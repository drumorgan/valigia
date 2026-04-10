# Valigia — Torn City Travel Arbitrage Tool

## Claude Code Kickoff Document

-----

## Deployment & GitHub Workflow

- **Always push changes all the way through**: After committing and pushing
  to a feature branch, create a pull request and merge it to `main` yourself.
  Do not leave changes sitting on a feature branch or ask the user to
  manually create/merge PRs.
- **Use MCP tools** (`mcp__github__create_pull_request` and
  `mcp__github__merge_pull_request`) if available. Fall back to the GitHub
  REST API via `curl` against
  `https://api.github.com/repos/drumorgan/valigia` with `GITHUB_TOKEN`
  only if MCP tools are not loaded in the current session.
- **Never forget the PR step**: Every task that changes code MUST end with:
  commit → push → create PR → merge PR. This is not optional.
- Merging to `main` triggers GitHub Actions → FTP deploy. Skipping the
  merge step means changes never reach the live site.
- **Supabase migrations**: After merging SQL migration files, remind the
  user to run the SQL manually in the Supabase Dashboard SQL Editor, since
  migrations are not auto-applied.

-----

## What This App Does

Valigia is a travel arbitrage calculator for Torn City. Players enter their
Torn API key, and the app:

1. Silently reads their recent abroad purchase log to crowd-source real buy
   prices into Supabase
1. Fetches live item market sell prices from the Torn API
1. Ranks every abroad item by profit margin and profit/hour
1. Shows a clean, up-to-the-minute leaderboard of best runs

No manual input required. The crowd-sourced price table self-updates every
time any user opens the app after a trip.

-----

## Supabase Setup — New Project

Create a brand new Supabase project for this app. Do not reuse Happy Jump
or Tornder credentials.

After creating the project, add to `.env`:

```
VITE_SUPABASE_URL=https://[new-project].supabase.co
VITE_SUPABASE_ANON_KEY=[new-anon-key]
```

The Edge Function needs its own secrets set in the Supabase dashboard under
Project Settings → Edge Functions → Secrets:

```
SUPABASE_URL=https://[new-project].supabase.co
SUPABASE_SERVICE_ROLE_KEY=[service-role-key]
```

Run the `abroad_prices` table SQL (below) in the new project’s SQL editor
before first deploy.

-----

## Tech Stack

- **Vanilla JS ES modules + Vite** — no React, no Vue
- **Supabase** — crowd-sourced abroad prices table + RLS
- **Supabase Edge Function** — Torn API proxy
- **GitHub Actions → FTP → InMotion cPanel** — same deploy pipeline as all
  GiroVagabondo apps
- **Hosted at:** `valigia.girovagabondo.com`

-----

## Critical Constraints

- **iPad only — no browser DevTools.** All errors must surface via
  `showToast()` or visible `<details>` elements. Never `console.log` only.
- **No React.** Vanilla JS only.
- **All Torn API calls go through the Edge Function.** CORS blocks direct
  browser fetch to the Torn API.
- **API key stored in `localStorage`.** Never sent to Supabase, never logged,
  never stored anywhere server-side.

-----

## Torn API — Key Details

**Base URL:** `https://api.torn.com`
**CORS:** Blocked for direct browser fetch. All calls must go through the
`torn-proxy` Edge Function.
**Rate limit:** 100 req/min per key.

**Error handling:** Always check `data.error` on every response. Key codes
to handle explicitly:

- `2` — Invalid key
- `5` — Too many requests
- `10` — Owner in federal jail
- `13` — Key disabled (owner inactive >7 days)
- `16` — Key access level too low

### Calls This App Makes

**1. User identity (on key entry)**

```
user/?selections=basic&key={userKey}
```

Returns `player_id`, `name`, `level`. Confirms key is valid and shows the
player their identity before the app proceeds.

**2. Abroad purchase log (log type 6501)**

```
user/?selections=log&log=6501&from={unix24hrsAgo}&key={userKey}
```

Returns abroad purchase entries for the last 24 hours. Used to silently
upsert crowd-sourced buy prices into Supabase. `from=` is Unix timestamp
in seconds.

Log entry shape:

```json
{
  "123456": {
    "log": 6501,
    "title": "Bought a African Violet from South Africa",
    "timestamp": 1743200000,
    "category": "Travel",
    "data": {
      "item": "African Violet",
      "quantity": 29,
      "cost": 2000
    }
  }
}
```

- `data.item` is the item **name string**, not an ID
- `data.cost` is the **unit price**, not total
- Country is extracted from `title` via: `/from (.+)$/i`

**3. Live item market sell price (one call per item)**

```
market/{itemId}?selections=itemmarket&key={userKey}
```

