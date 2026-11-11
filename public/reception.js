/* Reception view for office logins: Home · New call (step by step, or one page) · Find · Customer asks.
   Dispatchers and admins keep the full dashboard (they can preview this with ?view=reception). Uses window.APP. */
(() => {
  const A = window.APP;
  const { api, esc, toast, $, $$, state } = A;
  const P = window.PRICING;
  const money = (n) => (n == null || n === '' ? '—' : P.money(n));
  const root = () => $('#rc');
  const store = { get: (k, d) => { try { return localStorage.getItem('rc-' + k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('rc-' + k, v); } catch { /* private mode */ } } };

  const SERVICES = [
    ['haul', '🪨', 'Aggregate', 'Gravel, sand, soil — by the load or the yard'],
    ['septic', '💧', 'Septic pump-out', 'Tanks and pump chambers'],
    ['bin', '🗑️', 'Bin', 'Drop off, empty, pick up'],
    ['toilet', '🚻', 'Portable toilet', 'Weekly or monthly'],
    ['water', '💦', 'Water', 'By the load'],
    ['other', '❓', 'Something else', 'Write it down for dispatch'],
  ];
  const SVC = Object.fromEntries(SERVICES.map((s) => [s[0], s]));
  const POPULAR = ['Sand Fill', 'Screened Topsoil', 'A Gravel 3/4"', '3/4" Clear (drainage)', '2" Minus (B Stone)', 'Triple Mix', 'Screened Sand', 'Pea Gravel'];
  const BIN_SIZES = ['4 yd H&G', '6 yd H&G', '10 yd H&G', '14 yd H&G', '15 yd', '20 yd', '30 yd', '40 yd'];
  const TANKS = [['1000', '1000 gal or less'], ['1200', '1200'], ['1500', '1500'], ['2000', '2000'], ['2500', '2500'], ['3000', '3000']];
  const TOPICS = { haul: ['aggregate', 'gravel', 'sand', 'soil', 'deliver'], septic: ['septic', 'pump'], bin: ['bin'], toilet: ['toilet'], water: ['water'] };
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let book = null;
  let faq = [];
  let due = new Set();
  let view = 'home';
  let W = null; // the call being taken

  const pad = (n) => String(n).padStart(2, '0');
  const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  const dayName = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const shortDay = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const slotWords = { first: 'first thing in the morning', am: 'in the morning', pm: 'in the afternoon', any: '' };

  function freshCall() {
    return { step: 1, svc: '', f: { truck: 'Triaxle', qty: 1, trip: 'Deliver', period: 'week', service: 'Deliver bin', waste: 'mixed' },
      addr: { to_location: '', municipality: '' }, dist: {}, distError: '', distBusy: false, pin: null, x: {},
      cust: { phone: '', name: '', email: '', billing_address: '', customer_id: '' }, match: null,
      day: '', slot: '', notes: '', editId: null, quoteId: null, existing: null, error: '', missing: null };
  }

  // =====================================================================
  // start / navigation
  // =====================================================================
  async function start() {
    document.body.classList.add('reception');
    A.showTab('reception');
    [book, faq] = await Promise.all([window.PRICE_UI.getBook(), api('/faq').catch(() => [])]);
    api('/customers/due').then((list) => { due = new Set(list.map((c) => c.id)); }).catch(() => {});
    go('home');
  }

  function go(v, opts = {}) {
    view = v;
    if (v === 'call' && !opts.keep) W = freshCall();
    render();
    window.scrollTo(0, 0);
  }

  function nav() {
    const mode = store.get('mode', 'steps');
    const b = (v, label) => `<button class="rc-nav ${view === v ? 'on' : ''}" data-go="${v}">${label}</button>`;
    return `<div class="rc-bar">
      ${b('home', '⌂ Home')}${b('call', '📞 New call')}${b('find', '🔎 Find')}${b('asks', '💬 Customer asks')}
      <span class="sp"></span>
      ${view === 'call' ? `<div class="rc-mode" role="group" aria-label="Layout">
        <button data-mode="steps" class="${mode === 'steps' ? 'on' : ''}">Step by step</button>
        <button data-mode="quick" class="${mode === 'quick' ? 'on' : ''}">One page</button></div>` : ''}
      ${state.can?.dispatch ? '<a class="rc-nav" href="/">Back to the dashboard</a>' : ''}
    </div>`;
  }

  async function render() {
    if (view === 'home') return renderHome();
    if (view === 'find') return renderFind();
    if (view === 'asks') return renderAsks();
    if (view === 'call') return renderCall();
  }

  // =====================================================================
  // Home
  // =====================================================================
  async function renderHome() {
    const [h, notes] = await Promise.all([api('/reception/home').catch(() => ({ recent: [], quotes: [], today_jobs: 0, week_jobs: 0 })),
      api('/boss-notes').catch(() => [])]);
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    root().innerHTML = nav() + `<div class="rc-wrap">
      <h1 class="rc-h1">${hello}, ${esc((state.user?.name || '').split(' ')[0])}</h1>
      <div class="rc-sub">${esc(dayName(state.today))} · ${h.today_jobs} job${h.today_jobs === 1 ? '' : 's'} today · ${h.week_jobs} this week</div>
      ${notes.length ? `<div class="rc-boss"><h3>📌 Notes from the boss</h3>${notes.map((n) => `<div class="rc-boss-note">
        <div>${esc(n.body)}</div><div class="who">— ${esc(n.author)}, ${esc(A.fmtStamp(n.created_at))}</div></div>`).join('')}</div>` : ''}
      <div class="rc-big3">
        <button class="rc-bigbtn main" data-go="call"><span class="ic">📞</span><span><span class="t">New call</span><span class="s">Price it, answer questions, book it</span></span></button>
        <button class="rc-bigbtn" data-go="find"><span class="ic">🔎</span><span><span class="t">Find a customer</span><span class="s">Name, phone, address or W.O. # — change or cancel a booking</span></span></button>
        <button class="rc-bigbtn" data-go="asks"><span class="ic">💬</span><span><span class="t">Customer asks…</span><span class="s">Prices and the standard answers</span></span></button>
      </div>
      ${h.quotes.length ? `<div class="rc-list"><h3>Quotes to call back</h3>${h.quotes.map((q) => `
        <div class="rc-row"><span class="rc-pill">Quote</span><b>${esc(q.customer || q.phone || 'No name')}</b>
          <span class="muted">${esc(q.summary)}${q.address ? ' · ' + esc(q.address) : ''}</span><span class="sp"></span>
          <b>${money(q.total)}</b>
          <button class="btn tiny primary" data-quote="${q.id}">Book it</button>
          <button class="btn tiny" data-drop-quote="${q.id}">Not interested</button></div>`).join('')}</div>` : ''}
      <div class="rc-list"><h3>What I booked recently</h3>
        ${h.recent.map(jobRow).join('') || '<p class="muted">Nothing yet — press <b>New call</b> when the phone rings.</p>'}</div>
    </div>`;
  }

  function jobRow(j) {
    const when = `${shortDay(j.scheduled_date)}${j.time_slot && j.time_slot !== 'any' ? ' · ' + window.FORMS.slotLabel(j.time_slot) : ''}`;
    const tone = { green: 'g', yellow: 'y', grey: '' }[j.plain.tone] || '';
    const open = j.status === 'open';
    return `<div class="rc-row ${j.status}"><span class="rc-pill k">#${j.id}</span><b>${esc(j.customer || j.to_location || 'No name')}</b>
      <span class="muted">${esc(j.summary || j.type_name)}</span><span class="sp"></span>
      <span class="rc-pill">${esc(when)}</span><span class="rc-pill ${tone}">${esc(j.plain.text)}</span>
      ${open ? `<button class="btn tiny" data-edit="${j.id}">Change</button><button class="btn tiny danger" data-cancel="${j.id}">Cancel</button>` : ''}
      <button class="btn tiny" data-again="${j.id}">Book again</button>
      <a class="btn tiny" href="/print/${j.id}" target="_blank" rel="noopener">Print</a></div>`;
  }

  // =====================================================================
  // Find
  // =====================================================================
  let findQ = '';
  let findCustomer = null;
  async function renderFind() {
    root().innerHTML = nav() + `<div class="rc-wrap">
      <h1 class="rc-h1">Find a customer or booking</h1>
      <input class="rc-input rc-search" id="rc-find" placeholder="Name, phone number, address or work order #" value="${esc(findQ)}" autocomplete="off">
      <div id="rc-find-out"></div></div>`;
    const input = $('#rc-find');
    input.focus();
    let t;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { findQ = input.value; findCustomer = null; findResults(); }, 250); });
    findResults();
  }
  async function findResults() {
    const out = $('#rc-find-out');
    if (!out) return;
    if (findCustomer) {
      const jobs = await api(`/reception/customers/${findCustomer.id}/jobs`);
      out.innerHTML = `<div class="rc-list"><div class="rc-row"><button class="btn tiny" data-find-back>← All results</button></div>
        ${customerCard(findCustomer)}<h3>Their work orders</h3>${jobs.map(jobRow).join('') || '<p class="muted">No work orders yet.</p>'}</div>`;
      return;
    }
    if (findQ.trim().length < 2) { out.innerHTML = '<p class="muted">Type at least 2 letters or digits.</p>'; return; }
    const r = await api('/reception/find?q=' + encodeURIComponent(findQ));
    out.innerHTML = `${r.customers.length ? `<div class="rc-list"><h3>Customers</h3>${r.customers.map(customerCard).join('')}</div>` : ''}
      <div class="rc-list"><h3>Work orders</h3>${r.jobs.map(jobRow).join('') || '<p class="muted">No work orders match.</p>'}</div>`;
  }
  function customerCard(c) {
    return `<div class="rc-cust"><div><b>${esc(c.name || '(no name)')}</b> <span class="muted">${esc(A.prettyPhone(c.phone))}</span>
        ${due.has(c.id) ? '<span class="rc-pill y">Due for a pump-out</span>' : ''}
        <div class="muted small">${esc([c.site_address, c.municipality].filter(Boolean).join(', '))}${c.last_job_date ? ' · last job ' + esc(c.last_job_date) : ''}</div>
        ${c.notes ? `<div class="small">📝 ${esc(c.notes)}</div>` : ''}</div>
      <span class="sp"></span>
      <button class="btn tiny" data-cust-jobs='${esc(JSON.stringify(c))}'>Their jobs</button>
      <button class="btn tiny primary" data-call-for='${esc(JSON.stringify(c))}'>New call for them</button></div>`;
  }

  // =====================================================================
  // Customer asks (prices + answers)
  // =====================================================================
  function answersHtml(q, svc, { big = false } = {}) {
    const term = String(q || '').trim().toLowerCase();
    let list = faq;
    if (term) list = faq.filter((f) => `${f.question} ${f.answer} ${f.topic}`.toLowerCase().includes(term));
    else if (svc && TOPICS[svc]) {
      const words = TOPICS[svc];
      const hit = faq.filter((f) => words.some((w) => `${f.topic} ${f.question}`.toLowerCase().includes(w)));
      list = hit.length ? hit : faq;
    }
    const prices = term ? Object.entries(book?.items || {}).filter(([, it]) => it.name.toLowerCase().includes(term)).slice(0, big ? 30 : 6) : [];
    const qa = list.slice(0, big ? 100 : 6).map((f, i) => `<details class="rc-qa" ${i === 0 && !big ? 'open' : ''}><summary>${esc(f.question)}</summary><div>${esc(f.answer) || '<i>No answer yet</i>'}</div></details>`).join('');
    const pr = prices.map(([, it]) => `<div class="rc-price-hit"><span>${esc(it.name)}</span><b>${it.price == null ? 'ask' : money(it.price)}${it.unit ? ` <small>/ ${esc(it.unit)}</small>` : ''}</b></div>`).join('');
    return (pr ? `<div class="rc-prices"><div class="lbl">Prices</div>${pr}</div>` : '')
      + (qa || `<p class="muted small">${faq.length ? 'No answers match.' : 'No standard answers yet — an admin adds them on the Questions page.'}</p>`);
  }
  function renderAsks() {
    root().innerHTML = nav() + `<div class="rc-wrap"><h1 class="rc-h1">Customer asks…</h1>
      <input class="rc-input rc-search" id="rc-ask" placeholder="Type a word: delivery, septic, topsoil, Saturday…" autocomplete="off">
      <div class="rc-asks-big" id="rc-ask-out">${answersHtml('', '', { big: true })}</div></div>`;
    $('#rc-ask').focus();
    $('#rc-ask').addEventListener('input', (e) => { $('#rc-ask-out').innerHTML = answersHtml(e.target.value, '', { big: true }); });
  }
  function askPanel() {
    return `<aside class="rc-ask"><h3>💬 Customer asks…</h3>
      <input class="rc-input" id="rc-ask-side" placeholder="Search answers and prices" autocomplete="off">
      <div id="rc-ask-side-out">${answersHtml('', W?.svc)}</div></aside>`;
  }

  // =====================================================================
  // New call
  // =====================================================================
  /** The work order this call would make. */
  function jobFromCall() {
    const f = W.f;
    const base = { ...(W.existing || {}) };
    for (const k of ['id', 'lines', 'totals', 'assignments', 'tickets', 'missing', 'created_by_name', 'history']) delete base[k];
    const j = { ...base, to_location: W.addr.to_location, municipality: W.addr.municipality,
      distance_km: W.dist.km ?? '', distance_from: W.dist.from || '', distance_mode: W.dist.mode || '', in_town: W.dist.in_town ?? '',
      customer: W.cust.name, customer_phone: W.cust.phone, customer_email: W.cust.email, billing_address: W.cust.billing_address,
      customer_id: W.cust.customer_id || '', scheduled_date: W.day, time_slot: W.slot, notes: W.notes, price_options: {} };
    const details = { ...(base.details || {}) };
    if (W.svc === 'haul') {
      const yards = f.truck === 'Yards';
      Object.assign(j, { job_type: 'haul', material: f.material || '', loads_planned: yards ? '' : f.qty, quantity: yards ? f.qty : '' });
      Object.assign(details, { direction: 'Deliver to site', truck: yards ? '' : f.truck });
    } else if (W.svc === 'septic') {
      Object.assign(j, { job_type: 'septic' });
      Object.assign(details, { tank_size: f.gallons ? `${f.gallons} gal` : '', tank_type: f.tank_type || 'Septic' });
      j.price_options = { ...(f.chamber ? { pump_chamber_too: true } : {}), ...(f.off ? { off_schedule: true } : {}) };
    } else if (W.svc === 'bin') {
      Object.assign(j, { job_type: 'bin', material: f.size || '' });
      details.service = f.service;
      j.price_options = { waste: f.waste };
    } else if (W.svc === 'toilet') {
      Object.assign(j, { job_type: 'toilet' });
      Object.assign(details, { trip: f.trip, toilet1_type: f.toilet || '', toilet1_qty: f.qty });
      j.price_options = { period: f.period, ...(f.off ? { off_schedule: true } : {}) };
    } else if (W.svc === 'water') {
      Object.assign(j, { job_type: 'misc', material: 'Water', loads_planned: f.qty, quantity: '' });
    } else {
      Object.assign(j, { job_type: 'misc', material: f.what || '' });
    }
    // Details fields for this type (only the ones still shown on reception, so a changed service doesn't carry stray answers).
    for (const f of receptionFields(W.svc)) {
      if (W.x[f.key] !== undefined && String(W.x[f.key]).trim() !== '') details[f.key] = String(W.x[f.key]).trim();
      else delete details[f.key];
    }
    j.details = details;
    if (W.pin) { j.pin_lat = W.pin.lat; j.pin_lng = W.pin.lng; }
    return j;
  }

  function priceLines(job) {
    if (!book) return { lines: [], notes: [] };
    if (W.svc === 'water') {
      const it = book.items['water.load'];
      return { lines: it ? [{ slot: 'water.load', item_key: 'water.load', description: it.name, qty: Number(W.f.qty) || 1, unit: it.unit,
        unit_price: it.price, taxable: it.taxable ? 1 : 0, kind: 'charge', auto: 1, note: '' }] : [],
      notes: ['Water delivery is extra: $130/hour from leaving the yard to returning (added by the office after).'] };
    }
    if (W.svc === 'other') return { lines: [], notes: ['Dispatch will price this one.'] };
    const r = P.calc(job, book);
    const kept = W.existing ? P.merge(W.existing.lines || [], r.lines, (W.existing.price_options || {}).removed_slots || []) : r.lines;
    return { lines: kept, notes: r.notes };
  }

  function sayText(job, t) {
    const what = window.FORMS.summary(job) || (SVC[W.svc] || [])[2] || 'That';
    const where = W.addr.to_location ? ` to ${W.addr.to_location}` : '';
    return `"${what}${where} comes to <b>${money(t.total)} including HST</b>."`;
  }

  // ---------- sections (shared by both layouts) ----------
  function chip(name, value, current, label = value) {
    return `<button type="button" class="rc-chip ${String(current) === String(value) ? 'on' : ''}" data-set="${name}" data-val="${esc(value)}">${esc(label)}</button>`;
  }
  function stepper(name, value, unit) {
    return `<span class="rc-stepper"><button type="button" class="rc-chip" data-step="${name}" data-by="-1">−</button>
      <span class="rc-chip on">${esc(value)} ${esc(unit)}</span><button type="button" class="rc-chip" data-step="${name}" data-by="1">+</button></span>`;
  }

  function whatSection() {
    const f = W.f;
    const tiles = `<div class="rc-tiles">${SERVICES.map(([k, ic, t, s]) =>
      `<button type="button" class="rc-tile ${W.svc === k ? 'pick' : ''}" data-svc="${k}"><span class="ic">${ic}</span><span class="t">${esc(t)}</span><span class="s">${esc(s)}</span></button>`).join('')}</div>`;
    let more = '';
    if (W.svc === 'haul') {
      const all = Object.values(book.items).filter((it) => it.grp && it.category === 'aggregate').map((it) => it.grp);
      const groups = [...new Set(all)];
      more = `<div class="rc-label">Which material?</div><div class="rc-chips">${POPULAR.filter((m) => groups.includes(m)).map((m) => chip('material', m, f.material)).join('')}
        <select class="rc-select" data-set-select="material"><option value="">More…</option>${groups.filter((g) => !POPULAR.includes(g)).map((g) =>
          `<option ${f.material === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
        <div class="rc-label">How much?</div><div class="rc-chips">${chip('truck', 'Tandem', f.truck, 'Tandem load')}${chip('truck', 'Triaxle', f.truck, 'Triaxle load')}${chip('truck', 'Yards', f.truck, 'By the yard')}
        <span class="rc-gap"></span>${stepper('qty', f.qty, f.truck === 'Yards' ? (f.qty === 1 ? 'yard' : 'yards') : (f.qty === 1 ? 'load' : 'loads'))}</div>`;
    } else if (W.svc === 'septic') {
      more = `<div class="rc-label">How big is the tank? <span class="muted">(ask: "do you know the size of your tank?")</span></div>
        <div class="rc-chips">${TANKS.map(([v, l]) => chip('gallons', v, f.gallons, l)).join('')}${chip('gallons', '', f.gallons ?? '', 'Not sure')}</div>
        <div class="rc-label">Type of tank</div><div class="rc-chips">${['Septic', 'Holding', 'Pump chamber'].map((v) => chip('tank_type', v, f.tank_type || 'Septic')).join('')}</div>
        <div class="rc-chips rc-checks"><label><input type="checkbox" data-check="chamber" ${f.chamber ? 'checked' : ''}> Also pump the pump chamber (+$100)</label>
          <label><input type="checkbox" data-check="off" ${f.off ? 'checked' : ''}> Off-schedule day (+$100)</label></div>`;
    } else if (W.svc === 'bin') {
      more = `<div class="rc-label">What size?</div><div class="rc-chips">${BIN_SIZES.map((v) => chip('size', v, f.size)).join('')}</div>
        <div class="rc-label">What do they need?</div><div class="rc-chips">${chip('service', 'Deliver bin', f.service, 'Drop off a bin')}${chip('service', 'Empty & return', f.service, 'Empty it and bring it back')}${chip('service', 'Empty & no return', f.service, 'Pick it up for good')}</div>
        <div class="rc-label">What's going in it?</div><div class="rc-chips">${chip('waste', 'mixed', f.waste, 'Mixed waste')}${chip('waste', 'concrete', f.waste, 'Clean concrete')}${chip('waste', 'metal', f.waste, 'Scrap metal')}${chip('waste', 'asbestos', f.waste, 'Asbestos')}</div>`;
    } else if (W.svc === 'toilet') {
      const types = [...new Set(Object.values(book.items).filter((it) => it.category === 'toilet' && it.grp).map((it) => it.grp))];
      more = `<div class="rc-label">Which kind?</div><div class="rc-chips">${types.map((v) => chip('toilet', v, f.toilet)).join('')}</div>
        <div class="rc-label">How many, and for how long?</div><div class="rc-chips">${stepper('qty', f.qty, f.qty === 1 ? 'toilet' : 'toilets')}<span class="rc-gap"></span>
          ${chip('period', 'week', f.period, 'Weekly')}${chip('period', 'month', f.period, 'Monthly')}</div>
        <div class="rc-chips rc-checks">${chip('trip', 'Deliver', f.trip, 'Deliver')}${chip('trip', 'Service', f.trip, 'Extra service / pump-out')}
          <label><input type="checkbox" data-check="off" ${f.off ? 'checked' : ''}> Off-schedule (+$100)</label></div>`;
    } else if (W.svc === 'water') {
      more = `<div class="rc-label">How many loads? <span class="muted">(up to 2500 gallons a load)</span></div><div class="rc-chips">${stepper('qty', f.qty, f.qty === 1 ? 'load' : 'loads')}</div>`;
    } else if (W.svc === 'other') {
      more = `<div class="rc-label">What do they need?</div><textarea class="rc-input" rows="3" data-text="what" placeholder="e.g. float the excavator to Seguin, haul away old asphalt">${esc(f.what || '')}</textarea>`;
    }
    return `<h2 class="rc-h2">What does the caller need?</h2>${tiles}${more}${detailsFields()}`;
  }

  // Fields admins added and set to show on reception (Setup → Work order fields).
  const jobTypeOf = (svc) => (svc === 'water' || svc === 'other' ? 'misc' : svc);
  function receptionFields(svc) {
    if (!svc) return [];
    return window.FORMS.typeInfo(jobTypeOf(svc)).fields.filter((f) => f.reception && !f.hidden && !window.FORMS.RECEPTION_ASKS.includes(f.key));
  }
  function detailsFields() {
    const list = receptionFields(W.svc);
    if (!list.length) return '';
    const v = (k) => W.x[k] ?? '';
    return `<div class="rc-label" style="margin-top:20px">Details</div><div class="rc-xfields">${list.map((f) => {
      if (f.kind === 'choice') {
        return `<div class="rc-xf"><span class="rc-xl">${esc(f.label)}</span><div class="rc-chips">${f.options.map((o) =>
          `<button type="button" class="rc-chip ${v(f.key) === o ? 'on' : ''}" data-xset="${esc(f.key)}" data-val="${esc(o)}">${esc(o)}</button>`).join('')}</div></div>`;
      }
      if (f.kind === 'textarea') return `<label class="rc-xf wide"><span class="rc-xl">${esc(f.label)}</span><textarea class="rc-input" rows="2" data-xf="${esc(f.key)}">${esc(v(f.key))}</textarea></label>`;
      const type = f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text';
      return `<label class="rc-xf"><span class="rc-xl">${esc(f.label)}</span><input class="rc-input" type="${type}" data-xf="${esc(f.key)}" value="${esc(v(f.key))}"></label>`;
    }).join('')}</div>`;
  }

  function whereSection() {
    const d = W.dist;
    const km = d.km != null && d.km !== '' ? `🚚 <b>${esc(String(d.km))} km</b> from the yard${Number(d.in_town) ? ' · inside Parry Sound' : ''}${d.mode === 'pin' ? ' (map pin)' : ''}` : '';
    const job = jobFromCall();
    const { lines, notes } = priceLines(job);
    const t = P.totals(lines, book?.hst_rate ?? 13);
    W.lines = lines;
    const rows = lines.filter((l) => l.kind !== 'deposit').map((l) => `<div class="ln"><span>${esc(l.description)}${Number(l.qty) !== 1 ? ` — ${esc(String(l.qty))} × ${money(l.unit_price)}` : ''}</span><span>${l.unit_price == null ? 'to be priced' : money(P.amount(l))}</span></div>`).join('');
    const dep = lines.filter((l) => l.kind === 'deposit').map((l) => `<div class="ln dep"><span>Deposit to collect (not in the total)</span><span>${money(l.unit_price)}</span></div>`).join('');
    return `<h2 class="rc-h2">Where is it going?</h2>
      <div class="rc-grid2"><label class="rc-label">Address<input class="rc-input" data-addr="to_location" value="${esc(W.addr.to_location)}" placeholder="Street address, e.g. 45 Bay Rd" list="dl-locations" autocomplete="off"></label>
        <label class="rc-label">Town / township<input class="rc-input" data-addr="municipality" value="${esc(W.addr.municipality)}" list="dl-municipalities" autocomplete="off"></label></div>
      <div class="rc-dist">${W.distBusy ? 'Working out the distance…' : km}${W.distError ? `<span class="rc-err">${esc(W.distError)}</span>` : ''}
        <button type="button" class="link" data-pin>📍 No address yet? Drop a pin on the map</button></div>
      ${W.svc ? `<div class="rc-price"><div class="hd">PRICE</div>${rows || '<div class="ln"><span>Pick what they need above</span><span></span></div>'}
        ${t.subtotal ? `<div class="ln"><span>HST ${esc(String(book?.hst_rate ?? 13))}%</span><span>${money(t.hst)}</span></div>` : ''}${dep}
        <div class="tot-row"><span>Total</span><span class="tot">${money(t.total)}</span></div></div>
        ${notes.length ? `<ul class="rc-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        ${t.total ? `<div class="rc-say">🗣 <b>Say:</b> ${sayText(job, t)}</div>` : ''}` : ''}`;
  }

  function whoSection() {
    const c = W.cust;
    const m = W.match;
    return `<h2 class="rc-h2">Who is it for?</h2>
      <label class="rc-label">Their phone number <span class="muted">— returning customers fill in by themselves</span>
        <input class="rc-input" data-cust="phone" type="tel" value="${esc(c.phone)}" placeholder="705-555-1234" autocomplete="off"></label>
      <div id="rc-match">${m ? matchCard(m) : ''}</div>
      <div class="rc-grid2"><label class="rc-label">Name<input class="rc-input" data-cust="name" value="${esc(c.name)}" autocomplete="off"></label>
        <label class="rc-label">Email <span class="muted">(optional)</span><input class="rc-input" data-cust="email" type="email" value="${esc(c.email)}"></label></div>
      <label class="rc-label">Mailing address for the bill <span class="muted">(if different from the job address)</span>
        <input class="rc-input" data-cust="billing_address" value="${esc(c.billing_address)}"></label>`;
  }
  function matchCard(m) {
    const used = String(W.cust.customer_id) === String(m.id);
    return `<div class="rc-match ${used ? 'used' : ''}">✓ <b>${esc(m.name || 'Customer')}</b> ${m.last_job_date ? `— last job ${esc(m.last_job_date)}` : ''}
      ${due.has(m.id) ? '<span class="rc-pill y">Due for a pump-out — offer to book it</span>' : ''}
      <div class="small">${esc([m.site_address, m.municipality].filter(Boolean).join(', '))}${m.notes ? ' · 📝 ' + esc(m.notes) : ''}</div>
      ${used ? '<span class="small">Filled in ✓</span>' : '<button type="button" class="btn tiny primary" data-use-match>That\'s them — fill in</button>'}</div>`;
  }

  // ---------- busy days ----------
  let cal = {};
  let calLoaded = '';
  let crew = 1;
  async function loadCal() {
    const months = [state.today.slice(0, 7), addDays(state.today.slice(0, 7) + '-01', 32).slice(0, 7)];
    if (calLoaded === months.join()) return;
    const [a, b] = await Promise.all(months.map((m) => api('/calendar?month=' + m).catch(() => ({}))));
    cal = { ...a, ...b };
    crew = Math.max(1, (state.drivers || []).filter((d) => d.kind !== 'labourer').length);
    calLoaded = months.join();
  }
  function daySection({ compact = false } = {}) {
    const start = addDays(state.today, -((new Date(state.today + 'T12:00:00Z').getUTCDay() + 6) % 7)); // Monday this week
    const days = compact ? 14 : 35;
    const icons = { haul: '🪨', septic: '💧', bin: '🗑️', toilet: '🚻', float: '🚜', misc: '🛠️', labour: '👷' };
    const cells = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      const c = cal[d];
      const n = c?.total || 0;
      const ratio = n / crew;
      const level = !n ? 'free' : ratio < 0.7 ? 'ok' : ratio < 1 ? 'busy' : 'full';
      const past = d < state.today;
      const wkday = new Date(d + 'T12:00:00Z').getUTCDay();
      cells.push(`<button type="button" class="rc-day ${level} ${past ? 'past' : ''} ${W.day === d ? 'pick' : ''} ${wkday === 0 || wkday === 6 ? 'wkend' : ''}"
        ${past ? 'disabled' : ''} data-day="${d}"><span class="dn">${WEEKDAYS[wkday]} <b>${Number(d.slice(8))}</b></span>
        <span class="dc">${n ? `${n} job${n === 1 ? '' : 's'}` : 'open'}</span>
        <span class="bar"><i style="width:${Math.min(100, Math.round(ratio * 100))}%"></i></span>
        ${!compact && c ? `<span class="dt">${Object.entries(c.types).map(([k, v]) => `${icons[k] || ''}${v}`).join(' ')}</span>` : ''}</button>`);
    }
    return `<h2 class="rc-h2">Which day suits them?</h2>
      <div class="muted small">How busy each day already is: <span class="rc-key ok"></span> room <span class="rc-key busy"></span> busy <span class="rc-key full"></span> full (for ${crew} drivers)</div>
      <div class="rc-days ${compact ? 'compact' : ''}">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => `<span class="wh">${w}</span>`).join('')}${cells.join('')}</div>
      <div class="rc-chips" style="margin-top:6px"><label class="small">Later than that? <input type="date" class="rc-input rc-date" data-pick-date value="${esc(W.day && W.day > addDays(start, days - 1) ? W.day : '')}" min="${state.today}"></label></div>
      <div class="rc-label">What time?</div><div class="rc-chips">${window.FORMS.TIME_SLOTS.map(([k, l]) => chip('slot', k, W.slot, l)).join('')}</div>
      <label class="rc-label">Anything the driver should know? <span class="muted">(optional)</span>
        <textarea class="rc-input" rows="2" data-text-notes placeholder="e.g. dump half by the garage, gate code 4321">${esc(W.notes)}</textarea></label>`;
  }

  function summaryCard() {
    const job = jobFromCall();
    const t = P.totals(W.lines || [], book?.hst_rate ?? 13);
    return `<div class="rc-summary"><h3>${W.editId ? `Changing work order #${W.editId}` : 'Work order'}</h3>
      <div>${W.cust.name ? `<b>${esc(W.cust.name)}</b>` : '<span class="muted">No name yet</span>'}${W.cust.phone ? ' · ' + esc(W.cust.phone) : ''}</div>
      <div>${esc([W.addr.to_location, W.addr.municipality].filter(Boolean).join(', ')) || '<span class="muted">No address yet</span>'}</div>
      <div>${esc(window.FORMS.summary(job) || (SVC[W.svc] || [])[2] || '')}</div>
      <div><b>${W.day ? esc(shortDay(W.day)) : '<span class="muted">No day yet</span>'}${W.slot ? ' · ' + esc(window.FORMS.slotLabel(W.slot)) : ''}</b></div>
      ${t.total ? `<div class="rc-sum-tot">${money(t.total)} <small>incl. HST</small></div>` : ''}
      <p class="muted small">Dispatch picks the driver and texts them.</p></div>`;
  }

  // ---------- the two layouts ----------
  const STEPS = [['what', 'What they need'], ['where', 'Where & price'], ['who', 'Who'], ['day', 'Which day']];
  function stepDone(i) {
    const job = jobFromCall();
    if (i === 0) return W.svc && (W.svc !== 'haul' || job.material) ? (window.FORMS.summary(job) || (SVC[W.svc] || [])[2]) : '';
    if (i === 1) return W.addr.to_location || W.pin ? money(P.totals(W.lines || [], book?.hst_rate ?? 13).total) : '';
    if (i === 2) return W.cust.name || W.cust.phone ? (W.cust.name || W.cust.phone) : '';
    return '';
  }

  async function renderCall() {
    if (!W) W = freshCall();
    await loadCal();
    const mode = store.get('mode', 'steps');
    const err = W.error ? `<div class="rc-error">${esc(W.error)}${W.missing ? ' <button type="button" class="btn tiny" data-draft>Save as a draft instead</button>' : ''}</div>` : '';
    if (W.done) { root().innerHTML = nav() + doneScreen(); return; }
    if (mode === 'quick') {
      // Pricing is worked out once so the summary can show it.
      whereSection();
      root().innerHTML = nav() + `<div class="rc-one">
        <section class="rc-card">${whoSection()}</section>
        <section class="rc-card">${whatSection()}<hr>${whereSection()}<hr>${daySection({ compact: true })}${err}
          <div class="rc-actions">${W.editId ? '' : '<button class="btn big" data-save-quote>Save as quote</button>'}<button class="btn primary big" data-book>${W.editId ? '✓ Save changes' : '✓ Book it'}</button></div></section>
        ${askPanel()}</div>`;
    } else {
      const i = W.step - 1;
      const bar = `<div class="rc-steps">${STEPS.map(([, l], n) => {
        const done = n < i && stepDone(n);
        return `<button class="rc-step ${n === i ? 'on' : ''} ${done ? 'done' : ''}" data-step-to="${n + 1}"><span class="n">${done ? '✓' : n + 1}</span>${esc(done || l)}</button>`;
      }).join('')}</div>`;
      const body = [whatSection, whereSection, whoSection, daySection][i]();
      if (i === 3) whereSection(); // keep the price current for the summary
      const next = i < 3 ? `<button class="btn primary big" data-next>${['Next: where & price →', 'They want it → who is it for', 'Next: pick the day →'][i]}</button>`
        : `<button class="btn primary big" data-book>${W.editId ? '✓ Save changes' : '✓ Book it'}</button>`;
      root().innerHTML = nav() + bar + `<div class="rc-cols">
        <section class="rc-card">${body}${err}
          <div class="rc-actions">${i > 0 ? '<button class="btn big" data-back>← Back</button>' : ''}
            ${i === 1 && !W.editId ? '<button class="btn big" data-save-quote>Save as quote</button>' : ''}${next}</div></section>
        ${i === 3 ? `<aside>${summaryCard()}</aside>` : askPanel()}</div>`;
    }
    wireCall();
  }

  function doneScreen() {
    const j = W.done;
    const when = `${dayName(j.scheduled_date)}${slotWords[j.time_slot] ? ' ' + slotWords[j.time_slot] : ''}`;
    return `<div class="rc-done"><div class="ck">✓</div>
      <h1 class="rc-h1">${W.wasEdit ? 'Changed' : j.draft ? 'Saved as a draft' : 'Booked'} — work order #${j.id}</h1>
      <div class="rc-sub">${j.draft ? 'Finish it when you have the rest — dispatch can\'t text drivers until then.' : 'Dispatch has it. They\'ll assign the driver.'}</div>
      ${j.draft ? '' : `<div class="rc-tell">🗣 <b>Tell the customer:</b> "You're booked for <b>${esc(when)}</b>. Your work order number is <b>${j.id}</b>.${j.totals?.total ? ` The total is <b>${money(j.totals.total)}</b> including HST.` : ''}"</div>`}
      <div class="rc-actions center"><a class="btn big" href="/print/${j.id}" target="_blank" rel="noopener">🖨 Print work order</a>
        <button class="btn big" data-go="home">⌂ Home</button><button class="btn primary big" data-go="call">📞 Next call</button></div></div>`;
  }

  // ---------- events ----------
  let distTimer;
  let matchTimer;
  function wireCall() {
    const r = root();
    $$('[data-addr]', r).forEach((el) => el.addEventListener('change', () => {
      W.addr[el.dataset.addr] = el.value.trim();
      W.pin = null;
      lookupDistance();
    }));
    $$('[data-cust]', r).forEach((el) => el.addEventListener('input', () => {
      W.cust[el.dataset.cust] = el.value;
      if (el.dataset.cust === 'phone' || el.dataset.cust === 'name') {
        if (el.dataset.cust === 'phone' || !W.cust.customer_id) { /* keep typing */ }
        clearTimeout(matchTimer);
        matchTimer = setTimeout(findMatch, 350);
      }
    }));
    $('[data-text=what]', r)?.addEventListener('input', (e) => { W.f.what = e.target.value; });
    $('[data-text-notes]', r)?.addEventListener('input', (e) => { W.notes = e.target.value; });
    $$('[data-xf]', r).forEach((el) => el.addEventListener('input', () => { W.x[el.dataset.xf] = el.value; }));
    $('[data-pick-date]', r)?.addEventListener('change', (e) => { if (e.target.value) { W.day = e.target.value; renderCall(); } });
    $('[data-set-select]', r)?.addEventListener('change', (e) => { if (e.target.value) { W.f.material = e.target.value; renderCall(); } });
    $('#rc-ask-side', r)?.addEventListener('input', (e) => { $('#rc-ask-side-out').innerHTML = answersHtml(e.target.value, W.svc); });
    $$('[data-check]', r).forEach((el) => el.addEventListener('change', () => { W.f[el.dataset.check] = el.checked; renderCall(); }));
  }

  async function findMatch() {
    const digits = W.cust.phone.replace(/\D/g, '');
    const q = digits.length >= 7 ? digits : W.cust.name.trim().length >= 3 ? W.cust.name.trim() : '';
    if (!q) { W.match = null; const box = $('#rc-match'); if (box) box.innerHTML = ''; return; }
    const list = await api('/customers/search?q=' + encodeURIComponent(q)).catch(() => []);
    W.match = list[0] || null;
    const box = $('#rc-match');
    if (box) box.innerHTML = W.match ? matchCard(W.match) : '';
  }

  async function lookupDistance(point) {
    const address = [W.addr.to_location, W.addr.municipality].filter(Boolean).join(', ');
    if (!point && !W.addr.to_location) return renderCall();
    if (!state.maps?.distance) {
      W.distError = 'Distances aren\'t set up yet — ask an admin. The price is shown without delivery.';
      return renderCall();
    }
    W.distBusy = true; W.distError = '';
    renderCall();
    try {
      const d = await api('/distance', { method: 'POST', body: { address: point ? undefined : address, lat: point?.lat, lng: point?.lng } });
      W.dist = d;
      if (!W.addr.municipality && d.municipality) W.addr.municipality = d.municipality;
    } catch (err) { W.distError = err.message; }
    W.distBusy = false;
    renderCall();
  }

  function bodyForSave(draft = false) {
    const job = jobFromCall();
    const out = { ...job, lines: W.lines || [], draft, assignments: W.existing?.assignments?.map((a) => ({ driver_id: a.driver_id, truck_id: a.truck_id })) || [] };
    if (W.svc === 'water' && !out.notes.includes('$130/hour')) out.notes = [out.notes, 'Water delivery billed $130/hour.'].filter(Boolean).join(' ');
    if (W.quoteId) out.quote_id = W.quoteId;
    return out;
  }

  async function bookIt(draft = false) {
    if (!W.svc) { W.error = 'Pick what they need first.'; return renderCall(); }
    if (!W.day) { W.error = 'Pick a day.'; W.step = 4; return renderCall(); }
    const body = bodyForSave(draft);
    try {
      const out = W.editId ? await api('/jobs/' + W.editId, { method: 'PUT', body }) : await api('/jobs', { method: 'POST', body });
      W.wasEdit = Boolean(W.editId);
      W.done = out.job;
      W.error = '';
      renderCall();
    } catch (err) {
      W.error = err.message;
      W.missing = err.missing || null;
      renderCall();
    }
  }

  async function saveQuote() {
    if (!W.svc) { W.error = 'Pick what they need first.'; return renderCall(); }
    // A quote is for calling back: get a name and number if we don't have them yet.
    if (!W.cust.phone) {
      const phone = prompt('Their phone number, to call them back:', '');
      if (phone === null) return;
      W.cust.phone = phone.trim();
    }
    if (!W.cust.name) {
      const name = prompt('Their name:', '');
      if (name === null) return;
      W.cust.name = name.trim();
    }
    const job = jobFromCall();
    const t = P.totals(W.lines || [], book?.hst_rate ?? 13);
    try {
      const q = await api(W.quoteId ? '/quotes/' + W.quoteId : '/quotes', { method: W.quoteId ? 'PUT' : 'POST',
        body: { job: { ...job, _svc: W.svc, _f: W.f, _dist: W.dist, _pin: W.pin }, total: t.total, summary: window.FORMS.summary(job) } });
      toast(`Quote saved${q.customer ? ' for ' + q.customer : ''} — it's on the home screen to call back`);
      go('home');
    } catch (err) { toast(err.message); }
  }

  /** Load a saved work order into the call screen, to change it (or book the same again). */
  function callFromJob(job, { again = false } = {}) {
    W = freshCall();
    const d = job.details || {};
    const t = job.job_type;
    W.svc = t === 'haul' ? 'haul' : t === 'septic' ? 'septic' : t === 'bin' ? 'bin' : t === 'toilet' ? 'toilet'
      : t === 'misc' && /^water$/i.test(job.material || '') ? 'water' : t === 'misc' ? 'other' : null;
    if (!W.svc) return false;
    const po = job.price_options || {};
    if (W.svc === 'haul') Object.assign(W.f, { material: job.material, truck: d.truck || (job.quantity ? 'Yards' : 'Triaxle'), qty: Number(job.loads_planned || job.quantity) || 1 });
    if (W.svc === 'septic') Object.assign(W.f, { gallons: String(d.tank_size || '').replace(/\D/g, ''), tank_type: d.tank_type || 'Septic', chamber: po.pump_chamber_too, off: po.off_schedule });
    if (W.svc === 'bin') Object.assign(W.f, { size: job.material, service: d.service || 'Deliver bin', waste: po.waste || 'mixed' });
    if (W.svc === 'toilet') Object.assign(W.f, { toilet: d.toilet1_type, qty: Number(d.toilet1_qty) || 1, trip: d.trip || 'Deliver', period: po.period || 'week', off: po.off_schedule });
    if (W.svc === 'water') W.f.qty = Number(job.loads_planned) || 1;
    if (W.svc === 'other') W.f.what = job.material;
    W.x = Object.fromEntries(receptionFields(W.svc).filter((f) => d[f.key] !== undefined).map((f) => [f.key, d[f.key]]));
    W.addr = { to_location: job.to_location || '', municipality: job.municipality || '' };
    W.dist = job.distance_km != null ? { km: job.distance_km, in_town: job.in_town, from: job.distance_from, mode: job.distance_mode } : {};
    W.cust = { phone: A.prettyPhone(job.customer_phone || ''), name: job.customer || '', email: job.customer_email || '', billing_address: job.billing_address || '', customer_id: job.customer_id || '' };
    W.notes = job.notes || '';
    if (again) {
      W.existing = null;
      W.step = 4;
    } else {
      W.existing = job;
      W.editId = job.id;
      W.day = job.scheduled_date;
      W.slot = job.time_slot || '';
      W.step = 1;
    }
    return true;
  }

  function callFromQuote(q) {
    const j = q.job || {};
    W = freshCall();
    W.svc = j._svc || '';
    W.f = { ...W.f, ...(j._f || {}) };
    W.x = Object.fromEntries(receptionFields(W.svc).filter((f) => (j.details || {})[f.key] !== undefined).map((f) => [f.key, j.details[f.key]]));
    W.dist = j._dist || {};
    W.pin = j._pin || null;
    W.addr = { to_location: j.to_location || '', municipality: j.municipality || '' };
    W.cust = { phone: j.customer_phone || '', name: j.customer || '', email: j.customer_email || '', billing_address: j.billing_address || '', customer_id: j.customer_id || '' };
    W.notes = j.notes || '';
    W.quoteId = q.id;
    W.step = 3;
  }

  // One click handler for the whole reception view.
  document.addEventListener('click', async (e) => {
    if (!document.body.classList.contains('reception')) return;
    const el = e.target.closest('[data-xset],[data-go],[data-mode],[data-svc],[data-set],[data-step],[data-day],[data-next],[data-back],[data-step-to],[data-book],[data-draft],[data-save-quote],[data-pin],[data-use-match],[data-quote],[data-drop-quote],[data-edit],[data-cancel],[data-again],[data-cust-jobs],[data-call-for],[data-find-back]');
    if (!el || !root().contains(el)) return;
    const ds = el.dataset;
    try {
      if (ds.xset) { W.x[ds.xset] = W.x[ds.xset] === ds.val ? '' : ds.val; return renderCall(); }
      if (ds.go) return go(ds.go);
      if (ds.mode) { store.set('mode', ds.mode); return renderCall(); }
      if (ds.svc) { W.svc = ds.svc; W.error = ''; if (ds.svc === 'haul' && !W.f.material) W.f.material = ''; return renderCall(); }
      if (ds.set) {
        if (ds.set === 'slot') W.slot = ds.val;
        else W.f[ds.set] = ds.val;
        if (ds.set === 'truck' && !W.f.qty) W.f.qty = 1;
        return renderCall();
      }
      if (ds.step) { W.f[ds.step] = Math.max(1, (Number(W.f[ds.step]) || 1) + Number(ds.by)); return renderCall(); }
      if (ds.day) { W.day = ds.day; W.error = ''; return renderCall(); }
      if ('next' in ds) {
        if (W.step === 1 && !W.svc) { W.error = 'Pick what they need.'; return renderCall(); }
        W.error = ''; W.step = Math.min(4, W.step + 1); return renderCall();
      }
      if ('back' in ds) { W.error = ''; W.step = Math.max(1, W.step - 1); return renderCall(); }
      if (ds.stepTo) { W.step = Number(ds.stepTo); return renderCall(); }
      if ('book' in ds) return bookIt(false);
      if ('draft' in ds) return bookIt(true);
      if ('saveQuote' in ds) return saveQuote();
      if ('pin' in ds) return window.PRICE_UI.openPin(W.pin, (p) => { W.pin = p; lookupDistance(p); });
      if ('useMatch' in ds) {
        const m = W.match;
        Object.assign(W.cust, { customer_id: m.id, name: W.cust.name || m.name, email: W.cust.email || m.email || '',
          billing_address: W.cust.billing_address || m.billing_address || '', phone: W.cust.phone || A.prettyPhone(m.phone) });
        if (!W.addr.to_location && m.site_address) { W.addr = { to_location: m.site_address, municipality: m.municipality || '' }; lookupDistance(); }
        if (m.notes && !W.notes.includes(m.notes)) W.notes = [W.notes, m.notes].filter(Boolean).join(' ');
        return renderCall();
      }
      if (ds.quote) { callFromQuote(await api('/quotes/' + ds.quote)); view = 'call'; return renderCall(); }
      if (ds.dropQuote) { await api(`/quotes/${ds.dropQuote}/status`, { method: 'POST', body: { status: 'dropped' } }); return renderHome(); }
      if (ds.edit || ds.again) {
        const job = await api('/jobs/' + (ds.edit || ds.again));
        if (!callFromJob(job, { again: Boolean(ds.again) })) return A.openJobForm(job); // floats, labour…: the full form
        view = 'call';
        return renderCall();
      }
      if (ds.cancel) {
        const job = await api('/jobs/' + ds.cancel);
        const texted = job.assignments.some((a) => a.status !== 'pending' && a.status !== 'cancelled');
        if (!confirm(`Cancel work order #${job.id} for ${job.customer || 'this customer'} on ${shortDay(job.scheduled_date)}?${texted ? '\n\nThe driver was already texted — they\'ll get a text saying it\'s cancelled.' : ''}`)) return;
        await api(`/jobs/${job.id}/cancel`, { method: 'POST', body: {} });
        toast(`Work order #${job.id} cancelled`);
        return render();
      }
      if (ds.custJobs) { findCustomer = JSON.parse(ds.custJobs); return findResults(); }
      if ('findBack' in ds) { findCustomer = null; return findResults(); }
      if (ds.callFor) {
        const c = JSON.parse(ds.callFor);
        W = freshCall();
        W.cust = { phone: A.prettyPhone(c.phone), name: c.name || '', email: c.email || '', billing_address: c.billing_address || '', customer_id: c.id };
        W.addr = { to_location: c.site_address || '', municipality: c.municipality || '' };
        W.match = c;
        if (c.notes) W.notes = c.notes;
        view = 'call';
        await renderCall();
        if (W.addr.to_location) lookupDistance();
      }
    } catch (err) { toast(err.message); }
  });

  window.RECEPTION = { start };
})();
