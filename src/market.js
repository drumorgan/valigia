// Parallel sell price fetcher — fetches live item market prices
// for all known items via Promise.allSettled.

import { callTornApi } from './torn-api.js';

/**
 * Fetch live sell prices for a list of item IDs.
 * Uses Promise.allSettled so one failure doesn't block others.
 *
 * @param {number} playerId - Torn player ID (for server-side key decrypt)
 * @param {number[]} itemIds - unique item IDs to fetch
 * @param {function} onPrice - Called as each price resolves: (itemId, sellPrice|null)
 * @returns {Map} itemId → lowestPrice (or null if no listings)
 */
export async function fetchAllSellPrices(playerId, itemIds, onPrice) {
  const priceMap = new Map();

  const promises = itemIds.map(async (itemId) => {
    const data = await callTornApi({
      section: 'market',
      id: itemId,
      selections: 'itemmarket',
      player_id: playerId,
      v2: true,
    });

    let lowestPrice = null;

    // V2 response: { itemmarket: { item: {...}, listings: [{ price, amount }, ...] } }
    if (data?.itemmarket?.listings && data.itemmarket.listings.length > 0) {
      lowestPrice = data.itemmarket.listings[0].price;
    }

    priceMap.set(itemId, lowestPrice);

    if (onPrice) onPrice(itemId, lowestPrice);

    return { itemId, lowestPrice };
  });

  await Promise.allSettled(promises);

  return priceMap;
}
