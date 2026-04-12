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
  other: 30,
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
  other:    { label: '●', level: 'medium', title: 'Unknown category — ~30 min conservative sell-time baked into profit/hr.' },
};

/**
 * Estimated minutes to sell out a full run after landing, for an item of
 * this category. Unknown categories fall back to a conservative default.
 */
export function getSellTimeMins(category) {
  if (category && SELL_TIME_MINS[category] != null) return SELL_TIME_MINS[category];
  return SELL_TIME_MINS.other;
}

/**
 * UI badge descriptor for the Profit/hr cell: short label, coarse level,
 * and a tooltip that explains the assumption.
 */
export function getLiquidityBadge(category) {
  return LIQUIDITY_BADGES[category] || LIQUIDITY_BADGES.other;
}
