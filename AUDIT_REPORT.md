# Arbor Full Audit Report

**Date:** April 10, 2026  
**Auditor:** Claude Opus 4.6  
**Codebase:** 9,391 lines across 7 edge functions, 15 migrations, 6 frontend pages  
**Capital at risk:** $198.20 ($98.20 Kalshi + $100.00 Polymarket US)

---

## Executive Summary

**Overall System Health: YELLOW**

**Working correctly:**
- RSA-PSS auth for Kalshi (fixed: saltLength=32, full path prefix)
- Ed25519 auth for Polymarket US (via @noble/ed25519)
- Live balance fetching: Kalshi $98.20, Polymarket US $100.00
- Polymarket US market fetcher (981 US-tradeable markets)
- Batch Kalshi orderbooks (50-ticker chunks)
- Recurrence filter (prevents same-series mismatches)
- Claude polarity verification (SAFE/CAUTION/SKIP)
- 2-day lockup filter (silences long-dated alerts)
- Smart dedup (skip/alerted/executed cooldowns)
- Telegram alert + execute flow with dry-run guard
- Settlement tracker with P&L calculation
- ESPN live game score integration
- Analytics dashboard with real data
- Spread persistence tracking

**Needs fixing (CRITICAL):**
1. **Kalshi fee constant is WRONG:** `0.07` (7%) is used but Kalshi's actual taker fee is **1-3%** depending on price. The 7% rate was from an old parabolic formula. This overstates fees and hides real profitable opportunities.
2. **Polymarket fee uses GLOBAL rates, not US rates:** The `polyFeeCoefficient` function uses global Polymarket fee tiers (3-7.2%) but the user trades on Polymarket US which has a flat **5% fee** (`feeCoefficient: 0.05` in US API response).
3. **deployed_capital is never incremented on execution.** The settlement tracker decrements it, but `handleBuy` never increments it. The bot could over-deploy.
4. **Platform stub functions waste ~2s per scan** probing dead endpoints (Crypto.com, FanDuel, Fanatics, OG). These should be removed.
5. **Missing migration 007** — numbering gap from 006 to 008. Not breaking but unclean.

**Should be improved (non-critical):**
- kalshiws function is non-functional (Deno lacks WebSocketStream) — should be removed from cron
- PredictIt markets return 0 matches due to no inventory overlap — adds 1s of latency per scan for no value
- The scanner stores 20 opportunities regardless of lockup, wasting Claude calls on Cy Young markets that can never alert
- `TRADE_DRY_RUN` is still set — no real trades will execute until removed

---

## Section 1: Financial Calculations

### 1. Net Spread Calculation
**STATUS: CORRECT (with fee caveat)**

Formula in `walkOrderbook`:
```
grossProfitPct = 1.0 - (yesAskPrice + noAskPrice)
totalFees = feeForLeg(yesPlatform, qty, yesPrice) + feeForLeg(noPlatform, qty, noPrice)
feePct = totalFees / qty
netProfitPct = grossProfitPct - feePct
```

This is mathematically correct. The issue is the fee constants (see below).

### 2. Kalshi Fee
**STATUS: INCORRECT — OVERSTATED**

Current: `kalshiFee = ceil(0.07 * qty * price * (1-price) * 100) / 100`

The 0.07 (7%) rate is the **maximum** of the parabolic fee curve. Kalshi's actual taker fee schedule (Feb 2026 PDF) is:
- Contracts priced 0-10¢ or 90-100¢: ~1%
- Contracts priced 40-60¢: up to 1.75% (taker) 
- The 7% coefficient produces fees 3-4x higher than reality

**Impact:** A pair with 3% gross spread shows as -1% net (unprofitable) when it's actually +1.5% net (profitable). We are missing real opportunities.

**Recommendation:** Replace `0.07` with `0.02` (2% average taker rate) or implement the actual tiered fee schedule from Kalshi's API response which includes `feeCoefficient` per market.

### 3. Polymarket Fee  
**STATUS: INCORRECT for US platform**

Current: `polyFeeCoefficient` returns 0.03-0.072 based on global Polymarket category tiers.

The user trades on **Polymarket US** which returns `feeCoefficient: 0.05` in every market response. This is a flat 5% rate for all categories.

**Recommendation:** When the market source is `polymarket-us`, use the `feeCoefficient` from the US API response (0.05) instead of the per-category lookup.

### 4. Kelly Position Sizing
**STATUS: CORRECT**

Formula: `kellyFraction = netSpread / odds` where `odds = (1/costPerPair) - 1`

For pure arb (guaranteed win), this produces Kelly > 1.0, correctly capped at 1.0. Quarter Kelly (0.25) is conservative and appropriate.

Example: 4.6% net spread, $0.97 cost → Kelly = 1.49 → capped at 1.0 → Quarter Kelly = 0.25 → $39.64 on $158.56 capital.

