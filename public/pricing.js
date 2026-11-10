/*
 * Automatic pricing for work orders, from the price book (the office price sheets).
 * Shared by the dashboard (job form, Prices tab) and the server (tests, records).
 *
 *   PRICING.calc(job, book) → { lines, notes }
 *   PRICING.merge(currentLines, autoLines) → lines (lines the office typed or changed are kept)
 *   PRICING.totals(lines, hstRate) → { subtotal, hst, total, deposit }
 *
 * book = { items: { key: { price, taxable, name, unit } }, members: [municipalities], hst_rate: 13 }
 * job: the work order fields, plus distance_km, in_town and price_options
 *   price_options: { period: 'week'|'month', off_schedule, member: 'auto'|'yes'|'no', pump_chamber_too, waste, tons, extra_weeks }
 *
 * Rules (from the sheets, agreed with the office):
 *  - Delivery fee by driving km from the starting point; inside Parry Sound town limits = the town price.
 *    "Up to 10 km" includes 10.0 km. Over the last tier (100 km) = price by hand.
 *  - Aggregate: material per load (tandem/triaxle) or per yard; delivery fee per load; +$10 per delivery;
 *    +$10 per triaxle load. Haul-away jobs are priced by hand.
 *  - Bins and toilets: delivery and pick-up are each charged.
 *  - Septic: up to 1000 gal flat; larger tanks pumping + disposal per gallon; non-members of the lagoon pay the
 *    non-member disposal rate per gallon; off-schedule +$100.
 */
