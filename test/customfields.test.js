const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_ACCOUNT_SID = '';
const { testDb } = require('./helpers');
const { createDispatch } = require('../src/dispatch');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/server');
const FORMS = require('../public/forms');

async function app(t) {
  const db = await testDb(t);
  const sent = [];
  const d = createDispatch(db, { send: async (to, body) => { sent.push({ to, body }); return { sid: 'x' }; }, today: () => '2026-11-10' });
  await d.loadCustomFields();
  const dave = await d.saveDriver({ name: 'Dave Thompson', phone: '705-555-0101' });
  await createUser(db, { email: 'josh@adamsbros.ca', name: 'Josh', password: 'password123', role: 'admin' });
  await createUser(db, { email: 'office@adamsbros.ca', name: 'Front', password: 'password123', role: 'office' });
  const server = createApp({ db, dispatch: d }).listen(0);
  t.after(() => { server.close(); FORMS.setCustomFields({}); });
  const base = `http://localhost:${server.address().port}`;
  const as = async (email) => {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const api = async (method, p, body) => {
      const r = await fetch(base + '/api' + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { api, cookie };
  };
  return { db, d, dave, sent, base, admin: await as('josh@adamsbros.ca'), office: await as('office@adamsbros.ca') };
}

const FIELDS = {
  haul: [
    { label: 'Gate code', kind: 'text', by: 'office', sms: true, reception: true },
    { label: 'Dog on site', kind: 'yesno', by: 'office', sms: true, reception: false },
    { label: 'Road condition', kind: 'choice', options: 'Good, Soft, Washed out', by: 'driver' },
  ],
};

test('admins add work order fields; office logins cannot; bad ones are refused', async (t) => {
  const { admin, office } = await app(t);
  assert.equal((await office.api('POST', '/settings', { custom_fields: FIELDS })).status, 403);
  const saved = (await admin.api('POST', '/settings', { custom_fields: FIELDS })).body.custom_fields;
  assert.deepEqual(saved.haul.map((f) => f.key), ['x_gate_code', 'x_dog_on_site', 'x_road_condition']);
  assert.deepEqual(saved.haul[2].options, ['Good', 'Soft', 'Washed out']);
  assert.equal(saved.haul[2].reception, false, 'driver fields are never on reception');
  // Everyone logged in sees them (reception needs them), and the form for haul now has them.
  assert.equal((await office.api('GET', '/me')).body.custom_fields.haul.length, 3);
  assert.ok(FORMS.typeInfo('haul').fields.some((f) => f.key === 'x_gate_code'));
  assert.ok(FORMS.typeInfo('haul').report.some((f) => f.key === 'x_road_condition'));
  assert.ok(FORMS.requirable('haul').some((r) => r.key === 'd.x_gate_code'), 'can be made required');

  for (const [bad, msg] of [
    [{ haul: [{ label: '' }] }, /needs a name/],
    [{ haul: [{ label: 'Colour', kind: 'choice', options: 'Red' }] }, /at least two/],
    [{ haul: [{ label: 'A', key: 'x_a' }, { label: 'B', key: 'x_a' }] }, /listed twice/],
  ]) {
    const r = await admin.api('POST', '/settings', { custom_fields: bad });
    assert.equal(r.status, 400);
    assert.match(r.body.error, msg);
  }
  // Renaming keeps the key, so old answers stay attached.
  const renamed = (await admin.api('POST', '/settings', { custom_fields: { haul: [{ ...saved.haul[0], label: 'Gate / lock code' }, saved.haul[1], saved.haul[2]] } })).body.custom_fields;
  assert.equal(renamed.haul[0].key, 'x_gate_code');
  assert.equal(renamed.haul[0].label, 'Gate / lock code');
});

test('fields reach the text, the driver page and the print; removing one keeps old answers', async (t) => {
  const { d, dave, base, admin, sent } = await app(t);
  const saved = (await admin.api('POST', '/settings', { custom_fields: FIELDS })).body.custom_fields;
  const job = (await admin.api('POST', '/jobs', { job_type: 'haul', scheduled_date: '2026-11-20', customer: 'Jane', customer_phone: '705-555-0199',
    to_location: '12 Bay St', material: 'Gravel', details: { x_gate_code: '4321', x_dog_on_site: 'Yes' }, assignments: [{ driver_id: dave.id }] })).body.job;
  assert.equal(job.details.x_gate_code, '4321');
  await admin.api('POST', `/jobs/${job.id}/send`, {});
  assert.match(sent.at(-1).body, /Gate code: 4321/);
  assert.match(sent.at(-1).body, /Dog on site: Yes/);

  const token = job.assignments[0].token;
  let page = await (await fetch(`${base}/j/${token}`)).text();
  assert.match(page, /Road condition/);
  await d.saveReport(token, { x_road_condition: 'Soft' });
  let print = await (await fetch(`${base}/print/${job.id}`, { headers: { cookie: admin.cookie } })).text();
  assert.match(print, /Gate code/);
  assert.match(print, /4321/);
  assert.match(print, /opt on">SOFT/);

  // Remove the gate code and the road condition (leaving them out of the list does the same as switching them off).
  const off = (await admin.api('POST', '/settings', { custom_fields: { haul: [saved.haul[1]] } })).body.custom_fields;
  assert.deepEqual(off.haul.map((f) => [f.key, f.active]), [['x_dog_on_site', true], ['x_gate_code', false], ['x_road_condition', false]]);
  assert.ok(!FORMS.requirable('haul').some((r) => r.key === 'd.x_gate_code'));

  // Saving the job again from a form that no longer has the field keeps its value.
  const again = (await admin.api('PUT', `/jobs/${job.id}`, { ...job, details: { x_dog_on_site: 'No' } })).body.job;
  assert.equal(again.details.x_gate_code, '4321');
  assert.equal(again.details.x_dog_on_site, 'No');
  await admin.api('POST', `/jobs/${job.id}/send`, {});
  assert.doesNotMatch(sent.at(-1).body, /Gate code/, 'removed fields are not texted');
  page = await (await fetch(`${base}/j/${token}`)).text();
  assert.doesNotMatch(page, /Road condition/, 'drivers no longer get asked');
  await d.saveReport(token, { notes: 'all good' });
  print = await (await fetch(`${base}/print/${job.id}`, { headers: { cookie: admin.cookie } })).text();
  assert.match(print, /4321/, 'old answers still print');
  assert.match(print, /opt on">SOFT/, 'old driver answers still print');

  // Putting it back brings the same field back.
  const back = (await admin.api('POST', '/settings', { custom_fields: { haul: off.haul.map((f) => ({ ...f, active: true })) } })).body.custom_fields;
  assert.ok(back.haul.every((f) => f.active));
  assert.equal(new Set(back.haul.map((f) => f.key)).size, 3);
});

test('fields survive a restart (loaded from settings)', async (t) => {
  const { db, admin } = await app(t);
  await admin.api('POST', '/settings', { custom_fields: FIELDS });
  FORMS.setCustomFields({});
  assert.ok(!FORMS.typeInfo('haul').fields.some((f) => f.custom));
  await createDispatch(db).loadCustomFields();
  assert.ok(FORMS.typeInfo('haul').fields.some((f) => f.key === 'x_gate_code'));
});
