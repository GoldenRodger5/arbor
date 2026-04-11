-- Add alerted_at column to spread_events for 6-hour refire dedup.
-- was_alerted exists but alerted_at was missing, causing the cooldown
-- to never fire (event.alerted_at always null).
ALTER TABLE spread_events
  ADD COLUMN IF NOT EXISTS alerted_at timestamptz;
