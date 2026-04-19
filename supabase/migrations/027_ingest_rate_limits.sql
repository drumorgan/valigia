-- Per-player rate limit gate for the three ingest edge functions.
--
-- Before this: anon-write and key-validated-write endpoints (ingest-
-- sell-prices, ingest-bazaar-prices, ingest-travel-shop) only enforced
-- a per-request row cap (200/500/∞). A determined caller could POST as
-- fast as the network allowed, flooding the shared pool with bogus
-- prices or DOS-ing the service-role Postgres connection.
--
-- This migration adds a lightweight per-(player_id, endpoint) interval
-- gate. Each edge function calls ingest_rate_check() at the top. The
-- function atomically:
--   1. Looks up the last_write_at for this (player, endpoint) pair.
--   2. If the last write was more recent than p_min_interval_ms, it
--      returns false → caller answers 429.
--   3. Otherwise it upserts the row with now() and returns true.
--
-- Atomicity matters because two concurrent requests from the same
-- player would otherwise both read "no row" and both pass the gate.
-- A row-level FOR UPDATE lock inside the function serializes the
-- check against any other concurrent call for the same (player, endpoint).
--
-- Chosen intervals (applied by the callers, not the SQL):
--   sell-prices / bazaar-prices : 500 ms (permits the bazaar-scanner
--     Phase-3 verify loop where each iteration naturally spaces out
--     by ~1-2 s due to callTornApi; blocks tight mass-upsert loops)
--   travel-shop : 5000 ms (one POST per abroad landing; user can't
--     land again for ~10+ min flight time anyway)
--
-- Fail-open design: if the RPC errors (DB hiccup, network), the edge
-- function proceeds with the write. A flaky rate-limit gate is better
-- than a flaky ingest gate — the pool stays writable even if this
-- table is unavailable.
--
-- Run this in the Supabase Dashboard SQL Editor.

create table if not exists ingest_rate_limits (
  player_id     integer     not null,
  endpoint      text        not null,
  last_write_at timestamptz not null default now(),
  primary key (player_id, endpoint)
);

alter table ingest_rate_limits enable row level security;
-- No policies → service-role only (edge functions bypass RLS). Anon
-- must never read these timestamps; they'd leak scraping cadence.

create or replace function ingest_rate_check(
  p_player_id       integer,
  p_endpoint        text,
  p_min_interval_ms integer
) returns boolean as $$
declare
  last_at timestamptz;
begin
  select last_write_at into last_at
  from ingest_rate_limits
  where player_id = p_player_id and endpoint = p_endpoint
  for update;

  if last_at is not null
     and (now() - last_at) < (p_min_interval_ms * interval '1 millisecond') then
    return false;
  end if;

  insert into ingest_rate_limits (player_id, endpoint, last_write_at)
  values (p_player_id, p_endpoint, now())
  on conflict (player_id, endpoint)
    do update set last_write_at = now();

  return true;
end;
$$ language plpgsql security definer;

-- service_role is the only caller (edge functions); granting to it
-- explicitly documents the contract even though SECURITY DEFINER
-- means the function runs with the creator's privileges regardless.
grant execute on function ingest_rate_check(integer, text, integer)
  to service_role;
