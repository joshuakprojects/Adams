const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const { createBackups, restore, gunzipJson } = require('../src/backup');
const { runAs } = require('../src/actor');

function memoryStorage(kind = 'memory') {
  const files = new Map();
  return {
    kind, label: kind, files,
    async put(n, b) { files.set(n, Buffer.from(b)); },
    async get(n) { if (!files.has(n)) throw new Error('missing'); return files.get(n); },
    async exists(n) { return files.has(n); },
    async list(p) { return [...files.keys()].filter((n) => n.startsWith(p)); },
    async remove(n) { files.delete(n); },
  };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

async function filled(t) {
  const db = await testDb(t);
  const d = createDispatch(db, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  await d.prices.seed();
  await createUser(db, { email: 'josh@adamsbros.ca', name: 'Josh', password: 'password123', role: 'admin' });
  await createUser(db, { email: 'office@test.ca', name: 'Olive', password: 'password123', role: 'admin' });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const { job } = await runAs('Josh', () => d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-12', customer: 'Jane', customer_phone: '705-555-0199',
    to_location: '9 Shore Rd', assignments: [{ driver_id: dave.id }],
    lines: [{ item_key: 'septic.base', description: 'Pump-out', qty: 1, unit_price: 395.57, taxable: 1 }] }));
  await d.saveTicket({ assignment: { ...job.assignments[0], job_id: job.id }, driverId: dave.id, buffer: PNG, contentType: 'image/png' });
  const base = (await d.prices.list()).find((i) => i.key === 'septic.base');
  await runAs('Josh', () => d.prices.save([{ id: base.id, price: 410 }]));
  await db.run("INSERT INTO faq (question, answer, topic) VALUES ('How often?', 'Every 3 years', 'Septic')");
  return { db, d, job, dave };
}

test('backups include the price book, price lines, price changes and questions — and restore over a fresh price book', async (t) => {
  const { db, d, job } = await filled(t);
  const storage = memoryStorage();
  const b = createBackups(db, { storage, server: null, today: () => '2026-11-10', nowHm: () => '10:00', readPhoto: async (id) => (await d.getTicket(id)).data });
  await b.run();
  const backup = gunzipJson(storage.files.get('db/2026-11-10.json.gz'));
  for (const name of ['price_items', 'price_changes', 'job_lines', 'faq']) assert.ok(backup.tables[name].length, `${name} is backed up`);

  // A brand-new app has already loaded the price book from the sheets: the restore replaces it.
  const db2 = await testDb(t);
  const d2 = createDispatch(db2, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  await d2.prices.seed();
  await restore(db2, backup, { photoFor: async (id) => storage.get('photos/' + id) });
  assert.equal((await d2.prices.book()).items['septic.base'].price, 410, 'the edited price came back');
  const back = await d2.getJob(job.id);
  assert.equal(back.lines[0].unit_price, 395.57, 'the job kept the price it was booked at');
  assert.equal((await db2.all('SELECT * FROM faq')).length, 1);

  // A backup from before the price book existed leaves the price book alone instead of emptying it.
  const old = { ...backup, tables: { ...backup.tables } };
  for (const k of ['price_items', 'price_changes', 'job_lines', 'faq', 'qbo_sync']) delete old.tables[k];
  await restore(db2, old, { force: true });
  assert.ok(Object.keys((await d2.prices.book()).items).length > 100);
});

test('Restore button: owner only, typed confirmation, safety copy first, from a stored copy or an uploaded zip', async (t) => {
  const { db, d, job } = await filled(t);
  const storage = memoryStorage('replit');
  const backups = createBackups(db, { storage, server: null, today: () => '2026-11-10', nowHm: () => '10:15', readPhoto: async (id) => (await d.getTicket(id)).data });
  await backups.run();
  const server = createApp({ db, dispatch: d, backups }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const login = async (email) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }) })).headers.get('set-cookie')?.split(';')[0];
  const call = async (cookie, method, p, body, raw) => {
    const r = await fetch(base + '/api' + p, { method, headers: { cookie, 'Content-Type': raw ? 'application/zip' : 'application/json' },
      body: raw || (body && JSON.stringify(body)) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const other = await login('office@test.ca');
  assert.equal((await call(other, 'GET', '/backups/stored')).status, 403, 'another admin cannot restore');
  let josh = await login('josh@adamsbros.ca');
  const list = (await call(josh, 'GET', '/backups/stored')).body;
  assert.deepEqual(list.map((x) => [x.target, x.name, x.kind]), [['replit', 'db/2026-11-10.json.gz', 'nightly']]);

  // Work done after the backup…
  await d.saveJob({ job_type: 'bin', scheduled_date: '2026-11-13', customer: 'After the backup' });
  assert.equal((await call(josh, 'POST', '/backups/restore', { target: 'replit', name: list[0].name })).status, 400, 'needs RESTORE typed');
  const r = await call(josh, 'POST', '/backups/restore', { target: 'replit', name: list[0].name, confirm: 'RESTORE' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.safety, /^safety\/2026-11-10-1015\d\d(-\d+)?\.json\.gz$/);
  assert.ok(storage.files.has(r.body.safety), 'safety copy saved first');
  assert.equal(r.body.photos, 1);
  assert.equal((await db.all("SELECT id FROM jobs WHERE customer = 'After the backup'")).length, 0, '…is replaced by the backup');
  // The safety copy still has it, and can itself be restored.
  assert.ok(gunzipJson(storage.files.get(r.body.safety)).tables.jobs.some((j) => j.customer === 'After the backup'));
  assert.equal((await call(josh, 'GET', '/backups/stored')).status, 401, 'everyone signs in again after a restore');
  josh = await login('josh@adamsbros.ca');
  assert.ok((await call(josh, 'GET', '/backups/stored')).body.some((x) => x.kind === 'safety'));

  // From a "Download a copy" zip, uploaded.
  const zip = Buffer.from(await (await fetch(base + '/api/backups/download', { headers: { cookie: josh } })).arrayBuffer());
  await d.cancelJob(job.id);
  const up = await call(josh, 'POST', '/backups/restore-upload?confirm=RESTORE', null, zip);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.photos, 1);
  assert.notEqual(up.body.safety, r.body.safety, 'each restore keeps its own safety copy');
  assert.equal((await d.getJob(job.id)).status, 'open', 'back as it was in the zip');
  assert.deepEqual((await d.getTicket(1)).data, PNG);
  assert.equal((await call(await login('josh@adamsbros.ca'), 'POST', '/backups/restore', { target: 'replit', name: '../x', confirm: 'RESTORE' })).status, 400);
});
