// Imports legacy CSV exports into the MoveOps database.
//   npm run import -- <folder-with-csv-files>
// Files are recognised by their header row, not their name, so "Customers.csv" holding the
// Estimates table is still imported as Estimates. Every table upserts on its legacy key, so the
// import can be re-run safely against a fresh export.
// Spreadsheets (.xls/.xlsx) must be saved as CSV first.
const fs = require('node:fs');
const path = require('node:path');
const { openDb, tx } = require('../db');
const { parseCsv } = require('./csv');
const t = require('./transform');

const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

// Header signatures, checked in order (Agents and Estimates also have FirstName/LastName).
const SIGNATURES = [
  ['Estimates', ['estimateid', 'movedate']],
  ['Agents', ['agentid', 'businessname']],
  ['Adjustments', ['adjustmentid', 'personnelid']],
  ['Cities', ['zipcode', 'latitude', 'longitude']],
  ['ArrivalTimes', ['arrivaltime']],
  ['AdvertisingCodes', ['advertisingcode']],
  ['Personnel', ['lastname', 'firstname']],
];

function detectTable(headers) {
  const have = new Set(headers.map(norm));
  return SIGNATURES.find(([, cols]) => cols.every((c) => have.has(c)))?.[0] ?? null;
}

// Columns with one identical value in every row are program defaults (e.g. Referral = "cards"
// on all 366 estimates), not real data.
function constantColumns(rows, minRows = 20) {
  if (rows.length < minRows) return new Set();
  return new Set(Object.keys(rows[0]).filter((k) => rows.every((r) => r[k] === rows[0][k])));
}

