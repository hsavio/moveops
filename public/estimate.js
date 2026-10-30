// Estimate form: one record holding the customer, both addresses and the price, as in the legacy app.
const WORKFLOW_LABELS = {
  quoted: 'Mark quoted', booked: 'Accept & book', dispatched: 'Dispatch crew', in_progress: 'Move started',
  completed: 'Move complete', invoiced: 'Mark invoiced', lead: 'Reopen as lead', cancelled: 'Cancel move',
};
const WORKFLOW_ORDER = { lead: 0, quoted: 1, booked: 2, dispatched: 3, in_progress: 4, completed: 5, invoiced: 6, cancelled: 7 };
const form = $('#estForm');
const field = (name) => form.elements.namedItem(name);
const state = {
  id: Number(new URLSearchParams(location.search).get('id')) || null,
  est: null, card: null, catalog: [], windows: [], items: [], services: [], dirty: false, customerAddresses: [],
};

// ------------------------------------------------------------------ rates
const rateFor = (movers) => state.card.crew_rates?.[movers] ?? movers * state.card.per_mover_hourly_cents;

function syncRateHint() {
  const movers = Number(field('job.crew_size').value) || 0;
  const standard = rateFor(movers);
  const input = field('job.hourly_rate_cents');
  const custom = toCents(input.value) !== standard;
  $('#rateHint').innerHTML = custom && movers
    ? `Standard for ${movers}: ${money2(standard)} · <a href="#" id="rateReset">use it</a>`
    : `Standard rate for ${movers} movers`;
}

function onCrewChange() {
  const input = field('job.hourly_rate_cents');
  if (input.dataset.auto === '1') input.value = fromCents(rateFor(Number(field('job.crew_size').value) || 0));
  $$('[data-mirror="job.crew_size"]').forEach((m) => { m.value = field('job.crew_size').value; });
  syncRateHint();
}

// ------------------------------------------------------------------ fill / collect
// form.reset() leaves hidden inputs alone, so the record ids are cleared explicitly.
function resetForm() {
  form.reset();
  for (const name of ['customer.id', 'origin.id', 'destination.id']) field(name).value = '';
}

function setFields(prefix, obj) {
  for (const [k, v] of Object.entries(obj || {})) {
    const el = field(`${prefix}.${k}`);
    if (!el) continue;
    if (el instanceof RadioNodeList) { el.value = v ?? ''; continue; }
    el.value = el.classList?.contains('money') ? fromCents(v) : v ?? '';
  }
}

function collect() {
  const body = { customer: {}, origin: {}, destination: {}, job: {} };
  for (const el of form.elements) {
    if (!el.name || !el.name.includes('.') || (el.type === 'radio' && !el.checked)) continue;
    const [group, key] = el.name.split('.');
    let v = el.value.trim();
    if (el.classList.contains('money')) v = toCents(v);
    else if (el.type === 'number') v = v === '' ? null : Number(v);
    body[group][key] = v === '' ? null : v;
  }
  body.customer.id = body.customer.id ? Number(body.customer.id) : undefined;
  body.origin.id = body.origin.id ? Number(body.origin.id) : undefined;
  body.destination.id = body.destination.id ? Number(body.destination.id) : undefined;
  body.items = state.items;
  body.services = state.services.filter((s) => s.description.trim());
  return body;
}

function fill(est) {
  state.est = est;
  state.id = est.job.id;
  resetForm();
  setFields('customer', est.customer);
  setFields('origin', est.origin);
  setFields('destination', est.destination);
  const job = { ...est.job, site_visit_at: est.job.site_visit_at?.slice(0, 16) };
  setFields('job', job);
  state.items = est.items.map(({ item_id, code, description, quantity, unit_cents, cubic_feet }) => ({ item_id, code, description, quantity, unit_cents, cubic_feet }));
  state.services = est.services.map(({ description, quantity, unit_cents }) => ({ description, quantity, unit_cents }));
  field('job.hourly_rate_cents').dataset.auto = est.job.hourly_rate_cents === rateFor(est.job.crew_size) ? '1' : '0';
  $('#estDate').value = fmtDate(est.job.created_at);
  setCustomerLinked(est.customer, true);
  renderHeader();
  renderHistory();
  afterFill();
}

