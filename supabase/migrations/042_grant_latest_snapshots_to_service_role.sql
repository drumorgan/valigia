-- Migration 042 — grant get_latest_yata_snapshots() to service_role
--
-- Forecast model v3 switches both snapshot writers — the client's
-- recordSnapshots() and the cron-snapshot-yata edge function — from a
-- windowed "latest reading per shelf" query (which silently truncated at
-- PostgREST's 1000-row page and missed quiet shelves) to the DISTINCT ON
-- RPC added in migration 041. That migration granted execute to anon +
-- authenticated for the web fallback path; the cron runs as service_role,
-- so it needs its own grant. Harmless if execute was already inherited.
--
-- Run this in the Supabase Dashboard SQL Editor.

grant execute on function get_latest_yata_snapshots() to service_role;
