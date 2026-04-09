-- Polarity columns for market_pairs.
--
-- Adds the four fields the polarity-aware Claude verifier writes per pair.
-- The bug this fixes: scanner used to assign Polymarket clobTokenIds[0] to
-- "yesTokenId" purely by index. For markets like A's vs Yankees the index
-- 0 token paid out for Athletics, NOT for the question's grammatical YES
-- side, so the calculator computed a fake 57% spread on what was actually
-- a directional bet. Now Claude reads the outcome labels and tells us
-- which Poly outcome corresponds to Kalshi YES; the cache stores the
-- HEDGE side (the one we'd actually buy on Polymarket as the hedge for
-- Kalshi YES) so subsequent scans can re-use it.

alter table market_pairs
  add column if not exists kalshi_yes_meaning text,
  add column if not exists poly_hedge_outcome_label text,
  add column if not exists poly_hedge_token_id text,
  add column if not exists polarity_confirmed boolean default false;