const importers = {
  AdvertisingCodes(db, rows, report) {
    const stmt = db.prepare(`INSERT INTO advertising_sources (code, label, legacy_value) VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET label = excluded.label, legacy_value = excluded.legacy_value`);
    for (const r of rows) {
      const a = t.advertisingSource(r.AdvertisingCode);
      if (!a) { report.skipped++; continue; }
      stmt.run(a.code, a.label, a.legacy_value);
      report.imported++;
    }
  },

  ArrivalTimes(db, rows, report) {
    const stmt = db.prepare(`INSERT INTO arrival_windows (label, start_time, end_time, sort_order, legacy_value) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(legacy_value) DO UPDATE SET label = excluded.label, start_time = excluded.start_time,
        end_time = excluded.end_time, sort_order = excluded.sort_order`);
    rows.forEach((r, i) => {
      const w = t.arrivalWindow(r.ArrivalTime, i + 1);
      if (!w) { report.skipped++; report.warnings.push(`Unrecognised arrival time "${r.ArrivalTime}"`); return; }
      stmt.run(w.label, w.start_time, w.end_time, w.sort_order, w.legacy_value);
      report.imported++;
    });
  },

  Cities(db, rows, report) {
    const stmt = db.prepare(`INSERT INTO zip_codes (zip, city, state, latitude, longitude, population) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(zip) DO UPDATE SET city = excluded.city, state = excluded.state, latitude = excluded.latitude,
        longitude = excluded.longitude, population = excluded.population`);
    for (const r of rows) {
      const z = t.zipCode(r);
      if (!z) { report.skipped++; continue; }
      stmt.run(z.zip, z.city, z.state, z.latitude, z.longitude, z.population);
      report.imported++;
    }
    if (rows.length === 10000) {
      report.warnings.push('Exactly 10,000 rows: the export looks truncated by a row limit. Re-export the full table.');
    }
  },

  Agents(db, rows, report) {
    const stmt = db.prepare(`INSERT INTO agents (legacy_id, business_name, first_name, last_name, address, city, state, postal_code,
        business_phone, alternate_phone, fax) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(legacy_id) DO UPDATE SET business_name = excluded.business_name, first_name = excluded.first_name,
        last_name = excluded.last_name, address = excluded.address, city = excluded.city, state = excluded.state,
        postal_code = excluded.postal_code, business_phone = excluded.business_phone,
        alternate_phone = excluded.alternate_phone, fax = excluded.fax`);
    for (const r of rows) {
      const a = t.agent(r);
      if (!a) { report.skipped++; continue; }
      stmt.run(a.legacy_id, a.business_name, a.first_name, a.last_name, a.address, a.city, a.state, a.postal_code,
        a.business_phone, a.alternate_phone, a.fax);
      report.imported++;
    }
  },

  // Adjustments reference PersonnelID. Until the Personnel table is imported, unknown IDs get an
  // inactive placeholder crew member ("Personnel #13") that a later Personnel import fills in.
  Adjustments(db, rows, report) {
    const findCrew = db.prepare('SELECT id FROM crew_members WHERE legacy_id = ?');
    const addPlaceholder = db.prepare(`INSERT INTO crew_members (first_name, last_name, role, active, legacy_id) VALUES ('Personnel', ?, 'mover', 0, ?)`);
    const stmt = db.prepare(`INSERT INTO crew_adjustments (legacy_id, crew_member_id, adjustment_date, category, description, amount_cents)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(legacy_id) DO UPDATE SET crew_member_id = excluded.crew_member_id, adjustment_date = excluded.adjustment_date,
        category = excluded.category, description = excluded.description, amount_cents = excluded.amount_cents`);
    const placeholders = new Set();
    for (const r of rows) {
      const a = t.adjustment(r);
      if (!a) { report.skipped++; report.warnings.push(`Invalid adjustment row ${r.AdjustmentID}`); continue; }
      let crew = findCrew.get(a.personnel_legacy_id);
      if (!crew) {
        crew = { id: addPlaceholder.run(`#${a.personnel_legacy_id}`, a.personnel_legacy_id).lastInsertRowid };
        placeholders.add(a.personnel_legacy_id);
      }
      stmt.run(a.legacy_id, crew.id, a.adjustment_date, a.category, a.description, a.amount_cents);
      report.imported++;
    }
    if (placeholders.size) {
      report.warnings.push(`Created ${placeholders.size} placeholder crew members for PersonnelIDs ${[...placeholders].join(', ')}; import Personnel to fill in names.`);
    }
  },

  // Rows with a PersonnelID update the matching (placeholder) crew member. Rows without one are
  // matched by name. Sensitive columns (SSN, bank details) are never read.
  Personnel(db, rows, report) {
    const byLegacy = db.prepare('SELECT id FROM crew_members WHERE legacy_id = ?');
    const byName = db.prepare('SELECT id FROM crew_members WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?)');
    const update = db.prepare('UPDATE crew_members SET first_name = ?, last_name = ?, phone = coalesce(?, phone), email = coalesce(?, email), active = 1 WHERE id = ?');
    const insert = db.prepare(`INSERT INTO crew_members (first_name, last_name, phone, email, role, active, legacy_id) VALUES (?, ?, ?, ?, 'mover', 1, ?)`);
    const sensitive = Object.keys(rows[0] || {}).filter((k) => /ssn|social|bank|routing|account/i.test(k));
    if (sensitive.length) report.warnings.push(`Ignored sensitive column(s): ${sensitive.map((k) => `"${k.trim()}"`).join(', ')}`);
    let withoutId = 0;
    for (const r of rows) {
      const p = t.personnel(r);
      if (!p) { report.skipped++; continue; }
      if (!p.legacy_id) withoutId++;
      const existing = (p.legacy_id && byLegacy.get(p.legacy_id)) || byName.get(p.first_name, p.last_name);
      if (existing) update.run(p.first_name, p.last_name, p.phone, p.email, existing.id);
      else insert.run(p.first_name, p.last_name, p.phone, p.email, p.legacy_id);
      report.imported++;
    }
    if (withoutId) report.warnings.push(`${withoutId} rows have no PersonnelID, so they cannot be linked to Adjustments.`);
  },

  // The legacy Estimates table holds customers, addresses, jobs, quotes and payments in one row.
  Estimates(db, rows, report) {
    const ignored = constantColumns(rows);
    // A phone number shared by 3+ different last names is a placeholder (office number, 000-0000...).
    const phoneNames = new Map();
    for (const r of rows) {
      for (const k of ['HomePhone', 'CellPhone', 'NewPhone']) {
        const d = t.digits(r[k]);
        if (d) (phoneNames.get(d) ?? phoneNames.set(d, new Set()).get(d)).add((r.LastName || '').toLowerCase());
      }
    }
    const placeholderPhones = new Set([...phoneNames].filter(([, names]) => names.size >= 3).map(([d]) => d));
    const ctx = { ignored, placeholderPhones };

    const adSource = db.prepare('SELECT code FROM advertising_sources WHERE legacy_value = ? OR code = ?');
    const findCustomer = db.prepare('SELECT id FROM customers WHERE legacy_id = ?');
    const insertCustomer = db.prepare(`INSERT INTO customers (legacy_id, kind, first_name, last_name, company_name, phone, alt_phone, advertising_source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    const upsertAddress = db.prepare(`INSERT INTO addresses (legacy_id, customer_id, line1, line2, city, state, postal_code, floor, stair_flights,
        has_elevator, long_walks, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(legacy_id) DO UPDATE SET customer_id = excluded.customer_id, line1 = excluded.line1, line2 = excluded.line2,
        city = excluded.city, state = excluded.state, postal_code = excluded.postal_code, floor = excluded.floor,
        stair_flights = excluded.stair_flights, has_elevator = excluded.has_elevator, long_walks = excluded.long_walks,
        description = excluded.description
      RETURNING id`);
    const jobCols = ['legacy_id', 'job_number', 'customer_id', 'origin_address_id', 'destination_address_id', 'status', 'move_date',
      'arrival_window_start', 'arrival_window_end', 'est_hours', 'crew_size', 'crew_number', 'distance_miles', 'pricing_method',
      'hourly_rate_cents', 'trip_charge_cents', 'discount_cents', 'adjustment_cents', 'quoted_total_cents', 'final_total_cents',
      'tips_cents', 'notes', 'internal_notes', 'created_at'];
    const upsertJob = db.prepare(`INSERT INTO jobs (${jobCols.join(', ')}) VALUES (${jobCols.map(() => '?').join(', ')})
      ON CONFLICT(legacy_id) DO UPDATE SET ${jobCols.filter((c) => c !== 'legacy_id').map((c) => `${c} = excluded.${c}`).join(', ')},
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      RETURNING id`);
    const clearLines = db.prepare('DELETE FROM quote_lines WHERE job_id = ?');
    const insertLine = db.prepare('INSERT INTO quote_lines (job_id, code, description, amount_cents) VALUES (?, ?, ?, ?)');
    const upsertPayment = db.prepare(`INSERT INTO payments (legacy_id, job_id, kind, method, amount_cents, received_at) VALUES (?, ?, 'payment', ?, ?, ?)
      ON CONFLICT(legacy_id) DO UPDATE SET job_id = excluded.job_id, method = excluded.method, amount_cents = excluded.amount_cents, received_at = excluded.received_at`);
    const clearEvents = db.prepare(`DELETE FROM job_events WHERE job_id = ? AND actor = 'legacy import'`);
    const insertEvent = db.prepare(`INSERT INTO job_events (job_id, from_status, to_status, note, actor, created_at) VALUES (?, NULL, 'cancelled', 'Cancelled in legacy system', 'legacy import', ?)`);

    const customers = new Set();
    let scrubbed = 0;
    for (const r of rows) {
      const e = t.estimate(r, ctx);
      if (!e) { report.skipped++; continue; }
      const c = e.customer;
      let customer = findCustomer.get(c.legacy_id);
      if (!customer) {
        const source = c.legacy_referral ? adSource.get(c.legacy_referral, t.advertisingSource(c.legacy_referral)?.code)?.code ?? null : null;
        customer = { id: insertCustomer.run(c.legacy_id, c.kind, c.first_name, c.last_name, c.company_name, c.phone, c.alt_phone, source,
          c.created_at ? `${c.created_at}T00:00:00.000Z` : null).lastInsertRowid };
      }
      customers.add(customer.id);
      const addr = (a) => a && upsertAddress.get(a.legacy_id, customer.id, a.line1, a.line2, a.city, a.state, a.postal_code, a.floor,
        a.stair_flights, a.has_elevator, a.long_walks, a.description).id;
      const job = { ...e.job, customer_id: customer.id, origin_address_id: addr(e.origin) ?? null, destination_address_id: addr(e.destination) ?? null };
      const { id: jobId } = upsertJob.get(...jobCols.map((k) => job[k] ?? (k === 'created_at' ? new Date().toISOString() : null)));
      clearLines.run(jobId);
      for (const l of e.quoteLines) insertLine.run(jobId, l.code, l.description, l.amount_cents);
      if (e.payment) upsertPayment.run(e.payment.legacy_id, jobId, e.payment.method, e.payment.amount_cents, e.payment.received_at);
      clearEvents.run(jobId);
      if (e.cancelledAt) insertEvent.run(jobId, `${e.cancelledAt}T00:00:00.000Z`);
      if (e.sensitiveRemoved) scrubbed++;
      report.imported++;
    }
    report.warnings.push(`${customers.size} customers from ${report.imported} estimates.`);
    if (scrubbed) report.warnings.push(`Removed payment card / SSN details from the notes of ${scrubbed} estimate(s). Purge them from the legacy database too.`);
    inferRateCard(db, rows, report);
    const relevant = ['Referral', 'PaymentMethod', 'Employee'].filter((k) => ignored.has(k));
    if (relevant.length) report.warnings.push(`Ignored ${relevant.join(', ')}: same value on every row, so it is a program default, not data.`);
    if (placeholderPhones.size) report.warnings.push(`Ignored ${placeholderPhones.size} placeholder phone number(s) shared across many customers.`);
  },
};

// With no rate card yet, derive one from the legacy hourly estimates: the most common rate per
// crew size, trip charge and minimum hours. Mileage, stairs and long walks were not charged.
function inferRateCard(db, rows, report) {
  if (db.prepare('SELECT count(*) AS n FROM rate_cards').get().n) return;
  const hourly = rows.filter((r) => /^hourly$/i.test(r.PricingMethod) && t.moneyCents(r.HourlyRate) > 0);
  if (!hourly.length) return;
  const mode = (values) => {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  };
  const bySize = new Map();
  for (const r of hourly) {
    const size = Number(r.NumberOfMen);
    if (size > 0) (bySize.get(size) ?? bySize.set(size, []).get(size)).push(t.moneyCents(r.HourlyRate));
  }
  const crewRates = [...bySize].map(([size, rates]) => [size, mode(rates)]).sort((a, b) => a[0] - b[0]);
  const [baseSize, baseRate] = crewRates[0];
  const perMover = Math.round(baseRate / baseSize);
  const dates = rows.map((r) => t.usDate(r.EstimateDate)).filter(Boolean).sort();
  const cardId = db.prepare(`INSERT INTO rate_cards (name, effective_from, base_crew_size, base_hourly_cents, extra_mover_hourly_cents,
      extra_truck_hourly_cents, minimum_hours, billing_increment_min, travel_fee_cents)
    VALUES (?, ?, ?, ?, ?, 0, ?, 15, ?)`).run('Imported from legacy estimates', dates[0] || '2000-01-01', baseSize, baseRate, perMover,
    mode(hourly.map((r) => Number(r.MinimumHours) || 2)), mode(hourly.map((r) => t.moneyCents(r.TripCharge) || 0))).lastInsertRowid;
  const insert = db.prepare('INSERT INTO rate_card_crew_rates (rate_card_id, crew_size, hourly_cents) VALUES (?, ?, ?)');
  for (const [size, cents] of crewRates) insert.run(cardId, size, cents);
  report.warnings.push(`Created rate card from legacy estimates: ${crewRates.map(([n, c]) => `${n} movers $${c / 100}/h`).join(', ')}. Review before launch.`);
}

// Dependency order: lookups first, then rows that reference them.
const ORDER = ['AdvertisingCodes', 'ArrivalTimes', 'Cities', 'Agents', 'Personnel', 'Adjustments', 'Estimates'];

// Access exports Windows-1252 text; fall back to it when the file is not valid UTF-8.
function readText(file) {
  const buf = fs.readFileSync(file);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function importLegacy(db, dir) {
  const found = {};
  const unknown = [];
  for (const f of fs.readdirSync(dir).filter((f) => /\.csv$/i.test(f)).sort()) {
    const rows = parseCsv(readText(path.join(dir, f)));
    const table = detectTable(rows.columns);
    if (!table) unknown.push(f);
    else (found[table] ??= []).push({ file: f, rows });
  }
  const reports = [];
  for (const table of ORDER) {
    for (const { file, rows } of found[table] || []) {
      const report = { table, file, rows: rows.length, imported: 0, skipped: 0, warnings: [] };
      tx(db, () => importers[table](db, rows, report));
      reports.push(report);
    }
  }
  const skipped = fs.readdirSync(dir).filter((f) => /\.(xlsx?|mdb|accdb)$/i.test(f));
  return { reports, unknown: [...unknown, ...skipped.map((f) => `${f} (save as CSV to import)`)] };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error('Usage: npm run import -- <folder-with-csv-files>');
    process.exit(1);
  }
  const { reports, unknown } = importLegacy(openDb(), dir);
  for (const r of reports) {
    console.log(`${r.table.padEnd(17)} ${String(r.imported).padStart(6)} imported, ${r.skipped} skipped  (${r.file})`);
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }
  if (unknown.length) console.log(`No importer yet for: ${unknown.join(', ')}`);
}

module.exports = { importLegacy };
