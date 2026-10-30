const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');

const db = openDb(':memory:');
seed(db);
const server = createApp(db, { requireAuth: false }).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const call = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const jobId = (n) => db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(n).id;

test('dashboard flags today\'s under-staffed job', async () => {
  const { body } = await call('/api/dashboard');
  assert.equal(body.jobs_today, 4);
  assert.ok(body.needs_attention >= 1);
});

test('status transitions are enforced and audited', async () => {
  const id = jobId('J-2026-00111'); // lead
  assert.equal((await call(`/api/jobs/${id}/status`, 'PATCH', { status: 'completed' })).status, 409);
  assert.equal((await call(`/api/jobs/${id}/status`, 'PATCH', { status: 'quoted' })).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM job_events WHERE job_id = ?').get(id).n, 1);
});

test('double-booking a crew member on the same day is a conflict unless forced', async () => {
  const id = jobId('J-2026-00104'); // today, unassigned
  const clash = await call(`/api/jobs/${id}/assignments`, 'PUT', { crew: [1], trucks: [] }); // Marcus is on 00101
  assert.equal(clash.status, 409);
  assert.equal(clash.body.conflicts[0].job, 'J-2026-00101');
  const forced = await call(`/api/jobs/${id}/assignments`, 'PUT', { crew: [1], trucks: [], force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.crew[0].is_lead, 1);
});

test('trucks in maintenance cannot be assigned without force', async () => {
  const res = await call(`/api/jobs/${jobId('J-2026-00105')}/assignments`, 'PUT', { crew: [], trucks: [4] });
  assert.equal(res.status, 409);
  assert.equal(res.body.conflicts[0].reason, 'maintenance');
});

test('quote preview uses the active rate card', async () => {
  const { status, body } = await call('/api/quote/preview', 'POST', { hours: 4, distanceMiles: 5 });
  assert.equal(status, 200);
  assert.ok(body.total_cents > 0);
  assert.equal((await call('/api/quote/preview', 'POST', { hours: 0 })).status, 400);
});

// ------------------------------------------------------------ directions email + crew slots
const { createMailer } = require('../src/mailer');

async function directionsServer(mailerOverride) {
  const ddb = openDb(':memory:');
  seed(ddb);
  const outbox = [];
  const mailer = mailerOverride ?? {
    configured: true,
    async send(msg) { outbox.push(msg); },
  };
  const srv = createApp(ddb, { requireAuth: false, mailer, yardAddress: '500 Yard Rd, Spring, TX 77380' }).listen(0);
  const url = `http://localhost:${srv.address().port}`;
  const req = async (path, method = 'GET', body) => {
    const res = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { ddb, outbox, srv, req, id: (n) => ddb.prepare('SELECT id FROM jobs WHERE job_number = ?').get(n).id };
}

test('directions: route yard -> pickup -> drop-off, crew-only notes, email saved and logged', async () => {
  const { ddb, outbox, srv, req, id } = await directionsServer();
  try {
    const jobId = id('J-2026-00101');
    ddb.prepare("UPDATE jobs SET notes = 'Call on the way', internal_notes = 'Owes $200 from last move' WHERE id = ?").run(jobId);
    const preview = (await req(`/api/jobs/${jobId}/directions`)).body;
    assert.equal(preview.stops.length, 3);
    assert.equal(preview.stops[0], '500 Yard Rd, Spring, TX 77380');
    assert.match(preview.maps_url, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/);
    assert.match(preview.body, /Call on the way/);
    assert.doesNotMatch(preview.body, /Owes/);              // internal notes never go to crew

    const lead = preview.crew.find((c) => c.is_lead);
    const sent = await req(`/api/jobs/${jobId}/directions/send`, 'POST', { recipients: [{ crewId: lead.id, email: 'new.lead@example.com' }] });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.sent, [lead.name]);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, 'new.lead@example.com');
    assert.match(outbox[0].text, /^Hi Marcus,/);
    assert.match(outbox[0].text, /google\.com\/maps\/dir/);
    assert.equal(ddb.prepare('SELECT email FROM crew_members WHERE id = ?').get(lead.id).email, 'new.lead@example.com');
    assert.match(ddb.prepare('SELECT note FROM job_events WHERE job_id = ? ORDER BY id DESC').get(jobId).note, /Directions emailed to Marcus Bell/);

    const bad = await req(`/api/jobs/${jobId}/directions/send`, 'POST', { recipients: [{ crewId: lead.id, email: 'not-an-email' }] });
    assert.equal(bad.status, 400);
    const notOnJob = await req(`/api/jobs/${jobId}/directions/send`, 'POST', { recipients: [{ crewId: 10, email: 'x@example.com' }] });
    assert.equal(notOnJob.status, 400);
  } finally {
    srv.close();
  }
});

test('directions: clear 503 when email is not configured', async () => {
  const { srv, req, id } = await directionsServer(createMailer({}));
  try {
    const jobId = id('J-2026-00101');
    const preview = (await req(`/api/jobs/${jobId}/directions`)).body;
    assert.equal(preview.email_configured, false);
    const res = await req(`/api/jobs/${jobId}/directions/send`, 'POST', { recipients: [{ crewId: preview.crew[0].id, email: 'a@example.com' }] });
    assert.equal(res.status, 503);
  } finally {
    srv.close();
  }
});

test('nodemailer transport builds the message', async () => {
  const mailer = createMailer({ MAIL_FROM: 'dispatch@example.com' }, { jsonTransport: true });
  const info = await mailer.send({ to: 'crew@example.com', subject: 'Job', text: 'Hi' });
  const msg = JSON.parse(info.message);
  assert.equal(msg.from.address, 'dispatch@example.com');
  assert.equal(msg.to[0].address, 'crew@example.com');
});

test('schedule lanes are crew slots; future jobs without crew are not flagged', async () => {
  const { body } = await call('/api/schedule');
  assert.deepEqual(body.lanes.map((l) => l.name), ['Crew 1', 'Crew 2', 'Crew 3']);
  assert.ok(body.lanes[0].jobs.some((j) => j.job_number === 'J-2026-00101'));
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA');
  const future = (await call(`/api/jobs?from=${tomorrow}&to=${tomorrow}`)).body;
  assert.ok(future.length > 0 && future.every((j) => j.crew.length === 0 && j.warnings.length === 0));

  const res = await call(`/api/jobs/${jobId('J-2026-00106')}/assignments`, 'PUT', { crew: [], trucks: [], crewNumber: 5 });
  assert.equal(res.body.crew_number, 5);
  assert.equal((await call(`/api/jobs/${jobId('J-2026-00106')}/assignments`, 'PUT', { crewNumber: -1 })).status, 400);
});

// ------------------------------------------------------------ extra stops
test('extra stops: saved in order, kept when omitted, in crew directions and the customer email', async () => {
  const { srv, req } = await directionsServer();
  try {
    const stop = (line1, kind) => ({ kind, line1, city: 'Spring', state: 'TX', postal_code: '77380', stair_flights: 2 });
    const created = await req('/api/estimates', 'POST', {
      customer: { first_name: 'Sam', last_name: 'Ortiz', email: 'sam@example.com' },
      origin: { line1: '12 Elm St', city: 'Spring', state: 'TX', postal_code: '77380' },
      destination: { line1: '9 Oak Ave', city: 'Conroe', state: 'TX', postal_code: '77301' },
      stops: [stop('7 Storage Way', 'pickup'), { kind: 'pickup', line1: '  ' }, stop('3 Daughter Ln', 'dropoff')],
      job: { move_date: '2026-11-20', crew_size: 2, est_hours: 3, minimum_hours: 2, hourly_rate_cents: 15000, trip_charge_cents: 15000 },
    });
    assert.equal(created.status, 201);
    const id = created.body.job.id;
    assert.deepEqual(created.body.stops.map((s) => [s.line1, s.kind, s.stair_flights]), [['7 Storage Way', 'pickup', 2], ['3 Daughter Ln', 'dropoff', 2]]);

    const d = (await req(`/api/jobs/${id}/directions`)).body;
    assert.deepEqual(d.stops, ['500 Yard Rd, Spring, TX 77380', '12 Elm St, Spring, TX 77380', '7 Storage Way, Spring, TX 77380',
      '3 Daughter Ln, Spring, TX 77380', '9 Oak Ave, Conroe, TX 77301']);
    assert.match(d.body, /Stop 1, pickup: 7 Storage Way.*2 flight\(s\) of stairs/);
    assert.match(d.body, /Stop 2, drop-off: 3 Daughter Ln/);
    assert.match(d.body, /yard → pickup → 2 stops → drop-off/);

    const { renderEmail } = require('../src/documents');
    const est = (await req(`/api/estimates/${id}`)).body;
    assert.match(renderEmail('proposal', est, {}).text, /From: 12 Elm St[\s\S]*Stop 1 \(pickup\): 7 Storage Way[\s\S]*Stop 2 \(drop-off\): 3 Daughter Ln[\s\S]*To: 9 Oak Ave/);

    // Saving without a stops list leaves them alone; a new list replaces them (reordered, one removed).
    const body = { customer: { id: est.customer.id }, origin: est.origin, destination: est.destination, job: { notes: 'x' } };
    assert.equal((await req(`/api/estimates/${id}`, 'PUT', body)).body.stops.length, 2);
    const reordered = await req(`/api/estimates/${id}`, 'PUT', { ...body, stops: [est.stops[1]] });
    assert.deepEqual(reordered.body.stops.map((s) => [s.id, s.line1]), [[est.stops[1].id, '3 Daughter Ln']]);

    assert.equal((await req(`/api/estimates/${id}`, 'PUT', { ...body, stops: Array.from({ length: 11 }, (_, i) => stop(`${i} A St`, 'pickup')) })).status, 400);
    assert.equal((await req(`/api/estimates/${id}`, 'PUT', { ...body, stops: [stop('1 A St', 'storage')] })).status, 400);
  } finally {
    srv.close();
  }
});
