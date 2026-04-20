// Abroad price sync — merges first-party scrapes with the YATA community API.
//
// Two sources feed this module:
//   1. `abroad_prices` in Supabase — first-party observations scraped from
//      Torn's travel page by the PDA userscript (public/valigia-ingest.user.js).
//      Fresh and authoritative, but only covers destinations users have
//      recently visited.
//   2. YATA (https://yata.yt/api/v1/travel/export/) — crowd-sourced pool that
//      covers every destination all the time, but can lag reality by hours.
//
// Merge policy per (item_id, destination):
//   - If we have a scrape observed within FIRST_PARTY_FRESH_MS, use it.
//   - Otherwise fall back to YATA.
// The merged item carries a `source: 'scrape' | 'yata'` tag so the UI can
// render a freshness indicator (see src/ui.js).

import { supabase } from './supabase.js';
import { safeGetItem, safeSetItem } from './storage.js';

const YATA_URL = 'https://yata.yt/api/v1/travel/export/';
const CACHE_KEY = 'valigia_yata_cache_v1';

// A scrape counts as "authoritative" for this long after observed_at.
// 10 minutes matches the bazaar-pool freshness window and covers the
// typical round trip for a user flying in and back out again.
const FIRST_PARTY_FRESH_MS = 10 * 60 * 1000;

// Bound the query so we don't pull the whole table — FIRST_PARTY_FRESH_MS
// is enough, but we pad it a bit for clock skew.
const FIRST_PARTY_QUERY_WINDOW_MS = 15 * 60 * 1000;

// YATA uses 3-letter country codes → map to our destination names
const COUNTRY_MAP = {
  mex: 'Mexico',
  cay: 'Caymans',
  can: 'Canada',
  haw: 'Hawaii',
  uni: 'UK',
  arg: 'Argentina',
  swi: 'Switzerland',
  jap: 'Japan',
  chi: 'China',
  uae: 'UAE',
  sou: 'South Africa',
};

function readCache() {
  const raw = safeGetItem(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items) || !parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(items) {
  // Storage full or disabled — safeSetItem returns false and we move on.
  safeSetItem(CACHE_KEY, JSON.stringify({
    items,
    fetchedAt: Date.now(),
  }));
}

/**
 * Pull first-party scrapes observed within the freshness window.
 * Returns an array in the same shape YATA produces, so the merge is a
 * pure lookup by key. Always resolves — returns [] on any failure, since
 * YATA is the safe fallback.
 */
async function fetchFirstPartyAbroadPrices() {
  try {
    const sinceIso = new Date(Date.now() - FIRST_PARTY_QUERY_WINDOW_MS).toISOString();
    const { data, error } = await supabase
      .from('abroad_prices')
      .select('item_id, item_name, destination, buy_price, stock, observed_at')
      .gte('observed_at', sinceIso);
    if (error || !Array.isArray(data)) return [];

    // Within the window a given (item_id, destination) may have multiple
    // observations if several players visited. Keep the newest per key.
    const freshest = new Map();
    for (const row of data) {
      const key = `${row.item_id}|${row.destination}`;
      const existing = freshest.get(key);
      if (!existing || new Date(row.observed_at) > new Date(existing.observed_at)) {
        freshest.set(key, row);
      }
    }

    const out = [];
    const now = Date.now();
    for (const row of freshest.values()) {
      const observedMs = new Date(row.observed_at).getTime();
      if (now - observedMs > FIRST_PARTY_FRESH_MS) continue;
      out.push({
        item_id: row.item_id,
        item_name: row.item_name,
        destination: row.destination,
        buy_price: row.buy_price,
        reported_at: row.observed_at,
        quantity: row.stock,
        source: 'scrape',
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Fetch abroad prices from the YATA community API.
 * Internal helper — returns a plain array of items, or null on total failure
 * with no cache available.
 */
async function fetchYataAbroadPrices() {
  try {
    const res = await fetch(YATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    // YATA response: { "countryCode": { "update": timestamp, "stocks": [...] }, ... }
    // or possibly wrapped in a "stocks" key
    const countries = data.stocks || data;

    const items = [];
    for (const [code, country] of Object.entries(countries)) {
      const destination = COUNTRY_MAP[code];
      if (!destination) continue;

      const stocks = country.stocks || [];
      const updateTime = country.update
        ? new Date(country.update * 1000).toISOString()
        : new Date().toISOString();

      for (const stock of stocks) {
        if (!stock.id || !stock.cost) continue;
        items.push({
          item_id: stock.id,
          item_name: stock.name || `Item ${stock.id}`,
          destination,
          buy_price: stock.cost,
          reported_at: updateTime,
          quantity: stock.quantity ?? null,
          source: 'yata',
        });
      }
    }

    if (items.length > 0) writeCache(items);
    return { items, cached: false, cachedAt: null };
  } catch {
    // Live fetch failed — fall back to cache if we have one.
    const cache = readCache();
    if (cache && cache.items.length > 0) {
      // Tag cached items as yata too; they came from YATA originally.
      const items = cache.items.map((it) => ({ ...it, source: it.source || 'yata' }));
      return { items, cached: true, cachedAt: cache.fetchedAt };
    }
    return null;
  }
}

/**
 * Fetch abroad prices, preferring fresh first-party scrapes over YATA.
 *
 * Returns { items, cached, cachedAt }:
 *   - items: array of
 *     { item_id, item_name, destination, buy_price, reported_at, quantity, source }
 *     where source is 'scrape' or 'yata'
 *   - cached: true iff the YATA live fetch failed AND we're returning the
 *     last good YATA payload (unchanged meaning from before)
 *   - cachedAt: epoch ms of when the cached YATA payload was fetched
 *
 * Returns null only if the YATA fetch failed, no cache exists, AND we
 * have zero first-party data to fall back on.
 */
export async function fetchAbroadPrices() {
  // Run both in parallel. YATA is the backbone; first-party fills in fresh
  // data where we have it.
  const [yata, firstParty] = await Promise.all([
    fetchYataAbroadPrices(),
    fetchFirstPartyAbroadPrices(),
  ]);

  // No YATA AND no first-party → total failure.
  if ((!yata || yata.items.length === 0) && firstParty.length === 0) {
    return null;
  }

  // Build the merged map, YATA first, then overlay fresh scrapes on top.
  // Keyed by item_id|destination so items sold in multiple countries (e.g.
  // African Violet in UAE + SA, Xanax in JP + SA) stay distinct.
  const merged = new Map();

  if (yata && yata.items.length > 0) {
    for (const it of yata.items) {
      merged.set(`${it.item_id}|${it.destination}`, it);
    }
  }
  for (const it of firstParty) {
    merged.set(`${it.item_id}|${it.destination}`, it);
  }

  return {
    items: Array.from(merged.values()),
    cached: yata ? yata.cached : false,
    cachedAt: yata ? yata.cachedAt : null,
  };
}
