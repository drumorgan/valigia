// Unit tests for the pure forecasting math (src/forecast-math.js).
//
// Conventions: `base` is aligned to a quarter-hour tick so expected tick
// positions are easy to reason about. Times are epoch ms; TCT = UTC so
// tick boundaries are plain modular arithmetic on RESTOCK_TICK_MS.

import { describe, it, expect } from 'vitest';
import {
  RESTOCK_TICK_MS,
  floorTick,
  nextTickAfter,
  nearestTick,
  effectiveRestockTime,
  medianPostQty,
  estimateEmptiedAt,
  estimateHalfSelloutRestock,
  computeInSampleMAE,
  estimateNextRestock,
  allDepletionSegments,
  fitSegmentSlope,
  pooledDepletionSlope,
  simulateArrivalQty,
} from '../src/forecast-math.js';

const MIN = 60_000;
const TICK = RESTOCK_TICK_MS;
// Fixed, deterministic base on a tick boundary (2026-01-01T00:00:00Z is
// divisible by 15 min since the epoch is UTC-midnight-aligned).
const base = Date.UTC(2026, 0, 1, 12, 0, 0);

// Restock event helper: observed `mins` after base with a ±few-minute
// censoring window straddling the true tick.
const evt = (mins, postQty = 400, preLead = 3, postLag = 2) => ({
  preTime: base + mins * MIN - preLead * MIN,
  atTime: base + mins * MIN + postLag * MIN,
  postQty,
});

describe('tick helpers', () => {
  it('floor/next/nearest land on quarter-hour boundaries', () => {
    const t = base + 7 * MIN;
    expect(floorTick(t)).toBe(base);
    expect(nextTickAfter(t)).toBe(base + TICK);
    expect(nearestTick(t)).toBe(base); // 7m rounds down
    expect(nearestTick(base + 8 * MIN)).toBe(base + TICK);
    // exactly on a tick: next is strictly after
    expect(nextTickAfter(base)).toBe(base + TICK);
  });
});

describe('effectiveRestockTime', () => {
  it('recovers the exact tick from a censoring window containing one tick', () => {
    const e = { preTime: base + 26 * MIN, atTime: base + 33 * MIN, postQty: 1 };
    expect(effectiveRestockTime(e)).toBe(base + 30 * MIN);
  });

  it('picks the tick nearest the midpoint when the window holds several', () => {
    const e = { preTime: base + 1 * MIN, atTime: base + 59 * MIN, postQty: 1 };
    expect(effectiveRestockTime(e)).toBe(base + 30 * MIN);
  });

  it('falls back to the midpoint when no tick is inside the window', () => {
    const e = { preTime: base + 2 * MIN, atTime: base + 8 * MIN, postQty: 1 };
    expect(effectiveRestockTime(e)).toBe(base + 5 * MIN);
  });

  it('floors legacy rows (no preTime) to the latest tick at/before observation', () => {
    const e = { preTime: null, atTime: base + 22 * MIN, postQty: 1 };
    expect(effectiveRestockTime(e)).toBe(base + 15 * MIN);
  });
});

describe('medianPostQty', () => {
  it('works from a single event and takes the median beyond', () => {
    expect(medianPostQty([{ postQty: 500 }])).toBe(500);
    expect(medianPostQty([{ postQty: 100 }, { postQty: 900 }, { postQty: 500 }])).toBe(500);
    expect(medianPostQty([])).toBeNull();
    expect(medianPostQty(null)).toBeNull();
  });
});

