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

test('schedule: hourly copies kept 48 hours, nightly after 2 AM kept 30 days, failures retried later', async (t) => {
  const { db, d } = await filled(t);
  const storage = memoryStorage();
  let day = '2026-11-10';
  let hm = '01:30';
  let clock = Date.now(); // failures are stamped with the database's real clock
  const b = createBackups(db, { storage, server: null, today: () => day, nowHm: () => hm, now: () => clock,
    readPhoto: async (id) => (await d.getTicket(id)).data });
  const first = await b.runScheduled();
  assert.equal(first.name, 'hourly/2026-11-10-01.json.gz', 'an hourly copy, but no nightly before 2 AM');
  assert.equal(await b.runScheduled(), null, 'once an hour');
  hm = '02:01';
  assert.equal((await b.runScheduled()).name, 'db/2026-11-10.json.gz', 'nightly after 2 AM');
  assert.equal((await b.runScheduled()).name, 'hourly/2026-11-10-02.json.gz');
  assert.equal(await b.runScheduled(), null);

  await storage.put('db/2026-10-01.json.gz', Buffer.from('old'));
  await storage.put('db/2026-10-15.json.gz', Buffer.from('keep'));
  await storage.put('hourly/2026-11-08-01.json.gz', Buffer.from('old'));
  await storage.put('hourly/2026-11-09-03.json.gz', Buffer.from('keep'));
  day = '2026-11-11';
  hm = '02:10';
  assert.equal((await b.runScheduled()).ok, true);
  assert.deepEqual((await storage.list('db/')).sort(), ['db/2026-10-15.json.gz', 'db/2026-11-10.json.gz', 'db/2026-11-11.json.gz']);
  assert.ok(!(await storage.list('hourly/')).includes('hourly/2026-11-08-01.json.gz'), 'over 48 hours old: removed');
  assert.ok((await storage.list('hourly/')).includes('hourly/2026-11-09-03.json.gz'));

  storage.put = async () => { throw new Error('bucket not found'); };
  hm = '03:05';
  const bad = await b.runScheduled();
  assert.equal(bad.ok, false);
  assert.equal(await b.runScheduled(), null, 'waits 15 minutes after a failed hourly copy');
  clock += 16 * 60e3;
  assert.equal((await b.runScheduled()).ok, false, 'then tries again');
  const st = await b.status();
  assert.equal(st.runs[0].ok, 0);
  assert.match(st.runs[0].error, /bucket not found/);
  assert.equal(st.keep_hours, 48);
});

test('your own server is a second, separate copy: each one retried on its own', async (t) => {
  const { db, d } = await filled(t);
  const cloud = memoryStorage();
  const server = { ...memoryStorage(), kind: 'server', label: 'your server (nas)' };
  const files = server.files;
  let down = true;
  server.put = async (n, b) => { if (down) throw new Error('connection refused'); files.set(n, Buffer.from(b)); };
  const b = createBackups(db, { storage: cloud, server, today: () => '2026-11-10', nowHm: () => '10:05', now: () => Date.now(),
    readPhoto: async (id) => (await d.getTicket(id)).data });
  const r = await b.runScheduled(); // after 2 AM: the nightly copy first
  assert.equal(r.name, 'db/2026-11-10.json.gz');
  assert.equal(r.ok, false);
  assert.match(r.error, /your server \(nas\): connection refused/);
  assert.ok(cloud.files.has('db/2026-11-10.json.gz'), 'the cloud copy still worked');
  assert.equal(cloud.files.has('photos/1'), true);
  down = false;
  await db.run("UPDATE backups SET at = '2020-01-01 00:00:00' WHERE ok = 0"); // the failure was a while ago
  const again = await b.runScheduled();
  assert.deepEqual(again.results.map((x) => x.target), ['server'], 'only the server is retried');
  assert.ok(files.has('db/2026-11-10.json.gz'));
  assert.equal((await b.runScheduled()).name, 'hourly/2026-11-10-10.json.gz', 'then the hourly copy, to both');
  assert.ok(files.has('photos/1'), 'the server gets its own copy of the photos');
  const st = await b.status();
  assert.deepEqual(st.targets.map((x) => [x.kind, Boolean(x.last_ok)]), [['memory', true], ['server', true]]);
});

