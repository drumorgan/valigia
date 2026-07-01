// Stock forecasting — predicts what abroad stock will look like when the
// traveler actually lands, not what it is "right now".
//
// The Stock column in the UI historically showed YATA's current quantity
// and clamped effective_slots to min(slots, currentQty). For long flights
// (UAE, Japan, South Africa: ~3 h one-way) that's fiction — shelves empty
// or restock before you arrive. This module fuses two signals:
//
//   1. `yata_snapshots` (48 h rolling window) — consecutive quantity
//      samples used to fit a linear depletion slope, projecting stock at
//      arrival time.
//   2. `restock_events` (30-day append-only log, migration 018) — one row
//      per observed positive delta, feeding median interval + typical
//      post-restock quantity estimates. Split off from snapshots because
//      cadence estimation wants weeks of history while the slope fit
//      wants hours.
//
// The calling code feeds `flightMins * flightMultiplier` as arrivalMins.

import { supabase } from './supabase.js';
import { safeGetItem, safeSetItem } from './storage.js';

// Track whether we've already surfaced a snapshot-write error this session.
// Supabase rejects every insert for the same reason (e.g. RLS), so one toast
// is enough — we don't want to spam on every reload.
let snapshotErrorReported = false;

// Dynamic import dodges the circular dependency between this module and
// ui.js (ui.js imports forecastStock). At runtime the module graph has
// already settled by the time we actually need to show a toast.
async function reportSnapshotError(message) {
  if (snapshotErrorReported) return;
  snapshotErrorReported = true;
  try {
    const { showToast } = await import('./ui.js');
    showToast(message, 'error');
  } catch {
    // If even the toast module won't load, give up silently — we tried.
  }
}

// How far back to look when fitting the depletion slope. Snapshots are
// pruned to match. Kept short on purpose: slopes from last-hour samples
// track reality better than slopes smeared across a 48 h restock cycle.
const HISTORY_WINDOW_MINS = 48 * 60; // 48 h

// How old a snapshot is allowed to be before the prune sweep drops it.
// Kept in sync with HISTORY_WINDOW_MINS so we don't delete anything the
// forecaster would still read.
const PRUNE_OLDER_THAN_MINS = 48 * 60; // 48 h

// Restock cadence lives in a dedicated `restock_events` table (migration
// 018) that's append-only, so we can look back much further than the
// snapshot prune window. 30 days gets us ~10-30 restock observations per
// active shelf — enough for a stable median interval and a variance-based
// confidence score.
const RESTOCK_HISTORY_WINDOW_MINS = 30 * 24 * 60; // 30 days

// Minimum samples + minimum span before we upgrade confidence from "low" to "ok".
const MIN_SAMPLES_FOR_OK = 3;
const MIN_SPAN_MINS_FOR_OK = 20;

// Minimum restock events before estimateNextRestock() yields a prediction.
// Two events give one interval sample — the statistical floor. More events
// tighten the median and unlock higher confidence tiers downstream.
const MIN_RESTOCK_EVENTS = 2;

// Torn restocks land only on quarter-hour ticks — xx:00 / :15 / :30 / :45
// TCT (TCT is UTC, so epoch-ms math works directly). Community-documented
// shop mechanic, same as city NPC stores. Exploited in two places:
//   1. Restock-event timestamps get snapped to the tick inside their
//      censoring window (pre, post] — with the 5-min cron sampling that
//      window usually contains exactly ONE tick, recovering the exact
//      refill time from two loose observations.
//   2. Predictions get snapped forward onto a tick, because a refill
//      physically cannot land between ticks.
const RESTOCK_TICK_MS = 15 * 60_000;

// Cap on the inter-restock interval the cadence estimator will trust.
// History: this was 120 min when every snapshot writer was user-gated and a
// wide gap usually meant "nobody watched the shelf". Since migration 039 the
// cron-snapshot-yata poller samples every destination every ~5 min around
// the clock, so long gaps are now REAL cadence — the old cap was deleting
// the entire cadence signal for slow shelves (flowers: ~7 h sellout +
// ~3.5 h restock delay ≈ 10.5 h cycle). 24 h is a pure sanity bound now;
// genuinely missed cycles are handled by the adaptive trim below.
const MAX_RESTOCK_GAP_MINS = 24 * 60;

// Adaptive missed-cycle trim: an observation hole that swallows exactly one
// restock produces a gap of ~2× the shelf's true cadence. Before taking the
// final median, gaps beyond this multiple of the provisional median are
// treated as missed cycles and dropped. 1.75 splits the 1× cluster from the
// 2× cluster. Only applied at ≥ MIN_GAPS_FOR_TRIM raw gaps so tiny samples
// don't trim themselves into nothing.
const MISSED_CYCLE_FACTOR = 1.75;
const MIN_GAPS_FOR_TRIM = 4;

// Forecasting model version. Logged with every prediction (migration 035)
// so resolved-accuracy cohorts stay comparable across model changes.
//   v1 — initial pooled-slope + median-cadence model.
//   v2 — Phase 1 data quality: backfill excluded + 120-min gap cap in the
//        cadence calc, and restock times debiased to the (pre, post]
//        midpoint via migration 036's pre_observed_at.
//   v3 — mechanics-aware: restock times tick-attributed to Torn's
//        quarter-hour restock ticks (often exact), gap cap 120 m → 24 h with
//        an adaptive missed-cycle trim (slow shelves regain their cadence),
//        predictions snapped forward to ticks, observation-time stamping of
//        snapshots/events (YATA per-country `update`), and empty shelves
//        prefer the half-sellout rule (restock ≈ sellout duration ÷ 2) over
//        the cadence median.
const MODEL_VERSION = 'v3';

// Prediction-accuracy logging throttle. recordForecastPredictions() writes
// at most one batch per browser per interval; the DB additionally dedups
// across users via a 10-min bucket (migration 035), so this is purely a
// client-side spend cap, not a correctness requirement. 10 min keeps the
// log dense enough to score cadence drift without flooding the table.
const PREDICTION_LOG_KEY = 'valigia_prediction_log_at';
const PREDICTION_LOG_INTERVAL_MS = 10 * 60 * 1000;

// In-memory caches keyed by `${itemId}|${destination}`.
// Populated once per page load via loadForecastData().
const historyCache = new Map();
const restockCache = new Map();

// Cross-session cache: on every successful loadForecastData() we mirror
// both maps to localStorage so a page refresh inside the TTL window can
// skip the full snapshot+restock pull (thousands of rows). Chose 15 min
// because shelves deplete over hours and a 15-min-stale forecast is
// visually indistinguishable from a fresh one — the ETA uncertainty
// band already absorbs that much drift. Bump the version suffix (v1)
// if the serialised shape ever changes so old blobs deserialise cleanly
// instead of landing as noise in the fitter.
// v2: restock entries gained a `preTime` field and the restock query now
// excludes backfill rows — bump so pre-deploy v1 blobs (backfill-polluted,
// no preTime) are discarded instead of feeding the new estimator stale data.
const FORECAST_CACHE_KEY = 'valigia_forecast_cache_v2';
const FORECAST_CACHE_TTL_MS = 15 * 60 * 1000;

function cacheKey(itemId, destination) {
  return `${itemId}|${destination}`;
}

