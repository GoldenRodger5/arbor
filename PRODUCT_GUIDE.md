
# Arbor - Autonomous Prediction Market Trading Bot

## What It Is

Arbor is a fully autonomous prediction market trading bot that uses Claude AI (Sonnet 4.6 + web search) to predict sports outcomes and place bets on Kalshi and Polymarket US. It runs 24/7 on a Hetzner VPS, monitors live games via ESPN, and places trades when Claude's confidence exceeds the market price by a meaningful margin.

The core principle: Claude acts as a sports analyst, not a market analyst. It predicts **who wins**, not whether the market is mispriced. If Claude is 72% confident a team wins and the contract costs 60 cents, it buys. If the team wins, the contract pays $1.00 = 40 cents profit.

---

## Architecture

```
VPS (Hetzner, 87.99.155.128)
  └── pm2 manages:
      ├── arbor-ai (ai-edge.mjs) ← main trading bot, runs 24/7
      ├── arbor-health (healthcheck.mjs) ← daily 8am ET Telegram report
      └── arbor-arb (arb-bot.mjs) ← stopped, legacy

Data flow:
  ESPN Scoreboard API → Live scores, team records, pitcher stats
  Kalshi REST API → Market prices, order placement, positions
  Polymarket US API → Market prices, order placement, balance
  Anthropic API → Claude Haiku (screening) + Sonnet 4.6 (decisions)
  Telegram Bot API → Trade notifications, daily reports, alerts
```

### Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `bot/ai-edge.mjs` | 2,445 | Main trading bot — all prediction + execution logic |
| `bot/healthcheck.mjs` | ~200 | Daily health report via Telegram |
| `bot/ecosystem.config.cjs` | ~47 | pm2 process configuration |
| `bot/test-poly-order.mjs` | ~150 | Polymarket order test script |
| `bot/logs/trades.jsonl` | grows | Every trade with entry, exit, P&L |
| `bot/logs/screens.jsonl` | grows | Every screening decision for analysis |
| `bot/logs/daily-snapshots.jsonl` | grows | Daily bankroll + strategy stats |

---

## Trading Strategies

### 1. Pre-Game Predictions (Kalshi + Polymarket)

**Frequency:** Every 5 minutes
**When:** Before games start (best entry prices)
**How it works:**

1. Fetches all today's sports markets on Kalshi (MLB, NBA, NHL) in the 25-90 cent price range
2. Haiku (cheap, fast) screens all games: "Which 3 look most predictable?"
3. Sonnet + web search researches each pick: team records, pitching matchups, injuries
4. If confidence >= 65% AND confidence exceeds price by 5%+, checks both Kalshi and Polymarket prices
5. Buys on whichever platform is cheaper

**Example trade:**
```
Pre-game: PIT Pirates (9-5) vs CHC Cubs (6-8)
Kalshi: PIT YES @ 62 cents
Polymarket: PIT @ 58 cents
Claude: 71% confident PIT wins (better record, swept series, Cubs lost reliever)
Action: BUY on Polymarket @ 58 cents (4 cents cheaper than Kalshi)
Deployed: $23.20 (40 contracts)
If PIT wins: $40.00 payout = $16.80 profit
```

### 2. Live In-Game Predictions (Kalshi + Polymarket)

**Frequency:** Every 60 seconds
**When:** During live games with any score lead
**How it works:**

1. ESPN scoreboard API fetched in parallel for MLB/NBA/NHL (3 simultaneous requests)
2. Collects all games with a lead (any run/point/goal difference)
3. Haiku batch-screens all live games: "Pick the 2 best predictions"
4. Sonnet analyzes each with rich ESPN data:
   - Team records (overall + home/away splits)
   - Current pitcher stats (IP, ER, K, BB — live from ESPN)
   - Starting/probable pitcher ERA, W-L
   - Inning-by-inning line score
   - Live situation (outs, runners on base)
   - Team batting averages
