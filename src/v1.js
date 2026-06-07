const express = require('express');
const { randomUUID } = require('crypto');
const { AccountDB, ConfigDB } = require('./db');
const QuiverClient = require('./quiver');

const router = express.Router();

const MODELS = [
  {
    id: 'arrow-1.1',
    object: 'model',
    owned_by: 'quiver-web',
    type: 'svg'
  },
  {
    id: 'arrow-1.1-max',
    object: 'model',
    owned_by: 'quiver-web',
    type: 'svg'
  },
  {
    id: 'arrow-1',
    object: 'model',
    owned_by: 'quiver-web',
    type: 'svg'
  }
];

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getLocalApiKey() {
  return String(
    ConfigDB.get('local_api_key') ||
    process.env.QUIVER2API_KEY ||
    process.env.LOCAL_API_KEY ||
    ''
  ).trim();
}

function maskSecret(value) {
  const secret = String(value || '').trim();
  if (!secret) return '';
  if (secret.length <= 10) return `${secret.slice(0, 3)}***`;
  return `${secret.slice(0, 6)}***${secret.slice(-4)}`;
}

function authToken(req) {
  const authorization = String(req.headers.authorization || '').trim();
  if (/^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] || req.query.api_key || '').trim();
}

function requireApiKey(req, res, next) {
  const configured = getLocalApiKey();
  if (!configured) {
    next();
    return;
  }

  if (authToken(req) === configured) {
    next();
    return;
  }

  res.status(401).json({
    error: {
      message: 'Invalid or missing API key',
      type: 'authentication_error',
      code: 'invalid_api_key'
    }
  });
}

function fail(res, error, status = 500) {
  const code = error?.status || status;
  res.status(code).json({
    error: {
      message: error?.message || String(error),
      type: code === 401 ? 'authentication_error' : 'quiver_web_error',
      code: error?.code || null,
      data: error?.data
    }
  });
}

function requestEmail(req) {
  return (
    req.query.email ||
    req.body?.email ||
    req.body?.account_email ||
    req.body?.accountEmail ||
    req.headers['x-quiver-account'] ||
    null
  );
}

function makeClient(account) {
  if (!account?.session_token) {
    const error = new Error('Account has no Quiver web session cookie');
    error.status = 400;
    throw error;
  }
  return new QuiverClient(account.email, null, account.session_token);
}

