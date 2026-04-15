// Small header button + modal that shows iPad users how to install the
// in-game PDA overlay userscript.
//
// We deliberately DO NOT auto-open this on page load - that's spammy.
// The button sits discreetly next to Logout in the player badge and
// the user taps it when they want the walkthrough. No "dismiss forever"
// localStorage flag either: the button is quiet enough on its own.

const SCRIPT_URL = 'https://valigia.girovagabondo.com/valigia-ingest.user.js';

// Once a user has opened (or dismissed) the install modal, flip this flag
// so the button stops pulsing forever on subsequent visits. One-time nudge
// only — not a nag.
const SEEN_STORAGE_KEY = 'valigia-pda-button-seen';

/**
 * Mount the install button into the given container (typically the
 * #player-badge). Safe to call multiple times - we remove any previous
 * button first so re-renders of the badge don't duplicate.
 */
export function mountPdaInstallButton(container) {
  if (!container) return;
  const existing = container.querySelector('.pda-install-btn');
  if (existing) existing.remove();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pda-install-btn';
  btn.title = 'Install in-game overlay (Torn PDA)';
  btn.setAttribute('aria-label', 'Install in-game overlay');
  btn.innerHTML = '<span class="pda-install-icon" aria-hidden="true">📱</span><span class="pda-install-text">PDA overlay</span>';

  // First-time nudge: pulse the button until the user either opens the
  // modal or closes it. Once flagged, never pulse again across future
  // visits — the localStorage key persists per browser profile.
  if (!hasSeenButton()) {
    btn.classList.add('pulsing');
  }

  btn.addEventListener('click', () => {
    markButtonSeen();
    btn.classList.remove('pulsing');
    openModal();
  });

  // Place it before the logout button if one exists, so the destructive
  // action stays rightmost. Otherwise append.
  const logout = container.querySelector('.logout-btn');
  if (logout) container.insertBefore(btn, logout);
  else container.appendChild(btn);
}

// ── First-time-seen flag ───────────────────────────────────────

function hasSeenButton() {
  try {
    return localStorage.getItem(SEEN_STORAGE_KEY) === '1';
  } catch {
    // Private mode / storage disabled — don't pulse forever in that case,
    // just skip the nudge.
    return true;
  }
}

function markButtonSeen() {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, '1');
  } catch {
    // ignore
  }
}

// ── Modal ──────────────────────────────────────────────────────

let currentBackdrop = null;

function openModal() {
  if (currentBackdrop) return; // already open
  const backdrop = document.createElement('div');
  backdrop.className = 'pda-modal-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  backdrop.innerHTML = `
    <div class="pda-modal" role="dialog" aria-labelledby="pda-modal-title" aria-modal="true">
      <div class="pda-modal-header">
        <h2 class="pda-modal-title" id="pda-modal-title">Install in-game overlay</h2>
        <button class="pda-modal-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="pda-modal-body">
        <p class="pda-modal-intro">
          Run Valigia's profit data <em>inside</em> Torn's travel shop page — no
          tab switching, no mental math.
        </p>

        <h3 class="pda-section-title">What you get</h3>
        <ul class="pda-benefits">
          <li><strong>Market Price + margin on every row</strong> right on Torn's shop page</li>
          <li><strong>BEST badge</strong> on the highest-profit-per-item row so you know what to max</li>
          <li>Your shop scrapes feed the shared price pool — every install makes everyone's prices fresher</li>
        </ul>

        <p class="pda-requirement">Only works inside the <strong>Torn PDA</strong> mobile app (iOS / Android). Not Safari or Chrome.</p>

        <h3 class="pda-section-title">Install steps</h3>
        <ol class="pda-steps">
          <li>Open <strong>Torn PDA</strong> → tap the <strong>hamburger menu</strong> (top-left) → <strong>Settings</strong></li>
          <li>Tap <strong>Advanced Browser Settings</strong> <span class="pda-icon-hint">(wireframe globe icon 🌐)</span></li>
          <li>Tap <strong>Manage Scripts</strong> <span class="pda-icon-hint">(scroll icon 📜)</span></li>
          <li>Tap the <strong>+</strong> button to add a new script</li>
          <li>Tap <strong>Configure</strong>, then paste the URL below:</li>
        </ol>

        <div class="pda-url-block">
          <code class="pda-url" id="pda-url-text">${SCRIPT_URL}</code>
          <button class="pda-copy-btn" type="button" data-url="${SCRIPT_URL}">Copy URL</button>
        </div>

        <ol class="pda-steps" start="6">
          <li>Tap <strong>Fetch</strong></li>
          <li>
            <strong>Insert your Torn API key</strong> where the script asks for it.
            <div class="pda-key-hint">
              No key yet? Log out and use the <strong>Create a Custom Key on Torn</strong>
              button on Valigia's login screen — it opens Torn with the right
              permissions pre-selected.
            </div>
          </li>
          <li>Tap <strong>Load</strong></li>
          <li>Fly to any destination — the overlay appears automatically on the shop page</li>
        </ol>
      </div>
      <div class="pda-modal-footer">
        <button class="pda-modal-done" type="button">Got it</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  currentBackdrop = backdrop;

  backdrop.querySelector('.pda-modal-close').addEventListener('click', closeModal);
  backdrop.querySelector('.pda-modal-done').addEventListener('click', closeModal);
  backdrop.querySelector('.pda-copy-btn').addEventListener('click', onCopyClick);
  document.addEventListener('keydown', onKeydown);
}

function closeModal() {
  if (!currentBackdrop) return;
  currentBackdrop.remove();
  currentBackdrop = null;
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(e) {
  if (e.key === 'Escape') closeModal();
}

function onCopyClick(e) {
  const btn = e.currentTarget;
  const url = btn.getAttribute('data-url') || SCRIPT_URL;
  const original = btn.textContent;

  // Try the async clipboard API first; fall back to a temporary textarea
  // since older iPad browser engines still need the execCommand path.
  const done = () => {
    btn.textContent = 'Copied ✓';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1800);
  };
  const fail = () => {
    btn.textContent = 'Copy failed';
    setTimeout(() => { btn.textContent = original; }, 1800);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => legacyCopy(url) ? done() : fail());
  } else {
    legacyCopy(url) ? done() : fail();
  }
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
