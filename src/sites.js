/**
 * Our own job sites: site heads (foremen / operators running a job) ask for trucks, drivers, labourers and
 * equipment for the next working day, and the office hands them out.
 *
 *  - Each afternoon (Setup → Our sites) every active site's head gets a text: "what do you need for Mon?".
 *    They reply in plain words ("tandem AM, mini ex, 2 labourers", "same", "nothing") or tap a link to a phone form.
 *  - The Sites tab shows, per day, what each site asked for and what it's been given. Giving a site anything makes an
 *    "Our site" work order for that day (job_type 'site'), so drivers get their usual texts and the board shows it —
 *    marked OUR SITE, apart from customer work.
 *  - Equipment remembers where it was last sent; sending it to a different site offers to book the float.
 */
const crypto = require('node:crypto');
const sms = require('./sms');
const config = require('./config');

class SiteError extends Error {
  constructor(message) { super(message); this.status = 400; this.expose = true; }
}
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const checkDay = (day) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new SiteError('Pick a day'); };
const parseJson = (s, d = {}) => { try { return JSON.parse(s || '') ?? d; } catch { return d; } };

// Placeholder machines, so the page can be tried before the real list is entered (rename or remove them in Setup).
const PLACEHOLDER_EQUIPMENT = [
  ['Excavator 1', 'Excavator'], ['Excavator 2', 'Excavator'], ['Mini excavator 1', 'Mini excavator'],
  ['Loader 1', 'Loader'], ['Skid steer 1', 'Skid steer'], ['Dozer 1', 'Dozer'], ['Roller 1', 'Roller'],
];
const YARD = 'Yard - 116 William St, Parry Sound';
const TRUCK_TYPES = ['Tandem', 'Triaxle', 'Float', 'Water truck', 'Vac truck', 'Pickup'];
const SLOTS = { first: 'first thing', am: 'AM', pm: 'PM', all: 'all day' };

// Words site heads use, mapped to what they mean.
const TRUCK_WORDS = [
  [/\btri[\s-]?ax(le)?s?\b|\btri\b/i, 'Triaxle'], [/\btandems?\b/i, 'Tandem'], [/\b(float|low[\s-]?bed|low[\s-]?boy)s?\b/i, 'Float'],
  [/\bwater\s?truck/i, 'Water truck'], [/\bvac(uum)?\s?truck|\bvac\b/i, 'Vac truck'], [/\bpick[\s-]?ups?\b/i, 'Pickup'],
  [/\bdump\s?trucks?\b|\btrucks?\b/i, 'Tandem'],
];
const MACHINE_WORDS = [
  [/\bmini[\s-]?(ex|excavator|hoe)\b/i, 'Mini excavator'], [/\b(excavator|ex|hoe|digger|track\s?hoe)s?\b/i, 'Excavator'],
  [/\b(skid[\s-]?steer|bob[\s-]?cat)s?\b/i, 'Skid steer'], [/\bloaders?\b/i, 'Loader'], [/\b(dozer|bull[\s-]?dozer)s?\b/i, 'Dozer'],
  [/\b(roller|compactor|packer)s?\b/i, 'Roller'], [/\bgraders?\b/i, 'Grader'],
];
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function slotOf(text) {
  if (/first thing|\bearly\b|\b(6|7)\s?(am)?\b/i.test(text)) return 'first';
  if (/all day/i.test(text)) return 'all';
  if (/\bpm\b|afternoon|after lunch/i.test(text)) return 'pm';
  if (/\bam\b|morning/i.test(text)) return 'am';
  return '';
}

