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
      title: 'Aggregate Work Order',
      icon: '🪨',
      what: 'Aggregate type',
      whatSuggestions: ['Sand fill', 'Sand', '2" minus', '6" minus', '3/4" clear', '2" clear', '3/4" crush', 'Pit run',
        'Gravel', 'Topsoil', 'Screened topsoil', 'Fill', 'Asphalt', 'Recycled asphalt', 'Rip rap', 'Washed rock'],
      quantity: true,
      loads: true,
      from: 'From (pit / yard)',
      to: 'Delivery address',
      fields: [],
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
  const TOILET_TYPES = ['Standard', 'Deluxe', 'Wheelchair accessible', 'Hand wash station', 'Flushing'];
  const PAYMENT_METHODS = ['Cash', 'Debit', 'Visa/MC', 'Cheque', 'On account'];
  const COLLECTED = ['Cash', 'Cheque', 'Debit', 'Visa/MC', 'E-transfer', 'Not paid'];
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
  function summary(job) {
    const t = typeInfo(job.job_type);
    const d = parseDetails(job);
    const qty = [job.quantity, job.unit].filter(Boolean).join(' ');
    const loads = job.loads_planned ? `${job.loads_planned} load${job.loads_planned === 1 ? '' : 's'}` : '';
    switch (job.job_type) {
      case 'bin':
        return [d.service, job.material].filter(Boolean).join(' - ');
      case 'septic':
        return ['Pump-out', d.tank_type && d.tank_type.toLowerCase() + ' tank', d.tank_size].filter(Boolean).join(' - ');
      case 'toilet':
        return [d.trip, toiletSummary(d)].filter(Boolean).join(' - ');
      default:
        return [job.material, qty, loads].filter(Boolean).join(' - ') || (t.name === 'Misc' ? '' : t.name);
    }
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
      if (!f.sms) continue;
      if (/^toilet\d_/.test(f.key)) continue;
      if (['service', 'trip', 'tank_type', 'tank_size'].includes(f.key)) continue; // already in the summary line
      if (!isEmpty(d[f.key])) out.push([f.label, d[f.key]]);
    }
    return out; // toilet types & counts are already in the summary line
  }

  return { TYPES, TYPE_KEYS, TOILET_TYPES, PAYMENT_METHODS, COLLECTED, TRUCK_KINDS, YES_NO, typeInfo, parseDetails, summary, smsLines, toiletSummary, isEmpty };
});
