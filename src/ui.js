// UI module — table rendering, controls, shimmer loading, toast notifications.

import { getFlightMins } from './data/destinations.js';
import { DESTINATIONS } from './data/destinations.js';
import { getItemTypeById } from './item-resolver.js';
import { calculateMargins, formatFlightTime, formatMoney } from './calculator.js';

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

let slotCount = parseInt(localStorage.getItem(STORAGE_SLOTS)) || 29;
let flightType = localStorage.getItem(STORAGE_FLIGHT_TYPE) || 'standard';
let sortCol = localStorage.getItem(STORAGE_SORT_COL) || 'profitPerHour';
let sortDir = localStorage.getItem(STORAGE_SORT_DIR) || 'desc';
let filterDestination = localStorage.getItem(STORAGE_FILTER_DEST) || 'all';
let filterCategory = localStorage.getItem(STORAGE_FILTER_CAT) || 'all';

// Live data — populated as prices arrive
const sellPrices = new Map();   // itemId → sell price
const checkedItems = new Set();  // itemIds where sell price has been looked up
let knownItems = [];            // Array of { item_id, item_name, destination, buy_price, reported_at, quantity }

// ── Column definitions for sortable headers ───────────────────
const COLUMNS = [
  { key: null,            label: '#',           css: 'col-rank' },
  { key: 'name',          label: 'Item',        css: 'col-item' },
  { key: 'destination',   label: 'Dest',        css: 'col-dest' },
  { key: 'quantity',      label: 'Stock',       css: 'col-stock' },
  { key: 'buyPrice',      label: 'Buy',         css: 'col-buy' },
  { key: 'sellPrice',     label: 'Sell',        css: 'col-sell' },
  { key: 'marginPerItem', label: 'Margin',      css: 'col-margin' },
  { key: 'runCost',       label: 'Run Cost',    css: 'col-runcost' },
  { key: 'profitPerRun',  label: 'Profit/Run',  css: 'col-run' },
  { key: 'profitPerHour', label: 'Profit/hr',   css: 'col-hr' },
  { key: 'flightMins',    label: 'Flight',      css: 'col-flight' },
];

const COL_COUNT = COLUMNS.length;

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
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      filterCategory = btn.dataset.cat;
      persistFilters();
      // Update active state visually
      container.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('filter-chip--active'));
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
    case 'quantity':      return row.quantity ?? -1;
    case 'buyPrice':      return row.buyPrice || 0;
    case 'sellPrice':     return row.sellPrice || 0;
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

    let metrics = null;
    if (hasSellPrice && flightMins > 0) {
      metrics = calculateMargins({
        buyPrice,
        sellPrice,
        slotCount,
        flightMins,
        flightMultiplier: getFlightMultiplier(),
      });
    }

    rows.push({
      name: item.item_name,
      destination: item.destination,
      itemId: item.item_id,
      quantity: item.quantity ?? null,
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
 * Render (or re-render) the arbitrage table.
 */
export function renderTable() {
  const tbody = document.getElementById('arb-tbody');
  if (!tbody) return;

  updateHeaderSort();

  const rows = buildRows();

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

    // Stock cell
    const stockCell = formatQuantity(r.quantity);

    // Sell price cell
    const noListings = r.isChecked && !r.hasSellPrice;
    const sellCell = r.hasSellPrice
      ? formatMoney(r.sellPrice)
      : noListings
        ? '<span class="muted">no listings</span>'
        : '<span class="shimmer-cell"></span>';

    // Metric cells
    const dash = '<span class="muted">—</span>';
    const marginCell = r.metrics ? formatMoney(r.metrics.marginPerItem) : (noListings ? dash : '<span class="shimmer-cell"></span>');

    const runCostCell = r.metrics ? formatMoney(r.metrics.runCost) : (noListings ? dash : '<span class="shimmer-cell"></span>');
    const runCell = r.metrics ? formatMoney(r.metrics.profitPerRun) : (noListings ? dash : '<span class="shimmer-cell"></span>');
    const hrCell = r.metrics ? formatMoney(r.metrics.profitPerHour) : (noListings ? dash : '<span class="shimmer-cell"></span>');
    const flightCell = r.metrics
      ? formatFlightTime(r.metrics.roundTripMins)
      : (r.flightMins > 0 ? formatFlightTime(r.flightMins * 2) : '—');

    return `
      <tr class="${rowClass}">
        <td class="col-rank">${i + 1}</td>
        <td class="col-item">${r.name}</td>
        <td class="col-dest">${r.destination}</td>
        <td class="col-stock">${stockCell}</td>
        <td class="col-buy">${buyCell}</td>
        <td class="col-sell">${sellCell}</td>
        <td class="col-margin">${marginCell}</td>
        <td class="col-runcost">${runCostCell}</td>
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
