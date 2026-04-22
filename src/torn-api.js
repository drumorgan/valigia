// Torn API proxy helper — all calls route through the torn-proxy Edge Function.
// Supports two auth modes:
//   1. key: raw API key (used during initial login validation)
//   2. player_id: server decrypts stored key (used for all subsequent calls)

import { supabaseUrl, supabaseAnonKey } from './supabase.js';
import { showToast } from './ui.js';

const PROXY_URL = `${supabaseUrl}/functions/v1/torn-proxy`;

// Default per-request timeout. The torn-proxy edge function has its own
// upstream timeout, but a stuck browser socket (dropped connection, flaky
// cell tower) can keep fetch() pending forever with no user signal. 20 s
// is long enough to absorb a legitimately slow Torn response and short
// enough that a user on the login screen doesn't sit staring at
// "Validating…" with no clue what's happening.
const DEFAULT_TIMEOUT_MS = 20_000;

// Once a critical error (like code 16) is shown, suppress further toasts
// so the important message isn't overwritten by subsequent failures.
let criticalErrorShown = false;

/**
 * Call the Torn API through the Edge Function proxy.
 * @param {object} params
 * @param {string} params.section - 'user', 'market', 'torn', etc.
 * @param {string} params.selections - e.g. 'basic', 'log', 'itemmarket', 'items'
 * @param {string|number} [params.id] - item ID for market calls
 * @param {string} [params.key] - raw API key (login only)
 * @param {number} [params.player_id] - Torn player ID (post-login)
 * @param {number} [params.log] - log type filter (e.g. 6501)
 * @param {number} [params.from] - Unix timestamp for log start
 * @param {number} [params.timeoutMs] - override DEFAULT_TIMEOUT_MS
 * @returns {object|null} Parsed JSON or null on error
 */
export async function callTornApi(params) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...body } = params;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody?.error?.error || errBody?.error || `HTTP ${res.status}`;
      showToast(`Torn API error: ${msg}`);
      return null;
    }

    const data = await res.json();

    if (data.error) {
      const code = data.error.code;
      const critical = [2, 13, 16];
      const messages = {
        2: 'Invalid API key — please log out and re-enter a valid key',
        5: 'Too many requests — wait a moment',
        10: 'Key owner is in federal jail',
        13: 'Your Torn key is dormant (owner offline >7 days). Log into Torn once, then retry — no need to make a new key.',
        16: 'Key access too low — delete your current key on Torn and create a new one with the "Create a Custom Key" link on the login screen',
        17: 'Torn backend hiccup — scan continues',
      };
      if (critical.includes(code)) {
        // Show once — don't let subsequent failures overwrite this message
        if (!criticalErrorShown) {
          criticalErrorShown = true;
          showToast(messages[code]);
        }
      } else {
        const type = code === 17 ? 'warning' : 'error';
        showToast(messages[code] || `Torn API error ${code}: ${data.error.error}`, type);
      }
      return null;
    }

    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      showToast('Torn API timed out — try again.', 'warning');
    } else {
      showToast(`Network error: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
