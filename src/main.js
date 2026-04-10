// Valigia — entry point
// Ping Supabase via SDK to verify connection.

import { supabase } from './supabase.js';

const el = document.querySelector('.hello');

if (!supabase) {
  // supabase.js already showed the env-missing message
} else {
  el.textContent = 'Supabase: checking…';
  supabase
    .from('abroad_prices')
    .select('id')
    .limit(1)
    .then(({ data, error }) => {
      if (error) {
        el.textContent = `Supabase: ${error.message}`;
      } else if (data && data.length > 0) {
        el.textContent = 'Supabase: connected (has data)';
      } else {
        el.textContent = 'Supabase: connected (table empty)';
      }
    });
}
