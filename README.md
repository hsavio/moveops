# MoveOps

Modern rebuild of the legacy VB6 short-haul moving app: scheduling, dispatch, pricing, and customers.

```bash
npm install
npm start          # http://localhost:3000. An empty DB is auto-seeded with demo data
npm run seed       # reset demo data
npm test           # pricing, API and legacy-import tests (node:test)
npm run import -- <folder>   # import legacy CSV exports (safe to re-run)
npm run user -- list         # office accounts; also: reset <username>, create-admin <username>
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; no native modules).

## Screens

| Page | What it's for |
|---|---|
| Dashboard (`/`) | Today's KPIs, crew-slot schedule, dispatch grid, quick price calculator |
| Estimates (`/estimates.html`) | Search by name, company, phone, email or estimate number; start a new estimate |
| Estimate (`/estimate.html?id=`) | Customer, phones, dates and follow-up, origin/destination with conditions, hourly / fixed / itemized pricing, other services, additions and discounts, live total, workflow buttons |
| Proposal / invoice (`/proposal.html?id=&doc=proposal\|invoice`) | Complete plain-paper documents for the office printer |
| Calendar (`/calendar.html`) | Month / week view and a printable schedule for any date range: moves, call-backs, site visits, notes per day |
| Reports (`/reports.html`) | Activities, Unpaid moves (collections), Booking commission; any period, print or download CSV |
| Crew (`/crew.html`) | Workers: contact and mailing address, pay (% of job or hourly), W-9 and TAX1099 status, pay adjustments |
| Payroll (`/payroll.html`) | Weekly pay sheet (Sat–Fri, paid Wednesday), mark paid, print; year-end 1099 totals and TAX1099 import file |
| Settings (`/settings.html`) | Rates (per mover, trip charge, minimum, billing step, crew-size overrides), company details and proposal wording, agents & commission %, items catalog |

## Logins

Only office staff sign in (crew don't). On a brand-new install, the first visit shows **Create the first admin
account**; do this right after installing. Admins add more users in **Settings → Users** with a temporary password
that the person replaces at first sign-in.

| Role | Can use |
|---|---|
| Admin | Everything, including Crew, Payroll and 1099s, rates, company settings, agents, items and user accounts |
| Office | Dashboard, Calendar, Estimates (all steps incl. closeout and payments), Reports, own password |

Passwords are stored as salted scrypt hashes. Sessions last 14 days (renewed while in use) in an HttpOnly,
SameSite=Lax cookie; set `COOKIE_SECURE=1` once the site runs on HTTPS. Five wrong passwords lock that username for
15 minutes from that address. State-changing API calls must be JSON, which blocks cross-site form posts.
Job history records the signed-in person.

Locked out? On the server: `npm run user -- list`, `npm run user -- reset <username>` (prints a temporary
password) or `npm run user -- create-admin <username>`.

## Configuration

Copy `.env.example` to `.env` (git-ignored) and fill in what you use. Everything is optional; the app
runs without it and tells you what's missing.

| Setting | Used for |
|---|---|
| `GOOGLE_MAPS_API_KEY` | Google Routes API key for real driving distances. Empty = free estimate only. See *Distances*. |
| `GOOGLE_ROUTES_MONTHLY_LIMIT` | Most Google Routes requests per calendar month before falling back to the estimate (default `5000`). |
| `GEOCODER` | `census` (default) or `off`. See *Distances* below. |
| `ROAD_DISTANCE_FACTOR` | Straight-line miles are multiplied by this to estimate road miles (default `1.2`). |
| `YARD_ADDRESS` | First stop of the directions sent to crews (yard → pickup → drop-off). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Emailing customers (proposal, booking confirmation, invoice) and crew directions. For Gmail / Google Workspace use `smtp.gmail.com`, port 465 and an app password. |

## Distances

**Driving distance (Google Routes API).** With `GOOGLE_MAPS_API_KEY` set, the calculator asks Google for the
real driving distance and time (Compute Routes Essentials: no live traffic, only distance and duration
requested). Google gives 10,000 of these requests free each month; at about 20 moves a week MoveOps uses a few
hundred. Routes are cached for 90 days in `route_cache`, requests are counted per month in `api_usage`, and
at `GOOGLE_ROUTES_MONTHLY_LIMIT` (default 5,000) MoveOps stops asking Google and uses the free estimate.

Setting up the key (once): in the Google Cloud console create a project, attach a billing account (Google
requires one even for free usage), enable **Routes API**, then create an API key restricted to the Routes API.
As a second safety net, set a daily quota on the Routes API (APIs & Services → Routes API → Quotas, e.g.
300 requests/day) and a budget alert.

**Free estimate (fallback).** If there is no key, the monthly limit is reached or Google fails, each address is located with the **US Census Bureau geocoder** (free, no API key,
no account), cached in `geocode_cache` so every address is looked up only once. Miles are the straight-line
distance between the two points × `ROAD_DISTANCE_FACTOR` (roads run about 20% longer than a straight line).
If the geocoder can't match an address, is unreachable, or `GEOCODER=off`, the ZIP code's centre from
`zip_codes` is used instead, so quoting keeps working offline. The calculator always shows which was used.

The free estimate is not a driving route. That suits this business: the legacy app recorded mileage but
billed a flat trip charge (see *Estimates* below).

## Dispatch workflow

Trucks and crew are assigned at the yard on the morning of the move, so the schedule board is laid out by
**crew slot** (Crew 1, Crew 2, ... like the legacy CrewNumber) and only flags missing crew/trucks from the
move date on. After assigning, **✉ Directions** on a job emails each crew member a Google Maps web link
(yard → pickup → drop-off; a plain URL, no API key or charge) plus the arrival window, customer phone, access details and crew notes.
Office-only `internal_notes` are never included. Email addresses typed in that dialog are saved to the
crew member, and each send is logged on the job.

## Layout

| Path | Purpose |
|---|---|
| `src/db/schema.sql` | Database schema (portable SQL, Postgres-ready) |
| `src/pricing.js` | Pure pricing engine, the replacement for the VB6 calculator |
| `src/app.js` | Express API, status workflow, dispatch conflict checks |
| `src/legacy/` | CSV importer for the VB6/Access database exports |
| `public/` | Dashboard UI (vanilla JS, no build step) |

## Data model

```
customers 1─* addresses
customers 1─* jobs ─┬─ origin/destination → addresses
                    ├─ rate_card → rate_cards (versioned by effective_from)
                    ├─* quote_lines   (itemised quote snapshot, versioned)
                    ├─* job_crew  *─1 crew_members
                    ├─* job_trucks *─1 trucks
                    ├─* job_events    (status audit trail)
                    └─* payments
