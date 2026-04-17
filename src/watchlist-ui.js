// Watchlist UI — tab content + compact matches card.
//
// Two surfaces:
//   1) renderMatchesCard(container)  — slim card at the top of the Travel
//      tab. Shows the top few matches with direct links. Hidden if no
//      matches, so non-watchlist users never see it.
//   2) renderWatchlistTab(container) — the full tab: add-alert form,
//      existing-alerts table, and a matches panel below.
//
// Both surfaces share the same local alerts cache so flipping between
// Travel ↔ Watchlist doesn't require a re-fetch.

import { listAlerts, upsertAlert, deleteAlert, findMatches, ALL_VENUES } from './watchlist.js';
import { ABROAD_ITEMS } from './data/abroad-items.js';
import { showToast } from './ui.js';
import { formatMoney } from './calculator.js';

const ITEM_ID_MAP_KEY = 'valigia_item_id_map';

// Show at most this many rows in the typeahead dropdown. Torn has ~1000
// items; rendering them all each keystroke stutters on iPad. 12 fits on
// one screen without scroll on a typical dashboard viewport.
const TYPEAHEAD_MAX_RESULTS = 12;

// Shared per-session state. Both renderers read from these; writers (the
// add/delete handlers) mutate them and re-render.
let alertsCache = null;       // Array of { item_id, max_price, venues }
let matchesCache = null;      // Array of match objects (see watchlist.js)
let itemNameByIdMemo = null;  // Map<number, string> — lazy-built

/** Build { id → name } from the cached Torn catalog + ABROAD_ITEMS. */
function getItemNameById() {
  if (itemNameByIdMemo) return itemNameByIdMemo;
  const map = new Map();
  // ABROAD_ITEMS gives us names for anything that's in the travel list
  // with a resolved id — that covers Xanax and friends on first load.
  for (const it of ABROAD_ITEMS) {
    if (it.itemId != null) map.set(Number(it.itemId), it.name);
  }
  // The Torn item catalog cached by item-resolver covers every other id.
  try {
    const raw = localStorage.getItem(ITEM_ID_MAP_KEY);
    if (raw) {
      const nameToId = JSON.parse(raw);
      for (const [name, id] of Object.entries(nameToId)) {
        // Only overwrite if not already set — ABROAD_ITEMS has the canonical
        // casing we prefer ("Xanax" vs "xanax"). Same-cased items here fill
        // in everything else (LSD, Ecstasy, Beer, etc.).
        if (!map.has(Number(id))) {
          map.set(Number(id), name);
        }
      }
    }
  } catch { /* cache corrupt — ignore; worst case we show "Item #206" */ }
  itemNameByIdMemo = map;
  return map;
}

