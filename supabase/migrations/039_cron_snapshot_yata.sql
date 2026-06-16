-- Migration 039: schedule the YATA snapshot poller.
--
-- Wires up pg_cron + pg_net to call the cron-snapshot-yata edge function
-- every 5 minutes. That function polls the YATA travel export and writes
-- yata_snapshots + restock_events server-side, so depletion slopes and
-- restock cadence build from a dense time series regardless of how many
-- users are active. Until now those tables were only written on user
-- activity (web recordSnapshots(), the abroad_prices trigger, PDA
-- drip/stakeout), which left the forecast columns empty at low traffic.
--
-- Auth + secret storage follow migration 031 exactly: a shared CRON_SECRET
-- (Edge Function secret + Vault copy) gates the call, and the target URL
-- lives in Vault too — the SQL Editor's postgres role can't set custom
-- ALTER DATABASE GUCs, so Vault is the canonical Supabase pattern.
--
-- BEFORE running this migration, do these in order:
--
-- 1) CRON_SECRET is already set if you ran migration 031. If not, generate
--    one (openssl rand -base64 32) and set it as an Edge Function secret:
--      Edge Functions → Secrets:  CRON_SECRET = <secret>
--
-- 2) Deploy the cron-snapshot-yata edge function.
--
-- 3) In the SQL Editor, store the secret (skip if migration 031 already
--    created 'cron_secret') and this function's URL in Vault. Replace the
--    placeholders with your real values:
--
--      -- only if not already present from migration 031:
--      SELECT vault.create_secret('<the CRON_SECRET value>', 'cron_secret');
--
--      SELECT vault.create_secret(
--        'https://<your-project-ref>.supabase.co/functions/v1/cron-snapshot-yata',
--        'snapshot_yata_url'
--      );
--
--    Need to rotate the URL later? Drop and re-create:
--      DELETE FROM vault.secrets WHERE name = 'snapshot_yata_url';
--      SELECT vault.create_secret('<new url>', 'snapshot_yata_url');
--    pg_cron picks up the new value on its next run.
--
-- 4) Then run this migration.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent: drop any previous schedule before re-creating, so this
-- migration can be re-run safely if the cron expression or auth shape
-- changes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'snapshot-yata') THEN
    PERFORM cron.unschedule('snapshot-yata');
  END IF;
END $$;

SELECT cron.schedule(
  'snapshot-yata',
  '*/5 * * * *',  -- every 5 minutes
  $cron$
  SELECT net.http_post(
    url := (
      SELECT decrypted_secret
      FROM vault.decrypted_secrets
      WHERE name = 'snapshot_yata_url'
      LIMIT 1
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'cron_secret'
        LIMIT 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
