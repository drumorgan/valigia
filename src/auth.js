// Auth module — API key entry, validation, encrypted server-side storage.
// Plaintext key NEVER stored in localStorage. After login, the browser
// holds only { player_id, session_token }; the raw API key lives in
// Supabase encrypted with AES-256-GCM and is only decrypted server-side.

import { supabaseUrl, supabaseAnonKey } from './supabase.js';
import { callTornApi } from './torn-api.js';
import { showToast } from './ui.js';

// Session bundle (player_id + session_token) — both fields required for
// auto-login. Legacy key kept only so we can actively clear it and force
// re-login for users who last logged in before tokens existed.
const SESSION_STORAGE_KEY = 'valigia_session';
const LEGACY_PLAYER_ID_KEY = 'valigia_player_id';
const SET_KEY_URL = `${supabaseUrl}/functions/v1/set-api-key`;
const AUTO_LOGIN_URL = `${supabaseUrl}/functions/v1/auto-login`;

/** Read stored session bundle, or null. */
function getSession() {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.player_id || !parsed?.session_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Store or clear the session bundle. */
function setSession(session) {
  if (session && session.player_id && session.session_token) {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        player_id: String(session.player_id),
        session_token: session.session_token,
      })
    );
  } else {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

/** Public: expose player ID for the rest of the app (market calls, etc.). */
export function getPlayerId() {
  const session = getSession();
  return session ? session.player_id : null;
}

/**
 * Attempt auto-login using stored player ID + session token. Returns
 * { success, player_id, name, level } on success, or { success: false, error }
 * on any failure (including missing session, expired token, revoked key).
 */
export async function tryAutoLogin() {
  // Hard cutover for users who logged in before the session-token patch:
  // their localStorage only has `valigia_player_id`, no token. Clear it
  // and force them through the login screen once. Safer than carrying a
  // dual-mode code path.
  const legacyOnly =
    localStorage.getItem(LEGACY_PLAYER_ID_KEY) &&
    !localStorage.getItem(SESSION_STORAGE_KEY);
  if (legacyOnly) {
    localStorage.removeItem(LEGACY_PLAYER_ID_KEY);
    return { success: false, error: 'session_upgrade_required' };
  }

  const session = getSession();
  if (!session) return { success: false, error: 'no_stored_session' };

  try {
    const res = await fetch(AUTO_LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({
        player_id: Number(session.player_id),
        session_token: session.session_token,
      }),
    });

    // Any non-200 (including our 401 for bad/missing token) → clear and
    // send the user back to the login screen silently.
    if (!res.ok) {
      setSession(null);
      return { success: false, error: 'unauthorized' };
    }

    const data = await res.json();

    if (!data.success) {
      setSession(null);
      if (data.error === 'key_invalid') {
        showToast('Your API key expired or was revoked. Please log in again.');
      }
      return data;
    }

    return data;
  } catch (err) {
    showToast(`Auto-login failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Full login flow:
 * 1. Validate key via torn-proxy (using raw key)
 * 2. Encrypt & store via set-api-key Edge Function; receive session_token
 * 3. Save { player_id, session_token } to localStorage
 * Returns { success, player_id, name, level } or null on failure.
 */
export async function handleLogin(apiKey) {
  if (!apiKey || !apiKey.trim()) {
    showToast('Please enter your API key');
    return null;
  }

  const key = apiKey.trim();

  // Step 1: validate against Torn API
  const userData = await callTornApi({
    section: 'user',
    selections: 'basic',
    key,
  });

  if (!userData) return null; // callTornApi already showed toast

  const playerId = userData.player_id;

  // Step 2: encrypt and store key server-side; server returns a session token.
  let sessionToken = null;
  try {
    const res = await fetch(SET_KEY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({
        player_id: playerId,
        api_key: key,
      }),
    });

    const result = await res.json();
    if (!result.success || !result.session_token) {
      showToast('Failed to securely store your key. Try again.');
      return null;
    }
    sessionToken = result.session_token;
  } catch (err) {
    showToast(`Key storage error: ${err.message}`);
    return null;
  }

  // Step 3: save session bundle locally. Also sweep the legacy key so a
  // future deploy doesn't find stale ambiguous state.
  setSession({ player_id: playerId, session_token: sessionToken });
  localStorage.removeItem(LEGACY_PLAYER_ID_KEY);

  return {
    success: true,
    player_id: playerId,
    name: userData.name,
    level: userData.level,
  };
}

/** Clear session — remove stored session bundle. */
export function logout() {
  setSession(null);
  localStorage.removeItem(LEGACY_PLAYER_ID_KEY);
}

/**
 * Render the login screen into a container element.
 * @param {HTMLElement} container
 * @param {function} onSuccess - Called with { player_id, name, level } after login
 */
export function renderLoginScreen(container, onSuccess) {
  container.innerHTML = `
    <div class="login-card">
      <h2 class="login-title">Enter Your API Key</h2>
      <p class="login-desc">
        Your key is validated, then <strong>encrypted with AES-256</strong> and
        stored server-side. It is never saved in your browser.
      </p>
      <a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=basic,perks,bazaar&torn=items&market=bazaar,itemmarket&title=Valigia"
         target="_blank" rel="noopener" class="create-key-btn">Create a Custom Key on Torn</a>
      <p class="login-hint login-hint--sub">
        Only shares your name, perks, bazaar listings, and item market prices. Nothing else.
      </p>
      <div class="login-input-row">
        <input
          type="password"
          id="api-key-input"
          class="login-input"
          placeholder="Paste your Torn API key"
          autocomplete="off"
          spellcheck="false"
        />
        <button id="login-btn" class="login-btn">Connect</button>
      </div>
      <details class="login-tos">
        <summary>How your key is handled</summary>
        <ul>
          <li>Your key is sent once to our server to verify it with Torn</li>
          <li>It is then encrypted (AES-256-GCM) with a server-side secret and stored</li>
          <li>Only your player ID is saved in your browser</li>
          <li>Your key is decrypted server-side only when making Torn API calls</li>
          <li>You can revoke your key on Torn at any time to invalidate it</li>
        </ul>
      </details>
    </div>
  `;

  const input = container.querySelector('#api-key-input');
  const btn = container.querySelector('#login-btn');

  async function doLogin() {
    btn.disabled = true;
    btn.textContent = 'Validating\u2026';
    const result = await handleLogin(input.value);
    if (result) {
      onSuccess(result);
    } else {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }

  btn.addEventListener('click', doLogin);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });

  // Auto-focus after render
  requestAnimationFrame(() => input.focus());
}
