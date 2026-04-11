// Margin math functions for travel arbitrage calculations.

/**
 * Calculate profit metrics for an item.
 * @param {object} params
 * @param {number} params.buyPrice - Abroad buy price per unit
 * @param {number} params.sellPrice - Item market sell price per unit
 * @param {number} params.slotCount - Number of items per trip
 * @param {number} params.flightMins - One-way flight time in minutes
 * @param {number} params.flightMultiplier - Flight time multiplier (1.0 = standard, 0.7 = airstrip/WLT, 0.49 = both)
 * @returns {object} Calculated metrics
 */
export function calculateMargins({ buyPrice, sellPrice, slotCount, flightMins, flightMultiplier = 1.0 }) {
  const netSell = sellPrice * 0.95; // 5% item market fee
  const marginPerItem = netSell - buyPrice;
  const marginPct = buyPrice > 0 ? (marginPerItem / buyPrice) * 100 : 0;
  const runCost = buyPrice * slotCount;
  const profitPerRun = marginPerItem * slotCount;
  const effectiveFlightMins = flightMins * flightMultiplier;
  const roundTripMins = effectiveFlightMins * 2;
  const profitPerHour = roundTripMins > 0 ? (profitPerRun / roundTripMins) * 60 : 0;

  return {
    netSell,
    marginPerItem,
    marginPct,
    runCost,
    profitPerRun,
    roundTripMins,
    profitPerHour,
  };
}

/**
 * Format minutes as "Xh Ym RT" string.
 */
export function formatFlightTime(totalMins) {
  const h = Math.floor(totalMins / 60);
  const m = Math.round(totalMins % 60);
  if (h === 0) return `${m}m RT`;
  return `${h}h ${m}m RT`;
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
