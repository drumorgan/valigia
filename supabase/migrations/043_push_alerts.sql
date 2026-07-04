-- Migration 043 — Web Push departure alerts: subscriptions + alert configs
--
-- Two tables powering "leave in X" push notifications that reach the
-- player's device (installed-PWA Web Push, iOS 16.4+) even with the tab
-- closed:
--
--   push_subscriptions — one row per browser push endpoint. The endpoint
--     URL + p256dh/auth keys are effectively bearer credentials for
--     sending that device notifications, so this table is SERVICE-ROLE
--     ONLY: RLS enabled with no anon policies. All writes go through the
--     `push-alerts` edge function (session-token gated, same trust model
--     as `watchlist`).
--
--   departure_alerts — per-player per-shelf alert configs. `lead_mins` is
--     computed client-side at creation (one-way flight time with the
--     player's multiplier applied, plus a small shopping buffer) so the
--     cron sender never needs flight tables or per-player perk state:
--     it just fires when now ≈ predicted_restock − lead_mins.
--     `last_notified_restock_at` stores the predicted refill time the
--     last notification was sent for — the dedupe that stops the 5-min
--     cron from re-firing for the same physical restock. Public-read
--     like watchlist_alerts (no secrets, just item interest); writes via
--     the edge function only.
--
-- Run this in the Supabase Dashboard SQL Editor.

create table if not exists push_subscriptions (
  endpoint    text        primary key,
  player_id   bigint      not null,
  p256dh      text        not null,
  auth        text        not null,
  fail_count  integer     not null default 0,
  last_ok_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_player
  on push_subscriptions (player_id);

alter table push_subscriptions enable row level security;
-- No policies on purpose: service-role only.

create table if not exists departure_alerts (
  player_id                 bigint      not null,
  item_id                   integer     not null,
  item_name                 text        not null,
  destination               text        not null,
  lead_mins                 integer     not null,
  active                    boolean     not null default true,
  last_notified_restock_at  timestamptz,
  created_at                timestamptz not null default now(),
  primary key (player_id, item_id, destination)
);

-- Cron sender's hot path: all active alerts.
create index if not exists idx_departure_alerts_active
  on departure_alerts (active) where active;

alter table departure_alerts enable row level security;

create policy "Anyone can read departure alerts"
  on departure_alerts for select using (true);
-- Writes: service-role only (push-alerts edge function).
