# Valigia — Torn City Travel Arbitrage Tool

## Claude Code Working Document

This doc reflects the app as it actually exists today (April 2026), not the
original kickoff spec. For the pre-rewrite scaffolding history, see the
`archive/pre-rewrite-scaffold` branch on GitHub (do not merge — it predates
the current app entirely).

-----

## Deployment & GitHub Workflow

- **Always push changes all the way through**: After committing and pushing
  to a feature branch, create a pull request and merge it to `main` yourself.
  Do not leave changes sitting on a feature branch or ask the user to
  manually create/merge PRs.
- **Use MCP tools** (`mcp__github__create_pull_request` and
  `mcp__github__merge_pull_request`) — these are loaded in current sessions.
  Fall back to the GitHub REST API via `curl` against
  `https://api.github.com/repos/drumorgan/valigia` with `GITHUB_TOKEN`
  only if MCP tools are not available.
- **Never forget the PR step**: Every task that changes code MUST end with:
  commit → push → create PR → merge PR. This is not optional.
- Merging to `main` triggers GitHub Actions → FTP deploy. Skipping the
  merge step means changes never reach the live site.
- **Exception — archive branches.** Any branch matching `archive/*` is
  historical-only and MUST NOT be PR'd or merged to `main`. The
  PostToolUse push-reminder hook applies to feature branches only —
  ignore it for archive pushes and note why in your response.
- **Supabase migrations**: After merging SQL migration files, remind the
  user to run the SQL manually in the Supabase Dashboard SQL Editor, since
  migrations are not auto-applied.

-----

## What This App Does

Valigia is a travel arbitrage calculator for Torn City. Players log in with
their Torn API key (encrypted server-side, never in the browser after
login), and the app:

1. Pulls live abroad buy prices from the **YATA community API** (no key
   needed, community-sourced)
1. Uses a **shared Supabase cache** of item market sell prices, topped off
   on each visit from the Torn API
1. Ranks every abroad item by profit margin and profit/hour
1. Maintains a **crowd-sourced bazaar pool** in Supabase so every user's
   scans contribute to discovering underpriced bazaar listings for everyone
1. Surfaces the single best current action ("Best Run Right Now") —
   travel run OR verified bazaar deal, whichever has higher profit/hr

-----

## Tech Stack

- **Vanilla JS ES modules + Vite** — no React, no Vue
- **Supabase** — encrypted API keys, shared sell-price cache, bazaar pool,
  community stats
- **Supabase Edge Functions** — `torn-proxy` (API proxy), `set-api-key`
  (encrypt + store), `auto-login` (decrypt for session)
- **YATA API** (`yata.yt`) — abroad buy prices, fetched directly from the
  browser (no CORS issues)
- **GitHub Actions → FTP → InMotion cPanel** — same deploy pipeline as all
  GiroVagabondo apps
- **Hosted at:** `valigia.girovagabondo.com`

-----

## Critical Constraints

- **iPad only — no browser DevTools.** All errors must surface via
  `showToast()` or visible `<details>` elements. Never `console.log` only.
- **No React.** Vanilla JS only.
- **All Torn API calls go through the `torn-proxy` Edge Function.** CORS
  blocks direct browser fetch to the Torn API.
- **API key never in `localStorage` after login.** The raw key flows:
  `user enters key` → `set-api-key` edge function encrypts (AES-256-GCM)
  and stores in `player_secrets` → browser keeps only `player_id`. On
  subsequent calls, `auto-login` decrypts server-side for the session.

-----

## Supabase Schema — Current

All migrations live in `supabase/migrations/` (run manually in the SQL
editor; Supabase does not auto-apply them).

