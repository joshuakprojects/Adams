/* Prices tab, price panel in the job form, Customer questions, and Logins (owner). Uses app.js (window.APP). */
(() => {
  const A = window.APP;
  const { api, esc, toast, $, $$, state, form } = A;
  const P = window.PRICING;
  const money = (n) => (n == null || n === '' ? '—' : P.money(n));
  const qtyText = (n) => String(Number(n || 0)).replace(/\.0+$/, '');

  // ---------- price book ----------
  let book = null;
  async function getBook(force = false) {
    if (!book || force) book = await api('/prices/book');
    return book;
  }
  const BIN_SIZES = ['4 yd H&G', '6 yd H&G', '8 yd H&G', '10 yd H&G', '12 yd H&G', '14 yd H&G', '15 yd H&G', '15 yd', '20 yd', '30 yd', '40 yd'];
  function groups(prefix) {
    if (!book) return [];
    const seen = [];
    for (const [k, it] of Object.entries(book.items)) {
      if (k.startsWith(prefix) && it.grp && !seen.includes(it.grp)) seen.push(it.grp);
    }
    return seen;
  }
  function suggestionsFor(type) {
    if (type === 'haul') return groups('agg.');
    if (type === 'bin') return BIN_SIZES;
    if (type === 'toilets') return groups('toilet.');
    return [];
  }
  function fillPriceList() {
    $('#dl-prices').innerHTML = Object.entries(book.items).map(([k, it]) =>
      `<option value="${esc(it.name)}">${it.price == null ? 'price by hand' : esc(P.money(it.price) + (it.unit ? ' / ' + it.unit : ''))}</option>`).join('');
  }
  getBook().then(() => { fillPriceList(); A.fillWhatList(A.currentType()); }).catch(() => {});

  // ---------- distance ----------
  const distanceReady = () => Boolean(state.maps?.distance);
  async function measure({ address, lat, lng, from }) {
    return api('/distance', { method: 'POST', body: { address, lat, lng, from } });
  }

  // ---------- drop a pin ----------
  const pin = { map: null, marker: null, point: null, done: null };
  async function openPin(start, done) {
    if (!state.maps?.key) {
      toast('The map needs the Google Maps key (see Setup / README). You can type the km instead.');
      return;
    }
    pin.done = done;
    pin.point = start && start.lat != null ? { lat: Number(start.lat), lng: Number(start.lng) } : null;
    $('#pin-use').disabled = !pin.point;
    $('#pin-status').textContent = pin.point ? 'Pin placed — click elsewhere to move it.' : '';
    $('#pin-dialog').showModal();
    try {
      await A.loadGoogleMaps();
      const { Map } = await google.maps.importLibrary('maps');
      const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
      if (!pin.map) {
        pin.map = new Map($('#pin-map'), { center: { lat: 45.3469, lng: -80.0353 }, zoom: 10, mapId: state.maps.mapId,
          streetViewControl: false, mapTypeControl: true, mapTypeId: 'hybrid', gestureHandling: 'greedy' });
        pin.marker = new AdvancedMarkerElement({ map: null, gmpDraggable: true });
        const set = (ll) => {
          pin.point = { lat: ll.lat(), lng: ll.lng() };
          pin.marker.position = pin.point;
          pin.marker.map = pin.map;
          $('#pin-use').disabled = false;
          $('#pin-status').textContent = 'Pin placed — drag it or click elsewhere to move it.';
        };
        pin.map.addListener('click', (e) => e.latLng && set(e.latLng));
        pin.marker.addListener('dragend', () => {
          const p = pin.marker.position;
          pin.point = { lat: typeof p.lat === 'function' ? p.lat() : p.lat, lng: typeof p.lng === 'function' ? p.lng() : p.lng };
        });
      }
      if (pin.point) {
        pin.marker.position = pin.point;
        pin.marker.map = pin.map;
        pin.map.setCenter(pin.point);
        pin.map.setZoom(15);
      } else {
        pin.marker.map = null;
      }
    } catch (err) {
      $('#pin-map').innerHTML = `<div class="map-setup">${esc(err.message)}</div>`;
    }
  }
  $$('[data-close-pin]').forEach((b) => b.addEventListener('click', () => $('#pin-dialog').close()));
  $('#pin-use').addEventListener('click', () => {
    $('#pin-dialog').close();
    if (pin.point && pin.done) pin.done(pin.point);
  });

  /** The distance line shown in the job form and the calculator. */
  function distanceHtml(d, { error = '', busy = false } = {}) {
    const start = d.from || book?.start_address || '116 William St';
    const startShort = start.split(',')[0];
    let main;
    if (busy) main = '<span class="muted">Working out the driving distance…</span>';
    else if (d.km != null && d.km !== '') {
      const how = d.mode === 'pin' ? 'to the map pin' : d.mode === 'manual' ? '(typed in by hand)' : '';
      main = `🚚 <b>${esc(qtyText(d.km))} km</b> from ${esc(startShort)} ${how}${Number(d.in_town) ? ' · <b>inside Parry Sound town limits</b>' : ''}`;
    } else main = '<span class="muted">🚚 Delivery distance: enter the address</span>';
    return `<div class="dist-main">${main}</div>
      ${error ? `<div class="dist-error">${esc(error)}</div>` : ''}
      <div class="dist-acts">
        <button type="button" class="link" data-dist="lookup">${d.km != null && d.km !== '' ? 'Look up again' : 'Look up distance'}</button>
        <button type="button" class="link" data-dist="pin">📍 No address yet? Drop a pin</button>
        <button type="button" class="link" data-dist="km">Type the km</button>
        <button type="button" class="link" data-dist="from" title="Starting point: ${esc(start)}">From: ${esc(startShort)} (change)</button>
      </div>`;
  }

  // =====================================================================
  // Job form: price panel
  // =====================================================================
  const F = { lines: [], opts: {}, notes: [], error: '', busy: false };
  const fv = (n) => form.elements[n]?.value ?? '';

  function formDistance() {
    return { km: fv('distance_km'), from: fv('distance_from'), mode: fv('distance_mode'), in_town: fv('in_town') };
  }
  function setFormDistance(r) {
    form.elements.distance_km.value = r.km ?? '';
    form.elements.distance_from.value = r.from || '';
    form.elements.distance_mode.value = r.mode || '';
    form.elements.in_town.value = r.in_town == null ? '' : r.in_town ? 1 : 0;
  }
  function jobFromForm() {
    return {
      job_type: A.currentType(), material: fv('material'), quantity: fv('quantity'), loads_planned: fv('loads_planned'),
      municipality: fv('municipality'), details: A.collectDetails(), distance_km: fv('distance_km'), in_town: fv('in_town'), price_options: F.opts,
    };
  }

  function openForm(job) {
    F.lines = (job.lines || []).map((l) => ({ ...l }));
    F.opts = { ...(job.price_options || {}) };
    F.notes = [];
    F.error = '';
    F.legacy = !F.lines.length && job.quoted_price ? job.quoted_price : '';
    form.elements.pin_lat.value = '';
    form.elements.pin_lng.value = '';
    renderOpts();
    // New work orders are priced straight away; saved ones keep their price until something is changed.
    if (!job.id && !F.lines.length) recalc();
    else renderLines();
    renderFormDist();
  }

  function collect() {
    return {
      lines: F.lines.map(({ id, job_id, ...l }) => l),
      price_options: F.opts,
    };
  }

  function recalc() {
    if (!book) return getBook().then(recalc);
    const { lines, notes } = P.calc(jobFromForm(), book);
    F.lines = P.merge(F.lines, lines, F.opts.removed_slots || []);
    F.notes = notes;
    renderLines();
  }

  function renderFormDist() {
    $('#f-dist').innerHTML = distanceHtml(formDistance(), { error: F.error, busy: F.busy });
  }

  async function lookupFormDistance(point) {
    const address = [fv('to_location'), fv('municipality')].filter(Boolean).join(', ');
    if (!point && !fv('to_location').trim()) { F.error = 'Enter the delivery address first, or drop a pin.'; renderFormDist(); return; }
    if (!distanceReady()) {
      F.error = 'Distance lookups aren\'t set up yet (an admin adds the Google server key). Type the km for now.';
      renderFormDist();
      return;
    }
    F.busy = true; F.error = ''; renderFormDist();
    try {
      const r = await measure({ address: point ? undefined : address, lat: point?.lat, lng: point?.lng, from: fv('distance_from') || book?.start_address });
      setFormDistance(r);
      if (point) { form.elements.pin_lat.value = point.lat; form.elements.pin_lng.value = point.lng; }
      if (!fv('municipality') && r.municipality) form.elements.municipality.value = r.municipality;
    } catch (err) {
      F.error = err.message;
    }
    F.busy = false;
    renderFormDist();
    recalc();
  }

  $('#f-dist').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dist]');
    if (!b) return;
    const act = b.dataset.dist;
    if (act === 'lookup') lookupFormDistance();
    if (act === 'pin') {
      const lat = fv('pin_lat');
      openPin(lat ? { lat, lng: fv('pin_lng') } : null, (p) => lookupFormDistance(p));
    }
    if (act === 'km') {
      const v = prompt('Driving distance in km (from the starting point):', fv('distance_km'));
      if (v === null) return;
      const km = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(km) || km < 0) return toast('Type a number of km, e.g. 23.5');
      const inTown = km <= 5 && confirm('Is the job inside Parry Sound town limits?');
      setFormDistance({ km, from: fv('distance_from') || book?.start_address, mode: 'manual', in_town: inTown ? 1 : 0 });
      F.error = '';
      renderFormDist();
      recalc();
    }
    if (act === 'from') {
      const v = prompt('Measure the distance from (starting address):', fv('distance_from') || book?.start_address || '');
      if (v === null || !v.trim()) return;
      form.elements.distance_from.value = v.trim();
      lookupFormDistance();
    }
  });

  // Address typed or changed → driving distance; work order details changed → re-price.
  let recalcTimer;
  form.addEventListener('change', (e) => {
    const n = e.target.name || '';
    if (n === 'to_location' || (n === 'municipality' && fv('distance_mode') !== 'pin')) {
      if (fv('to_location').trim() && fv('distance_mode') !== 'manual') lookupFormDistance();
      else recalc();
      return;
    }
    if (n === 'job_type') { F.opts = {}; renderOpts(); }
    if (n === 'job_type' || n === 'material' || n === 'loads_planned' || n === 'quantity' || n.startsWith('d.')) {
      clearTimeout(recalcTimer);
      recalcTimer = setTimeout(recalc, 100);
    }
  });
  form.addEventListener('input', (e) => {
    const n = e.target.name || '';
    if (n === 'loads_planned' || n === 'quantity' || (n.startsWith('d.') && e.target.type === 'number')) {
      clearTimeout(recalcTimer);
      recalcTimer = setTimeout(recalc, 400);
    }
  });

  // Choices that change the price but aren't on the paper form.
  function optionsHtml(type, o, prefix) {
    const chk = (k, label) => `<label class="check-field"><input type="checkbox" name="${prefix}${k}" ${o[k] ? 'checked' : ''}> ${label}</label>`;
    const sel = (k, label, opts) => `<label>${label}<select name="${prefix}${k}">${opts.map(([v, t]) =>
      `<option value="${v}" ${String(o[k] ?? opts[0][0]) === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    const numIn = (k, label, ph = '') => `<label>${label}<input type="number" min="0" step="0.01" name="${prefix}${k}" value="${esc(o[k] ?? '')}" placeholder="${ph}"></label>`;
    if (type === 'bin') {
      return sel('waste', 'Waste type', [['mixed', 'Mixed waste'], ['concrete', 'Clean concrete'], ['asbestos', 'Asbestos'], ['metal', 'Clean metal only']]) +
        numIn('tons', 'Tons (from scale ticket)', 'when known') + numIn('extra_weeks', 'Weeks rented after the first', '0');
    }
    if (type === 'septic') {
      return sel('member', 'Lagoon member?', [['auto', 'By municipality'], ['yes', 'Yes — member rate'], ['no', 'No — non-member rate']]) +
        chk('pump_chamber_too', 'Also pump the pump chamber (+$100)') + chk('off_schedule', 'Off-schedule pump-out (+$100)');
    }
    if (type === 'toilet') {
      return sel('period', 'Rental', [['week', 'Weekly (1 day up to 1 week)'], ['month', 'Monthly (28 days)']]) + chk('off_schedule', 'Off-schedule (+$100)');
    }
    return '';
  }
  function readOptions(root, prefix, into) {
    for (const el of $$(`[name^="${prefix}"]`, root)) {
      const k = el.name.slice(prefix.length);
      if (el.type === 'checkbox') { if (el.checked) into[k] = true; else delete into[k]; } else if (el.value === '' || el.value === 'auto') delete into[k];
      else into[k] = el.type === 'number' ? Number(el.value) : el.value;
    }
    return into;
  }
  function renderOpts() {
    $('#f-price-opts').innerHTML = optionsHtml(A.currentType(), F.opts, 'po.');
  }
  $('#f-price-opts').addEventListener('change', () => { readOptions($('#f-price-opts'), 'po.', F.opts); recalc(); });
  $('#f-price-opts').addEventListener('input', (e) => {
    if (e.target.type !== 'number') return;
    readOptions($('#f-price-opts'), 'po.', F.opts);
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(recalc, 400);
  });

  function linesTable(lines, { editable }) {
    const t = P.totals(lines, book?.hst_rate ?? 13);
    const rows = lines.map((l, i) => {
      const amt = l.unit_price == null || l.unit_price === '' ? '<span class="need-price">price?</span>' : money(P.amount(l));
      const desc = `${esc(l.description)}${l.note ? `<div class="muted small">${esc(l.note)}</div>` : ''}${l.kind === 'deposit' ? '<div class="muted small">deposit — collected separately, not in the total</div>' : ''}${Number(l.taxable) ? '' : '<div class="muted small">no HST</div>'}`;
      if (!editable) {
        return `<tr><td>${desc}</td><td class="num">${esc(qtyText(l.qty))} ${esc(l.unit || '')}</td><td class="num">${l.unit_price == null ? '—' : money(l.unit_price)}</td><td class="num">${amt}</td></tr>`;
      }
      return `<tr data-line="${i}" class="${Number(l.auto) ? 'auto' : 'manual'}">
        <td>${desc}${Number(l.auto) ? '' : ' <span class="badge-edit" title="Added or changed by hand — kept when the price is recalculated">by hand</span>'}</td>
        <td class="num"><input name="ln.qty" type="number" min="0" step="0.01" value="${esc(qtyText(l.qty))}" aria-label="Quantity"> <span class="muted small">${esc(l.unit || '')}</span></td>
        <td class="num"><input name="ln.price" inputmode="decimal" value="${l.unit_price == null ? '' : esc(String(l.unit_price))}" placeholder="$" aria-label="Price each"></td>
        <td class="num amt">${amt}</td>
        <td><button type="button" class="link" data-line-del="${i}" aria-label="Remove line" title="Remove">✕</button></td></tr>`;
    }).join('');
    return `<table class="table lines-table"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th>${editable ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${editable ? 5 : 4}" class="muted">No prices yet.</td></tr>`}</tbody></table>
      <div class="totals">
        <div><span>Subtotal</span><b>${money(t.subtotal)}</b></div>
        <div><span>HST ${esc(String(book?.hst_rate ?? 13))}%</span><b>${money(t.hst)}</b></div>
        <div class="grand"><span>Total</span><b>${money(t.total)}</b></div>
        ${t.deposit ? `<div class="deposit"><span>Deposit to collect</span><b>${money(t.deposit)}</b></div>` : ''}
        ${t.unpriced ? `<div class="warn">${t.unpriced} line${t.unpriced > 1 ? 's' : ''} still need a price</div>` : ''}
      </div>`;
  }

  function renderLines() {
    const notes = F.notes.length ? `<ul class="price-notes">${F.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
    $('#f-lines').innerHTML = `${F.legacy ? `<p class="muted small">Price typed by hand before the price book: <b>${esc(F.legacy)}</b></p>` : ''}
      ${notes}${linesTable(F.lines, { editable: true })}
      <div class="add-line">
        <input id="f-add-line" list="dl-prices" placeholder="Add from the price book, or type an extra charge…" aria-label="Add a price line">
        <button type="button" class="btn" id="f-add-btn">Add</button>
        <button type="button" class="link" id="f-reprice" title="Throw away changes made by hand and use the price book">Reset to price book</button>
      </div>`;
  }

  $('#f-lines').addEventListener('input', (e) => {
    const tr = e.target.closest('[data-line]');
    if (!tr) return;
    const l = F.lines[Number(tr.dataset.line)];
    if (e.target.name === 'ln.qty') l.qty = Number(e.target.value) || 0;
    if (e.target.name === 'ln.price') {
      const v = e.target.value.replace(/[$,\s]/g, '');
      l.unit_price = v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    }
    l.auto = 0; // changed by hand: kept when the price is worked out again
    tr.classList.replace('auto', 'manual');
    $('.amt', tr).innerHTML = l.unit_price == null ? '<span class="need-price">price?</span>' : money(P.amount(l));
    const t = P.totals(F.lines, book?.hst_rate ?? 13);
    const box = $('#f-lines .totals');
    const vals = $$('b', box);
    vals[0].textContent = money(t.subtotal);
    vals[1].textContent = money(t.hst);
    vals[2].textContent = money(t.total);
  });
  $('#f-lines').addEventListener('change', (e) => { if (e.target.closest('[data-line]')) renderLines(); });
  $('#f-lines').addEventListener('click', (e) => {
    const del = e.target.closest('[data-line-del]');
    if (del) {
      const [l] = F.lines.splice(Number(del.dataset.lineDel), 1);
      if (l.slot) F.opts.removed_slots = [...new Set([...(F.opts.removed_slots || []), l.slot])];
      renderLines();
    }
    if (e.target.id === 'f-add-btn') addLine();
    if (e.target.id === 'f-reprice') {
      F.lines = F.lines.filter((l) => !l.slot && !Number(l.auto));
      delete F.opts.removed_slots;
      recalc();
    }
  });
  $('#f-lines').addEventListener('keydown', (e) => {
    if (e.target.id === 'f-add-line' && e.key === 'Enter') { e.preventDefault(); addLine(); }
  });
  function addLine() {
    const input = $('#f-add-line');
    const text = input.value.trim();
    if (!text) return;
    const hit = Object.entries(book.items).find(([, it]) => it.name.toLowerCase() === text.toLowerCase());
    F.lines.push(hit
      ? { item_key: hit[0], description: hit[1].name, qty: 1, unit: hit[1].unit, unit_price: hit[1].price, taxable: hit[1].taxable ? 1 : 0, kind: 'charge', auto: 0, slot: '', note: '' }
      : { item_key: '', description: text, qty: 1, unit: '', unit_price: null, taxable: 1, kind: 'charge', auto: 0, slot: '', note: '' });
    renderLines();
    $('#f-lines tbody tr:last-child input[name="ln.price"]')?.focus();
  }

  // =====================================================================
  // Prices tab: calculator + price lists
  // =====================================================================
  const Q = { type: 'haul', opts: {}, dist: {}, error: '', busy: false, f: {} };
  let priceData = null;
  const pending = new Map(); // id -> changes

  function quoteFieldsHtml() {
    const f = Q.f;
    const radios = (k, opts) => `<div class="choice-row">${opts.map((o) =>
      `<label class="pill"><input type="radio" name="q.${k}" value="${esc(o)}" ${f[k] === o ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`;
    const input = (k, label, attrs = '') => `<label>${label}<input name="q.${k}" value="${esc(f[k] ?? '')}" ${attrs}></label>`;
    const select = (k, label, opts) => `<label>${label}<select name="q.${k}"><option value="">—</option>${opts.map((o) =>
      `<option ${f[k] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    if (Q.type === 'haul') {
      return `<label class="wide">Material<select name="q.material"><option value="">Pick a material…</option>${groups('agg.').map((g) =>
        `<option ${f.material === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
        <div class="wide"><span class="cl">Truck</span>${radios('truck', ['Tandem', 'Triaxle', 'By the yard'])}</div>
        ${f.truck === 'By the yard' ? input('yards', '# of yards', 'type="number" min="0"') : input('loads', '# of loads', 'type="number" min="0"')}`;
    }
    if (Q.type === 'bin') {
      return select('size', 'Bin size', BIN_SIZES) + select('service', 'Service', ['Deliver bin', 'Empty & return', 'Empty & no return', 'H&G']) +
        `<div class="wide grid">${optionsHtml('bin', Q.opts, 'qo.')}</div>`;
    }
    if (Q.type === 'septic') {
      return input('gallons', 'Approx. tank size (gallons)', 'type="number" min="0" placeholder="e.g. 1000"') +
        select('tank_type', 'Type of tank', ['Septic', 'Holding', 'Pump chamber']) + `<div class="wide grid">${optionsHtml('septic', Q.opts, 'qo.')}</div>`;
    }
    return select('toilet', 'Type of toilet', groups('toilet.')) + input('qty', 'How many', 'type="number" min="1" placeholder="1"') +
      select('trip', 'This trip', ['Deliver', 'Service']) + `<div class="wide grid">${optionsHtml('toilet', Q.opts, 'qo.')}</div>`;
  }

  function quoteJob() {
    const qf = $('#quote-form').elements;
    const f = Q.f;
    const base = { job_type: Q.type, municipality: qf.municipality.value.trim(), to_location: qf.to_location.value.trim(),
      distance_km: Q.dist.km, in_town: Q.dist.in_town, distance_from: Q.dist.from || '', distance_mode: Q.dist.mode || '', price_options: { ...Q.opts } };
    if (Q.type === 'haul') {
      const byYard = f.truck === 'By the yard';
      return { ...base, material: f.material || '', loads_planned: byYard ? '' : f.loads || '', quantity: byYard ? f.yards || '' : '',
        details: { direction: 'Deliver to site', ...(byYard ? {} : { truck: f.truck || '' }) } };
    }
    if (Q.type === 'bin') return { ...base, material: f.size || '', details: { service: f.service || 'Deliver bin' } };
    if (Q.type === 'septic') return { ...base, details: { tank_size: f.gallons ? `${f.gallons} gal` : '', tank_type: f.tank_type || '' } };
    return { ...base, details: { trip: f.trip || 'Deliver', toilet1_type: f.toilet || '', toilet1_qty: f.qty || (f.toilet ? 1 : '') } };
  }

  function renderQuote() {
    if (!book) return;
    $('#q-fields').innerHTML = quoteFieldsHtml();
    $('#q-dist').innerHTML = distanceHtml(Q.dist, { error: Q.error, busy: Q.busy });
    renderQuoteResult();
  }
  function renderQuoteResult() {
    const job = quoteJob();
    const { lines, notes } = P.calc(job, book);
    Q.lines = lines;
    const t = P.totals(lines, book.hst_rate);
    $('#q-result').innerHTML = `${notes.length ? `<ul class="price-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${lines.length ? linesTable(lines, { editable: false }) : ''}
      ${lines.length ? `<div class="row-actions quote-acts"><button class="btn primary" type="button" id="q-make">Turn into a work order →</button>
        <span class="muted small">Total ${money(t.total)} incl. HST</span></div>` : ''}`;
  }

  $('#q-type').addEventListener('change', (e) => {
    Q.type = e.target.value;
    Q.f = {};
    Q.opts = {};
    renderQuote();
  });
  $('#q-fields').addEventListener('change', (e) => {
    const n = e.target.name || '';
    if (n.startsWith('q.')) Q.f[n.slice(2)] = e.target.value;
    if (n.startsWith('qo.')) readOptions($('#q-fields'), 'qo.', Q.opts);
    if (n === 'q.truck') renderQuote(); else renderQuoteResult();
  });
  $('#q-fields').addEventListener('input', (e) => {
    const n = e.target.name || '';
    if (e.target.type !== 'number') return;
    if (n.startsWith('q.')) Q.f[n.slice(2)] = e.target.value;
    if (n.startsWith('qo.')) readOptions($('#q-fields'), 'qo.', Q.opts);
    renderQuoteResult();
  });

  async function lookupQuoteDistance(point) {
    const qf = $('#quote-form').elements;
    const address = [qf.to_location.value.trim(), qf.municipality.value.trim()].filter(Boolean).join(', ');
    if (!point && !qf.to_location.value.trim()) { Q.error = 'Enter the address first, or drop a pin.'; renderQuote(); return; }
    if (!distanceReady()) { Q.error = 'Distance lookups aren\'t set up yet (an admin adds the Google server key). Type the km for now.'; renderQuote(); return; }
    Q.busy = true; Q.error = ''; renderQuote();
    try {
      Q.dist = await measure({ address: point ? undefined : address, lat: point?.lat, lng: point?.lng, from: Q.dist.from || book.start_address });
      if (point) Q.pin = point;
      if (!qf.municipality.value && Q.dist.municipality) qf.municipality.value = Q.dist.municipality;
    } catch (err) { Q.error = err.message; }
    Q.busy = false;
    renderQuote();
  }
  $('#quote-form').addEventListener('change', (e) => {
    if (e.target.name === 'to_location' && e.target.value.trim()) lookupQuoteDistance();
    if (e.target.name === 'municipality') renderQuoteResult();
  });
  $('#q-dist').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dist]');
    if (!b) return;
    const act = b.dataset.dist;
    if (act === 'lookup') lookupQuoteDistance();
    if (act === 'pin') openPin(Q.pin, (p) => lookupQuoteDistance(p));
    if (act === 'km') {
      const v = prompt('Driving distance in km:', Q.dist.km ?? '');
      if (v === null) return;
      const km = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(km) || km < 0) return toast('Type a number of km, e.g. 23.5');
      const inTown = km <= 5 && confirm('Is the job inside Parry Sound town limits?');
      Q.dist = { km, in_town: inTown ? 1 : 0, mode: 'manual', from: Q.dist.from || book.start_address };
      Q.error = '';
      renderQuote();
    }
    if (act === 'from') {
      const v = prompt('Measure the distance from (starting address):', Q.dist.from || book.start_address);
      if (v === null || !v.trim()) return;
      Q.dist = { ...Q.dist, from: v.trim() };
      lookupQuoteDistance();
    }
  });
  $('#q-result').addEventListener('click', (e) => {
    if (e.target.id !== 'q-make') return;
    const job = quoteJob();
    A.openJobForm({ ...job, scheduled_date: state.date || state.today, assignments: [], lines: Q.lines }).then(() => {
      if (Q.pin) { form.elements.pin_lat.value = Q.pin.lat; form.elements.pin_lng.value = Q.pin.lng; }
    });
  });

  // ---------- price lists ----------
  let priceCat = '';
  async function loadPrices() {
    $('#price-who').textContent = state.can.admin ? 'You can change prices: edit a price and press Save. Work orders already booked keep their price.'
      : 'Prices from the price sheets. Ask an admin to change a price.';
    [priceData] = await Promise.all([api('/prices'), getBook(true)]);
    fillPriceList();
    renderQuote();
    renderPriceCats();
    renderPriceTables();
    if (state.can.admin) {
      const sf = $('#price-settings').elements;
      sf.start_address.value = priceData.settings.start_address;
      sf.hst_rate.value = priceData.settings.hst_rate;
      sf.members.value = priceData.settings.members.join('\n');
      $('#price-add-cat').innerHTML = priceData.categories.map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');
      const ch = await api('/prices/changes');
      $('#price-changes').innerHTML = ch.map((c) => `<li><span class="h-when">${esc(A.fmtStamp(c.at))}</span><span class="h-who">${esc(c.actor)}</span>
        <span class="h-what"><b>${esc(c.item_name)}</b> — ${esc(c.change)}</span></li>`).join('') || '<li class="muted">No price changes yet.</li>';
    }
  }
  function renderPriceCats() {
    const cats = priceData.categories.filter(([k]) => priceData.items.some((i) => i.category === k));
    $('#price-cats').innerHTML = [['', 'All'], ...cats].map(([k, t]) =>
      `<button type="button" class="fchip ${priceCat === k ? 'on' : ''}" data-cat="${k}">${esc(t)}</button>`).join('');
  }
  $('#price-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    priceCat = b.dataset.cat;
    renderPriceCats();
    renderPriceTables();
  });
  $('#price-search').addEventListener('input', () => renderPriceTables());

  function priceCell(it) {
    const p = pending.get(it.id)?.price ?? (it.price == null ? '' : String(it.price));
    if (!state.can.admin) return it.price == null ? '<span class="muted">ask</span>' : money(it.price);
    return `<input class="price-in ${pending.has(it.id) ? 'changed' : ''}" data-price-id="${it.id}" value="${esc(p)}" placeholder="ask" inputmode="decimal" aria-label="${esc(it.name)} price">`;
  }

  function renderPriceTables() {
    const q = $('#price-search').value.trim().toLowerCase();
    const show = (it) => (state.can.admin || it.active) && (!priceCat || it.category === priceCat)
      && (!q || `${it.name} ${it.notes} ${it.unit} ${it.grp}`.toLowerCase().includes(q));
    const out = [];
    for (const [cat, title] of priceData.categories) {
      const items = priceData.items.filter((i) => i.category === cat && show(i));
      if (!items.length) continue;
      const note = priceData.notes[cat] ? `<p class="muted small cat-note">${esc(priceData.notes[cat])}</p>` : '';
      let table;
      const gridOf = (prefix, cols) => {
        const byGrp = new Map();
        const singles = [];
        for (const it of items) {
          const m = it.grp && it.key.startsWith(prefix) ? cols.find(([suffix]) => it.key.endsWith('.' + suffix)) : null;
          if (!m) { singles.push(it); continue; }
          if (!byGrp.has(it.grp)) byGrp.set(it.grp, {});
          byGrp.get(it.grp)[m[0]] = it;
        }
        const head = `<tr><th>${cat === 'toilet' ? 'Toilet' : 'Material'}</th>${cols.map(([, t]) => `<th class="num">${t}</th>`).join('')}<th>Note</th></tr>`;
        const rows = [...byGrp].map(([g, c]) => {
          const notes = cols.map(([k]) => c[k]?.notes).filter(Boolean).join(' · ');
          return `<tr class="${Object.values(c).every((x) => !x.active) ? 'inactive' : ''}"><td><b>${esc(g)}</b></td>${cols.map(([k]) =>
            `<td class="num">${c[k] ? priceCell(c[k]) : ''}</td>`).join('')}<td class="muted small">${esc(notes)}</td></tr>`;
        }).join('');
        return { grid: `<table class="table price-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`, singles };
      };
      const plain = (list) => (list.length ? `<table class="table price-table"><thead><tr><th>Item</th><th>Unit</th><th class="num">Price</th>
        ${state.can.admin ? '<th>HST</th><th>On list</th>' : '<th></th>'}<th>Note</th></tr></thead><tbody>${list.map((it) => `
        <tr class="${it.active ? '' : 'inactive'}"><td>${esc(it.name)}</td><td>${esc(it.unit)}</td><td class="num">${priceCell(it)}</td>
        ${state.can.admin ? `<td><input type="checkbox" data-tax-id="${it.id}" ${(pending.get(it.id)?.taxable ?? it.taxable) ? 'checked' : ''} aria-label="Charge HST"></td>
          <td><input type="checkbox" data-active-id="${it.id}" ${(pending.get(it.id)?.active ?? it.active) ? 'checked' : ''} aria-label="On the price list"></td>`
          : `<td class="muted small">${it.taxable ? '' : 'no HST'}</td>`}
        <td class="muted small">${esc(it.notes)}</td></tr>`).join('')}</tbody></table>` : '');
      if (cat === 'aggregate') {
        const g = gridOf('agg.', [['yard', 'Per yard'], ['tandem', 'Per tandem'], ['triaxle', 'Per triaxle']]);
        table = g.grid + plain(g.singles);
      } else if (cat === 'toilet') {
        const g = gridOf('toilet.', [['week', 'Weekly'], ['month', 'Monthly']]);
        table = g.grid + plain(g.singles);
      } else table = plain(items);
      out.push(`<section class="price-cat"><h3>${esc(title)}</h3>${note}${table}</section>`);
    }
    $('#price-tables').innerHTML = out.join('') || '<p class="muted">No prices match.</p>';
    updateSaveBar();
  }

  function updateSaveBar() {
    $('#price-save-bar').classList.toggle('hidden', !pending.size);
    $('#price-dirty').textContent = pending.size ? `${pending.size} change${pending.size > 1 ? 's' : ''} not saved yet` : '';
  }
  const markPending = (id, patch) => {
    pending.set(id, { ...(pending.get(id) || {}), ...patch });
    updateSaveBar();
  };
  $('#price-tables').addEventListener('input', (e) => {
    const id = Number(e.target.dataset.priceId);
    if (!id) return;
    markPending(id, { price: e.target.value });
    e.target.classList.add('changed');
  });
  $('#price-tables').addEventListener('change', (e) => {
    const t = Number(e.target.dataset.taxId);
    const a = Number(e.target.dataset.activeId);
    if (t) markPending(t, { taxable: e.target.checked });
    if (a) markPending(a, { active: e.target.checked });
  });
  $('#price-undo').addEventListener('click', () => { pending.clear(); renderPriceTables(); });
  $('#price-save').addEventListener('click', async () => {
    try {
      await api('/prices', { method: 'POST', body: { changes: [...pending].map(([id, c]) => ({ id, ...c })) } });
      toast(`Saved ${pending.size} price change${pending.size > 1 ? 's' : ''}. Booked work orders keep their old price.`);
      pending.clear();
      await loadPrices();
    } catch (err) { toast(err.message); }
  });
  $('#price-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await api('/prices/settings', { method: 'POST', body: { start_address: f.start_address.value, hst_rate: f.hst_rate.value, members: f.members.value } });
      toast('Pricing settings saved');
      await loadPrices();
    } catch (err) { toast(err.message); }
  });
  $('#price-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/prices', { method: 'POST', body: { changes: [Object.fromEntries(new FormData(e.target).entries())] } });
      e.target.reset();
      toast('Price added');
      await loadPrices();
    } catch (err) { toast(err.message); }
  });

  // =====================================================================
  // Customer questions
  // =====================================================================
  let faq = [];
  let faqEditing = null; // id, or 'new'
  async function loadFaq() {
    faq = await api('/faq');
    renderFaq();
  }
  function faqEditor(item = {}) {
    return `<form class="faq-edit panel" data-faq-form="${item.id || 'new'}">
      <label>Question <input name="question" value="${esc(item.question || '')}" required placeholder="e.g. How often should a septic tank be pumped?"></label>
      <label>Answer <textarea name="answer" rows="4" placeholder="The answer to give the customer">${esc(item.answer || '')}</textarea></label>
      <label>Topic <input name="topic" value="${esc(item.topic || '')}" list="dl-faq-topics" placeholder="Septic, Bins, Aggregate, Toilets, Billing…"></label>
      <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-faq-cancel>Cancel</button></div>
    </form>`;
  }
  function renderFaq() {
    const q = $('#faq-search').value.trim().toLowerCase();
    const list = faq.filter((f) => !q || `${f.question} ${f.answer} ${f.topic}`.toLowerCase().includes(q));
    const topics = [...new Set(faq.map((f) => f.topic).filter(Boolean))];
    let html = faqEditing === 'new' ? faqEditor() : '';
    let last = null;
    for (const f of list) {
      if (f.topic !== last) { html += `<h3 class="faq-topic">${esc(f.topic || 'General')}</h3>`; last = f.topic; }
      html += faqEditing === f.id ? faqEditor(f) : `<article class="faq-item panel">
        <div class="faq-q">${esc(f.question)}</div>
        <div class="faq-a">${esc(f.answer) || '<span class="muted">No answer yet.</span>'}</div>
        ${state.can.admin ? `<div class="row-actions faq-acts"><span class="muted small">Updated ${esc(A.fmtStamp(f.updated_at))}${f.updated_by ? ' by ' + esc(f.updated_by) : ''}</span>
          <button class="btn tiny" data-faq-edit="${f.id}">Edit</button><button class="btn tiny danger" data-faq-del="${f.id}">Delete</button></div>` : ''}
      </article>`;
    }
    if (!faq.length && faqEditing !== 'new') {
      html = `<div class="empty">No questions yet.${state.can.admin ? ' Press <b>+ Add a question</b> to write the first standard answer.' : ' An admin adds the standard answers here.'}</div>`;
    } else if (!list.length && faqEditing !== 'new') html = '<p class="muted">Nothing matches that search.</p>';
    $('#faq-list').innerHTML = html + `<datalist id="dl-faq-topics">${topics.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`;
    $('#faq-list [name=question]')?.focus();
  }
  $('#faq-search').addEventListener('input', renderFaq);
  $('#faq-new').addEventListener('click', () => { faqEditing = 'new'; renderFaq(); });
  $('#faq-list').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-faq-edit]');
    const del = e.target.closest('[data-faq-del]');
    if (e.target.closest('[data-faq-cancel]')) { faqEditing = null; renderFaq(); }
    if (ed) { faqEditing = Number(ed.dataset.faqEdit); renderFaq(); }
    if (del && confirm('Delete this question and answer?')) {
      await api('/faq/' + del.dataset.faqDel, { method: 'DELETE' });
      await loadFaq();
    }
  });
  $('#faq-list').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = e.target.dataset.faqForm;
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api(id === 'new' ? '/faq' : '/faq/' + id, { method: id === 'new' ? 'POST' : 'PUT', body });
      faqEditing = null;
      toast('Saved');
      await loadFaq();
    } catch (err) { toast(err.message); }
  });

  // =====================================================================
  // Logins (owner only)
  // =====================================================================
  const ROLE_OPTS = [['office', 'Office'], ['dispatcher', 'Dispatcher'], ['admin', 'Admin']];
  async function loadUsers() {
    const users = await api('/users');
    $('#user-rows').innerHTML = users.map((u) => `<tr data-user="${u.id}" class="${u.active ? '' : 'inactive'}">
      <td><input name="name" value="${esc(u.name)}" aria-label="Name"></td>
      <td>${esc(u.email)}${u.email === state.user?.email ? ' <span class="muted small">(you)</span>' : ''}</td>
      <td><select name="role" aria-label="Role">${ROLE_OPTS.map(([v, t]) => `<option value="${v}" ${u.role === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td class="row-actions"><button class="btn tiny" data-user-act="save">Save</button>
        <button class="btn tiny" data-user-act="password">New password</button>
        <button class="btn tiny danger" data-user-act="remove">Remove</button></td></tr>`).join('');
  }
  $('#user-rows').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-user-act]');
    if (!b) return;
    const tr = b.closest('[data-user]');
    const id = tr.dataset.user;
    try {
      if (b.dataset.userAct === 'save') {
        await api('/users/' + id, { method: 'PUT', body: { name: $('[name=name]', tr).value, role: $('[name=role]', tr).value } });
        toast('Login updated');
      }
      if (b.dataset.userAct === 'password') {
        const pw = prompt('New password for this login (8 or more characters). They\'ll be logged out and use this to log in:');
        if (!pw) return;
        await api('/users/' + id, { method: 'PUT', body: { password: pw } });
        toast('Password changed');
      }
      if (b.dataset.userAct === 'remove') {
        if (!confirm('Remove this login? They won\'t be able to log in. Their name stays on the work orders and history.')) return;
        await api('/users/' + id, { method: 'DELETE' });
        toast('Login removed');
      }
      loadUsers();
    } catch (err) { toast(err.message); }
  });
  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const u = await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
      toast(`Login added for ${u.name}. Give them their email and starting password.`);
      e.target.reset();
      loadUsers();
    } catch (err) { toast(err.message); }
  });

  window.PRICE_UI = { loadPrices, loadFaq, loadUsers, openForm, collect, suggestionsFor, getBook, openPin };
})();
