// Resolves null item IDs in ABROAD_ITEMS by fetching the Torn item catalog.
// Caches the name→id mapping in localStorage so this only costs one API call
// per browser (or until the cache is cleared).

import { callTornApi } from './torn-api.js';
import { ABROAD_ITEMS } from './data/abroad-items.js';

const CACHE_KEY = 'valigia_item_id_map';

/**
 * Check if any items still have null IDs.
 */
export function hasUnresolvedItems() {
  return ABROAD_ITEMS.some((item) => item.itemId == null);
}

/**
 * Try to fill null itemIds from localStorage cache.
 * Returns true if all items are now resolved.
 */
function applyCache() {
  const cached = localStorage.getItem(CACHE_KEY);
  if (!cached) return false;

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
    localStorage.removeItem(CACHE_KEY);
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

  // Build name→id map from Torn's response
  // Response shape: { items: { "1": { name: "Hammer", ... }, "2": { ... } } }
  const nameToId = {};
  for (const [idStr, item] of Object.entries(data.items)) {
    nameToId[item.name.toLowerCase()] = Number(idStr);
  }

  // Apply to ABROAD_ITEMS
  for (const item of ABROAD_ITEMS) {
    if (item.itemId == null) {
      const id = nameToId[item.name.toLowerCase()];
      if (id) item.itemId = id;
    }
  }

  // Cache for future visits
  localStorage.setItem(CACHE_KEY, JSON.stringify(nameToId));
}
