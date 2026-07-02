import { describe, it, expect } from 'vitest';
import { calculateMargins, planDestinationRun, formatFlightTime, formatMoney, formatMarginPctCompact } from '../src/calculator.js';

describe('calculateMargins', () => {
  it('computes the documented margin math', () => {
    const m = calculateMargins({
      buyPrice: 1000, sellPrice: 2000, slotCount: 29, flightMins: 90,
    });
    expect(m.netSell).toBe(1900);            // 5% fee
    expect(m.marginPerItem).toBe(900);
    expect(m.marginPct).toBeCloseTo(90, 10);
    expect(m.effectiveSlots).toBe(29);
    expect(m.stockLimited).toBe(false);
    expect(m.runCost).toBe(29_000);
    expect(m.profitPerRun).toBe(26_100);
    expect(m.roundTripMins).toBe(180);
    expect(m.profitPerHour).toBeCloseTo(26_100 / 3, 6);
  });

  it('clamps effective slots to stock and flags it', () => {
    const m = calculateMargins({
      buyPrice: 1000, sellPrice: 2000, slotCount: 29, flightMins: 90, stockQty: 12,
    });
    expect(m.effectiveSlots).toBe(12);
    expect(m.stockLimited).toBe(true);
    expect(m.profitPerRun).toBe(900 * 12);
  });

  it('applies the flight multiplier to the round trip', () => {
    const m = calculateMargins({
      buyPrice: 1000, sellPrice: 2000, slotCount: 10, flightMins: 100, flightMultiplier: 0.7,
    });
    expect(m.roundTripMins).toBeCloseTo(140, 10);
  });

  it('adds sell time to the cycle denominator', () => {
    const fast = calculateMargins({ buyPrice: 1, sellPrice: 100, slotCount: 1, flightMins: 30 });
    const slow = calculateMargins({ buyPrice: 1, sellPrice: 100, slotCount: 1, flightMins: 30, sellTimeMins: 60 });
    expect(slow.profitPerHour).toBeLessThan(fast.profitPerHour);
    expect(slow.cycleMins).toBe(120);
  });

  it('handles zero stock without dividing by zero', () => {
    const m = calculateMargins({ buyPrice: 1000, sellPrice: 2000, slotCount: 29, flightMins: 90, stockQty: 0 });
    expect(m.effectiveSlots).toBe(0);
    expect(m.profitPerRun).toBe(0);
    expect(m.profitPerHour).toBe(0);
  });
});

describe('planDestinationRun', () => {
  const xanax = { name: 'Xanax', marginPerItem: 900_000, buyPrice: 800_000, availableQty: 12, sellTimeMins: 2 };
  const vicodin = { name: 'Vicodin', marginPerItem: 400_000, buyPrice: 300_000, availableQty: 100, sellTimeMins: 2 };

  it('degenerates to single-item math when the top shelf covers capacity', () => {
    const plan = planDestinationRun({
      candidates: [{ ...xanax, availableQty: 500 }, vicodin],
      slotCount: 29, flightMins: 90, flightMultiplier: 1,
    });
    expect(plan.allocations.length).toBe(1);
    expect(plan.allocations[0].units).toBe(29);
    expect(plan.profitPerRun).toBe(29 * 900_000);
    // matches calculateMargins for the same inputs
    const single = calculateMargins({
      buyPrice: 800_000, sellPrice: 0, slotCount: 29, flightMins: 90, sellTimeMins: 2,
    });
    expect(plan.roundTripMins).toBe(single.roundTripMins);
    expect(plan.cycleMins).toBe(single.cycleMins);
  });

  it('fills remaining slots with the next-best shelf when stock-limited', () => {
    const plan = planDestinationRun({
      candidates: [vicodin, xanax], // deliberately unsorted
      slotCount: 29, flightMins: 90, flightMultiplier: 1,
    });
    expect(plan.allocations.map(a => [a.name, a.units])).toEqual([
      ['Xanax', 12], ['Vicodin', 17],
    ]);
    expect(plan.filledSlots).toBe(29);
    expect(plan.profitPerRun).toBe(12 * 900_000 + 17 * 400_000);
    expect(plan.runCost).toBe(12 * 800_000 + 17 * 300_000);
  });

  it('reports a partial fill when every shelf is exhausted', () => {
    const plan = planDestinationRun({
      candidates: [{ ...xanax, availableQty: 5 }, { ...vicodin, availableQty: 3 }],
      slotCount: 29, flightMins: 90,
    });
    expect(plan.filledSlots).toBe(8);
    expect(plan.allocations.length).toBe(2);
  });

  it('uses the max sell tail across allocations, not the sum', () => {
    const plan = planDestinationRun({
      candidates: [
        { ...xanax, sellTimeMins: 2 },
        { ...vicodin, sellTimeMins: 60 },
      ],
      slotCount: 29, flightMins: 90, flightMultiplier: 1,
    });
    expect(plan.cycleMins).toBe(180 + 60);
  });

  it('skips negative margins and zero availability; null qty = unlimited', () => {
    const plan = planDestinationRun({
      candidates: [
        { name: 'Loss', marginPerItem: -5, buyPrice: 100, availableQty: 50 },
        { name: 'Empty', marginPerItem: 900, buyPrice: 100, availableQty: 0 },
        { name: 'Open', marginPerItem: 500, buyPrice: 100, availableQty: null },
      ],
      slotCount: 10, flightMins: 30,
    });
    expect(plan.allocations.length).toBe(1);
    expect(plan.allocations[0].name).toBe('Open');
    expect(plan.allocations[0].units).toBe(10);
  });

  it('returns null with no viable candidates', () => {
    expect(planDestinationRun({ candidates: [], slotCount: 29, flightMins: 90 })).toBeNull();
    expect(planDestinationRun({
      candidates: [{ marginPerItem: -1, buyPrice: 1, availableQty: 9 }],
      slotCount: 29, flightMins: 90,
    })).toBeNull();
  });
});

describe('formatters', () => {
  it('formats flight time', () => {
    expect(formatFlightTime(45)).toBe('45m');
    expect(formatFlightTime(189)).toBe('3h 9m');
  });

  it('formats money with sign', () => {
    expect(formatMoney(1234567)).toBe('$1,234,567');
    expect(formatMoney(-50)).toBe('-$50');
    expect(formatMoney(null)).toBe('—');
  });

  it('compacts huge points-item margins into multipliers', () => {
    expect(formatMarginPctCompact(62.3)).toBe('62.3%');
    expect(formatMarginPctCompact(340)).toBe('340%');
    expect(formatMarginPctCompact(3400)).toBe('34.0×');
    expect(formatMarginPctCompact(14000)).toBe('140×');
  });
});
