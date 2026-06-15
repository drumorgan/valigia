-- Valigia — restock timing debias: capture the pre-restock observation time
--
-- Phase 1 of the forecast-accuracy plan. restock_events.restocked_at is the
-- timestamp of the POST-restock observation — i.e. when a scout first saw
-- the higher quantity. The actual refill happened uniformly somewhere in
-- (pre_observation, post_observation]. With sparse sampling that window can
-- be many minutes wide, so using restocked_at alone systematically dates
-- every restock LATE, which biases the cadence estimator toward predicting
-- restocks later than they really occur.
--
-- Storing the pre-restock observation time lets the client estimator use the
-- midpoint of the censoring interval — the minimum-variance estimate of when
-- the refill actually landed (see estimateNextRestock in
-- src/stock-forecast.js). Legacy rows (and the migration 018 backfill) leave
-- this null and the estimator falls back to restocked_at, so this is a pure
-- additive debias with no breaking change.
--
-- Two writers are updated to populate it going forward:
--   1. The abroad_prices UPDATE trigger (emit_restock_event_on_abroad_prices_update)
--      — old.observed_at is exactly the pre-restock observation.
--   2. The client recordSnapshots() path (src/stock-forecast.js) — the prior
--      snapshot's snapped_at.
--
-- Run this in the Supabase Dashboard SQL Editor after merging.

alter table restock_events
  add column if not exists pre_observed_at timestamptz;

-- Update the abroad_prices restock trigger to stamp the pre-restock
-- observation time. Identical to migration 018's function except for the
-- new column in the insert; ON CONFLICT behaviour is unchanged.
create or replace function emit_restock_event_on_abroad_prices_update()
returns trigger as $$
begin
  if new.stock > old.stock then
    insert into restock_events
      (item_id, destination, restocked_at, pre_observed_at, pre_qty, post_qty, source)
    values
      (new.item_id, new.destination, new.observed_at, old.observed_at, old.stock, new.stock, 'scrape')
    on conflict (item_id, destination, restocked_minute) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer;

-- Trigger binding is unchanged from migration 018 — CREATE OR REPLACE
-- FUNCTION updates the body in place, so no DROP/CREATE TRIGGER needed.