5. Confidence gate: >= 65%, 5%+ above price, price <= 90 cents
6. Cross-platform price check before order placement
7. Underdog logic: if trailing team has BETTER season record AND price is 15-40 cents in early game, evaluates comeback potential

**Thresholds for checking:**
- MLB: Any lead, game started
- NBA: 4+ point lead
- NHL: 1+ goal lead

### 3. UFC Fight Predictions (Polymarket only)

**Frequency:** Every 30 minutes
**When:** UFC fight cards are upcoming (Polymarket has moneyline markets)
**How it works:**

1. Fetches UFC moneylines from Polymarket (slug format: `aec-ufc-{fighter1}-{fighter2}-{date}`)
2. Haiku screens: "Which 2 fights are most predictable?"
3. Sonnet researches each: fighter records, style matchups, recent form, physical advantages
4. Same confidence gate as sports
5. Polymarket-only (Kalshi doesn't offer UFC)

### 4. Broad Market Scan (Kalshi)

**Frequency:** Every 5 minutes
**When:** Always running
**How it works:**

1. Fetches ALL open Kalshi markets: sports (200/series), non-sports (50/series)
2. Sports filtered by ticker date (today/tonight only), non-sports by close time (1 day max)
3. Sports deduped (same game has 2 tickers, one per team — only show once)
4. Markets grouped by event for bracket markets (CPI, GDP shown as cumulative thresholds)
5. Haiku screens 215+ markets for candidates (max 3)
6. Sonnet + web search researches each candidate
7. Confidence-based gate for sports, edge-based for non-sports

**Market categories scanned:**
- Sports: KXMLBGAME, KXNBAGAME, KXNHLGAME, KXNFLGAME, KXMLSGAME
- Crypto: KXBTC, KXETH
- Economics: KXFED, KXCPI, KXGDP
- Finance: KXSP, KXGOLD
- Politics: KXNEWPOPE, KXPRES, KXSENATE, KXHOUSE

### 5. Resolution Arbitrage (Kalshi)

**Frequency:** Every 5 minutes
**When:** After games end
**How it works:**

1. Fetches Kalshi markets with status `closed` and `settled`
2. Looks for winning sides still trading below 95 cents (guaranteed profit at $1 settlement)
3. For sports: cross-checks ESPN final scores to verify winner
4. Auto-buys winning side (risk-free profit)
5. Sizes aggressively (50% of cash — no risk)

### 6. Stop-Loss (Kalshi + Polymarket)

**Frequency:** Every 5 minutes
**When:** Open positions exist
**How it works:**

1. Reads all open trades from `trades.jsonl`
2. For Kalshi trades: fetches current market price, compares to entry price
3. For Polymarket trades: uses cached moneyline prices
4. If position dropped > 30% from entry: places sell order on Kalshi, sends Telegram alert for Poly
5. Polymarket doesn't support selling — alert-only for Poly positions

---

## Two-Model Pipeline

Every prediction uses a two-stage AI pipeline to minimize API costs:

```
Stage 1: Claude Haiku ($0.002/call)
  - Sees all markets/games at once
  - Fast screen: "Which 2-3 are worth analyzing?"
  - No web search — uses provided data only
  - Takes 3-5 seconds

Stage 2: Claude Sonnet 4.6 + Web Search ($0.08/call)
  - Only called on Haiku's picks (2-3 per cycle, not 20+)
  - Researches team records, injuries, pitcher stats via web search
  - Makes the actual confidence prediction
  - Takes 15-25 seconds
```

**Cost comparison:**
- Old approach: Sonnet on every market = ~$36/day
- Current approach: Haiku screens + Sonnet on picks = ~$5-8/day

---

## Cross-Platform Execution

Every trade checks both Kalshi and Polymarket prices before placing the order:

```
1. Claude predicts: "PIT wins with 74% confidence"
2. Kalshi price: PIT YES @ 69 cents
3. Polymarket price: PIT LONG @ 65 cents (via sport-aware mapper)
4. Bot buys on Polymarket (4 cents cheaper = 6% more profit)
```

**Sport-aware matching:** Polymarket slugs contain the sport (`aec-mlb-pit-chc`). The mapper requires both team abbreviations AND the sport to match, preventing cross-sport confusion (PIT Pirates MLB vs PIT Penguins NHL).

**Side matching:** `pickBestPlatform()` identifies which Polymarket side corresponds to the team we want by matching team abbreviations to slug positions and team names.

---

## Risk Management

### Position Sizing (Dynamic)

All limits scale automatically with bankroll every 60 seconds.

**Per-trade size:** `getBankroll() * MAX_TRADE_FRACTION` (10%) capped by `getTradeCapCeiling()`.

**Inverse deployment curve** (`getMaxDeployment()`): Aggressive when small (need growth), conservative when big (protect gains).

| Bankroll | Max Trade | Max Deploy | Positions | Per-Trade Ceiling |
|----------|-----------|------------|-----------|-------------------|
| $200 | $20 | $170 (85%) | 30 | $50 |
| $600 | $50 | $450 (75%) | 30 | $50 |
| $1,000 | $50 | $750 (75%) | 40 | $150 |
| $5,000 | $50 | $3,000 (60%) | 50 | $500 |
| $20,000 | $500 | $8,000 (40%) | 50 | $500 |
| $50,000 | $2,000 | $15,000 (30%) | 60 | $2,000 |

**How sizing works per trade:**
1. `getDynamicMaxTrade()` calculates: `min(bankroll * 10%, getTradeCapCeiling(), getAvailableCash())`
2. `getAvailableCash()` subtracts the 5% capital reserve from platform cash
3. `getPositionSize()` applies consecutive-loss reduction (50% after 7 losses)
4. Claude's recommended bet amount is capped by the above
5. Final quantity: `floor(safeBet / price)`

### Circuit Breakers

| Control | Threshold | Action |
|---------|-----------|--------|
| Daily loss | 15% of bankroll | Halt all trading, Telegram alert, auto-resume next day |
| Consecutive losses | 7 in a row | Reduce position size to 50% |
| Consecutive losses | 10 in a row | Full halt, Telegram alert |
| Midnight ET | Auto | Reset daily limits, update consecutive loss count |

### Trade Gates (every trade passes ALL of these)

1. `canTrade()` — daily loss not exceeded, not halted, positions under limit, deployment under cap
2. `canDeployMore(amount)` — total deployed + new trade within deployment limit
3. `checkSportExposure(ticker)` — max 25% of bankroll per sport per day
4. Confidence >= 65% (MIN_CONFIDENCE)
5. Confidence >= price + 5% (CONFIDENCE_MARGIN)
6. Price >= 5 cents and <= 90 cents (MAX_PRICE)
7. Cooldown: 15 minutes between trades on same game
8. Position check: no existing position on same game (cross-platform aware)

### Cross-Platform Position Tracking

`openPositions` array includes BOTH:
- Kalshi positions from `/portfolio/positions` API
- Polymarket positions from `trades.jsonl` (open status)

This ensures deployment caps, position limits, and same-game checks work across both platforms.

---

## Configuration

All constants are at the top of `ai-edge.mjs`:

```javascript
// Prediction thresholds
MIN_CONFIDENCE = 0.65       // Claude must be >= 65% confident
CONFIDENCE_MARGIN = 0.05    // Confidence must beat price by 5%+
MAX_PRICE = 0.90            // Won't buy above 90 cents

// Sizing
MAX_TRADE_FRACTION = 0.10   // 10% of bankroll per trade

// Timing
POLL_INTERVAL_MS = 60,000   // Main loop: every 60 seconds
PREGAME_SCAN_INTERVAL = 300,000  // Pre-game: every 5 minutes
BROAD_SCAN_INTERVAL = 300,000    // Broad scan: every 5 minutes
UFC_SCAN_INTERVAL = 1,800,000    // UFC: every 30 minutes
COOLDOWN_MS = 900,000       // 15 min between same-game trades

// Risk
DAILY_LOSS_PCT = 0.15       // Halt at 15% daily loss
CAPITAL_RESERVE = 0.05      // Keep 5% untouched
MAX_CONSECUTIVE_LOSSES = 7  // Half size after 7 straight losses
SPORT_EXPOSURE_PCT = 0.25   // Max 25% bankroll per sport
MAX_DAYS_OUT = 1             // Same-day markets only (sports by ticker date)

// AI Models
CLAUDE_SCREENER = 'claude-haiku-4-5-20251001'  // Cheap screening
CLAUDE_DECIDER = 'claude-sonnet-4-6'           // Expensive decisions
```

---

## Data Collection & Analytics

### trades.jsonl

Every trade is recorded with full detail:

```json
{
  "id": "1776020418062-fgyl99",
  "timestamp": "2026-04-12T19:00:18.062Z",
  "exchange": "kalshi",
  "strategy": "live-prediction",
  "ticker": "KXMLBGAME-26APR121340ATHNYM-ATH",
  "title": "A's vs New York M Winner?",
  "side": "yes",
  "quantity": 19,
  "entryPrice": 0.62,
  "deployCost": 11.78,
  "filled": 0,
  "orderId": "7c26eb24-...",
  "edge": 5.0,
  "confidence": 0.67,
  "reasoning": "ATH leads 1-0 through 5 innings with Civale (2.70 ERA)...",
  "liveScore": "ATH 1 - NYM 0 (End 5th)",
  "status": "settled",
  "exitPrice": 0.0,
  "realizedPnL": -11.78,
  "settledAt": "2026-04-12T22:30:00.000Z",
  "result": "no"
}
```

### screens.jsonl

Every Haiku screening and Sonnet decision logged:

```json
{
  "timestamp": "2026-04-12T18:24:52.606Z",
  "stage": "haiku",
  "result": "found",
  "candidates": [
    {"ticker": "KXMLBGAME-...", "reason": "LAA YES=$0.93 seems high..."}
  ],
  "marketCount": 144
}
```

### daily-snapshots.jsonl

End-of-day snapshots at 8pm ET and midnight ET:

```json
{
  "date": "2026-04-12",
  "bankroll": 251.34,
  "kalshiCash": 94.02,
  "kalshiPositions": 96.65,
  "polyBalance": 60.67,
  "totalTrades": 6,
  "settledTrades": 2,
  "wins": 0,
  "losses": 2,
  "winRate": 0,
  "totalPnL": -36.14,
  "strategyStats": {
    "live-prediction": {"trades": 2, "wins": 0, "losses": 2, "pnl": -36.14}
  }
}
```

### What the data enables

After 50+ trades:
- Win rate by strategy (pre-game vs live vs UFC)
- Claude calibration: when it says 70%, does it win 70%?
- Average entry price of winners vs losers
- Best performing sport/league
- API cost vs trading revenue
- Strategy auto-disable alerts (< 40% win rate over 10+ trades)

---

## Telegram Notifications

### Trade Placed
```
PREDICTION BET - KALSHI

Pittsburgh vs Chicago C Winner?
Team: PIT | Score: PIT 6 - CHC 3
Status: Bot 7th

BUY YES @ 69 cents x 36 = $24.84
Confidence: 74% vs price 69 cents
Potential profit: $11.16 if PIT wins

[Claude's reasoning with specific facts]
```

### Daily Report (8pm ET + Midnight ET)
```
DAILY REPORT - April 12

Portfolio:
Kalshi: $94.02 cash + $96.65 positions
Polymarket: $60.67
Total: $251.34

Trading:
Today: 6 trades, -$36.14
All time: 6 trades, 2 settled
Won: 0 | Lost: 2 | Win rate: 0%
Total P&L: -$36.14

By Strategy:
  live-prediction: 2 trades, 0% win rate, -$36.14

Open: 19 positions, $159.36 deployed
Consecutive losses: 2
```

### Health Check (8am ET daily)
```
ARBOR DAILY HEALTH CHECK

arbor-ai - online (9h uptime, 0 restarts)
arbor-arb - stopped (intentional)
arbor-health - online (0h uptime)

All systems operational

Kalshi Balance: $94.02 cash, $96.65 positions
Total: $190.67

Open Positions: 16
P&L Summary: -$36.14 total, 2 settled

No errors in last 24h
```

### Stop-Loss Alert
```
STOP-LOSS TRIGGERED

Pittsburgh vs Chicago C Winner?
Sold YES @ 45 cents x 36
Entry: 69 cents -> Exit: 45 cents
Loss: $8.64 (35%)
```

### Trading Halt
```
TRADING HALTED

Daily loss limit hit: $38.50 lost today (limit: $37.70 = 15% of $251.34)
Bot will resume tomorrow.
```

---

## API Integrations

### Kalshi (Primary exchange)
- **Auth:** RSA-PSS signature (PKCS1 PSS padding, salt length 32)
- **Endpoints used:**
  - `GET /portfolio/balance` — cash + position value
  - `GET /portfolio/positions` — open positions
  - `POST /portfolio/orders` — place buy/sell orders
  - `GET /markets` — fetch market prices (by series, status)
  - `GET /markets/{ticker}` — individual market price (stop-loss)

### Polymarket US (Secondary exchange)
- **Auth:** Ed25519 signature (signAsync, NO body in POST signature)
- **Endpoints used:**
  - `GET /v1/account/balances` — cash balance
  - `POST /v1/orders` — place orders (IOC limit orders)
  - `GET /v1/markets` (gateway API) — fetch market listings
- **Order format:**
  ```json
  {
    "marketSlug": "aec-mlb-pit-chc-2026-04-12",
    "intent": "ORDER_INTENT_BUY_LONG",
    "type": "ORDER_TYPE_LIMIT",
    "price": {"value": "0.60", "currency": "USD"},
    "quantity": 40,
    "tif": "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL"
  }
  ```

### ESPN (Data source — no auth)
- **Scoreboards:** `site.api.espn.com/apis/site/v2/sports/{sport}/scoreboard`
- **Data extracted:** scores, team records (overall/home/away), pitcher stats, line scores, live situation (outs, runners), probable pitchers with ERA

### Anthropic (AI decisions)
- **Models:** Haiku 4.5 (screening), Sonnet 4.6 (decisions)
- **Web search:** `web_search_20250305` tool (max 3-5 uses per call)
- **Cost:** ~$5-8/day at current usage

### Telegram (Notifications)
- **Bot API:** sendMessage with HTML parse mode
- **Notifications:** Every trade, daily reports, halt alerts, stop-loss triggers

---

## Infrastructure

### VPS
- **Provider:** Hetzner
- **IP:** 87.99.155.128
- **Cost:** $7.59/month
- **OS:** Linux
- **Access:** SSH key auth (`~/.ssh/hetzner_arbor`)

### Process Management
- **pm2** manages all processes
- `arbor-ai`: main bot, auto-restart on crash, max 200MB memory
- `arbor-health`: cron at 12:00 UTC (8am ET), runs once then stops
- Logs: `./logs/ai-out.log`, `./logs/ai-error.log`

### Environment Variables Required
```
KALSHI_API_KEY_ID=...
KALSHI_PRIVATE_KEY_PATH=./kalshi-private-key.pem
ANTHROPIC_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
POLY_US_KEY_ID=...
POLY_US_SECRET_KEY=...
```

---

## Financial Model

### Capital Strategy
- Starting capital: ~$250 ($95 Kalshi + $60 Polymarket + positions)
- Biweekly injection: $400 ($200 per platform)
- Target: $4,000/month passive income

### Break-Even Analysis
- At 60% win rate with average 55-cent entry price:
  - Win: $0.45 profit per contract
  - Lose: $0.55 loss per contract
  - Per 10 trades: 6 wins ($2.70) - 4 losses ($2.20) = +$0.50 net
  - At 5 trades/day, $20 avg: ~$10/day = $300/month at $250 bankroll
- At $1,000 bankroll: ~$40/day = $1,200/month
- At $5,000 bankroll: ~$100/day = $3,000/month

### Scaling (inverse risk curve)
As bankroll grows, deployment percentage decreases:
- $200: 85% deployed (aggressive — need growth)
- $5,000: 60% deployed (moderate)
- $50,000: 20% deployed (conservative — protect gains)

---

## Known Limitations

1. **Unproven win rate.** System has 2 settled trades (both losses). Need 50+ trades to validate prediction accuracy.

2. **No Polymarket sell capability.** Can buy on Poly but can't sell/exit positions early. Stop-loss is alert-only for Poly.

3. **Kalshi settlement delay.** Sports markets take hours to settle after games end. Capital is locked during this period.

4. **Claude cost.** At ~$5-8/day, API costs eat into small-bankroll profits. Becomes negligible at $1,000+ bankroll.

5. **Single point of failure.** One bot on one VPS. If VPS goes down, no trading. pm2 auto-restarts on crash, but hardware failure = downtime.

6. **No backtesting.** Predictions are forward-only. Can't validate strategy against historical data without building a separate backtesting framework.

7. **Poly futures positions.** 2 Hart Trophy bets ($36 total) are locked until June 30, 2026 from before the futures filter was added.

---

## Additional Features (Detail)

### Settlement Reconciliation (`checkSettlements`)

Runs every 5 minutes. Reads `trades.jsonl`, finds open Kalshi trades, fetches closed/settled markets from Kalshi API, and matches them. When a trade's market has settled:

- Calculates P&L: `won = (side matches result)`, exit price is $1.00 (win) or $0.00 (loss)
- Updates trade status in `trades.jsonl` from `open` to `settled`
- Updates `consecutiveLosses` counter
- Runs per-strategy performance check (see below)
- Logs result to console: `[pnl] SETTLED: KXMLB... yes -> no | P&L: -$11.78`

### Strategy Auto-Disable Alerts

After each settlement batch, the system calculates per-strategy win rates. If ANY strategy has 10+ settled trades AND win rate drops below 40%, a Telegram alert is sent:

```
Strategy Alert

"live-prediction" has 35% win rate over 12 trades.
P&L: -$18.40

Consider disabling this strategy.
```

This doesn't auto-disable (human decision required) but ensures you know when a strategy is bleeding money.

### Underdog Betting Logic

In live games, the bot evaluates BOTH the leading AND trailing team:

**Default:** Buy the leading team's contract (they're winning, likely to hold)

