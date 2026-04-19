-- abroad_prices — first-party shop observations from the Torn travel page.
--
-- Resurrects the table dropped in 003. This time it isn't populated by a
-- cache-warmer or the Torn API; it's populated by a PDA userscript that
-- scrapes the shop DOM whenever a player lands abroad, routed through the
-- ingest-travel-shop edge function.
--
-- Trust model: the edge function validates the submitting API key via
-- user/?selections=basic to get a real player_id before writing. For that
-- guarantee to mean anything, only the service role may write here — so
-- RLS allows public reads but no direct inserts from anon/authenticated.
--
-- Fresh-wins conflict resolution: composite PK on (item_id, destination)
-- so a second scrape for the same item in the same country overwrites
-- the previous row. observed_at always reflects the most recent visit.
--
-- An item can legitimately exist in multiple countries (e.g. Xanax in
-- both Japan and South Africa), hence destination is part of the PK
-- rather than a tiebreaker.

-- Defensive: if a previous run of 001 is still live on this database
-- without 003 having been applied (e.g. a dev snapshot restored from
-- pre-rewrite), the old permissive anon INSERT/UPDATE policies from 001
-- would still be attached. Cascade-drop guarantees we start from a
-- clean slate before re-creating the table with service-role-only
-- writes. On the live/normal sequence (001 → 003 → 013) the table
-- is already gone, so this is a harmless no-op.
--
-- ⚠ Re-running this migration on an already-live DB will cascade-drop
-- every trigger attached to abroad_prices. Currently that means
--   - trg_emit_restock_event  (migration 018_restock_events.sql)
--   - trg_emit_snapshot       (migration 023_snapshot_from_abroad_prices.sql)
-- Re-apply both migrations in that order after re-running this one, or
-- the restock-event log and yata_snapshots mirror will stop updating
-- from PDA scrapes (the web app path keeps working either way).
drop table if exists abroad_prices cascade;

create table abroad_prices (
  item_id            integer not null,
  destination        text    not null,
  item_name          text    not null,
  shop_category      text    not null,
  stock              integer not null,
  buy_price          integer not null,
  observer_player_id integer not null,
  observed_at        timestamptz not null default now(),
  primary key (item_id, destination)
);

-- "Give me all items in Switzerland, freshest first" — the hot path for
-- the read-side merge in log-sync.js.
create index idx_abroad_prices_destination_observed
  on abroad_prices (destination, observed_at desc);

-- Global freshness sweep — useful for pruning or admin queries.
create index idx_abroad_prices_observed
  on abroad_prices (observed_at desc);

alter table abroad_prices enable row level security;

-- Public read: every Valigia user (anon or authenticated) benefits from
-- the shared observation pool, same pattern as sell_prices.
create policy "Anyone can read abroad prices"
  on abroad_prices for select using (true);

-- No insert/update/delete policies → only the service role can write,
-- and the service role bypasses RLS entirely. That's exactly what we
-- want: writes flow exclusively through ingest-travel-shop.