describe('estimateNextRestock (cadence)', () => {
  it('needs at least two events', () => {
    expect(estimateNextRestock([evt(0)], base + 10 * MIN)).toBeNull();
  });

  it('finds a clean 30-min cadence and snaps the next restock to its tick', () => {
    const events = [evt(0), evt(30), evt(60), evt(90), evt(120)];
    const est = estimateNextRestock(events, base + 123 * MIN);
    expect(est).not.toBeNull();
    expect(est.medianIntervalMins).toBe(30);
    // last restock @120, +30 → 150; now=123 → 27 minutes out
    expect(est.timeToNextMins).toBeCloseTo(27, 5);
  });

  it('trims a missed-cycle gap instead of letting it drag the median', () => {
    // true cadence 30m, one 60m hole (missed the 90m restock)
    const events = [evt(0), evt(30), evt(60), evt(120), evt(150), evt(180), evt(210)];
    const est = estimateNextRestock(events, base + 212 * MIN);
    expect(est.medianIntervalMins).toBe(30);
  });

  it('keeps slow-shelf cadence that the old 120-min cap would have deleted', () => {
    const events = [evt(0, 96), evt(630, 96), evt(1260, 96)];
    const est = estimateNextRestock(events, base + 1300 * MIN);
    expect(est).not.toBeNull();
    expect(est.medianIntervalMins).toBe(630); // 10.5 h
  });

  it('resolves an overdue prediction to the next upcoming tick, not zero', () => {
    const events = [evt(0), evt(30), evt(60), evt(90), evt(120)];
    // predicted @150, now @158 → next tick @165 → 7 minutes
    const est = estimateNextRestock(events, base + 158 * MIN);
    expect(est.timeToNextMins).toBeCloseTo(7, 5);
  });

  it('collapses duplicate observers of the same physical refill', () => {
    const dupe = { preTime: base + 29 * MIN, atTime: base + 33 * MIN, postQty: 400 };
    const est = estimateNextRestock([evt(0), evt(30), dupe], base + 40 * MIN);
    expect(est.sampleCount).toBe(1); // one real gap, not two
    expect(est.medianIntervalMins).toBe(30);
  });

  it('drops gaps beyond the 24 h sanity cap', () => {
    const events = [evt(0), evt(26 * 60), evt(26 * 60 + 30)];
    const est = estimateNextRestock(events, base + (26 * 60 + 40) * MIN);
    expect(est.medianIntervalMins).toBe(30);
  });
});

describe('computeInSampleMAE', () => {
  it('returns null below two gaps and a sane LOO residual otherwise', () => {
    expect(computeInSampleMAE([30])).toBeNull();
    expect(computeInSampleMAE([30, 30, 30])).toBe(0);
    // [20, 30, 40]: LOO medians are 30/40? — verify symmetric spread > 0
    expect(computeInSampleMAE([20, 30, 40])).toBeGreaterThan(0);
  });
});

describe('estimateEmptiedAt', () => {
  const mkSamples = (qtys, stepMins = 5) =>
    qtys.map((q, i) => ({ quantity: q, snappedAt: base + i * stepMins * MIN }));

  it('finds the midpoint of the zero-crossing window', () => {
    const s = mkSamples([100, 50, 10, 0, 0]);
    const r = estimateEmptiedAt(s);
    // last positive @10m, first zero @15m → midpoint 12.5m, censor 5m
    expect(r.emptiedAt).toBe(base + 12.5 * MIN);
    expect(r.censorMins).toBe(5);
    expect(r.lastPositiveAt).toBe(base + 10 * MIN);
  });

  it('returns null when the shelf is not currently observed empty', () => {
    expect(estimateEmptiedAt(mkSamples([100, 50, 10]))).toBeNull();
  });

  it('returns null when the shelf was never observed positive', () => {
    expect(estimateEmptiedAt(mkSamples([0, 0, 0]))).toBeNull();
  });
});

describe('estimateHalfSelloutRestock', () => {
  // Shelf refilled at `base` (tick), depletes linearly, hits 0 ~2h in.
  const samples = [];
  for (let m = 0; m <= 130; m += 5) {
    samples.push({ quantity: Math.max(0, 500 - Math.round(m * 4.2)), snappedAt: base + m * MIN });
  }
  const refill = evt(0, 500, 4, 2);

  it('predicts emptiedAt + sellout/2, snapped to a tick', () => {
    const nowMs = samples[samples.length - 1].snappedAt + MIN;
    const est = estimateHalfSelloutRestock(samples, [refill], nowMs);
    expect(est).not.toBeNull();
    // predicted target must be tick-aligned and in the future
    const target = nowMs + est.timeToNextMins * MIN;
    expect(target % TICK).toBe(0);
    expect(est.timeToNextMins).toBeGreaterThan(0);
    // sellout ~2h → restock delay ~1h after empty (~117.5m) → ~half-past-two mark
    expect(est.selloutMins).toBeGreaterThan(100);
    expect(est.selloutMins).toBeLessThan(135);
    expect(est.confidence).toBe('high'); // 5-min sampling → tight censor
  });

  it('gives up when the prediction is far overdue (falls back to cadence)', () => {
    const nowMs = samples[samples.length - 1].snappedAt + 5 * 3600_000;
    expect(estimateHalfSelloutRestock(samples, [refill], nowMs)).toBeNull();
  });

  it('gives up when no refill precedes the sellout', () => {
    const nowMs = samples[samples.length - 1].snappedAt + MIN;
    const lateEvent = evt(500, 500); // after the zero-crossing
    expect(estimateHalfSelloutRestock(samples, [lateEvent], nowMs)).toBeNull();
  });
});

