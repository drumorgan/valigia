import { describe, it, expect } from 'vitest';
import { calculateMargins, formatFlightTime, formatMoney, formatMarginPctCompact } from '../src/calculator.js';

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
