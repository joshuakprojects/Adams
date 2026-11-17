/* Repeating work orders: the Repeat section on the work order form, and the Board's "🔁 Repeating" list.
   Uses app.js (window.APP). Visits are made by the server two weeks ahead, with no driver. */
(function () {
  const A = window.APP;
  if (!A) return;
  const { api, esc, toast } = A;
  const $ = (s, r = document) => r.querySelector(s);
  const box = $('#repeat-box');
  const sec = $('#repeat-sec');
  const form = A.form || $('#job-form');
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dateLong = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const weekdayOf = (ymd) => (ymd ? new Date(ymd + 'T12:00:00Z').getUTCDay() : 1);
  let job = null; // the work order being edited (null = new)

  const OPTIONS = [['', "Doesn't repeat"], ['week:1', 'Every week'], ['week:2', 'Every 2 weeks'], ['week:3', 'Every 3 weeks'], ['week:4', 'Every 4 weeks'], ['month:1', 'Every month (same date)'], ['month:2', 'Every 2 months'], ['month:3', 'Every 3 months']];

  function ruleEditor(rule) {
    const date = form.elements.scheduled_date.value;
    const sel = rule ? `${rule.freq}:${rule.every}` : '';
    const days = rule?.weekdays?.length ? rule.weekdays : [weekdayOf(date)];
    const end = rule?.end_date ? 'date' : rule?.max_visits ? 'count' : 'never';
    return `<div class="repeat-grid">
      <label>How often <select name="rp.how" id="rp-how">${OPTIONS.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="field-col rp-week" ${sel.startsWith('week') ? '' : 'hidden'}><span class="lbl">On</span>
        <div class="rp-days">${DAYS.map((d, i) => `<label class="rp-day"><input type="checkbox" name="rp.day" value="${i}" ${days.includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div></div>
      <div class="field-col rp-end" ${sel ? '' : 'hidden'}><span class="lbl">Ends</span>
        <div class="rp-ends">
          <label><input type="radio" name="rp.end" value="never" ${end === 'never' ? 'checked' : ''}> Never</label>
          <label><input type="radio" name="rp.end" value="date" ${end === 'date' ? 'checked' : ''}> On <input type="date" name="rp.end_date" value="${esc(rule?.end_date || '')}" aria-label="Last visit date"></label>
          <label><input type="radio" name="rp.end" value="count" ${end === 'count' ? 'checked' : ''}> After <input type="number" name="rp.max" min="2" max="500" value="${esc(rule?.max_visits || '')}" aria-label="Number of visits" class="rp-max"> visits</label>
        </div></div>
    </div>
    <p class="muted small rp-note" ${sel ? '' : 'hidden'}>Visits are made two weeks ahead with no driver. Pick the driver for each one on the Board.</p>`;
  }

  function render() {
    const type = form.querySelector('input[name=job_type]:checked')?.value;
    sec.hidden = type === 'site' || (job && !job.series && job.status !== 'open');
    if (job?.series) {
      const s = job.series;
      box.innerHTML = `<div class="rp-series"><b>🔁 ${esc(s.label)}</b>${s.paused ? ' <span class="pill warn">Paused</span>' : ''}${s.ended ? ' <span class="pill">Stopped</span>' : ''}
          <button type="button" class="btn tiny" id="rp-manage">Manage repeats</button></div>
        <div class="field-col"><span class="lbl">Save changes to</span>
          <div class="segmented small-seg" role="radiogroup">
            <label><input type="radio" name="rp.scope" value="this" checked><span>This visit only</span></label>
            <label><input type="radio" name="rp.scope" value="future"><span>This and future visits</span></label></div></div>
        <div id="rp-future" hidden>${ruleEditor(s.rule)}</div>`;
    } else {
      box.innerHTML = ruleEditor(null);
    }
  }

  function refreshVisibility() {
    const how = $('#rp-how')?.value || '';
    box.querySelector('.rp-week')?.toggleAttribute('hidden', !how.startsWith('week'));
    box.querySelector('.rp-end')?.toggleAttribute('hidden', !how);
    box.querySelector('.rp-note')?.toggleAttribute('hidden', !how);
    const future = box.querySelector('input[name="rp.scope"]:checked')?.value === 'future';
    $('#rp-future')?.toggleAttribute('hidden', !future);
  }

  box?.addEventListener('change', refreshVisibility);
  box?.addEventListener('click', (e) => { if (e.target.closest('#rp-manage')) { e.preventDefault(); openList(); } });
  $('#job-type')?.addEventListener('change', () => { const keep = collectRule(); render(); if (keep && !job?.series) restore(keep); refreshVisibility(); });
  form?.elements.scheduled_date?.addEventListener('change', () => {
    // A new weekly repeat follows the date's weekday until days are picked by hand.
    if (job?.series) return;
    const ticked = [...box.querySelectorAll('input[name="rp.day"]:checked')];
    if (ticked.length <= 1) box.querySelectorAll('input[name="rp.day"]').forEach((c) => { c.checked = Number(c.value) === weekdayOf(form.elements.scheduled_date.value); });
  });

  function collectRule() {
    const how = $('#rp-how')?.value || '';
    if (!how) return null;
    const [freq, every] = how.split(':');
    const end = box.querySelector('input[name="rp.end"]:checked')?.value || 'never';
    return {
      freq, every: Number(every),
      weekdays: [...box.querySelectorAll('input[name="rp.day"]:checked')].map((c) => Number(c.value)),
      end_date: end === 'date' ? box.querySelector('[name="rp.end_date"]').value : '',
      max_visits: end === 'count' ? box.querySelector('[name="rp.max"]').value : '',
    };
  }
  function restore(rule) { box.innerHTML = ruleEditor(rule); }

  /** What the form adds to the saved work order. */
  function collect() {
    if (sec.hidden) return {};
    if (job?.series) {
      const future = box.querySelector('input[name="rp.scope"]:checked')?.value === 'future';
      return future ? { series_scope: 'future', repeat: collectRule() } : { series_scope: 'this' };
    }
    const rule = collectRule();
    return rule ? { repeat: rule } : {};
  }

  function openForm(data) {
    job = data && data.id ? data : null;
    render();
    refreshVisibility();
  }

  // ---------- the "🔁 Repeating" list ----------
  const dialog = $('#repeat-dialog');
  async function openList() {
    const { series } = await api('/series');
    const T = window.FORMS?.TYPES || {};
    $('#repeat-list').innerHTML = series.length ? series.map((s) => `<div class="rp-item ${s.ended ? 'ended' : ''}" data-series="${s.id}">
        <div class="rp-top"><b>${esc(T[s.job_type]?.icon || '')} ${esc(s.customer || T[s.job_type]?.name || 'Work order')}</b>
          ${s.ended ? '<span class="pill">Stopped</span>' : s.paused ? '<span class="pill warn">Paused</span>' : ''}</div>
        <div>${esc(s.label)} · <span class="muted">${esc(s.to_location)}</span></div>
        <div class="muted small">${s.visits} visit${s.visits === 1 ? '' : 's'} so far, ${s.done} done${s.next ? ` · next ${esc(dateLong(s.next.date))} (#${s.next.id})` : ''}</div>
        ${s.ended ? '' : `<div class="rp-actions">
          ${s.upcoming.length ? `<select data-skip aria-label="Skip a visit"><option value="">Skip a visit…</option>${s.upcoming.map((u) => `<option value="${u.date}">${esc(dateLong(u.date))}</option>`).join('')}</select>` : ''}
          <button class="btn tiny" data-act="${s.paused ? 'resume' : 'pause'}">${s.paused ? 'Resume' : 'Pause'}</button>
          <button class="btn tiny danger" data-act="stop">Stop repeating</button></div>`}
      </div>`).join('') : '<p class="muted">Nothing repeats yet. On a work order, set <b>Repeat</b> to e.g. Every week.</p>';
    if (!dialog.open) dialog.showModal();
  }
  async function act(id, action, date = '') {
    try {
      await api(`/series/${id}`, { method: 'POST', body: { action, date } });
      toast({ pause: 'Paused: future visits with no driver removed', resume: 'Resumed', stop: 'Stopped: future visits with no driver removed', skip: 'Visit skipped' }[action]);
      await openList();
      window.APP.state && document.dispatchEvent(new CustomEvent('board-refresh'));
    } catch (err) { toast(err.message); }
  }
  $('#repeat-list-btn')?.addEventListener('click', () => openList().catch((err) => toast(err.message)));
  dialog?.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-repeat]') || e.target === dialog) return dialog.close();
    const b = e.target.closest('[data-act]');
    if (b) {
      const id = b.closest('[data-series]').dataset.series;
      if (b.dataset.act === 'stop' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to stop'; return; }
      act(id, b.dataset.act);
    }
  });
  dialog?.addEventListener('change', (e) => {
    if (!e.target.matches('[data-skip]') || !e.target.value) return;
    act(e.target.closest('[data-series]').dataset.series, 'skip', e.target.value);
  });

  window.REPEAT_UI = { openForm, collect, openList };
})();
