const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');

const db = openDb(':memory:');
seed(db);
const server = createApp(db, { mailer: { configured: false } }).listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const call = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };
const jobId = (n) => db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(n).id;

test('calendar lists moves (tentative while quoted), call-backs and site visits in range', async () => {
  db.prepare("UPDATE jobs SET callback_date = ? WHERE job_number = 'J-2026-00107'").run(day(1));
  db.prepare("UPDATE jobs SET site_visit_at = ? WHERE job_number = 'J-2026-00111'").run(`${day(2)}T10:30`);
  const { status, body } = await call(`/api/calendar?from=${day(0)}&to=${day(6)}`);
  assert.equal(status, 200);
  const moves = body.events.filter((e) => e.type === 'move');
  assert.ok(moves.length >= 8);
  assert.ok(moves.every((m) => m.date >= day(0) && m.date <= day(6)));
  assert.equal(moves.find((m) => m.job_number === 'J-2026-00107').tentative, true);   // quoted
  assert.equal(moves.find((m) => m.job_number === 'J-2026-00101').tentative, false);  // dispatched
  assert.deepEqual(body.events.filter((e) => e.type === 'callback').map((e) => [e.job_number, e.date]), [['J-2026-00107', day(1)]]);
  assert.deepEqual(body.events.filter((e) => e.type === 'visit').map((e) => [e.date, e.time]), [[day(2), '10:30']]);
});

test('cancelled jobs are left off; ranges are validated', async () => {
  await call(`/api/jobs/${jobId('J-2026-00108')}/status`, 'PATCH', { status: 'cancelled' });
  const { body } = await call(`/api/calendar?from=${day(0)}&to=${day(6)}`);
  assert.ok(!body.events.some((e) => e.job_number === 'J-2026-00108'));
  assert.equal((await call(`/api/calendar?from=${day(5)}&to=${day(0)}`)).status, 400);
  assert.equal((await call(`/api/calendar?from=2026-01-01&to=2026-12-31`)).status, 400);
});

test('day notes: save, show on the calendar and dashboard schedule, clear', async () => {
  const saved = await call(`/api/day-notes/${day(0)}`, 'PUT', { notes: 'Truck 2 at the shop until noon' });
  assert.equal(saved.status, 200);
  assert.equal((await call(`/api/calendar?from=${day(0)}&to=${day(0)}`)).body.notes[day(0)], 'Truck 2 at the shop until noon');
  assert.equal((await call(`/api/schedule?date=${day(0)}`)).body.note, 'Truck 2 at the shop until noon');
  assert.equal((await call(`/api/day-notes/${day(0)}`, 'PUT', { notes: 'card 4111 1111 1111 1111' })).status, 400);
  await call(`/api/day-notes/${day(0)}`, 'PUT', { notes: '' });
  assert.deepEqual((await call(`/api/calendar?from=${day(0)}&to=${day(0)}`)).body.notes, {});
});

test('marking a call-back done clears it and logs it', async () => {
  const id = jobId('J-2026-00107');
  db.prepare('UPDATE jobs SET callback_date = ? WHERE id = ?').run(day(1), id);
  await call(`/api/jobs/${id}/callback-done`, 'POST', { note: 'Left voicemail' });
  const { body } = await call(`/api/calendar?from=${day(0)}&to=${day(6)}`);
  assert.ok(!body.events.some((e) => e.type === 'callback' && e.job_id === id));
  assert.equal(db.prepare('SELECT note FROM job_events WHERE job_id = ? ORDER BY id DESC').get(id).note, 'Call-back done: Left voicemail');
});
