const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const PRICING = require('../public/pricing');
const { seedItems, LAGOON_MEMBERS } = require('../src/priceSeed');
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const { createDistance, pointInPolygon, municipalityFrom } = require('../src/distance');
const { runAs } = require('../src/actor');

function book() {
  const items = {};
  for (const it of seedItems()) items[it.key] = it;
  return { items, members: LAGOON_MEMBERS, hst_rate: 13 };
}
const B = book();
const price = (job) => {
  const { lines, notes } = PRICING.calc(job, B);
  return { lines, notes, t: PRICING.totals(lines, 13), by: Object.fromEntries(lines.map((l) => [l.slot, l])) };
};

test('aggregate: per triaxle load + delivery per load + $10 per delivery + $10 triaxle', () => {
  const r = price({ job_type: 'haul', material: 'A Gravel 3/4"', loads_planned: 3, details: { truck: 'Triaxle' }, distance_km: 23.4, in_town: 0 });
  assert.equal(r.by['agg1.material'].unit_price, 500);
  assert.equal(r.by['agg1.material'].qty, 3);
  assert.equal(r.by['agg1.delivery'].unit_price, 130); // up to 30 km
  assert.equal(r.by['agg1.delivery'].qty, 3);
  assert.match(r.by['agg1.delivery'].description, /23\.4 km \(up to 30 km\)/);
  assert.equal(r.by['agg1.extra'].unit_price, 10);
  assert.equal(r.by['agg1.triaxle'].unit_price, 10);
  // 3×500 + 3×130 + 3×10 + 3×10 = 1950; HST 253.50
  assert.deepEqual([r.t.subtotal, r.t.hst, r.t.total], [1950, 253.5, 2203.5]);
});

