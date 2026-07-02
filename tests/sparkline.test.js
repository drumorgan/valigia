import { describe, it, expect } from 'vitest';
import { stockSparklineSvg } from '../src/sparkline.js';

const MIN = 60_000;
const base = Date.UTC(2026, 0, 1, 12, 0, 0);
const s = (mins, qty) => ({ quantity: qty, snappedAt: base + mins * MIN });

describe('stockSparklineSvg', () => {
  it('renders a step path for a deplete → restock cycle', () => {
    const svg = stockSparklineSvg(
      [s(0, 100), s(60, 60), s(120, 20), s(180, 0), s(200, 500)],
      { nowMs: base + 240 * MIN },
    );
    expect(svg).toContain('<svg');
    expect(svg).toContain('preserveAspectRatio="none"');
    // step-after: horizontal (H) and vertical (V) commands, no diagonals (L)
    expect(svg).toMatch(/H[\d.]+/);
    expect(svg).toMatch(/V[\d.]+/);
    expect(svg).not.toMatch(/[^A-Za-z]L[\d.]/);
    // holds the last value out to the right edge (H<width>)
    expect(svg).toContain('H72"');
  });

  it('returns empty on thin history', () => {
    expect(stockSparklineSvg([s(0, 5), s(10, 3)])).toBe('');
    expect(stockSparklineSvg([])).toBe('');
    expect(stockSparklineSvg(null)).toBe('');
  });

  it('returns empty for a shelf never observed in stock', () => {
    expect(stockSparklineSvg([s(0, 0), s(10, 0), s(20, 0), s(30, 0)])).toBe('');
  });

  it('drops samples outside the window', () => {
    // only 3 samples inside the 48h window → too thin → empty
    const svg = stockSparklineSvg(
      [s(-49 * 60, 100), s(-48.5 * 60, 90), s(0, 50), s(10, 40), s(20, 30)],
      { nowMs: base + 20 * MIN },
    );
    expect(svg).toBe('');
  });

  it('downsamples very dense histories', () => {
    const dense = [];
    for (let i = 0; i < 500; i++) dense.push(s(i, 500 - (i % 100) * 5));
    const svg = stockSparklineSvg(dense, { nowMs: base + 500 * MIN });
    // 90 points max → ≤ 180 H/V commands + move + trailing hold
    const cmds = (svg.match(/[HV]/g) || []).length;
    expect(cmds).toBeLessThan(200);
    expect(svg).toContain('<svg');
  });

  it('keeps y within the viewBox (1px padding)', () => {
    const svg = stockSparklineSvg(
      [s(0, 0), s(10, 1000), s(20, 500), s(30, 0)],
      { nowMs: base + 30 * MIN, height: 16 },
    );
    const ys = [...svg.matchAll(/V([\d.]+)/g)].map(m => Number(m[1]));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0.9);
      expect(y).toBeLessThanOrEqual(15.1);
    }
  });
});
