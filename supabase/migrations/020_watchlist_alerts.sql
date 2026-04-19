-- watchlist_alerts — per-player price-drop watchlist.
--
-- Users pin items they want to buy at/under a target price. On every
-- dashboard load the client cross-references their rows against the three
-- live price pools (sell_prices, bazaar_prices, abroad_prices) and renders
-- a "Matches" card above the travel table, plus a dedicated Watchlist tab.
--
-- Trust model: player_id is a public Torn identifier, so we CAN'T let anon
-- writes land directly (anyone could add/delete anyone else's alerts).
-- Writes flow exclusively through the `watchlist` edge function, which
-- validates {player_id, session_token} against player_secrets the same way
-- auto-login does, then does a service-role upsert/delete. Service role
-- bypasses RLS, so no insert/update/delete policies are needed.
--
-- Reads are public: the rows contain no secrets (just player_id, item_id,
-- max_price, venues). Making reads public lets the client skip an extra
-- round-trip through the edge function on every dashboard load — one of
-- the bigger wins is being able to show matches without waiting on a
-- server fetch.

create table watchlist_alerts (
  player_id   integer not null,
  item_id     integer not null,
  max_price   bigint  not null check (max_price > 0),
  venues      text[]  not null default array['market','bazaar','abroad']::text[],
  created_at  timestamptz not null default now(),
  primary key (player_id, item_id)
);

-- Hot path: "give me all alerts for player X" — one query per dashboard load.
create index idx_watchlist_alerts_player on watchlist_alerts (player_id);

-- Matching path: when we later want server-side aggregation across items
-- (e.g. "how many players watch item Y"), an item_id index is cheap now.
create index idx_watchlist_alerts_item on watchlist_alerts (item_id);

alter table watchlist_alerts enable row level security;

-- Public read only. Writes are service-role via the watchlist edge fn.
create policy "Anyone can read watchlist alerts"
  on watchlist_alerts for select using (true);
