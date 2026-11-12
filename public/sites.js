/* Our sites: what each site head asked for on a day, and what the office gives them (trucks + drivers, machines,
   labourers). Three steps across the top (ask, hand out, confirm), the day's sites on the left, one site at a time on
   the right. Changes save as they're made. Shown on the dashboard's Our sites tab and on reception. Uses app.js (window.APP). */
(function () {
  const A = window.APP;
  const { api, esc, toast } = A;
  let root = null;
  let data = null;
  let day = null;
  let current = null; // the site shown on the right
  let picked = false; // phones: showing one site rather than the list
  let pick = null; // the open "Add a truck / machine / labourer" panel
  const edits = new Map(); // site id → what it's being given

  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const time = (sql) => (sql ? new Date(sql.replace(' ', 'T') + 'Z').toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '');
  const hm12 = (hm) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const dateLong = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const first = (name) => String(name || '').split(' ')[0] || 'the site head';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  async function mount(el) {
    root = el;
    await load(day);
  }
  async function load(d, keep = true) {
    data = await api('/sites/board' + (d ? '?day=' + d : ''));
    day = data.day;
    edits.clear();
    for (const s of data.sites) edits.set(s.site.id, fromGiven(s.given));
    if (!keep || !data.sites.some((s) => s.site.id === current)) current = data.sites[0]?.site.id ?? null;
    render();
  }
  function fromGiven(g) {
    return {
      trucks: (g?.trucks || []).map((t) => ({ truck_id: t.truck_id || '', driver_id: t.driver_id, material: t.material || '', loads: t.loads || '' })),
      equipment: (g?.equipment || []).map((e) => e.id),
      labourers: (g?.labourers || []).map((l) => l.driver_id),
      note: g?.note || '',
    };
  }
  const row = () => data.sites.find((s) => s.site.id === current);
  const truckBy = (id) => data.trucks.find((t) => t.id === Number(id));
  const personBy = (id) => data.people.find((p) => p.id === Number(id));
  const machineBy = (id) => data.equipment.find((e) => e.id === Number(id));

  // Where a site stands today.
  function status(r) {
    const d = r.day;
    if (d?.status === 'nothing') return d.confirmed_at ? 'confirmed' : 'nothing';
    if (r.given) return d?.confirmed_at ? 'confirmed' : 'ready';
    if (d?.replied_at) return 'replied';
    if (d?.asked_at) return 'noreply';
    return 'notasked';
  }
  const STATUS = { notasked: 'Not asked yet', noreply: 'No reply yet', replied: 'Replied', ready: 'Ready', confirmed: 'Told', nothing: 'Nothing needed' };
  const chip = (st) => `<span class="schip ${st}">${STATUS[st]}</span>`;
  const isReady = (st) => ['ready', 'confirmed', 'nothing'].includes(st);

  // What's busy elsewhere that day (for a customer, or another of our sites).
  function busyText(use, siteName) {
    const other = (use || []).filter((u) => u.label !== siteName);
    if (!other.length) return '';
    return other.map((u) => (u.own ? `at ${u.label}` : `customer: ${u.label}`)).join('; ');
  }

  function summary(r) {
    const st = status(r);
    if (st === 'notasked') return 'Not asked yet';
    if (st === 'noreply') return `Asked at ${time(r.day.asked_at)}`;
    if (r.day?.status === 'nothing') return 'Said nothing needed';
    const g = r.given;
    if (!g) return r.asked ? `Asked for: ${r.asked}` : 'Replied';
    const bits = [...g.trucks.map((t) => t.truck_unit || t.driver_name), ...g.equipment.map((e) => e.name),
      g.labourers.length ? plural(g.labourers.length, 'labourer') : ''].filter(Boolean);
    return `Sending ${bits.join(', ') || 'a note'}`;
  }

  function steps() {
    const n = data.sites.length;
    const sts = data.sites.map(status);
    const replied = data.sites.filter((s) => s.day?.replied_at || s.day?.status === 'nothing').length;
    const waiting = data.sites.filter((s, i) => !['replied', 'ready', 'confirmed', 'nothing'].includes(sts[i]) && s.site.head_phone).length;
    const ready = sts.filter(isReady).length;
    const told = sts.filter((x) => x === 'confirmed').length;
    const toTell = ready - told;
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    const step = (num, label, done, value, bar, body) => `<div class="sstep2 ${done ? 'done' : ''}">
      <div class="n"><b>${done ? '✓' : num}</b>${label}</div><div class="v">${value}</div>
      <div class="bar" aria-hidden="true"><i style="width:${bar}%"></i></div>${body}</div>`;
    return `<div class="ssteps">
      ${step(1, 'Ask', n && replied === n, `${replied} of ${n} replied`, pct(replied, n),
        `<p>${data.ask_time ? `Asked automatically at ${esc(hm12(data.ask_time))} on work days.` : 'The automatic afternoon text is off (Setup → Our sites).'}</p>
        ${waiting ? `<div><button class="btn tiny" data-ask-all>Ask the ${waiting} who haven't replied</button></div>` : ''}`)}
      ${step(2, 'Hand out', n && ready === n, `${ready} of ${n} ready`, pct(ready, n), '<p>Give each site what it needs. It saves as you go.</p>')}
      ${step(3, 'Confirm', ready > 0 && told === ready, `${told} of ${ready} told`, pct(told, ready),
        `<div><button class="btn primary tiny" data-confirm-all ${toTell ? '' : 'disabled'}>${toTell ? `Tell ${toTell === 1 ? 'the site head' : `${toTell} site heads`} what's coming` : 'Tell site heads what\'s coming'}</button></div>
        <p>Drivers are told in the morning.</p>`)}
    </div>`;
  }

  function siteList() {
    return `<div class="slist" role="list">${data.sites.map((r) => `<button class="sitem ${r.site.id === current ? 'on' : ''}" data-site="${r.site.id}" role="listitem">
      <span class="top"><span class="nm">${esc(r.site.name)}</span>${chip(status(r))}</span>
      <span class="who">${esc(r.site.head_name || 'No site head')}</span><span class="sum">${esc(summary(r))}</span></button>`).join('')}</div>`;
  }

  function detail(r) {
    const s = r.site;
    const e = edits.get(s.id);
    const st = status(r);
    const name = first(s.head_name);
    const asked = r.day?.request || {};
    const tags = [
      ...(asked.trucks || []).map((t) => `${t.count > 1 ? t.count + ' × ' : ''}${t.type || 'Truck'}${t.slot ? ` (${String(t.slot).toUpperCase()})` : ''}${t.material ? ` – ${t.material}` : ''}${t.loads ? `, ${plural(Number(t.loads), 'load')}` : ''}`),
      ...(asked.equipment || []).map((x) => `${x.kind}${x.slot ? ` (${String(x.slot).toUpperCase()})` : ''}`),
      asked.labourers ? plural(Number(asked.labourers), 'labourer') : '',
    ].filter(Boolean);
    const gEquip = new Map((r.given?.equipment || []).map((x) => [x.id, x]));
    const items = [
      ...e.trucks.map((t, i) => {
        const tr = truckBy(t.truck_id); const p = personBy(t.driver_id);
        return `<div class="sitem-row"><span class="ic" aria-hidden="true">🚚</span><button class="body" data-edit-truck="${i}" title="Change">
          <span class="t">${tr ? esc(tr.unit) + ' with ' : ''}${esc(p?.name || 'Driver')}</span>
          <span class="s">${t.material ? esc(t.material) + (t.loads ? `, ${plural(Number(t.loads), 'load')}` : '') : 'Nothing to haul'}</span></button>
          <button class="x" data-rm="trucks" data-i="${i}" aria-label="Remove ${esc(tr?.unit || p?.name || 'truck')}">×</button></div>`;
      }),
      ...e.equipment.map((id, i) => {
        const m = machineBy(id) || { name: 'Machine' }; const g = gEquip.get(id);
        const line = !g ? '' : !g.needs_float ? '<span class="ok">Already on site</span>'
          : g.float_job_id ? `<span class="float">Float booked</span> from ${esc(g.from)} · <a href="#" data-open-job="${g.float_job_id}">work order #${g.float_job_id}</a>`
            : `<span class="float">Needs a float</span> from ${esc(g.from)} <button class="btn tiny" data-float="${id}">Book it</button>`;
        return `<div class="sitem-row"><span class="ic" aria-hidden="true">🚜</span><div class="body"><span class="t">${esc(m.name)}${m.unit ? ` <span class="muted">#${esc(m.unit)}</span>` : ''}</span>
          <span class="s">${line}</span></div><button class="x" data-rm="equipment" data-i="${i}" aria-label="Remove ${esc(m.name)}">×</button></div>`;
      }),
      ...e.labourers.map((id, i) => {
        const p = personBy(id) || { name: 'Labourer' };
        return `<div class="sitem-row"><span class="ic" aria-hidden="true">👷</span><div class="body"><span class="t">${esc(p.name)}</span><span class="s">Labourer</span></div>
          <button class="x" data-rm="labourers" data-i="${i}" aria-label="Remove ${esc(p.name)}">×</button></div>`;
      }),
    ];
    // Machines being sent show under Sending, not twice.
    const onSite = (r.on_site || []).filter((m) => !e.equipment.includes(m.id));
    const canTell = s.head_phone && (r.given || r.day?.status === 'nothing') && st !== 'confirmed';
    return `<section class="sdetail" aria-label="${esc(s.name)}">
      <div class="dhead"><div><button class="btn tiny sback" data-back>‹ All sites</button><h2>${esc(s.name)}</h2><div class="muted small">${esc(s.address || '')}</div></div>
        <div class="dhead-r">${s.head_name ? `<b>${esc(s.head_name)}${s.head_phone ? ` · ${esc(A.prettyPhone(s.head_phone))}` : ''}</b>` : '<span class="muted">No site head (Setup → Our sites)</span>'}
          ${s.head_phone ? `<button class="btn tiny" data-ask="${s.id}">${r.day?.asked_at ? `Ask ${esc(name)} again` : `Ask ${esc(name)}`}</button>` : ''}</div></div>

      <div class="sblock"><h3>They asked for ${chip(st)}</h3>
        <div class="sasked">
          ${r.day?.reply_text ? `<div class="bubble">“${esc(r.day.reply_text)}”<span class="muted small"> ${r.day.reply_via === 'link' ? 'on the link' : r.day.reply_via === 'text' ? 'by text' : 'taken by the office'} ${esc(time(r.day.replied_at))}</span></div>`
            : `<div class="muted">${r.day?.asked_at ? 'No reply yet. Call them, or wait for their text.' : 'Not asked yet.'}</div>`}
          ${tags.length ? `<div class="stags">${tags.map((x) => `<span class="stag">${esc(x)}</span>`).join('')}</div>` : r.asked && !r.day?.reply_text ? `<div class="stags"><span class="stag">${esc(r.asked)}</span></div>` : ''}
          ${asked.note ? `<div class="small">Their note: ${esc(asked.note)}</div>` : ''}
          <form class="stook" data-took="${s.id}"><input name="text" placeholder="Took it on the phone? Type what they need, e.g. tandem AM, loader" aria-label="What they need"><button class="btn tiny">Add</button></form>
        </div></div>

      ${onSite.length ? `<div class="sblock"><h3>Already on site</h3><div class="sonsite">${onSite.map((m) => `<div class="r">
          <span><b>${esc(m.name)}</b>${m.unit ? ` <span class="muted small">#${esc(m.unit)}</span>` : ''} <span class="muted small">since ${esc(m.since_label)}${m.days > 0 ? ` (${plural(m.days, 'day')})` : ' (today)'}${m.from ? ` · from ${esc(m.from)}` : ''}</span></span>
          <button class="btn tiny" data-yard="${m.id}">Back to the yard</button></div>`).join('')}</div></div>` : ''}

      <div class="sblock"><h3>Sending <span class="ssaved" id="sites-saved" role="status"></span></h3>
        <div class="ssending">${items.join('') || `<div class="muted">${r.day?.status === 'nothing' ? 'They said nothing is needed.' : 'Nothing yet. Add what they asked for.'}</div>`}</div>
        <div class="sadds"><button class="btn" data-pick="truck">+ Truck</button><button class="btn" data-pick="machine">+ Machine</button><button class="btn" data-pick="labourer">+ Labourer</button></div></div>

      <div class="sblock"><h3><label for="sites-note">Note for ${esc(name)}</label></h3><input id="sites-note" class="snote" data-note value="${esc(e.note)}" placeholder="e.g. float arrives 7:30"></div>

      <div class="sfoot"><span class="muted small">${st === 'confirmed' ? `${esc(name)} was told${r.day?.confirmed_at ? ' at ' + esc(time(r.day.confirmed_at)) : ''}. Change anything and you can tell them again.` : canTell ? 'Ready to tell the site head.' : ''}
          ${r.job_id ? ` <a href="#" data-open-job="${r.job_id}">Work order #${r.job_id}</a>` : ''}</span>
        <button class="btn primary" data-confirm-one ${canTell ? '' : 'disabled'}>${st === 'confirmed' ? `${esc(name)} has been told ✓` : `Tell ${esc(name)} what's coming`}</button></div>
    </section>`;
  }

  function yard() {
    const free = (xs) => xs.filter((t) => !t.use.length);
    const freeTrucks = free(data.trucks);
    const custTrucks = data.trucks.filter((t) => t.use.some((u) => !u.own));
    const freePeople = data.people.filter((p) => p.kind !== 'labourer' && !p.use.length);
    const yardMachines = data.equipment.filter((e) => !e.site_id && !e.place && !e.in_shop && !e.use?.length);
    const elsewhere = data.equipment.filter((e) => !e.site_id && e.place && !e.in_shop);
    const shop = data.equipment.filter((e) => e.in_shop);
    const list = (xs, f) => xs.map(f).join(', ') || '<span class="muted">none</span>';
    return `<details class="sfree"><summary>What's free on ${esc(dateLong(day).split(',')[0])}</summary><dl>
      <dt>Trucks</dt><dd>${list(freeTrucks, (t) => esc(t.unit))}</dd>
      <dt>Out to customers</dt><dd>${list(custTrucks, (t) => esc(t.unit))}</dd>
      <dt>Drivers</dt><dd>${list(freePeople, (p) => esc(p.name))}</dd>
      <dt>Machines in the yard</dt><dd>${list(yardMachines, (e) => esc(e.name))}</dd>
      ${elsewhere.length ? `<dt>Machines elsewhere</dt><dd>${list(elsewhere, (e) => `${esc(e.name)} <span class="muted">(${esc(e.place)})</span>`)}</dd>` : ''}
      ${shop.length ? `<dt>In the shop</dt><dd>${list(shop, (e) => esc(e.name))}</dd>` : ''}
    </dl></details>`;
  }

  function render() {
    const r = row();
    root.innerHTML = `<div class="sites-page">
      <div class="sdayrow">
        <div class="day-nav"><button class="btn" data-day="-1" aria-label="Day before">‹</button>
          <input type="date" value="${day}" data-pickday aria-label="Day"><button class="btn" data-day="1" aria-label="Day after">›</button></div>
        <h2>${esc(dateLong(day))}</h2>
        ${day === data.next_work_day ? '<span class="muted">Next work day</span>' : `<button class="btn tiny" data-goto="${data.next_work_day}">Go to the next work day</button>`}
        <button class="btn tiny sprint" data-print>Print</button>
      </div>
      ${steps()}
      ${data.sites.length ? `<div class="swork ${picked ? 'picked' : ''}">${siteList()}${r ? detail(r) : ''}</div>`
        : '<div class="empty">No sites yet. Add site heads and sites under Setup → Our sites.</div>'}
      <div class="sprint-only">${data.sites.map(printCard).join('')}</div>
      ${yard()}
    </div>`;
  }

  // Print: every site on one sheet.
  function printCard(r) {
    const g = r.given;
    const lines = g ? [...g.trucks.map((t) => `${t.truck_unit ? t.truck_unit + ' with ' : ''}${t.driver_name}${t.material ? ` – ${t.material}${t.loads ? `, ${plural(Number(t.loads), 'load')}` : ''}` : ''}`),
      ...g.equipment.map((x) => x.name + (x.needs_float ? ` (float from ${x.from})` : '')), ...g.labourers.map((l) => `${l.driver_name} (labourer)`)] : [];
    return `<div class="pcard"><h3>${esc(r.site.name)} <small>${esc(r.site.head_name || '')} · ${STATUS[status(r)]}</small></h3>
      ${r.asked ? `<div>Asked for: ${esc(r.asked)}</div>` : ''}${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}${g?.note ? `<div>Note: ${esc(g.note)}</div>` : ''}</div>`;
  }

  // ---------- saving (as you go) ----------
  let saving = Promise.resolve();
  function save(siteId, { reload = true } = {}) {
    const e = edits.get(siteId);
    saving = saving.then(async () => {
      const out = await api(`/sites/${siteId}/give`, { method: 'POST', body: { day,
        trucks: e.trucks.map(({ truck_id, driver_id, material, loads }) => ({ truck_id, driver_id, material, loads })), equipment: e.equipment, labourers: e.labourers, note: e.note } });
      const f = out.floats || { made: [], dropped: [] };
      if (f.made.length) toast(`Float work order${f.made.length === 1 ? '' : 's'} ${f.made.map((j) => '#' + j.id).join(', ')} made to bring the machine${f.made.length === 1 ? '' : 's'}. Pick the float truck and driver on the Board.`);
      else if (f.dropped.length) toast(`Float${f.dropped.length === 1 ? '' : 's'} no longer needed, removed: ${f.dropped.map((n) => '#' + n).join(', ')}`);
      if (reload) {
        const keepFocus = document.activeElement?.id;
        data = out; for (const s of data.sites) edits.set(s.site.id, fromGiven(s.given));
        render();
        if (keepFocus) document.getElementById(keepFocus)?.focus();
      }
      const el = document.getElementById('sites-saved');
      if (el) { el.textContent = 'Saved ✓'; setTimeout(() => { if (el.isConnected) el.textContent = ''; }, 1800); }
    }).catch((err) => { toast(err.message); return load(day); });
    return saving;
  }

  // ---------- the "Add a truck / machine / labourer" panel ----------
  function openPicker(kind, editIndex = null) {
    const r = row(); const e = edits.get(r.site.id);
    const t = editIndex != null ? e.trucks[editIndex] : null;
    // A new truck starts with what the next asked-for truck is hauling.
    const askedTruck = (r.day?.request?.trucks || []).flatMap((x) => Array.from({ length: Math.min(x.count || 1, 9) }, () => x))[e.trucks.length];
    pick = { kind, edit: editIndex, truck: t?.truck_id || '', driver: t?.driver_id || '', id: '',
      material: t ? t.material : askedTruck?.material || '', loads: t ? t.loads : askedTruck?.loads || '' };
    drawPicker();
  }
  function opt(attr, val, title, sub, busy, sel, disabled = false) {
    return `<button type="button" class="popt ${busy ? 'busy' : ''} ${sel ? 'sel' : ''}" data-${attr}="${val}" ${disabled ? 'disabled' : ''} aria-pressed="${sel ? 'true' : 'false'}">
      <span><span class="t">${esc(title)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span>${sel ? '<span aria-hidden="true">✓</span>' : ''}</button>`;
  }
  function drawPicker() {
    const r = row(); const s = r.site; const e = edits.get(s.id);
    const usedHere = (field) => e.trucks.filter((_, i) => i !== pick.edit).map((x) => Number(x[field]));
    let body = '';
    if (pick.kind === 'truck') {
      const tOpts = data.trucks.map((t) => ({ t, busy: busyText(t.use, s.name) || (usedHere('truck_id').includes(t.id) ? 'already on this site' : '') }));
      const dOpts = data.people.filter((p) => p.kind !== 'labourer').map((p) => ({ p, busy: busyText(p.use, s.name) || (usedHere('driver_id').includes(p.id) || e.labourers.includes(p.id) ? 'already on this site' : '') }));
      const byFree = (a, b) => Number(Boolean(a.busy)) - Number(Boolean(b.busy));
      body = `<div class="pgl">Driver</div><div class="popts">${dOpts.sort(byFree).map(({ p, busy }) => opt('pdriver', p.id, p.name,
          busy || (truckBy(p.default_truck_id) ? `Free · usual truck ${truckBy(p.default_truck_id).unit}` : 'Free'), Boolean(busy), Number(pick.driver) === p.id)).join('') || '<span class="muted">No drivers yet (Setup → People)</span>'}</div>
        <div class="pgl">Truck</div><div class="popts">${opt('ptruck', '', 'No truck', 'The driver goes without one', false, !pick.truck)}${tOpts.sort(byFree).map(({ t, busy }) => opt('ptruck', t.id,
          `${t.unit}${t.description ? ' · ' + t.description : ''}`, busy || 'Free', Boolean(busy), Number(pick.truck) === t.id)).join('')}</div>
        <div class="pgl">Hauling (optional)</div>
        <div class="ptwo"><div class="pfield"><label for="pk-mat">Material</label><input id="pk-mat" list="dl-site-mat" value="${esc(pick.material || '')}" placeholder="e.g. A Gravel 3/4&quot;"></div>
          <div class="pfield"><label for="pk-loads">Loads</label><input id="pk-loads" type="number" min="0" max="99" value="${esc(pick.loads || '')}"></div></div>
        <datalist id="dl-site-mat">${(data.materials || []).map((m) => `<option value="${esc(m)}">`).join('')}</datalist>`;
    }
    if (pick.kind === 'machine') {
      const list = data.equipment.filter((m) => !e.equipment.includes(m.id));
      const here = list.filter((m) => m.site_id === s.id && !m.in_shop);
      const yardM = list.filter((m) => !m.site_id && !m.place && !m.in_shop);
      const away = list.filter((m) => (m.site_id && m.site_id !== s.id) || (!m.site_id && m.place)).filter((m) => !m.in_shop);
      const shop = list.filter((m) => m.in_shop);
      const sub = (m, extra) => [m.kind, busyText(m.use, s.name), extra].filter(Boolean).join(' · ');
      const group = (label, ms, extra, busy, disabled = false) => (ms.length ? `<div class="pgl">${label}</div><div class="popts">${ms.map((m) => opt('pid', m.id, m.name + (m.unit ? ` #${m.unit}` : ''),
        sub(m, typeof extra === 'function' ? extra(m) : extra), busy || Boolean(busyText(m.use, s.name)), Number(pick.id) === m.id, disabled)).join('')}</div>` : '');
      body = group('Already on this site', here, 'no float needed', false)
        + group('In the yard', yardM, 'a float is booked from the yard', false)
        + group('Somewhere else', away, (m) => `at ${m.at} since ${m.since_label} · a float is booked from there`, true)
        + group('In the shop', shop, "can't be sent", true, true)
        || '<span class="muted">No machines yet (Setup → Our sites → Equipment)</span>';
    }
    if (pick.kind === 'labourer') {
      const list = data.people.filter((p) => p.kind === 'labourer' && !e.labourers.includes(p.id)).map((p) => ({ p, busy: busyText(p.use, s.name) }))
        .sort((a, b) => Number(Boolean(a.busy)) - Number(Boolean(b.busy)));
      body = `<div class="popts">${list.map(({ p, busy }) => opt('pid', p.id, p.name, busy || 'Free', Boolean(busy), Number(pick.id) === p.id)).join('') || '<span class="muted">No labourers yet (Setup → People)</span>'}</div>`;
    }
    const title = pick.edit != null ? 'Change the truck' : { truck: 'Add a truck', machine: 'Add a machine', labourer: 'Add a labourer' }[pick.kind];
    const ready = pick.kind === 'truck' ? pick.driver : pick.id;
    let layer = document.getElementById('sites-layer');
    if (!layer) { layer = document.createElement('div'); layer.id = 'sites-layer'; document.body.append(layer); }
    const scroll = layer.querySelector('.pbody')?.scrollTop || 0;
    layer.innerHTML = `<div class="pscrim" data-pclose></div><aside class="ppanel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h3>${esc(title)}</h3><button type="button" class="x" data-pclose aria-label="Close">×</button></header>
      <div class="pbody">${body}</div>
      <footer><button type="button" class="btn" data-pclose>Cancel</button><button type="button" class="btn primary" data-padd ${ready ? '' : 'disabled'}>${pick.edit != null ? 'Save' : `Add to ${esc(s.name.split(' –')[0])}`}</button></footer></aside>`;
    layer.querySelector('.pbody').scrollTop = scroll;
    if (!layer.contains(document.activeElement)) layer.querySelector('.ppanel header .x').focus();
  }
  function closePicker() { pick = null; document.getElementById('sites-layer')?.replaceChildren(); }
  function keepFields() { const m = document.getElementById('pk-mat'); const l = document.getElementById('pk-loads'); if (m) pick.material = m.value; if (l) pick.loads = l.value; }

  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    const layer = document.getElementById('sites-layer');
    if (pick && layer?.contains(t)) {
      if (t.closest('[data-pclose]')) return closePicker();
      keepFields();
      const d = t.closest('[data-pdriver]');
      if (d) {
        pick.driver = Number(d.dataset.pdriver);
        const p = personBy(pick.driver); const usual = truckBy(p?.default_truck_id);
        if (!pick.truck && usual && !busyText(usual.use, row().site.name)) pick.truck = usual.id; // their usual truck
        return drawPicker();
      }
      const tr = t.closest('[data-ptruck]'); if (tr) { pick.truck = tr.dataset.ptruck ? Number(tr.dataset.ptruck) : ''; return drawPicker(); }
      const pid = t.closest('[data-pid]'); if (pid) { pick.id = Number(pid.dataset.pid); return drawPicker(); }
      if (t.closest('[data-padd]')) {
        const r = row(); const e = edits.get(r.site.id);
        if (pick.kind === 'truck') {
          const item = { truck_id: pick.truck || '', driver_id: pick.driver, material: pick.material.trim(), loads: pick.loads };
          if (pick.edit != null) e.trucks[pick.edit] = item; else e.trucks.push(item);
        }
        if (pick.kind === 'machine') e.equipment.push(pick.id);
        if (pick.kind === 'labourer') e.labourers.push(pick.id);
        closePicker();
        return save(r.site.id);
      }
      return;
    }
    if (!root || !root.contains(t)) return;
    try {
      const siteBtn = t.closest('[data-site]');
      if (siteBtn) { current = Number(siteBtn.dataset.site); picked = true; render(); if (window.matchMedia('(max-width: 860px)').matches) root.scrollIntoView({ block: 'start' }); return; }
      if (t.closest('[data-back]')) { picked = false; return render(); }
      if (t.closest('[data-day]')) return load(addDays(day, Number(t.closest('[data-day]').dataset.day)));
      if (t.closest('[data-goto]')) return load(t.closest('[data-goto]').dataset.goto);
      if (t.closest('[data-print]')) return window.print();
      if (t.closest('[data-open-job]')) { ev.preventDefault(); return A.openJobForm(await api('/jobs/' + t.closest('[data-open-job]').dataset.openJob)); }
      if (t.closest('[data-ask-all]')) {
        const ids = data.sites.filter((s) => !s.day?.replied_at && s.day?.status !== 'nothing' && !s.given).map((s) => s.site.id);
        const out = await api('/sites/ask', { method: 'POST', body: { day, site_ids: ids } });
        toast(`Texted ${plural(out.results.filter((x) => x.ok).length, 'site head')} about ${dateLong(day)}`);
        return load(day);
      }
      if (t.closest('[data-ask]')) {
        await api('/sites/ask', { method: 'POST', body: { day, site_ids: [Number(t.closest('[data-ask]').dataset.ask)] } });
        toast(`Texted ${first(row()?.site.head_name)}`); return load(day);
      }
      if (t.closest('[data-confirm-all], [data-confirm-one]')) {
        await saving;
        const one = t.closest('[data-confirm-one]');
        const ids = one ? [current] : data.sites.filter((s) => ['ready', 'nothing'].includes(status(s))).map((s) => s.site.id);
        const out = await api('/sites/confirm', { method: 'POST', body: { day, site_ids: ids } });
        const ok = out.results.filter((x) => x.ok).length;
        toast(ok ? `Texted ${one ? first(row()?.site.head_name) : plural(ok, 'site head')} what's coming. Drivers get their jobs in the morning text.` : 'Nothing to tell yet. Give the site what it needs first.');
        return load(day);
      }
      const r = row(); if (!r) return;
      const e = edits.get(r.site.id);
      const p = t.closest('[data-pick]'); if (p) return openPicker(p.dataset.pick);
      const et = t.closest('[data-edit-truck]'); if (et) return openPicker('truck', Number(et.dataset.editTruck));
      const rm = t.closest('[data-rm]'); if (rm) { e[rm.dataset.rm].splice(Number(rm.dataset.i), 1); render(); return save(r.site.id); }
      if (t.closest('[data-yard]')) {
        const id = Number(t.closest('[data-yard]').dataset.yard);
        const job = await api(`/sites/${r.site.id}/yard`, { method: 'POST', body: { day, equipment_id: id } });
        toast(`${machineBy(id)?.name || 'Machine'} goes back to the yard: float work order #${job.id}. Pick the float truck and driver on the Board.`);
        return load(day);
      }
      if (t.closest('[data-float]')) {
        const job = await api(`/sites/${r.site.id}/float`, { method: 'POST', body: { day, equipment_id: Number(t.closest('[data-float]').dataset.float) } });
        toast(`Float booked: work order #${job.id}. Pick the float truck and driver on the Board.`);
        return load(day);
      }
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && pick) closePicker(); });
  document.addEventListener('change', (ev) => {
    if (!root || !root.contains(ev.target)) return;
    const t = ev.target;
    if (t.matches('[data-pickday]') && t.value) return load(t.value);
    if (t.matches('[data-note]')) { const r = row(); edits.get(r.site.id).note = t.value; return save(r.site.id, { reload: false }); }
  });
  document.addEventListener('submit', async (ev) => {
    if (!root || !root.contains(ev.target) || !ev.target.matches('[data-took]')) return;
    ev.preventDefault();
    const text = ev.target.elements.text.value.trim();
    if (!text) return;
    try {
      await api(`/sites/${ev.target.dataset.took}/request`, { method: 'POST', body: { day, text } });
      toast('Saved what they need'); await load(day);
    } catch (err) { toast(err.message); }
  });


  // ---------- Setup → Our sites (admins) ----------
  let setupEl = null;
  async function mountSetup(el) {
    setupEl = el;
    const d = await api('/sites/setup');
    const headOpts = (sel) => '<option value="">No site head</option>' + d.heads.filter((h) => h.active || h.id === sel)
      .map((h) => `<option value="${h.id}" ${h.id === sel ? 'selected' : ''}>${esc(h.name)}</option>`).join('');
    const act = (on) => `<label class="check"><input type="checkbox" name="active" ${on ? 'checked' : ''}> Active</label>`;
    el.innerHTML = `
      <p class="muted small">People running our own jobs ask for trucks, drivers, machines and labourers on the <b>Sites</b> tab.
        Each work day at the time below, every active site's head is texted "what do you need for (next work day)?"
        — Friday asks about Monday. They reply in plain words or tap the link.</p>
      <form class="inline-form" data-s-asktime>
        <label class="check"><input type="checkbox" name="on" ${d.ask_time ? 'checked' : ''}> Text site heads automatically at</label>
        <input type="time" name="ask_time" value="${esc(d.ask_time || '14:30')}"> <button class="btn primary">Save</button>
      </form>
      <h3>Site heads</h3>
      <table class="table compact"><thead><tr><th>Name</th><th>Cell</th><th></th><th></th></tr></thead><tbody>
        ${[...d.heads, { id: '', name: '', phone: '', active: 1 }].map((h) => `<tr data-s-head="${h.id}">
          <td><input name="name" value="${esc(h.name)}" placeholder="${h.id ? '' : 'New site head'}"></td>
          <td><input name="phone" value="${esc(h.phone ? A.prettyPhone(h.phone) : '')}" placeholder="705-555-0123"></td>
          <td>${act(h.active)}</td><td><button class="btn tiny" data-s-save="head">${h.id ? 'Save' : 'Add'}</button></td></tr>`).join('')}
      </tbody></table>
      <h3>Sites</h3>
      <table class="table compact"><thead><tr><th>Site</th><th>Address</th><th>Municipality</th><th>Site head</th><th></th><th></th></tr></thead><tbody>
        ${[...d.sites, { id: '', name: '', address: '', municipality: '', head_id: null, active: 1 }].map((x) => `<tr data-s-site="${x.id}">
          <td><input name="name" value="${esc(x.name)}" placeholder="${x.id ? '' : 'e.g. Seguin – Lake Rd septic'}"></td>
          <td><input name="address" value="${esc(x.address)}"></td><td><input name="municipality" value="${esc(x.municipality)}"></td>
          <td><select name="head_id">${headOpts(x.head_id)}</select></td>
          <td>${act(x.active)}</td><td><button class="btn tiny" data-s-save="site">${x.id ? 'Save' : 'Add'}</button></td></tr>`).join('')}
      </tbody></table>
      <p class="muted small">Untick <b>Active</b> when a job wraps up: the site head stops getting the afternoon text.</p>
      <h3>Equipment</h3>
      <table class="table compact"><thead><tr><th>Name</th><th>Kind</th><th>Unit #</th><th>Where it is now</th><th></th><th></th><th></th></tr></thead><tbody>
        ${[...d.equipment, { id: '', name: '', kind: '', unit: '', in_shop: 0, active: 1 }].map((x) => `<tr data-s-equip="${x.id}">
          <td><input name="name" value="${esc(x.name)}" placeholder="${x.id ? '' : 'e.g. Cat 308'}"></td>
          <td><input name="kind" value="${esc(x.kind)}" list="dl-equip-kinds" placeholder="Excavator"></td>
          <td><input name="unit" value="${esc(x.unit)}"></td>
          <td>${x.id ? `<select name="where" data-s-place="${x.id}" aria-label="Where ${esc(x.name)} is now">
            <option value="">The yard</option>${d.sites.filter((s) => s.active || s.id === d.locations?.[x.id]?.site_id).map((s) => `<option value="${s.id}" ${d.locations?.[x.id]?.site_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select>` : '<span class="muted small">the yard</span>'}</td>
          <td><label class="check"><input type="checkbox" name="in_shop" ${x.in_shop ? 'checked' : ''}> In the shop</label></td>
          <td>${act(x.active)}</td><td><button class="btn tiny" data-s-save="equip">${x.id ? 'Save' : 'Add'}</button></td></tr>`).join('')}
      </tbody></table>
      <datalist id="dl-equip-kinds">${['Excavator', 'Mini excavator', 'Loader', 'Skid steer', 'Dozer', 'Roller', 'Grader'].map((k) => `<option value="${k}">`).join('')}</datalist>
      <p class="muted small">The "Kind" is what site heads ask for ("mini ex", "loader"). Placeholder machines are listed to start — rename them, or untick Active.
        <b>Where it is now</b>: set where each machine really is when you start (or if it was moved without the app). It changes right away and no float is made;
        after that the app keeps track as machines are given to sites, floated and sent back.</p>`;
  }
  document.addEventListener('click', async (ev) => {
    if (!setupEl || !setupEl.contains(ev.target)) return;
    const b = ev.target.closest('[data-s-save]');
    if (!b) return;
    const tr = b.closest('tr');
    const v = (n) => tr.querySelector(`[name=${n}]`);
    const kind = b.dataset.sSave;
    const id = tr.dataset.sHead ?? tr.dataset.sSite ?? tr.dataset.sEquip;
    const body = { id: id || undefined, name: v('name').value, active: v('active').checked };
    if (kind === 'head') body.phone = v('phone').value;
    if (kind === 'site') Object.assign(body, { address: v('address').value, municipality: v('municipality').value, head_id: v('head_id').value || null });
    if (kind === 'equip') Object.assign(body, { kind: v('kind').value, unit: v('unit').value, in_shop: v('in_shop').checked });
    try {
      await api(kind === 'head' ? '/sites/heads' : kind === 'site' ? '/sites/sites' : '/sites/equipment', { method: 'POST', body });
      toast('Saved'); await mountSetup(setupEl);
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('change', async (ev) => {
    if (!setupEl || !setupEl.contains(ev.target) || !ev.target.matches('[data-s-place]')) return;
    const sel = ev.target;
    try {
      const out = await api(`/sites/equipment/${sel.dataset.sPlace}/place`, { method: 'POST', body: { site_id: sel.value || null } });
      toast(out.unchanged ? 'No change' : `Noted: it's at ${sel.selectedOptions[0].textContent} now (no float made)`);
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('submit', async (ev) => {
    if (!setupEl || !setupEl.contains(ev.target) || !ev.target.matches('[data-s-asktime]')) return;
    ev.preventDefault();
    const f = ev.target.elements;
    try {
      const out = await api('/sites/ask-time', { method: 'POST', body: { ask_time: f.on.checked ? f.ask_time.value : '' } });
      toast(out.ask_time ? `Site heads will be texted at ${out.ask_time} on work days` : 'Automatic site head texts are off');
    } catch (err) { toast(err.message); }
  });

  // ---------- Setup (new layout): Equipment, Sites & site heads, Site heads' text ----------
  let parts = null;
  let partsTab = 'sites';
  const hm12s = (hm) => { if (!hm) return ''; const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  async function mountSetupParts(mounts) {
    parts = { mounts, d: await api('/sites/setup') };
    renderParts();
  }
  function fieldHtml(id, label, input, hint = '') {
    return `<div class="dfield"><label for="${id}">${esc(label)}</label>${input}${hint ? `<span class="dhint">${hint}</span>` : ''}</div>`;
  }
  const switchHtml = (id, label, on) => `<label class="dswitch" for="${id}"><span class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></span>${esc(label)}</label>`;
  function renderParts() {
    const { mounts, d } = parts;
    const siteName = (id) => d.sites.find((s) => s.id === id)?.name || 'a site';
    // Site heads' text
    mounts.sitetext.innerHTML = `<div class="setlist">
      <div class="setrow"><div><div class="t">Ask site heads automatically</div><div class="sub">Every work day. You can also ask any time from the Our sites page.</div></div>
        <div class="ctrl"><label class="sw"><input type="checkbox" data-ask-on ${d.ask_time ? 'checked' : ''} aria-label="Ask site heads automatically"><span></span></label></div></div>
      <div class="setrow"><div><div class="t">Time</div><div class="sub">Eastern time.</div></div>
        <div class="ctrl"><input type="time" data-ask-time value="${esc(d.ask_time || '14:30')}" aria-label="Time"></div></div>
      <div class="setrow"><div><div class="t">What they get</div><div class="bubble-prev">Hi Mike - what do you need at Seguin on Mon Nov 16? Reply e.g. "tandem AM, mini ex, 2 labourers", or "same", or "nothing". Or tap: (their link)</div></div></div>
    </div>`;
    // Sites & site heads
    const activeCount = (h) => d.sites.filter((s) => s.head_id === h.id && s.active).length;
    mounts.sites.innerHTML = `<div class="sub-head"><div class="subtabs" role="tablist">
        <button type="button" class="${partsTab === 'sites' ? 'on' : ''}" data-ptab="sites">Sites (${d.sites.length})</button>
        <button type="button" class="${partsTab === 'heads' ? 'on' : ''}" data-ptab="heads">Site heads (${d.heads.length})</button></div>
        <button class="btn primary" type="button" data-padd="${partsTab === 'sites' ? 'site' : 'head'}">+ Add ${partsTab === 'sites' ? 'site' : 'site head'}</button></div>
      <div class="rows">${partsTab === 'sites'
        ? d.sites.map((x) => `<div class="lrow"><div><div class="t">${esc(x.name)}</div><div class="sub">${esc(x.address || 'No address')}${x.head_name ? ' · run by ' + esc(x.head_name) : ' · no site head'}</div></div>
            <div class="meta"><span class="pill ${x.active ? 'ok' : ''}">${x.active ? 'Active' : 'Wrapped up'}</span><button class="btn tiny" type="button" data-pedit="site" data-id="${x.id}">Edit</button></div></div>`).join('')
          || '<div class="lempty">No sites yet. Add the first one with <b>+ Add site</b>.</div>'
        : d.heads.map((h) => `<div class="lrow"><div><div class="t">${esc(h.name)}</div><div class="sub">${esc(A.prettyPhone(h.phone))} · runs ${activeCount(h)} active site${activeCount(h) === 1 ? '' : 's'}</div></div>
            <div class="meta">${h.active ? '' : '<span class="pill">Inactive</span>'}<button class="btn tiny" type="button" data-pedit="head" data-id="${h.id}">Edit</button></div></div>`).join('')
          || '<div class="lempty">No site heads yet. Add the first one with <b>+ Add site head</b>.</div>'}</div>`;
    // Equipment
    mounts.equipment.innerHTML = `<div class="sub-head"><span></span><button class="btn primary" type="button" data-padd="machine">+ Add machine</button></div>
      <div class="rows">${d.equipment.map((e) => {
        const loc = d.locations?.[e.id];
        return `<div class="lrow ${e.active ? '' : 'inactive'}"><div><div class="t">${esc(e.name)}${e.unit ? ` <span class="sub">#${esc(e.unit)}</span>` : ''}</div><div class="sub">${esc(e.kind)}${e.active ? '' : ' · not in use'}</div></div>
          <div class="meta">${e.in_shop ? '<span class="pill warn">In the shop</span>' : ''}<span class="pill ${loc?.site_id ? 'brand' : loc?.place ? 'warn' : ''}">${loc?.site_id ? `At ${esc(siteName(loc.site_id))}` : loc?.place ? `At ${esc(loc.place)}` : 'In the yard'}</span>
          <button class="btn tiny" type="button" data-pedit="machine" data-id="${e.id}">Edit</button></div></div>`;
      }).join('') || '<div class="lempty">No machines yet.</div>'}</div>
      <p class="muted small">Placeholder machines are listed to start: rename them, or switch off <b>In use</b>. <b>Where it is now</b> in a machine's panel fixes its place if it was moved without the app (no float is made).</p>`;
  }
  async function reloadParts() { parts.d = await api('/sites/setup'); renderParts(); window.SETUP_UI?.refresh(); }
  function openPart(kind, item = null) {
    const { d } = parts;
    const v = (k) => esc(item?.[k] ?? '');
    let body = '';
    if (kind === 'head') body = fieldHtml('ph-name', 'Name', `<input id="ph-name" value="${v('name')}">`)
      + fieldHtml('ph-phone', 'Cell number', `<input id="ph-phone" type="tel" value="${esc(item ? A.prettyPhone(item.phone) : '')}" placeholder="705-555-0123">`, 'The "what do you need?" text goes to this number.')
      + switchHtml('ph-active', 'Active', item ? item.active : true);
    if (kind === 'site') body = fieldHtml('ps-name', 'Site name', `<input id="ps-name" value="${v('name')}" placeholder="e.g. Seguin – Lake Rd septic">`)
      + fieldHtml('ps-address', 'Address', `<input id="ps-address" value="${v('address')}">`)
      + fieldHtml('ps-muni', 'Municipality', `<input id="ps-muni" value="${v('municipality')}">`)
      + fieldHtml('ps-head', 'Site head', `<select id="ps-head"><option value="">No site head</option>${d.heads.filter((h) => h.active || h.id === item?.head_id).map((h) => `<option value="${h.id}" ${h.id === item?.head_id ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select>`)
      + switchHtml('ps-active', 'Active (gets the afternoon text)', item ? item.active : true)
      + '<span class="dhint">Switch Active off when the job wraps up.</span>';
    if (kind === 'machine') {
      const at = item ? d.locations?.[item.id] || {} : {};
      const loc = at.site_id || (at.place ? 'other' : '');
      body = fieldHtml('pm-name', 'Name', `<input id="pm-name" value="${v('name')}" placeholder="e.g. Cat 308">`)
        + fieldHtml('pm-kind', 'Kind', `<input id="pm-kind" value="${v('kind')}" list="dl-pm-kinds" placeholder="Excavator"><datalist id="dl-pm-kinds">${['Excavator', 'Mini excavator', 'Loader', 'Skid steer', 'Dozer', 'Roller', 'Grader'].map((k) => `<option value="${k}">`).join('')}</datalist>`, 'What site heads call it when they ask ("mini ex", "loader").')
        + fieldHtml('pm-unit', 'Unit #', `<input id="pm-unit" value="${v('unit')}" placeholder="EX-3">`, 'The number or code on the machine, if it has one.')
        + fieldHtml('pm-where', 'Where it is now', `<select id="pm-where"><option value="">The yard</option>${d.sites.filter((s) => s.active || s.id === loc).map((s) => `<option value="${s.id}" ${s.id === loc ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            <option value="other" ${loc === 'other' ? 'selected' : ''}>Somewhere else…</option></select>
            <input id="pm-place" value="${esc(at.place || '')}" placeholder="e.g. Sundridge shop, Cat dealer for repairs" aria-label="Where it is" ${loc === 'other' ? '' : 'hidden'}>`,
          item ? 'Changing this makes no float. Use it if the machine was moved without the app.' : 'Where the machine is today. No float is made; from now on the app keeps track as it moves.')
        + switchHtml('pm-shop', 'In the shop', item?.in_shop)
        + switchHtml('pm-active', 'In use', item ? item.active : true);
    }
    const titles = { head: 'site head', site: 'site', machine: 'machine' };
    const val = (id) => document.getElementById(id)?.value ?? '';
    const chk = (id) => Boolean(document.getElementById(id)?.checked);
    window.SETUP_UI.drawer({
      title: item ? (item.name || 'Edit') : `New ${titles[kind]}`,
      body,
      saveLabel: item ? 'Save' : `Add ${titles[kind]}`,
      onSave: async () => {
        if (kind === 'head') await api('/sites/heads', { method: 'POST', body: { id: item?.id, name: val('ph-name'), phone: val('ph-phone'), active: chk('ph-active') } });
        if (kind === 'site') await api('/sites/sites', { method: 'POST', body: { id: item?.id, name: val('ps-name'), address: val('ps-address'), municipality: val('ps-muni'), head_id: val('ps-head') || null, active: chk('ps-active') } });
        if (kind === 'machine') {
          const saved = await api('/sites/equipment', { method: 'POST', body: { id: item?.id, name: val('pm-name'), kind: val('pm-kind'), unit: val('pm-unit'), in_shop: chk('pm-shop'), active: chk('pm-active') } });
          const where = val('pm-where');
          const place = where === 'other' ? val('pm-place').trim() : '';
          if (where === 'other' && !place) { toast('Type where the machine is, or pick a site or the yard'); return false; }
          const was = (item && d.locations?.[item.id]) || {};
          if (String(where === 'other' ? '' : where) !== String(was.site_id || '') || place !== (was.place || '')) {
            await api(`/sites/equipment/${saved.id}/place`, { method: 'POST', body: { site_id: where === 'other' ? null : where || null, place } });
          }
        }
        toast('Saved ✓');
        await reloadParts();
      },
    });
  }
  document.addEventListener('click', (ev) => {
    if (!parts) return;
    const inParts = Object.values(parts.mounts).some((m) => m.contains(ev.target));
    if (!inParts) return;
    const tabBtn = ev.target.closest('[data-ptab]');
    if (tabBtn) { partsTab = tabBtn.dataset.ptab; return renderParts(); }
    const add = ev.target.closest('[data-padd]');
    if (add) return openPart(add.dataset.padd);
    const ed = ev.target.closest('[data-pedit]');
    if (ed) {
      const list = { head: parts.d.heads, site: parts.d.sites, machine: parts.d.equipment }[ed.dataset.pedit];
      return openPart(ed.dataset.pedit, list.find((x) => x.id === Number(ed.dataset.id)));
    }
  });
  // "Somewhere else…" shows its text box.
  document.addEventListener('change', (ev) => {
    if (ev.target.id !== 'pm-where') return;
    const box = document.getElementById('pm-place');
    if (box) { box.hidden = ev.target.value !== 'other'; if (!box.hidden) box.focus(); }
  });
  document.addEventListener('change', async (ev) => {
    if (!parts || !parts.mounts.sitetext.contains(ev.target)) return;
    const on = parts.mounts.sitetext.querySelector('[data-ask-on]').checked;
    const t = parts.mounts.sitetext.querySelector('[data-ask-time]').value || '14:30';
    try {
      const out = await api('/sites/ask-time', { method: 'POST', body: { ask_time: on ? t : '' } });
      toast(out.ask_time ? `Saved ✓ Site heads are asked at ${hm12s(out.ask_time)} on work days` : 'Saved ✓ Site heads are not asked automatically');
      parts.d.ask_time = out.ask_time; window.SETUP_UI?.refresh();
    } catch (err) { toast(err.message); }
  });

  window.SITES = { mount, mountSetup, mountSetupParts, reload: () => root && load(day) };
})();
