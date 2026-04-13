
# Arbor - Autonomous Prediction Market Trading Bot

## What It Is

Arbor is a fully autonomous prediction market trading bot that uses Claude AI (Haiku 4.5 screening + Sonnet 4.6 with web search) to predict sports outcomes and place bets on Kalshi (primary) and Polymarket US (secondary). It runs 24/7 on a Hetzner VPS, monitors live games via ESPN across six leagues (MLB, NBA, NHL, MLS, EPL, La Liga), and places trades when Claude's confidence exceeds the market price by a dynamic, sport-aware margin.

The system includes a full real-time React dashboard (hosted on Vercel) for monitoring trades, positions, analytics, and live bot activity.

The core principle: Claude acts as a sports analyst, not a market analyst. It predicts **who wins**, not whether the market is mispriced. If Claude is 72% confident a team wins and the contract costs 60 cents, it buys. If the team wins, the contract pays $1.00 = 40 cents profit.

---

## Architecture

```
VPS (Hetzner, 87.99.155.128)
  └── pm2 manages:
      ├── arbor-ai (ai-edge.mjs) ← main trading bot, 3,941 lines, runs 24/7
      ├── arbor-api (api.mjs) ← data API server, port 3456, serves dashboard
      ├── arbor-health (healthcheck.mjs) ← daily 8am ET Telegram report
      └── arbor-arb (arb-bot.mjs) ← stopped, legacy

Dashboard (Vercel)
  └── React SPA (Vite + TypeScript + Recharts)
      ├── Command Center — bankroll, stats, projections, achievements
      ├── Positions — open positions with sport filters
      ├── Trade History — all trades with multi-filter search
      ├── Analytics — charts: bankroll growth, sport performance, calibration, strategy breakdown
      ├── Trade Review — AI-graded post-game analysis (A/B/C/D)
      ├── Live Feed — real-time bot log viewer with filters
      └── Settings — system status, configuration display, dynamic margins

Data flow:
  ESPN Scoreboard API → Live scores, team records, pitcher stats (6 leagues)
  Kalshi REST API → Market prices, order placement, positions
  Polymarket US API → Market prices, order placement, balance
  Anthropic API → Claude Haiku (screening) + Sonnet 4.6 (decisions + web search)
  Telegram Bot API → Trade notifications, daily reports, alerts
  VPS Data API → bot/api.mjs serves JSONL data over HTTP
  Vercel Proxy → api/proxy.js (HTTPS → HTTP bridge for dashboard)
```

### Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `bot/ai-edge.mjs` | 3,941 | Main trading bot — all prediction, execution, position management |
| `bot/api.mjs` | 284 | Data API server — serves trades, positions, stats, snapshots, live feed to dashboard |
| `bot/healthcheck.mjs` | 204 | Daily health report via Telegram |
| `bot/ecosystem.config.cjs` | 47 | pm2 process configuration |
| `bot/arb-bot.mjs` | 32,795 | Legacy arbitrage bot (stopped) |
| `bot/market-maker.mjs` | 21,060 | Legacy market maker (disabled — thin sports markets cause one-sided fills) |
| `api/proxy.js` | 37 | Vercel serverless proxy — HTTPS frontend → HTTP VPS (avoids mixed content) |
| `src/App.tsx` | 30 | React app with 7 routes |
| `src/context/ArborContext.tsx` | 91 | Global state provider — polls API every 15 seconds |
| `src/lib/api.ts` | 31 | Frontend API client — dev hits VPS directly, prod uses Vercel proxy |
| `src/pages/CommandCenter.tsx` | 310 | Dashboard home — bankroll, stats, chart, positions, activity, achievements |
| `src/pages/PositionsPage.tsx` | 119 | Open positions with sport filters and expand-for-reasoning |
| `src/pages/TradeHistory.tsx` | 193 | All trades with date/sport/result/strategy filters |
| `src/pages/AnalyticsPage.tsx` | 227 | Charts: bankroll growth, sport performance, calibration scatter, strategy pie, hourly P&L |
| `src/pages/TradeReview.tsx` | 174 | AI-graded post-game analysis with A/B/C/D grades |
| `src/pages/LiveFeed.tsx` | 151 | Real-time bot log viewer with tag and type filters |
| `src/pages/SettingsPage.tsx` | 95 | System status, trading config, dynamic margins display, sport status |
| `src/components/Achievements.tsx` | 57 | 14 achievement badges (First Blood, Winner Winner, On Fire, etc.) |
| `src/components/Confetti.tsx` | 49 | Confetti animation on win settlements |
| `src/components/Layout.tsx` | 24 | Responsive layout — sidebar on desktop, bottom tabs on mobile |
| `src/components/Sidebar.tsx` | 89 | Desktop sidebar — nav, live/disconnected status, bankroll, positions count |
| `src/components/BottomTabs.tsx` | 43 | Mobile bottom tab bar (5 tabs) |
| `bot/logs/trades.jsonl` | grows | Every trade with entry, exit, P&L, reasoning |
| `bot/logs/screens.jsonl` | grows | Every screening decision for analysis |
| `bot/logs/daily-snapshots.jsonl` | grows | Daily bankroll + strategy stats |
| `bot/logs/ai-out.log` | grows | Full bot console output (read by live feed) |

---

## Trading Strategies

### 1. Live In-Game Predictions (Primary Strategy)

**Frequency:** Every 60 seconds
**Leagues:** MLB, NBA, NHL, MLS, EPL, La Liga
**When:** During live games with score leads (or tied soccer games for draw bets)

**How it works:**

1. **Phase 1 — Collect:** ESPN scoreboard API fetched in parallel for all 6 leagues. Collects all games with a lead (any score difference), plus tied soccer games.
2. **Phase 2 — Prioritize:** Score change detection + win expectancy baseline calculation. Candidates sorted by baseline WE — highest opportunity first.
3. **Line Movement Detection:** Monitors price changes across cycles. 5c+ swings get flagged and boosted to top of analysis queue.
4. **Batch Price Fetch:** All sports market prices fetched in one parallel call (6 series simultaneously). Cached for instant lookup per game.
5. **Phase 3 — Analyze:** Sonnet + web search analyzes candidates in priority order (max 6 per cycle, batched 3 at a time in parallel). Rich ESPN context includes:
   - Team records (overall + home/away splits)
   - Current pitcher stats (IP, ER, K, BB — live from ESPN)
   - Starting/probable pitcher ERA, W-L
   - Inning-by-inning line score
   - Live situation (outs, runners on base, current batter, last play)
   - Team batting averages
   - NBA shooting stats (FG%, 3P%, rebounds, assists, FTA)
   - Leading scorers (NBA)
   - Time remaining (critical for NBA/NHL)
   - Historical win expectancy baseline text
   - Soccer draw rate warnings
