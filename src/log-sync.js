// Silent background sync — fetches abroad purchase logs (type 6501)
// and upserts crowd-sourced buy prices into Supabase.
// Auto-discovers ANY item from purchase logs — not limited to the static list.

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';
import { showToast } from './ui.js';

// Regex to extract country from log title: "Bought a Xanax from South Africa"
const COUNTRY_REGEX = /from (.+)$/i;

// Item ID cache key (shared with item-resolver.js)
const CACHE_KEY = 'valigia_item_id_map';

/**
 * Look up item ID from the cached Torn item catalog.
 * Returns the numeric ID or null if not found.
 */
function lookupItemId(itemName) {
  const cached = localStorage.getItem(CACHE_KEY);
  if (!cached) return null;
  try {
    const nameToId = JSON.parse(cached);
    return nameToId[itemName.toLowerCase()] || null;
  } catch {
    return null;
  }
}

/**
 * Fetch recent abroad purchase logs and upsert prices to Supabase.
 * Captures ANY abroad purchase — auto-discovers new items and destinations.
 * @param {number} playerId - Torn player ID (for server-side key decrypt)
 */
export async function syncAbroadPrices(playerId) {
  const from = Math.floor((Date.now() - 86400000) / 1000); // 24h ago

  const data = await callTornApi({
    section: 'user',
    selections: 'log',
    player_id: playerId,
    log: 6501,
    from,
  });

  if (!data) {
    showToast('Log sync: no API response', 'error');
    return;
  }

  if (!data.log) {
    // Debug: show what keys we got back
    showToast(`Log sync: no "log" key. Keys: ${Object.keys(data).join(', ')}`, 'error');
    return;
  }

  const entries = Object.values(data.log);
  if (entries.length === 0) return;

  // Debug: show what we found
  const firstEntry = entries[0];
  const cacheExists = !!localStorage.getItem(CACHE_KEY);
  showToast(`Log: ${entries.length} entries, cache: ${cacheExists}, sample: ${firstEntry?.data?.item || 'no item'}`, 'success');

  const upserts = [];

  for (const entry of entries) {
    if (entry.log !== 6501) continue;

    const { item: itemName, cost: unitPrice } = entry.data || {};
    if (!itemName || !unitPrice) continue;

    // Extract country from title
    const countryMatch = entry.title?.match(COUNTRY_REGEX);
    if (!countryMatch) continue;
    const destination = countryMatch[1];

    // Look up item ID from cached Torn catalog
    const itemId = lookupItemId(itemName);
    if (!itemId) continue; // Can't upsert without an ID

    upserts.push({
      item_name: itemName,
      item_id: itemId,
      destination,
      buy_price: unitPrice,
      reported_at: new Date(entry.timestamp * 1000).toISOString(),
      torn_id: playerId,
    });
  }

  if (upserts.length === 0) return;

  // Upsert all — on conflict (item_id, destination) update buy_price + reported_at
  const { error } = await supabase
    .from('abroad_prices')
    .upsert(upserts, { onConflict: 'item_id,destination' });

  if (error) {
    console.warn('abroad_prices upsert error:', error.message);
  }
}
