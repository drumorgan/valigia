-- Migration 034 — pda_prefs (per-player PDA userscript preferences)
--
-- Lets a player control the PDA userscript's visual surfaces from the
-- website. First (and currently only) preference: show_indicators.
--   true  (default) — the userscript paints its full UI: travel overlay,
--                     watchlist / deals / flash bars, toasts, badges.
--   false           — "silent mode": every visual surface is suppressed,
--                     but all scraping + ingest paths keep running so the
--                     player still contributes prices to the shared pool.
--
-- Why a table instead of localStorage: the website lives on
-- valigia.girovagabondo.com and the userscript runs on torn.com — two
-- origins that cannot share localStorage. Supabase is the only channel
-- the two surfaces already share.
--
-- Trust model: identical to watchlist_alerts. player_id is a public Torn
-- identifier, so anon writes would let anyone flip anyone else's setting.
-- Writes flow exclusively through the `pda-prefs` edge function, which
-- validates {player_id, session_token} against player_secrets the same
-- way auto-login does, then does a service-role upsert. Reads are public:
-- the row contains nothing sensitive, and the userscript polls it with a
-- plain anon SELECT (cached client-side for 60 s).
--
-- Run this in the Supabase Dashboard SQL Editor.

create table pda_prefs (
  player_id        integer primary key,
  show_indicators  boolean not null default true,
  updated_at       timestamptz not null default now()
);

alter table pda_prefs enable row level security;

-- Public read only. Writes are service-role via the pda-prefs edge fn.
create policy "Anyone can read pda prefs"
  on pda_prefs for select using (true);
