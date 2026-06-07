const axios = require('axios');
const { createHash, randomUUID } = require('crypto');
const path = require('path');
const { getAxiosProxyOptions } = require('./proxy');

const QUIVER_BASE = 'https://app.quiver.ai';
const DEFAULT_MODEL = 'arrow-1.1';
const COOKIE_ATTRIBUTES = new Set([
  'path',
  'expires',
  'max-age',
  'domain',
  'secure',
  'httponly',
  'samesite',
  'priority'
]);

function normalizeCookieString(input) {
  if (!input) return '';
  if (Array.isArray(input)) return mergeCookies('', input.map(parseSetCookie).filter(Boolean).join('; '));

  const cookies = [];
  for (const part of String(input).split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [name] = trimmed.split('=', 1);
    if (COOKIE_ATTRIBUTES.has(name.trim().toLowerCase())) continue;
    cookies.push(trimmed);
  }
  return mergeCookies('', cookies.join('; '));
}

function parseSetCookie(header) {
  if (!header || typeof header !== 'string') return '';
  const first = header.split(';')[0]?.trim();
  return first && first.includes('=') ? first : '';
}

function mergeCookies(existing, incoming) {
  const map = new Map();
  const add = (cookie) => {
    if (!cookie || !cookie.includes('=')) return;
    const [name, ...valueParts] = cookie.split('=');
    const key = name.trim();
    const value = valueParts.join('=');
    if (!key || COOKIE_ATTRIBUTES.has(key.toLowerCase())) return;
    map.set(key, `${key}=${value}`);
  };

  for (const part of String(existing || '').split(';')) add(part.trim());
  for (const part of String(incoming || '').split(';')) add(part.trim());
  return [...map.values()].join('; ');
}

function extractMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data === 'string') return data.trim() || fallback;
  if (Buffer.isBuffer(data)) return data.toString('utf8') || fallback;
  return data.message || data.statusMessage || data.error || fallback;
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    let raw = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      raw += chunk;
    });
    stream.on('end', () => resolve(raw));
    stream.on('error', reject);
  });
}

function parseSse(raw) {
  const events = [];
  let event = 'message';
  let data = [];

  const flush = () => {
    if (data.length === 0) {
      event = 'message';
      return;
    }
    const payload = data.join('\n');
    events.push({ event, data: payload });
    event = 'message';
    data = [];
  };

  for (const line of String(raw || '').split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message';
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }
  flush();
  return events;
}

function addId(target, id) {
  if (typeof id === 'string' && id.trim()) target.add(id.trim());
}

function collectIds(value, out, parentKey = '') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, out, parentKey);
    return;
  }

  const type = String(value.type || value.object || '').toLowerCase();
  if (type.includes('task')) addId(out.taskIds, value.id);
  if (type.includes('creation')) addId(out.creationIds, value.id);

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    if (typeof item === 'string') {
      if (normalizedKey === 'taskid' || normalizedKey.endsWith('taskid')) addId(out.taskIds, item);
      if (normalizedKey === 'creationid' || normalizedKey.endsWith('creationid')) addId(out.creationIds, item);
      if (parentKey.includes('task') && normalizedKey === 'id') addId(out.taskIds, item);
      if (parentKey.includes('creation') && normalizedKey === 'id') addId(out.creationIds, item);
      continue;
    }

    if (Array.isArray(item)) {
      if (normalizedKey === 'taskids' || normalizedKey.endsWith('taskids')) {
        for (const id of item) addId(out.taskIds, id);
      }
      if (normalizedKey === 'creationids' || normalizedKey.endsWith('creationids')) {
        for (const id of item) addId(out.creationIds, id);
      }
    }

    collectIds(item, out, normalizedKey || parentKey);
  }
}

