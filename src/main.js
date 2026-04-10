// Valigia — entry point & orchestrator

import { supabase } from './supabase.js';
import { tryAutoLogin, renderLoginScreen, logout } from './auth.js';
import { syncAbroadPrices } from './log-sync.js';
import { fetchAllSellPrices } from './market.js';
import { showToast, renderControls, renderShimmerTable, renderTable, setBuyPrices, onSellPrice } from './ui.js';
import { resolveItemIds } from './item-resolver.js';

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

// ── Dashboard ──────────────────────────────────────────────────
async function startDashboard(playerId) {
  screenContainer.innerHTML = `
    <div id="controls-bar"></div>
    <div id="table-container"></div>
  `;

  const controlsBar = document.getElementById('controls-bar');
  const tableContainer = document.getElementById('table-container');

  // Render controls + shimmer table
  renderControls(controlsBar, () => renderTable());
  renderShimmerTable(tableContainer);

  // Resolve any null item IDs (one-time Torn API call, cached in localStorage)
  await resolveItemIds(playerId);

  // Re-render shimmer table now that we know which items have IDs
  renderShimmerTable(tableContainer);

  // Load buy prices from Supabase + kick off log sync in parallel
  const [buyResult] = await Promise.all([
    supabase.from('abroad_prices').select('*'),
    // Background: sync this player's purchase logs (silent)
    syncAbroadPrices(playerId).catch((err) =>
      console.warn('log-sync error:', err.message)
    ),
  ]);

  if (buyResult.data) {
    setBuyPrices(buyResult.data);
    renderTable();
  }

  // Fetch live sell prices — rows update progressively as each resolves
  await fetchAllSellPrices(playerId, onSellPrice);
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
