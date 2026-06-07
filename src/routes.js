const express = require('express');
const { AccountDB, ConfigDB } = require('./db');
const QuiverClient = require('./quiver');
const OfficialQuiverClient = require('./quiver-official');
const AutoRegister = require('./register');
const { getProxyUrl, maskProxyUrl } = require('./proxy');
const { getLocalApiKey, maskSecret } = require('./v1');

const router = express.Router();

const sseClients = new Set();
const magicSessions = new Map();
let registrationRunning = false;

function ok(res, data = null, extra = {}) {
  res.json({ success: true, data, ...extra });
}

function fail(res, error, status = 500) {
  const code = error?.status || status;
  res.status(code).json({ success: false, error: error?.message || String(error) });
}

function sanitizeAccount(account) {
  if (!account) return account;
  const { session_token: sessionToken, ...rest } = account;
  return {
    ...rest,
    has_session: !!sessionToken,
    session_preview: sessionToken ? `${sessionToken.slice(0, 16)}...${sessionToken.slice(-8)}` : ''
  };
}

function requestEmail(req) {
  return req.query.email || req.body?.email || req.body?.accountEmail || null;
}

function findEmail(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEmail(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['email', 'mail', 'address']) {
      const found = findEmail(value[key]);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = findEmail(item);
      if (found) return found;
    }
  }
  return '';
}

function selectAccount(req) {
  const email = requestEmail(req);
  if (email) return AccountDB.getByEmail(email);
  return AccountDB.getNext();
}

function makeClient(account) {
  if (!account?.session_token) {
    const error = new Error('Account has no Quiver session cookie');
    error.status = 400;
    throw error;
  }
  return new QuiverClient(account.email, null, account.session_token);
}

async function getWebUsage(client, account = {}) {
  try {
    return await client.getUsage();
  } catch (usageError) {
    try {
      const balance = await client.getBalance();
      return {
        credits: balance.credits || 0,
        weekly: null,
        purchasedBalance: balance.credits || 0,
        raw: balance.raw,
        usage_error: usageError.message
      };
    } catch (balanceError) {
      return {
        credits: account.credits || 0,
        weekly: null,
        purchasedBalance: 0,
        error: balanceError.message,
        usage_error: usageError.message
      };
    }
  }
}

function rememberMagicSession(email, cookies) {
  if (!email || !cookies) return;
  magicSessions.set(email, {
    cookies,
    expiresAt: Date.now() + 10 * 60 * 1000
  });
}

function consumeMagicSession(email) {
  const item = magicSessions.get(email);
  if (!item) return '';
  magicSessions.delete(email);
  if (item.expiresAt < Date.now()) return '';
  return item.cookies || '';
}

async function saveVerifiedWebSession(email, cookies) {
  const normalizedCookies = QuiverClient.normalizeCookieString(cookies);
  if (!normalizedCookies) {
    const error = new Error('Verification succeeded but no Quiver session cookie was returned');
    error.status = 502;
    throw error;
  }

  AccountDB.add(email, null, normalizedCookies);
  AccountDB.updateSession(email, normalizedCookies);

  const client = new QuiverClient(email, null, normalizedCookies);
  let credits = 0;
  let usage = null;
  let usageError = null;
  try {
    usage = await getWebUsage(client, { email });
    credits = usage.credits || 0;
    AccountDB.updateCredits(email, credits);
  } catch (error) {
    usageError = error.message;
  }

  let chat = null;
  let explore = null;
  try {
    [chat, explore] = await Promise.all([
      client.getChatAccess().catch((error) => ({ enabled: false, error: error.message })),
      client.getExploreAccess().catch((error) => ({ enabled: false, error: error.message }))
    ]);
  } catch (error) {
    chat = { enabled: false, error: error.message };
  }
  const canCreate = QuiverClient.createAccessEnabled(usage) || QuiverClient.accessEnabled(chat);
  AccountDB.updateStatus(email, canCreate ? 'active' : 'no_access');

  return {
    email,
    credits,
    status: canCreate ? 'active' : 'no_access',
    can_generate: canCreate,
    usage,
    chat,
    explore,
    balance_error: usage?.error || usage?.usage_error || usageError,
    has_session: true
  };
}