// Trucks that haul material: the site head says what (an aggregate from the price book, or anything).
const HAUL_TYPES = ['Tandem', 'Triaxle'];
const norm = (x) => ` ${String(x).toLowerCase().replace(/["'”″]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;
/** The price-book material named in `part`, matched loosely ("a gravel", "3/4 clear", "sand fill"); the longest name wins. */
function findMaterial(part, materials) {
  const p = norm(part);
  let best = null;
  for (const m of materials) {
    const aliases = [m, m.replace(/\(.*?\)/g, ''), m.replace(/\(.*?\)/g, '').replace(/[\d/"'.-]+/g, ' ')].map(norm).filter((a) => a.trim().length >= 4);
    for (const a of aliases) if (p.includes(a) && (!best || a.length > best.len)) best = { name: m, len: a.length };
  }
  return best?.name || '';
}

/** "tandem AM, mini ex and 2 labourers" → { trucks: [{type, count, slot, material, loads}], equipment: [{kind, slot}], labourers, note } */
function parseNeeds(text, kinds = [], materials = []) {
  const raw = String(text || '').trim();
  const out = { trucks: [], equipment: [], labourers: 0, note: '', nothing: false, same: false };
  if (!raw) return out;
  if (/^\W*(nothing|none|no|nope|nothing needed|all good|we're good|were good|good|n\/a)\W*$/i.test(raw)) { out.nothing = true; return out; }
  if (/^\W*(same|same as today|same as yesterday|same again|ditto)\W*$/i.test(raw)) { out.same = true; return out; }
  const left = [];
  for (const part of raw.split(/\s*(?:,|;|\n|\band\b|\+|&)\s*/i).filter(Boolean)) {
    const countMatch = part.match(/^\s*(\d+|a|an|one|two|three|four|five|six)\b/i);
    const count = countMatch ? Number(countMatch[1]) || NUMBER_WORDS[countMatch[1].toLowerCase()] || 1 : 1;
    const slot = slotOf(part) || '';
    let used = false;
    // "float to move the ex Friday": a float, with the details kept as a note.
    if (/\b(float|low[\s-]?bed|low[\s-]?boy)s?\b/i.test(part) && /\b(move|moving|bring|take|haul|pick ?up|drop)\b/i.test(part)) {
      out.trucks.push({ type: 'Float', count: 1, slot }); left.push(part); continue;
    }
    if (/\b(labou?r(er)?s?|helpers?|guys|men|hands)\b/i.test(part)) { out.labourers += count; used = true; }
    const machine = MACHINE_WORDS.find(([re]) => re.test(part)) || kinds.map((k) => [new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i'), k]).find(([re]) => re.test(part));
    if (!used && machine) { for (let i = 0; i < Math.min(count, 6); i++) out.equipment.push({ kind: machine[1], slot }); used = true; }
    const truck = !used && TRUCK_WORDS.find(([re]) => re.test(part));
    const material = findMaterial(part, materials);
    const loads = Number((part.match(/(\d+)\s*loads?\b/i) || [])[1]) || 0;
    if (truck) {
      out.trucks.push({ type: truck[1], count: loads && countMatch && Number(countMatch[1]) === loads ? 1 : Math.min(count, 9), slot,
        ...(material ? { material } : {}), ...(loads ? { loads } : {}) });
      used = true;
    } else if (!used && (material || loads)) {
      // "tandem AM, A gravel, 4 loads": goes with the last truck that hauls.
      const last = [...out.trucks].reverse().find((t) => HAUL_TYPES.includes(t.type));
      if (last) { if (material && !last.material) last.material = material; if (loads && !last.loads) last.loads = loads; used = true; }
    }
    if (!used) left.push(part);
  }
  out.note = left.join(', ').slice(0, 300);
  return out;
}

function describeNeeds(n) {
  if (!n) return '';
  if (n.nothing) return 'Nothing needed';
  if (n.same) return 'Same as last time';
  const bits = [];
  for (const t of n.trucks || []) {
    const load = [t.material, t.loads ? `${t.loads} load${t.loads === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    bits.push(`${t.count > 1 ? t.count + ' × ' : ''}${t.type}${t.slot ? ` (${SLOTS[t.slot]})` : ''}${load ? ` – ${load}` : ''}`);
  }
  const kinds = {};
  for (const e of n.equipment || []) { const k = e.kind + (e.slot ? ` (${SLOTS[e.slot]})` : ''); kinds[k] = (kinds[k] || 0) + 1; }
  for (const [k, c] of Object.entries(kinds)) bits.push(`${c > 1 ? c + ' × ' : ''}${k}`);
  if (n.labourers) bits.push(`${n.labourers} labourer${n.labourers === 1 ? '' : 's'}`);
  if (n.note) bits.push(n.note);
  return bits.join(', ');
}

const dayLabel = (day) => sms.formatDate(day);
function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The next working day: Friday → Monday. */
function nextWorkDay(day) {
  let d = addDays(day, 1);
  while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDays(d, 1);
  return d;
}
function prevWorkDay(day) {
  let d = addDays(day, -1);
  while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDays(d, -1);
  return d;
}

