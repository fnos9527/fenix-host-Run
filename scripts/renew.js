#!/usr/bin/env node
/**
 * renew.js
 *
 * 流程：
 *   1. 通过本地 Xray Socks5 代理 (127.0.0.1:1080) 访问 fenixhost.net
 *   2. 用 puppeteer-real-browser 打开登录页，填写邮箱/密码
 *   3. 处理 Cloudflare Turnstile 人机验证
 *   4. 登录成功后进入服务详情页，读取"续期前"剩余时间
 *   5. 点击 Renovar 按钮续期，刷新页面读取"续期后"剩余时间
 *   6. 对比前后剩余时间，判断续期是否成功
 *   7. 通过 Telegram Bot 发送续期前/续期后时间与成功与否的通知
 *
 * 环境变量：
 *   FENIX_EMAIL / FENIX_PASSWORD   FenixHost 登录账号密码
 *   TG_BOT_TOKEN / TG_CHAT_ID      Telegram 通知
 *   SERVICE_URL                    服务详情页地址，默认 https://fenixhost.net/services/535
 *   SOCKS5_PROXY                   本地代理地址，默认 socks5://127.0.0.1:1080
 *   MIN_INTERVAL_DAYS              两次续期最小间隔天数，默认 5
 *   FORCE_RUN                      "true" 时忽略间隔限制，强制执行
 */

const fs = require('fs');
const path = require('path');
const { connect } = require('puppeteer-real-browser');

const LOGIN_URL = 'https://fenixhost.net/login';
const SERVICE_URL = process.env.SERVICE_URL || 'https://fenixhost.net/services/535';
const EMAIL = process.env.FENIX_EMAIL;
const PASSWORD = process.env.FENIX_PASSWORD;
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SOCKS5_PROXY = process.env.DISABLE_PROXY === 'true' ? null : (process.env.SOCKS5_PROXY || 'socks5://127.0.0.1:1080');

const STATE_FILE = path.join(__dirname, '..', 'data', 'last-renew.json');
const MIN_INTERVAL_DAYS = parseFloat(process.env.MIN_INTERVAL_DAYS || '5');
const FORCE_RUN = process.env.FORCE_RUN === 'true';

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { lastRenewAt: null, history: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn('[telegram] 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过通知，内容如下：');
    console.log(text);
    return;
  }
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    if (!res.ok) {
      console.error('[telegram] 发送失败:', res.status, await res.text());
    }
  } catch (e) {
    console.error('[telegram] 发送异常:', e.message);
  }
}

// 从页面文字中解析形如 "6d 23h 3m 1s" 的倒计时，返回 { seconds, raw }
async function readCountdown(page) {
  const result = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const m = text.match(/(\d+)\s*d\s+(\d+)\s*h\s+(\d+)\s*m\s+(\d+)\s*s/i);
    if (!m) return null;
    return { raw: m[0], d: +m[1], h: +m[2], mi: +m[3], s: +m[4] };
  });
  if (!result) return null;
  const seconds = result.d * 86400 + result.h * 3600 + result.mi * 60 + result.s;
  return { seconds, raw: result.raw };
}

// 按可见文字查找 button / a 并点击（比死绑 class 更稳定）
async function clickByText(page, text) {
  const handle = await page.evaluateHandle((txt) => {
    const nodes = Array.from(document.querySelectorAll('button, a'));
    return nodes.find((el) => (el.innerText || '').trim().toLowerCase().includes(txt.toLowerCase())) || null;
  }, text);
  const el = handle.asElement();
  if (!el) throw new Error(`未找到文字包含 "${text}" 的按钮/链接`);
  await el.click();
  return true;
}

