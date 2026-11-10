// Small Twilio helpers for setup: check the account and number, and point the number's
// incoming-text webhook at this app. Sending texts lives in sms.js.
const config = require('./config');

const API = 'https://api.twilio.com/2010-04-01';

async function twilioRequest(path, { method = 'GET', form } = {}) {
  const { accountSid, authToken } = config.twilio;
  const res = await fetch(`${API}/Accounts/${accountSid}${path}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Twilio error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function webhookUrl() {
  return `${config.publicUrl}/sms/inbound`;
}

/**
 * Everything worth knowing before going live. Never throws: problems come back as `problems`.
 */
async function checkSetup() {
  const { accountSid, authToken, fromNumber } = config.twilio;
  const out = { configured: config.smsEnabled, webhook: webhookUrl(), problems: [], warnings: [] };
  if (!accountSid || !authToken) {
    out.problems.push('Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (and TWILIO_FROM_NUMBER) to .env, then restart.');
    return out;
  }
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) out.problems.push('TWILIO_ACCOUNT_SID should start with "AC" (copy it from the Twilio console home page).');
  if (fromNumber && !/^\+1\d{10}$/.test(fromNumber)) out.problems.push('TWILIO_FROM_NUMBER should look like +17055551234.');
  if (/localhost|127\.0\.0\.1/.test(config.publicUrl)) {
    out.warnings.push('PUBLIC_URL is localhost. Texts will send, but driver replies (OK / DONE / photos) and job links only work once the app is online at a public address.');
  } else if (!config.publicUrl.startsWith('https://')) {
    out.warnings.push('PUBLIC_URL should start with https:// so Twilio and drivers\' phones can reach it securely.');
  }

  try {
    const account = await twilioRequest('.json');
    out.account = { name: account.friendly_name, status: account.status, type: account.type };
    if (account.type === 'Trial') {
      out.warnings.push('This is a Twilio TRIAL account: it can only text numbers you have verified in the console, and adds a trial message to every text. Upgrade (add a payment method) before using it with drivers.');
    }
    if (account.status !== 'active') out.problems.push(`Twilio account status is "${account.status}".`);
  } catch (err) {
    out.problems.push(err.status === 401
      ? 'Twilio rejected the Account SID / Auth Token. Copy both again from the console home page.'
      : `Couldn't reach Twilio: ${err.message}`);
    return out;
  }

  if (!fromNumber) {
    // Logged in fine but no number chosen yet: list what the account has.
    try {
      const all = await twilioRequest('/IncomingPhoneNumbers.json?PageSize=20');
      out.availableNumbers = (all.incoming_phone_numbers || []).map((n) => ({
        phone: n.phone_number, sms: Boolean(n.capabilities?.sms), mms: Boolean(n.capabilities?.mms),
      }));
    } catch (err) {
      out.availableNumbers = [];
    }
    out.problems.push(out.availableNumbers.length
      ? `Set TWILIO_FROM_NUMBER to one of this account's numbers: ${out.availableNumbers.map((n) => n.phone).join(', ')}.`
      : 'This account has no phone number yet. In the Twilio console, get a number (trial accounts can claim one free), then set TWILIO_FROM_NUMBER.');
    return out;
  }

  try {
    const list = await twilioRequest(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(fromNumber)}`);
    const num = (list.incoming_phone_numbers || [])[0];
    if (!num) {
      out.problems.push(`${fromNumber} isn't a number on this Twilio account. Check TWILIO_FROM_NUMBER.`);
      return out;
    }
    out.number = {
      sid: num.sid,
      phone: num.phone_number,
      sms: Boolean(num.capabilities?.sms),
      mms: Boolean(num.capabilities?.mms),
      smsUrl: num.sms_url || '',
      smsMethod: num.sms_method || '',
    };
    if (!out.number.sms) out.problems.push('This number can\'t send texts (no SMS capability). Buy an SMS-capable number.');
    if (!out.number.mms) out.warnings.push('This number has no MMS: drivers can\'t text ticket photos to it (the job page upload still works).');
    if (out.number.smsUrl !== out.webhook || out.number.smsMethod !== 'POST') {
      out.warnings.push(`Incoming texts aren't pointed at this app yet (currently: ${out.number.smsUrl || 'not set'}). Use "Connect number" to set it to ${out.webhook}.`);
    }
  } catch (err) {
    out.problems.push(`Couldn't look up the phone number: ${err.message}`);
  }
  return out;
}

/** Point the number's "A message comes in" webhook at /sms/inbound. */
async function connectWebhook() {
  const status = await checkSetup();
  if (!status.number) throw new Error(status.problems[0] || 'Phone number not found');
  await twilioRequest(`/IncomingPhoneNumbers/${status.number.sid}.json`, {
    method: 'POST',
    form: { SmsUrl: status.webhook, SmsMethod: 'POST' },
  });
  return checkSetup();
}

module.exports = { checkSetup, connectWebhook, webhookUrl };