/**
 * Try to populate historyCache + restockCache from localStorage.
 * Returns true iff a fresh cache was found and hydrated. Any corruption
 * or missing fields → return false and let the caller do a live fetch.
 */
function hydrateForecastFromStorage() {
  const raw = safeGetItem(FORECAST_CACHE_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed
        || typeof parsed.fetchedAt !== 'number'
        || !Array.isArray(parsed.history)
        || !Array.isArray(parsed.restock)) {
      return false;
    }
    if (Date.now() - parsed.fetchedAt > FORECAST_CACHE_TTL_MS) return false;

    historyCache.clear();
    restockCache.clear();
    for (const [key, arr] of parsed.history) {
      if (typeof key === 'string' && Array.isArray(arr)) historyCache.set(key, arr);
    }
    for (const [key, arr] of parsed.restock) {
      if (typeof key === 'string' && Array.isArray(arr)) restockCache.set(key, arr);
    }
    return historyCache.size > 0 || restockCache.size > 0;
  } catch {
    return false;
  }
}

/**
 * Persist the current caches to localStorage. Best-effort — quota
 * exceeded or storage disabled just means next visit does the live
 * fetch, which is the pre-cache behaviour anyway.
 */
function persistForecastToStorage() {
  safeSetItem(FORECAST_CACHE_KEY, JSON.stringify({
    fetchedAt: Date.now(),
    history: Array.from(historyCache.entries()),
    restock: Array.from(restockCache.entries()),
  }));
}

/**
 * Persist the current YATA sample for every (item, destination) into
 * Supabase. Fire-and-forget — errors are swallowed so a failed write never
 * blocks the dashboard.
 *
 * Also runs a best-effort prune of snapshots older than PRUNE_OLDER_THAN_MINS.
 *
 * @param {Array<{item_id, destination, quantity, buy_price}>} items
 */
export async function recordSnapshots(items) {
  if (!Array.isArray(items) || items.length === 0) return;

  const nowMs = Date.now();
  const rows = items
    .filter(r => r.item_id && r.destination && r.quantity != null)
    .map(r => {
      // Observation-time stamping. `reported_at` carries when the reading
      // was actually collected — YATA's per-country `update` field for feed
      // rows, the scrape's observed_at for first-party rows (see
      // log-sync.js). Stamping snapped_at with the OBSERVATION time instead
      // of the write time is what lets the estimators attribute a restock
      // to the correct quarter-hour tick: a YATA payload that's 20 min
      // stale written as "now" smears every downstream timestamp by 20
      // minutes. Clamped to now (clock skew guard); unparsable → null and
      // the DB default now() applies, same as the pre-v3 behaviour.
      let obsMs = null;
      if (r.reported_at) {
        const t = new Date(r.reported_at).getTime();
        if (Number.isFinite(t)) obsMs = Math.min(t, nowMs);
      }
      return {
        item_id: r.item_id,
        destination: r.destination,
        quantity: r.quantity,
        buy_price: r.buy_price ?? null,
        __obsMs: obsMs,
      };
    });

  if (rows.length === 0) return;

  // Dedup on write. Original implementation wrote every (item, destination)
  // on every page load — with multiple users and stable shelves, the table
  // filled with thousands of identical rows carrying zero signal. The
  // forecaster only cares about transitions: a restock (positive delta) or
  // a depletion step. Re-observing the same quantity over and over adds
  // nothing. So we pull the latest existing reading per (item, destination)
  // for items in this batch and insert only the rows where quantity or
  // buy_price has changed.
  //
  // Concurrent-write safety: the DB guarantees dedup via migration 026's
  // unique index on (item_id, destination, snapped_minute). The client-side
  // read below is kept as a payload-shrinking optimization, not a correctness
  // requirement — two racing dashboard loads collapse into one row at the
  // index level (see the upsert(..., { ignoreDuplicates: true }) below).
  // Latest stored reading per (item, destination) via the
  // get_latest_yata_snapshots() RPC (migration 041, DISTINCT ON). The old
  // approach — `.in(itemIds)` ordered desc — silently truncated at
  // PostgREST's 1000-row default: busy shelves transition every few
  // minutes, so 48 h of history easily exceeds 1000 rows, and quiet
  // shelves' latest rows fell off the end of the page. A truncated key
  // read as "never seen", which both re-wrote a redundant row and — worse
  // — silently skipped restock detection for exactly the slow shelves
  // whose cadence data is scarcest. Falls back to the windowed read if
  // the RPC is unavailable.
  const latestMap = new Map(); // "itemId|destination" -> { quantity, buy_price, snapped_at }
  try {
    const { data, error } = await supabase.rpc('get_latest_yata_snapshots');
    if (error || !Array.isArray(data)) throw error || new Error('empty');
    for (const row of data) {
      latestMap.set(`${row.item_id}|${row.destination}`, row);
    }
  } catch {
    try {
      const itemIds = [...new Set(rows.map(r => r.item_id))];
      const { data, error } = await supabase
        .from('yata_snapshots')
        .select('item_id, destination, quantity, buy_price, snapped_at')
        .in('item_id', itemIds)
        .order('snapped_at', { ascending: false });
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const key = `${row.item_id}|${row.destination}`;
          // First row per key wins because we ordered desc by snapped_at.
          if (!latestMap.has(key)) latestMap.set(key, row);
        }
      }
      // If the read failed, fall through to unfiltered insert. Worst case
      // is one duplicate row — better than dropping a transition entirely.
    } catch {
      // Same fall-through — treat unknown latest as "no prior reading".
    }
  }

  const changed = rows.filter(r => {
    const prev = latestMap.get(`${r.item_id}|${r.destination}`);
    if (!prev) return true; // never seen — always record
    // Stale-guard: never write a reading that isn't strictly newer than the
    // freshest stored row. A lagging YATA payload racing a fresh PDA scrape
    // (whose trigger already snapshotted a newer observation) would
    // otherwise register a phantom quantity "change" — and potentially a
    // phantom restock event — out of pure staleness.
    if (r.__obsMs != null && prev.snapped_at) {
      const prevMs = new Date(prev.snapped_at).getTime();
      if (Number.isFinite(prevMs) && r.__obsMs <= prevMs) return false;
    }
    const prevPrice = prev.buy_price ?? null;
    const newPrice = r.buy_price ?? null;
    return prev.quantity !== r.quantity || prevPrice !== newPrice;
  });

  if (changed.length === 0) return; // shelf looks identical to last reading

  // Supabase-js v2 does NOT throw on write errors — it returns an `error`
  // object. A bare try/catch around .insert() was catching nothing, which
  // hid a silent RLS/permission failure during initial rollout. Surface
  // the real Postgres message to the user once per session so the UI is
  // an honest diagnostic surface (we're iPad-only, no DevTools).
  //
  // upsert with ignoreDuplicates: true lets migration 026's unique index
  // on (item_id, destination, snapped_minute) quietly discard concurrent
  // writes that land in the same minute bucket, instead of failing the
  // whole batch with a 23505 conflict.
  // Strip the internal __obsMs field and stamp snapped_at from it. Rows
  // with no parsable observation time omit snapped_at → DB default now().
  const inserts = changed.map(({ __obsMs, ...row }) =>
    __obsMs != null ? { ...row, snapped_at: new Date(__obsMs).toISOString() } : row
  );

  try {
    const { error } = await supabase
      .from('yata_snapshots')
      .upsert(inserts, {
        onConflict: 'item_id,destination,snapped_minute',
        ignoreDuplicates: true,
      });
    if (error) {
      reportSnapshotError(`Stock history write failed: ${error.message}`);
    }
  } catch (e) {
    reportSnapshotError(`Stock history write threw: ${e?.message || e}`);
  }

  // Emit restock events for any (item, destination) whose quantity strictly
  // increased vs. the prior snapshot. Same dedup read we did above already
  // has the previous quantity — just filter and upsert. ON CONFLICT on the
  // generated `restocked_minute` column collapses concurrent observers of
  // the same physical refill into one row. Backfill + this path + the
  // abroad_prices trigger are the three sources feeding restock_events.
  const restockEvents = [];
  for (const row of changed) {
    const prev = latestMap.get(`${row.item_id}|${row.destination}`);
    if (prev && row.quantity > prev.quantity) {
      restockEvents.push({
        item_id: row.item_id,
        destination: row.destination,
        // Observation time, not write time — so two observers of the same
        // YATA update stamp the same minute and collapse in the
        // restocked_minute dedup index instead of logging the one physical
        // refill twice (which used to pollute the cadence with tiny gaps).
        restocked_at: new Date(row.__obsMs ?? nowMs).toISOString(),
        // Pre-restock observation time (migration 036) — the prior
        // snapshot's timestamp. Bounds the censoring window (pre, post]
        // that the tick-attribution in effectiveRestockTime() resolves.
        pre_observed_at: prev.snapped_at ?? null,
        pre_qty: prev.quantity,
        post_qty: row.quantity,
        source: 'snapshot',
      });
    }
  }
  if (restockEvents.length > 0) {
    try {
      const { error } = await supabase
        .from('restock_events')
        .upsert(restockEvents, {
          onConflict: 'item_id,destination,restocked_minute',
          ignoreDuplicates: true,
        });
      if (error) {
        reportSnapshotError(`Restock event write failed: ${error.message}`);
      }
    } catch (e) {
      reportSnapshotError(`Restock event write threw: ${e?.message || e}`);
    }
  }

  // Prune old rows so the table stays bounded. Cheap enough to run every
  // load given the row counts (~200 items * 10 snapshots/h * 4h ~= 8k rows).
  try {
    const cutoff = new Date(Date.now() - PRUNE_OLDER_THAN_MINS * 60_000).toISOString();
    await supabase.from('yata_snapshots').delete().lt('snapped_at', cutoff);
    // Deliberately do NOT surface delete errors — a failed prune is not
    // user-visible and the table self-heals on the next successful prune.
  } catch {
    // Non-fatal — table grows a little.
  }
}

