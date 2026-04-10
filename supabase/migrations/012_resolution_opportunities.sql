-- Resolution opportunities table.
-- Logged by the resolve function when a mispriced winning contract is found.
-- Looked up by trade.ts when a user taps [✅ Execute] on a resolution alert.

CREATE TABLE IF NOT EXISTS resolution_opportunities (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform             text        NOT NULL,
  market_id            text        NOT NULL,
  market_title         text        NOT NULL,
  winning_side         text        NOT NULL,
  winning_ask          numeric     NOT NULL,
  estimated_profit_pct numeric     NOT NULL,
  detected_at          timestamptz DEFAULT now(),
  executed             boolean     DEFAULT false,
  expired              boolean     DEFAULT false,
  UNIQUE(platform, market_id)
);
