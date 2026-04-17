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

type UpsertBody = {
  action: 'upsert';
  player_id: number;
  session_token: string;
  item_id: number;
  max_price: number;
  venues?: string[];
};
type DeleteBody = {
  action: 'delete';
  player_id: number;
  session_token: string;
  item_id: number;
};
type ListBody = {
  action: 'list';
  player_id: number;
  session_token: string;
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
    const { action, player_id, session_token } = body;

    if (!action || !player_id || !session_token || typeof session_token !== 'string') {
      return unauthorized();
    }

    // Validate session token against player_secrets. Same shape as auto-login
    // — any failure returns the same opaque 401 so probing can't distinguish
    // "unknown player" from "wrong token".
    const { data: secret } = await supabase
      .from('player_secrets')
      .select('session_token_hash')
      .eq('torn_player_id', player_id)
      .single();
    if (!secret?.session_token_hash) return unauthorized();

    const submittedHash = await hashToken(session_token);
    if (!timingSafeEqual(submittedHash, secret.session_token_hash)) return unauthorized();

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
      // cap at 2^31-1 to be comfortably under bigint range and well over any
      // realistic Torn item price; mostly a sanity filter on bad client input.
      if (max_price > 2_147_483_647) return badRequest('invalid_max_price');

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
