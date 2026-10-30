// Estimates (the legacy "Estimates" form): customer + addresses + pricing on one record,
// plus the reference data the form needs (settings, rates, item catalog, customer search).
const express = require('express');
const { tx } = require('./db');
const { HttpError, EMAIL_RE, today } = require('./http');
const { priceJob, validateEstimateTerms, hoursBetween, closeoutPrice } = require('./pricing');
const { renderEmail } = require('./documents');
const { scrubSensitive } = require('./legacy/transform');
const { DEFAULT_SETTINGS } = require('./db/defaults');
const { MAX_STOPS } = require('./maps');

const CUSTOMER_FIELDS = ['kind', 'first_name', 'last_name', 'company_name', 'email', 'phone', 'cell_phone', 'work_phone',
  'work_ext', 'new_phone', 'fax', 'advertising_source'];
const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'postal_code', 'description'];
const ADDRESS_COUNTS = ['stair_flights', 'long_walks', 'elevator_floors'];
const STOP_KINDS = ['pickup', 'dropoff'];

// Job fields the form may set, with their types.
const JOB_FIELDS = {
  move_date: 'date', arrival_window_start: 'time', arrival_window_end: 'time', est_hours: 'number', crew_size: 'int',
  trucks_needed: 'int', minimum_hours: 'number', hourly_rate_cents: 'cents', trip_charge_cents: 'cents',
  fixed_price_cents: 'cents', pricing_method: 'text', estimate_type: 'text', not_to_exceed_cents: 'cents',
  move_addition_percent: 'percent', move_addition_cents: 'signed_cents', sales_addition_percent: 'percent',
  sales_addition_cents: 'signed_cents', discount_percent: 'percent', discount_cents: 'cents', callback_date: 'date',
  site_visit_at: 'datetime', agent_id: 'int', sales_rep_id: 'int', distance_miles: 'number', special_items: 'text',
  notes: 'text', internal_notes: 'text', po_number: 'text',
};
const NOT_NULL_DEFAULTS = { crew_size: 2, trucks_needed: 1, pricing_method: 'hourly', estimate_type: 'standard',
  move_addition_percent: 0, move_addition_cents: 0, sales_addition_percent: 0, sales_addition_cents: 0,
  discount_percent: 0, discount_cents: 0 };

const LABELS = { est_hours: 'Estimated hours', crew_size: 'Number of movers', minimum_hours: 'Minimum hours',
  hourly_rate_cents: 'Hourly rate', trip_charge_cents: 'Trip charge', fixed_price_cents: 'Fixed price',
  not_to_exceed_cents: 'Not-to-exceed amount', discount_percent: 'Discount %', discount_cents: 'Discount' };
const label = (k) => LABELS[k] || k.replace(/_cents$/, '').replace(/_/g, ' ');

const blank = (v) => v == null || String(v).trim() === '';
const text = (v) => (blank(v) ? null : String(v).trim());

// Free text must never carry payment card numbers or SSNs (see CLAUDE.md security rules).
function rejectSensitive(value, field) {
  if (value && scrubSensitive(value).removed) {
    throw new HttpError(400, `${field} looks like it contains a card number or SSN. Don't store those here; record only the last 4 digits.`);
  }
  return value;
}

function cleanValue(key, type, v) {
  if (blank(v)) return null;
  const n = Number(v);
  switch (type) {
    case 'text': return rejectSensitive(String(v).trim(), label(key));
    case 'date': if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v; break;
    case 'time': if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return v; break;
    case 'datetime': if (/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(v)) return v; break;
    case 'int': if (Number.isInteger(n) && n >= 0) return n; break;
    case 'number': if (Number.isFinite(n) && n >= 0) return n; break;
    case 'percent': if (Number.isFinite(n) && n >= 0 && n <= 100) return n; break;
    case 'cents': if (Number.isInteger(n) && n >= 0) return n; break;
    case 'signed_cents': if (Number.isInteger(n)) return n; break;
    default: break;
  }
  throw new HttpError(400, `${label(key)}: "${v}" is not valid`);
}

