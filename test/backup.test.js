const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const { createBackups, restore, gunzipJson, replitStorage } = require('../src/backup');

function memoryStorage() {
  const files = new Map();
  return {
    kind: 'memory', label: 'memory', files,
    async put(n, b) { files.set(n, Buffer.from(b)); },
    async get(n) { if (!files.has(n)) throw new Error('missing'); return files.get(n); },
    async exists(n) { return files.has(n); },
    async list(p) { return [...files.keys()].filter((n) => n.startsWith(p)); },
    async remove(n) { files.delete(n); },
  };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082', 'hex');

async function filled(t) {
  const db = await testDb(t);
  const d = createDispatch(db, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  await createUser(db, { email: 'office@test.ca', name: 'Josh', password: 'password123' });
  const truck = await d.saveTruck({ unit: 'T1', kind: 'haul' });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101', default_truck_id: truck.id });
  const { job } = await d.saveJob({ job_type: 'haul', scheduled_date: '2026-11-10', customer: 'Jane', customer_phone: '705-555-0199',
    material: 'Sand', to_location: '45 Bay Rd', invoice_number: 'INV-9', assignments: [{ driver_id: dave.id, truck_id: truck.id }] });
  await d.saveTicket({ assignment: { ...job.assignments[0], job_id: job.id }, driverId: dave.id, buffer: PNG, contentType: 'image/png' });
  return { db, d, job };
}

test('backup → restore round trip, with photos, into an empty database', async (t) => {
  const { db, d, job } = await filled(t);
  const storage = memoryStorage();
  const b = createBackups(db, { storage, today: () => '2026-11-10', nowHm: () => '02:05', readPhoto: async (id) => (await d.getTicket(id)).data });
  const out = await b.run();
  assert.equal(out.ok, true, out.error);
  assert.equal(out.photos, 1);
  assert.ok(storage.files.has('db/2026-11-10.json.gz'));
  const backup = gunzipJson(storage.files.get('db/2026-11-10.json.gz'));
  assert.equal(backup.tables.jobs[0].invoice_number, 'INV-9');
  assert.equal(backup.tables.tickets[0].data, undefined, 'photo bytes are not inside the database copy');
  assert.equal((await b.run()).photos, 0, 'photos are only uploaded once');

  // Restore into a brand-new database.
  const db2 = await testDb(t);
  await assert.rejects(() => restore(db, backup), /already has drivers or jobs/);
  const r = await restore(db2, backup, { photoFor: async (id) => storage.get('photos/' + id) });
  assert.equal(r.counts.jobs, 1);
  assert.equal(r.photos, 1);
  const d2 = createDispatch(db2, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  const back = await d2.getJob(job.id);
  assert.equal(back.customer, 'Jane');
  assert.equal(back.assignments[0].driver_name, 'Dave Thompson');
  assert.equal(back.assignments[0].token, job.assignments[0].token, 'driver links keep working');
  assert.deepEqual((await d2.getTicket(back.tickets[0].id)).data, PNG);
  // New rows after a restore don't collide with restored ids.
  const next = (await d2.saveJob({ job_type: 'bin', scheduled_date: '2026-11-11', customer: 'New' })).job;
  assert.ok(next.id > job.id);
  // The office login came across.
  assert.ok(await db2.get("SELECT id FROM users WHERE email = 'office@test.ca'"));
});

test('nightly schedule, 30-day pruning and failure logging', async (t) => {
  const { db, d } = await filled(t);
  const storage = memoryStorage();
  let day = '2026-11-10';
  let hm = '01:30';
  const b = createBackups(db, { storage, today: () => day, nowHm: () => hm, readPhoto: async (id) => (await d.getTicket(id)).data });
  assert.equal(await b.runScheduled(), null, 'not before 2 AM');
  hm = '02:01';
  assert.equal((await b.runScheduled()).ok, true);
  assert.equal(await b.runScheduled(), null, 'once a night');
  await storage.put('db/2026-10-01.json.gz', Buffer.from('old'));
  await storage.put('db/2026-10-15.json.gz', Buffer.from('keep'));
  day = '2026-11-11';
  assert.equal((await b.runScheduled()).ok, true);
  const names = (await storage.list('db/')).sort();
  assert.deepEqual(names, ['db/2026-10-15.json.gz', 'db/2026-11-10.json.gz', 'db/2026-11-11.json.gz']);

  storage.put = async () => { throw new Error('bucket not found'); };
  day = '2026-11-12';
  const bad = await b.runScheduled();
  assert.equal(bad.ok, false);
  assert.equal(await b.runScheduled(), null, 'waits an hour after a failure');
  const st = await b.status();
  assert.equal(st.runs[0].ok, 0);
  assert.match(st.runs[0].error, /bucket not found/);
});

test('Replit Object Storage adapter unwraps results', async () => {
  const calls = [];
  class FakeClient {
    async uploadFromBytes(n, b) { calls.push(['up', n, b.length]); return { ok: true }; }
    async downloadAsBytes(n) { return { ok: true, value: [Buffer.from('hi ' + n)] }; }
    async exists() { return { ok: true, value: true }; }
    async list({ prefix }) { return { ok: true, value: [{ name: prefix + 'a' }] }; }
    async delete(n) { return n === 'bad' ? { ok: false, error: { message: 'nope' } } : { ok: true }; }
  }
  const s = replitStorage(FakeClient);
  await s.put('db/x', Buffer.from('abc'));
  assert.deepEqual(calls, [['up', 'db/x', 3]]);
  assert.equal(String(await s.get('k')), 'hi k');
  assert.deepEqual(await s.list('db/'), ['db/a']);
  await assert.rejects(() => s.remove('bad'), /Object Storage delete failed: nope/);
});

test('backup endpoints: status, run now, download', async (t) => {
  const { db, d } = await filled(t);
  const storage = memoryStorage();
  const backups = createBackups(db, { storage, today: () => '2026-11-10', nowHm: () => '10:00', readPhoto: async (id) => (await d.getTicket(id)).data });
  const server = createApp({ db, dispatch: d, backups }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  assert.equal((await fetch(base + '/api/backups/download')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'office@test.ca', password: 'password123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ran = await (await fetch(base + '/api/backups/run', { method: 'POST', headers: { cookie } })).json();
  assert.equal(ran.ok, true);
  const st = await (await fetch(base + '/api/backups', { headers: { cookie } })).json();
  assert.equal(st.runs.length, 1);
  const dl = await fetch(base + '/api/backups/download', { headers: { cookie } });
  assert.match(dl.headers.get('content-disposition'), /adams-dispatch-backup-2026-11-10\.json\.gz/);
  const copy = gunzipJson(Buffer.from(await dl.arrayBuffer()));
  assert.equal(copy.tables.jobs.length, 1);
  assert.equal(copy.tables.sessions, undefined, 'logins in progress are not in backups');
});
