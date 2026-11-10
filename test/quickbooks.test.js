const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createQuickBooks, buildEstimate } = require('../src/quickbooks');
const { createBackups, gunzipJson } = require('../src/backup');
const { runAs } = require('../src/actor');

/** A small stand-in for the QuickBooks Online API. */
function fakeQbo() {
  const s = { customers: [{ Id: '1', DisplayName: 'Existing Co', PrimaryPhone: { FreeFormNumber: '(705) 555-0199' } }],
    estimates: {}, nextId: 100, calls: [], tokenCalls: 0, refreshed: 0, expireNext: false };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    s.calls.push(`${opts.method || 'GET'} ${url.replace(/\?.*/, '')}`);
    if (url.includes('/tokens/bearer')) {
      s.tokenCalls++;
      const p = new URLSearchParams(opts.body);
      assert.match(opts.headers.Authorization, /^Basic /);
      if (p.get('grant_type') === 'refresh_token') s.refreshed++;
      return ok({ access_token: `at${s.tokenCalls}`, refresh_token: `rt${s.tokenCalls}`, expires_in: 3600 });
    }
    if (s.expireNext) { s.expireNext = false; return { ok: false, status: 401, json: async () => ({}) }; }
    const path = url.replace(/^https:\/\/[^/]+\/v3\/company\/[^/]+/, '').replace(/\?.*$/, '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (path.startsWith('/companyinfo')) return ok({ CompanyInfo: { CompanyName: 'Adams Bros. Construction Ltd.' } });
    if (path === '/query') {
      const q = decodeURIComponent(url.match(/query=([^&]+)/)[1]);
      if (/from Item/.test(q)) return ok({ QueryResponse: { Item: [{ Id: '11', Name: 'Aggregate', Type: 'Service' }, { Id: '12', Name: 'Delivery', Type: 'Service' }, { Id: '19', Name: 'Sales', Type: 'Service' }] } });
      if (/from TaxCode/.test(q)) return ok({ QueryResponse: { TaxCode: [{ Id: '5', Name: 'HST ON' }, { Id: '7', Name: 'Exempt' }] } });
      if (/from Customer where DisplayName/.test(q)) return ok({ QueryResponse: { Customer: s.customers.filter((c) => q.includes(`'${c.DisplayName}'`)) } });
      if (/from Customer/.test(q)) return ok({ QueryResponse: { Customer: /startposition 1 /.test(q) ? s.customers : [] } });
    }
    if (path === '/customer') {
      if (s.customers.some((c) => c.DisplayName === body.DisplayName)) {
        return { ok: false, status: 400, json: async () => ({ Fault: { Error: [{ Message: 'Duplicate Name Exists Error', code: '6240' }] } }) };
      }
      const c = { ...body, Id: String(s.nextId++) };
      s.customers.push(c);
      return ok({ Customer: c });
    }
    if (path === '/estimate') {
      const id = body.Id || String(s.nextId++);
      if (body.Id && body.SyncToken !== s.estimates[id].SyncToken) return { ok: false, status: 400, json: async () => ({ Fault: { Error: [{ Message: 'Stale Object Error' }] } }) };
      const e = { ...body, Id: id, SyncToken: body.Id ? String(Number(body.SyncToken) + 1) : '0' };
      s.estimates[id] = e;
      return ok({ Estimate: e });
    }
    if (path.startsWith('/estimate/')) return ok({ Estimate: s.estimates[path.split('/')[2]] });
    throw new Error('unexpected ' + url);
  };
  return { s, fetchImpl };
}

