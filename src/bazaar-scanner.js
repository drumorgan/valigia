// Bazaar deal scanner — finds items listed in bazaars below item market price.
// Self-contained: resolves its own item IDs and fetches prices via the Torn API.

import { callTornApi } from './torn-api.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 7000;

/**
 * Resolve watchlist item names to IDs.
 * Tries localStorage cache first, then fetches the full Torn item catalog.
 */
async function resolveWatchlistIds(playerId) {
  let nameToId = null;
  const cached = localStorage.getItem('valigia_item_id_map');
  if (cached) {
    try { nameToId = JSON.parse(cached); } catch { /* ignore */ }
  }

  if (!nameToId) {
    const data = await callTornApi({
      section: 'torn',
      selections: 'items',
      player_id: playerId,
    });
    if (!data?.items) return { resolved: [], unresolved: BAZAAR_WATCHLIST.slice() };

    nameToId = {};
    for (const [idStr, item] of Object.entries(data.items)) {
      nameToId[item.name.toLowerCase()] = Number(idStr);
    }
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
 * Uses SEQUENTIAL calls per item (bazaar then lookup) to avoid proxy
 * concurrency issues with key decryption.
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
    sampleResponses: [],
  };

  if (items.length === 0) return { deals: [], stats };

  const deals = [];
  let scanned = 0;
  const total = items.length;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (item) => {
      // SEQUENTIAL calls per item to avoid proxy concurrency issues
      // 1. Fetch bazaar listings
      const bazaarData = await callTornApi({
        section: 'market',
        id: item.id,
        selections: 'bazaar',
        player_id: playerId,
      });

      // 2. Then fetch market price (lookup)
      const marketData = await callTornApi({
        section: 'market',
        id: item.id,
        selections: 'lookup',
        player_id: playerId,
      });

      scanned++;
      if (onProgress) onProgress(scanned, total);

      // Capture samples for debugging (first 3 items)
      if (stats.sampleResponses.length < 3) {
        stats.sampleResponses.push({
          name: item.name,
          id: item.id,
          bazaarKeys: bazaarData ? Object.keys(bazaarData) : null,
          marketKeys: marketData ? Object.keys(marketData) : null,
          bazaarType: bazaarData?.bazaar ? (Array.isArray(bazaarData.bazaar) ? `array[${bazaarData.bazaar.length}]` : typeof bazaarData.bazaar) : 'missing',
          marketType: marketData?.itemmarket ? (Array.isArray(marketData.itemmarket) ? `array[${marketData.itemmarket.length}]` : typeof marketData.itemmarket) : 'missing',
        });
      }

      if (!bazaarData) stats.apiErrors++;
      if (!marketData) stats.apiErrors++;

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
