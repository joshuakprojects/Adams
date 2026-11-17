const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createRecurring, cleanRule, describeRule, datesFor } = require('../src/recurring');

async function setup(t, day = '2026-11-13') {
  const db = await testDb(t);
  let today = day;
  const d = createDispatch(db, { send: async () => ({ sid: 'x' }), today: () => today });
  const r = createRecurring(db, d, { today: () => today });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const first = (await d.saveJob({ job_type: 'toilet', scheduled_date: day, time_slot: 'am', customer: 'Carling Community Centre',
    customer_phone: '705-555-0199', to_location: '2 Community Way', municipality: 'Carling', notes: 'Gate code 1234',
    details: { action: 'service' }, assignments: [{ driver_id: dave.id }],
    lines: [{ description: 'Service', qty: 1, unit_price: 85, taxable: 1 }] })).job;
  const visits = async (seriesId) => db.all('SELECT * FROM jobs WHERE series_id = ? ORDER BY scheduled_date', seriesId);
  return { db, d, r, first, dave, visits, setToday: (v) => { today = v; } };
}

test('rules: weekly, every 2 weeks on chosen days, monthly (short months), ends', () => {
  const fri = cleanRule({ freq: 'week' }, '2026-11-13');
  assert.deepEqual(fri.weekdays, [5], 'defaults to the first visit\'s weekday');
  assert.equal(describeRule(fri, '2026-11-13'), 'Every Friday');
  assert.deepEqual(datesFor(fri, '2026-11-13', '2026-12-04'), ['2026-11-13', '2026-11-20', '2026-11-27', '2026-12-04']);
  const two = cleanRule({ freq: 'week', every: 2, weekdays: [1, 4] }, '2026-11-16');
  assert.equal(describeRule(two, '2026-11-16'), 'Every 2 weeks on Mon & Thu');
  assert.deepEqual(datesFor(two, '2026-11-16', '2026-12-04'), ['2026-11-16', '2026-11-19', '2026-11-30', '2026-12-03']);
  const month = cleanRule({ freq: 'month', max_visits: 3 }, '2027-01-31');
  assert.equal(describeRule(month, '2027-01-31'), 'Every month on the 31st, 3 visits');
  assert.deepEqual(datesFor(month, '2027-01-31', '2027-12-31'), ['2027-01-31', '2027-02-28', '2027-03-31']);
  const until = cleanRule({ freq: 'week', end_date: '2026-11-27' }, '2026-11-13');
  assert.deepEqual(datesFor(until, '2026-11-13', '2026-12-31'), ['2026-11-13', '2026-11-20', '2026-11-27']);
  assert.equal(cleanRule({}, '2026-11-13'), null, 'no repeat');
  assert.throws(() => cleanRule({ freq: 'week', end_date: '2026-11-01' }, '2026-11-13'), /before the first visit/);
});

test('repeating: visits made two weeks ahead with no driver, same details and price', async (t) => {
  const { r, first, visits } = await setup(t);
  const s = await r.start(first.id, { freq: 'week' });
  assert.equal(s.label, 'Every Friday');
  const v = await visits(s.id);
  assert.deepEqual(v.map((j) => j.scheduled_date), ['2026-11-13', '2026-11-20', '2026-11-27']);
  const { d } = { d: null };
  void d;
  for (const j of v.slice(1)) {
    assert.equal(j.customer, 'Carling Community Centre');
    assert.equal(j.notes, 'Gate code 1234');
    assert.equal(j.time_slot, 'am');
    assert.match(j.quoted_price, /96\.05/);
  }
  const { db } = { db: null }; void db;
});

test('repeating: visits have no driver; made again daily; never remade once skipped or cancelled', async (t) => {
  const { db, d, r, first, visits, setToday } = await setup(t);
  const s = await r.start(first.id, { freq: 'week' });
  const second = (await visits(s.id))[1];
  assert.equal((await d.getJob(second.id)).assignments.length, 0, 'dispatch picks the driver for each visit');
  // Skip Nov 27; cancel Nov 20.
  await r.action(s.id, 'skip', '2026-11-27');
  await d.cancelJob(second.id);
  setToday('2026-11-21');
  await r.generate();
  const dates = (await visits(s.id)).map((j) => `${j.scheduled_date}:${j.status}`);
  assert.deepEqual(dates, ['2026-11-13:open', '2026-11-20:cancelled', '2026-12-04:open']);
  assert.equal(await r.runScheduled() !== null, true);
  assert.equal(await r.runScheduled(), null, 'once a day');
  void db;
});

test('repeating: this and future visits; pause, resume and stop', async (t) => {
  const { db, d, r, first, dave, visits } = await setup(t);
  const s = await r.start(first.id, { freq: 'week' });
  const [, v2, v3] = await visits(s.id);
  // v3 already has a driver texted: it keeps its driver but gets the new details.
  const job3 = await d.saveJob({ ...(await d.getJob(v3.id)), assignments: [{ driver_id: dave.id }] });
  await d.sendJob(job3.job.id);
  const edited = await d.getJob(v2.id);
  await d.saveJob({ ...edited, notes: 'New gate code 9999', assignments: [] });
  await r.updateFuture(v2.id, { freq: 'week', weekdays: [4, 5] });
  const after = await visits(s.id);
  assert.deepEqual(after.map((j) => j.scheduled_date), ['2026-11-13', '2026-11-20', '2026-11-26', '2026-11-27']);
  assert.ok(after.filter((j) => j.scheduled_date > '2026-11-20').every((j) => j.notes === 'New gate code 9999'));
  assert.equal(after[0].notes, 'Gate code 1234', 'earlier visits keep theirs');
  assert.equal((await d.getJob(v3.id)).assignments.length, 1, 'the texted visit keeps its driver');
  assert.equal((await r.get(s.id)).label, 'Every Thu & Fri');

  await r.action(s.id, 'pause');
  assert.deepEqual((await visits(s.id)).map((j) => j.scheduled_date), ['2026-11-13', '2026-11-27'], 'future visits with no driver removed');
  await r.action(s.id, 'resume');
  assert.equal((await visits(s.id)).length, 4);
  await r.action(s.id, 'stop');
  const list = await r.list();
  assert.equal(list[0].ended, true);
  assert.deepEqual((await visits(s.id)).map((j) => j.scheduled_date), ['2026-11-13', '2026-11-27'], 'the visit with a driver stays');
  void db;
});
