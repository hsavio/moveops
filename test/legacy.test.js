const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCsv } = require('../src/legacy/csv');
const t = require('../src/legacy/transform');
const { openDb } = require('../src/db');
const { importLegacy } = require('../src/legacy/import');
const { haversineMiles } = require('../src/geo');

test('CSV parser handles quotes, CRLF and trailing blank lines', () => {
  const rows = parseCsv('\uFEFFA,B\r\n1,"x, ""y"""\r\n\r\n');
  assert.deepEqual([...rows], [{ A: '1', B: 'x, "y"' }]);
  assert.deepEqual(rows.columns, ['A', 'B']);
});

test('advertising codes are normalised but keep the legacy spelling', () => {
  assert.deepEqual(t.advertisingSource('Refferal'), { code: 'referral', label: 'Referral', legacy_value: 'Refferal' });
  assert.equal(t.advertisingSource('Yellow Pages').code, 'yellow_pages');
  assert.equal(t.advertisingSource('internet').label, 'Internet');
});

test('arrival times: ranges without am/pm and exact times', () => {
  assert.equal(t.arrivalWindow('8:00 - 9:00').start_time, '08:00');
  assert.deepEqual([t.arrivalWindow('12:00 - 1:00').start_time, t.arrivalWindow('12:00 - 1:00').end_time], ['12:00', '13:00']);
  assert.deepEqual([t.arrivalWindow('6:00 - 7:00').start_time, t.arrivalWindow('6:00 - 7:00').end_time], ['18:00', '19:00']);
  assert.equal(t.arrivalWindow('12:00 Noon').start_time, '12:00');
  assert.equal(t.arrivalWindow('7:00 pm').start_time, '19:00');
  assert.equal(t.arrivalWindow('7:00 am').end_time, null);
  assert.equal(t.arrivalWindow('whenever'), null);
});

test('adjustment categories', () => {
  const cat = (d, a) => t.adjustmentCategory(d, a);
  assert.equal(cat('McBride Tip', 100), 'tip');
  assert.equal(cat('Damage 12 of 15', -50), 'damage');
  assert.equal(cat('Damage Payment 1 of 7 ($325)', -50), 'damage');
  assert.equal(cat('Pay Advance 11/18', -200), 'advance');
  assert.equal(cat('Debt Payment -$263 - $50 = $213', -50), 'advance');
  assert.equal(cat('Gas - $160', -40), 'expense');
  assert.equal(cat('PAID Cash Stagner Job', -102), 'cash_paid');
  assert.equal(cat('Saturday Cash Payment', -80), 'cash_paid');
  assert.equal(cat('Albright Reschedule', 40), 'extra_pay');
  assert.equal(cat('Doty return', -151), 'other');
  assert.equal(t.adjustment({ AdjustmentID: '1', PersonnelID: '6', AdjustmentDescription: 'x', AdjustmentAmount: '20', AdjustmentDate: '2013-11-02' }).amount_cents, 2000);
});

test('haversine distance: Washington DC to Baltimore ≈ 35 mi', () => {
  const miles = haversineMiles({ latitude: 38.9072, longitude: -77.0369 }, { latitude: 39.2904, longitude: -76.6122 });
  assert.ok(miles > 33 && miles < 37, miles);
});

test('import is idempotent and links adjustments to placeholder crew', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
  fs.writeFileSync(path.join(dir, 'abc-AdvertisingCodes.csv'), 'AdvertisingCode\r\nRefferal\r\nRadio\r\n');
  fs.writeFileSync(path.join(dir, 'abc-ArrivalTimes.csv'), 'ArrivalTime\r\n8:00 - 9:00\r\n12:00 Noon\r\n');
  fs.writeFileSync(path.join(dir, 'abc-Agents.csv'), 'AgentID,BusinessName,FirstName,LastName,Address,City,State,Zip,BusinessPhone,AlternatePhone,FaxNumber\r\n');
  fs.writeFileSync(path.join(dir, 'abc-Adjustments.csv'),
    'AdjustmentID,PersonnelID,AdjustmentDescription,AdjustmentAmount,AdjustmentDate\n15,5,Pay Advance 11/18,-200,2013-11-15\n20,5,"McBride Tip, cash",100,2013-12-06\n');
  fs.writeFileSync(path.join(dir, 'abc-Customers.csv'), 'X\n1\n');

  const db = openDb(':memory:');
  importLegacy(db, dir);
  const { unknown } = importLegacy(db, dir); // second run must not duplicate anything
  const count = (tbl) => db.prepare(`SELECT count(*) AS n FROM ${tbl}`).get().n;
  assert.equal(count('advertising_sources'), 2);
  assert.equal(count('arrival_windows'), 2);
  assert.equal(count('crew_adjustments'), 2);
  assert.equal(count('crew_members'), 1);
  const crew = db.prepare('SELECT * FROM crew_members').get();
  assert.deepEqual([crew.last_name, crew.active, crew.legacy_id], ['#5', 0, '5']);
  assert.deepEqual(unknown, ['abc-Customers.csv']);
});

