// Pure forecasting math — no I/O, no Supabase, no DOM. Extracted from
// stock-forecast.js so the estimators are unit-testable (vitest) and
// reusable by offline tooling (scripts/backtest.mjs) without dragging in
// the Supabase client. stock-forecast.js remains the only caller in the
// app; behavior is identical to the pre-extraction code.

// Minimum restock events before estimateNextRestock() yields a prediction.
// Two events give one interval sample — the statistical floor. More events
// tighten the median and unlock higher confidence tiers downstream.
export const MIN_RESTOCK_EVENTS = 2;

// Torn restocks land only on quarter-hour ticks — xx:00 / :15 / :30 / :45
// TCT (TCT is UTC, so epoch-ms math works directly). Community-documented
// shop mechanic, same as city NPC stores. Exploited in two places:
//   1. Restock-event timestamps get snapped to the tick inside their
//      censoring window (pre, post] — with the 5-min cron sampling that
//      window usually contains exactly ONE tick, recovering the exact
//      refill time from two loose observations.
//   2. Predictions get snapped forward onto a tick, because a refill
//      physically cannot land between ticks.
export const RESTOCK_TICK_MS = 15 * 60_000;

// Cap on the inter-restock interval the cadence estimator will trust.
// History: this was 120 min when every snapshot writer was user-gated and a
// wide gap usually meant "nobody watched the shelf". Since migration 039 the
// cron-snapshot-yata poller samples every destination every ~5 min around
// the clock, so long gaps are now REAL cadence — the old cap was deleting
// the entire cadence signal for slow shelves (flowers: ~7 h sellout +
// ~3.5 h restock delay ≈ 10.5 h cycle). 24 h is a pure sanity bound now;
// genuinely missed cycles are handled by the adaptive trim below.
export const MAX_RESTOCK_GAP_MINS = 24 * 60;

// Adaptive missed-cycle trim: an observation hole that swallows exactly one
// restock produces a gap of ~2× the shelf's true cadence. Before taking the
// final median, gaps beyond this multiple of the provisional median are
// treated as missed cycles and dropped. 1.75 splits the 1× cluster from the
// 2× cluster. Only applied at ≥ MIN_GAPS_FOR_TRIM raw gaps so tiny samples
// don't trim themselves into nothing.
export const MISSED_CYCLE_FACTOR = 1.75;
export const MIN_GAPS_FOR_TRIM = 4;


// ── Quarter-hour tick helpers ────────────────────────────────────────
// Torn restocks land exclusively on :00/:15/:30/:45 TCT (= UTC), so epoch
// math on RESTOCK_TICK_MS gives exact tick boundaries.

export function floorTick(ms) {
  return Math.floor(ms / RESTOCK_TICK_MS) * RESTOCK_TICK_MS;
}

export function nextTickAfter(ms) {
  return floorTick(ms) + RESTOCK_TICK_MS;
}

