// Watchlist — per-player price-drop alerts across Item Market, Bazaars, and
// abroad travel shops.
//
// Storage: `watchlist_alerts` (migration 019). Writes go through the
// `watchlist` edge function, which validates {player_id, session_token}
// the same way auto-login does and then performs a service-role upsert.
// Reads are public because the rows contain no secrets.
//
// Matching runs entirely client-side: one parallel query per venue, then
// a merge step that applies each alert's per-venue filter and max_price.
// The three source tables are already read-publicly, so there's no gain
// from round-tripping through the edge function for reads.

import { supabase, supabaseUrl, supabaseAnonKey } from './supabase.js';
import { getPlayerId } from './auth.js';

const SESSION_STORAGE_KEY = 'valigia_session';
const WATCHLIST_FN_URL = `${supabaseUrl}/functions/v1/watchlist`;

// Bazaar rows older than this are considered stale — same threshold the
// "Best Run Right Now" card uses before re-verifying a bazaar pool hit.
// Showing a 2-hour-old bazaar price as a "current match" would be a lie.
const BAZAAR_MAX_AGE_MS = 10 * 60 * 1000;

// Abroad prices are first-party PDA scrapes; they go stale faster because
// Torn shops restock and deplete continuously. 30 min is generous enough
// to avoid an empty card when nobody's travelled in a while, tight enough
// that we don't claim a stock level that no longer exists.
const ABROAD_MAX_AGE_MS = 30 * 60 * 1000;

export const ALL_VENUES = ['market', 'bazaar', 'abroad'];

function getSessionToken() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.session_token || null;
  } catch {
    return null;
  }
}

/** Low-level edge-function caller. Returns the parsed JSON body. */
async function callWatchlistFn(action, extras = {}) {
  const player_id = getPlayerId();
  const session_token = getSessionToken();
  if (!player_id || !session_token) {
    return { success: false, error: 'not_logged_in' };
  }
  const res = await fetch(WATCHLIST_FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({
      action,
      player_id: Number(player_id),
      session_token,
      ...extras,
    }),
  });
  try {
    return await res.json();
  } catch {
    return { success: false, error: 'bad_response' };
  }
}

// ── Public CRUD ────────────────────────────────────────────────

/** Fetch this player's alerts. Returns [] on failure. */
export async function listAlerts() {
  const result = await callWatchlistFn('list');
  if (!result?.success) return [];
  return Array.isArray(result.alerts) ? result.alerts : [];
}

/**
 * Add or update one alert.
 * @param {number} itemId
 * @param {number} maxPrice  alert fires when any venue ≤ this
 * @param {string[]} venues  subset of {'market','bazaar','abroad'}
 */
export async function upsertAlert(itemId, maxPrice, venues = ALL_VENUES) {
  return callWatchlistFn('upsert', {
    item_id: Number(itemId),
    max_price: Math.round(Number(maxPrice)),
    venues,
  });
}

/** Remove one alert. */
export async function deleteAlert(itemId) {
  return callWatchlistFn('delete', { item_id: Number(itemId) });
}

// ── Matching ───────────────────────────────────────────────────
// The output shape every UI consumer expects. Keep the fields flat so the
// render code doesn't have to branch on venue to format a row.
//
// match = {
//   item_id, item_name,      // identity
//   venue,                   // 'market' | 'bazaar' | 'abroad'
//   price,                   // numeric — already compared against max_price
//   max_price,               // the alert threshold (for display delta)
//   savings, savings_pct,    // max_price − price, and pct
//   observed_at,             // ms since epoch, venue-specific staleness
//   venue_label,             // human string e.g. "Item Market", "Bazaar", "Switzerland"
//   link,                    // deep-link URL into Torn
//   extra                    // venue-specific payload (bazaar owner, shop stock, etc.)
// }

/**
 * Resolve one alert against the three price pools. Returns an array of
 * matches (zero, one, or multiple venues can hit for the same alert).
 */
