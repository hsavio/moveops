// Estimates list: search customers/estimates and open one.
const PRICING = { hourly: 'Hourly', fixed: 'Fixed', itemized: 'Itemized', weight: 'Weight' };
const TYPES = { binding: 'binding', not_to_exceed: 'not to exceed' };

async function search() {
  const params = new URLSearchParams([...new FormData($('#filters'))].filter(([, v]) => v));
  try {
    const rows = await api(`/api/estimates?${params}`);
    $('#results tbody').innerHTML = rows.length ? rows.map((r) => `
      <tr class="clickable" data-id="${r.id}">
        <td><a href="estimate.html?id=${r.id}"><strong>${esc(r.job_number)}</strong></a></td>
        <td>${esc(r.customer_name)}</td>
        <td class="nowrap">${esc(r.customer_phone)}</td>
        <td class="nowrap">${r.move_date ? fmtDate(r.move_date) : '<span class="muted">not set</span>'}</td>
        <td class="route">${esc([r.origin_city, r.destination_city].filter(Boolean).join(' → '))}</td>
        <td>${PRICING[r.pricing_method] ?? esc(r.pricing_method)}${TYPES[r.estimate_type] ? `<div class="muted">${TYPES[r.estimate_type]}</div>` : ''}</td>
        <td class="num">${money(r.final_total_cents ?? r.quoted_total_cents)}</td>
        <td><span class="pill" style="--sc:var(--s-${r.status})">${statusLabel(r.status)}</span></td>
      </tr>`).join('')
      : '<tr><td colspan="8" class="empty">No estimates match. <a href="estimate.html">Start a new estimate</a>.</td></tr>';
    $('#count').textContent = rows.length === 100 ? 'Showing the 100 most recent matches.' : `${rows.length} estimate${rows.length === 1 ? '' : 's'}`;
  } catch (err) {
    toast(err.message);
  }
}

let timer;
$('#filters').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
$('#filters').addEventListener('submit', (e) => { e.preventDefault(); search(); });
$('#results').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row && !e.target.closest('a')) location.href = `estimate.html?id=${row.dataset.id}`;
});
search();
