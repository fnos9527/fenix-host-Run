#!/usr/bin/env node
/**
 * parse-vless.js
 * 将 vless:// 链接解析为 Xray (v25.9.11 兼容) 配置文件，输出到 stdout。
 *
 * 兼容项：
 *  - 读取 URL 中的 type 参数（默认 tcp），分别生成 wsSettings / tcpSettings / grpcSettings / httpSettings
 *  - fp / fingerprint 两种参数名都认
 *  - allowInsecure / insecure / allowinsecure 三种参数名都认，值为 "1" 或 "true" 都算跳过证书校验
 *  - sni 缺失时自动兜底为 host 参数，再兜底为服务器地址本身
 *  - uuid 做 decodeURIComponent，防止被 URL 编码
 *  - path 做 URL 解码，并自动补 "/"
 *  - 兼容 REALITY 安全层（pbk / sid / spx）
 *
 * 用法：
 *   node parse-vless.js "vless://uuid@host:port?...#remark" > xray-config.json
 * 或：
 *   VLESS_LINK="vless://..." node parse-vless.js > xray-config.json
 *
 * 环境变量：
 *   SOCKS5_PORT      本地 Socks5 监听端口，默认 1080
 *   HTTP_PROXY_PORT  本地 HTTP 代理监听端口，默认 1081
 */

const SOCKS_PORT = parseInt(process.env.SOCKS5_PORT || '1080', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PROXY_PORT || '1081', 10);

function fail(msg) {
  console.error('[parse-vless] ' + msg);
  process.exit(1);
}

function parseVless(link) {
  if (!link || !link.startsWith('vless://')) {
    fail('无效的 vless 链接（必须以 vless:// 开头）');
  }

  // 去掉协议头
  let rest = link.slice('vless://'.length);

  // 拆出 remark（# 之后的备注，不参与配置）
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx);

  // 拆出 query 部分
  const qIdx = rest.indexOf('?');
  let mainPart = rest;
  let query = '';
  if (qIdx !== -1) {
    mainPart = rest.slice(0, qIdx);
    query = rest.slice(qIdx + 1);
  }

  const atIdx = mainPart.lastIndexOf('@');
  if (atIdx === -1) fail('链接缺少 uuid@host:port 部分');

  const rawUuid = mainPart.slice(0, atIdx);
  let uuid = rawUuid;
  try { uuid = decodeURIComponent(rawUuid); } catch (e) { /* 保留原值 */ }

  const hostPort = mainPart.slice(atIdx + 1);
  const lastColon = hostPort.lastIndexOf(':');
  if (lastColon === -1) fail('链接缺少端口号');
  const address = hostPort.slice(0, lastColon);
  const port = parseInt(hostPort.slice(lastColon + 1), 10);
  if (!port) fail('端口号解析失败: ' + hostPort);

  const params = new URLSearchParams(query);
  const get = (...names) => {
    for (const n of names) {
      if (params.has(n)) return params.get(n);
    }
    return null;
  };

  const network = (get('type') || 'tcp').toLowerCase();
  const security = (get('security') || 'none').toLowerCase();
  const flow = get('flow') || undefined;

  // fp / fingerprint 两种参数名兼容，默认 chrome
  const fingerprint = get('fp', 'fingerprint') || 'chrome';

  // allowInsecure / insecure / allowinsecure 兼容，"1" 或 "true" 都算跳过证书校验
  const insecureRaw = (get('allowInsecure', 'insecure', 'allowinsecure') || '').toLowerCase();
  const allowInsecure = insecureRaw === '1' || insecureRaw === 'true';

  // host 参数（ws / http 的 Host 请求头），同时作为 sni 的第二兜底
  const hostHeader = get('host') || address;

  // sni 缺失 -> host 参数 -> 服务器地址本身
  const sni = get('sni') || hostHeader || address;

  // path URL 解码 + 自动补 "/"
  let pth = get('path') || '/';
  try { pth = decodeURIComponent(pth); } catch (e) { /* 保留原值 */ }
  if (!pth.startsWith('/')) pth = '/' + pth;

  const alpnRaw = get('alpn');
  const alpn = alpnRaw
    ? alpnRaw.split(',').map((s) => {
        try { return decodeURIComponent(s.trim()); } catch (e) { return s.trim(); }
      }).filter(Boolean)
    : undefined;

  const streamSettings = { network, security };

  if (network === 'ws') {
    streamSettings.wsSettings = {
      path: pth,
      headers: { Host: hostHeader }
    };
  } else if (network === 'tcp') {
    const headerType = get('headerType') || 'none';
    streamSettings.tcpSettings = {
      header: { type: headerType }
    };
  } else if (network === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: get('serviceName') || '',
      multiMode: (get('mode') || '') === 'multi'
    };
  } else if (network === 'http' || network === 'h2') {
    streamSettings.network = 'http';
    streamSettings.httpSettings = {
      path: pth,
      host: [hostHeader]
    };
  } else {
    fail('不支持的 type 参数: ' + network);
  }

  if (security === 'tls') {
    streamSettings.tlsSettings = {
      serverName: sni,
      allowInsecure,
      fingerprint,
      ...(alpn ? { alpn } : {})
    };
  } else if (security === 'reality') {
    streamSettings.realitySettings = {
      serverName: sni,
      fingerprint,
      publicKey: get('pbk') || '',
      shortId: get('sid') || '',
      spiderX: get('spx') || ''
    };
  } else if (security !== 'none') {
    fail('不支持的 security 参数: ' + security);
  }

  const user = { id: uuid, encryption: 'none' };
  if (flow) user.flow = flow;

  const config = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: SOCKS_PORT,
        protocol: 'socks',
        settings: { udp: true, auth: 'noauth' },
        tag: 'socks-in'
      },
      {
        listen: '127.0.0.1',
        port: HTTP_PORT,
        protocol: 'http',
        settings: {},
        tag: 'http-in'
      }
    ],
    outbounds: [
      {
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address,
              port,
              users: [user]
            }
          ]
        },
        streamSettings,
        tag: 'proxy'
      },
      { protocol: 'freedom', tag: 'direct' }
    ]
  };

  return config;
}

const link = process.argv[2] || process.env.VLESS_LINK;
const config = parseVless(link);
process.stdout.write(JSON.stringify(config, null, 2) + '\n');