/**
 * Load recent snapshots for the given items from Supabase into an in-memory
 * cache keyed by (itemId, destination). Call once per dashboard load after
 * YATA items are known. Subsequent forecastStock() calls are synchronous.
 *
 * Returns true if any history was loaded, false if none (fresh install,
 * empty table, or network error). Callers can use this to decide whether
 * to skip the "ETA" UI entirely on the first-ever visit.
 *
 * @param {Array<{item_id, destination}>} items
 */
export async function loadForecastData(items) {
  if (!Array.isArray(items) || items.length === 0) {
    historyCache.clear();
    restockCache.clear();
    return false;
  }

  // localStorage short-circuit: a page refresh inside FORECAST_CACHE_TTL_MS
  // hydrates from disk and skips the live Supabase read entirely. The
  // writes from recordSnapshots() still fire (that's the caller's
  // parallel promise in main.js), so we keep contributing data — we
  // just don't pay to re-read what we already had.
  if (hydrateForecastFromStorage()) {
    return historyCache.size > 0 || restockCache.size > 0;
  }

  historyCache.clear();
  restockCache.clear();

  const snapshotCutoff = new Date(Date.now() - HISTORY_WINDOW_MINS * 60_000).toISOString();
  const restockCutoff = new Date(Date.now() - RESTOCK_HISTORY_WINDOW_MINS * 60_000).toISOString();
  const itemIds = [...new Set(items.map(r => r.item_id).filter(Boolean))];
  if (itemIds.length === 0) return false;

  // Snapshots (short window, depletion slope) and restock events (long
  // window, cadence) share no code path but both target the same items —
  // fire them in parallel so total latency is max(snapshot, restock)
  // rather than the sum.
  const [snapshotRes, restockRes] = await Promise.all([
    supabase
      .from('yata_snapshots')
      .select('item_id, destination, quantity, snapped_at')
      .in('item_id', itemIds)
      .gte('snapped_at', snapshotCutoff)
      .order('snapped_at', { ascending: true })
      .then(r => r, e => ({ error: e })),
    // Exclude the one-time migration 018 backfill: those rows carry
    // historical YATA sampling gaps, not current scout cadence, and would
    // pollute the per-shelf median exactly as they did the aggregate before
    // migration 030 filtered them out.
    supabase
      .from('restock_events')
      .select('item_id, destination, restocked_at, pre_observed_at, post_qty')
      .in('item_id', itemIds)
      .gte('restocked_at', restockCutoff)
      .neq('source', 'backfill')
      .order('restocked_at', { ascending: true })
      .then(r => r, e => ({ error: e })),
  ]);

  if (snapshotRes.error) {
    reportSnapshotError(`Stock history read failed: ${snapshotRes.error.message}`);
  } else if (Array.isArray(snapshotRes.data)) {
    for (const row of snapshotRes.data) {
      const key = cacheKey(row.item_id, row.destination);
      let arr = historyCache.get(key);
      if (!arr) {
        arr = [];
        historyCache.set(key, arr);
      }
      arr.push({ quantity: row.quantity, snappedAt: new Date(row.snapped_at).getTime() });
    }
  }

  if (restockRes.error) {
    // Don't toast — restock events are an additive signal. Forecaster will
    // fall back to depletion-only, same as before migration 018. Surfacing
    // this as an error would be more alarming than informative.
  } else if (Array.isArray(restockRes.data)) {
    for (const row of restockRes.data) {
      const key = cacheKey(row.item_id, row.destination);
      let arr = restockCache.get(key);
      if (!arr) {
        arr = [];
        restockCache.set(key, arr);
      }
      arr.push({
        atTime: new Date(row.restocked_at).getTime(),
        // Pre-restock observation time (migration 036). null on legacy rows
        // → estimator falls back to the raw observation time. Used to
        // midpoint-debias the censoring interval (pre, post].
        preTime: row.pre_observed_at ? new Date(row.pre_observed_at).getTime() : null,
        postQty: row.post_qty,
      });
    }
  }

  // Mirror the freshly-fetched maps to localStorage so the next page
  // refresh inside FORECAST_CACHE_TTL_MS can short-circuit the fetch.
  // No-op on private browsing / quota-exceeded — safeSetItem swallows.
  persistForecastToStorage();

  return historyCache.size > 0 || restockCache.size > 0;
}

// ── Quarter-hour tick helpers ────────────────────────────────────────
// Torn restocks land exclusively on :00/:15/:30/:45 TCT (= UTC), so epoch
// math on RESTOCK_TICK_MS gives exact tick boundaries.

