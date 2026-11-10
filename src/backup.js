// Backups, every hour and every night.
//  • hourly/YYYY-MM-DD-HH.json.gz — every table except logins' sessions, as gzipped JSON. Kept 48 hours.
//  • db/YYYY-MM-DD.json.gz        — the nightly copy. Kept 30 days.
//  • photos/<ticket id>           — each scale ticket photo, uploaded once (photos are never pruned).
// Stored in Replit App Storage (Object Storage) on Replit, otherwise in data/backups — and also on your own server
// when BACKUP_SERVER_URL is set (src/backupTargets.js). "Download a copy" gives a .zip with the photos too.
// Restore with `npm run restore` (scripts/restore.js).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const config = require('./config');

const FORMAT = 'adams-dispatch-backup';
// Restore order: parents before children (foreign keys).
const TABLES = ['users', 'trucks', 'drivers', 'customers', 'jobs', 'assignments', 'messages', 'tickets',
  'lineup_sends', 'settings', 'requests', 'job_history', 'price_items', 'price_changes', 'job_lines', 'faq', 'qbo_sync', 'quotes', 'boss_notes'];
// Tables without an "id" counter (PostgreSQL counters are reset after a restore).
const NO_ID = new Set(['settings', 'qbo_sync']);
const KEEP_DAYS = 30;
const DB_PREFIX = 'db/';
const PHOTO_PREFIX = 'photos/';

// ---------- storage targets (same small interface) ----------

function localStorageAt(dir) {
  const full = (name) => {
    const p = path.resolve(dir, name);
    if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error('Bad backup name');
    return p;
  };
  return {
    kind: 'local',
    label: `folder ${dir}`,
    async put(name, buf) { fs.mkdirSync(path.dirname(full(name)), { recursive: true }); fs.writeFileSync(full(name), buf); },
    async get(name) { return fs.readFileSync(full(name)); },
    async exists(name) { return fs.existsSync(full(name)); },
    async list(prefix) {
      const d = full(prefix + 'x').replace(/x$/, '');
      return fs.existsSync(d) ? fs.readdirSync(d).map((f) => prefix + f) : [];
    },
    async remove(name) { fs.rmSync(full(name), { force: true }); },
  };
}

/** The bucket made in Replit's Object Storage tool, as written in .replit (or BACKUP_BUCKET_ID). */
function replitBucketId(env = process.env) {
  if (env.BACKUP_BUCKET_ID) return env.BACKUP_BUCKET_ID;
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', '.replit'), 'utf8');
    return /defaultBucketID\s*=\s*"([^"]+)"/.exec(text)?.[1] || undefined;
  } catch { return undefined; }
}

/**
 * Replit Object Storage (the bucket set up in the Replit "Object Storage" tool).
 * The client is only made when a backup runs: the library starts connecting as soon as a client is created, and a
 * failed connection there must never stop the dispatch app. If it fails, the next backup tries again.
 */
function replitStorage(Client = null, { bucketId = replitBucketId() } = {}) {
  let client = null;
  const getClient = () => {
    if (!client) {
      const C = Client || require('@replit/object-storage').Client;
      client = new C(bucketId ? { bucketId } : undefined);
      // The library starts its own connection in the background; note a failure here instead of crashing.
      client.state?.promise?.catch?.((err) => {
        console.warn('Object Storage not reachable:', err.message);
        client = null;
      });
    }
    return client;
  };
  const call = async (what, fn) => {
    let r;
    try {
      r = await fn(getClient());
    } catch (err) {
      client = null;
      // "fetch failed" hides the real reason in err.cause (e.g. ECONNREFUSED 127.0.0.1:1106).
      const why = [err.message, err.cause?.code, err.cause?.message].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' — ');
      const hint = bucketId ? `Bucket ${bucketId}.` : 'No bucket ID set: add the Secret BACKUP_BUCKET_ID (App Storage → your bucket → its ID).';
      throw new Error(`Object Storage ${what} failed: ${why}. ${hint}`);
    }
    if (!r || !r.ok) {
      if (/initiali[sz]/i.test(String(r?.error?.message || r?.error || ''))) client = null;
      throw new Error(`Object Storage ${what} failed: ${r?.error?.message || r?.error || 'unknown error'}`);
    }
    return r.value;
  };
  return {
    kind: 'replit',
    label: bucketId ? `Replit App Storage (bucket ${bucketId})` : 'Replit App Storage (default bucket)',
    bucketId,
    async put(name, buf) { await call('upload', (c) => c.uploadFromBytes(name, buf)); },
    async get(name) { const v = await call('download', (c) => c.downloadAsBytes(name)); return Array.isArray(v) ? v[0] : v; },
    async exists(name) { return call('check', (c) => c.exists(name)); },
    async list(prefix) { return (await call('list', (c) => c.list({ prefix }))).map((o) => o.name); },
    async remove(name) { await call('delete', (c) => c.delete(name)); },
  };
}

