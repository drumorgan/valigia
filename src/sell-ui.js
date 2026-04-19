// Sell-tab UI — TornExchange trader submit + pool browser.
//
// Originally this tab also showed "your inventory → best buyer" by calling
// Torn's user/?selections=inventory. Torn deprecated v1 inventory
// ("The inventory selection is no longer available") and the v2 path
// rejects our request with "Incorrect category", so the web can no
// longer read inventory directly. The PDA userscript's item.php runner
// covers the inventory matcher now (scrapes the player's own Items page
// and injects a Best Sell Opportunities bar in-game); this tab stays
// focused on two things the web can still do:
//   1) Submit form — paste a TE URL / handle; scrape it server-side.
//   2) Traders-in-the-pool list — read te_traders and refresh entries.

import {
  submitTrader, listTraders, refreshStaleTrader,
} from './te-traders.js';
import { showToast } from './ui.js';

let tradersCache = null;

export function invalidateSellCache() {
  tradersCache = null;
}

async function loadTraders() {
  if (tradersCache) return tradersCache;
  tradersCache = await listTraders();
  return tradersCache;
}

// ── Formatters ────────────────────────────────────────────────
function formatAge(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function traderProfileLink(row) {
  if (row.torn_player_id) {
    return `https://www.torn.com/profiles.php?XID=${row.torn_player_id}`;
  }
  return `https://tornexchange.com/prices/${encodeURIComponent(row.handle)}/`;
}

function traderRowHtml(row) {
  const status = row.last_scrape_ok
    ? `<span class="sell-trader-ok">${row.item_count || 0} items</span>`
    : `<span class="sell-trader-fail">last scrape failed</span>`;
  return `
    <div class="sell-trader-row" data-handle="${escapeHtml(row.handle)}">
      <a class="sell-trader-name" href="${traderProfileLink(row)}" target="_blank" rel="noopener">
        ${escapeHtml(row.handle)}
      </a>
      <span class="sell-trader-status">${status}</span>
      <span class="sell-trader-age">${formatAge(row.last_scraped_at)}</span>
      <button type="button" class="sell-trader-refresh" data-handle="${escapeHtml(row.handle)}">
        Refresh
      </button>
    </div>
  `;
}

// ── Main render ───────────────────────────────────────────────
// playerId is accepted for API compatibility with the tab-switch caller
// but unused here — nothing on this tab needs the logged-in player id
// anymore. Kept so main.js doesn't have to special-case Sell.
export async function renderSellTab(container, _playerId) {
  if (!container) return;

  container.innerHTML = `
    <div class="sell-tab">
      <div class="sell-intro">
        <h2 class="sell-heading">Sell</h2>
        <p class="sell-sub">
          TornExchange traders advertise standing buy-offers for items.
          Submit a trader's page and we'll keep a shared pool of their
          prices so every Valigia user can find the best buyer. For the
          inventory matcher itself, open <strong>torn.com/item.php</strong>
          inside Torn PDA with the Valigia userscript installed — it
          surfaces a "Best Sell Opportunities" bar at the top of your
          Items page using this same pool.
        </p>
      </div>

      <form class="sell-add" id="sell-add-form">
        <div class="sell-add-row">
          <label class="sell-field">
            <span class="sell-field-label">TornExchange page URL or handle</span>
            <input
              type="text"
              id="sell-input"
              class="sell-input"
              placeholder="https://tornexchange.com/prices/OldGoat/ — or just OldGoat"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <button type="submit" id="sell-submit" class="sell-submit">Add trader</button>
        </div>
        <div class="sell-add-status" id="sell-status" hidden></div>
      </form>

      <section class="sell-traders">
        <div class="sell-section-header">
          <h3 class="sell-section-title">Traders in the pool</h3>
          <button type="button" id="sell-refresh-traders" class="sell-mini-btn">Reload</button>
        </div>
        <div id="sell-traders-body" class="sell-traders-body">
          <div class="sell-loading">Loading traders…</div>
        </div>
      </section>
    </div>
  `;

  const form = container.querySelector('#sell-add-form');
  form.addEventListener('submit', (e) => handleSubmit(e, container));

  container.querySelector('#sell-refresh-traders').addEventListener('click', () => {
    invalidateSellCache();
    renderTradersBody(container);
  });

  // Event delegation for per-trader refresh buttons.
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.sell-trader-refresh');
    if (!btn) return;
    handleTraderRefresh(btn.dataset.handle, container);
  });

  renderTradersBody(container);
}

async function renderTradersBody(container) {
  const body = container.querySelector('#sell-traders-body');
  if (!body) return;
  const traders = await loadTraders();
  if (!traders || traders.length === 0) {
    body.innerHTML = `
      <div class="sell-empty">
        No traders yet. Add one above — your pool contributions help every
        Valigia user find better buyers.
      </div>
    `;
    return;
  }
  body.innerHTML = traders.map(traderRowHtml).join('');
}

// ── Form handlers ─────────────────────────────────────────────
async function handleSubmit(e, container) {
  e.preventDefault();
  const input = container.querySelector('#sell-input');
  const btn = container.querySelector('#sell-submit');
  const status = container.querySelector('#sell-status');
  const value = input.value.trim();
  if (!value) return;

  btn.disabled = true;
  btn.textContent = 'Scraping…';
  status.hidden = true;

  const result = await submitTrader(value);

  btn.disabled = false;
  btn.textContent = 'Add trader';

  status.hidden = false;
  if (result.ok) {
    status.className = 'sell-add-status sell-add-status--ok';
    status.textContent = `Added ${result.handle}: ${result.resolved} items${result.unresolved ? ` (${result.unresolved} unresolved)` : ''}.`;
    input.value = '';
    invalidateSellCache();
    renderTradersBody(container);
    showToast(`Added trader ${result.handle}`, 'success');
  } else {
    status.className = 'sell-add-status sell-add-status--err';
    const extras = [];
    if (result.strategy) extras.push(`strategy=${result.strategy}`);
    if (result.scraped_rows != null) extras.push(`scraped ${result.scraped_rows} rows`);
    if (result.unresolved_sample?.length) {
      extras.push(`unresolved: ${result.unresolved_sample.slice(0, 3).join(', ')}`);
    }
    const extraLabel = extras.length ? ` (${extras.join('; ')})` : '';
    status.textContent = `Could not scrape: ${result.error || 'unknown error'}${extraLabel}`;
    showToast(`Trader submit failed: ${result.error || 'see status'}`, 'error');
  }
}

async function handleTraderRefresh(handle, container) {
  if (!handle) return;
  const row = container.querySelector(`.sell-trader-row[data-handle="${CSS.escape(handle)}"]`);
  const btn = row?.querySelector('.sell-trader-refresh');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }

  const result = await refreshStaleTrader(handle);

  if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }

  if (result.ok) {
    showToast(`Refreshed ${handle}: ${result.resolved} items`, 'success');
    invalidateSellCache();
    renderTradersBody(container);
  } else {
    showToast(`Refresh ${handle} failed: ${result.error || 'unknown'}`, 'error');
  }
}