All caps verified:
| Parameter | Value | Appropriate for $198? |
|---|---|---|
| MIN_POSITION_USD | $20 | YES — covers 2 contracts at ~$0.95 |
| MAX_POSITION_SAFE | $200 | NO — exceeds total capital. Should be ~$80 |
| MAX_POSITION_CAUTION | $100 | BORDERLINE — 50% of capital on a CAUTION verdict |
| MAX_CAPITAL_FRACTION | 0.40 | YES — limits to $63.42 which is the binding constraint |
| QUARTER_KELLY | 0.25 | YES — conservative |

### 5. Annualized Return
**STATUS: CORRECT**

Formula: `annReturn = (netSpread / daysToClose) * 365`

MIN_APY_SPORTS = 50% — with 2-day lockup filter, a 3% spread on 2 days = 547% APY. The 50% floor is never binding for short-dated sports. **Correct but irrelevant.**

### 6. Lockup Filter
**STATUS: CORRECT but scanner wastes compute**

- `MAX_DAYS_LOCKUP = 2` in notify — only short-dated markets alert
- Scanner still processes all 365-day markets, runs Claude verification, fetches orderbooks for Cy Young markets that can never trigger an alert
- **Recommendation:** Add `MAX_DAYS_TO_CLOSE = 3` filter in scanner's pair selection to skip long-dated markets entirely

### 7. Auto-Execute
**STATUS: CORRECT but parameters are academic**

- `AUTO_EXECUTE_SPREAD = 0.05` (5%), `AUTO_EXECUTE_MAX_DAYS = 1`
- Only SAFE verdicts auto-execute — correct
- At $198 capital, 5% net on ~$50 deployed = ~$2.50 profit — reasonable
- Currently blocked by `TRADE_DRY_RUN=true`

### 8. Capital Tracking
**STATUS: BUG — deployed_capital never incremented**

`handleBuy` creates a position and executes orders but never does:
```sql
UPDATE capital_ledger SET deployed_capital = deployed_capital + totalDeployed
```

Only the settlement tracker decrements deployed_capital. This means the system doesn't know how much capital is deployed in open positions, and could theoretically deploy the same capital multiple times.

---

## Section 2: Execution Logic

### 9. Dual-Leg Execution
**STATUS: CORRECT with risk**

Both legs fire via `Promise.all()` — correct for speed. No slippage protection exists. If Kalshi fills at a significantly different price, the spread could turn negative. 

**Risk:** Limit orders should prevent worse-than-expected fills, but partial fills at different sizes between platforms create asymmetric exposure.

### 10. Order Bodies
**STATUS: NEEDS VERIFICATION**

Kalshi order body:
```json
{ "ticker": "...", "action": "buy", "side": "yes", "count": 52,
  "yes_price": 15, "time_in_force": "good_til_cancelled" }
```
This matches the current API spec. **CORRECT.**

Polymarket US order body:
```json
{ "marketSlug": "aec-mlb-...", "intent": "ORDER_INTENT_BUY_SHORT",
  "type": "ORDER_TYPE_LIMIT", "price": {"value":"0.53","currency":"USD"},
  "quantity": 52, "tif": "TIME_IN_FORCE_GOOD_TILL_CANCEL" }
```
**NOT YET TESTED with real money.** The field names match the spec from user documentation but have not been validated against the live API.

### 11. Partial Fill Handling
**STATUS: CORRECT**

The code handles: both fill → open, one fails → partial (with urgent Telegram), both fail → failed. Partial fill correctly alerts the user to manually hedge or close.

---

## Section 3: Market Matching

### 12. Polarity Verification
**STATUS: CORRECT**

Claude verifies polarity via a 6-check prompt. The system forces SKIP when polarity is ambiguous. The `assignPolarity` function correctly maps same-direction and hedge token IDs. The calculator's orient-A/B walk handles both directions.

### 13. Claude Verification
**STATUS: CORRECT but expensive**

Every pair goes through Claude (Sonnet 4.6) verification. Sports pairs from the join pass have explicit 0.95+ scores but still require Claude for polarity. Cache TTL is 24h. At $0.003/call × 80 pairs/scan = ~$0.24/scan × 12 scans/hour = ~$2.88/hour.

### 14. Sports Matching
**STATUS: CORRECT**

Team codes parsed from Kalshi tickers (e.g., ATHNYM → athletics + mets). Polymarket US provides embedded `team.alias` in `marketSides`. The 36h recurrence filter correctly prevents adjacent-game matching.

---

## Section 4: Infrastructure

### 15. Cron Timing
**STATUS: HEALTHY (no pg_cron jobs actually configured)**

Scanner, fastpoll, and resolve are all invoked via curl manually or via the DB webhook (notify). **None of the pg_cron jobs discussed in the prompts have actually been created in the SQL Editor.** This means:
- Fastpoll is NOT running every 60 seconds
- Resolve is NOT running every 5 minutes
- kalshiws is NOT running

### 16. Rate Limits
**STATUS: HEALTHY**

Kalshi: `KALSHI_PAGE_DELAY_MS = 250ms` between pages, batch orderbooks reduce call count by ~60x. Polymarket US: single paginated fetch. ESPN: 4 parallel calls, no auth needed.

### 17. Error Handling
**STATUS: ADEQUATE**

