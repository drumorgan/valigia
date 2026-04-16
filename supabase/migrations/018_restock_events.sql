-- restock_events — append-only log of observed positive stock deltas.
--
-- Why a dedicated table (vs. re-deriving from yata_snapshots on each read)?
--   - Snapshots get pruned (48 h window), so restocks older than that
--     disappear from cadence estimation forever. A persisted event survives
--     the prune.
--   - abroad_prices uses fresh-wins upserts; the prior stock is OVERWRITTEN
--     on every PDA scrape. Detection has to happen at write time or the
--     delta is lost. A trigger captures it regardless of who wrote the row.
--   - Cadence estimation wants a long history (30 days) but depletion slope
--     only needs a short one (hours). Splitting the storage lets each side
--     pick its own retention without compromise.
--
-- Trust model mirrors yata_snapshots: anon can read and append, but rows are
-- append-only (no update/delete policies). Detection happens in two places:
--   1. Client recordSnapshots() — after the dedup read, any (item,
--      destination) whose new quantity exceeds its prior quantity emits
--      a row with source='snapshot'.
--   2. Database trigger on abroad_prices — any UPDATE whose NEW.stock is
--      greater than OLD.stock emits a row with source='scrape'. Fires on
--      every update unconditionally ("cheap, always correct"): a stale
--      overwrite from days ago still counts as "a restock happened
--      sometime in that gap", and cadence medians smooth out the noise.
--
-- Dedup: a stored generated column rounds restocked_at to the minute, and
-- a unique index on (item_id, destination, restocked_minute) collapses
-- concurrent observers of the same refill into one row. Upserts use
-- ON CONFLICT DO NOTHING — first writer wins, others are idempotent.

create table if not exists restock_events (
  id               bigserial primary key,
  item_id          integer     not null,
  destination      text        not null,
  restocked_at     timestamptz not null,
  pre_qty          integer     not null,
  post_qty         integer     not null,
  observer_count   integer     not null default 1,
  source           text        not null default 'snapshot',
  created_at       timestamptz not null default now(),
  -- Generated stored columns must be IMMUTABLE. date_trunc(text, timestamptz)
  -- is STABLE (depends on session TZ), but date_trunc(text, timestamp) is
  -- IMMUTABLE. Converting to UTC first via `at time zone 'UTC'` drops the
  -- tz, leaves a plain timestamp, and keeps the expression IMMUTABLE.
  restocked_minute timestamp generated always as
    (date_trunc('minute', restocked_at at time zone 'UTC')) stored
);

-- Dedup key. Same (item, destination, minute-bucket) = same physical restock.
create unique index if not exists idx_restock_events_dedup
  on restock_events (item_id, destination, restocked_minute);

-- Hot path: "all restocks for this (item, destination), newest first" —
-- matches the read pattern in loadForecastData().
create index if not exists idx_restock_events_lookup
  on restock_events (item_id, destination, restocked_at desc);

-- Global freshness sweep for admin / future prune jobs.
create index if not exists idx_restock_events_restocked_at
  on restock_events (restocked_at desc);

alter table restock_events enable row level security;

create policy "Anyone can read restock events"
  on restock_events for select using (true);

create policy "Anyone can insert restock events"
  on restock_events for insert with check (true);

-- No update/delete policies → rows are immutable. observer_count is reserved
-- for a future RPC (record_restock_event) that would atomically increment on
-- conflict; for now every row counts for 1. One-sample-per-minute is still
-- the right signal for cadence estimation.

-- ── Trigger: detect restocks on abroad_prices updates ────────────────
--
-- Fires on every UPDATE. If NEW.stock > OLD.stock, emit a restock event
-- timestamped at NEW.observed_at. ON CONFLICT DO NOTHING preserves
-- idempotency if two near-simultaneous scrapes by different observers
-- both cross the threshold for the same physical refill.
--
-- SECURITY DEFINER so the trigger-owned service role bypasses the
-- restock_events insert policy check regardless of who issued the
-- triggering update.

create or replace function emit_restock_event_on_abroad_prices_update()
returns trigger as $$
begin
  if new.stock > old.stock then
    insert into restock_events
      (item_id, destination, restocked_at, pre_qty, post_qty, source)
    values
      (new.item_id, new.destination, new.observed_at, old.stock, new.stock, 'scrape')
    on conflict (item_id, destination, restocked_minute) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_emit_restock_event on abroad_prices;

create trigger trg_emit_restock_event
  after update on abroad_prices
  for each row execute function emit_restock_event_on_abroad_prices_update();

-- ── Backfill from yata_snapshots ─────────────────────────────────────
--
-- Walk the existing snapshot history partitioned by (item_id, destination)
-- ordered by snapped_at and emit one restock_event per positive delta.
-- Buys us ~48 h of pre-launch cadence data at zero observation cost.
-- Idempotent: re-running this migration hits the unique index and does
-- nothing for rows already present.

insert into restock_events
  (item_id, destination, restocked_at, pre_qty, post_qty, source)
select
  item_id,
  destination,
  snapped_at as restocked_at,
  prev_qty   as pre_qty,
  quantity   as post_qty,
  'backfill' as source
from (
  select
    item_id,
    destination,
    quantity,
    snapped_at,
    lag(quantity) over w as prev_qty
  from yata_snapshots
  window w as (partition by item_id, destination order by snapped_at)
) s
where prev_qty is not null
  and quantity > prev_qty
on conflict (item_id, destination, restocked_minute) do nothing;
