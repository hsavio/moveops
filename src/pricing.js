// Pricing engine. Pure functions only: no DB access, so it can be unit-tested and
// reused by the browser calculator via GET /api/quote/preview.

function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T12:00:00`).getDay();
  return day === 0 || day === 6;
}

function isPeakSeason(dateStr, monthsCsv) {
  const month = Number(dateStr.slice(5, 7));
  return monthsCsv.split(',').map(Number).includes(month);
}

// Round hours up to the billing increment, then apply the minimum.
function billableHours(hours, card) {
  const inc = card.billing_increment_min / 60;
  const rounded = Math.ceil(hours / inc - 1e-9) * inc;
  return Math.max(rounded, card.minimum_hours);
}

function accessFees(address, card) {
  if (!address) return { stairs: 0, walks: 0 };
  const flights = address.has_elevator ? 0 : address.stair_flights || 0;
  return {
    stairs: flights * card.stair_flight_fee_cents,
    walks: (address.long_walks || 0) * card.long_walk_fee_cents,
  };
}

// Hourly rate for a crew size: an explicit rate_card_crew_rates row wins, otherwise
// movers x the per-mover rate ($75/h per mover: 2 movers $150/h, 3 movers $225/h).
function crewHourlyRate(crewSize, card) {
  const explicit = card.crew_rates?.[crewSize];
  if (explicit != null) return explicit;
  return crewSize * card.per_mover_hourly_cents;
}

/**
 * @param {object} input  { hours, crewSize, trucks, distanceMiles, moveDate, origin, destination }
 * @param {object} card   a rate_cards row, plus crew_rates: { [crewSize]: hourly_cents }
 * @returns {{ lines: {code,description,amount_cents}[], subtotal_cents, tax_cents, total_cents, billable_hours, hourly_cents }}
 */
function calculateQuote(input, card) {
  const crewSize = input.crewSize ?? 2;
  const trucks = input.trucks ?? 1;
  const hours = billableHours(input.hours, card);

  let hourly = crewHourlyRate(crewSize, card) + Math.max(0, trucks - 1) * card.extra_truck_hourly_cents;

  const multipliers = [];
  if (input.moveDate && isWeekend(input.moveDate) && card.weekend_multiplier !== 1) {
    multipliers.push(['weekend', card.weekend_multiplier]);
  }
  if (input.moveDate && isPeakSeason(input.moveDate, card.peak_season_months) && card.peak_season_multiplier !== 1) {
    multipliers.push(['peak season', card.peak_season_multiplier]);
  }
  for (const [, m] of multipliers) hourly = Math.round(hourly * m);

  const lines = [];
  const add = (code, description, amount) => amount && lines.push({ code, description, amount_cents: amount });

  const surchargeNote = multipliers.length ? ` (incl. ${multipliers.map(([n, m]) => `${n} ×${m}`).join(', ')})` : '';
  add('labor', `${crewSize} movers, ${trucks} truck${trucks > 1 ? 's' : ''} — ${hours} h @ $${(hourly / 100).toFixed(2)}/h${surchargeNote}`,
    Math.round(hours * hourly));
  add('travel', 'Trip charge', card.travel_fee_cents);

  const paidMiles = Math.max(0, Math.ceil((input.distanceMiles || 0) - card.free_miles));
  add('mileage', `${paidMiles} mi @ $${(card.mileage_cents_per_mile / 100).toFixed(2)}/mi`, paidMiles * card.mileage_cents_per_mile);

  for (const [label, addr] of [['origin', input.origin], ['destination', input.destination]]) {
    const fees = accessFees(addr, card);
    add('stairs', `Stairs at ${label}`, fees.stairs);
    add('long_walk', `Long walk at ${label}`, fees.walks);
  }

  const subtotal = lines.reduce((s, l) => s + l.amount_cents, 0);
  const tax = Math.round(subtotal * card.tax_rate);
  return { lines, subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax, billable_hours: hours, hourly_cents: hourly };
}

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const sumLines = (lines) => lines.reduce((s, l) => s + l.amount_cents, 0);

/**
 * Price a saved estimate. All inputs come from the job itself (rates are snapshotted on the job).
 *   hourly:   max(est. hours, minimum) rounded to the billing increment x hourly rate, + trip charge
 *   fixed:    the agreed price
 *   itemized: sum of item quantity x unit price
 * then + Other Services, + move/sales additions (% of subtotal, then flat), - discounts (% then flat).
 * Not-to-exceed estimates report the cap; the final bill can't exceed it.
 */
function priceJob(job, { items = [], services = [], billingIncrementMin = 15 } = {}) {
  const lines = [];
  const add = (code, description, amount) => amount && lines.push({ code, description, amount_cents: Math.round(amount) });

  let hours = null;
  if (job.pricing_method === 'hourly') {
    const inc = billingIncrementMin / 60;
    const rawHours = Math.max(Number(job.est_hours) || 0, Number(job.minimum_hours) || 0);
    hours = Math.ceil(rawHours / inc - 1e-9) * inc;
    const rate = job.hourly_rate_cents || 0;
    add('labor', `${job.crew_size} movers × ${hours} h @ ${dollars(rate)}/h`, hours * rate);
    add('travel', 'Trip charge', job.trip_charge_cents || 0);
  } else if (job.pricing_method === 'fixed') {
    add('fixed', 'Moving services (fixed price)', job.fixed_price_cents || 0);
  } else if (job.pricing_method === 'itemized') {
    for (const it of items) add('item', `${it.quantity} × ${it.description}`, it.quantity * it.unit_cents);
  }
  for (const sv of services) add('service', sv.quantity === 1 ? sv.description : `${sv.quantity} × ${sv.description}`, sv.quantity * sv.unit_cents);
  const subtotal = sumLines(lines);

  const adjustments = [];
  const adj = (code, description, amount) => amount && adjustments.push({ code, description, amount_cents: Math.round(amount) });
  adj('move_addition', `Move additions (${job.move_addition_percent}%)`, (subtotal * (job.move_addition_percent || 0)) / 100);
  adj('move_addition', 'Move additions', job.move_addition_cents || 0);
  adj('sales_addition', `Sales additions (${job.sales_addition_percent}%)`, (subtotal * (job.sales_addition_percent || 0)) / 100);
  adj('sales_addition', 'Sales additions', job.sales_addition_cents || 0);
  const withAdditions = subtotal + sumLines(adjustments);
  adj('discount', `Discount (${job.discount_percent}%)`, -(withAdditions * (job.discount_percent || 0)) / 100);
  adj('discount', 'Discount', -(job.discount_cents || 0));

  const total = Math.max(0, subtotal + sumLines(adjustments));
  return {
    lines: [...lines, ...adjustments],
    subtotal_cents: subtotal,
    total_cents: total,
    billable_hours: hours,
    cap_cents: job.estimate_type === 'not_to_exceed' ? job.not_to_exceed_cents ?? null : null,
  };
}

// Consistency rules between pricing method and estimate type. Returns an error message or null.
function validateEstimateTerms(job) {
  if (!['hourly', 'fixed', 'itemized', 'weight'].includes(job.pricing_method)) return 'Unknown pricing method';
  if (job.estimate_type === 'binding' && !['fixed', 'itemized'].includes(job.pricing_method)) {
    return 'A binding estimate needs a fixed or itemized price';
  }
  if (job.estimate_type === 'not_to_exceed') {
    if (job.pricing_method !== 'hourly') return 'Not-to-exceed applies to hourly estimates';
    if (!(job.not_to_exceed_cents > 0)) return 'Enter the not-to-exceed amount';
  }
  if (job.pricing_method === 'hourly' && !(job.hourly_rate_cents > 0)) return 'Enter the hourly rate';
  if (job.pricing_method === 'fixed' && !(job.fixed_price_cents > 0)) return 'Enter the fixed price';
  return null;
}

module.exports = { calculateQuote, billableHours, crewHourlyRate, priceJob, validateEstimateTerms };
