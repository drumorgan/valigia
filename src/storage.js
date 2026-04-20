// Defensive localStorage wrappers.
//
// iPad Safari private-browsing quietly refuses writes with QuotaExceededError
// on every setItem. Quota-exceeded can also fire on regular sessions once the
// origin's budget is exhausted (rare but possible with the item catalog +
// session + perks caches stacking up). Previously the throw bubbled up to the
// call site and crashed whatever was trying to persist — login flow, filter
// persistence, item resolver, etc.
//
// These helpers swallow the throw and degrade gracefully: reads fall back to a
// caller-supplied default, writes return false so the caller can decide
// whether to inform the user. No toast spam here — individual call sites
// decide how loud to be (most don't need to be loud at all).

export function safeGetItem(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemoveItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore — removing from a broken store is already the desired end state */
  }
}
