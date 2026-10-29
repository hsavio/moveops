// Helpers shared by every MoveOps page. Loaded before the page's own script.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => (cents == null ? '—' : `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const money2 = (cents) => (cents == null ? '—' : `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
// "$1,234.50" / "1234.5" -> 123450 cents; '' -> null
const toCents = (v) => {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  return s === '' || Number.isNaN(Number(s)) ? null : Math.round(Number(s) * 100);
};
const fromCents = (c) => (c == null ? '' : (c / 100).toFixed(2));
const statusLabel = (s) => String(s).replace('_', ' ');
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA');
const fmtDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const fmt12 = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}

function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}