test('money, date and Access time parsing', () => {
  assert.equal(t.moneyCents('$2,200.00 '), 220000);
  assert.equal(t.moneyCents('($192.50)'), -19250);
  assert.equal(t.moneyCents('-54'), -5400);
  assert.equal(t.moneyCents(''), null);
  assert.equal(t.usDate('6/4/2017'), '2017-06-04');
  assert.equal(t.accessTime('1/1/1900 12:00'), '12:00');
  assert.equal(t.accessTime('1/1/1900 8:00'), '08:00');
});

test('card numbers and SSNs are scrubbed from notes, other text kept', () => {
  // 4111 1111 1111 1111 is the standard Visa test number (Luhn-valid).
  const r = t.scrubSensitive('Shrink wrap\r\n4111 1111 1111 1111   01/20   123\r\nSSN 123-45-6789');
  assert.equal(r.text, 'Shrink wrap\n[removed: payment card details]\n[removed: SSN]');
  assert.equal(r.removed, 2);
  assert.equal(t.scrubSensitive('call 281 785 9900 on the way').removed, 0); // phone numbers stay
});

const estimateRow = (over = {}) => ({
  EstimateID: '6805', EstimateDate: '6/14/2017', StartTime: '1/1/1900 8:00', EndTime: '1/1/1900 12:00', MoveDate: '6/24/2017',
  FirstName: 'Pat', LastName: 'Example', CompanyName: '', HomePhone: '(281) 555-0100', CellPhone: '(000) 000-0000', NewPhone: '',
  OriginApartment: '12', OriginAddress: '1 Main St', OriginCity: 'Spring', OriginState: 'TX', OriginZipCode: '77380',
  OriginStairs: '1', OriginLongWalks: '1', OriginElevatorFloors: '0', OriginDescription: 'ONE BEDROOM',
  DestinationAddress: '', DestinationCity: '', DestinationZipCode: '', DestinationStairs: '0', DestinationLongWalks: '0',
  NumberOfMen: '3', HourlyRate: '145', TripCharge: '45', MinimumHours: '2', SubTotal: '335', GrandTotal: '335',
  ClosedTotal: '480', TotalCollected: '480', Tips: '20', DiscountFlat: '25', AdjustmentFlat: '($100.00)',
  PricingMethod: 'Hourly', Status: 'Scheduled', ArrivalTime: '8:00 - 9:00', CrewNumber: '2', Miles: '18.2',
  PaymentMethod: 'Cash', Referral: 'cards', PublicNotes: 'call otw', PrivateNotes: '4111-1111-1111-1111 09-18 828', ...over,
});

test('an Estimates row becomes customer, addresses, job, quote lines and payment', () => {
  const e = t.estimate(estimateRow(), { ignored: new Set(), placeholderPhones: new Set(['0000000000']) });
  assert.equal(e.customer.phone, '(281) 555-0100');
  assert.equal(e.customer.cell_phone, null);                   // placeholder phone dropped
  assert.equal(e.job.job_number, '6805');                      // same number as the legacy paperwork
  assert.equal(e.origin.line2, 'Apt 12');
  assert.deepEqual([e.origin.stair_flights, e.origin.long_walks], [1, 1]);
  assert.equal(e.destination, null);                           // no destination entered
  assert.equal(e.job.status, 'completed');                     // Scheduled + money collected
  assert.deepEqual([e.job.arrival_window_start, e.job.arrival_window_end, e.job.est_hours], ['08:00', '09:00', 4]);
  assert.deepEqual([e.job.hourly_rate_cents, e.job.trip_charge_cents, e.job.move_addition_cents, e.job.minimum_hours], [14500, 4500, -10000, 2]);
  assert.deepEqual(e.quoteLines.map((l) => l.amount_cents), [29000, 4500]); // 2h x $145 + $45 = $335
  assert.equal(e.payment.amount_cents, 48000);
  assert.equal(e.job.internal_notes, '[removed: payment card details]');
  assert.equal(e.sensitiveRemoved, 1);
});