Returns current listings. Use `listings[0].cost` as the current lowest ask.
Run all ~25-30 of these in parallel with `Promise.allSettled()`. Handle
rejected/empty cases gracefully — show “no listings” in the UI rather than
crashing.

-----

## Edge Function: `torn-proxy`

```typescript
// supabase/functions/torn-proxy/index.ts
import { serve } from 'https://deno.land/std/http/server.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      }
    });
  }

  const { section, id, selections, key, log, from } = await req.json();
  const idSegment = id ? `/${id}` : '';
  let url = `https://api.torn.com/${section}${idSegment}?selections=${selections}&key=${key}`;
  if (log) url += `&log=${log}`;
  if (from) url += `&from=${from}`;

  const tornRes = await fetch(url);
  const data = await tornRes.json();

  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
});
```

Client calls it like:

```js
const res = await fetch(`${SUPABASE_URL}/functions/v1/torn-proxy`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
  },
  body: JSON.stringify({
    section: 'user',
    selections: 'log',
    key: userApiKey,
    log: 6501,
    from: Math.floor((Date.now() - 86400000) / 1000)
  })
});
const data = await res.json();
if (data.error) { showToast(`Torn API error ${data.error.code}`); return; }
```

-----

## Supabase Schema

Run this in the new project’s SQL editor before first deploy:

```sql
create table abroad_prices (
  id           uuid primary key default gen_random_uuid(),
  item_name    text not null,
  item_id      integer not null,
  destination  text not null,
  buy_price    integer not null,
  reported_at  timestamptz not null,
  torn_id      integer,
  unique (item_id, destination)
);

-- Public read
create policy "Anyone can read abroad prices"
  on abroad_prices for select
  using (true);

-- Public insert/upsert
create policy "Anyone can upsert abroad prices"
  on abroad_prices for insert
  with check (true);

create policy "Anyone can update abroad prices"
  on abroad_prices for update
  using (true);

alter table abroad_prices enable row level security;
```

Upsert target is `(item_id, destination)`. On conflict, update `buy_price`
and `reported_at`.

-----

## Static Data: `src/data/abroad-items.js`

**Before first meaningful test run, fill in all `null` item IDs.**
Call `torn/?selections=items&key=YOUR_KEY`, dump the result, and map item
names to IDs. Confirmed IDs: Xanax = 206, LSD = 197.

African Violet appears in both UAE and South Africa — same item, different
destination. The title regex is the source of truth for country on log parse.

Xanax appears in both Japan and South Africa — same item ID (206). The
`abroad_prices` table distinguishes by `destination` column.

```js
export const ABROAD_ITEMS = [
  // ── SOUTH AFRICA (5h 11m / 3h 37m with airstrip) ──
  { itemId: 206,  name: "Xanax",          destination: "South Africa", buyPriceFallback: 750000, flightMins: 311, type: "drug"    },
  { itemId: 197,  name: "LSD",            destination: "South Africa", buyPriceFallback: 35000,  flightMins: 311, type: "drug"    },
  { itemId: null, name: "Smoke Grenade",  destination: "South Africa", buyPriceFallback: 20000,  flightMins: 311, type: "drug"    },
  { itemId: null, name: "Elephant",       destination: "South Africa", buyPriceFallback: 500,    flightMins: 311, type: "plushie" },
  { itemId: null, name: "African Violet", destination: "South Africa", buyPriceFallback: 2000,   flightMins: 311, type: "flower"  },

  // ── UAE (4h 19m / 3h 1m with airstrip) ──
  { itemId: null, name: "Camel",          destination: "UAE",          buyPriceFallback: 3000,   flightMins: 259, type: "plushie" },
  { itemId: null, name: "Lion",           destination: "UAE",          buyPriceFallback: 4000,   flightMins: 259, type: "plushie" },
  { itemId: null, name: "African Violet", destination: "UAE",          buyPriceFallback: 2000,   flightMins: 259, type: "flower"  },

  // ── CHINA (3h 39m / 2h 33m with airstrip) ──
  { itemId: null, name: "Panda",          destination: "China",        buyPriceFallback: 2500,   flightMins: 219, type: "plushie" },
  { itemId: null, name: "Peony",          destination: "China",        buyPriceFallback: 1000,   flightMins: 219, type: "flower"  },
  { itemId: null, name: "Ecstasy",        destination: "China",        buyPriceFallback: 45000,  flightMins: 219, type: "drug"    },

  // ── JAPAN (3h 23m / 2h 22m with airstrip) ──
  { itemId: null, name: "Koi Carp",       destination: "Japan",        buyPriceFallback: 3500,   flightMins: 203, type: "plushie" },
  { itemId: null, name: "Cherry Blossom", destination: "Japan",        buyPriceFallback: 800,    flightMins: 203, type: "flower"  },
  { itemId: 206,  name: "Xanax",          destination: "Japan",        buyPriceFallback: 750000, flightMins: 203, type: "drug"    },

  // ── ARGENTINA (3h 9m / 2h 13m with airstrip) ──
  { itemId: null, name: "Monkey",         destination: "Argentina",    buyPriceFallback: 400,    flightMins: 189, type: "plushie" },
  { itemId: null, name: "Ceibo Flower",   destination: "Argentina",    buyPriceFallback: 600,    flightMins: 189, type: "flower"  },
  { itemId: null, name: "Tear Gas",       destination: "Argentina",    buyPriceFallback: 15000,  flightMins: 189, type: "temp"    },

  // ── SWITZERLAND (2h 49m / 1h 58m with airstrip) ──
  { itemId: null, name: "Flash Grenade",  destination: "Switzerland",  buyPriceFallback: 12000,  flightMins: 169, type: "temp"    },

  // ── UK (2h 32m / 1h 47m with airstrip) ──
  { itemId: null, name: "Nessie",         destination: "UK",           buyPriceFallback: 3000,   flightMins: 152, type: "plushie" },
  { itemId: null, name: "Peony",          destination: "UK",           buyPriceFallback: 1000,   flightMins: 152, type: "flower"  },

  // ── HAWAII (2h 1m / 1h 25m with airstrip) ──
  { itemId: null, name: "Orchid",         destination: "Hawaii",       buyPriceFallback: 800,    flightMins: 121, type: "flower"  },

  // ── CAYMAN ISLANDS (57m / 40m with airstrip) ──
  { itemId: null, name: "Stingray",       destination: "Caymans",      buyPriceFallback: 2000,   flightMins: 57,  type: "plushie" },
  { itemId: null, name: "Orchid",         destination: "Caymans",      buyPriceFallback: 800,    flightMins: 57,  type: "flower"  },

  // ── CANADA (37m / 26m with airstrip) ──
  { itemId: null, name: "Wolverine",      destination: "Canada",       buyPriceFallback: 1500,   flightMins: 37,  type: "plushie" },
  { itemId: null, name: "Trillium",       destination: "Canada",       buyPriceFallback: 600,    flightMins: 37,  type: "flower"  },

  // ── MEXICO (20m / 14m with airstrip) ──
  { itemId: null, name: "Jaguar",         destination: "Mexico",       buyPriceFallback: 1200,   flightMins: 20,  type: "plushie" },
  { itemId: null, name: "Dahlia",         destination: "Mexico",       buyPriceFallback: 500,    flightMins: 20,  type: "flower"  },
];

