// Valigia — entry point & orchestrator

import { callTornApi } from './torn-api.js';
import { tryAutoLogin, renderLoginScreen, logout } from './auth.js';
import { fetchAbroadPrices } from './log-sync.js';
import { fetchAllSellPrices, refreshSellPrices } from './market.js';
import { resolveItemIds } from './item-resolver.js';
import { renderScanButton, renderCommunityStats } from './bazaar-ui.js';
import { prescanBazaarPool, findBestBazaarRun } from './bazaar-scanner.js';
import { recordSnapshots, loadForecastData } from './stock-forecast.js';
import {
  showToast, renderControls, renderShimmerTable, renderTable,
  setKnownItems, getItemIdsForPriceFetch, onSellPrice, setPlayerTravel,
  setBestBazaarRun, getStaleItemIdsForCategory
} from './ui.js';

// Category chip clicks top up any sell prices in that category older than
// this threshold. Kept short — the whole point is to surface fresh margins
// the moment a user narrows the view.
const CATEGORY_REFRESH_AGE_MS = 5 * 60 * 1000;

const screenContainer = document.getElementById('screen-container');
const headerEl = document.getElementById('app-header');

// When knownItems was last sourced from YATA. A live fetch sets this to
// Date.now(); a cached fetch preserves YATA's original timestamp so we
// re-attempt the live call as soon as the user engages a category filter.
let yataFetchedAt = 0;

// ── Boot ───────────────────────────────────────────────────────
async function boot() {
  const result = await tryAutoLogin();

  if (result.success) {
    showPlayerHeader(result.name, result.level);
    showToast(`Welcome back, ${result.name}!`, 'success');
    startDashboard(result.player_id);
  } else {
    showLoginScreen();
  }
}

// ── Login Screen ───────────────────────────────────────────────
function showLoginScreen() {
  clearPlayerHeader();
  renderLoginScreen(screenContainer, (result) => {
    showPlayerHeader(result.name, result.level);
    showToast(`Welcome, ${result.name}!`, 'success');
    startDashboard(result.player_id);
  });
}

// ── Perks Detection ───────────────────────────────────────────
/**
 * Fetch user perks and auto-detect travel slots and airstrip.
 * Gracefully no-ops if the key lacks perks permission.
 */
async function detectPlayerTravel(playerId) {
  const data = await callTornApi({
    section: 'user',
    selections: 'perks',
    player_id: playerId,
  });

  if (!data) return; // key may lack perks permission — silent fallback

  // Flatten all perk arrays into one list of strings
  const allPerks = [];
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) {
      allPerks.push(...data[key]);
    }
  }

  // Detect airstrip: look for "Airstrip" in any perk string
  const airstrip = allPerks.some(p => /airstrip/i.test(p));

  // Detect travel capacity: base 5, plus "+N travel item(s)" perks
  let slots = 5;
  const capacityRegex = /\+?(\d+)\s+travel\s+items?\b/i;
  for (const p of allPerks) {
    const match = p.match(capacityRegex);
    if (match) slots += parseInt(match[1], 10);
  }

  setPlayerTravel(slots, airstrip);
}

// ── Dashboard ──────────────────────────────────────────────────
async function startDashboard(playerId) {
  screenContainer.innerHTML = `
    <div id="controls-bar"></div>
    <div id="best-run-container"></div>
    <div id="table-container"></div>
    <div id="bazaar-container"></div>
  `;

  const controlsBar = document.getElementById('controls-bar');
  const tableContainer = document.getElementById('table-container');

  // Render controls + shimmer table
  renderControls(controlsBar, () => renderTable());
  renderShimmerTable(tableContainer);

  // Resolve item IDs (one-time Torn API call, cached in localStorage)
  await resolveItemIds(playerId);

  // Fetch abroad prices from YATA and detect travel perks in parallel
  const [priceResult] = await Promise.all([
    fetchAbroadPrices().catch(() => null),
    detectPlayerTravel(playerId).catch(() => {}),
  ]);

  if (!priceResult || priceResult.items.length === 0) {
    showToast('Could not fetch abroad prices from YATA. Try refreshing.', 'warning');
    tableContainer.innerHTML = `
      <div style="text-align:center;padding:3rem 1rem;font-family:'Syne Mono',monospace;">
        <p style="font-size:1.2rem;color:var(--accent);margin-bottom:0.5rem;">
          Loading prices\u2026
        </p>
        <p style="color:var(--muted);font-size:0.85rem;max-width:28rem;margin:0 auto;">
          Fetching abroad prices from the community feed.
          If this persists, try refreshing.
        </p>
      </div>
    `;
    return;
  }

  const { items, cached, cachedAt } = priceResult;
  yataFetchedAt = cached ? (cachedAt || 0) : Date.now();

  // If we fell back to cache, let the user know — the freshness badges on
  // each row tell the detailed story, but a single banner explains why
  // nothing is marked "fresh".
  if (cached) {
    renderYataOfflineBanner(tableContainer, cachedAt);
  }

  // Set items, re-render controls (populates destination dropdown), and render table
  setKnownItems(items);
  renderControls(controlsBar, () => renderTable(), (cat) => handleCategoryRefresh(cat, playerId));
  renderTable();

  // Kick off the stock-history pipeline in parallel with everything else.
  // recordSnapshots writes this visit's YATA reading into Supabase so future
  // visits can fit a depletion slope; loadForecastData pulls the last 4 h
  // of samples for the items on screen. Re-render once history is in so
  // Stock cells can flip from "Now N" to "Now N / ETA M" and the margin
  // math picks up the arrival-time quantity.
  Promise.all([
    recordSnapshots(items),
    loadForecastData(items),
  ]).then(() => renderTable()).catch(() => {});

  // Fetch live sell prices for all known items
  const itemIds = getItemIdsForPriceFetch();
  if (itemIds.length > 0) {
    await fetchAllSellPrices(playerId, itemIds, onSellPrice);
  }

  // Show bazaar deal scanner button + community stats
  const bazaarContainer = document.getElementById('bazaar-container');
  renderScanButton(bazaarContainer, playerId);
  renderCommunityStats(bazaarContainer);

  // Silently pre-warm the bazaar pool in the background, THEN try to find
  // a verified bazaar deal good enough to claim the "Best Run Right Now"
  // slot. Running sequentially (not parallel) means the best-run search
  // sees the freshest pool data that the pre-scan just wrote.
  // Fire-and-forget: errors are swallowed inside both functions.
  prescanBazaarPool(playerId).then(() => findBestBazaarRun(playerId)).then(deal => {
    if (deal) setBestBazaarRun(deal);
  });
}

