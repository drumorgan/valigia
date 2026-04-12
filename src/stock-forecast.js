// Stock forecasting — predicts what abroad stock will look like when the
// traveler actually lands, not what it is "right now".
//
// The Stock column in the UI historically showed YATA's current quantity
// and clamped effective_slots to min(slots, currentQty). For long flights
// (UAE, Japan, South Africa: ~3 h one-way) that's fiction — shelves empty
// or restock before you arrive. This module reads a short history of
// snapshots from Supabase, fits a simple depletion slope, and projects the
// quantity at arrival time.
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

// How far back to look when estimating depletion. Beyond this, samples are
// too old to reflect the current rate of play.
const HISTORY_WINDOW_MINS = 240; // 4 h

// How old a snapshot is allowed to be before the prune sweep drops it.
const PRUNE_OLDER_THAN_MINS = 240; // 4 h

// Minimum samples + minimum span before we upgrade confidence from "low" to "ok".
const MIN_SAMPLES_FOR_OK = 3;
const MIN_SPAN_MINS_FOR_OK = 20;

// In-memory cache keyed by `${itemId}|${destination}`.
// Populated once per page load via loadForecastData().
const historyCache = new Map();

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

  // Supabase-js v2 does NOT throw on write errors — it returns an `error`
  // object. A bare try/catch around .insert() was catching nothing, which
  // hid a silent RLS/permission failure during initial rollout. Surface
  // the real Postgres message to the user once per session so the UI is
  // an honest diagnostic surface (we're iPad-only, no DevTools).
  try {
    const { error } = await supabase.from('yata_snapshots').insert(rows);
    if (error) {
      reportSnapshotError(`Stock history write failed: ${error.message}`);
    }
  } catch (e) {
    reportSnapshotError(`Stock history write threw: ${e?.message || e}`);
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
  if (!Array.isArray(items) || items.length === 0) return false;

  const cutoff = new Date(Date.now() - HISTORY_WINDOW_MINS * 60_000).toISOString();
  const itemIds = [...new Set(items.map(r => r.item_id).filter(Boolean))];
  if (itemIds.length === 0) return false;

  try {
    const { data, error } = await supabase
      .from('yata_snapshots')
      .select('item_id, destination, quantity, snapped_at')
      .in('item_id', itemIds)
      .gte('snapped_at', cutoff)
      .order('snapped_at', { ascending: true });

    if (error) {
      reportSnapshotError(`Stock history read failed: ${error.message}`);
      return false;
    }
    if (!Array.isArray(data)) return false;

    for (const row of data) {
      const key = cacheKey(row.item_id, row.destination);
      let arr = historyCache.get(key);
      if (!arr) {
        arr = [];
        historyCache.set(key, arr);
      }
      arr.push({ quantity: row.quantity, snappedAt: new Date(row.snapped_at).getTime() });
    }
    return historyCache.size > 0;
  } catch {
    return false;
  }
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
 * @param {number} itemId
 * @param {string} destination
 * @param {number} arrivalMins - one-way flight duration accounting for multipliers
 * @param {number|null} fallbackNowQty - YATA's current reading, used when
 *        the history cache has nothing for this (item, destination)
 * @returns {{
 *   nowQty: number|null,
 *   etaQty: number|null,
 *   confidence: 'none'|'low'|'ok',
 *   hasHistory: boolean
 * }}
 */
export function forecastStock(itemId, destination, arrivalMins, fallbackNowQty = null) {
  const samples = historyCache.get(cacheKey(itemId, destination));

  // No history at all (fresh install / table just created) — lean on YATA's
  // live number and report low confidence. Row still renders normally.
  if (!samples || samples.length === 0) {
    return {
      nowQty: fallbackNowQty,
      etaQty: fallbackNowQty,
      confidence: fallbackNowQty != null ? 'low' : 'none',
      hasHistory: false,
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
    return { nowQty, etaQty: nowQty, confidence: 'low', hasHistory: true };
  }

  const first = segment[0];
  const last = segment[segment.length - 1];
  const spanMins = (last.snappedAt - first.snappedAt) / 60_000;
  if (spanMins < 1) {
    return { nowQty, etaQty: nowQty, confidence: 'low', hasHistory: true };
  }

  // slope is quantity-per-minute; depleting shelves make it ≤ 0.
  const slope = (last.quantity - first.quantity) / spanMins;
  const projected = nowQty + slope * arrivalMins;
  // Clamp within [0, nowQty]. A depletion run cannot grow — any positive
  // projection would indicate the segment picked up noise or a restock the
  // walker missed. Rather than show a misleading ETA higher than Now, pin
  // the ETA to Now (i.e., "no confident depletion") and let the confidence
  // flag tell the rest of the story.
  const etaQty = Math.max(0, Math.min(nowQty, Math.round(projected)));

  const confidence =
    segment.length >= MIN_SAMPLES_FOR_OK && spanMins >= MIN_SPAN_MINS_FOR_OK
      ? 'ok'
      : 'low';

  return { nowQty, etaQty, confidence, hasHistory: true };
}
