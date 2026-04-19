// Sell-tab UI — "someone wants to buy your stuff" surface.
//
// Two surfaces inside this tab:
//   1) Submit form — paste a TE URL / handle / player id; scrape it
//      server-side via ingest-te-trader.
//   2) Inventory matcher — for every item in the logged-in player's
//      Torn inventory, find the trader in the shared pool offering the
//      highest buy-price. Sort by absolute trader-pays value descending
//      so the biggest wins surface at the top.
//
// Reads hit Supabase anon directly (te_traders + te_buy_prices have
// public SELECT policies). Writes flow through the ingest-te-trader
// edge fn so every scrape is submitter-attributed and rate-limited.

import { callTornApi } from './torn-api.js';
import {
  submitTrader, listTraders, fetchBestBuyersFor, refreshStaleTrader,
} from './te-traders.js';
import { formatMoney } from './calculator.js';
import { showToast } from './ui.js';

// Cached per tab-lifetime so flipping Travel ↔ Sell doesn't re-fetch.
// Invalidate on submit/refresh so new data lands immediately.
let inventoryCache = null;         // Array<{ item_id, name, quantity }>
let inventoryRawSample = null;     // first ~4 KB of the raw response when parse yields []
let bestBuyersCache = null;        // Map<item_id, { handle, buy_price, ... }>
let tradersCache = null;           // Array of te_traders rows

export function invalidateSellCache() {
  inventoryCache = null;
  inventoryRawSample = null;
  bestBuyersCache = null;
  tradersCache = null;
}

async function loadInventory(playerId) {
  if (inventoryCache) return inventoryCache;
  const data = await callTornApi({
    section: 'user',
    selections: 'inventory',
    player_id: playerId,
  });
  // callTornApi returns null when Torn rejects the call (e.g. code 16,
  // key access too low). We must NOT conflate that with "you actually
  // own nothing" — the renderer shows different copy for each.
  if (!data) return null;

  // Torn's `inventory` selection has come back in at least two shapes
  // across versions: an array of { ID, name, type, quantity } rows, and
  // an object keyed by slot id whose values have the same fields.
  // Accept either — otherwise a schema wobble looks like an empty
  // inventory to the user.
  let rows;
  if (Array.isArray(data.inventory)) {
    rows = data.inventory;
  } else if (data.inventory && typeof data.inventory === 'object') {
    rows = Object.values(data.inventory);
  } else {
    rows = [];
  }

  inventoryCache = rows
    .map((row) => ({
      // Torn mixes casing across selections: ID in old versions, id in
      // newer ones. Accept both so we don't silently drop every row.
      item_id: Number(row?.ID ?? row?.id),
      name: String(row?.name || ''),
      quantity: Number(row?.quantity || 0),
      type: String(row?.type || ''),
    }))
    .filter((r) => Number.isInteger(r.item_id) && r.item_id > 0 && r.quantity > 0);

  // If the parser produced nothing despite Torn returning data, cache a
  // snippet of the raw response so the renderer can surface it in a
  // debug <details>. No DevTools on iPad means this is the only way we
  // get to see what actually came back.
  if (inventoryCache.length === 0) {
    try {
      const snippet = JSON.stringify(data).slice(0, 4000);
      inventoryRawSample = snippet;
    } catch {
      inventoryRawSample = '[unserialisable response]';
    }
  } else {
    inventoryRawSample = null;
  }
  return inventoryCache;
}

async function loadBestBuyers(inventory) {
  if (bestBuyersCache) return bestBuyersCache;
  const ids = inventory.map((r) => r.item_id);
  bestBuyersCache = await fetchBestBuyersFor(ids);
  return bestBuyersCache;
}

async function loadTraders() {
  if (tradersCache) return tradersCache;
  tradersCache = await listTraders();
  return tradersCache;
}

