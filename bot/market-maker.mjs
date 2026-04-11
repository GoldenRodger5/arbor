/**
 * Arbor Market Maker Bot
 *
 * Provides liquidity on Kalshi by placing resting limit orders on both sides
 * of sports game-winner markets. Earns the bid-ask spread on every round-trip.
 *
 * Key advantages:
 *   - Maker orders are FEE-FREE on Kalshi (resting orders exempt)
 *   - Volume Incentive Program: $0.005 cashback per contract (through Sep 2026)
 *   - Both sides of a binary market = hedged position
 *   - Profit = spread earned per round trip (typically 2-4¢)
 *
 * Strategy:
 *   1. Find markets with wide bid-ask spreads (>4¢ gap)
 *   2. Place buy-YES at best_bid + 1¢ and buy-NO at best_no_bid + 1¢
 *   3. When one side fills, we have a position. When the other fills, we profit.
 *   4. If inventory builds up on one side, widen that side's quote.
 *   5. Cancel and re-quote every 30 seconds to track market movement.
 *
 * Risk management:
 *   - Max $50 per market (limits exposure to any single game)
 *   - Max 5 concurrent markets
 *   - Cancel all orders if game starts within 30 minutes
 *   - Cancel all on disconnect/shutdown
 *
 * Run: node market-maker.mjs
 */

import { readFileSync } from 'fs';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants } from 'crypto';
import 'dotenv/config';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_API_KEY = process.env.KALSHI_API_KEY_ID ?? '';
const KALSHI_REST = 'https://api.elections.kalshi.com/trade-api/v2';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID ?? '';

// Strategy params
const MIN_SPREAD_CENTS = 4;     // Only make markets with >= 4¢ bid-ask spread
const QUOTE_OFFSET_CENTS = 1;   // Place orders 1¢ inside the spread
const MAX_PER_MARKET_USD = 50;  // Max exposure per market
const MAX_CONCURRENT = 5;       // Max simultaneous markets
const REQUOTE_INTERVAL_MS = 30_000; // Re-quote every 30 seconds
const MIN_GAME_MINUTES = 30;    // Cancel if game starts within 30 min

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

let kalshiPrivateKey = null;
try {
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH ?? './kalshi-private-key.pem';
  kalshiPrivateKey = createPrivateKey({ key: readFileSync(keyPath, 'utf-8'), format: 'pem' });
} catch {
  const inline = process.env.KALSHI_PRIVATE_KEY ?? '';
  if (inline) kalshiPrivateKey = createPrivateKey({ key: inline, format: 'pem' });
}

