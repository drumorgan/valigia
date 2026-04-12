// UI module — table rendering, controls, shimmer loading, toast notifications.

import { getFlightMins, getDestinationBadge } from './data/destinations.js';
import { DESTINATIONS } from './data/destinations.js';
import { getItemTypeById } from './item-resolver.js';
import { calculateMargins, formatFlightTime, formatMoney } from './calculator.js';
import { forecastStock } from './stock-forecast.js';
import { getSellTimeMins, getLiquidityBadge } from './data/liquidity.js';

// ── Flight type definitions ───────────────────────────────────
const FLIGHT_TYPES = [
  { value: 'standard',     label: 'Standard',       multiplier: 1.0 },
  { value: 'airstrip',     label: 'Airstrip',        multiplier: 0.7 },
  { value: 'wlt',          label: 'WLT',             multiplier: 0.7 },
  { value: 'airstrip_wlt', label: 'Airstrip + WLT',  multiplier: 0.49 },
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
const checkedItems = new Set();  // itemIds where sell price has been looked up
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

export function renderControls(container, onChange) {
  const destinations = getAvailableDestinations();
  const destOptions = destinations.map(d =>
    `<option value="${d}" ${filterDestination === d ? 'selected' : ''}>${d}</option>`
  ).join('');

  const flightOptions = FLIGHT_TYPES.map(ft =>
    `<option value="${ft.value}" ${flightType === ft.value ? 'selected' : ''}>${ft.label}</option>`
  ).join('');

  container.innerHTML = `
    <div class="controls">
      <label class="control-group">
        <span class="control-label">Slots</span>
        <input type="number" id="ctl-slots" class="control-input"
               value="${slotCount}" min="5" max="44" />
      </label>
      <label class="control-group">
        <span class="control-label">Flight</span>
        <select id="ctl-flight-type" class="control-select">
          ${flightOptions}
        </select>
      </label>
      <label class="control-group">
        <span class="control-label">Destination</span>
        <select id="ctl-destination" class="control-select">
          <option value="all" ${filterDestination === 'all' ? 'selected' : ''}>All</option>
          ${destOptions}
        </select>
      </label>
      <div class="control-group filter-chips">
        <span class="control-label">Type</span>
        <button class="filter-chip ${filterCategory === 'all' ? 'filter-chip--active' : ''}" data-cat="all">All</button>
        <button class="filter-chip ${filterCategory === 'drug' ? 'filter-chip--active' : ''}" data-cat="drug">Drugs</button>
        <button class="filter-chip ${filterCategory === 'plushie' ? 'filter-chip--active' : ''}" data-cat="plushie">Plushies</button>
        <button class="filter-chip ${filterCategory === 'flower' ? 'filter-chip--active' : ''}" data-cat="flower">Flowers</button>
        <button class="filter-chip ${filterCategory === 'artifact' ? 'filter-chip--active' : ''}" data-cat="artifact">Artifacts</button>
      </div>
      <div class="control-group filter-chips" title="Realistic: clamp slots to arrival-stock forecast and add sell-time to profit/hr. Ideal: assume full slots and instant liquidation.">
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
    persistControls();
    onChange();
  });
  container.querySelector('#ctl-destination').addEventListener('change', (e) => {
    filterDestination = e.target.value;
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
 */
export function onSellPrice(itemId, price) {
  if (price != null) sellPrices.set(itemId, price);
  checkedItems.add(itemId);
  renderTable();
}

// ── Table helpers ──────────────────────────────────────────────

function formatTimeAgo(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m ago`;
}

function formatDaysAgo(ms) {
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function formatQuantity(qty) {
  if (qty == null) return '<span class="muted">—</span>';
  return Number(qty).toLocaleString('en-US');
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

  // When ETA materially differs from now, flag it. "Likely empty" replaces
  // the number entirely so the user reads the verdict, not a hopeful "1".
  let etaLine;
  if (eta === 0 && now > 0) {
    etaLine = `<span class="stock-eta stock-eta--empty" title="Recent depletion rate projects the shelf to be empty when you land">likely empty</span>`;
  } else {
    const confClass = f.confidence === 'ok' ? 'stock-eta--ok' : 'stock-eta--low';
    const confTitle = f.confidence === 'ok'
      ? 'Projected from recent depletion rate'
      : 'Limited history — rough estimate';
    etaLine = `<span class="stock-eta ${confClass}" title="${confTitle}">ETA ~${Number(eta).toLocaleString('en-US')}</span>`;
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
      sellPrice,
      hasSellPrice,
      isChecked,
      metrics,
      flightMins,
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
 * runs. Uses a nominal transaction time so profit/hr is comparable.
 * Returns null if the deal can't produce any profit at the current slot count.
 */
function buildBazaarRun(deal) {
  if (!deal) return null;
  const effectiveSlots = Math.min(slotCount, deal.bazaarQty);
  if (effectiveSlots <= 0) return null;

  const profitPerRun = deal.savings * effectiveSlots; // savings is already post-5%-fee
  if (profitPerRun <= 0) return null;

  const roundTripMins = BAZAAR_NOMINAL_TRANSACTION_MINS;
  const profitPerHour = (profitPerRun / roundTripMins) * 60;

  return {
    type: 'bazaar',
    name: deal.itemName,
    bazaarOwnerId: deal.bazaarOwnerId,
    metrics: {
      profitPerRun,
      profitPerHour,
      marginPct: deal.savingsPct,
      effectiveSlots,
      stockLimited: effectiveSlots < slotCount,
      roundTripMins,
    },
  };
}

/**
 * Pick the single best actionable run (travel OR bazaar) and render a
 * summary card above the table. Both are normalized to profit/hr for
 * comparison; the winner is shown in its own visual variant.
 */
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

    // Buy price cell with freshness indicator
    let freshnessBadge;
    if (r.freshness === 'fresh') {
      freshnessBadge = `<span class="freshness freshness--fresh" title="Fresh price — reported ${r.reportedAgo}">&#9679; ${r.reportedAgo}</span>`;
    } else if (r.freshness === 'medium') {
      freshnessBadge = `<span class="freshness freshness--medium" title="Price is ${r.reportedAgo} — still usable but may have changed">&#9679; ${r.reportedAgo}</span>`;
    } else if (r.freshness === 'stale') {
      freshnessBadge = `<span class="freshness freshness--stale" title="Price is ${r.reportedAgo} — likely outdated. Open the app after your next trip to update.">&#9679; old</span>`;
    } else {
      freshnessBadge = `<span class="freshness freshness--empty" title="No price data yet. Buy this item abroad to contribute a price.">&#9675; no data</span>`;
    }
    const buyCell = `${formatMoney(r.buyPrice)} ${freshnessBadge}`;

    // Stock cell: "Now X" + projected "ETA ~Y" when we have history.
    const stockCell = renderStockCell(r);

    // Sell price cell — show net price (after 5% item market fee) so math is visible
    const noListings = r.isChecked && !r.hasSellPrice;
    const netSell = r.hasSellPrice ? r.sellPrice * 0.95 : null;
    const sellCell = netSell != null
      ? formatMoney(netSell)
      : noListings
        ? '<span class="muted">no listings</span>'
        : '<span class="shimmer-cell"></span>';

    // Metric cells
    const dash = '<span class="muted">—</span>';
    const marginCell = r.metrics ? formatMoney(r.metrics.marginPerItem) : (noListings ? dash : '<span class="shimmer-cell"></span>');

    // Run cost cell — add a stock-limited badge when the run can't be filled
    // because the destination doesn't carry enough stock.
    let runCostCell;
    if (r.metrics) {
      const base = formatMoney(r.metrics.runCost);
      runCostCell = r.metrics.stockLimited
        ? `${base} <span class="stock-limited" title="Limited by available stock — only ${r.metrics.effectiveSlots} of ${slotCount} slots fillable">&#9888; ${r.metrics.effectiveSlots}/${slotCount}</span>`
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
