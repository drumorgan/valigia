-- One-time cleanup of duplicate consecutive yata_snapshots rows.
--
-- Until this cleanup, every dashboard load wrote a fresh row for every
-- (item, destination) regardless of whether anything changed. The table
-- accumulated thousands of rows like "(South Africa, item 4, qty=101,
-- price=750)" repeating every few minutes with no information content.
--
-- The app-side dedup in recordSnapshots now prevents NEW duplicates from
-- being written; this migration collapses the historical pile so the
-- table reflects the same "one row per transition" shape going forward.
--
-- Strategy: use LAG() over (item, destination) ordered by snapped_at to
-- find any row whose quantity AND buy_price match the immediately
-- preceding row for the same key. Those are pure re-observations with
-- nothing to contribute to the forecaster. Delete them.
--
-- yata_snapshots has no surrogate key — we rely on ctid (Postgres's
-- internal tuple identifier) to target specific rows for deletion,
-- since natural keys alone aren't unique enough after the bloat.

with duplicates as (
  select
    ctid,
    quantity,
    buy_price,
    lag(quantity)  over w as prev_quantity,
    lag(buy_price) over w as prev_buy_price
  from yata_snapshots
  window w as (partition by item_id, destination order by snapped_at)
)
delete from yata_snapshots
where ctid in (
  select ctid
  from duplicates
  where prev_quantity is not null
    and prev_quantity = quantity
    and (
      (prev_buy_price is null and buy_price is null)
      or prev_buy_price = buy_price
    )
);
