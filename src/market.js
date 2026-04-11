// Sell price fetcher — reads from Supabase shared cache first,
// only hits the Torn API for a few stale/missing prices per visit.
// Any fresh prices fetched are written back for all users.

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';
import { showToast } from './ui.js';

const MAX_REFRESH_PER_VISIT = 5;  // max Torn API calls per page load
const STALE_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Fetch sell prices — Supabase first, Torn API only for a handful of stale items.
 * Cache fills organically over multiple visits / users.
 *
 * @param {number} playerId - Torn player ID (for server-side key decrypt)
 * @param {number[]} itemIds - unique item IDs to fetch
 * @param {function} onPrice - Called as each price resolves: (itemId, sellPrice|null)
 */
export async function fetchAllSellPrices(playerId, itemIds, onPrice) {
  const now = Date.now();

  // 1. Read all cached sell prices from Supabase (single query)
  const { data: cached, error: readErr } = await supabase
    .from('sell_prices')
    .select('item_id, price, updated_at')
    .in('item_id', itemIds);

  if (readErr) {
    showToast(`Supabase read error: ${readErr.message}`, 'warning');
  }

  const cacheMap = new Map();
  if (cached) {
    for (const row of cached) {
      cacheMap.set(row.item_id, row);
    }
  }

  // 2. Serve ALL cached prices immediately (even stale — better than nothing)
  //    Collect stale/missing IDs for refresh
  const staleIds = [];
  for (const itemId of itemIds) {
    const row = cacheMap.get(itemId);
    if (row) {
      // Serve cached price regardless of age
      if (onPrice) onPrice(itemId, row.price);
      // Mark as stale if too old
      if ((now - new Date(row.updated_at).getTime()) >= STALE_MS) {
        staleIds.push(itemId);
      }
    } else {
      // Missing entirely — highest priority
      staleIds.push(itemId);
    }
  }

  if (staleIds.length === 0) {
    showToast(`Sell prices: all ${cacheMap.size} cached, 0 stale`, 'success');
    return;
  }

  // 3. Only refresh a small number per visit to stay under rate limits
  const toRefresh = staleIds.slice(0, MAX_REFRESH_PER_VISIT);
  const freshPrices = [];
  let apiSuccessCount = 0;
  let apiFailCount = 0;

  const promises = toRefresh.map(async (itemId) => {
    const data = await callTornApi({
      section: 'market',
      id: itemId,
      selections: 'itemmarket',
      player_id: playerId,
      v2: true,
    });

    if (!data) {
      apiFailCount++;
      return;
    }

    apiSuccessCount++;
    let lowestPrice = null;
    if (data?.itemmarket?.listings && data.itemmarket.listings.length > 0) {
      lowestPrice = data.itemmarket.listings[0].price;
    }

    freshPrices.push({ item_id: itemId, price: lowestPrice, updated_at: new Date().toISOString() });
    if (onPrice) onPrice(itemId, lowestPrice);
  });

  await Promise.allSettled(promises);

  // 4. Write fresh prices back to Supabase for all users
  if (freshPrices.length > 0) {
    const { error: writeErr } = await supabase
      .from('sell_prices')
      .upsert(freshPrices, { onConflict: 'item_id' });

    if (writeErr) {
      showToast(`Supabase write error: ${writeErr.message}`, 'warning');
    } else {
      showToast(`Sell prices: ${cacheMap.size} cached, ${apiSuccessCount} refreshed, ${apiFailCount} failed, ${freshPrices.length} written to Supabase`, 'success');
    }
  } else {
    showToast(`Sell prices: ${cacheMap.size} cached, 0/${toRefresh.length} API calls succeeded`, 'warning');
  }
}