function newEstimateDefaults() {
  resetForm();
  setFields('job', { crew_size: 2, minimum_hours: state.card.minimum_hours, trip_charge_cents: state.card.travel_fee_cents });
  field('job.hourly_rate_cents').value = fromCents(rateFor(2));
  field('job.hourly_rate_cents').dataset.auto = '1';
  $('#estDate').value = fmtDate(localDate());
  afterFill();
}

function afterFill() {
  syncArrivalSelect();
  onCrewChange();
  renderItems();
  renderServices();
  updateMethodUI();
  setDirty(false);
  refreshPrice();
}

// ------------------------------------------------------------------ header, workflow, history
function renderHeader() {
  const est = state.est;
  $('#title').textContent = est ? `Estimate #${est.job.job_number}` : 'New estimate';
  document.title = est ? `Estimate ${est.job.job_number} · MoveOps` : 'New estimate · MoveOps';
  const pill = $('#statusPill');
  pill.hidden = !est;
  if (est) { pill.textContent = statusLabel(est.job.status); pill.style.setProperty('--sc', `var(--s-${est.job.status})`); }
  const order = Object.keys(WORKFLOW_ORDER);
  const backwards = (s) => est && s !== 'cancelled' && order.indexOf(s) < order.indexOf(est.job.status);
  $('#workflow').innerHTML = (est?.allowed_statuses || []).map((s) =>
    `<button type="button" class="${s === 'cancelled' ? 'ghost danger' : backwards(s) ? 'ghost' : ''}" data-status="${s}">${
      backwards(s) ? `Back to ${statusLabel(s)}` : WORKFLOW_LABELS[s] ?? statusLabel(s)}</button>`).join('');
  for (const [btn, doc] of [[$('#printBtn'), 'proposal'], [$('#invoiceBtn'), 'invoice']]) {
    btn.hidden = !est;
    if (est) btn.href = `proposal.html?id=${est.job.id}&doc=${doc}`;
  }
  $('#invoiceBtn').hidden = !est || !['completed', 'invoiced'].includes(est.job.status);
  const doc = emailDocFor(est);
  $('#emailBtn').hidden = !doc;
  if (doc) {
    $('#emailBtn').textContent = `Email ${doc}`;
    $('#emailBtn').dataset.doc = doc;
    $('#emailBtn').disabled = !est.email_configured || !est.customer.email;
    $('#emailBtn').title = !est.email_configured ? 'Email is not set up yet (SMTP settings in .env)' : !est.customer.email ? 'Add the customer\'s email first' : '';
  }
  renderCloseout();
}

// The document that fits the job's stage: proposal before booking, confirmation once booked, invoice after the move.
function emailDocFor(est) {
  if (!est || est.job.status === 'cancelled') return null;
  if (['lead', 'quoted'].includes(est.job.status)) return 'proposal';
  if (['completed', 'invoiced'].includes(est.job.status)) return 'invoice';
  return 'confirmation';
}

