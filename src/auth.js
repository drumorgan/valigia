// Auth module — API key entry, validation, encrypted server-side storage.
// Plaintext key NEVER stored in localStorage — only player_id.

import { supabaseUrl, supabaseAnonKey } from './supabase.js';
import { callTornApi } from './torn-api.js';
import { showToast } from './ui.js';

const STORAGE_KEY = 'valigia_player_id';
const SET_KEY_URL = `${supabaseUrl}/functions/v1/set-api-key`;
const AUTO_LOGIN_URL = `${supabaseUrl}/functions/v1/auto-login`;

/** Get stored player ID (or null). */
export function getPlayerId() {
  return localStorage.getItem(STORAGE_KEY);
}

/** Store or clear player ID. */
export function setPlayerId(id) {
  if (id) {
    localStorage.setItem(STORAGE_KEY, String(id));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Attempt auto-login using stored player ID.
 * Returns { success, player_id, name, level } or { success: false, error }.
 */
export async function tryAutoLogin() {
  const playerId = getPlayerId();
  if (!playerId) return { success: false, error: 'no_stored_id' };

  try {
    const res = await fetch(AUTO_LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ player_id: Number(playerId) }),
    });

    const data = await res.json();

    if (!data.success) {
      setPlayerId(null);
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
 * 2. Encrypt & store via set-api-key Edge Function
 * 3. Save player_id to localStorage
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

  // Step 2: encrypt and store key server-side
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
    if (!result.success) {
      showToast('Failed to securely store your key. Try again.');
      return null;
    }
  } catch (err) {
    showToast(`Key storage error: ${err.message}`);
    return null;
  }

  // Step 3: save player ID locally
  setPlayerId(playerId);

  return {
    success: true,
    player_id: playerId,
    name: userData.name,
    level: userData.level,
  };
}

/** Clear session — remove stored player ID. */
export function logout() {
  setPlayerId(null);
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
      <a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=basic,log&torn=items&title=Valigia"
         target="_blank" rel="noopener" class="create-key-btn">Create a Custom Key on Torn</a>
      <p class="login-hint login-hint--sub">
        Only shares your name, level, and travel purchase log. Nothing else.
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
