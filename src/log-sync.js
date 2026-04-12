// Abroad price sync — fetches crowd-sourced buy prices from the YATA API.
// The Torn API doesn't expose abroad purchase data, so we use YATA's
// community database at https://yata.yt/api/v1/travel/export/

const YATA_URL = 'https://yata.yt/api/v1/travel/export/';
const CACHE_KEY = 'valigia_yata_cache_v1';

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
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items) || !parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(items) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      items,
      fetchedAt: Date.now(),
    }));
  } catch {
    // Storage full or disabled — non-fatal.
  }
}

/**
 * Fetch abroad prices from the YATA community API.
 *
 * Returns { items, cached, cachedAt }:
 *   - items: array in the shape of abroad_prices rows
 *     { item_id, item_name, destination, buy_price, reported_at, quantity }
 *   - cached: true iff live fetch failed and we're returning the last good payload
 *   - cachedAt: epoch ms of when the cached payload was fetched (null when live)
 *
 * Returns null only if the live fetch failed AND there's no cache to fall back on.
 */
export async function fetchAbroadPrices() {
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
        });
      }
    }

    if (items.length > 0) writeCache(items);
    return { items, cached: false, cachedAt: null };
  } catch {
    // Live fetch failed — fall back to cache if we have one.
    const cache = readCache();
    if (cache && cache.items.length > 0) {
      return { items: cache.items, cached: true, cachedAt: cache.fetchedAt };
    }
    return null;
  }
}
