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
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), data.missing ? { missing: data.missing } : {});
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
  function jobTime(job) {
    if (job.time_slot) return job.time_slot === 'any' ? '' : window.FORMS.slotLabel(job.time_slot);
    const t = fmtTime(job.scheduled_time); // jobs from before AM / PM
    if (job.first_thing) return 'First thing';
    return t;
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
    if (tab === 'requests') loadRequests();
    if (tab === 'records') loadRecords();
    if (tab === 'customers') loadCustomers();
    if (tab === 'prices') window.PRICE_UI?.loadPrices();
    if (tab === 'faq') window.PRICE_UI?.loadFaq();
    if (tab === 'people' && state.can?.owner) window.PRICE_UI?.loadUsers();
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

    // Alerts: driver texts the system didn't understand.
    const rc = $('#request-count');
    rc.textContent = state.board.new_requests || '';
    rc.classList.toggle('hidden', !state.board.new_requests);
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

    renderJobsArea(jobs);

    renderDriverStrip(drivers);
  }

  /** Drivers across the top: busy ones first (yellow if waiting on their OK), then free ones in green. */
  function driverRows(drivers) {
    return drivers.map((d) => {
      const todo = d.jobs.filter((j) => j.status !== 'done' && j.status !== 'cancelled');
      const done = d.jobs.filter((j) => j.status === 'done');
      return { d, todo, done };
    }).sort((a, b) => (b.todo.length > 0) - (a.todo.length > 0) || a.d.name.localeCompare(b.d.name));
  }

  const SHORT_STATUS = { pending: 'not texted', sent: 'waiting for OK', acknowledged: 'confirmed', in_progress: 'working' };

  function renderDriverStrip(drivers) {
    const rows = driverRows(drivers);
    $('#driver-strip').innerHTML = drivers.length ? `<span class="strip-label">Drivers</span>` + rows.map(({ d, todo, done }) => {
      const waiting = todo.some((j) => j.status === 'sent' || j.status === 'pending');
      const cls = !todo.length ? 'free' : waiting ? 'waiting' : 'busy';
      const initials = d.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      const sub = todo.length
        ? todo.map((j) => `#${j.job_id}`).join(', ') + ` · ${SHORT_STATUS[todo[0].status] || todo[0].status}`
        : `Free${done.length ? ` · ${done.length} done` : ''}`;
      return `<div class="dchip ${cls}" title="${esc(done.map((j) => `✓ #${j.job_id}`).join(' '))}">
        <span class="davatar">${esc(initials)}</span>
        <span class="dtext"><span class="dname">${esc(d.name)}</span><span class="dsub">${esc(sub)}</span></span>
      </div>`;
    }).join('') : '<span class="muted">Add drivers on the Setup tab.</span>';
  }

  document.addEventListener('click', (e) => {
    for (const d of $$('details[open]')) if (!d.contains(e.target)) d.removeAttribute('open');
  });

  // ---------- board filters ----------
  const VIEWS = [
    ['active', 'Active'], ['attention', 'Needs attention'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['all', 'All'],
  ];
  const store = {
    get(k, d) { try { return localStorage.getItem('dispatch.' + k) || d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('dispatch.' + k, v); } catch { /* private mode */ } },
  };
  state.view = store.get('view', 'active');
  state.typeFilter = store.get('type', '');
  state.showDone = false;
  state.showStale = false;

  const minutesSince = (sqlUtc) => (sqlUtc ? (Date.now() - new Date(sqlUtc.replace(' ', 'T') + 'Z').getTime()) / 60000 : 0);

  /** Why a job needs the office's attention (empty = it doesn't). */
  function attentionReasons(job) {
    if (job.status !== 'open') return [];
    const out = [];
    if (Number(job.draft)) out.push('Draft — finish it');
    const live = job.assignments.filter((a) => a.status !== 'cancelled');
    if (!live.length) out.push('No driver');
    if (live.some((a) => a.status === 'pending')) out.push('Not texted');
    if (live.some((a) => a.needs_resend && a.status !== 'done')) out.push('Needs update text');
    if (live.some((a) => a.status === 'sent' && !a.needs_resend && minutesSince(a.sent_at) > 30)) out.push('No OK yet');
    if ((state.board?.alerts || []).some((m) => m.job_id === job.id)) out.push('Driver texted');
    return out;
  }

  function inView(job, view) {
    if (view === 'active') return job.status === 'open';
    if (view === 'attention') return attentionReasons(job).length > 0;
    if (view === 'done') return job.status === 'complete';
    if (view === 'cancelled') return job.status === 'cancelled';
    return true;
  }

  function renderFilters(jobs) {
    const typed = jobs.filter((j) => !state.typeFilter || j.job_type === state.typeFilter);
    const n = (v) => typed.filter((j) => inView(j, v)).length;
    const rows = driverRows(state.board.drivers || []);
    const free = rows.filter((r) => !r.todo.length).length;
    const att = n('attention');
    const tile = (view, label, value, extra = '') =>
      `<button class="tile ${state.view === view ? 'on' : ''} ${extra}" data-view="${view}"><span class="tl">${label}</span><span class="tv">${value}</span></button>`;
    $('#status-filter').innerHTML =
      tile('active', 'Active', n('active')) +
      tile('attention', 'Needs attention', att, att ? 'alarm' : '') +
      tile('done', state.date === state.today ? 'Done today' : 'Done', n('done')) +
      `<div class="tile static"><span class="tl">Drivers free</span><span class="tv">${free} <small>of ${rows.length}</small></span></div>` +
      `<button class="tile link-tile" data-act="go-requests"><span class="tl">Website requests</span><span class="tv">${state.board.new_requests || 0} <small>new →</small></span></button>`;
    const counts = Object.fromEntries(TYPE_KEYS.map((k) => [k, jobs.filter((j) => j.job_type === k).length]));
    $('#type-filter').innerHTML = `<span class="row-label">Type</span>` +
      `<button class="fchip small ${!state.typeFilter ? 'on' : ''}" data-type="">All <span>${jobs.length}</span></button>` +
      TYPE_KEYS.filter((k) => counts[k] || state.typeFilter === k).map((k) =>
        `<button class="fchip small ${state.typeFilter === k ? 'on' : ''}" data-type="${k}">${TYPES[k].icon} ${esc(TYPES[k].name)} <span>${counts[k]}</span></button>`).join('') +
      `<span class="spacer"></span>` +
      `<button class="link ${state.view === 'cancelled' ? 'on' : ''}" data-view="cancelled">Cancelled (${n('cancelled')})</button>` +
      `<button class="link ${state.view === 'all' ? 'on' : ''}" data-view="all">All statuses (${n('all')})</button>`;
  }

  // Which lane a job sits in: still to text, waiting for the driver's OK, being worked, or done.
  function stageOf(job) {
    if (job.status === 'complete') return 'done';
    if (job.status === 'cancelled') return 'cancelled';
    const live = job.assignments.filter((a) => a.status !== 'cancelled');
    if (!live.length || live.some((a) => a.status === 'pending')) return 'totext';
    if (live.some((a) => a.status === 'sent' || (a.needs_resend && a.status !== 'done'))) return 'waiting';
    return 'working';
  }
  const LANES = [
    ['totext', 'To text', 'Assigned, drivers not texted yet'],
    ['waiting', 'Waiting for OK', 'Texted, no reply yet'],
    ['working', 'Working', 'Confirmed or loads underway'],
    ['done', 'Done', 'Finished'],
  ];
  state.layout = store.get('layout', 'lanes');

  function renderLanes(jobs) {
    const lanes = state.view === 'attention' ? LANES.filter(([k]) => k !== 'done') : LANES;
    return `<div class="lanes lanes-${lanes.length}">` + lanes.map(([k, title, hint]) => {
      const list = jobs.filter((j) => stageOf(j) === k);
      const label = k === 'done' && state.date === state.today ? 'Done today' : title;
      return `<section class="lane lane-${k}">
        <div class="lane-head"><span class="lane-dot"></span><h2>${label}</h2><span class="lane-count">${list.length}</span></div>
        ${list.length ? list.map((j) => renderJob(j, { compact: true })).join('') : `<div class="lane-empty">${hint}</div>`}
      </section>`;
    }).join('') + '</div>';
  }

  function renderJobsArea(jobs) {
    const stale = state.board.stale_jobs || [];
    $('#stale-banner').innerHTML = stale.length && !state.showStale ? `
      <div class="alert stale">⚠ <span class="body"><b>${stale.length} job${stale.length === 1 ? '' : 's'} from earlier days ${stale.length === 1 ? 'was' : 'were'} never marked done.</b>
        Finish, move or cancel ${stale.length === 1 ? 'it' : 'them'} so nothing gets missed.</span>
        <button class="btn tiny" data-act="show-stale">Review</button></div>` : '';

    // Calendar: the month at a glance; click a day to open it.
    const month = state.layout === 'month';
    document.body.classList.toggle('month-view', month);
    $$('.layout-toggle [data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === state.layout)));
    if (month) {
      const [cy, cm] = state.date.split('-').map(Number);
      $('#board-title').textContent = new Date(Date.UTC(cy, cm - 1, 1))
        .toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      $('#jobs').classList.remove('as-lanes', 'hidden');
      $('#map-panel').classList.add('hidden');
      renderCalendar();
      return;
    }

    if (state.showStale) {
      $('#board-filters').classList.add('hidden');
      $('#jobs').innerHTML = `<div class="view-head"><h3>Unfinished from earlier days (${stale.length})</h3>
          <button class="btn" data-act="hide-stale">← Back to the board</button></div>` +
        (stale.length ? stale.map((j) => renderJob(j, { stale: true })).join('') : '<div class="empty">All caught up.</div>');
      return;
    }
    $('#board-filters').classList.remove('hidden');
    renderFilters(jobs);
    const typed = jobs.filter((j) => !state.typeFilter || j.job_type === state.typeFilter);
    const shown = typed.filter((j) => inView(j, state.view));
    const doneHere = state.view === 'active' ? typed.filter((j) => j.status === 'complete') : [];
    const emptyText = {
      active: doneHere.length ? 'Everything on this day is done. 🎉' : 'No open jobs on this day.',
      attention: 'Nothing needs attention. 👍', done: 'Nothing finished yet.', cancelled: 'No cancelled jobs.', all: 'No jobs.',
    }[state.view];
    const lanes = state.layout === 'lanes' && ['active', 'attention'].includes(state.view) && jobs.length;
    $$('.layout-toggle [data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === state.layout)));
    $('#jobs').classList.toggle('as-lanes', Boolean(lanes));
    const onMap = state.layout === 'map';
    $('#jobs').classList.toggle('hidden', onMap);
    $('#map-panel').classList.toggle('hidden', !onMap);
    if (onMap) {
      renderMap(state.view === 'active' ? typed.filter((j) => j.status !== 'cancelled') : shown);
      return;
    }
    if (lanes) {
      // In lanes, finished jobs have their own column, so the board shows open ones plus today's done.
      const laneJobs = state.view === 'attention' ? shown : typed.filter((j) => j.status !== 'cancelled');
      $('#jobs').innerHTML = renderLanes(laneJobs);
      return;
    }
    let html = !jobs.length
      ? `<div class="empty">No jobs on this day yet.<br><br><button class="btn primary big" data-act="new">+ New job</button></div>`
      : shown.length ? shown.map((j) => renderJob(j)).join('') : `<div class="empty">${emptyText}</div>`;
    if (doneHere.length) {
      const label = state.date === state.today ? 'Completed today' : 'Completed';
      html += `<div class="done-strip"><button class="link" data-act="toggle-done">${state.showDone ? '▾' : '▸'} ✓ ${label} (${doneHere.length})</button></div>`;
      if (state.showDone) html += doneHere.map((j) => renderJob(j)).join('');
    }
    $('#jobs').innerHTML = html;
  }

  // Tiles, type chips, the Cancelled / All links and the Lanes / List switch.
  $('#tab-board').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    const t = e.target.closest('[data-type]');
    const l = e.target.closest('[data-layout]');
    if (v) { state.view = state.view === v.dataset.view && v.dataset.view !== 'active' ? 'active' : v.dataset.view; store.set('view', state.view); }
    if (t) { state.typeFilter = t.dataset.type; store.set('type', state.typeFilter); }
    if (l) {
      if (l.dataset.layout !== 'month') store.set('day-layout', l.dataset.layout);
      state.layout = l.dataset.layout;
      store.set('layout', state.layout);
    }
    if (v || t || l) renderBoard();
  });

  // ---------- map view (Google Maps) ----------
  const STAGE_COLOURS = { totext: '#8A8A8A', waiting: '#FFD101', working: '#2D6CDF', done: '#1E9E5A', cancelled: '#C0392B' };
  const mapState = { ready: null, map: null, markers: new Map(), yard: null, info: null, geocoder: null, jobs: [], fitted: '',
    failed: new Map(), geoError: '', placing: null };
  const geoQuery = (a) => (/\bon(tario)?\b/i.test(a) ? a : `${a}, Ontario`) + ', Canada';

  function loadGoogleMaps() {
    if (mapState.ready) return mapState.ready;
    mapState.ready = new Promise((resolve, reject) => {
      window.__adamsMapsReady = resolve;
      window.gm_authFailure = () => mapProblem('Google turned down the Maps key. Check the key, that the Maps JavaScript API and Geocoding API are turned on, and that the key allows this site’s address.');
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(state.maps.key)}&v=weekly&libraries=marker&loading=async&callback=__adamsMapsReady`;
      s.async = true;
      s.onerror = () => { mapState.ready = null; reject(new Error('Could not load Google Maps — check the internet connection.')); };
      document.head.append(s);
    });
    return mapState.ready;
  }

  function mapProblem(html) {
    $('#map').innerHTML = `<div class="map-setup">${html}</div>`;
    mapState.map = null;
  }

  async function initMap() {
    if (mapState.map) return true;
    if (!state.maps?.key) {
      mapProblem(`<h3>Turn on the map</h3><p>The map needs a free Google Maps key. In Google Cloud: create a project, turn on the
        <b>Maps JavaScript API</b> and <b>Geocoding API</b>, create an API key and restrict it to <b>Websites</b> →
        <code>${esc(location.origin)}/*</code>. Then add it on Replit as the secret <code>GOOGLE_MAPS_API_KEY</code> and republish.</p>
        <p class="muted small">Google gives a monthly free allowance; a dispatch office this size normally stays inside it.</p>`);
      return false;
    }
    try { await loadGoogleMaps(); } catch (err) { mapProblem(esc(err.message)); return false; }
    const { Map, InfoWindow } = await google.maps.importLibrary('maps');
    await google.maps.importLibrary('marker');
    $('#map').innerHTML = '';
    mapState.map = new Map($('#map'), { center: { lat: 45.3469, lng: -80.0353 }, zoom: 10, mapId: state.maps.mapId,
      streetViewControl: false, mapTypeControl: true, fullscreenControl: true, gestureHandling: 'greedy' });
    mapState.info = new InfoWindow();
    mapState.geocoder = new google.maps.Geocoder();
    // "Place on map": the next click on the map sets that job's pin.
    mapState.map.addListener('click', async (e) => {
      const id = mapState.placing;
      if (!id || !e.latLng) return;
      mapState.placing = null;
      showMapAlert();
      try {
        await api(`/jobs/${id}/location`, { method: 'POST', body: { lat: e.latLng.lat(), lng: e.latLng.lng(), manual: true } });
        toast(`Pin placed for job #${id}`);
        await loadBoard();
      } catch (err) { toast(err.message); }
    });
    const yard = await placeFor(state.maps.yard);
    if (yard) {
      mapState.yard = new google.maps.marker.AdvancedMarkerElement({ map: mapState.map, position: yard, title: 'Adams Bros yard',
        content: pinEl('A', '#111', '#FFD101') });
    }
    return true;
  }

  function pinEl(label, bg, fg = '#111') {
    const el = document.createElement('div');
    el.className = 'map-pin';
    el.style.background = bg;
    el.style.color = fg;
    el.textContent = label;
    return el;
  }

  // Address → point: the shared cache first, then Google's geocoder (which is then cached for everyone).
  async function placeFor(address) {
    if (!address) return null;
    const hit = (await api('/geocodes/lookup', { method: 'POST', body: { addresses: [address] } }).catch(() => ({})))[address];
    if (hit) return hit;
    // Don't ask Google again for an address it already couldn't find (the board refreshes every few seconds).
    if (mapState.failed.has(address)) return null;
    try {
      const { results } = await mapState.geocoder.geocode({ address: geoQuery(address), region: 'ca' });
      if (!results?.length) { mapState.failed.set(address, 'ZERO_RESULTS'); return null; }
      const loc = results[0].geometry.location;
      const p = { lat: loc.lat(), lng: loc.lng() };
      api('/geocodes', { method: 'POST', body: { address, ...p } }).catch(() => {});
      return p;
    } catch (err) {
      const code = String(err?.code || err?.message || 'ERROR');
      mapState.failed.set(address, code);
      if (!/ZERO_RESULTS/.test(code)) { mapState.geoError = code; showMapAlert(); }
      return null;
    }
  }

  function showMapAlert() {
    const box = $('#map-alert');
    const code = mapState.geoError;
    if (mapState.placing) {
      box.innerHTML = `📍 <b>Click on the map where job #${mapState.placing} is.</b> <button class="link" data-map-cancel>Cancel</button>`;
    } else if (/REQUEST_DENIED/.test(code)) {
      box.innerHTML = `<b>Google won't look up addresses with this key (REQUEST_DENIED).</b> In Google Cloud console:
        <b>APIs &amp; Services → Library → Geocoding API → Enable</b>. Then <b>Credentials</b> → your key → if
        "Restrict key" is on under API restrictions, tick <b>Geocoding API</b> as well as Maps JavaScript API. Save, wait a couple
        of minutes, and reload this page. Until then you can place pins by hand with <b>Place on map</b>.`;
    } else if (/OVER_QUERY_LIMIT|OVER_DAILY_LIMIT/.test(code)) {
      box.innerHTML = `<b>Google's address lookup limit was reached (${esc(code)}).</b> Check billing is set up on the Google Cloud project. You can still place pins by hand.`;
    } else if (code) {
      box.innerHTML = `<b>Address lookup failed (${esc(code)}).</b> You can place pins by hand with <b>Place on map</b>.`;
    }
    box.classList.toggle('hidden', !mapState.placing && !code);
  }

  async function renderMap(jobs) {
    mapState.jobs = jobs;
    if (!(await initMap())) { renderMapSide(jobs, new Set()); return; }
    if (mapState.jobs !== jobs) return; // a newer refresh took over while the map loaded
    const missing = new Set();
    const seen = new Set();
    const stacked = {};
    const bounds = new google.maps.LatLngBounds();
    if (mapState.yard) bounds.extend(mapState.yard.position);
    // Look up every address we don't have a pin for in one go.
    const need = [...new Set(jobs.filter((j) => j.lat == null && siteAddress(j)).map(siteAddress))];
    const cached = need.length ? await api('/geocodes/lookup', { method: 'POST', body: { addresses: need } }).catch(() => ({})) : {};
    for (const j of jobs) {
      let pos = j.lat != null ? { lat: j.lat, lng: j.lng } : cached[siteAddress(j)];
      if (!pos && siteAddress(j)) {
        pos = await placeFor(siteAddress(j));
        if (pos) { cached[siteAddress(j)] = pos; api(`/jobs/${j.id}/location`, { method: 'POST', body: pos }).catch(() => {}); }
      }
      if (!pos) { missing.add(j.id); continue; }
      // Several jobs at one address: fan the pins out a little so each can be clicked.
      const spot = `${pos.lat.toFixed(5)},${pos.lng.toFixed(5)}`;
      const k = (stacked[spot] = (stacked[spot] || 0) + 1) - 1;
      if (k) pos = { lat: pos.lat + 0.00025 * k, lng: pos.lng + 0.00035 * k };
      seen.add(j.id);
      bounds.extend(pos);
      const stage = stageOf(j);
      let m = mapState.markers.get(j.id);
      if (!m) {
        m = new google.maps.marker.AdvancedMarkerElement({ map: mapState.map, gmpDraggable: true });
        m.addListener('click', () => openMapInfo(m.jobId));
        m.addListener('dragend', async () => {
          const p = m.position;
          const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
          const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
          try { await api(`/jobs/${m.jobId}/location`, { method: 'POST', body: { lat, lng, manual: true } }); toast(`Pin moved for job #${m.jobId}`); loadBoard(); }
          catch (err) { toast(err.message); }
        });
        mapState.markers.set(j.id, m);
      }
      m.jobId = j.id;
      m.position = pos;
      m.title = `#${j.id} ${j.customer || ''} — ${siteAddress(j)}`;
      m.content = pinEl(String(j.id).slice(-3), STAGE_COLOURS[stage], stage === 'waiting' ? '#111' : '#fff');
      m.map = mapState.map;
    }
    for (const [id, m] of mapState.markers) if (!seen.has(id)) { m.map = null; mapState.markers.delete(id); }
    // Zoom to fit when the day or the set of jobs changes, not on every refresh.
    const sig = state.date + ':' + [...seen].sort().join(',');
    if (sig !== mapState.fitted && !bounds.isEmpty()) {
      mapState.fitted = sig;
      if (seen.size) mapState.map.fitBounds(bounds, 60);
      if (seen.size <= 1) mapState.map.setZoom(Math.min(mapState.map.getZoom() || 12, 12));
    }
    renderMapSide(jobs, missing);
  }

  function openMapInfo(jobId) {
    const j = mapState.jobs.find((x) => x.id === jobId);
    const m = mapState.markers.get(jobId);
    if (!j || !m) return;
    const drivers = j.assignments.filter((a) => a.status !== 'cancelled').map((a) => a.driver_name).join(', ');
    const nav = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(geoQuery(siteAddress(j)))}`;
    mapState.info.setContent(`<div class="map-info"><b>#${j.id} · ${esc(typeInfo(j.job_type).name)}</b>
      <div>${esc(j.customer || '')}</div><div class="muted">${esc(siteAddress(j))}</div>
      <div>${esc(cargo(j))}</div><div class="muted">${esc(drivers || 'No driver yet')}${jobTime(j) ? ' · ' + esc(jobTime(j)) : ''}</div>
      <div class="row-actions"><button class="btn tiny primary" data-act="edit" data-job="${j.id}">Edit</button>
        <a class="btn tiny" href="${nav}" target="_blank" rel="noopener">Directions</a></div></div>`);
    mapState.info.open({ map: mapState.map, anchor: m });
  }

  function renderMapSide(jobs, missing) {
    const rank = (j) => ({ first: 0, am: 1, pm: 2 }[j.time_slot] ?? 3);
    const list = jobs.slice().sort((a, b) => rank(a) - rank(b));
    $('#map-side').innerHTML = `<h3>${jobs.length} job${jobs.length === 1 ? '' : 's'}</h3>` + (list.map((j) => `
      <button type="button" class="map-item" data-map-job="${j.id}">
        <i class="dot st-${stageOf(j)}"></i><b>#${j.id}</b> ${esc(j.customer || typeInfo(j.job_type).name)}
        <span class="muted small">${esc(siteAddress(j) || 'No address')}${missing.has(j.id) ? ' · <em>not on the map</em>' : ''}</span>
      </button>${missing.has(j.id) && mapState.map ? `<button type="button" class="btn tiny map-place" data-map-place="${j.id}">📍 Place on map</button>` : ''}`).join('')
      || '<p class="muted">No jobs on this day.</p>');
  }

  $('#map-panel').addEventListener('click', (e) => {
    if (e.target.closest('[data-map-cancel]')) { mapState.placing = null; showMapAlert(); }
  });
  $('#map-side').addEventListener('click', (e) => {
    const place = e.target.closest('[data-map-place]');
    if (place) { mapState.placing = Number(place.dataset.mapPlace); showMapAlert(); return; }
    const b = e.target.closest('[data-map-job]');
    if (!b) return;
    const id = Number(b.dataset.mapJob);
    const m = mapState.markers.get(id);
    if (m && mapState.map) { mapState.map.panTo(m.position); openMapInfo(id); } else api('/jobs/' + id).then(openJobForm).catch((err) => toast(err.message));
  });

  function renderJob(job, { stale = false, compact = false } = {}) {
    const t = typeInfo(job.job_type);
    const active = job.assignments.filter((a) => a.status !== 'cancelled');
    const loadsDone = job.assignments.reduce((n, a) => n + a.loads_done, 0);
    const toSend = job.assignments.filter((a) => a.status === 'pending' || (a.needs_resend && a.status !== 'done')).length;
    const unconfirmed = active.filter((a) => a.status === 'sent' && !a.needs_resend).length;
    const statusTag = job.status === 'open' ? '' : `<span class="tag st-${job.status}">${job.status === 'complete' ? 'Done' : 'Cancelled'}</span>`;
    const planned = window.FORMS.totalLoads(job);
    const untilStop = job.job_type === 'haul' && job.details?.until_stop;
    const progress = planned || loadsDone || untilStop ? `
      <div class="progress"><span>Loads</span><span>${loadsDone}${planned ? ` of ${planned}` : ''}${untilStop ? ' · until site says stop' : ''}</span>
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
        ${job.status === 'cancelled' || !state.can.dispatch ? '' : `<details><summary aria-label="Driver actions">⋯</summary><div class="menu">
          <button data-act="resend" data-job="${job.id}" data-asg="${a.id}">${a.status === 'pending' ? 'Text this driver' : 'Re-send text'}</button>
          <button data-act="mark" data-token="${a.token}" data-mark="ack">Mark confirmed</button>
          <button data-act="mark" data-token="${a.token}" data-mark="load">+1 load</button>
          <button data-act="mark" data-token="${a.token}" data-mark="done">Mark done</button>
          ${a.status === 'done' ? `<button data-act="mark" data-token="${a.token}" data-mark="reopen">Undo done</button>` : ''}
          <button data-act="copylink" data-token="${a.token}">Copy driver's link</button>
        </div></details>`}
      </div>`;
    }).join('');

    // One clear main action per card; everything else under "More".
    let primary;
    if (job.status === 'cancelled') primary = ['reopen', 'Re-open'];
    else if (stale) primary = ['move-today', 'Move to today'];
    else if (toSend) primary = ['send', `Text ${toSend} driver${toSend > 1 ? 's' : ''}`];
    else if (unconfirmed) primary = ['resend-unconfirmed', 'Re-send text'];
    else if (job.status === 'open' && active.length) primary = ['complete', 'Mark complete'];
    else if (job.status === 'complete') primary = ['print', 'Print'];
    else primary = ['edit', 'Assign driver'];
    if (Number(job.draft) && job.status === 'open') primary = ['edit', 'Finish draft'];
    // Office logins don't assign, text or close jobs: they open the work order.
    const dispatchActs = ['reopen', 'move-today', 'send', 'resend-unconfirmed', 'complete', 'cancel', 'delete'];
    if (!state.can.dispatch && dispatchActs.includes(primary[0])) primary = ['edit', 'Open work order'];
    if (!state.can.dispatch && primary[0] === 'edit') primary = ['edit', 'Open work order'];
    const quiet = ['print', 'reopen'].includes(primary[0]) && job.status !== 'cancelled';
    const more = [
      primary[0] !== 'print' && ['print', 'Print work order'],
      ['dup', 'Copy to another day…'],
      ['history', 'History'],
      (job.job_type === 'toilet' || job.job_type === 'bin') && job.status !== 'cancelled' && ['pickup', 'Book pick-up'],
      stale && primary[0] !== 'move-today' && ['move-today', 'Move to today'],
      job.status === 'open' && primary[0] !== 'complete' && ['complete', 'Mark complete'],
      job.status === 'complete' && ['reopen', 'Re-open'],
      job.status !== 'complete' && job.status !== 'cancelled' && (active.some((a) => a.status !== 'pending')
        ? ['cancel', 'Cancel job…', 'danger'] : ['delete', 'Delete', 'danger']),
    ].filter(Boolean).filter((m) => state.can.dispatch || !dispatchActs.includes(m[0]));

    return `<article class="job t-${job.job_type} ${job.status} ${compact ? 'compact' : ''} ${Number(job.draft) ? 'is-draft' : ''}">
      ${Number(job.draft) && job.missing?.length ? `<div class="draft-missing">Still needs: ${esc(job.missing.join(', '))}</div>` : ''}
      <div class="job-head">
        <span class="job-num">#${job.id}</span>
        <span class="job-time ${job.time_slot === 'first' || job.first_thing ? 'first' : ''}">${esc(jobTime(job) || 'Any time')}</span>
        ${Number(job.draft) ? '<span class="tag st-draft" title="Not finished — can\'t be texted yet">DRAFT</span>' : ''}
        ${statusTag}
        <span class="spacer"></span>
        <span class="tag type" title="${esc(t.title)}">${esc(t.name)}</span>
      </div>
      ${stale ? `<div class="stale-date">From ${esc(longDate(job.scheduled_date))}</div>` : ''}
      ${attentionReasons(job).length ? `<div class="attention">${attentionReasons(job).map(esc).join(' · ')}</div>` : ''}
      <div class="job-title">${esc(cargo(job) || job.customer || '(no details)')}</div>
      <div class="job-route">
        ${window.FORMS.isHaulAway(job) ? `
          ${siteAddress(job) ? `<div><b>Load at</b> ${esc(siteAddress(job))}</div>` : ''}
          ${job.from_location ? `<div><b>Dump at</b> ${esc(job.from_location)}</div>` : ''}` : `
          ${t.from && job.from_location ? `<div><b>From</b> ${esc(job.from_location)}</div>` : ''}
          ${siteAddress(job) ? `<div><b>${job.job_type === 'float' ? 'To' : 'At'}</b> ${esc(siteAddress(job))}</div>` : ''}`}
      </div>
      <div class="job-meta">${[job.customer && esc(job.customer + (job.customer_phone ? ' · ' + prettyPhone(job.customer_phone) : '')), !compact && job.contact_name && 'Site: ' + esc(job.contact_name + ' ' + prettyPhone(job.contact_phone))].filter(Boolean).join(' · ')}</div>
      ${job.quoted_price || job.payment_method || job.assignments.some((a) => Object.keys(a.report || {}).length) ? `<div class="tickets-row">
        ${job.quoted_price || job.payment_method ? `<span class="chip collect" title="Office only">${esc([job.quoted_price, job.payment_method].filter(Boolean).join(' · '))}</span>` : ''}
        ${job.assignments.filter((a) => Object.keys(a.report || {}).length).map((a) => `<button class="chip report" data-act="print" data-job="${job.id}" title="Open the work order with the driver's report">Report from ${esc(a.driver_name.split(' ')[0])}</button>`).join('')}
      </div>` : ''}
      ${job.notes && !compact ? `<div class="job-notes">${esc(job.notes)}</div>` : ''}
      ${progress}
      ${job.tickets.length ? `<div class="tickets-row">
        <button class="lbl" data-act="tickets" data-job="${job.id}">${job.tickets.length} ticket${job.tickets.length === 1 ? '' : 's'}</button>
        ${job.tickets.slice(-4).map((tk) => `<img src="/api/tickets/${tk.id}/image" alt="Ticket photo" loading="lazy" data-act="tickets" data-job="${job.id}">`).join('')}
      </div>` : ''}
      <div class="assignments">${rows || '<div class="asg muted">No driver assigned</div>'}</div>
      <div class="job-actions">
        <button class="btn ${quiet ? '' : 'primary'} grow" data-act="${primary[0]}" data-job="${job.id}">${primary[1]}</button>
        ${primary[0] !== 'edit' ? `<button class="btn" data-act="edit" data-job="${job.id}">Edit</button>` : ''}
        <details class="more"><summary class="btn">More</summary><div class="menu">
          ${more.map(([act, label, cls]) => `<button data-act="${act}" data-job="${job.id}" class="${cls || ''}">${label}</button>`).join('')}
        </div></details>
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
      if (act === 'go-requests') return showTab('requests');
      if (act === 'go-texts') return showTab('messages');
      if (act === 'history') { el.closest('details')?.removeAttribute('open'); return openHistory(Number(jobId)); }
      if (act === 'resend-unconfirmed') {
        const job = [...state.board.jobs, ...(state.board.stale_jobs || [])].find((j) => j.id === Number(jobId));
        for (const a of (job?.assignments || []).filter((x) => x.status === 'sent' && !x.needs_resend)) {
          reportSend(await api(`/jobs/${jobId}/send`, { method: 'POST', body: { assignment_id: a.id } }));
        }
      }
      if (act === 'show-stale') { state.showStale = true; return renderBoard(); }
      if (act === 'hide-stale') { state.showStale = false; return renderBoard(); }
      if (act === 'toggle-done') { state.showDone = !state.showDone; return renderBoard(); }
      if (act === 'move-today') {
        const moved = await api(`/jobs/${jobId}/move`, { method: 'POST', body: { date: state.today } });
        toast(`Job #${moved.id} moved to today${moved.assignments.some((a) => a.needs_resend) ? ' — text the drivers the update' : ''}`);
      }
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
    if (state.layout === 'month' && n !== 0) {
      // A month at a time.
      const [y, m] = state.date.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1 + n, 1));
      state.date = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-01`;
    } else state.date = n === 0 ? state.today : addDays(state.date, n);
    loadBoard();
  }));

  // ---------- calendar (month view) ----------
  let calMonth = null;
  let calData = {};
  async function renderCalendar() {
    const ym = state.date.slice(0, 7);
    if (calMonth !== ym) {
      calData = {};
      calMonth = ym;
      $('#jobs').innerHTML = '<div class="empty">Loading…</div>';
    }
    calData = await api('/calendar?month=' + ym).catch(() => calData);
    if (state.layout !== 'month' || calMonth !== ym) return;
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = (first.getUTCDay() + 6) % 7; // weeks start on Monday
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="cal-cell blank"></div>');
    for (let d = 1; d <= days; d++) {
      const date = `${ym}-${pad(d)}`;
      const c = calData[date];
      const past = date < state.today;
      const sub = [];
      if (c && c.done && c.open) sub.push(`${c.done} done`);
      if (c && c.done && !c.open) sub.push('all done ✓');
      if (c && c.drafts) sub.push(`<span class="cal-draft">${c.drafts} draft${c.drafts > 1 ? 's' : ''}</span>`);
      cells.push(`<button type="button" class="cal-cell ${date === state.today ? 'today' : ''} ${past ? 'past' : ''} ${c ? 'has' : ''}" data-cal-day="${date}">
        <span class="cal-d">${d}</span>
        ${c ? `<span class="cal-n"><b>${c.total}</b> job${c.total === 1 ? '' : 's'}</span><span class="cal-sub">${sub.join(' · ')}</span>` : ''}
      </button>`);
    }
    $('#jobs').innerHTML = `<div class="cal-wrap"><div class="cal">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => `<div class="cal-w">${w}</div>`).join('')}
      ${cells.join('')}</div>
      <p class="muted small">Click a day to see its jobs. Book up to a month ahead with <b>+ New job</b>.</p></div>`;
  }
  $('#jobs').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cal-day]');
    if (!c) return;
    state.date = c.dataset.calDay;
    state.layout = store.get('day-layout', 'lanes');
    store.set('layout', state.layout);
    loadBoard();
  });
  // Requests and Texts open from the board; their pages have a way back.
  document.addEventListener('click', (e) => { if (e.target.closest('[data-back-board]')) showTab('board'); });
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
    const job = [...state.board.jobs, ...(state.board.stale_jobs || [])].find((j) => j.id === jobId);
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
    // Aggregates and bins: the price book names first, so the price can be worked out.
    const priced = window.PRICE_UI?.suggestionsFor(type) || [];
    const past = priced.length ? [] : state.suggest?.materialsByType?.[type] || [];
    $('#dl-what').innerHTML = [...new Set([...priced, ...past, ...(priced.length ? [] : t.whatSuggestions || [])])].map((v) => `<option value="${esc(v)}">`).join('');
    const toilets = window.PRICE_UI?.suggestionsFor('toilets') || [];
    if (toilets.length) $('#dl-toilets').innerHTML = toilets.map((v) => `<option value="${esc(v)}">`).join('');
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
      if (f.kind === 'check') {
        return `<label class="check-field"><input type="checkbox" name="${name}" value="Yes" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
      }
      const type = f.kind === 'date' ? 'date' : f.kind === 'number' ? 'number' : 'text';
      const list = f.suggestions === 'toilets' ? 'list="dl-toilets"' : f.suggestions === 'what' ? 'list="dl-what"' : '';
      const cls = f.wide ? 'wide' : f.suggestions === 'toilets' ? 'span2' : '';
      return `<label class="${cls}">${esc(f.label)}<input type="${type}" name="${name}" value="${esc(v)}" ${list} ${type === 'number' ? 'min="0"' : ''}></label>`;
    };
    $('#type-fields-first').innerHTML = t.fields.filter((f) => f.slot === 'first').map(html).join('');
    $('#type-fields-top').innerHTML = t.fields.filter((f) => f.top).map(html).join('');
    $('#type-fields').innerHTML = t.fields.filter((f) => !f.top && !f.slot).map(html).join('');
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
    for (const el of $$('#type-fields [name], #type-fields-top [name], #type-fields-first [name]')) {
      const key = el.name.slice(2);
      if (el.type === 'radio' || el.type === 'checkbox') { if (el.checked) out[key] = el.value; } else if (el.value.trim()) out[key] = el.value.trim();
    }
    return out;
  }

  /** Address labels follow the job: a haul-away loads at the job site and dumps elsewhere. */
  function updateAddressLabels() {
    const type = currentType();
    const job = { job_type: type, details: collectDetails() };
    const lb = window.FORMS.labels(job);
    $('[data-label=from]', form).textContent = lb.from || 'From';
    $('[data-label=to]', form).textContent = lb.to;
    // Open-ended hauling: no load / yard targets.
    const stop = type === 'haul' && job.details.until_stop;
    form.elements.loads_planned.disabled = Boolean(stop);
    form.elements.quantity.disabled = Boolean(stop);
    $$('#type-fields-top input[type=number]').forEach((el) => { el.disabled = Boolean(stop); });
  }
  form.addEventListener('change', (e) => { if (e.target.name === 'd.direction' || e.target.name === 'd.until_stop') updateAddressLabels(); });

  function applyType(type, details) {
    const t = typeInfo(type);
    $('#form-title').textContent = t.title;
    $('[data-label=what]', form).textContent = t.what || '';

    $('[data-label=date]', form).textContent = type === 'septic' ? 'Pump-out date' : 'Delivery date';
    $('[data-label=loads]', form).textContent = t.loadsLabel || 'Number of loads';
    $('[data-label=qty]', form).textContent = t.quantityLabel || 'Quantity';
    const show = { ...t, unit: t.quantity && !t.fixedUnit };
    $$('[data-when]', form).forEach((el) => el.classList.toggle('hidden', !show[el.dataset.when]));
    // Aggregates: type, loads and yards on one line, like the paper form.
    $('[data-when=what]', form).classList.toggle('wide', !t.fixedUnit);
    // Keep what was typed in the type-specific fields when switching back and forth.
    renderTypeFields(type, details || collectDetails());
    updateAddressLabels();
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
        if (a.status === 'done' || a.status === 'cancelled') continue; // finished work doesn't make a driver busy
        const label = `#${j.id}${jobTime(j) ? ' ' + jobTime(j) : ''}`;
        busyByDriver.set(a.driver_id, busyByDriver.has(a.driver_id) ? busyByDriver.get(a.driver_id) + ', ' + label : label);
      }
    }
  }

  async function openJobForm(job = null) {
    form.reset();
    form.elements.customer_id.value = '';
    $('#job-form-error').textContent = '';
    if (!state.drivers.length || !state.trucks.length) await loadBoard();
    fillSuggestions().catch(() => {});
    const data = job || { job_type: 'haul', scheduled_date: state.date, assignments: [] };
    $('#job-form-title').textContent = job?.id ? `Edit job #${job.id}` : job?.request_id ? 'Schedule website request' : 'New job';
    $('#from-request').classList.toggle('hidden', !data.request_id);
    $('#from-request').textContent = data.request_id ? '🌐 Filled in from the website order. Check it, pick the drivers, then save.' : '';
    for (const [k, v] of Object.entries(data)) {
      const input = form.elements[k];
      if (!input || k === 'job_type' || k === 'details' || k === 'time_slot' || !('value' in input)) continue;
      input.value = v ?? '';
    }
    const slot = data.time_slot || (data.first_thing ? 'first' : data.scheduled_time ? (data.scheduled_time < '12:00' ? 'am' : 'pm') : '');
    $$('input[name=time_slot]', form).forEach((r) => { r.checked = r.value === slot; });
    markMissing([]);
    $('#job-form-error').innerHTML = '';
    if (data.contact_phone) form.elements.contact_phone.value = prettyPhone(data.contact_phone);
    if (data.customer_phone) form.elements.customer_phone.value = prettyPhone(data.customer_phone);
    $$('input[name=job_type]', form).forEach((r) => { r.checked = r.value === data.job_type; });
    formAssignments = new Map(data.assignments.map((a) => [a.driver_id, a.truck_id]));
    showCustomerNote(data.customer_id ? await api('/customers/' + data.customer_id).then((r) => r.customer).catch(() => null) : null);
    await computeBusy(data.scheduled_date, data.id);
    applyType(data.job_type, data.details || {});
    window.PRICE_UI?.openForm(data);
    dialog.showModal();
  }

  form.elements.scheduled_date.addEventListener('change', async (e) => {
    await computeBusy(e.target.value, form.elements.id.value);
    renderAssignList(currentType());
  });

  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => dialog.close()));

  // Required fields (Setup → Required fields): checked here first, and again by the server.
  let requiredCache = null;
  async function requiredFor(type) {
    if (!requiredCache) requiredCache = (await api('/settings')).required_fields || {};
    return requiredCache[type] || [];
  }
  function markMissing(keys) {
    $$('.missing', form).forEach((el) => el.classList.remove('missing'));
    for (const k of keys) {
      const el = k.startsWith('d.') ? form.querySelector(`[name="${k}"]`) : k === 'time_slot' ? $('[data-req=time_slot]', form) : form.elements[k];
      const box = el?.closest?.('label, .choice-row, .field-col, .cust-pick') || el;
      box?.classList?.add('missing');
    }
  }
  function showMissing(missing) {
    markMissing(missing.map((m) => m.key || m));
    $('#job-form-error').innerHTML = `Still needs: <b>${esc(missing.map((m) => m.label || m).join(', '))}</b>.
      <button type="button" class="btn tiny" id="save-draft-instead">Save as a draft instead</button>`;
    $('#save-draft-instead').addEventListener('click', () => form.requestSubmit(form.querySelector('button[value=draft]')));
    form.querySelector('.missing')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sendNow = false; // saving never texts drivers: text them from the board when ready
    const asDraft = e.submitter?.value === 'draft';
    const fd = new FormData(form);
    const body = Object.fromEntries([...fd.entries()].filter(([k]) => !k.startsWith('d.') && !k.startsWith('po.') && !k.startsWith('ln.')));
    body.details = collectDetails();
    Object.assign(body, window.PRICE_UI?.collect() || {});
    body.time_slot = $('input[name=time_slot]:checked', form)?.value || '';
    body.assignments = [...formAssignments].map(([driver_id, truck_id]) => ({ driver_id, truck_id }));
    body.send_now = sendNow;
    body.draft = asDraft;
    if (!asDraft) {
      const missing = window.FORMS.missingRequired({ ...body, has_pin: Boolean(body.pin_lat) || body.lat != null }, await requiredFor(body.job_type));
      if (missing.length) return showMissing(missing);
    }
    try {
      const id = body.id;
      const out = await api(id ? '/jobs/' + id : '/jobs', { method: id ? 'PUT' : 'POST', body });
      dialog.close();
      if (asDraft) toast(`Job #${out.job.id} saved as a draft — finish it before texting drivers`);
      else toast(`Job #${out.job.id} saved${out.job.assignments.length && state.can.dispatch ? ' — text the drivers from the board when ready' : ''}`);
      if (out.job.scheduled_date !== state.date) state.date = out.job.scheduled_date;
      if (body.request_id) toast(`Website request scheduled as job #${out.job.id}`);
      if (state.tab === 'requests') loadRequests();
      loadBoard();
    } catch (err) {
      if (err.missing) return showMissing(window.FORMS.requirable(body.job_type).filter((f) => err.missing.includes(f.key)));
      $('#job-form-error').textContent = err.message;
    }
  });

  // ---------- drivers & trucks ----------
  const KIND = window.FORMS.TRUCK_KINDS;
  $('#truck-kind').innerHTML = Object.entries(KIND).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

  // ---------- texting setup ----------
  function renderSmsStatus(s) {
    const rows = [];
    if (s.account) rows.push(`<div>Account: <b>${esc(s.account.name)}</b> (${esc(s.account.type)}, ${esc(s.account.status)})</div>`);
    if (s.number) rows.push(`<div>Dispatch number: <b>${esc(prettyPhone(s.number.phone))}</b> · SMS ${s.number.sms ? '✔' : '✖'} · MMS (photos) ${s.number.mms ? '✔' : '✖'}</div>`);
    rows.push(`<div>Incoming texts should go to: <code>${esc(s.webhook)}</code>${s.number ? (s.number.smsUrl === s.webhook ? ' ✔' : ` — currently <code>${esc(s.number.smsUrl || 'not set')}</code>`) : ''}</div>`);
    for (const p of s.problems) rows.push(`<div class="error">✖ ${esc(p)}</div>`);
    for (const w of s.warnings) rows.push(`<div class="warn-line">! ${esc(w)}</div>`);
    if (s.configured && !s.problems.length && !s.warnings.length) rows.push('<div class="ok-line">✔ Texting is ready.</div>');
    if (!s.configured) rows.push('<div class="muted small">Until this is set up the app is in TEST MODE: texts are printed in the server log, not sent.</div>');
    $('#sms-status').innerHTML = rows.join('');
    $('#sms-connect').classList.toggle('hidden', !s.number || (s.number.smsUrl === s.webhook && s.number.smsMethod === 'POST'));
  }
  async function loadSmsStatus() {
    $('#sms-status').textContent = 'Checking…';
    try { renderSmsStatus(await api('/sms/status')); } catch (err) { $('#sms-status').textContent = err.message; }
  }
  $('#sms-recheck').addEventListener('click', loadSmsStatus);
  $('#sms-connect').addEventListener('click', async () => {
    try { renderSmsStatus(await api('/sms/connect', { method: 'POST', body: {} })); toast('Number connected'); } catch (err) { toast(err.message); }
  });
  $('#sms-test').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await api('/sms/test', { method: 'POST', body: { phone: e.target.elements.phone.value } });
      toast(out.simulated ? 'Test mode: the text was printed in the server log, not sent' : 'Test text sent — reply OK from that phone and check the Texts tab');
    } catch (err) { toast(err.message); }
  });

  async function loadPeople() {
    loadSmsStatus();
    const [drivers, trucks, settings] = await Promise.all([api('/drivers?all=1'), api('/trucks?all=1'), api('/settings')]);
    const sf = $('#settings-form');
    sf.elements.lineup_on.checked = Boolean(settings.lineup_time);
    sf.elements.lineup_time.value = settings.lineup_time || '17:00';
    $('#septic-form').elements.septic_reminder_years.value = settings.septic_reminder_years || '3';
    loadBackups().catch(() => {});
    reqState.data = settings.required_fields || {};
    renderRequired();
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

  // ---------- website requests ----------
  const SERVICE_ICON = { septic: '💧', aggregate: '🪨', bin: '🗑️', toilet: '🚻', quote: '📝', other: '🌐' };

  async function loadRequests() {
    const status = $('#request-filter input:checked').value;
    const list = await api('/requests?status=' + status);
    $('#request-list').innerHTML = list.map((r) => `
      <article class="request ${r.status}">
        <div class="req-head">
          <span class="req-icon">${SERVICE_ICON[r.service] || '🌐'}</span>
          <b>${esc(r.service_name)}</b>
          <span class="muted small">${esc(fmtStamp(r.created_at))}</span>
          ${r.status !== 'new' ? `<span class="chip ${r.status === 'scheduled' ? 'acknowledged' : 'cancelled'}">${esc(r.status)}${r.job_id ? ` · job #${r.job_id}${r.job_date ? ' · ' + esc(longDate(r.job_date)) : ''}` : ''}</span>` : '<span class="chip sent">New</span>'}
          <div class="spacer"></div>
          ${r.estimate_total ? `<span class="req-est">Est. ${esc(r.estimate_total)}</span>` : ''}
        </div>
        <div class="req-body">
          <div><b>${esc(r.customer_name || '(no name)')}</b> ${r.phone ? `· <a href="tel:${esc(r.phone)}">${esc(prettyPhone(r.phone))}</a>` : ''} ${r.email ? `· <a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : ''}</div>
          <div>${esc([r.address, r.municipality].filter(Boolean).join(', '))}</div>
          ${r.summary ? `<div class="req-summary">${esc(r.summary)}</div>` : ''}
          ${r.requested_date ? `<div>Requested date: <b>${esc(longDate(r.requested_date))}</b></div>` : ''}
          ${r.notes ? `<div class="job-notes">${esc(r.notes)}</div>` : ''}
          <details><summary>All details</summary>
            <ul>${r.detail_lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
            ${r.estimate_lines.length ? `<table class="table est">${r.estimate_lines.map((l) => `<tr><td>${esc(l.label || '')}</td><td>${esc(l.amount ?? '')}</td></tr>`).join('')}</table>` : ''}
          </details>
        </div>
        <div class="job-actions">
          ${r.status === 'new' ? `
            <button class="btn primary" data-req="schedule" data-id="${r.id}">Schedule…</button>
            <button class="btn" data-req="duplicate" data-id="${r.id}">Duplicate</button>
            <button class="btn danger" data-req="declined" data-id="${r.id}">Decline</button>` : `
            ${r.job_id ? `<button class="btn" data-req="open-job" data-date="${esc(r.job_date || '')}">Show on board</button>` : ''}
            ${r.status !== 'scheduled' ? `<button class="btn" data-req="new" data-id="${r.id}">Move back to New</button>` : ''}`}
        </div>
      </article>`).join('') || `<div class="empty">${status === 'open' ? 'No new website requests.' : 'Nothing here yet.'}</div>`;
  }

  $('#request-filter').addEventListener('change', loadRequests);
  $('#request-list').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-req]');
    if (!el) return;
    const act = el.dataset.req;
    try {
      if (act === 'schedule') {
        const prefill = await api(`/requests/${el.dataset.id}/prefill`);
        state.date = prefill.scheduled_date || state.date;
        await openJobForm(prefill);
      } else if (act === 'open-job') {
        if (el.dataset.date) state.date = el.dataset.date;
        showTab('board');
      } else {
        if (act === 'declined' && !confirm('Decline this request? (It stays in the list under All.)')) return;
        await api(`/requests/${el.dataset.id}/status`, { method: 'POST', body: { status: act } });
        loadRequests();
        loadBoard();
      }
    } catch (err) { toast(err.message); }
  });

  // ---------- records (search & export) ----------
  const rf = $('#records-form');
  rf.elements.type.innerHTML = '<option value="">All types</option>' +
    TYPE_KEYS.map((k) => `<option value="${k}">${esc(TYPES[k].title)}</option>`).join('');

  function recordQuery() {
    return new URLSearchParams(Object.fromEntries(new FormData(rf).entries())).toString();
  }

  function setRange(which) {
    const t = state.today || new Date().toISOString().slice(0, 10);
    const y = Number(t.slice(0, 4));
    const m = Number(t.slice(5, 7));
    const last = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
    const ranges = {
      year: [`${y}-01-01`, t],
      lastyear: [`${y - 1}-01-01`, `${y - 1}-12-31`],
      month: [`${t.slice(0, 7)}-01`, t],
      lastmonth: m === 1 ? [`${y - 1}-12-01`, `${y - 1}-12-31`] : [`${y}-${pad(m - 1)}-01`, last(y, m - 1)],
    };
    [rf.elements.from.value, rf.elements.to.value] = ranges[which];
  }

  async function loadRecords() {
    if (!rf.elements.from.value) setRange('year');
    try {
      const out = await api('/records?' + recordQuery());
      const loads = out.jobs.reduce((n, j) => n + j.assignments.reduce((m, a) => m + (a.loads_done || 0), 0), 0);
      $('#records-summary').textContent = `${out.jobs.length}${out.truncated ? '+ (showing the first 500 — the spreadsheet and printout include all)' : ''} work order${out.jobs.length === 1 ? '' : 's'} · ${longDate(out.from)} to ${longDate(out.to)}${loads ? ` · ${loads} loads` : ''}`;
      $('#records-rows').innerHTML = out.jobs.map((j) => `
        <tr>
          <td><b>#${j.id}</b>${j.paper_wo ? `<div class="muted small">W.O. ${esc(j.paper_wo)}</div>` : ''}</td>
          <td>${esc(j.scheduled_date)}</td>
          <td>${esc(typeInfo(j.job_type).name)}</td>
          <td>${esc(j.customer)}${j.customer_phone ? `<div class="muted small">${esc(prettyPhone(j.customer_phone))}</div>` : ''}</td>
          <td>${esc(siteAddress(j))}</td>
          <td>${esc(cargo(j))}${j.tickets.length ? ` <span class="muted small">🧾 ${j.tickets.length}</span>` : ''}</td>
          <td>${j.assignments.reduce((n, a) => n + (a.loads_done || 0), 0) || ''}</td>
          <td>${esc(j.quoted_price)}</td>
          <td>${esc(j.amount_billed)}${j.invoice_number ? `<div class="muted small">${esc(j.invoice_number)}</div>` : ''}</td>
          <td><span class="chip ${j.status === 'complete' ? 'done' : j.status === 'cancelled' ? 'cancelled' : 'sent'}">${esc(j.status)}</span></td>
          <td><button class="btn tiny" data-act="print" data-job="${j.id}">Print</button></td>
        </tr>`).join('') || '<tr><td colspan="11" class="muted">No work orders match.</td></tr>';
    } catch (err) { toast(err.message); }
  }

  rf.addEventListener('submit', (e) => { e.preventDefault(); loadRecords(); });
  $$('[data-range]').forEach((b) => b.addEventListener('click', () => { setRange(b.dataset.range); loadRecords(); }));
  $('#records-csv').addEventListener('click', () => { location.href = '/api/records.csv?' + recordQuery(); });
  $('#records-print').addEventListener('click', () => window.open('/print/records?' + recordQuery(), '_blank'));

  // ---------- job history ----------
  async function openHistory(jobId) {
    const rows = await api(`/jobs/${jobId}/history`);
    $('#history-title').textContent = `Job #${jobId} — history`;
    $('#history-list').innerHTML = rows.length ? rows.map((r) => `
      <li><span class="h-when">${esc(fmtStamp(r.at))}</span>
        <span class="h-who">${esc(r.actor)}</span>
        <span class="h-what"><b>${esc(r.action)}</b>${r.details ? ` — ${esc(r.details)}` : ''}</span></li>`).join('')
      : '<li class="muted">No history recorded yet (jobs created before this feature start here).</li>';
    $('#history-dialog').showModal();
  }
  $('[data-close-history]').addEventListener('click', () => $('#history-dialog').close());

  // ---------- customer picker in the job form ----------
  const custInput = form.elements.customer;
  let custTimer;
  let custResults = [];
  function showCustomerNote(c) {
    const box = $('#cust-note');
    if (!c) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = `<b>Existing customer</b>${c.notes ? ` · Notes: ${esc(c.notes)}
      <button type="button" class="link" id="cust-note-add">Add to instructions</button>` : ''}
      <button type="button" class="link" id="cust-unlink">Not this customer</button>`;
    $('#cust-note-add')?.addEventListener('click', () => {
      const n = form.elements.notes;
      if (!n.value.includes(c.notes)) n.value = [n.value, c.notes].filter(Boolean).join(' ');
    });
    $('#cust-unlink').addEventListener('click', () => { form.elements.customer_id.value = ''; showCustomerNote(null); });
  }
  function closeSuggest() { $('#cust-suggest').classList.add('hidden'); custInput.setAttribute('aria-expanded', 'false'); }
  custInput.addEventListener('input', () => {
    form.elements.customer_id.value = '';
    showCustomerNote(null);
    clearTimeout(custTimer);
    const q = custInput.value.trim();
    if (q.length < 2) return closeSuggest();
    custTimer = setTimeout(async () => {
      custResults = await api('/customers/search?q=' + encodeURIComponent(q)).catch(() => []);
      const box = $('#cust-suggest');
      if (!custResults.length) return closeSuggest();
      box.innerHTML = custResults.map((c, i) => `<button type="button" role="option" data-pick="${i}">
        <b>${esc(c.name || '(no name)')}</b> <span class="muted">${esc(prettyPhone(c.phone))}</span>
        <span class="muted small">${esc([c.site_address, c.municipality].filter(Boolean).join(', '))}${c.last_job_date ? ` · last job ${esc(c.last_job_date)}` : ''}</span></button>`).join('');
      box.classList.remove('hidden');
      custInput.setAttribute('aria-expanded', 'true');
    }, 200);
  });
  custInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSuggest(); });
  $('#cust-suggest').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const c = custResults[Number(b.dataset.pick)];
    const f = form.elements;
    f.customer.value = c.name;
    f.customer_id.value = c.id;
    if (c.phone) f.customer_phone.value = prettyPhone(c.phone);
    if (c.email && !f.customer_email.value) f.customer_email.value = c.email;
    if (c.billing_address && !f.billing_address.value) f.billing_address.value = c.billing_address;
    if (c.site_address && !f.to_location.value) f.to_location.value = c.site_address;
    if (c.municipality && !f.municipality.value) f.municipality.value = c.municipality;
    closeSuggest();
    showCustomerNote(c);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.cust-pick')) closeSuggest(); });

  // ---------- customers tab ----------
  let custView = 'all';
  async function loadCustomers() {
    const due = await api('/customers/due');
    const dc = $('#due-count');
    dc.textContent = due.length || '';
    dc.classList.toggle('hidden', !due.length);
    $('#due-count-inline').textContent = due.length ? `(${due.length})` : '';
    if (custView === 'due') {
      $('#cust-head').innerHTML = '<tr><th>Customer</th><th>Property</th><th>Last pump-out</th><th>Tank</th><th></th></tr>';
      $('#cust-rows').innerHTML = due.map((c) => `<tr>
          <td><b>${esc(c.name)}</b><div class="muted small">${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(prettyPhone(c.phone))}</a>` : ''}${c.reminder_note ? ` · ${esc(c.reminder_note)}` : ''}</div></td>
          <td>${esc([c.address, c.job_municipality].filter(Boolean).join(', '))}</td>
          <td>${esc(c.last_pumpout)}</td>
          <td>${esc([c.tank_type, c.tank_size].filter(Boolean).join(' · '))}</td>
          <td class="row-actions"><button class="btn tiny primary" data-cust-act="book" data-id="${c.id}">Book pump-out</button>
            <button class="btn tiny" data-cust-act="contacted" data-id="${c.id}">Mark contacted</button></td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">Nobody is due for a pump-out right now.</td></tr>';
      return;
    }
    const list = await api('/customers?q=' + encodeURIComponent($('#cust-search').value.trim()));
    $('#cust-head').innerHTML = '<tr><th>Customer</th><th>Phone</th><th>Site</th><th>Last job</th></tr>';
    $('#cust-rows').innerHTML = list.map((c) => `<tr class="clickable" data-cust-act="open" data-id="${c.id}" tabindex="0">
        <td><b>${esc(c.name || '(no name)')}</b>${c.notes ? `<div class="muted small">${esc(c.notes)}</div>` : ''}</td>
        <td>${esc(prettyPhone(c.phone))}</td>
        <td>${esc([c.site_address, c.municipality].filter(Boolean).join(', '))}</td>
        <td>${esc(c.last_job_date || '')}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">No customers yet — they appear as you create jobs.</td></tr>';
  }

  async function openCustomer(id) {
    const box = $('#cust-detail');
    const out = id ? await api('/customers/' + id) : { customer: {}, jobs: [] };
    const c = out.customer;
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="dialog-head"><h2>${id ? esc(c.name || 'Customer') : 'New customer'}</h2>
        <button type="button" class="link" data-cust-act="close" aria-label="Close">✕</button></div>
      <form id="cust-form" class="cust-form">
        <input type="hidden" name="id" value="${esc(c.id || '')}">
        <label>Name <input name="name" value="${esc(c.name || '')}"></label>
        <label>Phone <input name="phone" type="tel" value="${esc(prettyPhone(c.phone || ''))}"></label>
        <label>Email <input name="email" type="email" value="${esc(c.email || '')}"></label>
        <label>Billing / mailing address <input name="billing_address" value="${esc(c.billing_address || '')}"></label>
        <label>Usual site address <input name="site_address" value="${esc(c.site_address || '')}"></label>
        <label>Municipality <input name="municipality" value="${esc(c.municipality || '')}"></label>
        <label>Notes (gate codes, dog in yard, where the tank is…) <textarea name="notes" rows="3">${esc(c.notes || '')}</textarea></label>
        <div class="row-actions"><button class="btn primary" type="submit">Save customer</button>
          ${id ? `<button class="btn" type="button" data-cust-act="newjob" data-id="${c.id}">+ New job for them</button>
          <button class="btn" type="button" data-cust-act="book" data-id="${c.id}">Book pump-out</button>` : ''}</div>
      </form>
      ${id ? `<h3>Jobs (${out.jobs.length})</h3>
      <ul class="cust-jobs">${out.jobs.map((j) => `<li>
        <div><b>#${j.id}</b> · ${esc(j.scheduled_date)} · ${esc(typeInfo(j.job_type).name)}
          <span class="chip ${j.status === 'complete' ? 'done' : j.status === 'cancelled' ? 'cancelled' : 'sent'}">${esc(j.status)}</span></div>
        <div class="muted small">${esc(cargo(j))}${j.amount_billed ? ` · billed ${esc(j.amount_billed)}` : j.quoted_price ? ` · quoted ${esc(j.quoted_price)}` : ''}${j.invoice_number ? ` · ${esc(j.invoice_number)}` : ''}</div>
        <button class="btn tiny" data-act="print" data-job="${j.id}">Print</button></li>`).join('') || '<li class="muted">No jobs yet.</li>'}</ul>` : ''}`;
    $('#cust-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const saved = await api('/customers', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
        toast('Customer saved');
        loadCustomers();
        openCustomer(saved.id);
      } catch (err) { toast(err.message); }
    });
  }

  $('#tab-customers').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-cust-act]');
    if (!el) return;
    const id = el.dataset.id;
    try {
      if (el.dataset.custAct === 'open') openCustomer(id);
      if (el.dataset.custAct === 'close') $('#cust-detail').classList.add('hidden');
      if (el.dataset.custAct === 'book') {
        const prefill = await api(`/customers/${id}/septic-prefill`);
        state.date = prefill.scheduled_date || state.date;
        await openJobForm(prefill);
      }
      if (el.dataset.custAct === 'newjob') {
        const { customer: c } = await api('/customers/' + id);
        await openJobForm({ job_type: 'haul', scheduled_date: state.date, customer_id: c.id, customer: c.name, customer_phone: c.phone,
          customer_email: c.email, billing_address: c.billing_address, to_location: c.site_address, municipality: c.municipality, assignments: [] });
      }
      if (el.dataset.custAct === 'contacted') {
        const note = prompt('Note (optional) — e.g. "Left a message", "Booking in spring"', '');
        if (note === null) return;
        await api(`/customers/${id}/contacted`, { method: 'POST', body: { note } });
        toast('Marked contacted — hidden from the list for 90 days');
        loadCustomers();
      }
    } catch (err) { toast(err.message); }
  });
  $('#tab-customers').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('tr[data-cust-act=open]')) openCustomer(e.target.dataset.id);
  });
  $('#cust-filter').addEventListener('change', () => { custView = $('#cust-filter input:checked').value; loadCustomers(); });
  let custSearchTimer;
  $('#cust-search').addEventListener('input', () => {
    clearTimeout(custSearchTimer);
    custSearchTimer = setTimeout(() => {
      if (custView !== 'all') { custView = 'all'; $('#cust-filter input[value=all]').checked = true; }
      loadCustomers();
    }, 250);
  });
  $('#cust-new').addEventListener('click', () => openCustomer(null));

  // ---------- required fields (admin) ----------
  const reqState = { type: 'haul', data: {} };
  $('#req-type').innerHTML = TYPE_KEYS.map((k) =>
    `<label><input type="radio" name="req-type" value="${k}" ${k === 'haul' ? 'checked' : ''}><span>${TYPES[k].icon} ${esc(TYPES[k].name)}</span></label>`).join('');
  function renderRequired() {
    const on = new Set(reqState.data[reqState.type] || []);
    $('#req-fields').innerHTML = window.FORMS.requirable(reqState.type).map((f) =>
      `<label><input type="checkbox" value="${esc(f.key)}" ${on.has(f.key) ? 'checked' : ''}> ${esc(f.label)}</label>`).join('');
  }
  $('#req-type').addEventListener('change', (e) => { reqState.type = e.target.value; renderRequired(); });
  $('#req-fields').addEventListener('change', () => {
    reqState.data[reqState.type] = $$('#req-fields input:checked').map((i) => i.value);
  });
  $('#req-save').addEventListener('click', async () => {
    try {
      const out = await api('/settings', { method: 'POST', body: { required_fields: reqState.data } });
      reqState.data = out.required_fields;
      requiredCache = null;
      toast('Required fields saved');
    } catch (err) { toast(err.message); }
  });

  async function loadBackups() {
    const st = await api('/backups');
    const last = st.runs.find((r) => r.ok);
    $('#backup-where').innerHTML = st.target === 'off'
      ? 'Automatic backups are turned off. You can still download a copy.'
      : `Every night after 2 AM the whole database is saved to <b>${esc(st.label)}</b>; copies are kept ${st.keep_days} days and ticket photos are kept for good.
         ${last ? `Last good backup: <b>${esc(fmtStamp(last.at))}</b>` : '<b>No backup has run yet.</b>'}
         ${st.target === 'replit' && st.runs[0] && !st.runs[0].ok ? '<br><b class="bad">The last backup failed.</b> On Replit, open <b>App Storage</b>, copy your bucket\'s ID, add it as the Secret <b>BACKUP_BUCKET_ID</b>, republish, then press Back up now.' : ''}`;
    $('#backup-run').classList.toggle('hidden', st.target === 'off');
    $('#backup-rows').innerHTML = st.runs.map((r) => `<tr>
        <td>${esc(fmtStamp(r.at))}</td><td>${esc(r.name.replace('db/', '').replace('.json.gz', ''))}</td>
        <td>${r.ok ? `${Math.max(1, Math.round(r.bytes / 1024))} KB` : ''}</td><td>${r.ok ? r.photos : ''}</td>
        <td>${r.ok ? '<span class="chip done">saved</span>' : `<span class="chip cancelled" title="${esc(r.error)}">failed</span> <span class="muted small">${esc(r.error)}</span>`}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No backups yet.</td></tr>';
  }
  $('#backup-run').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const out = await api('/backups/run', { method: 'POST' });
      toast(out.ok ? `Backed up (${out.photos} new photo${out.photos === 1 ? '' : 's'})` : `Backup failed: ${out.error}`);
      await loadBackups();
    } catch (err) { toast(err.message); } finally { e.target.disabled = false; }
  });

  $('#septic-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/settings', { method: 'POST', body: { septic_reminder_years: e.target.elements.septic_reminder_years.value } });
      toast('Saved');
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

  // Shared with pricing-ui.js (Prices, Questions, Logins and the job form's price panel).
  window.APP = { api, esc, toast, $, $$, state, form, openJobForm, loadGoogleMaps, fillWhatList, currentType, collectDetails, fmtStamp, prettyPhone, showTab };

  (async () => {
    const me = await api('/me');
    state.today = state.date = me.today;
    state.smsEnabled = me.smsEnabled;
    state.user = me.user;
    // What this login can do: office / dispatcher / admin (+ owner manages logins).
    state.can = me.can || { dispatch: true, admin: true };
    document.body.classList.toggle('can-dispatch', Boolean(state.can.dispatch));
    document.body.classList.toggle('can-admin', Boolean(state.can.admin));
    document.body.classList.toggle('is-owner', Boolean(state.can.owner));
    $('#user-name').title = state.can.role_name || '';
    if (!state.can.dispatch) $('#job-form button[value=save]').textContent = 'Save work order';
    state.maps = me.maps || {};
    $('#user-name').textContent = me.user.name;
    $('#user-initial').textContent = (me.user.name || '?').trim()[0].toUpperCase();
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
