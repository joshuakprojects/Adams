// Nightly backups.
//  • db/YYYY-MM-DD.json.gz — every table except logins' sessions, as gzipped JSON. Kept 30 days.
//  • photos/<ticket id>     — each scale ticket photo, uploaded once (photos are never pruned).
// Stored in Replit Object Storage when the app runs on Replit with a bucket set up, otherwise in data/backups.
// Restore with `npm run restore` (scripts/restore.js).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const config = require('./config');

const FORMAT = 'adams-dispatch-backup';
// Restore order: parents before children (foreign keys).
const TABLES = ['users', 'trucks', 'drivers', 'customers', 'jobs', 'assignments', 'messages', 'tickets',
  'lineup_sends', 'settings', 'requests', 'job_history'];
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
  await db.tx(async (t) => {
    if (force) for (const name of [...TABLES].reverse()) await t.run(`DELETE FROM ${name}`);
    // The login the app made at start-up and default settings would clash with the backed-up ones.
    await t.run('DELETE FROM sessions');
    await t.run('DELETE FROM users');
    await t.run('DELETE FROM settings');
    for (const name of TABLES) {
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
    for (const name of TABLES.filter((n) => n !== 'settings')) {
      await db.get(`SELECT setval(pg_get_serial_sequence('${name}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${name}), 0), 1))`);
    }
  }
  return { counts, photos };
}

// ---------- the nightly job ----------

function createBackups(db, { storage = chooseStorage(), today, nowHm, readPhoto } = {}) {
  async function setting(key) { return (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value ?? null; }
  async function setSetting(key, value) {
    await db.run('DELETE FROM settings WHERE key = ?', key);
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', key, String(value));
  }

  async function run({ reason = 'nightly' } = {}) {
    if (!storage) throw new Error('Backups are turned off (BACKUP_TARGET=off)');
    const name = `${DB_PREFIX}${today()}.json.gz`;
    try {
      const buf = gzipJson(await dump(db));
      await storage.put(name, buf);
      // New ticket photos since the last backup.
      const after = Number(await setting('backup_photo_id')) || 0;
      const fresh = await db.all('SELECT id FROM tickets WHERE id > ? ORDER BY id', after);
      let photos = 0;
      let last = after;
      for (const { id } of fresh) {
        const data = await readPhoto(id);
        if (data) { await storage.put(`${PHOTO_PREFIX}${id}`, data); photos++; }
        last = id;
      }
      if (last !== after) await setSetting('backup_photo_id', last);
      await prune();
      await db.run('INSERT INTO backups (name, target, bytes, photos, ok) VALUES (?, ?, ?, ?, 1)', name, storage.kind, buf.length, photos);
      return { ok: true, name, bytes: buf.length, photos, reason };
    } catch (err) {
      await db.run('INSERT INTO backups (name, target, bytes, photos, ok, error) VALUES (?, ?, 0, 0, 0, ?)', name, storage.kind, String(err.message).slice(0, 500));
      return { ok: false, name, error: err.message, reason };
    }
  }

  /** Delete database copies older than 30 days (by the date in the name). */
  async function prune() {
    const cutoff = new Date(Date.parse(today() + 'T12:00:00Z') - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
    for (const n of await storage.list(DB_PREFIX)) {
      const m = /(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(n);
      if (m && m[1] < cutoff) await storage.remove(n);
    }
  }

  /** Called every minute: one backup a night, after 2 AM company time (or as soon as the app is up after that). */
  async function runScheduled() {
    if (!storage || nowHm() < '02:00') return null;
    const done = await db.get('SELECT id FROM backups WHERE ok = 1 AND name = ? LIMIT 1', `${DB_PREFIX}${today()}.json.gz`);
    if (done) return null;
    // After a failure, wait an hour before trying again.
    const failed = await db.get("SELECT at FROM backups WHERE ok = 0 AND name = ? ORDER BY id DESC LIMIT 1", `${DB_PREFIX}${today()}.json.gz`);
    if (failed && Date.now() - Date.parse(failed.at.replace(' ', 'T') + 'Z') < 3600e3) return null;
    return run();
  }

  async function status() {
    const runs = await db.all('SELECT * FROM backups ORDER BY id DESC LIMIT 10');
    return { target: storage ? storage.kind : 'off', label: storage ? storage.label : 'Backups are off', keep_days: KEEP_DAYS, runs };
  }

  async function download() { return gzipJson(await dump(db)); }

  return { run, runScheduled, prune, status, download, storage };
}

module.exports = { createBackups, dump, restore, gzipJson, gunzipJson, localStorageAt, replitStorage, chooseStorage, TABLES, DB_PREFIX, PHOTO_PREFIX };
