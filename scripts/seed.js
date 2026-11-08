// Adds sample trucks, drivers and a few jobs for today so you can try the board.
// Phone numbers are fake (555). Safe to run once on an empty database.
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createDispatch } = require('../src/dispatch');

const db = openDb(config.dbPath);
const d = createDispatch(db);
if (d.listDrivers().length) {
  console.log('Database already has drivers — not seeding.');
  process.exit(0);
}

const trucks = Object.fromEntries([
  ['T1', 'haul', 'Kenworth T800 end dump'], ['T2', 'haul', 'Western Star tri-axle'], ['T3', 'haul', 'Mack tandem'],
  ['F1', 'float', 'Peterbilt + 50T lowbed'], ['S1', 'septic', 'Vac truck 3000 gal'],
].map(([unit, kind, description]) => [unit, d.saveTruck({ unit, kind, description }).id]));

const drv = (name, phone, truck) => d.saveDriver({ name, phone, default_truck_id: trucks[truck] }).id;
const dave = drv('Dave Thompson', '403-555-0101', 'T1');
const ron = drv('Ron Kowalski', '403-555-0102', 'T2');
const gary = drv('Gary Mitchell', '403-555-0103', 'T3');
const bill = drv('Bill Henderson', '403-555-0104', 'F1');
const lyle = drv('Lyle Peterson', '403-555-0105', 'S1');

const today = d.today();
d.saveJob({
  job_type: 'haul', scheduled_date: today, scheduled_time: '07:00', customer: 'Northland Homes',
  material: '3/4" clear', quantity: '200', unit: 'tonnes', loads_planned: 12,
  from_location: 'Adams pit, Range Rd 20', to_location: '45 Oak St, Red Deer',
  contact_name: 'Mike', contact_phone: '403-555-1234', notes: 'Dump at back of lot, by the garage pad.',
  assignments: [{ driver_id: dave, truck_id: trucks.T1 }, { driver_id: ron, truck_id: trucks.T2 }],
});
d.saveJob({
  job_type: 'haul', scheduled_date: today, scheduled_time: '08:30', customer: 'County of Red Deer',
  material: 'Asphalt', quantity: '', unit: '', loads_planned: 4,
  from_location: 'Plant on Hwy 2', to_location: 'Twp Rd 384 patching crew',
  assignments: [{ driver_id: gary, truck_id: trucks.T3 }],
});
d.saveJob({
  job_type: 'float', scheduled_date: today, scheduled_time: '09:00', customer: 'Smith Excavating',
  material: 'CAT 320 excavator', from_location: 'Smith yard, 12 Industrial Way', to_location: 'Lot 7, Sylvan Lake',
  assignments: [{ driver_id: bill, truck_id: trucks.F1 }],
});
d.saveJob({
  job_type: 'septic', scheduled_date: today, scheduled_time: '10:00', customer: 'J. Larson',
  material: 'Residential tank pump-out', quantity: '1000', unit: 'gallons',
  from_location: '27123 Twp Rd 380', to_location: 'Lagoon disposal site',
  contact_name: 'Jan', contact_phone: '403-555-7788', notes: 'Lid is under the deck, dog in yard.',
  assignments: [{ driver_id: lyle, truck_id: trucks.S1 }],
});
console.log('Seeded 5 trucks, 5 drivers and 4 jobs for', today);
