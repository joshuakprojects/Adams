const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const { createSites, parseNeeds, describeNeeds, nextWorkDay } = require('../src/sites');

test('reading what a site head texts', () => {
  const kinds = ['Excavator', 'Mini excavator', 'Loader'];
  const n = parseNeeds('tandem AM, mini ex and 2 labourers', kinds);
  assert.deepEqual(n.trucks, [{ type: 'Tandem', count: 1, slot: 'am' }]);
  assert.deepEqual(n.equipment, [{ kind: 'Mini excavator', slot: '' }]);
  assert.equal(n.labourers, 2);
  assert.equal(describeNeeds(n), 'Tandem (AM), Mini excavator, 2 labourers');
  assert.deepEqual(parseNeeds('2 triaxles first thing, the loader, float to move the ex friday', kinds).trucks.map((t) => [t.type, t.count]),
    [['Triaxle', 2], ['Float', 1]]);
  assert.match(parseNeeds('2 triaxles first thing, the loader, float to move the ex friday', kinds).note, /float to move the ex friday/);
  assert.equal(parseNeeds('Nothing', kinds).nothing, true);
  assert.equal(parseNeeds('same', kinds).same, true);
  assert.equal(parseNeeds('need someone to fix the pump', kinds).note, 'need someone to fix the pump');
  assert.equal(nextWorkDay('2026-11-13'), '2026-11-16', 'Friday asks about Monday');
  assert.equal(nextWorkDay('2026-11-12'), '2026-11-13');
});

async function setup(t) {
  const db = await testDb(t);
  const sent = [];
  const send = async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; };
  const d = createDispatch(db, { send, today: () => '2026-11-13' });
  const sites = createSites(db, d, { send, today: () => '2026-11-13', nowHm: () => '14:45' });
  await sites.ensureSetup();
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  const sam = await d.saveDriver({ name: 'Sam Lee', phone: '705-555-0102', kind: 'labourer' });
  const t4 = await d.saveTruck({ unit: 'T4', kind: 'haul' });
  const mike = await sites.saveHead({ name: 'Mike Rivers', phone: '705-555-0200' });
  const seguin = await sites.saveSite({ name: 'Seguin', address: '12 Lake Rd, Seguin', head_id: mike.id });
  const carling = await sites.saveSite({ name: 'Carling', address: '4 Bay St, Carling', head_id: mike.id });
  return { db, d, sites, sent, send, dave, sam, t4, mike, seguin, carling };
}

test('site heads are texted about the next working day and answer by text', async (t) => {
  const { sites, sent, seguin } = await setup(t);
  assert.equal((await sites.listEquipment()).length, 7, 'placeholder machines to start with');
  const out = await sites.ask('2026-11-16', { siteIds: [seguin.id] });
  assert.equal(out.results[0].ok, true);
  assert.equal(sent[0].to, '+17055550200');
  assert.match(sent[0].body, /^Hi Mike - what do you need at Seguin on Mon Nov 16\?/);
  assert.match(sent[0].body, /\/s\/[\w-]+$/);

  const r = await sites.handleReply('+17055550200', 'Tandem AM, mini ex and 2 labourers');
  assert.match(r.reply, /got it for Seguin on Mon Nov 16: Tandem \(AM\), Mini excavator, 2 labourers/);
  const b = await sites.board('2026-11-16');
  const row = b.sites.find((s) => s.site.id === seguin.id);
  assert.equal(row.day.status, 'replied');
  assert.equal(row.day.reply_via, 'text');
  assert.equal(row.asked, 'Tandem (AM), Mini excavator, 2 labourers');
  assert.equal(await sites.handleReply('+17055550999', 'hello'), null, 'not a site head: left to the driver handling');
});

