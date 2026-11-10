// Reception (office logins): saved quotes, the home screen summary, and "Find" (customers and their work orders).
const sms = require('./sms');
const FORMS = require('../public/forms');

class QuoteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const str = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));

/** A plain-words status for a work order, as reception sees it. */
function plainStatus(job) {
  const live = (job.assignments || []).filter((a) => a.status !== 'cancelled');
  if (job.status === 'cancelled') return { text: 'Cancelled', tone: 'grey' };
  if (job.status === 'complete') return { text: 'Done ✓', tone: 'green' };
  if (Number(job.draft)) return { text: `Draft — needs ${(job.missing || []).join(', ') || 'details'}`, tone: 'yellow' };
  if (!live.length) return { text: 'Waiting for dispatch', tone: 'grey' };
  if (live.some((a) => a.status === 'pending')) return { text: 'Dispatch has it ✓', tone: 'green' };
  if (live.every((a) => ['acknowledged', 'in_progress', 'done'].includes(a.status))) return { text: 'Driver confirmed ✓', tone: 'green' };
  return { text: 'Driver texted', tone: 'green' };
}

function createReception(db, dispatch) {
  async function shape(job) {
    return {
      id: job.id, job_type: job.job_type, type_name: FORMS.typeInfo(job.job_type).name, scheduled_date: job.scheduled_date,
      time_slot: job.time_slot, customer: job.customer, customer_phone: job.customer_phone, to_location: job.to_location,
      municipality: job.municipality, summary: FORMS.summary(job), total: job.totals?.total ?? null, status: job.status,
      draft: Number(job.draft) || 0, plain: plainStatus(job), created_by_name: job.created_by_name,
    };
  }

  // ---------- quotes ----------
  function cleanQuote(data) {
    const job = data.job && typeof data.job === 'object' ? data.job : null;
    if (!job) throw new QuoteError('Nothing to save in the quote');
    const total = Number(data.total);
    return {
      customer: str(job.customer || data.customer, 200),
      phone: sms.normalizePhone(job.customer_phone || '') || str(job.customer_phone, 40),
      address: str([job.to_location, job.municipality].filter(Boolean).join(', '), 300),
      summary: str(data.summary || FORMS.summary(job), 300),
      total: Number.isFinite(total) ? Math.round(total * 100) / 100 : null,
      data: JSON.stringify(job).slice(0, 200000),
    };
  }
  async function saveQuote(data, user) {
    const q = cleanQuote(data);
    if (data.id) {
      const row = await db.get('SELECT * FROM quotes WHERE id = ?', Number(data.id));
      if (!row) throw new QuoteError('Quote not found', 404);
      await db.run(`UPDATE quotes SET customer = ?, phone = ?, address = ?, summary = ?, total = ?, data = ?, updated_at = datetime('now') WHERE id = ?`,
        q.customer, q.phone, q.address, q.summary, q.total, q.data, row.id);
      return getQuote(row.id);
    }
    const r = await db.run(`INSERT INTO quotes (customer, phone, address, summary, total, data, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      q.customer, q.phone, q.address, q.summary, q.total, q.data, user?.id ?? null, user?.name || '');
    return getQuote(Number(r.lastInsertRowid));
  }
  async function getQuote(id) {
    const row = await db.get('SELECT * FROM quotes WHERE id = ?', Number(id));
    if (!row) return null;
    let job = {};
    try { job = JSON.parse(row.data || '{}'); } catch { /* keep empty */ }
    return { ...row, data: undefined, job };
  }
  async function listQuotes({ status = 'open', limit = 50 } = {}) {
    return db.all('SELECT id, customer, phone, address, summary, total, status, job_id, created_by_name, created_at, updated_at FROM quotes WHERE status = ? ORDER BY id DESC LIMIT ?',
      status, limit);
  }
  async function setQuoteStatus(id, status, jobId = null) {
    if (!['open', 'booked', 'dropped'].includes(status)) throw new QuoteError('Unknown quote status');
    await db.run("UPDATE quotes SET status = ?, job_id = COALESCE(?, job_id), updated_at = datetime('now') WHERE id = ?", status, jobId, Number(id));
    return getQuote(id);
  }

  // ---------- home ----------
  async function home(user, today) {
    const mine = await db.all(`SELECT id FROM jobs WHERE created_by = ? ORDER BY id DESC LIMIT 12`, user?.id ?? -1);
    const recent = [];
    for (const { id } of mine) recent.push(await shape(await dispatch.getJob(id)));
    const count = async (sql, ...a) => Number((await db.get(sql, ...a))?.n || 0);
    const weekEnd = new Date(Date.parse(today + 'T12:00:00Z') + 6 * 86400e3).toISOString().slice(0, 10);
    return {
      recent,
      quotes: await listQuotes({ status: 'open', limit: 20 }),
      today_jobs: await count("SELECT COUNT(*) AS n FROM jobs WHERE scheduled_date = ? AND status <> 'cancelled'", today),
      week_jobs: await count("SELECT COUNT(*) AS n FROM jobs WHERE scheduled_date BETWEEN ? AND ? AND status <> 'cancelled'", today, weekEnd),
    };
  }

  // ---------- find ----------
  /** Customers and work orders matching a name, phone, address or W.O. number. */
  async function find(q) {
    const term = str(q, 100);
    if (!term) return { customers: [], jobs: [] };
    const customers = await dispatch.customers.search(term, 8);
    const digits = term.replace(/\D/g, '');
    const like = `%${term.toLowerCase()}%`;
    const woNumber = /^\s*(?:w\.?o\.?|#)?\s*(\d{3,6})\s*$/i.exec(term)?.[1];
    const rows = await db.all(`SELECT id FROM jobs WHERE ${woNumber ? 'id = ? OR ' : ''}lower(customer) LIKE ? OR lower(to_location) LIKE ?
        ${digits.length >= 4 ? 'OR customer_phone LIKE ?' : ''}
      ORDER BY scheduled_date DESC, id DESC LIMIT 30`,
    ...(woNumber ? [Number(woNumber)] : []), like, like, ...(digits.length >= 4 ? [`%${digits}%`] : []));
    const jobs = [];
    for (const { id } of rows) jobs.push(await shape(await dispatch.getJob(id)));
    return { customers, jobs };
  }

  async function customerJobs(customerId) {
    const rows = await db.all('SELECT id FROM jobs WHERE customer_id = ? ORDER BY scheduled_date DESC, id DESC LIMIT 50', Number(customerId));
    const out = [];
    for (const { id } of rows) out.push(await shape(await dispatch.getJob(id)));
    return out;
  }

  return { saveQuote, getQuote, listQuotes, setQuoteStatus, home, find, customerJobs, plainStatus };
}

module.exports = { createReception, plainStatus, QuoteError };
