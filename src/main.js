// Valigia — entry point & orchestrator

import { callTornApi } from './torn-api.js';
import { tryAutoLogin, renderLoginScreen, logout } from './auth.js';
import { fetchAbroadPrices } from './log-sync.js';
import { fetchAllSellPrices } from './market.js';
import { resolveItemIds } from './item-resolver.js';
import { renderScanButton, renderCommunityStats } from './bazaar-ui.js';
import { prescanBazaarPool } from './bazaar-scanner.js';
import {
  showToast, renderControls, renderShimmerTable, renderTable,
  setKnownItems, getItemIdsForPriceFetch, onSellPrice, setPlayerTravel
} from './ui.js';

const screenContainer = document.getElementById('screen-container');
const headerEl = document.getElementById('app-header');

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
  const [items] = await Promise.all([
    fetchAbroadPrices().catch(() => null),
    detectPlayerTravel(playerId).catch(() => {}),
  ]);

  if (!items || items.length === 0) {
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

  // Set items, re-render controls (populates destination dropdown), and render table
  setKnownItems(items);
  renderControls(controlsBar, () => renderTable());
  renderTable();

  // Fetch live sell prices for all known items
  const itemIds = getItemIdsForPriceFetch();
  if (itemIds.length > 0) {
    await fetchAllSellPrices(playerId, itemIds, onSellPrice);
  }

  // Show bazaar deal scanner button + community stats
  const bazaarContainer = document.getElementById('bazaar-container');
  renderScanButton(bazaarContainer, playerId);
  renderCommunityStats(bazaarContainer);

  // Silently pre-warm the bazaar pool in the background. Refreshes the few
  // stalest entries so the user's next "Spin" has fresh data to work with.
  // Fire-and-forget: errors are swallowed inside prescanBazaarPool.
  prescanBazaarPool(playerId);
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
