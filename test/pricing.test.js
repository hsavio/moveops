const test = require('node:test');
const assert = require('node:assert');
const { calculateQuote, billableHours, crewHourlyRate, priceJob, validateEstimateTerms } = require('../src/pricing');

const card = {
  per_mover_hourly_cents: 7450, extra_truck_hourly_cents: 4000,
  minimum_hours: 3, billing_increment_min: 15, travel_fee_cents: 9900, mileage_cents_per_mile: 150, free_miles: 15,
  stair_flight_fee_cents: 2500, long_walk_fee_cents: 2000,
  weekend_multiplier: 1.1, peak_season_multiplier: 1.15, peak_season_months: '5,6,7,8', tax_rate: 0,
};

test('billable hours honour minimum and 15-minute rounding', () => {
  assert.equal(billableHours(1, card), 3);
  assert.equal(billableHours(4.1, card), 4.25);
  assert.equal(billableHours(4.25, card), 4.25);
});

test('weekday, off-season, base crew: labor + trip charge only', () => {
  const q = calculateQuote({ hours: 4, distanceMiles: 10, moveDate: '2026-10-28' }, card); // Wednesday, October
  assert.deepEqual(q.lines.map((l) => l.code), ['labor', 'travel']);
  assert.equal(q.total_cents, 4 * 14900 + 9900);
});

test('extra crew, extra truck, mileage, stairs and long walks', () => {
  const q = calculateQuote({
    hours: 5, crewSize: 4, trucks: 2, distanceMiles: 20.2, moveDate: '2026-10-28',
    origin: { stair_flights: 2, long_walks: 2, has_elevator: 0 },
    destination: { stair_flights: 3, long_walks: 0, has_elevator: 1 }, // elevator waives stairs
  }, card);
  const hourly = 4 * 7450 + 4000;
  assert.equal(q.hourly_cents, hourly);
  const byCode = Object.fromEntries(q.lines.map((l) => [l.code, l.amount_cents]));
  assert.equal(byCode.labor, 5 * hourly);
  assert.equal(byCode.mileage, 6 * 150);       // ceil(20.2 - 15) = 6 miles
  assert.equal(byCode.stairs, 2 * 2500);       // origin only
  assert.equal(byCode.long_walk, 2 * 2000);
});

test('weekend in peak season stacks both multipliers', () => {
  const q = calculateQuote({ hours: 3, moveDate: '2026-06-13' }, card); // Saturday in June
  assert.equal(q.hourly_cents, Math.round(Math.round(14900 * 1.1) * 1.15));
});

test('explicit crew-size rates override movers x per-mover rate (legacy 2017 rates)', () => {
  const legacy = { ...card, per_mover_hourly_cents: 4950, minimum_hours: 2, travel_fee_cents: 4500,
    mileage_cents_per_mile: 0, stair_flight_fee_cents: 0, long_walk_fee_cents: 0, weekend_multiplier: 1, peak_season_multiplier: 1,
    crew_rates: { 2: 9900, 3: 14500, 4: 19800, 6: 29700 } };
  assert.equal(crewHourlyRate(3, legacy), 14500);
  assert.equal(crewHourlyRate(5, legacy), 5 * 4950); // no explicit row: movers x per-mover rate
  // Legacy estimate for 3 movers: 2 h minimum x $145 + $45 trip = $335
  assert.equal(calculateQuote({ hours: 1, crewSize: 3, distanceMiles: 40, moveDate: '2017-06-20' }, legacy).total_cents, 33500);
});

test('current default: $75/h per mover', () => {
  const card2026 = { ...card, per_mover_hourly_cents: 7500 };
  assert.deepEqual([2, 3, 4].map((n) => crewHourlyRate(n, card2026)), [15000, 22500, 30000]);
});

const baseJob = { pricing_method: 'hourly', estimate_type: 'standard', crew_size: 3, est_hours: 3.1, minimum_hours: 2,
  hourly_rate_cents: 22500, trip_charge_cents: 15000 };

test('hourly job: hours rounded up to 15 min, minimum applied, trip charge added', () => {
  const p = priceJob(baseJob);
  assert.equal(p.billable_hours, 3.25);
  assert.equal(p.total_cents, Math.round(3.25 * 22500) + 15000);
  assert.equal(priceJob({ ...baseJob, est_hours: 1 }).billable_hours, 2);
});

test('fixed and itemized jobs, plus Other Services', () => {
  const services = [{ description: 'Shrink wrap', quantity: 2, unit_cents: 2500 }];
  assert.equal(priceJob({ ...baseJob, pricing_method: 'fixed', fixed_price_cents: 90000 }, { services }).total_cents, 95000);
  const items = [{ description: 'Sofa', quantity: 1, unit_cents: 8000 }, { description: 'Box', quantity: 10, unit_cents: 500 }];
  const p = priceJob({ ...baseJob, pricing_method: 'itemized' }, { items });
  assert.equal(p.total_cents, 13000);
  assert.ok(!p.lines.some((l) => l.code === 'travel')); // trip charge is part of hourly pricing only
});

test('additions apply to the subtotal, then both percent and flat discounts apply', () => {
  // Legacy screenshot: subtotal $312.50, 20% and $25 off. The old app ignored the flat $25; we apply both.
  const p = priceJob({ ...baseJob, pricing_method: 'fixed', fixed_price_cents: 31250, discount_percent: 20, discount_cents: 2500 });
  assert.equal(p.total_cents, 31250 - 6250 - 2500);
  const q = priceJob({ ...baseJob, pricing_method: 'fixed', fixed_price_cents: 10000, move_addition_percent: 10, sales_addition_cents: 500, discount_percent: 50 });
  assert.equal(q.total_cents, Math.round((10000 + 1000 + 500) / 2));
});

test('estimate terms: binding needs a guaranteed price, not-to-exceed needs hourly + cap', () => {
  assert.equal(validateEstimateTerms(baseJob), null);
  assert.match(validateEstimateTerms({ ...baseJob, estimate_type: 'binding' }), /fixed or itemized/);
  assert.match(validateEstimateTerms({ ...baseJob, estimate_type: 'not_to_exceed' }), /not-to-exceed amount/);
  assert.equal(validateEstimateTerms({ ...baseJob, estimate_type: 'not_to_exceed', not_to_exceed_cents: 100000 }), null);
  assert.equal(priceJob({ ...baseJob, estimate_type: 'not_to_exceed', not_to_exceed_cents: 100000 }).cap_cents, 100000);
  assert.match(validateEstimateTerms({ ...baseJob, pricing_method: 'fixed' }), /fixed price/);
});
