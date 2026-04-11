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

const DISCOVER_BUDGET = 5;    // API calls for discovering new bazaar sources
const CHECK_BUDGET = 25;      // API calls for checking bazaar prices
const MIN_SOURCES_FOR_SKIP = 5; // items with >= this many sources skip discovery
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
 * Phase 3: Check bazaar prices. Prioritizes least-recently-checked.
 * Returns array of { item_id, bazaar_owner_id, price, quantity }.
 */
async function checkBazaars(items, pool, discovered, playerId, onProgress) {
  const now = Date.now();
  const results = [];

  // Build a unified list of (item_id, bazaar_owner_id, staleness) to check
  const toCheck = [];

  for (const item of items) {
    const knownSources = pool.get(item.id) || [];
    const discoveredIds = discovered.get(item.id) || [];

    // Add known sources, prioritizing stale ones
    for (const src of knownSources) {
      const age = now - new Date(src.checked_at).getTime();
      toCheck.push({
        itemId: item.id,
        bazaarOwnerId: src.bazaar_owner_id,
        staleness: age,
        isNew: false,
      });
    }

    // Add newly discovered sources (highest priority — never checked)
    for (const bazId of discoveredIds) {
      // Skip if already in known sources
      const alreadyKnown = knownSources.some(s => s.bazaar_owner_id === bazId);
      if (!alreadyKnown) {
        toCheck.push({
          itemId: item.id,
          bazaarOwnerId: bazId,
          staleness: Infinity, // never checked = max priority
          isNew: true,
        });
      }
    }
  }

  // Sort: new discoveries first, then stalest first
  toCheck.sort((a, b) => b.staleness - a.staleness);

  // Take top N within budget
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

    // Search for our item in this bazaar's inventory
    const bazaarItems = Array.isArray(data.bazaar)
      ? data.bazaar
      : Object.values(data.bazaar || {});

    for (const item of bazaarItems) {
      const itemId = item.ID || item.id;
      const price = item.cost || item.price || item.market_price;
      if (!itemId || !price) continue;

      // Record this item if it's on our watchlist
      const watchlistIds = new Set(items.map(i => i.id));
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
 * Find the single best deal from LIVE-checked bazaar prices only.
 * Pool data tells us where to look — only freshResults are real.
 * A price from a previous scan is almost certainly bought already.
 */
function findBestDeal(items, marketPrices, freshResults) {
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

  // Find best deal from live prices only
  let bestDeal = null;

  for (const item of items) {
    const marketPrice = marketPrices.get(item.id);
    const bazaar = livePrices.get(item.id);

    if (!marketPrice || !bazaar) continue;

    const savings = marketPrice - bazaar.price;
    if (savings <= 0) continue;

    const savingsPct = (savings / marketPrice) * 100;

    // Skip "too good to be true" — locked/troll listings (e.g. $1 PCP)
    if (savingsPct > 90) continue;

    const deal = {
      itemId: item.id,
      itemName: item.name,
      bazaarPrice: bazaar.price,
      bazaarQty: bazaar.quantity,
      bazaarOwnerId: bazaar.bazaarOwnerId,
      marketPrice,
      savings,
      savingsPct,
    };

    if (!bestDeal || deal.savingsPct > bestDeal.savingsPct) {
      bestDeal = deal;
    }
  }

  return bestDeal;
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

  // Find the single best deal — only from live-checked prices
  const bestDeal = findBestDeal(items, marketPrices, freshResults);

  // Record this scan in community stats
  const { error: rpcErr } = await supabase.rpc('record_scan', { found_deal: bestDeal != null });
  if (rpcErr) stats.rpcError = rpcErr.message;

  return { bestDeal, stats };
}