| Table | Purpose |
|---|---|
| `player_secrets` | AES-256-GCM encrypted API keys. Service-role-only. |
| `sell_prices` | Shared cache of item market sell prices (item_id PK). `price` = qty-filtered effective floor (skips 1-unit loss-leaders), used by Travel profit math. `min_price` = absolute cheapest listing regardless of qty, used by the Watchlist matcher so single-unit opportunities below a user's threshold still fire. Written by both the web app and the PDA userscript's Item Market runner. |
| `bazaar_prices` | Crowd-sourced bazaar pool (item_id + bazaar_owner_id composite key, with `miss_count` for pool hygiene). Written by the web-app scanner and the PDA userscript's Bazaar runner. |
| `abroad_prices` | First-party travel-shop observations (item_id + destination composite key). Written ONLY by the `ingest-travel-shop` edge function, which validates the submitting key's `player_id` before upserting. Publicly readable. Resurrected in migration 013 to carry live PDA scrapes. |
| `community_stats` | Single-row spin counter. |
| `yata_snapshots` | Short-term stock-history samples that feed the depletion-slope fitter in `stock-forecast.js`. 48 h prune window. Two writers: the web app's `recordSnapshots()` (merged YATA + scrape on dashboard load) and a DB trigger on `abroad_prices` that mirrors every PDA-scrape change into here too, so a user who only uses PDA still contributes slope samples (migration 025). Concurrent writers are dedupped at the DB level via a unique index on `(item_id, destination, snapped_minute)` where `snapped_minute` rounds `snapped_at` to the minute (migration 026). |
| `restock_events` | Append-only log of observed positive stock deltas. Fed by the client's `recordSnapshots()` and an AFTER-UPDATE trigger on `abroad_prices`. 30-day read window powers restock cadence estimation in `stock-forecast.js`. Migration 018. |
| `watchlist_alerts` | Per-player price-drop watchlist (`player_id + item_id` composite key, `max_price` threshold, `venues` array). Writes go exclusively through the `watchlist` edge function (session-token gated); reads are public. Migration 019. |
| `ingest_rate_limits` | Per-`(player_id, endpoint)` gate enforcing a minimum interval between ingest writes. Service-role only (no RLS policies). The `ingest_rate_check()` RPC does an atomic check-and-set with a row-level `FOR UPDATE` lock, returning `false` if the caller's last write was too recent. Migration 027. |
| `te_traders` | Catalog of TornExchange trader pages we scrape (handle PK, optional `torn_player_id`, `submitted_by`, `last_scraped_at`, `last_scrape_ok`, `consecutive_fails`, `item_count`). Writes via the `ingest-te-trader` edge fn only; reads public. Migration 028. |
| `te_buy_prices` | Per-trader standing buy-offers (`handle + item_id` composite key). `buy_price` is what the trader advertises they'll pay per unit. The Sell tab's inventory matcher picks the highest across all traders per item_id. Migration 028. |

**RPC functions** (granted to anon + authenticated):
- `record_scan(found_deal boolean)` — atomic increment after each scan
- `get_player_count()` — live player count from `player_secrets`

**Dropped (do not recreate):**
- `secret_audit_log` — was write-only, never read

-----

## Torn API — Key Details

**Base URL:** `https://api.torn.com`
**CORS:** Blocked for direct browser fetch — route everything through
`torn-proxy`.
**Rate limit:** 100 req/min per key.

**Error handling:** Always check `data.error`. Key codes to handle:
- `2` — Invalid key
- `5` — Too many requests
- `10` — Owner in federal jail
- `13` — Key disabled (owner inactive >7 days)
- `16` — Key access level too low

### Calls This App Makes

1. **User identity** — `user/?selections=basic` — validates key, returns
   `player_id`, `name`, `level`.
1. **User perks** — `user/?selections=perks` — auto-detects travel slot
   count and airstrip. Silently no-ops if the key lacks perks permission.
1. **Item catalog** — `torn/?selections=items` — one-time resolution of
   item names → IDs via `item-resolver.js`. Cached in `localStorage`.
1. **Item market sell price** — `market/{itemId}?selections=itemmarket` —
   parallel fetches for stale items in `sell_prices`, stale-first ordering.
1. **Bazaar discovery** — `market/{itemId}?selections=bazaar` (v2) — finds
   new bazaar owners stocking a given item.
1. **Bazaar check** — `user/{bazaarId}?selections=bazaar` (v1) — reads an
   actual bazaar's listings + prices.

YATA abroad prices are fetched directly from `yata.yt/api/v1/travel/export/`
in `src/log-sync.js` (filename is legacy — it's the YATA fetcher now, not
Torn log sync).

