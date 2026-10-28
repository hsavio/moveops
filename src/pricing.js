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
// base rate plus the extra-mover rate for each mover beyond the base crew.
function crewHourlyRate(crewSize, card) {
  const explicit = card.crew_rates?.[crewSize];
  if (explicit != null) return explicit;
  return card.base_hourly_cents + Math.max(0, crewSize - card.base_crew_size) * card.extra_mover_hourly_cents;
}

/**
 * @param {object} input  { hours, crewSize, trucks, distanceMiles, moveDate, origin, destination }
 * @param {object} card   a rate_cards row, plus crew_rates: { [crewSize]: hourly_cents }
 * @returns {{ lines: {code,description,amount_cents}[], subtotal_cents, tax_cents, total_cents, billable_hours, hourly_cents }}
 */
function calculateQuote(input, card) {
  const crewSize = input.crewSize ?? card.base_crew_size;
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

module.exports = { calculateQuote, billableHours, crewHourlyRate };
