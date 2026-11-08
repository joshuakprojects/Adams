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
  const dispatch = createDispatch(db, { send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; } });
  const server = createApp({ db, dispatch }).listen(0);
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
  assert.match(html, /Job #1001/);
  assert.match(html, /Topsoil/);
  res = await fetch(`${base}/j/${token}/load`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 303);
  await fetch(`${base}/j/${token}/done`, { method: 'POST', redirect: 'manual' });

  const board = (await api('/board?date=' + today)).data;
  assert.equal(board.jobs[0].status, 'complete');
  assert.equal(board.jobs[0].assignments[0].loads_done, 1);
  assert.equal(board.jobs[0].assignments[0].ack_via, 'sms');

  res = await fetch(base + '/j/not-a-real-token');
  assert.equal(res.status, 404);
  res = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(res.status, 302);
});
