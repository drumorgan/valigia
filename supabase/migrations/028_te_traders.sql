-- TornExchange trader pool — crowd-sourced buy-price offers from the
-- off-Torn community trading board at tornexchange.com.
--
-- TE is a price board where traders publish "I will buy item X at price Y
-- from anyone who brings it." This is a SELL-SIDE opportunity from the
-- viewpoint of a Valigia user who happens to own item X — the best trader
-- pays the most per unit.
--
-- Trust model matches abroad_prices: TE pages are public but scraping needs
-- a server-side fetch (browser CORS + bot UA gating), so writes are
-- service-role only via the `ingest-te-trader` edge function. Reads are
-- public so the dashboard and the PDA userscript can render matches
-- without round-tripping through an auth'd endpoint.
--
-- A "trader" is identified by the slug in their TE profile URL
-- (/prices/{handle}/). That slug is almost always the player's Torn name,
-- so when a known handle logs into Valigia we opportunistically refresh
-- their own prices — a cheap way to keep active traders' pools fresh
-- without a cron.

create table te_traders (
  handle             text primary key,       -- slug from /prices/{handle}/
  torn_player_id     integer,                -- resolved via Torn API (nullable: resolution is best-effort)
  submitted_by       integer not null,       -- Torn player_id of whoever first added them
  submitted_at       timestamptz not null default now(),
  last_scraped_at    timestamptz,
  last_scrape_ok     boolean not null default false,
  last_scrape_error  text,
  consecutive_fails  integer not null default 0,
  item_count         integer not null default 0
);

-- Read path: "refresh the N stalest traders on dashboard load" uses this.
create index idx_te_traders_last_scraped on te_traders (last_scraped_at nulls first);

-- Self-refresh lookup: "does the logged-in player match a known trader?"
-- Name-based because TE URLs are name-slugged. Unique index would be
-- too strict (renames happen, attribution should persist), so plain index.
create index idx_te_traders_player_id on te_traders (torn_player_id) where torn_player_id is not null;

alter table te_traders enable row level security;
create policy "Anyone can read te_traders" on te_traders for select using (true);
-- No insert/update/delete policies → service-role only (edge fn bypasses RLS).


create table te_buy_prices (
  handle      text    not null references te_traders(handle) on delete cascade,
  item_id     integer not null,
  item_name   text    not null,            -- denormalised for fast client rendering
  buy_price   bigint  not null check (buy_price > 0),
  updated_at  timestamptz not null default now(),
  primary key (handle, item_id)
);

-- The hot path: "for item X, who's paying the most?" — this is what the
-- Sell tab runs for every inventory slot. Composite index with descending
-- price lets Postgres answer with an index-only scan.
create index idx_te_buy_prices_item_price on te_buy_prices (item_id, buy_price desc);

alter table te_buy_prices enable row level security;
create policy "Anyone can read te_buy_prices" on te_buy_prices for select using (true);
