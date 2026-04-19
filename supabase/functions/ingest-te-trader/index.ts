import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ── Shared: CORS ────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Session-token auth (same shape as auto-login / watchlist) ──
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64(new Uint8Array(digest));
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
async function importKey(rawB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(rawB64), { name: 'AES-GCM' }, false, ['decrypt']);
}
async function decryptApiKey(ciphertextB64: string, ivB64: string): Promise<string> {
  const rawKey = Deno.env.get('API_KEY_ENCRYPTION_KEY');
  if (!rawKey) throw new Error('Missing API_KEY_ENCRYPTION_KEY env var');
  const key = await importKey(rawKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ciphertextB64),
  );
  return new TextDecoder().decode(decrypted);
}

// ── Rate-limit gate (same pattern as ingest-travel-shop) ────────
async function checkRateLimit(
  supabase: SupabaseClient,
  playerId: number,
  endpoint: string,
  minIntervalMs: number,
): Promise<{ allowed: true } | { allowed: false; response: Response }> {
  try {
    const { data, error } = await supabase.rpc('ingest_rate_check', {
      p_player_id: playerId,
      p_endpoint: endpoint,
      p_min_interval_ms: minIntervalMs,
    });
    if (error || data !== false) return { allowed: true };
    return {
      allowed: false,
      response: json({ error: 'rate_limited', retry_after_ms: minIntervalMs }, 429, {
        'Retry-After': String(Math.max(1, Math.ceil(minIntervalMs / 1000))),
      }),
    };
  } catch {
    return { allowed: true };
  }
}

// ── Input parsing ───────────────────────────────────────────────
// Accept three forms: full TE URL, bare handle, numeric Torn player id.
// Normalise downstream code to "handle slug" (the {handle} in
// /prices/{handle}/).
function parseTraderInput(raw: string): { kind: 'handle'; handle: string } | { kind: 'playerId'; id: number } | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/^https?:\/\/(?:www\.)?tornexchange\.com\/prices\/([^/\s?#]+)\/?/i);
  if (urlMatch) {
    const handle = decodeURIComponent(urlMatch[1]);
    if (isValidHandle(handle)) return { kind: 'handle', handle };
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    if (Number.isInteger(id) && id > 0 && id < 10_000_000) {
      return { kind: 'playerId', id };
    }
    return null;
  }

  if (isValidHandle(trimmed)) return { kind: 'handle', handle: trimmed };
  return null;
}

function isValidHandle(s: string): boolean {
  return /^[A-Za-z0-9_-]{1,24}$/.test(s);
}

// ── TE scrape ───────────────────────────────────────────────────
// TE's DOM isn't documented and will likely drift. Try three strategies
// in order (embedded JSON hydration → <table> rows → loose tag scan),
// return which one fired, and expose a `debug` flag that echoes a slice
// of the raw HTML so the parser can be iterated after deploy without
// another round-trip.
interface ScrapedRow { name: string; buy_price: number }
interface ScrapeResult {
  ok: boolean;
  http_status?: number;
  strategy?: string;
  rows: ScrapedRow[];
  debug_sample?: string;
  error?: string;
}

async function scrapeTEPage(handle: string): Promise<ScrapeResult> {
  const url = `https://tornexchange.com/prices/${encodeURIComponent(handle)}/`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    return { ok: false, rows: [], error: `fetch_failed: ${(err as Error).message}` };
  }
  if (!res.ok) {
    return { ok: false, http_status: res.status, rows: [], error: `http_${res.status}` };
  }
  const html = await res.text();
  const debug_sample = html.slice(0, 4000);

  const jsonRows = tryExtractFromJson(html);
  if (jsonRows.length > 0) return { ok: true, strategy: 'json', rows: jsonRows, debug_sample };

  const tableRows = tryExtractFromTable(html);
  if (tableRows.length > 0) return { ok: true, strategy: 'table', rows: tableRows, debug_sample };

  const looseRows = tryExtractFromLoose(html);
  if (looseRows.length > 0) return { ok: true, strategy: 'loose', rows: looseRows, debug_sample };

  return {
    ok: false,
    http_status: res.status,
    rows: [],
    error: 'no_rows_parsed',
    debug_sample,
  };
}

