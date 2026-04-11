// Sell price fetcher — reads from Supabase shared cache first,
// only hits the Torn API for a few stale/missing prices per visit.
// Any fresh prices fetched are written back for all users.

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';
import { showToast } from './ui.js';

const MAX_REFRESH_PER_VISIT = 30;  // max Torn API calls per page load
const STALE_MS = 4 * 60 * 60 * 1000; // 4 hours for items with a price
const NULL_STALE_MS = 5 * 60 * 1000; // 5 minutes for items with no listings (re-check aggressively)

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
  //    Collect missing and stale IDs separately so missing gets priority
  const missingIds = [];
  const nullPriceIds = [];
  const staleIds = [];
  for (const itemId of itemIds) {
    const row = cacheMap.get(itemId);
    if (row) {
      // Serve cached price regardless of age
      if (onPrice) onPrice(itemId, row.price);
      const age = now - new Date(row.updated_at).getTime();
      if (row.price == null && age >= NULL_STALE_MS) {
        // Null price — re-check sooner (listings may have appeared)
        nullPriceIds.push(itemId);
      } else if (age >= STALE_MS) {
        staleIds.push(itemId);
      }
    } else {
      // Missing entirely — highest priority
      missingIds.push(itemId);
    }
  }

  if (missingIds.length === 0 && nullPriceIds.length === 0 && staleIds.length === 0) return;

  // 3. Priority: missing → null-priced (re-check) → stale. Up to cap per visit.
  const toRefresh = [...missingIds, ...nullPriceIds, ...staleIds].slice(0, MAX_REFRESH_PER_VISIT);
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

    // Detect the API help page response — don't overwrite good cached prices
    if (data.selections && !data.itemmarket) {
      apiFailCount++;
      return;
    }

    apiSuccessCount++;

    let lowestPrice = null;
    // V2 itemmarket returns { itemmarket: [...] } or { itemmarket: { listings: [...] } }
    const listings = data.itemmarket?.listings || data.itemmarket;
    if (Array.isArray(listings) && listings.length > 0) {
      lowestPrice = listings[0].cost || listings[0].price;
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
    }
  }
}
