import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ── Shared: CORS ────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Session token verification ──────────────────────────────────
// Mirrors auto-login: stored hash is base64(SHA-256(token)). We re-hash the
// submitted token and constant-time compare.
function base64FromBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return base64FromBytes(new Uint8Array(digest));
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
function unauthorized() {
  return json({ success: false, error: 'unauthorized' }, 401);
}
function badRequest(error: string) {
  return json({ success: false, error }, 400);
}

// The three venues we currently know how to match against. Keep in sync
// with src/watchlist.js.
const ALLOWED_VENUES = new Set(['market', 'bazaar', 'abroad']);
const MAX_ALERTS_PER_PLAYER = 50;

type AuthFields = {
  // Web path: player_id + session_token (validated against player_secrets).
  player_id?: number;
  session_token?: string;
  // PDA path: a raw Torn API key, validated against user/basic to derive
  // player_id server-side (same trust model as ingest-travel-shop). The
  // userscript holds the key but has no Valigia session token.
  api_key?: string;
};
type UpsertBody = AuthFields & {
  action: 'upsert';
  item_id: number;
  max_price: number;
  venues?: string[];
};
type DeleteBody = AuthFields & {
  action: 'delete';
  item_id: number;
};
type ListBody = AuthFields & {
  action: 'list';
};
type Body = UpsertBody | DeleteBody | ListBody;

// ── Handler ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = (await req.json()) as Body;
    const { action } = body;
    if (!action) return unauthorized();

    // Resolve player_id from one of two auth methods. Both end in the same
    // opaque 401 on any failure so probing can't distinguish "unknown
    // player" from "wrong credential".
    let player_id: number;
    if (body.api_key) {
      // PDA path: validate the Torn key and derive player_id from it, the
      // way ingest-travel-shop attributes its writes. The key round-trip
      // is itself the rate gate (Torn caps at 100 req/min/key).
      const apiKey = String(body.api_key);
      if (apiKey.length < 16 || apiKey.length > 32) return unauthorized();
      let tornData: { player_id?: number; error?: unknown } | null = null;
      try {
        const tornRes = await fetch(
          `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(apiKey)}`,
        );
        tornData = await tornRes.json();
      } catch {
        return unauthorized();
      }
      if (!tornData || tornData.error) return unauthorized();
      player_id = Number(tornData.player_id);
      if (!Number.isInteger(player_id) || player_id <= 0) return unauthorized();
    } else {
      // Web path: player_id + session_token, hashed and compared to the
      // stored hash exactly as auto-login does.
      const { player_id: pid, session_token } = body;
      if (!pid || !session_token || typeof session_token !== 'string') {
        return unauthorized();
      }
      const { data: secret } = await supabase
        .from('player_secrets')
        .select('session_token_hash')
        .eq('torn_player_id', pid)
        .single();
      if (!secret?.session_token_hash) return unauthorized();
      const submittedHash = await hashToken(session_token);
      if (!timingSafeEqual(submittedHash, secret.session_token_hash)) return unauthorized();
      player_id = pid;
    }

    // --- Authorised. Dispatch by action. ---
    if (action === 'list') {
      const { data, error } = await supabase
        .from('watchlist_alerts')
        .select('item_id, max_price, venues, created_at')
        .eq('player_id', player_id)
        .order('created_at', { ascending: false });
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, alerts: data ?? [] });
    }

    if (action === 'upsert') {
      const { item_id, max_price, venues } = body as UpsertBody;
      if (!Number.isInteger(item_id) || item_id <= 0) return badRequest('invalid_item_id');
      if (!Number.isFinite(max_price) || max_price <= 0) return badRequest('invalid_max_price');
      // Sanity cap: $1 quadrillion — comfortably under bigint range, far above
      // any realistic Torn item price (top-tier items list in the hundreds of
      // billions). Filters out garbage client input without constraining real use.
      if (max_price > 1_000_000_000_000_000) return badRequest('invalid_max_price');

      const cleanVenues = Array.isArray(venues)
        ? [...new Set(venues.filter((v) => ALLOWED_VENUES.has(v)))]
        : ['market', 'bazaar', 'abroad'];
      if (cleanVenues.length === 0) return badRequest('invalid_venues');

      // Enforce per-player alert cap so a single player can't balloon the
      // table. Checked only on insert path: if the row already exists we're
      // just updating it.
      const { data: existing } = await supabase
        .from('watchlist_alerts')
        .select('item_id')
        .eq('player_id', player_id)
        .eq('item_id', item_id)
        .maybeSingle();
      if (!existing) {
        const { count } = await supabase
          .from('watchlist_alerts')
          .select('item_id', { count: 'exact', head: true })
          .eq('player_id', player_id);
        if ((count ?? 0) >= MAX_ALERTS_PER_PLAYER) return badRequest('alert_cap_reached');
      }

      const { error } = await supabase
        .from('watchlist_alerts')
        .upsert(
          {
            player_id,
            item_id,
            max_price: Math.round(max_price),
            venues: cleanVenues,
          },
          { onConflict: 'player_id,item_id' }
        );
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }

    if (action === 'delete') {
      const { item_id } = body as DeleteBody;
      if (!Number.isInteger(item_id) || item_id <= 0) return badRequest('invalid_item_id');
      const { error } = await supabase
        .from('watchlist_alerts')
        .delete()
        .eq('player_id', player_id)
        .eq('item_id', item_id);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }

    return badRequest('unknown_action');
  } catch (_err) {
    // Generic 401 — never echo exception details to the client. Stack traces
    // show up in Supabase function logs, which is the right place for them.
    return unauthorized();
  }
});
