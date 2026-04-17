// Bazaar deal scanner — crowd-sourced "super database" of bazaar prices.
//
// Strategy: every scan contributes to a shared Supabase pool. Over time the
// system learns which bazaars carry which items and at what prices.
//
// Watchlist: static curated list + dynamic high-value items from sell_prices
// (anything above DYNAMIC_WATCHLIST_MIN_PRICE auto-joins).
//
// Per-scan flow (budget: ~30 API calls):
//   Phase 1 — FREE (Supabase reads, 0 API calls)
//     • Read market prices from sell_prices cache
//     • Read known bazaar sources from bazaar_prices pool
//   Phase 2 — DISCOVER (~8 API calls)
//     • Rank items by (marketPrice / (sourceCount + 1)) with jitter
//     • V2 market/{id}/bazaar → discover new bazaar IDs
//   Phase 3 — CHECK (~25 API calls)
//     • Check bazaars, prioritizing least-recently-checked
//     • V1 user/{bazaarId}/bazaar → actual prices
//   Phase 4 — WRITE BACK (Supabase upsert, 0 API calls)
//     • Hits reset miss_count; misses ++ it; MAX_MISS_COUNT → prune
//
// prescanBazaarPool() runs a tiny fire-and-forget variant on page load.

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';
import { ingestSellPrices, ingestBazaarPrices } from './ingest.js';
import { BAZAAR_WATCHLIST } from './data/bazaar-watchlist.js';

const DISCOVER_BUDGET = 8;    // API calls for discovering new bazaar sources
const CHECK_BUDGET = 25;      // API calls for checking unique bazaar owners
const MIN_SOURCES_FOR_SKIP = 15; // items with >= this many sources skip discovery
const POOL_STALE_MS = 30 * 60 * 1000; // 30 min — re-check bazaars older than this
const MAX_MISS_COUNT = 3;     // after this many consecutive misses, prune the entry
const PRESCAN_CHECK_BUDGET = 8; // quiet background scan: just a handful of stale refreshes
const DYNAMIC_WATCHLIST_MIN_PRICE = 50000;  // items above this sell price auto-join the watchlist
const DYNAMIC_WATCHLIST_CAP = 150;          // max extra items pulled from sell_prices

// Best-run bazaar candidate tunables
const BEST_RUN_FRESH_MS = 10 * 60 * 1000;  // only consider bazaar entries checked in the last 10 min
const BEST_RUN_MAX_VERIFY = 3;             // max fresh market-price verifications per dashboard load
const BEST_RUN_MAX_SAVINGS_PCT = 90;       // skip "too good to be true" deals (locked/troll listings)
const BEST_RUN_MIN_SAVINGS = 10000;        // don't bother surfacing sub-$10K absolute-savings deals

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
 * Extend the static watchlist with high-value items from sell_prices.
 * Any item cached with a sell price >= DYNAMIC_WATCHLIST_MIN_PRICE becomes
 * a bazaar deal candidate, even if nobody curated it into the static list.
 * Item names come from the local item catalog so we can display them.
 */
