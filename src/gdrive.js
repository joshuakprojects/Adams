/**
 * Google Drive as another place for the nightly backup (Setup → Backups → Connect Google Drive).
 *
 * An admin connects a Google account once (like QuickBooks). The app can only see the files it puts there
 * (Google's "drive.file" access), all in one folder, "Adams Bros Dispatch backups". Nightly copies and ticket photos
 * go there; nightly copies older than 30 days are removed, as in the other places.
 *
 * Needs a Google Cloud OAuth client (Web application) with the redirect URI <PUBLIC_URL>/gdrive/callback, set in
 * the Secrets as GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET.
 */
const crypto = require('node:crypto');
const config = require('./config');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const FOLDER = 'Adams Bros Dispatch backups';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

class DriveError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function createDrive(db, {
  clientId = process.env.GOOGLE_DRIVE_CLIENT_ID || '', clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
  redirectUri = `${config.publicUrl}/gdrive/callback`, fetchImpl = (...a) => fetch(...a), now = () => Date.now(),
} = {}) {
  const getSetting = async (key) => (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value ?? null;
  const setSetting = (key, value) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  const delSetting = (key) => db.run('DELETE FROM settings WHERE key = ?', key);
  const getJson = async (key) => { try { return JSON.parse(await getSetting(key)) || null; } catch { return null; } };
  const configured = Boolean(clientId && clientSecret);

  // ---------- connecting ----------
  async function authUrl() {
    if (!configured) throw new DriveError('Google Drive is not set up yet: add GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET to the Secrets.');
    const state = crypto.randomBytes(16).toString('hex');
    await setSetting('gdrive_state', JSON.stringify({ state, at: now() }));
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return `${AUTH_URL}?${q}`;
  }
  async function tokenRequest(params) {
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }).toString() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === 'invalid_grant') throw new DriveError('Google Drive was disconnected (the sign-in was withdrawn or expired). Connect it again in Setup → Backups.', 401);
      throw new DriveError(`Google sign-in failed: ${body.error_description || body.error || res.status}`, 502);
    }
    return body;
  }
  async function finishConnect({ code, state }) {
    const saved = await getJson('gdrive_state');
    if (!saved || saved.state !== state || now() - saved.at > 15 * 60e3) throw new DriveError('That Google sign-in expired. Press Connect Google Drive again.');
    await delSetting('gdrive_state');
    const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (!t.refresh_token) throw new DriveError('Google did not allow offline access. Press Connect Google Drive again and allow it.');
    let email = '';
    try { email = JSON.parse(Buffer.from(String(t.id_token || '').split('.')[1] || '', 'base64url').toString()).email || ''; } catch { /* no email shown */ }
    await setSetting('gdrive_tokens', JSON.stringify({ refresh_token: t.refresh_token, access_token: t.access_token, expires_at: now() + (t.expires_in || 3600) * 1000, email }));
    await delSetting('gdrive_folder');
    await folderId(); // makes the folder now, so a problem shows straight away
    return status();
  }
  async function disconnect() {
    const t = await getJson('gdrive_tokens');
    if (t?.refresh_token) await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST' }).catch(() => {});
    await delSetting('gdrive_tokens');
    await delSetting('gdrive_folder');
    return status();
  }
  async function active() { return configured && Boolean((await getJson('gdrive_tokens'))?.refresh_token); }
  async function status() {
    const t = await getJson('gdrive_tokens');
    return { configured, connected: Boolean(t?.refresh_token), email: t?.email || '', folder: FOLDER, redirect_uri: redirectUri };
  }

  // ---------- calling Drive ----------
  async function accessToken() {
    const t = await getJson('gdrive_tokens');
    if (!t?.refresh_token) throw new DriveError('Google Drive is not connected');
    if (t.access_token && t.expires_at - now() > 60e3) return t.access_token;
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    const next = { ...t, access_token: fresh.access_token, expires_at: now() + (fresh.expires_in || 3600) * 1000 };
    await setSetting('gdrive_tokens', JSON.stringify(next));
    return next.access_token;
  }
  async function call(method, url, { body, headers = {}, raw = false, retried = false } = {}) {
    const res = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${await accessToken()}`, ...headers }, body });
    if (res.status === 401 && !retried) {
      const t = await getJson('gdrive_tokens');
      await setSetting('gdrive_tokens', JSON.stringify({ ...t, access_token: '', expires_at: 0 }));
      return call(method, url, { body, headers, raw, retried: true });
    }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      const msg = e.error?.message || `HTTP ${res.status}`;
      if (/quota/i.test(msg)) throw new DriveError(`Google Drive is full: ${msg}`, 507);
      throw new DriveError(`Google Drive: ${msg}`, 502);
    }
    if (raw) return res;
    return res.status === 204 ? null : res.json().catch(() => null);
  }
  const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function folderId() {
    const saved = await getSetting('gdrive_folder');
    if (saved) return saved;
    const found = await call('GET', `${API}/files?q=${encodeURIComponent(`name = '${q(FOLDER)}' and mimeType = '${FOLDER_MIME}' and trashed = false`)}&fields=files(id)&spaces=drive`);
    let id = found?.files?.[0]?.id;
    if (!id) id = (await call('POST', `${API}/files?fields=id`, { body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_MIME }), headers: { 'Content-Type': 'application/json' } })).id;
    await setSetting('gdrive_folder', id);
    return id;
  }
  async function find(name) {
    const parent = await folderId();
    const r = await call('GET', `${API}/files?q=${encodeURIComponent(`name = '${q(name)}' and '${parent}' in parents and trashed = false`)}&fields=files(id,name)&spaces=drive`);
    return r?.files?.[0]?.id || null;
  }

  // The same small interface as the other backup places: put, get, exists, list, remove.
  const target = {
    kind: 'gdrive',
    label: 'Google Drive',
    nightlyOnly: true, // hourly copies stay in the app's own storage; Drive gets the nightly copy and photos
    active,
    async put(name, buf) {
      const parent = await folderId();
      const existing = await find(name);
      const boundary = 'b' + crypto.randomBytes(8).toString('hex');
      const meta = existing ? {} : { name, parents: [parent] };
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        buf, Buffer.from(`\r\n--${boundary}--`)]);
      const headers = { 'Content-Type': `multipart/related; boundary=${boundary}` };
      if (existing) await call('PATCH', `${UPLOAD}/files/${existing}?uploadType=multipart&fields=id`, { body, headers });
      else await call('POST', `${UPLOAD}/files?uploadType=multipart&fields=id`, { body, headers });
    },
    async get(name) {
      const id = await find(name);
      if (!id) throw new DriveError(`${name} is not in Google Drive`, 404);
      return Buffer.from(await (await call('GET', `${API}/files/${id}?alt=media`, { raw: true })).arrayBuffer());
    },
    async exists(name) { return Boolean(await find(name)); },
    async list(prefix) {
      const parent = await folderId();
      const out = [];
      let token = '';
      do {
        const r = await call('GET', `${API}/files?q=${encodeURIComponent(`'${parent}' in parents and trashed = false and name contains '${q(prefix)}'`)}`
          + `&fields=nextPageToken,files(name)&pageSize=1000&spaces=drive${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
        for (const f of r?.files || []) if (f.name.startsWith(prefix)) out.push(f.name);
        token = r?.nextPageToken || '';
      } while (token);
      return out;
    },
    async remove(name) {
      const id = await find(name);
      if (id) await call('DELETE', `${API}/files/${id}`);
    },
  };

  return { target, authUrl, finishConnect, disconnect, status, active, configured };
}

module.exports = { createDrive, DriveError, FOLDER };
