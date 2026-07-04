-- Migration 044: schedule the departure-alert push sender.
--
-- Wires pg_cron + pg_net to call the cron-send-alerts edge function every
-- 5 minutes. That function recomputes restock predictions server-side
-- (same v3 math as the client, via the _shared/forecast-math.js mirror),
-- finds departure_alerts whose leave-by moment falls inside the current
-- window, and Web-Pushes "Leave for <dest> now" to every subscribed
-- device of that player. 5 min matches the snapshot poller — predictions
-- move on quarter-hour ticks, and lead times are flight-length (hours),
-- so finer scheduling buys nothing.
--
-- Auth + secret storage follow migrations 031/039 exactly (CRON_SECRET
-- Bearer + Vault-stored URL).
--
-- BEFORE running this migration, do these in order:
--
-- 1) CRON_SECRET already exists if you ran 031/039. Additionally set the
--    Web Push VAPID keys as Edge Function secrets (Dashboard → Edge
--    Functions → Secrets):
--      VAPID_PUBLIC_KEY  = <public key baked into src/push.js>
--      VAPID_PRIVATE_KEY = <matching private key>
--      VAPID_SUBJECT     = mailto:<your email>
--
-- 2) Deploy the push-alerts and cron-send-alerts edge functions.
--
-- 3) In the SQL Editor, store this function's URL in Vault:
--
--      SELECT vault.create_secret(
--        'https://<your-project-ref>.supabase.co/functions/v1/cron-send-alerts',
--        'send_alerts_url'
--      );
--
-- 4) Then run this migration.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-alerts') THEN
    PERFORM cron.unschedule('send-alerts');
  END IF;
END $$;

SELECT cron.schedule(
  'send-alerts',
  '*/5 * * * *',  -- every 5 minutes
  $cron$
  SELECT net.http_post(
    url := (
      SELECT decrypted_secret
      FROM vault.decrypted_secrets
      WHERE name = 'send_alerts_url'
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
