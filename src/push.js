// Web Push departure alerts — client data layer.
//
// Flow: the user installs Valigia to the iPad Home Screen (iOS only
// exposes Web Push to installed PWAs, 16.4+), taps "Enable alerts" in the
// Watchlist tab, and then taps any "leave in ~Xm" hint on the Travel
// table to arm a departure alert for that shelf. Every 5 minutes the
// cron-send-alerts edge function recomputes the shelf's restock
// prediction server-side and pushes "Leave for Japan now" when the
// leave-by moment arrives — with the tab closed.
//
// All writes go through the session-gated `push-alerts` edge function
// (same trust model as the watchlist): push endpoints are bearer
// credentials for messaging the device, so the table has no anon
// policies and this module never touches it directly.

import { supabaseUrl, supabaseAnonKey } from './supabase.js';
import { getSession } from './auth.js';

const PUSH_FN_URL = `${supabaseUrl}/functions/v1/push-alerts`;

// Public half of the VAPID keypair. Safe to ship — the push service uses
// it to verify that sends were signed by the matching PRIVATE key, which
// lives only in the edge function's secrets.
export const VAPID_PUBLIC_KEY =
  'BMfofvYRLp7_P3sLzdtGJT5juQRtt8ULM09_bTLWkJazQKVvNC_wJk7njfHldm5IwymhrUEdqC2SZVixlz67Vz8';

// Shopping buffer added on top of the flight time when arming an alert:
// leave a couple of minutes to actually open Torn and hit the airport.
export const LEAVE_BUFFER_MINS = 2;

/** Browser exposes the full push stack? (On iOS: only inside an installed PWA.) */
export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Running as an installed Home-Screen app? */
export function isStandalone() {
  return (
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true
  );
}

/**
 * Register the push-only service worker. Safe to call on every load —
 * the browser dedupes registrations. Never throws; returns the
 * registration or null.
 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function callPushFn(action, extras = {}) {
  const session = getSession();
  if (!session) return { success: false, error: 'not_logged_in' };
  try {
    const res = await fetch(PUSH_FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({
        action,
        player_id: session.player_id,
        session_token: session.session_token,
        ...extras,
      }),
    });
    return await res.json();
  } catch (e) {
    return { success: false, error: e?.message || 'network_error' };
  }
}

/**
 * Full enable flow: permission prompt → push subscription → store it
 * server-side. Must be called from a user gesture (iOS requirement).
 * Returns { success, error? } with user-presentable error codes:
 *   'unsupported' | 'not_standalone' | 'permission_denied' | edge fn errors
 */
export async function enablePush() {
  if (!pushSupported()) {
    return { success: false, error: isStandalone() ? 'unsupported' : 'not_standalone' };
  }
  const reg = await registerServiceWorker();
  if (!reg) return { success: false, error: 'sw_failed' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { success: false, error: 'permission_denied' };

  let sub;
  try {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  } catch (e) {
    return { success: false, error: e?.message || 'subscribe_failed' };
  }

  return callPushFn('subscribe', { subscription: sub.toJSON() });
}

/** Tear down this device's subscription (browser + server). */
export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/sw.js');
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      await callPushFn('unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
  } catch {
    // Best-effort; a dangling server row dies via fail_count pruning.
  }
  return { success: true };
}

/** Is THIS device currently push-subscribed (browser-side check)? */
export async function isSubscribed() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/sw.js');
    const sub = await reg?.pushManager?.getSubscription();
    return !!sub;
  } catch {
    return false;
  }
}

export function addDepartureAlert({ itemId, itemName, destination, leadMins }) {
  return callPushFn('add_alert', {
    item_id: Number(itemId),
    item_name: String(itemName),
    destination: String(destination),
    lead_mins: Math.max(1, Math.round(leadMins)),
  });
}

export function removeDepartureAlert({ itemId, destination }) {
  return callPushFn('remove_alert', {
    item_id: Number(itemId),
    destination: String(destination),
  });
}

export async function listDepartureAlerts() {
  const res = await callPushFn('list_alerts');
  return res?.success ? res.alerts : [];
}

export function pushStatus() {
  return callPushFn('status');
}
