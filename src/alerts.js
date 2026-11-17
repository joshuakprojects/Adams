/**
 * Alerts: tell the office (by text, to the numbers set in Setup) when something has gone wrong in the background:
 * texts failing, a backup failing, QuickBooks not syncing, an error in the app, or the app having been down.
 *
 * Every alert is kept (Setup shows the latest). The same kind of alert is texted at most once an hour,
 * so a problem that keeps happening doesn't flood anyone's phone.
 */
const sms = require('./sms');

const KINDS = {
  sms: 'Texts not sending',
  backup: 'Backup failed',
  qbo: 'QuickBooks not syncing',
  error: 'Error in the app',
  down: 'App was down',
  task: 'Scheduled text failed',
  test: 'Test alert',
};

function parsePhones(value) {
  let list = value;
  if (typeof value === 'string') {
    try { list = JSON.parse(value); } catch { list = null; }
    if (!Array.isArray(list)) list = value.split(/[\n,;]+/);
  }
  return [...new Set((Array.isArray(list) ? list : []).map((p) => sms.normalizePhone(p)).filter(Boolean))].slice(0, 10);
}

function createAlerts(db, { send = sms.sendSms, now = () => new Date(), throttleMinutes = 60, listen = true } = {}) {
  let sending = false; // an alert text that fails must not raise another alert

  const getSetting = async (key, fallback = '') => (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value ?? fallback;
  const setSetting = (key, value) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

  async function phones() { return parsePhones(await getSetting('alert_phones', '[]')); }

  /** Record an alert and text it (unless the same kind was texted within the hour). */
  async function raise(kind, message, { force = false } = {}) {
    const text = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const to = await phones();
    const since = sqlTime(new Date(now().getTime() - throttleMinutes * 60e3));
    const recent = force ? null : await db.get("SELECT id FROM alerts WHERE kind = ? AND texted != '' AND at >= ? LIMIT 1", kind, since);
    let texted = '';
    if (to.length && !recent) {
      sending = true;
      try {
        const body = `ADAMS BROS DISPATCH ALERT - ${KINDS[kind] || kind}: ${text}`;
        const ok = [];
        for (const p of to) { try { await send(p, body); ok.push(p); } catch { /* keep trying the others */ } }
        texted = ok.join(',');
      } finally { sending = false; }
    }
    await db.run('INSERT INTO alerts (kind, message, texted, at) VALUES (?, ?, ?, ?)', kind, text, texted, sqlTime(now()));
    console.error(`ALERT (${kind}): ${text}${texted ? ' — texted ' + texted : ''}`);
    return { texted: texted ? texted.split(',') : [], throttled: Boolean(recent) };
  }

  /** Never throws: alerts are called from places that are already handling a failure. */
  function notify(kind, message, opts) { return raise(kind, message, opts).catch((err) => console.error('Alert could not be recorded:', err.message)); }

  /** Texts that fail anywhere in the app. */
  if (listen) sms.onSendFailure((to, err) => {
    if (sending) return;
    notify('sms', `A text to ${sms.prettyPhone(to)} failed: ${String(err?.message || err).slice(0, 160)}. Drivers or customers may not be getting texts.`);
  });

  // The app writes a heartbeat every minute; on start-up, a gap of over 10 minutes means it was down.
  async function heartbeat() { await setSetting('heartbeat_at', now().toISOString()); }
  async function checkDowntime(timeZone) {
    const last = await getSetting('heartbeat_at', '');
    const gapMin = last ? (now().getTime() - Date.parse(last)) / 60e3 : 0;
    await heartbeat();
    if (gapMin > 10) {
      const fmt = (d) => d.toLocaleString('en-CA', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const hours = gapMin >= 120 ? `${Math.round(gapMin / 60)} hours` : `${Math.round(gapMin)} minutes`;
      await notify('down', `Dispatch was not running from ${fmt(new Date(last))} to ${fmt(now())} (${hours}). Texts, replies and scheduled texts in that time were missed.`, { force: true });
      return true;
    }
    return false;
  }

  async function settings() {
    return { alert_phones: await phones() };
  }
  async function saveSettings({ alert_phones }) {
    if (alert_phones !== undefined) await setSetting('alert_phones', JSON.stringify(parsePhones(alert_phones)));
    return settings();
  }
  async function list(limit = 20) {
    return (await db.all('SELECT * FROM alerts ORDER BY id DESC LIMIT ?', limit)).map((a) => ({ ...a, label: KINDS[a.kind] || a.kind }));
  }

  return { notify, raise, heartbeat, checkDowntime, settings, saveSettings, list, phones };
}

module.exports = { createAlerts, parsePhones, KINDS };
