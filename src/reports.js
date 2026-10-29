// Reports from the legacy app: Activities, Unpaid Moves (collections) and Booking Commission,
// plus the agents (realtors / referrers) that commissions are owed to.
const { HttpError, EMAIL_RE, today } = require('./http');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME = `coalesce(c.company_name, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')))`;
const PAID = `coalesce((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount_cents ELSE p.amount_cents END) FROM payments p WHERE p.job_id = j.id), 0)`;

function dateRange(q) {
  const from = q.from || '2000-01-01';
  const to = q.to || today();
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw new HttpError(400, 'from and to must be dates, from <= to');
  return [from, to];
}

const totals = (rows) => ({
  count: rows.length,
  estimated_cents: rows.reduce((s, r) => s + (r.quoted_total_cents || 0), 0),
  closed_cents: rows.reduce((s, r) => s + (r.final_total_cents || 0), 0),
});

function registerReportRoutes(app, db) {
  const cols = `j.id, j.job_number, substr(j.created_at, 1, 10) AS estimate_date, j.move_date, j.status, c.first_name, c.last_name,
    c.company_name, ${NAME} AS customer_name, j.quoted_total_cents, j.final_total_cents`;
  const eventDate = (status) => `(SELECT substr(max(e.created_at), 1, 10) FROM job_events e WHERE e.job_id = j.id AND e.to_status = '${status}')`;

  // Activities: estimates given, moves scheduled, moves cancelled and moves completed in the period.
  app.get('/api/reports/activities', (req, res) => {
    const [from, to] = dateRange(req.query);
    const q = (sql) => db.prepare(sql).all(from, to);
    const estimates = q(`SELECT ${cols} FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE substr(j.created_at, 1, 10) BETWEEN ? AND ? ORDER BY j.created_at`);
    const scheduled = q(`SELECT ${cols}, ${eventDate('booked')} AS event_date FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE ${eventDate('booked')} BETWEEN ? AND ? ORDER BY event_date`);
    const cancelled = q(`SELECT ${cols}, ${eventDate('cancelled')} AS event_date FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE j.status = 'cancelled' AND ${eventDate('cancelled')} BETWEEN ? AND ? ORDER BY event_date`);
    const moved = q(`SELECT ${cols} FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE j.status IN ('completed', 'invoiced') AND j.move_date BETWEEN ? AND ? ORDER BY j.move_date`);
    res.json({
      from, to,
      sections: [
        { key: 'estimates', title: 'Estimates', description: 'Estimates given during the period.', date_label: 'Move date', rows: estimates, totals: totals(estimates) },
        { key: 'scheduled', title: 'Scheduled', description: 'Estimates booked onto the schedule during the period.', date_label: 'Scheduled', rows: scheduled, totals: totals(scheduled) },
        { key: 'cancelled', title: 'Cancelled', description: 'Moves cancelled during the period.', date_label: 'Cancelled', rows: cancelled, totals: totals(cancelled) },
        { key: 'moved', title: 'Moved', description: 'Moves completed during the period.', date_label: 'Move date', rows: moved, totals: totals(moved) },
      ],
    });
  });

  // Unpaid moves: completed moves whose final total is more than what's been paid.
  app.get('/api/reports/unpaid', (req, res) => {
    const [from, to] = dateRange(req.query);
    const rows = db.prepare(`
      SELECT ${cols}, ${PAID} AS paid_cents, coalesce(j.final_total_cents, j.quoted_total_cents) - ${PAID} AS balance_cents,
             CAST(julianday(?) - julianday(j.move_date) AS INTEGER) AS days_since_move,
             c.phone, c.cell_phone, c.work_phone, c.work_ext, c.new_phone, c.fax, c.email
      FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE j.status IN ('completed', 'invoiced') AND j.move_date BETWEEN ? AND ?
        AND coalesce(j.final_total_cents, j.quoted_total_cents) - ${PAID} > 0
      ORDER BY j.move_date`).all(today(), from, to);
    res.json({ from, to, rows, totals: { count: rows.length, balance_cents: rows.reduce((s, r) => s + r.balance_cents, 0) } });
  });

  // Booking commission owed to agents for moves in the period (cancelled moves earn nothing).
  app.get('/api/reports/commissions', (req, res) => {
    const [from, to] = dateRange(req.query);
    const params = [from, to];
    let where = `j.agent_id IS NOT NULL AND j.status != 'cancelled' AND j.move_date BETWEEN ? AND ?`;
    if (req.query.agent_id) { where += ' AND j.agent_id = ?'; params.push(Number(req.query.agent_id)); }
    if (req.query.unpaid) where += ' AND j.commission_paid_at IS NULL';
    const rows = db.prepare(`
      SELECT ${cols}, j.commission_paid_at, a.id AS agent_id, coalesce(a.business_name, a.first_name || ' ' || a.last_name) AS agent_name,
             a.commission_percent,
             CAST(round(coalesce(j.final_total_cents, j.quoted_total_cents, 0) * a.commission_percent / 100.0) AS INTEGER) AS commission_cents
      FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN agents a ON a.id = j.agent_id
      WHERE ${where} ORDER BY agent_name, j.move_date`).all(...params);
    const owed = rows.filter((r) => !r.commission_paid_at);
    res.json({ from, to, rows, totals: {
      count: rows.length, commission_cents: rows.reduce((s, r) => s + r.commission_cents, 0),
      owed_cents: owed.reduce((s, r) => s + r.commission_cents, 0),
    } });
  });

  app.post('/api/jobs/:id/commission-paid', (req, res) => {
    const paid = req.body.paid !== false;
    const date = paid ? (DATE_RE.test(req.body.date || '') ? req.body.date : today()) : null;
    if (!db.prepare('UPDATE jobs SET commission_paid_at = ? WHERE id = ? AND agent_id IS NOT NULL').run(date, req.params.id).changes) {
      throw new HttpError(404, 'Job with an agent not found');
    }
    res.json({ id: Number(req.params.id), commission_paid_at: date });
  });

  // ------------------------------------------------------------ agents
  const AGENT_FIELDS = ['business_name', 'first_name', 'last_name', 'business_phone', 'alternate_phone', 'email', 'address', 'city', 'state', 'postal_code'];
  function saveAgent(id, b) {
    const v = Object.fromEntries(AGENT_FIELDS.map((k) => [k, b[k] == null || String(b[k]).trim() === '' ? null : String(b[k]).trim()]));
    if (!v.business_name && !v.last_name) throw new HttpError(400, 'Enter a business or last name');
    if (v.email && !EMAIL_RE.test(v.email)) throw new HttpError(400, `"${v.email}" is not a valid email address`);
    const pct = Number(b.commission_percent ?? 0);
    if (!(pct >= 0 && pct <= 100)) throw new HttpError(400, 'Commission must be between 0 and 100%');
    const active = b.active === false || b.active === 0 ? 0 : 1;
    if (id) {
      const r = db.prepare(`UPDATE agents SET ${AGENT_FIELDS.map((k) => `${k} = ?`).join(', ')}, commission_percent = ?, active = ? WHERE id = ?`)
        .run(...AGENT_FIELDS.map((k) => v[k]), pct, active, id);
      if (!r.changes) throw new HttpError(404, 'Agent not found');
      return id;
    }
    return db.prepare(`INSERT INTO agents (${AGENT_FIELDS.join(', ')}, commission_percent, active) VALUES (${AGENT_FIELDS.map(() => '?').join(', ')}, ?, ?)`)
      .run(...AGENT_FIELDS.map((k) => v[k]), pct, active).lastInsertRowid;
  }
  const getAgent = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  app.get('/api/agents', (req, res) => res.json(db.prepare(`SELECT * FROM agents ${req.query.all ? '' : 'WHERE active = 1'}
    ORDER BY coalesce(business_name, last_name)`).all()));
  app.post('/api/agents', (req, res) => res.status(201).json(getAgent(saveAgent(null, req.body))));
  app.put('/api/agents/:id(\\d+)', (req, res) => res.json(getAgent(saveAgent(Number(req.params.id), req.body))));
}

module.exports = { registerReportRoutes };
