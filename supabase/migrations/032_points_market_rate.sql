-- Migration 032 — Points Market rate (single-row crowd-shared cache)
--
-- Captures the cheapest cash-per-point Points Market listing observed
-- by any Valigia user who visits pmarket.php. Read by the Museum and
-- Bazaar Deals runners to compute museum-set buy thresholds:
--
--   buyUnder = setPoints * (itemMarket / sumSetMarket) * rate * 0.90
--
-- Pattern matches community_stats: single row, id always = 1, anon
-- SELECT + UPDATE. Pre-seeded so anon UPDATE is the only write path
-- needed (no INSERT policy required).
--
-- The Points Market is a single global market in Torn — every player
-- sees the same offers — so there's no per-player attribution to
-- maintain here. Last writer wins; competing writers are all sampling
-- the same source within seconds of each other so the deltas are
-- noise. The CHECK constraint clamps writes to a plausible band so a
-- griefer can't store $1/pt or $1B/pt.
--
-- Run this in the Supabase Dashboard SQL Editor.

create table points_market_rate (
  id          integer primary key default 1 check (id = 1),
  rate        bigint not null,
  updated_at  timestamptz not null default now()
);

alter table points_market_rate
  add constraint points_market_rate_range
    check (rate >= 1000 and rate <= 1000000);

-- Seed the single row. Initial value is a reasonable mid-band guess —
-- the first userscript visit to pmarket.php overwrites it with the
-- live cheapest offer. The 1970-era updated_at ensures consumers
-- treat the seed as stale until a real capture lands.
insert into points_market_rate (id, rate, updated_at)
values (1, 35000, '1970-01-01T00:00:00Z')
on conflict (id) do nothing;

alter table points_market_rate enable row level security;

create policy "Anyone can read points market rate"
  on points_market_rate for select using (true);

-- Anon UPDATE is the legitimate write path. CHECK above gates obviously
-- bogus values; otherwise we accept any user's capture since the global
-- market converges on the same answer regardless of who writes.
create policy "Anyone can update points market rate"
  on points_market_rate for update using (true);
