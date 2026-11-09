const crypto = require('node:crypto');
const config = require('./config');

/** Normalize a North American phone number to E.164 (+14035551234). Returns '' if invalid. */
function normalizePhone(input) {
  if (!input) return '';
  const trimmed = String(input).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') && digits.length >= 10 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return '';
}

/** +14035551234 -> 403-555-1234 */
function prettyPhone(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  const local = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (local.length !== 10) return e164 || '';
  return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-10' -> 'Tue Nov 10' */
function formatDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return ymd || '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

/** '07:00' -> '7:00 AM' */
function formatTime(hm) {
  if (!hm) return '';
  const [h, m] = hm.split(':').map(Number);
  if (Number.isNaN(h)) return hm;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

const FORMS = require('../public/forms');

function jobTypeInfo(type) {
  return FORMS.typeInfo(type);
}

/** One-line description of the work ("2" minus - 20 loads", "Empty & return - 20 yd"). */
function cargoSummary(job) {
  return FORMS.summary(job);
}

/** Delivery address with the municipality added, unless it's already in there. */
function siteAddress(job) {
  const to = job.to_location || '';
  const muni = job.municipality || '';
  if (!muni || to.toLowerCase().includes(muni.toLowerCase())) return to;
  return to ? `${to}, ${muni}` : muni;
}

/** '7:00 AM', 'FIRST THING', 'FIRST THING (7:00 AM)' or '' */
function formatJobTime(job) {
  const time = formatTime(job.scheduled_time);
  if (job.first_thing) return time ? `FIRST THING (${time})` : 'FIRST THING';
  return time;
}

/** 'Tue Nov 10 @ 7:00 AM' / 'Tue Nov 10 - FIRST THING' */
function formatJobWhen(job) {
  const time = formatJobTime(job);
  if (!time) return formatDate(job.scheduled_date);
  return `${formatDate(job.scheduled_date)}${job.first_thing ? ' - ' : ' @ '}${time}`;
}

function jobLink(token) {
  return `${config.publicUrl}/j/${token}`;
}

/** The text a driver receives for a job. Plain text, readable without opening the link. */
function buildJobText(job, assignment, { updated = false } = {}) {
  const t = jobTypeInfo(job.job_type);
  const lines = [];
  lines.push(`${config.companyName} - ${updated ? 'UPDATED ' : ''}${t.title} #${job.id}`);
  lines.push(formatJobWhen(job));
  if (assignment.truck_unit) lines.push(`Truck: ${assignment.truck_unit}`);
  const cargo = cargoSummary(job);
  if (cargo) lines.push(`${t.what || 'Job'}: ${cargo}`);
  const lb = FORMS.labels(job);
  const site = siteAddress(job);
  // For a haul-away the job site comes first: that's where the truck goes.
  if (FORMS.isHaulAway(job)) {
    if (site) lines.push(`${lb.to}: ${site}`);
    if (job.from_location) lines.push(`${lb.from}: ${job.from_location}`);
  } else {
    if (lb.from && job.from_location) lines.push(`${lb.from}: ${job.from_location}`);
    if (site) lines.push(`${lb.to}: ${site}`);
  }
  for (const [label, value] of FORMS.smsLines(job)) lines.push(`${label}: ${value}`);
  for (const line of FORMS.driverInstructions(job)) lines.push(line.toUpperCase());
  const customer = [job.customer, prettyPhone(job.customer_phone)].filter(Boolean).join(' ');
  if (customer) lines.push(`Customer: ${customer}`);
  const contact = [job.contact_name, prettyPhone(job.contact_phone)].filter(Boolean).join(' ');
  if (contact) lines.push(`Site contact: ${contact}`);
  if (job.notes) lines.push(`Notes: ${job.notes}`);
  lines.push('');
  const untilStop = job.job_type === 'haul' && FORMS.parseDetails(job).until_stop;
  lines.push(untilStop ? 'Reply OK to confirm. Reply DONE when the site says stop.' : 'Reply OK to confirm. Reply DONE when finished.');
  lines.push(`Details: ${jobLink(assignment.token)}`);
  return lines.join('\n');
}

/**
 * The evening "here's your day" text. One job gets the full job text; several get a numbered list,
 * each with its own details link.
 */
function buildLineupText(date, items) {
  if (items.length === 1) {
    const { job, assignment } = items[0];
    return `Your job for ${formatDate(date)}:\n` + buildJobText(job, assignment, { updated: false });
  }
  const lines = [`${config.companyName} - Your ${items.length} jobs for ${formatDate(date)}:`];
  items.forEach(({ job, assignment }, i) => {
    const t = jobTypeInfo(job.job_type);
    lines.push('');
    const time = formatJobTime(job);
    lines.push(`${i + 1}) ${time ? time + ' - ' : ''}${t.name} #${job.id}`);
    const cargo = cargoSummary(job);
    if (cargo) lines.push(cargo);
    const lb = FORMS.labels(job);
    const site = siteAddress(job);
    if (FORMS.isHaulAway(job)) {
      if (site) lines.push(`${lb.to}: ${site}`);
      if (job.from_location) lines.push(`${lb.from}: ${job.from_location}`);
    } else {
      if (lb.from && job.from_location) lines.push(`${lb.from}: ${job.from_location}`);
      if (site) lines.push(`${lb.to}: ${site}`);
    }
    if (assignment.truck_unit) lines.push(`Truck: ${assignment.truck_unit}`);
    lines.push(`Details: ${jobLink(assignment.token)}`);
  });
  lines.push('');
  lines.push('Reply OK to confirm all. Reply DONE when you finish each job.');
  return lines.join('\n');
}

function buildCancelText(job) {
  return `${config.companyName} - Job #${job.id} on ${formatDate(job.scheduled_date)} is CANCELLED. ` +
    `You do not need to do this job. Call dispatch with any questions.`;
}

function buildRemovedText(job) {
  return `${config.companyName} - You have been taken OFF Job #${job.id} on ${formatDate(job.scheduled_date)}. ` +
    `Call dispatch with any questions.`;
}

const ACK_WORDS = new Set([
  'OK', 'OKAY', 'K', 'KK', 'Y', 'YES', 'YEP', 'YUP', 'YEAH', 'YA', 'SURE', 'GOT', 'ROGER', 'CONFIRM',
  'CONFIRMED', 'C', 'COPY', 'ACK', '104', '10-4', 'SOUNDS', 'WILL', 'ON', '👍', '👌', '✅',
]);
const DONE_WORDS = new Set(['DONE', 'D', 'FINISHED', 'FINISH', 'COMPLETE', 'COMPLETED', 'ALL']);
// Replies that need no action and shouldn't be flagged to the office.
const SMALL_TALK = /^(THANKS|THANK YOU|THANKYOU|THX|TY|CHEERS|NP|NO PROBLEM)[\s!.]*$/i;

/**
 * Work out what a driver meant by a text reply.
 * Returns { action: 'ack' | 'done' | null, jobId: number | null }.
 * Only the first word decides the action so "ok thanks" works but "not ok" doesn't.
 */
function parseReply(body) {
  const text = String(body || '').trim();
  if (!text) return { action: null, jobId: null };
  const upper = text.toUpperCase();

  const jobMatch = upper.replace(/10-4/g, '').match(/#?\s*\b(\d{3,6})\b/);
  const jobId = jobMatch ? Number(jobMatch[1]) : null;

  // First "word" — keep emoji and 10-4 intact.
  const first = upper.replace(/^[^\p{L}\p{N}\p{Extended_Pictographic}]+/u, '').split(/[\s,.!?:;]+/)[0];
  if (DONE_WORDS.has(first)) {
    if (first === 'ALL' && !/^ALL\s+DONE/.test(upper)) return { action: null, jobId };
    return { action: 'done', jobId };
  }
  if (ACK_WORDS.has(first)) {
    if (first === 'GOT' && !/^GOT\s+(IT|ER|THAT)/.test(upper)) return { action: null, jobId };
    if (first === 'SOUNDS' && !/^SOUNDS\s+GOOD/.test(upper)) return { action: null, jobId };
    if (first === 'WILL' && !/^WILL\s+DO/.test(upper)) return { action: null, jobId };
    if (first === 'ON' && !/^ON\s+IT/.test(upper)) return { action: null, jobId };
    return { action: 'ack', jobId };
  }
  return { action: null, jobId };
}

/**
 * Send a text. Without Twilio settings the message is only logged (handy for trying
 * the system out); it still shows on the dashboard as sent.
 */
async function sendSms(to, body) {
  if (!config.smsEnabled) {
    console.log(`\n[SMS not configured — would text ${to}]\n${body}\n`);
    return { sid: 'local-' + crypto.randomBytes(6).toString('hex'), simulated: true };
  }
  const { accountSid, authToken, fromNumber } = config.twilio;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: fromNumber, Body: body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio error ${res.status}`);
  return { sid: data.sid };
}

/** Verify an inbound webhook really came from Twilio. */
function validTwilioSignature(signature, url, params, authToken = config.twilio.authToken) {
  if (!signature || !authToken) return false;
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function twiml(message) {
  const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  return '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    (message ? `<Message>${esc(message)}</Message>` : '') + '</Response>';
}

module.exports = {
  normalizePhone,
  prettyPhone,
  formatDate,
  formatTime,
  formatJobTime,
  formatJobWhen,
  jobTypeInfo,
  siteAddress,
  cargoSummary,
  jobLink,
  buildJobText,
  buildLineupText,
  buildCancelText,
  buildRemovedText,
  parseReply,
  sendSms,
  validTwilioSignature,
  twiml,
  SMALL_TALK,
};
