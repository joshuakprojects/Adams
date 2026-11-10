const test = require('node:test');
const assert = require('node:assert/strict');

// Settings must be in place before config is loaded.
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = 'secret';
process.env.TWILIO_FROM_NUMBER = '+17055550000';
process.env.PUBLIC_URL = 'https://dispatch.example.ca';
const { checkSetup, connectWebhook } = require('../src/twilio');

function fakeTwilio({ type = 'Full', smsUrl = '', mms = true } = {}) {
  const calls = [];
  const number = { sid: 'PN1', phone_number: '+17055550000', capabilities: { sms: true, mms }, sms_url: smsUrl, sms_method: 'POST' };
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? String(opts.body) : '' });
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (String(url).endsWith(`/Accounts/${process.env.TWILIO_ACCOUNT_SID}.json`)) {
      return json({ friendly_name: 'Adams Bros', status: 'active', type });
    }
    if (String(url).includes('/IncomingPhoneNumbers.json')) return json({ incoming_phone_numbers: [number] });
    if (String(url).includes('/IncomingPhoneNumbers/PN1.json')) {
      number.sms_url = new URLSearchParams(String(opts.body)).get('SmsUrl');
      return json(number);
    }
    return json({ message: 'not found' }, 404);
  };
  return calls;
}

test('check flags a trial account and an unconnected number, connect fixes the webhook', async () => {
  const calls = fakeTwilio({ type: 'Trial', mms: false });
  let s = await checkSetup();
  assert.deepEqual(s.problems, []);
  assert.equal(s.webhook, 'https://dispatch.example.ca/sms/inbound');
  assert.ok(s.warnings.some((w) => /TRIAL/.test(w)));
  assert.ok(s.warnings.some((w) => /no MMS/.test(w)));
  assert.ok(s.warnings.some((w) => /aren't pointed at this app/.test(w)));

  s = await connectWebhook();
  const update = calls.find((c) => c.method === 'POST');
  assert.match(update.body, /SmsUrl=https%3A%2F%2Fdispatch\.example\.ca%2Fsms%2Finbound/);
  assert.match(update.body, /SmsMethod=POST/);
  assert.ok(!s.warnings.some((w) => /aren't pointed/.test(w)));
});

test('a fully set up account is ready', async () => {
  fakeTwilio({ smsUrl: 'https://dispatch.example.ca/sms/inbound' });
  const s = await checkSetup();
  assert.deepEqual(s.problems, []);
  assert.deepEqual(s.warnings, []);
});

test('bad credentials are explained', async () => {
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Authenticate' }) });
  const s = await checkSetup();
  assert.match(s.problems[0], /rejected the Account SID/);
});
