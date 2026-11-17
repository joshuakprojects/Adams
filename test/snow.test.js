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
  assert.match(twiml, /Adams Bros snow call\. Start at 4 AM at the yard\. Bring your own shovel\. Press 1 if you are coming/);
  assert.match(await snow.voiceAnswer(token, '1'), /See you at 4 AM at the yard/);
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