async function getWebUsage(client, account) {
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

async function refreshAccountState(account) {
  const client = makeClient(account);
  const [session, chat, explore, usage] = await Promise.all([
    client.getSession().catch((error) => ({ user: null, error: error.message })),
    client.getChatAccess().catch((error) => ({ enabled: false, error: error.message })),
    client.getExploreAccess().catch((error) => ({ enabled: false, error: error.message })),
    getWebUsage(client, account)
  ]);

  const hasSession = !!session?.user;
  const canCreate = hasSession && (
    QuiverClient.createAccessEnabled(usage)
    || QuiverClient.accessEnabled(chat)
  );
  const status = canCreate ? 'active' : 'no_access';
  AccountDB.updateStatus(account.email, status);
  AccountDB.updateCredits(account.email, usage.credits || 0);
  if (status === 'active') AccountDB.clearError(account.email);

  return {
    ...account,
    status,
    credits: usage.credits || 0,
    can_generate: canCreate,
    session: {
      ok: hasSession,
      error: session?.error || null
    },
    chat,
    explore,
    usage,
    balance_error: usage.error || usage.usage_error || null
  };
}

async function recoverAccountByEmail(email) {
  const account = AccountDB.getByEmail(email);
  if (!account) return null;
  if (!account.session_token || account.status === 'disabled') return account;
  try {
    return await refreshAccountState(account);
  } catch (error) {
    AccountDB.markError(account.email);
    return { ...account, status: 'error', recover_error: error.message };
  }
}

async function recoverFirstUsableAccount() {
  const candidates = AccountDB.getAll().filter((account) =>
    account.session_token && account.status !== 'disabled'
  );

  for (const account of candidates) {
    const refreshed = await recoverAccountByEmail(account.email);
    if (refreshed?.status === 'active') {
      AccountDB.touch(refreshed.email);
      return AccountDB.getByEmail(refreshed.email);
    }
  }

  return null;
}

async function selectGenerationAccount(req) {
  const email = requestEmail(req);
  let account = email ? AccountDB.getByEmail(email) : AccountDB.getNext();

  if (email && account?.status !== 'active' && account?.session_token && account.status !== 'disabled') {
    const refreshed = await recoverAccountByEmail(email);
    account = refreshed?.status === 'active' ? AccountDB.getByEmail(email) : refreshed;
  }

  if (!email && !account) {
    account = await recoverFirstUsableAccount();
  }

  if (!account) {
    const all = AccountDB.getAll();
    const hasSessions = all.some((item) => item.session_token);
    const hasOnlyNoAccess = all.some((item) => item.status === 'no_access');
    const error = new Error(
      email
        ? 'Account not found'
        : hasOnlyNoAccess
          ? 'No active web account. Saved accounts currently have no Quiver Create quota or access.'
          : hasSessions
            ? 'No active web account'
            : 'No web account sessions are imported'
    );
    error.status = 404;
    throw error;
  }
  if (account.status !== 'active') {
    const detail = account.recover_error ? ` (${account.recover_error})` : '';
    const error = new Error(`Account is ${account.status}; generation requires an active Quiver Create web account${detail}`);
    error.status = 403;
    error.data = {
      email: account.email,
      session: account.session,
      usage: account.usage,
      chat: account.chat,
      explore: account.explore,
      balance_error: account.balance_error,
      recover_error: account.recover_error
    };
    throw error;
  }
  return account;
}

function normalizeCount(input) {
  return Number.isFinite(Number(input))
    ? Math.max(1, Math.min(4, Math.round(Number(input))))
    : 1;
}

function normalizeWaitMs(body = {}, defaultMs = 90000) {
  if (body.wait === false || body.wait_for_svg === false || body.poll === false) return 0;
  const input = body.wait_ms ?? body.timeout_ms ?? body.poll_timeout_ms ?? body.waitForSvgMs;
  if (Number.isFinite(Number(input))) return Math.max(0, Math.min(180000, Math.round(Number(input))));
  return defaultMs;
}

function normalizePollIntervalMs(body = {}) {
  const input = body.poll_interval_ms ?? body.pollIntervalMs;
  if (Number.isFinite(Number(input))) return Math.max(500, Math.min(10000, Math.round(Number(input))));
  return 2500;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'input_text') return part.text || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function promptFromMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const userMessages = messages.filter((message) => message?.role === 'user');
  const source = userMessages.length ? userMessages : messages;
  return source
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join('\n\n');
}

function promptFromBody(body = {}) {
  return String(
    body.prompt ||
    body.input ||
    body.text ||
    body.message ||
    promptFromMessages(body.messages) ||
    ''
  ).trim();
}

function findSvg(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const match = value.match(/<svg[\s\S]*?<\/svg>/i);
    return match ? match[0] : '';
  }
  if (Buffer.isBuffer(value)) return findSvg(value.toString('utf8'));
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSvg(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['svg', 'content', 'data', 'result', 'creation']) {
      const found = findSvg(value[key]);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = findSvg(item);
      if (found) return found;
    }
  }
  return '';
}

function firstStatus(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.status === 'string') return value.status.toLowerCase();
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = firstStatus(item);
      if (status) return status;
    }
    return '';
  }
  for (const key of ['data', 'result', 'creation', 'task']) {
    const status = firstStatus(value[key]);
    if (status) return status;
  }
  return '';
}

function missingSvgMessage(value, fallback) {
  const status = firstStatus(value);
  if (['queued', 'pending', 'running', 'processing', 'generating'].includes(status)) {
    return `Quiver is still ${status}; refresh this result later without re-generating.`;
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    return value?.failureMessage || value?.error || `Quiver task ${status}.`;
  }
  return fallback;
}

