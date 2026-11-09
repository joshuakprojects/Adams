// Orders from the website (joshtemp.site / adamsbros.ca) land here as "requests".
// The office reviews each one and clicks Schedule, which opens the matching work order already filled in.
// The JSON the website sends is described in docs/website-integration.md.
const crypto = require('node:crypto');
const sms = require('./sms');

const SERVICES = ['septic', 'aggregate', 'bin', 'toilet', 'quote', 'other'];
const STATUSES = ['new', 'scheduled', 'declined', 'duplicate'];
const SERVICE_NAMES = {
  septic: 'Septic pump-out', aggregate: 'Aggregate order', bin: 'Roll-off bin', toilet: 'Portable toilet',
  quote: 'Quote request', other: 'Website request',
};

class IntakeError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const low = (v) => str(v).toLowerCase();
const isTrue = (v) => v === true || ['true', 'yes', 'y', '1', 'on'].includes(low(v));

/** Accept "septic" / "Septic Pumping" / "septic-pumping" etc. */
function normalizeService(v) {
  const s = low(v);
  if (/septic|pump/.test(s)) return 'septic';
  if (/aggregate|gravel|sand|soil|stone|topsoil/.test(s)) return 'aggregate';
  if (/bin|roll.?off|dumpster/.test(s)) return 'bin';
  if (/toilet|porta|washroom/.test(s)) return 'toilet';
  if (/quote/.test(s)) return 'quote';
  return 'other';
}

function money(v) {
  if (v === '' || v == null) return '';
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : str(v, 40);
}

