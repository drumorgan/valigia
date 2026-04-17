// Valigia — entry point & orchestrator

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';
import { tryAutoLogin, renderLoginScreen, logout } from './auth.js';
import { fetchAbroadPrices } from './log-sync.js';
import { fetchAllSellPrices, refreshSellPrices } from './market.js';
import { resolveItemIds } from './item-resolver.js';
import { renderScanButton, renderCommunityStats } from './bazaar-ui.js';
import { prescanBazaarPool, findBestBazaarRun } from './bazaar-scanner.js';
import { recordSnapshots, loadForecastData } from './stock-forecast.js';
import { mountPdaInstallButton } from './pda-install-modal.js';
import {
  renderMatchesCard, renderWatchlistTab, invalidateWatchlistCache,
} from './watchlist-ui.js';
import { setAbroadSnapshot } from './watchlist.js';
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
const tabNav = document.getElementById('tab-nav');

// When knownItems was last sourced from YATA. A live fetch sets this to
// Date.now(); a cached fetch preserves YATA's original timestamp so we
// re-attempt the live call as soon as the user engages a category filter.
let yataFetchedAt = 0;

// Tab state. The Travel tab is the full dashboard (controls + table +
// best-run + bazaar). Switching tabs hides the Travel DOM and renders the
// Watchlist DOM in its place — we don't rebuild Travel from scratch,
// because re-fetching YATA + running a pre-scan on every tab switch would
// be wasteful and the user would lose their scroll/sort state.
//
// The selected tab is persisted to localStorage so a page refresh lands
// the user back where they were. Only two tabs today, so a tiny string
// key is enough — no need for a router.
const STORAGE_ACTIVE_TAB = 'valigia_active_tab';
const VALID_TABS = ['travel', 'watchlist'];
let currentTab = 'travel';
const TAB_CONTAINER_IDS = {
  travel: 'tab-travel-host',
  watchlist: 'tab-watchlist-host',
};

function getStoredTab() {
  const stored = localStorage.getItem(STORAGE_ACTIVE_TAB);
  return VALID_TABS.includes(stored) ? stored : 'travel';
}

// ── Boot ───────────────────────────────────────────────────────
async function boot() {
  // Header-level PDA-scouts counter is independent of login state — fire it
  // in parallel so it shows up on the login screen too.
  loadPdaScoutCount();

  const result = await tryAutoLogin();

  if (result.success) {
    showPlayerHeader(result.name, result.level);
    showToast(`Welcome back, ${result.name}!`, 'success');
    startDashboard(result.player_id);
  } else {
    showLoginScreen();
  }
}

// ── PDA activity counter ──────────────────────────────────────
/**
 * Fetch per-page PDA scout counts (last 24h) and reveal the header banner.
 *
 * The RPC returns one row per page_type ('travel', 'item_market', 'bazaar'),
 * each with a distinct-player scout count plus an event count. The banner
 * shows one segment per page_type with at least one scout; segments with
 * zero activity stay hidden so we don't advertise a dead runner.
 *
 * Trust: every counted player_id is Torn-validated at write time —
 * travel rows are fanned out from ingest-travel-shop, Item Market and
 * Bazaar rows come from the record-pda-activity edge function. See
 * migration 018_pda_activity_log.sql.
 *
 * Silently hides on any failure — vanity metric, not load-blocking.
 */
const PAGE_TYPES = ['travel', 'item_market', 'bazaar'];

async function loadPdaScoutCount() {
  const banner = document.getElementById('pda-scouts-banner');
  if (!banner) return;

  try {
    const { data, error } = await supabase.rpc('get_pda_activity_24h');
    if (error || !Array.isArray(data)) return;

    const byPage = new Map();
    for (const row of data) {
      if (!row || typeof row.page_type !== 'string') continue;
      const scouts = Number(row.scouts);
      const events = Number(row.events);
      if (!Number.isFinite(scouts) || scouts <= 0) continue;
      byPage.set(row.page_type, {
        scouts,
        events: Number.isFinite(events) ? events : 0,
      });
    }

    if (byPage.size === 0) return;

    for (const pageType of PAGE_TYPES) {
      const segment = document.getElementById(`pda-${pageType}-segment`);
      if (!segment) continue;
      const entry = byPage.get(pageType);
      if (!entry) { segment.hidden = true; continue; }
      const scoutsEl = document.getElementById(`pda-${pageType}-scouts`);
      const eventsEl = document.getElementById(`pda-${pageType}-events`);
      if (scoutsEl) scoutsEl.textContent = entry.scouts.toLocaleString();
      if (eventsEl) {
        eventsEl.textContent = entry.events > 0
          ? `(${entry.events.toLocaleString()})`
          : '';
      }
      segment.hidden = false;
    }

    const travelVisible = byPage.has('travel');
    const marketVisible = byPage.has('item_market');
    const bazaarVisible = byPage.has('bazaar');
    const sepTravelMarket = document.getElementById('pda-sep-travel-itemmarket');
    const sepMarketBazaar = document.getElementById('pda-sep-itemmarket-bazaar');
    if (sepTravelMarket) {
      sepTravelMarket.hidden = !(travelVisible && (marketVisible || bazaarVisible));
    }
    if (sepMarketBazaar) {
      sepMarketBazaar.hidden = !((travelVisible || marketVisible) && bazaarVisible);
    }

    banner.hidden = false;
  } catch {
    // Counter is vanity — silent fail keeps it invisible rather than broken.
  }
}

