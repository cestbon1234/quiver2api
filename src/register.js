const axios = require('axios');
const { AccountDB, ConfigDB } = require('./db');
const QuiverClient = require('./quiver');
const { getAxiosProxyOptions } = require('./proxy');

const YYDS_API_BASE = 'https://maliapi.215.im/v1';
const DEFAULT_DOMAINS = ['yyds.dev', '215.im', 'mail.215.im'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function randomLocalPart() {
  const words = [
    'alex', 'blue', 'carta', 'daily', 'ember', 'frame', 'glow', 'harbor',
    'indigo', 'juno', 'kepler', 'lumen', 'mira', 'nova', 'orbit', 'pixel',
    'quartz', 'river', 'sketch', 'tempo', 'urban', 'vector', 'willow', 'zen'
  ];
  const left = words[Math.floor(Math.random() * words.length)];
  const right = words[Math.floor(Math.random() * words.length)];
  const number = Math.floor(1000 + Math.random() * 9000);
  return `${left}.${right}${number}`;
}

class AutoRegister {
  constructor() {
    this.domains = DEFAULT_DOMAINS;
    this.blockedDomains = new Set();
    this.logCallback = null;
  }

  setLogCallback(callback) {
    this.logCallback = typeof callback === 'function' ? callback : null;
  }

  log(message, type = 'info') {
    console.log(message);
    if (this.logCallback) this.logCallback(message, type);
  }

  getApiKey() {
    return ConfigDB.get('yyds_api_key') || process.env.YYDS_API_KEY || '';
  }

  async getAvailableDomains() {
    const apiKey = this.getApiKey();
    if (!apiKey) return this.domains.filter((domain) => !this.blockedDomains.has(domain));

    try {
      const response = await axios.get(`${YYDS_API_BASE}/domains`, {
        headers: { 'X-API-Key': apiKey },
        ...getAxiosProxyOptions(),
        timeout: 30000
      });
      const payload = response.data;
      const domains = payload?.data || payload?.['hydra:member'] || payload || [];
      const parsed = Array.isArray(domains)
        ? domains.map((item) => item.domain || item.name || item).filter(Boolean)
        : [];
      const unique = [...new Set(parsed.map(String))];
      return unique.filter((domain) => !this.blockedDomains.has(domain));
    } catch (error) {
      this.log(`Failed to load YYDS domains, using defaults: ${error.message}`, 'warning');
      return this.domains.filter((domain) => !this.blockedDomains.has(domain));
    }
  }

  blockDomain(domain) {
    if (domain) this.blockedDomains.add(domain);
  }

  async createTempEmail(maxRetries = 5) {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('YYDS Mail API key is not configured');

    const domains = await this.getAvailableDomains();
    if (domains.length === 0) throw new Error('No available temporary email domains');

    const shuffled = [...domains].sort(() => Math.random() - 0.5);
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const domain = shuffled[attempt % shuffled.length];
      const localPart = randomLocalPart();

      try {
        this.log(`Creating mailbox on ${domain}`);
        const response = await axios.post(
          `${YYDS_API_BASE}/accounts`,
          { localPart, domain },
          {
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': apiKey
            },
            ...getAxiosProxyOptions(),
            timeout: 30000
          }
        );

        if (response.data?.success === false) {
          throw new Error(response.data?.error || 'Mailbox creation failed');
        }

        const data = response.data?.data || response.data;
        const email = normalizeEmail(data.address || data.email);
        if (!email) throw new Error('YYDS did not return an email address');
        return { email, token: data.token || null };
      } catch (error) {
        lastError = error;
        this.log(`Mailbox domain ${domain} failed: ${error.response?.data?.error || error.message}`, 'warning');
        await delay(1000);
      }
    }

    throw new Error(`Failed to create temporary mailbox: ${lastError?.message || 'unknown error'}`);
  }

  async getMessages(email) {
    const apiKey = this.getApiKey();
    const address = normalizeEmail(email);
    if (!apiKey || !address) return [];

    try {
      const response = await axios.get(`${YYDS_API_BASE}/messages`, {
        params: { address },
        headers: { 'X-API-Key': apiKey },
        ...getAxiosProxyOptions(),
        timeout: 30000
      });
      const payload = response.data;
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.data)) return payload.data;
      if (Array.isArray(payload?.data?.messages)) return payload.data.messages;
      if (Array.isArray(payload?.['hydra:member'])) return payload['hydra:member'];
      return [];
    } catch (error) {
      this.log(`Failed to read mailbox ${address}: ${error.message}`, 'warning');
      return [];
    }
  }

  async getMessage(email, messageId) {
    const apiKey = this.getApiKey();
    const address = normalizeEmail(email);
    if (!apiKey || !address || !messageId) return null;

    try {
      const response = await axios.get(`${YYDS_API_BASE}/messages/${messageId}`, {
        params: { address },
        headers: { 'X-API-Key': apiKey },
        ...getAxiosProxyOptions(),
        timeout: 30000
      });
      return response.data?.data || response.data;
    } catch (error) {
      this.log(`Failed to read message ${messageId}: ${error.message}`, 'warning');
      return null;
    }
  }

  extractCode(message) {
    const body = htmlToText([
      message?.subject,
      message?.text,
      message?.html,
      message?.body,
      message?.content
    ].filter(Boolean).join('\n'));

    const direct = body.match(/\b(\d{6})\b/);
    if (direct) return direct[1];

    const labeled = body.match(/(?:code|verification|verify)[^\d]{0,20}(\d{6})/i);
    return labeled ? labeled[1] : null;
  }

  async waitForCode(email, maxRetries = 45, intervalMs = 2000) {
    const address = normalizeEmail(email);
    this.log(`Waiting for verification email: ${address}`);

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const messages = await this.getMessages(address);
      this.log(`Mailbox poll ${attempt}/${maxRetries}: ${messages.length} messages`);

      for (const message of messages) {
        const subject = String(message.subject || '').toLowerCase();
        const from = String(message.from?.address || message.from || '').toLowerCase();
        const looksRelevant =
          subject.includes('quiver') ||
          subject.includes('code') ||
          subject.includes('verify') ||
          subject.includes('sign') ||
          from.includes('quiver') ||
          from.includes('workos');

        if (!looksRelevant) continue;
        const full = await this.getMessage(address, message.id);
        const code = this.extractCode(full || message);
        if (code) {
          this.log(`Verification code received: ${code}`, 'success');
          return code;
        }
      }

      await delay(intervalMs);
    }

    throw new Error('Timed out waiting for verification code');
  }

  isRetryableSignupRejection(error) {
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes("couldn't create a new account") ||
      message.includes('already') ||
      message.includes('used before') ||
      message.includes('use a different email')
    );
  }

  async getWebUsage(client, email) {
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
        this.log(`Account created, usage check failed: ${balanceError.message}`, 'warning');
        return {
          credits: 0,
          weekly: null,
          purchasedBalance: 0,
          error: balanceError.message,
          usage_error: usageError.message
        };
      }
    }
  }

  async finishQuiverSignup(email, options = {}) {
    const intent = options.intent === 'signin' ? 'signin' : 'signup';
    const redirectTo = options.redirectTo || (intent === 'signup' ? '/agent' : undefined);
    this.log(`Starting Quiver ${intent} flow for ${email}`);
    const client = new QuiverClient(email);
    await client.initSession();
    await client.sendMagicCode(email, intent);
    this.log('Verification code requested');

    const code = options.code || await this.waitForCode(email, options.maxRetries, options.intervalMs);
    const verification = await client.verifyMagicCode(email, code, redirectTo);
    const cookies = verification.cookies || client.getCookieHeader();
    if (!cookies) throw new Error('Verification succeeded but no session cookie was returned');

    AccountDB.add(email, null, cookies);
    AccountDB.updateSession(email, cookies);

    let credits = 0;
    const usage = await this.getWebUsage(client, email);
    credits = usage.credits || 0;
    AccountDB.updateCredits(email, credits);

    let chatAccess = null;
    let exploreAccess = null;
    try {
      [chatAccess, exploreAccess] = await Promise.all([
        client.getChatAccess(),
        client.getExploreAccess()
      ]);
    } catch (error) {
      this.log(`Account created, access check failed: ${error.message}`, 'warning');
    }

    const canCreate = QuiverClient.createAccessEnabled(usage) || QuiverClient.accessEnabled(chatAccess);
    AccountDB.updateStatus(email, canCreate ? 'active' : 'no_access');
    if (!canCreate) {
      this.log(`Account has no Quiver Create quota/access: ${email}`, 'warning');
    }

    this.log(`Registered and saved account: ${email}`, 'success');
    return {
      email,
      credits,
      cookies,
      usage,
      chatAccess,
      exploreAccess,
      canCreate,
      success: true
    };
  }

  async registerOne(options = {}) {
    const suppliedEmail = normalizeEmail(options.email);
    if (suppliedEmail) return this.finishQuiverSignup(suppliedEmail, options);

    const maxEmailAttempts = Math.max(1, Math.min(Number(options.emailAttempts) || 6, 12));
    const requireAccess = options.requireAccess !== false;
    let lastError = null;

    for (let attempt = 1; attempt <= maxEmailAttempts; attempt += 1) {
      const mailbox = await this.createTempEmail();
      try {
        this.log(`Trying mailbox ${attempt}/${maxEmailAttempts}: ${mailbox.email}`);
        const result = await this.finishQuiverSignup(mailbox.email, options);
        if (requireAccess && !result.canCreate) {
          const domain = mailbox.email.split('@')[1];
          this.blockDomain(domain);
          if (options.keepNoAccess !== true) {
            AccountDB.delete(mailbox.email);
            this.log(`Removed ${mailbox.email} from the account pool because Quiver did not grant Create quota/access`, 'warning');
          }
          lastError = new Error(
            `Registered ${mailbox.email}, but Quiver returned no remaining weekly or purchased Create credits`
          );
          this.log(`${lastError.message}; trying another mailbox/domain`, 'warning');
          await delay(1500);
          continue;
        }
        return result;
      } catch (error) {
        lastError = error;
        const domain = mailbox.email.split('@')[1];
        if (this.isRetryableSignupRejection(error)) {
          this.blockDomain(domain);
          this.log(`Quiver rejected ${mailbox.email}; switching mailbox/domain`, 'warning');
          await delay(1500);
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Unable to register a usable Quiver web account. ${lastError?.message || 'unknown error'}. ` +
      'Quiver is currently accepting these signup sessions but not granting Create quota/access or web credits.'
    );
  }

  async registerBatch(count = 1, delayMs = 8000) {
    const safeCount = Math.max(1, Math.min(Number(count) || 1, 5));
    const results = [];

    for (let index = 0; index < safeCount; index += 1) {
      try {
        this.log(`Registering account ${index + 1}/${safeCount}`);
        results.push(await this.registerOne());
      } catch (error) {
        this.log(`Registration ${index + 1}/${safeCount} failed: ${error.message}`, 'error');
        results.push({ success: false, email: null, error: error.message });
      }

      if (index < safeCount - 1) await delay(Math.max(5000, Number(delayMs) || 8000));
    }

    return results;
  }
}

module.exports = new AutoRegister();
