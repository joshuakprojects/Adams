const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { renderPrintPage } = require('../src/printPage');
const FORMS = require('../public/forms');

async function app(t) {
  const db = await testDb(t);
  const sent = [];
  const d = createDispatch(db, { send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; }, today: () => '2026-11-10' });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  await createUser(db, { email: 'josh@adamsbros.ca', name: 'Josh', password: 'password123', role: 'admin' });
  const server = createApp({ db, dispatch: d }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'josh@adamsbros.ca', password: 'password123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (method, p, body) => {
    const r = await fetch(base + '/api' + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { db, d, dave, api, sent, base, cookie };
}

test('required fields: chosen per type by an admin; missing ones block saving unless it is a draft', async (t) => {
  const { d, dave, api } = await app(t);
  const req = (await api('GET', '/settings')).body.required_fields;
  assert.deepEqual(req.septic, ['customer', 'customer_phone', 'to_location'], 'starts with name, phone, address');
  await api('POST', '/settings', { required_fields: { ...req, septic: ['customer', 'customer_phone', 'to_location', 'd.tank_size', 'time_slot', 'bogus'] } });
  const now = (await api('GET', '/settings')).body.required_fields;
  assert.deepEqual(now.septic, ['customer', 'customer_phone', 'to_location', 'd.tank_size', 'time_slot']);

  const partial = { job_type: 'septic', scheduled_date: '2026-11-20', customer: 'Jane', assignments: [{ driver_id: dave.id }] };
  const refused = await api('POST', '/jobs', partial);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Fill in: Phone #, Property address, Approx\. tank size, Time/);
  assert.deepEqual(refused.body.missing, ['customer_phone', 'to_location', 'd.tank_size', 'time_slot']);

  // Booked a month ahead with details to come: a draft.
  const draft = (await api('POST', '/jobs', { ...partial, draft: true })).body.job;
  assert.equal(draft.draft, 1);
  assert.deepEqual(draft.missing, ['Phone #', 'Property address', 'Approx. tank size', 'Time (first thing / AM / PM)']);
  const cant = await api('POST', `/jobs/${draft.id}/send`, {});
  assert.equal(cant.status, 400);
  assert.match(cant.body.error, /is a draft/);

  // Finished later: no longer a draft, and can be texted.
  const done = (await api('PUT', `/jobs/${draft.id}`, { ...draft, customer_phone: '705-555-0199', details: { tank_size: '1000 gal' },
    time_slot: 'any', lat: 45.3, lng: -80, pin_lat: 45.3, pin_lng: -80.0, draft: false })).body.job;
  assert.equal(done.draft, 0, 'a dropped pin counts as the address; "Any time" counts as a time');
  assert.equal((await api('POST', `/jobs/${draft.id}/send`, {})).status, 200);
  // Changes made inside the app (copies, pick-ups) are not blocked.
  assert.ok((await d.duplicateJob(draft.id, '2026-11-21')).id);
});

test('drafts are left out of the evening lineup', async (t) => {
  const { d, dave, sent } = await app(t);
  await d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-11', customer: 'A', material: 'Fill', draft: true, assignments: [{ driver_id: dave.id }] });
  const out = await d.sendLineup('2026-11-11');
  assert.equal(out.results.length, 0);
  assert.equal(sent.length, 0);
});

test('calendar: job counts per day for a month', async (t) => {
  const { d, api } = await app(t);
  const mk = (date, extra = {}) => d.saveJob({ job_type: 'bin', scheduled_date: date, customer: 'X', ...extra });
  await mk('2026-11-12'); await mk('2026-11-12', { draft: true }); await mk('2026-12-01');
  const c = await mk('2026-11-20');
  await d.cancelJob(c.job.id);
  const cal = (await api('GET', '/calendar?month=2026-11')).body;
  assert.deepEqual(cal['2026-11-12'], { total: 2, open: 2, done: 0, drafts: 1 });
  assert.equal(cal['2026-11-20'], undefined, 'cancelled jobs are not counted');
  assert.equal(cal['2026-12-01'], undefined);
  assert.equal((await api('GET', '/calendar?month=nope')).status, 400);
});

test('printed work orders show who created them and when they were printed', async (t) => {
  const { d, api, base, cookie } = await app(t);
  const { job } = (await api('POST', '/jobs', { job_type: 'bin', scheduled_date: '2026-11-12', customer: 'Kim', customer_phone: '705-555-1111',
    to_location: '1 Main St', time_slot: 'am' })).body;
  assert.equal(job.created_by_name, 'Josh');
  const html = await (await fetch(`${base}/print/${job.id}`, { headers: { cookie } })).text();
  assert.match(html, /Created by <b>Josh<\/b>/);
  assert.match(html, /Printed <b>/);
  assert.match(renderPrintPage(await d.getJob(job.id)), /Time:<\/span><span class="val">AM/);
});

test('old exact times become AM / PM / First thing when the database is opened', async (t) => {
  const db = await openDb(':memory:');
  t.after(() => db.close());
  await db.run("DELETE FROM settings WHERE key = 'migration_time_slot'");
  await db.run("INSERT INTO jobs (job_type, scheduled_date, scheduled_time, first_thing) VALUES ('haul', '2026-11-10', '07:30', 0), ('haul', '2026-11-10', '13:00', 0), ('haul', '2026-11-10', '', 1), ('haul', '2026-11-10', '', 0)");
  await require('../src/db').migrate(db);
  const rows = await db.all('SELECT time_slot FROM jobs ORDER BY id');
  assert.deepEqual(rows.map((r) => r.time_slot), ['am', 'pm', 'first', '']);
  assert.equal(FORMS.slotLabel(''), 'Any time');
});