function collectStringIds(value, matcher, out = new Set()) {
  if (!value) return out;
  if (typeof value === 'string') {
    if (matcher('', value)) out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringIds(item, matcher, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
      if (typeof item === 'string' && matcher(normalizedKey, item)) out.add(item);
      else collectStringIds(item, matcher, out);
    }
  }
  return out;
}

function creationIdsFromValue(value) {
  return [...collectStringIds(value, (key) =>
    key === 'creationid' || key.endsWith('creationid')
  )];
}

async function tryFetchCreationSvg(client, creationId) {
  try {
    const svgResponse = await client.getCreationSvg(creationId);
    const svg = findSvg(svgResponse);
    return svg
      ? { svg, raw: svgResponse, ok: true }
      : {
        raw: svgResponse,
        ok: false,
        error: missingSvgMessage(svgResponse, 'Quiver SVG is not available yet; refresh this result later without re-generating.')
      };
  } catch (error) {
    try {
      const creation = await client.getCreation(creationId);
      const svg = findSvg(creation);
      return svg
        ? { svg, raw: creation, ok: true }
        : {
          raw: creation,
          ok: false,
          error: missingSvgMessage(creation, 'Quiver SVG is not available yet; refresh this result later without re-generating.')
        };
    } catch (fallbackError) {
      return { ok: false, error: fallbackError.message || error.message };
    }
  }
}

