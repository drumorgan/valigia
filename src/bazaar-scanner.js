// Bazaar deal scanner — finds items listed in bazaars significantly below
// item market price. Uses batched API calls to stay within rate limits.

import { callTornApi } from './torn-api.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const DEAL_THRESHOLD_PCT = 10;   // minimum % below market to flag as deal
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
 * Extract the lowest bazaar price from a Torn API response.
 * Handles both v1 object/array formats.
 */
function extractLowestBazaar(bazaarData) {
  if (!bazaarData) return null;

  // Array format: [{ cost, quantity }, ...]
  if (Array.isArray(bazaarData)) {
    if (bazaarData.length === 0) return null;
    // Already sorted by price in Torn API
    return { price: bazaarData[0].cost, quantity: bazaarData[0].quantity || 1 };
  }

  // Object format: { "listingId": { cost, quantity }, ... }
  if (typeof bazaarData === 'object') {
    let lowest = null;
    for (const listing of Object.values(bazaarData)) {
      if (listing.cost != null && (lowest == null || listing.cost < lowest.price)) {
        lowest = { price: listing.cost, quantity: listing.quantity || 1 };
      }
    }
    return lowest;
  }

  return null;
}

/**
 * Extract the lowest item market price from a Torn API response.
 * Handles v1 array and v2 listings format.
 */
function extractLowestMarket(marketData) {
  if (!marketData) return null;

  // V2: { listings: [{ price, quantity }] }
  if (marketData.listings && marketData.listings.length > 0) {
    return marketData.listings[0].price;
  }

  // V1: [{ cost, quantity }]
  if (Array.isArray(marketData) && marketData.length > 0) {
    return marketData[0].cost;
  }

  return null;
}

/**
 * Scan bazaar listings for deals below market price.
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

  // Process in batches to respect rate limits
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (item) => {
      // Single call with both selections — returns bazaar + itemmarket
      const data = await callTornApi({
        section: 'market',
        id: item.id,
        selections: 'bazaar,itemmarket',
        player_id: playerId,
      });

      scanned++;
      if (onProgress) onProgress(scanned, items.length);

      if (!data) return;

      const bazaar = extractLowestBazaar(data.bazaar);
      const marketPrice = extractLowestMarket(data.itemmarket);

      if (!bazaar || !marketPrice || marketPrice <= 0) return;

      const savings = marketPrice - bazaar.price;
      const savingsPct = (savings / marketPrice) * 100;

      if (savingsPct >= DEAL_THRESHOLD_PCT) {
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

    // Delay between batches (skip after last batch)
    if (i + BATCH_SIZE < items.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return deals.sort((a, b) => b.savingsPct - a.savingsPct);
}
