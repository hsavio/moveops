const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { hashPassword, verifyPassword } = require('../src/auth');

const db = openDb(':memory:');
seed(db);
const server = createApp(db, { mailer: { configured: false } }).listen(0); // logins ON
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

// A tiny cookie-keeping client.
function client() {
  let cookie = '';
  return async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + path, { method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers, cookie: set };
  };
}

test('passwords are salted scrypt hashes', () => {
  const h = hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$16384\$/);
  assert.notEqual(h, hashPassword('correct horse battery'));
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
});

test('everything is locked until the first admin is set up; setup works only once', async () => {
  const anon = client();
  assert.equal((await anon('/api/estimates')).status, 401);
  const page = await anon('/estimates.html');
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /^\/login\.html\?next=/);
  assert.equal((await anon('/login.html')).status, 200);
  assert.equal((await anon('/styles.css')).status, 200);
  assert.deepEqual((await anon('/api/auth/status')).body, { setup_needed: true, user: null });

  const owner = client();
  assert.equal((await owner('/api/auth/setup', 'POST', { username: 'phil', display_name: 'Phil', password: 'short' })).status, 400);
  const setup = await owner('/api/auth/setup', 'POST', { username: 'phil', display_name: 'Phil', password: 'a-long-enough-password' });
  assert.equal(setup.status, 201);
  assert.match(setup.cookie, /HttpOnly; SameSite=Lax/);
  assert.equal((await owner('/api/estimates')).status, 200);
  assert.equal((await anon('/api/auth/setup', 'POST', { username: 'evil', password: 'another-long-password' })).status, 409);
});

test('login, wrong password, lockout after repeated failures, logout', async () => {
  const c = client();
  assert.equal((await c('/api/auth/login', 'POST', { username: 'phil', password: 'nope' })).status, 401);
  assert.equal((await c('/api/auth/login', 'POST', { username: 'PHIL', password: 'a-long-enough-password' })).status, 200); // usernames ignore case
  assert.equal((await c('/api/auth/me')).body.user.role, 'admin');
  await c('/api/auth/logout', 'POST', {});
  assert.equal((await c('/api/estimates')).status, 401);

  const attacker = client();
  for (let i = 0; i < 5; i++) await attacker('/api/auth/login', 'POST', { username: 'phil', password: `guess${i}` });
  const locked = await attacker('/api/auth/login', 'POST', { username: 'phil', password: 'a-long-enough-password' });
  assert.equal(locked.status, 429);
});

test('office staff can work estimates but not pay, personnel, rates or users', async () => {
  const admin = client();
  // the lockout above is per username + address, so sign in as a fresh admin created directly
  db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('boss', 'Boss', ?, 'admin')").run(hashPassword('boss-password-123'));
  assert.equal((await admin('/api/auth/login', 'POST', { username: 'boss', password: 'boss-password-123' })).status, 200);
  const created = await admin('/api/users', 'POST', { username: 'amy', display_name: 'Amy', role: 'office', password: 'temporary-pass-1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.must_change_password, true);

  const amy = client();
  await amy('/api/auth/login', 'POST', { username: 'amy', password: 'temporary-pass-1' });
  assert.equal((await amy('/api/estimates')).status, 200);
  assert.equal((await amy('/api/settings')).status, 200);                    // reading rates for the estimate form is fine
  assert.equal((await amy('/api/payroll')).status, 403);
  assert.equal((await amy('/api/personnel')).status, 403);
  assert.equal((await amy('/api/tax1099')).status, 403);
  assert.equal((await amy('/api/users')).status, 403);
  assert.equal((await amy('/api/rate-card', 'PUT', { per_mover_hourly_cents: 1, travel_fee_cents: 0 })).status, 403);
  const crewPage = await amy('/payroll.html');
  assert.equal(crewPage.status, 302);

  // history records the signed-in person, not what the browser claims
  const est = (await amy('/api/estimates')).body[0];
  await amy(`/api/jobs/${est.id}/callback-done`, 'POST', { actor: 'Somebody else' });
  assert.equal(db.prepare('SELECT actor FROM job_events WHERE job_id = ? ORDER BY id DESC').get(est.id).actor, 'Amy');

  // changing password clears the flag; deactivating signs her out
  assert.equal((await amy('/api/auth/password', 'POST', { current_password: 'temporary-pass-1', new_password: 'fresh-secret-pw' })).status, 200);
  assert.equal((await amy('/api/auth/me')).body.user.must_change_password, false);
  await admin(`/api/users/${created.body.id}`, 'PUT', { active: false });
  assert.equal((await amy('/api/estimates')).status, 401);
});

test('the last admin cannot be removed; cross-site style requests are refused', async () => {
  const admin = client();
  await admin('/api/auth/login', 'POST', { username: 'boss', password: 'boss-password-123' });
  const phil = db.prepare("SELECT id FROM users WHERE username = 'phil'").get().id;
  const boss = db.prepare("SELECT id FROM users WHERE username = 'boss'").get().id;
  assert.equal((await admin(`/api/users/${phil}`, 'PUT', { active: false })).status, 200);
  assert.equal((await admin(`/api/users/${boss}`, 'PUT', { role: 'office' })).status, 409);
  // a form post (text/plain) can't change anything, even with a valid session
  const form = await admin('/api/day-notes/2026-11-01', 'PUT', undefined, { 'Content-Type': 'text/plain' });
  assert.equal(form.status, 415);
});