// Lookup by lowercase name — used when parsing log entries (data.item is a name string)
export const ABROAD_ITEM_BY_NAME = Object.fromEntries(
  ABROAD_ITEMS.map(item => [item.name.toLowerCase(), item])
);
```

-----

## App Flow

### On Load

1. Check `localStorage` for `valigia_api_key`
1. If found: call `user/?selections=basic` to verify — show player name
   in header on success, show key entry screen on error
1. If not found: show key entry screen

### After Key Confirmed

Run both of these concurrently with `Promise.all`:

**Background (silent — no UI feedback unless error):**

- Fetch log type 6501 for last 24h
- For each entry: extract item name, unit cost, country from title regex
- Look up item in `ABROAD_ITEM_BY_NAME` — skip if not found
- Upsert to Supabase `abroad_prices`

**Foreground:**

- Read `abroad_prices` from Supabase for all known items
- Fetch live sell price from `market/{itemId}?selections=itemmarket` for
  all items in parallel via `Promise.allSettled()`
- As each sell price resolves, render/update that row immediately — do not
  wait for all to finish before showing anything

### Price Selection Logic (per item)

```
if (supabase price exists AND reported_at within 4h)             → use it, show "reported X min ago"
if (supabase price exists AND reported_at within 2h, drug/contraband) → use it, show "reported X min ago"
else                                                              → use buyPriceFallback, show "⚠ est." badge
```

Drugs and contraband get the tighter 2-hour staleness window because their
abroad prices fluctuate faster than plushies/flowers.

### Margin Calculations

```
net_sell        = sell_price * 0.95          // 5% item market fee
margin_per_item = net_sell - buy_price
margin_pct      = (margin_per_item / buy_price) * 100
profit_per_run  = margin_per_item * slot_count
round_trip_mins = flightMins * 2             // halve flightMins if airstrip checked
profit_per_hour = (profit_per_run / round_trip_mins) * 60
```

Skip rendering items where `itemId` is still null. Show items where
`margin_per_item <= 0` greyed-out at the bottom rather than hiding them.

-----

## User Controls

All persisted in `localStorage`:

- **Slot count** — number input, default 29, min 5, max 44
- **Has airstrip** — checkbox, default false. When checked, halves all
  `flightMins` values before calculation
- **Sort** — select: Profit/Hour (default) | Profit/Run | Margin %

Controls sit above the table. Any change immediately re-sorts and re-renders
without re-fetching.

-----

## UI Design

**Aesthetic:** Dark cargo terminal. Utilitarian, cinematic, night-mode flight
board. Not a bright dashboard.

**Palette (CSS variables):**

```css
--bg:       #0d0f14;
--surface:  #161a22;
--border:   #252a35;
--accent:   #e8c84a;   /* cargo gold */
--positive: #4ae8a0;   /* profit green */
--warning:  #e8824a;   /* stale amber */
--text:     #c8cdd8;
--muted:    #5a6070;
```

**Typography:** `Syne Mono` (Google Fonts) for all numeric values and item
names. `Syne` for headers and labels. Load both via Google Fonts CDN.

**Table columns:**
`Rank | Item | Destination | Buy Price | Sell Price | Margin $ | Margin % | Profit/Run | Profit/hr | Flight`

- Buy price column: if stale, show amber `⚠ est.` badge inline with a
  tap/hover tooltip: “No recent report — using community average. Open
  the app after your next trip to update.”
- Profit/hr column: primary sort column — accent color, slightly larger
- Flight column: show round-trip e.g. “3h 9m RT”
- Negative margin rows: greyed out, sorted to bottom regardless of sort

**Loading behaviour:**

- While sell prices are fetching, show a shimmer placeholder per row
- Rows populate individually as each `Promise.allSettled` item resolves
- Never block the full table on a single slow or failed item

**Stale price tooltip:**
On the `⚠ est.` badge, show on hover/tap: “No recent report — using community
average. Open the app after your next trip to update.”

-----

## File Structure

```
valigia.girovagabondo.com/
├── index.html
├── src/
│   ├── main.js              — entry, orchestrates load flow
│   ├── auth.js              — key entry, validation, localStorage
│   ├── torn-api.js          — proxy fetch helper
│   ├── market.js            — parallel sell price fetcher
│   ├── log-sync.js          — log 6501 fetch + Supabase upsert
│   ├── supabase.js          — Supabase client init
│   ├── calculator.js        — margin math functions
│   ├── ui.js                — table render, controls, shimmer
│   └── data/
│       └── abroad-items.js  — static item data (fill nulls first)
├── supabase/
│   └── functions/
│       └── torn-proxy/
│           └── index.ts
├── .env
├── vite.config.js
└── .github/
    └── workflows/
        └── deploy.yml
