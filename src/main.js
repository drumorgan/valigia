// Valigia — entry point
// Ping Supabase to verify connection, show result on screen.
// TEMPORARY: extra diagnostics until connection is confirmed.

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const el = document.querySelector('.hello');

if (!url || !key) {
  el.innerHTML = `Supabase: env vars missing<br><small>URL: ${url || '(unset)'}<br>KEY: ${key ? key.slice(0, 20) + '…' : '(unset)'}</small>`;
} else {
  el.textContent = 'Supabase: checking…';
  const target = `${url}/rest/v1/`;
  fetch(target, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  })
    .then(r => {
      if (r.ok) {
        el.textContent = 'Supabase: connected';
      } else {
        el.innerHTML = `Supabase: HTTP ${r.status}<br><small>URL: ${target}<br>KEY starts: ${key.slice(0, 20)}…<br>KEY length: ${key.length}</small>`;
      }
    })
    .catch(err => {
      el.innerHTML = `Supabase: ${err.message}<br><small>URL: ${target}</small>`;
    });
}
