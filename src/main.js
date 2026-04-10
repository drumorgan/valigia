// Valigia — entry point
// Ping Supabase to verify connection, show result on screen.

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const el = document.querySelector('.hello');

if (!url || !key) {
  el.textContent = 'Supabase: env vars missing';
} else {
  el.textContent = 'Supabase: checking…';
  fetch(`${url}/rest/v1/`, {
    headers: { apikey: key }
  })
    .then(r => {
      el.textContent = r.ok
        ? 'Supabase: connected'
        : `Supabase: HTTP ${r.status}`;
    })
    .catch(err => {
      el.textContent = `Supabase: ${err.message}`;
    });
}
