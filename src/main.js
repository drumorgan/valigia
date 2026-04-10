// Valigia — entry point & orchestrator

import { callTornApi } from './torn-api.js';
import { tryAutoLogin, renderLoginScreen, logout } from './auth.js';
import { resolveItemIds } from './item-resolver.js';
import {
  showToast, renderControls, setPlayerTravel
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

  // Detect travel capacity: base 5, plus any "traveling capacity" bonuses
  let slots = 5;
  const capacityRegex = /(?:increases?\s+)?(?:maximum\s+)?travel(?:ing|l)?\s+(?:item\s+)?capacity\s+by\s+(\d+)/i;
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
    <div id="table-container"></div>
  `;

  const controlsBar = document.getElementById('controls-bar');
  const tableContainer = document.getElementById('table-container');

  // Render controls + shimmer table
  renderControls(controlsBar, () => renderTable());

  // Show under construction message
  tableContainer.innerHTML = `
    <div style="text-align:center;padding:3rem 1rem;font-family:'Syne Mono',monospace;">
      <p style="font-size:1.5rem;color:var(--accent);margin-bottom:0.5rem;">Under Construction</p>
      <p style="color:var(--muted);font-size:0.9rem;max-width:28rem;margin:0 auto;">
        We're wiring up the abroad price feed. Check back soon —
        the travel leaderboard is on the way.
      </p>
    </div>
  `;

  // Resolve item IDs (one-time Torn API call, cached in localStorage)
  await resolveItemIds(playerId);

  // Detect travel perks
  detectPlayerTravel(playerId).catch((err) =>
    console.warn('perks detection error:', err.message)
  );
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
