// MoveOps dashboard (no framework, no build step).
const DAY_START = 7;   // schedule axis start hour
const DAY_HOURS = 12;  // 07:00–19:00
const STATUSES = ['lead', 'quoted', 'booked', 'dispatched', 'in_progress', 'completed', 'invoiced', 'cancelled'];
const TRANSITIONS = {
  lead: ['quoted', 'cancelled'], quoted: ['booked', 'lead', 'cancelled'], booked: ['dispatched', 'quoted', 'cancelled'],
  dispatched: ['in_progress', 'booked', 'cancelled'], in_progress: ['completed'], completed: ['invoiced'], invoiced: [], cancelled: ['lead'],
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => (cents == null ? '—' : `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const statusLabel = (s) => s.replace('_', ' ');
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA');

const state = { date: localDate(), resources: null, jobsById: new Map() };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ------------------------------------------------------------------ KPIs
function renderKpis(k) {
  const tiles = [
    { label: 'Jobs today', value: k.jobs_today, sub: new Date(`${k.date}T12:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) },
    { label: 'Needs attention', value: k.needs_attention, sub: 'Under-staffed or no truck', alert: k.needs_attention > 0 },
    { label: 'Crew assigned', value: `${k.crew_assigned}/${k.crew_active}`, sub: 'Active crew on jobs today' },
    { label: 'Booked next 7 days', value: money(k.week_booked_cents), sub: `${k.week_booked_jobs} jobs` },
    { label: 'Open pipeline', value: (k.pipeline.lead || 0) + (k.pipeline.quoted || 0), sub: `${k.pipeline.lead || 0} leads · ${k.pipeline.quoted || 0} quoted` },
  ];
  $('#kpis').innerHTML = tiles.map((t) => `
    <div class="kpi${t.alert ? ' alert' : ''}"><div class="label">${t.label}</div><div class="value">${esc(t.value)}</div><div class="sub">${esc(t.sub)}</div></div>`).join('');
}

// ------------------------------------------------------------------ Schedule
function timeToPct(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return Math.min(100, Math.max(0, ((h + m / 60 - DAY_START) / DAY_HOURS) * 100));
}

function jobBlock(j) {
  const start = j.arrival_window_start || '08:00';
  const left = timeToPct(start);
  const width = Math.max(4, Math.min(100 - left, ((j.est_hours || 2) / DAY_HOURS) * 100));
  return `<div class="block${j.warnings.length ? ' warn' : ''}" style="left:${left}%;width:${width}%;--sc:var(--s-${j.status})"
    data-job="${j.id}" title="${esc(`${j.job_number} · ${j.customer_name}\n${j.origin} → ${j.destination}\n${j.warnings.join('\n')}`)}">
    <strong>${esc(j.customer_name)}</strong>${esc(start)} · ${j.est_hours}h · ${j.crew.length}/${j.crew_size} crew · ${esc(j.trucks.map((t) => t.name).join(', ') || 'truck at yard')}</div>`;
}

function renderSchedule(s) {
  const ticks = Array.from({ length: DAY_HOURS + 1 }, (_, i) => {
    const h = DAY_START + i;
    return `<span class="tick" style="left:${(i / DAY_HOURS) * 100}%">${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}</span>`;
  }).join('');
  const lanes = s.lanes.map((l) => `
    <div class="lane">
      <div class="lane-label">${esc(l.name)}<small>${l.jobs.length ? `${l.jobs.length} job${l.jobs.length > 1 ? 's' : ''}` : 'open'}</small></div>
      <div class="lane-track">${l.jobs.map(jobBlock).join('')}</div>
    </div>`).join('');
  const unassigned = s.unassigned.length
    ? `<div class="unassigned"><span class="warn-text">No crew slot yet:</span>${s.unassigned.map((j) =>
        `<button class="assign-btn" data-assign="${j.id}">${esc(j.job_number)} · ${esc(j.customer_name)}</button>`).join('')}</div>`
    : '';
  $('#schedule').innerHTML = `<div class="sched-inner" style="--hours:${DAY_HOURS}">
    <div class="axis"><div></div><div class="ticks">${ticks}</div></div>${lanes}</div>${unassigned}`;
  $('#scheduleLabel').textContent = `${s.lanes.reduce((n, l) => n + l.jobs.length, 0) + s.unassigned.length} jobs · trucks are picked at the yard`;
}

