/* ❄ Snow call: phone every shoveler at their own call-ahead time, see who's coming. Uses app.js (window.APP). */
(function () {
  const A = window.APP;
  if (!A) return;
  const { api, esc, toast, prettyPhone } = A;
  let root = null;
  let data = null;
  let timer = null;
  let confirmStart = false;
  let editing = null; // shoveler id being edited

  const TZ = 'America/Toronto';
  const dueText = (sql) => {
    if (!sql) return '';
    const d = new Date(sql.replace(' ', 'T') + 'Z');
    const today = new Date().toDateString() === d.toDateString();
    return today ? localTime(sql) : d.toLocaleString('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const localTime = (sql) => (sql ? new Date(sql.replace(' ', 'T') + 'Z').toLocaleTimeString('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '');
  const dateLong = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const STATUS = {
    waiting: ['Waiting', ''], calling: ['Ringing…', 'blue'], no_answer_retry: ['No answer, trying again', 'warn'], coming: ['Coming ✓', 'ok'],
    not_coming: ["Can't come", 'bad'], no_answer: ['No answer', 'bad'], failed: ["Couldn't call", 'bad'], cancelled: ['Cancelled', ''],
  };
  const AHEAD = [15, 20, 30, 45, 60, 75, 90, 120];
  const sayHm = (hm) => { const [h, m] = String(hm).split(':').map(Number); return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };

  /** The next time the clock reads `hm` (today if that's still ahead, else tomorrow), as date + time inputs. */
  const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function nextStart(hm = '04:00') {
    const local = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
    const [h, m] = hm.split(':').map(Number);
    if (local.getHours() * 60 + local.getMinutes() >= h * 60 + m) local.setDate(local.getDate() + 1);
    return { day: ymdOf(local), time: hm };
  }
  let dateTouched = false; // the date box follows the time until someone changes the date by hand
  const at = (day, hm) => new Date(`${day}T${hm}:00`); // the office's own clock (Parry Sound)
  const whenText = (d) => d.toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function fromNow(d) {
    const min = Math.round((d - Date.now()) / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `in ${min} min`;
    const h = Math.floor(min / 60);
    return `in ${h} hour${h === 1 ? '' : 's'}${min % 60 ? ` ${min % 60} min` : ''}`;
  }
  const minus = (hm, min) => { const [h, m] = hm.split(':').map(Number); const t = ((h * 60 + m - min) % 1440 + 1440) % 1440; const hh = Math.floor(t / 60); return `${((hh + 11) % 12) + 1}:${String(t % 60).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };

  async function mount(el) {
    root = el;
    await load();
    clearInterval(timer);
    timer = setInterval(() => { if (A.state.tab === 'snow' && !document.hidden && data?.current) load().catch(() => {}); }, 10000);
  }
  async function load() {
    data = await api('/snow');
    render();
  }

  function render() {
    root.innerHTML = `<div class="snow-page">
      ${data.current ? running(data.current) : startForm()}
      ${shovelers()}
      ${data.recent.length ? `<div class="panel"><h3>Recent call-outs</h3><ul class="snow-recent">${data.recent.map((r) => `<li>${esc(dateLong(r.day))}, start ${esc(sayHm(r.start_time))} at ${esc(r.place)} · <span class="muted">${esc(r.status)}</span></li>`).join('')}</ul></div>` : ''}
    </div>`;
  }

  function startForm() {
    const n = nextStart();
    dateTouched = false;
    const people = data.shovelers.filter((s) => s.active);
    return `<div class="panel snow-start">
      <h2>❄ Snow call</h2>
      <p class="muted">Every shoveler is phoned at their own call-ahead time before the start, and texted the details. They press 1 (coming) or 2 (can't), or text back. No answer: called again 5 minutes later, up to 3 times.</p>
      <form id="snow-form" class="snow-form">
        <label>Start <input type="date" name="day" value="${n.day}" required> <input type="time" name="time" value="${n.time}" required aria-label="Start time"></label>
        <label>Where to report <input name="place" value="the yard, 116 William St" maxlength="120"></label>
        <label class="wide">Note for the call (optional) <input name="note" placeholder="e.g. Bring your own shovel. Downtown route first." maxlength="160"></label>
        <div class="field-col"><span class="lbl">When to call</span>
          <label class="check"><input type="radio" name="mode" value="ahead" checked> At each person's call-ahead time</label>
          <label class="check"><input type="radio" name="mode" value="now"> Everyone now</label></div>
        <label class="wide">Text me who's coming when it's done <textarea name="notify" rows="1" placeholder="Your cell, e.g. 705-555-0100">${esc((data.notify || []).map(prettyPhone).join('\n'))}</textarea></label>
        <div class="snow-preview" id="snow-preview">${preview(people, n.day, n.time, 'ahead')}</div>
        <button class="btn primary big" type="submit" ${people.length ? '' : 'disabled'}>Start snow call</button>
        ${people.length ? '' : '<p class="muted small">Add the shovelers below first.</p>'}
      </form>
    </div>`;
  }
  /** When the first call goes out (a Date), for the preview and the confirm button. */
  function firstCall(people, day, time, mode) {
    if (mode === 'now' || !people.length) return new Date();
    const start = at(day, time);
    return new Date(Math.max(Date.now(), start - Math.max(...people.map((s) => s.call_ahead_min)) * 60000));
  }
  function preview(people, day, time, mode) {
    if (!people.length || !day || !time) return '';
    const start = at(day, time);
    const first = firstCall(people, day, time, mode);
    const late = start - Date.now() > 20 * 3600 * 1000;
    const past = start < Date.now();
    return `<div class="snow-when ${late || past ? 'warn' : ''}"><b>Start: ${esc(whenText(start))}</b> (${esc(fromNow(start))}).
        First call ${mode === 'now' ? '<b>right away</b>' : `<b>${esc(whenText(first))}</b> (${esc(fromNow(first))})`}.
        ${late ? '<br>⚠ That\'s more than 20 hours away: check the date.' : past ? '<br>⚠ That time has already passed: check the date.' : ''}</div>
      <span class="lbl">Who gets called when</span><ul>${people.map((s) => `<li><b>${esc(s.name)}</b> <span class="muted">${mode === 'now' ? 'right away'
        : `${esc(whenText(new Date(Math.max(Date.now(), start - s.call_ahead_min * 60000))))} (${s.call_ahead_min} min ahead)`}</span></li>`).join('')}</ul>`;
  }

  function running(c) {
    const pill = (s) => { const [t, k] = STATUS[s] || [s, '']; return `<span class="snow-pill ${k}">${esc(t)}</span>`; };
    return `<div class="panel snow-running">
      <div class="snow-head"><div><h2>❄ Snow call: start ${esc(c.say)}, ${esc(dateLong(c.day))}</h2><div class="muted">At ${esc(c.place)}${c.note ? ` · ${esc(c.note)}` : ''} · started by ${esc(c.created_by || '')}</div></div>
        ${c.status === 'running' ? '<button class="btn danger" data-snow="cancel">Cancel the call-out</button>' : ''}</div>
      ${c.live ? '' : '<div class="note-warn">Test mode: nobody is really phoned (Twilio isn\'t set up). Mark the answers below to try it.</div>'}
      <div class="sum-tiles">
        <div class="sum-tile"><span>Coming</span><b>${c.counts.coming || 0}</b></div>
        <div class="sum-tile"><span>Can't come</span><b>${c.counts.not_coming || 0}</b></div>
        <div class="sum-tile"><span>Still to answer</span><b>${(c.counts.waiting || 0) + (c.counts.calling || 0) + (c.counts.no_answer_retry || 0)}</b></div>
        <div class="sum-tile"><span>No answer</span><b>${(c.counts.no_answer || 0) + (c.counts.failed || 0)}</b></div>
      </div>
      <table class="table snow-table"><thead><tr><th>Shoveler</th><th>Called at</th><th>Status</th><th>Calls</th><th></th></tr></thead><tbody>
      ${c.people.map((p) => `<tr><td><b>${esc(p.name)}</b><div class="muted small">${esc(prettyPhone(p.phone))}</div></td>
        <td>${esc(dueText(p.due_at))}</td><td>${pill(p.status)}${p.via ? ` <span class="muted small">by ${esc(p.via)}</span>` : ''}</td><td>${p.attempts}</td>
        <td><div class="snow-acts">${['coming', 'not_coming', 'cancelled'].includes(p.status) || c.status !== 'running' ? '' : `<button class="btn tiny" data-snow="call_now" data-id="${p.id}">Call now</button>`}
          ${c.status === 'running' && p.status !== 'coming' ? `<button class="btn tiny" data-snow="coming" data-id="${p.id}" title="They told you another way">Coming</button>` : ''}
          ${c.status === 'running' && p.status !== 'not_coming' ? `<button class="btn tiny" data-snow="not_coming" data-id="${p.id}">Can't</button>` : ''}</div></td></tr>`).join('')}
      </tbody></table>
      <p class="muted small">This page updates by itself. When everyone has answered (or been tried 3 times), who's coming is texted to ${c.notify.length ? esc(c.notify.map(prettyPhone).join(', ')) : 'nobody (no number was given)'}.</p>
    </div>`;
  }

  function shovelers() {
    const row = (s) => editing === s.id ? `<tr><td colspan="5">${shovelerForm(s)}</td></tr>`
      : `<tr class="${s.active ? '' : 'inactive'}"><td><b>${esc(s.name)}</b></td><td>${esc(prettyPhone(s.phone))}</td><td>${s.call_ahead_min} min</td>
        <td>${s.active ? '' : '<span class="muted">not called</span>'}</td><td><button class="btn tiny" data-snow-edit="${s.id}">Edit</button></td></tr>`;
    return `<div class="panel"><h3>Shovelers</h3>
      <p class="muted small"><b>Call-ahead</b> is how long before the start each person needs to be called (to wake up and drive in).</p>
      <table class="table compact"><thead><tr><th>Name</th><th>Cell</th><th>Call-ahead</th><th></th><th></th></tr></thead>
        <tbody>${data.shovelers.map(row).join('') || '<tr><td colspan="5" class="muted">No shovelers yet.</td></tr>'}</tbody></table>
      ${editing === 'new' ? shovelerForm(null) : '<button class="btn" data-snow-edit="new">+ Add shoveler</button>'}
    </div>`;
  }
  function shovelerForm(s) {
    const ahead = s?.call_ahead_min ?? 30;
    const opts = [...new Set([...AHEAD, ahead])].sort((a, b) => a - b);
    return `<form class="inline-form snow-shoveler" data-id="${s?.id || ''}">
      <input name="name" placeholder="Name" value="${esc(s?.name || '')}" required aria-label="Name">
      <input name="phone" placeholder="Cell, e.g. 705-555-0123" value="${esc(s ? prettyPhone(s.phone) : '')}" required aria-label="Cell number">
      <select name="call_ahead_min" aria-label="Call-ahead">${opts.map((m) => `<option value="${m}" ${m === ahead ? 'selected' : ''}>${m} min ahead</option>`).join('')}</select>
      ${s ? `<label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Call them</label>` : ''}
      <button class="btn primary" type="submit">Save</button> <button class="btn" type="button" data-snow-edit="">Cancel</button></form>`;
  }

  document.addEventListener('click', async (e) => {
    if (!root || !root.contains(e.target)) return;
    const ed = e.target.closest('[data-snow-edit]');
    if (ed) { editing = ed.dataset.snowEdit === 'new' ? 'new' : ed.dataset.snowEdit ? Number(ed.dataset.snowEdit) : null; return render(); }
    const b = e.target.closest('[data-snow]');
    if (!b) return;
    try {
      if (b.dataset.snow === 'cancel') {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to cancel'; return; }
        await api(`/snow/${data.current.id}/cancel`, { method: 'POST' });
        toast('Call-out cancelled. Anyone not yet called won\'t be.');
      } else {
        await api(`/snow/people/${b.dataset.id}`, { method: 'POST', body: { action: b.dataset.snow } });
      }
      await load();
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('input', (e) => {
    if (!root || !e.target.closest('#snow-form')) return;
    const f = e.target.closest('#snow-form').elements;
    if (e.target.name === 'day') dateTouched = true;
    // Changing the time moves the date to the next time the clock reads it (unless the date was set by hand).
    if (e.target.name === 'time' && !dateTouched && f.time.value) f.day.value = nextStart(f.time.value).day;
    const el = document.getElementById('snow-preview');
    if (el) el.innerHTML = preview(data.shovelers.filter((s) => s.active), f.day.value, f.time.value, f.mode.value);
    if (confirmStart) { confirmStart = false; const btn = e.target.closest('#snow-form').querySelector('button[type=submit]'); if (btn) btn.textContent = 'Start snow call'; }
  });
  document.addEventListener('change', (e) => { if (root && e.target.closest('#snow-form') && e.target.name === 'mode') e.target.dispatchEvent(new Event('input', { bubbles: true })); });
  document.addEventListener('submit', async (e) => {
    if (!root || !root.contains(e.target)) return;
    if (e.target.id === 'snow-form') {
      e.preventDefault();
      if (!confirmStart) {
        confirmStart = true;
        const people = data.shovelers.filter((x) => x.active);
        const f = e.target.elements;
        const first = firstCall(people, f.day.value, f.time.value, f.mode.value);
        e.target.querySelector('button[type=submit]').textContent = f.mode.value === 'now'
          ? `Tap again: phone all ${people.length} now`
          : `Tap again to start: first call ${whenText(first)}`;
        return;
      }
      confirmStart = false;
      const f = e.target.elements;
      try {
        await api('/snow/start', { method: 'POST', body: { day: f.day.value, time: f.time.value, place: f.place.value, note: f.note.value, mode: f.mode.value, notify: f.notify.value } });
        toast('Snow call started');
        await load();
      } catch (err) { toast(err.message); render(); }
      return;
    }
    if (e.target.matches('.snow-shoveler')) {
      e.preventDefault();
      const f = e.target.elements;
      try {
        await api('/snow/shovelers', { method: 'POST', body: { id: e.target.dataset.id || null, name: f.name.value, phone: f.phone.value,
          call_ahead_min: f.call_ahead_min.value, active: f.active ? f.active.checked : true } });
        editing = null;
        toast('Saved');
        await load();
      } catch (err) { toast(err.message); }
    }
  });

  window.SNOW_UI = { mount };
})();