function cleanJob(input = {}) {
  const job = {};
  for (const [k, type] of Object.entries(JOB_FIELDS)) {
    if (k in input) job[k] = cleanValue(k, type, input[k]) ?? NOT_NULL_DEFAULTS[k] ?? null;
  }
  return job;
}

function cleanLines(list, kind) {
  if (!Array.isArray(list)) return [];
  return list.filter((l) => !blank(l.description)).map((l, i) => {
    const quantity = Number(l.quantity ?? 1);
    const unit = Number(l.unit_cents ?? 0);
    if (!(quantity > 0)) throw new HttpError(400, `${kind} "${l.description}": quantity must be more than 0`);
    if (!Number.isInteger(unit) || unit < 0) throw new HttpError(400, `${kind} "${l.description}": price is not valid`);
    return {
      item_id: l.item_id ? Number(l.item_id) : null,
      code: text(l.code),
      description: rejectSensitive(String(l.description).trim(), kind),
      quantity,
      unit_cents: unit,
      cubic_feet: blank(l.cubic_feet) ? null : Number(l.cubic_feet),
      sort_order: i,
    };
  });
}

function nextJobNumber(db) {
  const row = db.prepare(`SELECT max(CAST(job_number AS INTEGER)) AS n FROM jobs WHERE job_number NOT GLOB '*[^0-9]*'`).get();
  return String((row.n || 1000) + 1);
}

const DOCUMENT_LABELS = { proposal: 'Proposal', confirmation: 'Confirmation', invoice: 'Invoice' };
const PAYMENT_KINDS = ['deposit', 'payment', 'refund'];
const PAYMENT_METHODS = ['cash', 'check', 'card', 'ach', 'other'];

/**
 * @returns {{ sendDocument(jobId: number, kind: string, actor?: string): Promise<{sent: boolean, to?: string, reason?: string}> }}
 */
