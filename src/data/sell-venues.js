// Sell-venue resolution — where does an imported item actually get sold?
//
// Before Contraband (Dec 2025) every abroad import was an Item Market flip,
// so the table only knew one sell price: the market floor minus the 5% fee.
// Contraband broke that assumption. Many of the new items can't be sold on
// the Item Market at all — they go to a city store (Pharmacy, jeweller…) for
// a fixed cash price, or to the Museum for points. Pricing them against the
// Item Market showed "no listings" or a meaningless floor.
//
// This module picks the best of up to three venues per item:
//
//   market — Item Market floor × 0.95 (5% listing fee)
//   store  — the fixed NPC shop sell price from Torn's item catalog
//            (`sell_price`), paid in cash with no fee
//   museum — museum points × the crowd-sourced Points Market cash rate
//
// Pure functions only (no I/O) so the choice is unit-testable.

export const MARKET_FEE = 0.05;

// Normalise an item name for lookups: lowercase, trimmed, trailing plural
// "s" dropped so "Uncut Diamonds" / "Uncut Diamond" both match.
export function normalizeItemName(name) {
  if (!name) return '';
  const n = String(name).trim().toLowerCase();
  return n.endsWith('s') ? n.slice(0, -1) : n;
}

// Museum exchange values for abroad-bought contraband. Mirrors the
// userscript's MUSEUM_SETS table (public/valigia-ingest.user.js) — keep the
// two in step. The Arrowhead set is six DIFFERENT points worth 25 points
// together; per-unit value is 25/6 and only realisable as a complete set,
// which the UI flags via `setSize`.
const ARROWHEAD_NAMES = [
  'Chert Point', 'Quartzite Point', 'Basalt Point',
  'Obsidian Point', 'Quartz Point', 'Chalcedony Point',
];

const MUSEUM_ITEMS = new Map([
  [normalizeItemName('Patagonian Fossil'),  { points: 20, setSize: 1 }],
  [normalizeItemName('Meteorite Fragment'), { points: 15, setSize: 1 }],
  ...ARROWHEAD_NAMES.map(n => [normalizeItemName(n), { points: 25 / 6, setSize: 6 }]),
]);

/**
 * Museum entry for an item name, or null when it isn't a museum item.
 * @returns {{points:number, setSize:number}|null}
 */
export function getMuseumEntry(name) {
  return MUSEUM_ITEMS.get(normalizeItemName(name)) || null;
}

// Contraband items named in the Travel 2.0 / Tourism Day 2026 guide. Used
// as a fallback classifier alongside Torn's catalog `type`, because we
// can't confirm how the catalog labels the new category.
const CONTRABAND_NAMES = new Set([
  'Ephedrine Powder', 'Safrole Oil', 'Ergotamine Ampoules',
  'Uncut Diamond', 'Natural Pearl', 'Counterfeit Manga',
  'Meteorite Fragment', 'Patagonian Fossil',
  ...ARROWHEAD_NAMES,
].map(normalizeItemName));

export function isContrabandName(name) {
  return CONTRABAND_NAMES.has(normalizeItemName(name));
}

/**
 * Pick the venue that pays the most per unit, after fees.
 *
 * @param {object} p
 * @param {number|null|undefined} p.marketPrice - Item Market floor (gross)
 * @param {number|null|undefined} p.storePrice  - NPC shop sell price (cash, no fee)
 * @param {{points:number,setSize:number}|null} [p.museum] - museum entry
 * @param {number|null} [p.pointsRate] - cash per point; museum ignored without it
 * @returns {{venue:'market'|'store'|'museum', gross:number, fee:number, net:number, setSize:number}|null}
 *   null when no venue has a price.
 */
export function pickSellVenue({ marketPrice, storePrice, museum = null, pointsRate = null }) {
  const options = [];
  if (marketPrice != null && marketPrice > 0) {
    options.push({ venue: 'market', gross: marketPrice, fee: MARKET_FEE, setSize: 1 });
  }
  if (storePrice != null && storePrice > 0) {
    options.push({ venue: 'store', gross: storePrice, fee: 0, setSize: 1 });
  }
  if (museum && pointsRate != null && pointsRate > 0) {
    options.push({ venue: 'museum', gross: museum.points * pointsRate, fee: 0, setSize: museum.setSize });
  }
  let best = null;
  for (const o of options) {
    o.net = o.gross * (1 - o.fee);
    // Ties go to the market (listed first) — it's the familiar venue.
    if (!best || o.net > best.net) best = o;
  }
  return best;
}
