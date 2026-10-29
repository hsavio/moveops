// Office logins: password hashing, sessions, login throttling and access rules.
// Crew never log in. Two roles: admin (everything) and office (no pay, personnel, rates or users).
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const COOKIE = 'mo_session';
const SESSION_DAYS = 14;
const MIN_PASSWORD = 10;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

// ------------------------------------------------------------ passwords
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, n, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

function checkPasswordRules(password, username) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`;
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) return 'The password must not contain the username';
  return null;
}

// ------------------------------------------------------------ sessions
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  return Object.fromEntries(String(header || '').split(';').map((p) => p.trim().split('=')).filter(([k, v]) => k && v)
    .map(([k, v]) => [k, decodeURIComponent(v)]));
}

function createAuth(db, { secureCookies = process.env.COOKIE_SECURE === '1' } = {}) {
  const failures = new Map(); // key -> { count, until }

  function cookie(res, value, maxAgeSeconds, req) {
    const secure = secureCookies || req.secure ? '; Secure' : '';
    res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
  }

  function startSession(res, req, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, expires);
    db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(user.id);
    cookie(res, token, SESSION_DAYS * 86400, req);
  }

  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    cookie(res, '', 0, req);
  }

  // Sliding expiry: a session used within its lifetime is extended.
  function userFor(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = db.prepare(`SELECT s.token_hash, s.expires_at, u.id, u.username, u.display_name, u.role, u.active, u.must_change_password
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
    if (!row || !row.active || row.expires_at < new Date().toISOString()) return null;
    if (Date.parse(row.expires_at) - Date.now() < (SESSION_DAYS - 1) * 864e5) {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(), row.token_hash);
    }
    const { token_hash: _t, expires_at: _e, active: _a, ...user } = row;
    return user;
  }

  function login(req, res, username, password) {
    const key = `${String(username).toLowerCase()}|${req.ip}`;
    const f = failures.get(key);
    if (f && f.until > Date.now()) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.`);
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
    // Hash even for unknown users so response time doesn't reveal which usernames exist.
    const ok = verifyPassword(password, user?.password_hash ?? hashPassword('placeholder-password'));
    if (!user || !ok) {
      const lockExpired = f && f.until && f.until <= Date.now();
      const count = (lockExpired ? 0 : f?.count ?? 0) + 1;
      failures.set(key, { count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MINUTES * 60000 : 0 });
      throw new HttpError(401, 'Wrong username or password');
    }
    failures.delete(key);
    startSession(res, req, user);
    return user;
  }

  const userCount = () => db.prepare('SELECT count(*) AS n FROM users').get().n;

  return { hashPassword, verifyPassword, checkPasswordRules, startSession, endSession, userFor, login, userCount };
}

// ------------------------------------------------------------ access rules
// Reachable without logging in: the login page and its assets, and the login/setup endpoints.
const PUBLIC = [/^\/login\.html$/, /^\/[\w-]+\.(css|js)$/, /^\/api\/auth\/(login|status|setup)$/];
// Admin only (office staff get 403): pay, personnel, rates, company settings changes and user accounts.
const ADMIN_PAGES = [/^\/(crew|payroll)\.html$/];
function adminOnlyApi(method, path) {
  if (/^\/api\/(personnel|adjustments|payroll|tax1099|users)(\/|$)/.test(path)) return true;
  if (method === 'GET') return false;
  return /^\/api\/(settings|rate-card|items)(\/|$)/.test(path);
}
// Cross-site forms can only send these content types without a CORS preflight, so state-changing API calls
// must not use them (together with SameSite=Lax cookies this blocks cross-site request forgery).
const SIMPLE_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)/i;

function authMiddleware(auth) {
  return (req, res, next) => {
    const path = req.path;
    const isApi = path.startsWith('/api/');
    if (isApi && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const type = req.headers['content-type'] || '';
      if (req.method !== 'DELETE' && (!type || SIMPLE_TYPES.test(type))) return next(new HttpError(415, 'Send JSON'));
    }
    if (PUBLIC.some((re) => re.test(path))) return next();
    const user = auth.userFor(req);
    if (!user) {
      if (isApi) return next(new HttpError(401, 'Please sign in'));
      return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
    }
    req.user = user;
    if (user.role !== 'admin' && (adminOnlyApi(req.method, path) || ADMIN_PAGES.some((re) => re.test(path)))) {
      if (isApi) return next(new HttpError(403, 'Only an admin can do that'));
      return res.redirect('/index.html');
    }
    // History entries record who did it, whatever the browser claims.
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body.actor = user.display_name;
    next();
  };
}

module.exports = { createAuth, authMiddleware, hashPassword, verifyPassword, checkPasswordRules, COOKIE };
