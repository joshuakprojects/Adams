/**
 * Repeating work orders: weekly toilet servicing, the Friday septic route, a monthly bin swap.
 *
 * A series keeps a copy of the work order (its template) and a rule: every N weeks on chosen weekdays, or every
 * N months on the same date. Visits are made about two weeks ahead as normal work orders with no driver (dispatch
 * picks each one), so the Board, texts and prices work as usual. A visit that is cancelled or skipped is never
 * made again; editing "this and future visits" updates the template and the visits nobody has been texted about.
 */
const { addDays, ValidationError } = require('./dispatch');

const HORIZON_DAYS = 14;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const parseJson = (s, fallback) => { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } };
const weekday = (ymd) => new Date(ymd + 'T12:00:00Z').getUTCDay();
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

/** A repeat rule from the form: { freq: 'week'|'month', every: 1-4, weekdays: [0-6], end_date, max_visits }. */
function cleanRule(input, startDate) {
  const r = input || {};
  const freq = r.freq === 'month' ? 'month' : r.freq === 'week' ? 'week' : null;
  if (!freq) return null;
  const every = Math.max(1, Math.min(freq === 'week' ? 8 : 12, Number(r.every) || 1));
  let weekdays = freq === 'week' ? [...new Set((Array.isArray(r.weekdays) ? r.weekdays : []).map(Number).filter((n) => n >= 0 && n <= 6))].sort() : [];
  if (freq === 'week' && !weekdays.length) weekdays = [weekday(startDate)];
  const end_date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.end_date || '')) ? String(r.end_date) : '';
  if (end_date && end_date < startDate) throw new ValidationError('The repeat end date is before the first visit');
  const max = r.max_visits === '' || r.max_visits == null ? null : Math.floor(Number(r.max_visits));
  if (max != null && !(max >= 2 && max <= 500)) throw new ValidationError('Number of visits must be 2 to 500');
  return { freq, every, weekdays, end_date, max_visits: max };
}

/** "Every Friday", "Every 2 weeks on Mon & Thu", "Every month on the 15th", plus how it ends. */
function describeRule(rule, startDate) {
  if (!rule) return '';
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th');
  let s;
  if (rule.freq === 'week') {
    const days = rule.weekdays.map((d) => DAY_NAMES[d]);
    const list = days.length === 1 ? days[0] : days.map((d) => d.slice(0, 3)).join(' & ');
    s = rule.every === 1 ? `Every ${list}` : `Every ${rule.every} weeks on ${list}`;
  } else {
    const day = Number(startDate.slice(8));
    s = rule.every === 1 ? `Every month on the ${ord(day)}` : `Every ${rule.every} months on the ${ord(day)}`;
  }
  if (rule.end_date) s += `, until ${rule.end_date}`;
  else if (rule.max_visits) s += `, ${rule.max_visits} visits`;
  return s;
}

/** Visit dates from the start, in order, up to `until` (inclusive). */
function datesFor(rule, startDate, until) {
  const out = [];
  const last = rule.end_date && rule.end_date < until ? rule.end_date : until;
  if (rule.freq === 'week') {
    // Weeks counted from the start date's week (Sunday-based).
    const weekStart = addDays(startDate, -weekday(startDate));
    for (let d = startDate; d <= last; d = addDays(d, 1)) {
      const week = Math.floor(daysBetween(weekStart, d) / 7);
      if (week % rule.every === 0 && rule.weekdays.includes(weekday(d))) out.push(d);
      if (out.length > 1000) break;
    }
  } else {
    const [y, m, dd] = startDate.split('-').map(Number);
    for (let i = 0; i < 1000; i += rule.every) {
      const yy = y + Math.floor((m - 1 + i) / 12);
      const mm = ((m - 1 + i) % 12) + 1;
      const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      const d = `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(dd, lastDay)).padStart(2, '0')}`;
      if (d > last) break;
      out.push(d);
    }
  }
  return rule.max_visits ? out.slice(0, rule.max_visits) : out;
}

// Work order fields copied to each visit (not the date, drivers, status, or office bookkeeping for one visit).
const TEMPLATE_SKIP = new Set(['id', 'scheduled_date', 'assignments', 'status', 'created_at', 'updated_at', 'created_by', 'created_by_name',
  'tickets', 'totals', 'missing', 'series_id', 'paper_wo', 'invoice_number', 'amount_billed', 'completed_at', 'review_status', 'review_at',
  'lat', 'lng', 'request_id', 'quote_id', 'send_now', 'series_scope', 'repeat', 'draft']);
