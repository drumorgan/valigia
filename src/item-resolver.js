// Resolves null item IDs in ABROAD_ITEMS by fetching the Torn item catalog.
// Caches the name→id mapping in localStorage so this only costs one API call
// per browser (or until the cache is cleared).

import { callTornApi } from './torn-api.js';
import { ABROAD_ITEMS } from './data/abroad-items.js';
import { safeGetItem, safeSetItem, safeRemoveItem } from './storage.js';
import { isContrabandName } from './data/sell-venues.js';

const CACHE_KEY = 'valigia_item_id_map';
const TYPE_CACHE_KEY = 'valigia_item_type_map';
// NPC-shop sell prices (`sell_price` from the catalog) — the cash a city
// store pays for an item. Separate, versioned key so browsers that cached
// the id/type maps before this existed re-fetch the catalog exactly once.
const STORE_SELL_CACHE_KEY = 'valigia_item_store_sell_v1';
// Store prices are fixed by Torn but new items (Contraband) get added, so
// re-pull the catalog weekly.
const STORE_SELL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// In-memory id→type map, populated from cache or Torn API
let idToType = {};
// In-memory id→store sell price map
let idToStoreSell = {};
// Lazy reverse of the cached name→id map, for name-based classification.
let idToName = null;

// Torn catalog types that come from the abroad Arms Dealer.
const ARMS_TYPES = new Set(['melee', 'primary', 'secondary', 'defensive', 'temporary']);

/**
 * Check if any items still have null IDs.
 */
export function hasUnresolvedItems() {
  return ABROAD_ITEMS.some((item) => item.itemId == null);
}

function nameForId(id) {
  if (!idToName) {
    idToName = {};
    const cached = safeGetItem(CACHE_KEY);
    if (cached) {
      try {
        for (const [name, iid] of Object.entries(JSON.parse(cached))) idToName[iid] = name;
      } catch { /* ignore */ }
    }
  }
  return idToName[id] || null;
}

/**
 * Get the Torn API item type for an item ID.
 * Returns lowercase category: 'drug', 'plushie', 'flower', 'artifact',
 * 'contraband', 'arms', or 'other'.
 *
 * Contraband is matched by catalog type (anything containing
 * "contraband") OR by the known item names, since we can't confirm how
 * Torn's catalog labels the category. Name wins over type so a contraband
 * item Torn files under e.g. "Other" still lands in the Contraband chip.
 */
export function getItemTypeById(id, name = null) {
  if (isContrabandName(name || nameForId(id))) return 'contraband';
  const raw = idToType[id];
  if (!raw) return 'other';
  const lower = raw.toLowerCase();
  if (lower.includes('contraband')) return 'contraband';
  if (ARMS_TYPES.has(lower)) return 'arms';
  if (lower === 'drug') return 'drug';
  if (lower === 'plushie') return 'plushie';
  if (lower === 'flower') return 'flower';
  if (lower === 'artifact') return 'artifact';
  return 'other';
}

/**
 * Fixed cash price a Torn city store pays for this item, or null when the
 * catalog has no (or a zero) sell price.
 */
export function getStoreSellPrice(id) {
  const v = Number(idToStoreSell[id]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Load the store-price cache. Returns true when it's present and fresh.
 */
function applyStoreSellCache() {
  const cached = safeGetItem(STORE_SELL_CACHE_KEY);
  if (!cached) return false;
  try {
    const { fetchedAt, prices } = JSON.parse(cached);
    idToStoreSell = prices || {};
    return Date.now() - fetchedAt < STORE_SELL_TTL_MS;
  } catch {
    safeRemoveItem(STORE_SELL_CACHE_KEY);
    return false;
  }
}

/**
 * Resolve a curated abroad item's display name from its id. Used by the
 * snapshot fallback in log-sync, where yata_snapshots stores ids only (no
 * name column). Returns null for ids outside the curated ABROAD_ITEMS list,
 * so the caller can apply its own "Item N" placeholder.
 */
export function getItemNameById(id) {
  for (const item of ABROAD_ITEMS) {
    if (item.itemId === id) return item.name;
  }
  return null;
}

/**
 * Try to fill null itemIds from localStorage cache.
 * Returns true if all items are now resolved.
 */
function applyCache() {
  const cached = safeGetItem(CACHE_KEY);
  if (!cached) return false;

  // Also load type cache
  const typeCached = safeGetItem(TYPE_CACHE_KEY);
  if (typeCached) {
    try { idToType = JSON.parse(typeCached); } catch { /* ignore */ }
  }

  try {
    const nameToId = JSON.parse(cached);
    for (const item of ABROAD_ITEMS) {
      if (item.itemId == null) {
        const id = nameToId[item.name.toLowerCase()];
        if (id) item.itemId = id;
      }
    }
    return !hasUnresolvedItems();
  } catch {
    safeRemoveItem(CACHE_KEY);
    return false;
  }
}

/**
 * Fetch the full Torn item catalog and fill null IDs.
 * Caches the mapping in localStorage for future visits.
 * @param {number} playerId - for server-side key decrypt
 */
export async function resolveItemIds(playerId) {
  // Try cache first. Both the id map AND the store-price map must be warm;
  // a stale/missing store map (every browser that predates it) costs one
  // catalog fetch, after which it rides the cache for a week.
  const idsResolved = applyCache();
  const storeFresh = applyStoreSellCache();
  if (idsResolved && storeFresh) return;

  // Fetch full item catalog from Torn API
  const data = await callTornApi({
    section: 'torn',
    selections: 'items',
    player_id: playerId,
  });

  if (!data?.items) return;

  // Build name→id and id→type maps from Torn's response
  // Response shape: { items: { "1": { name: "Hammer", type: "Melee", ... }, ... } }
  const nameToId = {};
  const newIdToType = {};
  const newStoreSell = {};
  for (const [idStr, item] of Object.entries(data.items)) {
    nameToId[item.name.toLowerCase()] = Number(idStr);
    if (item.type) newIdToType[idStr] = item.type;
    if (Number(item.sell_price) > 0) newStoreSell[idStr] = Number(item.sell_price);
  }

  // Apply to ABROAD_ITEMS
  for (const item of ABROAD_ITEMS) {
    if (item.itemId == null) {
      const id = nameToId[item.name.toLowerCase()];
      if (id) item.itemId = id;
    }
  }

  // Update in-memory type map and cache both
  idToType = newIdToType;
  idToStoreSell = newStoreSell;
  idToName = null;
  safeSetItem(CACHE_KEY, JSON.stringify(nameToId));
  safeSetItem(TYPE_CACHE_KEY, JSON.stringify(newIdToType));
  safeSetItem(STORE_SELL_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), prices: newStoreSell }));
}