// ── Formatters ────────────────────────────────────────────────
function formatAge(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function traderProfileLink(row) {
  if (row.torn_player_id) {
    return `https://www.torn.com/profiles.php?XID=${row.torn_player_id}`;
  }
  return `https://tornexchange.com/prices/${encodeURIComponent(row.handle)}/`;
}

// ── Match-row HTML ────────────────────────────────────────────
// Each inventory item that has at least one buy-offer renders as a
// single row: quantity × item name, best trader + per-unit price,
// total the trader would pay for the full stack, and a CTA link to
// the trader's TE page (message them in-game from there).
function matchRowHtml({ item, offer }) {
  const total = offer.buy_price * item.quantity;
  const tePage = `https://tornexchange.com/prices/${encodeURIComponent(offer.handle)}/`;
  return `
    <a class="sell-match-row" href="${tePage}" target="_blank" rel="noopener">
      <span class="sell-match-qty">${item.quantity.toLocaleString('en-US')}×</span>
      <span class="sell-match-item">${escapeHtml(offer.item_name || item.name)}</span>
      <span class="sell-match-arrow" aria-hidden="true">→</span>
      <span class="sell-match-trader">${escapeHtml(offer.handle)}</span>
      <span class="sell-match-price">${formatMoney(offer.buy_price)}<span class="sell-match-unit">/ea</span></span>
      <span class="sell-match-total">${formatMoney(total)} total</span>
      <span class="sell-match-age">${formatAge(offer.updated_at)}</span>
      <span class="sell-match-cta" aria-hidden="true">trade →</span>
    </a>
  `;
}

function noMatchRowHtml({ item }) {
  return `
    <div class="sell-nomatch-row">
      <span class="sell-match-qty">${item.quantity.toLocaleString('en-US')}×</span>
      <span class="sell-match-item">${escapeHtml(item.name)}</span>
      <span class="sell-nomatch-label">no trader in pool</span>
    </div>
  `;
}

function traderRowHtml(row) {
  const status = row.last_scrape_ok
    ? `<span class="sell-trader-ok">${row.item_count || 0} items</span>`
    : `<span class="sell-trader-fail">last scrape failed</span>`;
  return `
    <div class="sell-trader-row" data-handle="${escapeHtml(row.handle)}">
      <a class="sell-trader-name" href="${traderProfileLink(row)}" target="_blank" rel="noopener">
        ${escapeHtml(row.handle)}
      </a>
      <span class="sell-trader-status">${status}</span>
      <span class="sell-trader-age">${formatAge(row.last_scraped_at)}</span>
      <button type="button" class="sell-trader-refresh" data-handle="${escapeHtml(row.handle)}">
        Refresh
      </button>
    </div>
  `;
}

// ── Main render ───────────────────────────────────────────────
export async function renderSellTab(container, playerId) {
  if (!container) return;

  // Initial shell so the user sees something immediately. The two
  // async loads fill in below.
  container.innerHTML = `
    <div class="sell-tab">
      <div class="sell-intro">
        <h2 class="sell-heading">Sell</h2>
        <p class="sell-sub">
          TornExchange traders advertise standing buy-offers for items.
          Submit a trader's page and we'll keep a pool of their prices
          so anyone using Valigia can find the best buyer for what they
          own — including you, on this tab.
        </p>
      </div>

      <form class="sell-add" id="sell-add-form">
        <div class="sell-add-row">
          <label class="sell-field">
            <span class="sell-field-label">TornExchange page URL or handle</span>
            <input
              type="text"
              id="sell-input"
              class="sell-input"
              placeholder="https://tornexchange.com/prices/OldGoat/ — or just OldGoat"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <button type="submit" id="sell-submit" class="sell-submit">Add trader</button>
        </div>
        <div class="sell-add-status" id="sell-status" hidden></div>
      </form>

      <section class="sell-matches">
        <div class="sell-section-header">
          <h3 class="sell-section-title">Your inventory → best buyer</h3>
          <button type="button" id="sell-refresh-matches" class="sell-mini-btn">Refresh</button>
        </div>
        <div id="sell-matches-body" class="sell-matches-body">
          <div class="sell-loading">Loading your inventory…</div>
        </div>
      </section>

      <section class="sell-traders">
        <div class="sell-section-header">
          <h3 class="sell-section-title">Traders in the pool</h3>
        </div>
        <div id="sell-traders-body" class="sell-traders-body">
          <div class="sell-loading">Loading traders…</div>
        </div>
      </section>
    </div>
  `;

  // Wire the submit form
  const form = container.querySelector('#sell-add-form');
  form.addEventListener('submit', (e) => handleSubmit(e, container, playerId));

  // Wire the top-right refresh of the matches block
  container.querySelector('#sell-refresh-matches').addEventListener('click', () => {
    invalidateSellCache();
    renderMatchesBody(container, playerId);
    renderTradersBody(container);
  });

  // Event delegation for per-trader refresh buttons (they don't exist
  // yet — the body renders asynchronously below).
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.sell-trader-refresh');
    if (!btn) return;
    handleTraderRefresh(btn.dataset.handle, container, playerId);
  });

  // Fire the two async renders in parallel.
  renderMatchesBody(container, playerId);
  renderTradersBody(container);
}