// 尝试处理 Cloudflare Turnstile：puppeteer-real-browser 的 turnstile:true
// 会自动处理大多数情况，这里再做一次兜底点击。
// 等待 Cloudflare Turnstile 验证通过。
// 不做任何手动点击——puppeteer-real-browser 的 turnstile:true 已经会用
// 拟人化的鼠标行为去处理它；我们只需要轮询 Turnstile 生成的隐藏 token
// (input[name="cf-turnstile-response"]) 是否已经有值来判断是否验证成功。
// 之前版本会在 iframe 内部强制点击一个 checkbox，这很可能是导致 Cloudflare
// 反复 reset() 验证、一直卡在 "Verifying..." 的原因，现已移除。
async function waitForTurnstile(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const token = await page
      .evaluate(() => {
        const el = document.querySelector('input[name="cf-turnstile-response"]');
        return el ? el.value : null;
      })
      .catch(() => null);
    if (token) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('缺少 FENIX_EMAIL / FENIX_PASSWORD 环境变量');
  }

  const state = readState();
  if (!FORCE_RUN && state.lastRenewAt) {
    const elapsedDays = (Date.now() - new Date(state.lastRenewAt).getTime()) / 86400000;
    if (elapsedDays < MIN_INTERVAL_DAYS) {
      console.log(
        `距离上次成功续期仅 ${elapsedDays.toFixed(2)} 天，未达到 ${MIN_INTERVAL_DAYS} 天间隔，本次跳过。`
      );
      return;
    }
  }

  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    args: SOCKS5_PROXY ? [`--proxy-server=${SOCKS5_PROXY}`] : [],
    customConfig: {},
    connectOption: { defaultViewport: { width: 1366, height: 900 } },
    disableXvfb: false
  });

  let beforeSeconds = null;
  let afterSeconds = null;
  let beforeRaw = '-';
  let afterRaw = '-';
  let success = false;
  let errorMsg = null;

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
    await page.type('input[type="email"], input[name="email"]', EMAIL, { delay: 30 });
    await page.type('input[type="password"], input[name="password"]', PASSWORD, { delay: 30 });

    const turnstilePassed = await waitForTurnstile(page, 90000);
    if (!turnstilePassed) {
      throw new Error(
        'Cloudflare Turnstile 验证一直卡在 Verifying 状态、90 秒内未通过。' +
          '大概率是当前 VLESS 节点的出口 IP 被 Cloudflare 判定为高风险(数据中心/已知代理段)，' +
          '建议换一个住宅/家宽属性更好的节点再试，或临时不走代理测试对比。'
      );
    }

    await clickByText(page, 'Sign in');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});

    // 登录后如果仍停留在 /login，说明账号密码或验证没有真正通过
    if (/\/login/i.test(page.url())) {
      throw new Error('提交登录后仍停留在登录页，账号密码或验证码校验可能未通过');
    }

    await page.goto(SERVICE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    const before = await readCountdown(page);
    if (!before) throw new Error('未能读取续期前的剩余时间，页面结构可能已变化');
    beforeSeconds = before.seconds;
    beforeRaw = before.raw;

    await clickByText(page, 'Renovar');
    await new Promise((r) => setTimeout(r, 3000));

    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    const after = await readCountdown(page);
    if (!after) throw new Error('未能读取续期后的剩余时间，页面结构可能已变化');
    afterSeconds = after.seconds;
    afterRaw = after.raw;

    success = afterSeconds > beforeSeconds;
  } catch (e) {
    errorMsg = e.message;
    console.error('[renew] 出错:', e.stack || e.message);
    // 失败时保存截图 + 当前页面 HTML，方便排查具体卡在哪一步
    try {
      const curUrl = page.url();
      console.error('[renew] 出错时页面 URL:', curUrl);
      await page.screenshot({ path: path.join(__dirname, '..', 'debug-failure.png'), fullPage: true });
      fs.writeFileSync(path.join(__dirname, '..', 'debug-failure.html'), await page.content());
      console.error('[renew] 已保存 debug-failure.png / debug-failure.html');
    } catch (e2) {
      console.error('[renew] 保存调试信息也失败了:', e2.message);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const now = new Date().toISOString();
  const summaryLines = [
    '<b>FenixHost 自动续期</b>',
    `时间: ${now}`,
    `续期前剩余: ${beforeRaw}`,
    `续期后剩余: ${afterRaw}`,
    `结果: ${success ? '✅ 成功' : '❌ 失败'}`
  ];
  if (errorMsg) summaryLines.push(`错误信息: ${errorMsg}`);

  await sendTelegram(summaryLines.join('\n'));

  state.lastRenewAt = success ? now : state.lastRenewAt;
  state.history = state.history || [];
  state.history.unshift({
    time: now,
    beforeSeconds,
    afterSeconds,
    beforeRaw,
    afterRaw,
    success,
    error: errorMsg
  });
  state.history = state.history.slice(0, 30);
  writeState(state);

  if (!success) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await sendTelegram(`<b>FenixHost 自动续期脚本异常</b>\n${e.message}`);
  process.exitCode = 1;
});
