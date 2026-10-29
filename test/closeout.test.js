const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { renderEmail } = require('../src/documents');

const db = openDb(':memory:');
seed(db);
db.prepare("UPDATE settings SET value = 'Demo Movers' WHERE key = 'company_name'").run();
const outbox = [];
const server = createApp(db, { requireAuth: false, mailer: { configured: true, async send(m) { outbox.push(m); } } }).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const call = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

async function estimate(job = {}, customer = {}) {
  const { body } = await call('/api/estimates', 'POST', {
    customer: { first_name: 'Pat', last_name: 'Rivera', email: 'pat@example.com', ...customer },
    origin: { line1: '12 Elm St', city: 'Spring', state: 'TX', postal_code: '77380' },
    destination: { line1: '9 Oak Ave', city: 'Conroe', state: 'TX', postal_code: '77301' },
    job: { move_date: '2026-11-20', arrival_window_start: '08:00', arrival_window_end: '09:00', crew_size: 3, est_hours: 4,
      minimum_hours: 2, hourly_rate_cents: 22500, trip_charge_cents: 15000, notes: 'Gate code 1234', internal_notes: 'Slow payer', ...job },
  });
  return body;
}

test('accepting a quote emails the customer a confirmation (crew-safe content, logged)', async () => {
  const est = await estimate();
  outbox.length = 0;
  await call(`/api/jobs/${est.job.id}/status`, 'PATCH', { status: 'quoted' });
  const r = await call(`/api/jobs/${est.job.id}/status`, 'PATCH', { status: 'booked' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.confirmation, { sent: true, to: 'pat@example.com' });
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].subject, /Your move is booked: Friday, November 20, 2026/);
  assert.match(outbox[0].text, /between 8:00 am and 9:00 am/);
  assert.match(outbox[0].text, /Gate code 1234/);
  assert.doesNotMatch(outbox[0].text + outbox[0].html, /Slow payer/);  // office-only notes never go out
  assert.match(outbox[0].html, /Demo Movers/);
  const hist = (await call(`/api/estimates/${est.job.id}`)).body.history;
  assert.ok(hist.some((h) => h.note === 'Confirmation emailed to pat@example.com'));
});

test('booking still works without a customer email; the reason is reported', async () => {
  const est = await estimate({}, { email: null });
  await call(`/api/jobs/${est.job.id}/status`, 'PATCH', { status: 'quoted' });
  const r = await call(`/api/jobs/${est.job.id}/status`, 'PATCH', { status: 'booked' });
  assert.equal(r.body.status, 'booked');
  assert.deepEqual(r.body.confirmation, { sent: false, reason: 'The customer has no email address' });
});

