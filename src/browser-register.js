const puppeteer = require('puppeteer-core');
const { AccountDB, ConfigDB } = require('./db');
const axios = require('axios');

const YYDS_API_BASE = 'https://maliapi.215.im/v1';

// 延迟函数
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// 日志回调
let logCallback = null;

class BrowserRegister {
  constructor() {
    this.domains = ['yyds.dev', '215.im', 'mail.215.im'];
    this.blockedDomains = [];
    this.browser = null;
  }

  setLogCallback(callback) {
    logCallback = callback;
  }

  log(msg, type = 'info') {
    console.log(msg);
    if (logCallback) logCallback(msg, type);
  }

  getApiKey() {
    return ConfigDB.get('yyds_api_key') || process.env.YYDS_API_KEY || '';
  }

  async getAvailableDomains() {
    const apiKey = this.getApiKey();
    try {
      const res = await axios.get(`${YYDS_API_BASE}/domains`, {
        headers: { 'X-API-Key': apiKey }
      });
      const domains = res.data.data || res.data['hydra:member'] || [];
      const allDomains = domains.map(d => d.domain || d).filter(Boolean);
      return allDomains.filter(d => !this.blockedDomains.includes(d));
    } catch (error) {
      return this.domains.filter(d => !this.blockedDomains.includes(d));
    }
  }

  blockDomain(domain) {
    if (!this.blockedDomains.includes(domain)) {
      this.blockedDomains.push(domain);
    }
  }