async function buildDynamicWatchlist(staticItemIds) {
  try {
    const { data, error } = await supabase
      .from('sell_prices')
      .select('item_id, price')
      .gte('price', DYNAMIC_WATCHLIST_MIN_PRICE)
      .order('price', { ascending: false })
      .limit(DYNAMIC_WATCHLIST_CAP);

    if (error || !data) return [];

    const cached = localStorage.getItem('valigia_item_id_map');
    let idToName = {};
    if (cached) {
      try {
        const nameToId = JSON.parse(cached);
        for (const [name, id] of Object.entries(nameToId)) idToName[id] = name;
      } catch { /* fall through */ }
    }

    const extras = [];
    for (const row of data) {
      if (staticItemIds.has(row.item_id)) continue; // already in static list
      extras.push({
        name: idToName[row.item_id] || `Item ${row.item_id}`,
        id: row.item_id,
      });
    }
    return extras;
  } catch {
    return [];
  }
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
      .select('item_id, bazaar_owner_id, price, quantity, checked_at, miss_count')
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
 * Writes ALL discovered (item, bazaar_owner) pairs to the pool immediately
 * so they persist even if not checked this spin.
 *
 * Candidates are ranked by `marketPrice / (sourceCount + 1)` so high-value
 * items with few known sources are prioritized. An expensive Xanax source is
 * far more valuable to discover than another Dahlia source.
 *
 * Returns Map(item_id → [owner_ids])
 */
async function discoverBazaars(items, pool, marketPrices, playerId, onProgress) {
  // Rank items by value density: high-value + low-source-count first.
  // A small jitter (±15%) keeps the discovery from getting stuck on the
  // same handful of items every scan.
  const candidates = items
    .map(item => {
      const sourceCount = (pool.get(item.id) || []).length;
      const marketPrice = marketPrices.get(item.id) || 1000; // assume low value if unknown
      const jitter = 0.85 + Math.random() * 0.3;
      const score = (marketPrice / (sourceCount + 1)) * jitter;
      return { ...item, sourceCount, score };
    })
    .filter(item => item.sourceCount < MIN_SOURCES_FOR_SKIP)
    .sort((a, b) => b.score - a.score)
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

    // V2 bazaar returns { bazaar: { category: [...], ... } }
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

  // Write ALL discovered pairs to the pool immediately (price=null marks
  // them as "known but unchecked"). This way they persist across spins
  // even if we can't check them all this time.
  const seedRows = [];
  for (const [itemId, ownerIds] of discovered) {
    for (const ownerId of ownerIds) {
      // Only seed if not already in pool
      const existing = pool.get(itemId) || [];
      if (!existing.some(s => s.bazaar_owner_id === ownerId)) {
        seedRows.push({
          item_id: itemId,
          bazaar_owner_id: ownerId,
          price: null,
          quantity: null,
          checked_at: new Date(0).toISOString(), // epoch = never checked = max staleness
        });
      }
    }
  }
  if (seedRows.length > 0) {
    // Seed newly-discovered pairs with epoch checked_at so they sort to the
    // top of the staleness rotation and get checked next scan. Via ingest
    // edge function (Layer 2 — observer-attributed). Non-fatal on error.
    try {
      await ingestBazaarPrices(seedRows.map(r => ({
        item_id: r.item_id,
        bazaar_owner_id: r.bazaar_owner_id,
        price: null,
        quantity: null,
        miss_count: 0,
        checked_at: r.checked_at,
      })));
    } catch { /* non-fatal */ }
  }

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
  // Also track which (item_id, owner_id) pairs we *expected* to find from the
  // pool, so we can increment miss_count on pairs that didn't turn up.
  const bazaarMap = new Map(); // bazaarOwnerId → { staleness, isNew }
  const expectedPairs = []; // [{ item_id, bazaar_owner_id, miss_count }]

  for (const item of items) {
    const knownSources = pool.get(item.id) || [];
    const discoveredIds = discovered.get(item.id) || [];

    for (const src of knownSources) {
      const age = now - new Date(src.checked_at).getTime();
      const existing = bazaarMap.get(src.bazaar_owner_id);
      if (!existing || age > existing.staleness) {
        bazaarMap.set(src.bazaar_owner_id, { staleness: age, isNew: false });
      }
      // Only pairs with a previously-known price are "expected" — null-priced
      // seeds are speculative and missing them doesn't count against the pair.
      if (src.price != null) {
        expectedPairs.push({
          item_id: item.id,
          bazaar_owner_id: src.bazaar_owner_id,
          miss_count: src.miss_count || 0,
        });
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
  const checkedOwnerIds = new Set(batch.map(e => e.bazaarOwnerId));
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
  results.expectedPairs = expectedPairs;
  results.checkedOwnerIds = checkedOwnerIds;
  return results;
}

/**
 * Phase 4: Write discoveries back to the shared pool, increment miss_count
 * for expected-but-missing pairs, and delete pairs that crossed the threshold.
 *
 * Returns { hits, misses, pruned } counts for stats reporting.
 */
async function writeBazaarPool(results) {
  const now = new Date().toISOString();
  const hits = results.length;
  const expectedPairs = results.expectedPairs || [];
  const checkedOwnerIds = results.checkedOwnerIds || new Set();
  let pruned = 0;
  let misses = 0;

  // Build a set of (item_id, bazaar_owner_id) pairs that were found this scan.
  const foundKeys = new Set(
    results.map(r => `${r.item_id}:${r.bazaar_owner_id}`)
  );

  // Work out which expected pairs were checked-but-missing (miss) vs just
  // not-checked-this-scan (leave alone).
  const toIncrement = []; // pairs to ++miss_count
  const toPrune = [];     // pairs to delete (threshold exceeded)

  for (const pair of expectedPairs) {
    if (!checkedOwnerIds.has(pair.bazaar_owner_id)) continue; // not checked
    const key = `${pair.item_id}:${pair.bazaar_owner_id}`;
    if (foundKeys.has(key)) continue; // found — will be upserted as hit

    if (pair.miss_count + 1 >= MAX_MISS_COUNT) {
      toPrune.push(pair);
    } else {
      toIncrement.push(pair);
    }
  }
  misses = toIncrement.length + toPrune.length;
  pruned = toPrune.length;

  try {
    // Upsert hits: fresh price + quantity, reset miss_count to 0.
    // Writes go through the ingest-bazaar-prices edge function (Layer 2 —
    // observer-attributed). checked_at is stamped server-side.
    if (hits > 0) {
      const rows = results.map(r => ({
        item_id: r.item_id,
        bazaar_owner_id: r.bazaar_owner_id,
        price: r.price,
        quantity: r.quantity,
        miss_count: 0,
      }));
      await ingestBazaarPrices(rows);
    }

    // Increment miss_count for expected-but-missing pairs (still under threshold).
    // Upsert with a computed miss_count (read value + 1). Price cleared to null
    // so stale prices from weeks ago don't mislead the next deal pick.
    if (toIncrement.length > 0) {
      const rows = toIncrement.map(p => ({
        item_id: p.item_id,
        bazaar_owner_id: p.bazaar_owner_id,
        price: null,
        quantity: null,
        miss_count: p.miss_count + 1,
      }));
      await ingestBazaarPrices(rows);
    }

    // Prune pairs that have now missed MAX_MISS_COUNT times in a row.
    if (toPrune.length > 0) {
      // Supabase client can't match composite keys in one .delete(); delete
      // per-pair. Pool pruning is infrequent so the extra round-trips are fine.
      await Promise.allSettled(toPrune.map(p =>
        supabase
          .from('bazaar_prices')
          .delete()
          .eq('item_id', p.item_id)
          .eq('bazaar_owner_id', p.bazaar_owner_id)
      ));
    }
  } catch {
    // Pool write failed — non-fatal, scan results still valid
  }

  return { hits, misses, pruned };
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
  // Weight = absolute savings × savings %, so a $100K/5% deal beats a
  // $750/15% deal. Both axes matter: pure-percentage weighting over-rewards
  // tiny-ticket deals, pure-dollar weighting ignores how "good" a find is.
  const weights = allDeals.map(d => Math.max(1, d.savings) * d.savingsPct);
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
  const { resolved: staticItems, unresolved } = resolveWatchlistIds();

  // Extend the static watchlist with any cached sell_prices entry above
  // DYNAMIC_WATCHLIST_MIN_PRICE. This lets the scanner follow market trends
  // automatically — any high-value item a user looked up becomes a deal
  // candidate for everyone.
  const staticIds = new Set(staticItems.map(i => i.id));
  const dynamicItems = await buildDynamicWatchlist(staticIds);
  const items = [...staticItems, ...dynamicItems];

  const stats = {
    watchlistSize: BAZAAR_WATCHLIST.length,
    resolved: staticItems.length,
    dynamicItems: dynamicItems.length,
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

  // Phase 2: Discover new bazaar sources (~8 API calls)
  // Discovered pairs are written to pool immediately with null prices
  // so they persist across spins even if not checked this time.
  const discovered = await discoverBazaars(items, pool, marketPrices, playerId);
  // Count unique NEW bazaar owners (not already in pool)
  const newBazaarOwners = new Set();
  for (const ids of discovered.values()) {
    for (const id of ids) newBazaarOwners.add(id);
  }
  // Subtract already-known owners
  for (const id of newBazaarOwners) {
    if (uniqueBazaars.has(id)) newBazaarOwners.delete(id);
  }
  stats.discovered = newBazaarOwners.size;
  stats.apiCalls += Math.min(DISCOVER_BUDGET, items.filter(i => (pool.get(i.id) || []).length < MIN_SOURCES_FOR_SKIP).length);

  // Phase 3: Check bazaars (~25 API calls)
  const freshResults = await checkBazaars(items, pool, discovered, playerId, onProgress);
  stats.bazaarsChecked = freshResults.apiCalls || 0;
  stats.pricesFound = freshResults.length;

  // Phase 4: Write checked prices back to shared pool (0 API calls).
  // Also increments miss_count for expected-but-missing pairs and prunes
  // pairs that have crossed MAX_MISS_COUNT consecutive misses.
  const writeStats = await writeBazaarPool(freshResults);
  stats.poolMisses = writeStats.misses;
  stats.poolPruned = writeStats.pruned;

  // Pick a random deal from all live-checked deals — wheel of fortune.
  // We also surface the full ranked deal list so users who want the whole
  // picture can see every bargain found this scan, not just the spin pick.
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
      // Update Supabase cache so main table benefits too — via ingest
      // edge function (Layer 2 — observer-attributed). Non-fatal on error.
      try {
        await ingestSellPrices([{ item_id: candidate.itemId, price: freshPrice }]);
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

  // Return a de-duplicated, absolute-savings-sorted list of *all* deals found
  // this scan so the UI can show the full set as runners-up.
  const sortedDeals = [...allDeals].sort((a, b) => b.savings - a.savings);

  return { bestDeal, allDeals: sortedDeals, stats };
}

/**
 * Background pre-scan — silently refresh the stalest entries in the bazaar
 * pool so when the user clicks "Spin for a Deal" the pool is already warm.
 *
 * Only runs Phase 1 (pool read) + Phase 3 (check a tiny batch) + Phase 4
 * (write back). No discovery, no deal picking, no verification. Returns
 * quickly; callers should fire-and-forget.
 *
 * @param {number} playerId
 * @returns {Promise<{ refreshed: number }>}
 */
export async function prescanBazaarPool(playerId) {
  try {
    const { resolved: staticItems } = resolveWatchlistIds();
    const staticIds = new Set(staticItems.map(i => i.id));
    const dynamicItems = await buildDynamicWatchlist(staticIds);
    const items = [...staticItems, ...dynamicItems];
    if (items.length === 0) return { refreshed: 0 };

    const itemIds = items.map(i => i.id);
    const pool = await readBazaarPool(itemIds);
    if (pool.size === 0) return { refreshed: 0 };

    // Build list of checkable bazaar owners, staleness-ranked.
    const now = Date.now();
    const bazaarMap = new Map();
    for (const item of items) {
      const sources = pool.get(item.id) || [];
      for (const src of sources) {
        const age = now - new Date(src.checked_at).getTime();
        const existing = bazaarMap.get(src.bazaar_owner_id);
        if (!existing || age > existing.staleness) {
          bazaarMap.set(src.bazaar_owner_id, { staleness: age });
        }
      }
    }

    // Only check entries that are actually stale — otherwise this pre-scan
    // would burn fresh-API calls on already-current data.
    const toCheck = [...bazaarMap.entries()]
      .filter(([, info]) => info.staleness >= POOL_STALE_MS)
      .sort((a, b) => b[1].staleness - a[1].staleness)
      .slice(0, PRESCAN_CHECK_BUDGET);

    if (toCheck.length === 0) return { refreshed: 0 };

    const watchlistIds = new Set(itemIds);
    const results = [];
    const checkedOwnerIds = new Set();
    const expectedPairs = [];
    for (const item of items) {
      for (const src of (pool.get(item.id) || [])) {
        if (src.price != null) {
          expectedPairs.push({
            item_id: item.id,
            bazaar_owner_id: src.bazaar_owner_id,
            miss_count: src.miss_count || 0,
          });
        }
      }
    }

    await Promise.allSettled(toCheck.map(async ([bazaarOwnerId]) => {
      checkedOwnerIds.add(bazaarOwnerId);
      const data = await callTornApi({
        section: 'user',
        id: bazaarOwnerId,
        selections: 'bazaar',
        player_id: playerId,
      });
      if (!data?.bazaar) return;

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
            bazaar_owner_id: bazaarOwnerId,
            price,
            quantity: item.quantity || 1,
          });
        }
      }
    }));

    results.expectedPairs = expectedPairs;
    results.checkedOwnerIds = checkedOwnerIds;
    await writeBazaarPool(results);

    return { refreshed: toCheck.length };
  } catch {
    return { refreshed: 0 };
  }
}

/**
 * Find the single best currently-actionable bazaar deal, verified with a
 * fresh market-price check. Designed to feed the "Best Run Right Now"
 * summary card: this is the one bazaar listing worth acting on right now.
 *
 * Returns null if nothing in the pool is fresh enough, or if every
 * candidate evaporates on verification. Up to BEST_RUN_MAX_VERIFY Torn API
 * calls (one per candidate).
 *
 * Why this is trustworthy:
 *  - Only considers pool entries checked within BEST_RUN_FRESH_MS (10 min).
 *    Recently-refreshed entries come from this page load's prescan or from
 *    a recent user spin — they reflect the current state of the bazaar.
 *  - Re-fetches the market price at verification time so the savings math
 *    doesn't rely on a stale sell_prices row.
 *  - Skips deals with savings% > 90 (locked/troll listings).
 *
 * @param {number} playerId
 * @returns {Promise<object|null>} verified deal or null
 *   { itemId, itemName, bazaarPrice, bazaarQty, bazaarOwnerId,
 *     marketPrice, savings, savingsPct, verifiedAt }
 */
export async function findBestBazaarRun(playerId) {
  try {
    const freshSince = new Date(Date.now() - BEST_RUN_FRESH_MS).toISOString();

    // Read only fresh, priced pool entries. No point considering stale
    // entries for a "right now" recommendation.
    const { data: poolRows, error: poolErr } = await supabase
      .from('bazaar_prices')
      .select('item_id, bazaar_owner_id, price, quantity, checked_at')
      .not('price', 'is', null)
      .gte('checked_at', freshSince);

    if (poolErr || !poolRows || poolRows.length === 0) return null;

    // Pull market prices for the same items from sell_prices cache.
    const itemIds = [...new Set(poolRows.map(r => r.item_id))];
    const { data: marketRows } = await supabase
      .from('sell_prices')
      .select('item_id, price')
      .in('item_id', itemIds)
      .not('price', 'is', null);

    if (!marketRows || marketRows.length === 0) return null;

    const marketPrices = new Map();
    for (const row of marketRows) marketPrices.set(row.item_id, row.price);

    // Resolve item IDs back to names for display.
    const cached = localStorage.getItem('valigia_item_id_map');
    const idToName = {};
    if (cached) {
      try {
        const nameToId = JSON.parse(cached);
        for (const [name, id] of Object.entries(nameToId)) idToName[id] = name;
      } catch { /* fall through */ }
    }

    // Keep the cheapest listing per item (one best deal per item is enough).
    const bestPerItem = new Map();
    for (const row of poolRows) {
      const existing = bestPerItem.get(row.item_id);
      if (!existing || row.price < existing.price) {
        bestPerItem.set(row.item_id, row);
      }
    }

    // Compute savings for each item and sort by absolute savings desc.
    const candidates = [];
    for (const [itemId, row] of bestPerItem) {
      const marketPrice = marketPrices.get(itemId);
      if (!marketPrice) continue;
      const netSell = marketPrice * 0.95; // 5% item market fee
      const savingsPerUnit = netSell - row.price;
      if (savingsPerUnit <= 0) continue;
      const savingsPct = (savingsPerUnit / marketPrice) * 100;
      if (savingsPct > BEST_RUN_MAX_SAVINGS_PCT) continue;
      const absoluteSavings = savingsPerUnit * (row.quantity || 1);
      if (absoluteSavings < BEST_RUN_MIN_SAVINGS) continue;

      candidates.push({
        itemId,
        itemName: idToName[itemId] || `Item ${itemId}`,
        bazaarPrice: row.price,
        bazaarQty: row.quantity || 1,
        bazaarOwnerId: row.bazaar_owner_id,
        marketPrice, // cached — will be replaced by fresh value on verify
        savingsPerUnit,
        absoluteSavings,
      });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.absoluteSavings - a.absoluteSavings);

    // Verify top candidates with a fresh market-price fetch. First one that
    // still holds up wins. Budget is capped so a bad pool doesn't burn many
    // API calls.
    const batch = candidates.slice(0, BEST_RUN_MAX_VERIFY);
    for (const c of batch) {
      const freshMarket = await callTornApi({
        section: 'market',
        id: c.itemId,
        selections: 'itemmarket',
        player_id: playerId,
        v2: true,
      });
      if (!freshMarket?.itemmarket) continue;

      const listings = freshMarket.itemmarket?.listings || freshMarket.itemmarket;
      const freshPrice = Array.isArray(listings) && listings.length > 0
        ? (listings[0].cost || listings[0].price)
        : null;
      if (!freshPrice) continue;

      // Write fresh price back — benefits the travel table too. Via ingest
      // edge function (Layer 2 — observer-attributed). Non-fatal on error.
      try {
        await ingestSellPrices([{ item_id: c.itemId, price: freshPrice }]);
      } catch { /* non-fatal */ }

      const netSell = freshPrice * 0.95;
      const savings = netSell - c.bazaarPrice;
      const savingsPct = freshPrice > 0 ? (savings / freshPrice) * 100 : 0;
      if (savings <= 0) continue;
      if (savingsPct > BEST_RUN_MAX_SAVINGS_PCT) continue;

      return {
        itemId: c.itemId,
        itemName: c.itemName,
        bazaarPrice: c.bazaarPrice,
        bazaarQty: c.bazaarQty,
        bazaarOwnerId: c.bazaarOwnerId,
        marketPrice: freshPrice,
        savings,       // per-unit savings AFTER 5% market fee
        savingsPct,
        verifiedAt: Date.now(),
      };
    }

    return null;
  } catch {
    return null;
  }
}
