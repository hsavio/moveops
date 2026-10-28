# MoveOps

Modern rebuild of the legacy VB6 short-haul moving app: scheduling, dispatch, pricing, and customers.

```bash
npm install
npm start          # http://localhost:3000. An empty DB is auto-seeded with demo data
npm run seed       # reset demo data
npm test           # pricing, API and legacy-import tests (node:test)
npm run import -- <folder>   # import legacy CSV exports (safe to re-run)
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; no native modules).

## Configuration

Copy `.env.example` to `.env` (git-ignored) and fill in what you use. Everything is optional; the app
runs without it and tells you what's missing.

| Setting | Used for |
|---|---|
| `GEOCODER` | `census` (default) or `off`. See *Distances* below. |
| `ROAD_DISTANCE_FACTOR` | Straight-line miles are multiplied by this to estimate road miles (default `1.2`). |
| `YARD_ADDRESS` | First stop of the directions sent to crews (yard → pickup → drop-off). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Emailing directions to crew. For Gmail / Google Workspace use `smtp.gmail.com`, port 465 and an app password. |

## Distances

No paid service is used. Each address is located with the **US Census Bureau geocoder** (free, no API key,
no account), cached in `geocode_cache` so every address is looked up only once. Miles are the straight-line
distance between the two points × `ROAD_DISTANCE_FACTOR` (roads run about 20% longer than a straight line).
If the geocoder can't match an address, is unreachable, or `GEOCODER=off`, the ZIP code's centre from
`zip_codes` is used instead, so quoting keeps working offline. The calculator always shows which was used.

This is an estimate, not a driving route. That suits this business: the legacy app recorded mileage but
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
