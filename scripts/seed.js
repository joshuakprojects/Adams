// Adds sample trucks, drivers and one job of each work order type for today, so you can try the board.
// Names and phone numbers are made up (555). Safe to run once on an empty database.
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createDispatch, addDays } = require('../src/dispatch');

const db = openDb(config.dbPath);
const d = createDispatch(db);
if (d.listDrivers().length) {
  console.log('Database already has drivers — not seeding.');
  process.exit(0);
}

const trucks = Object.fromEntries([
  ['T1', 'haul', 'Tri-axle dump'], ['T2', 'haul', 'Tandem dump'], ['F1', 'float', 'Float / lowbed'],
  ['S1', 'septic', 'Vac truck'], ['B1', 'bin', 'Roll-off bin truck'], ['P1', 'toilet', 'Toilet service truck'],
].map(([unit, kind, description]) => [unit, d.saveTruck({ unit, kind, description }).id]));

const drv = (name, phone, truck) => d.saveDriver({ name, phone, default_truck_id: trucks[truck] }).id;
const dave = drv('Dave Thompson', '705-555-0101', 'T1');
const ron = drv('Ron Kowalski', '705-555-0102', 'T2');
const bill = drv('Bill Henderson', '705-555-0104', 'F1');
const lyle = drv('Lyle Peterson', '705-555-0105', 'S1');
const gary = drv('Gary Mitchell', '705-555-0103', 'B1');
const pete = drv('Pete Lalonde', '705-555-0106', 'P1');

const today = d.today();
d.saveJob({
  job_type: 'haul', scheduled_date: today, scheduled_time: '07:00', customer: 'Northshore Builders', customer_phone: '705-555-2001',
  material: '2" minus', loads_planned: 20, from_location: 'Adams pit', to_location: '1200 Lake Rd', municipality: 'Ahmic Harbour',
  contact_name: 'Mike', contact_phone: '705-555-1234', notes: 'Dump at back of lot, by the garage pad.', quoted_price: 'Per load', payment_method: 'On account',
  assignments: [{ driver_id: dave, truck_id: trucks.T1 }, { driver_id: ron, truck_id: trucks.T2 }],
});
d.saveJob({
  job_type: 'float', scheduled_date: today, scheduled_time: '08:30', customer: 'Northshore Builders',
  material: '15 ton zero turn (smooth bucket)', from_location: 'Adams yard, 116 William St', to_location: '1200 Lake Rd', municipality: 'Ahmic Harbour',
  assignments: [{ driver_id: bill, truck_id: trucks.F1 }],
});
d.saveJob({
  job_type: 'septic', scheduled_date: today, scheduled_time: '10:00', customer: 'J. Larson', customer_phone: '705-555-7788',
  billing_address: 'PO Box 12, Parry Sound ON', to_location: '45 Bay Rd', municipality: 'McDougall',
  quoted_price: '$395', payment_method: 'Cash', collect_payment: true,
  details: { tank_size: '1000 gal', tank_type: 'Septic', lids_uncovered: 'No', hose_length: '100 ft', steep_driveway: 'Yes',
    back_in: 'Yes', tank_location: 'Under the deck, left side of the cottage', directions: 'Second driveway past the marina, green mailbox.' },
  notes: 'Dog in yard.',
  assignments: [{ driver_id: lyle, truck_id: trucks.S1 }],
});
d.saveJob({
  job_type: 'bin', scheduled_date: today, scheduled_time: '11:00', customer: 'K. Morris', customer_phone: '705-555-3344',
  material: '20 yd', to_location: '88 Seguin Trail', municipality: 'Seguin', quoted_price: '$450', payment_method: 'Visa/MC',
  details: { service: 'Deliver bin' }, notes: 'Place on the gravel pad, not the lawn.',
  assignments: [{ driver_id: gary, truck_id: trucks.B1 }],
});
d.saveJob({
  job_type: 'toilet', scheduled_date: today, scheduled_time: '13:00', customer: 'Carling Community Centre', customer_phone: '705-555-9090',
  po_number: 'CC-2231', to_location: '2 Community Way', municipality: 'Carling', quoted_price: '$180 / week', payment_method: 'Cheque',
  details: { trip: 'Deliver', pickup_date: addDays(today, 14), toilet1_type: 'Standard', toilet1_qty: '2',
    toilet2_type: 'Wheelchair accessible', toilet2_qty: '1', placement: 'Beside the pavilion, on the level spot', extra_servicing: 'Weekly pump-out' },
  assignments: [{ driver_id: pete, truck_id: trucks.P1 }],
});
d.saveJob({
  job_type: 'haul', scheduled_date: addDays(today, 1), scheduled_time: '07:30', customer: 'R. McDougall', material: 'Sand fill', loads_planned: 6,
  from_location: 'Adams pit', to_location: '310 Hwy 124', municipality: 'McDougall',
  assignments: [{ driver_id: dave, truck_id: trucks.T1 }],
});
console.log('Seeded 6 trucks, 6 drivers and 6 jobs (one of each form type) starting', today);
