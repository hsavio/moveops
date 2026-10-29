const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');

const db = openDb(':memory:');
seed(db);
const server = createApp(db, { mailer: { configured: false } }).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const call = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

const newEstimate = (over = {}) => ({
  customer: { first_name: 'Pat', last_name: 'Rivera', phone: '(281) 555-0142', email: 'pat@example.com', advertising_source: 'referral' },
  origin: { line1: '12 Elm St', city: 'Spring', state: 'tx', postal_code: '77380', stair_flights: 1, long_walks: 0, elevator_floors: 0 },
  destination: { line1: '9 Oak Ave', line2: 'Apt 4', city: 'Conroe', state: 'TX', postal_code: '77301', elevator_floors: 3 },
  job: { move_date: '2026-11-20', arrival_window_start: '08:00', arrival_window_end: '09:00', crew_size: 3, est_hours: 4,
    minimum_hours: 2, hourly_rate_cents: 22500, trip_charge_cents: 15000, notes: 'Call on the way', internal_notes: 'Repeat customer' },
  services: [{ description: 'Shrink wrap', quantity: 2, unit_cents: 2500 }],
  ...over,
});

test('settings start with the owner defaults: $75/h per mover, $150 trip charge, proposal terms', async () => {
  const { body } = await call('/api/settings');
  assert.equal(body.rate_card.per_mover_hourly_cents, 7500);
  assert.equal(body.rate_card.travel_fee_cents, 15000);
  assert.match(body.settings.proposal_terms, /72 hours/);
  assert.doesNotMatch(JSON.stringify(body), /rollout/i);
});

test('create an hourly estimate: customer, addresses, services and quote lines are saved', async () => {
  const { status, body } = await call('/api/estimates', 'POST', newEstimate());
  assert.equal(status, 201);
  assert.match(body.job.job_number, /^\d+$/);
  assert.equal(body.job.status, 'lead');
  assert.equal(body.customer.last_name, 'Rivera');
  assert.equal(body.origin.state, 'TX');
  assert.equal(body.destination.elevator_floors, 3);
  assert.equal(body.price.total_cents, 4 * 22500 + 15000 + 5000);
  assert.equal(body.job.quoted_total_cents, body.price.total_cents);
  assert.equal(db.prepare('SELECT count(*) AS n FROM quote_lines WHERE job_id = ?').get(body.job.id).n, 3);
  assert.equal(body.history[0].note, 'Estimate created');
});

test('edit: switch to a binding fixed price with a discount; customer and addresses are updated, not duplicated', async () => {
  const created = (await call('/api/estimates', 'POST', newEstimate())).body;
  const customers = db.prepare('SELECT count(*) AS n FROM customers').get().n;
  const { status, body } = await call(`/api/estimates/${created.job.id}`, 'PUT', {
    customer: { id: created.customer.id, cell_phone: '832-555-0199' },
    origin: { ...created.origin, stair_flights: 2 },
    job: { pricing_method: 'fixed', estimate_type: 'binding', fixed_price_cents: 120000, discount_percent: 10 },
    services: [],
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.customer.cell_phone, '832-555-0199');
  assert.equal(body.customer.phone, '(281) 555-0142');          // untouched fields keep their value
  assert.equal(body.origin.id, created.origin.id);
  assert.equal(body.origin.stair_flights, 2);
  assert.equal(body.job.quoted_total_cents, 108000);
  assert.equal(db.prepare('SELECT count(*) AS n FROM customers').get().n, customers);
});

test('itemized estimate uses catalog items', async () => {
  const items = (await call('/api/items')).body;
  const sofa = items.find((i) => i.code === 'SOFA');
  const { status, body } = await call('/api/estimates', 'POST', newEstimate({
    job: { pricing_method: 'itemized', crew_size: 2 },                        // binding is implied
    items: [{ item_id: sofa.id, code: sofa.code, description: sofa.description, quantity: 2, unit_cents: sofa.price_cents }],
    services: [],
  }));
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.items.length, 1);
  assert.equal(body.job.estimate_type, 'binding');
  assert.equal(body.price.total_cents, 2 * sofa.price_cents);
});

test('validation: estimate terms, missing name, card numbers in notes', async () => {
  const nte = await call('/api/estimates', 'POST', newEstimate({ job: { ...newEstimate().job, estimate_type: 'not_to_exceed' } }));
  assert.equal(nte.status, 400);
  assert.match(nte.body.error, /not-to-exceed amount/);
  const noName = await call('/api/estimates', 'POST', newEstimate({ customer: { phone: '555' } }));
  assert.equal(noName.status, 400);
  const card = await call('/api/estimates', 'POST', newEstimate({ job: { ...newEstimate().job, internal_notes: 'Visa 4111 1111 1111 1111 exp 09/28' } }));
  assert.equal(card.status, 400);
  assert.match(card.body.error, /card number/);
  const badDate = await call('/api/estimates', 'POST', newEstimate({ job: { ...newEstimate().job, move_date: '11/20/2026' } }));
  assert.equal(badDate.status, 400);
});

