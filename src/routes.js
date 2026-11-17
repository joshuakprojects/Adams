/**
 * Route planning (Board → Plan route): put a day's stops (septic pump-outs by default) in the shortest order,
 * starting and ending at the yard.
 *
 * Customers' times come first: First thing, then AM, then PM, then Any time (the Board's order), and the stops
 * inside each are put in the best order, each part starting where the last one ended. When every stop shares one
 * time, Google picks the order on real roads; otherwise (or with no Google key) the order is worked out from the
 * map points and Google, when it can, measures the real driving km and time for it.
 */
const config = require('./config');
const sms = require('./sms');

const SLOTS = [['first', 'First thing'], ['am', 'AM'], ['pm', 'PM'], ['any', 'Any time']];
const slotOf = (j) => (['first', 'am', 'pm'].includes(j.time_slot) ? j.time_slot : 'any');

/** Straight-line km between two map points. */
function km(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Best order of `stops` starting at `start` and ending at `end` (or anywhere when end is null):
 * nearest stop first, then swap pairs (2-opt) while that shortens the drive.
 */
function orderStops(start, stops, end = null) {
  if (stops.length < 2) return stops.slice();
  const left = stops.slice();
  const path = [];
  let here = start;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (km(here, left[i]) < km(here, left[best])) best = i;
    here = left.splice(best, 1)[0];
    path.push(here);
  }
  const length = (p) => p.reduce((sum, s, i) => sum + km(i ? p[i - 1] : start, s), 0) + (end ? km(p[p.length - 1], end) : 0);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 0; i < path.length - 1; i++) {
      for (let k = i + 1; k < path.length; k++) {
        const next = [...path.slice(0, i), ...path.slice(i, k + 1).reverse(), ...path.slice(k + 1)];
        if (length(next) + 1e-9 < length(path)) { path.splice(0, path.length, ...next); improved = true; }
      }
    }
  }
  return path;
}

