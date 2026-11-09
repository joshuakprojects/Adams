const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { openDb } = require('../src/db');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const { normalizePayload, toJobPrefill } = require('../src/intake');

const KEY = 'test-intake-key-1234567890';

// The septic order from the website screenshots.
const septicOrder = {
  id: 'web-1001',
  service: 'septic',
  customer: { name: 'Jane Cottager', phone: '705 555 0199', email: 'jane@example.com' },
  location: { address: '116 Williams St', municipality: 'Parry Sound' },
  requested_date: null,
  estimate: { subtotal: 395.57, hst: 51.43, total: 447, lines: [{ label: 'Member-area pump-out up to 1,000 gallons', amount: '395.57' }] },
  details: { system_type: 'septic', tank_size_gallons: 1000, scheduling: 'regular_route', lids: 'digging_required',
    steep_driveway: 'yes', air_attachments: 'yes', add_pump_chamber: false, ecoethic: true },
};

test('septic order becomes a filled-in septic work order', () => {
  const row = { id: 7, ...normalizePayload(septicOrder) };
  assert.equal(row.phone, '+17055550199');
  assert.equal(row.estimate_total, '$447.00');
  const job = toJobPrefill(row, '2026-11-10');
  assert.equal(job.job_type, 'septic');
  assert.equal(job.scheduled_date, '2026-11-10');
  assert.equal(job.to_location, '116 Williams St');
  assert.equal(job.municipality, 'Parry Sound');
  assert.equal(job.quoted_price, '$447.00 (website estimate)');
  assert.deepEqual(job.details, { tank_type: 'Septic', tank_size: '1000 gal', lids_uncovered: 'No', steep_driveway: 'Yes' });
  assert.match(job.notes, /Lids need locating \/ digging/);
  assert.match(job.notes, /Air attachments previously required/);
  assert.match(job.notes, /EcoEthic/);
  assert.match(job.notes, /Next regular route/);
  assert.equal(job.request_id, 7);
});

test('other services map to their work orders, and labels from the website are understood', () => {
  const agg = toJobPrefill({ id: 1, ...normalizePayload({ service: 'Aggregates', customer: { name: 'A' },
    details: { material: 'Sand fill', quantity: 10, unit: 'yards', fulfillment: 'pickup' } }) }, '2026-11-10');
  assert.equal(agg.job_type, 'haul');
  assert.equal(agg.material, 'Sand fill');
  assert.equal(agg.quantity, '10');
  assert.match(agg.notes, /CUSTOMER PICKUP/);

  const bin = toJobPrefill({ id: 2, ...normalizePayload({ service: 'roll-off bins', customer: { name: 'B' },
    details: { bin_size: '20 yd', service: 'empty_return' } }) }, '2026-11-10');
  assert.equal(bin.job_type, 'bin');
  assert.deepEqual(bin.details, { service: 'Empty & return' });

  const toilet = toJobPrefill({ id: 3, ...normalizePayload({ service: 'toilet', customer: { name: 'C' }, requested_date: '2026-11-15',
    details: { toilets: [{ type: 'Standard', qty: 2 }], pickup_date: '2026-11-24', placement: 'By the barn' } }) }, '2026-11-10');
  assert.equal(toilet.scheduled_date, '2026-11-15');
  assert.equal(toilet.details.toilet1_qty, '2');
  assert.equal(toilet.details.pickup_date, '2026-11-24');

  const quote = toJobPrefill({ id: 4, ...normalizePayload({ service: 'quote', customer: { name: 'D' },
    details: { service_name: 'Excavation', description: 'Dig a basement' } }) }, '2026-11-10');
  assert.equal(quote.job_type, 'misc');
  assert.equal(quote.material, 'Excavation');
  assert.match(quote.notes, /Description: Dig a basement/);

  assert.throws(() => normalizePayload({ service: 'septic' }), /customer name, phone or email/);
});

test('website → intake → Requests inbox → schedule → status back to the website', async (t) => {
  const db = openDb(':memory:');
  createUser(db, { email: 'office@test.ca', name: 'Office', password: 'password123' });
  const dispatch = createDispatch(db, { send: async () => ({ sid: 'x' }) });
  const server = createApp({ db, dispatch, intakeKey: KEY }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const post = (body, key = KEY) => fetch(base + '/api/intake', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

  assert.equal((await post(septicOrder, 'wrong-key')).status, 401);
  assert.equal((await post({ nope: true })).status, 400);
  let res = await post(septicOrder);
  assert.equal(res.status, 201);
  const { request_id } = await res.json();
  res = await post({ ...septicOrder, notes: 'Gate code 1234' });
  assert.equal(res.status, 200, 'same order id again updates instead of duplicating');

  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'office@test.ca', password: 'password123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (path, body) => (await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET',
    headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();

  assert.equal((await api('/board')).new_requests, 1);
  const inbox = await api('/requests?status=open');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].customer_name, 'Jane Cottager');
  assert.equal(inbox[0].summary, 'Septic · 1000 gal · next regular route');
  assert.equal(inbox[0].notes, 'Gate code 1234');

  // Office clicks Schedule: prefill → save as a job.
  const prefill = await api(`/requests/${request_id}/prefill`);
  assert.match(prefill.notes, /Customer notes: Gate code 1234/);
  const { job } = await api('/jobs', { ...prefill, scheduled_date: '2026-11-12' });
  assert.equal(job.job_type, 'septic');
  assert.equal(job.request_id, request_id);
  assert.equal((await api('/board')).new_requests, 0);
  assert.equal((await api('/requests?status=scheduled'))[0].job_id, job.id);

  res = await fetch(base + '/api/intake/web-1001', { headers: { Authorization: `Bearer ${KEY}` } });
  assert.deepEqual(await res.json(), { status: 'scheduled', job_number: job.id, scheduled_date: '2026-11-12' });
  assert.equal((await fetch(base + '/api/intake/web-1001')).status, 401);
});

test('intake is off without a key', async (t) => {
  const db = openDb(':memory:');
  const server = createApp({ db, dispatch: createDispatch(db), intakeKey: '' }).listen(0);
  t.after(() => server.close());
  const res = await fetch(`http://localhost:${server.address().port}/api/intake`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(septicOrder) });
  assert.equal(res.status, 503);
});
