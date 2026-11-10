// "Your own server" as a second place for backups, set with Secrets (nothing to install on Replit):
//   BACKUP_SERVER_URL=https://nas.example.ca:5006/adams-backups     → WebDAV (Synology / QNAP NAS, Windows IIS, Nextcloud…)
//   BACKUP_SERVER_URL=s3://bucket-name/optional/folder              → S3-compatible storage (NAS S3, MinIO, Backblaze B2, AWS)
//     with BACKUP_SERVER_ENDPOINT=https://s3.example.ca (and BACKUP_SERVER_REGION, default us-east-1)
//   BACKUP_SERVER_USER / BACKUP_SERVER_PASSWORD  (WebDAV login, or the S3 access key id / secret key)
// Each target has the same small interface as the other backup stores: put, get, exists, list, remove.
const crypto = require('node:crypto');

function webdavStorage({ url, user, password, fetchImpl = (...a) => fetch(...a) }) {
  const base = url.replace(/\/+$/, '');
  const auth = user ? { Authorization: 'Basic ' + Buffer.from(`${user}:${password || ''}`).toString('base64') } : {};
  const enc = (name) => name.split('/').map(encodeURIComponent).join('/');
  const req = async (method, name, { body, headers = {}, okStatus = [] } = {}) => {
    const res = await fetchImpl(`${base}/${enc(name)}`, { method, headers: { ...auth, ...headers }, body });
    if (!res.ok && !okStatus.includes(res.status)) {
      throw new Error(`Server ${method} ${name}: HTTP ${res.status}${res.status === 401 ? ' (check BACKUP_SERVER_USER / PASSWORD)' : ''}`);
    }
    return res;
  };
  const made = new Set();
  async function ensureDir(name) {
    const parts = name.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/') + '/';
      if (made.has(dir)) continue;
      await req('MKCOL', dir, { okStatus: [405, 301] }); // 405 = already there
      made.add(dir);
    }
  }
  return {
    kind: 'server',
    label: `your server (${new URL(base).host})`,
    async put(name, buf) { await ensureDir(name); await req('PUT', name, { body: buf, headers: { 'Content-Type': 'application/octet-stream' } }); },
    async get(name) { return Buffer.from(await (await req('GET', name)).arrayBuffer()); },
    async exists(name) { return (await req('HEAD', name, { okStatus: [404] })).status !== 404; },
    async list(prefix) {
      const res = await req('PROPFIND', prefix, { headers: { Depth: '1' }, okStatus: [404] });
      if (res.status === 404) return [];
      const xml = await res.text();
      const root = new URL(base).pathname.replace(/\/+$/, '');
      return [...xml.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/gi)]
        .map((m) => decodeURIComponent(new URL(m[1], base + '/').pathname))
        .map((p) => p.startsWith(root + '/') ? p.slice(root.length + 1) : p)
        .filter((n) => n.startsWith(prefix) && n !== prefix && !n.endsWith('/'));
    },
    async remove(name) { await req('DELETE', name, { okStatus: [404] }); },
  };
}

/** S3-compatible storage with AWS Signature V4 (path-style URLs, which NAS S3 servers and MinIO use). */
function s3Storage({ url, endpoint, region = 'us-east-1', accessKey, secretKey, fetchImpl = (...a) => fetch(...a), now = () => new Date() }) {
  const u = new URL(url);
  const bucket = u.host;
  const folder = u.pathname.replace(/^\/+|\/+$/g, '');
  const ep = new URL(endpoint || `https://s3.${region}.amazonaws.com`);
  const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const encKey = (k) => k.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
  const full = (name) => (folder ? `${folder}/${name}` : name);

  async function req(method, key, { body = Buffer.alloc(0), query = {}, okStatus = [] } = {}) {
    const t = now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = t.slice(0, 8);
    const path = `/${bucket}${key ? '/' + encKey(key) : ''}`;
    const qs = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
    const payloadHash = sha(body);
    const headers = { host: ep.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': t };
    const signed = Object.keys(headers).sort();
    const canonical = [method, path, qs, ...signed.map((h) => `${h}:${headers[h]}`), '', signed.join(';'), payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', t, scope, sha(canonical)].join('\n');
    const kSign = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), 's3'), 'aws4_request');
    const sig = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
    const authz = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;
    const res = await fetchImpl(`${ep.origin}${path}${qs ? '?' + qs : ''}`, {
      method, headers: { ...headers, Authorization: authz }, body: method === 'PUT' ? body : undefined,
    });
    if (!res.ok && !okStatus.includes(res.status)) {
      const text = await res.text().catch(() => '');
      throw new Error(`Server ${method} ${key || bucket}: HTTP ${res.status} ${(/<Code>([^<]+)/.exec(text) || [])[1] || ''}`.trim());
    }
    return res;
  }
  return {
    kind: 'server',
    label: `your server (${ep.host}, bucket ${bucket})`,
    async put(name, buf) { await req('PUT', full(name), { body: buf }); },
    async get(name) { return Buffer.from(await (await req('GET', full(name))).arrayBuffer()); },
    async exists(name) { return (await req('HEAD', full(name), { okStatus: [404] })).status !== 404; },
    async list(prefix) {
      const out = [];
      let token;
      do {
        const query = { 'list-type': '2', prefix: full(prefix), ...(token ? { 'continuation-token': token } : {}) };
        const xml = await (await req('GET', '', { query })).text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) out.push(folder ? m[1].slice(folder.length + 1) : m[1]);
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)/.exec(xml) || [])[1] : null;
      } while (token);
      return out;
    },
    async remove(name) { await req('DELETE', full(name), { okStatus: [404] }); },
  };
}

/** The server target from the Secrets, or null when none is set. */
function serverTarget(env = process.env, opts = {}) {
  const url = String(env.BACKUP_SERVER_URL || '').trim();
  if (!url) return null;
  if (url.startsWith('s3://')) {
    return s3Storage({ url, endpoint: env.BACKUP_SERVER_ENDPOINT, region: env.BACKUP_SERVER_REGION || 'us-east-1',
      accessKey: env.BACKUP_SERVER_USER, secretKey: env.BACKUP_SERVER_PASSWORD, ...opts });
  }
  if (!/^https?:\/\//.test(url)) throw new Error('BACKUP_SERVER_URL must start with https:// (WebDAV) or s3://');
  return webdavStorage({ url, user: env.BACKUP_SERVER_USER, password: env.BACKUP_SERVER_PASSWORD, ...opts });
}

module.exports = { webdavStorage, s3Storage, serverTarget };
