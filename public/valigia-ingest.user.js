// ==UserScript==
// @name         Valigia
// @namespace    https://valigia.girovagabondo.com/
// @version      0.10.1
// @description  Inside Torn PDA, contribute to Valigia's shared price pool from four pages: (1) the travel shop — push fresh abroad buy prices + overlay per-row margins, (2) the Item Market — push fresh sell prices into the community cache, surface your Watchlist matches, and (when filtered to a single item) show the cheapest fresh bazaar listing for that item, (3) any bazaar — push fresh bazaar listings + surface Watchlist matches + a Bazaar Deals bar listing every listing priced below its Item Market floor, (4) your own Items page (item.php) — scrape inventory across category tabs and surface the best TornExchange buy-offer for each stack.
// @author       drumorgan
// @match        https://www.torn.com/page.php?sid=travel*
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @match        https://www.torn.com/bazaar.php*
// @match        https://www.torn.com/item.php*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      vtslzplzlxdptpvxtanz.supabase.co
// @connect      api.torn.com
// @updateURL    https://valigia.girovagabondo.com/valigia-ingest.user.js
// @downloadURL  https://valigia.girovagabondo.com/valigia-ingest.user.js
// ==/UserScript==

(function () {
  'use strict';

  // -- Config --------------------------------------------------------------
  // PDA substitutes ###PDA-APIKEY### with the user's Torn key at runtime.
  // Outside PDA the placeholder stays literal, and the script aborts cleanly.
  const TORN_API_KEY = '###PDA-APIKEY###';

  // Mirror of the @version header above. Not shown in toasts (they should
  // stay short), but kept here so anything needing the version at runtime
  // — future diagnostic panels, log() traces, edge-function telemetry —
  // has a single source to read from. Bump alongside @version.
  const SCRIPT_VERSION = '0.10.1';

  const INGEST_URL =
    'https://vtslzplzlxdptpvxtanz.supabase.co/functions/v1/ingest-travel-shop';
  const INGEST_SELL_URL =
    'https://vtslzplzlxdptpvxtanz.supabase.co/functions/v1/ingest-sell-prices';
  const INGEST_BAZAAR_URL =
    'https://vtslzplzlxdptpvxtanz.supabase.co/functions/v1/ingest-bazaar-prices';
  const ACTIVITY_URL =
    'https://vtslzplzlxdptpvxtanz.supabase.co/functions/v1/record-pda-activity';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0c2x6cGx6bHhkcHRwdnh0YW56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MzQyNTMsImV4cCI6MjA5MTQxMDI1M30.Ddzoq8bCmWc875gbdQKhqnR5M7TraWWj4TYS4RRKkMY';

  // Flip to true to draw an always-on debug panel on the Torn page showing
  // exactly what the parser found. Useful on iPad where DevTools is absent.
  const DEBUG = false;

  // -- Overlay design note -------------------------------------------------
  // The overlay shows PER-ITEM numbers only: Market Price (net of the 5%
  // item-market fee), absolute margin, and margin percent. The value is
  // explicitly labelled "Market Price" so it's unambiguous against Torn's
  // existing "Cost" / "Buy" columns on the shop page — those are what you
  // pay abroad; Market Price is what you'll get listing back home.
  // It deliberately does NOT multiply by slot count. Doing
  // so would require either hardcoding a default (wrong for many players)
  // or syncing the web app's slot preference through Supabase (extra
  // plumbing for a value the player already knows in their head). Ranking
  // within a single shop is identical under a constant flight time whether
  // we sort by margin-per-item or profit/hr, so the BEST badge is still
  // accurate without any slot-count input.

  // Public Supabase PostgREST base. The sell_prices cache is read by the
  // travel-page overlay (anon SELECT, see migration 002_sell_prices.sql) and
  // written by the Item Market / Bazaar ingest runners (anon INSERT+UPDATE,
  // same migration + 004_bazaar_prices.sql). Going direct to PostgREST keeps
  // those two new runners edge-function-free: no Torn API key-validation
  // round-trip on every scrape, matching how the web app already writes to
  // these community-data tables.
  const SUPABASE_REST_URL = 'https://vtslzplzlxdptpvxtanz.supabase.co/rest/v1';
  const SELL_PRICES_URL = SUPABASE_REST_URL + '/sell_prices';
  const BAZAAR_PRICES_URL = SUPABASE_REST_URL + '/bazaar_prices';
  const RESTOCK_EVENTS_URL = SUPABASE_REST_URL + '/restock_events';

  // Known Torn travel shop category names. Used as section anchors: the
  // parser looks for these in visible text to group items by shop.
  const SHOP_CATEGORIES = [
    'General Store',
    'Pharmacy',
    'Arms Dealer',
    'Black Market',
    'Cantina',
    'Tourist Center',
    'Jewelry Store',
    'Souvenir Shop',
    'Drug Store',
    'Food Stand',
    'Farmers Market',
    'Plushie Shop',
    'Flower Shop',
    'Estate Agent',
    'Barber Shop',
  ];

  // -- Utilities -----------------------------------------------------------
  function log(...args) {
    if (DEBUG) {
      try { console.log('[valigia]', ...args); } catch { /* ignore */ }
    }
  }

  function toast(message, kind) {
    const bg = kind === 'error' ? '#b33'
      : kind === 'success' ? '#2a7'
      : kind === 'warning' ? '#e8824a'
      : '#333';
    const el = document.createElement('div');
    el.textContent = 'Valigia: ' + message;
    Object.assign(el.style, {
      position: 'fixed',
      top: '10px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: bg,
      color: '#fff',
      padding: '10px 16px',
      borderRadius: '8px',
      zIndex: '999999',
      font: '600 14px/1.3 sans-serif',
      maxWidth: '90vw',
      boxShadow: '0 4px 16px rgba(0,0,0,.5)',
    });
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }

  function debugPanel(lines) {
    if (!DEBUG) return;
    const existing = document.getElementById('valigia-debug-panel');
    if (existing) existing.remove();
    const el = document.createElement('pre');
    el.id = 'valigia-debug-panel';
    el.textContent = lines.join('\n');
    Object.assign(el.style, {
      position: 'fixed',
      top: '60px',
      right: '10px',
      maxWidth: '45vw',
      maxHeight: '70vh',
      overflow: 'auto',
      background: 'rgba(0,0,0,.85)',
      color: '#9f9',
      padding: '8px',
      borderRadius: '6px',
      zIndex: '999998',
      font: '11px/1.3 ui-monospace, monospace',
      whiteSpace: 'pre-wrap',
    });
    document.body.appendChild(el);
  }

  function parseMoney(text) {
    // "$1,234" / "$1.234" / "1234" -> 1234
    const digits = String(text).replace(/[^\d]/g, '');
    return digits ? Number(digits) : NaN;
  }

  function parseInt10(text) {
    const digits = String(text).replace(/[^\d]/g, '');
    return digits ? Number(digits) : NaN;
  }

  // -- Destination detection -----------------------------------------------
  // Torn's travel page reads: "You are in {Country} and have..."
  function detectDestination() {
    const body = document.body && document.body.innerText || '';
    const m = body.match(/You are in ([A-Z][A-Za-z ]+?) and have/);
    return m ? m[1].trim() : null;
  }

  // -- Shop scraping -------------------------------------------------------
  // Strategy: every shop item row on the travel page contains an <img> whose
  // src matches /images/items/{id}/. We locate each such image, walk up to
  // the nearest row-like ancestor, extract name/stock/price from that row's
  // text, and attribute the row to the nearest preceding heading that looks
  // like a shop category name. This stays robust if Torn shuffles CSS classes.

  function nearestShopCategoryFor(node) {
    // Walk backwards through the DOM to find text that matches a known shop
    // category name. We scan the ancestors' preceding siblings first, then
    // fall back to a full-document text scan.
    let cursor = node;
    while (cursor && cursor !== document.body) {
      let sib = cursor.previousElementSibling;
      while (sib) {
        const txt = (sib.innerText || '').trim();
        for (const cat of SHOP_CATEGORIES) {
          if (txt.includes(cat)) return cat;
        }
        sib = sib.previousElementSibling;
      }
      cursor = cursor.parentElement;
    }
    return 'Unknown';
  }

  function rowContainer(img) {
    // Find the closest ancestor that behaves like a row. We try a few shapes
    // Torn has used: tr, li, div with sibling cells.
    return (
      img.closest('tr') ||
      img.closest('li') ||
      img.closest('[class*="row"]') ||
      img.closest('[class*="Row"]') ||
      (img.parentElement && img.parentElement.parentElement) ||
      img.parentElement
    );
  }

  function parseItemRow(img) {
    const src = img.getAttribute('src') || '';
    const idMatch = src.match(/\/images\/items\/(\d+)\//);
    if (!idMatch) return null;
    const item_id = Number(idMatch[1]);

    const row = rowContainer(img);
    if (!row) return null;

    // The name is usually the alt text on the item image, or the first bit
    // of text in the row. Prefer alt: it's the most stable.
    const altName = (img.getAttribute('alt') || '').trim();
    const rowText = (row.innerText || '').trim();

    let name = altName;
    if (!name) {
      const firstLine = rowText.split('\n')[0] || '';
      name = firstLine.trim();
    }

    // Stock: the row typically shows the stock count as a bare integer, and
    // the price as a $-prefixed number. We grep both from the row text.
    //
    // Example row text: "Hammer\n1,000\n$25" or variations with tabs/spaces.
    const priceMatch = rowText.match(/\$\s*([\d,\.]+)/);
    const buy_price = priceMatch ? parseMoney(priceMatch[1]) : NaN;

    // For stock, strip out the price portion first so its digits don't leak.
    const textWithoutPrice = rowText.replace(/\$\s*[\d,\.]+/g, ' ');
    // Find the largest bare-integer token: stock is almost always >= 1.
    const intTokens = textWithoutPrice.match(/(?<![\w.])\d[\d,]*(?![\w.])/g) || [];
    let stock = NaN;
    for (const tok of intTokens) {
      const n = parseInt10(tok);
      if (Number.isFinite(n) && (Number.isNaN(stock) || n > stock)) stock = n;
    }

    return { item_id: item_id, name: name, stock: stock, buy_price: buy_price };
  }

  function scrapeShops() {
    const imgs = Array.from(document.querySelectorAll('img[src*="/images/items/"]'));
    const shops = new Map();

    for (const img of imgs) {
      const row = rowContainer(img);
      if (!row) continue;
      const category = nearestShopCategoryFor(row);
      const parsed = parseItemRow(img);
      if (!parsed) continue;
      if (!Number.isFinite(parsed.buy_price) || parsed.buy_price <= 0) continue;
      if (!Number.isFinite(parsed.stock) || parsed.stock < 0) continue;
      if (!parsed.name) continue;

      if (!shops.has(category)) shops.set(category, []);
      shops.get(category).push(parsed);
    }

    return Array.from(shops.entries()).map(function (entry) {
      return { category: entry[0], items: entry[1] };
    });
  }

  // -- Network -------------------------------------------------------------
  function gmRequest(opts) {
    // Support both GM_xmlhttpRequest (classic) and GM.xmlHttpRequest (promise-ish).
    return new Promise(function (resolve, reject) {
      const base = {
        method: opts.method || 'POST',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data,
        timeout: 15000,
        onload: function (res) { resolve(res); },
        onerror: function (err) { reject(err); },
        ontimeout: function () { reject(new Error('timeout')); },
      };
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest(base);
      } else if (typeof GM !== 'undefined' && GM.xmlHttpRequest) {
        GM.xmlHttpRequest(base);
      } else {
        reject(new Error('No GM_xmlhttpRequest available - install as userscript in PDA'));
      }
    });
  }

  // Travel-shop ingest POST. Same retry policy as postIngestRows (below):
  // transient failures (network/timeout, HTTP 5xx, 429 rate-limit) get up
  // to two retries with 500ms → 1500ms backoff; permanent 4xx failures
  // (bad key, validation) return immediately so the friendly-error toast
  // fires without delay. Returns the same { ok, count, error, raw } shape
  // that friendlyIngestError() consumes.
  async function postIngest(payload) {
    let lastError = 'unknown';
    let lastRaw = null;
    for (let attempt = 0; attempt < INGEST_MAX_ATTEMPTS; attempt++) {
      let transient = false;
      try {
        const res = await gmRequest({
          method: 'POST',
          url: INGEST_URL,
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          },
          data: JSON.stringify(payload),
        });
        let body = null;
        try { body = JSON.parse(res.responseText); } catch { /* ignore */ }
        if (res.status >= 200 && res.status < 300 && body && body.ok) {
          return { ok: true, count: body.stored ?? 0, body };
        }
        lastError = (body && body.error) || ('HTTP ' + res.status);
        lastRaw = res.responseText;
        if (!isTransientStatus(res.status)) {
          return { ok: false, error: lastError, raw: lastRaw };
        }
        transient = true;
      } catch (err) {
        lastError = (err && err.message) || String(err);
        transient = true;
      }
      if (transient && attempt < INGEST_MAX_ATTEMPTS - 1) {
        log('travel ingest transient failure, retrying', { attempt, error: lastError });
        await sleep(INGEST_BACKOFF_MS[attempt]);
      }
    }
    return { ok: false, error: lastError, raw: lastRaw, retried: true };
  }

  // -- Activity ping -------------------------------------------------------
  // Fires a key-validated heartbeat to record-pda-activity so the Item
  // Market and Bazaar scrapes show up in the scout count alongside travel
  // contributions. Travel's ping is fanned out server-side from
  // ingest-travel-shop, so we don't ping from runTravel().
  //
  // Throttled per page_type via localStorage: each page_type pings at most
  // once per ACTIVITY_PING_WINDOW_MS. The cap keeps the extra Torn API
  // calls (one user/basic validation per ping) off the user's rate budget
  // during long SPA browsing sessions, while still marking them "active"
  // on a rolling 24h window.
  //
  // Fire-and-forget: any failure here is invisible to the user. The scout
  // count is a vanity metric; it must never interrupt the scrape flow.
  const ACTIVITY_PING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const ACTIVITY_PING_STORAGE_KEY = 'valigia_last_activity_ping';

  function loadActivityPingMap() {
    try {
      const raw = localStorage.getItem(ACTIVITY_PING_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) { return {}; }
  }

  function saveActivityPingMap(map) {
    try { localStorage.setItem(ACTIVITY_PING_STORAGE_KEY, JSON.stringify(map)); }
    catch (e) { /* quota or private mode - ignore */ }
  }

  async function pingActivity(pageType) {
    const now = Date.now();
    const map = loadActivityPingMap();
    const last = Number(map[pageType]) || 0;
    if (now - last < ACTIVITY_PING_WINDOW_MS) {
      log('activity ping throttled (' + pageType + ')');
      return;
    }
    // Record the attempt BEFORE firing so a stuck request can't cause
    // every subsequent scrape to re-ping.
    map[pageType] = now;
    saveActivityPingMap(map);

    try {
      await gmRequest({
        method: 'POST',
        url: ACTIVITY_URL,
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        },
        data: JSON.stringify({ api_key: TORN_API_KEY, page_type: pageType }),
      });
    } catch (e) {
      log('activity ping failed (' + pageType + '):', e);
    }
  }

  // -- Sell prices from Supabase -------------------------------------------
  // Single GET against PostgREST with an in.(...) filter pulls every item
  // we see on the shop page in one round trip. sell_prices is anon-readable
  // by design (shared community cache).
  async function fetchSellPrices(itemIds) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) return new Map();
    const idList = itemIds.join(',');
    const url = SELL_PRICES_URL +
      '?select=item_id,price,updated_at' +
      '&item_id=in.(' + idList + ')';
    try {
      const res = await gmRequest({
        method: 'GET',
        url: url,
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Accept': 'application/json',
        },
      });
      if (res.status < 200 || res.status >= 300) return new Map();
      const rows = JSON.parse(res.responseText || '[]');
      const map = new Map();
      for (const r of rows) {
        if (r && typeof r.item_id === 'number' && typeof r.price === 'number') {
          map.set(r.item_id, { price: r.price, updatedAt: r.updated_at || null });
        }
      }
      return map;
    } catch (e) {
      return new Map();
    }
  }

  // -- Restock ETA fetch + estimator --------------------------------------
  // Slim port of stock-forecast.js's estimateNextRestock for the travel
  // overlay: only "expected refill" mins, only for shelves that are
  // currently empty. Falls back silently on any failure — refill ETA is a
  // nice-to-have, never blocks the BEST/margin overlay.
  //
  // Anon SELECT on restock_events is allowed (migration 018). 30-day
  // window matches the web app's RESTOCK_HISTORY_WINDOW_MINS so we
  // estimate from the same data the dashboard uses; 2000-row cap keeps
  // payloads bounded on shelves with very high cadence.
  async function fetchRestockEvents(itemIds, destination) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) return new Map();
    if (!destination) return new Map();
    const cutoffIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const idList = itemIds.join(',');
    const url = RESTOCK_EVENTS_URL +
      '?select=item_id,restocked_at' +
      '&item_id=in.(' + idList + ')' +
      '&destination=eq.' + encodeURIComponent(destination) +
      '&restocked_at=gte.' + encodeURIComponent(cutoffIso) +
      '&order=restocked_at.desc' +
      '&limit=2000';
    try {
      const res = await gmRequest({
        method: 'GET',
        url: url,
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Accept': 'application/json',
        },
      });
      if (res.status < 200 || res.status >= 300) return new Map();
      const rows = JSON.parse(res.responseText || '[]');
      const byItem = new Map();
      for (const r of rows) {
        if (!r || typeof r.item_id !== 'number') continue;
        const t = new Date(r.restocked_at).getTime();
        if (!Number.isFinite(t)) continue;
        let arr = byItem.get(r.item_id);
        if (!arr) { arr = []; byItem.set(r.item_id, arr); }
        arr.push(t);
      }
      return byItem;
    } catch (e) {
      return new Map();
    }
  }

  // Median observed interval minus time-since-last-restock. Mirrors the
  // central calculation in stock-forecast.js (estimateNextRestock) without
  // the confidence/MAD/MAE machinery — the overlay just needs one number.
  // Needs ≥2 events (one interval sample); returns null otherwise.
  function estimateRefillMins(eventTimes, nowMs) {
    if (!Array.isArray(eventTimes) || eventTimes.length < 2) return null;
    const sorted = eventTimes.slice().sort(function (a, b) { return a - b; });
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i] - sorted[i - 1]) / 60000);
    }
    const sortedGaps = gaps.slice().sort(function (a, b) { return a - b; });
    const median = sortedGaps[Math.floor(sortedGaps.length / 2)];
    if (!(median > 0)) return null;
    const lastAt = sorted[sorted.length - 1];
    const sinceLastMins = (nowMs - lastAt) / 60000;
    return Math.max(0, Math.round(median - sinceLastMins));
  }

  function formatRefillEta(mins) {
    if (mins == null) return null;
    if (mins < 1) return 'refill imminent';
    if (mins < 90) return 'refill ~' + Math.round(mins) + 'm';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return m > 0 ? 'refill ~' + h + 'h ' + m + 'm' : 'refill ~' + h + 'h';
  }

  // -- Ingest edge-function post ------------------------------------------
  // Layer 2 security hardening: writes to sell_prices / bazaar_prices flow
  // through ingest-sell-prices / ingest-bazaar-prices. Each validates
  // TORN_API_KEY via user/?selections=basic and stamps observer_player_id
  // onto every row before a service-role upsert. Same pattern as
  // ingest-travel-shop — one extra Torn API round-trip per scrape, paid
  // out of the player's own 100/min budget.
  //
  // Retry policy: iPad cellular drops one request every few minutes. A
  // single flake used to lose the entire scrape. We now retry up to 2
  // times on transient failures — network/timeout errors, HTTP 5xx, and
  // 429 rate limits — with 500ms → 1500ms backoff. 4xx responses (bad
  // key, payload too big, validation error) are NOT retried since they
  // are permanent; retrying would just delay the error toast.
  const INGEST_MAX_ATTEMPTS = 3;
  const INGEST_BACKOFF_MS = [500, 1500];

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function isTransientStatus(status) {
    return status === 429 || (status >= 500 && status < 600);
  }

  async function postIngestRows(ingestUrl, rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: true, count: 0 };
    }
    let lastError = 'unknown';
    let lastRaw = null;
    for (let attempt = 0; attempt < INGEST_MAX_ATTEMPTS; attempt++) {
      let transient = false;
      try {
        const res = await gmRequest({
          method: 'POST',
          url: ingestUrl,
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          },
          data: JSON.stringify({ api_key: TORN_API_KEY, rows: rows }),
        });
        let body = null;
        try { body = JSON.parse(res.responseText); } catch { /* ignore */ }
        if (res.status >= 200 && res.status < 300 && body && body.ok) {
          return { ok: true, count: body.stored ?? rows.length };
        }
        lastError = (body && body.error) || ('HTTP ' + res.status);
        lastRaw = res.responseText;
        if (!isTransientStatus(res.status)) {
          return { ok: false, error: lastError, raw: lastRaw };
        }
        transient = true;
      } catch (err) {
        // Network error, timeout, DNS — all transient from our POV.
        lastError = (err && err.message) || String(err);
        transient = true;
      }
      if (transient && attempt < INGEST_MAX_ATTEMPTS - 1) {
        log('ingest transient failure, retrying', { attempt, error: lastError });
        await sleep(INGEST_BACKOFF_MS[attempt]);
      }
    }
    return { ok: false, error: lastError, raw: lastRaw, retried: true };
  }

  // -- Friendly ingest-error text -----------------------------------------
  // The edge functions echo Torn's literal error wording on a rejected
  // key (e.g. "Torn API rejected key: Incorrect key" for code 2). That's
  // technically accurate but un-actionable on iPad where PDA is the only
  // place the key lives — the user doesn't always realise "the key"
  // means the one they pasted into PDA's Script Manager, not the one
  // stored on Valigia's server. Translate the common failures into a
  // one-line instruction the user can act on without leaving the toast.
  function friendlyIngestError(label, rowCount, result) {
    const raw = (result && result.error) || 'unknown';
    const lower = String(raw).toLowerCase();
    if (lower.indexOf('incorrect key') !== -1 || lower.indexOf('invalid key') !== -1) {
      return label + ': Torn rejected your API key. Update it in PDA Settings \u2192 Script Manager \u2192 Valigia.';
    }
    if (lower.indexOf('access level') !== -1 || lower.indexOf('key access') !== -1) {
      return label + ': API key is missing a permission. Re-create a Custom Key from the Valigia login screen.';
    }
    if (lower.indexOf('rate_limited') !== -1 || lower.indexOf('rate limit') !== -1) {
      return label + ': rate-limited by Valigia \u2014 scrape again in a few seconds.';
    }
    return label + ' (' + rowCount + '): ' + raw;
  }

  // -- Per-item profit math ------------------------------------------------
  // The overlay only displays per-item values, so we only compute them.
  // Net sell is after Torn's 5% item-market fee. Returns null when inputs
  // are missing or non-positive so the renderer can show "no sell data".
  function computeProfit(opts) {
    const buyPrice = opts.buyPrice;
    const sellPrice = opts.sellPrice;

    if (!(sellPrice > 0) || !(buyPrice > 0)) return null;

    const netSell = sellPrice * 0.95;              // 5% item-market fee
    const marginPerItem = netSell - buyPrice;
    const marginPct = (marginPerItem / buyPrice) * 100;

    return {
      netSell: netSell,
      marginPerItem: marginPerItem,
      marginPct: marginPct,
    };
  }

  // -- Formatters ----------------------------------------------------------
  function formatMoney(n) {
    if (n == null || !Number.isFinite(n)) return '-';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(Math.round(n));
    return sign + '$' + abs.toLocaleString('en-US');
  }

  function formatPct(n) {
    if (n == null || !Number.isFinite(n)) return '-';
    return (n >= 0 ? '+' : '') + n.toFixed(0) + '%';
  }

  // -- Style injection -----------------------------------------------------
  // Single <style> tag per page load. Kept minimal in v1; polish later.
  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = [
      '.valigia-cell {',
      '  padding: 4px 8px;',
      '  font: 600 11px/1.3 ui-monospace, monospace;',
      '  color: #c8cdd8;',
      '  background: rgba(22,26,34,0.55);',
      '  border-left: 2px solid #252a35;',
      '  white-space: nowrap;',
      '  vertical-align: middle;',
      '}',
      // When the host row isn't a <tr>, we inject a block-level <div> below
      // the row instead. Give it a touch of top margin so it reads as an
      // annotation of the row above rather than a row of its own.
      'div.valigia-cell {',
      '  display: block;',
      '  margin: 2px 0 6px 44px;',
      '  border-left: 3px solid #252a35;',
      '  border-radius: 2px;',
      '}',
      '.valigia-cell .v-label {',
      '  color: #5a6070;',
      '  font-weight: 500;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.04em;',
      '  font-size: 10px;',
      '}',
      '.valigia-cell .v-sell { color: #c8cdd8; }',
      '.valigia-cell .v-margin-pos { color: #4ae8a0; }',
      '.valigia-cell .v-margin-neg { color: #b33; }',
      '.valigia-cell .v-muted { color: #5a6070; font-weight: 400; }',
      '.valigia-cell .v-sep { color: #3a4050; margin: 0 4px; }',
      '.valigia-best .valigia-cell,',
      '.valigia-best > .valigia-cell,',
      '.valigia-best + div.valigia-cell {',
      '  background: rgba(74,232,160,0.14);',
      '  border-left: 3px solid #4ae8a0;',
      '}',
      '.valigia-best-badge {',
      '  display: inline-block;',
      '  background: #4ae8a0;',
      '  color: #0d0f14;',
      '  font-weight: 800;',
      '  letter-spacing: 0.05em;',
      '  padding: 1px 5px;',
      '  border-radius: 3px;',
      '  margin-right: 6px;',
      '  font-size: 10px;',
      '}',
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'valigia-overlay-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // -- Overlay render ------------------------------------------------------
  // For each row we scraped, compute profit and inject a cell at the end of
  // the row showing margin + profit/hr. Mark the top profit/hr row with a
  // BEST badge and a subtle green highlight.
  function renderOverlay(shops, sellPriceMap, refillEtaMap) {
    if (!(refillEtaMap instanceof Map)) refillEtaMap = new Map();
    injectStyles();

    // Flatten every scraped item into a row descriptor with a reference to
    // its DOM row container so we can inject directly. We re-walk the same
    // images we scraped from to find the row — Torn has migrated many pages
    // away from <table>/<tr>, so we use the same flexible rowContainer()
    // helper the scraper uses.
    const allRows = [];
    const imgs = Array.from(document.querySelectorAll('img[src*="/images/items/"]'));
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const idMatch = src.match(/\/images\/items\/(\d+)\//);
      if (!idMatch) continue;
      const item_id = Number(idMatch[1]);

      const row = rowContainer(img);
      if (!row) continue;
      // Skip rows we've already decorated (in case the script fires twice
      // from tab switches inside the same page).
      if (row.classList && row.classList.contains('valigia-decorated')) continue;

      // Find the scraped record for this item_id so we don't re-parse the
      // row ourselves (already done by scrapeShops).
      let buyPrice = null;
      let stock = null;
      for (const sh of shops) {
        for (const it of sh.items) {
          if (it.item_id === item_id) {
            buyPrice = it.buy_price;
            stock = it.stock;
            break;
          }
        }
        if (buyPrice != null) break;
      }
      if (buyPrice == null) continue;

      const sp = sellPriceMap.get(item_id);
      const sellPrice = sp ? sp.price : null;
      const metrics = sellPrice != null
        ? computeProfit({
            buyPrice: buyPrice,
            sellPrice: sellPrice,
          })
        : null;

      allRows.push({
        row: row,
        item_id: item_id,
        buyPrice: buyPrice,
        stock: stock,
        sellPrice: sellPrice,
        metrics: metrics,
      });
    }

    // Rank by per-item margin - within a single shop page the flight time
    // and slot count are constants, so ranking by margin-per-item is
    // equivalent to ranking by profit/hr. No slot count needed here.
    // Only rows with positive margin and non-zero stock are eligible.
    let best = null;
    for (const r of allRows) {
      if (!r.metrics) continue;
      if (r.metrics.marginPerItem <= 0) continue;
      if (r.stock != null && r.stock <= 0) continue;
      if (!best || r.metrics.marginPerItem > best.metrics.marginPerItem) best = r;
    }

    // Inject the cell into each row. We show per-item values only:
    // net sell price, absolute margin, margin %. The player does the
    // "times my actual slot count" math in their head, which avoids us
    // needing to know (or sync) their slot preference.
    //
    // If the row is a <tr> we append a matching <td>; otherwise (Torn's
    // newer div-based shop grid) we insert a block <div> right after the
    // row so it reads as an annotation immediately beneath.
    for (const r of allRows) {
      const isTr = r.row.tagName === 'TR';
      const cell = document.createElement(isTr ? 'td' : 'div');
      cell.className = 'valigia-cell';

      if (!r.metrics) {
        if (r.sellPrice == null) {
          cell.innerHTML = '<span class="v-muted">no market price data</span>';
        } else {
          cell.innerHTML = '<span class="v-muted">-</span>';
        }
      } else {
        const m = r.metrics;
        const isBest = (r === best);
        const marginClass = m.marginPerItem >= 0 ? 'v-margin-pos' : 'v-margin-neg';
        const outOfStock = (r.stock != null && r.stock <= 0);

        let html = '';
        if (isBest) html += '<span class="valigia-best-badge">BEST</span>';
        if (outOfStock) {
          const etaMins = refillEtaMap.get(r.item_id);
          const etaText = formatRefillEta(etaMins != null ? etaMins : null);
          if (etaText) {
            html += '<span class="v-muted">stock 0 &middot; ' + etaText + '</span>';
          } else {
            html += '<span class="v-muted">stock 0 &middot; skip</span>';
          }
        } else {
          // Label the number "Market Price" so it's clearly distinct from
          // Torn's existing "Cost" / "Buy" columns on the shop page. The
          // value shown is the net per-unit Item Market sell price (after
          // the 5% market fee) — what the player actually realises per unit.
          html += '<span class="v-label">Market Price</span> ';
          html += '<span class="v-sell">' + formatMoney(m.netSell) + '</span>';
          html += '<span class="v-sep">&middot;</span>';
          html += '<span class="' + marginClass + '">' + formatMoney(m.marginPerItem) + '</span>';
          html += '<span class="v-sep">&middot;</span>';
          html += '<span class="' + marginClass + '">' + formatPct(m.marginPct) + '</span>';
        }
        cell.innerHTML = html;
        if (isBest) r.row.classList.add('valigia-best');
      }

      if (isTr) {
        r.row.appendChild(cell);
      } else {
        // For non-<tr> rows, insert directly after the row so it appears
        // immediately beneath. If the row has no parent (detached), fall
        // back to appending into the row itself.
        if (r.row.parentNode) {
          r.row.parentNode.insertBefore(cell, r.row.nextSibling);
        } else {
          r.row.appendChild(cell);
        }
      }
      if (r.row.classList) r.row.classList.add('valigia-decorated');
    }

    return { total: allRows.length, withMetrics: allRows.filter(r => r.metrics).length, best: best };
  }

  // -- Item Market scraper -------------------------------------------------
  // Every listing card on the modern Item Market has an <img> with the item
  // id in its src and a $-prefixed price somewhere in the same row/card. We
  // group all rows by item_id, pick the lowest price as the floor, count the
  // rows as the listing depth, and upsert that straight into sell_prices.
  //
  // One catch: the same item image appears in navigation / sidebar / search
  // chrome. We skip any row that doesn't contain a $-price so chrome rows
  // don't pollute the listing count.
  // Listings above this qty are almost certainly category-card contamination
  // (the item-browse card shows "$price (circulation)" where circulation is
  // a five/six-figure total-in-game count — NOT a listing size). Popular
  // drugs sit at 60k-240k circulation, so a 10k cap cleanly separates real
  // listings (largest observed ~5k amount) from that noise.
  const MAX_LISTING_QTY = 10000;

  function scrapeItemMarket() {
    const imgs = Array.from(document.querySelectorAll('img[src*="/images/items/"]'));
    const byItem = new Map(); // item_id -> { name, listings: [{price, qty}] }
    const seenRows = new Set();

    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const idMatch = src.match(/\/images\/items\/(\d+)\//);
      if (!idMatch) continue;
      const item_id = Number(idMatch[1]);

      const row = rowContainer(img);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);

      const text = (row.innerText || '').trim();
      const priceMatch = text.match(/\$\s*([\d,\.]+)/);
      if (!priceMatch) continue; // no price in this row => chrome, skip
      const price = parseMoney(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

      // Quantity: first bare integer after removing the price token AND
      // parenthesized numbers. Category-card pages show "$price (circulation)"
      // where the parenthesized number is total items in-game, not a listing
      // quantity. Stripping "(51,422)" etc. lets the qty default to 1 so we
      // still capture the price signal without skewing floor_qty.
      const withoutPrice = text.replace(/\$\s*[\d,\.]+/g, ' ');
      const withoutCirculation = withoutPrice.replace(/\(\s*[\d,]+\s*\)/g, ' ');
      const intTokens = withoutCirculation.match(/(?<![\w.])\d[\d,]*(?![\w.])/g) || [];
      let qty = 1;
      for (const tok of intTokens) {
        const n = parseInt10(tok);
        if (Number.isFinite(n) && n > 0) { qty = n; break; }
      }

      // Safety net: reject listings claiming absurd quantities (likely a
      // scraping artefact we didn't anticipate).
      if (qty > MAX_LISTING_QTY) continue;

      // Item name: prefer the image alt (stable across Torn's UI shuffles);
      // fall back to the first line of the row text.
      const altName = (img.getAttribute('alt') || '').trim();
      const firstLine = (text.split('\n')[0] || '').trim();
      const name = altName || firstLine || '';

      if (!byItem.has(item_id)) byItem.set(item_id, { name: name, listings: [] });
      const entry = byItem.get(item_id);
      if (!entry.name && name) entry.name = name;
      entry.listings.push({ price: price, qty: qty });
    }

    const now = new Date().toISOString();
    const rows = [];
    for (const [item_id, entry] of byItem) {
      const listings = entry.listings;
      if (listings.length === 0) continue;
      listings.sort(function (a, b) { return a.price - b.price; });

      // min_price = absolute floor (cheapest listing, any qty). Feeds
      // the Watchlist matcher: a single-unit $219k listing under a
      // $250k alert is a real buying opportunity even if the next stack
      // sits above the threshold. Travel profit math ignores this and
      // keeps using the qty-filtered effective floor below.
      const minPrice = listings[0].price;

      // Effective floor = first listing with qty >= 2. A single-unit listing
      // at a much lower price is almost always a loss-leader or misclick
      // (see Cannabis case: 1 unit at $10,500 sitting atop 19-unit stacks at
      // $12,900+). Storing the $10,500 as THE sell price overstates profit
      // for any realistic multi-unit travel run. Fall back to the absolute
      // floor when every listing is single-unit (rare items / collector bins).
      let floor = null;
      for (const l of listings) {
        if (l.qty >= 2) { floor = l; break; }
      }
      if (!floor) floor = listings[0];

      rows.push({
        item_id: item_id,
        price: floor.price,
        min_price: minPrice,
        floor_qty: floor.qty,
        listing_count: listings.length,
        updated_at: now,
        // Keep name out of the upsert payload (sell_prices doesn't have a
        // name column), but carry it on the row for the toast to read.
        _name: entry.name,
      });
    }
    return rows;
  }

  async function runItemMarket() {
    // Kick the watchlist-matches banner in parallel with the scrape.
    // Fire-and-forget: any failure is silent so the primary scraper
    // flow isn't blocked on a (potentially slow) Torn key validation.
    injectWatchlistBar();
    // When the player has filtered down to a single item (hash carries
    // itemID=N), surface the cheapest fresh bazaar listing for that
    // item from the shared pool. Silent no-op on the catalog landing
    // view or when the pool has no fresh hit.
    injectLowestPriceBar();

    // Poll briefly for listings to hydrate - the Item Market page is SPA-ish.
    const start = Date.now();
    let rows = [];
    while (Date.now() - start < 8000) {
      rows = scrapeItemMarket();
      if (rows.length > 0) break;
      await new Promise(function (r) { setTimeout(r, 500); });
    }

    if (DEBUG) {
      const lines = ['page=itemmarket', 'items=' + rows.length];
      for (const r of rows.slice(0, 10)) {
        lines.push('  id=' + r.item_id + ' (' + (r._name || '?') + ') $' + r.price +
                   ' x' + r.floor_qty + ' (' + r.listing_count + ' listings)');
      }
      debugPanel(lines);
    }

    if (rows.length === 0) {
      log('Item Market: no listings found, skipping upsert.');
      return;
    }

    const upsertRows = rows.map(function (r) {
      // Drop both the carry-through _name and updated_at — the edge function
      // stamps updated_at server-side, and there's no name column on
      // sell_prices.
      const { _name, updated_at, ...rest } = r;
      return rest;
    });

    const result = await postIngestRows(INGEST_SELL_URL, upsertRows);
    if (result.ok) {
      toast('Item Market: ' + result.count + ' prices', 'success');
      pingActivity('item_market');
    } else {
      toast(friendlyIngestError('Market', upsertRows.length, result), 'error');
    }
  }

  // -- Bazaar scraper ------------------------------------------------------
  // Bazaar URLs look like bazaar.php?userId=123 (legacy) or with step= query
  // strings in the modern layout. We pull the owner id from either the
  // query string or the hash; if neither carries one, we're looking at the
  // player's own bazaar - nothing useful to push to the shared pool there,
  // so bail.
  function detectBazaarOwnerId() {
    try {
      const url = new URL(location.href);
      const qs = url.searchParams;
      const fromQuery = qs.get('userID') || qs.get('userId') || qs.get('user_id');
      if (fromQuery && /^\d+$/.test(fromQuery)) return Number(fromQuery);
    } catch (e) { /* ignore */ }
    // Hash-routed forms: "#/p=bazaar&userId=123" or similar.
    const hash = location.hash || '';
    const hashMatch = hash.match(/user(?:ID|Id|_id)=(\d+)/i);
    if (hashMatch) return Number(hashMatch[1]);
    return null;
  }

  /**
   * Is the tile's item image a padlock glyph?
   *
   * Torn overlays a padlock on bazaar tiles the owner has parked as $1
   * placeholders. Earlier versions tried to sniff class names, aria
   * attributes, and inner text for "lock"/"locked" — but every CSS
   * selector we tried (substring `[class*="lock"]`, word-boundary
   * regex, etc.) either missed tiles or false-positived on common
   * tokens like `block`, `clock`, and `unlocked` that Torn uses
   * liberally. The result was real listings vanishing from the Deals
   * bar AND the bazaar pool.
   *
   * This minimal version only checks the item image's own src for a
   * padlock filename. The $1 price gate at the caller handles every
   * other locked tile — a real bazaar never lists a buyable item at
   * $1, so dropping $1 rows at scrape time is both accurate and
   * DOM-independent.
   */
  function isLockedListing(img) {
    try {
      const imgSrc = img.getAttribute('src') || '';
      return /\/padlock|\/lock[._-]/i.test(imgSrc);
    } catch (_) { return false; }
  }

  function scrapeBazaarItems() {
    const imgs = Array.from(document.querySelectorAll('img[src*="/images/items/"]'));
    const byItem = new Map(); // item_id -> {price, qty} (cheapest only)
    const seenRows = new Set();

    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const idMatch = src.match(/\/images\/items\/(\d+)\//);
      if (!idMatch) continue;
      const item_id = Number(idMatch[1]);

      const row = rowContainer(img);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);

      // Skip tiles whose image is a padlock glyph. The real work is done
      // by the $1 price gate below — a real bazaar never lists a buyable
      // item at $1, so dropping $1 rows is both DOM-independent and the
      // canonical "this is locked" signal.
      if (isLockedListing(img)) continue;

      const text = (row.innerText || '').trim();
      const priceMatch = text.match(/\$\s*([\d,\.]+)/);
      if (!priceMatch) continue;
      const price = parseMoney(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 1) continue;

      const withoutPrice = text.replace(/\$\s*[\d,\.]+/g, ' ');
      const intTokens = withoutPrice.match(/(?<![\w.])\d[\d,]*(?![\w.])/g) || [];
      let qty = 1;
      for (const tok of intTokens) {
        const n = parseInt10(tok);
        if (Number.isFinite(n) && n > 0) { qty = n; break; }
      }

      const existing = byItem.get(item_id);
      if (!existing || price < existing.price) {
        byItem.set(item_id, { price: price, qty: qty });
      }
    }

    return Array.from(byItem.entries()).map(function (entry) {
      return { item_id: entry[0], price: entry[1].price, quantity: entry[1].qty };
    });
  }

  async function runBazaar() {
    // Watchlist banner kicks off in parallel. Even on an own-bazaar visit
    // (no ownerId, early return below) we still want to surface matches
    // — so this runs before the ownerId guard.
    injectWatchlistBar();

    const ownerId = detectBazaarOwnerId();
    if (!ownerId) {
      log('Bazaar: no userId in URL (own bazaar?) - skipping.');
      return;
    }

    // Same hydration poll used on travel + item market.
    const start = Date.now();
    let items = [];
    while (Date.now() - start < 8000) {
      items = scrapeBazaarItems();
      if (items.length > 0) break;
      await new Promise(function (r) { setTimeout(r, 500); });
    }

    if (DEBUG) {
      const lines = ['page=bazaar', 'owner=' + ownerId, 'items=' + items.length];
      for (const it of items.slice(0, 10)) {
        lines.push('  id=' + it.item_id + ' $' + it.price + ' x' + it.quantity);
      }
      debugPanel(lines);
    }

    if (items.length === 0) {
      log('Bazaar: no items visible, skipping upsert.');
      return;
    }

    // Scraping a bazaar page is a definitive hit: we see the listing right
    // now, so miss_count resets to 0. Items that USED to be in this bazaar
    // but aren't in our scrape are left alone - the web-app scanner's
    // miss-count logic catches those on its next live check. checked_at is
    // stamped server-side by the edge function.
    const rows = items.map(function (it) {
      return {
        item_id: it.item_id,
        bazaar_owner_id: ownerId,
        price: it.price,
        quantity: it.quantity,
        miss_count: 0,
      };
    });

    // Surface any flippable listings in a top-of-page bar (mirrors the
    // Watchlist Matches bar's UX). Fire-and-forget: any failure is
    // silent so the primary ingest path is never blocked.
    injectBazaarDealsBar(items).catch(function (e) { log('deals bar error', e); });

    const result = await postIngestRows(INGEST_BAZAAR_URL, rows);
    if (result.ok) {
      toast('Bazaar: ' + result.count + ' prices', 'success');
      pingActivity('bazaar');
    } else {
      toast(friendlyIngestError('Bazaar', rows.length, result), 'error');
    }
  }

  // -- Watchlist matches banner --------------------------------------------
  // A collapsed green bar injected at the top of the Item Market and
  // Bazaar pages that surfaces this player's active Watchlist matches.
  // Tapping the triangle expands it into a Valigia-styled list with
  // direct deep-links back into Torn. Hidden entirely on zero matches.
  //
  // Trust/data path:
  //   1. Resolve player_id once (cached per api_key hash in localStorage)
  //      via a single Torn /user/?selections=basic call.
  //   2. Fetch watchlist_alerts + sell_prices + bazaar_prices via anon
  //      SELECT — all three are public-read, same surface the web app
  //      and existing scrapers already use.
  //   3. Compute matches client-side, mirroring src/watchlist.js. Abroad
  //      venue is skipped here (it'd require a per-page YATA fetch); the
  //      web app remains the surface for abroad matches.
  //
  // Scope: runs only on Market + Bazaar. Travel is intentionally excluded
  // — the travel page already shows abroad prices inline, so a banner
  // would duplicate information the user is actively looking at.

  const WATCHLIST_BAR_ID = 'valigia-watchlist-bar';
  const WATCHLIST_ALERTS_URL = SUPABASE_REST_URL + '/watchlist_alerts';
  const PLAYER_ID_CACHE_KEY = 'valigia_pda_player_id_v1';
  // Torn items catalog cache. The web app maintains its own copy on
  // valigia.girovagabondo.com, but userscript localStorage is scoped to
  // torn.com — we can't share. Cost is one Torn /torn/?selections=items
  // call per player per catalog-TTL, answered by a static dataset.
  const ITEM_CATALOG_CACHE_KEY = 'valigia_item_catalog_v1';
  // Torn rarely changes item names. A 30-day TTL keeps the cache small in
  // terms of refresh pressure; any unknown id at lookup time still falls
  // back to "Item #N" so a stale cache doesn't break the banner.
  const ITEM_CATALOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  // Bazaar rows older than this are dropped — matches the web app's
  // 10-minute threshold so the bar doesn't claim a stale deal.
  const WATCHLIST_BAZAAR_MAX_AGE_MS = 10 * 60 * 1000;

  // Item Market rows older than this are dropped. Mirrors the web
  // app's 1-hour MARKET_MAX_AGE_MS so a stale floor (e.g. someone
  // scraped Gold Noble Coin an hour ago at $1.4M and the listing has
  // long since been bought, leaving a $2.3M real floor) can't
  // masquerade as a current match. The web app force-refreshes every
  // watchlisted item on a 10-minute staleness window on each dashboard
  // load, so a price that still holds will quickly re-appear here.
  const WATCHLIST_MARKET_MAX_AGE_MS = 60 * 60 * 1000;

  // Tiny non-crypto hash of the api_key so we can key the player_id cache
  // by it — lets the cache invalidate automatically when the user swaps
  // to a different Torn API key without leaking the key itself.
  function hashApiKey(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = (h * 31 + key.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  async function resolvePlayerId() {
    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) return null;
    const keyHash = hashApiKey(TORN_API_KEY);
    try {
      const raw = localStorage.getItem(PLAYER_ID_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && cached.hash === keyHash && cached.player_id) {
          return cached.player_id;
        }
      }
    } catch (_) { /* ignore corrupt cache */ }

    // Use GM_xmlhttpRequest (not plain fetch) so PDA's webview CORS
    // behaviour doesn't block the call. api.torn.com is in @connect.
    try {
      const res = await gmRequest({
        method: 'GET',
        url: 'https://api.torn.com/user/?selections=basic&key=' +
             encodeURIComponent(TORN_API_KEY),
        headers: { 'Accept': 'application/json' },
      });
      let data = null;
      try { data = JSON.parse(res.responseText); } catch (_) { /* ignore */ }
      if (data && data.player_id) {
        try {
          localStorage.setItem(
            PLAYER_ID_CACHE_KEY,
            JSON.stringify({ hash: keyHash, player_id: data.player_id })
          );
        } catch (_) { /* ignore quota / disabled storage */ }
        return data.player_id;
      }
      log('resolvePlayerId: unexpected response', res.status, res.responseText);
    } catch (err) {
      log('resolvePlayerId: request failed', err);
    }
    return null;
  }

  async function fetchJSON(url) {
    try {
      const res = await gmRequest({
        method: 'GET',
        url: url,
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Accept': 'application/json',
        },
      });
      if (res.status < 200 || res.status >= 300) {
        log('fetchJSON non-2xx', res.status, url);
        return null;
      }
      try { return JSON.parse(res.responseText); } catch (_) { return null; }
    } catch (err) {
      log('fetchJSON failed', err, url);
      return null;
    }
  }

  /**
   * Read alerts for this player, then look up live market/bazaar prices
   * for the alerted items and compute the match list. Returns [] on any
  /**
   * Fetch + shape this player's watchlist matches. Returns [] on any
   * failure so callers can treat "no matches" and "fetch failed"
   * identically — a silent no-op is the right failure mode for a banner.
   *
   * Memoised for WATCHLIST_CACHE_TTL_MS (30 s). Item Market's SPA nav
   * fires dispatch() — and therefore injectWatchlistBar() — on every
   * item tap, so a user flicking through 10 items in 30 s used to burn
   * 30 PostgREST reads on data that can't have changed. Per-player key
   * isolates cache across key rotation (player_id changes), and cached
   * reads of an empty result are just as valid as non-empty, so zero
   * matches are memoised too.
   */
  const WATCHLIST_CACHE_TTL_MS = 30_000;
  let watchlistMatchesCache = null; // { playerId, expiresAt, matches } | null

  async function fetchWatchlistMatches(playerId) {
    if (!playerId) return [];

    const now = Date.now();
    if (watchlistMatchesCache
        && watchlistMatchesCache.playerId === playerId
        && watchlistMatchesCache.expiresAt > now) {
      return watchlistMatchesCache.matches;
    }

    const alerts = await fetchJSON(
      WATCHLIST_ALERTS_URL +
      '?player_id=eq.' + encodeURIComponent(playerId) +
      '&select=item_id,max_price,venues'
    );
    if (!Array.isArray(alerts) || alerts.length === 0) return [];

    const idList = alerts.map(function (a) { return a.item_id; }).join(',');
    if (!idList) return [];

    // Parallel reads — same pattern as src/watchlist.js. Abroad skipped.
    const inClause = 'in.(' + idList + ')';
    const [sellRows, bazaarRows] = await Promise.all([
      fetchJSON(
        SELL_PRICES_URL +
        '?item_id=' + inClause +
        '&select=item_id,price,min_price,updated_at'
      ),
      fetchJSON(
        BAZAAR_PRICES_URL +
        '?item_id=' + inClause +
        '&select=item_id,price,quantity,bazaar_owner_id,checked_at'
      ),
    ]);

    const sellByItem = new Map();
    if (Array.isArray(sellRows)) {
      for (const r of sellRows) sellByItem.set(r.item_id, r);
    }
    const bazaarByItem = new Map();
    if (Array.isArray(bazaarRows)) {
      for (const r of bazaarRows) {
        const existing = bazaarByItem.get(r.item_id);
        if (!existing || r.price < existing.price) {
          const observedAt = r.checked_at ? new Date(r.checked_at).getTime() : 0;
          if (Date.now() - observedAt <= WATCHLIST_BAZAAR_MAX_AGE_MS) {
            bazaarByItem.set(r.item_id, r);
          }
        }
      }
    }

    const matches = [];
    for (const a of alerts) {
      const venues = new Set(a.venues || ['market', 'bazaar']);
      const maxPrice = Number(a.max_price);

      if (venues.has('market')) {
        const s = sellByItem.get(a.item_id);
        // Match against min_price (absolute floor) — see src/watchlist.js
        // for the rationale. Falls back to price for rows that haven't
        // been refreshed since migration 024.
        const floorPrice = s && s.min_price != null
          ? Number(s.min_price)
          : (s && s.price != null ? Number(s.price) : null);
        if (s && floorPrice != null && floorPrice <= maxPrice) {
          const observedAt = s.updated_at ? new Date(s.updated_at).getTime() : 0;
          const fresh = observedAt > 0 && Date.now() - observedAt <= WATCHLIST_MARKET_MAX_AGE_MS;
          if (fresh) {
            const limited = s.price != null
              && s.min_price != null
              && Number(s.min_price) < Number(s.price);
            matches.push({
              item_id: a.item_id,
              venue: 'market',
              venue_label: 'Item Market',
              price: floorPrice,
              max_price: maxPrice,
              savings: maxPrice - floorPrice,
              savings_pct: ((maxPrice - floorPrice) / maxPrice) * 100,
              observed_at: observedAt,
              link: 'https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=' + a.item_id,
              extra: { limited: limited },
            });
          }
        }
      }
      if (venues.has('bazaar')) {
        const b = bazaarByItem.get(a.item_id);
        // Drop $1 locked placeholders. bazaar_prices still carries
        // rows written before the scraper's $1 filter landed, and
        // surfacing them as a "bazaar match" means the user clicks
        // through to a bazaar only to find the listing is unbuyable.
        if (b && Number(b.price) > 1 && Number(b.price) <= maxPrice) {
          const price = Number(b.price);
          matches.push({
            item_id: a.item_id,
            venue: 'bazaar',
            venue_label: 'Bazaar',
            price: price,
            max_price: maxPrice,
            savings: maxPrice - price,
            savings_pct: ((maxPrice - price) / maxPrice) * 100,
            observed_at: b.checked_at ? new Date(b.checked_at).getTime() : 0,
            link: 'https://www.torn.com/bazaar.php?userId=' + b.bazaar_owner_id,
            extra: { owner_id: b.bazaar_owner_id, quantity: b.quantity },
          });
        }
      }
    }
    matches.sort(function (a, b) { return b.savings_pct - a.savings_pct; });

    watchlistMatchesCache = {
      playerId: playerId,
      expiresAt: now + WATCHLIST_CACHE_TTL_MS,
      matches: matches,
    };
    return matches;
  }

  // -- Banner styles + DOM -------------------------------------------------

  function injectWatchlistStyles() {
    if (document.getElementById('valigia-watchlist-styles')) return;
    const css = [
      '#' + WATCHLIST_BAR_ID + ' {',
      '  all: initial;',
      '  display: block;',
      '  margin: 8px auto 12px;',
      '  max-width: 1100px;',
      '  font-family: ui-monospace, Menlo, Consolas, monospace;',
      '  color: #c8cdd8;',
      '  background: #161a22;',
      '  border: 1px solid #252a35;',
      '  border-left: 3px solid #4ae8a0;',
      '  border-radius: 4px;',
      '  box-sizing: border-box;',
      '  overflow: hidden;',
      '}',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-head {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 8px 12px;',
      '  cursor: pointer;',
      '  user-select: none;',
      '}',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-title {',
      '  color: #4ae8a0;',
      '  font-weight: 700;',
      '  font-size: 12px;',
      '  letter-spacing: 0.12em;',
      '  text-transform: uppercase;',
      '}',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-count {',
      '  background: #4ae8a0;',
      '  color: #0d0f14;',
      '  font-weight: 700;',
      '  font-size: 11px;',
      '  padding: 1px 7px;',
      '  border-radius: 999px;',
      '}',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-caret {',
      '  margin-left: auto;',
      '  color: #4ae8a0;',
      '  font-size: 11px;',
      '  transition: transform 150ms;',
      '}',
      '#' + WATCHLIST_BAR_ID + '.vgl-wl-open .vgl-wl-caret {',
      '  transform: rotate(180deg);',
      '}',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-body {',
      '  display: none;',
      '  padding: 4px 10px 10px;',
      '  gap: 4px;',
      '  flex-direction: column;',
      '}',
      '#' + WATCHLIST_BAR_ID + '.vgl-wl-open .vgl-wl-body {',
      '  display: flex;',
      '}',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-row {',
      '  display: grid;',
      '  grid-template-columns: minmax(0,1.4fr) auto auto minmax(0,1fr) auto auto;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 6px 8px;',
      '  border: 1px solid #252a35;',
      '  border-radius: 3px;',
      '  background: rgba(74,232,160,0.04);',
      '  color: #c8cdd8;',
      '  text-decoration: none;',
      '  font-size: 12px;',
      '}',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-row:active {',
      '  background: rgba(74,232,160,0.12);',
      '}',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-item { font-weight: 700; color: #c8cdd8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-venue { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 6px; border-radius: 2px; white-space: nowrap; }',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-venue--market { background: rgba(232,200,74,0.18); color: #e8c84a; }',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-venue--bazaar { background: rgba(74,232,160,0.18); color: #4ae8a0; }',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-price { color: #e8c84a; font-weight: 700; white-space: nowrap; }',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-save { color: #8a8fa0; white-space: nowrap; }',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-save strong { color: #4ae8a0; font-weight: 700; }',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-age { color: #8a8fa0; font-size: 10px; white-space: nowrap; }',
      '#' + WATCHLIST_BAR_ID + ' .vgl-wl-arrow { color: #e8c84a; font-weight: 700; }',
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'valigia-watchlist-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function formatMoney(n) {
    if (n == null) return '\u2014';
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  }

  /**
   * Compact money formatter used inside the bazaar row overlay where
   * horizontal space is tight. < $10k: full digits ($9,876). $10k–$1M:
   * "$12.3k" / "$123k". >= $1M: "$1.2M" / "$120M". Negative numbers get
   * a leading "-".
   */
  function formatMoneyCompact(n) {
    if (n == null || !Number.isFinite(n)) return '\u2014';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    if (abs < 10000) return sign + '$' + Math.round(abs).toLocaleString('en-US');
    if (abs < 1_000_000) {
      const k = abs / 1000;
      return sign + '$' + (k >= 100 ? Math.round(k) : k.toFixed(1)) + 'k';
    }
    if (abs < 1_000_000_000) {
      const m = abs / 1_000_000;
      return sign + '$' + (m >= 100 ? Math.round(m) : m.toFixed(1)) + 'M';
    }
    const b = abs / 1_000_000_000;
    return sign + '$' + (b >= 100 ? Math.round(b) : b.toFixed(1)) + 'B';
  }

  function formatAge(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  // In-memory view of the Torn items catalog. Populated lazily by
  // ensureItemCatalog() from localStorage or a Torn API call. Shape:
  // Map<itemId:number, name:string>.
  let itemNameCache = null;

  /**
   * Load the id→name map, hydrating the in-memory cache from localStorage
   * or fetching from Torn if we're cold. Safe to call repeatedly — only
   * hits the network once per TTL window. Silent-fail on any error so
   * the banner never blocks on name resolution.
   */
  async function ensureItemCatalog() {
    if (itemNameCache && itemNameCache.size > 0) return itemNameCache;

    // Try localStorage first. If the cached blob is present and fresh,
    // hydrate the in-memory cache and skip the fetch entirely.
    try {
      const raw = localStorage.getItem(ITEM_CATALOG_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (
          cached &&
          cached.fetchedAt &&
          Date.now() - cached.fetchedAt < ITEM_CATALOG_TTL_MS &&
          cached.nameById && typeof cached.nameById === 'object'
        ) {
          itemNameCache = new Map();
          for (const idStr in cached.nameById) {
            itemNameCache.set(Number(idStr), cached.nameById[idStr]);
          }
          if (itemNameCache.size > 0) return itemNameCache;
        }
      }
    } catch (_) { /* corrupt cache — fall through to refetch */ }

    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) {
      return itemNameCache || new Map();
    }

    try {
      const res = await gmRequest({
        method: 'GET',
        url: 'https://api.torn.com/torn/?selections=items&key=' +
             encodeURIComponent(TORN_API_KEY),
        headers: { 'Accept': 'application/json' },
      });
      let data = null;
      try { data = JSON.parse(res.responseText); } catch (_) { /* ignore */ }
      if (data && data.items) {
        const nameById = {};
        const map = new Map();
        for (const idStr in data.items) {
          const entry = data.items[idStr];
          const name = entry && entry.name;
          if (name) {
            nameById[idStr] = name;
            map.set(Number(idStr), name);
          }
        }
        try {
          localStorage.setItem(
            ITEM_CATALOG_CACHE_KEY,
            JSON.stringify({ nameById, fetchedAt: Date.now() })
          );
        } catch (_) { /* storage full / disabled — non-fatal */ }
        itemNameCache = map;
        return itemNameCache;
      }
    } catch (err) {
      log('item catalog fetch failed', err);
    }

    return itemNameCache || new Map();
  }

  /** Synchronous lookup used once the catalog is warm. "Item #N" fallback. */
  function itemNameFor(itemId) {
    if (itemNameCache && itemNameCache.has(Number(itemId))) {
      return itemNameCache.get(Number(itemId));
    }
    return 'Item #' + itemId;
  }

  function buildWatchlistBar(matches) {
    const bar = document.createElement('div');
    bar.id = WATCHLIST_BAR_ID;

    const head = document.createElement('div');
    head.className = 'vgl-wl-head';
    const title = document.createElement('span');
    title.className = 'vgl-wl-title';
    title.textContent = 'Watchlist Matches';
    const count = document.createElement('span');
    count.className = 'vgl-wl-count';
    count.textContent = String(matches.length);
    const caret = document.createElement('span');
    caret.className = 'vgl-wl-caret';
    caret.textContent = '\u25BE';
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(caret);

    const body = document.createElement('div');
    body.className = 'vgl-wl-body';
    for (const m of matches) {
      const row = document.createElement('a');
      row.className = 'vgl-wl-row';
      row.href = m.link;
      row.target = '_top';
      row.rel = 'noopener';

      const name = document.createElement('span');
      name.className = 'vgl-wl-item';
      name.textContent = itemNameFor(m.item_id);

      const venue = document.createElement('span');
      venue.className = 'vgl-wl-venue vgl-wl-venue--' + m.venue;
      venue.textContent = m.venue_label;

      const price = document.createElement('span');
      price.className = 'vgl-wl-price';
      price.textContent = formatMoney(m.price);

      const save = document.createElement('span');
      save.className = 'vgl-wl-save';
      const saveStrong = document.createElement('strong');
      saveStrong.textContent = formatMoney(m.savings);
      save.appendChild(document.createTextNode('saves '));
      save.appendChild(saveStrong);
      save.appendChild(document.createTextNode(
        Number.isFinite(m.savings_pct) ? ' (' + Math.round(m.savings_pct) + '%)' : ''
      ));
      // Loss-leader heads-up — see src/watchlist.js for rationale.
      if (m.venue === 'market' && m.extra && m.extra.limited) {
        save.appendChild(document.createTextNode(' \u00B7 single unit'));
      }

      const age = document.createElement('span');
      age.className = 'vgl-wl-age';
      age.textContent = formatAge(m.observed_at);

      const arrow = document.createElement('span');
      arrow.className = 'vgl-wl-arrow';
      arrow.textContent = '\u2192';

      row.appendChild(name);
      row.appendChild(venue);
      row.appendChild(price);
      row.appendChild(save);
      row.appendChild(age);
      row.appendChild(arrow);
      body.appendChild(row);
    }

    head.addEventListener('click', function () {
      bar.classList.toggle('vgl-wl-open');
    });

    bar.appendChild(head);
    bar.appendChild(body);
    return bar;
  }

  /**
   * Top-level entry point. Safe to call on every page load — it no-ops
   * silently when there are no matches, and removes any prior bar before
   * injecting a fresh one so SPA navs don't stack duplicates.
   */
  async function injectWatchlistBar() {
    // Idempotent: tear down any previous instance before fetching.
    const existing = document.getElementById(WATCHLIST_BAR_ID);
    if (existing) existing.remove();

    const playerId = await resolvePlayerId();
    if (!playerId) return;

    // Warm the items catalog in parallel with the match fetch — by the
    // time we go to render row labels we'll have real item names instead
    // of the "Item #N" fallback.
    const [matches] = await Promise.all([
      fetchWatchlistMatches(playerId),
      ensureItemCatalog(),
    ]);
    if (matches.length === 0) return;

    injectWatchlistStyles();
    const bar = buildWatchlistBar(matches);

    // Torn's content layout varies across pages and PDA skins. Try a
    // couple of well-known containers, fall back to body so we never
    // disappear silently.
    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    host.insertBefore(bar, host.firstChild);
  }

  // -- Bazaar Deals bar ----------------------------------------------------
  // A top-of-page collapsed bar (visual twin of the Watchlist Matches
  // bar) that surfaces every bazaar listing priced below its Item
  // Market floor. We used to inject a per-row overlay into each tile,
  // but Torn's bazaar DOM varies so much across layouts that the
  // overlay ended up truncated, squeezed between flex items, or
  // stacked into the wrong row. A single bar at the top sidesteps all
  // of that — one known-good injection point, one clean list.
  //
  // Hidden entirely when there are zero profitable listings. Every
  // row is a deep-link into the Item Market for that item so the
  // player can list their flip in one tap.

  const BAZAAR_DEALS_BAR_ID = 'valigia-bazaar-deals-bar';
  // Torn takes a 5% fee on item market sales — a flip is only real
  // when net-sell (market * 0.95) exceeds the bazaar buy price.
  const MARKET_FEE_RATE = 0.05;

  function injectBazaarDealsStyles() {
    if (document.getElementById('valigia-bazaar-deals-styles')) return;
    const css = [
      '#' + BAZAAR_DEALS_BAR_ID + ' {',
      '  all: initial;',
      '  display: block;',
      '  margin: 8px auto 12px;',
      '  max-width: 1100px;',
      '  font-family: ui-monospace, Menlo, Consolas, monospace;',
      '  color: #c8cdd8;',
      '  background: #161a22;',
      '  border: 1px solid #252a35;',
      '  border-left: 3px solid #4ae8a0;',
      '  border-radius: 4px;',
      '  box-sizing: border-box;',
      '  overflow: hidden;',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-head {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 8px 12px;',
      '  cursor: pointer;',
      '  user-select: none;',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-title {',
      '  color: #4ae8a0;',
      '  font-weight: 700;',
      '  font-size: 12px;',
      '  letter-spacing: 0.12em;',
      '  text-transform: uppercase;',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-count {',
      '  background: #4ae8a0;',
      '  color: #0d0f14;',
      '  font-weight: 700;',
      '  font-size: 11px;',
      '  padding: 1px 7px;',
      '  border-radius: 999px;',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-caret {',
      '  margin-left: auto;',
      '  color: #4ae8a0;',
      '  font-size: 11px;',
      '  transition: transform 150ms;',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + '.vgl-bd-open .vgl-bd-caret {',
      '  transform: rotate(180deg);',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-body {',
      '  display: none;',
      '  padding: 4px 10px 10px;',
      '  gap: 4px;',
      '  flex-direction: column;',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + '.vgl-bd-open .vgl-bd-body {',
      '  display: flex;',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-row {',
      '  display: grid;',
      '  grid-template-columns: minmax(0,1.6fr) auto auto auto auto;',
      '  align-items: center;',
      '  gap: 10px;',
      '  padding: 6px 8px;',
      '  border: 1px solid #252a35;',
      '  border-radius: 3px;',
      '  background: rgba(74,232,160,0.04);',
      '  color: #c8cdd8;',
      '  text-decoration: none;',
      '  font-size: 12px;',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-row:active {',
      '  background: rgba(74,232,160,0.12);',
      '}',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-item { font-weight: 700; color: #c8cdd8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-baz { color: #c8cdd8; white-space: nowrap; }',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-arrow { color: #8a8fa0; }',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-mkt { color: #e8c84a; font-weight: 700; white-space: nowrap; }',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-gain { color: #4ae8a0; font-weight: 700; white-space: nowrap; }',
      // Narrow viewports: stack so nothing clips.
      '@media (max-width: 560px) {',
      '  #' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-row {',
      '    grid-template-columns: 1fr auto;',
      '    row-gap: 2px;',
      '  }',
      '  #' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-item { grid-column: 1 / -1; }',
      '}',
    ].join('\n');
    const el = document.createElement('style');
    el.id = 'valigia-bazaar-deals-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function buildBazaarDealsBar(deals) {
    const bar = document.createElement('div');
    bar.id = BAZAAR_DEALS_BAR_ID;

    const head = document.createElement('div');
    head.className = 'vgl-bd-head';
    const title = document.createElement('span');
    title.className = 'vgl-bd-title';
    title.textContent = 'Bazaar Deals';
    const count = document.createElement('span');
    count.className = 'vgl-bd-count';
    count.textContent = String(deals.length);
    const caret = document.createElement('span');
    caret.className = 'vgl-bd-caret';
    caret.textContent = '\u25BE';
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(caret);

    const body = document.createElement('div');
    body.className = 'vgl-bd-body';
    for (const d of deals) {
      const row = document.createElement('a');
      row.className = 'vgl-bd-row';
      row.href = 'https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=' + d.item_id;
      row.target = '_top';
      row.rel = 'noopener';

      const name = document.createElement('span');
      name.className = 'vgl-bd-item';
      name.textContent = d.name;

      const baz = document.createElement('span');
      baz.className = 'vgl-bd-baz';
      baz.textContent = formatMoneyCompact(d.bazaarPrice);

      const arrow = document.createElement('span');
      arrow.className = 'vgl-bd-arrow';
      arrow.textContent = '\u2192';

      const mkt = document.createElement('span');
      mkt.className = 'vgl-bd-mkt';
      mkt.textContent = formatMoneyCompact(d.netSell);

      const gain = document.createElement('span');
      gain.className = 'vgl-bd-gain';
      gain.textContent = '+' + formatMoneyCompact(d.profit) +
        ' (' + (d.profitPct >= 100 ? Math.round(d.profitPct) : d.profitPct.toFixed(d.profitPct >= 10 ? 0 : 1)) + '%)';

      row.appendChild(name);
      row.appendChild(baz);
      row.appendChild(arrow);
      row.appendChild(mkt);
      row.appendChild(gain);
      body.appendChild(row);
    }

    head.addEventListener('click', function () {
      bar.classList.toggle('vgl-bd-open');
    });

    bar.appendChild(head);
    bar.appendChild(body);
    return bar;
  }

  /**
   * Top-level entry. Reads sell_prices for the scraped bazaar items,
   * filters for flippable ones (bazaar < net-sell), and injects the
   * bar at the top of the page. Silent no-op on zero flips or any
   * failure along the way so the ingest path is never blocked.
   */
  async function injectBazaarDealsBar(scrapedItems) {
    // Remove any prior instance so SPA nav doesn't stack duplicates.
    const existing = document.getElementById(BAZAAR_DEALS_BAR_ID);
    if (existing) existing.remove();

    if (!Array.isArray(scrapedItems) || scrapedItems.length === 0) return;
    const ids = [...new Set(scrapedItems.map(function (r) { return r.item_id; }))];
    if (ids.length === 0) return;

    // Warm the items catalog in parallel with the sell-prices read so
    // the bar has real names for every row.
    const [sellRows] = await Promise.all([
      fetchJSON(
        SELL_PRICES_URL +
        '?item_id=in.(' + ids.join(',') + ')' +
        '&select=item_id,price'
      ),
      ensureItemCatalog(),
    ]);
    if (!Array.isArray(sellRows) || sellRows.length === 0) return;

    const marketByItem = new Map();
    for (const r of sellRows) {
      if (r.price != null) marketByItem.set(Number(r.item_id), Number(r.price));
    }

    const deals = [];
    for (const it of scrapedItems) {
      const marketPrice = marketByItem.get(Number(it.item_id));
      if (!Number.isFinite(marketPrice)) continue;
      const bazaarPrice = Number(it.price);
      if (!Number.isFinite(bazaarPrice) || bazaarPrice <= 0) continue;
      const netSell = marketPrice * (1 - MARKET_FEE_RATE);
      const profit = netSell - bazaarPrice;
      if (profit <= 0) continue; // only flippable rows
      deals.push({
        item_id: Number(it.item_id),
        name: itemNameFor(it.item_id),
        bazaarPrice: bazaarPrice,
        netSell: netSell,
        profit: profit,
        profitPct: (profit / bazaarPrice) * 100,
      });
    }
    if (deals.length === 0) return;

    // Best margins first — most actionable deal at the top of the list.
    deals.sort(function (a, b) { return b.profitPct - a.profitPct; });

    injectBazaarDealsStyles();
    const bar = buildBazaarDealsBar(deals);

    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    host.insertBefore(bar, host.firstChild);
  }

  // -- Lowest Price Found bar ---------------------------------------------
  // On the Item Market when the user has filtered down to a single item
  // (the hash carries `itemID=N`), look up the cheapest fresh bazaar
  // listing for that item from the shared `bazaar_prices` pool and
  // inject a single-row card. Stacks directly below the Watchlist
  // Matches bar when both are present, otherwise sits at the top of
  // the page on its own. Hidden entirely when the pool has no fresh
  // hit for the active item.

  const LOWEST_PRICE_BAR_ID = 'valigia-lowest-price-bar';
  // Same freshness window the watchlist matcher uses for bazaar entries
  // (and the web app's "Best Run" eligibility gate). Older rows get
  // dropped — the listing is too likely to be gone by the time the
  // player taps through.
  const LOWEST_PRICE_BAZAAR_MAX_AGE_MS = 10 * 60 * 1000;
  // Anything priced under 10% of the Item Market floor is almost
  // certainly a locked / troll listing — same threshold the web app
  // uses before claiming the Best Run card. Filter these so we never
  // deep-link a player to a bazaar where the listing isn't actually
  // buyable.
  const LOWEST_PRICE_TOO_GOOD_THRESHOLD = 0.10;

  /**
   * Pull the active item id out of the Item Market hash. Torn uses
   * patterns like "#/market/view=search&itemID=12345" and
   * "#/market/view=category&itemID=12345&...". Returns null on the
   * landing view (no itemID) so the bar doesn't fire across the
   * whole catalog.
   */
  function detectItemMarketSingleItemId() {
    const hash = location.hash || '';
    const m = hash.match(/itemID=(\d+)/i);
    return m ? Number(m[1]) : null;
  }

  /**
   * Read the cheapest fresh bazaar entry for `itemId` from the shared
   * pool. Cross-references `sell_prices` so we can both filter
   * locked-listing scams (price < 10% of market floor) and surface
   * the savings vs. the Item Market the player is currently looking
   * at. Returns null when there's no eligible row.
   */
  async function fetchLowestBazaarForItem(itemId) {
    if (!itemId) return null;
    const [bazaarRows, sellRows] = await Promise.all([
      fetchJSON(
        BAZAAR_PRICES_URL +
        '?item_id=eq.' + encodeURIComponent(itemId) +
        '&price=gt.1' +
        '&select=item_id,price,quantity,bazaar_owner_id,checked_at' +
        '&order=price.asc' +
        '&limit=20'
      ),
      fetchJSON(
        SELL_PRICES_URL +
        '?item_id=eq.' + encodeURIComponent(itemId) +
        '&select=price,min_price'
      ),
    ]);
    if (!Array.isArray(bazaarRows) || bazaarRows.length === 0) return null;

    const sellRow = Array.isArray(sellRows) && sellRows.length > 0
      ? sellRows[0] : null;
    const marketPrice = sellRow && sellRow.price != null
      ? Number(sellRow.price) : null;
    const marketFloor = sellRow && sellRow.min_price != null
      ? Number(sellRow.min_price)
      : marketPrice;

    const cutoff = Date.now() - LOWEST_PRICE_BAZAAR_MAX_AGE_MS;
    for (const r of bazaarRows) {
      const observedAt = r.checked_at ? new Date(r.checked_at).getTime() : 0;
      if (observedAt < cutoff) continue;
      const price = Number(r.price);
      if (!Number.isFinite(price) || price <= 1) continue;
      if (Number.isFinite(marketFloor) && marketFloor > 0 &&
          price < marketFloor * LOWEST_PRICE_TOO_GOOD_THRESHOLD) {
        continue;
      }
      return {
        item_id: itemId,
        price: price,
        quantity: Number(r.quantity) || 1,
        bazaar_owner_id: r.bazaar_owner_id,
        observed_at: observedAt,
        market_price: Number.isFinite(marketPrice) ? marketPrice : null,
      };
    }
    return null;
  }

  function injectLowestPriceStyles() {
    if (document.getElementById('valigia-lowest-price-styles')) return;
    const css = [
      '#' + LOWEST_PRICE_BAR_ID + ' {',
      '  all: initial;',
      '  display: block;',
      '  margin: 8px auto 12px;',
      '  max-width: 1100px;',
      '  font-family: ui-monospace, Menlo, Consolas, monospace;',
      '  color: #c8cdd8;',
      '  background: #161a22;',
      '  border: 1px solid #252a35;',
      '  border-left: 3px solid #4ae8a0;',
      '  border-radius: 4px;',
      '  box-sizing: border-box;',
      '  overflow: hidden;',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-row {',
      '  display: grid;',
      '  grid-template-columns: auto minmax(0,1.4fr) auto auto minmax(0,1fr) auto auto;',
      '  align-items: center;',
      '  gap: 10px;',
      '  padding: 10px 12px;',
      '  color: #c8cdd8;',
      '  text-decoration: none;',
      '  font-size: 12px;',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-row:active {',
      '  background: rgba(74,232,160,0.08);',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-title {',
      '  color: #4ae8a0;',
      '  font-weight: 700;',
      '  font-size: 11px;',
      '  letter-spacing: 0.12em;',
      '  text-transform: uppercase;',
      '  white-space: nowrap;',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-item {',
      '  font-weight: 700;',
      '  color: #c8cdd8;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-price {',
      '  color: #4ae8a0;',
      '  font-weight: 700;',
      '  white-space: nowrap;',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-qty {',
      '  color: #8a8fa0;',
      '  white-space: nowrap;',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-vs {',
      '  color: #8a8fa0;',
      '  white-space: nowrap;',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-vs strong { color: #4ae8a0; font-weight: 700; }',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-vs.vgl-lp-vs--worse strong { color: #e8824a; }',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-age {',
      '  color: #8a8fa0;',
      '  font-size: 10px;',
      '  white-space: nowrap;',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-arrow {',
      '  color: #4ae8a0;',
      '  font-weight: 700;',
      '}',
      '@media (max-width: 560px) {',
      '  #' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-row {',
      '    grid-template-columns: auto 1fr auto;',
      '    row-gap: 4px;',
      '  }',
      '  #' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-item { grid-column: 1 / -1; }',
      '  #' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-vs { grid-column: 1 / -1; }',
      '}',
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'valigia-lowest-price-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildLowestPriceBar(deal) {
    const bar = document.createElement('div');
    bar.id = LOWEST_PRICE_BAR_ID;

    const row = document.createElement('a');
    row.className = 'vgl-lp-row';
    row.href = 'https://www.torn.com/bazaar.php?userId=' + deal.bazaar_owner_id;
    row.target = '_top';
    row.rel = 'noopener';

    const title = document.createElement('span');
    title.className = 'vgl-lp-title';
    title.textContent = 'Lowest Price Found';

    const name = document.createElement('span');
    name.className = 'vgl-lp-item';
    name.textContent = itemNameFor(deal.item_id);

    const price = document.createElement('span');
    price.className = 'vgl-lp-price';
    price.textContent = formatMoney(deal.price);

    const qty = document.createElement('span');
    qty.className = 'vgl-lp-qty';
    qty.textContent = 'qty ' + deal.quantity;

    const vs = document.createElement('span');
    vs.className = 'vgl-lp-vs';
    if (deal.market_price != null && deal.market_price > 0) {
      const diff = deal.market_price - deal.price;
      const pct = (diff / deal.market_price) * 100;
      const strong = document.createElement('strong');
      if (diff > 0) {
        strong.textContent = formatMoney(diff);
        vs.appendChild(document.createTextNode('saves '));
        vs.appendChild(strong);
        vs.appendChild(document.createTextNode(
          ' (' + Math.round(pct) + '%) vs market'
        ));
      } else {
        vs.classList.add('vgl-lp-vs--worse');
        strong.textContent = formatMoney(-diff);
        vs.appendChild(document.createTextNode('+'));
        vs.appendChild(strong);
        vs.appendChild(document.createTextNode(' over market'));
      }
    } else {
      vs.appendChild(document.createTextNode('no market reference'));
    }
    // Append the freshness inside the same cell with a mid-dot separator.
    // Cleaner than a separate grid cell whose 10px gap renders too tight
    // at typical PDA viewport sizes — "vs market" and "just now" looked
    // smushed together (e.g. "marketnow") in earlier versions.
    const ageText = formatAge(deal.observed_at);
    if (ageText) {
      vs.appendChild(document.createTextNode(' \u00B7 ' + ageText));
    }

    const arrow = document.createElement('span');
    arrow.className = 'vgl-lp-arrow';
    // Use a Unicode escape rather than the literal arrow glyph: cPanel
    // serves .user.js as Latin-1 by default, so the UTF-8 bytes for the
    // arrow would mis-decode to "a-circumflex" + control chars in PDA's
    // webview. The escape keeps the source ASCII and lets the JS engine
    // produce the correct codepoint at runtime regardless of file charset.
    arrow.textContent = '\u2192';

    row.appendChild(title);
    row.appendChild(name);
    row.appendChild(price);
    row.appendChild(qty);
    row.appendChild(vs);
    row.appendChild(arrow);

    bar.appendChild(row);
    return bar;
  }

  /**
   * Top-level entry. Safe to call on every Item Market dispatch — it
   * tears down any prior instance and silently no-ops when the user
   * isn't filtered to a single item or the pool has no fresh hit.
   * Stacks below the Watchlist Matches bar when present (race-safe:
   * whichever bar arrives later sits in the right slot regardless of
   * order).
   */
  async function injectLowestPriceBar() {
    const existing = document.getElementById(LOWEST_PRICE_BAR_ID);
    if (existing) existing.remove();

    const itemId = detectItemMarketSingleItemId();
    if (!itemId) return;

    const [deal] = await Promise.all([
      fetchLowestBazaarForItem(itemId),
      ensureItemCatalog(),
    ]);
    if (!deal) return;

    injectLowestPriceStyles();
    const bar = buildLowestPriceBar(deal);

    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;

    // Slot directly after the Watchlist Matches bar when it's already
    // present. If the watchlist injects after us, its insertBefore at
    // host.firstChild will push this bar down naturally — so the
    // stacking order ends up Watchlist → Lowest Price either way.
    const watchlistBar = document.getElementById(WATCHLIST_BAR_ID);
    if (watchlistBar && watchlistBar.parentNode === host) {
      host.insertBefore(bar, watchlistBar.nextSibling);
    } else {
      host.insertBefore(bar, host.firstChild);
    }
  }

  // -- Stakeout mode -------------------------------------------------------
  // Tier 3 of the restock-data-quality plan. When the user is abroad and
  // this toggle is ON, re-run runTravel() every STAKEOUT_INTERVAL_MS so
  // each upsert to abroad_prices gives the restock trigger a chance to
  // fire on a stock-up delta. Every tick is an independently-observed
  // data point with tight confidence (≤5 min since prior observation),
  // so stakers meaningfully improve the community's cadence metric.
  //
  // The 5 min cadence is well above the edge function's 5 s per-player
  // rate limit, so there's no backend pressure. It's also above the
  // realistic post-cleanup median cadence (20–45 min observed), which
  // means most real refills during a long stakeout get caught on the
  // *next* tick after they occur.
  //
  // User-facing UI is a small pill fixed to the top-right of the travel
  // page: [STAKEOUT: OFF] tap-to-enable, [STAKEOUT: ON · next 4:32]
  // tap-to-disable. Setting is persisted in localStorage so it survives
  // page reloads and re-landings.
  const STAKEOUT_INTERVAL_MS = 5 * 60 * 1000;
  const STAKEOUT_STORAGE_KEY = 'valigia_stakeout_enabled';

  const stakeout = {
    intervalId: null,
    tickIntervalId: null,
    badge: null,
    nextTickAt: 0,
  };

  function stakeoutEnabled() {
    try { return localStorage.getItem(STAKEOUT_STORAGE_KEY) === '1'; }
    catch (e) { return false; }
  }

  function setStakeoutEnabled(val) {
    try { localStorage.setItem(STAKEOUT_STORAGE_KEY, val ? '1' : '0'); }
    catch (e) { /* quota / private mode — ignore */ }
  }

  function formatCountdown(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  function updateStakeoutBadge() {
    if (!stakeout.badge) return;
    const on = stakeoutEnabled();
    let text = 'STAKEOUT: ' + (on ? 'ON' : 'OFF');
    if (on && stakeout.nextTickAt > 0) {
      text += ' · next ' + formatCountdown(stakeout.nextTickAt - Date.now());
    }
    stakeout.badge.textContent = text;
    stakeout.badge.style.color = on ? '#4ae8a0' : '#999';
    stakeout.badge.style.borderColor = on ? '#4ae8a0' : '#444';
  }

  function onStakeoutBadgeClick() {
    if (stakeoutEnabled()) {
      setStakeoutEnabled(false);
      stopStakeoutInterval();
      toast('Stakeout disabled', 'success');
    } else {
      setStakeoutEnabled(true);
      startStakeoutInterval();
      toast('Stakeout enabled — next scrape in 5 min', 'success');
    }
    updateStakeoutBadge();
  }

  function mountStakeoutBadge() {
    if (stakeout.badge) return;
    const badge = document.createElement('div');
    badge.id = 'valigia-stakeout-badge';
    Object.assign(badge.style, {
      position: 'fixed',
      top: '10px',
      right: '10px',
      zIndex: '99998',
      padding: '6px 10px',
      background: '#161a22',
      border: '1px solid #444',
      borderRadius: '6px',
      font: "600 11px/1 'Syne Mono', monospace",
      letterSpacing: '0.04em',
      color: '#999',
      cursor: 'pointer',
      userSelect: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,.4)',
    });
    badge.addEventListener('click', onStakeoutBadgeClick);
    document.body.appendChild(badge);
    stakeout.badge = badge;
  }

  function unmountStakeoutBadge() {
    if (stakeout.badge) {
      stakeout.badge.remove();
      stakeout.badge = null;
    }
  }

  async function stakeoutTick() {
    log('stakeout tick');
    stakeout.nextTickAt = Date.now() + STAKEOUT_INTERVAL_MS;
    updateStakeoutBadge();
    try { await runTravel(); } catch (e) { log('stakeout tick error:', e); }
  }

  function startStakeoutInterval() {
    if (stakeout.intervalId) return; // already running, don't stack
    stakeout.nextTickAt = Date.now() + STAKEOUT_INTERVAL_MS;
    stakeout.intervalId = setInterval(stakeoutTick, STAKEOUT_INTERVAL_MS);
    stakeout.tickIntervalId = setInterval(updateStakeoutBadge, 1000);
  }

  function stopStakeoutInterval() {
    if (stakeout.intervalId) { clearInterval(stakeout.intervalId); stakeout.intervalId = null; }
    if (stakeout.tickIntervalId) { clearInterval(stakeout.tickIntervalId); stakeout.tickIntervalId = null; }
    stakeout.nextTickAt = 0;
  }

  // Called from runTravel() once a destination is confirmed. Mounts the
  // badge (shows OFF or ON state from localStorage) and starts the
  // auto-scrape interval if the user previously enabled it.
  function initStakeoutUI() {
    mountStakeoutBadge();
    if (stakeoutEnabled() && !stakeout.intervalId) {
      startStakeoutInterval();
    }
    updateStakeoutBadge();
  }

  // Called from dispatch() when navigating to a non-travel page. Clears
  // timers + removes the badge but does NOT flip the user's preference.
  function tearDownStakeout() {
    stopStakeoutInterval();
    unmountStakeoutBadge();
  }

  // -- Main ----------------------------------------------------------------
  async function runTravel() {
    const destination = detectDestination();
    if (!destination) {
      log('No "You are in X" marker - probably not landed yet.');
      return;
    }

    // Mount the stakeout toggle as soon as we know the user is abroad.
    // Idempotent: re-running this on a stakeout tick is a no-op. Must run
    // BEFORE the 8-s shop-hydration poll so the toggle appears even if
    // scraping fails for DOM-selector reasons.
    initStakeoutUI();

    // Torn's travel page hydrates its shop lists after initial DOM render.
    // Poll briefly for item images to show up before scraping.
    const start = Date.now();
    let shops = [];
    while (Date.now() - start < 8000) {
      shops = scrapeShops();
      const total = shops.reduce(function (s, sh) { return s + sh.items.length; }, 0);
      if (total > 0) break;
      await new Promise(function (r) { setTimeout(r, 500); });
    }

    const totalItems = shops.reduce(function (s, sh) { return s + sh.items.length; }, 0);
    if (totalItems === 0) {
      log('No shop items found after 8s - aborting.');
      if (DEBUG) debugPanel(['destination=' + destination, 'No items found.']);
      return;
    }

    if (DEBUG) {
      const lines = ['destination=' + destination, 'shops=' + shops.length, 'items=' + totalItems, ''];
      for (const sh of shops) {
        lines.push('  [' + sh.category + '] ' + sh.items.length + ' items');
        for (const it of sh.items.slice(0, 3)) {
          lines.push('    - ' + it.name + ' (id=' + it.item_id + ') stock=' + it.stock + ' $' + it.buy_price);
        }
        if (sh.items.length > 3) lines.push('    ... +' + (sh.items.length - 3) + ' more');
      }
      debugPanel(lines);
    }

    // Collect the item_ids we need sell prices for (single Supabase GET).
    const itemIds = [];
    const seen = new Set();
    for (const sh of shops) {
      for (const it of sh.items) {
        if (!seen.has(it.item_id)) {
          seen.add(it.item_id);
          itemIds.push(it.item_id);
        }
      }
    }

    // Surface silent selector drift: if nearestShopCategoryFor couldn't
    // match any heading in an item's ancestry, rows get tagged 'Unknown'.
    // On iPad with no DevTools that's indistinguishable from a real
    // scrape — the user just thinks it worked. Add a visible count to
    // the success toast so a Torn DOM change shows up as "UAE: 48 prices
    // (3 unknown)" instead of a silent degradation.
    const unknownCount = shops.reduce(function (s, sh) {
      return s + (sh.category === 'Unknown' ? sh.items.length : 0);
    }, 0);

    // Fire ingest (POST) and sell-price fetch (GET) in parallel. Overlay
    // render waits only on the sell-price fetch; ingest toast fires
    // independently when its POST resolves.
    const ingestPromise = (async function () {
      const result = await postIngest({
        api_key: TORN_API_KEY,
        destination: destination,
        shops: shops,
      });
      if (result.ok) {
        const suffix = unknownCount > 0
          ? ' (' + unknownCount + ' unknown)'
          : '';
        const toneForUnknown = unknownCount > 0 ? 'warning' : 'success';
        toast(destination + ': ' + result.count + ' prices' + suffix, toneForUnknown);
      } else {
        toast(friendlyIngestError('Travel ' + destination, totalItems, result), 'error');
      }
    })();

    // Identify items currently at stock 0 — those are the only rows where
    // a refill ETA is useful to show. Skipping the fetch entirely when none
    // are zero-stock keeps the common case (fully stocked shelves) free of
    // an extra round-trip.
    const zeroStockIds = [];
    const seenZero = new Set();
    for (const sh of shops) {
      for (const it of sh.items) {
        if (it.stock === 0 && !seenZero.has(it.item_id)) {
          seenZero.add(it.item_id);
          zeroStockIds.push(it.item_id);
        }
      }
    }

    const overlayPromise = (async function () {
      try {
        const [sellPriceMap, restockEventsMap] = await Promise.all([
          fetchSellPrices(itemIds),
          zeroStockIds.length > 0
            ? fetchRestockEvents(zeroStockIds, destination)
            : Promise.resolve(new Map()),
        ]);
        const refillEtaMap = new Map();
        const nowMs = Date.now();
        for (const entry of restockEventsMap) {
          const itemId = entry[0];
          const events = entry[1];
          const etaMins = estimateRefillMins(events, nowMs);
          if (etaMins != null) refillEtaMap.set(itemId, etaMins);
        }
        const stats = renderOverlay(shops, sellPriceMap, refillEtaMap);
        if (DEBUG) {
          const bestLine = stats.best
            ? ('best=' + stats.best.item_id + ' margin=' + Math.round(stats.best.metrics.marginPerItem))
            : 'best=(none eligible)';
          debugPanel([
            'destination=' + destination,
            'overlay rows=' + stats.total + ' with-metrics=' + stats.withMetrics,
            bestLine,
          ]);
        }
      } catch (err) {
        log('overlay error:', err);
      }
    })();

    await Promise.all([ingestPromise, overlayPromise]);
  }

  // -- Item page (item.php) ------------------------------------------------
  // Torn's own Items page (item.php) lists every item the player owns,
  // broken up into category tabs (Flowers / Plushies / Drugs / ...). The
  // Torn API's v1 `user/?selections=inventory` path has been deprecated
  // ("The inventory selection is no longer available") and the v2
  // replacement has had flaky rollout on PDA — but the page itself is
  // right there in the browser, so we scrape it directly.
  //
  // What this runner does:
  //   1. Scrape the currently-visible category tab for { item_id, name, qty }.
  //   2. Query te_buy_prices for those item_ids and find the single highest
  //      buy-offer per item (anon SELECT — public data).
  //   3. Inject a green "Best Sell Opportunities" bar at the top of the
  //      page, summarising the rows whose best offer × qty is largest.
  //
  // Earlier versions (≤0.8.4) merged every scrape into a 24-hour
  // localStorage cache so all tabs visited in a session accumulated in the
  // bar. That made just-sold items linger and mixed categories — when the
  // player is on "Plushies" they only want to see plushies, not the
  // flowers they scrolled past ten minutes ago. Dropping the cache gives
  // an always-current view scoped to the visible tab; the MutationObserver
  // already rescrapes on every tab switch, so the bar tracks the DOM.

  const ITEM_PAGE_BAR_ID = 'valigia-sell-opportunities-bar';
  const TE_BUY_PRICES_URL = SUPABASE_REST_URL + '/te_buy_prices';

  // Walk up from el to body; return true if any ancestor (or el itself) is
  // actually rendered. Torn's items page keeps every previously-rendered
  // category tab alive in the DOM and hides the inactive ones — some with
  // display:none, some with zero-height collapses. innerText *should* skip
  // display:none text but in practice on PDA's webview it sometimes still
  // returns the text for those nodes, so an explicit geometry check is the
  // reliable filter.
  function isRowVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  // Scrape the currently-visible category's item rows. Uses the same
  // /images/items/{id}/ selector other runners rely on, plus the shared
  // rowContainer() heuristic to tolerate Torn's <tr>/<div> drift, then
  // filters to only rows that are actually on screen so hidden category
  // tabs don't leak into the bar.
  function scrapeItemPageRows() {
    const imgs = Array.from(document.querySelectorAll('img[src*="/images/items/"]'));
    const rows = new Map();
    const seenRows = new Set();
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const idMatch = src.match(/\/images\/items\/(\d+)\//);
      if (!idMatch) continue;
      const item_id = Number(idMatch[1]);

      const row = rowContainer(img);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);

      // Filter hidden category tabs still present in the DOM.
      if (!isRowVisible(row)) continue;

      // Skip the left sidebar's item-icon row (category tabs, equipped
      // preview) — those have images but no "x{N}" count next to them.
      const text = (row.innerText || '').trim();
      const qtyMatch = text.match(/\bx\s*([\d,]+)\b/i);
      if (!qtyMatch) continue;
      const quantity = Number(qtyMatch[1].replace(/,/g, ''));
      if (!Number.isInteger(quantity) || quantity <= 0) continue;

      const altName = (img.getAttribute('alt') || '').trim();
      // Fall back to the text before the "xN" if alt is empty. Keep it
      // short — a row can have follow-on text like "Send", "Destroy",
      // prices, etc., and we only want the name.
      const nameFromText = text.split(/\bx\s*[\d,]+\b/i)[0]
        .replace(/\s+/g, ' ')
        .trim();
      const name = altName || nameFromText.slice(0, 60);
      if (!name) continue;

      rows.set(item_id, { item_id, name, quantity, observed_at: Date.now() });
    }
    return rows;
  }

  async function fetchTeBuyPricesFor(itemIds) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) return new Map();
    const url = TE_BUY_PRICES_URL +
      '?select=handle,item_id,item_name,buy_price,updated_at' +
      '&item_id=in.(' + itemIds.join(',') + ')';
    try {
      const res = await gmRequest({
        method: 'GET',
        url: url,
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Accept': 'application/json',
        },
      });
      if (res.status < 200 || res.status >= 300) return new Map();
      const rows = JSON.parse(res.responseText || '[]');
      // Collapse to best (highest) buy_price per item_id. Freshness is a
      // tiebreak so a newly-scraped trader wins ties over an old one.
      const best = new Map();
      for (const r of rows) {
        if (!r || typeof r.item_id !== 'number' || typeof r.buy_price !== 'number') continue;
        const existing = best.get(r.item_id);
        if (
          !existing
          || r.buy_price > existing.buy_price
          || (r.buy_price === existing.buy_price && (r.updated_at || '') > (existing.updated_at || ''))
        ) {
          best.set(r.item_id, r);
        }
      }
      return best;
    } catch (_) {
      return new Map();
    }
  }

  function injectItemPageStyles() {
    if (document.getElementById('valigia-itempage-styles')) return;
    const st = document.createElement('style');
    st.id = 'valigia-itempage-styles';
    st.textContent = `
      #${ITEM_PAGE_BAR_ID} {
        font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
        background: #0d0f14;
        color: #c8cdd8;
        border: 1px solid #252a35;
        border-left: 3px solid #4ae8a0;
        border-radius: 4px;
        margin: 8px 0;
        overflow: hidden;
      }
      #${ITEM_PAGE_BAR_ID} summary {
        list-style: none;
        cursor: pointer;
        padding: 10px 12px;
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
      }
      #${ITEM_PAGE_BAR_ID} summary::-webkit-details-marker { display: none; }
      #${ITEM_PAGE_BAR_ID} summary::before {
        content: '\\25B8'; /* \u25B8 right-pointing triangle — escaped so a miscoded file doesn't mojibake the glyph */
        color: #4ae8a0;
        transition: transform 120ms ease;
      }
      #${ITEM_PAGE_BAR_ID}[open] summary::before { transform: rotate(90deg); }
      #${ITEM_PAGE_BAR_ID} .v-ip-title {
        font-weight: 700;
        color: #4ae8a0;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        font-size: 11px;
      }
      #${ITEM_PAGE_BAR_ID} .v-ip-count {
        font-weight: 400;
        color: #5a6070;
        margin-left: auto;
        font-size: 11px;
      }
      #${ITEM_PAGE_BAR_ID} .v-ip-total {
        color: #4ae8a0;
        font-weight: 700;
      }
      #${ITEM_PAGE_BAR_ID} .v-ip-rows {
        border-top: 1px solid #252a35;
        max-height: 60vh;
        overflow-y: auto;
      }
      #${ITEM_PAGE_BAR_ID} .v-ip-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto auto;
        align-items: center;
        gap: 8px 10px;
        padding: 8px 12px;
        border-bottom: 1px solid #1a1e27;
        text-decoration: none;
        color: #c8cdd8;
        font-size: 12px;
      }
      #${ITEM_PAGE_BAR_ID} .v-ip-row:last-child { border-bottom: 0; }
      #${ITEM_PAGE_BAR_ID} .v-ip-row:hover { background: rgba(74, 232, 160, 0.05); }
      #${ITEM_PAGE_BAR_ID} .v-ip-qty { color: #5a6070; font-variant-numeric: tabular-nums; }
      #${ITEM_PAGE_BAR_ID} .v-ip-item { font-weight: 700; color: #c8cdd8; }
      #${ITEM_PAGE_BAR_ID} .v-ip-trader { color: #e8c84a; font-size: 11px; }
      #${ITEM_PAGE_BAR_ID} .v-ip-price { color: #4ae8a0; white-space: nowrap; font-variant-numeric: tabular-nums; }
      #${ITEM_PAGE_BAR_ID} .v-ip-unit { color: #5a6070; font-size: 10px; }
      #${ITEM_PAGE_BAR_ID} .v-ip-stack { color: #c8cdd8; white-space: nowrap; font-variant-numeric: tabular-nums; font-size: 11px; }
    `;
    document.head.appendChild(st);
  }

  function fmtMoney(n) {
    if (!Number.isFinite(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function buildItemPageBar(matches) {
    injectItemPageStyles();

    const totalPay = matches.reduce((s, m) => s + m.total, 0);

    const details = document.createElement('details');
    details.id = ITEM_PAGE_BAR_ID;

    const summary = document.createElement('summary');
    summary.innerHTML = `
      <span class="v-ip-title">Best sell opportunities</span>
      <span class="v-ip-total">${fmtMoney(totalPay)}</span>
      <span class="v-ip-count">${matches.length} item${matches.length === 1 ? '' : 's'}</span>
    `;
    details.appendChild(summary);

    const rowsEl = document.createElement('div');
    rowsEl.className = 'v-ip-rows';
    for (const m of matches) {
      const a = document.createElement('a');
      a.className = 'v-ip-row';
      a.href = 'https://tornexchange.com/prices/' + encodeURIComponent(m.offer.handle) + '/';
      a.target = '_blank';
      a.rel = 'noopener';
      // \u-escape the multiplication sign and arrow. InMotion's FTP deploy
      // serves the userscript without an explicit UTF-8 charset header and
      // PDA's webview has been seen to render raw bytes as Latin-1, turning
      // "x" (U+00D7) into "Ã" + garbage. Escaped forms are safe regardless.
      a.innerHTML = `
        <span class="v-ip-qty">${m.item.quantity.toLocaleString('en-US')}\u00d7</span>
        <span class="v-ip-item">${escapeHtml(m.offer.item_name || m.item.name)} <span class="v-ip-trader">\u2192 ${escapeHtml(m.offer.handle)}</span></span>
        <span class="v-ip-price">${fmtMoney(m.offer.buy_price)}<span class="v-ip-unit">/ea</span></span>
        <span class="v-ip-stack">${fmtMoney(m.total)}</span>
      `;
      rowsEl.appendChild(a);
    }
    details.appendChild(rowsEl);

    return details;
  }

  // Lightweight HTML escape — other runners use a shared one but it's not
  // exported in this script, so keep a local copy to avoid reshuffling.
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function renderItemPageBar(inventory) {
    const prev = document.getElementById(ITEM_PAGE_BAR_ID);
    if (!inventory || inventory.size === 0) {
      if (prev) prev.remove();
      return;
    }

    const ids = Array.from(inventory.keys());
    const offers = await fetchTeBuyPricesFor(ids);

    const matches = [];
    for (const [id, row] of inventory) {
      const offer = offers.get(id);
      if (!offer) continue;
      matches.push({ item: row, offer, total: offer.buy_price * row.quantity });
    }
    matches.sort((a, b) => b.total - a.total);

    const after = document.getElementById(ITEM_PAGE_BAR_ID);
    if (matches.length === 0) {
      if (after) after.remove();
      return;
    }
    const bar = buildItemPageBar(matches);
    if (after) after.replaceWith(bar);
    else {
      const host =
        document.querySelector('#mainContainer .content-wrapper') ||
        document.querySelector('.content-wrapper') ||
        document.querySelector('#mainContainer') ||
        document.body;
      host.insertBefore(bar, host.firstChild);
    }
  }

  // Debounced scrape + render. Torn switches category tabs in two
  // different ways depending on whether the tab has been visited this
  // session: sometimes a full DOM rebuild (new item images added —
  // observable via childList), sometimes a pure CSS toggle on a cached
  // tree (no nodes added, only class/style attributes change). We
  // schedule a scan on ANY mutation and let a hash guard collapse
  // no-op re-renders, so both cases land on the same code path.
  //
  // The debounce resets on every mutation (so a burst of 20 mutations
  // in 5ms collapses into one scan), but a max-wait guarantees the
  // scan still fires ~1.2s after the first mutation even if mutations
  // keep arriving — otherwise a constantly-ticking UI element could
  // starve the scan forever.
  let itemPageScheduled = null;
  let itemPageFirstMutation = 0;
  let lastRenderedHash = null;

  function scheduleItemPageScan(reason) {
    const now = Date.now();
    if (!itemPageFirstMutation) itemPageFirstMutation = now;
    if (itemPageScheduled) clearTimeout(itemPageScheduled);

    const DEBOUNCE_MS = 300;
    const MAX_WAIT_MS = 1200;
    const elapsed = now - itemPageFirstMutation;
    const wait = elapsed >= MAX_WAIT_MS ? 0 : Math.min(DEBOUNCE_MS, MAX_WAIT_MS - elapsed);

    itemPageScheduled = setTimeout(async function () {
      itemPageScheduled = null;
      itemPageFirstMutation = 0;
      try {
        const fresh = scrapeItemPageRows();
        // Hash the visible set (ids + quantities, sorted) so we can
        // skip re-renders when nothing changed. Crucial: the bar's own
        // DOM insertion feeds the observer, and without this guard
        // that would loop forever.
        const ids = Array.from(fresh.keys()).sort(function (a, b) { return a - b; });
        const hash = ids.length === 0
          ? ''
          : ids.map(function (id) { return id + ':' + fresh.get(id).quantity; }).join(',');
        if (hash === lastRenderedHash) return;
        lastRenderedHash = hash;
        log('item.php: scrape reason=' + reason + ' size=' + fresh.size);
        await renderItemPageBar(fresh);
      } catch (e) {
        log('item.php scan error:', e);
      }
    }, wait);
  }

  async function runItemPage() {
    // First pass on whatever is currently rendered.
    scheduleItemPageScan('initial');

    // Watch for tab-switch triggers. We observe the whole body with
    // childList + attributes so both full-DOM-swap and class-toggle
    // forms of category switching are caught. The callback is
    // unconditional — the debounce + hash guard handle noise.
    const observer = new MutationObserver(function () {
      scheduleItemPageScan('mutation');
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
    // Tear down if the PDA dispatcher fires again for a different URL
    // (e.g. user navigates to the Item Market). The existing
    // scheduleDispatch() flow doesn't explicitly cancel observers, but
    // hashchange is its main trigger and a hashchange → different page
    // → rowContainer wouldn't find item images anyway.
    window.addEventListener('hashchange', function once() {
      observer.disconnect();
      window.removeEventListener('hashchange', once);
    });

    // Not pinging the scout counter here — record-pda-activity's
    // ALLOWED_PAGE_TYPES is currently {travel, item_market, bazaar} and
    // expanding it belongs in its own change. This runner's value to
    // the player is immediate (the bar scoped to the visible tab); the
    // scouts counter is vanity.
  }

  // -- Drip-scrape -----------------------------------------------------------
  // Background bazaar-pool maintenance. On every dispatch (except the
  // bazaar runner, which already writes heavily to bazaar_prices via DOM
  // scraping), fire one v2 `market/{id}/bazaar` discovery call against
  // a stale-but-valuable item picked from the shared pool. Throttle gate
  // (per-user, localStorage) caps the spend at one Torn API call per
  // DRIP_MIN_INTERVAL_MS. Distributed across the userbase this keeps
  // the pool fresh without any single player burning meaningful API
  // budget — and no third-party data dependency.
  //
  // Candidate selection: top-N items from sell_prices by market value,
  // cross-referenced against the freshest bazaar_prices entry for each.
  // Items whose freshest bazaar entry is younger than
  // DRIP_BAZAAR_FRESH_WINDOW_MS get filtered out — no point re-checking
  // an item the pool already knows about. The remaining list is cached
  // in localStorage for DRIP_CANDIDATE_TTL_MS so most page visits
  // skip the two PostgREST reads entirely.

  const DRIP_GATE_KEY = 'valigia_drip_last_at';
  const DRIP_CANDIDATE_CACHE_KEY = 'valigia_drip_candidates';
  // Min interval between drips for a single user. With ~6 page navs per
  // active minute, this caps drip spend at ~1 Torn call per minute per
  // user — under 1% of the 100/min key budget.
  const DRIP_MIN_INTERVAL_MS = 60 * 1000;
  // Candidate list refresh cadence. The list itself is cheap to derive
  // (two PostgREST reads), but doing it on every drip would double the
  // API spend per user with no real benefit.
  const DRIP_CANDIDATE_TTL_MS = 10 * 60 * 1000;
  // Pull this many top-value items from sell_prices as the drip pool.
  const DRIP_CANDIDATE_POOL_SIZE = 30;
  // Don't drip cheap items — a $500 plushie's bazaar coverage doesn't
  // matter, and we'd rather spend the budget on the long tail of
  // high-value goods.
  const DRIP_VALUE_FLOOR = 10_000;
  // Skip items whose freshest bazaar entry is younger than this. Web
  // app's "Best Run" eligibility window is 10 min, so 30 min gives
  // plenty of buffer to avoid double-checking items the pool already
  // tracks well.
  const DRIP_BAZAAR_FRESH_WINDOW_MS = 30 * 60 * 1000;

  let dripInFlight = false;

  function dripGateLastAt() {
    try { return Number(localStorage.getItem(DRIP_GATE_KEY)) || 0; }
    catch (_) { return 0; }
  }
  function dripGateMark() {
    try { localStorage.setItem(DRIP_GATE_KEY, String(Date.now())); }
    catch (_) { /* ignore quota / disabled storage */ }
  }

  /**
   * Build (or retrieve from cache) the list of items eligible for the
   * next drip. Each item is { item_id, price, age_ms } where age_ms is
   * how long since the freshest known bazaar entry for that item (or
   * Number.MAX_SAFE_INTEGER if no entries exist at all — those are the
   * highest-priority drip targets).
   */
  async function loadDripCandidates() {
    try {
      const raw = localStorage.getItem(DRIP_CANDIDATE_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && cached.fetchedAt &&
            Date.now() - cached.fetchedAt < DRIP_CANDIDATE_TTL_MS &&
            Array.isArray(cached.items)) {
          return cached.items;
        }
      }
    } catch (_) { /* corrupt cache - fall through to refetch */ }

    const sellRows = await fetchJSON(
      SELL_PRICES_URL +
      '?price=gte.' + DRIP_VALUE_FLOOR +
      '&select=item_id,price' +
      '&order=price.desc' +
      '&limit=' + DRIP_CANDIDATE_POOL_SIZE
    );
    if (!Array.isArray(sellRows) || sellRows.length === 0) return [];

    const ids = sellRows.map(function (r) { return r.item_id; });
    const bazRows = await fetchJSON(
      BAZAAR_PRICES_URL +
      '?item_id=in.(' + ids.join(',') + ')' +
      '&select=item_id,checked_at' +
      '&order=checked_at.desc' +
      '&limit=500'
    );
    const freshestByItem = new Map();
    if (Array.isArray(bazRows)) {
      for (const r of bazRows) {
        const t = r.checked_at ? new Date(r.checked_at).getTime() : 0;
        const prev = freshestByItem.get(r.item_id) || 0;
        if (t > prev) freshestByItem.set(r.item_id, t);
      }
    }

    const now = Date.now();
    const candidates = sellRows
      .map(function (r) {
        const fresh = freshestByItem.get(r.item_id) || 0;
        const ageMs = fresh === 0 ? Number.MAX_SAFE_INTEGER : now - fresh;
        return { item_id: r.item_id, price: Number(r.price), age_ms: ageMs };
      })
      .filter(function (c) { return c.age_ms >= DRIP_BAZAAR_FRESH_WINDOW_MS; });

    try {
      localStorage.setItem(DRIP_CANDIDATE_CACHE_KEY, JSON.stringify({
        fetchedAt: now,
        items: candidates,
      }));
    } catch (_) { /* ignore quota / disabled storage */ }

    return candidates;
  }

  /**
   * Score candidates by `price × log(age_hours + 1) × jitter`. The log
   * softens staleness so a $1M item that's 1 h old still beats a $50k
   * item that's 24 h old. Take the top 5 and pick one at random — that
   * gives concentrated effort on the most valuable stale items while
   * still spreading load when many users converge on the same shortlist.
   */
  function pickDripCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const scored = candidates.map(function (c) {
      const ageHours = Math.max(c.age_ms / 3_600_000, 0.1);
      const jitter = 0.8 + Math.random() * 0.4;
      return Object.assign({}, c, { score: c.price * Math.log(ageHours + 1) * jitter });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    const top = scored.slice(0, Math.min(5, scored.length));
    return top[Math.floor(Math.random() * top.length)];
  }

  /**
   * Parse Torn v2 `market/{id}/bazaar` response. The shape varies:
   * sometimes `bazaar` is a flat array of listings, sometimes an object
   * keyed by category whose values are arrays. Handle both. Drop $1 and
   * sub-$1 entries — they're locked-listing placeholders that would
   * pollute the pool.
   */
  function parseV2BazaarResponse(data) {
    if (!data || !data.bazaar) return [];
    const out = [];
    function handle(e) {
      const id = Number(e && (e.ID != null ? e.ID : e.id));
      const price = Number(e && e.price);
      const qtyRaw = e && (e.quantity != null ? e.quantity : 1);
      const quantity = Number(qtyRaw);
      if (!Number.isInteger(id) || id <= 0) return;
      if (!Number.isFinite(price) || price <= 1) return;
      out.push({
        owner_id: id,
        price: price,
        quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
      });
    }
    if (Array.isArray(data.bazaar)) {
      for (const e of data.bazaar) handle(e);
    } else if (typeof data.bazaar === 'object') {
      for (const cat of Object.values(data.bazaar)) {
        if (Array.isArray(cat)) for (const e of cat) handle(e);
      }
    }
    return out;
  }

  /**
   * Top-level drip entry. Idempotent and silent — the gate + in-flight
   * flag mean rapid repeated calls collapse to one. Always returns
   * before any heavy work if the user isn't inside PDA, the gate
   * hasn't elapsed, or there's nothing worth dripping. Errors swallowed
   * so the dispatcher's main flow is never disrupted.
   */
  async function dripScrapeBazaarPool() {
    if (dripInFlight) return;
    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) return;
    if (Date.now() - dripGateLastAt() < DRIP_MIN_INTERVAL_MS) return;
    dripInFlight = true;
    // Mark the gate immediately so a slow drip + rapid nav can't fire
    // a second one in flight before this one writes the timestamp.
    dripGateMark();
    try {
      const candidates = await loadDripCandidates();
      const pick = pickDripCandidate(candidates);
      if (!pick) return;

      const res = await gmRequest({
        method: 'GET',
        url: 'https://api.torn.com/v2/market/' + encodeURIComponent(pick.item_id) +
             '/bazaar?key=' + encodeURIComponent(TORN_API_KEY),
        headers: { 'Accept': 'application/json' },
      });
      let data = null;
      try { data = JSON.parse(res.responseText); } catch (_) { return; }
      if (data && data.error) {
        log('drip: torn error', data.error);
        return;
      }
      const listings = parseV2BazaarResponse(data);
      if (listings.length === 0) {
        log('drip: no listings for item ' + pick.item_id);
        return;
      }

      const rows = listings.map(function (l) {
        return {
          item_id: pick.item_id,
          bazaar_owner_id: l.owner_id,
          price: l.price,
          quantity: l.quantity,
          miss_count: 0,
        };
      });
      const result = await postIngestRows(INGEST_BAZAAR_URL, rows);
      if (result.ok) {
        log('drip: stored ' + result.count + ' listings for item ' + pick.item_id);
      } else {
        log('drip: ingest failed', result.error);
      }
    } catch (err) {
      log('drip: unexpected error', err);
    } finally {
      dripInFlight = false;
    }
  }

  // -- Dispatch ------------------------------------------------------------
  // Route the current page to the right runner. The PDA-APIKEY placeholder
  // check stays as the single gate: only run inside Torn PDA. Outside PDA
  // the script goes fully quiet rather than writing to the community pool
  // from an environment we didn't design around.
  function detectPage() {
    const url = location.href;
    if (/\/page\.php\?.*sid=travel\b/i.test(url)) return 'travel';
    if (/\/page\.php\?.*sid=ItemMarket\b/i.test(url)) return 'itemmarket';
    if (/\/bazaar\.php/i.test(url)) return 'bazaar';
    if (/\/item\.php/i.test(url)) return 'itempage';
    return null;
  }

  async function dispatch() {
    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) {
      log('Not running inside PDA - aborting.');
      return;
    }
    const page = detectPage();
    // Stakeout badge + auto-rescrape interval are travel-page-only. Tear
    // them down on every dispatch and let runTravel() re-mount if
    // applicable. Skips the teardown during a stakeout-driven re-run
    // (page is still 'travel'), which would otherwise stop its own loop.
    if (page !== 'travel') tearDownStakeout();
    // Background drip-scrape — fire and forget, in parallel with the
    // page runner. Skipped on bazaar pages where the runner already
    // writes heavily to bazaar_prices and would just race the drip
    // against the per-endpoint rate limiter. Per-user throttle gate
    // (60s) inside dripScrapeBazaarPool() makes this safe to call on
    // every dispatch.
    if (page && page !== 'bazaar') {
      dripScrapeBazaarPool().catch(function (e) { log('drip error', e); });
    }
    switch (page) {
      case 'travel':     return runTravel();
      case 'itemmarket': return runItemMarket();
      case 'bazaar':     return runBazaar();
      case 'itempage':   return runItemPage();
      default:
        log('Unmatched page - skipping. url=' + location.href);
    }
  }

  // Dispatch scheduler. Two entry points fire it: the initial DOM-ready
  // landing, and any SPA hash change (the Item Market's #/market/view=... URL
  // shape is hash-routed, so clicking between items never triggers
  // DOMContentLoaded again). The `lastDispatchedUrl` guard skips redundant
  // dispatches when the full URL hasn't actually changed, and a small
  // debounce collapses bursts of rapid nav events into one run.
  let lastDispatchedUrl = null;
  let dispatchTimer = null;
  function scheduleDispatch(reason) {
    if (dispatchTimer) clearTimeout(dispatchTimer);
    dispatchTimer = setTimeout(async function () {
      dispatchTimer = null;
      if (location.href === lastDispatchedUrl) {
        log('dispatch skipped (same url) reason=' + reason);
        return;
      }
      lastDispatchedUrl = location.href;
      log('dispatch reason=' + reason);
      try { await dispatch(); } catch (e) { log('dispatch error:', e); }
    }, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded',
      function () { scheduleDispatch('initial'); }, { once: true });
  } else {
    scheduleDispatch('initial');
  }
  window.addEventListener('hashchange',
    function () { scheduleDispatch('hashchange'); });
})();
