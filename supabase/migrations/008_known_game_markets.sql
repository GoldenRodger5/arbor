-- known_game_markets: cache of all game-winner prediction markets seen by
-- fastpoll across Kalshi and Polymarket. Used to detect new markets and
-- suppress duplicate Telegram alerts.

CREATE TABLE IF NOT EXISTS known_game_markets (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform       text        NOT NULL,
  market_id      text        NOT NULL,
  title          text        NOT NULL,
  close_time     timestamptz,
  sport_league   text,
  home_team      text,
  away_team      text,
  game_date      date,
  first_seen_at  timestamptz DEFAULT now(),
  last_spread_pct numeric,
  last_checked_at timestamptz,
  alerted_at     timestamptz,
  UNIQUE(platform, market_id)
);

CREATE INDEX IF NOT EXISTS known_game_markets_platform_idx
  ON known_game_markets(platform);
CREATE INDEX IF NOT EXISTS known_game_markets_close_time_idx
  ON known_game_markets(close_time);
