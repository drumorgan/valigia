// Liquidity defaults — how long each item category typically takes to sell
// on the Torn item market after you land with it.
//
// These plug into the profit/hr denominator so the ranking stops rewarding
// items that look good on paper but tie up your capital for hours after
// you land. The math is simple:
//
//   profit/hr = profit_per_run / (round_trip_mins + sell_time_mins) * 60
//
// Drugs and flowers turn over in seconds — the 2–3 min numbers reflect
// "time to walk to the market, list, and walk back", not wait-on-buyer.
// Artifacts sit in the market for hours or never sell at all; 90 min is
// still optimistic but captures the directional reality.
//
// These are blunt averages. A future pass (see Path 2 / Path 3 in the
// Apr 2026 discussion) would refine per-item from market depth or
// sell-price history. For now: better a rough number than a pretend zero.

const SELL_TIME_MINS = {
  drug: 2,
  flower: 3,
  plushie: 10,
  artifact: 90,
  // Contraband that DOES trade on the Item Market (when the store/museum
  // venue doesn't win) — thin, newer market, so slower than drugs.
  contraband: 15,
  // Arms Dealer weapons/armour/temporaries: plain-quality pieces, but
  // buyers compare bonuses, so they sit longer than consumables.
  arms: 20,
  other: 30,
};

// Non-market venues pay on the spot — the tail is just the walk to the
// store / museum counter. Museum is slightly longer (exchange screen).
const VENUE_SELL_TIME_MINS = {
  store: 2,
  museum: 5,
};

// Single-glyph badges shown in the Profit/hr column. The numeric sell-time
// lived here originally ("⚡ 2m", "~30m", etc.) but it was the noisiest
// per-row text on the page and the magnitudes are already folded into the
// profit/hr value. The glyph still communicates fast / medium / slow at a
// glance, and the tooltip carries the exact minutes for anyone who wants
// to read the assumption.
const LIQUIDITY_BADGES = {
  drug:     { label: '⚡', level: 'fast',   title: 'Drugs sell in seconds — ~2 min baked into profit/hr.' },
  flower:   { label: '⚡', level: 'fast',   title: 'Flowers are liquid — ~3 min baked into profit/hr.' },
  plushie:  { label: '●', level: 'medium', title: 'Plushies sell quickly but not instantly — ~10 min baked into profit/hr.' },
  artifact: { label: '⏳', level: 'slow',   title: 'Artifacts sit on the market — ~90 min baked into profit/hr. Capital stays tied up.' },
  contraband: { label: '●', level: 'medium', title: 'Contraband on the Item Market — thin market, ~15 min baked into profit/hr.' },
  arms:     { label: '●', level: 'medium', title: 'Weapons/armour sit a while — buyers compare bonuses. ~20 min baked into profit/hr.' },
  other:    { label: '●', level: 'medium', title: 'Unknown category — ~30 min conservative sell-time baked into profit/hr.' },
};

const VENUE_BADGES = {
  store:  { label: '⚡', level: 'fast', title: 'Sold to a city store for fixed cash — ~2 min baked into profit/hr.' },
  museum: { label: '⚡', level: 'fast', title: 'Exchanged at the Museum for points — ~5 min baked into profit/hr.' },
};

/**
 * Estimated minutes to sell out a full run after landing, for an item of
 * this category. Unknown categories fall back to a conservative default.
 * A store/museum venue overrides the category — those pay instantly.
 */
export function getSellTimeMins(category, venue = 'market') {
  if (VENUE_SELL_TIME_MINS[venue] != null) return VENUE_SELL_TIME_MINS[venue];
  if (category && SELL_TIME_MINS[category] != null) return SELL_TIME_MINS[category];
  return SELL_TIME_MINS.other;
}

/**
 * UI badge descriptor for the Profit/hr cell: short label, coarse level,
 * and a tooltip that explains the assumption.
 */
export function getLiquidityBadge(category, venue = 'market') {
  if (VENUE_BADGES[venue]) return VENUE_BADGES[venue];
  return LIQUIDITY_BADGES[category] || LIQUIDITY_BADGES.other;
}
