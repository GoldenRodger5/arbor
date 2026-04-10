-- Spread persistence tracking.
-- Logs each open spread event from first detection through close,
-- enabling analysis of execution windows, spread decay, and alert timing.

CREATE TABLE IF NOT EXISTS spread_events (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id             text        NOT NULL,
  kalshi_market_id    text        NOT NULL,
  poly_market_id      text        NOT NULL,
  kalshi_title        text        NOT NULL,
  first_detected_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  first_net_spread    numeric     NOT NULL,
  peak_net_spread     numeric     NOT NULL,
  last_net_spread     numeric     NOT NULL,
  scan_count          integer     NOT NULL DEFAULT 1,
  closed_at           timestamptz,
  duration_seconds    integer,
  was_alerted         boolean     DEFAULT false,
  was_executed        boolean     DEFAULT false,
  closing_reason      text,
  source              text        NOT NULL DEFAULT 'scanner',
  CHECK (source IN ('scanner', 'fastpoll'))
);

CREATE INDEX IF NOT EXISTS spread_events_pair_idx
  ON spread_events(pair_id);
CREATE INDEX IF NOT EXISTS spread_events_first_detected_idx
  ON spread_events(first_detected_at DESC);
CREATE INDEX IF NOT EXISTS spread_events_open_idx
  ON spread_events(closed_at)
  WHERE closed_at IS NULL;
