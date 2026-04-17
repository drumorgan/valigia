-- Valigia — PDA activity log (multi-page scout tracking)
--
-- Supersedes migration 016's get_pda_activity_24h(). That RPC read
-- abroad_prices directly, which limited the count to travel-page
-- contributors — the only runner that goes through a key-validating
-- edge function. Item Market and Bazaar scrapes were invisible to the
-- scout count even though they're the bulk of PDA-userscript traffic.
--
-- This migration introduces a dedicated pda_activity table that every
-- attributed runner writes into. The travel ingest fans out to it
-- server-side; a new record-pda-activity edge function handles Item
-- Market + Bazaar pings (same key-validation shape as ingest-travel-shop).
--
-- Trust model is unchanged: every row's player_id has been validated
-- against Torn's user/basic endpoint within the same request. No anon
-- writes — service role only.
--
-- Run this in the Supabase Dashboard SQL Editor after merging.
--
-- NOTE: This migration starts the counts fresh. The banner will fill
-- naturally over the first 24h after deploy. No backfill from
-- abroad_prices — keeping the ingest paths as the single source of
-- truth is simpler than reconciling two histories.

create table if not exists pda_activity (
  id          bigserial   primary key,
  player_id   bigint      not null,
  page_type   text        not null check (page_type in ('travel','item_market','bazaar')),
  observed_at timestamptz not null default now()
);

create index if not exists pda_activity_page_time
  on pda_activity (page_type, observed_at desc);

create index if not exists pda_activity_player_time
  on pda_activity (player_id, observed_at desc);

-- Replace the travel-only RPC from migration 016.
drop function if exists get_pda_activity_24h();

create or replace function get_pda_activity_24h()
returns table(page_type text, scouts integer, events integer) as $$
  select
    page_type,
    count(distinct player_id)::integer as scouts,
    count(*)::integer                  as events
  from pda_activity
  where observed_at > now() - interval '24 hours'
  group by page_type;
$$ language sql security definer stable;

grant execute on function get_pda_activity_24h() to anon, authenticated;
