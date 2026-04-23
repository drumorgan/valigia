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
// SVG meter.
const BAR_CELLS = 18;

function barForScore(score) {
  const s = Math.max(0, Math.min(1, Number(score) || 0));
  const filled = Math.round(s * BAR_CELLS);
  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled);
}

// Freshness as a function of last-scout age. Full credit up to 30 min,
// zero past 48 h, log-interpolated in between. Log decay (not linear)
// because the user cares about order-of-magnitude staleness —
// 30 min vs 60 min is a bigger deal than 12 h vs 13 h. Tuning anchors:
//   0–30 min   → 100%  (fresh)
//   1 h        →  85%
//   2 h        →  70%
//   12 h       →  30%
//   48 h+      →   0%  (cold)
const FRESH_FLOOR_MIN = 30;
const STALE_CEIL_MIN = 48 * 60;
const LOG_FLOOR = Math.log2(FRESH_FLOOR_MIN);
const LOG_CEIL = Math.log2(STALE_CEIL_MIN);

function freshnessScore(ageSeconds) {
  const s = Number(ageSeconds);
  if (!Number.isFinite(s) || s < 0) return 0;
  const ageMin = s / 60;
  if (ageMin <= FRESH_FLOOR_MIN) return 1;
  if (ageMin >= STALE_CEIL_MIN) return 0;
  return 1 - (Math.log2(ageMin) - LOG_FLOOR) / (LOG_CEIL - LOG_FLOOR);
}

// Four tiers drive the bar + percent colors. Cutoffs align with the
// log-decay anchors above: "fresh" = within the yes/no floor, "aging"
// spans the first few hours, "stale" runs the long tail to 48 h, and
// "cold" is the >48 h catch-all.
function tierFor(score) {
  if (score >= 0.8) return 'fresh';
  if (score >= 0.4) return 'aging';
  if (score > 0.01) return 'stale';
  return 'cold';
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
  // Freshest destinations on top so the user can see at a glance what
  // they can trust right now. Stable order via destination name when
  // ages are equal / absent. RPC default sort is by catalog depth,
  // which matters less than recency for this panel.
  const sorted = rows.slice().sort((a, b) => {
    const aAge = Number.isFinite(Number(a.last_scout_s)) ? Number(a.last_scout_s) : Infinity;
    const bAge = Number.isFinite(Number(b.last_scout_s)) ? Number(b.last_scout_s) : Infinity;
    if (aAge !== bAge) return aAge - bAge;
    return String(a.destination).localeCompare(String(b.destination));
  });
  for (const row of sorted) {
    const score = freshnessScore(row.last_scout_s);
    const tier = tierFor(score);
    const r = el('div', `stats-coverage-row stats-coverage--${tier}`);
    r.appendChild(el('span', 'stats-coverage-dest', row.destination));
    r.appendChild(el('span', 'stats-coverage-bar', barForScore(score)));
    r.appendChild(el('span', 'stats-coverage-pct', `${Math.round(score * 100)}%`));
    r.appendChild(el('span', 'stats-coverage-age', formatAge(row.last_scout_s)));
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
    renderSection('ABROAD COVERAGE (first-party, age-graded to 48 h)',
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
