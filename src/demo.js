// Sample trucks, drivers and one job of each work order type, so the board isn't empty in a demo.
// Names and phone numbers are made up (555 numbers never receive texts).
const { addDays } = require('./dispatch');

/** Fill an empty database with sample data. Returns false if there are already drivers. */
async function seedDemo(d) {
  if ((await d.listDrivers()).length) return false;
  const today = d.today();
  const trucks = {};
  for (const [unit, kind, description] of [
    ['T1', 'haul', 'Tri-axle dump'], ['T2', 'haul', 'Tandem dump'], ['F1', 'float', 'Float / lowbed'],
    ['S1', 'septic', 'Vac truck'], ['B1', 'bin', 'Roll-off bin truck'], ['P1', 'toilet', 'Toilet service truck'],
  ]) trucks[unit] = (await d.saveTruck({ unit, kind, description })).id;

  const drv = async (name, phone, truck) => (await d.saveDriver({ name, phone, default_truck_id: trucks[truck] })).id;
  const dave = await drv('Dave Thompson', '705-555-0101', 'T1');
  const ron = await drv('Ron Kowalski', '705-555-0102', 'T2');
  const bill = await drv('Bill Henderson', '705-555-0104', 'F1');
  const lyle = await drv('Lyle Peterson', '705-555-0105', 'S1');
  const gary = await drv('Gary Mitchell', '705-555-0103', 'B1');
  const pete = await drv('Pete Lalonde', '705-555-0106', 'P1');

  await d.saveJob({
    job_type: 'haul', scheduled_date: today, time_slot: 'am', customer: 'Northshore Builders', customer_phone: '705-555-2001',
    material: '2" minus', loads_planned: 20, details: { truck: 'Triaxle', aggregate2_type: '6" minus', aggregate2_loads: '4', aggregate2_truck: 'Tandem' },
    from_location: 'Adams pit', to_location: '1200 Lake Rd', municipality: 'Ahmic Harbour',
    contact_name: 'Mike', contact_phone: '705-555-1234', notes: 'Dump at back of lot, by the garage pad.', quoted_price: 'Per load', payment_method: 'On account',
    assignments: [{ driver_id: dave, truck_id: trucks.T1 }, { driver_id: ron, truck_id: trucks.T2 }],
  });
  await d.saveJob({
    job_type: 'float', scheduled_date: today, time_slot: 'am', customer: 'Northshore Builders',
    material: '15 ton zero turn (smooth bucket)', from_location: 'Adams yard, 116 William St', to_location: '1200 Lake Rd', municipality: 'Ahmic Harbour',
    assignments: [{ driver_id: bill, truck_id: trucks.F1 }],
  });
  await d.saveJob({
    job_type: 'septic', scheduled_date: today, time_slot: 'am', customer: 'J. Larson', customer_phone: '705-555-7788',
    billing_address: 'PO Box 12, Parry Sound ON', to_location: '45 Bay Rd', municipality: 'McDougall',
    quoted_price: '$395', payment_method: 'Cash',
    details: { tank_size: '1000 gal', tank_type: 'Septic', lids_uncovered: 'No', hose_length: '100 ft', steep_driveway: 'Yes',
      back_in: 'Yes', tank_location: 'Under the deck, left side of the cottage', directions: 'Second driveway past the marina, green mailbox.' },
    notes: 'Dog in yard.',
    assignments: [{ driver_id: lyle, truck_id: trucks.S1 }],
  });
  await d.saveJob({
    job_type: 'bin', scheduled_date: today, time_slot: 'am', customer: 'K. Morris', customer_phone: '705-555-3344',
    material: '20 yd', to_location: '88 Seguin Trail', municipality: 'Seguin', quoted_price: '$450', payment_method: 'Visa/MC',
    details: { service: 'Deliver bin' }, notes: 'Place on the gravel pad, not the lawn.',
    assignments: [{ driver_id: gary, truck_id: trucks.B1 }],
  });
  await d.saveJob({
    job_type: 'toilet', scheduled_date: today, time_slot: 'pm', customer: 'Carling Community Centre', customer_phone: '705-555-9090',
    po_number: 'CC-2231', to_location: '2 Community Way', municipality: 'Carling', quoted_price: '$180 / week', payment_method: 'Cheque',
    details: { trip: 'Deliver', pickup_date: addDays(today, 14), toilet1_type: 'Standard', toilet1_qty: '2',
      toilet2_type: 'Wheelchair accessible', toilet2_qty: '1', placement: 'Beside the pavilion, on the level spot', extra_servicing: 'Weekly pump-out' },
    assignments: [{ driver_id: pete, truck_id: trucks.P1 }],
  });
  await d.saveJob({
    job_type: 'haul', scheduled_date: addDays(today, 1), time_slot: 'first', customer: 'R. McDougall', material: 'Sand fill', loads_planned: 1,
    details: { truck: 'Tandem' }, quoted_price: 'Quoted', payment_method: 'Visa/MC',
    from_location: 'Adams pit', to_location: '310 Hwy 124', municipality: 'McDougall',
    assignments: [{ driver_id: dave, truck_id: trucks.T1 }],
  });
  await d.saveJob({
    job_type: 'haul', scheduled_date: today, time_slot: 'first', customer: 'Bayview Excavating', customer_phone: '705-555-4411',
    material: 'Fill', details: { direction: 'Haul away from site', until_stop: 'Yes', truck: 'Triaxle' },
    to_location: '10 Mountain Basin Rd', municipality: 'McDougall', from_location: 'Adams pit',
    contact_name: 'Site foreman', contact_phone: '705-555-4412', notes: 'Foreman will tell you when to stop.',
    assignments: [{ driver_id: ron, truck_id: trucks.T2 }],
  });
  return true;
}

module.exports = { seedDemo };
