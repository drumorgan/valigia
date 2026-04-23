-- Valigia — restock cadence quality fix
--
-- Replaces get_stats_snapshot() from migration 029 with two filters in the
-- restock cadence calc that dramatically improve data quality without any
-- new observations:
--
-- 1. source != 'backfill' — migration 018's one-time backfill from
--    yata_snapshots is stale data whose observation gaps don't reflect
--    the cadence of actual user activity.
--
-- 2. gap_min <= 120 — caps the inter-event interval at 2 hours when
--    computing the median. A 2-day gap between observations means
--    "nobody visited for 2 days", not "one restock per 2 days". Capping
--    defends the median from those stale-observation spans without
--    having to wait for organic scout volume to drown them out.
--
-- Shape of the returned JSONB is unchanged — this only tightens the
-- cadence computation. The client (src/stats-panel.js) needs no changes.
--
-- The events_7d total gets the same backfill filter so the numerator and
-- denominator stay consistent (if a gap is ignored, the flanking event
-- shouldn't be counted either).
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
  -- Live restock events within the 7-day window, excluding the one-time
  -- yata_snapshots backfill since those rows carry historical YATA
  -- sampling gaps rather than current scout cadence.
  restock_events_live as (
    select item_id, destination, restocked_at
    from restock_events
    where restocked_at > now() - interval '7 days'
      and source <> 'backfill'
  ),
  -- Per-partition lag() gives the inter-restock interval in minutes.
  -- Cap at 120 min when feeding the median so a stale-observation span
  -- (no scout visited for hours) doesn't masquerade as a single long
  -- cadence. Torn's real shelf cadence is well under 120 min for every
  -- destination we care about, so this cap is a defensible noise floor.
  restock_gaps as (
    select
      extract(epoch from (restocked_at - lag(restocked_at)
        over (partition by item_id, destination order by restocked_at))) / 60.0
        as gap_min
    from restock_events_live
  ),
  restocks as (
    select
      (select count(*)::int from restock_events_live)                                    as events_7d,
      (select (percentile_cont(0.5) within group (order by gap_min))::int
         from restock_gaps
         where gap_min is not null
           and gap_min > 0
           and gap_min <= 120)                                                           as median_cadence_min
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
