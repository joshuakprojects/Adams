// Texting through Sunwire (SolSwitch) instead of Twilio, from the office number.
// API: https://docs.solswitch.ca/apis-sms — JSON over HTTPS.
//   Send a text:   POST SUNWIRE_SMS_URL  { From, To, Body, Key }      → { Status: 'OK', ID } | { Status: 'FAIL', Reason }
//   Send a photo:  POST SUNWIRE_MMS_URL  { From, To, ContentName, ContentType, Content (base64), Key }
//   Incoming:      Sunwire POSTs { Type: 'Message' | 'Report', ID, From, To, Body, Key? } to <PUBLIC_URL>/sms/sunwire
//                  and expects { Status: 'OK' }. A photo arrives as a link in Body ("MMS received (link will expire in 7 days): https://…").
// Sunwire only accepts sends from IP addresses given to it in advance: on hosting without a fixed IP, set OUTBOUND_PROXY_URL.
const crypto = require('node:crypto');
const config = require('./config');
const { request } = require('./httpOut');

const MAX_PHOTO = 13 * 1024 * 1024;

/** Sunwire wants plain digits: 11-digit North American numbers (17055551234). */
function digits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length === 10 ? '1' + d : d;
}

function createSunwire({ cfg = config.sunwire, proxy = config.outboundProxy, requestImpl = request } = {}) {
  async function post(url, payload) {
    const res = await requestImpl(url, {
      method: 'POST', proxy,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(cfg.key ? { ...payload, Key: cfg.key } : payload),
    });
    const out = res.json();
    if (String(out.Status || '').toUpperCase() !== 'OK') {
      const why = out.Reason || (res.ok ? 'no reason given' : `HTTP ${res.status}`);
      throw new Error(`Sunwire refused the text: ${why}${/ip/i.test(why) ? ' (is the fixed IP / OUTBOUND_PROXY_URL set up and allowed by Sunwire?)' : ''}`);
    }
    return { sid: String(out.ID || '') };
  }

  return {
    name: 'sunwire',
    configured: () => Boolean(cfg.smsUrl && cfg.fromNumber),
    sendSms: (to, body) => post(cfg.smsUrl, { From: digits(cfg.fromNumber), To: digits(to), Body: body }),
    sendMms: (to, { buffer, contentType, name = 'photo.jpg' }) => {
      if (!cfg.mmsUrl) throw new Error('SUNWIRE_MMS_URL is not set');
      return post(cfg.mmsUrl, { From: digits(cfg.fromNumber), To: digits(to), ContentName: name, ContentType: contentType, Content: buffer.toString('base64') });
    },

    /** Is this incoming request really from Sunwire? (The key, in the body or as a header.) */
    verify(req) {
      if (!cfg.inboundKey) return false;
      const given = String(req.body?.Key || req.get('x-api-key') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
      const a = Buffer.from(given);
      const b = Buffer.from(cfg.inboundKey);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    /** A photo link in an incoming message: { text, links }. */
    parseBody(body) {
      const text = String(body || '');
      const m = /^\s*MMS received[^:]*:\s*/i.exec(text);
      if (!m) return { text, links: [] };
      const rest = text.slice(m[0].length);
      const links = [...rest.matchAll(/https:\/\/[^\s]+/g)].map((x) => x[0]);
      return { text: rest.replace(/https:\/\/[^\s]+/g, '').trim(), links };
    },

    /** Download a photo from a Sunwire link (only Sunwire's own https links). */
    async fetchPhoto(link) {
      const u = new URL(link);
      if (u.protocol !== 'https:' || !(u.hostname === 'sunwire.ca' || u.hostname.endsWith('.sunwire.ca'))) throw new Error('Unexpected photo link');
      const res = await requestImpl(u.toString(), { method: 'GET', proxy });
      if (!res.ok) throw new Error(`Photo download failed (HTTP ${res.status})`);
      if (res.buffer.length > MAX_PHOTO) throw new Error('Photo too large');
      const contentType = String(u.searchParams.get('contenttype') || res.headers['content-type'] || '').split(';')[0].trim();
      return { buffer: res.buffer, contentType };
    },

    status() {
      const problems = [];
      if (!cfg.smsUrl) problems.push('SUNWIRE_SMS_URL is not set (Sunwire gives you this address).');
      if (!cfg.fromNumber) problems.push('SUNWIRE_FROM_NUMBER is not set (the office number, e.g. 7057462962).');
      if (!cfg.inboundKey) problems.push('SUNWIRE_INBOUND_KEY is not set: incoming texts are refused until it is (ask Sunwire to send it as the Key).');
      const warnings = [];
      if (!proxy) warnings.push('No OUTBOUND_PROXY_URL: sending only works if this server\'s IP address is on Sunwire\'s allow list.');
      if (!cfg.mmsUrl) warnings.push('SUNWIRE_MMS_URL is not set: the app can receive photos but not send them (it doesn\'t need to today).');
      return {
        provider: 'sunwire', configured: !problems.length, webhook: `${config.publicUrl}/sms/sunwire`, problems, warnings,
        lines: [
          `Texting through Sunwire from ${cfg.fromNumber || '(no number set)'}`,
          proxy ? `Sends go through the fixed-IP relay ${new URL(proxy).hostname}` : 'Sends go straight from this server (no relay)',
        ],
      };
    },
  };
}

/** Make the outgoing text safe for plain SMS: one fancy character makes every segment hold 70 characters instead of 160. */
function plainText(s) {
  return String(s || '')
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/×/g, 'x').replace(/[·•]/g, '-')
    .replace(/ /g, ' ').replace(/[✓✔✅]/g, 'OK');
}

module.exports = { createSunwire, digits, plainText };
