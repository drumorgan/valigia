-- Promote sell_prices.price and bazaar_prices.price from integer to bigint.
--
-- Same problem migration 010 solved for yata_snapshots.buy_price, now hitting
-- the community price caches from the PDA userscript's Item Market and
-- Bazaar runners. High-value items routinely sit above Postgres's int4 max
-- of 2,147,483,647:
--
--   - Cars on the Item Market: Echo S3 @ $3,500,000,000
--   - Armor in bazaars:        EOD Pants @ $6,850,000,000
--                              Sentinel Apron @ $5,840,000,000
--                              Vanguard Body @ $4,300,000,000
--
-- PostgREST surfaces the overflow as HTTP 400 ("value out of range for type
-- integer"), which fails the entire batch upsert — so a single car listing
-- kills the scrape of an otherwise-fine Cars page, and a single high-tier
-- armor listing kills the whole bazaar scrape. The userscript toasts the
-- failure as "market upsert failed - HTTP 400" / "bazaar upsert failed -
-- HTTP 400".
--
-- bigint (int8) tops out around 9.2 * 10^18 — future-proof for any
-- realistic Torn price, at a negligible 4-byte-per-row cost.
--
-- Run this in the Supabase Dashboard SQL Editor after merging.

alter table sell_prices
  alter column price type bigint;

alter table bazaar_prices
  alter column price type bigint;
