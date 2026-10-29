-- MoveOps schema
-- Conventions:
--   * Money is stored as INTEGER cents (never floats).
--   * Timestamps are ISO-8601 TEXT in UTC; move dates are local 'YYYY-MM-DD'.
--   * Enumerations are enforced with CHECK constraints so they port cleanly to Postgres enums/checks.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- reference data
-- Lookup tables carried over from the legacy system. `legacy_value` keeps the original
-- spelling so old records can be mapped during migration.
CREATE TABLE IF NOT EXISTS advertising_sources (
  code          TEXT PRIMARY KEY,               -- 'yellow_pages'
  label         TEXT NOT NULL,                  -- 'Yellow Pages'
  legacy_value  TEXT UNIQUE,                    -- 'Yellow Pages', 'Refferal', ...
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

-- Arrival windows offered when booking. end_time NULL means an exact arrival time.
CREATE TABLE IF NOT EXISTS arrival_windows (
  id            INTEGER PRIMARY KEY,
  label         TEXT NOT NULL,                  -- '8:00 – 9:00 am'
  start_time    TEXT NOT NULL,                  -- 'HH:MM', 24h
  end_time      TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  legacy_value  TEXT UNIQUE,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

-- ZIP code directory for address autofill and distance pricing. Coordinates in degrees
-- (the legacy Cities table stored radians).
CREATE TABLE IF NOT EXISTS zip_codes (
  zip         TEXT PRIMARY KEY,                 -- always 5 characters, zero-padded
  city        TEXT NOT NULL,
  state       TEXT NOT NULL,
  latitude    REAL NOT NULL,
  longitude   REAL NOT NULL,
  population  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_zip_codes_city ON zip_codes(state, city);

-- Referring agents (realtors, relocation companies, partner movers).
CREATE TABLE IF NOT EXISTS agents (
  id              INTEGER PRIMARY KEY,
  business_name   TEXT,
  first_name      TEXT,
  last_name       TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  postal_code     TEXT,
  business_phone  TEXT,
  alternate_phone TEXT,
  fax             TEXT,
  legacy_id       TEXT UNIQUE,
  CHECK (coalesce(business_name, last_name) IS NOT NULL)
);

-- ---------------------------------------------------------------- customers
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'residential' CHECK (kind IN ('residential','commercial')),
  first_name    TEXT,
  last_name     TEXT,
  company_name  TEXT,
  phone         TEXT,                  -- home / main number
  cell_phone    TEXT,
  work_phone    TEXT,
  work_ext      TEXT,
  new_phone     TEXT,                  -- number at the new address
  fax           TEXT,
  email         TEXT,
  advertising_source TEXT REFERENCES advertising_sources(code),  -- how they heard about us
  notes         TEXT,
  legacy_id     TEXT UNIQUE,           -- key from the VB6 database, for migration/reconciliation
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (coalesce(last_name, first_name, company_name) IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- Addresses belong to a customer so they can be reused on repeat moves.
-- Access details live here because they drive pricing (stairs, carries, elevators).
CREATE TABLE IF NOT EXISTS addresses (
  id               INTEGER PRIMARY KEY,
  customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  line1            TEXT NOT NULL,
  line2            TEXT,
  city             TEXT NOT NULL,
  state            TEXT NOT NULL,
  postal_code      TEXT NOT NULL,
  dwelling_type    TEXT CHECK (dwelling_type IN ('house','apartment','condo','storage','office','other')),
  floor            INTEGER NOT NULL DEFAULT 1,
  stair_flights    INTEGER NOT NULL DEFAULT 0 CHECK (stair_flights >= 0),
  has_elevator     INTEGER NOT NULL DEFAULT 0 CHECK (has_elevator IN (0,1)),
  long_walks       INTEGER NOT NULL DEFAULT 0 CHECK (long_walks >= 0),  -- legacy unit: long truck-to-door walks
  description      TEXT,                     -- 'ONE BEDROOM', 'UNLOAD 3 PODS', 'Storage 5x10'
  parking_notes    TEXT,
  legacy_id        TEXT UNIQUE,              -- e.g. '6805:origin' for addresses taken from a legacy estimate
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_addresses_customer ON addresses(customer_id);

-- ---------------------------------------------------------------- resources
CREATE TABLE IF NOT EXISTS crew_members (
  id            INTEGER PRIMARY KEY,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'mover' CHECK (role IN ('mover','driver','lead')),
  phone         TEXT,
  email         TEXT,                          -- where job directions are sent
  is_salesperson INTEGER NOT NULL DEFAULT 0 CHECK (is_salesperson IN (0,1)),
  wage_cents    INTEGER NOT NULL DEFAULT 0,   -- hourly, for job costing
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  legacy_id     TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS trucks (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,          -- 'Truck 3'
  length_ft     INTEGER NOT NULL,              -- 16, 20, 26
  capacity_cuft INTEGER NOT NULL,
  plate         TEXT,
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','maintenance','retired')),
  legacy_id     TEXT UNIQUE
);

-- ---------------------------------------------------------------- pricing
-- Rate cards are versioned by effective date; a job snapshots the card it was quoted on,
-- so changing rates never silently rewrites old quotes.
CREATE TABLE IF NOT EXISTS rate_cards (
  id                        INTEGER PRIMARY KEY,
  name                      TEXT NOT NULL,
  effective_from            TEXT NOT NULL,            -- 'YYYY-MM-DD'
  per_mover_hourly_cents    INTEGER NOT NULL,         -- crew rate = movers x this (unless overridden below)
  extra_truck_hourly_cents  INTEGER NOT NULL DEFAULT 0,
  minimum_hours             REAL    NOT NULL DEFAULT 2,
  billing_increment_min     INTEGER NOT NULL DEFAULT 15,
  travel_fee_cents          INTEGER NOT NULL DEFAULT 0,   -- flat "trip charge"
  mileage_cents_per_mile    INTEGER NOT NULL DEFAULT 0,   -- origin -> destination
  free_miles                INTEGER NOT NULL DEFAULT 0,
  stair_flight_fee_cents    INTEGER NOT NULL DEFAULT 0,   -- per flight, per address
  long_walk_fee_cents       INTEGER NOT NULL DEFAULT 0,   -- per long walk, per address
  weekend_multiplier        REAL    NOT NULL DEFAULT 1.0,
  peak_season_multiplier    REAL    NOT NULL DEFAULT 1.0,
  peak_season_months        TEXT    NOT NULL DEFAULT '5,6,7,8',  -- CSV of month numbers
  tax_rate                  REAL    NOT NULL DEFAULT 0,
  active                    INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

-- Optional hourly rate for a specific crew size, overriding movers x per-mover rate.
-- (The 2017 legacy rates were not linear: 2 men $99, 3 men $145, 4 men $198.)
CREATE TABLE IF NOT EXISTS rate_card_crew_rates (
  rate_card_id  INTEGER NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
  crew_size     INTEGER NOT NULL CHECK (crew_size > 0),
  hourly_cents  INTEGER NOT NULL,
  PRIMARY KEY (rate_card_id, crew_size)
);

-- ---------------------------------------------------------------- jobs
CREATE TABLE IF NOT EXISTS jobs (
  id                      INTEGER PRIMARY KEY,
  job_number              TEXT NOT NULL UNIQUE,      -- 'J-2026-00042'
  customer_id             INTEGER NOT NULL REFERENCES customers(id),
  origin_address_id       INTEGER REFERENCES addresses(id),
  destination_address_id  INTEGER REFERENCES addresses(id),
  status                  TEXT NOT NULL DEFAULT 'lead' CHECK (status IN
                            ('lead','quoted','booked','dispatched','in_progress','completed','invoiced','cancelled')),
  move_date               TEXT,                      -- 'YYYY-MM-DD'
  arrival_window_start    TEXT,                      -- 'HH:MM'
  arrival_window_end      TEXT,
  est_hours               REAL,
  crew_size               INTEGER NOT NULL DEFAULT 2,
  trucks_needed           INTEGER NOT NULL DEFAULT 1,
  crew_number             INTEGER,                   -- legacy schedule-board crew slot (CrewNumber)
  distance_miles          REAL,
  rate_card_id            INTEGER REFERENCES rate_cards(id),
  agent_id                INTEGER REFERENCES agents(id),
  sales_rep_id            INTEGER REFERENCES crew_members(id),
  callback_date           TEXT,                      -- follow-up call due ('YYYY-MM-DD')
  site_visit_at           TEXT,                      -- in-home estimate / "visual" ('YYYY-MM-DDTHH:MM')
  po_number               TEXT,
  -- Agreed terms. Stored on the job because dispatchers override the rate card per job.
  -- weight is legacy-only (one 2017 estimate); new estimates use hourly, fixed or itemized.
  pricing_method          TEXT NOT NULL DEFAULT 'hourly' CHECK (pricing_method IN ('hourly','fixed','itemized','weight')),
  -- standard: hourly, billed on actual time. binding: guaranteed price (fixed or itemized).
  -- not_to_exceed: hourly, billed on actual time but capped at not_to_exceed_cents.
  estimate_type           TEXT NOT NULL DEFAULT 'standard' CHECK (estimate_type IN ('standard','binding','not_to_exceed')),
  not_to_exceed_cents     INTEGER,
  minimum_hours           REAL,
  hourly_rate_cents       INTEGER,
  trip_charge_cents       INTEGER,
  fixed_price_cents       INTEGER,
  move_addition_percent   REAL NOT NULL DEFAULT 0,
  move_addition_cents     INTEGER NOT NULL DEFAULT 0,
  sales_addition_percent  REAL NOT NULL DEFAULT 0,
  sales_addition_cents    INTEGER NOT NULL DEFAULT 0,
  discount_percent        REAL NOT NULL DEFAULT 0,
  discount_cents          INTEGER NOT NULL DEFAULT 0,
  quoted_total_cents      INTEGER,
  -- Closeout (after the move)
  actual_start_time       TEXT,                      -- 'HH:MM'
  actual_end_time         TEXT,
  actual_hours            REAL,
  final_total_cents       INTEGER,
  final_total_manual      INTEGER NOT NULL DEFAULT 0 CHECK (final_total_manual IN (0,1)),  -- 1 = typed in, not calculated
  tips_cents              INTEGER NOT NULL DEFAULT 0,
  special_items           TEXT,                      -- piano, safe, gun cabinet...
  notes                   TEXT,                      -- shown to crew / customer
  internal_notes          TEXT,                      -- office only. Never store card numbers here.
  legacy_id               TEXT UNIQUE,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_date     ON jobs(move_date);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);

-- Itemized pricing: items on a job, copied from the catalog so later price changes don't alter quotes.
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  code          TEXT UNIQUE,
  description   TEXT NOT NULL,
  price_cents   INTEGER NOT NULL DEFAULT 0,
  cubic_feet    REAL,
  weight_lbs    REAL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  legacy_id     TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS job_items (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_id       INTEGER REFERENCES items(id),
  code          TEXT,
  description   TEXT NOT NULL,
  quantity      REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_cents    INTEGER NOT NULL DEFAULT 0,
  cubic_feet    REAL,
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items(job_id);

-- "Other Services" on the proposal (packing materials, piano handling, ...), any pricing method.
CREATE TABLE IF NOT EXISTS job_services (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  quantity      REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_cents    INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_job_services_job ON job_services(job_id);

-- Company details and proposal wording, edited on the Settings page.
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- Quote line items: an itemised snapshot of the last saved price calculation.
CREATE TABLE IF NOT EXISTS quote_lines (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_version INTEGER NOT NULL DEFAULT 1,
  code          TEXT NOT NULL,          -- 'labor', 'travel', 'mileage', 'stairs', ...
  description   TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_quote_lines_job ON quote_lines(job_id, quote_version);

-- Dispatch: who and what is on each job.
CREATE TABLE IF NOT EXISTS job_crew (
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
  is_lead        INTEGER NOT NULL DEFAULT 0 CHECK (is_lead IN (0,1)),
  PRIMARY KEY (job_id, crew_member_id)
);
CREATE INDEX IF NOT EXISTS idx_job_crew_member ON job_crew(crew_member_id);

CREATE TABLE IF NOT EXISTS job_trucks (
  job_id   INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  truck_id INTEGER NOT NULL REFERENCES trucks(id),
  PRIMARY KEY (job_id, truck_id)
);
CREATE INDEX IF NOT EXISTS idx_job_trucks_truck ON job_trucks(truck_id);

-- Audit trail of status changes (who moved a job to 'dispatched', and when).
CREATE TABLE IF NOT EXISTS job_events (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  actor       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);

CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id),
  kind         TEXT NOT NULL CHECK (kind IN ('deposit','payment','refund')),
  method       TEXT CHECK (method IN ('card','cash','check','ach','other')),
  amount_cents INTEGER NOT NULL,
  reference    TEXT,
  legacy_id    TEXT UNIQUE,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_job ON payments(job_id);

-- Payroll adjustments per crew member: tips, damage deductions (often in installments),
-- pay advances and loan repayments, fuel/expense deductions, extra pay.
-- Positive amounts are added to the paycheck, negative amounts deducted.
CREATE TABLE IF NOT EXISTS crew_adjustments (
  id              INTEGER PRIMARY KEY,
  crew_member_id  INTEGER NOT NULL REFERENCES crew_members(id),
  job_id          INTEGER REFERENCES jobs(id),
  adjustment_date TEXT NOT NULL,                -- 'YYYY-MM-DD'
  category        TEXT NOT NULL DEFAULT 'other' CHECK (category IN
                    ('tip','extra_pay','damage','advance','expense','cash_paid','other')),
  description     TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  legacy_id       TEXT UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_crew_adjustments_member ON crew_adjustments(crew_member_id, adjustment_date);

-- Cached address coordinates from the free US Census geocoder, keyed by the normalised address.
-- latitude NULL records a failed match, retried after a day.
CREATE TABLE IF NOT EXISTS geocode_cache (
  address_key      TEXT PRIMARY KEY,
  latitude         REAL,
  longitude        REAL,
  matched_address  TEXT,
  fetched_at       TEXT NOT NULL
);

-- Notes for a calendar day ("Daily Information" on the legacy Moves Schedule).
CREATE TABLE IF NOT EXISTS day_notes (
  date        TEXT PRIMARY KEY,               -- 'YYYY-MM-DD'
  notes       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
