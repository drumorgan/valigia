// Silent background sync — fetches abroad purchase logs (type 6501)
// and upserts crowd-sourced buy prices into Supabase.
// Auto-discovers ANY item from purchase logs — not limited to the static list.
// Uses 7-day lookback with pagination. Only updates DB if the log entry
// is more recent than the existing record (newest data always wins).

import { callTornApi } from './torn-api.js';
import { supabase } from './supabase.js';
import { showToast } from './ui.js';

// Regex to extract country from log title: "Bought a Xanax from South Africa"
const COUNTRY_REGEX = /from (.+)$/i;

// Item ID cache key (shared with item-resolver.js)
const CACHE_KEY = 'valigia_item_id_map';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 10; // Safety cap to prevent runaway pagination

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
 * Fetch all abroad purchase logs from the last 7 days, paginating
 * forward through results if the API returns a full page.
 */
async function fetchAllLogs(playerId, diag) {
  const allEntries = [];
  let from = Math.floor((Date.now() - SEVEN_DAYS_MS) / 1000);

  // DIAGNOSTIC: first fetch ALL logs (no type filter) to see what exists
  const allLogsData = await callTornApi({
    section: 'user',
    selections: 'log',
    player_id: playerId,
    from,
  });
  if (allLogsData?.log) {
    const allLogs = Object.values(allLogsData.log);
    const typeCounts = {};
    for (const e of allLogs) {
      typeCounts[e.log] = (typeCounts[e.log] || 0) + 1;
    }
    diag.push(`ALL logs (no filter): ${allLogs.length} entries`);
    diag.push(`types: ${JSON.stringify(typeCounts)}`);
    if (allLogs.length > 0) {
      const sample = allLogs[0];
      diag.push(`sample: log=${sample.log} title="${sample.title?.slice(0, 60)}"`);
    }
  } else {
    diag.push(`ALL logs: ${allLogsData === null ? 'API error' : 'no log key'}`);
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await callTornApi({
      section: 'user',
      selections: 'log',
      player_id: playerId,
      log: 6501,
      from,
    });

    if (data === null) {
      diag.push(`6501 page ${page}: API error`);
      break;
    }

    if (!data.log) {
      diag.push(`6501 page ${page}: no "log" key`);
      break;
    }

    const entries = Object.values(data.log);
    diag.push(`6501 page ${page}: ${entries.length} entries`);
    if (entries.length === 0) break;

    allEntries.push(...entries);

    if (entries.length < 100) break;

    const newestTs = Math.max(...entries.map(e => e.timestamp || 0));
    if (newestTs <= from) break;
    from = newestTs + 1;
  }

  return allEntries;
}

/**
 * Fetch recent abroad purchase logs and upsert prices to Supabase.
 * Captures ANY abroad purchase — auto-discovers new items and destinations.
 * Only updates a row if the log entry is more recent than what's already stored,
 * so the freshest data always wins regardless of which player contributed it.
 * @param {number} playerId - Torn player ID (for server-side key decrypt)
 */
export async function syncAbroadPrices(playerId) {
  const diag = []; // diagnostic breadcrumbs

  const entries = await fetchAllLogs(playerId, diag);
  diag.push(`total: ${entries.length} log entries`);
  if (entries.length === 0) return diag;

  // Parse log entries into upsert candidates
  const candidates = [];
  let skippedNoData = 0;
  let skippedNoCountry = 0;
  let skippedNoItemId = 0;

  for (const entry of entries) {
    if (entry.log !== 6501) continue;

    const { item: itemName, cost: unitPrice } = entry.data || {};
    if (!itemName || !unitPrice) { skippedNoData++; continue; }

    // Extract country from title
    const countryMatch = entry.title?.match(COUNTRY_REGEX);
    if (!countryMatch) { skippedNoCountry++; continue; }
    const destination = countryMatch[1];

    // Look up item ID from cached Torn catalog
    const itemId = lookupItemId(itemName);
    if (!itemId) { skippedNoItemId++; continue; }

    candidates.push({
      item_name: itemName,
      item_id: itemId,
      destination,
      buy_price: unitPrice,
      reported_at: new Date(entry.timestamp * 1000).toISOString(),
      torn_id: playerId,
    });
  }

  diag.push(`${candidates.length} candidates (skip: ${skippedNoData} no-data, ${skippedNoCountry} no-country, ${skippedNoItemId} no-item-id)`);

  if (candidates.length === 0) return diag;

  // Deduplicate within this batch: keep only the most recent entry
  // per (item_id, destination) so we send the freshest data we have.
  const bestByKey = new Map();
  for (const c of candidates) {
    const key = `${c.item_id}:${c.destination}`;
    const existing = bestByKey.get(key);
    if (!existing || new Date(c.reported_at) > new Date(existing.reported_at)) {
      bestByKey.set(key, c);
    }
  }

  const upserts = [...bestByKey.values()];

  // Check what's already in the DB so we don't overwrite newer data
  // from another player's more recent login.
  const itemIds = [...new Set(upserts.map(u => u.item_id))];
  const { data: existingRows } = await supabase
    .from('abroad_prices')
    .select('item_id, destination, reported_at')
    .in('item_id', itemIds);

  const existingMap = new Map();
  if (existingRows) {
    for (const row of existingRows) {
      existingMap.set(`${row.item_id}:${row.destination}`, new Date(row.reported_at));
    }
  }

  // Only upsert entries that are newer than what the DB already has
  const filtered = upserts.filter(u => {
    const key = `${u.item_id}:${u.destination}`;
    const existingDate = existingMap.get(key);
    if (!existingDate) return true; // brand new item/destination combo
    return new Date(u.reported_at) > existingDate;
  });

  if (filtered.length === 0) return;

  // Upsert — on conflict (item_id, destination) update buy_price + reported_at
  const { error } = await supabase
    .from('abroad_prices')
    .upsert(filtered, { onConflict: 'item_id,destination' });

  if (error) {
    diag.push(`upsert error: ${error.message}`);
  } else {
    diag.push(`${filtered.length} prices upserted`);
  }

  return diag;
}
