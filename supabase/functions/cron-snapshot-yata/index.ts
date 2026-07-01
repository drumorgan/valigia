import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// cron-snapshot-yata
//
// Triggered every ~5 min by pg_cron + pg_net (see migration 039). Polls
// the YATA travel export and writes yata_snapshots + restock_events
// server-side, completely independent of user activity.
//
// Why this exists: depletion slopes and restock cadence need a dense
// time series of the same (item, destination). Until now the only
// writers were user-gated — the web app's recordSnapshots() on dashboard
// load, the abroad_prices PDA-scrape trigger, and the PDA drip/stakeout.
// With low traffic those fire rarely, so the forecast columns stay empty.
// YATA is already a community-aggregated feed that updates frequently;
// sampling it on a fixed cadence decouples our data density from our own
// user count.
//
// This mirrors src/stock-forecast.js's recordSnapshots() exactly: dedup
// against the latest reading per (item, destination), insert only changed
// rows, emit a restock_event on any positive quantity delta, and prune the
// 48 h window. Concurrent writers (client + trigger + this cron) collapse
// at the DB level via migration 026's unique index on
// (item_id, destination, snapped_minute) and restock_events' (…,
// restocked_minute). Authenticates via a shared CRON_SECRET header so it
// runs without a player session — same trust model as cron-refresh-traders.

const YATA_EXPORT_URL = 'https://yata.yt/api/v1/travel/export/';

// YATA country code → canonical destination. Must match the web app
// (src/data/destinations.js) and the PDA userscript's YATA_COUNTRY_MAP so
// every writer keys the same destination strings.
const YATA_COUNTRY_MAP: Record<string, string> = {
  mex: 'Mexico',
  cay: 'Caymans',
  can: 'Canada',
  haw: 'Hawaii',
  uni: 'UK',
  arg: 'Argentina',
  swi: 'Switzerland',
  jap: 'Japan',
  chi: 'China',
  uae: 'UAE',
  sou: 'South Africa',
};

// 48 h rolling window, matching src/stock-forecast.js PRUNE_OLDER_THAN_MINS
// and the CLAUDE.md schema note for yata_snapshots.
const PRUNE_OLDER_THAN_MINS = 48 * 60;

// Only need the most recent reading per (item, destination) to diff against.
// A 2 h lookback bounds the payload while comfortably covering the ~5 min
// cadence (and any short gap). A longer gap just reads as "never seen" and
// the row is recorded fresh — exactly what we want.
const LATEST_LOOKBACK_MINS = 120;

// Transient-failure retry for the YATA fetch (see fetchYataRows).
const YATA_FETCH_ATTEMPTS = 3;
const YATA_BACKOFF_MS = [500, 1500];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface YataRow {
  item_id: number;
  destination: string;
  quantity: number;
  buy_price: number | null;
  // Epoch ms of YATA's per-country `update` field — when the reading was
  // actually collected, as opposed to when we polled. Null if absent.
  observed_ms: number | null;
}

