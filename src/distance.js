// Driving distance from the starting point (116 William St.) to a job, for the delivery fee.
// Uses Google's Geocoding API (address → map point and municipality) and Routes API (driving distance),
// called from the server with GOOGLE_MAPS_SERVER_KEY so every quote is worked out the same way.
// "Within town limits" is checked against the Town of Parry Sound boundary (src/data/parry-sound-town.json).
const config = require('./config');
const TOWN = require('./data/parry-sound-town.json');
const { addressKey } = require('./geo');

class DistanceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const CACHE_DAYS = 30; // Google allows keeping looked-up results up to 30 days.

function pointInPolygon(lat, lng, rings = TOWN.coordinates) {
  let inside = false;
  const ring = rings[0];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** "Township of The Archipelago" → "Archipelago", "Municipality of McDougall" → "McDougall". */
function cleanMunicipality(name) {
  return String(name || '').replace(/^(the\s+)?(township|municipality|town|city|village)\s+of\s+/i, '').replace(/^the\s+/i, '').trim();
}

function municipalityFrom(components = []) {
  const pick = (type) => components.find((c) => (c.types || []).includes(type))?.long_name;
  return cleanMunicipality(pick('administrative_area_level_3') || pick('locality') || pick('sublocality') || '');
}

const geoQuery = (a) => {
  const s = String(a || '').trim();
  return /\b(on|ontario)\b/i.test(s) ? `${s}, Canada` : `${s}, Ontario, Canada`;
};

function createDistance(db, { key = config.maps.serverKey, fetchImpl = (...a) => fetch(...a) } = {}) {
  const cutoff = () => new Date(Date.now() - CACHE_DAYS * 86400e3).toISOString().slice(0, 19).replace('T', ' ');

  function explain(status, message) {
    if (status === 'REQUEST_DENIED' || status === 'PERMISSION_DENIED') {
      return 'Google refused the distance lookup. In Google Cloud, turn on the Geocoding API and Routes API for the server key ' +
        `(GOOGLE_MAPS_SERVER_KEY)${message ? ` — Google said: ${message}` : ''}.`;
    }
    if (status === 'OVER_QUERY_LIMIT' || status === 'RESOURCE_EXHAUSTED') return 'Google\'s lookup limit was reached — check billing on the Google Cloud project.';
    return `Google couldn't work out the distance (${status}${message ? `: ${message}` : ''}).`;
  }

  async function geocode(address) {
    const k = addressKey(address);
    if (!k) throw new DistanceError('Enter an address, or drop a pin on the map');
    const hit = await db.get('SELECT lat, lng, municipality FROM geocodes WHERE address_key = ? AND at >= ?', k, cutoff());
    if (hit && hit.municipality) return { lat: hit.lat, lng: hit.lng, municipality: hit.municipality, formatted: address };
    const url = `https://maps.googleapis.com/maps/api/geocode/json?region=ca&address=${encodeURIComponent(geoQuery(address))}&key=${encodeURIComponent(key)}`;
    const res = await fetchImpl(url);
    const body = await res.json().catch(() => ({}));
    if (body.status === 'ZERO_RESULTS' || (body.status === 'OK' && !body.results?.length)) {
      throw new DistanceError(`Google couldn't find "${address}". Check the address, or drop a pin on the map.`);
    }
    if (body.status !== 'OK') throw new DistanceError(explain(body.status, body.error_message), 502);
    const r = body.results[0];
    const out = { lat: r.geometry.location.lat, lng: r.geometry.location.lng, municipality: municipalityFrom(r.address_components), formatted: r.formatted_address };
    await db.run('DELETE FROM geocodes WHERE address_key = ?', k);
    await db.run("INSERT INTO geocodes (address_key, lat, lng, municipality, at) VALUES (?, ?, ?, ?, datetime('now'))", k, out.lat, out.lng, out.municipality);
    return out;
  }

  async function reverse(lat, lng) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${encodeURIComponent(key)}`;
    const body = await (await fetchImpl(url)).json().catch(() => ({}));
    if (body.status !== 'OK' || !body.results?.length) return { municipality: '' };
    return { municipality: municipalityFrom(body.results.find((r) => (r.address_components || []).some((c) => c.types.includes('administrative_area_level_3')))?.address_components
      || body.results[0].address_components) };
  }

  async function drive(from, to) {
    const routeKey = `${from.lat.toFixed(5)},${from.lng.toFixed(5)}>${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
    const hit = await db.get('SELECT meters FROM distances WHERE route_key = ? AND at >= ?', routeKey, cutoff());
    if (hit) return Number(hit.meters);
    const point = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const res = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters' },
      body: JSON.stringify({ origin: point(from), destination: point(to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', units: 'METRIC' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new DistanceError(explain(body.error?.status || `HTTP ${res.status}`, body.error?.message), 502);
    const meters = body.routes?.[0]?.distanceMeters;
    if (!Number.isFinite(meters)) throw new DistanceError('Google found no driving route to that spot. Drop the pin on a road, or enter the km by hand.');
    await db.run('DELETE FROM distances WHERE route_key = ?', routeKey);
    await db.run("INSERT INTO distances (route_key, meters, at) VALUES (?, ?, datetime('now'))", routeKey, Math.round(meters));
    return Math.round(meters);
  }

  /**
   * { from, address } or { from, lat, lng } → { km, in_town, municipality, lat, lng, from, mode }
   */
  async function measure({ from, address, lat, lng }) {
    if (!key) throw new DistanceError('Distance lookups need a Google key: add GOOGLE_MAPS_SERVER_KEY (see the README, "Prices").');
    const start = await geocode(from);
    let dest;
    let mode = 'address';
    if (lat != null && lng != null && lat !== '' && lng !== '') {
      const la = Number(lat);
      const ln = Number(lng);
      if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) throw new DistanceError('That map pin is not valid');
      dest = { lat: la, lng: ln, ...(await reverse(la, ln).catch(() => ({ municipality: '' }))) };
      mode = 'pin';
    } else {
      dest = await geocode(address);
    }
    const meters = await drive(start, dest);
    return {
      km: Math.round(meters / 100) / 10,
      in_town: pointInPolygon(dest.lat, dest.lng) ? 1 : 0,
      municipality: dest.municipality || '',
      lat: dest.lat,
      lng: dest.lng,
      from,
      mode,
    };
  }

  return { measure, geocode };
}

module.exports = { createDistance, DistanceError, pointInPolygon, municipalityFrom, cleanMunicipality };
