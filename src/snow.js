/**
 * Snow call-outs: the overnight person presses one button and every shoveler is phoned (and texted) at their own
 * call-ahead time before the start, e.g. start 4:00 AM → Bob (60 min ahead) is called at 3:00, Sue (30 min) at 3:30.
 *
 * The call is a computer voice through Twilio: "Adams Bros snow call. Start at 4 AM at the yard. Press 1 if you're
 * coming, 2 if you can't." Pressing a key (or texting back 1 / 2) marks them coming or not. No answer: called again
 * 5 minutes later, up to 3 calls. Each person also gets a text with the details. When everyone is done, the
 * results are texted to the numbers given when the call-out started.
 *
 * Without Twilio set up (test mode) calls are only written to the log, and the screen can mark the answers by hand.
 */
const crypto = require('node:crypto');
const config = require('./config');
const sms = require('./sms');

const RETRY_MINUTES = 5;
const MAX_CALLS = 3;
const parseJson = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const fromSql = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

class SnowError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** "2026-12-03" + "04:00" in the given time zone → a Date (UTC instant). */
function zonedTime(day, hm, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    guess += Date.UTC(y, m - 1, d, hh, mm) - shown;
  }
  return new Date(guess);
}

/** "4 AM", "4:30 AM" (how the voice and the text say the start time). */
function sayTime(hm) {
  const [h, m] = hm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function createSnow(db, {
  send = sms.sendSms, now = () => new Date(), timeZone = config.timeZone, publicUrl = config.publicUrl,
  twilio = config.twilio, voiceFrom = process.env.TWILIO_VOICE_FROM || config.twilio.fromNumber,
  fetchImpl = (...a) => fetch(...a), live = config.smsEnabled && config.smsProvider === 'twilio',
} = {}) {
  let active = null; // null = not known yet; false = no call-out running (minute checks then ask the database nothing)

  // ---------- shovelers ----------
  async function listShovelers({ all = false } = {}) {
    return db.all(`SELECT * FROM shovelers ${all ? '' : 'WHERE active = 1'} ORDER BY call_ahead_min DESC, name`);
  }
  async function saveShoveler(input) {
    const name = String(input.name || '').trim().slice(0, 80);
    const phone = sms.normalizePhone(input.phone);
    if (!name) throw new SnowError('Enter a name');
    if (!phone) throw new SnowError('Enter a cell number, e.g. 705-555-0123');
    const ahead = Math.round(Number(input.call_ahead_min));
    if (!(ahead >= 0 && ahead <= 240)) throw new SnowError('Call-ahead time must be 0 to 240 minutes');
    const activeFlag = input.active === undefined ? 1 : input.active ? 1 : 0;
    if (input.id) {
      await db.run('UPDATE shovelers SET name = ?, phone = ?, call_ahead_min = ?, active = ? WHERE id = ?', name, phone, ahead, activeFlag, Number(input.id));
      return db.get('SELECT * FROM shovelers WHERE id = ?', Number(input.id));
    }
    const r = await db.run('INSERT INTO shovelers (name, phone, call_ahead_min, active) VALUES (?, ?, ?, ?)', name, phone, ahead, activeFlag);
    return db.get('SELECT * FROM shovelers WHERE id = ?', Number(r.lastInsertRowid));
  }

  // ---------- starting a call-out ----------
  /** { day, time, place, note, mode: 'ahead' | 'now', notify: [phones] } */
  async function start(input, userName = '') {
    if (await current()) throw new SnowError('A snow call is already running. Finish or cancel it first.');
    const day = String(input.day || '');
    const time = String(input.time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new SnowError('Pick the start date and time');
    const startAt = zonedTime(day, time, timeZone);
    if (startAt.getTime() < now().getTime() - 60 * 60e3) throw new SnowError('That start time has already passed');
    const place = String(input.place || '').trim().slice(0, 120) || 'the yard';
    const note = String(input.note || '').trim().slice(0, 160);
    const mode = input.mode === 'now' ? 'now' : 'ahead';
    const notify = [...new Set((Array.isArray(input.notify) ? input.notify : String(input.notify || '').split(/[\n,;]+/)).map(sms.normalizePhone).filter(Boolean))].slice(0, 5);
    const people = await listShovelers();
    if (!people.length) throw new SnowError('Add the shovelers first (their name, cell and call-ahead time)');
    const r = await db.run(`INSERT INTO snow_calls (day, start_time, start_at, place, note, mode, notify, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`, day, time, sqlTime(startAt), place, note, mode, JSON.stringify(notify), String(userName).slice(0, 80));
    const callId = Number(r.lastInsertRowid);
    for (const p of people) {
      const due = mode === 'now' ? now() : new Date(Math.max(now().getTime(), startAt.getTime() - p.call_ahead_min * 60e3));
      await db.run(`INSERT INTO snow_call_people (call_id, shoveler_id, name, phone, due_at, token) VALUES (?, ?, ?, ?, ?, ?)`,
        callId, p.id, p.name, p.phone, sqlTime(due), crypto.randomBytes(12).toString('base64url'));
    }
    active = true;
    await tick();
    return get(callId);
  }

  async function current() {
    const row = await db.get("SELECT id FROM snow_calls WHERE status = 'running' ORDER BY id DESC LIMIT 1");
    active = Boolean(row);
    return row ? get(row.id) : null;
  }

  async function get(id) {
    const c = await db.get('SELECT * FROM snow_calls WHERE id = ?', Number(id));
    if (!c) return null;
    c.notify = parseJson(c.notify, []);
    c.people = await db.all('SELECT id, shoveler_id, name, phone, due_at, status, attempts, last_attempt_at, answered_at, via FROM snow_call_people WHERE call_id = ? ORDER BY due_at, name', c.id);
    c.counts = { coming: 0, not_coming: 0, no_answer: 0, waiting: 0, calling: 0, cancelled: 0, failed: 0 };
    for (const p of c.people) c.counts[p.status] = (c.counts[p.status] || 0) + 1;
    c.say = sayTime(c.start_time);
    c.live = live;
    return c;
  }
  async function recent(limit = 5) {
    return db.all('SELECT id, day, start_time, place, status, created_at FROM snow_calls ORDER BY id DESC LIMIT ?', limit);
  }

  // ---------- calling ----------
  const message = (c) => `Adams Bros snow call. Start at ${sayTime(c.start_time)} at ${c.place}.${c.note ? ' ' + c.note + '.' : ''}`;

  async function placeCall(person, call) {
    const token = person.token;
    if (!live) {
      console.log(`[Snow call not live — would phone ${person.phone} (${person.name}): ${message(call)} Press 1 / 2]`);
      return { sid: 'local-' + crypto.randomBytes(4).toString('hex') };
    }
    const base = publicUrl.replace(/\/$/, '');
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: person.phone, From: voiceFrom, Url: `${base}/voice/snow/${token}`, Method: 'POST', Timeout: '30',
        StatusCallback: `${base}/voice/snow/${token}/status`, StatusCallbackMethod: 'POST' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Twilio error ${res.status}`);
    return { sid: data.sid };
  }

  /** Called every minute (and right after starting): phone whoever is due, retry no-answers, finish when done. */
  async function tick() {
    if (active === false) return null;
    const c = await current();
    if (!c) return null;
    const call = await db.get('SELECT * FROM snow_calls WHERE id = ?', c.id);
    const t = now();
    const due = await db.all(`SELECT * FROM snow_call_people WHERE call_id = ? AND status IN ('waiting', 'no_answer_retry') AND due_at <= ?`, c.id, sqlTime(t));
    for (const p of due) {
      const attempts = p.attempts + 1;
      try {
        const out = await placeCall(p, call);
        await db.run(`UPDATE snow_call_people SET status = 'calling', attempts = ?, last_call_sid = ?, last_attempt_at = ? WHERE id = ?`, attempts, out.sid, sqlTime(t), p.id);
      } catch (err) {
        await db.run(`UPDATE snow_call_people SET status = ?, attempts = ?, last_attempt_at = ?, due_at = ? WHERE id = ?`,
          attempts >= MAX_CALLS ? 'failed' : 'no_answer_retry', attempts, sqlTime(t), sqlTime(new Date(t.getTime() + RETRY_MINUTES * 60e3)), p.id);
        console.error(`Snow call to ${p.name} failed:`, err.message);
      }
      // The text goes with the first call: the details in writing, and a way to answer without picking up.
      if (attempts === 1) {
        await send(p.phone, `ADAMS BROS SNOW CALL: start ${sayTime(call.start_time)} at ${call.place}.${call.note ? ' ' + call.note + '.' : ''} Reply 1 if you're coming, 2 if you can't.`)
          .catch((err) => console.error(`Snow call text to ${p.name} failed:`, err.message));
      }
    }
    // A call still "calling" after 3 minutes with no answer from Twilio: treat as no answer.
    const stuck = await db.all(`SELECT * FROM snow_call_people WHERE call_id = ? AND status = 'calling' AND last_attempt_at <= ?`, c.id, sqlTime(new Date(t.getTime() - 3 * 60e3)));
    for (const p of stuck) await noAnswer(p);
    return finishIfDone(c.id);
  }

  async function noAnswer(p) {
    const t = now();
    if (p.attempts >= MAX_CALLS) await db.run(`UPDATE snow_call_people SET status = 'no_answer' WHERE id = ?`, p.id);
    else await db.run(`UPDATE snow_call_people SET status = 'no_answer_retry', due_at = ? WHERE id = ?`, sqlTime(new Date(t.getTime() + RETRY_MINUTES * 60e3)), p.id);
  }

  async function finishIfDone(callId) {
    const open = await db.get(`SELECT COUNT(*) AS n FROM snow_call_people WHERE call_id = ? AND status IN ('waiting', 'calling', 'no_answer_retry')`, callId);
    if (Number(open.n)) return null;
    const c = await get(callId);
    if (c.status !== 'running') return null;
    await db.run(`UPDATE snow_calls SET status = 'done', finished_at = ? WHERE id = ?`, sqlTime(now()), callId);
    active = false;
    const names = (s) => c.people.filter((p) => p.status === s).map((p) => p.name);
    const body = `ADAMS BROS SNOW CALL ${sayTime(c.start_time)}: ${c.counts.coming} coming${names('coming').length ? ` (${names('coming').join(', ')})` : ''}.`
      + (names('not_coming').length ? ` Can't: ${names('not_coming').join(', ')}.` : '')
      + ([...names('no_answer'), ...names('failed')].length ? ` No answer: ${[...names('no_answer'), ...names('failed')].join(', ')}.` : '');
    for (const p of c.notify) await send(p, body).catch(() => {});
    return { done: true, body };
  }

  // ---------- answers ----------
  async function personByToken(token) {
    return db.get('SELECT * FROM snow_call_people WHERE token = ?', String(token || ''));
  }
  async function answer(personId, choice, via) {
    const status = choice === 'coming' ? 'coming' : 'not_coming';
    await db.run('UPDATE snow_call_people SET status = ?, answered_at = ?, via = ? WHERE id = ?', status, sqlTime(now()), via, personId);
    const p = await db.get('SELECT call_id FROM snow_call_people WHERE id = ?', personId);
    await finishIfDone(p.call_id);
    return status;
  }

  /** TwiML for the call (Twilio asks when the person picks up). */
  async function voiceTwiml(token) {
    const p = await personByToken(token);
    if (!p) return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
    const call = await db.get('SELECT * FROM snow_calls WHERE id = ?', p.call_id);
    if (call.status === 'cancelled') return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">The Adams Bros snow call was cancelled. Thank you.</Say></Response>`;
    const say = `${xml(message(call))} Press 1 if you are coming. Press 2 if you can't.`;
    const action = `/voice/snow/${xml(token)}/answer`;
    return '<?xml version="1.0" encoding="UTF-8"?><Response>'
      + `<Gather numDigits="1" timeout="8" action="${action}" method="POST"><Say voice="Polly.Joanna">${say}</Say></Gather>`
      + `<Gather numDigits="1" timeout="8" action="${action}" method="POST"><Say voice="Polly.Joanna">Again. ${say}</Say></Gather>`
      + '<Say voice="Polly.Joanna">We did not get an answer. We will try again soon.</Say></Response>';
  }
  async function voiceAnswer(token, digits) {
    const p = await personByToken(token);
    if (!p) return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
    const call = await db.get('SELECT * FROM snow_calls WHERE id = ?', p.call_id);
    if (digits === '1' || digits === '2') {
      await answer(p.id, digits === '1' ? 'coming' : 'not_coming', 'call');
      const thanks = digits === '1' ? `Thank you. See you at ${sayTime(call.start_time)} at ${call.place}.` : 'Thank you. We will let the office know.';
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${xml(thanks)}</Say></Response>`;
    }
    return voiceTwiml(token);
  }
  /** Twilio's call status: busy / no answer / failed with no key pressed → try again later. */
  async function voiceStatus(token, status) {
    const p = await personByToken(token);
    if (!p || p.status !== 'calling') return;
    if (['busy', 'no-answer', 'failed', 'canceled', 'completed'].includes(status)) await noAnswer(p);
    await finishIfDone(p.call_id);
  }

  /** A text from a shoveler during a running call-out: "1" / "yes" = coming, "2" / "no" = can't. Null if it isn't one. */
  async function handleReply(phone, body) {
    if (active === false) return null;
    const p = await db.get(`SELECT p.* FROM snow_call_people p JOIN snow_calls c ON c.id = p.call_id
      WHERE c.status = 'running' AND p.phone = ? ORDER BY p.id DESC LIMIT 1`, phone);
    if (!p) return null;
    const t = String(body || '').trim().toLowerCase();
    const choice = /^(1|y|yes|ok|coming|on my way|omw)\b/.test(t) ? 'coming' : /^(2|n|no|can'?t|cannot|sick)\b/.test(t) ? 'not_coming' : null;
    if (!choice) return { reply: 'Snow call: reply 1 if you are coming, 2 if you can\'t.' };
    await answer(p.id, choice, 'text');
    const call = await db.get('SELECT * FROM snow_calls WHERE id = ?', p.call_id);
    return { reply: choice === 'coming' ? `Thanks ${p.name.split(' ')[0]}, see you at ${sayTime(call.start_time)}.` : 'Thanks, the office has been told.' };
  }

  // ---------- from the screen ----------
  async function act(personId, what) {
    const p = await db.get('SELECT * FROM snow_call_people WHERE id = ?', Number(personId));
    if (!p) throw new SnowError('Not found', 404);
    if (what === 'coming' || what === 'not_coming') await answer(p.id, what, 'office');
    else if (what === 'call_now') {
      await db.run(`UPDATE snow_call_people SET status = 'waiting', due_at = ? WHERE id = ?`, sqlTime(now()), p.id);
      active = true;
      await tick();
    } else throw new SnowError('Unknown action');
    return get(p.call_id);
  }
  async function cancel(callId) {
    await db.run(`UPDATE snow_calls SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'`, sqlTime(now()), Number(callId));
    await db.run(`UPDATE snow_call_people SET status = 'cancelled' WHERE call_id = ? AND status IN ('waiting', 'no_answer_retry')`, Number(callId));
    active = false;
    return get(callId);
  }

  return { listShovelers, saveShoveler, start, current, get, recent, tick, voiceTwiml, voiceAnswer, voiceStatus, handleReply, act, cancel, sayTime };
}

module.exports = { createSnow, zonedTime, sayTime, SnowError };
