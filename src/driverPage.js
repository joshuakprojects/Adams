const config = require('./config');
const sms = require('./sms');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mapsUrl = (address) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;

const STATUS_TEXT = {
  pending: 'New job',
  sent: 'New job – please confirm',
  acknowledged: 'Confirmed',
  in_progress: 'In progress',
  done: 'Finished',
  cancelled: 'CANCELLED',
};

function row(label, value, extra = '') {
  if (!value) return '';
  return `<div class="row"><div class="label">${esc(label)}</div><div class="value">${esc(value)}${extra}</div></div>`;
}

/**
 * The page a driver opens from the link in their text. Big text, big buttons, no login.
 * Works without JavaScript (plain form posts).
 */
function renderDriverPage(a, otherJobs = []) {
  const job = a.job;
  const t = sms.jobTypeInfo(job.job_type);
  const cancelled = a.status === 'cancelled' || job.status === 'cancelled';
  const action = (name, label, cls = '') =>
    `<form method="post" action="/j/${esc(a.token)}/${name}"><button class="btn ${cls}" type="submit">${label}</button></form>`;

  let buttons = '';
  if (cancelled) {
    buttons = `<div class="banner cancelled">This job was CANCELLED. You do not need to do it.</div>`;
  } else if (a.status === 'done') {
    buttons = `<div class="banner done">✔ Finished${a.loads_done ? ` — ${a.loads_done} load${a.loads_done === 1 ? '' : 's'}` : ''}. Thank you!</div>
      ${action('reopen', 'Oops — not finished yet', 'small')}`;
  } else {
    if (a.status === 'pending' || a.status === 'sent') buttons += action('ack', '👍 Got it', 'primary');
    if (job.job_type === 'haul' || job.loads_planned) {
      buttons += `<div class="loads">Loads done: <b>${a.loads_done}</b>${job.loads_planned ? ` of ${job.loads_planned}` : ''}</div>`;
      buttons += action('load', '+1 Load delivered', 'load');
      if (a.loads_done > 0) buttons += action('unload', 'Undo last load', 'small');
    }
    buttons += action('done', '✔ Job finished', 'finish');
  }

  const contactPhone = sms.prettyPhone(job.contact_phone);
  const contactLink = job.contact_phone && /^\+?\d+$/.test(job.contact_phone)
    ? ` <a class="call" href="tel:${esc(job.contact_phone)}">Call</a>` : '';

  const others = otherJobs.length ? `
    <h2>Your other jobs</h2>
    <ul class="others">${otherJobs.map((o) => `
      <li><a href="/j/${esc(o.token)}">#${o.job_id} · ${esc(sms.formatDate(o.scheduled_date))} ${esc(sms.formatTime(o.scheduled_time))}
        <span>${esc(o.material || o.to_location || '')}</span></a></li>`).join('')}
    </ul>` : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Job #${job.id} – ${esc(config.companyName)}</title>
<link rel="stylesheet" href="/driver.css">
</head><body>
<header><div class="co">${esc(config.companyName)}</div><div class="num">Job #${job.id}</div></header>
<main>
  <div class="status s-${esc(cancelled ? 'cancelled' : a.status)}">${esc(cancelled ? STATUS_TEXT.cancelled : STATUS_TEXT[a.status] || a.status)}</div>
  <div class="when">${esc(sms.formatDate(job.scheduled_date))}${job.scheduled_time ? ` @ ${esc(sms.formatTime(job.scheduled_time))}` : ''}</div>
  <div class="card">
    ${row('Driver', a.driver_name)}
    ${row('Truck', a.truck_unit)}
    ${row(t.what, sms.cargoSummary(job))}
    ${row(t.from, job.from_location, job.from_location ? `<a class="map" href="${mapsUrl(job.from_location)}">Map ➜</a>` : '')}
    ${row(t.to, job.to_location, job.to_location ? `<a class="map" href="${mapsUrl(job.to_location)}">Map ➜</a>` : '')}
    ${row('Customer', job.customer)}
    ${row('Site contact', [job.contact_name, contactPhone].filter(Boolean).join(' '), contactLink)}
    ${row('Notes', job.notes)}
  </div>
  <div class="actions">${buttons}</div>
  ${config.dispatchPhone ? `<a class="btn call-dispatch" href="tel:${esc(config.dispatchPhone)}">📞 Call dispatch</a>` : ''}
  <p class="tip">You can also just text back <b>OK</b> to confirm or <b>DONE</b> when finished.</p>
  ${others}
</main>
</body></html>`;
}

function renderNotFound() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/driver.css"><title>Job not found</title></head>
<body><header><div class="co">${esc(config.companyName)}</div></header><main>
<div class="banner cancelled">This job link isn't valid anymore. Call dispatch.</div>
${config.dispatchPhone ? `<a class="btn call-dispatch" href="tel:${esc(config.dispatchPhone)}">📞 Call dispatch</a>` : ''}
</main></body></html>`;
}

module.exports = { renderDriverPage, renderNotFound };
