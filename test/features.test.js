const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createDispatch } = require('../src/dispatch');
const FORMS = require('../public/forms');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

function setup({ now = '12:00', day = '2026-11-10' } = {}) {
  const db = openDb(':memory:');
  const sent = [];
  const clock = { now, day };
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  const d = createDispatch(db, {
    send: async (to, body) => { sent.push({ to, body }); return { sid: 't' }; },
    today: () => clock.day,
    nowHm: () => clock.now,
    uploadDir,
  });
  const dave = d.saveDriver({ name: 'Dave Thompson', phone: '403-555-0101' });
  const ron = d.saveDriver({ name: 'Ron K', phone: '403-555-0102' });
  return { db, d, sent, clock, dave, ron, uploadDir };
}
const job = (over) => ({ job_type: 'haul', scheduled_date: '2026-11-11', scheduled_time: '07:00', material: 'Topsoil',
  from_location: 'Pit', to_location: 'Site', ...over });

test('lineup: one text per driver listing all their jobs, and it counts as texting the job', async () => {
  const { d, sent, dave, ron } = setup();
  d.saveJob(job({ assignments: [{ driver_id: dave.id }, { driver_id: ron.id }] }));
  d.saveJob(job({ scheduled_time: '13:00', material: '3/4" clear', assignments: [{ driver_id: dave.id }] }));
  const out = await d.sendLineup('2026-11-11');
  assert.equal(out.results.length, 2);
  const toDave = sent.find((m) => m.to === '+14035550101').body;
  assert.match(toDave, /Your 2 jobs for Wed Nov 11/);
  assert.match(toDave, /1\) 7:00 AM - Aggregate #1001/);
  assert.match(toDave, /2\) 1:00 PM - Aggregate #1002/);
  assert.match(toDave, /Reply OK to confirm all/);
  const toRon = sent.find((m) => m.to === '+14035550102').body;
  assert.match(toRon, /Your job for Wed Nov 11:\nADAMS BROS - Aggregates Work Order #1001/);
  assert.ok(d.getJob(1001).assignments.every((a) => a.status === 'sent'));
  // One OK confirms both of Dave's jobs.
  assert.match(d.handleInbound('+14035550101', 'ok').reply, /Jobs #1001 .*#1002/);
});

test('automatic evening lineup sends once, after the set time, only to drivers with something new', async () => {
  const { d, sent, clock, dave, ron } = setup({ now: '16:59' });
  d.saveJob(job({ assignments: [{ driver_id: dave.id }] }));
  assert.equal(d.getSettings().lineup_time, '17:00');
  assert.equal(await d.runScheduledLineup(), null, 'too early');
  clock.now = '17:00';
  const out = await d.runScheduledLineup();
  assert.equal(out.date, '2026-11-11');
  assert.equal(sent.length, 1);
  assert.equal(await d.runScheduledLineup(), null, 'only once a day');

  // Next evening: Dave already got Thursday's job texted earlier by hand; Ron is new.
  clock.day = '2026-11-11';
  const thu = d.saveJob(job({ scheduled_date: '2026-11-12', assignments: [{ driver_id: dave.id }] })).job;
  await d.sendLineup('2026-11-12');
  d.saveJob({ ...job({ scheduled_date: '2026-11-12' }), id: thu.id, assignments: [{ driver_id: dave.id }, { driver_id: ron.id }] });
  sent.length = 0;
  await d.runScheduledLineup();
  assert.deepEqual(sent.map((m) => m.to), ['+14035550102']);

  d.saveSettings({ lineup_time: '' });
  clock.day = '2026-11-12';
  assert.equal(await d.runScheduledLineup(), null, 'turned off');
  assert.throws(() => d.saveSettings({ lineup_time: '5pm' }), /17:00/);
});

test('ticket photos: from the job page, texted in, and unmatched', async () => {
  const { d, dave, ron, uploadDir } = setup();
  const j = d.saveJob(job({ scheduled_date: '2026-11-10', assignments: [{ driver_id: dave.id }] })).job;
  await d.sendJob(j.id);
  const a = d.assignmentByToken(j.assignments[0].token);

  const t = d.saveTicket({ driverId: dave.id, assignment: a, buffer: JPEG, contentType: 'image/jpeg' });
  assert.ok(fs.existsSync(path.join(uploadDir, t.filename)));
  assert.throws(() => d.saveTicket({ assignment: a, buffer: JPEG, contentType: 'text/html' }), /Only photos/);

  // Texted photo with no words goes to today's job.
  let r = d.handleInbound('+14035550101', '', { media: [{ buffer: JPEG, contentType: 'image/jpeg' }] });
  assert.equal(r.reply, 'Got your ticket photo for Job #1001.');
  // Photo + DONE: saves photo and marks done.
  r = d.handleInbound('+14035550101', 'done', { media: [{ buffer: JPEG, contentType: 'image/jpeg' }] });
  assert.match(r.reply, /marked DONE/);
  assert.equal(d.getJob(j.id).tickets.length, 3);
  assert.equal(d.board('2026-11-10').alerts.length, 0);

  // Ron has no job today: photo is kept, flagged, and can be attached by the office.
  r = d.handleInbound('+14035550102', '', { media: [{ buffer: JPEG, contentType: 'image/jpeg' }] });
  assert.match(r.reply, /couldn't tell which job/);
  const board = d.board('2026-11-10');
  assert.equal(board.unmatched_tickets.length, 1);
  assert.equal(board.alerts.length, 1);
  d.attachTicket(board.unmatched_tickets[0].id, j.id);
  assert.equal(d.board('2026-11-10').unmatched_tickets.length, 0);
  assert.equal(d.getJob(j.id).tickets.length, 4);

  d.deleteTicket(t.id);
  assert.ok(!fs.existsSync(path.join(uploadDir, t.filename)));
});

test('septic job: office details, driver report, and the customer/billing fields', async () => {
  const { d, dave } = setup();
  const { job } = d.saveJob({
    job_type: 'septic', scheduled_date: '2026-11-10', to_location: '12 Bay St', municipality: 'McDougall',
    customer: 'J. Larson', customer_phone: '705-555-0199', customer_email: 'j@example.com', billing_address: 'PO Box 1',
    quoted_price: '$350', payment_method: 'Cash', paper_wo: '9440',
    details: { tank_type: 'Holding', tank_size: '1000 gal', lids_uncovered: 'At grade', bogus: 'dropped' },
    assignments: [{ driver_id: dave.id }],
  });
  assert.deepEqual(job.details, { lids_uncovered: 'At grade', tank_type: 'Holding', tank_size: '1000 gal' });
  assert.equal(job.customer_phone, '+17055550199');
  assert.throws(() => d.saveJob({ ...job, id: job.id, details: { tank_type: 'Swimming pool' } }), /Type of tank/);

  await d.sendJob(job.id);
  // Office-only changes (billing address, price) don't ask drivers to re-confirm; a tank detail change does.
  d.saveJob({ ...job, id: job.id, billing_address: 'PO Box 2', quoted_price: '$375', assignments: [{ driver_id: dave.id }] });
  assert.equal(d.getJob(job.id).assignments[0].needs_resend, 0);
  d.saveJob({ ...job, id: job.id, details: { ...job.details, hose_length: '200 ft' }, assignments: [{ driver_id: dave.id }] });
  assert.equal(d.getJob(job.id).assignments[0].needs_resend, 1);

  const token = job.assignments[0].token;
  const a = d.saveReport(token, { outlet_baffle: 'Recommend replacement', liquid_level: 'High', lids_broken: 'No',
    payment_collected: 'Cash', comments: 'Baffle cracked', junk: 'x' });
  // Payment fields are not part of the driver's report (the office collects payments).
  assert.deepEqual(a.report, { outlet_baffle: 'Recommend replacement', liquid_level: 'High', lids_broken: 'No',
    comments: 'Baffle cracked' });
  assert.equal(a.status, 'acknowledged');
  assert.throws(() => d.saveReport(token, { liquid_level: 'Full' }), /Liquid level/);
});

test('book the pick-up for a portable toilet', () => {
  const { d, dave } = setup();
  const { job } = d.saveJob({ job_type: 'toilet', scheduled_date: '2026-11-10', to_location: 'Cottage',
    details: { trip: 'Deliver', pickup_date: '2026-11-24', toilet1_type: 'Standard', toilet1_qty: '2' }, assignments: [{ driver_id: dave.id }] });
  const pickup = d.bookPickup(job.id);
  assert.equal(pickup.scheduled_date, '2026-11-24');
  assert.equal(pickup.details.trip, 'Pick up');
  assert.equal(pickup.details.toilet1_qty, '2');
  assert.equal(pickup.assignments.length, 0);
  assert.match(pickup.notes, /Pick-up for job #1001/);
});

test('aggregates work order: two aggregate lines, yards, truck type', () => {
  const { d, dave } = setup();
  const { job } = d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-10', material: 'Sand fill', loads_planned: 1, quantity: '',
    details: { truck: 'Tandem', aggregate2_type: '2" minus', aggregate2_loads: '20', aggregate2_truck: 'Triaxle' },
    assignments: [{ driver_id: dave.id }] });
  assert.equal(job.unit, '');
  assert.equal(FORMS.totalLoads(job), 21);
  assert.equal(FORMS.summary(job), 'Sand fill - 1 load - Tandem + 2" minus - 20 loads - Triaxle');
  const yards = d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-10', material: 'Topsoil', quantity: '30', unit: 'tonnes' }).job;
  assert.equal(yards.unit, 'yards', 'aggregates are always in yards');
  assert.throws(() => d.saveJob({ ...job, id: job.id, details: { truck: 'Pickup' } }), /Circle one/);
});
