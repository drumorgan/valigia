#!/usr/bin/env node
// Restock-timing backtest — replays the v2 and v3 cadence estimators over
// the real restock_events history, out-of-sample: at each event i (with at
// least 3 prior events), predict the time of event i+1 using ONLY events
// [0..i], then score the prediction against what actually happened.
//
// Usage:
//   node scripts/backtest.mjs                # live data (needs env, below)
//   node scripts/backtest.mjs --synthetic    # self-test on generated shelves
//   node scripts/backtest.mjs --days 14      # narrower window (default 30)
//
// Live mode reads VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY from the
// environment or a .env file in the repo root (same vars the app builds
// with). Read-only: one paginated GET against restock_events.
//
// Scope note: this scores the CADENCE path (median-interval prediction).
// The half-sellout path needs yata_snapshots zero-crossings, which are
// pruned at 48 h — too short a window to backtest meaningfully from a
// snapshot pull. The forecast_predictions accuracy pipeline (migrations
// 035/037/038) is the ground truth for the full model; this script exists
// to iterate on estimator variants offline without waiting days for the
// pipeline to accumulate resolved predictions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  estimateNextRestock,
  effectiveRestockTime,
} from '../src/forecast-math.js';

const MIN = 60_000;

// ── v2 reference estimator (frozen) ──────────────────────────────────
// The pre-tick-attribution model, kept here verbatim-in-spirit so the
// backtest always compares against the same baseline: censoring-window
// midpoint times, 120-min gap cap, timeToNext = max(0, median − sinceLast).
function estimateNextRestockV2(events, nowMs) {
  if (!events || events.length < 2) return null;
  const effTimes = events.map(e =>
    (e.preTime != null && e.preTime < e.atTime)
      ? (e.preTime + e.atTime) / 2
      : e.atTime
  );
  const gaps = [];
  for (let i = 1; i < effTimes.length; i++) {
    const g = (effTimes[i] - effTimes[i - 1]) / MIN;
    if (g > 0 && g <= 120) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const medianInterval = sorted[Math.floor(sorted.length / 2)];
  if (!(medianInterval > 0)) return null;
  const lastRestockAt = effTimes[effTimes.length - 1];
  const sinceLastMins = (nowMs - lastRestockAt) / MIN;
  return { timeToNextMins: Math.max(0, medianInterval - sinceLastMins) };
}

// ── Data loading ─────────────────────────────────────────────────────

function loadEnv() {
  const env = { ...process.env };
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* no .env — rely on process.env */ }
  return env;
}

async function fetchRestockEvents(days) {
  const env = loadEnv();
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (env or .env).');
    process.exit(1);
  }
  const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const rows = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const q = `${url}/rest/v1/restock_events`
      + `?select=item_id,destination,restocked_at,pre_observed_at,post_qty,source`
      + `&restocked_at=gte.${cutoff}&source=neq.backfill`
      + `&order=restocked_at.asc&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      console.error(`Supabase read failed: HTTP ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

// ── Synthetic shelves for the self-test ──────────────────────────────
// Deterministic PRNG so runs are reproducible.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticEvents() {
  const rand = mulberry32(42);
  const rows = [];
  const base = Date.UTC(2026, 5, 1);
  const shelves = [
    { item: 206, dest: 'Japan', cycleMins: 45, jitterTicks: 1 },   // fast
    { item: 260, dest: 'UAE', cycleMins: 150, jitterTicks: 2 },    // medium
    { item: 264, dest: 'Switzerland', cycleMins: 630, jitterTicks: 4 }, // slow (old 120m cap killed these)
  ];
  for (const s of shelves) {
    let t = base;
    for (let i = 0; i < 60; i++) {
      // true refill lands on a tick near the nominal cycle
      const jitter = (Math.floor(rand() * (2 * s.jitterTicks + 1)) - s.jitterTicks) * 15;
      t += Math.max(15, s.cycleMins + jitter) * MIN;
      const tick = Math.round(t / (15 * MIN)) * (15 * MIN);
      // observed via ~5-min sampling: pre a few min before, post a few after
      const preLead = 1 + rand() * 5;
      const postLag = 1 + rand() * 5;
      // ~10% missed observations (hole swallows the event entirely)
      if (rand() < 0.1) continue;
      rows.push({
        item_id: s.item,
        destination: s.dest,
        restocked_at: new Date(tick + postLag * MIN).toISOString(),
        pre_observed_at: new Date(tick - preLead * MIN).toISOString(),
        post_qty: 500,
        source: 'cron',
      });
    }
  }
  return rows;
}

