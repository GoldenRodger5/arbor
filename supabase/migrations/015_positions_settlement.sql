-- Settlement tracking columns for positions.
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS realized_pnl numeric,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_kalshi_result text,
  ADD COLUMN IF NOT EXISTS settlement_poly_result text;