test('handing out a truck, a labourer and a machine makes an "Our site" work order; moving a machine offers the float', async (t) => {
  const { d, sites, sent, dave, sam, t4, seguin, carling } = await setup(t);
  const [ex] = await sites.listEquipment();
  // Friday: the excavator is at Carling.
  await sites.give(carling.id, '2026-11-13', { equipment: [ex.id] });
  // Monday: Seguin gets T4 with Dave, Sam, and the same excavator.
  const b = await sites.give(seguin.id, '2026-11-16', { trucks: [{ truck_id: t4.id, driver_id: dave.id }], labourers: [sam.id], equipment: [ex.id], note: 'Bring the laser' });
  const row = b.sites.find((s) => s.site.id === seguin.id);
  const job = await d.getJob(row.job_id);
  assert.equal(job.job_type, 'site');
  assert.equal(job.site_id, seguin.id);
  assert.equal(job.to_location, '12 Lake Rd, Seguin');
  assert.equal(job.contact_name, 'Mike Rivers');
  assert.deepEqual(job.assignments.map((a) => a.driver_name).sort(), ['Dave Thompson', 'Sam Lee']);
  assert.equal(row.given.trucks[0].truck_unit, 'T4');
  assert.equal(row.given.labourers[0].driver_name, 'Sam Lee');
  assert.equal(row.given.equipment[0].needs_float, true);
  assert.equal(row.given.equipment[0].from, 'Carling');
  // The truck shows as busy at our site (not a customer) that day.
  assert.deepEqual(b.trucks.find((x) => x.id === t4.id).use.map((u) => [u.own, u.label]), [[true, 'Seguin']]);

  // The excavator isn't at Seguin yet: saving made its float work order.
  assert.equal(b.floats.made.length, 1);
  const float = b.floats.made[0];
  assert.equal(float.job_type, 'float');
  assert.equal(float.from_location, '4 Bay St, Carling');
  assert.equal(float.to_location, '12 Lake Rd, Seguin');
  const after = (await sites.board('2026-11-16')).sites.find((s) => s.site.id === seguin.id);
  assert.equal(after.given.equipment[0].float_job_id, float.id);
  // Saving again doesn't make a second float; taking the machine off removes it (nobody texted yet).
  assert.equal((await sites.give(seguin.id, '2026-11-16', { trucks: [{ truck_id: t4.id, driver_id: dave.id }], labourers: [sam.id], equipment: [ex.id], note: 'Bring the laser' })).floats.made.length, 0);
  const off = await sites.give(seguin.id, '2026-11-16', { trucks: [{ truck_id: t4.id, driver_id: dave.id }], labourers: [sam.id], note: 'Bring the laser' });
  assert.deepEqual(off.floats.dropped, [float.id]);
  assert.equal(await d.getJob(float.id), null);
  await sites.give(seguin.id, '2026-11-16', { trucks: [{ truck_id: t4.id, driver_id: dave.id }], labourers: [sam.id], equipment: [ex.id], note: 'Bring the laser' });

  sent.length = 0;
  await sites.confirm('2026-11-16', { siteIds: [seguin.id] });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /for Seguin on Mon Nov 16 you have: T4 with Dave Thompson, Excavator 1 \(floated from Carling\), Sam Lee\. Note: Bring the laser/);
});

