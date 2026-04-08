-- Arbor scanner cron job — runs the edge function every 5 minutes.
--
-- ONE-TIME SETUP (do this manually in the Supabase dashboard):
--
-- 1. Open: https://supabase.com/dashboard/project/vhjgrwjuzbxdqilordeb/database/extensions
--    Enable both extensions:
--      - pg_cron
--      - pg_net
--
-- 2. Open: https://supabase.com/dashboard/project/vhjgrwjuzbxdqilordeb/sql/new
--    Paste and run the SQL below.
--
--    IMPORTANT: Replace YOUR_SERVICE_ROLE_KEY below with the actual
--    service role key from:
--    https://supabase.com/dashboard/project/vhjgrwjuzbxdqilordeb/settings/api
--    (look for "service_role" — it's a long JWT, NOT the anon key)
--
-- 3. To remove the schedule later, run:
--      select cron.unschedule('arbor-scanner');

select cron.schedule(
  'arbor-scanner',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://vhjgrwjuzbxdqilordeb.supabase.co/functions/v1/scanner',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body := '{}'::jsonb
  ) as request_id;
  $$
);
