-- Migration 041 — get_latest_yata_snapshots() RPC
--
-- The web Travel table is fed by a live YATA fetch from the browser, with a
-- per-browser localStorage cache as its only fallback. When YATA blips (or a
-- fresh device has no cache) the table goes blank — even though Supabase holds
-- a current server-side YATA mirror in yata_snapshots, refreshed every 5 min
-- for every destination by the cron-snapshot-yata poller (migration 039).
--
-- This RPC exposes that mirror as a clean "latest reading per (item,
-- destination)" set so the client can fall back to it. yata_snapshots stores
-- only CHANGED rows (the cron skips unchanged shelves), so the latest sample
-- for a stable shelf may be hours old — a plain time-windowed SELECT would
-- miss it. DISTINCT ON returns the newest row per pair regardless of age,
-- across the retained history (pruned to 48 h elsewhere).
--
-- Read-only and side-effect free; granted to anon + authenticated like the
-- other public community reads. buy_price can be null (YATA occasionally omits
-- cost); the client filters those out.
--
-- Run this in the Supabase Dashboard SQL Editor.

create or replace function get_latest_yata_snapshots()
returns table (
  item_id     integer,
  destination text,
  quantity    integer,
  buy_price   integer,
  snapped_at  timestamptz
)
language sql
stable
as $$
  select distinct on (item_id, destination)
    item_id, destination, quantity, buy_price, snapped_at
  from yata_snapshots
  order by item_id, destination, snapped_at desc;
$$;

grant execute on function get_latest_yata_snapshots() to anon, authenticated;