test('aggregate: by the yard, tandem, in town, tier edges, over 100 km, second line', () => {
  let r = price({ job_type: 'haul', material: 'screened topsoil', quantity: '10', details: {}, in_town: 1, distance_km: 2 });
  assert.equal(r.by['agg1.material'].unit_price, 55);
  assert.equal(r.by['agg1.material'].qty, 10);
  assert.equal(r.by['agg1.delivery'].unit_price, 85, 'inside town limits');
  assert.equal(r.by['agg1.delivery'].qty, 1);
  assert.equal(r.by['agg1.triaxle'], undefined);
  r = price({ job_type: 'haul', material: 'Sand Fill', loads_planned: 1, details: { truck: 'Tandem' }, distance_km: 10, in_town: 0 });
  assert.equal(r.by['agg1.material'].unit_price, 210);
  assert.equal(r.by['agg1.delivery'].unit_price, 95, '10.0 km is "up to 10 km"');
  r = price({ job_type: 'haul', material: 'Sand Fill', loads_planned: 1, details: { truck: 'Tandem' }, distance_km: 10.1, in_town: 0 });
  assert.equal(r.by['agg1.delivery'].unit_price, 110);
  r = price({ job_type: 'haul', material: 'Sand Fill', loads_planned: 1, details: { truck: 'Tandem' }, distance_km: 130, in_town: 0 });
  assert.equal(r.by['agg1.delivery'].unit_price, null);
  assert.ok(r.notes.some((n) => /Over 100 km/.test(n)));
  r = price({ job_type: 'haul', material: '2" minus', loads_planned: 2, distance_km: 45,
    details: { truck: 'Tandem', aggregate2_type: 'Pea Gravel', aggregate2_loads: 1, aggregate2_truck: 'Triaxle' } });
  assert.equal(r.by['agg1.material'].unit_price, 320, '"2" minus" finds 2" Minus (B Stone)');
  assert.equal(r.by['agg2.material'].unit_price, 1015);
  assert.equal(r.by['agg2.delivery'].unit_price, 175);
  r = price({ job_type: 'haul', material: 'Moon rock', loads_planned: 1, details: { truck: 'Tandem' }, distance_km: 5 });
  assert.ok(r.notes.some((n) => /isn't in the price book/.test(n)));
  r = price({ job_type: 'haul', material: 'Fill', details: { direction: 'Haul away from site' } });
  assert.equal(r.lines.length, 0);
  assert.ok(r.notes.some((n) => /priced by hand/.test(n)));
});

test('septic: members flat up to 1000 gal, per gallon above, non-members per gallon, extras', () => {
  let r = price({ job_type: 'septic', municipality: 'Seguin', details: { tank_size: '1000 gal', tank_type: 'Septic' } });
  assert.equal(r.by['septic.main'].unit_price, 395.57);
  assert.equal(r.t.total, 446.99, '$395.57 + 13% HST (the sheet rounds this to $447.00)');
  r = price({ job_type: 'septic', municipality: 'McDougall', details: { tank_size: '1,500 gallons' } });
  assert.equal(PRICING.amount(r.by['septic.pump']), 240);
  assert.equal(PRICING.amount(r.by['septic.disposal']), 300);
  assert.equal(r.t.subtotal, 540, 'sheet: 1500 gal subtotal $540');
  r = price({ job_type: 'septic', municipality: 'Huntsville', details: { tank_size: '1200' } });
  assert.equal(r.by['septic.disposal'].unit_price, 1.24);
  assert.equal(r.t.subtotal, 1680); // 1200 × (0.16 + 1.24)
  r = price({ job_type: 'septic', municipality: 'Seguin', details: { tank_size: '1000' }, price_options: { off_schedule: true, pump_chamber_too: true } });
  assert.equal(r.t.subtotal, 595.57);
  r = price({ job_type: 'septic', municipality: '', details: { tank_size: '1000' } });
  assert.ok(r.notes.some((n) => /municipality/.test(n)));
  r = price({ job_type: 'septic', municipality: 'Seguin', details: { tank_type: 'Pump chamber' } });
  assert.equal(r.t.total, 226);
});

test('bins and toilets: delivery and pick-up each charged; deposits kept out of the total', () => {
  let r = price({ job_type: 'bin', material: '20 yd', details: { service: 'Deliver bin' }, distance_km: 15 });
  assert.equal(r.by['bin.delivery'].unit_price, 110);
  assert.equal(r.by['bin.deposit'].unit_price, 1000);
  assert.equal(r.t.subtotal, 110);
  assert.equal(r.t.deposit, 1000);
  r = price({ job_type: 'bin', material: '14 yd', details: { service: 'Empty & return' }, distance_km: 15, price_options: { tons: 2.5, waste: 'mixed', extra_weeks: 2 } });
  assert.equal(r.by['bin.pickup'].unit_price, 110);
  assert.equal(r.by['bin.delivery'].unit_price, 110);
  assert.equal(PRICING.amount(r.by['bin.disposal']), 462.5);
  assert.equal(PRICING.amount(r.by['bin.rental']), 120);
  r = price({ job_type: 'toilet', details: { trip: 'Deliver', toilet1_type: 'Standard', toilet1_qty: 2, toilet2_type: 'Deluxe w/sink & mirror', toilet2_qty: 1 },
    price_options: { period: 'month' }, in_town: 1 });
  assert.equal(r.by.toilet1.unit_price, 180);
  assert.equal(r.by.toilet1.qty, 2);
  assert.equal(r.by.toilet2.unit_price, 375);
  assert.equal(r.by['toilet.delivery'].unit_price, 85);
  assert.equal(r.by['toilet.pickup'].unit_price, 85);
  assert.equal(r.t.subtotal, 360 + 375 + 170);
  r = price({ job_type: 'toilet', details: { trip: 'Service', toilet1_type: 'Basic', toilet1_qty: 3 } });
  assert.equal(PRICING.amount(r.by['toilet.service']), 255);
});

test('recalculating keeps the lines the office changed or added', () => {
  const auto = price({ job_type: 'haul', material: 'Sand Fill', loads_planned: 1, details: { truck: 'Tandem' }, distance_km: 5 }).lines;
  const edited = auto.map((l) => (l.slot === 'agg1.delivery' ? { ...l, unit_price: 50, auto: 0 } : l));
  edited.push({ description: 'Spread with loader', qty: 1, unit_price: 75, taxable: 1, auto: 0, kind: 'charge' });
  const again = price({ job_type: 'haul', material: 'Sand Fill', loads_planned: 2, details: { truck: 'Tandem' }, distance_km: 5 }).lines;
  const merged = PRICING.merge(edited, again);
  assert.equal(merged.filter((l) => l.slot === 'agg1.delivery').length, 1);
  assert.equal(merged.find((l) => l.slot === 'agg1.delivery').unit_price, 50);
  assert.equal(merged.find((l) => l.slot === 'agg1.material').qty, 2);
  assert.ok(merged.some((l) => l.description === 'Spread with loader'));
});

test('town boundary and municipality names', () => {
  assert.equal(pointInPolygon(45.3447, -80.0345), true, '116 William St is in town');
  assert.equal(pointInPolygon(45.29, -79.9), false, 'Seguin');
  assert.equal(municipalityFrom([{ long_name: 'The Archipelago', types: ['administrative_area_level_3'] }]), 'Archipelago');
  assert.equal(municipalityFrom([{ long_name: 'Township of Carling', types: ['administrative_area_level_3'] }]), 'Carling');
});

function fakeGoogle() {
  const calls = [];
  const places = {
    '116 william st': { lat: 45.3447, lng: -80.0345, muni: 'Parry Sound' },
    '45 bay rd': { lat: 45.40, lng: -79.95, muni: 'McDougall' },
  };
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.includes('geocode/json?region')) {
      const q = decodeURIComponent(url.match(/address=([^&]+)/)[1]).toLowerCase();
      const hit = Object.entries(places).find(([k]) => q.startsWith(k));
      if (!hit) return { json: async () => ({ status: 'ZERO_RESULTS', results: [] }) };
      return { json: async () => ({ status: 'OK', results: [{ formatted_address: q, geometry: { location: { lat: hit[1].lat, lng: hit[1].lng } },
        address_components: [{ long_name: hit[1].muni, types: ['administrative_area_level_3'] }] }] }) };
    }
    if (url.includes('latlng=')) return { json: async () => ({ status: 'OK', results: [{ address_components: [{ long_name: 'Seguin', types: ['administrative_area_level_3'] }] }] }) };
    if (url.includes('computeRoutes')) {
      const b = JSON.parse(opts.body);
      assert.equal(opts.headers['X-Goog-FieldMask'], 'routes.distanceMeters');
      const lat = b.destination.location.latLng.latitude;
      return { ok: true, json: async () => ({ routes: [{ distanceMeters: lat > 45.39 ? 17260 : 8040 }] }) };
    }
    throw new Error('unexpected ' + url);
  };
  return { calls, fetchImpl };
}

