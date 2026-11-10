const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const { runAs } = require('../src/actor');

async function setup(t, day = '2026-11-10') {
  const db = await testDb(t);
  const sent = [];
  const d = createDispatch(db, { send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; }, today: () => day });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  return { db, d, sent, dave };
}

test('jobs build the address book: matched by phone, blanks filled in, never overwritten', async (t) => {
  const { d } = await setup(t);
  const a = (await d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-10', customer: 'Jane Cottager', customer_phone: '705-555-0199',
    to_location: '45 Bay Rd', municipality: 'McDougall' })).job;
  assert.ok(a.customer_id);
  let c = await d.customers.get(a.customer_id);
  assert.equal(c.name, 'Jane Cottager');
  assert.equal(c.site_address, '45 Bay Rd');

  // Same phone, different spelling: same customer; new email fills a blank, address is not overwritten.
  const b = (await d.saveJob({ job_type: 'bin', scheduled_date: '2026-11-11', customer: 'J. Cottager', customer_phone: '(705) 555-0199',
    customer_email: 'jane@example.com', to_location: 'Other place' })).job;
  assert.equal(b.customer_id, a.customer_id);
  c = await d.customers.get(a.customer_id);
  assert.equal(c.email, 'jane@example.com');
  assert.equal(c.site_address, '45 Bay Rd');
  assert.equal(c.name, 'Jane Cottager');

  // Picked in the form wins over matching.
  const other = await d.customers.save({ name: 'Northshore Builders', phone: '705-555-2001', notes: 'Gate code 4321' });
  const j = (await d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-11', customer_id: other.id, customer: 'Northshore Builders' })).job;
  assert.equal(j.customer_id, other.id);
  assert.equal((await d.customers.search('north'))[0].id, other.id);
  assert.equal((await d.customers.search('555-2001'))[0].id, other.id);
  assert.equal((await d.customers.jobsFor(other.id)).length, 1);
  await assert.rejects(() => d.customers.save({}), /name or a phone/);
});

test('earlier jobs are linked to customers on start-up', async (t) => {
  const { db, d } = await setup(t);
  await db.run("INSERT INTO jobs (job_type, scheduled_date, customer, customer_phone) VALUES ('haul', '2025-05-01', 'Old Customer', '+17055550777')");
  assert.equal(await d.customers.backfill(), 1);
  const job = await db.get("SELECT customer_id FROM jobs WHERE customer = 'Old Customer'");
  assert.ok(job.customer_id);
  assert.equal(await d.customers.backfill(), 0);
});

test('septic reminders: due after the interval, not if booked or recently contacted', async (t) => {
  const { d, dave } = await setup(t, '2026-11-10');
  const pump = async (date, name, phone) => {
    const { job } = await d.saveJob({ job_type: 'septic', scheduled_date: date, customer: name, customer_phone: phone,
      to_location: `${name} cottage`, details: { tank_type: 'Holding', tank_size: '1000 gal' }, assignments: [{ driver_id: dave.id }] });
    await d.driverAction(job.assignments[0].token, 'done');
    return job;
  };
  await pump('2024-06-01', 'Due Dan', '705-555-1001');        // 2.4 years ago → due
  await pump('2025-09-01', 'Recent Rita', '705-555-1002');    // 1.2 years → not yet
  const booked = await pump('2023-05-01', 'Booked Bob', '705-555-1003');
  await d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-20', customer: 'Booked Bob', customer_phone: '705-555-1003' });
  let due = await d.customers.septicDue({ years: 2 });
  assert.deepEqual(due.map((c) => c.name), ['Due Dan']);
  assert.equal(due[0].tank_type, 'Holding');
  assert.equal(due[0].last_pumpout, '2024-06-01');

  const prefill = await d.customers.septicPrefill(due[0].id);
  assert.equal(prefill.job_type, 'septic');
  assert.equal(prefill.details.tank_size, '1000 gal');
  assert.equal(prefill.to_location, 'Due Dan cottage');

  await d.customers.markContacted(due[0].id, 'Left a message');
  assert.equal((await d.customers.septicDue({ years: 2 })).length, 0, 'contacted: hidden for 90 days');
  assert.equal((await d.customers.septicDue({ years: 1 })).map((c) => c.name).join(), 'Recent Rita');
  assert.ok(booked);
});

test('change history records the office, drivers and the system', async (t) => {
  const { d, dave } = await setup(t);
  const job = await runAs('Josh', async () => (await d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-10', material: 'Sand fill',
    time_slot: 'am', assignments: [{ driver_id: dave.id }] })).job);
  await runAs('Josh', () => d.saveJob({ ...job, time_slot: 'pm', invoice_number: 'INV-1042', amount_billed: '$310.00',
    assignments: [{ driver_id: dave.id }] }));
  await runAs('Josh', () => d.sendJob(job.id));
  await d.handleInbound('+17055550101', 'ok');
  await d.driverAction(job.assignments[0].token, 'load', 'web');
  await d.handleInbound('+17055550101', 'done');
  const h = await d.historyFor(job.id);
  const lines = h.map((e) => `${e.actor}: ${e.action}${e.details ? ' — ' + e.details : ''}`);
  assert.match(lines[0], /^Josh: Created — Sand fill/);
  assert.match(lines[1], /^Josh: Edited — Time: AM → PM; Invoice #: \(blank\) → INV-1042; Amount billed: \(blank\) → \$310\.00/);
  assert.match(lines[2], /^Josh: Texted — Dave Thompson \(update\)|^Josh: Texted — Dave Thompson/);
  assert.match(lines[3], /^Dave Thompson: Confirmed by text — ok/);
  assert.match(lines[4], /^Dave Thompson: \+1 load \(1\) on the job page/);
  assert.match(lines[5], /^Dave Thompson: Texted DONE/);
  assert.match(lines[6], /^System: Job complete/);
  // Billing fields are office-only: editing them doesn't ask the driver to re-confirm.
  const again = await d.getJob(job.id);
  assert.equal(again.invoice_number, 'INV-1042');
});

test('customer and history endpoints', async (t) => {
  const { db, d, dave } = await setup(t);
  await createUser(db, { email: 'office@test.ca', name: 'Josh', password: 'password123' });
  const server = createApp({ db, dispatch: d }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'office@test.ca', password: 'password123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (p, body) => (await fetch(base + '/api' + p, { method: body ? 'POST' : 'GET',
    headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();

  const c = await api('/customers', { name: 'Lakeview Cottage', phone: '705-555-3000', site_address: '9 Shore Rd', notes: 'Dog in yard' });
  assert.equal((await api('/customers/search?q=lake'))[0].id, c.id);
  const { job } = await api('/jobs', { job_type: 'haul', scheduled_date: '2026-11-10', customer_id: c.id, customer: 'Lakeview Cottage', customer_phone: '705-555-3000', to_location: '9 Shore Rd',
    assignments: [{ driver_id: dave.id }] });
  assert.equal(job.customer_id, c.id);
  const detail = await api(`/customers/${c.id}`);
  assert.equal(detail.jobs[0].id, job.id);
  const hist = await api(`/jobs/${job.id}/history`);
  assert.equal(hist[0].actor, 'Josh', 'office actions are credited to the logged-in user');
  assert.equal((await api('/settings', { septic_reminder_years: 3 })).septic_reminder_years, '3');
  assert.deepEqual(await api('/customers/due'), []);
});
