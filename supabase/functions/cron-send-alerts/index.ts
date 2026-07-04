import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import webpush from 'npm:web-push@3.6.7';
import {
  estimateNextRestock,
  estimateHalfSelloutRestock,
} from '../_shared/forecast-math.js';

// cron-send-alerts
//
// Triggered every 5 min by pg_cron + pg_net (migration 044). Evaluates
// every active departure_alert against a fresh server-side restock
// prediction (same v3 math as the browser, imported from the
// _shared/forecast-math.js mirror) and Web-Pushes "Leave for <dest> now"
// to each of the player's subscribed devices when the leave-by moment
// falls inside the current window.
//
// Fire condition per alert:
//   predictedAt = now + timeToNextMins   (tick-snapped by the estimator)
//   leaveAt     = predictedAt − lead_mins
//   fire iff  −LATE_GRACE ≤ (leaveAt − now) ≤ CRON_PERIOD
// i.e. the leave-by moment is due within this cron window, with a small
// grace for a tick of cron jitter. Predictions with uncertainty over
// MAX_UNCERTAINTY_MINS are skipped — the same honesty gate the web UI
// applies before rendering "leave in Xm" copy.
//
// Dedupe: last_notified_restock_at stores the predicted refill time the
// last push was sent for; a new prediction within DEDUPE_WINDOW_MINS of
// it is the same physical restock re-observed, not a new event.
//
// Subscription hygiene: 404/410 from the push service means the browser
// dropped the subscription — delete the row. Other failures bump
// fail_count; rows die at MAX_FAILS so a permanently broken endpoint
// doesn't burn sends forever.

const corsJson = { 'Content-Type': 'application/json' };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsJson });
}

const CRON_PERIOD_MINS = 5;
const LATE_GRACE_MINS = 5;
const MAX_UNCERTAINTY_MINS = 45; // mirrors ui.js MAX_UNCERTAINTY_MINS
const DEDUPE_WINDOW_MINS = 20;
const MAX_FAILS = 5;
const SNAPSHOT_WINDOW_MINS = 48 * 60;
const RESTOCK_WINDOW_MINS = 30 * 24 * 60;

interface AlertRow {
  player_id: number;
  item_id: number;
  item_name: string;
  destination: string;
  lead_mins: number;
  last_notified_restock_at: string | null;
}

