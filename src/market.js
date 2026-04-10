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
const BATCH_SIZE = 8;
const BATCH_DELAY_MS = 1500;

export async function fetchAllSellPrices(playerId, itemIds, onPrice) {
  const priceMap = new Map();

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batch = itemIds.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (itemId) => {
      const data = await callTornApi({
        section: 'market',
        id: itemId,
        selections: 'itemmarket',
        player_id: playerId,
        v2: true,
      });

      let lowestPrice = null;
      if (data?.itemmarket?.listings && data.itemmarket.listings.length > 0) {
        lowestPrice = data.itemmarket.listings[0].price;
      }

      priceMap.set(itemId, lowestPrice);
      if (onPrice) onPrice(itemId, lowestPrice);
    });

    await Promise.allSettled(promises);

    // Pause between batches to stay under 100 req/min rate limit
    if (i + BATCH_SIZE < itemIds.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return priceMap;
}