6. **Confidence Hard Cap:** Claude's confidence is capped at baseline + 15%. Prevents insanity like "17% baseline → 68% confidence."
7. **Dynamic Margin Gate:** Sport-aware margin (see Dynamic Margins section). Raw edge must exceed margin.
8. **Cross-Platform Price Check:** Compares Kalshi vs Polymarket, buys on cheaper platform.
9. **Phase 4 — Execute:** Orders placed, trades logged to JSONL, Telegram notification sent.

**Thresholds for checking:**
- MLB: Any lead, game started
- NBA: Any lead (previously 4+ points)
- NHL: 1+ goal lead
- Soccer: Any lead OR tied (for draw bets)

### 2. Soccer Draw Betting

**Frequency:** Every 60 seconds (part of live-edge cycle)
**Leagues:** MLS, EPL, La Liga
**When:** Tied soccer games in 2nd half (or late 1st half if 0-0)

**How it works:**

1. Detects tied soccer games. Calculates draw probability from research-verified baselines by minute:
   - 0-0 at 80': 88% draw probability
   - 0-0 at 70': 78%
   - 0-0 at 60': 59%
   - 0-0 at 55': 50%
   - 0-0 at 45' (start of 2nd half): 42%
   - 1-1/2-2 at 80': 84%
   - 1-1/2-2 at 70': 72%
   - 1-1/2-2 at 60': 55%
2. Finds the TIE market from cached Kalshi prices (instant, no API call)
3. Buys if draw probability exceeds price by 3%+ (uses CONFIDENCE_MARGIN, not dynamic margin)
4. Pure math strategy — no Claude AI call needed, uses historical baseline only

**Example:**
```
MLS: ATL 0-0 NSH at 72'
TIE contract @ 62c (market thinks 62% draw)
Historical baseline: 78% draw at 72' when 0-0
Margin: 78% - 62% = 16% edge
Action: BUY TIE @ 62c x 15 = $9.30
If draw holds: $15.00 payout = $5.70 profit
```

### 3. Pre-Game Predictions

**Frequency:** Every 15 minutes
**When:** Before 6pm ET (once live games start, live-edge takes over)
**Daily limit:** Max 2 trades per day (survives restarts — counted from JSONL)
**Leagues:** MLB, NBA, NHL, MLS, EPL, La Liga

**How it works:**

1. Fetches today's Kalshi sports markets across all 6 leagues. Soccer gets a 3-day lookahead (games scheduled in advance, not daily like US sports).
2. Groups both team tickers per game (e.g., PIT and CHC for Pirates vs Cubs), filters out TIE tickers.
3. Builds screening prompt with both sides, prices, and records for all games.
4. Haiku screens for most predictable games.
5. Sonnet + web search researches each pick with sport-specific prompts. Win expectancy baselines provided for context.
6. Dynamic pre-game margin applied (sport base + 1% + price penalty for 70c+ favorites — see Dynamic Margins).
7. Cross-platform price check before execution.
8. Confidence hard-capped at baseline + 15%.

**Pre-game additions vs live:**
- +1% base margin (market has had time to settle)
- +3% penalty for 70c+ favorites (trap protection)
- Shuts off at 6pm ET automatically
- Tracks previously bet games to prevent re-buying

### 4. UFC Fight Predictions (Polymarket Only)

**Frequency:** Every 30 minutes
**When:** UFC fight cards are upcoming
**How it works:**