**Underdog trigger (all must be true):**
- Trailing team's contract price is between 15-40 cents (cheap)
- Game is early (period/inning <= 4)
- Score deficit is small (3 or fewer runs/points)
- Trailing team has a BETTER season record than the leading team

When triggered, Claude evaluates the trailing team's comeback potential instead. The prompt explicitly notes this is an underdog bet and asks Claude to assess whether the better team can come back.

**Example:** Yankees (8-3) trailing Rays (5-6) by 2 runs in the 3rd inning. NYY at 35 cents. Bot evaluates NYY comeback because they're the better team down early.

### Bracket Market Grouping

Non-sports markets like CPI, GDP, Fed rates are cumulative threshold brackets:
- "GDP > 2.0%?" YES=$0.53
- "GDP > 2.5%?" YES=$0.33
- "GDP > 3.0%?" YES=$0.16

The bot groups these by event and presents them to Claude as a single bracket with all thresholds visible. Claude picks the single best threshold to trade, understanding that the implied probability of "GDP between 2.0-2.5%" = 0.53 - 0.33 = 20%.

### ESPN Data Extraction

For live games, the bot extracts rich context from ESPN's scoreboard API (no additional API calls needed):

| Data Point | Source | Used In |
|-----------|--------|---------|
| Team records (overall) | `competitor.records[0].summary` | Live-edge + pre-game prompts |
| Home/away records | `competitor.records[type=home/road]` | Live-edge prompt |
| Current pitcher stats | `competition.situation.pitcher.summary` | Live MLB prompt |
| Starting pitcher ERA | `competitor.probables[].statistics[ERA]` | Live MLB prompt |
| Starting pitcher W-L | `competitor.probables[].statistics[W/L]` | Live MLB prompt |
| Team batting average | `competitor.statistics[AVG]` | Live MLB prompt |
| Inning-by-inning scores | `competitor.linescores[]` | Live prompt |
| Runners on base | `competition.situation.onFirst/Second/Third` | Live prompt |
| Outs | `competition.situation.outs` | Live prompt |
| Game status detail | `competition.status.type.shortDetail` | All prompts |