(function (root, factory) {
  const pricing = factory();
  if (typeof module === 'object' && module.exports) module.exports = pricing;
  else root.PRICING = pricing;
})(typeof self !== 'undefined' ? self : this, function () {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const num = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const money = (n) => (n == null || n === '' ? '' : '$' + round2(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const parseDetails = (job) => {
    if (job.details && typeof job.details === 'object') return job.details;
    try { return JSON.parse(job.details || '{}') || {}; } catch { return {}; }
  };
  const parseOptions = (job) => {
    if (job.price_options && typeof job.price_options === 'object') return job.price_options;
    try { return JSON.parse(job.price_options || '{}') || {}; } catch { return {}; }
  };

  const DELIVERY_TIERS = [10, 20, 30, 40, 50, 60, 80, 100];

  /** The delivery-fee price item for a trip: { key, label } or { over: true } / null when there's no distance. */
  function deliveryTier(job, book) {
    if (Number(job.in_town) === 1) return { key: 'delivery.town', label: 'within Parry Sound town limits' };
    const km = job.distance_km == null || job.distance_km === '' ? null : Number(job.distance_km);
    if (km == null || !Number.isFinite(km)) return null;
    const tiers = Object.entries(book.items).filter(([k, it]) => /^delivery\.\d+$/.test(k) && it.max_km != null)
      .map(([k, it]) => ({ key: k, max: Number(it.max_km) })).sort((a, b) => a.max - b.max);
    const list = tiers.length ? tiers : DELIVERY_TIERS.map((m) => ({ key: `delivery.${m}`, max: m }));
    const t = list.find((x) => km <= x.max + 1e-9);
    const kmText = `${round2(km).toFixed(1)} km`;
    if (!t) return { over: true, label: `${kmText} — over ${list[list.length - 1].max} km` };
    return { key: t.key, label: `${kmText} (up to ${t.max} km)` };
  }

  /** Find a material in the price book by the name typed on the work order. */
  function findMaterial(book, name) {
    const q = norm(name);
    if (!q) return null;
    const groups = {};
    for (const [key, it] of Object.entries(book.items)) {
      const m = /^agg\.(.+)\.(yard|tandem|triaxle)$/.exec(key);
      if (!m) continue;
      const g = (groups[m[1]] = groups[m[1]] || { slug: m[1], name: it.grp || it.name.split(' — ')[0], keys: {} });
      g.keys[m[2]] = key;
    }
    const all = Object.values(groups);
    const exact = all.find((g) => norm(g.name) === q);
    if (exact) return exact;
    const starts = all.filter((g) => norm(g.name).startsWith(q) || q.startsWith(norm(g.name)));
    return starts.length === 1 ? starts[0] : null;
  }

  const TOILET_ALIASES = {
    standard: 'basic', basic: 'basic', basicwsink: 'basic-w-sink', basicwithsink: 'basic-w-sink',
    recirculatedflush: 'recirculated-flush', flushing: 'recirculated-flush', flush: 'recirculated-flush',
    handicapped: 'handicapped', wheelchairaccessible: 'handicapped', accessible: 'handicapped',
    deluxe: 'deluxe-w-sink-mirror', deluxewsinkmirror: 'deluxe-w-sink-mirror',
    handwashstation: 'handwash-station', handwashstations: 'handwash-station', handwash: 'handwash-station',
  };

  function calc(job, book) {
    if (job.job_type === 'labour') return { lines: [], notes: [] }; // labour work orders aren't priced
    const items = book.items || {};
    const d = parseDetails(job);
    const o = parseOptions(job);
    const lines = [];
    const notes = [];
    const line = (slot, key, qty, extra = {}) => {
      const it = items[key];
      if (!it) { notes.push(`"${key}" is missing from the price book.`); return null; }
      const l = {
        slot, item_key: key, description: it.name, qty: round2(qty), unit: it.unit || '',
        unit_price: it.price == null ? null : Number(it.price), taxable: it.taxable ? 1 : 0, kind: 'charge', auto: 1, note: '', ...extra,
      };
      if (l.unit_price == null) notes.push(`${it.name}: no set price — enter it by hand.`);
      lines.push(l);
      return l;
    };
    const trip = (slot, word, qty) => {
      const t = deliveryTier(job, book);
      if (!t) { notes.push(`Enter the address (or drop a pin) to add the ${word.toLowerCase()} fee.`); return null; }
      if (t.over) {
        lines.push({ slot, item_key: '', description: `${word} — ${t.label}`, qty, unit: 'trip', unit_price: null, taxable: 1, kind: 'charge', auto: 1, note: '' });
        notes.push(`Over 100 km: enter the ${word.toLowerCase()} price by hand.`);
        return null;
      }
      return line(slot, t.key, qty, { description: `${word} — ${t.label}` });
    };

    if (job.job_type === 'haul') {
      if (d.direction === 'Haul away from site') {
        notes.push('Haul-away jobs are priced by hand — add lines below.');
        return { lines, notes };
      }
      const aggs = [
        { n: 1, name: job.material, loads: num(job.loads_planned), yards: num(job.quantity), truck: d.truck },
        { n: 2, name: d.aggregate2_type, loads: num(d.aggregate2_loads), yards: num(d.aggregate2_yards), truck: d.aggregate2_truck },
      ].filter((a) => a.name || a.loads || a.yards);
      for (const a of aggs) {
        const mat = findMaterial(book, a.name);
        const truck = String(a.truck || '').toLowerCase();
        const byLoad = a.loads > 0 && (truck === 'tandem' || truck === 'triaxle');
        const stop = Boolean(d.until_stop);
        const loads = a.loads || (stop ? 1 : 0);
        if (!a.name) { notes.push(`Aggregate ${a.n}: pick the aggregate type.`); continue; }
        if (!mat) notes.push(`"${a.name}" isn't in the price book — pick a material from the list, or price it by hand.`);
        else if (byLoad || (stop && (truck === 'tandem' || truck === 'triaxle'))) {
          line(`agg${a.n}.material`, mat.keys[truck], loads, stop ? { note: 'per load — until the site says stop' } : {});
        } else if (a.yards > 0) {
          line(`agg${a.n}.material`, mat.keys.yard, a.yards);
        } else if (truck === 'h&g') {
          notes.push(`${a.name}: H&G loads are priced per yard — enter the # of yards.`);
        } else {
          notes.push(`${a.name}: enter the # of loads and circle Tandem or Triaxle, or enter the # of yards.`);
        }
        const deliveries = Math.max(loads, 1);
        const fee = trip(`agg${a.n}.delivery`, 'Delivery', deliveries);
        if (fee && stop) fee.note = 'per load — until the site says stop';
        line(`agg${a.n}.extra`, 'agg.extra_per_delivery', deliveries);
        if (truck === 'triaxle' && fee) line(`agg${a.n}.triaxle`, 'delivery.triaxle_extra', deliveries);
      }
      return { lines, notes };
    }

    if (job.job_type === 'bin') {
      const service = d.service || 'Deliver bin';
      const size = num(job.material);
      const metal = o.waste === 'metal';
      const depositKey = metal ? 'bin.deposit.scrap' : size >= 20 ? 'bin.deposit.large' : size >= 12 ? 'bin.deposit.medium' : size > 0 ? 'bin.deposit.small' : null;
      const delivers = ['Deliver bin', 'Empty & return', 'H&G'].includes(service);
      const picksUp = ['Empty & return', 'Empty & no return', 'H&G'].includes(service);
      if (picksUp) trip('bin.pickup', 'Pick-up', 1);
      if (delivers) trip('bin.delivery', 'Delivery', 1);
      if (picksUp) {
        const waste = { mixed: 'bin.waste.mixed', concrete: 'bin.waste.concrete', asbestos: 'bin.waste.asbestos', metal: 'bin.waste.metal' }[o.waste || 'mixed'];
        line('bin.disposal', waste, num(o.tons), { note: num(o.tons) ? '' : 'tons from the scale ticket' });
        if (num(o.extra_weeks)) line('bin.rental', 'bin.rental_week', num(o.extra_weeks), { note: 'weeks after the first (first week free)' });
      }
      if (service === 'Deliver bin') {
        if (depositKey) line('bin.deposit', depositKey, 1, { kind: 'deposit' });
        else notes.push('Enter the bin size to show the deposit.');
      }
      return { lines, notes };
    }

    if (job.job_type === 'septic') {
      const gal = num(d.tank_size);
      const members = (book.members || []).map(norm);
      const muni = norm(job.municipality);
      const member = o.member === 'yes' ? true : o.member === 'no' ? false : muni ? members.includes(muni) : null;
      if (d.tank_type === 'Pump chamber') {
        line('septic.main', 'septic.pump_chamber', 1);
      } else if (member === null) {
        notes.push('Enter the municipality — non-members of the lagoon pay a different disposal rate.');
      } else if (!gal) {
        notes.push('Enter the approx. tank size in gallons to price the pump-out.');
      } else if (member && gal <= 1000) {
        line('septic.main', 'septic.base', 1);
      } else {
        line('septic.pump', 'septic.pump_per_gal', gal);
        line('septic.disposal', member ? 'septic.disposal_member' : 'septic.disposal_nonmember', gal, member ? {} : { note: 'non-member of the lagoon' });
      }
      if (o.pump_chamber_too && d.tank_type !== 'Pump chamber') line('septic.chamber', 'septic.pump_chamber_with', 1);
      if (o.off_schedule) line('septic.off_schedule', 'septic.off_schedule', 1);
      return { lines, notes };
    }

    if (job.job_type === 'toilet') {
      const tripType = d.trip || 'Deliver';
      const period = o.period === 'month' ? 'month' : 'week';
      let units = 0;
      for (const i of [1, 2, 3]) {
        const type = d[`toilet${i}_type`];
        const qty = num(d[`toilet${i}_qty`]) || (type ? 1 : 0);
        if (!type) continue;
        units += qty;
        if (tripType !== 'Deliver') continue;
        const slug = TOILET_ALIASES[norm(type)];
        const key = slug ? `toilet.${slug}.${period}` : null;
        if (!key || !items[key]) { notes.push(`"${type}" isn't in the price book — pick a toilet type from the list.`); continue; }
        line(`toilet${i}`, key, qty);
      }
      if (tripType === 'Deliver') {
        trip('toilet.delivery', 'Delivery', 1);
        trip('toilet.pickup', 'Pick-up', 1);
        const p = lines.find((l) => l.slot === 'toilet.pickup');
        if (p) p.note = 'billed on the first invoice';
      } else if (tripType === 'Service') {
        line('toilet.service', 'toilet.extra_service', Math.max(units, 1));
      }
      if (o.off_schedule) line('toilet.off_schedule', 'toilet.off_schedule', 1);
      return { lines, notes };
    }

    notes.push('Add prices from the price book below.');
    return { lines, notes };
  }

  /** Recalculated lines replace the automatic ones; lines the office added, changed or removed by hand stay that way. */
  function merge(current, auto, removedSlots = []) {
    const manual = (current || []).filter((l) => !Number(l.auto));
    const taken = new Set([...manual.map((l) => l.slot).filter(Boolean), ...removedSlots]);
    return [...auto.filter((l) => !taken.has(l.slot)), ...manual];
  }

  const amount = (l) => (l.unit_price == null || l.unit_price === '' ? 0 : round2(Number(l.qty || 0) * Number(l.unit_price)));

  function totals(lines, hstRate = 13) {
    let subtotal = 0;
    let taxable = 0;
    let deposit = 0;
    let unpriced = 0;
    for (const l of lines || []) {
      if (l.unit_price == null || l.unit_price === '') { unpriced++; continue; }
      const a = amount(l);
      if (l.kind === 'deposit') { deposit += a; continue; }
      subtotal += a;
      if (Number(l.taxable)) taxable += a;
    }
    const hst = round2(taxable * Number(hstRate) / 100);
    return { subtotal: round2(subtotal), hst, total: round2(subtotal + hst), deposit: round2(deposit), unpriced };
  }

  return { calc, merge, totals, amount, money, round2, deliveryTier, findMaterial, DELIVERY_TIERS };
});
