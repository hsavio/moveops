// Personnel (crew records, pay setup, W-9 status), pay adjustments, weekly payroll and the
// year-end TAX1099 export. SSNs are never accepted or stored.
const { tx } = require('./db');
const { HttpError, EMAIL_RE, today } = require('./http');
const { scrubSensitive } = require('./legacy/transform');
const payroll = require('./payroll');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROLES = ['mover', 'driver', 'lead'];
const W9 = ['missing', 'requested', 'received'];
const ADJUSTMENT_CATEGORIES = ['tip', 'extra_pay', 'damage', 'advance', 'expense', 'cash_paid', 'other'];
const PAYOUT_METHODS = ['cash', 'check', 'ach', 'other'];
const TEXT_FIELDS = ['first_name', 'last_name', 'phone', 'email', 'address', 'city', 'state', 'postal_code', 'notes'];

const blank = (v) => v == null || String(v).trim() === '';
const text = (v) => (blank(v) ? null : String(v).trim());
const noSensitive = (v, label) => {
  if (v && scrubSensitive(v).removed) throw new HttpError(400, `${label} looks like it contains an SSN or card number. Don't store those in MoveOps.`);
  return v;
};

function cleanWorker(b) {
  if (Object.keys(b).some((k) => /ssn|social|tin|license|licence/i.test(k))) {
    throw new HttpError(400, 'SSNs, TINs and licence numbers are not stored in MoveOps');
  }
  const w = Object.fromEntries(TEXT_FIELDS.map((k) => [k, noSensitive(text(b[k]), k.replace('_', ' '))]));
  if (!w.first_name || !w.last_name) throw new HttpError(400, 'Enter a first and last name');
  if (w.email && !EMAIL_RE.test(w.email)) throw new HttpError(400, `"${w.email}" is not a valid email address`);
  if (w.state) w.state = w.state.toUpperCase();
  if (w.state && !/^[A-Z]{2}$/.test(w.state)) throw new HttpError(400, 'State must be 2 letters');
  w.role = b.role ?? 'mover';
  if (!ROLES.includes(w.role)) throw new HttpError(400, 'Role is not valid');
  w.pay_type = b.pay_type ?? 'split';
  if (!['split', 'hourly'].includes(w.pay_type)) throw new HttpError(400, 'Pay type is not valid');
  w.split_percent = Number(b.split_percent ?? 0);
  if (!(w.split_percent >= 0 && w.split_percent <= 100)) throw new HttpError(400, 'Split must be between 0 and 100%');
  w.wage_cents = Number(b.wage_cents ?? 0);
  if (!(Number.isInteger(w.wage_cents) && w.wage_cents >= 0)) throw new HttpError(400, 'Hourly rate is not valid');
  if (w.pay_type === 'split' && !(w.split_percent > 0) && b.active !== false) throw new HttpError(400, 'Enter the split percent');
  if (w.pay_type === 'hourly' && !(w.wage_cents > 0) && b.active !== false) throw new HttpError(400, 'Enter the hourly rate');
  w.w9_status = b.w9_status ?? 'missing';
  if (!W9.includes(w.w9_status)) throw new HttpError(400, 'W-9 status is not valid');
  for (const k of ['start_date', 'end_date', 'w9_received_on']) {
    w[k] = blank(b[k]) ? null : b[k];
    if (w[k] && !DATE_RE.test(w[k])) throw new HttpError(400, `${k.replace(/_/g, ' ')} is not a valid date`);
  }
  if (w.w9_status === 'received' && !w.w9_received_on) w.w9_received_on = today();
  for (const k of ['available_as_mover', 'is_salesperson', 'in_tax1099']) w[k] = b[k] === true || b[k] === 1 || b[k] === '1' ? 1 : 0;
  w.active = b.active === false || b.active === 0 ? 0 : 1;
  return w;
}

