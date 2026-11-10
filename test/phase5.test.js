const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const sms = require('../src/sms');

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const photo = [{ buffer: JPEG, contentType: 'image/jpeg' }];

async function setup(t) {
  const db = await testDb(t);
  const sent = [];
  const d = createDispatch(db, { send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; }, today: () => '2026-11-10' });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const lab = await d.saveDriver({ name: 'Larry Labourer', phone: '705-555-0109', kind: 'labourer', default_truck_id: 5 });
  const mk = async (customer, extra = {}) => {
    const { job } = await d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-10', customer, assignments: [{ driver_id: dave.id }], ...extra });
    await d.sendJob(job.id);
    return job;
  };
  return { db, d, sent, dave, lab, mk };
}

test('job numbers: written ones always count, plain numbers only when they are one of your jobs', () => {
  assert.deepEqual(sms.jobNumbers('WO 1042'), { explicit: [1042], plain: [] });
  assert.deepEqual(sms.jobNumbers('W.O. #1043 dumped at Carling'), { explicit: [1043], plain: [] });
  assert.deepEqual(sms.jobNumbers('job 1046, tank full'), { explicit: [1046], plain: [] });
  assert.deepEqual(sms.jobNumbers('pumped 1200 gallons'), { explicit: [], plain: [1200] });
});

test('labourers: their own list, no truck, texted their jobs like drivers', async (t) => {
  const { d, sent, lab } = await setup(t);
  assert.equal(lab.kind, 'labourer');
  assert.equal(lab.default_truck_id, null, 'labourers have no truck');
  const { job } = await d.saveJob({ job_type: 'misc', scheduled_date: '2026-11-10', customer: 'Riser install', material: 'Dig lids',
    assignments: [{ driver_id: lab.id }] });
  await d.sendJob(job.id);
  assert.equal(sent.at(-1).to, '+17055550109');
  assert.match((await d.handleInbound('+17055550109', 'ok')).reply, /Thanks Larry - Job #\d+ .*confirmed/);
  assert.deepEqual((await d.listDrivers()).map((x) => [x.name, x.kind]), [['Dave Thompson', 'driver'], ['Larry Labourer', 'labourer']]);
});

test('two jobs today and a photo with no number: asks which job, then the number puts it there', async (t) => {
  const { d, mk } = await setup(t);
  const a = await mk('Smith');
  const b = await mk('Jones');
  let r = await d.handleInbound('+17055550101', '', { media: photo });
  assert.equal(r.reply, `Got your ticket photo. Which job is it for? Reply with the job number: ${a.id} (Smith), ${b.id} (Jones)`);
  assert.equal((await d.getJob(a.id)).tickets.length + (await d.getJob(b.id)).tickets.length, 0, 'not guessed');
  r = await d.handleInbound('+17055550101', `${b.id}`);
  assert.equal(r.reply, `Thanks Dave - photo added to Job #${b.id}.`);
  assert.equal((await d.getJob(b.id)).tickets.length, 1);
  // DONE without a number when there are two jobs: asks too.
  r = await d.handleInbound('+17055550101', 'done');
  assert.match(r.reply, /Which job is done\? Reply DONE and the job number/);
  r = await d.handleInbound('+17055550101', `done WO ${a.id}`);
  assert.match(r.reply, new RegExp(`Job #${a.id} .*marked DONE`));
});

test('photo first, job number in the next text (the caption arrived separately): the photo moves to that job', async (t) => {
  const { d, dave, mk } = await setup(t);
  const a = await mk('Smith');
  const b = await mk('Jones');
  await d.driverAction(a.assignments[0].token, 'load', 'web'); // Dave is working on Smith's job
  let r = await d.handleInbound('+17055550101', '', { media: photo });
  assert.equal(r.reply, `Got your ticket photo for Job #${a.id}.`);
  r = await d.handleInbound('+17055550101', `#${b.id}`);
  assert.equal(r.reply, `Thanks Dave - photo added to Job #${b.id}.`);
  assert.equal((await d.getJob(a.id)).tickets.length, 0);
  assert.equal((await d.getJob(b.id)).tickets.length, 1);
  assert.ok(dave);
});

test('"1200 gallons" is not a job number; a note with a job number goes on that job', async (t) => {
  const { d, mk } = await setup(t);
  const a = await mk('Smith');
  await mk('Jones');
  let r = await d.handleInbound('+17055550101', 'pumped 1200 gallons, all good', { media: photo });
  assert.match(r.reply, /Which job is it for/);
  r = await d.handleInbound('+17055550101', `WO ${a.id} baffle is cracked, customer wants a quote`);
  assert.equal(r.reply, `Thanks Dave - photo added to Job #${a.id}.`);
  const h = await d.historyFor(a.id);
  assert.ok(h.some((e) => e.action.startsWith('Texted a ticket photo')));
  r = await d.handleInbound('+17055550101', `WO ${a.id} lids were buried under the deck`);
  assert.equal(r.reply, null, 'a note: no auto-reply, the office sees it');
  assert.ok((await d.historyFor(a.id)).some((e) => e.action === 'Texted a note' && /lids were buried/.test(e.details)));
});
