const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { payWeek, TAX1099_COLUMNS } = require('../src/payroll');
const { parseCsv } = require('../src/legacy/csv');

const db = openDb(':memory:');
seed(db);
const server = createApp(db, { mailer: { configured: false } }).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const call = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
};
const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.toLocaleDateString('en-CA'); };
const jobId = (n) => db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(n).id;
const workerId = (first) => db.prepare('SELECT id FROM crew_members WHERE first_name = ?').get(first).id;

test('personnel: create, edit; SSNs and licence numbers are refused', async () => {
  const w = await call('/api/personnel', 'POST', { first_name: 'Rita', last_name: 'Gomez', role: 'driver', pay_type: 'split', split_percent: 18,
    address: '5 Oak Ln', city: 'Conroe', state: 'tx', postal_code: '77301', w9_status: 'received' });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.equal(w.body.state, 'TX');
  assert.equal(w.body.w9_received_on, day(0));
  const edit = await call(`/api/personnel/${w.body.id}`, 'PUT', { ...w.body, split_percent: 20, in_tax1099: true });
  assert.deepEqual([edit.body.split_percent, edit.body.in_tax1099], [20, 1]);
  assert.equal((await call('/api/personnel', 'POST', { first_name: 'A', last_name: 'B', split_percent: 10, ssn: '123-45-6789' })).status, 400);
  assert.equal((await call('/api/personnel', 'POST', { first_name: 'A', last_name: 'B', split_percent: 10, notes: 'SSN 123-45-6789' })).status, 400);
  assert.equal((await call('/api/personnel', 'POST', { first_name: 'A', last_name: 'B', pay_type: 'split', split_percent: 0 })).status, 400);
});

test('weekly payroll: split pay, tip shares, adjustments; mark paid and undo', async () => {
  const id = jobId('J-2026-00109');                       // completed yesterday, crew Marcus (lead), Sam (driver), Leo (mover)
  await call(`/api/estimates/${id}/closeout`, 'PUT', { actual_hours: 5, tips_cents: 9000 });
  const total = db.prepare('SELECT final_total_cents FROM jobs WHERE id = ?').get(id).final_total_cents;
  await call(`/api/personnel/${workerId('Leo')}/adjustments`, 'POST', { amount_cents: -5000, category: 'advance', description: 'Pay advance', adjustment_date: day(-1) });

  const wk = (await call(`/api/payroll?date=${day(-1)}`)).body;
  assert.deepEqual(wk.week, payWeek(day(-1)));
  const leo = wk.workers.find((w) => w.worker.first_name === 'Leo');
  const marcus = wk.workers.find((w) => w.worker.first_name === 'Marcus');
  const job = leo.jobs.find((j) => j.job_number === 'J-2026-00109');
  assert.equal(job.amount_cents, Math.round(total * 0.12));               // mover 12%
  assert.equal(marcus.jobs.find((j) => j.job_number === 'J-2026-00109').amount_cents, Math.round(total * 0.16)); // lead 16%
  assert.equal(job.tip_share_cents, 3000);                                // $90 tips / 3 crew
  assert.equal(leo.total_cents, leo.job_pay_cents + leo.tips_cents - 5000);

  const paid = await call('/api/payroll/pay', 'POST', { date: day(-1), crew_member_ids: [workerId('Leo')], method: 'check', reference: '2201' });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  const leoPaid = paid.body.workers.find((w) => w.worker.first_name === 'Leo');
  assert.equal(leoPaid.payout.total_cents, leo.total_cents);
  assert.equal(leoPaid.payout.pay_date, wk.week.payDate);
  assert.equal((await call('/api/payroll/pay', 'POST', { date: day(-1), crew_member_id: workerId('Leo') })).status, 409);

  // a paid week's adjustments are locked; undoing the payment unlocks them
  const adj = db.prepare('SELECT id FROM crew_adjustments WHERE crew_member_id = ?').get(workerId('Leo'));
  assert.equal((await call(`/api/adjustments/${adj.id}`, 'DELETE')).status, 409);
  await call(`/api/payroll/pay/${leoPaid.payout.id}`, 'DELETE');
  assert.equal((await call(`/api/adjustments/${adj.id}`, 'DELETE')).status, 200);
});

test('payroll flags moves in the week that are not closed out yet', async () => {
  const wk = (await call(`/api/payroll?date=${day(0)}`)).body;
  assert.ok(wk.not_closed.some((j) => j.job_number === 'J-2026-00101'));
});

test('1099s: yearly totals by pay date, threshold, TAX1099 CSV without TINs', async () => {
  const wk = (await call(`/api/payroll?date=${day(-1)}`)).body;
  const ids = wk.workers.filter((w) => !w.payout).map((w) => w.worker.id);
  await call('/api/payroll/pay', 'POST', { date: day(-1), crew_member_ids: ids, method: 'cash' });
  await call('/api/settings', 'PUT', { settings: { company_name: 'Demo Movers', company_address: '1 Main St', company_city_state_zip: 'Conroe, TX 77384', payer_ein: '123456789' } });
  const year = Number(wk.week.payDate.slice(0, 4));
  const s = (await call(`/api/tax1099?year=${year}&threshold_cents=0`)).body;
  assert.deepEqual(s.payer_missing, []);
  assert.equal(s.recipients.length, ids.length);
  const csv = (await call(`/api/tax1099/export?year=${year}&threshold_cents=0`)).body;
  const rows = parseCsv(csv);
  assert.deepEqual(rows.columns, TAX1099_COLUMNS);
  assert.equal(rows.length, ids.length);
  assert.deepEqual([rows[0]['Payer Type'], rows[0]['Payer TIN'], rows[0]['Payer Business Name or Last Name'], rows[0]['Payer State']],
    ['Business', '12-3456789', 'Demo Movers', 'TX']);
  assert.ok(rows.every((r) => r['Recipient TIN'] === ''));               // never exported: MoveOps holds no SSNs
  // default threshold leaves out small totals
  assert.equal((await call(`/api/tax1099?year=${year}`)).body.recipients.filter((r) => r.needs_1099).length, 0);
  assert.equal((await call('/api/settings', 'PUT', { settings: { payer_ein: '123-45-6789' } })).status, 400);
});
