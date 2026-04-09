-- Positions table schema extensions for the Telegram alert + HIL flow.
--
-- The alert system inserts a "pending" row into positions when the user
-- taps [✅ Execute] in Telegram, then flips it to "open" when the user
-- confirms both legs were filled via /done_{uuid}. The original schema
-- had status CHECK ('OPEN','SETTLED','DISPUTED') uppercase with no
-- references to the originating markets except via pair_id. The alert
-- flow logs the opportunity WITHOUT a market_pairs row (the pair may
-- not have been persisted by the verifier yet), so we also need direct
-- kalshi/poly market id + title columns.

-- Drop old check so we can add lowercase statuses. Keep the old
-- uppercase values in the new CHECK so existing rows remain valid.
alter table positions drop constraint if exists positions_status_check;

alter table positions alter column status set default 'pending';

alter table positions add constraint positions_status_check
  check (status in (
    'pending','open','settled','cancelled',
    'OPEN','SETTLED','DISPUTED'
  ));

alter table positions
  add column if not exists kalshi_market_id text,
  add column if not exists kalshi_title text,
  add column if not exists poly_market_id text,
  add column if not exists poly_title text,
  add column if not exists intended_kalshi_side text,
  add column if not exists intended_poly_side text,
  add column if not exists opportunity_id text;
