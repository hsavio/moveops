// Sign in, first-run admin setup, and the forced password change for new accounts.
const next = (() => {
  const n = new URLSearchParams(location.search).get('next') || '/index.html';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/index.html'; // only same-site redirects
})();

function show(id) {
  for (const f of ['loginForm', 'setupForm', 'changeForm']) $(`#${f}`).hidden = f !== id;
  const first = $(`#${id} input`);
  if (first) first.focus();
}

function done(user) {
  if (user.must_change_password) show('changeForm');
  else location.href = next;
}

function wire(id, url, after) {
  $(`#${id}`).addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error', e.target);
    err.textContent = '';
    const btn = $('button', e.target);
    btn.disabled = true;
    try {
      after(await api(url, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }));
    } catch (error) {
      err.textContent = error.message;
    } finally {
      btn.disabled = false;
    }
  });
}

wire('loginForm', '/api/auth/login', (r) => done(r.user));
wire('setupForm', '/api/auth/setup', (r) => done(r.user));
wire('changeForm', '/api/auth/password', () => { location.href = next; });

(async () => {
  const s = await api('/api/auth/status');
  if (s.user) done(s.user);
  else show(s.setup_needed ? 'setupForm' : 'loginForm');
})();
