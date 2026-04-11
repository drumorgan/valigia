// Bazaar deal scanner — finds items listed in bazaars below item market price.
// Self-contained: resolves its own item IDs and fetches both bazaar + market
// prices via separate API calls per item.

import { callTornApi } from './torn-api.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const BATCH_SIZE = 5;            // items per batch (2 calls each = 10 API calls)
const BATCH_DELAY_MS = 7000;     // delay between batches (respect 100 req/min)

/**
 * Resolve watchlist item names to IDs.
 * Tries localStorage cache first, then fetches the full Torn item catalog.
 */
async function resolveWatchlistIds(playerId) {
  // Try cache first
  let nameToId = null;
  const cached = localStorage.getItem('valigia_item_id_map');
  if (cached) {
    try { nameToId = JSON.parse(cached); } catch { /* ignore */ }
  }

  // If no cache, fetch the item catalog ourselves
  if (!nameToId) {
    const data = await callTornApi({
      section: 'torn',
      selections: 'items',
      player_id: playerId,
    });

    if (!data?.items) return [];

    nameToId = {};
    for (const [idStr, item] of Object.entries(data.items)) {
      nameToId[item.name.toLowerCase()] = Number(idStr);
    }
    // Save for future use
    localStorage.setItem('valigia_item_id_map', JSON.stringify(nameToId));
  }

  const resolved = [];
  const unresolved = [];
  for (const name of BAZAAR_WATCHLIST) {
    const id = nameToId[name.toLowerCase()];
    if (id) {
      resolved.push({ name, id });
    } else {
      unresolved.push(name);
    }
  }

  return { resolved, unresolved };
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

  if (Array.isArray(listings)) {
    if (listings.length === 0) return null;
    return { price: listings[0].cost, quantity: listings[0].quantity || 1 };
  }

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
 *
 * @param {number} playerId - Torn player ID (for proxy auth)
 * @param {function} onProgress - Called with (scanned, total) after each item
 * @param {function} onDeal - Called immediately when a deal is found
 * @returns {Promise<object>} { deals, stats }
 */
export async function scanBazaarDeals(playerId, onProgress, onDeal) {
  const { resolved: items, unresolved } = await resolveWatchlistIds(playerId);

  const stats = {
    watchlistSize: BAZAAR_WATCHLIST.length,
    resolved: items.length,
    unresolved,
    hadBazaar: 0,
    hadMarket: 0,
    cheaper: 0,
    apiErrors: 0,
    firstBazaarKeys: null,   // raw response keys for debugging
    firstMarketKeys: null,
    firstBazaarSample: null,
    firstMarketSample: null,
  };

  if (items.length === 0) return { deals: [], stats };

  const deals = [];
  let scanned = 0;
  const total = items.length;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (item) => {
      // Two separate API calls — both individually proven to work
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

      if (!bazaarData) { stats.apiErrors++; }
      if (!marketData) { stats.apiErrors++; }

      // Capture first raw response for debugging
      if (bazaarData && !stats.firstBazaarKeys) {
        stats.firstBazaarKeys = Object.keys(bazaarData).join(', ');
        stats.firstBazaarSample = JSON.stringify(bazaarData).substring(0, 200);
      }
      if (marketData && !stats.firstMarketKeys) {
        stats.firstMarketKeys = Object.keys(marketData).join(', ');
        stats.firstMarketSample = JSON.stringify(marketData).substring(0, 200);
      }

      const bazaar = bazaarData ? extractLowest(bazaarData.bazaar) : null;
      if (bazaar) stats.hadBazaar++;

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
