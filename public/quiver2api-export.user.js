// ==UserScript==
// @name         Quiver2API Account Exporter
// @namespace    http://localhost:3000/
// @version      1.0.2
// @description  Export your logged-in QuiverAI web session to a local Quiver2API service.
// @match        https://app.quiver.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM.cookie
// @grant        GM_cookie
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const state = {
    localBase: localStorage.getItem('quiver2api:localBase') || 'http://localhost:3000'
  };

  function createPanel() {
    if (document.getElementById('quiver2api-export-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'quiver2api-export-panel';
    panel.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'width:320px',
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif',
      'color:#172033',
      'background:#fff',
      'border:1px solid #dbe3ef',
      'border-radius:8px',
      'box-shadow:0 16px 45px rgba(15,23,42,.18)',
      'padding:12px'
    ].join(';');

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <strong>Quiver2API</strong>
        <button data-q2a-close style="border:0;background:transparent;cursor:pointer;font-size:16px;line-height:1;">x</button>
      </div>
      <label style="display:block;color:#64748b;margin-bottom:4px;">Local service</label>
      <input data-q2a-base value="${escapeHtml(state.localBase)}" style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:7px 8px;margin-bottom:8px;">
      <label style="display:block;color:#64748b;margin-bottom:4px;">Manual cookie fallback</label>
      <textarea data-q2a-cookie placeholder="nuxt-session=..." style="width:100%;min-height:52px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:7px 8px;margin-bottom:8px;resize:vertical;"></textarea>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button data-q2a-check style="flex:1;border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:7px;cursor:pointer;">检测</button>
        <button data-q2a-export style="flex:1;border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:6px;padding:7px;cursor:pointer;">导入</button>
      </div>
      <pre data-q2a-log style="white-space:pre-wrap;max-height:180px;overflow:auto;background:#0f172a;color:#dbeafe;border-radius:6px;padding:8px;margin:0;"></pre>
    `;

    document.body.appendChild(panel);
    panel.querySelector('[data-q2a-close]').addEventListener('click', () => panel.remove());
    panel.querySelector('[data-q2a-check]').addEventListener('click', () => runCheck().catch((error) => log(error.message, true)));
    panel.querySelector('[data-q2a-export]').addEventListener('click', () => exportAccount().catch((error) => log(error.message, true)));
    panel.querySelector('[data-q2a-base]').addEventListener('change', (event) => {
      state.localBase = String(event.target.value || '').replace(/\/+$/, '');
      localStorage.setItem('quiver2api:localBase', state.localBase);
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function log(message, error = false) {
    const box = document.querySelector('[data-q2a-log]');
    if (!box) return;
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    box.textContent += `${box.textContent ? '\n' : ''}${line}`;
    box.style.color = error ? '#fecaca' : '#dbeafe';
    box.scrollTop = box.scrollHeight;
  }

  function accessEnabled(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.enabled === true || value.hasAccess === true || value.allowed === true || value.canAccess === true) return true;
    if (value.data && accessEnabled(value.data)) return true;
    if (value.access && accessEnabled(value.access)) return true;
    if (value.chat && accessEnabled(value.chat)) return true;
    return false;
  }

  async function quiverJson(path) {
    const response = await fetch(path, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `${path} HTTP ${response.status}`);
    return data;
  }

  function localJson(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `${state.localBase.replace(/\/+$/, '')}${path}`,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 30000,
        onload(response) {
          let data = {};
          try {
            data = JSON.parse(response.responseText || '{}');
          } catch {}
          if (response.status < 200 || response.status >= 300 || data.success === false) {
            const error = typeof data.error === 'object' ? data.error.message : data.error;
            reject(new Error(error || `Local HTTP ${response.status}`));
            return;
          }
          resolve(data);
        },
        onerror() {
          reject(new Error('Cannot reach local Quiver2API service'));
        },
        ontimeout() {
          reject(new Error('Local Quiver2API request timed out'));
        }
      });
    });
  }

  function cookieString(cookies) {
    if (!Array.isArray(cookies)) return '';
    return cookies
      .filter((cookie) => cookie?.name && cookie.value !== undefined)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  function cookieNames(cookieHeader) {
    return String(cookieHeader || '')
      .split(';')
      .map((item) => item.trim().split('=')[0])
      .filter(Boolean)
      .join(', ') || 'none';
  }

  async function gmDotCookies() {
    if (typeof GM === 'undefined' || !GM.cookie || typeof GM.cookie.list !== 'function') return '';
    const attempts = [
      { url: location.origin + '/' },
      { domain: location.hostname },
      { name: 'nuxt-session', url: location.origin + '/' }
    ];

    for (const details of attempts) {
      try {
        const cookies = await GM.cookie.list(details);
        const header = cookieString(cookies);
        if (header.includes('nuxt-session=')) return header;
        if (header) log(`GM.cookie 可读 cookies: ${cookieNames(header)}`);
      } catch {}
    }
    return '';
  }

  function gmUnderscoreCookies() {
    return new Promise((resolve) => {
      if (typeof GM_cookie === 'undefined' || typeof GM_cookie.list !== 'function') {
        resolve('');
        return;
      }

      const attempts = [
        { url: location.origin + '/' },
        { domain: location.hostname },
        { name: 'nuxt-session', url: location.origin + '/' }
      ];

      const next = (index) => {
        if (index >= attempts.length) {
          resolve('');
          return;
        }
        GM_cookie.list(attempts[index], (cookies, error) => {
          const header = error ? '' : cookieString(cookies);
          if (header.includes('nuxt-session=')) {
            resolve(header);
            return;
          }
          if (header) log(`GM_cookie 可读 cookies: ${cookieNames(header)}`);
          next(index + 1);
        });
      };

      next(0);
    });
  }

  async function readCookieHeader() {
    const fromGmDot = await gmDotCookies();
    const fromGmUnderscore = fromGmDot ? '' : await gmUnderscoreCookies();
    const fromDocument = document.cookie || '';
    if (fromDocument) log(`document.cookie 可读 cookies: ${cookieNames(fromDocument)}`);

    const manual = String(document.querySelector('[data-q2a-cookie]')?.value || '').trim();
    const cookieHeader = fromGmDot || fromGmUnderscore || fromDocument || manual;
    if (!cookieHeader.includes('nuxt-session=')) {
      throw new Error('没有读到 nuxt-session。请在 Tampermonkey 设置里允许 GM.cookie/GM_cookie 权限，或把 DevTools/Application/Cookies 里的 nuxt-session 手动粘贴到兜底输入框。');
    }
    return cookieHeader;
  }

  async function readQuiverState() {
    const session = await quiverJson('/api/_auth/session');
    const email = session?.user?.email;
    if (!email) throw new Error('当前页面没有登录 Quiver 账号');

    const [chat, explore, usage] = await Promise.all([
      quiverJson('/api/chat/access').catch((error) => ({ enabled: false, error: error.message })),
      quiverJson('/api/explore/access').catch((error) => ({ enabled: false, error: error.message })),
      quiverJson('/api/billing/usage').catch((error) => ({ data: { weekly: { remaining: 0 }, purchasedBalance: 0 }, error: error.message }))
    ]);
    const usageData = usage?.data || usage || {};
    const weekly = usageData.weekly || {};
    const weeklyRemaining = Number(weekly.remaining ?? Math.max(0, Number(weekly.limit || 0) - Number(weekly.used || 0))) || 0;
    const purchasedBalance = Number(usageData.purchasedBalance ?? usageData.purchased_balance ?? 0) || 0;

    return {
      email,
      chat,
      explore,
      usage,
      credits: weeklyRemaining + purchasedBalance,
      weeklyRemaining,
      purchasedBalance
    };
  }

  async function runCheck() {
    log('检测 Quiver 登录和权限...');
    const info = await readQuiverState();
    log(`${info.email}: createCredits=${info.credits}, weeklyRemaining=${info.weeklyRemaining}, chat=${accessEnabled(info.chat)}, explore=${accessEnabled(info.explore)}`);
  }

  async function exportAccount() {
    state.localBase = String(document.querySelector('[data-q2a-base]')?.value || state.localBase).replace(/\/+$/, '');
    localStorage.setItem('quiver2api:localBase', state.localBase);

    log('读取 Quiver 登录状态...');
    const info = await readQuiverState();
    log('读取浏览器 cookie...');
    const cookies = await readCookieHeader();

    log(`校验并导入 ${info.email} 到本地服务...`);
    const imported = await localJson('/api/accounts/import-web', 'POST', { email: info.email, cookies });
    const encoded = encodeURIComponent(info.email);
    const diagnosis = await localJson(`/api/accounts/${encoded}/diagnose`).catch(() => null);

    const saved = imported?.data || {};
    const diagnostic = diagnosis?.data || {};
    const canGenerate = saved.can_generate === true || diagnostic.can_generate === true;
    const credits = diagnostic.credits_after ?? saved.credits ?? info.credits ?? 0;
    log(`完成: ${info.email}, status=${saved.status || diagnostic.status_after || 'unknown'}, create=${canGenerate ? 'enabled' : 'disabled'}, credits=${credits}`);
    if (!canGenerate) {
      log(diagnostic.recommended_next_step || 'Local session imported, but Quiver Create quota/access is unavailable for /v1 generation.', true);
    }
  }

  createPanel();
})();
