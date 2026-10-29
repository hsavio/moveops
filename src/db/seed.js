// Seeds a demo dataset with jobs around today's date. Usage: npm run seed
const { openDb, tx } = require('./index');
const { DEFAULT_RATES } = require('./defaults');

function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

function seed(db) {
  tx(db, () => {
    for (const t of ['crew_adjustments', 'payments', 'job_events', 'job_trucks', 'job_crew', 'quote_lines', 'job_items', 'job_services',
      'jobs', 'trucks', 'crew_members', 'addresses', 'customers']) {
      db.exec(`DELETE FROM ${t}`);
    }

    // Reference data is shared with legacy imports, so only add what is missing.
    const src = db.prepare('INSERT OR IGNORE INTO advertising_sources (code, label) VALUES (?, ?)');
    [['referral', 'Referral'], ['internet', 'Internet'], ['yellow_pages', 'Yellow Pages'], ['trailer', 'Trailer']].forEach((r) => src.run(...r));
    if (!db.prepare('SELECT count(*) AS n FROM arrival_windows').get().n) {
      const win = db.prepare('INSERT INTO arrival_windows (label, start_time, end_time, sort_order) VALUES (?, ?, ?, ?)');
      for (let h = 8; h <= 18; h++) win.run(`${((h + 11) % 12) + 1}:00 – ${(h % 12) + 1}:00 ${h + 1 < 12 ? 'am' : 'pm'}`, `${String(h).padStart(2, '0')}:00`, `${String(h + 1).padStart(2, '0')}:00`, h);
    }

    const cardId = db.prepare('SELECT id FROM rate_cards WHERE active = 1 ORDER BY effective_from DESC LIMIT 1').get().id;

    if (!db.prepare('SELECT count(*) AS n FROM items').get().n) {
      const item = db.prepare('INSERT INTO items (code, description, price_cents, cubic_feet) VALUES (?, ?, ?, ?)');
      [['SOFA', 'Sofa', 6000, 35], ['LOVE', 'Loveseat', 4500, 25], ['BEDQ', 'Queen bed', 5500, 60], ['DRSR', 'Dresser', 4000, 30],
       ['TBL', 'Dining table', 3500, 25], ['CHR', 'Dining chair', 800, 5], ['BOXM', 'Box, medium', 500, 3], ['WASH', 'Washer', 5000, 25],
       ['PIAN', 'Upright piano', 25000, 70]].forEach((r) => item.run(...r));
    }

    const truck = db.prepare('INSERT INTO trucks (name, length_ft, capacity_cuft, plate, status) VALUES (?, ?, ?, ?, ?)');
    [['Truck 1', 26, 1700, 'MV-1001', 'available'], ['Truck 2', 26, 1700, 'MV-1002', 'available'],
     ['Truck 3', 20, 1000, 'MV-1003', 'available'], ['Truck 4', 16, 800, 'MV-1004', 'maintenance']]
      .forEach((r) => truck.run(...r));

    const crew = db.prepare('INSERT INTO crew_members (first_name, last_name, role, phone, email, wage_cents) VALUES (?, ?, ?, ?, ?, ?)');
    [['Marcus', 'Bell', 'lead'], ['Dana', 'Ortiz', 'lead'], ['Sam', 'Kowalski', 'driver'], ['Priya', 'Nair', 'driver'],
     ['Leo', 'Grant', 'mover'], ['Tom', 'Reyes', 'mover'], ['Ava', 'Chen', 'mover'], ['Ike', 'Mensah', 'mover'],
     ['Ray', 'Duval', 'mover'], ['Jo', 'Park', 'mover']]
      .forEach(([f, l, role], i) => crew.run(f, l, role, `555-01${String(i).padStart(2, '0')}`,
        i < 8 ? `${f}.${l}@example.com`.toLowerCase() : null, role === 'lead' ? 2600 : 2000));
    db.prepare("UPDATE crew_members SET is_salesperson = 1 WHERE first_name = 'Dana' AND last_name = 'Ortiz'").run();

    const cust = db.prepare('INSERT INTO customers (kind, first_name, last_name, company_name, phone, email, advertising_source) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const addr = db.prepare(`INSERT INTO addresses (customer_id, line1, city, state, postal_code, dwelling_type, floor, stair_flights, has_elevator, long_walks)
      VALUES (?, ?, ?, 'TX', ?, ?, ?, ?, ?, ?)`);
    const job = db.prepare(`INSERT INTO jobs (job_number, customer_id, origin_address_id, destination_address_id, status, move_date,
      arrival_window_start, arrival_window_end, est_hours, crew_size, trucks_needed, distance_miles, rate_card_id, quoted_total_cents, special_items,
      minimum_hours, hourly_rate_cents, trip_charge_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?)`);

    const people = [
      ['residential', 'Hannah', 'Lee', null, 'internet'], ['residential', 'Victor', 'Alvarez', null, 'referral'],
      ['commercial', null, null, 'Brightline Dental', 'referral'], ['residential', 'Grace', 'Okafor', null, 'referral'],
      ['residential', 'Ben', 'Larsen', null, 'yellow_pages'], ['residential', 'Mia', 'Thompson', null, 'internet'],
      ['commercial', null, null, 'Fern & Co Studio', 'internet'], ['residential', 'Owen', 'Fischer', null, 'referral'],
      ['residential', 'Lucy', 'Nguyen', null, 'referral'], ['residential', 'Caleb', 'Ward', null, 'internet'],
      ['residential', 'Zoe', 'Hart', null, 'yellow_pages'], ['residential', 'Noah', 'Price', null, 'internet'],
    ];
    // [dayOffset, status, start, end, hours, crew, trucks, miles, special]
    const plan = [
      [0, 'dispatched', '08:00', '09:00', 5, 3, 1, 12, null], [0, 'in_progress', '08:00', '08:30', 4, 2, 1, 6, null],
      [0, 'booked', '13:00', '14:00', 6, 4, 2, 18, null], [0, 'booked', '12:00', '13:00', 3, 2, 1, 4, 'Upright piano'],
      [1, 'booked', '08:00', '09:00', 7, 4, 1, 22, null], [1, 'booked', '10:00', '11:00', 3, 2, 1, 5, null],
      [2, 'quoted', '08:00', '10:00', 5, 3, 1, 9, null], [2, 'booked', '09:00', '10:00', 4, 3, 1, 14, 'Gun safe'],
      [-1, 'completed', '08:00', '09:00', 5, 3, 1, 11, null], [-1, 'invoiced', '13:00', '14:00', 3, 2, 1, 3, null],
      [4, 'lead', null, null, 4, 2, 1, 8, null], [6, 'quoted', '08:00', '09:00', 8, 4, 2, 25, null],
    ];
    const streets = ['Rayford Rd', 'Louetta Rd', 'Cypresswood Dr', 'Kuykendahl Rd', 'Woodlands Pkwy', 'Sawdust Rd', 'League Line Rd', 'Riley Fuzzel Rd'];

    people.forEach(([kind, f, l, co, ref], i) => {
      const c = cust.run(kind, f, l, co, `555-02${String(i).padStart(2, '0')}`, `${(f || co).toLowerCase().replace(/\W+/g, '')}@example.com`, ref);
      const cid = c.lastInsertRowid;
      const o = addr.run(cid, `${100 + i * 17} ${streets[i % 8]}`, 'Spring', '77380', i % 3 ? 'house' : 'apartment', i % 3 ? 1 : 3, i % 3 ? 0 : 2, 0, i % 4 === 0 ? 1 : 0);
      const d = addr.run(cid, `${400 + i * 23} ${streets[(i + 3) % 8]}`, i % 2 ? 'Conroe' : 'The Woodlands', i % 2 ? '77301' : '77381', 'house', 2, 1, 0, 0);
      const [off, status, s, e, h, crewN, trucksN, miles, special] = plan[i];
      const jn = `J-2026-${String(101 + i).padStart(5, '0')}`;
      const rate = crewN * DEFAULT_RATES.per_mover_hourly_cents;
      job.run(jn, cid, o.lastInsertRowid, d.lastInsertRowid, status, isoDate(off), s, e, h, crewN, trucksN, miles, cardId,
        Math.max(h, 2) * rate + DEFAULT_RATES.travel_fee_cents, special, rate, DEFAULT_RATES.travel_fee_cents);
    });

    // Assign crew + trucks to jobs that are already dispatched or later, and to two booked jobs.
    // slot = crew slot on the schedule board. Future jobs have a slot but no crew/truck yet:
    // those are assigned at the yard on the morning of the move.
    const assignments = {
      'J-2026-00101': { slot: 1, trucks: [1], crew: [1, 3, 5] },
      'J-2026-00102': { slot: 2, trucks: [3], crew: [2, 6] },
      'J-2026-00103': { slot: 1, trucks: [2], crew: [4, 7] }, // under-staffed on purpose: needs 4
      'J-2026-00104': { slot: 3, trucks: [], crew: [] },
      'J-2026-00105': { slot: 1, trucks: [], crew: [] },
      'J-2026-00106': { slot: 2, trucks: [], crew: [] },
      'J-2026-00108': { slot: 1, trucks: [], crew: [] },
      'J-2026-00109': { slot: 1, trucks: [1], crew: [1, 3, 5] },
      'J-2026-00110': { slot: 2, trucks: [3], crew: [2, 6] },
    };
    const jc = db.prepare('INSERT INTO job_crew (job_id, crew_member_id, is_lead) VALUES (?, ?, ?)');
    const jt = db.prepare('INSERT INTO job_trucks (job_id, truck_id) VALUES (?, ?)');
    for (const [jn, a] of Object.entries(assignments)) {
      const { id } = db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(jn);
      a.crew.forEach((m, i) => jc.run(id, m, i === 0 ? 1 : 0));
      a.trucks.forEach((t) => jt.run(id, t));
      db.prepare('UPDATE jobs SET crew_number = ? WHERE id = ?').run(a.slot, id);
    }
  });
}

if (require.main === module) {
  const db = openDb();
  seed(db);
  console.log('Seeded demo data.');
}

module.exports = { seed };