  async createTempEmail() {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('未配置 YYDS Mail API Key');

    const availableDomains = await this.getAvailableDomains();
    if (availableDomains.length === 0) throw new Error('没有可用域名');

    const shuffled = [...availableDomains].sort(() => Math.random() - 0.5);

    for (let i = 0; i < Math.min(3, shuffled.length); i++) {
      const domain = shuffled[i];
      const localPart = `reg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

      try {
        const res = await axios.post(`${YYDS_API_BASE}/accounts`, {
          localPart,
          domain
        }, {
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey }
        });

        if (res.data.success === false) throw new Error(res.data.error);

        return {
          email: res.data.data.address,
          token: res.data.data.token
        };
      } catch (error) {
        this.log(`域名 ${domain} 失败: ${error.message}`);
      }
    }

    throw new Error('创建邮箱失败');
  }

  async getMessages(email) {
    const apiKey = this.getApiKey();
    try {
      const res = await axios.get(`${YYDS_API_BASE}/messages`, {
        params: { address: email },
        headers: { 'X-API-Key': apiKey }
      });
      const data = res.data;
      if (data.data?.messages) return data.data.messages;
      if (Array.isArray(data.data)) return data.data;
      if (Array.isArray(data)) return data;
      return [];
    } catch {
      return [];
    }
  }

  async getMessage(email, messageId) {
    const apiKey = this.getApiKey();
    try {
      const res = await axios.get(`${YYDS_API_BASE}/messages/${messageId}`, {
        params: { address: email },
        headers: { 'X-API-Key': apiKey }
      });
      return res.data.data || res.data;
    } catch {
      return null;
    }
  }

  async waitForCode(email, maxRetries = 40) {
    for (let i = 0; i < maxRetries; i++) {
      const messages = await this.getMessages(email);
      this.log(`轮询 ${i + 1}/${maxRetries}: ${messages.length} 封邮件`);

      const msg = messages.find(m => {
        const s = (m.subject || '').toLowerCase();
        return s.includes('code') || s.includes('verify') || s.includes('quiver') || s.includes('sign');
      });

      if (msg) {
        const full = await this.getMessage(email, msg.id);
        const text = full?.text || full?.html || full?.body || '';
        const match = text.match(/\b(\d{6})\b/);
        if (match) return match[1];
      }

      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('等待验证码超时');
  }

  async initBrowser() {
    if (this.browser) return;

    // 尝试找到 Chrome 路径
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    ];

    let chromePath = null;
    for (const p of chromePaths) {
      try {
        require('fs').accessSync(p);
        chromePath = p;
        break;
      } catch {}
    }

    if (!chromePath) {
      throw new Error('未找到 Chrome，请安装 Chrome 浏览器');
    }

    this.browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async registerOne() {
    this.log('=== 开始浏览器注册 ===');

    // 1. 创建临时邮箱
    this.log('步骤1: 创建临时邮箱...');
    const { email } = await this.createTempEmail();
    this.log(`邮箱: ${email}`);

    // 2. 启动浏览器
    this.log('步骤2: 启动浏览器...');
    await this.initBrowser();
    const page = await this.browser.newPage();

    try {
      // 3. 访问登录页面
      this.log('步骤3: 访问登录页...');
      await page.goto('https://app.quiver.ai/sign-in', { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(2000);

      // 4. 输入邮箱
      this.log('步骤4: 输入邮箱...');
      const emailInput = await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { timeout: 10000 });
      await emailInput.click();
      await page.keyboard.type(email, { delay: 50 });
      await delay(500);

      // 5. 点击发送验证码
      this.log('步骤5: 发送验证码...');
      await delay(1000);

      // 使用 evaluate 查找并点击按钮
      const clicked = await page.evaluate(() => {
        // 查找包含 "Send" 或 "send" 或 "Continue" 文本的按钮
        const buttons = Array.from(document.querySelectorAll('button'));
        const sendBtn = buttons.find(b => {
          const text = b.textContent.toLowerCase();
          return text.includes('send') || text.includes('continue') || text.includes('code');
        });

        if (sendBtn) {
          sendBtn.click();
          return sendBtn.textContent.trim();
        }

        // 尝试提交表单
        const form = document.querySelector('form');
        if (form) {
          const submitBtn = form.querySelector('button[type="submit"]');
          if (submitBtn) {
            submitBtn.click();
            return 'submit button';
          }
        }

        return null;
      });

      this.log(`点击按钮: ${clicked || '未找到'}`);
      await delay(3000);

      // 检查页面是否有错误信息
      const pageError = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        if (bodyText.includes('already') || bodyText.includes('used')) {
          return 'EMAIL_USED';
        }
        if (bodyText.includes('error') || bodyText.includes('Error')) {
          return bodyText.substring(0, 200);
        }
        return null;
      });

      if (pageError === 'EMAIL_USED') {
        this.log('邮箱已被使用，换域名重试...', 'warning');
        const domain = email.split('@')[1];
        this.blockDomain(domain);
        throw new Error('邮箱已被使用');
      } else if (pageError) {
        this.log(`页面错误: ${pageError}`, 'warning');
      }

      // 截图保存
      await page.screenshot({ path: 'debug-step5.png' });
      this.log('截图已保存: debug-step5.png');

      // 6. 等待验证码
      this.log('步骤6: 等待验证码...');
      const code = await this.waitForCode(email);
      this.log(`验证码: ${code}`);

      // 7. 等待验证码输入框出现
      this.log('步骤7: 输入验证码...');
      await delay(3000);

      // 使用 evaluate 查找验证码输入框
      const codeInputHandle = await page.evaluateHandle(() => {
        // 查找所有可见的文本输入框
        const inputs = Array.from(document.querySelectorAll('input'));
        const visibleInputs = inputs.filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

        // 优先查找带 placeholder 的
        let input = visibleInputs.find(el => {
          const p = (el.placeholder || '').toLowerCase();
          return p.includes('code') || p.includes('digit') || p.includes('verify');
        });

        if (input) return input;

        // 查找不是 email 的文本输入框
        input = visibleInputs.find(el => {
          return el.type === 'text' && el.name !== 'email' && !el.placeholder.includes('email');
        });

        return input || visibleInputs[visibleInputs.length - 1];
      });

      if (!codeInputHandle) {
        throw new Error('找不到验证码输入框');
      }

      // 逐位输入验证码
      for (const char of code) {
        await codeInputHandle.focus();
        await page.keyboard.type(char, { delay: 100 });
        await delay(100);
      }

      await delay(1000);

      // 8. 点击验证按钮
      this.log('步骤8: 提交验证...');
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const verifyBtn = buttons.find(b => {
          const text = b.textContent.toLowerCase();
          return text.includes('verify') || text.includes('submit') || text.includes('continue') || text.includes('confirm');
        });

        if (verifyBtn) {
          verifyBtn.click();
          return;
        }

        // 尝试提交表单
        const form = document.querySelector('form');
        if (form) {
          const submitBtn = form.querySelector('button[type="submit"]');
          if (submitBtn) submitBtn.click();
        }
      });

      // 9. 等待登录完成
      this.log('步骤9: 等待登录完成...');
      await delay(5000);

      // 10. 获取 cookies
      const cookies = await page.cookies();
      this.log('所有 cookies: ' + cookies.map(c => c.name).join(', '));

      // 构建完整 cookie 字符串
      const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      // 查找 session cookie
      const sessionCookie = cookies.find(c =>
        c.name === 'nuxt-session' ||
        c.name === 'session' ||
        c.name === '__session' ||
        c.name.includes('token') ||
        c.name.includes('auth')
      );

      let token = sessionCookie?.value || null;

      if (token) {
        this.log(`找到 session cookie: ${sessionCookie.name}`, 'success');
      } else {
        this.log('警告: 未找到 session token', 'warning');
      }

      // 11. 保存账号
      AccountDB.add(email);
      if (token) {
        // 保存完整 cookies
        AccountDB.updateSession(email, cookieString);
        this.log('Cookies 已保存', 'success');
      }

      // 12. 刷新页面后测试 API
      this.log('刷新页面测试 API...');
      await page.goto('https://app.quiver.ai/agent', { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(3000);

      const apiResult = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/chats');
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            return { status: res.status, data: await res.json() };
          } else {
            return { status: res.status, isHtml: true };
          }
        } catch (e) {
          return { error: e.message };
        }
      });
      this.log('API 结果: ' + JSON.stringify(apiResult));

      // 检查是否成功
      if (apiResult.status === 200 && apiResult.data) {
        this.log('登录状态有效！', 'success');

        // 尝试获取余额
        const balanceResult = await page.evaluate(async () => {
          try {
            const res = await fetch('/api/billing/balance');
            if (res.ok) return await res.json();
            return null;
          } catch { return null; }
        });

        if (balanceResult?.credits !== undefined) {
          AccountDB.updateCredits(email, balanceResult.credits);
          this.log(`余额: ${balanceResult.credits}`, 'success');
        }
      } else {
        this.log('登录状态无效，尝试重新获取 cookies...', 'warning');

        // 获取当前页面的所有 cookies
        const currentCookies = await page.cookies();
        const cookieString = currentCookies.map(c => `${c.name}=${c.value}`).join('; ');
        AccountDB.updateSession(email, cookieString);
      }

      this.log(`注册完成: ${email}`, 'success');
      return { email, token, success: true };

    } catch (error) {
      this.log(`注册失败: ${error.message}`, 'error');
      throw error;
    } finally {
      await page.close();
    }
  }

  async registerBatch(count = 1, delay = 8000) {
    const results = [];

    for (let i = 0; i < count; i++) {
      try {
        this.log(`\n=== 注册 ${i + 1}/${count} ===`);
        const result = await this.registerOne();
        results.push(result);

        if (i < count - 1) {
          this.log(`等待 ${delay/1000} 秒后继续...`);
          await new Promise(r => setTimeout(r, delay));
        }
      } catch (error) {
        results.push({ email: null, success: false, error: error.message });
      }
    }

    await this.closeBrowser();
    return results;
  }

  // 使用浏览器获取余额
  async getBalanceFromBrowser(email, cookies) {
    await this.initBrowser();
    const page = await this.browser.newPage();

    try {
      // 设置 cookies
      if (cookies) {
        const cookieList = cookies.split('; ').map(c => {
          const [name, ...valueParts] = c.split('=');
          return {
            name: name.trim(),
            value: valueParts.join('='),
            domain: 'app.quiver.ai',
            path: '/'
          };
        });
        await page.setCookie(...cookieList);
      }

      // 访问页面
      await page.goto('https://app.quiver.ai/agent', { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(3000);

      // 获取实际的 cookies
      const actualCookies = await page.cookies();
      this.log('实际 cookies: ' + actualCookies.map(c => c.name).join(', '), 'info');

      // 测试 API
      const apiResult = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/chats');
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const data = await res.json();
            return { status: res.status, data };
          }
          return { status: res.status, isHtml: true };
        } catch (e) {
          return { error: e.message };
        }
      });

      if (apiResult.status === 401 || apiResult.isHtml) {
        throw new Error('登录状态无效 (401)');
      }

      this.log('登录状态有效', 'success');

      // 尝试获取余额
      const balanceResult = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/billing/balance');
          if (res.ok) {
            return await res.json();
          }
          return null;
        } catch {
          return null;
        }
      });

      const credits = balanceResult?.credits || 0;
      if (credits > 0) {
        AccountDB.updateCredits(email, credits);
      }

      return { credits, success: true };
    } catch (error) {
      this.log('获取余额失败: ' + error.message, 'error');
      throw error;
    } finally {
      await page.close();
    }
  }
}

module.exports = new BrowserRegister();
