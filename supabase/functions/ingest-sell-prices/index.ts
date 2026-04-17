import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ── Inlined shared: CORS ────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Inlined shared: base64 + SHA-256 helpers ────────────────────
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64(new Uint8Array(digest));
}
// Constant-time compare; both sides are 44-char base64 SHA-256 digests.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// ── Types ───────────────────────────────────────────────────────
interface SellRow {
  item_id: number;
  price: number | null;
  min_price: number | null;
  floor_qty: number | null;
  listing_count: number | null;
}

// ── Auth: dual-path observer resolution ─────────────────────────
//
// The web app holds { player_id, session_token } after login (see auth.js).
// The PDA userscript holds a raw ###PDA-APIKEY### substitution. Either path
// produces a trusted player_id we can stamp onto the row, but the validation
// is different:
//
//   Web-app path: look up session_token_hash in player_secrets, constant-time
//     compare. No Torn API call — auto-login already established the binding
//     between session token and player_id.
//
//   PDA path: call user/?selections=basic with the raw key. Mirrors the
//     pattern in ingest-travel-shop; one extra Torn API call per page scrape
//     (counts against the player's own 100/min budget, not ours).
//
// Returns either the validated player_id or an error Response to return.
async function resolveObserver(
  body: Record<string, unknown>,
  supabase: SupabaseClient,
): Promise<{ ok: true; player_id: number } | { ok: false; response: Response }> {
  // Web-app path first — cheaper and more common during typical page loads.
  if (typeof body.session_token === 'string' && body.player_id != null) {
    const playerId = Number(body.player_id);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      return { ok: false, response: unauthorized() };
    }
    const { data: secret } = await supabase
      .from('player_secrets')
      .select('session_token_hash')
      .eq('torn_player_id', playerId)
      .single();
    if (!secret?.session_token_hash) {
      return { ok: false, response: unauthorized() };
    }
    const submittedHash = await hashToken(body.session_token);
    if (!timingSafeEqual(submittedHash, secret.session_token_hash)) {
      return { ok: false, response: unauthorized() };
    }
    return { ok: true, player_id: playerId };
  }

  // PDA path — validate the raw key against Torn.
  if (
    typeof body.api_key === 'string' &&
    body.api_key.length >= 16 &&
    body.api_key.length <= 32
  ) {
    const tornRes = await fetch(
      `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(body.api_key)}`,
    );
    const tornData = await tornRes.json();
    if (tornData?.error) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            error: `Torn API rejected key: ${tornData.error.error}`,
            torn_code: tornData.error.code,
          }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        ),
      };
    }
    const playerId = Number(tornData?.player_id);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ error: 'Torn API returned no player_id' }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        ),
      };
    }
    return { ok: true, player_id: playerId };
  }

  return { ok: false, response: unauthorized() };
}

// Opaque 401 — never distinguish "unknown player" from "bad token" so probing
// with guessed player_ids reveals nothing.
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── Row validation ──────────────────────────────────────────────
// Per-row validation mirrors the migration 019/020 CHECK constraints so we
// reject bad rows with a clear error before Postgres does. Returns either a
// clean SellRow or a { skip } token with a reason the caller can surface.
function normalizeRow(raw: unknown): SellRow | { skip: string } {
  if (!raw || typeof raw !== 'object') return { skip: 'not an object' };
  const r = raw as Record<string, unknown>;

  const item_id = Number(r.item_id);
  if (!Number.isInteger(item_id) || item_id <= 0) {
    return { skip: `invalid item_id: ${r.item_id}` };
  }

  const priceRaw = r.price;
  const price =
    priceRaw === null || priceRaw === undefined ? null : Number(priceRaw);
  if (price !== null && (!Number.isFinite(price) || price < 1 || price > 100_000_000_000)) {
    return { skip: `invalid price for ${item_id}: ${r.price}` };
  }

  // min_price = absolute cheapest listing (regardless of qty) — migration 020.
  // Feeds the Watchlist matcher. Same range as price.
  const minPriceRaw = r.min_price;
  const min_price =
    minPriceRaw === null || minPriceRaw === undefined ? null : Number(minPriceRaw);
  if (min_price !== null && (!Number.isFinite(min_price) || min_price < 1 || min_price > 100_000_000_000)) {
    return { skip: `invalid min_price for ${item_id}: ${r.min_price}` };
  }

  const floorRaw = r.floor_qty;
  const floor_qty =
    floorRaw === null || floorRaw === undefined ? null : Number(floorRaw);
  if (floor_qty !== null && (!Number.isInteger(floor_qty) || floor_qty < 1 || floor_qty > 100_000)) {
    return { skip: `invalid floor_qty for ${item_id}: ${r.floor_qty}` };
  }

  const lcRaw = r.listing_count;
  const listing_count =
    lcRaw === null || lcRaw === undefined ? null : Number(lcRaw);
  if (listing_count !== null && (!Number.isInteger(listing_count) || listing_count < 0 || listing_count > 100_000)) {
    return { skip: `invalid listing_count for ${item_id}: ${r.listing_count}` };
  }

  return { item_id, price, min_price, floor_qty, listing_count };
}

// ── Handler ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return new Response(JSON.stringify({ error: 'Body must be a JSON object' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!Array.isArray(body.rows) || (body.rows as unknown[]).length === 0) {
      return new Response(JSON.stringify({ error: 'rows must be a non-empty array' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if ((body.rows as unknown[]).length > 200) {
      return new Response(JSON.stringify({ error: 'rows must be 200 or fewer' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const auth = await resolveObserver(body, supabase);
    if (!auth.ok) return auth.response;

    const normalized: Array<{
      item_id: number;
      price: number | null;
      min_price: number | null;
      floor_qty: number | null;
      listing_count: number | null;
      updated_at: string;
      observer_player_id: number;
    }> = [];
    const skipped: string[] = [];
    const updated_at = new Date().toISOString();

    for (const raw of body.rows as unknown[]) {
      const norm = normalizeRow(raw);
      if ('skip' in norm) {
        skipped.push(norm.skip);
        continue;
      }
      normalized.push({
        item_id: norm.item_id,
        price: norm.price,
        min_price: norm.min_price,
        floor_qty: norm.floor_qty,
        listing_count: norm.listing_count,
        updated_at,
        observer_player_id: auth.player_id,
      });
    }

    if (normalized.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: 'No valid rows in payload', skipped }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { error: upsertErr } = await supabase
      .from('sell_prices')
      .upsert(normalized, { onConflict: 'item_id' });

    if (upsertErr) {
      return new Response(
        JSON.stringify({ error: `Upsert failed: ${upsertErr.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        observer_player_id: auth.player_id,
        stored: normalized.length,
        skipped: skipped.length,
        skipped_reasons: skipped,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `ingest-sell-prices error: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