export function nearestTick(ms) {
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
export function effectiveRestockTime(e) {
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
export function medianPostQty(events) {
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
export const HALFLIFE_MAX_EMPTY_CENSOR_MINS = 90;
// If the rule's prediction is this far in the past while the shelf is still
// empty, the model missed (bad cycle-start attribution, mechanics edge
// case) — return null and let the cadence median take over rather than
// insisting "next tick!" forever.
export const HALFLIFE_MAX_OVERDUE_MINS = 30;
// Sellout-duration sanity bounds. Below 5 min we likely mis-attributed the
// cycle start; beyond 36 h the "cycle" spans more than our observation
// quality supports.
export const HALFLIFE_MIN_SELLOUT_MINS = 5;
export const HALFLIFE_MAX_SELLOUT_MINS = 36 * 60;

/**
 * Locate the most recent qty>0 → qty=0 transition in the snapshot history.
 * Requires the trailing run to be zeros (shelf observed empty). Returns
 * { emptiedAt, censorMins, lastPositiveAt } or null.
 */
export function estimateEmptiedAt(samples) {
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
export function estimateHalfSelloutRestock(samples, events, nowMs) {
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
export function computeInSampleMAE(gaps) {
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
export function estimateNextRestock(events, nowMs) {
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

// ── Flight-window shelf simulation ───────────────────────────────────
//
// Projects shelf quantity across a whole flight, modeling EVERY refill in
// the window rather than just the first. The old single-refill override
// understated arrival stock on fast shelves observed over long flights: a
// shelf with a ~50-min cycle restocks 4-5 times during a 4.5 h Japan leg,
// and what matters is the phase of the LAST cycle at landing, not the
// first.
//
// Refill schedule: the first refill time comes from the caller (half-
// sellout rule or cadence median — already tick-snapped). Subsequent
// refills prefer the mechanic-derived cycle — a refill of `restockQty`
// units at `-slope` units/min sells out in restockQty/-slope minutes and
// refills half that later, so cycle = 1.5 × restockQty / -slope — falling
// back to the observed cadence median when there's no usable slope. The
// cycle is floored at one tick (nothing restocks faster than 15 min).
//
// Approximation notes: refills SET the shelf to restockQty (Torn refills
// a sold-out shelf to its stock level; post_qty medians measure exactly
// that). We take max(current, restockQty) so a mis-timed schedule can
// never make a refill LOWER the projection. Subsequent refill times drift
// off exact tick alignment when the cycle isn't a 15-min multiple —
// acceptable, since per-cycle phase error is already dominated by slope
// noise several cycles out.

const MAX_SIMULATED_REFILLS = 50;

/**
 * @param {object} p
 * @param {number} p.nowQty            current quantity (≥ 0)
 * @param {number} p.slope             depletion rate in units/min (≤ 0; 0 = flat)
 * @param {number} p.arrivalMins       minutes until landing
 * @param {number|null} p.firstRestockMins  minutes until the first predicted refill
 *                                     (null or > arrivalMins → no refills modeled)
 * @param {number|null} p.intervalMins observed cadence median for subsequent refills
 * @param {number|null} p.restockQty   typical post-refill quantity
 * @returns {{ etaQty: number, refills: number }} projected arrival quantity
 *          (unrounded, ≥ 0) and how many refills landed during the flight
 */
export function simulateArrivalQty({ nowQty, slope, arrivalMins, firstRestockMins, intervalMins, restockQty }) {
  const rate = Math.min(0, slope ?? 0);
  let qty = Math.max(0, nowQty ?? 0);

  // Build the refill schedule inside [0, arrivalMins].
  const times = [];
  if (firstRestockMins != null && firstRestockMins <= arrivalMins && restockQty != null && restockQty > 0) {
    // Mechanic-derived cycle beats the cadence median for refills after
    // the first: it's consistent with the very slope the simulation
    // depletes at. Cadence is the fallback; no interval at all → model
    // only the first refill (the pre-simulation behavior).
    let cycle = null;
    if (rate < 0) {
      cycle = 1.5 * (restockQty / -rate);
    } else if (intervalMins != null && intervalMins > 0) {
      cycle = intervalMins;
    }
    if (cycle != null) cycle = Math.max(cycle, RESTOCK_TICK_MS / 60_000);

    let t = Math.max(0, firstRestockMins);
    times.push(t);
    while (cycle != null && times.length < MAX_SIMULATED_REFILLS) {
      t += cycle;
      if (t > arrivalMins) break;
      times.push(t);
    }
  }

  // Walk the timeline: deplete to each refill, refill, deplete to arrival.
  let cursor = 0;
  let refills = 0;
  for (const rt of times) {
    qty = Math.max(0, qty + rate * (rt - cursor));
    qty = Math.max(qty, restockQty);
    refills++;
    cursor = rt;
  }
  qty = Math.max(0, qty + rate * (arrivalMins - cursor));

  return { etaQty: qty, refills };
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
export function allDepletionSegments(samples) {
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
export function fitSegmentSlope(segment) {
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
export function pooledDepletionSlope(segments) {
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

