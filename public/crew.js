// Crew records: contact details, pay setup, W-9 / TAX1099 status and pay adjustments.
const ROLE = { mover: 'Mover', driver: 'Driver', lead: 'Crew lead' };
const W9 = { missing: 'Missing', requested: 'Requested', received: 'Received' };
const CATEGORY = { tip: 'Tip', extra_pay: 'Extra pay', damage: 'Damage', advance: 'Advance', expense: 'Expense', cash_paid: 'Paid in cash', other: 'Other' };
const form = $('#workerForm');
let current = null;

const payLabel = (w) => (w.pay_type === 'hourly' ? `${money2(w.wage_cents)}/h` : `${w.split_percent}%`);

async function loadList() {
  const rows = await api(`/api/personnel${$('#showInactive').checked ? '?all=1' : ''}`);
  $('#crewTable tbody').innerHTML = rows.map((w) => `<tr class="clickable${w.active ? '' : ' inactive'}${current?.id === w.id ? ' selected-row' : ''}" data-id="${w.id}">
      <td><strong>${esc(w.first_name)} ${esc(w.last_name)}</strong>${w.legacy_id && w.first_name === 'Personnel' ? ' <span class="muted small">(legacy)</span>' : ''}</td>
      <td>${ROLE[w.role]}${w.is_salesperson ? ' · sales' : ''}</td>
      <td>${payLabel(w)}</td>
      <td><span class="badge ${w.w9_status}">${W9[w.w9_status]}</span></td>
      <td>${w.in_tax1099 ? '✓' : '<span class="muted">—</span>'}</td>
      <td class="nowrap">${esc(w.phone ?? '')}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No crew yet.</td></tr>';
}

function showPayFields() {
  const hourly = form.pay_type.value === 'hourly';
  $('.pay-split').hidden = hourly;
  $('.pay-hourly').hidden = !hourly;
}

function fillForm(w) {
  form.reset();
  for (const el of form.elements) {
    if (!el.name || !(el.name in w)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(w[el.name]);
    else if (el.type === 'radio') el.checked = el.value === w[el.name];
    else el.value = el.classList.contains('money') ? fromCents(w[el.name]) : w[el.name] ?? '';
  }
  showPayFields();
}

async function open(id) {
  $('#workerError').textContent = '';
  $('#editor').hidden = false;
  if (!id) {
    current = null;
    $('#editorTitle').textContent = 'New worker';
    fillForm({ role: 'mover', pay_type: 'split', available_as_mover: 1, active: 1, w9_status: 'missing' });
    $('#adjCard').hidden = true;
    form.first_name.focus();
    return;
  }
  const d = await api(`/api/personnel/${id}`);
  current = d.worker;
  $('#editorTitle').textContent = `${d.worker.first_name} ${d.worker.last_name}`;
  fillForm(d.worker);
  $('#adjCard').hidden = false;
  $('#adjDate').value = localDate();
  $('#adjTable tbody').innerHTML = d.adjustments.map((a) => `<tr>
      <td class="nowrap">${fmtDate(a.adjustment_date)}</td><td>${CATEGORY[a.category]}</td><td>${esc(a.description)}</td>
      <td class="num ${a.amount_cents < 0 ? 'neg' : ''}">${money2(a.amount_cents)}</td>
      <td><button class="icon" data-del-adj="${a.id}" aria-label="Delete adjustment">✕</button></td></tr>`).join('')
    || '<tr><td class="empty small">No adjustments.</td></tr>';
  $('#paidYear').textContent = `Paid this year: ${money2(d.paid_this_year_cents)}`;
  $('#payoutTable tbody').innerHTML = d.payouts.slice(0, 8).map((p) => `<tr><td>Paid ${fmtDate(p.pay_date)}</td>
      <td class="muted">week of ${fmtDate(p.week_start)}</td><td>${esc([p.method, p.reference].filter(Boolean).join(' '))}</td>
      <td class="num">${money2(p.total_cents)}</td></tr>`).join('') || '<tr><td class="empty small">No pay recorded yet.</td></tr>';
  loadList();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of form.elements) {
    if (!el.name || (el.type === 'radio' && !el.checked)) continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.classList.contains('money') ? toCents(el.value) ?? 0 : el.value;
  }
  try {
    const w = await api(current ? `/api/personnel/${current.id}` : '/api/personnel', { method: current ? 'PUT' : 'POST', body });
    toast('Saved');
    await open(w.id);
  } catch (err) {
    $('#workerError').textContent = err.message;
  }
});

form.addEventListener('change', (e) => {
  if (e.target.name === 'pay_type') showPayFields();
  if (e.target.name === 'w9_status' && e.target.value === 'received' && !form.w9_received_on.value) form.w9_received_on.value = localDate();
});

$('#adjAdd').addEventListener('click', async () => {
  try {
    await api(`/api/personnel/${current.id}/adjustments`, { method: 'POST', body: {
      adjustment_date: $('#adjDate').value, category: $('#adjCategory').value, description: $('#adjDesc').value,
      amount_cents: toCents($('#adjAmount').value),
    } });
    $('#adjDesc').value = '';
    $('#adjAmount').value = '';
    toast('Adjustment added');
    open(current.id);
  } catch (err) {
    toast(err.message);
  }
});

$('#adjTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-adj]');
  if (!b || !confirm('Delete this adjustment?')) return;
  try {
    await api(`/api/adjustments/${b.dataset.delAdj}`, { method: 'DELETE' });
    open(current.id);
  } catch (err) {
    toast(err.message);
  }
});

$('#crewTable').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row) open(Number(row.dataset.id));
});
$('#newWorker').addEventListener('click', () => open(null));
$('#closeEditor').addEventListener('click', () => { $('#editor').hidden = true; $('#adjCard').hidden = true; current = null; loadList(); });
$('#showInactive').addEventListener('change', loadList);
loadList();
