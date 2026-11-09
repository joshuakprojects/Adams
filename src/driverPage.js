const config = require('./config');
const sms = require('./sms');
const FORMS = require('../public/forms');
const { reportFields } = require('./dispatch');

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

function fieldInput(f, value, prefix = '') {
  const name = esc(prefix + f.key);
  if (f.kind === 'choice') {
    return `<fieldset class="choice"><legend>${esc(f.label)}</legend>${f.options.map((o) => `
      <label><input type="radio" name="${name}" value="${esc(o)}" ${value === o ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}
    </fieldset>`;
  }
  if (f.kind === 'textarea') {
    return `<label class="field">${esc(f.label)}<textarea name="${name}" rows="3">${esc(value)}</textarea></label>`;
  }
  return `<label class="field">${esc(f.label)}<input name="${name}" value="${esc(value)}" ${f.kind === 'number' ? 'inputmode="decimal"' : ''}></label>`;
}

/**
 * The page a driver opens from the link in their text. Big text, big buttons, no login.
 * Works without JavaScript (plain form posts).
 */
function renderDriverPage(a, otherJobs = [], tickets = [], { saved = false } = {}) {
  const job = a.job;
  const t = sms.jobTypeInfo(job.job_type);
  const d = FORMS.parseDetails(job);
  const cancelled = a.status === 'cancelled' || job.status === 'cancelled';
  const action = (name, label, cls = '') =>
    `<form method="post" action="/j/${esc(a.token)}/${name}"><button class="btn ${cls}" type="submit">${label}</button></form>`;

  let top = '';
  let finish = '';
  if (cancelled) {
    top = `<div class="banner cancelled">This job was CANCELLED. You do not need to do it.</div>`;
  } else if (a.status === 'done') {
    top = `<div class="banner done">✔ Finished${a.loads_done ? ` — ${a.loads_done} load${a.loads_done === 1 ? '' : 's'}` : ''}. Thank you!</div>`;
    finish = action('reopen', 'Oops — not finished yet', 'small');
  } else {
    if (a.status === 'pending' || a.status === 'sent') top += action('ack', '👍 Got it', 'primary');
    const planned = FORMS.totalLoads(job);
    if (t.loads || planned) {
      top += `<div class="loads">Loads done: <b>${a.loads_done}</b>${planned ? ` of ${planned}` : ''}</div>`;
      top += action('load', '+1 Load delivered', 'load');
      if (a.loads_done > 0) top += action('unload', 'Undo last load', 'small');
    }
    finish = action('done', '✔ Job finished', 'finish');
  }

  const callLink = (phone) => (phone && /^\+?\d+$/.test(phone) ? ` <a class="call" href="tel:${esc(phone)}">Call</a>` : '');
  const site = sms.siteAddress(job);
  const typeRows = t.fields
    .filter((f) => !/^toilet\d_/.test(f.key) && !/^aggregate2_/.test(f.key) && !['service', 'trip', 'truck'].includes(f.key))
    .map((f) => row(f.label, f.kind === 'date' ? sms.formatDate(d[f.key]) : d[f.key])).join('');

  // After-job report: the form's own questions (septic conditions) and notes. Payments are handled by the office.
  const fields = reportFields(job.job_type);
  const typeReport = t.report.length > 0;
  const r = a.report || {};
  const reportForm = cancelled ? '' : `
    <form method="post" action="/j/${esc(a.token)}/report" id="report" class="report ${typeReport ? '' : 'compact'}">
      <h2>${esc(t.reportTitle || 'Notes for the office')}</h2>
      ${saved ? '<div class="banner saved">✔ Saved — thanks!</div>' : ''}
      ${fields.map((f) => fieldInput(f, r[f.key])).join('')}
      <button class="btn primary" type="submit">Save${typeReport ? ' report' : ''}</button>
    </form>`;

  const photoWord = ['haul', 'misc'].includes(job.job_type) ? 'scale ticket' : 'job';
  const ticketSection = cancelled ? '' : `
    <h2>${photoWord === 'job' ? 'Photos' : 'Scale tickets'}</h2>
    ${tickets.length ? `<div class="tickets">${tickets.map((tk) => `
      <a href="/j/${esc(a.token)}/ticket/${tk.id}" target="_blank"><img src="/j/${esc(a.token)}/ticket/${tk.id}" alt="Photo" loading="lazy"></a>`).join('')}
    </div>` : ''}
    <label class="btn photo" id="photo-btn">📷 Add ${photoWord} photo
      <input type="file" accept="image/*" capture="environment" id="photo-input" hidden>
    </label>
    <div id="photo-status" class="tip"></div>
    <p class="tip">Or just text the photo to this number.</p>`;

  const others = otherJobs.length ? `
    <h2>Your other jobs</h2>
    <ul class="others">${otherJobs.map((o) => `
      <li><a href="/j/${esc(o.token)}">${esc(sms.jobTypeInfo(o.job_type).name)} #${o.job_id} · ${esc(sms.formatDate(o.scheduled_date))} ${esc(sms.formatTime(o.scheduled_time))}
        <span>${esc(o.material || o.to_location || '')}</span></a></li>`).join('')}
    </ul>` : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(t.name)} #${job.id} – ${esc(config.companyName)}</title>
<link rel="stylesheet" href="/driver.css">
</head><body>
<header><div class="co">${esc(config.companyName)}</div><div class="num">${esc(t.icon)} #${job.id}</div></header>
<main>
  <div class="form-title">${esc(t.title)}</div>
  <div class="status s-${esc(cancelled ? 'cancelled' : a.status)}">${esc(cancelled ? STATUS_TEXT.cancelled : STATUS_TEXT[a.status] || a.status)}</div>
  <div class="when">${esc(sms.formatDate(job.scheduled_date))}${job.scheduled_time ? ` @ ${esc(sms.formatTime(job.scheduled_time))}` : ''}</div>
  <div class="card">
    ${row(t.what || 'Job', sms.cargoSummary(job))}
    ${t.from ? row(t.from, job.from_location, job.from_location ? `<a class="map" href="${mapsUrl(job.from_location)}">Map ➜</a>` : '') : ''}
    ${row(t.to, site, site ? `<a class="map" href="${mapsUrl(site)}">Map ➜</a>` : '')}
    ${typeRows}
    ${row('Customer', [job.customer, sms.prettyPhone(job.customer_phone)].filter(Boolean).join(' '), callLink(job.customer_phone))}
    ${row('Site contact', [job.contact_name, sms.prettyPhone(job.contact_phone)].filter(Boolean).join(' '), callLink(job.contact_phone))}
    ${row('Notes', job.notes)}
    ${row('Driver', a.driver_name)}
    ${row('Truck', a.truck_unit)}
  </div>
  <div class="actions">${top}</div>
  ${reportForm}
  ${ticketSection}
  <div class="actions">${finish}</div>
  ${config.dispatchPhone ? `<a class="btn call-dispatch" href="tel:${esc(config.dispatchPhone)}">📞 Call dispatch</a>` : ''}
  <p class="tip">You can also just text back <b>OK</b> to confirm or <b>DONE</b> when finished.</p>
  ${others}
</main>
<script>
(function () {
  var input = document.getElementById('photo-input');
  if (!input) return;
  var status = document.getElementById('photo-status');
  // Shrink big phone photos so they upload quickly on a weak signal.
  function shrink(file) {
    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 1800, w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.round(w * s); c.height = Math.round(h * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.8);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) return;
    status.textContent = 'Uploading photo…';
    shrink(file).then(function (blob) {
      return fetch(location.pathname + '/ticket', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Upload failed'); });
      status.textContent = '✔ Photo saved';
      location.reload();
    }).catch(function (err) {
      status.textContent = '✖ ' + err.message + ' — try again, or text the photo instead.';
    });
  });
})();
</script>
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
