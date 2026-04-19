// TornExchange trader pool — data layer for the Sell tab.
//
// TE is a community board where players advertise standing buy-offers
// ("I'll pay $30k per Jaguar Plushie to anyone who shows up"). Reading
// the two tables migration 028 created is public; writing goes through
// the `ingest-te-trader` edge function because TE requires a server-side
// scrape (their site 403s bot-looking fetches).
//
// This module handles:
//   - submitTrader(): ask the edge fn to scrape a TE URL / handle / id
//   - listTraders(): read the current trader pool
//   - fetchBuyPricesFor(itemIds): the Sell tab's inventory matcher hot path
//   - refreshStaleTrader(): opportunistic freshen-on-login for a known handle
//
// All reads hit Supabase anon directly — the three trust boundaries
// (anon read, service-role write, rate-limited submit) are enforced by
// migration 028 and ingest-te-trader.

import { supabase, supabaseUrl, supabaseAnonKey } from './supabase.js';
import { getSession } from './auth.js';

const INGEST_URL = `${supabaseUrl}/functions/v1/ingest-te-trader`;

// A just-scraped trader is "fresh" for this long. The background refresher
// only retouches traders older than this on dashboard load, and the
// self-refresh hook also no-ops if it ran recently. 20 min is a rough
// compromise between TE's real update cadence (many traders edit prices
// a few times a day) and being polite about outbound load on TE itself.
export const TRADER_STALE_MS = 20 * 60 * 1000;

// Max traders to refresh in a single dashboard load, oldest-first. Bigger
// numbers mean more load on TE; this also caps the number of HTTP hops
// the edge fn makes per player visit.
const REFRESH_BATCH = 3;

/**
 * Submit a trader for scraping.
 * Accepts any of: full TE URL, bare handle, numeric Torn player id.
 * Uses the logged-in session — no raw API key needed on the client.
 * @param {string} input
 * @param {{ debug?: boolean }} [opts]
 * @returns {Promise<{ok: boolean, handle?: string, resolved?: number, unresolved?: number, error?: string, debug_sample?: string}>}
 */
export async function submitTrader(input, opts = {}) {
  const session = getSession();
  if (!session) return { ok: false, error: 'not_logged_in' };
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({
        input,
        player_id: Number(session.player_id),
        session_token: session.session_token,
        debug: !!opts.debug,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}`, ...data };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err?.message || 'network_error' };
  }
}

/**
 * Read all traders in the pool, newest-refreshed first. The submit
 * form's "known traders" list uses this.
 */
export async function listTraders() {
  const { data, error } = await supabase
    .from('te_traders')
    .select('handle, torn_player_id, last_scraped_at, last_scrape_ok, consecutive_fails, item_count')
    .order('last_scraped_at', { ascending: false, nullsFirst: false });
  if (error) return [];
  return data || [];
}

/**
 * For a set of item ids, return the highest buy-price offer per item
 * along with which trader is offering it. This is the engine behind the
 * Sell tab's inventory matcher: pass in the user's inventory ids, get
 * back the best buyer per item.
 *
 * @param {number[]} itemIds
 * @returns {Promise<Map<number, {handle: string, item_id: number, item_name: string, buy_price: number, updated_at: string}>>}
 */
export async function fetchBestBuyersFor(itemIds) {
  const out = new Map();
  const ids = (itemIds || []).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return out;

  // PostgREST `.in()` is capped at URL length; chunk conservatively so
  // a user with a 400-item inventory doesn't blow the query.
  const CHUNK = 150;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('te_buy_prices')
      .select('handle, item_id, item_name, buy_price, updated_at')
      .in('item_id', slice);
    if (error || !data) continue;

    // Reduce to best (highest) price per item_id. Ties break on freshness
    // so an identically-priced fresher row wins — surfacing recently-
    // updated traders is what a user would want in practice.
    for (const row of data) {
      const existing = out.get(row.item_id);
      if (
        !existing
        || row.buy_price > existing.buy_price
        || (row.buy_price === existing.buy_price && row.updated_at > existing.updated_at)
      ) {
        out.set(row.item_id, row);
      }
    }
  }
  return out;
}

/**
 * Read one trader's full price list, for the detail view on the Sell tab.
 */
export async function fetchTraderPrices(handle) {
  const { data, error } = await supabase
    .from('te_buy_prices')
    .select('item_id, item_name, buy_price, updated_at')
    .eq('handle', handle)
    .order('buy_price', { ascending: false });
  if (error) return [];
  return data || [];
}

/**
 * Opportunistic "freshen a stale trader" call — used by the self-refresh
 * hook in main.js when the logged-in player matches a known handle.
 */
export async function refreshStaleTrader(input) {
  return submitTrader(input);
}

/**
 * Return up to REFRESH_BATCH traders whose last_scraped_at is older than
 * TRADER_STALE_MS (or never scraped). Used by the dashboard's background
 * refresher to keep the pool current without a cron.
 */
export async function getTradersDueForRefresh() {
  const cutoff = new Date(Date.now() - TRADER_STALE_MS).toISOString();
  const { data, error } = await supabase
    .from('te_traders')
    .select('handle, last_scraped_at, last_scrape_ok, consecutive_fails')
    .or(`last_scraped_at.is.null,last_scraped_at.lt.${cutoff}`)
    // Traders that have failed many times in a row go to the back of the
    // queue — we still retry them occasionally (nulls-first ordering on
    // last_scraped_at doesn't apply to failed rows because those have
    // a timestamp set), but newer submissions without recent failures
    // get preference.
    .order('consecutive_fails', { ascending: true })
    .order('last_scraped_at', { ascending: true, nullsFirst: true })
    .limit(REFRESH_BATCH);
  if (error || !data) return [];
  // Skip traders that have failed a lot — let a human re-submit them.
  return data.filter((t) => (t.consecutive_fails ?? 0) < 5);
}
