-- Valigia — PDA activity RPC (scouts + trips)
--
-- Supersedes migration 015's get_pda_scouts_24h(). The scouts-only number
-- told an honest but muted story — a single prolific contributor still
-- showed as "1". Pairing it with a trips count (row count over the same
-- window) tells both dimensions: community reach AND actual activity flow.
--
-- One RPC returning both values keeps the round trip count at one.
--
-- Same trust story as migration 015: only the travel runner goes through
-- ingest-travel-shop, so every row in abroad_prices carries a real,
-- key-validated observer_player_id. Item Market + Bazaar runners write
-- anon without attribution and are intentionally excluded.
--
-- Run this in the Supabase Dashboard SQL Editor after merging.

-- Drop the single-value RPC from migration 015. Idempotent: harmless
-- whether 015 was applied yet or not.
drop function if exists get_pda_scouts_24h();

create or replace function get_pda_activity_24h()
returns table(scouts integer, trips integer) as $$
  select
    count(distinct observer_player_id)::integer as scouts,
    count(*)::integer                            as trips
  from abroad_prices
  where observed_at > now() - interval '24 hours';
$$ language sql security definer stable;

grant execute on function get_pda_activity_24h() to anon, authenticated;
