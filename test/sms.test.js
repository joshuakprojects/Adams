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
    id: 1042, job_type: 'haul', scheduled_date: '2026-11-10', scheduled_time: '07:00', material: '2" minus',
    quantity: '', unit: '', loads_planned: 20, from_location: 'Pit', to_location: '1388 Lake Rd', municipality: 'Ahmic Harbour',
    customer: 'Smith', customer_phone: '+17055550100', contact_name: 'Mike', contact_phone: '+14035551234', notes: 'Back of lot', details: '{}',
  };
  const text = sms.buildJobText(job, { token: 'abc', truck_unit: 'T1' });
  assert.match(text, /^ADAMS BROS - Aggregate Work Order #1042/);
  assert.match(text, /Tue Nov 10 @ 7:00 AM/);
  assert.match(text, /Truck: T1/);
  assert.match(text, /Aggregate type: 2" minus - 20 loads/);
  assert.match(text, /From \(pit \/ yard\): Pit/);
  assert.match(text, /Delivery address: 1388 Lake Rd, Ahmic Harbour/);
  assert.match(text, /Customer: Smith 705-555-0100/);
  assert.match(text, /Site contact: Mike 403-555-1234/);
  assert.doesNotMatch(text, /COLLECT/);
  assert.match(text, /Reply OK to confirm/);
  assert.match(text, /\/j\/abc$/);
});

test('job text per form type', () => {
  const base = { id: 7, scheduled_date: '2026-11-10', scheduled_time: '', to_location: '12 Bay St', municipality: 'McDougall' };
  const septic = sms.buildJobText({ ...base, job_type: 'septic', collect_payment: 1, quoted_price: '$350', payment_method: 'Cash',
    details: { tank_type: 'Holding', tank_size: '1000 gal', hose_length: '150 ft', lids_uncovered: 'No', steep_driveway: 'Yes', tank_location: 'Under the deck' } }, { token: 'x' });
  assert.match(septic, /Septic Pump-out #7/);
  assert.match(septic, /Job: Pump-out - holding tank - 1000 gal/);
  assert.match(septic, /Property address: 12 Bay St, McDougall/);
  assert.match(septic, /Hose length: 150 ft/);
  assert.match(septic, /Lids uncovered: No/);
  assert.match(septic, /Steep driveway: Yes/);
  assert.match(septic, /Tank location: Under the deck/);
  assert.match(septic, /COLLECT PAYMENT: \$350 - Cash/);

  const bin = sms.buildJobText({ ...base, job_type: 'bin', material: '20 yd', details: { service: 'Empty & return' } }, { token: 'x' });
  assert.match(bin, /Bin Work Order #7/);
  assert.match(bin, /Bin size: Empty & return - 20 yd/);

  const toilet = sms.buildJobText({ ...base, job_type: 'toilet', details: { trip: 'Deliver', pickup_date: '2026-11-20',
    toilet1_type: 'Standard', toilet1_qty: '2', toilet2_type: 'Wheelchair accessible', toilet2_qty: '1', placement: 'Beside the garage' } }, { token: 'x' });
  assert.match(toilet, /Portable Toilet Rental #7/);
  assert.match(toilet, /Job: Deliver - 2× Standard, 1× Wheelchair accessible/);
  assert.match(toilet, /Directions of where to place toilet: Beside the garage/);
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