/** BACKUP_TARGET: replit | local | off. Default: Replit Object Storage on Replit, else the local folder. */
function chooseStorage(env = process.env) {
  const want = (env.BACKUP_TARGET || '').toLowerCase();
  if (want === 'off') return null;
  const onReplit = Boolean(env.REPL_ID || env.REPLIT_DEPLOYMENT);
  if (want === 'replit' || (!want && onReplit)) {
    try {
      require.resolve('@replit/object-storage');
      return replitStorage();
    } catch (err) {
      if (want === 'replit') throw err;
      console.warn('Replit Object Storage not available, backing up to data/backups instead:', err.message);
    }
  }
  return localStorageAt(env.BACKUP_DIR || path.join(path.dirname(config.dbPath), 'backups'));
}

// ---------- dump / restore ----------

async function dump(db) {
  const tables = {};
  for (const t of TABLES) {
    let rows = await db.all(`SELECT * FROM ${t} ORDER BY 1`);
    if (t === 'tickets') rows = rows.map(({ data, ...rest }) => rest); // photos go up separately
    if (t === 'settings') rows = rows.filter((r) => !String(r.key).startsWith('qbo_tokens') && r.key !== 'qbo_oauth_state'); // no sign-ins in backups
    tables[t] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) || v instanceof Uint8Array ? null : v])));
  }
  return { format: FORMAT, version: 1, created_at: new Date().toISOString(), db_kind: db.kind, tables };
}

const gzipJson = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
const gunzipJson = (buf) => {
  const obj = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  if (obj.format !== FORMAT) throw new Error('This is not an Adams Bros dispatch backup');
  return obj;
};

/**
 * Load a backup into an empty database (same or newer version of the app).
 * photoFor(ticketId) → Buffer|null fills in the ticket photos.
 */
async function restore(db, backup, { photoFor = null, force = false } = {}) {
  const have = await db.get('SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM drivers) AS drivers');
  if (!force && (Number(have.jobs) || Number(have.drivers))) {
    throw new Error('This database already has drivers or jobs. Restore into an empty database (or pass --force to wipe it first).');
  }
  const counts = {};
  let photos = 0;
  // Tables in this backup are replaced. (Older backups don't have the newer tables, such as the price book:
  // those are left as they are rather than emptied.)
  const inBackup = TABLES.filter((n) => Array.isArray(backup.tables[n]));
  await db.tx(async (t) => {
    if (force) for (const name of [...TABLES].reverse()) if (inBackup.includes(name)) await t.run(`DELETE FROM ${name}`);
    // What the app made by itself at start-up (the first login, default settings, the price book) would clash.
    await t.run('DELETE FROM sessions');
    for (const name of [...inBackup].reverse()) await t.run(`DELETE FROM ${name}`);
    for (const name of inBackup) {
      const rows = backup.tables[name] || [];
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        await t.run(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
      }
      counts[name] = rows.length;
    }
  });
  if (photoFor) {
    for (const row of backup.tables.tickets || []) {
      const buf = await photoFor(row.id).catch(() => null);
      if (buf) { await db.run('UPDATE tickets SET data = ? WHERE id = ?', buf, row.id); photos++; }
    }
  }
  if (db.kind === 'pg') {
    for (const name of inBackup.filter((n) => !NO_ID.has(n))) {
      await db.get(`SELECT setval(pg_get_serial_sequence('${name}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${name}), 0), 1))`);
    }
  }
  return { counts, photos };
}

