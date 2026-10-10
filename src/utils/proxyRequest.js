'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');

/**
 * fetch() through an HTTP proxy (CONNECT tunnel), using only Node's own modules.
 *
 * Why: the card partner only accepts calls from a fixed IP address. A hosting plan whose outbound traffic leaves
 * from a shared pool cannot give one, but a static-IP proxy service can: set MAPLERAD_PROXY_URL and every call to
 * the partner leaves from the proxy's fixed address. Only those calls take this path; nothing else changes.
 * The proxy URL carries credentials, so it is never logged or returned by an API.
 */
function parseProxy(proxyUrl) {
  const u = new URL(proxyUrl);
  if (u.protocol !== 'http:') throw new Error('MAPLERAD_PROXY_URL doit être de la forme http://utilisateur:motdepasse@hote:port');
  const auth = u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` : null;
  return { host: u.hostname, port: Number(u.port || 80), auth };
}

function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}) },
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy refused the tunnel (HTTP ${res.statusCode})`)); }
      resolve(socket);
    });
    req.on('timeout', () => { req.destroy(new Error('proxy timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function proxiedFetch(proxyUrl, url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port || (isHttps ? 443 : 80));
  const proxy = parseProxy(proxyUrl);
  const tunnel = await openTunnel(proxy, target.hostname, port, timeoutMs);
  const socket = isHttps ? tls.connect({ socket: tunnel, servername: target.hostname }) : tunnel;
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, timeoutMs);
    const req = transport.request({
      host: target.hostname, port, path: `${target.pathname}${target.search}`, method,
      headers: { ...headers, Host: target.host, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      createConnection: () => socket,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        socket.destroy();
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (name) => res.headers[String(name).toLowerCase()] || null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', (err) => { clearTimeout(timer); socket.destroy(); reject(err); });
    if (body) req.write(body);
    req.end();
  });
}

/** What may be shown about the proxy: never the credentials. */
function describe(proxyUrl) {
  if (!proxyUrl) return { configured: false };
  try { const u = new URL(proxyUrl); return { configured: true, host: u.hostname, port: Number(u.port || 80) }; } catch (e) { return { configured: true, host: null, invalid: true }; }
}

module.exports = { proxiedFetch, describe };
