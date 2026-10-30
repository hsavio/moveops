// Printable proposal / invoice on plain paper (?id=<job id>&doc=proposal|invoice).
const params = new URLSearchParams(location.search);
const id = Number(params.get('id'));
const docType = params.get('doc') === 'invoice' ? 'invoice' : 'proposal';

const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
const arrival = (j) => (j.arrival_window_start
  ? (j.arrival_window_end ? `${fmt12(j.arrival_window_start)} – ${fmt12(j.arrival_window_end)}` : fmt12(j.arrival_window_start))
  : 'To be scheduled');

function addressBlock(label, a) {
  if (!a) return `<div class="addr"><h3>${label}</h3><p class="muted">Not entered</p></div>`;
  const elevator = a.elevator_floors ? `Elevator (floor ${a.elevator_floors})` : 'No elevator';
  return `<div class="addr">
    <h3>${label}</h3>
    ${a.description ? `<p class="muted">${esc(a.description)}</p>` : ''}
    <p>${esc(a.line1)}${a.line2 ? `, ${esc(a.line2)}` : ''}<br>${esc(a.city)}${a.city ? ', ' : ''}${esc(a.state)} ${esc(a.postal_code)}</p>
    <p class="cond">Stairs: ${a.stair_flights} · Long walks: ${a.long_walks} · ${elevator}</p>
  </div>`;
}