1. Fetches UFC moneylines from Polymarket (slug format: `aec-ufc-{fighter1}-{fighter2}-{date}`)
2. Haiku screens: "Which 2 fights are most predictable?"
3. Sonnet researches each: fighter records, style matchups, recent form, physical advantages
4. Same confidence gate as sports
5. Polymarket-only (Kalshi doesn't offer UFC moneylines)

### 5. Broad Market Scan

**Frequency:** Every 30 minutes
**When:** Always running
**How it works:**

1. Fetches ALL open Kalshi markets: sports series (6 leagues + NFL), non-sports series (crypto, economics, finance, politics), plus keyword-based Golf/Masters markets
2. Sports filtered by ticker date (today/tonight only, soccer gets 3-day window), non-sports by close time (1 day max)
3. Sports deduped (same game has 2 tickers, one per team — only show once)
4. Markets grouped by event for bracket markets (CPI, GDP shown as cumulative thresholds)
5. Fetches contextual data: ESPN news headlines + BTC/ETH spot prices from CoinGecko
6. Haiku screens 200+ markets for candidates (max 5)
7. Sonnet + web search researches each candidate with sport-specific or non-sports prompts
8. Sports games BLOCKED from broad-scan execution — redirected to pre-game/live-edge for proper side mapping
9. Non-sports use confidence-based gate with dynamic margins

**Market categories scanned:**
- Sports: KXMLBGAME, KXNBAGAME, KXNHLGAME, KXNFLGAME, KXMLSGAME, KXEPLGAME, KXLALIGAGAME
- Golf: keyword-based (Masters, Rory, Scheffler, etc.)
- Crypto: KXBTC, KXETH
- Economics: KXFED, KXCPI, KXGDP
- Finance: KXSP, KXGOLD
- Politics: KXNEWPOPE, KXPRES, KXSENATE, KXHOUSE

### 6. Resolution Arbitrage (Kalshi)

**Frequency:** Every 5 minutes
**When:** After games end
**How it works:**

1. Fetches Kalshi markets with status `closed` and `settled`
2. Looks for winning sides still trading below 95 cents (guaranteed profit at $1 settlement)
3. For sports: cross-checks ESPN final scores to verify winner
4. Auto-buys winning side (risk-free profit)
5. Sizes aggressively — up to 50% of cash (no risk, guaranteed settlement at $1)
6. 1-hour cooldown per ticker

### 7. High-Conviction Tier

**Trigger:** Late-game situations where Claude is 90%+ confident
**Sizing:** 25-30% of bankroll (vs normal 10%)

**Sport-specific qualifiers (all require late stage + 90%+ confidence):**
- NBA: 20+ point lead in Q4 (<1% comeback), or 15+ in Q4 (~2%)
- NHL: 2+ goal lead in P3 (~5% comeback), or 1 goal in P3
- MLB: 4+ runs in 7th+ (~2%), or 3+ runs in 8th+
- Soccer: 2+ goals at 75'+ (<3% comeback)

**Safety rails:**
- Max 1 high-conviction bet per hour
- Max 40% of bankroll in active high-conviction positions
- Own ceiling: 50% of bankroll per trade

---

## Two-Model Pipeline

Every prediction (except draw bets) uses a two-stage AI pipeline to minimize API costs:

```
Stage 1: Claude Haiku 4.5 ($0.002/call)
  - Sees all markets/games at once
  - Fast screen: "Which 2-5 are worth analyzing?"
  - No web search — uses provided data only
  - Takes 3-5 seconds

Stage 2: Claude Sonnet 4.6 + Web Search ($0.03-0.05/call)
  - Only called on Haiku's picks
  - Researches team records, injuries, pitcher stats via web search
  - Makes the actual confidence prediction
  - Batched 3 at a time in parallel for live-edge
  - Takes 15-25 seconds per batch
```

**Cost comparison:**
- Old approach: Sonnet on every market = ~$36/day
- Current approach: Haiku screens + Sonnet on picks = ~$5-8/day

---

## Win Expectancy Baselines

Claude's predictions are anchored to historical baselines, preventing wild confidence swings. The bot provides sport-specific win expectancy tables in every prompt:

### MLB (Source: Tom Tango, FanGraphs, 1903-2024)
| Run Lead | Inn 1 | Inn 3 | Inn 5 | Inn 7 | Inn 9 |
|----------|-------|-------|-------|-------|-------|
| 1 | 56% | 60% | 67% | 77% | 91% |
| 2 | 64% | 70% | 79% | 88% | 96% |
| 3 | 72% | 78% | 87% | 93% | 98% |
| 4 | 79% | 85% | 92% | 96% | 99% |
| 5+ | 85% | 90% | 95% | 98% | 99% |

### NBA (Source: Professor MJ, Modern era 2015+)
| Point Lead | Q1 | Q2 | Q3 | Q4 |
|-----------|-----|-----|-----|-----|
| 5 | 57% | 60% | 65% | 75% |
| 10 | 63% | 69% | 77% | 86% |
| 15 | 70% | 78% | 85% | 92% |
| 20 | 78% | 85% | 91% | 96% |
| 25+ | 85% | 90% | 95% | 98% |

Note: 15-point comebacks now happen 13% of the time (was 6% pre-2002) due to 3-point shooting revolution.

### NHL (Source: Hockey Graphs, MoneyPuck)
| Goal Lead | P1 | P2 | P3 |
|----------|-----|-----|-----|
| 1 | 62% | 68% | 79% |
| 2 | 80% | 86% | 93% |
| 3+ | 92% | 95% | 99% |

### Soccer (Source: brendansudol, EPL/MLS data)
| Goal Lead | 1st Half | 2nd Half |
|----------|----------|----------|
| 1 | 65% | 78% |
| 2 | 82% | 92% |
| 3+ | 94% | 98% |

Draw rates: EPL 28%, MLS 24%. Home advantage: EPL 45% home wins, MLS 49%.

**Hard cap:** Claude cannot deviate more than 15% from the historical baseline for the target team. This prevents overconfidence (e.g., "17% baseline → 68% confidence" is capped to 32%).

---

## Dynamic Confidence Margins

Replaced the old flat 5% margin. Margins are now sport-aware, price-aware, and situation-aware.

### Key Insight

Live and pre-game bets are fundamentally different:
- **Live:** Price reflects game state. A team up 20 in Q4 at 85c is a BETTER bet than a pre-game toss-up at 50c. Don't penalize high prices.
- **Pre-game:** Price reflects market consensus. A 75c favorite could easily lose. Be selective, especially on expensive favorites.

### Live Margins (Sport Base Only)

| Sport | Base Margin | With Score Change | With Line Move |
|-------|------------|-------------------|---------------|
| NHL | 3% | 2% | 1% |
| NBA | 4% | 3% | 2% |
| MLB | 5% | 4% | 3% |
| Soccer (MLS/EPL/La Liga) | 5% | 4% | 3% |
| UFC | 2% | 1% | 0% |
| Crypto/Economics/Politics | 4% | — | — |

Score change = market is recalculating, act fast. Line move = 5c+ price swing detected, edge window open.

### Pre-Game Margins (Sport Base + 1% + Price Penalty)

| Sport | Under 55c | 55-70c | 70c+ (Trap Zone) |
|-------|-----------|--------|-----------------|
| NHL | 4% | 5% | 7% |
| NBA | 5% | 6% | 8% |
| MLB | 6% | 7% | 9% |
| Soccer | 6% | 7% | 9% |
| UFC | 3% | 4% | 6% |

The 70c+ penalty exists because expensive pre-game favorites are traps — one loss at 75c wipes out 3 cheap wins.

---

## Cross-Platform Execution

Every trade checks both Kalshi and Polymarket prices before placing the order:

```
1. Claude predicts: "PIT wins with 74% confidence"
2. Kalshi price: PIT YES @ 69 cents
3. Polymarket price: PIT LONG @ 65 cents (via sport-aware mapper)
4. Bot buys on Polymarket (4 cents cheaper = 6% more profit)
```

**Kalshi-only mode:** Default `KALSHI_ONLY=true`. When enabled, skips Polymarket trading entirely (capital consolidating to Kalshi).

**Sport-aware matching:** Polymarket slugs contain the sport (`aec-mlb-pit-chc`). The mapper requires both team abbreviations AND the sport prefix to match, preventing cross-sport confusion (PIT Pirates MLB vs PIT Penguins NHL).

**Side matching:** `pickBestPlatform()` identifies which Polymarket side corresponds to the team we want by matching team abbreviations to slug positions and team names. First team in slug = LONG, second = SHORT.

**Team abbreviation mapping:** ESPN and Kalshi use different abbreviations for the same teams. The `ABBR_MAP` translates between them:
- CHW ↔ CWS (White Sox), AZ ↔ ARI (Diamondbacks), ATH ↔ OAK (Athletics)
- GS ↔ GSW (Warriors), WSH ↔ WAS (Washington), TB ↔ TBL (Lightning)
- MAN ↔ MUN (Manchester United), WOL ↔ WLV (Wolverhampton), VAL ↔ VLL (Valladolid)

---

## Position Management

### Smart Exits (Replacing Blind Stop-Loss)

The old system: sell if price drops 30%. The new system: Claude evaluates every losing position with full game context and makes sport-specific sell/hold decisions.

**Three-tier exit system:**

#### Tier 1: Rule-Based Auto-Exits
- **Late-game profit-take:** Auto-sell at 97c+ in late game. Risking 97c to gain 3c is 32:1 against.
- **Nuclear stop-loss:** Absolute floor, no Claude evaluation needed. Entry-price-tiered:
  - 70c+ entry: sell at -60%
  - 50-70c entry: sell at -75%
  - Under 50c entry: sell at -85%

#### Tier 2: Claude-Powered Sell/Hold Decisions
When a position hits the Claude evaluation threshold (varies by game stage and entry price), Haiku is asked to sell or hold with full context:

**Claude evaluation thresholds (% drop from entry):**

| Entry Price | Early Game | Mid Game | Late Game |
|------------|-----------|---------|----------|
| 70c+ (expensive) | -15% | -12% | -10% |
| 50-70c (mid) | -25% | -20% | -15% |
| Under 50c (cheap) | -35% | -30% | -25% |

Claude's prompt includes:
- Current position P&L and unrealized loss
- Live score and game detail from ESPN
- Game stage (early/mid/late/finished)
- Win expectancy percentage
- Sport-specific comeback statistics:
  - NBA: "15-pt comebacks happen 13% in the 3-point era"
  - MLB: "3-run comebacks happen 20% through 6 innings"
  - NHL: "2-goal comebacks ~15%"
  - Soccer: "1-goal deficits equalize ~20%"

Claude decides: SELL (lock in loss, free up capital) or HOLD (team still has a real shot).

**Sport-specific evaluation cooldowns:** NBA 8 minutes (fastest game pace), all others 12 minutes.

#### Tier 3: Winners Stay
No Claude evaluation on winning positions. If we're winning, we hold. Let it settle at $1. Every Haiku call on a winner is wasted money.

### Scale-In Logic

The bot can add to existing positions if the price improves:

- **Max entries per game:** 3
- **Max game exposure:** 15% of bankroll
- **Condition:** Price must be at least 2c cheaper than last entry
- If price is same or worse — nothing changed, don't add

### Settlement Reconciliation (`checkSettlements`)

Runs every 5 minutes. Reads `trades.jsonl`, finds open Kalshi trades, fetches closed/settled markets from Kalshi API, and matches them:

- Calculates P&L: `won = (side matches result)`, exit price is $1.00 (win) or $0.00 (loss)
- Updates trade status from `open` to `settled`
- Updates `consecutiveLosses` counter
- Runs per-strategy performance check

### Stop-Loss Outcome Review

After each settlement cycle, reviews whether previous stop-loss decisions were correct. Tracks:
- Trades sold early that would have won (missed profit)
- Trades sold early that would have lost further (saved capital)

### Position Sync

On every portfolio refresh, the bot syncs JSONL entries with Kalshi's actual portfolio:
- If a Kalshi trade is marked `open` in JSONL but no longer appears in Kalshi positions, it's auto-closed as `closed-manual` (manual cashout or settlement the bot missed)
- Grace period: trades placed in the last 5 minutes are exempt (Kalshi API can be slow to reflect new orders)

---

## Risk Management

### Position Sizing (Dynamic)

All limits scale automatically with bankroll.

**Per-trade size:** `getBankroll() * MAX_TRADE_FRACTION` (10%) capped by `getTradeCapCeiling()`.

**Confidence scaling:** Higher confidence = bigger bet. Margin 5% = 1x (base), 10% = 1.5x, 15% = 2x, 20%+ = 2.5x (max).

**Inverse deployment curve** (`getMaxDeployment()`): Aggressive when small (need growth), conservative when big (protect gains).

| Bankroll | Max Trade | Max Deploy | Max Positions | Per-Trade Ceiling |
|----------|-----------|------------|--------------|-------------------|
| $200 | $20 | $170 (85%) | 12 | $50 |
| $600 | $50 | $450 (75%) | 12 | $50 |
| $1,000 | $50 | $750 (75%) | 15 | $150 |
| $2,000 | $100 | $1,500 (75%) | 18 | $150 |
| $5,000 | $50 | $3,000 (60%) | 25 | $500 |
| $10,000 | $100 | $4,000 (40%) | 25 | $500 |
| $20,000 | $500 | $8,000 (40%) | 35 | $2,000 |
| $50,000 | $2,000 | $10,000 (20%) | 50 | $5,000 |

**How sizing works per trade:**
1. `getDynamicMaxTrade()` calculates: `min(bankroll * 10%, getTradeCapCeiling(), getAvailableCash())`
2. `getAvailableCash()` subtracts the 5% capital reserve from platform cash
3. `getPositionSize()` applies confidence scaling (higher edge = bigger bet) and consecutive-loss reduction (50% after 7 losses)
4. Claude's recommended bet amount is capped by the above
5. Final quantity: `floor(safeBet / price)`

### Circuit Breakers

| Control | Threshold | Action |
|---------|-----------|--------|
| Daily loss | 25% of bankroll (min $10) | Halt all trading, Telegram alert, auto-resume next day |
| Consecutive losses | 7 in a row | Reduce position size to 50% |
| Consecutive losses | 10 in a row | Full halt, Telegram alert |
| Available cash | Under $3 | Skip trading cycle (reserve protected) |
| Midnight ET | Auto | Reset daily limits, update consecutive loss count |

### Trade Gates (every trade passes ALL of these)

1. `canTrade()` — daily loss not exceeded, not halted, positions under dynamic limit, deployment under cap
2. `canDeployMore(amount)` — total deployed + new trade within deployment limit
3. `checkSportExposure(ticker)` — max 25% of bankroll per sport (min $15)
4. Confidence >= 65% (MIN_CONFIDENCE)
5. Dynamic margin gate (sport + price + situation aware)
6. Confidence hard-capped at baseline + 15% (prevents wild predictions)
7. Price >= 5 cents and <= 90 cents (MAX_PRICE)
8. Cooldown: 5 minutes between trades on same game (can be bypassed for scale-in at better price)
9. Position check: no existing position on same game (cross-platform aware) unless scaling in
10. Max entries per game: 3, max 15% of bankroll per game

### Cross-Platform Position Tracking

`openPositions` array includes BOTH:
- Kalshi positions from `/portfolio/positions` API (filtered by active exposure)
- Polymarket positions from `trades.jsonl` (open status)

This ensures deployment caps, position limits, and same-game checks work across both platforms.

---

## Dashboard (React Frontend)

The dashboard is a React SPA built with Vite, TypeScript, and Recharts, hosted on Vercel. It provides real-time monitoring of all bot activity.

### Global State

`ArborContext` polls 4 API endpoints every 15 seconds using `Promise.allSettled` (graceful partial failures):
- `/api/trades` — all trades (excludes `testing-void`)
- `/api/positions` — open positions (includes today's `closed-manual` Kalshi trades that may still be active)
- `/api/stats` — computed stats (win rate, streaks, sport performance, calibration, strategy breakdown, live bankroll estimate)
- `/api/snapshots` — daily snapshots for charts

### Pages

#### Command Center (/)
- **Bankroll Hero:** Total bankroll with Kalshi cash + positions + Polymarket breakdown. Today and all-time P&L.
- **Daily Challenge:** Progress bar toward 5% daily bankroll target.
- **Projections:** "If every day is like today" — weekly/monthly/yearly P&L projections. "If every day is like our average" — daily average, days to $1K/$5K.
- **Stats Grid:** Today's trades, win rate, streak (with fire animation at 3+), open positions, best/worst trade.
- **Bankroll Chart:** Recharts AreaChart of bankroll over time.
- **Active Positions:** Top 12 open positions with sport badge, price, quantity, deploy cost, confidence.
- **Recent Activity:** Last 10 trades with status icons (open/win/loss/stop-loss).
- **Achievements:** 14 badges (earned + locked).
- **Confetti:** Triggers on new win settlement.

#### Positions (/positions)
- Sport filter buttons (All, MLB, NBA, NHL, MLS, EPL, UFC, Other)
- Cards with: sport badge, exchange badge, title, side/price/qty/cost, potential profit, confidence, edge, hold time, strategy
- Expand to see Claude's reasoning
- Live score display if available

#### Trade History (/history)
- **Summary bar:** Total trades, settled count, W/L, win rate, P&L, average P&L
- **Multi-filter:** Date, sport (MLB/NBA/NHL/Soccer/UFC/Other), result (win/loss/open), strategy
- **Trade cards:** Date/time, sport badge, high-conviction fire indicator, title, status badge (open/settled/stop-loss/closed-manual), P&L, price/qty details
- Expand for: Claude's reasoning, live score at entry, strategy, exchange, ticker

#### Analytics (/analytics)
- **Bankroll Growth:** AreaChart with gradient fill
- **Performance by Sport:** Dual bar charts (win rate + P&L), plus data table
- **Confidence Calibration:** ScatterChart — predicted vs actual win rate. Dots on diagonal = perfectly calibrated. Above = underconfident (good). Below = overconfident (bad).
- **Strategy Breakdown:** PieChart of trades by strategy + table with trades/win rate/P&L per strategy
- **Performance by Hour (ET):** BarChart showing P&L by hour of day

#### Trade Review (/review)
- **Grade Summary:** A/B/C/D grade counts with visual badges
  - A = Great trade (right reasoning, outcome matched)
  - B = Solid process (good reasoning, bad luck or vice versa)
  - C = Weak trade (reasoning gaps)
  - D = Bad trade (should not have been taken)
- **Process vs Luck:** Tracks "process wins" (B grades that lost) and "lucky wins" (C grades that won)
- **Reviews activate** after 50 settled trades when the calibration engine kicks in
- Each trade shows: original Claude reasoning + AI review text (when available)

#### Live Feed (/live)
- **Real-time:** Polls `ai-out.log` every 10 seconds via `/api/live-feed`
- **Controls:** Live/Paused toggle, auto-scroll ON/OFF
- **Tag filters:** all, live-edge, pre-game, broad-scan, portfolio, exit, pnl, sync, risk
- **Type filters:** all types, trade, analysis, block, win, loss
- **Color coding:** Trades (green), wins (green), losses (red), blocks (red), analysis (accent), portfolio (muted), dry run (amber)
- Monospace font, timestamp + tag + message format
- Smart filtering: hides noisy portfolio lines unless specifically filtered

#### Settings (/settings)
- **System Status:** Bot online indicator, total trades, settled, W/L, win rate, open positions
- **Trading Configuration:** Read-only display of all config constants
- **Dynamic Margins (Live):** Sport base margins with score change adjustments
- **Dynamic Margins (Pre-Game):** Sport margins with price tier adjustments
- **Sport Status:** Per-sport health indicator (green/amber/red by win rate), trade count, win rate, P&L

### Design System

- **Dark theme:** `--bg-base: #0A0A0F`, `--bg-surface: #111118`, `--bg-elevated: #1A1A24`
- **Colors:** `--accent: #6366F1` (indigo), `--green: #22C55E`, `--red: #EF4444`, `--amber: #F59E0B`
- **Typography:** Inter (body), JetBrains Mono (numbers/data)
- **Responsive:** Desktop sidebar (220px fixed) + mobile bottom tabs with safe-area inset
- **Animations:** Pulse (live status dot), shimmer (skeleton loading), confetti (win celebration), fire glow (3+ win streak), badge pop (achievements)

### Achievements System

14 badges unlocked based on stats:

| Badge | Name | Condition |
|-------|------|-----------|
| First Blood | Placed first trade | 1+ trades |
| Winner Winner | Won first trade | 1+ wins |
| High Five | 5 winning trades | 5+ wins |
| Getting Serious | 10 trades placed | 10+ trades |
| Quarter Century | 25 trades placed | 25+ trades |
| Calibration Ready | 50 trades settled | 50+ settled |
| On Fire | 3-win streak | 3+ consecutive wins |
| Unstoppable | 5-win streak | 5+ consecutive wins |
| In The Green | Positive all-time P&L | P&L > $0 |
| Big Day | $50+ profit in one day | Today P&L >= $50 |
| Half a Grand | Bankroll hit $500 | Bankroll >= $500 |
| Comma Club | Bankroll hit $1,000 | Bankroll >= $1,000 |
| Diversified | Won in 3+ sports | 3+ sports with wins |
| Sharp | 60%+ win rate (10+ trades) | Win rate >= 60%, 10+ settled |

---

## Data API Server

`bot/api.mjs` runs on port 3456, serving bot data to the dashboard over HTTP.

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/trades` | GET | All trades from JSONL (excludes `testing-void`) |
| `/api/positions` | GET | Open trades + today's `closed-manual` Kalshi trades |
| `/api/stats` | GET | Computed stats: win rate, streaks, sport/strategy performance, calibration, live bankroll |
| `/api/snapshots` | GET | Daily snapshots from JSONL |
| `/api/screens` | GET | Last 100 screening decisions |
| `/api/live-feed` | GET | Parsed tail of `ai-out.log` with type categorization |

### Auth
Simple token auth: `?token=arbor-2026` or `Authorization: Bearer arbor-2026`

### Stats Computation (server-side)
The `/api/stats` endpoint computes everything on each request:
- Win rate, total P&L, today's P&L, best/worst trade
- Sport performance: per-sport trades, wins, losses, win rate, P&L
- Strategy performance: per-strategy trades, settled, wins, losses, win rate, P&L
- Calibration buckets: 65-70%, 70-75%, 75-80%, 80-85%, 85-90%, 90%+ — actual win rate vs predicted
- Win/loss streak
- Live bankroll estimate: last snapshot + P&L settled since snapshot

### Vercel Proxy
`api/proxy.js` bridges HTTPS (Vercel) to HTTP (VPS) to avoid mixed-content browser errors. Forwards query params, adds auth token, 10-second timeout, CORS headers, 10-second cache.

---

## Configuration

All constants are at the top of `ai-edge.mjs`:

```javascript
// Prediction thresholds
MIN_CONFIDENCE = 0.65       // Claude must be >= 65% confident
CONFIDENCE_MARGIN = 0.03    // Legacy flat margin — only used for draw bets + fallback
MAX_PRICE = 0.90            // Won't buy above 90 cents

// Sizing
MAX_TRADE_FRACTION = 0.10   // 10% of bankroll per trade (base)
MAX_ENTRIES_PER_GAME = 3    // Max times we can buy into same game
MAX_GAME_EXPOSURE_PCT = 0.15 // Max 15% of bankroll on one game

// Timing
POLL_INTERVAL_MS = 60,000            // Main loop: every 60 seconds
PREGAME_SCAN_INTERVAL = 900,000      // Pre-game: every 15 minutes
MAX_PREGAME_PER_DAY = 2              // Max pre-game trades per day
BROAD_SCAN_INTERVAL = 1,800,000      // Broad scan: every 30 minutes
UFC_SCAN_INTERVAL = 1,800,000        // UFC: every 30 minutes
COOLDOWN_MS = 300,000                // 5 min between same-game trades
MAX_SONNET_PER_CYCLE = 6             // Max Sonnet calls per live-edge cycle

// Risk
DAILY_LOSS_PCT = 0.25       // Halt at 25% daily loss (room for bad streaks at small bankroll)
CAPITAL_RESERVE = 0.05      // Keep 5% untouched
MAX_CONSECUTIVE_LOSSES = 7  // Half size after 7 straight losses
SPORT_EXPOSURE_PCT = 0.25   // Max 25% bankroll per sport (min $15)
MAX_DAYS_OUT = 1            // Same-day markets only (sports by ticker date, soccer 3 days)

// AI Models
CLAUDE_SCREENER = 'claude-haiku-4-5-20251001'  // Cheap screening — $0.002/call
CLAUDE_DECIDER = 'claude-sonnet-4-6'            // Expensive decisions — only on candidates

// Modes
DRY_RUN = false              // Set true or --dry-run flag — runs full pipeline, no real orders
KALSHI_ONLY = true           // Default: skip Polymarket trading
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
  "otherPlatformPrice": 0.59,
  "highConviction": false,
  "status": "settled",
  "exitPrice": 0.0,
  "realizedPnL": -11.78,
  "settledAt": "2026-04-12T22:30:00.000Z",
  "result": "no"
}
```

**Trade statuses:** `open`, `settled`, `sold-stop-loss`, `sold-claude-stop`, `sold-claude-sell`, `closed-manual`, `testing-void`

**Strategy types:** `live-prediction`, `pre-game-prediction`, `ufc-prediction`, `claude-prediction` (broad scan), `resolution-arb`, `draw-bet`, `high-conviction`

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
  "timestamp": "2026-04-12T04:00:00.000Z",
  "bankroll": 251.34,
  "kalshiCash": 94.02,
  "kalshiPositions": 96.65,
  "polyBalance": 60.67,
  "openPositionCount": 16,
  "totalDeployed": 159.36,
  "totalTrades": 6,
  "settledTrades": 2,
  "wins": 0,
  "losses": 2,
  "winRate": 0,
  "totalPnL": -36.14,
  "todayPnL": -36.14,
  "todayTrades": 6,
  "consecutiveLosses": 2,
  "strategyStats": {
    "live-prediction": {"trades": 2, "settled": 2, "wins": 0, "losses": 2, "pnl": -36.14}
  }
}
```

### Calibration Engine

Runs daily at 6am ET (after overnight settlements). Analyzes all settled trades to measure how well Claude's confidence predictions match actual outcomes. Results are served via `/api/stats` and displayed on the Analytics page as a scatter chart.

Buckets: 65-70%, 70-75%, 75-80%, 80-85%, 85-90%, 90%+

### Strategy Auto-Disable Alerts

After each settlement batch, the system calculates per-strategy win rates. If ANY strategy has 10+ settled trades AND win rate drops below 40%, a Telegram alert is sent. This doesn't auto-disable (human decision required) but ensures you know when a strategy is bleeding money.

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
Bought on Poly (69c Kalshi -> 65c Poly)

[Claude's reasoning with specific facts]
```

### High-Conviction Trade
```
HIGH CONVICTION BET - KALSHI

[NBA team] up 22 in Q4

BUY @ 87c x 80 = $69.60
Confidence: 93% vs price 87c

HIGH CONVICTION — NBA Q4 up 22 pts — <1% comeback
```

### Draw Bet
```
DRAW BET - KALSHI

ATL 0-0 NSH at 72'

BUY TIE @ 62c x 15 = $9.30
Draw probability: 78% vs price 62c
Potential profit: $5.70

Pure math: 0-0 at 72' = 78% draw historically
```

### Resolution Arb
```
RESOLUTION ARB - KALSHI

[Game Title]
Result: YES WON

BUY YES @ $0.93 x 50
Deployed: $46.50
Guaranteed profit: $3.50 (7c/contract after fees)
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

Open: 16 positions, $159.36 deployed
Consecutive losses: 2
API spend today: ~$0.85 (12 calls)
```

### Health Check (8am ET daily)
```
ARBOR DAILY HEALTH CHECK

arbor-ai — online (9h uptime, 0 restarts)
arbor-arb — stopped (intentional)
arbor-health — online (0h uptime)

All systems operational

Kalshi Balance:
Cash: $94.02
Positions: $96.65
Total: $190.67

Open Positions: 16

P&L Summary:
Total: -$36.14 (2 settled)
Today: +$0.00 | 0 trades placed
Open: 16 trades, $159.36 deployed
```

### Trading Halt
```
TRADING HALTED

Daily loss limit hit: $38.50 lost today (limit: $62.84 = 25% of $251.34)
Bot will resume tomorrow.
```

### Bot Startup
```
AI Edge Bot Started

Risk Controls Active:
Max trade: $25.13 (10% of bankroll, ceiling $50)
Max deploy: 85% ($213.64) | Positions: 12
Daily loss halt: $62.84 (25%)
Reserve: 5% ($12.57) | Game cap: 15% ($37.70)
Pre-game: max 2/cycle, 2/day | Consecutive loss: 7->half

Config:
Min confidence: 65% | Margins: dynamic by sport + price
Mode: Kalshi only | LIVE TRADING
Sonnet + web search | Live-edge: every 60s

Kalshi: $94.02 cash + $96.65 positions
Polymarket: $60.67
Total bankroll: $251.34
```

---

## API Integrations

### Kalshi (Primary exchange)
- **Auth:** RSA-PSS signature (PKCS1 PSS padding, salt length 32)
- **Endpoints used:**
  - `GET /portfolio/balance` — cash + position value
  - `GET /portfolio/positions` — open positions (filtered by event_exposure > 0)
  - `POST /portfolio/orders` — place buy/sell orders
  - `GET /markets` — fetch market prices (by series, status)
  - `GET /markets/{ticker}` — individual market price (position management)

### Polymarket US (Secondary exchange, disabled by default)
- **Auth:** Ed25519 signature (signAsync, NO body in POST signature)
- **Endpoints used:**
  - `GET /v1/account/balances` — cash balance
  - `POST /v1/orders` — place orders (IOC limit orders)
  - `GET /v1/markets` (gateway API) — fetch market listings (paginated, 200/page)
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
- **Signing note:** The `sha512Sync` function from Node's crypto module is set once at initialization. Falls back to `signAsync` which has internal sha512. Handles frozen `ed.etc` objects gracefully.

### ESPN (Data source — no auth)
- **Scoreboards:** `site.api.espn.com/apis/site/v2/sports/{sport}/scoreboard`
- **Six leagues:** baseball/mlb, basketball/nba, hockey/nhl, soccer/usa.1, soccer/eng.1, soccer/esp.1
- **Data extracted:**

| Data Point | Source | Used In |
|-----------|--------|---------|
| Team records (overall) | `competitor.records[0].summary` | All prompts |
| Home/away records | `competitor.records[type=home/road]` | Live-edge + pre-game |
| Current pitcher stats | `competition.situation.pitcher.summary` | Live MLB |
| Starting pitcher ERA | `competitor.probables[].statistics[ERA]` | Live + pre-game MLB |
| Starting pitcher W-L | `competitor.probables[].statistics[W/L]` | Live + pre-game MLB |
| Team batting average | `competitor.statistics[AVG]` | Live MLB |
| NBA FG%, 3P%, REB, AST, FTA | `competitor.statistics[...]` | Live NBA |
| Leading scorers | `competitor.leaders[points]` | Live NBA |
| Inning/quarter scores | `competitor.linescores[]` | Live prompt |
| Runners on base | `competition.situation.onFirst/Second/Third` | Live MLB |
| Outs | `competition.situation.outs` | Live MLB |
| Current batter | `competition.situation.batter` | Live MLB |
| Last play | `competition.situation.lastPlay.text` | Live MLB |
| Game status detail | `competition.status.type.shortDetail` | All prompts |
| Game state | `competition.status.type.state` | in/post filtering |

### CoinGecko (Crypto prices — no auth)
- **Endpoint:** `api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd`
- **Used in:** Broad scan prompt context for crypto market analysis

### Anthropic (AI decisions)
- **Models:** Haiku 4.5 (screening, stop-loss eval), Sonnet 4.6 (predictions + web search)
- **Web search:** `web_search_20250305` tool (1-5 uses per call depending on strategy)
- **Cost:** ~$5-8/day at current usage

### Telegram (Notifications)
- **Bot API:** sendMessage with HTML parse mode
- **Notifications:** Every trade, daily reports (8pm + midnight), halt alerts, stop-loss triggers, strategy alerts, bot start/stop

---

## Poll Cycle Flow

Every 60 seconds, `pollCycle()` runs this sequence:

```
1. refreshPortfolio()
   ├── Fetch Kalshi balance + positions
   ├── Filter positions by active exposure (not settled/cashed out)
   ├── Read trades.jsonl for open Poly positions
   ├── Refresh Poly balance via Ed25519 signed request
   └── Sync: auto-close JSONL entries not in Kalshi portfolio (5-min grace)

2. Daily reset check (midnight ET)
   └── Reset daily loss tracking, update consecutive losses from JSONL

3. canTrade() gate
   └── Check: not halted, daily loss OK, positions under dynamic limit, deployment under cap, cash >= $3

4. checkLiveScoreEdges() [every cycle — most time-sensitive]
   ├── Phase 1: Parallel ESPN fetch (6 leagues), collect games with leads/ties
   ├── Score change detection + win expectancy baseline calculation
   ├── Line movement detection (5c+ swings)
   ├── Phase 2: Batch fetch all sports market prices (6 series in parallel)
   ├── Draw bet check (soccer tied games, pure math)
   ├── Phase 3: Queue candidates, cap at 6 Sonnet calls
   └── Phase 4: Fire Sonnet calls in parallel (3 at a time), execute trades

5. checkPreGamePredictions() [every 15 min, before 6pm ET, max 2/day]
   ├── Fetch today's Kalshi sports markets (6 leagues, soccer +3 days)
   ├── Group both team tickers per game, filter TIE
   ├── Haiku screens most predictable games
   ├── Sonnet + web search predicts each with baselines
   └── Cross-platform price check, buy on cheaper

6. checkUFCPredictions() [every 30 min]
   ├── Fetch Poly UFC moneylines
   ├── Haiku picks 2 most predictable fights
   └── Sonnet researches fighters, buy if confidence passes

7. claudeBroadScan() [every 30 min]
   ├── Fetch 200+ markets across all categories + Golf/Masters keywords
   ├── Filter: sports by ticker date, non-sports by close time, soccer +3 days
   ├── Dedup sports, fetch context (ESPN news + BTC/ETH prices)
   ├── Haiku screens for 5 candidates
   ├── Sonnet researches each (sports BLOCKED from execution)
   └── Execute non-sports trades only
```

Every 5 minutes, `settlementLoop()` runs:
```
1. managePositions()    — Claude-powered sell/hold + auto profit-take + nuclear stop
2. checkSettlements()   — reconcile closed markets with trade log
3. reviewStopLossOutcomes() — track whether stop-loss decisions were correct
4. checkResolutionArbs() — buy winning sides below $0.95
```

Every hour, `calibrationLoop()` checks:
```
At 6am ET: runCalibration() — daily calibration engine
```

Every 30 minutes, `dailyReportLoop()` checks:
```
At midnight ET (hour 0): sendDailyReport()
At 8pm ET (hour 20): sendDailyReport()
```

Every 5 minutes, `statsLoop()` runs:
```
logStats() — console log of claude calls, trades, API spend, balance, P&L
```

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

### Frontend Hosting
- **Vercel:** React dashboard auto-deployed from git
- **Proxy:** Serverless function at `/api/proxy` bridges HTTPS to VPS HTTP
- **Cache:** 10-second s-maxage with 5-second stale-while-revalidate

### Environment Variables Required

**VPS (bot/.env):**
```
KALSHI_API_KEY_ID=...
KALSHI_PRIVATE_KEY_PATH=./kalshi-private-key.pem
ANTHROPIC_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
POLY_US_KEY_ID=...
POLY_US_SECRET_KEY=...
API_TOKEN=arbor-2026
API_PORT=3456
DRY_RUN=false
KALSHI_ONLY=true
```

**Frontend (.env):**
```
VITE_API_URL=http://87.99.155.128:3456
VITE_API_TOKEN=arbor-2026
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

**Vercel (environment variables):**
```
VPS_API_URL=http://87.99.155.128:3456
API_TOKEN=arbor-2026
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

1. **Early validation phase.** Need 50+ trades under the prediction system to validate win rate and calibration accuracy. The calibration engine and trade review system activate at that threshold.

2. **No Polymarket sell capability.** Can buy on Poly but can't sell/exit positions early. Stop-loss and Claude-powered exits are Kalshi-only. Poly positions ride to settlement.

3. **Kalshi settlement delay.** Sports markets take hours to settle after games end. Capital is locked during this period. Resolution arbs partially mitigate this.

4. **Claude cost.** At ~$5-8/day, API costs eat into small-bankroll profits. Becomes negligible at $1,000+ bankroll.

5. **Single point of failure.** One bot on one VPS. If VPS goes down, no trading. pm2 auto-restarts on crash, but hardware failure = downtime.

6. **No backtesting.** Predictions are forward-only. Can't validate strategy against historical data without building a separate backtesting framework.

7. **ESPN dependency.** All live game data comes from ESPN's public API. If ESPN changes endpoints or rate-limits, live-edge and position management are affected.

8. **Soccer draw complexity.** Draw bets use historical baselines without Claude analysis. The baseline accuracy depends on the specific matchup quality (top team vs bottom team has different draw rates than mid-table clash).

9. **Broad scan sports blocked.** Sports games are blocked from broad-scan execution because side mapping (YES = which team?) is unreliable without proper ticker parsing. Pre-game and live-edge handle sports with correct mapping.

10. **Polymarket defaults off.** `KALSHI_ONLY=true` means cross-platform price advantage is not active by default. Must be explicitly enabled.

---

## Supabase Edge Functions (Legacy/Auxiliary)

The `supabase/functions/` directory contains edge functions that were part of an earlier architecture:

| Function | Purpose |
|----------|---------|
| `scanner/` | Server-side scan cycle — fetches Kalshi/Polymarket markets, uses Claude for polarity verification, writes to Supabase |
| `analytics/` | Analytics computation edge function |
| `fastpoll/` | Fast polling edge function |
| `kalshiws/` | Kalshi WebSocket connection handler |
| `notify/` | Notification delivery |
| `resolve/` | Market resolution verification |
| `trade/` | Trade execution edge function |

These functions contain sophisticated logic (polarity-correct token mapping, orderbook walking, fuzzy market matching) but the primary trading pipeline now runs entirely in `bot/ai-edge.mjs`. The scanner's `calculator.ts` and `matcher.ts` logic is preserved in `src/lib/` for reference but not imported by the frontend.

---

## Database Schema (Supabase Migrations)

17 migration files define the Supabase schema:

| Migration | Purpose |
|-----------|---------|
| 001_initial_schema | Base tables for markets, trades |
| 002_scan_results | Scan result storage |
| 003_scan_results_date_stats | Date-based statistics |
| 004_polarity_columns | Polarity verification columns |
| 005_positions_columns | Position tracking columns |
| 006_positions_execution | Execution details |
| 008_known_game_markets | Known game market cache |
| 009_positions_kelly | Kelly criterion sizing fields |
| 010_spread_persistence | Spread data persistence |
| 011_positions_type | Position type classification |
| 012_resolution_opportunities | Resolution arb tracking |
| 013_spread_events_skipped | Skipped spread events |
| 014_known_game_markets_espn | ESPN market mapping |
| 015_positions_settlement | Settlement tracking |
| 016_spread_events_alerted_at | Alert timestamps |
| 017_spread_events_unique_pair_id | Unique pair identification |
