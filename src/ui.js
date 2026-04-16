// UI module — table rendering, controls, shimmer loading, toast notifications.

import { getFlightMins, getDestinationBadge } from './data/destinations.js';
import { DESTINATIONS } from './data/destinations.js';
import { getItemTypeById } from './item-resolver.js';
import { calculateMargins, formatFlightTime, formatMoney } from './calculator.js';
import { forecastStock } from './stock-forecast.js';
import { getSellTimeMins, getLiquidityBadge } from './data/liquidity.js';

// ── Flight type definitions ───────────────────────────────────
// `short` is what we display in the collapsed control so the whole bar
// fits on one line. The native picker still shows `label`.
const FLIGHT_TYPES = [
  { value: 'standard',     label: 'Standard',       short: 'STD', multiplier: 1.0 },
  { value: 'airstrip',     label: 'Airstrip',       short: 'A/S', multiplier: 0.7 },
  { value: 'wlt',          label: 'WLT',            short: 'WLT', multiplier: 0.7 },
  { value: 'airstrip_wlt', label: 'Airstrip + WLT', short: 'A+W', multiplier: 0.49 },
];

function getFlightMultiplier() {
  const ft = FLIGHT_TYPES.find(f => f.value === flightType);
  return ft ? ft.multiplier : 1.0;
}

// ── State ──────────────────────────────────────────────────────
const STORAGE_SLOTS = 'valigia_slots';
const STORAGE_FLIGHT_TYPE = 'valigia_flight_type';
const STORAGE_SORT_COL = 'valigia_sort_col';
const STORAGE_SORT_DIR = 'valigia_sort_dir';
const STORAGE_FILTER_DEST = 'valigia_filter_dest';
const STORAGE_FILTER_CAT = 'valigia_filter_cat';
const STORAGE_REALISM = 'valigia_realism_mode';

let slotCount = parseInt(localStorage.getItem(STORAGE_SLOTS)) || 29;
let flightType = localStorage.getItem(STORAGE_FLIGHT_TYPE) || 'standard';
let sortCol = localStorage.getItem(STORAGE_SORT_COL) || 'profitPerHour';
let sortDir = localStorage.getItem(STORAGE_SORT_DIR) || 'desc';
let filterDestination = localStorage.getItem(STORAGE_FILTER_DEST) || 'all';
let filterCategory = localStorage.getItem(STORAGE_FILTER_CAT) || 'all';
// realismMode:
//   'realistic' — clamp slots to arrival-time stock forecast AND include
//                 category sell-time in the profit/hr denominator. Default.
//                 Answers "what will I actually make on this run".
//   'ideal'     — ignore stock (assume full slots) and ignore sell-time
//                 (assume instant liquidation). Answers "what's the peak
//                 theoretical return of this arbitrage pairing right now".
//                 Useful as a sanity check and for planning ahead.
let realismMode = localStorage.getItem(STORAGE_REALISM) || 'realistic';

// Live data — populated as prices arrive
const sellPrices = new Map();   // itemId → sell price
const marketDepth = new Map();  // itemId → { floorQty, listingCount }
const checkedItems = new Set();  // itemIds where sell price has been looked up
// Timestamp of the data source for each known sell price — Supabase row's
// updated_at when served from cache, Date.now() when fetched fresh.
// Drives the category-filter "refresh anything >5min old" hook.
const sellPriceFetchedAt = new Map(); // itemId → ms since epoch
let knownItems = [];            // Array of { item_id, item_name, destination, buy_price, reported_at, quantity }
let bestBazaarRun = null;        // Optional verified bazaar deal, set by main.js

// A bazaar purchase + re-list is a short, one-shot task. 5 min is a
// defensible nominal duration: click bazaar link → buy → go to item market
// → list. This is what we divide absolute profit by to compare against a
// travel run's profit/hr.
const BAZAAR_NOMINAL_TRANSACTION_MINS = 5;

// ── Column definitions for sortable headers ───────────────────
const COLUMNS = [
  { key: null,            label: '#',           css: 'col-rank' },
  { key: 'name',          label: 'Item',        css: 'col-item' },
  { key: 'destination',   label: 'Dest',        css: 'col-dest' },
  { key: 'quantity',      label: 'Stock',       css: 'col-stock' },
  { key: 'buyPrice',      label: 'Buy',         css: 'col-buy' },
  { key: 'sellPrice',     label: 'Sell (net)',   css: 'col-sell' },
  { key: 'marginPerItem', label: 'Margin',      css: 'col-margin' },
  { key: 'runCost',       label: 'Run Cost',    css: 'col-runcost' },
  { key: 'profitPerRun',  label: 'Profit/Run',  css: 'col-run' },
  { key: 'profitPerHour', label: 'Profit/hr',   css: 'col-hr' },
  { key: 'flightMins',    label: 'Flight',      css: 'col-flight' },
];

const COL_COUNT = COLUMNS.length;

// Items with absurdly high buy prices (> $10M) are almost always rare
// collector variants (e.g. "Dozen White Roses" at $950M) that share a name
// with a real abroad item. They aren't real travel arbitrage targets.
// Hide them when the market also confirms "no listings" — at that point
// they're noise, not opportunity.
const OUTLIER_BUY_PRICE_THRESHOLD = 10_000_000;

// ── Toast ──────────────────────────────────────────────────────
let toastTimeout;

