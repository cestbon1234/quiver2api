const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
require('./env').loadEnv();

function databasePath() {
  const configured = process.env.QUIVER2API_DB || process.env.ACCOUNTS_DB_PATH || '';
  if (!configured) return path.join(__dirname, '..', 'accounts.db');
  return path.isAbsolute(configured) ? configured : path.join(__dirname, '..', configured);
}

const dbPath = databasePath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT,
    session_token TEXT,
    credits INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    last_used_at DATETIME,
    error_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const AccountDB = {
  add(email, password = null, sessionToken = null) {
    const normalized = normalizeEmail(email);
    if (!normalized) throw new Error('Email is required');
    const stmt = db.prepare(`
      INSERT INTO accounts (email, password, session_token)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        password = COALESCE(excluded.password, accounts.password),
        session_token = COALESCE(excluded.session_token, accounts.session_token),
        status = CASE WHEN excluded.session_token IS NOT NULL THEN 'active' ELSE accounts.status END
    `);
    return stmt.run(normalized, password || null, sessionToken || null);
  },

  addBatch(accounts) {
    const stmt = db.prepare(`
      INSERT INTO accounts (email, password, session_token)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        password = COALESCE(excluded.password, accounts.password),
        session_token = COALESCE(excluded.session_token, accounts.session_token)
    `);
    const insertMany = db.transaction((items) => {
      for (const item of items) {
        const email = normalizeEmail(item.email);
        if (!email) continue;
        stmt.run(email, item.password || null, item.session_token || item.cookies || null);
      }
    });
    return insertMany(accounts);
  },

  getAll() {
    return db.prepare('SELECT * FROM accounts ORDER BY id').all();
  },

  getByEmail(email) {
    return db.prepare('SELECT * FROM accounts WHERE email = ?').get(normalizeEmail(email));
  },

  getActive() {
    return db.prepare(`
      SELECT * FROM accounts
      WHERE status = ?
      ORDER BY COALESCE(last_used_at, '1970-01-01') ASC, id ASC
    `).all('active');
  },

  getNext() {
    const account = db.prepare(`
      SELECT * FROM accounts
      WHERE status = ?
      ORDER BY COALESCE(last_used_at, '1970-01-01') ASC, id ASC
      LIMIT 1
    `).get('active');

    if (account) this.touch(account.email);
    return account;
  },

  touch(email) {
    return db.prepare('UPDATE accounts SET last_used_at = CURRENT_TIMESTAMP WHERE email = ?')
      .run(normalizeEmail(email));
  },

  updateSession(email, token) {
    return db.prepare(`
      UPDATE accounts
      SET session_token = ?, status = 'active', error_count = 0
      WHERE email = ?
    `).run(token || null, normalizeEmail(email));
  },

  updateCredits(email, credits) {
    const value = Number.isFinite(Number(credits)) ? Number(credits) : 0;
    return db.prepare('UPDATE accounts SET credits = ? WHERE email = ?')
      .run(value, normalizeEmail(email));
  },

  updateStatus(email, status) {
    return db.prepare('UPDATE accounts SET status = ? WHERE email = ?')
      .run(status, normalizeEmail(email));
  },

  markError(email) {
    return db.prepare(`
      UPDATE accounts
      SET
        error_count = error_count + 1,
        status = CASE WHEN error_count + 1 >= 3 THEN 'disabled' ELSE status END
      WHERE email = ?
    `).run(normalizeEmail(email));
  },

  clearError(email) {
    return db.prepare('UPDATE accounts SET error_count = 0 WHERE email = ?')
      .run(normalizeEmail(email));
  },

  resetError(email) {
    return db.prepare('UPDATE accounts SET error_count = 0, status = ? WHERE email = ?')
      .run('active', normalizeEmail(email));
  },

  delete(email) {
    return db.prepare('DELETE FROM accounts WHERE email = ?').run(normalizeEmail(email));
  },

  getStats() {
    const total = db.prepare('SELECT COUNT(*) as count FROM accounts').get().count;
    const active = db.prepare('SELECT COUNT(*) as count FROM accounts WHERE status = ?').get('active').count;
    const noAccess = db.prepare('SELECT COUNT(*) as count FROM accounts WHERE status = ?').get('no_access').count;
    const disabled = db.prepare('SELECT COUNT(*) as count FROM accounts WHERE status = ?').get('disabled').count;
    const credits = db.prepare('SELECT COALESCE(SUM(credits), 0) as total FROM accounts').get().total;
    return { total, active, no_access: noAccess, disabled, credits };
  }
};

const ConfigDB = {
  get(key) {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  set(key, value) {
    return db.prepare(`
      INSERT OR REPLACE INTO config (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(key, value);
  },

  getAll() {
    const rows = db.prepare('SELECT key, value FROM config').all();
    const config = {};
    for (const row of rows) config[row.key] = row.value;
    return config;
  },

  delete(key) {
    return db.prepare('DELETE FROM config WHERE key = ?').run(key);
  }
};

module.exports = { AccountDB, ConfigDB };
