-- Valigia — forecast prediction-accuracy log (Phase 0: ground truth)
--
-- Why this exists
-- ---------------
-- The depletion-slope fitter and restock-cadence estimator in
-- src/stock-forecast.js compute an *in-sample* leave-one-out MAE, but the
-- app has never measured whether a prediction was actually right against
-- the realized outcome. Without an out-of-sample accuracy signal there's
-- no honest way to claim one model is better than another, and every
-- future tuning change is a guess.
--
-- This migration adds the measurement harness:
--   1. forecast_predictions — one row per restock-timing prediction the
--      client logs (throttled + deduped), carrying the predicted next
--      restock time, post-restock qty, depletion slope, and confidence.
--   2. resolve_forecast_predictions() — an AFTER INSERT trigger on
--      restock_events. When a real restock lands for a (item, destination),
--      it closes out every still-open prediction made before that event,
--      stamping the signed error (actual − predicted). Each prediction is
--      thus resolved by the very next actual restock that followed it.
--   3. get_stats_snapshot() gains a `forecast_accuracy` block so the
--      existing stats panel (src/stats-panel.js) surfaces the live MAE /
--      bias without any new fetch.
--
-- Trust model mirrors restock_events: anon can read + insert, rows are
-- otherwise immutable (resolution runs SECURITY DEFINER, bypassing RLS).
--
-- Run this in the Supabase Dashboard SQL Editor after merging.

create table if not exists forecast_predictions (
  id                          bigserial primary key,
  item_id                     integer     not null,
  destination                 text        not null,
  -- Bumped whenever the forecasting model changes so resolved cohorts can
  -- be compared apples-to-apples across model versions.
  model_version               text        not null default 'v1',
  predicted_at                timestamptz not null default now(),

  -- Prediction payload. predicted_restock_at is absolute (flight-independent)
  -- so it can be compared directly against the realized restocked_at.
  predicted_restock_at        timestamptz,
  predicted_post_qty          integer,
  -- Steady-state depletion slope (units/min, <= 0) at prediction time.
  -- Logged for offline depletion backtests; not resolved by the trigger
  -- (depletion is continuous, not a discrete event).
  predicted_depletion_per_min numeric,
  restock_confidence          text,

  -- Resolution — filled by resolve_forecast_predictions() when the next
  -- real restock for this shelf lands.
  resolved_at                 timestamptz,
  actual_restock_at           timestamptz,
  actual_post_qty             integer,
  -- Signed: actual − predicted, in minutes. Positive = we predicted the
  -- restock too EARLY (it actually came later). Negative = too late.
  restock_error_mins          numeric,
  -- Signed: actual − predicted post-restock quantity.
  post_qty_error              integer,

  created_at                  timestamptz not null default now(),

  -- Coarse dedup bucket. Predictions are derived from the shared pool and
  -- predicted_restock_at is flight-independent, so any two users logging
  -- the same shelf inside the same 10-min window produce ~identical rows.
  -- Collapsing them keeps the table bounded under concurrent load.
  --
  -- Immutability: extract(epoch from timestamptz) resolves to the STABLE
  -- timestamptz_part function (its volatility can't depend on the field
  -- name), which a stored generated column rejects — same trap migration
  -- 018 hit with date_trunc. Converting to a plain UTC timestamp first
  -- (`at time zone 'UTC'`) routes through the IMMUTABLE timestamp_part,
  -- and to_timestamp(double) is itself IMMUTABLE. 600 s = 10-min buckets.
  predicted_bucket timestamptz generated always as
    (to_timestamp(floor(extract(epoch from (predicted_at at time zone 'UTC')) / 600) * 600)) stored
);

-- Cross-user dedup: one prediction row per shelf per 10-min bucket per model.
create unique index if not exists idx_forecast_predictions_dedup
  on forecast_predictions (item_id, destination, predicted_bucket, model_version);

-- Hot path for the resolver: open predictions for a given shelf.
create index if not exists idx_forecast_predictions_open
  on forecast_predictions (item_id, destination)
  where resolved_at is null and predicted_restock_at is not null;

-- Accuracy aggregation scan window.
create index if not exists idx_forecast_predictions_predicted_at
  on forecast_predictions (predicted_at desc);

alter table forecast_predictions enable row level security;

create policy "Anyone can read forecast predictions"
  on forecast_predictions for select using (true);

create policy "Anyone can insert forecast predictions"
  on forecast_predictions for insert with check (true);

-- No update/delete policies → rows are immutable to clients. Resolution
-- happens through the SECURITY DEFINER trigger below, which bypasses RLS.

-- ── Resolver: close out predictions when a real restock lands ────────
--
-- Fires AFTER INSERT on restock_events. For the (item_id, destination) of
-- the new event, resolve every still-open prediction made at or before the
-- event. Because resolved rows drop out of the `resolved_at is null` set,
-- the NEXT restock only catches predictions made after this one — so each
-- prediction is mapped to the first actual restock that followed it,
-- exactly the quantity we want to score.
--
-- SECURITY DEFINER so the update bypasses forecast_predictions' (read +
-- insert only) RLS regardless of who issued the triggering insert.

create or replace function resolve_forecast_predictions()
returns trigger as $$
begin
  update forecast_predictions p
  set resolved_at        = now(),
      actual_restock_at  = new.restocked_at,
      actual_post_qty    = new.post_qty,
      restock_error_mins = extract(epoch from (new.restocked_at - p.predicted_restock_at)) / 60.0,
      post_qty_error     = new.post_qty - p.predicted_post_qty
  where p.item_id = new.item_id
    and p.destination = new.destination
    and p.resolved_at is null
    and p.predicted_restock_at is not null
    and p.predicted_at <= new.restocked_at;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_resolve_forecast_predictions on restock_events;

create trigger trg_resolve_forecast_predictions
  after insert on restock_events
  for each row execute function resolve_forecast_predictions();

-- ── Extend get_stats_snapshot() with a forecast_accuracy block ───────
--
-- Identical to migration 030 except for the new `forecast_acc` CTE and the
-- `forecast_accuracy` key in the output object. Everything else is carried
-- forward verbatim so this stays a drop-in replacement.

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
  -- Out-of-sample restock-timing accuracy over resolved predictions in the
  -- last 30 days. median_abs is the headline MAE; median_signed exposes
  -- directional bias (positive = systematically predicting restocks too
  -- early); p90_abs is the tail. n_open counts predictions still waiting on
  -- a restock to score them.
  forecast_acc as (
    select
      count(*) filter (where resolved_at is not null)                                    as n_resolved,
      (percentile_cont(0.5) within group (order by abs(restock_error_mins))
         filter (where resolved_at is not null))::numeric(10,1)                          as median_abs_err_min,
      (percentile_cont(0.5) within group (order by restock_error_mins)
         filter (where resolved_at is not null))::numeric(10,1)                          as median_signed_err_min,
      (percentile_cont(0.9) within group (order by abs(restock_error_mins))
         filter (where resolved_at is not null))::numeric(10,1)                          as p90_abs_err_min,
      count(*) filter (where resolved_at is null and predicted_restock_at is not null)   as n_open
    from forecast_predictions
    where predicted_at > now() - interval '30 days'
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
      'n_open',                (select n_open                from forecast_acc)
    )
  );
$$;

grant execute on function get_stats_snapshot() to anon, authenticated;
