// Customer emails: proposal, booking confirmation and invoice. Pure functions of an estimate (as loaded
// by estimates.js) and the company settings. Office-only notes (internal_notes) are never included.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'to be scheduled');
const fmt12 = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
const arrival = (j) => (!j.arrival_window_start ? 'to be scheduled'
  : j.arrival_window_end ? `between ${fmt12(j.arrival_window_start)} and ${fmt12(j.arrival_window_end)}` : `at ${fmt12(j.arrival_window_start)}`);
const oneLine = (a) => (a ? [[a.line1, a.line2].filter(Boolean).join(' '), a.city, `${a.state} ${a.postal_code}`.trim()].filter((x) => x && x.trim()).join(', ') : 'not entered');

function customerName(c) {
  return c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
}

function companyLines(s) {
  return [s.company_name, s.company_address, s.company_city_state_zip, s.company_phone && `Phone ${s.company_phone}`,
    s.company_email, s.dot_number && `DOT# ${s.dot_number}`].filter(Boolean);
}

// Builds matching text and HTML bodies from a list of blocks.
function compose(blocks) {
  const text = [];
  const html = [];
  for (const b of blocks) {
    if (b.p) { text.push(b.p); html.push(`<p style="margin:0 0 12px">${esc(b.p).replace(/\n/g, '<br>')}</p>`); }
    if (b.h) { text.push(`\n${b.h.toUpperCase()}`); html.push(`<h3 style="margin:18px 0 6px;font-size:15px;color:#1a3a8a">${esc(b.h)}</h3>`); }
    if (b.rows) {
      text.push(b.rows.map(([k, v]) => `${k}: ${v}`).join('\n'));
      html.push(`<table style="border-collapse:collapse;margin:0 0 12px">${b.rows.map(([k, v]) =>
        `<tr><td style="padding:2px 16px 2px 0;color:#555;vertical-align:top">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`).join('')}</table>`);
    }
    if (b.lines) {
      text.push(b.lines.map(([k, v]) => `${k.padEnd(44)} ${v}`).join('\n'));
      html.push(`<table style="border-collapse:collapse;width:100%;max-width:560px;margin:0 0 12px">${b.lines.map(([k, v, strong]) =>
        `<tr style="${strong ? 'font-weight:bold;border-top:2px solid #111' : 'border-bottom:1px solid #ddd'}"><td style="padding:4px 0">${esc(k)}</td>
          <td style="padding:4px 0;text-align:right;white-space:nowrap">${esc(v)}</td></tr>`).join('')}</table>`);
    }
    if (b.small) { text.push(`\n${b.small}`); html.push(`<p style="margin:16px 0 0;font-size:12px;color:#666">${esc(b.small).replace(/\n/g, '<br>')}</p>`); }
  }
  return {
    text: text.join('\n\n').replace(/\n{3,}/g, '\n\n'),
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#111;max-width:620px">${html.join('\n')}</div>`,
  };
}

function moveRows(est) {
  const { job } = est;
  return [
    ['Estimate number', job.job_number],
    ['Move date', fmtDate(job.move_date)],
    ['Arrival', arrival(job)],
    ['From', oneLine(est.origin)],
    ['To', oneLine(est.destination)],
    ...(job.pricing_method === 'hourly' ? [['Crew', `${job.crew_size} movers`]] : []),
  ];
}

function priceBlock(est, price, totalLabel) {
  return [...price.lines.map((l) => [l.description, money(l.amount_cents)]), [totalLabel, money(price.total_cents), true]];
}

function termsNote(est) {
  const { job } = est;
  if (job.estimate_type === 'binding') return 'This is a binding estimate: the price above is guaranteed for the items and services listed.';
  if (job.estimate_type === 'not_to_exceed') return `You will be billed for the actual time, but never more than ${money(job.not_to_exceed_cents)}.`;
  if (job.pricing_method === 'hourly') {
    return `You will be billed for the actual time at ${money(job.hourly_rate_cents)} per hour for ${job.crew_size} movers`
      + `${job.minimum_hours ? ` (${job.minimum_hours} hour minimum)` : ''}, plus the trip charge.`;
  }
  return null;
}

/**
 * @param {'proposal'|'confirmation'|'invoice'} kind
 * @param {object} est       estimate as returned by loadEstimate (job, customer, origin, destination, price, closeout, payments)
 * @param {object} settings  company settings
 * @returns {{subject:string, text:string, html:string}}
 */
function renderEmail(kind, est, settings) {
  const { job, customer } = est;
  const company = settings.company_name || 'Your moving company';
  const greeting = `Dear ${customer.first_name || customerName(customer)},`;
  const signature = [settings.signer_name, settings.signer_title, ...companyLines(settings)].filter(Boolean).join('\n');
  const notes = job.notes ? [{ h: 'Notes' }, { p: job.notes }] : [];
  let subject;
  let blocks;

  if (kind === 'proposal') {
    subject = `Moving proposal #${job.job_number} from ${company}`;
    blocks = [{ p: greeting }, { p: settings.proposal_intro }, { h: 'Your move' }, { rows: moveRows(est) },
      { h: 'Price' }, { lines: priceBlock(est, est.price, job.estimate_type === 'binding' ? 'Total' : 'Estimated total') },
      ...(termsNote(est) ? [{ p: termsNote(est) }] : []), ...notes,
      { p: 'To book, reply to this email or give us a call.' }, { p: signature }, { small: settings.proposal_terms }];
  } else if (kind === 'confirmation') {
    subject = `Your move is booked: ${fmtDate(job.move_date)} (#${job.job_number})`;
    blocks = [{ p: greeting }, { p: `Thank you for choosing ${company}. Your move is booked:` }, { rows: moveRows(est) },
      { h: 'Price' }, { lines: priceBlock(est, est.price, job.estimate_type === 'binding' ? 'Total' : 'Estimated total') },
      ...(termsNote(est) ? [{ p: termsNote(est) }] : []), ...notes,
      { p: 'If anything changes, please let us know as soon as possible.' }, { p: signature }, { small: settings.proposal_terms }];
  } else if (kind === 'invoice') {
    const price = est.closeout || est.price;
    const total = job.final_total_cents ?? price.total_cents;
    const paid = est.paid_cents || 0;
    subject = `Invoice #${job.job_number} from ${company}`;
    const lines = job.final_total_manual
      ? [['Moving services', money(total)], ['Total', money(total), true]]
      : [...price.lines.map((l) => [l.description, money(l.amount_cents)]), ['Total', money(total), true]];
    if (paid) lines.push(['Payments received', money(-paid)], ['Balance due', money(total - paid), true]);
    const timeRows = job.actual_start_time ? [['Time on the job', `${fmt12(job.actual_start_time)} to ${job.actual_end_time ? fmt12(job.actual_end_time) : '?'}`]] : [];
    blocks = [{ p: greeting }, { p: `Thank you for moving with ${company}. Here is your invoice.` },
      { rows: [['Invoice number', job.job_number], ['Move date', fmtDate(job.move_date)], ...timeRows, ['From', oneLine(est.origin)], ['To', oneLine(est.destination)]] },
      { h: 'Charges' }, { lines },
      ...(price.capped ? [{ p: `Capped at the not-to-exceed amount of ${money(job.not_to_exceed_cents)}.` }] : []),
      { p: total - paid > 0 ? `Balance due: ${money(total - paid)}.` : 'Paid in full. Thank you!' }, { p: signature }, { small: settings.proposal_terms }];
  } else {
    throw new Error(`Unknown document ${kind}`);
  }
  return { subject, ...compose(blocks) };
}

module.exports = { renderEmail };
