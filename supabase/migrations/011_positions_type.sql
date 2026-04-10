-- Trade type column for positions.
-- 'arb'        = two-leg cross-platform arbitrage (default)
-- 'resolution' = single-leg buy of a guaranteed winning contract
-- 'manual'     = manually entered position

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS trade_type text
    NOT NULL DEFAULT 'arb'
    CHECK (trade_type IN ('arb', 'resolution', 'manual'));

-- Resolution opportunities: logged by the resolve function so trade.ts
-- can look them up when a user taps [✅ Execute] on a resolution alert.
CREATE TABLE IF NOT EXISTS resolution_opportunities (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform        text        NOT NULL,
  market_id       text        NOT NULL,
  market_title    text        NOT NULL,
  winning_side    text        NOT NULL,
  winning_ask     numeric     NOT NULL,
  estimated_profit_pct numeric NOT NULL,
  detected_at     timestamptz DEFAULT now(),
  executed        boolean     DEFAULT false,
  expired         boolean     DEFAULT false,
  UNIQUE(platform, market_id)
);