function checkResult(name, ok, extra = {}) {
  return { name, ok: !!ok, ...extra };
}

function failedCheck(name, error) {
  return checkResult(name, false, {
    error: error?.message || String(error),
    status: error?.status || null,
    data: error?.data || null
  });
}

function diagnosticRecommendation(diagnostic) {
  if (!diagnostic.has_session) {
    return 'Import this account again with Web login or a fresh Quiver nuxt-session cookie.';
  }
  if (!diagnostic.checks.session.ok) {
    return 'The saved web session is not readable. Re-import the account with a fresh Quiver login session.';
  }
  if (diagnostic.can_generate) {
    return 'This account is ready. Use /v1/svgs/generations or /v1/chat/completions.';
  }
  if (!diagnostic.checks.usage.ok) {
    return 'Quiver did not return web usage for this session. Re-login in the browser, verify the account can open Create on app.quiver.ai, then import it again.';
  }
  if (!diagnostic.checks.usage.enabled) {
    return 'The session is valid, but Quiver reports no remaining weekly or purchased Create credits. Use an account whose Quiver Create page can generate.';
  }
  return 'The account is not ready for generation yet. Re-import a working web account and run diagnosis again.';
}

async function diagnoseWebAccount(account, options = {}) {
  const diagnostic = {
    object: 'quiver_account_diagnostic',
    email: account.email,
    status_before: account.status,
    has_session: !!account.session_token,
    can_generate: false,
    detected_email: '',
    checks: {
      session: checkResult('session', false),
      balance: checkResult('balance', false),
      usage: checkResult('usage', false),
      chat_access: checkResult('chat_access', false),
      explore_access: checkResult('explore_access', false)
    },
    recommended_next_step: ''
  };

  if (!account.session_token) {
    diagnostic.recommended_next_step = diagnosticRecommendation(diagnostic);
    return diagnostic;
  }

  const update = options.update !== false;
  const client = makeClient(account);

  try {
    const session = await client.getSession();
    diagnostic.detected_email = findEmail(session);
    diagnostic.checks.session = checkResult('session', true, {
      detected_email: diagnostic.detected_email || null,
      has_user: !!session?.user
    });
  } catch (error) {
    diagnostic.checks.session = failedCheck('session', error);
  }

  try {
    const usage = await getWebUsage(client, account);
    const usageEnabled = QuiverClient.createAccessEnabled(usage);
    diagnostic.checks.usage = checkResult('usage', true, {
      enabled: usageEnabled,
      credits: usage.credits || 0,
      weekly: usage.weekly || null,
      purchased_balance: usage.purchasedBalance || 0,
      raw: usage.raw,
      usage_error: usage.usage_error || null
    });
    diagnostic.checks.balance = checkResult('balance', true, {
      credits: usage.credits || 0,
      weekly: usage.weekly || null,
      purchased_balance: usage.purchasedBalance || 0,
      raw: usage.raw
    });
    diagnostic.can_generate = diagnostic.can_generate || usageEnabled;
    if (update) AccountDB.updateCredits(account.email, usage.credits || 0);
  } catch (error) {
    diagnostic.checks.usage = failedCheck('usage', error);
    diagnostic.checks.balance = failedCheck('balance', error);
  }

  try {
    const chat = await client.getChatAccess();
    const enabled = QuiverClient.accessEnabled(chat);
    diagnostic.checks.chat_access = checkResult('chat_access', true, {
      enabled,
      raw: chat
    });
    diagnostic.can_generate = diagnostic.can_generate || enabled;
  } catch (error) {
    diagnostic.checks.chat_access = failedCheck('chat_access', error);
  }

  try {
    const explore = await client.getExploreAccess();
    diagnostic.checks.explore_access = checkResult('explore_access', true, {
      enabled: QuiverClient.accessEnabled(explore),
      raw: explore
    });
  } catch (error) {
    diagnostic.checks.explore_access = failedCheck('explore_access', error);
  }

  if (update) {
    AccountDB.updateStatus(account.email, diagnostic.can_generate ? 'active' : 'no_access');
    if (diagnostic.can_generate) AccountDB.clearError(account.email);
  }

  const updated = AccountDB.getByEmail(account.email) || account;
  diagnostic.status_after = updated.status;
  diagnostic.credits_after = updated.credits || 0;
  diagnostic.recommended_next_step = diagnosticRecommendation(diagnostic);
  return diagnostic;
}