function kalshiHeaders(method, path) {
  const ts = String(Date.now());
  const fullPath = path.startsWith('/trade-api/v2') ? path : `/trade-api/v2${path}`;
  const sig = cryptoSign('sha256', Buffer.from(`${ts}${method}${fullPath}`), {
    key: kalshiPrivateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return {
    'KALSHI-ACCESS-KEY': KALSHI_API_KEY,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': sig.toString('base64'),
    'Content-Type': 'application/json',
  };
}

async function kalshiGet(path) {
  const res = await fetch(`${KALSHI_REST}${path}`, { headers: kalshiHeaders('GET', path) });
  if (!res.ok) throw new Error(`Kalshi GET ${path}: ${res.status}`);
  return res.json();
}

async function kalshiPost(path, body) {
  const res = await fetch(`${KALSHI_REST}${path}`, {
    method: 'POST',
    headers: kalshiHeaders('POST', path),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function kalshiDelete(path) {
  const res = await fetch(`${KALSHI_REST}${path}`, {
    method: 'DELETE',
    headers: kalshiHeaders('DELETE', path),
  });
  return { ok: res.ok, status: res.status };
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram
// ─────────────────────────────────────────────────────────────────────────────

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

// Live balance — refreshed before each requote cycle
let kalshiBalanceDollars = 0;

// Active quotes: ticker → { yesOrderId, noOrderId, yesFilled, noFilled, ... }
const activeQuotes = new Map();
let totalProfit = 0;
let totalFills = 0;
let stats = { quotesPlaced: 0, fillsYes: 0, fillsNo: 0, roundTrips: 0, cancelled: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// Market Discovery: find wide-spread markets
// ─────────────────────────────────────────────────────────────────────────────

async function findWideSpreadMarkets() {
  const series = ['KXMLBGAME', 'KXNBAGAME', 'KXNHLGAME'];
  const candidates = [];
  const baseSeen = new Set();

  for (const s of series) {
    try {
      const params = new URLSearchParams({ series_ticker: s, status: 'open', limit: '200' });
      const data = await kalshiGet(`/markets?${params}`);
      for (const m of data.markets ?? []) {
        if (!m.ticker) continue;
        // Dedup per-team markets
        const lastH = m.ticker.lastIndexOf('-');
        if (lastH > 0) {
          const base = m.ticker.slice(0, lastH);
          if (baseSeen.has(base)) continue;
          baseSeen.add(base);
        }

        const yesAsk = m.yes_ask_dollars != null ? parseFloat(m.yes_ask_dollars) : null;
        const noAsk = m.no_ask_dollars != null ? parseFloat(m.no_ask_dollars) : null;
        const yesBid = m.yes_bid_dollars != null ? parseFloat(m.yes_bid_dollars) : null;
        const noBid = m.no_bid_dollars != null ? parseFloat(m.no_bid_dollars) : null;
        if (!yesAsk || !noAsk || !yesBid || !noBid) continue;

        // Spread = ask - bid (on YES side). Also check NO side.
        const yesSpread = Math.round((yesAsk - yesBid) * 100); // in cents
        const noSpread = Math.round((noAsk - noBid) * 100);
        const bestSpread = Math.max(yesSpread, noSpread);

        if (bestSpread >= MIN_SPREAD_CENTS) {
          candidates.push({
            ticker: m.ticker,
            title: m.title ?? '',
            yesAsk, noAsk, yesBid, noBid,
            yesSpread, noSpread,
            closeTime: m.close_time ?? m.expected_expiration_time ?? '',
            volume: m.volume ?? 0,
          });
        }
      }
    } catch (e) {
      console.error(`[mm] ${s} fetch failed:`, e.message);
    }
  }

  // Sort by spread (widest = most profit potential), then volume (more fills)
  candidates.sort((a, b) => {
    const spreadDiff = Math.max(b.yesSpread, b.noSpread) - Math.max(a.yesSpread, a.noSpread);
    if (spreadDiff !== 0) return spreadDiff;
    return b.volume - a.volume;
  });

  console.log(`[mm] Found ${candidates.length} markets with spread >= ${MIN_SPREAD_CENTS}¢`);
  for (const c of candidates.slice(0, 5)) {
    console.log(`  ${c.ticker}: YES ${c.yesBid}/${c.yesAsk} (${c.yesSpread}¢) NO ${c.noBid}/${c.noAsk} (${c.noSpread}¢) vol=${c.volume}`);
  }

  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quoting: place orders on both sides
// ─────────────────────────────────────────────────────────────────────────────

async function placeQuotes(market) {
  const { ticker, yesBid, yesAsk, noBid, noAsk } = market;

  // Calculate our quote prices: 1¢ inside the spread on each side
  const ourYesBidCents = Math.round(yesBid * 100) + QUOTE_OFFSET_CENTS;  // buy YES slightly higher
  const ourNoBidCents = Math.round(noBid * 100) + QUOTE_OFFSET_CENTS;    // buy NO slightly higher

  // Don't cross the spread
  if (ourYesBidCents >= Math.round(yesAsk * 100)) return null;
  if (ourNoBidCents >= Math.round(noAsk * 100)) return null;

  // Size: max contracts we can afford per side
  const yesPrice = ourYesBidCents / 100;
  const noPrice = ourNoBidCents / 100;
  // Dynamic sizing: use 90% of balance / number of concurrent markets
  const perMarketBudget = kalshiBalanceDollars > 0
    ? Math.min(MAX_PER_MARKET_USD, (kalshiBalanceDollars * 0.9) / MAX_CONCURRENT)
    : MAX_PER_MARKET_USD;
  const maxQtyYes = Math.floor(perMarketBudget / yesPrice);
  const maxQtyNo = Math.floor(perMarketBudget / noPrice);
  const qty = Math.min(maxQtyYes, maxQtyNo, 100);

  if (qty < 1) return null;

  // Place YES buy (resting limit order — maker, fee-free)
  // Kalshi defaults to GTC limit orders when no type/tif specified
  const yesResult = await kalshiPost('/portfolio/orders', {
    ticker,
    action: 'buy',
    side: 'yes',
    count: qty,
    yes_price: ourYesBidCents,
  });

  // Place NO buy (resting limit order — maker, fee-free)
  const noResult = await kalshiPost('/portfolio/orders', {
    ticker,
    action: 'buy',
    side: 'no',
    count: qty,
    yes_price: 100 - ourNoBidCents, // Kalshi takes yes_price even for NO orders
  });

  if (!yesResult.ok && !noResult.ok) {
    console.log(`[mm] Failed to place quotes on ${ticker}: YES=${yesResult.status} NO=${noResult.status}`);
    return null;
  }

  const quote = {
    ticker,
    title: market.title,
    qty,
    yesBidCents: ourYesBidCents,
    noBidCents: ourNoBidCents,
    yesOrderId: yesResult.data?.order?.order_id ?? null,
    noOrderId: noResult.data?.order?.order_id ?? null,
    yesFilled: 0,
    noFilled: 0,
    placedAt: Date.now(),
    spreadCents: (yesAsk - yesBid + noAsk - noBid) * 50, // approximate spread earned if both fill
  };

  stats.quotesPlaced++;
  console.log(`[mm] Quoted ${ticker}: BUY YES @${ourYesBidCents}¢ × ${qty} | BUY NO @${ourNoBidCents}¢ × ${qty} | spread ~${(ourYesBidCents + ourNoBidCents <= 100 ? 100 - ourYesBidCents - ourNoBidCents : 0)}¢`);

  return quote;
}

// ─────────────────────────────────────────────────────────────────────────────
// Order Management: check fills, cancel, re-quote
// ─────────────────────────────────────────────────────────────────────────────

async function checkFills() {
  for (const [ticker, quote] of activeQuotes) {
    let changed = false;

    // Check YES order
    if (quote.yesOrderId) {
      try {
        const data = await kalshiGet(`/portfolio/orders/${quote.yesOrderId}`);
        const order = data.order ?? data;
        const filled = order.quantity_filled ?? order.filled ?? 0;
        if (filled > quote.yesFilled) {
          const newFills = filled - quote.yesFilled;
          quote.yesFilled = filled;
          stats.fillsYes += newFills;
          totalFills += newFills;
          changed = true;
          console.log(`[mm] FILL YES ${ticker} +${newFills} (total YES: ${filled}/${quote.qty})`);
          await tg(`📥 <b>MM FILL YES</b> ${quote.title}\n+${newFills} @ ${quote.yesBidCents}¢ (${filled}/${quote.qty})`);
        }
        // If fully filled, mark order as done
        if (order.status === 'filled' || order.status === 'cancelled') {
          quote.yesOrderId = null;
        }
      } catch { /* ignore check errors */ }
    }

    // Check NO order
    if (quote.noOrderId) {
      try {
        const data = await kalshiGet(`/portfolio/orders/${quote.noOrderId}`);
        const order = data.order ?? data;
        const filled = order.quantity_filled ?? order.filled ?? 0;
        if (filled > quote.noFilled) {
          const newFills = filled - quote.noFilled;
          quote.noFilled = filled;
          stats.fillsNo += newFills;
          totalFills += newFills;
          changed = true;
          console.log(`[mm] FILL NO  ${ticker} +${newFills} (total NO: ${filled}/${quote.qty})`);
          await tg(`📥 <b>MM FILL NO</b> ${quote.title}\n+${newFills} @ ${quote.noBidCents}¢ (${filled}/${quote.qty})`);
        }
        if (order.status === 'filled' || order.status === 'cancelled') {
          quote.noOrderId = null;
        }
      } catch { /* ignore */ }
    }

    // Check for round-trip completion (both sides filled)
    const totalRoundTrips = Math.min(quote.yesFilled, quote.noFilled);
    const newRoundTrips = totalRoundTrips - (quote.lastReportedRoundTrips ?? 0);
    if (newRoundTrips > 0 && changed) {
      quote.lastReportedRoundTrips = totalRoundTrips;
      const profitPerPairCents = 100 - quote.yesBidCents - quote.noBidCents;
      const newProfitCents = newRoundTrips * profitPerPairCents;
      totalProfit += newProfitCents / 100;
      stats.roundTrips += newRoundTrips;

      if (profitPerPairCents > 0) {
        console.log(`[mm] ROUND TRIP ${ticker}: +${newRoundTrips} new pairs × ${profitPerPairCents}¢ = +$${(newProfitCents / 100).toFixed(2)}`);
        await tg(
          `💰 <b>MM ROUND TRIP</b>\n\n` +
          `${quote.title}\n` +
          `+${newRoundTrips} pairs × ${profitPerPairCents}¢ = <b>+$${(newProfitCents / 100).toFixed(2)}</b>\n` +
          `Total: ${totalRoundTrips} round trips | Session profit: <b>$${totalProfit.toFixed(2)}</b>`
        );
      }
    }

    // If both orders are done (filled or cancelled), remove from active
    if (!quote.yesOrderId && !quote.noOrderId) {
      activeQuotes.delete(ticker);
      console.log(`[mm] ${ticker} completed — removed from active`);
    }
  }
}

async function cancelAllOrders() {
  for (const [ticker, quote] of activeQuotes) {
    if (quote.yesOrderId) {
      await kalshiDelete(`/portfolio/orders/${quote.yesOrderId}`).catch(() => {});
      stats.cancelled++;
    }
    if (quote.noOrderId) {
      await kalshiDelete(`/portfolio/orders/${quote.noOrderId}`).catch(() => {});
      stats.cancelled++;
    }
  }
  activeQuotes.clear();
  console.log(`[mm] All orders cancelled`);
}

async function requote() {
  // Refresh balance before requoting
  try {
    const bal = await kalshiGet('/portfolio/balance');
    kalshiBalanceDollars = (bal.balance ?? 0) / 100;
    console.log(`[mm] Balance: $${kalshiBalanceDollars.toFixed(2)}`);
  } catch { /* keep old value */ }

  // Cancel existing orders and re-place with updated prices
  const currentTickers = [...activeQuotes.keys()];
  await cancelAllOrders();

  // Find new wide-spread markets
  const markets = await findWideSpreadMarkets();
  const toQuote = markets.slice(0, MAX_CONCURRENT);

  for (const market of toQuote) {
    // Skip if game starts within 30 minutes
    const closeMs = Date.parse(market.closeTime);
    if (Number.isFinite(closeMs) && closeMs - Date.now() < MIN_GAME_MINUTES * 60 * 1000) {
      console.log(`[mm] Skip ${market.ticker} — game starts in < ${MIN_GAME_MINUTES}min`);
      continue;
    }

    const quote = await placeQuotes(market);
    if (quote) {
      activeQuotes.set(market.ticker, quote);
    }

    // Small delay between orders to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[mm] Active quotes: ${activeQuotes.size} markets`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

function logStats() {
  console.log(`[mm-stats] quotes=${stats.quotesPlaced} fills_yes=${stats.fillsYes} fills_no=${stats.fillsNo} round_trips=${stats.roundTrips} cancelled=${stats.cancelled} profit=$${totalProfit.toFixed(2)} active=${activeQuotes.size}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Arbor Market Maker Bot ===');
  console.log(`Config: MIN_SPREAD=${MIN_SPREAD_CENTS}¢ OFFSET=${QUOTE_OFFSET_CENTS}¢ MAX_PER_MARKET=$${MAX_PER_MARKET_USD} MAX_CONCURRENT=${MAX_CONCURRENT}`);

  if (!KALSHI_API_KEY || !kalshiPrivateKey) {
    console.error('Missing Kalshi credentials');
    process.exit(1);
  }

  // Cancel any stale orders from a previous crashed session
  try {
    const openOrders = await kalshiGet('/portfolio/orders?status=resting&limit=100');
    const stale = (openOrders.orders ?? []).filter(o => o.ticker?.includes('GAME'));
    if (stale.length > 0) {
      console.log(`[mm] Cancelling ${stale.length} stale orders from previous session`);
      for (const o of stale) {
        await kalshiDelete(`/portfolio/orders/${o.order_id}`).catch(() => {});
      }
    }
  } catch (e) {
    console.log('[mm] Could not check stale orders:', e.message);
  }

  // Check balance
  try {
    const bal = await kalshiGet('/portfolio/balance');
    console.log(`[mm] Kalshi balance: $${((bal.balance ?? 0) / 100).toFixed(2)}`);
  } catch (e) {
    console.error('[mm] Balance check failed:', e.message);
  }

  // Initial quote placement
  await requote();

  // Check fills every 5 seconds
  setInterval(checkFills, 5_000);

  // Re-quote every 30 seconds (cancel + re-place with fresh prices)
  setInterval(requote, REQUOTE_INTERVAL_MS);

  // Log stats every 60 seconds
  setInterval(logStats, 60_000);

  // Startup notification
  await tg(
    `🏦 <b>Market Maker Started</b>\n\n` +
    `Strategy: ${MIN_SPREAD_CENTS}¢+ spreads, ${QUOTE_OFFSET_CENTS}¢ offset\n` +
    `Max: $${MAX_PER_MARKET_USD}/market, ${MAX_CONCURRENT} concurrent\n` +
    `Re-quote: every ${REQUOTE_INTERVAL_MS / 1000}s`
  );

  // Graceful shutdown — cancel all orders
  process.on('SIGINT', async () => {
    console.log('\n[mm] Shutting down — cancelling all orders...');
    await cancelAllOrders();
    await tg('🛑 <b>Market Maker Stopped</b> — all orders cancelled');
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await cancelAllOrders();
    process.exit(0);
  });

  console.log('Market maker running. Press Ctrl+C to stop.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
