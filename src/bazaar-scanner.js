// Bazaar deal scanner — finds items in bazaars below item market price.
// Uses the V2 Torn API for both bazaar and market lookups.

import { callTornApi } from './torn-api.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 7000;

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
 * Scan bazaar listings for deals below item market price.
 * Uses V2 API endpoints for more reliable data retrieval.
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
      // Try V2 API first for market lookup, fall back to V1
      // V2 URL: /v2/market/{id}/lookup
      // V1 URL: /market/{id}?selections=lookup
      const marketData = await callTornApi({
        section: 'market',
        id: item.id,
        selections: 'lookup',
        player_id: playerId,
        v2: true,
      });

      // Bazaar via V2: /v2/market/{id}/bazaar
      const bazaarData = await callTornApi({
        section: 'market',
        id: item.id,
        selections: 'bazaar',
        player_id: playerId,
        v2: true,
      });

      scanned++;
      if (onProgress) onProgress(scanned, total);

      // Capture samples for debugging (first 3 items)
      if (stats.sampleResponses.length < 3) {
        const mSample = marketData ? JSON.stringify(marketData).substring(0, 150) : 'null';
        const bSample = bazaarData ? JSON.stringify(bazaarData).substring(0, 150) : 'null';
        stats.sampleResponses.push({
          name: item.name,
          id: item.id,
          marketKeys: marketData ? Object.keys(marketData).join(',') : 'null',
          bazaarKeys: bazaarData ? Object.keys(bazaarData).join(',') : 'null',
          mSample,
          bSample,
        });
      }

      if (!bazaarData) stats.apiErrors++;
      if (!marketData) stats.apiErrors++;

      // V2 may return data under different keys — try multiple
      const bazaar = extractLowest(bazaarData?.bazaar)
        || extractLowest(bazaarData?.listings)
        || extractLowest(bazaarData?.items);
      if (bazaar) stats.hadBazaar++;

      // V2 lookup may return under itemmarket, market, or items
      let marketPrice = null;
      const mktList = marketData?.itemmarket || marketData?.market || marketData?.items;
      if (Array.isArray(mktList) && mktList.length > 0) {
        marketPrice = mktList[0].cost || mktList[0].price;
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
