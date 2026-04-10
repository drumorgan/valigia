// Abroad price sync — fetches crowd-sourced buy prices from the YATA API.
// The Torn API doesn't expose abroad purchase data, so we use YATA's
// community database at https://yata.yt/api/v1/travel/export/

const YATA_URL = 'https://yata.yt/api/v1/travel/export/';

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

/**
 * Fetch abroad prices from the YATA community API.
 * Returns an array of items in the same shape as the abroad_prices table:
 *   { item_id, item_name, destination, buy_price, reported_at }
 * Returns null on failure.
 */
export async function fetchAbroadPrices() {
  try {
    const res = await fetch(YATA_URL);
    if (!res.ok) return null;

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

    return items;
  } catch (err) {
    // CORS or network error
    return null;
  }
}