```

* Money is integer **cents**. Move dates are local `YYYY-MM-DD`, windows are `HH:MM`.
* Job lifecycle: `lead → quoted → booked → dispatched → in_progress → completed → invoiced` (plus `cancelled`).
  Allowed transitions are enforced server-side (`TRANSITIONS` in `src/app.js`).
* Access details (stairs, elevator, long carry) live on `addresses` because they drive pricing.
* `legacy_id` columns hold the old system's keys for migration and reconciliation.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/dashboard?date=` | KPI figures |
| GET | `/api/schedule?date=` | Jobs per truck lane |
| GET | `/api/jobs?from=&to=&status=` | Dispatch grid rows (with crew, trucks, warnings) |
| PATCH | `/api/jobs/:id/status` | `{status}`. Returns 409 on an illegal transition |
| PUT | `/api/jobs/:id/assignments` | `{crew[], trucks[], leadId, crewNumber, force}`. Returns 409 on a double-booking unless forced |
| GET | `/api/resources` | Active crew + trucks |
| GET | `/api/rate-card` | Current rate card |
| POST | `/api/quote/preview` | Run the pricing engine (`originAddress`/`destinationAddress` fill in distance) |
| GET | `/api/lookups` | Advertising sources, arrival windows, agents |
| GET | `/api/zip/:zip` | City/state for a ZIP |
| GET | `/api/distance?from=&to=` | Estimated road miles between two addresses (Census geocoder, ZIP fallback) |
| GET | `/api/jobs/:id/directions` | Route stops, Google Maps link and email preview for the crew |
| POST | `/api/jobs/:id/directions/send` | `{recipients: [{crewId, email}]}`. Emails directions to crew |
| PATCH | `/api/crew/:id` | `{email, phone}` |
| GET | `/api/config` | Which integrations are configured |
| GET/PUT | `/api/settings` | Company details and proposal wording (+ current rate card) |
| PUT | `/api/rate-card` | `{per_mover_hourly_cents, travel_fee_cents, minimum_hours, billing_increment_min, crew_rates}` |
| GET | `/api/auth/status` | `{setup_needed, user}` (public) |
| POST | `/api/auth/setup` | Create the first admin (only while there are no users) |
| POST | `/api/auth/login`, `/api/auth/logout` | `{username, password}` |
| GET/POST | `/api/auth/me`, `/api/auth/password` | Current user; change own password `{current_password, new_password}` |
| GET/POST/PUT | `/api/users`, `/api/users/:id` | Admin: list / add (temporary password) / edit, deactivate, reset |
| GET/PUT/DELETE | `/api/settings/logo` | Company logo (PUT the raw image; PNG, JPEG, GIF or WebP, max 2 MB) |
| GET/POST/PUT | `/api/items`, `/api/items/:id` | Item catalog for itemized pricing (`?all=1` includes hidden items) |
| GET | `/api/customers?q=` | Customer lookup (name, company, email, phone digits) with saved addresses |
| GET | `/api/estimates?q=&status=&from=&to=` | Estimate search |
| GET/POST/PUT | `/api/estimates`, `/api/estimates/:id` | Load / create / update an estimate (customer, origin, destination, job, items, services) |
| POST | `/api/estimates/price` | Live total for unsaved form data |
| GET | `/api/calendar?from=&to=` | Moves, call-backs and site visits in a range (max 120 days) + day notes |
| PUT | `/api/day-notes/:date` | `{notes}`. Empty text deletes the note |
| POST | `/api/jobs/:id/callback-done` | Clear a call-back and log it |
| GET | `/api/reports/activities?from=&to=` | Estimates given, scheduled, cancelled, moved, with totals |
| GET | `/api/reports/unpaid?from=&to=` | Completed moves with a balance due, days since move, phones |
| GET | `/api/reports/commissions?from=&to=&agent_id=&unpaid=1` | Commission per agent per move |
| POST | `/api/jobs/:id/commission-paid` | `{paid, date}` |
| GET/POST/PUT | `/api/agents`, `/api/agents/:id` | Agents / realtors with commission % (`?all=1` includes inactive) |
| GET/POST/PUT | `/api/personnel`, `/api/personnel/:id` | Crew records (SSN/TIN/licence fields are refused) |
| POST | `/api/personnel/:id/adjustments` | `{adjustment_date, category, description, amount_cents}` (negative deducts) |
| DELETE | `/api/adjustments/:id` | Refused once that week is paid |
| GET | `/api/payroll?date=` | Pay sheet for the week containing the date |
| POST/DELETE | `/api/payroll/pay`, `/api/payroll/pay/:id` | `{date, crew_member_ids, method, reference}` mark paid / undo |
| GET | `/api/tax1099?year=&threshold_cents=` | Yearly totals per worker, missing address/W-9 flags |
| GET | `/api/tax1099/export?year=&threshold_cents=` | CSV in TAX1099.com's 1099-NEC import template |
| PUT | `/api/estimates/:id/closeout` | `{actual_start_time, actual_end_time, actual_hours, final_total_cents, tips_cents}` (blank final = calculated) |
| POST/DELETE | `/api/estimates/:id/payments[/:paymentId]` | `{kind, method, amount_cents, reference, received_at}`. Card numbers are refused |
| GET | `/api/estimates/:id/email/:kind` | Preview a customer email (`proposal`, `confirmation`, `invoice`) |
| POST | `/api/estimates/:id/email` | `{kind}`. Send it to the customer's email address |

