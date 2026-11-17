const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDrive } = require('../src/gdrive');
const { createBackups, localStorageAt, gunzipJson } = require('../src/backup');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** A small stand-in for Google's sign-in and Drive APIs. */
function fakeGoogle() {
  const s = { files: {}, next: 1, tokens: 0, revoked: 0 };
  const ok = (body, status = 200) => ({ ok: true, status, json: async () => body, arrayBuffer: async () => body });
  const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'office@adamsbros.ca' })).toString('base64url') + '.y';
  const fetchImpl = async (url, opts = {}) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      s.tokens++;
      const p = new URLSearchParams(opts.body);
      if (p.get('grant_type') === 'authorization_code') return ok({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, id_token: idToken });
      return ok({ access_token: `at${s.tokens}`, expires_in: 3600 });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) { s.revoked++; return ok({}); }
    assert.match(opts.headers.Authorization, /^Bearer at\d+$/);
    const u = new URL(url);
    const q = u.searchParams.get('q') || '';
    if (u.pathname === '/drive/v3/files' && opts.method === 'GET') {
      let files = Object.values(s.files);
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const contains = /name contains '([^']+)'/.exec(q)?.[1];
      if (/mimeType = 'application\/vnd.google-apps.folder'/.test(q)) files = files.filter((f) => f.folder);
      if (name) files = files.filter((f) => f.name === name);
      if (parent) files = files.filter((f) => f.parent === parent);
      if (contains) files = files.filter((f) => f.name.includes(contains));
      return ok({ files: files.map((f) => ({ id: f.id, name: f.name })) });
    }
    if (u.pathname === '/drive/v3/files' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      const id = 'f' + s.next++;
      s.files[id] = { id, name: body.name, folder: true };
      return ok({ id });
    }
    const upload = /^\/upload\/drive\/v3\/files(?:\/(\w+))?$/.exec(u.pathname);
    if (upload) {
      const raw = Buffer.from(opts.body);
      const boundary = /boundary=(\w+)/.exec(opts.headers['Content-Type'])[1];
      const parts = raw.toString('latin1').split(`--${boundary}`);
      const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
      const start = raw.indexOf(Buffer.from('application/octet-stream\r\n\r\n')) + 'application/octet-stream\r\n\r\n'.length;
      const data = raw.subarray(start, raw.lastIndexOf(Buffer.from(`\r\n--${boundary}--`)));
      const id = upload[1] || 'f' + s.next++;
      s.files[id] = { ...(s.files[id] || {}), id, ...meta, parent: meta.parents?.[0] || s.files[id]?.parent, data: Buffer.from(data) };
      return ok({ id });
    }
    const one = /^\/drive\/v3\/files\/(\w+)$/.exec(u.pathname);
    if (one && opts.method === 'DELETE') { delete s.files[one[1]]; return { ok: true, status: 204, json: async () => null }; }
    if (one && u.searchParams.get('alt') === 'media') return { ok: true, status: 200, arrayBuffer: async () => s.files[one[1]].data };
    throw new Error('unexpected ' + opts.method + ' ' + url);
  };
  return { s, fetchImpl };
}

test('Google Drive: not set up, then connect, back up the nightly copy (not hourly) and photos, list, read, prune, disconnect', async (t) => {
  const db = await testDb(t);
  const g = fakeGoogle();
  const none = createDrive(db, { clientId: '', clientSecret: '', fetchImpl: g.fetchImpl });
  assert.equal((await none.status()).configured, false);
  await assert.rejects(() => none.authUrl(), /GOOGLE_DRIVE_CLIENT_ID/);

  const drive = createDrive(db, { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://dispatch.example/gdrive/callback', fetchImpl: g.fetchImpl });
  assert.equal(await drive.active(), false);
  const url = new URL(await drive.authUrl());
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file openid email');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  await assert.rejects(() => drive.finishConnect({ code: 'c', state: 'wrong' }), /expired/);
  const st = await drive.finishConnect({ code: 'c', state: url.searchParams.get('state') });
  assert.equal(st.connected, true);
  assert.equal(st.email, 'office@adamsbros.ca');
  const folder = Object.values(g.s.files).find((f) => f.folder);
  assert.equal(folder.name, 'Adams Bros Dispatch backups');

  // Backups: the app's own storage plus Drive. Drive gets the nightly copy only.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let hm = '01:00';
  let day = '2026-11-20';
  await db.run("INSERT INTO settings (key, value) VALUES ('hello', 'world')");
  const backups = createBackups(db, { storage: localStorageAt(dir), server: null, extra: [drive.target], today: () => day, nowHm: () => hm, readPhoto: async () => null });
  let out = await backups.runScheduled();
  assert.deepEqual(out.results.map((r) => r.target), ['local'], 'hourly: not to Drive');
  hm = '02:30';
  out = await backups.runScheduled();
  assert.deepEqual(out.results.map((r) => [r.target, r.ok]), [['local', true], ['gdrive', true]]);
  const names = await drive.target.list('db/');
  assert.deepEqual(names, ['db/2026-11-20.json.gz']);
  const back = gunzipJson(await drive.target.get('db/2026-11-20.json.gz'));
  assert.equal(back.tables.settings.find((r) => r.key === 'hello').value, 'world');
  // The same name again replaces the file (no duplicates).
  await drive.target.put('db/2026-11-20.json.gz', Buffer.from('x'));
  assert.equal(Object.values(g.s.files).filter((f) => f.name === 'db/2026-11-20.json.gz').length, 1);
  // 31 days later the old nightly copy is pruned from Drive too.
  day = '2026-12-22';
  await backups.run({ kind: 'nightly', only: [drive.target] });
  assert.deepEqual(await drive.target.list('db/'), ['db/2026-12-22.json.gz']);
  assert.ok((await backups.status()).targets.some((x) => x.kind === 'gdrive'));

  await drive.disconnect();
  assert.equal(g.s.revoked, 1);
  assert.equal(await drive.active(), false);
  assert.ok(!(await backups.status()).targets.some((x) => x.kind === 'gdrive'), 'not used once disconnected');
});