async function pollCreationSvg(client, creationId, options = {}) {
  const deadline = options.deadline || (Date.now() + Math.max(0, options.waitMs || 0));
  let attempts = 0;
  let last = null;

  do {
    attempts += 1;
    last = await tryFetchCreationSvg(client, creationId);
    if (last.ok) {
      return { ...last, attempts, status: 'ready' };
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(options.pollIntervalMs || 2500, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return {
    ...last,
    attempts,
    status: 'pending',
    error: last?.error || 'SVG was not ready before timeout'
  };
}

async function discoverCreationIdsFromTasks(client, taskIds) {
  const creationIds = new Set();
  const tasks = [];

  for (const taskId of taskIds) {
    try {
      const task = await client.getTask(taskId);
      tasks.push({ id: taskId, ok: true, raw: task });
      for (const id of creationIdsFromValue(task)) creationIds.add(id);
    } catch (error) {
      tasks.push({ id: taskId, ok: false, error: error.message });
    }
  }

  return { creationIds: [...creationIds], tasks };
}

async function pollCreationIdsFromTasks(client, taskIds, options = {}) {
  const deadline = options.deadline || (Date.now() + Math.max(0, options.waitMs || 0));
  const creationIds = new Set();
  const taskLookups = [];
  let attempts = 0;

  if (!taskIds.length) return { creationIds: [], taskLookups };

  do {
    attempts += 1;
    const discovered = await discoverCreationIdsFromTasks(client, taskIds);
    for (const id of discovered.creationIds) creationIds.add(id);
    taskLookups.push(...discovered.tasks.map((task) => ({ ...task, attempt: attempts })));
    if (creationIds.size) break;
    if (Date.now() >= deadline) break;
    await delay(Math.min(options.pollIntervalMs || 2500, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return { creationIds: [...creationIds], taskLookups };
}

async function fetchSvgOutputs(client, result, options = {}) {
  const outputs = [];
  const deadline = Date.now() + Math.max(0, options.waitMs || 0);
  const sharedOptions = { ...options, deadline };
  const creationIds = new Set(Array.isArray(result.creationIds) ? result.creationIds : []);
  const taskIds = Array.isArray(result.taskIds) ? result.taskIds : [];
  const taskLookups = [];

  if (taskIds.length && creationIds.size === 0) {
    const discovered = await pollCreationIdsFromTasks(client, taskIds, sharedOptions);
    for (const id of discovered.creationIds) creationIds.add(id);
    taskLookups.push(...discovered.taskLookups);
  } else if (taskIds.length) {
    const discovered = await discoverCreationIdsFromTasks(client, taskIds);
    for (const id of discovered.creationIds) creationIds.add(id);
    taskLookups.push(...discovered.tasks.map((task) => ({ ...task, attempt: 1 })));
  }

  const ids = [...creationIds];
  for (let index = 0; index < ids.length; index += 1) {
    const creationId = ids[index];
    const output = {
      id: creationId,
      object: 'svg',
      index,
      creation_id: creationId,
      status: 'pending'
    };

    const fetched = await pollCreationSvg(client, creationId, sharedOptions);
    output.status = fetched.status;
    output.attempts = fetched.attempts;
    if (fetched.svg) output.svg = fetched.svg;
    if (fetched.raw && !fetched.svg) output.raw = fetched.raw;
    if (fetched.error && !fetched.svg) output.error = fetched.error;

    outputs.push(output);
  }

  if (outputs.length === 0) {
    const svg = findSvg(result.text) || findSvg(result.chunks) || findSvg(result.raw);
    if (svg) {
      outputs.push({
        id: `svg-${randomUUID()}`,
        object: 'svg',
        index: 0,
        status: 'ready',
        svg
      });
    }
  }

  return { outputs, taskLookups };
}

async function generateWithWebAccount(req) {
  const prompt = promptFromBody(req.body || {});
  if (!prompt) {
    const error = new Error('prompt is required');
    error.status = 400;
    throw error;
  }

  const account = await selectGenerationAccount(req);

  try {
    const client = makeClient(account);

    const options = {
      ...req.body,
      prompt,
      model: req.body?.model || req.body?.selectedChatModel || 'arrow-1.1',
      n: normalizeCount(req.body?.n ?? req.body?.selectedGenerationCount)
    };

    const result = await client.submitGenerationTask(prompt, options);

    const { outputs, taskLookups } = await fetchSvgOutputs(client, result, {
      waitMs: normalizeWaitMs(req.body || {}),
      pollIntervalMs: normalizePollIntervalMs(req.body || {})
    });
    let balance = null;

    try {
      balance = await client.getUsage();
      AccountDB.updateCredits(account.email, balance.credits);
    } catch {
      // The generation succeeded. Balance refresh is useful but not required.
    }

    AccountDB.clearError(account.email);

    return {
      account,
      balance,
      model: options.model,
      prompt,
      result,
      outputs,
      taskLookups
    };
  } catch (error) {
    if (!error.skipAccountPenalty) AccountDB.markError(account.email);
    throw error;
  }
}

function imageInputFromBody(body = {}) {
  const image = body.image || body.reference || body.file;
  if (image) return image;
  if (body.url) return { url: body.url };
  if (body.base64 || body.b64_json || body.data_url || body.dataUrl) {
    return {
      base64: body.base64 || body.b64_json,
      data_url: body.data_url || body.dataUrl,
      mime_type: body.mime_type || body.mimeType
    };
  }
  if (Array.isArray(body.references) && body.references.length) return body.references[0];
  return null;
}

async function vectorizeWithWebAccount(req) {
  const image = imageInputFromBody(req.body || {});
  if (!image) {
    const error = new Error('image, url, base64, or references[0] is required');
    error.status = 400;
    throw error;
  }

  const account = await selectGenerationAccount(req);

  try {
    const client = makeClient(account);
    const options = {
      ...req.body,
      model: req.body?.model || req.body?.selectedChatModel || 'arrow-1.1',
      cropToContent: req.body?.auto_crop ?? req.body?.cropToContent ?? true
    };
    const result = await client.submitVectorizationTask(image, options);
    const { outputs, taskLookups } = await fetchSvgOutputs(client, result, {
      waitMs: normalizeWaitMs(req.body || {}, 180000),
      pollIntervalMs: normalizePollIntervalMs(req.body || {})
    });
    let balance = null;

    try {
      balance = await client.getUsage();
      AccountDB.updateCredits(account.email, balance.credits);
    } catch {
      // The vectorization succeeded. Balance refresh is useful but not required.
    }

    AccountDB.clearError(account.email);

    return {
      account,
      balance,
      model: options.model,
      prompt: '',
      result,
      outputs,
      taskLookups
    };
  } catch (error) {
    if (!error.skipAccountPenalty) AccountDB.markError(account.email);
    throw error;
  }
}

function idsFromBody(body = {}, snakeKey, camelKey) {
  const source = body[snakeKey] ?? body[camelKey];
  if (!source) return [];
  const items = Array.isArray(source) ? source : [source];
  return items
    .map((item) => typeof item === 'string' ? item : item?.id)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

async function pollExistingSvgResult(req) {
  const email = requestEmail(req);
  if (!email) {
    const error = new Error('email or x-quiver-account is required to refresh an existing result');
    error.status = 400;
    throw error;
  }

  const account = AccountDB.getByEmail(email);
  if (!account) {
    const error = new Error('Account not found');
    error.status = 404;
    throw error;
  }
  if (!account.session_token) {
    const error = new Error('Account has no Quiver web session cookie');
    error.status = 400;
    throw error;
  }

  const taskIds = idsFromBody(req.body || {}, 'task_ids', 'taskIds');
  const creationIds = idsFromBody(req.body || {}, 'creation_ids', 'creationIds');
  if (!taskIds.length && !creationIds.length) {
    const error = new Error('task_ids or creation_ids is required');
    error.status = 400;
    throw error;
  }

  const client = makeClient(account);
  const result = {
    chatId: req.body?.chat_id || req.body?.chatId || null,
    request: {
      references: Array.isArray(req.body?.references) ? req.body.references : []
    },
    raw: req.body?.raw || null,
    taskIds,
    creationIds,
    text: '',
    errors: []
  };
  const { outputs, taskLookups } = await fetchSvgOutputs(client, result, {
    waitMs: normalizeWaitMs(req.body || {}, 30000),
    pollIntervalMs: normalizePollIntervalMs(req.body || {})
  });

  AccountDB.clearError(account.email);

  return {
    account,
    balance: null,
    model: req.body?.model || req.body?.selectedChatModel || 'arrow-1.1',
    prompt: '',
    result,
    outputs,
    taskLookups
  };
}

function svgGenerationResponse(payload) {
  const created = nowSeconds();
  const readyCount = payload.outputs.filter((item) => !!item.svg).length;
  return {
    id: `qvg-${randomUUID()}`,
    object: 'svg.generation',
    created,
    model: payload.model,
    source: 'quiver-web',
    status: payload.outputs.length === 0
      ? 'empty'
      : readyCount === payload.outputs.length
        ? 'succeeded'
        : readyCount > 0
          ? 'partial'
          : 'pending',
    account: {
      email: payload.account.email,
      credits: payload.balance?.credits ?? payload.account.credits ?? 0
    },
    data: payload.outputs,
    chat_id: payload.result.chatId,
    task_ids: payload.result.taskIds || [],
    creation_ids: payload.result.creationIds || [],
    task_lookups: payload.taskLookups || [],
    text: payload.result.text || '',
    errors: payload.result.errors || [],
    references: payload.result.request?.references || [],
    usage: {
      credits_remaining: payload.balance?.credits ?? payload.account.credits ?? 0
    }
  };
}

function imageGenerationResponse(payload, body = {}) {
  const svg = svgGenerationResponse(payload);
  const responseFormat = String(body.response_format || body.responseFormat || 'url').toLowerCase();
  const useBase64 = responseFormat === 'b64_json';

  return {
    created: svg.created,
    source: svg.source,
    model: svg.model,
    status: svg.status,
    data: svg.data.map((item) => {
      const output = {
        index: item.index,
        status: item.status
      };

      if (item.creation_id) output.creation_id = item.creation_id;
      if (item.error) output.error = item.error;
      if (item.svg) {
        const encoded = Buffer.from(item.svg, 'utf8').toString('base64');
        output.mime_type = 'image/svg+xml';
        output.svg = item.svg;
        if (useBase64) output.b64_json = encoded;
        else output.url = `data:image/svg+xml;base64,${encoded}`;
      }

      return output;
    }),
    quiver: {
      account: svg.account.email,
      credits_remaining: svg.usage.credits_remaining,
      chat_id: svg.chat_id,
      task_ids: svg.task_ids,
      creation_ids: svg.creation_ids,
      task_lookups: svg.task_lookups,
      errors: svg.errors
    }
  };
}

function chatCompletionResponse(payload) {
  const created = nowSeconds();
  const content = payload.result.text || payload.outputs.map((item) => item.svg).filter(Boolean).join('\n\n');
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created,
    model: payload.model,
    source: 'quiver-web',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: payload.result.errors?.length ? 'error' : 'stop'
      }
    ],
    quiver: {
      account: payload.account.email,
      chat_id: payload.result.chatId,
      task_ids: payload.result.taskIds || [],
      creation_ids: payload.result.creationIds || [],
      task_lookups: payload.taskLookups || [],
      data: payload.outputs,
      balance: payload.balance ? { credits: payload.balance.credits } : null,
      errors: payload.result.errors || []
    },
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      credits_remaining: payload.balance?.credits ?? payload.account.credits ?? 0
    }
  };
}

function sendSse(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function refreshedAccountBalance(account) {
  const client = makeClient(account);
  const balance = await getWebUsage(client, account);
  AccountDB.updateCredits(account.email, balance.credits);
  AccountDB.clearError(account.email);
  return {
    email: account.email,
    status: account.status,
    credits: balance.credits,
    weekly: balance.weekly || null,
    purchased_balance: balance.purchasedBalance || 0,
    refreshed: true
  };
}

function accountStatus(account) {
  return {
    email: account.email,
    status: account.status,
    credits: account.credits || 0,
    has_session: !!account.session_token,
    error_count: account.error_count || 0
  };
}

async function buildServiceStatus(refresh = false) {
  if (refresh) {
    const accounts = AccountDB.getAll().filter((account) =>
      account.session_token && account.status !== 'disabled'
    );
    for (const account of accounts) {
      await recoverAccountByEmail(account.email);
    }
  }

  const accounts = AccountDB.getAll();
  const activeAccounts = accounts.filter((account) => account.status === 'active' && account.session_token);
  const sessionAccounts = accounts.filter((account) => account.session_token);
  const totalCredits = accounts.reduce((sum, account) => sum + Number(account.credits || 0), 0);
  const ready = activeAccounts.length > 0;

  return {
    object: 'quiver_web_status',
    source: 'quiver-web',
    ready,
    can_generate: ready,
    total_accounts: accounts.length,
    session_accounts: sessionAccounts.length,
    active_accounts: activeAccounts.length,
    no_access_accounts: accounts.filter((account) => account.status === 'no_access').length,
    disabled_accounts: accounts.filter((account) => account.status === 'disabled').length,
    total_credits: totalCredits,
    message: ready
      ? 'At least one imported web account has Quiver Create quota or access.'
      : sessionAccounts.length
        ? 'No imported web account currently has Quiver Create quota or access.'
        : 'No Quiver web sessions are imported.',
    next_step: ready
      ? 'Call /v1/svgs/generations, /v1/svgs/vectorizations, /v1/images/generations, or /v1/chat/completions.'
      : 'Import a Quiver web account that can generate on app.quiver.ai, or call /v1/status?refresh=true after Quiver grants weekly credits/access.',
    data: accounts.map(accountStatus)
  };
}

router.use(requireApiKey);

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    object: 'health',
    source: 'quiver-web',
    auth_required: !!getLocalApiKey(),
    timestamp: new Date().toISOString()
  });
});

