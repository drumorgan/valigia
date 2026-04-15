-- Valigia — PDA scout count RPC
--
-- Counts distinct PDA userscript contributors who have pushed a travel-shop
-- observation in the last 24 hours. Only the travel runner goes through the
-- ingest-travel-shop edge function, which validates each submitting API key
-- via user/?selections=basic before stamping observer_player_id onto every
-- row in abroad_prices. That makes this count honest: every unit is a real,
-- key-validated player who actively ran the PDA script on the travel page.
--
-- The Item Market and Bazaar runners write via direct anon PostgREST upsert
-- (no key validation, no attribution), so they are intentionally NOT counted
-- here. If we ever want to include them, we'll need a separate attribution
-- path.
--
-- Exposed as an RPC (not a view) to keep the call surface small and to match
-- get_player_count()'s pattern. Granted to anon + authenticated so the web
-- app can display the counter without a logged-in session.
--
-- Run this in the Supabase Dashboard SQL Editor after merging.

create or replace function get_pda_scouts_24h()
returns integer as $$
  select count(distinct observer_player_id)::integer
  from abroad_prices
  where observed_at > now() - interval '24 hours';
$$ language sql security definer stable;

grant execute on function get_pda_scouts_24h() to anon, authenticated;
