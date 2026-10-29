// Calendar: month / week grid and a printable schedule list for any date range.
const TYPE_LABEL = { move: 'Move', callback: 'Call back', visit: 'Site visit' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const state = {
  view: matchMedia('(max-width: 760px)').matches ? 'list' : 'month',
  anchor: localDate(),
  listFrom: localDate(),
  listTo: addDays(localDate(), 6),
  types: new Set(['move', 'callback', 'visit']),
  data: { events: [], notes: {} },
  selected: null,
};

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
}
const weekday = (iso) => new Date(`${iso}T12:00`).getDay();
const longDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

function range() {
  if (state.view === 'list') return [state.listFrom, state.listTo];
  if (state.view === 'week') {
    const start = addDays(state.anchor, -weekday(state.anchor));
    return [start, addDays(start, 6)];
  }
  const first = `${state.anchor.slice(0, 7)}-01`;
  const start = addDays(first, -weekday(first));
  const nextMonth = new Date(`${first}T12:00`);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const last = addDays(localDate(nextMonth), -1);
  return [start, addDays(last, 6 - weekday(last))];
}

function eventsOn(date) {
  return state.data.events.filter((e) => e.date === date && state.types.has(e.type))
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || a.type.localeCompare(b.type));
}

function chip(e) {
  const time = e.time ? fmt12(e.time).replace(':00', '').replace(' ', '') : '';
  const what = e.type === 'move' ? `${e.customer_name} (${e.crew_size})` : `${TYPE_LABEL[e.type]}: ${e.customer_name}`;
  return `<a class="chip ${e.type}${e.tentative ? ' tentative' : ''}" href="estimate.html?id=${e.job_id}"
    title="${esc(`${TYPE_LABEL[e.type]} · #${e.job_number} · ${e.customer_name}${e.tentative ? ' (not booked yet)' : ''}`)}">${time ? `<b>${time}</b> ` : ''}${esc(what)}</a>`;
}

// ------------------------------------------------------------------ month / week
function renderGrid() {
  const [from, to] = range();
  const today = localDate();
  const month = state.anchor.slice(0, 7);
  const cells = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const evs = eventsOn(d);
    const limit = state.view === 'week' ? 99 : 4;
    cells.push(`<div class="cal-cell${d === today ? ' today' : ''}${state.view === 'month' && d.slice(0, 7) !== month ? ' other' : ''}${d === state.selected ? ' selected' : ''}"
        data-date="${d}" tabindex="0" role="button" aria-label="${longDate(d)}: ${evs.length} item${evs.length === 1 ? '' : 's'}">
      <div class="cal-date"><span>${Number(d.slice(8))}</span>${state.data.notes[d] ? '<span class="note-flag" title="Has a note">✎</span>' : ''}</div>
      ${evs.slice(0, limit).map(chip).join('')}
      ${evs.length > limit ? `<span class="more">+${evs.length - limit} more</span>` : ''}
    </div>`);
  }
  $('#calMain').innerHTML = `<div class="cal-grid ${state.view}">
    ${DAY_NAMES.map((n) => `<div class="cal-head">${n}</div>`).join('')}${cells.join('')}</div>`;
}

// ------------------------------------------------------------------ schedule list
function renderList() {
  const [from, to] = range();
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const evs = eventsOn(d);
    const note = state.data.notes[d];
    if (!evs.length && !note) continue;
    const moves = evs.filter((e) => e.type === 'move');
    const others = evs.filter((e) => e.type !== 'move');
    days.push(`<section class="sched-day">
      <h2>${longDate(d)} <span class="muted small">${moves.length} move${moves.length === 1 ? '' : 's'}</span></h2>
      ${note ? `<p class="day-note">✎ ${esc(note)}</p>` : ''}
      ${moves.length ? `<div class="table-wrap"><table class="grid">
        <thead><tr><th>Arrival</th><th>Est. #</th><th>Customer</th><th>Phone</th><th>From → to</th><th class="num">Movers</th><th>Crew</th><th class="num">Total</th><th>Status</th></tr></thead>
        <tbody>${moves.map((m) => `<tr>
          <td class="nowrap">${m.arrival_window_start ? `${fmt12(m.arrival_window_start)}${m.arrival_window_end ? `–${fmt12(m.arrival_window_end)}` : ''}` : 'TBD'}</td>
          <td><a href="estimate.html?id=${m.job_id}">${esc(m.job_number)}</a></td>
          <td>${esc(m.customer_name)}</td>
          <td class="nowrap">${esc(m.phone ?? '')}</td>
          <td>${esc([m.origin_city, m.origin_zip].filter(Boolean).join(' '))} → ${esc([m.destination_city, m.destination_zip].filter(Boolean).join(' '))}</td>
          <td class="num">${m.crew_size}</td>
          <td>${m.crew_number ? `Crew ${m.crew_number}` : '<span class="muted">—</span>'}</td>
          <td class="num">${money(m.total_cents)}</td>
          <td><span class="pill" style="--sc:var(--s-${m.status})">${statusLabel(m.status)}</span></td>
        </tr>`).join('')}</tbody></table></div>` : ''}
      ${others.length ? `<ul class="sched-other">${others.map((e) => `<li><span class="dot ${e.type}"></span>${TYPE_LABEL[e.type]}${e.time ? ` at ${fmt12(e.time)}` : ''}:
        <a href="estimate.html?id=${e.job_id}">#${esc(e.job_number)} ${esc(e.customer_name)}</a> ${esc(e.phone ?? '')}</li>`).join('')}</ul>` : ''}
    </section>`);
  }
  $('#calMain').innerHTML = days.join('') || '<p class="empty">Nothing scheduled in this period.</p>';
}

