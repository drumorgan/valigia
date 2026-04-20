// Resolves null item IDs in ABROAD_ITEMS by fetching the Torn item catalog.
// Caches the name→id mapping in localStorage so this only costs one API call
// per browser (or until the cache is cleared).

import { callTornApi } from './torn-api.js';
import { ABROAD_ITEMS } from './data/abroad-items.js';
import { safeGetItem, safeSetItem, safeRemoveItem } from './storage.js';

const CACHE_KEY = 'valigia_item_id_map';
const TYPE_CACHE_KEY = 'valigia_item_type_map';

// In-memory id→type map, populated from cache or Torn API
let idToType = {};

/**
 * Check if any items still have null IDs.
 */
export function hasUnresolvedItems() {
  return ABROAD_ITEMS.some((item) => item.itemId == null);
}

/**
 * Get the Torn API item type for an item ID.
 * Returns lowercase category: 'drug', 'plushie', 'flower', 'artifact', or 'other'.
 */
export function getItemTypeById(id) {
  const raw = idToType[id];
  if (!raw) return 'other';
  const lower = raw.toLowerCase();
  if (lower === 'drug') return 'drug';
  if (lower === 'plushie') return 'plushie';
  if (lower === 'flower') return 'flower';
  if (lower === 'artifact') return 'artifact';
  return 'other';
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
  // Try cache first
  if (applyCache()) return;
  if (!hasUnresolvedItems()) return;

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
  for (const [idStr, item] of Object.entries(data.items)) {
    nameToId[item.name.toLowerCase()] = Number(idStr);
    if (item.type) newIdToType[idStr] = item.type;
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
  safeSetItem(CACHE_KEY, JSON.stringify(nameToId));
  safeSetItem(TYPE_CACHE_KEY, JSON.stringify(newIdToType));
}
