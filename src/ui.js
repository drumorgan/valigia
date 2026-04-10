// UI module — table rendering, controls, shimmer loading, toast notifications.
// Data-driven from Supabase abroad_prices — not limited to a static item list.

import { getFlightMins } from './data/destinations.js';
import { calculateMargins, formatFlightTime, formatMoney, formatPct } from './calculator.js';

// ── State ──────────────────────────────────────────────────────
const STORAGE_SLOTS = 'valigia_slots';
const STORAGE_AIRSTRIP = 'valigia_airstrip';
const STORAGE_SORT = 'valigia_sort';

let slotCount = parseInt(localStorage.getItem(STORAGE_SLOTS)) || 29;
let hasAirstrip = localStorage.getItem(STORAGE_AIRSTRIP) === 'true';
let sortBy = localStorage.getItem(STORAGE_SORT) || 'profitPerHour';

// Live data — populated as prices arrive
const sellPrices = new Map();   // itemId → sell price
let knownItems = [];            // Array of { item_id, item_name, destination, buy_price, reported_at }

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

// ── Data ───────────────────────────────────────────────────────

/**
 * Set the known items from Supabase abroad_prices rows.
 * This is the primary data source — every item any player ever bought abroad.
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
  sellPrices.set(itemId, price);
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

/**
 * Build sorted row data from Supabase items + live sell prices.
 */
function buildRows() {
  const rows = [];

  for (const item of knownItems) {
    if (!item.item_id) continue;

    const flightMins = getFlightMins(item.destination);
    const { price: buyPrice, freshness, reportedAgo } = getBuyPriceInfo(item);
    const sellPrice = sellPrices.get(item.item_id);
    const hasSellPrice = sellPrice != null;

    let metrics = null;
    if (hasSellPrice && flightMins > 0) {
      metrics = calculateMargins({
        buyPrice,
        sellPrice,
        slotCount,
        flightMins,
        hasAirstrip,
      });
    }

    rows.push({
      name: item.item_name,
      destination: item.destination,
      itemId: item.item_id,
      buyPrice,
      freshness,
      reportedAgo,
      sellPrice,
      hasSellPrice,
      metrics,
      flightMins,
    });
  }

  // Sort: negative margins to bottom, then by selected column descending
  rows.sort((a, b) => {
    const aNeg = a.metrics && a.metrics.marginPerItem <= 0;
    const bNeg = b.metrics && b.metrics.marginPerItem <= 0;
    if (aNeg && !bNeg) return 1;
    if (!aNeg && bNeg) return -1;

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

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="10" class="empty-msg">
        No abroad price data yet. Log in after your next trip to populate prices automatically.
      </td></tr>
    `;
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

    // Sell price cell
    const sellCell = r.hasSellPrice
      ? formatMoney(r.sellPrice)
      : '<span class="shimmer-cell"></span>';

    // Metric cells
    const marginCell = r.metrics ? formatMoney(r.metrics.marginPerItem) : '<span class="shimmer-cell"></span>';
    const pctCell = r.metrics ? formatPct(r.metrics.marginPct) : '<span class="shimmer-cell"></span>';
    const runCell = r.metrics ? formatMoney(r.metrics.profitPerRun) : '<span class="shimmer-cell"></span>';
    const hrCell = r.metrics ? formatMoney(r.metrics.profitPerHour) : '<span class="shimmer-cell"></span>';
    const flightCell = r.metrics
      ? formatFlightTime(r.metrics.roundTripMins)
      : (r.flightMins > 0 ? formatFlightTime(r.flightMins * 2) : '—');

    return `
      <tr class="${rowClass}">
        <td class="col-rank">${i + 1}</td>
        <td class="col-item">${r.name}</td>
        <td class="col-dest">${r.destination}</td>
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
 * Render the table shell with shimmer rows.
 */
export function renderShimmerTable(container) {
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
        ${Array.from({ length: 10 }, (_, i) => `
          <tr>
            <td class="col-rank">${i + 1}</td>
            ${Array.from({ length: 9 }, () => '<td><span class="shimmer-cell"></span></td>').join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}
