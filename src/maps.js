// Distances.
//  0. With GOOGLE_MAPS_API_KEY set, the real driving distance comes from the Google Routes API
//     (Compute Routes Essentials: no traffic, field mask limited to distance + duration). Google's free
//     allowance for that SKU is 10,000 requests a month; results are cached in route_cache and requests
//     are counted in api_usage, stopping at GOOGLE_ROUTES_MONTHLY_LIMIT (default 5,000). Over the limit,
//     or if Google fails, the free estimate below is used instead.
//  1. Each address is turned into coordinates by the US Census Bureau geocoder: free, no API key,
//     no billing account. Results are cached in geocode_cache, so an address is looked up once.
//  2. Miles = straight-line distance x a road factor (default 1.2; roads run ~20% longer than
//     the crow flies). Set ROAD_DISTANCE_FACTOR to tune it.
//  3. If the geocoder is off (GEOCODER=off), unreachable, or can't match an address, the ZIP code's
//     centre from the zip_codes table is used instead.
const { haversineMiles } = require('./geo');

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROUTES_FIELDS = 'routes.distanceMeters,routes.duration'; // Essentials-only fields keep the free SKU
const ROUTE_CACHE_DAYS = 90;
const METERS_PER_MILE = 1609.344;
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
  googleKey = process.env.GOOGLE_MAPS_API_KEY || null,
  monthlyLimit = Number(process.env.GOOGLE_ROUTES_MONTHLY_LIMIT) || 5000,
  logger = console,
} = {}) {
  const useCensus = geocoder !== 'off';
  const routeGet = db.prepare(`SELECT meters, seconds FROM route_cache WHERE route_key = ? AND fetched_at > datetime('now', ?)`);
  const routePut = db.prepare(`INSERT INTO route_cache (route_key, meters, seconds, fetched_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(route_key) DO UPDATE SET meters = excluded.meters, seconds = excluded.seconds, fetched_at = excluded.fetched_at`);
  const usageGet = db.prepare(`SELECT calls FROM api_usage WHERE month = strftime('%Y-%m', 'now') AND service = 'google_routes'`);
  const usageAdd = db.prepare(`INSERT INTO api_usage (month, service, calls) VALUES (strftime('%Y-%m', 'now'), 'google_routes', 1)
    ON CONFLICT(month, service) DO UPDATE SET calls = calls + 1`);
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

  // Returns { meters, seconds } or null (no key, limit reached, no route, or Google unreachable).
  async function googleRoute(from, to) {
    if (!googleKey) return null;
    const key = `${normalize(from)}|${normalize(to)}`;
    const cached = routeGet.get(key, `-${ROUTE_CACHE_DAYS} days`);
    if (cached) return cached;
    if ((usageGet.get()?.calls ?? 0) >= monthlyLimit) {
      logger.warn(`Google Routes: monthly limit of ${monthlyLimit} requests reached; using the estimate`);
      return null;
    }
    usageAdd.run();
    let body;
    try {
      const res = await fetchFn(ROUTES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': googleKey, 'X-Goog-FieldMask': ROUTES_FIELDS },
        body: JSON.stringify({ origin: { address: from }, destination: { address: to }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' }),
        signal: AbortSignal.timeout(8000),
      });
      body = await res.json().catch(() => null);
      if (!res.ok) {
        logger.warn(`Google Routes: HTTP ${res.status} ${body?.error?.message ?? ''}`.trim());
        return null;
      }
    } catch (err) {
      logger.warn(`Google Routes unreachable: ${err.message}`);
      return null;
    }
    const route = body?.routes?.[0];
    if (!route?.distanceMeters) return null;
    const point = { meters: route.distanceMeters, seconds: parseInt(route.duration, 10) || 0 };
    routePut.run(key, point.meters, point.seconds);
    return point;
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
    provider: googleKey ? 'google' : useCensus ? 'census' : 'zip',
    roadFactor,
    /** @returns {Promise<{miles:number, method:'route'|'address'|'zip', from:string, to:string, minutes?:number,
     *   straight_miles?:number, road_factor?:number}>} */
    async distance(from, to) {
      if (!String(from || '').trim() || !String(to || '').trim()) throw new DistanceError('Both addresses are required', 400);
      const route = await googleRoute(from, to);
      if (route) {
        return { miles: round1(route.meters / METERS_PER_MILE), minutes: Math.round(route.seconds / 60), method: 'route', from, to };
      }
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
