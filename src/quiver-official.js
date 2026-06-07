const axios = require('axios');
const { ConfigDB } = require('./db');
const { getAxiosProxyOptions } = require('./proxy');

const QUIVER_API_BASE = 'https://api.quiver.ai';

function getApiKey() {
  return String(ConfigDB.get('quiver_api_key') || process.env.QUIVERAI_API_KEY || '').trim();
}

function maskApiKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 3)}***`;
  return `${key.slice(0, 6)}***${key.slice(-4)}`;
}

function extractMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data === 'string') return data.trim() || fallback;
  return data.message || data.error || fallback;
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
    if (!data.length) {
      event = 'message';
      return;
    }
    events.push({ event, data: data.join('\n') });
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
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }

  flush();
  return events;
}

function parseOfficialStream(raw) {
  const events = [];
  const outputs = new Map();
  let credits = 0;

  for (const event of parseSse(raw)) {
    if (event.data === '[DONE]') continue;
    try {
      const data = JSON.parse(event.data);
      events.push({ event: event.event, data });
      if (data?.id) {
        outputs.set(data.id, {
          ...(outputs.get(data.id) || {}),
          ...data,
          event: event.event
        });
      }
      if (Number.isFinite(Number(data?.credits))) credits += Number(data.credits);
    } catch {
      events.push({ event: event.event, data: event.data });
    }
  }

  return {
    events,
    data: [...outputs.values()]
      .filter((item) => item.svg)
      .map((item) => ({ id: item.id, index: item.index, svg: item.svg, type: item.type })),
    credits,
    raw
  };
}

class OfficialQuiverClient {
  constructor(apiKey = getApiKey()) {
    this.apiKey = String(apiKey || '').trim();
    if (!this.apiKey) {
      const error = new Error('QuiverAI API key is not configured');
      error.status = 400;
      throw error;
    }

    this.client = axios.create({
      baseURL: QUIVER_API_BASE,
      timeout: 180000,
      ...getAxiosProxyOptions(),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': 'quiver2api/1.0'
      }
    });
  }

  static getApiKey() {
    return getApiKey();
  }

  static maskApiKey(value) {
    return maskApiKey(value);
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

  async listModels() {
    return this.request('GET', '/v1/models');
  }

  async getModel(model) {
    if (!model) {
      const error = new Error('model is required');
      error.status = 400;
      throw error;
    }
    return this.request('GET', `/v1/models/${encodeURIComponent(model)}`);
  }

  normalizeGenerationBody(input = {}) {
    const prompt = String(input.prompt || input.message || input.text || '').trim();
    if (!prompt) {
      const error = new Error('prompt is required');
      error.status = 400;
      throw error;
    }

    const n = Number.isFinite(Number(input.n ?? input.selectedGenerationCount))
      ? Math.max(1, Math.min(16, Math.round(Number(input.n ?? input.selectedGenerationCount))))
      : 1;

    return {
      model: input.model || input.selectedChatModel || 'arrow-1.1',
      prompt,
      stream: input.stream === true,
      n,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.references ? { references: input.references } : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
      ...(input.max_output_tokens ? { max_output_tokens: Number(input.max_output_tokens) } : {}),
      ...(input.temperature !== undefined ? { temperature: Number(input.temperature) } : {}),
      ...(input.top_p !== undefined ? { top_p: Number(input.top_p) } : {}),
      ...(input.presence_penalty !== undefined ? { presence_penalty: Number(input.presence_penalty) } : {})
    };
  }

  async generateSVG(input = {}) {
    const body = this.normalizeGenerationBody(input);
    if (!body.stream) return this.request('POST', '/v1/svgs/generations', { data: body });

    const response = await this.client.post('/v1/svgs/generations', body, {
      responseType: 'stream',
      headers: { Accept: 'text/event-stream' }
    });
    const raw = await streamToString(response.data);
    return { ...parseOfficialStream(raw), request: body };
  }

  async vectorizeSVG(input = {}) {
    const image = input.image || (input.url ? { url: input.url } : null) || (input.base64 ? { base64: input.base64 } : null);
    if (!image) {
      const error = new Error('image, url, or base64 is required');
      error.status = 400;
      throw error;
    }

    const body = {
      model: input.model || 'arrow-1.1',
      image,
      stream: input.stream === true,
      ...(input.auto_crop !== undefined ? { auto_crop: !!input.auto_crop } : {}),
      ...(input.target_size ? { target_size: Number(input.target_size) } : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
      ...(input.max_output_tokens ? { max_output_tokens: Number(input.max_output_tokens) } : {}),
      ...(input.temperature !== undefined ? { temperature: Number(input.temperature) } : {}),
      ...(input.top_p !== undefined ? { top_p: Number(input.top_p) } : {}),
      ...(input.presence_penalty !== undefined ? { presence_penalty: Number(input.presence_penalty) } : {})
    };

    if (!body.stream) return this.request('POST', '/v1/svgs/vectorizations', { data: body });

    const response = await this.client.post('/v1/svgs/vectorizations', body, {
      responseType: 'stream',
      headers: { Accept: 'text/event-stream' }
    });
    const raw = await streamToString(response.data);
    return { ...parseOfficialStream(raw), request: body };
  }
}

module.exports = OfficialQuiverClient;