function templateFrom(job) {
  const t = {};
  for (const [k, v] of Object.entries(job || {})) if (!TEMPLATE_SKIP.has(k)) t[k] = v;
  t.lines = (job.lines || []).filter((l) => !Number(l.auto)).map(({ id, job_id, ...l }) => l); // prices are worked out again per visit
  return t;
}

function createRecurring(db, dispatch, { today = dispatch.today } = {}) {
  async function get(id) {
    const s = await db.get('SELECT * FROM job_series WHERE id = ?', Number(id));
    if (!s) return null;
    s.rule = parseJson(s.rule, null);
    s.template = parseJson(s.template, {});
    s.skips = parseJson(s.skips, []);
    s.label = describeRule(s.rule, s.start_date);
    return s;
  }

  /** Visits already made (any status), by date. */
  async function visits(seriesId) {
    return db.all('SELECT id, scheduled_date, status FROM jobs WHERE series_id = ? ORDER BY scheduled_date', seriesId);
  }

  /** Visits nobody has touched: open, after `after`, no driver given yet. Safe to change or remove. */
  async function untouched(seriesId, after) {
    const rows = await db.all(`SELECT j.id FROM jobs j WHERE j.series_id = ? AND j.scheduled_date > ? AND j.status = 'open'
      AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.job_id = j.id AND a.status != 'cancelled')`, seriesId, after);
    return rows.map((r) => r.id);
  }

  /** Start repeating from an existing work order (it is the first visit). */
  async function start(jobId, repeat, userId = null) {
    const job = await dispatch.getJob(jobId);
    if (!job) throw new ValidationError('Job not found');
    if (job.series_id) throw new ValidationError('This work order already repeats');
    const rule = cleanRule(repeat, job.scheduled_date);
    if (!rule) return null;
    const r = await db.run('INSERT INTO job_series (template, rule, start_date, created_by) VALUES (?, ?, ?, ?)',
      JSON.stringify(templateFrom(job)), JSON.stringify(rule), job.scheduled_date, userId);
    const id = Number(r.lastInsertRowid);
    await db.run('UPDATE jobs SET series_id = ? WHERE id = ?', id, job.id);
    await dispatch.logHistory(job.id, 'Set to repeat', describeRule(rule, job.scheduled_date));
    await generate(id);
    return get(id);
  }

  /** Make the visits due in the next two weeks (all series, or one). */
  async function generate(onlyId = null) {
    const series = onlyId ? [await db.get('SELECT id FROM job_series WHERE id = ?', onlyId)].filter(Boolean)
      : await db.all('SELECT id FROM job_series WHERE ended = 0 AND paused = 0');
    const made = [];
    const from = today();
    const until = addDays(from, HORIZON_DAYS);
    for (const { id } of series) {
      const s = await get(id);
      if (!s || s.ended || s.paused) continue;
      const have = new Set((await visits(id)).map((v) => v.scheduled_date));
      const all = datesFor(s.rule, s.start_date, until);
      for (const d of all) {
        if (d < from || have.has(d) || s.skips.includes(d)) continue;
        const { job } = await dispatch.saveJob({ ...s.template, id: null, scheduled_date: d, assignments: [], draft: false });
        await db.run('UPDATE jobs SET series_id = ? WHERE id = ?', id, job.id);
        await dispatch.logHistory(job.id, 'Repeat visit', `${s.label} (series #${id})`, 'System');
        made.push(job.id);
      }
      // An end date or a number of visits, and the last one is made: the series is finished.
      if (s.rule.end_date || s.rule.max_visits) {
        const allEver = datesFor(s.rule, s.start_date, s.rule.end_date || addDays(from, 3650));
        if (allEver.length && allEver[allEver.length - 1] <= until) await db.run('UPDATE job_series SET ended = 1 WHERE id = ?', id);
      }
    }
    return made;
  }

  /** "This and future visits": new template (and rule) from the edited visit; untouched future visits are remade. */
  async function updateFuture(jobId, repeat = null) {
    const job = await dispatch.getJob(jobId);
    if (!job?.series_id) throw new ValidationError('This work order does not repeat');
    const s = await get(job.series_id);
    // The changed repeat counts from this visit on; earlier visits stay as they were.
    const rule = repeat ? cleanRule(repeat, job.scheduled_date) || s.rule : s.rule;
    const startDate = repeat ? job.scheduled_date : s.start_date;
    for (const id of await untouched(s.id, job.scheduled_date)) await dispatch.deleteJob(id);
    // Visits that already have a driver keep their date and driver but get the new details.
    const texted = await db.all(`SELECT id FROM jobs WHERE series_id = ? AND scheduled_date > ? AND status = 'open'`, s.id, job.scheduled_date);
    for (const { id } of texted) {
      const v = await dispatch.getJob(id);
      await dispatch.saveJob({ ...templateFrom(job), id, scheduled_date: v.scheduled_date, assignments: v.assignments.map((a) => ({ driver_id: a.driver_id, truck_id: a.truck_id })) });
    }
    await db.run("UPDATE job_series SET template = ?, rule = ?, start_date = ?, ended = 0, updated_at = datetime('now') WHERE id = ?",
      JSON.stringify(templateFrom(job)), JSON.stringify(rule), startDate, s.id);
    await dispatch.logHistory(job.id, 'Repeat changed for this and future visits', describeRule(rule, startDate));
    await generate(s.id);
    return get(s.id);
  }

  async function action(seriesId, what, date = '') {
    const s = await get(seriesId);
    if (!s) throw new ValidationError('Repeat not found');
    const from = today();
    if (what === 'pause' || what === 'resume') {
      await db.run('UPDATE job_series SET paused = ? WHERE id = ?', what === 'pause' ? 1 : 0, s.id);
      if (what === 'pause') for (const id of await untouched(s.id, from)) await dispatch.deleteJob(id);
      else await generate(s.id);
    } else if (what === 'stop') {
      await db.run('UPDATE job_series SET ended = 1 WHERE id = ?', s.id);
      for (const id of await untouched(s.id, from)) await dispatch.deleteJob(id);
    } else if (what === 'skip') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('Pick the date to skip');
      await db.run('UPDATE job_series SET skips = ? WHERE id = ?', JSON.stringify([...new Set([...s.skips, date])].sort()), s.id);
      const v = await db.get("SELECT id FROM jobs WHERE series_id = ? AND scheduled_date = ? AND status = 'open'", s.id, date);
      if (v) {
        const touched = await db.get("SELECT 1 FROM assignments WHERE job_id = ? AND status != 'cancelled'", v.id);
        if (touched) await dispatch.cancelJob(v.id); else await dispatch.deleteJob(v.id);
      }
    } else throw new ValidationError('Unknown action');
    return get(s.id);
  }

  async function list() {
    const rows = await db.all('SELECT id FROM job_series ORDER BY ended, id DESC');
    const out = [];
    for (const { id } of rows) {
      const s = await get(id);
      const v = await visits(id);
      const next = v.find((x) => x.scheduled_date >= today() && x.status === 'open');
      out.push({ id: s.id, label: s.label, rule: s.rule, start_date: s.start_date, paused: Boolean(s.paused), ended: Boolean(s.ended), skips: s.skips,
        job_type: s.template.job_type, customer: s.template.customer || '', to_location: s.template.to_location || '',
        visits: v.length, done: v.filter((x) => x.status === 'complete').length, next: next ? { id: next.id, date: next.scheduled_date } : null,
        upcoming: v.filter((x) => x.scheduled_date >= today() && x.status === 'open').slice(0, 6).map((x) => ({ id: x.id, date: x.scheduled_date })) });
    }
    return out;
  }

  /** Called every minute: make new visits once a day. */
  async function runScheduled() {
    const day = today();
    const ran = (await db.get("SELECT value FROM settings WHERE key = 'series_ran_day'"))?.value;
    if (ran === day) return null;
    await db.run("INSERT INTO settings (key, value) VALUES ('series_ran_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", day);
    return generate();
  }

  return { start, generate, updateFuture, action, list, get, runScheduled };
}

module.exports = { createRecurring, cleanRule, describeRule, datesFor, templateFrom, HORIZON_DAYS };
