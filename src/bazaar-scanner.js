// Bazaar deal scanner — finds items in bazaars below item market price.
// 1. V2 market/{id}/itemmarket → current market price
// 2. V2 market/{id}/bazaar → list of bazaars selling the item
// 3. For each bazaar, fetch user/{bazaarId}/bazaar → actual prices
// Compares lowest bazaar price to market price.

import { callTornApi } from './torn-api.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const BATCH_SIZE = 3;            // items per batch (multiple API calls each)
const BATCH_DELAY_MS = 7000;
const MAX_BAZAARS_PER_ITEM = 3;  // check top N bazaars per item for prices

/**
 * Resolve watchlist item names to IDs.
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
 * Get the lowest item market price from V2 itemmarket response.
 */
function extractMarketPrice(data) {
  if (!data) return null;

  // V2 itemmarket returns { itemmarket: { listings: [...] } } or { itemmarket: [...] }
  const listings = data.itemmarket?.listings || data.itemmarket;
  if (Array.isArray(listings) && listings.length > 0) {
    // Find the lowest cost
    let lowest = listings[0].cost || listings[0].price;
    for (const l of listings) {
      const p = l.cost || l.price;
      if (p && p < lowest) lowest = p;
    }
    return lowest;
  }

  return null;
}

/**
 * Get bazaar IDs that sell a specific item from V2 bazaar response.
 */
function extractBazaarIds(data) {
  if (!data?.bazaar) return [];

  // V2 returns { bazaar: { specialized: [...], ... } }
  const ids = [];
  for (const category of Object.values(data.bazaar)) {
    if (Array.isArray(category)) {
      for (const baz of category) {
        if (baz.id) ids.push(baz.id);
      }
    }
  }
  return ids.slice(0, MAX_BAZAARS_PER_ITEM);
}

/**
 * Fetch a specific bazaar's listing for an item.
 * Uses user/{bazaarOwnerId}/bazaar to get their bazaar inventory.
 */
async function getBazaarPrice(bazaarOwnerId, itemId, playerId) {
  const data = await callTornApi({
    section: 'user',
    id: bazaarOwnerId,
    selections: 'bazaar',
    player_id: playerId,
  });

  if (!data?.bazaar) return null;

  // bazaar response: { bazaar: { "itemId": { name, price, quantity, ... }, ... } }
  // or array format
  if (Array.isArray(data.bazaar)) {
    for (const item of data.bazaar) {
      if (item.ID === itemId || item.id === itemId) {
        return { price: item.cost || item.price || item.market_price, quantity: item.quantity || 1 };
      }
    }
  } else if (typeof data.bazaar === 'object') {
    for (const item of Object.values(data.bazaar)) {
      if (item.ID === itemId || item.id === itemId) {
        return { price: item.cost || item.price || item.market_price, quantity: item.quantity || 1 };
      }
    }
  }

  return null;
}

/**
 * Scan bazaar listings for deals below item market price.
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
      // 1. Get market price via V2 itemmarket
      const marketData = await callTornApi({
        section: 'market',
        id: item.id,
        selections: 'itemmarket',
        player_id: playerId,
        v2: true,
      });

      const marketPrice = extractMarketPrice(marketData);
      if (marketPrice) stats.hadMarket++;

      // 2. Get list of bazaars selling this item via V2
      const bazaarListData = await callTornApi({
        section: 'market',
        id: item.id,
        selections: 'bazaar',
        player_id: playerId,
        v2: true,
      });

      const bazaarIds = extractBazaarIds(bazaarListData);

      // Capture samples for first 3 items
      if (stats.sampleResponses.length < 3) {
        stats.sampleResponses.push({
          name: item.name,
          id: item.id,
          marketKeys: marketData ? Object.keys(marketData).join(',') : 'null',
          marketPrice,
          bazaarCount: bazaarIds.length,
          mSample: marketData ? JSON.stringify(marketData).substring(0, 120) : 'null',
        });
      }

      if (!marketData) stats.apiErrors++;
      if (!bazaarListData) stats.apiErrors++;

      scanned++;
      if (onProgress) onProgress(scanned, total);

      if (!marketPrice || bazaarIds.length === 0) return;

      // 3. Check actual bazaar prices (top N bazaars)
      let lowestBazaar = null;
      for (const bazId of bazaarIds) {
        const bp = await getBazaarPrice(bazId, item.id, playerId);
        if (bp && (!lowestBazaar || bp.price < lowestBazaar.price)) {
          lowestBazaar = bp;
        }
      }

      if (lowestBazaar) stats.hadBazaar++;
      if (!lowestBazaar) return;

      const savings = marketPrice - lowestBazaar.price;
      const savingsPct = (savings / marketPrice) * 100;

      if (savings > 0) {
        stats.cheaper++;
        const deal = {
          itemId: item.id,
          itemName: item.name,
          bazaarPrice: lowestBazaar.price,
          bazaarQty: lowestBazaar.quantity,
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
