const path = require('node:path');
const express = require('express');
const config = require('./config');
const { openDb } = require('./db');
const { createDispatch, ValidationError, nowHmIn } = require('./dispatch');
const { createBackups } = require('./backup');
const { need, needOwner, can, permissions } = require('./roles');
const { createDistance } = require('./distance');
const auth = require('./auth');
const sms = require('./sms');
const { renderDriverPage, renderNotFound } = require('./driverPage');
const { renderPrintPage, renderPrintBatch } = require('./printPage');
const { jobsToCsv } = require('./records');
const { runAs } = require('./actor');
const { CustomerError } = require('./customers');
const twilio = require('./twilio');
const { createIntake, validKey, IntakeError } = require('./intake');

/** Download a photo a driver texted in (MMS). Only Twilio's own media URLs are fetched. */
async function fetchTwilioMedia(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'api.twilio.com') throw new Error('Unexpected media URL');
  const { accountSid, authToken } = config.twilio;
  const res = await fetch(u, { headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') } });
  if (!res.ok) throw new Error(`Media download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: res.headers.get('content-type') || '' };
}

function sendImage(res, ticket) {
  if (!ticket || !ticket.data) return res.status(404).send('Not found');
  res.setHeader('Content-Type', ticket.content_type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.send(ticket.data);
}

/** Express 4 doesn't catch errors from async handlers; this passes them to the error handler. */
const h = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

function createApp({ db, dispatch, fetchMedia = fetchTwilioMedia, intakeKey = config.intakeKey, backups = null, distance = createDistance(db) }) {
  const intake = createIntake(db);
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Driver links carry their key in the URL, so they never send a referrer. Office pages send only the
    // site's origin, which Google Maps needs to check its key is used on this site.
    res.setHeader('Referrer-Policy', _req.path.startsWith('/j/') ? 'no-referrer' : 'strict-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const pub = path.join(__dirname, '..', 'public');
  app.get('/driver.css', (_req, res) => res.sendFile(path.join(pub, 'driver.css')));
  // Logo and browser-tab icons: public, so the login page and driver pages can show them.
  app.use('/brand', express.static(path.join(pub, 'brand'), { maxAge: '7d', fallthrough: false }));
  app.get('/favicon.ico', (_req, res) => res.sendFile(path.join(pub, 'brand', 'favicon.ico'), { maxAge: '7d' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true, db: db.kind }));

  // ---------- driver job page (the link in the text; the token is the key) ----------
  app.get('/j/:token', h(async (req, res) => {
    const a = await dispatch.assignmentByToken(req.params.token);
    if (!a) return res.status(404).send(renderNotFound());
    // Opening the link counts as "seen" but not as confirmed — they still tap Got it or text OK.
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderDriverPage(a, await dispatch.otherJobsForDriver(a.driver_id, a.id), await dispatch.ticketsForAssignment(a.id),
      { saved: req.query.saved === '1' }));
  }));

  // The driver's after-job report (septic conditions, notes) — a plain form post.
  app.post('/j/:token/report', h(async (req, res) => {
    try {
      await dispatch.saveReport(req.params.token, req.body || {}, 'web');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return res.status(400).send(`${err.message}. Go back and try again.`);
    }
    res.redirect(303, `/j/${encodeURIComponent(req.params.token)}?saved=1#report`);
  }));

  // Scale ticket photo from the job page. The page shrinks the photo first and posts the raw image.
  app.post('/j/:token/ticket', express.raw({ type: () => true, limit: '13mb' }), h(async (req, res) => {
    const a = await dispatch.assignmentByToken(req.params.token);
    if (!a) return res.status(404).json({ error: 'Job not found' });
    try {
      const t = await dispatch.saveTicket({ driverId: a.driver_id, assignment: a, buffer: req.body, contentType: req.get('content-type'), source: 'web' });
      res.json({ ok: true, id: t.id });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      res.status(400).json({ error: err.message });
    }
  }));

  app.get('/j/:token/ticket/:id', h(async (req, res) => {
    const a = await dispatch.assignmentByToken(req.params.token);
    const t = a && await dispatch.getTicket(req.params.id);
    sendImage(res, t && t.assignment_id === a.id ? t : null);
  }));

  app.post('/j/:token/:action', h(async (req, res) => {
    try {
      await dispatch.driverAction(req.params.token, req.params.action, 'web');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
    }
    res.redirect(303, `/j/${encodeURIComponent(req.params.token)}`);
  }));

  // ---------- inbound texts from Twilio ----------
  app.post('/sms/inbound', h(async (req, res) => {
    if (config.smsEnabled) {
      const url = config.publicUrl + req.originalUrl;
      if (!sms.validTwilioSignature(req.get('X-Twilio-Signature'), url, req.body || {})) {
        return res.status(403).send('Bad signature');
      }
    }
    // Photos texted in (scale tickets).
    const media = [];
    const count = Math.min(Number(req.body.NumMedia) || 0, 10);
    for (let i = 0; i < count; i++) {
      try {
        const m = await fetchMedia(req.body[`MediaUrl${i}`]);
        if (m.buffer.length) media.push(m);
      } catch (err) {
        console.error('Could not download texted photo:', err.message);
      }
    }
    const { reply } = await dispatch.handleInbound(req.body.From, req.body.Body, { media });
    res.type('text/xml').send(sms.twiml(reply));
  }));

  // ---------- orders from the website ----------
  // The website POSTs each order here with "Authorization: Bearer <INTAKE_KEY>". See docs/website-integration.md.
  const intakeAuth = (req, res, next) => {
    if (!intakeKey) return res.status(503).json({ error: 'Website intake is not set up (INTAKE_KEY missing)' });
    const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-intake-key');
    if (!validKey(given, intakeKey)) return res.status(401).json({ error: 'Bad intake key' });
    next();
  };
  app.post('/api/intake', intakeAuth, h(async (req, res) => {
    try {
      const { request, created } = await intake.receive(req.body);
      res.status(created ? 201 : 200).json({ ok: true, request_id: request.id, status: request.status });
    } catch (err) {
      if (!(err instanceof IntakeError)) throw err;
      res.status(400).json({ error: err.message });
    }
  }));
  app.get('/api/intake/:externalId', intakeAuth, h(async (req, res) => {
    const s = await intake.statusFor(req.params.externalId);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  }));

  // ---------- office ----------
  auth.authRoutes(app, db);
  app.use(auth.loadUser(db));
  // Everything an office user does is credited to them in the job history.
  app.use((req, _res, next) => (req.user ? runAs(req.user.name || req.user.email, next) : next()));
  app.get('/login', (_req, res) => res.sendFile(path.join(pub, 'login.html')));
  app.get('/login.css', (_req, res) => res.sendFile(path.join(pub, 'styles.css')));

  /** Records filters from the query string: from/to (default: this year so far), status, type, q. */
  const recordFilters = (query) => {
    const today = dispatch.today();
    const ymd = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : fallback);
    const from = ymd(query.from, `${today.slice(0, 4)}-01-01`);
    const to = ymd(query.to, today);
    if (from > to) throw new ValidationError('"From" must be before "To"');
    return { from, to, status: String(query.status || 'complete'), type: String(query.type || ''), q: String(query.q || '') };
  };

  const api = express.Router();
  api.use(auth.requireUser);
  const json = (fn) => h(async (req, res) => res.json(await fn(req)));

  api.get('/me', (req, res) => res.json({ user: req.user, can: permissions(req.user), smsEnabled: config.smsEnabled, today: dispatch.today(),
    maps: { key: config.maps.key, mapId: config.maps.mapId, yard: config.maps.yard, distance: Boolean(config.maps.serverKey) },
    owner_email: config.ownerEmail }));

  // ---------- price book ----------
  api.get('/prices', json(async () => ({
    items: await dispatch.prices.list({ includeInactive: true }),
    categories: dispatch.prices.categories,
    notes: dispatch.prices.categoryNotes,
    settings: await dispatch.prices.settings(),
  })));
  api.get('/prices/book', json(() => dispatch.prices.book()));
  api.get('/prices/changes', json(() => dispatch.prices.changes(200)));
  api.post('/prices', need('admin'), json((req) => dispatch.prices.save(req.body?.changes || [])));
  api.post('/prices/settings', need('admin'), json((req) => dispatch.prices.saveSettings(req.body || {})));
  // Driving distance from the starting point to an address or a dropped pin (for the delivery fee).
  api.post('/distance', json(async (req) => {
    const from = String(req.body?.from || '').trim() || (await dispatch.prices.settings()).start_address;
    return distance.measure({ from, address: req.body?.address, lat: req.body?.lat, lng: req.body?.lng });
  }));

  // ---------- customer questions (standard answers) ----------
  api.get('/faq', json(() => db.all('SELECT * FROM faq ORDER BY lower(topic), lower(question)')));
  const saveFaq = async (req) => {
    const question = String(req.body?.question || '').trim().slice(0, 500);
    const answer = String(req.body?.answer || '').trim().slice(0, 4000);
    const topic = String(req.body?.topic || '').trim().slice(0, 60);
    if (!question) throw new ValidationError('Type the question');
    if (req.params.id) {
      await db.run("UPDATE faq SET question = ?, answer = ?, topic = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
        question, answer, topic, req.user.name, Number(req.params.id));
      return db.get('SELECT * FROM faq WHERE id = ?', Number(req.params.id));
    }
    const r = await db.run('INSERT INTO faq (question, answer, topic, updated_by) VALUES (?, ?, ?, ?)', question, answer, topic, req.user.name);
    return db.get('SELECT * FROM faq WHERE id = ?', Number(r.lastInsertRowid));
  };
  api.post('/faq', need('admin'), json(saveFaq));
  api.put('/faq/:id', need('admin'), json(saveFaq));
  api.delete('/faq/:id', need('admin'), json(async (req) => {
    await db.run('DELETE FROM faq WHERE id = ?', Number(req.params.id));
    return { ok: true };
  }));

  // ---------- logins (owner only) ----------
  api.get('/users', needOwner, json(() => auth.listUsers(db)));
  api.post('/users', needOwner, json(async (req) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (await db.get('SELECT id FROM users WHERE email = ?', email)) throw new ValidationError('There is already a login for that email');
    const id = await auth.createUser(db, { email, name: b.name, password: b.password, role: b.role });
    return (await auth.listUsers(db)).find((u) => u.id === id);
  }));
  api.put('/users/:id', needOwner, json(async (req) => {
    const b = req.body || {};
    if (Number(req.params.id) === req.user.id && (b.role && b.role !== 'admin' || b.active === false)) {
      throw new ValidationError('You can\'t take away your own admin access');
    }
    return auth.updateUser(db, req.params.id, { name: b.name, role: b.role, password: b.password || '', active: b.active });
  }));
  api.delete('/users/:id', needOwner, json(async (req) => {
    if (Number(req.params.id) === req.user.id) throw new ValidationError('You can\'t remove your own login');
    await auth.deleteUser(db, req.params.id);
    return { ok: true };
  }));

  // ---------- map ----------
  api.post('/geocodes/lookup', h(async (req, res) => res.json(await dispatch.geo.lookup(req.body.addresses))));
  api.post('/geocodes', h(async (req, res) => res.json({ ok: await dispatch.geo.remember(req.body.address, req.body.lat, req.body.lng) })));
  api.post('/jobs/:id/location', h(async (req, res) => {
    res.json(await dispatch.setJobLocation(req.params.id, req.body.lat, req.body.lng, { manual: req.body.manual === true }));
  }));
  api.get('/board', json(async (req) => ({
    ...(await dispatch.board(String(req.query.date || dispatch.today()))),
    new_requests: await intake.countNew(),
  })));
  api.get('/requests', json((req) => intake.list({ status: String(req.query.status || 'open') })));
  api.get('/requests/:id/prefill', h(async (req, res) => {
    const p = await intake.prefill(req.params.id, dispatch.today());
    if (!p) return res.status(404).json({ error: 'Not found' });
    // Known customer? Link them and bring in their site notes (gate codes, dog in yard…).
    const match = p.customer_phone ? (await dispatch.customers.search(p.customer_phone, 1))[0] : null;
    if (match) {
      p.customer_id = match.id;
      for (const k of ['billing_address', 'customer_email']) if (!p[k]) p[k] = k === 'customer_email' ? match.email : match.billing_address;
      if (match.notes) p.notes = [p.notes, `Customer notes: ${match.notes}`].filter(Boolean).join('. ');
    }
    res.json(p);
  }));
  api.post('/requests/:id/status', json((req) => intake.setStatus(req.params.id, req.body?.status, req.user.id)));
  api.get('/jobs', json((req) => {
    const from = String(req.query.from || dispatch.today());
    return dispatch.listJobs({ from, to: String(req.query.to || from) });
  }));
  api.get('/jobs/:id', h(async (req, res) => {
    const job = await dispatch.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(job);
  }));
  // Office logins save work orders but don't assign or text drivers (that's dispatch).
  const officeSafe = async (req, id) => {
    if (can(req.user, 'dispatcher')) return req.body;
    const current = id ? await dispatch.getJob(id) : null;
    return { ...req.body, send_now: false,
      assignments: current ? current.assignments.map((a) => ({ driver_id: a.driver_id, truck_id: a.truck_id })) : [] };
  };
  api.post('/jobs', json(async (req) => {
    req.body = await officeSafe(req, null);
    let { job } = await dispatch.saveJob({ ...req.body, id: null }, req.user.id);
    // Scheduled from a website request: link the two.
    if (req.body.request_id) {
      await intake.link(req.body.request_id, job.id, req.user.id);
      await dispatch.logHistory(job.id, 'Booked from a website order', `Website request #${req.body.request_id}`);
      job = await dispatch.getJob(job.id);
    }
    return req.body.send_now ? dispatch.sendJob(job.id) : { job, results: [] };
  }));
  api.put('/jobs/:id', json(async (req) => {
    req.body = await officeSafe(req, req.params.id);
    const { job, removed } = await dispatch.saveJob({ ...req.body, id: req.params.id }, req.user.id);
    await dispatch.notifyRemoved(job, removed);
    return req.body.send_now ? dispatch.sendJob(job.id) : { job, results: [] };
  }));
  api.post('/jobs/:id/send', need('dispatcher'), json((req) => dispatch.sendJob(req.params.id, { assignmentId: req.body?.assignment_id || null })));
  api.post('/jobs/:id/cancel', need('dispatcher'), json((req) => dispatch.cancelJob(req.params.id)));
  api.post('/jobs/:id/status', need('dispatcher'), json((req) => dispatch.setJobStatus(req.params.id, req.body.status)));
  api.post('/jobs/:id/pickup', json((req) => dispatch.bookPickup(req.params.id, req.body?.date, req.user.id)));
  api.post('/jobs/:id/move', json((req) => dispatch.moveJob(req.params.id, req.body?.date)));
  api.post('/jobs/:id/duplicate', json((req) => dispatch.duplicateJob(req.params.id, req.body.date, req.user.id)));
  api.delete('/jobs/:id', need('dispatcher'), h(async (req, res) => {
    const job = await dispatch.getJob(req.params.id);
    if (job && job.assignments.some((a) => a.status !== 'pending')) {
      return res.status(400).json({ error: 'Drivers were already texted. Cancel the job instead so they get told.' });
    }
    await dispatch.deleteJob(req.params.id);
    res.json({ ok: true });
  }));
  api.get('/tickets/:id/image', h(async (req, res) => sendImage(res, await dispatch.getTicket(req.params.id))));
  api.post('/tickets/:id/attach', need('dispatcher'), json(async (req) => {
    const t = await dispatch.attachTicket(req.params.id, req.body.job_id);
    return { ...t, data: undefined };
  }));
  api.delete('/tickets/:id', need('dispatcher'), json(async (req) => {
    await dispatch.deleteTicket(req.params.id);
    return { ok: true };
  }));
  api.get('/settings', json(() => dispatch.getSettings()));
  // Backups: status, run one now, or download a copy of the whole database (photos stay in the backup store).
  api.get('/backups', need('admin'), json(() => (backups ? backups.status() : { target: 'off', label: 'Backups are off', runs: [] })));
  api.post('/backups/run', need('admin'), h(async (_req, res) => {
    if (!backups) return res.status(400).json({ error: 'Backups are off' });
    res.json(await backups.run({ reason: 'by hand' }));
  }));
  api.get('/backups/download', need('admin'), h(async (_req, res) => {
    const buf = await (backups || createBackups(db, { storage: null, today: dispatch.today })).download();
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="adams-dispatch-backup-${dispatch.today()}.json.gz"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  }));
  api.post('/settings', need('admin'), json((req) => dispatch.saveSettings(req.body || {})));
  // Text every driver their whole day for a date (the "tomorrow's jobs" text, sent by hand).
  api.post('/lineup/send', need('dispatcher'), json((req) => {
    const date = String(req.body?.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('Pick a date');
    return dispatch.sendLineup(date);
  }));
  // Office can set a driver's status by hand (e.g. driver phoned in).
  api.post('/assignments/:token/:action', need('dispatcher'), json(async (req) => {
    const a = await dispatch.driverAction(req.params.token, req.params.action, 'office');
    return { ...a, job: undefined };
  }));

  // Records: find past work orders, download a spreadsheet, print / save as PDF (tax season).
  api.get('/records', need('dispatcher'), json(async (req) => {
    const f = recordFilters(req.query);
    const jobs = await dispatch.findJobs({ ...f, limit: 501 });
    return { ...f, truncated: jobs.length > 500, jobs: jobs.slice(0, 500) };
  }));
  api.get('/records.csv', need('dispatcher'), h(async (req, res) => {
    const f = recordFilters(req.query);
    const jobs = await dispatch.findJobs(f);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="adams-bros-work-orders-${f.from}-to-${f.to}.csv"`);
    res.send(jobsToCsv(jobs));
  }));
  // Customer address book and septic reminders.
  api.get('/customers', json((req) => dispatch.customers.list({ q: String(req.query.q || '') })));
  api.get('/customers/search', json((req) => dispatch.customers.search(String(req.query.q || ''), 8)));
  api.get('/customers/due', json(async () => dispatch.customers.septicDue({ years: Number((await dispatch.getSettings()).septic_reminder_years) || 2 })));
  api.get('/customers/:id', h(async (req, res) => {
    const c = await dispatch.customers.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json({ customer: c, jobs: await dispatch.customers.jobsFor(c.id) });
  }));
  api.post('/customers', json((req) => dispatch.customers.save(req.body || {})));
  api.post('/customers/:id/contacted', json((req) => dispatch.customers.markContacted(req.params.id, req.body?.note)));
  api.get('/customers/:id/septic-prefill', json((req) => dispatch.customers.septicPrefill(req.params.id)));
  api.get('/jobs/:id/history', json((req) => dispatch.historyFor(req.params.id)));
  api.get('/drivers', json((req) => dispatch.listDrivers({ includeInactive: req.query.all === '1' })));
  api.post('/drivers', need('admin'), json((req) => dispatch.saveDriver(req.body)));
  api.get('/trucks', json((req) => dispatch.listTrucks({ includeInactive: req.query.all === '1' })));
  api.post('/trucks', need('admin'), json((req) => dispatch.saveTruck(req.body)));
  api.get('/suggestions', json(() => dispatch.suggestions()));
  api.get('/messages', need('dispatcher'), json(() => dispatch.listMessages({ limit: 200 })));
  api.post('/messages/seen', need('dispatcher'), json(async (req) => {
    await dispatch.markMessagesSeen(req.body.ids);
    return { ok: true };
  }));
  // Texting setup (Setup tab).
  api.get('/sms/status', need('admin'), json(() => twilio.checkSetup()));
  api.post('/sms/connect', need('admin'), json(() => {
    if (!config.smsEnabled) throw new ValidationError('Add the Twilio settings to .env first');
    return twilio.connectWebhook();
  }));
  api.post('/sms/test', need('admin'), json(async (req) => {
    const to = sms.normalizePhone(req.body?.phone);
    if (!to) throw new ValidationError('Enter a 10-digit cell number');
    const r = await sms.sendSms(to, `${config.companyName} dispatch: test text. Reply OK to check replies reach the office.`);
    return { ok: true, simulated: Boolean(r.simulated) };
  }));
  // Try a driver reply without a real phone (only when texting isn't hooked up yet).
  api.post('/simulate-reply', need('dispatcher'), json((req) => {
    if (config.smsEnabled) throw new ValidationError('Texting is live; reply from a real phone.');
    return dispatch.handleInbound(req.body.phone, req.body.body);
  }));
  app.use('/api', api);

  app.get('/', auth.requireUser, (_req, res) => res.sendFile(path.join(pub, 'index.html')));
  // Many work orders at once, one per page (Records tab → Print / Save as PDF).
  app.get('/print/records', auth.requireUser, need('dispatcher'), h(async (req, res) => {
    const f = recordFilters(req.query);
    res.send(renderPrintBatch(await dispatch.findJobs(f), f));
  }));
  // Printable work order, laid out like the paper forms.
  app.get('/print/:id', auth.requireUser, h(async (req, res) => {
    const job = await dispatch.getJob(req.params.id);
    if (!job) return res.status(404).send('Job not found');
    res.send(renderPrintPage(job));
  }));
  app.use(auth.requireUser, express.static(pub, { index: false }));

  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status === 500) console.error(err);
    if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
    res.status(status).send(status === 500 ? 'Something went wrong' : err.message);
  });

  return app;
}

async function main() {
  // Replit's built-in PostgreSQL sets DATABASE_URL; without it, a local SQLite file is used.
  const db = await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : config.dbPath);
  console.log(db.kind === 'pg' ? 'Database: PostgreSQL (DATABASE_URL)' : `Database: SQLite file ${config.dbPath}`);
  await auth.ensureAdmin(db);
  const dispatch = createDispatch(db);
  const priced = await dispatch.prices.seed();
  if (priced) console.log(`Price book: loaded ${priced} prices from the price sheets.`);
  const linked = await dispatch.customers.backfill();
  if (linked) console.log(`Address book: linked ${linked} earlier job(s) to customers.`);
  // DEMO_DATA=true: fill an empty database with sample jobs (for showing the app off).
  if (process.env.DEMO_DATA === 'true' && await require('./demo').seedDemo(dispatch)) console.log('Loaded demo data.');
  const backups = createBackups(db, {
    today: dispatch.today,
    nowHm: () => nowHmIn(),
    readPhoto: async (id) => (await dispatch.getTicket(id))?.data || null,
  });
  console.log(backups.storage ? `Nightly backups: ${backups.storage.label}` : 'Nightly backups are OFF (BACKUP_TARGET=off)');
  createApp({ db, dispatch, backups }).listen(config.port, () => {
    console.log(`Dispatch running on ${config.publicUrl} (port ${config.port}), time zone ${config.timeZone}`);
    if (!config.smsEnabled) console.log('Texting is NOT configured — texts will be printed here instead of sent.');
  });
  // Evening "tomorrow's jobs" text: checked every minute against the time set on the Setup tab.
  setInterval(() => {
    dispatch.runScheduledLineup()
      .then((out) => out && console.log(`Sent lineup for ${out.date} to ${out.results.length} driver(s)`))
      .catch((err) => console.error('Lineup send failed:', err));
    // Nightly backup, after 2 AM.
    backups.runScheduled()
      .then((out) => {
        if (!out) return;
        console.log(out.ok ? `Backup saved: ${out.name} (${out.bytes} bytes, ${out.photos} new photo(s))` : `Backup FAILED: ${out.error}`);
        if (out.ok) dispatch.geo.prune().catch(() => {});
      })
      .catch((err) => console.error('Backup failed:', err));
  }, 60 * 1000);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Could not start:', err);
    process.exit(1);
  });
}

module.exports = { createApp };
