const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/payroll');

test('pay week is Saturday-Friday, paid the following Wednesday', () => {
  for (const d of ['2026-10-24', '2026-10-27', '2026-10-30']) {           // Sat, Tue, Fri of the same week
    assert.deepEqual(p.payWeek(d), { start: '2026-10-24', end: '2026-10-30', payDate: '2026-11-04' });
  }
  assert.equal(p.payWeek('2026-10-31').start, '2026-10-31');              // next Saturday starts a new week
  assert.equal(p.payWeek('2027-01-01').payDate, '2027-01-06');            // across a year end
});

test('tips split evenly; leftover cents go to the first crew members', () => {
  const s = p.tipShares(10000, [7, 3, 5]);
  assert.deepEqual([s.get(3), s.get(5), s.get(7)], [3334, 3333, 3333]);
  assert.equal([...s.values()].reduce((a, b) => a + b, 0), 10000);
  assert.equal(p.tipShares(0, [1]).size, 0);
});

test('split pay is a percent of the job total (tips excluded); hourly uses actual hours', () => {
  const job = { final_total_cents: 120000, quoted_total_cents: 100000, actual_hours: 5.5, est_hours: 4 };
  assert.equal(p.jobPay({ pay_type: 'split', split_percent: 20 }, job).amount_cents, 24000);     // driver
  assert.equal(p.jobPay({ pay_type: 'split', split_percent: 15 }, job).amount_cents, 18000);     // mover
  assert.equal(p.jobPay({ pay_type: 'split', split_percent: 15 }, { quoted_total_cents: 100000 }).amount_cents, 15000);
  assert.equal(p.jobPay({ pay_type: 'hourly', wage_cents: 1800 }, job).amount_cents, 9900);
  assert.equal(p.jobPay({ pay_type: 'hourly', wage_cents: 1800 }, { est_hours: 4 }).amount_cents, 7200);
});

test('a worker\'s week: jobs + tip shares + adjustments', () => {
  const w = p.workerWeek({ pay_type: 'split', split_percent: 20 },
    [{ id: 1, job_number: '11541', final_total_cents: 100000, tip_share_cents: 2000 }, { id: 2, job_number: '11542', quoted_total_cents: 50000 }],
    [{ id: 9, adjustment_date: '2026-10-27', category: 'advance', description: 'Pay advance', amount_cents: -5000 }]);
  assert.deepEqual([w.job_pay_cents, w.tips_cents, w.adjustments_cents, w.total_cents], [30000, 2000, -5000, 27000]);
  assert.equal(w.jobs[0].basis, '20% of $1000.00');
});

test('TAX1099 rows follow the template columns and never carry a recipient TIN', () => {
  const rows = p.tax1099Rows(
    { company_name: 'All The Right Moves', company_address: '110 FM 1488 Rd', company_city_state_zip: 'Conroe TX 77384', company_phone: '(281) 785-9900', payer_ein: '12-3456789' },
    [{ worker: { id: 4, first_name: 'Sam', last_name: 'Kowalski', address: '9 Pine St', city: 'Spring', state: 'TX', postal_code: '77380' }, total_cents: 1234567 }]);
  assert.deepEqual(Object.keys(rows[0]), p.TAX1099_COLUMNS);
  assert.equal(p.TAX1099_COLUMNS.length, 58);
  assert.equal(rows[0]['Box 1 Nonemployee Compensation'], '12345.67');
  assert.deepEqual([rows[0]['Payer City'], rows[0]['Payer State'], rows[0]['Payer ZIP or Foreign Postal Code']], ['Conroe', 'TX', '77384']);
  assert.equal(rows[0]['Recipient TIN'], '');
  assert.equal(rows[0]['Client RecipientID'], 'MO-4');
  assert.deepEqual(p.splitCityStateZip('Conroe, tx 77384-1234'), { city: 'Conroe', state: 'TX', zip: '77384-1234' });
});

test('1099-NEC threshold: $600 through 2025, $2,000 from 2026', () => {
  assert.equal(p.necThresholdCents(2025), 60000);
  assert.equal(p.necThresholdCents(2026), 200000);
});
