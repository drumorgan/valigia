// ==UserScript==
// @name         Valigia
// @namespace    https://valigia.girovagabondo.com/
// @version      0.32.0
// @description  Crowd-sourced price intelligence for Torn City, inside Torn PDA. Pushes anonymised observations to a shared pool and surfaces deals across six pages: Travel (home best-run board + margin overlays + YATA destination preview), Item Market (watchlist matches + add/edit/remove, lowest bazaar, TornExchange flash deals), Bazaar (deals below market/points value), Items (best trader buy-offers for your inventory), Museum (artifact prices), Points Market. Companion app: https://valigia.girovagabondo.com
// @author       drumorgan
// @match        https://www.torn.com/page.php?sid=travel*
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @match        https://www.torn.com/bazaar.php*
// @match        https://www.torn.com/item.php*
// @match        https://www.torn.com/museum.php*
// @match        https://www.torn.com/pmarket.php*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      vtslzplzlxdptpvxtanz.supabase.co
// @connect      api.torn.com
// @connect      yata.yt
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
  const SCRIPT_VERSION = '0.31.0';

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
  const POINTS_RATE_URL = SUPABASE_REST_URL + '/points_market_rate';
  const ABROAD_PRICES_URL = SUPABASE_REST_URL + '/abroad_prices';
  const PDA_PREFS_URL = SUPABASE_REST_URL + '/pda_prefs';
  const PDA_PREFS_FN_URL =
    'https://vtslzplzlxdptpvxtanz.supabase.co/functions/v1/pda-prefs';

  // -- Indicator visibility --------------------------------------------------
  // Per-player toggle set from the website (PDA overlay modal → "Overlay
  // display"). When the player chooses "Hide indicators", every visual
  // surface this script paints — overlay cells, top-of-page bars, the
  // stakeout badge, toasts — is suppressed, while ALL scraping and ingest
  // paths keep running so the player still contributes prices to the
  // shared pool. Resolved once per dispatch from the public pda_prefs row
  // (anon SELECT, 60 s localStorage cache); defaults to visible on any
  // failure. The on-page DEBUG panel is intentionally NOT gated — it's an
  // explicit opt-in diagnostic, and silent mode is exactly when you'd
  // need it.
  let indicatorsHidden = false;

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

  // Pop-up toasts are disabled by user request: no "here's what we're doing"
  // alerts of any kind. Kept as a logging shim so the dozens of existing
  // call sites still work — the message goes to the DEBUG log() only, never
  // to a visible overlay. (The "V" overlay-toggle pill and the stakeout
  // badge are persistent controls, not toasts, so they're unaffected.)
  function toast(message, kind) {
    log('toast (suppressed):', kind || 'info', message);
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

  // City names Torn shows in the flight banner, mapped back to our
  // canonical destination keys (matching YATA's COUNTRY_MAP values in
  // src/log-sync.js). Source: https://wiki.torn.com/wiki/Travel — the
  // wiki's destination table lists the country name and the city Torn
  // uses inside the banner. We map both forms because confirmed live
  // observations show Torn writing "Torn to Tokyo" and "Torn to Dubai"
  // (city), so the city is the form actually rendered; the country
  // entries are kept as harmless fallbacks in case Torn ever changes.
  // Note "Ciudad Juárez" — 'á' is escaped to keep the source pure
  // ASCII for the FTP deploy.
  const CITY_TO_DESTINATION = {
    'Ciudad Ju\u00E1rez': 'Mexico',
    'Ciudad Juarez': 'Mexico',
    'Mexico': 'Mexico',
    'George Town': 'Caymans',
    'Cayman Islands': 'Caymans',
    'Toronto': 'Canada',
    'Canada': 'Canada',
    'Honolulu': 'Hawaii',
    'Hawaii': 'Hawaii',
    'London': 'UK',
    'United Kingdom': 'UK',
    'Buenos Aires': 'Argentina',
    'Argentina': 'Argentina',
    'Zurich': 'Switzerland',
    'Switzerland': 'Switzerland',
    'Tokyo': 'Japan',
    'Japan': 'Japan',
    'Beijing': 'China',
    'China': 'China',
    'Dubai': 'UAE',
    'United Arab Emirates': 'UAE',
    'UAE': 'UAE',
    'Johannesburg': 'South Africa',
    'South Africa': 'South Africa',
  };

  // Strip diacritics so "Ciudad Ju\u00E1rez" and "Ciudad Juarez" (Torn renders
  // the latter, the accented form was the live-observation guess) resolve
  // identically. NFD splits accented chars into base + combining mark, then
  // we drop the marks. Wrapped in try/catch because String.normalize is
  // absent on ancient engines \u2014 PDA's webview has it, but failing soft to
  // the raw string is harmless.
  function stripDiacritics(s) {
    try { return String(s).normalize('NFD').replace(/[\u0300-\u036F]/g, ''); }
    catch (e) { return String(s); }
  }

  // Accent- and case-insensitive index of CITY_TO_DESTINATION, built once.
  const CITY_TO_DESTINATION_NORM = (function () {
    const idx = {};
    for (const key in CITY_TO_DESTINATION) {
      idx[stripDiacritics(key).toLowerCase()] = CITY_TO_DESTINATION[key];
    }
    return idx;
  })();

  // Resolve a banner city name to a canonical destination. Tries the exact
  // map first (fast path), then the accent/case-normalized index, then falls
  // back to the raw city so an unmapped name at least flows through (and
  // shows up in the "no rows" log) instead of silently becoming undefined.
  function resolveCityToDestination(city) {
    if (CITY_TO_DESTINATION[city]) return CITY_TO_DESTINATION[city];
    const norm = CITY_TO_DESTINATION_NORM[stripDiacritics(city).toLowerCase()];
    return norm || city;
  }

  // In-flight banner reads: "Torn to {City}. Remaining Flight Time - HH:MM:SS"
  // (or the inverse "{City} to Torn..." when returning home — we only show
  // the strip on the outbound leg, since flying back the player can't shop
  // at the origin anymore). The city group matches anything except a period
  // so accented chars (Ciudad Juárez) and multi-word names (Buenos Aires)
  // both work. Returns { destination, returning, remainingMins } or null.
  function detectInFlight() {
    const body = document.body && document.body.innerText || '';
    if (!/Remaining Flight Time/i.test(body)) return null;

    // Pull HH:MM:SS off the timer if present. Banner format is
    // "Remaining Flight Time - 02:37:06" — convert to minutes (fractional).
    // null when missing, so callers can fall back to the destination's
    // standard flight time.
    let remainingMins = null;
    const tm = body.match(/Remaining Flight Time\s*-\s*(\d{1,2}):(\d{2}):(\d{2})/);
    if (tm) {
      const h = Number(tm[1]); const mi = Number(tm[2]); const se = Number(tm[3]);
      if (Number.isFinite(h) && Number.isFinite(mi) && Number.isFinite(se)) {
        remainingMins = h * 60 + mi + se / 60;
      }
    }

    let m = body.match(/Torn to ([^.]+?)\.\s*Remaining Flight Time/);
    if (m) {
      const city = m[1].trim();
      const dest = resolveCityToDestination(city);
      return { destination: dest, returning: false, remainingMins: remainingMins };
    }
    m = body.match(/([^.]+?) to Torn\.\s*Remaining Flight Time/);
    if (m) {
      const city = m[1].trim();
      const dest = resolveCityToDestination(city);
      return { destination: dest, returning: true, remainingMins: remainingMins };
    }
    return null;
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

  // -- Parse-mismatch capture (TEMPORARY DIAGNOSTIC) -----------------------
  // The travel-shop overlay badged Flail in UK as BEST when the real run
  // is a multi-million-dollar loss — the scraper read $8,000,000 as ~$800
  // because some other smaller `$N` token in the row was matched first.
  // This block collects rows where the first-`$` parse and the largest-`$`
  // parse disagree, and renderParseMismatchPanel() draws an unconditional
  // amber panel with the raw outerHTML so we can lock the parser onto the
  // right element. Remove the buffer, captureParseMismatch(), the
  // renderParseMismatchPanel() call in runTravel(), and the capture block
  // inside parseItemRow once the parser is hardened.
  const parseMismatches = [];
  const MAX_MISMATCH_CAPTURES = 5;

  function captureParseMismatch(entry) {
    if (parseMismatches.length >= MAX_MISMATCH_CAPTURES) return;
    for (const m of parseMismatches) {
      if (m.item_id === entry.item_id && m.firstDollar === entry.firstDollar) return;
    }
    parseMismatches.push(entry);
  }

  function renderParseMismatchPanel() {
    if (indicatorsHidden) return;
    if (parseMismatches.length === 0) return;
    const existing = document.getElementById('valigia-parse-mismatch-panel');
    if (existing) existing.remove();
    const lines = [
      'VALIGIA PARSER MISMATCH \u2014 please screenshot',
      'v' + SCRIPT_VERSION + ' \u00B7 ' + parseMismatches.length + ' row(s)',
      '',
    ];
    for (const m of parseMismatches) {
      lines.push('\u2014 ' + m.name + ' (id=' + m.item_id + ')');
      lines.push('  first-$ = ' + m.firstDollar);
      lines.push('  largest-$ = ' + m.largestDollar);
      lines.push('  HTML: ' + m.htmlSnippet);
      lines.push('');
    }
    const el = document.createElement('pre');
    el.id = 'valigia-parse-mismatch-panel';
    el.textContent = lines.join('\n');
    Object.assign(el.style, {
      position: 'fixed',
      top: '60px',
      left: '10px',
      maxWidth: '45vw',
      maxHeight: '70vh',
      overflow: 'auto',
      background: 'rgba(20,12,0,.92)',
      color: '#ffd27a',
      border: '2px solid #e8824a',
      padding: '10px',
      borderRadius: '6px',
      zIndex: '999998',
      font: '11px/1.35 ui-monospace, monospace',
      whiteSpace: 'pre-wrap',
      margin: '0',
    });
    document.body.appendChild(el);
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
    // Travel rows include an expandable info wrapper (id="item-N-itemInfoWrapper")
    // that shows the item's market sell price when the row is expanded. That
    // price is way larger than the abroad buy price and corrupted both the
    // first-$ and largest-$ parses — see the parseMismatches diagnostic. Clone
    // the row, drop the wrapper, then read text so only the shop's own cells
    // contribute. textContent (not innerText) is used on the clone because the
    // clone isn't attached to the layout tree.
    const rowClone = row.cloneNode(true);
    rowClone
      .querySelectorAll('[id$="-itemInfoWrapper"], [id*="ItemInfoWrapper"]')
      .forEach(function (el) { el.remove(); });
    const rowText = (rowClone.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

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

    // TEMP DIAGNOSTIC (see parseMismatches comment above): if the largest
    // `$N` token in the row disagrees with the first one we picked, capture
    // the row's HTML so we can fix the parser from real data.
    const allDollarTokens = rowText.match(/\$\s*[\d,\.]+/g) || [];
    let largestDollar = NaN;
    for (const tok of allDollarTokens) {
      const n = parseMoney(tok);
      if (Number.isFinite(n) && (Number.isNaN(largestDollar) || n > largestDollar)) {
        largestDollar = n;
      }
    }
    if (
      Number.isFinite(buy_price) &&
      Number.isFinite(largestDollar) &&
      buy_price !== largestDollar
    ) {
      const html = (row.outerHTML || '').replace(/\s+/g, ' ').trim();
      captureParseMismatch({
        name: altName || (rowText.split('\n')[0] || '').trim() || 'unknown',
        item_id: item_id,
        firstDollar: buy_price,
        largestDollar: largestDollar,
        htmlSnippet: html.length > 600 ? html.slice(0, 600) + '\u2026' : html,
      });
    }

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
  // Tries three transports in order:
  //   1. GM_xmlhttpRequest (classic Tampermonkey / older PDA builds)
  //   2. GM.xmlHttpRequest (newer Greasemonkey-style)
  //   3. PDA_httpGet / PDA_httpPost (Torn PDA's native cross-origin helpers,
  //      promise-returning, sidestep the webview's CORS the same way GM_*
  //      does). Some PDA builds don't expose GM_xmlhttpRequest at all, so
  //      this fallback is what keeps the script alive there.
  function gmRequest(opts) {
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
        return;
      }
      if (typeof GM !== 'undefined' && GM.xmlHttpRequest) {
        GM.xmlHttpRequest(base);
        return;
      }
      const method = (opts.method || 'POST').toUpperCase();
      let pdaCall = null;
      try {
        if (method === 'GET' && typeof PDA_httpGet === 'function') {
          // Newer PDA accepts (url, headers); older accepts (url) only.
          // Pass headers when present and let PDA ignore the extra arg
          // on builds that don't read it.
          pdaCall = PDA_httpGet(opts.url, opts.headers || {});
        } else if (method === 'POST' && typeof PDA_httpPost === 'function') {
          pdaCall = PDA_httpPost(opts.url, opts.headers || {}, opts.data || '');
        }
      } catch (err) {
        reject(err);
        return;
      }
      if (pdaCall && typeof pdaCall.then === 'function') {
        const timer = setTimeout(function () {
          reject(new Error('timeout'));
        }, 15000);
        pdaCall.then(function (res) {
          clearTimeout(timer);
          // PDA_httpGet/Post resolve with { status, responseText } on
          // current builds. Some older builds resolved with a raw string —
          // normalise both shapes so callers can read .status/.responseText.
          let status = 200;
          let body = '';
          if (res && typeof res === 'object') {
            if (res.status != null) status = res.status;
            if (res.responseText != null) body = res.responseText;
            else if (typeof res.body === 'string') body = res.body;
            else if (typeof res.data === 'string') body = res.data;
          } else if (typeof res === 'string') {
            body = res;
          }
          resolve({ status: status, responseText: body });
        }).catch(function (err) {
          clearTimeout(timer);
          reject(err);
        });
        return;
      }
      reject(new Error('No GM_xmlhttpRequest available - install as userscript in PDA'));
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
    // post_qty is the typical-shelf-after-restock count — needed by the
    // in-flight strip's during-flight refill override (estimateRestockPlan
    // below). The landed-overlay caller only uses .at and ignores postQty,
    // so the change is backwards-compatible.
    // Exclude the one-time migration 018 backfill: those rows carry historical
    // YATA sampling gaps, not real scout cadence (matches the web v2 model and
    // get_stats_snapshot's filter). Keeps the surfaced refill ETA honest.
    const url = RESTOCK_EVENTS_URL +
      '?select=item_id,restocked_at,post_qty' +
      '&item_id=in.(' + idList + ')' +
      '&destination=eq.' + encodeURIComponent(destination) +
      '&restocked_at=gte.' + encodeURIComponent(cutoffIso) +
      '&source=neq.backfill' +
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
        if (!r) continue;
        const itemId = Number(r.item_id);
        if (!Number.isFinite(itemId)) continue;
        const t = new Date(r.restocked_at).getTime();
        if (!Number.isFinite(t)) continue;
        const postQty = Number(r.post_qty);
        let arr = byItem.get(itemId);
        if (!arr) { arr = []; byItem.set(itemId, arr); }
        arr.push({ at: t, postQty: Number.isFinite(postQty) ? postQty : null });
      }
      return byItem;
    } catch (e) {
      return new Map();
    }
  }

  // Cap on the inter-restock interval the cadence estimators will trust.
  // Wider than this is an observation hole, not a real two-hour cadence —
  // mirrors src/stock-forecast.js's MAX_RESTOCK_GAP_MINS and migration 030.
  const MAX_RESTOCK_GAP_MINS = 120;

  // Median observed interval minus time-since-last-restock. Mirrors the
  // central calculation in stock-forecast.js (estimateNextRestock) without
  // the confidence/MAD/MAE machinery — the overlay just needs one number.
  // Needs ≥2 events (one interval sample); returns null otherwise.
  function estimateRefillMins(events, nowMs) {
    if (!Array.isArray(events) || events.length < 2) return null;
    const sorted = events.map(function (e) { return e.at; })
      .filter(Number.isFinite)
      .sort(function (a, b) { return a - b; });
    if (sorted.length < 2) return null;
    // Drop non-positive gaps and any gap wider than MAX_RESTOCK_GAP_MINS — a
    // multi-hour gap is an observation hole ("nobody visited"), not a real
    // cadence. Mirrors the web v2 model + migration 030's 120-min cap.
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const g = (sorted[i] - sorted[i - 1]) / 60000;
      if (g > 0 && g <= MAX_RESTOCK_GAP_MINS) gaps.push(g);
    }
    if (gaps.length === 0) return null;
    const sortedGaps = gaps.slice().sort(function (a, b) { return a - b; });
    const median = sortedGaps[Math.floor(sortedGaps.length / 2)];
    if (!(median > 0)) return null;
    const lastAt = sorted[sorted.length - 1];
    const sinceLastMins = (nowMs - lastAt) / 60000;
    return Math.max(0, Math.round(median - sinceLastMins));
  }

  // Slim port of stock-forecast.js's estimateNextRestock — returns
  // { timeToNextMins, typicalPostQty } so the in-flight strip can apply
  // the same restock-during-flight override the web app does:
  //
  //   if depletion forecast hits 0 AND a restock is expected before
  //   landing, replace 0 with typicalPostQty.
  //
  // Skips the confidence/MAD/MAE/uncertainty machinery — the strip only
  // needs the median cadence + median post-restock qty.
  function estimateRestockPlan(events, nowMs) {
    if (!Array.isArray(events) || events.length < 2) return null;
    const atTimes = events.map(function (e) { return e.at; })
      .filter(Number.isFinite)
      .sort(function (a, b) { return a - b; });
    if (atTimes.length < 2) return null;
    // Same gap hygiene as estimateRefillMins: drop holes wider than the cap.
    const gaps = [];
    for (let i = 1; i < atTimes.length; i++) {
      const g = (atTimes[i] - atTimes[i - 1]) / 60000;
      if (g > 0 && g <= MAX_RESTOCK_GAP_MINS) gaps.push(g);
    }
    if (gaps.length === 0) return null;
    const sortedGaps = gaps.slice().sort(function (a, b) { return a - b; });
    const medianInterval = sortedGaps[Math.floor(sortedGaps.length / 2)];
    if (!(medianInterval > 0)) return null;

    const postQtys = events.map(function (e) { return e.postQty; })
      .filter(Number.isFinite)
      .sort(function (a, b) { return a - b; });
    if (postQtys.length === 0) return null;
    const typicalPostQty = postQtys[Math.floor(postQtys.length / 2)];

    const lastRestockAt = atTimes[atTimes.length - 1];
    const sinceLastMins = (nowMs - lastRestockAt) / 60000;
    const timeToNextMins = Math.max(0, medianInterval - sinceLastMins);

    return {
      timeToNextMins: timeToNextMins,
      typicalPostQty: typicalPostQty,
      medianIntervalMins: medianInterval,
    };
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

  // Failures the user can't act on — rate-limit gating and transient
  // network/5xx errors that exhausted retries — shouldn't paint a red
  // toast. The next scrape will succeed on its own (the iPad is the only
  // surface and there's no DevTools to read the message anyway). Real
  // key/permission errors still toast: those need user action in PDA's
  // Script Manager.
  function isSilentIngestError(result) {
    if (!result || result.ok) return false;
    if (result.retried) return true;
    const lower = String(result.error || '').toLowerCase();
    return lower.indexOf('rate_limited') !== -1 || lower.indexOf('rate limit') !== -1;
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
      '  font: 600 11px/1.3 Arial, Helvetica, sans-serif;',
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
  // Remove any cells/classes a previous render left behind so renderOverlay
  // can be called repeatedly (e.g. a pooled-data first pass followed by a
  // live-price repaint) without stacking duplicate annotations.
  function clearOverlayDecorations() {
    document.querySelectorAll('.valigia-cell').forEach(function (n) { n.remove(); });
    document.querySelectorAll('.valigia-decorated').forEach(function (n) {
      n.classList.remove('valigia-decorated');
      n.classList.remove('valigia-best');
    });
  }

  function renderOverlay(shops, sellPriceMap, refillEtaMap) {
    if (indicatorsHidden) return { total: 0, withMetrics: 0, best: null };
    if (!(refillEtaMap instanceof Map)) refillEtaMap = new Map();
    injectStyles();
    clearOverlayDecorations();

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

    // Compute the top-margin row for the DEBUG panel's return shape only.
    // Per user request there is NO "best" emphasis in the abroad view —
    // while you're in a country every item just shows its own buy-vs-sell
    // comparison, no single recommendation. (The "where to fly" pick lives
    // on the home picker board, which is the right place for it.)
    // Within a single shop page flight time and slot count are constants,
    // so ranking by margin-per-item is equivalent to ranking by profit/hr.
    let best = null;
    for (const r of allRows) {
      if (!r.metrics) continue;
      if (r.metrics.marginPerItem <= 0) continue;
      if (r.stock != null && r.stock <= 0) continue;
      // Sanity cap: catches parser blow-ups like the historical Flail UK
      // bug (+831,249% when $8M was misread as ~$800) without excluding
      // legitimate UK collectibles, plushies, and flowers, which routinely
      // run past +3000% (Heather +602%, Inkwell +3429%, etc.). A 100,000%
      // ceiling is well above any real Torn travel margin and still flags
      // gross parse errors. The numbers still render in the overlay either
      // way so the player can see when something's off.
      if (r.metrics.marginPct > 100000) continue;
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
        const marginClass = m.marginPerItem >= 0 ? 'v-margin-pos' : 'v-margin-neg';
        const outOfStock = (r.stock != null && r.stock <= 0);

        let html = '';
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
    // Pool-wide flip surface: cross-references fresh sell_prices floors
    // against the highest fresh te_buy_prices offer per item. Scopes to
    // a single item when itemID=N is in the hash.
    injectFlashDealsBar();
    // Watchlist management: a collapsed bar listing every alert (editable
    // price + remove), plus a per-item add/edit/remove control when the
    // hash is scoped to one item. Fire-and-forget so a slow Torn key
    // validation never blocks the scraper.
    injectMyWatchlistBar().catch(function (e) { log('my-watchlist bar error', e); });
    injectItemWatchControl().catch(function (e) { log('item-watch control error', e); });

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
      log('Item Market: ' + result.count + ' prices upserted');
      pingActivity('item_market');
    } else if (isSilentIngestError(result)) {
      log('Item Market ingest skipped (silent):', result.error);
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
    injectBazaarDealsBar(items, ownerId).catch(function (e) { log('deals bar error', e); });

    const result = await postIngestRows(INGEST_BAZAAR_URL, rows);
    if (result.ok) {
      log('Bazaar: ' + result.count + ' prices upserted');
      pingActivity('bazaar');
    } else if (isSilentIngestError(result)) {
      log('Bazaar ingest skipped (silent):', result.error);
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
  const MY_WATCHLIST_BAR_ID = 'valigia-my-watchlist-bar';
  const ITEM_WATCH_BAR_ID = 'valigia-item-watch-bar';
  const WATCHLIST_ALERTS_URL = SUPABASE_REST_URL + '/watchlist_alerts';
  const WATCHLIST_FN_URL =
    'https://vtslzplzlxdptpvxtanz.supabase.co/functions/v1/watchlist';
  // New per-item alerts prefill 10% BELOW the current market floor: an
  // alert fires when a listing is at/below max_price, so anchoring under
  // today's floor means it only trips on a genuine dip, not the price the
  // item already sits at. The user can override the prefilled value before
  // saving.
  const WATCHLIST_ADD_FACTOR = 0.9;
  const PLAYER_ID_CACHE_KEY = 'valigia_pda_player_id_v1';
  // Torn items catalog cache. The web app maintains its own copy on
  // valigia.girovagabondo.com, but userscript localStorage is scoped to
  // torn.com — we can't share. Cost is one Torn /torn/?selections=items
  // call per player per catalog-TTL, answered by a static dataset.
  // Bumped to v2 when we extended the cache shape from name-only to
  // { name, type }. v1 readers got a one-time refetch on first load.
  const ITEM_CATALOG_CACHE_KEY = 'valigia_item_catalog_v2';
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
      '  font-family: Arial, Helvetica, sans-serif;',
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
  // Map<itemId:number, { name:string, type:string|null }>.
  // The cache used to hold names only; v2 added type so the in-flight
  // strip can filter to the canonical arbitrage categories
  // (Drug/Flower/Plushie/Artifact).
  let itemMetaCache = null;

  /**
   * Load the id→name map, hydrating the in-memory cache from localStorage
   * or fetching from Torn if we're cold. Safe to call repeatedly — only
   * hits the network once per TTL window. Silent-fail on any error so
   * the banner never blocks on name resolution.
   */
  async function ensureItemCatalog() {
    if (itemMetaCache && itemMetaCache.size > 0) return itemMetaCache;

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
          cached.byId && typeof cached.byId === 'object'
        ) {
          itemMetaCache = new Map();
          for (const idStr in cached.byId) {
            const meta = cached.byId[idStr];
            if (meta && typeof meta === 'object') {
              itemMetaCache.set(Number(idStr), meta);
            }
          }
          if (itemMetaCache.size > 0) return itemMetaCache;
        }
      }
    } catch (_) { /* corrupt cache — fall through to refetch */ }

    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) {
      return itemMetaCache || new Map();
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
        const byId = {};
        const map = new Map();
        for (const idStr in data.items) {
          const entry = data.items[idStr];
          if (entry && entry.name) {
            const meta = { name: entry.name, type: entry.type || null };
            byId[idStr] = meta;
            map.set(Number(idStr), meta);
          }
        }
        try {
          localStorage.setItem(
            ITEM_CATALOG_CACHE_KEY,
            JSON.stringify({ byId, fetchedAt: Date.now() })
          );
        } catch (_) { /* storage full / disabled — non-fatal */ }
        itemMetaCache = map;
        return itemMetaCache;
      }
    } catch (err) {
      log('item catalog fetch failed', err);
    }

    return itemMetaCache || new Map();
  }

  /** Synchronous lookup used once the catalog is warm. "Item #N" fallback. */
  function itemNameFor(itemId) {
    const meta = itemMetaCache && itemMetaCache.get(Number(itemId));
    if (meta && meta.name) return meta.name;
    return 'Item #' + itemId;
  }

  // Returns Torn's item-category string ('Drug' / 'Flower' / 'Plushie' /
  // 'Artifact' / 'Energy Drink' / etc.) or null when the catalog hasn't
  // been warmed yet for this id. Callers must treat null as "unknown" —
  // the in-flight strip drops unknown rows when filtering by type.
  function itemTypeFor(itemId) {
    const meta = itemMetaCache && itemMetaCache.get(Number(itemId));
    return meta && meta.type ? meta.type : null;
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
  let watchlistBarGeneration = 0;
  async function injectWatchlistBar() {
    const myGeneration = ++watchlistBarGeneration;
    // Idempotent: tear down any previous instance before fetching.
    const existing = document.getElementById(WATCHLIST_BAR_ID);
    if (existing) existing.remove();
    if (indicatorsHidden) return;

    const playerId = await resolvePlayerId();
    if (!playerId) return;

    // Warm the items catalog in parallel with the match fetch — by the
    // time we go to render row labels we'll have real item names instead
    // of the "Item #N" fallback.
    const [matches] = await Promise.all([
      fetchWatchlistMatches(playerId),
      ensureItemCatalog(),
    ]);
    if (myGeneration !== watchlistBarGeneration) return;
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
    // Final sweep right before insert: a parallel call could have inserted
    // its own bar between our start-of-function removal and now.
    document.querySelectorAll('#' + WATCHLIST_BAR_ID).forEach(function (n) { n.remove(); });
    host.insertBefore(bar, host.firstChild);
  }

  // -- Watchlist writes (add / edit / remove) ------------------------------
  // The userscript holds the player's raw Torn key but has no Valigia
  // session token, so writes go through the `watchlist` edge function's
  // api_key auth branch (it validates the key via user/basic to derive
  // player_id, the same trust model as ingest-travel-shop). Reads still go
  // direct via anon SELECT.

  async function postWatchlist(payload) {
    try {
      const res = await gmRequest({
        method: 'POST',
        url: WATCHLIST_FN_URL,
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        },
        data: JSON.stringify(Object.assign({ api_key: TORN_API_KEY }, payload)),
      });
      let data = null;
      try { data = JSON.parse(res.responseText || '{}'); } catch (_) { /* ignore */ }
      if (res.status >= 200 && res.status < 300 && data && data.success) {
        return { ok: true };
      }
      return { ok: false, error: (data && data.error) || ('http_' + res.status) };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  function watchlistUpsert(itemId, maxPrice, venues) {
    const payload = { action: 'upsert', item_id: Number(itemId), max_price: Math.round(maxPrice) };
    // Preserve the alert's existing venue selection on edit. New alerts omit
    // venues so the edge function applies its all-venues default rather than
    // the PDA narrowing a web-set choice on an unrelated price tweak.
    if (Array.isArray(venues) && venues.length) payload.venues = venues;
    return postWatchlist(payload);
  }

  function watchlistDelete(itemId) {
    return postWatchlist({ action: 'delete', item_id: Number(itemId) });
  }

  // Player's full alert set (every alert, not just current matches — the
  // management surfaces need to edit/remove alerts that aren't firing right
  // now). Short cache shared across the My Watchlist bar and the per-item
  // control; invalidated on every write.
  const ALL_ALERTS_TTL_MS = 30_000;
  let allAlertsCache = null; // { playerId, expiresAt, alerts } | null

  async function fetchAllAlerts(playerId) {
    if (!playerId) return [];
    const now = Date.now();
    if (allAlertsCache
        && allAlertsCache.playerId === playerId
        && allAlertsCache.expiresAt > now) {
      return allAlertsCache.alerts;
    }
    const alerts = await fetchJSON(
      WATCHLIST_ALERTS_URL +
      '?player_id=eq.' + encodeURIComponent(playerId) +
      '&select=item_id,max_price,venues&order=created_at.desc'
    );
    const list = Array.isArray(alerts) ? alerts : [];
    allAlertsCache = { playerId: playerId, expiresAt: now + ALL_ALERTS_TTL_MS, alerts: list };
    return list;
  }

  // Current Item Market floor for an item, used to prefill a new alert's
  // threshold. Prefers the shared sell_prices cache (free anon read), but
  // that only tracks ~200 arbitrage-relevant items — so for anything else
  // (e.g. Credit Card) it falls back to a live Torn market lookup so the
  // prefill works for every item.
  async function fetchItemMarketFloor(itemId) {
    const rows = await fetchJSON(
      SELL_PRICES_URL + '?item_id=eq.' + encodeURIComponent(itemId) +
      '&select=price,min_price'
    );
    if (Array.isArray(rows) && rows.length > 0) {
      const r = rows[0];
      if (r.min_price != null) return Number(r.min_price);
      if (r.price != null) return Number(r.price);
    }
    return fetchLiveItemMarketFloor(itemId);
  }

  // Absolute cheapest live Item Market listing for an item, straight from
  // the Torn API (the userscript already holds the key). Parsing mirrors
  // src/market.js: v1 returns { itemmarket: [...] }, newer shapes nest a
  // { itemmarket: { listings: [...] } }; listings come cheapest-first, so
  // [0].cost is the floor. Best-effort — returns null on any failure.
  async function fetchLiveItemMarketFloor(itemId) {
    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) return null;
    try {
      const res = await gmRequest({
        method: 'GET',
        url: 'https://api.torn.com/market/' + encodeURIComponent(itemId) +
             '?selections=itemmarket&key=' + encodeURIComponent(TORN_API_KEY),
        headers: { 'Accept': 'application/json' },
      });
      let data = null;
      try { data = JSON.parse(res.responseText || '{}'); } catch (_) { return null; }
      if (!data || data.error) return null;
      const listings = (data.itemmarket && data.itemmarket.listings) || data.itemmarket;
      if (Array.isArray(listings) && listings.length > 0) {
        const first = listings[0];
        const cost = first.cost != null ? first.cost : first.price;
        const n = Number(cost);
        return Number.isFinite(n) && n > 0 ? n : null;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // Session cache of live Item Market fetches so a re-render or another
  // landing inside the window doesn't re-spend Torn API. item_id ->
  // { price, minPrice, at }.
  const liveSellCache = new Map();
  const LIVE_SELL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
  // Refresh a pooled price the overlay already has if it's older than this.
  // (It still shows the stale number meanwhile — this just queues a refresh.)
  const LIVE_SELL_STALE_MS = 2 * 60 * 60 * 1000; // 2 h
  // Hard cap on live fetches per landing so a huge shop can't blow the
  // 100/min Torn key budget. A travel shop is ~35 items, so this rarely bites.
  const LIVE_SELL_MAX_FETCH = 45;
  const LIVE_SELL_CONCURRENCY = 5;

  // Full Item Market listings for an item, reduced to the same two prices
  // sell_prices stores: min_price = absolute floor (cheapest listing, any
  // qty) and price = first listing with qty >= 2 (skips single-unit loss-
  // leaders that would overstate a multi-unit travel run), falling back to
  // the floor when every listing is a single. Mirrors buildSellPriceRows()
  // and src/market.js. Returns { price, minPrice, floorQty, listingCount }
  // or null on any failure.
  async function fetchLiveItemMarketPrices(itemId) {
    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) return null;
    try {
      const res = await gmRequest({
        method: 'GET',
        url: 'https://api.torn.com/market/' + encodeURIComponent(itemId) +
             '?selections=itemmarket&key=' + encodeURIComponent(TORN_API_KEY),
        headers: { 'Accept': 'application/json' },
      });
      let data = null;
      try { data = JSON.parse(res.responseText || '{}'); } catch (_) { return null; }
      if (!data || data.error) return null;
      const listings = (data.itemmarket && data.itemmarket.listings) || data.itemmarket;
      if (!Array.isArray(listings) || listings.length === 0) return null;
      const norm = [];
      for (const l of listings) {
        const cost = Number(l.cost != null ? l.cost : l.price);
        // Quantity field name varies across API shapes (amount / quantity).
        // Default to 1 so an unknown qty is treated as a single-unit listing.
        const qtyRaw = l.amount != null ? l.amount : (l.quantity != null ? l.quantity : 1);
        const qty = Number(qtyRaw);
        if (Number.isFinite(cost) && cost > 0) {
          norm.push({ price: cost, qty: Number.isFinite(qty) && qty > 0 ? qty : 1 });
        }
      }
      if (norm.length === 0) return null;
      norm.sort(function (a, b) { return a.price - b.price; });
      const minPrice = norm[0].price;
      let floor = null;
      for (const l of norm) { if (l.qty >= 2) { floor = l; break; } }
      if (!floor) floor = norm[0];
      return { price: floor.price, minPrice: minPrice, floorQty: floor.qty, listingCount: norm.length };
    } catch (e) {
      return null;
    }
  }

  // Fill in sell prices the shared pool is missing or stale on by fetching
  // them live from the Torn Item Market, painting them into sellPriceMap,
  // and upserting them back into sell_prices so every other Valigia user
  // benefits. Bounded: session-cached, capped at LIVE_SELL_MAX_FETCH, and
  // run with limited concurrency. Best-effort — a failed fetch just leaves
  // that row without a price, exactly as before. Mutates sellPriceMap.
  async function enrichSellPricesLive(itemIds, sellPriceMap) {
    if (indicatorsHidden) return; // silent mode paints nothing; don't spend API
    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) return;
    if (!Array.isArray(itemIds) || itemIds.length === 0) return;

    const now = Date.now();
    const todo = [];
    for (const id of itemIds) {
      // Reuse a fresh session-cached live value without re-spending API.
      const cached = liveSellCache.get(id);
      if (cached && (now - cached.at) < LIVE_SELL_CACHE_TTL_MS) {
        if (!sellPriceMap.has(id)) {
          sellPriceMap.set(id, {
            price: cached.price,
            minPrice: cached.minPrice,
            updatedAt: new Date(cached.at).toISOString(),
          });
        }
        continue;
      }
      const pooled = sellPriceMap.get(id);
      const stale = pooled && pooled.updatedAt
        && (now - new Date(pooled.updatedAt).getTime()) > LIVE_SELL_STALE_MS;
      if (!pooled || stale) todo.push(id);
    }
    if (todo.length === 0) return;

    const batch = todo.slice(0, LIVE_SELL_MAX_FETCH);
    const fetched = [];
    let idx = 0;
    async function worker() {
      while (idx < batch.length) {
        const id = batch[idx++];
        const r = await fetchLiveItemMarketPrices(id);
        if (!r) continue;
        const at = Date.now();
        liveSellCache.set(id, { price: r.price, minPrice: r.minPrice, at: at });
        sellPriceMap.set(id, {
          price: r.price,
          minPrice: r.minPrice,
          updatedAt: new Date(at).toISOString(),
        });
        fetched.push({
          item_id: id,
          price: r.price,
          min_price: r.minPrice,
          floor_qty: r.floorQty,
          listing_count: r.listingCount,
        });
      }
    }
    const workers = [];
    const n = Math.min(LIVE_SELL_CONCURRENCY, batch.length);
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);

    // Densify the shared pool. Same canonical path the Item Market runner
    // uses (rate-limited + key-validated edge function). Fire-and-forget.
    if (fetched.length > 0) {
      try { await postIngestRows(INGEST_SELL_URL, fetched); }
      catch (e) { log('live sell-price upsert failed:', e); }
    }
  }

  function invalidateWatchlistWriteCaches() {
    allAlertsCache = null;
    watchlistMatchesCache = null;
  }

  // Resolve a typed item name back to its id via the warmed catalog
  // (case-insensitive exact match). Returns null when the name doesn't
  // match a known item, so the add path can reject typos cleanly.
  function resolveItemIdByName(name) {
    if (!itemMetaCache || !name) return null;
    const target = String(name).trim().toLowerCase();
    if (!target) return null;
    for (const [id, meta] of itemMetaCache.entries()) {
      if (meta && meta.name && meta.name.toLowerCase() === target) return Number(id);
    }
    return null;
  }

  // Build the <datalist> backing the add-item autocomplete once and park it
  // on the page. Native datalist gives free type-ahead on PDA's WebKit
  // webview; even if a build doesn't render the dropdown, typing the full
  // name still resolves via resolveItemIdByName. No-op until the catalog is
  // warm and idempotent thereafter.
  const ITEM_DATALIST_ID = 'valigia-item-datalist';
  function ensureItemDatalist() {
    if (document.getElementById(ITEM_DATALIST_ID)) return;
    if (!itemMetaCache || itemMetaCache.size === 0) return;
    const dl = document.createElement('datalist');
    dl.id = ITEM_DATALIST_ID;
    for (const meta of itemMetaCache.values()) {
      if (!meta || !meta.name) continue;
      const opt = document.createElement('option');
      opt.value = meta.name;
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
  }

  // Re-render every watchlist surface after a write so add/edit/remove is
  // reflected immediately without a page reload.
  async function refreshWatchlistSurfaces() {
    invalidateWatchlistWriteCaches();
    await Promise.all([
      injectWatchlistBar().catch(function (e) { log('matches refresh error', e); }),
      injectMyWatchlistBar().catch(function (e) { log('my-watchlist refresh error', e); }),
      injectItemWatchControl().catch(function (e) { log('item-watch refresh error', e); }),
    ]);
  }

  function injectWatchManageStyles() {
    if (document.getElementById('valigia-watch-manage-styles')) return;
    const css = [
      // --- My Watchlist bar (collapsed list of every alert) ---
      '#' + MY_WATCHLIST_BAR_ID + ' {',
      '  all: initial; display: block; margin: 8px auto 12px; max-width: 1100px;',
      '  font-family: Arial, Helvetica, sans-serif; color: #c8cdd8;',
      '  background: #161a22; border: 1px solid #252a35;',
      '  border-left: 3px solid #4ae8a0; border-radius: 4px;',
      '  box-sizing: border-box; overflow: hidden;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-head {',
      '  display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-title {',
      '  color: #4ae8a0; font-weight: 700; font-size: 11px;',
      '  letter-spacing: 0.12em; text-transform: uppercase;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-count {',
      '  background: rgba(74,232,160,0.18); color: #4ae8a0; font-size: 11px;',
      '  font-weight: 700; padding: 1px 7px; border-radius: 9px;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-caret {',
      '  margin-left: auto; color: #4ae8a0; font-size: 10px; transition: transform 0.15s ease;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + '.vgl-mw-open .vgl-mw-caret { transform: rotate(180deg); }',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-body {',
      '  display: none; flex-direction: column; gap: 6px; padding: 0 12px 12px;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + '.vgl-mw-open .vgl-mw-body { display: flex; }',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-row {',
      '  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-name {',
      '  flex: 1 1 120px; min-width: 0; font-weight: 700; color: #c8cdd8;',
      '  font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-empty { color: #5a6070; font-size: 12px; }',
      // Add row sits below the alert list, separated by a hairline so it
      // reads as a distinct "create" affordance rather than another alert.
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-addrow {',
      '  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;',
      '  margin-top: 4px; padding-top: 10px; border-top: 1px solid #252a35;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-addname {',
      '  appearance: none; -webkit-appearance: none; flex: 1 1 140px; min-width: 0;',
      '  background: #0d0f14; border: 1px solid #252a35; border-radius: 3px;',
      '  color: #c8cdd8; font-family: inherit; font-size: 12px; padding: 6px 8px;',
      '  outline: none;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-addname::placeholder { color: #5a6070; }',
      // Shared input + button styling for both surfaces. Torn's page CSS is
      // aggressive, so reset appearance and set every visible property.
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-pricewrap,',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-pricewrap {',
      '  display: inline-flex; align-items: center; background: #0d0f14;',
      '  border: 1px solid #252a35; border-radius: 3px; padding: 2px 6px;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-dollar,',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-dollar { color: #5a6070; font-size: 12px; margin-right: 2px; }',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-input,',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-input {',
      '  appearance: none; -webkit-appearance: none; background: transparent;',
      '  border: none; outline: none; width: 88px; color: #c8cdd8; font-size: 12px;',
      '  font-family: inherit; text-align: right; padding: 0; margin: 0;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-btn,',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-btn {',
      '  appearance: none; -webkit-appearance: none; font-family: inherit;',
      '  font-size: 11px; font-weight: 700; border: none; border-radius: 3px;',
      '  padding: 6px 12px; cursor: pointer;',
      '}',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-save,',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-save { background: rgba(74,232,160,0.18); color: #4ae8a0; }',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-btn:disabled,',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-btn:disabled { opacity: 0.5; }',
      '#' + MY_WATCHLIST_BAR_ID + ' .vgl-mw-remove,',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-remove { background: rgba(232,130,74,0.16); color: #e8824a; }',
      // --- Per-item watch control (single row, always expanded) ---
      '#' + ITEM_WATCH_BAR_ID + ' {',
      '  all: initial; display: block; margin: 8px auto 12px; max-width: 1100px;',
      '  font-family: Arial, Helvetica, sans-serif; color: #c8cdd8;',
      '  background: #161a22; border: 1px solid #252a35;',
      '  border-left: 3px solid #4ae8a0; border-radius: 4px;',
      '  box-sizing: border-box; overflow: hidden;',
      '}',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-row {',
      '  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px;',
      '}',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-title {',
      '  color: #4ae8a0; font-weight: 700; font-size: 11px;',
      '  letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap;',
      '}',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-name {',
      '  font-weight: 700; color: #c8cdd8; font-size: 12px; min-width: 0;',
      '  max-width: 40%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
      '}',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-label { color: #5a6070; font-size: 12px; }',
      '#' + ITEM_WATCH_BAR_ID + ' .vgl-iw-remove { margin-left: auto; }',
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'valigia-watch-manage-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildMyWatchlistRow(alert) {
    const row = document.createElement('div');
    row.className = 'vgl-mw-row';

    const name = document.createElement('span');
    name.className = 'vgl-mw-name';
    name.textContent = itemNameFor(alert.item_id);

    const priceWrap = document.createElement('span');
    priceWrap.className = 'vgl-mw-pricewrap';
    const dollar = document.createElement('span');
    dollar.className = 'vgl-mw-dollar';
    dollar.textContent = '$';
    const input = document.createElement('input');
    input.className = 'vgl-mw-input';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.value = Math.round(Number(alert.max_price)).toLocaleString('en-US');
    priceWrap.appendChild(dollar);
    priceWrap.appendChild(input);

    const save = document.createElement('button');
    save.className = 'vgl-mw-btn vgl-mw-save';
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', async function () {
      const val = parseInt10(input.value);
      if (!Number.isFinite(val) || val <= 0) { toast('Enter a price', 'warning'); return; }
      save.disabled = true;
      const res = await watchlistUpsert(alert.item_id, val, alert.venues);
      if (res.ok) {
        toast(itemNameFor(alert.item_id) + ' updated', 'success');
        await refreshWatchlistSurfaces();
      } else {
        toast('Update failed: ' + res.error, 'error');
        save.disabled = false;
      }
    });

    const remove = document.createElement('button');
    remove.className = 'vgl-mw-btn vgl-mw-remove';
    remove.type = 'button';
    remove.textContent = '\u00D7';
    remove.title = 'Remove';
    remove.addEventListener('click', async function () {
      remove.disabled = true;
      const res = await watchlistDelete(alert.item_id);
      if (res.ok) {
        toast(itemNameFor(alert.item_id) + ' removed', 'success');
        await refreshWatchlistSurfaces();
      } else {
        toast('Remove failed: ' + res.error, 'error');
        remove.disabled = false;
      }
    });

    row.appendChild(name);
    row.appendChild(priceWrap);
    row.appendChild(save);
    row.appendChild(remove);
    return row;
  }

  // The "+ Add item" row at the foot of the bar: a name field (catalog
  // autocomplete) + price + Add. This is the discoverable add path \u2014
  // the per-item control only appears once you've drilled into one item,
  // so the list itself needs its own way in. Price left blank falls back
  // to 10% below the item's current floor, matching the per-item default.
  function buildMyWatchlistAddRow() {
    const row = document.createElement('div');
    row.className = 'vgl-mw-addrow';

    const nameInput = document.createElement('input');
    nameInput.className = 'vgl-mw-addname';
    nameInput.type = 'text';
    nameInput.placeholder = 'Add item by name';
    nameInput.setAttribute('list', ITEM_DATALIST_ID);
    nameInput.autocomplete = 'off';

    const priceWrap = document.createElement('span');
    priceWrap.className = 'vgl-mw-pricewrap';
    const dollar = document.createElement('span');
    dollar.className = 'vgl-mw-dollar';
    dollar.textContent = '$';
    const priceInput = document.createElement('input');
    priceInput.className = 'vgl-mw-input';
    priceInput.type = 'text';
    priceInput.inputMode = 'numeric';
    priceInput.placeholder = 'price';
    priceWrap.appendChild(dollar);
    priceWrap.appendChild(priceInput);

    const add = document.createElement('button');
    add.className = 'vgl-mw-btn vgl-mw-save';
    add.type = 'button';
    add.textContent = 'Add';
    add.addEventListener('click', async function () {
      const itemId = resolveItemIdByName(nameInput.value);
      if (!itemId) { toast('Unknown item name', 'warning'); return; }
      let val = parseInt10(priceInput.value);
      if (!Number.isFinite(val) || val <= 0) {
        const floor = await fetchItemMarketFloor(itemId);
        if (floor && floor > 0) val = Math.round(floor * WATCHLIST_ADD_FACTOR);
      }
      if (!Number.isFinite(val) || val <= 0) { toast('Enter a price', 'warning'); return; }
      add.disabled = true;
      const res = await watchlistUpsert(itemId, val);
      if (res.ok) {
        toast(itemNameFor(itemId) + ' added', 'success');
        await refreshWatchlistSurfaces();
      } else {
        toast('Add failed: ' + res.error, 'error');
        add.disabled = false;
      }
    });

    row.appendChild(nameInput);
    row.appendChild(priceWrap);
    row.appendChild(add);
    return row;
  }

  function buildMyWatchlistBar(alerts) {
    const bar = document.createElement('div');
    bar.id = MY_WATCHLIST_BAR_ID;

    const head = document.createElement('div');
    head.className = 'vgl-mw-head';
    const title = document.createElement('span');
    title.className = 'vgl-mw-title';
    title.textContent = 'My Watchlist';
    const count = document.createElement('span');
    count.className = 'vgl-mw-count';
    count.textContent = String(alerts.length);
    const caret = document.createElement('span');
    caret.className = 'vgl-mw-caret';
    caret.textContent = '\u25BE';
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(caret);
    bar.appendChild(head);

    const body = document.createElement('div');
    body.className = 'vgl-mw-body';
    for (const a of alerts) body.appendChild(buildMyWatchlistRow(a));
    if (alerts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vgl-mw-empty';
      empty.textContent = 'No alerts yet \u2014 add one below.';
      body.appendChild(empty);
    }
    body.appendChild(buildMyWatchlistAddRow());
    bar.appendChild(body);

    head.addEventListener('click', function () {
      bar.classList.toggle('vgl-mw-open');
    });
    return bar;
  }

  let myWatchlistGeneration = 0;
  async function injectMyWatchlistBar() {
    const myGeneration = ++myWatchlistGeneration;
    // Preserve expand state across the post-write re-render so editing one
    // row doesn't collapse the bar out from under a multi-edit session.
    const existing = document.getElementById(MY_WATCHLIST_BAR_ID);
    const wasOpen = !!existing && existing.classList.contains('vgl-mw-open');
    if (existing) existing.remove();
    if (indicatorsHidden) return;

    const playerId = await resolvePlayerId();
    if (!playerId) return;

    const [alerts] = await Promise.all([
      fetchAllAlerts(playerId),
      ensureItemCatalog(),
    ]);
    if (myGeneration !== myWatchlistGeneration) return;
    // Always render (even with zero alerts) so the "+ Add item" row is a
    // reliable entry point — the bar is the management hub, not just a
    // match list. Collapsed by default, so the empty state is just a thin
    // header.
    const alertList = Array.isArray(alerts) ? alerts : [];

    injectWatchManageStyles();
    ensureItemDatalist();
    const bar = buildMyWatchlistBar(alertList);
    if (wasOpen) bar.classList.add('vgl-mw-open');
    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    // Final sweep right before insert: a parallel call (e.g. the initial
    // dispatch racing the Item Market SPA's hashchange) could have inserted
    // its own bar between our start-of-function removal and now. querySelectorAll
    // catches every duplicate (getElementById would only return the first).
    document.querySelectorAll('#' + MY_WATCHLIST_BAR_ID).forEach(function (n) { n.remove(); });
    host.insertBefore(bar, host.firstChild);
  }

  function buildItemWatchControl(itemId, existingAlert, prefill) {
    const bar = document.createElement('div');
    bar.id = ITEM_WATCH_BAR_ID;

    const row = document.createElement('div');
    row.className = 'vgl-iw-row';

    const title = document.createElement('span');
    title.className = 'vgl-iw-title';
    title.textContent = existingAlert ? 'WATCHING' : 'WATCH';

    const name = document.createElement('span');
    name.className = 'vgl-iw-name';
    name.textContent = itemNameFor(itemId);

    const label = document.createElement('span');
    label.className = 'vgl-iw-label';
    label.textContent = 'below';

    const priceWrap = document.createElement('span');
    priceWrap.className = 'vgl-iw-pricewrap';
    const dollar = document.createElement('span');
    dollar.className = 'vgl-iw-dollar';
    dollar.textContent = '$';
    const input = document.createElement('input');
    input.className = 'vgl-iw-input';
    input.type = 'text';
    input.inputMode = 'numeric';
    if (prefill != null) {
      input.value = Math.round(prefill).toLocaleString('en-US');
    } else {
      input.placeholder = 'price';
    }
    priceWrap.appendChild(dollar);
    priceWrap.appendChild(input);

    const save = document.createElement('button');
    save.className = 'vgl-iw-btn vgl-iw-save';
    save.type = 'button';
    save.textContent = existingAlert ? 'Save' : 'Add';
    save.addEventListener('click', async function () {
      const val = parseInt10(input.value);
      if (!Number.isFinite(val) || val <= 0) { toast('Enter a price', 'warning'); return; }
      save.disabled = true;
      const res = await watchlistUpsert(itemId, val, existingAlert ? existingAlert.venues : null);
      if (res.ok) {
        toast(itemNameFor(itemId) + (existingAlert ? ' updated' : ' added'), 'success');
        await refreshWatchlistSurfaces();
      } else {
        toast('Save failed: ' + res.error, 'error');
        save.disabled = false;
      }
    });

    row.appendChild(title);
    row.appendChild(name);
    row.appendChild(label);
    row.appendChild(priceWrap);
    row.appendChild(save);

    if (existingAlert) {
      const remove = document.createElement('button');
      remove.className = 'vgl-iw-btn vgl-iw-remove';
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async function () {
        remove.disabled = true;
        const res = await watchlistDelete(itemId);
        if (res.ok) {
          toast(itemNameFor(itemId) + ' removed', 'success');
          await refreshWatchlistSurfaces();
        } else {
          toast('Remove failed: ' + res.error, 'error');
          remove.disabled = false;
        }
      });
      row.appendChild(remove);
    }

    bar.appendChild(row);
    return bar;
  }

  // Per-item add/edit/remove control. Shows only when the Item Market hash
  // is scoped to a single item (itemID=N) — i.e. the player has drilled
  // into one item, the natural place to "watch this item". New alerts
  // prefill 10% below the current floor; existing alerts prefill their
  // saved threshold and gain a Remove button.
  let itemWatchGeneration = 0;
  async function injectItemWatchControl() {
    const myGeneration = ++itemWatchGeneration;
    const existing = document.getElementById(ITEM_WATCH_BAR_ID);
    if (existing) existing.remove();
    if (indicatorsHidden) return;

    const itemId = detectItemMarketSingleItemId();
    if (!itemId) return;

    const playerId = await resolvePlayerId();
    if (!playerId) return;

    const [alerts] = await Promise.all([
      fetchAllAlerts(playerId),
      ensureItemCatalog(),
    ]);
    if (myGeneration !== itemWatchGeneration) return;
    const existingAlert = (Array.isArray(alerts) ? alerts : []).find(function (a) {
      return Number(a.item_id) === Number(itemId);
    }) || null;

    let prefill = null;
    if (existingAlert) {
      prefill = Math.round(Number(existingAlert.max_price));
    } else {
      const floor = await fetchItemMarketFloor(itemId);
      if (floor && floor > 0) prefill = Math.round(floor * WATCHLIST_ADD_FACTOR);
    }

    injectWatchManageStyles();
    const bar = buildItemWatchControl(itemId, existingAlert, prefill);
    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    // Final sweep right before insert: a parallel call could have inserted
    // its own control between our start-of-function removal and now.
    document.querySelectorAll('#' + ITEM_WATCH_BAR_ID).forEach(function (n) { n.remove(); });
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
      '  font-family: Arial, Helvetica, sans-serif;',
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
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-label { color: #8a8fa0; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-right: 3px; }',
      // Points-arb route: gold badge + tinted left edge so a quick scan
      // distinguishes "flip on Item Market" rows from "complete a museum
      // set" rows. Same row layout so the eye doesnt have to retrain.
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-row--points { background: rgba(232,200,74,0.04); border-left: 2px solid rgba(232,200,74,0.45); padding-left: 6px; }',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-mkt--points { color: #e8c84a; }',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-route { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 2px; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }',
      '#' + BAZAAR_DEALS_BAR_ID + ' .vgl-bd-route--points { background: rgba(232,200,74,0.18); color: #e8c84a; }',
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
      const isPoints = d.route === 'points';

      const row = document.createElement('a');
      row.className = 'vgl-bd-row' + (isPoints ? ' vgl-bd-row--points' : '');
      // Market-flip rows deep-link to the Item Market search (where the
      // player will resell). Points rows deep-link back to the listings
      // bazaar so the player can buy it directly \u2014 theres nothing to
      // search for, the bazaar IS the action.
      row.href = isPoints
        ? 'https://www.torn.com/bazaar.php?userId=' + d.bazaar_owner_id
        : 'https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=' + d.item_id;
      row.target = '_top';
      row.rel = 'noopener';

      const name = document.createElement('span');
      name.className = 'vgl-bd-item';
      name.textContent = d.name;

      const baz = document.createElement('span');
      baz.className = 'vgl-bd-baz';
      const bazLabel = document.createElement('span');
      bazLabel.className = 'vgl-bd-label';
      bazLabel.textContent = 'Bazaar';
      baz.appendChild(bazLabel);
      baz.appendChild(document.createTextNode(formatMoneyCompact(d.bazaarPrice)));

      const arrow = document.createElement('span');
      arrow.className = 'vgl-bd-arrow';
      arrow.textContent = '\u2192';

      // Right-side cell flips between two routes:
      //   - market: gross Item Market price (the 5% fee is already baked
      //     into d.profit, so the gain column tells the truthful net
      //     story).
      //   - points: cash-equivalent of this items share of its museum
      //     set, computed at evaluation time as
      //     setPoints * itemMarketShare * pointsRate.
      const dest = document.createElement('span');
      dest.className = 'vgl-bd-mkt' + (isPoints ? ' vgl-bd-mkt--points' : '');
      const destLabel = document.createElement('span');
      destLabel.className = 'vgl-bd-label';
      destLabel.textContent = isPoints ? 'Points' : 'Market';
      dest.appendChild(destLabel);
      const destValue = isPoints ? d.pointsCash : d.marketPrice;
      dest.appendChild(document.createTextNode(formatMoneyCompact(destValue)));

      const gain = document.createElement('span');
      gain.className = 'vgl-bd-gain';
      gain.textContent = '+' + formatMoneyCompact(d.profit) +
        ' (' + (d.profitPct >= 100 ? Math.round(d.profitPct) : d.profitPct.toFixed(d.profitPct >= 10 ? 0 : 1)) + '%)';

      row.appendChild(name);
      row.appendChild(baz);
      row.appendChild(arrow);
      row.appendChild(dest);
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
  let bazaarDealsGeneration = 0;
  async function injectBazaarDealsBar(scrapedItems, ownerId) {
    const myGeneration = ++bazaarDealsGeneration;
    // Remove any prior instance so SPA nav doesn't stack duplicates.
    const existing = document.getElementById(BAZAAR_DEALS_BAR_ID);
    if (existing) existing.remove();
    if (indicatorsHidden) return;

    if (!Array.isArray(scrapedItems) || scrapedItems.length === 0) return;
    const ids = [...new Set(scrapedItems.map(function (r) { return r.item_id; }))];
    if (ids.length === 0) return;

    // Warm the items catalog and the shared Points Market rate in
    // parallel with the sell-prices read so the bar has real names for
    // every row, the museum-set resolver can map item names → ids,
    // and the points-arb route can fire even for players who've never
    // visited pmarket.php (rate falls through to the community pool).
    const [sellRows] = await Promise.all([
      fetchJSON(
        SELL_PRICES_URL +
        '?item_id=in.(' + ids.join(',') + ')' +
        '&select=item_id,price'
      ),
      ensureItemCatalog(),
      ensurePointsRate(),
    ]);

    const marketByItem = new Map();
    if (Array.isArray(sellRows)) {
      for (const r of sellRows) {
        if (r.price != null) marketByItem.set(Number(r.item_id), Number(r.price));
      }
    }

    // Points-arb prework: if the bazaar contains any item thats a
    // member of a museum set AND we have a fresh Points Market rate,
    // also fetch market prices for the OTHER set members so we can
    // compute proportional per-item points value (set is worth N points,
    // each members share is its proportion of total set market value).
    const pointsRate = getPointsRate();
    if (pointsRate) {
      const extraIds = new Set();
      for (const it of scrapedItems) {
        const set = setForItemId(Number(it.item_id));
        if (!set) continue;
        for (const member of set.items) {
          const memberId = itemIdForName(member.name);
          if (memberId && !marketByItem.has(memberId)) extraIds.add(memberId);
        }
      }
      if (extraIds.size > 0) {
        const extraRows = await fetchJSON(
          SELL_PRICES_URL +
          '?item_id=in.(' + [...extraIds].join(',') + ')' +
          '&select=item_id,price'
        );
        if (Array.isArray(extraRows)) {
          for (const r of extraRows) {
            if (r.price != null) marketByItem.set(Number(r.item_id), Number(r.price));
          }
        }
      }
    }

    const deals = [];
    for (const it of scrapedItems) {
      const itemId = Number(it.item_id);
      const bazaarPrice = Number(it.price);
      if (!Number.isFinite(bazaarPrice) || bazaarPrice <= 0) continue;

      // Route 1: market flip (existing behavior). Only valid when we
      // have a market floor AND the bazaar price beats net-sell.
      let marketDeal = null;
      const marketPrice = marketByItem.get(itemId);
      if (Number.isFinite(marketPrice)) {
        const netSell = marketPrice * (1 - MARKET_FEE_RATE);
        const profit = netSell - bazaarPrice;
        if (profit > 0) {
          marketDeal = {
            route: 'market',
            marketPrice: marketPrice,
            netSell: netSell,
            profit: profit,
            profitPct: (profit / bazaarPrice) * 100,
          };
        }
      }

      // Route 2: museum-points exchange. Buy bazaar → complete set →
      // exchange at museum for N points → sell points at current
      // pmarket rate. Only fires if the listing is at least
      // POINTS_BUY_DISCOUNT under the points-equivalent cash value, so
      // we dont flag rows that are just barely-below — a 1% under
      // bazaar isnt worth the friction of completing a set.
      let pointsDeal = null;
      if (pointsRate) {
        const set = setForItemId(itemId);
        if (set) {
          const ptsForItem = computePointsForItem(itemId, set, marketByItem);
          if (Number.isFinite(ptsForItem) && ptsForItem > 0) {
            const pointsCash = ptsForItem * pointsRate;
            const profit = pointsCash - bazaarPrice;
            if (profit > pointsCash * POINTS_BUY_DISCOUNT) {
              pointsDeal = {
                route: 'points',
                pointsPerItem: ptsForItem,
                pointsCash: pointsCash,
                setName: set.name,
                profit: profit,
                profitPct: (profit / bazaarPrice) * 100,
              };
            }
          }
        }
      }

      // Pick the better route for this item — bigger absolute profit
      // wins. We surface only one row per item to keep the bar tight;
      // both routes triggering on the same item is rare and the loser
      // is always strictly less profitable, so dropping it costs the
      // user nothing actionable.
      const winner = (marketDeal && pointsDeal)
        ? (pointsDeal.profit > marketDeal.profit ? pointsDeal : marketDeal)
        : (marketDeal || pointsDeal);
      if (!winner) continue;

      deals.push(Object.assign({
        item_id: itemId,
        name: itemNameFor(itemId),
        bazaarPrice: bazaarPrice,
        bazaar_owner_id: ownerId,
      }, winner));
    }
    if (deals.length === 0) return;
    if (myGeneration !== bazaarDealsGeneration) return;

    // Best margins first — most actionable deal at the top of the list.
    deals.sort(function (a, b) { return b.profitPct - a.profitPct; });

    injectBazaarDealsStyles();
    const bar = buildBazaarDealsBar(deals);

    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    // Final sweep right before insert: a parallel call could have inserted
    // its own bar between our start-of-function removal and now.
    document.querySelectorAll('#' + BAZAAR_DEALS_BAR_ID).forEach(function (n) { n.remove(); });
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
  // Aligned with DRIP_BAZAAR_FRESH_WINDOW_MS (the drip-scrape's "skip if
  // fresh" gate) — using a tighter window here would create a dead zone
  // where the bar hides data the drip refuses to refresh, leaving no
  // bazaar info visible for an item even though the pool has it. Bazaar
  // listings typically stay up for hours-to-days; 30 min is a reasonable
  // "actionable" window for buying decisions, and the row stamps the
  // freshness ("3m ago") so the player can judge for themselves.
  const LOWEST_PRICE_BAZAAR_MAX_AGE_MS = 30 * 60 * 1000;
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
      '  font-family: Arial, Helvetica, sans-serif;',
      '  color: #c8cdd8;',
      '  background: #161a22;',
      '  border: 1px solid #252a35;',
      '  border-left: 3px solid #4ae8a0;',
      '  border-radius: 4px;',
      '  box-sizing: border-box;',
      '  overflow: hidden;',
      '}',
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-row {',
      '  display: flex;',
      '  align-items: center;',
      '  flex-wrap: wrap;',
      '  gap: 6px 10px;',
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
      '#' + LOWEST_PRICE_BAR_ID + ' .vgl-lp-arrow {',
      '  color: #4ae8a0;',
      '  font-weight: 700;',
      '  margin-left: auto;',
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
  let lowestPriceGeneration = 0;
  async function injectLowestPriceBar() {
    const myGeneration = ++lowestPriceGeneration;
    const existing = document.getElementById(LOWEST_PRICE_BAR_ID);
    if (existing) existing.remove();
    if (indicatorsHidden) return;

    const itemId = detectItemMarketSingleItemId();
    if (!itemId) return;

    const [deal] = await Promise.all([
      fetchLowestBazaarForItem(itemId),
      ensureItemCatalog(),
    ]);
    if (myGeneration !== lowestPriceGeneration) return;
    if (!deal) return;

    injectLowestPriceStyles();
    const bar = buildLowestPriceBar(deal);

    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;

    // Final sweep right before insert: a parallel call could have inserted
    // its own bar between our start-of-function removal and now.
    document.querySelectorAll('#' + LOWEST_PRICE_BAR_ID).forEach(function (n) { n.remove(); });

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

  // -- Flash Deals bar -----------------------------------------------------
  // Pool-wide discovery surface on the Item Market page: cross-references
  // every fresh sell_prices floor against the highest fresh te_buy_prices
  // offer per item_id. When a market listing is priced below what the
  // best TornExchange trader will pay, the bar surfaces it as a one-tap
  // flip opportunity. Hidden when there are zero opportunities.
  //
  // When the player has filtered to a single item (hash carries
  // itemID=N), the bar scopes to that item only — same data path,
  // tighter query.

  const FLASH_DEALS_BAR_ID = 'valigia-flash-deals-bar';
  // Mirror the watchlist Item Market freshness window — a "fresh" market
  // floor must have been observed within the last 30 minutes for us to
  // claim it as a current opportunity. Stricter than the watchlist (1h)
  // because flash deals get acted on immediately, not tracked over time.
  const FLASH_DEAL_MARKET_MAX_AGE_MS = 30 * 60 * 1000;
  // Trader offers stay live for days; 24h matches the Sell-tab matcher.
  const FLASH_DEAL_TRADER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  // Below this absolute profit per unit, skip — the click cost on iPad
  // outweighs the gain. Empirical pick; tune if it filters real deals.
  const FLASH_DEAL_MIN_PROFIT = 10_000;
  // Cap rows in pool-wide mode. Bar is collapsed by default so a long
  // list has no UI cost, but iPad players generally only chase the top
  // handful and we want to keep the DOM bounded.
  const FLASH_DEAL_MAX_ROWS = 15;

  const FLASH_DEAL_CACHE_TTL_MS = 30_000;
  // Keyed by 'all' or `item:N` so a single-item drill doesn't poison
  // the pool-wide cache and vice-versa.
  const flashDealCache = new Map();

  // Generation guard: SPA hash navigation can spawn multiple
  // injectFlashDealsBar() calls in flight before any one has finished
  // its fetch + insert, and each call's "remove existing" check happens
  // before the await — so multiple calls all see "no existing" and stack
  // their bars at the end. Bumping this on every call and bailing if our
  // generation isn't current makes only the latest call paint.
  let flashDealsGeneration = 0;

  async function fetchFlashDeals(itemIdFilter) {
    const cacheKey = itemIdFilter ? 'item:' + itemIdFilter : 'all';
    const now = Date.now();
    const cached = flashDealCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.deals;

    const sellSinceIso = new Date(now - FLASH_DEAL_MARKET_MAX_AGE_MS).toISOString();
    // Bazaar listings stay actionable for the same window we use on the
    // Lowest Price Found bar — anything older than 30 min and the listing
    // is likely sold or pulled.
    const bazaarSinceIso = new Date(now - LOWEST_PRICE_BAZAAR_MAX_AGE_MS).toISOString();
    const tradeSinceIso = new Date(now - FLASH_DEAL_TRADER_MAX_AGE_MS).toISOString();

    let sellRows;
    let bazaarRows;
    let teRows;
    if (itemIdFilter) {
      [sellRows, bazaarRows, teRows] = await Promise.all([
        fetchJSON(
          SELL_PRICES_URL +
          '?item_id=eq.' + encodeURIComponent(itemIdFilter) +
          '&select=item_id,price,min_price,updated_at'
        ),
        fetchJSON(
          BAZAAR_PRICES_URL +
          '?item_id=eq.' + encodeURIComponent(itemIdFilter) +
          '&checked_at=gte.' + encodeURIComponent(bazaarSinceIso) +
          '&price=gt.1' +
          '&select=item_id,price,quantity,bazaar_owner_id,checked_at' +
          '&order=price.asc' +
          '&limit=20'
        ),
        fetchJSON(
          TE_BUY_PRICES_URL +
          '?item_id=eq.' + encodeURIComponent(itemIdFilter) +
          '&updated_at=gte.' + encodeURIComponent(tradeSinceIso) +
          '&select=item_id,handle,buy_price,updated_at' +
          '&order=buy_price.desc' +
          '&limit=5'
        ),
      ]);
    } else {
      // Pool-wide: anchor on freshly-scraped market and bazaar rows so the
      // trader IN-clause stays bounded. Bazaar items can be entirely absent
      // from sell_prices (obscure stuff with no recent market activity but
      // a cheap bazaar listing), so the trader query unions both id sets.
      [sellRows, bazaarRows] = await Promise.all([
        fetchJSON(
          SELL_PRICES_URL +
          '?updated_at=gte.' + encodeURIComponent(sellSinceIso) +
          '&min_price=gt.0' +
          '&select=item_id,price,min_price,updated_at' +
          '&order=updated_at.desc' +
          '&limit=400'
        ),
        fetchJSON(
          BAZAAR_PRICES_URL +
          '?checked_at=gte.' + encodeURIComponent(bazaarSinceIso) +
          '&price=gt.1' +
          '&select=item_id,price,quantity,bazaar_owner_id,checked_at' +
          '&order=price.asc' +
          '&limit=400'
        ),
      ]);
      const idSet = new Set();
      if (Array.isArray(sellRows)) {
        for (const r of sellRows) {
          if (r && Number.isFinite(r.item_id)) idSet.add(r.item_id);
        }
      }
      if (Array.isArray(bazaarRows)) {
        for (const r of bazaarRows) {
          if (r && Number.isFinite(r.item_id)) idSet.add(r.item_id);
        }
      }
      if (idSet.size === 0) {
        flashDealCache.set(cacheKey, { expiresAt: now + FLASH_DEAL_CACHE_TTL_MS, deals: [] });
        return [];
      }
      teRows = await fetchJSON(
        TE_BUY_PRICES_URL +
        '?item_id=in.(' + Array.from(idSet).join(',') + ')' +
        '&updated_at=gte.' + encodeURIComponent(tradeSinceIso) +
        '&select=item_id,handle,buy_price,updated_at'
      );
    }

    if (!Array.isArray(teRows) || teRows.length === 0) {
      flashDealCache.set(cacheKey, { expiresAt: now + FLASH_DEAL_CACHE_TTL_MS, deals: [] });
      return [];
    }

    // Highest buy_price per item_id; updated_at breaks ties so a
    // newly-scraped trader wins over a stale one at the same price.
    const bestTrader = new Map();
    for (const r of teRows) {
      if (!r || typeof r.item_id !== 'number' || typeof r.buy_price !== 'number') continue;
      const existing = bestTrader.get(r.item_id);
      if (
        !existing
        || r.buy_price > existing.buy_price
        || (r.buy_price === existing.buy_price && (r.updated_at || '') > (existing.updated_at || ''))
      ) {
        bestTrader.set(r.item_id, r);
      }
    }

    // Cheapest fresh bazaar listing per item_id. Pool already excludes
    // $1 placeholders and stale rows at the query layer; we just pick the
    // floor here. Multiple bazaars per item end up represented by the
    // single best deal — a player can drill into Item Market for that
    // item to see the rest via Lowest Price Found.
    const bestBazaar = new Map();
    if (Array.isArray(bazaarRows)) {
      for (const r of bazaarRows) {
        if (!r || typeof r.item_id !== 'number') continue;
        const price = Number(r.price);
        if (!Number.isFinite(price) || price <= 1) continue;
        const observedAt = r.checked_at ? new Date(r.checked_at).getTime() : 0;
        if (!observedAt || now - observedAt > LOWEST_PRICE_BAZAAR_MAX_AGE_MS) continue;
        const existing = bestBazaar.get(r.item_id);
        if (!existing || price < existing.price) {
          bestBazaar.set(r.item_id, { price, bazaar_owner_id: r.bazaar_owner_id, observed_at: observedAt });
        }
      }
    }

    const deals = [];

    // Source: market floor → trader. Selling to a trader is a direct
    // cash trade (no Item Market 5% fee), so the gross trader_price is
    // also the net you keep.
    if (Array.isArray(sellRows)) {
      for (const s of sellRows) {
        if (!s || typeof s.item_id !== 'number') continue;
        const floorRaw = s.min_price != null ? Number(s.min_price)
          : (s.price != null ? Number(s.price) : NaN);
        if (!Number.isFinite(floorRaw) || floorRaw <= 0) continue;
        const observedAt = s.updated_at ? new Date(s.updated_at).getTime() : 0;
        if (!observedAt || now - observedAt > FLASH_DEAL_MARKET_MAX_AGE_MS) continue;

        const trader = bestTrader.get(s.item_id);
        if (!trader) continue;
        const traderPrice = Number(trader.buy_price);
        if (!Number.isFinite(traderPrice) || traderPrice <= 0) continue;

        const profit = traderPrice - floorRaw;
        if (profit < FLASH_DEAL_MIN_PROFIT) continue;

        deals.push({
          source: 'market',
          item_id: s.item_id,
          buy_price: floorRaw,
          buy_label: 'Item Market',
          buy_link: 'https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=' + s.item_id,
          sell_price: traderPrice,
          sell_label: 'Trader',
          trader_handle: trader.handle,
          profit: profit,
          profit_pct: (profit / floorRaw) * 100,
          buy_observed_at: observedAt,
          sell_observed_at: trader.updated_at ? new Date(trader.updated_at).getTime() : 0,
        });
      }
    }

    // Source: bazaar listing → trader. Same fee rationale (no Item Market
    // fee on a trader sell). Click target is the specific bazaar.
    for (const [itemId, b] of bestBazaar) {
      const trader = bestTrader.get(itemId);
      if (!trader) continue;
      const traderPrice = Number(trader.buy_price);
      if (!Number.isFinite(traderPrice) || traderPrice <= 0) continue;

      const profit = traderPrice - b.price;
      if (profit < FLASH_DEAL_MIN_PROFIT) continue;

      deals.push({
        source: 'bazaar',
        item_id: itemId,
        buy_price: b.price,
        buy_label: 'Bazaar',
        buy_link: 'https://www.torn.com/bazaar.php?userId=' + b.bazaar_owner_id,
        sell_price: traderPrice,
        sell_label: 'Trader',
        trader_handle: trader.handle,
        profit: profit,
        profit_pct: (profit / b.price) * 100,
        buy_observed_at: b.observed_at,
        sell_observed_at: trader.updated_at ? new Date(trader.updated_at).getTime() : 0,
      });
    }

    deals.sort(function (a, b) { return b.profit - a.profit; });
    // Single-item mode lets both source variants through (one market +
    // one bazaar at most) so the player can compare; pool-wide caps at
    // FLASH_DEAL_MAX_ROWS.
    const trimmed = itemIdFilter ? deals.slice(0, 5) : deals.slice(0, FLASH_DEAL_MAX_ROWS);

    flashDealCache.set(cacheKey, { expiresAt: now + FLASH_DEAL_CACHE_TTL_MS, deals: trimmed });
    return trimmed;
  }

  function injectFlashDealsStyles() {
    if (document.getElementById('valigia-flash-deals-styles')) return;
    const css = [
      '#' + FLASH_DEALS_BAR_ID + ' {',
      '  all: initial;',
      '  display: block;',
      '  margin: 8px auto 12px;',
      '  max-width: 1100px;',
      '  font-family: Arial, Helvetica, sans-serif;',
      '  color: #c8cdd8;',
      '  background: #161a22;',
      '  border: 1px solid #252a35;',
      '  border-left: 3px solid #e8c84a;',
      '  border-radius: 4px;',
      '  box-sizing: border-box;',
      '  overflow: hidden;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-head {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 8px 12px;',
      '  cursor: pointer;',
      '  user-select: none;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-title {',
      '  color: #e8c84a;',
      '  font-weight: 700;',
      '  font-size: 12px;',
      '  letter-spacing: 0.12em;',
      '  text-transform: uppercase;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-count {',
      '  background: #e8c84a;',
      '  color: #0d0f14;',
      '  font-weight: 700;',
      '  font-size: 11px;',
      '  padding: 1px 7px;',
      '  border-radius: 999px;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-caret {',
      '  margin-left: auto;',
      '  color: #e8c84a;',
      '  font-size: 11px;',
      '  transition: transform 150ms;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + '.vgl-fd-open .vgl-fd-caret {',
      '  transform: rotate(180deg);',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-body {',
      '  display: none;',
      '  padding: 4px 10px 10px;',
      '  gap: 4px;',
      '  flex-direction: column;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + '.vgl-fd-open .vgl-fd-body {',
      '  display: flex;',
      '}',
      // Two-row layout: item name + profit on the header line, then
      // buy → sell on a wrap-friendly second line. Avoids the prior
      // single-line grid where 9-digit dollar amounts on a phone-width
      // screen forced the item-name column to 0px and clipped the
      // profit off the right edge under overflow:hidden.
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-row {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 4px;',
      '  padding: 6px 8px;',
      '  border: 1px solid #252a35;',
      '  border-radius: 3px;',
      '  background: rgba(232,200,74,0.04);',
      '  color: #c8cdd8;',
      '  font-size: 12px;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-head-line {',
      '  display: flex;',
      '  align-items: baseline;',
      '  gap: 8px;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-trade-line {',
      '  display: flex;',
      '  align-items: center;',
      '  flex-wrap: wrap;',
      '  gap: 4px 8px;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-item {',
      '  font-weight: 700;',
      '  color: #c8cdd8;',
      '  flex: 1 1 auto;',
      '  min-width: 0;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-buy, #' + FLASH_DEALS_BAR_ID + ' .vgl-fd-sell {',
      '  color: #c8cdd8;',
      '  text-decoration: none;',
      '  display: inline-flex;',
      '  align-items: baseline;',
      '  flex-wrap: wrap;',
      '  gap: 4px;',
      '  padding: 2px 4px;',
      '  border-radius: 2px;',
      '}',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-buy:active { background: rgba(232,200,74,0.18); }',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-sell:active { background: rgba(74,232,160,0.18); }',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-buy strong { color: #e8c84a; font-weight: 700; }',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-sell strong { color: #4ae8a0; font-weight: 700; }',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-handle { color: #8a8fa0; font-size: 11px; }',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-profit { color: #4ae8a0; font-weight: 700; white-space: nowrap; flex: 0 0 auto; }',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-arrow { color: #e8c84a; font-weight: 700; }',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-prefix { color: #8a8fa0; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }',
      '#' + FLASH_DEALS_BAR_ID + ' .vgl-fd-label { color: #8a8fa0; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }',
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'valigia-flash-deals-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildFlashDealsBar(deals) {
    const bar = document.createElement('div');
    bar.id = FLASH_DEALS_BAR_ID;

    const head = document.createElement('div');
    head.className = 'vgl-fd-head';
    const title = document.createElement('span');
    title.className = 'vgl-fd-title';
    title.textContent = 'Flash Deals';
    const count = document.createElement('span');
    count.className = 'vgl-fd-count';
    count.textContent = String(deals.length);
    const caret = document.createElement('span');
    caret.className = 'vgl-fd-caret';
    caret.textContent = '\u25BE';
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(caret);

    const body = document.createElement('div');
    body.className = 'vgl-fd-body';
    for (const d of deals) {
      // Two independent click targets per row \u2014 buy side opens the
      // venue (Item Market search or specific bazaar), sell side opens
      // the trader's TornExchange profile. Nested <a> isn't valid, so
      // the row container is a <div>.
      const row = document.createElement('div');
      row.className = 'vgl-fd-row';

      // Header line: item name (truncating) + profit pinned right.
      const headLine = document.createElement('div');
      headLine.className = 'vgl-fd-head-line';
      const name = document.createElement('span');
      name.className = 'vgl-fd-item';
      name.textContent = itemNameFor(d.item_id);
      const profit = document.createElement('span');
      profit.className = 'vgl-fd-profit';
      profit.textContent = '+' + formatMoney(d.profit);
      headLine.appendChild(name);
      headLine.appendChild(profit);

      // Trade line: buy \u2192 sell, wrapping if it doesn't fit.
      const tradeLine = document.createElement('div');
      tradeLine.className = 'vgl-fd-trade-line';

      const buy = document.createElement('a');
      buy.className = 'vgl-fd-buy';
      buy.href = d.buy_link;
      buy.target = '_top';
      buy.rel = 'noopener';
      const buyPrefix = document.createElement('span');
      buyPrefix.className = 'vgl-fd-prefix';
      buyPrefix.textContent = 'Buy';
      const buyStrong = document.createElement('strong');
      buyStrong.textContent = formatMoney(d.buy_price);
      const buyLabel = document.createElement('span');
      buyLabel.className = 'vgl-fd-label';
      buyLabel.textContent = d.buy_label;
      buy.appendChild(buyPrefix);
      buy.appendChild(buyStrong);
      buy.appendChild(buyLabel);

      const arrow = document.createElement('span');
      arrow.className = 'vgl-fd-arrow';
      arrow.textContent = '\u2192';

      const sell = document.createElement('a');
      sell.className = 'vgl-fd-sell';
      sell.href = 'https://tornexchange.com/prices/' + encodeURIComponent(d.trader_handle) + '/';
      sell.target = '_top';
      sell.rel = 'noopener';
      const sellPrefix = document.createElement('span');
      sellPrefix.className = 'vgl-fd-prefix';
      sellPrefix.textContent = 'Sell';
      const sellStrong = document.createElement('strong');
      sellStrong.textContent = formatMoney(d.sell_price);
      const sellLabel = document.createElement('span');
      sellLabel.className = 'vgl-fd-label';
      sellLabel.textContent = d.sell_label;
      const handle = document.createElement('span');
      handle.className = 'vgl-fd-handle';
      handle.textContent = '@' + d.trader_handle;
      sell.appendChild(sellPrefix);
      sell.appendChild(sellStrong);
      sell.appendChild(sellLabel);
      sell.appendChild(handle);

      tradeLine.appendChild(buy);
      tradeLine.appendChild(arrow);
      tradeLine.appendChild(sell);

      row.appendChild(headLine);
      row.appendChild(tradeLine);
      body.appendChild(row);
    }

    head.addEventListener('click', function () {
      bar.classList.toggle('vgl-fd-open');
    });

    bar.appendChild(head);
    bar.appendChild(body);
    return bar;
  }

  /**
   * Top-level entry. Safe to call on every Item Market dispatch — it
   * tears down any prior instance and silently no-ops when there are
   * no opportunities. When the user has drilled into a single item
   * (hash itemID=N) the bar scopes to that item; otherwise it surfaces
   * the top FLASH_DEAL_MAX_ROWS pool-wide opportunities.
   *
   * Stacks below the Watchlist Matches and Lowest Price Found bars
   * when present. Race-safe: each bar fights for its own slot, so the
   * final order ends up Watchlist → Lowest → Flash regardless of
   * fetch ordering.
   */
  async function injectFlashDealsBar() {
    const myGeneration = ++flashDealsGeneration;
    // Sweep any already-rendered bars before fetching too — keeps the
    // page tidy if a prior generation already painted.
    document.querySelectorAll('#' + FLASH_DEALS_BAR_ID).forEach(function (n) { n.remove(); });
    if (indicatorsHidden) return;

    const itemIdFilter = detectItemMarketSingleItemId();

    const [deals] = await Promise.all([
      fetchFlashDeals(itemIdFilter),
      ensureItemCatalog(),
    ]);
    if (myGeneration !== flashDealsGeneration) return;
    if (!deals || deals.length === 0) return;

    injectFlashDealsStyles();
    const bar = buildFlashDealsBar(deals);

    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;

    // Final sweep right before insert: a parallel call from an earlier
    // generation could have completed its fetch and inserted between our
    // generation check and now. querySelectorAll catches every duplicate
    // (getElementById would only return the first).
    document.querySelectorAll('#' + FLASH_DEALS_BAR_ID).forEach(function (n) { n.remove(); });

    const lowestBar = document.getElementById(LOWEST_PRICE_BAR_ID);
    const watchlistBar = document.getElementById(WATCHLIST_BAR_ID);
    const anchor = (lowestBar && lowestBar.parentNode === host) ? lowestBar
      : (watchlistBar && watchlistBar.parentNode === host) ? watchlistBar
      : null;
    if (anchor) {
      host.insertBefore(bar, anchor.nextSibling);
    } else {
      host.insertBefore(bar, host.firstChild);
    }
  }

  // -- Stakeout mode -------------------------------------------------------
  // Tier 3 of the restock-data-quality plan. When the user is abroad and
  // this toggle is ON, re-run runTravel() (in SILENT mode — see below)
  // every STAKEOUT_INTERVAL_MS so each upsert to abroad_prices gives the
  // restock trigger a chance to fire on a stock-up delta.
  //
  // Cadence = 15 s. The whole point of the forecaster's midpoint debias
  // (restock time estimated as the midpoint of the (pre, post] censoring
  // window) is that a tighter observation interval shrinks that window —
  // a refill caught within 15 s is dated to within ±7.5 s of reality
  // instead of ±2.5 min at the old 5-min cadence. That is the single
  // biggest lever a staker has on cadence-prediction accuracy.
  //
  // Why 15 s is safe:
  //   - ingest-travel-shop's per-player rate gate is 5 s (migration 027),
  //     so 15 s clears it with margin (going under 5 s would 429).
  //   - yata_snapshots dedups to one row per minute (migration 026's
  //     ON CONFLICT DO NOTHING), so the snapshot table doesn't bloat —
  //     extra ticks within a minute are silently collapsed. The win is
  //     restock *detection* latency, not snapshot volume.
  //
  // SILENT ticks: at 15 s, repainting the profit overlay and firing
  // toasts every tick would be intolerable "display churn". Stakeout
  // ticks therefore call runTravel({ silent: true }) — scrape + ingest
  // only, no overlay render, no parse panel, no toasts. The initial
  // landing render (the normal dispatch call) still paints everything;
  // only the background auto-ticks are quiet.
  //
  // User-facing UI is a small pill fixed to the top-right of the travel
  // page: [STAKEOUT: OFF] tap-to-enable, [STAKEOUT: ON · next 0:12]
  // tap-to-disable. Setting is persisted in localStorage so it survives
  // page reloads and re-landings.
  const STAKEOUT_INTERVAL_MS = 15 * 1000;
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
      text += ' \u00B7 next ' + formatCountdown(stakeout.nextTickAt - Date.now());
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
      toast('Stakeout enabled \u2014 silent rescrape every 15s', 'success');
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
      font: "600 11px/1 Arial, Helvetica, sans-serif",
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
    // Silent: scrape + ingest only. No overlay repaint, no toasts — at the
    // 15 s cadence those would be intolerable display churn. The data path
    // (abroad_prices upsert → restock/snapshot triggers) is unaffected.
    try { await runTravel({ silent: true }); } catch (e) { log('stakeout tick error:', e); }
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
    // Indicators hidden: skip the badge but keep a previously-enabled
    // stakeout's auto-scrape interval running — the stakeout's whole
    // point is gathering prices, which silent mode preserves. The badge
    // updater no-ops while stakeout.badge is null.
    if (indicatorsHidden) {
      unmountStakeoutBadge();
    } else {
      mountStakeoutBadge();
    }
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

  // -- In-flight destination strip ----------------------------------------
  // While the player is mid-flight Torn shows a static cloud-image banner
  // and a "Remaining Flight Time" countdown — no shop list to scrape, no
  // overlay to paint, just dead time. The strip injects a single static
  // (non-scrolling) row at the top of the page summarising what's actually
  // buyable at the destination right now: item · stock · buy → net sell ·
  // margin %. Sorted by margin desc, in-stock + positive-margin only,
  // filtered to a sane row count so the iPad layout stays scannable.
  //
  // Data source: YATA's public abroad-prices feed (yata.yt/api/v1/travel/
  // export/), same source the web app uses. Sell prices come from the
  // shared sell_prices cache via the existing fetchSellPrices() helper, so
  // the strip pieces together the same buy-vs-net-sell math as the
  // landed overlay. Both fetches run via gmRequest so PDA's webview CORS
  // doesn't block them.

  const INFLIGHT_BAR_ID = 'valigia-inflight-strip';
  // The four canonical Torn arbitrage categories. Filtering the strip
  // to these surfaces the items players actually fly to buy/sell, and
  // drops noise like alcohol/booster/melee/etc. Torn's items endpoint
  // returns these strings verbatim in the `type` field (capitalized,
  // singular). Match exactly.
  const INFLIGHT_ALLOWED_TYPES = new Set(['Drug', 'Flower', 'Plushie', 'Artifact']);
  // Generous upper bound rather than a hard top-N: every Drug/Flower/
  // Plushie/Artifact at the destination should fit comfortably under
  // this. Keeps a safety net against runaway DOM cost if Torn ever
  // dramatically expands the catalog.
  const INFLIGHT_MAX_ROWS = 50;
  // Slots to multiply the buy price by for the run-cost column. The web
  // app stores its slot count in localStorage under 'valigia_slots' on the
  // valigia.girovagabondo.com origin, which the userscript can't read
  // (cross-origin). Use a separate key the player can override:
  //   localStorage.setItem('valigia_pda_slots', '32')
  // Default 29 matches the web app and is correct for most players.
  const SLOTS_STORAGE_KEY = 'valigia_pda_slots';
  function getSlotCount() {
    try {
      const raw = localStorage.getItem(SLOTS_STORAGE_KEY);
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 5 && n <= 44) return n;
    } catch { /* ignore */ }
    return 29;
  }
  // One-way flight times in minutes, mirroring src/data/destinations.js
  // (game constants). The home-screen Best Run board uses these to turn
  // profit/run into profit/hr so destinations with different flight times
  // rank fairly against each other.
  const FLIGHT_MINS = {
    'Mexico': 20,
    'Canada': 37,
    'Caymans': 57,
    'Hawaii': 121,
    'UK': 152,
    'Switzerland': 169,
    'Argentina': 189,
    'Japan': 203,
    'China': 219,
    'UAE': 259,
    'South Africa': 311,
  };
  // Flight-time multiplier: 1.0 standard, 0.7 airstrip/WLT, 0.49 both.
  // Like the slot count, the web app's value lives on an origin we can't
  // read cross-origin, so the player overrides via:
  //   localStorage.setItem('valigia_pda_flight_mult', '0.7')
  const FLIGHT_MULT_STORAGE_KEY = 'valigia_pda_flight_mult';
  function getFlightMultiplier() {
    try {
      const n = Number(localStorage.getItem(FLIGHT_MULT_STORAGE_KEY));
      if (Number.isFinite(n) && n > 0 && n <= 1) return n;
    } catch { /* ignore */ }
    return 1.0;
  }
  const YATA_EXPORT_URL = 'https://yata.yt/api/v1/travel/export/';
  // Mirrors src/log-sync.js — YATA keys destinations by lowercase 3-letter
  // codes, which we map back to the same canonical names the rest of this
  // userscript and the web app use.
  const YATA_COUNTRY_MAP = {
    mex: 'Mexico',
    cay: 'Caymans',
    can: 'Canada',
    haw: 'Hawaii',
    uni: 'UK',
    arg: 'Argentina',
    swi: 'Switzerland',
    jap: 'Japan',
    chi: 'China',
    uae: 'UAE',
    sou: 'South Africa',
  };

  // Fetch the full YATA export once and flatten it into rows tagged with
  // their canonical destination. The home-screen Best Run board ranks
  // across every destination, so it needs all of them; the single-
  // destination in-flight strip filters this down via the wrapper below.
  async function fetchYataAll() {
    try {
      const res = await gmRequest({
        method: 'GET',
        url: YATA_EXPORT_URL,
        headers: { 'Accept': 'application/json' },
      });
      if (res.status < 200 || res.status >= 300) return [];
      const data = JSON.parse(res.responseText || '{}');
      const countries = data.stocks || data;
      const out = [];
      for (const code of Object.keys(countries)) {
        const dest = YATA_COUNTRY_MAP[code];
        if (!dest) continue;
        const stocks = (countries[code] && countries[code].stocks) || [];
        for (const s of stocks) {
          if (!s || !s.id || !s.cost) continue;
          out.push({
            item_id: Number(s.id),
            name: s.name || ('Item ' + s.id),
            buy_price: Number(s.cost),
            stock: Number.isFinite(Number(s.quantity)) ? Number(s.quantity) : null,
            destination: dest,
          });
        }
      }
      return out;
    } catch (e) {
      log('yata fetch failed', e);
      return [];
    }
  }

  async function fetchYataForDestination(destination) {
    const all = await fetchYataAll();
    return all.filter(function (r) { return r.destination === destination; });
  }

  // -- First-party scout scrapes (abroad_prices) -------------------------
  // Mirrors the merge policy in src/log-sync.js: a Valigia Scout (any
  // userscript user who's landed at the destination recently) writes
  // freshly-scraped buy_price/stock into abroad_prices via the
  // ingest-travel-shop edge function. Anything we observed within
  // FIRST_PARTY_FRESH_MS overrides YATA — we trust our own scrape over a
  // crowd-sourced reading that may be 10-30 min stale. Long-term goal:
  // weaning the in-flight strip off YATA entirely once scout coverage is
  // wide enough that every destination has a fresh first-party reading on
  // every flight. This is the first step.
  const FIRST_PARTY_FRESH_MS = 10 * 60 * 1000;
  // Pad a couple minutes for clock skew when filtering server-side.
  const FIRST_PARTY_QUERY_WINDOW_MS = 12 * 60 * 1000;

  async function fetchAbroadScrapes(destination) {
    if (!destination) return new Map();
    const sinceIso = new Date(Date.now() - FIRST_PARTY_QUERY_WINDOW_MS).toISOString();
    const url = ABROAD_PRICES_URL +
      '?select=item_id,item_name,buy_price,stock,observed_at' +
      '&destination=eq.' + encodeURIComponent(destination) +
      '&observed_at=gte.' + encodeURIComponent(sinceIso) +
      '&order=observed_at.desc';
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
      // Multiple scouts may land in the same window — keep the freshest
      // observation per item_id. Rows arrived ordered desc by observed_at,
      // so the first hit per item is already the freshest.
      const freshest = new Map();
      const cutoff = Date.now() - FIRST_PARTY_FRESH_MS;
      for (const r of rows) {
        if (!r) continue;
        const itemId = Number(r.item_id);
        if (!Number.isFinite(itemId)) continue;
        if (freshest.has(itemId)) continue;
        const t = new Date(r.observed_at).getTime();
        if (!Number.isFinite(t) || t < cutoff) continue;
        freshest.set(itemId, {
          item_id: itemId,
          name: r.item_name || ('Item ' + itemId),
          buy_price: Number(r.buy_price),
          stock: Number.isFinite(Number(r.stock)) ? Number(r.stock) : null,
          observedAt: t,
        });
      }
      return freshest;
    } catch (e) {
      return new Map();
    }
  }

  // All-destinations variant of fetchAbroadScrapes for the home-screen Best
  // Run board. Same freshness policy, but the result map is keyed by
  // 'destination|item_id' since the same item_id (e.g. Xanax in Japan and
  // South Africa) appears at multiple destinations.
  async function fetchAbroadScrapesAll() {
    const sinceIso = new Date(Date.now() - FIRST_PARTY_QUERY_WINDOW_MS).toISOString();
    const url = ABROAD_PRICES_URL +
      '?select=item_id,buy_price,stock,destination,observed_at' +
      '&observed_at=gte.' + encodeURIComponent(sinceIso) +
      '&order=observed_at.desc';
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
      const freshest = new Map();
      const cutoff = Date.now() - FIRST_PARTY_FRESH_MS;
      for (const r of rows) {
        if (!r || !r.destination) continue;
        const itemId = Number(r.item_id);
        if (!Number.isFinite(itemId)) continue;
        const key = r.destination + '|' + itemId;
        if (freshest.has(key)) continue;
        const t = new Date(r.observed_at).getTime();
        if (!Number.isFinite(t) || t < cutoff) continue;
        freshest.set(key, {
          buy_price: Number(r.buy_price),
          stock: Number.isFinite(Number(r.stock)) ? Number(r.stock) : null,
        });
      }
      return freshest;
    } catch (e) {
      return new Map();
    }
  }

  // -- Depletion-slope fitter (slim port of stock-forecast.js) ------------
  // For each (item_id, destination) we want a per-minute steady-state
  // depletion rate so the strip can answer "how much will be left when I
  // land?". The web app's stock-forecast.js does this with restock cadence,
  // confidence tiers, and a 48h history window — overkill for a quick
  // arrival estimate. We use the last 2 hours of yata_snapshots, segment
  // by restock boundaries (positive deltas), least-squares fit a slope per
  // segment, and weighted-median pool. Same algorithm as the web app's
  // pooledDepletionSlope(), just compressed.
  // Match the web app's HISTORY_WINDOW_MINS exactly (src/stock-forecast.js).
  // Initial guess of 2h was wrong: yata_snapshots is dedup-on-write (only
  // inserts when stock or buy_price changes), so a stable shelf can have
  // < 2 samples over a 2-hour window even when it has dozens over 48
  // hours. The web app's pooledDepletionSlope explicitly handles 48h of
  // data — splits on restock boundaries and weighted-medians the
  // per-segment slopes — so widening here doesn't dilute the fit, it
  // just gives the fitter material to work with.
  const SNAPSHOTS_HISTORY_MINS = 48 * 60;
  const YATA_SNAPSHOTS_URL = SUPABASE_REST_URL + '/yata_snapshots';

  async function fetchYataSnapshots(itemIds, destination) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) return new Map();
    if (!destination) return new Map();
    const cutoffIso = new Date(Date.now() - SNAPSHOTS_HISTORY_MINS * 60_000).toISOString();
    const idList = itemIds.join(',');
    const url = YATA_SNAPSHOTS_URL +
      '?select=item_id,quantity,snapped_at' +
      '&item_id=in.(' + idList + ')' +
      '&destination=eq.' + encodeURIComponent(destination) +
      '&snapped_at=gte.' + encodeURIComponent(cutoffIso) +
      '&order=snapped_at.asc' +
      '&limit=20000';
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
      // Coerce numeric columns explicitly: yata_snapshots.quantity is
      // bigint (migration 010), and raw PostgREST may return bigint
      // values as strings. The web app's Supabase JS SDK auto-coerces;
      // we don't get that for free here, so the strict typeof === 'number'
      // check we used previously silently dropped every snapshot row,
      // which is why the strip's "on arrival" column went all-dashes
      // overnight despite the data being there.
      for (const r of rows) {
        if (!r) continue;
        const itemId = Number(r.item_id);
        const qty = Number(r.quantity);
        if (!Number.isFinite(itemId) || !Number.isFinite(qty)) continue;
        const t = new Date(r.snapped_at).getTime();
        if (!Number.isFinite(t)) continue;
        let arr = byItem.get(itemId);
        if (!arr) { arr = []; byItem.set(itemId, arr); }
        arr.push({ q: qty, t: t });
      }
      return byItem;
    } catch (e) {
      return new Map();
    }
  }

  // Walk a chronologically-sorted sample series and split into runs of
  // non-increasing quantity; a strictly-positive delta is a restock and
  // breaks the run. Same shape as stock-forecast.js's allDepletionSegments.
  function splitDepletionSegments(samples) {
    if (!samples || samples.length < 2) return [];
    const segs = [];
    let cur = [samples[0]];
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].q > cur[cur.length - 1].q) {
        if (cur.length >= 2) segs.push(cur);
        cur = [samples[i]];
      } else {
        cur.push(samples[i]);
      }
    }
    if (cur.length >= 2) segs.push(cur);
    return segs;
  }

  // Least-squares slope of quantity vs minutes-since-segment-start.
  // Returns null on degenerate segments (single sample, all same time).
  function fitSlope(seg) {
    if (!seg || seg.length < 2) return null;
    const t0 = seg[0].t;
    let n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const s of seg) {
      const x = (s.t - t0) / 60_000;
      const y = s.q;
      sx += x; sy += y; sxy += x * y; sxx += x * x; n++;
    }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    return (n * sxy - sx * sy) / denom;
  }

  // Weighted-median pool of per-segment slopes, weighted by segment length.
  // Drops positive slopes (numerical noise on flat segments); keeps zeros.
  // Returns units/min (≤ 0) or null when no usable slope.
  function poolSlope(segments) {
    const weighted = [];
    for (const seg of segments) {
      const s = fitSlope(seg);
      if (s == null || s > 0) continue;
      weighted.push({ s: s, w: seg.length });
    }
    if (weighted.length === 0) return null;
    weighted.sort(function (a, b) { return a.s - b.s; });
    const total = weighted.reduce(function (acc, x) { return acc + x.w; }, 0);
    let acc = 0;
    let picked = weighted[weighted.length - 1].s;
    for (const w of weighted) {
      acc += w.w;
      if (acc >= total / 2) { picked = w.s; break; }
    }
    return picked;
  }

  // Top-level: turns a samples array into a per-minute depletion rate.
  // null when we can't fit one (no history, all flat, single restock cycle
  // shorter than 2 samples, etc.) — caller falls back to "stock now".
  function depletionRatePerMin(samples) {
    return poolSlope(splitDepletionSegments(samples || []));
  }

  function injectInFlightStyles() {
    if (document.getElementById('valigia-inflight-styles')) return;
    const css = [
      '#' + INFLIGHT_BAR_ID + ' {',
      '  all: initial;',
      '  display: block;',
      '  margin: 8px auto 12px;',
      '  max-width: 1100px;',
      '  font-family: Arial, Helvetica, sans-serif;',
      '  color: #c8cdd8;',
      '  background: #161a22;',
      '  border: 1px solid #252a35;',
      '  border-left: 3px solid #e8c84a;',
      '  border-radius: 4px;',
      '  box-sizing: border-box;',
      '  overflow: hidden;',
      '}',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-head {',
      '  display: flex; align-items: center; gap: 8px;',
      '  padding: 8px 12px;',
      '  cursor: pointer; user-select: none;',
      '}',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-title {',
      '  color: #e8c84a; font-weight: 700; font-size: 12px;',
      '  letter-spacing: 0.12em; text-transform: uppercase;',
      '}',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-dest {',
      '  color: #c8cdd8; font-size: 11px; opacity: 0.8;',
      '}',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-count {',
      '  margin-left: auto; background: #e8c84a; color: #0d0f14;',
      '  font-weight: 700; font-size: 11px; padding: 1px 7px;',
      '  border-radius: 999px;',
      '}',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-caret {',
      '  color: #e8c84a; font-size: 11px;',
      '  transition: transform 150ms;',
      '}',
      '#' + INFLIGHT_BAR_ID + '.vgl-if-open .vgl-if-caret {',
      '  transform: rotate(180deg);',
      '}',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-body {',
      '  display: none;',
      '  flex-direction: column; gap: 3px;',
      '  padding: 4px 10px 10px;',
      '}',
      '#' + INFLIGHT_BAR_ID + '.vgl-if-open .vgl-if-body {',
      '  display: flex;',
      '}',
      // Five columns, all on a single line. Name flexes; the four numeric
      // cells size to content with right alignment so they read like a
      // table. min-width:0 on name lets ellipsis kick in cleanly when an
      // item name is unusually long instead of pushing the row to wrap.
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-row {',
      '  display: grid;',
      '  grid-template-columns: minmax(0,1fr) auto auto auto auto;',
      '  align-items: baseline; gap: 12px;',
      '  padding: 5px 8px;',
      '  border: 1px solid #252a35; border-radius: 3px;',
      '  background: rgba(232,200,74,0.04);',
      '  font-size: 12px;',
      '}',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-name { font-weight: 700; color: #c8cdd8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-buy { color: #c8cdd8; white-space: nowrap; text-align: right; }',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-runcost { color: #e8c84a; font-weight: 700; white-space: nowrap; text-align: right; }',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-stock { color: #8a8fa0; font-size: 11px; white-space: nowrap; text-align: right; }',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-arrival { color: #4ae8a0; font-weight: 700; white-space: nowrap; text-align: right; }',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-arrival--empty { color: #e8824a; }',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-arrival--unknown { color: #5a6070; font-weight: 400; }',
      '#' + INFLIGHT_BAR_ID + ' .vgl-if-empty {',
      '  display: none;',
      '  padding: 4px 12px 10px; font-size: 11px; color: #8a8fa0;',
      '}',
      '#' + INFLIGHT_BAR_ID + '.vgl-if-open .vgl-if-empty {',
      '  display: block;',
      '}',
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'valigia-inflight-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildInFlightStrip(destination, rows) {
    const bar = document.createElement('div');
    bar.id = INFLIGHT_BAR_ID;

    const head = document.createElement('div');
    head.className = 'vgl-if-head';
    const title = document.createElement('span');
    title.className = 'vgl-if-title';
    title.textContent = 'Arriving Soon';
    const dest = document.createElement('span');
    dest.className = 'vgl-if-dest';
    // Middle dot (U+00B7) and the row arrow (U+2192) below are escaped
    // rather than written as literal multi-byte UTF-8: the FTP deploy
    // pipeline mangles unescaped non-ASCII into latin-1, which renders
    // as garbled mojibake on iPad. Match the watchlist bar's convention.
    dest.textContent = '\u00B7 ' + destination;
    head.appendChild(title);
    head.appendChild(dest);

    const count = document.createElement('span');
    count.className = 'vgl-if-count';
    count.textContent = String(rows.length);
    head.appendChild(count);

    const caret = document.createElement('span');
    caret.className = 'vgl-if-caret';
    caret.textContent = '\u25BE';
    head.appendChild(caret);

    bar.appendChild(head);

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vgl-if-empty';
      empty.textContent = 'No profitable in-stock items right now.';
      bar.appendChild(empty);
    } else {
      const body = document.createElement('div');
      body.className = 'vgl-if-body';
      for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'vgl-if-row';

        // Five cells, in order: name | unit price | run cost
        // (price * slots) | current stock | predicted on arrival.
        const name = document.createElement('span');
        name.className = 'vgl-if-name';
        name.textContent = r.name;

        const buy = document.createElement('span');
        buy.className = 'vgl-if-buy';
        buy.textContent = formatMoneyCompact(r.buy_price);

        const runcost = document.createElement('span');
        runcost.className = 'vgl-if-runcost';
        runcost.textContent = formatMoneyCompact(r.runCost);

        const stock = document.createElement('span');
        stock.className = 'vgl-if-stock';
        stock.textContent = (r.stock != null ? r.stock.toLocaleString('en-US') : '?') + ' stock';

        // Predicted-arrival cell: green number when we have a slope and
        // Arrival cell: green when we have a real depletion fit, muted
        // when we fell back to slope=0 (no observed depletion in the
        // 2h window so the prediction equals current stock). Amber
        // "may sell out" wins regardless of source when predicted hits 0.
        const arrival = document.createElement('span');
        arrival.className = 'vgl-if-arrival';
        if (r.predictedStock != null) {
          if (r.predictedStock <= 0) {
            arrival.textContent = 'may sell out';
            arrival.classList.add('vgl-if-arrival--empty');
          } else {
            // "post-refill" suffix when the prediction depends on a
            // restock event landing during the flight \u2014 the player
            // should know they're betting on the cadence holding.
            const suffix = r.postRefill ? ' post-refill' : ' arr.';
            arrival.textContent = '\u2248 ' + r.predictedStock.toLocaleString('en-US') + suffix;
            if (!r.predictedFromSlope) {
              arrival.classList.add('vgl-if-arrival--unknown');
            }
          }
        } else {
          arrival.textContent = '\u2014 arr.';
          arrival.classList.add('vgl-if-arrival--unknown');
        }

        row.appendChild(name);
        row.appendChild(buy);
        row.appendChild(runcost);
        row.appendChild(stock);
        row.appendChild(arrival);
        body.appendChild(row);
      }
      bar.appendChild(body);
    }

    head.addEventListener('click', function () {
      bar.classList.toggle('vgl-if-open');
    });

    return bar;
  }

  // Top-level injection. Idempotent: tears down any previous strip before
  // rendering, so a hashchange-driven re-dispatch on the travel page never
  // stacks duplicates. Silent on any data failure — the player still has
  // the cloud image, they just don't get a preview.
  let inFlightGeneration = 0;
  async function injectInFlightStrip(destination, remainingMins) {
    const myGeneration = ++inFlightGeneration;
    const existing = document.getElementById(INFLIGHT_BAR_ID);
    if (existing) existing.remove();
    if (indicatorsHidden) return;

    // Fire YATA + first-party scrapes + item catalog warm in parallel.
    // The catalog is needed to filter the strip by Torn's type field
    // (Drug / Flower / Plushie / Artifact); without it we can't tell
    // a Cherry Blossom from a Bottle of Sake. Cache hit is free; cold
    // first run pays one Torn API call.
    const [yataRows, scoutMap] = await Promise.all([
      fetchYataForDestination(destination),
      fetchAbroadScrapes(destination),
      ensureItemCatalog(),
    ]);

    // Build the merged row list. Every YATA row is kept (so the strip
    // covers items even when no scout has visited recently); when a fresh
    // scout reading exists for the same item_id, its stock + buy_price
    // override YATA's. We also surface scout-only items (e.g. a brand-new
    // shelf YATA hasn't picked up yet) by appending them after the YATA pass.
    const merged = [];
    const seen = new Set();
    for (const y of yataRows) {
      const s = scoutMap.get(y.item_id);
      if (s) {
        merged.push({
          item_id: y.item_id,
          name: y.name || s.name,
          buy_price: Number.isFinite(s.buy_price) ? s.buy_price : y.buy_price,
          stock: s.stock != null ? s.stock : y.stock,
          source: 'scout',
        });
      } else {
        merged.push({
          item_id: y.item_id,
          name: y.name,
          buy_price: y.buy_price,
          stock: y.stock,
          source: 'yata',
        });
      }
      seen.add(y.item_id);
    }
    for (const [itemId, s] of scoutMap) {
      if (seen.has(itemId)) continue;
      if (!Number.isFinite(s.buy_price) || s.buy_price <= 0) continue;
      merged.push({
        item_id: itemId,
        name: s.name,
        buy_price: s.buy_price,
        stock: s.stock,
        source: 'scout',
      });
    }

    if (merged.length === 0) {
      log('inflight: no rows for ' + destination + ' (yata=0, scout=0)');
      return;
    }

    const itemIds = merged.map(function (r) { return r.item_id; });
    // Three parallel reads: sell prices for margin math, snapshots for
    // depletion slope, restock events for during-flight refill modeling.
    const [sellMap, snapshotsMap, restockMap] = await Promise.all([
      fetchSellPrices(itemIds),
      fetchYataSnapshots(itemIds, destination),
      fetchRestockEvents(itemIds, destination),
    ]);

    const slots = getSlotCount();
    const ranked = [];
    let slopeHits = 0;
    let slopeMisses = 0;
    let restockOverrides = 0;
    let typeFiltered = 0;
    const nowMs = Date.now();
    for (const r of merged) {
      // Drop anything that isn't one of the four canonical arbitrage
      // categories. Items the catalog hasn't resolved yet (type=null)
      // are dropped too — better to wait one dispatch for the warm
      // than to flash non-arbitrage items and remove them on rerender.
      const itype = itemTypeFor(r.item_id);
      if (!itype || !INFLIGHT_ALLOWED_TYPES.has(itype)) {
        typeFiltered++;
        continue;
      }
      const sell = sellMap.get(r.item_id);
      if (!sell || !Number.isFinite(sell.price)) continue;
      const netSell = sell.price * 0.95;
      const margin = netSell - r.buy_price;
      if (margin <= 0) continue;
      // Don't early-drop stock=0 rows: they're exactly the case where
      // the restock-during-flight model wins. Drop happens later if the
      // predictor can't produce a positive arrival estimate.
      const stockNow = r.stock;

      // Predicted stock at arrival. Three branches:
      //   A. stock > 0 with depletion slope: stock + slope * remainingMins.
      //      If slope drives it to 0 AND a restock is due during flight,
      //      apply the post-restock branch below to replace 0.
      //   B. stock == 0: rely entirely on the restock-during-flight
      //      branch — typicalPostQty + slope * (remainingMins -
      //      timeToNext). When neither slope nor restock apply, drop.
      //   C. stock > 0 with no slope data: assume slope=0 (predicted =
      //      stock now). Muted in the UI to flag the guess.
      let predicted = null;
      let predictedFromSlope = false;
      let postRefill = false;
      if (Number.isFinite(remainingMins) && remainingMins > 0) {
        const slope = depletionRatePerMin(snapshotsMap.get(r.item_id));
        const plan = estimateRestockPlan(restockMap.get(r.item_id), nowMs);
        const restockDuringFlight = !!(plan &&
          plan.timeToNextMins <= remainingMins &&
          Number.isFinite(plan.typicalPostQty));

        if (stockNow != null && stockNow > 0) {
          if (slope != null) {
            predicted = Math.max(0, Math.round(stockNow + slope * remainingMins));
            predictedFromSlope = true;
            slopeHits++;
          } else {
            predicted = stockNow;
            slopeMisses++;
          }
          // Empty-shelf override: if depletion bottoms out at 0 and a
          // restock is due, project post-restock depletion. Same math as
          // branch B below.
          if (predicted === 0 && restockDuringFlight) {
            const slopeForProj = slope != null ? slope : 0;
            const timeAfterRestock = remainingMins - plan.timeToNextMins;
            predicted = Math.max(0, Math.round(
              plan.typicalPostQty + slopeForProj * timeAfterRestock
            ));
            predictedFromSlope = true;
            postRefill = true;
            restockOverrides++;
          }
        } else if (stockNow === 0 && restockDuringFlight) {
          // Branch B — currently empty, refilling during flight. Apply
          // post-restock depletion using the steady-state slope (or 0
          // when we have no slope data).
          const slopeForProj = slope != null ? slope : 0;
          const timeAfterRestock = remainingMins - plan.timeToNextMins;
          predicted = Math.max(0, Math.round(
            plan.typicalPostQty + slopeForProj * timeAfterRestock
          ));
          predictedFromSlope = true;
          postRefill = true;
          restockOverrides++;
        }
      }

      // Drop rows with no actionable arrival count: stock=0 now AND no
      // restock predicted during flight. Nothing to buy.
      if (predicted == null || predicted <= 0) continue;
      // Run cost: unit price × min(predicted, slots). Use predicted
      // rather than current stock so a refilling shelf shows real
      // expected spend, not $0 because it's empty right now.
      const effectiveSlots = predicted < slots ? predicted : slots;
      const runCost = r.buy_price * effectiveSlots;
      ranked.push({
        item_id: r.item_id,
        name: r.name,
        stock: r.stock,
        predictedStock: predicted,
        predictedFromSlope: predictedFromSlope,
        postRefill: postRefill,
        buy_price: r.buy_price,
        runCost: runCost,
        netSell: netSell,
        margin: margin,
        marginPct: (margin / r.buy_price) * 100,
      });
    }
    ranked.sort(function (a, b) { return b.marginPct - a.marginPct; });
    const top = ranked.slice(0, INFLIGHT_MAX_ROWS);

    if (DEBUG) {
      // Counts the userscript-side breakdown of where the strip's
      // numbers come from. Visible on iPad as a fixed black panel
      // (debugPanel renders to the page; PDA has no console).
      let snapshotItems = 0;
      let snapshotSamples = 0;
      for (const arr of snapshotsMap.values()) {
        snapshotItems++;
        snapshotSamples += arr.length;
      }
      let scoutCount = 0;
      for (const r of merged) if (r.source === 'scout') scoutCount++;
      debugPanel([
        'inflight ' + destination,
        'remaining=' + (remainingMins != null ? Math.round(remainingMins) + 'm' : '?'),
        'merged=' + merged.length + ' ranked=' + ranked.length,
        'sources: scout=' + scoutCount + ' yata=' + (merged.length - scoutCount),
        'snapshots: items=' + snapshotItems + ' samples=' + snapshotSamples,
        'filter: typeFiltered=' + typeFiltered + ' (kept Drug/Flower/Plushie/Artifact)',
        'predict: slopeHits=' + slopeHits + ' slopeMisses=' + slopeMisses + ' restockOverrides=' + restockOverrides,
      ]);
    }

    if (myGeneration !== inFlightGeneration) return;
    injectInFlightStyles();
    const bar = buildInFlightStrip(destination, top);
    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    // Final sweep right before insert: a parallel call could have inserted
    // its own strip between our start-of-function removal and now.
    document.querySelectorAll('#' + INFLIGHT_BAR_ID).forEach(function (n) { n.remove(); });
    host.insertBefore(bar, host.firstChild);
  }

  // -- Home Best Run board -------------------------------------------------
  // Mirrors the web app's "Best Run Right Now" card, but built for the one
  // screen the travel runner was previously silent on: the country picker
  // (and the return leg), where the player is deciding where to fly next.
  // It ranks every destination's strongest in-stock arbitrage run by
  // profit/hr and headlines the single best, so the decision is one glance.
  // Pure recommendation surface — Torn's travel form has no GET deep-link
  // to pre-select a destination, so rows aren't tap targets (same as the
  // web card, whose CTA just points back at the travel page).
  const BESTRUN_BAR_ID = 'valigia-bestrun-bar';
  const BESTRUN_MAX_ROWS = 11;

  function injectBestRunStyles() {
    if (document.getElementById('valigia-bestrun-styles')) return;
    const css = [
      '#' + BESTRUN_BAR_ID + ' {',
      '  margin: 6px 8px; border: 1px solid #e8c84a; border-radius: 5px;',
      '  background: #161a22; font-family: inherit; overflow: hidden;',
      '}',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-head {',
      '  display: flex; align-items: baseline; gap: 8px; cursor: pointer;',
      '  padding: 8px 10px;',
      '}',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-label {',
      '  font-size: 11px; font-weight: 700; text-transform: uppercase;',
      '  letter-spacing: 0.06em; color: #e8c84a; white-space: nowrap;',
      '}',
      // Headline pick stays visible while collapsed so the bar is useful
      // without a tap; flexes and ellipsises so long names never wrap.
      '#' + BESTRUN_BAR_ID + ' .vgl-br-pick {',
      '  flex: 1 1 auto; min-width: 0; font-weight: 700; color: #c8cdd8;',
      '  font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
      '}',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-rate {',
      '  font-weight: 700; color: #e8c84a; font-size: 12px; white-space: nowrap;',
      '}',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-caret {',
      '  color: #e8c84a; font-size: 10px; transition: transform 0.15s ease;',
      '}',
      '#' + BESTRUN_BAR_ID + '.vgl-br-open .vgl-br-caret { transform: rotate(180deg); }',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-body {',
      '  display: none; flex-direction: column; gap: 3px; padding: 0 10px 10px;',
      '}',
      '#' + BESTRUN_BAR_ID + '.vgl-br-open .vgl-br-body { display: flex; }',
      // Four columns: item (flex) | destination | profit/run | profit/hr.
      '#' + BESTRUN_BAR_ID + ' .vgl-br-row {',
      '  display: grid; grid-template-columns: minmax(0,1fr) auto auto auto auto;',
      '  align-items: baseline; gap: 10px; padding: 5px 8px;',
      '  border: 1px solid #252a35; border-radius: 3px;',
      '  background: rgba(232,200,74,0.04); font-size: 12px;',
      '}',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-name { font-weight: 700; color: #c8cdd8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-dest { color: #8a8fa0; font-size: 11px; white-space: nowrap; text-align: right; }',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-dest--limited { color: #e8824a; }',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-refill { color: #4ae8a0; font-size: 11px; white-space: nowrap; text-align: right; }',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-refill--none { color: #5a6070; }',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-run { color: #c8cdd8; white-space: nowrap; text-align: right; }',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-hr { color: #e8c84a; font-weight: 700; white-space: nowrap; text-align: right; }',
      // Country picker in the header. Flex-grows to fill the space the
      // collapsed headline used to take. Dark to match the cargo terminal.
      '#' + BESTRUN_BAR_ID + ' .vgl-br-select {',
      '  flex: 1 1 auto; min-width: 0; max-width: 100%;',
      '  background: #0d0f14; color: #c8cdd8; border: 1px solid #252a35;',
      '  border-radius: 3px; font-size: 12px; font-family: inherit;',
      '  padding: 2px 4px;',
      '}',
      // Country-detail row cells. Price (gold), depletion (muted), restock
      // reuses .vgl-br-refill (green). Same 5-col grid as the best-run rows.
      '#' + BESTRUN_BAR_ID + ' .vgl-br-price { color: #e8c84a; white-space: nowrap; text-align: right; }',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-depl { color: #8a8fa0; font-size: 11px; white-space: nowrap; text-align: right; }',
      '#' + BESTRUN_BAR_ID + ' .vgl-br-detail-msg { color: #8a8fa0; font-size: 12px; padding: 6px 8px; }',
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'valigia-bestrun-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // localStorage-persisted country-view selection. Empty string = "Top
  // picks" (the cross-country best-run ranking); any other value is a single
  // destination whose full item list is shown instead.
  const COUNTRY_VIEW_KEY = 'valigia_pda_country_view';
  function getCountryView() {
    try { return localStorage.getItem(COUNTRY_VIEW_KEY) || ''; }
    catch (e) { return ''; }
  }
  function setCountryView(v) {
    try {
      if (v) localStorage.setItem(COUNTRY_VIEW_KEY, v);
      else localStorage.removeItem(COUNTRY_VIEW_KEY);
    } catch (e) { /* private mode \u2014 selection just won't persist */ }
  }

  // Per-country detail list. Answers "should I fly here?": every item the
  // country stocks, with current stock, price, depletion rate, and \u2014 the key
  // bit \u2014 the next restock ETA for items that are out of stock right now.
  // Deliberately NO profit math or ranking: this is an "is my item here /
  // when will it be / how much" lookup, not a best-run board.
  async function renderCountryDetail(destination, body, generation) {
    body.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'vgl-br-detail-msg';
    loading.textContent = 'Loading ' + destination + '\u2026';
    body.appendChild(loading);

    const [yataRows, scoutMap] = await Promise.all([
      fetchYataForDestination(destination),
      fetchAbroadScrapes(destination),
    ]);
    if (generation !== bestRunGeneration) return;

    // Merge YATA with fresh first-party scrapes (scout stock/price wins).
    // Scout-only items (a shelf YATA hasn't picked up) are appended after.
    const merged = [];
    const seen = new Set();
    for (const y of yataRows) {
      const s = scoutMap.get(y.item_id);
      merged.push({
        item_id: y.item_id,
        name: (s && s.name) || y.name,
        buy_price: (s && Number.isFinite(s.buy_price)) ? s.buy_price : y.buy_price,
        stock: (s && s.stock != null) ? s.stock : y.stock,
      });
      seen.add(y.item_id);
    }
    for (const [itemId, s] of scoutMap) {
      if (seen.has(itemId)) continue;
      merged.push({ item_id: itemId, name: s.name, buy_price: s.buy_price, stock: s.stock });
    }

    if (merged.length === 0) {
      body.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'vgl-br-detail-msg';
      msg.textContent = 'No data for ' + destination + ' yet.';
      body.appendChild(msg);
      return;
    }

    const itemIds = merged.map(function (r) { return r.item_id; });
    const [snapshotsMap, restockMap] = await Promise.all([
      fetchYataSnapshots(itemIds, destination),
      fetchRestockEvents(itemIds, destination),
    ]);
    if (generation !== bestRunGeneration) return;

    const slots = getSlotCount();
    const nowMs = Date.now();
    // Alphabetical so a player can scan for one specific item rather than
    // hunting through a profit ranking.
    merged.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

    body.textContent = '';
    for (const r of merged) {
      const row = document.createElement('div');
      row.className = 'vgl-br-row';

      const name = document.createElement('span');
      name.className = 'vgl-br-name';
      name.textContent = r.name;

      const stockNum = Number(r.stock);
      const hasStock = Number.isFinite(stockNum) && stockNum > 0;
      const stockLimited = Number.isFinite(stockNum) && stockNum < slots;

      const stock = document.createElement('span');
      stock.className = 'vgl-br-dest';
      if (!Number.isFinite(stockNum)) {
        stock.textContent = '? stk';
      } else if (stockNum <= 0) {
        stock.textContent = 'empty';
        stock.classList.add('vgl-br-dest--limited');
      } else {
        stock.textContent = stockNum.toLocaleString('en-US') + ' stk';
        if (stockLimited) stock.classList.add('vgl-br-dest--limited');
      }

      const price = document.createElement('span');
      price.className = 'vgl-br-price';
      price.textContent = (Number.isFinite(r.buy_price) && r.buy_price > 0)
        ? formatMoneyCompact(r.buy_price)
        : '\u2014';

      const depl = document.createElement('span');
      depl.className = 'vgl-br-depl';
      const slope = depletionRatePerMin(snapshotsMap.get(r.item_id));
      if (slope != null && slope < 0) {
        const rate = -slope;
        depl.textContent = 'sells ~' + (rate >= 1 ? Math.round(rate) : rate.toFixed(1)) + '/min';
        depl.title = 'Observed depletion rate';
      } else {
        depl.textContent = '\u2014';
        depl.title = 'No depletion data yet';
      }

      // Restock ETA only matters when the shelf is empty/thin \u2014 that's the
      // "when will it be there if it isn't now" answer. Deep shelves show
      // "in stock" rather than a stale-cadence ETA (same honesty rule as the
      // best-run rows).
      const refill = document.createElement('span');
      refill.className = 'vgl-br-refill';
      if (hasStock && !stockLimited) {
        refill.textContent = 'in stock';
        refill.classList.add('vgl-br-refill--none');
      } else {
        const eta = formatRefillEta(estimateRefillMins(restockMap.get(r.item_id), nowMs));
        if (eta) {
          refill.textContent = eta;
          refill.title = 'Estimated time to next restock';
        } else {
          refill.textContent = hasStock ? 'low' : 'no ETA';
          refill.classList.add('vgl-br-refill--none');
          refill.title = 'Not enough restock history yet';
        }
      }

      row.appendChild(name);
      row.appendChild(stock);
      row.appendChild(price);
      row.appendChild(depl);
      row.appendChild(refill);
      body.appendChild(row);
    }
  }

  function buildBestRunBar(runs) {
    const bar = document.createElement('div');
    bar.id = BESTRUN_BAR_ID;
    // Open by default so stock + refill ETA for every destination is visible
    // at decision time without an extra tap. Header still toggles it closed.
    bar.classList.add('vgl-br-open');

    const head = document.createElement('div');
    head.className = 'vgl-br-head';

    const label = document.createElement('span');
    label.className = 'vgl-br-label';
    label.textContent = 'Travel';

    // Country picker: "Top picks" keeps the cross-country best-run ranking;
    // selecting a destination swaps the body to that country's full item list.
    const select = document.createElement('select');
    select.className = 'vgl-br-select';
    const topOpt = document.createElement('option');
    topOpt.value = '';
    topOpt.textContent = 'Top picks (all countries)';
    select.appendChild(topOpt);
    // Every travel destination, not just the profit-ranked ones — a player
    // may want to check a country that currently has no arbitrage at all.
    const dests = Array.from(new Set(Object.values(YATA_COUNTRY_MAP)))
      .sort(function (a, b) { return String(a).localeCompare(String(b)); });
    for (const d of dests) {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = d;
      select.appendChild(o);
    }
    const saved = getCountryView();
    if (saved && dests.indexOf(saved) !== -1) select.value = saved;
    // Interacting with the select must not toggle the panel open/closed.
    select.addEventListener('click', function (e) { e.stopPropagation(); });

    const rate = document.createElement('span');
    rate.className = 'vgl-br-rate';

    const caret = document.createElement('span');
    caret.className = 'vgl-br-caret';
    caret.textContent = '\u25BE';

    head.appendChild(label);
    head.appendChild(select);
    head.appendChild(rate);
    head.appendChild(caret);
    bar.appendChild(head);

    const body = document.createElement('div');
    body.className = 'vgl-br-body';
    bar.appendChild(body);

    function renderTopPicks() {
      rate.textContent = formatMoneyCompact(runs[0].profitPerHour) + '/hr';
      body.textContent = '';
      for (const r of runs) {
        const row = document.createElement('div');
        row.className = 'vgl-br-row';

        const name = document.createElement('span');
        name.className = 'vgl-br-name';
        name.textContent = r.name;

        const dest = document.createElement('span');
        dest.className = 'vgl-br-dest';
        // Always show current stock so the player can judge whether a shelf is
        // deep enough to be worth the flight. Stock-limited runs (shelf thinner
        // than a full slot fill) are flagged amber via the --limited class.
        const stockStr = (r.stock != null && Number.isFinite(Number(r.stock)))
          ? Number(r.stock).toLocaleString('en-US')
          : '?';
        dest.textContent = r.destination + ' \u00B7 ' + stockStr + ' stk';
        if (r.stockLimited) dest.classList.add('vgl-br-dest--limited');

        const refill = document.createElement('span');
        refill.className = 'vgl-br-refill';
        // Refill timing is only shown on stock-limited shelves (see idsByDest
        // filter above). On a deep shelf the column stays present but empty so
        // the 5-col grid alignment holds \u2014 no misleading "refill imminent" on a
        // full shelf whose cadence estimate has merely gone stale.
        if (!r.stockLimited) {
          refill.classList.add('vgl-br-refill--none');
        } else if (r.restockMins != null && Number.isFinite(Number(r.restockMins))) {
          refill.textContent = formatRefillEta(r.restockMins);
          refill.title = 'Estimated time to next restock';
        } else {
          refill.textContent = 'refill \u2014';
          refill.classList.add('vgl-br-refill--none');
          refill.title = 'Not enough restock history yet';
        }

        const run = document.createElement('span');
        run.className = 'vgl-br-run';
        run.textContent = formatMoneyCompact(r.profitPerRun) + '/run';

        const hr = document.createElement('span');
        hr.className = 'vgl-br-hr';
        hr.textContent = formatMoneyCompact(r.profitPerHour) + '/hr';

        row.appendChild(name);
        row.appendChild(dest);
        row.appendChild(refill);
        row.appendChild(run);
        row.appendChild(hr);
        body.appendChild(row);
      }
    }

    function applyMode() {
      const dest = select.value;
      setCountryView(dest);
      if (!dest) {
        renderTopPicks();
      } else {
        rate.textContent = '';
        renderCountryDetail(dest, body, bestRunGeneration);
      }
    }

    select.addEventListener('change', applyMode);
    head.addEventListener('click', function (e) {
      if (e.target === select) return;
      bar.classList.toggle('vgl-br-open');
    });

    applyMode();
    return bar;
  }

  // Top-level injection. Idempotent: tears down any previous board before
  // rendering. Silent on any data failure and hidden entirely when no run
  // clears the bar — the home screen stays clean rather than showing an
  // empty "no runs" state the player can't act on.
  let bestRunGeneration = 0;
  async function injectBestRunBar() {
    const myGeneration = ++bestRunGeneration;
    const existing = document.getElementById(BESTRUN_BAR_ID);
    if (existing) existing.remove();
    if (indicatorsHidden) return;

    const [yataRows, scrapeMap] = await Promise.all([
      fetchYataAll(),
      fetchAbroadScrapesAll(),
      ensureItemCatalog(),
    ]);
    if (myGeneration !== bestRunGeneration) return;
    if (!Array.isArray(yataRows) || yataRows.length === 0) return;

    // One Supabase GET for every item the export mentions.
    const itemIds = [];
    const seenIds = new Set();
    for (const y of yataRows) {
      if (!seenIds.has(y.item_id)) { seenIds.add(y.item_id); itemIds.push(y.item_id); }
    }
    const sellMap = await fetchSellPrices(itemIds);

    const slots = getSlotCount();
    const mult = getFlightMultiplier();
    const runs = [];
    for (const y of yataRows) {
      const itype = itemTypeFor(y.item_id);
      if (!itype || !INFLIGHT_ALLOWED_TYPES.has(itype)) continue;

      const flightMins = FLIGHT_MINS[y.destination];
      if (!flightMins) continue;

      const sell = sellMap.get(y.item_id);
      if (!sell || !Number.isFinite(sell.price)) continue;

      // Fresh first-party scrape (<= 10 min) overrides YATA's buy_price and
      // stock, exactly as the in-flight strip and web app's log-sync merge do.
      const scrape = scrapeMap.get(y.destination + '|' + y.item_id);
      const buyPrice = scrape && Number.isFinite(scrape.buy_price) ? scrape.buy_price : y.buy_price;
      const stock = scrape && scrape.stock != null ? scrape.stock : y.stock;

      if (!Number.isFinite(buyPrice) || buyPrice <= 0) continue;
      const netSell = sell.price * 0.95;
      const margin = netSell - buyPrice;
      if (margin <= 0) continue;

      // "Right now" means buyable now: skip sold-out shelves. Unknown stock
      // (null) is allowed and assumes the run can fill — same as the web
      // Best Run card, which only blocks on a confirmed quantity of 0.
      if (stock != null && stock <= 0) continue;
      const effectiveSlots = stock != null ? Math.min(slots, stock) : slots;
      if (effectiveSlots <= 0) continue;
      const stockLimited = stock != null && stock < slots;

      const profitPerRun = margin * effectiveSlots;
      const roundTripMins = flightMins * mult * 2;
      if (roundTripMins <= 0) continue;
      const profitPerHour = (profitPerRun / roundTripMins) * 60;

      runs.push({
        name: y.name,
        itemId: y.item_id,
        destination: y.destination,
        stock: stock,
        profitPerRun: profitPerRun,
        profitPerHour: profitPerHour,
        effectiveSlots: effectiveSlots,
        stockLimited: stockLimited,
      });
    }

    if (runs.length === 0) return;

    // Collapse to each destination's single strongest run before ranking:
    // the player can only be at one destination, so "where should I fly"
    // is answered by the best each place offers, not a list clustered on
    // whichever destination happens to stock several good items.
    const bestPerDest = new Map();
    for (const r of runs) {
      const cur = bestPerDest.get(r.destination);
      if (!cur || r.profitPerHour > cur.profitPerHour) bestPerDest.set(r.destination, r);
    }
    const ranked = Array.from(bestPerDest.values())
      .sort(function (a, b) { return b.profitPerHour - a.profitPerHour; })
      .slice(0, BESTRUN_MAX_ROWS);

    // Attach a refill ETA to each ranked pick so the player can see, before
    // flying, when a shelf next restocks (restock_events is keyed per
    // destination, so we group the picks and fire one GET per destination).
    // Best-effort: a row with too little cadence history just shows no ETA.
    const nowMs = Date.now();
    // Only thin (stock-limited) shelves get a refill ETA — that's the only
    // case where waiting for a top-up is actionable. Deep shelves are bought
    // now, so skip their reads entirely (also avoids surfacing a stale-cadence
    // "refill imminent" on a shelf that's actually full).
    const idsByDest = new Map();
    for (const r of ranked) {
      if (!r.stockLimited) continue;
      let arr = idsByDest.get(r.destination);
      if (!arr) { arr = []; idsByDest.set(r.destination, arr); }
      arr.push(r.itemId);
    }
    await Promise.all(Array.from(idsByDest.entries()).map(async function (entry) {
      const dest = entry[0];
      const evMap = await fetchRestockEvents(entry[1], dest);
      for (const r of ranked) {
        if (r.destination !== dest) continue;
        r.restockMins = estimateRefillMins(evMap.get(r.itemId), nowMs);
      }
    }));

    if (DEBUG) {
      debugPanel([
        'home best-run',
        'yata=' + yataRows.length + ' runs=' + runs.length + ' dests=' + ranked.length,
        'top=' + ranked[0].name + ' @ ' + ranked[0].destination + ' ' + Math.round(ranked[0].profitPerHour),
        'slots=' + slots + ' flightMult=' + mult,
      ]);
    }

    if (myGeneration !== bestRunGeneration) return;
    injectBestRunStyles();
    const bar = buildBestRunBar(ranked);
    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    // Final sweep right before insert: a parallel call could have inserted
    // its own board between our start-of-function removal and now.
    document.querySelectorAll('#' + BESTRUN_BAR_ID).forEach(function (n) { n.remove(); });
    host.insertBefore(bar, host.firstChild);
  }

  // Clears every Valigia travel overlay (Best Run board + In-Flight strip).
  // Used when the phase changes (so a stale bar from a prior dispatch never
  // lingers underneath the new one) and on the return leg (where we show
  // neither). Each injector self-clears its own id, but neither clears the
  // other's — this does both so the two overlays can never coexist.
  function removeTravelBars() {
    document.querySelectorAll('#' + BESTRUN_BAR_ID).forEach(function (n) { n.remove(); });
    document.querySelectorAll('#' + INFLIGHT_BAR_ID).forEach(function (n) { n.remove(); });
  }

  // -- Picker: selected-country detail ------------------------------------
  // On the home travel map, tapping a country populates a footer that reads
  // "{Country} - {City}  Flight Time - HH:MM  Price ...  TRAVEL". We detect
  // that selection and reuse injectInFlightStrip() to show the chosen
  // country's per-item picture (current stock + arrival projection + margin)
  // before the player commits. Best-effort and silent on any miss.
  let pickerSelectionObserver = null;
  let pickerLastSelectedDest = null;

  // Parse the selected destination + flight time from the footer. Returns
  // { destination, flightMins } or null when nothing is selected yet
  // ("Please choose a destination" shows no "Flight Time -").
  function detectSelectedDestination() {
    const body = document.body ? document.body.innerText : '';
    if (!body || !/Flight Time\s*-/i.test(body)) return null;
    // "{Country} - {City}" sits just before "Flight Time - HH:MM". The
    // country/city groups stay on one line (no newline in the class); the
    // [\s\S]{0,20}? gap tolerates the airplane glyph / column separators
    // Torn renders between "{City}" and "Flight Time".
    const m = body.match(/([A-Za-z][A-Za-z .'-]*?)\s*-\s*[A-Za-z][A-Za-z .'-]*?[\s\S]{0,20}?Flight Time\s*-\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const dest = resolveCityToDestination(m[1].trim());
    if (!dest || !FLIGHT_MINS[dest]) return null;
    const mins = Number(m[2]) * 60 + Number(m[3]);
    return {
      destination: dest,
      flightMins: Number.isFinite(mins) && mins > 0 ? mins : FLIGHT_MINS[dest],
    };
  }

  // Install a debounced observer that reacts to country selection on the
  // picker. Idempotent — only one observer per page. The "destination
  // changed" guard makes re-injecting the strip (which itself mutates the
  // DOM) a no-op, so there's no feedback loop.
  function watchPickerSelection() {
    if (pickerSelectionObserver) return;
    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    if (!host) return;
    let timer = null;
    function evaluate() {
      timer = null;
      const sel = detectSelectedDestination();
      const dest = sel ? sel.destination : null;
      if (dest === pickerLastSelectedDest) return; // unchanged → no churn
      pickerLastSelectedDest = dest;
      if (dest) {
        injectInFlightStrip(sel.destination, sel.flightMins);
      } else {
        document.querySelectorAll('#' + INFLIGHT_BAR_ID).forEach(function (n) { n.remove(); });
      }
    }
    const onChange = function () {
      if (timer) return;
      timer = setTimeout(evaluate, 350);
    };
    pickerSelectionObserver = new MutationObserver(onChange);
    pickerSelectionObserver.observe(host, { childList: true, subtree: true, characterData: true });
    // Handle a country already selected when the script first runs.
    evaluate();
  }

  // How long to wait for a definitive flight/abroad marker before concluding
  // the player is on the home destination picker. Torn hydrates the flight
  // banner ("Remaining Flight Time") and abroad marker ("You are in X") a
  // beat after DOMContentLoaded; reading once up front races that hydration
  // and misfires the home Best Run board onto flight pages.
  const TRAVEL_PHASE_TIMEOUT_MS = 4000;
  const TRAVEL_PHASE_POLL_MS = 300;

  // -- Main ----------------------------------------------------------------
  async function runTravel(opts) {
    // silent: data-only mode used by stakeout auto-ticks (15 s cadence) —
    // scrape + ingest run, but the overlay repaint, parse panel, and any
    // toasts are skipped so the page doesn't churn every tick.
    const silent = !!(opts && opts.silent);

    // TEMP DIAGNOSTIC: clear any prior parse-mismatch captures so a fresh
    // scrape replaces a stale panel.
    parseMismatches.length = 0;

    // Resolve the travel phase before deciding what to render. The flight
    // banner and the "You are in X" abroad marker both hydrate slightly after
    // initial render, so a single synchronous read can catch a flight page
    // mid-hydrate, see no marker, and wrongly fall back to the home Best Run
    // board (the catch-all default). That race is what made the overlay flip
    // randomly between Arriving Soon and Best Run. Poll briefly until a flight
    // or abroad marker appears; only conclude "home picker" once the window
    // elapses with neither present.
    const phaseStart = Date.now();
    let flight = detectInFlight();
    let destination = flight ? null : detectDestination();
    while (!flight && !destination && Date.now() - phaseStart < TRAVEL_PHASE_TIMEOUT_MS) {
      await new Promise(function (r) { setTimeout(r, TRAVEL_PHASE_POLL_MS); });
      flight = detectInFlight();
      destination = flight ? null : detectDestination();
    }

    // Return leg: the player is flying home, can't shop at the origin, and the
    // destination picker isn't on screen — so neither the Arriving Soon strip
    // nor the Best Run board is actionable. Clear any stray bar and bail.
    if (flight && flight.returning) {
      log('Return leg detected - clearing overlays, nothing to show.');
      removeTravelBars();
      return;
    }

    // Outbound branch: no shop DOM to scrape, but we can preview what's
    // available at the destination so the flight isn't dead time.
    if (flight) {
      removeTravelBars();
      try { await injectInFlightStrip(flight.destination, flight.remainingMins); } catch (e) { log('inflight error', e); }
      return;
    }

    if (!destination) {
      // Not landed and not in flight after the poll window: the country
      // picker. The player is deciding where to fly next, so headline the
      // best run across every destination. Errors are swallowed so a
      // YATA/Supabase hiccup never disrupts the page.
      log('No flight banner or "You are in X" marker - home travel screen, showing best-run board.');
      removeTravelBars();
      try { await injectBestRunBar(); } catch (e) { log('bestrun error', e); }
      // Tapping a country populates Torn's footer with the selected
      // destination + flight time. Watch for that and show the chosen
      // country's per-item strip (current stock + arrival projection +
      // margins) so the player can judge before tapping TRAVEL. Skipped in
      // silent mode (injectInFlightStrip self-guards on indicatorsHidden too).
      if (!silent) watchPickerSelection();
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

    // TEMP DIAGNOSTIC: render any captured parse mismatches as soon as
    // we have rows to show. Fires unconditionally (no DEBUG flag needed)
    // so the user can screenshot it and we can fix the parser from real
    // DOM. Remove this call once parser is hardened. Skipped on silent
    // stakeout ticks — no visual churn.
    if (!silent) renderParseMismatchPanel();

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
        log('Travel ' + destination + ': ' + result.count + ' prices upserted');
        // Routine success is silent now, but unknown items still mean the
        // parser saw a row it couldn't resolve — a parse-health signal worth
        // surfacing on a DevTools-less iPad. Only fires when something's off.
        if (unknownCount > 0) {
          toast(destination + ': ' + unknownCount + ' unrecognized item' +
            (unknownCount === 1 ? '' : 's'), 'warning');
        }
      } else if (isSilentIngestError(result)) {
        log('Travel ' + destination + ' ingest skipped (silent):', result.error);
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

    // Silent stakeout ticks skip the overlay entirely: it's a read + repaint
    // with no data contribution, and at 15 s cadence the repaint is exactly
    // the "display churn" we're avoiding. The ingest above still runs.
    const overlayPromise = silent ? Promise.resolve() : (async function () {
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
        // First pass: paint whatever the shared pool already has so the
        // overlay appears immediately rather than waiting on live fetches.
        renderOverlay(shops, sellPriceMap, refillEtaMap);
        // Live-fill: the pool only covers items someone has already scraped
        // into sell_prices, so most abroad rows (weapons, tools, country-
        // specific artifacts) show no margin. Fetch the current Item Market
        // price for everything the pool is missing/stale on, then upsert it
        // back so the shared pool's coverage improves for everyone. Mutates
        // sellPriceMap; throttled + session-cached (~one Torn API burst per
        // landing).
        await enrichSellPricesLive(itemIds, sellPriceMap);
        // Second pass: repaint with the freshly-filled prices.
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
        font-family: Arial, Helvetica, sans-serif;
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
    if (!Number.isFinite(n)) return '\u2014';
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
    // This runner is a pure-read UI surface (no ingest), so indicators
    // hidden means there's nothing left for it to do. Clear any bar a
    // prior visit painted and bail before wiring the MutationObserver.
    if (indicatorsHidden) {
      const existing = document.getElementById(ITEM_PAGE_BAR_ID);
      if (existing) existing.remove();
      return;
    }
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

  // -- Museum sets + points-arb data --------------------------------------
  // Source of truth for "this item participates in a museum set worth N
  // points." Used by the bazaar Deals bar to flag listings priced under
  // their museum-points-equivalent value (the player buys cheap, completes
  // a set, and exchanges at the museum for points worth more cash via the
  // current Points Market rate).
  //
  // Per-item points value is computed dynamically at evaluation time:
  //   ptsForItem = setPoints * marketPrice(item) / sum(marketPrice(member) * qty)
  // ...so a set with one expensive piece and many cheap pieces (Senet:
  // 1 board + 10 pawns, where pawns dominate market value 17:1) auto-
  // rebalances without us having to ship userscript updates every time
  // the floor moves. For singletons this collapses to setPoints; for
  // uniform sets (Coins, Arrowheads) it collapses to setPoints / N.
  //
  // Item names must match Torn's catalog exactly. The resolver silently
  // skips any name that doesn't resolve, so a typo just means that
  // member won't contribute to set valuation — the rest of the set still
  // works. Verify against itemMetaCache when adding new sets.
  const MUSEUM_SETS = [
    { name: 'Arrowhead Set',     points: 25,    items: [
      { name: 'Chert Point',     qty: 1 },
      { name: 'Quartzite Point', qty: 1 },
      { name: 'Basalt Point',    qty: 1 },
      { name: 'Obsidian Point',  qty: 1 },
      { name: 'Quartz Point',    qty: 1 },
      { name: 'Chalcedony Point', qty: 1 },
    ]},
    { name: 'Medieval Coin Set', points: 100,   items: [
      { name: 'Leopard Coin',    qty: 1 },
      { name: 'Florin Coin',     qty: 1 },
      { name: 'Gold Noble Coin', qty: 1 },
    ]},
    { name: 'Patagonian Fossil', points: 20,    items: [{ name: 'Patagonian Fossil', qty: 1 }] },
    { name: 'Meteorite Fragment', points: 15,   items: [{ name: 'Meteorite Fragment', qty: 1 }] },
    { name: 'Vairocana Buddha',  points: 100,   items: [{ name: 'Vairocana Buddha Sculpture', qty: 1 }] },
    { name: 'Ganesha Sculpture', points: 250,   items: [{ name: 'Ganesha Sculpture', qty: 1 }] },
    { name: 'Shabti Sculpture',  points: 500,   items: [{ name: 'Shabti Sculpture', qty: 1 }] },
    { name: 'Senet Game Set',    points: 2000,  items: [
      { name: 'Senet Board',       qty: 1 },
      { name: 'White Senet Pawn',  qty: 5 },
      { name: 'Black Senet Pawn',  qty: 5 },
    ]},
    { name: 'Companion Script Set', points: 1000, items: [
      { name: 'Companion Script : Abdullah', qty: 1 },
      { name: 'Companion Script : Ali',      qty: 1 },
      { name: 'Companion Script : Ubay',     qty: 1 },
    ]},
    { name: 'Egyptian Amulet',   points: 10000, items: [{ name: 'Egyptian Amulet', qty: 1 }] },
  ];

  // Buy-signal threshold: bazaar < pointsCash * (1 - this) → fire signal.
  const POINTS_BUY_DISCOUNT = 0.10;

  // localStorage key + freshness window for the captured Points Market rate.
  const POINTS_RATE_KEY = 'valigia.pointsRate';
  const POINTS_RATE_TTL_MS = 24 * 60 * 60 * 1000;

  // Resolve item names to ids via the warm catalog. Reverse-index built
  // lazily on first call. Returns null when the catalog isn't warm OR
  // the name doesn't match anything (typo / Torn renamed it).
  let itemNameToIdCache = null;
  function itemIdForName(name) {
    if (!itemMetaCache || itemMetaCache.size === 0) return null;
    if (!itemNameToIdCache) {
      itemNameToIdCache = new Map();
      itemMetaCache.forEach(function (meta, id) {
        if (meta && meta.name) itemNameToIdCache.set(meta.name, id);
      });
    }
    return itemNameToIdCache.get(name) || null;
  }

  // Find which set (if any) an item id belongs to. Returns the set object
  // with item names already resolved to ids, or null if the id isn't part
  // of any set we know about.
  function setForItemId(itemId) {
    if (!Number.isFinite(itemId)) return null;
    for (const set of MUSEUM_SETS) {
      for (const member of set.items) {
        if (itemIdForName(member.name) === itemId) return set;
      }
    }
    return null;
  }

  // Compute per-unit points value for an item in a set, weighted by
  // current market prices. Returns null if we can't price every member
  // (one missing market price would skew the proportion — better to
  // suppress the signal than flash a wrong number).
  function computePointsForItem(itemId, set, marketByItem) {
    let totalSetMarket = 0;
    let thisItemMarket = null;
    for (const member of set.items) {
      const memberId = itemIdForName(member.name);
      if (!memberId) return null;
      const memberPrice = marketByItem.get(memberId);
      if (!Number.isFinite(memberPrice) || memberPrice <= 0) return null;
      totalSetMarket += memberPrice * member.qty;
      if (memberId === itemId) thisItemMarket = memberPrice;
    }
    if (thisItemMarket == null || totalSetMarket <= 0) return null;
    return set.points * thisItemMarket / totalSetMarket;
  }

  // Read the captured Points Market rate from the local cache only.
  // Returns null if missing or older than POINTS_RATE_TTL_MS. Callers
  // that can tolerate one round-trip should `await ensurePointsRate()`
  // first to populate the local cache from the shared Supabase pool;
  // those that cant (sync render paths) just live with an occasional
  // null when this user has never warmed the cache.
  function getPointsRate() {
    try {
      const raw = localStorage.getItem(POINTS_RATE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Number.isFinite(parsed.rate) || !parsed.observed_at) return null;
      if (Date.now() - parsed.observed_at > POINTS_RATE_TTL_MS) return null;
      return parsed.rate;
    } catch (_) { return null; }
  }

  // Warm the local cache from the shared Supabase pool when it's missing
  // or stale. Lets a player who has never visited pmarket.php still see
  // BUY UNDER thresholds in the museum bar and POINTS BUY rows in the
  // bazaar Deals bar — provided some other Valigia user pushed a fresh
  // rate in the last POINTS_RATE_TTL_MS. Silent no-op on any failure
  // (network, parse, missing seed): the consumer falls back to "no
  // rate" placeholders, which is the same UX as before this change.
  async function ensurePointsRate() {
    if (getPointsRate() != null) return;
    try {
      const res = await gmRequest({
        method: 'GET',
        url: POINTS_RATE_URL + '?id=eq.1&select=rate,updated_at',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Accept': 'application/json',
        },
      });
      if (res.status < 200 || res.status >= 300) return;
      const rows = JSON.parse(res.responseText || '[]');
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row || !Number.isFinite(Number(row.rate))) return;
      const observedAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
      // Honour the same 24h freshness gate as locally-captured rates.
      // Catches the seed-row case (observed_at = 1970) and any pool
      // that's gone collectively cold.
      if (!observedAt || Date.now() - observedAt > POINTS_RATE_TTL_MS) return;
      try {
        localStorage.setItem(POINTS_RATE_KEY, JSON.stringify({
          rate: Number(row.rate),
          observed_at: observedAt,
        }));
      } catch (_) { /* storage full — non-fatal */ }
    } catch (e) {
      log('points rate Supabase read failed:', e);
    }
  }

  // Push a freshly-captured rate to both the local cache (immediate
  // truth for this browser) and the shared Supabase pool (benefits
  // every other Valigia user for the next 24h). Returns true if the
  // shared write also landed; false if only the local cache was
  // updated. The caller surfaces this distinction in the success
  // banner so the player knows whether their capture is helping the
  // community pool or just their own browser.
  async function setPointsRate(rate) {
    try {
      localStorage.setItem(POINTS_RATE_KEY, JSON.stringify({
        rate: rate,
        observed_at: Date.now(),
      }));
    } catch (_) { /* storage full / disabled — non-fatal */ }
    try {
      await pushPointsRateToSupabase(rate);
      return true;
    } catch (e) {
      log('points rate Supabase write failed:', e);
      return false;
    }
  }

  // POST + resolution=merge-duplicates is the proven upsert pattern
  // used by sell_prices and bazaar_prices ingest in this same script.
  // We tried PATCH /points_market_rate?id=eq.1 in v0.20.0–0.20.2 and
  // it silently no-op'd inside PDA's gmRequest — writes appeared to
  // succeed client-side but the seeded row never updated. Migration
  // 033 added the INSERT policy that makes this upsert path legal.
  async function pushPointsRateToSupabase(rate) {
    const res = await gmRequest({
      method: 'POST',
      url: POINTS_RATE_URL,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      data: JSON.stringify({
        id: 1,
        rate: Math.round(rate),
        updated_at: new Date().toISOString(),
      }),
    });
    if (res && res.status != null && (res.status < 200 || res.status >= 300)) {
      throw new Error('Supabase upsert non-2xx: ' + res.status +
        (res.responseText ? ' body=' + res.responseText.slice(0, 200) : ''));
    }
  }

  // -- Museum page (museum.php) -------------------------------------------
  // Players visiting the museum want to know whether to grind for missing
  // artifact pieces or just buy them from the market / a bazaar. This
  // runner injects an expandable bar at the top of the page listing every
  // Torn-classified artifact alongside its current Item Market floor and
  // the cheapest fresh bazaar listing in the shared pool. Pure read
  // surface — no scraping, no writes.

  const MUSEUM_BAR_ID = 'valigia-museum-bar';
  // Match the Lowest Price Found freshness window — anything older and
  // the bazaar listing is likely sold or pulled.
  const MUSEUM_BAZAAR_MAX_AGE_MS = 30 * 60 * 1000;
  // Drop the locked / troll listings same as Lowest Price Found.
  const MUSEUM_TOO_GOOD_THRESHOLD = 0.10;
  // Cap displayed rows. Torn currently lists ~40 artifact items in the
  // catalog; a bounded list keeps the DOM small even if more are added.
  const MUSEUM_MAX_ROWS = 60;

  function injectMuseumStyles() {
    if (document.getElementById('valigia-museum-styles')) return;
    const css = [
      '#' + MUSEUM_BAR_ID + ' {',
      '  all: initial;',
      '  display: block;',
      '  margin: 8px auto 12px;',
      '  max-width: 1100px;',
      '  font-family: Arial, Helvetica, sans-serif;',
      '  color: #c8cdd8;',
      '  background: #161a22;',
      '  border: 1px solid #252a35;',
      '  border-left: 3px solid #e8c84a;',
      '  border-radius: 4px;',
      '  box-sizing: border-box;',
      '  overflow: hidden;',
      '}',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-head {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 8px 12px;',
      '  cursor: pointer;',
      '  user-select: none;',
      '}',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-title {',
      '  color: #e8c84a;',
      '  font-weight: 700;',
      '  font-size: 12px;',
      '  letter-spacing: 0.12em;',
      '  text-transform: uppercase;',
      '}',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-count {',
      '  background: #e8c84a;',
      '  color: #0d0f14;',
      '  font-weight: 700;',
      '  font-size: 11px;',
      '  padding: 1px 7px;',
      '  border-radius: 999px;',
      '}',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-caret {',
      '  margin-left: auto;',
      '  color: #e8c84a;',
      '  font-size: 11px;',
      '  transition: transform 150ms;',
      '}',
      '#' + MUSEUM_BAR_ID + '.vgl-mu-open .vgl-mu-caret {',
      '  transform: rotate(180deg);',
      '}',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-body {',
      '  display: none;',
      '  padding: 4px 10px 10px;',
      '  gap: 4px;',
      '  flex-direction: column;',
      '}',
      '#' + MUSEUM_BAR_ID + '.vgl-mu-open .vgl-mu-body {',
      '  display: flex;',
      '}',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-row {',
      '  display: grid;',
      '  grid-template-columns: minmax(0,1.4fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr);',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 6px 8px;',
      '  border: 1px solid #252a35;',
      '  border-radius: 3px;',
      '  background: rgba(232,200,74,0.04);',
      '  font-size: 12px;',
      '}',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-item { font-weight: 700; color: #c8cdd8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-cell a { color: inherit; text-decoration: none; display: flex; align-items: center; gap: 6px; min-width: 0; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-cell a:active { opacity: 0.7; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-label {',
      '  font-size: 10px;',
      '  font-weight: 700;',
      '  letter-spacing: 0.06em;',
      '  text-transform: uppercase;',
      '  padding: 2px 6px;',
      '  border-radius: 2px;',
      '  white-space: nowrap;',
      '}',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-label--market { background: rgba(232,200,74,0.18); color: #e8c84a; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-label--bazaar { background: rgba(74,232,160,0.18); color: #4ae8a0; }',
      // Buy-under cell uses an orange/amber palette so it visually
      // separates from the gold market price + green bazaar price — a
      // third distinct semantic (a target threshold, not an observed
      // price). Sits in the rightmost cell so the eye sweeps left-to-
      // right: name → what it costs → what its going for → buy if under X.
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-label--buy { background: rgba(232,130,74,0.18); color: #e8a14a; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-price--buy { color: #e8a14a; font-weight: 700; white-space: nowrap; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-price { color: #e8c84a; font-weight: 700; white-space: nowrap; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-price--bazaar { color: #4ae8a0; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-empty { color: #5a6070; white-space: nowrap; font-style: italic; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-age { color: #8a8fa0; font-size: 10px; white-space: nowrap; }',
      // Header rate caption: tucks under the title row, small grey text
      // that explains where the BUY UNDER thresholds come from. Tinted
      // amber when stale/missing so the user knows to visit Points Market.
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-rate { font-size: 11px; color: #8a8fa0; margin-left: 12px; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-rate strong { color: #e8c84a; font-weight: 700; }',
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-rate--missing { color: #e8a14a; }',
      // Hit signal: when bazaar < buyUnder, highlight the row gold so a
      // scanning eye lands on the actionable rows first.
      '#' + MUSEUM_BAR_ID + ' .vgl-mu-row--hit { border-color: rgba(232,200,74,0.45); background: rgba(232,200,74,0.10); }',
      // Narrow screens (phone): stack each rows cells vertically. The
      // name keeps its prominence on its own line, and each price cell
      // (Market / Bazaar / Buy Under) drops below it. Without this, the
      // 4-column grid + long values like "$599M" pushed past the
      // viewport on phones. Head row also wraps and the rate caption
      // gets its own line so the title + count chip dont smush.
      '@media (max-width: 700px) {',
      '  #' + MUSEUM_BAR_ID + ' .vgl-mu-row {',
      '    grid-template-columns: 1fr;',
      '    gap: 3px;',
      '    padding: 8px;',
      '  }',
      '  #' + MUSEUM_BAR_ID + ' .vgl-mu-item { padding-bottom: 2px; border-bottom: 1px solid #252a35; margin-bottom: 4px; }',
      '  #' + MUSEUM_BAR_ID + ' .vgl-mu-head { flex-wrap: wrap; }',
      '  #' + MUSEUM_BAR_ID + ' .vgl-mu-rate { margin-left: 0; flex-basis: 100%; }',
      '  #' + MUSEUM_BAR_ID + ' .vgl-mu-caret { margin-left: auto; }',
      '}',
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'valigia-museum-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /**
   * Pull every Artifact-typed item from the warm catalog. Returns an
   * array of { id, name } sorted by name for stable rendering before
   * we know prices.
   */
  function listArtifactItems() {
    if (!itemMetaCache) return [];
    const out = [];
    itemMetaCache.forEach(function (meta, id) {
      if (meta && meta.type === 'Artifact' && meta.name) {
        out.push({ id: id, name: meta.name });
      }
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out;
  }

  /**
   * Bulk-read sell_prices and bazaar_prices for the given ids in two
   * PostgREST round-trips. Returns { market: Map<id, {price, min_price,
   * updated_at}>, bazaar: Map<id, {price, quantity, owner_id, observed_at}> }
   * — bazaar map only contains the cheapest fresh, scam-filtered
   * listing per id.
   */
  async function fetchMuseumPrices(ids) {
    if (!ids || ids.length === 0) {
      return { market: new Map(), bazaar: new Map() };
    }
    const idList = ids.join(',');
    const sinceIso = new Date(Date.now() - MUSEUM_BAZAAR_MAX_AGE_MS).toISOString();
    const [sellRows, bazaarRows] = await Promise.all([
      fetchJSON(
        SELL_PRICES_URL +
        '?item_id=in.(' + idList + ')' +
        '&select=item_id,price,min_price,updated_at'
      ),
      fetchJSON(
        BAZAAR_PRICES_URL +
        '?item_id=in.(' + idList + ')' +
        '&checked_at=gte.' + encodeURIComponent(sinceIso) +
        '&price=gt.1' +
        '&select=item_id,price,quantity,bazaar_owner_id,checked_at' +
        '&order=price.asc'
      ),
    ]);

    const market = new Map();
    if (Array.isArray(sellRows)) {
      for (const r of sellRows) {
        if (!r || typeof r.item_id !== 'number') continue;
        market.set(r.item_id, {
          price: Number(r.price),
          min_price: r.min_price != null ? Number(r.min_price) : null,
          updated_at: r.updated_at ? new Date(r.updated_at).getTime() : 0,
        });
      }
    }

    const bazaar = new Map();
    if (Array.isArray(bazaarRows)) {
      for (const r of bazaarRows) {
        if (!r || typeof r.item_id !== 'number') continue;
        if (bazaar.has(r.item_id)) continue; // already have the cheapest
        const price = Number(r.price);
        if (!Number.isFinite(price) || price <= 1) continue;
        // Filter scam listings against the same market floor the Lowest
        // Price Found bar uses.
        const m = market.get(r.item_id);
        const floor = m && m.min_price != null ? m.min_price : (m ? m.price : null);
        if (Number.isFinite(floor) && floor > 0 && price < floor * MUSEUM_TOO_GOOD_THRESHOLD) {
          continue;
        }
        bazaar.set(r.item_id, {
          price: price,
          quantity: Number(r.quantity) || 1,
          owner_id: r.bazaar_owner_id,
          observed_at: r.checked_at ? new Date(r.checked_at).getTime() : 0,
        });
      }
    }

    return { market: market, bazaar: bazaar };
  }

  function buildMuseumBar(rows, pointsRate) {
    const bar = document.createElement('div');
    bar.id = MUSEUM_BAR_ID;

    const head = document.createElement('div');
    head.className = 'vgl-mu-head';
    const title = document.createElement('span');
    title.className = 'vgl-mu-title';
    title.textContent = 'Artifact Prices';
    const count = document.createElement('span');
    count.className = 'vgl-mu-count';
    count.textContent = String(rows.length);

    // Inline rate caption next to the count. Tells the user where the
    // BUY UNDER thresholds come from + nudges them to refresh by visiting
    // Points Market when the rate is missing/stale.
    const rateCaption = document.createElement('span');
    if (Number.isFinite(pointsRate)) {
      rateCaption.className = 'vgl-mu-rate';
      rateCaption.appendChild(document.createTextNode('Points rate '));
      const strong = document.createElement('strong');
      strong.textContent = formatMoneyCompact(pointsRate) + '/pt';
      rateCaption.appendChild(strong);
    } else {
      rateCaption.className = 'vgl-mu-rate vgl-mu-rate--missing';
      rateCaption.textContent = 'Visit Points Market for buy thresholds';
    }

    const caret = document.createElement('span');
    caret.className = 'vgl-mu-caret';
    // Unicode escape, not the literal glyph: cPanel serves .user.js as
    // Latin-1 so multi-byte UTF-8 mis-decodes in PDA's webview. Same
    // workaround the other bars use.
    caret.textContent = '\u25BE';
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(rateCaption);
    head.appendChild(caret);

    const body = document.createElement('div');
    body.className = 'vgl-mu-body';

    for (const r of rows) {
      const row = document.createElement('div');
      // Highlight the row when the cheapest fresh bazaar listing is at
      // or under the points-buy threshold — the actionable state.
      const isHit = r.bazaar && Number.isFinite(r.buyUnder) && r.bazaar.price <= r.buyUnder;
      row.className = 'vgl-mu-row' + (isHit ? ' vgl-mu-row--hit' : '');

      const name = document.createElement('span');
      name.className = 'vgl-mu-item';
      name.textContent = r.name;

      // Market cell: tappable, deep-links to the Item Market search.
      const marketCell = document.createElement('span');
      marketCell.className = 'vgl-mu-cell';
      const marketLink = document.createElement('a');
      marketLink.href =
        'https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=' + r.id;
      marketLink.target = '_top';
      marketLink.rel = 'noopener';
      const marketLabel = document.createElement('span');
      marketLabel.className = 'vgl-mu-label vgl-mu-label--market';
      marketLabel.textContent = 'Market';
      marketLink.appendChild(marketLabel);
      if (r.market != null) {
        const price = document.createElement('span');
        price.className = 'vgl-mu-price';
        // formatMoneyCompact ($600M) over formatMoney ($599,999,999) so
        // the row fits on phone width without horizontal overflow.
        price.textContent = formatMoneyCompact(r.market);
        marketLink.appendChild(price);
      } else {
        const empty = document.createElement('span');
        empty.className = 'vgl-mu-empty';
        empty.textContent = 'no listings';
        marketLink.appendChild(empty);
      }
      marketCell.appendChild(marketLink);

      // Bazaar cell: tappable when we have a fresh deal, plain text otherwise.
      const bazaarCell = document.createElement('span');
      bazaarCell.className = 'vgl-mu-cell';
      const bazaarLabel = document.createElement('span');
      bazaarLabel.className = 'vgl-mu-label vgl-mu-label--bazaar';
      bazaarLabel.textContent = 'Bazaar';
      if (r.bazaar) {
        const link = document.createElement('a');
        link.href = 'https://www.torn.com/bazaar.php?userId=' + r.bazaar.owner_id;
        link.target = '_top';
        link.rel = 'noopener';
        link.appendChild(bazaarLabel);
        const price = document.createElement('span');
        price.className = 'vgl-mu-price vgl-mu-price--bazaar';
        price.textContent = formatMoneyCompact(r.bazaar.price);
        link.appendChild(price);
        const age = document.createElement('span');
        age.className = 'vgl-mu-age';
        age.textContent = formatAge(r.bazaar.observed_at);
        link.appendChild(age);
        bazaarCell.appendChild(link);
      } else {
        bazaarCell.appendChild(bazaarLabel);
        const empty = document.createElement('span');
        empty.className = 'vgl-mu-empty';
        empty.textContent = 'none fresh';
        bazaarCell.appendChild(empty);
      }

      // Buy-under cell: amber threshold price computed from the items
      // share of its museum-set points × current Points Market rate ×
      // (1 - POINTS_BUY_DISCOUNT). When we cant compute it (no rate
      // cached, or item not in any set), show a dim placeholder so the
      // column still aligns.
      const buyCell = document.createElement('span');
      buyCell.className = 'vgl-mu-cell';
      const buyLabel = document.createElement('span');
      buyLabel.className = 'vgl-mu-label vgl-mu-label--buy';
      buyLabel.textContent = 'Buy Under';
      buyCell.appendChild(buyLabel);
      if (Number.isFinite(r.buyUnder)) {
        const buyPrice = document.createElement('span');
        buyPrice.className = 'vgl-mu-price--buy';
        buyPrice.textContent = formatMoneyCompact(r.buyUnder);
        buyCell.appendChild(buyPrice);
      } else {
        const empty = document.createElement('span');
        empty.className = 'vgl-mu-empty';
        empty.textContent = r.buyUnderReason || '\u2014';
        buyCell.appendChild(empty);
      }

      row.appendChild(name);
      row.appendChild(marketCell);
      row.appendChild(bazaarCell);
      row.appendChild(buyCell);
      body.appendChild(row);
    }

    head.addEventListener('click', function () {
      bar.classList.toggle('vgl-mu-open');
    });

    bar.appendChild(head);
    bar.appendChild(body);
    return bar;
  }

  /**
   * Top-level entry. Idempotent: tears down any prior bar before
   * fetching, no-ops silently when the catalog hasn't warmed yet or
   * Torn currently lists no Artifact items.
   */
  async function runMuseum() {
    const existing = document.getElementById(MUSEUM_BAR_ID);
    if (existing) existing.remove();
    // Pure-read UI surface — nothing to gather here in silent mode.
    if (indicatorsHidden) return;

    await ensureItemCatalog();
    const items = listArtifactItems();
    if (items.length === 0) {
      log('museum: no artifacts in catalog');
      return;
    }

    const ids = items.map(function (i) { return i.id; });
    // Fetch museum prices and warm the Points Market rate from the
    // shared Supabase pool in parallel — the latter falls through to
    // localStorage cache when fresh, otherwise pulls the community
    // rate so a player who's never visited pmarket.php still sees
    // BUY UNDER thresholds.
    const [{ market, bazaar }] = await Promise.all([
      fetchMuseumPrices(ids),
      ensurePointsRate(),
    ]);

    // Flatten the {price, min_price, updated_at} shape into the simple
    // Map<id, number> that computePointsForItem() expects. We feed it
    // every artifact market price we already fetched — set members live
    // in there too because listArtifactItems() returns every Artifact-
    // typed catalog entry (Senet pawns, board, etc. are all Artifacts).
    const marketByItem = new Map();
    market.forEach(function (m, id) {
      if (m && Number.isFinite(m.price)) marketByItem.set(id, m.price);
    });

    const pointsRate = getPointsRate();

    // Compose rows: keep artifacts with any of (market price, fresh
    // bazaar listing, computed buy-under threshold). Sort by market
    // price desc — most valuable first — with bazaar-only rows tail-
    // sorted by bazaar price desc.
    const rows = [];
    for (const it of items) {
      const m = market.get(it.id);
      const b = bazaar.get(it.id);
      const marketPrice = m ? Number(m.price) : null;

      // Buy-under threshold: per-item points value × current pmarket
      // rate × (1 - POINTS_BUY_DISCOUNT). Falls through to null with a
      // human-readable reason when we cant compute it, so the cell
      // shows a meaningful placeholder instead of an empty box.
      let buyUnder = null;
      let buyUnderReason = null;
      const set = setForItemId(it.id);
      if (!set) {
        buyUnderReason = 'no set';
      } else if (!pointsRate) {
        buyUnderReason = 'no rate';
      } else {
        const ptsForItem = computePointsForItem(it.id, set, marketByItem);
        if (Number.isFinite(ptsForItem) && ptsForItem > 0) {
          buyUnder = ptsForItem * pointsRate * (1 - POINTS_BUY_DISCOUNT);
        } else {
          buyUnderReason = 'set incomplete';
        }
      }

      if (marketPrice == null && !b && buyUnder == null) continue;
      rows.push({
        id: it.id,
        name: it.name,
        market: Number.isFinite(marketPrice) ? marketPrice : null,
        bazaar: b || null,
        buyUnder: buyUnder,
        buyUnderReason: buyUnderReason,
      });
    }
    rows.sort(function (a, b) {
      const av = a.market != null ? a.market : (a.bazaar ? a.bazaar.price : 0);
      const bv = b.market != null ? b.market : (b.bazaar ? b.bazaar.price : 0);
      return bv - av;
    });
    const trimmed = rows.slice(0, MUSEUM_MAX_ROWS);
    if (trimmed.length === 0) return;

    injectMuseumStyles();
    const bar = buildMuseumBar(trimmed, pointsRate);

    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    host.insertBefore(bar, host.firstChild);
  }

  // -- Points Market (pmarket.php) ----------------------------------------
  // Captures the cheapest cash-per-point listing so the Bazaar Deals bar
  // and Museum bar can flag listings priced under their museum-points-
  // equivalent value.
  //
  // DOM-scrape only. We considered using market/?selections=pointsmarket
  // for cleaner data but Torn returns "API error 16: Access level not
  // high enough" on the standard PDA-injected key tier, and we cant
  // upgrade the key from script. The DOM is right there on the page
  // and sees the currently-rendered cheapest ~20 listings — plenty,
  // since "cheapest" is exactly what we need.
  //
  // Caches result in localStorage AND the shared Supabase
  // points_market_rate row via setPointsRate().

  const POINTS_RATE_BAR_ID = 'valigia-points-rate-bar';

  function injectPointsRateStyles() {
    if (document.getElementById('valigia-points-rate-styles')) return;
    const css = [
      '#' + POINTS_RATE_BAR_ID + ' {',
      '  all: initial;',
      '  display: block;',
      '  margin: 8px auto 12px;',
      '  max-width: 1100px;',
      '  font-family: Arial, Helvetica, sans-serif;',
      '  color: #c8cdd8;',
      '  background: #161a22;',
      '  border: 1px solid #252a35;',
      '  border-left: 3px solid #e8c84a;',
      '  border-radius: 4px;',
      '  padding: 10px 12px;',
      '  font-size: 12px;',
      '  box-sizing: border-box;',
      '}',
      '#' + POINTS_RATE_BAR_ID + ' .vgl-pr-title {',
      '  color: #e8c84a;',
      '  font-weight: 700;',
      '  font-size: 11px;',
      '  letter-spacing: 0.12em;',
      '  text-transform: uppercase;',
      '  margin-right: 10px;',
      '}',
      '#' + POINTS_RATE_BAR_ID + ' .vgl-pr-rate { color: #e8c84a; font-weight: 700; }',
      '#' + POINTS_RATE_BAR_ID + ' .vgl-pr-note { color: #8a8fa0; margin-left: 10px; }',
      '#' + POINTS_RATE_BAR_ID + '.vgl-pr-error { border-left-color: #e8824a; }',
      '#' + POINTS_RATE_BAR_ID + '.vgl-pr-error .vgl-pr-title { color: #e8824a; }',
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'valigia-points-rate-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function showPointsRateBanner(rate, isError, diagnostic) {
    const existing = document.getElementById(POINTS_RATE_BAR_ID);
    if (existing) existing.remove();
    // The rate capture + community-pool write in runPointsMarket() have
    // already happened by the time this is called — only the banner is
    // suppressed in silent mode.
    if (indicatorsHidden) return;
    injectPointsRateStyles();
    const bar = document.createElement('div');
    bar.id = POINTS_RATE_BAR_ID;
    if (isError) bar.classList.add('vgl-pr-error');

    const title = document.createElement('span');
    title.className = 'vgl-pr-title';
    title.textContent = isError ? 'Points Rate Capture Failed' : 'Points Rate Captured';
    bar.appendChild(title);

    if (!isError && Number.isFinite(rate)) {
      const value = document.createElement('span');
      value.className = 'vgl-pr-rate';
      value.textContent = formatMoneyCompact(rate) + '/pt';
      bar.appendChild(value);

      const note = document.createElement('span');
      note.className = 'vgl-pr-note';
      // Use the runtime diagnostic when provided so the caller can
      // surface useful context like "shared with community pool" vs
      // "local only — pool write failed". Falls back to a generic
      // hint when no diagnostic is passed. Unicode escape on the
      // middle-dot separator: cPanel serves .user.js as Latin-1, so a
      // literal "·" would mis-decode to "Â·" in PDA's webview
      // (the v0.20.3 success banner showed exactly that bug).
      note.textContent = '\u00B7 ' + (diagnostic || 'used for bazaar points-buy signals (24h)');
      bar.appendChild(note);
    } else {
      const note = document.createElement('span');
      note.className = 'vgl-pr-note';
      // Diagnostic tells the user (and us, remotely) what came back so
      // we dont have to guess. Especially useful on iPad with no
      // DevTools — the only debug surface is the page itself.
      note.textContent = diagnostic || 'try refreshing the page';
      bar.appendChild(note);
    }

    const host =
      document.querySelector('#mainContainer .content-wrapper') ||
      document.querySelector('.content-wrapper') ||
      document.querySelector('#mainContainer') ||
      document.body;
    host.insertBefore(bar, host.firstChild);
  }

  // Scrape leaf elements whose entire textContent is a bare "$X" amount
  // in the per-point sanity range — the per-listing price labels in
  // pmarket.php's row layout. Both v1-table and modern div layouts emit
  // that pattern. Real Torn Points Market rates have ranged $20-80k
  // over time; the 5k-200k window allows surge spikes while excluding
  // sub-5k mis-parses and total-cost labels in the millions.
  function scrapePointsMarketDOM() {
    const all = document.querySelectorAll('*');
    const allMatches = [];
    const sample = [];
    for (const el of all) {
      if (el.children && el.children.length > 0) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      const m = text.match(/^\$\s*([\d,]+(?:\.\d+)?)\s*$/);
      if (!m) continue;
      const v = parseMoney(m[1]);
      if (!Number.isFinite(v)) continue;
      allMatches.push(v);
      if (sample.length < 8) sample.push(m[0]);
    }
    const valid = allMatches.filter(function (v) { return v >= 5000 && v <= 200000; });
    if (valid.length === 0) {
      return {
        rate: null,
        error: 'DOM scrape: ' + allMatches.length + ' $ leaves found, ' +
               'none in 5k-200k range. samples=' + (sample.join(',') || '(empty)'),
      };
    }
    return { rate: Math.min.apply(null, valid), error: null };
  }

  async function runPointsMarket() {
    // Hydration-poll for up to 8s like the other runners — Torn's SPA
    // may not have rendered the listings yet on the first dispatch
    // tick, especially on slower connections.
    const start = Date.now();
    let result = { rate: null, error: 'not yet attempted' };
    while (Date.now() - start < 8000) {
      result = scrapePointsMarketDOM();
      if (result.rate != null) break;
      await new Promise(function (r) { setTimeout(r, 500); });
    }

    if (result.rate != null) {
      const shared = await setPointsRate(result.rate);
      log('pmarket: captured rate=' + result.rate + ' shared=' + shared);
      showPointsRateBanner(result.rate, false,
        shared
          ? 'shared with community pool \u00B7 24h cache'
          : 'local only \u2014 community pool write failed (see logs)');
      return;
    }

    log('pmarket: scrape failed \u2014 ' + result.error);
    showPointsRateBanner(null, true, result.error);
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
    if (/\/museum\.php/i.test(url)) return 'museum';
    if (/\/pmarket\.php/i.test(url)) return 'pmarket';
    return null;
  }

  // -- Indicator preference resolver ----------------------------------------
  // Reads the player's show_indicators flag from the public pda_prefs row
  // (set from the website's PDA overlay modal). Cached in localStorage for
  // 60 s so SPA nav bursts don't re-fetch; on a failed fetch we fall back
  // to the last cached value (any age), and to "show" when there's no
  // cache at all — a Supabase hiccup should never make the overlay vanish
  // for a player who wants it.
  const INDICATOR_PREF_CACHE_KEY = 'valigia_pda_indicators_v1';
  const INDICATOR_PREF_TTL_MS = 60 * 1000;

  async function refreshIndicatorPref() {
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(INDICATOR_PREF_CACHE_KEY) || 'null');
    } catch (_) { cached = null; }
    if (cached && typeof cached.show === 'boolean'
        && Date.now() - cached.fetchedAt < INDICATOR_PREF_TTL_MS) {
      indicatorsHidden = !cached.show;
      return;
    }

    const playerId = await resolvePlayerId();
    if (!playerId) {
      indicatorsHidden = false;
      return;
    }
    const rows = await fetchJSON(
      PDA_PREFS_URL +
      '?player_id=eq.' + encodeURIComponent(playerId) +
      '&select=show_indicators'
    );
    let show;
    if (Array.isArray(rows)) {
      // No row yet means the player never touched the toggle → show.
      show = !(rows.length > 0 && rows[0] && rows[0].show_indicators === false);
    } else if (cached && typeof cached.show === 'boolean') {
      show = cached.show;
    } else {
      show = true;
    }
    indicatorsHidden = !show;
    try {
      localStorage.setItem(
        INDICATOR_PREF_CACHE_KEY,
        JSON.stringify({ playerId: playerId, show: show, fetchedAt: Date.now() })
      );
    } catch (_) { /* ignore quota / disabled storage */ }
  }

  // Overwrite the indicator cache with a known show/hide value, keeping the
  // existing playerId attribution if we have one. Used by the in-game toggle
  // so the immediate post-toggle reload reads the new state from cache
  // (fresh < TTL) without waiting on the network write to round-trip.
  function writeIndicatorCache(show) {
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem(INDICATOR_PREF_CACHE_KEY) || 'null'); }
    catch (_) { prev = null; }
    try {
      localStorage.setItem(
        INDICATOR_PREF_CACHE_KEY,
        JSON.stringify({
          playerId: (prev && prev.playerId) || null,
          show: show,
          fetchedAt: Date.now(),
        })
      );
    } catch (_) { /* ignore quota / disabled storage */ }
  }

  // Persist the player's show/hide choice to pda_prefs via the edge function's
  // api_key auth branch — same trust model as the watchlist writes, since the
  // userscript holds the raw Torn key but no Valigia session token.
  async function postPdaPref(showIndicators) {
    try {
      const res = await gmRequest({
        method: 'POST',
        url: PDA_PREFS_FN_URL,
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        },
        data: JSON.stringify({
          action: 'set',
          api_key: TORN_API_KEY,
          show_indicators: !!showIndicators,
        }),
      });
      let data = null;
      try { data = JSON.parse(res.responseText || '{}'); } catch (_) { /* ignore */ }
      if (res.status >= 200 && res.status < 300 && data && data.success) {
        return { ok: true };
      }
      return { ok: false, error: (data && data.error) || ('http_' + res.status) };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  // -- In-game overlay toggle ("V" button) ---------------------------------
  // A small fixed pill anchored to the right edge, echoing Torn's own
  // edge-attached side tabs. One tap flips every Valigia overlay on/off by
  // writing show_indicators to pda_prefs — the same flag the website's "PDA
  // overlay" modal sets — then reloads so all ~18 paint sites re-evaluate
  // indicatorsHidden from a clean slate (far more robust than tearing each
  // overlay down by hand across six page types). Lit gold = overlays ON;
  // dim inverse = overlays OFF. The button itself is NEVER gated by
  // indicatorsHidden — it has to stay visible in silent mode, since it's the
  // only way back.
  const OVERLAY_TOGGLE_ID = 'valigia-overlay-toggle';
  let overlayToggleBusy = false;

  function paintOverlayToggle(btn) {
    const showing = !indicatorsHidden;
    btn.title = showing
      ? 'Valigia overlays ON — tap to hide'
      : 'Valigia overlays OFF — tap to show';
    Object.assign(btn.style, {
      position: 'fixed',
      right: '0',
      top: '58%',
      zIndex: '999999',
      width: '30px',
      height: '36px',
      padding: '0',
      borderRadius: '8px 0 0 8px',
      cursor: 'pointer',
      font: '700 17px/1 "Syne Mono", ui-monospace, monospace',
      boxShadow: '0 2px 8px rgba(0,0,0,.45)',
      // Lit (showing): cargo-gold fill, dark glyph. Inverse (hidden): dark
      // surface fill, gold outline + glyph.
      background: showing ? '#e8c84a' : '#161a22',
      color: showing ? '#0d0f14' : '#e8c84a',
      border: '1px solid #e8c84a',
      borderRight: 'none',
      opacity: showing ? '1' : '0.9',
    });
  }

  // Brief red flash so a failed write is visible even in silent mode, where
  // toast() suppresses itself. Repaints from current state afterward.
  function flashOverlayToggleError(btn) {
    if (!btn) return;
    btn.style.background = '#b33';
    btn.style.color = '#fff';
    setTimeout(function () { paintOverlayToggle(btn); }, 900);
  }

  async function onOverlayToggleClick() {
    if (overlayToggleBusy) return;
    overlayToggleBusy = true;
    const btn = document.getElementById(OVERLAY_TOGGLE_ID);
    if (btn) btn.disabled = true;

    // Optimistic flip: hidden -> show, shown -> hide. Update the in-memory
    // flag and the cache up front so the reload lands in the new state.
    const nextShow = indicatorsHidden;
    indicatorsHidden = !nextShow;
    if (btn) paintOverlayToggle(btn);
    writeIndicatorCache(nextShow);

    const res = await postPdaPref(nextShow);
    if (!res.ok) {
      // Roll the optimistic flip back and signal the failure.
      indicatorsHidden = !indicatorsHidden;
      writeIndicatorCache(!nextShow);
      if (btn) { btn.disabled = false; flashOverlayToggleError(btn); }
      overlayToggleBusy = false;
      log('overlay toggle write failed:', res.error);
      return;
    }
    location.reload();
  }

  function mountOverlayToggle() {
    // Idempotent — dispatch re-fires on SPA nav, so clear any prior instance.
    document.querySelectorAll('#' + OVERLAY_TOGGLE_ID)
      .forEach(function (n) { n.remove(); });
    const btn = document.createElement('button');
    btn.id = OVERLAY_TOGGLE_ID;
    btn.type = 'button';
    btn.textContent = 'V';
    paintOverlayToggle(btn);
    btn.addEventListener('click', onOverlayToggleClick);
    (document.body || document.documentElement).appendChild(btn);
  }

  async function dispatch() {
    if (!TORN_API_KEY || TORN_API_KEY.indexOf('PDA-APIKEY') !== -1) {
      log('Not running inside PDA - aborting.');
      return;
    }
    // Resolve the indicator toggle before any runner paints. Failures
    // inside the resolver already degrade to "show"; the catch is belt
    // and suspenders so a bug here can never block the ingest runners.
    try { await refreshIndicatorPref(); }
    catch (e) { log('indicator pref error', e); indicatorsHidden = false; }
    // Mount the in-game show/hide toggle on every page. NOT gated by
    // indicatorsHidden — it must stay reachable in silent mode.
    try { mountOverlayToggle(); } catch (e) { log('overlay toggle mount error', e); }
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
      case 'museum':     return runMuseum();
      case 'pmarket':    return runPointsMarket();
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
