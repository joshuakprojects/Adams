const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { openDb } = require('../src/db');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');

test('office login, create & text a job, driver confirms by SMS and finishes on the page', async (t) => {
  const db = openDb(':memory:');
  createUser(db, { email: 'office@test.ca', name: 'Office', password: 'password123' });
  const sent = [];
  const uploadDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'up-'));
  const dispatch = createDispatch(db, { uploadDir, send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; } });
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xff, 0xd9]);
  const fetched = [];
  const fetchMedia = async (url) => { fetched.push(url); return { buffer: JPEG, contentType: 'image/jpeg' }; };
  const server = createApp({ db, dispatch, fetchMedia }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;

  let res = await fetch(base + '/api/board');
  assert.equal(res.status, 401);

  res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'office@test.ca', password: 'wrong' }) });
  assert.equal(res.status, 401);
  res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'office@test.ca', password: 'password123' }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + '/api' + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };

  const truck = (await api('/trucks', { unit: 'T1', kind: 'haul' })).data;
  const driver = (await api('/drivers', { name: 'Dave', phone: '403-555-0101', default_truck_id: truck.id })).data;
  const today = (await api('/me')).data.today;
  const { data } = await api('/jobs', {
    job_type: 'haul', scheduled_date: today, scheduled_time: '07:00', material: 'Topsoil', loads_planned: 3,
    from_location: 'Pit', to_location: 'Site', assignments: [{ driver_id: driver.id, truck_id: truck.id }], send_now: true,
  });
  assert.equal(data.results[0].ok, true);
  assert.equal(sent.length, 1);
  const token = data.job.assignments[0].token;
  assert.ok(sent[0].body.includes(`/j/${token}`));

  // Driver texts back OK through the Twilio webhook.
  res = await fetch(base + '/sms/inbound', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '+14035550101', Body: 'OK' }) });
  const xml = await res.text();
  assert.match(xml, /<Message>Thanks Dave - Job #1001 .* confirmed\.<\/Message>/);

  // Driver opens the link and taps buttons (no login).
  res = await fetch(base + '/j/' + token);
  const html = await res.text();
  assert.match(html, /Aggregate Work Order/);
  assert.match(html, /#1001/);
  assert.match(html, /Topsoil/);
  res = await fetch(`${base}/j/${token}/report`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ driver_notes: 'Gate was locked, waited 10 min' }) });
  assert.equal(res.status, 303);
  assert.match(await (await fetch(base + '/j/' + token + '?saved=1')).text(), /Saved/);
  // Scale ticket photo from the page, and one texted in.
  res = await fetch(`${base}/j/${token}/ticket`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
  const { id: ticketId } = await res.json();
  res = await fetch(`${base}/j/${token}/ticket/${ticketId}`);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  res = await fetch(`${base}/j/${token}/ticket`, { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: '<script>' });
  assert.equal(res.status, 400);
  res = await fetch(base + '/sms/inbound', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '+14035550101', Body: '', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1' }) });
  assert.match(await res.text(), /Got your ticket photo for Job #1001/);
  assert.equal(fetched.length, 1);
  assert.match(await (await fetch(base + '/j/' + token)).text(), /ticket\/\d+/);
  assert.equal((await fetch(`${base}/api/tickets/${ticketId}/image`, { redirect: 'manual' })).status, 401);

  res = await fetch(`${base}/j/${token}/load`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 303);
  await fetch(`${base}/j/${token}/done`, { method: 'POST', redirect: 'manual' });

  const board = (await api('/board?date=' + today)).data;
  assert.equal(board.jobs[0].status, 'complete');
  assert.equal(board.jobs[0].assignments[0].loads_done, 1);
  assert.equal(board.jobs[0].assignments[0].ack_via, 'sms');
  assert.equal(board.jobs[0].tickets.length, 2);
  assert.equal(board.jobs[0].assignments[0].report.driver_notes, 'Gate was locked, waited 10 min');
  res = await fetch(`${base}/api/tickets/${ticketId}/image`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal((await api('/settings', { lineup_time: '18:30' })).data.lineup_time, '18:30');
  assert.equal((await api('/lineup/send', { date: 'nope' })).status, 400);

  res = await fetch(base + '/j/not-a-real-token');
  assert.equal(res.status, 404);
  res = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(res.status, 302);
});
