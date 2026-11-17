const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createSnow, zonedTime, sayTime } = require('../src/snow');

const TZ = 'America/Toronto';

async function setup(t, { live = true } = {}) {
  const db = await testDb(t);
  let clock = new Date('2026-12-03T07:30:00Z'); // 2:30 AM in Parry Sound (EST, UTC-5)
  const texts = [];
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const p = new URLSearchParams(opts.body);
    calls.push({ to: p.get('To'), from: p.get('From'), url: p.get('Url'), status: p.get('StatusCallback') });
    return { ok: true, status: 201, json: async () => ({ sid: 'CA' + calls.length }) };
  };
  const snow = createSnow(db, { send: async (to, body) => { texts.push({ to, body }); }, now: () => clock, timeZone: TZ, publicUrl: 'https://dispatch.example',
    twilio: { accountSid: 'AC1', authToken: 'tok' }, voiceFrom: '+17055550000', fetchImpl, live });
  const bob = await snow.saveShoveler({ name: 'Bob Smith', phone: '705-555-0301', call_ahead_min: 60 });
  const sue = await snow.saveShoveler({ name: 'Sue Lee', phone: '705-555-0302', call_ahead_min: 30 });
  return { db, snow, texts, calls, bob, sue, at: (iso) => { clock = new Date(iso); } };
}

test('times: local start time to the real moment; said plainly', () => {
  assert.equal(zonedTime('2026-12-03', '04:00', TZ).toISOString(), '2026-12-03T09:00:00.000Z');
  assert.equal(zonedTime('2026-07-03', '04:00', TZ).toISOString(), '2026-07-03T08:00:00.000Z', 'summer time');
  assert.equal(sayTime('04:00'), '4 AM');
  assert.equal(sayTime('04:30'), '4:30 AM');
});

test('shovelers: name, cell and call-ahead time checked', async (t) => {
  const { snow } = await setup(t);
  await assert.rejects(() => snow.saveShoveler({ name: 'X', phone: '12', call_ahead_min: 30 }), /cell number/);
  await assert.rejects(() => snow.saveShoveler({ name: 'X', phone: '705-555-0399', call_ahead_min: 500 }), /0 to 240/);
  assert.equal((await snow.listShovelers()).map((s) => s.name).join(), 'Bob Smith,Sue Lee', 'longest call-ahead first');
});

test('snow call: each shoveler phoned and texted at their own call-ahead time; key presses and texts answer it', async (t) => {
  const { snow, texts, calls, at } = await setup(t);
  const c = await snow.start({ day: '2026-12-03', time: '04:00', place: 'the yard', note: 'Bring your own shovel', notify: '705-555-0100' }, 'Night Guy');
  assert.equal(c.say, '4 AM');
  assert.deepEqual(c.people.map((p) => [p.name, p.due_at]), [['Bob Smith', '2026-12-03 08:00:00'], ['Sue Lee', '2026-12-03 08:30:00']]);
  assert.equal(calls.length, 0, 'nobody is due at 2:30');
  await assert.rejects(() => snow.start({ day: '2026-12-03', time: '04:00' }), /already running/);

  at('2026-12-03T08:00:00Z'); // 3:00 AM: Bob
  await snow.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, '+17055550301');
  assert.match(calls[0].url, /^https:\/\/dispatch\.example\/voice\/snow\/[\w-]+$/);
  assert.match(texts[0].body, /^ADAMS BROS SNOW CALL: start 4 AM at the yard\. Bring your own shovel\. Reply 1/);
  const token = calls[0].url.split('/').pop();
  const twiml = await snow.voiceTwiml(token);
  assert.match(twiml, /<Gather numDigits="1"[^>]*action="\/voice\/snow\/[\w-]+\/answer"/);
  assert.match(twiml, /Adams Bros snow call\. Start at 4 AM\. Report to the yard\. Bring your own shovel\. Press 1 if you are coming/);
  assert.match(await snow.voiceAnswer(token, '1'), /Thank you\. See you there\. Start at 4 AM\. Report to the yard\./);
  await snow.voiceStatus(token, 'completed'); // after pressing 1: stays "coming"

  at('2026-12-03T08:30:00Z'); // 3:30 AM: Sue, who texts back instead of answering
  await snow.tick();
  assert.equal(calls.length, 2);
  const reply = await snow.handleReply('+17055550302', 'no sorry sick');
  assert.match(reply.reply, /office has been told/);
  const done = await snow.get(c.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.people.map((p) => [p.name, p.status, p.via]), [['Bob Smith', 'coming', 'call'], ['Sue Lee', 'not_coming', 'text']]);
  assert.equal(texts.at(-1).to, '+17055550100');
  assert.equal(texts.at(-1).body, "ADAMS BROS SNOW CALL 4 AM: 1 coming (Bob Smith). Can't: Sue Lee.");
  assert.equal(await snow.handleReply('+17055550302', '1'), null, 'no call-out running: not a snow reply');
});