-----

## App Flow

### On Load

1. `auto-login` edge function attempts key decrypt from `player_secrets`
   using stored `player_id`.
1. If success: show dashboard. If fail: show login screen for key entry.

### After Login (dashboard)

1. **Resolve item IDs** — `item-resolver.js` ensures every `ABROAD_ITEMS`
   entry has a real ID (cached in `localStorage`, one Torn API call per
   browser).
1. **In parallel:** fetch YATA abroad prices AND detect player travel
   perks from Torn API.
1. **Render shimmer → table** — once YATA prices arrive, render the full
   table with fallback sell prices; rows fill in as live prices resolve.
1. **Top off `sell_prices` cache** — `market.js` picks stale items
   (cached price desc, ~15/visit), fetches fresh market prices in
   parallel via `Promise.allSettled`, writes back to Supabase for
   everyone. Each row updates individually as prices resolve.
1. **Bazaar pre-scan (background)** — `prescanBazaarPool(playerId)` runs
   a small refresh of the bazaar pool (~8 API calls), then
   `findBestBazaarRun(playerId)` picks the best verified deal.
1. **"Best Run Right Now" card** — compares the top travel run against
   the verified bazaar deal by profit/hr and displays whichever wins
   (green accent for bazaar, gold for travel).

### Bazaar Scan (on-demand via scan button)

See `src/bazaar-scanner.js` for the full flow. Four phases:

1. **FREE** — read `sell_prices` and known bazaar sources from Supabase.
1. **DISCOVER** (~8 API calls) — rank items by `(marketPrice / (sourceCount + 1))`
   with jitter, call v2 `market/{id}/bazaar` to find new bazaar owners.
1. **CHECK** (~25 API calls) — check bazaars (least-recently-checked
   first), v1 `user/{id}/bazaar` for actual prices.
1. **WRITE BACK** — upsert hits (resets `miss_count`), increment
   `miss_count` on misses, prune at `MAX_MISS_COUNT = 3`.

Dynamic watchlist extension: any item in `sell_prices` with price ≥
`$50K` auto-joins the watchlist (capped at 150). Deal selection uses
weighted random on `savings × savingsPct`.

### Price Selection Logic

- **Buy prices** — live from YATA on every page load. No staleness logic
  because YATA updates frequently and we re-fetch every visit.
- **Sell prices** — use Supabase cache. Price is considered "fresh" if
  `updated_at` is recent; stale items go to the top of the refresh
  queue each visit.
- **Bazaar pool** — only pool entries with `checked_at` within the last
  10 minutes are eligible for "Best Run Right Now" candidacy, and the
  winner is re-verified with a fresh market fetch before claiming the
  card.

### Margin Calculations

```
net_sell         = sell_price * 0.95           // 5% item market fee
margin_per_item  = net_sell - buy_price
margin_pct       = (margin_per_item / buy_price) * 100
effective_slots  = min(slot_count, yata_stock) // stock-limited flag if clamped
run_cost         = buy_price * effective_slots
profit_per_run   = margin_per_item * effective_slots
round_trip_mins  = flightMins * 2              // halve flightMins if airstrip
profit_per_hour  = (profit_per_run / round_trip_mins) * 60
```

Bazaar profit/hr uses a nominal 5-minute transaction time, letting
time-limited bazaar deals correctly dominate multi-hour travel runs
when the savings warrant it.

-----

## User Controls

All persisted in `localStorage`:

- **Slot count** — number input, default 29, min 5, max 44. Auto-detect
  from perks misses faction perks, so the user can override manually.
- **Flight type** — dropdown: Standard (default) | Airstrip. Auto-detected
  from perks, manually overridable.
- **Destination filter** — dropdown: All | one specific country.
- **Category filter** — chip buttons: All | Drugs | Plushies | Flowers.
  Uses the static `type` field from `abroad-items.js`. Items not in the
  list are hidden by category filters.
- **Sort** — click any column header. Default: Profit/hr desc. Negative
  margins always sink to bottom, "no listings" separated beneath.

Controls sit above the table. Any change immediately re-sorts and
re-renders without re-fetching.

-----

## UI Design

