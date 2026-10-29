const path = require('node:path');
const express = require('express');
const { tx } = require('./db');
const { calculateQuote } = require('./pricing');
const { createDistanceService, directionsUrl } = require('./maps');
const { createMailer } = require('./mailer');
const { HttpError, wrap, EMAIL_RE, today } = require('./http');
const { registerEstimateRoutes } = require('./estimates');

// Allowed job status transitions. Anything not listed is rejected.
const TRANSITIONS = {
  lead: ['quoted', 'cancelled'],
  quoted: ['booked', 'lead', 'cancelled'],
  booked: ['dispatched', 'quoted', 'cancelled'],
  dispatched: ['in_progress', 'booked', 'cancelled'],
  in_progress: ['completed'],
  completed: ['invoiced'],
  invoiced: [],
  cancelled: ['lead'],
};


const fullAddress = (a) => a && [[a.line1, a.line2].filter(Boolean).join(' '), a.city, `${a.state} ${a.postal_code}`.trim()]
  .filter((x) => x && x.trim()).join(', ');

const fmt12 = (hhmm) => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

/**
 * @param {object} [services]
 * @param {object} [services.distance]  distance service (see maps.js)
 * @param {object} [services.mailer]    mailer (see mailer.js)
 * @param {string} [services.yardAddress] where crews start the day; first stop in directions
 */
