-- Valigia — Session token for auto-login
--
-- Background: until now, `auto-login` only required a `player_id`, which is a
-- public Torn identifier. Anyone who knew (or guessed) a victim's player ID
-- could hit the edge function and be handed a valid session for that player.
--
-- This migration adds a per-key random session token. `set-api-key` mints a
-- 32-byte random token, stores ONLY its SHA-256 hash here, and returns the
-- raw token to the client (put in localStorage alongside `player_id`).
-- `auto-login` requires both fields; server re-hashes the submitted token
-- and compares in constant time before decrypting.
--
-- Storing the hash (not the token itself) means a DB leak does not hand an
-- attacker working sessions — same principle as storing password hashes.
--
-- Run this in the Supabase Dashboard SQL Editor.

alter table player_secrets
  add column if not exists session_token_hash      text,
  add column if not exists session_token_created_at timestamptz;

-- Lookup shape used by auto-login: scoped by player_id, matched by hash.
create index if not exists player_secrets_token_lookup
  on player_secrets (torn_player_id, session_token_hash);
