// Valigia — community-data ingest via edge functions.
//
// Layer 2 of the security hardening. Writes to the shared sell_prices and
// bazaar_prices tables now go through ingest-sell-prices and
// ingest-bazaar-prices, which validate the submitting session against
// player_secrets.session_token_hash and stamp observer_player_id onto every
// row. Closes the anon-write leak exposed by the public PDA userscript.
//
// During Parts 2 and 3 of the rollout we keep a fallback to the direct anon
// upsert so a bad edge-function deploy doesn't lose community data. In the
// fallback path observer_player_id stays null, which makes fallback activity
// visible in the DB. The fallback goes away in Part 3 when the anon
// INSERT/UPDATE policies are dropped entirely.

import { supabase, supabaseUrl, supabaseAnonKey } from './supabase.js';
import { getSession } from './auth.js';

const INGEST_SELL_URL = `${supabaseUrl}/functions/v1/ingest-sell-prices`;
const INGEST_BAZAAR_URL = `${supabaseUrl}/functions/v1/ingest-bazaar-prices`;

// Rate-limit retry policy. The ingest-* edge functions gate writes at 500ms
// per-player (migration 027). The dashboard's three sell-price refresh
// paths (abroad, watchlist, top-travel) all end with one batched
// ingestSellPrices() each, and they race — any two finishing within 500ms
// of each other get 429'd. Rather than serialise the callers we retry
// automatically using the server-advertised retry_after_ms. Three
// attempts covers back-to-back bursts up to ~1.5s apart without
// masking a real outage.
const INGEST_RETRY_ATTEMPTS = 3;

function authBody() {
  const session = getSession();
  if (!session) return null;
  return {
    player_id: Number(session.player_id),
    session_token: session.session_token,
  };
}

async function postIngest(url, rows) {
  const auth = authBody();
  if (!auth) return { ok: false, error: 'no_session' };

  let lastBody = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < INGEST_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({ ...auth, rows }),
      });
      if (res.ok) return { ok: true, status: res.status };

      let body = {};
      try { body = await res.json(); } catch { /* ignore */ }
      lastBody = body;
      lastStatus = res.status;

      // 429 = per-player ingest rate limiter (migration 027). The server
      // tells us exactly how long to wait via retry_after_ms; add a small
      // jitter so two racing callers don't wake up at the exact same
      // instant and re-collide on the next gate check.
      if (res.status === 429 && attempt < INGEST_RETRY_ATTEMPTS - 1) {
        const retryMs = Number(body?.retry_after_ms) > 0
          ? Number(body.retry_after_ms)
          : 500;
        const jitter = Math.floor(Math.random() * 120);
        await new Promise((r) => setTimeout(r, retryMs + jitter));
        continue;
      }

      return {
        ok: false,
        status: res.status,
        error: body.error || `HTTP ${res.status}`,
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }
  return {
    ok: false,
    status: lastStatus,
    error: lastBody?.error || `HTTP ${lastStatus}`,
  };
}

/**
 * Upsert rows into sell_prices via the ingest-sell-prices edge function,
 * falling back to a direct anon upsert on any failure so community data
 * keeps flowing during the rollout.
 *
 * Each row: { item_id, price, floor_qty?, listing_count? }.
 * updated_at is set server-side by the edge function (or stamped here on
 * the fallback path).
 */
export async function ingestSellPrices(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true };

  const result = await postIngest(INGEST_SELL_URL, rows);
  if (result.ok) return result;

  // 429 is a deliberate rate-limit from the edge function (migration 027).
  // Falling back to the direct anon upsert would bypass the gate entirely,
  // defeating the whole point. Surface the block instead — the caller
  // decides whether to retry. Other errors (5xx, network) still fall back.
  if (result.status === 429) return result;

  const withTimestamp = rows.map(r => ({
    item_id: r.item_id,
    price: r.price ?? null,
    floor_qty: r.floor_qty ?? null,
    listing_count: r.listing_count ?? null,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('sell_prices')
    .upsert(withTimestamp, { onConflict: 'item_id' });
  if (error) return { ok: false, error: error.message, fallback: true };
  return { ok: true, fallback: true };
}

/**
 * Upsert rows into bazaar_prices via the ingest-bazaar-prices edge function,
 * with the same rollout-period fallback as ingestSellPrices.
 *
 * Each row: { item_id, bazaar_owner_id, price, quantity, miss_count, checked_at? }.
 * If checked_at is omitted, the edge function stamps server-side now(). The
 * scanner's Phase-2 discovery passes epoch to force max-staleness ordering.
 */
export async function ingestBazaarPrices(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true };

  const result = await postIngest(INGEST_BAZAAR_URL, rows);
  if (result.ok) return result;

  // See ingestSellPrices() — 429 must NOT fall back to anon upsert.
  if (result.status === 429) return result;

  const nowIso = new Date().toISOString();
  const withTimestamp = rows.map(r => ({
    item_id: r.item_id,
    bazaar_owner_id: r.bazaar_owner_id,
    price: r.price ?? null,
    quantity: r.quantity ?? null,
    miss_count: r.miss_count ?? 0,
    checked_at: r.checked_at ?? nowIso,
  }));
  const { error } = await supabase
    .from('bazaar_prices')
    .upsert(withTimestamp, { onConflict: 'item_id,bazaar_owner_id' });
  if (error) return { ok: false, error: error.message, fallback: true };
  return { ok: true, fallback: true };
}