Moving a job to `booked` (`PATCH /api/jobs/:id/status`) emails the customer a confirmation when email is set up and
the customer has an address; the response's `confirmation` says whether it was sent. Pass `sendConfirmation: false`
to skip it.

## Legacy import

Export each Access table to CSV (save spreadsheets as CSV too), put the files in one folder, then run
`npm run import -- <folder>`. Files are recognised by their **header row**, not their name, so a file
called `Customers.csv` that holds the Estimates table is imported as Estimates. Every row upserts on its
legacy key, so re-running after a fresh export updates records instead of duplicating them.

Use a separate database for real data: `DB_FILE=data/live.db npm run import -- <folder>`, then
`DB_FILE=data/live.db npm start`. The server only seeds demo data into a completely empty database.

| Legacy table | New table | Notes |
|---|---|---|
| AdvertisingCodes | `advertising_sources` | Cleaned labels (`Refferal` → Referral); original spelling kept in `legacy_value` |
| ArrivalTimes | `arrival_windows` | Ranges have no am/pm; hours 1–6 are read as pm |
| Cities | `zip_codes` | ZIPs were floats (`210.0` → `00210`); coordinates converted from radians to degrees |
| Agents | `agents` | Export was empty; jobs can link to an agent via `jobs.agent_id` |
| Adjustments | `crew_adjustments` | Category inferred from the description; unknown `PersonnelID`s get inactive placeholder crew until Personnel is imported |
| Personnel | `crew_members` | Matched by `PersonnelID` when present, otherwise by name. SSN/bank columns are never read |
| Estimates | `customers`, `addresses`, `jobs`, `quote_lines`, `payments`, `job_events` | See below |

