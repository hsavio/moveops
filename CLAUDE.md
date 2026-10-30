# MoveOps: project notes for Claude

Rebuild of a legacy VB6/ActiveX + Access short-haul moving app (Spring / Conroe / north Houston, TX).
Node.js + Express, SQLite via built-in `node:sqlite`, vanilla JS front end (no build step). See README.md
for setup, API and import details; this file holds context and decisions.

## Commands
- `npm start` / `npm run dev`: server on :3000 (auto-seeds demo data only into a completely empty DB)
- `npm test`: node:test suite (pricing, API, legacy import, distance). Keep it green.
- `npm run import -- <folder>`: import legacy CSV exports. Use a separate DB for real data: `DB_FILE=data/live.db`.
- `npm run user -- list | reset <username> | create-admin <username>`: account recovery on the server.
- `npm run distance-check -- "<from>" "<to>" [...]` (or `--file pairs.txt`, `from | to` per line): live test of the
  address-to-miles lookup; prints geocoder reachability, miles, street vs ZIP match and a Maps link to compare.
- Config lives in `.env` (git-ignored); see `.env.example`.

## Layout
- `src/db/schema.sql`: whole schema; no migrations yet (DB is recreated). Add a migration step before launch.
- `src/pricing.js`: pure pricing (`priceJob` for saved estimates, `calculateQuote` for the dashboard calculator).
- `src/app.js`: dashboard/dispatch API. `src/estimates.js`: estimates, customers, items, settings, rates API.
  `src/http.js`: shared HttpError/wrap. `src/db/defaults.js`: owner's default rates + proposal wording (ensureDefaults).
- `src/calendar.js`: calendar events (moves, call-backs, site visits) + day notes.
- `src/reports.js`: Activities, Unpaid Moves, Booking Commission reports + agents API.
- `src/payroll.js`: pure pay rules (pay week, split/hourly job pay, tip shares, TAX1099 rows).
  `src/personnel.js`: crew records, adjustments, weekly payroll + payouts, year-end 1099 summary/export.
- `src/auth.js`: password hashing, sessions, lockout, access rules (admin-only paths). `src/users.js`: login/setup/
  password/user-account routes. `src/tools/users.js`: `npm run user` recovery CLI.
- `src/maps.js`: distance (Google Routes → Census estimate → ZIP) + Maps link. `src/mailer.js`: SMTP. `src/documents.js`: customer emails (proposal,
  booking confirmation, invoice) as pure text+HTML renderers.
- `src/legacy/`: CSV parser, pure row transforms (`transform.js`), importer (`import.js`).
- `public/`: `common.js` shared helpers; `index.html` dashboard; `estimates.html` search list; `estimate.html` the
  Estimate form; `proposal.html?id=&doc=proposal|invoice` printable documents (`print.css`); `settings.html`;
  `calendar.html` month / week / printable schedule list with day notes; `reports.html` (print + CSV);
  `crew.html` personnel + adjustments; `payroll.html` weekly pay sheet + year-end 1099s.

## Conventions
- Money is integer cents; dates `YYYY-MM-DD`; times `HH:MM` 24h. Enums enforced with CHECK constraints.
- Legacy rows keep their key in `legacy_id`; every importer upserts on it, so re-importing is safe.
- Transforms stay pure and unit-tested; DB access stays in the importer.

## Decisions made with the owner
- **Distance (owner, Oct 30 2026; replaces the earlier "no Google API" rule):** Google Routes API, Compute Routes
  Essentials only (TRAFFIC_UNAWARE, field mask `routes.distanceMeters,routes.duration`, ≤10 waypoints) so it stays
  in Google's free tier (10,000/month; ~20 moves/week uses a few hundred). Cached 90 days, counted in `api_usage`,
  capped by GOOGLE_ROUTES_MONTHLY_LIMIT (5,000). No key, cap reached or Google error → free estimate: Census
  geocoder → straight-line × ROAD_DISTANCE_FACTOR (1.2) → ZIP centres. Never add Pro/Enterprise fields or traffic.
  Considered and not chosen: Google Maps Java client (app is Node; plain REST does the same), public OSRM demo
  server (not for production use), self-hosted OSRM (a server to run and update).
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
- **Crew pay (owner, Oct 2026):** all movers are 1099 contractors (no employees). Each worker earns their own % of
  the job total (drivers more than movers) or an hourly rate; tips are excluded from the total and split evenly
  across the crew on the job. Pay week Saturday-Friday, paid the following **Wednesday**. Only closed-out moves
  (completed/invoiced) count. "Mark paid" snapshots a crew_payouts row; 1099 Box 1 = sum of payouts by pay date.