function createRoutes(db, dispatch, distance, { yard = config.maps.yard } = {}) {
  async function pointFor(job) {
    if (job.lat != null && job.lng != null) return { lat: Number(job.lat), lng: Number(job.lng) };
    if (!distance.hasKey || !job.to_location) return null;
    try {
      const g = await distance.geocode([job.to_location, job.municipality].filter(Boolean).join(', '));
      await db.run('UPDATE jobs SET lat = ?, lng = ? WHERE id = ? AND lat IS NULL', g.lat, g.lng, job.id);
      return { lat: g.lat, lng: g.lng };
    } catch { return null; }
  }

  /** The day's jobs a route can be planned for: open, of these types, optionally one driver's. */
  async function candidates(date, { types = ['septic'], driverId = null } = {}) {
    const jobs = (await dispatch.listJobs({ from: date, to: date })).filter((j) => j.status === 'open' && !Number(j.draft)
      && (!types.length || types.includes(j.job_type))
      && (!driverId || j.assignments.some((a) => a.driver_id === Number(driverId) && a.status !== 'cancelled')));
    return jobs;
  }

  /** Who has jobs that day (for the driver picker). */
  async function drivers(date, types) {
    const jobs = await candidates(date, { types });
    const by = new Map();
    for (const j of jobs) for (const a of j.assignments.filter((x) => x.status !== 'cancelled')) by.set(a.driver_id, { id: a.driver_id, name: a.driver_name, jobs: (by.get(a.driver_id)?.jobs || 0) + 1 });
    return [...by.values()];
  }

  async function plan({ date, types = ['septic'], driverId = null } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw Object.assign(new Error('Pick a day'), { status: 400 });
    const jobs = await candidates(date, { types, driverId });
    let start;
    try { start = distance.hasKey ? await distance.geocode(yard) : null; } catch { start = null; }
    if (!start) start = config.maps.yardPoint || { lat: 45.3447, lng: -80.0345 }; // 116 William St, Parry Sound
    const placed = [];
    const unplaced = [];
    for (const j of jobs) {
      const p = await pointFor(j);
      const stop = { id: j.id, customer: j.customer, address: [j.to_location, j.municipality].filter(Boolean).join(', '), slot: slotOf(j),
        drivers: j.assignments.filter((a) => a.status !== 'cancelled').map((a) => a.driver_name), current: j.route_order ?? null };
      if (p) placed.push({ ...stop, ...p }); else unplaced.push(stop);
    }
    const groups = SLOTS.map(([k]) => placed.filter((s) => s.slot === k)).filter((g) => g.length);
    let ordered = [];
    let method = 'map';
    let road = null;
    if (groups.length === 1 && placed.length > 1 && placed.length <= 25 && distance.hasKey) {
      // One time window: Google chooses the order on real roads.
      try {
        road = await distance.routeThrough([start, ...placed, start], { optimize: true });
        if (road.optimized && road.legs?.length === placed.length + 1) {
          ordered = road.order.map((i) => placed[i]);
          method = 'google';
        } else road = null;
      } catch { road = null; }
    }
    if (!ordered.length) {
      let here = start;
      groups.forEach((g, gi) => {
        const part = orderStops(here, g, gi === groups.length - 1 ? start : null);
        ordered.push(...part);
        here = part[part.length - 1] || here;
      });
      if (distance.hasKey && ordered.length && ordered.length <= 25) {
        try { road = await distance.routeThrough([start, ...ordered, start]); method = 'map+google'; } catch { road = null; }
      }
    }
    // Leg by leg: real roads when Google measured them, else straight line × 1.3 (roads wind around the lakes).
    const legs = road?.legs?.length === ordered.length + 1 ? road.legs.map((l) => ({ km: l.meters / 1000, min: l.seconds / 60, road: true }))
      : [...ordered, null].map((s, i) => {
        const a = i ? ordered[i - 1] : start;
        const b = s || start;
        const k = km(a, b) * 1.3;
        return { km: k, min: (k / 60) * 60, road: false };
      });
    const before = await currentLength(start, placed);
    const round1 = (n) => Math.round(n * 10) / 10;
    return {
      date, types, driver_id: driverId ? Number(driverId) : null, method, yard,
      stops: ordered.map((s, i) => ({ ...s, n: i + 1, leg_km: round1(legs[i].km), leg_min: Math.round(legs[i].min) })),
      back_km: round1(legs[legs.length - 1]?.km || 0), back_min: Math.round(legs[legs.length - 1]?.min || 0),
      total_km: round1(legs.reduce((n, l) => n + l.km, 0)), total_min: Math.round(legs.reduce((n, l) => n + l.min, 0)),
      straight_before_km: before, straight_after_km: round1(lengthOf(start, ordered)),
      road: legs.every((l) => l.road), unplaced,
      maps_links: mapsLinks(yard, ordered),
    };
  }

  // Straight-line length of the current Board order (to show what the plan saves).
  function lengthOf(start, list) { return list.reduce((n, s, i) => n + km(i ? list[i - 1] : start, s), 0) + (list.length ? km(list[list.length - 1], start) : 0); }
  async function currentLength(start, placed) {
    const order = [...placed].sort((a, b) => SLOTS.findIndex(([k]) => k === a.slot) - SLOTS.findIndex(([k]) => k === b.slot) || (a.current ?? 9999) - (b.current ?? 9999) || a.id - b.id);
    return Math.round(lengthOf(start, order) * 10) / 10;
  }

  /** Google Maps directions links: yard → stops → yard, 9 stops per link (Google's limit for a shared link). */
  function mapsLinks(start, stops) {
    const out = [];
    for (let i = 0; i < stops.length; i += 9) {
      const part = stops.slice(i, i + 9);
      const from = i ? `${part[0].lat},${part[0].lng}` : start;
      const rest = (i ? part.slice(1) : part).map((s) => `${s.lat},${s.lng}`);
      const to = i + 9 >= stops.length ? start : rest.pop();
      out.push(`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}`
        + (rest.length ? `&waypoints=${encodeURIComponent(rest.join('|'))}` : '') + '&travelmode=driving');
    }
    return out;
  }

  /** Save the order (job ids, first stop first): the Board, the work order list and the drivers' day text follow it. */
  async function save(date, ids, userId = null) {
    const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
    let n = 0;
    for (const id of list) {
      const j = await db.get('SELECT id, scheduled_date FROM jobs WHERE id = ?', id);
      if (!j || j.scheduled_date !== date) continue;
      await db.run('UPDATE jobs SET route_order = ? WHERE id = ?', ++n, id);
    }
    if (n) await dispatch.logHistory(list[0], 'Route planned', `${n} stop${n === 1 ? '' : 's'} on ${sms.formatDate(date)}: ${list.map((i) => '#' + i).join(' → ')}`);
    void userId;
    return { saved: n };
  }

  return { plan, save, drivers, candidates };
}

module.exports = { createRoutes, orderStops, km };
