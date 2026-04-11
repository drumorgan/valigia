// Bazaar deal scanner — finds items listed in bazaars significantly below
// item market price. Uses Supabase sell_prices cache for market reference
// and only fetches bazaar listings from the Torn API (one call per item).

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const DEAL_THRESHOLD_PCT = 0;    // show ANY deal where bazaar < market (tune up later)
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

/**
 * Fetch market prices from Supabase sell_prices cache.
 * Returns Map of itemId → price.
 */
async function getMarketPricesFromCache(itemIds) {
  const { data } = await supabase
    .from('sell_prices')
    .select('item_id, price')
    .in('item_id', itemIds);

  const map = new Map();
  if (data) {
    for (const row of data) {
      if (row.price != null) map.set(row.item_id, row.price);
    }
  }
  return map;
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
 * Scan bazaar listings for deals below market price.
 * Market prices come from the Supabase sell_prices cache (shared across all users).
 * Only bazaar listings are fetched live from the Torn API.
 *
 * @param {number} playerId - Torn player ID (for proxy auth)
 * @param {function} onProgress - Called with (scanned, total) after each item
 * @param {function} onDeal - Called immediately when a deal is found
 * @returns {Promise<Array>} Sorted deals array (best % off first)
 */
export async function scanBazaarDeals(playerId, onProgress, onDeal) {
  const items = resolveWatchlistIds();
  if (items.length === 0) return [];

  // Get market prices from Supabase cache (free, instant)
  const marketPrices = await getMarketPricesFromCache(items.map(i => i.id));

  const deals = [];
  let scanned = 0;
  const total = items.length;

  // Process in batches to respect rate limits
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (item) => {
      // Only fetch bazaar listings — market price comes from cache
      const data = await callTornApi({
        section: 'market',
        id: item.id,
        selections: 'bazaar',
        player_id: playerId,
      });

      scanned++;
      if (onProgress) onProgress(scanned, total);

      if (!data) return;

      const bazaar = extractLowestBazaar(data.bazaar);
      if (!bazaar) return;

      const marketPrice = marketPrices.get(item.id);
      if (!marketPrice || marketPrice <= 0) return;

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

    if (i + BATCH_SIZE < items.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return deals.sort((a, b) => b.savingsPct - a.savingsPct);
}
