const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createDistanceService, directionsUrl, zipOf } = require('../src/maps');

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

function dbWithZips() {
  const db = openDb(':memory:');
  const zip = db.prepare('INSERT INTO zip_codes (zip, city, state, latitude, longitude) VALUES (?, ?, ?, ?, ?)');
  zip.run('77380', 'Spring', 'TX', 30.1441, -95.4681);
  zip.run('77301', 'Conroe', 'TX', 30.3088, -95.4552);
  return db;
}

const SPRING = '1 Main St, Spring, TX 77380';
const CONROE = '2 Oak Ave, Conroe, TX 77301';

test('street addresses: Census request, road factor and caching', async () => {
  const db = dbWithZips();
  const fetchFn = mockCensus({ [SPRING]: [30.15, -95.47], [CONROE]: [30.31, -95.46] });
  const svc = createDistanceService({ db, geocoder: 'census', roadFactor: 1.2, fetchFn });
  const r = await svc.distance(SPRING, CONROE);
  assert.equal(r.method, 'address');
  assert.equal(r.road_factor, 1.2);
  assert.ok(Math.abs(r.miles - r.straight_miles * 1.2) < 0.11, JSON.stringify(r));
  assert.ok(r.straight_miles > 10 && r.straight_miles < 12, JSON.stringify(r));

  const url = new URL(fetchFn.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  assert.equal(url.searchParams.get('benchmark'), 'Public_AR_Current');
  assert.equal(url.searchParams.get('format'), 'json');

  // Same addresses again (different spacing/case): answered from geocode_cache, no new requests.
  await svc.distance('1  main st, spring, tx 77380', CONROE);
  assert.equal(fetchFn.calls.length, 2);
});

test('unmatched address falls back to its ZIP code and the miss is cached', async () => {
  const db = dbWithZips();
  const fetchFn = mockCensus({ [CONROE]: [30.31, -95.46] });
  const svc = createDistanceService({ db, fetchFn });
  const r = await svc.distance('999 Nowhere Ln, Spring, TX 77380', CONROE);
  assert.equal(r.method, 'zip');
  assert.equal(r.from, 'Spring, TX 77380');
  await svc.distance('999 Nowhere Ln, Spring, TX 77380', CONROE);
  assert.equal(fetchFn.calls.length, 2); // miss not re-requested within a day
});

test('geocoder unreachable: quoting keeps working from ZIP codes', async () => {
  const db = dbWithZips();
  const svc = createDistanceService({ db, fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  const r = await svc.distance(SPRING, CONROE);
  assert.equal(r.method, 'zip');
  assert.equal(db.prepare('SELECT count(*) AS n FROM geocode_cache').get().n, 0); // outages are not cached
});

test('GEOCODER=off never touches the network; bare ZIPs skip the geocoder', async () => {
  const db = dbWithZips();
  const off = createDistanceService({ db, geocoder: 'off', fetchFn: () => assert.fail('must not call out') });
  assert.equal(off.provider, 'zip');
  assert.equal((await off.distance(SPRING, CONROE)).method, 'zip');
  const on = createDistanceService({ db, fetchFn: () => assert.fail('bare ZIPs need no geocoding') });
  assert.equal((await on.distance('77380', '77301')).method, 'zip');
});

test('readable errors when an address cannot be placed', async () => {
  const db = dbWithZips();
  const svc = createDistanceService({ db, fetchFn: mockCensus({}) });
  await assert.rejects(svc.distance('Main St', CONROE), /check the street address or add a ZIP code/);
  await assert.rejects(svc.distance('5 Elm St, Austin, TX 99999', CONROE), /ZIP 99999 is not in the ZIP table/);
  await assert.rejects(svc.distance('', CONROE), { status: 400 });
});

test('ZIP extraction uses the last 5-digit group, not the street number', () => {
  assert.equal(zipOf('12345 Rayford Rd, Spring, TX 77380-1234'), '77380');
  assert.equal(zipOf('77380'), '77380');
  assert.equal(zipOf('Main St'), null);
});

test('Google Maps directions link (plain URL, no API): yard, pickup as waypoint, drop-off', () => {
  const url = new URL(directionsUrl(['Yard, Spring TX', '1 Main St, Spring TX', null, '2 Oak Ave, Conroe TX']));
  assert.equal(url.origin + url.pathname, 'https://www.google.com/maps/dir/');
  assert.equal(url.searchParams.get('origin'), 'Yard, Spring TX');
  assert.equal(url.searchParams.get('waypoints'), '1 Main St, Spring TX');
  assert.equal(url.searchParams.get('destination'), '2 Oak Ave, Conroe TX');
  assert.equal(directionsUrl(['only one stop']), null);
});

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

test('Google Routes: Essentials request, driving miles and minutes, cached', async () => {
  const db = dbWithZips();
  const fetchFn = mockRoutes({ meters: 32187, seconds: 1650 });
  const svc = createDistanceService({ db, googleKey: 'test-key', fetchFn, logger: quiet });
  assert.equal(svc.provider, 'google');
  const r = await svc.distance(SPRING, CONROE);
  assert.deepEqual(r, { miles: 20, minutes: 28, method: 'route', from: SPRING, to: CONROE });

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

test('Google Routes: stops at the monthly limit and falls back to the free estimate', async () => {
  const db = dbWithZips();
  const fetchFn = mockRoutes();
  const svc = createDistanceService({ db, googleKey: 'k', geocoder: 'off', monthlyLimit: 1, fetchFn, logger: quiet });
  assert.equal((await svc.distance(SPRING, CONROE)).method, 'route');
  const r = await svc.distance('5 Pine St, Spring, TX 77380', CONROE);
  assert.equal(r.method, 'zip');
  assert.equal(fetchFn.calls.length, 1);
});

test('Google Routes: bad key or outage falls back to the estimate and is not cached', async () => {
  for (const fetchFn of [mockRoutes({ status: 403 }), mockRoutes({ fail: true })]) {
    const db = dbWithZips();
    const svc = createDistanceService({ db, googleKey: 'k', geocoder: 'off', fetchFn, logger: quiet });
    assert.equal((await svc.distance(SPRING, CONROE)).method, 'zip');
    assert.equal(db.prepare('SELECT count(*) AS n FROM route_cache').get().n, 0);
  }
});

test('no Google key: Google is never called', async () => {
  const db = dbWithZips();
  const fetchFn = mockCensus({ [SPRING]: [30.15, -95.47], [CONROE]: [30.31, -95.46] });
  const svc = createDistanceService({ db, googleKey: null, fetchFn });
  assert.equal(svc.provider, 'census');
  assert.equal((await svc.distance(SPRING, CONROE)).method, 'address');
  assert.ok(fetchFn.calls.every((c) => !c.url.includes('googleapis')));
});
