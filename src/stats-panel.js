// Stats panel — lazy-loaded community stats behind the scouts banner.
//
// The triangle at the end of #pda-scouts-banner toggles #stats-panel. The
// panel contents are fetched once on first expand via the
// get_stats_snapshot() RPC (migration 029) and cached in memory for
// PANEL_CACHE_TTL_MS so rapid open/close/open doesn't spam Supabase.
//
// Not load-bearing: every failure path hides the panel and leaves the
// banner itself intact. This is a nerdy-stats surface, not a dashboard.

import { supabase } from './supabase.js';

const PANEL_CACHE_TTL_MS = 60_000;

const state = {
  toggle: null,
  panel: null,
  wired: false,
  fetchedAt: 0,
  data: null,
  inflight: null,
};

// ── DOM helpers ────────────────────────────────────────────────
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function formatInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : '—';
}

// "3m", "2h", "5d" — matches the terseness of the rest of the UI.
function formatAge(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// 18-cell ASCII bar, matches the cargo-terminal aesthetic better than an
// SVG meter. Empty denominator → all-dot (no data rather than a lie).
const BAR_CELLS = 18;
function barFor(numerator, denominator) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) {
    return '░'.repeat(BAR_CELLS);
  }
  const pct = Math.max(0, Math.min(1, n / d));
  const filled = Math.round(pct * BAR_CELLS);
  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled);
}

function pctFor(numerator, denominator) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

// ── Render ─────────────────────────────────────────────────────
function renderSection(title, body) {
  const section = el('div', 'stats-section');
  section.appendChild(el('div', 'stats-section-title', title));
  section.appendChild(body);
  return section;
}

function renderCoverage(rows) {
  const wrap = el('div', 'stats-coverage');
  if (!Array.isArray(rows) || rows.length === 0) {
    wrap.appendChild(el('div', 'stats-muted', 'No first-party scrapes yet.'));
    return wrap;
  }
  for (const row of rows) {
    const r = el('div', 'stats-coverage-row');
    r.appendChild(el('span', 'stats-coverage-dest', row.destination));
    r.appendChild(el('span', 'stats-coverage-bar',
      barFor(row.fresh_30m, row.items_known)));
    r.appendChild(el('span', 'stats-coverage-pct',
      pctFor(row.fresh_30m, row.items_known)));
    r.appendChild(el('span', 'stats-coverage-age',
      formatAge(row.last_scout_s)));
    wrap.appendChild(r);
  }
  return wrap;
}

function renderStatsPanel(panel, data) {
  panel.textContent = '';

  const { contributors, abroad, pools, community, restocks } = data || {};

  // Contributors
  const contribBody = el('div', 'stats-line');
  contribBody.textContent = [
    `${formatInt(contributors?.registered)} registered`,
    `${formatInt(contributors?.pda_scouts_24h)} scouting via PDA today`,
  ].join(' · ');
  panel.appendChild(renderSection('CONTRIBUTORS', contribBody));

  // Abroad coverage
  panel.appendChild(
    renderSection('ABROAD COVERAGE (first-party, fresh < 30 min)',
      renderCoverage(abroad))
  );

  // Pool sizes
  const poolsBody = el('div', 'stats-line');
  poolsBody.textContent = [
    `${formatInt(pools?.sell_prices)} IM prices`,
    `${formatInt(pools?.bazaar_active)} bazaar listings`,
    `${formatInt(pools?.te_traders)} TE traders (${formatInt(pools?.te_offers)} offers)`,
    `${formatInt(pools?.watchlist_alerts)} watchlist alerts`,
  ].join(' · ');
  panel.appendChild(renderSection('POOLS', poolsBody));

  // Community
  const communityBody = el('div', 'stats-line');
  communityBody.textContent = `${formatInt(community?.spins)} lifetime spins`;
  panel.appendChild(renderSection('COMMUNITY', communityBody));

  // Restocks
  const restocksBody = el('div', 'stats-line');
  const cadence = restocks?.median_cadence_min;
  const cadenceStr = Number.isFinite(Number(cadence))
    ? `median cadence ${cadence} min`
    : 'cadence not yet estimable';
  restocksBody.textContent =
    `${formatInt(restocks?.events_7d)} in 7 d · ${cadenceStr}`;
  panel.appendChild(renderSection('RESTOCKS', restocksBody));
}

function renderError(panel, message) {
  panel.textContent = '';
  panel.appendChild(el('div', 'stats-muted', message));
}

function renderLoading(panel) {
  panel.textContent = '';
  panel.appendChild(el('div', 'stats-muted', 'Loading stats…'));
}

// ── Fetch ──────────────────────────────────────────────────────
async function fetchStats() {
  // Coalesce concurrent callers onto one in-flight request so double-taps
  // don't fire two RPCs.
  if (state.inflight) return state.inflight;

  const age = Date.now() - state.fetchedAt;
  if (state.data && age < PANEL_CACHE_TTL_MS) return state.data;

  state.inflight = (async () => {
    const { data, error } = await supabase.rpc('get_stats_snapshot');
    if (error) throw error;
    state.data = data;
    state.fetchedAt = Date.now();
    return data;
  })();
  try {
    return await state.inflight;
  } finally {
    state.inflight = null;
  }
}

// ── Toggle ─────────────────────────────────────────────────────
async function openPanel() {
  const { toggle, panel } = state;
  if (!toggle || !panel) return;
  toggle.setAttribute('aria-expanded', 'true');
  panel.hidden = false;

  // Serve stale-but-warm data instantly; refresh silently if cache is stale.
  if (state.data) {
    renderStatsPanel(panel, state.data);
  } else {
    renderLoading(panel);
  }

  try {
    const data = await fetchStats();
    // Only repaint if the panel is still open — user may have collapsed it.
    if (toggle.getAttribute('aria-expanded') === 'true') {
      renderStatsPanel(panel, data);
    }
  } catch (_err) {
    if (toggle.getAttribute('aria-expanded') === 'true' && !state.data) {
      renderError(panel, "Couldn't load stats. Try again in a moment.");
    }
  }
}

function closePanel() {
  const { toggle, panel } = state;
  if (!toggle || !panel) return;
  toggle.setAttribute('aria-expanded', 'false');
  panel.hidden = true;
}

function onToggleClick() {
  const expanded = state.toggle.getAttribute('aria-expanded') === 'true';
  if (expanded) closePanel();
  else openPanel();
}

/**
 * Wire up the stats-panel toggle. Idempotent — safe to call from boot()
 * regardless of login state, since loadPdaScoutCount() also fires
 * unconditionally.
 */
export function initStatsPanel() {
  if (state.wired) return;
  const toggle = document.getElementById('stats-toggle');
  const panel = document.getElementById('stats-panel');
  if (!toggle || !panel) return;
  state.toggle = toggle;
  state.panel = panel;
  toggle.addEventListener('click', onToggleClick);
  state.wired = true;
}
