-- Migration 031: schedule the daily TornExchange trader pool refresh.
--
-- Wires up pg_cron + pg_net to call the cron-refresh-traders edge
-- function once a day. Torn's daily price update happens at 00:00 UTC
-- (= midnight Torn Time); the 5-minute offset gives traders a moment
-- to publish new buy offers before we re-scrape the whole pool.
--
-- BEFORE running this migration, do these in order:
--
-- 1) Generate a strong random secret (any 32+ chars), e.g.:
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
-- 4) In the SQL Editor, set TWO database parameters with the same
--    secret and your project's edge-function URL. These persist across
--    pg_cron worker sessions and are what the schedule below reads at
--    runtime — keeping the secret out of the migration history.
--
--      ALTER DATABASE postgres
--        SET app.cron_secret = '<the same secret from step 1>';
--      ALTER DATABASE postgres
--        SET app.cron_target_url =
--          'https://<your-project-ref>.supabase.co/functions/v1/cron-refresh-traders';
--
--    To rotate later, just re-run the ALTER DATABASE — pg_cron picks up
--    new values on its next worker session.
--
-- 5) Then run this migration.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent: drop any previous schedule before re-creating, so this
-- migration can be re-run safely if the cron expression changes.
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
    url := current_setting('app.cron_target_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $cron$
);
