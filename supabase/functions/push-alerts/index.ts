import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// push-alerts — session-gated CRUD for Web Push departure alerts.
//
// Owns all writes to two tables:
//   push_subscriptions — browser push endpoints + encryption keys. These
//     are bearer credentials for messaging the device, so the table has
//     no anon policies and every write funnels through here.
//   departure_alerts — per-player per-shelf "leave in X" configs the
//     cron-send-alerts sender evaluates every 5 minutes.
//
// Auth mirrors the watchlist edge function exactly: player_id +
// session_token hashed and constant-time compared against
// player_secrets.session_token_hash. Same opaque 401 on any failure.
//
// Actions:
//   subscribe          { subscription: { endpoint, keys: { p256dh, auth } } }
//   unsubscribe        { endpoint }
//   add_alert          { item_id, item_name, destination, lead_mins }
//   remove_alert       { item_id, destination }
//   list_alerts        {}
//   status             {}   → { subscribed: boolean, alert_count }

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
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
const unauthorized = () => json({ success: false, error: 'unauthorized' }, 401);
const badRequest = (error: string) => json({ success: false, error }, 400);

const MAX_ALERTS_PER_PLAYER = 20;
const MAX_SUBSCRIPTIONS_PER_PLAYER = 5;
// Longest sane lead: UAE/SA/Japan flights run ~3.5 h one-way even without
// perks; 12 h leaves generous headroom for any future flight-time change.
const MAX_LEAD_MINS = 12 * 60;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // deno-lint-ignore no-explicit-any
    const body = (await req.json()) as any;
    const action = body?.action;
    if (!action) return unauthorized();

    // ── Auth: web session only. No PDA path — push subscription happens
    // in the installed PWA, which always holds a session token. ──
    const pid = Number(body.player_id);
    const sessionToken = body.session_token;
    if (!Number.isInteger(pid) || pid <= 0 || typeof sessionToken !== 'string') {
      return unauthorized();
    }
    const { data: secret } = await supabase
      .from('player_secrets')
      .select('session_token_hash')
      .eq('torn_player_id', pid)
      .single();
    if (!secret?.session_token_hash) return unauthorized();
    const submittedHash = await hashToken(sessionToken);
    if (!timingSafeEqual(submittedHash, secret.session_token_hash)) return unauthorized();
    const player_id = pid;

    // ── Dispatch ──
    if (action === 'subscribe') {
      const sub = body.subscription;
      const endpoint = sub?.endpoint;
      const p256dh = sub?.keys?.p256dh;
      const auth = sub?.keys?.auth;
      if (
        typeof endpoint !== 'string' || !endpoint.startsWith('https://') ||
        endpoint.length > 2048 ||
        typeof p256dh !== 'string' || p256dh.length > 256 ||
        typeof auth !== 'string' || auth.length > 128
      ) {
        return badRequest('invalid_subscription');
      }

      // Cap devices per player. Upserting an existing endpoint (browser
      // re-subscribed with the same endpoint) doesn't count as new.
      const { count } = await supabase
        .from('push_subscriptions')
        .select('endpoint', { count: 'exact', head: true })
        .eq('player_id', player_id)
        .neq('endpoint', endpoint);
      if ((count ?? 0) >= MAX_SUBSCRIPTIONS_PER_PLAYER) {
        return badRequest('too_many_subscriptions');
      }

      const { error } = await supabase
        .from('push_subscriptions')
        .upsert(
          { endpoint, player_id, p256dh, auth, fail_count: 0 },
          { onConflict: 'endpoint' },
        );
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }

    if (action === 'unsubscribe') {
      const endpoint = body.endpoint;
      if (typeof endpoint !== 'string') return badRequest('invalid_endpoint');
      // Scoped to the caller's own rows so one player can't evict another's
      // device by guessing endpoints.
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint)
        .eq('player_id', player_id);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }

    if (action === 'add_alert') {
      const item_id = Number(body.item_id);
      const item_name = String(body.item_name ?? '').slice(0, 80);
      const destination = String(body.destination ?? '').slice(0, 40);
      const lead_mins = Number(body.lead_mins);
      if (!Number.isInteger(item_id) || item_id <= 0) return badRequest('invalid_item_id');
      if (!item_name) return badRequest('invalid_item_name');
      if (!destination) return badRequest('invalid_destination');
      if (!Number.isInteger(lead_mins) || lead_mins <= 0 || lead_mins > MAX_LEAD_MINS) {
        return badRequest('invalid_lead_mins');
      }

      const { count } = await supabase
        .from('departure_alerts')
        .select('item_id', { count: 'exact', head: true })
        .eq('player_id', player_id);
      if ((count ?? 0) >= MAX_ALERTS_PER_PLAYER) return badRequest('too_many_alerts');

      const { error } = await supabase
        .from('departure_alerts')
        .upsert(
          {
            player_id, item_id, item_name, destination, lead_mins,
            active: true,
            // Re-adding an alert re-arms it: clear the dedupe stamp so the
            // next predicted restock fires even if the previous config
            // already notified for it.
            last_notified_restock_at: null,
          },
          { onConflict: 'player_id,item_id,destination' },
        );
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }

    if (action === 'remove_alert') {
      const item_id = Number(body.item_id);
      const destination = String(body.destination ?? '');
      if (!Number.isInteger(item_id) || item_id <= 0 || !destination) {
        return badRequest('invalid_alert_key');
      }
      const { error } = await supabase
        .from('departure_alerts')
        .delete()
        .eq('player_id', player_id)
        .eq('item_id', item_id)
        .eq('destination', destination);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }

    if (action === 'list_alerts') {
      const { data, error } = await supabase
        .from('departure_alerts')
        .select('item_id, item_name, destination, lead_mins, active, created_at')
        .eq('player_id', player_id)
        .order('created_at', { ascending: false });
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, alerts: data ?? [] });
    }

    if (action === 'status') {
      const [{ count: subCount }, { count: alertCount }] = await Promise.all([
        supabase
          .from('push_subscriptions')
          .select('endpoint', { count: 'exact', head: true })
          .eq('player_id', player_id),
        supabase
          .from('departure_alerts')
          .select('item_id', { count: 'exact', head: true })
          .eq('player_id', player_id),
      ]);
      return json({
        success: true,
        subscribed: (subCount ?? 0) > 0,
        subscription_count: subCount ?? 0,
        alert_count: alertCount ?? 0,
      });
    }

    return badRequest('unknown_action');
  } catch (err) {
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
