
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
  Kalshi REST API → Market prices, order placement, positions, settlement
  Polymarket US API → Market prices, order placement, balance
  Polymarket Gateway API → Market listings, settlement status
  Anthropic API → Claude Haiku (screening) + Sonnet 4.6 (decisions + web search)
  Telegram Bot API → Trade notifications, daily reports, alerts
  CoinGecko API → BTC/ETH spot prices for broad scan context
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
| `bot/arb-bot.mjs` | ~32,800 | Legacy arbitrage bot (stopped) |
| `bot/market-maker.mjs` | ~21,000 | Legacy market maker (disabled — thin sports markets cause one-sided fills) |
| `bot/test-poly-order.mjs` | ~6,400 | Polymarket order test script |
| `bot/deploy-vps.sh` | ~1,000 | VPS deployment script (rsync + pm2 restart) |
| `api/proxy.js` | 37 | Vercel serverless proxy — HTTPS frontend → HTTP VPS (avoids mixed content) |
| `src/App.tsx` | 30 | React app with 7 routes |
| `src/context/ArborContext.tsx` | 91 | Global state provider — polls API every 15 seconds |
| `src/lib/api.ts` | 31 | Frontend API client — dev hits VPS directly, prod uses Vercel proxy |
| `src/lib/calculator.ts` | 130 | Reference: orderbook walking + arbitrage calculation (legacy, not imported) |
| `src/lib/matcher.ts` | 105 | Reference: fuzzy market title matching (legacy, not imported) |
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
| `bot/logs/trades.jsonl` | grows | Every trade with full entry/exit/P&L/reasoning |
| `bot/logs/screens.jsonl` | grows | Every screening and decision for analysis |
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
2. **Phase 2 — Prioritize:** Score change detection compares current game state to last seen state. Win expectancy baseline calculated for each candidate. Candidates sorted by baseline WE — highest opportunity first. Games seen for the first time are skipped (no baseline to compare).
3. **Line Movement Detection:** Monitors price changes across cycles. A 5-cent or larger price swing (`LINE_MOVE_THRESHOLD`) gets flagged and boosted to the top of the analysis queue (baseline WE overridden to 90% for priority).
4. **Batch Price Fetch:** All sports market prices fetched in one parallel call (6 series: KXMLBGAME, KXNBAGAME, KXNHLGAME, KXMLSGAME, KXEPLGAME, KXLALIGAGAME). Prices cached in `cachedPrices` Map for instant lookup per game — no per-market API calls.
5. **Phase 3 — Analyze:** Sonnet + web search analyzes candidates in priority order (max 6 per cycle, batched 3 at a time in parallel). Each prompt includes rich ESPN context:
   - Team records (overall + home/away splits)
   - Current pitcher stats (IP, ER, K, BB — live from ESPN)
   - Starting/probable pitcher ERA, W-L
   - Inning-by-inning line score
   - Live situation (outs, runners on base, current batter, last play)
   - Team batting averages
   - NBA shooting stats (FG%, 3P%, rebounds, assists, FTA) with shooting dominance flags (10%+ FG gap)
   - Leading scorers (NBA)
   - Time remaining (critical for NBA/NHL — "3:21 - 2nd")
   - Historical win expectancy baseline text (see Win Expectancy section)
   - Soccer draw rate warnings (team-specific W-D-L draw rate from record)
6. **Confidence Hard Cap:** Claude's confidence is capped at historical baseline + 15%. For trailing teams (underdogs), baseline is `1 - winExpectancy`. Prevents hallucinations like "17% baseline → 68% confidence."
7. **Dynamic Margin Gate:** Sport-aware, price-aware, situation-aware margin (see Dynamic Margins section). Entry gate uses raw edge (confidence - price); fees affect profit, not prediction quality.
8. **Cross-Platform Price Check:** Compares Kalshi vs Polymarket prices, buys on cheaper platform. Requires at least 2-cent savings to switch.
9. **Phase 4 — Execute:** Orders placed on best platform, trades logged to JSONL with full context, Telegram notification sent with reasoning.

**Underdog Logic:**

In live games, the bot evaluates BOTH the leading AND trailing team. Default is the leading team, but the trailing team is evaluated as an underdog if ALL conditions are met:

| Sport | Max Deficit | Max Period | Trail Price Range |
|-------|-----------|-----------|------------------|
| NHL | 1 goal | Period 1 | 15-40c |
| NBA | 10 points | Quarter 2 | 15-40c |
| MLB | 2 runs | Inning 5 | 15-40c |
| Soccer | 1 goal | 1st Half | 15-40c |

**Additional underdog requirement:** The trailing team must have **10+ more wins** in their season record than the leading team. Not just a slightly better record — a significantly better team.

### 2. Soccer Draw Betting

**Frequency:** Every 60 seconds (part of live-edge cycle)
**Leagues:** MLS, EPL, La Liga
**When:** Tied soccer games in 2nd half (or late 1st half if 0-0)

**How it works:**

1. Detects tied soccer games during the live-edge cycle. Parses minutes from ESPN status detail (e.g. "72'" or "2nd - 27'").
2. Calculates draw probability from research-verified historical baselines by minute:

**0-0 games (highest draw rates):**
| Minute | Draw Probability |
|--------|-----------------|
| 80'+ | 88% |
| 75' | 85% |
| 70' | 78% |
| 65' | 70% |
| 60' | 59% |
| 55' | 50% |
| 45' (2nd half start) | 42% |
| 35' (late 1st half) | 36% |

**Score-matched games (1-1, 2-2, etc.):**
| Minute | Draw Probability |
|--------|-----------------|
| 80'+ | 84% |
| 75' | 80% |
| 70' | 72% |
| 65' | 63% |
| 60' | 55% |
| 55' | 47% |

3. Finds the TIE market from `cachedPrices` (instant, no API call needed — prices already fetched in batch)
4. Buys if draw probability exceeds price by 3%+ (uses flat CONFIDENCE_MARGIN, not dynamic margin) and price is between 10-90c
5. **Pure math strategy — no Claude AI call, no Haiku screen, no web search.** Uses historical baselines only.
6. After a draw bet, the game is skipped for normal team-win analysis (no leader to bet on when tied)

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
**When:** Before 6pm ET only (shuts off automatically — once live games start, live-edge takes over)
**Daily limit:** Max 2 trades per day (survives restarts — counter restored from JSONL on startup)
**Max per scan cycle:** 2 trades
**Eligible sports: NBA and NHL only**

MLB and soccer are explicitly blocked because their sport-specific confidence caps are too low to pass the 70% minimum:
- MLB baseline 54% + max 8% bonus = 62% max → fails 70% requirement
- Soccer baseline 45% + max 8% bonus = 53% max → fails (draws make pre-game too risky)
- NBA baseline 63% + max 20% bonus = 83% max → passes
- NHL baseline 59% + max 15% bonus = 74% max → passes

**How it works:**

1. Fetches today's Kalshi sports markets across all 6 leagues. Soccer gets a 3-day lookahead (games scheduled in advance, not daily like US sports). Groups both team tickers per game, filters out TIE tickers.
2. Filters to NBA and NHL only (`PRE_GAME_ELIGIBLE_SPORTS`).
3. **No Haiku screening step.** All eligible games go directly to Sonnet (max 8 games, batched 3 at a time in parallel). Each game gets its own Sonnet + web search call with a sport-specific prompt including baselines.
4. Claude responds with a team pick, confidence, bet amount, and reasoning.
5. **Team pick validation:** Claude's chosen team is matched to the correct ticker (always buying YES on that team's market). If Claude outputs a team abbreviation that doesn't match either game team, the trade is blocked.
6. **Reasoning cross-validation:** The bot analyzes Claude's reasoning text for sentiment toward each team (positive/negative word matching). If the reasoning overwhelmingly favors the OTHER team (e.g., Claude says "BUF wins" but reasoning praises CHI), the trade is blocked. This prevents abbreviation confusion errors.
7. **Sport confusion detection:** If Claude's reasoning mentions the wrong sport (e.g., "pitcher" in an NHL game, "ERA" in an NBA game), the trade is blocked.
8. **Pre-game confidence cap:** Sport-specific, stricter than live:
   - NBA: capped at baseline + 20% = max 83%
   - NHL: capped at baseline + 15% = max 74%
