-- Positions execution columns.
--
-- Adds order fill tracking so the trade function can record what was
-- actually filled on each leg after auto-execution, and widens the
-- status CHECK to include 'partial' and 'failed'.

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS kalshi_order_id text,
  ADD COLUMN IF NOT EXISTS poly_order_id text,
  ADD COLUMN IF NOT EXISTS kalshi_fill_price numeric,
  ADD COLUMN IF NOT EXISTS poly_fill_price numeric,
  ADD COLUMN IF NOT EXISTS kalshi_fill_quantity integer,
  ADD COLUMN IF NOT EXISTS poly_fill_quantity integer,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz;

-- Normalise any legacy uppercase statuses to lowercase before tightening
-- the check constraint.
UPDATE positions
  SET status = lower(status)
  WHERE status NOT IN ('pending','open','partial','settled','cancelled','failed');

-- Replace the check constraint with the full set of valid statuses.
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_status_check;
ALTER TABLE positions ADD CONSTRAINT positions_status_check
  CHECK (status IN ('pending','open','partial','settled','cancelled','failed'));
