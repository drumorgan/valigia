-- Migration 040 — pda_prefs.travel_capacity (shared travel-slot count)
--
-- Until now the player's travel capacity lived in two unconnected places:
--   • web app  — localStorage 'valigia_slots' on valigia.girovagabondo.com
--   • userscript — localStorage 'valigia_pda_slots' on torn.com
-- Two origins, no shared storage, so a capacity the userscript auto-detects
-- off the travel shop page ("purchased X / Y items" → Y) never reached the
-- web table, and a manual web edit never reached the in-game overlays. The
-- two surfaces routinely disagreed (web stuck at the 29 default while the
-- real number was 28).
--
-- pda_prefs is the table both surfaces already share, so capacity rides
-- along with it. travel_capacity is the player's TRUE current max carry
-- (base + suitcases + stocks + perks), i.e. the Y denominator off the shop
-- page — never the quantity actually purchased on a given trip. It tracks
-- the real value in BOTH directions: a real capacity change (29 → 28) is
-- captured, but buying fewer items than the cap never lowers it.
--
-- Nullable so "never detected yet" stays distinguishable from a real value;
-- readers fall back to the perks estimate / default when it's null.
--
-- Trust model is unchanged from migration 034: reads are public anon
-- SELECTs (nothing sensitive in the row), writes flow exclusively through
-- the `pda-prefs` edge function — either {player_id, session_token} from
-- the web or a raw Torn api_key from the userscript. No new RLS policy is
-- required; the existing public-read policy already covers the new column.
--
-- Run this in the Supabase Dashboard SQL Editor.

alter table pda_prefs
  add column if not exists travel_capacity integer;

-- Defensive bound matching the app: Traveling 2.0 Phase 2 range is base 10,
-- max 43 (86 on World Tourism Day). Keeps a fat-fingered or malformed write
-- from poisoning the shared value even if the edge function's check is ever
-- bypassed.
alter table pda_prefs
  add constraint pda_prefs_travel_capacity_range
  check (travel_capacity is null or (travel_capacity >= 10 and travel_capacity <= 86));
