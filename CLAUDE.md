# MoveOps: project notes for Claude

Rebuild of a legacy VB6/ActiveX + Access short-haul moving app (Spring / Conroe / north Houston, TX).
Node.js + Express, SQLite via built-in `node:sqlite`, vanilla JS front end (no build step). See README.md
for setup, API and import details; this file holds context and decisions.

## Commands
- `npm start` / `npm run dev`: server on :3000 (auto-seeds demo data only into a completely empty DB)
- `npm test`: node:test suite (pricing, API, legacy import, distance). Keep it green.
- `npm run import -- <folder>`: import legacy CSV exports. Use a separate DB for real data: `DB_FILE=data/live.db`.
- Config lives in `.env` (git-ignored); see `.env.example`.

## Layout
- `src/db/schema.sql`: whole schema; no migrations yet (DB is recreated). Add a migration step before launch.
- `src/pricing.js`: pure pricing engine. `src/app.js`: API. `src/maps.js`: distance + Maps link. `src/mailer.js`: SMTP.
- `src/legacy/`: CSV parser, pure row transforms (`transform.js`), importer (`import.js`).
- `public/`: dashboard (KPIs, crew-slot schedule, dispatch grid, pricing calculator, assign + directions dialogs).

## Conventions
- Money is integer cents; dates `YYYY-MM-DD`; times `HH:MM` 24h. Enums enforced with CHECK constraints.
- Legacy rows keep their key in `legacy_id`; every importer upserts on it, so re-importing is safe.
- Transforms stay pure and unit-tested; DB access stays in the importer.

## Decisions made with the owner
- **No paid/per-lookup services.** Distance = free US Census geocoder → straight-line × ROAD_DISTANCE_FACTOR (1.2),
  falling back to ZIP centres. Google Maps API code was removed on purpose; do not reintroduce it.
- Crew emails contain a plain Google Maps **web link** (free, no API). Routes for crew are optional.
- Trucks and crew are assigned **at the yard on the morning of the job**: the schedule is laid out by crew slot
  (legacy CrewNumber), not truck; missing crew/truck is only flagged from the move date on.
- Owner will supply fresh CSV (or SQL) exports at launch; the importer must keep working on new exports.

## Legacy data facts (from the 2017 export)
- No customer table in the old app: the **Estimates** table holds customer, addresses, rates, outcome.
  The owner's file is named `Customers.csv`; the importer detects tables by header, not filename.
- Pricing, verified on all 335 hourly estimates: `estimate = MinimumHours × HourlyRate + TripCharge`.
  Rate by crew size: 2 → $99, 3 → $145, 4 → $198, 6 → $297. Trip charge usually $45, raised by hand
  for long moves. 2 h minimum, 15-min billing. Mileage/stairs/long walks recorded but **not charged**.
- Legacy quirks: ZIPs exported as floats ("210.0"), lat/long in radians, accounting negatives "($100.00)",
  Access times as "1/1/1900 14:00", arrival ranges without am/pm (1–6 = pm).
- Constant columns (Referral = "cards", PaymentMethod, Employee) are program defaults; ignored.
- Adjustments = crew payroll (tips, damage installments, advances), keyed by PersonnelID.

## Security rules (hard requirements)
- Legacy notes contained full card numbers + CVV; Personnel.xls contains SSNs. Never store, print or log either.
  The importer drops note lines with Luhn-valid card numbers or SSN patterns and never reads SSN/bank columns.
- When profiling legacy files, show only column names, counts and value shapes; redact free text by default.
- `internal_notes` never leave the office (excluded from crew emails; covered by a test).

## Requirements from the owner's legacy screenshots (Oct 2026)
- Business: All The Right Moves, 110 FM 1488 Rd, Conroe TX 77384, (281) 785-9900, DOT# 006038868C.
  Put company details in settings, not hard-coded. Estimate numbers are ~11,5xx in the live system.
- **Current rates differ from 2017**: Oct 2026 invoice shows 3 movers $200/h, trip charge $150, plus a
  "rollout charge" line. Owner to confirm full rate list; the 2017 rate card is stale.
- Pricing methods: **hourly**, **fixed**, **itemized** (prices from the legacy Items table, not yet exported).
  Proposal has "Not To Exceed" / "Binding" estimate types (meaning to confirm with owner).
- Workflow: Lead → Site visit/"visual" (optional) → Quote → Accepted (date + arrival time, auto-emails a
  confirmation) → Crew dispatched → Moved → Collected → Call-back (if needed) → Crew paid.
- Proposal (customer-facing, print/email): company header, estimate/invoice no., move date, arrival time,
  origin/dest with stairs/walks/elevator, phones (home/work/cell/new/fax), notes, estimate type, items/services,
  hourly block (start/end/total time × rate + rollout + trip = total, "includes N movers", initials line),
  3 "Other Services" lines (legacy AdministrativeDescription1-3), terms: 3% credit card fee, C.O.D.,
  cancel within 72 h or $100 fee. Legacy invoice prints field values onto pre-printed stock (owner to confirm).
- Personnel: ID, name, address, phones, driver's licence, SSN, status, start/end date, available as mover,
  hourly pay rate **or split %**, salesperson flag, system access (username/password/privileges).
  Owner says SSN is needed for tax filings: decision pending (A: payroll provider holds SSNs, app exports pay
  summary [recommended]; B: encrypted, admin-only, masked, audited). Until decided, do not store SSNs.
- Reports: Activities (estimates/scheduled/cancelled/moved in a date range, with totals); Unpaid Moves
  (collections: closed total − payments, days since move, phones); Booking Commission (owed to realtors/agents).
- "At a Glance" (callbacks, visuals, moves) should become a calendar.

## Open items / next steps
1. Customers and Jobs screens (create/edit jobs, save quotes as quote_lines). Waiting on the owner's
   Estimates form screenshot (did not arrive) and Moves Schedule screenshot.
2. Waiting on owner: full Cities/Zip export (current one stops at 10,000 rows, no TX ZIPs); Personnel with
   PersonnelID (to link Adjustments; 18 placeholders exist); Items, Inventory, Letters tables (itemized pricing).
3. Owner to review the imported rate card. Census geocoder untested live (blocked in the build sandbox).
4. Before launch: migrations, auth/users, backups, deployment.
