const path = require('node:path');
const express = require('express');
const config = require('./config');
const { openDb } = require('./db');
const { createDispatch, ValidationError } = require('./dispatch');
const auth = require('./auth');
const sms = require('./sms');
const { renderDriverPage, renderNotFound } = require('./driverPage');

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
  if (!ticket) return res.status(404).send('Not found');
  res.setHeader('Content-Type', ticket.content_type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.sendFile(ticket.path, (err) => { if (err && !res.headersSent) res.status(404).send('Not found'); });
}

function createApp({ db, dispatch, fetchMedia = fetchTwilioMedia }) {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const pub = path.join(__dirname, '..', 'public');
  app.get('/driver.css', (_req, res) => res.sendFile(path.join(pub, 'driver.css')));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ---------- driver job page (the link in the text; the token is the key) ----------
  app.get('/j/:token', (req, res) => {
    const a = dispatch.assignmentByToken(req.params.token);
    if (!a) return res.status(404).send(renderNotFound());
    // Opening the link counts as "seen" but not as confirmed — they still tap Got it or text OK.
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderDriverPage(a, dispatch.otherJobsForDriver(a.driver_id, a.id), dispatch.ticketsForAssignment(a.id)));
  });

  // Scale ticket photo from the job page. The page shrinks the photo first and posts the raw image.
  app.post('/j/:token/ticket', express.raw({ type: () => true, limit: '13mb' }), (req, res) => {
    const a = dispatch.assignmentByToken(req.params.token);
    if (!a) return res.status(404).json({ error: 'Job not found' });
    try {
      const t = dispatch.saveTicket({ driverId: a.driver_id, assignment: a, buffer: req.body, contentType: req.get('content-type'), source: 'web' });
      res.json({ ok: true, id: t.id });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/j/:token/ticket/:id', (req, res) => {
    const a = dispatch.assignmentByToken(req.params.token);
    const t = a && dispatch.getTicket(req.params.id);
    sendImage(res, t && t.assignment_id === a.id ? t : null);
  });

  app.post('/j/:token/:action', (req, res) => {
    try {
      dispatch.driverAction(req.params.token, req.params.action, 'web');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
    }
    res.redirect(303, `/j/${encodeURIComponent(req.params.token)}`);
  });

  // ---------- inbound texts from Twilio ----------
  app.post('/sms/inbound', async (req, res, next) => {
    try {
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
      const { reply } = dispatch.handleInbound(req.body.From, req.body.Body, { media });
      res.type('text/xml').send(sms.twiml(reply));
    } catch (err) {
      next(err);
    }
  });

  // ---------- office ----------
  auth.authRoutes(app, db);
  app.use(auth.loadUser(db));
  app.get('/login', (_req, res) => res.sendFile(path.join(pub, 'login.html')));
  app.get('/login.css', (_req, res) => res.sendFile(path.join(pub, 'styles.css')));

  const api = express.Router();
  api.use(auth.requireUser);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  api.get('/me', (req, res) => res.json({ user: req.user, smsEnabled: config.smsEnabled, today: dispatch.today() }));
  api.get('/board', (req, res) => res.json(dispatch.board(String(req.query.date || dispatch.today()))));
  api.get('/jobs', (req, res) => {
    const from = String(req.query.from || dispatch.today());
    res.json(dispatch.listJobs({ from, to: String(req.query.to || from) }));
  });
  api.get('/jobs/:id', (req, res) => {
    const job = dispatch.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(job);
  });
  api.post('/jobs', wrap(async (req, res) => {
    const { job, removed } = dispatch.saveJob({ ...req.body, id: null }, req.user.id);
    const out = req.body.send_now ? await dispatch.sendJob(job.id) : { job, results: [] };
    res.json(out);
  }));
  api.put('/jobs/:id', wrap(async (req, res) => {
    const { job, removed } = dispatch.saveJob({ ...req.body, id: req.params.id }, req.user.id);
    await dispatch.notifyRemoved(job, removed);
    const out = req.body.send_now ? await dispatch.sendJob(job.id) : { job, results: [] };
    res.json(out);
  }));
  api.post('/jobs/:id/send', wrap(async (req, res) => {
    res.json(await dispatch.sendJob(req.params.id, { assignmentId: req.body?.assignment_id || null }));
  }));
  api.post('/jobs/:id/cancel', wrap(async (req, res) => res.json(await dispatch.cancelJob(req.params.id))));
  api.post('/jobs/:id/status', (req, res) => res.json(dispatch.setJobStatus(req.params.id, req.body.status)));
  api.post('/jobs/:id/duplicate', (req, res) => res.json(dispatch.duplicateJob(req.params.id, req.body.date, req.user.id)));
  api.delete('/jobs/:id', (req, res) => {
    const job = dispatch.getJob(req.params.id);
    if (job && job.assignments.some((a) => a.status !== 'pending')) {
      return res.status(400).json({ error: 'Drivers were already texted. Cancel the job instead so they get told.' });
    }
    dispatch.deleteJob(req.params.id);
    res.json({ ok: true });
  });
  api.get('/tickets/:id/image', (req, res) => sendImage(res, dispatch.getTicket(req.params.id)));
  api.post('/tickets/:id/attach', (req, res) => res.json(dispatch.attachTicket(req.params.id, req.body.job_id)));
  api.delete('/tickets/:id', (req, res) => {
    dispatch.deleteTicket(req.params.id);
    res.json({ ok: true });
  });
  api.get('/settings', (_req, res) => res.json(dispatch.getSettings()));
  api.post('/settings', (req, res) => res.json(dispatch.saveSettings(req.body || {})));
  // Text every driver their whole day for a date (the "tomorrow's jobs" text, sent by hand).
  api.post('/lineup/send', wrap(async (req, res) => {
    const date = String(req.body?.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('Pick a date');
    res.json(await dispatch.sendLineup(date));
  }));
  // Office can set a driver's status by hand (e.g. driver phoned in).
  api.post('/assignments/:token/:action', (req, res) => res.json(dispatch.driverAction(req.params.token, req.params.action, 'office')));

  api.get('/drivers', (req, res) => res.json(dispatch.listDrivers({ includeInactive: req.query.all === '1' })));
  api.post('/drivers', (req, res) => res.json(dispatch.saveDriver(req.body)));
  api.get('/trucks', (req, res) => res.json(dispatch.listTrucks({ includeInactive: req.query.all === '1' })));
  api.post('/trucks', (req, res) => res.json(dispatch.saveTruck(req.body)));
  api.get('/suggestions', (_req, res) => res.json(dispatch.suggestions()));
  api.get('/messages', (_req, res) => res.json(dispatch.listMessages({ limit: 200 })));
  api.post('/messages/seen', (req, res) => {
    dispatch.markMessagesSeen(req.body.ids);
    res.json({ ok: true });
  });
  // Try a driver reply without a real phone (only when texting isn't hooked up yet).
  api.post('/simulate-reply', (req, res) => {
    if (config.smsEnabled) return res.status(400).json({ error: 'Texting is live; reply from a real phone.' });
    res.json(dispatch.handleInbound(req.body.phone, req.body.body));
  });
  app.use('/api', api);

  app.get('/', auth.requireUser, (_req, res) => res.sendFile(path.join(pub, 'index.html')));
  app.use(auth.requireUser, express.static(pub, { index: false }));

  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
    res.status(status).send(status === 500 ? 'Something went wrong' : err.message);
  });

  return app;
}

if (require.main === module) {
  const db = openDb(config.dbPath);
  auth.ensureAdmin(db);
  const dispatch = createDispatch(db);
  createApp({ db, dispatch }).listen(config.port, () => {
    console.log(`Dispatch running on ${config.publicUrl} (port ${config.port}), time zone ${config.timeZone}`);
    if (!config.smsEnabled) console.log('Texting is NOT configured — texts will be printed here instead of sent.');
  });
  // Evening "tomorrow's jobs" text: checked every minute against the time set on the Setup tab.
  setInterval(() => {
    dispatch.runScheduledLineup()
      .then((out) => out && console.log(`Sent lineup for ${out.date} to ${out.results.length} driver(s)`))
      .catch((err) => console.error('Lineup send failed:', err));
  }, 60 * 1000);
}

module.exports = { createApp };
