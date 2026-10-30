// Pure transforms from legacy VB6/Access rows to the new schema. No DB access.

const blank = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

// ---------------------------------------------------------------- AdvertisingCodes
// Known legacy spellings mapped to a clean label. Anything else is title-cased as-is.
const AD_LABELS = { refferal: 'Referral', referral: 'Referral', internet: 'Internet', cards: 'Business cards' };

function advertisingSource(legacyValue) {
  const raw = blank(legacyValue);
  if (!raw) return null;
  const key = raw.toLowerCase();
  const label = AD_LABELS[key] ?? raw.replace(/\b\w/g, (c) => c.toUpperCase());
  return { code: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label, legacy_value: raw };
}

// ---------------------------------------------------------------- ArrivalTimes
// Legacy ranges carry no am/pm ("1:00 - 2:00"). Moving crews work roughly 7am–7pm,
// so hours 1–6 are read as pm, and a range's end is read as the first time after its start. Single times ("7:00 am", "12:00 Noon") carry a suffix.
const pad = (n) => String(n).padStart(2, '0');

function to24h(h, m, suffix) {
  h = Number(h);
  if (suffix) {
    suffix = suffix.toLowerCase();
    if (suffix === 'noon') h = 12;
    else if (suffix === 'pm' && h < 12) h += 12;
    else if (suffix === 'am' && h === 12) h = 0;
  } else if (h >= 1 && h <= 6) {
    h += 12;
  }
  return `${pad(h)}:${pad(Number(m))}`;
}

