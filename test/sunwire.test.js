const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createApp } = require('../src/server');
const { createSunwire, digits, plainText } = require('../src/sunwire');
const { request } = require('../src/httpOut');

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

test('plain characters for SMS, and Sunwire number format', () => {
  assert.equal(plainText('Deliver - 2× Standard — “Lake” ‘Rd’ … · ✓'), 'Deliver - 2x Standard - "Lake" \'Rd\' ... - OK');
  assert.equal(digits('+17055551234'), '17055551234');
  assert.equal(digits('705-555-1234'), '17055551234');
});

test('sending through Sunwire: the right fields and key, refusals explained', async () => {
  const calls = [];
  let answer = { Status: 'OK', ID: '67df965509094' };
  const requestImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: () => answer };
  };
  const s = createSunwire({ cfg: { smsUrl: 'https://api.sunwire.ca/sms/', mmsUrl: 'https://api.sunwire.ca/mms/', fromNumber: '705-746-2962', key: 'K1', inboundKey: 'IN' },
    proxy: 'http://u:p@relay.example:9293', requestImpl });
  assert.deepEqual(await s.sendSms('+17055551234', 'Hi'), { sid: '67df965509094' });
  assert.equal(calls[0].url, 'https://api.sunwire.ca/sms/');
  assert.equal(calls[0].opts.proxy, 'http://u:p@relay.example:9293');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { From: '17057462962', To: '17055551234', Body: 'Hi', Key: 'K1' });
  await s.sendMms('+17055551234', { buffer: JPEG, contentType: 'image/jpeg', name: 't.jpg' });
  assert.equal(JSON.parse(calls[1].opts.body).Content, JPEG.toString('base64'));
  answer = { Status: 'Fail', Reason: 'IP address not allowed.' };
  await assert.rejects(() => s.sendSms('+17055551234', 'Hi'), /IP address not allowed\. \(is the fixed IP/);
  assert.deepEqual(s.parseBody('MMS received (link will expire in 7 days): https://x.sunwire.ca/download-file.php?mms=1&contenttype=image/jpeg'),
    { text: '', links: ['https://x.sunwire.ca/download-file.php?mms=1&contenttype=image/jpeg'] });
  assert.deepEqual(s.parseBody('DONE 1042'), { text: 'DONE 1042', links: [] });
  await assert.rejects(() => s.fetchPhoto('https://evil.example/x.jpg'), /Unexpected photo link/);
  assert.equal(s.status().configured, true);
  assert.equal(createSunwire({ cfg: {}, proxy: '' }).status().problems.length, 3);
});

test('the fixed-IP relay: requests tunnel through an HTTP CONNECT proxy, with its login', async (t) => {
  const target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => res.end(JSON.stringify({ Status: 'OK', ID: 'via-relay', got: JSON.parse(body || '{}') })));
  }).listen(0);
  let auth = null;
  const sockets = new Set();
  const relay = http.createServer().on('connect', (req, client) => {
    sockets.add(client);
    auth = req.headers['proxy-authorization'];
    if (auth !== 'Basic ' + Buffer.from('user:pa ss').toString('base64')) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(client); client.pipe(up); });
    sockets.add(up);
  }).listen(0);
  t.after(() => {
    for (const s of sockets) s.destroy();
    target.closeAllConnections();
    target.close();
    relay.closeAllConnections();
    relay.close();
  });
  const url = `http://127.0.0.1:${target.address().port}/sms/`;
  const res = await request(url, { method: 'POST', body: JSON.stringify({ To: '1' }), headers: { 'Content-Type': 'application/json' },
    proxy: `http://user:pa%20ss@127.0.0.1:${relay.address().port}` });
  assert.equal(res.json().ID, 'via-relay');
  assert.deepEqual(res.json().got, { To: '1' });
  await assert.rejects(() => request(url, { method: 'POST', body: '{}', proxy: `http://user:wrong@127.0.0.1:${relay.address().port}` }), /HTTP 407/);
  const direct = await request(url, { method: 'POST', body: '{}' });
  assert.equal(direct.json().ID, 'via-relay', 'works without a relay too');
});

test('incoming texts and photos from Sunwire: key checked, photo saved, reply sent as its own text, retries ignored', async (t) => {
  const db = await testDb(t);
  const sent = [];
  const d = createDispatch(db, { send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; }, today: () => '2026-11-10' });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const { job } = await d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-10', customer: 'Jane', assignments: [{ driver_id: dave.id }] });
  await d.sendJob(job.id);
  const downloads = [];
  const sunwire = createSunwire({ cfg: { smsUrl: 'https://api.sunwire.ca/sms/', fromNumber: '7057462962', inboundKey: 'secret-in' }, proxy: '',
    requestImpl: async (url) => { downloads.push(url); return { ok: true, status: 200, buffer: JPEG, headers: { 'content-type': 'image/jpeg' }, json: () => ({}) }; } });
  const replies = [];
  const server = createApp({ db, dispatch: d, sunwire, smsProvider: 'sunwire', sendReply: async (to, body) => { replies.push({ to, body }); } }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const post = async (body, headers = {}) => {
    const r = await fetch(base + '/sms/sunwire', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await post({ Type: 'Message', ID: '1', From: '7055550101', To: '7057462962', Body: 'ok' })).status, 401, 'no key: refused');
  assert.equal((await post({ Type: 'Message', ID: '1', From: '7055550101', To: '7057462962', Body: 'ok', Key: 'wrong' })).status, 401);
  const ok = await post({ Type: 'Message', ID: '1', From: '17055550101', To: '17057462962', Body: 'ok', Key: 'secret-in' });
  assert.deepEqual(ok.body, { Status: 'OK' });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(replies[0].body, /Thanks Dave - Job #\d+ .*confirmed/);
  assert.equal(replies[0].to, '+17055550101');
  assert.equal((await d.getJob(job.id)).assignments[0].status, 'acknowledged');

  // A photo, with the key as a header this time.
  const photo = { Type: 'Message', ID: '2', From: '7055550101', To: '7057462962',
    Body: 'MMS received (link will expire in 7 days): https://x.sunwire.ca/download-file.php?mms=1234&hash=abcd&filename=image.jpg&contenttype=image/jpeg' };
  assert.equal((await post(photo, { 'x-api-key': 'secret-in' })).status, 200);
  assert.equal(downloads.length, 1);
  const tickets = (await d.getJob(job.id)).tickets;
  assert.equal(tickets.length, 1);
  assert.deepEqual((await d.getTicket(tickets[0].id)).data, JPEG);
  // Sunwire retries the same message: handled once.
  await post(photo, { authorization: 'Bearer secret-in' });
  assert.equal((await d.getJob(job.id)).tickets.length, 1);
  assert.equal(downloads.length, 1);
  // Delivery receipts are accepted and ignored.
  assert.deepEqual((await post({ Type: 'Report', ID: '9', Status: '0', Key: 'secret-in' })).body, { Status: 'OK' });

  // With Twilio switched on, this address is closed.
  const tw = createApp({ db, dispatch: d, sunwire, smsProvider: 'twilio' }).listen(0);
  t.after(() => tw.close());
  const r = await fetch(`http://localhost:${tw.address().port}/sms/sunwire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 503);
});