// ── Replay ───────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function replay(rows, minPrior = 3) {
  const byShelf = new Map();
  for (const r of rows) {
    const key = `${r.item_id}|${r.destination}`;
    if (!byShelf.has(key)) byShelf.set(key, []);
    byShelf.get(key).push({
      atTime: new Date(r.restocked_at).getTime(),
      preTime: r.pre_observed_at ? new Date(r.pre_observed_at).getTime() : null,
      postQty: r.post_qty,
    });
  }

  // Paired scoring: a model that declines to predict on hard shelves
  // (v2's 120-min gap cap silently skips every slow shelf) would look
  // artificially good in an unpaired median — it only ever answers the
  // easy questions. So the head-to-head uses ONLY cases where both
  // models committed to a prediction, and coverage is reported
  // separately: predicting on a shelf v2 couldn't touch is exactly the
  // point of the 24 h cap.
  const paired = { v2: [], v3: [] };
  const v3Only = [];
  let cases = 0;
  let shelves = 0;
  for (const [, events] of byShelf) {
    events.sort((a, b) => a.atTime - b.atTime);
    if (events.length < minPrior + 2) continue;
    shelves++;
    for (let i = minPrior; i < events.length - 1; i++) {
      const known = events.slice(0, i + 1);
      // Predict just after observing event i.
      const nowMs = known[known.length - 1].atTime + 1 * MIN;
      // Ground truth: tick-attributed time of the next event (best
      // available estimate of when the refill really landed).
      const actualMs = effectiveRestockTime(events[i + 1]);
      if (actualMs <= nowMs) continue; // duplicate observer / same refill
      cases++;

      const v2 = estimateNextRestockV2(known, nowMs);
      const v3 = estimateNextRestock(known, nowMs);
      const err = (est) => Math.abs((nowMs + est.timeToNextMins * MIN) - actualMs) / MIN;
      if (v2 && v3) {
        paired.v2.push(err(v2));
        paired.v3.push(err(v3));
      } else if (v3) {
        v3Only.push(err(v3));
      }
    }
  }
  return { paired, v3Only, cases, shelves };
}

function report(label, errs) {
  const s = errs.slice().sort((a, b) => a - b);
  const fmt = (v) => (v == null ? '—' : `${v.toFixed(1)}m`);
  console.log(
    `  ${label.padEnd(4)} n=${String(s.length).padStart(5)}  ` +
    `median=${fmt(percentile(s, 0.5))}  p75=${fmt(percentile(s, 0.75))}  p90=${fmt(percentile(s, 0.9))}`
  );
  return percentile(s, 0.5);
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const synthetic = args.includes('--synthetic');
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) || 30 : 30;

const rows = synthetic ? syntheticEvents() : await fetchRestockEvents(days);
console.log(`${synthetic ? 'Synthetic' : `Live (${days}d)`}: ${rows.length} restock events`);

const { paired, v3Only, cases, shelves } = replay(rows);
console.log(`Shelves with enough history: ${shelves}; scoreable cases: ${cases}`);
console.log('\nHead-to-head — cases where BOTH models predicted:');
const m2 = report('v2', paired.v2);
const m3 = report('v3', paired.v3);

console.log('\nCoverage — v3 predictions on cases v2 declined (gap cap / slow shelves):');
report('v3+', v3Only);
const v2Cov = paired.v2.length;
const v3Cov = paired.v3.length + v3Only.length;
console.log(`  covered: v2 ${v2Cov}/${cases} (${((v2Cov / cases) * 100).toFixed(0)}%), ` +
            `v3 ${v3Cov}/${cases} (${((v3Cov / cases) * 100).toFixed(0)}%)`);

if (m2 != null && m3 != null) {
  const delta = ((m2 - m3) / m2) * 100;
  console.log(`\nv3 vs v2 paired median error: ${delta >= 0 ? '−' : '+'}${Math.abs(delta).toFixed(0)}%`);
  if (synthetic && (m3 > m2 * 1.05 || v3Cov < v2Cov)) {
    console.error('SELF-TEST FAIL: v3 must match v2 head-to-head and strictly extend coverage');
    process.exit(1);
  }
}