function fmt12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === 12 && m === 0) return 'noon';
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`;
}

function arrivalWindow(legacyValue, sortOrder = 0) {
  const raw = blank(legacyValue);
  if (!raw) return null;
  let m = raw.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (m) {
    const start = to24h(m[1], m[2]);
    let end = to24h(m[3], m[4]);
    if (end <= start) end = `${pad(Number(end.slice(0, 2)) + 12)}${end.slice(2)}`; // "6:00 - 7:00" ends at 19:00
    if (end <= start || end > '24:00') return null;
    return { label: `${fmt12(start)} – ${fmt12(end)}`, start_time: start, end_time: end, sort_order: sortOrder, legacy_value: raw };
  }
  m = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm|noon)$/i);
  if (m) {
    const start = to24h(m[1], m[2], m[3]);
    return { label: `Arrive at ${fmt12(start)}`, start_time: start, end_time: null, sort_order: sortOrder, legacy_value: raw };
  }
  return null;
}

// ---------------------------------------------------------------- Agents
function agent(row) {
  const a = {
    legacy_id: blank(row.AgentID),
    business_name: blank(row.BusinessName),
    first_name: blank(row.FirstName),
    last_name: blank(row.LastName),
    address: blank(row.Address),
    city: blank(row.City),
    state: blank(row.State),
    postal_code: blank(row.Zip),
    business_phone: blank(row.BusinessPhone),
    alternate_phone: blank(row.AlternatePhone),
    fax: blank(row.FaxNumber),
  };
  return a.business_name || a.last_name ? a : null;
}

// ---------------------------------------------------------------- Adjustments
// Category is inferred from free-text descriptions; order matters (first match wins).
// The original description is always kept, so a wrong guess loses nothing.
const ADJUSTMENT_RULES = [
  ['cash_paid', /^paid\b|\bpaid cash\b|\bcash payment\b/i],
  ['damage', /damage/i],
  ['advance', /advance|loan|debt/i],
  ['tip', /\btip\b/i],
  ['expense', /\bgas\b|truck wash|rental fee|phone bill|under-cleaned/i],
];

function adjustmentCategory(description, amount) {
  for (const [cat, re] of ADJUSTMENT_RULES) if (re.test(description)) return cat;
  return amount > 0 ? 'extra_pay' : 'other';
}

function adjustment(row) {
  const amount = Number(row.AdjustmentAmount);
  const date = blank(row.AdjustmentDate)?.slice(0, 10);
  if (!blank(row.PersonnelID) || !Number.isFinite(amount) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const description = blank(row.AdjustmentDescription) || '(no description)';
  return {
    legacy_id: blank(row.AdjustmentID),
    personnel_legacy_id: blank(row.PersonnelID),
    adjustment_date: date,
    description,
    category: adjustmentCategory(description, amount),
    amount_cents: Math.round(amount * 100),
  };
}

// ---------------------------------------------------------------- shared value parsers
// Access exports money as "$2,200.00 ", "(100.00)" (negative) or "-50".
function moneyCents(v) {
  let s = blank(v);
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()$,\s-]/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  return Math.round(Number(s) * 100) * (negative ? -1 : 1);
}

// "6/14/2017" -> "2017-06-14"; ISO dates pass through.
function usDate(v) {
  const s = blank(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : null;
}

// Access time-only values are exported on the 1899/1900 epoch: "1/1/1900 14:00" -> "14:00".
function accessTime(v) {
  const m = blank(v)?.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  return m[3] ? to24h(m[1], m[2], m[3]) : `${pad(m[1])}:${m[2]}`; // no suffix: already 24-hour
}

const digits = (v) => String(v ?? '').replace(/\D/g, '');

// ---------------------------------------------------------------- sensitive data
// Legacy notes contain full card numbers (with expiry and CVV) and possibly SSNs.
// Any line holding a Luhn-valid 13–19 digit number, or an SSN pattern, is dropped entirely.
function luhn(num) {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// Card numbers are written as one run or as groups split by a space or dash ("4186 2100 1528 1952").
// Try every chain of adjacent digit groups, so trailing expiry/CVV digits don't hide the number.
function hasCardNumber(line) {
  const groups = [...line.matchAll(/\d+/g)];
  for (let i = 0; i < groups.length; i++) {
    let n = '';
    for (let j = i; j < groups.length; j++) {
      if (j > i && !/^[ -]$/.test(line.slice(groups[j - 1].index + groups[j - 1][0].length, groups[j].index))) break;
      n += groups[j][0];
      if (n.length > 19) break;
      if (n.length >= 13 && luhn(n)) return true;
    }
  }
  return false;
}

function scrubSensitive(text) {
  const raw = blank(text);
  if (!raw) return { text: null, removed: 0 };
  let removed = 0;
  const lines = raw.split(/\r?\n/).map((line) => {
    if (hasCardNumber(line)) { removed++; return '[removed: payment card details]'; }
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(line)) { removed++; return '[removed: SSN]'; }
    return line;
  });
  return { text: blank(lines.join('\n')), removed };
}

// ---------------------------------------------------------------- Estimates
// The legacy app had no customer table: each Estimates row holds the customer, both addresses,
// the agreed rates and the outcome. `ctx` carries file-level facts computed by the importer:
//   ignored: columns holding one constant value in every row (program defaults, not data)
//   placeholderPhones: phone numbers shared across many unrelated customers
const STATUS_MAP = { estimate: 'quoted', scheduled: 'booked', cancelled: 'cancelled' };

function estimate(row, ctx = { ignored: new Set(), placeholderPhones: new Set() }) {
  const id = blank(row.EstimateID);
  if (!id) return null;
  const col = (k) => (ctx.ignored.has(k) ? null : blank(row[k]));
  const phone = (k) => {
    const v = col(k);
    return v && digits(v).length >= 7 && !ctx.placeholderPhones.has(digits(v)) ? v : null;
  };
  const num = (k) => (col(k) == null || Number.isNaN(Number(col(k))) ? 0 : Number(col(k)));

  const company = col('CompanyName');
  const first = col('FirstName');
  const last = col('LastName') || (company || first ? null : '(no name)');
  const homePhone = phone('HomePhone');
  const customerKey = [digits(homePhone) || 'nophone', (last || company || first || '').toLowerCase()].join('|');

  const address = (prefix) => {
    const line1 = col(`${prefix}Address`);
    const city = col(`${prefix}City`);
    const zip = col(`${prefix}ZipCode`);
    if (!line1 && !city && !zip) return null;
    const elevatorFloors = num(`${prefix}ElevatorFloors`);
    return {
      legacy_id: `${id}:${prefix.toLowerCase()}`,
      line1: line1 || '',
      line2: col(`${prefix}Apartment`) ? `Apt ${col(`${prefix}Apartment`).replace(/^(apt|unit|#)\s*/i, '')}` : null,
      city: city || '',
      state: (col(`${prefix}State`) || '').toUpperCase(),
      postal_code: zip ? zip.padStart(5, '0') : '',
      stair_flights: Math.max(0, Math.round(num(`${prefix}Stairs`))),
      long_walks: Math.max(0, Math.round(num(`${prefix}LongWalks`))),
      has_elevator: elevatorFloors > 0 ? 1 : 0,
      floor: elevatorFloors > 0 ? Math.round(elevatorFloors) : 1,
      description: col(`${prefix}Description`),
    };
  };

  const collected = moneyCents(row.TotalCollected) || 0;
  const closed = moneyCents(row.ClosedTotal) || 0;
  let status = STATUS_MAP[(blank(row.Status) || '').toLowerCase()] || 'lead';
  if (status === 'booked' && (collected > 0 || closed > 0)) status = 'completed';

  const start = accessTime(row.StartTime);
  const end = accessTime(row.EndTime);
  const window = arrivalWindow(row.ArrivalTime);
  const minHours = num('MinimumHours') || 2;
  const hourly = moneyCents(row.HourlyRate);
  const trip = moneyCents(row.TripCharge) || 0;
  const quoted = moneyCents(row.GrandTotal) ?? moneyCents(row.SubTotal);
  const method = (blank(row.PricingMethod) || 'hourly').toLowerCase();
  const men = Math.max(1, Math.round(num('NumberOfMen')) || 2);

  // Legacy hourly estimate = minimum hours x rate + trip charge. Anything else is kept as one line.
  const lines = [];
  if (method === 'hourly' && hourly != null && quoted === Math.round(minHours * hourly) + trip) {
    lines.push({ code: 'labor', description: `${men} movers, ${minHours} h minimum @ $${(hourly / 100).toFixed(2)}/h`, amount_cents: Math.round(minHours * hourly) });
    if (trip) lines.push({ code: 'travel', description: 'Trip charge', amount_cents: trip });
  } else if (quoted != null) {
    lines.push({ code: 'legacy_total', description: `Legacy ${method} estimate total`, amount_cents: quoted });
  }

  const pub = scrubSensitive(row.PublicNotes);
  const priv = scrubSensitive(row.PrivateNotes);
  const moveDate = usDate(row.MoveDate);
  const estimateDate = usDate(row.EstimateDate);

  return {
    customerKey,
    customer: {
      legacy_id: `estimate-customer:${customerKey}`,
      kind: company ? 'commercial' : 'residential',
      first_name: first,
      last_name: last,
      company_name: company,
      phone: homePhone,
      cell_phone: phone('CellPhone'),
      work_phone: phone('BusinessPhone'),
      work_ext: col('WorkExtension'),
      new_phone: phone('NewPhone'),
      fax: phone('FaxNumber'),
      email: [col('Email'), col('EmailAddress'), col('E-Mail')].find((v) => v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) ?? null,
      legacy_referral: col('Referral'),
      created_at: estimateDate,
    },
    origin: address('Origin'),
    destination: address('Destination'),
    job: {
      legacy_id: id,
      job_number: id, // same number as on the customer's legacy paperwork
      status,
      move_date: moveDate,
      arrival_window_start: window?.start_time ?? start,
      arrival_window_end: window?.end_time ?? (window ? null : end),
      est_hours: start && end && end > start ? (Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) - Number(start.slice(0, 2)) * 60 - Number(start.slice(3))) / 60 : minHours,
      crew_size: men,
      crew_number: blank(row.CrewNumber) ? Number(row.CrewNumber) : null,
      distance_miles: num('Miles') || null,
      pricing_method: ['hourly', 'itemized', 'weight'].includes(method) ? method : 'hourly',
      hourly_rate_cents: hourly,
      trip_charge_cents: trip,
      minimum_hours: minHours,
      discount_cents: moneyCents(row.DiscountFlat) || 0,
      discount_percent: num('DiscountPercent'),
      move_addition_cents: moneyCents(row.AdjustmentFlat) || 0,
      move_addition_percent: num('AdjustmentPercent'),
      sales_addition_cents: moneyCents(row.SalesAdjustmentFlat) || 0,
      sales_addition_percent: num('SalesAdjustmentPercent'),
      // The legacy app defaults CallBackDate to the estimate date, so it only means something on open estimates.
      callback_date: ['quoted', 'lead'].includes(status) ? usDate(row.CallBackDate) : null,
      po_number: col('PONumber'),
      quoted_total_cents: quoted,
      final_total_cents: closed > 0 ? closed : null,
      tips_cents: moneyCents(row.Tips) || 0,
      notes: pub.text,
      internal_notes: priv.text,
      created_at: estimateDate ? `${estimateDate}T00:00:00.000Z` : null,
    },
    quoteLines: lines,
    payment: collected > 0 ? {
      legacy_id: `estimate:${id}`,
      method: { cash: 'cash', check: 'check', credit: 'card', 'credit card': 'card', card: 'card' }[(col('PaymentMethod') || '').toLowerCase()] ?? null,
      amount_cents: collected,
      received_at: `${moveDate || estimateDate}T00:00:00.000Z`,
    } : null,
    cancelledAt: status === 'cancelled' ? usDate(row.CancelledDate) : null,
    scheduledAt: status !== 'quoted' ? usDate(row.ScheduledDate) : null,
    sensitiveRemoved: pub.removed + priv.removed,
  };
}

// ---------------------------------------------------------------- Personnel
// Headers vary ("Last Name", "LastName", " Last Name"). SSN and bank columns are never read.
function personnel(row) {
  const get = (...names) => {
    for (const [k, v] of Object.entries(row)) {
      const key = k.toLowerCase().replace(/[^a-z]/g, '');
      if (names.includes(key)) return blank(v);
    }
    return null;
  };
  const first = get('firstname', 'first');
  const last = get('lastname', 'last');
  if (!first || !last) return null;
  const email = get('email', 'emailaddress');
  return {
    legacy_id: get('personnelid', 'employeeid', 'id'), first_name: first, last_name: last,
    phone: get('phone', 'cellphone', 'homephone'), email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    address: get('address1', 'address', 'streetaddress'), city: get('city'), state: get('state')?.toUpperCase() ?? null,
    postal_code: get('zip', 'zipcode', 'postalcode'),
  };
}

module.exports = {
  advertisingSource, arrivalWindow, agent, adjustment, adjustmentCategory,
  estimate, personnel, moneyCents, usDate, accessTime, scrubSensitive, digits,
};
