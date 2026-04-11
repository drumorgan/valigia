// Bazaar deal scanner UI — "Wheel of Fortune" style.
// One spin → one best deal revealed. You get what you get.
// 60-second cooldown from initial page load and between scans.

import { scanBazaarDeals } from './bazaar-scanner.js';
import { formatMoney } from './calculator.js';

let isScanning = false;
let currentPlayerId = null;
const COOLDOWN_SEC = 60;

// ── Helpers ──────────────────────────────────────────────────

function bazaarSearchUrl(itemName) {
  const encoded = encodeURIComponent(itemName);
  return `https://www.torn.com/imarket.php#/p=shop&step=shop&type=&searchname=${encoded}`;
}

// ── Modal ────────────────────────────────────────────────────

function showModal(playerId) {
  const existing = document.getElementById('bazaar-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'bazaar-overlay';
  overlay.className = 'bazaar-overlay';
  overlay.innerHTML = `
    <div class="bazaar-modal">
      <div class="bazaar-modal-header">
        <h2 class="bazaar-modal-title">Bazaar Deal Scanner</h2>
        <button class="bazaar-close" id="bazaar-close">&times;</button>
      </div>
      <div class="bazaar-modal-body" id="bazaar-body">
        <div class="wof-scanner" id="wof-scanner">
          <div class="wof-spinner" id="wof-spinner">
            <div class="wof-radar"></div>
            <div class="wof-text" id="wof-text">Scanning bazaars...</div>
            <div class="wof-subtext" id="wof-subtext">Checking the shared pool</div>
          </div>
        </div>
        <div class="wof-result" id="wof-result" style="display:none"></div>
        <details class="bazaar-diag-details" id="bazaar-diag-details" style="display:none">
          <summary>Scan details</summary>
          <div class="bazaar-diag" id="bazaar-diag"></div>
        </details>
      </div>
      <div class="bazaar-modal-footer"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#bazaar-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  runScan(playerId);
}

// ── Scan Logic ───────────────────────────────────────────────

async function runScan(playerId) {
  if (isScanning) return;
  isScanning = true;

  const spinnerEl = document.getElementById('wof-spinner');
  const textEl = document.getElementById('wof-text');
  const subtextEl = document.getElementById('wof-subtext');
  const resultEl = document.getElementById('wof-result');
  const diagDetails = document.getElementById('bazaar-diag-details');
  const diagEl = document.getElementById('bazaar-diag');

  if (!textEl || !resultEl) {
    isScanning = false;
    return;
  }

  textEl.textContent = 'Scanning bazaars...';
  subtextEl.textContent = 'Reading shared pool';

  const { bestDeal, stats } = await scanBazaarDeals(
    playerId,
    (checked, total) => {
      subtextEl.textContent = `Checking bazaar ${checked}/${total}`;
    }
  );

  isScanning = false;

  // Hide spinner, show result
  spinnerEl.style.display = 'none';
  resultEl.style.display = 'block';

  if (bestDeal) {
    const pctOff = bestDeal.savingsPct.toFixed(1);
    resultEl.innerHTML = `
      <div class="wof-deal wof-deal--reveal">
        <div class="wof-deal-badge">${pctOff}% OFF</div>
        <div class="wof-deal-name">${bestDeal.itemName}</div>
        <div class="wof-deal-prices">
          <div class="wof-price-row">
            <span class="wof-price-label">Bazaar</span>
            <span class="wof-price-value wof-price--bazaar">${formatMoney(bestDeal.bazaarPrice)}</span>
            ${bestDeal.bazaarQty > 1 ? `<span class="wof-price-qty">x${bestDeal.bazaarQty}</span>` : ''}
          </div>
          <div class="wof-price-row">
            <span class="wof-price-label">Market</span>
            <span class="wof-price-value wof-price--market">${formatMoney(bestDeal.marketPrice)}</span>
          </div>
          <div class="wof-price-row wof-savings-row">
            <span class="wof-price-label">You save</span>
            <span class="wof-price-value wof-price--savings">${formatMoney(bestDeal.savings)}</span>
          </div>
        </div>
        <a href="${bazaarSearchUrl(bestDeal.itemName)}" target="_blank" rel="noopener"
           class="wof-deal-link">Find in Bazaar &rarr;</a>
      </div>
    `;
  } else {
    resultEl.innerHTML = `
      <div class="wof-no-deal wof-deal--reveal">
        <div class="wof-no-deal-icon">&#x1F3B0;</div>
        <div class="wof-no-deal-text">No deals this spin</div>
        <div class="wof-no-deal-sub">
          No bazaar listings found below market price right now.<br>
          Every scan teaches the system new bazaars — try again later!
        </div>
      </div>
    `;
  }

  // Diagnostics (collapsible)
  const diagLines = [
    `Watchlist: ${stats.resolved}/${stats.watchlistSize} resolved`,
    `Market prices (from cache): ${stats.marketHits}`,
    `Known bazaar sources (pool): ${stats.poolHits} items`,
    `New bazaars discovered: ${stats.discovered}`,
    `Bazaars checked: ${stats.checked}`,
    `~${stats.apiCalls + stats.checked} API calls used`,
  ];
  if (stats.unresolved.length > 0) {
    diagLines.push(`Unresolved: ${stats.unresolved.join(', ')}`);
  }

  diagDetails.style.display = 'block';
  diagEl.innerHTML = diagLines.join('<br>');
}

// ── Public API ───────────────────────────────────────────────

/**
 * Render the bazaar scan trigger button.
 * Starts with a 60-second cooldown to respect rate limits from
 * the initial sell-price "opening ceremony" API calls.
 */
export function renderScanButton(container, playerId) {
  currentPlayerId = playerId;

  const btn = document.createElement('button');
  btn.className = 'bazaar-trigger-btn bazaar-trigger-btn--cooldown';
  btn.disabled = true;
  btn.textContent = `Wait ${COOLDOWN_SEC}s...`;

  function startCooldown() {
    let remaining = COOLDOWN_SEC;
    btn.disabled = true;
    btn.classList.remove('bazaar-trigger-btn--ready');
    btn.classList.add('bazaar-trigger-btn--cooldown');
    btn.textContent = `Wait ${remaining}s...`;

    const interval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
        btn.disabled = false;
        btn.classList.remove('bazaar-trigger-btn--cooldown');
        btn.classList.add('bazaar-trigger-btn--ready');
        btn.textContent = 'Spin for a Deal';
      } else {
        btn.textContent = `Wait ${remaining}s...`;
      }
    }, 1000);
  }

  btn.addEventListener('click', async () => {
    if (isScanning || btn.disabled) return;
    showModal(playerId);
    startCooldown();
  });

  container.appendChild(btn);

  // Start initial cooldown immediately (opening ceremony rate limit)
  startCooldown();
}
