/* ❄ Snow call: phone every shoveler at their own call-ahead time and see who's coming. Uses app.js (window.APP).
   Three views: start a call-out (pick the time, who, where), the live board (Coming / Waiting / Can't), and the last
   results (they stay until the next call-out). Shovelers, the setup text and the call voice are below. */
(function () {
  const A = window.APP;
  if (!A) return;
  const { api, esc, toast, prettyPhone } = A;
  let root = null;
  let data = null;
  let timer = null;
  let editing = null; // shoveler id being edited, or 'new'
  const form = { day: '', time: '04:00', dayTouched: false, place: '', note: '', mode: 'ahead', pick: null, notify: '', confirm: false };

  const TZ = 'America/Toronto';
  const QUICK = ['04:00', '04:30', '05:00', '05:30', '06:00'];
  const AHEAD = [15, 20, 30, 45, 60, 75, 90, 120];
  const sayHm = (hm) => { const [h, m] = String(hm).split(':').map(Number); return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
  const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const localNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const todayYmd = () => ymdOf(localNow());
  const tomorrowYmd = () => { const d = localNow(); d.setDate(d.getDate() + 1); return ymdOf(d); };
  /** The next day the clock reads `hm`: today if that's still ahead, else tomorrow. */
  const nextDay = (hm) => { const n = localNow(); const [h, m] = hm.split(':').map(Number); return n.getHours() * 60 + n.getMinutes() < h * 60 + m ? todayYmd() : tomorrowYmd(); };
  const at = (day, hm) => new Date(`${day}T${hm}:00`);
  const clock = (d) => d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  const dayWord = (ymd) => (ymd === todayYmd() ? 'Today' : ymd === tomorrowYmd() ? 'Tomorrow' : new Date(ymd + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }));
  const whenText = (d) => `${dayWord(ymdOf(d))} ${clock(d)}`;
  const fromSql = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
  function fromNow(d) {
    const min = Math.round((d - Date.now()) / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `in ${min} min`;
    const h = Math.floor(min / 60);
    return `in ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  }
  const active = () => data.shovelers.filter((s) => s.active);
  const picked = () => (form.pick ? active().filter((s) => form.pick.has(s.id)) : active());

  async function mount(el) {
    root = el;
    await load();
    clearInterval(timer);
    timer = setInterval(() => { if (A.state.tab === 'snow' && !document.hidden && data?.current) load().catch(() => {}); }, 8000);
  }
  async function load() {
    data = await api('/snow');
    if (!form.day) { form.day = nextDay(form.time); form.place = data.place || 'the yard, 116 William St'; form.notify = (data.notify || []).map(prettyPhone).join(', '); }
    render();
  }

  // ---------- views ----------
  function render() {
    const keep = document.activeElement?.id;
    root.innerHTML = `<div class="snow-page">
      ${data.current ? live(data.current) : `${data.last ? results(data.last) : ''}${starter()}`}
      ${people()}
      ${A.state.can?.dispatch ? voiceBox() : ''}
    </div>`;
    if (keep) document.getElementById(keep)?.focus();
  }

  function columns(c) {
    const by = (list) => c.people.filter((p) => list.includes(p.status));
    const tile = (p, actions) => `<div class="sn-person"><div><b>${esc(p.name)}</b><span>${esc(p.detail)}</span></div>${actions ? `<div class="sn-acts">${actions}</div>` : ''}</div>`;
    const running = c.status === 'running';
    const btn = (p, act, label) => `<button class="btn tiny" data-snow="${act}" data-id="${p.id}">${label}</button>`;
    const coming = by(['coming']).map((p) => tile({ ...p, detail: p.via === 'office' ? 'marked by the office' : `answered by ${p.via}` },
      running ? btn(p, 'not_coming', "Can't") : ''));
    const waiting = by(['waiting', 'calling', 'no_answer_retry']).map((p) => {
      const due = fromSql(p.due_at);
      const detail = p.status === 'calling' ? '📞 Ringing now…' : p.status === 'no_answer_retry' ? `No answer, calling again ${fromNow(due)} (call ${p.attempts + 1} of 3)`
        : due > new Date() ? `Called ${whenText(due)} (${fromNow(due)})` : 'Calling…';
      return tile({ ...p, detail }, running ? `${btn(p, 'call_now', 'Call now')}${btn(p, 'coming', 'Coming')}${btn(p, 'not_coming', "Can't")}` : '');
    });
    const notComing = by(['not_coming', 'no_answer', 'failed', 'cancelled']).map((p) => tile({ ...p,
      detail: p.status === 'not_coming' ? `Can't come (${p.via})` : p.status === 'cancelled' ? 'Not called (cancelled)' : `No answer after ${p.attempts} call${p.attempts === 1 ? '' : 's'}` },
      running && p.status !== 'cancelled' ? `${btn(p, 'call_now', 'Try again')}${btn(p, 'coming', 'Coming')}` : ''));
    const col = (cls, icon, title, list, empty) => `<section class="sn-col ${cls}"><h3>${icon} ${title} <span>${list.length}</span></h3>${list.join('') || `<p class="muted">${empty}</p>`}</section>`;
    return `<div class="sn-cols">
      ${col('ok', '✅', 'Coming', coming, 'Nobody yet')}
      ${running || waiting.length ? col('wait', '⏳', 'Waiting', waiting, 'Everyone has answered') : ''}
      ${col('no', '❌', "Can't / no answer", notComing, 'Nobody')}
    </div>`;
  }

  function live(c) {
    const start = fromSql(c.start_at);
    const next = c.people.filter((p) => ['waiting', 'no_answer_retry'].includes(p.status)).map((p) => fromSql(p.due_at)).sort((a, b) => a - b)[0];
    const status = next && next > new Date() ? `Next call ${whenText(next)} (${fromNow(next)})` : c.people.some((p) => p.status === 'calling') ? 'Calling now' : 'Waiting for answers';
    return `<div class="sn-hero running">
      <div class="sn-hero-top"><div><div class="sn-kicker">❄ Snow call running</div>
        <h2>Start ${esc(sayHm(c.start_time))} · ${esc(dayWord(ymdOf(start)))}</h2>
        <div class="sn-sub">At ${esc(c.place)}${c.note ? ` · ${esc(c.note)}` : ''} · ${esc(status)}</div></div>
        <div class="sn-big"><b>${c.counts.coming || 0}</b><span>coming</span></div></div>
      ${c.live ? '' : '<div class="note-warn">Test mode: nobody is really phoned (Twilio isn\'t set up). Use the buttons to try it.</div>'}
      ${c.voice ? `<div class="muted small">Voice: ${esc(c.voice)}</div>` : ''}
    </div>
    ${columns(c)}
    <div class="sn-foot"><span class="muted small">This page updates by itself.${c.notify.length ? ` When everyone has answered, the results are texted to ${esc(c.notify.map(prettyPhone).join(', '))}.` : ''}</span>
      <button class="btn danger" data-snow="cancel">Cancel the call-out</button></div>`;
  }

  function results(c) {
    const start = fromSql(c.start_at);
    const recent = Date.now() - start < 18 * 3600 * 1000;
    return `<div class="sn-hero ${c.status === 'cancelled' ? 'cancelled' : 'done'}">
      <div class="sn-hero-top"><div><div class="sn-kicker">${c.status === 'cancelled' ? 'Last snow call (cancelled)' : 'Last snow call'}</div>
        <h2>Start ${esc(sayHm(c.start_time))} · ${esc(dayWord(ymdOf(start)))}</h2>
        <div class="sn-sub">At ${esc(c.place)}</div></div>
        <div class="sn-big"><b>${c.counts.coming || 0}</b><span>coming</span></div></div>
      <div class="sn-hero-foot"><button class="btn tiny outline" data-snow="clear" data-call="${c.id}">Clear the board</button></div>
    </div>
    ${recent ? columns(c) : ''}`;
  }

  function starter() {
    const ppl = active();
    const chosen = picked();
    const start = at(form.day, form.time);
    const firstCall = form.mode === 'now' || !chosen.length ? new Date() : new Date(Math.max(Date.now(), start - Math.max(...chosen.map((s) => s.call_ahead_min)) * 60000));
    const warn = start < Date.now() ? 'That time has already passed.' : start - Date.now() > 20 * 3600 * 1000 ? "That's more than 20 hours away: check the day." : '';
    const custom = !QUICK.includes(form.time);
    return `<div class="sn-card">
      <h2>❄ Start a snow call</h2>
      <div class="sn-step"><span class="sn-n">1</span><div class="sn-body"><div class="sn-q">When do they start?</div>
        <div class="sn-chips">${QUICK.map((t) => `<button type="button" class="sn-chip ${form.time === t ? 'on' : ''}" data-time="${t}">${sayHm(t)}</button>`).join('')}
          <label class="sn-chip other ${custom ? 'on' : ''}">Other <input type="time" id="sn-time" value="${esc(form.time)}" aria-label="Other start time"></label></div>
        <div class="sn-chips small">${[todayYmd(), tomorrowYmd()].map((d) => `<button type="button" class="sn-chip ${form.day === d ? 'on' : ''}" data-day="${d}">${dayWord(d)}</button>`).join('')}
          <label class="sn-chip other ${form.day !== todayYmd() && form.day !== tomorrowYmd() ? 'on' : ''}">Other day <input type="date" id="sn-day" value="${esc(form.day)}" aria-label="Other day"></label></div>
      </div></div>
      <div class="sn-step"><span class="sn-n">2</span><div class="sn-body"><div class="sn-q">Where?</div>
        <input class="sn-input" id="sn-place" value="${esc(form.place)}" maxlength="120" aria-label="Where to report">
        <input class="sn-input" id="sn-note" value="${esc(form.note)}" maxlength="160" placeholder="Anything else to say? (optional) e.g. Downtown route first" aria-label="Note"></div></div>
      <div class="sn-step"><span class="sn-n">3</span><div class="sn-body"><div class="sn-q">Who? <span class="muted small">${chosen.length} of ${ppl.length} ·
          <button type="button" class="link" data-pick="all">all</button> · <button type="button" class="link" data-pick="none">none</button></span></div>
        ${ppl.length ? `<div class="sn-who">${ppl.map((s) => { const on = !form.pick || form.pick.has(s.id);
          const when = form.mode === 'now' ? 'right away' : whenText(new Date(Math.max(Date.now(), start - s.call_ahead_min * 60000)));
          return `<label class="sn-pick ${on ? 'on' : ''}"><input type="checkbox" data-who="${s.id}" ${on ? 'checked' : ''}><b>${esc(s.name)}</b><span>${on ? `called ${esc(when)}` : 'not called'}</span></label>`; }).join('')}</div>`
          : '<p class="muted">No shovelers yet. Add them below.</p>'}
        <label class="check sn-now"><input type="checkbox" id="sn-now" ${form.mode === 'now' ? 'checked' : ''}> Call everyone right now (not at their call-ahead times)</label></div></div>
      <details class="sn-more"><summary>Text me the results</summary>
        <input class="sn-input" id="sn-notify" value="${esc(form.notify)}" placeholder="Your cell, e.g. 705-555-0100" aria-label="Text the results to"></details>
      <div class="sn-go ${warn ? 'warn' : ''}"><div><b>Start ${esc(whenText(start))}</b> (${esc(fromNow(start))}) · First call ${form.mode === 'now' ? 'right away' : `${esc(whenText(firstCall))} (${esc(fromNow(firstCall))})`}
          ${warn ? `<div>⚠ ${esc(warn)}</div>` : ''}</div>
        <button class="btn primary big" id="sn-start" ${chosen.length ? '' : 'disabled'}>${form.confirm ? `Tap again to phone ${chosen.length}` : 'Start snow call'}</button></div>
    </div>`;
  }

  function people() {
    const row = (s) => editing === s.id ? `<li class="sn-edit">${shovelerForm(s)}</li>`
      : `<li class="${s.active ? '' : 'inactive'}"><div><b>${esc(s.name)}</b> <span class="muted">${esc(prettyPhone(s.phone))} · called ${s.call_ahead_min} min ahead${s.active ? '' : ' · not called'}</span>
          <div class="small ${s.setup_replied_at ? 'muted' : 'sn-warn-text'}">${s.setup_replied_at ? '✓ Replied SNOW and got our contact' : s.setup_texted_at ? '… Setup text sent: waiting for them to reply SNOW' : '⚠ Not sent the setup text yet'}</div></div>
        <button class="btn tiny" data-snow-edit="${s.id}">Edit</button></li>`;
    const notSent = data.shovelers.filter((s) => s.active && !s.setup_texted_at).length;
    return `<details class="sn-card sn-people" ${data.shovelers.length && !editing ? '' : 'open'}><summary><h3>Shovelers <span class="muted">(${active().length})</span></h3>
        ${notSent ? `<span class="pill warn">${notSent} not set up</span>` : ''}</summary>
      <div class="sn-setup"><b>So the call rings at 3 AM:</b> phones often silence or flag calls from numbers that aren't saved. <b>Send setup text</b> asks each shoveler to reply SNOW
        (replying tells their phone we're not spam); then they're sent our number (${esc(data.number || '')}) to save as "Adams Bros Snow Call", and how to make it a Favourite so it rings through Do Not Disturb.
        <span class="muted">If they don't see the text, it may be in their spam or "Unknown senders" folder: ask them to open it, mark it "Not spam" and reply SNOW.</span>
        <div><button class="btn" data-snow="setup" data-scope="new">${notSent ? `Send setup text to the ${notSent} not set up` : 'Everyone has the setup text'}</button>
          <button class="btn tiny" data-snow="setup" data-scope="all">Send to everyone again</button></div></div>
      <ul class="sn-list">${data.shovelers.map(row).join('') || '<li class="muted">No shovelers yet.</li>'}</ul>
      ${editing === 'new' ? shovelerForm(null) : '<button class="btn" data-snow-edit="new">+ Add shoveler</button>'}
    </details>`;
  }
  function shovelerForm(s) {
    const ahead = s?.call_ahead_min ?? 30;
    const opts = [...new Set([...AHEAD, ahead])].sort((a, b) => a - b);
    return `<form class="inline-form snow-shoveler" data-id="${s?.id || ''}">
      <input name="name" placeholder="Name" value="${esc(s?.name || '')}" required aria-label="Name">
      <input name="phone" placeholder="Cell, e.g. 705-555-0123" value="${esc(s ? prettyPhone(s.phone) : '')}" required aria-label="Cell number">
      <select name="call_ahead_min" aria-label="Call-ahead">${opts.map((m) => `<option value="${m}" ${m === ahead ? 'selected' : ''}>call ${m} min ahead</option>`).join('')}</select>
      ${s ? `<label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Call them</label>` : ''}
      <button class="btn primary" type="submit">Save</button> <button class="btn" type="button" data-snow-edit="">Cancel</button></form>`;
  }

  let voices = null;
  function voiceBox() {
    const v = data.voice || {};
    const done = v.voice_id && v.usual && v.recorded >= v.usual;
    const library = v.voice_id ? `<div class="sn-library ${done ? 'ok' : ''}">
        <b>${done ? '✓ The usual lines are recorded' : `${v.recorded || 0} of ${v.usual || 0} usual lines recorded`}</b>
        <span class="small">The greeting, "Press 1…", the thank-yous, start times 3:00 to 8:00 AM, and the place. Recorded once, kept forever and played on every call — no more ElevenLabs charges for them.${v.kept > v.recorded ? ` (${v.kept} lines kept in all.)` : ''}</span>
        ${!done && v.configured ? `<button class="btn primary" data-snow="record" id="sn-record">Record the usual lines now</button><span class="muted small">Takes about a minute; uses about 600 characters of ElevenLabs credit, once.</span>` : ''}
        ${done && v.configured ? '<span class="muted small">You can now remove ELEVENLABS_API_KEY from the Secrets if you like. Only a new place or a one-off note would then be read by the standard voice.</span>' : ''}
      </div>` : '';
    if (!v.configured) {
      return `<details class="sn-card"><summary><h3>Call voice: ${v.voice_id && v.recorded ? esc(v.voice_name || 'ElevenLabs') + ' (recorded)' : 'standard'}</h3></summary>
        ${library}
        <p class="small">${v.voice_id && v.recorded ? 'Calls play the kept recordings. A new place or a one-off note is read by the phone system\'s voice. To record more, add' : 'Calls use the phone system\'s voice. For a natural voice, add'} an ElevenLabs API key to Replit's Secrets as <code>ELEVENLABS_API_KEY</code>, Republish, and ${v.voice_id ? 'press Record here' : 'pick a voice here'}.</p></details>`;
    }
    return `<details class="sn-card" id="sn-voice" ${voices || (v.voice_id && !done) ? 'open' : ''}><summary><h3>Call voice: ${esc(v.voice_name || 'not picked yet (standard voice)')}</h3></summary>
      ${library}
      ${voices ? `<div class="sn-voices">${voices.map((x) => `<label class="sn-voice ${x.voice_id === v.voice_id ? 'on' : ''}"><input type="radio" name="sn-voice" value="${esc(x.voice_id)}" data-name="${esc(x.name)}" ${x.voice_id === v.voice_id ? 'checked' : ''}>
          <b>${esc(x.name)}</b><span>${esc(x.about || '')}</span>
          <button type="button" class="btn tiny" data-hear="${esc(x.voice_id)}">▶ Hear our call</button></label>`).join('')}</div>
        <p class="muted small">"Hear our call" plays this voice saying a real snow call. Pick one, then record the usual lines in it.</p>`
        : `<button class="btn ${v.voice_id ? 'outline' : 'primary'}" data-snow="voices">${v.voice_id ? 'Change the voice' : 'Choose a voice'}</button>`}
    </details>`;
  }

  // ---------- actions ----------
  const startUpdate = () => { form.confirm = false; render(); };
  document.addEventListener('click', async (e) => {
    if (!root || !root.contains(e.target)) return;
    const t = e.target;
    const time = t.closest('[data-time]');
    if (time) { form.time = time.dataset.time; if (!form.dayTouched) form.day = nextDay(form.time); return startUpdate(); }
    const day = t.closest('[data-day]');
    if (day) { form.day = day.dataset.day; form.dayTouched = true; return startUpdate(); }
    const pk = t.closest('[data-pick]');
    if (pk) { form.pick = pk.dataset.pick === 'all' ? null : new Set(); return startUpdate(); }
    const ed = t.closest('[data-snow-edit]');
    if (ed) { editing = ed.dataset.snowEdit === 'new' ? 'new' : ed.dataset.snowEdit ? Number(ed.dataset.snowEdit) : null; return render(); }
    const hear = t.closest('[data-hear]');
    if (hear) {
      e.preventDefault();
      hear.disabled = true; hear.textContent = '…';
      try {
        const res = await fetch('/api/snow/voice/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice_id: hear.dataset.hear, text: `Adams Bros snow call. Start at ${sayHm(form.time)}. Report to ${form.place || 'the yard'}. Press 1 if you are coming. Press 2 if you can't.` }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not make the sample');
        new Audio(URL.createObjectURL(await res.blob())).play();
      } catch (err) { toast(err.message); }
      hear.disabled = false; hear.textContent = '▶ Hear our call';
      return;
    }
    if (t.closest('#sn-start')) {
      if (!form.confirm) { form.confirm = true; t.closest('#sn-start').textContent = `Tap again to phone ${picked().length}`; return; }
      form.confirm = false;
      try {
        await api('/snow/start', { method: 'POST', body: { day: form.day, time: form.time, place: form.place, note: form.note,
          mode: form.mode, notify: form.notify, shovelers: picked().map((s) => s.id) } });
        toast('Snow call started');
        await load();
      } catch (err) { toast(err.message); render(); }
      return;
    }
    const b = t.closest('[data-snow]');
    if (!b) return;
    try {
      const act = b.dataset.snow;
      if (act === 'cancel') {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to cancel'; return; }
        await api(`/snow/${data.current.id}/cancel`, { method: 'POST' });
        toast("Call-out cancelled. Anyone not yet called won't be.");
      } else if (act === 'setup') {
        const ids = b.dataset.scope === 'all' ? active().map((s) => s.id) : active().filter((s) => !s.setup_texted_at).map((s) => s.id);
        if (!ids.length) return toast('Everyone already has it');
        const out = await api('/snow/setup-text', { method: 'POST', body: { ids } });
        toast(`Setup text sent to ${out.results.filter((r) => r.ok).length}`);
      } else if (act === 'clear') {
        if (!confirm('Clear these results off the screen? (The call-out stays in the records.)')) return;
        await api(`/snow/${b.dataset.call}/clear`, { method: 'POST' });
        toast('Board cleared');
      } else if (act === 'record') {
        b.disabled = true;
        b.textContent = 'Recording… (about a minute)';
        const out = await api('/snow/voice/record', { method: 'POST' });
        toast(out.made ? `Recorded ${out.made} lines — kept for good` : 'Already recorded');
      } else if (act === 'voices') {
        voices = (await api('/snow/voices')).voices;
        return render();
      } else {
        await api(`/snow/people/${b.dataset.id}`, { method: 'POST', body: { action: act } });
      }
      await load();
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('change', async (e) => {
    if (!root || !root.contains(e.target)) return;
    const t = e.target;
    if (t.matches('[data-who]')) {
      if (!form.pick) form.pick = new Set(active().map((s) => s.id));
      if (t.checked) form.pick.add(Number(t.dataset.who)); else form.pick.delete(Number(t.dataset.who));
      return startUpdate();
    }
    if (t.id === 'sn-now') { form.mode = t.checked ? 'now' : 'ahead'; return startUpdate(); }
    if (t.id === 'sn-time' && t.value) { form.time = t.value; if (!form.dayTouched) form.day = nextDay(form.time); return startUpdate(); }
    if (t.id === 'sn-day' && t.value) { form.day = t.value; form.dayTouched = true; return startUpdate(); }
    if (t.name === 'sn-voice') {
      try { data.voice = { ...data.voice, ...(await api('/snow/voice', { method: 'POST', body: { voice_id: t.value, name: t.dataset.name } })) }; toast(`Voice: ${t.dataset.name}`); render(); }
      catch (err) { toast(err.message); }
    }
  });
  document.addEventListener('input', (e) => {
    if (!root || !root.contains(e.target)) return;
    const t = e.target;
    if (t.id === 'sn-place') form.place = t.value;
    if (t.id === 'sn-note') form.note = t.value;
    if (t.id === 'sn-notify') form.notify = t.value;
  });
  document.addEventListener('submit', async (e) => {
    if (!root || !root.contains(e.target) || !e.target.matches('.snow-shoveler')) return;
    e.preventDefault();
    const f = e.target.elements;
    try {
      await api('/snow/shovelers', { method: 'POST', body: { id: e.target.dataset.id || null, name: f.name.value, phone: f.phone.value,
        call_ahead_min: f.call_ahead_min.value, active: f.active ? f.active.checked : true } });
      editing = null;
      toast('Saved');
      await load();
    } catch (err) { toast(err.message); }
  });

  window.SNOW_UI = { mount };
})();