export function showToast(message, type = 'error') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast toast--${type} toast--visible`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('toast--visible'), 4000);
}

// ── Controls ───────────────────────────────────────────────────

function persistControls() {
  localStorage.setItem(STORAGE_SLOTS, String(slotCount));
  localStorage.setItem(STORAGE_FLIGHT_TYPE, flightType);
}

function persistSort() {
  localStorage.setItem(STORAGE_SORT_COL, sortCol);
  localStorage.setItem(STORAGE_SORT_DIR, sortDir);
}

function persistFilters() {
  localStorage.setItem(STORAGE_FILTER_DEST, filterDestination);
  localStorage.setItem(STORAGE_FILTER_CAT, filterCategory);
}

function persistRealism() {
  localStorage.setItem(STORAGE_REALISM, realismMode);
}

/**
 * Get sorted list of destinations from known items, ordered by flight time (longest first).
 */
function getAvailableDestinations() {
  const dests = new Set();
  for (const item of knownItems) {
    if (item.destination) dests.add(item.destination);
  }
  return [...dests].sort((a, b) => (getFlightMins(b) || 0) - (getFlightMins(a) || 0));
}

export function renderControls(container, onChange, onCategoryChange) {
  const destinations = getAvailableDestinations();
  // Options show the full country name + flag so the native picker is clear,
  // but the collapsed control only shows a flag via an overlay span (see CSS).
  const destOptions = destinations.map(d => {
    const { flag } = getDestinationBadge(d);
    const prefix = flag ? `${flag} ` : '';
    return `<option value="${d}" ${filterDestination === d ? 'selected' : ''}>${prefix}${d}</option>`;
  }).join('');

  const flightOptions = FLIGHT_TYPES.map(ft =>
    `<option value="${ft.value}" ${flightType === ft.value ? 'selected' : ''}>${ft.label}</option>`
  ).join('');

  const selectedFlight = FLIGHT_TYPES.find(f => f.value === flightType) || FLIGHT_TYPES[0];
  const destIsAll = filterDestination === 'all';
  const selectedDestDisplay = destIsAll
    ? 'ALL'
    : (getDestinationBadge(filterDestination).flag || filterDestination);
  const destDisplayClass = destIsAll ? '' : 'select-display--flag';

  container.innerHTML = `
    <div class="controls">
      <label class="control-group">
        <span class="control-label">Slots</span>
        <input type="number" id="ctl-slots" class="control-input control-input--slim"
               value="${slotCount}" min="5" max="44" />
      </label>
      <label class="control-group">
        <span class="control-label">Flight</span>
        <span class="select-wrap">
          <select id="ctl-flight-type" class="control-select control-select--compact">
            ${flightOptions}
          </select>
          <span class="select-display" id="ctl-flight-display">${selectedFlight.short}</span>
        </span>
      </label>
      <label class="control-group">
        <span class="control-label">Dest</span>
        <span class="select-wrap">
          <select id="ctl-destination" class="control-select control-select--compact select--flag">
            <option value="all" ${filterDestination === 'all' ? 'selected' : ''}>All destinations</option>
            ${destOptions}
          </select>
          <span class="select-display ${destDisplayClass}" id="ctl-destination-display">${selectedDestDisplay}</span>
        </span>
      </label>
      <div class="control-group filter-chips">
        <span class="control-label">Type</span>
        <button class="filter-chip ${filterCategory === 'all' ? 'filter-chip--active' : ''}" data-cat="all">All</button>
        <button class="filter-chip ${filterCategory === 'drug' ? 'filter-chip--active' : ''}" data-cat="drug">Drugs</button>
        <button class="filter-chip ${filterCategory === 'plushie' ? 'filter-chip--active' : ''}" data-cat="plushie">Plushies</button>
        <button class="filter-chip ${filterCategory === 'flower' ? 'filter-chip--active' : ''}" data-cat="flower">Flowers</button>
        <button class="filter-chip ${filterCategory === 'artifact' ? 'filter-chip--active' : ''}" data-cat="artifact">Artifacts</button>
      </div>
      <div class="control-group filter-chips control-group--right" title="Realistic: clamp slots to arrival-stock forecast and add sell-time to profit/hr. Ideal: assume full slots and instant liquidation.">
        <span class="control-label">Mode</span>
        <button class="filter-chip ${realismMode === 'realistic' ? 'filter-chip--active' : ''}" data-realism="realistic">Realistic</button>
        <button class="filter-chip ${realismMode === 'ideal' ? 'filter-chip--active' : ''}" data-realism="ideal">Ideal</button>
      </div>
    </div>
  `;

  container.querySelector('#ctl-slots').addEventListener('input', (e) => {
    slotCount = Math.max(5, Math.min(44, parseInt(e.target.value) || 29));
    persistControls();
    onChange();
  });
  container.querySelector('#ctl-flight-type').addEventListener('change', (e) => {
    flightType = e.target.value;
    const ft = FLIGHT_TYPES.find(f => f.value === flightType);
    const disp = container.querySelector('#ctl-flight-display');
    if (ft && disp) disp.textContent = ft.short;
    persistControls();
    onChange();
  });
  container.querySelector('#ctl-destination').addEventListener('change', (e) => {
    filterDestination = e.target.value;
    const disp = container.querySelector('#ctl-destination-display');
    if (disp) {
      const isAll = filterDestination === 'all';
      disp.textContent = isAll
        ? 'ALL'
        : (getDestinationBadge(filterDestination).flag || filterDestination);
      disp.classList.toggle('select-display--flag', !isAll);
    }
    persistFilters();
    onChange();
  });
  // Category filter chips (scoped by data-cat so they don't collide with
  // the Mode chips below).
  container.querySelectorAll('.filter-chip[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      filterCategory = btn.dataset.cat;
      persistFilters();
      container.querySelectorAll('.filter-chip[data-cat]').forEach(b => b.classList.remove('filter-chip--active'));
      btn.classList.add('filter-chip--active');
      onChange();
      if (onCategoryChange) onCategoryChange(filterCategory);
    });
  });

  // Realism toggle — flips the Stock clamp and sell-time penalty on/off.
  // Scoped by data-realism so it's independent of the category chips.
  container.querySelectorAll('.filter-chip[data-realism]').forEach(btn => {
    btn.addEventListener('click', () => {
      realismMode = btn.dataset.realism;
      persistRealism();
      container.querySelectorAll('.filter-chip[data-realism]').forEach(b => b.classList.remove('filter-chip--active'));
      btn.classList.add('filter-chip--active');
      onChange();
    });
  });
}

/**
 * Update slots and airstrip from auto-detected values.
 * Also updates the DOM controls if they exist.
 */
export function setPlayerTravel(slots, airstrip) {
  if (slots != null && slots > slotCount) {
    slotCount = slots;
    localStorage.setItem(STORAGE_SLOTS, slotCount);
    const el = document.getElementById('ctl-slots');
    if (el) el.value = slotCount;
  }
  if (airstrip != null && airstrip && flightType === 'standard') {
    // Auto-upgrade to airstrip only if currently on standard
    flightType = 'airstrip';
    const el = document.getElementById('ctl-flight-type');
    if (el) el.value = 'airstrip';
    const disp = document.getElementById('ctl-flight-display');
    const ft = FLIGHT_TYPES.find(f => f.value === 'airstrip');
    if (disp && ft) disp.textContent = ft.short;
  }
  persistControls();
  renderTable();
}

// ── Data ───────────────────────────────────────────────────────

/**
 * Set the known items from YATA abroad prices.
 */
export function setKnownItems(rows) {
  knownItems = rows;
}

/**
 * Set a verified bazaar-deal candidate from main.js's background search.
 * When set, the "Best Run Right Now" card will compare this against the
 * top travel run by profit/hr and show whichever wins. Pass null to clear.
 */
export function setBestBazaarRun(deal) {
  bestBazaarRun = deal;
  renderTable();
}

/**
 * Get all unique item IDs that need sell price lookups.
 */
export function getItemIdsForPriceFetch() {
  const ids = new Set();
  for (const row of knownItems) {
    if (row.item_id) ids.add(row.item_id);
  }
  return [...ids];
}

/**
 * Called as each sell price resolves from the market fetcher.
 * @param {number} itemId
 * @param {number|null} price - Cheapest listing price, or null when no listings.
 * @param {{floorQty: number|null, listingCount: number|null}|null} [depth]
 *   Market depth snapshot at the time of the fetch. Optional for back-compat.
 */
export function onSellPrice(itemId, price, depth, fetchedAt) {
  if (price != null) sellPrices.set(itemId, price);
  if (depth && (depth.floorQty != null || depth.listingCount != null)) {
    marketDepth.set(itemId, depth);
  }
  if (fetchedAt != null) sellPriceFetchedAt.set(itemId, fetchedAt);
  checkedItems.add(itemId);
  renderTable();
}

/**
 * Return unique item IDs belonging to the given Torn category whose sell
 * price is older than maxAgeMs (or has never been fetched in this session).
 * Called from the category filter click handler to trigger a targeted
 * on-demand refresh. "all" returns nothing — we only refresh when the user
 * has narrowed the view to a specific category.
 */
export function getStaleItemIdsForCategory(category, maxAgeMs) {
  if (!category || category === 'all') return [];
  const now = Date.now();
  const ids = new Set();
  for (const item of knownItems) {
    if (!item.item_id) continue;
    if (getItemTypeById(item.item_id) !== category) continue;
    const fetchedAt = sellPriceFetchedAt.get(item.item_id);
    if (fetchedAt == null || now - fetchedAt > maxAgeMs) {
      ids.add(item.item_id);
    }
  }
  return [...ids];
}

// ── Table helpers ──────────────────────────────────────────────

// "ago" is implied by the freshness-dot icon next to the value —
// spelling it out on every row was wasted width. Kept short and dense:
// "2m", "1h 30m", "5d". The tooltip still includes the full phrase.
function formatTimeAgo(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

function formatDaysAgo(ms) {
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  return `${days}d`;
}

function formatQuantity(qty) {
  if (qty == null) return '<span class="muted">—</span>';
  return Number(qty).toLocaleString('en-US');
}

/**
 * Tooltip string describing market depth. Returns empty string when we
 * have nothing useful to say. Attribute-safe (no quotes in output).
 *
 * listing_count of 0 means we've confirmed "no listings" — phrased
 * differently from unknown so the user knows it's been checked.
 */
function formatDepthTooltip(depth) {
  if (!depth) return '';
  const { floorQty, listingCount } = depth;
  if (listingCount === 0) return 'Item market: no active listings';
  const parts = [];
  if (listingCount != null) {
    parts.push(`${listingCount} listing${listingCount === 1 ? '' : 's'}`);
  }
  if (floorQty != null) {
    parts.push(`${floorQty} at floor`);
  }
  if (parts.length === 0) return '';
  return `Market depth: ${parts.join(', ')}`;
}

/**
 * Render the Stock cell. Shows YATA's live quantity on top, and an
 * arrival-time estimate below when we have enough history to project one.
 * For short flights or when history has only a single sample the ETA is
 * usually the same as now — we still show it, with a muted tone, so the
 * math downstream is visible and not "hidden".
 */
/**
 * Compact destination cell: airplane link (unchanged) + flag + 3-letter
 * code. Full country name lives in the title attribute for tooltip lookup.
 * Falls back to the raw destination name if we don't have badge data.
 */
function renderDestCell(destination) {
  const travelLink = `<a href="https://www.torn.com/page.php?sid=travel" target="_blank" rel="noopener" class="dest-link" title="Travel to ${destination}">✈️</a>`;
  const { flag, code } = getDestinationBadge(destination);
  if (!flag) return `${travelLink} ${destination}`;
  return `${travelLink} <span class="dest-flag" title="${destination}">${flag}</span> <span class="dest-code">${code}</span>`;
}

function renderStockCell(row) {
  const now = row.quantity;
  if (now == null) return '<span class="muted">—</span>';

  // In Ideal mode we're intentionally ignoring the arrival-time forecast
  // (slot clamping is off), so hiding the ETA line here keeps the Stock
  // cell honest about what the math is actually using.
  if (realismMode === 'ideal') return formatQuantity(now);

  const f = row.forecast;
  // No history loaded yet (first visit, or cache still coming in) — just
  // show the live number. Avoids a flash of "ETA —" on initial render.
  if (!f || !f.hasHistory) return formatQuantity(now);

  const eta = f.etaQty;
  if (eta == null) return formatQuantity(now);

  // Four possible states, in the order tested below:
  //   1. Empty now + restock projected to land before arrival → show the
  //      restock narrative with its uncertainty band ("restock ~52m ±8m → 12").
  //      The "China at 0" scenario: long flight + regular cadence turns an
  //      apparent dead run back into a live one.
  //   2. Shelf depletes during flight AND restock refills it before arrival
  //      → two-phase narrative ("empty ~37m · restock ~52m → 894"). Detected
  //      via `eta > now` — that's only possible because stock-forecast.js
  //      already overrode etaQty from 0 → restockQty; the depletion clamp
  //      otherwise enforces eta ≤ now. Without this branch the cell would
  //      show a naked "ETA 894" with no explanation of the journey.
  //   3. Shelf will deplete during the flight, no restock projected → swap
  //      the vague "likely empty" for a concrete "empty ~37m" when the slope
  //      gives us one; fall back to "likely empty" when it doesn't.
  //   4. Shelf survives the flight (default) → the existing "ETA N" tile.
  let etaLine;
  const restockBeforeArrival = f.restockEtaMins != null && f.restockQty != null;
  const restockConfClass = f.restockConfidence === 'high'
    ? 'stock-eta--restock-high'
    : f.restockConfidence === 'ok'
      ? 'stock-eta--restock'
      : 'stock-eta--restock-low';

  if (now === 0 && restockBeforeArrival) {
    const mins = f.restockEtaMins;
    const qty = Number(f.restockQty).toLocaleString('en-US');
    const minsLabel = mins === 0 ? 'imminent' : `~${mins}m`;
    const uncertainty = f.restockUncertaintyMins != null && mins > 0
      ? ` ±${f.restockUncertaintyMins}m`
      : '';
    const title = `Based on ${f.restockConfidence}-confidence restock cadence (${f.restockConfidence === 'high' ? 'tight' : 'rough'} interval)`;
    etaLine = `<span class="stock-eta ${restockConfClass}" title="${title}">restock ${minsLabel}${uncertainty} → ${qty}</span>`;
  } else if (eta > now && restockBeforeArrival) {
    const restockMins = f.restockEtaMins;
    const qty = Number(f.restockQty).toLocaleString('en-US');
    const emptyClause = f.timeToEmptyMins != null
      ? `empty ~${f.timeToEmptyMins}m · `
      : '';
    const title = `Slope depletes the shelf mid-flight; restock cadence (${f.restockConfidence} conf) refills it to ~${qty} before you land`;
    etaLine = `<span class="stock-eta stock-eta--refill ${restockConfClass}" title="${title}">${emptyClause}restock ~${restockMins}m → ${qty}</span>`;
  } else if (eta === 0 && now > 0) {
    const label = f.timeToEmptyMins != null
      ? `empty ~${f.timeToEmptyMins}m`
      : 'likely empty';
    etaLine = `<span class="stock-eta stock-eta--empty" title="Recent depletion rate projects the shelf to be empty when you land">${label}</span>`;
  } else {
    const confClass = f.confidence === 'ok' ? 'stock-eta--ok' : 'stock-eta--low';
    const confTitle = f.confidence === 'ok'
      ? 'Projected from recent depletion rate'
      : 'Limited history — rough estimate';
    etaLine = `<span class="stock-eta ${confClass}" title="${confTitle}">ETA ${Number(eta).toLocaleString('en-US')}</span>`;
  }

  return `
    <span class="stock-now">Now ${Number(now).toLocaleString('en-US')}</span>
    ${etaLine}
  `;
}

function getBuyPriceInfo(row) {
  if (!row.reported_at) {
    return { price: row.buy_price, freshness: 'empty', reportedAgo: null };
  }

  const ageMs = Date.now() - new Date(row.reported_at).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // Fresh: today or yesterday (within 48h)
  if (ageHours <= 48) {
    return { price: row.buy_price, freshness: 'fresh', reportedAgo: formatTimeAgo(ageMs) };
  }

  // Medium: 2–7 days old
  if (ageHours <= 168) {
    return { price: row.buy_price, freshness: 'medium', reportedAgo: formatDaysAgo(ageMs) };
  }

  // Stale: older than 7 days
  return { price: row.buy_price, freshness: 'stale', reportedAgo: formatDaysAgo(ageMs) };
}

// Sell-price freshness tiers — tuned to the on-demand refresh threshold.
// Under 5 min = just fetched (or cache is still fresh), matches the
// CATEGORY_REFRESH_AGE_MS gate in main.js. 5-60 min still usable, >60 min
// likely drifting. No text label — just a dot, intentionally tight.
function getSellPriceFreshnessClass(itemId) {
  const fetchedAt = sellPriceFetchedAt.get(itemId);
  if (fetchedAt == null) return null;
  const ageMins = (Date.now() - fetchedAt) / 60000;
  if (ageMins <= 5) return 'fresh';
  if (ageMins <= 60) return 'medium';
  return 'stale';
}

function formatSellAgeTooltip(itemId) {
  const fetchedAt = sellPriceFetchedAt.get(itemId);
  if (fetchedAt == null) return '';
  const ageMs = Date.now() - fetchedAt;
  const mins = Math.floor(ageMs / 60000);
  if (mins < 1) return 'Sell price refreshed just now';
  if (mins < 60) return `Sell price refreshed ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `Sell price refreshed ${hrs}h ${rem}m ago`;
}

