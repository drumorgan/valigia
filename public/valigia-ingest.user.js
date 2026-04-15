// ==UserScript==
// @name         Valigia
// @namespace    https://valigia.girovagabondo.com/
// @version      0.2.0
// @description  Inside Torn PDA, scrape the travel shop and push fresh buy prices to Valigia's shared pool, then overlay profit-per-hour math on each shop row so the best-buy item is visible in-game.
// @author       drumorgan
// @match        https://www.torn.com/page.php?sid=travel*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      vtslzplzlxdptpvxtanz.supabase.co
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
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0c2x6cGx6bHhkcHRwdnh0YW56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MzQyNTMsImV4cCI6MjA5MTQxMDI1M30.Ddzoq8bCmWc875gbdQKhqnR5M7TraWWj4TYS4RRKkMY';

  // Flip to true to draw an always-on debug panel on the Torn page showing
  // exactly what the parser found. Useful on iPad where DevTools is absent.
  const DEBUG = false;

  // -- Overlay defaults (see CLAUDE.md: "Goal #2 user prefs, option A") ----
  // Hardcoded for v1. If you want per-device overrides later, swap these for
  // values read from a small in-overlay gear icon persisted to PDA local-
  // storage (keyed on 'valigia_prefs'). The overlay stays directionally
  // correct for most players at these defaults.
  const DEFAULT_SLOT_COUNT = 29;
  // 1.0 = Standard, 0.7 = Airstrip/WLT, 0.49 = both. We default to Standard
  // because it applies to everyone; the user can still fly Airstrip and
  // treat the displayed profit/hr as a conservative floor.
  const DEFAULT_FLIGHT_MULTIPLIER = 1.0;

  // Public Supabase PostgREST endpoint for reading the sell_prices cache.
  // Same anon key we use for the edge function POST; RLS on sell_prices
  // allows SELECT to everyone (see migration 002_sell_prices.sql).
  const SELL_PRICES_URL =
    'https://vtslzplzlxdptpvxtanz.supabase.co/rest/v1/sell_prices';

  // One-way flight times in minutes. Mirrors src/data/destinations.js in the
  // main app. Keyed on whatever detectDestination() returns from the page.
  const FLIGHT_MINS = {
    'Mexico': 20,
    'Cayman Islands': 57,
    'Caymans': 57,
    'Canada': 37,
    'Hawaii': 121,
    'United Kingdom': 152,
    'UK': 152,
    'Argentina': 189,
    'Switzerland': 169,
    'Japan': 203,
    'China': 219,
    'UAE': 259,
    'South Africa': 311,
  };

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

  // -- Profit math (mirrors src/calculator.js in the main app) -------------
  // Returns the shape the overlay renderer expects. Null output means we
  // can't compute for this row (missing sell price, non-positive flight).
  function computeProfit(opts) {
    const buyPrice = opts.buyPrice;
    const sellPrice = opts.sellPrice;
    const stock = opts.stock;
    const flightMins = opts.flightMins;
    const slotCount = opts.slotCount || DEFAULT_SLOT_COUNT;
    const flightMult = opts.flightMultiplier || DEFAULT_FLIGHT_MULTIPLIER;

    if (!(sellPrice > 0) || !(flightMins > 0) || !(buyPrice > 0)) return null;

    const netSell = sellPrice * 0.95;                // 5% item-market fee
    const marginPerItem = netSell - buyPrice;
    const marginPct = (marginPerItem / buyPrice) * 100;

    // Effective slots honours available stock.
    const effectiveSlots = (stock != null && stock >= 0)
      ? Math.min(slotCount, stock)
      : slotCount;
    const stockLimited = stock != null && stock < slotCount;

    const runCost = buyPrice * effectiveSlots;
    const profitPerRun = marginPerItem * effectiveSlots;
    const roundTripMins = flightMins * flightMult * 2;
    const profitPerHour = roundTripMins > 0
      ? (profitPerRun / roundTripMins) * 60
      : 0;

    return {
      netSell: netSell,
      marginPerItem: marginPerItem,
      marginPct: marginPct,
      effectiveSlots: effectiveSlots,
      stockLimited: stockLimited,
      runCost: runCost,
      profitPerRun: profitPerRun,
      profitPerHour: profitPerHour,
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
      '.valigia-cell .v-hr { color: #e8c84a; font-weight: 700; }',
      '.valigia-cell .v-margin-pos { color: #4ae8a0; }',
      '.valigia-cell .v-margin-neg { color: #b33; }',
      '.valigia-cell .v-muted { color: #5a6070; font-weight: 400; }',
      '.valigia-cell .v-sep { color: #3a4050; margin: 0 4px; }',
      '.valigia-best .valigia-cell {',
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
  function renderOverlay(shops, sellPriceMap, flightMins) {
    injectStyles();

    // Flatten every scraped item into a row descriptor with a reference to
    // its DOM <tr> so we can inject directly. We re-walk the same images we
    // scraped from to find the tr - keeps the injection index-safe even if
    // the page reorders rows.
    const allRows = [];
    const imgs = Array.from(document.querySelectorAll('img[src*="/images/items/"]'));
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const idMatch = src.match(/\/images\/items\/(\d+)\//);
      if (!idMatch) continue;
      const item_id = Number(idMatch[1]);

      const tr = img.closest('tr');
      if (!tr) continue;
      // Skip rows we've already decorated (in case the script fires twice
      // from tab switches inside the same page).
      if (tr.classList.contains('valigia-decorated')) continue;

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
            stock: stock,
            flightMins: flightMins,
          })
        : null;

      allRows.push({
        tr: tr,
        item_id: item_id,
        buyPrice: buyPrice,
        stock: stock,
        sellPrice: sellPrice,
        metrics: metrics,
      });
    }

    // Rank by profit/hr - only rows with positive profit/hr and non-zero
    // stock are eligible for the BEST badge.
    let best = null;
    for (const r of allRows) {
      if (!r.metrics) continue;
      if (r.metrics.profitPerHour <= 0) continue;
      if (r.stock != null && r.stock <= 0) continue;
      if (!best || r.metrics.profitPerHour > best.metrics.profitPerHour) best = r;
    }

    // Inject the cell into each row.
    for (const r of allRows) {
      const td = document.createElement('td');
      td.className = 'valigia-cell';

      if (!r.metrics) {
        if (r.sellPrice == null) {
          td.innerHTML = '<span class="v-muted">no sell data</span>';
        } else {
          td.innerHTML = '<span class="v-muted">-</span>';
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
          html += '<span class="' + marginClass + '">' + formatMoney(m.marginPerItem) + '/ea</span>';
          html += '<span class="v-sep">&middot;</span>';
          html += '<span class="' + marginClass + '">' + formatPct(m.marginPct) + '</span>';
          html += '<span class="v-sep">&middot;</span>';
          html += '<span class="v-hr">' + formatMoney(m.profitPerHour) + '/hr</span>';
          if (m.stockLimited) {
            html += '<span class="v-sep">&middot;</span>';
            html += '<span class="v-muted" title="Only ' + m.effectiveSlots + ' of ' + DEFAULT_SLOT_COUNT + ' slots fillable">slots:' + m.effectiveSlots + '</span>';
          }
        }
        td.innerHTML = html;
        if (isBest) r.tr.classList.add('valigia-best');
      }

      r.tr.appendChild(td);
      r.tr.classList.add('valigia-decorated');
    }

    return { total: allRows.length, withMetrics: allRows.filter(r => r.metrics).length, best: best };
  }

  // -- Main ----------------------------------------------------------------
  async function run() {
    // The placeholder stays literal if this isn't running inside PDA. Bail
    // quietly rather than firing a bogus request with a broken key.
    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) {
      log('Not running inside PDA - aborting.');
      return;
    }

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

    const flightMins = FLIGHT_MINS[destination] || 0;

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
          toast(destination + ': stored ' + body.stored + ' items', 'success');
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
        const stats = renderOverlay(shops, sellPriceMap, flightMins);
        if (DEBUG) {
          const bestLine = stats.best
            ? ('best=' + stats.best.item_id + ' profit/hr=' + Math.round(stats.best.metrics.profitPerHour))
            : 'best=(none eligible)';
          debugPanel([
            'destination=' + destination,
            'flightMins=' + flightMins + ' (one-way)',
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

  // Run once after DOM is settled. Torn's SPA may re-render on in-page nav;
  // for v0.1 we only handle the initial landing, which is the common case.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    setTimeout(run, 500);
  }
})();
