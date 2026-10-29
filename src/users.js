// Login, first-run setup, password changes and (admin) user accounts.
const { HttpError } = require('./http');

const USERNAME_RE = /^[a-z0-9._-]{3,40}$/i;
const ROLES = ['admin', 'office'];
const publicUser = (u) => u && { id: u.id, username: u.username, display_name: u.display_name, role: u.role,
  active: u.active, must_change_password: Boolean(u.must_change_password), last_login_at: u.last_login_at };

function registerUserRoutes(app, db, auth) {
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const adminCount = () => db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;

  function validateNew(b) {
    const username = String(b.username || '').trim();
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username: 3-40 letters, numbers, dots, dashes or underscores');
    const display = String(b.display_name || '').trim() || username;
    const problem = auth.checkPasswordRules(b.password, username);
    if (problem) throw new HttpError(400, problem);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
    return { username, display };
  }

  // ------------------------------------------------------------ session
  app.get('/api/auth/status', (req, res) => {
    res.json({ setup_needed: auth.userCount() === 0, user: publicUser(auth.userFor(req)) });
  });

  // Creates the first admin. Only works while there are no accounts at all.
  app.post('/api/auth/setup', (req, res) => {
    if (auth.userCount() > 0) throw new HttpError(409, 'Setup is already done. Sign in instead.');
    const { username, display } = validateNew(req.body);
    const id = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run(username, display, auth.hashPassword(req.body.password)).lastInsertRowid;
    auth.startSession(res, req, getUser(id));
    res.status(201).json({ user: publicUser(getUser(id)) });
  });

  app.post('/api/auth/login', (req, res) => {
    const user = auth.login(req, res, req.body.username, req.body.password);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = req.user ?? auth.userFor(req);
    if (!user) throw new HttpError(401, 'Please sign in');
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/password', (req, res) => {
    const me = req.user ?? auth.userFor(req);
    if (!me) throw new HttpError(401, 'Please sign in');
    const user = getUser(me.id);
    if (!auth.verifyPassword(req.body.current_password, user.password_hash)) throw new HttpError(400, 'Current password is wrong');
    const problem = auth.checkPasswordRules(req.body.new_password, user.username);
    if (problem) throw new HttpError(400, problem);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(req.body.new_password), user.id);
    // Sign out other devices; keep this one.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    auth.startSession(res, req, user);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ accounts (admin; enforced by the auth middleware)
  app.get('/api/users', (req, res) => {
    res.json(db.prepare('SELECT * FROM users ORDER BY active DESC, display_name').all().map(publicUser));
  });

  // New accounts get a temporary password the person must change at first sign-in.
  app.post('/api/users', (req, res) => {
    const { username, display } = validateNew(req.body);
    const role = req.body.role ?? 'office';
    if (!ROLES.includes(role)) throw new HttpError(400, 'Role is not valid');
    const id = db.prepare('INSERT INTO users (username, display_name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)')
      .run(username, display, auth.hashPassword(req.body.password), role).lastInsertRowid;
    res.status(201).json(publicUser(getUser(id)));
  });

  app.put('/api/users/:id(\\d+)', (req, res) => {
    const user = getUser(req.params.id);
    if (!user) throw new HttpError(404, 'User not found');
    const b = req.body;
    const role = b.role ?? user.role;
    const active = b.active === undefined ? user.active : b.active ? 1 : 0;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Role is not valid');
    const losingAdmin = user.role === 'admin' && user.active && (role !== 'admin' || !active);
    if (losingAdmin && adminCount() <= 1) throw new HttpError(409, 'Keep at least one active admin');
    const display = String(b.display_name ?? user.display_name).trim() || user.username;
    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?').run(display, role, active, user.id);
    if (b.password) {
      const problem = auth.checkPasswordRules(b.password, user.username);
      if (problem) throw new HttpError(400, problem);
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(b.password), user.id);
    }
    // Deactivating, demoting or resetting a password signs that person out everywhere.
    if (!active || role !== user.role || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    res.json(publicUser(getUser(user.id)));
  });
}

module.exports = { registerUserRoutes };
