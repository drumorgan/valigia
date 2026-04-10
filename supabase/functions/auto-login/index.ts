import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { decryptApiKey } from '../_shared/crypto.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { player_id } = await req.json();

    if (!player_id) {
      return new Response(
        JSON.stringify({ success: false, error: 'missing_player_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Retrieve encrypted key
    const { data: secret } = await supabase
      .from('player_secrets')
      .select('api_key_enc, api_key_iv, key_version')
      .eq('torn_player_id', player_id)
      .single();

    if (!secret?.api_key_enc || !secret?.api_key_iv) {
      return new Response(
        JSON.stringify({ success: false, error: 'no_stored_key' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Decrypt
    const apiKey = await decryptApiKey(
      secret.api_key_enc,
      secret.api_key_iv,
      secret.key_version
    );

    // Validate against Torn API
    const tornRes = await fetch(
      `https://api.torn.com/user/?selections=basic&key=${apiKey}`
    );
    const tornData = await tornRes.json();

    if (tornData.error) {
      // Key is invalid — clear stored secret
      await supabase
        .from('player_secrets')
        .delete()
        .eq('torn_player_id', player_id);

      await supabase.from('secret_audit_log').insert({
        torn_player_id: player_id,
        action: 'invalidated',
        edge_function: 'auto-login',
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: 'key_invalid',
          torn_error: tornData.error.code,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Audit the successful decryption
    await supabase.from('secret_audit_log').insert({
      torn_player_id: player_id,
      action: 'decrypt_used',
      edge_function: 'auto-login',
    });

    return new Response(
      JSON.stringify({
        success: true,
        player_id: tornData.player_id,
        name: tornData.name,
        level: tornData.level,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: `auto-login error: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