function accessEnabled(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.enabled === true) return true;
  if (value.hasAccess === true) return true;
  if (value.allowed === true) return true;
  if (value.canAccess === true) return true;
  if (value.data && typeof value.data === 'object') return accessEnabled(value.data);
  if (value.access && typeof value.access === 'object') return accessEnabled(value.access);
  if (value.chat && typeof value.chat === 'object') return accessEnabled(value.chat);
  return false;
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseUsageCredits(data) {
  const payload = data?.data && typeof data.data === 'object' ? data.data : data;
  const weekly = payload?.weekly && typeof payload.weekly === 'object' ? payload.weekly : {};
  const used = numericOrNull(weekly.used);
  const limit = numericOrNull(weekly.limit);
  const explicitRemaining = numericOrNull(weekly.remaining);
  const remaining = explicitRemaining !== null
    ? explicitRemaining
    : limit !== null && used !== null
      ? Math.max(0, limit - used)
      : 0;
  const purchasedBalance = numericOrNull(
    payload?.purchasedBalance ?? payload?.purchased_balance ?? payload?.balance
  ) ?? 0;
  const credits = Math.max(0, remaining) + Math.max(0, purchasedBalance);

  return {
    credits,
    weekly: {
      used: used ?? 0,
      limit: limit ?? 0,
      remaining: Math.max(0, remaining),
      resetOn: weekly.resetOn ?? weekly.reset_on ?? null
    },
    purchasedBalance,
    raw: data
  };
}

function createAccessEnabled(value) {
  if (!value || typeof value !== 'object') return false;
  const usage = value.weekly || value.purchasedBalance !== undefined
    ? value
    : parseUsageCredits(value);
  return Number(usage.credits || 0) > 0
    || Number(usage.weekly?.remaining || 0) > 0
    || Number(usage.purchasedBalance || 0) > 0;
}

function parseQuiverStream(raw) {
  const chunks = [];
  const text = [];
  const errors = [];
  const ids = { taskIds: new Set(), creationIds: new Set() };

  for (const event of parseSse(raw)) {
    if (event.data === '[DONE]') continue;
    try {
      const chunk = JSON.parse(event.data);
      chunks.push(chunk);

      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') text.push(chunk.delta);
      if (chunk.type === 'error' && typeof chunk.errorText === 'string') errors.push(chunk.errorText);
      collectIds(chunk, ids);
    } catch {
      chunks.push({ type: 'raw', event: event.event, data: event.data });
    }
  }

  return {
    chunks,
    text: text.join(''),
    errors,
    taskIds: [...ids.taskIds],
    creationIds: [...ids.creationIds]
  };
}

function buildUserMessage(prompt, files = undefined) {
  const parts = [];
  const text = String(prompt || '').trim();
  if (text) parts.push({ type: 'text', text });
  if (Array.isArray(files)) {
    for (const file of files) parts.push(file);
  }
  return {
    id: randomUUID(),
    role: 'user',
    parts
  };
}

function parseDataUrl(value) {
  const match = String(value || '').trim().match(/^data:([^;,]+)?(;base64)?,([\s\S]+)$/i);
  if (!match) return null;
  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = !!match[2];
  const payload = match[3] || '';
  return {
    mimeType,
    base64: isBase64
      ? payload.replace(/\s+/g, '')
      : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64')
  };
}

function normalizeReference(item) {
  if (!item) return null;

  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (!trimmed) return null;
    const dataUrl = parseDataUrl(trimmed);
    if (dataUrl) return { base64: dataUrl.base64, mimeType: dataUrl.mimeType };
    if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
    return { uploadId: trimmed };
  }

  if (typeof item !== 'object') return null;

  const uploadId = item.uploadId || item.upload_id || item.referenceId || item.reference_id || item.id;
  if (uploadId) return { uploadId: String(uploadId).trim() };

  const url = item.url || item.image_url || item.imageUrl;
  if (url) return {
    url: String(url).trim(),
    filename: item.filename || item.name,
    mimeType: item.mime_type || item.mimeType || item.mediaType
  };

  const dataUrl = parseDataUrl(item.data_url || item.dataUrl || item.src || '');
  if (dataUrl) return {
    base64: dataUrl.base64,
    filename: item.filename || item.name,
    mimeType: item.mime_type || item.mimeType || item.mediaType || dataUrl.mimeType
  };

  const base64 = item.base64 || item.b64_json || item.b64Json;
  if (base64) {
    const parsed = parseDataUrl(base64);
    return {
      base64: parsed ? parsed.base64 : String(base64).replace(/\s+/g, ''),
      filename: item.filename || item.name,
      mimeType: item.mime_type || item.mimeType || item.mediaType || parsed?.mimeType || undefined
    };
  }

  return null;
}

