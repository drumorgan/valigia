// Bazaar deal scanner UI — trigger button, modal overlay, deal cards.

import { scanBazaarDeals } from './bazaar-scanner.js';
import { formatMoney } from './calculator.js';

let isScanning = false;
let currentPlayerId = null;
const COOLDOWN_SEC = 5; // seconds between scans (low for testing, raise later)

// ── Helpers ──────────────────────────────────────────────────

function bazaarSearchUrl(itemName) {
  const encoded = encodeURIComponent(itemName);
  return `https://www.torn.com/imarket.php#/p=shop&step=shop&type=&searchname=${encoded}`;
}

function dealCardHtml(deal) {
  const pctOff = deal.savingsPct.toFixed(1);
  return `
    <div class="deal-card">
      <div class="deal-header">
        <span class="deal-name">${deal.itemName}</span>
        <span class="deal-pct">${pctOff}% off</span>
      </div>
      <div class="deal-prices">
        <div class="deal-price-row">
          <span class="deal-label">Bazaar</span>
          <span class="deal-value deal-value--bazaar">${formatMoney(deal.bazaarPrice)}</span>
          <span class="deal-qty">${deal.bazaarQty > 1 ? 'x' + deal.bazaarQty : ''}</span>
        </div>
        <div class="deal-price-row">
          <span class="deal-label">Market</span>
          <span class="deal-value deal-value--market">${formatMoney(deal.marketPrice)}</span>
        </div>
        <div class="deal-price-row deal-savings-row">
          <span class="deal-label">You save</span>
          <span class="deal-value deal-value--savings">${formatMoney(deal.savings)}</span>
        </div>
      </div>
      <a href="${bazaarSearchUrl(deal.itemName)}" target="_blank" rel="noopener"
         class="deal-link">Find in Bazaar &rarr;</a>
    </div>
  `;
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
        <div class="bazaar-progress" id="bazaar-progress">
          <div class="bazaar-progress-text" id="bazaar-progress-text">Scanning bazaars...</div>
          <div class="bazaar-progress-bar">
            <div class="bazaar-progress-fill" id="bazaar-progress-fill" style="width:0%"></div>
          </div>
        </div>
        <div class="bazaar-deals" id="bazaar-deals"></div>
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

  const progressText = document.getElementById('bazaar-progress-text');
  const progressFill = document.getElementById('bazaar-progress-fill');
  const progressEl = document.getElementById('bazaar-progress');
  const dealsEl = document.getElementById('bazaar-deals');
  if (!progressText || !dealsEl) {
    isScanning = false;
    return;
  }

  // Reset UI
  progressEl.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = 'Scanning bazaars...';
  dealsEl.innerHTML = '';

  const { deals, stats } = await scanBazaarDeals(
    playerId,
    (scanned, total) => {
      const pct = Math.round((scanned / total) * 100);
      progressFill.style.width = pct + '%';
      progressText.textContent = `Scanning... ${scanned}/${total} items`;
    },
    (deal) => {
      dealsEl.insertAdjacentHTML('beforeend', dealCardHtml(deal));
    }
  );

  // Done
  isScanning = false;

  const diagLine = `${stats.resolved}/${stats.watchlistSize} resolved · ${stats.hadBazaar} bazaar · ${stats.hadMarket} market · ${stats.cheaper} cheaper`;

  if (deals.length === 0) {
    progressText.textContent = 'No deals right now';
    dealsEl.innerHTML = `
      <div class="bazaar-empty">
        No bazaar listings found cheaper than market price right now.<br>
        Close this and try again in a bit.
      </div>
      <div class="bazaar-diag">${diagLine}</div>
    `;
  } else {
    progressText.textContent = `${deals.length} deal${deals.length > 1 ? 's' : ''} found!`;
    dealsEl.innerHTML = deals.map(dealCardHtml).join('') +
      `<div class="bazaar-diag">${diagLine}</div>`;
  }

}

// ── Public API ───────────────────────────────────────────────

/**
 * Render the bazaar scan trigger button.
 * Call from main.js after dashboard loads.
 */
export function renderScanButton(container, playerId) {
  currentPlayerId = playerId;

  const btn = document.createElement('button');
  btn.className = 'bazaar-trigger-btn bazaar-trigger-btn--ready';
  btn.textContent = 'Scan Bazaar Deals';

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
        btn.textContent = 'Scan Bazaar Deals';
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
}
