-- Valigia — Initial Schema
-- Run this in the Supabase Dashboard SQL Editor

-- ═══════════════════════════════════════════════════════════════
-- 1. abroad_prices — crowd-sourced buy prices from player logs
-- ═══════════════════════════════════════════════════════════════
create table abroad_prices (
  id           uuid primary key default gen_random_uuid(),
  item_name    text not null,
  item_id      integer not null,
  destination  text not null,
  buy_price    integer not null,
  reported_at  timestamptz not null,
  torn_id      integer,
  unique (item_id, destination)
);

alter table abroad_prices enable row level security;

create policy "Anyone can read abroad prices"
  on abroad_prices for select using (true);

create policy "Anyone can upsert abroad prices"
  on abroad_prices for insert with check (true);

create policy "Anyone can update abroad prices"
  on abroad_prices for update using (true);

-- ═══════════════════════════════════════════════════════════════
-- 2. player_secrets — AES-256-GCM encrypted API keys
-- ═══════════════════════════════════════════════════════════════
create table player_secrets (
  torn_player_id  integer primary key,
  api_key_enc     text not null,
  api_key_iv      text not null,
  key_version     integer not null default 1,
  updated_at      timestamptz not null default now()
);

alter table player_secrets enable row level security;

-- No client-side access — only Edge Functions with service role key
-- (RLS enabled with no policies = deny all from anon/authenticated)

-- ═══════════════════════════════════════════════════════════════
-- 3. secret_audit_log — tracks all key encrypt/decrypt operations
-- ═══════════════════════════════════════════════════════════════
create table secret_audit_log (
  id               uuid primary key default gen_random_uuid(),
  torn_player_id   integer not null,
  action           text not null,        -- 'set', 'decrypt_used', 'invalidated'
  edge_function    text not null,
  created_at       timestamptz not null default now()
);

alter table secret_audit_log enable row level security;

-- No client-side access — service role only
