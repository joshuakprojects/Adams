// Twilio setup helper.
//   npm run twilio                      check credentials, the number, and where incoming texts go
//   npm run twilio -- connect           point the number's incoming texts at PUBLIC_URL/sms/inbound
//   npm run twilio -- test 705-555-1234 send a test text to that phone
const config = require('../src/config');
const { checkSetup, connectWebhook } = require('../src/twilio');
const sms = require('../src/sms');

function print(s) {
  console.log('');
  if (s.account) console.log(`Account:  ${s.account.name} (${s.account.type}, ${s.account.status})`);
  if (s.number) {
    console.log(`Number:   ${sms.prettyPhone(s.number.phone)}  SMS ${s.number.sms ? '✔' : '✖'}  MMS ${s.number.mms ? '✔' : '✖'}`);
    console.log(`Incoming: ${s.number.smsUrl || '(not set)'} ${s.number.smsMethod ? `[${s.number.smsMethod}]` : ''}`);
  }
  console.log(`App URL:  ${s.webhook}`);
  for (const p of s.problems) console.log(`✖ ${p}`);
  for (const w of s.warnings) console.log(`! ${w}`);
  if (!s.problems.length && !s.warnings.length) console.log('✔ Texting is ready.');
  console.log('');
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'connect') {
    print(await connectWebhook());
  } else if (cmd === 'test') {
    const to = sms.normalizePhone(arg);
    if (!to) throw new Error('Give a phone number: npm run twilio -- test 705-555-1234');
    if (!config.smsEnabled) throw new Error('Twilio is not set up in .env yet.');
    const r = await sms.sendSms(to, `${config.companyName} dispatch: test text. Reply OK to check replies reach the office.`);
    console.log(`Sent to ${sms.prettyPhone(to)} (${r.sid}). Reply from that phone and watch the Texts tab.`);
  } else {
    print(await checkSetup());
  }
})().catch((err) => {
  console.error('✖', err.message);
  process.exit(1);
});
