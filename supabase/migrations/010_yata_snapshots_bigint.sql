-- Promote yata_snapshots.buy_price from integer to bigint.
--
-- YATA occasionally reports absurd buy prices for rare collector variants
-- that share an item_id with a real abroad item (e.g. a "Dozen White Roses"
-- variant priced at $25 billion). Postgres `integer` tops out at ~2.1B, so
-- those rows blew up every snapshot insert with:
--     value "25000000000" is out of range for type integer
-- which silently stopped the entire batch from landing.
--
-- bigint is 8 bytes vs 4 — negligible at our row counts, and it future-proofs
-- against legitimate high-value items (meteorite hits, inflation, etc.).

alter table yata_snapshots
  alter column buy_price type bigint;
