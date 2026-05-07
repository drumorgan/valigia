import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// cron-refresh-traders
//
// Triggered once a day by pg_cron + pg_net (see migration 031). Walks
// every row in te_traders, re-scrapes each TornExchange page, and
// upserts buy_prices. Authenticates via a shared CRON_SECRET header so
// it can run without a player session. Uses SERVICE_TORN_API_KEY for
// the items catalog (catalog endpoint only needs a valid public key).
//
// Scrape + catalog helpers are copied from ingest-te-trader/index.ts —
// keep both in sync if TE's DOM shifts. Intentionally not extracted to
// _shared/ so each edge function stays independently deployable.

interface ScrapedRow { name: string; buy_price: number }
interface ScrapeResult {
  ok: boolean;
  http_status?: number;
  strategy?: string;
  rows: ScrapedRow[];
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

  const jsonRows = tryExtractFromJson(html);
  if (jsonRows.length > 0) return { ok: true, strategy: 'json', rows: jsonRows };

  const tableRows = tryExtractFromTable(html);
  if (tableRows.length > 0) return { ok: true, strategy: 'table', rows: tableRows };

  const looseRows = tryExtractFromLoose(html);
  if (looseRows.length > 0) return { ok: true, strategy: 'loose', rows: looseRows };

  return { ok: false, http_status: res.status, rows: [], error: 'no_rows_parsed' };
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

interface RefreshResult {
  handle: string;
  ok: boolean;
  resolved?: number;
  error?: string;
}

async function refreshOne(
  supabase: SupabaseClient,
  catalog: Map<string, { id: number; canonical: string }>,
  trader: { handle: string; torn_player_id: number | null; consecutive_fails: number | null },
): Promise<RefreshResult> {
  const scrape = await scrapeTEPage(trader.handle);
  const nowIso = new Date().toISOString();

  if (!scrape.ok || scrape.rows.length === 0) {
    const nextFails = (trader.consecutive_fails ?? 0) + 1;
    await supabase.from('te_traders').upsert({
      handle: trader.handle,
      torn_player_id: trader.torn_player_id,
      last_scraped_at: nowIso,
      last_scrape_ok: false,
      last_scrape_error: scrape.error?.slice(0, 200) ?? 'unknown',
      consecutive_fails: nextFails,
    }, { onConflict: 'handle' });
    return { handle: trader.handle, ok: false, error: scrape.error };
  }

  const resolved: { item_id: number; item_name: string; buy_price: number }[] = [];
  for (const row of scrape.rows) {
    const hit = catalog.get(row.name.toLowerCase());
    if (hit) resolved.push({ item_id: hit.id, item_name: hit.canonical, buy_price: row.buy_price });
  }

  if (resolved.length === 0) {
    const nextFails = (trader.consecutive_fails ?? 0) + 1;
    await supabase.from('te_traders').upsert({
      handle: trader.handle,
      torn_player_id: trader.torn_player_id,
      last_scraped_at: nowIso,
      last_scrape_ok: false,
      last_scrape_error: 'no_items_resolved',
      consecutive_fails: nextFails,
    }, { onConflict: 'handle' });
    return { handle: trader.handle, ok: false, error: 'no_items_resolved' };
  }

  await supabase.from('te_traders').upsert({
    handle: trader.handle,
    torn_player_id: trader.torn_player_id,
    last_scraped_at: nowIso,
    last_scrape_ok: true,
    last_scrape_error: null,
    consecutive_fails: 0,
    item_count: resolved.length,
  }, { onConflict: 'handle' });

  const priceRows = resolved.map((r) => ({
    handle: trader.handle,
    item_id: r.item_id,
    item_name: r.item_name,
    buy_price: r.buy_price,
    updated_at: nowIso,
  }));
  await supabase.from('te_buy_prices').upsert(priceRows, { onConflict: 'handle,item_id' });

  const keptIds = resolved.map((r) => r.item_id);
  if (keptIds.length > 0) {
    await supabase
      .from('te_buy_prices')
      .delete()
      .eq('handle', trader.handle)
      .not('item_id', 'in', `(${keptIds.join(',')})`);
  }

  return { handle: trader.handle, ok: true, resolved: resolved.length };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret) return json({ error: 'cron_secret_not_configured' }, 500);
  const auth = req.headers.get('authorization') || '';
  if (auth !== `Bearer ${cronSecret}`) return json({ error: 'unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const force = body?.force === true;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const apiKey = Deno.env.get('SERVICE_TORN_API_KEY');
  if (!apiKey) return json({ error: 'service_torn_api_key_not_configured' }, 500);

  const catalog = await getItemCatalog(apiKey);
  if (!catalog) return json({ error: 'items_catalog_unavailable' }, 502);

  const { data: traders, error: tErr } = await supabase
    .from('te_traders')
    .select('handle, torn_player_id, consecutive_fails, last_scraped_at')
    // Oldest-first so a partial run drains the staler ones — if we ever
    // outgrow the edge-fn timeout we'll add chunking, but for ~50 traders
    // at ~1.5 s each (scrape + 500 ms politeness sleep + a couple writes)
    // we comfortably finish inside the 300 s timeout below.
    .order('last_scraped_at', { ascending: true, nullsFirst: true });
  if (tErr || !traders) {
    return json({ error: `traders_query_failed: ${tErr?.message ?? 'unknown'}` }, 500);
  }

  const COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const FAIL_LIMIT = 3;
  const now = Date.now();

  const results: RefreshResult[] = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const t of traders) {
    // Dead-page cooldown: a trader page that's failed FAIL_LIMIT+ times in
    // a row gets a 24 h breather before we re-attempt. Rolls forward on
    // every failed retry, so a permanently-deleted page settles into
    // one attempt per day instead of burning the cron budget every night.
    const lastAt = t.last_scraped_at ? new Date(t.last_scraped_at).getTime() : 0;
    const inCooldown = !force
      && (t.consecutive_fails ?? 0) >= FAIL_LIMIT
      && lastAt
      && now - lastAt < COOLDOWN_MS;
    if (inCooldown) {
      skipped++;
      results.push({ handle: t.handle, ok: false, error: 'cooldown_skip' });
      continue;
    }

    processed++;
    const result = await refreshOne(supabase, catalog, {
      handle: t.handle,
      torn_player_id: t.torn_player_id,
      consecutive_fails: t.consecutive_fails,
    });
    if (result.ok) succeeded++; else failed++;
    results.push(result);

    // Politeness delay between TE page fetches. Half a second × 50 traders
    // = 25 s of sleep per run, comfortably under the function's wall clock
    // and far below any reasonable rate limit on tornexchange.com.
    await sleep(500);
  }

  return json({
    ok: true,
    total: traders.length,
    processed,
    succeeded,
    failed,
    skipped,
    results,
  });
});
