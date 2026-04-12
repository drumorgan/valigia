-- yata_snapshots — rolling short-term history of abroad stock quantities.
-- Each page load writes the current YATA quantity for every (item, country)
-- as a timestamped sample. The forecaster reads recent samples to estimate
-- how fast each shelf is depleting, and projects what stock will remain
-- when a traveler actually arrives (flight time = 20 min … ~3 h one-way).
--
-- Why a dedicated table and not reuse abroad_prices?
--   - abroad_prices was dropped in migration 003; we read YATA live now
--   - We specifically want *history*, not a single "latest" row
--   - The forecaster only needs the last ~4 h, so we prune aggressively

create table if not exists yata_snapshots (
  item_id      integer     not null,
  destination  text        not null,
  quantity     integer     not null,
  buy_price    integer,
  snapped_at   timestamptz not null default now()
);

-- Primary access pattern: "give me recent samples for this (item, destination),
-- newest first" during the history load on each page visit.
create index if not exists idx_yata_snapshots_lookup
  on yata_snapshots (item_id, destination, snapped_at desc);

-- Secondary index for the prune sweep that runs alongside each insert batch.
create index if not exists idx_yata_snapshots_snapped_at
  on yata_snapshots (snapped_at);

alter table yata_snapshots enable row level security;

create policy "Anyone can read yata snapshots"
  on yata_snapshots for select using (true);

create policy "Anyone can insert yata snapshots"
  on yata_snapshots for insert with check (true);

create policy "Anyone can delete stale yata snapshots"
  on yata_snapshots for delete using (true);