function ymd(v) {
  const s = str(v, 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return s && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

/** Yes / No / '' ("not sure") from website answers like "yes", "No — normal truck access", "not_sure". */
function yesNo(v) {
  const s = low(v);
  if (!s || /not.?sure|unsure|unknown/.test(s)) return '';
  if (/^(y|yes|true)/.test(s)) return 'Yes';
  if (/^(n|no|false)/.test(s)) return 'No';
  return '';
}

/** Turn whatever the website sent into a stored request row. Throws IntakeError on unusable input. */
function normalizePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IntakeError('Send a JSON object');
  const customer = body.customer || {};
  const location = body.location || {};
  const name = str(customer.name || body.name, 200);
  const phoneRaw = str(customer.phone || body.phone, 40);
  if (!name && !phoneRaw && !str(customer.email || body.email)) throw new IntakeError('A customer name, phone or email is required');
  const details = body.details && typeof body.details === 'object' ? body.details : {};
  const estimate = body.estimate && typeof body.estimate === 'object' ? body.estimate : {};
  return {
    external_id: str(body.id || body.external_id, 120) || null,
    service: SERVICES.includes(body.service) ? body.service : normalizeService(body.service),
    customer_name: name,
    phone: sms.normalizePhone(phoneRaw) || phoneRaw,
    email: str(customer.email || body.email, 200),
    billing_address: str(customer.billing_address || body.billing_address, 500),
    address: str(location.address || body.address, 300),
    municipality: str(location.municipality || body.municipality, 100),
    requested_date: ymd(body.requested_date),
    estimate_total: money(estimate.total),
    notes: str(body.notes, 2000),
    payload: JSON.stringify(body).slice(0, 50000),
  };
}

/** A one-line description for the inbox. */
function summarize(service, d) {
  switch (service) {
    case 'septic':
      return [septicTankType(d.system_type) || 'Tank', d.tank_size_gallons && `${d.tank_size_gallons} gal`,
        /alternate/.test(low(d.scheduling)) ? 'alternate date' : d.scheduling && 'next regular route'].filter(Boolean).join(' · ');
    case 'aggregate':
      return [d.material, [d.quantity, d.unit].filter(Boolean).join(' '), /pick/.test(low(d.fulfillment)) ? 'CUSTOMER PICKUP' : 'delivery']
        .filter(Boolean).join(' · ');
    case 'bin':
      return [d.bin_size, binService(d.service)].filter(Boolean).join(' · ');
    case 'toilet':
      return (Array.isArray(d.toilets) ? d.toilets : []).map((t) => `${t.qty || 1}× ${t.type || 'toilet'}`).join(', ') || 'Portable toilet';
    default:
      return str(d.service_name || d.description, 120);
  }
}

function septicTankType(v) {
  const s = low(v);
  if (/hold/.test(s)) return 'Holding';
  if (/chamber/.test(s)) return 'Pump chamber';
  if (/septic/.test(s)) return 'Septic';
  return '';
}

function binService(v) {
  const s = low(v);
  if (/no.?return/.test(s)) return 'Empty & no return';
  if (/return/.test(s)) return 'Empty & return';
  if (/h.?&.?g|haul.?and.?go|h_g/.test(s)) return 'H&G';
  if (/deliver|drop/.test(s)) return 'Deliver bin';
  return '';
}

/** Readable "label: value" list of everything the website sent in `details`, for the inbox and job notes. */
function detailLines(d) {
  const out = [];
  for (const [k, v] of Object.entries(d || {})) {
    if (v === '' || v == null || v === false) continue;
    const label = k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    if (Array.isArray(v)) out.push(`${label}: ${v.map((x) => (typeof x === 'object' ? Object.values(x).join(' ') : x)).join(', ')}`);
    else if (typeof v === 'object') out.push(`${label}: ${Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ')}`);
    else out.push(`${label}: ${v === true ? 'Yes' : String(v).replace(/_/g, ' ')}`);
  }
  return out;
}

/**
 * What the job form should be filled in with when the office clicks Schedule.
 * Anything without a matching box goes into the special instructions so nothing is lost.
 */
function toJobPrefill(r, today) {
  const body = JSON.parse(r.payload || '{}');
  const d = body.details || {};
  const extra = [];
  const job = {
    customer: r.customer_name,
    customer_phone: r.phone,
    customer_email: r.email,
    billing_address: r.billing_address,
    to_location: r.address,
    municipality: r.municipality,
    scheduled_date: r.requested_date || today,
    quoted_price: r.estimate_total ? `${r.estimate_total} (website estimate)` : '',
    details: {},
    assignments: [],
    request_id: r.id,
  };
  switch (r.service) {
    case 'septic': {
      job.job_type = 'septic';
      job.details = {
        tank_type: septicTankType(d.system_type),
        tank_size: d.tank_size_gallons ? `${d.tank_size_gallons} gal` : str(d.tank_size, 60),
        lids_uncovered: /uncover|access|^yes/.test(low(d.lids)) ? 'Yes' : /dig|locat|^no/.test(low(d.lids)) ? 'No' : '',
        steep_driveway: yesNo(d.steep_driveway),
      };
      if (/not.?sure/.test(low(d.lids))) extra.push('Lids: customer not sure if uncovered');
      if (/dig|locat/.test(low(d.lids))) extra.push('Lids need locating / digging');
      if (/not.?sure/.test(low(d.steep_driveway))) extra.push('Driveway: customer not sure if steep');
      if (yesNo(d.air_attachments) === 'Yes') extra.push('Air attachments previously required');
      else if (/not.?sure/.test(low(d.air_attachments))) extra.push('Air attachments: customer not sure');
      if (isTrue(d.add_pump_chamber)) extra.push('ALSO PUMP THE PUMP CHAMBER');
      if (isTrue(d.ecoethic)) extra.push('EcoEthic septic powder requested');
      if (/alternate/.test(low(d.scheduling))) extra.push(`Customer asked for a specific date${r.requested_date ? ` (${sms.formatDate(r.requested_date)})` : ''}`);
      else if (d.scheduling) extra.push('Next regular route');
      break;
    }
    case 'aggregate': {
      job.job_type = 'haul';
      job.material = str(d.material, 200);
      const unit = low(d.unit);
      if (/load/.test(unit)) job.loads_planned = Number(d.quantity) || null;
      else if (d.quantity) job.quantity = str(d.quantity, 40);
      if (d.quantity && !/load|yard/.test(unit) && unit) extra.push(`Customer ordered ${d.quantity} ${d.unit}`);
      job.details = { direction: 'Deliver to site' };
      if (/pick/.test(low(d.fulfillment))) extra.push('CUSTOMER PICKUP at the yard — no delivery truck needed');
      break;
    }
    case 'bin':
      job.job_type = 'bin';
      job.material = str(d.bin_size, 60);
      job.details = { service: binService(d.service) };
      if (d.pickup_date) extra.push(`Expected pick-up: ${sms.formatDate(ymd(d.pickup_date))}`);
      if (d.material_type) extra.push(`Going in the bin: ${d.material_type}`);
      break;
    case 'toilet': {
      job.job_type = 'toilet';
      const t = Array.isArray(d.toilets) ? d.toilets : [];
      job.details = { trip: 'Deliver', pickup_date: ymd(d.pickup_date), placement: str(d.placement, 1000), extra_servicing: str(d.extra_servicing, 200) };
      t.slice(0, 3).forEach((x, i) => {
        job.details[`toilet${i + 1}_type`] = str(x.type, 100);
        job.details[`toilet${i + 1}_qty`] = x.qty ? String(Number(x.qty) || '') : '';
      });
      if (t.length > 3) extra.push(`More toilets: ${t.slice(3).map((x) => `${x.qty || 1}× ${x.type}`).join(', ')}`);
      break;
    }
    default:
      job.job_type = 'misc';
      job.material = str(d.service_name || SERVICE_NAMES[r.service], 200);
      extra.push(...detailLines(d));
  }
  for (const k of Object.keys(job.details)) if (!job.details[k]) delete job.details[k];
  if (r.notes) extra.push(`Customer notes: ${r.notes}`);
  job.notes = extra.join('. ');
  return job;
}

function createIntake(db) {
  const q = (sql) => db.prepare(sql);

  function get(id) {
    const r = q('SELECT * FROM requests WHERE id = ?').get(Number(id));
    return r ? decorate(r) : null;
  }

  function decorate(r) {
    const body = JSON.parse(r.payload || '{}');
    return {
      ...r,
      service_name: SERVICE_NAMES[r.service] || r.service,
      summary: summarize(r.service, body.details || {}),
      detail_lines: detailLines(body.details || {}),
      estimate_lines: Array.isArray(body.estimate?.lines) ? body.estimate.lines.slice(0, 30) : [],
      payload: undefined,
    };
  }

  /** Store a website order. Re-sending the same order id updates it instead of making a duplicate. */
  function receive(body) {
    const row = normalizePayload(body);
    const existing = row.external_id ? q('SELECT * FROM requests WHERE external_id = ?').get(row.external_id) : null;
    const cols = ['service', 'customer_name', 'phone', 'email', 'billing_address', 'address', 'municipality',
      'requested_date', 'estimate_total', 'notes', 'payload'];
    if (existing) {
      q(`UPDATE requests SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...cols.map((c) => row[c]), existing.id);
      return { request: get(existing.id), created: false };
    }
    const r = q(`INSERT INTO requests (external_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
      .run(row.external_id, ...cols.map((c) => row[c]));
    return { request: get(r.lastInsertRowid), created: true };
  }

  function list({ status } = {}) {
    const where = status === 'open' ? "WHERE r.status = 'new'" : STATUSES.includes(status) ? 'WHERE r.status = ?' : '';
    const args = STATUSES.includes(status) ? [status] : [];
    return q(`SELECT r.*, j.scheduled_date AS job_date, j.status AS job_status FROM requests r
              LEFT JOIN jobs j ON j.id = r.job_id ${where} ORDER BY r.id DESC LIMIT 200`).all(...args).map(decorate);
  }

  function countNew() {
    return q("SELECT COUNT(*) AS n FROM requests WHERE status = 'new'").get().n;
  }

  function setStatus(id, status, userId = null) {
    if (!STATUSES.includes(status)) throw new IntakeError('Unknown status');
    q(`UPDATE requests SET status = ?, handled_by = ?, updated_at = datetime('now') WHERE id = ?`).run(status, userId, Number(id));
    return get(id);
  }

  /** The office scheduled this request as a job. */
  function link(id, jobId, userId = null) {
    if (!get(id)) return null;
    q(`UPDATE requests SET status = 'scheduled', job_id = ?, handled_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(Number(jobId), userId, Number(id));
    q('UPDATE jobs SET request_id = ? WHERE id = ?').run(Number(id), Number(jobId));
    return get(id);
  }

  function prefill(id, today) {
    const r = q('SELECT * FROM requests WHERE id = ?').get(Number(id));
    return r ? toJobPrefill(r, today) : null;
  }

  /** For the website to show "Scheduled for Tue Nov 10" in its admin. */
  function statusFor(externalId) {
    const r = q(`SELECT r.status, r.job_id, j.scheduled_date, j.status AS job_status FROM requests r
                 LEFT JOIN jobs j ON j.id = r.job_id WHERE r.external_id = ?`).get(String(externalId));
    if (!r) return null;
    let status = r.status;
    if (r.job_id && r.job_status === 'complete') status = 'completed';
    if (r.job_id && r.job_status === 'cancelled') status = 'cancelled';
    return { status, job_number: r.job_id || null, scheduled_date: r.scheduled_date || null };
  }

  return { receive, list, get, countNew, setStatus, link, prefill, statusFor };
}

/** Constant-time check of the website's key. */
function validKey(given, expected) {
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { createIntake, normalizePayload, toJobPrefill, validKey, IntakeError, SERVICES, SERVICE_NAMES };
