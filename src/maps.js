// Distances along a route: start -> any extra stops -> end.
//  1. With GOOGLE_MAPS_API_KEY set, the real driving distance comes from the Google Routes API
//     (Compute Routes Essentials: no traffic, at most 10 stops in between, field mask limited to
//     distance + duration). Google's free allowance for that SKU is 10,000 requests a month; results
//     are cached in route_cache and requests are counted in api_usage, stopping at
//     GOOGLE_ROUTES_MONTHLY_LIMIT (default 5,000). Over the limit, or if Google fails, step 2 is used.
//  2. Free estimate: each address is turned into coordinates by the US Census Bureau geocoder (no key,
//     no account; cached in geocode_cache), and each leg's straight-line distance is multiplied by a
//     road factor (default 1.2; roads run ~20% longer than the crow flies). Set ROAD_DISTANCE_FACTOR
//     to tune it. If an address can't be found the office types the miles in by hand.
const { haversineMiles } = require('./geo');

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROUTES_FIELDS = 'routes.distanceMeters,routes.duration'; // Essentials-only fields keep the free SKU
const MAX_STOPS = 10; // stops in between; more than 10 moves the request to the paid Pro SKU
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
const round1 = (n) => Math.round(n * 10) / 10;

function createDistanceService({
  db,
  roadFactor = Number(process.env.ROAD_DISTANCE_FACTOR) || 1.2,
  fetchFn = globalThis.fetch,
  googleKey = process.env.GOOGLE_MAPS_API_KEY || null,
  monthlyLimit = Number(process.env.GOOGLE_ROUTES_MONTHLY_LIMIT) || 5000,
  logger = console,
} = {}) {
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

  // Returns { meters, seconds } or null (no key, limit reached, no route, or Google unreachable).
  async function googleRoute(points) {
    if (!googleKey) return null;
    const key = points.map(normalize).join('|');
    const cached = routeGet.get(key, `-${ROUTE_CACHE_DAYS} days`);
    if (cached) return cached;
    if ((usageGet.get()?.calls ?? 0) >= monthlyLimit) {
      logger.warn(`Google Routes: monthly limit of ${monthlyLimit} requests reached; using the estimate`);
      return null;
    }
    usageAdd.run();
    const request = { origin: { address: points[0] }, destination: { address: points.at(-1) }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' };
    if (points.length > 2) request.intermediates = points.slice(1, -1).map((address) => ({ address }));
    let body;
    try {
      const res = await fetchFn(ROUTES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': googleKey, 'X-Goog-FieldMask': ROUTES_FIELDS },
        body: JSON.stringify(request),
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
    const result = { meters: route.distanceMeters, seconds: parseInt(route.duration, 10) || 0 };
    routePut.run(key, result.meters, result.seconds);
    return result;
  }

  // Returns { latitude, longitude, label }. Throws when the address can't be matched or the geocoder
  // can't be reached (outages are not cached, so the next try asks again).
  async function locate(address) {
    const key = normalize(address);
    const cached = cacheGet.get(key, `-${MISS_RETRY_HOURS} hours`);
    let point = cached && cached.latitude != null && { latitude: cached.latitude, longitude: cached.longitude, label: cached.matched_address };
    if (!cached) {
      const params = new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' });
      let body;
      try {
        const res = await fetchFn(`${CENSUS_URL}?${params}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = await res.json();
      } catch {
        throw new DistanceError('The distance lookup is unavailable right now: type the miles in', 503);
      }
      const match = body?.result?.addressMatches?.[0];
      point = match && { latitude: match.coordinates.y, longitude: match.coordinates.x, label: match.matchedAddress };
      cachePut.run(key, point?.latitude ?? null, point?.longitude ?? null, point?.label ?? null);
    }
    if (!point) throw new DistanceError(`Couldn't find "${address}": check the street address, or type the miles in`);
    return point;
  }

  return {
    provider: googleKey ? 'google' : 'census',
    roadFactor,
    maxStops: MAX_STOPS,
    /**
     * @param {string} from  start address
     * @param {string} to    end address
     * @param {string[]} [stops]  addresses in between, in driving order (at most 10)
     * @returns {Promise<{miles:number, method:'route'|'estimate', minutes?:number, straight_miles?:number, road_factor?:number}>}
     */
    async distance(from, to, stops = []) {
      if (!String(from || '').trim() || !String(to || '').trim()) throw new DistanceError('Both addresses are required', 400);
      const via = stops.map((s) => String(s || '').trim()).filter(Boolean);
      if (via.length > MAX_STOPS) throw new DistanceError(`At most ${MAX_STOPS} extra stops`, 400);
      const points = [from, ...via, to];
      const route = await googleRoute(points);
      if (route) return { miles: round1(route.meters / METERS_PER_MILE), minutes: Math.round(route.seconds / 60), method: 'route' };
      const located = await Promise.all(points.map(locate));
      let straight = 0;
      for (let i = 1; i < located.length; i++) straight += haversineMiles(located[i - 1], located[i]);
      return { miles: round1(straight * roadFactor), straight_miles: round1(straight), road_factor: roadFactor, method: 'estimate' };
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

module.exports = { createDistanceService, directionsUrl, DistanceError, MAX_STOPS };