function normalizeTaskReferences(options = {}) {
  const items = [];
  if (Array.isArray(options.referenceIds)) items.push(...options.referenceIds);
  if (Array.isArray(options.references)) items.push(...options.references);
  if (options.image) items.push(options.image);
  if (Array.isArray(options.images)) items.push(...options.images);

  const seen = new Set();
  const references = [];
  for (const item of items) {
    const reference = normalizeReference(item);
    if (!reference) continue;
    const key = JSON.stringify(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }

  return references.slice(0, 4).map((reference) => {
    if (reference.uploadId) return { uploadId: reference.uploadId };
    if (reference.url) {
      const item = { url: reference.url };
      if (reference.filename) item.filename = reference.filename;
      if (reference.mimeType) item.mimeType = reference.mimeType;
      return item;
    }
    const item = { base64: reference.base64 };
    if (reference.mimeType) item.mimeType = reference.mimeType;
    if (reference.filename) item.filename = reference.filename;
    return item;
  });
}

function extensionFromMimeType(mimeType = '') {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/svg+xml') return 'svg';
  return 'bin';
}

function filenameFromUrl(url, mimeType) {
  try {
    const parsed = new URL(url);
    const name = path.basename(parsed.pathname || '');
    if (name && name !== '/' && /\.[a-z0-9]+$/i.test(name)) return name;
  } catch {
    // Fall through to a generated filename.
  }
  return `reference-${randomUUID()}.${extensionFromMimeType(mimeType)}`;
}

function dataUrlFromBase64(base64, mimeType = '') {
  const parsed = parseDataUrl(base64);
  const cleanBase64 = parsed ? parsed.base64 : String(base64 || '').replace(/\s+/g, '');
  return {
    buffer: Buffer.from(cleanBase64, 'base64'),
    mediaType: parsed?.mimeType || mimeType || 'image/png'
  };
}

function mimeTypeFromFilename(filename = '') {
  const extension = path.extname(String(filename || '')).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.svg') return 'image/svg+xml';
  return '';
}

function taskResponseFromCreateResponse(response, requestBody) {
  const taskId = response?.taskId || response?.id || null;
  const creationIds = Array.isArray(response?.creationIds)
    ? response.creationIds
    : Array.isArray(response?.creations)
      ? response.creations.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean)
      : [];

  return {
    chatId: null,
    request: requestBody,
    raw: response,
    status: response?.status || null,
    traceId: response?.traceId || null,
    taskId,
    taskIds: taskId ? [taskId] : [],
    creationIds,
    chunks: [],
    text: '',
    errors: []
  };
}

