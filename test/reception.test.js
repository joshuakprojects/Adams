const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const { plainStatus } = require('../src/reception');

async function app(t) {
  const db = await testDb(t);
  const sent = [];
  const d = createDispatch(db, { send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; }, today: () => '2026-11-10' });
  await d.prices.seed();
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  await createUser(db, { email: 'office@test.ca', name: 'Olive', password: 'password123', role: 'office' });
  const server = createApp({ db, dispatch: d }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'office@test.ca', password: 'password123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (method, p, body) => {
    const r = await fetch(base + '/api' + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { db, d, dave, api, sent };
}

const gravel = { job_type: 'haul', material: 'A Gravel 3/4"', loads_planned: 3, details: { direction: 'Deliver to site', truck: 'Triaxle' },
  to_location: '45 Bay Rd', municipality: 'McDougall', customer: 'Lake Cottage', customer_phone: '705-555-0123' };

test('reception: quote → call back → book it; home shows quotes and my bookings in plain words', async (t) => {
  const { api } = await app(t);
  const q = (await api('POST', '/quotes', { job: gravel, total: 2135.7 })).body;
  assert.equal(q.phone, '+17055550123');
  assert.equal(q.summary, 'A Gravel 3/4" - 3 loads - Triaxle');
  let home = (await api('GET', '/reception/home')).body;
  assert.deepEqual(home.quotes.map((x) => x.id), [q.id]);
  assert.equal((await api('GET', `/quotes/${q.id}`)).body.job.material, 'A Gravel 3/4"');

  const { job } = (await api('POST', '/jobs', { ...gravel, scheduled_date: '2026-11-12', time_slot: 'pm', quote_id: q.id,
    lines: [{ item_key: 'agg.a-gravel-3-4.triaxle', description: 'A Gravel', qty: 3, unit_price: 500, taxable: 1 }] })).body;
  home = (await api('GET', '/reception/home')).body;
  assert.equal(home.quotes.length, 0, 'booked quotes leave the call-back list');
  assert.equal(home.recent[0].id, job.id);
  assert.equal(home.recent[0].plain.text, 'Waiting for dispatch');
  assert.equal((await api('GET', `/quotes/${q.id}`)).body.status, 'booked');

  const dropped = (await api('POST', '/quotes', { job: { ...gravel, customer: 'Not keen' }, total: 10 })).body;
  await api('POST', `/quotes/${dropped.id}/status`, { status: 'dropped' });
  assert.equal((await api('GET', '/reception/home')).body.quotes.length, 0);
  await assert.ok((await api('POST', '/quotes', {})).status === 400);
});

test('reception: find by name, phone or W.O. #, change and cancel a booking (the driver is told)', async (t) => {
  const { d, dave, api, sent } = await app(t);
  const { job } = (await api('POST', '/jobs', { ...gravel, scheduled_date: '2026-11-12', time_slot: 'pm' })).body;
  for (const q of ['Lake', '555-0123', `${job.id}`, `WO ${job.id}`]) {
    assert.ok((await api('GET', '/reception/find?q=' + encodeURIComponent(q))).body.jobs.some((j) => j.id === job.id), q);
  }
  assert.equal((await api('GET', '/reception/find?q=lake')).body.customers[0].name, 'Lake Cottage');
  // Dispatch assigns and texts; reception changes the time and later cancels.
  await d.saveJob({ ...(await d.getJob(job.id)), assignments: [{ driver_id: dave.id }] });
  await d.sendJob(job.id);
  const changed = (await api('PUT', `/jobs/${job.id}`, { ...(await d.getJob(job.id)), time_slot: 'am' })).body.job;
  assert.equal(changed.time_slot, 'am');
  assert.equal(changed.assignments.length, 1, 'the driver stays on it');
  assert.equal((await api('POST', `/jobs/${job.id}/cancel`, {})).status, 200);
  assert.match(sent.at(-1).body, /CANCELLED/i);
  assert.equal((await d.getJob(job.id)).status, 'cancelled');
});

test('plain-words status', () => {
  assert.equal(plainStatus({ status: 'open', draft: 1, missing: ['Phone #'], assignments: [] }).text, 'Draft — needs Phone #');
  assert.equal(plainStatus({ status: 'open', assignments: [{ status: 'pending' }] }).text, 'Dispatch has it ✓');
  assert.equal(plainStatus({ status: 'open', assignments: [{ status: 'acknowledged' }] }).text, 'Driver confirmed ✓');
  assert.equal(plainStatus({ status: 'open', assignments: [{ status: 'sent' }] }).text, 'Driver texted');
  assert.equal(plainStatus({ status: 'complete', assignments: [] }).text, 'Done ✓');
});
