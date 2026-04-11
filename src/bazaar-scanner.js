// Bazaar deal scanner — finds items listed in bazaars below item market price.
// Makes two API calls per item: one for bazaar listings, one for market price.

import { callTornApi } from './torn-api.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const BATCH_SIZE = 5;            // items per batch (2 calls each = 10 API calls)
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
 * Makes two separate API calls per item (bazaar + lookup) to guarantee
 * both datasets are returned correctly.
 *
 * @param {number} playerId - Torn player ID (for proxy auth)
 * @param {function} onProgress - Called with (scanned, total) after each item
 * @param {function} onDeal - Called immediately when a deal is found
 * @returns {Promise<object>} { deals, stats }
 */
export async function scanBazaarDeals(playerId, onProgress, onDeal) {
  const items = resolveWatchlistIds();

  const stats = {
    watchlistSize: BAZAAR_WATCHLIST.length,
    resolved: items.length,
    hadBazaar: 0,
    hadMarket: 0,
    cheaper: 0,
  };

  if (items.length === 0) return { deals: [], stats };

  const deals = [];
  let scanned = 0;
  const total = items.length;

  // Process in batches to respect rate limits
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (item) => {
      // Two separate calls — both proven to work individually
      const [bazaarData, marketData] = await Promise.all([
        callTornApi({
          section: 'market',
          id: item.id,
          selections: 'bazaar',
          player_id: playerId,
        }),
        callTornApi({
          section: 'market',
          id: item.id,
          selections: 'lookup',
          player_id: playerId,
        }),
      ]);

      scanned++;
      if (onProgress) onProgress(scanned, total);

      // Extract lowest bazaar listing
      const bazaar = bazaarData ? extractLowest(bazaarData.bazaar) : null;
      if (bazaar) stats.hadBazaar++;

      // Extract lowest market price
      let marketPrice = null;
      if (marketData && Array.isArray(marketData.itemmarket) && marketData.itemmarket.length > 0) {
        marketPrice = marketData.itemmarket[0].cost;
        stats.hadMarket++;
      }

      if (!bazaar || !marketPrice) return;

      const savings = marketPrice - bazaar.price;
      const savingsPct = (savings / marketPrice) * 100;

      if (savings > 0) {
        stats.cheaper++;
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

  return { deals: deals.sort((a, b) => b.savingsPct - a.savingsPct), stats };
}
