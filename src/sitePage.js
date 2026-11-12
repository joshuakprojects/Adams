// The phone page a site head opens from the afternoon text: tap what you need for the next working day.
const config = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function head(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} – ${esc(config.companyName)}</title>
<link rel="stylesheet" href="/driver.css"><link rel="icon" type="image/png" href="/brand/favicon-64.png">
<style>
  .need { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 0; border-bottom: 1px solid #eee; }
  .need:last-child { border-bottom: 0; }
  .need .nm { font-size: 19px; font-weight: 700; }
  .step { display: flex; align-items: center; gap: 8px; }
  .step button { width: 46px; height: 46px; border-radius: 50%; border: 2px solid #1d3a2b; background: #fff; font-size: 24px; font-weight: 800; color: #1d3a2b; }
  .step output { min-width: 26px; text-align: center; font-size: 22px; font-weight: 800; }
  textarea { width: 100%; font: inherit; font-size: 18px; padding: 10px; border-radius: 10px; border: 2px solid #ccc; box-sizing: border-box; }
  .quick { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 12px 0 18px; }
  .quick .btn { font-size: 18px; padding: 16px; background: #fff; border: 3px solid #1d3a2b; color: #1d3a2b; }
  h2 { margin: 22px 0 6px; font-size: 18px; text-transform: uppercase; letter-spacing: .04em; color: #555; }
  .saved { background: #e7f4ea; border: 2px solid #1d7a3d; color: #1d3a2b; padding: 14px; border-radius: 12px; font-size: 18px; margin: 12px 0; }
</style></head><body>`;
}

function stepper(name, label, value = 0) {
  return `<div class="need"><span class="nm">${esc(label)}</span><span class="step">
    <button type="button" data-d="-1" aria-label="One less ${esc(label)}">−</button><output>${value}</output>
    <button type="button" data-d="1" aria-label="One more ${esc(label)}">+</button>
    <input type="hidden" name="${esc(name)}" value="${value}"></span></div>`;
}

function renderSitePage(p, { saved = false, describe = (r) => '' } = {}) {
  const r = p.current?.request || {};
  const count = (list, key, val) => (list || []).filter((x) => x[key] === val).reduce((n, x) => n + (x.count || 1), 0);
  const slot = (r.trucks || [])[0]?.slot || (r.equipment || [])[0]?.slot || '';
  const first = String(p.site.head_name || '').split(' ')[0];
  return `${head(p.site.name)}
<header><div class="co">${esc(config.companyName)}</div><div class="num">🏗️</div></header>
<main>
  <div class="form-title">${esc(p.site.name)}</div>
  <div class="when">What do you need on <b>${esc(p.day_label)}</b>?</div>
  ${saved ? `<div class="saved" role="status">Thanks${first ? ' ' + esc(first) : ''} — got it: ${esc(describe(r) || 'nothing needed')}. We'll text you what's confirmed.</div>` : ''}
  <form method="post" class="quick">
    <button class="btn" name="quick" value="same">Same as last time</button>
    <button class="btn" name="quick" value="nothing">Nothing needed</button>
  </form>
  <form method="post" id="needs">
    <h2>Trucks</h2>
    <div class="card">${p.truck_types.map((t) => stepper(`truck:${t}`, t, count(r.trucks, 'type', t))).join('')}</div>
    <h2>Machines</h2>
    <div class="card">${p.kinds.map((k) => stepper(`machine:${k}`, k, (r.equipment || []).filter((e) => e.kind === k).length)).join('')}</div>
    <h2>People</h2>
    <div class="card">${stepper('labourers', 'Labourers', r.labourers || 0)}</div>
    <fieldset class="choice"><legend>When</legend>
      ${Object.entries(p.slots).map(([k, v]) => `<label><input type="radio" name="slot" value="${k}" ${slot === k ? 'checked' : ''}><span>${esc(v[0].toUpperCase() + v.slice(1))}</span></label>`).join('')}
    </fieldset>
    <h2>Anything else?</h2>
    <textarea name="note" rows="3" placeholder="e.g. need the float to move the ex Friday">${esc(r.note || '')}</textarea>
    <button class="btn primary" style="margin-top:16px">Send</button>
  </form>
</main>
<script>
document.querySelectorAll('.step').forEach((s) => s.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const input = s.querySelector('input'); const out = s.querySelector('output');
  const v = Math.max(0, Math.min(9, Number(input.value) + Number(b.dataset.d)));
  input.value = v; out.textContent = v;
}));
</script>
</body></html>`;
}

/** Turn the posted form into a request: { trucks, equipment, labourers, note, nothing, same }. */
function requestFromForm(body) {
  if (body.quick === 'nothing') return { nothing: true, trucks: [], equipment: [], labourers: 0, note: '' };
  if (body.quick === 'same') return { same: true };
  const slot = ['first', 'am', 'pm', 'all'].includes(body.slot) ? body.slot : '';
  const out = { trucks: [], equipment: [], labourers: Math.max(0, Math.min(20, Number(body.labourers) || 0)), note: String(body.note || '').trim().slice(0, 300) };
  for (const [k, v] of Object.entries(body)) {
    const n = Math.max(0, Math.min(9, Number(v) || 0));
    if (!n) continue;
    if (k.startsWith('truck:')) out.trucks.push({ type: k.slice(6).slice(0, 40), count: n, slot });
    if (k.startsWith('machine:')) for (let i = 0; i < n; i++) out.equipment.push({ kind: k.slice(8).slice(0, 60), slot });
  }
  if (!out.trucks.length && !out.equipment.length && !out.labourers && !out.note) out.nothing = true;
  return out;
}

function renderSiteNotFound() {
  return `${head('Not found')}<main><div class="form-title">This link isn't active</div>
    <p>Call the office: ${esc(config.company?.phone || '')}</p></main></body></html>`;
}

module.exports = { renderSitePage, requestFromForm, renderSiteNotFound };