function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return null;
  return Math.round(n);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function tryExtractFromJson(html: string): ScrapedRow[] {
  const out: ScrapedRow[] = [];
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of scripts) {
    const body = block.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '');
    const re = /"name"\s*:\s*"([^"\\]{1,80}(?:\\.[^"\\]*)*)"\s*,\s*(?:[^{}]{0,200})"price"\s*:\s*(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const name = decodeEntities(m[1]).trim();
      const price = Number(m[2]);
      if (!name || !Number.isFinite(price) || price <= 0) continue;
      out.push({ name, buy_price: price });
      if (out.length > 2000) break;
    }
    if (out.length > 0) break;
  }
  return dedupeByName(out);
}

function tryExtractFromTable(html: string): ScrapedRow[] {
  const out: ScrapedRow[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(html)) !== null) {
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      cells.push(decodeEntities(stripTags(cm[1])));
    }
    if (cells.length < 2) continue;
    let priceIdx = -1;
    let price = 0;
    for (let i = 0; i < cells.length; i++) {
      if (/\$[\d,]+/.test(cells[i])) {
        const p = parsePrice(cells[i]);
        if (p) { priceIdx = i; price = p; break; }
      }
    }
    if (priceIdx < 0) continue;
    let name = '';
    for (let i = 0; i < cells.length; i++) {
      if (i === priceIdx) continue;
      const c = cells[i].trim();
      if (c && c.length >= 2 && c.length <= 80 && !/^\$?[\d,]+$/.test(c)) {
        name = c;
        break;
      }
    }
    if (!name || !price) continue;
    out.push({ name, buy_price: price });
    if (out.length > 2000) break;
  }
  return dedupeByName(out);
}

