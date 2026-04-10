// Valigia — entry point
// Uses the Supabase JS SDK to verify connection, then will orchestrate
// the full app flow once remaining modules are built.

import { supabase, supabaseUrl } from './supabase.js';

const el = document.querySelector('.status');

el.textContent = 'Supabase: checking…';

// Ping by reading from abroad_prices (the table may be empty — that's fine,
// a successful empty response still proves the connection + RLS work).
supabase
  .from('abroad_prices')
  .select('id')
  .limit(1)
  .then(({ data, error }) => {
    if (error) {
      el.innerHTML = `Supabase: ${error.message}<br><small>${supabaseUrl}</small>`;
    } else {
      el.textContent = `Supabase: connected (${data.length ? 'has data' : 'table empty'})`;
    }
  })
  .catch(err => {
    el.innerHTML = `Supabase: ${err.message}<br><small>${supabaseUrl}</small>`;
  });
