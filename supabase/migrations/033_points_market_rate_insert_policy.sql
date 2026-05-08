-- Migration 033 — Add anon INSERT to points_market_rate for POST upsert
--
-- v0.20.x of the PDA userscript wrote to this table via
-- PATCH /rest/v1/points_market_rate?id=eq.1 but PDA's gmRequest
-- implementation drops PATCH requests silently — they don't error
-- client-side, but they never land server-side either. Result: every
-- PDA user's pmarket.php visit updated their own localStorage but
-- the shared Supabase row stayed at the seed (rate=35000,
-- updated_at='1970-01-01').
--
-- Switching the userscript to the standard PostgREST upsert pattern
-- (POST + `Prefer: resolution=merge-duplicates`, the same shape
-- sell_prices / bazaar_prices ingest already use successfully through
-- gmRequest) requires an INSERT policy. The id=1 CHECK constraint
-- still pins the row to a single id; Postgres just sees the request
-- as "INSERT, ON CONFLICT (id) UPDATE", and our existing UPDATE
-- policy handles the actual write path.
--
-- Run this in the Supabase Dashboard SQL Editor.

create policy "Anyone can insert points market rate"
  on points_market_rate for insert with check (true);