// ------------------------------------------------------------------ closeout + payments
function renderCloseout() {
  const est = state.est;
  const afterMove = est && ['dispatched', 'in_progress', 'completed', 'invoiced'].includes(est.job.status);
  $('#closeoutCard').hidden = !afterMove;
  $('#paymentsCard').hidden = !est || ['lead', 'cancelled'].includes(est.job.status) && !est.payments.length;
  if (!est) return;
  const j = est.job;
  $('#coStart').value = j.actual_start_time ?? '';
  $('#coEnd').value = j.actual_end_time ?? '';
  $('#coHours').value = j.actual_hours ?? '';
  $('#coTips').value = j.tips_cents ? fromCents(j.tips_cents) : '';
  $('#coFinal').value = j.final_total_manual ? fromCents(j.final_total_cents) : '';
  const c = est.closeout;
  $('#coCalc').textContent = c
    ? `Calculated: ${money2(c.total_cents)}${c.billable_hours != null ? ` (${c.billable_hours} billable h)` : ''}${c.capped ? `, capped from ${money2(c.uncapped_cents)}` : ''}. Leave blank to use it.`
    : 'Enter the hours to calculate the final bill.';
  $('#closeoutHelp').hidden = Boolean(j.actual_hours) || j.pricing_method !== 'hourly';

  $('#paymentTable tbody').innerHTML = est.payments.map((p) => `<tr>
      <td class="nowrap">${fmtDate(p.received_at)}</td>
      <td>${esc(p.kind)}${p.method ? ` · ${esc(p.method)}` : ''}</td>
      <td>${esc(p.reference ?? '')}</td>
      <td class="num">${money2(p.kind === 'refund' ? -p.amount_cents : p.amount_cents)}</td>
      <td><button type="button" class="icon" data-remove-payment="${p.id}" aria-label="Remove payment">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty small">No payments yet.</td></tr>';
  const owed = j.final_total_cents ?? j.quoted_total_cents ?? 0;
  $('#balance').innerHTML = `<div class="line"><span>${j.final_total_cents != null ? 'Final total' : 'Quoted total'}</span><span>${money2(owed)}</span></div>
    <div class="line"><span>Paid</span><span>${money2(est.paid_cents)}</span></div>
    <div class="line total ${est.balance_cents > 0 ? 'due' : 'paid'}"><span>${est.balance_cents > 0 ? 'Balance due' : 'Paid in full'}</span>
      <span>${money2(Math.max(0, est.balance_cents))}</span></div>`;
  if (!$('#payDate').value) $('#payDate').value = localDate();
}

async function saveCloseout() {
  try {
    const est = await api(`/api/estimates/${state.id}/closeout`, { method: 'PUT', body: {
      actual_start_time: $('#coStart').value, actual_end_time: $('#coEnd').value, actual_hours: $('#coHours').value,
      tips_cents: toCents($('#coTips').value), final_total_cents: toCents($('#coFinal').value),
    } });
    showError('');
    state.est = est;
    renderHeader();
    renderHistory();
    toast(est.job.final_total_cents != null ? `Final total ${money2(est.job.final_total_cents)}` : 'Closeout saved');
  } catch (err) {
    showError(err.message);
  }
}

async function addPayment() {
  try {
    const est = await api(`/api/estimates/${state.id}/payments`, { method: 'POST', body: {
      kind: $('#payKind').value, method: $('#payMethod').value, amount_cents: toCents($('#payAmount').value),
      reference: $('#payRef').value, received_at: $('#payDate').value,
    } });
    $('#payAmount').value = '';
    $('#payRef').value = '';
    showError('');
    state.est = est;
    renderCloseout();
    toast('Payment recorded');
  } catch (err) {
    showError(err.message);
  }
}

async function emailDocument() {
  const doc = $('#emailBtn').dataset.doc;
  if (state.dirty && !(await save())) return;
  if (!confirm(`Email the ${doc} to ${state.est.customer.email}?`)) return;
  try {
    const r = await api(`/api/estimates/${state.id}/email`, { method: 'POST', body: { kind: doc } });
    showError('');
    state.est = r.estimate;
    renderHistory();
    toast(`${doc[0].toUpperCase()}${doc.slice(1)} emailed to ${r.to}`);
  } catch (err) {
    showError(err.message);
  }
}

function renderHistory() {
  const h = state.est?.history || [];
  $('#historyCard').hidden = !h.length;
  $('#history').innerHTML = h.map((e) => `<li><span class="muted">${fmtDate(e.created_at)}</span>
    ${e.note ? esc(e.note) : `${e.from_status ? `${statusLabel(e.from_status)} → ` : ''}${statusLabel(e.to_status)}`}</li>`).join('');
}

async function changeStatus(status) {
  if (status === 'cancelled' && !confirm('Cancel this move?')) return;
  if (state.dirty && !(await save())) return;
  try {
    const r = await api(`/api/jobs/${state.id}/status`, { method: 'PATCH', body: { status } });
    fill(await api(`/api/estimates/${state.id}`));
    const c = r.confirmation;
    toast(c ? (c.sent ? `Booked. Confirmation emailed to ${c.to}` : `Booked. Confirmation not sent: ${c.reason}`) : `Status: ${statusLabel(status)}`);
  } catch (err) {
    showError(err.message);
  }
}

// ------------------------------------------------------------------ customer lookup
function setCustomerLinked(customer, existingEstimate) {
  const linked = Boolean(customer?.id);
  $('#customerFind').hidden = existingEstimate;
  $('#customerLink').innerHTML = linked
    ? `Customer #${customer.id}${existingEstimate ? '' : ' · <a href="#" id="unlinkCustomer">new customer instead</a>'}`
    : '';
  state.customerAddresses = customer?.addresses || state.customerAddresses;
  renderSavedAddresses();
}

let customerTimer;
$('#customerSearch').addEventListener('input', (e) => {
  clearTimeout(customerTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('#customerResults').hidden = true; return; }
  customerTimer = setTimeout(async () => {
    const rows = await api(`/api/customers?q=${encodeURIComponent(q)}`);
    state.customerMatches = rows;
    $('#customerResults').hidden = false;
    $('#customerResults').innerHTML = rows.length ? rows.map((c, i) => `<li role="option" tabindex="0" data-i="${i}">
      <strong>${esc(c.company_name || `${c.first_name ?? ''} ${c.last_name ?? ''}`)}</strong>
      <span class="muted">${esc([c.phone || c.cell_phone, c.addresses[0]?.city, `${c.job_count} job${c.job_count === 1 ? '' : 's'}`].filter(Boolean).join(' · '))}</span></li>`).join('')
      : '<li class="muted">No match: fill in the details below for a new customer.</li>';
  }, 250);
});

$('#customerResults').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const c = state.customerMatches[Number(li.dataset.i)];
  setFields('customer', c);
  state.customerAddresses = c.addresses;
  setCustomerLinked(c, false);
  $('#customerResults').hidden = true;
  $('#customerSearch').value = '';
  setDirty(true);
});

