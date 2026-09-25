import { describe, it, expect } from 'vitest';
import { pickSellVenue, getMuseumEntry, isContrabandName, normalizeItemName } from '../src/data/sell-venues.js';

describe('pickSellVenue', () => {
  it('returns null when nothing is priced', () => {
    expect(pickSellVenue({ marketPrice: null, storePrice: null })).toBeNull();
  });

  it('prices the market net of the 5% fee', () => {
    const s = pickSellVenue({ marketPrice: 1000, storePrice: null });
    expect(s.venue).toBe('market');
    expect(s.net).toBeCloseTo(950, 6);
  });

  it('prefers a store that pays more than market net', () => {
    // 960 cash beats 1000 × 0.95 = 950
    const s = pickSellVenue({ marketPrice: 1000, storePrice: 960 });
    expect(s.venue).toBe('store');
    expect(s.net).toBe(960);
    expect(s.fee).toBe(0);
  });

  it('prices store-only contraband that has no market listings', () => {
    const s = pickSellVenue({ marketPrice: undefined, storePrice: 42000 });
    expect(s.venue).toBe('store');
  });

  it('values museum items at points × rate, skipping without a rate', () => {
    const museum = getMuseumEntry('Patagonian Fossil');
    expect(pickSellVenue({ marketPrice: null, storePrice: null, museum })).toBeNull();
    const s = pickSellVenue({ marketPrice: 500000, storePrice: null, museum, pointsRate: 40000 });
    expect(s.venue).toBe('museum');
    expect(s.net).toBe(800000);
  });

  it('flags arrowheads as a set of 6 at 25/6 points each', () => {
    const museum = getMuseumEntry('Obsidian Point');
    expect(museum.setSize).toBe(6);
    const s = pickSellVenue({ marketPrice: null, museum, pointsRate: 60000 });
    expect(s.net).toBeCloseTo(250000, 6);
    expect(s.setSize).toBe(6);
  });
});

describe('contraband names', () => {
  it('matches singular/plural and case', () => {
    expect(isContrabandName('Uncut Diamonds')).toBe(true);
    expect(isContrabandName('ergotamine ampoule')).toBe(true);
    expect(isContrabandName('Xanax')).toBe(false);
    expect(isContrabandName(null)).toBe(false);
    expect(normalizeItemName(' Safrole Oil ')).toBe('safrole oil');
  });
});