**Aesthetic:** Dark cargo terminal. Utilitarian, cinematic, night-mode flight
board. Not a bright dashboard.

**Palette (CSS variables):**

```css
--bg:       #0d0f14;
--surface:  #161a22;
--border:   #252a35;
--accent:   #e8c84a;   /* cargo gold — travel winner */
--positive: #4ae8a0;   /* profit green — bazaar winner */
--warning:  #e8824a;   /* stale amber */
--text:     #c8cdd8;
--muted:    #5a6070;
```

**Typography:** `Syne Mono` (Google Fonts) for all numeric values and item
names. `Syne` for headers and labels. Load both via Google Fonts CDN.

**Table columns:**
`Rank | Item | Destination | Stock | Buy Price | Sell Price | Margin $ | Margin % | Run Cost | Profit/Run | Profit/hr | Flight`

- Profit/hr column: primary sort column — accent color, slightly larger
- Flight column: round-trip e.g. "3h 9m RT"
- Stock column: YATA stock quantity; stock-limited runs show a badge
- Negative margin rows: greyed out, sorted to bottom regardless of sort

**Best Run Right Now card:**
- Travel variant: gold `--accent` styling
- Bazaar variant: green `--positive` styling with "VERIFIED DEAL" badge
  and a direct CTA to the bazaar owner

**Loading behaviour:**
- Shimmer placeholders while sell prices refresh
- Rows populate individually as each `Promise.allSettled` resolves
- Never block the full table on a single slow or failed item

-----

## File Structure

```
valigia.girovagabondo.com/
├── index.html
├── src/
│   ├── main.js              — entry, orchestrates dashboard load flow
│   ├── auth.js              — login/logout, calls set-api-key + auto-login
│   ├── torn-api.js          — torn-proxy fetch helper
│   ├── market.js            — parallel sell-price fetcher, stale-first
│   ├── log-sync.js          — YATA abroad-price fetcher (legacy filename)
│   ├── item-resolver.js     — one-time Torn items catalog → id map
│   ├── supabase.js          — Supabase client init
│   ├── calculator.js        — margin math, stock-limited effective slots
│   ├── ui.js                — table, controls, shimmer, Best Run card
│   ├── bazaar-scanner.js    — pool maintenance + findBestBazaarRun
│   ├── bazaar-ui.js         — scan button, runners-up, community stats
│   ├── watchlist.js         — alert CRUD + 3-venue match resolver
│   ├── watchlist-ui.js      — Watchlist tab + matches card
│   ├── te-traders.js        — TornExchange trader pool data layer
│   ├── sell-ui.js           — Sell tab (inventory → best TE buyer matcher)
│   ├── styles.css
│   └── data/
│       ├── abroad-items.js      — static destination/type metadata
│       ├── bazaar-watchlist.js  — curated high-value item IDs
│       └── destinations.js      — destination list + flight times
├── public/
│   └── valigia-ingest.user.js  — Torn PDA userscript (see "PDA Userscript" below)
├── supabase/
│   ├── functions/
│   │   ├── torn-proxy/           — Torn API CORS proxy
│   │   ├── set-api-key/          — encrypt + store API key
│   │   ├── auto-login/           — decrypt key for session
│   │   ├── ingest-travel-shop/   — validates PDA userscript travel scrapes, upserts abroad_prices
│   │   ├── watchlist/            — session-gated CRUD on watchlist_alerts
│   │   ├── ingest-te-trader/     — session-gated TornExchange page scraper → te_traders + te_buy_prices
│   │   └── _shared/              — cors + crypto helpers
│   └── migrations/
│       ├── 001_initial_schema.sql
│       ├── 002_sell_prices.sql
│       ├── 003_drop_unused_tables.sql
│       ├── 004_bazaar_prices.sql
│       ├── 005_community_stats.sql
│       ├── 006_simplify_stats.sql
│       ├── 007_grant_rpc_functions.sql
│       ├── 008_bazaar_miss_count.sql
│       ├── 009_yata_snapshots.sql
│       ├── 010_yata_snapshots_bigint.sql
│       ├── 011_sell_price_depth.sql
│       ├── 012_dedup_yata_snapshots.sql
│       ├── 013_abroad_prices.sql
│       ├── 014_session_token.sql
│       ├── 015_pda_scout_count.sql
│       ├── 016_pda_activity.sql
│       ├── 017_price_bigint.sql
│       ├── 018_restock_events.sql
│       ├── 019_pda_activity_log.sql
│       ├── 020_watchlist_alerts.sql
│       ├── 021_rls_hardening.sql
│       ├── 022_layer2_prep.sql
│       ├── 023_fix_prune_policy.sql
│       ├── 024_sell_prices_min_price.sql
│       ├── 025_snapshot_from_abroad_prices.sql
│       ├── 026_yata_snapshots_dedup_index.sql
│       ├── 027_ingest_rate_limits.sql
│       └── 028_te_traders.sql
├── .env
├── vite.config.js
└── .github/
    └── workflows/
        └── deploy.yml
```

