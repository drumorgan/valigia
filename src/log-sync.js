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
 * Fetch all abroad purchase logs from the last 7 days.
 * The Torn API's server-side log=6501 filter is unreliable,
 * so we fetch ALL logs with pagination and filter client-side.
 * Paginates backwards (newest → oldest) using `to` parameter.
 */
async function fetchAllLogs(playerId, diag) {
  const allEntries = [];
  const from = Math.floor((Date.now() - SEVEN_DAYS_MS) / 1000);

  // Try V2 API with cat=travel first — V1 log selection doesn't return purchase entries
  const v2data = await callTornApi({
    section: 'user',
    selections: 'log',
    player_id: playerId,
    v2: true,
    cat: 'travel',
    from,
  });

  if (v2data && v2data.log) {
    const v2entries = Array.isArray(v2data.log) ? v2data.log : Object.values(v2data.log);
    const v2purchases = v2entries.filter(e =>
      /bought/i.test(e.title) || e.log === 6501
    );
    diag.push(`V2 travel: ${v2entries.length} entries, ${v2purchases.length} purchases`);
    if (v2entries.length > 0) {
      const sample = v2entries[0];
      diag.push(`v2 sample: log=${sample.log} "${sample.title?.slice(0, 60)}"`);
    }
    if (v2purchases.length > 0) {
      allEntries.push(...v2purchases);
      diag.push(`total: ${allEntries.length} log entries (from V2)`);
      return allEntries;
    }
  } else {
    diag.push(`V2 travel: ${v2data === null ? 'API error' : JSON.stringify(v2data).slice(0, 100)}`);
  }

  // Fallback: V1 paginated fetch
  let to = undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = {
      section: 'user',
      selections: 'log',
      player_id: playerId,
      from,
    };
    if (to !== undefined) params.to = to;

    const data = await callTornApi(params);

    if (data === null) {
      diag.push(`page ${page}: API error`);
      break;
    }

    if (!data.log) {
      diag.push(`page ${page}: no "log" key`);
      break;
    }

    const entries = Object.values(data.log);
    const matched = entries.filter(e => e.log === 6501);
    allEntries.push(...matched);

    // Diagnostic: time range + type breakdown + any "bought" entries
    const timestamps = entries.map(e => e.timestamp || 0);
    const oldest = new Date(Math.min(...timestamps) * 1000).toISOString().slice(5, 16);
    const newest = new Date(Math.max(...timestamps) * 1000).toISOString().slice(5, 16);
    const typeCounts = {};
    const boughtEntries = [];
    for (const e of entries) {
      typeCounts[e.log] = (typeCounts[e.log] || 0) + 1;
      if (/bought/i.test(e.title)) {
        boughtEntries.push(`type=${e.log} "${e.title?.slice(0, 50)}"`);
      }
    }
    diag.push(`p${page}: ${entries.length} logs [${oldest}→${newest}] ${matched.length} type-6501`);
    diag.push(`types: ${JSON.stringify(typeCounts)}`);
    if (boughtEntries.length > 0) {
      diag.push(`BOUGHT: ${boughtEntries.slice(0, 3).join(' | ')}`);
    }

    // Less than 100 means we've fetched everything
    if (entries.length < 100) break;

    // Move backwards: set `to` just before the oldest entry in this page
    const oldestTs = Math.min(...entries.map(e => e.timestamp || Infinity));
    if (oldestTs <= from) break; // reached the 7-day boundary
    to = oldestTs - 1;
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
