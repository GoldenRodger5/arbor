-- Add skipped_at for deduplication cooldown tracking.
ALTER TABLE spread_events
  ADD COLUMN IF NOT EXISTS skipped_at timestamptz;
