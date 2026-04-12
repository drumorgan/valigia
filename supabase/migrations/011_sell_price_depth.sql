-- Market depth columns on sell_prices.
--
-- The v2 itemmarket call we already make returns the full listings array;
-- we've been throwing away everything except the cheapest price. Two extra
-- signals from the same call are cheap to capture and let us reason about
-- liquidity per-item instead of per-category:
--
--   floor_qty      units available at the cheapest listing. If it's 1 and
--                  you're trying to offload 29, only the first unit
--                  actually competes with the floor — the next listing
--                  above sets your effective ceiling.
--   listing_count  total live listings. Higher = deeper queue ahead of
--                  any new listing you make, i.e. slower to clear.
--
-- Both nullable — existing rows backfill to NULL and refresh on next top-up.

alter table sell_prices
  add column if not exists floor_qty     integer,
  add column if not exists listing_count integer;