9. **Pre-game minimum confidence: 70%** (higher than live's 65% — market has had time to settle)
10. Dynamic pre-game margin applied (sport base + 1% + price penalty for 70c+ favorites)
11. Cross-platform price check, duplicate position checks (Kalshi API + JSONL), and execution

### 4. UFC Fight Predictions (Polymarket Only)

**Frequency:** Every 30 minutes
**When:** UFC fight cards are upcoming
**How it works:**

1. Fetches UFC moneylines from Polymarket (slug format: `aec-ufc-{fighter1}-{fighter2}-{date}`)
2. Haiku screens: "Which 2 fights are most predictable?"
3. Sonnet + web search researches each: fighter records, style matchups, recent form, physical advantages
4. Same confidence gate as live sports (65% min, dynamic margin)
5. Polymarket-only (Kalshi doesn't offer UFC moneylines)

### 5. Broad Market Scan

**Frequency:** Every 30 minutes
**When:** Always running (requires at least $5 Kalshi balance)

**How it works:**

1. Fetches ALL open Kalshi markets: sports series (6 leagues + NFL), non-sports series (crypto, economics, finance, politics), plus keyword-based Golf/Masters markets (searches for "masters", "rory", "scheffler", etc.)
2. **Date filtering:** Sports filtered by ticker date (today/tonight only, tomorrow after 10pm ET, soccer gets 3-day window), non-sports by close time (max 1 day out)
3. Sports deduped (same game has 2 tickers, one per team — only show once per game)
4. Markets grouped by event for bracket markets (CPI, GDP shown as cumulative thresholds together)
5. Fetches contextual data in parallel: ESPN MLB news headlines + BTC/ETH spot prices from CoinGecko
6. Builds position-aware market list (excludes games with existing positions)
7. **Haiku screens** all tradeable markets (max 80 lines in prompt) for up to 5 candidates
8. **Sonnet + web search** researches each candidate with sport-specific or non-sports prompts
9. **Sports games BLOCKED from execution** (lines 2843-2848) — sports side mapping (YES = which team?) is unreliable in broad scan. Pre-game and live-edge handle sports with correct mapping.
10. **Non-sports: confidence cap** for sports tickers in broad scan uses home-team baselines (MLB 54%, NBA 63%, NHL 59%, Soccer 45-49%) + 20% max deviation
11. One trade per broad scan cycle (breaks after first successful trade)

**Market categories scanned:**
- Sports: KXMLBGAME, KXNBAGAME, KXNHLGAME, KXNFLGAME, KXMLSGAME, KXEPLGAME, KXLALIGAGAME
- Golf: keyword-based (Masters, Rory, Scheffler, Cameron Young, McIlroy, Scottie)
- Crypto: KXBTC, KXETH
- Economics: KXFED, KXCPI, KXGDP
- Finance: KXSP, KXGOLD
- Politics: KXNEWPOPE, KXPRES, KXSENATE, KXHOUSE

### 6. Resolution Arbitrage (Kalshi)

**Frequency:** Every 5 minutes
**When:** After games end (requires at least $2 Kalshi balance + canTrade())

**How it works:**

1. Fetches Kalshi markets with status `closed` and `settled` (up to 50 per status)
2. For each market with a known result, checks if the winning side is still priced below 95c
3. Calculates net profit after Kalshi parabolic fee: `(1 - winPrice) - 0.07 * winPrice * (1 - winPrice)`. Skips if net profit < 1c.
4. **ESPN verification for sports:** For MLB, NBA, NFL, and NHL games (not soccer), cross-checks ESPN scoreboard final scores to confirm the winner matches Kalshi's result. If ESPN disagrees or is unreachable, the arb is skipped (fail-closed).
5. Sizes aggressively — up to 50% of Kalshi cash, capped by `getTradeCapCeiling()` (risk-free, guaranteed settlement at $1)
6. 1-hour cooldown per ticker

### 7. High-Conviction Tier

**Trigger:** Late-game situations where Claude is 90%+ confident
**Sizing:** 20-30% of bankroll instead of normal 10%

**Sport-specific qualifiers (all require `stage === 'late'` + 90%+ confidence):**

| Sport | Condition | Comeback Rate | Tier |
|-------|----------|--------------|------|
| NBA | 20+ pts in Q4 | <1% | 93%+ → 30%, 90%+ → 25% |
| NBA | 15+ pts in Q4 | ~2% | 93%+ → 30%, 90%+ → 25% |
| NHL | 2+ goals in P3 | ~5% | 93%+ → 30%, 90%+ → 25% |
| NHL | 1 goal in P3 | check time | 90%+ → 25%, <93% → 20% |
| MLB | 4+ runs in 7th+ | ~2% | 93%+ → 30%, 90%+ → 25% |
| MLB | 3+ runs in 8th+ | ~5% | 93%+ → 30%, 90%+ → 25% |
| Soccer | 2+ goals at 75'+ | <3% | 93%+ → 30%, 90%+ → 25% |

**Safety rails:**
- Max 1 high-conviction bet per hour (`60 * 60 * 1000ms` since last)
- Max 40% of bankroll in active high-conviction positions (`highConvictionDeployed`)
- Own ceiling: 50% of bankroll per trade (overrides normal trade ceiling)
- Bypasses normal `getTradeCapCeiling()` — HC bets are rare and near-certain

---

## Two-Model Pipeline

Every strategy uses Claude, but in different ways:

| Strategy | Haiku Screen? | Sonnet Decision? | Web Search? |
|----------|--------------|-----------------|-------------|
| Live in-game | No (uses win expectancy baselines) | Yes (batched 3 parallel) | Yes (1 search/game) |
| Soccer draw | No | No (pure math) | No |
| Pre-game | No | Yes (batched 3 parallel) | Yes (2 searches/game) |
| UFC | Yes | Yes | Yes (3 searches/fight) |
| Broad scan | Yes | Yes | Yes (3 searches/candidate) |
| Position management | No | No (Haiku evaluates sell/hold) | No |

**Claude models:**
- **Haiku 4.5** (`claude-haiku-4-5-20251001`): ~$0.002/call, 300 max tokens, 10s timeout. Used for: broad scan screening, UFC screening, position sell/hold evaluation.
- **Sonnet 4.6** (`claude-sonnet-4-6`): ~$0.03-0.05/call, 500-1500 max tokens, 45s timeout. Used for: all trade decisions with web search enabled (`web_search_20250305` tool).

**Cost comparison:**
- Old approach: Sonnet on every market = ~$36/day
- Current approach: Haiku screens + Sonnet on picks = ~$5-8/day

---

## Win Expectancy Baselines

Claude's predictions are anchored to historical baselines, preventing wild confidence swings. The bot provides sport-specific win expectancy tables in every live-edge prompt. A home-court/field adjustment of +3% is added for home teams, -1% for away.

### MLB (Source: Tom Tango/tangotiger.net, FanGraphs, 1903-2024)
| Run Lead | Inn 1 | Inn 2 | Inn 3 | Inn 4 | Inn 5 | Inn 6 | Inn 7 | Inn 8 | Inn 9 |
|----------|-------|-------|-------|-------|-------|-------|-------|-------|-------|
| 1 | 56% | 58% | 60% | 64% | 67% | 71% | 77% | 84% | 91% |
| 2 | 64% | 67% | 70% | 76% | 79% | 83% | 88% | 93% | 96% |
| 3 | 72% | 75% | 78% | 85% | 87% | 90% | 93% | 96% | 98% |
| 4 | 79% | 82% | 85% | 90% | 92% | 94% | 96% | 98% | 99% |
| 5+ | 85% | 87% | 90% | 93% | 95% | 97% | 98% | 99% | 99% |

### NBA (Source: Professor MJ, inpredictable.com — Modern era 2015+)
| Point Lead | Q1 | Q2 | Q3 | Q4 |
|-----------|-----|-----|-----|-----|
| 5 | 57% | 60% | 65% | 75% |
| 10 | 63% | 69% | 77% | 86% |
| 15 | 70% | 78% | 85% | 92% |
| 20 | 78% | 85% | 91% | 96% |
| 25+ | 85% | 90% | 95% | 98% |

Note: 15-point comebacks now happen 13% of the time (was 6% pre-2002) due to 3-point shooting revolution. Home court advantage: 62.7% overall.

### NHL (Source: Hockey Graphs, MoneyPuck)
| Goal Lead | P1 | P2 | P3 |
|----------|-----|-----|-----|
| 1 | 62% | 68% | 79% |
| 2 | 80% | 86% | 93% |
| 3+ | 92% | 95% | 99% |

Scoring first jumps to 70% win probability. Home ice advantage: 59%.

### Soccer (Source: brendansudol.github.io, EPL/MLS data)
| Goal Lead | 1st Half | 2nd Half |
|----------|----------|----------|
| 1 | 65% | 78% |
| 2 | 82% | 92% |
| 3+ | 94% | 98% |

Draw rates: EPL 28%, MLS 24%. Home advantage: EPL 45% home wins, MLS 49%. Red card = ~25-30% swing.

**Confidence Hard Cap:** Claude cannot deviate more than 15% above the historical baseline for the target team. For trailing teams (underdogs), the baseline is `1 - winExpectancy`. Maximum cap is 95%.

Example: Team leading 1-0 in NHL P1 has 62% baseline. Claude can predict up to 77% (62% + 15%). If Claude says 85%, it's capped to 77%.

---

## Dynamic Confidence Margins

Replaced the old flat 5% margin. Margins are now sport-aware, price-aware, and situation-aware. The function `getRequiredMargin(price, options)` calculates the required edge for each trade.

### Key Insight

Live and pre-game bets are fundamentally different:
- **Live:** Price reflects game state. A team up 20 in Q4 at 85c is a BETTER bet than a pre-game toss-up at 50c. Don't penalize high prices.
- **Pre-game:** Price reflects market consensus. A 75c favorite could easily lose. Be selective, especially on expensive favorites.

### Sport Base Margins
| Sport | Base |
|-------|------|
| NHL | 3% |
| NBA | 4% |
| MLB | 5% |
| Soccer (MLS/EPL/La Liga) | 5% |
| UFC | 2% |
| Crypto | 4% |
| Economics | 4% |
| Politics | 4% |

### Live Margins (Sport Base Only — NO price penalty)

| Adjustment | Effect |
|-----------|--------|
| Score changed since last check | -1% (market recalculating, act fast) |
| 5c+ line movement detected | -1% (something happened, edge window) |
| Minimum margin floor | 1% |

Example: NBA base 4%, score just changed → 3% margin required.

### Pre-Game Margins (Sport Base + 1% + Price Penalty)

| Price Range | Additional Penalty |
|------------|-------------------|
| Under 55c | +0% |
| 55-70c | +1% |
| 70c+ (Trap Zone) | +3% |

Pre-game always adds +1% over live (market has had time to settle). Minimum 2%.

**Computed pre-game margins by sport:**

| Sport | Under 55c | 55-70c | 70c+ |
|-------|-----------|--------|------|
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

**Kalshi-only mode:** Default `KALSHI_ONLY=true`. When enabled, `pickBestPlatform()` immediately returns Kalshi without checking Polymarket. Capital is consolidating to Kalshi.

**Polymarket moneyline cache:** The bot caches all active Polymarket moneylines every 3 minutes (`POLY_CACHE_MS`). Fetches up to 1000 markets in batches of 200 from the gateway API. Filters to `marketType === 'moneyline'` only (futures blocked — they lock capital for months).

**Sport-aware matching (`findPolyMarketForGame`):** Polymarket slugs use format `aec-{sport}-{team1}-{team2}-{date}`. The mapper requires both team abbreviations AND the sport prefix (e.g., `-mlb-`, `-nba-`) to be present in the slug. This prevents cross-sport confusion (PIT Pirates MLB vs PIT Penguins NHL).

**Side matching (`pickBestPlatform`):** Identifies which Polymarket side corresponds to the team we want by:
1. Checking if team abbreviation appears in `s0Name` (first side name) → LONG
2. Checking if team abbreviation appears in `s1Name` (second side name) → SHORT
3. Checking slug position: index 2 = first team = LONG, index 3 = second team = SHORT
4. Only switches to Polymarket if price is at least 2c cheaper AND within 5c-90c range

**Team abbreviation mapping (`ABBR_MAP`):** ESPN and Kalshi use different abbreviations for the same teams. The `tickerHasTeam()` function checks both versions:
- CHW ↔ CWS (White Sox), AZ ↔ ARI (Diamondbacks), ATH ↔ OAK (Athletics)
- GS ↔ GSW (Warriors), WSH ↔ WAS (Washington), TB ↔ TBL (Lightning)
- NY ↔ NYK (Knicks), SA ↔ SAS (Spurs), NO ↔ NOP (Pelicans)
- MON ↔ MTL (Canadiens), LA ↔ LAK (Kings), NJ ↔ NJD (Devils)
- UTAH ↔ UTA (Jazz/Hockey)
- MAN ↔ MUN (Manchester United), WOL ↔ WLV (Wolverhampton), VAL ↔ VLL (Valladolid)

---

## Position Management

### Smart Exits (Three-Tier System)

The old system was a blind 30% stop-loss. The new system uses game-stage-aware, sport-specific, Claude-powered exit decisions.

**Game stage detection (`getGameContext`):** For every open position, the bot fetches ESPN scoreboard to determine:
- **Stage:** early/mid/late/finished (sport-specific boundaries)
  - MLB: innings 1-4 = early, 5-6 = mid, 7+ = late
  - NBA: Q1-Q2 = early, Q3 = mid, Q4 = late
  - NHL: P1 = early, P2 = mid, P3 = late
  - Soccer: 1st half = early, 2nd half = late
- **Live context:** Score, detail, win expectancy, situation (runners, outs, last play for MLB)

#### Tier 1: Rule-Based Auto-Exits (No Claude)

**Late-game profit-take:** Auto-sell at 97c+ in late game stage. Risking 97c to gain 3c is 32:1 against. Sells at `currentPrice - 2c` (wants good exit, not market order).

**Nuclear stop-loss:** Absolute floor by entry price tier. No Claude evaluation — just get out immediately. Sells at 1c (market order for instant exit).
- 70c+ entry: sell at -60% loss
- 50-70c entry: sell at -75% loss
- Under 50c entry: sell at -85% loss

#### Tier 2: Claude-Powered Sell/Hold Decisions

When a position hits the Claude evaluation threshold, Haiku is asked to sell or hold with full game context.

**Claude evaluation thresholds (`getExitThresholds`) — % drop from entry that triggers evaluation:**

| Entry Price | Early Game | Mid Game | Late Game |
|------------|-----------|---------|----------|
| 70c+ (expensive) | -15% | -12% | -10% |
| 50-70c (mid) | -25% | -20% | -15% |
| Under 50c (cheap) | -35% | -30% | -25% |

Claude's prompt includes:
- Current position: entry price, current price, % loss, dollar loss
- Live score and game detail from ESPN
- Game stage (EARLY/MID/LATE)
- Win expectancy if available
- Sport-specific comeback statistics:
  - NBA: "15-pt comebacks happen 13% in the 3-point era. 20-pt = 4%. 25+ = <1%."
  - MLB: "3-run comebacks happen 20% through 6 innings, 10% in 7th+. 5+ run deficit after 6th = <3%."
  - NHL: "1-goal = 30%. 2-goal = ~15%. 3-goal = ~5%. Down 3+ in 3rd = essentially over."
  - Soccer: "1-goal deficits equalize ~20%. 2-goal = ~5%. Down 2+ after 75' = essentially over."
- Decision framework: hold if WE > 25%, consider selling if WE 10-25% late, sell if WE < 10%
- Dollar amounts for sell vs hold scenarios

**Claude decides:** `{"action": "sell"}` or `{"action": "hold"}` with reasoning.

**Sport-specific evaluation cooldowns:** NBA gets evaluated every 8 minutes (fastest game pace), all others every 12 minutes.

#### Tier 3: Winners Stay

No Claude evaluation on winning positions. If we're winning, we hold. Let it settle at $1. Every Haiku call on a winner is wasted money.

### Sell Execution (`executeSell`)

Supports both full and partial exits:

- **Stop-loss/Claude-stop:** Sells at 1c (market order — get out immediately)
- **Profit-take:** Sells at current price - 2c (want a good exit price)
- **Full exit:** Status set to `sold-{reason}`, P&L calculated, trade closed
- **Partial exit:** Quantity and deploy cost reduced, trade stays open, partial profit tracked in `partialProfitTaken` field
- Telegram notification sent with: sell label, title, qty sold, entry → exit price, P&L, remaining contracts if partial

**Sell statuses:** `sold-stop-loss`, `sold-claude-stop`, `sold-profit-take`, `sold-scale-out`, `sold-claude-sell`, `sold-claude-scale`

### Scale-In Logic

The bot can add to existing positions if the price improves (`canScaleInto`):

- **Max entries per game:** 3 (`MAX_ENTRIES_PER_GAME`)
- **Max game exposure:** 15% of bankroll (`MAX_GAME_EXPOSURE_PCT`)
- **Condition:** Price must be at least 2c cheaper than last entry price
- If price is same or worse — nothing changed, don't add
- Tracked in `gameEntries` Map: `{count, lastPrice, totalDeployed}`

### Settlement Reconciliation (`checkSettlements`)

Runs every 5 minutes. Handles BOTH Kalshi and Polymarket settlements:

**Kalshi settlements:**
1. Reads all open Kalshi trades from `trades.jsonl`
2. Fetches `closed` and `settled` markets from Kalshi API (up to 100 per status)
3. Matches open trades to settled markets by ticker
4. Calculates P&L: if side matches result → win ($1/contract), else → loss ($0)
5. Updates trade: status → `settled`, exitPrice, realizedPnL, settledAt, result
6. Sends Telegram notification for each settlement (WIN or LOSS with P&L)

**Polymarket sports settlements:**
1. Reads all open Polymarket trades from `trades.jsonl`
2. For sports (MLB, NBA, NHL): fetches ESPN scoreboard, finds completed game, determines winner
3. Matches winner to trade's slug position (first team in slug = LONG side)
4. Calculates P&L and updates trade

**Polymarket UFC settlements:**
1. Fetches market status from Polymarket gateway API (`/v1/markets/{slug}`)
2. If market is closed/resolved, determines winning side by checking which side has price > 90c
3. Calculates P&L and updates trade

**After all settlements:**
- Rewrites `trades.jsonl` with updated records
- Updates consecutive loss tracking (`updateConsecutiveLosses`)
- Runs strategy performance check: if any strategy has 10+ settled trades AND win rate below 40%, sends a Telegram alert

### Stop-Loss Outcome Review (`reviewStopLossOutcomes`)

Runs every 5 minutes. Reviews stopped-out trades within the last 24 hours that haven't been reviewed yet (tracked by `stopReviewed` flag in JSONL — survives restarts).

For each stopped trade:
1. Fetches the Kalshi market to check the final result
2. Determines if the position would have won or lost if held
3. Calculates: actual loss from stop vs hypothetical P&L if held
4. **Sends Telegram:** "GOOD STOP — saved $X vs total loss" or "BAD STOP — would have WON $X if held"
5. Logs to `screens.jsonl` for analysis
6. Marks trade as reviewed (`stopReviewed = true` in JSONL)

### Position Sync

On every portfolio refresh (`refreshPortfolio`), the bot syncs JSONL entries with Kalshi's actual portfolio:
- If a Kalshi trade is marked `open` in JSONL but no longer appears in Kalshi positions (filtered by `event_exposure > 0`), it's auto-closed as `closed-manual`
- **Grace period:** Trades placed in the last 5 minutes are exempt (Kalshi API can be slow to reflect new orders)
- This catches: manual cashouts, settlements the bot missed, and other discrepancies

---

## Risk Management

### Position Sizing (Dynamic)

All limits scale automatically with bankroll every 60 seconds.

**Per-trade size:** `getBankroll() * MAX_TRADE_FRACTION` (10%) capped by `getTradeCapCeiling()`.

**Confidence scaling:** Higher confidence = bigger bet. Applied when edge > 5%:
- Edge 5% = 1x (base)
- Edge 10% = 1.5x
- Edge 15% = 2x
- Edge 20%+ = 2.5x (max)
Formula: `min(2.5, 1 + (edge - 0.05) * 10)`

**Inverse deployment curve** (`getMaxDeployment()`): Aggressive when small (need growth), conservative when big (protect gains).

| Bankroll | Max Deploy % | Max Positions | Per-Trade Ceiling |
|----------|-------------|--------------|-------------------|
| < $500 | 85% | 12 | $50 |
| $500-$2K | 75% | 15-18 | $150 |
| $2K-$5K | 60% | 18-25 | $500 |
| $5K-$20K | 40% | 25-35 | $500-$2,000 |
| $20K-$50K | 30% | 35 | $2,000 |
| $50K+ | 20% | 50 | $5,000 |

**How sizing works per trade:**
1. `getDynamicMaxTrade()` calculates: `min(bankroll * 10%, getTradeCapCeiling(), getAvailableCash())`
2. `getAvailableCash()` subtracts the 5% capital reserve from platform cash: `max(0, balance - bankroll * 0.05)`
3. `getPositionSize()` applies:
   - High-conviction tier override (20-30% of bankroll) if applicable
   - Confidence scaling multiplier (1x-2.5x based on edge)
   - Consecutive-loss reduction: 50% after 7 straight losses
4. Claude's recommended bet amount is capped by the above
5. Final quantity: `floor(safeBet / price)`, minimum 1

**Deployment calculation:** `getTotalDeployed()` uses Kalshi's `portfolio_value` (current market value) for Kalshi positions, not original cost. A $50 position now worth $10 counts as $10 deployed, not $50. Polymarket positions use original deploy cost from JSONL.

### Circuit Breakers

| Control | Threshold | Action |
|---------|-----------|--------|
| Daily loss | 25% of bankroll (min $10) | Halt all trading, Telegram alert, auto-resume at midnight ET |
| Consecutive losses | 7 in a row | Reduce position size to 50% |
| Consecutive losses | 10 in a row | Full halt, Telegram alert |
| Available cash | Under $3 | Skip entire trading cycle |
| Midnight ET | Auto | Reset dailyOpenBankroll, clear halt, update consecutiveLosses from JSONL |

**Meaningful position filter:** Only positions with cost >= $1.00 count toward the position limit. Dust positions (< $1) are ignored.

### Trade Gates (every trade passes ALL of these)

1. `canTrade()` — not halted, daily loss OK, meaningful positions under dynamic limit, deployment under cap
2. `canDeployMore(amount)` — total deployed + new trade within deployment limit
3. Confidence >= 65% (`MIN_CONFIDENCE`) for live, >= 70% (`PRE_GAME_MIN_CONF`) for pre-game
4. Dynamic margin gate (sport + price + situation aware)
5. Confidence hard-capped at baseline + 15% (live) or sport-specific cap (pre-game)
6. Price >= 5c and <= 90c (`MAX_PRICE`)
7. Cooldown: 5 minutes between trades on same game (bypassed for scale-in at better price)
8. No existing position on same game (cross-platform aware) unless scaling in
9. Scale-in rules: max 3 entries/game, max 15% bankroll/game, price must be 2c+ cheaper
10. Pre-game only: before 6pm ET, max 2/day, NBA/NHL only, no previously bet games
11. Pre-game only: reasoning validation (anti-confusion), sport confusion detection

### Cross-Platform Position Tracking

`openPositions` array includes BOTH:
- Kalshi positions from `/portfolio/positions` API (filtered by `event_exposure > 0` — only active positions)
- Polymarket positions from `trades.jsonl` (open status, matched by exchange field)

This ensures deployment caps, position limits, same-game checks, and sport exposure caps work across both platforms.

---

## Calibration Engine (`runCalibration`)

Runs daily at 6am ET (after overnight settlements). Requires 50+ settled trades (`CALIBRATION_MIN_TRADES`).

**What it does:**
1. Reads all settled trades from JSONL
2. Buckets trades by confidence range: 65-70%, 70-75%, 75-80%, 80-85%, 85-90%, 90%+
3. Calculates actual win rate per bucket (needs 3+ trades in a bucket for reporting)
4. Computes calibration error: `actualWinRate - midConfidence`
5. **Overconfidence detection:** If any bucket with midConfidence >= 75% has actual win rate < 60% with 5+ trades, flags as overconfident
6. Generates per-strategy breakdown: win rate and P&L per strategy
7. **Sends Telegram calibration report** with per-bucket results (icons: checkmark if calibrated within 5%, warning if overconfident, money bag if underconfident), strategy breakdown, and overconfidence alert if applicable
8. Logs to `screens.jsonl`

The dashboard's Analytics page displays the same calibration data as a scatter chart via the `/api/stats` endpoint.

---

## Dashboard (React Frontend)

The dashboard is a React SPA built with Vite, TypeScript, and Recharts, hosted on Vercel. It provides real-time monitoring of all bot activity.

### Global State (`ArborContext`)

Polls 4 API endpoints every 15 seconds using `Promise.allSettled` (graceful partial failures — shows data even if some endpoints fail):
- `/api/trades` — all trades (excludes `testing-void`, default Kalshi-only)
- `/api/positions` — open trades + today's `closed-manual` Kalshi trades (may still be active on Kalshi due to sync race)
- `/api/stats` — computed stats (see Data API section)
- `/api/snapshots` — daily snapshots for bankroll chart

Connection status indicator: green pulsing dot if any endpoint succeeds, red if all fail.

### Pages

#### Command Center (/)
- **Bankroll Hero:** Total bankroll with Kalshi cash + positions + Polymarket breakdown. Today and all-time P&L with color coding (green/red).
- **Daily Challenge:** Progress bar toward 5% daily bankroll target. Green when hit, accent at 50%+, amber below.
- **Projections:** Two sections:
  - "If every day is like today" — weekly/monthly/yearly P&L projections (only shown if todayPnL != 0)
  - "If every day is like our average" — daily avg P&L, weekly avg, days to $1K/$5K bankroll (only shown if positive average, accounts for biweekly $400 injection)
- **Stats Grid:** 6 cards — Today's trades (+ settled count), win rate (W/L), streak (fire animation at 3+ wins), open positions (+ deployed $), best trade, worst trade
- **Bankroll Chart:** Recharts AreaChart with gradient fill, dollar-formatted Y axis, date X axis. Only shown with 2+ snapshots.
- **Active Positions:** Top 12 open positions with: sport badge (MLB/NBA/NHL/MLS/POLY), title, side/price/qty/cost, confidence percentage. Truncated with ellipsis for long titles.
- **Recent Activity:** Last 10 trades (newest first) with status icons: open=target, settled-win=checkmark, settled-loss=X, sold=stop-sign, other=clipboard. Shows time, title, side@price, P&L.
- **Achievements:** Component showing earned (colored) and locked (greyed, 35% opacity) badges.
- **Confetti:** Triggers when `stats.wins` increases between polls. 40 pieces, 7 colors, 4-second animation.

#### Positions (/positions)
- Sport filter buttons (All + dynamically generated from data: MLB, NBA, NHL, MLS, EPL, UFC, Other)
- Total deployed dollar amount header
- Cards with: sport badge, exchange badge (KALSHI/POLYMARKET), title, side/price/qty/cost, potential profit (green), confidence (accent), edge, hold time (computed from timestamp), strategy
- Click to expand: shows Claude's full reasoning in italic
- Live score display in amber monospace if available

#### Trade History (/history)
- **Summary bar:** Trade count, settled count, W count (green), L count (red), win rate %, P&L (colored), avg P&L per trade
- **4 filter dropdowns:** Date (all dates from data), sport (MLB/NBA/NHL/Soccer/UFC/Other), result (Win/Loss/Open), strategy (all strategies from data). Clear filters button when any active.
- **Trade cards:** Date/time, sport badge, fire indicator for high-conviction trades, title (truncated), status badge (color-coded: open=indigo, settled=green, stop-loss=red, closed-manual=amber), P&L
- **Details line:** Side @ price x qty = cost → exit price | Conf: X% | Edge: X%
- Click to expand: Claude's reasoning, live score at entry, strategy, exchange, ticker

#### Analytics (/analytics)
- **Bankroll Growth:** AreaChart with CartesianGrid, gradient fill (#6366F1), date axis, dollar axis
- **Performance by Sport:** Side-by-side bar charts (win rate % with color coding: green >=55%, amber >=45%, red <45%) and (P&L $ with green/red). Plus summary table below.
- **Confidence Calibration:** ScatterChart with CartesianGrid, predicted % on X axis, actual win % on Y axis. Dots are green if actual >= predicted (underconfident = good), red if below (overconfident = bad). Bucket labels shown below chart.
- **Strategy Breakdown:** Donut PieChart (7 colors rotating) with legend table: strategy name, trade count, win rate %, P&L (colored)
- **Performance by Hour (ET):** BarChart with hour on X axis, P&L on Y axis, green/red per bar

#### Trade Review (/review)
- **Grade Summary:** A/B/C/D grade counts with colored badges (A=green, B=indigo, C=amber, D=red)
  - A = Great trade — right reasoning, outcome matched prediction
  - B = Solid process — good reasoning even if outcome was bad luck (or won despite weak reasoning)
  - C = Weak trade — reasoning had gaps, got lucky or predictably lost
  - D = Bad trade — should not have been taken, reasoning was flawed
- **Process vs Luck stats:** "Process wins" (B-grade losses = good reasoning, bad luck) and "Lucky wins" (C-grade wins = weak reasoning, got lucky)
- **How grading works:** Explainer box with grade descriptions and note that reviews activate at 50 settled trades
- **Settled trades list:** Win/loss icon, grade badge (if reviewed), title, sport/side/price/date, P&L. Original Claude reasoning in grey box. AI review text in grade-colored box (if available). "Pending AI review" note for unreviewed trades.

#### Live Feed (/live)
- **Real-time polling:** Fetches `/api/live-feed?limit=100` every 10 seconds (when not paused)
- **Controls:** LIVE (green) / PAUSED (amber) toggle, auto-scroll ON/OFF toggle
- **Tag filters:** all, live-edge, pre-game, broad-scan, portfolio, exit, pnl, sync, risk
- **Type filters:** all types, trade (target icon), analysis (brain), block (stop), win (checkmark), loss (X)
- **Color coding by type:** trade=green bg, win=green bg, loss=red bg, block=red bg, analysis=accent bg, portfolio=transparent, dryrun=amber bg, info=transparent
- **Display:** JetBrains Mono font, 11px, full viewport height minus header. Each line: timestamp (HH:MM:SS), [tag], colored message.
- **Smart filtering:** Portfolio lines hidden by default unless specifically filtered (too noisy)

#### Settings (/settings)
- **System Status:** Green pulsing dot + "Bot Online", total trades, settled (W/L), win rate, open positions
- **Trading Configuration:** Read-only InfoRow grid showing: min confidence (65%), max price (90c), max trade (10%), max positions (12), deployment cap (85%), daily loss limit (15%), capital reserve (5%), cooldown (5 min), poll interval (60s)
- **Dynamic Margins (Live):** Per-sport margins with score change adjustments
- **Dynamic Margins (Pre-Game):** Per-sport margins with price tier breakdowns
- **Sport Status:** Per-sport row with health dot (green >=55% win rate, amber >=45%, red <45%), trade count, win rate, P&L

### Design System

- **Dark theme:** `--bg-base: #0A0A0F`, `--bg-surface: #111118`, `--bg-elevated: #1A1A24`
- **Colors:** `--accent: #6366F1` (indigo), `--green: #22C55E`, `--red: #EF4444`, `--amber: #F59E0B`
- **Text:** `--text-primary: #F8F8FF`, `--text-secondary: #8B8B9E`, `--text-tertiary: #4B4B5E`
- **Typography:** Inter (body, 400/500/600/700), JetBrains Mono (numbers/data, tabular-nums)
- **Responsive:** Desktop = fixed 220px sidebar + main content. Mobile = full-width content + fixed 60px bottom tab bar with `env(safe-area-inset-bottom)` for notched phones. Breakpoint via `useIsMobile()` hook.
- **Animations:**
  - `pulse`: 2s ease-in-out infinite (live status dot)
  - `shimmer`: 1.5s infinite (skeleton loading — gradient slide)
  - `confetti-fall`: 3s ease-out forwards (win celebration — falls from top)
  - `fire-glow`: 1.5s ease-in-out infinite (3+ win streak — amber/red text shadow)
  - `badge-pop`: 0.4s ease-out (achievement unlock — scale 0→1.2→1)
- **Scrollbar:** 4px thin, tertiary color track

### Achievements System

14 badges unlocked based on real-time stats:

| Icon | Name | Condition |
|------|------|-----------|
| Target | First Blood | 1+ trades placed |
| Checkmark | Winner Winner | 1+ wins |
| Trophy | High Five | 5+ wins |
| Chart | Getting Serious | 10+ trades placed |
| Muscle | Quarter Century | 25+ trades placed |
| Abacus | Calibration Ready | 50+ trades settled |
| Fire | On Fire | 3+ consecutive wins (current streak) |
| Explosion | Unstoppable | 5+ consecutive wins (current streak) |
| Money | In The Green | All-time P&L > $0 |
| Rich | Big Day | Today P&L >= $50 |
| Chart Up | Half a Grand | Bankroll >= $500 |
| Party | Comma Club | Bankroll >= $1,000 |
| Globe | Diversified | Wins in 3+ different sports |
| Target | Sharp | 60%+ win rate with 10+ settled trades |

Earned badges: colored with accent background, full opacity. Locked badges: greyscale icon, 35% opacity, base background.

---

## Data API Server (`bot/api.mjs`)

Runs on port 3456 (configurable via `API_PORT`), serving bot data to the dashboard over HTTP.

### Endpoints

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/api/trades` | GET | All trades from JSONL. Excludes `testing-void` status. Default: Kalshi only (`?exchange=kalshi`), pass `?exchange=all` for both platforms. |
| `/api/positions` | GET | Open trades + today's `closed-manual` Kalshi trades (accounts for Kalshi sync race where manually cashed positions may still be active). Same exchange filter. |
| `/api/stats` | GET | Comprehensive computed stats object (see below) |
| `/api/snapshots` | GET | All daily snapshots from JSONL |
| `/api/screens` | GET | Last 100 screening decisions from JSONL |
| `/api/live-feed` | GET | Parsed tail of `ai-out.log`. `?limit=N` (default 50, max 200). Each line parsed into `{ts, tag, msg, type}` with type categorization for UI coloring. |

### Auth
Simple token auth: `?token=arbor-2026` or `Authorization: Bearer arbor-2026`. Returns 401 if wrong.

### Stats Object (`/api/stats` response)
```json
{
  "totalTrades": 45,
  "settledTrades": 30,
  "openTrades": 15,
  "wins": 18,
  "losses": 12,
  "winRate": 60,
  "totalPnL": 42.50,
  "todayTrades": 5,
  "todaySettled": 2,
  "todayPnL": 8.30,
  "bestTrade": { "title": "...", "pnl": 15.20, "ticker": "..." },
  "worstTrade": { "title": "...", "pnl": -12.50, "ticker": "..." },
  "streak": 3,
  "streakType": "win",
  "sportPerformance": [
    { "sport": "nba", "trades": 10, "wins": 6, "losses": 4, "winRate": 60, "pnl": 25.00 }
  ],
  "strategyPerformance": [
    { "strategy": "live-prediction", "trades": 20, "settled": 15, "wins": 9, "losses": 6, "winRate": 60, "pnl": 30.00 }
  ],
  "calibration": [
    { "label": "65-70%", "min": 0.65, "max": 0.70, "total": 8, "wins": 5, "actualWinRate": 63 }
  ],
  "latestSnapshot": { ... },
  "liveBankroll": 295.50,
  "openDeployed": 125.00,
  "serverTime": "2026-04-13T20:00:00.000Z"
}
```

**Live bankroll estimate:** `lastSnapshot.bankroll + pnlSettledSinceSnapshot`. Only counts P&L from trades settled AFTER the snapshot timestamp.

### Vercel Proxy (`api/proxy.js`)
Bridges HTTPS (Vercel) to HTTP (VPS) for the production dashboard. Forwards all query params (except `path`) to the VPS. Adds auth token. 10-second fetch timeout. CORS headers. Cache: `s-maxage=10, stale-while-revalidate=5`.

---

## Configuration

All constants at the top of `ai-edge.mjs`:

```javascript
// Prediction thresholds
MIN_CONFIDENCE = 0.65            // Live: Claude must be >= 65% confident
PRE_GAME_MIN_CONF = 0.70        // Pre-game: higher bar (market has settled)
CONFIDENCE_MARGIN = 0.03         // Legacy flat margin — only for draw bets + fallback
MAX_PRICE = 0.90                 // Won't buy above 90 cents

// Sizing
MAX_TRADE_FRACTION = 0.10        // 10% of bankroll per trade (base)
MAX_ENTRIES_PER_GAME = 3         // Max buys into same game (scale-in)
MAX_GAME_EXPOSURE_PCT = 0.15     // Max 15% of bankroll on one game
LINE_MOVE_THRESHOLD = 0.05       // 5c+ price swing = line movement detected

// Timing
POLL_INTERVAL_MS = 60,000        // Main loop: every 60 seconds
PREGAME_SCAN_INTERVAL = 900,000  // Pre-game: every 15 minutes
MAX_PREGAME_PER_DAY = 2          // Max pre-game trades per day
MAX_PREGAME_PER_CYCLE = 2        // Max pre-game trades per scan
BROAD_SCAN_INTERVAL = 1,800,000  // Broad scan: every 30 minutes
UFC_SCAN_INTERVAL = 1,800,000    // UFC: every 30 minutes
COOLDOWN_MS = 300,000            // 5 min between same-game trades
MAX_SONNET_PER_CYCLE = 6         // Max Sonnet calls per live-edge cycle
POLY_CACHE_MS = 180,000          // Polymarket moneyline cache: 3 min

// Risk
DAILY_LOSS_PCT = 0.25            // Halt at 25% daily loss
CAPITAL_RESERVE = 0.05           // Keep 5% untouched
MAX_CONSECUTIVE_LOSSES = 7       // Half size after 7 straight losses (halt at 10)
SPORT_EXPOSURE_PCT = 0.25        // Max 25% bankroll per sport (min $15)
MAX_DAYS_OUT = 1                 // Same-day markets only (soccer 3 days)
CALIBRATION_MIN_TRADES = 50      // Need 50+ settled trades before calibrating

// AI Models
CLAUDE_SCREENER = 'claude-haiku-4-5-20251001'
CLAUDE_DECIDER = 'claude-sonnet-4-6'

// Modes
DRY_RUN = false                  // --dry-run flag: full pipeline, no real orders
KALSHI_ONLY = true               // Default: skip Polymarket trading
```

---

## Data Collection & Logging

### trades.jsonl

Every trade is recorded as a single JSON line with full context:

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
  "bettingOn": "Oakland Athletics",
  "status": "settled",
  "exitPrice": 0.0,
  "realizedPnL": -11.78,
  "settledAt": "2026-04-12T22:30:00.000Z",
  "result": "no",
  "stopReviewed": true,
  "partialProfitTaken": 0
}
```

**Trade statuses:** `open` → `settled`, `sold-stop-loss`, `sold-claude-stop`, `sold-claude-sell`, `sold-claude-scale`, `sold-profit-take`, `sold-scale-out`, `closed-manual`, `testing-void`

**Strategy values:** `live-prediction`, `pre-game-prediction`, `ufc-prediction`, `claude-prediction` (broad scan non-sports), `resolution-arb`, `draw-bet`, `high-conviction`

### screens.jsonl

Every screening, decision, exit, calibration, and stop-loss review logged with timestamp and stage:
- `stage: 'haiku'` — broad scan/UFC screening results
- `stage: 'sonnet'` or `stage: 'live-edge'` or `stage: 'pre-game'` or `stage: 'pre-game-sonnet'` — trade decisions
- `stage: 'exit'` — sell executions with pricing
- `stage: 'stop-review'` — stop-loss outcome reviews
- `stage: 'calibration'` — daily calibration results

### daily-snapshots.jsonl

Snapshots saved at 8pm ET and midnight ET via `sendDailyReport()`:

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
    "live-prediction": { "trades": 2, "settled": 2, "wins": 0, "losses": 2, "pnl": -36.14 }
  }
}
```

---

## Telegram Notifications

Every significant event produces a Telegram notification (HTML parse mode):

| Event | Icon | Key Info |
|-------|------|---------|
| Live prediction trade | Target | Team, score, status, price x qty = cost, confidence vs price, potential profit, reasoning |
| Pre-game trade | Target | Game title, betting on team, price x qty = cost, confidence, potential profit, reasoning |
| High-conviction trade | Fire | Same as live + "HIGH CONVICTION — [sport reason]" |
| Draw bet | Soccer ball | Teams, score, minute, draw probability vs price, potential profit |
| Underdog bet | Dog | Same as live + "UNDERDOG" label |
| Resolution arb | Money | Title, result, price x qty, guaranteed profit |
| Settlement (win) | Checkmark | Title, bought side @ price x qty, result, P&L |
| Settlement (loss) | X | Same as win with negative P&L |
| Stop-loss sell | Stop sign | Title, qty sold, entry → exit price, P&L |
| Claude smart exit | Brain | Title, qty sold, entry → exit price, P&L, reasoning |
| Profit lock | Money | Title, qty sold, entry → exit price, P&L |
| Stop-loss review | Angry/Check | Title, entry → stop price, game result, "BAD STOP"/"GOOD STOP" verdict, $ comparison |
| Daily report (8pm + midnight) | Chart | Portfolio breakdown, today's trades + P&L, all-time stats, strategy breakdown, open positions, consecutive losses, API spend |
| Health check (8am) | Chart | pm2 process statuses, Kalshi balance, open positions, error count, P&L summary |
| Strategy alert | Warning | Strategy name, win rate, P&L, "Consider disabling" |
| Trading halt | Stop | Reason (daily loss / 10 consecutive losses), resume info |
| Bot start | Brain | All risk control settings, config summary, full balance breakdown |
| Bot stop | Stop | Graceful shutdown notification |
| Calibration report | Chart | Per-bucket predicted vs actual %, strategy breakdown, overconfidence alert |

---

## API Integrations

### Kalshi (Primary exchange)
- **Auth:** RSA-PSS signature (`PKCS1_PSS_PADDING`, salt length 32). Timestamp + method + full path signed with private key.
- **Base URL:** `https://api.elections.kalshi.com/trade-api/v2`
- **Endpoints used:**
  - `GET /portfolio/balance` — `balance` (cents) + `portfolio_value` (cents)
  - `GET /portfolio/positions` — open positions (filtered by `event_exposure_dollars > 0`)
  - `POST /portfolio/orders` — place buy/sell orders (count, ticker, action, side, yes_price in cents)
  - `GET /markets?series_ticker=X&status=Y&limit=N` — batch fetch market prices
  - `GET /markets/{ticker}` — individual market (position management, settlement check)
- **Fee model:** Parabolic: `ceil(0.07 * contracts * price * (1-price) * 100) / 100`. Max at 50c (1.75c/contract), zero at 0 or $1.

### Polymarket US (Secondary exchange, disabled by default)
- **Auth:** Ed25519 signature via `@noble/ed25519` library. Signature = `timestamp + method + path` (NO body for POST — critical fix, including body causes 401).
- **Base URL:** `https://api.polymarket.us`
- **Gateway URL:** `https://gateway.polymarket.us`
- **Endpoints used:**
  - `GET /v1/account/balances` — cash balance
  - `POST /v1/orders` — place IOC limit orders (price set 2c above market to ensure fill)
  - `GET /v1/markets?limit=200&offset=N&active=true&closed=false` (gateway) — paginated market listings
  - `GET /v1/markets/{slug}` (gateway) — individual market for UFC settlement checks
- **Order format:** All orders are `TIME_IN_FORCE_IMMEDIATE_OR_CANCEL` limit orders. If not filled immediately, order cancels — no hanging orders.
- **Signing note:** `ed.etc.sha512Sync` set once at init. Handles frozen objects via `Object.defineProperty` fallback. Falls back to `signAsync` if fully sealed.
- **Fees:** Zero taker fees (as of codebase date).

### ESPN (Data source — no auth, no API key)
- **Scoreboards:** `site.api.espn.com/apis/site/v2/sports/{sport}/scoreboard`
- **News:** `site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?limit=3`
- **Six league paths:** `baseball/mlb`, `basketball/nba`, `hockey/nhl`, `soccer/usa.1`, `soccer/eng.1`, `soccer/esp.1`
- **All requests:** 5-second timeout, User-Agent: `arbor-ai/1`
- **Data extracted per game:**

| Data Point | ESPN Path | Used In |
|-----------|--------|---------|
| Team records (overall) | `competitor.records[0].summary` | All prompts |
| Home/away records | `competitor.records[type=home/road].summary` | Live + pre-game |
| Current pitcher stats | `competition.situation.pitcher.summary` | Live MLB |
| Starting pitcher ERA | `competitor.probables[].statistics[ERA]` | Live + pre-game MLB |
| Starting pitcher W-L | `competitor.probables[].statistics[W/L]` | Live + pre-game MLB |
| Team batting average | `competitor.statistics[AVG]` | Live MLB |
| NBA FG%, 3P% | `competitor.statistics[FG%/3P%]` | Live NBA |
| NBA REB, AST, FTA | `competitor.statistics[REB/AST/FTA]` | Live NBA |
| Leading scorers | `competitor.leaders[points].leaders[0]` | Live NBA |
| Inning/quarter scores | `competitor.linescores[].displayValue` | Live prompt |
| Runners on base | `competition.situation.onFirst/Second/Third` | Live MLB |
| Outs count | `competition.situation.outs` | Live MLB |
| Current batter | `competition.situation.batter.athlete.displayName` | Live MLB |
| Last play text | `competition.situation.lastPlay.text` | Live context |
| Game status | `competition.status.type.shortDetail` | All prompts |
| Game state | `competition.status.type.state` | in/post/pre filtering |
| Period/quarter | `competition.status.period` | Stage detection |
| Winner flag | `competitor.winner` | Settlement, arb verification |

### CoinGecko (Crypto prices — no auth)
- **Endpoint:** `api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd`
- **Used in:** Broad scan prompt context for crypto market analysis

### Anthropic (AI decisions)
- **Models:** Haiku 4.5 (screening, sell/hold eval), Sonnet 4.6 (all trade decisions)
- **Web search tool:** `web_search_20250305` (max 1-5 uses per call)
- **API version:** `2023-06-01`
- **Cost tracking:** `stats.apiSpendCents` accumulates estimated cost. Haiku = $0.002, Sonnet = $0.03 + $0.01/search.
- **Estimated cost:** ~$5-8/day at current usage

### Telegram (Notifications)
- **Bot API:** `api.telegram.org/bot{token}/sendMessage` with HTML parse_mode
- **Error handling:** All Telegram sends are fire-and-forget (`.catch(() => {})`) — notification failures never block trading

---

## Infrastructure

### VPS
- **Provider:** Hetzner
- **IP:** 87.99.155.128
- **Cost:** $7.59/month
- **OS:** Linux
- **Access:** SSH key auth (`~/.ssh/hetzner_arbor`)
- **Deployment:** `bot/deploy-vps.sh` (rsync files + pm2 restart)

### Process Management (pm2)
- `arbor-ai`: main bot, auto-restart on crash, max 200MB memory, max 50 restarts
- `arbor-health`: cron at `0 12 * * *` (12:00 UTC = 8am ET), runs once then stops
- `arbor-arb`: legacy arb bot (stopped, same config as arbor-ai)
- All: 10-second restart delay, dated log format, separate error/output log files

### Frontend Hosting
- **Vercel:** React dashboard auto-deployed from git
- **Proxy:** Serverless function at `/api/proxy` bridges HTTPS to VPS HTTP
- **Cache:** `s-maxage=10, stale-while-revalidate=5`

### Environment Variables

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
  - Win: $0.45 profit per contract (minus ~1.7c Kalshi fee at 55c)
  - Lose: $0.55 loss per contract
  - Per 10 trades: 6 wins ($2.70) - 4 losses ($2.20) = +$0.50 net
  - At 5 trades/day, $20 avg: ~$10/day = $300/month at $250 bankroll
- At $1,000 bankroll: ~$40/day = $1,200/month
- At $5,000 bankroll: ~$100/day = $3,000/month

### Scaling (inverse risk curve)
As bankroll grows, deployment percentage decreases:
- $200: 85% deployed (aggressive — need growth)
- $2,000: 75% deployed
- $5,000: 60% deployed (moderate)
- $20,000: 40% deployed
- $50,000: 20% deployed (conservative — protect gains)

---

## Known Limitations

1. **Early validation phase.** Need 50+ settled trades to activate the calibration engine and trade review system. Until then, confidence thresholds and margins are based on design assumptions, not empirical data.

2. **No Polymarket sell capability.** Can buy on Poly but can't sell/exit positions early. All position management (stop-loss, Claude exits, profit-taking) is Kalshi-only. Poly positions ride to settlement.

3. **Kalshi settlement delay.** Sports markets take hours to settle after games end. Capital is locked during this period. Resolution arbs partially mitigate by buying winning sides before formal settlement.

4. **Claude cost.** At ~$5-8/day, API costs eat into small-bankroll profits. At $250 bankroll with $10/day target profit, API costs are 50-80% of gross. Becomes negligible at $1,000+ bankroll.

5. **Single point of failure.** One bot on one VPS. If VPS goes down, no trading. pm2 auto-restarts on crash, but hardware failure = downtime until manual intervention.

6. **No backtesting.** Predictions are forward-only. Can't validate strategy against historical data without building a separate backtesting framework.

7. **ESPN dependency.** All live game data comes from ESPN's public API (no auth, no SLA). If ESPN changes endpoints, rate-limits, or goes down, live-edge, position management, and settlement reconciliation are affected.

8. **Soccer draw complexity.** Draw bets use historical baselines without Claude analysis. The baselines are averages across all matchups — a top team vs bottom team has different draw rates than a mid-table clash, but the same minute-based baseline is applied.

9. **Pre-game limited to NBA/NHL.** MLB and soccer are blocked due to sport-specific confidence caps being too low to pass the 70% minimum. This means no pre-game bets during MLB-only afternoons.

10. **Polymarket defaults off.** `KALSHI_ONLY=true` means cross-platform price advantage is not active by default. Must be explicitly enabled by setting to `false`.

11. **Resolution arbs: no ESPN verification for soccer.** The ESPN verification for resolution arbs only covers MLB, NBA, NFL, NHL. Soccer arbs rely solely on Kalshi's reported result.

12. **Broad scan sports blocked.** Sports games are blocked from broad-scan trade execution because YES/NO side mapping is unreliable without proper ticker parsing. Only pre-game and live-edge handle sports with correct team-to-side mapping.

---

## Supabase Edge Functions (Legacy/Auxiliary)

The `supabase/functions/` directory contains edge functions from an earlier architecture. These are NOT part of the active trading pipeline (which runs entirely in `bot/ai-edge.mjs`):

| Function | Purpose |
|----------|---------|
| `scanner/` | Server-side scan cycle with Claude polarity verification, orderbook walking, writes to Supabase DB |
| `analytics/` | Analytics computation |
| `fastpoll/` | Fast polling |
| `kalshiws/` | Kalshi WebSocket handler |
| `notify/` | Notification delivery |
| `resolve/` | Market resolution verification |
| `trade/` | Trade execution |

The scanner contains sophisticated logic (polarity-correct token mapping, orderbook walking via `walkOrderbook()`, fuzzy market title matching via `fuzzyScore()`) preserved in `src/lib/calculator.ts` and `src/lib/matcher.ts` for reference but not imported by the active frontend or bot.

17 Supabase migration files (`supabase/migrations/001-017`) define the database schema for this legacy system, covering: markets, scan results, positions, known game markets, spread events, and settlement tracking.
