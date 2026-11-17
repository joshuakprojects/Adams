/**
 * End-of-day summary: what got done on a day, what's still open, money and loads, machines moved, and tomorrow.
 * Shown on the Board (Day summary) and texted to the numbers set in Setup, by a button or automatically each day.
 */
const PRICING = require('../public/pricing');
const FORMS = require('../public/forms');
const sms = require('./sms');
const { addDays } = require('./dispatch');
const config = require('./config');

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-CA');
const localDay = (sqlUtc, timeZone) => (sqlUtc ? new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleDateString('en-CA', { timeZone }) : '');

function createSummary(db, { send = sms.sendSms, today, nowHm, timeZone = config.timeZone } = {}) {
  const getSetting = async (key, fallback = '') => (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value ?? fallback;
  const setSetting = (key, value) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

  async function jobValue(jobIds) {
    if (!jobIds.length) return new Map();
    const hst = Number(await getSetting('price_hst_rate', '13'));
    const rows = await db.all(`SELECT * FROM job_lines WHERE job_id IN (${jobIds.map(() => '?').join(',')})`, ...jobIds);
    const by = new Map();
    for (const r of rows) (by.get(r.job_id) || by.set(r.job_id, []).get(r.job_id)).push(r);
    return new Map(jobIds.map((id) => [id, PRICING.totals(by.get(id) || [], hst)]));
  }

  async function assignmentsFor(jobIds) {
    if (!jobIds.length) return new Map();
    const rows = await db.all(`SELECT a.*, d.name AS driver_name FROM assignments a JOIN drivers d ON d.id = a.driver_id
      WHERE a.job_id IN (${jobIds.map(() => '?').join(',')}) AND a.status != 'cancelled'`, ...jobIds);
    const by = new Map();
    for (const r of rows) (by.get(r.job_id) || by.set(r.job_id, []).get(r.job_id)).push(r);
    return by;
  }

  const typeName = (t) => (FORMS.TYPES[t]?.name || t).toLowerCase();
  function openReason(as) {
    if (!as.length) return 'no driver';
    if (as.some((a) => a.status === 'pending')) return 'not texted';
    if (as.some((a) => a.status === 'sent')) return 'no OK yet';
    return 'not finished';
  }

  /** Everything for the day (a work date, YYYY-MM-DD). */
  async function build(date = today()) {
    const jobs = await db.all('SELECT * FROM jobs WHERE scheduled_date = ? AND (draft IS NULL OR draft = 0) ORDER BY id', date);
    const live = jobs.filter((j) => j.status !== 'cancelled');
    const done = live.filter((j) => j.status === 'complete');
    const open = live.filter((j) => j.status !== 'complete');
    const assigns = await assignmentsFor(live.map((j) => j.id));
    const values = await jobValue(live.map((j) => j.id));
    const byType = {};
    for (const j of done) byType[j.job_type] = (byType[j.job_type] || 0) + 1;
    const loads = [...assigns.values()].flat().reduce((n, a) => n + (Number(a.loads_done) || 0), 0);
    const sum = (list, key) => list.reduce((n, j) => n + (values.get(j.id)?.[key] || 0), 0);

    // Booked today (for any date), counted by when it was entered.
    const recent = await db.all("SELECT id, created_at, status FROM jobs WHERE created_at >= ? AND status != 'cancelled' AND (draft IS NULL OR draft = 0)",
      `${addDays(date, -1)} 00:00:00`);
    const bookedIds = recent.filter((j) => localDay(j.created_at, timeZone) === date).map((j) => j.id);
    const bookedValues = await jobValue(bookedIds);
    const bookedValue = bookedIds.reduce((n, id) => n + (bookedValues.get(id)?.subtotal || 0), 0);

    const reqs = await db.all('SELECT created_at FROM requests WHERE created_at >= ?', `${addDays(date, -1)} 00:00:00`);
    const websiteRequests = reqs.filter((r) => localDay(r.created_at, timeZone) === date).length;
    const waitingRequests = (await db.get("SELECT COUNT(*) AS n FROM requests WHERE status = 'new'"))?.n || 0;

    let moves = [];
    try {
      moves = await db.all(`SELECT m.place, e.name AS machine, s.name AS site FROM equipment_moves m JOIN equipment e ON e.id = m.equipment_id
        LEFT JOIN sites s ON s.id = m.site_id LEFT JOIN jobs j ON j.id = m.job_id WHERE m.day = ? AND (j.id IS NULL OR j.status != 'cancelled') ORDER BY m.id`, date);
    } catch { /* no Our sites tables yet */ }

    const next = addDays(date, 1);
    const tomorrow = (await db.all("SELECT id FROM jobs WHERE scheduled_date = ? AND status != 'cancelled' AND (draft IS NULL OR draft = 0)", next)).map((j) => j.id);
    const tAssign = await assignmentsFor(tomorrow);

    return {
      date,
      jobs: live.length,
      done: done.length,
      done_by_type: Object.entries(byType).map(([type, n]) => ({ type, name: typeName(type), n })),
      loads,
      done_value: Math.round(sum(done, 'subtotal') * 100) / 100,
      day_value: Math.round(sum(live, 'subtotal') * 100) / 100,
      unpriced: done.filter((j) => !(values.get(j.id)?.subtotal)).map((j) => j.id),
      open: open.map((j) => {
        const as = assigns.get(j.id) || [];
        return { id: j.id, type: j.job_type, customer: j.customer || FORMS.TYPES[j.job_type]?.name || '', reason: openReason(as),
          drivers: as.map((a) => a.driver_name) };
      }),
      cancelled: jobs.length - live.length,
      booked_today: bookedIds.length,
      booked_value: Math.round(bookedValue * 100) / 100,
      website_requests: websiteRequests,
      waiting_requests: waitingRequests,
      moves: moves.map((m) => ({ machine: m.machine, to: m.site || m.place || 'the yard' })),
      tomorrow: { date: next, jobs: tomorrow.length, no_driver: tomorrow.filter((id) => !(tAssign.get(id) || []).length).length },
    };
  }

  /** The summary as one text message. */
  function text(s) {
    const lines = [`ADAMS BROS - Day summary ${sms.formatDate(s.date)}`];
    lines.push(`Done: ${s.done} of ${s.jobs} job${s.jobs === 1 ? '' : 's'}${s.done_by_type.length ? ` (${s.done_by_type.map((t) => `${t.n} ${t.name}`).join(', ')})` : ''}`);
    if (s.loads) lines.push(`Loads hauled: ${s.loads}`);
    lines.push(`Work done: ${money(s.done_value)} + HST${s.unpriced.length ? ` (${s.unpriced.length} done job${s.unpriced.length === 1 ? '' : 's'} not priced)` : ''}`);
    if (s.open.length) lines.push(`Still open: ${s.open.length} - ${s.open.slice(0, 5).map((o) => `#${o.id} ${o.customer} (${o.reason})`).join('; ')}${s.open.length > 5 ? '; ...' : ''}`);
    if (s.cancelled) lines.push(`Cancelled: ${s.cancelled}`);
    lines.push(`Booked today: ${s.booked_today} job${s.booked_today === 1 ? '' : 's'}${s.booked_value ? ` (${money(s.booked_value)})` : ''}`);
    if (s.website_requests || s.waiting_requests) lines.push(`Website orders: ${s.website_requests} new today${s.waiting_requests ? `, ${s.waiting_requests} waiting to book` : ''}`);
    if (s.moves.length) lines.push(`Machines moved: ${s.moves.map((m) => `${m.machine} to ${m.to}`).join('; ')}`);
    lines.push(`Tomorrow: ${s.tomorrow.jobs} job${s.tomorrow.jobs === 1 ? '' : 's'}${s.tomorrow.no_driver ? `, ${s.tomorrow.no_driver} with no driver` : ''}`);
    return lines.join('\n');
  }

  async function settings() {
    const { parsePhones } = require('./alerts');
    return {
      summary_phones: parsePhones(await getSetting('summary_phones', '[]')),
      summary_time: await getSetting('summary_time', ''),
    };
  }
  async function saveSettings({ summary_phones, summary_time }) {
    const { parsePhones } = require('./alerts');
    if (summary_phones !== undefined) await setSetting('summary_phones', JSON.stringify(parsePhones(summary_phones)));
    if (summary_time !== undefined) {
      const t = String(summary_time || '').trim();
      if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw Object.assign(new Error('Time must look like 17:00'), { status: 400 });
      await setSetting('summary_time', t);
    }
    return settings();
  }

  /** Text the summary for `date` to `phones` (default: the summary numbers in Setup). */
  async function sendTo(date, phones = null) {
    const { parsePhones } = require('./alerts');
    const to = phones ? parsePhones(phones) : (await settings()).summary_phones;
    if (!to.length) throw Object.assign(new Error('Add at least one number to text the summary to'), { status: 400 });
    const body = text(await build(date));
    const results = [];
    for (const p of to) {
      try { await send(p, body); results.push({ phone: p, ok: true }); } catch (err) { results.push({ phone: p, ok: false, error: err.message }); }
    }
    return { date, body, results };
  }

  /** Called every minute: send today's summary once, at the time set in Setup. */
  async function runScheduled() {
    const s = await settings();
    if (!s.summary_time || !s.summary_phones.length) return null;
    const day = today();
    if (nowHm() < s.summary_time || (await getSetting('summary_sent_day', '')) === day) return null;
    await setSetting('summary_sent_day', day);
    return sendTo(day);
  }

  return { build, text, settings, saveSettings, sendTo, runScheduled };
}

module.exports = { createSummary };
