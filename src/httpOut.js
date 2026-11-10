// Outgoing HTTPS requests that can go through a fixed-IP relay (an HTTP CONNECT proxy such as QuotaGuard),
// for providers that only accept requests from IP addresses given to them in advance (Sunwire).
// OUTBOUND_PROXY_URL = http://user:password@proxy.example.com:9293 — leave blank to connect directly.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

/** Open a tunnel to host:port through the proxy (CONNECT). Resolves to a socket (TLS when secure). */
function tunnel(proxyUrl, host, port, secure) {
  const p = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (p.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
    const req = http.request({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: `${host}:${port}`, headers, timeout: 15000 });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`Relay refused the connection (HTTP ${res.statusCode})`)); }
      if (!secure) return resolve(socket);
      const s = tls.connect({ socket, servername: host }, () => resolve(s));
      s.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Relay timed out')));
    req.on('error', (err) => reject(new Error(`Couldn't reach the relay: ${err.message}`)));
    req.end();
  });
}

/**
 * request(url, { method, headers, body, proxy, timeoutMs }) → { status, headers, buffer, text(), json() }
 * Same result shape with or without a proxy.
 */
async function request(url, { method = 'GET', headers = {}, body = null, proxy = '', timeoutMs = 30000 } = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const socket = proxy ? await tunnel(proxy, u.hostname, port, secure) : null;
  return new Promise((resolve, reject) => {
    const opts = {
      method, host: u.hostname, port, path: u.pathname + u.search, timeout: timeoutMs,
      headers: { ...headers, ...(data ? { 'Content-Length': data.length } : {}), Host: u.host, Connection: 'close' },
      ...(socket ? { createConnection: () => socket, agent: false } : {}),
    };
    const req = (secure ? https : http).request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers, buffer,
          text: () => buffer.toString('utf8'),
          json: () => { try { return JSON.parse(buffer.toString('utf8') || '{}'); } catch { return {}; } },
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { request, tunnel };