test('snow call: no answer is called again 5 minutes later, 3 calls at most; everyone-now mode; cancel', async (t) => {
  const { snow, calls, texts, at } = await setup(t);
  const c = await snow.start({ day: '2026-12-03', time: '04:00', mode: 'now', notify: ['705-555-0100'] });
  assert.equal(calls.length, 2, 'everyone at once');
  const bobToken = calls.find((x) => x.to === '+17055550301').url.split('/').pop();
  const sueToken = calls.find((x) => x.to === '+17055550302').url.split('/').pop();
  await snow.voiceAnswer(sueToken, '1');
  for (let i = 0; i < 3; i++) {
    await snow.voiceStatus(bobToken, 'no-answer');
    at(new Date(Date.parse('2026-12-03T07:30:00Z') + (i + 1) * 5 * 60e3 + 1000).toISOString());
    await snow.tick();
  }
  const after = await snow.get(c.id);
  const bob = after.people.find((p) => p.name === 'Bob Smith');
  assert.equal(bob.attempts, 3);
  assert.equal(bob.status, 'no_answer');
  assert.equal(after.status, 'done');
  assert.match(texts.at(-1).body, /1 coming \(Sue Lee\)\. No answer: Bob Smith\./);

  const c2 = await snow.start({ day: '2026-12-04', time: '05:00' });
  const cancelled = await snow.cancel(c2.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.people.every((p) => p.status === 'cancelled'));
});

test('snow call in test mode: nothing is phoned; answers can be marked on the screen', async (t) => {
  const { snow, calls } = await setup(t, { live: false });
  const c = await snow.start({ day: '2026-12-03', time: '04:00', mode: 'now' });
  assert.equal(calls.length, 0);
  const bob = c.people.find((p) => p.name === 'Bob Smith');
  const after = await snow.act(bob.id, 'coming');
  assert.equal(after.people.find((p) => p.id === bob.id).status, 'coming');
});