function floorTick(ms) {
  return Math.floor(ms / RESTOCK_TICK_MS) * RESTOCK_TICK_MS;
}

function nextTickAfter(ms) {
  return floorTick(ms) + RESTOCK_TICK_MS;
}

function nearestTick(ms) {
  return Math.round(ms / RESTOCK_TICK_MS) * RESTOCK_TICK_MS;
}

/**
 * Best estimate of when a restock event's refill actually landed.
 *
 * The refill happened somewhere in the censoring window (preTime, atTime]
 * AND only on a quarter-hour tick. With the cron's ~5-min sampling the
 * window usually contains exactly one tick — in that case we recover the
 * EXACT refill time, which is strictly better than the v2 midpoint. With
 * multiple ticks in a wide window, pick the tick nearest the midpoint
 * (midpoint = minimum-variance estimate; snapping keeps it physical).
 * If no tick falls inside the window the observation clocks are slightly
 * off (YATA update lag, device skew) — the plain midpoint is the honest
 * fallback. Legacy rows with no preTime snap DOWN to the latest tick at
 * or before the observation, since the refill can't postdate being seen.
 */
function effectiveRestockTime(e) {
  if (e.preTime != null && e.preTime < e.atTime) {
    const first = nextTickAfter(e.preTime); // first tick strictly after pre
    const last = floorTick(e.atTime);       // last tick at/before post
    if (first <= last) {
      const mid = (e.preTime + e.atTime) / 2;
      return Math.min(Math.max(nearestTick(mid), first), last);
    }
    return (e.preTime + e.atTime) / 2;
  }
  return floorTick(e.atTime);
}

/**
 * Median post-restock quantity across all observed events. Kept separate
 * from estimateNextRestock() because it's meaningful from a SINGLE event,
 * while the cadence median needs two — and the half-sellout path below
 * only needs one prior refill to make a timing call.
 */
function medianPostQty(events) {
  if (!events || events.length === 0) return null;
  const q = events.map(e => e.postQty).slice().sort((a, b) => a - b);
  return q[Math.floor(q.length / 2)];
}

// ── Half-sellout-rule restock model ──────────────────────────────────
//
// Torn's documented shop mechanic: a foreign shelf restocks in HALF the
// time it took to sell out, landing on a quarter-hour tick. ("Say it took
// flowers 7 hours to go out of stock, it will take 3 h 30 m to restock.")
// When we observed both ends of the CURRENT cycle — the last refill and
// the moment the shelf hit zero — the next restock is directly computable:
//
//   selloutMins   = emptiedAt − lastRestockAt
//   nextRestockAt = emptiedAt + selloutMins / 2   → snapped to a tick
//
// This beats the cadence median wherever it applies: it's per-cycle (adapts
// the moment demand shifts, where a 30-day median lags), and it needs only
// ONE prior restock event where the cadence needs two. The cadence
// estimator stays as the fallback for shelves whose empty transition
// wasn't observed, or that aren't empty right now.

// Zero-crossing censoring window wider than this → emptiedAt too fuzzy for
// the rule to add anything over the cadence median.
const HALFLIFE_MAX_EMPTY_CENSOR_MINS = 90;
// If the rule's prediction is this far in the past while the shelf is still
// empty, the model missed (bad cycle-start attribution, mechanics edge
// case) — return null and let the cadence median take over rather than
// insisting "next tick!" forever.
const HALFLIFE_MAX_OVERDUE_MINS = 30;
// Sellout-duration sanity bounds. Below 5 min we likely mis-attributed the
// cycle start; beyond 36 h the "cycle" spans more than our observation
// quality supports.
const HALFLIFE_MIN_SELLOUT_MINS = 5;
const HALFLIFE_MAX_SELLOUT_MINS = 36 * 60;

/**
 * Locate the most recent qty>0 → qty=0 transition in the snapshot history.
 * Requires the trailing run to be zeros (shelf observed empty). Returns
 * { emptiedAt, censorMins, lastPositiveAt } or null.
 */
function estimateEmptiedAt(samples) {
  if (!samples || samples.length < 2) return null;
  let i = samples.length - 1;
  if (samples[i].quantity !== 0) return null;
  while (i > 0 && samples[i - 1].quantity === 0) i--;
  if (i === 0) return null; // never observed positive before the zero run
  const lastPositive = samples[i - 1];
  const firstZero = samples[i];
  return {
    // Sellouts happen whenever the last unit sells (no tick constraint),
    // so the censoring-window midpoint is the best estimate.
    emptiedAt: (lastPositive.snappedAt + firstZero.snappedAt) / 2,
    censorMins: (firstZero.snappedAt - lastPositive.snappedAt) / 60_000,
    lastPositiveAt: lastPositive.snappedAt,
  };
}

/**
 * Half-sellout-rule prediction for a currently-empty shelf. Returns
 * { timeToNextMins, uncertaintyMins, confidence, selloutMins } or null
 * when the current cycle wasn't observed well enough.
 */
function estimateHalfSelloutRestock(samples, events, nowMs) {
  const emptied = estimateEmptiedAt(samples);
  if (!emptied) return null;
  if (emptied.censorMins > HALFLIFE_MAX_EMPTY_CENSOR_MINS) return null;

  // Cycle start: the latest refill at/before the last positive observation.
  // (Using lastPositiveAt, not the emptiedAt midpoint, so a refill that
  // landed inside the zero-crossing window can't masquerade as the start
  // of a 2-minute "cycle".)
  let cycleStart = null;
  let cycleStartCensorMins = RESTOCK_TICK_MS / 60_000; // legacy floor-tick uncertainty
  for (let i = events.length - 1; i >= 0; i--) {
    const t = effectiveRestockTime(events[i]);
    if (t <= emptied.lastPositiveAt) {
      cycleStart = t;
      if (events[i].preTime != null && events[i].preTime < events[i].atTime) {
        cycleStartCensorMins = (events[i].atTime - events[i].preTime) / 60_000;
      }
      break;
    }
  }
  if (cycleStart == null) return null;

  const selloutMins = (emptied.emptiedAt - cycleStart) / 60_000;
  if (selloutMins < HALFLIFE_MIN_SELLOUT_MINS || selloutMins > HALFLIFE_MAX_SELLOUT_MINS) {
    return null;
  }

  const rawPredicted = emptied.emptiedAt + (selloutMins / 2) * 60_000;
  const predictedAt = nearestTick(rawPredicted);
  const overdueMins = (nowMs - predictedAt) / 60_000;
  if (overdueMins > HALFLIFE_MAX_OVERDUE_MINS) return null;
  // Slightly overdue → the refill can only land on the NEXT tick from now.
  const targetAt = predictedAt > nowMs ? predictedAt : nextTickAfter(nowMs);

  // Error propagation: emptiedAt appears in both terms of the prediction
  // (×1.5 total), so its ±censor/2 widens by 1.5 → 0.75 × censorMins. The
  // cycle-start error enters at ×0.5 → 0.25 × its censor width. Floor of
  // 8 min covers tick quantization on top.
  const uncertaintyMins = Math.max(
    8,
    Math.round(emptied.censorMins * 0.75 + cycleStartCensorMins * 0.25)
  );
  const confidence = uncertaintyMins <= 15 ? 'high' : uncertaintyMins <= 45 ? 'ok' : 'low';

  return {
    timeToNextMins: (targetAt - nowMs) / 60_000,
    uncertaintyMins,
    confidence,
    selloutMins: Math.round(selloutMins),
  };
}