// ── Login Screen ───────────────────────────────────────────────
function showLoginScreen() {
  clearPlayerHeader();
  hideTabNav();
  invalidateWatchlistCache();
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
  showTabNav();
  screenContainer.innerHTML = `
    <div id="${TAB_CONTAINER_IDS.travel}" class="tab-host tab-host--active">
      <div id="watchlist-matches-card"></div>
      <div id="controls-bar"></div>
      <div id="best-run-container"></div>
      <div id="table-container"></div>
      <div id="bazaar-container"></div>
    </div>
    <div id="${TAB_CONTAINER_IDS.watchlist}" class="tab-host" hidden></div>
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
  // Share the merged YATA+scrape snapshot with the watchlist matcher so
  // its abroad-venue lookup matches what the Travel table shows, instead
  // of being limited to the sparse `abroad_prices` Supabase rows.
  setAbroadSnapshot(items);
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

  // Watchlist matches card + tab badge. The card lives above the controls,
  // so it's the first thing a user with active alerts sees on login. The
  // tab badge reflects the same count so unvisited matches are obvious.
  // Fire-and-forget: both surfaces hide themselves if anything fails.
  refreshWatchlistSurfaces();

  // Restore the last-selected tab. We only do this AFTER the Travel
  // dashboard's DOM is built and its async data is in flight, so when the
  // user switches back to Travel the data is already there. Using the
  // sentinel 'travel' as the default means this is a no-op for users who
  // never left the default.
  const storedTab = getStoredTab();
  if (storedTab !== 'travel') switchTab(storedTab);
}

// ── Watchlist matches surfacing ───────────────────────────────
async function refreshWatchlistSurfaces() {
  const card = document.getElementById('watchlist-matches-card');
  const badge = document.getElementById('tab-watchlist-badge');
  if (!card) return;
  try {
    await renderMatchesCard(card);
    // Derive the tab badge from the card's rendered content — we keep a
    // single source of truth (watchlist-ui.js owns cache) rather than
    // re-querying here.
    const matchCountEl = card.querySelector('.wl-card-badge');
    if (badge) {
      const count = matchCountEl ? matchCountEl.textContent.trim() : '';
      if (count && count !== '0') {
        badge.textContent = count;
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    }
  } catch {
    // Silent — the card's own error path hides itself.
  }
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

// ── Tab switching ─────────────────────────────────────────────
function showTabNav() {
  if (tabNav) tabNav.hidden = false;
}
function hideTabNav() {
  if (tabNav) tabNav.hidden = true;
  currentTab = 'travel';
}

async function switchTab(nextTab) {
  if (!VALID_TABS.includes(nextTab)) nextTab = 'travel';
  if (nextTab === currentTab) return;
  currentTab = nextTab;
  // Persist so a page refresh lands the user back on the same tab.
  try { localStorage.setItem(STORAGE_ACTIVE_TAB, nextTab); } catch {}

  // Update nav-button styling
  if (tabNav) {
    tabNav.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('tab-btn--active', btn.dataset.tab === nextTab);
    });
  }

  const travelHost = document.getElementById(TAB_CONTAINER_IDS.travel);
  const watchlistHost = document.getElementById(TAB_CONTAINER_IDS.watchlist);
  if (!travelHost || !watchlistHost) return;

  if (nextTab === 'travel') {
    travelHost.hidden = false;
    travelHost.classList.add('tab-host--active');
    watchlistHost.hidden = true;
    watchlistHost.classList.remove('tab-host--active');
    // The underlying sell/bazaar/abroad tables may have changed while the
    // user was on the Watchlist tab — re-render matches so the card stays
    // truthful.
    invalidateWatchlistCache();
    refreshWatchlistSurfaces();
  } else if (nextTab === 'watchlist') {
    travelHost.hidden = true;
    travelHost.classList.remove('tab-host--active');
    watchlistHost.hidden = false;
    watchlistHost.classList.add('tab-host--active');
    await renderWatchlistTab(watchlistHost);
  }
}

if (tabNav) {
  tabNav.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn || !btn.dataset.tab) return;
    switchTab(btn.dataset.tab);
  });
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
  // Discreet PDA-overlay install button sits left of Logout. Opens a
  // modal walkthrough - never auto-opens.
  mountPdaInstallButton(badge);
}

function clearPlayerHeader() {
  const badge = document.getElementById('player-badge');
  if (badge) badge.remove();
}

// ── Go ─────────────────────────────────────────────────────────
boot();