function createApp(db, services = {}) {
  const distance = services.distance ?? createDistanceService({ db });
  const mailer = services.mailer ?? createMailer();
  const yardAddress = services.yardAddress ?? process.env.YARD_ADDRESS ?? null;
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  const currentRateCard = () => {
    const card = db.prepare(`SELECT * FROM rate_cards WHERE active = 1 AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1`).get(today());
    if (card) {
      card.crew_rates = Object.fromEntries(db.prepare('SELECT crew_size, hourly_cents FROM rate_card_crew_rates WHERE rate_card_id = ?')
        .all(card.id).map((r) => [r.crew_size, r.hourly_cents]));
    }
    return card;
  };

  // Jobs with customer, addresses, crew and trucks flattened for grid/schedule views.
  function listJobs({ from, to, status }) {
    const where = [];
    const params = [];
    if (from) { where.push('j.move_date >= ?'); params.push(from); }
    if (to) { where.push('j.move_date <= ?'); params.push(to); }
    if (status) { where.push('j.status = ?'); params.push(status); }
    const jobs = db.prepare(`
      SELECT j.*,
             coalesce(c.company_name, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))) AS customer_name, c.phone AS customer_phone,
             o.line1 || ', ' || o.city AS origin, d.line1 || ', ' || d.city AS destination
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      LEFT JOIN addresses o ON o.id = j.origin_address_id
      LEFT JOIN addresses d ON d.id = j.destination_address_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY j.move_date, j.arrival_window_start, j.job_number`).all(...params);

    const crewStmt = db.prepare(`SELECT m.id, m.first_name || ' ' || m.last_name AS name, m.role, jc.is_lead
      FROM job_crew jc JOIN crew_members m ON m.id = jc.crew_member_id WHERE jc.job_id = ? ORDER BY jc.is_lead DESC, m.last_name`);
    const truckStmt = db.prepare(`SELECT t.id, t.name, t.length_ft FROM job_trucks jt JOIN trucks t ON t.id = jt.truck_id WHERE jt.job_id = ?`);
    // Crew and trucks are assigned at the yard on the morning of the job, so missing assignments
    // only count as a problem from the move date on.
    const now = today();
    for (const j of jobs) {
      j.crew = crewStmt.all(j.id);
      j.trucks = truckStmt.all(j.id);
      j.warnings = [];
      if (['booked', 'dispatched'].includes(j.status) && j.move_date && j.move_date <= now) {
        if (j.crew.length < j.crew_size) j.warnings.push(`Needs ${j.crew_size - j.crew.length} more crew`);
        if (j.trucks.length < j.trucks_needed) j.warnings.push(`Needs ${j.trucks_needed - j.trucks.length} more truck(s)`);
      }
    }
    return jobs;
  }

  app.get('/api/dashboard', (req, res) => {
    const date = req.query.date || today();
    const jobs = listJobs({ from: date, to: date }).filter((j) => j.status !== 'cancelled');
    const week = db.prepare(`SELECT count(*) AS n, coalesce(sum(quoted_total_cents), 0) AS cents FROM jobs
      WHERE status IN ('booked','dispatched','in_progress','completed','invoiced')
        AND move_date BETWEEN ? AND date(?, '+6 days')`).get(date, date);
    const pipeline = db.prepare(`SELECT status, count(*) AS n FROM jobs WHERE status IN ('lead','quoted') GROUP BY status`).all();
    const crewActive = db.prepare('SELECT count(*) AS n FROM crew_members WHERE active = 1').get().n;
    const crewOut = new Set(jobs.flatMap((j) => j.crew.map((c) => c.id))).size;
    res.json({
      date,
      jobs_today: jobs.length,
      needs_attention: jobs.filter((j) => j.warnings.length).length,
      crew_assigned: crewOut,
      crew_active: crewActive,
      week_booked_jobs: week.n,
      week_booked_cents: week.cents,
      pipeline: Object.fromEntries(pipeline.map((p) => [p.status, p.n])),
    });
  });

  app.get('/api/jobs', (req, res) => res.json(listJobs(req.query)));

  // The schedule board is laid out by crew slot (legacy CrewNumber), not by truck: trucks vary and
  // are picked at the yard on the day. Slots 1..3 always show; higher slots appear when used.
  app.get('/api/schedule', (req, res) => {
    const date = req.query.date || today();
    const jobs = listJobs({ from: date, to: date }).filter((j) => j.status !== 'cancelled');
    const slots = Math.max(3, ...jobs.map((j) => j.crew_number || 0));
    res.json({
      date,
      lanes: Array.from({ length: slots }, (_, i) => ({ slot: i + 1, name: `Crew ${i + 1}`, jobs: jobs.filter((j) => j.crew_number === i + 1) })),
      unassigned: jobs.filter((j) => !j.crew_number),
    });
  });

  app.get('/api/resources', (req, res) => {
    res.json({
      crew: db.prepare(`SELECT id, first_name || ' ' || last_name AS name, role, email, is_salesperson FROM crew_members WHERE active = 1 ORDER BY role, last_name`).all(),
      trucks: db.prepare(`SELECT id, name, length_ft, status FROM trucks WHERE status != 'retired' ORDER BY name`).all(),
    });
  });

  const { sendDocument } = registerEstimateRoutes(app, db, { currentRateCard, TRANSITIONS, mailer });

  app.patch('/api/jobs/:id/status', wrap(async (req, res) => {
    const job = db.prepare('SELECT id, status, move_date, arrival_window_start FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) throw new HttpError(404, 'Job not found');
    const to = req.body.status;
    if (!TRANSITIONS[job.status]?.includes(to)) {
      throw new HttpError(409, `Cannot move a job from '${job.status}' to '${to}'`, { allowed: TRANSITIONS[job.status] });
    }
    // Accepting a quote means agreeing a date and arrival time (the legacy "Schedule" step).
    if (to === 'booked' && (!job.move_date || !job.arrival_window_start)) {
      throw new HttpError(409, 'Set the move date and arrival time before booking');
    }
    tx(db, () => {
      db.prepare(`UPDATE jobs SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(to, job.id);
      db.prepare('INSERT INTO job_events (job_id, from_status, to_status, note, actor) VALUES (?, ?, ?, ?, ?)')
        .run(job.id, job.status, to, req.body.note ?? null, req.body.actor ?? 'dispatcher');
    });
    // Accepting a quote emails the customer a confirmation. The booking stands even if the email can't go out.
    let confirmation;
    if (to === 'booked' && req.body.sendConfirmation !== false) {
      try {
        confirmation = await sendDocument(job.id, 'confirmation', req.body.actor ?? 'dispatcher');
      } catch (err) {
        confirmation = { sent: false, reason: `Email failed: ${err.message}` };
      }
    }
    res.json({ id: job.id, status: to, allowed: TRANSITIONS[to], confirmation });
  }));

  // Replace a job's crew/truck assignment, rejecting double-bookings on the same date.
  app.put('/api/jobs/:id/assignments', (req, res) => {
    const job = db.prepare('SELECT id, move_date FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) throw new HttpError(404, 'Job not found');
    const crew = [...new Set((req.body.crew || []).map(Number))];
    const trucks = [...new Set((req.body.trucks || []).map(Number))];
    const leadId = req.body.leadId != null ? Number(req.body.leadId) : crew[0];
    const crewNumber = req.body.crewNumber == null || req.body.crewNumber === '' ? null : Number(req.body.crewNumber);
    if (crewNumber != null && !(Number.isInteger(crewNumber) && crewNumber > 0)) throw new HttpError(400, 'crewNumber must be a positive whole number');

    const conflicts = [];
    const crewClash = db.prepare(`SELECT j.job_number FROM job_crew jc JOIN jobs j ON j.id = jc.job_id
      WHERE jc.crew_member_id = ? AND j.move_date = ? AND j.id != ? AND j.status != 'cancelled'`);
    const truckClash = db.prepare(`SELECT j.job_number FROM job_trucks jt JOIN jobs j ON j.id = jt.job_id
      WHERE jt.truck_id = ? AND j.move_date = ? AND j.id != ? AND j.status != 'cancelled'`);
    for (const id of crew) for (const r of crewClash.all(id, job.move_date, job.id)) conflicts.push({ type: 'crew', id, job: r.job_number });
    for (const id of trucks) {
      const t = db.prepare('SELECT status FROM trucks WHERE id = ?').get(id);
      if (!t) throw new HttpError(400, `Unknown truck ${id}`);
      if (t.status !== 'available') conflicts.push({ type: 'truck', id, reason: t.status });
      for (const r of truckClash.all(id, job.move_date, job.id)) conflicts.push({ type: 'truck', id, job: r.job_number });
    }
    if (conflicts.length && !req.body.force) throw new HttpError(409, 'Assignment conflicts', { conflicts });

    tx(db, () => {
      db.prepare('DELETE FROM job_crew WHERE job_id = ?').run(job.id);
      db.prepare('DELETE FROM job_trucks WHERE job_id = ?').run(job.id);
      const ic = db.prepare('INSERT INTO job_crew (job_id, crew_member_id, is_lead) VALUES (?, ?, ?)');
      const it = db.prepare('INSERT INTO job_trucks (job_id, truck_id) VALUES (?, ?)');
      crew.forEach((m) => ic.run(job.id, m, m === leadId ? 1 : 0));
      trucks.forEach((t) => it.run(job.id, t));
      if ('crewNumber' in req.body) db.prepare('UPDATE jobs SET crew_number = ? WHERE id = ?').run(crewNumber, job.id);
    });
    res.json(listJobs({}).find((j) => j.id === job.id));
  });

  app.get('/api/rate-card', (req, res) => res.json(currentRateCard()));

  // Lookup lists for forms (lead source, arrival window pickers).
  app.get('/api/lookups', (req, res) => {
    res.json({
      advertising_sources: db.prepare('SELECT code, label FROM advertising_sources WHERE active = 1 ORDER BY label').all(),
      arrival_windows: db.prepare('SELECT id, label, start_time, end_time FROM arrival_windows WHERE active = 1 ORDER BY end_time IS NULL, start_time').all(),
      agents: db.prepare(`SELECT id, coalesce(business_name, first_name || ' ' || last_name) AS name FROM agents ORDER BY name`).all(),
    });
  });

  app.get('/api/zip/:zip', (req, res) => {
    const z = /^\d{5}$/.test(req.params.zip) && db.prepare('SELECT zip, city, state FROM zip_codes WHERE zip = ?').get(req.params.zip);
    if (!z) throw new HttpError(404, `ZIP code ${req.params.zip} not found`);
    res.json(z);
  });

  // ?from=&to= are street addresses (Census geocoder) or anything containing a ZIP code (fallback).
  app.get('/api/distance', wrap(async (req, res) => {
    res.json({ provider: distance.provider, ...(await distance.distance(req.query.from, req.query.to)) });
  }));

  app.get('/api/config', (req, res) => {
    res.json({ distance_provider: distance.provider, email_configured: mailer.configured, yard_address: yardAddress });
  });

  // ------------------------------------------------------------ crew contact details
  app.patch('/api/crew/:id', (req, res) => {
    const member = db.prepare('SELECT id FROM crew_members WHERE id = ?').get(req.params.id);
    if (!member) throw new HttpError(404, 'Crew member not found');
    const email = req.body.email == null ? undefined : String(req.body.email).trim() || null;
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, `"${email}" is not a valid email address`);
    if (email !== undefined) db.prepare('UPDATE crew_members SET email = ? WHERE id = ?').run(email, member.id);
    if (req.body.phone !== undefined) db.prepare('UPDATE crew_members SET phone = ? WHERE id = ?').run(String(req.body.phone).trim() || null, member.id);
    res.json(db.prepare('SELECT id, first_name, last_name, role, phone, email FROM crew_members WHERE id = ?').get(member.id));
  });

  // ------------------------------------------------------------ directions for the crew
  function jobDirections(jobId) {
    const job = listJobs({}).find((j) => j.id === Number(jobId));
    if (!job) throw new HttpError(404, 'Job not found');
    const addr = db.prepare('SELECT * FROM addresses WHERE id = ?');
    const origin = job.origin_address_id ? addr.get(job.origin_address_id) : null;
    const destination = job.destination_address_id ? addr.get(job.destination_address_id) : null;
    const stops = [yardAddress, fullAddress(origin), fullAddress(destination)].filter(Boolean);
    const url = directionsUrl(stops);
    const crew = db.prepare(`SELECT m.id, m.first_name, m.first_name || ' ' || m.last_name AS name, m.email, jc.is_lead
      FROM job_crew jc JOIN crew_members m ON m.id = jc.crew_member_id WHERE jc.job_id = ? ORDER BY jc.is_lead DESC, m.last_name`).all(job.id);

    const access = (a) => [a.stair_flights && !a.has_elevator ? `${a.stair_flights} flight(s) of stairs` : null,
      a.has_elevator ? `elevator (floor ${a.floor})` : null, a.long_walks ? 'long walk' : null, a.description].filter(Boolean).join('; ');
    const day = job.move_date ? new Date(`${job.move_date}T12:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'date TBD';
    const window = job.arrival_window_start
      ? (job.arrival_window_end ? `${fmt12(job.arrival_window_start)}–${fmt12(job.arrival_window_end)}` : `at ${fmt12(job.arrival_window_start)}`)
      : 'time TBD';
    const subject = `Job ${job.job_number} · ${day} · arrive ${window}`;
    // Only crew-facing notes go out. internal_notes never leave the office.
    const body = [
      `Job ${job.job_number} on ${day}. Arrive ${window}.`,
      '',
      `Crew: ${crew.map((c) => (c.is_lead ? `${c.name} (lead)` : c.name)).join(', ') || 'TBD'}`,
      `Truck: ${job.trucks.map((t) => t.name).join(', ') || 'assigned at the yard'}`,
      '',
      `Customer: ${job.customer_name}${job.customer_phone ? `, ${job.customer_phone}` : ''}`,
      `Pickup: ${fullAddress(origin) || 'not entered'}${origin && access(origin) ? ` (${access(origin)})` : ''}`,
      `Drop-off: ${fullAddress(destination) || 'not entered'}${destination && access(destination) ? ` (${access(destination)})` : ''}`,
      job.special_items ? `Special items: ${job.special_items}` : null,
      job.notes ? `Notes: ${job.notes}` : null,
      '',
      url ? `Directions (${yardAddress ? 'yard → pickup → drop-off' : 'pickup → drop-off'}):\n${url}` : 'Directions: not enough address details for a route.',
    ].filter((l) => l !== null).join('\n');
    return { job, stops, url, crew, subject, body };
  }

  app.get('/api/jobs/:id/directions', (req, res) => {
    const d = jobDirections(req.params.id);
    res.json({ job_number: d.job.job_number, stops: d.stops, maps_url: d.url, crew: d.crew, subject: d.subject, body: d.body,
      email_configured: mailer.configured, yard_address: yardAddress });
  });

  // Body: { recipients: [{ crewId, email }] }. Emails typed in the dialog are saved to the crew member.
  app.post('/api/jobs/:id/directions/send', wrap(async (req, res) => {
    const d = jobDirections(req.params.id);
    const onJob = new Map(d.crew.map((c) => [c.id, c]));
    const recipients = (req.body.recipients || []).map((r) => ({ crew: onJob.get(Number(r.crewId)), email: String(r.email || '').trim() }));
    if (!recipients.length) throw new HttpError(400, 'Choose at least one crew member');
    const bad = recipients.filter((r) => !r.crew || !EMAIL_RE.test(r.email));
    if (bad.length) throw new HttpError(400, `Check the email address for ${bad.map((r) => r.crew?.name ?? 'an unknown crew member').join(', ')}`);
    if (!d.url) throw new HttpError(422, 'This job needs pickup and drop-off addresses before directions can be sent');
    if (!mailer.configured) throw new HttpError(503, 'Email is not set up yet (SMTP settings missing)');

    const saveEmail = db.prepare('UPDATE crew_members SET email = ? WHERE id = ?');
    for (const r of recipients) saveEmail.run(r.email, r.crew.id);
    const sent = [];
    const failed = [];
    for (const r of recipients) {
      try {
        await mailer.send({ to: r.email, subject: d.subject, text: `Hi ${r.crew.first_name},\n\n${d.body}` });
        sent.push(r.crew.name);
      } catch (err) {
        failed.push({ name: r.crew.name, error: err.message });
      }
    }
    if (sent.length) {
      db.prepare('INSERT INTO job_events (job_id, from_status, to_status, note, actor) VALUES (?, ?, ?, ?, ?)')
        .run(d.job.id, d.job.status, d.job.status, `Directions emailed to ${sent.join(', ')}`, req.body.actor ?? 'dispatcher');
    }
    res.status(failed.length && !sent.length ? 502 : 200).json({ sent, failed });
  }));

  app.post('/api/quote/preview', wrap(async (req, res) => {
    const card = currentRateCard();
    if (!card) throw new HttpError(503, 'No active rate card: add one before quoting');
    const b = req.body;
    if (!(Number(b.hours) > 0)) throw new HttpError(400, 'hours must be > 0');
    res.json(calculateQuote({
      hours: Number(b.hours),
      crewSize: b.crewSize != null ? Number(b.crewSize) : undefined,
      trucks: b.trucks != null ? Number(b.trucks) : undefined,
      distanceMiles: b.distanceMiles == null && b.originAddress && b.destinationAddress
        ? (await distance.distance(b.originAddress, b.destinationAddress)).miles
        : Number(b.distanceMiles) || 0,
      moveDate: b.moveDate || undefined,
      origin: b.origin,
      destination: b.destination,
    }, card));
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message, ...err.details });
  });
  return app;
}

module.exports = { createApp, TRANSITIONS };
