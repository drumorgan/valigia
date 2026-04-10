import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  document.body.innerHTML = `
    <div style="padding:2rem;color:#e8824a;font-family:'Syne Mono',monospace;">
      <h2>Configuration Error</h2>
      <p>Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.</p>
      <p>Copy .env.example to .env and fill in your Supabase credentials.</p>
    </div>
  `;
  throw new Error('Missing Supabase env vars');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export { supabaseUrl, supabaseAnonKey };