test('the overnight snow dispatcher login: the Snow call and nothing else', async (t) => {
  const db = await testDb(t);
  const { createUser } = require('../src/auth');
  const { createDispatch } = require('../src/dispatch');
  const { createApp } = require('../src/server');
  await createUser(db, { email: 'night@test.ca', name: 'Night', password: 'password123', role: 'snow' });
  const server = createApp({ db, dispatch: createDispatch(db) }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'night@test.ca', password: 'password123' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const api = async (path, body) => {
    const r = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const me = (await api('/me')).data;
  assert.equal(me.can.snow_only, true);
  assert.equal(me.can.snow, true);
  assert.equal(me.can.dispatch, false);
  for (const path of ['/board', '/jobs?from=2026-01-01&to=2026-12-31', '/customers', '/prices', '/settings', '/sites/board']) {
    assert.equal((await api(path)).status, 403, path);
  }
  assert.equal((await api('/snow/shovelers', { name: 'Bob', phone: '705-555-0301', call_ahead_min: 60 })).status, 200);
  assert.equal((await api('/snow')).status, 200);
  assert.equal((await api('/snow')).data.shovelers.length, 1);
});

test('ElevenLabs voice: the usual lines are recorded once and kept; calls then need no key', async (t) => {
  const db = await testDb(t);
  const { createVoice } = require('../src/voice');
  const spoken = [];
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.headers['xi-api-key'], 'k');
    if (url.endsWith('/voices')) return { ok: true, json: async () => ({ voices: [{ voice_id: 'v2', name: 'Zoe', labels: { accent: 'canadian' } }, { voice_id: 'v1', name: 'Adam', preview_url: 'https://x/p.mp3' }] }) };
    spoken.push(JSON.parse(opts.body).text);
    return { ok: true, arrayBuffer: async () => Buffer.from('MP3:' + JSON.parse(opts.body).text) };
  };
  const voice = createVoice(db, { key: 'k', fetchImpl });
  assert.deepEqual((await voice.voices()).map((v) => v.name), ['Adam', 'Zoe']);
  await assert.rejects(() => voice.recordUsual(['the yard']), /Pick a voice/);
  await voice.choose('v1', 'Adam');
  const made = await voice.recordUsual(['the yard']);
  assert.equal(made.made, made.usual);
  assert.equal(made.recorded, made.usual);
  assert.ok(spoken.includes('Start at 4:30 AM.') && spoken.includes('Report to the yard.'));
  const once = spoken.length;
  assert.equal((await voice.recordUsual(['the yard'])).made, 0, 'already kept: nothing recorded again');
  assert.equal(spoken.length, once);

  // No key from here on: the kept recordings are played.
  const noKey = createVoice(db, { key: '', fetchImpl: async () => { throw new Error('should not call ElevenLabs'); } });
  let clock = new Date('2026-12-03T07:30:00Z');
  const snow = createSnow(db, { send: async () => {}, now: () => clock, timeZone: TZ, publicUrl: 'https://dispatch.example', live: false, voice: noKey });
  await snow.saveShoveler({ name: 'Bob', phone: '705-555-0301', call_ahead_min: 60 });
  const c = await snow.start({ day: '2026-12-03', time: '04:00', place: 'the yard', note: 'Bring a scraper' });
  const row = await db.get('SELECT token FROM snow_call_people WHERE call_id = ?', c.id);
  const twiml = await snow.voiceTwiml(row.token);
  const plays = [...twiml.matchAll(/<Play>https:\/\/dispatch\.example\/voice\/clip\/([\w-]+)\.mp3<\/Play>/g)].map((m) => m[1]);
  assert.ok(plays.length >= 8, twiml); // greeting, time, place, press — twice
  assert.equal((await snow.audio(plays[0])).toString(), 'MP3:Adams Bros snow call.');
  // The one-off note was never recorded and there's no key: just that part in the standard voice.
  assert.match(twiml, /<Say voice="Polly\.Joanna-Neural">Bring a scraper\.<\/Say>/);
  assert.doesNotMatch(await snow.voiceAnswer(row.token, '1'), /<Say/);
  assert.equal(await snow.audio('nope'), null);
  await snow.cancel(c.id);

  // With the key, a new place or note is recorded the first time and kept.
  const withKey = createSnow(db, { send: async () => {}, now: () => clock, timeZone: TZ, publicUrl: 'https://dispatch.example', live: false, voice });
  const c2 = await withKey.start({ day: '2026-12-03', time: '04:00', place: 'the Bowes St lot' });
  assert.ok(spoken.includes('Report to the Bowes St lot.'));
  assert.equal((await db.get('SELECT voice FROM snow_calls WHERE id = ?', c2.id)).voice, 'Adam');
  await withKey.cancel(c2.id);

  // ElevenLabs down: the call-out still starts; the missing part is spoken.
  const down = createSnow(db, { send: async () => {}, now: () => clock, timeZone: TZ, live: false,
    voice: { chosen: async () => ({ voice_id: 'v1' }), ensure: async () => { throw new Error('502'); }, clip: async () => null } });
  const c3 = await down.start({ day: '2026-12-03', time: '04:00' });
  const tok = (await db.get('SELECT token FROM snow_call_people WHERE call_id = ?', c3.id)).token;
  assert.match(await down.voiceTwiml(tok), /<Say voice="Polly\.Joanna-Neural">Adams Bros snow call\. Start at 4 AM/);
});

test('snow call: only the ticked shovelers; results stay on screen after; setup text and contact card', async (t) => {
  const { snow, texts, bob } = await setup(t, { live: false });
  await assert.rejects(() => snow.start({ day: '2026-12-03', time: '04:00', shovelers: [] }), /Tick at least one/);
  const c = await snow.start({ day: '2026-12-03', time: '04:00', mode: 'now', shovelers: [bob.id] });
  assert.deepEqual(c.people.map((p) => p.name), ['Bob Smith']);
  await snow.act(c.people[0].id, 'coming');
  assert.equal(await snow.current(), null, 'finished');
  const last = await snow.last();
  assert.equal(last.id, c.id);
  assert.deepEqual(last.people.map((p) => [p.name, p.status]), [['Bob Smith', 'coming']]);
  // "Clear the board": the results come off the screen; a running call-out can't be cleared.
  await snow.clear(c.id);
  assert.equal(await snow.last(), null);
  const c2 = await snow.start({ day: '2026-12-03', time: '04:00', shovelers: [bob.id] });
  await assert.rejects(() => snow.clear(c2.id), /still running/);
  await snow.cancel(c2.id);
  assert.equal((await snow.last()).id, c2.id, 'the next call-out shows again');
  const out = await snow.sendSetupText();
  assert.equal(out.results.length, 2);
  assert.match(texts.at(-1).body, /snow call-outs will phone you from 705-555-0000\. .*\/snow\/contact\.vcf .*Favourite/);
  const card = snow.contactCard();
  assert.match(card, /^BEGIN:VCARD\r\nVERSION:3\.0\r\nFN:Adams Bros Snow Call\r\n/);
  assert.match(card, /TEL;TYPE=WORK,VOICE:\+17055550000/);
});
