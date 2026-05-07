-- Migration 031: schedule the daily TornExchange trader pool refresh.
--
-- Wires up pg_cron + pg_net to call the cron-refresh-traders edge
-- function once a day at 00:05 UTC (5 min after midnight Torn Time).
-- Torn's daily price update happens at 00:00 UTC; the offset gives
-- TornExchange traders a moment to publish their new buy offers
-- before we re-scrape the whole pool.
--
-- The cron secret + target URL live in Supabase Vault (pgsodium-
-- encrypted at rest), not in custom Postgres GUCs. The SQL Editor's
-- `postgres` role on Supabase doesn't have permission to do
-- `ALTER DATABASE postgres SET app.foo = ...` for custom variables,
-- so a Vault-based read is the canonical Supabase pattern.
--
-- BEFORE running this migration, do these in order:
--
-- 1) Generate a strong random secret (any 32+ chars):
--      openssl rand -base64 32
--
-- 2) In the Supabase Dashboard, set TWO Edge Function secrets:
--      Edge Functions → Secrets:
--        CRON_SECRET           = <the secret from step 1>
--        SERVICE_TORN_API_KEY  = <any working Torn API key — your own
--                                 is fine; only used for the public
--                                 items catalog endpoint>
--
-- 3) Deploy the cron-refresh-traders edge function.
--
-- 4) In the SQL Editor, store the SAME secret + your project's edge-
--    function URL in Supabase Vault. Replace the placeholders with
--    your real values:
--
--      SELECT vault.create_secret(
--        '<the same secret from step 1>',
--        'cron_secret'
--      );
--      SELECT vault.create_secret(
--        'https://<your-project-ref>.supabase.co/functions/v1/cron-refresh-traders',
--        'cron_target_url'
--      );
--
--    Already created and need to rotate? Drop and re-create:
--      DELETE FROM vault.secrets WHERE name = 'cron_secret';
--      SELECT vault.create_secret('<new secret>', 'cron_secret');
--    pg_cron picks up the new value on its next run.
--
-- 5) Then run this migration.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent: drop any previous schedule before re-creating, so this
-- migration can be re-run safely if the cron expression or auth shape
-- changes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-te-traders') THEN
    PERFORM cron.unschedule('refresh-te-traders');
  END IF;
END $$;

SELECT cron.schedule(
  'refresh-te-traders',
  '5 0 * * *',  -- 00:05 UTC daily
  $cron$
  SELECT net.http_post(
    url := (
      SELECT decrypted_secret
      FROM vault.decrypted_secrets
      WHERE name = 'cron_target_url'
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
    timeout_milliseconds := 300000
  );
  $cron$
);