// ── Sorting ───────────────────────────────────────────────────

function getSortValue(row, col) {
  switch (col) {
    case 'name':          return row.name || '';
    case 'destination':   return row.destination || '';
    case 'quantity':      return row.forecast?.etaQty ?? row.quantity ?? -1;
    case 'buyPrice':      return row.buyPrice || 0;
    case 'sellPrice':     return (row.sellPrice || 0) * 0.95;
    case 'marginPerItem': return row.metrics?.marginPerItem || 0;
    case 'runCost':       return row.metrics?.runCost || 0;
    case 'profitPerRun':  return row.metrics?.profitPerRun || 0;
    case 'profitPerHour': return row.metrics?.profitPerHour || 0;
    case 'flightMins':    return row.flightMins || 0;
    default:              return 0;
  }
}

function updateHeaderSort() {
  const thead = document.querySelector('.arb-table thead');
  if (!thead) return;

  thead.querySelectorAll('[data-sort]').forEach(th => {
    const key = th.dataset.sort;
    const col = COLUMNS.find(c => c.key === key);
    const isActive = sortCol === key;
    const arrow = isActive ? (sortDir === 'desc' ? ' \u25BE' : ' \u25B4') : '';
    th.textContent = col.label + arrow;
    th.classList.toggle('th--sorted', isActive);
  });
}

