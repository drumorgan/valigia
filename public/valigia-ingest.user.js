// ==UserScript==
// @name         Valigia — Travel Shop Ingest
// @namespace    https://valigia.girovagabondo.com/
// @version      0.1.1
// @description  When you land abroad in Torn, scrape the travel shop and push fresh buy prices to Valigia's shared pool. Runs inside Torn PDA.
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

  // ── Config ──────────────────────────────────────────────────────────────
  // PDA substitutes ###PDA-APIKEY### with the user's Torn key at runtime.
  // Outside PDA the placeholder stays literal, and the script aborts cleanly.
  // v0.1.1 — no behaviour change; bumped @version to verify PDA auto-update.
  const TORN_API_KEY = '###PDA-APIKEY###';

  const INGEST_URL =
    'https://vtslzplzlxdptpvxtanz.supabase.co/functions/v1/ingest-travel-shop';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0c2x6cGx6bHhkcHRwdnh0YW56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MzQyNTMsImV4cCI6MjA5MTQxMDI1M30.Ddzoq8bCmWc875gbdQKhqnR5M7TraWWj4TYS4RRKkMY';

  // Flip to true to draw an always-on debug panel on the Torn page showing
  // exactly what the parser found. Useful on iPad where DevTools is absent.
  const DEBUG = false;

  // Known Torn travel shop category names. Used as section anchors — the
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

  // ── Utilities ───────────────────────────────────────────────────────────
  function log(...args) {
    if (DEBUG) {
      try { console.log('[valigia]', ...args); } catch { /* ignore */ }
    }
  }

  function toast(message, kind = 'info') {
    const bg = kind === 'error' ? '#b33' : kind === 'success' ? '#2a7' : '#333';
    const el = document.createElement('div');
    el.textContent = `Valigia: ${message}`;
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
    setTimeout(() => el.remove(), 6000);
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
    // "$1,234" / "$1.234" / "1234" → 1234
    const digits = String(text).replace(/[^\d]/g, '');
    return digits ? Number(digits) : NaN;
  }

  function parseInt10(text) {
    const digits = String(text).replace(/[^\d]/g, '');
    return digits ? Number(digits) : NaN;
  }

  // ── Destination detection ───────────────────────────────────────────────
  // Torn's travel page reads: "You are in {Country} and have..."
  function detectDestination() {
    const body = document.body?.innerText || '';
    const m = body.match(/You are in ([A-Z][A-Za-z ]+?) and have/);
    return m ? m[1].trim() : null;
  }

  // ── Shop scraping ───────────────────────────────────────────────────────
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
    // Torn has used — tr, li, div with sibling cells.
    return (
      img.closest('tr') ||
      img.closest('li') ||
      img.closest('[class*="row"]') ||
      img.closest('[class*="Row"]') ||
      img.parentElement?.parentElement ||
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
    // of text in the row. Prefer alt — it's the most stable.
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
    // Find the largest bare-integer token — stock is almost always >= 1.
    const intTokens = textWithoutPrice.match(/(?<![\w.])\d[\d,]*(?![\w.])/g) || [];
    let stock = NaN;
    for (const tok of intTokens) {
      const n = parseInt10(tok);
      if (Number.isFinite(n) && (Number.isNaN(stock) || n > stock)) stock = n;
    }

    return { item_id, name, stock, buy_price };
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

    return Array.from(shops.entries()).map(([category, items]) => ({
      category,
      items,
    }));
  }

  // ── Network ─────────────────────────────────────────────────────────────
  function gmRequest(opts) {
    // Support both GM_xmlhttpRequest (classic) and GM.xmlHttpRequest (promise-ish).
    return new Promise((resolve, reject) => {
      const base = {
        method: opts.method || 'POST',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data,
        timeout: 15000,
        onload: (res) => resolve(res),
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error('timeout')),
      };
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest(base);
      } else if (typeof GM !== 'undefined' && GM.xmlHttpRequest) {
        GM.xmlHttpRequest(base).then(resolve, reject);
      } else {
        reject(new Error('No GM_xmlhttpRequest available — install as userscript in PDA'));
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
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      data: JSON.stringify(payload),
    });
    let parsed = null;
    try { parsed = JSON.parse(res.responseText); } catch { /* ignore */ }
    return { status: res.status, body: parsed, raw: res.responseText };
  }

  // ── Main ────────────────────────────────────────────────────────────────
  async function run() {
    // The placeholder stays literal if this isn't running inside PDA. Bail
    // quietly rather than firing a bogus request with a broken key.
    if (!TORN_API_KEY || TORN_API_KEY.includes('PDA-APIKEY')) {
      log('Not running inside PDA — aborting.');
      return;
    }

    const destination = detectDestination();
    if (!destination) {
      log('No "You are in X" marker — probably not landed yet.');
      return;
    }

    // Torn's travel page hydrates its shop lists after initial DOM render.
    // Poll briefly for item images to show up before scraping.
    const start = Date.now();
    let shops = [];
    while (Date.now() - start < 8000) {
      shops = scrapeShops();
      const total = shops.reduce((s, sh) => s + sh.items.length, 0);
      if (total > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const totalItems = shops.reduce((s, sh) => s + sh.items.length, 0);
    if (totalItems === 0) {
      log('No shop items found after 8s — aborting.');
      if (DEBUG) debugPanel([`destination=${destination}`, 'No items found.']);
      return;
    }

    if (DEBUG) {
      const lines = [`destination=${destination}`, `shops=${shops.length}`, `items=${totalItems}`, ''];
      for (const sh of shops) {
        lines.push(`  [${sh.category}] ${sh.items.length} items`);
        for (const it of sh.items.slice(0, 3)) {
          lines.push(`    • ${it.name} (id=${it.item_id}) stock=${it.stock} $${it.buy_price}`);
        }
        if (sh.items.length > 3) lines.push(`    … +${sh.items.length - 3} more`);
      }
      debugPanel(lines);
    }

    try {
      const { status, body } = await postIngest({
        api_key: TORN_API_KEY,
        destination,
        shops,
      });
      if (status >= 200 && status < 300 && body?.ok) {
        toast(`${destination}: stored ${body.stored} items`, 'success');
      } else {
        const msg = body?.error || `HTTP ${status}`;
        toast(`ingest failed — ${msg}`, 'error');
      }
    } catch (err) {
      toast(`network error — ${err.message || err}`, 'error');
    }
  }

  // Run once after DOM is settled. Torn's SPA may re-render on in-page nav;
  // for v0.1 we only handle the initial landing, which is the common case.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    setTimeout(run, 500);
  }
})();
