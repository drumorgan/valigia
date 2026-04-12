// Bazaar deal scanner UI — "Wheel of Fortune" style.
// One spin → one best deal revealed. You get what you get.
// 60-second cooldown from initial page load and between scans.

import { scanBazaarDeals } from './bazaar-scanner.js';
import { supabase } from './supabase.js';
import { formatMoney } from './calculator.js';

let isScanning = false;
let currentPlayerId = null;
const COOLDOWN_SEC = 60;

// ── Helpers ──────────────────────────────────────────────────

function bazaarUrl(bazaarOwnerId) {
  if (bazaarOwnerId) {
    return `https://www.torn.com/bazaar.php?userId=${bazaarOwnerId}#/`;
  }
  return `https://www.torn.com/page.php?sid=bazaar`;
}

/**
 * Render a collapsed list of every deal the scanner found this spin,
 * excluding the already-shown featured deal. Empty string if no extras.
 */
function renderRunnersUp(featured, allDeals) {
  const others = featured
    ? allDeals.filter(d =>
        d.itemId !== featured.itemId || d.bazaarOwnerId !== featured.bazaarOwnerId
      )
    : allDeals;

  if (others.length === 0) return '';

  const rows = others.slice(0, 10).map(d => `
    <li class="wof-runners-row">
      <a href="${bazaarUrl(d.bazaarOwnerId)}" target="_blank" rel="noopener"
         class="wof-runners-link">
        <span class="wof-runners-name">${d.itemName}</span>
        <span class="wof-runners-savings">${formatMoney(d.savings)}</span>
        <span class="wof-runners-pct">${d.savingsPct.toFixed(0)}%</span>
      </a>
    </li>
  `).join('');

  const moreNote = others.length > 10
    ? `<div class="wof-runners-more">+${others.length - 10} more</div>`
    : '';

  return `
    <details class="wof-runners">
      <summary class="wof-runners-summary">
        See all ${others.length + (featured ? 1 : 0)} deals this spin
      </summary>
      <ol class="wof-runners-list">${rows}</ol>
      ${moreNote}
    </details>
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

  let bestDeal = null;
  let allDeals = [];
  let stats = null;

  try {
    const result = await scanBazaarDeals(
      playerId,
      (checked, total) => {
        if (subtextEl) subtextEl.textContent = `Checking bazaar ${checked}/${total}`;
      }
    );
    bestDeal = result.bestDeal;
    allDeals = result.allDeals || [];
    stats = result.stats;
  } catch (err) {
    // Scan failed — show error state instead of freezing
    isScanning = false;
    if (spinnerEl) spinnerEl.style.display = 'none';
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = `
        <div class="wof-no-deal wof-deal--reveal">
          <div class="wof-no-deal-text">Scan error</div>
          <div class="wof-no-deal-sub">${err.message || 'Something went wrong. Try again.'}</div>
        </div>
      `;
    }
    return;
  }

  isScanning = false;

  // Refresh community stats counter live
  refreshStats();

  // Hide spinner, show result
  if (spinnerEl) spinnerEl.style.display = 'none';
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
        <a href="${bazaarUrl(bestDeal.bazaarOwnerId)}" target="_blank"
           class="wof-deal-link">Go to Bazaar &rarr;</a>
      </div>
      ${renderRunnersUp(bestDeal, allDeals)}
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
      ${renderRunnersUp(null, allDeals)}
    `;
  }

  // Diagnostics (collapsible)
  const diagLines = [
    `Watchlist: ${stats.resolved}/${stats.watchlistSize} curated + ${stats.dynamicItems || 0} auto-added`,
    `Market prices (from cache): ${stats.marketHits}`,
    `Pool: ${stats.poolHits} items across ${stats.uniqueBazaars || '?'} unique bazaars`,
    `New bazaars discovered: ${stats.discovered} (saved to pool)`,
    `Bazaars checked this spin: ${stats.bazaarsChecked}`,
    `Prices found: ${stats.pricesFound}`,
    `Deals below market: ${stats.dealsFound || 0}`,
    `Pool hygiene: ${stats.poolMisses || 0} misses (${stats.poolPruned || 0} pruned)`,
    `~${stats.apiCalls + stats.bazaarsChecked} API calls used`,
  ];
  if (stats.unresolved.length > 0) {
    diagLines.push(`Unresolved: ${stats.unresolved.join(', ')}`);
  }
  if (stats.rpcError) {
    diagLines.push(`Stats error: ${stats.rpcError}`);
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

  const wrapper = document.createElement('div');
  wrapper.className = 'fuse-wrapper';
  wrapper.innerHTML = `
    <button class="bazaar-trigger-btn bazaar-trigger-btn--cooldown" disabled>
      <span class="fuse-label">Spin for a Deal</span>
    </button>
    <div class="fuse-track">
      <div class="fuse-line"></div>
      <div class="fuse-spark"></div>
    </div>
    <div class="fuse-timer"></div>
  `;

  const btn = wrapper.querySelector('.bazaar-trigger-btn');
  const fuseTrack = wrapper.querySelector('.fuse-track');
  const fuseLine = wrapper.querySelector('.fuse-line');
  const fuseSpark = wrapper.querySelector('.fuse-spark');
  const fuseTimer = wrapper.querySelector('.fuse-timer');
  const fuseLabel = wrapper.querySelector('.fuse-label');

  let sparkRaf = null;

  function trackSpark() {
    // Position spark at the right edge of the shrinking fuse line
    const lineWidth = fuseLine.getBoundingClientRect().width;
    fuseSpark.style.left = lineWidth + 'px';
    sparkRaf = requestAnimationFrame(trackSpark);
  }

  function startCooldown() {
    let remaining = COOLDOWN_SEC;
    btn.disabled = true;
    btn.classList.remove('bazaar-trigger-btn--ready');
    btn.classList.add('bazaar-trigger-btn--cooldown');
    fuseLabel.textContent = 'Lighting the fuse...';
    fuseTrack.style.display = 'block';
    fuseTimer.style.display = 'block';
    fuseLine.style.transition = 'none';
    fuseLine.style.width = '100%';
    fuseSpark.style.display = 'block';
    fuseTimer.textContent = `${remaining}s`;

    // Start spark tracking + fuse burn
    requestAnimationFrame(() => {
      fuseLine.style.transition = `width ${COOLDOWN_SEC}s linear`;
      fuseLine.style.width = '0%';
      trackSpark();
    });

    const interval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
        if (sparkRaf) cancelAnimationFrame(sparkRaf);
        btn.disabled = false;
        btn.classList.remove('bazaar-trigger-btn--cooldown');
        btn.classList.add('bazaar-trigger-btn--ready');
        fuseLabel.textContent = 'Spin for a Deal';
        fuseTrack.style.display = 'none';
        fuseTimer.style.display = 'none';
        fuseLine.style.transition = 'none';
      } else {
        fuseTimer.textContent = `${remaining}s`;
      }
    }, 1000);
  }

  btn.addEventListener('click', async () => {
    if (isScanning || btn.disabled) return;
    showModal(playerId);
    startCooldown();
  });

  container.appendChild(wrapper);

  // Start initial cooldown immediately (opening ceremony rate limit)
  startCooldown();
}