test('email a proposal on demand; preview without sending', async () => {
  const est = await estimate();
  outbox.length = 0;
  const preview = await call(`/api/estimates/${est.job.id}/email/proposal`);
  assert.match(preview.body.subject, /Moving proposal #\d+ from Demo Movers/);
  assert.equal(outbox.length, 0);
  const sent = await call(`/api/estimates/${est.job.id}/email`, 'POST', { kind: 'proposal' });
  assert.equal(sent.status, 200);
  assert.equal(outbox[0].to, 'pat@example.com');
  assert.match(outbox[0].text, /billed for the actual time at \$225\.00 per hour for 3 movers \(2 hour minimum\)/);
  assert.equal((await call(`/api/estimates/${est.job.id}/email`, 'POST', { kind: 'letter' })).status, 400);
});

test('closeout: actual times give the final bill; payments and balance; invoice email', async () => {
  const est = await estimate();
  const c = await call(`/api/estimates/${est.job.id}/closeout`, 'PUT', { actual_start_time: '08:10', actual_end_time: '13:25', tips_cents: 4000 });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.job.actual_hours, 5.25);
  assert.equal(c.body.job.final_total_cents, 5.25 * 22500 + 15000);
  assert.equal(c.body.job.tips_cents, 4000);
  assert.equal(c.body.closeout.billable_hours, 5.25);

  const dep = await call(`/api/estimates/${est.job.id}/payments`, 'POST', { kind: 'deposit', method: 'card', amount_cents: 20000, reference: '4242 auth 123456' });
  assert.equal(dep.status, 201, JSON.stringify(dep.body));
  const pay = await call(`/api/estimates/${est.job.id}/payments`, 'POST', { method: 'check', amount_cents: 50000, reference: 'Check 1043', received_at: '2026-11-20' });
  assert.equal(pay.body.paid_cents, 70000);
  assert.equal(pay.body.balance_cents, 5.25 * 22500 + 15000 - 70000);

  outbox.length = 0;
  await call(`/api/estimates/${est.job.id}/email`, 'POST', { kind: 'invoice' });
  assert.match(outbox[0].subject, /Invoice #/);
  assert.match(outbox[0].text, /Balance due: \$631\.25/);
  assert.match(outbox[0].text, /8:10 am to 1:25 pm/);

  const del = await call(`/api/estimates/${est.job.id}/payments/${pay.body.payments.at(-1).id}`, 'DELETE');
  assert.equal(del.body.paid_cents, 20000);
});

test('closeout: not-to-exceed caps the bill, typed final total overrides, binding keeps its price', async () => {
  const nte = await estimate({ estimate_type: 'not_to_exceed', not_to_exceed_cents: 100000 });
  const capped = (await call(`/api/estimates/${nte.job.id}/closeout`, 'PUT', { actual_hours: 7 })).body;
  assert.deepEqual([capped.job.final_total_cents, capped.closeout.capped], [100000, true]);
  const manual = (await call(`/api/estimates/${nte.job.id}/closeout`, 'PUT', { actual_hours: 7, final_total_cents: 95000 })).body;
  assert.deepEqual([manual.job.final_total_cents, manual.job.final_total_manual], [95000, 1]);
  const fixed = await estimate({ pricing_method: 'fixed', fixed_price_cents: 120000 });
  assert.equal((await call(`/api/estimates/${fixed.job.id}/closeout`, 'PUT', {})).body.job.final_total_cents, 120000);
  assert.equal((await call(`/api/estimates/${fixed.job.id}/closeout`, 'PUT', { actual_start_time: '14:00', actual_end_time: '09:00' })).status, 400);
});

test('payments never hold card numbers', async () => {
  const est = await estimate();
  const full = await call(`/api/estimates/${est.job.id}/payments`, 'POST', { method: 'card', amount_cents: 100, reference: '4111 1111 1111 1111' });
  assert.equal(full.status, 400);
  const partial = await call(`/api/estimates/${est.job.id}/payments`, 'POST', { method: 'card', amount_cents: 100, reference: '411111111111' });
  assert.equal(partial.status, 400);
  assert.equal((await call(`/api/estimates/${est.job.id}/payments`, 'POST', { method: 'card', amount_cents: 0 })).status, 400);
});

test('invoice email for a paid-in-full binding job', () => {
  const est = {
    job: { job_number: '11542', pricing_method: 'fixed', estimate_type: 'binding', final_total_cents: 50000, move_date: '2026-11-20' },
    customer: { first_name: 'Sam' }, origin: null, destination: null,
    price: { lines: [{ description: 'Moving services (fixed price)', amount_cents: 50000 }], total_cents: 50000 },
    closeout: { lines: [{ description: 'Moving services (fixed price)', amount_cents: 50000 }], total_cents: 50000 }, paid_cents: 50000,
  };
  const m = renderEmail('invoice', est, { company_name: 'Demo Movers', proposal_terms: '' });
  assert.match(m.text, /Paid in full/);
  assert.match(m.html, /^<div/);
});

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('logo: upload PNG, refuse SVG/HTML, serve it, embed it in customer emails', async () => {
  const up = await fetch(`${base}/api/settings/logo`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).logo.mime, 'image/png');
  const svg = await fetch(`${base}/api/settings/logo`, { method: 'PUT', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg onload="alert(1)"/>' });
  assert.equal(svg.status, 415);
  const lie = await fetch(`${base}/api/settings/logo`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: '<html>not a png</html>' });
  assert.equal(lie.status, 415);
  const big = await fetch(`${base}/api/settings/logo`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]) });
  assert.equal(big.status, 413);

  const got = await fetch(`${base}/api/settings/logo`);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(PNG));
  assert.equal((await call('/api/settings')).body.logo.mime, 'image/png');

  const est = await estimate();
  outbox.length = 0;
  await call(`/api/estimates/${est.job.id}/email`, 'POST', { kind: 'proposal' });
  assert.match(outbox[0].html, /<img src="cid:company-logo"/);
  assert.equal(outbox[0].attachments[0].cid, 'company-logo');

  await call('/api/settings/logo', 'DELETE');
  assert.equal((await fetch(`${base}/api/settings/logo`)).status, 404);
  outbox.length = 0;
  await call(`/api/estimates/${est.job.id}/email`, 'POST', { kind: 'proposal' });
  assert.doesNotMatch(outbox[0].html, /cid:/);
});