describe('simulateArrivalQty', () => {
  it('pure depletion with no refill in window', () => {
    const r = simulateArrivalQty({
      nowQty: 100, slope: -1, arrivalMins: 60,
      firstRestockMins: null, intervalMins: null, restockQty: 500,
    });
    expect(r.etaQty).toBe(40);
    expect(r.refills).toBe(0);
  });

  it('clamps at zero when the shelf empties before landing', () => {
    const r = simulateArrivalQty({
      nowQty: 30, slope: -1, arrivalMins: 60,
      firstRestockMins: null, intervalMins: null, restockQty: null,
    });
    expect(r.etaQty).toBe(0);
  });

  it('single refill then post-refill depletion (old override behavior)', () => {
    // empty now, refill of 500 at min 20, deplete 2/min for remaining 40 min
    const r = simulateArrivalQty({
      nowQty: 0, slope: -2, arrivalMins: 60,
      firstRestockMins: 20, intervalMins: null, restockQty: 500,
    });
    // mechanic cycle = 1.5 × 500/2 = 375 min → no second refill in window
    expect(r.refills).toBe(1);
    expect(r.etaQty).toBe(500 - 2 * 40);
  });

  it('models recurring refills on a fast shelf over a long flight', () => {
    // refill 100 @ min 15, rate −2/min → sellout 50 min, cycle 75 min:
    // refills at 15, 90, 165, 240; arrival 250 → 10 min after last refill
    const r = simulateArrivalQty({
      nowQty: 0, slope: -2, arrivalMins: 250,
      firstRestockMins: 15, intervalMins: null, restockQty: 100,
    });
    expect(r.refills).toBe(4);
    expect(r.etaQty).toBe(100 - 2 * 10);
    // The old single-refill model would have said max(0, 100 − 2×235) = 0.
  });

  it('falls back to the cadence interval when there is no slope', () => {
    // flat rate: qty just becomes restockQty at each refill
    const r = simulateArrivalQty({
      nowQty: 0, slope: 0, arrivalMins: 100,
      firstRestockMins: 10, intervalMins: 30, restockQty: 250,
    });
    expect(r.refills).toBe(4); // 10, 40, 70, 100
    expect(r.etaQty).toBe(250);
  });

  it('floors the derived cycle at one tick', () => {
    // tiny refill + huge rate → raw cycle ≪ 15 min; must not spin
    const r = simulateArrivalQty({
      nowQty: 0, slope: -100, arrivalMins: 60,
      firstRestockMins: 0, intervalMins: null, restockQty: 10,
    });
    expect(r.refills).toBe(5); // 0, 15, 30, 45, 60
    expect(r.etaQty).toBe(10); // landing right on a refill
  });

  it('a refill never lowers the projection', () => {
    const r = simulateArrivalQty({
      nowQty: 800, slope: 0, arrivalMins: 30,
      firstRestockMins: 10, intervalMins: null, restockQty: 100,
    });
    expect(r.etaQty).toBe(800);
  });
});

describe('depletion segments + pooled slope', () => {
  const s = (mins, qty) => ({ quantity: qty, snappedAt: base + mins * MIN });

  it('splits history at restock boundaries', () => {
    const samples = [s(0, 100), s(10, 80), s(20, 60), s(30, 500), s(40, 480)];
    const segs = allDepletionSegments(samples);
    expect(segs.length).toBe(2);
    expect(segs[0].length).toBe(3);
    expect(segs[1].length).toBe(2);
  });

  it('fits an exact slope on clean linear data', () => {
    const seg = [s(0, 100), s(10, 80), s(20, 60)];
    expect(fitSegmentSlope(seg)).toBeCloseTo(-2, 10); // −2 units/min
  });

  it('pools multiple segments into a weighted-median slope', () => {
    const segs = [
      [s(0, 100), s(10, 80), s(20, 60)],          // −2/min, weight 3
      [s(30, 500), s(40, 490)],                    // −1/min, weight 2
    ];
    const pooled = pooledDepletionSlope(segs);
    expect(pooled.slope).toBeCloseTo(-2, 10); // weight-3 segment wins the median
    expect(pooled.segmentCount).toBe(2);
    expect(pooled.totalSamples).toBe(5);
  });

  it('returns null when every segment is degenerate', () => {
    expect(pooledDepletionSlope([[s(0, 100)]])).toBeNull();
    expect(pooledDepletionSlope([])).toBeNull();
  });
});