-----

## PDA Userscript (`public/valigia-ingest.user.js`)

A single userscript that runs inside Torn PDA across four page types. PDA
substitutes `###PDA-APIKEY###` with the installed user's Torn key at
runtime; the script refuses to run if that placeholder is still literal
(i.e. outside PDA).

The script serves the same file both as the install source and as its own
auto-update source (`@updateURL`/`@downloadURL` point at
`valigia.girovagabondo.com/valigia-ingest.user.js`), so bumping the
`@version` header and deploying is enough to push updates to every
installed PDA.

### Runners (`dispatch()` routes by URL)

| Page match | Runner | Writes to | Via |
|---|---|---|---|
| `page.php?sid=travel*` | `runTravel()` | `abroad_prices` + overlay | `ingest-travel-shop` edge fn (key-validated upsert) |
| `page.php?sid=ItemMarket*` | `runItemMarket()` | `sell_prices` | Direct PostgREST anon upsert |
| `bazaar.php*` | `runBazaar()` | `bazaar_prices` | Direct PostgREST anon upsert |
| `item.php*` | `runItemPage()` | localStorage only (private) | Reads `te_buy_prices` via anon SELECT |

The Items-page runner is a pure-read surface: it scrapes the current category's inventory rows (name + quantity), merges them into a per-player `localStorage` cache so multiple tab visits accumulate across a session, and queries `te_buy_prices` for the highest buy-offer per item_id. A green collapsed **Best Sell Opportunities bar** at the top of the page summarises the rows sorted by total trader-pays. A MutationObserver re-runs the scrape whenever Torn swaps the items list (category tab clicks, search filtering) so the bar grows live as the player browses tabs. Inventory never leaves the player's own browser — this is the workaround for Torn having deprecated the v1 `user/?selections=inventory` selection.

The travel runner also paints a per-row overlay (`Market Price · $margin ·
margin%`) with a green BEST badge on the highest-margin in-stock row.
The Item Market and Bazaar runners additionally inject a collapsed
**Watchlist Matches bar** at the top of the page — styled to match the
Valigia web card (green border, triangle expand, one row per hit with
direct deep-links back into Torn). Hidden entirely when the player has
no matches. Abroad venue is skipped in the userscript banner (a per-page
YATA fetch would add latency for a surface where the user is focused on
Market/Bazaar anyway); the web app remains the matching surface for
abroad. The banner resolves `player_id` via one Torn `user/?selections=basic`
call (routed through `GM_xmlhttpRequest` so PDA's webview CORS doesn't
block it), cached in `localStorage` keyed by a hash of the API key so
it survives key rotation.

The bazaar runner additionally injects a **Bazaar Deals bar** at the
top of the page (same visual language as the Watchlist Matches bar).
For every scraped listing whose bazaar price is below the current Item
Market net-sell (market × 0.95 to account for the 5% sale fee), the
bar lists the item name, bazaar price, market net-sell, and profit
delta, sorted by margin. Every row deep-links to the Item Market
search for that item so a flip is one tap away. Hidden entirely when
there are zero flippable listings. Earlier versions (0.6.2–0.6.9)
tried a per-row overlay inside each tile but Torn's bazaar DOM varied
too much across layouts — the single top bar is the stable replacement.