### Estimates

The legacy app had no customer table; each Estimates row holds the customer, both addresses, the agreed
rates and the outcome.

* **Customers** are de-duplicated by home phone + last name (339 customers from 366 estimates in the 2017 data).
* **Status**: Estimate → `quoted`, Scheduled → `booked` (or `completed` once money was collected), Cancelled → `cancelled` (with a dated `job_events` row).
* **Pricing** (verified against all 335 hourly estimates): `estimate = MinimumHours × HourlyRate + TripCharge`.
  The rate depends on crew size (2 → $99, 3 → $145, 4 → $198, 6 → $297); the trip charge is usually $45 and
  was raised by hand for long distances. Mileage, stairs and long walks were recorded but not charged.
  Final bills were trip charge + hours × rate in 15-minute increments. If no rate card exists, the importer
  creates one from these values.
* **Itemized / weight** estimates are kept as a single `legacy_total` quote line until the Items/Inventory tables are imported.
* Columns holding the same value on every row (`Referral`, `PaymentMethod`, `Employee`) are program defaults and are ignored.

### Sensitive data

The legacy notes fields contain full payment card numbers with expiry and CVV, and the Personnel
spreadsheet contains SSNs. The importer drops any note line with a Luhn-valid card number or an SSN
pattern, and never reads SSN or bank columns. Neither should ever be stored in this database.

### Before launch

1. Re-export **Cities/Zip** in full: the current export stops at 10,000 rows (ZIP 24595), so none of the Texas ZIPs are present.
2. Export **Personnel** with its `PersonnelID` so payroll adjustments link to real names.
3. Export **Items**, **Inventory** and **Letters** (they reference Estimates).
4. Review the imported rate card.
