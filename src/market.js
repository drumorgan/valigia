// Sell price fetcher — reads from Supabase shared cache first,
// only hits the Torn API for stale/missing prices.
// Any fresh prices fetched are written back for all users.

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';

const BATCH_SIZE = 8;
const BATCH_DELAY_MS = 1500;
const STALE_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Fetch sell prices — Supabase first, Torn API only for stale items.
 *
 * @param {number} playerId - Torn player ID (for server-side key decrypt)
 * @param {number[]} itemIds - unique item IDs to fetch
 * @param {function} onPrice - Called as each price resolves: (itemId, sellPrice|null)
 */
export async function fetchAllSellPrices(playerId, itemIds, onPrice) {
  const now = Date.now();

  // 1. Read all cached sell prices from Supabase (single query)
  const { data: cached } = await supabase
    .from('sell_prices')
    .select('item_id, price, updated_at')
    .in('item_id', itemIds);

  const cacheMap = new Map();
  if (cached) {
    for (const row of cached) {
      cacheMap.set(row.item_id, row);
    }
  }

  // 2. Serve fresh cached prices immediately, collect stale IDs
  const staleIds = [];
  for (const itemId of itemIds) {
    const row = cacheMap.get(itemId);
    if (row && (now - new Date(row.updated_at).getTime()) < STALE_MS) {
      if (onPrice) onPrice(itemId, row.price);
    } else {
      staleIds.push(itemId);
    }
  }

  if (staleIds.length === 0) return;

  // 3. Fetch only stale/missing prices from Torn API in batches
  const freshPrices = [];

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

      freshPrices.push({ item_id: itemId, price: lowestPrice, updated_at: new Date().toISOString() });
      if (onPrice) onPrice(itemId, lowestPrice);
    });

    await Promise.allSettled(promises);

    if (i + BATCH_SIZE < staleIds.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // 4. Write fresh prices back to Supabase for all users
  if (freshPrices.length > 0) {
    await supabase
      .from('sell_prices')
      .upsert(freshPrices, { onConflict: 'item_id' });
  }
}