test('estimate status mapping', () => {
  const st = (over) => t.estimate(estimateRow({ TotalCollected: '0', ClosedTotal: '0', ...over })).job.status;
  assert.equal(st({ Status: 'Scheduled' }), 'booked');
  assert.equal(st({ Status: 'Estimate' }), 'quoted');
  assert.equal(st({ Status: 'Cancelled' }), 'cancelled');
  const itemized = t.estimate(estimateRow({ PricingMethod: 'Itemized', GrandTotal: '4797.1' }));
  assert.deepEqual(itemized.quoteLines, [{ code: 'legacy_total', description: 'Legacy itemized estimate total', amount_cents: 479710 }]);
});

test('personnel rows never carry SSNs', () => {
  const p = t.personnel({ '': '', ' Last Name': 'Doe', 'First Name': 'Jo', SocialSecurityNumber: '123-45-6789' });
  assert.deepEqual(p, { legacy_id: null, first_name: 'Jo', last_name: 'Doe', phone: null, email: null,
    address: null, city: null, state: null, postal_code: null });
  const withAddr = t.personnel({ 'Last Name': 'Doe', 'First Name': 'Jo', 'Address 1': '9 Pine St', City: 'Spring', State: 'tx', ZIP: '77380' });
  assert.deepEqual([withAddr.address, withAddr.city, withAddr.state, withAddr.postal_code], ['9 Pine St', 'Spring', 'TX', '77380']);
});

test('Estimates import: header detection, customer de-duplication, idempotent, defaults ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-est-'));
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push(estimateRow({ EstimateID: String(7000 + i), LastName: i < 2 ? 'Repeat' : `Person${i}`, HomePhone: i < 2 ? '2815550199' : `28155501${String(i).padStart(2, '0')}`,
      CellPhone: '0000000000', Status: i === 5 ? 'Cancelled' : 'Scheduled', CancelledDate: i === 5 ? '6/20/2017' : '' }));
  }
  const cols = Object.keys(rows[0]);
  const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  fs.writeFileSync(path.join(dir, 'Customers.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c] ?? '')).join(','))].join('\r\n'));
  fs.writeFileSync(path.join(dir, 'Personnel.csv'), ' Last Name,First Name,SocialSecurityNumber\nDoe,Jo,123-45-6789\n');
  fs.writeFileSync(path.join(dir, 'Personnel.xls'), 'binary');

  const db = openDb(':memory:');
  const first = importLegacy(db, dir);
  importLegacy(db, dir);
  const count = (sql) => db.prepare(sql).get().n;
  assert.equal(first.reports.find((r) => r.file === 'Customers.csv').table, 'Estimates');
  assert.deepEqual(first.unknown, ['Personnel.xls (save as CSV to import)']);
  assert.equal(count('SELECT count(*) n FROM jobs'), 25);
  assert.equal(count('SELECT count(*) n FROM customers'), 24);          // two estimates share a customer
  assert.equal(count('SELECT count(*) n FROM payments'), 25);           // a cancelled job keeps money it collected
  assert.equal(count("SELECT count(*) n FROM job_events WHERE to_status = 'cancelled'"), 1);
  assert.equal(count('SELECT count(*) n FROM customers WHERE advertising_source IS NOT NULL'), 0); // Referral constant -> ignored
  assert.equal(count("SELECT count(*) n FROM jobs WHERE internal_notes LIKE '%4111%'"), 0);
  assert.equal(count('SELECT count(*) n FROM crew_members'), 1);
  assert.equal(count("SELECT count(*) n FROM jobs WHERE quoted_total_cents = 33500"), 25);
  // Imports never touch rates: the owner's defaults ($75/h per mover, $150 trip) stay in place.
  const card = db.prepare('SELECT * FROM rate_cards').get();
  assert.deepEqual([card.per_mover_hourly_cents, card.travel_fee_cents], [7500, 15000]);
  assert.equal(count('SELECT count(*) n FROM rate_cards'), 1);
  const sensitiveWarning = first.reports.find((r) => r.table === 'Personnel').warnings.join(' ');
  assert.match(sensitiveWarning, /SocialSecurityNumber/);
});

test('legacy scheduled dates become booking events for the Activities report', () => {
  const e = t.estimate(estimateRow({ ScheduledDate: '6/15/2017' }));
  assert.equal(e.scheduledAt, '2017-06-15');
  assert.equal(t.estimate(estimateRow({ Status: 'Estimate', ScheduledDate: '6/15/2017', TotalCollected: '0', ClosedTotal: '0' })).scheduledAt, null);
});