class QuiverClient {
  constructor(email = null, sessionToken = null, allCookies = null) {
    this.email = email;
    this.cookies = normalizeCookieString(allCookies || sessionToken || '');

    this.client = axios.create({
      baseURL: QUIVER_BASE,
      timeout: 120000,
      ...getAxiosProxyOptions(),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: QUIVER_BASE,
        Referer: `${QUIVER_BASE}/`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    this.client.interceptors.request.use((config) => {
      if (this.cookies) {
        config.headers = config.headers || {};
        config.headers.Cookie = this.cookies;
      }
      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        this.captureCookies(response);
        return response;
      },
      (error) => {
        if (error.response) this.captureCookies(error.response);
        return Promise.reject(error);
      }
    );
  }

  static normalizeCookieString(input) {
    return normalizeCookieString(input);
  }

  static parseQuiverStream(raw) {
    return parseQuiverStream(raw);
  }

  static accessEnabled(value) {
    return accessEnabled(value);
  }

  static parseUsageCredits(data) {
    return parseUsageCredits(data);
  }

  static createAccessEnabled(value) {
    return createAccessEnabled(value);
  }

  static normalizeTaskReferences(options) {
    return normalizeTaskReferences(options);
  }

  captureCookies(response) {
    const setCookie = response?.headers?.['set-cookie'];
    if (!setCookie) return;
    const incoming = Array.isArray(setCookie)
      ? setCookie.map(parseSetCookie).filter(Boolean).join('; ')
      : parseSetCookie(setCookie);
    this.cookies = mergeCookies(this.cookies, incoming);
  }

  getCookieHeader() {
    return this.cookies;
  }

  async request(method, path, options = {}) {
    try {
      const response = await this.client.request({ method, url: path, ...options });
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const message = extractMessage(error.response?.data, error.message);
      const err = new Error(status ? `${message} (${status})` : message);
      err.status = status;
      err.data = error.response?.data;
      throw err;
    }
  }

  async initSession() {
    return this.request('GET', '/api/_auth/session');
  }

  async getSession() {
    return this.request('GET', '/api/_auth/session');
  }

  async sendMagicCode(email = this.email, intent = 'signin', options = {}) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) throw new Error('Email is required');
    const body = {
      email: normalizedEmail,
      intent: intent === 'signup' ? 'signup' : 'signin'
    };
    if (options.resend) body.resend = true;
    return this.request('POST', '/api/auth/magic', { data: body });
  }

  async verifyMagicCode(email = this.email, code, redirectTo = undefined) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedCode = String(code || '').trim();
    if (!normalizedEmail) throw new Error('Email is required');
    if (!/^\d{6}$/.test(normalizedCode)) throw new Error('Verification code must be 6 digits');

    const data = await this.request('POST', '/api/auth/magic/verify', {
      data: {
        email: normalizedEmail,
        code: normalizedCode,
        ...(redirectTo ? { redirectTo } : {})
      }
    });