async function withAccount(req, res, handler) {
  const account = selectAccount(req);
  if (!account) return fail(res, new Error(requestEmail(req) ? 'Account not found' : 'No active account'), 404);

  try {
    const client = makeClient(account);
    const data = await handler(client, account);
    AccountDB.clearError(account.email);
    return ok(res, data);
  } catch (error) {
    if (!error.skipAccountPenalty) AccountDB.markError(account.email);
    return fail(res, error);
  }
}

function sendLog(message, type = 'info') {
  const payload = `data: ${JSON.stringify({ message, type, time: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) client.write(payload);
}

AutoRegister.setLogCallback((message, type) => sendLog(message, type));

// Account management
router.get('/accounts', (req, res) => {
  try {
    ok(res, AccountDB.getAll().map(sanitizeAccount));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/accounts', (req, res) => {
  try {
    const { email, password } = req.body || {};
    const cookies = req.body?.session_token || req.body?.cookies || null;
    if (!email) return fail(res, new Error('Email is required'), 400);

    const normalizedCookies = cookies ? QuiverClient.normalizeCookieString(cookies) : null;
    AccountDB.add(email, password || null, normalizedCookies);
    ok(res, null, { message: 'Account saved' });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/accounts/import-web', async (req, res) => {
  try {
    const cookies = req.body?.session_token || req.body?.cookies || null;
    if (!cookies) return fail(res, new Error('Quiver Cookie is required'), 400);

    const normalizedCookies = QuiverClient.normalizeCookieString(cookies);
    const probe = new QuiverClient(req.body?.email || null, null, normalizedCookies);
    const session = await probe.getSession();
    const email = String(req.body?.email || findEmail(session) || '').trim().toLowerCase();
    if (!email) {
      const error = new Error('Could not read account email from Quiver session');
      error.status = 401;
      throw error;
    }

    const saved = await saveVerifiedWebSession(email, probe.getCookieHeader() || normalizedCookies);
    ok(res, { ...saved, session }, {
      message: saved.status === 'active'
        ? 'Quiver web account imported and ready'
        : 'Quiver web account imported, but Create quota/access is unavailable'
    });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/accounts/batch', (req, res) => {
  try {
    const accounts = req.body?.accounts;
    if (!Array.isArray(accounts)) return fail(res, new Error('accounts must be an array'), 400);
    AccountDB.addBatch(accounts.map((account) => ({
      ...account,
      session_token: account.session_token || account.cookies
        ? QuiverClient.normalizeCookieString(account.session_token || account.cookies)
        : null
    })));
    ok(res, null, { message: `Imported ${accounts.length} accounts` });
  } catch (error) {
    fail(res, error);
  }
});

router.patch('/accounts/:email', (req, res) => {
  try {
    const { status, session_token: sessionToken, cookies } = req.body || {};
    if (status) AccountDB.updateStatus(req.params.email, status);
    if (sessionToken || cookies) {
      AccountDB.updateSession(req.params.email, QuiverClient.normalizeCookieString(sessionToken || cookies));
    }
    ok(res, null, { message: 'Account updated' });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/accounts/:email/reset', (req, res) => {
  try {
    AccountDB.resetError(req.params.email);
    ok(res, null, { message: 'Account reset' });
  } catch (error) {
    fail(res, error);
  }
});

router.delete('/accounts/:email', (req, res) => {
  try {
    AccountDB.delete(req.params.email);
    ok(res, null, { message: 'Account deleted' });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/auth/magic', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return fail(res, new Error('Email is required'), 400);
    const intent = req.body?.intent === 'signup' ? 'signup' : 'signin';
    const client = new QuiverClient(email);
    await client.initSession();
    const result = await client.sendMagicCode(email, intent, { resend: !!req.body?.resend });
    rememberMagicSession(email, client.getCookieHeader());
    ok(res, {
      email,
      intent,
      result,
      session_preview: client.getCookieHeader()
        ? `${client.getCookieHeader().slice(0, 16)}...${client.getCookieHeader().slice(-8)}`
        : ''
    }, { message: 'Verification code sent' });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/auth/magic/verify', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!email) return fail(res, new Error('Email is required'), 400);
    if (!/^\d{6}$/.test(code)) return fail(res, new Error('Verification code must be 6 digits'), 400);

    const pendingCookies = consumeMagicSession(email);
    const client = new QuiverClient(email, null, pendingCookies);
    if (!pendingCookies) await client.initSession();
    const verification = await client.verifyMagicCode(email, code, req.body?.redirectTo || '/agent');
    const saved = await saveVerifiedWebSession(email, verification.cookies || client.getCookieHeader());
    ok(res, saved, {
      message: saved.status === 'active'
        ? 'Quiver web account imported and ready'
        : 'Quiver web account imported, but Create quota/access is unavailable'
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/stats', (req, res) => {
  try {
    ok(res, AccountDB.getStats());
  } catch (error) {
    fail(res, error);
  }
});

// Quiver billing and account APIs
router.get('/session', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  session: await client.getSession()
})));

router.get('/balance', (req, res) => withAccount(req, res, async (client, account) => {
  const balance = await getWebUsage(client, account);
  AccountDB.updateCredits(account.email, balance.credits);
  return { email: account.email, ...balance };
}));

router.get('/access', (req, res) => withAccount(req, res, async (client, account) => {
  const [chat, explore] = await Promise.all([
    client.getChatAccess().catch((error) => ({ enabled: false, error: error.message })),
    client.getExploreAccess().catch((error) => ({ enabled: false, error: error.message }))
  ]);
  const usage = await getWebUsage(client, account);
  AccountDB.updateCredits(account.email, usage.credits || 0);
  const canCreate = QuiverClient.createAccessEnabled(usage) || QuiverClient.accessEnabled(chat);
  AccountDB.updateStatus(account.email, canCreate ? 'active' : 'no_access');
  return { email: account.email, can_generate: canCreate, usage, chat, explore };
}));

router.get('/accounts/:email/diagnose', async (req, res) => {
  try {
    const account = AccountDB.getByEmail(req.params.email);
    if (!account) return fail(res, new Error('Account not found'), 404);
    const update = req.query.update !== 'false';
    ok(res, await diagnoseWebAccount(account, { update }));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/accounts/diagnose-web', async (req, res) => {
  try {
    const cookies = req.body?.session_token || req.body?.cookies || null;
    const email = String(req.body?.email || '').trim().toLowerCase();
    let account = null;

    if (cookies) {
      account = {
        email: email || 'unsaved-session',
        status: 'unsaved',
        credits: 0,
        error_count: 0,
        session_token: QuiverClient.normalizeCookieString(cookies)
      };
    } else if (email) {
      account = AccountDB.getByEmail(email);
    }

    if (!account) return fail(res, new Error(cookies || email ? 'Account not found' : 'Email or Quiver Cookie is required'), 404);
    ok(res, await diagnoseWebAccount(account, { update: !!account.id && req.query.update !== 'false' }));
  } catch (error) {
    fail(res, error);
  }
});

router.get('/balance/all', async (req, res) => {
  try {
    const accounts = AccountDB.getAll().filter((account) =>
      account.session_token && account.status !== 'disabled'
    );
    const results = [];

    for (const account of accounts) {
      try {
        const client = makeClient(account);
        const balance = await getWebUsage(client, account);
        AccountDB.updateCredits(account.email, balance.credits);
        AccountDB.clearError(account.email);
        results.push({
          email: account.email,
          credits: balance.credits,
          weekly: balance.weekly || null,
          purchased_balance: balance.purchasedBalance || 0,
          status: 'ok'
        });
      } catch (error) {
        AccountDB.markError(account.email);
        results.push({ email: account.email, credits: account.credits || 0, status: 'error', error: error.message });
      }
    }

    ok(res, results);
  } catch (error) {
    fail(res, error);
  }
});

router.get('/subscription', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  subscription: await client.getSubscription()
})));

router.get('/transactions', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  transactions: await client.getTransactions({
    limit: req.query.limit,
    cursor: req.query.cursor,
    startDate: req.query.startDate,
    endDate: req.query.endDate
  })
})));

// Quiver chat and generation APIs
router.get('/chats', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  chats: await client.getChats({ limit: req.query.limit, cursor: req.query.cursor })
})));

async function sendChat(req, res) {
  return withAccount(req, res, async (client, account) => {
    const prompt = req.body?.prompt || req.body?.message || req.body?.text;
    if (!prompt) {
      const error = new Error('prompt is required');
      error.status = 400;
      throw error;
    }

    const access = await client.getChatAccess();
    if (!QuiverClient.accessEnabled(access)) {
      AccountDB.updateStatus(account.email, 'no_access');
      const error = new Error('Quiver Chat/Agent access is disabled for this account');
      error.status = 403;
      error.data = access;
      error.skipAccountPenalty = true;
      throw error;
    }

    const result = req.body?.chatId
      ? await client.sendChatMessage(req.body.chatId, prompt, req.body)
      : await client.createAndSendChat(prompt, req.body);

    try {
      const balance = await client.getBalance();
      AccountDB.updateCredits(account.email, balance.credits);
      result.balance = { credits: balance.credits };
    } catch {
      // Generation succeeded; balance refresh is best-effort.
    }

    return { email: account.email, ...result };
  });
}

router.post('/chat', sendChat);
router.post('/chats', sendChat);

// Official QuiverAI API (https://api.quiver.ai/v1)
router.get('/official/models', async (req, res) => {
  try {
    const client = new OfficialQuiverClient();
    ok(res, await client.listModels());
  } catch (error) {
    fail(res, error);
  }
});

router.get('/official/models/:model', async (req, res) => {
  try {
    const client = new OfficialQuiverClient();
    ok(res, await client.getModel(req.params.model));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/official/generate', async (req, res) => {
  try {
    const client = new OfficialQuiverClient();
    ok(res, await client.generateSVG(req.body || {}));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/official/vectorize', async (req, res) => {
  try {
    const client = new OfficialQuiverClient();
    ok(res, await client.vectorizeSVG(req.body || {}));
  } catch (error) {
    fail(res, error);
  }
});

router.get('/chats/:id', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  chat: await client.getChat(req.params.id)
})));

router.delete('/chats/:id', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  deleted: await client.deleteChat(req.params.id)
})));

router.patch('/chats/:id', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  chat: await client.updateChat(req.params.id, req.body || {})
})));

router.get('/messages', (req, res) => withAccount(req, res, async (client, account) => {
  if (!req.query.chatId) {
    const error = new Error('chatId is required');
    error.status = 400;
    throw error;
  }
  return { email: account.email, messages: await client.getMessages(req.query.chatId) };
}));

router.get('/artifacts', (req, res) => withAccount(req, res, async (client, account) => {
  if (!req.query.chatId) {
    const error = new Error('chatId is required');
    error.status = 400;
    throw error;
  }
  return { email: account.email, artifacts: await client.getArtifacts(req.query.chatId) };
}));

router.get('/tasks/:id', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  task: await client.getTask(req.params.id)
})));

router.get('/creations/:id', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  creation: await client.getCreation(req.params.id)
})));

router.get('/creations/:id/svg', (req, res) => withAccount(req, res, async (client, account) => ({
  email: account.email,
  svg: await client.getCreationSvg(req.params.id)
})));

// Registration
router.get('/register/log', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

router.post('/register', async (req, res) => {
  if (registrationRunning) return fail(res, new Error('Registration is already running'), 409);
  registrationRunning = true;
  try {
    const result = await AutoRegister.registerOne(req.body || {});
    ok(res, result);
  } catch (error) {
    fail(res, error);
  } finally {
    registrationRunning = false;
  }
});

router.post('/register/batch', (req, res) => {
  if (registrationRunning) return fail(res, new Error('Registration is already running'), 409);

  const count = Math.max(1, Math.min(Number(req.body?.count) || 1, 5));
  const delay = Math.max(5000, Number(req.body?.delay) || 8000);
  registrationRunning = true;

  ok(res, null, { message: `Started registration for ${count} account(s)` });

  AutoRegister.registerBatch(count, delay)
    .then((results) => {
      const successCount = results.filter((result) => result.success).length;
      sendLog(`Batch registration finished: ${successCount}/${count} succeeded`, successCount ? 'success' : 'warning');
    })
    .catch((error) => sendLog(`Batch registration failed: ${error.message}`, 'error'))
    .finally(() => {
      registrationRunning = false;
    });
});

// Config
router.get('/config', (req, res) => {
  try {
    const config = ConfigDB.getAll();
    if (config.yyds_api_key) {
      config.yyds_api_key_masked = `${config.yyds_api_key.slice(0, 5)}***${config.yyds_api_key.slice(-3)}`;
      delete config.yyds_api_key;
    }
    if (config.proxy_url) {
      config.proxy_url_masked = maskProxyUrl(config.proxy_url);
      delete config.proxy_url;
    }
    if (config.quiver_api_key) {
      config.quiver_api_key_masked = OfficialQuiverClient.maskApiKey(config.quiver_api_key);
      delete config.quiver_api_key;
    }
    if (config.local_api_key) {
      config.local_api_key_masked = maskSecret(config.local_api_key);
      delete config.local_api_key;
    }
    ok(res, config);
  } catch (error) {
    fail(res, error);
  }
});

router.post('/config', (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return fail(res, new Error('Config key is required'), 400);
    ConfigDB.set(key, value || '');
    ok(res, null, { message: 'Config saved' });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/config/yyds-key', (req, res) => {
  try {
    const key = ConfigDB.get('yyds_api_key') || process.env.YYDS_API_KEY || '';
    ok(res, {
      configured: !!key,
      masked: key && key.length > 8 ? `${key.slice(0, 5)}***${key.slice(-3)}` : ''
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/config/proxy', (req, res) => {
  try {
    const proxyUrl = getProxyUrl();
    ok(res, {
      configured: !!proxyUrl,
      masked: maskProxyUrl(proxyUrl)
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/config/quiver-api-key', (req, res) => {
  try {
    const key = OfficialQuiverClient.getApiKey();
    ok(res, {
      configured: !!key,
      masked: OfficialQuiverClient.maskApiKey(key)
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/config/local-api-key', (req, res) => {
  try {
    const key = getLocalApiKey();
    ok(res, {
      configured: !!key,
      masked: maskSecret(key)
    });
  } catch (error) {
    fail(res, error);
  }
});

module.exports = router;