All three runners use a single shared `rowContainer()` heuristic that
tolerates Torn's migration from `<table>` to div-based layouts.

### Why direct anon upserts for sell / bazaar, but an edge function for travel?

- `sell_prices` and `bazaar_prices` already have anon `INSERT`/`UPDATE`
  RLS policies — the web app writes to them the same way. The userscript
  reuses that existing trust surface, avoiding a Torn API key-validation
  round-trip per page load.
- `abroad_prices` has no anon-write policy by design: it's the only
  table where the row carries `observer_player_id`, and that attribution
  is only meaningful if the edge function validates the submitting key
  against `user/?selections=basic` before writing. Service-role writes
  only, via `ingest-travel-shop`.

### Known limitations

- DOMContentLoaded runs `dispatch()` once on landing. A `hashchange`
  listener re-fires it when the user navigates between items in the
  Item Market's hash-routed SPA (`#/market/view=category&itemID=…`).
  A `lastDispatchedUrl` guard + 400ms debounce collapse rapid nav
  bursts into one scrape. History-API nav (`pushState`/`replaceState`)
  without a hash change is not covered — Torn doesn't currently use
  it on these pages, so it's a hypothetical gap rather than an
  observed one.
- The Item Market and Bazaar scrapers don't yet compute miss-count
  deltas for items that *used* to be in the scraped view but aren't
  anymore. The web-app scanner's next live check handles those.
- DOM scraping is inherently fragile. Every runner supports a `DEBUG`
  flag that draws an on-page debug panel — essential on iPad where
  DevTools aren't available.

-----

## Known Gotchas

1. **African Violet in UAE and South Africa.** Same item ID, two rows in
   `abroad-items.js`. YATA's per-country prices are the source of truth.
1. **Xanax in Japan and South Africa.** Same item ID (206), two rows.
1. **`Promise.allSettled` for market calls** — some items will have no
   listings. Treat rejected or empty responses as "no listings" and
   display accordingly rather than erroring.
1. **Plushies/flowers post-Aug 2024** are traded for Points, not direct
   cash. The item market price still reflects real trade value — use it
   as-is. Do not attempt Points conversion.
1. **Bazaar "too good to be true" listings** — anything with >90%
   savings vs. market is likely a locked/troll listing. Filtered out
   before claiming the Best Run card.
1. **FTP deploy:** Do NOT exclude `assets/` from FTP sync. Silent failure
   if omitted — confirmed gotcha from Yoink Adventures.
1. **Supabase anon key in client:** Intentional and safe. `sell_prices`,
   `bazaar_prices`, and `community_stats` are public community data with
   no PII. `player_secrets` is RLS-locked to service role only.
1. **`log-sync.js` is a legacy name.** It fetches YATA abroad prices,
   not Torn logs. Kept for stability; don't rename without a migration.

-----

## Current State (April 2026)

### What's Working
- **Auth** — AES-256-GCM encrypted API keys, auto-login across sessions
- **Buy prices** — Live from YATA, no key needed
- **Sell prices** — Supabase-backed cache (~200 items), ~15 refreshes
  per visit, shared across all users
- **Profit calculations** — Margin $/%, Run Cost, Profit/Run, Profit/hr,
  stock-limited effective slots
- **Sorting + filters** — Column sort, destination dropdown, category
  chips, negative margins dimmed, "no listings" separated
- **Travel perks** — Auto-detects slots + airstrip (faction perks need
  manual override)
- **Bazaar scanner** — Crowd-sourced pool, discover/check/prune cycle,
  dynamic watchlist extension, weighted-random deal selection, runners-up
  list under top pick
- **Best Run Right Now** — Unified card that compares the top travel run
  against a verified bazaar deal and displays whichever has higher
  profit/hr
- **PDA userscript** — Three-runner ingest pipeline: travel shop scrapes
  (first-party `abroad_prices`), Item Market listings scrapes (direct
  `sell_prices` refresh), and bazaar page scrapes (direct
  `bazaar_prices` pool contribution). Travel page also gets an in-game
  per-row profit overlay.
