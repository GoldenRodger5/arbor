-- Resolve cron job — runs every 5 minutes to check for settled positions,
-- auto-execute resolution arbs, and free capital back to the pool.
--
-- Setup: run this SQL in the Supabase SQL editor after replacing
-- YOUR_SERVICE_ROLE_KEY with the actual service role key.
--
-- To remove: select cron.unschedule('arbor-resolve');

select cron.schedule(
  'arbor-resolve',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://vhjgrwjuzbxdqilordeb.supabase.co/functions/v1/resolve',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body := '{}'::jsonb
  ) as request_id;
  $$
);
