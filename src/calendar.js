// Calendar: moves, call-backs and site visits for a date range, plus per-day notes.
// Replaces the legacy "At a Glance" tabs and the one-day Moves Schedule.
const { HttpError } = require('./http');
const { scrubSensitive } = require('./legacy/transform');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 120;

function registerCalendarRoutes(app, db) {
  const base = `
    SELECT j.id AS job_id, j.job_number, j.status, j.move_date, j.arrival_window_start, j.arrival_window_end, j.crew_size,
           j.crew_number, j.est_hours, j.callback_date, j.site_visit_at, coalesce(j.final_total_cents, j.quoted_total_cents) AS total_cents,
           coalesce(c.company_name, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))) AS customer_name,
           coalesce(c.phone, c.cell_phone, c.work_phone) AS phone,
           o.city AS origin_city, o.postal_code AS origin_zip, d.city AS destination_city, d.postal_code AS destination_zip
    FROM jobs j JOIN customers c ON c.id = j.customer_id
    LEFT JOIN addresses o ON o.id = j.origin_address_id LEFT JOIN addresses d ON d.id = j.destination_address_id`;

  app.get('/api/calendar', (req, res) => {
    const { from, to } = req.query;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || to < from) throw new HttpError(400, 'from and to must be dates, from <= to');
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > MAX_DAYS) throw new HttpError(400, `Choose a range of ${MAX_DAYS} days or less`);

    const moves = db.prepare(`${base} WHERE j.move_date BETWEEN ? AND ? AND j.status != 'cancelled'
      ORDER BY j.move_date, j.arrival_window_start, j.crew_number, j.job_number`).all(from, to)
      .map((r) => ({ type: 'move', date: r.move_date, time: r.arrival_window_start, tentative: ['lead', 'quoted'].includes(r.status), ...r }));
    const callbacks = db.prepare(`${base} WHERE j.callback_date BETWEEN ? AND ? AND j.status != 'cancelled'
      ORDER BY j.callback_date, j.job_number`).all(from, to)
      .map((r) => ({ type: 'callback', date: r.callback_date, time: null, ...r }));
    const visits = db.prepare(`${base} WHERE substr(j.site_visit_at, 1, 10) BETWEEN ? AND ? AND j.status != 'cancelled'
      ORDER BY j.site_visit_at`).all(from, to)
      .map((r) => ({ type: 'visit', date: r.site_visit_at.slice(0, 10), time: r.site_visit_at.slice(11, 16) || null, ...r }));
    const notes = Object.fromEntries(db.prepare('SELECT date, notes FROM day_notes WHERE date BETWEEN ? AND ?').all(from, to).map((n) => [n.date, n.notes]));
    res.json({ from, to, events: [...moves, ...callbacks, ...visits], notes });
  });

  // Empty text deletes the note.
  app.put('/api/day-notes/:date', (req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) throw new HttpError(400, 'Invalid date');
    const notes = String(req.body.notes ?? '').trim();
    if (notes && scrubSensitive(notes).removed) throw new HttpError(400, 'Notes look like they contain a card number or SSN');
    if (notes) {
      db.prepare(`INSERT INTO day_notes (date, notes) VALUES (?, ?)
        ON CONFLICT(date) DO UPDATE SET notes = excluded.notes, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(date, notes);
    } else {
      db.prepare('DELETE FROM day_notes WHERE date = ?').run(date);
    }
    res.json({ date, notes });
  });

  // Mark a call-back done: clears the date and records it in the job's history.
  app.post('/api/jobs/:id/callback-done', (req, res) => {
    const job = db.prepare('SELECT id, status, callback_date FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) throw new HttpError(404, 'Job not found');
    db.prepare('UPDATE jobs SET callback_date = NULL WHERE id = ?').run(job.id);
    db.prepare('INSERT INTO job_events (job_id, from_status, to_status, note, actor) VALUES (?, ?, ?, ?, ?)')
      .run(job.id, job.status, job.status, `Call-back done${req.body.note ? `: ${String(req.body.note).slice(0, 200)}` : ''}`, req.body.actor ?? 'office');
    res.json({ id: job.id, callback_date: null });
  });

  const dayNote = (date) => db.prepare('SELECT notes FROM day_notes WHERE date = ?').get(date)?.notes ?? null;
  return { dayNote };
}

module.exports = { registerCalendarRoutes };
