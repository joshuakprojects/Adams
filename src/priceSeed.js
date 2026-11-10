// Starting price book, copied from the office price sheets:
//   2025 Aggregate Pricing · 2024 Delivery Fees · 2025 Septic Pricing (effective March 19, 2025, revised June 6, 2025)
//   Roll Off Price Sheet 2024 · Toilet & Water Price (revised June 6, 2025)
// Loaded once into an empty price book; after that admins change prices on the Prices tab.
// price: null = "inquire / price by hand". taxable: 0 = no HST (water is tax-exempt).
// Keys are used by the automatic pricing (public/pricing.js) and never change.

const slug = (s) => String(s).toLowerCase().replace(/["']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Material, per yard, per tandem, per triaxle (null = not sold that way / inquire), note
const AGGREGATES = [
  ['Fill', null, 180, 264],
  ['Sand Fill', 20, 210, 309],
  ['Screened Sand', 25, 270, 396],
  ['Screened Topsoil', 55, 570, 835],
  ['Mortar Sand', 52.5, 630, 924],
  ['Beach Sand', 52.5, 630, 924],
  ['Filter Sand', 52.5, 630, 924],
  ['ASTM C33', 45, 450, 665],
  ['Winter Sand', 50, null, null, '$35.00 for 1/2 yard'],
  ['Type A', 45, 450, 665],
  ['A Gravel 3/4"', 35, 340, 500],
  ['3/4" Clear (drainage)', 40, 400, 594],
  ['Granite Screenings', 40, 350, 585],
  ['2" Minus (B Stone)', 32, 320, 465],
  ['4-6" Minus', 30, 300, 450],
  ['6-8" Crib Stone', null, null, null, 'Inquire about pricing'],
  ['Pea Gravel', 69, 690, 1015],
  ['Pink A Gravel', 40, 400, 594],
  ['Pink 3/4" Clear', 57, 570, 835],
  ['1-3" Round Stone (River)', 72, 720, 1056],
  ['4-8" Round Stone (River)', 69, 690, 1015],
  ['Blast Rock', null, 225, 330],
  ['Limestone Screenings', 57, 570, 835],
  ['3/4" Limestone A Gravel', 57, 570, 835],
  ['Recycled Asphalt', 50, 570, 835],
  ['Cold Patch', null, null, null, 'Inquire about pricing if selling to the public — $160 for Adams jobs'],
  ['Triple Mix', 60, 720, 1200],
  ['Black Mulch', 60, 720, 1200],
  ['Enhanced Mulch (brown/red)', 60, 720, 1200],
  ['Red Mulch', 60, 720, 1200],
  ['Natural Mulch', 60, 720, 1200],
];

function seedItems() {
  const items = [];
  let sort = 0;
  const add = (o) => items.push({ taxable: 1, grp: '', unit: '', notes: '', max_km: null, ...o, sort: sort++ });

  for (const [name, yard, tandem, triaxle, note = ''] of AGGREGATES) {
    const base = `agg.${slug(name)}`;
    add({ key: `${base}.yard`, category: 'aggregate', grp: name, name: `${name} — per yard`, unit: 'yard', price: yard, notes: note });
    add({ key: `${base}.tandem`, category: 'aggregate', grp: name, name: `${name} — per tandem`, unit: 'tandem load', price: tandem });
    add({ key: `${base}.triaxle`, category: 'aggregate', grp: name, name: `${name} — per triaxle`, unit: 'triaxle load', price: triaxle });
  }
  add({ key: 'agg.winter-sand.half-yard', category: 'aggregate', grp: 'Winter Sand', name: 'Winter Sand — 1/2 yard', unit: '1/2 yard', price: 35 });
  add({ key: 'agg.extra_per_delivery', category: 'aggregate', name: 'Aggregate — extra per delivery', unit: 'delivery', price: 10,
    notes: '"$10.00 extra per Delivery" (2025 Aggregate Pricing)' });

  // Delivery fees, by driving distance from the starting point (116 William St.).
  add({ key: 'delivery.town', category: 'delivery', name: 'Delivery — within Parry Sound town limits', unit: 'delivery', price: 85 });
  for (const [km, price] of [[10, 95], [20, 110], [30, 130], [40, 150], [50, 175], [60, 200], [80, 225], [100, 250]]) {
    add({ key: `delivery.${km}`, category: 'delivery', name: `Delivery — up to ${km} km`, unit: 'delivery', price, max_km: km });
  }
  add({ key: 'delivery.triaxle_extra', category: 'delivery', name: 'Delivery — add for triaxles', unit: 'triaxle load', price: 10 });

  // Septic (2025).
  add({ key: 'septic.base', category: 'septic', name: 'Septic pump-out — up to 1000 gallon tank', unit: 'pump-out', price: 395.57, notes: '$447.00 with HST' });
  add({ key: 'septic.pump_per_gal', category: 'septic', name: 'Larger tanks — pumping', unit: 'gallon', price: 0.16 });
  add({ key: 'septic.disposal_member', category: 'septic', name: 'Larger tanks — disposal (lagoon members)', unit: 'gallon', price: 0.20 });
  add({ key: 'septic.disposal_nonmember', category: 'septic', name: 'Disposal — non-members of the Industrial Park lagoon', unit: 'gallon', price: 1.24,
    notes: 'Non-members: $0.16 pumping + $1.24 disposal per gallon' });
  add({ key: 'septic.pump_chamber', category: 'septic', name: 'Pump chamber pump-out (up to 80 gallons)', unit: 'each', price: 200, notes: '$226.00 with HST' });
  add({ key: 'septic.pump_chamber_with', category: 'septic', name: 'Pump chamber pump-out at the time of the septic pump-out', unit: 'each', price: 100 });
  add({ key: 'septic.off_schedule', category: 'septic', name: 'Off-schedule pump-out service charge', unit: 'each', price: 100 });
  add({ key: 'septic.baffle', category: 'septic', name: 'Baffle replacement (standard parts included)', unit: 'each', price: 250 });
  add({ key: 'septic.filter_install', category: 'septic', name: 'Effluent filter install', unit: 'each', price: 300 });
  add({ key: 'septic.filter_clean', category: 'septic', name: 'Effluent filter cleaning', unit: 'each', price: 100 });
  add({ key: 'septic.riser_labour', category: 'septic', name: 'Riser installation labour', unit: 'hour', price: 75 });
  add({ key: 'septic.truck_hour', category: 'septic', name: 'Pumper truck rental', unit: 'hour', price: 140 });
  add({ key: 'septic.ecoethic', category: 'septic', name: 'Eco Ethic septic powder', unit: 'each', price: 53.10, notes: '$60.00 with HST' });
  add({ key: 'septic.lids', category: 'septic', name: 'Locating and digging lids', unit: 'hour', price: 75, notes: 'Minimum charge $50.00 + HST' });
  add({ key: 'septic.air', category: 'septic', name: 'Air attachments for difficult pump-outs', unit: 'hour', price: 125 });
  add({ key: 'septic.extras', category: 'septic', name: 'Extra hoses, snaking, lid replacement, auxiliary pumps', unit: 'each', price: null,
    notes: 'All extra — not included in the pump-out price' });

  // Roll-off and Hook & Go bins (2024). Deposits are collected, not part of the price.
  add({ key: 'bin.deposit.small', category: 'bin', name: 'Deposit — 4 to 10 yd bins', unit: 'deposit', price: 500, taxable: 0 });
  add({ key: 'bin.deposit.medium', category: 'bin', name: 'Deposit — 12 to 15 yd bins', unit: 'deposit', price: 750, taxable: 0 });
  add({ key: 'bin.deposit.large', category: 'bin', name: 'Deposit — 20 to 40 yd bins', unit: 'deposit', price: 1000, taxable: 0 });
  add({ key: 'bin.deposit.scrap', category: 'bin', name: 'Deposit — bins for scrap metal', unit: 'deposit', price: 100, taxable: 0 });
  add({ key: 'bin.rental_week', category: 'bin', name: 'Bin rental — per week after the first (first week free)', unit: 'week', price: 60 });
  add({ key: 'bin.waste.mixed', category: 'bin', name: 'Disposal — mixed waste', unit: 'ton', price: 185 });
  add({ key: 'bin.waste.concrete', category: 'bin', name: 'Disposal — clean concrete', unit: 'ton', price: 55 });
  add({ key: 'bin.waste.asbestos', category: 'bin', name: 'Disposal — asbestos', unit: 'ton', price: 200 });
  add({ key: 'bin.waste.metal', category: 'bin', name: 'Disposal — clean metal only', unit: 'ton', price: 0, notes: 'No charge' });
  add({ key: 'bin.sea_container_month', category: 'bin', name: 'Sea container rental (20\' only)', unit: 'month', price: 150 });
  add({ key: 'bin.sea_container_delivery', category: 'bin', name: 'Sea container delivery', unit: 'hour', price: 150 });

  // Portable toilets (revised June 6, 2025).
  for (const [name, week, month, dims] of [
    ['Basic', 140, 180, '43.5"W x 47"L x 91"H'],
    ['Basic w/sink', 150, 205, '43.5"W x 47"L x 91"H'],
    ['Recirculated Flush', 240, 290, '43.5"W x 47"L x 91"H'],
    ['Handicapped', 240, 290, '62"W x 62"L x 91"H'],
    ['Deluxe w/sink & mirror', 260, 375, '47"W x 47"L x 91"H'],
    ['Handwash Station', 135, null, ''],
  ]) {
    add({ key: `toilet.${slug(name)}.week`, category: 'toilet', grp: name, name: `${name} — weekly (1 day up to 1 week)`, unit: 'unit / week', price: week, notes: dims });
    add({ key: `toilet.${slug(name)}.month`, category: 'toilet', grp: name, name: `${name} — monthly (28 days)`, unit: 'unit / month', price: month });
  }
  add({ key: 'toilet.winter_cover', category: 'toilet', name: 'Insulated winter cover', unit: 'each', price: 50 });
  add({ key: 'toilet.truck_hour', category: 'toilet', name: 'Toilet truck', unit: 'hour', price: 110 });
  add({ key: 'toilet.extra_service', category: 'toilet', name: 'Extra servicing / pump-out (monthly rentals are serviced weekly)', unit: 'unit', price: 85 });
  add({ key: 'toilet.off_schedule', category: 'toilet', name: 'Off-schedule delivery, pick-up or servicing charge', unit: 'each', price: 100 });
  add({ key: 'toilet.owned_plain', category: 'toilet', name: 'Customer-owned portable toilet pump-out — no chemical/supplies', unit: 'each', price: 95 });
  add({ key: 'toilet.owned_chem', category: 'toilet', name: 'Customer-owned portable toilet pump-out — with chemical', unit: 'each', price: 100 });
  add({ key: 'toilet.owned_trailer', category: 'toilet', name: 'Trailer, outhouse or boat pump-out', unit: 'each', price: 150,
    notes: 'Ask for the size of the tank and hose connection' });

  // Water (tax exempt).
  add({ key: 'water.load', category: 'water', name: 'Water (max 2500 imp. gallons)', unit: 'load', price: 150, taxable: 0 });
  add({ key: 'water.delivery_hour', category: 'water', name: 'Water delivery — from leaving the yard to returning', unit: 'hour', price: 130, taxable: 0,
    notes: 'Roll-off water truck 11,350 L max · H&G water truck 2,650 L max' });
  add({ key: 'water.tank_500', category: 'water', name: 'Water tank rental — 500 gallon', unit: 'each', price: 100, taxable: 0, notes: 'Delivery & pick-up extra' });
  add({ key: 'water.tank_1200', category: 'water', name: 'Water tank rental — 1200 gallon', unit: 'each', price: 150, taxable: 0, notes: 'Delivery & pick-up extra' });
  return items;
}

const CATEGORIES = [
  ['aggregate', 'Aggregate'],
  ['delivery', 'Delivery fees'],
  ['septic', 'Septic'],
  ['bin', 'Bins (roll-off & H&G)'],
  ['toilet', 'Toilets'],
  ['water', 'Water'],
  ['other', 'Other'],
];

// Reference notes shown with each category (from the sheets).
const CATEGORY_NOTES = {
  aggregate: '$10.00 extra per delivery. Delivery fee is charged per load (see Delivery fees).',
  delivery: 'Driving distance from the starting point (116 William St.). Add $10.00 for triaxles. Charged per load. ' +
    'Bins and toilets: delivery and pick-up are each charged.',
  septic: 'Pump-out schedule — Mon: Town · Tue: North · Wed: South · Thu: South · Fri: 124 · Sat: only if necessary. ' +
    'Off-schedule pump-outs are subject to a $100.00 + HST service charge. ' +
    'Lagoon members: Archipelago, Seguin, Carling, Wasauksing, McDougall, Whitestone, McKellar, Parry Sound — quote non-member rates for anyone not on this list.',
  bin: 'All prices plus HST. Contents no more than 6" from the top of the bin. No hazardous materials (oil, batteries, paint, aerosols, chemicals, tires, asbestos). ' +
    'Sizes — H&G: 4, 6, 8, 10, 12, 14, 15 yd · Roll-off: 15, 20, 30, 40 yd.',
  toilet: 'Delivery & pick-up charges extra (billed on the first invoice) — same as roll-off/gravel. ' +
    'Customer must call the office when the toilet is ready for pick-up.',
  water: 'Water is tax exempt.',
};

const LAGOON_MEMBERS = ['Archipelago', 'Seguin', 'Carling', 'Wasauksing', 'McDougall', 'Whitestone', 'McKellar', 'Parry Sound'];

module.exports = { seedItems, CATEGORIES, CATEGORY_NOTES, LAGOON_MEMBERS, slug };