// ── Category filter refresh ───────────────────────────────────
/**
 * Triggered when the user clicks a category filter chip (drugs / plushies /
 * flowers / artifacts). Refreshes both stock (one YATA fetch covers every
 * row) and the per-item sell prices for that category, but only when each
 * source is already older than CATEGORY_REFRESH_AGE_MS. Clicking "all" is
 * treated as a pure filter change — no network calls.
 */
async function handleCategoryRefresh(category, playerId) {
  if (!category || category === 'all') return;

  // Stock + buy prices: a single YATA request. Covers every row at once, so
  // we only gate on the last snapshot age, not on the selected category.
  if (Date.now() - yataFetchedAt > CATEGORY_REFRESH_AGE_MS) {
    const result = await fetchAbroadPrices().catch(() => null);
    if (result && result.items && result.items.length > 0) {
      setKnownItems(result.items);
      yataFetchedAt = result.cached ? (result.cachedAt || yataFetchedAt) : Date.now();
      renderTable();
    }
  }

  // Sell prices: per-item Torn API calls, so scope to just the clicked
  // category and only those whose snapshot is already past the threshold.
  const staleIds = getStaleItemIdsForCategory(category, CATEGORY_REFRESH_AGE_MS);
  if (staleIds.length === 0) return;

  showToast(
    `Refreshing ${staleIds.length} ${category} price${staleIds.length === 1 ? '' : 's'}…`,
    'success',
  );
  await refreshSellPrices(playerId, staleIds, onSellPrice);
}

// ── YATA-offline banner ────────────────────────────────────────
/**
 * Render a warning banner above the table explaining that YATA is
 * unreachable and we're showing cached prices. The banner is inserted
 * before the table so it scrolls with the content.
 */
function renderYataOfflineBanner(tableContainer, cachedAt) {
  const ageMins = Math.max(1, Math.floor((Date.now() - cachedAt) / 60000));
  const ageLabel = ageMins < 60
    ? `${ageMins}m ago`
    : ageMins < 1440
      ? `${Math.floor(ageMins / 60)}h ago`
      : `${Math.floor(ageMins / 1440)}d ago`;

  const banner = document.createElement('div');
  banner.className = 'yata-offline-banner';
  banner.innerHTML = `
    <span class="yata-offline-icon">&#9888;</span>
    <span class="yata-offline-text">
      YATA is offline &mdash; showing cached prices from ${ageLabel}.
      Refresh later for live data.
    </span>
  `;
  tableContainer.parentNode.insertBefore(banner, tableContainer);
}

// ── Header ─────────────────────────────────────────────────────
function showPlayerHeader(name, level) {
  let badge = document.getElementById('player-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'player-badge';
    headerEl.appendChild(badge);
  }
  badge.innerHTML = `
    <span class="player-name">${name}</span>
    <span class="player-level">Lv. ${level}</span>
    <button id="logout-btn" class="logout-btn">Logout</button>
  `;
  badge.querySelector('#logout-btn').addEventListener('click', () => {
    logout();
    showLoginScreen();
    showToast('Logged out', 'success');
  });
}

function clearPlayerHeader() {
  const badge = document.getElementById('player-badge');
  if (badge) badge.remove();
}

// ── Go ─────────────────────────────────────────────────────────
boot();
