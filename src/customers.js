// Customer address book: one record per customer, linked from jobs (jobs.customer_id).
// Jobs fill it in automatically; the office can edit it on the Customers tab.
const sms = require('./sms');

class CustomerError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));

function createCustomers(db, { today }) {
  const FIELDS = ['name', 'phone', 'email', 'billing_address', 'site_address', 'municipality', 'notes'];

  function clean(data) {
    const phoneRaw = str(data.phone, 40);
    return {
      name: str(data.name, 200),
      phone: sms.normalizePhone(phoneRaw) || phoneRaw,
      email: str(data.email, 200),
      billing_address: str(data.billing_address, 500),
      site_address: str(data.site_address, 300),
      municipality: str(data.municipality, 100),
      notes: str(data.notes, 1000),
    };
  }

  async function get(id) {
    return (await db.get('SELECT * FROM customers WHERE id = ?', Number(id))) || null;
  }

  async function save(data) {
    const c = clean(data);
    if (!c.name && !c.phone) throw new CustomerError('A customer needs a name or a phone number');
    if (data.id) {
      if (!(await get(data.id))) throw new CustomerError('Customer not found');
      await db.run(`UPDATE customers SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ...FIELDS.map((f) => c[f]), Number(data.id));
      return get(data.id);
    }
    const r = await db.run(`INSERT INTO customers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`, ...FIELDS.map((f) => c[f]));
    return get(r.lastInsertRowid);
  }

  /** Quick search for the job form: by name, phone digits, or address. */
  async function search(q, limit = 10) {
    const term = str(q, 100).toLowerCase();
    if (!term) return [];
    const digits = term.replace(/\D/g, '');
    const like = `%${term}%`;
    return db.all(`SELECT c.*, (SELECT MAX(scheduled_date) FROM jobs j WHERE j.customer_id = c.id) AS last_job_date
      FROM customers c
      WHERE lower(c.name) LIKE ? OR lower(c.site_address) LIKE ? OR lower(c.billing_address) LIKE ?${digits.length >= 3 ? ' OR c.phone LIKE ?' : ''}
      ORDER BY lower(c.name) LIMIT ${Number(limit) || 10}`, like, like, like, ...(digits.length >= 3 ? [`%${digits}%`] : []));
  }

  async function list({ q = '' } = {}) {
    if (q) return search(q, 200);
    return db.all(`SELECT c.*, (SELECT MAX(scheduled_date) FROM jobs j WHERE j.customer_id = c.id) AS last_job_date,
        (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) AS job_count
      FROM customers c ORDER BY lower(c.name) LIMIT 500`);
  }

  async function jobsFor(id) {
    return db.all(`SELECT id, job_type, scheduled_date, status, material, to_location, municipality, quoted_price, amount_billed, invoice_number, details
      FROM jobs WHERE customer_id = ? ORDER BY scheduled_date DESC, id DESC LIMIT 100`, Number(id));
  }

  /**
   * The customer a job belongs to: the one picked in the form, else a match on phone number, else on
   * name (when neither has a phone), else a new record. Fills in blanks on a matched record, never overwrites.
   * Returns the customer id, or null when the job has no customer name or phone at all.
   */
  async function resolve(fields, pickedId = null, t = db) {
    const name = str(fields.customer, 200);
    const phone = sms.normalizePhone(fields.customer_phone) || '';
    let c = null;
    if (pickedId) c = await t.get('SELECT * FROM customers WHERE id = ?', Number(pickedId));
    if (!c && phone) c = await t.get('SELECT * FROM customers WHERE phone = ? ORDER BY id LIMIT 1', phone);
    if (!c && name) c = await t.get("SELECT * FROM customers WHERE lower(name) = ? AND (phone = '' OR ? = '') ORDER BY id LIMIT 1", name.toLowerCase(), phone);
    const fromJob = {
      name, phone, email: str(fields.customer_email, 200), billing_address: str(fields.billing_address, 500),
      site_address: str(fields.to_location, 300), municipality: str(fields.municipality, 100),
    };
    if (!c) {
      if (!name && !phone) return null;
      const cols = Object.keys(fromJob);
      const r = await t.run(`INSERT INTO customers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((k) => fromJob[k]));
      return Number(r.lastInsertRowid);
    }
    const blanks = Object.keys(fromJob).filter((k) => !c[k] && fromJob[k]);
    if (blanks.length) {
      await t.run(`UPDATE customers SET ${blanks.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ...blanks.map((k) => fromJob[k]), c.id);
    }
    return c.id;
  }

  /** Link jobs from before the address book existed. Safe to run on every start. */
  async function backfill() {
    const jobs = await db.all(`SELECT * FROM jobs WHERE customer_id IS NULL AND (customer != '' OR customer_phone != '') ORDER BY id LIMIT 5000`);
    for (const j of jobs) {
      const id = await resolve(j);
      if (id) await db.run('UPDATE jobs SET customer_id = ? WHERE id = ?', id, j.id);
    }
    return jobs.length;
  }

  function addYears(ymd, years) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y - years, m - 1, d));
    return dt.toISOString().slice(0, 10);
  }

  /**
   * Customers due for another septic pump-out: last completed pump-out at least `years` ago, nothing
   * septic booked since, and not marked contacted in the last 90 days.
   */
  async function septicDue({ years = 2 } = {}) {
    const cutoff = addYears(today(), years);
    const rows = await db.all(`SELECT c.*, MAX(j.scheduled_date) AS last_pumpout
      FROM customers c JOIN jobs j ON j.customer_id = c.id
      WHERE j.job_type = 'septic' AND j.status = 'complete'
      GROUP BY c.id, c.name, c.phone, c.email, c.billing_address, c.site_address, c.municipality, c.notes, c.site_lat, c.site_lng,
        c.reminder_contacted_at, c.reminder_note, c.created_at, c.updated_at
      HAVING MAX(j.scheduled_date) <= ?
      ORDER BY MAX(j.scheduled_date)`, cutoff);
    const out = [];
    for (const r of rows) {
      const booked = await db.get(`SELECT id FROM jobs WHERE customer_id = ? AND job_type = 'septic' AND status = 'open' LIMIT 1`, r.id);
      if (booked) continue;
      if (r.reminder_contacted_at) {
        const since = (Date.parse(today()) - Date.parse(r.reminder_contacted_at.slice(0, 10))) / 86400000;
        if (since < 90) continue;
      }
      const last = await db.get(`SELECT id, details, to_location, municipality FROM jobs
        WHERE customer_id = ? AND job_type = 'septic' AND status = 'complete' ORDER BY scheduled_date DESC, id DESC LIMIT 1`, r.id);
      let details = {};
      try { details = JSON.parse(last?.details || '{}'); } catch { /* ignore */ }
      out.push({ ...r, last_job_id: last?.id || null, tank_type: details.tank_type || '', tank_size: details.tank_size || '',
        address: last?.to_location || r.site_address, job_municipality: last?.municipality || r.municipality });
    }
    return out;
  }

  async function markContacted(id, note = '') {
    if (!(await get(id))) throw new CustomerError('Customer not found');
    await db.run(`UPDATE customers SET reminder_contacted_at = datetime('now'), reminder_note = ?, updated_at = datetime('now') WHERE id = ?`,
      str(note, 300), Number(id));
    return get(id);
  }

  /** A new septic job filled in from the customer and their last pump-out. */
  async function septicPrefill(id) {
    const c = await get(id);
    if (!c) throw new CustomerError('Customer not found');
    const last = await db.get(`SELECT * FROM jobs WHERE customer_id = ? AND job_type = 'septic' ORDER BY scheduled_date DESC, id DESC LIMIT 1`, c.id);
    let details = {};
    try { details = JSON.parse(last?.details || '{}'); } catch { /* ignore */ }
    return {
      job_type: 'septic', customer_id: c.id, customer: c.name, customer_phone: c.phone, customer_email: c.email,
      billing_address: c.billing_address, to_location: last?.to_location || c.site_address,
      municipality: last?.municipality || c.municipality, scheduled_date: today(), details, assignments: [],
      notes: [c.notes, last ? `Last pump-out: job #${last.id} on ${last.scheduled_date}.` : ''].filter(Boolean).join(' '),
    };
  }

  return { get, save, search, list, jobsFor, resolve, backfill, septicDue, markContacted, septicPrefill };
}

module.exports = { createCustomers, CustomerError };
