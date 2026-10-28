// Distances without paid services.
//  1. Each address is turned into coordinates by the US Census Bureau geocoder: free, no API key,
//     no billing account. Results are cached in geocode_cache, so an address is looked up once.
//  2. Miles = straight-line distance x a road factor (default 1.2; roads run ~20% longer than
//     the crow flies). Set ROAD_DISTANCE_FACTOR to tune it.
//  3. If the geocoder is off (GEOCODER=off), unreachable, or can't match an address, the ZIP code's
//     centre from the zip_codes table is used instead.
const { haversineMiles } = require('./geo');

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const MISS_RETRY_HOURS = 24; // don't re-ask the geocoder about an unmatched address for a day

class DistanceError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const normalize = (address) => String(address || '').trim().replace(/\s+/g, ' ').toLowerCase();
const zipOf = (address) => String(address || '').match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/)?.[1] ?? null;
const isZipOnly = (address) => /^\s*\d{5}(-\d{4})?\s*$/.test(String(address || ''));
const round1 = (n) => Math.round(n * 10) / 10;

function createDistanceService({
  db,
  geocoder = process.env.GEOCODER || 'census',
  roadFactor = Number(process.env.ROAD_DISTANCE_FACTOR) || 1.2,
  fetchFn = globalThis.fetch,
} = {}) {
  const useCensus = geocoder !== 'off';
  const cacheGet = db.prepare(`SELECT latitude, longitude, matched_address FROM geocode_cache
    WHERE address_key = ? AND (latitude IS NOT NULL OR fetched_at > datetime('now', ?))`);
  const cachePut = db.prepare(`INSERT INTO geocode_cache (address_key, latitude, longitude, matched_address, fetched_at)
    VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(address_key) DO UPDATE SET latitude = excluded.latitude,
    longitude = excluded.longitude, matched_address = excluded.matched_address, fetched_at = excluded.fetched_at`);
  const zipStmt = db.prepare('SELECT zip, city, state, latitude, longitude FROM zip_codes WHERE zip = ?');

  // Returns { latitude, longitude, label } or null when the address can't be matched.
  // Network failures return null too (and are not cached), so quoting keeps working offline.
  async function censusGeocode(address) {
    const key = normalize(address);
    const cached = cacheGet.get(key, `-${MISS_RETRY_HOURS} hours`);
    if (cached) return cached.latitude == null ? null : { latitude: cached.latitude, longitude: cached.longitude, label: cached.matched_address };
    const params = new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' });
    let body;
    try {
      const res = await fetchFn(`${CENSUS_URL}?${params}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      body = await res.json();
    } catch {
      return null;
    }
    const match = body?.result?.addressMatches?.[0];
    const point = match && { latitude: match.coordinates.y, longitude: match.coordinates.x, label: match.matchedAddress };
    cachePut.run(key, point?.latitude ?? null, point?.longitude ?? null, point?.label ?? null);
    return point || null;
  }

  async function locate(address) {
    if (useCensus && !isZipOnly(address)) {
      const p = await censusGeocode(address);
      if (p) return { ...p, source: 'address' };
    }
    const zip = zipOf(address);
    const z = zip && zipStmt.get(zip);
    if (z) return { latitude: z.latitude, longitude: z.longitude, label: `${z.city}, ${z.state} ${z.zip}`, source: 'zip' };
    throw new DistanceError(zip
      ? `Couldn't find "${address}": ZIP ${zip} is not in the ZIP table`
      : `Couldn't find "${address}": check the street address or add a ZIP code`);
  }

  return {
    provider: useCensus ? 'census' : 'zip',
    roadFactor,
    /** @returns {Promise<{miles:number, straight_miles:number, road_factor:number, method:'address'|'zip', from:string, to:string}>} */
    async distance(from, to) {
      if (!String(from || '').trim() || !String(to || '').trim()) throw new DistanceError('Both addresses are required', 400);
      const [a, b] = await Promise.all([locate(from), locate(to)]);
      const straight = haversineMiles(a, b);
      return {
        miles: round1(straight * roadFactor),
        straight_miles: round1(straight),
        road_factor: roadFactor,
        method: a.source === 'address' && b.source === 'address' ? 'address' : 'zip',
        from: a.label,
        to: b.label,
      };
    },
  };
}

// A plain Google Maps web link that opens directions on the crew's phone. It is only a URL:
// no API key, no account and no charge.
function directionsUrl(stops) {
  const s = stops.filter((x) => x && String(x).trim());
  if (s.length < 2) return null;
  const params = new URLSearchParams({ api: '1', origin: s[0], destination: s[s.length - 1], travelmode: 'driving' });
  if (s.length > 2) params.set('waypoints', s.slice(1, -1).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}

module.exports = { createDistanceService, directionsUrl, DistanceError, zipOf };
