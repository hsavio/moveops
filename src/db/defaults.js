// Starting values for a new database: the owner's 2026 rates and the proposal wording from the
// legacy quote form. Both are edited on the Settings page afterwards; these only fill gaps.
const DEFAULT_RATES = {
  per_mover_hourly_cents: 7500, // $75/h per mover: 2 movers $150/h, 3 movers $225/h
  travel_fee_cents: 15000,      // trip charge
  minimum_hours: 2,
  billing_increment_min: 15,
};

const DEFAULT_SETTINGS = {
  company_name: '',
  company_address: '',
  company_city_state_zip: '',
  company_phone: '',
  company_email: '',
  dot_number: '',
  signer_name: '',
  signer_title: 'Operating Manager',
  proposal_intro: 'We are furnishing you with the move price based on the items and conditions attached. '
    + 'Changes to the inventory and conditions can be made anytime. Thank you for your interest in our company.',
  proposal_terms: 'Credit card charges are subject to a 3% processing fee.\n'
    + 'THIS PROPOSAL / CONTRACT IS FOR LISTED ITEMS AND SERVICES ONLY. ADDITIONAL ITEMS AND SERVICES MAY RESULT IN ADDITIONAL COST.\n'
    + 'Transportation charges are due prior to unloading at the final destination. This shipment is C.O.D. '
    + 'Personal checks, company checks and credit cards are accepted.\n'
    + 'CANCELLATION POLICY: Scheduled moves must be cancelled within 72 hours to avoid a $100 cancellation fee.',
};

function ensureDefaults(db) {
  const put = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) put.run(k, v);
  if (!db.prepare('SELECT count(*) AS n FROM rate_cards').get().n) {
    db.prepare(`INSERT INTO rate_cards (name, effective_from, per_mover_hourly_cents, travel_fee_cents, minimum_hours, billing_increment_min)
      VALUES ('Standard rates', ?, ?, ?, ?, ?)`)
      .run(new Date().toLocaleDateString('en-CA'), DEFAULT_RATES.per_mover_hourly_cents, DEFAULT_RATES.travel_fee_cents, DEFAULT_RATES.minimum_hours, DEFAULT_RATES.billing_increment_min);
  }
}

module.exports = { DEFAULT_RATES, DEFAULT_SETTINGS, ensureDefaults };
