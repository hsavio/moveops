const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createDistanceService, directionsUrl } = require('../src/maps');

// Census geocoder stand-in: answers from a table of address -> [lat, lon], or "no match".
function mockCensus(points) {
  const calls = [];
  const fn = async (url) => {
    const address = new URL(url).searchParams.get('address');
    calls.push({ url, address });
    const p = points[address];
    const addressMatches = p ? [{ matchedAddress: address.toUpperCase(), coordinates: { x: p[1], y: p[0] } }] : [];
    return { ok: true, status: 200, json: async () => ({ result: { input: {}, addressMatches } }) };
  };
  fn.calls = calls;
  return fn;
}

// Google Routes stand-in: records requests; answers with a route, an HTTP error, or a network failure.
function mockRoutes({ meters = 21000, seconds = 1500, status = 200, fail = false } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body && JSON.parse(opts.body) });
    if (fail) throw new Error('ECONNREFUSED');
    const json = status === 200 ? { routes: [{ distanceMeters: meters, duration: `${seconds}s` }] } : { error: { message: 'API key not valid' } };
    return { ok: status === 200, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

const quiet = { warn: () => {} };
const SPRING = '1 Main St, Spring, TX 77380';
const CONROE = '2 Oak Ave, Conroe, TX 77301';
const WOODLANDS = '3 Elm St, The Woodlands, TX 77380';
const POINTS = { [SPRING]: [30.15, -95.47], [CONROE]: [30.31, -95.46], [WOODLANDS]: [30.17, -95.50] };

test('free estimate: Census request, road factor and caching', async () => {
  const db = openDb(':memory:');
  const fetchFn = mockCensus(POINTS);
  const svc = createDistanceService({ db, googleKey: null, roadFactor: 1.2, fetchFn });
  assert.equal(svc.provider, 'census');
  const r = await svc.distance(SPRING, CONROE);
  assert.equal(r.method, 'estimate');
  assert.equal(r.road_factor, 1.2);
  assert.ok(Math.abs(r.miles - r.straight_miles * 1.2) < 0.11, JSON.stringify(r));
  assert.ok(r.straight_miles > 10 && r.straight_miles < 12, JSON.stringify(r));

  const url = new URL(fetchFn.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  assert.equal(url.searchParams.get('benchmark'), 'Public_AR_Current');

  // Same addresses again (different spacing/case): answered from geocode_cache, no new requests.
  await svc.distance('1  main st, spring, tx 77380', CONROE);
  assert.equal(fetchFn.calls.length, 2);
});

test('free estimate with stops adds up each leg', async () => {
  const db = openDb(':memory:');
  const svc = createDistanceService({ db, googleKey: null, fetchFn: mockCensus(POINTS) });
  const direct = await svc.distance(SPRING, CONROE);
  const via = await svc.distance(SPRING, CONROE, [WOODLANDS]);
  const legs = (await svc.distance(SPRING, WOODLANDS)).straight_miles + (await svc.distance(WOODLANDS, CONROE)).straight_miles;
  assert.ok(via.straight_miles > direct.straight_miles);
  assert.ok(Math.abs(via.straight_miles - legs) < 0.11, JSON.stringify({ via, legs }));
});

test('readable errors: unknown address, geocoder down, missing address, too many stops', async () => {
  const db = openDb(':memory:');
  const svc = createDistanceService({ db, googleKey: null, fetchFn: mockCensus({ [CONROE]: POINTS[CONROE] }) });
  await assert.rejects(svc.distance('999 Nowhere Ln, Spring, TX', CONROE), /Couldn't find "999 Nowhere Ln, Spring, TX": check the street address/);
  await assert.rejects(svc.distance('', CONROE), { status: 400 });
  await assert.rejects(svc.distance(SPRING, CONROE, Array(11).fill(SPRING)), /At most 10 extra stops/);

  const down = createDistanceService({ db: openDb(':memory:'), googleKey: null, fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.distance(SPRING, CONROE), { status: 503, message: /unavailable right now: type the miles in/ });
});

test('Google Routes: Essentials request, driving miles and minutes, cached', async () => {
  const db = openDb(':memory:');
  const fetchFn = mockRoutes({ meters: 32187, seconds: 1650 });
  const svc = createDistanceService({ db, googleKey: 'test-key', fetchFn, logger: quiet });
  assert.equal(svc.provider, 'google');
  assert.deepEqual(await svc.distance(SPRING, CONROE), { miles: 20, minutes: 28, method: 'route' });

  const { url, opts, body } = fetchFn.calls[0];
  assert.equal(url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['X-Goog-Api-Key'], 'test-key');
  assert.equal(opts.headers['X-Goog-FieldMask'], 'routes.distanceMeters,routes.duration');
  assert.deepEqual(body, { origin: { address: SPRING }, destination: { address: CONROE }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' });

  await svc.distance('1  main st, spring, tx 77380', CONROE);
  assert.equal(fetchFn.calls.length, 1); // answered from route_cache
  assert.equal(db.prepare('SELECT calls FROM api_usage').get().calls, 1);
});

test('Google Routes with stops: sent as intermediates in order, cached per route', async () => {
  const db = openDb(':memory:');
  const fetchFn = mockRoutes();
  const svc = createDistanceService({ db, googleKey: 'k', fetchFn, logger: quiet });
  await svc.distance(SPRING, CONROE, [WOODLANDS, '  ', '4 Pine St, Spring, TX']);
  assert.deepEqual(fetchFn.calls[0].body.intermediates, [{ address: WOODLANDS }, { address: '4 Pine St, Spring, TX' }]);
  await svc.distance(SPRING, CONROE); // a different route: not the cached one
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(fetchFn.calls[1].body.intermediates, undefined);
});

test('Google Routes: stops at the monthly limit and falls back to the free estimate', async () => {
  const db = openDb(':memory:');
  const routes = mockRoutes();
  const census = mockCensus(POINTS);
  const fetchFn = (url, opts) => (url.includes('googleapis') ? routes(url, opts) : census(url, opts));
  const svc = createDistanceService({ db, googleKey: 'k', monthlyLimit: 1, fetchFn, logger: quiet });
  assert.equal((await svc.distance(SPRING, CONROE)).method, 'route');
  assert.equal((await svc.distance(WOODLANDS, CONROE)).method, 'estimate');
  assert.equal(routes.calls.length, 1);
});

test('Google Routes: bad key or outage falls back to the estimate and is not cached', async () => {
  for (const routes of [mockRoutes({ status: 403 }), mockRoutes({ fail: true })]) {
    const db = openDb(':memory:');
    const census = mockCensus(POINTS);
    const fetchFn = (url, opts) => (url.includes('googleapis') ? routes(url, opts) : census(url, opts));
    const svc = createDistanceService({ db, googleKey: 'k', fetchFn, logger: quiet });
    assert.equal((await svc.distance(SPRING, CONROE)).method, 'estimate');
    assert.equal(db.prepare('SELECT count(*) AS n FROM route_cache').get().n, 0);
  }
});

test('no Google key: Google is never called', async () => {
  const fetchFn = mockCensus(POINTS);
  const svc = createDistanceService({ db: openDb(':memory:'), googleKey: null, fetchFn });
  await svc.distance(SPRING, CONROE);
  assert.ok(fetchFn.calls.every((c) => !c.url.includes('googleapis')));
});

test('Google Maps directions link (plain URL, no API): yard, pickup as waypoint, drop-off', () => {
  const url = new URL(directionsUrl(['Yard, Spring TX', '1 Main St, Spring TX', null, '2 Oak Ave, Conroe TX']));
  assert.equal(url.origin + url.pathname, 'https://www.google.com/maps/dir/');
  assert.equal(url.searchParams.get('origin'), 'Yard, Spring TX');
  assert.equal(url.searchParams.get('waypoints'), '1 Main St, Spring TX');
  assert.equal(url.searchParams.get('destination'), '2 Oak Ave, Conroe TX');
  assert.equal(directionsUrl(['only one stop']), null);
});
