import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// pda-prefs — session-gated writes to the pda_prefs table.
//
// The website's "PDA overlay" modal lets a player choose whether the
// userscript shows its visual indicators (bars / overlays / toasts) or
// runs silently while still contributing scrapes. Reads are public anon
// SELECTs (the userscript polls the row directly); only writes come
// through here, validated against player_secrets exactly like the
// watchlist edge function.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

type Body = {
  action: 'set';
  player_id: number;
  session_token: string;
  show_indicators: boolean;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = (await req.json()) as Body;
    if (body.action !== 'set') return json({ success: false, error: 'unknown_action' }, 400);
    if (typeof body.show_indicators !== 'boolean') {
      return json({ success: false, error: 'invalid_show_indicators' }, 400);
    }

    // Same web-session auth as the watchlist edge function: re-hash the
    // submitted token and constant-time compare against the stored hash.
    // Opaque 401 on every failure mode so probing can't distinguish
    // "unknown player" from "wrong credential".
    const { player_id, session_token } = body;
    if (!player_id || !session_token || typeof session_token !== 'string') {
      return unauthorized();
    }
    const { data: secret } = await supabase
      .from('player_secrets')
      .select('session_token_hash')
      .eq('torn_player_id', player_id)
      .single();
    if (!secret?.session_token_hash) return unauthorized();
    const submittedHash = await hashToken(session_token);
    if (!timingSafeEqual(submittedHash, secret.session_token_hash)) return unauthorized();

    const { error } = await supabase
      .from('pda_prefs')
      .upsert(
        {
          player_id,
          show_indicators: body.show_indicators,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'player_id' }
      );
    if (error) return json({ success: false, error: error.message }, 500);
    return json({ success: true });
  } catch (_err) {
    // Generic 401 — never echo exception details to the client. Stack
    // traces land in Supabase function logs, the right place for them.
    return unauthorized();
  }
});
