/*
 * The work order types, modelled on the Adams Bros paper forms.
 * Shared by the server (texts, driver page, print) and the dashboard (job form).
 *
 * Every job also has the common fields that are on all the forms: customer name, phone, email,
 * billing/mailing address, PO #, delivery address, municipality, site contact, delivery date,
 * quoted price and payment method.
 *
 * field.kind: text | textarea | choice | date | number
 * field.sms:  include it in the text to the driver
 * `report` fields are filled in by the driver on their phone after the job (like the bottom of the septic sheet).
 */
(function (root, factory) {
  const forms = factory();
  if (typeof module === 'object' && module.exports) module.exports = forms;
  else root.FORMS = forms;
})(typeof self !== 'undefined' ? self : this, function () {
  const YES_NO = ['Yes', 'No'];
  const BAFFLE = ['OK', 'Recommend replacement', 'Cannot see'];

  const TYPES = {
    haul: {
      name: 'Aggregate',
      title: 'Aggregates Work Order',
      icon: '🪨',
      what: 'Aggregate type',
      whatSuggestions: ['Sand fill', 'Sand', '2" minus', '6" minus', '3/4" clear', '2" clear', '3/4" crush', 'Pit run',
        'Gravel', 'Topsoil', 'Screened topsoil', 'Fill', 'Asphalt', 'Recycled asphalt', 'Rip rap', 'Washed rock'],
      // Like the paper form: "# of Loads ___ OR # of Yards ___", always in yards.
      quantity: true,
      quantityLabel: 'OR # of yards',
      fixedUnit: 'yards',
      loads: true,
      loadsLabel: '# of loads',
      from: 'From (pit / yard)',
      to: 'Delivery address',
      // The paper form has two aggregate lines; the first uses the main fields above.
      // slot 'first' = above the aggregate line, 'top' = right under it.
      fields: [
        { key: 'direction', label: 'Job', kind: 'choice', options: ['Deliver to site', 'Haul away from site'], sms: true, slot: 'first' },
        { key: 'until_stop', label: 'Keep hauling until the site says stop', kind: 'check', sms: true, slot: 'first' },
        { key: 'truck', label: 'Circle one', kind: 'choice', options: ['Tandem', 'Triaxle', 'H&G'], sms: true, top: true },
        { key: 'aggregate2_type', label: '2nd aggregate type', kind: 'text', sms: true, top: true, suggestions: 'what' },
        { key: 'aggregate2_loads', label: '# of loads', kind: 'number', sms: true, top: true },
        { key: 'aggregate2_yards', label: 'OR # of yards', kind: 'number', sms: true, top: true },
        { key: 'aggregate2_truck', label: 'Circle one', kind: 'choice', options: ['Tandem', 'Triaxle', 'H&G'], sms: true, top: true },
      ],
      report: [],
    },
    bin: {
      name: 'Bin',
      title: 'Bin Work Order',
      icon: '🗑️',
      what: 'Bin size',
      whatSuggestions: ['10 yd', '14 yd', '20 yd', '30 yd', '40 yd'],
      quantity: false,
      loads: false,
      from: null,
      to: 'Delivery address',
      fields: [
        { key: 'service', label: 'Circle one', kind: 'choice', options: ['Deliver bin', 'Empty & return', 'Empty & no return', 'H&G'], sms: true },
      ],
      report: [],
    },
    septic: {
      name: 'Septic',
      title: 'Septic Pump-out',
      icon: '💧',
      what: null,
      quantity: false,
      loads: false,
      from: null,
      to: 'Property address',
      fields: [
        { key: 'tank_size', label: 'Approx. tank size', kind: 'text', sms: true },
        { key: 'elevation', label: 'Elevation', kind: 'text', sms: true },
        { key: 'hose_length', label: 'Hose length', kind: 'text', sms: true },
        { key: 'lids_uncovered', label: 'Lids uncovered', kind: 'choice', options: ['Yes', 'No', 'At grade'], sms: true },
        { key: 'tank_type', label: 'Type of tank', kind: 'choice', options: ['Septic', 'Holding', 'Pump chamber'], sms: true },
        { key: 'steep_driveway', label: 'Steep driveway', kind: 'choice', options: YES_NO, sms: true },
        { key: 'back_in', label: 'Back in from roadway', kind: 'choice', options: YES_NO, sms: true },
        { key: 'tank_location', label: 'Tank location', kind: 'text', wide: true, sms: true },
        { key: 'directions', label: 'Directions', kind: 'textarea', wide: true, sms: true },
      ],
      reportTitle: 'Observed conditions of tanks',
      report: [
        { key: 'anyone_present', label: 'Anyone present at pump-out?', kind: 'choice', options: YES_NO },
        { key: 'present_name', label: 'Name', kind: 'text' },
        { key: 'weather', label: 'Weather conditions', kind: 'text' },
        { key: 'tank_construction', label: 'Tank construction', kind: 'choice', options: ['Steel', 'Concrete', 'Plastic'] },
        { key: 'outlet_baffle', label: 'Outlet baffle', kind: 'choice', options: BAFFLE },
        { key: 'inlet_baffle', label: 'Inlet baffle', kind: 'choice', options: BAFFLE },
        { key: 'liquid_level', label: 'Liquid level in tanks', kind: 'choice', options: ['Normal', 'High', 'Low', 'Overflowing'] },
        { key: 'filter', label: 'Filter', kind: 'choice', options: YES_NO },
        { key: 'cleaned', label: 'Filter cleaned', kind: 'choice', options: YES_NO },
        { key: 'lids_broken', label: 'Lid or lids broken?', kind: 'choice', options: YES_NO },
        { key: 'more_frequent', label: 'Requires more frequent pumping?', kind: 'choice', options: YES_NO },
        { key: 'extras', label: 'Extras (hoses, digging lids)', kind: 'text' },
        { key: 'ecoethic', label: 'EcoEthic additive', kind: 'choice', options: YES_NO },
        { key: 'comments', label: 'Comments', kind: 'textarea' },
      ],
      disclaimer: 'THIS IS A SEPTIC CHECK UP, NOT A LICENCED SEPTIC INSPECTION. ' +
        "Adams Bro's cannot be responsible for broken lids if we must open the tanks.",
    },
    toilet: {
      name: 'Toilet',
      title: 'Portable Toilet Rental',
      icon: '🚻',
      what: null,
      quantity: false,
      loads: false,
      from: null,
      to: 'Delivery address',
      fields: [
        { key: 'trip', label: 'This trip', kind: 'choice', options: ['Deliver', 'Pick up', 'Service'], sms: true },
        { key: 'pickup_date', label: 'Expected pick-up date', kind: 'date', sms: true, wide: true },
        { key: 'toilet1_type', label: 'Type of toilet', kind: 'text', sms: true, suggestions: 'toilets' },
        { key: 'toilet1_qty', label: 'How many', kind: 'number', sms: true },
        { key: 'toilet2_type', label: 'Type of toilet', kind: 'text', sms: true, suggestions: 'toilets' },
        { key: 'toilet2_qty', label: 'How many', kind: 'number', sms: true },
        { key: 'toilet3_type', label: 'Type of toilet', kind: 'text', sms: true, suggestions: 'toilets' },
        { key: 'toilet3_qty', label: 'How many', kind: 'number', sms: true },
        { key: 'placement', label: 'Directions of where to place toilet', kind: 'textarea', wide: true, sms: true },
        { key: 'extra_servicing', label: 'Is extra servicing required?', kind: 'text', wide: true, sms: true },
      ],
      report: [],
    },
    float: {
      name: 'Float',
      title: 'Float / Equipment Move',
      icon: '🚜',
      what: 'Equipment',
      whatSuggestions: [],
      quantity: false,
      loads: false,
      from: 'Pick up at',
      to: 'Drop off at',
      fields: [],
      report: [],
    },
    // The boss telling the crew where to be and what to do: no customer billing, no prices, not sent to QuickBooks.
    labour: {
      name: 'Labour',
      title: 'Labour Work Order',
      icon: '👷',
      what: 'What they are doing',
      whatSuggestions: ['Dig and uncover lids', 'Install risers', 'Landscaping', 'Clean-up', 'Hand digging', 'Flagging / traffic',
        'Help the operator', 'Shop / yard work'],
      quantity: false,
      loads: false,
      from: null,
      to: 'Where',
      noPricing: true,
      fields: [
        { key: 'bring', label: 'Bring (tools / equipment)', kind: 'text', wide: true, sms: true },
        { key: 'report_to', label: 'Report to', kind: 'text', sms: true },
      ],
      report: [],
    },
    // Trucks, drivers, labourers and machines sent to one of our own job sites (Sites tab): not billed, not a customer.
    site: {
      name: 'Our site',
      title: 'Our Job Site',
      icon: '🏗️',
      what: 'Site',
      whatSuggestions: [],
      quantity: false,
      loads: false,
      from: null,
      to: 'Site address',
      noPricing: true,
      fields: [
        { key: 'site_head', label: 'Site head', kind: 'text', sms: true },
        // Office and print only: each driver's own load is in their text (assignment note).
        { key: 'hauling', label: 'Hauling', kind: 'text', wide: true },
        { key: 'equipment', label: 'Equipment', kind: 'text', wide: true },
      ],
      report: [],
    },
    misc: {
      name: 'Misc',
      title: 'Miscellaneous Work Order',
      icon: '🛠️',
      what: 'Work / material',
      quantity: true,
      loads: true,
      from: 'From (if any)',
      to: 'Delivery address',
      fields: [],
      report: [],
    },
  };

  const TYPE_KEYS = Object.keys(TYPES);

  // ---------- admins shape the work orders (Setup → Work order fields) ----------
  // custom_fields = {
  //   haul: [{ key, label, active, sms, reception, … }, …],   // every type field in order: built-in ones (builtin: true)
  //                                                             // can be renamed, removed, reordered and given extra choices;
  //                                                             // added ones (key x_…) also have kind / options / by
  //   common: { haul: { customer_phone: { label, hidden } } },   // the boxes every work order has
  // }
  // Keys never change, so website orders, prices and old work orders keep working whatever the labels say.
  // A removed field is hidden from forms, but a value already on a work order (or sent by the website) still shows and prints.
  const CUSTOM_KINDS = ['text', 'textarea', 'number', 'yesno', 'choice', 'date'];
  const BUILTIN = Object.fromEntries(TYPE_KEYS.map((k) => [k, {
    fields: TYPES[k].fields.slice(), report: TYPES[k].report.slice(),
    labels: { what: TYPES[k].what, from: TYPES[k].from, to: TYPES[k].to, loadsLabel: TYPES[k].loadsLabel, quantityLabel: TYPES[k].quantityLabel },
  }]));
  // The reception screen asks these itself (tiles and chips), so they can't also be put under its "Details".
  const RECEPTION_ASKS = ['direction', 'until_stop', 'truck', 'service', 'tank_size', 'tank_type', 'trip', 'pickup_date', 'placement',
    'extra_servicing', 'aggregate2_type', 'aggregate2_loads', 'aggregate2_yards', 'aggregate2_truck',
    'toilet1_type', 'toilet1_qty', 'toilet2_type', 'toilet2_qty', 'toilet3_type', 'toilet3_qty'];

  /** The boxes on every work order, for this type: [{ key, label, base, hidden, lock, when }]. */
  function commonDefaults(type) {
    const b = BUILTIN[type] ? BUILTIN[type].labels : BUILTIN.haul.labels;
    const t = TYPES[type] || TYPES.haul;
    const out = [
      { key: 'paper_wo', base: 'Paper W.O. #' },
      { key: 'customer', base: 'Name', lock: true },
      { key: 'customer_phone', base: 'Phone #' },
      { key: 'billing_address', base: 'Billing / mailing address' },
      { key: 'po_number', base: 'PO #' },
      { key: 'customer_email', base: 'Email' },
    ];
    // What / loads / quantity are priced on aggregates and bins, so they stay on those forms.
    if (b.what) out.push({ key: 'material', base: b.what, lock: ['haul', 'bin'].includes(type), when: 'what' });
    if (t.loads) out.push({ key: 'loads_planned', base: b.loadsLabel || 'Number of loads', lock: type === 'haul', when: 'loads' });
    if (t.quantity) out.push({ key: 'quantity', base: b.quantityLabel || 'Quantity', lock: type === 'haul', when: 'quantity' });
    if (b.from) out.push({ key: 'from_location', base: b.from, when: 'from' });
    out.push(
      { key: 'to_location', base: b.to || 'Delivery address', lock: true },
      { key: 'municipality', base: 'Municipality' },
      { key: 'contact_name', base: 'Site contact name' },
      { key: 'contact_phone', base: 'Site contact phone #' },
      { key: 'notes', base: 'Special instructions (drivers see this)' },
    );
    if (!t.noPricing) out.push({ key: 'payment_method', base: 'Payment method' });
    return out;
  }
  let custom = {};
  function commonFields(type) {
    const o = (custom.common && custom.common[type]) || {};
    return commonDefaults(type).map((c) => ({ ...c, label: (o[c.key] && o[c.key].label) || c.base,
      hidden: !c.lock && Boolean(o[c.key] && o[c.key].hidden) }));
  }
  const commonLabel = (type, key, fallback) => (commonFields(type).find((c) => c.key === key) || {}).label || fallback;
  const commonHidden = (type, key) => Boolean((commonFields(type).find((c) => c.key === key) || {}).hidden);

  function toField(type, c) {
    const base = BUILTIN[type].fields.concat(BUILTIN[type].report).find((f) => f.key === c.key);
    if (base) {
      const f = { ...base, builtin: true, label: String(c.label || '').trim() || base.label, hidden: c.active === false,
        sms: c.sms === undefined ? Boolean(base.sms) : Boolean(c.sms),
        reception: Boolean(c.reception) && !RECEPTION_ASKS.includes(base.key), by: BUILTIN[type].report.includes(base) ? 'driver' : 'office' };
      if (base.options) f.options = [...new Set([...base.options, ...(c.extra_options || []).filter(Boolean)])];
      return f;
    }
    const f = { key: c.key, label: c.label, custom: true, hidden: c.active === false, sms: Boolean(c.sms), reception: Boolean(c.reception),
      by: c.by === 'driver' ? 'driver' : 'office' };
    if (c.kind === 'yesno') return { ...f, kind: 'choice', options: ['Yes', 'No'] };
    if (c.kind === 'choice') return { ...f, kind: 'choice', options: (c.options || []).filter(Boolean) };
    if (c.kind === 'textarea') return { ...f, kind: 'textarea', wide: true };
    return { ...f, kind: CUSTOM_KINDS.includes(c.kind) ? c.kind : 'text', wide: c.kind === 'text' };
  }
  function setCustomFields(cfg) {
    custom = cfg && typeof cfg === 'object' ? cfg : {};
    for (const k of TYPE_KEYS) {
      const list = Array.isArray(custom[k]) ? custom[k] : [];
      const b = BUILTIN[k];
      const isBuiltin = (key) => b.fields.concat(b.report).some((f) => f.key === key);
      // Built-in fields not in the saved list (e.g. added to the app later) go in their usual place at the end.
      const listed = new Set(list.map((c) => c.key));
      const all = [...list.filter((c) => c && c.key), ...b.fields.concat(b.report).filter((f) => !listed.has(f.key)).map((f) => ({ key: f.key }))]
        .filter((c) => isBuiltin(c.key) || /^x_/.test(c.key))
        .map((c) => toField(k, c));
      TYPES[k].fields = all.filter((f) => f.by !== 'driver');
      TYPES[k].report = all.filter((f) => f.by === 'driver');
      // Renamed common boxes the rest of the app reads off the type.
      const lb = (key, dflt) => commonLabel(k, key, dflt);
      TYPES[k].what = b.labels.what ? lb('material', b.labels.what) : b.labels.what;
      TYPES[k].from = b.labels.from ? lb('from_location', b.labels.from) : b.labels.from;
      TYPES[k].to = lb('to_location', b.labels.to);
      if (TYPES[k].loads) TYPES[k].loadsLabel = lb('loads_planned', b.labels.loadsLabel || 'Number of loads');
      if (TYPES[k].quantity) TYPES[k].quantityLabel = lb('quantity', b.labels.quantityLabel || 'Quantity');
    }
  }
  const customFields = () => custom;
  setCustomFields({});
  /** Everything an admin can change for a type, for Setup: { fields: [...], common: [...] } with the defaults alongside. */
  function layout(type) {
    const b = BUILTIN[type];
    const all = TYPES[type].fields.concat(TYPES[type].report).map((f) => {
      const base = b.fields.concat(b.report).find((x) => x.key === f.key);
      const same = base && b.fields.concat(b.report).filter((x) => x.label === base.label).length > 1;
      const saved = (custom[type] || []).find((c) => c.key === f.key) || {};
      return f.builtin ? { key: f.key, builtin: true, label: f.label, base: base.label, kind: base.kind, options: base.options || null,
        extra_options: (f.options || []).filter((o) => !(base.options || []).includes(o)), by: f.by, sms: f.sms, reception: f.reception,
        no_reception: RECEPTION_ASKS.includes(f.key) || f.by === 'driver', active: !f.hidden,
        hint: same ? f.key.replace(/_/g, ' ').replace(/(\d)/, ' $1') : '' }
        : { ...saved, key: f.key, label: f.label, active: !f.hidden };
    });
    return { fields: all, common: commonFields(type) };
  }
  const TOILET_TYPES = ['Standard', 'Deluxe', 'Wheelchair accessible', 'Hand wash station', 'Flushing'];
  const PAYMENT_METHODS = ['Cash', 'Debit', 'Visa/MC', 'Cheque', 'On account'];
  // Truck kinds, so drivers whose usual truck fits the job type are listed first.
  const TRUCK_KINDS = { haul: 'Gravel / end dump', float: 'Float / lowbed', septic: 'Septic vac', bin: 'Bin truck', toilet: 'Toilet service', other: 'Other' };

  function typeInfo(key) {
    return TYPES[key] || TYPES.haul;
  }

  function parseDetails(job) {
    if (!job) return {};
    if (job.details && typeof job.details === 'object') return job.details;
    try { return JSON.parse(job.details || '{}') || {}; } catch { return {}; }
  }

  /** "2× Standard, 1× Wheelchair accessible" */
  function toiletSummary(d) {
    return [1, 2, 3].map((i) => {
      const type = d[`toilet${i}_type`];
      const qty = d[`toilet${i}_qty`];
      if (!type && !qty) return '';
      return `${qty || 1}× ${type || 'toilet'}`;
    }).filter(Boolean).join(', ');
  }

  /** One-line description of the work, for cards, texts and lists. */
  const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

  /** "Sand fill - 1 load - Tandem" for one aggregate line. */
  function aggregateLine(type, loads, yards, truck) {
    return [type, loads ? plural(loads, 'load') : '', yards ? `${yards} yards` : '', truck].filter(Boolean).join(' - ');
  }

  /** Loads planned across both aggregate lines, for the progress bar. */
  function totalLoads(job) {
    const d = parseDetails(job);
    if (job.job_type === 'haul' && d.until_stop) return 0; // open-ended: no target
    return (Number(job.loads_planned) || 0) + (job.job_type === 'haul' ? Number(d.aggregate2_loads) || 0 : 0);
  }

  function summary(job) {
    const t = typeInfo(job.job_type);
    const d = parseDetails(job);
    const qty = [job.quantity, job.unit].filter(Boolean).join(' ');
    const loads = job.loads_planned ? plural(job.loads_planned, 'load') : '';
    switch (job.job_type) {
      case 'haul': {
        const stop = Boolean(d.until_stop);
        const first = aggregateLine(job.material, stop ? '' : job.loads_planned, stop ? '' : job.quantity, d.truck);
        const second = aggregateLine(d.aggregate2_type, stop ? '' : d.aggregate2_loads, stop ? '' : d.aggregate2_yards, d.aggregate2_truck);
        const what = [first, second].filter(Boolean).join(' + ');
        const parts = [isHaulAway(job) ? 'HAUL AWAY' : '', what, stop ? 'until site says stop' : ''].filter(Boolean);
        return parts.join(' - ') || t.name;
      }
      case 'bin':
        return [d.service, job.material].filter(Boolean).join(' - ');
      case 'septic':
        return ['Pump-out', d.tank_type && d.tank_type.toLowerCase() + ' tank', d.tank_size].filter(Boolean).join(' - ');
      case 'toilet':
        return [d.trip, toiletSummary(d)].filter(Boolean).join(' - ');
      case 'labour':
        return job.material || 'Labour';
      default:
        return [job.material, qty, loads].filter(Boolean).join(' - ') || (t.name === 'Misc' ? '' : t.name);
    }
  }

  function isHaulAway(job) {
    return job && job.job_type === 'haul' && parseDetails(job).direction === 'Haul away from site';
  }

  /**
   * Address labels for a job. A haul-away flips them: the job site is where the truck loads,
   * and the other address is where the load goes.
   */
  function labels(job) {
    const t = typeInfo(job.job_type);
    if (isHaulAway(job)) return { from: 'Dump at', to: 'Job site (load here)' };
    return { from: t.from, to: t.to };
  }

  /** Extra instructions for the driver text, e.g. "Show up EMPTY" for a haul-away. */
  function driverInstructions(job) {
    const d = parseDetails(job);
    const out = [];
    if (isHaulAway(job)) out.push('Show up EMPTY and haul material away from the site.');
    if (job.job_type === 'haul' && d.until_stop) out.push('Keep hauling until the people on site say stop.');
    return out;
  }

  function isEmpty(v) {
    return v === undefined || v === null || String(v).trim() === '';
  }

  /** Type-specific lines for the driver text: [label, value][]. */
  function smsLines(job) {
    const t = typeInfo(job.job_type);
    const d = parseDetails(job);
    const out = [];
    for (const f of t.fields) {
      if (!f.sms || f.hidden) continue;
      if (/^toilet\d_/.test(f.key)) continue;
      if (['service', 'trip', 'tank_type', 'tank_size', 'truck', 'direction', 'until_stop'].includes(f.key) || /^aggregate2_/.test(f.key)) continue; // already in the summary line
      if (!isEmpty(d[f.key])) out.push([f.label, d[f.key]]);
    }
    return out; // toilet types & counts are already in the summary line
  }

  // ---------- time of day (customers aren't given exact times) ----------
  // '' = not picked yet (shown as "Any time"); 'any' = picked "Any time" (counts when Time is a required field).
  const TIME_SLOTS = [['first', 'First thing'], ['am', 'AM'], ['pm', 'PM'], ['any', 'Any time']];
  function slotLabel(slot) {
    return (TIME_SLOTS.find(([k]) => k === slot) || TIME_SLOTS[3])[1];
  }

  // ---------- required fields ----------
  /** The fields an admin can make required for a work order type: [{ key, label }] (type fields are 'd.<key>'). */
  function requirable(type) {
    const t = typeInfo(type);
    const L = (key, dflt) => (commonHidden(type, key) ? null : { key, label: commonLabel(type, key, dflt) });
    const out = [
      { key: 'customer', label: commonLabel(type, 'customer', 'Name') === 'Name' ? 'Customer name' : commonLabel(type, 'customer') },
      L('customer_phone', 'Phone #'),
      L('billing_address', 'Billing / mailing address'),
      L('customer_email', 'Email'),
      L('po_number', 'PO #'),
      { key: 'time_slot', label: 'Time (first thing / AM / PM)' },
      { key: 'to_location', label: t.to || 'Delivery address' },
      L('municipality', 'Municipality'),
      L('contact_name', 'Site contact name'),
      L('contact_phone', 'Site contact phone #'),
    ];
    if (t.what) out.push(L('material', t.what));
    if (t.loads) out.push(commonHidden(type, 'loads_planned') ? null
      : { key: 'loads_planned', label: t.quantity ? `${t.loadsLabel || '# of loads'} (or yards)` : (t.loadsLabel || '# of loads') });
    if (t.from) out.push(L('from_location', t.from));
    out.push(commonHidden(type, 'notes') ? null : { key: 'notes', label: 'Special instructions' }, t.noPricing ? null : L('payment_method', 'Payment method'), L('paper_wo', 'Paper W.O. #'));
    for (const f of t.fields) if (f.kind !== 'check' && !f.hidden) out.push({ key: 'd.' + f.key, label: f.label === 'Circle one' ? `${f.label} (${f.options.join(' / ')})` : f.label });
    return out.filter(Boolean);
  }

  /** Required fields that are still empty: [{ key, label }]. A pinned map spot counts as the address. */
  function missingRequired(job, keys) {
    const d = parseDetails(job);
    const has = (k) => {
      if (k.startsWith('d.')) return !isEmpty(d[k.slice(2)]);
      if (k === 'time_slot') return Boolean(job.time_slot);
      if (k === 'to_location') return !isEmpty(job.to_location) || Boolean(job.has_pin);
      if (k === 'loads_planned') {
        return !isEmpty(job.loads_planned) || !isEmpty(job.quantity) || (job.job_type === 'haul' && Boolean(d.until_stop));
      }
      return !isEmpty(job[k]);
    };
    const all = requirable(job.job_type);
    return (keys || []).filter((k) => !has(k)).map((k) => all.find((f) => f.key === k) || { key: k, label: k });
  }

  return { setCustomFields, customFields, layout, commonFields, commonLabel, commonHidden, RECEPTION_ASKS, CUSTOM_KINDS, TIME_SLOTS, slotLabel, requirable, missingRequired, TYPES, TYPE_KEYS, TOILET_TYPES, PAYMENT_METHODS, totalLoads, isHaulAway, labels, driverInstructions, aggregateLine, TRUCK_KINDS, YES_NO, typeInfo, parseDetails, summary, smsLines, toiletSummary, isEmpty };
});
