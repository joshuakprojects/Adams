const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const { jobsToCsv } = require('../src/records');

function parseCsv(text) {
  // Minimal CSV parser for the test (handles quotes, commas and newlines in cells).
  const rows = [];
  let row = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') continue;
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  return rows;
}

async function setup(t) {
  const db = await testDb(t);
  const d = createDispatch(db, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const truck = await d.saveTruck({ unit: 'S1', kind: 'septic' });
  const septic = (await d.saveJob({
    job_type: 'septic', scheduled_date: '2026-03-02', customer: 'Jane, "The" Cottager', customer_phone: '705-555-0199',
    billing_address: 'PO Box 1\nParry Sound', to_location: '45 Bay Rd', municipality: 'McDougall', quoted_price: '$447.00',
    payment_method: 'Cash', details: { tank_type: 'Holding', tank_size: '1000 gal' }, notes: '=HYPERLINK("http://evil")',
    assignments: [{ driver_id: dave.id, truck_id: truck.id }],
  })).job;
  const token = septic.assignments[0].token;
  await d.driverAction(token, 'done');
  await d.saveReport(token, { liquid_level: 'High', comments: 'Baffle cracked' });
  const agg = (await d.saveJob({ job_type: 'haul', scheduled_date: '2026-06-15', customer: 'Northshore', material: 'Sand fill',
    loads_planned: 3, details: { truck: 'Tandem' }, assignments: [{ driver_id: dave.id }] })).job;
  await d.driverAction(agg.assignments[0].token, 'load');
  await d.driverAction(agg.assignments[0].token, 'load');
  await d.driverAction(agg.assignments[0].token, 'done');
  await d.saveJob({ job_type: 'bin', scheduled_date: '2026-07-01', customer: 'Open job', material: '20 yd', details: { service: 'Deliver bin' } });
  await d.saveJob({ job_type: 'haul', scheduled_date: '2025-12-30', customer: 'Last year', material: 'Fill' });
  return { db, d, septic, agg };
}

test('find work orders by range, status, type and search', async (t) => {
  const { d, septic, agg } = await setup(t);
  const year = { from: '2026-01-01', to: '2026-12-31' };
  assert.deepEqual((await d.findJobs(year)).map((j) => j.id), [septic.id, agg.id], 'completed only by default');
  assert.equal((await d.findJobs({ ...year, status: 'all' })).length, 3);
  assert.equal((await d.findJobs({ ...year, status: 'open' }))[0].customer, 'Open job');
  assert.deepEqual((await d.findJobs({ ...year, type: 'haul' })).map((j) => j.id), [agg.id]);
  assert.deepEqual((await d.findJobs({ ...year, q: 'cottager' })).map((j) => j.id), [septic.id]);
  assert.deepEqual((await d.findJobs({ ...year, q: 'mcdougall' })).map((j) => j.id), [septic.id]);
  assert.deepEqual((await d.findJobs({ ...year, q: `#${agg.id}` })).map((j) => j.id), [agg.id]);
  assert.deepEqual((await d.findJobs({ ...year, q: '555-0199' })).map((j) => j.id), [septic.id]);
  const [s] = await d.findJobs({ ...year, q: 'cottager' });
  assert.equal(s.assignments[0].driver_name, 'Dave Thompson');
  assert.ok(s.completed_at);
  assert.equal((await d.findJobs({ from: '2025-01-01', to: '2025-12-31', status: 'all' }))[0].customer, 'Last year');
});

test('spreadsheet export: one row per work order, safe cells', async (t) => {
  const { d, septic, agg } = await setup(t);
  const rows = parseCsv(jobsToCsv(await d.findJobs({ from: '2026-01-01', to: '2026-12-31' })));
  const head = rows[0];
  assert.equal(rows.length, 3);
  const col = (r, name) => r[head.indexOf(name)];
  const s = rows.find((r) => col(r, 'Work order #') === String(septic.id));
  assert.equal(col(s, 'Customer'), 'Jane, "The" Cottager');
  assert.equal(col(s, 'Billing address'), 'PO Box 1\nParry Sound');
  assert.equal(col(s, 'Type'), 'Septic Pump-out');
  assert.equal(col(s, 'Quoted price'), '$447.00');
  assert.equal(col(s, 'Drivers'), 'Dave Thompson');
  assert.equal(col(s, 'Trucks'), 'S1');
  assert.match(col(s, 'Form details'), /Type of tank: Holding/);
  assert.match(col(s, 'Driver report'), /Liquid level in tanks: High; Comments: Baffle cracked/);
  assert.equal(col(s, 'Special instructions'), `'=HYPERLINK("http://evil")`, 'formulas are neutralised');
  const a = rows.find((r) => col(r, 'Work order #') === String(agg.id));
  assert.equal(col(a, 'Loads done'), '2');
  assert.equal(col(a, 'Work'), 'Sand fill - 3 loads - Tandem');
});

test('records endpoints: list, CSV download, printable batch', async (t) => {
  const { db, d, septic } = await setup(t);
  await createUser(db, { email: 'office@test.ca', name: 'Office', password: 'password123' });
  const server = createApp({ db, dispatch: d }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  assert.equal((await fetch(base + '/api/records.csv')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'office@test.ca', password: 'password123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = (p) => fetch(base + p, { headers: { cookie } });

  const list = await (await get('/api/records?from=2026-01-01&to=2026-12-31')).json();
  assert.equal(list.jobs.length, 2);
  const csv = await get('/api/records.csv?from=2026-01-01&to=2026-12-31&status=all');
  assert.match(csv.headers.get('content-disposition'), /adams-bros-work-orders-2026-01-01-to-2026-12-31\.csv/);
  assert.equal(parseCsv(await csv.text()).length, 4);
  const html = await (await get('/print/records?from=2026-01-01&to=2026-12-31')).text();
  assert.equal((html.match(/<article class="sheet/g) || []).length, 2);
  assert.match(html, new RegExp(`WORK ORDER # <span class="num">${septic.id}`));
  assert.match(html, /Save as PDF/);
  assert.equal((await get('/api/records?from=2026-12-31&to=2026-01-01')).status, 400);
});