function createSites(db, dispatch, { send = sms.sendSms, today, nowHm } = {}) {
  today = today || (() => new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date()));
  nowHm = nowHm || (() => new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()));
  const getSetting = async (k, d = '') => (await db.get('SELECT value FROM settings WHERE key = ?', k))?.value ?? d;
  const setSetting = async (k, v) => {
    if (await db.get('SELECT key FROM settings WHERE key = ?', k)) await db.run('UPDATE settings SET value = ? WHERE key = ?', v, k);
    else await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', k, v);
  };
  const linkFor = (site) => `${config.publicUrl}/s/${site.token}`;

  async function ensureSetup() {
    if (await getSetting('equipment_seeded')) return;
    const n = (await db.get('SELECT COUNT(*) AS n FROM equipment')).n;
    if (!Number(n)) {
      let sort = 0;
      for (const [name, kind] of PLACEHOLDER_EQUIPMENT) {
        await db.run('INSERT INTO equipment (name, kind, unit, notes, sort) VALUES (?, ?, ?, ?, ?)', name, kind, '', 'Placeholder — rename or remove', sort++);
      }
    }
    await setSetting('equipment_seeded', '1');
  }

  // ---------- site heads, sites, equipment (Setup) ----------
  const listHeads = ({ all = false } = {}) => db.all(`SELECT * FROM site_heads ${all ? '' : 'WHERE active = 1'} ORDER BY name COLLATE NOCASE`);
  async function saveHead(data) {
    const name = str(data.name, 100);
    if (!name) throw new SiteError('Site head name is required');
    const phone = sms.normalizePhone(data.phone);
    if (!phone) throw new SiteError('Enter a valid 10-digit cell number');
    const active = data.active === false || data.active === 0 || data.active === '0' ? 0 : 1;
    try {
      if (data.id) {
        await db.run('UPDATE site_heads SET name = ?, phone = ?, active = ?, notes = ? WHERE id = ?', name, phone, active, str(data.notes), Number(data.id));
        return db.get('SELECT * FROM site_heads WHERE id = ?', Number(data.id));
      }
      const r = await db.run('INSERT INTO site_heads (name, phone, active, notes) VALUES (?, ?, ?, ?)', name, phone, active, str(data.notes));
      return db.get('SELECT * FROM site_heads WHERE id = ?', r.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE|duplicate key/i.test(err.message)) throw new SiteError('Another site head already has that phone number');
      throw err;
    }
  }
  const listSites = ({ all = false } = {}) => db.all(`SELECT s.*, h.name AS head_name, h.phone AS head_phone FROM sites s
      LEFT JOIN site_heads h ON h.id = s.head_id ${all ? '' : 'WHERE s.active = 1'} ORDER BY s.name COLLATE NOCASE`);
  async function saveSite(data) {
    const name = str(data.name, 100);
    if (!name) throw new SiteError('Give the site a name, e.g. "Seguin — Lake Rd septic"');
    const fields = [name, str(data.address, 300), str(data.municipality, 100), data.head_id ? Number(data.head_id) : null,
      data.active === false || data.active === 0 || data.active === '0' ? 0 : 1, str(data.notes)];
    if (data.id) {
      await db.run('UPDATE sites SET name = ?, address = ?, municipality = ?, head_id = ?, active = ?, notes = ? WHERE id = ?', ...fields, Number(data.id));
      return db.get('SELECT * FROM sites WHERE id = ?', Number(data.id));
    }
    const r = await db.run('INSERT INTO sites (name, address, municipality, head_id, active, notes, token) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ...fields, crypto.randomBytes(9).toString('base64url'));
    return db.get('SELECT * FROM sites WHERE id = ?', r.lastInsertRowid);
  }
  const listEquipment = ({ all = false } = {}) => db.all(`SELECT * FROM equipment ${all ? '' : 'WHERE active = 1'} ORDER BY sort, name COLLATE NOCASE`);
  async function saveEquipment(data) {
    const name = str(data.name, 100);
    if (!name) throw new SiteError('Equipment name is required');
    const fields = [name, str(data.kind, 60) || 'Other', str(data.unit, 40), data.in_shop ? 1 : 0,
      data.active === false || data.active === 0 || data.active === '0' ? 0 : 1, str(data.notes)];
    if (data.id) {
      await db.run('UPDATE equipment SET name = ?, kind = ?, unit = ?, in_shop = ?, active = ?, notes = ? WHERE id = ?', ...fields, Number(data.id));
      return db.get('SELECT * FROM equipment WHERE id = ?', Number(data.id));
    }
    const sort = Number((await db.get('SELECT COALESCE(MAX(sort), 0) AS m FROM equipment')).m) + 1;
    const r = await db.run('INSERT INTO equipment (name, kind, unit, in_shop, active, notes, sort) VALUES (?, ?, ?, ?, ?, ?, ?)', ...fields, sort);
    return db.get('SELECT * FROM equipment WHERE id = ?', r.lastInsertRowid);
  }
  const equipmentKinds = async () => [...new Set((await listEquipment()).map((e) => e.kind))];
  const materials = async () => (await db.all(`SELECT grp FROM price_items WHERE category = 'aggregate' AND grp != '' AND active = 1
      GROUP BY grp ORDER BY MIN(sort)`)).map((m) => m.grp);

  // ---------- one site, one day ----------
  async function siteDay(siteId, day, create = false) {
    let row = await db.get('SELECT * FROM site_days WHERE site_id = ? AND day = ?', siteId, day);
    if (!row && create) {
      await db.run('INSERT INTO site_days (site_id, day) VALUES (?, ?)', siteId, day);
      row = await db.get('SELECT * FROM site_days WHERE site_id = ? AND day = ?', siteId, day);
    }
    if (row) { row.request = parseJson(row.request, {}); row.truck_notes = parseJson(row.truck_notes, {}); }
    return row;
  }
  async function equipmentOnJob(jobId) {
    return db.all('SELECT e.* FROM job_equipment je JOIN equipment e ON e.id = je.equipment_id WHERE je.job_id = ? ORDER BY e.sort, e.name', jobId);
  }
  // ---------- where each machine is ----------
  // A machine stays where it was last sent until it's moved: handed to a site, floated to a site, or sent back to the yard.
  async function machineEvents() {
    const ev = [];
    for (const r of await db.all(`SELECT je.equipment_id, j.scheduled_date AS day, j.site_id, j.id AS job_id FROM job_equipment je
        JOIN jobs j ON j.id = je.job_id WHERE j.status != 'cancelled' AND j.site_id IS NOT NULL`)) ev.push({ ...r, how: 'given', order: 1 });
    // Floats to a site and trips back to the yard (a cancelled float doesn't count).
    for (const r of await db.all(`SELECT m.id, m.equipment_id, m.day, m.site_id, m.job_id, m.place FROM equipment_moves m
        LEFT JOIN jobs j ON j.id = m.job_id WHERE j.id IS NULL OR j.status != 'cancelled'`)) {
      const place = r.site_id ? '' : String(r.place || '');
      ev.push({ ...r, place, how: r.site_id ? (r.job_id ? 'float' : 'moved') : place ? 'elsewhere' : 'yard', order: r.site_id ? 0 : 2, seq: r.id });
    }
    ev.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.order - b.order || (a.seq || 0) - (b.seq || 0)));
    const by = new Map();
    for (const e of ev) (by.get(e.equipment_id) || by.set(e.equipment_id, []).get(e.equipment_id)).push(e);
    return by;
  }
  /**
   * Where a machine is on `day` (or, with inclusive=false, just before it): a site (site_id), somewhere else (place),
   * or the yard (neither); since when, and where it came from.
   */
  const spot = (e) => (e.site_id ? `s${e.site_id}` : e.place ? `p:${e.place}` : 'yard');
  function locate(events, day, inclusive = true) {
    const list = (events || []).filter((e) => (inclusive ? e.day <= day : e.day < day));
    if (!list.length) return { site_id: null, place: '', since: null, from_site_id: null, from_place: '', moved_before: false, how: '' };
    const last = list[list.length - 1];
    let i = list.length - 1;
    while (i > 0 && spot(list[i - 1]) === spot(last)) i--;
    const prev = i > 0 ? list[i - 1] : null;
    return { site_id: last.site_id ?? null, place: last.site_id ? '' : last.place || '', since: list[i].day, how: list[i].how,
      from_site_id: prev?.site_id ?? null, from_place: prev && !prev.site_id ? prev.place || '' : '', moved_before: Boolean(prev) };
  }
  async function siteNames() {
    return new Map((await db.all('SELECT id, name, address FROM sites')).map((s) => [s.id, s]));
  }
  async function whereIs(equipmentId, day) {
    const loc = locate((await machineEvents()).get(Number(equipmentId)), day, false);
    const s = loc.site_id ? (await siteNames()).get(loc.site_id) : null;
    return { ...loc, site_name: s?.name || '', address: s?.address || '' };
  }

  /** Everything the Sites tab shows for a day. */
  async function board(day) {
    const sites = await listSites();
    const jobs = (await dispatch.listJobs({ from: day, to: day })).filter((j) => j.status !== 'cancelled');
    const trucks = await dispatch.listTrucks();
    const people = await dispatch.listDrivers();
    const equipment = await listEquipment();
    const events = await machineEvents();
    const names = await siteNames();
    const nameOf = (id, place = '') => (id ? names.get(id)?.name || 'another site' : place || 'the yard');
    // Who and what is busy that day, and whether for a customer or one of our sites.
    const truckUse = new Map(); const personUse = new Map(); const machineUse = new Map();
    for (const j of jobs) {
      const own = j.job_type === 'site';
      const label = own ? (sites.find((s) => s.id === j.site_id)?.name || j.material || 'Our site') : (j.customer || j.material || `#${j.id}`);
      for (const a of j.assignments.filter((x) => x.status !== 'cancelled')) {
        if (a.truck_id) (truckUse.get(a.truck_id) || truckUse.set(a.truck_id, []).get(a.truck_id)).push({ job_id: j.id, own, label });
        (personUse.get(a.driver_id) || personUse.set(a.driver_id, []).get(a.driver_id)).push({ job_id: j.id, own, label });
      }
      if (own) for (const e of await equipmentOnJob(j.id)) (machineUse.get(e.id) || machineUse.set(e.id, []).get(e.id)).push({ job_id: j.id, own, label });
    }
    const out = [];
    for (const s of sites) {
      const d = await siteDay(s.id, day);
      const job = d?.job_id ? jobs.find((j) => j.id === d.job_id) || null : null;
      const given = job ? {
        trucks: job.assignments.filter((a) => a.status !== 'cancelled' && a.driver_kind !== 'labourer').map((a) => ({ driver_id: a.driver_id, driver_name: a.driver_name,
          truck_id: a.truck_id, truck_unit: a.truck_unit, material: d.truck_notes?.[a.driver_id]?.material || '', loads: d.truck_notes?.[a.driver_id]?.loads || '' })),
        labourers: job.assignments.filter((a) => a.status !== 'cancelled' && a.driver_kind === 'labourer').map((a) => ({ driver_id: a.driver_id, driver_name: a.driver_name })),
        equipment: (await equipmentOnJob(job.id)).map((e) => {
          const was = locate(events.get(e.id), day, false);
          const moved = was.site_id !== s.id;
          const float = moved ? (events.get(e.id) || []).find((x) => x.how === 'float' && x.day === day && x.site_id === s.id) : null;
          return { ...e, from: nameOf(was.site_id, was.place), needs_float: moved, float_job_id: float?.job_id || null };
        }),
        note: job.notes,
      } : null;
      // Machines sitting at this site that day, how long they've been there, and where they came from.
      const onSite = equipment.map((e) => ({ e, loc: locate(events.get(e.id), day, true) })).filter(({ loc }) => loc.site_id === s.id)
        .map(({ e, loc }) => ({ id: e.id, name: e.name, kind: e.kind, unit: e.unit, in_shop: e.in_shop, since: loc.since, since_label: loc.since ? dayLabel(loc.since) : '',
          days: loc.since ? Math.round((Date.parse(day) - Date.parse(loc.since)) / 86400000) : 0,
          how: loc.how, from: loc.moved_before ? nameOf(loc.from_site_id, loc.from_place) : '' }));
      out.push({ site: { ...s, link: linkFor(s) }, day: d, job_id: job?.id || null, given, on_site: onSite, asked: d ? describeNeeds(d.request) : '' });
    }
    const usage = (m, id) => m.get(id) || [];
    return {
      day, day_label: dayLabel(day), next_work_day: nextWorkDay(today()), today: today(),
      sites: out,
      trucks: trucks.map((t) => ({ ...t, use: usage(truckUse, t.id) })),
      people: people.map((p) => ({ id: p.id, name: p.name, kind: p.kind || 'driver', default_truck_id: p.default_truck_id, use: usage(personUse, p.id) })),
      equipment: equipment.map((e) => {
        const loc = locate(events.get(e.id), day, true);
        return { ...e, use: usage(machineUse, e.id), site_id: loc.site_id, place: loc.place, at: loc.site_id ? nameOf(loc.site_id) : loc.place, since_label: loc.since ? dayLabel(loc.since) : '' };
      }),
      truck_types: TRUCK_TYPES, haul_types: HAUL_TYPES, materials: await materials(), slots: SLOTS, ask_time: await getSetting('sites_ask_time', ''),
    };
  }

  // ---------- asking ----------
  function askText(head, site, day) {
    return `Hi ${head.name.split(' ')[0]} - what do you need at ${site.name} on ${dayLabel(day)}? ` +
      `Reply e.g. "tandem AM, mini ex, 2 labourers", or "same", or "nothing". Or tap: ${linkFor(site)}`;
  }
  /** Text the site heads of the active sites (or just `siteIds`) asking what they need on `day`. */
  async function ask(day, { siteIds = null, by = 'Office' } = {}) {
    checkDay(day);
    const results = [];
    for (const s of await listSites()) {
      if (siteIds && !siteIds.includes(s.id)) continue;
      if (!s.head_id || !s.head_phone) { results.push({ site_id: s.id, ok: false, error: 'No site head' }); continue; }
      const head = { name: s.head_name, phone: s.head_phone };
      await siteDay(s.id, day, true);
      try {
        await send(head.phone, askText(head, s, day));
        await db.run(`UPDATE site_days SET asked_at = datetime('now'), status = CASE WHEN status = '' THEN 'asked' ELSE status END WHERE site_id = ? AND day = ?`, s.id, day);
        await db.run(`INSERT INTO messages (driver_id, direction, phone, body) VALUES (NULL, 'out', ?, ?)`, head.phone, askText(head, s, day));
        results.push({ site_id: s.id, ok: true });
      } catch (err) {
        results.push({ site_id: s.id, ok: false, error: err.message });
      }
    }
    return { day, by, results };
  }
  /** Each working day at the time set on Setup (default off): ask about the next working day. */
  async function runScheduledAsk() {
    const time = await getSetting('sites_ask_time', '');
    if (!time) return null;
    const day = today();
    if ([0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay())) return null;
    if (nowHm() < time || (await getSetting('sites_ask_last')) === day) return null;
    await setSetting('sites_ask_last', day);
    return ask(nextWorkDay(day), { by: 'Automatic' });
  }
  async function saveAskTime(t) {
    const time = str(t, 5);
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new SiteError('Time must look like 14:30');
    await setSetting('sites_ask_time', time);
    return time;
  }

  // ---------- answers (text reply, the link, or the office) ----------
  async function saveRequest(siteId, day, { request, text = '', via = 'office' }) {
    checkDay(day);
    const d = await siteDay(siteId, day, true);
    let need = request || parseNeeds(text, await equipmentKinds(), await materials());
    if (need.same) {
      // "Same": what this site asked for (or was given) the working day before.
      const prev = await siteDay(siteId, prevWorkDay(day));
      need = prev?.request && !prev.request.same ? { ...prev.request, same_from: prev.day } : need;
    }
    const replyText = text ? (d.reply_text ? `${d.reply_text}\n${text}` : text).slice(0, 1000) : d.reply_text;
    await db.run(`UPDATE site_days SET request = ?, reply_text = ?, reply_via = ?, replied_at = datetime('now'), status = ? WHERE id = ?`,
      JSON.stringify(need), replyText, via, need.nothing ? 'nothing' : 'replied', d.id);
    return siteDay(siteId, day);
  }

  /**
   * A text from a site head's phone. Returns { reply } when it was a site head answering, or null (not a site head,
   * or nothing was asked) so the usual driver handling carries on.
   */
  async function handleReply(phone, body) {
    const head = await db.get('SELECT * FROM site_heads WHERE phone = ? AND active = 1', phone);
    if (!head || !String(body || '').trim()) return null;
    const asked = await db.all(`SELECT sd.*, s.name AS site_name FROM site_days sd JOIN sites s ON s.id = sd.site_id
        WHERE s.head_id = ? AND s.active = 1 AND sd.asked_at IS NOT NULL AND sd.day >= ? ORDER BY sd.asked_at DESC, sd.day DESC`, head.id, today());
    if (!asked.length) return null;
    // Runs more than one site: the site named in the text, else the one asked most recently.
    const named = asked.find((a) => body.toLowerCase().includes(String(a.site_name).toLowerCase().split(/\s+[-—–]\s+/)[0]));
    const target = named || asked[0];
    const saved = await saveRequest(target.site_id, target.day, { text: body.trim(), via: 'text' });
    await db.run(`INSERT INTO messages (driver_id, direction, phone, body, handled) VALUES (NULL, 'in', ?, ?, 1)`, phone, body.slice(0, 1600));
    const what = describeNeeds(saved.request);
    const first = head.name.split(' ')[0];
    const reply = saved.request.nothing
      ? `Thanks ${first} - nothing needed at ${target.site_name} on ${dayLabel(target.day)}. Text again if that changes.`
      : `Thanks ${first} - got it for ${target.site_name} on ${dayLabel(target.day)}: ${what || body.trim().slice(0, 120)}. We'll text you what's confirmed.`;
    await db.run(`INSERT INTO messages (driver_id, direction, phone, body) VALUES (NULL, 'out', ?, ?)`, phone, reply);
    return { reply };
  }

  // ---------- handing things out ----------
  /**
   * What the office gives a site on a day: { trucks: [{ truck_id, driver_id }], labourers: [driver ids],
   * equipment: [ids], note }. Makes (or updates) the day's "Our site" work order.
   */
  async function give(siteId, day, given, userId = null) {
    checkDay(day);
    const site = await db.get('SELECT s.*, h.name AS head_name, h.phone AS head_phone FROM sites s LEFT JOIN site_heads h ON h.id = s.head_id WHERE s.id = ?', siteId);
    if (!site) throw new SiteError('Site not found');
    const d = await siteDay(siteId, day, true);
    const trucks = (Array.isArray(given.trucks) ? given.trucks : []).filter((t) => t && t.driver_id)
      .map((t) => ({ driver_id: Number(t.driver_id), truck_id: t.truck_id ? Number(t.truck_id) : null,
        material: str(t.material, 100), loads: Math.max(0, Math.min(99, Number(t.loads) || 0)) || '' }));
    const labourers = (Array.isArray(given.labourers) ? given.labourers : []).map(Number).filter(Boolean);
    const equipment = [...new Set((Array.isArray(given.equipment) ? given.equipment : []).map(Number).filter(Boolean))];
    const seen = new Set();
    const assignments = [...trucks, ...labourers.map((id) => ({ driver_id: id, truck_id: null }))].filter((a) => !seen.has(a.driver_id) && seen.add(a.driver_id));
    const note = str(given.note, 800);
    const existing = d.job_id ? await dispatch.getJob(d.job_id) : null;
    if (!assignments.length && !equipment.length && !note) {
      // Nothing given: drop the day's work order if it hasn't gone anywhere yet.
      if (existing && existing.status === 'open' && existing.assignments.every((a) => a.status === 'pending')) {
        await db.run('DELETE FROM job_equipment WHERE job_id = ?', existing.id);
        await dispatch.deleteJob?.(existing.id);
        await db.run('UPDATE site_days SET job_id = NULL WHERE id = ?', d.id);
      }
      const floats = await syncFloats(siteId, day, [], userId);
      return { ...(await board(day)), floats };
    }
    const truckNotes = Object.fromEntries(trucks.filter((t) => t.material || t.loads).map((t) => [t.driver_id, { material: t.material, loads: t.loads }]));
    const units = new Map((await dispatch.listTrucks({ includeInactive: true })).map((t) => [t.id, t.unit]));
    const people = new Map((await dispatch.listDrivers({ includeInactive: true })).map((p) => [p.id, p.name]));
    const hauling = trucks.filter((t) => t.material || t.loads).map((t) => `${units.get(t.truck_id) || people.get(t.driver_id) || 'Truck'}: ${[t.material, t.loads ? `${t.loads} load${t.loads === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}`).join('; ');
    const machineNames = equipment.length ? (await db.all(`SELECT name FROM equipment WHERE id IN (${equipment.map(() => '?').join(',')})`, ...equipment)).map((e) => e.name) : [];
    const data = {
      ...(existing || {}),
      id: existing?.id,
      job_type: 'site',
      scheduled_date: day,
      time_slot: existing?.time_slot || '',
      customer: '',
      customer_phone: '',
      material: `Our site: ${site.name}`,
      to_location: site.address,
      municipality: site.municipality,
      contact_name: site.head_name || '',
      contact_phone: site.head_phone || '',
      details: { ...(existing?.details || {}), site_head: site.head_name || '', equipment: machineNames.join(', '), hauling },
      notes: note,
      assignments: assignments.map(({ driver_id, truck_id }) => ({ driver_id, truck_id })),
    };
    const saved = existing ? await dispatch.saveJob(data, userId) : await dispatch.saveJob(data, userId);
    const jobId = saved.job.id;
    await db.run('UPDATE jobs SET site_id = ? WHERE id = ?', siteId, jobId);
    await db.run('DELETE FROM job_equipment WHERE job_id = ?', jobId);
    for (const id of equipment) await db.run('INSERT INTO job_equipment (job_id, equipment_id) VALUES (?, ?)', jobId, id);
    await db.run('UPDATE site_days SET job_id = ?, truck_notes = ? WHERE id = ?', jobId, JSON.stringify(truckNotes), d.id);
    // Each driver's own load goes in their text (re-sent if it changed after they were texted).
    for (const t of trucks) {
      const note = [t.material, t.loads ? `${t.loads} load${t.loads === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
      await db.run(`UPDATE assignments SET needs_resend = CASE WHEN note != ? AND status IN ('sent','acknowledged','in_progress') THEN 1 ELSE needs_resend END,
          note = ? WHERE job_id = ? AND driver_id = ?`, note, note, jobId, t.driver_id);
    }
    const floats = await syncFloats(siteId, day, equipment, userId);
    return { ...(await board(day)), floats };
  }

  /**
   * Machines given to a site on a day that aren't there yet need delivering: make the float work order for each
   * (from wherever the machine is). A machine taken off again loses its float, if nobody's been texted about it.
   */
  async function syncFloats(siteId, day, equipmentIds, userId = null) {
    const events = await machineEvents();
    const made = [];
    for (const id of equipmentIds) {
      const was = locate(events.get(id), day, false);
      if (was.site_id === siteId) continue; // already there
      const booked = (events.get(id) || []).some((x) => x.how === 'float' && x.day === day && x.site_id === siteId);
      if (!booked) made.push(await bookFloat(siteId, day, id, userId));
    }
    const dropped = [];
    const floats = await db.all('SELECT * FROM equipment_moves WHERE site_id = ? AND day = ? AND job_id IS NOT NULL', siteId, day);
    for (const m of floats) {
      if (equipmentIds.includes(Number(m.equipment_id))) continue;
      const job = await dispatch.getJob(m.job_id);
      if (job && job.status === 'open' && job.assignments.every((a) => a.status === 'pending')) {
        await dispatch.deleteJob(job.id);
        await db.run('DELETE FROM equipment_moves WHERE id = ?', m.id);
        dropped.push(job.id);
      }
    }
    return { made, dropped };
  }

  /** Book the float that moves a machine from where it was to this site, on the day. */
  async function bookFloat(siteId, day, equipmentId, userId = null) {
    checkDay(day);
    const site = await db.get('SELECT * FROM sites WHERE id = ?', siteId);
    const machine = await db.get('SELECT * FROM equipment WHERE id = ?', equipmentId);
    if (!site || !machine) throw new SiteError('Site or equipment not found');
    const was = await whereIs(equipmentId, day);
    const from = was.site_id ? was.address || was.site_name : was.place || YARD;
    const saved = await dispatch.saveJob({
      job_type: 'float', scheduled_date: day, time_slot: 'first', material: machine.name,
      from_location: from || '', to_location: site.address, municipality: site.municipality,
      customer: '', notes: `Move ${machine.name} to our site: ${site.name}${was?.site_name ? ` (from ${was.site_name})` : ''}.`,
      details: { equipment_id: machine.id }, assignments: [],
    }, userId);
    await db.run('UPDATE jobs SET site_id = ? WHERE id = ?', siteId, saved.job.id);
    await db.run('INSERT INTO equipment_moves (equipment_id, day, site_id, job_id) VALUES (?, ?, ?, ?)', machine.id, day, siteId, saved.job.id);
    return saved.job;
  }

  /** Where every machine is today: { equipment_id: { site_id, since } } (Setup → Equipment). */
  async function locations() {
    const events = await machineEvents();
    const day = today();
    return Object.fromEntries((await listEquipment({ all: true })).map((e) => {
      const loc = locate(events.get(e.id), day, true);
      return [e.id, { site_id: loc.site_id, place: loc.place, since: loc.since }];
    }));
  }
  /**
   * Say where a machine really is (e.g. when starting out, or after it was moved without the app): no float is made.
   * site_id null = the yard.
   */
  async function placeMachine(equipmentId, siteId, place = '') {
    const machine = await db.get('SELECT * FROM equipment WHERE id = ?', equipmentId);
    if (!machine) throw new SiteError('Equipment not found');
    const site = siteId ? await db.get('SELECT * FROM sites WHERE id = ?', siteId) : null;
    if (siteId && !site) throw new SiteError('Site not found');
    const where = site ? '' : str(place, 100);
    const now = locate((await machineEvents()).get(machine.id), today(), true);
    if ((now.site_id ?? null) === (site?.id ?? null) && (now.place || '') === where) return { unchanged: true };
    await db.run('INSERT INTO equipment_moves (equipment_id, day, site_id, job_id, place) VALUES (?, ?, ?, NULL, ?)', machine.id, today(), site?.id ?? null, where);
    return { ok: true };
  }

  /** A machine done at a site: back to the yard on `day`, with the float booked to bring it. */
  async function backToYard(siteId, day, equipmentId, userId = null) {
    checkDay(day);
    const site = await db.get('SELECT * FROM sites WHERE id = ?', siteId);
    const machine = await db.get('SELECT * FROM equipment WHERE id = ?', equipmentId);
    if (!site || !machine) throw new SiteError('Site or equipment not found');
    const saved = await dispatch.saveJob({
      job_type: 'float', scheduled_date: day, time_slot: '', material: machine.name,
      from_location: site.address, to_location: YARD, municipality: site.municipality,
      customer: '', notes: `Bring ${machine.name} back to the yard from our site: ${site.name}.`,
      details: { equipment_id: machine.id }, assignments: [],
    }, userId);
    await db.run('INSERT INTO equipment_moves (equipment_id, day, site_id, job_id) VALUES (?, ?, NULL, ?)', machine.id, day, saved.job.id);
    return saved.job;
  }

  /** Text site heads what they're getting (all sites given something that day, or just `siteIds`). */
  /** Site heads only: drivers and labourers hear what they're doing in the morning jobs text (Setup). */
  async function confirm(day, { siteIds = null } = {}) {
    checkDay(day);
    const b = await board(day);
    const results = [];
    for (const row of b.sites) {
      if (siteIds && !siteIds.includes(row.site.id)) continue;
      if (!row.site.head_phone) continue;
      if (!row.given && !(row.day && row.day.status === 'nothing')) continue;
      const first = String(row.site.head_name || '').split(' ')[0];
      let text;
      if (!row.given) text = `Hi ${first} - noted: nothing needed at ${row.site.name} on ${dayLabel(day)}.`;
      else {
        const bits = [
          ...row.given.trucks.map((t) => `${t.truck_unit ? t.truck_unit + ' with ' : ''}${t.driver_name}${t.material || t.loads ? ` (${[t.material, t.loads ? `${t.loads} load${Number(t.loads) === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')})` : ''}`),
          ...row.given.equipment.map((e) => `${e.name}${e.needs_float ? ` (floated from ${e.from})` : ''}`),
          row.given.labourers.length ? row.given.labourers.map((l) => l.driver_name).join(' & ') : '',
        ].filter(Boolean);
        text = `Hi ${first} - for ${row.site.name} on ${dayLabel(day)} you have: ${bits.join(', ') || 'see note'}.${row.given.note ? ' Note: ' + row.given.note : ''}`;
      }
      try {
        await send(row.site.head_phone, text);
        await db.run(`UPDATE site_days SET confirmed_at = datetime('now') WHERE site_id = ? AND day = ?`, row.site.id, day);
        await db.run(`INSERT INTO messages (driver_id, direction, phone, body) VALUES (NULL, 'out', ?, ?)`, row.site.head_phone, text);
        results.push({ site_id: row.site.id, ok: true, text });
      } catch (err) { results.push({ site_id: row.site.id, ok: false, error: err.message }); }
    }
    return { day, results };
  }

  // ---------- the phone page behind the link ----------
  async function pageFor(token) {
    const site = await db.get('SELECT s.*, h.name AS head_name FROM sites s LEFT JOIN site_heads h ON h.id = s.head_id WHERE s.token = ? AND s.active = 1', token);
    if (!site) return null;
    const asked = await db.get('SELECT day FROM site_days WHERE site_id = ? AND asked_at IS NOT NULL AND day >= ? ORDER BY asked_at DESC LIMIT 1', site.id, today());
    const day = asked?.day || nextWorkDay(today());
    return { site, day, day_label: dayLabel(day), current: await siteDay(site.id, day), kinds: await equipmentKinds(), truck_types: TRUCK_TYPES,
      haul_types: HAUL_TYPES, materials: await materials(), slots: SLOTS };
  }

  return {
    askTime: () => getSetting('sites_ask_time', ''), ensureSetup, listHeads, saveHead, listSites, saveSite, listEquipment, saveEquipment, board, ask, runScheduledAsk, saveAskTime,
    saveRequest, handleReply, give, bookFloat, backToYard, locations, placeMachine, confirm, pageFor, whereIs,
  };
}

module.exports = { createSites, findMaterial, HAUL_TYPES, parseNeeds, describeNeeds, nextWorkDay, prevWorkDay, SiteError, TRUCK_TYPES, SLOTS };
