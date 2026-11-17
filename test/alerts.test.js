const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createAlerts, parsePhones, clock } = require('../src/alerts');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSummary } = require('../src/summary');

async function setup(t) {
  const db = await testDb(t);
  const sent = [];
  const send = async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; };
  const d = createDispatch(db, { send, today: () => '2026-11-12' });
  return { db, d, sent, send };
}

test('phone lists: one per line, commas, or a saved list; bad numbers dropped', () => {
  assert.deepEqual(parsePhones('705-555-0100\n(705) 555-0101, nope'), ['+17055550100', '+17055550101']);
  assert.deepEqual(parsePhones('7055550100'), ['+17055550100']);
  assert.deepEqual(parsePhones('["+17055550100"]'), ['+17055550100']);
  assert.deepEqual(parsePhones(''), []);
});

test('alerts: kept, texted to the alert numbers, the same kind at most once an hour', async (t) => {
  const { db, sent, send } = await setup(t);
  let clock = new Date('2026-11-12T15:00:00Z');
  const alerts = createAlerts(db, { send, now: () => clock, listen: false });
  await alerts.notify('backup', 'The nightly backup failed: disk full');
  assert.equal(sent.length, 0, 'no numbers yet: kept but not texted');
  await alerts.saveSettings({ alert_phones: '705-555-0100\n705-555-0101' });
  await alerts.notify('backup', 'The nightly backup failed: disk full');
  assert.equal(sent.length, 2);
  assert.match(sent[0].body, /^ADAMS BROS DISPATCH ALERT - Backup failed: The nightly backup failed/);
  await alerts.notify('backup', 'Again');
  assert.equal(sent.length, 2, 'throttled within the hour');
  await alerts.notify('qbo', 'QuickBooks sync stopped');
  assert.equal(sent.length, 4, 'a different kind still goes');
  clock = new Date('2026-11-12T16:05:00Z');
  await alerts.notify('backup', 'Still failing');
  assert.equal(sent.length, 6, 'an hour later it goes again');
  const list = await alerts.list();
  assert.equal(list.length, 5);
  assert.equal(list[0].message, 'Still failing');
  assert.equal(list.find((a) => a.message === 'Again').texted, '');
});

test('alerts: an alert text that fails is still recorded', async (t) => {
  const { db } = await setup(t);
  const alerts = createAlerts(db, { send: async () => { throw new Error('Twilio error 401'); }, listen: false });
  await alerts.saveSettings({ alert_phones: '705-555-0100' });
  const out = await alerts.raise('test', 'Test', { force: true });
  assert.deepEqual(out.texted, []);
  const [a] = await alerts.list();
  assert.equal(a.kind, 'test');
  assert.equal(a.texted, '');
});

test('alerts: the app being down for a while is noticed on start-up; a planned restart is not', async (t) => {
  const { db, sent, send } = await setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clockNow = new Date('2026-11-12T15:00:00Z');
  const alerts = createAlerts(db, { send, now: () => clockNow, listen: false, heartbeatFile: path.join(dir, 'hb.json') });
  await alerts.saveSettings({ alert_phones: '705-555-0100' });
  assert.equal(await alerts.checkDowntime('America/Toronto'), false, 'first start: nothing to compare');
  clockNow = new Date('2026-11-12T15:05:00Z');
  assert.equal(await alerts.checkDowntime('America/Toronto'), false, 'a quick restart is fine');
  // A Republish: stopped on purpose, back 12 minutes later. Not reported.
  alerts.stopped();
  clockNow = new Date('2026-11-12T15:17:00Z');
  assert.equal(await alerts.checkDowntime('America/Toronto'), false);
  // Stopped without warning (a crash) for 3 hours: reported, with plain times.
  clockNow = new Date('2026-11-12T18:17:00Z');
  assert.equal(await alerts.checkDowntime('America/Toronto'), true);
  assert.match(sent.at(-1).body, /App was down: Dispatch was not running from Thu Nov 12, 10:17 AM to Thu Nov 12, 1:17 PM \(3 hours\)\./);
  assert.equal(clock(new Date('2026-11-17T13:49:00Z'), 'America/Toronto'), 'Tue Nov 17, 8:49 AM');
});

test('day summary: done, loads, money, still open, booked today, tomorrow; texted to chosen numbers', async (t) => {
  const { db, d, sent, send } = await setup(t);
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const ron = await d.saveDriver({ name: 'Ron Kowalski', phone: '705-555-0102' });
  const septic = (await d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-12', customer: 'Jane Cottager', customer_phone: '705-555-0199',
    to_location: '12 Lake Rd', assignments: [{ driver_id: dave.id }],
    lines: [{ description: 'Pump-out', qty: 1, unit_price: 400, taxable: 1 }] })).job;
  await d.driverAction(septic.assignments[0].token, 'done');
  const gravel = (await d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-12', customer: 'Bayview', to_location: '4 Bay St', material: 'A Gravel',
    assignments: [{ driver_id: ron.id }] })).job;
  await db.run('UPDATE assignments SET loads_done = 3 WHERE job_id = ?', gravel.id);
  await d.saveJob({ job_type: 'bin', scheduled_date: '2026-11-13', customer: 'K. Morris', to_location: '88 Seguin Trail' });

  const summary = createSummary(db, { send, today: () => '2026-11-12', nowHm: () => '17:30' });
  const s = await summary.build('2026-11-12');
  assert.equal(s.jobs, 2);
  assert.equal(s.done, 1);
  assert.deepEqual(s.done_by_type.map((x) => [x.type, x.n]), [['septic', 1]]);
  assert.equal(s.loads, 3);
  assert.equal(s.done_value, 400);
  assert.deepEqual(s.open.map((o) => [o.id, o.reason]), [[gravel.id, 'not texted']]);
  assert.equal(s.tomorrow.jobs, 1);
  assert.equal(s.tomorrow.no_driver, 1);
  const text = summary.text(s);
  assert.match(text, /Done: 1 of 2 jobs \(1 septic/);
  assert.match(text, /Loads hauled: 3/);
  assert.match(text, /Work done: \$400 \+ HST/);
  assert.match(text, new RegExp(`Still open: 1 - #${gravel.id} Bayview \\(not texted\\)`));
  assert.match(text, /Tomorrow: 1 job, 1 with no driver/);

  await assert.rejects(summary.sendTo('2026-11-12'), /Add at least one number/);
  const out = await summary.sendTo('2026-11-12', ['705-555-0300']);
  assert.equal(out.results[0].ok, true);
  assert.equal(sent.at(-1).to, '+17055550300');

  // Automatic: once a day, at the time set.
  await summary.saveSettings({ summary_phones: '705-555-0300', summary_time: '17:00' });
  const before = sent.length;
  assert.ok(await summary.runScheduled());
  assert.equal(await summary.runScheduled(), null, 'only once a day');
  assert.equal(sent.length, before + 1);
  await assert.rejects(summary.saveSettings({ summary_time: '5pm' }), /Time must look like 17:00/);
});
