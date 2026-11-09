// Spreadsheet (CSV) export of work orders, e.g. for the accountant at tax time.
// Opens in Excel / Google Sheets: UTF-8 with a BOM, one row per work order.
const config = require('./config');
const sms = require('./sms');
const FORMS = require('../public/forms');
const { reportFields } = require('./dispatch');

/** Local date/time (company time zone) from a stored UTC 'YYYY-MM-DD HH:MM:SS'. */
function localStamp(sqlUtc) {
  if (!sqlUtc) return '';
  const d = new Date(String(sqlUtc).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** "Label: value; Label: value" for the type-specific form fields. */
function detailsText(job) {
  const d = job.details || {};
  return FORMS.typeInfo(job.job_type).fields
    .filter((f) => !FORMS.isEmpty(d[f.key]))
    .map((f) => `${f.label}: ${f.kind === 'date' ? d[f.key] : d[f.key]}`).join('; ');
}

function reportText(job) {
  return job.assignments.filter((a) => a.report && Object.keys(a.report).length).map((a) => {
    const fields = reportFields(job.job_type).filter((f) => !FORMS.isEmpty(a.report[f.key]));
    return `${a.driver_name}: ${fields.map((f) => `${f.label}: ${a.report[f.key]}`).join('; ')}`;
  }).join(' | ');
}

const COLUMNS = [
  ['Work order #', (j) => j.id],
  ['Paper W.O. #', (j) => j.paper_wo],
  ['Date', (j) => j.scheduled_date],
  ['Time', (j) => sms.formatJobTime(j)],
  ['Type', (j) => FORMS.typeInfo(j.job_type).title],
  ['Status', (j) => j.status],
  ['Completed', (j) => localStamp(j.completed_at)],
  ['Customer', (j) => j.customer],
  ['Customer phone', (j) => sms.prettyPhone(j.customer_phone)],
  ['Customer email', (j) => j.customer_email],
  ['Billing address', (j) => j.billing_address],
  ['PO #', (j) => j.po_number],
  ['Site / delivery address', (j) => j.to_location],
  ['Municipality', (j) => j.municipality],
  ['From / dump at', (j) => j.from_location],
  ['Work', (j) => FORMS.summary(j)],
  ['Material / equipment / size', (j) => j.material],
  ['Quantity', (j) => [j.quantity, j.unit].filter(Boolean).join(' ')],
  ['Loads planned', (j) => FORMS.totalLoads(j) || ''],
  ['Loads done', (j) => j.assignments.reduce((n, a) => n + (a.loads_done || 0), 0) || ''],
  ['Drivers', (j) => j.assignments.filter((a) => a.status !== 'cancelled').map((a) => a.driver_name).join(', ')],
  ['Trucks', (j) => [...new Set(j.assignments.map((a) => a.truck_unit).filter(Boolean))].join(', ')],
  ['Quoted price', (j) => j.quoted_price],
  ['Payment method', (j) => j.payment_method],
  ['Site contact', (j) => [j.contact_name, sms.prettyPhone(j.contact_phone)].filter(Boolean).join(' ')],
  ['Special instructions', (j) => j.notes],
  ['Form details', detailsText],
  ['Driver report', reportText],
  ['Ticket photos', (j) => j.tickets.length || ''],
  ['Website request #', (j) => j.request_id || ''],
  ['Created', (j) => localStamp(j.created_at)],
];

/** Quote a CSV cell. Cells starting with = + - @ are prefixed with ' so spreadsheets don't run them as formulas. */
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

function jobsToCsv(jobs) {
  const rows = [COLUMNS.map(([h]) => h), ...jobs.map((j) => COLUMNS.map(([, get]) => get(j)))];
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { jobsToCsv, COLUMNS, localStamp };
