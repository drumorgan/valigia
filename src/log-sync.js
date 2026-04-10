// Abroad price sync — fetches foreign stock prices and upserts to Supabase.
// Tries multiple Torn API endpoints to find abroad item data.

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';

/**
 * Fetch abroad prices and upsert to Supabase.
 * Tries V2 foreignstock endpoint first, then V1 torn/shoplifting.
 * @param {number} playerId - Torn player ID (for server-side key decrypt)
 */
export async function syncAbroadPrices(playerId) {
  const diag = []; // diagnostic breadcrumbs

  // ── Attempt 1: V2 foreignstock endpoint ──
  const v2stock = await callTornApi({
    section: 'travel',
    selections: 'foreignstock',
    player_id: playerId,
    v2: true,
  });

  if (v2stock) {
    const keys = Object.keys(v2stock);
    diag.push(`V2 foreignstock keys: [${keys.slice(0, 10).join(',')}]`);
    const sample = JSON.stringify(v2stock).slice(0, 300);
    diag.push(`V2 foreignstock sample: ${sample}`);

    // If it has country/item data, report it
    if (v2stock.foreignstock || v2stock.stocks || v2stock.items) {
      const data = v2stock.foreignstock || v2stock.stocks || v2stock.items;
      const entries = Array.isArray(data) ? data : Object.values(data);
      diag.push(`V2 foreignstock: ${entries.length} entries`);
      if (entries.length > 0) {
        diag.push(`entry sample: ${JSON.stringify(entries[0]).slice(0, 200)}`);
      }
    }
  } else {
    diag.push('V2 foreignstock: API error');
  }

  // ── Attempt 2: V1 torn/shoplifting ──
  const v1shop = await callTornApi({
    section: 'torn',
    selections: 'shoplifting',
    player_id: playerId,
  });

  if (v1shop) {
    const keys = Object.keys(v1shop);
    diag.push(`V1 shoplifting keys: [${keys.slice(0, 10).join(',')}]`);
    const sample = JSON.stringify(v1shop).slice(0, 300);
    diag.push(`V1 shoplifting sample: ${sample}`);
  } else {
    diag.push('V1 shoplifting: API error');
  }

  return diag;
}
