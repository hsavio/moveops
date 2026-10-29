// Crew pay. Pure functions only (no DB), unit-tested.
// Rules from the owner:
//   * Pay week runs Saturday-Friday and is paid the following Wednesday.
//   * Each worker earns their own percent of the job total (drivers more), or an hourly rate.
//   * Tips are not part of the job total; the crew on the job splits them evenly.
//   * Adjustments (advances, damage deductions, extra pay...) dated in the week are added/subtracted.

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The pay week containing `date`: { start (Saturday), end (Friday), payDate (Wednesday after) }. */
function payWeek(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const start = addDays(date, -((day + 1) % 7));
  const end = addDays(start, 6);
  return { start, end, payDate: addDays(end, 5) };
}

/** Split tips evenly across crew members; leftover cents go to the first members (by id) so the shares add up exactly. */
function tipShares(tipsCents, memberIds) {
  const ids = [...memberIds].sort((a, b) => a - b);
  const shares = new Map();
  if (!ids.length || !tipsCents) return shares;
  const base = Math.floor(tipsCents / ids.length);
  const extra = tipsCents - base * ids.length;
  ids.forEach((id, i) => shares.set(id, base + (i < extra ? 1 : 0)));
  return shares;
}

/** What one worker earns for one job (tips excluded). */
function jobPay(worker, job) {
  if (worker.pay_type === 'hourly') {
    const hours = job.actual_hours ?? job.est_hours ?? 0;
    return { basis: `${hours} h × $${(worker.wage_cents / 100).toFixed(2)}`, amount_cents: Math.round(hours * worker.wage_cents) };
  }
  const total = job.final_total_cents ?? job.quoted_total_cents ?? 0;
  return { basis: `${worker.split_percent}% of $${(total / 100).toFixed(2)}`, amount_cents: Math.round((total * worker.split_percent) / 100) };
}

/**
 * One worker's pay for a week.
 * @param worker      crew_members row
 * @param jobs        jobs this worker was on, each with tip_share_cents already worked out
 * @param adjustments crew_adjustments rows dated in the week
 */
function workerWeek(worker, jobs, adjustments) {
  const jobLines = jobs.map((j) => ({ job_id: j.id, job_number: j.job_number, move_date: j.move_date, customer_name: j.customer_name,
    ...jobPay(worker, j), tip_share_cents: j.tip_share_cents || 0 }));
  const adjLines = adjustments.map((a) => ({ id: a.id, date: a.adjustment_date, category: a.category, description: a.description, amount_cents: a.amount_cents }));
  const job_pay_cents = jobLines.reduce((s, l) => s + l.amount_cents, 0);
  const tips_cents = jobLines.reduce((s, l) => s + l.tip_share_cents, 0);
  const adjustments_cents = adjLines.reduce((s, l) => s + l.amount_cents, 0);
  return { jobs: jobLines, adjustments: adjLines, job_pay_cents, tips_cents, adjustments_cents,
    total_cents: job_pay_cents + tips_cents + adjustments_cents };
}

// IRS 1099-NEC filing threshold. $600 through 2025 payments; the 2025 tax law raised it to $2,000 for
// payments made from 2026. The year-end screen lets the office change it; confirm with the accountant.
const necThresholdCents = (year) => (year <= 2025 ? 60000 : 200000);

// Columns of TAX1099.com's "1099 NEC data import template", in order.
const TAX1099_COLUMNS = ['Payer Type', 'Payer TIN Type', 'Payer TIN', 'Payer Business Name or Last Name', 'Payer First Name',
  'Payer Middle Name', 'Payer Suffix', 'Payer Disregarded Entity', 'Payer Address 1', 'Payer Address 2 (Optional)', 'Payer City',
  'Payer State', 'Payer ZIP or Foreign Postal Code', 'Payer Country', 'Payer Phone Number', 'Payer Email Address (Optional)',
  'Payer State ID (Optional)', 'Recipient Attention To (Optional)', 'Recipient Type', 'Recipient TIN Type', 'Recipient TIN',
  'Recipient Business Name or Last Name', 'Recipient First Name', 'Recipient Middle Name', 'Recipient Suffix', 'Recipient Address 1',
  'Recipient Address 2 (Optional)', 'Recipient City', 'Recipient State', 'Recipient ZIP or Foreign Postal Code', 'Recipient Country',
  'Recipient Phone Number (Optional)', 'Recipient Email Address (Optional)', 'Acct No (Optional)', 'Box 1 Nonemployee Compensation',
  'Box 2 Payer Made Direct Sales Totaling $5,000 or More', 'Box 3 Excess golden parachute payments', 'Box 4 Federal Income Tax Withheld',
  'Box 5a State Tax Withheld', 'Box 5b State Tax Withheld', 'Box 6a State', 'Box 6a State No', 'Box 6b State', 'Box 6b State No',
  'Box 7a State Income', 'Box 7b State Income', 'Client PayerID', 'Exclude Direct State Filing', 'Client RecipientID',
  'Tax RecipientID (TRID)', 'Group ID', 'TaxPayer ID (TPID)', 'Second TIN', 'Email Receipt Language', 'Exclude CFSF', 'Receipt ID',
  'Submission ID', 'Record ID'];

/** "Conroe, TX 77384" / "Conroe TX 77384-1234" -> { city, state, zip } */
function splitCityStateZip(s) {
  const m = String(s || '').trim().match(/^(.*?)[,\s]+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  return m ? { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] } : { city: String(s || '').trim(), state: '', zip: '' };
}

/**
 * Rows for TAX1099's import template. Recipient TINs are deliberately left blank: MoveOps never stores
 * SSNs. The worker's MoveOps id goes in Client RecipientID so TAX1099 can match a saved recipient.
 * @param settings   company settings (name, address, phone, email, payer_ein)
 * @param recipients [{ worker, total_cents }]
 */
function tax1099Rows(settings, recipients) {
  const payer = splitCityStateZip(settings.company_city_state_zip);
  return recipients.map(({ worker: w, total_cents }) => {
    const row = Object.fromEntries(TAX1099_COLUMNS.map((c) => [c, '']));
    Object.assign(row, {
      'Payer Type': 'Business',
      'Payer TIN Type': settings.payer_ein ? 'EIN' : '',
      'Payer TIN': settings.payer_ein || '',
      'Payer Business Name or Last Name': settings.company_name || '',
      'Payer Address 1': settings.company_address || '',
      'Payer City': payer.city,
      'Payer State': payer.state,
      'Payer ZIP or Foreign Postal Code': payer.zip,
      'Payer Country': 'US',
      'Payer Phone Number': settings.company_phone || '',
      'Payer Email Address (Optional)': settings.company_email || '',
      'Recipient Type': 'Individual',
      'Recipient TIN Type': 'SSN',
      'Recipient Business Name or Last Name': w.last_name,
      'Recipient First Name': w.first_name,
      'Recipient Address 1': w.address || '',
      'Recipient City': w.city || '',
      'Recipient State': w.state || '',
      'Recipient ZIP or Foreign Postal Code': w.postal_code || '',
      'Recipient Country': 'US',
      'Recipient Phone Number (Optional)': w.phone || '',
      'Recipient Email Address (Optional)': w.email || '',
      'Box 1 Nonemployee Compensation': (total_cents / 100).toFixed(2),
      'Client RecipientID': `MO-${w.id}`,
    });
    return row;
  });
}

module.exports = { payWeek, tipShares, jobPay, workerWeek, necThresholdCents, TAX1099_COLUMNS, splitCityStateZip, tax1099Rows, addDays };
