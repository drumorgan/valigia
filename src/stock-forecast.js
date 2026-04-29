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
const FORECAST_CACHE_KEY = 'valigia_forecast_cache_v1';
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

  const rows = items
    .filter(r => r.item_id && r.destination && r.quantity != null)
    .map(r => ({
      item_id: r.item_id,
      destination: r.destination,
      quantity: r.quantity,
      buy_price: r.buy_price ?? null,
    }));

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
  const itemIds = [...new Set(rows.map(r => r.item_id))];
  const latestMap = new Map(); // "itemId|destination" -> { quantity, buy_price }
  try {
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
    // If the read failed, fall through to unfiltered insert. Worst case is
    // one duplicate row — better than dropping a transition entirely.
  } catch {
    // Same fall-through — treat unknown latest as "no prior reading".
  }

  const changed = rows.filter(r => {
    const prev = latestMap.get(`${r.item_id}|${r.destination}`);
    if (!prev) return true; // never seen — always record
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
  try {
    const { error } = await supabase
      .from('yata_snapshots')
      .upsert(changed, {
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
  const nowIso = new Date().toISOString();
  for (const row of changed) {
    const prev = latestMap.get(`${row.item_id}|${row.destination}`);
    if (prev && row.quantity > prev.quantity) {
      restockEvents.push({
        item_id: row.item_id,
        destination: row.destination,
        restocked_at: nowIso,
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
    supabase
      .from('restock_events')
      .select('item_id, destination, restocked_at, post_qty')
      .in('item_id', itemIds)
      .gte('restocked_at', restockCutoff)
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
 *   timeToNextMins: number (can be 0 if overdue),
 *   typicalPostQty: number,
 *   uncertaintyMins: number (≥1, scaled MAD or MAE — whichever wider),
 *   sampleCount: number of interval samples,
 *   cadenceMAE: number|null (in-sample leave-one-out MAE in minutes),
 *   confidence: 'low' | 'ok' | 'high',
 * } or null.
 */
function estimateNextRestock(events, nowMs) {
  if (!events || events.length < MIN_RESTOCK_EVENTS) return null;

  // Intervals between consecutive restock events, in minutes.
  const gaps = [];
  for (let i = 1; i < events.length; i++) {
    gaps.push((events[i].atTime - events[i - 1].atTime) / 60_000);
  }
  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const medianInterval = sortedGaps[Math.floor(sortedGaps.length / 2)];
  if (!(medianInterval > 0)) return null;

  const postQtys = events.map(e => e.postQty).slice().sort((a, b) => a - b);
  const typicalPostQty = postQtys[Math.floor(postQtys.length / 2)];

  const lastRestockAt = events[events.length - 1].atTime;
  const sinceLastMins = (nowMs - lastRestockAt) / 60_000;
  const timeToNextMins = Math.max(0, medianInterval - sinceLastMins);

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
 *   confidence: 'none'|'low'|'ok',          // depletion-slope fit confidence
 *   hasHistory: boolean,
 *   timeToEmptyMins: number|null,           // null if not depleting, > 24h, or no slope
 *   depletionPerMin: number|null,           // pooled units/min slope (≤0). null when no usable slope. Exposed so UI can show the steady-state rate independent of current stock — a shelf at 0 still has a meaningful depletion rate from prior cycles.
 *   nextRestockMins: number|null,           // raw time-to-next-restock (un-gated, minutes from now)
 *   restockEtaMins: number|null,            // only set when restock is expected DURING this flight
 *   restockQty: number|null,                // typical post-restock qty, set whenever cadence exists
 *   restockUncertaintyMins: number|null,    // max(scaled MAD, in-sample MAE) — widened when model underclaims
 *   restockConfidence: 'none'|'low'|'ok'|'high',  // auto-capped when MAE exceeds scaledMAD × 2 or 0.75 × median
 *   restockIntervalMins: number|null,       // median observed interval between restocks (un-gated by confidence; UI gates display)
 *   cadenceMAE: number|null,                // leave-one-out in-sample MAE (minutes), null when <2 gaps
 *   restockEventCount: number               // raw count of observed restocks (30-day window) for "cadence forming (N obs)" hints
 * }}
 */
export function forecastStock(itemId, destination, arrivalMins, fallbackNowQty = null) {
  const key = cacheKey(itemId, destination);
  const samples = historyCache.get(key);

  // Restock cadence comes from the dedicated `restock_events` table (30-day
  // window, append-only) rather than rescanning the short snapshot window.
  // Computed up front because it's independent of depletion samples — even
  // a brand-new item with no snapshots yet can still have backfilled restock
  // events, and a shelf at 0 benefits from the refill prediction regardless.
  const restockEvents = restockCache.get(key) || [];
  const restockEst = estimateNextRestock(restockEvents, Date.now());
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
  const restockQty = restockEst ? restockEst.typicalPostQty : null;
  const restockUncertaintyMins = restockEst ? restockEst.uncertaintyMins : null;
  const restockConfidence = restockEst ? restockEst.confidence : 'none';
  // Median observed interval between restocks (minutes). Exposed alongside
  // confidence so the UI can decide whether to render it ("refill ~42m"
  // line on the row) — typicalPostQty + timeToNextMins handle the
  // "what/when" but not the steady-state cadence.
  const restockIntervalMins = restockEst ? Math.round(restockEst.medianIntervalMins) : null;
  // Cadence MAE (leave-one-out in-sample, minutes). Exposed for future
  // observability — a layer-2 accuracy log or a debug panel can read it
  // without re-running estimateNextRestock. null when <2 gaps.
  const cadenceMAE = restockEst ? restockEst.cadenceMAE : null;
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
      confidence: nowQty != null ? 'low' : 'none',
      hasHistory: restockCoversEmptyShelf || hasActionableCadence,
      timeToEmptyMins: null,
      depletionPerMin: null,
      nextRestockMins,
      restockEtaMins,
      restockQty,
      restockUncertaintyMins,
      restockConfidence,
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
    return {
      nowQty, etaQty: eta, confidence: 'low', hasHistory: true,
      timeToEmptyMins: null,
      depletionPerMin: null,
      nextRestockMins, restockEtaMins, restockQty, restockUncertaintyMins, restockConfidence, restockIntervalMins, cadenceMAE, restockEventCount,
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
  // the typical post-restock quantity. Gated on `restockEtaMins` (during-
  // flight) rather than `restockQty` (un-gated, set whenever cadence data
  // exists) — otherwise we'd inflate arrival-time stock with a restock
  // that won't land until long after the traveler is home. This is the
  // classic Xanax-JPN failure mode at work on the depletion branch too.
  if (etaQty === 0 && restockEtaMins != null) {
    etaQty = restockQty;
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
    nowQty, etaQty, confidence, hasHistory: true,
    timeToEmptyMins,
    depletionPerMin: slope,
    nextRestockMins, restockEtaMins, restockQty, restockUncertaintyMins, restockConfidence, restockIntervalMins, cadenceMAE, restockEventCount,
  };
}
