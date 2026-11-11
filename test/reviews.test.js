const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');

const LINK = 'https://g.page/r/abc123/review';
const at = (iso) => new Date(iso); // 2026-11-12 is EST (UTC-5): 15:00Z = 10:00 local

async function setup(t) {
  const db = await testDb(t);
  const sent = [];
  const d = createDispatch(db, { send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; }, today: () => '2026-11-12' });
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const job = async (over = {}) => {
    const { job: j } = await d.saveJob({ job_type: 'septic', scheduled_date: '2026-11-12', customer: 'Jane Cottager', customer_phone: '705-555-0199',
      to_location: '12 Lake Rd', assignments: [{ driver_id: dave.id }], ...over });
    await d.driverAction(j.assignments[0].token, 'done');
    // Finished at 8:00 local.
    await db.run("UPDATE jobs SET completed_at = '2026-11-12 13:00:00' WHERE id = ?", j.id);
    return j;
  };
  return { db, d, sent, job };
}

test('review texts: off until switched on with a link; then sent once, an hour after the job, in daytime', async (t) => {
  const { db, d, sent, job } = await setup(t);
  const j = await job();
  assert.equal(await d.runReviewRequests(at('2026-11-12T15:00:00Z')), null, 'off by default');

  await assert.rejects(d.saveSettings({ reviews: { on: true, link: '' } }), /review link/);
  await assert.rejects(d.saveSettings({ reviews: { on: true, link: LINK, message: 'no link here' } }), /\{link\}/);
  await d.saveSettings({ reviews: { on: true, link: LINK, types: ['septic', 'bin'] } });
  // Switched on after the job finished: only jobs finished from now on are asked.
  await db.run("UPDATE settings SET value = '2026-11-12 12:00:00' WHERE key = 'review_since'");

  assert.deepEqual(await d.runReviewRequests(at('2026-11-12T13:30:00Z')), null, 'before 9 a.m. local: nothing');
  await d.runReviewRequests(at('2026-11-12T15:00:00Z'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+17055550199');
  assert.match(sent[0].body, /^Hi Jane, thanks for choosing Adams Bros!/);
  assert.ok(sent[0].body.endsWith(LINK));
  const after = await d.getJob(j.id);
  assert.equal(after.review_status, 'sent');
  assert.ok((await d.historyFor(j.id)).some((h) => /Review request texted/.test(h.action)));

  await d.runReviewRequests(at('2026-11-12T16:00:00Z'));
  assert.equal(sent.length, 1, 'never twice for the same job');
});

test('review texts skip: too soon, opted out, wrong type, same phone within a year, and company names get "there"', async (t) => {
  const { db, d, sent, job } = await setup(t);
  await d.saveSettings({ reviews: { on: true, link: LINK, types: ['septic'] } });
  await db.run("UPDATE settings SET value = '2026-01-01 00:00:00' WHERE key = 'review_since'");

  const optedOut = await job({ no_review: 'on' });
  const bin = await job({ job_type: 'bin', customer_phone: '705-555-0300' });
  const company = await job({ customer: 'Bayview Excavating Ltd', customer_phone: '705-555-0400' });
  const repeat = await job({ customer_phone: '705-555-0400' });
  const soon = await job({ customer_phone: '705-555-0500' });
  await db.run("UPDATE jobs SET completed_at = '2026-11-12 14:30:00' WHERE id = ?", soon.id); // finished 30 min before

  await d.runReviewRequests(at('2026-11-12T15:00:00Z'));
  assert.deepEqual(sent.map((s) => s.to), ['+17055550400']);
  assert.match(sent[0].body, /^Hi there,/);
  assert.equal((await d.getJob(optedOut.id)).review_status, '');
  assert.equal((await d.getJob(bin.id)).review_status, 'skipped');
  assert.equal((await d.getJob(company.id)).review_status, 'sent');
  assert.equal((await d.getJob(repeat.id)).review_status, 'skipped');
  assert.equal((await d.getJob(soon.id)).review_status, '', 'waits until an hour has passed');
  await d.runReviewRequests(at('2026-11-12T16:00:00Z'));
  assert.deepEqual(sent.map((s) => s.to), ['+17055550400', '+17055550500']);
});
