const { ConfigDB } = require('./db');

function getProxyUrl() {
  return String(ConfigDB.get('proxy_url') || process.env.QUIVER_PROXY || '').trim();
}

function maskProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return raw.replace(/:\/\/([^:/?#]+):([^@/?#]+)@/, '://$1:***@');
  }
}

function getAxiosProxyOptions(proxyUrl = getProxyUrl()) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return { proxy: false };

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Proxy URL must be a valid URL, for example http://127.0.0.1:7890');
  }

  const protocol = url.protocol.replace(':', '');
  if (!['http', 'https'].includes(protocol)) {
    throw new Error('Only HTTP/HTTPS proxy URLs are supported without extra dependencies');
  }

  const proxy = {
    protocol,
    host: url.hostname,
    port: Number(url.port || (protocol === 'https' ? 443 : 80))
  };

  if (url.username || url.password) {
    proxy.auth = {
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password)
    };
  }

  return { proxy };
}

module.exports = {
  getAxiosProxyOptions,
  getProxyUrl,
  maskProxyUrl
};
