const fs = require('fs');
const path = require('path');

function stripInlineComment(value) {
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== '\\') {
      quote = quote === char ? '' : quote || char;
    }
    if (!quote && char === '#' && /\s/.test(value[i - 1] || '')) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function parseEnv(content) {
  const parsed = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();

    const equalsAt = line.indexOf('=');
    if (equalsAt <= 0) continue;

    const key = line.slice(0, equalsAt).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = stripInlineComment(line.slice(equalsAt + 1).trim());
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    }
    parsed[key] = value;
  }
  return parsed;
}

function envFilePath(rootDir) {
  const configured = process.env.QUIVER2API_ENV_FILE || process.env.ENV_FILE || '.env';
  return path.isAbsolute(configured) ? configured : path.join(rootDir, configured);
}

function loadEnv(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, '..');
  const filePath = options.path || envFilePath(rootDir);
  if (!fs.existsSync(filePath)) return { loaded: false, path: filePath, keys: [] };

  const parsed = parseEnv(fs.readFileSync(filePath, 'utf8'));
  const keys = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, path: filePath, keys };
}

module.exports = { loadEnv, parseEnv };