/**
 * Leave-one-out in-sample MAE: for each observed interval, compute the
 * median of the OTHER intervals and measure the residual. Averaging those
 * residuals tells us how far off the median-predictor typically is when
 * confronted with its own data — a self-check on the restock model that
 * doesn't require new observations or a persisted prediction log.
 *
 * Why leave-one-out: in-sample MAE with the global median systematically
 * underestimates error because each sample pulls the median toward itself.
 * Leaving the sample out gives an honest "what would we have predicted
 * without this datum" residual.
 *
 * Returns MAE in minutes, or null if < 2 gaps (no meaningful LOO).
 */
function computeInSampleMAE(gaps) {
  if (!gaps || gaps.length < 2) return null;
  let sum = 0;
  for (let i = 0; i < gaps.length; i++) {
    const others = [];
    for (let j = 0; j < gaps.length; j++) {
      if (j !== i) others.push(gaps[j]);
    }
    others.sort((a, b) => a - b);
    const medianOthers = others[Math.floor(others.length / 2)];
    sum += Math.abs(gaps[i] - medianOthers);
  }
  return sum / gaps.length;
}

/**
 * Estimate when the next restock is due and how confident we are, given a
 * chronologically-sorted array of `{ atTime, postQty }` events pulled from
 * restock_events.
 *
 * We use the MEDIAN of observed intervals (robust to the occasional missed
 * restock widening one gap to 2x normal) and the MEDIAN post-restock
 * quantity. Uncertainty is the larger of:
 *
 *   - Scaled MAD (1.4826 × MAD) — robust 1-stddev under normality
 *   - In-sample MAE — the median-predictor's actual typical error against
 *     its own history
 *
 * Whichever is wider becomes the reported `±U`. Under a normal distribution
 * scaled MAD and MAE are close (MAE ≈ 0.8 × scaledMAD); when MAE is
 * distinctly larger, the gap distribution has a fat tail and scaled MAD
 * alone would understate reality. Using the max keeps the ±U copy honest
 * regardless of which case we're in.
 *
 * Confidence then gets auto-capped by two separate MAE-based checks:
 *
 *   - MAE > 2 × scaledMAD → step one tier down. Under normality MAE is
 *     always < scaledMAD, so a 2× multiplier means the distribution is
 *     distinctly non-normal and our "we've seen enough samples" confidence
 *     is overclaiming vs. how spread the data actually is.
 *   - MAE > 0.75 × medianInterval → hard-force 'low'. At that spread the
 *     median isn't a meaningful center — half the predictions are off by
 *     more than the interval itself.
 *
 * Needs at least MIN_RESTOCK_EVENTS events (one interval sample) to
 * produce anything. MAE computation needs ≥2 gaps; with only 1 gap the
 * predictor can't be cross-checked, and confidence stays at its base tier
 * (which will be 'low' anyway per the sample-depth rule).
 *
 * Returns {
 *   timeToNextMins: number (minutes to the predicted refill tick; an
 *     overdue prediction resolves to the next upcoming quarter-hour tick),
 *   typicalPostQty: number,
 *   uncertaintyMins: number (≥1, scaled MAD or MAE — whichever wider),
 *   sampleCount: number of interval samples,
 *   cadenceMAE: number|null (in-sample leave-one-out MAE in minutes),
 *   confidence: 'low' | 'ok' | 'high',
 * } or null.
 */
function estimateNextRestock(events, nowMs) {
  if (!events || events.length < MIN_RESTOCK_EVENTS) return null;

  // Effective restock time per event — tick-attributed inside the
  // censoring window (see effectiveRestockTime). Sorted and deduped:
  // two observers of the same physical refill (e.g. a PDA scrape and a
  // cron poll with different observation stamps) resolve to the SAME
  // tick, so dedup here collapses them instead of letting a 2-minute
  // phantom gap drag the median toward zero.
  const effTimes = [...new Set(events.map(effectiveRestockTime))].sort((a, b) => a - b);

  // Intervals between consecutive effective restock times, in minutes.
  // Drop non-positive gaps and anything beyond the 24 h sanity bound.
  let gaps = [];
  for (let i = 1; i < effTimes.length; i++) {
    const g = (effTimes[i] - effTimes[i - 1]) / 60_000;
    if (g > 0 && g <= MAX_RESTOCK_GAP_MINS) gaps.push(g);
  }
  if (gaps.length === 0) return null;

  // Adaptive missed-cycle trim: with enough samples, gaps far beyond the
  // provisional median are almost certainly observation holes that
  // swallowed a whole refill+sellout cycle (they cluster near integer
  // multiples of the true cadence). Trim them, then take the final median
  // from what's left. Guarded so the trim can never empty the pool.
  if (gaps.length >= MIN_GAPS_FOR_TRIM) {
    const provisional = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const trimmed = gaps.filter(g => g <= provisional * MISSED_CYCLE_FACTOR);
    if (trimmed.length >= 2) gaps = trimmed;
  }

  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const medianInterval = sortedGaps[Math.floor(sortedGaps.length / 2)];
  if (!(medianInterval > 0)) return null;

  const typicalPostQty = medianPostQty(events);

  // Project the next refill and snap it onto a quarter-hour tick — a
  // restock physically can't land between ticks. An overdue prediction
  // used to freeze at "0 m / imminent" forever; now it resolves to the
  // next upcoming tick, which is the soonest a refill can actually occur.
  const lastRestockAt = effTimes[effTimes.length - 1];
  const predictedAt = nearestTick(lastRestockAt + medianInterval * 60_000);
  const targetAt = predictedAt > nowMs ? predictedAt : nextTickAfter(nowMs);
  const timeToNextMins = (targetAt - nowMs) / 60_000;

  // Spread estimates.
  const deviations = gaps
    .map(g => Math.abs(g - medianInterval))
    .sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  const scaledMad = mad * 1.4826;
  const cadenceMAE = computeInSampleMAE(gaps);

  // Honest uncertainty: report the larger of scaled MAD and MAE. Clamped
  // to ≥1 min so the display ("±8m") never shows "±0m" on tiny samples.
  const uncertaintyRaw = cadenceMAE != null
    ? Math.max(scaledMad, cadenceMAE)
    : scaledMad;
  const uncertaintyMins = Math.max(1, Math.round(uncertaintyRaw));

  // Base confidence tier from sample depth + MAD tightness.
  //
  //   'high' — ≥5 intervals AND relativeMad ≤ 0.3 (tight, well-observed)
  //   'ok'   — ≥2 intervals AND relativeMad ≤ 0.6
  //   'low'  — anything else
  const relativeMad = mad / medianInterval;
  let confidence;
  if (gaps.length >= 5 && relativeMad <= 0.3) {
    confidence = 'high';
  } else if (gaps.length >= 2 && relativeMad <= 0.6) {
    confidence = 'ok';
  } else {
    confidence = 'low';
  }

  // MAE-based self-correction. Applied AFTER the base tier so the auto-cap
  // can only step confidence DOWN, never up. Two independent checks:
  //
  //   1. MAE > 2 × scaledMAD — distribution is so non-normal that sample-
  //      depth rules are overclaiming. Step one tier down.
  //   2. MAE > 0.75 × medianInterval — residuals on the scale of the
  //      interval itself. Hard-force 'low' regardless of sample depth.
  //
  // computeInSampleMAE needs ≥2 gaps, matching the base-tier 'ok' threshold,
  // so this check is meaningful wherever it fires.
  if (cadenceMAE != null) {
    if (cadenceMAE > medianInterval * 0.75) {
      confidence = 'low';
    } else if (cadenceMAE > scaledMad * 2 && scaledMad > 0) {
      confidence = confidence === 'high' ? 'ok' : 'low';
    }
  }

  return {
    timeToNextMins,
    typicalPostQty,
    uncertaintyMins,
    sampleCount: gaps.length,
    cadenceMAE,
    confidence,
    medianIntervalMins: medianInterval,
  };
}

