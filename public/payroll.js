// Weekly crew pay and year-end 1099 totals.
const lastWeek = () => { const d = new Date(); d.setDate(d.getDate() - 7); return localDate(d); };
const state = { tab: 'week', date: lastWeek(), data: null };
const shiftDate = (iso, days) => { const d = new Date(`${iso}T12:00`); d.setDate(d.getDate() + days); return localDate(d); };

// ------------------------------------------------------------------ weekly
async function loadWeek() {
  try {
    state.data = await api(`/api/payroll?date=${state.date}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  const { week, workers, not_closed, jobs_without_crew } = state.data;
  $('#weekTitle').textContent = `Week of ${fmtDate(week.start)} – ${fmtDate(week.end)}`;
  $('#payday').textContent = `Payday Wednesday ${fmtDate(week.payDate)}`;
  $('#warnings').innerHTML = [
    not_closed.length && `<p class="day-note">⚠ Not closed out yet, so not in anyone's pay: ${not_closed.map((j) =>
      `<a href="estimate.html?id=${j.id}">#${esc(j.job_number)}</a> (${fmtDate(j.move_date)}, ${statusLabel(j.status)})`).join(', ')}</p>`,
    jobs_without_crew.length && `<p class="day-note">⚠ No crew recorded on: ${jobs_without_crew.map((j) =>
      `<a href="estimate.html?id=${j.id}">#${esc(j.job_number)}</a>`).join(', ')}. Assign the crew on the Dashboard so they get paid.</p>`,
  ].filter(Boolean).join('');
  $('#payTable tbody').innerHTML = workers.map((w) => {
    const p = w.payout;
    const show = p ? { job: p.job_pay_cents, tips: p.tips_cents, adj: p.adjustments_cents, total: p.total_cents } : { job: w.job_pay_cents, tips: w.tips_cents, adj: w.adjustments_cents, total: w.total_cents };
    const pay = w.worker.pay_type === 'hourly' ? `${money2(w.worker.wage_cents)}/h` : `${w.worker.split_percent}%`;
    const details = [...w.jobs.map((j) => `<li>#${esc(j.job_number)} ${esc(j.customer_name ?? '')}, ${fmtDate(j.move_date)}: ${esc(j.basis)} = ${money2(j.amount_cents)}${j.tip_share_cents ? ` + tips ${money2(j.tip_share_cents)}` : ''}</li>`),
      ...w.adjustments.map((a) => `<li>${fmtDate(a.date)} ${esc(a.description)}: ${money2(a.amount_cents)}</li>`)].join('');
    return `<tr>
      <td><a href="crew.html"><strong>${esc(w.worker.first_name)} ${esc(w.worker.last_name)}</strong></a>
        <details class="pay-details"><summary class="muted small">Details</summary><ul>${details}</ul></details></td>
      <td>${pay}</td>
      <td class="num">${w.jobs.length}</td>
      <td class="num">${money2(show.job)}</td>
      <td class="num">${money2(show.tips)}</td>
      <td class="num ${show.adj < 0 ? 'neg' : ''}">${money2(show.adj)}</td>
      <td class="num"><strong>${money2(show.total)}</strong></td>
      <td>${p
        ? `<span class="badge received">Paid</span> <span class="small">${esc([p.method, p.reference].filter(Boolean).join(' '))}</span>
           ${w.changed_since_paid ? `<div class="warn-text small">Changed since paid: now ${money2(w.total_cents)}</div>` : ''}
           <button class="link-btn no-print" data-unpay="${p.id}">Undo</button>`
        : `<span class="pay-one no-print"><select data-method="${w.worker.id}" aria-label="Method"><option value="cash">Cash</option><option value="check">Check</option><option value="ach">Bank</option><option value="other">Other</option></select>
           <input data-ref="${w.worker.id}" placeholder="Check #" aria-label="Reference" size="6">
           <button data-pay="${w.worker.id}">Mark paid</button></span><span class="print-only">Unpaid</span>`}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">Nobody to pay for this week (no closed-out moves or adjustments).</td></tr>';
  $('#weekTotal').textContent = money2(state.data.totals.total_cents);
  $('#payAll').disabled = !workers.some((w) => !w.payout);
}

async function pay(ids, method, reference) {
  try {
    state.data = await api('/api/payroll/pay', { method: 'POST', body: { date: state.date, crew_member_ids: ids, method, reference } });
    toast(ids.length > 1 ? `${ids.length} workers marked paid` : 'Marked paid');
    loadWeek();
  } catch (err) {
    toast(err.message);
  }
}

$('#payTable').addEventListener('click', async (e) => {
  const p = e.target.closest('[data-pay]');
  if (p) {
    const id = p.dataset.pay;
    pay([Number(id)], $(`[data-method="${id}"]`).value, $(`[data-ref="${id}"]`).value);
  }
  const u = e.target.closest('[data-unpay]');
  if (u && confirm('Undo this payment record?')) {
    await api(`/api/payroll/pay/${u.dataset.unpay}`, { method: 'DELETE' });
    loadWeek();
  }
});
$('#payAll').addEventListener('click', () => {
  const ids = state.data.workers.filter((w) => !w.payout).map((w) => w.worker.id);
  if (confirm(`Mark ${ids.length} worker${ids.length === 1 ? '' : 's'} as paid by ${$('#bulkMethod').selectedOptions[0].text.toLowerCase()}?`)) pay(ids, $('#bulkMethod').value, '');
});
$('#prevWeek').addEventListener('click', () => { state.date = shiftDate(state.date, -7); loadWeek(); });
$('#nextWeek').addEventListener('click', () => { state.date = shiftDate(state.date, 7); loadWeek(); });
$('#thisWeek').addEventListener('click', () => { state.date = lastWeek(); loadWeek(); });
$('#printBtn').addEventListener('click', () => { $$('.pay-details').forEach((d) => { d.open = true; }); window.print(); });

// ------------------------------------------------------------------ year-end
async function loadYear() {
  const year = Number($('#year').value);
  const thresholdCents = toCents($('#threshold').value);
  const q = `year=${year}${thresholdCents != null ? `&threshold_cents=${thresholdCents}` : ''}`;
  let d;
  try {
    d = await api(`/api/tax1099?${q}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  if (thresholdCents == null) $('#threshold').value = fromCents(d.threshold_cents);
  const needed = d.recipients.filter((r) => r.needs_1099);
  $('#yearTitle').textContent = `${year}: ${needed.length} worker${needed.length === 1 ? '' : 's'} need a 1099-NEC (paid ${money2(d.threshold_cents)} or more)`;
  $('#payerWarn').innerHTML = d.payer_missing.length
    ? `<p class="day-note">⚠ For the payer section, add your ${d.payer_missing.join(', ')} in <a href="settings.html">Settings</a>.</p>` : '';
  $('#yearTable tbody').innerHTML = d.recipients.map((r) => `<tr>
      <td><strong>${esc(r.worker.first_name)} ${esc(r.worker.last_name)}</strong> <span class="muted small">MO-${r.worker.id}</span></td>
      <td>${r.missing.length ? `<span class="warn-text">Missing ${r.missing.join(', ')}</span>` : esc(`${r.worker.address}, ${r.worker.city}, ${r.worker.state} ${r.worker.postal_code}`)}</td>
      <td><span class="badge ${r.w9_status}">${{ missing: 'Missing', requested: 'Requested', received: 'Received' }[r.w9_status]}</span></td>
      <td>${r.in_tax1099 ? '✓' : '<span class="warn-text">No</span>'}</td>
      <td class="num">${r.weeks_paid}</td>
      <td class="num"><strong>${money2(r.total_cents)}</strong></td>
      <td>${r.needs_1099 ? 'Yes' : '<span class="muted">Below threshold</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No pay recorded for this year.</td></tr>';
  $('#exportBtn').href = `/api/tax1099/export?${q}`;
  $('#exportBtn').toggleAttribute('aria-disabled', !needed.length);
}
$('#year').value = new Date().getMonth() < 3 ? new Date().getFullYear() - 1 : new Date().getFullYear();
$('#year').addEventListener('change', () => { $('#threshold').value = ''; loadYear(); });
$('#threshold').addEventListener('change', loadYear);

// ------------------------------------------------------------------ tabs
function showTab(tab) {
  state.tab = tab;
  $('#weekView').hidden = tab !== 'week';
  $('#yearView').hidden = tab !== 'year';
  $$('.week-only').forEach((el) => { el.hidden = tab !== 'week'; });
  $$('.year-only').forEach((el) => { el.hidden = tab !== 'year'; });
  if (tab === 'week') loadWeek(); else loadYear();
}
$$('input[name=tab]').forEach((r) => r.addEventListener('change', () => showTab(r.value)));
showTab(new URLSearchParams(location.search).get('tab') === 'year' ? 'year' : 'week');