test('live price preview reports problems without saving', async () => {
  const before = db.prepare('SELECT count(*) AS n FROM jobs').get().n;
  const { body } = await call('/api/estimates/price', 'POST', { job: { pricing_method: 'hourly', crew_size: 2, est_hours: 1, minimum_hours: 2, hourly_rate_cents: 15000, trip_charge_cents: 15000 } });
  assert.equal(body.total_cents, 2 * 15000 + 15000);
  assert.equal(body.problem, null);
  assert.equal((await call('/api/estimates/price', 'POST', { job: { pricing_method: 'fixed' } })).body.problem, 'Enter the fixed price');
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, before);
});

test('search by name, phone digits and estimate number', async () => {
  const created = (await call('/api/estimates', 'POST', newEstimate({ customer: { first_name: 'Quinn', last_name: 'Zeller', phone: '(936) 555-0177' } }))).body;
  assert.ok((await call('/api/estimates?q=zeller')).body.some((r) => r.id === created.job.id));
  assert.ok((await call('/api/estimates?q=936-555-01')).body.some((r) => r.id === created.job.id));
  assert.ok((await call(`/api/estimates?q=${created.job.job_number}`)).body.some((r) => r.id === created.job.id));
  const customers = (await call('/api/customers?q=9365550177')).body;
  assert.equal(customers[0].last_name, 'Zeller');
  assert.equal(customers[0].addresses.length, 2);
});

test('estimate numbers continue from the highest numeric one (legacy numbers carry on)', async () => {
  db.prepare("UPDATE jobs SET job_number = '11541' WHERE job_number = 'J-2026-00112'").run();
  const { body } = await call('/api/estimates', 'POST', newEstimate());
  assert.equal(body.job.job_number, '11542');
});

test('rates: saving creates today\'s version; existing estimates keep their own rates', async () => {
  db.prepare("UPDATE rate_cards SET effective_from = date('now', '-1 day')").run(); // rates set on an earlier day
  const before = (await call('/api/settings')).body.rate_card;
  const est = (await call('/api/estimates', 'POST', newEstimate())).body;
  const r = await call('/api/rate-card', 'PUT', { per_mover_hourly_cents: 8000, travel_fee_cents: 17500, crew_rates: { 5: 37500 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.per_mover_hourly_cents, 8000);
  assert.equal(r.body.crew_rates[5], 37500);
  assert.notEqual(r.body.id, before.id);
  const again = await call('/api/rate-card', 'PUT', { per_mover_hourly_cents: 7500, travel_fee_cents: 15000 });
  assert.equal(again.body.id, r.body.id);                   // same day: updated in place
  assert.deepEqual(again.body.crew_rates, {});
  assert.equal((await call(`/api/estimates/${est.job.id}`)).body.job.hourly_rate_cents, 22500);
  assert.equal((await call('/api/rate-card', 'PUT', { per_mover_hourly_cents: 0, travel_fee_cents: 0 })).status, 400);
});

test('company settings and item catalog can be edited', async () => {
  const s = await call('/api/settings', 'PUT', { settings: { company_name: 'Demo Movers', unknown_key: 'ignored' } });
  assert.equal(s.body.settings.company_name, 'Demo Movers');
  assert.equal(s.body.settings.unknown_key, undefined);
  const created = await call('/api/items', 'POST', { code: 'tv55', description: '55" TV', price_cents: 3000 });
  assert.equal(created.status, 201);
  assert.equal(created.body.code, 'TV55');
  assert.equal((await call('/api/items', 'POST', { code: 'TV55', description: 'dup', price_cents: 1 })).status, 409);
  const off = await call(`/api/items/${created.body.id}`, 'PUT', { ...created.body, active: false });
  assert.equal(off.body.active, 0);
  assert.ok(!(await call('/api/items')).body.some((i) => i.code === 'TV55'));
});

test('booking requires a move date and arrival time', async () => {
  const est = (await call('/api/estimates', 'POST', newEstimate({ job: { ...newEstimate().job, arrival_window_start: null, arrival_window_end: null } }))).body;
  await call(`/api/jobs/${est.job.id}/status`, 'PATCH', { status: 'quoted' });
  const refused = await call(`/api/jobs/${est.job.id}/status`, 'PATCH', { status: 'booked' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /arrival time/);
  await call(`/api/estimates/${est.job.id}`, 'PUT', { job: { arrival_window_start: '08:00', arrival_window_end: '09:00' } });
  assert.equal((await call(`/api/jobs/${est.job.id}/status`, 'PATCH', { status: 'booked' })).status, 200);
});