async function setup(t) {
  const db = await testDb(t);
  const d = createDispatch(db, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  await d.prices.seed();
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const fake = fakeQbo();
  const qbo = createQuickBooks(db, d, { clientId: 'cid', clientSecret: 'secret', environment: 'sandbox',
    redirectUri: 'https://dispatch.example/qbo/callback', fetchImpl: fake.fetchImpl });
  d.onChange((id, action) => { if (!/^Estimate /.test(action)) qbo.enqueue(id); });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { db, d, dave, qbo, fake, settle };
}

const septicLines = [
  { item_key: 'septic.base', description: 'Septic pump-out — up to 1000 gallon tank', qty: 1, unit: 'pump-out', unit_price: 395.57, taxable: 1, kind: 'charge' },
  { item_key: 'water.load', description: 'Water', qty: 1, unit: 'load', unit_price: 150, taxable: 0, kind: 'charge' },
  { item_key: 'bin.deposit.small', description: 'Deposit', qty: 1, unit_price: 500, taxable: 0, kind: 'deposit' },
  { item_key: '', description: 'Extra hoses', qty: 2, unit_price: null, taxable: 1, kind: 'charge' },
];

test('estimate built from the price lines: products by category, HST or exempt, deposit in the note', () => {
  const job = { id: 1042, job_type: 'septic', scheduled_date: '2026-11-12', status: 'open', customer: 'Jane', to_location: '45 Bay Rd',
    municipality: 'McDougall', details: { tank_size: '1000 gal' }, lines: septicLines, assignments: [], tickets: [], created_by_name: 'Olive' };
  const cats = { 'septic.base': 'septic', 'water.load': 'water' };
  const { estimate, missing } = buildEstimate(job, { items: { septic: '30', other: '19' }, tax: { hst: '5', exempt: '7' }, customerRef: '58' },
    { categoryOf: (k) => cats[k] || 'other' });
  assert.deepEqual(missing, []);
  assert.equal(estimate.DocNumber, 'WO-1042');
  assert.equal(estimate.TxnStatus, 'Pending');
  assert.equal(estimate.Line.length, 3, 'the deposit is not a sale');
  assert.deepEqual(estimate.Line.map((l) => [l.SalesItemLineDetail.ItemRef.value, l.SalesItemLineDetail.TaxCodeRef.value, l.Amount]),
    [['30', '5', 395.57], ['19', '7', 150], ['19', '5', 0]]);
  assert.match(estimate.Line[2].Description, /price to be set/);
  assert.match(estimate.PrivateNote, /work order #1042[\s\S]*Created by Olive[\s\S]*Deposit to collect: \$500\.00/);
  assert.equal(estimate.ShipAddr.City, 'McDougall');
  const none = buildEstimate(job, { items: {}, tax: {} });
  assert.ok(none.missing.length >= 3);
});

test('while QuickBooks is off, saving a job keeps a preview of what would be sent — nothing is sent', async (t) => {
  const { d, qbo, fake, settle } = await setup(t);
  const { job } = await d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-12', customer: 'Jane', lines: septicLines });
  await settle();
  const out = await qbo.processQueue();
  assert.equal(out.previewed, 1);
  assert.equal(fake.s.calls.length, 0, 'no calls to QuickBooks');
  const p = await qbo.preview(job.id);
  assert.equal(p.status, 'preview');
  assert.equal(p.payload.DocNumber, `WO-${job.id}`);
  assert.match(p.last_error, /Still to set up/);
  const st = await qbo.status();
  assert.deepEqual([st.configured, st.connected, st.enabled, st.live], [true, false, false, false]);
  // A job with no prices yet waits.
  const bare = (await d.saveJob({ job_type: 'bin', scheduled_date: '2026-11-12', customer: 'K' })).job;
  await qbo.processQueue();
  assert.equal((await qbo.preview(bare.id)).status, 'waiting');
});

test('connected and on: creates the customer and a pending estimate, updates it as the job goes, stops once invoiced', async (t) => {
  const { d, dave, qbo, fake, settle } = await setup(t);
  // Connect (OAuth): the state must match.
  const url = new URL(await qbo.authUrl());
  assert.equal(url.searchParams.get('redirect_uri'), 'https://dispatch.example/qbo/callback');
  assert.equal(url.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  await assert.rejects(() => qbo.finishConnect({ code: 'c', state: 'wrong', realmId: '123' }), /expired/);
  const url2 = new URL(await qbo.authUrl());
  const st = await qbo.finishConnect({ code: 'c', state: url2.searchParams.get('state'), realmId: '123' });
  assert.equal(st.connected, true);
  assert.equal(st.company, 'Adams Bros. Construction Ltd.');
  const lists = await qbo.lists();
  assert.equal(lists.tax_codes[0].name, 'HST ON');
  await qbo.saveMapping({ items: { septic: '11', water: '11', other: '19' }, tax: { hst: '5', exempt: '7' } });
  await qbo.setEnabled(true);

  const { job } = await runAs('Olive', () => d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-12', customer: 'Lake House', customer_phone: '705-555-0444',
    to_location: '9 Shore Rd', lines: septicLines.slice(0, 2), assignments: [{ driver_id: dave.id }] }));
  await settle();
  let out = await qbo.processQueue();
  assert.equal(Object.keys(fake.s.estimates).length, 1, 'one estimate created (by whichever sync run got there first)');
  assert.equal((await qbo.preview(job.id)).status, 'synced');
  const est = Object.values(fake.s.estimates)[0];
  assert.equal(est.TxnStatus, 'Pending');
  assert.equal(est.CustomerRef.value, fake.s.customers.find((c) => c.DisplayName === 'Lake House').Id, 'new customer added in QuickBooks');
  assert.ok((await d.customers.get(job.customer_id)).qbo_id, 'and linked in the address book');
  assert.match((await d.historyFor(job.id)).at(-1).action, /Estimate created in QuickBooks/);

  // The driver finishes and reports: the estimate is updated (same estimate, new SyncToken).
  await d.sendJob(job.id);
  await d.saveReport(job.assignments[0].token, { liquid_level: 'High', comments: 'Baffle cracked' });
  await d.driverAction(job.assignments[0].token, 'done');
  await settle();
  fake.s.expireNext = true; // the sign-in ran out: refreshed and retried
  out = await qbo.processQueue();
  assert.equal(out.sent, 1);
  assert.equal(fake.s.refreshed, 1, 'expired sign-in was refreshed');
  assert.equal(Object.keys(fake.s.estimates).length, 1);
  const updated = Object.values(fake.s.estimates)[0];
  assert.equal(updated.SyncToken, '1');
  assert.match(updated.PrivateNote, /Status: complete[\s\S]*Report — Dave Thompson: liquid level High, comments Baffle cracked/);

  // The bookkeeper turns it into an invoice: the app leaves it alone from then on.
  updated.LinkedTxn = [{ TxnType: 'Invoice', TxnId: '900' }];
  await d.saveJob({ ...(await d.getJob(job.id)), notes: 'changed after invoicing', assignments: [{ driver_id: dave.id }] });
  await settle();
  out = await qbo.processQueue();
  assert.equal(out.locked, 1);
  assert.equal(Object.values(fake.s.estimates)[0].SyncToken, '1', 'not changed');
  await d.saveJob({ ...(await d.getJob(job.id)), notes: 'again', assignments: [{ driver_id: dave.id }] });
  await settle();
  assert.equal((await qbo.preview(job.id)).status, 'locked', 'stays locked');
});

test('existing QuickBooks customers: imported into the address book, and a duplicate name reuses the customer', async (t) => {
  const { d, qbo, fake, settle } = await setup(t);
  const url = new URL(await qbo.authUrl());
  await qbo.finishConnect({ code: 'c', state: url.searchParams.get('state'), realmId: '123' });
  await d.customers.save({ name: 'Existing Company', phone: '705-555-0199' });
  const r = await qbo.importCustomers();
  assert.deepEqual(r, { linked: 1, added: 0 }, 'matched by phone');
  fake.s.customers.push({ Id: '2', DisplayName: 'Northshore Builders' });
  await qbo.saveMapping({ items: { other: '19', septic: '19' }, tax: { hst: '5', exempt: '7' } });
  await qbo.setEnabled(true);
  const { job } = await d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-12', customer: 'Northshore Builders', lines: septicLines.slice(0, 1) });
  await settle();
  await qbo.processQueue();
  assert.equal(Object.values(fake.s.estimates)[0].CustomerRef.value, '2');
  assert.equal((await d.customers.get(job.customer_id)).qbo_id, '2');
});

test('cancelled work orders mark the estimate rejected; sign-ins are never in backups', async (t) => {
  const { db, d, qbo, fake, settle } = await setup(t);
  const url = new URL(await qbo.authUrl());
  await qbo.finishConnect({ code: 'c', state: url.searchParams.get('state'), realmId: '123' });
  await qbo.saveMapping({ items: { other: '19' }, tax: { hst: '5', exempt: '7' } });
  await qbo.setEnabled(true);
  const { job } = await d.saveJob({ job_type: 'bin', scheduled_date: '2026-11-12', customer: 'Kim', lines: septicLines.slice(0, 1) });
  await settle();
  await qbo.processQueue();
  await d.cancelJob(job.id);
  await settle();
  await qbo.processQueue();
  assert.equal(Object.values(fake.s.estimates)[0].TxnStatus, 'Rejected');

  const b = createBackups(db, { storage: null, today: () => '2026-11-10' });
  const dump = gunzipJson(await b.download());
  assert.ok(!dump.tables.settings.some((r) => r.key === 'qbo_tokens'));
  assert.ok(dump.tables.settings.some((r) => r.key === 'qbo_mapping'));
  await qbo.disconnect();
  assert.equal((await qbo.status()).connected, false);
});
