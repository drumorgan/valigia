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

function cacheKey(itemId, destination) {
  return `${itemId}|${destination}`;
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
  // Race condition accepted: if two users load simultaneously and both see
  // "no row yet" they'll each insert — one duplicate, not a regression.
  // The next prune sweep catches it, or it dedups out when one changes.
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
  try {
    const { error } = await supabase.from('yata_snapshots').insert(changed);
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
  historyCache.clear();
  restockCache.clear();
  if (!Array.isArray(items) || items.length === 0) return false;

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

  return historyCache.size > 0 || restockCache.size > 0;
}

/**
 * Estimate when the next restock is due and how confident we are, given a
 * chronologically-sorted array of `{ atTime, postQty }` events pulled from
 * restock_events.
 *
 * We use the MEDIAN of observed intervals (robust to the occasional missed
 * restock widening one gap to 2x normal) and the MEDIAN post-restock
 * quantity. Uncertainty is scaled Median Absolute Deviation: `1.4826 * MAD`
 * approximates one standard deviation for a normal distribution, but MAD
 * shrugs off outliers that a plain stddev would blow up on.
 *
 * Needs at least MIN_RESTOCK_EVENTS events (one interval sample) to
 * produce anything.
 *
 * Returns {
 *   timeToNextMins: number (can be 0 if overdue),
 *   typicalPostQty: number,
 *   uncertaintyMins: number (≥1, scaled MAD — "±Nm" label in the UI),
 *   sampleCount: number of interval samples,
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

  // Scaled MAD: robust 1-stddev equivalent. Clamped to ≥1 min so the
  // display ("±8m") never shows "±0m" on tiny sample counts.
  const deviations = gaps
    .map(g => Math.abs(g - medianInterval))
    .sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  const uncertaintyMins = Math.max(1, Math.round(mad * 1.4826));

  // Confidence tiers are driven by BOTH sample depth and cadence tightness.
  // Relative MAD (MAD / median) is the scale-free "how regular is this
  // shelf" signal — a 5-min MAD on a 10-min cycle is chaos, the same 5m on
  // a 4h cycle is basically perfect. Thresholds chosen conservatively so
  // "high" is only shown when we genuinely trust the number.
  const relativeMad = mad / medianInterval;
  let confidence;
  if (gaps.length >= 5 && relativeMad <= 0.3) {
    confidence = 'high';
  } else if (gaps.length >= 3 && relativeMad <= 0.5) {
    confidence = 'ok';
  } else {
    confidence = 'low';
  }

  return {
    timeToNextMins,
    typicalPostQty,
    uncertaintyMins,
    sampleCount: gaps.length,
    confidence,
  };
}

/**
 * Find the most recent monotonic-non-increasing run in the sample series.
 * This is the cheapest way to avoid a linear fit being corrupted by a
 * restock jump (quantity suddenly goes up). We walk backward from the
 * newest sample and stop as soon as we see a strictly earlier sample with
 * a smaller quantity — that's a restock event, anything before it belongs
 * to a different "run".
 *
 * Returns the segment in chronological order, or null if < 2 samples.
 */
function latestDepletionSegment(samples) {
  if (!samples || samples.length < 2) return null;
  // samples already sorted asc by snappedAt from Supabase `.order(...asc)`
  const segment = [samples[samples.length - 1]];
  for (let i = samples.length - 2; i >= 0; i--) {
    const next = segment[0];
    // If the earlier sample has STRICTLY LESS quantity than the later one,
    // a restock happened between them — stop.
    if (samples[i].quantity < next.quantity) break;
    segment.unshift(samples[i]);
  }
  return segment.length >= 2 ? segment : null;
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
 *   nextRestockMins: number|null,           // raw time-to-next-restock (un-gated, minutes from now)
 *   restockEtaMins: number|null,            // only set when restock is expected DURING this flight
 *   restockQty: number|null,                // typical post-restock qty, set whenever cadence exists
 *   restockUncertaintyMins: number|null,    // scaled MAD of interval samples, set whenever cadence exists
 *   restockConfidence: 'none'|'low'|'ok'|'high'
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
      nextRestockMins,
      restockEtaMins,
      restockQty,
      restockUncertaintyMins,
      restockConfidence,
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

  const segment = latestDepletionSegment(samples);
  if (!segment) {
    // Only one sample in cache, or we just restocked — no slope to extrapolate.
    // If the shelf is empty and a restock is due before we land, project the
    // refill; otherwise keep etaQty pinned to nowQty.
    const eta = (nowQty === 0 && restockEtaMins != null) ? restockQty : nowQty;
    return {
      nowQty, etaQty: eta, confidence: 'low', hasHistory: true,
      timeToEmptyMins: null,
      nextRestockMins, restockEtaMins, restockQty, restockUncertaintyMins, restockConfidence,
    };
  }

  const first = segment[0];
  const last = segment[segment.length - 1];
  const spanMins = (last.snappedAt - first.snappedAt) / 60_000;
  if (spanMins < 1) {
    const eta = (nowQty === 0 && restockEtaMins != null) ? restockQty : nowQty;
    return {
      nowQty, etaQty: eta, confidence: 'low', hasHistory: true,
      timeToEmptyMins: null,
      nextRestockMins, restockEtaMins, restockQty, restockUncertaintyMins, restockConfidence,
    };
  }

  // slope is quantity-per-minute; depleting shelves make it ≤ 0.
  const slope = (last.quantity - first.quantity) / spanMins;
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

  const confidence =
    segment.length >= MIN_SAMPLES_FOR_OK && spanMins >= MIN_SPAN_MINS_FOR_OK
      ? 'ok'
      : 'low';

  return {
    nowQty, etaQty, confidence, hasHistory: true,
    timeToEmptyMins,
    nextRestockMins, restockEtaMins, restockQty, restockUncertaintyMins, restockConfidence,
  };
}
