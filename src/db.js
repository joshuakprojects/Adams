// Storage. Uses PostgreSQL when DATABASE_URL is set (Replit's built-in database keeps data permanently),
// otherwise a local SQLite file (handy on a laptop and for tests).
//
// SQL is written once, SQLite-style with ? placeholders; for PostgreSQL it is translated
// (placeholders, datetime('now'), AUTOINCREMENT, BLOB, COLLATE NOCASE). All calls are async:
//   await db.get(sql, ...params)   -> first row or undefined
//   await db.all(sql, ...params)   -> rows
//   await db.run(sql, ...params)   -> { changes, lastInsertRowid }
//   await db.tx(async (t) => { ... t.get/all/run ... })
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- truck kind: haul (aggregate), float (lowbed), septic (vac), bin, toilet (service), other
CREATE TABLE IF NOT EXISTS trucks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'haul',
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  default_truck_id INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT ''
);

-- job_type: haul (aggregate) | bin | septic | toilet | float | misc  (see public/forms.js)
-- status:   open | complete | cancelled
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL DEFAULT 'haul',
  customer TEXT NOT NULL DEFAULT '',
  material TEXT NOT NULL DEFAULT '',
  quantity TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  loads_planned INTEGER,
  from_location TEXT NOT NULL DEFAULT '',
  to_location TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  scheduled_date TEXT NOT NULL,
  scheduled_time TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS jobs_date ON jobs(scheduled_date);

-- status: pending (not texted yet) | sent | acknowledged | in_progress | done | cancelled
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  truck_id INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  loads_done INTEGER NOT NULL DEFAULT 0,
  needs_resend INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  ack_at TEXT,
  ack_via TEXT,
  started_at TEXT,
  done_at TEXT,
  UNIQUE (job_id, driver_id)
);
CREATE INDEX IF NOT EXISTS assignments_driver ON assignments(driver_id);

-- direction: out | in.  handled: 1 when an inbound text was understood (OK / DONE)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  handled INTEGER NOT NULL DEFAULT 1,
  seen INTEGER NOT NULL DEFAULT 0,
  provider_sid TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);

-- Scale ticket / delivery photos. source: web (job page) | sms (texted photo) | office
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tickets_job ON tickets(job_id);

-- Which drivers got the day's lineup text, so the automatic evening send doesn't repeat itself.
CREATE TABLE IF NOT EXISTS lineup_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  auto INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lineup_sends_date ON lineup_sends(date);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Orders sent in by the website. status: new | scheduled | declined | duplicate
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE,
  service TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  customer_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  billing_address TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  municipality TEXT NOT NULL DEFAULT '',
  requested_date TEXT NOT NULL DEFAULT '',
  estimate_total TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status);

-- Customer address book. Jobs link to it with jobs.customer_id.
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  billing_address TEXT NOT NULL DEFAULT '',
  site_address TEXT NOT NULL DEFAULT '',
  municipality TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  site_lat REAL,
  site_lng REAL,
  reminder_contacted_at TEXT,
  reminder_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS customers_phone ON customers(phone);

-- Who did what to a job, and when (office staff, drivers, the website).
CREATE TABLE IF NOT EXISTS job_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS job_history_job ON job_history(job_id);

