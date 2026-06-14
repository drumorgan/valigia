import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// pda-prefs — authenticated writes to the pda_prefs table.
//
// The website's "PDA overlay" modal lets a player choose whether the
// userscript shows its visual indicators (bars / overlays / toasts) or
// runs silently while still contributing scrapes. Reads are public anon
// SELECTs (the userscript polls the row directly); only writes come
// through here.
//
// Two auth paths resolve the same player_id, mirroring the watchlist
// edge function:
//   • Web path  — player_id + session_token, hashed and compared to the
//     stored hash (the "PDA overlay" modal on valigia.girovagabondo.com).
//   • PDA path  — a raw Torn api_key, validated against user/basic so the
//     userscript's in-game "V" overlay toggle can flip the same flag
//     without ever holding a Valigia session token.

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
  // Web path.
  player_id?: number;
  session_token?: string;
  // PDA path: raw Torn key, validated against user/basic to derive player_id.
  api_key?: string;
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

    // Resolve player_id from one of two auth methods. Both end in the same
    // opaque 401 on any failure so probing can't distinguish "unknown
    // player" from "wrong credential".
    let player_id: number;
    if (body.api_key) {
      // PDA path: validate the Torn key and derive player_id from it, the
      // same trust model as ingest-travel-shop and the watchlist function.
      // The key round-trip is itself the rate gate (Torn caps at 100/min/key).
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
      // Web path: re-hash the submitted token and constant-time compare
      // against the stored hash, exactly as auto-login does.
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