router.get('/status', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true' || req.query.sync === 'true';
    res.json(await buildServiceStatus(refresh));
  } catch (error) {
    fail(res, error);
  }
});

router.get('/auth/status', (req, res) => {
  res.json({
    object: 'auth.status',
    configured: !!getLocalApiKey(),
    masked: maskSecret(getLocalApiKey())
  });
});

router.get('/models', (req, res) => {
  res.json({
    object: 'list',
    data: MODELS
  });
});

router.get('/models/:model', (req, res) => {
  const model = MODELS.find((item) => item.id === req.params.model);
  if (!model) {
    fail(res, new Error('Model not found'), 404);
    return;
  }
  res.json(model);
});

router.get('/balance', async (req, res) => {
  try {
    const email = requestEmail(req);
    const refresh = req.query.refresh === 'true' || req.query.sync === 'true';

    if (email) {
      const account = AccountDB.getByEmail(email);
      if (!account) {
        fail(res, new Error('Account not found'), 404);
        return;
      }
      const data = refresh && account.session_token
        ? await refreshedAccountBalance(account)
        : {
          email: account.email,
          status: account.status,
          credits: account.credits || 0,
          refreshed: false
        };
      res.json({ object: 'balance', source: 'quiver-web', data });
      return;
    }

    const accounts = AccountDB.getAll();
    const data = [];
    for (const account of accounts) {
      if (refresh && account.session_token && account.status !== 'disabled') {
        try {
          data.push(await refreshedAccountBalance(account));
        } catch (error) {
          AccountDB.markError(account.email);
          data.push({
            email: account.email,
            status: 'error',
            credits: account.credits || 0,
            refreshed: false,
            error: error.message
          });
        }
      } else {
        data.push({
          email: account.email,
          status: account.status,
          credits: account.credits || 0,
          refreshed: false
        });
      }
    }

    res.json({
      object: 'balance',
      source: 'quiver-web',
      total_credits: data.reduce((sum, item) => sum + Number(item.credits || 0), 0),
      data
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/dashboard/billing/credit_grants', async (req, res) => {
  try {
    const accounts = AccountDB.getAll();
    const total = accounts.reduce((sum, account) => sum + Number(account.credits || 0), 0);
    res.json({
      object: 'credit_summary',
      total_granted: total,
      total_used: 0,
      total_available: total,
      grants: {
        object: 'list',
        data: accounts.map((account) => ({
          object: 'credit_grant',
          email: account.email,
          status: account.status,
          amount_granted: account.credits || 0,
          amount_used: 0,
          amount_available: account.credits || 0
        }))
      }
    });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/svgs/generations', async (req, res) => {
  try {
    const payload = await generateWithWebAccount(req);
    const response = svgGenerationResponse(payload);
    if (req.body?.stream === true) {
      sendSse(res, [response]);
      return;
    }
    res.json(response);
  } catch (error) {
    fail(res, error);
  }
});

router.post('/svgs/vectorizations', async (req, res) => {
  try {
    const payload = await vectorizeWithWebAccount(req);
    const response = {
      ...svgGenerationResponse(payload),
      object: 'svg.vectorization'
    };
    if (req.body?.stream === true) {
      sendSse(res, [response]);
      return;
    }
    res.json(response);
  } catch (error) {
    fail(res, error);
  }
});

router.post('/svgs/results', async (req, res) => {
  try {
    const payload = await pollExistingSvgResult(req);
    const response = {
      ...svgGenerationResponse(payload),
      object: req.body?.object === 'svg.vectorization' ? 'svg.vectorization' : 'svg.generation'
    };
    if (req.body?.stream === true) {
      sendSse(res, [response]);
      return;
    }
    res.json(response);
  } catch (error) {
    fail(res, error);
  }
});

router.post('/images/generations', async (req, res) => {
  try {
    const payload = await generateWithWebAccount(req);
    res.json(imageGenerationResponse(payload, req.body || {}));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/chat/completions', async (req, res) => {
  try {
    const payload = await generateWithWebAccount(req);
    const response = chatCompletionResponse(payload);
    if (req.body?.stream === true) {
      const chunk = {
        id: response.id,
        object: 'chat.completion.chunk',
        created: response.created,
        model: response.model,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: response.choices[0].message.content
            },
            finish_reason: null
          }
        ]
      };
      const done = {
        id: response.id,
        object: 'chat.completion.chunk',
        created: response.created,
        model: response.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: response.choices[0].finish_reason
          }
        ]
      };
      sendSse(res, [chunk, done]);
      return;
    }
    res.json(response);
  } catch (error) {
    fail(res, error);
  }
});

module.exports = {
  router,
  getLocalApiKey,
  maskSecret
};
