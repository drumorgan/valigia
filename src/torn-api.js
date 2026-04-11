// Torn API proxy helper — all calls route through the torn-proxy Edge Function.
// Supports two auth modes:
//   1. key: raw API key (used during initial login validation)
//   2. player_id: server decrypts stored key (used for all subsequent calls)

import { supabaseUrl, supabaseAnonKey } from './supabase.js';
import { showToast } from './ui.js';

const PROXY_URL = `${supabaseUrl}/functions/v1/torn-proxy`;

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
 * @returns {object|null} Parsed JSON or null on error
 */
export async function callTornApi(params) {
  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify(params),
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
      const messages = {
        2: 'Invalid API key',
        5: 'Too many requests — wait a moment',
        10: 'Key owner is in federal jail',
        13: 'Key disabled (owner inactive >7 days)',
        16: 'Key access too low — delete your current key on Torn and create a new one with the "Create a Custom Key" link on the login screen',
      };
      showToast(messages[code] || `Torn API error ${code}: ${data.error.error}`);
      return null;
    }

    return data;
  } catch (err) {
    showToast(`Network error: ${err.message}`);
    return null;
  }
}
