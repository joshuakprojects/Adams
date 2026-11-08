const test = require('node:test');
const assert = require('node:assert/strict');
const sms = require('../src/sms');

test('normalizePhone handles common formats', () => {
  assert.equal(sms.normalizePhone('403-555-1234'), '+14035551234');
  assert.equal(sms.normalizePhone('(403) 555 1234'), '+14035551234');
  assert.equal(sms.normalizePhone('1 403 555 1234'), '+14035551234');
  assert.equal(sms.normalizePhone('+14035551234'), '+14035551234');
  assert.equal(sms.normalizePhone('555-1234'), '');
});

test('parseReply understands acknowledgements', () => {
  for (const t of ['OK', 'ok', 'Ok thanks', 'Okay', 'k', 'Y', 'yes', 'Yep!', '10-4', 'Got it', 'got er', '👍', 'Sounds good', 'will do', 'Roger that', ' ok ']) {
    assert.equal(sms.parseReply(t).action, 'ack', t);
  }
});

test('parseReply understands done, with or without a job number', () => {
  assert.deepEqual(sms.parseReply('DONE'), { action: 'done', jobId: null });
  assert.deepEqual(sms.parseReply('done 1042'), { action: 'done', jobId: 1042 });
  assert.deepEqual(sms.parseReply('Done #1043'), { action: 'done', jobId: 1043 });
  assert.equal(sms.parseReply('All done').action, 'done');
  assert.equal(sms.parseReply('finished').action, 'done');
  assert.deepEqual(sms.parseReply('ok 1050'), { action: 'ack', jobId: 1050 });
  assert.deepEqual(sms.parseReply('10-4'), { action: 'ack', jobId: null });
});

test('parseReply leaves other messages for the office', () => {
  for (const t of ['not ok', 'running 20 min late', "can't make it", 'Got a flat', 'on my way', 'All good?', 'will be late', '']) {
    assert.equal(sms.parseReply(t).action, null, t);
  }
});

test('job text has the details a driver needs', () => {
  const job = {
    id: 1042, job_type: 'haul', scheduled_date: '2026-11-10', scheduled_time: '07:00', material: '3/4" clear',
    quantity: '200', unit: 'tonnes', loads_planned: 12, from_location: 'Pit', to_location: '45 Oak St',
    customer: 'Northland', contact_name: 'Mike', contact_phone: '+14035551234', notes: 'Back of lot',
  };
  const text = sms.buildJobText(job, { token: 'abc', truck_unit: 'T1' });
  assert.match(text, /Job #1042/);
  assert.match(text, /Tue Nov 10 @ 7:00 AM/);
  assert.match(text, /Truck: T1/);
  assert.match(text, /Haul: 3\/4" clear - 200 tonnes - 12 loads/);
  assert.match(text, /From: Pit/);
  assert.match(text, /To: 45 Oak St/);
  assert.match(text, /Site contact: Mike 403-555-1234/);
  assert.match(text, /Reply OK to confirm/);
  assert.match(text, /\/j\/abc$/);

  const septic = sms.buildJobText({ ...job, job_type: 'septic', material: 'Tank', loads_planned: null }, { token: 'x' });
  assert.match(septic, /Pump-out: Tank/);
  assert.match(septic, /Pump at: Pit/);
  assert.match(septic, /Dump at: 45 Oak St/);
});

test('Twilio signature check', () => {
  const crypto = require('node:crypto');
  const url = 'https://dispatch.example.com/sms/inbound';
  const params = { From: '+14035550101', Body: 'OK', To: '+15875550000' };
  const data = url + 'BodyOK' + 'From+14035550101' + 'To+15875550000';
  const sig = crypto.createHmac('sha1', 'secret').update(data).digest('base64');
  assert.equal(sms.validTwilioSignature(sig, url, params, 'secret'), true);
  assert.equal(sms.validTwilioSignature(sig, url, { ...params, Body: 'DONE' }, 'secret'), false);
  assert.equal(sms.validTwilioSignature('', url, params, 'secret'), false);
});
