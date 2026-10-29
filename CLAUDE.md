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
- `src/pricing.js`: pure pricing (`priceJob` for saved estimates, `calculateQuote` for the dashboard calculator).
- `src/app.js`: dashboard/dispatch API. `src/estimates.js`: estimates, customers, items, settings, rates API.
  `src/http.js`: shared HttpError/wrap. `src/db/defaults.js`: owner's default rates + proposal wording (ensureDefaults).
- `src/maps.js`: distance + Maps link. `src/mailer.js`: SMTP.
- `src/legacy/`: CSV parser, pure row transforms (`transform.js`), importer (`import.js`).
- `public/`: `common.js` shared helpers; `index.html` dashboard; `estimates.html` search list; `estimate.html` the
  Estimate form; `proposal.html?id=&doc=proposal|invoice` printable documents (`print.css`); `settings.html`.

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

- **Rates (Oct 2026):** default $75/h **per mover** (crew rate = movers × rate) and $150 trip charge; editable in
  Settings, optional per-crew-size overrides. Saving creates a version dated today; estimates keep their own rates.
- **No rollout charge** (owner: nobody uses it). Don't add it back.
- **Binding** = guaranteed price: fixed and itemized estimates are always binding. **Not to exceed** = hourly with a cap.
  Hourly "standard" bills actual hours.
- Both % and flat discounts apply (the legacy app ignored the flat one; owner accepted the fix).
- **Printing:** complete documents on plain paper from the office printer. No pre-printed stock overlays.
- **SSNs:** not stored in MoveOps. Owner files 1099s via TAX1099.com and does payroll in-house; MoveOps should track
  each worker's tax-form status and export yearly pay totals for TAX1099. (Contractors give a W-9; owner said "W-4".)
- **Payments:** never store card number/expiry/CVV (the legacy Payment Information box did). Method, amount,
  last 4 and auth code only. Notes fields reject text that looks like a card number or SSN.
- Estimate numbers: imported legacy estimates keep their number (e.g. 11541); new ones continue from the highest.

## Requirements from the owner's legacy screenshots (Oct 2026)
- Business: All The Right Moves, 110 FM 1488 Rd, Conroe TX 77384, (281) 785-9900, DOT# 006038868C.
  Put company details in settings, not hard-coded. Estimate numbers are ~11,5xx in the live system.
- Pricing methods: **hourly**, **fixed**, **itemized** (catalog in `items`; legacy Items table not yet exported).
- Workflow: Lead → Site visit/"visual" (optional) → Quote → Accepted (date + arrival time, auto-emails a
  confirmation) → Crew dispatched → Moved → Collected → Call-back (if needed) → Crew paid.
- Proposal (customer-facing, print/email): company header, estimate/invoice no., move date, arrival time,
  origin/dest with stairs/walks/elevator, phones (home/work/cell/new/fax), notes, estimate type, items/services,
  hourly block (start/end/total time × rate + rollout + trip = total, "includes N movers", initials line),
  3 "Other Services" lines (legacy AdministrativeDescription1-3), terms: 3% credit card fee, C.O.D.,
  cancel within 72 h or $100 fee.
- Personnel: ID, name, address, phones, driver's licence, SSN, status, start/end date, available as mover,
  hourly pay rate **or split %**, salesperson flag, system access (username/password/privileges). SSN: see decisions.
- Reports: Activities (estimates/scheduled/cancelled/moved in a date range, with totals); Unpaid Moves
  (collections: closed total − payments, days since move, phones); Booking Commission (owed to realtors/agents).
- "At a Glance" (callbacks, visuals, moves) should become a calendar.
- Moves Schedule: show moves for a selectable period (not just one day), with per-day notes ("Daily Information").

## Open items / next steps
1. Done: Estimate form, estimate search, printable proposal/invoice, Settings (rates, company, items).
   Next: confirmation email on booking; closeout (actual hours, final total, payments, tips) feeding the invoice;
   calendar (call-backs, site visits, moves) + period schedule with daily notes; reports (Activities, Unpaid Moves,
   Booking Commission); Personnel (pay rate/split %, logins, W-9 status, TAX1099 export); extra stops.
2. Waiting on owner: full Cities/Zip export (current one stops at 10,000 rows, no TX ZIPs); Personnel with
   PersonnelID (to link Adjustments; 18 placeholders exist); Items, Inventory, Letters tables (itemized pricing).
3. Owner to review the imported rate card. Census geocoder untested live (blocked in the build sandbox).
4. Before launch: migrations, auth/users, backups, deployment.
