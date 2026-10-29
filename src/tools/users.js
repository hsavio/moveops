// Account recovery from the server's command line (no web login needed):
//   npm run user -- list
//   npm run user -- reset <username>          prints a new temporary password
//   npm run user -- create-admin <username>   prints a temporary password
const crypto = require('node:crypto');
const { openDb } = require('../db');
const { hashPassword } = require('../auth');

const [cmd, username] = process.argv.slice(2);
const db = openDb();
const temp = () => crypto.randomBytes(9).toString('base64url');

if (cmd === 'list') {
  for (const u of db.prepare('SELECT username, display_name, role, active, last_login_at FROM users ORDER BY username').all()) {
    console.log(`${u.username.padEnd(20)} ${u.role.padEnd(7)} ${u.active ? 'active  ' : 'inactive'} ${u.display_name}`);
  }
} else if (cmd === 'reset' && username) {
  const pw = temp();
  const r = db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, active = 1 WHERE username = ?').run(hashPassword(pw), username);
  if (!r.changes) { console.error(`No user "${username}"`); process.exit(1); }
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(username);
  console.log(`Temporary password for ${username}: ${pw}\n(They'll choose a new one when they sign in.)`);
} else if (cmd === 'create-admin' && username) {
  const pw = temp();
  db.prepare("INSERT INTO users (username, display_name, password_hash, role, must_change_password) VALUES (?, ?, ?, 'admin', 1)")
    .run(username, username, hashPassword(pw));
  console.log(`Admin ${username} created. Temporary password: ${pw}`);
} else {
  console.log('Usage: npm run user -- list | reset <username> | create-admin <username>');
  process.exit(cmd ? 1 : 0);
}
