const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const FORMS = require('../public/forms');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

async function setup(t, { now = '12:00', day = '2026-11-10' } = {}) {
  const db = await testDb(t);
  const sent = [];
  const clock = { now, day };
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  const d = createDispatch(db, {
    send: async (to, body) => { sent.push({ to, body }); return { sid: 't' }; },
    today: () => clock.day,
    nowHm: () => clock.now,
    uploadDir,
  });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '403-555-0101' });
  const ron = await d.saveDriver({ name: 'Ron K', phone: '403-555-0102' });
  return { db, d, sent, clock, dave, ron, uploadDir };
}
const job = (over) => ({ job_type: 'haul', scheduled_date: '2026-11-11', scheduled_time: '07:00', material: 'Topsoil',
  from_location: 'Pit', to_location: 'Site', ...over });

test('lineup: one text per driver listing all their jobs, and it counts as texting the job', async (t) => {
  const { d, sent, dave, ron } = await setup(t);
  await d.saveJob(job({ assignments: [{ driver_id: dave.id }, { driver_id: ron.id }] }));
  await d.saveJob(job({ time_slot: 'pm', material: '3/4" clear', assignments: [{ driver_id: dave.id }] }));
  const out = await d.sendLineup('2026-11-11');
  assert.equal(out.results.length, 2);
  const toDave = sent.find((m) => m.to === '+14035550101').body;
  assert.match(toDave, /Your 2 jobs for Wed Nov 11/);
  assert.match(toDave, /1\) AM - Aggregate #1001/);
  assert.match(toDave, /2\) PM - Aggregate #1002/);
  assert.match(toDave, /Reply OK to confirm all/);
  const toRon = sent.find((m) => m.to === '+14035550102').body;
  assert.match(toRon, /Your job for Wed Nov 11:\nADAMS BROS - Aggregates Work Order #1001/);
  assert.ok((await d.getJob(1001)).assignments.every((a) => a.status === 'sent'));
  // One OK confirms both of Dave's jobs.
  assert.match((await d.handleInbound('+14035550101', 'ok')).reply, /Jobs #1001 .*#1002/);
});

test('automatic evening lineup sends once, after the set time, only to drivers with something new', async (t) => {
  const { d, sent, clock, dave, ron } = await setup(t, { now: '16:59' });
  await d.saveJob(job({ assignments: [{ driver_id: dave.id }] }));
  assert.equal((await d.getSettings()).lineup_time, '17:00');
  assert.equal(await d.runScheduledLineup(), null, 'too early');
  clock.now = '17:00';
  const out = await d.runScheduledLineup();
  assert.equal(out.date, '2026-11-11');
  assert.equal(sent.length, 1);
  assert.equal(await d.runScheduledLineup(), null, 'only once a day');

  // Next evening: Dave already got Thursday's job texted earlier by hand; Ron is new.
  clock.day = '2026-11-11';
  const thu = (await d.saveJob(job({ scheduled_date: '2026-11-12', assignments: [{ driver_id: dave.id }] }))).job;
  await d.sendLineup('2026-11-12');
  await d.saveJob({ ...job({ scheduled_date: '2026-11-12' }), id: thu.id, assignments: [{ driver_id: dave.id }, { driver_id: ron.id }] });
  sent.length = 0;
  await d.runScheduledLineup();
  assert.deepEqual(sent.map((m) => m.to), ['+14035550102']);

  await d.saveSettings({ lineup_time: '' });
  clock.day = '2026-11-12';
  assert.equal(await d.runScheduledLineup(), null, 'turned off');
  await assert.rejects(async () => await d.saveSettings({ lineup_time: '5pm' }), /17:00/);
});

test('ticket photos: from the job page, texted in, and unmatched', async (t) => {
  const { d, dave, ron, uploadDir } = await setup(t);
  const j = (await d.saveJob(job({ scheduled_date: '2026-11-10', assignments: [{ driver_id: dave.id }] }))).job;
  await d.sendJob(j.id);
  const a = await d.assignmentByToken(j.assignments[0].token);

  const tk = await d.saveTicket({ driverId: dave.id, assignment: a, buffer: JPEG, contentType: 'image/jpeg' });
  // The photo is stored in the database itself (survives a republish), not as a file.
  assert.deepEqual((await d.getTicket(tk.id)).data, JPEG);
  assert.deepEqual(fs.readdirSync(uploadDir), []);
  await assert.rejects(async () => await d.saveTicket({ assignment: a, buffer: JPEG, contentType: 'text/html' }), /Only photos/);

  // Texted photo with no words goes to today's job.
  let r = await d.handleInbound('+14035550101', '', { media: [{ buffer: JPEG, contentType: 'image/jpeg' }] });
  assert.equal(r.reply, 'Got your ticket photo for Job #1001.');
  // Photo + DONE: saves photo and marks done.
  r = await d.handleInbound('+14035550101', 'done', { media: [{ buffer: JPEG, contentType: 'image/jpeg' }] });
  assert.match(r.reply, /marked DONE/);
  assert.equal((await d.getJob(j.id)).tickets.length, 3);
  assert.equal((await d.board('2026-11-10')).alerts.length, 0);

  // Ron has no job today: photo is kept, flagged, and can be attached by the office.
  r = await d.handleInbound('+14035550102', '', { media: [{ buffer: JPEG, contentType: 'image/jpeg' }] });
  assert.match(r.reply, /couldn't tell which job/);
  const board = await d.board('2026-11-10');
  assert.equal(board.unmatched_tickets.length, 1);
  assert.equal(board.alerts.length, 1);
  await d.attachTicket(board.unmatched_tickets[0].id, j.id);
  assert.equal((await d.board('2026-11-10')).unmatched_tickets.length, 0);
  assert.equal((await d.getJob(j.id)).tickets.length, 4);

  await d.deleteTicket(tk.id);
  assert.equal(await d.getTicket(tk.id), null);
});

test('septic job: office details, driver report, and the customer/billing fields', async (t) => {
  const { d, dave } = await setup(t);
  const { job } = await d.saveJob({
    job_type: 'septic', scheduled_date: '2026-11-10', to_location: '12 Bay St', municipality: 'McDougall',
    customer: 'J. Larson', customer_phone: '705-555-0199', customer_email: 'j@example.com', billing_address: 'PO Box 1',
    quoted_price: '$350', payment_method: 'Cash', paper_wo: '9440',
    details: { tank_type: 'Holding', tank_size: '1000 gal', lids_uncovered: 'At grade', bogus: 'dropped' },
    assignments: [{ driver_id: dave.id }],
  });
  assert.deepEqual(job.details, { lids_uncovered: 'At grade', tank_type: 'Holding', tank_size: '1000 gal' });
  assert.equal(job.customer_phone, '+17055550199');
  await assert.rejects(async () => await d.saveJob({ ...job, id: job.id, details: { tank_type: 'Swimming pool' } }), /Type of tank/);

  await d.sendJob(job.id);
  // Office-only changes (billing address, price) don't ask drivers to re-confirm; a tank detail change does.
  await d.saveJob({ ...job, id: job.id, billing_address: 'PO Box 2', quoted_price: '$375', assignments: [{ driver_id: dave.id }] });
  assert.equal((await d.getJob(job.id)).assignments[0].needs_resend, 0);
  await d.saveJob({ ...job, id: job.id, details: { ...job.details, hose_length: '200 ft' }, assignments: [{ driver_id: dave.id }] });
  assert.equal((await d.getJob(job.id)).assignments[0].needs_resend, 1);

  const token = job.assignments[0].token;
  const a = await d.saveReport(token, { outlet_baffle: 'Recommend replacement', liquid_level: 'High', lids_broken: 'No',
    payment_collected: 'Cash', comments: 'Baffle cracked', junk: 'x' });
  // Payment fields are not part of the driver's report (the office collects payments).
  assert.deepEqual(a.report, { outlet_baffle: 'Recommend replacement', liquid_level: 'High', lids_broken: 'No',
    comments: 'Baffle cracked' });
  assert.equal(a.status, 'acknowledged');
  await assert.rejects(async () => await d.saveReport(token, { liquid_level: 'Full' }), /Liquid level/);
});

test('book the pick-up for a portable toilet', async (t) => {
  const { d, dave } = await setup(t);
  const { job } = await d.saveJob({ job_type: 'toilet', scheduled_date: '2026-11-10', to_location: 'Cottage',
    details: { trip: 'Deliver', pickup_date: '2026-11-24', toilet1_type: 'Standard', toilet1_qty: '2' }, assignments: [{ driver_id: dave.id }] });
  const pickup = await d.bookPickup(job.id);
  assert.equal(pickup.scheduled_date, '2026-11-24');
  assert.equal(pickup.details.trip, 'Pick up');
  assert.equal(pickup.details.toilet1_qty, '2');
  assert.equal(pickup.assignments.length, 0);
  assert.match(pickup.notes, /Pick-up for job #1001/);
});

test('aggregates work order: two aggregate lines, yards, truck type', async (t) => {
  const { d, dave } = await setup(t);
  const { job } = await d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-10', material: 'Sand fill', loads_planned: 1, quantity: '',
    details: { truck: 'Tandem', aggregate2_type: '2" minus', aggregate2_loads: '20', aggregate2_truck: 'Triaxle' },
    assignments: [{ driver_id: dave.id }] });
  assert.equal(job.unit, '');
  assert.equal(FORMS.totalLoads(job), 21);
  assert.equal(FORMS.summary(job), 'Sand fill - 1 load - Tandem + 2" minus - 20 loads - Triaxle');
  const yards = (await d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-10', material: 'Topsoil', quantity: '30', unit: 'tonnes' })).job;
  assert.equal(yards.unit, 'yards', 'aggregates are always in yards');
  await assert.rejects(async () => await d.saveJob({ ...job, id: job.id, details: { truck: 'Pickup' } }), /Circle one/);
});

test('time of day: first thing, AM, PM, any time — sorted in that order and said in the text', async (t) => {
  const { d, sent, dave } = await setup(t);
  await d.saveJob(job({ time_slot: 'am', assignments: [{ driver_id: dave.id }] }));
  const first = (await d.saveJob(job({ time_slot: 'first', material: 'Sand fill', assignments: [{ driver_id: dave.id }] }))).job;
  const pm = (await d.saveJob(job({ time_slot: 'pm', material: 'Fill' }))).job;
  const any = (await d.saveJob(job({ time_slot: 'any', material: 'Fill' }))).job;
  // Older callers sending an exact time or the "first thing" tick still work.
  const old = (await d.saveJob(job({ scheduled_time: '14:30', material: 'Fill' }))).job;
  assert.equal(old.time_slot, 'pm');
  assert.equal((await d.saveJob(job({ first_thing: true }))).job.time_slot, 'first');
  assert.equal(first.first_thing, 1);
  const order = (await d.listJobs({ from: '2026-11-11', to: '2026-11-11' })).map((j) => j.id);
  assert.deepEqual(order.slice(0, 2), [first.id, order[1]]);
  assert.ok(order.indexOf(1001) < order.indexOf(pm.id) && order.indexOf(pm.id) < order.indexOf(any.id));
  await d.sendJob(first.id);
  assert.match(sent.at(-1).body, /Wed Nov 11 - FIRST THING/);
  await d.sendLineup('2026-11-11');
  assert.match(sent.at(-1).body, /1\) FIRST THING - Aggregate #1002[\s\S]*2\) AM - Aggregate #1001/);
});

test('haul-away / until the site says stop', async (t) => {
  const { d, sent, dave } = await setup(t);
  const { job } = await d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-10', first_thing: true, material: 'Fill', loads_planned: 5,
    to_location: '10 Mountain Basin Rd', municipality: 'McDougall', from_location: 'Adams pit',
    details: { direction: 'Haul away from site', until_stop: 'on', truck: 'Tandem' }, assignments: [{ driver_id: dave.id }] });
  assert.equal(job.details.until_stop, 'Yes');
  assert.equal(FORMS.totalLoads(job), 0);
  assert.equal(FORMS.summary(job), 'HAUL AWAY - Fill - Tandem - until site says stop');
  await d.sendJob(job.id);
  const text = sent.at(-1).body;
  assert.match(text, /Job site \(load here\): 10 Mountain Basin Rd, McDougall\nDump at: Adams pit/);
  assert.match(text, /SHOW UP EMPTY/);
  assert.match(text, /KEEP HAULING UNTIL THE PEOPLE ON SITE SAY STOP/);
  assert.match(text, /Reply DONE when the site says stop/);
  // Delivering is unchanged.
  const del = (await d.saveJob({ ...job, id: null, details: { direction: 'Deliver to site' }, assignments: [] })).job;
  assert.deepEqual(FORMS.labels(del), { from: 'From (pit / yard)', to: 'Delivery address' });
});

test('unfinished jobs from earlier days show up, and can be moved to today', async (t) => {
  const { d, sent, dave } = await setup(t); // today is 2026-11-10
  const old = (await d.saveJob(job({ scheduled_date: '2026-11-08', assignments: [{ driver_id: dave.id }] }))).job;
  const finished = (await d.saveJob(job({ scheduled_date: '2026-11-09', assignments: [{ driver_id: dave.id }] }))).job;
  await d.driverAction(finished.assignments[0].token, 'done');
  const cancelled = (await d.saveJob(job({ scheduled_date: '2026-11-09' }))).job;
  await d.cancelJob(cancelled.id);
  await d.saveJob(job({ scheduled_date: '2026-11-10' })); // today: not "earlier"

  let board = await d.board('2026-11-10');
  assert.deepEqual(board.stale_jobs.map((j) => j.id), [old.id]);

  await d.sendJob(old.id);
  const moved = await d.moveJob(old.id, '2026-11-10');
  assert.equal(moved.scheduled_date, '2026-11-10');
  assert.equal(moved.assignments[0].needs_resend, 1, 'texted driver needs the new date');
  board = await d.board('2026-11-10');
  assert.equal(board.stale_jobs.length, 0);
  await assert.rejects(() => d.moveJob(finished.id, '2026-11-10'), /Only open jobs/);
  await assert.rejects(() => d.moveJob(old.id, 'tomorrow'), /Pick a date/);
  assert.ok(sent.length >= 1);
});