function attachSortHandlers() {
  const thead = document.querySelector('.arb-table thead');
  if (!thead) return;

  thead.querySelectorAll('[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortCol === key) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortCol = key;
        sortDir = 'desc';
      }
      persistSort();
      updateHeaderSort();
      renderTable();
    });
  });
}

/**
 * Build sorted row data from known items + live sell prices.
 * Applies destination and category filters.
 */
function buildRows() {
  const rows = [];

  for (const item of knownItems) {
    if (!item.item_id) continue;

    // Apply destination filter
    if (filterDestination !== 'all' && item.destination !== filterDestination) continue;

    // Apply category filter using Torn API item types
    const category = getItemTypeById(item.item_id);
    if (filterCategory !== 'all' && category !== filterCategory) continue;

    const flightMins = getFlightMins(item.destination);
    const { price: buyPrice, freshness, reportedAgo } = getBuyPriceInfo(item);
    const sellPrice = sellPrices.get(item.item_id);
    const hasSellPrice = sellPrice != null;
    const isChecked = checkedItems.has(item.item_id);

    // Suppress outlier rows: confirmed no market listings AND a buy price
    // far above any legitimate abroad item. These are misidentified rare
    // variants, not real runs.
    if (isChecked && !hasSellPrice && buyPrice > OUTLIER_BUY_PRICE_THRESHOLD) {
      continue;
    }

    // Project stock to arrival time. One-way flight duration accounts for
    // the flight-type multiplier (airstrip/WLT shorten the time). Fall
    // back to YATA's live quantity when we have no history for this row.
    const arrivalMins = flightMins * getFlightMultiplier();
    const forecast = forecastStock(
      item.item_id,
      item.destination,
      arrivalMins,
      item.quantity ?? null,
    );

    // Realism toggle: in 'ideal' mode we strip both the stock clamp and
    // the sell-time penalty so the table answers "what's the theoretical
    // peak return". In 'realistic' (default) both are applied.
    const isIdeal = realismMode === 'ideal';

    let metrics = null;
    if (hasSellPrice && flightMins > 0) {
      metrics = calculateMargins({
        buyPrice,
        sellPrice,
        slotCount,
        flightMins,
        flightMultiplier: getFlightMultiplier(),
        // Realistic: clamp to arrival-time stock forecast.
        // Ideal:     null => calculator assumes full slot fill.
        stockQty: isIdeal ? null : forecast.etaQty,
        // Realistic: add per-category sell-time tail to cycle length.
        // Ideal:     0 => instant liquidation on landing.
        sellTimeMins: isIdeal ? 0 : getSellTimeMins(category),
      });
    }

    rows.push({
      name: item.item_name,
      destination: item.destination,
      itemId: item.item_id,
      quantity: item.quantity ?? null,
      forecast,
      category,
      buyPrice,
      freshness,
      reportedAgo,
      // 'scrape' when the price came from a PDA userscript observation in
      // abroad_prices; 'yata' otherwise. Used by the render layer to swap
      // the freshness badge for a distinct "LIVE" indicator.
      priceSource: item.source || 'yata',
      sellPrice,
      hasSellPrice,
      isChecked,
      metrics,
      flightMins,
      depth: marketDepth.get(item.item_id) || null,
    });
  }

  // Sort: negative margins to bottom, then by selected column
  rows.sort((a, b) => {
    const aNeg = a.metrics && a.metrics.marginPerItem <= 0;
    const bNeg = b.metrics && b.metrics.marginPerItem <= 0;
    if (aNeg && !bNeg) return 1;
    if (!aNeg && bNeg) return -1;

    if (!a.hasSellPrice && b.hasSellPrice) return 1;
    if (a.hasSellPrice && !b.hasSellPrice) return -1;

    const aVal = getSortValue(a, sortCol);
    const bVal = getSortValue(b, sortCol);

    if (typeof aVal === 'string') {
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    }

    return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
  });

  return rows;
}

