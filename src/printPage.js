const config = require('./config');
const sms = require('./sms');
const FORMS = require('../public/forms');
const { reportFields } = require('./dispatch');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function line(label, value, cls = '') {
  return `<div class="ln ${cls}"><span class="lb">${esc(label)}:</span><span class="val">${esc(value || '')}</span></div>`;
}

/** Choice fields print like the paper form: every option listed, the chosen one circled. */
function circled(label, options, value) {
  const long = options.join('').length > 16 ? 'long' : '';
  return `<div class="ln choice ${long}"><span class="lb">${esc(label)}:</span><span class="opts">${options.map((o) =>
    `<span class="opt ${o === value ? 'on' : ''}">${esc(o.toUpperCase())}</span>`).join('')}</span></div>`;
}

function renderField(f, value) {
  if (f.kind === 'choice') return circled(f.label, f.options, value);
  if (f.kind === 'check') return `<div class="ln wide"><span class="lb">${value ? '☑' : '☐'} ${esc(f.label)}</span></div>`;
  if (f.kind === 'date') return line(f.label, value ? sms.formatDate(value) : '');
  return line(f.label, value, f.wide || f.kind === 'textarea' ? 'wide' : '');
}

function fmtStamp(sqlUtc) {
  if (!sqlUtc) return '';
  return new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleString('en-CA', {
    timeZone: config.timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** One work order sheet laid out like the Adams Bros paper forms. */
function renderSheet(job) {
  const t = FORMS.typeInfo(job.job_type);
  const d = job.details || {};
  const c = config.company;
  const created = fmtStamp(job.created_at).split(',').slice(0, 2).join(',');
  const toilets = job.job_type === 'toilet' ? [1, 2, 3].map((i) => `
      <div class="ln half"><span class="lb">Type of toilet:</span><span class="val">${esc(d[`toilet${i}_type`])}</span></div>
      <div class="ln half"><span class="lb">How many:</span><span class="val">${esc(d[`toilet${i}_qty`])}</span></div>`).join('') : '';
  const typeFields = job.job_type === 'haul' ? '' : t.fields.filter((f) => !/^toilet\d_/.test(f.key)).map((f) => renderField(f, d[f.key])).join('');
  // Aggregates: two lines, like the paper form.
  const trucks = (t.fields.find((f) => f.key === 'truck') || {}).options || [];
  const half = (label, value) => `<div class="ln half"><span class="lb">${esc(label)}:</span><span class="val">${esc(value || '')}</span></div>`;
  const haulOptions = job.job_type === 'haul'
    ? t.fields.filter((f) => f.slot === 'first').map((f) => renderField(f, d[f.key])).join('') : '';
  const aggregateRows = job.job_type === 'haul' ? haulOptions + [
    [job.material, d.truck, job.loads_planned, job.quantity],
    [d.aggregate2_type, d.aggregate2_truck, d.aggregate2_loads, d.aggregate2_yards],
  ].map(([type, truck, loads, yards]) => half('Aggregate type', type) + circled('Circle one', trucks, truck) +
    half('# of loads', loads) + half('OR # of yards', yards)).join('<div class="sep"></div>') : '';

  const reports = job.assignments.filter((a) => a.report && Object.keys(a.report).length);
  const reportHtml = reports.map((a) => {
    const fields = reportFields(job.job_type);
    return `<section class="box">
      <h3>${esc(t.reportTitle || 'Driver report')} — ${esc(a.driver_name)}${a.report_at ? ` <small>(${esc(fmtStamp(a.report_at))})</small>` : ''}</h3>
      ${fields.filter((f) => t.report.includes(f) || a.report[f.key]).map((f) => renderField(f, a.report[f.key])).join('')}
    </section>`;
  }).join('');
  // Blank conditions section for septic, so the printed sheet can still be filled in by hand.
  const blankReport = !reports.length && t.report.length ? `<section class="box">
      <h3>${esc(t.reportTitle)}</h3>${t.report.map((f) => renderField(f, '')).join('')}</section>` : '';

  const drivers = job.assignments.filter((a) => a.status !== 'cancelled').map((a) =>
    `${esc(a.driver_name)}${a.truck_unit ? ` (${esc(a.truck_unit)})` : ''}${a.loads_done ? ` — ${a.loads_done} load${a.loads_done === 1 ? '' : 's'}` : ''}`).join(', ');

  // Scale tickets / job photos, so the printed record is complete.
  const photos = (job.tickets || []).length ? `<section class="box photos">
      <h3>${['haul', 'misc'].includes(job.job_type) ? 'Scale tickets' : 'Photos'} (${job.tickets.length})</h3>
      ${job.tickets.map((tk) => `<figure><img src="/api/tickets/${tk.id}/image" alt="Ticket photo"><figcaption>${esc(tk.driver_name || '')} · ${esc(fmtStamp(tk.created_at))}</figcaption></figure>`).join('')}
    </section>` : '';

  return `<article class="sheet t-${esc(job.job_type)}">
  <header>
    <div class="logo"><img src="/brand/adams-a.png" alt="" class="mark-a"><div><div class="mark">ADAMS BROS</div><div class="sub">CONSTRUCTION</div></div></div>
    <div class="co">
      <div>${esc(c.address)}</div>
      <div>${esc(c.phone)} · ${esc(c.email)} · ${esc(c.website)}</div>
    </div>
    <div class="wo">
      <div class="title">${esc(t.title)}</div>
      <div>WORK ORDER # <span class="num">${job.id}</span></div>
      ${job.paper_wo ? `<div class="small">Paper W.O. # ${esc(job.paper_wo)}</div>` : ''}
      <div class="small">HST # ${esc(c.hst)}</div>
    </div>
  </header>
  ${job.status === 'cancelled' ? '<div class="stamp">CANCELLED</div>' : ''}

  <section class="grid2">
    <div>
      ${line('Name', job.customer)}
      ${line('Billing / mailing address', job.billing_address, 'wide')}
      ${line('Phone #', sms.prettyPhone(job.customer_phone))}
      ${line('Email', job.customer_email)}
      ${line('PO #', job.po_number)}
    </div>
    <div>
      ${line('Date', created)}
      ${line(job.job_type === 'septic' ? 'Pump-out date' : 'Delivery date', sms.formatJobWhen(job))}
      ${line(FORMS.labels(job).to, job.to_location, 'wide')}
      ${line('Municipality', job.municipality)}
      ${line('Site contact name / phone #', [job.contact_name, sms.prettyPhone(job.contact_phone)].filter(Boolean).join(' / '))}
    </div>
  </section>

  <section class="box">
    ${aggregateRows || `
    ${t.what ? line(t.what, job.material) : ''}
    ${t.quantity ? `<div class="ln half"><span class="lb">Quantity:</span><span class="val">${esc([job.quantity, job.unit].filter(Boolean).join(' '))}</span></div>` : ''}
    ${t.loads ? `<div class="ln half"><span class="lb">Loads:</span><span class="val">${esc(job.loads_planned || '')}</span></div>` : ''}`}
    ${FORMS.labels(job).from ? line(FORMS.labels(job).from, job.from_location, 'wide') : ''}
    ${toilets}
    ${typeFields}
    ${line('Special instructions', job.notes, 'wide tall')}
    ${line('Driver / truck', drivers, 'wide')}
  </section>

  ${reportHtml || blankReport}

  <section class="price">
    <div class="ln"><span class="lb">Quoted price:</span><span class="val">${esc(job.quoted_price)}</span></div>
    <div class="ln"><span class="lb">HST # ${esc(c.hst)}</span><span class="val"></span></div>
    <div class="ln total"><span class="lb">TOTAL:</span><span class="val">${esc(job.amount_billed)}</span></div>
    ${job.invoice_number ? line('Invoice #', job.invoice_number) : ''}
    ${circled('Payment', FORMS.PAYMENT_METHODS, job.payment_method)}
  </section>

  ${t.disclaimer ? `<p class="disclaimer">${esc(t.disclaimer)}</p>` : ''}
  ${photos}
</article>`;
}

function page(title, body, toolbarNote = '') {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/print.css">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/brand/favicon-64.png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
</head><body>
<div class="toolbar no-print"><button onclick="window.print()">🖨 Print / Save as PDF</button> <button onclick="window.close()">Close</button>${toolbarNote ? `<div class="note">${toolbarNote}</div>` : ''}</div>
${body}
</body></html>`;
}

/** A printable work order laid out like the Adams Bros paper forms. */
function renderPrintPage(job) {
  return page(`${FORMS.typeInfo(job.job_type).title} #${job.id}`, renderSheet(job));
}

/** Many work orders, one per page: for year-end records ("Save as PDF" in the print dialog). */
function renderPrintBatch(jobs, { from, to } = {}) {
  const range = [from, to].filter(Boolean).map((d) => sms.formatDate(d)).join(' – ');
  const title = `Adams Bros work orders ${range}`.trim();
  if (!jobs.length) return page(title, '<p class="empty-batch">No work orders match those filters.</p>');
  return page(title, jobs.map(renderSheet).join('\n'),
    `${jobs.length} work order${jobs.length === 1 ? '' : 's'}${range ? ` · ${esc(range)}` : ''}. In the print window choose <b>Save as PDF</b> to keep a file.`);
}

module.exports = { renderPrintPage, renderPrintBatch, renderSheet };
