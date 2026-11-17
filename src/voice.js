/**
 * A natural voice for the snow call (ElevenLabs text-to-speech) instead of the phone system's computer voice.
 *
 * Record once, use forever: every line is recorded once and kept in the database (voice_clips). The usual lines
 * (the greeting, "Press 1…", the start times 3:00 to 8:00 AM, the usual place) are recorded with one button;
 * after that the calls need no ElevenLabs key at all. A new place or a one-off note is recorded the first time
 * (when a key is set) and kept too; without a key, just that part is read by the phone system's voice.
 *
 * ELEVENLABS_API_KEY (in the Secrets) is only needed while recording. The voice is picked on the Snow call screen.
 */
const crypto = require('node:crypto');

const API = 'https://api.elevenlabs.io/v1';
const MODEL = 'eleven_multilingual_v2';

class VoiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** "4 AM", "4:30 AM". */
function sayTime(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The lines a snow call says, in parts (each part is its own recording, so the common ones are reused). */
const PHRASES = {
  intro: 'Adams Bros snow call.',
  start: (hm) => `Start at ${sayTime(hm)}.`,
  place: (place) => `Report to ${place}.`,
  note: (note) => (/[.!?]$/.test(note) ? note : `${note}.`),
  press: "Press 1 if you are coming. Press 2 if you can't.",
  coming: 'Thank you. See you there.',
  not_coming: 'Thank you. We will let the office know.',
  no_answer: 'We did not get an answer. We will try again soon.',
  cancelled: 'The Adams Bros snow call was cancelled. Thank you.',
};
/** Start times recorded by "Record the usual lines": 3:00 to 8:00 AM, every 15 minutes. */
const USUAL_TIMES = Array.from({ length: 21 }, (_, i) => { const t = 180 + i * 15; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; });

function createVoice(db, { key = process.env.ELEVENLABS_API_KEY || '', fetchImpl = (...a) => fetch(...a) } = {}) {
  const configured = Boolean(key);
  const getSetting = async (k, fallback = '') => (await db.get('SELECT value FROM settings WHERE key = ?', k))?.value ?? fallback;
  const setSetting = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));

  async function call(path, opts = {}) {
    if (!configured) throw new VoiceError('Add ELEVENLABS_API_KEY to the Secrets to record in an ElevenLabs voice.');
    const res = await fetchImpl(`${API}${path}`, { ...opts, headers: { 'xi-api-key': key, ...(opts.headers || {}) } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.detail?.message || body.detail || `HTTP ${res.status}`;
      throw new VoiceError(`ElevenLabs: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status === 401 ? 401 : 502);
    }
    return res;
  }

  /** The voices on the account: [{ voice_id, name, preview_url, about }]. */
  async function voices() {
    const body = await (await call('/voices')).json();
    return (body.voices || []).map((v) => ({
      voice_id: v.voice_id, name: v.name, preview_url: v.preview_url || '',
      about: [v.labels?.gender, v.labels?.accent, v.labels?.age, v.labels?.description || v.labels?.descriptive].filter(Boolean).join(', '),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function chosen() {
    return { voice_id: await getSetting('snow_voice_id', ''), voice_name: await getSetting('snow_voice_name', '') };
  }
  async function choose(voiceId, name = '') {
    await setSetting('snow_voice_id', String(voiceId || '').slice(0, 64));
    await setSetting('snow_voice_name', String(name || '').slice(0, 80));
    return chosen();
  }

  /** Speech for `text` as an MP3 (Buffer), straight from ElevenLabs (used for "Hear our call"). */
  async function speak(text, voiceId = null) {
    const id = voiceId || (await chosen()).voice_id;
    if (!id) throw new VoiceError('Pick a voice first');
    const res = await call(`/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_22050_32`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: String(text).slice(0, 600), model_id: MODEL, voice_settings: { stability: 0.6, similarity_boost: 0.8 } }),
    });
    return Buffer.from(await res.arrayBuffer());
  }

  // ---------- recorded lines (kept forever) ----------
  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  /** The recording of `text` in the chosen voice: { id } if it's kept, else null. */
  async function clip(text) {
    const { voice_id } = await chosen();
    if (!voice_id) return null;
    return (await db.get('SELECT id FROM voice_clips WHERE voice_id = ? AND text = ?', voice_id, norm(text))) || null;
  }
  /** Make sure `text` is recorded in the chosen voice (records it when a key is set). Returns the clip, or null. */
  async function ensure(text) {
    const have = await clip(text);
    if (have || !configured) return have;
    const { voice_id } = await chosen();
    if (!voice_id) return null;
    const data = await speak(norm(text), voice_id);
    const id = crypto.randomBytes(9).toString('base64url');
    await db.run('INSERT INTO voice_clips (id, voice_id, text, data) VALUES (?, ?, ?, ?) ON CONFLICT (voice_id, text) DO NOTHING', id, voice_id, norm(text), data);
    return clip(text);
  }
  async function clipData(id) {
    const row = await db.get('SELECT data FROM voice_clips WHERE id = ?', String(id || ''));
    return row ? Buffer.from(row.data) : null;
  }
  /** The usual lines: greeting, prompts, thank-yous, the start times 3:00 to 8:00 AM, and the places given. */
  function usualLines(places = []) {
    const fixed = Object.values(PHRASES).filter((p) => typeof p === 'string');
    return [...fixed, ...USUAL_TIMES.map(PHRASES.start), ...places.filter(Boolean).map(PHRASES.place)];
  }
  async function recordUsual(places = []) {
    if (!(await chosen()).voice_id) throw new VoiceError('Pick a voice first');
    let made = 0;
    let chars = 0;
    for (const line of usualLines(places)) {
      if (await clip(line)) continue;
      await ensure(line);
      made++;
      chars += line.length;
    }
    return { made, chars, ...(await library(places)) };
  }
  /** How many of the usual lines are recorded in the chosen voice. */
  async function library(places = []) {
    const lines = usualLines(places);
    const { voice_id } = await chosen();
    const kept = voice_id ? (await db.all('SELECT text FROM voice_clips WHERE voice_id = ?', voice_id)).map((r) => r.text) : [];
    const have = new Set(kept);
    return { usual: lines.length, recorded: lines.filter((l) => have.has(norm(l))).length, kept: kept.length };
  }

  return { configured, voices, chosen, choose, speak, clip, ensure, clipData, recordUsual, library, usualLines };
}

module.exports = { createVoice, VoiceError, PHRASES, USUAL_TIMES, sayTime };