// ------------------------------------------------------------------ Dispatch grid
function renderDispatch(jobs) {
  const filter = $('#statusFilter').value;
  const rows = jobs.filter((j) => !filter || j.status === filter);
  const tbody = $('#dispatch tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No jobs for this day${filter ? ` with status “${statusLabel(filter)}”` : ''}.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((j) => {
    const crew = j.crew.length ? j.crew.map((c) => (c.is_lead ? `★ ${c.name}` : c.name)).join(', ') : 'Assign crew…';
    const trucks = j.trucks.length ? j.trucks.map((t) => t.name).join(', ') : 'Assign truck…';
    const options = [j.status, ...TRANSITIONS[j.status]].map((s) => `<option value="${s}"${s === j.status ? ' selected' : ''}>${statusLabel(s)}</option>`).join('');
    return `<tr>
      <td><strong>${esc(j.job_number)}</strong>${j.special_items ? `<div class="warn-text">⚑ ${esc(j.special_items)}</div>` : ''}</td>
      <td>${j.arrival_window_start ? `${esc(j.arrival_window_start)}–${esc(j.arrival_window_end)}` : '<span class="muted">TBD</span>'}</td>
      <td>${esc(j.customer_name)}<div class="muted">${esc(j.customer_phone)}</div></td>
      <td class="route">${esc(j.origin)}<br>→ ${esc(j.destination)}<br>${j.distance_miles ?? '?'} mi · ${j.est_hours}h est.</td>
      <td><button class="assign-btn" data-assign="${j.id}">${esc(crew)}</button><div class="muted">${j.crew.length}/${j.crew_size} needed</div></td>
      <td><button class="assign-btn" data-assign="${j.id}">${esc(trucks)}</button>${j.warnings.map((w) => `<div class="warn-text">${esc(w)}</div>`).join('')}</td>
      <td class="num">${money(j.quoted_total_cents)}</td>
      <td>${TRANSITIONS[j.status].length
        ? `<select class="status" data-status="${j.id}" style="--sc:var(--s-${j.status})" aria-label="Status for ${esc(j.job_number)}">${options}</select>`
        : `<span class="pill" style="--sc:var(--s-${j.status})">${statusLabel(j.status)}</span>`}
        ${j.crew.length ? `<button class="link-btn" data-directions="${j.id}">✉ Directions</button>` : ''}</td>
    </tr>`;
  }).join('');
}

// ------------------------------------------------------------------ Assignment dialog
function openAssign(jobId) {
  const j = state.jobsById.get(jobId);
  if (!j) return;
  const { crew, trucks } = state.resources;
  const crewIds = new Set(j.crew.map((c) => c.id));
  const lead = j.crew.find((c) => c.is_lead)?.id;
  const truckIds = new Set(j.trucks.map((t) => t.id));
  $('#assignTitle').textContent = `${j.job_number} · ${j.customer_name}`;
  $('#assignSub').textContent = `${j.move_date} · needs ${j.crew_size} crew and ${j.trucks_needed} truck(s). ★ = crew lead`;
  $('#assignCrew').innerHTML = crew.map((c) => `
    <div class="crew-row">
      <input type="radio" name="lead" value="${c.id}"${lead === c.id ? ' checked' : ''} aria-label="Make ${esc(c.name)} crew lead" title="Crew lead">
      <label><input type="checkbox" name="crew" value="${c.id}"${crewIds.has(c.id) ? ' checked' : ''}> ${esc(c.name)}<span class="role">${c.role}</span></label>
    </div>`).join('');
  $('#assignTrucks').innerHTML = trucks.map((t) => `
    <label><input type="checkbox" name="truck" value="${t.id}"${truckIds.has(t.id) ? ' checked' : ''}${t.status !== 'available' ? ' disabled' : ''}>
      ${esc(t.name)}<span class="role">${t.length_ft}'${t.status !== 'available' ? ` · ${t.status}` : ''}</span></label>`).join('');
  const slots = Math.max(7, j.crew_number || 0);
  $('#assignSlot').innerHTML = '<option value="">None</option>' + Array.from({ length: slots }, (_, i) =>
    `<option value="${i + 1}"${j.crew_number === i + 1 ? ' selected' : ''}>Crew ${i + 1}</option>`).join('');
  $('#assignError').textContent = '';
  $('#assignDialog').dataset.jobId = jobId;
  $('#assignDialog').dataset.force = '';
  $('#assignSave').textContent = 'Save assignment';
  $('#assignDialog').showModal();
}

