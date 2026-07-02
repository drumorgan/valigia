// Margin math functions for travel arbitrage calculations.

/**
 * Calculate profit metrics for an item.
 * @param {object} params
 * @param {number} params.buyPrice - Abroad buy price per unit
 * @param {number} params.sellPrice - Item market sell price per unit
 * @param {number} params.slotCount - Number of items per trip
 * @param {number} params.flightMins - One-way flight time in minutes
 * @param {number} params.flightMultiplier - Flight time multiplier (1.0 = standard, 0.7 = airstrip/WLT, 0.49 = both)
 * @param {number|null} [params.stockQty] - Available stock at destination. When set, caps effective slot fill to min(slotCount, stockQty).
 * @param {number} [params.sellTimeMins] - Estimated minutes to liquidate the run after landing. Defaults to 0 (instant sell). Gets added to the profit/hr denominator so illiquid items (armor, artifacts) stop looking artificially better than drugs.
 * @returns {object} Calculated metrics
 */
export function calculateMargins({ buyPrice, sellPrice, slotCount, flightMins, flightMultiplier = 1.0, stockQty = null, sellTimeMins = 0 }) {
  const netSell = sellPrice * 0.95; // 5% item market fee
  const marginPerItem = netSell - buyPrice;
  const marginPct = buyPrice > 0 ? (marginPerItem / buyPrice) * 100 : 0;

  // Effective slots honors available stock — you can't fill 29 slots if only
  // 5 units are on the shelf. Stock-limited runs get a stockLimited flag so
  // the UI can warn the user.
  const effectiveSlots = (stockQty != null && stockQty >= 0)
    ? Math.min(slotCount, stockQty)
    : slotCount;
  const stockLimited = stockQty != null && stockQty < slotCount;

  const runCost = buyPrice * effectiveSlots;
  const profitPerRun = marginPerItem * effectiveSlots;
  const effectiveFlightMins = flightMins * flightMultiplier;
  const roundTripMins = effectiveFlightMins * 2;

  // Cycle time is what your capital is ACTUALLY locked up for: fly there,
  // fly back, AND wait for the stack to sell. For a Xanax run sellTimeMins
  // is ~2; for an armor piece it can be 90+ and materially lowers the rate.
  const cycleMins = roundTripMins + sellTimeMins;
  const profitPerHour = cycleMins > 0 ? (profitPerRun / cycleMins) * 60 : 0;

  return {
    netSell,
    marginPerItem,
    marginPct,
    runCost,
    profitPerRun,
    roundTripMins,
    sellTimeMins,
    cycleMins,
    profitPerHour,
    effectiveSlots,
    stockLimited,
  };
}

/**
 * Plan a full-capacity run for ONE destination: fill the traveler's slots
 * greedily by margin-per-item across every positive-margin item the shop
 * stocks. With unit slot weights, greedy-by-margin IS the optimal knapsack
 * fill — when the best item can't cover every slot, the remainder goes to
 * the next-best shelf instead of flying home light.
 *
 * Sell-time tail: allocations liquidate side by side after landing (list
 * everything, wait for the slowest), so the cycle extends by the MAX of
 * the allocated items' sell times, not the sum.
 *
 * @param {object} p
 * @param {Array<{marginPerItem:number, buyPrice:number, availableQty:number|null,
 *                sellTimeMins?:number}>} p.candidates - one entry per item at
 *        this destination. availableQty null = unlimited (ideal mode);
 *        entries with non-positive margin or zero availability are skipped.
 *        Extra fields (name, row refs) pass through into allocations.
 * @param {number} p.slotCount
 * @param {number} p.flightMins - one-way, pre-multiplier
 * @param {number} p.flightMultiplier
 * @returns {{
 *   allocations: Array<{units:number, ...candidate}>,  // margin-desc order
 *   filledSlots: number, slotCount: number,
 *   profitPerRun: number, runCost: number, marginPct: number,
 *   roundTripMins: number, cycleMins: number, profitPerHour: number,
 * }|null} null when nothing at this destination is worth a slot
 */
export function planDestinationRun({ candidates, slotCount, flightMins, flightMultiplier = 1.0 }) {
  if (!(slotCount > 0) || !(flightMins > 0)) return null;
  const usable = (candidates || []).filter(c =>
    c && c.marginPerItem > 0 && c.buyPrice > 0
    && (c.availableQty == null || c.availableQty > 0)
  );
  if (usable.length === 0) return null;

  usable.sort((a, b) => b.marginPerItem - a.marginPerItem);

  const allocations = [];
  let remaining = slotCount;
  for (const c of usable) {
    if (remaining <= 0) break;
    const units = c.availableQty == null
      ? remaining
      : Math.min(remaining, Math.floor(c.availableQty));
    if (units <= 0) continue;
    allocations.push({ ...c, units });
    remaining -= units;
  }
  if (allocations.length === 0) return null;

  let profitPerRun = 0;
  let runCost = 0;
  let sellTailMins = 0;
  for (const a of allocations) {
    profitPerRun += a.marginPerItem * a.units;
    runCost += a.buyPrice * a.units;
    sellTailMins = Math.max(sellTailMins, a.sellTimeMins || 0);
  }

  const roundTripMins = flightMins * flightMultiplier * 2;
  const cycleMins = roundTripMins + sellTailMins;
  return {
    allocations,
    filledSlots: slotCount - remaining,
    slotCount,
    profitPerRun,
    runCost,
    marginPct: runCost > 0 ? (profitPerRun / runCost) * 100 : 0,
    roundTripMins,
    cycleMins,
    profitPerHour: cycleMins > 0 ? (profitPerRun / cycleMins) * 60 : 0,
  };
}

/**
 * Format minutes as "Xh Ym" string. Round-trip is implied by the Flight
 * column header — spelling out "RT" on every row was wasted width.
 */
export function formatFlightTime(totalMins) {
  const h = Math.floor(totalMins / 60);
  const m = Math.round(totalMins % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Format a number as currency string (e.g. "$1,234,567").
 */
export function formatMoney(n) {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
}

/**
 * Format percentage (e.g. "12.3%").
 */
export function formatPct(n) {
  if (n == null) return '—';
  return n.toFixed(1) + '%';
}

/**
 * Format a margin percentage for card/summary display. Plushies and flowers
 * trade at Points-denominated sell prices against cash buy prices, so the
 * raw margin % is honestly in the 5,000–50,000+ range for those items. The
 * cell-level "%" label becomes unreadable at that scale ("13911%"). Switch
 * to a multiplier label above 1000% and drop the decimal on anything ≥100
 * so the eye can scan the scale quickly.
 *
 *   n < 100   → "62%"
 *   n < 1000  → "340%"
 *   n < 10_000 → "34×"       (1 decimal place up to 999%, multiplier beyond)
 *   n ≥ 10_000 → "140×"      (integer multiplier)
 */
export function formatMarginPctCompact(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) < 100) return `${n.toFixed(1)}%`;
  if (Math.abs(n) < 1000) return `${Math.round(n)}%`;
  // 10× = 1000%. Past that, humans read ratios faster than three-digit percentages.
  const multiplier = n / 100;
  if (Math.abs(multiplier) < 100) return `${multiplier.toFixed(1)}×`;
  return `${Math.round(multiplier)}×`;
}
