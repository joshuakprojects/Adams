/* Our sites: what each site head asked for on a day, and what the office gives them (trucks + drivers, machines,
   labourers). Shown on the dashboard's Sites tab and on reception. Uses app.js (window.APP). */
(function () {
  const A = window.APP;
  const { api, esc, toast } = A;
  let root = null;
  let data = null;
  let day = null;
  const edits = new Map(); // site id → what's being given (unsaved)

  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const time = (sql) => (sql ? new Date(sql.replace(' ', 'T') + 'Z').toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '');
  const hm12 = (hm) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const dateLong = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

  async function mount(el) {
    root = el;
    if (!day) day = null;
    await load(day);
  }
  async function load(d) {
    data = await api('/sites/board' + (d ? '?day=' + d : ''));
    day = data.day;
    edits.clear();
    for (const s of data.sites) edits.set(s.site.id, fromGiven(s.given, s.day?.request));
    render();
  }
  function fromGiven(g, request) {
    // Nothing given yet: start a row for each truck they asked for, with what it's hauling.
    const asked = !g && request?.trucks ? request.trucks.flatMap((t) => Array.from({ length: Math.min(t.count || 1, 9) },
      () => ({ truck_id: '', driver_id: '', material: t.material || '', loads: t.loads || '', asked: t.type }))) : [];
    return {
      trucks: g ? (g.trucks || []).map((t) => ({ truck_id: t.truck_id || '', driver_id: t.driver_id, material: t.material || '', loads: t.loads || '' })) : asked,
      equipment: (g?.equipment || []).map((e) => e.id),
      labourers: (g?.labourers || []).map((l) => l.driver_id),
      note: g?.note || '',
      dirty: false,
    };
  }

  // What's busy elsewhere that day (for a customer, or another of our sites).
  function busyText(use, siteName) {
    const other = use.filter((u) => u.label !== siteName);
    if (!other.length) return '';
    return other.map((u) => (u.own ? `at ${u.label}` : `customer: ${u.label}`)).join('; ');
  }
  function truckOptions(sel, siteName) {
    return '<option value="">No truck</option>' + data.trucks.map((t) => {
      const busy = busyText(t.use, siteName);
      return `<option value="${t.id}" ${Number(sel) === t.id ? 'selected' : ''}>${esc(t.unit)}${t.description ? ' · ' + esc(t.description) : ''}${busy ? ` — ${esc(busy)}` : ''}</option>`;
    }).join('');
  }
  function personOptions(kind, sel, siteName, placeholder) {
    return `<option value="">${placeholder}</option>` + data.people.filter((p) => (kind === 'labourer' ? p.kind === 'labourer' : p.kind !== 'labourer')).map((p) => {
      const busy = busyText(p.use, siteName);
      return `<option value="${p.id}" ${Number(sel) === p.id ? 'selected' : ''}>${esc(p.name)}${busy ? ` — ${esc(busy)}` : ''}</option>`;
    }).join('');
  }
  function machineOptions(siteName, taken, siteId) {
    return '<option value="">+ Add a machine…</option>' + data.equipment.filter((e) => !taken.includes(e.id) && e.site_id !== siteId).map((e) => {
      const where = e.in_shop ? 'in the shop' : e.site_id ? `at ${e.at} since ${e.since_label}` : 'in the yard';
      return `<option value="${e.id}" ${e.in_shop ? 'disabled' : ''}>${esc(e.name)} (${esc(e.kind)}) — ${esc(where)}</option>`;
    }).join('');
  }

  function statusChip(row) {
    const d = row.day;
    if (!d || (!d.asked_at && !d.replied_at)) return '<span class="chip">Not asked yet</span>';
    if (d.status === 'nothing') return `<span class="chip done">Nothing needed</span>`;
    if (d.replied_at) return `<span class="chip done">Replied ${d.reply_via === 'link' ? 'on the link' : d.reply_via === 'text' ? 'by text' : '(office)'} ${esc(time(d.replied_at))}</span>`;
    return `<span class="chip sent">Asked ${esc(time(d.asked_at))} · no reply yet</span>`;
  }

  function siteCard(row) {
    const s = row.site;
    const e = edits.get(s.id);
    const given = row.given;
    const machines = e.equipment.map((id) => {
      const m = data.equipment.find((x) => x.id === id) || { name: 'Machine', kind: '' };
      const g = given?.equipment.find((x) => x.id === id);
      const float = g?.needs_float ? (g.float_job_id ? `<span class="muted small">float booked (#${g.float_job_id})</span>`
        : `<button class="btn tiny" data-float="${id}">Book the float from ${esc(g.from)}</button>`) : '';
      return `<span class="gchip">${esc(m.name)} ${float}<button class="x" data-rm-machine="${id}" aria-label="Remove ${esc(m.name)}">×</button></span>`;
    }).join('');
    const labourers = e.labourers.map((id) => {
      const p = data.people.find((x) => x.id === id) || { name: '?' };
      return `<span class="gchip">${esc(p.name)}<button class="x" data-rm-lab="${id}" aria-label="Remove ${esc(p.name)}">×</button></span>`;
    }).join('');
    return `<article class="site-card ${row.job_id ? 'has-job' : ''}" data-site="${s.id}">
      <header>
        <div><h3>🏗️ ${esc(s.name)}</h3><div class="muted small">${esc(s.address || '')}</div></div>
        <div class="head">${s.head_name ? `<b>${esc(s.head_name)}</b> ${s.head_phone ? `<a href="tel:${esc(s.head_phone)}">${esc(A.prettyPhone(s.head_phone))}</a>` : ''}` : '<span class="muted">No site head</span>'}</div>
      </header>
      <section class="asked">
        <div class="row-actions">${statusChip(row)} ${row.day?.confirmed_at ? `<span class="chip done">Confirmed ${esc(time(row.day.confirmed_at))}</span>` : ''}
          ${s.head_phone ? `<button class="btn tiny" data-ask="${s.id}" title="Sends the 'what do you need?' text to just this site head">Ask ${esc(String(s.head_name || '').split(' ')[0])} again</button>` : ''}</div>
        ${row.day?.reply_text ? `<blockquote>${esc(row.day.reply_text)}</blockquote>` : ''}
        ${row.asked ? `<div class="need-line"><span class="lbl">Asked for</span> ${esc(row.asked)}</div>` : ''}
        <form class="took" data-took="${s.id}"><input name="text" placeholder="Took it on the phone? Type what they need, e.g. tandem AM, loader" aria-label="What they need">
          <button class="btn tiny">Save</button></form>
      </section>
      ${row.on_site?.length ? `<section class="on-site">
        <div class="lbl">On site now</div>
        ${row.on_site.map((m) => `<div class="on-row">
          <span class="nm">🚜 ${esc(m.name)}${m.unit ? ` <span class="muted small">#${esc(m.unit)}</span>` : ''}</span>
          <span class="muted small">since ${esc(m.since_label)}${m.days > 0 ? ` (${m.days} day${m.days === 1 ? '' : 's'})` : ' (today)'}${m.from ? ` · ${m.how === 'float' ? 'floated' : 'came'} from ${esc(m.from)}` : ''}</span>
          <button class="btn tiny" data-yard="${m.id}" title="Books the float to bring it back">Back to the yard</button></div>`).join('')}
      </section>` : ''}
      <section class="given">
        <div class="lbl">Trucks &amp; drivers</div>
        ${e.trucks.map((t, i) => `<div class="truck-row" data-i="${i}">
          ${t.asked ? `<div class="asked-for muted small">Asked: ${esc(t.asked)}</div>` : ''}
          <select data-truck aria-label="Truck">${truckOptions(t.truck_id, s.name)}</select>
          <select data-driver aria-label="Driver">${personOptions('driver', t.driver_id, s.name, 'Driver…')}</select>
          <button class="x" data-rm-truck="${i}" aria-label="Remove">×</button>
          <input data-mat list="dl-site-mat" value="${esc(t.material || '')}" placeholder="Hauling (e.g. A Gravel 3/4&quot;)" aria-label="Material">
          <input data-loads type="number" min="0" max="99" value="${t.loads || ''}" placeholder="Loads" aria-label="Loads"></div>`).join('')}
        <button class="btn tiny" data-add-truck>+ Truck</button>
        <div class="lbl">Machines</div>
        <div class="chips">${machines}</div>
        <select data-add-machine aria-label="Add a machine">${machineOptions(s.name, e.equipment, s.id)}</select>
        <div class="lbl">Labourers</div>
        <div class="chips">${labourers}</div>
        <select data-add-lab aria-label="Add a labourer">${personOptions('labourer', '', s.name, '+ Add a labourer…')}</select>
        <div class="lbl">Note for the site head</div>
        <input data-note value="${esc(e.note)}" placeholder="e.g. float arrives 7:30">
        <div class="row-actions save-row">
          <button class="btn primary" data-save ${e.dirty ? '' : 'disabled'}>${e.dirty ? 'Save' : 'Saved'}</button>
          ${row.job_id ? `<a class="muted small" href="#" data-open-job="${row.job_id}">Work order #${row.job_id}</a>` : ''}
        </div>
      </section>
    </article>`;
  }

  function yard() {
    const freeTrucks = data.trucks.filter((t) => !t.use.length);
    const custTrucks = data.trucks.filter((t) => t.use.some((u) => !u.own));
    const siteTrucks = data.trucks.filter((t) => t.use.some((u) => u.own));
    const yardMachines = data.equipment.filter((e) => !e.site_id && !e.in_shop);
    const siteMachines = data.equipment.filter((e) => e.site_id);
    const shop = data.equipment.filter((e) => e.in_shop);
    const list = (xs, f) => xs.map(f).join(', ') || '<span class="muted">none</span>';
    return `<div class="yard">
      <div><span class="lbl">Trucks free</span> ${list(freeTrucks, (t) => esc(t.unit))}</div>
      <div><span class="lbl">Out to customers</span> ${list(custTrucks, (t) => esc(t.unit))}</div>
      <div><span class="lbl">At our sites</span> ${list(siteTrucks, (t) => esc(t.unit))}</div>
      <div><span class="lbl">Machines in the yard</span> ${list(yardMachines, (e) => esc(e.name))}</div>
      <div><span class="lbl">Machines at sites</span> ${list(siteMachines, (e) => `${esc(e.name)} <span class="muted">(${esc(e.at)} since ${esc(e.since_label)})</span>`)}</div>
      ${shop.length ? `<div><span class="lbl">In the shop</span> ${list(shop, (e) => esc(e.name))}</div>` : ''}
    </div>`;
  }

  function render() {
    const replied = data.sites.filter((s) => s.day?.replied_at).length;
    const asked = data.sites.filter((s) => s.day?.asked_at).length;
    root.innerHTML = `<div class="sites-page">
      <div class="sites-top">
        <div class="day-nav"><button class="btn" data-day="-1" aria-label="Day before">‹</button>
          <input type="date" value="${day}" data-pick aria-label="Day">
          <button class="btn" data-day="1" aria-label="Day after">›</button>
          ${day !== data.next_work_day ? `<button class="btn" data-goto="${data.next_work_day}">Next work day</button>` : ''}</div>
        <h2>${esc(dateLong(day))}</h2>
        <div class="row-actions"><button class="btn" data-print>Print</button></div>
      </div>
      <div class="site-steps">
        <div class="sstep">
          <button class="btn" data-ask-all>1 · Ask site heads what they need</button>
          <span>Texts each site head "what do you need on ${esc(dateLong(day).split(',')[0])}?"${data.ask_time ? ` Goes out by itself at ${esc(hm12(data.ask_time))} on work days; use this to send it now.` : ' (The automatic afternoon text is off: Setup → Our sites.)'}</span>
        </div>
        <div class="sstep">
          <button class="btn primary" data-confirm-all ${data.sites.some((s) => s.given || s.day?.status === 'nothing') ? '' : 'disabled title="Give at least one site what it needs and Save first"'}>2 · Tell site heads what they're getting</button>
          <span>After you've saved each site: texts each site head their list. Drivers are told in the morning.</span>
        </div>
      </div>
      <p class="muted small">${data.sites.length} site${data.sites.length === 1 ? '' : 's'} · asked ${asked} · replied ${replied}</p>
      ${data.sites.length ? '' : '<div class="empty">No sites yet. Add site heads and sites under Setup → Our sites.</div>'}
      <div class="site-grid">${data.sites.map(siteCard).join('')}</div>
      <datalist id="dl-site-mat">${(data.materials || []).map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      ${yard()}
    </div>`;
  }

  function cardEdit(el) { const card = el.closest('[data-site]'); return card ? [Number(card.dataset.site), edits.get(Number(card.dataset.site))] : [null, null]; }
  function dirty(id) { const e = edits.get(id); e.dirty = true; render(); }

  document.addEventListener('click', async (ev) => {
    if (!root || !root.contains(ev.target)) return;
    const t = ev.target;
    const [id, e] = cardEdit(t);
    try {
      if (t.closest('[data-day]')) return load(addDays(day, Number(t.closest('[data-day]').dataset.day)));
      if (t.closest('[data-goto]')) return load(t.closest('[data-goto]').dataset.goto);
      if (t.closest('[data-print]')) return window.print();
      if (t.closest('[data-ask-all]')) {
        const out = await api('/sites/ask', { method: 'POST', body: { day } });
        toast(`Texted ${out.results.filter((r) => r.ok).length} site head(s) about ${dateLong(day)}`);
        return load(day);
      }
      if (t.closest('[data-ask]')) {
        await api('/sites/ask', { method: 'POST', body: { day, site_ids: [Number(t.closest('[data-ask]').dataset.ask)] } });
        toast('Texted'); return load(day);
      }
      if (t.closest('[data-confirm-all]')) {
        if ([...edits.values()].some((x) => x.dirty)) return toast('Save the sites you changed first');
        const out = await api('/sites/confirm', { method: 'POST', body: { day } });
        toast(out.results.length ? `Sent ${out.results.filter((r) => r.ok).length} site head confirmation(s). Drivers get their jobs in the morning text.`
          : 'Nothing to confirm yet — give the sites what they need first');
        return load(day);
      }
      if (t.closest('[data-open-job]')) { ev.preventDefault(); return A.openJobForm(await api('/jobs/' + t.closest('[data-open-job]').dataset.openJob)); }
      if (!e) return;
      if (t.closest('[data-add-truck]')) { e.trucks.push({ truck_id: '', driver_id: '' }); return dirty(id); }
      if (t.closest('[data-rm-truck]')) { e.trucks.splice(Number(t.closest('[data-rm-truck]').dataset.rmTruck), 1); return dirty(id); }
      if (t.closest('[data-rm-machine]')) { e.equipment = e.equipment.filter((x) => x !== Number(t.closest('[data-rm-machine]').dataset.rmMachine)); return dirty(id); }
      if (t.closest('[data-rm-lab]')) { e.labourers = e.labourers.filter((x) => x !== Number(t.closest('[data-rm-lab]').dataset.rmLab)); return dirty(id); }
      if (t.closest('[data-yard]')) {
        const m = data.equipment.find((x) => x.id === Number(t.closest('[data-yard]').dataset.yard));
        if (!confirm(`Send ${m?.name || 'this machine'} back to the yard on ${dateLong(day)}? A float work order is made to bring it.`)) return;
        const job = await api(`/sites/${id}/yard`, { method: 'POST', body: { day, equipment_id: m.id } });
        toast(`Back to the yard: float work order #${job.id} — pick the float truck and driver on the board`);
        return load(day);
      }
      if (t.closest('[data-float]')) {
        const job = await api(`/sites/${id}/float`, { method: 'POST', body: { day, equipment_id: Number(t.closest('[data-float]').dataset.float) } });
        toast(`Float booked: work order #${job.id} — pick the float truck and driver on the board`);
        return load(day);
      }
      if (t.closest('[data-save]')) {
        const missing = e.trucks.some((x) => !x.driver_id);
        if (missing) return toast('Pick a driver for each truck (or remove the row)');
        const saved = await api(`/sites/${id}/give`, { method: 'POST', body: { day, trucks: e.trucks.map(({ truck_id, driver_id, material, loads }) => ({ truck_id, driver_id, material, loads })), equipment: e.equipment, labourers: e.labourers, note: e.note } });
        const f = saved.floats || { made: [], dropped: [] };
        toast(['Saved — the drivers are told in the morning jobs text',
          f.made.length ? `Float work order${f.made.length === 1 ? '' : 's'} made to deliver the machine${f.made.length === 1 ? '' : 's'}: ${f.made.map((j) => '#' + j.id).join(', ')} — pick the float truck and driver on the board` : '',
          f.dropped.length ? `Float${f.dropped.length === 1 ? '' : 's'} no longer needed, removed: ${f.dropped.map((n) => '#' + n).join(', ')}` : ''].filter(Boolean).join('. '));
        return load(day);
      }
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('change', (ev) => {
    if (!root || !root.contains(ev.target)) return;
    const t = ev.target;
    if (t.matches('[data-pick]') && t.value) return load(t.value);
    const [id, e] = cardEdit(t);
    if (!e) return;
    if (t.matches('[data-truck], [data-driver]')) {
      const row = e.trucks[Number(t.closest('[data-i]').dataset.i)];
      if (t.matches('[data-truck]')) row.truck_id = t.value ? Number(t.value) : '';
      else {
        row.driver_id = t.value ? Number(t.value) : '';
        const p = data.people.find((x) => x.id === row.driver_id);
        if (p?.default_truck_id && !row.truck_id) row.truck_id = p.default_truck_id; // their usual truck
      }
      return dirty(id);
    }
    if (t.matches('[data-add-machine]') && t.value) { e.equipment.push(Number(t.value)); return dirty(id); }
    if (t.matches('[data-add-lab]') && t.value && !e.labourers.includes(Number(t.value))) { e.labourers.push(Number(t.value)); return dirty(id); }
  });
  document.addEventListener('input', (ev) => {
    if (!root || !root.contains(ev.target) || !ev.target.matches('[data-note], [data-mat], [data-loads]')) return;
    const [, e] = cardEdit(ev.target);
    if (ev.target.matches('[data-note]')) e.note = ev.target.value;
    else {
      const row = e.trucks[Number(ev.target.closest('[data-i]').dataset.i)];
      if (ev.target.matches('[data-mat]')) row.material = ev.target.value; else row.loads = ev.target.value;
    }
    if (!e.dirty) { e.dirty = true; const b = ev.target.closest('[data-site]').querySelector('[data-save]'); b.disabled = false; b.textContent = 'Save'; }
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

  window.SITES = { mount, mountSetup, reload: () => root && load(day) };
})();