test('"same" copies the last working day; the scheduled text goes once a working day; the link page saves a request', async (t) => {
  const { db, d, sites, sent, seguin, mike } = await setup(t);
  await sites.saveRequest(seguin.id, '2026-11-13', { text: '2 tandems' });
  await sites.ask('2026-11-16', { siteIds: [seguin.id] });
  await sites.handleReply(mike.phone, 'same');
  const row = (await sites.board('2026-11-16')).sites.find((s) => s.site.id === seguin.id);
  assert.equal(row.asked, '2 × Tandem');

  sent.length = 0;
  assert.equal(await sites.runScheduledAsk(), null, 'off until a time is set');
  await sites.saveAskTime('14:30');
  const out = await sites.runScheduledAsk();
  assert.equal(out.day, '2026-11-16', 'Friday afternoon asks about Monday');
  assert.equal(sent.length, 2, 'both active sites');
  assert.equal(await sites.runScheduledAsk(), null, 'once a day');

  // The link: a phone form.
  await createUser(db, { email: 'josh@adamsbros.ca', name: 'Josh', password: 'password123', role: 'admin' });
  const server = createApp({ db, dispatch: d, sites }).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const page = await (await fetch(`${base}/s/${seguin.token}`)).text();
  assert.match(page, /What do you need on <b>Mon Nov 16<\/b>/);
  const post = await fetch(`${base}/s/${seguin.token}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'truck:Triaxle': '1', 'machine:Loader': '1', labourers: '1', slot: 'am', note: 'call me' }).toString() });
  assert.equal(post.status, 303);
  const day = (await sites.board('2026-11-16')).sites.find((s) => s.site.id === seguin.id).day;
  assert.equal(day.reply_via, 'link');
  assert.equal(describeNeeds(day.request), 'Triaxle (AM), Loader (AM), 1 labourer, call me');
  assert.equal((await fetch(`${base}/s/nope`)).status, 404);
});

test('hauling: material and loads from the text, the link and the office; confirmations text the crew too', async (t) => {
  const { db, d, sites, sent, dave, t4, seguin, mike } = await setup(t);
  await d.prices.seed();
  await sites.ask('2026-11-16', { siteIds: [seguin.id] });
  const r = await sites.handleReply(mike.phone, 'tandem of A gravel AM, 4 loads');
  assert.match(r.reply, /Tandem \(AM\) – A Gravel 3\/4", 4 loads/);
  const b = await sites.give(seguin.id, '2026-11-16', { trucks: [{ truck_id: t4.id, driver_id: dave.id, material: 'A Gravel 3/4"', loads: 4 }] });
  const row = b.sites.find((s) => s.site.id === seguin.id);
  assert.equal(row.given.trucks[0].material, 'A Gravel 3/4"');
  assert.equal(Number(row.given.trucks[0].loads), 4);
  const job = await d.getJob(row.job_id);
  assert.equal(job.details.hauling, 'T4: A Gravel 3/4", 4 loads');
  sent.length = 0;
  await sites.confirm('2026-11-16', { siteIds: [seguin.id] });
  assert.deepEqual(sent.map((m) => m.to), [mike.phone], 'only the site head: drivers are told the morning of');
  assert.match(sent[0].body, /T4 with Dave Thompson \(A Gravel 3\/4", 4 loads\)/);

  // The morning text: at the set time, each driver gets that day's jobs, the site job included.
  const morning = createDispatch(db, { send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; }, today: () => '2026-11-16', nowHm: () => '06:35' });
  await morning.saveSettings({ lineup_time: '06:30', lineup_when: 'morning' });
  sent.length = 0;
  const out = await morning.runScheduledLineup();
  assert.equal(out.date, '2026-11-16', "today's jobs, not tomorrow's");
  const daveText = sent.find((m) => m.to === '+17055550101');
  assert.match(daveText.body, /Your load: A Gravel 3\/4", 4 loads/);
  assert.doesNotMatch(daveText.body, /Equipment:|Hauling:/, 'the dump truck driver sees only his own load');
  assert.equal(await morning.runScheduledLineup(), null, 'once a morning');
  void db;
});

test('machines stay on a site until moved: the card shows since when and from where; back to the yard books the float', async (t) => {
  const { sites, seguin, carling } = await setup(t);
  const [ex] = await sites.listEquipment();
  await sites.give(carling.id, '2026-11-11', { equipment: [ex.id] });           // Wed: given to Carling
  let b = await sites.board('2026-11-13');                                         // Fri: still there, not re-given
  let row = b.sites.find((s) => s.site.id === carling.id);
  assert.deepEqual(row.on_site.map((m) => [m.name, m.since, m.days, m.from]), [['Excavator 1', '2026-11-11', 2, '']]);
  assert.equal(b.equipment.find((e) => e.id === ex.id).at, 'Carling');

  await sites.bookFloat(seguin.id, '2026-11-16', ex.id);                          // Mon: floated to Seguin
  b = await sites.board('2026-11-17');
  row = b.sites.find((s) => s.site.id === seguin.id);
  assert.deepEqual(row.on_site.map((m) => [m.since, m.how, m.from]), [['2026-11-16', 'float', 'Carling']]);
  assert.equal(b.sites.find((s) => s.site.id === carling.id).on_site.length, 0);

  const back = await sites.backToYard(seguin.id, '2026-11-18', ex.id);            // Wed: back to the yard
  assert.equal(back.job_type, 'float');
  assert.equal(back.from_location, '12 Lake Rd, Seguin');
  b = await sites.board('2026-11-18');
  assert.equal(b.sites.find((s) => s.site.id === seguin.id).on_site.length, 0);
  assert.equal(b.equipment.find((e) => e.id === ex.id).site_id, null, 'in the yard');
});

test('a backup can put back just the Our sites data, leaving everything else as it is now', async (t) => {
  const { db, d, sites, dave, t4, seguin } = await setup(t);
  const { dump, restoreSites } = require('../src/backup');
  const [ex] = await sites.listEquipment();
  const b0 = await sites.give(seguin.id, '2026-11-16', { trucks: [{ truck_id: t4.id, driver_id: dave.id }], equipment: [ex.id] });
  const siteJob = b0.sites.find((s) => s.site.id === seguin.id).job_id;
  const backup = await dump(db);
  // What a Replit publish did: the site tables emptied (dropped and re-made), jobs.site_id gone.
  for (const n of ['equipment_moves', 'job_equipment', 'site_days', 'equipment', 'sites', 'site_heads']) await db.run(`DELETE FROM ${n}`);
  await db.run('UPDATE jobs SET site_id = NULL');
  const later = (await d.saveJob({ job_type: 'misc', scheduled_date: '2026-11-17', material: 'Made after the backup', assignments: [] })).job;

  const out = await restoreSites(db, backup);
  assert.equal(out.counts.sites, 2);
  assert.equal(out.counts.site_heads, 1);
  assert.equal((await sites.listSites()).length, 2);
  assert.equal((await d.getJob(siteJob)).site_id, seguin.id, 'site work orders linked again');
  assert.ok(await d.getJob(later.id), 'work made after the backup is kept');
  const row = (await sites.board('2026-11-16')).sites.find((s) => s.site.id === seguin.id);
  assert.equal(row.given.equipment[0].id, ex.id);
  // New ids keep counting from the restored ones.
  const s3 = await sites.saveSite({ name: 'Third' });
  assert.ok(s3.id > seguin.id);
});