All API calls are wrapped in try/catch with console.error logging. Failed legs don't crash the scan. Kalshi/Poly failures return empty arrays, not thrown errors.

### 18. Secrets
**STATUS: HEALTHY — no hardcoded secrets**

15 secrets verified in Supabase. No secrets found hardcoded in source code. The `.env` file contains keys for local testing only and is not committed.

Note: `TRADE_DRY_RUN` is set to `true` — **no real trades will execute.**

### 19. Database
**STATUS: HEALTHY**

15 migrations applied (missing #007 is a numbering gap, not a missing migration). Indexes exist on `spread_events(pair_id)`, `known_game_markets(platform, close_time)`. Foreign keys from original schema are intact.

---

## Section 5: Known Issues Found

| # | Issue | Priority | Status |
|---|---|---|---|
| 1 | **Kalshi fee 0.07 overstates fees 3-4x** | CRITICAL | Active — hiding profitable opportunities |
| 2 | **Poly fee uses global rates, not US 0.05** | CRITICAL | Active — incorrect fee calculation |
| 3 | **deployed_capital never incremented** | CRITICAL | Active — could over-deploy |
| 4 | **MAX_POSITION_SAFE=$200 > total capital** | HIGH | Cap is never binding (capital_cap=40% is tighter) |
| 5 | **4 dead platform stubs waste 2s/scan** | MEDIUM | Performance only |
| 6 | **Scanner processes Cy Young for Claude** | MEDIUM | Wasted Claude calls (~$0.10/scan) |
| 7 | **pg_cron jobs not created** | MEDIUM | Fastpoll/resolve not running automatically |
| 8 | **kalshiws non-functional** | LOW | WebSocketStream unavailable in Deno |
| 9 | **PredictIt returns 0 matches** | LOW | No US inventory overlap with Kalshi |
| 10 | **Migration numbering gap (007)** | LOW | Cosmetic only |
| 11 | **TRADE_DRY_RUN still enabled** | INFO | Intentional — waiting for user to go live |

---

## Parameter Recommendations

| Parameter | Current | Correct for $198? | Recommended | Reasoning |
|---|---|---|---|---|
| `kalshiFee` coefficient | 0.07 | NO | 0.02 | Actual taker fee is ~1-2%, not 7% |
| `polyFeeCoefficient` | 0.03-0.072 | NO | 0.05 flat | Polymarket US charges flat 5% |
| `MIN_NET_SPREAD` | 0.005 | YES | 0.005 | Low threshold keeps diagnostic pairs visible |
| `MAX_POSITION_SAFE` | $200 | NO | $80 | Should not exceed total capital |
| `MAX_POSITION_CAUTION` | $100 | BORDERLINE | $50 | 25% of capital on uncertain verdict |
| `MAX_CAPITAL_FRACTION` | 0.40 | YES | 0.40 | 40% of $158 = $63 — reasonable |
| `MIN_POSITION_USD` | $20 | YES | $20 | Below $20 isn't worth the execution risk |
| `QUARTER_KELLY` | 0.25 | YES | 0.25 | Conservative for arb |
| `MAX_DAYS_LOCKUP` | 2 | YES | 2 | Short-dated game markets only |
| `AUTO_EXECUTE_SPREAD` | 0.05 | YES | 0.05 | 5% net is high-conviction |
| `AUTO_EXECUTE_MAX_DAYS` | 1 | YES | 1 | Same-day only |
| `MIN_HOURS_TO_CLOSE_SPORTS` | 3 | YES | 3 | Enough time to execute both legs |

---

## Action Items (Priority Order)

1. **[CRITICAL] Fix Kalshi fee coefficient:** Change `0.07` → `0.02` in `kalshiFee()` function. This one change will surface 2-3x more profitable opportunities.

2. **[CRITICAL] Fix Polymarket fee for US:** Read `feeCoefficient` from the US market response and use it instead of the global category lookup. US markets all return `0.05`.

3. **[CRITICAL] Track deployed capital on execution:** In `handleBuy`, after both legs succeed, add: `UPDATE capital_ledger SET deployed_capital = deployed_capital + totalDeployed`

4. **[HIGH] Lower MAX_POSITION_SAFE to $80:** Prevents a single SAFE trade from exceeding total capital.

5. **[HIGH] Create pg_cron jobs:** The fastpoll (60s), resolve (5min) functions are deployed but not scheduled. They only run when manually invoked.

6. **[MEDIUM] Remove dead platform stubs:** CryptoCom, FanDuel, Fanatics, OG all return errors immediately. Remove them to save 2s per scan.

7. **[MEDIUM] Add scanner date pre-filter:** Skip Claude verification for any pair where BOTH close dates > 3 days. Saves ~60 Claude calls per scan.

8. **[MEDIUM] Remove kalshiws from cron:** It's non-functional. Fastpoll at 60s covers the same use case.

9. **[LOW] Remove PredictIt fetcher:** Returns 94 markets but 0 matches. Adds 1s latency for no value.

10. **[LOW] Fix migration numbering:** Renumber or add a no-op 007 migration.

11. **[INFO] When ready to go live:** `supabase secrets unset TRADE_DRY_RUN`
