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
