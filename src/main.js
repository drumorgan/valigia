// Valigia — entry point & orchestrator

import { supabase } from './supabase.js';
import { tryAutoLogin, renderLoginScreen, logout } from './auth.js';
import { syncAbroadPrices } from './log-sync.js';
import { fetchAllSellPrices } from './market.js';
import { resolveItemIds } from './item-resolver.js';
import {
  showToast, renderControls, renderShimmerTable, renderTable,
  setKnownItems, getItemIdsForPriceFetch, onSellPrice
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

  // Resolve item IDs (one-time Torn API call, cached in localStorage)
  await resolveItemIds(playerId);

  // Sync this player's purchase logs (silent, auto-discovers items)
  // and load existing prices from Supabase — in parallel
  const [buyResult] = await Promise.all([
    supabase.from('abroad_prices').select('*'),
    syncAbroadPrices(playerId).catch((err) =>
      console.warn('log-sync error:', err.message)
    ),
  ]);

  // After sync, re-fetch to include any newly upserted items
  const freshResult = await supabase.from('abroad_prices').select('*');
  const items = freshResult.data || buyResult.data || [];

  if (items.length === 0) {
    showToast('No price data yet. Buy items abroad and check back!', 'success');
  }

  // Set items and render table with buy prices
  setKnownItems(items);
  renderTable();

  // Fetch live sell prices for all known items
  const itemIds = getItemIdsForPriceFetch();
  if (itemIds.length > 0) {
    await fetchAllSellPrices(playerId, itemIds, onSellPrice);
  }
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