/**
 * Normalize a verified bazaar deal into a "run" we can rank next to travel
 * runs. Uses a nominal transaction time + category sell-time so profit/hr
 * is comparable to a travel run under the same liquidity assumptions.
 * Returns null if the deal can't produce any profit at the current slot count.
 *
 * Why sell-time matters here too: before this fix, a $10M armour bazaar
 * "steal" would dominate the Best Run card because the math assumed a
 * flat 5-minute cycle. But you still have to *sell* the armour afterwards
 * on the same illiquid market. Folding in the same per-category sell-time
 * the travel rows use means armour bazaar deals get the same ~20x haircut
 * that armour travel runs do — and the card stops lying about them.
 *
 * In 'ideal' realism mode we skip the sell-time, matching the travel side.
 */
function buildBazaarRun(deal) {
  if (!deal) return null;
  const effectiveSlots = Math.min(slotCount, deal.bazaarQty);
  if (effectiveSlots <= 0) return null;

  const profitPerRun = deal.savings * effectiveSlots; // savings is already post-5%-fee
  if (profitPerRun <= 0) return null;

  const category = getItemTypeById(deal.itemId);
  const sellTimeMins = realismMode === 'ideal' ? 0 : getSellTimeMins(category);
  const cycleMins = BAZAAR_NOMINAL_TRANSACTION_MINS + sellTimeMins;
  const profitPerHour = (profitPerRun / cycleMins) * 60;

  return {
    type: 'bazaar',
    name: deal.itemName,
    category,
    bazaarOwnerId: deal.bazaarOwnerId,
    metrics: {
      profitPerRun,
      profitPerHour,
      marginPct: deal.savingsPct,
      effectiveSlots,
      stockLimited: effectiveSlots < slotCount,
      // roundTripMins stays as the bazaar transaction time alone so the UI
      // can still say "5 min transaction" without the sell-time padding.
      // cycleMins is the full number used for profit/hr.
      roundTripMins: BAZAAR_NOMINAL_TRANSACTION_MINS,
      sellTimeMins,
      cycleMins,
    },
  };
}