function render(est, settings, logo) {
  const { job, customer: c, price } = est;
  const name = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
  const phones = [['Home', c.phone], ['Cell', c.cell_phone], ['Work', c.work_phone && `${c.work_phone}${c.work_ext ? ` x${c.work_ext}` : ''}`],
    ['New', c.new_phone], ['Fax', c.fax]].filter(([, v]) => v);
  const isInvoice = docType === 'invoice';
  const box = (on) => `<span class="box">${on ? '✓' : ''}</span>`;
  const paid = est.paid_cents;
  const hourly = job.pricing_method === 'hourly';
  // The invoice bills the closeout (actual hours) when there is one; the proposal shows the estimate.
  const billed = isInvoice ? est.closeout || price : price;
  const total = isInvoice ? job.final_total_cents ?? billed.total_cents : price.total_cents;
  const lines = isInvoice && job.final_total_manual ? [{ description: 'Moving services', amount_cents: total }] : billed.lines;

  document.title = `${isInvoice ? 'Invoice' : 'Proposal'} ${job.job_number}${name ? ` · ${name}` : ''}`;
  $('#doc').innerHTML = `
    <header class="doc-head">
      <div class="company">
        ${logo ? `<img class="logo" src="/api/settings/logo?v=${encodeURIComponent(logo.updated_at)}" alt="${esc(settings.company_name)}">` : ''}
        <strong>${esc(settings.company_name || 'Your company name')}</strong><br>
        ${[settings.company_address, settings.company_city_state_zip, settings.company_phone && `Phone ${settings.company_phone}`,
          settings.company_email, settings.dot_number && `DOT# ${settings.dot_number}`].filter(Boolean).map(esc).join('<br>')}
      </div>
      <dl class="meta">
        <dt>${isInvoice ? 'Invoice' : 'Estimate'} number</dt><dd>${esc(job.job_number)}</dd>
        ${isInvoice ? `<dt>Invoice date</dt><dd>${fmtDate(localDate())}</dd>` : `<dt>Estimate date</dt><dd>${fmtDate(job.created_at)}</dd>`}
        <dt>Move date</dt><dd>${job.move_date ? fmtDate(job.move_date) : 'To be scheduled'}</dd>
        <dt>Arrival time</dt><dd>${arrival(job)}</dd>
      </dl>
    </header>

    <h1>${isInvoice ? 'Invoice' : 'Proposal for Moving Services'}</h1>

    <section class="parties">
      <div class="addr">
        <h3>Customer</h3>
        <p><strong>${esc(name)}</strong>${c.company_name && c.last_name ? `<br>Attn: ${esc([c.first_name, c.last_name].filter(Boolean).join(' '))}` : ''}</p>
        <p>${[...phones.map(([k, v]) => `${k}: ${esc(v)}`), c.email && esc(c.email)].filter(Boolean).join('<br>')}</p>
      </div>
      ${addressBlock('Origin', est.origin)}
      ${addressBlock('Destination', est.destination)}
    </section>
    ${est.stops?.length ? `<section class="parties stops">
      ${est.stops.map((s, i) => addressBlock(`Stop ${i + 1}: ${s.kind === 'dropoff' ? 'drop-off' : 'pickup'}`, s)).join('')}
    </section>
    <p class="small">Movers will go from the origin to the stops above in order, then to the destination.</p>`
    : '<p class="small">Unless otherwise noted, movers will proceed directly to the destination after loading.</p>'}

    ${isInvoice ? '' : `
    <section class="letter">
      <div class="estimate-type">This type of estimate provided:
        <span>${box(job.estimate_type === 'not_to_exceed')} Not to exceed${job.not_to_exceed_cents ? ` ${money2(job.not_to_exceed_cents)}` : ''}</span>
        <span>${box(job.estimate_type === 'binding')} Binding</span>
      </div>
      <p>Dear ${esc(c.first_name || name)},</p>
      <p><strong>Subject: Move estimate number ${esc(job.job_number)}</strong></p>
      <p>${nl2br(settings.proposal_intro)}</p>
      <p class="sign">${esc(settings.signer_name)}<br><span class="muted">${esc(settings.signer_title)}</span></p>
    </section>`}

    <section>
      <h2>Items / Services</h2>
      <table class="lines">
        <tbody>
          ${lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${money2(l.amount_cents)}</td></tr>`).join('')}
        </tbody>
        <tfoot>
          <tr class="total"><td>${isInvoice ? 'Total' : hourly ? `Estimated total (${price.billable_hours} hours)` : 'Total'}</td>
            <td class="num">${money2(total)}</td></tr>
          ${isInvoice ? `<tr><td>Payments received</td><td class="num">${money2(-paid)}</td></tr>
            <tr class="total"><td>Balance due</td><td class="num">${money2(total - paid)}</td></tr>` : ''}
        </tfoot>
      </table>
      ${isInvoice && job.actual_start_time ? `<p>Time on the job: ${fmt12(job.actual_start_time)} – ${fmt12(job.actual_end_time)}
        (${job.actual_hours} h${billed.billable_hours && billed.billable_hours !== job.actual_hours ? `, billed ${billed.billable_hours} h` : ''})</p>` : ''}
      ${isInvoice && billed.capped ? `<p>Capped at the not-to-exceed amount of <strong>${money2(billed.cap_cents)}</strong>.</p>` : ''}
      ${!isInvoice && price.cap_cents ? `<p>Billed on actual time, but will not exceed <strong>${money2(price.cap_cents)}</strong>.</p>` : ''}
    </section>

    ${hourly && !isInvoice ? `
    <section class="hourly">
      <div class="time-grid">
        <span>Start time</span><span class="blank"></span>
        <span>End time</span><span class="blank"></span>
        <span>Total time</span><span class="blank"></span>
        <span>× ${money2(job.hourly_rate_cents)} / hour</span><span class="blank"></span>
        <span>+ Trip charge</span><span class="filled">${money2(job.trip_charge_cents || 0)}</span>
        <span>= Grand total</span><span class="blank"></span>
      </div>
      <p>This includes ${job.crew_size} movers. When charges are based on an hourly rate, the shipper acknowledges that this
        proposal is complete without the number of hours. Initials: <span class="blank short"></span></p>
    </section>` : ''}

    ${job.notes ? `<section><h2>Notes</h2><p>${nl2br(job.notes)}</p></section>` : ''}

    <section class="terms"><p>${nl2br(settings.proposal_terms)}</p></section>

    ${isInvoice ? '' : `
    <section class="accept">
      <span>Accepted by <span class="blank"></span></span>
      <span>Date <span class="blank short"></span></span>
    </section>`}
  `;
  $('#setupWarn').hidden = Boolean(settings.company_name);
}

$('#printBtn').addEventListener('click', () => window.print());
$('#backLink').href = `estimate.html?id=${id}`;
(async () => {
  try {
    const [est, s] = await Promise.all([api(`/api/estimates/${id}`), api('/api/settings')]);
    render(est, s.settings, s.logo);
  } catch (err) {
    $('#doc').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
})();
