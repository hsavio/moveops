const test = require('node:test');
const assert = require('node:assert');
const { calculateQuote, billableHours, crewHourlyRate } = require('../src/pricing');

const card = {
  base_crew_size: 2, base_hourly_cents: 14900, extra_mover_hourly_cents: 5500, extra_truck_hourly_cents: 4000,
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
  const hourly = 14900 + 2 * 5500 + 4000;
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

test('explicit crew-size rates override the base + extra-mover formula (legacy 2017 rates)', () => {
  const legacy = { ...card, base_hourly_cents: 9900, extra_mover_hourly_cents: 4950, minimum_hours: 2, travel_fee_cents: 4500,
    mileage_cents_per_mile: 0, stair_flight_fee_cents: 0, long_walk_fee_cents: 0, weekend_multiplier: 1, peak_season_multiplier: 1,
    crew_rates: { 2: 9900, 3: 14500, 4: 19800, 6: 29700 } };
  assert.equal(crewHourlyRate(3, legacy), 14500);
  assert.equal(crewHourlyRate(5, legacy), 9900 + 3 * 4950); // no explicit row: formula
  // Legacy estimate for 3 movers: 2 h minimum x $145 + $45 trip = $335
  assert.equal(calculateQuote({ hours: 1, crewSize: 3, distanceMiles: 40, moveDate: '2017-06-20' }, legacy).total_cents, 33500);
});