function tryExtractFromLoose(html: string): ScrapedRow[] {
  const text = decodeEntities(stripTags(html));
  const tokens = text.split(/(\$[\d,]+)/g);
  const out: ScrapedRow[] = [];
  for (let i = 1; i < tokens.length; i += 2) {
    const price = parsePrice(tokens[i]);
    if (!price) continue;
    const pre = tokens[i - 1].trim();
    const match = pre.match(/([A-Za-z][A-Za-z0-9 '&().-]{1,60}[A-Za-z0-9)])\s*$/);
    if (!match) continue;
    const name = match[1].trim();
    if (name.length < 2 || /^[\d,]+$/.test(name)) continue;
    out.push({ name, buy_price: price });
    if (out.length > 2000) break;
  }
  return dedupeByName(out);
}

function dedupeByName(rows: ScrapedRow[]): ScrapedRow[] {
  const seen = new Map<string, ScrapedRow>();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    const existing = seen.get(key);
    if (!existing || r.buy_price > existing.buy_price) seen.set(key, r);
  }
  return [...seen.values()];
}

// ── Torn items catalog (name → id) ──────────────────────────────
// Fetched per-isolate with the submitter's decrypted key. Deno edge-fn
// isolates stay warm for ~minutes of back-to-back traffic, so a single
// catalog fetch covers a full submit session. Falls back to previous
// cache on transient errors.
let cachedCatalog: { nameToId: Map<string, { id: number; canonical: string }>; fetchedAt: number } | null = null;
const CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function getItemCatalog(apiKey: string): Promise<Map<string, { id: number; canonical: string }> | null> {
  if (cachedCatalog && (Date.now() - cachedCatalog.fetchedAt) < CATALOG_MAX_AGE_MS) {
    return cachedCatalog.nameToId;
  }
  try {
    const res = await fetch(`https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(apiKey)}`);
    const data = await res.json();
    if (!data || data.error || !data.items) return cachedCatalog?.nameToId ?? null;
    const map = new Map<string, { id: number; canonical: string }>();
    for (const [idStr, raw] of Object.entries(data.items as Record<string, unknown>)) {
      const id = Number(idStr);
      const obj = raw as { name?: unknown };
      const name = typeof obj?.name === 'string' ? obj.name : null;
      if (!Number.isInteger(id) || id <= 0 || !name) continue;
      map.set(name.toLowerCase(), { id, canonical: name });
    }
    cachedCatalog = { nameToId: map, fetchedAt: Date.now() };
    return map;
  } catch {
    return cachedCatalog?.nameToId ?? null;
  }
}

// ── Handler ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const player_id = Number(body?.player_id);
    const session_token = typeof body?.session_token === 'string' ? body.session_token : '';
    const input = typeof body?.input === 'string' ? body.input : '';
    const debug = body?.debug === true;

    if (!Number.isInteger(player_id) || player_id <= 0 || !session_token) {
      return json({ error: 'unauthorized' }, 401);
    }
    const parsed = parseTraderInput(input);
    if (!parsed) return json({ error: 'invalid_input' }, 400);

    // Step 1 — validate session token against player_secrets; decrypt
    // the stored API key so we can call Torn for items catalog + optional
    // player-id → name resolution.
    const { data: secret } = await supabase
      .from('player_secrets')
      .select('api_key_enc, api_key_iv, session_token_hash')
      .eq('torn_player_id', player_id)
      .single();
    if (!secret?.session_token_hash || !secret?.api_key_enc || !secret?.api_key_iv) {
      return json({ error: 'unauthorized' }, 401);
    }
    const submittedHash = await hashToken(session_token);
    if (!timingSafeEqual(submittedHash, secret.session_token_hash)) {
      return json({ error: 'unauthorized' }, 401);
    }
    const apiKey = await decryptApiKey(secret.api_key_enc, secret.api_key_iv);

    // Step 2 — rate-limit per submitter. 10 s blocks tight loops while
    // letting a legitimate "submit + immediately retry on a typo" flow
    // through without a gate error.
    const gate = await checkRateLimit(supabase, player_id, 'te-trader', 10_000);
    if (!gate.allowed) return gate.response;

    // Step 3 — look up the submitter's own Torn name. We need this for two
    // reasons: (a) to resolve a player-id submission to a TE handle, and
    // (b) to detect self-submission (trader scraping their OWN page), in
    // which case we opportunistically pin torn_player_id on the trader row.
    // That's the only reliable way to back-fill the id column for pages
    // submitted by URL/handle where the submitter didn't know it — when
    // the trader themselves eventually logs into Valigia, their self-
    // refresh lands here and stamps the id.
    const selfRes = await fetch(
      `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(apiKey)}`,
    );
    const selfData = await selfRes.json();
    if (selfData?.error) {
      return json({ error: 'torn_rejected_stored_key', torn_code: selfData.error.code }, 401);
    }
    const submitterName = typeof selfData?.name === 'string' ? selfData.name : '';

    // Step 4 — resolve handle. If the caller passed a player id, look up
    // the Torn name to use as the TE slug (separate Torn call because the
    // submitter's key can query any player, not just themselves).
    let handle: string;
    let resolvedPlayerId: number | null = null;
    if (parsed.kind === 'handle') {
      handle = parsed.handle;
    } else {
      const nameRes = await fetch(
        `https://api.torn.com/user/${parsed.id}/?selections=basic&key=${encodeURIComponent(apiKey)}`,
      );
      const nameData = await nameRes.json();
      if (nameData?.error) {
        return json({ error: 'could_not_resolve_player_id', torn_code: nameData.error.code }, 400);
      }
      const name = typeof nameData?.name === 'string' ? nameData.name : '';
      if (!isValidHandle(name)) return json({ error: 'resolved_name_invalid' }, 400);
      handle = name;
      resolvedPlayerId = parsed.id;
    }

    // Self-submission check: if the submitter's Torn name matches the
    // resolved handle (case-insensitive — Torn names are unique case-
    // insensitively), stamp their player_id on the trader row. This makes
    // the "trader logs in → their id gets back-filled" flow work for any
    // trader page originally submitted by URL/handle.
    if (!resolvedPlayerId
        && submitterName
        && submitterName.toLowerCase() === handle.toLowerCase()) {
      resolvedPlayerId = player_id;
    }

    // Read any existing trader row up front. We need the prior
    // torn_player_id to preserve it across upserts by non-owner submitters
    // (otherwise a stranger refreshing the page would clobber the id back
    // to null) and the prior consecutive_fails for the failure path's
    // increment.
    const { data: existingTrader } = await supabase
      .from('te_traders')
      .select('torn_player_id, consecutive_fails')
      .eq('handle', handle)
      .maybeSingle();
    const effectivePlayerId = resolvedPlayerId ?? existingTrader?.torn_player_id ?? null;

    // Step 5 — scrape TE.
    const scrape = await scrapeTEPage(handle);
    if (!scrape.ok || scrape.rows.length === 0) {
      // Record the failure so the background refresher backs off. Preserve
      // the existing torn_player_id if any — a failing refresh shouldn't
      // undo identity that was previously pinned.
      const nextFails = (existingTrader?.consecutive_fails ?? 0) + 1;
      await supabase.from('te_traders').upsert(
        {
          handle,
          torn_player_id: effectivePlayerId,
          submitted_by: player_id,
          last_scraped_at: new Date().toISOString(),
          last_scrape_ok: false,
          last_scrape_error: scrape.error?.slice(0, 200) ?? 'unknown',
          consecutive_fails: nextFails,
        },
        { onConflict: 'handle' },
      );
      return json(
        {
          ok: false,
          handle,
          error: scrape.error || 'scrape_failed',
          http_status: scrape.http_status,
          debug_sample: debug ? scrape.debug_sample : undefined,
        },
        502,
      );
    }

    // Step 6 — resolve names to item ids via Torn's item catalog.
    const catalog = await getItemCatalog(apiKey);
    if (!catalog) return json({ error: 'items_catalog_unavailable' }, 502);

    const resolved: { item_id: number; item_name: string; buy_price: number }[] = [];
    const unresolved: string[] = [];
    for (const row of scrape.rows) {
      const hit = catalog.get(row.name.toLowerCase());
      if (!hit) {
        if (unresolved.length < 25) unresolved.push(row.name);
        continue;
      }
      resolved.push({ item_id: hit.id, item_name: hit.canonical, buy_price: row.buy_price });
    }

    if (resolved.length === 0) {
      return json(
        {
          ok: false,
          handle,
          error: 'no_items_resolved',
          scraped_rows: scrape.rows.length,
          unresolved_sample: unresolved,
          strategy: scrape.strategy,
          debug_sample: debug ? scrape.debug_sample : undefined,
        },
        422,
      );
    }

    // Step 7 — upsert trader + prices, prune items that disappeared from
    // the trader's page since last scrape. Use effectivePlayerId so a
    // stranger refreshing the page keeps the previously-pinned id intact.
    const now = new Date().toISOString();
    const { error: tErr } = await supabase.from('te_traders').upsert(
      {
        handle,
        torn_player_id: effectivePlayerId,
        submitted_by: player_id,
        last_scraped_at: now,
        last_scrape_ok: true,
        last_scrape_error: null,
        consecutive_fails: 0,
        item_count: resolved.length,
      },
      { onConflict: 'handle' },
    );
    if (tErr) return json({ error: `trader_upsert_failed: ${tErr.message}` }, 500);

    const priceRows = resolved.map((r) => ({
      handle,
      item_id: r.item_id,
      item_name: r.item_name,
      buy_price: r.buy_price,
      updated_at: now,
    }));
    const { error: pErr } = await supabase
      .from('te_buy_prices')
      .upsert(priceRows, { onConflict: 'handle,item_id' });
    if (pErr) return json({ error: `price_upsert_failed: ${pErr.message}` }, 500);

    const keptIds = resolved.map((r) => r.item_id);
    if (keptIds.length > 0) {
      await supabase
        .from('te_buy_prices')
        .delete()
        .eq('handle', handle)
        .not('item_id', 'in', `(${keptIds.join(',')})`);
    }

    return json({
      ok: true,
      handle,
      strategy: scrape.strategy,
      resolved: resolved.length,
      unresolved: unresolved.length,
      unresolved_sample: unresolved,
      debug_sample: debug ? scrape.debug_sample : undefined,
    });
  } catch (err) {
    return json({ error: `ingest-te-trader_error: ${(err as Error).message}` }, 500);
  }
});

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  });
}
