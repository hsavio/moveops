const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');

const db = openDb(':memory:');
seed(db);
const server = createApp(db, { mailer: { configured: false }, requireAuth: false }).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const call = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.toLocaleDateString('en-CA'); };
const jobId = (n) => db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(n).id;
const status = (n, s) => call(`/api/jobs/${jobId(n)}/status`, 'PATCH', { status: s, sendConfirmation: false });

test('activities: estimates, scheduled, cancelled and moved in the period, with totals', async () => {
  await status('J-2026-00107', 'booked');                                // quoted -> booked today
  await status('J-2026-00112', 'cancelled');                             // quoted -> cancelled today
  const { body } = await call(`/api/reports/activities?from=${day(-7)}&to=${day(7)}`);
  const s = Object.fromEntries(body.sections.map((x) => [x.key, x]));
  assert.equal(s.estimates.totals.count, 12);                             // all demo estimates were created today
  assert.deepEqual(s.scheduled.rows.map((r) => r.job_number), ['J-2026-00107']);
  assert.equal(s.scheduled.rows[0].event_date, day(0));
  assert.deepEqual(s.cancelled.rows.map((r) => r.job_number), ['J-2026-00112']);
  assert.deepEqual(s.moved.rows.map((r) => r.job_number).sort(), ['J-2026-00109', 'J-2026-00110']);
  assert.equal(s.moved.totals.estimated_cents, s.moved.rows.reduce((t, r) => t + r.quoted_total_cents, 0));
  assert.equal((await call(`/api/reports/activities?from=${day(1)}&to=${day(0)}`)).status, 400);
});

test('unpaid moves: balance after payments, days since move, phones; paid moves drop off', async () => {
  const id = jobId('J-2026-00109');
  await call(`/api/estimates/${id}/closeout`, 'PUT', { actual_hours: 5 });
  await call(`/api/estimates/${id}/payments`, 'POST', { method: 'cash', amount_cents: 50000 });
  const { body } = await call(`/api/reports/unpaid?from=${day(-30)}&to=${day(0)}`);
  const row = body.rows.find((r) => r.job_number === 'J-2026-00109');
  assert.equal(row.balance_cents, row.final_total_cents - 50000);
  assert.equal(row.days_since_move, 1);
  assert.ok(row.phone);
  await call(`/api/estimates/${id}/payments`, 'POST', { method: 'check', amount_cents: row.balance_cents, reference: '1001' });
  assert.ok(!(await call(`/api/reports/unpaid?from=${day(-30)}&to=${day(0)}`)).body.rows.some((r) => r.job_number === 'J-2026-00109'));
});

test('booking commission: percent of the total per agent, owed until marked paid', async () => {
  const agent = (await call('/api/agents', 'POST', { business_name: 'Lakeside Realty', first_name: 'Ana', last_name: 'Cole', commission_percent: 10 })).body;
  assert.equal(agent.commission_percent, 10);
  for (const n of ['J-2026-00105', 'J-2026-00106']) await call(`/api/estimates/${jobId(n)}`, 'PUT', { job: { agent_id: agent.id } });
  const r = (await call(`/api/reports/commissions?from=${day(0)}&to=${day(7)}`)).body;
  assert.equal(r.rows.length, 2);
  const first = r.rows.find((x) => x.job_number === 'J-2026-00105');
  assert.equal(first.commission_cents, Math.round(first.quoted_total_cents * 0.1));
  assert.equal(r.totals.owed_cents, r.totals.commission_cents);
  await call(`/api/jobs/${jobId('J-2026-00105')}/commission-paid`, 'POST', { paid: true });
  const after = (await call(`/api/reports/commissions?from=${day(0)}&to=${day(7)}`)).body;
  assert.equal(after.totals.owed_cents, after.totals.commission_cents - first.commission_cents);
  assert.equal((await call(`/api/reports/commissions?from=${day(0)}&to=${day(7)}&unpaid=1`)).body.rows.length, 1);
  await status('J-2026-00106', 'cancelled');                             // cancelled moves earn nothing
  assert.equal((await call(`/api/reports/commissions?from=${day(0)}&to=${day(7)}&unpaid=1`)).body.rows.length, 0);
});

test('agents: validation, edit, deactivate hides them from the estimate form', async () => {
  assert.equal((await call('/api/agents', 'POST', { first_name: 'No' })).status, 400);
  assert.equal((await call('/api/agents', 'POST', { last_name: 'Ng', commission_percent: 150 })).status, 400);
  const a = (await call('/api/agents', 'POST', { last_name: 'Ng', email: 'ng@example.com' })).body;
  await call(`/api/agents/${a.id}`, 'PUT', { ...a, active: false });
  assert.ok(!(await call('/api/lookups')).body.agents.some((x) => x.id === a.id));
  assert.ok((await call('/api/agents?all=1')).body.some((x) => x.id === a.id));
});
