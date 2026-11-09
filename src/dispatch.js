const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const sms = require('./sms');
const FORMS = require('../public/forms');

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
    const name = str(data.name, 100);
    if (!name) throw new ValidationError('Driver name is required');
    const phone = sms.normalizePhone(data.phone);
    if (!phone) throw new ValidationError('Enter a valid 10-digit cell number');
    const truckId = data.default_truck_id ? Number(data.default_truck_id) : null;
    const active = data.active === false || data.active === 0 ? 0 : 1;
    const notes = str(data.notes, 500);
    try {
      if (data.id) {
        await db.run('UPDATE drivers SET name = ?, phone = ?, default_truck_id = ?, active = ?, notes = ? WHERE id = ?', name, phone, truckId, active, notes, Number(data.id));
        return await db.get('SELECT * FROM drivers WHERE id = ?', Number(data.id));
      }
      const r = await db.run('INSERT INTO drivers (name, phone, default_truck_id, active, notes) VALUES (?, ?, ?, ?, ?)', name, phone, truckId, active, notes);
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
              ORDER BY scheduled_date, first_thing DESC, (scheduled_time = ''), scheduled_time, id`, from, to);
    return Promise.all(rows.map(hydrate));
  }

  function cleanJob(data) {
    const job_type = JOB_TYPES.includes(data.job_type) ? data.job_type : 'haul';
    const scheduled_date = str(data.scheduled_date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) throw new ValidationError('Pick a date for the job');
    const scheduled_time = str(data.scheduled_time, 5);
    if (scheduled_time && !/^\d{2}:\d{2}$/.test(scheduled_time)) throw new ValidationError('Time must look like 07:30');
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
      scheduled_time,
      first_thing: data.first_thing === true || data.first_thing === 1 || data.first_thing === '1' || data.first_thing === 'on' ? 1 : 0,
      notes: str(data.notes, 1000),
    };
  }

  const JOB_FIELDS = ['job_type', 'customer', 'material', 'quantity', 'unit', 'loads_planned', 'from_location',
    'to_location', 'contact_name', 'contact_phone', 'scheduled_date', 'scheduled_time', 'first_thing', 'notes',
    'customer_phone', 'customer_email', 'billing_address', 'po_number', 'municipality', 'paper_wo',
    'quoted_price', 'payment_method', 'details'];
  // Office-only fields (drivers never see them; payments are handled by the office): changing these doesn't need a new text.
  const OFFICE_ONLY = new Set(['customer_email', 'billing_address', 'po_number', 'paper_wo', 'quoted_price', 'payment_method']);

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
  async function saveJob(data, userId = null) {
    const fields = cleanJob(data);
    const wanted = await cleanAssignments(data.assignments);
    const removed = [];

    const jobId = await db.tx(async (t) => {
      let id = data.id ? Number(data.id) : null;
      if (id) {
        const before = await t.get('SELECT * FROM jobs WHERE id = ?', id);
        if (!before) throw new ValidationError('Job not found');
        const changed = JOB_FIELDS.some((f) => !OFFICE_ONLY.has(f) && String(before[f] ?? '') !== String(fields[f] ?? ''));
        const sets = JOB_FIELDS.map((f) => `${f} = ?`).join(', ');
        await t.run(`UPDATE jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`, ...JOB_FIELDS.map((f) => fields[f]), id);
        if (changed) {
          // Drivers who already have the old details need the update.
          await t.run(`UPDATE assignments SET needs_resend = 1 WHERE job_id = ? AND status IN ('sent','acknowledged','in_progress')`, id);
        }
      } else {
        const marks = JOB_FIELDS.map(() => '?').join(', ');
        const r = await t.run(`INSERT INTO jobs (${JOB_FIELDS.join(', ')}, created_by) VALUES (${marks}, ?)`, ...JOB_FIELDS.map((f) => fields[f]), userId);
        id = Number(r.lastInsertRowid);
      }

      const existing = await t.all(`${ASSIGNMENT_SELECT} WHERE a.job_id = ?`, id);
      const wantedIds = new Set(wanted.map((w) => w.driver_id));
      for (const a of existing) {
        if (!wantedIds.has(a.driver_id)) {
          if (a.status !== 'pending' && a.status !== 'cancelled') removed.push(a);
          await t.run('DELETE FROM assignments WHERE id = ?', a.id);
        }
      }
      for (const w of wanted) {
        const cur = existing.find((a) => a.driver_id === w.driver_id);
        if (cur) {
          if ((cur.truck_id || null) !== w.truck_id) {
            await t.run(`UPDATE assignments SET truck_id = ?,
                 needs_resend = CASE WHEN status IN ('sent','acknowledged','in_progress') THEN 1 ELSE needs_resend END
               WHERE id = ?`, w.truck_id, cur.id);
          }
        } else {
          await t.run('INSERT INTO assignments (job_id, driver_id, truck_id, token) VALUES (?, ?, ?, ?)', id, w.driver_id, w.truck_id, newToken());
        }
      }
      return id;
    });

    return { job: await getJob(jobId), removed };
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
    if (job.status === 'cancelled') throw new ValidationError('Job is cancelled');
    const targets = job.assignments.filter((a) =>
      assignmentId ? a.id === Number(assignmentId) : a.status === 'pending' || a.needs_resend);
    const results = [];
    for (const a of targets) {
      if (a.status === 'done' && !assignmentId) continue;
      const updated = a.status !== 'pending';
      const res = await sendText(a.driver_id, a.driver_phone, sms.buildJobText(job, a, { updated }), a.id);
      if (res.ok) await markTexted(a.id);
      results.push({ assignment_id: a.id, driver: a.driver_name, ...res });
    }
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
    return await getJob(job.id);
  }

  /** Copy a job (with the same drivers) to another date — for "same run again tomorrow". */
  async function duplicateJob(jobId, date, userId = null) {
    const job = await getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    const copy = { ...job, id: null, scheduled_date: date || job.scheduled_date, paper_wo: '' };
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
      ...job, id: null, scheduled_date: when, scheduled_time: '', first_thing: 0, paper_wo: '', details,
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
    return await assignmentByToken(token);
  }

  /** Other upcoming jobs for the same driver, so the job page can link between them. */
  async function otherJobsForDriver(driverId, excludeAssignmentId) {
    return await db.all(`SELECT a.token, a.status, j.id AS job_id, j.job_type, j.scheduled_date, j.scheduled_time, j.first_thing, j.material, j.to_location
              FROM assignments a JOIN jobs j ON j.id = a.job_id
              WHERE a.driver_id = ? AND a.id != ? AND j.status = 'open' AND j.scheduled_date >= ?
                AND a.status IN ('sent','acknowledged','in_progress')
              ORDER BY j.scheduled_date, j.first_thing DESC, (j.scheduled_time = ''), j.scheduled_time LIMIT 10`, driverId, excludeAssignmentId, today());
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
    return await assignmentByToken(token);
  }

  /** When every driver on a job is done, the job is complete. */
  async function autoCompleteJob(jobId) {
    const left = (await db.get(`SELECT COUNT(*) AS n FROM assignments WHERE job_id = ? AND status NOT IN ('done','cancelled')`, jobId)).n;
    if (left === 0) await db.run(`UPDATE jobs SET status = 'complete', updated_at = datetime('now') WHERE id = ? AND status = 'open'`, jobId);
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

    const { action, jobId } = sms.parseReply(body);
    const open = await db.all(`${ASSIGNMENT_SELECT.replace('SELECT a.*', 'SELECT a.*, j.scheduled_date, j.scheduled_time, j.first_thing')}
                    JOIN jobs j ON j.id = a.job_id
                    WHERE a.driver_id = ? AND j.status = 'open' AND a.status IN ('sent','acknowledged','in_progress')
                    ORDER BY j.scheduled_date, j.first_thing DESC, (j.scheduled_time = ''), j.scheduled_time, j.id`, driver.id);
    const first = driver.name.split(' ')[0];
    const finish = async (reply, assignmentId, handled = true) => {
      await logInbound(phone, body || '[photo]', driver.id, assignmentId, handled);
      if (reply) await logAutoReply(driver, reply, assignmentId);
      return { reply };
    };

    // The job a driver most likely means: the one they named, else today's job in progress, else today's first.
    const currentJob = () => {
      if (jobId) return open.find((a) => a.job_id === jobId) || null;
      const current = open.filter((a) => a.scheduled_date <= today());
      return current.find((a) => a.status === 'in_progress') || current[0] || null;
    };

    // A texted photo is a scale ticket for the current job.
    if (media.length) {
      const target = currentJob();
      for (const m of media) {
        await saveTicket({ driverId: driver.id, assignment: target, buffer: m.buffer, contentType: m.contentType, source: 'sms' });
      }
      const n = media.length === 1 ? 'ticket photo' : `${media.length} ticket photos`;
      if (!target) {
        if (!body) body = '[photo - no job today to attach it to]';
        return finish(`Got your ${n}, but couldn't tell which job it's for. Dispatch will sort it out.`, null, false);
      }
      if (!action) {
        if (body && !sms.SMALL_TALK.test(body)) {
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
        }
      }
      const label = targets.length === 1 ? `Job ${jobLabel(targets[0])}` : `Jobs ${targets.map(jobLabel).join(', ')}`;
      return finish(`Thanks ${first} - ${label} confirmed.`, targets.length === 1 ? targets[0].id : null);
    }

    if (action === 'done') {
      const target = currentJob();
      if (!target) {
        if (jobId) return finish(`Couldn't find an open Job #${jobId} for you. Call dispatch if that's wrong.`, null, false);
        return finish(`No job today to mark done. Reply DONE and the job number, e.g. DONE ${open[0]?.job_id || 1042}`, null, false);
      }
      await db.run(`UPDATE assignments SET status = 'done', done_at = datetime('now'),
           ack_at = COALESCE(ack_at, datetime('now')), ack_via = COALESCE(ack_via, 'sms') WHERE id = ?`, target.id);
      await autoCompleteJob(target.job_id);
      const others = open.filter((a) => a.id !== target.id && a.scheduled_date <= today()).length;
      const hint = others ? ` Wrong job? Reply DONE and the job number.` : '';
      return finish(`Thanks ${first} - Job ${jobLabel(target)} marked DONE.${hint}`, target.id);
    }

    // Not an OK/DONE: put it in front of the office.
    if (sms.SMALL_TALK.test(body)) return finish(null, open[0]?.id || null, true);
    const linked = jobId ? open.find((a) => a.job_id === jobId) : open.length === 1 ? open[0] : null;
    return finish(null, linked?.id || null, false);
  }

  // ---------- scale tickets ----------

  async function ticketsFor(jobId) {
    return await db.all(`SELECT t.id, t.assignment_id, t.driver_id, t.source, t.created_at, d.name AS driver_name
              FROM tickets t LEFT JOIN drivers d ON d.id = t.driver_id
              WHERE t.job_id = ? ORDER BY t.id`, jobId);
  }

  /** Save a ticket photo. `assignment` may be null (photo texted with no job to match). */
  async function saveTicket({ driverId = null, assignment = null, buffer, contentType, source = 'web' }) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) throw new ValidationError('Only photos can be uploaded');
    if (!buffer || !buffer.length) throw new ValidationError('The photo was empty');
    if (buffer.length > MAX_IMAGE_BYTES) throw new ValidationError('That photo is too big');
    // Stored in the database (not on disk) so photos survive a republish on Replit.
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const r = await db.run(`INSERT INTO tickets (assignment_id, job_id, driver_id, filename, content_type, source, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      assignment?.id ?? null, assignment?.job_id ?? null, driverId ?? assignment?.driver_id ?? null, filename, type, source, Buffer.from(buffer));
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
    return { lineup_time: await getSetting('lineup_time', config.lineupTime || '') };
  }

  async function saveSettings(data) {
    if ('lineup_time' in data) {
      const t = str(data.lineup_time, 5);
      if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new ValidationError('Time must look like 17:00');
      await setSetting('lineup_time', t);
    }
    return await getSettings();
  }

  // ---------- day lineup ("tomorrow's jobs" text) ----------

  /** Per driver, their open jobs on `date`, in time order. */
  async function lineupFor(date) {
    const jobs = (await listJobs({ from: date, to: date })).filter((j) => j.status === 'open');
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
    };
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
    saveReport, bookPickup, reportFields,
    saveTicket, getTicket, ticketsForAssignment, attachTicket, deleteTicket,
    getSettings, saveSettings, lineupFor, lineupStatus, sendLineup, runScheduledLineup,
    listMessages, markMessagesSeen, board, suggestions, today,
  };
}

module.exports = { createDispatch, reportFields, ValidationError, todayIn, nowHmIn, addDays, JOB_TYPES, TRUCK_KINDS, ACTIVE_STATUSES, IMAGE_TYPES, MAX_IMAGE_BYTES };
