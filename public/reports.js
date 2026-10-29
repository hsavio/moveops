// Reports: Activities, Unpaid moves (collections) and Booking commission. Printable and exportable.
const state = { report: new URLSearchParams(location.search).get('r') || 'activities', data: null };
const DEFAULT_PRESET = { activities: 'month', unpaid: 'all', commissions: 'month' };
const name = (r) => r.customer_name;
const link = (r) => `<a href="estimate.html?id=${r.id}">${esc(r.job_number)}</a>`;
const phoneList = (r) => [['H', r.phone], ['C', r.cell_phone], ['W', r.work_phone && `${r.work_phone}${r.work_ext ? ` x${r.work_ext}` : ''}`],
  ['N', r.new_phone], ['F', r.fax]].filter(([, v]) => v);

function presetRange(p) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const iso = (d) => localDate(d);
  switch (p) {
    case 'month': return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    case 'last_month': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case 'year': return [`${y}-01-01`, `${y}-12-31`];
    case 'last_year': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case 'all': return ['2000-01-01', iso(now)];
    default: return [$('#from').value, $('#to').value];
  }
}

// Each report renders as [{ title, description, columns: [[label, fn(row) -> html, csv(row)?, class]], rows, foot }]
function tables() {
  const d = state.data;
  if (state.report === 'activities') {
    return d.sections.map((s) => ({
      title: s.title, description: s.description, rows: s.rows,
      columns: [['Est. #', link, (r) => r.job_number], ['Est. date', (r) => fmtDate(r.estimate_date), (r) => r.estimate_date],
        [s.date_label, (r) => fmtDate(r.event_date ?? r.move_date), (r) => r.event_date ?? r.move_date],
        ['Customer', (r) => esc(name(r)), name], ['Est. total', (r) => money2(r.quoted_total_cents), (r) => cents(r.quoted_total_cents), 'num'],
        ['Closed total', (r) => money2(r.final_total_cents), (r) => cents(r.final_total_cents), 'num'],
        ['Status', (r) => `<span class="pill" style="--sc:var(--s-${r.status})">${statusLabel(r.status)}</span>`, (r) => r.status]],
      foot: `${s.totals.count} · estimated ${money2(s.totals.estimated_cents)} · closed ${money2(s.totals.closed_cents)}`,
    }));
  }
  if (state.report === 'unpaid') {
    return [{
      title: 'Unpaid moves', description: 'Completed moves with a balance due. Call these customers to collect.', rows: d.rows,
      columns: [['Est. #', link, (r) => r.job_number], ['Move date', (r) => fmtDate(r.move_date), (r) => r.move_date],
        ['Days', (r) => r.days_since_move, (r) => r.days_since_move, 'num'], ['Customer', (r) => esc(name(r)), name],
        ['Phones', (r) => phoneList(r).map(([k, v]) => `<span class="nowrap"><span class="muted">${k}</span> ${esc(v)}</span>`).join('<br>'),
          (r) => phoneList(r).map(([k, v]) => `${k} ${v}`).join('; ')],
        ['Closed total', (r) => money2(r.final_total_cents ?? r.quoted_total_cents), (r) => cents(r.final_total_cents ?? r.quoted_total_cents), 'num'],
        ['Paid', (r) => money2(r.paid_cents), (r) => cents(r.paid_cents), 'num'],
        ['Balance', (r) => `<strong>${money2(r.balance_cents)}</strong>`, (r) => cents(r.balance_cents), 'num']],
      foot: `${d.totals.count} unpaid move${d.totals.count === 1 ? '' : 's'} · ${money2(d.totals.balance_cents)} outstanding`,
    }];
  }
  return [{
    title: 'Booking commission', description: 'Commission owed to agents and realtors for moves in the period.', rows: d.rows,
    columns: [['Agent', (r) => esc(r.agent_name), (r) => r.agent_name], ['Est. #', link, (r) => r.job_number],
      ['Move date', (r) => fmtDate(r.move_date), (r) => r.move_date], ['Customer', (r) => esc(name(r)), name],
      ['Closed total', (r) => money2(r.final_total_cents ?? r.quoted_total_cents), (r) => cents(r.final_total_cents ?? r.quoted_total_cents), 'num'],
      ['Rate', (r) => `${r.commission_percent}%`, (r) => r.commission_percent, 'num'],
      ['Commission', (r) => money2(r.commission_cents), (r) => cents(r.commission_cents), 'num'],
      ['Paid', (r) => (r.commission_paid_at ? `${fmtDate(r.commission_paid_at)} <button class="link-btn inline-btn" data-unpay="${r.id}">undo</button>`
        : `<button class="small" data-pay="${r.id}">Mark paid</button>`), (r) => r.commission_paid_at ?? '']],
    foot: `${d.totals.count} move${d.totals.count === 1 ? '' : 's'} · commission ${money2(d.totals.commission_cents)} · still owed ${money2(d.totals.owed_cents)}`,
  }];
}
const cents = (c) => (c == null ? '' : (c / 100).toFixed(2));

