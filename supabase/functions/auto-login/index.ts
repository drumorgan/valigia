import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ── Inlined shared: CORS ────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Inlined shared: AES-256-GCM decrypt ─────────────────
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
async function importKey(rawB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(rawB64), { name: 'AES-GCM' }, false, ['decrypt']);
}
async function decryptApiKey(ciphertextB64: string, ivB64: string, _keyVersion = 1): Promise<string> {
  const rawKey = Deno.env.get('API_KEY_ENCRYPTION_KEY');
  if (!rawKey) throw new Error('Missing API_KEY_ENCRYPTION_KEY env var');
  const key = await importKey(rawKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ciphertextB64)
  );
  return new TextDecoder().decode(decrypted);
}

// ── Session token verification ───────────────────────
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64(new Uint8Array(digest));
}

// Constant-time string compare. Both strings are base64 SHA-256 digests
// (always 44 chars) — length-varying short-circuits would leak nothing
// meaningful here, but we do it anyway to keep the pattern right.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Every failure path returns the same opaque 401 so an attacker probing with
// guessed player_ids can't tell "unknown player" from "wrong token".
function unauthorized() {
  return new Response(
    JSON.stringify({ success: false, error: 'unauthorized' }),
    { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// ── Handler ──────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { player_id, session_token } = await req.json();

    // Both fields are required. player_id alone is a public identifier and
    // must not grant a session on its own.
    if (!player_id || !session_token || typeof session_token !== 'string') {
      return unauthorized();
    }

    // Retrieve encrypted key + stored token hash
    const { data: secret } = await supabase
      .from('player_secrets')
      .select('api_key_enc, api_key_iv, key_version, session_token_hash')
      .eq('torn_player_id', player_id)
      .single();

    // No row, no encrypted key, or no token set → unauthorized. Do NOT leak
    // which of those it was; do NOT fall back to the pre-token code path.
    if (!secret?.api_key_enc || !secret?.api_key_iv || !secret?.session_token_hash) {
      return unauthorized();
    }

    // Constant-time compare the submitted token's hash against the stored
    // hash. Only on match do we proceed to decrypt and hit the Torn API.
    const submittedHash = await hashToken(session_token);
    if (!timingSafeEqual(submittedHash, secret.session_token_hash)) {
      return unauthorized();
    }

    // Decrypt
    const apiKey = await decryptApiKey(
      secret.api_key_enc,
      secret.api_key_iv,
      secret.key_version
    );

    // Validate against Torn API. If the fetch itself fails (network / DNS /
    // Torn side timeout) treat it as transient — the stored row is still
    // good, just tell the client to retry on the next page load.
    let tornData: any;
    try {
      const tornRes = await fetch(
        `https://api.torn.com/user/?selections=basic&key=${apiKey}`
      );
      tornData = await tornRes.json();
    } catch (err) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'torn_unavailable',
          detail: (err as Error).message,
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (tornData.error) {
      // Torn error codes that mean the key itself is permanently dead:
      //   2  = Incorrect Key (revoked / deleted)
      //   16 = Access level of this key is not high enough
      // Everything else (5 rate limit, 8 IP block, 9 API disabled, 13 inactive,
      // 14 daily cap, 17 backend error, 18 paused) is temporary — the key will
      // work again once the condition clears, so we must NOT nuke the row.
      const PERMANENT_TORN_ERRORS = [2, 16];
      const code = tornData.error?.code;

      if (PERMANENT_TORN_ERRORS.includes(code)) {
        await supabase
          .from('player_secrets')
          .delete()
          .eq('torn_player_id', player_id);

        return new Response(
          JSON.stringify({
            success: false,
            error: 'key_invalid',
            torn_error: code,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Transient Torn failure — leave the encrypted row in place. The
      // client keeps its session and retries on the next page load.
      return new Response(
        JSON.stringify({
          success: false,
          error: 'torn_unavailable',
          torn_error: code,
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        player_id: tornData.player_id,
        name: tornData.name,
        level: tornData.level,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (_err) {
    // Don't echo err.message — it can reveal shape of the request. Generic
    // error for the client; details stay in Supabase function logs.
    return unauthorized();
  }
});
