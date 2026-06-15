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
import { CANONICAL_DESTINATIONS, normalizeDestination } from './data/destinations.js';

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
  // Null / missing signals a destination that has no abroad_prices row at
  // all — i.e. nobody has ever scouted it. Render explicitly rather than
  // a dash so the user can tell "new" from "unknown".
  if (seconds === null || seconds === undefined) return 'never';
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
  // Null / undefined = never scouted. Guard explicitly: Number(null) is 0,
  // which would otherwise slip past the isFinite check below and score as
  // "0 minutes old" → 100% fresh, exactly the wrong answer for a row that
  // has no scout at all.
  if (ageSeconds === null || ageSeconds === undefined) return 0;
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

// Merge the RPC rows (only destinations that have ever been scouted) with
// the canonical destination list so every country shows up — scouted ones
// get their real numbers, unscouted ones get a "never" stub. Unknown
// destinations from the RPC (shouldn't happen, but defensive against
// ingest-normalisation drift) are appended at the bottom so we don't
// silently hide them.
function buildCoverageRows(rpcRows) {
  const byDest = new Map();
  for (const row of Array.isArray(rpcRows) ? rpcRows : []) {
    if (!row || typeof row.destination !== 'string') continue;
    // Fold long-form names ('United Kingdom' → 'UK', 'Cayman Islands' →
    // 'Caymans') into canonical short forms so legacy/unnormalised ingest
    // rows merge into a single coverage row instead of duplicating it.
    const dest = normalizeDestination(row.destination);
    const existing = byDest.get(dest);
    if (existing) {
      existing.items_known = (Number(existing.items_known) || 0) + (Number(row.items_known) || 0);
      existing.fresh_30m = (Number(existing.fresh_30m) || 0) + (Number(row.fresh_30m) || 0);
      // Keep the freshest (smallest) age across the merged variants.
      const a = existing.last_scout_s;
      const b = row.last_scout_s;
      if (a === null || a === undefined) existing.last_scout_s = b;
      else if (b !== null && b !== undefined) existing.last_scout_s = Math.min(Number(a), Number(b));
    } else {
      byDest.set(dest, { ...row, destination: dest });
    }
  }
  const merged = [];
  for (const dest of CANONICAL_DESTINATIONS) {
    merged.push(byDest.get(dest) || {
      destination: dest,
      items_known: 0,
      fresh_30m: 0,
      last_scout_s: null,
    });
    byDest.delete(dest);
  }
  for (const leftover of byDest.values()) merged.push(leftover);
  return merged;
}

function renderCoverage(rows) {
  const wrap = el('div', 'stats-coverage');
  const merged = buildCoverageRows(rows);
  if (merged.length === 0) {
    wrap.appendChild(el('div', 'stats-muted', 'No destinations configured.'));
    return wrap;
  }
  // Freshest destinations on top so the user can see at a glance what
  // they can trust right now. "never" scouted rows (last_scout_s === null)
  // sort to the bottom. Stable order via destination name when ages tie.
  const sorted = merged.slice().sort((a, b) => {
    const aAge = (a.last_scout_s === null || a.last_scout_s === undefined)
      ? Infinity : Number(a.last_scout_s);
    const bAge = (b.last_scout_s === null || b.last_scout_s === undefined)
      ? Infinity : Number(b.last_scout_s);
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

  const { contributors, abroad, pools, community, restocks, forecast_accuracy } = data || {};

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

  // Forecast accuracy (Phase 0 ground truth). Out-of-sample restock-timing
  // error over resolved predictions in the last 30 days. Hidden until at
  // least one prediction has been resolved by a real restock, so a fresh
  // install doesn't show an empty "—" row that looks broken.
  panel.appendChild(renderSection('FORECAST ACCURACY (restock timing, 30 d)',
    renderForecastAccuracy(forecast_accuracy)));
}

// Render the forecast-accuracy line. Before any prediction has resolved we
// show how many are still pending so the user knows the harness is live but
// not yet scored. Once resolutions exist, lead with the median abs error
// (the headline MAE), then bias and the p90 tail.
function renderForecastAccuracy(acc) {
  const body = el('div', 'stats-line');
  const resolved = Number(acc?.n_resolved) || 0;
  const open = Number(acc?.n_open) || 0;
  if (resolved === 0) {
    body.textContent = open > 0
      ? `no resolutions yet · ${formatInt(open)} prediction${open === 1 ? '' : 's'} pending`
      : 'no predictions logged yet';
    return body;
  }
  const mae = acc?.median_abs_err_min;
  const bias = acc?.median_signed_err_min;
  const p90 = acc?.p90_abs_err_min;
  const parts = [`±${formatNum(mae)}m median error (n=${formatInt(resolved)})`];
  if (Number.isFinite(Number(bias))) {
    const b = Number(bias);
    // Positive signed error = predicted too early (restock came later).
    const dir = b > 0 ? 'early' : b < 0 ? 'late' : 'centered';
    parts.push(`bias ${formatNum(Math.abs(b))}m ${dir}`);
  }
  if (Number.isFinite(Number(p90))) parts.push(`p90 ${formatNum(p90)}m`);
  if (open > 0) parts.push(`${formatInt(open)} pending`);

  const wrap = el('div');
  body.textContent = parts.join(' · ');
  wrap.appendChild(body);

  // Per-model split (only when more than one model cohort has resolved data
  // — during a rollout this is the A/B that shows whether the new model
  // actually beat the old one). Lower median error = better; signed bias
  // shows directional skew (early vs late).
  const byModel = Array.isArray(acc?.by_model) ? acc.by_model : [];
  if (byModel.length > 1) {
    for (const m of byModel) {
      const b = Number(m?.median_signed_err_min);
      const dir = !Number.isFinite(b) ? '' : b > 0 ? ' early' : b < 0 ? ' late' : ' centered';
      const line = el('div', 'stats-line stats-muted');
      line.textContent =
        `${m.model_version}: ±${formatNum(m.median_abs_err_min)}m`
        + (Number.isFinite(b) ? ` (bias ${formatNum(Math.abs(b))}m${dir})` : '')
        + ` · n=${formatInt(m.n_resolved)}`;
      wrap.appendChild(line);
    }
  }
  return wrap;
}

// One-decimal number for sub-minute error readouts; "—" for non-finite.
function formatNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : '—';
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
