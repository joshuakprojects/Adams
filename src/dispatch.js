const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const sms = require('./sms');
const FORMS = require('../public/forms');
const PRICING = require('../public/pricing');
const { createPrices } = require('./prices');
const { createCustomers } = require('./customers');
const { createGeo, addressKey, validPoint } = require('./geo');
const { currentActor } = require('./actor');

const JOB_TYPES = FORMS.TYPE_KEYS;
const TRUCK_KINDS = Object.keys(FORMS.TRUCK_KINDS);
const ACTIVE_STATUSES = ['sent', 'acknowledged', 'in_progress'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function todayIn(timeZone = config.timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Current local time as 'HH:MM' in the company time zone. */
function nowHmIn(timeZone = config.timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function newToken() {
  return crypto.randomBytes(12).toString('base64url');
}

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));

/** Keep only known form fields, trimmed; choice fields must be one of their options. */
function cleanFields(fields, input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const f of fields) {
    let v = str(src[f.key], f.kind === 'textarea' ? 1000 : 200);
    if (!v) continue;
    if (f.kind === 'check') {
      if (['yes', 'on', 'true', '1'].includes(v.toLowerCase())) out[f.key] = 'Yes';
      continue;
    }
    if (f.kind === 'choice' && !f.options.includes(v)) throw new ValidationError(`${f.label}: pick one of ${f.options.join(', ')}`);
    if (f.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ValidationError(`${f.label} must be a date`);
    if (f.kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${f.label} must be a number`);
      v = String(n);
    }
    out[f.key] = v;
  }
  return out;
}

/** What the driver can fill in after a job: the form's report fields, plus notes for any job. (Payments are handled by the office.) */
function reportFields(jobType) {
  return [
    ...FORMS.typeInfo(jobType).report,
    { key: 'driver_notes', label: 'Notes for the office', kind: 'textarea' },
  ];
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC, as stored) for n minutes ago. */
const sqlMinutesAgo = (n) => new Date(Date.now() - n * 60e3).toISOString().slice(0, 19).replace('T', ' ');

/** Sort order for the time of day: first thing, morning, afternoon, then any time. */
const SLOT_ORDER = (t) => `CASE ${t}time_slot WHEN 'first' THEN 0 WHEN 'am' THEN 1 WHEN 'pm' THEN 2 ELSE 3 END, ${t}scheduled_time`;

function parseJson(text) {
  try { return JSON.parse(text || '{}') || {}; } catch { return {}; }
}

const ASSIGNMENT_SELECT = `
  SELECT a.*, d.name AS driver_name, d.phone AS driver_phone, t.unit AS truck_unit, t.kind AS truck_kind
  FROM assignments a
  JOIN drivers d ON d.id = a.driver_id
  LEFT JOIN trucks t ON t.id = a.truck_id`;

/**
 * All dispatch business logic. `send(to, body)` is injectable so tests don't hit Twilio.
 */
function createDispatch(db, { send = sms.sendSms, today = todayIn, nowHm = nowHmIn, uploadDir = config.uploadDir } = {}) {

  // ---------- drivers & trucks ----------

  async function listTrucks({ includeInactive = false } = {}) {
    return await db.all(`SELECT * FROM trucks ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY unit COLLATE NOCASE`);
  }

  async function saveTruck(data) {
    const unit = str(data.unit, 40);
    if (!unit) throw new ValidationError('Truck unit number is required');
    const kind = TRUCK_KINDS.includes(data.kind) ? data.kind : 'haul';
    const description = str(data.description, 200);
    const active = data.active === false || data.active === 0 ? 0 : 1;
    try {
      if (data.id) {
        await db.run('UPDATE trucks SET unit = ?, kind = ?, description = ?, active = ? WHERE id = ?', unit, kind, description, active, Number(data.id));
        return await db.get('SELECT * FROM trucks WHERE id = ?', Number(data.id));
      }
      const r = await db.run('INSERT INTO trucks (unit, kind, description, active) VALUES (?, ?, ?, ?)', unit, kind, description, active);
      return await db.get('SELECT * FROM trucks WHERE id = ?', r.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE|duplicate key/i.test(err.message)) throw new ValidationError(`Truck ${unit} already exists`);
      throw err;
    }
  }

  async function listDrivers({ includeInactive = false } = {}) {
    return await db.all(`SELECT d.*, t.unit AS default_truck_unit FROM drivers d
              LEFT JOIN trucks t ON t.id = d.default_truck_id
              ${includeInactive ? '' : 'WHERE d.active = 1'}
              ORDER BY d.name COLLATE NOCASE`);
  }

  async function saveDriver(data) {
    const kind = data.kind === 'labourer' ? 'labourer' : 'driver';
    const name = str(data.name, 100);
    if (!name) throw new ValidationError(`${kind === 'labourer' ? 'Labourer' : 'Driver'} name is required`);
    const phone = sms.normalizePhone(data.phone);
    if (!phone) throw new ValidationError('Enter a valid 10-digit cell number');
    const truckId = kind === 'driver' && data.default_truck_id ? Number(data.default_truck_id) : null;
    const active = data.active === false || data.active === 0 ? 0 : 1;
    const notes = str(data.notes, 500);
    try {
      if (data.id) {
        await db.run('UPDATE drivers SET name = ?, phone = ?, default_truck_id = ?, active = ?, notes = ?, kind = ? WHERE id = ?', name, phone, truckId, active, notes, kind, Number(data.id));
        return await db.get('SELECT * FROM drivers WHERE id = ?', Number(data.id));
      }
      const r = await db.run('INSERT INTO drivers (name, phone, default_truck_id, active, notes, kind) VALUES (?, ?, ?, ?, ?, ?)', name, phone, truckId, active, notes, kind);
      return await db.get('SELECT * FROM drivers WHERE id = ?', r.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE|duplicate key/i.test(err.message)) throw new ValidationError('Another driver already has that phone number');
      throw err;
    }
  }

  // ---------- jobs ----------

  async function assignmentsFor(jobId) {
    return (await db.all(`${ASSIGNMENT_SELECT} WHERE a.job_id = ? ORDER BY d.name COLLATE NOCASE`, jobId))
      .map((a) => ({ ...a, report: parseJson(a.report) }));
  }

  async function hydrate(job) {
    job.details = parseJson(job.details);
    job.price_options = parseJson(job.price_options);
    job.lines = await db.all('SELECT * FROM job_lines WHERE job_id = ? ORDER BY sort, id', job.id);
    job.totals = PRICING.totals(job.lines, await hstRate());
    job.created_by_name = job.created_by ? (await db.get('SELECT name FROM users WHERE id = ?', job.created_by))?.name || '' : '';
    if (Number(job.draft)) {
      job.missing = FORMS.missingRequired({ ...job, has_pin: job.lat != null }, (await requiredFields())[job.job_type] || []).map((m) => m.label);
    }
    job.assignments = await assignmentsFor(job.id);
    job.tickets = await ticketsFor(job.id);
    return job;
  }

  async function getJob(id) {
    const job = await db.get('SELECT * FROM jobs WHERE id = ?', Number(id));
    return job ? await hydrate(job) : null;
  }

  async function listJobs({ from, to }) {
    const rows = await db.all(`SELECT * FROM jobs WHERE scheduled_date BETWEEN ? AND ?
              ORDER BY scheduled_date, ${SLOT_ORDER('')}, id`, from, to);
    return Promise.all(rows.map(hydrate));
  }

  function cleanJob(data) {
    const job_type = JOB_TYPES.includes(data.job_type) ? data.job_type : 'haul';
    const scheduled_date = str(data.scheduled_date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) throw new ValidationError('Pick a date for the job');
    // First thing / AM / PM / any time. (Older callers may still send an exact time or the "first thing" tick.)
    let time_slot = FORMS.TIME_SLOTS.some(([k]) => k === data.time_slot) ? data.time_slot : null;
    if (time_slot === null) {
      const hm = str(data.scheduled_time, 5);
      if (hm && !/^\d{2}:\d{2}$/.test(hm)) throw new ValidationError('Time must look like 07:30');
      const first = data.first_thing === true || data.first_thing === 1 || data.first_thing === '1' || data.first_thing === 'on';
      time_slot = first ? 'first' : hm ? (hm < '12:00' ? 'am' : 'pm') : '';
    }
    const loads = data.loads_planned === '' || data.loads_planned == null ? null : Number(data.loads_planned);
    if (loads != null && (!Number.isInteger(loads) || loads < 0 || loads > 999)) {
      throw new ValidationError('Number of loads must be a whole number');
    }
    const contactRaw = str(data.contact_phone, 30);
    const customerPhoneRaw = str(data.customer_phone, 30);
    const paymentMethod = str(data.payment_method, 40);
    if (paymentMethod && !FORMS.PAYMENT_METHODS.includes(paymentMethod)) throw new ValidationError('Unknown payment method');
    const t = FORMS.typeInfo(job_type);
    return {
      job_type,
      customer: str(data.customer, 200),
      customer_phone: sms.normalizePhone(customerPhoneRaw) || customerPhoneRaw,
      customer_email: str(data.customer_email, 200),
      billing_address: str(data.billing_address, 500),
      po_number: str(data.po_number, 60),
      municipality: str(data.municipality, 100),
      paper_wo: str(data.paper_wo, 30),
      quoted_price: str(data.quoted_price, 200),
      payment_method: paymentMethod,
      details: JSON.stringify(cleanFields(t.fields, data.details)),
      material: str(data.material, 200),
      quantity: str(data.quantity, 40),
      unit: t.fixedUnit ? (str(data.quantity, 40) ? t.fixedUnit : '') : str(data.unit, 40),
      loads_planned: loads || null,
      from_location: str(data.from_location, 300),
      to_location: str(data.to_location, 300),
      contact_name: str(data.contact_name, 100),
      contact_phone: sms.normalizePhone(contactRaw) || contactRaw,
      scheduled_date,
      time_slot,
      scheduled_time: '',
      first_thing: time_slot === 'first' ? 1 : 0,
      notes: str(data.notes, 1000),
      invoice_number: str(data.invoice_number, 60),
      amount_billed: str(data.amount_billed, 60),
      ...cleanDistance(data),
      price_options: JSON.stringify(cleanPriceOptions(data.price_options)),
    };
  }

  function cleanDistance(data) {
    const km = data.distance_km === '' || data.distance_km == null ? null : Number(data.distance_km);
    if (km != null && (!Number.isFinite(km) || km < 0 || km > 2000)) throw new ValidationError('Distance must be a number of km');
    const mode = ['address', 'pin', 'manual'].includes(data.distance_mode) ? data.distance_mode : '';
    return {
      distance_km: km == null ? null : Math.round(km * 10) / 10,
      distance_from: km == null ? '' : str(data.distance_from, 200),
      distance_mode: km == null ? '' : mode,
      in_town: km == null && !Number(data.in_town) ? null : Number(data.in_town) ? 1 : 0,
    };
  }

  function cleanPriceOptions(o) {
    const src = typeof o === 'string' ? parseJson(o) : o || {};
    const out = {};
    if (src.period === 'month' || src.period === 'week') out.period = src.period;
    if (['yes', 'no', 'auto'].includes(src.member)) out.member = src.member;
    if (['mixed', 'concrete', 'asbestos', 'metal'].includes(src.waste)) out.waste = src.waste;
    if (Array.isArray(src.removed_slots)) out.removed_slots = src.removed_slots.map((x) => str(x, 60)).filter(Boolean).slice(0, 30);
    for (const k of ['off_schedule', 'pump_chamber_too']) if (src[k]) out[k] = true;
    for (const k of ['tons', 'extra_weeks']) {
      const n = Number(src[k]);
      if (Number.isFinite(n) && n > 0 && n < 10000) out[k] = Math.round(n * 100) / 100;
    }
    return out;
  }

  /** The priced lines sent with a work order (the form works them out; the office can add or change lines). */
  function cleanLines(list) {
    if (!Array.isArray(list)) return null;
    return list.slice(0, 60).map((l, i) => {
      const description = str(l.description, 200);
      if (!description) throw new ValidationError('Every price line needs a description');
      const qty = Number(l.qty);
      if (!Number.isFinite(qty) || qty < 0 || qty > 100000) throw new ValidationError(`Quantity for "${description}" isn't a number`);
      let price = l.unit_price === '' || l.unit_price == null ? null : Number(String(l.unit_price).replace(/[$,]/g, ''));
      if (price != null && (!Number.isFinite(price) || Math.abs(price) > 1e6)) throw new ValidationError(`Price for "${description}" isn't a number`);
      if (price != null) price = Math.round(price * 10000) / 10000;
      return {
        item_key: str(l.item_key, 120), description, qty: Math.round(qty * 100) / 100, unit: str(l.unit, 40), unit_price: price,
        taxable: Number(l.taxable) ? 1 : 0, kind: l.kind === 'deposit' ? 'deposit' : 'charge', auto: Number(l.auto) ? 1 : 0,
        slot: str(l.slot, 60), note: str(l.note, 200), sort: i,
      };
    });
  }

  // ---------- calendar ----------
  /** Job counts per day for a month ('YYYY-MM'): { 'YYYY-MM-DD': { total, open, done, drafts } }. Cancelled jobs aren't counted. */
  async function calendar(month) {
    if (!/^\d{4}-\d{2}$/.test(String(month))) throw new ValidationError('Month must look like 2026-11');
    const rows = await db.all(`SELECT scheduled_date, status, draft FROM jobs WHERE scheduled_date >= ? AND scheduled_date <= ? AND status <> 'cancelled'`,
      `${month}-01`, `${month}-31`);
    const out = {};
    for (const r of rows) {
      const d = (out[r.scheduled_date] = out[r.scheduled_date] || { total: 0, open: 0, done: 0, drafts: 0 });
      d.total++;
      if (r.status === 'complete') d.done++; else d.open++;
      if (Number(r.draft)) d.drafts++;
    }
    return out;
  }

  // ---------- required fields (Setup → Required fields) ----------
  const DEFAULT_REQUIRED = Object.fromEntries(FORMS.TYPE_KEYS.map((k) => [k, ['customer', 'customer_phone', 'to_location']]));
  let reqCache = null;
  async function requiredFields() {
    if (reqCache && reqCache.at > Date.now() - 5000) return reqCache.value;
    const row = await db.get("SELECT value FROM settings WHERE key = 'required_fields'");
    const value = row ? { ...DEFAULT_REQUIRED, ...parseJson(row.value) } : DEFAULT_REQUIRED;
    reqCache = { value, at: Date.now() };
    return value;
  }
  async function saveRequiredFields(input) {
    const out = {};
    for (const type of FORMS.TYPE_KEYS) {
      const allowed = new Set(FORMS.requirable(type).map((f) => f.key));
      out[type] = [...new Set((Array.isArray(input?.[type]) ? input[type] : []).filter((k) => allowed.has(k)))];
    }
    await setSetting('required_fields', JSON.stringify(out));
    reqCache = null;
    return out;
  }

  let hstCache = null;
  async function hstRate() {
    if (hstCache && hstCache.at > Date.now() - 5000) return hstCache.rate;
    const rate = Number((await db.get("SELECT value FROM settings WHERE key = 'price_hst_rate'"))?.value ?? 13);
    hstCache = { rate, at: Date.now() };
    return rate;
  }

  const JOB_FIELDS = ['job_type', 'customer', 'material', 'quantity', 'unit', 'loads_planned', 'from_location',
    'to_location', 'contact_name', 'contact_phone', 'scheduled_date', 'scheduled_time', 'first_thing', 'time_slot', 'notes',
    'customer_phone', 'customer_email', 'billing_address', 'po_number', 'municipality', 'paper_wo',
    'quoted_price', 'payment_method', 'details', 'invoice_number', 'amount_billed', 'customer_id',
    'distance_km', 'distance_from', 'distance_mode', 'in_town', 'price_options', 'draft'];
  // Office-only fields (drivers never see them; payments are handled by the office): changing these doesn't need a new text.
  const OFFICE_ONLY = new Set(['customer_email', 'billing_address', 'po_number', 'paper_wo', 'quoted_price', 'payment_method',
    'invoice_number', 'amount_billed', 'customer_id', 'distance_km', 'distance_from', 'distance_mode', 'in_town', 'price_options', 'draft']);
  // Names for the change history.
  const FIELD_LABELS = {
    job_type: 'Type', customer: 'Customer', material: 'Material', quantity: 'Quantity', unit: 'Unit', loads_planned: 'Loads',
    from_location: 'From', to_location: 'Address', contact_name: 'Site contact', contact_phone: 'Site phone',
    scheduled_date: 'Date', scheduled_time: 'Exact time', first_thing: 'First thing', time_slot: 'Time', draft: 'Draft', notes: 'Instructions',
    customer_phone: 'Customer phone', customer_email: 'Email', billing_address: 'Billing address', po_number: 'PO #',
    municipality: 'Municipality', paper_wo: 'Paper W.O. #', quoted_price: 'Quoted price', payment_method: 'Payment',
    details: 'Form details', invoice_number: 'Invoice #', amount_billed: 'Amount billed',
    distance_km: 'Distance (km)', distance_from: 'Distance from', distance_mode: 'Distance by', in_town: 'In town', price_options: 'Price options',
  };
  const customers = createCustomers(db, { today });
  const geo = createGeo(db);
  const prices = createPrices(db);

  // ---------- change history ----------

  // Anything that changes a job is written to its history; listeners (QuickBooks) hear about it there.
  const changeListeners = [];
  function onChange(fn) { changeListeners.push(fn); }

  async function logHistory(jobId, action, details = '', actor = currentActor()) {
    if (!jobId) return;
    await db.run('INSERT INTO job_history (job_id, actor, action, details) VALUES (?, ?, ?, ?)', Number(jobId), str(actor, 100), action, str(details, 1000));
    for (const fn of changeListeners) Promise.resolve().then(() => fn(Number(jobId), action)).catch((err) => console.error('Job change listener:', err.message));
  }

  async function historyFor(jobId) {
    return db.all('SELECT * FROM job_history WHERE job_id = ? ORDER BY id', Number(jobId));
  }

  function describeChange(f, from, to) {
    const show = (v) => {
      if (v === '' || v == null) return '(blank)';
      if (f === 'first_thing' || f === 'draft') return Number(v) ? 'yes' : 'no';
      if (f === 'time_slot') return FORMS.slotLabel(v);
      return String(v).length > 60 ? String(v).slice(0, 57) + '…' : String(v);
    };
    if (f === 'details') return 'Form details changed';
    return `${FIELD_LABELS[f] || f}: ${show(from)} → ${show(to)}`;
  }

  // ---------- map pins ----------
  const sameAddress = (a, b) => addressKey(a) !== '' && addressKey(a) === addressKey(b);

  /** A job at the customer's usual site uses the pin the office already placed for that customer. */
  async function pinFromCustomer(jobId) {
    const j = await db.get('SELECT id, lat, customer_id, to_location FROM jobs WHERE id = ?', jobId);
    if (!j || j.lat != null || !j.customer_id) return;
    const c = await customers.get(j.customer_id);
    if (c && c.site_lat != null && sameAddress(c.site_address, j.to_location)) {
      await db.run('UPDATE jobs SET lat = ?, lng = ? WHERE id = ?', c.site_lat, c.site_lng, jobId);
    }
  }

  /** Save a job's map pin. A pin the office dragged also becomes the customer's site pin. */
  async function setJobLocation(jobId, lat, lng, { manual = false } = {}) {
    const p = validPoint(lat, lng);
    if (!p) throw new ValidationError('Invalid map location');
    const job = await db.get('SELECT * FROM jobs WHERE id = ?', Number(jobId));
    if (!job) throw new ValidationError('Job not found');
    await db.run('UPDATE jobs SET lat = ?, lng = ? WHERE id = ?', p.lat, p.lng, job.id);
    if (manual) {
      await logHistory(job.id, 'Moved the map pin');
      if (job.customer_id) {
        const c = await customers.get(job.customer_id);
        if (c && (!c.site_address || sameAddress(c.site_address, job.to_location))) {
          await db.run('UPDATE customers SET site_lat = ?, site_lng = ? WHERE id = ?', p.lat, p.lng, c.id);
        }
      }
    }
    return p;
  }

  async function cleanAssignments(list) {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const driverId = Number(item.driver_id);
      if (!driverId || seen.has(driverId)) continue;
      const driver = await db.get('SELECT id FROM drivers WHERE id = ?', driverId);
      if (!driver) throw new ValidationError('Unknown driver');
      seen.add(driverId);
      out.push({ driver_id: driverId, truck_id: item.truck_id ? Number(item.truck_id) : null });
    }
    return out;
  }

  /**
   * Create or update a job and its driver assignments.
   * Returns { job, removed } — `removed` are assignments taken off a job that had already been texted.
   * Texts go out separately via sendJob() so the office decides when drivers are notified.
   */
  async function saveJob(data, userId = null, { enforceRequired = false } = {}) {
    const fields = cleanJob(data);
    // Required fields (chosen by an admin on the Setup tab). Missing ones = save as a draft, or not at all.
    const missing = FORMS.missingRequired({ ...fields, details: parseJson(fields.details), has_pin: Boolean(data.pin_lat) || data.lat != null },
      (await requiredFields())[fields.job_type] || []);
    const wantDraft = data.draft === true || data.draft === 1 || data.draft === '1';
    if (enforceRequired && missing.length && !wantDraft) {
      const err = new ValidationError(`Fill in: ${missing.map((m) => m.label).join(', ')} — or save it as a draft.`);
      err.missing = missing.map((m) => m.key);
      throw err;
    }
    fields.draft = wantDraft ? 1 : 0;
    const lines = cleanLines(data.lines);
    const rate = await hstRate();
    if (lines) {
      // Old jobs and the board read quoted_price; keep it in step with the priced lines.
      const t = PRICING.totals(lines, rate);
      if (lines.length) fields.quoted_price = PRICING.money(t.total) + (t.unpriced ? ' + to be priced' : '');
    }
    const wanted = await cleanAssignments(data.assignments);
    const removed = [];
    const changes = [];
    let isNew = !data.id;
    // Address book: the picked customer, else matched by phone / name, else a new one.
    fields.customer_id = await customers.resolve(fields, data.customer_id || null);

    const jobId = await db.tx(async (t) => {
      let id = data.id ? Number(data.id) : null;
      if (id) {
        const before = await t.get('SELECT * FROM jobs WHERE id = ?', id);
        if (!before) throw new ValidationError('Job not found');
        const changed = JOB_FIELDS.some((f) => !OFFICE_ONLY.has(f) && String(before[f] ?? '') !== String(fields[f] ?? ''));
        for (const f of JOB_FIELDS) {
          if (['customer_id', 'distance_from', 'distance_mode', 'in_town', 'price_options', 'scheduled_time', 'first_thing', 'draft'].includes(f)) continue;
          if (f === 'quoted_price' && lines) continue; // the "Price:" line below says it
          if (String(before[f] ?? '') !== String(fields[f] ?? '')) changes.push(describeChange(f, before[f], fields[f]));
        }
        const sets = JOB_FIELDS.map((f) => `${f} = ?`).join(', ');
        await t.run(`UPDATE jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`, ...JOB_FIELDS.map((f) => fields[f]), id);
        if (before.to_location !== fields.to_location || before.municipality !== fields.municipality) {
          await t.run('UPDATE jobs SET lat = NULL, lng = NULL WHERE id = ?', id); // new address: find it on the map again
        }
        if (changed) {
          // Drivers who already have the old details need the update.
          await t.run(`UPDATE assignments SET needs_resend = 1 WHERE job_id = ? AND status IN ('sent','acknowledged','in_progress')`, id);
        }
      } else {
        const marks = JOB_FIELDS.map(() => '?').join(', ');
        const r = await t.run(`INSERT INTO jobs (${JOB_FIELDS.join(', ')}, created_by) VALUES (${marks}, ?)`, ...JOB_FIELDS.map((f) => fields[f]), userId);
        id = Number(r.lastInsertRowid);
      }

      if (lines) {
        const before = await t.all('SELECT * FROM job_lines WHERE job_id = ?', id);
        const was = PRICING.totals(before, rate).total;
        const now = PRICING.totals(lines, rate).total;
        if (!isNew && (was !== now || before.length !== lines.length)) changes.push(`Price: ${PRICING.money(was)} → ${PRICING.money(now)}`);
        await t.run('DELETE FROM job_lines WHERE job_id = ?', id);
        for (const l of lines) {
          await t.run(`INSERT INTO job_lines (job_id, item_key, description, qty, unit, unit_price, taxable, kind, auto, slot, note, sort)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, l.item_key, l.description, l.qty, l.unit, l.unit_price, l.taxable, l.kind, l.auto, l.slot, l.note, l.sort);
        }
      }
      const existing = await t.all(`${ASSIGNMENT_SELECT} WHERE a.job_id = ?`, id);
      const wantedIds = new Set(wanted.map((w) => w.driver_id));
      for (const a of existing) {
        if (!wantedIds.has(a.driver_id)) {
          if (!isNew) changes.push(`Removed driver ${a.driver_name}`);
          if (a.status !== 'pending' && a.status !== 'cancelled') removed.push(a);
          await t.run('DELETE FROM assignments WHERE id = ?', a.id);
        }
      }
      for (const w of wanted) {
        const cur = existing.find((a) => a.driver_id === w.driver_id);
        if (cur) {
          if ((cur.truck_id || null) !== w.truck_id) {
            changes.push(`Changed ${cur.driver_name}'s truck`);
            await t.run(`UPDATE assignments SET truck_id = ?,
                 needs_resend = CASE WHEN status IN ('sent','acknowledged','in_progress') THEN 1 ELSE needs_resend END
               WHERE id = ?`, w.truck_id, cur.id);
          }
        } else {
          await t.run('INSERT INTO assignments (job_id, driver_id, truck_id, token) VALUES (?, ?, ?, ?)', id, w.driver_id, w.truck_id, newToken());
          if (!isNew) changes.push(`Added driver ${(await t.get('SELECT name FROM drivers WHERE id = ?', w.driver_id)).name}`);
        }
      }
      return id;
    });

    // A pin dropped in the form (a lot with no address yet) puts the job on the map there.
    if (data.pin_lat !== undefined && data.pin_lat !== '' && validPoint(data.pin_lat, data.pin_lng)) {
      await setJobLocation(jobId, data.pin_lat, data.pin_lng, { manual: true });
    }
    await pinFromCustomer(jobId);
    const job = await getJob(jobId);
    if (isNew) {
      const who = job.assignments.map((a) => a.driver_name).join(', ');
      await logHistory(jobId, 'Created', [data.history_note, FORMS.summary(job), who && `Drivers: ${who}`].filter(Boolean).join(' · '));
    } else if (changes.length) {
      await logHistory(jobId, 'Edited', changes.join('; '));
    }
    return { job, removed, changes };
  }

  async function sendText(driverId, phone, body, assignmentId = null) {
    try {
      const result = await send(phone, body);
      await db.run(`INSERT INTO messages (driver_id, assignment_id, direction, phone, body, provider_sid) VALUES (?, ?, 'out', ?, ?, ?)`, driverId, assignmentId, phone, body, result?.sid || null);
      return { ok: true };
    } catch (err) {
      await db.run(`INSERT INTO messages (driver_id, assignment_id, direction, phone, body, error) VALUES (?, ?, 'out', ?, ?, ?)`, driverId, assignmentId, phone, body, String(err.message || err));
      return { ok: false, error: String(err.message || err) };
    }
  }

  /** After a driver is texted new or changed details: they need to confirm again, unless already working it. */
  async function markTexted(assignmentId) {
    await db.run(`UPDATE assignments SET needs_resend = 0, sent_at = datetime('now'),
         status = CASE WHEN status IN ('pending','sent','acknowledged') THEN 'sent' ELSE status END,
         ack_at = CASE WHEN status IN ('pending','sent','acknowledged') THEN NULL ELSE ack_at END,
         ack_via = CASE WHEN status IN ('pending','sent','acknowledged') THEN NULL ELSE ack_via END
       WHERE id = ?`, assignmentId);
  }

  /** Tell drivers who were taken off a job. */
  async function notifyRemoved(job, removed) {
    for (const a of removed) await sendText(a.driver_id, a.driver_phone, sms.buildRemovedText(job));
  }

  /**
   * Text the job to drivers. By default: anyone not yet texted, plus anyone whose details changed.
   * Pass assignmentId to (re)send to one driver regardless.
   */
  async function sendJob(jobId, { assignmentId = null } = {}) {
    const job = await getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    if (Number(job.draft)) throw new ValidationError(`Job #${job.id} is a draft. Finish the work order and save it before texting drivers.`);
    if (job.status === 'cancelled') throw new ValidationError('Job is cancelled');
    const targets = job.assignments.filter((a) =>
      assignmentId ? a.id === Number(assignmentId) : a.status === 'pending' || a.needs_resend);
    const results = [];
    for (const a of targets) {
      if (a.status === 'done' && !assignmentId) continue;
      const updated = a.status !== 'pending';
      const res = await sendText(a.driver_id, a.driver_phone, sms.buildJobText(job, a, { updated }), a.id);
      if (res.ok) await markTexted(a.id);
      results.push({ assignment_id: a.id, driver: a.driver_name, updated, ...res });
    }
    const sentOk = results.filter((r) => r.ok);
    if (sentOk.length) await logHistory(jobId, 'Texted', sentOk.map((r) => `${r.driver}${r.updated ? ' (update)' : ''}`).join(', '));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) await logHistory(jobId, 'Text failed', failed.map((r) => `${r.driver}: ${r.error}`).join('; '));
    return { job: await getJob(jobId), results };
  }

  async function cancelJob(jobId) {
    const job = await getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    await db.run(`UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, job.id);
    for (const a of job.assignments) {
      if (a.status !== 'pending' && a.status !== 'done' && a.status !== 'cancelled') {
        await sendText(a.driver_id, a.driver_phone, sms.buildCancelText(job), a.id);
      }
    }
    await db.run(`UPDATE assignments SET status = 'cancelled', needs_resend = 0 WHERE job_id = ? AND status != 'done'`, job.id);
    await logHistory(job.id, 'Cancelled', 'Texted drivers who had it');
    return await getJob(job.id);
  }

  async function setJobStatus(jobId, status) {
    if (!['open', 'complete'].includes(status)) throw new ValidationError('Bad status');
    const job = await getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    if (job.status === 'cancelled' && status === 'open') {
      // Reopening a cancelled job: drivers go back to "not texted yet".
      await db.run(`UPDATE assignments SET status = 'pending', needs_resend = 0, sent_at = NULL, ack_at = NULL WHERE job_id = ? AND status = 'cancelled'`, job.id);
    }
    await db.run(`UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?`, status, job.id);
    if (job.status !== status) await logHistory(job.id, status === 'complete' ? 'Marked complete' : 'Re-opened');
    return await getJob(job.id);
  }

  /** Copy a job (with the same drivers) to another date — for "same run again tomorrow". */
  async function duplicateJob(jobId, date, userId = null) {
    const job = await getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    const copy = { ...job, id: null, scheduled_date: date || job.scheduled_date, paper_wo: '', invoice_number: '', amount_billed: '',
      history_note: `Copied from #${job.id}` };
    copy.assignments = job.assignments.map((a) => ({ driver_id: a.driver_id, truck_id: a.truck_id }));
    return (await saveJob(copy, userId)).job;
  }

  /**
   * Book the return trip for a portable toilet or bin: same customer and address on the pick-up date,
   * no driver yet (it's usually a different day and truck).
   */
  async function bookPickup(jobId, date, userId = null) {
    const job = await getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    if (!['toilet', 'bin'].includes(job.job_type)) throw new ValidationError('Pick-ups are for toilets and bins');
    const when = date || job.details.pickup_date;
    if (!when) throw new ValidationError('Set the expected pick-up date first');
    const details = { ...job.details };
    if (job.job_type === 'toilet') details.trip = 'Pick up';
    else details.service = 'Empty & no return';
    return (await saveJob({
      ...job, id: null, scheduled_date: when, scheduled_time: '', first_thing: 0, time_slot: '', paper_wo: '', details,
      invoice_number: '', amount_billed: '', history_note: `Pick-up for #${job.id}`,
      notes: [`Pick-up for job #${job.id}.`, job.notes].filter(Boolean).join(' '), assignments: [],
    }, userId)).job;
  }

  async function deleteJob(jobId) {
    await db.run('DELETE FROM jobs WHERE id = ?', Number(jobId));
  }

  // ---------- driver side ----------

  async function assignmentByToken(token) {
    const a = await db.get(`${ASSIGNMENT_SELECT} WHERE a.token = ?`, String(token || ''));
    if (!a) return null;
    a.job = await db.get('SELECT * FROM jobs WHERE id = ?', a.job_id);
    a.job.details = parseJson(a.job.details);
    a.report = parseJson(a.report);
    return a;
  }

  /** The driver's after-job report from their phone (septic conditions, notes). */
  async function saveReport(token, data, via = 'web') {
    const a = await assignmentByToken(token);
    if (!a) throw new ValidationError('Job not found');
    const report = cleanFields(reportFields(a.job.job_type), data);
    await db.run(`UPDATE assignments SET report = ?, report_at = datetime('now'),
         ack_at = COALESCE(ack_at, datetime('now')), ack_via = COALESCE(ack_via, ?),
         status = CASE WHEN status IN ('pending','sent') THEN 'acknowledged' ELSE status END
       WHERE id = ?`, JSON.stringify(report), via, a.id);
    await logHistory(a.job_id, 'Filled in the report', '', a.driver_name);
    return await assignmentByToken(token);
  }

  /** Other upcoming jobs for the same driver, so the job page can link between them. */
  async function otherJobsForDriver(driverId, excludeAssignmentId) {
    return await db.all(`SELECT a.token, a.status, j.id AS job_id, j.job_type, j.scheduled_date, j.scheduled_time, j.first_thing, j.time_slot, j.material, j.to_location
              FROM assignments a JOIN jobs j ON j.id = a.job_id
              WHERE a.driver_id = ? AND a.id != ? AND j.status = 'open' AND j.scheduled_date >= ?
                AND a.status IN ('sent','acknowledged','in_progress')
              ORDER BY j.scheduled_date, ${SLOT_ORDER('j.')} LIMIT 10`, driverId, excludeAssignmentId, today());
  }

  /**
   * Button presses from the driver's job page.
   * ack: "Got it"   load: +1 load   unload: undo a load   done: finished   reopen: undo finished
   */
  async function driverAction(token, action, via = 'web') {
    const a = await assignmentByToken(token);
    if (!a) throw new ValidationError('Job not found');
    if (a.status === 'cancelled' || a.job.status === 'cancelled') throw new ValidationError('This job was cancelled');
    switch (action) {
      case 'ack':
        if (a.status === 'pending' || a.status === 'sent') {
          await db.run(`UPDATE assignments SET status = 'acknowledged', ack_at = datetime('now'), ack_via = ? WHERE id = ?`, via, a.id);
        }
        break;
      case 'load':
        await db.run(`UPDATE assignments SET loads_done = loads_done + 1,
             status = CASE WHEN status = 'done' THEN status ELSE 'in_progress' END,
             ack_at = COALESCE(ack_at, datetime('now')), ack_via = COALESCE(ack_via, ?),
             started_at = COALESCE(started_at, datetime('now'))
           WHERE id = ?`, via, a.id);
        break;
      case 'unload':
        await db.run('UPDATE assignments SET loads_done = CASE WHEN loads_done > 0 THEN loads_done - 1 ELSE 0 END WHERE id = ?', a.id);
        break;
      case 'done':
        await db.run(`UPDATE assignments SET status = 'done', done_at = datetime('now'),
             ack_at = COALESCE(ack_at, datetime('now')), ack_via = COALESCE(ack_via, ?)
           WHERE id = ?`, via, a.id);
        await autoCompleteJob(a.job_id);
        break;
      case 'reopen':
        await db.run(`UPDATE assignments SET status = CASE WHEN loads_done > 0 THEN 'in_progress' ELSE 'acknowledged' END, done_at = NULL WHERE id = ?`, a.id);
        await db.run(`UPDATE jobs SET status = 'open' WHERE id = ? AND status = 'complete'`, a.job_id);
        break;
      default:
        throw new ValidationError('Unknown action');
    }
    const after = await assignmentByToken(token);
    const what = { ack: 'Confirmed', load: `+1 load (${after.loads_done})`, unload: `Undid a load (${after.loads_done})`, done: 'Marked done', reopen: 'Undid done' }[action];
    const where = via === 'web' ? ' on the job page' : via === 'office' ? ` for ${a.driver_name}` : '';
    if (!(action === 'ack' && !['pending', 'sent'].includes(a.status))) {
      await logHistory(a.job_id, what + where, '', via === 'office' ? currentActor() : a.driver_name);
    }
    return after;
  }

  /** When every driver on a job is done, the job is complete. */
  async function autoCompleteJob(jobId) {
    const left = (await db.get(`SELECT COUNT(*) AS n FROM assignments WHERE job_id = ? AND status NOT IN ('done','cancelled')`, jobId)).n;
    if (left === 0) {
      const r = await db.run(`UPDATE jobs SET status = 'complete', updated_at = datetime('now') WHERE id = ? AND status = 'open'`, jobId);
      if (r.changes) await logHistory(jobId, 'Job complete', 'Every driver finished', 'System');
    }
  }

  // ---------- inbound texts ----------

  async function logInbound(phone, body, driverId, assignmentId, handled) {
    await db.run(`INSERT INTO messages (driver_id, assignment_id, direction, phone, body, handled) VALUES (?, ?, 'in', ?, ?, ?)`, driverId, assignmentId, phone, body, handled ? 1 : 0);
  }

  async function logAutoReply(driver, body, assignmentId = null) {
    await db.run(`INSERT INTO messages (driver_id, assignment_id, direction, phone, body) VALUES (?, ?, 'out', ?, ?)`, driver.id, assignmentId, driver.phone, body);
  }

  const jobLabel = (a) => `#${a.job_id} (${sms.formatJobWhen(a).replace(' @ ', ' ')})`;

  /**
   * A driver texted us. Understands OK / DONE (optionally with a job number); anything else is
   * flagged on the dashboard for the office. Returns { reply } — the text to send back, if any.
   */
  async function handleInbound(fromRaw, bodyRaw, { media = [] } = {}) {
    const phone = sms.normalizePhone(fromRaw) || String(fromRaw || '');
    let body = String(bodyRaw || '').trim().slice(0, 1600);
    const driver = await db.get('SELECT * FROM drivers WHERE phone = ?', phone);
    if (!driver) {
      await logInbound(phone, body || `[${media.length} photo(s)]`, null, null, false);
      return { reply: null };
    }

    const { action } = sms.parseReply(body);
    const open = await db.all(`${ASSIGNMENT_SELECT.replace('SELECT a.*', 'SELECT a.*, j.scheduled_date, j.scheduled_time, j.first_thing, j.time_slot, j.customer, j.to_location')}
                    JOIN jobs j ON j.id = a.job_id
                    WHERE a.driver_id = ? AND j.status = 'open' AND a.status IN ('sent','acknowledged','in_progress')
                    ORDER BY j.scheduled_date, ${SLOT_ORDER('j.')}, j.id`, driver.id);
    const first = driver.name.split(' ')[0];
    const finish = async (reply, assignmentId, handled = true) => {
      await logInbound(phone, body || '[photo]', driver.id, assignmentId, handled);
      if (reply) await logAutoReply(driver, reply, assignmentId);
      return { reply };
    };

    // Which job does the text mean? "WO 1042", "W.O. #1042", "job 1042", "#1042" always count; a plain number only when it
    // is one of this driver's open jobs (so "1200 gallons" isn't mistaken for a job).
    const named = sms.jobNumbers(body);
    const mine = new Set(open.map((a) => a.job_id));
    const jobId = named.explicit.find((n) => mine.has(n)) ?? named.plain.find((n) => mine.has(n)) ?? named.explicit[0] ?? null;
    const today_ = today();
    const current = open.filter((a) => a.scheduled_date <= today_);
    const working = current.filter((a) => a.status === 'in_progress');
    // No number: their job in progress, or their only job today. More than one: ask, don't guess.
    const onlyJob = () => (working.length === 1 ? working[0] : current.length === 1 ? current[0] : null);
    const named_ = jobId ? open.find((a) => a.job_id === jobId) || null : null;
    const choices = () => current.slice(0, 4).map((a) => `${a.job_id}${a.customer ? ` (${a.customer})` : ''}`).join(', ');

    // A job number on its own (or with words) right after photos we couldn't place, or guessed: put them on that job.
    if (named_ && !media.length) {
      const recent = await db.all(`SELECT id, job_id, matched FROM tickets WHERE driver_id = ? AND source = 'sms' AND matched IN ('asked', 'only')
        AND created_at >= ? ORDER BY id`, driver.id, sqlMinutesAgo(30));
      const move = recent.filter((tk) => tk.matched === 'asked' || (tk.job_id !== named_.job_id && tk.matched === 'only'));
      if (move.length) {
        for (const tk of move) await db.run("UPDATE tickets SET job_id = ?, assignment_id = ?, matched = 'number' WHERE id = ?", named_.job_id, named_.id, tk.id);
        await logHistory(named_.job_id, `Texted ${move.length === 1 ? 'a ticket photo' : move.length + ' ticket photos'}`, `job number sent after the photo`, driver.name);
        if (!action) {
          const what = move.length === 1 ? 'photo' : `${move.length} photos`;
          return finish(`Thanks ${first} - ${what} added to Job #${named_.job_id}.`, named_.id);
        }
      }
    }

    // A texted photo is a scale ticket for the job.
    if (media.length) {
      const target = named_ || onlyJob();
      const how = named_ ? 'number' : target ? 'only' : 'asked';
      for (const m of media) {
        await saveTicket({ driverId: driver.id, assignment: target, buffer: m.buffer, contentType: m.contentType, source: 'sms', matched: how });
      }
      if (target) await logHistory(target.job_id, `Texted ${media.length === 1 ? 'a ticket photo' : media.length + ' ticket photos'}`, body && !action ? body : '', driver.name);
      const n = media.length === 1 ? 'ticket photo' : `${media.length} ticket photos`;
      if (!target) {
        if (!body) body = '[photo - waiting for the job number]';
        if (!current.length) return finish(`Got your ${n}, but you have no job today to put it on. Dispatch will sort it out.`, null, false);
        return finish(`Got your ${n}. Which job is it for? Reply with the job number: ${choices()}`, null, false);
      }
      if (!action) {
        if (body && !sms.SMALL_TALK.test(body) && !/^\W*(wo|w\.o\.?|job|#)?\W*\d{3,6}\W*$/i.test(body)) {
          // Photo plus a real message: save the photo, still show the message to the office.
          return finish(`Got your ${n} for Job #${target.job_id}.`, target.id, false);
        }
        return finish(`Got your ${n} for Job #${target.job_id}.`, target.id);
      }
    }

    if (action === 'ack') {
      let targets = open.filter((a) => a.status === 'sent');
      if (jobId) targets = open.filter((a) => a.job_id === jobId);
      if (!targets.length) {
        if (jobId) return finish(`Couldn't find an open Job #${jobId} for you. Call dispatch if that's wrong.`, null, false);
        return finish(open.length ? `Thanks ${first} - your jobs are already confirmed.` : null, null, true);
      }
      for (const a of targets) {
        if (a.status === 'sent') {
          await db.run(`UPDATE assignments SET status = 'acknowledged', ack_at = datetime('now'), ack_via = 'sms' WHERE id = ?`, a.id);
          await logHistory(a.job_id, 'Confirmed by text', body, driver.name);
        }
      }
      const label = targets.length === 1 ? `Job ${jobLabel(targets[0])}` : `Jobs ${targets.map(jobLabel).join(', ')}`;
      return finish(`Thanks ${first} - ${label} confirmed.`, targets.length === 1 ? targets[0].id : null);
    }

    if (action === 'done') {
      const target = jobId ? named_ : onlyJob();
      if (!target) {
        if (jobId) return finish(`Couldn't find an open Job #${jobId} for you. Call dispatch if that's wrong.`, null, false);
        if (current.length > 1) return finish(`Which job is done? Reply DONE and the job number: ${choices()}`, null, false);
        return finish(`No job today to mark done. Reply DONE and the job number, e.g. DONE ${open[0]?.job_id || 1042}`, null, false);
      }
      await db.run(`UPDATE assignments SET status = 'done', done_at = datetime('now'),
           ack_at = COALESCE(ack_at, datetime('now')), ack_via = COALESCE(ack_via, 'sms') WHERE id = ?`, target.id);
      await logHistory(target.job_id, 'Texted DONE', body, driver.name);
      await autoCompleteJob(target.job_id);
      return finish(`Thanks ${first} - Job ${jobLabel(target)} marked DONE.`, target.id);
    }

    // Not an OK/DONE: put it in front of the office, and on the job when we know which one.
    if (sms.SMALL_TALK.test(body)) return finish(null, open[0]?.id || null, true);
    const linked = named_ || (current.length === 1 ? current[0] : open.length === 1 ? open[0] : null);
    if (linked && body) await logHistory(linked.job_id, 'Texted a note', body, driver.name);
    return finish(null, linked?.id || null, false);
  }

  // ---------- scale tickets ----------

  async function ticketsFor(jobId) {
    return await db.all(`SELECT t.id, t.assignment_id, t.driver_id, t.source, t.created_at, d.name AS driver_name
              FROM tickets t LEFT JOIN drivers d ON d.id = t.driver_id
              WHERE t.job_id = ? ORDER BY t.id`, jobId);
  }

  /** Save a ticket photo. `assignment` may be null (photo texted with no job to match). */
  async function saveTicket({ driverId = null, assignment = null, buffer, contentType, source = 'web', matched = '' }) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) throw new ValidationError('Only photos can be uploaded');
    if (!buffer || !buffer.length) throw new ValidationError('The photo was empty');
    if (buffer.length > MAX_IMAGE_BYTES) throw new ValidationError('That photo is too big');
    // Stored in the database (not on disk) so photos survive a republish on Replit.
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const r = await db.run(`INSERT INTO tickets (assignment_id, job_id, driver_id, filename, content_type, source, data, matched) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      assignment?.id ?? null, assignment?.job_id ?? null, driverId ?? assignment?.driver_id ?? null, filename, type, source, Buffer.from(buffer), matched);
    if (source === 'web' && assignment) await logHistory(assignment.job_id, 'Added a ticket photo', '', assignment.driver_name || currentActor());
    return await getTicket(r.lastInsertRowid);
  }

  /** A ticket with its photo bytes in `data` (older tickets may only have a file in UPLOAD_DIR). */
  async function getTicket(id) {
    const t = await db.get('SELECT * FROM tickets WHERE id = ?', Number(id));
    if (!t) return null;
    if (t.data) t.data = Buffer.from(t.data);
    else {
      const file = path.join(uploadDir, t.filename);
      t.data = fs.existsSync(file) ? fs.readFileSync(file) : null;
    }
    return t;
  }

  async function ticketsForAssignment(assignmentId) {
    return await db.all('SELECT id, created_at, source FROM tickets WHERE assignment_id = ? ORDER BY id', assignmentId);
  }

  /** Photos texted in that couldn't be matched to a job — the office attaches them by hand. */
  async function unmatchedTickets() {
    return await db.all(`SELECT t.id, t.created_at, t.driver_id, d.name AS driver_name FROM tickets t
              LEFT JOIN drivers d ON d.id = t.driver_id WHERE t.job_id IS NULL ORDER BY t.id DESC LIMIT 50`);
  }

  async function attachTicket(ticketId, jobId) {
    const t = await getTicket(ticketId);
    if (!t) throw new ValidationError('Ticket not found');
    const a = t.driver_id ? await db.get('SELECT * FROM assignments WHERE job_id = ? AND driver_id = ?', Number(jobId), t.driver_id) : null;
    if (!await db.get('SELECT id FROM jobs WHERE id = ?', Number(jobId))) throw new ValidationError('Job not found');
    await db.run('UPDATE tickets SET job_id = ?, assignment_id = ? WHERE id = ?', Number(jobId), a?.id ?? null, t.id);
    return await getTicket(t.id);
  }

  async function deleteTicket(ticketId) {
    const t = await getTicket(ticketId);
    if (!t) return;
    await db.run('DELETE FROM tickets WHERE id = ?', t.id);
    fs.rmSync(path.join(uploadDir, t.filename), { force: true });
  }

  // ---------- settings ----------

  async function getSetting(key, fallback = '') {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? row.value : fallback;
  }

  async function setSetting(key, value) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  async function getSettings() {
    return {
      lineup_time: await getSetting('lineup_time', config.lineupTime || ''),
      septic_reminder_years: await getSetting('septic_reminder_years', '3'),
      required_fields: await requiredFields(),
    };
  }

  async function saveSettings(data) {
    if ('lineup_time' in data) {
      const t = str(data.lineup_time, 5);
      if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new ValidationError('Time must look like 17:00');
      await setSetting('lineup_time', t);
    }
    if ('required_fields' in data) await saveRequiredFields(data.required_fields);
    if ('septic_reminder_years' in data) {
      const y = Number(data.septic_reminder_years);
      if (![1, 2, 3, 4, 5].includes(y)) throw new ValidationError('Reminder interval must be 1 to 5 years');
      await setSetting('septic_reminder_years', String(y));
    }
    return await getSettings();
  }

  // ---------- day lineup ("tomorrow's jobs" text) ----------

  /** Per driver, their open jobs on `date`, in time order. */
  async function lineupFor(date) {
    const jobs = (await listJobs({ from: date, to: date })).filter((j) => j.status === 'open' && !Number(j.draft));
    const byDriver = new Map();
    for (const job of jobs) {
      for (const a of job.assignments) {
        if (a.status === 'cancelled' || a.status === 'done') continue;
        if (!byDriver.has(a.driver_id)) byDriver.set(a.driver_id, { driver_id: a.driver_id, name: a.driver_name, phone: a.driver_phone, items: [] });
        byDriver.get(a.driver_id).items.push({ job, assignment: a });
      }
    }
    return [...byDriver.values()];
  }

  async function lineupStatus(date) {
    const sent = await db.all(`SELECT driver_id, MAX(sent_at) AS sent_at FROM lineup_sends WHERE date = ? GROUP BY driver_id`, date);
    const drivers = await lineupFor(date);
    return {
      date,
      drivers: drivers.length,
      sent: sent.length,
      last_sent_at: sent.reduce((m, r) => (r.sent_at > m ? r.sent_at : m), '') || null,
    };
  }

  /**
   * Text each driver their whole day for `date`.
   * auto=true (the evening send) skips drivers who already got the lineup and have nothing new since.
   */
  async function sendLineup(date, { auto = false } = {}) {
    const results = [];
    for (const d of await lineupFor(date)) {
      if (auto) {
        const already = await db.get('SELECT 1 FROM lineup_sends WHERE date = ? AND driver_id = ?', date, d.driver_id);
        const somethingNew = d.items.some(({ assignment: a }) => a.status === 'pending' || a.needs_resend);
        if (already && !somethingNew) continue;
      }
      const res = await sendText(d.driver_id, d.phone, sms.buildLineupText(date, d.items),
        d.items.length === 1 ? d.items[0].assignment.id : null);
      if (res.ok) {
        for (const { assignment: a } of d.items) {
          if (a.status === 'pending' || a.needs_resend) await markTexted(a.id);
        }
        await db.run('INSERT INTO lineup_sends (date, driver_id, auto) VALUES (?, ?, ?)', date, d.driver_id, auto ? 1 : 0);
      }
      results.push({ driver: d.name, jobs: d.items.length, ...res });
    }
    return { date, results };
  }

  /**
   * Called every minute. Once the set time has passed each day, texts everyone their jobs for tomorrow.
   */
  async function runScheduledLineup() {
    const time = (await getSettings()).lineup_time;
    if (!time) return null;
    const day = today();
    if (nowHm() < time || await getSetting('lineup_auto_last') === day) return null;
    await setSetting('lineup_auto_last', day);
    return sendLineup(addDays(day, 1), { auto: true });
  }

  // ---------- records (search & export, e.g. for tax season) ----------

  /**
   * Work orders in a date range with drivers, trucks and photos attached, loaded in a few queries
   * so a whole year exports quickly. status: complete | open | cancelled | all.
   */
  async function findJobs({ from, to, status = 'complete', type = '', q = '', limit = 0 } = {}) {
    const where = ['scheduled_date BETWEEN ? AND ?'];
    const args = [from, to];
    if (['complete', 'open', 'cancelled'].includes(status)) { where.push('status = ?'); args.push(status); }
    if (JOB_TYPES.includes(type)) { where.push('job_type = ?'); args.push(type); }
    const term = str(q, 100).toLowerCase();
    if (term) {
      const like = `%${term}%`;
      const digits = term.replace(/\D/g, '');
      where.push(`(lower(customer) LIKE ? OR lower(to_location) LIKE ? OR lower(from_location) LIKE ? OR lower(municipality) LIKE ?
        OR lower(material) LIKE ? OR lower(po_number) LIKE ? OR CAST(id AS TEXT) = ? OR paper_wo = ?${digits.length >= 4 ? ' OR customer_phone LIKE ?' : ''})`);
      args.push(like, like, like, like, like, like, term.replace(/^#/, ''), term.replace(/^#/, ''));
      if (digits.length >= 4) args.push(`%${digits}%`);
    }
    const jobs = await db.all(`SELECT * FROM jobs WHERE ${where.join(' AND ')}
      ORDER BY scheduled_date, ${SLOT_ORDER('')}, id${limit ? ` LIMIT ${Number(limit)}` : ''}`, ...args);
    if (!jobs.length) return [];
    const byId = new Map(jobs.map((j) => [j.id, Object.assign(j, { details: parseJson(j.details), assignments: [], tickets: [] })]));
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const marks = chunk.map(() => '?').join(', ');
      for (const a of await db.all(`${ASSIGNMENT_SELECT} WHERE a.job_id IN (${marks}) ORDER BY d.name`, ...chunk)) {
        byId.get(a.job_id).assignments.push({ ...a, report: parseJson(a.report) });
      }
      for (const t of await db.all(`SELECT t.id, t.job_id, t.assignment_id, t.driver_id, t.source, t.created_at, d.name AS driver_name
          FROM tickets t LEFT JOIN drivers d ON d.id = t.driver_id WHERE t.job_id IN (${marks}) ORDER BY t.id`, ...chunk)) {
        byId.get(t.job_id).tickets.push(t);
      }
    }
    for (const j of jobs) {
      // When the work was finished: the last driver's "done", else when the job was marked complete.
      const done = j.assignments.map((a) => a.done_at).filter(Boolean).sort().pop();
      j.completed_at = j.status === 'complete' ? done || j.updated_at : null;
    }
    return jobs;
  }

  // ---------- dashboard ----------

  async function listMessages({ limit = 100, unhandledOnly = false } = {}) {
    return await db.all(`SELECT m.*, d.name AS driver_name, a.job_id FROM messages m
              LEFT JOIN drivers d ON d.id = m.driver_id
              LEFT JOIN assignments a ON a.id = m.assignment_id
              ${unhandledOnly ? "WHERE m.direction = 'in' AND m.handled = 0 AND m.seen = 0" : ''}
              ORDER BY m.id DESC LIMIT ?`, limit);
  }

  async function markMessagesSeen(ids) {
    for (const id of ids || []) await db.run('UPDATE messages SET seen = 1 WHERE id = ?', Number(id));
  }

  /** Everything the dispatch board needs for one day. */
  async function board(date) {
    const jobs = await listJobs({ from: date, to: date });
    const drivers = (await listDrivers()).map((d) => {
      const mine = jobs.filter((j) => j.status !== 'cancelled')
        .flatMap((j) => j.assignments.filter((a) => a.driver_id === d.id).map((a) => ({ job_id: j.id, status: a.status })));
      return { ...d, jobs: mine };
    });
    return {
      date,
      today: today(),
      jobs,
      drivers,
      trucks: await listTrucks(),
      alerts: await listMessages({ unhandledOnly: true, limit: 50 }),
      unmatched_tickets: await unmatchedTickets(),
      lineup: { ...(await lineupStatus(date)), auto_time: (await getSettings()).lineup_time },
      // Jobs from before today that were never marked done (missed DONEs, multi-day hauls).
      stale_jobs: await findJobs({ from: '0000-01-01', to: addDays(today(), -1), status: 'open', limit: 100 }),
    };
  }

  /** Move a job to another day (e.g. an unfinished job from yesterday onto today). Texted drivers get flagged for an update. */
  async function moveJob(jobId, date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new ValidationError('Pick a date');
    const job = await getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    if (job.status !== 'open') throw new ValidationError('Only open jobs can be moved');
    const assignments = job.assignments.filter((a) => a.status !== 'cancelled').map((a) => ({ driver_id: a.driver_id, truck_id: a.truck_id }));
    return (await saveJob({ ...job, scheduled_date: date, assignments })).job;
  }

  /** Previously used values, for autocomplete in the job form. */
  async function suggestions() {
    const col = async (c) => (await db.all(`SELECT ${c} AS v, COUNT(*) AS n FROM jobs WHERE ${c} != '' GROUP BY ${c} ORDER BY n DESC LIMIT 200`)).map((r) => r.v);
    const locations = [...new Set([...(await col('from_location')), ...(await col('to_location'))])];
    const materialsByType = {};
    for (const r of await db.all(`SELECT job_type, material, COUNT(*) AS n FROM jobs WHERE material != '' GROUP BY job_type, material ORDER BY n DESC LIMIT 500`)) {
      (materialsByType[r.job_type] ||= []).push(r.material);
    }
    return { customers: await col('customer'), materialsByType, locations, units: await col('unit'), municipalities: await col('municipality') };
  }

  return {
    listTrucks, saveTruck, listDrivers, saveDriver,
    getJob, listJobs, saveJob, sendJob, notifyRemoved, cancelJob, setJobStatus, duplicateJob, deleteJob,
    assignmentByToken, otherJobsForDriver, driverAction, handleInbound,
    saveReport, bookPickup, reportFields, findJobs, moveJob, logHistory, historyFor, customers, setJobLocation, geo, prices, onChange,
    saveTicket, getTicket, ticketsForAssignment, attachTicket, deleteTicket,
    getSettings, saveSettings, requiredFields, calendar, lineupFor, lineupStatus, sendLineup, runScheduledLineup,
    listMessages, markMessagesSeen, board, suggestions, today,
  };
}

module.exports = { createDispatch, reportFields, ValidationError, todayIn, nowHmIn, addDays, JOB_TYPES, TRUCK_KINDS, ACTIVE_STATUSES, IMAGE_TYPES, MAX_IMAGE_BYTES };
