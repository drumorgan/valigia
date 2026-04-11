// Bazaar deal scanner — finds items listed in bazaars significantly below
// item market price. Uses Supabase sell_prices cache for market reference
// and only fetches bazaar listings from the Torn API (one call per item).

import { callTornApi } from './torn-api.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const BATCH_SIZE = 10;           // items per batch
const BATCH_DELAY_MS = 7000;     // delay between batches (respect 100 req/min)

/**
 * Resolve watchlist item names to IDs using the cached Torn item catalog.
 * Returns array of { name, id }.
 */
function resolveWatchlistIds() {
  const cached = localStorage.getItem('valigia_item_id_map');
  if (!cached) return [];

  let nameToId;
  try {
    nameToId = JSON.parse(cached);
  } catch {
    return [];
  }

  const resolved = [];
  for (const name of BAZAAR_WATCHLIST) {
    const id = nameToId[name.toLowerCase()];
    if (id) resolved.push({ name, id });
  }
  return resolved;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract the lowest price from a listing dataset.
 * Handles both v1 array and object formats.
 */
function extractLowest(listings) {
  if (!listings) return null;

  // Array format: [{ cost, quantity }, ...] — already sorted by cost
  if (Array.isArray(listings)) {
    if (listings.length === 0) return null;
    return { price: listings[0].cost, quantity: listings[0].quantity || 1 };
  }

  // Object format: { "listingId": { cost, quantity }, ... }
  if (typeof listings === 'object') {
    let lowest = null;
    for (const listing of Object.values(listings)) {
      if (listing.cost != null && (lowest == null || listing.cost < lowest.price)) {
        lowest = { price: listing.cost, quantity: listing.quantity || 1 };
      }
    }
    return lowest;
  }

  return null;
}

/**
 * Scan bazaar listings for deals below market price.
 * Fetches BOTH bazaar and market prices in a single API call per item
 * (selections=bazaar,lookup), so no Supabase dependency.
 *
 * @param {number} playerId - Torn player ID (for proxy auth)
 * @param {function} onProgress - Called with (scanned, total) after each item
 * @param {function} onDeal - Called immediately when a deal is found
 * @returns {Promise<Array>} Sorted deals array (best % off first)
 */
export async function scanBazaarDeals(playerId, onProgress, onDeal) {
  const items = resolveWatchlistIds();
  if (items.length === 0) return [];

  const deals = [];
  let scanned = 0;
  const total = items.length;

  // Process in batches to respect rate limits
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (item) => {
      // Fetch both bazaar and market prices in one call
      const data = await callTornApi({
        section: 'market',
        id: item.id,
        selections: 'bazaar,lookup',
        player_id: playerId,
      });

      scanned++;
      if (onProgress) onProgress(scanned, total);

      if (!data) return;

      const bazaar = extractLowest(data.bazaar);
      if (!bazaar) return;

      // Market price from the lookup data (itemmarket array)
      let marketPrice = null;
      if (Array.isArray(data.itemmarket) && data.itemmarket.length > 0) {
        marketPrice = data.itemmarket[0].cost;
      }
      if (!marketPrice || marketPrice <= 0) return;

      const savings = marketPrice - bazaar.price;
      const savingsPct = (savings / marketPrice) * 100;

      // Show any deal where bazaar is cheaper than market
      if (savings > 0) {
        const deal = {
          itemId: item.id,
          itemName: item.name,
          bazaarPrice: bazaar.price,
          bazaarQty: bazaar.quantity,
          marketPrice,
          savings,
          savingsPct,
        };
        deals.push(deal);
        if (onDeal) onDeal(deal);
      }
    });

    await Promise.allSettled(promises);

    if (i + BATCH_SIZE < items.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return deals.sort((a, b) => b.savingsPct - a.savingsPct);
}