test('WebDAV server: makes folders, uploads, lists, deletes', async (t) => {
  const http = require('node:http');
  const store = new Map();
  const dirs = new Set(['/backups/']);
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('josh:pw').toString('base64')) { res.statusCode = 401; return res.end(); }
    const p = decodeURIComponent(req.url);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'MKCOL') { res.statusCode = dirs.has(p) ? 405 : 201; dirs.add(p); return res.end(); }
      if (req.method === 'PUT') {
        if (!dirs.has(p.replace(/[^/]+$/, ''))) { res.statusCode = 409; return res.end(); }
        store.set(p, Buffer.concat(chunks)); res.statusCode = 201; return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') { if (!store.has(p)) { res.statusCode = 404; return res.end(); } return res.end(req.method === 'GET' ? store.get(p) : undefined); }
      if (req.method === 'DELETE') { store.delete(p); res.statusCode = 204; return res.end(); }
      if (req.method === 'PROPFIND') {
        const inside = [...store.keys()].filter((k) => k.startsWith(p));
        res.statusCode = 207;
        return res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${p}</D:href></D:response>${
          inside.map((k) => `<D:response><D:href>${encodeURI(k)}</D:href></D:response>`).join('')}</D:multistatus>`);
      }
      res.statusCode = 405; res.end();
    });
  }).listen(0);
  t.after(() => srv.close());
  const { serverTarget } = require('../src/backupTargets');
  const s = serverTarget({ BACKUP_SERVER_URL: `http://localhost:${srv.address().port}/backups`, BACKUP_SERVER_USER: 'josh', BACKUP_SERVER_PASSWORD: 'pw' });
  assert.equal(s.kind, 'server');
  await s.put('hourly/2026-11-10-10.json.gz', Buffer.from('abc'));
  await s.put('photos/7', Buffer.from('img'));
  assert.deepEqual(await s.list('hourly/'), ['hourly/2026-11-10-10.json.gz']);
  assert.equal(String(await s.get('photos/7')), 'img');
  assert.equal(await s.exists('photos/8'), false);
  await s.remove('hourly/2026-11-10-10.json.gz');
  assert.deepEqual(await s.list('hourly/'), []);
  const wrong = serverTarget({ BACKUP_SERVER_URL: `http://localhost:${srv.address().port}/backups`, BACKUP_SERVER_USER: 'josh', BACKUP_SERVER_PASSWORD: 'no' });
  await assert.rejects(() => wrong.put('x/y', Buffer.from('a')), /HTTP 401 \(check BACKUP_SERVER_USER/);
  assert.throws(() => serverTarget({ BACKUP_SERVER_URL: 'ftp://x' }), /must start with/);
  assert.equal(serverTarget({}), null);
});

test('S3-compatible server: signed requests, folder prefix, paged lists', async () => {
  const { serverTarget } = require('../src/backupTargets');
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    assert.match(opts.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20261110\/ca-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    if (opts.method === 'GET' && url.includes('list-type=2')) {
      const page2 = url.includes('continuation-token');
      return { ok: true, status: 200, text: async () => `<ListBucketResult><Key>adams/db/${page2 ? 'b' : 'a'}.json.gz</Key>${page2 ? '' : '<IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken>'}</ListBucketResult>` };
    }
    if (opts.method === 'HEAD') return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const s = serverTarget({ BACKUP_SERVER_URL: 's3://dispatch-backups/adams', BACKUP_SERVER_ENDPOINT: 'https://nas.example.ca:9000',
    BACKUP_SERVER_REGION: 'ca-central-1', BACKUP_SERVER_USER: 'AKID', BACKUP_SERVER_PASSWORD: 'secret' },
  { fetchImpl, now: () => new Date('2026-11-10T15:04:05Z') });
  await s.put('photos/1', Buffer.from('x'));
  assert.equal(calls[0].url, 'https://nas.example.ca:9000/dispatch-backups/adams/photos/1');
  assert.equal(calls[0].opts.headers['x-amz-date'], '20261110T150405Z');
  assert.deepEqual(await s.list('db/'), ['db/a.json.gz', 'db/b.json.gz']);
  assert.equal(await s.exists('photos/2'), false);
});

test('Download a copy: one zip with the database and the photos by work order, which restores everything', async (t) => {
  const { db, d, job } = await filled(t);
  const b = createBackups(db, { storage: null, server: null, today: () => '2026-11-10', readPhoto: async (id) => (await d.getTicket(id)).data });
  const chunks = [];
  const out = await b.downloadZip(async (buf) => { chunks.push(buf); });
  assert.equal(out.photos, 1);
  const file = require('node:path').join(require('node:os').tmpdir(), `dl-${process.pid}-${Date.now()}.zip`);
  require('node:fs').writeFileSync(file, Buffer.concat(chunks));
  t.after(() => require('node:fs').rmSync(file, { force: true }));
  const { readZip } = require('../src/zip');
  const z = readZip(file);
  const names = z.entries.map((e) => e.name);
  z.close();
  assert.ok(names.includes('adams-dispatch-database-2026-11-10.json.gz'));
  assert.ok(names.includes('Photos/index.csv'));
  assert.ok(names.includes('README.txt'));
  const photo = names.find((n) => n.startsWith('Photos/WO-'));
  assert.match(photo, new RegExp(`^Photos/WO-${job.id} - Jane - 2026-11-10/ticket 1 - Dave Thompson - .+\\.png$`));

  const { loadZipBackup } = require('../src/backup');
  const zb = loadZipBackup(file);
  t.after(() => zb.close());
  assert.equal(zb.photoCount, 1);
  const db2 = await testDb(t);
  const r = await restore(db2, zb.backup, { photoFor: zb.photoFor });
  assert.equal(r.counts.jobs, 1);
  assert.equal(r.photos, 1);
  const d2 = createDispatch(db2, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  assert.deepEqual((await d2.getTicket(1)).data, PNG);
});

test('Replit Object Storage: a failed connection never crashes the app, and the next backup retries', async () => {
  let made = 0;
  class Broken {
    constructor() {
      made++;
      // Like the real library: starts connecting in the constructor, and rejects if that fails.
      this.state = { promise: Promise.reject(new Error('fetch failed')) };
    }
    async uploadFromBytes() { throw new Error('fetch failed'); }
  }
  const s = replitStorage(Broken, { bucketId: 'b' });
  assert.equal(made, 0, 'nothing connects until a backup runs');
  await assert.rejects(() => s.put('db/x', Buffer.from('a')), /Object Storage upload failed: fetch failed/);
  await assert.rejects(() => s.put('db/x', Buffer.from('a')), /fetch failed/);
  assert.equal(made, 2, 'a new connection is tried for the next backup');
  await new Promise((r) => setImmediate(r)); // no unhandled rejection is left behind
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
  const s = replitStorage(FakeClient, { bucketId: 'test-bucket' });
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
  assert.equal((await fetch(base + '/api/backups/download?only=database')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'office@test.ca', password: 'password123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ran = await (await fetch(base + '/api/backups/run', { method: 'POST', headers: { cookie } })).json();
  assert.equal(ran.ok, true);
  const st = await (await fetch(base + '/api/backups', { headers: { cookie } })).json();
  assert.equal(st.runs.length, 1);
  const zip = await fetch(base + '/api/backups/download', { headers: { cookie } });
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.match(zip.headers.get('content-disposition'), /adams-dispatch-backup-2026-11-10\.zip/);
  assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0), 0x04034b50, 'a zip file');
  const dl = await fetch(base + '/api/backups/download?only=database', { headers: { cookie } });
  assert.match(dl.headers.get('content-disposition'), /adams-dispatch-backup-2026-11-10\.json\.gz/);
  const copy = gunzipJson(Buffer.from(await dl.arrayBuffer()));
  assert.equal(copy.tables.jobs.length, 1);
  assert.equal(copy.tables.sessions, undefined, 'logins in progress are not in backups');
});