### Poll Cycle Flow

Every 60 seconds, `pollCycle()` runs this sequence:

```
1. refreshPortfolio()
   ├── Fetch Kalshi balance + positions
   ├── Read trades.jsonl for open Poly positions
   └── Refresh Poly balance via Ed25519 signed request

2. Daily reset check (midnight ET)
   └── Reset daily loss tracking, update consecutive losses

3. canTrade() gate
   └── Check: not halted, daily loss OK, positions under limit, deployment under cap

4. checkPreGamePredictions() [every 5 min]
   ├── Fetch today's Kalshi sports markets (25-90 cent range)
   ├── Haiku screens for 3 most predictable games
   ├── Sonnet + web search predicts each
   ├── Cross-platform price check (Kalshi vs Poly)
   └── Buy on cheaper platform if confidence passes

5. checkUFCPredictions() [every 30 min]
   ├── Fetch Poly UFC moneylines
   ├── Haiku picks 2 most predictable fights
   ├── Sonnet researches fighters
   └── Buy on Poly if confidence passes

6. checkLiveScoreEdges() [every cycle]
   ├── Parallel ESPN fetch (MLB + NBA + NHL)
   ├── Collect all games with leads
   ├── Haiku batch-screens: pick 2 best predictions
   ├── Sonnet analyzes each with full ESPN data
   ├── Cross-platform price check
   └── Buy on cheaper platform

7. claudeBroadScan() [every 5 min]
   ├── Fetch 200+ markets across all categories
   ├── Filter by date (sports: ticker date, non-sports: close time)
   ├── Dedup sports (one ticker per game)
   ├── Haiku screens for 3 candidates
   └── Sonnet researches each
```

Every 5 minutes, `settlementLoop()` runs:
```
1. checkStopLosses()   — sell Kalshi positions down >30%
2. checkSettlements()   — reconcile closed markets with trade log
3. checkResolutionArbs() — buy winning sides below $0.95
```

### Polymarket Technical Details

**Signing:** Ed25519 via `@noble/ed25519` library. The `sha512Sync` function from Node's crypto module is set once at initialization (the `ed.etc` object freezes after first use). Falls back to `signAsync` which has internal sha512.

**Signature format:** `timestamp + method + path` (NO body included for POST requests — this was a critical fix; including body caused 401 errors).

**Order type:** All orders are `TIME_IN_FORCE_IMMEDIATE_OR_CANCEL` (IOC) limit orders. Price is set 2 cents above market to ensure fill. If not filled immediately, order cancels — no hanging orders.

**Market mapping:** Polymarket slugs use format `aec-{sport}-{team1}-{team2}-{date}`. The mapper requires BOTH team abbreviations AND sport prefix to match, preventing cross-sport confusion (e.g., PIT Pirates MLB vs PIT Penguins NHL).

**Futures blocked:** Only `moneyline` market type allowed (game-winners). The `futures` type (MVP, championships) is blocked because these lock capital for months.