/** 'YYYY-MM-DD HH:MM' in the company's time zone, from a stored UTC 'YYYY-MM-DD HH:MM:SS'. */
function localStamp(sqlUtc) {
  const d = new Date(String(sqlUtc || '').replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** A "Download a copy" zip: { backup, photoFor(ticketId), photoCount, close }. */
function loadZipBackup(file) {
  const { readZip } = require('./zip');
  const z = readZip(file);
  const dbEntry = z.entries.find((e) => !e.name.includes('/') && /\.json\.gz$/.test(e.name));
  if (!dbEntry) { z.close(); throw new Error('No database file in that zip — is it an Adams Bros Dispatch backup?'); }
  const backup = gunzipJson(z.read(dbEntry));
  const photos = new Map();
  for (const e of z.entries) {
    const m = /^Photos\/.+\/ticket (\d+) - [^/]*$/.exec(e.name);
    if (m) photos.set(Number(m[1]), e);
  }
  return { backup, photoCount: photos.size, photoFor: async (id) => (photos.has(Number(id)) ? z.read(photos.get(Number(id))) : null), close: z.close };
}

// ---------- the backup job: hourly + nightly, to every target ----------
//  hourly/YYYY-MM-DD-HH.json.gz  every hour, kept 48 hours
//  db/YYYY-MM-DD.json.gz         every night after 2 AM, kept 30 days
//  photos/<ticket id>            each new ticket photo, once per target, kept for good
const HOURLY_PREFIX = 'hourly/';
const KEEP_HOURS = 48;

function createBackups(db, { storage = chooseStorage(), server = undefined, today, nowHm, readPhoto, now = () => Date.now() } = {}) {
  if (server === undefined) {
    try { server = require('./backupTargets').serverTarget(); } catch (err) { console.warn('Backup server not used:', err.message); server = null; }
  }
  const targets = [storage, server].filter(Boolean);
  async function setting(key) { return (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value ?? null; }
  async function setSetting(key, value) {
    await db.run('DELETE FROM settings WHERE key = ?', key);
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', key, String(value));
  }
  // Each target remembers the last ticket photo it has (the first target kept the original setting name).
  const photoKey = (t) => (t === targets[0] ? 'backup_photo_id' : `backup_photo_id:${t.kind}`);
  const nameFor = (kind) => (kind === 'hourly' ? `${HOURLY_PREFIX}${today()}-${nowHm().slice(0, 2)}.json.gz` : `${DB_PREFIX}${today()}.json.gz`);

  async function runOn(target, name, buf) {
    try {
      await target.put(name, buf);
      const after = Number(await setting(photoKey(target))) || 0;
      const fresh = await db.all('SELECT id FROM tickets WHERE id > ? ORDER BY id', after);
      let photos = 0;
      let last = after;
      for (const { id } of fresh) {
        const data = await readPhoto(id);
        if (data) { await target.put(`${PHOTO_PREFIX}${id}`, data); photos++; }
        last = id;
      }
      if (last !== after) await setSetting(photoKey(target), last);
      await prune(target);
      await db.run('INSERT INTO backups (name, target, bytes, photos, ok) VALUES (?, ?, ?, ?, 1)', name, target.kind, buf.length, photos);
      return { ok: true, target: target.kind, label: target.label, name, bytes: buf.length, photos };
    } catch (err) {
      await db.run('INSERT INTO backups (name, target, bytes, photos, ok, error) VALUES (?, ?, 0, 0, 0, ?)', name, target.kind, String(err.message).slice(0, 500));
      return { ok: false, target: target.kind, label: target.label, name, error: err.message };
    }
  }

  /** Back up now (to every target, or the ones given). */
  async function run({ reason = 'by hand', kind = 'nightly', only = null } = {}) {
    if (!targets.length) throw new Error('Backups are turned off (BACKUP_TARGET=off)');
    const name = nameFor(kind);
    const buf = gzipJson(await dump(db));
    const results = [];
    for (const t of only || targets) results.push(await runOn(t, name, buf));
    const first = results[0];
    const failed = results.filter((r) => !r.ok);
    return { ok: !failed.length, name, bytes: buf.length, photos: first.photos || 0, reason, results,
      error: failed.length ? failed.map((r) => `${r.label}: ${r.error}`).join(' · ') : undefined };
  }

  /** Delete hourly copies older than 48 hours and nightly copies older than 30 days (by the date in the name). */
  async function prune(target = targets[0]) {
    const cutoffDay = new Date(Date.parse(today() + 'T12:00:00Z') - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
    for (const n of await target.list(DB_PREFIX)) {
      const m = /(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(n);
      if (m && m[1] < cutoffDay) await target.remove(n);
    }
    const nowKey = `${today()}-${nowHm().slice(0, 2)}`;
    const toMs = (k) => Date.parse(`${k.slice(0, 10)}T${k.slice(11, 13)}:00:00Z`);
    for (const n of await target.list(HOURLY_PREFIX)) {
      const m = /(\d{4}-\d{2}-\d{2}-\d{2})\.json\.gz$/.exec(n);
      if (m && toMs(nowKey) - toMs(m[1]) > KEEP_HOURS * 3600e3) await target.remove(n);
    }
  }

  /** Called every minute: the nightly copy after 2 AM, and an hourly copy every hour — each target on its own. */
  async function runScheduled() {
    if (!targets.length) return null;
    const due = async (name, t, waitMin) => {
      if (await db.get('SELECT id FROM backups WHERE ok = 1 AND name = ? AND target = ? LIMIT 1', name, t.kind)) return false;
      const failed = await db.get('SELECT at FROM backups WHERE ok = 0 AND name = ? AND target = ? ORDER BY id DESC LIMIT 1', name, t.kind);
      return !(failed && now() - Date.parse(failed.at.replace(' ', 'T') + 'Z') < waitMin * 60e3);
    };
    for (const [kind, wait] of [['nightly', 60], ['hourly', 15]]) {
      if (kind === 'nightly' && nowHm() < '02:00') continue;
      const name = nameFor(kind);
      const only = [];
      for (const t of targets) if (await due(name, t, wait)) only.push(t);
      if (only.length) return run({ reason: kind, kind, only });
    }
    return null;
  }

  async function status() {
    const runs = await db.all('SELECT * FROM backups ORDER BY id DESC LIMIT 20');
    const last = async (kind) => db.get('SELECT * FROM backups WHERE target = ? ORDER BY id DESC LIMIT 1', kind);
    const lastOk = async (kind) => db.get('SELECT * FROM backups WHERE target = ? AND ok = 1 ORDER BY id DESC LIMIT 1', kind);
    const list = [];
    for (const t of targets) list.push({ kind: t.kind, label: t.label, last: await last(t.kind), last_ok: await lastOk(t.kind) });
    return {
      target: storage ? storage.kind : 'off',
      label: storage ? storage.label : 'Backups are off',
      server: server ? { label: server.label } : null,
      targets: list,
      keep_days: KEEP_DAYS,
      keep_hours: KEEP_HOURS,
      runs,
    };
  }

  /** The database only, as one file (.json.gz). */
  async function download() { return gzipJson(await dump(db)); }

  /**
   * Everything in one .zip, streamed: the database (restorable) and every ticket photo in a folder per work order,
   * with a spreadsheet saying which photo is which. write(buf) sends bytes on.
   */
  async function downloadZip(write, { stamp = today() } = {}) {
    const { zipWriter } = require('./zip');
    const z = zipWriter(write);
    await z.add(`adams-dispatch-database-${stamp}.json.gz`, gzipJson(await dump(db)));
    const rows = await db.all(`SELECT t.id, t.job_id, t.filename, t.content_type, t.source, t.created_at,
        d.name AS driver_name, j.customer, j.scheduled_date, j.to_location, j.municipality, j.job_type
      FROM tickets t LEFT JOIN drivers d ON d.id = t.driver_id LEFT JOIN jobs j ON j.id = t.job_id ORDER BY t.job_id, t.id`);
    const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const ext = (r) => (/\.[a-z0-9]{3,4}$/i.exec(r.filename || '') || ['.jpg'])[0].toLowerCase();
    const index = [['File', 'Ticket #', 'Work order #', 'Job date', 'Customer', 'Address', 'Driver', 'Sent', 'How']];
    let photos = 0;
    for (const r of rows) {
      const data = await readPhoto(r.id).catch(() => null);
      if (!data) continue;
      const folder = r.job_id ? `WO-${r.job_id} - ${clean(r.customer) || 'no name'} - ${r.scheduled_date || ''}` : 'Not matched to a work order';
      const when = localStamp(r.created_at).replace(':', '.');
      const file = `Photos/${clean(folder)}/ticket ${r.id} - ${clean(r.driver_name) || 'driver'} - ${when}${ext(r)}`;
      await z.add(file, data, r.created_at ? new Date(r.created_at.replace(' ', 'T') + 'Z') : new Date());
      index.push([file, r.id, r.job_id || '', r.scheduled_date || '', r.customer || '', [r.to_location, r.municipality].filter(Boolean).join(', '),
        r.driver_name || '', localStamp(r.created_at), r.source === 'sms' ? 'texted' : 'job page']);
      photos++;
    }
    const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    await z.add('Photos/index.csv', Buffer.from('﻿' + index.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'));
    await z.add('README.txt', Buffer.from([
      'Adams Bros Dispatch — backup made ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' (UTC)',
      '',
      `adams-dispatch-database-${stamp}.json.gz  The whole database: work orders, customers, drivers, prices, history, logins.`,
      'Photos/                      Every scale ticket photo, in a folder per work order.',
      'Photos/index.csv             Which photo belongs to which work order (opens in Excel).',
      '',
      'To restore everything (database and photos) into an empty database:',
      '  npm run restore -- path/to/this-file.zip',
      '',
      'Keep this file somewhere safe: it includes customer details and the office logins (passwords are scrambled).',
    ].join('\r\n')));
    await z.end();
    return { photos, bytes: z.size };
  }

  // ---------- restore (Setup → Backups, owner only) ----------
  const SAFETY_PREFIX = 'safety/';
  /** Copies that can be restored, newest first: [{ target, label, name, kind, stamp }]. */
  async function stored() {
    const out = [];
    for (const t of targets) {
      let names = [];
      try { names = [...await t.list(DB_PREFIX), ...await t.list(HOURLY_PREFIX), ...await t.list(SAFETY_PREFIX)]; } catch { continue; }
      for (const name of names) {
        const m = /(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2})?(\d{2})?)?(?:-\d+)?\.json\.gz$/.exec(name);
        if (!m) continue;
        const kind = name.startsWith(HOURLY_PREFIX) ? 'hourly' : name.startsWith(SAFETY_PREFIX) ? 'safety' : 'nightly';
        // Nightly copies (and "Back up now") are one per day: shown by date. Hourly and safety copies by time.
        const stamp = kind === 'nightly' ? m[1] : `${m[1]} ${m[2] || '00'}:${m[3] || '00'}${m[4] ? ':' + m[4] : ''}`;
        out.push({ target: t.kind, label: t.label, name, kind, stamp, sort: kind === 'nightly' ? `${m[1]} 02:00` : stamp });
      }
    }
    return out.sort((a, b) => b.sort.localeCompare(a.sort) || b.name.localeCompare(a.name)).slice(0, 200);
  }

  let restoring = false;
  /** A copy of things as they are right now, before a restore replaces them. */
  async function safetyCopy() {
    const t = targets[0];
    if (!t) return null;
    const hms = nowHm().replace(':', '') + String(new Date().getSeconds()).padStart(2, '0');
    let name = `${SAFETY_PREFIX}${today()}-${hms}.json.gz`;
    for (let n = 2; await t.exists(name).catch(() => false); n++) name = `${SAFETY_PREFIX}${today()}-${hms}-${n}.json.gz`; // never overwrite one
    const r = await runOn(t, name, gzipJson(await dump(db)));
    if (!r.ok) throw new Error(`Couldn't make the safety copy first, so nothing was restored: ${r.error}`);
    return name;
  }

  /** Replace the live data with a stored copy (or a "Download a copy" zip): a safety copy is made first. */
  async function restoreNow({ target: kind, name, zipFile } = {}) {
    if (restoring) throw Object.assign(new Error('A restore is already running'), { status: 400 });
    restoring = true;
    try {
      let backup;
      let photoFor;
      let zip = null;
      if (zipFile) {
        zip = loadZipBackup(zipFile);
        backup = zip.backup;
        photoFor = zip.photoFor;
      } else {
        const t = targets.find((x) => x.kind === kind);
        if (!t) throw Object.assign(new Error('That backup place is not set up'), { status: 400 });
        if (!/^(db|hourly|safety)\/[\w-]+\.json\.gz$/.test(String(name))) throw Object.assign(new Error('Pick a backup from the list'), { status: 400 });
        backup = gunzipJson(await t.get(name));
        photoFor = async (id) => ((await t.exists(PHOTO_PREFIX + id)) ? t.get(PHOTO_PREFIX + id) : null);
      }
      try {
        const safety = await safetyCopy();
        const out = await restore(db, backup, { photoFor, force: true });
        return { ...out, safety, created_at: backup.created_at };
      } finally {
        zip?.close();
      }
    } finally {
      restoring = false;
    }
  }

  return { run, runScheduled, prune, status, download, downloadZip, stored, restoreNow, storage, server, targets };
}

module.exports = { createBackups, dump, restore, gzipJson, gunzipJson, localStorageAt, replitStorage, chooseStorage, loadZipBackup, TABLES, DB_PREFIX, PHOTO_PREFIX, HOURLY_PREFIX };
