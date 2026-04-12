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
| `sell_prices` | Shared cache of item market sell prices (item_id PK). |
| `bazaar_prices` | Crowd-sourced bazaar pool (item_id + bazaar_owner_id composite key, with `miss_count` for pool hygiene). |
| `community_stats` | Single-row spin counter. |

**RPC functions** (granted to anon + authenticated):
- `record_scan(found_deal boolean)` — atomic increment after each scan
- `get_player_count()` — live player count from `player_secrets`

**Dropped (do not recreate):**
- `abroad_prices` — replaced by YATA community API
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
│   ├── styles.css
│   └── data/
│       ├── abroad-items.js      — static destination/type metadata
│       ├── bazaar-watchlist.js  — curated high-value item IDs
│       └── destinations.js      — destination list + flight times
├── supabase/
│   ├── functions/
│   │   ├── torn-proxy/      — Torn API CORS proxy
│   │   ├── set-api-key/     — encrypt + store API key
│   │   ├── auto-login/      — decrypt key for session
│   │   └── _shared/         — cors + crypto helpers
│   └── migrations/
│       ├── 001_initial_schema.sql
│       ├── 002_sell_prices.sql
│       ├── 003_drop_unused_tables.sql
│       ├── 004_bazaar_prices.sql
│       ├── 005_community_stats.sql
│       ├── 006_simplify_stats.sql
│       ├── 007_grant_rpc_functions.sql
│       └── 008_bazaar_miss_count.sql
├── .env
├── vite.config.js
└── .github/
    └── workflows/
        └── deploy.yml
```

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

### Known Limitations
- **Slots** — Auto-detect misses faction perks; user overrides manually.
- **"No listings" items** — Genuinely untradeable collector items;
  re-checked hourly.
- **Category mapping** — Static lookup from `abroad-items.js`. Items not
  in the list show as "other" and are hidden by category filters.

### Supabase Tables (Active)
- `player_secrets` — Encrypted API keys
- `sell_prices` — Cached item market sell prices
- `bazaar_prices` — Crowd-sourced bazaar pool with miss-count hygiene
- `community_stats` — Single-row spin counter

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
- Userscript architecture (DOM scraping on torn.com) — our standalone
  app is simpler for users.
- Restock timing predictions — requires significant data infrastructure.
- Draggable floating panel UX — overcomplicated for a standalone app.