/**
 * Pick the single best actionable run (travel OR bazaar) and render a
 * summary card above the table. Both are normalized to profit/hr for
 * comparison; the winner is shown in its own visual variant.
 */
// ── Upcoming Restock Window card ─────────────────────────────
// Picks the single best "leave in X minutes" candidate across the current
// row set. Different semantic from "Best Run Right Now" — that card answers
// "what should I do NOW?", this card answers "when should I LEAVE so I
// land right as a shelf refills?".
//
// Math: leaveInMins = nextRestockMins - (flightMins * flightMultiplier).
// The user wants arrival to coincide with restock, so we subtract the one-
// way flight time (already multiplied by airstrip/WLT factor) from the
// predicted restock ETA. leaveInMins ≤ 0 is "leave now"; > 60m is "too
// early to commit, come back later" — we skip it rather than show a stale
// prediction.

// Biggest future window we'll still surface. Beyond this the forecaster's
// uncertainty (and any buy/sell price drift) outweighs the precision of
// the "leave in" copy. 60 min matches the typical depletion horizon and
// the rate at which a user's context (available slots, cash) changes.
const LEAVE_SOON_MAX_MINS = 60;

function buildUpcomingWindowCandidates(rows) {
  const flightMultiplier = getFlightMultiplier();
  const isIdeal = realismMode === 'ideal';

  const candidates = [];
  for (const row of rows) {
    const f = row.forecast;
    if (!f || f.nextRestockMins == null || f.restockQty == null) continue;
    if (!row.hasSellPrice) continue;
    // Gate on confidence. 'low' tiers include shelves with just two observed
    // intervals — predicting a leave time off a single sample is theater, not
    // signal. 'none' means no restock estimate exists at all.
    if (f.restockConfidence === 'low' || f.restockConfidence === 'none') continue;

    const arrivalMins = row.flightMins * flightMultiplier;
    const leaveInMins = f.nextRestockMins - arrivalMins;

    // Skip if the window already closed further ago than our uncertainty
    // band — the restock has likely already happened and been drained.
    const uncertainty = f.restockUncertaintyMins || 0;
    if (leaveInMins < -uncertainty) continue;
    // Skip if the window is further out than LEAVE_SOON_MAX_MINS — the
    // prediction will be more useful next page load anyway.
    if (leaveInMins > LEAVE_SOON_MAX_MINS) continue;

    // Arrival coincides with the restock landing: the user sees the full
    // typicalPostQty (ignoring any trickle leftover from pre-restock stock).
    // We recompute metrics with restockQty as the effective stock rather
    // than reusing row.metrics, which was computed against forecast.etaQty.
    const metrics = calculateMargins({
      buyPrice: row.buyPrice,
      sellPrice: row.sellPrice,
      slotCount,
      flightMins: row.flightMins,
      flightMultiplier,
      stockQty: isIdeal ? null : f.restockQty,
      sellTimeMins: isIdeal ? 0 : getSellTimeMins(row.category),
    });

    if (metrics.marginPerItem <= 0) continue;
    if (metrics.effectiveSlots <= 0) continue;

    candidates.push({ row, leaveInMins, metrics });
  }

  candidates.sort((a, b) => b.metrics.profitPerHour - a.metrics.profitPerHour);
  return candidates;
}

function renderUpcomingWindowCard(rows) {
  const container = document.getElementById('upcoming-window-container');
  if (!container) return;

  const candidates = buildUpcomingWindowCandidates(rows);
  if (candidates.length === 0) {
    container.innerHTML = '';
    return;
  }

  const { row, leaveInMins, metrics } = candidates[0];
  const f = row.forecast;

  const leaveLabel = leaveInMins < 1
    ? 'leave now'
    : `leave in ~${Math.round(leaveInMins)}m`;
  const uncertainty = f.restockUncertaintyMins != null && leaveInMins >= 1
    ? ` <span class="upcoming-window-uncertainty">±${f.restockUncertaintyMins}m</span>`
    : '';
  const confClass = `upcoming-window-card--${f.restockConfidence}`;
  const confTitle = f.restockConfidence === 'high'
    ? 'High confidence — tight, well-observed cadence'
    : 'Rough cadence estimate — timing may shift';

  const othersNote = candidates.length > 1
    ? `<span class="upcoming-window-sep">·</span><span class="upcoming-window-others">+${candidates.length - 1} more window${candidates.length === 2 ? '' : 's'}</span>`
    : '';

  container.innerHTML = `
    <div class="upcoming-window-card ${confClass}" title="${confTitle}">
      <div class="upcoming-window-label">Upcoming Restock Window</div>
      <div class="upcoming-window-body">
        <div class="upcoming-window-item">
          <span class="upcoming-window-name">${row.name}</span>
          <span class="upcoming-window-dest">&rarr; ${row.destination}</span>
        </div>
        <div class="upcoming-window-leave">
          <span class="upcoming-window-leave-value">${leaveLabel}</span>${uncertainty}
        </div>
      </div>
      <div class="upcoming-window-meta">
        <span>${formatMoney(metrics.profitPerHour)}/hr projected</span>
        <span class="upcoming-window-sep">&middot;</span>
        <span>${metrics.effectiveSlots} units @ ${metrics.marginPct.toFixed(0)}%</span>
        <span class="upcoming-window-sep">&middot;</span>
        <span>${formatFlightTime(metrics.roundTripMins)} RT</span>
        ${othersNote}
      </div>
      <a href="https://www.torn.com/page.php?sid=travel" target="_blank" rel="noopener"
         class="upcoming-window-cta">Travel &rarr;</a>
    </div>
  `;
}

