import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ── Inlined shared: CORS ────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Types ───────────────────────────────────────────────────────
type PageType = 'travel' | 'item_market' | 'bazaar';
interface ActivityPayload {
  api_key: string;
  page_type: PageType;
}

const ALLOWED_PAGE_TYPES: readonly PageType[] = ['travel', 'item_market', 'bazaar'];

// ── Input validation ────────────────────────────────────────────
function validatePayload(
  body: unknown,
): { ok: true; data: ActivityPayload } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;

  if (typeof b.api_key !== 'string' || b.api_key.length < 16 || b.api_key.length > 32) {
    return { ok: false, error: 'api_key must be a 16–32 char string' };
  }
  if (typeof b.page_type !== 'string' || !ALLOWED_PAGE_TYPES.includes(b.page_type as PageType)) {
    return { ok: false, error: `page_type must be one of: ${ALLOWED_PAGE_TYPES.join(', ')}` };
  }
  return { ok: true, data: b as unknown as ActivityPayload };
}

// ── Handler ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => null);
    const parsed = validatePayload(body);
    if (!parsed.ok) {
      return new Response(JSON.stringify({ error: parsed.error }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { api_key, page_type } = parsed.data;

    // Step 1 — validate the key and resolve player_id via user/basic.
    // Same trust surface as ingest-travel-shop: every row written here
    // carries a Torn-verified player_id, keeping the scout count honest.
    // The key itself is never persisted.
    const tornRes = await fetch(
      `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(api_key)}`,
    );
    const tornData = await tornRes.json();
    if (tornData?.error) {
      return new Response(
        JSON.stringify({
          error: `Torn API rejected key: ${tornData.error.error}`,
          torn_code: tornData.error.code,
        }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const player_id = Number(tornData?.player_id);
    if (!Number.isInteger(player_id) || player_id <= 0) {
      return new Response(JSON.stringify({ error: 'Torn API returned no player_id' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { error: insertErr } = await supabase
      .from('pda_activity')
      .insert({ player_id, page_type });

    if (insertErr) {
      return new Response(
        JSON.stringify({ error: `Insert failed: ${insertErr.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ ok: true, player_id, page_type }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `record-pda-activity error: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
