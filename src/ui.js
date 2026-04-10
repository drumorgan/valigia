// UI module — table rendering, controls, shimmer loading, toast notifications.

import { ABROAD_ITEMS } from './data/abroad-items.js';
import { calculateMargins, formatFlightTime, formatMoney, formatPct } from './calculator.js';

// ── State ──────────────────────────────────────────────────────
const STORAGE_SLOTS = 'valigia_slots';
const STORAGE_AIRSTRIP = 'valigia_airstrip';
const STORAGE_SORT = 'valigia_sort';

let slotCount = parseInt(localStorage.getItem(STORAGE_SLOTS)) || 29;
let hasAirstrip = localStorage.getItem(STORAGE_AIRSTRIP) === 'true';
let sortBy = localStorage.getItem(STORAGE_SORT) || 'profitPerHour';

// Live data maps — populated as prices arrive
const sellPrices = new Map();   // itemId → sell price
const buyPrices = new Map();    // "itemId-destination" → { price, reportedAt }

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
  localStorage.setItem(STORAGE_AIRSTRIP, String(hasAirstrip));
  localStorage.setItem(STORAGE_SORT, sortBy);
}

/**
 * Render controls bar into container. Calls onChange when any value changes.
 */
export function renderControls(container, onChange) {
  container.innerHTML = `
    <div class="controls">
      <label class="control-group">
        <span class="control-label">Slots</span>
        <input type="number" id="ctl-slots" class="control-input"
               value="${slotCount}" min="5" max="44" />
      </label>
      <label class="control-group control-group--check">
        <input type="checkbox" id="ctl-airstrip" ${hasAirstrip ? 'checked' : ''} />
        <span class="control-label">Airstrip</span>
      </label>
      <label class="control-group">
        <span class="control-label">Sort</span>
        <select id="ctl-sort" class="control-select">
          <option value="profitPerHour" ${sortBy === 'profitPerHour' ? 'selected' : ''}>Profit/Hour</option>
          <option value="profitPerRun" ${sortBy === 'profitPerRun' ? 'selected' : ''}>Profit/Run</option>
          <option value="marginPct" ${sortBy === 'marginPct' ? 'selected' : ''}>Margin %</option>
        </select>
      </label>
    </div>
  `;

  container.querySelector('#ctl-slots').addEventListener('input', (e) => {
    slotCount = Math.max(5, Math.min(44, parseInt(e.target.value) || 29));
    persistControls();
    onChange();
  });
  container.querySelector('#ctl-airstrip').addEventListener('change', (e) => {
    hasAirstrip = e.target.checked;
    persistControls();
    onChange();
  });
  container.querySelector('#ctl-sort').addEventListener('change', (e) => {
    sortBy = e.target.value;
    persistControls();
    onChange();
  });
}

// ── Table ──────────────────────────────────────────────────────

/**
 * Set crowd-sourced buy prices from Supabase data.
 * @param {Array} rows - rows from abroad_prices table
 */
export function setBuyPrices(rows) {
  for (const row of rows) {
    const key = `${row.item_id}-${row.destination}`;
    buyPrices.set(key, { price: row.buy_price, reportedAt: new Date(row.reported_at) });
  }
}

/**
 * Called as each sell price resolves from the market fetcher.
 */
export function onSellPrice(itemId, price) {
  sellPrices.set(itemId, price);
  renderTable();
}

/**
 * Get the effective buy price for an item, respecting staleness windows.
 * Returns { price, isStale, reportedAgo }
 */
function getEffectiveBuyPrice(item) {
  const key = `${item.itemId}-${item.destination}`;
  const stored = buyPrices.get(key);

  if (!stored) {
    return { price: item.buyPriceFallback, isStale: true, reportedAgo: null };
  }

  const ageMs = Date.now() - stored.reportedAt.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // Drugs/contraband: 2h window; plushies/flowers: 4h window
  const isDrugOrTemp = item.type === 'drug' || item.type === 'temp';
  const maxAge = isDrugOrTemp ? 2 : 4;

  if (ageHours > maxAge) {
    return { price: item.buyPriceFallback, isStale: true, reportedAgo: null };
  }

  const reportedAgo = formatTimeAgo(ageMs);
  return { price: stored.price, isStale: false, reportedAgo };
}

