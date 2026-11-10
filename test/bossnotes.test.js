const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');

test('notes from the boss: only the ticked logins post or remove; everyone (reception too) reads; only the owner ticks', async (t) => {
  const db = await testDb(t);
  const d = createDispatch(db, { send: async () => ({ sid: 'x' }), today: () => '2026-11-10' });
  await createUser(db, { email: 'josh@adamsbros.ca', name: 'Josh', password: 'password123', role: 'admin' });
  const danielle = await createUser(db, { email: 'danielle@test.ca', name: 'Danielle', password: 'password123', role: 'admin' });
  await createUser(db, { email: 'disp@test.ca', name: 'Dee', password: 'password123', role: 'dispatcher' });
  await createUser(db, { email: 'office@test.ca', name: 'Olive', password: 'password123', role: 'office' });
  const server = createApp({ db, dispatch: d }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const as = async (email) => {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return async (method, p, body) => {
      const r = await fetch(base + '/api' + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
  };
  const owner = await as('josh@adamsbros.ca');
  const dan = await as('danielle@test.ca');
  const dee = await as('disp@test.ca');
  const office = await as('office@test.ca');

  assert.equal((await dan('POST', '/boss-notes', { body: 'Hi' })).status, 403, 'not ticked yet');
  assert.equal((await dan('PUT', `/users/${danielle}`, { boss_notes: true })).status, 403, 'only the owner ticks it');
  await owner('PUT', `/users/${danielle}`, { boss_notes: true });
  assert.equal((await owner('GET', '/users')).body.find((u) => u.id === danielle).boss_notes, 1);
  assert.equal((await dan('GET', '/me')).body.can.notes, true);
  assert.equal((await dee('GET', '/me')).body.can.notes, false);

  const n = (await dan('POST', '/boss-notes', { body: 'No septic bookings in McDougall next week.' })).body;
  assert.equal(n.author, 'Danielle');
  assert.equal((await dan('POST', '/boss-notes', { body: '  ' })).status, 400);
  assert.equal((await office('GET', '/boss-notes')).body[0].body, 'No septic bookings in McDougall next week.', 'reception reads it');
  assert.equal((await office('POST', '/boss-notes', { body: 'x' })).status, 403, 'reception cannot post');
  assert.equal((await dee('DELETE', `/boss-notes/${n.id}`)).status, 403, 'other dispatchers cannot remove');
  assert.equal((await dan('DELETE', `/boss-notes/${n.id}`)).status, 200);
  assert.deepEqual((await office('GET', '/boss-notes')).body, []);
});
