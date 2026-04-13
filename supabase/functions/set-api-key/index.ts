import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ── Inlined shared: CORS ────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Inlined shared: AES-256-GCM encrypt ─────────────────────────
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function importKey(rawB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(rawB64), { name: 'AES-GCM' }, false, ['encrypt']);
}
async function encryptApiKey(plaintext: string, keyVersion = 1) {
  const rawKey = Deno.env.get('API_KEY_ENCRYPTION_KEY');
  if (!rawKey) throw new Error('Missing API_KEY_ENCRYPTION_KEY env var');
  const key = await importKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv), keyVersion };
}

// ── Session token mint + hash ───────────────────────────────────
// 32 random bytes, base64url for a URL-safe opaque token. The client stores
// this alongside player_id; we only store its SHA-256 hash in the row.
async function mintSessionToken(): Promise<{ token: string; hash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(raw);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = bytesToBase64(new Uint8Array(digest));
  return { token, hash };
}

// ── Handler ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { player_id, api_key } = await req.json();

    if (!player_id || !api_key) {
      return new Response(
        JSON.stringify({ error: 'Missing player_id or api_key' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Encrypt the API key
    const { ciphertext, iv, keyVersion } = await encryptApiKey(api_key);

    // Mint a fresh session token on every set-api-key call. Re-entering a key
    // intentionally logs out any other device with the previous token — this
    // is the rotation hook; a stolen player_id alone is no longer enough.
    const { token: sessionToken, hash: sessionTokenHash } = await mintSessionToken();

    // Store encrypted key + token hash in player_secrets
    const { error: secretErr } = await supabase
      .from('player_secrets')
      .upsert(
        {
          torn_player_id: player_id,
          api_key_enc: ciphertext,
          api_key_iv: iv,
          key_version: keyVersion,
          session_token_hash: sessionTokenHash,
          session_token_created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'torn_player_id' }
      );

    if (secretErr) {
      return new Response(
        JSON.stringify({ error: `Secret storage failed: ${secretErr.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Return the raw token ONCE. Client stores it in localStorage and sends
    // it back on every auto-login. The token itself is never logged or
    // persisted server-side (only its hash is).
    return new Response(
      JSON.stringify({ success: true, session_token: sessionToken }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `set-api-key error: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