function formatTimeAgo(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m ago`;
}

/**
 * Build sorted row data for all renderable items.
 */
function buildRows() {
  const rows = [];

  for (const item of ABROAD_ITEMS) {
    if (item.itemId == null) continue;

    const { price: buyPrice, isStale, reportedAgo } = getEffectiveBuyPrice(item);
    const sellPrice = sellPrices.get(item.itemId);
    const hasSellPrice = sellPrice != null;

    let metrics = null;
    if (hasSellPrice) {
      metrics = calculateMargins({
        buyPrice,
        sellPrice,
        slotCount,
        flightMins: item.flightMins,
        hasAirstrip,
      });
    }

    rows.push({
      item,
      buyPrice,
      isStale,
      reportedAgo,
      sellPrice,
      hasSellPrice,
      metrics,
    });
  }

  // Sort: negative margins to bottom, then by selected column descending
  rows.sort((a, b) => {
    const aNeg = a.metrics && a.metrics.marginPerItem <= 0;
    const bNeg = b.metrics && b.metrics.marginPerItem <= 0;
    if (aNeg && !bNeg) return 1;
    if (!aNeg && bNeg) return -1;

    // Items still loading go between positive and negative
    if (!a.hasSellPrice && b.hasSellPrice) return 1;
    if (a.hasSellPrice && !b.hasSellPrice) return -1;

    if (!a.metrics || !b.metrics) return 0;

    return (b.metrics[sortBy] || 0) - (a.metrics[sortBy] || 0);
  });

  return rows;
}

/**
 * Render (or re-render) the arbitrage table.
 */
export function renderTable() {
  const tbody = document.getElementById('arb-tbody');
  if (!tbody) return;

  const rows = buildRows();

  tbody.innerHTML = rows.map((r, i) => {
    const { item, buyPrice, isStale, reportedAgo, sellPrice, hasSellPrice, metrics } = r;
    const isNeg = metrics && metrics.marginPerItem <= 0;
    const rowClass = isNeg ? 'row--negative' : '';

    // Buy price cell
    const staleBadge = isStale
      ? `<span class="badge-stale" title="No recent report — using community average. Open the app after your next trip to update.">&#9888; est.</span>`
      : `<span class="badge-fresh">${reportedAgo}</span>`;
    const buyCell = `${formatMoney(buyPrice)} ${staleBadge}`;

    // Sell price cell — shimmer if not loaded
    const sellCell = hasSellPrice
      ? formatMoney(sellPrice)
      : '<span class="shimmer-cell"></span>';

    // Metric cells
    const marginCell = metrics ? formatMoney(metrics.marginPerItem) : '<span class="shimmer-cell"></span>';
    const pctCell = metrics ? formatPct(metrics.marginPct) : '<span class="shimmer-cell"></span>';
    const runCell = metrics ? formatMoney(metrics.profitPerRun) : '<span class="shimmer-cell"></span>';
    const hrCell = metrics ? formatMoney(metrics.profitPerHour) : '<span class="shimmer-cell"></span>';
    const flightCell = metrics ? formatFlightTime(metrics.roundTripMins) : '<span class="shimmer-cell"></span>';

    return `
      <tr class="${rowClass}">
        <td class="col-rank">${i + 1}</td>
        <td class="col-item">${item.name}</td>
        <td class="col-dest">${item.destination}</td>
        <td class="col-buy">${buyCell}</td>
        <td class="col-sell">${sellCell}</td>
        <td class="col-margin">${marginCell}</td>
        <td class="col-pct">${pctCell}</td>
        <td class="col-run">${runCell}</td>
        <td class="col-hr">${hrCell}</td>
        <td class="col-flight">${flightCell}</td>
      </tr>
    `;
  }).join('');
}

/**
 * Render the initial shimmer-only table (before any data loads).
 */
export function renderShimmerTable(container) {
  const renderableCount = ABROAD_ITEMS.filter((i) => i.itemId != null).length;

  container.innerHTML = `
    <table class="arb-table">
      <thead>
        <tr>
          <th class="col-rank">#</th>
          <th class="col-item">Item</th>
          <th class="col-dest">Destination</th>
          <th class="col-buy">Buy Price</th>
          <th class="col-sell">Sell Price</th>
          <th class="col-margin">Margin $</th>
          <th class="col-pct">Margin %</th>
          <th class="col-run">Profit/Run</th>
          <th class="col-hr">Profit/hr</th>
          <th class="col-flight">Flight</th>
        </tr>
      </thead>
      <tbody id="arb-tbody">
        ${Array.from({ length: renderableCount }, (_, i) => `
          <tr>
            <td class="col-rank">${i + 1}</td>
            ${Array.from({ length: 9 }, () => '<td><span class="shimmer-cell"></span></td>').join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}
