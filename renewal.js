const puppeteer = require('puppeteer-real-browser');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class VLESSRenewal {
  constructor() {
    this.vlessLink = process.env.VLESS_LINK;
    this.email = process.env.FENIX_EMAIL;
    this.password = process.env.FENIX_PASSWORD;
    this.tgBotToken = process.env.TG_BOT_TOKEN;
    this.tgChatId = process.env.TG_CHAT_ID;
    this.browser = null;
    this.timeBeforeRenewal = null;
    this.timeAfterRenewal = null;
  }

  // 展开路径中的 ~，Node 的 spawn 不会像 shell 那样自动处理
  resolveHomePath(p) {
    if (!p) return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) {
      return path.join(os.homedir(), p.slice(2));
    }
    return p;
  }

  // 解析 VLESS 链接
  parseVLESS(link) {
    const urlMatch = link.match(/vless:\/\/([^@]+)@([^:?#]+):(\d+)([^?]*)\??(.*)/) || [];
    
    if (!urlMatch[0]) {
      throw new Error('Invalid VLESS link format');
    }

    const uuid = decodeURIComponent(urlMatch[1].split(':')[0]);
    const host = urlMatch[2];
    const port = parseInt(urlMatch[3]);
    const path = (urlMatch[4] || '/').startsWith('/') ? urlMatch[4] : '/' + (urlMatch[4] || '');
    const params = new URLSearchParams(urlMatch[5] || '');

    // 解析参数
    const config = {
      uuid,
      host,
      port,
      path: decodeURIComponent(path) || '/',
      type: params.get('type') || 'tcp',
      sni: params.get('sni') || params.get('serverName') || host,
      alpn: params.get('alpn') || 'h2,http/1.1',
      fp: params.get('fp') || 'chrome',
      reality: params.get('reality'),
      shortId: params.get('shortId') || '',
      publicKey: params.get('publicKey') || '',
      flow: params.get('flow') || '',
      skipCertVerify: this.parseSkipVerify(params),
      tls: (params.get('security') || 'tls') === 'reality' ? false : true,
    };

    return config;
  }

  parseSkipVerify(params) {
    const insecure = params.get('insecure');
    const allowInsecure = params.get('allowInsecure');
    return (insecure === '1' || insecure === 'true' || 
            allowInsecure === '1' || allowInsecure === 'true');
  }

  // 生成 Xray 配置
  generateXrayConfig(vlConfig) {
    const inbound = {
      port: 10808,
      protocol: 'socks',
      settings: {
        auth: 'noauth',
        udp: true,
      },
    };

    // 构建 outbound settings
    let tlsSettings = {};
    if (vlConfig.tls) {
      tlsSettings = {
        serverName: vlConfig.sni,
        allowInsecure: vlConfig.skipCertVerify,
        fingerprint: vlConfig.fp,
      };
    }

    let streamSettings = {
      network: vlConfig.type,
      security: vlConfig.tls ? 'tls' : 'reality',
    };

    if (vlConfig.tls) {
      streamSettings.tlsSettings = tlsSettings;
    } else if (vlConfig.reality) {
      streamSettings.realitySettings = {
        show: false,
        fingerprint: vlConfig.fp,
        serverName: vlConfig.sni,
        publicKey: vlConfig.publicKey,
        shortId: vlConfig.shortId,
        spiderX: '/',
      };
    }

    // 根据 type 添加对应的 settings
    switch (vlConfig.type) {
      case 'ws':
        streamSettings.wsSettings = {
          path: vlConfig.path,
          headers: {
            Host: vlConfig.host,
          },
        };
        break;
      case 'grpc':
        streamSettings.grpcSettings = {
          serviceName: vlConfig.path.replace(/^\//, ''),
        };
        break;
      case 'http':
        streamSettings.httpSettings = {
          path: [vlConfig.path],
          host: [vlConfig.host],
        };
        break;
      case 'tcp':
      default:
        if (vlConfig.path !== '/') {
          streamSettings.tcpSettings = {
            header: {
              type: 'http',
              request: {
                version: '1.1',
                method: 'GET',
                path: [vlConfig.path],
                headers: {
                  Host: [vlConfig.host],
                  'User-Agent': ['Mozilla/5.0'],
                },
              },
            },
          };
        }
    }

    const outbound = {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: vlConfig.host,
            port: vlConfig.port,
            users: [
              {
                id: vlConfig.uuid,
                flow: vlConfig.flow || '',
                encryption: 'none',
              },
            ],
          },
        ],
      },
      streamSettings,
      mux: {
        enabled: true,
      },
    };

    return {
      log: {
        loglevel: 'warning',
      },
      inbounds: [inbound],
      outbounds: [outbound],
      routing: {
        rules: [
          {
            type: 'field',
            ip: ['geoip:private'],
            outbound: 'direct',
          },
        ],
      },
    };
  }

  // 启动 Xray 代理
  async startXrayProxy(vlConfig) {
    const configPath = '/tmp/xray-config.json';
    const config = this.generateXrayConfig(vlConfig);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    try {
      await execAsync(`pkill -f xray`).catch(() => {});
      await sleep(1000);
    } catch (e) {
      // ignore
    }

    // 展开 ~ 路径，避免 spawn ENOENT（spawn 不做 shell 展开）
    let xrayBin = this.resolveHomePath(process.env.XRAY_PATH) || './xray';
    xrayBin = path.resolve(xrayBin);

    if (!fs.existsSync(xrayBin)) {
      throw new Error(`未找到 xray 可执行文件: ${xrayBin}`);
    }

    const { spawn } = require('child_process');
    this.xrayProcess = spawn(xrayBin, ['run', '-c', configPath], {
      stdio: 'pipe',
      detached: true,
    });

    this.xrayProcess.stdout.on('data', (d) => console.log(`[xray] ${d.toString().trim()}`));
    this.xrayProcess.stderr.on('data', (d) => console.warn(`[xray] ${d.toString().trim()}`));
    this.xrayProcess.on('error', (err) => {
      console.error('Xray 进程启动失败:', err.message);
    });

    await sleep(2000);
  }

  // Puppeteer 登录
  async login(browser, page) {
    try {
      await page.goto('https://fenixhost.net/login', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // 等待邮箱输入框
      await page.waitForSelector('input[name="email"]', { timeout: 5000 });

      // 输入邮箱
      await page.type('input[name="email"]', this.email);
      await sleep(500);

      // 输入密码
      await page.type('input[name="password"]', this.password);
      await sleep(500);

      // 等待并点击 Cloudflare 验证
      console.log('等待 Cloudflare 验证...');
      await this.solveCloudflare(page);

      // 点击登录按钮
      await page.click('button[type="submit"]');

      // 等待登录完成
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      console.log('登录成功');
    } catch (error) {
      throw new Error(`登录失败: ${error.message}`);
    }
  }

  // 解决 Cloudflare 验证
  async solveCloudflare(page) {
    try {
      // 等待 iframe
      await page.waitForFunction(() => {
        const iframes = document.querySelectorAll('iframe');
        for (let iframe of iframes) {
          if (iframe.src.includes('challenges.cloudflare.com')) {
            return true;
          }
        }
        return false;
      }, { timeout: 10000 });

      const iframeElement = await page.$('iframe[src*="challenges.cloudflare.com"]');
      const frame = await iframeElement.contentFrame();

      // 等待并点击验证复选框
      const checkbox = await frame.waitForSelector('input[type="checkbox"]', { timeout: 5000 });
      await checkbox.click();

      // 等待验证完成
      await page.waitForFunction(() => {
        const iframes = document.querySelectorAll('iframe');
        for (let iframe of iframes) {
          if (iframe.src.includes('challenges.cloudflare.com')) {
            return false;
          }
        }
        return true;
      }, { timeout: 30000 });

      console.log('Cloudflare 验证通过');
    } catch (error) {
      console.warn(`Cloudflare 验证出现问题: ${error.message}，尝试继续...`);
      await sleep(3000);
    }
  }

  // 获取剩余时间
  async getExpiryTime(page) {
    try {
      await page.goto('https://fenixhost.net/services/535', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // 等待时间显示元素
      await page.waitForSelector('[class*="expir"], [class*="time"], span', { timeout: 5000 });

      // 提取时间信息
      const timeText = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*')).filter(
          el => el.textContent.match(/\d+[dhms]/)
        );
        return elements[0]?.textContent || '';
      });

      return timeText.trim();
    } catch (error) {
      console.warn(`获取时间失败: ${error.message}`);
      return null;
    }
  }

  // 点击续期按钮
  async clickRenewButton(page) {
    try {
      await page.waitForSelector('button:contains("Renewer"), button[class*="renew"]', { timeout: 5000 });
      
      // 查找续期按钮
      const renewButton = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => btn.textContent.includes('Renewer') || btn.textContent.includes('续'))?.innerHTML || null;
      });

      if (renewButton) {
        await page.click('button:has-text("Renewer")');
        await sleep(2000);
        console.log('已点击续期按钮');
      } else {
        throw new Error('未找到续期按钮');
      }
    } catch (error) {
      console.warn(`点击续期按钮失败: ${error.message}`);
    }
  }

  // 发送 TG 通知
  async sendTelegramNotification(success, beforeTime, afterTime) {
    if (!this.tgBotToken || !this.tgChatId) {
      console.log('未配置 TG 通知');
      return;
    }

    const status = success ? '✅ 成功' : '❌ 失败';
    const message = `
VLESS 续期 ${status}

续期前: ${beforeTime || '未知'}
续期后: ${afterTime || '未知'}
时间: ${new Date().toLocaleString('zh-CN')}
    `.trim();

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.tgBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.tgChatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      if (response.ok) {
        console.log('TG 通知已发送');
      }
    } catch (error) {
      console.warn(`发送 TG 通知失败: ${error.message}`);
    }
  }

  // 主程序
  async run() {
    let browser = null;
    try {
      // 解析 VLESS 链接
      const vlConfig = this.parseVLESS(this.vlessLink);
      console.log('VLESS 配置解析成功:', {
        host: vlConfig.host,
        port: vlConfig.port,
        type: vlConfig.type,
        sni: vlConfig.sni,
      });

      // 启动 Xray 代理
      await this.startXrayProxy(vlConfig);
      console.log('Xray 代理已启动');

      // 启动浏览器
      const { browser: b } = await puppeteer.connect({
        headless: 'new',
        args: [
          '--proxy-server=socks5://127.0.0.1:10808',
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      });
      browser = b;

      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      );

      // 登录
      await this.login(browser, page);

      // 获取续期前的时间
      this.timeBeforeRenewal = await this.getExpiryTime(page);
      console.log('续期前时间:', this.timeBeforeRenewal);

      // 点击续期按钮
      await this.clickRenewButton(page);

      // 刷新页面
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });

      // 获取续期后的时间
      await sleep(2000);
      this.timeAfterRenewal = await this.getExpiryTime(page);
      console.log('续期后时间:', this.timeAfterRenewal);

      // 判断是否成功
      const success = this.timeBeforeRenewal !== this.timeAfterRenewal;

      // 发送通知
      await this.sendTelegramNotification(success, this.timeBeforeRenewal, this.timeAfterRenewal);

      await browser.close();
      if (this.xrayProcess) {
        this.xrayProcess.kill();
      }

      process.exit(success ? 0 : 1);
    } catch (error) {
      console.error('续期过程出错:', error);
      await this.sendTelegramNotification(false, this.timeBeforeRenewal, null);

      if (browser) {
        await browser.close();
      }
      if (this.xrayProcess) {
        this.xrayProcess.kill();
      }

      process.exit(1);
    }
  }
}

// 运行
const renewal = new VLESSRenewal();
renewal.run();
