-- Add a unique index on yata_snapshots so concurrent recordSnapshots()
-- calls can no longer insert duplicate rows for the same shelf reading.
--
-- Context: recordSnapshots() in src/stock-forecast.js dedups at the
-- application layer by reading the latest (item, destination) row and
-- skipping rows whose quantity/buy_price hasn't changed. That works
-- fine serially, but two users loading the dashboard at once both see
-- "no row since last transition", both run the filter, and both insert
-- the same sample. Over a busy day the table fills with thousands of
-- duplicate-minute rows that contribute zero signal to the depletion
-- fitter and slow every read in loadForecastData().
--
-- Fix mirrors migration 018_restock_events.sql's pattern: a generated
-- stored column rounds snapped_at to the minute, and a unique index on
-- (item_id, destination, snapped_minute) collapses concurrent observers
-- of the same physical shelf state into one row. Client code switches
-- to upsert({ ignoreDuplicates: true }) so the race becomes a no-op
-- instead of a wasted row.
--
-- IMMUTABLE generated-column trick: date_trunc(text, timestamptz) is
-- STABLE (depends on session TZ), but date_trunc(text, timestamp) is
-- IMMUTABLE. Converting to UTC first via `at time zone 'UTC'` drops
-- the tz and keeps the expression IMMUTABLE — same approach 018 uses.
--
-- Run this in the Supabase Dashboard SQL Editor.

-- ── Part 1: purge existing minute-bucket duplicates ─────────────────
-- The unique index can't be created while duplicates exist. Partition
-- by (item_id, destination, minute-bucket) and keep only the first row
-- in each bucket (ordered by snapped_at). ctid targets specific tuples
-- since yata_snapshots has no surrogate key.
with ranked as (
  select
    ctid,
    row_number() over (
      partition by
        item_id,
        destination,
        date_trunc('minute', snapped_at at time zone 'UTC')
      order by snapped_at
    ) as rn
  from yata_snapshots
)
delete from yata_snapshots
where ctid in (select ctid from ranked where rn > 1);

-- ── Part 2: add the generated minute-bucket column ──────────────────
alter table yata_snapshots
  add column if not exists snapped_minute timestamp generated always as
    (date_trunc('minute', snapped_at at time zone 'UTC')) stored;

-- ── Part 3: enforce uniqueness going forward ────────────────────────
create unique index if not exists idx_yata_snapshots_dedup
  on yata_snapshots (item_id, destination, snapped_minute);

-- ── Part 4: make the 025 trigger tolerate the new unique index ──────
-- The trigger from migration 025 does a plain INSERT into yata_snapshots.
-- With the minute-bucket index in place, two scrapes of the same shelf
-- within the same minute now collide. Re-define the function with
-- ON CONFLICT DO NOTHING so a collision is a silent no-op instead of
-- aborting the whole abroad_prices write. If migration 025 hasn't been
-- applied on this DB, `create or replace function` just pre-registers
-- the fixed definition and the later 025 run leaves it in place.
create or replace function emit_snapshot_on_abroad_prices_change()
returns trigger as $$
begin
  if (tg_op = 'INSERT')
     or (tg_op = 'UPDATE' and (
           new.stock is distinct from old.stock
        or new.buy_price is distinct from old.buy_price
     )) then
    insert into yata_snapshots
      (item_id, destination, quantity, buy_price, snapped_at)
    values
      (new.item_id, new.destination, new.stock, new.buy_price, new.observed_at)
    on conflict (item_id, destination, snapped_minute) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer;
