// Bazaar deal scanner — crowd-sourced "super database" of bazaar prices.
//
// Strategy: every scan contributes to a shared Supabase pool. Over time the
// system learns which bazaars carry which items and at what prices.
//
// Per-scan flow (budget: ~30 API calls):
//   Phase 1 — FREE (Supabase reads, 0 API calls)
//     • Read market prices from sell_prices cache
//     • Read known bazaar sources from bazaar_prices pool
//   Phase 2 — DISCOVER (~5 API calls)
//     • Pick random items with few known sources
//     • V2 market/{id}/bazaar → discover new bazaar IDs
//   Phase 3 — CHECK (~25 API calls)
//     • Check bazaars, prioritizing least-recently-checked
//     • V1 user/{bazaarId}/bazaar → actual prices
//   Phase 4 — WRITE BACK (Supabase upsert, 0 API calls)
//     • All discoveries written to bazaar_prices for everyone

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const DISCOVER_BUDGET = 8;    // API calls for discovering new bazaar sources
const CHECK_BUDGET = 25;      // API calls for checking unique bazaar owners
const MIN_SOURCES_FOR_SKIP = 15; // items with >= this many sources skip discovery
const POOL_STALE_MS = 30 * 60 * 1000; // 30 min — re-check bazaars older than this

/**
 * Resolve watchlist item names to IDs using cached item catalog.
 */
