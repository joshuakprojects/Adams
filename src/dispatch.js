const crypto = require('node:crypto');
const config = require('./config');
const { tx } = require('./db');
const sms = require('./sms');

const JOB_TYPES = ['haul', 'float', 'septic'];
const TRUCK_KINDS = ['haul', 'float', 'septic', 'other'];
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

function newToken() {
  return crypto.randomBytes(12).toString('base64url');
}

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));

const ASSIGNMENT_SELECT = `
  SELECT a.*, d.name AS driver_name, d.phone AS driver_phone, t.unit AS truck_unit, t.kind AS truck_kind
  FROM assignments a
  JOIN drivers d ON d.id = a.driver_id
  LEFT JOIN trucks t ON t.id = a.truck_id`;

/**
 * All dispatch business logic. `send(to, body)` is injectable so tests don't hit Twilio.
 */
function createDispatch(db, { send = sms.sendSms, today = todayIn } = {}) {
  const q = (sql) => db.prepare(sql);

  // ---------- drivers & trucks ----------

  function listTrucks({ includeInactive = false } = {}) {
    return q(`SELECT * FROM trucks ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY unit COLLATE NOCASE`).all();
  }

  function saveTruck(data) {
    const unit = str(data.unit, 40);
    if (!unit) throw new ValidationError('Truck unit number is required');
    const kind = TRUCK_KINDS.includes(data.kind) ? data.kind : 'haul';
    const description = str(data.description, 200);
    const active = data.active === false || data.active === 0 ? 0 : 1;
    try {
      if (data.id) {
        q('UPDATE trucks SET unit = ?, kind = ?, description = ?, active = ? WHERE id = ?')
          .run(unit, kind, description, active, Number(data.id));
        return q('SELECT * FROM trucks WHERE id = ?').get(Number(data.id));
      }
      const r = q('INSERT INTO trucks (unit, kind, description, active) VALUES (?, ?, ?, ?)').run(unit, kind, description, active);
      return q('SELECT * FROM trucks WHERE id = ?').get(r.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new ValidationError(`Truck ${unit} already exists`);
      throw err;
    }
  }

  function listDrivers({ includeInactive = false } = {}) {
    return q(`SELECT d.*, t.unit AS default_truck_unit FROM drivers d
              LEFT JOIN trucks t ON t.id = d.default_truck_id
              ${includeInactive ? '' : 'WHERE d.active = 1'}
              ORDER BY d.name COLLATE NOCASE`).all();
  }

  function saveDriver(data) {
    const name = str(data.name, 100);
    if (!name) throw new ValidationError('Driver name is required');
    const phone = sms.normalizePhone(data.phone);
    if (!phone) throw new ValidationError('Enter a valid 10-digit cell number');
    const truckId = data.default_truck_id ? Number(data.default_truck_id) : null;
    const active = data.active === false || data.active === 0 ? 0 : 1;
    const notes = str(data.notes, 500);
    try {
      if (data.id) {
        q('UPDATE drivers SET name = ?, phone = ?, default_truck_id = ?, active = ?, notes = ? WHERE id = ?')
          .run(name, phone, truckId, active, notes, Number(data.id));
        return q('SELECT * FROM drivers WHERE id = ?').get(Number(data.id));
      }
      const r = q('INSERT INTO drivers (name, phone, default_truck_id, active, notes) VALUES (?, ?, ?, ?, ?)')
        .run(name, phone, truckId, active, notes);
      return q('SELECT * FROM drivers WHERE id = ?').get(r.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new ValidationError('Another driver already has that phone number');
      throw err;
    }
  }

  // ---------- jobs ----------

  function assignmentsFor(jobId) {
    return q(`${ASSIGNMENT_SELECT} WHERE a.job_id = ? ORDER BY d.name COLLATE NOCASE`).all(jobId);
  }

  function getJob(id) {
    const job = q('SELECT * FROM jobs WHERE id = ?').get(Number(id));
    if (!job) return null;
    job.assignments = assignmentsFor(job.id);
    return job;
  }

  function listJobs({ from, to }) {
    const jobs = q(`SELECT * FROM jobs WHERE scheduled_date BETWEEN ? AND ?
                    ORDER BY scheduled_date, (scheduled_time = ''), scheduled_time, id`).all(from, to);
    for (const job of jobs) job.assignments = assignmentsFor(job.id);
    return jobs;
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
    return {
      job_type,
      customer: str(data.customer, 200),
      material: str(data.material, 200),
      quantity: str(data.quantity, 40),
      unit: str(data.unit, 40),
      loads_planned: loads || null,
      from_location: str(data.from_location, 300),
      to_location: str(data.to_location, 300),
      contact_name: str(data.contact_name, 100),
      contact_phone: sms.normalizePhone(contactRaw) || contactRaw,
      scheduled_date,
      scheduled_time,
      notes: str(data.notes, 1000),
    };
  }

  const JOB_FIELDS = ['job_type', 'customer', 'material', 'quantity', 'unit', 'loads_planned', 'from_location',
    'to_location', 'contact_name', 'contact_phone', 'scheduled_date', 'scheduled_time', 'notes'];

  function cleanAssignments(list) {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const driverId = Number(item.driver_id);
      if (!driverId || seen.has(driverId)) continue;
      const driver = q('SELECT id FROM drivers WHERE id = ?').get(driverId);
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
  function saveJob(data, userId = null) {
    const fields = cleanJob(data);
    const wanted = cleanAssignments(data.assignments);
    const removed = [];

    const jobId = tx(db, () => {
      let id = data.id ? Number(data.id) : null;
      if (id) {
        const before = q('SELECT * FROM jobs WHERE id = ?').get(id);
        if (!before) throw new ValidationError('Job not found');
        const changed = JOB_FIELDS.some((f) => String(before[f] ?? '') !== String(fields[f] ?? ''));
        q(`UPDATE jobs SET ${JOB_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
          .run(...JOB_FIELDS.map((f) => fields[f]), id);
        if (changed) {
          // Drivers who already have the old details need the update.
          q(`UPDATE assignments SET needs_resend = 1 WHERE job_id = ? AND status IN ('sent','acknowledged','in_progress')`).run(id);
        }
      } else {
        const r = q(`INSERT INTO jobs (${JOB_FIELDS.join(', ')}, created_by) VALUES (${JOB_FIELDS.map(() => '?').join(', ')}, ?)`)
          .run(...JOB_FIELDS.map((f) => fields[f]), userId);
        id = Number(r.lastInsertRowid);
      }

      const existing = q(`${ASSIGNMENT_SELECT} WHERE a.job_id = ?`).all(id);
      const wantedIds = new Set(wanted.map((w) => w.driver_id));
      for (const a of existing) {
        if (!wantedIds.has(a.driver_id)) {
          if (a.status !== 'pending' && a.status !== 'cancelled') removed.push(a);
          q('DELETE FROM assignments WHERE id = ?').run(a.id);
        }
      }
      for (const w of wanted) {
        const cur = existing.find((a) => a.driver_id === w.driver_id);
        if (cur) {
          if ((cur.truck_id || null) !== w.truck_id) {
            q(`UPDATE assignments SET truck_id = ?,
                 needs_resend = CASE WHEN status IN ('sent','acknowledged','in_progress') THEN 1 ELSE needs_resend END
               WHERE id = ?`).run(w.truck_id, cur.id);
          }
        } else {
          q('INSERT INTO assignments (job_id, driver_id, truck_id, token) VALUES (?, ?, ?, ?)')
            .run(id, w.driver_id, w.truck_id, newToken());
        }
      }
      return id;
    });

    return { job: getJob(jobId), removed };
  }

  async function sendText(driverId, phone, body, assignmentId = null) {
    try {
      const result = await send(phone, body);
      q(`INSERT INTO messages (driver_id, assignment_id, direction, phone, body, provider_sid) VALUES (?, ?, 'out', ?, ?, ?)`)
        .run(driverId, assignmentId, phone, body, result?.sid || null);
      return { ok: true };
    } catch (err) {
      q(`INSERT INTO messages (driver_id, assignment_id, direction, phone, body, error) VALUES (?, ?, 'out', ?, ?, ?)`)
        .run(driverId, assignmentId, phone, body, String(err.message || err));
      return { ok: false, error: String(err.message || err) };
    }
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
    const job = getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    if (job.status === 'cancelled') throw new ValidationError('Job is cancelled');
    const targets = job.assignments.filter((a) =>
      assignmentId ? a.id === Number(assignmentId) : a.status === 'pending' || a.needs_resend);
    const results = [];
    for (const a of targets) {
      if (a.status === 'done' && !assignmentId) continue;
      const updated = a.status !== 'pending';
      const res = await sendText(a.driver_id, a.driver_phone, sms.buildJobText(job, a, { updated }), a.id);
      if (res.ok) {
        // A changed job needs a fresh confirmation, unless the driver is already working it.
        q(`UPDATE assignments SET needs_resend = 0, sent_at = datetime('now'),
             status = CASE WHEN status IN ('pending','sent','acknowledged') THEN 'sent' ELSE status END,
             ack_at = CASE WHEN status IN ('pending','sent','acknowledged') THEN NULL ELSE ack_at END,
             ack_via = CASE WHEN status IN ('pending','sent','acknowledged') THEN NULL ELSE ack_via END
           WHERE id = ?`).run(a.id);
      }
      results.push({ assignment_id: a.id, driver: a.driver_name, ...res });
    }
    return { job: getJob(jobId), results };
  }

  async function cancelJob(jobId) {
    const job = getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    q(`UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(job.id);
    for (const a of job.assignments) {
      if (a.status !== 'pending' && a.status !== 'done' && a.status !== 'cancelled') {
        await sendText(a.driver_id, a.driver_phone, sms.buildCancelText(job), a.id);
      }
    }
    q(`UPDATE assignments SET status = 'cancelled', needs_resend = 0 WHERE job_id = ? AND status != 'done'`).run(job.id);
    return getJob(job.id);
  }

  function setJobStatus(jobId, status) {
    if (!['open', 'complete'].includes(status)) throw new ValidationError('Bad status');
    const job = getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    if (job.status === 'cancelled' && status === 'open') {
      // Reopening a cancelled job: drivers go back to "not texted yet".
      q(`UPDATE assignments SET status = 'pending', needs_resend = 0, sent_at = NULL, ack_at = NULL WHERE job_id = ? AND status = 'cancelled'`).run(job.id);
    }
    q(`UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, job.id);
    return getJob(job.id);
  }

  /** Copy a job (with the same drivers) to another date — for "same run again tomorrow". */
  function duplicateJob(jobId, date, userId = null) {
    const job = getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    const copy = { ...job, id: null, scheduled_date: date || job.scheduled_date };
    copy.assignments = job.assignments.map((a) => ({ driver_id: a.driver_id, truck_id: a.truck_id }));
    return saveJob(copy, userId).job;
  }

  function deleteJob(jobId) {
    q('DELETE FROM jobs WHERE id = ?').run(Number(jobId));
  }

  // ---------- driver side ----------

  function assignmentByToken(token) {
    const a = q(`${ASSIGNMENT_SELECT} WHERE a.token = ?`).get(String(token || ''));
    if (!a) return null;
    a.job = q('SELECT * FROM jobs WHERE id = ?').get(a.job_id);
    return a;
  }

  /** Other upcoming jobs for the same driver, so the job page can link between them. */
  function otherJobsForDriver(driverId, excludeAssignmentId) {
    return q(`SELECT a.token, a.status, j.id AS job_id, j.job_type, j.scheduled_date, j.scheduled_time, j.material, j.to_location
              FROM assignments a JOIN jobs j ON j.id = a.job_id
              WHERE a.driver_id = ? AND a.id != ? AND j.status = 'open' AND j.scheduled_date >= ?
                AND a.status IN ('sent','acknowledged','in_progress')
              ORDER BY j.scheduled_date, j.scheduled_time LIMIT 10`).all(driverId, excludeAssignmentId, today());
  }

  /**
   * Button presses from the driver's job page.
   * ack: "Got it"   load: +1 load   unload: undo a load   done: finished   reopen: undo finished
   */
  function driverAction(token, action, via = 'web') {
    const a = assignmentByToken(token);
    if (!a) throw new ValidationError('Job not found');
    if (a.status === 'cancelled' || a.job.status === 'cancelled') throw new ValidationError('This job was cancelled');
    switch (action) {
      case 'ack':
        if (a.status === 'pending' || a.status === 'sent') {
          q(`UPDATE assignments SET status = 'acknowledged', ack_at = datetime('now'), ack_via = ? WHERE id = ?`).run(via, a.id);
        }
        break;
      case 'load':
        q(`UPDATE assignments SET loads_done = loads_done + 1,
             status = CASE WHEN status = 'done' THEN status ELSE 'in_progress' END,
             ack_at = COALESCE(ack_at, datetime('now')), ack_via = COALESCE(ack_via, ?),
             started_at = COALESCE(started_at, datetime('now'))
           WHERE id = ?`).run(via, a.id);
        break;
      case 'unload':
        q('UPDATE assignments SET loads_done = MAX(loads_done - 1, 0) WHERE id = ?').run(a.id);
        break;
      case 'done':
        q(`UPDATE assignments SET status = 'done', done_at = datetime('now'),
             ack_at = COALESCE(ack_at, datetime('now')), ack_via = COALESCE(ack_via, ?)
           WHERE id = ?`).run(via, a.id);
        autoCompleteJob(a.job_id);
        break;
      case 'reopen':
        q(`UPDATE assignments SET status = CASE WHEN loads_done > 0 THEN 'in_progress' ELSE 'acknowledged' END, done_at = NULL WHERE id = ?`).run(a.id);
        q(`UPDATE jobs SET status = 'open' WHERE id = ? AND status = 'complete'`).run(a.job_id);
        break;
      default:
        throw new ValidationError('Unknown action');
    }
    return assignmentByToken(token);
  }

  /** When every driver on a job is done, the job is complete. */
  function autoCompleteJob(jobId) {
    const left = q(`SELECT COUNT(*) AS n FROM assignments WHERE job_id = ? AND status NOT IN ('done','cancelled')`).get(jobId).n;
    if (left === 0) q(`UPDATE jobs SET status = 'complete', updated_at = datetime('now') WHERE id = ? AND status = 'open'`).run(jobId);
  }

  // ---------- inbound texts ----------

  function logInbound(phone, body, driverId, assignmentId, handled) {
    q(`INSERT INTO messages (driver_id, assignment_id, direction, phone, body, handled) VALUES (?, ?, 'in', ?, ?, ?)`)
      .run(driverId, assignmentId, phone, body, handled ? 1 : 0);
  }

  function logAutoReply(driver, body, assignmentId = null) {
    q(`INSERT INTO messages (driver_id, assignment_id, direction, phone, body) VALUES (?, ?, 'out', ?, ?)`)
      .run(driver.id, assignmentId, driver.phone, body);
  }

  const jobLabel = (a) => `#${a.job_id} (${sms.formatDate(a.scheduled_date)}${a.scheduled_time ? ' ' + sms.formatTime(a.scheduled_time) : ''})`;

  /**
   * A driver texted us. Understands OK / DONE (optionally with a job number); anything else is
   * flagged on the dashboard for the office. Returns { reply } — the text to send back, if any.
   */
  function handleInbound(fromRaw, bodyRaw) {
    const phone = sms.normalizePhone(fromRaw) || String(fromRaw || '');
    const body = String(bodyRaw || '').trim().slice(0, 1600);
    const driver = q('SELECT * FROM drivers WHERE phone = ?').get(phone);
    if (!driver) {
      logInbound(phone, body, null, null, false);
      return { reply: null };
    }

    const { action, jobId } = sms.parseReply(body);
    const open = q(`${ASSIGNMENT_SELECT.replace('SELECT a.*', 'SELECT a.*, j.scheduled_date, j.scheduled_time')}
                    JOIN jobs j ON j.id = a.job_id
                    WHERE a.driver_id = ? AND j.status = 'open' AND a.status IN ('sent','acknowledged','in_progress')
                    ORDER BY j.scheduled_date, (j.scheduled_time = ''), j.scheduled_time, j.id`).all(driver.id);
    const first = driver.name.split(' ')[0];
    const finish = (reply, assignmentId, handled = true) => {
      logInbound(phone, body, driver.id, assignmentId, handled);
      if (reply) logAutoReply(driver, reply, assignmentId);
      return { reply };
    };

    if (action === 'ack') {
      let targets = open.filter((a) => a.status === 'sent');
      if (jobId) targets = open.filter((a) => a.job_id === jobId);
      if (!targets.length) {
        if (jobId) return finish(`Couldn't find an open Job #${jobId} for you. Call dispatch if that's wrong.`, null, false);
        return finish(open.length ? `Thanks ${first} - your jobs are already confirmed.` : null, null, true);
      }
      for (const a of targets) {
        if (a.status === 'sent') {
          q(`UPDATE assignments SET status = 'acknowledged', ack_at = datetime('now'), ack_via = 'sms' WHERE id = ?`).run(a.id);
        }
      }
      const label = targets.length === 1 ? `Job ${jobLabel(targets[0])}` : `Jobs ${targets.map(jobLabel).join(', ')}`;
      return finish(`Thanks ${first} - ${label} confirmed.`, targets.length === 1 ? targets[0].id : null);
    }

    if (action === 'done') {
      let target;
      if (jobId) {
        target = open.find((a) => a.job_id === jobId);
        if (!target) return finish(`Couldn't find an open Job #${jobId} for you. Call dispatch if that's wrong.`, null, false);
      } else {
        const current = open.filter((a) => a.scheduled_date <= today());
        target = current.find((a) => a.status === 'in_progress') || current[0];
        if (!target) return finish(`No job today to mark done. Reply DONE and the job number, e.g. DONE ${open[0]?.job_id || 1042}`, null, false);
      }
      q(`UPDATE assignments SET status = 'done', done_at = datetime('now'),
           ack_at = COALESCE(ack_at, datetime('now')), ack_via = COALESCE(ack_via, 'sms') WHERE id = ?`).run(target.id);
      autoCompleteJob(target.job_id);
      const others = open.filter((a) => a.id !== target.id && a.scheduled_date <= today()).length;
      const hint = others ? ` Wrong job? Reply DONE and the job number.` : '';
      return finish(`Thanks ${first} - Job ${jobLabel(target)} marked DONE.${hint}`, target.id);
    }

    // Not an OK/DONE: put it in front of the office.
    if (sms.SMALL_TALK.test(body)) return finish(null, open[0]?.id || null, true);
    const linked = jobId ? open.find((a) => a.job_id === jobId) : open.length === 1 ? open[0] : null;
    return finish(null, linked?.id || null, false);
  }

  // ---------- dashboard ----------

  function listMessages({ limit = 100, unhandledOnly = false } = {}) {
    return q(`SELECT m.*, d.name AS driver_name, a.job_id FROM messages m
              LEFT JOIN drivers d ON d.id = m.driver_id
              LEFT JOIN assignments a ON a.id = m.assignment_id
              ${unhandledOnly ? "WHERE m.direction = 'in' AND m.handled = 0 AND m.seen = 0" : ''}
              ORDER BY m.id DESC LIMIT ?`).all(limit);
  }

  function markMessagesSeen(ids) {
    const stmt = q('UPDATE messages SET seen = 1 WHERE id = ?');
    for (const id of ids || []) stmt.run(Number(id));
  }

  /** Everything the dispatch board needs for one day. */
  function board(date) {
    const jobs = listJobs({ from: date, to: date });
    const drivers = listDrivers().map((d) => {
      const mine = jobs.filter((j) => j.status !== 'cancelled')
        .flatMap((j) => j.assignments.filter((a) => a.driver_id === d.id).map((a) => ({ job_id: j.id, status: a.status })));
      return { ...d, jobs: mine };
    });
    return {
      date,
      today: today(),
      jobs,
      drivers,
      trucks: listTrucks(),
      alerts: listMessages({ unhandledOnly: true, limit: 50 }),
    };
  }

  /** Previously used values, for autocomplete in the job form. */
  function suggestions() {
    const col = (c) => q(`SELECT ${c} AS v, COUNT(*) AS n FROM jobs WHERE ${c} != '' GROUP BY ${c} ORDER BY n DESC LIMIT 200`).all().map((r) => r.v);
    const locations = [...new Set([...col('from_location'), ...col('to_location')])];
    return { customers: col('customer'), materials: col('material'), locations, units: col('unit') };
  }

  return {
    listTrucks, saveTruck, listDrivers, saveDriver,
    getJob, listJobs, saveJob, sendJob, notifyRemoved, cancelJob, setJobStatus, duplicateJob, deleteJob,
    assignmentByToken, otherJobsForDriver, driverAction, handleInbound,
    listMessages, markMessagesSeen, board, suggestions, today,
  };
}

module.exports = { createDispatch, ValidationError, todayIn, JOB_TYPES, TRUCK_KINDS, ACTIVE_STATUSES };