function fmtTct(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} TCT`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret) return json({ error: 'cron_secret_not_configured' }, 500);
  if ((req.headers.get('authorization') || '') !== `Bearer ${cronSecret}`) {
    return json({ error: 'unauthorized' }, 401);
  }

  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@girovagabondo.com';
  if (!vapidPublic || !vapidPrivate) return json({ error: 'vapid_not_configured' }, 500);
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Load active alerts ──
  const { data: alerts, error: alertsErr } = await supabase
    .from('departure_alerts')
    .select('player_id, item_id, item_name, destination, lead_mins, last_notified_restock_at')
    .eq('active', true);
  if (alertsErr) return json({ error: 'alerts_read_failed', detail: alertsErr.message }, 500);
  if (!alerts || alerts.length === 0) return json({ ok: true, alerts: 0, fired: 0 });

  const shelves = new Map<string, { item_id: number; destination: string }>();
  for (const a of alerts as AlertRow[]) {
    shelves.set(`${a.item_id}|${a.destination}`, { item_id: a.item_id, destination: a.destination });
  }
  const itemIds = [...new Set([...shelves.values()].map((s) => s.item_id))];

  // ── Forecast inputs for the watched shelves ──
  const nowMs = Date.now();
  const snapCutoff = new Date(nowMs - SNAPSHOT_WINDOW_MINS * 60_000).toISOString();
  const restockCutoff = new Date(nowMs - RESTOCK_WINDOW_MINS * 60_000).toISOString();
  const [snapRes, eventRes, latestRes] = await Promise.all([
    supabase
      .from('yata_snapshots')
      .select('item_id, destination, quantity, snapped_at')
      .in('item_id', itemIds)
      .gte('snapped_at', snapCutoff)
      .order('snapped_at', { ascending: true }),
    supabase
      .from('restock_events')
      .select('item_id, destination, restocked_at, pre_observed_at, post_qty')
      .in('item_id', itemIds)
      .gte('restocked_at', restockCutoff)
      .neq('source', 'backfill')
      .order('restocked_at', { ascending: true }),
    supabase.rpc('get_latest_yata_snapshots'),
  ]);

  const samplesByShelf = new Map<string, Array<{ quantity: number; snappedAt: number }>>();
  for (const r of snapRes.data ?? []) {
    const key = `${r.item_id}|${r.destination}`;
    if (!shelves.has(key)) continue;
    if (!samplesByShelf.has(key)) samplesByShelf.set(key, []);
    samplesByShelf.get(key)!.push({ quantity: r.quantity, snappedAt: new Date(r.snapped_at).getTime() });
  }
  const eventsByShelf = new Map<string, Array<{ atTime: number; preTime: number | null; postQty: number }>>();
  for (const r of eventRes.data ?? []) {
    const key = `${r.item_id}|${r.destination}`;
    if (!shelves.has(key)) continue;
    if (!eventsByShelf.has(key)) eventsByShelf.set(key, []);
    eventsByShelf.get(key)!.push({
      atTime: new Date(r.restocked_at).getTime(),
      preTime: r.pre_observed_at ? new Date(r.pre_observed_at).getTime() : null,
      postQty: r.post_qty,
    });
  }
  const nowQtyByShelf = new Map<string, number>();
  for (const r of latestRes.data ?? []) {
    nowQtyByShelf.set(`${r.item_id}|${r.destination}`, r.quantity);
  }

  // ── Predict per shelf ──
  const predictionByShelf = new Map<string, { predictedAtMs: number; uncertaintyMins: number; basis: string }>();
  for (const [key] of shelves) {
    const events = eventsByShelf.get(key) ?? [];
    const samples = samplesByShelf.get(key) ?? [];
    const nowQty = nowQtyByShelf.get(key) ?? null;
    const half = nowQty === 0 && samples.length >= 2 && events.length > 0
      ? estimateHalfSelloutRestock(samples, events, nowMs)
      : null;
    const est = half || estimateNextRestock(events, nowMs);
    if (!est) continue;
    if (est.uncertaintyMins > MAX_UNCERTAINTY_MINS) continue;
    predictionByShelf.set(key, {
      predictedAtMs: nowMs + est.timeToNextMins * 60_000,
      uncertaintyMins: est.uncertaintyMins,
      basis: half ? 'halftime' : 'cadence',
    });
  }

  // ── Evaluate alerts and send ──
  let fired = 0;
  let sent = 0;
  let pruned = 0;
  const subsByPlayer = new Map<number, Array<{ endpoint: string; p256dh: string; auth: string; fail_count: number }>>();

  for (const a of alerts as AlertRow[]) {
    const pred = predictionByShelf.get(`${a.item_id}|${a.destination}`);
    if (!pred) continue;

    const leaveDeltaMins = (pred.predictedAtMs - nowMs) / 60_000 - a.lead_mins;
    if (leaveDeltaMins > CRON_PERIOD_MINS || leaveDeltaMins < -LATE_GRACE_MINS) continue;

    // Same physical restock already notified?
    if (a.last_notified_restock_at) {
      const lastMs = new Date(a.last_notified_restock_at).getTime();
      if (Math.abs(lastMs - pred.predictedAtMs) < DEDUPE_WINDOW_MINS * 60_000) continue;
    }

    // Lazy-load this player's subscriptions (players can share shelves).
    if (!subsByPlayer.has(a.player_id)) {
      const { data } = await supabase
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth, fail_count')
        .eq('player_id', a.player_id);
      subsByPlayer.set(a.player_id, data ?? []);
    }
    const subs = subsByPlayer.get(a.player_id)!;
    if (subs.length === 0) continue;

    fired++;
    const leaveWord = leaveDeltaMins >= 1
      ? `in ~${Math.round(leaveDeltaMins)}m`
      : 'now';
    const payload = JSON.stringify({
      title: `Leave for ${a.destination} ${leaveWord}`,
      body: `${a.item_name} restock ~${fmtTct(pred.predictedAtMs)} (±${pred.uncertaintyMins}m, ${pred.basis}). ` +
        `Depart ${leaveWord} to land at the refill.`,
      url: 'https://valigia.girovagabondo.com/',
    });

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 15 * 60, urgency: 'high' },
        );
        sent++;
        await supabase
          .from('push_subscriptions')
          .update({ fail_count: 0, last_ok_at: new Date().toISOString() })
          .eq('endpoint', sub.endpoint);
      } catch (err) {
        // deno-lint-ignore no-explicit-any
        const status = (err as any)?.statusCode;
        if (status === 404 || status === 410 || sub.fail_count + 1 >= MAX_FAILS) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          pruned++;
        } else {
          await supabase
            .from('push_subscriptions')
            .update({ fail_count: sub.fail_count + 1 })
            .eq('endpoint', sub.endpoint);
        }
      }
    }

    await supabase
      .from('departure_alerts')
      .update({ last_notified_restock_at: new Date(pred.predictedAtMs).toISOString() })
      .eq('player_id', a.player_id)
      .eq('item_id', a.item_id)
      .eq('destination', a.destination);
  }

  return json({
    ok: true,
    alerts: alerts.length,
    shelves: shelves.size,
    predictions: predictionByShelf.size,
    fired,
    sent,
    pruned,
  });
});
