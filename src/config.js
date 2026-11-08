const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

module.exports = {
  port: Number(env.PORT || 3000),
  // Public URL of this app, used for links in texts and Twilio signature checks.
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'dispatch.db'),
  timeZone: env.TZ_NAME || 'America/Edmonton',
  companyName: env.COMPANY_NAME || 'ADAMS BROS',
  dispatchPhone: env.DISPATCH_PHONE || '',
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    fromNumber: env.TWILIO_FROM_NUMBER || '',
  },
  admin: {
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
  },
  cookieSecure: env.COOKIE_SECURE === 'true',
};

module.exports.smsEnabled = Boolean(
  module.exports.twilio.accountSid && module.exports.twilio.authToken && module.exports.twilio.fromNumber
);
