/* Dispatch board — plain JS, no build step. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Work order types come from forms.js (shared with the server), modelled on the paper forms.
  const { TYPES, TYPE_KEYS } = window.FORMS;
  const typeInfo = window.FORMS.typeInfo;
  const UNITS = ['tonnes', 'yards', 'loads', 'gallons'];
  const STATUS = {
    pending: 'Not texted', sent: 'Texted – waiting', acknowledged: 'Confirmed ✓', in_progress: 'Working',
    done: 'Done ✓', cancelled: 'Cancelled',
  };

  const state = { date: null, today: null, board: null, drivers: [], trucks: [], smsEnabled: false, tab: 'board' };

  // ---------- helpers ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { location.href = '/login'; throw new Error('Logged out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  const pad = (n) => String(n).padStart(2, '0');
  function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }
  function longDate(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }
  function fmtTime(hm) {
    if (!hm) return '';
    const [h, m] = hm.split(':').map(Number);
    return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  function fmtStamp(sqlUtc) {
    if (!sqlUtc) return '';
    const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
    return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function prettyPhone(p) {
    const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : p || '';
  }
  function cargo(job) {
    return window.FORMS.summary(job);
  }
  function siteAddress(job) {
    const to = job.to_location || '';
    const muni = job.municipality || '';
    if (!muni || to.toLowerCase().includes(muni.toLowerCase())) return to;
    return to ? `${to}, ${muni}` : muni;
  }

  // ---------- tabs ----------
  function showTab(tab) {
    state.tab = tab;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + tab));
    if (tab === 'people') loadPeople();
    if (tab === 'messages') loadMessages();
    if (tab === 'board') loadBoard();
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- board ----------
  async function loadBoard() {
    const data = await api('/board?date=' + state.date);
    state.board = data;
    state.today = data.today;
    state.drivers = data.drivers;
    state.trucks = data.trucks;
    renderBoard();
  }

  function renderBoard() {
    const { jobs, drivers, alerts } = state.board;
    $('#board-date').value = state.date;
    const rel = state.date === state.today ? 'Today · ' : state.date === addDays(state.today, 1) ? 'Tomorrow · ' : '';
    $('#board-title').textContent = rel + longDate(state.date);
    $('#drivers-title').textContent = state.date === state.today ? 'Drivers today' : state.date === addDays(state.today, 1) ? 'Drivers tomorrow' : 'Drivers this day';

    // Alerts: driver texts the system didn't understand.
    const ac = $('#alert-count');
    ac.textContent = alerts.length;
    ac.classList.toggle('hidden', !alerts.length);
    $('#alerts').innerHTML = alerts.map((m) => `
      <div class="alert">
        <span>💬</span>
        <span class="who">${esc(m.driver_name || prettyPhone(m.phone))}${m.job_id ? ` (Job #${m.job_id})` : ''}:</span>
        <span class="body">${esc(m.body)}</span>
        <span class="muted small">${esc(fmtStamp(m.created_at))}</span>
        <button class="btn tiny" data-act="seen" data-id="${m.id}">Got it</button>
      </div>`).join('') + (state.board.unmatched_tickets || []).map((t) => `
      <div class="alert photo">
        <a href="/api/tickets/${t.id}/image" target="_blank"><img src="/api/tickets/${t.id}/image" alt=""></a>
        <span class="body"><b>${esc(t.driver_name || 'Unknown number')}</b> texted a ticket photo we couldn't match to a job.</span>
        <button class="btn tiny" data-act="attach-ticket" data-id="${t.id}" data-driver="${t.driver_id || ''}">Attach to job…</button>
        <button class="btn tiny danger" data-act="delete-ticket" data-id="${t.id}">Delete</button>
      </div>`).join('');

    // Lineup ("text drivers their day") status.
    const lu = state.board.lineup;
    const parts = [];
    if (lu.sent) parts.push(`Day sent to ${lu.sent} of ${lu.drivers} driver${lu.drivers === 1 ? '' : 's'} · ${fmtStamp(lu.last_sent_at)}`);
    else if (lu.auto_time && state.date === addDays(state.today, 1)) parts.push(`Auto-texts drivers at ${fmtTime(lu.auto_time)} today`);
    $('#lineup-status').textContent = parts.join('');
    $('#send-lineup').classList.toggle('hidden', state.date < state.today || !lu.drivers);

    $('#jobs').innerHTML = jobs.length ? jobs.map(renderJob).join('') :
      `<div class="empty">No jobs on this day yet.<br><br><button class="btn primary big" data-act="new">+ New job</button></div>`;

    $('#driver-list').innerHTML = drivers.length ? drivers.map((d) => `
      <div class="drow">
        <span class="name">${esc(d.name)}</span>
        ${d.jobs.length ? d.jobs.map((j) => `<span class="chip ${j.status}" title="${esc(STATUS[j.status])}">#${j.job_id}</span>`).join('') : '<span class="free">Free</span>'}
      </div>`).join('') : '<p class="muted">Add drivers on the Setup tab.</p>';
  }

  function renderJob(job) {
    const t = typeInfo(job.job_type);
    const active = job.assignments.filter((a) => a.status !== 'cancelled');
    const loadsDone = job.assignments.reduce((n, a) => n + a.loads_done, 0);
    const toSend = job.assignments.filter((a) => a.status === 'pending' || (a.needs_resend && a.status !== 'done')).length;
    const statusTag = job.status === 'open' ? '' : `<span class="tag st-${job.status}">${job.status}</span>`;
    const planned = window.FORMS.totalLoads(job);
    const progress = planned || loadsDone ? `
      <div class="progress">Loads: ${loadsDone}${planned ? ` / ${planned}` : ''}
        ${planned ? `<div class="bar"><div style="width:${Math.min(100, (loadsDone / planned) * 100)}%"></div></div>` : ''}
      </div>` : '';

    const rows = job.assignments.map((a) => {
      const chip = a.needs_resend && !['done', 'cancelled'].includes(a.status)
        ? '<span class="chip resend" title="Job changed since this driver was texted">Needs update</span>'
        : `<span class="chip ${a.status}" title="${a.ack_via ? 'Confirmed by ' + (a.ack_via === 'sms' ? 'text reply' : a.ack_via === 'web' ? 'job page' : 'office') : ''}">${STATUS[a.status]}${a.status === 'acknowledged' && a.ack_via === 'sms' ? ' (text)' : ''}</span>`;
      const loads = a.loads_done ? `<span class="truck">${a.loads_done} ld</span>` : '';
      return `<div class="asg">
        <span class="name">${esc(a.driver_name)}</span>
        <span class="truck">${esc(a.truck_unit || '')}</span>
        ${loads}${chip}
        ${job.status === 'cancelled' ? '' : `<details><summary>⋯</summary><div class="menu">
          <button data-act="resend" data-job="${job.id}" data-asg="${a.id}">${a.status === 'pending' ? 'Text this driver' : 'Re-send text'}</button>
          <button data-act="mark" data-token="${a.token}" data-mark="ack">Mark confirmed</button>
          <button data-act="mark" data-token="${a.token}" data-mark="load">+1 load</button>
          <button data-act="mark" data-token="${a.token}" data-mark="done">Mark done</button>
          ${a.status === 'done' ? `<button data-act="mark" data-token="${a.token}" data-mark="reopen">Undo done</button>` : ''}
          <button data-act="copylink" data-token="${a.token}">Copy driver's link</button>
        </div></details>`}
      </div>`;
    }).join('');

    return `<article class="job t-${job.job_type} ${job.status}">
      <div class="job-head">
        <span class="job-num">#${job.id}</span>
        <span class="job-time">${esc(fmtTime(job.scheduled_time) || 'Any time')}</span>
        <span class="tag ${job.job_type}" title="${esc(t.title)}">${t.icon} ${esc(t.name)}</span>
        ${statusTag}
        ${job.paper_wo ? `<span class="muted small" title="Paper work order #">W.O. ${esc(job.paper_wo)}</span>` : ''}
      </div>
      <div class="job-title">${esc(cargo(job) || job.customer || '(no details)')}</div>
      <div class="job-route">
        ${t.from && job.from_location ? `<div><b>From</b> ${esc(job.from_location)}</div>` : ''}
        ${siteAddress(job) ? `<div><b>${job.job_type === 'float' ? 'To' : 'At'}</b> ${esc(siteAddress(job))}</div>` : ''}
      </div>
      <div class="job-meta">${[job.customer && 'Customer: ' + esc(job.customer + (job.customer_phone ? ' ' + prettyPhone(job.customer_phone) : '')), job.contact_name && 'Site: ' + esc(job.contact_name + ' ' + prettyPhone(job.contact_phone))].filter(Boolean).join(' · ')}</div>
      ${job.quoted_price || job.payment_method || job.assignments.some((a) => Object.keys(a.report || {}).length) ? `<div class="tickets-row">
        ${job.quoted_price || job.payment_method ? `<span class="chip collect" title="Office only">💲 ${esc([job.quoted_price, job.payment_method].filter(Boolean).join(' · '))}</span>` : ''}
        ${job.assignments.filter((a) => Object.keys(a.report || {}).length).map((a) => `<span class="chip report" data-act="print" data-job="${job.id}" title="Open the work order with the driver's report">📋 Report from ${esc(a.driver_name.split(' ')[0])}</span>`).join('')}
      </div>` : ''}
      ${job.notes ? `<div class="job-notes">${esc(job.notes)}</div>` : ''}
      ${progress}
      ${job.tickets.length ? `<div class="tickets-row">
        <span class="lbl" data-act="tickets" data-job="${job.id}">🧾 ${job.tickets.length} ticket${job.tickets.length === 1 ? '' : 's'}</span>
        ${job.tickets.slice(-6).map((t) => `<img src="/api/tickets/${t.id}/image" alt="" loading="lazy" data-act="tickets" data-job="${job.id}">`).join('')}
      </div>` : ''}
      <div class="assignments">${rows || '<div class="asg muted">No driver assigned</div>'}</div>
      <div class="job-actions">
        ${job.status === 'cancelled' ? `<button class="btn" data-act="reopen" data-job="${job.id}">Re-open</button>` : `
          ${toSend ? `<button class="btn warn" data-act="send" data-job="${job.id}">📱 Text ${toSend} driver${toSend > 1 ? 's' : ''}</button>` : ''}
          <button class="btn" data-act="edit" data-job="${job.id}">Edit</button>
          <button class="btn" data-act="print" data-job="${job.id}" title="Printable work order">🖨 Print</button>
          <button class="btn" data-act="dup" data-job="${job.id}">Copy to…</button>
          ${job.job_type === 'toilet' || job.job_type === 'bin' ? `<button class="btn" data-act="pickup" data-job="${job.id}">Book pick-up</button>` : ''}
          ${job.status === 'open' ? `<button class="btn" data-act="complete" data-job="${job.id}">Mark complete</button>`
            : `<button class="btn" data-act="reopen" data-job="${job.id}">Re-open</button>`}
          <div class="spacer"></div>
          ${active.some((a) => a.status !== 'pending')
            ? `<button class="btn danger" data-act="cancel" data-job="${job.id}">Cancel job</button>`
            : `<button class="btn danger" data-act="delete" data-job="${job.id}">Delete</button>`}`}
      </div>
    </article>`;
  }

  function reportSend(out) {
    const failed = (out.results || []).filter((r) => !r.ok);
    if (failed.length) toast(`Text failed for ${failed.map((r) => r.driver).join(', ')}: ${failed[0].error}`);
    else if ((out.results || []).length) toast(`Texted ${out.results.map((r) => r.driver).join(', ')}`);
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const jobId = el.dataset.job;
    try {
      if (act === 'new') openJobForm();
      if (act === 'edit') openJobForm(await api('/jobs/' + jobId));
      if (act === 'send') reportSend(await api(`/jobs/${jobId}/send`, { method: 'POST', body: {} }));
      if (act === 'resend') reportSend(await api(`/jobs/${jobId}/send`, { method: 'POST', body: { assignment_id: Number(el.dataset.asg) } }));
      if (act === 'mark') await api(`/assignments/${el.dataset.token}/${el.dataset.mark}`, { method: 'POST', body: {} });
      if (act === 'copylink') {
        await navigator.clipboard.writeText(`${location.origin}/j/${el.dataset.token}`);
        toast('Link copied');
      }
      if (act === 'complete') await api(`/jobs/${jobId}/status`, { method: 'POST', body: { status: 'complete' } });
      if (act === 'reopen') await api(`/jobs/${jobId}/status`, { method: 'POST', body: { status: 'open' } });
      if (act === 'cancel') {
        if (!confirm(`Cancel job #${jobId}? Drivers who were texted will get a cancellation text.`)) return;
        await api(`/jobs/${jobId}/cancel`, { method: 'POST', body: {} });
        toast(`Job #${jobId} cancelled`);
      }
      if (act === 'delete') {
        if (!confirm(`Delete job #${jobId}? Nobody has been texted yet.`)) return;
        await api(`/jobs/${jobId}`, { method: 'DELETE' });
      }
      if (act === 'dup') {
        const date = prompt('Copy this job (same drivers) to which date? YYYY-MM-DD', addDays(state.date, 1));
        if (!date) return;
        const job = await api(`/jobs/${jobId}/duplicate`, { method: 'POST', body: { date } });
        toast(`Copied to job #${job.id} on ${longDate(date)} — not texted yet`);
      }
      if (act === 'seen') await api('/messages/seen', { method: 'POST', body: { ids: [Number(el.dataset.id)] } });
      if (act === 'tickets') return openTickets(Number(jobId));
      if (act === 'print') return window.open('/print/' + jobId, '_blank');
      if (act === 'pickup') {
        const job = state.board.jobs.find((j) => j.id === Number(jobId));
        const date = prompt('Pick-up date? YYYY-MM-DD', job?.details?.pickup_date || addDays(state.date, 7));
        if (!date) return;
        const p = await api(`/jobs/${jobId}/pickup`, { method: 'POST', body: { date } });
        toast(`Pick-up booked as job #${p.id} on ${longDate(date)} — assign a driver there`);
      }
      if (act === 'attach-ticket') {
        const driverId = Number(el.dataset.driver);
        const mine = state.board.jobs.filter((j) => j.assignments.some((a) => a.driver_id === driverId)).map((j) => j.id);
        const id = prompt(`Attach this photo to which job number?${mine.length ? ` (This driver is on #${mine.join(', #')} today)` : ''}`, mine[0] || '');
        if (!id) return;
        await api(`/tickets/${el.dataset.id}/attach`, { method: 'POST', body: { job_id: Number(id) } });
        toast(`Attached to job #${id}`);
      }
      if (act === 'delete-ticket') {
        if (!confirm('Delete this photo?')) return;
        await api(`/tickets/${el.dataset.id}`, { method: 'DELETE' });
        if ($('#ticket-dialog').open) { await loadBoard(); return openTickets(Number(el.dataset.job)); }
      }
      if (act !== 'new' && act !== 'edit' && act !== 'copylink') {
        el.closest('details')?.removeAttribute('open');
        await loadBoard();
      }
    } catch (err) {
      toast(err.message);
    }
  });

  $$('[data-day]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.day);
    state.date = n === 0 ? state.today : addDays(state.date, n);
    loadBoard();
  }));
  $('#board-date').addEventListener('change', (e) => { if (e.target.value) { state.date = e.target.value; loadBoard(); } });
  $('#new-job').addEventListener('click', () => openJobForm());

  $('#send-lineup').addEventListener('click', async () => {
    const lu = state.board.lineup;
    const when = state.date === addDays(state.today, 1) ? 'tomorrow' : longDate(state.date);
    const again = lu.sent ? `\n\nThey were already sent their day ${fmtStamp(lu.last_sent_at)}. This sends it again to everyone.` : '';
    if (!confirm(`Text ${lu.drivers} driver${lu.drivers === 1 ? '' : 's'} a list of all their jobs for ${when}?${again}`)) return;
    try {
      const out = await api('/lineup/send', { method: 'POST', body: { date: state.date } });
      const failed = out.results.filter((r) => !r.ok);
      toast(failed.length ? `Failed for ${failed.map((r) => r.driver).join(', ')}` : `Texted ${out.results.length} driver${out.results.length === 1 ? '' : 's'} their day`);
      loadBoard();
    } catch (err) { toast(err.message); }
  });

  // ---------- ticket photos ----------
  function openTickets(jobId) {
    const job = state.board.jobs.find((j) => j.id === jobId);
    if (!job) return;
    $('#ticket-title').textContent = `Job #${job.id} — scale tickets (${job.tickets.length})`;
    $('#ticket-list').innerHTML = job.tickets.map((t) => `
      <figure>
        <a href="/api/tickets/${t.id}/image" target="_blank"><img src="/api/tickets/${t.id}/image" alt="Ticket photo"></a>
        <figcaption><span>${esc(t.driver_name || '')} · ${esc(fmtStamp(t.created_at))}${t.source === 'sms' ? ' · texted' : ''}</span>
          <button class="btn tiny danger" data-act="delete-ticket" data-id="${t.id}" data-job="${job.id}">Delete</button></figcaption>
      </figure>`).join('') || '<p class="muted">No tickets.</p>';
    if (!$('#ticket-dialog').open) $('#ticket-dialog').showModal();
  }
  $('[data-close-tickets]').addEventListener('click', () => $('#ticket-dialog').close());

  // ---------- job form ----------
  const dialog = $('#job-dialog');
  const form = $('#job-form');

  async function fillSuggestions() {
    const s = await api('/suggestions');
    const opts = (list) => [...new Set(list)].map((v) => `<option value="${esc(v)}">`).join('');
    $('#dl-customers').innerHTML = opts(s.customers);
    state.suggest = s;
    $('#dl-locations').innerHTML = opts(s.locations);
    $('#dl-units').innerHTML = opts([...s.units, ...UNITS]);
    $('#dl-municipalities').innerHTML = opts([...s.municipalities, 'Parry Sound', 'McDougall', 'Seguin', 'Carling', 'McKellar',
      'Ahmic Harbour', 'Magnetawan', 'Whitestone', 'Archipelago', 'The Archipelago', 'Nobel', 'Rosseau', 'Sundridge', 'Burk\'s Falls']);
    $('#dl-toilets').innerHTML = opts(window.FORMS.TOILET_TYPES);
    fillWhatList(currentType());
  }

  function currentType() {
    return $('input[name=job_type]:checked', form)?.value || 'haul';
  }

  function fillWhatList(type) {
    const t = typeInfo(type);
    const past = state.suggest?.materialsByType?.[type] || [];
    $('#dl-what').innerHTML = [...new Set([...past, ...(t.whatSuggestions || [])])].map((v) => `<option value="${esc(v)}">`).join('');
  }

  // Type buttons and payment methods come from forms.js.
  $('#job-type').innerHTML = TYPE_KEYS.map((k) =>
    `<label title="${esc(TYPES[k].title)}"><input type="radio" name="job_type" value="${k}"><span>${TYPES[k].icon} ${esc(TYPES[k].name)}</span></label>`).join('');
  form.elements.payment_method.innerHTML = '<option value="">—</option>' +
    window.FORMS.PAYMENT_METHODS.map((m) => `<option>${esc(m)}</option>`).join('');

  /** The type-specific part of the form (bin service, septic tank details, toilet types…). */
  function renderTypeFields(type, values = {}) {
    const t = typeInfo(type);
    const html = (f) => {
      const name = 'd.' + f.key;
      const v = values[f.key] ?? '';
      if (f.kind === 'choice') {
        return `<div class="choice-row"><span class="cl">${esc(f.label)}</span>${f.options.map((o) =>
          `<label class="pill"><input type="radio" name="${name}" value="${esc(o)}" ${v === o ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`;
      }
      if (f.kind === 'textarea') {
        return `<label class="wide">${esc(f.label)}<textarea name="${name}" rows="2">${esc(v)}</textarea></label>`;
      }
      const type = f.kind === 'date' ? 'date' : f.kind === 'number' ? 'number' : 'text';
      const list = f.suggestions === 'toilets' ? 'list="dl-toilets"' : f.suggestions === 'what' ? 'list="dl-what"' : '';
      const cls = f.wide ? 'wide' : f.suggestions === 'toilets' ? 'span2' : '';
      return `<label class="${cls}">${esc(f.label)}<input type="${type}" name="${name}" value="${esc(v)}" ${list} ${type === 'number' ? 'min="0"' : ''}></label>`;
    };
    $('#type-fields-top').innerHTML = t.fields.filter((f) => f.top).map(html).join('');
    $('#type-fields').innerHTML = t.fields.filter((f) => !f.top).map(html).join('');
  }

  // Click a selected pill again to clear it.
  form.addEventListener('pointerdown', (e) => {
    const input = e.target.closest('.pill')?.querySelector('input');
    if (input) input.dataset.was = input.checked ? '1' : '';
  });
  form.addEventListener('click', (e) => {
    const input = e.target.matches('.pill input') ? e.target : null;
    if (input && input.dataset.was === '1') { input.checked = false; input.dataset.was = ''; }
  });

  function collectDetails() {
    const out = {};
    for (const el of $$('#type-fields [name], #type-fields-top [name]')) {
      const key = el.name.slice(2);
      if (el.type === 'radio') { if (el.checked) out[key] = el.value; } else if (el.value.trim()) out[key] = el.value.trim();
    }
    return out;
  }

  function applyType(type, details) {
    const t = typeInfo(type);
    $('#form-title').textContent = t.title;
    $('[data-label=what]', form).textContent = t.what || '';
    $('[data-label=from]', form).textContent = t.from || 'From';
    $('[data-label=to]', form).textContent = t.to;
    $('[data-label=date]', form).textContent = type === 'septic' ? 'Pump-out date' : 'Delivery date';
    $('[data-label=loads]', form).textContent = t.loadsLabel || 'Number of loads';
    $('[data-label=qty]', form).textContent = t.quantityLabel || 'Quantity';
    const show = { ...t, unit: t.quantity && !t.fixedUnit };
    $$('[data-when]', form).forEach((el) => el.classList.toggle('hidden', !show[el.dataset.when]));
    // Aggregates: type, loads and yards on one line, like the paper form.
    $('[data-when=what]', form).classList.toggle('wide', !t.fixedUnit);
    // Keep what was typed in the type-specific fields when switching back and forth.
    renderTypeFields(type, details || collectDetails());
    fillWhatList(type);
    // Put drivers whose usual truck matches this job type first.
    renderAssignList(type);
  }
  $('#job-type').addEventListener('change', (e) => { if (e.target.name === 'job_type') applyType(e.target.value); });

  let formAssignments = new Map(); // driver_id -> truck_id
  let busyByDriver = new Map();

  function truckOptions(selected) {
    return '<option value="">Truck…</option>' + state.trucks.map((t) =>
      `<option value="${t.id}" ${Number(selected) === t.id ? 'selected' : ''}>${esc(t.unit)}</option>`).join('');
  }

  function renderAssignList(type) {
    const truckKind = new Map(state.trucks.map((t) => [t.id, t.kind]));
    const drivers = [...state.drivers].sort((a, b) => {
      const ka = truckKind.get(a.default_truck_id) === type ? 0 : 1;
      const kb = truckKind.get(b.default_truck_id) === type ? 0 : 1;
      return ka - kb || a.name.localeCompare(b.name);
    });
    $('#assign-list').innerHTML = drivers.map((d) => {
      const on = formAssignments.has(d.id);
      const busy = busyByDriver.get(d.id);
      return `<div class="assign ${on ? 'on' : ''}" data-driver="${d.id}">
        <input type="checkbox" ${on ? 'checked' : ''} id="as-${d.id}">
        <label class="nm" for="as-${d.id}">${esc(d.name)}${busy ? `<span class="busy">Also on ${busy}</span>` : ''}</label>
        <select>${truckOptions(on ? formAssignments.get(d.id) : d.default_truck_id)}</select>
      </div>`;
    }).join('') || '<p class="muted">No drivers yet — add them on the Setup tab.</p>';
  }

  $('#assign-list').addEventListener('change', (e) => {
    const row = e.target.closest('.assign');
    if (!row) return;
    const id = Number(row.dataset.driver);
    const cb = $('input', row);
    const truck = $('select', row).value || null;
    if (e.target.tagName === 'SELECT' && !cb.checked) cb.checked = true;
    if (cb.checked) formAssignments.set(id, truck ? Number(truck) : null);
    else formAssignments.delete(id);
    row.classList.toggle('on', cb.checked);
  });

  async function computeBusy(date, jobId) {
    busyByDriver = new Map();
    const jobs = await api('/jobs?from=' + date);
    for (const j of jobs) {
      if (j.id === Number(jobId) || j.status === 'cancelled') continue;
      for (const a of j.assignments) {
        const label = `#${j.id}${j.scheduled_time ? ' ' + fmtTime(j.scheduled_time) : ''}`;
        busyByDriver.set(a.driver_id, busyByDriver.has(a.driver_id) ? busyByDriver.get(a.driver_id) + ', ' + label : label);
      }
    }
  }

  async function openJobForm(job = null) {
    form.reset();
    $('#job-form-error').textContent = '';
    if (!state.drivers.length || !state.trucks.length) await loadBoard();
    fillSuggestions().catch(() => {});
    const data = job || { job_type: 'haul', scheduled_date: state.date, assignments: [] };
    $('#job-form-title').textContent = job ? `Edit job #${job.id}` : 'New job';
    for (const [k, v] of Object.entries(data)) {
      const input = form.elements[k];
      if (!input || k === 'job_type' || k === 'details' || !('value' in input)) continue;
      input.value = v ?? '';
    }
    if (data.contact_phone) form.elements.contact_phone.value = prettyPhone(data.contact_phone);
    if (data.customer_phone) form.elements.customer_phone.value = prettyPhone(data.customer_phone);
    $$('input[name=job_type]', form).forEach((r) => { r.checked = r.value === data.job_type; });
    formAssignments = new Map(data.assignments.map((a) => [a.driver_id, a.truck_id]));
    await computeBusy(data.scheduled_date, data.id);
    applyType(data.job_type, data.details || {});
    dialog.showModal();
  }

  form.elements.scheduled_date.addEventListener('change', async (e) => {
    await computeBusy(e.target.value, form.elements.id.value);
    renderAssignList(currentType());
  });

  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => dialog.close()));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sendNow = e.submitter?.value === 'send';
    const fd = new FormData(form);
    const body = Object.fromEntries([...fd.entries()].filter(([k]) => !k.startsWith('d.')));
    body.details = collectDetails();
    body.assignments = [...formAssignments].map(([driver_id, truck_id]) => ({ driver_id, truck_id }));
    body.send_now = sendNow;
    if (sendNow && !body.assignments.length) {
      $('#job-form-error').textContent = 'Tick at least one driver to text.';
      return;
    }
    try {
      const id = body.id;
      const out = await api(id ? '/jobs/' + id : '/jobs', { method: id ? 'PUT' : 'POST', body });
      dialog.close();
      if (sendNow) reportSend(out);
      else toast(`Job #${out.job.id} saved${out.job.assignments.length ? ' — drivers NOT texted yet' : ''}`);
      if (out.job.scheduled_date !== state.date) state.date = out.job.scheduled_date;
      loadBoard();
    } catch (err) {
      $('#job-form-error').textContent = err.message;
    }
  });

  // ---------- drivers & trucks ----------
  const KIND = window.FORMS.TRUCK_KINDS;
  $('#truck-kind').innerHTML = Object.entries(KIND).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

  async function loadPeople() {
    const [drivers, trucks, settings] = await Promise.all([api('/drivers?all=1'), api('/trucks?all=1'), api('/settings')]);
    const sf = $('#settings-form');
    sf.elements.lineup_on.checked = Boolean(settings.lineup_time);
    sf.elements.lineup_time.value = settings.lineup_time || '17:00';
    const truckSel = $('#driver-form select[name=default_truck_id]');
    truckSel.innerHTML = '<option value="">Usual truck…</option>' + trucks.filter((t) => t.active).map((t) => `<option value="${t.id}">${esc(t.unit)} – ${esc(KIND[t.kind])}</option>`).join('');
    $('#driver-rows').innerHTML = drivers.map((d) => `
      <tr class="${d.active ? '' : 'inactive'}"><td>${esc(d.name)}${d.active ? '' : ' (inactive)'}</td><td>${esc(prettyPhone(d.phone))}</td>
      <td>${esc(d.default_truck_unit || '')}</td>
      <td><button class="btn tiny" data-edit-driver='${esc(JSON.stringify(d))}'>Edit</button></td></tr>`).join('');
    $('#truck-rows').innerHTML = trucks.map((t) => `
      <tr class="${t.active ? '' : 'inactive'}"><td>${esc(t.unit)}${t.active ? '' : ' (inactive)'}</td><td>${esc(KIND[t.kind])}</td><td>${esc(t.description)}</td>
      <td><button class="btn tiny" data-edit-truck='${esc(JSON.stringify(t))}'>Edit</button></td></tr>`).join('');
  }

  function fillForm(f, obj) {
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') el.checked = Boolean(obj[el.name]);
      else el.value = el.name === 'phone' ? prettyPhone(obj.phone) : obj[el.name] ?? '';
    }
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('#tab-people').addEventListener('click', (e) => {
    const d = e.target.closest('[data-edit-driver]');
    if (d) fillForm($('#driver-form'), JSON.parse(d.dataset.editDriver));
    const t = e.target.closest('[data-edit-truck]');
    if (t) fillForm($('#truck-form'), JSON.parse(t.dataset.editTruck));
  });

  for (const [formId, path] of [['#driver-form', '/drivers'], ['#truck-form', '/trucks']]) {
    $(formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      body.active = e.target.elements.active.checked;
      try {
        await api(path, { method: 'POST', body });
        e.target.reset();
        e.target.elements.id.value = '';
        toast('Saved');
        loadPeople();
      } catch (err) { toast(err.message); }
    });
    $(formId).addEventListener('reset', (e) => setTimeout(() => { e.target.elements.id.value = ''; }));
  }

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      const out = await api('/settings', { method: 'POST', body: { lineup_time: f.lineup_on.checked ? f.lineup_time.value : '' } });
      toast(out.lineup_time ? `Drivers will get tomorrow's jobs at ${fmtTime(out.lineup_time)} each day` : 'Evening text turned off');
    } catch (err) { toast(err.message); }
  });

  // ---------- messages ----------
  async function loadMessages() {
    const msgs = await api('/messages');
    $('#message-list').innerHTML = msgs.map((m) => `
      <div class="msg ${m.direction} ${m.handled ? '' : 'unhandled'}">
        <div class="muted">${esc(fmtStamp(m.created_at))}</div>
        <div><span class="dir">${m.direction === 'in' ? '⬅ FROM' : '➡ TO'}</span><br>${esc(m.driver_name || prettyPhone(m.phone))}</div>
        <div class="body">${esc(m.body)}${m.error ? `<div class="err">Failed: ${esc(m.error)}</div>` : ''}</div>
      </div>`).join('') || '<p class="muted">No texts yet.</p>';
    const unseen = msgs.filter((m) => m.direction === 'in' && !m.handled && !m.seen).map((m) => m.id);
    if (unseen.length) api('/messages/seen', { method: 'POST', body: { ids: unseen } }).catch(() => {});
    if (!state.smsEnabled) {
      $('#simulate').classList.remove('hidden');
      const drivers = await api('/drivers');
      $('#sim-driver').innerHTML = drivers.map((d) => `<option value="${esc(d.phone)}">${esc(d.name)}</option>`).join('');
    }
  }

  $('#simulate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      const out = await api('/simulate-reply', { method: 'POST', body });
      $('#sim-result').textContent = out.reply ? `Auto-reply: "${out.reply}"` : 'No auto-reply (flagged for office if not understood)';
      e.target.elements.body.value = '';
      loadMessages();
    } catch (err) { toast(err.message); }
  });

  // ---------- start ----------
  $('#logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  });

  (async () => {
    const me = await api('/me');
    state.today = state.date = me.today;
    state.smsEnabled = me.smsEnabled;
    $('#user-name').textContent = me.user.name;
    $('#test-mode').classList.toggle('hidden', me.smsEnabled);
    await loadBoard();
    // Keep the board fresh so driver confirmations show up without reloading.
    setInterval(() => {
      if (document.hidden || dialog.open || $('#ticket-dialog').open) return;
      if (state.tab === 'board' && !document.querySelector('details[open]')) loadBoard().catch(() => {});
      if (state.tab === 'messages') loadMessages().catch(() => {});
    }, 15000);
  })();
})();
