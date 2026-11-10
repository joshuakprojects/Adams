// Map support: a small cache of address → coordinates looked up by the office browser
// (Google's Geocoder runs in the browser with the Maps key). Entries older than 30 days
// are ignored and refreshed, in line with Google's caching terms.
const MAX_AGE_DAYS = 30;

const addressKey = (a) => String(a || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

function validPoint(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return { lat: la, lng: ln };
}

function createGeo(db) {
  async function lookup(addresses) {
    const out = {};
    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
    for (const a of (Array.isArray(addresses) ? addresses : []).slice(0, 200)) {
      const key = addressKey(a);
      if (!key) continue;
      const row = await db.get('SELECT lat, lng FROM geocodes WHERE address_key = ? AND at >= ?', key, cutoff);
      if (row) out[a] = { lat: row.lat, lng: row.lng };
    }
    return out;
  }

  async function remember(address, lat, lng) {
    const key = addressKey(address);
    const p = validPoint(lat, lng);
    if (!key || !p) return false;
    await db.run('DELETE FROM geocodes WHERE address_key = ?', key);
    await db.run("INSERT INTO geocodes (address_key, lat, lng, at) VALUES (?, ?, ?, datetime('now'))", key, p.lat, p.lng);
    return true;
  }

  async function prune() {
    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
    await db.run('DELETE FROM geocodes WHERE at < ?', cutoff);
  }

  return { lookup, remember, prune };
}

module.exports = { createGeo, addressKey, validPoint };