// ------------------------------------------------------------------ saved addresses
function renderSavedAddresses() {
  for (const card of $$('.address')) {
    const list = state.customerAddresses || [];
    $('.saved-list', card).hidden = !list.length;
    $('.saved-select', card).innerHTML = '<option value="">New address</option>' + list.map((a) =>
      `<option value="${a.id}">${esc([a.description, a.line1, a.city].filter(Boolean).join(', '))}</option>`).join('');
    $('.saved-select', card).value = field(`${card.dataset.prefix}.id`).value || '';
  }
}

form.addEventListener('change', (e) => {
  const sel = e.target.closest('.saved-select');
  if (!sel) return;
  const prefix = sel.closest('.address').dataset.prefix;
  const a = state.customerAddresses.find((x) => x.id === Number(sel.value));
  const blankAddr = { id: '', line1: '', line2: '', city: '', state: '', postal_code: '', description: '', stair_flights: 0, long_walks: 0, elevator_floors: 0 };
  setFields(prefix, a || blankAddr);
  setDirty(true);
});

// ------------------------------------------------------------------ arrival time
function syncArrivalSelect() {
  const s = field('job.arrival_window_start').value;
  const e = field('job.arrival_window_end').value;
  const match = state.windows.find((w) => w.start_time === s && (w.end_time ?? '') === e);
  $('#arrivalSelect').value = match ? String(match.id) : s ? 'custom' : '';
  $$('.custom-time').forEach((el) => { el.hidden = $('#arrivalSelect').value !== 'custom'; });
}