function registerPersonnelRoutes(app, db, { readSettings }) {
  // ------------------------------------------------------------ personnel
  app.get('/api/personnel', (req, res) => {
    res.json(db.prepare(`SELECT * FROM crew_members ${req.query.all ? '' : 'WHERE active = 1'} ORDER BY active DESC, last_name, first_name`).all());
  });

  app.get('/api/personnel/:id(\\d+)', (req, res) => {
    const w = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
    if (!w) throw new HttpError(404, 'Worker not found');
    const year = today().slice(0, 4);
    res.json({
      worker: w,
      adjustments: db.prepare('SELECT * FROM crew_adjustments WHERE crew_member_id = ? ORDER BY adjustment_date DESC, id DESC LIMIT 100').all(w.id),
      payouts: db.prepare('SELECT id, week_start, week_end, pay_date, total_cents, method, reference FROM crew_payouts WHERE crew_member_id = ? ORDER BY pay_date DESC LIMIT 52').all(w.id),
      paid_this_year_cents: db.prepare('SELECT coalesce(sum(total_cents), 0) AS n FROM crew_payouts WHERE crew_member_id = ? AND substr(pay_date, 1, 4) = ?').get(w.id, year).n,
    });
  });

  function saveWorker(id, body) {
    const w = cleanWorker(body);
    const cols = Object.keys(w);
    if (id) {
      if (!db.prepare(`UPDATE crew_members SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => w[k]), id).changes) {
        throw new HttpError(404, 'Worker not found');
      }
      return id;
    }
    return db.prepare(`INSERT INTO crew_members (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => w[k])).lastInsertRowid;
  }
  app.post('/api/personnel', (req, res) => res.status(201).json(db.prepare('SELECT * FROM crew_members WHERE id = ?').get(saveWorker(null, req.body))));
  app.put('/api/personnel/:id(\\d+)', (req, res) => res.json(db.prepare('SELECT * FROM crew_members WHERE id = ?').get(saveWorker(Number(req.params.id), req.body))));

  // ------------------------------------------------------------ adjustments (advances, damage, extra pay...)
  app.post('/api/personnel/:id(\\d+)/adjustments', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM crew_members WHERE id = ?').get(id)) throw new HttpError(404, 'Worker not found');
    const b = req.body;
    const amount = Number(b.amount_cents);
    if (!(Number.isInteger(amount) && amount !== 0)) throw new HttpError(400, 'Enter an amount (negative to deduct)');
    if (!ADJUSTMENT_CATEGORIES.includes(b.category ?? 'other')) throw new HttpError(400, 'Category is not valid');
    const description = noSensitive(text(b.description), 'Description');
    if (!description) throw new HttpError(400, 'Enter a description');
    const date = DATE_RE.test(b.adjustment_date || '') ? b.adjustment_date : today();
    const row = db.prepare(`INSERT INTO crew_adjustments (crew_member_id, adjustment_date, category, description, amount_cents)
      VALUES (?, ?, ?, ?, ?) RETURNING *`).get(id, date, b.category ?? 'other', description, amount);
    res.status(201).json(row);
  });

  app.delete('/api/adjustments/:id(\\d+)', (req, res) => {
    const a = db.prepare('SELECT * FROM crew_adjustments WHERE id = ?').get(req.params.id);
    if (!a) throw new HttpError(404, 'Adjustment not found');
    const week = payroll.payWeek(a.adjustment_date);
    if (db.prepare('SELECT 1 FROM crew_payouts WHERE crew_member_id = ? AND week_start = ?').get(a.crew_member_id, week.start)) {
      throw new HttpError(409, 'That week is already paid. Undo the payment first, or add a correcting adjustment.');
    }
    db.prepare('DELETE FROM crew_adjustments WHERE id = ?').run(a.id);
    res.json({ deleted: a.id });
  });

  // ------------------------------------------------------------ weekly payroll
  function computeWeek(date) {
    const week = payroll.payWeek(date);
    const jobs = db.prepare(`SELECT j.*, coalesce(c.company_name, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))) AS customer_name
      FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE j.move_date BETWEEN ? AND ? AND j.status IN ('completed', 'invoiced') ORDER BY j.move_date, j.job_number`).all(week.start, week.end);
    const crewOf = db.prepare('SELECT crew_member_id FROM job_crew WHERE job_id = ?');
    const byWorker = new Map();
    const noCrew = [];
    for (const j of jobs) {
      const ids = crewOf.all(j.id).map((r) => r.crew_member_id);
      if (!ids.length) noCrew.push({ id: j.id, job_number: j.job_number, move_date: j.move_date });
      const shares = payroll.tipShares(j.tips_cents || 0, ids);
      for (const id of ids) {
        if (!byWorker.has(id)) byWorker.set(id, []);
        byWorker.get(id).push({ ...j, tip_share_cents: shares.get(id) || 0 });
      }
    }
    const adjustments = db.prepare('SELECT * FROM crew_adjustments WHERE adjustment_date BETWEEN ? AND ? ORDER BY adjustment_date, id').all(week.start, week.end);
    const payouts = db.prepare('SELECT * FROM crew_payouts WHERE week_start = ?').all(week.start);
    const ids = new Set([...byWorker.keys(), ...adjustments.map((a) => a.crew_member_id), ...payouts.map((p) => p.crew_member_id)]);
    const workerStmt = db.prepare('SELECT * FROM crew_members WHERE id = ?');
    const workers = [...ids].map((id) => {
      const w = workerStmt.get(id);
      const pay = payroll.workerWeek(w, byWorker.get(id) || [], adjustments.filter((a) => a.crew_member_id === id));
      const payout = payouts.find((p) => p.crew_member_id === id) || null;
      return { worker: { id: w.id, first_name: w.first_name, last_name: w.last_name, role: w.role, pay_type: w.pay_type,
        split_percent: w.split_percent, wage_cents: w.wage_cents }, ...pay, payout,
        changed_since_paid: Boolean(payout && payout.total_cents !== pay.total_cents) };
    }).sort((a, b) => a.worker.last_name.localeCompare(b.worker.last_name));
    // Moves in the week that haven't been closed out yet won't pay anyone until they are.
    const notClosed = db.prepare(`SELECT id, job_number, move_date, status FROM jobs WHERE move_date BETWEEN ? AND ?
      AND status IN ('booked', 'dispatched', 'in_progress') ORDER BY move_date`).all(week.start, week.end);
    return { week, workers, not_closed: notClosed, jobs_without_crew: noCrew,
      totals: { total_cents: workers.reduce((s, w) => s + (w.payout?.total_cents ?? w.total_cents), 0) } };
  }

  app.get('/api/payroll', (req, res) => {
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : today();
    res.json(computeWeek(date));
  });

  app.post('/api/payroll/pay', (req, res) => {
    const b = req.body;
    if (!DATE_RE.test(b.date || '')) throw new HttpError(400, 'Choose the pay week');
    if (b.method && !PAYOUT_METHODS.includes(b.method)) throw new HttpError(400, 'Payment method is not valid');
    const reference = noSensitive(text(b.reference), 'Reference');
    const ids = (Array.isArray(b.crew_member_ids) ? b.crew_member_ids : [b.crew_member_id]).map(Number).filter(Boolean);
    if (!ids.length) throw new HttpError(400, 'Choose who is being paid');
    const wk = computeWeek(b.date);
    const insert = db.prepare(`INSERT INTO crew_payouts (crew_member_id, week_start, week_end, pay_date, job_pay_cents, tips_cents,
      adjustments_cents, total_cents, method, reference, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    tx(db, () => {
      for (const id of ids) {
        const w = wk.workers.find((x) => x.worker.id === id);
        if (!w) throw new HttpError(400, 'Nothing to pay that worker for this week');
        if (w.payout) throw new HttpError(409, `${w.worker.first_name} ${w.worker.last_name} is already marked paid for this week`);
        insert.run(id, wk.week.start, wk.week.end, b.pay_date && DATE_RE.test(b.pay_date) ? b.pay_date : wk.week.payDate,
          w.job_pay_cents, w.tips_cents, w.adjustments_cents, w.total_cents, b.method || null, reference,
          JSON.stringify({ jobs: w.jobs, adjustments: w.adjustments }));
      }
    });
    res.status(201).json(computeWeek(b.date));
  });

  app.delete('/api/payroll/pay/:id(\\d+)', (req, res) => {
    const p = db.prepare('SELECT * FROM crew_payouts WHERE id = ?').get(req.params.id);
    if (!p) throw new HttpError(404, 'Payment not found');
    db.prepare('DELETE FROM crew_payouts WHERE id = ?').run(p.id);
    res.json(computeWeek(p.week_start));
  });

  // ------------------------------------------------------------ year-end 1099s (TAX1099.com)
  function yearSummary(year, thresholdCents) {
    const rows = db.prepare(`SELECT m.*, sum(p.total_cents) AS total_cents, count(p.id) AS weeks_paid
      FROM crew_payouts p JOIN crew_members m ON m.id = p.crew_member_id
      WHERE substr(p.pay_date, 1, 4) = ? GROUP BY m.id ORDER BY m.last_name, m.first_name`).all(String(year));
    return rows.map(({ total_cents, weeks_paid, ...w }) => {
      const missing = [!w.address && 'address', !w.city && 'city', !w.state && 'state', !w.postal_code && 'ZIP'].filter(Boolean);
      return { worker: w, total_cents, weeks_paid, needs_1099: total_cents >= thresholdCents, missing,
        w9_status: w.w9_status, in_tax1099: Boolean(w.in_tax1099) };
    });
  }
  const yearParams = (q) => {
    const year = Number(q.year) || Number(today().slice(0, 4)) - 1;
    const threshold = q.threshold_cents != null && q.threshold_cents !== '' ? Number(q.threshold_cents) : payroll.necThresholdCents(year);
    if (!(year >= 2000 && year <= 2100) || !(threshold >= 0)) throw new HttpError(400, 'Year or threshold is not valid');
    return { year, threshold };
  };

  app.get('/api/tax1099', (req, res) => {
    const { year, threshold } = yearParams(req.query);
    const settings = readSettings();
    const payer = payroll.splitCityStateZip(settings.company_city_state_zip);
    const payerMissing = [!settings.company_name && 'company name', !settings.company_address && 'company address',
      !payer.state && 'city, state and ZIP', !settings.payer_ein && 'business EIN'].filter(Boolean);
    res.json({ year, threshold_cents: threshold, payer_missing: payerMissing, recipients: yearSummary(year, threshold) });
  });

  app.get('/api/tax1099/export', (req, res) => {
    const { year, threshold } = yearParams(req.query);
    const recipients = yearSummary(year, threshold).filter((r) => req.query.all || r.needs_1099);
    const rows = payroll.tax1099Rows(readSettings(), recipients);
    const q = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const csv = [payroll.TAX1099_COLUMNS.map(q).join(','), ...rows.map((r) => payroll.TAX1099_COLUMNS.map((c) => q(r[c])).join(','))].join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="1099-NEC-${year}-tax1099-import.csv"`);
    res.send(`${csv}\r\n`);
  });
}

module.exports = { registerPersonnelRoutes };
