-- ESPN live game state columns for known_game_markets.
ALTER TABLE known_game_markets
  ADD COLUMN IF NOT EXISTS last_score text,
  ADD COLUMN IF NOT EXISTS last_score_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS espn_game_id text;
