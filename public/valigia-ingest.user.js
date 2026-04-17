// ==UserScript==
// @name         Valigia
// @namespace    https://valigia.girovagabondo.com/
// @version      0.6.0
// @description  Inside Torn PDA, contribute to Valigia's shared price pool from three pages: (1) the travel shop — push fresh abroad buy prices + overlay per-row margins, (2) the Item Market — push fresh sell prices into the community cache + surface your Watchlist matches, (3) any bazaar — push fresh bazaar listings + owner + show Watchlist matches so you spot a deal the moment you open a bazaar.
// @author       drumorgan
// @match        https://www.torn.com/page.php?sid=travel*
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @match        https://www.torn.com/bazaar.php*
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
    const bg = kind === 'error' ? '#b33' : kind === 'success' ? '#2a7' : '#333';
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
        GM.xmlHttpRequest(base).then(resolve, reject);
      } else {
        reject(new Error('No GM_xmlhttpRequest available - install as userscript in PDA'));
      }
    });
  }

  async function postIngest(payload) {
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
    let parsed = null;
    try { parsed = JSON.parse(res.responseText); } catch (e) { /* ignore */ }
    return { status: res.status, body: parsed, raw: res.responseText };
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

  // -- Ingest edge-function post ------------------------------------------
  // Layer 2 security hardening: writes to sell_prices / bazaar_prices flow
  // through ingest-sell-prices / ingest-bazaar-prices. Each validates
  // TORN_API_KEY via user/?selections=basic and stamps observer_player_id
  // onto every row before a service-role upsert. Same pattern as
  // ingest-travel-shop — one extra Torn API round-trip per scrape, paid
  // out of the player's own 100/min budget.
  async function postIngestRows(ingestUrl, rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: true, count: 0 };
    }
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
      const err = (body && body.error) || ('HTTP ' + res.status);
      return { ok: false, error: err, raw: res.responseText };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
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
  function renderOverlay(shops, sellPriceMap) {
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
          html += '<span class="v-muted">stock 0 &middot; skip</span>';
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
      toast('Item Market: ' + result.count + ' prices collected \u00B7 thanks!', 'success');
      pingActivity('item_market');
    } else {
      toast('market upsert failed - ' + (result.error || 'unknown'), 'error');
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

      const text = (row.innerText || '').trim();
      const priceMatch = text.match(/\$\s*([\d,\.]+)/);
      if (!priceMatch) continue;
      const price = parseMoney(priceMatch[1]);
      if (!Number.isFinite(price) || price <= 0) continue;

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

    const result = await postIngestRows(INGEST_BAZAAR_URL, rows);
    if (result.ok) {
      toast('Bazaar: ' + result.count + ' prices collected \u00B7 thanks!', 'success');
      pingActivity('bazaar');
    } else {
      toast('bazaar upsert failed - ' + (result.error || 'unknown'), 'error');
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

  // Bazaar rows older than this are dropped — matches the web app's
  // 10-minute threshold so the bar doesn't claim a stale deal.
  const WATCHLIST_BAZAAR_MAX_AGE_MS = 10 * 60 * 1000;

  // Item Market rows older than this are dropped. Mirrors the web
  // app's 4-hour MARKET_MAX_AGE_MS so a stale floor (e.g. someone
  // scraped Lucky Quarter 11 hours ago and the listing has long since
  // been bought) can't masquerade as a current match. The web app
  // tops up watchlisted items on every dashboard load, so a price
  // that still holds will quickly re-appear here.
  const WATCHLIST_MARKET_MAX_AGE_MS = 4 * 60 * 60 * 1000;

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

    try {
      const res = await fetch(
        'https://api.torn.com/user/?selections=basic&key=' + encodeURIComponent(TORN_API_KEY)
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.player_id) {
        try {
          localStorage.setItem(
            PLAYER_ID_CACHE_KEY,
            JSON.stringify({ hash: keyHash, player_id: data.player_id })
          );
        } catch (_) { /* ignore quota / disabled storage */ }
        return data.player_id;
      }
    } catch (_) { /* network / CORS — skip silently */ }
    return null;
  }

  async function fetchJSON(url) {
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) return null;
    try { return await res.json(); } catch (_) { return null; }
  }

  /**
   * Read alerts for this player, then look up live market/bazaar prices
   * for the alerted items and compute the match list. Returns [] on any
   * failure so callers can treat "no matches" and "fetch failed"
   * identically — a silent no-op is the right failure mode for a banner.
   */
  async function fetchWatchlistMatches(playerId) {
    if (!playerId) return [];

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
        '&select=item_id,price,updated_at'
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
        if (s && Number(s.price) <= maxPrice) {
          const observedAt = s.updated_at ? new Date(s.updated_at).getTime() : 0;
          const fresh = observedAt > 0 && Date.now() - observedAt <= WATCHLIST_MARKET_MAX_AGE_MS;
          if (fresh) {
            const price = Number(s.price);
            matches.push({
              item_id: a.item_id,
              venue: 'market',
              venue_label: 'Item Market',
              price: price,
              max_price: maxPrice,
              savings: maxPrice - price,
              savings_pct: ((maxPrice - price) / maxPrice) * 100,
              observed_at: observedAt,
              link: 'https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=' + a.item_id,
              extra: {},
            });
          }
        }
      }
      if (venues.has('bazaar')) {
        const b = bazaarByItem.get(a.item_id);
        if (b && Number(b.price) <= maxPrice) {
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
    if (n == null) return '—';
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
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

  // Resolve the item id → name map we already maintain in the travel
  // runner's cache. Falls back to "Item #N" if we haven't seen it.
  function itemNameFor(itemId) {
    try {
      const raw = localStorage.getItem('valigia_item_id_map');
      if (raw) {
        const nameToId = JSON.parse(raw);
        for (const name in nameToId) {
          if (Number(nameToId[name]) === Number(itemId)) return name;
        }
      }
    } catch (_) { /* ignore */ }
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
    caret.textContent = '▾';
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

      const age = document.createElement('span');
      age.className = 'vgl-wl-age';
      age.textContent = formatAge(m.observed_at);

      const arrow = document.createElement('span');
      arrow.className = 'vgl-wl-arrow';
      arrow.textContent = '→';

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

    const matches = await fetchWatchlistMatches(playerId);
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

  // -- Main ----------------------------------------------------------------
  async function runTravel() {
    const destination = detectDestination();
    if (!destination) {
      log('No "You are in X" marker - probably not landed yet.');
      return;
    }

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

    // Fire ingest (POST) and sell-price fetch (GET) in parallel. Overlay
    // render waits only on the sell-price fetch; ingest toast fires
    // independently when its POST resolves.
    const ingestPromise = (async function () {
      try {
        const result = await postIngest({
          api_key: TORN_API_KEY,
          destination: destination,
          shops: shops,
        });
        const status = result.status;
        const body = result.body;
        if (status >= 200 && status < 300 && body && body.ok) {
          toast(destination + ': ' + body.stored + ' prices collected \u00B7 thanks!', 'success');
        } else {
          const msg = (body && body.error) || ('HTTP ' + status);
          toast('ingest failed - ' + msg, 'error');
        }
      } catch (err) {
        toast('network error - ' + (err && err.message || err), 'error');
      }
    })();

    const overlayPromise = (async function () {
      try {
        const sellPriceMap = await fetchSellPrices(itemIds);
        const stats = renderOverlay(shops, sellPriceMap);
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
    return null;
  }

  async function dispatch() {
    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) {
      log('Not running inside PDA - aborting.');
      return;
    }
    const page = detectPage();
    switch (page) {
      case 'travel':     return runTravel();
      case 'itemmarket': return runItemMarket();
      case 'bazaar':     return runBazaar();
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
