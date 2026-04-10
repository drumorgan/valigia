import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { encryptApiKey } from '../_shared/crypto.ts';

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

    // Store encrypted key in player_secrets
    const { error: secretErr } = await supabase
      .from('player_secrets')
      .upsert(
        {
          torn_player_id: player_id,
          api_key_enc: ciphertext,
          api_key_iv: iv,
          key_version: keyVersion,
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

    // Audit log
    await supabase.from('secret_audit_log').insert({
      torn_player_id: player_id,
      action: 'set',
      edge_function: 'set-api-key',
    });

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `set-api-key error: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
