const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');

async function setup(t) {
  const db = await testDb(t);
  const d = createDispatch(db, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  return { db, d };
}

test('geocode cache: shared by address, ignores spelling noise, expires after 30 days', async (t) => {
  const { db, d } = await setup(t);
  assert.equal(await d.geo.remember('45 Bay Rd, McDougall', 45.36, -79.98), true);
  assert.equal(await d.geo.remember('', 1, 1), false);
  assert.equal(await d.geo.remember('x', 'nope', 1), false);
  const hit = await d.geo.lookup(['45  bay rd. McDougall', 'Nowhere']);
  assert.deepEqual(hit, { '45  bay rd. McDougall': { lat: 45.36, lng: -79.98 } });
  await db.run("UPDATE geocodes SET at = '2020-01-01 00:00:00'");
  assert.deepEqual(await d.geo.lookup(['45 Bay Rd, McDougall']), {});
});

test('map pins: dragged pin is kept for the customer and reused; a new address clears it', async (t) => {
  const { d } = await setup(t);
  const a = (await d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-10', customer: 'Jane', customer_phone: '705-555-0199',
    to_location: '45 Bay Rd', municipality: 'McDougall' })).job;
  await d.setJobLocation(a.id, 45.1, -80.1);
  let c = await d.customers.get(a.customer_id);
  assert.equal(c.site_lat, null, 'an automatic lookup does not change the customer');
  await d.setJobLocation(a.id, 45.2, -80.2, { manual: true });
  c = await d.customers.get(a.customer_id);
  assert.equal(c.site_lat, 45.2);
  assert.match((await d.historyFor(a.id)).at(-1).action, /Moved the map pin/);

  // Next job at the same site starts with the office's pin.
  const b = (await d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-12', customer: 'Jane', customer_phone: '705-555-0199',
    to_location: '45 Bay Rd', municipality: 'McDougall' })).job;
  assert.equal(b.lat, 45.2);
  assert.equal(b.lng, -80.2);

  // Changing the address drops the old pin so the map looks it up again.
  const moved = (await d.saveJob({ ...b, to_location: '12 Other Rd', assignments: [] })).job;
  assert.equal(moved.lat, null);
  await assert.rejects(() => d.setJobLocation(a.id, 200, 0), /Invalid map location/);
});