    return {
      ...data,
      cookies: this.getCookieHeader()
    };
  }

  async checkSession() {
    try {
      const session = await this.getSession();
      return !!session?.user;
    } catch {
      return false;
    }
  }

  async getBalance() {
    const data = await this.request('GET', '/api/billing/balance', {
      headers: { Referer: `${QUIVER_BASE}/settings/billing` }
    });
    const credits = data?.data?.credits ?? data?.credits ?? data?.balance ?? 0;
    return { credits, raw: data };
  }

  async getUsage() {
    const data = await this.request('GET', '/api/billing/usage', {
      headers: { Referer: `${QUIVER_BASE}/settings/usage` }
    });
    return parseUsageCredits(data);
  }

  async getChatAccess() {
    return this.request('GET', '/api/chat/access');
  }

  async getExploreAccess() {
    return this.request('GET', '/api/explore/access');
  }

  async getSubscription() {
    return this.request('GET', '/api/billing/subscription', {
      headers: { Referer: `${QUIVER_BASE}/settings/billing` }
    });
  }

  async getTransactions(params = {}) {
    return this.request('GET', '/api/billing/transactions', {
      params: { limit: 50, ...params },
      headers: { Referer: `${QUIVER_BASE}/settings/usage` }
    });
  }

  async getChats(params = {}) {
    return this.request('GET', '/api/chats', { params });
  }

  async createChat(chat = {}) {
    return this.request('POST', '/api/chats', {
      data: {
        id: chat.id || randomUUID(),
        title: chat.title || 'New Chat',
        ...chat
      }
    });
  }

  async updateChat(chatId, patch) {
    return this.request('PATCH', `/api/chats/${encodeURIComponent(chatId)}`, { data: patch });
  }

  async deleteChat(chatId) {
    return this.request('DELETE', `/api/chats/${encodeURIComponent(chatId)}`);
  }

  async getChat(chatId) {
    return this.request('GET', `/api/chats/${encodeURIComponent(chatId)}`);
  }

  async getMessages(chatId) {
    return this.request('GET', '/api/messages', { params: { chatId } });
  }

  async getArtifacts(chatId) {
    return this.request('GET', '/api/artifacts', { params: { chatId } });
  }

  async getTask(taskId) {
    return this.request('GET', `/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async presignUpload(file, options = {}) {
    const body = {
      contentSha256: createHash('sha256').update(file.buffer).digest('hex'),
      dedupeScope: `${options.intent || 'generation-reference'}:${options.crop ? 'crop' : 'original'}`,
      filename: file.filename,
      mediaType: file.mediaType,
      size: file.buffer.length
    };
    return this.request('POST', '/api/uploads/presign', {
      data: body,
      headers: { Referer: `${QUIVER_BASE}/creations` }
    });
  }

  async completeUpload(uploadId) {
    return this.request('POST', `/api/uploads/${encodeURIComponent(uploadId)}/complete`, {
      headers: { Referer: `${QUIVER_BASE}/creations` }
    });
  }

  async uploadContent(uploadId, file) {
    return this.request('PUT', `/api/uploads/${encodeURIComponent(uploadId)}/content`, {
      data: file.buffer,
      headers: {
        Accept: 'application/json',
        'Content-Type': file.mediaType,
        Referer: `${QUIVER_BASE}/creations`
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 180000
    });
  }

  async uploadToPresignedUrl(url, file, headers = {}) {
    await axios.put(url, file.buffer, {
      headers: {
        ...headers,
        'Content-Type': headers['Content-Type'] || headers['content-type'] || file.mediaType
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 180000,
      validateStatus: (status) => status >= 200 && status < 300,
      ...getAxiosProxyOptions()
    });
  }

  async uploadImageReference(file, options = {}) {
    if (!file?.buffer?.length) {
      const error = new Error('Reference image is empty');
      error.status = 400;
      throw error;
    }

    const mediaType = String(file.mediaType || '').split(';')[0].trim().toLowerCase();
    if (!mediaType.startsWith('image/')) {
      const error = new Error(`Reference image media type must be image/*, got ${file.mediaType || 'unknown'}`);
      error.status = 400;
      throw error;
    }

    const presign = await this.presignUpload(file, options);
    const uploadId = presign?.uploadId || presign?.id;
    if (!uploadId) {
      const error = new Error('Quiver upload presign response did not include uploadId');
      error.status = 502;
      error.data = presign;
      throw error;
    }

    if (presign.uploadRequired === false) return uploadId;

    const presignedUrl = presign.presignedUrl || presign.url || presign.uploadUrl;
    const uploadHeaders = presign.uploadHeaders || presign.headers || {};
    if (presignedUrl) {
      try {
        await this.uploadToPresignedUrl(presignedUrl, file, uploadHeaders);
        await this.completeUpload(uploadId);
        return uploadId;
      } catch {
        // Quiver web falls back to same-origin upload when direct storage upload fails.
      }
    }

    await this.uploadContent(uploadId, file);
    return uploadId;
  }

  async fileFromReference(reference) {
    if (reference.base64) {
      const image = dataUrlFromBase64(reference.base64, reference.mimeType || reference.mediaType);
      return {
        buffer: image.buffer,
        filename: reference.filename || `reference-${randomUUID()}.${extensionFromMimeType(image.mediaType)}`,
        mediaType: image.mediaType
      };
    }

    if (reference.url) {
      const response = await axios.get(reference.url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 24 * 1024 * 1024,
        validateStatus: (status) => status >= 200 && status < 300,
        ...getAxiosProxyOptions()
      });
      const mediaType = String(
        reference.mimeType ||
        reference.mediaType ||
        response.headers?.['content-type'] ||
        mimeTypeFromFilename(reference.filename || reference.url) ||
        'image/png'
      ).split(';')[0].trim();
      return {
        buffer: Buffer.from(response.data),
        filename: reference.filename || filenameFromUrl(reference.url, mediaType),
        mediaType
      };
    }

    return null;
  }

  async resolveTaskReferences(references, options = {}) {
    const resolved = [];
    for (const reference of references.slice(0, 4)) {
      if (reference.uploadId) {
        resolved.push({ uploadId: reference.uploadId });
        continue;
      }

      const file = await this.fileFromReference(reference);
      if (!file) continue;
      const uploadId = await this.uploadImageReference(file, options);
      resolved.push({ uploadId });
    }
    return resolved;
  }

  async createTask(body, options = {}) {
    const traceId = String(options.traceId || randomUUID());
    const data = await this.request('POST', '/api/tasks', {
      data: body,
      headers: {
        Referer: `${QUIVER_BASE}/creations`,
        'x-trace-id': traceId
      },
      timeout: options.timeout || 180000
    });
    return { ...data, traceId: data?.traceId || traceId };
  }

  async submitGenerationTask(prompt, options = {}) {
    const generationCount = Number.isFinite(Number(options.n ?? options.selectedGenerationCount))
      ? Math.max(1, Math.min(4, Math.round(Number(options.n ?? options.selectedGenerationCount))))
      : 1;
    const body = {
      method: 'generate',
      model: options.model || options.selectedChatModel || DEFAULT_MODEL,
      n: generationCount,
      prompt: String(prompt || '').trim(),
      stream: false
    };

    const references = await this.resolveTaskReferences(normalizeTaskReferences(options), {
      intent: options.uploadIntent || 'generation-reference',
      crop: !!options.cropToContent
    });
    if (references.length) {
      body.references = references;
    }

    const response = await this.createTask(body, {
      traceId: options.traceId,
      timeout: options.timeout
    });
    return taskResponseFromCreateResponse(response, body);
  }

  async submitVectorizationTask(input, options = {}) {
    const [image] = await this.resolveTaskReferences(normalizeTaskReferences({ image: input }), {
      intent: options.uploadIntent || 'generation-reference',
      crop: !!options.cropToContent
    });
    if (!image?.uploadId) {
      const error = new Error('image, url, base64, or uploadId is required');
      error.status = 400;
      throw error;
    }

    const body = {
      method: 'vectorize',
      model: options.model || options.selectedChatModel || DEFAULT_MODEL,
      image,
      stream: false
    };

    const response = await this.createTask(body, {
      traceId: options.traceId,
      timeout: options.timeout
    });
    return taskResponseFromCreateResponse(response, body);
  }

  async getCreation(creationId) {
    return this.request('GET', `/api/creations/${encodeURIComponent(creationId)}`);
  }

  async getCreationSvg(creationId) {
    return this.request('GET', `/api/creations/${encodeURIComponent(creationId)}/svg`);
  }

  async sendChatMessage(chatId, prompt, options = {}) {
    const id = chatId || randomUUID();
    const generationCount = Number.isFinite(Number(options.selectedGenerationCount ?? options.n))
      ? Math.max(1, Math.min(4, Math.round(Number(options.selectedGenerationCount ?? options.n))))
      : 1;
    const message = options.message || buildUserMessage(prompt, options.files);

    const body = {
      id,
      selectedChatModel: options.model || options.selectedChatModel || DEFAULT_MODEL,
      selectedGenerationCount: generationCount,
      selectedVisibilityType: options.visibility || options.selectedVisibilityType || 'private',
      message
    };

    const response = await this.client.post('/api/chat', body, {
      responseType: 'stream',
      headers: {
        Accept: 'text/event-stream',
        Referer: `${QUIVER_BASE}/agent/${encodeURIComponent(id)}`
      },
      timeout: options.timeout || 180000
    });

    const raw = await streamToString(response.data);
    return {
      chatId: id,
      request: body,
      raw,
      ...parseQuiverStream(raw)
    };
  }

  async createAndSendChat(prompt, options = {}) {
    const chatId = options.chatId || randomUUID();
    const normalizedPrompt = String(prompt || '').trim();
    const title = options.title || normalizedPrompt.replace(/\s+/g, ' ').slice(0, 120) || 'New Chat';
    const chat = await this.createChat({ id: chatId, title });
    const stream = await this.sendChatMessage(chatId, normalizedPrompt, options);
    return { chat, ...stream };
  }
}

module.exports = QuiverClient;
