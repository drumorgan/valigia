-- Valigia — Layer 2 schema prep: fix listing_count range + add observer attribution.
--
-- Part 1 fixes a bug introduced in migration 019. That migration's
-- sell_prices_listing_count_range CHECK required listing_count >= 1, but
-- src/market.js legitimately writes listing_count = 0 for items that have
-- no active Item Market listings ("niche item nobody is selling right
-- now"). Every call to fetchOneSellPrice() for such an item now fails the
-- CHECK and shows a Supabase write toast. Loosen the lower bound to 0.
--
-- Part 2 prepares for Layer 2's edge-function-gated writes on sell_prices
-- and bazaar_prices. Adds a nullable observer_player_id column to both
-- tables so the new ingest-sell-prices / ingest-bazaar-prices functions
-- can stamp the validated Torn player_id onto every write (same pattern
-- as abroad_prices.observer_player_id from migration 013).
--
-- The column stays nullable through Layers 2 and 3 so the existing anon
-- INSERT/UPDATE path (which doesn't know a player_id) can continue to
-- succeed during rollout. Once all callers have switched to the edge
-- functions, a future migration can drop the anon write policies and
-- make the column NOT NULL.
--
-- Run this in the Supabase Dashboard SQL Editor.

-- ── Part 1: fix listing_count range ───────────────────────────
alter table sell_prices drop constraint if exists sell_prices_listing_count_range;
alter table sell_prices
  add constraint sell_prices_listing_count_range
    check (listing_count is null or (listing_count >= 0 and listing_count <= 100000)) not valid;

-- ── Part 2: observer attribution columns ──────────────────────
alter table sell_prices
  add column if not exists observer_player_id integer;

alter table bazaar_prices
  add column if not exists observer_player_id integer;
