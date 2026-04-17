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
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// ── Types ───────────────────────────────────────────────────────
interface BazaarRow {
  item_id: number;
  bazaar_owner_id: number;
  price: number | null;
  quantity: number | null;
  miss_count: number;
  checked_at: string | null;
}

// ── Auth: dual-path observer resolution ─────────────────────────
// Same shape as ingest-sell-prices; see that file for the rationale. We
// duplicate rather than share because Supabase Edge Functions package each
// function independently and the existing codebase inlines helpers into
// every function (see auto-login, torn-proxy, ingest-travel-shop).
async function resolveObserver(
  body: Record<string, unknown>,
  supabase: SupabaseClient,
): Promise<{ ok: true; player_id: number } | { ok: false; response: Response }> {
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

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── Row validation ──────────────────────────────────────────────
// Ranges match migration 019's CHECK constraints. price/quantity accept null
// because the scanner writes null rows for "checked this bazaar, item wasn't
// there — bump miss_count" — see bazaar-scanner.js upsert of toIncrement.
function normalizeRow(raw: unknown): BazaarRow | { skip: string } {
  if (!raw || typeof raw !== 'object') return { skip: 'not an object' };
  const r = raw as Record<string, unknown>;

  const item_id = Number(r.item_id);
  if (!Number.isInteger(item_id) || item_id <= 0) {
    return { skip: `invalid item_id: ${r.item_id}` };
  }

  const bazaar_owner_id = Number(r.bazaar_owner_id);
  if (!Number.isInteger(bazaar_owner_id) || bazaar_owner_id <= 0) {
    return { skip: `invalid bazaar_owner_id for ${item_id}: ${r.bazaar_owner_id}` };
  }

  const priceRaw = r.price;
  const price = priceRaw === null || priceRaw === undefined ? null : Number(priceRaw);
  if (price !== null && (!Number.isFinite(price) || price < 1 || price > 100_000_000_000)) {
    return { skip: `invalid price for ${item_id}@${bazaar_owner_id}: ${r.price}` };
  }

  const qRaw = r.quantity;
  const quantity = qRaw === null || qRaw === undefined ? null : Number(qRaw);
  if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000)) {
    return { skip: `invalid quantity for ${item_id}@${bazaar_owner_id}: ${r.quantity}` };
  }

  // miss_count is always provided by both callers (0 on hit, prev+1 on miss).
  // Range matches the CHECK in migration 019 (0..10); the scanner caps at 3.
  const miss_count = Number(r.miss_count ?? 0);
  if (!Number.isInteger(miss_count) || miss_count < 0 || miss_count > 10) {
    return { skip: `invalid miss_count for ${item_id}@${bazaar_owner_id}: ${r.miss_count}` };
  }

  // Optional client-provided checked_at. The scanner's Phase-2 discovery
  // seeds new bazaars with epoch (1970) so they sort to the top of the
  // least-recently-checked rotation and get checked next scan. Without
  // accepting this, server-side now() would stamp them "fresh" and they'd
  // never be prioritized. Allow any valid ISO timestamp; abuse potential
  // is bounded (past = earlier re-check, future = forever "fresh" but
  // still subject to miss_count pruning).
  let checked_at: string | null = null;
  if (r.checked_at != null) {
    if (typeof r.checked_at !== 'string') {
      return { skip: `invalid checked_at for ${item_id}@${bazaar_owner_id}: ${r.checked_at}` };
    }
    const parsed = Date.parse(r.checked_at);
    if (!Number.isFinite(parsed)) {
      return { skip: `unparseable checked_at for ${item_id}@${bazaar_owner_id}: ${r.checked_at}` };
    }
    checked_at = new Date(parsed).toISOString();
  }

  return { item_id, bazaar_owner_id, price, quantity, miss_count, checked_at };
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
    if ((body.rows as unknown[]).length > 500) {
      return new Response(JSON.stringify({ error: 'rows must be 500 or fewer' }), {
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
      bazaar_owner_id: number;
      price: number | null;
      quantity: number | null;
      miss_count: number;
      checked_at: string;
      observer_player_id: number;
    }> = [];
    const skipped: string[] = [];
    const serverNow = new Date().toISOString();

    for (const raw of body.rows as unknown[]) {
      const norm = normalizeRow(raw);
      if ('skip' in norm) {
        skipped.push(norm.skip);
        continue;
      }
      normalized.push({
        item_id: norm.item_id,
        bazaar_owner_id: norm.bazaar_owner_id,
        price: norm.price,
        quantity: norm.quantity,
        miss_count: norm.miss_count,
        checked_at: norm.checked_at ?? serverNow,
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
      .from('bazaar_prices')
      .upsert(normalized, { onConflict: 'item_id,bazaar_owner_id' });

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
      JSON.stringify({ error: `ingest-bazaar-prices error: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