- **Watchlist alerts** — Per-player price-drop watchlist scoped to one or
  more venues (Item Market, crowd-sourced bazaars, first-party abroad
  scrapes). On login the dashboard cross-references every alert against
  the three price pools and surfaces hits two ways: a compact "Watchlist
  matches" card above the Travel table, and a dedicated **Watchlist**
  tab with an add-alert form + full match list. Writes flow through the
  session-gated `watchlist` edge function; reads are public. No push or
  email alerts yet — matches only appear on page load.
- **Sell tab (TornExchange)** — Submit any TornExchange trader page
  (full URL, bare handle, or numeric Torn player id) and the
  `ingest-te-trader` edge function scrapes their standing buy-offers
  with a desktop UA. Prices land in `te_buy_prices`; the submitting
  player is attributed via `te_traders.submitted_by`. The Sell tab
  pulls the logged-in player's Torn inventory (`user/?selections=inventory`)
  and for each item shows the best (highest) buy-offer across all
  traders in the pool, sorted by total trader-pays for the full stack.
  Every match row deep-links to the trader's TE page so the user can
  message them in-game. On login, if the player's Torn name or id
  matches a known trader, the backend opportunistically re-scrapes
  their own page (subject to a 15-minute staleness gate) so the pool
  stays fresh for every other Valigia user. The scraper tries three
  parsing strategies (embedded JSON hydration → `<table>` rows →
  loose tag scan) and echoes a `debug_sample` of raw HTML on failure
  for remote iteration. Rate-limited to one scrape per submitter per
  10 s via `ingest_rate_check`.

### Known Limitations
- **Slots** — Auto-detect misses faction perks; user overrides manually.
- **"No listings" items** — Genuinely untradeable collector items;
  re-checked hourly.
- **Category mapping** — Static lookup from `abroad-items.js`. Items not
  in the list show as "other" and are hidden by category filters.

### Supabase Tables (Active)
- `player_secrets` — Encrypted API keys
- `sell_prices` — Cached item market sell prices (web app + PDA Item Market runner)
- `bazaar_prices` — Crowd-sourced bazaar pool with miss-count hygiene (web app + PDA Bazaar runner)
- `abroad_prices` — First-party travel-shop scrapes from PDA (service-role writes via ingest-travel-shop)
- `yata_snapshots` — YATA abroad-price history (fallback data source)
- `community_stats` — Single-row spin counter
- `te_traders` + `te_buy_prices` — TornExchange trader pool (service-role writes via ingest-te-trader)
- `watchlist_alerts` — Per-player price-drop alerts (service-role writes via `watchlist` edge fn)

-----

## Competitive Research: DroqsDB

DroqsDB (droqsdb.com) is a similar Torn travel arbitrage tool with a
Tampermonkey userscript that scrapes live shop data from Torn's travel
pages.

### Features Valigia Has Adopted
- Destination filter dropdown
- Category filter chips (Drugs / Plushies / Flowers)
- Stock quantity display (from YATA)
- Run Cost column (buy price × effective slots)
- Flight type dropdown (Standard / Airstrip)
- **"Best Run Right Now" summary card** — now unified across travel
  AND verified bazaar deals

### Features to Consider Next (Medium Effort)
- **TCS (Torn City Shops) sell venue** — DroqsDB supports Item Market,
  Bazaar, and TCS. We have Item Market + Bazaar-as-buy; TCS-as-sell
  would be a third profit math path.
- **More flight types** — WLT and Business class. Need confirmed
  multipliers before implementing.

### Features to Consider Later (High Effort)
- **Stock-aware recommendations** — Filter out items likely to be out
  of stock on arrival. Requires restock timing data.
- **Historical price trends** — Track sell price changes over time.
  DroqsDB has 30-day charts.
- **DroqsDB public API** — Their `/api/public/v1` exposes stock levels
  and restock estimates. Could supplement YATA.

### What NOT to Copy
- Restock timing predictions — requires significant data infrastructure.
- Draggable floating panel UX — overcomplicated for a standalone app.

*(Historical note: "userscript architecture" used to be on this list. It's
not anymore — we ship `public/valigia-ingest.user.js`, a Torn PDA userscript
that scrapes three page types and pushes to the same Supabase tables the
web app uses. Web app + userscript both benefit from the shared pool.)*
