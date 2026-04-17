-- Valigia — Layer 1 RLS hardening on the community-write tables.
--
-- Background: the PDA userscript ships publicly at /valigia-ingest.user.js
-- and exposes the Supabase URL + anon key. Today's RLS lets anyone on the
-- internet write arbitrary rows into five tables:
--
--   sell_prices      INSERT + UPDATE anon
--   bazaar_prices    INSERT + UPDATE + DELETE anon
--   yata_snapshots   INSERT + DELETE anon
--   restock_events   INSERT anon
--   community_stats  UPDATE anon
--
-- This migration is Layer 1 of a three-layer plan. It needs no app or
-- userscript change — pure DB hardening:
--
--   1. Narrow DELETE policies with USING clauses so anon can only delete
--      rows matching the legitimate prune pattern the app already uses.
--   2. Drop the anon UPDATE policy on community_stats — record_scan() is
--      SECURITY DEFINER so the RPC bypasses RLS and is the only real
--      write path. No caller in src/ hits community_stats.update().
--   3. Add CHECK constraints clamping numeric columns to sane ranges so
--      outright-bogus values ($-1 B, 2 B qty, negative miss_count, etc.)
--      get rejected at the Postgres layer regardless of who's writing.
--
-- Layer 2 (key-validated edge-function writes + observer attribution) and
-- Layer 3 (soft per-player rate limits) are separate change sets.
--
-- All CHECK constraints are added NOT VALID: future inserts/updates enforce
-- them, but Postgres does NOT validate pre-existing rows. That keeps the
-- migration safe to run against live data. Once we've spot-checked, any
-- constraint can be promoted with ALTER TABLE ... VALIDATE CONSTRAINT.
--
-- Ranges chosen with headroom over every plausible Torn value:
--   prices      $1 … $100 B   (real ceiling today ~$7 B for top armor)
--   quantities  0 … 100 000    (biggest observed stack ~5 k)
--   miss_count  0 … 10         (scanner caps at MAX_MISS_COUNT = 3)
--
-- Run this in the Supabase Dashboard SQL Editor.

-- ─────────────────────────────────────────────────────────────
-- 1. Narrow DELETE policies
-- ─────────────────────────────────────────────────────────────

-- bazaar_prices: anon can only delete rows the scanner would prune anyway.
-- MAX_MISS_COUNT in src/bazaar-scanner.js is 3. Rows with miss_count >= 3
-- are legitimately prunable; anything below is active pool data an attacker
-- shouldn't be able to wipe.
drop policy if exists "Anyone can delete bazaar prices" on bazaar_prices;
create policy "Anyone can delete stale bazaar prices"
  on bazaar_prices for delete
  using (miss_count >= 3);

-- yata_snapshots: anon can only delete rows well past the read horizon.
-- stock-forecast.js reads ~4 h of history and prunes ~4 h old; a 12 h
-- guard leaves plenty of margin before anything becomes deletable.
drop policy if exists "Anyone can delete stale yata snapshots" on yata_snapshots;
create policy "Anyone can delete stale yata snapshots"
  on yata_snapshots for delete
  using (snapped_at < now() - interval '12 hours');

-- ─────────────────────────────────────────────────────────────
-- 2. Drop anon UPDATE on community_stats
-- ─────────────────────────────────────────────────────────────

-- No caller in src/ or supabase/functions/ hits community_stats.update()
-- directly — every scan writes via record_scan() RPC which is SECURITY
-- DEFINER and bypasses RLS. Dropping this policy removes the trivial
-- "anyone can reset total_spins" vector at zero code cost.
drop policy if exists "Anyone can update community stats" on community_stats;

-- ─────────────────────────────────────────────────────────────
-- 3. CHECK constraints on numeric columns
-- ─────────────────────────────────────────────────────────────

alter table sell_prices
  add constraint sell_prices_price_range
    check (price is null or (price >= 1 and price <= 100000000000)) not valid,
  add constraint sell_prices_floor_qty_range
    check (floor_qty is null or (floor_qty >= 1 and floor_qty <= 100000)) not valid,
  add constraint sell_prices_listing_count_range
    check (listing_count is null or (listing_count >= 1 and listing_count <= 100000)) not valid;

alter table bazaar_prices
  add constraint bazaar_prices_price_range
    check (price is null or (price >= 1 and price <= 100000000000)) not valid,
  add constraint bazaar_prices_quantity_range
    check (quantity is null or (quantity >= 1 and quantity <= 100000)) not valid,
  add constraint bazaar_prices_miss_count_range
    check (miss_count >= 0 and miss_count <= 10) not valid;

alter table yata_snapshots
  add constraint yata_snapshots_quantity_range
    check (quantity >= 0 and quantity <= 1000000) not valid,
  add constraint yata_snapshots_buy_price_range
    check (buy_price is null or (buy_price >= 0 and buy_price <= 100000000000)) not valid;

alter table restock_events
  add constraint restock_events_pre_qty_range
    check (pre_qty >= 0 and pre_qty <= 1000000) not valid,
  add constraint restock_events_post_qty_range
    check (post_qty >= 0 and post_qty <= 1000000) not valid,
  add constraint restock_events_post_gt_pre
    check (post_qty > pre_qty) not valid,
  add constraint restock_events_source_valid
    check (source in ('snapshot','scrape','backfill')) not valid;

alter table community_stats
  add constraint community_stats_total_spins_nonneg
    check (total_spins >= 0) not valid;
