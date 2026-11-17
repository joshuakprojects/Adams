/* Board → 🗺 Plan route: the day's pump-outs (or other work orders) in the shortest order from the yard.
   Uses app.js (window.APP). Saving the order puts the Board, the work order list and the drivers' day text in it. */
(function () {
  const A = window.APP;
  if (!A) return;
  const { api, esc, toast } = A;
  const $ = (s) => document.querySelector(s);
  const dialog = $('#route-dialog');
  const form = $('#route-form');
  if (!dialog || !form) return;
  const TYPES = window.FORMS?.TYPES || {};
  const ROUTABLE = ['septic', 'toilet', 'bin', 'haul', 'misc'];
  const SLOT = { first: 'First thing', am: 'AM', pm: 'PM', any: 'Any time' };
  const dateLong = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`);
  let plan = null;

  $('#route-types').innerHTML = ROUTABLE.map((k) => `<label class="check"><input type="checkbox" name="types" value="${k}" ${k === 'septic' ? 'checked' : ''}>
    ${esc(TYPES[k]?.icon || '')} ${esc(TYPES[k]?.name || k)}</label>`).join('');

  async function run() {
    const f = form.elements;
    const types = [...form.querySelectorAll('input[name=types]:checked')].map((c) => c.value);
    if (!types.length) return toast('Tick at least one kind of work order');
    $('#route-body').innerHTML = '<p class="muted">Working out the shortest route…</p>';
    const q = new URLSearchParams({ date: f.date.value, types: types.join(','), ...(f.driver.value ? { driver: f.driver.value } : {}) });
    plan = await api('/routes/plan?' + q);
    const keep = f.driver.value;
    f.driver.innerHTML = '<option value="">Everyone\'s jobs</option>' + plan.drivers.map((d) => `<option value="${d.id}">${esc(d.name)} (${d.jobs})</option>`).join('');
    f.driver.value = plan.drivers.some((d) => String(d.id) === keep) ? keep : '';
    render();
  }

  function render() {
    const p = plan;
    $('#route-title').textContent = `Plan route · ${dateLong(p.date)}`;
    if (!p.stops.length) {
      $('#route-body').innerHTML = `<p class="muted">No open work orders of that kind on ${esc(dateLong(p.date))}${p.unplaced.length ? ' with an address on the map' : ''}.</p>${unplaced(p)}`;
      return;
    }
    const saved = p.stops.some((s) => s.current != null);
    const how = p.method === 'google' ? 'Order chosen by Google on real roads.'
      : p.road ? 'Kept customers\' times (First thing, AM, PM, Any time); the order inside each is the shortest on the map, and Google measured the roads.'
        : 'Kept customers\' times (First thing, AM, PM, Any time). Distances are estimates from the map.';
    const saving = p.straight_before_km - p.straight_after_km;
    $('#route-body').innerHTML = `
      <div class="sum-tiles route-tiles">
        <div class="sum-tile"><span>Stops</span><b>${p.stops.length}</b></div>
        <div class="sum-tile"><span>Driving</span><b>${p.total_km} km</b><small>${p.road ? 'by road' : 'estimate'}</small></div>
        <div class="sum-tile"><span>Drive time</span><b>${hm(p.total_min)}</b><small>not counting time at each stop</small></div>
        <div class="sum-tile"><span>Shorter by</span><b>${saving > 0.5 ? Math.round(saving) + ' km' : '—'}</b><small>than the Board's order</small></div>
      </div>
      <p class="muted small">${how}</p>
      <ol class="route-list">
        <li class="yard"><span class="n">⌂</span><div><b>Yard</b><div class="muted small">${esc(p.yard)}</div></div></li>
        ${p.stops.map((s) => `<li><span class="n">${s.n}</span><div><b>#${s.id} ${esc(s.customer || '')}</b> <span class="pill">${SLOT[s.slot]}</span>
          <div class="muted small">${esc(s.address)}${s.drivers.length ? ` · ${esc(s.drivers.join(', '))}` : ' · no driver yet'}</div></div>
          <span class="leg">${s.leg_km} km · ${hm(s.leg_min)}</span></li>`).join('')}
        <li class="yard"><span class="n">⌂</span><div><b>Back to the yard</b></div><span class="leg">${p.back_km} km · ${hm(p.back_min)}</span></li>
      </ol>
      ${unplaced(p)}
      <div class="row-actions route-actions">
        <button class="btn primary" id="route-save">${saved ? 'Save this order (replaces the saved one)' : 'Save this order'}</button>
        ${p.maps_links.map((u, i) => `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">Open in Google Maps${p.maps_links.length > 1 ? ` (part ${i + 1})` : ''} ↗</a>`).join('')}
      </div>
      <p class="muted small">Saving puts the Board and the drivers' day text in this order. It doesn't change anyone's time of day or text anyone.</p>`;
  }
  function unplaced(p) {
    return p.unplaced.length ? `<div class="note-warn">Not on the map, so left out: ${p.unplaced.map((s) => `#${s.id} ${esc(s.customer || '')} (${esc(s.address || 'no address')})`).join(', ')}.
      Open the work order and check the address, or drop a pin.</div>` : '';
  }

  $('#route-btn')?.addEventListener('click', () => {
    form.elements.date.value = A.state.date || A.state.today;
    form.elements.driver.value = '';
    $('#route-body').innerHTML = '';
    dialog.showModal();
    run().catch((err) => toast(err.message));
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); run().catch((err) => toast(err.message)); });
  form.elements.date.addEventListener('change', () => { form.elements.driver.value = ''; });
  dialog.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close-route]') || e.target === dialog) return dialog.close();
    if (!e.target.closest('#route-save') || !plan) return;
    try {
      const out = await api('/routes/save', { method: 'POST', body: { date: plan.date, ids: plan.stops.map((s) => s.id) } });
      toast(`Route saved: ${out.saved} stop${out.saved === 1 ? '' : 's'} in order on the Board`);
      dialog.close();
      document.dispatchEvent(new CustomEvent('board-refresh'));
    } catch (err) { toast(err.message); }
  });
})();