// ------------------------------------------------------------------ day panel
function renderDay() {
  const d = state.selected;
  $('#dayPanel').hidden = !d || state.view === 'list';
  if (!d || state.view === 'list') return;
  $('#dayTitle').textContent = longDate(d);
  const evs = eventsOn(d);
  $('#dayEvents').innerHTML = evs.length ? `<ul class="day-list">${evs.map((e) => `<li class="${e.type}">
      <span class="dot ${e.type}"></span>
      <div><a href="estimate.html?id=${e.job_id}"><strong>${esc(e.customer_name)}</strong></a> <span class="muted">#${esc(e.job_number)}</span><br>
        <span class="small">${TYPE_LABEL[e.type]}${e.time ? ` · ${fmt12(e.time)}` : ''}${e.type === 'move' ? ` · ${e.crew_size} movers${e.tentative ? ' · not booked yet' : ''}` : ''}${e.phone ? ` · ${esc(e.phone)}` : ''}</span>
        ${e.type === 'callback' ? `<button class="link-btn" data-callback-done="${e.job_id}">Mark call-back done</button>` : ''}
      </div></li>`).join('')}</ul>` : '<p class="muted">Nothing scheduled.</p>';
  $('#dayNote').value = state.data.notes[d] ?? '';
  $('#newForDay').href = 'estimate.html';
}

// ------------------------------------------------------------------ load + wiring
async function load() {
  const [from, to] = range();
  const title = state.view === 'month'
    ? new Date(`${state.anchor}T12:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : `${fmtDate(from)} – ${fmtDate(to)}`;
  $('#rangeTitle').textContent = title;
  $('.cal-nav').hidden = state.view === 'list';
  $('.list-range').hidden = state.view !== 'list';
  try {
    state.data = await api(`/api/calendar?from=${from}&to=${to}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  if (state.view === 'list') renderList(); else renderGrid();
  renderDay();
}

function step(dir) {
  const d = new Date(`${state.anchor}T12:00`);
  if (state.view === 'month') { d.setDate(1); d.setMonth(d.getMonth() + dir); } else d.setDate(d.getDate() + 7 * dir);
  state.anchor = localDate(d);
  load();
}

$$('input[name=view]').forEach((r) => { r.checked = r.value === state.view; });
$$('input[name=view]').forEach((r) => r.addEventListener('change', () => { state.view = r.value; load(); }));
$('#prev').addEventListener('click', () => step(-1));
$('#next').addEventListener('click', () => step(1));
$('#today').addEventListener('click', () => { state.anchor = localDate(); state.selected = localDate(); load(); });
$('#listFrom').value = state.listFrom;
$('#listTo').value = state.listTo;
for (const id of ['listFrom', 'listTo']) {
  $(`#${id}`).addEventListener('change', (e) => {
    state[id] = e.target.value;
    if (state.listTo < state.listFrom) { state.listTo = state.listFrom; $('#listTo').value = state.listTo; }
    load();
  });
}
$('#printList').addEventListener('click', () => window.print());
$$('.cal-filters input').forEach((c) => c.addEventListener('change', () => {
  if (c.checked) state.types.add(c.dataset.type); else state.types.delete(c.dataset.type);
  if (state.view === 'list') renderList(); else renderGrid();
  renderDay();
}));

function selectCell(cell) {
  state.selected = cell.dataset.date;
  $$('.cal-cell.selected').forEach((c) => c.classList.remove('selected'));
  cell.classList.add('selected');
  renderDay();
}
$('#calMain').addEventListener('click', (e) => {
  const cell = e.target.closest('.cal-cell');
  if (cell && !e.target.closest('a')) selectCell(cell);
});
$('#calMain').addEventListener('keydown', (e) => {
  const cell = e.target.closest('.cal-cell');
  if (cell && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectCell(cell); }
});
$('#closeDay').addEventListener('click', () => { state.selected = null; renderGrid(); renderDay(); });
$('#saveNote').addEventListener('click', async () => {
  try {
    const r = await api(`/api/day-notes/${state.selected}`, { method: 'PUT', body: { notes: $('#dayNote').value } });
    if (r.notes) state.data.notes[r.date] = r.notes; else delete state.data.notes[r.date];
    renderGrid();
    toast('Note saved');
  } catch (err) {
    toast(err.message);
  }
});
$('#dayEvents').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-callback-done]');
  if (!b) return;
  await api(`/api/jobs/${b.dataset.callbackDone}/callback-done`, { method: 'POST', body: {} });
  toast('Call-back marked done');
  load();
});
load();
