// Silent background sync — fetches abroad purchase logs (type 6501)
// and upserts crowd-sourced buy prices into Supabase.

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';
import { ABROAD_ITEMS, ABROAD_ITEM_BY_NAME } from './data/abroad-items.js';

// Regex to extract country from log title: "Bought a Xanax from South Africa"
const COUNTRY_REGEX = /from (.+)$/i;

/**
 * Fetch recent abroad purchase logs and upsert prices to Supabase.
 * Runs silently — no UI feedback unless there's an error worth surfacing.
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

  if (!data || !data.log) return;

  const entries = Object.values(data.log);
  if (entries.length === 0) return;

  const upserts = [];

  for (const entry of entries) {
    if (entry.log !== 6501) continue;

    const { item: itemName, cost: unitPrice } = entry.data || {};
    if (!itemName || !unitPrice) continue;

    // Extract country from title
    const countryMatch = entry.title?.match(COUNTRY_REGEX);
    if (!countryMatch) continue;
    const country = countryMatch[1];

    // Look up item in static data by name
    const itemDef = ABROAD_ITEM_BY_NAME[itemName.toLowerCase()];
    if (!itemDef || !itemDef.itemId) continue;

    // Find the specific item+destination combo (e.g. Xanax in Japan vs South Africa)
    const matchedItem = ABROAD_ITEMS.find(
      (i) =>
        i.name.toLowerCase() === itemName.toLowerCase() &&
        i.destination.toLowerCase() === country.toLowerCase()
    );
    if (!matchedItem || !matchedItem.itemId) continue;

    upserts.push({
      item_name: matchedItem.name,
      item_id: matchedItem.itemId,
      destination: matchedItem.destination,
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
