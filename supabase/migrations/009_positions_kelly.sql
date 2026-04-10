-- Kelly criterion sizing columns for positions and capital_ledger.

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS kelly_fraction            numeric,
  ADD COLUMN IF NOT EXISTS limiting_factor           text,
  ADD COLUMN IF NOT EXISTS active_capital_at_execution numeric;

ALTER TABLE capital_ledger
  ADD COLUMN IF NOT EXISTS last_trade_at timestamptz;
