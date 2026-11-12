/* Setup, laid out like a settings app: a grouped menu on the left (a dropdown on phones), an Overview of how things
   are set up, and one section at a time. The existing panels and their save logic are reused; add/edit forms open
   in a side panel. Uses app.js (window.APP). */
(function () {
  const A = window.APP;
  const { api, esc, $, $$ } = A;
  const tab = $('#tab-people');
  if (!tab) return;

  // ---------- find the existing panels ----------
  const panelByTitle = (title) => $$('.panel', tab).find((p) => $('h2', p)?.textContent.trim() === title);
  const P = {
    logins: $('#users-panel'), texting: $('#sms-panel'), daytext: panelByTitle("Drivers' jobs text"), fields: $('#fields-panel'),
    required: $('#required-panel'), quickbooks: $('#qbo-panel'), septic: panelByTitle('Septic reminders'), sitesSetup: $('#sites-panel'),
    reviews: $('#review-panel'), backups: $('#backup-panel'), drivers: panelByTitle('Drivers'), labourers: panelByTitle('Labourers'), trucks: panelByTitle('Trucks'),
  };

  const SECTIONS = [
    { group: 'Start', items: [{ id: 'overview', name: 'Overview', text: 'How the app is set up today. Click a card to change it.' }] },
    { group: 'People & fleet', items: [
      { id: 'drivers', name: 'Drivers', text: 'People who drive our trucks. They get job texts on these cell numbers.', panels: ['drivers'], add: { form: '#driver-form', label: '+ Add driver' }, guide: '#setup' },
      { id: 'labourers', name: 'Labourers', text: 'People who go to jobs without a truck. They get the same job texts: reply OK and DONE, and a job page link.', panels: ['labourers'], add: { form: '#labourer-form', label: '+ Add labourer' } },
      { id: 'trucks', name: 'Trucks', text: "Our fleet. A driver's usual truck is filled in for them, and the truck kind puts the right drivers first on a work order.", panels: ['trucks'], add: { form: '#truck-form', label: '+ Add truck' } },
      { id: 'equipment', name: 'Equipment', text: 'Machines for our own sites. Site heads ask for them by kind ("mini ex", "loader"). The app keeps track of where each one is.', mount: 'equipment' },
      { id: 'sites', name: 'Sites & site heads', text: 'Our own job sites and the people running them. Active sites get the afternoon text.', mount: 'sites' },
    ] },
    { group: 'Texts', items: [
      { id: 'texting', name: 'Texting number', text: 'The office number drivers, site heads and customers get texts from, and whether replies come back in.', panels: ['texting'] },
      { id: 'daytext', name: "Drivers' day text", text: 'One text per driver and labourer with their jobs. Drivers who already have their day are only texted again if something changed.', panels: ['daytext'] },
      { id: 'sitetext', name: "Site heads' text", text: "Asks each active site's head what they need for the next work day. Friday asks about Monday.", mount: 'sitetext' },
      { id: 'reviews', name: 'Review requests', text: 'Text customers asking for a Google review an hour after their job (9 AM to 8 PM, at most once a year).', panels: ['reviews'] },
    ] },
    { group: 'Work orders', items: [
      { id: 'fields', name: 'Fields & required', text: 'Everything on each type of work order: rename, reorder, hide or add fields, and choose which must be filled in.', panels: ['fields', 'required'] },
      { id: 'septic', name: 'Septic reminders', text: 'When customers show as due for a pump-out on the Customers tab. Nothing is sent to customers automatically.', panels: ['septic'] },
    ] },
    { group: 'Account', items: [
      { id: 'logins', name: 'Logins', owner: true, text: 'Who can log in and what they can do. Only you see this section.', panels: ['logins'] },
      { id: 'quickbooks', name: 'QuickBooks', text: 'Sends priced work orders to QuickBooks Online as Estimates.', panels: ['quickbooks'] },
      { id: 'backups', name: 'Backups & restore', text: 'A copy every hour (kept 48 hours) and every night (kept 30 days). Restore is for the owner only.', panels: ['backups'] },
    ] },
  ];
  const KEYWORDS = { daytext: 'morning evening lineup tomorrow time', sitetext: 'afternoon ask 2:30', backups: 'restore backup safety download', reviews: 'google review',
    texting: 'twilio sunwire number sms phone', fields: 'required work order boxes', logins: 'users password owner office dispatcher admin', septic: 'pump-out due reminder',
    equipment: 'machines excavator loader float unit', sites: 'site heads foreman' };
  const items = () => SECTIONS.flatMap((g) => g.items).filter((it) => !it.owner || A.state.can?.owner);
  const counts = {};
  const dots = {};

  // ---------- build the layout ----------
  const help = $('.help-strip[data-help="people"]', tab);
  const shell = document.createElement('div');
  shell.className = 'setup-shell';
  shell.innerHTML = `<aside class="setup-side">
      <h1>Setup</h1>
      <input class="setup-search" type="search" placeholder="Search settings (e.g. morning, backup)" aria-label="Search settings">
      <select class="setup-select" aria-label="Setup section"></select>
      <nav class="setup-nav" aria-label="Setup sections"></nav>
    </aside>
    <div class="setup-main"></div>`;
  tab.prepend(shell);
  help?.remove(); // each section has its own line instead
  const main = $('.setup-main', shell);
  const holder = document.createElement('div'); // where the panels wait while another section is shown
  holder.hidden = true;
  tab.append(holder);
  for (const p of Object.values(P)) if (p) holder.append(p);
  $('.three-col', tab)?.remove();

  // Sections for the Our sites settings, filled by sites.js.
  const mounts = {};
  for (const k of ['equipment', 'sites', 'sitetext']) { mounts[k] = document.createElement('div'); mounts[k].className = 'setup-mount'; }

  const sectionEls = {};
  for (const it of SECTIONS.flatMap((g) => g.items)) {
    const el = document.createElement('section');
    el.className = 'setup-section';
    el.dataset.section = it.id;
    el.hidden = true;
    el.innerHTML = `<div class="setup-head"><div><h2>${esc(it.name)}</h2><p>${esc(it.text)}</p></div>
      ${it.add ? `<button class="btn primary" type="button" data-setup-add="${esc(it.add.form)}">${esc(it.add.label)}</button>` : ''}</div>`;
    for (const k of it.panels || []) if (P[k]) el.append(P[k]);
    if (it.mount) el.append(mounts[it.mount]);
    if (it.id === 'overview') { const c = document.createElement('div'); c.className = 'setup-cards'; el.append(c); }
    main.append(el);
    sectionEls[it.id] = el;
  }
  // The add/edit forms for drivers, labourers and trucks live in the side panel; the list stays on the page.
  const listForms = { '#driver-form': 'driver', '#labourer-form': 'labourer', '#truck-form': 'truck' };
  for (const sel of Object.keys(listForms)) { const f = $(sel); if (f) { f.classList.add('drawer-form'); f.hidden = true; } }

  // The old one-line forms only had placeholders: give each box a label above it in the side panel.
  const LABELS = { name: 'Name', phone: 'Cell number', default_truck_id: 'Usual truck', unit: 'Unit #', kind: 'Kind', description: 'Description' };
  function labelForm(form) {
    if (form.dataset.labelled) return;
    for (const el of [...form.elements]) {
      if (!LABELS[el.name] || el.type === 'hidden') continue;
      const wrap = document.createElement('div');
      wrap.className = 'dfield';
      const id = `${form.getAttribute('id')}-${el.name}`;
      el.id = el.id || id;
      wrap.innerHTML = `<label for="${esc(el.id)}">${esc(LABELS[el.name])}</label>`;
      el.replaceWith(wrap);
      wrap.append(el);
    }
    form.dataset.labelled = '1';
  }

  // ---------- the side panel ----------
  const layer = document.createElement('div');
  layer.className = 'drawer-layer';
  layer.hidden = true;
  layer.innerHTML = '<div class="drawer-scrim" data-drawer-close></div><aside class="drawer" role="dialog" aria-modal="true"><header><h3></h3><button class="drawer-x" type="button" data-drawer-close aria-label="Close">×</button></header><div class="drawer-body"></div><footer class="drawer-foot"></footer></aside>';
  document.body.append(layer);
  let drawerState = null;
  function closeDrawer() {
    if (!drawerState) return;
    if (drawerState.form) { drawerState.form.hidden = true; drawerState.home.append(drawerState.form); }
    drawerState = null;
    layer.hidden = true;
    $('.drawer-body', layer).innerHTML = '';
    $('.drawer-foot', layer).innerHTML = '';
  }
  /**
   * Open the side panel. Either { form } (an existing form element, kept with its own submit logic) or
   * { body: html, onSave(bodyEl), onRemove? } for forms made here.
   */
  function drawer({ title, form = null, body = '', onSave = null, onRemove = null, saveLabel = 'Save', removeLabel = 'Remove' }) {
    closeDrawer();
    $('h3', layer).textContent = title;
    const b = $('.drawer-body', layer);
    const foot = $('.drawer-foot', layer);
    drawerState = { form, home: form?.parentElement };
    if (form) {
      labelForm(form);
      form.hidden = false;
      b.append(form);
      foot.innerHTML = `<span></span><div class="drawer-btns"><button class="btn" type="button" data-drawer-close>Cancel</button>
        <button class="btn primary" type="button" data-drawer-submit>${esc(saveLabel)}</button></div>`;
    } else {
      b.innerHTML = body;
      foot.innerHTML = `${onRemove ? `<button class="btn danger" type="button" data-drawer-remove>${esc(removeLabel)}</button>` : '<span></span>'}
        <div class="drawer-btns"><button class="btn" type="button" data-drawer-close>Cancel</button><button class="btn primary" type="button" data-drawer-save>${esc(saveLabel)}</button></div>`;
      drawerState.onSave = onSave;
      drawerState.onRemove = onRemove;
    }
    layer.hidden = false;
    setTimeout(() => $('input:not([type=hidden]), select, textarea', b)?.focus(), 30);
  }
  layer.addEventListener('click', async (e) => {
    if (e.target.closest('[data-drawer-close]')) return closeDrawer();
    if (e.target.closest('[data-drawer-submit]')) return drawerState?.form?.requestSubmit();
    const save = e.target.closest('[data-drawer-save]');
    const remove = e.target.closest('[data-drawer-remove]');
    const fn = save ? drawerState?.onSave : remove ? drawerState?.onRemove : null;
    if (!fn) return;
    (save || remove).disabled = true;
    try { if ((await fn($('.drawer-body', layer))) !== false) closeDrawer(); } catch (err) { A.toast(err.message); } finally { if (save || remove) (save || remove).disabled = false; }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerState) closeDrawer(); });
  // app.js: a driver / labourer / truck form was saved, or an Edit button filled one in.
  document.addEventListener('setup-saved', closeDrawer);
  document.addEventListener('setup-edit', (e) => {
    const form = e.detail?.form;
    const kind = listForms['#' + form?.getAttribute('id')]; // (form.id is the form's hidden "id" input)
    if (!kind) return;
    const name = form.elements.name?.value || form.elements.unit?.value || '';
    drawer({ title: name || `New ${kind}`, form, saveLabel: `Save ${kind}` });
  });
  shell.addEventListener('click', (e) => {
    const add = e.target.closest('[data-setup-add]');
    if (!add) return;
    const form = $(add.dataset.setupAdd);
    form.reset();
    if (form.elements.id) form.elements.id.value = '';
    if (form.elements.kind && form.id !== 'truck-form') form.elements.kind.value = form.id === 'labourer-form' ? 'labourer' : 'driver';
    drawer({ title: `New ${listForms[add.dataset.setupAdd]}`, form, saveLabel: `Save ${listForms[add.dataset.setupAdd]}` });
  });

  // ---------- menu ----------
  let current = 'overview';
  try { current = localStorage.getItem('setup-section') || 'overview'; } catch { /* private window */ }
  function renderNav() {
    const q = ($('.setup-search', shell).value || '').toLowerCase().trim();
    const list = items();
    if (!list.some((it) => it.id === current)) current = 'overview';
    const hit = (it) => !q || it.name.toLowerCase().includes(q) || (KEYWORDS[it.id] || '').includes(q) || it.text.toLowerCase().includes(q);
    $('.setup-nav', shell).innerHTML = SECTIONS.map((g) => {
      const its = g.items.filter((it) => list.includes(it) && hit(it));
      if (!its.length) return '';
      return `<div class="setup-group"><div class="setup-gl">${esc(g.group)}</div>${its.map((it) => `<a href="#" class="${it.id === current ? 'on' : ''}" data-setup-go="${it.id}">
        <span>${esc(it.name)}${it.owner ? ' <span class="setup-owner">you only</span>' : ''}</span>
        ${counts[it.id] != null ? `<span class="setup-n">${counts[it.id]}</span>` : dots[it.id] ? `<span class="setup-dot ${dots[it.id]}" title="${dots[it.id] === 'on' ? 'On' : dots[it.id] === 'warn' ? 'Needs a look' : 'Off'}"></span>` : ''}</a>`).join('')}</div>`;
    }).join('') || '<div class="setup-gl">No settings match</div>';
    $('.setup-select', shell).innerHTML = SECTIONS.map((g) => {
      const its = g.items.filter((it) => list.includes(it));
      return its.length ? `<optgroup label="${esc(g.group)}">${its.map((it) => `<option value="${it.id}" ${it.id === current ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
  }
  function show(id) {
    current = id;
    try { localStorage.setItem('setup-section', id); } catch { /* private window */ }
    for (const [k, el] of Object.entries(sectionEls)) el.hidden = k !== id;
    renderNav();
    if (id === 'overview') renderOverview();
    window.scrollTo({ top: 0 });
  }
  shell.addEventListener('click', (e) => {
    const go = e.target.closest('[data-setup-go]');
    if (go) { e.preventDefault(); show(go.dataset.setupGo); }
  });
  $('.setup-select', shell).addEventListener('change', (e) => show(e.target.value));
  $('.setup-search', shell).addEventListener('input', () => {
    renderNav();
    const first = $('.setup-nav a', shell);
    if ($('.setup-search', shell).value.trim() && first && !$('.setup-nav a.on', shell)) show(first.dataset.setupGo);
  });

  // ---------- overview ----------
  const hm12 = (hm) => { if (!hm) return ''; const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const card = (go, k, v, s, tone = '') => `<button type="button" class="setup-card ${tone}" data-setup-go="${go}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></button>`;
  async function renderOverview() {
    const box = $('.setup-cards', sectionEls.overview);
    const [settings, drivers, trucks, sitesSetup, sms, backups] = await Promise.all([
      api('/settings').catch(() => ({})), api('/drivers?all=1').catch(() => []), api('/trucks?all=1').catch(() => []),
      api('/sites/setup').catch(() => ({ sites: [], heads: [], equipment: [], locations: {} })), api('/sms/status').catch(() => null), api('/backups').catch(() => null)]);
    const people = drivers.filter((d) => d.active);
    const drv = people.filter((d) => d.kind !== 'labourer').length;
    const lab = people.filter((d) => d.kind === 'labourer').length;
    const eq = (sitesSetup.equipment || []).filter((e) => e.active);
    const atSites = eq.filter((e) => sitesSetup.locations?.[e.id]?.site_id).length;
    const shop = eq.filter((e) => e.in_shop).length;
    const activeSites = (sitesSetup.sites || []).filter((s) => s.active).length;
    const smsOk = sms && sms.configured && !(sms.problems || []).length;
    const lastOk = (backups?.targets || []).map((t) => t.last_ok?.at).filter(Boolean).sort().pop();
    const backupBad = (backups?.targets || []).some((t) => t.last && !t.last.ok);
    const ago = (sql) => { const m = Math.round((Date.now() - new Date(String(sql).replace(' ', 'T') + 'Z')) / 60000); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
    const rv = settings.reviews || {};
    // Counts and on/off dots for the menu, from the same data.
    Object.assign(counts, { drivers: drv, labourers: lab, trucks: trucks.filter((t) => t.active).length, equipment: eq.length, sites: activeSites });
    Object.assign(dots, { texting: smsOk ? 'on' : 'warn', daytext: settings.lineup_time ? 'on' : 'off', sitetext: sitesSetup.ask_time ? 'on' : 'off',
      reviews: rv.on ? 'on' : 'off', backups: backupBad ? 'warn' : lastOk ? 'on' : 'off' });
    renderNav();
    box.innerHTML = [
      card('texting', 'Texting number', smsOk ? 'Connected' : sms?.configured ? 'Needs a look' : 'Test mode',
        smsOk ? `${sms.number?.phone ? A.prettyPhone(sms.number.phone) + ' · ' : ''}replies come back in.` : 'Texts are not going out yet. Open to see what to fix.', smsOk ? '' : 'warn'),
      card('daytext', "Drivers' day text", settings.lineup_time ? `${settings.lineup_when === 'morning' ? 'Morning of' : 'Evening before'}, ${hm12(settings.lineup_time)}` : 'Off',
        settings.lineup_time ? 'Each driver and labourer gets their jobs in one text.' : 'Drivers are only texted from the Board.', settings.lineup_when === 'morning' || !settings.lineup_time ? '' : 'warn'),
      card('sitetext', "Site heads' text", sitesSetup.ask_time ? `Every work day, ${hm12(sitesSetup.ask_time)}` : 'Off', `${activeSites} active site${activeSites === 1 ? '' : 's'}.`),
      card('backups', 'Backups', lastOk ? `Last copy ${ago(lastOk)}` : 'No copy yet', backupBad ? 'The last try failed somewhere. Open to see.' : 'Hourly and nightly.', backupBad || !lastOk ? 'warn' : ''),
      card('reviews', 'Review requests', rv.on ? 'On' : 'Off', rv.on ? 'Customers are asked an hour after the job.' : rv.link ? 'Ready: switch them on when you like.' : 'Paste your Google review link to switch these on.'),
      card('equipment', 'Equipment', `${eq.length} machine${eq.length === 1 ? '' : 's'}`, `${atSites} at sites, ${eq.length - atSites} in the yard${shop ? `, ${shop} in the shop` : ''}.`),
      card('drivers', 'People & trucks', `${drv} drivers · ${lab} labourers`, `${trucks.filter((t) => t.active).length} trucks, ${activeSites} active sites.`),
      card('fields', 'Work order fields', 'Fields & required', 'What each type of work order asks, and what must be filled in.'),
    ].join('');
  }

  // ---------- start ----------
  function start() {
    renderNav();
    show(current);
    window.SITES?.mountSetupParts?.(mounts).catch(() => {});
    renderOverview().catch(() => {});
  }
  window.SETUP_UI = { drawer, closeDrawer, show, refresh: () => renderOverview().catch(() => {}), start };
})();
