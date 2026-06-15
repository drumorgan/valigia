-- Valigia — per-model forecast accuracy breakdown
--
-- Phase 1 observability. migration 035 surfaced a single combined accuracy
-- number across all model versions. During a model rollout that blends the
-- old and new cohorts for the full 30-day window, so you can't tell whether
-- the new model actually helped until the old one ages out a month later.
--
-- This adds a `by_model` array to the forecast_accuracy block so the stats
-- panel can show v1 vs v2 side by side immediately. The combined headline
-- stays for at-a-glance. Everything else is carried forward verbatim from
-- migration 030 + 035 — drop-in replacement.
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
  restock_events_live as (
    select item_id, destination, restocked_at
    from restock_events
    where restocked_at > now() - interval '7 days'
      and source <> 'backfill'
  ),
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
  ),
  resolved as (
    select model_version, restock_error_mins
    from forecast_predictions
    where predicted_at > now() - interval '30 days'
      and resolved_at is not null
  ),
  forecast_acc as (
    select
      (select count(*) from resolved)                                                    as n_resolved,
      (select (percentile_cont(0.5) within group (order by abs(restock_error_mins)))::numeric(10,1)
         from resolved)                                                                  as median_abs_err_min,
      (select (percentile_cont(0.5) within group (order by restock_error_mins))::numeric(10,1)
         from resolved)                                                                  as median_signed_err_min,
      (select (percentile_cont(0.9) within group (order by abs(restock_error_mins)))::numeric(10,1)
         from resolved)                                                                  as p90_abs_err_min,
      (select count(*) from forecast_predictions
        where predicted_at > now() - interval '30 days'
          and resolved_at is null
          and predicted_restock_at is not null)                                          as n_open
  ),
  -- Per-model split so a rollout's cohorts can be compared immediately
  -- instead of waiting for the older one to age out of the 30-day window.
  forecast_by_model as (
    select
      model_version,
      count(*)::int                                                                      as n_resolved,
      (percentile_cont(0.5) within group (order by abs(restock_error_mins)))::numeric(10,1) as median_abs_err_min,
      (percentile_cont(0.5) within group (order by restock_error_mins))::numeric(10,1)      as median_signed_err_min
    from resolved
    group by model_version
  ),
  forecast_models as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'model_version',         model_version,
          'n_resolved',            n_resolved,
          'median_abs_err_min',    median_abs_err_min,
          'median_signed_err_min', median_signed_err_min
        )
        order by model_version desc
      ),
      '[]'::jsonb
    ) as payload
    from forecast_by_model
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
    ),
    'forecast_accuracy', jsonb_build_object(
      'n_resolved',            (select n_resolved            from forecast_acc),
      'median_abs_err_min',    (select median_abs_err_min    from forecast_acc),
      'median_signed_err_min', (select median_signed_err_min from forecast_acc),
      'p90_abs_err_min',       (select p90_abs_err_min       from forecast_acc),
      'n_open',                (select n_open                from forecast_acc),
      'by_model',              (select payload               from forecast_models)
    )
  );
$$;

grant execute on function get_stats_snapshot() to anon, authenticated;
