// Parallel sell price fetcher — fetches live item market prices
// for all abroad items with non-null IDs via Promise.allSettled.

import { callTornApi } from './torn-api.js';
import { ABROAD_ITEMS } from './data/abroad-items.js';

/**
 * Fetch live sell prices for all items with valid IDs.
 * Uses Promise.allSettled so one failure doesn't block others.
 *
 * @param {number} playerId - Torn player ID (for server-side key decrypt)
 * @param {function} onPrice - Called as each price resolves: (itemId, sellPrice|null)
 * @returns {Map} itemId → lowestPrice (or null if no listings)
 */
export async function fetchAllSellPrices(playerId, onPrice) {
  // Deduplicate by itemId (Xanax 206 appears in Japan + SA)
  const uniqueIds = [...new Set(
    ABROAD_ITEMS
      .filter((item) => item.itemId != null)
      .map((item) => item.itemId)
  )];

  const priceMap = new Map();

  const promises = uniqueIds.map(async (itemId) => {
    const data = await callTornApi({
      section: 'market',
      id: itemId,
      selections: 'itemmarket',
      player_id: playerId,
    });

    let lowestPrice = null;

    if (data?.itemmarket && data.itemmarket.length > 0) {
      lowestPrice = data.itemmarket[0].cost;
    }

    priceMap.set(itemId, lowestPrice);

    if (onPrice) onPrice(itemId, lowestPrice);

    return { itemId, lowestPrice };
  });

  await Promise.allSettled(promises);

  return priceMap;
}
