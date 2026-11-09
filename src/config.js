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
  timeZone: env.TZ_NAME || 'America/Toronto',
  // Where scale ticket photos are stored.
  uploadDir: env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
  // Default time to text drivers tomorrow's jobs (HH:MM, blank = off). Can be changed on the Setup tab.
  lineupTime: env.LINEUP_TIME ?? '17:00',
  companyName: env.COMPANY_NAME || 'ADAMS BROS',
  // Printed on work orders, as on the paper forms.
  company: {
    legalName: env.COMPANY_LEGAL_NAME || 'Adams Bros. Construction Ltd.',
    address: env.COMPANY_ADDRESS || '116 William St., P.O. Box 324, Parry Sound, ON  P2A 2X4',
    phone: env.COMPANY_PHONE || '(705) 746-2962',
    email: env.COMPANY_EMAIL || 'info@adamsbros.ca',
    website: env.COMPANY_WEBSITE || 'www.adamsbros.ca',
    hst: env.COMPANY_HST || 'R100046929',
  },
  dispatchPhone: env.DISPATCH_PHONE || '+17057462962',
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
  // Shared secret the website sends with each order (Authorization: Bearer <key>). Blank = intake off.
  intakeKey: env.INTAKE_KEY || '',
};

module.exports.smsEnabled = Boolean(
  module.exports.twilio.accountSid && module.exports.twilio.authToken && module.exports.twilio.fromNumber
);