```

-----

## Known Gotchas

1. **Fill null item IDs before meaningful testing.** Call
   `torn/?selections=items&key=YOUR_KEY`, dump the JSON, map all item
   names from `abroad-items.js` to their IDs. Without this, the market
   price fetch calls have nothing to call.
1. **African Violet in UAE and South Africa.** Same item ID, two rows in
   the static data. Log title regex determines country — do not infer
   from item name alone.
1. **Xanax in Japan and South Africa.** Same item ID (206), two rows.
   Same rule — country from title.
1. **Log 6501 may return nothing** if the user hasn’t bought abroad in
   the last 24h. The upsert runs zero times. Fallback prices handle a
   cold Supabase table — no error, no toast.
1. **`Promise.allSettled` for market calls** — some items will have no
   listings. Treat rejected or empty responses as “no listings” and
   display accordingly rather than erroring.
1. **Plushies/flowers post-Aug 2024** are traded for Points, not direct
   cash. The item market price still reflects real trade value — use it
   as-is for v1. Do not attempt Points conversion.
1. **Drug/contraband buy prices fluctuate.** The 2-hour staleness window
   for drugs is intentional and tighter than flowers/plushies.
1. **FTP deploy:** Do NOT exclude `assets/` from FTP sync. Silent failure
   if omitted — confirmed gotcha from Yoink Adventures.
1. **Supabase anon key in client:** Intentional and safe. The
   `abroad_prices` table is public community data with no PII.

-----

## First Steps for Claude Code

1. Create new Supabase project, run the `abroad_prices` SQL, copy env vars
1. Scaffold Vite project
1. Copy `torn-proxy` Edge Function from Tornder, update to accept `log`
   and `from` params as shown in this doc
1. Make a one-off call to `torn/?selections=items` with a real key and
   fill all null `itemId` values in `abroad-items.js`
1. Build `log-sync.js` — call log 6501, parse entries, upsert Supabase
1. Build `market.js` — parallel fetch all sell prices via `Promise.allSettled()`
1. Build `calculator.js` — margin math
1. Build `ui.js` — table with shimmer loading, progressive row population
1. Wire in `main.js`
1. Test end-to-end with a real API key
1. Deploy via GitHub Actions FTP pipeline
