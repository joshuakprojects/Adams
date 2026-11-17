/**
 * A natural voice for the snow call (ElevenLabs text-to-speech) instead of the phone system's computer voice.
 *
 * Needs ELEVENLABS_API_KEY in the Secrets. The voice is picked on the Snow call screen (from the voices on that
 * ElevenLabs account). Each call-out's words are turned into speech once, when it starts; every call plays that
 * recording. Without a key, or if ElevenLabs can't be reached, calls use Twilio's own (neural) voice instead.
 */
const API = 'https://api.elevenlabs.io/v1';
const MODEL = 'eleven_multilingual_v2';

class VoiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function createVoice(db, { key = process.env.ELEVENLABS_API_KEY || '', fetchImpl = (...a) => fetch(...a) } = {}) {
  const configured = Boolean(key);
  const getSetting = async (k, fallback = '') => (await db.get('SELECT value FROM settings WHERE key = ?', k))?.value ?? fallback;
  const setSetting = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));

  async function call(path, opts = {}) {
    if (!configured) throw new VoiceError('Add ELEVENLABS_API_KEY to the Secrets to use an ElevenLabs voice.');
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

  /** Speech for `text` as an MP3 (Buffer), in the chosen voice (or `voiceId`). */
  async function speak(text, voiceId = null) {
    const id = voiceId || (await chosen()).voice_id;
    if (!id) throw new VoiceError('Pick a voice first');
    const res = await call(`/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_22050_32`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: String(text).slice(0, 600), model_id: MODEL, voice_settings: { stability: 0.6, similarity_boost: 0.8 } }),
    });
    return Buffer.from(await res.arrayBuffer());
  }

  /** Is a voice ready to use for calls? */
  async function ready() { return configured && Boolean((await chosen()).voice_id); }

  return { configured, voices, chosen, choose, speak, ready };
}

module.exports = { createVoice, VoiceError };