/** [{id,name}] suitable for the <datalist> autocomplete. */
function getItemSuggestions() {
  const map = getItemNameById();
  const out = [];
  for (const [id, name] of map) out.push({ id, name });
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Resolve a user-entered item name to its id. Case-insensitive. */
function resolveItemName(input) {
  if (!input) return null;
  const needle = String(input).trim().toLowerCase();
  if (!needle) return null;
  for (const [id, name] of getItemNameById()) {
    if (name.toLowerCase() === needle) return id;
  }
  return null;
}

/**
 * Filter the full item list by substring match against the query. Matches
 * that START with the query rank above substring-only matches; ties break
 * alphabetically. Empty query returns the first TYPEAHEAD_MAX_RESULTS
 * alphabetically so the dropdown has something useful on focus before any
 * typing.
 */
function filterItemSuggestions(query) {
  const all = getItemSuggestions();
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return all.slice(0, TYPEAHEAD_MAX_RESULTS);

  const starts = [];
  const contains = [];
  for (const s of all) {
    const name = s.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(s);
    else if (name.includes(needle)) contains.push(s);
    if (starts.length >= TYPEAHEAD_MAX_RESULTS) break;
  }
  return [...starts, ...contains].slice(0, TYPEAHEAD_MAX_RESULTS);
}

/**
 * Attach typeahead behaviour to the #wl-item-input + #wl-typeahead-list
 * pair. Touch-first: tapping a row fills the input and submits focus
 * back to the price field. Keyboard users get arrow-up/down + Enter.
 */
function wireTypeahead(root) {
  const input = root.querySelector('#wl-item-input');
  const list = root.querySelector('#wl-typeahead-list');
  const priceInput = root.querySelector('#wl-price-input');
  if (!input || !list) return;

  let activeIndex = -1;    // keyboard-highlighted row, -1 = none
  let currentResults = []; // mirrors what's rendered, for arrow-key picks

  function render(query) {
    currentResults = filterItemSuggestions(query);
    if (currentResults.length === 0) {
      list.innerHTML = `<li class="wl-typeahead-empty">No items match "${query}"</li>`;
      list.hidden = false;
      return;
    }
    list.innerHTML = currentResults
      .map((s, i) => `
        <li class="wl-typeahead-row${i === activeIndex ? ' wl-typeahead-row--active' : ''}"
            data-id="${s.id}" data-name="${s.name}" role="option">
          ${s.name}
        </li>
      `)
      .join('');
    list.hidden = false;
  }

  function close() {
    list.hidden = true;
    activeIndex = -1;
  }

  function selectRow(row) {
    if (!row) return;
    input.value = row.dataset.name || '';
    close();
    // Hand focus to the price field — this is the natural next step and
    // keeps the on-screen keyboard open on iPad instead of dismissing it.
    if (priceInput) priceInput.focus();
  }

  input.addEventListener('focus', () => render(input.value));
  input.addEventListener('input', () => {
    activeIndex = -1;
    render(input.value);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, currentResults.length - 1);
      render(input.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, -1);
      render(input.value);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      const picked = currentResults[activeIndex];
      if (picked) {
        input.value = picked.name;
        close();
        if (priceInput) priceInput.focus();
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });

  // pointerdown fires before blur, so the blur handler doesn't race us into
  // hiding the list before we can read the tapped row's data.
  list.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.wl-typeahead-row');
    if (!row) return;
    e.preventDefault();
    selectRow(row);
  });

  input.addEventListener('blur', () => {
    // Defer so a pointerdown on a row still gets to fire first.
    setTimeout(close, 120);
  });
}

// ── Data plumbing ──────────────────────────────────────────────

/** Load alerts + resolve current matches. Caches both for reuse. */
async function refreshAlertsAndMatches() {
  alertsCache = await listAlerts();
  matchesCache = await findMatches(alertsCache, getItemNameById());
}

/** External hook: re-fetch next render. Called after login changes. */
export function invalidateWatchlistCache() {
  alertsCache = null;
  matchesCache = null;
  itemNameByIdMemo = null;
}

// ── Formatters ─────────────────────────────────────────────────

function venueBadgeClass(venue) {
  switch (venue) {
    case 'market': return 'wl-venue wl-venue--market';
    case 'bazaar': return 'wl-venue wl-venue--bazaar';
    case 'abroad': return 'wl-venue wl-venue--abroad';
    default:       return 'wl-venue';
  }
}

