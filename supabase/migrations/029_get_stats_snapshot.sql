-- Valigia — stats snapshot RPC
--
-- Single round-trip aggregation for the expandable stats panel behind the
-- Scouts banner. One call returns everything the panel renders, so a user
-- opening/closing the triangle doesn't N+1 the database.
--
-- Security: SECURITY DEFINER stable SQL so the anon role can call it but
-- can't read the underlying rows directly where RLS blocks them. Every
-- aggregate here is already over tables whose rows are anon-readable, but
-- keeping the definer boundary means any future row-level restriction on
-- one of these tables won't silently break the panel.
--
-- Shape (keep in sync with src/stats-panel.js):
--   {
--     "contributors": { "registered": 38, "pda_scouts_24h": 15 },
--     "abroad":       [ { "destination": "UAE", "items_known": 16,
--                         "fresh_30m": 14, "last_scout_s": 180 }, ... ],
--     "pools":        { "sell_prices": ..., "bazaar_active": ...,
--                       "te_traders": ..., "te_offers": ...,
--                       "watchlist_alerts": ... },
--     "community":    { "spins": 12847 },
--     "restocks":     { "events_7d": 204, "median_cadence_min": 28 }
--   }
--
-- `bazaar_active` uses the same miss_count cutoff (< 3) the scanner uses
-- to decide a bazaar is pruneable; the raw row count would over-report
-- since dead rows linger until the next prune pass.
--
-- Run this in the Supabase Dashboard SQL Editor after merging.

create or replace function get_stats_snapshot()
returns jsonb
language sql
security definer
stable
as $$
  with
  contrib as (
    select
      (select count(*)::int from player_secrets)                      as registered,
      (select count(distinct player_id)::int
         from pda_activity
         where observed_at > now() - interval '24 hours')             as pda_scouts_24h
  ),
  abroad_rows as (
    select
      destination,
      count(distinct item_id)::int                                    as items_known,
      count(distinct item_id) filter
        (where observed_at > now() - interval '30 minutes')::int      as fresh_30m,
      extract(epoch from (now() - max(observed_at)))::int             as last_scout_s
    from abroad_prices
    group by destination
  ),
  abroad as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'destination',  destination,
          'items_known',  items_known,
          'fresh_30m',    fresh_30m,
          'last_scout_s', last_scout_s
        )
        order by items_known desc, destination asc
      ),
      '[]'::jsonb
    ) as payload
    from abroad_rows
  ),
  pools as (
    select
      (select count(*)::int from sell_prices)                                            as sell_prices,
      (select count(*)::int from bazaar_prices where coalesce(miss_count, 0) < 3)        as bazaar_active,
      (select count(*)::int from te_traders)                                             as te_traders,
      (select count(*)::int from te_buy_prices)                                          as te_offers,
      (select count(*)::int from watchlist_alerts)                                       as watchlist_alerts
  ),
  community as (
    select coalesce(
      (select total_spins from community_stats where id = 1), 0
    )::bigint as spins
  ),
  -- Median gap between consecutive restocks per (item, destination) over
  -- the last 7 d. Within-partition lag() gives the interval in minutes; a
  -- single percentile_cont across all gaps yields a single headline
  -- number that's robust to the long-tail outliers early cadence
  -- estimation will produce.
  restock_gaps as (
    select
      extract(epoch from (restocked_at - lag(restocked_at)
        over (partition by item_id, destination order by restocked_at))) / 60.0
        as gap_min
    from restock_events
    where restocked_at > now() - interval '7 days'
  ),
  restocks as (
    select
      (select count(*)::int from restock_events
         where restocked_at > now() - interval '7 days')                               as events_7d,
      (select (percentile_cont(0.5) within group (order by gap_min))::int
         from restock_gaps
         where gap_min is not null and gap_min > 0)                                    as median_cadence_min
  )
  select jsonb_build_object(
    'contributors', jsonb_build_object(
      'registered',     (select registered     from contrib),
      'pda_scouts_24h', (select pda_scouts_24h from contrib)
    ),
    'abroad',       (select payload from abroad),
    'pools',        jsonb_build_object(
      'sell_prices',      (select sell_prices      from pools),
      'bazaar_active',    (select bazaar_active    from pools),
      'te_traders',       (select te_traders       from pools),
      'te_offers',        (select te_offers        from pools),
      'watchlist_alerts', (select watchlist_alerts from pools)
    ),
    'community',    jsonb_build_object('spins', (select spins from community)),
    'restocks',     jsonb_build_object(
      'events_7d',          (select events_7d          from restocks),
      'median_cadence_min', (select median_cadence_min from restocks)
    )
  );
$$;

grant execute on function get_stats_snapshot() to anon, authenticated;
