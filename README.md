# Arbor

Automated prediction market arbitrage engine. Scans Kalshi and Polymarket US for cross-platform price discrepancies, verifies polarity via Claude AI, calculates spreads net of fees, alerts via Telegram with one-tap execution, and tracks positions through settlement. Built for a US-based trader with ~$200 in capital across both platforms.

## Architecture

```
                    ┌─────────────┐
                    │  Telegram   │
                    │   Bot API   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌────────┐  ┌────────┐
         │ notify │  │ trade  │  │resolve │
         │(webhook│  │(webhook│  │(cron   │
         │on scan)│  │on tap) │  │ 5min)  │
         └────┬───┘  └────┬───┘  └────┬───┘
              │           │           │
              ▼           ▼           ▼
         ┌────────────────────────────────┐
         │         Supabase DB            │
         │  positions · spread_events     │
         │  capital_ledger · scan_results │
         │  known_game_markets            │
         └────────────────────────────────┘
              ▲           ▲
              │           │
         ┌────┴───┐  ┌───┴─────┐
         │scanner │  │fastpoll │
         │(cron   │  │(cron    │
         │ 5min)  │  │ 60sec)  │
         └────────┘  └─────────┘
```

**Edge Functions (Supabase/Deno):**
- `scanner` — Full market scan. Fetches Kalshi (5700+) and Polymarket US (1000+) markets, fuzzy-matches pairs, verifies polarity via Claude, fetches orderbooks, calculates net spreads.
- `fastpoll` — Fast game-winner scanner. Targets sports moneyline markets only, runs every 60s, skips Claude (deterministic polarity).
- `notify` — DB webhook on `scan_results` INSERT. Filters for >3% net spread within 2 days, dedup-checks against `spread_events`, sends Telegram alert with Kelly-sized position.
- `trade` — Telegram webhook. Handles Execute/Skip button taps, places dual-leg orders (Kalshi REST + Polymarket US Ed25519), tracks positions.
- `resolve` — Resolution arb monitor + settlement tracker. Checks for mispriced winning sides after game ends, tracks live ESPN scores, settles open positions.
- `analytics` — Returns spread persistence statistics as JSON.

## Setup

### 1. Secrets

```bash
supabase secrets set \
  KALSHI_API_KEY_ID=<key-id> \
  KALSHI_PRIVATE_KEY="$(cat key.pem)" \
  POLY_US_KEY_ID=<polymarket-us-key-id> \
  POLY_US_SECRET_KEY='<base64-ed25519-secret>' \
  POLY_FUNDER_ADDRESS=<0x-wallet-address> \
  ANTHROPIC_API_KEY=<claude-api-key> \
  TELEGRAM_BOT_TOKEN=<bot-token> \
  TELEGRAM_CHAT_ID=<chat-id> \
  TRADE_DRY_RUN=true
```

### 2. Deploy

```bash
supabase db push
supabase functions deploy scanner --no-verify-jwt
supabase functions deploy fastpoll --no-verify-jwt
supabase functions deploy notify --no-verify-jwt
supabase functions deploy trade --no-verify-jwt
supabase functions deploy resolve --no-verify-jwt
supabase functions deploy analytics --no-verify-jwt
```

### 3. DB Webhook

Dashboard > Database > Webhooks > Create:
- Table: `scan_results`, Event: INSERT
- URL: `<SUPABASE_URL>/functions/v1/notify`
- Auth header: `Bearer <SERVICE_ROLE_KEY>`

### 4. Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d '{"url":"<SUPABASE_URL>/functions/v1/trade"}'
```

## How Arb Detection Works

1. **Fetch:** Scanner pulls ~5700 Kalshi markets and ~1000 Polymarket US markets.
2. **Match:** Fuzzy token-overlap matching + dedicated sports join pass using team codes from ticker parsing.
3. **Verify:** Every pair goes through Claude Sonnet 4.6 for polarity verification. Returns SAFE/CAUTION/SKIP.
4. **Price:** Batch Kalshi orderbooks (up to 100 tickers/call), individual Polymarket CLOB orderbooks. Walk both orientations.
5. **Filter:** Net spread > 0.5%, 2-day lockup max for alerts, recurrence filter, per-category APY floors.

## Execution Flow

1. Notify sends Telegram alert with Kelly-sized position
2. User taps Execute
3. Trade function fetches live balances from both platforms
4. Checks sufficient balance for each leg
5. Places both orders simultaneously
6. Records position with fill prices
7. Settlement tracker checks if markets resolved (every 5 min)
8. When settled: calculates P&L, updates capital, sends notification

## Key Parameters

| Parameter | Value | Controls |
|---|---|---|
| `TRADE_DRY_RUN` | `true` | No real orders until unset |
| `MAX_DAYS_LOCKUP` | 2 | Only short-dated markets alert |
| `AUTO_EXECUTE_SPREAD` | 5% | Auto-execute without tap (SAFE + same-day) |
| `QUARTER_KELLY` | 0.25 | Fraction of Kelly to deploy |
| `MAX_CAPITAL_FRACTION` | 40% | Max per trade |

## Monitoring

- **Telegram `/stats`** — spread analytics
- **Analytics page** — capital, trades, spread intelligence, health
- **Positions page** — open/pending/settled positions

## Known Limitations

- WebSocket listener non-functional (Deno runtime limitation)
- PredictIt integration returns 0 matches (no inventory overlap)
- Platform stubs (CryptoCom, FanDuel, Fanatics, OG) — APIs not accessible
- Polymarket US order placement untested with real money
