-- Valigia — score forecast accuracy against the debiased restock time
--
-- Phase 1 follow-on to migration 036. The resolver from migration 035
-- scored predicted_restock_at against restock_events.restocked_at — the
-- POST-restock observation time, which is systematically late (see 036).
--
-- The v2 cadence model debiases its predictions toward the TRUE restock
-- time (the midpoint of the (pre, post] censoring window). If the scorer
-- keeps using the late-biased observation time as ground truth, v2 looks
-- like it "predicts too early" even when it's closer to reality — the
-- harness would reward the worse, late-biased model. That defeats the
-- entire purpose of Phase 0.
--
-- Fix: score against the same midpoint estimate of true restock time that
-- the model targets. The resolving event now carries pre_observed_at
-- (migration 036), so the midpoint is computable inline. Legacy / backfill
-- events with no pre_observed_at fall back to restocked_at, matching the
-- estimator's own fallback. actual_restock_at still records the raw
-- observation for the audit trail; only the scored error uses the midpoint.
--
-- Run this in the Supabase Dashboard SQL Editor after merging.

create or replace function resolve_forecast_predictions()
returns trigger as $$
declare
  -- Best estimate of when the refill actually happened: the midpoint of the
  -- censoring window (pre_observed_at, restocked_at]. Falls back to the raw
  -- observation when the pre-observation time is unknown.
  effective_restock_at timestamptz := coalesce(
    new.pre_observed_at + (new.restocked_at - new.pre_observed_at) / 2,
    new.restocked_at
  );
begin
  update forecast_predictions p
  set resolved_at        = now(),
      actual_restock_at  = new.restocked_at,
      actual_post_qty    = new.post_qty,
      restock_error_mins = extract(epoch from (effective_restock_at - p.predicted_restock_at)) / 60.0,
      post_qty_error     = new.post_qty - p.predicted_post_qty
  where p.item_id = new.item_id
    and p.destination = new.destination
    and p.resolved_at is null
    and p.predicted_restock_at is not null
    and p.predicted_at <= new.restocked_at;
  return new;
end;
$$ language plpgsql security definer;

-- Trigger binding is unchanged from migration 035 — CREATE OR REPLACE
-- FUNCTION swaps the body in place.
