-- Mirror abroad_prices writes into yata_snapshots so every PDA scrape
-- becomes a time-series sample.
--
-- Context: abroad_prices is upsert-on-(item_id, destination). Every PDA
-- scrape overwrites the previous row, so intermediate depletion
-- observations (e.g. a user in Japan hammering refresh and watching
-- Ecstasy go 184 → 170 → 150) are lost — the only long-lived stock
-- value is the latest one. The depletion-slope fitter in
-- stock-forecast.js reads yata_snapshots, which is written only by
-- the web app's recordSnapshots() path (see src/stock-forecast.js).
-- That means any user whose workflow is PDA-only never contributes
-- slope samples: the app silently trusts YATA's slower cadence for
-- depletion even when fresher first-party observations exist.
--
-- This trigger closes the gap. On every INSERT or quantity/price-
-- changing UPDATE of abroad_prices, append a matching row to
-- yata_snapshots stamped with the observer's `observed_at`, not the
-- trigger's clock. One PDA-scrape = one yata_snapshots row, the
-- slope fitter gets a free time-series, and the restock-event
-- trigger from migration 018 continues to fire alongside.
--
-- Dedup: guarded on (new.stock <> old.stock) OR (buy_price distinct)
-- so an identical re-scrape does NOT insert a duplicate row. Matches
-- the "one row per transition" invariant migration 012 cleaned the
-- table down to.
--
-- Trust: SECURITY DEFINER so the trigger bypasses the snapshots insert
-- policy regardless of who wrote the triggering row. Same pattern as
-- migration 018's emit_restock_event_on_abroad_prices_update().

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
      (new.item_id, new.destination, new.stock, new.buy_price, new.observed_at);
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_emit_snapshot on abroad_prices;

create trigger trg_emit_snapshot
  after insert or update on abroad_prices
  for each row execute function emit_snapshot_on_abroad_prices_change();