function matchesForAlert(alert, context) {
  const { itemNameById, sellByItem, bazaarByItem, abroadByItem } = context;
  const out = [];
  const itemName = itemNameById.get(alert.item_id) || `Item #${alert.item_id}`;
  const maxPrice = Number(alert.max_price);
  const venueSet = new Set(alert.venues || ALL_VENUES);

  // --- Item Market ---
  if (venueSet.has('market')) {
    const row = sellByItem.get(alert.item_id);
    if (row && row.price != null && Number(row.price) <= maxPrice) {
      const price = Number(row.price);
      out.push({
        item_id: alert.item_id,
        item_name: itemName,
        venue: 'market',
        venue_label: 'Item Market',
        price,
        max_price: maxPrice,
        savings: maxPrice - price,
        savings_pct: ((maxPrice - price) / maxPrice) * 100,
        observed_at: row.updated_at ? new Date(row.updated_at).getTime() : 0,
        link: `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${alert.item_id}`,
        extra: {},
      });
    }
  }

  // --- Bazaars ---
  // Multiple owners can stock the same item; surface only the cheapest row
  // that matches. Showing runners-up on the match card would be noise — the
  // user can click through to the Watchlist tab if they want depth.
  if (venueSet.has('bazaar')) {
    const rows = bazaarByItem.get(alert.item_id) || [];
    let best = null;
    for (const row of rows) {
      if (row.price == null) continue;
      const price = Number(row.price);
      if (price > maxPrice) continue;
      const observedAt = row.checked_at ? new Date(row.checked_at).getTime() : 0;
      if (Date.now() - observedAt > BAZAAR_MAX_AGE_MS) continue;
      if (!best || price < best.price) {
        best = { price, observedAt, owner: row.bazaar_owner_id, quantity: row.quantity };
      }
    }
    if (best) {
      out.push({
        item_id: alert.item_id,
        item_name: itemName,
        venue: 'bazaar',
        venue_label: 'Bazaar',
        price: best.price,
        max_price: maxPrice,
        savings: maxPrice - best.price,
        savings_pct: ((maxPrice - best.price) / maxPrice) * 100,
        observed_at: best.observedAt,
        link: `https://www.torn.com/bazaar.php?userId=${best.owner}`,
        extra: { owner_id: best.owner, quantity: best.quantity },
      });
    }
  }

  // --- Abroad travel shops ---
  // Same item can appear in two countries (Xanax JPN + ZAF, African Violet
  // UAE + ZAF). We surface every matching destination separately — they're
  // different buy opportunities with different flight times.
  if (venueSet.has('abroad')) {
    const rows = abroadByItem.get(alert.item_id) || [];
    for (const row of rows) {
      if (row.buy_price == null) continue;
      const price = Number(row.buy_price);
      if (price > maxPrice) continue;
      const observedAt = row.observed_at ? new Date(row.observed_at).getTime() : 0;
      if (Date.now() - observedAt > ABROAD_MAX_AGE_MS) continue;
      out.push({
        item_id: alert.item_id,
        item_name: itemName,
        venue: 'abroad',
        venue_label: row.destination || 'Abroad',
        price,
        max_price: maxPrice,
        savings: maxPrice - price,
        savings_pct: ((maxPrice - price) / maxPrice) * 100,
        observed_at: observedAt,
        link: 'https://www.torn.com/page.php?sid=travel',
        extra: { destination: row.destination, stock: row.stock },
      });
    }
  }

  return out;
}

/**
 * Look up current matches for a batch of alerts. Three parallel queries,
 * then a per-alert merge. Returns a flat list sorted by savings_pct desc.
 *
 * @param {Array<{item_id:number,max_price:number,venues:string[]}>} alerts
 * @param {Map<number,string>} itemNameById - for rendering labels
 */
export async function findMatches(alerts, itemNameById) {
  if (!Array.isArray(alerts) || alerts.length === 0) return [];
  const itemIds = [...new Set(alerts.map((a) => a.item_id))];

  // Fire all three queries in parallel. An individual failure degrades to
  // "no matches from that venue" — never throws out of findMatches.
  const [sellRes, bazaarRes, abroadRes] = await Promise.allSettled([
    supabase.from('sell_prices').select('item_id, price, updated_at').in('item_id', itemIds),
    supabase
      .from('bazaar_prices')
      .select('item_id, price, quantity, bazaar_owner_id, checked_at')
      .in('item_id', itemIds),
    supabase
      .from('abroad_prices')
      .select('item_id, destination, buy_price, stock, observed_at')
      .in('item_id', itemIds),
  ]);

  const sellByItem = new Map();
  if (sellRes.status === 'fulfilled' && Array.isArray(sellRes.value?.data)) {
    for (const row of sellRes.value.data) sellByItem.set(row.item_id, row);
  }
  const bazaarByItem = new Map();
  if (bazaarRes.status === 'fulfilled' && Array.isArray(bazaarRes.value?.data)) {
    for (const row of bazaarRes.value.data) {
      if (!bazaarByItem.has(row.item_id)) bazaarByItem.set(row.item_id, []);
      bazaarByItem.get(row.item_id).push(row);
    }
  }
  const abroadByItem = new Map();
  if (abroadRes.status === 'fulfilled' && Array.isArray(abroadRes.value?.data)) {
    for (const row of abroadRes.value.data) {
      if (!abroadByItem.has(row.item_id)) abroadByItem.set(row.item_id, []);
      abroadByItem.get(row.item_id).push(row);
    }
  }

  const context = { itemNameById, sellByItem, bazaarByItem, abroadByItem };
  const matches = [];
  for (const alert of alerts) {
    for (const m of matchesForAlert(alert, context)) matches.push(m);
  }
  matches.sort((a, b) => b.savings_pct - a.savings_pct);
  return matches;
}
