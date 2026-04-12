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
 * Fetch a single item's market snapshot from the Torn API.
 * Shared by the cache-aware batch fetcher and the targeted refresh path.
 * Returns null on network / help-page responses so callers can skip them
 * without overwriting existing cache entries.
 */
async function fetchOneSellPrice(playerId, itemId) {
  const data = await callTornApi({
    section: 'market',
    id: itemId,
    selections: 'itemmarket',
    player_id: playerId,
    v2: true,
  });

  if (!data) return null;
  // Detect the API help page response — don't overwrite good cached prices
  if (data.selections && !data.itemmarket) return null;

  let lowestPrice = null;
  let floorQty = null;
  let listingCount = null;
  // V2 itemmarket returns { itemmarket: [...] } or { itemmarket: { listings: [...] } }
  const listings = data.itemmarket?.listings || data.itemmarket;
  if (Array.isArray(listings) && listings.length > 0) {
    lowestPrice = listings[0].cost || listings[0].price;
    // Torn v2 uses `amount`; older shapes occasionally used `quantity`.
    // Fall back to 1 so a listing with no qty field at least counts itself.
    floorQty = listings[0].amount ?? listings[0].quantity ?? 1;
    listingCount = listings.length;
  } else if (Array.isArray(listings)) {
    // Empty listings array — record a zero so the cell explicitly shows
    // "no listings" depth rather than stale history.
    listingCount = 0;
  }

  return { lowestPrice, floorQty, listingCount };
}

/**
 * Fetch sell prices — Supabase first, Torn API only for a handful of stale items.
 * Cache fills organically over multiple visits / users.
 *
 * @param {number} playerId - Torn player ID (for server-side key decrypt)
 * @param {number[]} itemIds - unique item IDs to fetch
 * @param {function} onPrice - Called as each price resolves:
 *   (itemId, sellPrice|null, depth|null, fetchedAt) where depth is
 *   { floorQty, listingCount } or null if unknown / no listings, and
 *   fetchedAt is the ms timestamp of the data source (cache row's
 *   updated_at, or Date.now() for a fresh Torn fetch).
 */
export async function fetchAllSellPrices(playerId, itemIds, onPrice) {
  const now = Date.now();

  // 1. Read all cached sell prices from Supabase (single query)
  const { data: cached, error: readErr } = await supabase
    .from('sell_prices')
    .select('item_id, price, updated_at, floor_qty, listing_count')
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
  //    Collect missing and stale IDs separately so missing gets priority.
  //    Within each bucket, prioritize high-value items: a stale $850K Xanax
  //    matters far more than a stale $500 Dahlia.
  const missingIds = [];
  const nullPriceIds = [];
  const staleIds = []; // [{ itemId, price }] — sorted by price desc below
  for (const itemId of itemIds) {
    const row = cacheMap.get(itemId);
    if (row) {
      // Serve cached price (and depth if we have it) regardless of age.
      const cachedDepth = (row.floor_qty != null || row.listing_count != null)
        ? { floorQty: row.floor_qty, listingCount: row.listing_count }
        : null;
      const cachedAt = new Date(row.updated_at).getTime();
      if (onPrice) onPrice(itemId, row.price, cachedDepth, cachedAt);
      const age = now - cachedAt;
      if (row.price == null && age >= NULL_STALE_MS) {
        // Null price — re-check sooner (listings may have appeared)
        nullPriceIds.push(itemId);
      } else if (age >= STALE_MS) {
        staleIds.push({ itemId, price: row.price || 0 });
      }
    } else {
      // Missing entirely — highest priority
      missingIds.push(itemId);
    }
  }

  if (missingIds.length === 0 && nullPriceIds.length === 0 && staleIds.length === 0) return;

  // Sort stale items by cached price descending so high-value stale prices
  // get refreshed first. (Missing items have no cached price, so we preserve
  // input order; null-priced items re-check aggressively regardless of value.)
  staleIds.sort((a, b) => b.price - a.price);
  const staleIdsByValue = staleIds.map(s => s.itemId);

  // 3. Priority: missing → null-priced (re-check) → stale-by-value. Up to cap per visit.
  const toRefresh = [...missingIds, ...nullPriceIds, ...staleIdsByValue].slice(0, MAX_REFRESH_PER_VISIT);
  const freshPrices = [];
  let apiSuccessCount = 0;
  let apiFailCount = 0;

  const promises = toRefresh.map(async (itemId) => {
    const result = await fetchOneSellPrice(playerId, itemId);
    if (!result) {
      apiFailCount++;
      return;
    }
    apiSuccessCount++;

    const { lowestPrice, floorQty, listingCount } = result;
    const fetchedAt = Date.now();
    freshPrices.push({
      item_id: itemId,
      price: lowestPrice,
      floor_qty: floorQty,
      listing_count: listingCount,
      updated_at: new Date(fetchedAt).toISOString(),
    });
    const depth = (floorQty != null || listingCount != null)
      ? { floorQty, listingCount }
      : null;
    if (onPrice) onPrice(itemId, lowestPrice, depth, fetchedAt);
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

/**
 * Force-refresh sell prices for a specific set of item IDs directly from the
 * Torn API, bypassing the cache-freshness check. Used by the category filter
 * click handler to top up items that are older than the filter threshold.
 * Writes fresh rows back to Supabase so every user benefits.
 *
 * @param {number} playerId
 * @param {number[]} itemIds - already-deduped list of items to refresh
 * @param {function} onPrice - same signature as fetchAllSellPrices
 */
export async function refreshSellPrices(playerId, itemIds, onPrice) {
  if (!itemIds || itemIds.length === 0) return;

  const freshPrices = [];
  const promises = itemIds.map(async (itemId) => {
    const result = await fetchOneSellPrice(playerId, itemId);
    if (!result) return;

    const { lowestPrice, floorQty, listingCount } = result;
    const fetchedAt = Date.now();
    freshPrices.push({
      item_id: itemId,
      price: lowestPrice,
      floor_qty: floorQty,
      listing_count: listingCount,
      updated_at: new Date(fetchedAt).toISOString(),
    });
    const depth = (floorQty != null || listingCount != null)
      ? { floorQty, listingCount }
      : null;
    if (onPrice) onPrice(itemId, lowestPrice, depth, fetchedAt);
  });

  await Promise.allSettled(promises);

  if (freshPrices.length > 0) {
    const { error: writeErr } = await supabase
      .from('sell_prices')
      .upsert(freshPrices, { onConflict: 'item_id' });

    if (writeErr) {
      showToast(`Supabase write error: ${writeErr.message}`, 'warning');
    }
  }
}
