const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createRoutes, orderStops, km } = require('../src/routes');

const YARD = { lat: 45.3447, lng: -80.0345 };
// Stops along a line north of the yard, entered out of order.
const P = { a: { lat: 45.40, lng: -80.03 }, b: { lat: 45.50, lng: -80.03 }, c: { lat: 45.60, lng: -80.03 }, d: { lat: 45.45, lng: -80.03 } };

test('ordering: nearest first, then untangled; ends back near the yard', () => {
  const stops = [P.c, P.a, P.b, P.d].map((p, i) => ({ ...p, id: i }));
  const out = orderStops(YARD, stops, YARD).map((s) => s.lat);
  assert.deepEqual(out, [45.40, 45.45, 45.50, 45.60]);
  assert.ok(Math.abs(km(YARD, P.a) - 6.1) < 0.3, 'about 6 km');
});

async function setup(t, distance) {
  const db = await testDb(t);
  const d = createDispatch(db, { send: async () => ({ sid: 'x' }), today: () => '2026-11-20' });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const job = async (name, p, slot = 'any', type = 'septic', driver = dave.id) => {
    const { job: j } = await d.saveJob({ job_type: type, scheduled_date: '2026-11-20', time_slot: slot, customer: name, to_location: `${name} Rd`,
      assignments: driver ? [{ driver_id: driver }] : [] });
    await db.run('UPDATE jobs SET lat = ?, lng = ? WHERE id = ?', p.lat, p.lng, j.id);
    return j;
  };
  const routes = createRoutes(db, d, distance || { hasKey: false });
  return { db, d, dave, job, routes };
}

test('plan: one time window, no Google key: shortest loop from the yard; save puts the Board in that order', async (t) => {
  const { d, job, routes } = await setup(t);
  const c = await job('Charlie', P.c);
  const a = await job('Alpha', P.a);
  const b = await job('Bravo', P.b);
  await job('Gravel', P.d, 'any', 'haul'); // not septic: left out
  const plan = await routes.plan({ date: '2026-11-20' });
  assert.equal(plan.method, 'map');
  assert.deepEqual(plan.stops.map((s) => s.id), [a.id, b.id, c.id]);
  assert.ok(plan.total_km > 0 && plan.road === false);
  assert.ok(plan.straight_after_km <= plan.straight_before_km);
  assert.match(plan.maps_links[0], /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=/);
  await routes.save('2026-11-20', plan.stops.map((s) => s.id));
  const listed = (await d.listJobs({ from: '2026-11-20', to: '2026-11-20' })).filter((j) => j.job_type === 'septic').map((j) => j.id);
  assert.deepEqual(listed, [a.id, b.id, c.id]);
});

test('plan: customers\' times come first (AM before PM), each part ordered; one driver only', async (t) => {
  const { d, job, routes } = await setup(t);
  const ron = await d.saveDriver({ name: 'Ron', phone: '705-555-0102' });
  const far = await job('Far AM', P.c, 'am');
  const near = await job('Near PM', P.a, 'pm');
  const mid = await job('Mid AM', P.b, 'am');
  await job('Ron job', P.d, 'any', 'septic', ron.id);
  const plan = await routes.plan({ date: '2026-11-20', driverId: (await d.listDrivers())[0].id });
  assert.deepEqual(plan.stops.map((s) => s.id), [mid.id, far.id, near.id]);
});

test('plan: with Google, one time window is ordered on real roads; legs measured', async (t) => {
  const calls = [];
  const distance = {
    hasKey: true,
    geocode: async () => YARD,
    routeThrough: async (points, { optimize } = {}) => {
      calls.push({ n: points.length, optimize });
      return { optimized: Boolean(optimize), order: [2, 0, 1], legs: points.slice(1).map(() => ({ meters: 10000, seconds: 900 })), meters: 40000, seconds: 3600 };
    },
  };
  const { job, routes } = await setup(t, distance);
  const a = await job('Alpha', P.a);
  const b = await job('Bravo', P.b);
  const c = await job('Charlie', P.c);
  const plan = await routes.plan({ date: '2026-11-20' });
  assert.equal(plan.method, 'google');
  assert.deepEqual(plan.stops.map((s) => s.id), [c.id, a.id, b.id]);
  assert.equal(plan.total_km, 40);
  assert.equal(plan.total_min, 60);
  assert.equal(plan.road, true);
  assert.deepEqual(calls, [{ n: 5, optimize: true }]);
});
