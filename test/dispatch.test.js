const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createDispatch } = require('../src/dispatch');

function setup() {
  const db = openDb(':memory:');
  const sent = [];
  const d = createDispatch(db, {
    send: async (to, body) => { sent.push({ to, body }); return { sid: 'test' }; },
    today: () => '2026-11-10',
  });
  const truck = d.saveTruck({ unit: 'T1', kind: 'haul' });
  const dave = d.saveDriver({ name: 'Dave Thompson', phone: '403-555-0101', default_truck_id: truck.id });
  const ron = d.saveDriver({ name: 'Ron K', phone: '403-555-0102' });
  return { db, d, sent, truck, dave, ron };
}

const baseJob = (over = {}) => ({
  job_type: 'haul', scheduled_date: '2026-11-10', scheduled_time: '07:00', material: '3/4" clear',
  loads_planned: 10, from_location: 'Pit', to_location: 'Site', ...over,
});

test('job numbers start at 1001', () => {
  const { d } = setup();
  assert.equal(d.saveJob(baseJob()).job.id, 1001);
});

test('assign, text, driver replies OK, then DONE', async () => {
  const { d, sent, dave, ron, truck } = setup();
  const { job } = d.saveJob(baseJob({ assignments: [{ driver_id: dave.id, truck_id: truck.id }, { driver_id: ron.id }] }));
  assert.deepEqual(job.assignments.map((a) => a.status), ['pending', 'pending']);

  const out = await d.sendJob(job.id);
  assert.equal(out.results.length, 2);
  assert.equal(sent.length, 2);
  assert.ok(out.job.assignments.every((a) => a.status === 'sent'));

  let r = d.handleInbound('+14035550101', 'ok');
  assert.match(r.reply, /Thanks Dave - Job #1001 .* confirmed/);
  let a = d.getJob(job.id).assignments.find((x) => x.driver_id === dave.id);
  assert.equal(a.status, 'acknowledged');
  assert.equal(a.ack_via, 'sms');

  r = d.handleInbound('4035550101', 'Done');
  assert.match(r.reply, /marked DONE/);
  a = d.getJob(job.id).assignments.find((x) => x.driver_id === dave.id);
  assert.equal(a.status, 'done');
  assert.equal(d.getJob(job.id).status, 'open', 'Ron is not done yet');

  d.handleInbound('+14035550102', 'done 1001');
  assert.equal(d.getJob(job.id).status, 'complete');
});

test('OK confirms all newly texted jobs at once', async () => {
  const { d, dave } = setup();
  const j1 = d.saveJob(baseJob({ assignments: [{ driver_id: dave.id }] })).job;
  const j2 = d.saveJob(baseJob({ scheduled_date: '2026-11-11', assignments: [{ driver_id: dave.id }] })).job;
  await d.sendJob(j1.id);
  await d.sendJob(j2.id);
  const r = d.handleInbound('+14035550101', '👍');
  assert.match(r.reply, /Jobs #1001 .*#1002/);
  assert.equal(d.getJob(j2.id).assignments[0].status, 'acknowledged');
});

test('unrecognised replies are flagged for the office', async () => {
  const { d, dave } = setup();
  const j = d.saveJob(baseJob({ assignments: [{ driver_id: dave.id }] })).job;
  await d.sendJob(j.id);
  const r = d.handleInbound('+14035550101', 'running 20 min late');
  assert.equal(r.reply, null);
  const alerts = d.board('2026-11-10').alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].body, 'running 20 min late');
  assert.equal(alerts[0].job_id, j.id);
  d.handleInbound('+14035550101', 'thanks!');
  assert.equal(d.board('2026-11-10').alerts.length, 1, 'small talk is not flagged');
  d.handleInbound('+17805559999', 'who is this');
  assert.equal(d.board('2026-11-10').alerts.length, 2, 'unknown numbers are flagged');
});

test('editing a texted job flags it for re-send and re-send needs a new OK', async () => {
  const { d, sent, dave } = setup();
  const j = d.saveJob(baseJob({ assignments: [{ driver_id: dave.id }] })).job;
  await d.sendJob(j.id);
  d.handleInbound('+14035550101', 'ok');
  d.saveJob({ ...baseJob({ scheduled_time: '06:30' }), id: j.id, assignments: [{ driver_id: dave.id }] });
  assert.equal(d.getJob(j.id).assignments[0].needs_resend, 1);
  await d.sendJob(j.id);
  assert.match(sent.at(-1).body, /UPDATED Job #1001/);
  assert.match(sent.at(-1).body, /6:30 AM/);
  const a = d.getJob(j.id).assignments[0];
  assert.equal(a.status, 'sent');
  assert.equal(a.needs_resend, 0);
});

test('saving without changes does not flag a re-send', async () => {
  const { d, dave } = setup();
  const j = d.saveJob(baseJob({ assignments: [{ driver_id: dave.id }] })).job;
  await d.sendJob(j.id);
  d.saveJob({ ...baseJob(), id: j.id, assignments: [{ driver_id: dave.id }] });
  assert.equal(d.getJob(j.id).assignments[0].needs_resend, 0);
});

test('removing a texted driver tells them; cancelling texts everyone who was texted', async () => {
  const { d, sent, dave, ron } = setup();
  const j = d.saveJob(baseJob({ assignments: [{ driver_id: dave.id }, { driver_id: ron.id }] })).job;
  await d.sendJob(j.id);
  const { job, removed } = d.saveJob({ ...baseJob(), id: j.id, assignments: [{ driver_id: dave.id }] });
  assert.equal(removed.length, 1);
  await d.notifyRemoved(job, removed);
  assert.match(sent.at(-1).body, /taken OFF Job #1001/);
  assert.equal(sent.at(-1).to, '+14035550102');

  await d.cancelJob(j.id);
  assert.match(sent.at(-1).body, /CANCELLED/);
  assert.equal(sent.at(-1).to, '+14035550101');
  assert.equal(d.getJob(j.id).assignments[0].status, 'cancelled');
});

test('driver page buttons count loads and finish', () => {
  const { d, dave } = setup();
  const j = d.saveJob(baseJob({ assignments: [{ driver_id: dave.id }] })).job;
  const token = j.assignments[0].token;
  d.driverAction(token, 'ack');
  d.driverAction(token, 'load');
  d.driverAction(token, 'load');
  let a = d.driverAction(token, 'unload');
  assert.equal(a.loads_done, 1);
  assert.equal(a.status, 'in_progress');
  a = d.driverAction(token, 'done');
  assert.equal(a.status, 'done');
  assert.equal(d.getJob(j.id).status, 'complete');
  a = d.driverAction(token, 'reopen');
  assert.equal(a.status, 'in_progress');
  assert.equal(d.getJob(j.id).status, 'open');
});

test('duplicate copies drivers to a new date, not texted', async () => {
  const { d, dave } = setup();
  const j = d.saveJob(baseJob({ assignments: [{ driver_id: dave.id }] })).job;
  await d.sendJob(j.id);
  const copy = d.duplicateJob(j.id, '2026-11-11');
  assert.equal(copy.scheduled_date, '2026-11-11');
  assert.equal(copy.assignments[0].status, 'pending');
  assert.notEqual(copy.assignments[0].token, j.assignments[0].token);
});

test('validation', () => {
  const { d } = setup();
  assert.throws(() => d.saveDriver({ name: 'X', phone: '123' }), /valid 10-digit/);
  assert.throws(() => d.saveDriver({ name: 'Dup', phone: '403-555-0101' }), /already has that phone/);
  assert.throws(() => d.saveJob({ job_type: 'haul' }), /Pick a date/);
});
