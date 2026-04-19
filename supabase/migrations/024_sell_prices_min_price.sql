-- sell_prices.min_price — absolute-floor column for Watchlist alerts.
--
-- sell_prices.price stores the *effective* floor: the cheapest listing
-- with qty >= 2, falling back to the absolute floor only when every
-- listing is single-unit. That's right for the Travel tab, where the
-- math needs a price you could actually buy multiple units at — a
-- single unit at $219,989 sitting atop a wall of $222k 1-unit listings
-- and a $222,504 × 114 stack would massively overstate profit if the
-- player's planning to move 29 items through customs.
--
-- Watchlist alerts have the *opposite* semantic: "ping me the moment
-- any listing drops below my max." A single unit at $219k under a
-- $250k alert is a real buying opportunity even if the next stack
-- sits above the threshold — the user will happily grab the one
-- available unit for profit or personal use. Folding both semantics
-- into one column forced us to pick a losing side.
--
-- New nullable column: the cheapest listing's price, ignoring the
-- qty >= 2 rule. Both writers (src/market.js and the PDA Item Market
-- scraper in valigia-ingest.user.js) populate it from the same listings
-- array they already parse; the Watchlist matcher reads it and falls
-- back to `price` for rows that haven't been refreshed since this
-- migration. Travel ignores it entirely and keeps using `price`.
--
-- Existing rows backfill to NULL and pick up a value on their next
-- refresh, so no data migration is needed — the rollout is purely
-- forward-looking.
--
-- Run this in the Supabase Dashboard SQL Editor after merging.

alter table sell_prices
  add column if not exists min_price bigint;

-- Same range + shape as the existing price CHECK (migration 021
-- rls_hardening). NOT VALID so existing NULL-backfilled rows don't
-- need validation, and future writes enforce it.
alter table sell_prices
  add constraint sell_prices_min_price_range
    check (min_price is null or (min_price >= 1 and min_price <= 100000000000)) not valid;
