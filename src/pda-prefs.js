// PDA preferences — controls the userscript's visual surfaces from the web.
//
// Storage: `pda_prefs` (migration 034). Same trust split as the watchlist:
// reads are public (the row holds nothing sensitive, and the userscript
// polls it with an anon SELECT), writes go through the `pda-prefs` edge
// function which validates {player_id, session_token} against
// player_secrets before a service-role upsert.
//
// One preference today: show_indicators. true (default) = the userscript
// paints its full UI; false = silent mode — every bar/overlay/toast is
// suppressed but all scraping keeps feeding the shared pool.

import { supabase, supabaseUrl, supabaseAnonKey } from './supabase.js';
import { getPlayerId } from './auth.js';
import { safeGetItem } from './storage.js';

const SESSION_STORAGE_KEY = 'valigia_session';
const PDA_PREFS_FN_URL = `${supabaseUrl}/functions/v1/pda-prefs`;

function getSessionToken() {
  const raw = safeGetItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.session_token || null;
  } catch {
    return null;
  }
}

/**
 * Read this player's show_indicators preference. Defaults to true on any
 * failure (no row yet, not logged in, network error) — "show" is the safe
 * fallback because it matches the userscript's own default.
 */
export async function getShowIndicators() {
  const playerId = getPlayerId();
  if (!playerId) return true;
  try {
    const { data } = await supabase
      .from('pda_prefs')
      .select('show_indicators')
      .eq('player_id', Number(playerId))
      .maybeSingle();
    return data ? data.show_indicators !== false : true;
  } catch {
    return true;
  }
}

/**
 * Persist the preference via the session-gated edge function.
 * Returns {success, error?} — never throws, so callers can wire it
 * straight into button handlers without leaving them stuck on "Saving…".
 */
export async function setShowIndicators(show) {
  return postPdaPrefs({ show_indicators: !!show });
}

/**
 * Read this player's synced travel capacity (the userscript-detected carry
 * max, shared via pda_prefs). Returns the integer slot count, or null when
 * there's no value yet (never detected, not logged in, or a read error) so
 * the caller can fall back to the perks estimate / localStorage default.
 */
export async function getTravelCapacity() {
  const playerId = getPlayerId();
  if (!playerId) return null;
  try {
    const { data } = await supabase
      .from('pda_prefs')
      .select('travel_capacity')
      .eq('player_id', Number(playerId))
      .maybeSingle();
    const cap = data ? Number(data.travel_capacity) : NaN;
    return Number.isInteger(cap) && cap >= 10 && cap <= 86 ? cap : null;
  } catch {
    return null;
  }
}

/**
 * Persist a manual capacity edit so the in-game overlays pick it up too.
 * Same session-gated channel as the indicator flag. Fire-and-forget at the
 * call site — never throws.
 */
export async function setTravelCapacity(capacity) {
  return postPdaPrefs({ travel_capacity: Number(capacity) });
}

/**
 * Shared POST to the session-gated pda-prefs edge function. `fields` carries
 * whichever pda_prefs columns to write (show_indicators and/or
 * travel_capacity); the edge function leaves the others untouched.
 */
async function postPdaPrefs(fields) {
  const player_id = getPlayerId();
  const session_token = getSessionToken();
  if (!player_id || !session_token) {
    return { success: false, error: 'not_logged_in' };
  }
  try {
    const res = await fetch(PDA_PREFS_FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({
        action: 'set',
        player_id: Number(player_id),
        session_token,
        ...fields,
      }),
    });
    try {
      return await res.json();
    } catch {
      return { success: false, error: 'bad_response', status: res.status };
    }
  } catch (err) {
    return { success: false, error: 'network', detail: err?.message };
  }
}