function renderBestRunCard(rows) {
  const container = document.getElementById('best-run-container');
  if (!container) return;

  // Candidate 1: best travel run (positive margin, live price, stock).
  const travelCandidates = rows.filter(r =>
    r.metrics &&
    r.metrics.marginPerItem > 0 &&
    r.metrics.effectiveSlots > 0
  );
  const bestTravel = travelCandidates.length > 0
    ? travelCandidates.slice().sort(
        (a, b) => (b.metrics.profitPerHour || 0) - (a.metrics.profitPerHour || 0)
      )[0]
    : null;

  // Candidate 2: verified bazaar deal from main.js background search.
  const bestBazaar = buildBazaarRun(bestBazaarRun);

  // Pick the winner by profit/hr. A bazaar deal almost always wins on rate
  // (short nominal time) — that's correct. It's a "grab it now" opportunity.
  let winner = null;
  if (bestTravel && bestBazaar) {
    winner = bestBazaar.metrics.profitPerHour > bestTravel.metrics.profitPerHour
      ? bestBazaar
      : bestTravel;
  } else {
    winner = bestBazaar || bestTravel;
  }

  if (!winner) {
    container.innerHTML = '';
    return;
  }

  if (winner.type === 'bazaar') {
    renderBazaarBestRun(container, winner);
  } else {
    renderTravelBestRun(container, winner);
  }
}

function renderTravelBestRun(container, best) {
  const stockNote = best.metrics.stockLimited
    ? `<span class="best-run-stock" title="Only ${best.metrics.effectiveSlots} units in stock">stock: ${best.metrics.effectiveSlots}</span>`
    : '';

  container.innerHTML = `
    <div class="best-run-card best-run-card--travel">
      <div class="best-run-label">Best Run Right Now</div>
      <div class="best-run-body">
        <div class="best-run-item">
          <span class="best-run-name">${best.name}</span>
          <span class="best-run-dest">&rarr; ${best.destination}</span>
        </div>
        <div class="best-run-rate">
          <span class="best-run-rate-value">${formatMoney(best.metrics.profitPerHour)}</span>
          <span class="best-run-rate-unit">/hr</span>
        </div>
      </div>
      <div class="best-run-meta">
        <span>${formatMoney(best.metrics.profitPerRun)} per run</span>
        <span class="best-run-sep">&middot;</span>
        <span>${formatFlightTime(best.metrics.roundTripMins)}</span>
        <span class="best-run-sep">&middot;</span>
        <span>${best.metrics.marginPct.toFixed(0)}% margin</span>
        ${stockNote ? `<span class="best-run-sep">&middot;</span>${stockNote}` : ''}
      </div>
      <a href="https://www.torn.com/page.php?sid=travel" target="_blank" rel="noopener"
         class="best-run-cta">Travel &rarr;</a>
    </div>
  `;
}

function renderBazaarBestRun(container, best) {
  const bazaarUrl = `https://www.torn.com/bazaar.php?userId=${best.bazaarOwnerId}#/`;
  const qtyNote = best.metrics.stockLimited
    ? `<span class="best-run-stock" title="Bazaar has ${best.metrics.effectiveSlots} unit(s) available">qty: ${best.metrics.effectiveSlots}</span>`
    : `<span>qty: ${best.metrics.effectiveSlots}</span>`;

  // Liquidity badge — same visual language as the table rows, so the
  // user can see at a glance whether this bazaar deal is on a fast-moving
  // item (drugs) or one that's going to sit on their market for an hour.
  // In Ideal mode we hide it since sell-time is zero by design.
  const badge = realismMode === 'ideal' ? null : getLiquidityBadge(best.category);
  const liquidityNote = badge
    ? `<span class="best-run-sep">&middot;</span><span class="liquidity liquidity--${badge.level}" title="${badge.title}">${badge.label}</span>`
    : '';

  container.innerHTML = `
    <div class="best-run-card best-run-card--bazaar">
      <div class="best-run-label">
        Best Run Right Now
        <span class="best-run-badge" title="Live-verified bazaar listing — act fast">&#x26A1; Bazaar</span>
      </div>
      <div class="best-run-body">
        <div class="best-run-item">
          <span class="best-run-name">${best.name}</span>
          <span class="best-run-dest">from bazaar</span>
        </div>
        <div class="best-run-rate">
          <span class="best-run-rate-value">${formatMoney(best.metrics.profitPerHour)}</span>
          <span class="best-run-rate-unit">/hr</span>
        </div>
      </div>
      <div class="best-run-meta">
        <span>${formatMoney(best.metrics.profitPerRun)} total profit</span>
        <span class="best-run-sep">&middot;</span>
        ${qtyNote}
        <span class="best-run-sep">&middot;</span>
        <span>${best.metrics.marginPct.toFixed(0)}% off market</span>
        ${liquidityNote}
      </div>
      <a href="${bazaarUrl}" target="_blank" rel="noopener"
         class="best-run-cta best-run-cta--bazaar">Go to Bazaar &rarr;</a>
    </div>
  `;
}

/**
 * Render (or re-render) the arbitrage table.
 */