/**
 * Split a chronologically-sorted sample array into every maximal run of
 * non-increasing quantity. A run ends (and a new one begins) at the first
 * strictly-positive delta — that's a restock, and samples on either side
 * belong to different "depletion cycles" of the shelf.
 *
 * Unlike the earlier latestDepletionSegment(), this returns EVERY run in
 * the history window so the slope estimator can pool them. The pooled
 * rate converges on the shelf's true steady-state depletion rate as more
 * scrape data accumulates — the goal is "the" rate for the shelf, not a
 * reactive per-minute reading.
 *
 * @param {Array<{quantity:number, snappedAt:number}>} samples - asc by snappedAt
 * @returns {Array<Array<{quantity:number, snappedAt:number}>>}
 */
function allDepletionSegments(samples) {
  if (!samples || samples.length < 2) return [];
  const segments = [];
  let current = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const prev = current[current.length - 1];
    if (samples[i].quantity > prev.quantity) {
      // Restock boundary — close out the current segment and start fresh.
      if (current.length >= 2) segments.push(current);
      current = [samples[i]];
    } else {
      current.push(samples[i]);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

/**
 * Least-squares linear regression of quantity vs. minutes-since-segment-
 * start. Uses every sample in the segment, not just the endpoints, so a
 * long run with many intermediate observations produces a slope estimate
 * that reflects all of them rather than just whichever two happen to be
 * first and last.
 *
 * @returns {number|null} slope in units/min, or null for degenerate cases
 *   (fewer than 2 samples, or all samples at the same instant).
 */
function fitSegmentSlope(segment) {
  if (!segment || segment.length < 2) return null;
  const t0 = segment[0].snappedAt;
  let n = 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const s of segment) {
    const x = (s.snappedAt - t0) / 60_000; // minutes since segment start
    const y = s.quantity;
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
    n++;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null; // all samples at the same timestamp
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Pool per-segment slopes into one "depletion rate" estimate for the shelf.
 *
 * Philosophy (from user feedback): Torn's popular shelves like Xanax-JPN
 * have a stable steady-state emptying rate driven by buyers grabbing
 * stacks of 29 at a time. Individual segments are noisy; the average
 * behaviour across many segments is what we actually want the UI to
 * show. More scrape data → tighter estimate.
 *
 * Weighted median (not mean): a single runaway segment — e.g. a burst
 * where one buyer stripped 200 units in under a minute — would skew a
 * mean toward fiction. Median is robust to that. Weight by segment
 * sample count so longer, better-observed runs count more than a
 * two-sample sliver.
 *
 * Positive-slope segments are skipped: the segment walker guarantees
 * non-increasing runs, so a strictly-positive fit means numerical
 * noise on a near-flat segment. A flat slope (0) is a real
 * observation — "shelf didn't move during this window" — and stays in
 * the pool.
 *
 * @returns {{slope:number, segmentCount:number, totalSamples:number, spanMins:number}|null}
 */
function pooledDepletionSlope(segments) {
  const weighted = [];
  let totalSamples = 0;
  let spanMins = 0;
  for (const seg of segments) {
    const s = fitSegmentSlope(seg);
    if (s == null || s > 0) continue;
    weighted.push({ slope: s, weight: seg.length });
    totalSamples += seg.length;
    spanMins += (seg[seg.length - 1].snappedAt - seg[0].snappedAt) / 60_000;
  }
  if (weighted.length === 0) return null;
  weighted.sort((a, b) => a.slope - b.slope);
  const totalWeight = weighted.reduce((sum, x) => sum + x.weight, 0);
  let acc = 0;
  let pickedSlope = weighted[weighted.length - 1].slope;
  for (const w of weighted) {
    acc += w.weight;
    if (acc >= totalWeight / 2) { pickedSlope = w.slope; break; }
  }
  return {
    slope: pickedSlope,
    segmentCount: weighted.length,
    totalSamples,
    spanMins,
  };
}

/**
 * Forecast arrival-time stock for (item, destination) given one-way flight
 * time. Returns a result object that ALWAYS includes a usable `nowQty` and
 * `etaQty`; callers can trust both numbers even when history is thin.
 *
 * `restockEtaMins` is set ONLY when we have enough history to project one
 * and the current stock is empty — otherwise we leave the depletion-only
 * story alone. Rationale: bumping a non-zero ETA upward to "predict a
 * restock during flight" doubles up two noisy signals; on a row that's at
 * 0 now, adding a restock prediction is the difference between "false
 * negative" and "useful answer".
 *
 * @param {number} itemId
 * @param {string} destination
 * @param {number} arrivalMins - one-way flight duration accounting for multipliers
 * @param {number|null} fallbackNowQty - YATA's current reading, used when
 *        the history cache has nothing for this (item, destination)
 * @returns {{
 *   nowQty: number|null,
 *   etaQty: number|null,
 *   etaPostRefill: boolean,                  // true when etaQty depends on a restock event landing during this flight. UI may add a "post-refill" indicator so the player knows the prediction is conditional on the cadence holding.
 *   confidence: 'none'|'low'|'ok',          // depletion-slope fit confidence
 *   hasHistory: boolean,
 *   timeToEmptyMins: number|null,           // null if not depleting, > 24h, or no slope
 *   depletionPerMin: number|null,           // pooled units/min slope (≤0). null when no usable slope. Exposed so UI can show the steady-state rate independent of current stock — a shelf at 0 still has a meaningful depletion rate from prior cycles.
 *   nextRestockMins: number|null,           // raw time-to-next-restock (un-gated, minutes from now)
 *   restockEtaMins: number|null,            // only set when restock is expected DURING this flight
 *   restockQty: number|null,                // typical post-restock qty, set whenever cadence exists
 *   restockUncertaintyMins: number|null,    // max(scaled MAD, in-sample MAE) — widened when model underclaims
 *   restockConfidence: 'none'|'low'|'ok'|'high',  // auto-capped when MAE exceeds scaledMAD × 2 or 0.75 × median
 *   restockBasis: 'halftime'|'cadence'|null, // which model made the timing call: Torn's half-sellout rule (empty shelf, observed cycle) or the cadence median
 *   restockIntervalMins: number|null,       // median observed interval between restocks (un-gated by confidence; UI gates display)
 *   cadenceMAE: number|null,                // leave-one-out in-sample MAE (minutes), null when <2 gaps
 *   restockEventCount: number               // raw count of observed restocks (30-day window) for "cadence forming (N obs)" hints
 * }}
 */
export function forecastStock(itemId, destination, arrivalMins, fallbackNowQty = null) {
  const key = cacheKey(itemId, destination);
  const samples = historyCache.get(key);
  const nowMs = Date.now();

  // Restock cadence comes from the dedicated `restock_events` table (30-day
  // window, append-only) rather than rescanning the short snapshot window.
  // Computed up front because it's independent of depletion samples — even
  // a brand-new item with no snapshots yet can still have backfilled restock
  // events, and a shelf at 0 benefits from the refill prediction regardless.
  const restockEvents = restockCache.get(key) || [];
  const cadenceEst = estimateNextRestock(restockEvents, nowMs);

  // Half-sellout-rule prediction — Torn's actual restock mechanic — takes
  // priority for a currently-empty shelf whose cycle we observed (last
  // refill + zero-crossing both in view). Empty-shelf timing is exactly
  // the case players plan flights around ("leave in X → land at refill"),
  // and the rule is per-cycle where the cadence median is a 30-day blur.
  const latestSample = samples && samples.length > 0 ? samples[samples.length - 1] : null;
  const liveNowQty = fallbackNowQty ?? (latestSample ? latestSample.quantity : null);
  const halfEst = (liveNowQty === 0 && restockEvents.length > 0)
    ? estimateHalfSelloutRestock(samples, restockEvents, nowMs)
    : null;
  const restockEst = halfEst || cadenceEst;
  const restockBasis = halfEst ? 'halftime' : (cadenceEst ? 'cadence' : null);

  const restockDuringFlight = !!(
    restockEst && restockEst.timeToNextMins <= arrivalMins
  );
  // `nextRestockMins` is the raw "time until next restock" regardless of
  // whether it lands during this flight — fuels the "leave in X minutes"
  // upcoming-window card. `restockEtaMins` stays gated to during-flight
  // because the Stock cell's semantic is "a refill happens WHILE I'm in
  // the air", and unchaining it would make that UI lie.
  const nextRestockMins = restockEst ? Math.round(restockEst.timeToNextMins) : null;
  const restockEtaMins = restockDuringFlight ? nextRestockMins : null;
  // `restockQty` and `restockUncertaintyMins` are un-gated so the Leave
  // Soon card can see them even when the window is in the future rather
  // than currently in-flight. Stock cell still keys off `restockEtaMins`
  // to decide whether to show them, so the cell's behavior is unchanged.
  // Post-restock qty is a per-shelf property independent of which timing
  // model fired — the events median covers both (and works from 1 event).
  const restockQty = restockEst ? medianPostQty(restockEvents) : null;
  const restockUncertaintyMins = restockEst ? restockEst.uncertaintyMins : null;
  const restockConfidence = restockEst ? restockEst.confidence : 'none';
  // Median observed interval between restocks (minutes). A steady-state
  // descriptor, so it stays cadence-based even when the half-sellout rule
  // is making the timing call.
  const restockIntervalMins = cadenceEst ? Math.round(cadenceEst.medianIntervalMins) : null;
  // Cadence MAE (leave-one-out in-sample, minutes). Exposed for future
  // observability — a layer-2 accuracy log or a debug panel can read it
  // without re-running estimateNextRestock. null when <2 gaps.
  const cadenceMAE = cadenceEst ? cadenceEst.cadenceMAE : null;
  // Raw count of observed restocks for this shelf over the 30-day window.
  // Independent of whether they were enough to produce a prediction — the
  // UI uses this to render "cadence forming (N obs)" hints on rows where
  // we're watching but haven't accumulated enough (or regular enough) data
  // to commit to a leave-in recommendation.
  const restockEventCount = restockCache.get(key)?.length ?? 0;

  // No snapshot history at all — can't fit a depletion slope, so etaQty
  // falls back to Now. Still honor the restock prediction if Now is empty:
  // that's the whole point of keeping cadence in a separate long-window
  // table — a fresh shelf with zero snapshots can still say "restock
  // expected in 40m" if backfill filled in its cadence.
  //
  // Guard on `restockEtaMins` (during-flight), NOT `restockQty` — the
  // latter is un-gated and set whenever cadence exists, so using it
  // here would show arrival-time qty of `restockQty` for shelves whose
  // next restock is hours after we'd land. That's how Xanax-JPN got a
  // bogus "ETA 744" when Japan's flight is 9 h and cadence put the
  // restock well beyond that.
  //
  // hasHistory is true only when we'll actually project something useful
  // (Now=0 with a restock during flight). Setting it true on the general
  // "we have restock events but nothing interesting to say right now" case
  // would make the UI render a redundant "Now N / ETA N" line.
  if (!samples || samples.length === 0) {
    const nowQty = fallbackNowQty;
    const restockCoversEmptyShelf = nowQty === 0 && restockEtaMins != null;
    // hasHistory also trips when we have any actionable cadence signal —
    // the UI needs to reach the stock-cell render logic so the leave-in-X
    // branch can fire for fresh shelves with backfilled restock history
    // but zero snapshots yet. Without this, those shelves render as a
    // naked "Now N" and the user loses the wait-to-leave hint.
    const hasActionableCadence = restockEst != null && restockQty != null;
    const eta = restockCoversEmptyShelf ? restockQty : nowQty;
    return {
      nowQty,
      etaQty: eta,
      // No depletion slope on this branch (no snapshots), so a
      // post-refill projection here is just bare typicalPostQty —
      // unmarked. Marking it true would imply we modeled depletion
      // when we didn't.
      etaPostRefill: false,
      confidence: nowQty != null ? 'low' : 'none',
      hasHistory: restockCoversEmptyShelf || hasActionableCadence,
      timeToEmptyMins: null,
      depletionPerMin: null,
      nextRestockMins,
      restockEtaMins,
      restockQty,
      restockUncertaintyMins,
      restockConfidence,
      restockBasis,
      restockIntervalMins,
      cadenceMAE,
      restockEventCount,
    };
  }

  const latest = samples[samples.length - 1];
  // Anchor the projection on YATA's live reading (what the UI labels "Now"),
  // not the latest DB snapshot. Snapshots can be older than the current page
  // load — another user may have written the most recent row with a stale
  // YATA reading, or our own write hasn't landed yet (recordSnapshots and
  // loadForecastData race in main.js). Using fallbackNowQty keeps the ETA
  // line internally consistent with the "Now" column above it. We only fall
  // back to the snapshot number if YATA didn't give us one this visit.
  const nowQty = fallbackNowQty ?? latest.quantity;

  // Pool slopes across every depletion segment in the window. A "segment"
  // is a run of non-increasing quantity bounded by a restock on either
  // side — see allDepletionSegments(). For a shelf we've observed
  // through multiple restock cycles, this fuses every cycle's rate into
  // one steady-state estimate via a weight-by-sample-count median; for a
  // shelf we've only seen once, it reduces to a least-squares fit on
  // that single run (still an improvement over endpoint-to-endpoint).
  //
  // Returns null when no usable depletion signal exists — too few
  // samples, a single post-restock sample, or every segment degenerate.
  const pooled = pooledDepletionSlope(allDepletionSegments(samples));
  if (!pooled) {
    // If the shelf is empty and a restock is due before we land, project
    // the refill; otherwise keep etaQty pinned to nowQty and mark low
    // confidence.
    const eta = (nowQty === 0 && restockEtaMins != null) ? restockQty : nowQty;
    const etaPostRefill = (nowQty === 0 && restockEtaMins != null);
    return {
      nowQty, etaQty: eta, etaPostRefill, confidence: 'low', hasHistory: true,
      timeToEmptyMins: null,
      depletionPerMin: null,
      nextRestockMins, restockEtaMins, restockQty, restockUncertaintyMins, restockConfidence, restockBasis, restockIntervalMins, cadenceMAE, restockEventCount,
    };
  }

  // slope is quantity-per-minute; depleting shelves make it ≤ 0.
  const slope = pooled.slope;
  const projected = nowQty + slope * arrivalMins;

  // Time-to-empty: how long until the shelf hits 0 at the current slope.
  // Null unless the shelf is actually depleting (slope < 0) AND has stock
  // to deplete. Capped at 24 h — beyond that the answer is "not emptying
  // any time soon" and a precise number would be noise, not signal.
  let timeToEmptyMins = null;
  if (slope < 0 && nowQty > 0) {
    const rawMins = nowQty / -slope;
    if (rawMins <= 24 * 60) timeToEmptyMins = Math.round(rawMins);
  }
  // Clamp within [0, nowQty]. A depletion run cannot grow — any positive
  // projection would indicate the segment picked up noise or a restock the
  // walker missed. Rather than show a misleading ETA higher than Now, pin
  // the ETA to Now (i.e., "no confident depletion") and let the confidence
  // flag tell the rest of the story.
  let etaQty = Math.max(0, Math.min(nowQty, Math.round(projected)));

  // Restock override: if the depletion forecast bottomed out at 0 AND a
  // restock is expected DURING THIS FLIGHT, replace the empty shelf with
  // the typical post-restock quantity, then drain it by the steady-state
  // depletion slope for the time between the restock event and arrival.
  // Without the post-restock depletion the projection is wildly
  // optimistic on popular shelves — Xanax-JPN sees ~21 units/min of
  // buyers, so a 1057-unit refill at the 1-hour mark of a 4-hour flight
  // realistically lands closer to empty than full.
  //
  // Gated on `restockEtaMins` (during-flight) rather than `restockQty`
  // (un-gated, set whenever cadence data exists) — otherwise we'd
  // inflate arrival-time stock with a restock that won't land until long
  // after the traveler is home.
  //
  // Limitation: models only the *next* restock event. A shelf with a
  // 1-hour cadence on a 4-hour flight can restock 3-4 times during
  // flight, which we don't track. Single-event-plus-depletion is still
  // strictly more accurate than no post-restock depletion.
  let etaPostRefill = false;
  if (etaQty === 0 && restockEtaMins != null) {
    const minsAfterRestock = arrivalMins - restockEtaMins;
    etaQty = Math.max(0, Math.round(restockQty + slope * minsAfterRestock));
    etaPostRefill = true;
  }

  // Confidence tiers off the pooled totals. Observing the shelf through
  // more than one restock cycle means the slope is an average of
  // multiple independent depletion runs — the most robust signal the
  // pooled estimator produces. `totalSamples` and `spanMins` are both
  // summed across segments, matching the intent of the original
  // single-segment thresholds.
  let confidence = 'low';
  if (pooled.totalSamples >= MIN_SAMPLES_FOR_OK && pooled.spanMins >= MIN_SPAN_MINS_FOR_OK) {
    confidence = pooled.segmentCount >= 2 ? 'high' : 'ok';
  }

  return {
    nowQty, etaQty, etaPostRefill, confidence, hasHistory: true,
    timeToEmptyMins,
    depletionPerMin: slope,
    nextRestockMins, restockEtaMins, restockQty, restockUncertaintyMins, restockConfidence, restockBasis, restockIntervalMins, cadenceMAE, restockEventCount,
  };
}

/**
 * Phase 0 ground-truth logger. For every (item, destination) we can make a
 * restock-timing prediction for, write a row into `forecast_predictions`
 * (migration 035) carrying the absolute predicted restock time, post-restock
 * qty, depletion slope, and confidence. A DB trigger on restock_events later
 * resolves each row against the next real restock, stamping the signed error
 * — that's the out-of-sample accuracy the in-sample MAE can't give us.
 *
 * Must run AFTER loadForecastData() so the in-memory caches are populated.
 * Fire-and-forget: throttled per browser, errors swallowed. Call once per
 * dashboard load with the merged YATA+scrape item list.
 *
 * `predicted_restock_at` is absolute and flight-independent, so we forecast
 * with arrivalMins=0 — only the flight-agnostic fields are read here.
 *
 * @param {Array<{item_id, destination, quantity}>} items
 */
export async function recordForecastPredictions(items) {
  if (!Array.isArray(items) || items.length === 0) return;

  // Per-browser throttle. The DB's 10-min dedup bucket is the real guard
  // against cross-user duplication; this just avoids re-attempting the
  // write on every reload within the window.
  const lastRaw = safeGetItem(PREDICTION_LOG_KEY);
  const lastAt = lastRaw ? Number(lastRaw) : 0;
  if (Number.isFinite(lastAt) && Date.now() - lastAt < PREDICTION_LOG_INTERVAL_MS) {
    return;
  }

  const nowMs = Date.now();
  const rows = [];
  const seen = new Set(); // dedup within this batch (item|destination)
  for (const it of items) {
    if (!it.item_id || !it.destination) continue;
    const key = `${it.item_id}|${it.destination}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // arrivalMins=0: predicted_restock_at, restockQty, depletionPerMin and
    // restockConfidence are all independent of flight duration.
    const f = forecastStock(it.item_id, it.destination, 0, it.quantity ?? null);
    // Only log rows where we actually committed to a restock-timing call —
    // otherwise there's nothing for the resolver to score.
    if (f.nextRestockMins == null) continue;

    rows.push({
      item_id: it.item_id,
      destination: it.destination,
      model_version: MODEL_VERSION,
      predicted_restock_at: new Date(nowMs + f.nextRestockMins * 60_000).toISOString(),
      predicted_post_qty: f.restockQty ?? null,
      predicted_depletion_per_min: f.depletionPerMin ?? null,
      restock_confidence: f.restockConfidence ?? null,
    });
  }

  if (rows.length === 0) {
    // Still stamp the throttle so we don't recompute every reload when the
    // pool has no predictable shelves yet.
    safeSetItem(PREDICTION_LOG_KEY, String(nowMs));
    return;
  }

  try {
    // ignoreDuplicates lets the (item, destination, predicted_bucket,
    // model_version) unique index quietly collapse concurrent writers.
    const { error } = await supabase
      .from('forecast_predictions')
      .upsert(rows, {
        onConflict: 'item_id,destination,predicted_bucket,model_version',
        ignoreDuplicates: true,
      });
    // Stamp the throttle regardless — a failed write shouldn't make us retry
    // in a tight reload loop. Accuracy logging is additive, never load-bearing.
    safeSetItem(PREDICTION_LOG_KEY, String(nowMs));
    if (error) {
      // Quietly — this is an observability surface, not user-facing. A
      // failure just means a thinner accuracy sample, same as pre-Phase-0.
      return;
    }
  } catch {
    safeSetItem(PREDICTION_LOG_KEY, String(nowMs));
  }
}
