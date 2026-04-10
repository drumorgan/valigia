import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { decryptApiKey } from '../_shared/crypto.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { section, id, selections, key, player_id, log, from } =
      await req.json();

    if (!section || !selections) {
      return new Response(
        JSON.stringify({
          error: { code: 0, error: 'Missing required fields: section, selections' },
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Resolve API key: use provided key, or decrypt stored key from player_id
    let apiKey = key;

    if (!apiKey && player_id) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      const { data: secret } = await supabase
        .from('player_secrets')
        .select('api_key_enc, api_key_iv, key_version')
        .eq('torn_player_id', player_id)
        .single();

      if (!secret?.api_key_enc || !secret?.api_key_iv) {
        return new Response(
          JSON.stringify({
            error: { code: 0, error: 'No stored API key. Please log in again.' },
          }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      apiKey = await decryptApiKey(
        secret.api_key_enc,
        secret.api_key_iv,
        secret.key_version
      );

      // Audit
      await supabase.from('secret_audit_log').insert({
        torn_player_id: player_id,
        action: 'decrypt_used',
        edge_function: 'torn-proxy',
      });
    }

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: { code: 0, error: 'Missing key or player_id' },
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build Torn API URL
    const idSegment = id ? `/${id}` : '';
    let url = `https://api.torn.com/${section}${idSegment}?selections=${selections}&key=${apiKey}`;
    if (log) url += `&log=${log}`;
    if (from) url += `&from=${from}`;

    const tornRes = await fetch(url);
    const data = await tornRes.json();

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: { code: 0, error: `Proxy error: ${err.message}` },
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
