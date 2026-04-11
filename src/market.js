// Sell price fetcher — fetches live item market prices from Torn API.
// Caches prices in localStorage so we only re-fetch stale ones.

import { callTornApi } from './torn-api.js';

const BATCH_SIZE = 8;
const BATCH_DELAY_MS = 1500;
const CACHE_KEY = 'valigia_sell_prices';
const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Read the sell price cache from localStorage. */
function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

/** Write the sell price cache to localStorage. */
function writeCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

/**
 * Fetch live sell prices for a list of item IDs.
 * Serves cached prices immediately, then only fetches stale/missing ones.
 *
 * @param {number} playerId - Torn player ID (for server-side key decrypt)
 * @param {number[]} itemIds - unique item IDs to fetch
 * @param {function} onPrice - Called as each price resolves: (itemId, sellPrice|null)
 * @returns {Map} itemId → lowestPrice (or null if no listings)
 */
export async function fetchAllSellPrices(playerId, itemIds, onPrice) {
  const priceMap = new Map();
  const cache = readCache();
  const now = Date.now();
  const staleIds = [];

  // Serve cached prices immediately, collect stale ones
  for (const itemId of itemIds) {
    const cached = cache[itemId];
    if (cached && (now - cached.at) < CACHE_MAX_AGE_MS) {
      priceMap.set(itemId, cached.price);
      if (onPrice) onPrice(itemId, cached.price);
    } else {
      staleIds.push(itemId);
    }
  }

  // Fetch only stale/missing prices in batches
  for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
    const batch = staleIds.slice(i, i + BATCH_SIZE);

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
      cache[itemId] = { price: lowestPrice, at: now };
      if (onPrice) onPrice(itemId, lowestPrice);
    });

    await Promise.allSettled(promises);

    // Pause between batches to stay under 100 req/min rate limit
    if (i + BATCH_SIZE < staleIds.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Persist updated cache
  if (staleIds.length > 0) {
    writeCache(cache);
  }

  return priceMap;
}