$('#arrivalSelect').addEventListener('change', (e) => {
  const w = state.windows.find((x) => String(x.id) === e.target.value);
  if (w) { field('job.arrival_window_start').value = w.start_time; field('job.arrival_window_end').value = w.end_time ?? ''; }
  if (!e.target.value) { field('job.arrival_window_start').value = ''; field('job.arrival_window_end').value = ''; }
  $$('.custom-time').forEach((el) => { el.hidden = e.target.value !== 'custom'; });
});

// ------------------------------------------------------------------ pricing method, items, services
function updateMethodUI() {
  const method = form.querySelector('input[name="job.pricing_method"]:checked').value;
  $$('.method-block').forEach((b) => { b.hidden = b.dataset.method !== method; });
  const type = field('job.estimate_type');
  // Fixed and itemized prices are always binding (guaranteed); hourly is standard or not-to-exceed.
  for (const opt of type.options) opt.disabled = method === 'hourly' ? opt.value === 'binding' : opt.value !== 'binding';
  if (type.selectedOptions[0].disabled) type.value = method === 'hourly' ? 'standard' : 'binding';
  $$('.nte-only').forEach((el) => { el.hidden = type.value !== 'not_to_exceed'; });
}

function renderItems() {
  $('#itemTable tbody').innerHTML = state.items.map((it, i) => `<tr>
      <td>${esc(it.description)}${it.code ? ` <span class="muted small">${esc(it.code)}</span>` : ''}</td>
      <td class="num"><input type="number" min="1" step="1" value="${it.quantity}" data-item="${i}" data-key="quantity" aria-label="Quantity of ${esc(it.description)}"></td>
      <td class="num"><input class="money" value="${fromCents(it.unit_cents)}" data-item="${i}" data-key="unit_cents" aria-label="Price of ${esc(it.description)}"></td>
      <td class="num">${money2(it.quantity * it.unit_cents)}</td>
      <td><button type="button" class="icon" data-remove-item="${i}" aria-label="Remove ${esc(it.description)}">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty small">No items yet.</td></tr>';
  const pieces = state.items.reduce((n, it) => n + Number(it.quantity), 0);
  const cubes = state.items.reduce((n, it) => n + Number(it.quantity) * (Number(it.cubic_feet) || 0), 0);
  $('#itemTotals').textContent = state.items.length ? `${pieces} pieces · about ${Math.round(cubes)} cu ft` : '';
}

function renderServices() {
  $('#serviceTable tbody').innerHTML = state.services.map((s, i) => `<tr>
      <td><input value="${esc(s.description)}" data-service="${i}" data-key="description" aria-label="Service description"></td>
      <td class="num"><input type="number" min="1" step="1" value="${s.quantity}" data-service="${i}" data-key="quantity" aria-label="Quantity"></td>
      <td class="num"><input class="money" value="${fromCents(s.unit_cents)}" data-service="${i}" data-key="unit_cents" aria-label="Price"></td>
      <td><button type="button" class="icon" data-remove-service="${i}" aria-label="Remove service">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty small">None.</td></tr>';
}

$('#itemAdd').addEventListener('click', () => {
  const item = state.catalog.find((c) => String(c.id) === $('#itemPick').value);
  if (!item) return;
  const quantity = Math.max(1, Number($('#itemQty').value) || 1);
  const existing = state.items.find((it) => it.item_id === item.id);
  if (existing) existing.quantity += quantity;
  else state.items.push({ item_id: item.id, code: item.code, description: item.description, quantity, unit_cents: item.price_cents, cubic_feet: item.cubic_feet });
  $('#itemPick').value = '';
  $('#itemQty').value = 1;
  renderItems();
  changed();
});

$('#serviceAdd').addEventListener('click', () => {
  state.services.push({ description: '', quantity: 1, unit_cents: 0 });
  renderServices();
  $(`[data-service="${state.services.length - 1}"][data-key="description"]`).focus();
});

form.addEventListener('click', (e) => {
  const ri = e.target.closest('[data-remove-item]');
  if (ri) { state.items.splice(Number(ri.dataset.removeItem), 1); renderItems(); changed(); }
  const rs = e.target.closest('[data-remove-service]');
  if (rs) { state.services.splice(Number(rs.dataset.removeService), 1); renderServices(); changed(); }
  if (e.target.id === 'rateReset') {
    e.preventDefault();
    field('job.hourly_rate_cents').dataset.auto = '1';
    onCrewChange();
    changed();
  }
  if (e.target.id === 'unlinkCustomer') {
    e.preventDefault();
    setFields('customer', { id: '' });
    setFields('origin', { id: '' });
    setFields('destination', { id: '' });
    state.customerAddresses = [];
    setCustomerLinked(null, false);
    changed();
  }
});

// ------------------------------------------------------------------ distance (free estimate, see README)
$('#distanceBtn').addEventListener('click', async () => {
  const addr = (p) => ['line1', 'city', 'state', 'postal_code'].map((k) => field(`${p}.${k}`).value.trim()).filter(Boolean).join(', ');
  const [from, to] = [addr('origin'), addr('destination')];
  if (!from || !to) { $('#distanceNote').textContent = 'Enter both addresses first.'; return; }
  $('#distanceNote').textContent = 'Estimating…';
  try {
    const d = await api(`/api/distance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    field('job.distance_miles').value = d.miles;
    $('#distanceNote').textContent = d.method === 'route'
      ? `${d.miles} mi driving, about ${d.minutes} min (Google route)`
      : `≈ ${d.miles} mi by road (estimated ${d.method === 'address' ? 'from the addresses' : 'from ZIP codes'})`;
    changed();
  } catch (err) {
    $('#distanceNote').textContent = err.message;
  }
});

// ------------------------------------------------------------------ live price
let priceTimer;
async function refreshPrice() {
  clearTimeout(priceTimer);
  priceTimer = setTimeout(async () => {
    try {
      const body = collect();
      const p = await api('/api/estimates/price', { method: 'POST', body: { job: body.job, items: body.items, services: body.services } });
      const sub = p.lines.length ? `<div class="line sub"><span>Subtotal</span><span>${money2(p.subtotal_cents)}</span></div>` : '';
      const base = p.lines.filter((l) => !/addition|discount/.test(l.code));
      const adj = p.lines.filter((l) => /addition|discount/.test(l.code));
      $('#priceLines').innerHTML = base.map((l) => `<div class="line"><span>${esc(l.description)}</span><span>${money2(l.amount_cents)}</span></div>`).join('')
        + (adj.length ? sub + adj.map((l) => `<div class="line"><span>${esc(l.description)}</span><span>${money2(l.amount_cents)}</span></div>`).join('') : '')
        + `<div class="line total"><span>Estimated total</span><span>${money2(p.total_cents)}</span></div>`
        + (p.cap_cents ? `<p class="muted small">Not to exceed ${money2(p.cap_cents)}: billed on actual hours, never more than this.</p>` : '')
        + (p.billable_hours != null ? `<p class="muted small">${p.billable_hours} billable hours (minimum and 15-minute rounding applied)</p>` : '');
      $('#priceProblem').textContent = p.problem || '';
    } catch (err) {
      $('#priceProblem').textContent = err.message;
    }
  }, 200);
}

// ------------------------------------------------------------------ save
function setDirty(d) {
  state.dirty = d;
  $('#dirtyNote').hidden = !d;
}
function changed() { setDirty(true); refreshPrice(); }

function showError(msg) {
  $('#formError').textContent = msg;
  $('#formError').hidden = !msg;
  if (msg) $('#formError').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function save() {
  showError('');
  const btn = $('#saveBtn');
  btn.disabled = true;
  try {
    const est = await api(state.id ? `/api/estimates/${state.id}` : '/api/estimates', { method: state.id ? 'PUT' : 'POST', body: collect() });
    const created = !state.id;
    fill(est);
    if (created) history.replaceState(null, '', `estimate.html?id=${est.job.id}`);
    toast(created ? `Estimate #${est.job.job_number} created` : 'Saved');
    return true;
  } catch (err) {
    showError(err.message);
    return false;
  } finally {
    btn.disabled = false;
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

form.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'customerSearch' || t.closest('#closeoutCard, #paymentsCard')) return;
  if (t.dataset.item != null) {
    const it = state.items[Number(t.dataset.item)];
    it[t.dataset.key] = t.dataset.key === 'unit_cents' ? toCents(t.value) ?? 0 : Number(t.value) || 1;
  }
  if (t.dataset.service != null) {
    const s = state.services[Number(t.dataset.service)];
    s[t.dataset.key] = t.dataset.key === 'unit_cents' ? toCents(t.value) ?? 0 : t.dataset.key === 'quantity' ? Number(t.value) || 1 : t.value;
  }
  if (t.dataset.mirror) { field(t.dataset.mirror).value = t.value; onCrewChange(); }
  if (t.name === 'job.crew_size') onCrewChange();
  if (t.name === 'job.hourly_rate_cents') { t.dataset.auto = '0'; syncRateHint(); }
  if (t.name === 'job.pricing_method' || t.name === 'job.estimate_type') updateMethodUI();
  changed();
});
form.addEventListener('change', (e) => {
  if (e.target.dataset.item != null) renderItems(); // refresh line totals once editing finishes
  if (e.target.name === 'job.pricing_method' || e.target.name === 'job.estimate_type') { updateMethodUI(); changed(); }
});
$('#emailBtn').addEventListener('click', emailDocument);
// Enter inside the closeout/payment cards runs that card's action instead of saving the estimate.
form.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
  if (e.target.closest('#paymentsCard')) { e.preventDefault(); addPayment(); }
  else if (e.target.closest('#closeoutCard')) { e.preventDefault(); saveCloseout(); }
});
$('#coSave').addEventListener('click', saveCloseout);
$('#payAdd').addEventListener('click', addPayment);
$('#paymentTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remove-payment]');
  if (!b || !confirm('Remove this payment?')) return;
  try {
    state.est = await api(`/api/estimates/${state.id}/payments/${b.dataset.removePayment}`, { method: 'DELETE' });
    renderCloseout();
  } catch (err) {
    showError(err.message);
  }
});
$('#workflow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-status]');
  if (b) changeStatus(b.dataset.status);
});
window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });

// ------------------------------------------------------------------ start
(async () => {
  try {
    const [settings, lookups, catalog, resources] = await Promise.all([
      api('/api/settings'), api('/api/lookups'), api('/api/items'), api('/api/resources'),
    ]);
    state.card = settings.rate_card;
    state.catalog = catalog;
    state.windows = lookups.arrival_windows;
    $('#sourceSelect').innerHTML += lookups.advertising_sources.map((s) => `<option value="${esc(s.code)}">${esc(s.label)}</option>`).join('');
    $('#agentSelect').innerHTML += lookups.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    $('#repSelect').innerHTML += resources.crew.filter((c) => c.is_salesperson).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('#arrivalSelect').innerHTML += state.windows.map((w) => `<option value="${w.id}">${esc(w.label)}</option>`).join('')
      + '<option value="custom">Other time…</option>';
    $('#itemPick').innerHTML += catalog.map((c) => `<option value="${c.id}">${esc(c.code ? `${c.code} · ${c.description}` : c.description)} (${money2(c.price_cents)})</option>`).join('');
    if (state.id) fill(await api(`/api/estimates/${state.id}`));
    else { newEstimateDefaults(); renderHeader(); }
  } catch (err) {
    showError(err.message);
  }
})();