export function renderTable() {
  const tbody = document.getElementById('arb-tbody');
  if (!tbody) return;

  updateHeaderSort();

  const rows = buildRows();
  renderUpcomingWindowCard(rows);
  renderBestRunCard(rows);

  if (rows.length === 0) {
    const hasFilters = filterDestination !== 'all' || filterCategory !== 'all';
    const msg = hasFilters
      ? 'No items match your current filters.'
      : 'No abroad price data yet. Log in after your next trip to populate prices automatically.';
    tbody.innerHTML = `<tr><td colspan="${COL_COUNT}" class="empty-msg">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r, i) => {
    const isNeg = r.metrics && r.metrics.marginPerItem <= 0;
    const rowClass = isNeg ? 'row--negative' : '';

    // Buy price cell with freshness indicator. First-party scrapes (from a
    // PDA userscript landing in a shop in the last ~10 min) always trump
    // age-based freshness tiers — they're authoritative by origin, not age.
    let freshnessBadge;
    if (r.priceSource === 'scrape') {
      freshnessBadge = `<span class="freshness freshness--scrape" title="First-party scrape from Torn travel shop — ${r.reportedAgo}">&#9679; LIVE</span>`;
    } else if (r.freshness === 'fresh') {
      freshnessBadge = `<span class="freshness freshness--fresh" title="Fresh price — reported ${r.reportedAgo}">&#9679; ${r.reportedAgo}</span>`;
    } else if (r.freshness === 'medium') {
      freshnessBadge = `<span class="freshness freshness--medium" title="Price is ${r.reportedAgo} — still usable but may have changed">&#9679; ${r.reportedAgo}</span>`;
    } else if (r.freshness === 'stale') {
      freshnessBadge = `<span class="freshness freshness--stale" title="Price is ${r.reportedAgo} — likely outdated. Open the app after your next trip to update.">&#9679; old</span>`;
    } else {
      freshnessBadge = `<span class="freshness freshness--empty" title="No price data yet. Buy this item abroad to contribute a price.">&#9675; no data</span>`;
    }
    const buyCell = `${formatMoney(r.buyPrice)} ${freshnessBadge}`;

    // Stock cell: "Now X" + projected "ETA Y" when we have history.
    const stockCell = renderStockCell(r);

    // Sell price cell — show net price (after 5% item market fee) so math is visible.
    // Tooltip carries market-depth context (floor qty / listing count) when we
    // have it, so players can sanity-check whether the floor price is fragile
    // (1 unit listed) or well-supported (dozens of listings at this price).
    const noListings = r.isChecked && !r.hasSellPrice;
    const netSell = r.hasSellPrice ? r.sellPrice * 0.95 : null;
    const depthTitle = formatDepthTooltip(r.depth);
    const sellInner = netSell != null
      ? formatMoney(netSell)
      : noListings
        ? '<span class="muted">no listings</span>'
        : '<span class="shimmer-cell"></span>';
    const sellBase = depthTitle
      ? `<span title="${depthTitle}">${sellInner}</span>`
      : sellInner;
    // Dot-only freshness indicator for the sell price — keeps the column
    // narrow. Only rendered when we actually have a price (not for "no
    // listings" or shimmering rows).
    const sellFreshClass = r.hasSellPrice ? getSellPriceFreshnessClass(r.itemId) : null;
    const sellFreshDot = sellFreshClass
      ? ` <span class="freshness freshness--${sellFreshClass} freshness--dot" title="${formatSellAgeTooltip(r.itemId)}">&#9679;</span>`
      : '';
    const sellCell = `${sellBase}${sellFreshDot}`;

    // Metric cells
    const dash = '<span class="muted">—</span>';
    const marginCell = r.metrics ? formatMoney(r.metrics.marginPerItem) : (noListings ? dash : '<span class="shimmer-cell"></span>');

    // Run cost cell — add a stock-limited badge when the run can't be filled
    // because the destination doesn't carry enough stock.
    let runCostCell;
    if (r.metrics) {
      const base = formatMoney(r.metrics.runCost);
      runCostCell = r.metrics.stockLimited
        // Drop the "/29" — the configured slot count is already shown in
        // the Slots input at the top of the page, so repeating it on every
        // row was noise. The warning icon plus the fillable number alone
        // communicates the constraint.
        ? `${base} <span class="stock-limited" title="Limited by available stock — only ${r.metrics.effectiveSlots} of ${slotCount} slots fillable">&#9888;${r.metrics.effectiveSlots}</span>`
        : base;
    } else {
      runCostCell = noListings ? dash : '<span class="shimmer-cell"></span>';
    }
    const runCell = r.metrics ? formatMoney(r.metrics.profitPerRun) : (noListings ? dash : '<span class="shimmer-cell"></span>');
    // Profit/hr cell — in Realistic mode include the liquidity assumption
    // as a small trailing badge so the user can see why a drug row "beats"
    // an artifact row that has nominally higher margin. The sell-time is
    // already baked into the hourly number; the badge just makes the
    // assumption visible. In Ideal mode the sell-time is zero by design,
    // so the badge would be misleading.
    let hrCell;
    if (r.metrics) {
      if (realismMode === 'ideal') {
        hrCell = formatMoney(r.metrics.profitPerHour);
      } else {
        const badge = getLiquidityBadge(r.category);
        hrCell = `${formatMoney(r.metrics.profitPerHour)} <span class="liquidity liquidity--${badge.level}" title="${badge.title}">${badge.label}</span>`;
      }
    } else {
      hrCell = noListings ? dash : '<span class="shimmer-cell"></span>';
    }
    const flightCell = r.metrics
      ? formatFlightTime(r.metrics.roundTripMins)
      : (r.flightMins > 0 ? formatFlightTime(r.flightMins * 2) : '—');

    return `
      <tr class="${rowClass}">
        <td class="col-rank">${i + 1}</td>
        <td class="col-item">${r.name}</td>
        <td class="col-dest">${renderDestCell(r.destination)}</td>
        <td class="col-stock">${stockCell}</td>
        <td class="col-buy">${buyCell}</td>
        <td class="col-sell">${sellCell}</td>
        <td class="col-margin">${marginCell}</td>
        <td class="col-runcost">${r.metrics ? `<a href="https://www.torn.com/page.php?sid=stocks" target="_blank" rel="noopener" class="runcost-link" title="Stock Market">💰</a> ` : ''}${runCostCell}</td>
        <td class="col-run">${runCell}</td>
        <td class="col-hr">${hrCell}</td>
        <td class="col-flight">${flightCell}</td>
      </tr>
    `;
  }).join('');
}

/**
 * Render the table shell with sortable headers and shimmer rows.
 */
export function renderShimmerTable(container) {
  const headerCells = COLUMNS.map(col => {
    if (!col.key) {
      return `<th class="${col.css}">${col.label}</th>`;
    }
    const isActive = sortCol === col.key;
    const arrow = isActive ? (sortDir === 'desc' ? ' \u25BE' : ' \u25B4') : '';
    const activeClass = isActive ? ' th--sorted' : '';
    return `<th class="${col.css} th--sortable${activeClass}" data-sort="${col.key}">${col.label}${arrow}</th>`;
  }).join('\n          ');

  container.innerHTML = `
    <table class="arb-table">
      <thead>
        <tr>
          ${headerCells}
        </tr>
      </thead>
      <tbody id="arb-tbody">
        ${Array.from({ length: 10 }, (_, i) => `
          <tr>
            <td class="col-rank">${i + 1}</td>
            ${Array.from({ length: COL_COUNT - 1 }, () => '<td><span class="shimmer-cell"></span></td>').join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  attachSortHandlers();
}