async function renderMatchesBody(container, playerId) {
  const body = container.querySelector('#sell-matches-body');
  if (!body) return;
  body.innerHTML = '<div class="sell-loading">Loading your inventory…</div>';

  let inventory;
  try {
    inventory = await loadInventory(playerId);
  } catch (err) {
    body.innerHTML = `<div class="sell-empty">Could not load inventory: ${escapeHtml(err?.message || 'unknown error')}</div>`;
    return;
  }
  // null = Torn rejected the call (usually code 16 — the stored key
  // predates the `inventory` scope). Tell the user exactly what to do;
  // "empty inventory" copy would be misleading here.
  if (inventory === null) {
    body.innerHTML = `
      <div class="sell-empty">
        Valigia couldn't read your inventory. Your Torn API key is missing
        the <code>inventory</code> permission — log out, then log back in
        and use the "Create a Custom Key on Torn" link to make a new one.
      </div>
    `;
    return;
  }
  if (inventory.length === 0) {
    // If we captured a raw-response sample, surface it in a collapsed
    // details block so the user can expand it on iPad (no DevTools) and
    // paste it back for parser iteration. Hidden unless we actually
    // have a sample — a genuinely empty inventory shouldn't offer noise.
    const debugBlock = inventoryRawSample
      ? `
        <details class="sell-debug">
          <summary>Raw inventory response (for debugging)</summary>
          <pre class="sell-debug-body">${escapeHtml(inventoryRawSample)}</pre>
        </details>
      `
      : '';
    body.innerHTML = `
      <div class="sell-empty">Your Torn inventory is empty — nothing to sell.</div>
      ${debugBlock}
    `;
    return;
  }

  const best = await loadBestBuyers(inventory);

  // Partition into "has offer" / "no offer". Show offers first sorted by
  // total-trader-pays descending (the biggest dollar win, not the highest
  // per-unit price — a cheap item you have 1000 of can beat a rare one).
  const withOffer = [];
  const withoutOffer = [];
  for (const item of inventory) {
    const offer = best.get(item.item_id);
    if (offer) withOffer.push({ item, offer, total: offer.buy_price * item.quantity });
    else withoutOffer.push({ item });
  }
  withOffer.sort((a, b) => b.total - a.total);

  if (withOffer.length === 0) {
    body.innerHTML = `
      <div class="sell-empty">
        No traders in the pool are buying any of your ${inventory.length} inventory items.
        Try submitting a trader above — their prices become available to every Valigia user.
      </div>
    `;
    return;
  }

  const offersHtml = withOffer.map(matchRowHtml).join('');
  const missingHtml = withoutOffer.length > 0
    ? `
      <details class="sell-no-offers">
        <summary>${withoutOffer.length} item${withoutOffer.length === 1 ? '' : 's'} with no pool offer</summary>
        <div class="sell-nomatch-body">${withoutOffer.map(noMatchRowHtml).join('')}</div>
      </details>
    `
    : '';

  body.innerHTML = `
    <div class="sell-match-rows">${offersHtml}</div>
    ${missingHtml}
  `;
}

async function renderTradersBody(container) {
  const body = container.querySelector('#sell-traders-body');
  if (!body) return;
  const traders = await loadTraders();
  if (!traders || traders.length === 0) {
    body.innerHTML = `
      <div class="sell-empty">
        No traders yet. Add one above — your pool contributions help every
        Valigia user find better buyers.
      </div>
    `;
    return;
  }
  body.innerHTML = traders.map(traderRowHtml).join('');
}

// ── Form handlers ─────────────────────────────────────────────
async function handleSubmit(e, container, playerId) {
  e.preventDefault();
  const input = container.querySelector('#sell-input');
  const btn = container.querySelector('#sell-submit');
  const status = container.querySelector('#sell-status');
  const value = input.value.trim();
  if (!value) return;

  btn.disabled = true;
  btn.textContent = 'Scraping…';
  status.hidden = true;

  const result = await submitTrader(value);

  btn.disabled = false;
  btn.textContent = 'Add trader';

  status.hidden = false;
  if (result.ok) {
    status.className = 'sell-add-status sell-add-status--ok';
    status.textContent = `Added ${result.handle}: ${result.resolved} items${result.unresolved ? ` (${result.unresolved} unresolved)` : ''}.`;
    input.value = '';
    // Wipe both caches so the new trader's prices appear immediately
    // and the trader list shows them at the top.
    invalidateSellCache();
    renderMatchesBody(container, playerId);
    renderTradersBody(container);
    showToast(`Added trader ${result.handle}`, 'success');
  } else {
    status.className = 'sell-add-status sell-add-status--err';
    const extras = [];
    if (result.strategy) extras.push(`strategy=${result.strategy}`);
    if (result.scraped_rows != null) extras.push(`scraped ${result.scraped_rows} rows`);
    if (result.unresolved_sample?.length) {
      extras.push(`unresolved: ${result.unresolved_sample.slice(0, 3).join(', ')}`);
    }
    const extraLabel = extras.length ? ` (${extras.join('; ')})` : '';
    status.textContent = `Could not scrape: ${result.error || 'unknown error'}${extraLabel}`;
    showToast(`Trader submit failed: ${result.error || 'see status'}`, 'error');
  }
}

async function handleTraderRefresh(handle, container, playerId) {
  if (!handle) return;
  const row = container.querySelector(`.sell-trader-row[data-handle="${CSS.escape(handle)}"]`);
  const btn = row?.querySelector('.sell-trader-refresh');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }

  const result = await refreshStaleTrader(handle);

  if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }

  if (result.ok) {
    showToast(`Refreshed ${handle}: ${result.resolved} items`, 'success');
    invalidateSellCache();
    renderMatchesBody(container, playerId);
    renderTradersBody(container);
  } else {
    showToast(`Refresh ${handle} failed: ${result.error || 'unknown'}`, 'error');
  }
}