-- Map locations looked up for addresses (Google allows keeping these up to 30 days).
CREATE TABLE IF NOT EXISTS geocodes (
  address_key TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nightly backups that were written (Replit Object Storage or a local folder).
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  photos INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Price book (from the office price sheets). Admins edit prices; jobs keep the price they were booked at (job_lines).
-- key: used by the automatic pricing (e.g. delivery.30, agg.a-gravel-3-4.triaxle); grp: groups a material's prices.
CREATE TABLE IF NOT EXISTS price_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  grp TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  price REAL,
  taxable INTEGER NOT NULL DEFAULT 1,
  max_km REAL,
  notes TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS price_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER,
  item_name TEXT NOT NULL DEFAULT '',
  change TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The priced lines of a work order, with the price at the time it was booked.
CREATE TABLE IF NOT EXISTS job_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT '',
  unit_price REAL,
  taxable INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'charge',
  auto INTEGER NOT NULL DEFAULT 0,
  slot TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS job_lines_job ON job_lines(job_id);

-- Standard answers to customer questions, kept by admins, read by everyone.
CREATE TABLE IF NOT EXISTS faq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- QuickBooks Online: the Estimate kept for each work order (or a preview while QuickBooks is off).
CREATE TABLE IF NOT EXISTS qbo_sync (
  job_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  estimate_id TEXT NOT NULL DEFAULT '',
  sync_token TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Driving distances looked up with Google (kept up to 30 days).
CREATE TABLE IF NOT EXISTS distances (
  route_key TEXT PRIMARY KEY,
  meters INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Columns added after the first version. Added to existing databases on start-up.
const ADDED_COLUMNS = {
  jobs: {
    // Customer & billing, as on the paper work orders.
    customer_phone: "TEXT NOT NULL DEFAULT ''",
    customer_email: "TEXT NOT NULL DEFAULT ''",
    billing_address: "TEXT NOT NULL DEFAULT ''",
    po_number: "TEXT NOT NULL DEFAULT ''",
    municipality: "TEXT NOT NULL DEFAULT ''",
    paper_wo: "TEXT NOT NULL DEFAULT ''",
    quoted_price: "TEXT NOT NULL DEFAULT ''",
    payment_method: "TEXT NOT NULL DEFAULT ''",
    collect_payment: 'INTEGER NOT NULL DEFAULT 0', // no longer used: payments are handled by the office
    // "First thing" in the morning: sorts ahead of timed jobs that day.
    first_thing: 'INTEGER NOT NULL DEFAULT 0',
    // The website request this job was scheduled from, if any.
    request_id: 'INTEGER',
    // Address book link, office billing fields, and a pin dragged by hand on the map.
    customer_id: 'INTEGER',
    invoice_number: "TEXT NOT NULL DEFAULT ''",
    amount_billed: "TEXT NOT NULL DEFAULT ''",
    lat: 'REAL',
    lng: 'REAL',
    // Time of day instead of an exact time: 'first' (first thing), 'am', 'pm' or '' (any time).
    time_slot: "TEXT NOT NULL DEFAULT ''",
    // Saved without every required field filled in: can't be texted until it's finished.
    draft: 'INTEGER NOT NULL DEFAULT 0',
    // Pricing: driving distance used for the delivery fee, and the price-panel choices (weekly/monthly, off-schedule…).
    distance_km: 'REAL',
    distance_from: "TEXT NOT NULL DEFAULT ''",
    distance_mode: "TEXT NOT NULL DEFAULT ''",
    in_town: 'INTEGER',
    price_options: "TEXT NOT NULL DEFAULT '{}'",
    // Type-specific form fields (bin service, septic tank details, toilet types…) as JSON.
    details: "TEXT NOT NULL DEFAULT '{}'",
  },
  users: {
    // office: prices, questions, customers, work orders (no texting) · dispatcher: + texting drivers · admin: everything
    role: "TEXT NOT NULL DEFAULT 'admin'",
    active: 'INTEGER NOT NULL DEFAULT 1',
  },
  assignments: {
    // What the driver filled in after the job (septic conditions, payment collected, notes) as JSON.
    report: "TEXT NOT NULL DEFAULT '{}'",
    report_at: 'TEXT',
  },
  customers: {
    // The same customer in QuickBooks Online (QuickBooks is the master customer list).
    qbo_id: "TEXT NOT NULL DEFAULT ''",
  },
  geocodes: {
    municipality: "TEXT NOT NULL DEFAULT ''",
  },
  drivers: {
    // 'driver' (drives a truck) or 'labourer' (texted their jobs the same way, no truck).
    kind: "TEXT NOT NULL DEFAULT 'driver'",
  },
  tickets: {
    // How a texted photo found its job: 'number' (the driver said which), 'only' (their only job), 'asked' (no job yet: we asked).
    matched: "TEXT NOT NULL DEFAULT ''",
    data: 'BLOB',
  },
};


// ---------- PostgreSQL ----------

const PG_NOW = "to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')";

function toPgSql(sql) {
  let n = 0;
  return sql
    .replace(/datetime\('now'\)/g, PG_NOW)
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'INTEGER PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY')
    .replace(/\bBLOB\b/g, 'BYTEA')
    .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
    .replace(/\s+COLLATE NOCASE/g, '')
    .replace(/\?/g, () => `$${++n}`);
}

function pgDriver(url) {
  const pg = require('pg');
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT(*) and BIGINT as numbers
  const ssl = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 5 });
  const clean = (params) => params.map((v) => (v === undefined ? null : v));

  const make = (runner) => {
    const query = (sql, params) => runner.query(toPgSql(sql), clean(params));
    return {
      kind: 'pg',
      async get(sql, ...params) { return (await query(sql, params)).rows[0]; },
      async all(sql, ...params) { return (await query(sql, params)).rows; },
      async run(sql, ...params) {
        const isInsert = /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql);
        const res = await query(isInsert ? `${sql} RETURNING *` : sql, params);
        return { changes: res.rowCount, lastInsertRowid: res.rows[0]?.id };
      },
      async exec(sql) { await runner.query(toPgSql(sql)); },
    };
  };

  const db = make(pool);
  db.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(make(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  db.close = () => pool.end();
  db.setup = async () => {
    await pool.query(toPgSql(SCHEMA));
    for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
      for (const [name, def] of Object.entries(cols)) {
        await pool.query(toPgSql(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${def}`));
      }
    }
    // Start job numbers at 1001 so they look like real job numbers on the trucks.
    const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS max FROM jobs');
    if (Number(rows[0].max) < 1000) await pool.query("SELECT setval(pg_get_serial_sequence('jobs', 'id'), 1000)");
  };
  return db;
}

// ---------- SQLite ----------

function sqliteDriver(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const clean = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
  const db = {
    kind: 'sqlite',
    async get(sql, ...params) { return raw.prepare(sql).get(...clean(params)); },
    async all(sql, ...params) { return raw.prepare(sql).all(...clean(params)); },
    async run(sql, ...params) {
      const r = raw.prepare(sql).run(...clean(params));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    async exec(sql) { raw.exec(sql); },
  };
  // One connection: run transactions one at a time.
  let queue = Promise.resolve();
  db.tx = (fn) => {
    const next = queue.then(async () => {
      raw.exec('BEGIN');
      try {
        const result = await fn(db);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    });
    queue = next.catch(() => {});
    return next;
  };
  db.close = async () => raw.close();
  db.setup = async () => {
    raw.exec(SCHEMA);
    for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
      const have = new Set(raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      for (const [name, def] of Object.entries(cols)) {
        if (!have.has(name)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
      }
    }
    const seq = raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'jobs'").get();
    if (!seq) raw.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('jobs', 1000)").run();
  };
  return db;
}

/**
 * Open the database and make sure all tables exist.
 * openDb(':memory:') / openDb('data/dispatch.db') for SQLite, openDb({ url: 'postgres://…' }) for PostgreSQL.
 */
async function openDb(target) {
  const db = typeof target === 'object' && target.url ? pgDriver(target.url) : sqliteDriver(typeof target === 'string' ? target : target.file);
  await db.setup();
  await migrate(db);
  return db;
}

/** One-time data changes, each run once per database. */
async function migrate(db) {
  const done = async (key) => Boolean(await db.get('SELECT value FROM settings WHERE key = ?', 'migration_' + key));
  const mark = (key) => db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'migration_' + key, 'done');
  // Exact times became First thing / AM / PM.
  if (!(await done('time_slot'))) {
    await db.run(`UPDATE jobs SET time_slot = CASE
        WHEN first_thing = 1 THEN 'first'
        WHEN scheduled_time <> '' AND scheduled_time < '12:00' THEN 'am'
        WHEN scheduled_time >= '12:00' THEN 'pm'
        ELSE '' END WHERE time_slot = ''`);
    await mark('time_slot');
  }
}

module.exports = { openDb, toPgSql, migrate };