async function fetchYataRows(): Promise<YataRow[]> {
  // YATA's export occasionally returns a transient 5xx or drops the
  // connection. Retry a couple of times with short backoff, and send a
  // browser User-Agent (some tiers reject UA-less requests). A persistent
  // failure still throws → the caller returns 502 and the next 5-min tick
  // recovers, so a bad moment costs at most one skipped sample.
  // deno-lint-ignore no-explicit-any
  let data: any = null;
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < YATA_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(YATA_EXPORT_URL, {
        headers: {
          'Accept': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        },
      });
      if (res.ok) {
        data = await res.json();
        break;
      }
      lastErr = `yata_http_${res.status}`;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    if (attempt < YATA_FETCH_ATTEMPTS - 1) await sleep(YATA_BACKOFF_MS[attempt]);
  }
  if (data == null) throw new Error(lastErr);

  const countries = data?.stocks || data || {};
  const out: YataRow[] = [];
  const nowMs = Date.now();
  for (const code of Object.keys(countries)) {
    const dest = YATA_COUNTRY_MAP[code];
    if (!dest) continue;
    const stocks = countries[code]?.stocks || [];
    // Observation-time stamping: YATA's per-country `update` (epoch
    // seconds) says when this country's data was actually collected. A
    // reading can be many minutes stale by the time we poll it — writing
    // it as "now" smears the timestamps the tick-attribution and
    // half-sellout estimators depend on (restocks land on exact
    // quarter-hour ticks, so minutes matter). Clamped to now for skew;
    // missing/garbage → null and the DB default now() applies.
    const updRaw = Number(countries[code]?.update);
    const observedMs = Number.isFinite(updRaw) && updRaw > 0
      ? Math.min(updRaw * 1000, nowMs)
      : null;
    for (const s of stocks) {
      if (!s || !s.id) continue;
      const qty = Number(s.quantity);
      if (!Number.isFinite(qty)) continue; // need a number to diff/store
      out.push({
        item_id: Number(s.id),
        destination: dest,
        quantity: qty,
        buy_price: Number.isFinite(Number(s.cost)) ? Number(s.cost) : null,
        observed_ms: observedMs,
      });
    }
  }
  return out;
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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let yataRows: YataRow[];
  try {
    yataRows = await fetchYataRows();
  } catch (err) {
    return json({ error: 'yata_fetch_failed', detail: (err as Error).message }, 502);
  }
  if (yataRows.length === 0) return json({ ok: true, scanned: 0, snapshots: 0, restocks: 0 });

  // Latest existing reading per (item, destination) via the
  // get_latest_yata_snapshots() RPC (migration 041, DISTINCT ON — one
  // newest row per pair regardless of age). The old windowed read missed
  // the latest row for any shelf whose last transition predated the
  // lookback, silently skipping restock detection for slow shelves. The
  // windowed read stays as a fallback if the RPC errors.
  const latestMap = new Map<string, { quantity: number; buy_price: number | null; snapped_at: string }>();
  {
    const { data, error } = await supabase.rpc('get_latest_yata_snapshots');
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        latestMap.set(`${row.item_id}|${row.destination}`, row);
      }
    } else {
      const itemIds = [...new Set(yataRows.map((r) => r.item_id))];
      const cutoffLatest = new Date(Date.now() - LATEST_LOOKBACK_MINS * 60_000).toISOString();
      const { data: winData, error: winError } = await supabase
        .from('yata_snapshots')
        .select('item_id, destination, quantity, buy_price, snapped_at')
        .in('item_id', itemIds)
        .gte('snapped_at', cutoffLatest)
        .order('snapped_at', { ascending: false });
      if (!winError && Array.isArray(winData)) {
        for (const row of winData) {
          const key = `${row.item_id}|${row.destination}`;
          if (!latestMap.has(key)) latestMap.set(key, row); // desc → first wins
        }
      }
      // On a read error we fall through with an empty map: worst case is one
      // duplicate-minute row that the unique index discards anyway.
    }
  }

  // Record only transitions — a re-observation of the same quantity AND
  // price carries no signal (this is the whole reason the table is small).
  // Stale-guard: a reading whose observation time isn't strictly newer
  // than the freshest stored row is the SAME data we already have (or
  // older than a PDA scrape that beat us to it) — writing it would
  // register a phantom transition dated at the wrong time.
  const changed = yataRows.filter((r) => {
    const prev = latestMap.get(`${r.item_id}|${r.destination}`);
    if (!prev) return true;
    if (r.observed_ms != null && prev.snapped_at) {
      const prevMs = new Date(prev.snapped_at).getTime();
      if (Number.isFinite(prevMs) && r.observed_ms <= prevMs) return false;
    }
    return prev.quantity !== r.quantity || (prev.buy_price ?? null) !== (r.buy_price ?? null);
  });

  if (changed.length === 0) {
    return json({ ok: true, scanned: yataRows.length, snapshots: 0, restocks: 0 });
  }

  let snapshotsWritten = 0;
  {
    // snapped_at = observation time when YATA provided one; otherwise omit
    // and let the DB default (now()) apply.
    const rows = changed.map((r) => ({
      item_id: r.item_id,
      destination: r.destination,
      quantity: r.quantity,
      buy_price: r.buy_price,
      ...(r.observed_ms != null
        ? { snapped_at: new Date(r.observed_ms).toISOString() }
        : {}),
    }));
    const { error } = await supabase
      .from('yata_snapshots')
      .upsert(rows, { onConflict: 'item_id,destination,snapped_minute', ignoreDuplicates: true });
    if (error) return json({ error: 'snapshot_write_failed', detail: error.message }, 500);
    snapshotsWritten = rows.length;
  }

  // Emit a restock event for any strictly-positive quantity delta. source
  // 'cron' distinguishes these from client ('snapshot') and trigger writes;
  // all non-'backfill' sources feed the cadence estimator.
  //
  // restocked_at = observation time, not poll time: the client-side
  // estimator resolves the refill to a quarter-hour tick inside the
  // (pre_observed_at, restocked_at] window, and stamping observation
  // times keeps that window as tight as YATA's own data allows. It also
  // makes concurrent observers of the same YATA update collapse in the
  // restocked_minute dedup index instead of double-logging one refill.
  const nowIso = new Date().toISOString();
  const restockEvents = [];
  for (const r of changed) {
    const prev = latestMap.get(`${r.item_id}|${r.destination}`);
    if (prev && r.quantity > prev.quantity) {
      restockEvents.push({
        item_id: r.item_id,
        destination: r.destination,
        restocked_at: r.observed_ms != null ? new Date(r.observed_ms).toISOString() : nowIso,
        pre_observed_at: prev.snapped_at ?? null,
        pre_qty: prev.quantity,
        post_qty: r.quantity,
        source: 'cron',
      });
    }
  }
  let restocksWritten = 0;
  if (restockEvents.length > 0) {
    const { error } = await supabase
      .from('restock_events')
      .upsert(restockEvents, { onConflict: 'item_id,destination,restocked_minute', ignoreDuplicates: true });
    // A restock-event failure is non-fatal: the snapshot already landed and
    // a later poll re-detects the elevated quantity as a fresh transition.
    if (!error) restocksWritten = restockEvents.length;
  }

  // Keep the snapshot table bounded. Best-effort — a failed prune self-heals
  // on the next run.
  const pruneCutoff = new Date(Date.now() - PRUNE_OLDER_THAN_MINS * 60_000).toISOString();
  await supabase.from('yata_snapshots').delete().lt('snapped_at', pruneCutoff);

  return json({
    ok: true,
    scanned: yataRows.length,
    snapshots: snapshotsWritten,
    restocks: restocksWritten,
  });
});
