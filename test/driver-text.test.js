const test = require('node:test');
const assert = require('node:assert/strict');
const FORMS = require('../public/forms');
const sms = require('../src/sms');

test("driver text: the town is added unless the address already ends with it; dates read like a person writes them", () => {
  const text = (job) => sms.buildJobText({ id: 1, job_type: 'toilet', scheduled_date: '2026-11-21', ...job }, { token: 't' });
  assert.match(text({ to_location: '88 Seguin Trail', municipality: 'Seguin' }), /Delivery address: 88 Seguin Trail, Seguin\n/);
  assert.match(text({ to_location: '45 Bay Rd, McDougall', municipality: 'McDougall' }), /Delivery address: 45 Bay Rd, McDougall\n/);
  assert.deepEqual(FORMS.smsLines({ job_type: 'toilet', details: JSON.stringify({ pickup_date: '2026-12-15' }) }), [['Expected pick-up date', 'Tue, Dec 15']]);
});
