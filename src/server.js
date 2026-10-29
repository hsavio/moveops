const { openDb } = require('./db');
const { seed } = require('./db/seed');
const { createApp } = require('./app');

const db = openDb();
// Only seed a brand-new database, never one holding imported legacy data.
const isEmpty = ['customers', 'crew_members', 'zip_codes'].every((t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n === 0);
if (isEmpty) {
  seed(db);
  console.log('Empty database: loaded demo data.');
}

const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => console.log(`MoveOps running at http://localhost:${port}`));