/**
 * Refresh the stats counters in-place (called after each scan).
 */
async function refreshStats() {
  try {
    const [statsRes, countRes, bazaarRes] = await Promise.all([
      supabase.from('community_stats').select('total_spins').eq('id', 1).single(),
      supabase.rpc('get_player_count'),
      supabase.from('bazaar_prices').select('bazaar_owner_id'),
    ]);

    const spinsEl = document.getElementById('cs-spins');
    const usersEl = document.getElementById('cs-users');
    const bazaarsEl = document.getElementById('cs-bazaars');
    if (statsRes.data && spinsEl) {
      spinsEl.textContent = statsRes.data.total_spins.toLocaleString();
    }
    if (countRes.data != null && usersEl) {
      usersEl.textContent = countRes.data.toLocaleString();
    }
    if (bazaarRes.data && bazaarsEl) {
      const unique = new Set(bazaarRes.data.map(r => r.bazaar_owner_id));
      bazaarsEl.textContent = unique.size.toLocaleString();
    }
  } catch {
    // Stats not available — leave as-is
  }
}

/**
 * Render live community stats + share CTA below the scan button.
 */
export async function renderCommunityStats(container) {
  const el = document.createElement('div');
  el.className = 'community-stats';
  el.innerHTML = `
    <div class="cs-title">Community Scanner</div>
    <div class="cs-counters">
      <div class="cs-counter">
        <span class="cs-value" id="cs-spins">--</span>
        <span class="cs-label">spins</span>
      </div>
      <div class="cs-divider"></div>
      <div class="cs-counter">
        <span class="cs-value" id="cs-users">--</span>
        <span class="cs-label">players</span>
      </div>
      <div class="cs-divider"></div>
      <div class="cs-counter">
        <span class="cs-value" id="cs-bazaars">--</span>
        <span class="cs-label">bazaars known</span>
      </div>
    </div>
    <div class="cs-cta">
      More players = more bazaars discovered. Tell your faction!
    </div>
  `;

  container.appendChild(el);
  await refreshStats();
}