function formatAge(ms) {
  if (!ms) return 'unknown';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function matchRowHtml(match) {
  const extraBits = [];
  if (match.venue === 'abroad' && match.extra?.stock != null) {
    extraBits.push(`Stock: ${match.extra.stock}`);
  }
  if (match.venue === 'bazaar' && match.extra?.owner_id) {
    extraBits.push(`Owner #${match.extra.owner_id}`);
  }
  // Loss-leader match: the absolute floor is below the user's threshold
  // but the qty-filtered effective floor isn't. Tell them the cheap
  // price is almost certainly one-unit-only so they don't expect to
  // clear a stack at $219k when the real wall sits at $222k.
  if (match.venue === 'market' && match.extra?.limited) {
    extraBits.push('single unit');
  }
  const extraHtml = extraBits.length
    ? `<span class="wl-match-extra">${extraBits.join(' · ')}</span>`
    : '';
  const savingsPct = Number.isFinite(match.savings_pct)
    ? `${match.savings_pct.toFixed(0)}%`
    : '—';
  return `
    <a class="wl-match-row" href="${match.link}" target="_blank" rel="noopener">
      <span class="wl-match-item">${match.item_name}</span>
      <span class="${venueBadgeClass(match.venue)}">${match.venue_label}</span>
      <span class="wl-match-price">${formatMoney(match.price)}</span>
      <span class="wl-match-savings">
        saves <strong>${formatMoney(match.savings)}</strong>
        <span class="wl-match-pct">(${savingsPct})</span>
      </span>
      ${extraHtml}
      <span class="wl-match-age">${formatAge(match.observed_at)}</span>
      <span class="wl-match-arrow">→</span>
    </a>
  `;
}

// ── Matches card (lives above Best Run on the Travel tab) ──────

/**
 * Render a slim "Watchlist matches" card. Hidden entirely if the user has
 * no alerts or no current matches. Uses the shared cache — safe to call
 * on every tab switch.
 */
export async function renderMatchesCard(container) {
  if (!container) return;
  if (alertsCache == null) await refreshAlertsAndMatches();
  if (!alertsCache || alertsCache.length === 0 || !matchesCache || matchesCache.length === 0) {
    container.innerHTML = '';
    return;
  }

  const MAX_PREVIEW = 5;
  const preview = matchesCache.slice(0, MAX_PREVIEW);
  const moreCount = matchesCache.length - preview.length;
  const moreLine = moreCount > 0
    ? `<div class="wl-card-more">+${moreCount} more on the Watchlist tab</div>`
    : '';

  container.innerHTML = `
    <div class="wl-card">
      <div class="wl-card-header">
        <span class="wl-card-title">WATCHLIST MATCHES</span>
        <span class="wl-card-badge">${matchesCache.length}</span>
      </div>
      <div class="wl-card-rows">
        ${preview.map(matchRowHtml).join('')}
      </div>
      ${moreLine}
    </div>
  `;
}

// ── Full Watchlist tab ─────────────────────────────────────────

export async function renderWatchlistTab(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="wl-tab">
      <div class="wl-intro">
        <h2 class="wl-heading">Watchlist</h2>
        <p class="wl-sub">
          Pin items you want to buy under a target price. Every time you
          open Valigia, we check the Item Market, every crowd-sourced
          bazaar, and every scraped travel shop — any hit surfaces here
          and on the Travel tab.
        </p>
      </div>

      <form class="wl-add" id="wl-add-form">
        <div class="wl-add-row">
          <label class="wl-field wl-field--item">
            <span class="wl-field-label">Item</span>
            <div class="wl-typeahead" id="wl-typeahead">
              <input
                type="text"
                id="wl-item-input"
                class="wl-input"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                required
              />
              <ul class="wl-typeahead-list" id="wl-typeahead-list" hidden></ul>
            </div>
          </label>
          <label class="wl-field wl-field--price">
            <span class="wl-field-label">Max price</span>
            <input
              type="number"
              id="wl-price-input"
              class="wl-input"
              min="1"
              step="1"
              required
            />
          </label>
          <button type="submit" class="wl-add-btn" id="wl-add-btn">Add</button>
        </div>
        <div class="wl-venues">
          <span class="wl-field-label">Notify for</span>
          <label class="wl-venue-toggle">
            <input type="checkbox" data-venue="market" checked /> Item Market
          </label>
          <label class="wl-venue-toggle">
            <input type="checkbox" data-venue="bazaar" checked /> Bazaars
          </label>
          <label class="wl-venue-toggle">
            <input type="checkbox" data-venue="abroad" checked /> Abroad
          </label>
        </div>
      </form>

      <section class="wl-section">
        <h3 class="wl-section-title">Current matches</h3>
        <div id="wl-matches-host"></div>
      </section>

      <section class="wl-section">
        <h3 class="wl-section-title">Your alerts</h3>
        <div id="wl-alerts-host"></div>
      </section>
    </div>
  `;

  // Wire the custom typeahead. Native <datalist> on iPadOS doesn't filter
  // as-you-type the way users expect — it flashes the whole Torn catalog.
  // We do our own substring filter, capped at TYPEAHEAD_MAX_RESULTS rows so
  // the dropdown stays a tappable size on iPad.
  wireTypeahead(container);

  // Add-alert submit
  container.querySelector('#wl-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const itemInput = container.querySelector('#wl-item-input');
    const priceInput = container.querySelector('#wl-price-input');
    const btn = container.querySelector('#wl-add-btn');

    const itemId = resolveItemName(itemInput.value);
    const price = Math.round(Number(priceInput.value));
    const venues = [...container.querySelectorAll('.wl-venue-toggle input')]
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.venue);

    if (!itemId) {
      showToast(`Unknown item "${itemInput.value}". Try the autocomplete.`);
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      showToast('Enter a valid max price.');
      return;
    }
    if (venues.length === 0) {
      showToast('Pick at least one venue.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving…';
    let result;
    try {
      result = await upsertAlert(itemId, price, venues);
    } catch (err) {
      // Network / CORS / thrown fetch — make sure we always reset the
      // button so the form isn't stuck on "Saving…". Swallow to the toast.
      result = { success: false, error: err?.message || 'network' };
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add';
    }

    if (!result?.success) {
      const errMap = {
        alert_cap_reached: 'You already have 50 alerts — delete one first.',
        not_logged_in: 'Your session expired — log in again.',
        unauthorized: 'Your session expired — log in again.',
        network: 'Network or server unreachable — is the watchlist edge function deployed?',
        bad_response: 'Server returned an unexpected response — try again shortly.',
      };
      const msg = errMap[result?.error] || `Could not save alert: ${result?.error || 'unknown'}`;
      showToast(msg);
      return;
    }

    itemInput.value = '';
    priceInput.value = '';
    showToast('Alert saved.', 'success');
    invalidateWatchlistCache();
    renderWatchlistTab(container);
  });

  // Render bodies (data may or may not already be cached — refresh covers both).
  await refreshAlertsAndMatches();
  renderMatchesBody(container.querySelector('#wl-matches-host'));
  renderAlertsTable(container.querySelector('#wl-alerts-host'), container);
}

function renderMatchesBody(host) {
  if (!host) return;
  if (!matchesCache || matchesCache.length === 0) {
    host.innerHTML = `
      <p class="wl-empty">
        No current hits. Add an alert above, or wait — the three pools
        refresh continuously as people use Valigia.
      </p>
    `;
    return;
  }
  host.innerHTML = `
    <div class="wl-match-list">${matchesCache.map(matchRowHtml).join('')}</div>
  `;
}

function renderAlertsTable(host, tabRoot) {
  if (!host) return;
  if (!alertsCache || alertsCache.length === 0) {
    host.innerHTML = `
      <p class="wl-empty">
        You haven't added any alerts yet. Pin your first item above to
        start getting heads-up when it shows up below target price.
      </p>
    `;
    return;
  }
  const names = getItemNameById();
  const rows = alertsCache.map((a) => {
    const name = names.get(a.item_id) || `Item #${a.item_id}`;
    const venueList = (a.venues || ALL_VENUES).join(' · ');
    return `
      <tr data-item-id="${a.item_id}">
        <td class="wl-cell-item">${name}</td>
        <td class="wl-cell-price">${formatMoney(a.max_price)}</td>
        <td class="wl-cell-venues">${venueList}</td>
        <td class="wl-cell-action">
          <button class="wl-del-btn" data-item-id="${a.item_id}" title="Remove alert">×</button>
        </td>
      </tr>
    `;
  }).join('');
  host.innerHTML = `
    <table class="wl-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Max price</th>
          <th>Venues</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  host.querySelectorAll('.wl-del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const itemId = Number(btn.dataset.itemId);
      btn.disabled = true;
      let result;
      try {
        result = await deleteAlert(itemId);
      } catch (err) {
        result = { success: false, error: err?.message || 'network' };
      }
      if (!result?.success) {
        btn.disabled = false;
        showToast('Could not delete alert. Try again.');
        return;
      }
      showToast('Alert removed.', 'success');
      invalidateWatchlistCache();
      renderWatchlistTab(tabRoot);
    });
  });
}