async function saveAssign(e) {
  if (e.submitter?.value !== 'default') return;
  e.preventDefault();
  const dlg = $('#assignDialog');
  const form = $('#assignForm');
  const crew = [...form.querySelectorAll('input[name=crew]:checked')].map((i) => Number(i.value));
  const trucks = [...form.querySelectorAll('input[name=truck]:checked')].map((i) => Number(i.value));
  let leadId = Number(form.querySelector('input[name=lead]:checked')?.value);
  if (!crew.includes(leadId)) leadId = crew[0];
  try {
    await api(`/api/jobs/${dlg.dataset.jobId}/assignments`, { method: 'PUT', body: { crew, trucks, leadId, crewNumber: $('#assignSlot').value || null, force: dlg.dataset.force === '1' } });
    dlg.close();
    toast('Assignment saved');
    refresh();
  } catch (err) {
    if (err.status === 409 && err.data.conflicts) {
      const names = { crew: new Map(state.resources.crew.map((c) => [c.id, c.name])), truck: new Map(state.resources.trucks.map((t) => [t.id, t.name])) };
      $('#assignError').textContent = 'Conflicts:\n' + err.data.conflicts.map((c) =>
        `• ${names[c.type].get(c.id)} ${c.job ? `is already on ${c.job}` : `is in ${c.reason}`}`).join('\n');
      dlg.dataset.force = '1';
      $('#assignSave').textContent = 'Save anyway';
    } else {
      $('#assignError').textContent = err.message;
    }
  }
}