function resolveWatchlistIds() {
  const cached = localStorage.getItem('valigia_item_id_map');
  if (!cached) return { resolved: [], unresolved: BAZAAR_WATCHLIST.slice() };

  let nameToId;
  try { nameToId = JSON.parse(cached); } catch { return { resolved: [], unresolved: BAZAAR_WATCHLIST.slice() }; }

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

/**
 * Phase 1: Read market prices from Supabase sell_prices cache.
 * Zero API calls — entirely from the shared cache that main page already populates.
 */
async function readMarketPrices(itemIds) {
  const { data, error } = await supabase
    .from('sell_prices')
    .select('item_id, price')
    .in('item_id', itemIds)
    .not('price', 'is', null);

  if (error || !data) return new Map();

  const map = new Map();
  for (const row of data) {
    map.set(row.item_id, row.price);
  }
  return map;
}

/**
 * Phase 1: Read known bazaar sources from Supabase pool.
 * Zero API calls — crowd-sourced from all users' previous scans.
 */
async function readBazaarPool(itemIds) {
  try {
    const { data, error } = await supabase
      .from('bazaar_prices')
      .select('item_id, bazaar_owner_id, price, quantity, checked_at')
      .in('item_id', itemIds);

    if (error || !data) return new Map();

    // Group by item_id
    const pool = new Map();
    for (const row of data) {
      if (!pool.has(row.item_id)) pool.set(row.item_id, []);
      pool.get(row.item_id).push(row);
    }
    return pool;
  } catch {
    // Table may not exist yet — proceed without pool data
    return new Map();
  }
}

/**
 * Phase 2: Discover new bazaar sources for items with few known sources.
 * Uses V2 market/{id}/bazaar to find bazaars that sell each item.
 */
async function discoverBazaars(items, pool, playerId, onProgress) {
  // Pick items with fewest known sources, randomized
  const candidates = items
    .map(item => ({ ...item, sourceCount: (pool.get(item.id) || []).length }))
    .filter(item => item.sourceCount < MIN_SOURCES_FOR_SKIP)
    .sort(() => Math.random() - 0.5)
    .slice(0, DISCOVER_BUDGET);

  const discovered = new Map(); // item_id → [bazaar_owner_ids]

  const promises = candidates.map(async (item) => {
    const data = await callTornApi({
      section: 'market',
      id: item.id,
      selections: 'bazaar',
      player_id: playerId,
      v2: true,
    });

    if (!data?.bazaar) return;

    // V2 bazaar returns { bazaar: { specialized: [...], ... } }
    const ids = [];
    for (const category of Object.values(data.bazaar)) {
      if (Array.isArray(category)) {
        for (const baz of category) {
          if (baz.id) ids.push(baz.id);
        }
      }
    }

    if (ids.length > 0) {
      discovered.set(item.id, ids);
    }
  });

  await Promise.allSettled(promises);
  return discovered;
}

/**
 * Phase 3: Check bazaar prices. Deduplicates by bazaar owner so each
 * bazaar is checked at most once — one API call returns ALL items.
 * Returns array of { item_id, bazaar_owner_id, price, quantity }.
 */
async function checkBazaars(items, pool, discovered, playerId, onProgress) {
  const now = Date.now();
  const results = [];
  const watchlistIds = new Set(items.map(i => i.id));

  // Build a map of unique bazaar owners → best staleness score.
  // Multiple items may point to the same bazaar — we only need to check it once.
  const bazaarMap = new Map(); // bazaarOwnerId → { staleness, isNew }

  for (const item of items) {
    const knownSources = pool.get(item.id) || [];
    const discoveredIds = discovered.get(item.id) || [];

    for (const src of knownSources) {
      const age = now - new Date(src.checked_at).getTime();
      const existing = bazaarMap.get(src.bazaar_owner_id);
      if (!existing || age > existing.staleness) {
        bazaarMap.set(src.bazaar_owner_id, { staleness: age, isNew: false });
      }
    }

    for (const bazId of discoveredIds) {
      const alreadyKnown = knownSources.some(s => s.bazaar_owner_id === bazId);
      if (!alreadyKnown) {
        const existing = bazaarMap.get(bazId);
        if (!existing || !existing.isNew) {
          bazaarMap.set(bazId, { staleness: Infinity, isNew: true });
        }
      }
    }
  }

  // Sort: new discoveries first, then stalest first
  const toCheck = [...bazaarMap.entries()]
    .map(([bazaarOwnerId, info]) => ({ bazaarOwnerId, ...info }))
    .sort((a, b) => b.staleness - a.staleness);

  // Take top N unique bazaars within budget
  const batch = toCheck.slice(0, CHECK_BUDGET);
  let checked = 0;
  const total = batch.length;

  const promises = batch.map(async (entry) => {
    const data = await callTornApi({
      section: 'user',
      id: entry.bazaarOwnerId,
      selections: 'bazaar',
      player_id: playerId,
    });

    checked++;
    if (onProgress) onProgress(checked, total);

    if (!data?.bazaar) return;

    // Harvest ALL watchlist items from this bazaar
    const bazaarItems = Array.isArray(data.bazaar)
      ? data.bazaar
      : Object.values(data.bazaar || {});

    for (const item of bazaarItems) {
      const itemId = item.ID || item.id;
      const price = item.cost || item.price || item.market_price;
      if (!itemId || !price) continue;

      if (watchlistIds.has(itemId)) {
        results.push({
          item_id: itemId,
          bazaar_owner_id: entry.bazaarOwnerId,
          price,
          quantity: item.quantity || 1,
        });
      }
    }
  });

  await Promise.allSettled(promises);
  results.apiCalls = batch.length;
  return results;
}

/**
 * Phase 4: Write discoveries back to the shared pool.
 */
async function writeBazaarPool(results) {
  if (results.length === 0) return;

  try {
    const rows = results.map(r => ({
      item_id: r.item_id,
      bazaar_owner_id: r.bazaar_owner_id,
      price: r.price,
      quantity: r.quantity,
      checked_at: new Date().toISOString(),
    }));

    await supabase
      .from('bazaar_prices')
      .upsert(rows, { onConflict: 'item_id,bazaar_owner_id' });
  } catch {
    // Pool write failed — non-fatal, scan results still valid
  }
}

/**
 * Collect all valid deals from LIVE-checked bazaar prices, pick one at random.
 * Pool data tells us where to look — only freshResults are real.
 * A price from a previous scan is almost certainly bought already.
 *
 * "Wheel of fortune" — you might get the best deal, or a surprise lesser one.
 */
function findRandomDeal(items, marketPrices, freshResults) {
  // Build map of lowest live-checked price per item
  const livePrices = new Map(); // item_id → { price, quantity, bazaarOwnerId }

  for (const r of freshResults) {
    if (r.price == null) continue;
    const current = livePrices.get(r.item_id);
    if (!current || r.price < current.price) {
      livePrices.set(r.item_id, {
        price: r.price,
        quantity: r.quantity || 1,
        bazaarOwnerId: r.bazaar_owner_id,
      });
    }
  }

  // Collect ALL valid deals from live prices
  const allDeals = [];

  for (const item of items) {
    const marketPrice = marketPrices.get(item.id);
    const bazaar = livePrices.get(item.id);

    if (!marketPrice || !bazaar) continue;

    const savings = marketPrice - bazaar.price;
    if (savings <= 0) continue;

    const savingsPct = (savings / marketPrice) * 100;

    // Skip "too good to be true" — locked/troll listings (e.g. $1 PCP)
    if (savingsPct > 90) continue;

    allDeals.push({
      itemId: item.id,
      itemName: item.name,
      bazaarPrice: bazaar.price,
      bazaarQty: bazaar.quantity,
      bazaarOwnerId: bazaar.bazaarOwnerId,
      marketPrice,
      savings,
      savingsPct,
    });
  }

  if (allDeals.length === 0) return { picked: null, allDeals: [] };

  // Weighted random — better deals are more likely to be picked.
  // Weight = savingsPct², so a 10% deal is 100× more likely than a 1% deal.
  const weights = allDeals.map(d => d.savingsPct * d.savingsPct);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let roll = Math.random() * totalWeight;
  let pickedIdx = allDeals.length - 1;
  for (let i = 0; i < allDeals.length; i++) {
    roll -= weights[i];
    if (roll <= 0) { pickedIdx = i; break; }
  }

  // Return picked deal + remaining deals as fallbacks for verification
  const picked = allDeals[pickedIdx];
  const fallbacks = [...allDeals.slice(0, pickedIdx), ...allDeals.slice(pickedIdx + 1)];
  // Sort fallbacks by savings % desc so best alternatives are tried first
  fallbacks.sort((a, b) => b.savingsPct - a.savingsPct);

  return { picked, allDeals, fallbacks };
}

/**
 * Main scanner entry point.
 * Returns { bestDeal, stats } — one deal or null.
 *
 * @param {number} playerId
 * @param {function} onProgress - (checked, total) progress callback
 */
export async function scanBazaarDeals(playerId, onProgress) {
  const { resolved: items, unresolved } = resolveWatchlistIds();

  const stats = {
    watchlistSize: BAZAAR_WATCHLIST.length,
    resolved: items.length,
    unresolved,
    poolHits: 0,
    marketHits: 0,
    discovered: 0,
    bazaarsChecked: 0,
    pricesFound: 0,
    apiCalls: 0,
  };

  if (items.length === 0) return { bestDeal: null, stats };

  const itemIds = items.map(i => i.id);

  // Phase 1: Read from Supabase (0 API calls)
  const [marketPrices, pool] = await Promise.all([
    readMarketPrices(itemIds),
    readBazaarPool(itemIds),
  ]);

  stats.marketHits = marketPrices.size;
  stats.poolHits = pool.size;

  // Count unique bazaar owners across the entire pool
  const uniqueBazaars = new Set();
  for (const sources of pool.values()) {
    for (const src of sources) uniqueBazaars.add(src.bazaar_owner_id);
  }
  stats.uniqueBazaars = uniqueBazaars.size;

  // Phase 2: Discover new bazaar sources (~5 API calls)
  const discovered = await discoverBazaars(items, pool, playerId);
  let totalDiscovered = 0;
  for (const ids of discovered.values()) totalDiscovered += ids.length;
  stats.discovered = totalDiscovered;
  stats.apiCalls += Math.min(DISCOVER_BUDGET, items.filter(i => (pool.get(i.id) || []).length < MIN_SOURCES_FOR_SKIP).length);

  // Phase 3: Check bazaars (~25 API calls)
  const freshResults = await checkBazaars(items, pool, discovered, playerId, onProgress);
  stats.bazaarsChecked = freshResults.apiCalls || 0;
  stats.pricesFound = freshResults.length;

  // Phase 4: Write back to shared pool (0 API calls)
  await writeBazaarPool(freshResults);

  // Pick a random deal from all live-checked deals — wheel of fortune
  const { picked, allDeals, fallbacks } = findRandomDeal(items, marketPrices, freshResults);
  stats.dealsFound = allDeals.length;

  // Phase 5: Verify — fetch FRESH market price for the chosen deal.
  // The cached sell_prices can be hours stale, leading to phantom deals.
  // If the deal evaporates, try fallbacks (up to 3 extra API calls).
  let bestDeal = null;
  const candidates = picked ? [picked, ...fallbacks] : [];
  const verifiedItems = new Map(); // itemId → freshPrice (avoid re-checking same item)
  const MAX_VERIFY = 4; // max verification API calls
  let verifyCount = 0;

  for (const candidate of candidates) {
    if (verifyCount >= MAX_VERIFY) break;
    if (verifiedItems.has(candidate.itemId)) {
      // Already verified this item's market price — reuse it
      const cached = verifiedItems.get(candidate.itemId);
      if (cached != null) {
        const savings = cached - candidate.bazaarPrice;
        const savingsPct = cached > 0 ? (savings / cached) * 100 : 0;
        if (savings > 0 && savingsPct <= 90) {
          bestDeal = { ...candidate, marketPrice: cached, savings, savingsPct };
          break;
        }
      }
      continue;
    }

    const freshMarket = await callTornApi({
      section: 'market',
      id: candidate.itemId,
      selections: 'itemmarket',
      player_id: playerId,
      v2: true,
    });
    verifyCount++;

    let freshPrice = null;
    if (freshMarket?.itemmarket) {
      const listings = freshMarket.itemmarket?.listings || freshMarket.itemmarket;
      if (Array.isArray(listings) && listings.length > 0) {
        freshPrice = listings[0].cost || listings[0].price;
      }
    }

    // Cache the verified price for this item
    verifiedItems.set(candidate.itemId, freshPrice);

    if (freshPrice != null) {
      // Update Supabase cache so main table benefits too
      try {
        await supabase.from('sell_prices').upsert(
          { item_id: candidate.itemId, price: freshPrice, updated_at: new Date().toISOString() },
          { onConflict: 'item_id' }
        );
      } catch { /* non-fatal */ }

      // Recalculate deal with verified price
      const savings = freshPrice - candidate.bazaarPrice;
      const savingsPct = freshPrice > 0 ? (savings / freshPrice) * 100 : 0;

      if (savings > 0 && savingsPct <= 90) {
        bestDeal = { ...candidate, marketPrice: freshPrice, savings, savingsPct };
        break;
      }
    }
  }
  stats.apiCalls += verifyCount;

  // Record this scan in community stats
  const { error: rpcErr } = await supabase.rpc('record_scan', { found_deal: bestDeal != null });
  if (rpcErr) stats.rpcError = rpcErr.message;

  return { bestDeal, stats };
}