test('distance: address or pin, town check, cached, clear errors', async (t) => {
  const db = await testDb(t);
  const g = fakeGoogle();
  const dist = createDistance(db, { key: 'k', fetchImpl: g.fetchImpl });
  const a = await dist.measure({ from: '116 William St, Parry Sound', address: '45 Bay Rd, McDougall' });
  assert.deepEqual([a.km, a.in_town, a.municipality, a.mode], [17.3, 0, 'McDougall', 'address']);
  const n = g.calls.length;
  await dist.measure({ from: '116 William St, Parry Sound', address: '45 Bay Rd, McDougall' });
  assert.equal(g.calls.length, n, 'second lookup comes from the cache');
  const p = await dist.measure({ from: '116 William St, Parry Sound', lat: 45.345, lng: -80.03 });
  assert.deepEqual([p.km, p.in_town, p.mode], [8, 1, 'pin']);
  await assert.rejects(() => dist.measure({ from: '116 William St, Parry Sound', address: 'Nowhere Lane' }), /couldn't find/);
  const nokey = createDistance(db, { key: '', fetchImpl: g.fetchImpl });
  await assert.rejects(() => nokey.measure({ from: 'x', address: 'y' }), /GOOGLE_MAPS_SERVER_KEY/);
});

async function app(t) {
  const db = await testDb(t);
  const d = createDispatch(db, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  await d.prices.seed();
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  await createUser(db, { email: 'josh@adamsbros.ca', name: 'Josh', password: 'password123', role: 'admin' });
  await createUser(db, { email: 'dispatch@test.ca', name: 'Danielle', password: 'password123', role: 'dispatcher' });
  await createUser(db, { email: 'office@test.ca', name: 'Olive', password: 'password123', role: 'office' });
  const g = fakeGoogle();
  const server = createApp({ db, dispatch: d, distance: createDistance(db, { key: 'k', fetchImpl: g.fetchImpl }) }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const as = async (email, password = 'password123') => {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (login.status !== 200) return null;
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    return async (method, p, body) => {
      const r = await fetch(base + '/api' + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
  };
  return { db, d, dave, as };
}

test('roles: office saves work orders but cannot text or assign; only the owner manages logins', async (t) => {
  const { d, dave, as } = await app(t);
  const office = await as('office@test.ca');
  const disp = await as('dispatch@test.ca');
  const owner = await as('josh@adamsbros.ca');
  const me = (await office('GET', '/me')).body;
  assert.deepEqual([me.can.role, me.can.dispatch, me.can.admin, me.can.owner], ['office', false, false, false]);
  assert.equal((await owner('GET', '/me')).body.can.owner, true);

  // Office creates a job: drivers and "text now" are ignored.
  const made = await office('POST', '/jobs', { job_type: 'septic', scheduled_date: '2026-11-12', customer: 'Jane', municipality: 'Seguin', customer_phone: '705-555-0199', to_location: '5 Lake Rd',
    details: { tank_size: '1000' }, assignments: [{ driver_id: dave.id }], send_now: true,
    lines: [{ slot: 'septic.main', item_key: 'septic.base', description: 'Septic pump-out — up to 1000 gallon tank', qty: 1, unit_price: 395.57, taxable: 1, auto: 1 }] });
  assert.equal(made.status, 200);
  assert.equal(made.body.job.assignments.length, 0);
  assert.equal(made.body.job.totals.total, 446.99);
  assert.equal(made.body.job.quoted_price, '$446.99');
  const id = made.body.job.id;
  assert.equal((await office('POST', `/jobs/${id}/send`, {})).status, 403);
  assert.equal((await office('GET', '/records')).status, 403);
  assert.equal((await office('GET', '/messages')).status, 403);
  assert.equal((await office('POST', '/drivers', { name: 'X', phone: '705-555-0000' })).status, 403);
  assert.equal((await office('POST', '/prices', { changes: [] })).status, 403);
  assert.equal((await office('GET', '/users')).status, 403);
  // Dispatcher assigns and texts; office editing later keeps the drivers.
  await disp('PUT', `/jobs/${id}`, { ...made.body.job, assignments: [{ driver_id: dave.id }] });
  assert.equal((await disp('POST', `/jobs/${id}/send`, {})).status, 200);
  const kept = await office('PUT', `/jobs/${id}`, { ...(await d.getJob(id)), notes: 'Dog in yard', assignments: [] });
  assert.equal(kept.body.job.assignments.length, 1);
  assert.equal((await disp('POST', '/settings', {})).status, 403);
  assert.equal((await disp('GET', '/users')).status, 403);

  // Owner adds, changes and removes logins.
  const u = await owner('POST', '/users', { email: 'Kim@AdamsBros.ca', name: 'Kim', password: 'longenough', role: 'office' });
  assert.equal(u.body.email, 'kim@adamsbros.ca');
  assert.equal((await owner('POST', '/users', { email: 'kim@adamsbros.ca', name: 'Kim', password: 'longenough' })).status, 400);
  const kim = await as('kim@adamsbros.ca', 'longenough');
  assert.equal((await kim('GET', '/me')).body.can.role, 'office');
  await owner('PUT', `/users/${u.body.id}`, { role: 'dispatcher' });
  assert.equal((await kim('GET', '/me')).body.can.role, 'dispatcher');
  await owner('PUT', `/users/${u.body.id}`, { password: 'brand-new-pass' });
  assert.equal((await kim('GET', '/me')).status, 401, 'password reset logs them out');
  assert.ok(await as('kim@adamsbros.ca', 'brand-new-pass'));
  assert.equal((await owner('PUT', `/users/${(await owner('GET', '/me')).body.user.id}`, { role: 'office' })).status, 400);
  assert.equal((await owner('DELETE', `/users/${u.body.id}`)).status, 200);
  assert.equal(await as('kim@adamsbros.ca', 'brand-new-pass'), null, 'removed login cannot sign in');
  assert.equal((await owner('GET', '/users')).body.length, 3);
});

test('price book: everyone reads, admins edit, changes logged, old jobs keep their price', async (t) => {
  const { d, as } = await app(t);
  const office = await as('office@test.ca');
  const admin = await as('josh@adamsbros.ca');
  const list = (await office('GET', '/prices')).body;
  const base = list.items.find((i) => i.key === 'septic.base');
  assert.equal(base.price, 395.57);
  assert.equal(list.settings.start_address, '116 William St, Parry Sound, ON P2A 1V4');
  const job = (await runAs('Josh', () => d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-12', customer: 'Old price',
    lines: [{ item_key: 'septic.base', description: base.name, qty: 1, unit_price: base.price, taxable: 1 }] }))).job;

  const saved = await admin('POST', '/prices', { changes: [{ id: base.id, price: '410.00' }] });
  assert.equal(saved.body[0].price, 410);
  assert.equal((await admin('GET', '/prices/changes')).body[0].change, '$395.57 → $410.00');
  assert.equal((await admin('GET', '/prices/changes')).body[0].actor, 'Josh');
  assert.equal((await d.getJob(job.id)).lines[0].unit_price, 395.57, 'old job keeps its price');
  assert.equal((await office('GET', '/prices/book')).body.items['septic.base'].price, 410);
  const added = await admin('POST', '/prices', { changes: [{ category: 'other', name: 'Loader spreading', unit: 'hour', price: 120 }] });
  assert.match(added.body[0].key, /^other\.custom\.loader-spreading/);
  assert.equal((await admin('POST', '/prices', { changes: [{ id: base.id, price: 'abc' }] })).status, 400);
  const s = await admin('POST', '/prices/settings', { start_address: '1 Yard Rd, Parry Sound', hst_rate: 13 });
  assert.equal(s.body.start_address, '1 Yard Rd, Parry Sound');

  // Distance endpoint uses the starting address unless another is given.
  const dist = await office('POST', '/distance', { address: '45 Bay Rd, McDougall', from: '116 William St, Parry Sound' });
  assert.equal(dist.body.km, 17.3);
  assert.equal(dist.body.municipality, 'McDougall');

  // Questions: admins write, everyone reads.
  assert.equal((await office('POST', '/faq', { question: 'Q?' })).status, 403);
  const q = await admin('POST', '/faq', { question: 'How often should a septic be pumped?', answer: 'Every 3 to 5 years.', topic: 'Septic' });
  assert.equal(q.body.updated_by, 'Josh');
  assert.equal((await office('GET', '/faq')).body[0].answer, 'Every 3 to 5 years.');
});

test('editing a job\'s price lines is recorded in the history', async (t) => {
  const { d } = await app(t);
  const line = { item_key: 'x', description: 'Pump-out', qty: 1, unit_price: 100, taxable: 1 };
  const job = (await runAs('Josh', () => d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-12', customer: 'A', lines: [line] }))).job;
  await runAs('Josh', () => d.saveJob({ ...job, lines: [{ ...line, unit_price: 150 }], assignments: [] }));
  const h = await d.historyFor(job.id);
  assert.match(h.at(-1).details, /Price: \$113\.00 → \$169\.50/);
  assert.equal((await d.getJob(job.id)).quoted_price, '$169.50');
});