- **TAX1099 export** follows the owner's template (1099-NEC import, 58 columns). Recipient TIN is left blank
  (no SSNs in MoveOps); Client RecipientID = `MO-<worker id>`. Payer EIN stored in settings (SSN shape refused).
  Threshold default $600 (≤2025) / $2,000 (2026+), editable on screen; owner to confirm with accountant.
- **Logins:** office staff only (crew don't log in).

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
1. Done: Estimate form, estimate search, printable proposal/invoice, Settings (rates, company, items);
   booking auto-emails a confirmation (booking still succeeds if email can't go out); Email proposal/confirmation/
   invoice buttons; closeout (actual start/end or hours, final total calculated or typed, tips); payments
   (deposit/payment/refund, last-4 + auth only) with balance due; invoice uses actual hours.
   Calendar done: month/week/schedule list for any range, moves (tentative while lead/quoted), call-backs (mark
   done), site visits, day notes (also shown on the dashboard), printable schedule.
   Reports done: Activities (estimates/scheduled/cancelled/moved; "scheduled" = date of the booking event, legacy
   ScheduledDate imported as one), Unpaid Moves (default all time), Booking Commission (agent commission_percent of
   closed-or-quoted total; cancelled moves earn none; mark paid). Agents managed in Settings.
   Personnel + payroll done (Crew and Payroll pages).
   Logo done: uploaded in Settings (PNG/JPEG/GIF/WebP by magic bytes, 2 MB, SVG refused), stored in `files`,
   printed on proposals/invoices and embedded in customer emails as an inline (cid) attachment. Use it on
   letters too once the legacy Letters table arrives.
   Logins done: office staff only; roles admin (everything) / office (no crew, payroll, 1099, rates, settings changes,
   users). First-run setup creates the first admin. Tests that aren't about logins pass `requireAuth: false`
   to createApp; keep new API tests doing the same, and add admin-only paths to `adminOnlyApi` in src/auth.js.
   Next: extra stops; Letters (waiting on the legacy Letters table).
2. Waiting on owner: full Cities/Zip export (current one stops at 10,000 rows, no TX ZIPs; **urgent before launch**:
   with no TX ZIPs the ZIP fallback fails for local addresses, so a Census outage/no-match gives an error, not miles); Personnel with
   PersonnelID (to link Adjustments; 18 placeholders exist); Items, Inventory, Letters tables (itemized pricing).
3. Owner to review the imported rate card. Google Routes **works live** (Oct 30 2026): owner's key in `.env` on their
   PC, `npm run distance-check` returned driving miles (Conroe yard → Austin). The key is IP-restricted to the
   owner's network, so it can't be tested from cloud sessions; the hosting server's IP must be added at launch.
   Keys go only in the git-ignored `.env`, never `.env.example` (an earlier key leaked there and was replaced).
   Owner runs MoveOps locally: VS Code clone of hsavio/moveops, Node.js LTS, `npm install`, `npm start`.
   Census geocoder (fallback) is blocked by the cloud session's network policy; untested live.
   Owner still to send: Items, Letters and full Zip exports.
4. Before launch: migrations, backups, deployment (HTTPS + COOKIE_SECURE=1; add the server's IP to the Google key).
5. Workflow: commit to `main` (owner's choice). Start new cloud sessions with `hsavio/moveops` selected as the
   source so GitHub access works from the start. Keep this "Open items" list current at the end of each session.
