/* End-of-day summary (Board → Day summary) and Setup → Alerts & day summary. Uses app.js (window.APP). */
(function () {
  const A = window.APP;
  if (!A) return;
  const { api, esc, toast, prettyPhone } = A;
  const $ = (s) => document.querySelector(s);
  const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-CA');
  const dateLong = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const phonesText = (list) => (list || []).map(prettyPhone).join('\n');
  const REASON = { 'no driver': 'No driver', 'not texted': 'Not texted', 'no OK yet': 'No OK yet', 'not finished': 'Not finished' };

  // ---------- Board: Day summary ----------
  const dialog = $('#summary-dialog');
  let current = null;

  function tiles(s) {
    const tile = (label, value, sub = '') => `<div class="sum-tile"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    return `<div class="sum-tiles">
      ${tile('Jobs done', `${s.done} <small>of ${s.jobs}</small>`, s.done_by_type.map((t) => `${t.n} ${esc(t.name)}`).join(' · '))}
      ${tile('Loads hauled', s.loads)}
      ${tile('Work done', money(s.done_value), s.unpriced.length ? `${s.unpriced.length} done job${s.unpriced.length === 1 ? '' : 's'} not priced` : '+ HST')}
      ${tile('Booked today', s.booked_today, s.booked_value ? money(s.booked_value) : 'for any day')}
    </div>`;
  }

  function render(data) {
    const s = data.summary;
    current = data;
    $('#summary-title').textContent = `Day summary · ${dateLong(s.date)}`;
    $('#summary-body').innerHTML = `${tiles(s)}
      <div class="sum-block"><h3>Still open <span class="muted">(${s.open.length})</span></h3>
        ${s.open.length ? `<ul class="sum-list">${s.open.map((o) => `<li><b>#${o.id}</b> ${esc(o.customer)} <span class="pill ${o.reason === 'no driver' ? 'warn' : ''}">${REASON[o.reason] || esc(o.reason)}</span>
          ${o.drivers.length ? `<span class="muted small">${esc(o.drivers.join(', '))}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Everything is finished. 👍</p>'}</div>
      <div class="sum-grid">
        <div class="sum-block"><h3>Website orders</h3><p>${s.website_requests} new today${s.waiting_requests ? `, <b>${s.waiting_requests} waiting to book</b>` : ''}</p></div>
        <div class="sum-block"><h3>Cancelled</h3><p>${s.cancelled}</p></div>
        <div class="sum-block"><h3>Machines moved</h3><p>${s.moves.length ? s.moves.map((m) => `${esc(m.machine)} → ${esc(m.to)}`).join('<br>') : 'None'}</p></div>
        <div class="sum-block"><h3>Tomorrow</h3><p>${s.tomorrow.jobs} job${s.tomorrow.jobs === 1 ? '' : 's'}${s.tomorrow.no_driver ? `, <b>${s.tomorrow.no_driver} with no driver</b>` : ''}</p></div>
      </div>
      <details class="sum-text"><summary>The text that gets sent</summary><pre>${esc(data.text)}</pre></details>`;
    const saved = data.summary_phones || [];
    $('#summary-send').innerHTML = `<h3>Text this summary</h3>
      <div class="sum-phones">${saved.map((p, i) => `<label class="check"><input type="checkbox" data-phone="${esc(p)}" checked id="sum-p${i}"> ${esc(prettyPhone(p))}</label>`).join('')}
        <input id="sum-extra" placeholder="Another number (optional)" aria-label="Another number to text"></div>
      ${saved.length ? '' : '<p class="muted small">Tip: save the usual numbers in Setup → Alerts &amp; day summary.</p>'}
      <div class="row-actions"><button class="btn primary" id="sum-send">Text it</button>
        <span class="muted small">${data.summary_time ? `Also texted automatically at ${esc(data.summary_time)} each day.` : ''}</span></div>`;
  }

  async function open(date) {
    const data = await api('/day-summary' + (date ? '?date=' + date : ''));
    render(data);
    if (!dialog.open) dialog.showModal();
  }

  $('#day-summary')?.addEventListener('click', () => open(A.state.date).catch((err) => toast(err.message)));
  dialog?.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-close-summary]') || ev.target === dialog) return dialog.close();
    if (!ev.target.closest('#sum-send')) return;
    const phones = [...dialog.querySelectorAll('[data-phone]:checked')].map((c) => c.dataset.phone);
    const extra = $('#sum-extra').value.trim();
    if (extra) phones.push(extra);
    if (!phones.length) return toast('Tick or type at least one number');
    try {
      const out = await api('/day-summary/send', { method: 'POST', body: { date: current.summary.date, phones } });
      const ok = out.results.filter((r) => r.ok).length;
      const bad = out.results.filter((r) => !r.ok);
      toast(bad.length ? `Texted ${ok}; couldn't text ${bad.map((r) => prettyPhone(r.phone)).join(', ')}` : `Summary texted to ${ok} number${ok === 1 ? '' : 's'}`);
    } catch (err) { toast(err.message); }
  });

  // ---------- Setup → Alerts & day summary ----------
  const form = $('#alerts-form');
  function fill(d) {
    form.elements.alert_phones.value = phonesText(d.alert_phones);
    form.elements.summary_phones.value = phonesText(d.summary_phones);
    form.elements.summary_auto.checked = Boolean(d.summary_time);
    form.elements.summary_time.value = d.summary_time || '17:00';
    $('#alert-list').innerHTML = d.recent.length ? d.recent.map((a) => `<li><span class="when">${esc(A.fmtStamp ? A.fmtStamp(a.at) : a.at)}</span>
      <b>${esc(a.label)}</b> ${esc(a.message)} <span class="muted small">${a.texted ? `texted ${esc(a.texted.split(',').map(prettyPhone).join(', '))}` : 'not texted'}</span></li>`).join('')
      : '<li class="muted">No alerts. All quiet.</li>';
  }
  async function load() {
    if (!form || !A.state.can?.admin) return;
    fill(await api('/alerts'));
  }
  form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const f = form.elements;
      fill(await api('/alerts/settings', { method: 'POST', body: {
        alert_phones: f.alert_phones.value, summary_phones: f.summary_phones.value, summary_time: f.summary_auto.checked ? f.summary_time.value : '' } }));
      toast('Saved');
    } catch (err) { toast(err.message); }
  });
  $('#alerts-test')?.addEventListener('click', async () => {
    try {
      const out = await api('/alerts/test', { method: 'POST' });
      toast(out.texted.length ? `Test alert texted to ${out.texted.map(prettyPhone).join(', ')}` : 'The test alert could not be texted. Check the texting number in Setup.');
      load();
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('click', (ev) => { if (ev.target.closest('[data-tab="people"], [data-setup-go="alerts"]')) load().catch(() => {}); });
  window.ALERTS_UI = { load, openSummary: open };
})();