// ------------------------------------------------------------------ Pricing calculator
async function updateQuote() {
  const f = new FormData($('#calcForm'));
  const n = (k) => Number(f.get(k)) || 0;
  const body = {
    hours: n('hours'), crewSize: n('crewSize'), trucks: n('trucks'), distanceMiles: n('distanceMiles'), moveDate: f.get('moveDate') || null,
    origin: { stair_flights: n('o_stairs'), long_walks: n('o_walks'), has_elevator: f.get('o_elevator') ? 1 : 0 },
    destination: { stair_flights: n('d_stairs'), long_walks: n('d_walks'), has_elevator: f.get('d_elevator') ? 1 : 0 },
  };
  try {
    const q = await api('/api/quote/preview', { method: 'POST', body });
    const cents = (c) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    $('#quote').innerHTML = q.lines.map((l) => `<div class="line"><span>${esc(l.description)}</span><span>${cents(l.amount_cents)}</span></div>`).join('')
      + (q.tax_cents ? `<div class="line"><span>Tax</span><span>${cents(q.tax_cents)}</span></div>` : '')
      + `<div class="line total"><span>Estimated total</span><span>${cents(q.total_cents)}</span></div>
         <div class="muted">${q.billable_hours} billable hours (includes minimum and rounding)</div>`;
  } catch (err) {
    $('#quote').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// Fill distance from the two addresses: an estimate of road miles from the addresses' coordinates
// (free Census geocoder) or, failing that, their ZIP codes. Runs on change, not every keystroke.
async function updateDistance() {
  const form = $('#calcForm');
  const from = form.originAddress.value.trim();
  const to = form.destinationAddress.value.trim();
  const note = $('#zipNote');
  if (!from || !to) { note.textContent = ''; return; }
  note.textContent = 'Looking up distance…';
  try {
    const d = await api(`/api/distance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    form.distanceMiles.value = d.miles;
    note.textContent = `≈ ${d.miles} mi by road (${d.straight_miles} mi straight × ${d.road_factor}), `
      + (d.method === 'address' ? 'from the street addresses' : `from ZIP code centres: ${d.from} → ${d.to}`);
    updateQuote();
  } catch (err) {
    note.textContent = err.message;
  }
}

// ------------------------------------------------------------------ Directions dialog
async function openDirections(jobId) {
  const dlg = $('#dirDialog');
  $('#dirError').textContent = '';
  try {
    const d = await api(`/api/jobs/${jobId}/directions`);
    $('#dirTitle').textContent = `Directions · ${d.job_number}`;
    const labels = d.yard_address ? ['Yard', 'Pickup', 'Drop-off'] : ['Pickup', 'Drop-off'];
    $('#dirStops').innerHTML = d.stops.map((s, i) => `<li><span class="muted">${labels[i] ?? 'Stop'}</span> ${esc(s)}</li>`).join('')
      || '<li class="muted">No addresses on this job yet.</li>';
    $('#dirLink').hidden = !d.maps_url;
    if (d.maps_url) $('#dirLink').href = d.maps_url;
    $('#dirCrew').innerHTML = d.crew.map((c) => `
      <label class="dir-row"><input type="checkbox" name="to" value="${c.id}" checked>
        <span>${esc(c.name)}${c.is_lead ? ' ★' : ''}</span>
        <input type="email" name="email-${c.id}" value="${esc(c.email || '')}" placeholder="email address" aria-label="Email for ${esc(c.name)}"></label>`).join('');
    $('#dirPreview').textContent = `Subject: ${d.subject}

${d.body}`;
    const blocked = !d.email_configured ? 'Email is not set up yet: add the SMTP settings to .env to send.' : !d.maps_url ? 'Add pickup and drop-off addresses to send directions.' : '';
    $('#dirSend').disabled = Boolean(blocked);
    $('#dirError').textContent = blocked;
    dlg.dataset.jobId = jobId;
    dlg.showModal();
  } catch (err) {
    toast(err.message);
  }
}

async function sendDirections(e) {
  if (e.submitter?.value !== 'default') return;
  e.preventDefault();
  const form = $('#dirForm');
  const recipients = [...form.querySelectorAll('input[name=to]:checked')]
    .map((i) => ({ crewId: Number(i.value), email: form.querySelector(`input[name="email-${i.value}"]`).value.trim() }));
  const btn = $('#dirSend');
  btn.disabled = true;
  try {
    const r = await api(`/api/jobs/${$('#dirDialog').dataset.jobId}/directions/send`, { method: 'POST', body: { recipients } });
    if (r.failed.length) {
      $('#dirError').textContent = `Sent to ${r.sent.join(', ') || 'nobody'}. Failed: ${r.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`;
    } else {
      $('#dirDialog').close();
      toast(`Directions sent to ${r.sent.join(', ')}`);
    }
    state.resources = await api('/api/resources');
  } catch (err) {
    $('#dirError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ Wiring
async function refresh() {
  const d = state.date;
  const [kpis, schedule, jobs] = await Promise.all([
    api(`/api/dashboard?date=${d}`), api(`/api/schedule?date=${d}`), api(`/api/jobs?from=${d}&to=${d}`),
  ]);
  state.jobsById = new Map(jobs.map((j) => [j.id, j]));
  renderKpis(kpis);
  renderSchedule(schedule);
  renderDispatch(jobs);
  state.lastJobs = jobs;
}

function shiftDate(days) {
  const d = new Date(`${state.date}T12:00`);
  d.setDate(d.getDate() + days);
  setDate(localDate(d));
}
function setDate(d) {
  state.date = d;
  $('#date').value = d;
  refresh().catch((e) => toast(e.message));
}

document.addEventListener('click', (e) => {
  const dir = e.target.closest('[data-directions]');
  if (dir) { openDirections(Number(dir.dataset.directions)); return; }
  const target = e.target.closest('[data-assign],[data-job]');
  if (target) openAssign(Number(target.dataset.assign || target.dataset.job));
});
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-status]');
  if (!sel) return;
  try {
    await api(`/api/jobs/${sel.dataset.status}/status`, { method: 'PATCH', body: { status: sel.value } });
    toast(`Status → ${statusLabel(sel.value)}`);
  } catch (err) {
    toast(err.message);
  }
  refresh();
});

$('#statusFilter').innerHTML += STATUSES.map((s) => `<option value="${s}">${statusLabel(s)}</option>`).join('');
$('#statusFilter').addEventListener('change', () => renderDispatch(state.lastJobs || []));
$('#prevDay').onclick = () => shiftDate(-1);
$('#nextDay').onclick = () => shiftDate(1);
$('#todayBtn').onclick = () => setDate(localDate());
$('#date').onchange = (e) => e.target.value && setDate(e.target.value);
$('#assignForm').addEventListener('submit', saveAssign);
$('#calcForm').addEventListener('input', (e) => { if (!['originAddress', 'destinationAddress'].includes(e.target.name)) updateQuote(); });
$('#calcForm').addEventListener('change', (e) => { if (['originAddress', 'destinationAddress'].includes(e.target.name)) updateDistance(); });
$('#dirForm').addEventListener('submit', sendDirections);
$('#calcForm').moveDate.value = localDate();

(async () => {
  state.resources = await api('/api/resources');
  const card = await api('/api/rate-card');
  $('#rateCardName').textContent = card?.name ?? '';
  setDate(state.date);
  updateQuote();
})();