function render() {
  const [from, to] = [$('#from').value, $('#to').value];
  $('#report').innerHTML = `<p class="muted small print-only">${fmtDate(from)} – ${fmtDate(to)} · printed ${fmtDate(localDate())}</p>`
    + tables().map((t) => `<div class="report-section">
      <h2>${esc(t.title)}</h2><p class="muted small">${esc(t.description)}</p>
      <div class="table-wrap"><table class="grid">
        <thead><tr>${t.columns.map(([label, , , cls]) => `<th class="${cls || ''}">${esc(label)}</th>`).join('')}</tr></thead>
        <tbody>${t.rows.map((r) => `<tr>${t.columns.map(([, fn, , cls]) => `<td class="${cls || ''}">${fn(r) ?? ''}</td>`).join('')}</tr>`).join('')
          || `<tr><td colspan="${t.columns.length}" class="empty">Nothing in this period.</td></tr>`}</tbody>
      </table></div>
      <p class="report-foot">${t.foot}</p></div>`).join('');
}

async function load() {
  const [from, to] = presetRange($('#preset').value);
  $('#from').value = from;
  $('#to').value = to;
  $$('.commission-only').forEach((el) => { el.hidden = state.report !== 'commissions'; });
  const extra = state.report === 'commissions' && $('#unpaidOnly').checked ? '&unpaid=1' : '';
  try {
    state.data = await api(`/api/reports/${state.report}?from=${from}&to=${to}${extra}`);
    render();
    history.replaceState(null, '', `?r=${state.report}`);
  } catch (err) {
    toast(err.message);
  }
}

function downloadCsv() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [];
  for (const t of tables()) {
    if (lines.length) lines.push('');
    lines.push(q(t.title), t.columns.map(([label]) => q(label)).join(','));
    for (const r of t.rows) lines.push(t.columns.map(([, , csv]) => q(csv ? csv(r) : '')).join(','));
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${state.report}-${$('#from').value}-to-${$('#to').value}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

$$('input[name=report]').forEach((r) => {
  r.checked = r.value === state.report;
  r.addEventListener('change', () => {
    state.report = r.value;
    // Collections look back over all time; the other reports default to the current month.
    if ($('#preset').value !== 'custom') $('#preset').value = DEFAULT_PRESET[state.report];
    load();
  });
});
$('#preset').value = DEFAULT_PRESET[state.report] ?? 'month';
$('#preset').addEventListener('change', load);
for (const id of ['from', 'to']) $(`#${id}`).addEventListener('change', () => { $('#preset').value = 'custom'; load(); });
$('#unpaidOnly').addEventListener('change', load);
$('#printBtn').addEventListener('click', () => window.print());
$('#csvBtn').addEventListener('click', downloadCsv);
$('#report').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pay], [data-unpay]');
  if (!b) return;
  await api(`/api/jobs/${b.dataset.pay || b.dataset.unpay}/commission-paid`, { method: 'POST', body: { paid: Boolean(b.dataset.pay) } });
  load();
});
load();
