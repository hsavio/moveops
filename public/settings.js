// Settings: rates, company details for proposals, and the item catalog.
let card = null;

function renderCrewTable() {
  const perMover = toCents($('#rateForm').per_mover_hourly_cents.value) || 0;
  $('#crewTable tbody').innerHTML = Array.from({ length: 8 }, (_, i) => i + 1).map((n) => `<tr>
    <td>${n}</td>
    <td class="num">${money2(n * perMover)}</td>
    <td class="num"><input class="money" data-crew="${n}" value="${fromCents(card.crew_rates?.[n])}" aria-label="Override for ${n} movers"></td>
  </tr>`).join('');
}

function fillRates() {
  const f = $('#rateForm');
  f.per_mover_hourly_cents.value = fromCents(card.per_mover_hourly_cents);
  f.travel_fee_cents.value = fromCents(card.travel_fee_cents);
  f.minimum_hours.value = card.minimum_hours;
  f.billing_increment_min.value = String(card.billing_increment_min);
  $('#rateMeta').textContent = `In effect since ${fmtDate(card.effective_from)}. Saving keeps existing estimates at the rates they were quoted at.`;
  renderCrewTable();
}

$('#rateForm').per_mover_hourly_cents.addEventListener('input', () => {
  // keep typed overrides while the standard column updates
  card.crew_rates = Object.fromEntries($$('[data-crew]').map((i) => [i.dataset.crew, toCents(i.value)]).filter(([, v]) => v != null));
  renderCrewTable();
});

$('#rateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#rateError').textContent = '';
  try {
    card = await api('/api/rate-card', { method: 'PUT', body: {
      per_mover_hourly_cents: toCents(f.per_mover_hourly_cents.value),
      travel_fee_cents: toCents(f.travel_fee_cents.value),
      minimum_hours: Number(f.minimum_hours.value),
      billing_increment_min: Number(f.billing_increment_min.value),
      crew_rates: Object.fromEntries($$('[data-crew]').map((i) => [i.dataset.crew, toCents(i.value)])),
    } });
    fillRates();
    toast('Rates saved');
  } catch (err) {
    $('#rateError').textContent = err.message;
  }
});

$('#companyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings = Object.fromEntries(new FormData(e.target));
  try {
    await api('/api/settings', { method: 'PUT', body: { settings } });
    toast('Company details saved');
  } catch (err) {
    toast(err.message);
  }
});

// ------------------------------------------------------------------ item catalog
async function loadItems() {
  const items = await api(`/api/items${$('#showInactive').checked ? '?all=1' : ''}`);
  $('#itemsTable tbody').innerHTML = items.map((it) => `<tr data-id="${it.id}" class="${it.active ? '' : 'inactive'}">
    <td><input name="code" value="${esc(it.code ?? '')}" aria-label="Code"></td>
    <td><input name="description" value="${esc(it.description)}" aria-label="Description"></td>
    <td class="num"><input class="money" name="price_cents" value="${fromCents(it.price_cents)}" aria-label="Price"></td>
    <td class="num"><input type="number" min="0" name="cubic_feet" value="${it.cubic_feet ?? ''}" aria-label="Cubic feet"></td>
    <td><input type="checkbox" name="active" ${it.active ? 'checked' : ''} aria-label="Active"></td>
    <td><button type="button" class="save-item">Save</button></td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">No items yet.</td></tr>';
}

const itemFrom = (row) => ({
  code: $('[name=code]', row).value,
  description: $('[name=description]', row).value,
  price_cents: toCents($('[name=price_cents]', row).value) ?? 0,
  cubic_feet: $('[name=cubic_feet]', row).value,
  active: $('[name=active]', row)?.checked ?? true,
});

$('#itemsTable').addEventListener('click', async (e) => {
  const row = e.target.closest('tr');
  try {
    if (e.target.classList.contains('save-item')) {
      await api(`/api/items/${row.dataset.id}`, { method: 'PUT', body: itemFrom(row) });
      toast('Item saved');
      loadItems();
    } else if (e.target.id === 'addItem') {
      await api('/api/items', { method: 'POST', body: itemFrom(row) });
      $$('input', row).forEach((i) => { i.value = ''; });
      toast('Item added');
      loadItems();
    }
  } catch (err) {
    toast(err.message);
  }
});
$('#showInactive').addEventListener('change', loadItems);

// ------------------------------------------------------------------ agents
const AGENT_INPUTS = ['business_name', 'first_name', 'last_name', 'business_phone', 'email', 'commission_percent'];
async function loadAgents() {
  const agents = await api(`/api/agents${$('#showInactiveAgents').checked ? '?all=1' : ''}`);
  $('#agentsTable tbody').innerHTML = agents.map((a) => `<tr data-id="${a.id}" class="${a.active ? '' : 'inactive'}">
    ${AGENT_INPUTS.map((k) => `<td class="${k === 'commission_percent' ? 'num' : ''}"><input name="${k}" value="${esc(a[k] ?? '')}"
      ${k === 'commission_percent' ? 'type="number" min="0" max="100" step="0.5"' : ''} aria-label="${k.replace(/_/g, ' ')}"></td>`).join('')}
    <td><input type="checkbox" name="active" ${a.active ? 'checked' : ''} aria-label="Active"></td>
    <td><button type="button" class="save-agent">Save</button></td>
  </tr>`).join('') || '<tr><td colspan="8" class="empty">No agents yet.</td></tr>';
}
const agentFrom = (row) => ({
  ...Object.fromEntries(AGENT_INPUTS.map((k) => [k, $(`[name=${k}]`, row).value])),
  commission_percent: Number($('[name=commission_percent]', row).value) || 0,
  active: $('[name=active]', row)?.checked ?? true,
});
$('#agentsTable').addEventListener('click', async (e) => {
  const row = e.target.closest('tr');
  try {
    if (e.target.classList.contains('save-agent')) {
      await api(`/api/agents/${row.dataset.id}`, { method: 'PUT', body: agentFrom(row) });
      toast('Agent saved');
      loadAgents();
    } else if (e.target.id === 'addAgent') {
      await api('/api/agents', { method: 'POST', body: agentFrom(row) });
      $$('input', row).forEach((i) => { i.value = ''; });
      toast('Agent added');
      loadAgents();
    }
  } catch (err) {
    toast(err.message);
  }
});
$('#showInactiveAgents').addEventListener('change', loadAgents);

// ------------------------------------------------------------------ logo
function showLogo(logo) {
  $('#logoPreview').innerHTML = logo
    ? `<img src="/api/settings/logo?v=${encodeURIComponent(logo.updated_at)}" alt="Company logo">`
    : '<span class="muted small">No logo yet</span>';
  $('#logoRemove').hidden = !logo;
}
$('#logoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('That file is too large (2 MB at most)'); return; }
  const res = await fetch('/api/settings/logo', { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => ({}));
  e.target.value = '';
  if (!res.ok) { toast(data.error || 'Upload failed'); return; }
  showLogo(data.logo);
  toast('Logo uploaded');
});
$('#logoRemove').addEventListener('click', async () => {
  if (!confirm('Remove the logo?')) return;
  showLogo((await api('/api/settings/logo', { method: 'DELETE' })).logo);
});

(async () => {
  const s = await api('/api/settings');
  showLogo(s.logo);
  card = s.rate_card;
  fillRates();
  for (const [k, v] of Object.entries(s.settings)) if ($('#companyForm').elements.namedItem(k)) $('#companyForm').elements.namedItem(k).value = v ?? '';
  loadItems();
  loadAgents();
})();