function registerEstimateRoutes(app, db, { currentRateCard, TRANSITIONS, mailer }) {
  // ------------------------------------------------------------ settings + rates
  const readSettings = () => ({ ...DEFAULT_SETTINGS, ...Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])) });

  const logoInfo = () => db.prepare('SELECT mime, length(data) AS bytes, updated_at FROM files WHERE key = ?').get('logo') ?? null;
  app.get('/api/settings', (req, res) => res.json({ settings: readSettings(), rate_card: currentRateCard(), logo: logoInfo() }));

  // ------------------------------------------------------------ company logo
  // Raster images only: SVG can carry scripts. The type is checked from the file's first bytes, not trusted from the browser.
  const LOGO_TYPES = {
    'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
    'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  };
  const MAX_LOGO_BYTES = 2 * 1024 * 1024;
  app.put('/api/settings/logo', express.raw({ type: () => true, limit: MAX_LOGO_BYTES }), (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = Object.keys(LOGO_TYPES).find((t) => LOGO_TYPES[t](buf));
    if (!buf.length) throw new HttpError(400, 'Choose an image file');
    if (!mime) throw new HttpError(415, 'The logo must be a PNG, JPEG, GIF or WebP image');
    db.prepare(`INSERT INTO files (key, mime, data) VALUES ('logo', ?, ?)
      ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(mime, buf);
    res.json({ logo: logoInfo() });
  });
  app.get('/api/settings/logo', (req, res) => {
    const f = db.prepare('SELECT mime, data FROM files WHERE key = ?').get('logo');
    if (!f) throw new HttpError(404, 'No logo uploaded');
    res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.send(Buffer.from(f.data));
  });
  app.delete('/api/settings/logo', (req, res) => {
    db.prepare("DELETE FROM files WHERE key = 'logo'").run();
    res.json({ logo: null });
  });

  app.put('/api/settings', (req, res) => {
    const input = req.body.settings || {};
    // The payer EIN is printed on 1099s. Refuse anything shaped like an SSN (123-45-6789).
    if (input.payer_ein) {
      const ein = String(input.payer_ein).trim();
      if (/^\d{3}-?\d{2}-?\d{4}$/.test(ein) && !/^\d{2}-?\d{7}$/.test(ein)) throw new HttpError(400, 'That looks like an SSN. Enter the business EIN (12-3456789).');
      if (!/^\d{2}-?\d{7}$/.test(ein)) throw new HttpError(400, 'EIN must look like 12-3456789');
      input.payer_ein = `${ein.replace('-', '').slice(0, 2)}-${ein.replace('-', '').slice(2)}`;
    }
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    tx(db, () => {
      for (const key of Object.keys(DEFAULT_SETTINGS)) if (key in input) put.run(key, String(input[key] ?? '').trim());
    });
    res.json({ settings: readSettings() });
  });

  // Saving rates creates a new version effective today (or updates today's), so estimates already
  // saved keep the rates they were quoted at.
  app.put('/api/rate-card', (req, res) => {
    const b = req.body;
    const current = currentRateCard();
    const perMover = Number(b.per_mover_hourly_cents);
    const trip = Number(b.travel_fee_cents);
    const minHours = Number(b.minimum_hours ?? current?.minimum_hours ?? 2);
    const increment = Number(b.billing_increment_min ?? current?.billing_increment_min ?? 15);
    if (!(Number.isInteger(perMover) && perMover > 0)) throw new HttpError(400, 'Enter the hourly rate per mover');
    if (!(Number.isInteger(trip) && trip >= 0)) throw new HttpError(400, 'Enter the trip charge (0 for none)');
    if (!(minHours >= 0 && minHours <= 24)) throw new HttpError(400, 'Minimum hours must be between 0 and 24');
    if (![1, 5, 6, 10, 15, 20, 30, 60].includes(increment)) throw new HttpError(400, 'Billing increment must be 1, 5, 6, 10, 15, 20, 30 or 60 minutes');
    const overrides = Object.entries(b.crew_rates || {}).filter(([, v]) => !blank(v)).map(([size, cents]) => {
      if (!(Number.isInteger(Number(size)) && Number(size) > 0 && Number.isInteger(Number(cents)) && Number(cents) > 0)) {
        throw new HttpError(400, `Crew rate for ${size} movers is not valid`);
      }
      return [Number(size), Number(cents)];
    });

    tx(db, () => {
      let id = current?.effective_from === today() ? current.id : null;
      if (id) {
        db.prepare(`UPDATE rate_cards SET per_mover_hourly_cents = ?, travel_fee_cents = ?, minimum_hours = ?, billing_increment_min = ? WHERE id = ?`)
          .run(perMover, trip, minHours, increment, id);
      } else {
        id = db.prepare(`INSERT INTO rate_cards (name, effective_from, per_mover_hourly_cents, extra_truck_hourly_cents, minimum_hours,
            billing_increment_min, travel_fee_cents, mileage_cents_per_mile, free_miles, stair_flight_fee_cents, long_walk_fee_cents,
            weekend_multiplier, peak_season_multiplier, peak_season_months, tax_rate)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`Rates from ${today()}`, today(), perMover,
          current?.extra_truck_hourly_cents ?? 0, minHours, increment, trip, current?.mileage_cents_per_mile ?? 0, current?.free_miles ?? 0,
          current?.stair_flight_fee_cents ?? 0, current?.long_walk_fee_cents ?? 0, current?.weekend_multiplier ?? 1,
          current?.peak_season_multiplier ?? 1, current?.peak_season_months ?? '5,6,7,8', current?.tax_rate ?? 0).lastInsertRowid;
      }
      db.prepare('DELETE FROM rate_card_crew_rates WHERE rate_card_id = ?').run(id);
      const ins = db.prepare('INSERT INTO rate_card_crew_rates (rate_card_id, crew_size, hourly_cents) VALUES (?, ?, ?)');
      for (const [size, cents] of overrides) ins.run(id, size, cents);
    });
    res.json(currentRateCard());
  });

  // ------------------------------------------------------------ item catalog
  app.get('/api/items', (req, res) => {
    res.json(db.prepare(`SELECT * FROM items ${req.query.all ? '' : 'WHERE active = 1'} ORDER BY description`).all());
  });

  function saveItem(id, b) {
    const description = text(b.description);
    const price = Number(b.price_cents);
    if (!description) throw new HttpError(400, 'Enter a description');
    if (!(Number.isInteger(price) && price >= 0)) throw new HttpError(400, 'Price is not valid');
    const values = [text(b.code)?.toUpperCase() ?? null, description, price, blank(b.cubic_feet) ? null : Number(b.cubic_feet),
      blank(b.weight_lbs) ? null : Number(b.weight_lbs), b.active === false || b.active === 0 ? 0 : 1];
    try {
      if (id) {
        if (!db.prepare('UPDATE items SET code = ?, description = ?, price_cents = ?, cubic_feet = ?, weight_lbs = ?, active = ? WHERE id = ?').run(...values, id).changes) {
          throw new HttpError(404, 'Item not found');
        }
        return id;
      }
      return db.prepare('INSERT INTO items (code, description, price_cents, cubic_feet, weight_lbs, active) VALUES (?, ?, ?, ?, ?, ?)').run(...values).lastInsertRowid;
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(409, `Item code ${values[0]} is already used`);
      throw err;
    }
  }
  app.post('/api/items', (req, res) => res.status(201).json(db.prepare('SELECT * FROM items WHERE id = ?').get(saveItem(null, req.body))));
  app.put('/api/items/:id', (req, res) => res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(saveItem(Number(req.params.id), req.body))));

  // ------------------------------------------------------------ search
  // Matches names, company, email, estimate number, and phone numbers by digits ("281 555" finds "(281) 555-0100").
  const digitsSql = (col) => `replace(replace(replace(replace(replace(coalesce(${col}, ''), '(', ''), ')', ''), '-', ''), ' ', ''), '.', '')`;
  function searchClause(q, params) {
    if (blank(q)) return '1 = 1';
    const like = `%${String(q).trim().toLowerCase()}%`;
    const digits = String(q).replace(/\D/g, '');
    const parts = ["lower(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) LIKE ?", "lower(coalesce(c.last_name, '')) LIKE ?",
      "lower(coalesce(c.company_name, '')) LIKE ?", "lower(coalesce(c.email, '')) LIKE ?"];
    params.push(like, like, like, like);
    if (digits.length >= 3) {
      for (const col of ['c.phone', 'c.cell_phone', 'c.work_phone', 'c.new_phone']) { parts.push(`${digitsSql(col)} LIKE ?`); params.push(`%${digits}%`); }
    }
    return `(${parts.join(' OR ')})`;
  }

  app.get('/api/customers', (req, res) => {
    const params = [];
    const where = searchClause(req.query.q, params);
    const rows = db.prepare(`SELECT c.*, (SELECT count(*) FROM jobs j WHERE j.customer_id = c.id) AS job_count FROM customers c
      WHERE ${where} ORDER BY c.updated_at DESC LIMIT 20`).all(...params);
    const addr = db.prepare('SELECT * FROM addresses WHERE customer_id = ? ORDER BY id DESC');
    res.json(rows.map((c) => ({ ...c, addresses: addr.all(c.id).map(addressOut) })));
  });

  app.get('/api/estimates', (req, res) => {
    const params = [];
    let where = searchClause(req.query.q, params);
    if (!blank(req.query.q)) { where = `(${where} OR j.job_number LIKE ?)`; params.push(`%${String(req.query.q).trim()}%`); }
    if (req.query.status) { where += ' AND j.status = ?'; params.push(req.query.status); }
    if (req.query.from) { where += ' AND j.move_date >= ?'; params.push(req.query.from); }
    if (req.query.to) { where += ' AND j.move_date <= ?'; params.push(req.query.to); }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(db.prepare(`
      SELECT j.id, j.job_number, j.status, j.move_date, j.arrival_window_start, j.arrival_window_end, j.pricing_method, j.estimate_type,
             j.crew_size, j.quoted_total_cents, j.final_total_cents, j.callback_date, j.created_at,
             coalesce(c.company_name, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))) AS customer_name,
             coalesce(c.phone, c.cell_phone) AS customer_phone, o.city AS origin_city, d.city AS destination_city
      FROM jobs j JOIN customers c ON c.id = j.customer_id
      LEFT JOIN addresses o ON o.id = j.origin_address_id LEFT JOIN addresses d ON d.id = j.destination_address_id
      WHERE ${where}
      ORDER BY coalesce(j.move_date, substr(j.created_at, 1, 10)) DESC, j.id DESC LIMIT ${limit}`).all(...params));
  });

  // ------------------------------------------------------------ one estimate
  function addressOut(a) {
    if (!a) return null;
    return { id: a.id, line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.postal_code,
      description: a.description, stair_flights: a.stair_flights, long_walks: a.long_walks, elevator_floors: a.has_elevator ? a.floor : 0 };
  }

  function loadEstimate(id) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!job) throw new HttpError(404, 'Estimate not found');
    const addr = db.prepare('SELECT * FROM addresses WHERE id = ?');
    const items = db.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY sort_order, id').all(id);
    const services = db.prepare('SELECT * FROM job_services WHERE job_id = ? ORDER BY sort_order, id').all(id);
    const card = currentRateCard();
    const opts = { items, services, billingIncrementMin: card?.billing_increment_min ?? 15 };
    const payments = db.prepare('SELECT id, kind, method, amount_cents, reference, received_at FROM payments WHERE job_id = ? ORDER BY received_at, id').all(id);
    const paid = payments.reduce((sum, p) => sum + (p.kind === 'refund' ? -p.amount_cents : p.amount_cents), 0);
    const owed = job.final_total_cents ?? job.quoted_total_cents ?? 0;
    return {
      job,
      customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(job.customer_id),
      origin: addressOut(job.origin_address_id && addr.get(job.origin_address_id)),
      destination: addressOut(job.destination_address_id && addr.get(job.destination_address_id)),
      stops: db.prepare('SELECT address_id, kind FROM job_stops WHERE job_id = ? ORDER BY sort_order, id').all(id)
        .map((s) => ({ ...addressOut(addr.get(s.address_id)), kind: s.kind })),
      items,
      services,
      price: priceJob(job, opts),
      closeout: closeoutPrice(job, opts),
      payments,
      paid_cents: paid,
      balance_cents: owed - paid,
      email_configured: Boolean(mailer?.configured),
      history: db.prepare('SELECT from_status, to_status, note, actor, created_at FROM job_events WHERE job_id = ? ORDER BY id DESC').all(id),
      allowed_statuses: TRANSITIONS[job.status] ?? [],
      sales_rep: job.sales_rep_id ? db.prepare(`SELECT id, first_name || ' ' || last_name AS name FROM crew_members WHERE id = ?`).get(job.sales_rep_id) : null,
      agent: job.agent_id ? db.prepare(`SELECT id, coalesce(business_name, first_name || ' ' || last_name) AS name FROM agents WHERE id = ?`).get(job.agent_id) : null,
    };
  }

  app.get('/api/estimates/:id(\\d+)', (req, res) => res.json(loadEstimate(Number(req.params.id))));

  // Live total while the form is being filled in. Never saves anything.
  app.post('/api/estimates/price', (req, res) => {
    const job = { ...NOT_NULL_DEFAULTS, ...cleanJob(req.body.job) };
    const card = currentRateCard();
    res.json({
      ...priceJob(job, { items: cleanLines(req.body.items, 'Item'), services: cleanLines(req.body.services, 'Service'),
        billingIncrementMin: card?.billing_increment_min ?? 15 }),
      problem: validateEstimateTerms(job),
    });
  });

  function saveEstimate(id, body) {
    const c = body.customer || {};
    const customerIn = Object.fromEntries(CUSTOMER_FIELDS.filter((k) => k in c).map((k) => [k, k === 'kind' ? c[k] : text(c[k])]));
    if (customerIn.email && !EMAIL_RE.test(customerIn.email)) throw new HttpError(400, `"${customerIn.email}" is not a valid email address`);
    if (customerIn.kind && !['residential', 'commercial'].includes(customerIn.kind)) throw new HttpError(400, 'Customer type is not valid');
    if (customerIn.advertising_source && !db.prepare('SELECT 1 FROM advertising_sources WHERE code = ?').get(customerIn.advertising_source)) {
      throw new HttpError(400, 'Unknown referral source');
    }
    const jobIn = cleanJob(body.job);
    const items = cleanLines(body.items, 'Item');
    const services = cleanLines(body.services, 'Service');

    return tx(db, () => {
      const existing = id ? db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) : null;
      if (id && !existing) throw new HttpError(404, 'Estimate not found');

      // Customer: update the chosen/linked one, or create a new one.
      let customerId = Number(c.id) || existing?.customer_id || null;
      if (customerId && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) throw new HttpError(400, 'Customer not found');
      const merged = { ...(customerId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : {}), ...customerIn };
      if (!merged.last_name && !merged.first_name && !merged.company_name) throw new HttpError(400, 'Enter the customer\'s name or company');
      if (customerId) {
        const keys = Object.keys(customerIn);
        if (keys.length) {
          db.prepare(`UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
            .run(...keys.map((k) => customerIn[k]), customerId);
        }
      } else {
        const keys = Object.keys(customerIn);
        customerId = db.prepare(`INSERT INTO customers (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
          .run(...keys.map((k) => customerIn[k])).lastInsertRowid;
      }

      // Addresses: reuse a saved address of this customer, update it, or add a new one.
      const saveAddress = (a, currentId) => {
        if (!a) return currentId ?? null;
        const vals = Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, k === 'description' ? rejectSensitive(text(a[k]), 'Address description') : text(a[k])]));
        if (Object.values(vals).every((v) => v == null)) return null;
        const counts = Object.fromEntries(ADDRESS_COUNTS.map((k) => [k, Math.max(0, Math.round(Number(a[k]) || 0))]));
        const row = [vals.line1 ?? '', vals.line2, vals.city ?? '', (vals.state ?? '').toUpperCase(), vals.postal_code ?? '', vals.description,
          counts.stair_flights, counts.long_walks, counts.elevator_floors > 0 ? 1 : 0, counts.elevator_floors > 0 ? counts.elevator_floors : 1];
        const addrId = Number(a.id) || null;
        if (addrId && db.prepare('SELECT 1 FROM addresses WHERE id = ? AND customer_id = ?').get(addrId, customerId)) {
          db.prepare(`UPDATE addresses SET line1 = ?, line2 = ?, city = ?, state = ?, postal_code = ?, description = ?, stair_flights = ?,
            long_walks = ?, has_elevator = ?, floor = ? WHERE id = ?`).run(...row, addrId);
          return addrId;
        }
        return db.prepare(`INSERT INTO addresses (line1, line2, city, state, postal_code, description, stair_flights, long_walks, has_elevator,
          floor, customer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...row, customerId).lastInsertRowid;
      };
      const originId = saveAddress(body.origin, existing?.origin_address_id);
      const destinationId = saveAddress(body.destination, existing?.destination_address_id);
      // Extra stops (left as they are when the request has no stops list). Blank stops are dropped.
      let stops = null;
      if (Array.isArray(body.stops)) {
        stops = body.stops.map((s) => ({ kind: s?.kind ?? 'pickup', address_id: saveAddress(s) })).filter((s) => s.address_id);
        if (stops.length > MAX_STOPS) throw new HttpError(400, `At most ${MAX_STOPS} extra stops`);
        if (stops.some((s) => !STOP_KINDS.includes(s.kind))) throw new HttpError(400, 'Each stop is a pickup or a drop-off');
      }

      const job = { ...NOT_NULL_DEFAULTS, ...(existing || {}), ...jobIn, customer_id: customerId, origin_address_id: originId, destination_address_id: destinationId };
      // A fixed or itemized price is a guaranteed (binding) price by definition.
      if (['fixed', 'itemized'].includes(job.pricing_method)) job.estimate_type = 'binding';
      if (job.sales_rep_id && !db.prepare('SELECT 1 FROM crew_members WHERE id = ?').get(job.sales_rep_id)) throw new HttpError(400, 'Unknown sales rep');
      if (job.agent_id && !db.prepare('SELECT 1 FROM agents WHERE id = ?').get(job.agent_id)) throw new HttpError(400, 'Unknown agent');
      if (job.pricing_method === 'weight' && !existing) throw new HttpError(400, 'Weight pricing is only kept for legacy estimates');
      const problem = validateEstimateTerms(job);
      if (problem) throw new HttpError(400, problem);
      const card = currentRateCard();
      const price = priceJob(job, { items, services, billingIncrementMin: card?.billing_increment_min ?? 15 });

      const cols = [...Object.keys(JOB_FIELDS), 'customer_id', 'origin_address_id', 'destination_address_id', 'quoted_total_cents'];
      job.quoted_total_cents = price.total_cents;
      let jobId = id;
      if (existing) {
        db.prepare(`UPDATE jobs SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
          .run(...cols.map((k) => job[k] ?? null), id);
      } else {
        const status = ['lead', 'quoted'].includes(body.status) ? body.status : 'lead';
        jobId = db.prepare(`INSERT INTO jobs (${cols.join(', ')}, job_number, status, rate_card_id) VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?)`)
          .run(...cols.map((k) => job[k] ?? null), nextJobNumber(db), status, card?.id ?? null).lastInsertRowid;
        db.prepare(`INSERT INTO job_events (job_id, from_status, to_status, note, actor) VALUES (?, NULL, ?, 'Estimate created', ?)`)
          .run(jobId, status, body.actor ?? 'office');
      }

      if (stops) {
        db.prepare('DELETE FROM job_stops WHERE job_id = ?').run(jobId);
        const insStop = db.prepare('INSERT INTO job_stops (job_id, address_id, kind, sort_order) VALUES (?, ?, ?, ?)');
        stops.forEach((s, i) => insStop.run(jobId, s.address_id, s.kind, i));
      }

      db.prepare('DELETE FROM job_items WHERE job_id = ?').run(jobId);
      const insItem = db.prepare(`INSERT INTO job_items (job_id, item_id, code, description, quantity, unit_cents, cubic_feet, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const it of items) insItem.run(jobId, it.item_id, it.code, it.description, it.quantity, it.unit_cents, it.cubic_feet, it.sort_order);
      db.prepare('DELETE FROM job_services WHERE job_id = ?').run(jobId);
      const insSvc = db.prepare('INSERT INTO job_services (job_id, description, quantity, unit_cents, sort_order) VALUES (?, ?, ?, ?, ?)');
      for (const sv of services) insSvc.run(jobId, sv.description, sv.quantity, sv.unit_cents, sv.sort_order);
      db.prepare('DELETE FROM quote_lines WHERE job_id = ?').run(jobId);
      const insLine = db.prepare('INSERT INTO quote_lines (job_id, code, description, amount_cents) VALUES (?, ?, ?, ?)');
      for (const l of price.lines) insLine.run(jobId, l.code, l.description, l.amount_cents);
      return jobId;
    });
  }

  app.post('/api/estimates', (req, res) => res.status(201).json(loadEstimate(saveEstimate(null, req.body))));
  app.put('/api/estimates/:id(\\d+)', (req, res) => res.json(loadEstimate(saveEstimate(Number(req.params.id), req.body))));

  // ------------------------------------------------------------ closeout + payments
  // Body: { actual_start_time, actual_end_time, actual_hours, final_total_cents (blank = calculate), tips_cents }
  app.put('/api/estimates/:id(\\d+)/closeout', (req, res) => {
    const id = Number(req.params.id);
    const est = loadEstimate(id);
    const b = req.body;
    const start = cleanValue('actual_start_time', 'time', b.actual_start_time);
    const end = cleanValue('actual_end_time', 'time', b.actual_end_time);
    let hours = cleanValue('actual_hours', 'number', b.actual_hours);
    if (hours == null && start && end) hours = hoursBetween(start, end);
    if (start && end && !hoursBetween(start, end)) throw new HttpError(400, 'End time must be after start time');
    const manual = cleanValue('final_total_cents', 'cents', b.final_total_cents);
    const tips = cleanValue('tips_cents', 'cents', b.tips_cents) ?? 0;
    const computed = closeoutPrice({ ...est.job, actual_hours: hours }, { items: est.items, services: est.services,
      billingIncrementMin: currentRateCard()?.billing_increment_min ?? 15 });
    const final = manual ?? computed?.total_cents ?? null;
    tx(db, () => {
      db.prepare(`UPDATE jobs SET actual_start_time = ?, actual_end_time = ?, actual_hours = ?, final_total_cents = ?,
        final_total_manual = ?, tips_cents = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(start, end, hours, final, manual != null ? 1 : 0, tips, id);
      if (final != null && final !== est.job.final_total_cents) {
        db.prepare(`INSERT INTO job_events (job_id, from_status, to_status, note, actor) VALUES (?, ?, ?, ?, ?)`)
          .run(id, est.job.status, est.job.status, `Final total $${(final / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}${manual != null ? ' (entered)' : ''}`, b.actor ?? 'office');
      }
    });
    res.json(loadEstimate(id));
  });

  // Payments record method, amount and a reference (check number, or card last 4 + auth code) only.
  app.post('/api/estimates/:id(\\d+)/payments', (req, res) => {
    const id = Number(req.params.id);
    loadEstimate(id);
    const b = req.body;
    const amount = Number(b.amount_cents);
    if (!PAYMENT_KINDS.includes(b.kind ?? 'payment')) throw new HttpError(400, 'Payment type is not valid');
    if (b.method && !PAYMENT_METHODS.includes(b.method)) throw new HttpError(400, 'Payment method is not valid');
    if (!(Number.isInteger(amount) && amount > 0)) throw new HttpError(400, 'Enter the amount');
    const reference = rejectSensitive(text(b.reference), 'Reference');
    if (reference && /\d{12,}/.test(reference.replace(/[\s-]/g, ''))) {
      throw new HttpError(400, 'For card payments, record only the last 4 digits and the authorization code');
    }
    const date = cleanValue('received_at', 'date', b.received_at) ?? today();
    db.prepare('INSERT INTO payments (job_id, kind, method, amount_cents, reference, received_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, b.kind ?? 'payment', b.method || null, amount, reference, `${date}T12:00:00.000Z`);
    res.status(201).json(loadEstimate(id));
  });

  app.delete('/api/estimates/:id(\\d+)/payments/:paymentId(\\d+)', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('DELETE FROM payments WHERE id = ? AND job_id = ?').run(Number(req.params.paymentId), id).changes) {
      throw new HttpError(404, 'Payment not found');
    }
    res.json(loadEstimate(id));
  });

  // ------------------------------------------------------------ customer emails
  async function sendDocument(jobId, kind, actor = 'office') {
    if (!DOCUMENT_LABELS[kind]) throw new HttpError(400, 'Unknown document');
    const est = loadEstimate(jobId);
    const to = est.customer.email;
    if (!to) return { sent: false, reason: 'The customer has no email address' };
    if (!mailer?.configured) return { sent: false, reason: 'Email is not set up yet (SMTP settings missing)' };
    const logo = db.prepare("SELECT mime, data FROM files WHERE key = 'logo'").get();
    const msg = renderEmail(kind, est, readSettings(), { logoCid: logo ? 'company-logo' : null });
    const attachments = logo ? [{ filename: `logo.${logo.mime.split('/')[1]}`, content: Buffer.from(logo.data), contentType: logo.mime, cid: 'company-logo' }] : undefined;
    await mailer.send({ to, ...msg, attachments });
    db.prepare('INSERT INTO job_events (job_id, from_status, to_status, note, actor) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, est.job.status, est.job.status, `${DOCUMENT_LABELS[kind]} emailed to ${to}`, actor);
    return { sent: true, to };
  }

  app.get('/api/estimates/:id(\\d+)/email/:kind', (req, res) => {
    if (!DOCUMENT_LABELS[req.params.kind]) throw new HttpError(400, 'Unknown document');
    res.json(renderEmail(req.params.kind, loadEstimate(Number(req.params.id)), readSettings()));
  });

  app.post('/api/estimates/:id(\\d+)/email', async (req, res, next) => {
    try {
      const result = await sendDocument(Number(req.params.id), req.body.kind, req.body.actor);
      if (!result.sent) throw new HttpError(result.reason.startsWith('Email is not') ? 503 : 400, result.reason);
      res.json({ ...result, estimate: loadEstimate(Number(req.params.id)) });
    } catch (err) {
      next(err);
    }
  });

  return { sendDocument, readSettings };
}

module.exports = { registerEstimateRoutes };
