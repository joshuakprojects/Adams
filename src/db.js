const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

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
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  // Start job numbers at 1001 so they look like real job numbers on the trucks.
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'jobs'").get();
  if (!seq) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('jobs', 1000)").run();
  return db;
}

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
    // Type-specific form fields (bin service, septic tank details, toilet types…) as JSON.
    details: "TEXT NOT NULL DEFAULT '{}'",
  },
  assignments: {
    // What the driver filled in after the job (septic conditions, payment collected, notes) as JSON.
    report: "TEXT NOT NULL DEFAULT '{}'",
    report_at: 'TEXT',
  },
};

function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, def] of Object.entries(cols)) {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  }
}

/** Run fn inside a transaction. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
