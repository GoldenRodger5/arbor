/**
 * Arbor Prediction Trading Bot
 *
 * Autonomous sports prediction engine for Kalshi + Polymarket.
 * Uses Claude (Haiku screen → Sonnet + web search decide) to predict
 * game winners and buy contracts on the cheaper platform.
 *
 * Pipeline (every 60 seconds):
 *   1. Pre-game: Scan today's games, predict winners, buy at 25-85¢
 *   2. Live: Monitor ESPN scores, predict winners of games with leads
 *   3. Cross-platform: Compare Kalshi vs Poly prices, buy cheaper
 *   4. Resolution: Buy winning sides of settled games below $1 (risk-free)
 *   5. Stop-loss: Sell Kalshi positions down >30% from entry
 *
 * Risk controls: dynamic sizing (10% of bankroll), 15% daily loss halt,
 * 5-consecutive-loss reducer, 85¢ max price, 65% min confidence,
 * 5% confidence-over-price margin, sport exposure caps.
 *
 * Run: node ai-edge.mjs
 */

import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants } from 'crypto';
import 'dotenv/config';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_API_KEY = process.env.KALSHI_API_KEY_ID ?? '';
const KALSHI_REST = 'https://api.elections.kalshi.com/trade-api/v2';
const ANTHROPIC_KEY = process.env.VITE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID ?? '';

const MIN_CONFIDENCE = 0.65;      // Claude must be ≥65% confident to trade
const CONFIDENCE_MARGIN = 0.03;   // Confidence must exceed price by 3% — prediction mode, not mispricing
const MAX_PRICE = 0.90;           // Don't buy contracts above 90¢ — allows high-confidence late-game bets
const MAX_TRADE_FRACTION = 0.10; // 10% of bankroll per trade — base fraction
const POLL_INTERVAL_MS = 60 * 1000; // Check news every 60 seconds
const COOLDOWN_MS = 15 * 60 * 1000; // 15 min — allows scaling into winners
const MAX_DAYS_OUT = 1;            // Same-day only — capital turns over nightly
const CLAUDE_SCREENER = 'claude-haiku-4-5-20251001';  // Cheap screening — $0.002/call
const CLAUDE_DECIDER = 'claude-sonnet-4-6';            // Expensive analysis — only on candidates
// MAX_POSITIONS and deployment limits are DYNAMIC — see getMaxPositions() and getMaxDeployment()
const DAILY_LOSS_PCT = 0.15;       // Stop trading if down 15% in a day (room for 2-3 bad trades)
const CAPITAL_RESERVE = 0.05;      // Keep 5% of bankroll untouched (more capital working)
const MAX_CONSECUTIVE_LOSSES = 7;  // After 7 losses → reduce size (5 in a row happens naturally every 2-3 weeks)
const SPORT_EXPOSURE_PCT = 0.25;   // Max 25% of bankroll per sport — sports are the main edge source

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
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function kalshiPost(path, body) {
  const res = await fetch(`${KALSHI_REST}${path}`, {
    method: 'POST', headers: kalshiHeaders('POST', path), body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket US Auth (Ed25519)
// ─────────────────────────────────────────────────────────────────────────────

const POLY_US_KEY_ID = process.env.POLY_US_KEY_ID ?? '';
const POLY_US_SECRET = process.env.POLY_US_SECRET_KEY ?? '';
const POLY_US_API = 'https://api.polymarket.us';
let polyBalance = 0;

// Initialize Ed25519 signing ONCE at module level — avoids frozen object error
let polySign = null;
let polyPrivBytes = null;
async function initPolySigning() {
  if (polySign) return; // already initialized
  if (!POLY_US_KEY_ID || !POLY_US_SECRET) return;
  try {
    const { createHash } = await import('crypto');
    const ed = await import('@noble/ed25519');
    // ed.etc may be frozen — use Object.defineProperty which works on frozen objects
    // or wrap sha512 at a higher level
    try {
      ed.etc.sha512Sync = (...m) => {
        const h = createHash('sha512');
        for (const msg of m) h.update(msg);
        return new Uint8Array(h.digest());
      };
    } catch {
      // Object is frozen — override via defineProperty on a fresh copy
      try {
        Object.defineProperty(ed.etc, 'sha512Sync', {
          value: (...m) => {
            const h = createHash('sha512');
            for (const msg of m) h.update(msg);
            return new Uint8Array(h.digest());
          },
          writable: true, configurable: true,
        });
      } catch {
        // Object is truly sealed — use signAsync which uses its own sha512
        // signAsync doesn't need sha512Sync set
      }
    }
    // Prefer signAsync (doesn't need sha512Sync) over sync sign
    polySign = ed.signAsync ?? ed.sign;
    polyPrivBytes = Uint8Array.from(atob(POLY_US_SECRET), c => c.charCodeAt(0)).slice(0, 32);
    console.log('[poly] Ed25519 signing initialized (using signAsync)');
  } catch (e) {
    console.error('[poly] init error:', e.message);
  }
}

async function polySignRequest(method, path) {
  if (!polySign) await initPolySigning();
  if (!polySign) return null;
  const ts = String(Date.now());
  // Polymarket US signature: timestamp + method + path (NO body)
  const message = `${ts}${method}${path}`;
  const sigBytes = await polySign(new TextEncoder().encode(message), polyPrivBytes);
  const signature = btoa(String.fromCharCode(...sigBytes));
  return {
    headers: {
      'X-PM-Access-Key': POLY_US_KEY_ID,
      'X-PM-Timestamp': ts,
      'X-PM-Signature': signature,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'arbor-ai/1',
    },
  };
}

async function refreshPolyBalance() {
  if (!POLY_US_KEY_ID || !POLY_US_SECRET) return;
  try {
    const path = '/v1/account/balances';
    const auth = await polySignRequest('GET', path);
    if (!auth) return;

    const res = await fetch(`${POLY_US_API}${path}`, {
      headers: auth.headers,
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const balArr = data?.balances ?? data;
      const bal = Array.isArray(balArr)
        ? (balArr[0]?.currentBalance ?? balArr[0]?.buyingPower ?? balArr[0]?.balance ?? 0)
        : (data?.balance ?? data?.currentBalance ?? 0);
      polyBalance = parseFloat(String(bal ?? '0'));
      if (!Number.isFinite(polyBalance)) polyBalance = 0;
    }
  } catch (e) {
    console.error('[poly-balance] error:', e.message);
  }
}

async function polymarketPost(slug, intent, price, quantity) {
  if (!POLY_US_KEY_ID || !POLY_US_SECRET) {
    console.error('[poly-order] credentials not set');
    return { ok: false, status: 0, data: {} };
  }
  try {
    const path = '/v1/orders';
    const body = {
      marketSlug: slug,
      intent,
      type: 'ORDER_TYPE_LIMIT',
      price: { value: price.toFixed(2), currency: 'USD' },
      quantity: Math.round(quantity),
      tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    };
    const bodyStr = JSON.stringify(body);
    const auth = await polySignRequest('POST', path);
    if (!auth) return { ok: false, status: 0, data: {} };

    const res = await fetch(`${POLY_US_API}${path}`, {
      method: 'POST',
      headers: auth.headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[poly-order] FAILED ${res.status}:`, JSON.stringify(data));
    }
    console.log('[poly-order]', JSON.stringify({ status: res.status, slug, intent, price, quantity, response: data }));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    console.error('[poly-order] error:', e.message);
    return { ok: false, status: 0, data: {} };
  }
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude with Web Search — researches before deciding
// ─────────────────────────────────────────────────────────────────────────────

// Cheap Haiku screen — no web search, fast, $0.002/call
async function claudeScreen(prompt, { maxTokens = 300, timeout = 10000 } = {}) {
  stats.claudeCalls++;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: AbortSignal.timeout(timeout),
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_SCREENER,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.[0]?.text ?? '';
  } catch (e) {
    console.error('[claude-screen] error:', e.message);
    return null;
  }
}

// Expensive Sonnet + web search — only for final trade decisions
async function claudeWithSearch(prompt, { maxTokens = 1024, maxSearches = 3, timeout = 45000 } = {}) {
  stats.claudeCalls++;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: AbortSignal.timeout(timeout),
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_DECIDER,
        max_tokens: maxTokens,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: maxSearches,
        }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error('[claude-search] HTTP', res.status, await res.text().catch(() => ''));
      return null;
    }

    const data = await res.json();
    const textBlocks = (data.content ?? []).filter(b => b.type === 'text');
    const searches = (data.content ?? []).filter(b => b.type === 'server_tool_use').length;
    if (searches > 0) console.log(`[claude-search] Used ${searches} web searches`);

    // Return last text block (Claude's final answer after research)
    return textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : '';
  } catch (e) {
    console.error('[claude-search] error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const tradeCooldowns = new Map(); // ticker → lastTradedMs
const lastGameStates = new Map(); // "ATH@NYM" → "1-0-5" (score-period, for change detection)
let kalshiBalance = 0;
let kalshiPositionValue = 0;
let openPositions = [];  // fetched each cycle
let stats = { claudeCalls: 0, tradesPlaced: 0 }; // only tracking active metrics

// ─────────────────────────────────────────────────────────────────────────────
// Risk Management State
// ─────────────────────────────────────────────────────────────────────────────

let dailyOpenBankroll = 0;       // snapshot at start of day / bot restart
let consecutiveLosses = 0;       // reset on any win
let tradingHalted = false;       // circuit breaker flag
let haltReason = '';
let lastHaltCheck = 0;

function getBankroll() {
  return kalshiBalance + kalshiPositionValue + polyBalance;
}

// [REMOVED: Fee-gating functions — replaced by confidence-based prediction engine]

// Inverse curve: aggressive when small (need growth), conservative when big (protect gains)
// $200 → 85% deployed, $1K → 75%, $5K → 50%, $20K → 30%, $50K+ → 20%
function getMaxDeployment() {
  const b = getBankroll();
  if (b < 500) return 0.85;
  if (b < 2000) return 0.75;
  if (b < 5000) return 0.60;
  if (b < 20000) return 0.40;
  if (b < 50000) return 0.30;
  return 0.20;
}

function getMaxPositions() {
  const b = getBankroll();
  if (b < 500) return 30;       // small account — deployment cap is the real limiter
  if (b < 2000) return 40;
  if (b < 10000) return 50;
  if (b < 50000) return 60;
  return 80;
}

// Per-trade cap also scales: small accounts need room, big accounts need limits
function getTradeCapCeiling() {
  const b = getBankroll();
  if (b < 500) return 50;        // $200 → max $20 per trade (10% wins)
  if (b < 2000) return 150;      // $1K → max $100
  if (b < 10000) return 500;     // $5K → max $500
  if (b < 50000) return 2000;    // $20K → max $2000
  return 5000;                    // $50K+ → max $5000
}

function getAvailableCash(exchange = 'kalshi') {
  const bal = exchange === 'polymarket' ? polyBalance : kalshiBalance;
  const reserve = getBankroll() * CAPITAL_RESERVE;
  return Math.max(0, bal - reserve);
}

function getDynamicMaxTrade(exchange = 'kalshi') {
  const bankroll = getBankroll();
  const pctCap = bankroll * MAX_TRADE_FRACTION; // 10% of bankroll
  const ceiling = getTradeCapCeiling();
  const available = getAvailableCash(exchange);
  return Math.min(pctCap, ceiling, available);
}

function getTotalDeployed() {
  // Use Kalshi's portfolio_value (current market value) not original cost
  // Original cost is misleading — a $50 position that's now worth $10 isn't $50 of deployment
  return kalshiPositionValue + openPositions.filter(p => p.exchange === 'polymarket').reduce((sum, p) => sum + (p.cost ?? 0), 0);
}

function canDeployMore(tradeAmount) {
  const maxDeploy = getBankroll() * getMaxDeployment();
  const currentlyDeployed = getTotalDeployed();
  if (currentlyDeployed + tradeAmount > maxDeploy) {
    console.log(`[risk] Deployment cap: $${currentlyDeployed.toFixed(2)} + $${tradeAmount.toFixed(2)} > $${maxDeploy.toFixed(2)} (${(getMaxDeployment()*100).toFixed(0)}% of $${getBankroll().toFixed(2)})`);
    return false;
  }
  return true;
}

function canTrade() {
  if (tradingHalted) {
    console.log(`[risk] HALTED: ${haltReason}`);
    return false;
  }

  // Check daily loss limit (scales with bankroll)
  const currentBankroll = getBankroll();
  const dailyLossLimit = Math.max(10, dailyOpenBankroll * DAILY_LOSS_PCT);
  const dailyPnL = currentBankroll - dailyOpenBankroll;
  if (dailyOpenBankroll > 0 && dailyPnL < -dailyLossLimit) {
    tradingHalted = true;
    haltReason = `Daily loss limit hit: $${Math.abs(dailyPnL).toFixed(2)} lost today (limit: $${dailyLossLimit.toFixed(2)} = ${(DAILY_LOSS_PCT*100).toFixed(0)}% of $${dailyOpenBankroll.toFixed(2)})`;
    tg(`🛑 <b>TRADING HALTED</b>\n\n${haltReason}\n\nBot will resume tomorrow.`);
    console.log(`[risk] ${haltReason}`);
    return false;
  }

  // Check max positions (dynamic) — only count positions with meaningful cost
  const maxPos = getMaxPositions();
  const meaningfulPositions = openPositions.filter(p => (p.cost ?? 0) >= 1.0).length;
  if (meaningfulPositions >= maxPos) {
    console.log(`[risk] Max meaningful positions: ${meaningfulPositions}/${maxPos} (${openPositions.length} total including dust)`);
    return false;
  }

  // Also check deployment cap — even if position count is OK, don't over-deploy
  const deployed = getTotalDeployed();
  const maxDeploy = getBankroll() * getMaxDeployment();
  if (deployed >= maxDeploy) {
    console.log(`[risk] Deployment cap: $${deployed.toFixed(2)}/$${maxDeploy.toFixed(2)} (${(getMaxDeployment()*100).toFixed(0)}%)`);
    return false;
  }

  // Check consecutive losses (reduce size at 5, don't halt until 8)
  if (consecutiveLosses >= 10) {
    tradingHalted = true;
    haltReason = `10 consecutive losses — full halt, something is wrong`;
    tg(`🛑 <b>TRADING HALTED</b>\n\n${haltReason}`);
    console.log(`[risk] ${haltReason}`);
    return false;
  }

  return true;
}

function getPositionSize(exchange = 'kalshi', confidenceMargin = 0) {
  let size = getDynamicMaxTrade(exchange);

  // Scale UP for high-confidence trades — bigger margin = bigger bet
  // margin 5% = 1x (base), 10% = 1.5x, 15% = 2x, 20%+ = 2.5x (max)
  if (confidenceMargin > 0.05) {
    const multiplier = Math.min(2.5, 1 + (confidenceMargin - 0.05) * 10);
    const scaledSize = size * multiplier;
    // Still respect deployment cap and ceiling
    const ceiling = getTradeCapCeiling();
    size = Math.min(scaledSize, ceiling);
    if (multiplier > 1.1) console.log(`[sizing] High confidence (+${(confidenceMargin*100).toFixed(0)}%): ${multiplier.toFixed(1)}x → $${size.toFixed(2)}`);
  }

  // Reduce size after consecutive losses
  if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    size = size * 0.5;
    console.log(`[risk] Reduced position size to $${size.toFixed(2)} (50%) after ${consecutiveLosses} consecutive losses`);
  }

  return Math.max(1, size); // minimum $1
}

function getSportExposure(sport) {
  // Calculate how much is deployed on a given sport today
  let exposure = 0;
  for (const p of openPositions) {
    const ticker = p.ticker ?? '';
    if (sport === 'MLB' && ticker.includes('MLB')) exposure += p.cost;
    else if (sport === 'NBA' && ticker.includes('NBA')) exposure += p.cost;
    else if (sport === 'NHL' && ticker.includes('NHL')) exposure += p.cost;
    else if (sport === 'NFL' && ticker.includes('NFL')) exposure += p.cost;
  }
  return exposure;
}

function checkSportExposure(ticker) {
  for (const sport of ['MLB', 'NBA', 'NHL', 'NFL']) {
    if (ticker.includes(sport)) {
      const current = getSportExposure(sport);
      const sportCap = Math.max(15, getBankroll() * SPORT_EXPOSURE_PCT);
      if (current >= sportCap) {
        console.log(`[risk] ${sport} exposure $${current.toFixed(2)} >= $${sportCap.toFixed(2)} cap (8% of bankroll)`);
        return false;
      }
      return true;
    }
  }
  return true; // non-sports — no cap
}

// Update consecutive losses from trade log
function updateConsecutiveLosses() {
  if (!existsSync(TRADES_LOG)) return;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    // Read settled trades in reverse order
    let streak = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const t = JSON.parse(lines[i]);
        if (t.status !== 'settled') continue;
        if (t.realizedPnL >= 0) break; // win breaks the streak
        streak++;
      } catch { continue; }
    }
    consecutiveLosses = streak;
  } catch { /* keep current */ }
}

// Reset daily tracking (called at midnight ET or on restart)
function resetDailyTracking() {
  dailyOpenBankroll = getBankroll();
  tradingHalted = false;
  haltReason = '';
  updateConsecutiveLosses();
  console.log(`[risk] Daily reset: bankroll=$${dailyOpenBankroll.toFixed(2)} consecutiveLosses=${consecutiveLosses}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// P&L Trade Logging — append-only JSONL for every trade placed
// ─────────────────────────────────────────────────────────────────────────────

const TRADES_LOG = './logs/trades.jsonl';
const DAILY_LOG = './logs/daily-snapshots.jsonl';
const SCREENS_LOG = './logs/screens.jsonl';
if (!existsSync('./logs')) mkdirSync('./logs', { recursive: true });

function logTrade(entry) {
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry,
    status: 'open',           // open → settled (updated by checkSettlements)
    exitPrice: null,
    realizedPnL: null,
  };
  try {
    appendFileSync(TRADES_LOG, JSON.stringify(record) + '\n');
    console.log(`[pnl] Logged trade: ${record.exchange} ${record.ticker} ${record.side} $${record.deployCost?.toFixed(2)}`);
  } catch (e) {
    console.error('[pnl] Failed to log trade:', e.message);
  }
  return record.id;
}

// Log screening decisions for analysis: what Haiku flagged, what Sonnet decided
function logScreen(entry) {
  try {
    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(SCREENS_LOG, JSON.stringify(record) + '\n');
  } catch { /* silent */ }
}

// Daily analytics snapshot — called at midnight ET
function saveDailySnapshot() {
  try {
    // Read trade history for stats
    let totalTrades = 0, settledTrades = 0, wins = 0, losses = 0;
    let totalPnL = 0, todayPnL = 0, todayTrades = 0;
    const strategyStats = {};
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;

    if (existsSync(TRADES_LOG)) {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          totalTrades++;
          if (t.status === 'settled') {
            settledTrades++;
            const pnl = t.realizedPnL ?? 0;
            totalPnL += pnl;
            if (pnl >= 0) wins++; else losses++;
            if (t.settledAt && Date.parse(t.settledAt) > cutoff24h) todayPnL += pnl;
          }
          if (t.timestamp && Date.parse(t.timestamp) > cutoff24h) todayTrades++;
          // Per-strategy
          const strat = t.strategy ?? 'unknown';
          if (!strategyStats[strat]) strategyStats[strat] = { trades: 0, settled: 0, wins: 0, losses: 0, pnl: 0 };
          strategyStats[strat].trades++;
          if (t.status === 'settled') {
            strategyStats[strat].settled++;
            if ((t.realizedPnL ?? 0) >= 0) strategyStats[strat].wins++;
            else strategyStats[strat].losses++;
            strategyStats[strat].pnl += (t.realizedPnL ?? 0);
          }
        } catch { /* skip */ }
      }
    }

    const snapshot = {
      date: new Date().toISOString().slice(0, 10),
      timestamp: new Date().toISOString(),
      bankroll: getBankroll(),
      kalshiCash: kalshiBalance,
      kalshiPositions: kalshiPositionValue,
      polyBalance,
      openPositionCount: openPositions.length,
      totalDeployed: getTotalDeployed(),
      totalTrades,
      settledTrades,
      wins,
      losses,
      winRate: settledTrades > 0 ? Math.round((wins / settledTrades) * 100) : null,
      totalPnL: Math.round(totalPnL * 100) / 100,
      todayPnL: Math.round(todayPnL * 100) / 100,
      todayTrades,
      consecutiveLosses,
      strategyStats,
    };

    appendFileSync(DAILY_LOG, JSON.stringify(snapshot) + '\n');
    console.log(`[analytics] Daily snapshot saved: bankroll=$${snapshot.bankroll.toFixed(2)} pnl=$${snapshot.totalPnL.toFixed(2)} winRate=${snapshot.winRate ?? 'n/a'}%`);
    return snapshot;
  } catch (e) {
    console.error('[analytics] snapshot error:', e.message);
    return null;
  }
}

// Send daily P&L report to Telegram
async function sendDailyReport() {
  const snap = saveDailySnapshot();
  if (!snap) return;

  const stratLines = Object.entries(snap.strategyStats).map(([name, s]) => {
    const wr = s.settled > 0 ? `${Math.round((s.wins / s.settled) * 100)}%` : 'n/a';
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
    return `  ${name}: ${s.trades} trades, ${wr} win rate, ${pnlStr}`;
  }).join('\n');

  const pnlIcon = snap.totalPnL >= 0 ? '📈' : '📉';
  const todayIcon = snap.todayPnL >= 0 ? '+' : '';

  await tg(
    `${pnlIcon} <b>DAILY REPORT — ${snap.date}</b>\n\n` +
    `<b>Portfolio:</b>\n` +
    `Kalshi: $${snap.kalshiCash.toFixed(2)} cash + $${snap.kalshiPositions.toFixed(2)} positions\n` +
    `Polymarket: $${snap.polyBalance.toFixed(2)}\n` +
    `Total: <b>$${snap.bankroll.toFixed(2)}</b>\n\n` +
    `<b>Trading:</b>\n` +
    `Today: ${snap.todayTrades} trades, ${todayIcon}$${snap.todayPnL.toFixed(2)}\n` +
    `All time: ${snap.totalTrades} trades, ${snap.settledTrades} settled\n` +
    `Won: ${snap.wins} | Lost: ${snap.losses} | Win rate: ${snap.winRate ?? 'n/a'}%\n` +
    `Total P&L: <b>${snap.totalPnL >= 0 ? '+' : ''}$${snap.totalPnL.toFixed(2)}</b>\n\n` +
    `<b>By Strategy:</b>\n` +
    (stratLines || '  No trades yet') + '\n\n' +
    `Open: ${snap.openPositionCount} positions, $${snap.totalDeployed.toFixed(2)} deployed\n` +
    `Consecutive losses: ${snap.consecutiveLosses}\n` +
    `🕐 ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`
  );
}

async function refreshPortfolio() {
  try {
    const bal = await kalshiGet('/portfolio/balance');
    kalshiBalance = (bal.balance ?? 0) / 100;
    kalshiPositionValue = (bal.portfolio_value ?? 0) / 100;
  } catch { /* keep old */ }

  // Fetch Kalshi open positions
  try {
    const data = await kalshiGet('/portfolio/positions');
    openPositions = (data.event_positions ?? data.market_positions ?? data.positions ?? []).map(p => ({
      ticker: p.event_ticker ?? p.ticker ?? p.market_ticker ?? '',
      cost: parseFloat(p.total_cost_dollars ?? '0'),
      exchange: 'kalshi',
    })).filter(p => p.cost > 0);
  } catch { openPositions = []; }

  // Add Polymarket open positions from trades log — Poly API doesn't have a positions endpoint
  try {
    if (existsSync(TRADES_LOG)) {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          if (t.status === 'open' && t.exchange === 'polymarket') {
            openPositions.push({
              ticker: t.ticker,
              cost: t.deployCost ?? 0,
              exchange: 'polymarket',
            });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  // Also refresh Poly balance
  await refreshPolyBalance();

  const kalshiCount = openPositions.filter(p => p.exchange === 'kalshi').length;
  const polyCount = openPositions.filter(p => p.exchange === 'polymarket').length;
  console.log(`[portfolio] Kalshi: $${kalshiBalance.toFixed(2)} cash + $${kalshiPositionValue.toFixed(2)} positions | Poly: $${polyBalance.toFixed(2)} | Open: ${kalshiCount} Kalshi + ${polyCount} Poly`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Team Abbreviation Mapping — ESPN and Kalshi use different abbreviations
// ─────────────────────────────────────────────────────────────────────────────

const ABBR_MAP = {
  // ESPN → Kalshi (and vice versa — we normalize to check both)
  'CHW': 'CWS', 'CWS': 'CHW',    // Chicago White Sox
  'AZ': 'ARI', 'ARI': 'AZ',       // Arizona Diamondbacks
  'GS': 'GSW', 'GSW': 'GS',       // Golden State Warriors
  'NY': 'NYK', 'NYK': 'NY',       // New York Knicks
  'SA': 'SAS', 'SAS': 'SA',       // San Antonio Spurs
  'NO': 'NOP', 'NOP': 'NO',       // New Orleans Pelicans
  'UTAH': 'UTA', 'UTA': 'UTAH',   // Utah Jazz/Hockey
  'MON': 'MTL', 'MTL': 'MON',     // Montreal Canadiens
  'LA': 'LAK', 'LAK': 'LA',       // Los Angeles Kings
  'NJ': 'NJD', 'NJD': 'NJ',       // New Jersey Devils
  'TB': 'TBL', 'TBL': 'TB',       // Tampa Bay Lightning (NHL only — MLB TB is fine)
  'WSH': 'WAS', 'WAS': 'WSH',     // Washington (varies by sport)
  'ATH': 'OAK', 'OAK': 'ATH',     // Oakland/Athletics
};

// Check if a ticker contains a team abbreviation (tries both ESPN and Kalshi versions)
function tickerHasTeam(ticker, teamAbbr) {
  const upper = ticker.toUpperCase();
  if (upper.includes(teamAbbr.toUpperCase())) return true;
  const alt = ABBR_MAP[teamAbbr.toUpperCase()];
  if (alt && upper.includes(alt)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Win Expectancy Baselines — historical data for anchoring Claude's predictions
// ─────────────────────────────────────────────────────────────────────────────

// MLB: probability of leading team winning, by run lead and inning
// Source: Tom Tango (tangotiger.net/we.html), FanGraphs, 1903-2024 data
// Note: 3-run lead value differs by scoring environment (~4.3 R/G in 2020s)
const MLB_WIN_EXPECTANCY = {
  1: { 1: 0.56, 2: 0.58, 3: 0.60, 4: 0.64, 5: 0.67, 6: 0.71, 7: 0.77, 8: 0.84, 9: 0.91 },
  2: { 1: 0.64, 2: 0.67, 3: 0.70, 4: 0.76, 5: 0.79, 6: 0.83, 7: 0.88, 8: 0.93, 9: 0.96 },
  3: { 1: 0.72, 2: 0.75, 3: 0.78, 4: 0.85, 5: 0.87, 6: 0.90, 7: 0.93, 8: 0.96, 9: 0.98 },
  4: { 1: 0.79, 2: 0.82, 3: 0.85, 4: 0.90, 5: 0.92, 6: 0.94, 7: 0.96, 8: 0.98, 9: 0.99 },
  5: { 1: 0.85, 2: 0.87, 3: 0.90, 4: 0.93, 5: 0.95, 6: 0.97, 7: 0.98, 8: 0.99, 9: 0.99 },
};

// NBA: probability of leading team winning, by point lead and quarter
// Source: Professor MJ, inpredictable.com, Albert's Blog — MODERN era (2015+)
// Key: 15-point comebacks now happen 13% of time (was 6% pre-2002) due to 3-point shooting
// Home court: 62.7% overall (much stronger than MLB/NHL)
const NBA_WIN_EXPECTANCY = {
  5:  { 1: 0.57, 2: 0.60, 3: 0.65, 4: 0.75 },
  10: { 1: 0.63, 2: 0.69, 3: 0.77, 4: 0.86 },
  15: { 1: 0.70, 2: 0.78, 3: 0.85, 4: 0.92 },
  20: { 1: 0.78, 2: 0.85, 3: 0.91, 4: 0.96 },
  25: { 1: 0.85, 2: 0.90, 3: 0.95, 4: 0.98 },
};

// NHL: probability of leading team winning, by goal lead and period
// Source: Hockey Graphs, MoneyPuck — scoring first jumps to 70% win prob
// Home ice: 59% overall
const NHL_WIN_EXPECTANCY = {
  1: { 1: 0.62, 2: 0.68, 3: 0.79 },
  2: { 1: 0.80, 2: 0.86, 3: 0.93 },
  3: { 1: 0.92, 2: 0.95, 3: 0.99 },
};

function getWinExpectancy(league, lead, period) {
  let table, leadKey, periodKey;

  if (league === 'mlb') {
    table = MLB_WIN_EXPECTANCY;
    leadKey = Math.min(lead, 5);
    periodKey = Math.min(Math.max(period, 1), 9);
  } else if (league === 'mls' || league === 'epl' || league === 'laliga') {
    // Soccer: goal lead by half (1=first half, 2=second half)
    // Source: brendansudol.github.io, EPL/MLS data
    // Home leading 1-0 at HT: ~70% win. Away 1-0: reaches 70% at 68th min
    // 2-0 in 2nd half: >90% win. Draws: EPL 28%, MLS 24%
    table = { 1: { 1: 0.65, 2: 0.78 }, 2: { 1: 0.82, 2: 0.92 }, 3: { 1: 0.94, 2: 0.98 } };
    leadKey = Math.min(lead, 3);
    periodKey = Math.min(Math.max(period, 1), 2);
  } else if (league === 'nba') {
    table = NBA_WIN_EXPECTANCY;
    // Round to nearest bracket
    leadKey = lead >= 25 ? 25 : lead >= 20 ? 20 : lead >= 15 ? 15 : lead >= 10 ? 10 : 5;
    periodKey = Math.min(Math.max(period, 1), 4);
  } else if (league === 'nhl') {
    table = NHL_WIN_EXPECTANCY;
    leadKey = Math.min(lead, 3);
    periodKey = Math.min(Math.max(period, 1), 3);
  } else {
    return null;
  }

  if (!table[leadKey] || !table[leadKey][periodKey]) return null;
  return table[leadKey][periodKey];
}

function getWinExpectancyText(league, lead, period, isHome) {
  const base = getWinExpectancy(league, lead, period);
  if (!base) return '';
  const homeAdj = isHome ? 0.03 : -0.01;
  const adjusted = Math.min(0.99, base + homeAdj);
  const sport = league === 'mlb' ? 'MLB' : league === 'nba' ? 'NBA' : 'NHL';
  const periodName = league === 'mlb' ? `inning ${period}` : league === 'nba' ? `Q${period}` : `period ${period}`;
  const isSoccer = ['mls', 'epl', 'laliga'].includes(league);
  const drawWarning = isSoccer ? ' IMPORTANT: Soccer has draws (~25% of games). Your team must WIN outright — a draw means your contract LOSES.' : '';
  return `HISTORICAL BASELINE: Teams leading by ${lead} ${league === 'nba' ? 'points' : league === 'mlb' ? 'runs' : 'goals'} in ${periodName} ${isHome ? '(home)' : '(away)'} win ${(adjusted * 100).toFixed(0)}% of the time historically.${drawWarning} Start from this baseline and adjust up/down.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live Predictions + Market Scanning
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Platform Market Mapper — find same game on both Kalshi + Polymarket
// ─────────────────────────────────────────────────────────────────────────────

let cachedPolyMoneylines = [];
let polyMoneylinesFetchedAt = 0;
const POLY_CACHE_MS = 3 * 60 * 1000; // refresh every 3 min

async function getPolyMoneylines() {
  if (Date.now() - polyMoneylinesFetchedAt < POLY_CACHE_MS && cachedPolyMoneylines.length > 0) {
    return cachedPolyMoneylines;
  }
  const markets = [];
  try {
    for (let offset = 0; offset < 1000; offset += 200) {
      const res = await fetch(`https://gateway.polymarket.us/v1/markets?limit=200&offset=${offset}&active=true&closed=false`, {
        headers: { 'User-Agent': 'arbor-ai/1', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) break;
      const data = await res.json();
      if (!data.markets?.length) break;
      for (const m of data.markets) {
        if (m.marketType !== 'moneyline' || m.closed || !m.active) continue;
        const sides = m.marketSides ?? [];
        if (sides.length < 2) continue;
        const s0 = parseFloat(String(sides[0]?.price ?? '0'));
        const s1 = parseFloat(String(sides[1]?.price ?? '0'));
        if (s0 < 0.05 || s1 < 0.05) continue;
        markets.push({
          slug: m.slug ?? '',
          title: m.question ?? '',
          s0Name: sides[0]?.team?.name ?? sides[0]?.description ?? '',
          s1Name: sides[1]?.team?.name ?? sides[1]?.description ?? '',
          s0Price: s0, s1Price: s1,
        });
      }
    }
  } catch (e) {
    console.error('[poly-mapper] fetch error:', e.message);
  }
  cachedPolyMoneylines = markets;
  polyMoneylinesFetchedAt = Date.now();
  return markets;
}

// Find the Poly market matching a Kalshi game (by team abbreviations + sport)
function findPolyMarketForGame(homeAbbr, awayAbbr, polyMarkets, sport = '') {
  const ha = homeAbbr.toLowerCase();
  const aa = awayAbbr.toLowerCase();
  // Map Kalshi series to Poly sport prefix to avoid cross-sport matches
  // (PIT Pirates MLB ≠ PIT Penguins NHL)
  const sportMap = { mlb: 'mlb', nba: 'nba', nhl: 'nhl', nfl: 'nfl' };
  const polyPrefix = sportMap[sport.toLowerCase()] ?? '';

  return polyMarkets.find(m => {
    const slug = m.slug.toLowerCase();
    // Must match sport prefix if we know it
    if (polyPrefix && !slug.includes('-' + polyPrefix + '-')) return false;
    return slug.includes(ha) && slug.includes(aa);
  }) ?? null;
}

// Compare prices and pick the best platform to buy on
// targetTeamAbbr: which team we want to buy (e.g. 'PIT')
function pickBestPlatform(side, kalshiPrice, polyMatch, targetTeamAbbr = '') {
  if (!polyMatch) return { platform: 'kalshi', price: kalshiPrice };

  // Find which Poly side matches the team we want to buy
  const target = targetTeamAbbr.toLowerCase();
  const s0Name = (polyMatch.s0Name ?? '').toLowerCase();
  const s1Name = (polyMatch.s1Name ?? '').toLowerCase();
  const slugParts = (polyMatch.slug ?? '').toLowerCase().split('-');

  // Match by: team name contains abbreviation, or slug position matches
  let polyPrice = null;
  let polyIntent = '';

  // Check s0 (first team in slug = LONG)
  if (s0Name.includes(target) || (slugParts.length >= 4 && slugParts[2] === target)) {
    polyPrice = polyMatch.s0Price;
    polyIntent = 'ORDER_INTENT_BUY_LONG';
  }
  // Check s1 (second team in slug = SHORT)
  else if (s1Name.includes(target) || (slugParts.length >= 5 && slugParts[3] === target)) {
    polyPrice = polyMatch.s1Price;
    polyIntent = 'ORDER_INTENT_BUY_SHORT';
  }

  if (polyPrice !== null && polyPrice < kalshiPrice - 0.02 && polyPrice >= 0.05 && polyPrice < MAX_PRICE) {
    console.log(`[cross-platform] Poly cheaper: ${target} ${(polyPrice*100).toFixed(0)}¢ vs Kalshi ${(kalshiPrice*100).toFixed(0)}¢ (saving ${((kalshiPrice-polyPrice)*100).toFixed(0)}¢)`);
    return { platform: 'polymarket', price: polyPrice, slug: polyMatch.slug, intent: polyIntent };
  }
  return { platform: 'kalshi', price: kalshiPrice };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live Predictions — predict winners during live games
// ─────────────────────────────────────────────────────────────────────────────

async function checkLiveScoreEdges() {
  const sports = [
    { league: 'mlb', path: 'baseball/mlb', series: 'KXMLBGAME' },
    { league: 'nba', path: 'basketball/nba', series: 'KXNBAGAME' },
    { league: 'nhl', path: 'hockey/nhl', series: 'KXNHLGAME' },
    { league: 'mls', path: 'soccer/usa.1', series: 'KXMLSGAME' },
    { league: 'epl', path: 'soccer/eng.1', series: 'KXEPLGAME' },
    { league: 'laliga', path: 'soccer/esp.1', series: 'KXLALIGAGAME' },
  ];

  // === PHASE 1: Collect all games with leads (parallel ESPN fetch) ===
  const liveGames = [];
  const espnResults = await Promise.allSettled(
    sports.map(({ league, path }) =>
      fetch(`http://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`,
        { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : null)
        .then(data => ({ league, data }))
        .catch(() => null)
    )
  );
  for (const result of espnResults) {
    if (result.status !== 'fulfilled' || !result.value?.data) continue;
    const { league, data } = result.value;
    for (const ev of data.events ?? []) {
      const comp = ev.competitions?.[0];
      if (!comp || comp.status?.type?.state !== 'in') continue;
      const period = parseInt(comp.status?.period ?? '0');
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      const homeScore = parseInt(home.score ?? '0');
      const awayScore = parseInt(away.score ?? '0');
      const diff = Math.abs(homeScore - awayScore);
      const isSoccer = ['mls', 'epl', 'laliga'].includes(league);
      // Skip tied games UNLESS it's soccer (draw is a valid bet)
      if (diff === 0 && !isSoccer) continue;
      const leading = diff > 0 ? (homeScore > awayScore ? home : away) : home; // tied = home as placeholder
      const detail = comp.status?.type?.shortDetail ?? '';
      liveGames.push({ league, comp, ev, home, away, homeScore, awayScore, diff, period, leading, detail, isSoccer });
    }
  }

  if (liveGames.length === 0) return;

  // === PHASE 2: Find opportunities — score changed OR baseline-vs-price gap exists ===
  const candidates = [];
  for (const g of liveGames) {
    const gameKey = `${g.away.team?.abbreviation}@${g.home.team?.abbreviation}`;
    const currentState = `${g.awayScore}-${g.homeScore}-${g.period}`;
    const lastState = lastGameStates.get(gameKey);
    const scoreChanged = lastState !== undefined && lastState !== currentState;

    // Always update state
    lastGameStates.set(gameKey, currentState);

    // Skip first time seeing a game (no baseline)
    if (lastState === undefined) continue;

    // Calculate baseline win expectancy
    const isHome = g.leading === g.home;
    const we = g.diff > 0 ? (getWinExpectancy(g.league, g.diff, g.period, isHome) ?? 0.50) : 0.50;
    g._baselineWE = we;
    g._scoreChanged = scoreChanged;

    // Include if: score changed, OR baseline suggests opportunity (>60% WE with a lead)
    if (scoreChanged || (g.diff > 0 && we >= 0.60)) {
      candidates.push(g);
    }
  }

  if (candidates.length === 0) return;

  // Sort by baseline WE — highest opportunity first
  candidates.sort((a, b) => b._baselineWE - a._baselineWE);

  console.log(`[live-edge] ${candidates.length} candidates from ${liveGames.length} live (${candidates.map(g => {
    const tag = g._scoreChanged ? '⚡' : '📊';
    return tag + g.away.team?.abbreviation + '@' + g.home.team?.abbreviation + '(' + (g._baselineWE*100).toFixed(0) + '%)';
  }).join(', ')})`);

  // === PHASE 3: Analyze candidates in priority order — best opportunity first ===
  let sonnetCallsThisCycle = 0;
  const MAX_SONNET_PER_CYCLE = 3; // Cap to keep prices fresh

  for (const { league, comp, home, away, homeScore, awayScore, diff, period, leading, detail: gameDetail, isSoccer, _scoreChanged } of candidates) {
    const seriesMap = { mlb: 'KXMLBGAME', nba: 'KXNBAGAME', nhl: 'KXNHLGAME', mls: 'KXMLSGAME', epl: 'KXEPLGAME', laliga: 'KXLALIGAGAME' };
    const series = seriesMap[league] ?? 'KXMLBGAME';

    // === DRAW BET CHECK (soccer only, tied games, late in match) ===
    if (isSoccer && diff === 0 && period >= 2) {
      try {
        const homeAbbr = home.team?.abbreviation ?? '';
        const awayAbbr = away.team?.abbreviation ?? '';

        // Parse minutes from detail (e.g. "72'" or "2nd - 27'")
        const minMatch = gameDetail.match(/(\d+)/);
        const minutes = minMatch ? parseInt(minMatch[1]) : 0;
        // period 2 = second half. Minutes in second half context.
        const effectiveMin = period === 2 ? Math.max(minutes, 45) : minutes;

        // Draw probability baselines by minute (research-verified)
        let drawProb = 0;
        if (homeScore === 0 && awayScore === 0) {
          // 0-0 game
          if (effectiveMin >= 75) drawProb = 0.85;
          else if (effectiveMin >= 60) drawProb = 0.59;
          else drawProb = 0.36;
        } else {
          // 1-1, 2-2 etc
          if (effectiveMin >= 75) drawProb = 0.80;
          else if (effectiveMin >= 70) drawProb = 0.72;
          else if (effectiveMin >= 60) drawProb = 0.55;
          else drawProb = 0.35;
        }

        // Only bet draws when probability is high enough (>55%)
        if (drawProb >= 0.55) {
          // Find the TIE market
          const params = new URLSearchParams({ series_ticker: series, status: 'open', limit: '100' });
          const mkts = await kalshiGet(`/markets?${params}`);
          const tieMarket = (mkts.markets ?? []).find(m => {
            const ticker = m.ticker ?? '';
            return ticker.includes('-TIE') && tickerHasTeam(ticker, homeAbbr) && tickerHasTeam(ticker, awayAbbr);
          });

          if (tieMarket) {
            const tiePrice = parseFloat(tieMarket.yes_ask_dollars ?? '1');

            // Only buy if our probability exceeds the price by 3%+
            if (tiePrice < drawProb - CONFIDENCE_MARGIN && tiePrice <= MAX_PRICE && tiePrice >= 0.10) {
              const margin = drawProb - tiePrice;

              // Check risk gates
              if (!canTrade()) continue;
              const gameBase = tieMarket.ticker.lastIndexOf('-') > 0 ? tieMarket.ticker.slice(0, tieMarket.ticker.lastIndexOf('-')) : tieMarket.ticker;
              if (Date.now() - (tradeCooldowns.get(tieMarket.ticker) ?? 0) < COOLDOWN_MS) continue;
              if (Date.now() - (tradeCooldowns.get(gameBase) ?? 0) < COOLDOWN_MS) continue;

              // Check no existing position
              const hasPos = openPositions.some(p => {
                const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
                return pBase === gameBase || (p.exchange === 'polymarket' && tickerHasTeam(p.ticker, homeAbbr) && tickerHasTeam(p.ticker, awayAbbr));
              });
              if (hasPos) continue;

              const maxBet = getPositionSize('kalshi', margin);
              const qty = Math.max(1, Math.floor(maxBet / tiePrice));
              if (!canDeployMore(qty * tiePrice)) continue;

              const priceInCents = Math.round(tiePrice * 100);
              console.log(`[draw-bet] ⚽ ${homeAbbr} ${homeScore}-${awayScore} ${awayAbbr} at ${effectiveMin}' | TIE @${priceInCents}¢ (prob: ${(drawProb*100).toFixed(0)}%) margin: ${(margin*100).toFixed(0)}%`);

              tradeCooldowns.set(tieMarket.ticker, Date.now());
              tradeCooldowns.set(gameBase, Date.now());

              const result = await kalshiPost('/portfolio/orders', {
                ticker: tieMarket.ticker, action: 'buy', side: 'yes', count: qty,
                yes_price: priceInCents,
              });

              if (result.ok) {
                stats.tradesPlaced++;
                const deployed = qty * tiePrice;
                logTrade({
                  exchange: 'kalshi', strategy: 'draw-bet',
                  ticker: tieMarket.ticker, title: tieMarket.title ?? `${homeAbbr} vs ${awayAbbr} TIE`,
                  side: 'yes', quantity: qty, entryPrice: tiePrice, deployCost: deployed,
                  filled: (result.data.order ?? result.data).quantity_filled ?? 0,
                  orderId: (result.data.order ?? result.data).order_id ?? null,
                  edge: margin * 100, confidence: drawProb,
                  reasoning: `${homeScore}-${awayScore} at ${effectiveMin}'. Draw baseline ${(drawProb*100).toFixed(0)}% vs price ${priceInCents}¢.`,
                });

                await tg(
                  `⚽ <b>DRAW BET — KALSHI</b>\n\n` +
                  `<b>${homeAbbr} ${homeScore}-${awayScore} ${awayAbbr}</b> at ${effectiveMin}'\n\n` +
                  `BUY TIE @ ${priceInCents}¢ × ${qty} = <b>$${deployed.toFixed(2)}</b>\n` +
                  `Draw probability: <b>${(drawProb*100).toFixed(0)}%</b> vs price ${priceInCents}¢\n` +
                  `Potential profit: <b>$${(qty * (1 - tiePrice)).toFixed(2)}</b>\n\n` +
                  `🧠 <i>Pure math: ${homeScore === 0 && awayScore === 0 ? '0-0' : homeScore+'-'+awayScore} at ${effectiveMin}' = ${(drawProb*100).toFixed(0)}% draw historically</i>`
                );
              }
            }
          }
        }
      } catch (e) { console.error(`[draw-bet] error:`, e.message); }

      // If game is tied, skip the normal team-win analysis (no leader to bet on)
      if (diff === 0) continue;
    }

    // Cap Sonnet calls per cycle to avoid stale prices on later games
    if (sonnetCallsThisCycle >= MAX_SONNET_PER_CYCLE) {
      console.log(`[live-edge] Sonnet cap reached (${MAX_SONNET_PER_CYCLE}), remaining games deferred to next cycle`);
      break;
    }

    try {
        const homeAbbr = home.team?.abbreviation ?? '';
        const awayAbbr = away.team?.abbreviation ?? '';
        if (!homeAbbr || !awayAbbr) continue;
        console.log(`[live-edge] Sonnet analyzing: ${away.team?.displayName} (${awayAbbr}) ${awayScore} @ ${home.team?.displayName} (${homeAbbr}) ${homeScore} (${gameDetail})`);

        // Get today/tonight Kalshi markets — pre-filter to THIS game's teams + today's date
        const etNowLE = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const toShortLE = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
        const todayStr = toShortLE(etNowLE);
        // Late night: if it's after 10pm ET, also accept tomorrow's date (game started tonight, ticker is next day UTC)
        const etHourLE = etNowLE.getHours();
        const etTmrwLE = new Date(etNowLE.getTime() + 24 * 60 * 60 * 1000);
        const tonightStr = etHourLE >= 22 ? toShortLE(etTmrwLE) : null;

        const params = new URLSearchParams({ series_ticker: series, status: 'open', limit: '100' });
        const mkts = await kalshiGet(`/markets?${params}`);

        // Filter to ONLY markets for THIS game: must match teams AND TODAY's date
        // Only accept tomorrow's date after 10pm ET (for games that started tonight)
        const gameMarkets = (mkts.markets ?? []).filter(m => {
          if (!m.yes_ask_dollars || !m.no_ask_dollars) return false;
          const ya = parseFloat(m.yes_ask_dollars);
          const na = parseFloat(m.no_ask_dollars);
          if (ya < 0.01 || ya > 0.99 || na < 0.01 || na > 0.99) return false;
          const ticker = m.ticker ?? '';
          // Must be today's date (or tonight's late game after 10pm ET)
          if (!ticker.includes(todayStr) && !(tonightStr && ticker.includes(tonightStr))) return false;
          // Must match BOTH playing teams (ticker contains both abbreviations)
          // Use abbreviation mapper — ESPN "CHW" matches Kalshi "CWS" etc.
          return tickerHasTeam(ticker, homeAbbr) && tickerHasTeam(ticker, awayAbbr);
        });

        if (gameMarkets.length === 0) {
          console.log(`[live-edge] No Kalshi market found for ${awayAbbr}@${homeAbbr} on ${todayStr}${tonightStr ? '/' + tonightStr : ''}`);
          continue;
        }

        // Check BOTH sides — leading team AND trailing team (underdog value)
        const leadingAbbr = leading.team?.abbreviation ?? '';
        const trailing = homeScore > awayScore ? away : home;
        const trailingAbbr = trailing.team?.abbreviation ?? '';

        // Find markets for both teams
        // Find markets — check both ESPN and Kalshi abbreviation variants
        const leadMarket = gameMarkets.find(m => {
          const suffix = m.ticker?.split('-').pop()?.toUpperCase() ?? '';
          return suffix === leadingAbbr || suffix === (ABBR_MAP[leadingAbbr] ?? '');
        });
        const trailMarket = gameMarkets.find(m => {
          const suffix = m.ticker?.split('-').pop()?.toUpperCase() ?? '';
          return suffix === trailingAbbr || suffix === (ABBR_MAP[trailingAbbr] ?? '');
        });

        // Pick the better entry: leading team at cheap price OR trailing underdog at very cheap price
        const leadPrice = leadMarket ? parseFloat(leadMarket.yes_ask_dollars) : 1;
        const trailPrice = trailMarket ? parseFloat(trailMarket.yes_ask_dollars) : 1;

        // Default to leading team, but consider trailing if they're cheap enough (<40¢)
        let targetMarket = leadMarket;
        let targetAbbr = leadingAbbr;
        let targetTeam = leading;
        let price = leadPrice;

        // Underdog check: only if trailing team has a BETTER record than the leader
        if (trailMarket && trailPrice >= 0.15 && trailPrice <= 0.40 && period <= 4 && diff <= 3) {
          // Parse win counts from records to compare team quality
          const trailRec = trailing.records?.[0]?.summary ?? '';
          const leadRec = leading.records?.[0]?.summary ?? '';
          const parseWins = (rec) => parseInt(rec.split('-')[0]) || 0;
          const trailWins = parseWins(trailRec);
          const leadWins = parseWins(leadRec);
          // Only bet underdog if they have MORE wins (better team down early)
          if (trailWins > leadWins) {
            targetMarket = trailMarket;
            targetAbbr = trailingAbbr;
            targetTeam = trailing;
            price = trailPrice;
            console.log(`[live-edge] 🐕 Underdog value: ${trailingAbbr} (${trailRec}) trailing ${leadingAbbr} (${leadRec}) by ${diff} at ${(trailPrice*100).toFixed(0)}¢`);
          }
        }

        if (!targetMarket) continue;
        const title = targetMarket.title ?? '';

        console.log(`[live-edge] Found market: ${targetMarket.ticker} "${title}" ${targetAbbr} YES=$${price.toFixed(2)}`);

        // === BUILD RICH CONTEXT FROM ESPN DATA ===
        const homeRecord = home.records?.[0]?.summary ?? '';
        const awayRecord = away.records?.[0]?.summary ?? '';
        const homeHomeRec = home.records?.find(r => r.type === 'home')?.summary ?? '';
        const awayRoadRec = away.records?.find(r => r.type === 'road')?.summary ?? '';
        const homeIsLeading = leadingAbbr === homeAbbr;

        // Pitcher info (MLB)
        let pitcherInfo = '';
        if (league === 'mlb') {
          const situation = comp.situation ?? {};
          const pitcher = situation.pitcher;
          if (pitcher?.summary) {
            pitcherInfo = `Current pitcher: ${pitcher.athlete?.displayName ?? '?'} (${pitcher.summary})\n`;
          }
          // Probable/starting pitchers
          for (const c of [home, away]) {
            for (const p of c.probables ?? []) {
              const era = p.statistics?.find(s => s.abbreviation === 'ERA')?.displayValue ?? '?';
              const w = p.statistics?.find(s => s.abbreviation === 'W')?.displayValue ?? '?';
              const l = p.statistics?.find(s => s.abbreviation === 'L')?.displayValue ?? '?';
              pitcherInfo += `${c.team?.abbreviation} starter: ${p.athlete?.displayName ?? '?'} (${w}-${l}, ${era} ERA)\n`;
            }
          }
        }

        // Live situation (runners, outs, batter, last play)
        let situationInfo = '';
        const sit = comp.situation;
        if (sit) {
          const runners = [sit.onFirst && '1st', sit.onSecond && '2nd', sit.onThird && '3rd'].filter(Boolean);
          situationInfo = `Outs: ${sit.outs ?? '?'} | Runners: ${runners.length > 0 ? runners.join(', ') : 'none'}`;
          // Current batter (MLB)
          if (sit.batter?.athlete?.displayName) {
            situationInfo += ` | At bat: ${sit.batter.athlete.displayName} (${sit.batter.summary ?? ''})`;
          }
          // Last play for momentum context
          if (sit.lastPlay?.text) {
            situationInfo += `\nLast play: ${sit.lastPlay.text}`;
          }
        }

        // Time remaining (critical for NBA/NHL — "3:21 in 2nd" vs just "2nd quarter")
        let timeRemaining = '';
        const statusDetail = comp.status?.type?.shortDetail ?? '';
        if (league === 'nba' || league === 'nhl') {
          timeRemaining = statusDetail; // ESPN gives "3:21 - 2nd" which includes time
        }

        // Team stats
        const homeAvg = home.statistics?.find(s => s.abbreviation === 'AVG')?.displayValue ?? '';
        const awayAvg = away.statistics?.find(s => s.abbreviation === 'AVG')?.displayValue ?? '';

        // NBA shooting stats
        let shootingInfo = '';
        if (league === 'nba') {
          const getStat = (team, abbr) => team.statistics?.find(s => s.abbreviation === abbr)?.displayValue ?? '';
          const homeFG = getStat(home, 'FG%');
          const awayFG = getStat(away, 'FG%');
          const home3P = getStat(home, '3P%');
          const away3P = getStat(away, '3P%');
          const homeFTA = getStat(home, 'FTA');
          const awayFTA = getStat(away, 'FTA');
          const homeReb = getStat(home, 'REB');
          const awayReb = getStat(away, 'REB');
          const homeAST = getStat(home, 'AST');
          const awayAST = getStat(away, 'AST');

          if (homeFG) {
            shootingInfo = `FG%: ${homeAbbr} ${homeFG}% | ${awayAbbr} ${awayFG}%`;
            if (home3P) shootingInfo += ` | 3P%: ${homeAbbr} ${home3P}% | ${awayAbbr} ${away3P}%`;
            shootingInfo += `\nRebounds: ${homeAbbr} ${homeReb} | ${awayAbbr} ${awayReb} | Assists: ${homeAbbr} ${homeAST} | ${awayAbbr} ${awayAST}`;
            if (homeFTA) shootingInfo += ` | FTA: ${homeAbbr} ${homeFTA} | ${awayAbbr} ${awayFTA}`;
            // Flag shooting dominance for Claude
            const homeFGn = parseFloat(homeFG) || 0;
            const awayFGn = parseFloat(awayFG) || 0;
            if (Math.abs(homeFGn - awayFGn) > 10) {
              const better = homeFGn > awayFGn ? homeAbbr : awayAbbr;
              shootingInfo += `\n⚠️ ${better} shooting significantly better (${Math.abs(homeFGn - awayFGn).toFixed(0)}% FG gap)`;
            }
          }
        }

        // Leading scorers (NBA)
        let leadersInfo = '';
        if (league === 'nba') {
          for (const c of [home, away]) {
            const pts = c.leaders?.find(l => l.name === 'points');
            if (pts?.leaders?.[0]) {
              const p = pts.leaders[0];
              leadersInfo += `${c.team?.abbreviation} top scorer: ${p.athlete?.displayName} ${p.displayValue}\n`;
            }
          }
        }

        // Line score
        const homeLineScore = (home.linescores ?? []).map(l => l.displayValue).join(' ');
        const awayLineScore = (away.linescores ?? []).map(l => l.displayValue).join(' ');

        // Get win expectancy baseline for this exact game situation
        const targetIsHome = targetAbbr === homeAbbr;
        const baselineText = getWinExpectancyText(league, diff, period, leadingAbbr === homeAbbr);

        const livePrompt =
          `You are a professional sports bettor. Your job: predict this game's outcome using the historical baseline below.\n\n` +
          `═══ LIVE ${league.toUpperCase()} GAME ═══\n` +
          `${away.team?.displayName} (${awayRecord}${awayRoadRec ? ', ' + awayRoadRec + ' away' : ''}) ${awayScore}\n` +
          `  at\n` +
          `${home.team?.displayName} (${homeRecord}${homeHomeRec ? ', ' + homeHomeRec + ' home' : ''}) ${homeScore}\n\n` +
          `Status: ${gameDetail}\n` +
          `Line score: ${awayAbbr} [${awayLineScore}] | ${homeAbbr} [${homeLineScore}]\n` +
          (situationInfo ? `Situation: ${situationInfo}\n` : '') +
          (pitcherInfo ? `\n${pitcherInfo}` : '') +
          (homeAvg || awayAvg ? `Team batting: ${homeAbbr} ${homeAvg} | ${awayAbbr} ${awayAvg}\n` : '') +
          (shootingInfo ? `${shootingInfo}\n` : '') +
          (leadersInfo ? `${leadersInfo}` : '') +
          (timeRemaining && timeRemaining !== gameDetail ? `Time: ${timeRemaining}\n` : '') +
          `\n═══ ${baselineText} ═══\n\n` +
          `═══ MARKET ═══\n` +
          `${targetAbbr} YES @ ${(price*100).toFixed(0)}¢ (market thinks ${(price*100).toFixed(0)}% chance)\n` +
          `${targetAbbr === leadingAbbr ? '(LEADING team' : '(TRAILING team — underdog'}${targetIsHome ? ', HOME)' : ', AWAY)'}\n\n` +
          `═══ YOUR JOB ═══\n` +
          `Start from the historical baseline above. Then ADJUST up or down:\n` +
          `+ Better team (record, talent) → UP 2-5%\n` +
          `+ Home field → already in baseline (+3% home advantage)\n` +
          `+ Strong pitching/goaltending → UP 2-3%\n` +
          `+ ${league === 'mlb' ? 'Pitcher with ERA < 3.0 → UP 5-8%' : league === 'nba' ? 'Star player dominating (25+ pts) → UP 3-5%' : (league === 'mls' || league === 'epl' || league === 'laliga') ? 'Home advantage: EPL 45% home wins, MLS 49%. Red card on opponent = UP 25-30% (win prob 47%→18% for red-carded home team). First goal is critical momentum shift.' : 'Goalie with SV% > .925 → UP 3-5%'}\n` +
          `- Trailing team is much better → DOWN 3-8%\n` +
          `- ${league === 'mlb' ? 'Weak bullpen (ERA > 5.0) → DOWN 3-5%' : league === 'nba' ? 'MODERN NBA: 15-pt comebacks happen 13% now (3pt era) — be less aggressive on big NBA leads' : (league === 'mls' || league === 'epl' || league === 'laliga') ? 'DRAWS happen 24-30% of games (EPL 28%). 1-goal leads hold ~65-78%. Minutes 55-70 = best comeback window. Red card on YOUR team = DOWN 25-30%.' : 'Empty net situation → DOWN 5-10%'}\n` +
          `- ${league === 'nba' ? 'Star player in foul trouble → DOWN 5-10% for their team' : 'Trailing team has momentum (just scored multiple) → DOWN 2-4%'}\n` +
          `- IMPORTANT: Time remaining matters MORE than period/quarter number. 10pts up with 8min left ≠ 10pts up with 30sec left.\n\n` +
          `Use web search if you need injury/streak info. Then give your FINAL adjusted probability.\n\n` +
          `BUY if: your probability ≥ 65% AND at least 3 points above price.\n` +
          `${targetAbbr !== leadingAbbr ? 'NOTE: This is an UNDERDOG bet. The baseline says they LOSE. Only bet if specific factors override the baseline.\n' : ''}` +
          `Max bet: $${getDynamicMaxTrade().toFixed(2)} (bet MORE if confidence is much higher than price)\n\n` +
          `JSON ONLY:\n` +
          `{"trade": false, "confidence": 0.XX, "reasoning": "baseline X%, adjusted to Y% because [reasons]. Price is Z¢ so [pass/buy]."}\n` +
          `OR {"trade": true, "side": "yes", "confidence": 0.XX, "betAmount": N, "reasoning": "baseline X%, adjusted to Y% because [reasons]. Price Z¢ = good buy."}`;
        // Block if we already have a position on this game (check BOTH platforms)
        const ticker = targetMarket.ticker;
        const lastH = ticker.lastIndexOf('-');
        const gameBase = lastH > 0 ? ticker.slice(0, lastH) : ticker;
        const ha = homeAbbr.toLowerCase();
        const aa = awayAbbr.toLowerCase();
        const hasPosition = openPositions.some(p => {
          const pt = (p.ticker ?? '').toLowerCase();
          // Match Kalshi base ticker
          const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
          if (pBase === gameBase) return true;
          // Match Poly slug (contains team abbreviations)
          if (p.exchange === 'polymarket' && tickerHasTeam(pt, homeAbbr) && tickerHasTeam(pt, awayAbbr)) return true;
          return false;
        });
        if (hasPosition) { console.log(`[live-edge] BLOCKED: already have position on ${gameBase} (cross-platform check)`); continue; }

        // Cooldown check
        if (Date.now() - (tradeCooldowns.get(ticker) ?? 0) < COOLDOWN_MS) continue;
        if (Date.now() - (tradeCooldowns.get(gameBase) ?? 0) < COOLDOWN_MS) continue;

        // Price filter — skip if already decided (80¢+ = not enough upside) or lottery
        if (price <= 0.05) {
          console.log(`[live-edge] Skipping: ${leadingAbbr} @${(price*100).toFixed(0)}¢ (lottery ticket)`);
          continue;
        }
        if (price >= MAX_PRICE) {
          console.log(`[live-edge] Skipping: ${leadingAbbr} @${(price*100).toFixed(0)}¢ (too expensive, not enough upside)`);
          continue;
        }

        // Ask Claude to PREDICT the winner
        sonnetCallsThisCycle++;
        const cText = await claudeWithSearch(livePrompt);
        if (!cText) { console.log(`[live-edge] Sonnet returned empty for ${homeAbbr}@${awayAbbr}`); continue; }
        const jsonMatch = cText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { console.log(`[live-edge] Sonnet response not JSON for ${homeAbbr}@${awayAbbr}: ${cText.slice(0, 100)}`); continue; }

        let decision;
        try { decision = JSON.parse(jsonMatch[0]); } catch (e) { console.log(`[live-edge] JSON parse failed for ${homeAbbr}@${awayAbbr}: ${e.message}`); continue; }

        if (!decision.trade) {
          console.log(`[live-edge] Claude says NO: conf=${((decision.confidence ?? 0)*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ | ${decision.reasoning?.slice(0, 80)}`);
          logScreen({ stage: 'live-edge', ticker, result: 'pass', confidence: decision.confidence, price, reasoning: decision.reasoning });
          continue;
        }

        // Confidence-based gate — simple and clear
        const confidence = decision.confidence ?? 0;
        if (confidence < MIN_CONFIDENCE) {
          console.log(`[live-edge] Confidence too low: ${(confidence*100).toFixed(0)}% < 65%`);
          continue;
        }
        // Confidence must exceed price for the bet to be +EV
        if (confidence < price + CONFIDENCE_MARGIN) {
          console.log(`[live-edge] Not enough margin: conf=${(confidence*100).toFixed(0)}% vs price=${(price*100).toFixed(0)}¢ (need ${(CONFIDENCE_MARGIN*100).toFixed(0)}%+ gap)`);
          continue;
        }

        const edge = confidence - price; // simple: how much we think we're ahead

        // Risk checks
        if (!canTrade()) continue;
        if (!checkSportExposure(ticker)) continue;

        // === CROSS-PLATFORM PRICE CHECK — buy on cheaper platform ===
        const polyMoneylines = await getPolyMoneylines();
        const polyMatch = findPolyMarketForGame(homeAbbr, awayAbbr, polyMoneylines, league);
        const best = pickBestPlatform('yes', price, polyMatch, targetAbbr);

        // Use the better price for sizing
        const bestPrice = best.price;
        const bestEdge = confidence - bestPrice;
        if (bestEdge < CONFIDENCE_MARGIN) continue; // recheck with best price

        const maxBetLE = getPositionSize(best.platform, bestEdge);
        const claudeBet = decision.betAmount ?? 0;
        const safeBet = Math.min(claudeBet, maxBetLE);
        if (safeBet < 1) {
          console.log(`[live-edge] Bet too small: max=$${maxBetLE.toFixed(2)} Claude=$${claudeBet}`);
          continue;
        }
        if (!canDeployMore(safeBet)) continue;

        const qty = Math.max(1, Math.floor(safeBet / bestPrice));
        const priceInCents = Math.round(bestPrice * 100);

        const platformLabel = best.platform === 'polymarket' ? `POLY (${(price*100).toFixed(0)}¢ Kalshi → ${priceInCents}¢ Poly, saved ${((price-bestPrice)*100).toFixed(0)}¢)` : 'KALSHI';
        console.log(`[live-edge] 🎯 TRADE on ${platformLabel}: ${ticker} ${targetAbbr} YES @${priceInCents}¢ × ${qty} conf=${(confidence*100).toFixed(0)}%`);
        console.log(`  Score: ${awayAbbr} ${awayScore} @ ${homeAbbr} ${homeScore} (${gameDetail})`);
        console.log(`  Reason: ${decision.reasoning}`);
        logScreen({ stage: 'live-edge', ticker, result: 'TRADE', confidence, price: bestPrice, platform: best.platform, reasoning: decision.reasoning });

        tradeCooldowns.set(ticker, Date.now());
        tradeCooldowns.set(gameBase, Date.now());

        let result, deployed;
        if (best.platform === 'polymarket' && best.slug) {
          result = await polymarketPost(best.slug, best.intent, bestPrice + 0.02, qty);
          deployed = qty * bestPrice;
        } else {
          result = await kalshiPost('/portfolio/orders', {
            ticker, action: 'buy', side: 'yes', count: qty,
            yes_price: priceInCents,
          });
          deployed = qty * bestPrice;
        }

        if (result.ok) {
          stats.tradesPlaced++;

          logTrade({
            exchange: best.platform, strategy: 'live-prediction',
            ticker: best.platform === 'polymarket' ? best.slug : ticker,
            title, side: 'yes',
            quantity: qty, entryPrice: bestPrice, deployCost: deployed,
            filled: (result.data?.order ?? result.data)?.quantity_filled ?? 0,
            orderId: (result.data?.order ?? result.data)?.order_id ?? result.data?.id ?? null,
            edge: bestEdge * 100, confidence,
            reasoning: decision.reasoning,
            liveScore: `${awayAbbr} ${awayScore} - ${homeAbbr} ${homeScore} (${gameDetail})`,
            otherPlatformPrice: best.platform === 'polymarket' ? price : (polyMatch?.s0Price ?? null),
          });

          const savedMsg = best.platform === 'polymarket' ? `\n💡 Bought on Poly (${(price*100).toFixed(0)}¢ Kalshi → ${priceInCents}¢ Poly)` : '';
          await tg(
            `🎯 <b>${targetAbbr === leadingAbbr ? 'PREDICTION' : '🐕 UNDERDOG'} BET — ${best.platform.toUpperCase()}</b>\n\n` +
            `<b>${title}</b>\n` +
            `Team: <b>${targetAbbr}</b> | Score: ${awayAbbr} ${awayScore} - ${homeAbbr} ${homeScore}\n` +
            `Status: ${gameDetail}\n\n` +
            `BUY @ ${priceInCents}¢ × ${qty} = <b>$${deployed.toFixed(2)}</b>\n` +
            `Confidence: <b>${(confidence*100).toFixed(0)}%</b> vs price ${priceInCents}¢\n` +
            `Potential profit: <b>$${(qty * (1 - bestPrice)).toFixed(2)}</b>${savedMsg}\n\n` +
            `🧠 <i>${decision.reasoning}</i>`
          );
        } else {
          console.error(`[live-edge] Order failed:`, result.status, JSON.stringify(result.data));
        }
    } catch (e) {
      console.error(`[live-edge] error:`, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Predictions — bet on today's games BEFORE they start
// ─────────────────────────────────────────────────────────────────────────────

let lastPreGameScan = 0;
const PREGAME_SCAN_INTERVAL = 5 * 60 * 1000; // every 5 min — catch pre-game price shifts

async function checkPreGamePredictions() {
  if (Date.now() - lastPreGameScan < PREGAME_SCAN_INTERVAL) return;
  lastPreGameScan = Date.now();
  if (!canTrade()) return;

  const sportsSeries = ['KXMLBGAME', 'KXNBAGAME', 'KXNHLGAME', 'KXMLSGAME', 'KXEPLGAME', 'KXLALIGAGAME'];
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etTmrw = new Date(etNow.getTime() + 24 * 60 * 60 * 1000);
  const toShort = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
  const todayStr = toShort(etNow);
  const tonightStr = toShort(etTmrw);

  // Collect today's pre-game markets
  const preGameMarkets = [];
  for (const series of sportsSeries) {
    try {
      const data = await kalshiGet(`/markets?series_ticker=${series}&status=open&limit=200`);
      const seenBases = new Set();
      for (const m of data.markets ?? []) {
        if (!m.yes_ask_dollars || !m.no_ask_dollars) continue;
        const ticker = m.ticker ?? '';
        if (!ticker.includes(todayStr) && !ticker.includes(tonightStr)) continue;
        const ya = parseFloat(m.yes_ask_dollars);
        // Pre-game: 25-85¢ range for value entries
        if (ya < 0.25 || ya > MAX_PRICE) continue;
        // Dedup by game base
        const lastH = ticker.lastIndexOf('-');
        const base = lastH > 0 ? ticker.slice(0, lastH) : ticker;
        if (seenBases.has(base)) continue;
        seenBases.add(base);
        // Skip if we already have a position
        const hasPos = openPositions.some(p => {
          const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
          return pBase === base;
        });
        if (hasPos) continue;
        if (Date.now() - (tradeCooldowns.get(ticker) ?? 0) < COOLDOWN_MS) continue;
        if (Date.now() - (tradeCooldowns.get(base) ?? 0) < COOLDOWN_MS) continue;

        preGameMarkets.push({
          ticker, title: m.title, yesAsk: ya, noAsk: parseFloat(m.no_ask_dollars),
          base, series,
        });
      }
    } catch { /* skip */ }
  }

  if (preGameMarkets.length === 0) { console.log('[pre-game] No pre-game markets in 30-70¢ range'); return; }
  console.log(`[pre-game] Found ${preGameMarkets.length} pre-game markets in sweet spot`);

  // Haiku screen: which games look predictable?
  const marketList = preGameMarkets.slice(0, 20).map(m =>
    `${m.ticker}: "${m.title}" YES=${(m.yesAsk*100).toFixed(0)}¢ NO=${(m.noAsk*100).toFixed(0)}¢`
  ).join('\n');

  const screenText = await claudeScreen(
    `You are a sports handicapper. Pick up to 5 games where you have a strong opinion on who wins.\n\n` +
    `TODAY'S GAMES (pre-game, not started yet):\n${marketList}\n\n` +
    `For each pick, say which side (YES = first team listed in title, NO = second team) and why.\n` +
    `Only pick games where you're genuinely confident (≥65%). Skip coin-flip games.\n\n` +
    `JSON array: [{"ticker":"exact","side":"yes"/"no","reason":"who wins and why"}] or []`
  );
  if (!screenText) return;

  let picks = [];
  try {
    const arrMatch = screenText.match(/\[[\s\S]*\]/);
    if (arrMatch) picks = JSON.parse(arrMatch[0]);
  } catch { /* bad JSON */ }

  if (!Array.isArray(picks) || picks.length === 0) {
    console.log('[pre-game] Haiku: no confident picks');
    return;
  }
  console.log(`[pre-game] Haiku picked ${picks.length}: ${picks.map(p => p.ticker).join(', ')}`);

  // Sonnet deep dive on each pick
  for (const pick of picks.slice(0, 5)) {
    const market = preGameMarkets.find(m => m.ticker === pick.ticker);
    if (!market) continue;

    const price = pick.side === 'yes' ? market.yesAsk : market.noAsk;
    if (price > MAX_PRICE || price < 0.05) continue;

    const pregamePrice = pick.side === 'yes' ? market.yesAsk : market.noAsk;
    const decideText = await claudeWithSearch(
      `You are a professional sports bettor. Predict who wins this pre-game matchup.\n\n` +
      `GAME: ${market.title}\n` +
      `YES price: ${(market.yesAsk*100).toFixed(0)}¢ | NO price: ${(market.noAsk*100).toFixed(0)}¢\n` +
      `Haiku's pick: ${pick.side.toUpperCase()} — "${pick.reason}"\n\n` +
      `PRE-GAME BASELINES (verified historical data):\n` +
      `- MLB home team wins 54% | Top pitcher (ERA<3.0) adds +10-15% | FIP is better predictor than ERA\n` +
      `- NBA home team wins 63% | Star player out = -10% | Back-to-back team = -3-5%\n` +
      `- NHL home team wins 59% | Scoring first = 70% win rate | Goalie SV% is key factor\n` +
      `- EPL home 45%, draw 28%, away 27% | MLS home 49%, draw 24% | REMEMBER: draw = your contract LOSES\n` +
      `- Soccer: Red card = massive swing (47%→18%). Recent form (last 5) matters. First goal is critical.\n` +
      `Start from the home/away baseline, then adjust.\n\n` +
      `RESEARCH: Look up both teams' records, starting pitchers (MLB), key injuries, recent form (last 5 games), head-to-head this season.\n\n` +
      `ADJUST the baseline based on:\n` +
      `+ Much better record → UP 5-10%\n` +
      `+ Ace pitcher starting (ERA < 3.0) → UP 5-8%\n` +
      `+ Home team with strong home record → UP 3-5%\n` +
      `+ Hot streak (won 5+ in a row) → UP 3-5%\n` +
      `- Key player injured/resting → DOWN 5-10%\n` +
      `- Bad recent form (lost 4+ in a row) → DOWN 3-5%\n` +
      `- Poor starter pitching (ERA > 5.0) → DOWN 5-8%\n\n` +
      `BUY if confidence ≥ 65% AND at least 3 points above price.\n` +
      `Max bet: $${getDynamicMaxTrade().toFixed(2)} (bet MORE if confidence is much higher than price)\n\n` +
      `JSON ONLY:\n` +
      `{"trade":false,"confidence":0.XX,"reasoning":"baseline X%, adjusted to Y% because [reasons]"}\n` +
      `OR {"trade":true,"side":"${pick.side}","confidence":0.XX,"betAmount":N,"reasoning":"baseline X%, adjusted to Y% because [reasons]. Price ${(pregamePrice*100).toFixed(0)}¢ = good buy."}`,
      { maxTokens: 800, maxSearches: 3 }
    );
    if (!decideText) continue;

    const jsonMatch = decideText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;
    let decision;
    try { decision = JSON.parse(jsonMatch[0]); } catch { continue; }

    if (!decision.trade) {
      console.log(`[pre-game] Sonnet rejected ${pick.ticker}: conf=${((decision.confidence??0)*100).toFixed(0)}% | ${decision.reasoning?.slice(0, 80)}`);
      logScreen({ stage: 'pre-game-sonnet', ticker: pick.ticker, result: 'rejected', confidence: decision.confidence, reasoning: decision.reasoning });
      continue;
    }

    const confidence = decision.confidence ?? 0;
    if (confidence < MIN_CONFIDENCE || confidence < price + CONFIDENCE_MARGIN) {
      console.log(`[pre-game] Confidence check failed: conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢`);
      continue;
    }

    if (!canTrade()) break;
    if (!checkSportExposure(market.ticker)) continue;

    // Cross-platform price check — extract team abbreviations from ticker
    const tickerParts = market.ticker.split('-');
    const teamBlock = tickerParts.length >= 3 ? tickerParts[tickerParts.length - 2] : '';
    const team1 = teamBlock.slice(-6, -3);
    const team2 = teamBlock.slice(-3);
    // Extract sport from Kalshi series ticker (KXMLBGAME → mlb, KXNBAGAME → nba)
    const pgSport = market.ticker.includes('MLB') ? 'mlb' : market.ticker.includes('NBA') ? 'nba' : market.ticker.includes('NHL') ? 'nhl' : market.ticker.includes('MLS') ? 'mls' : market.ticker.includes('EPL') ? 'epl' : market.ticker.includes('LALIGA') ? 'laliga' : '';
    const pgPolyMarkets = await getPolyMoneylines();
    const pgPolyMatch = findPolyMarketForGame(team1, team2, pgPolyMarkets, pgSport);
    // The team we want is in the ticker suffix (e.g., -PIT or -CHC)
    const pgTargetTeam = market.ticker.split('-').pop() ?? '';
    const pgBest = pickBestPlatform(pick.side, price, pgPolyMatch, pgTargetTeam);

    const bestPrice = pgBest.price;
    const edge = confidence - bestPrice;
    if (edge < CONFIDENCE_MARGIN) continue;

    const maxBet = getPositionSize(pgBest.platform, edge);
    const safeBet = Math.min(decision.betAmount ?? 0, maxBet);
    if (safeBet < 1) continue;

    const qty = Math.max(1, Math.floor(safeBet / bestPrice));
    const priceInCents = Math.round(bestPrice * 100);

    if (!canDeployMore(qty * bestPrice)) continue;

    const pgPlatformLabel = pgBest.platform === 'polymarket' ? `POLY (saved ${((price-bestPrice)*100).toFixed(0)}¢ vs Kalshi)` : 'KALSHI';
    console.log(`[pre-game] 🎯 TRADE on ${pgPlatformLabel}: ${market.ticker} ${pick.side.toUpperCase()} @${priceInCents}¢ × ${qty} conf=${(confidence*100).toFixed(0)}%`);
    logScreen({ stage: 'pre-game', ticker: market.ticker, result: 'TRADE', confidence, price: bestPrice, platform: pgBest.platform, reasoning: decision.reasoning });

    tradeCooldowns.set(market.ticker, Date.now());
    tradeCooldowns.set(market.base, Date.now());

    let pgResult, deployed;
    if (pgBest.platform === 'polymarket' && pgBest.slug) {
      pgResult = await polymarketPost(pgBest.slug, pgBest.intent, bestPrice + 0.02, qty);
      deployed = qty * bestPrice;
    } else {
      pgResult = await kalshiPost('/portfolio/orders', {
        ticker: market.ticker, action: 'buy', side: pick.side, count: qty,
        yes_price: pick.side === 'yes' ? priceInCents : 100 - priceInCents,
      });
      deployed = qty * bestPrice;
    }

    if (pgResult.ok) {
      stats.tradesPlaced++;
      logTrade({
        exchange: pgBest.platform, strategy: 'pre-game-prediction',
        ticker: pgBest.platform === 'polymarket' ? pgBest.slug : market.ticker,
        title: market.title,
        side: pick.side, quantity: qty, entryPrice: bestPrice,
        deployCost: deployed,
        filled: (pgResult.data?.order ?? pgResult.data)?.quantity_filled ?? 0,
        orderId: (pgResult.data?.order ?? pgResult.data)?.order_id ?? pgResult.data?.id ?? null,
        edge: edge * 100, confidence,
        reasoning: decision.reasoning,
      });

      const pgSavedMsg = pgBest.platform === 'polymarket' ? `\n💡 Poly was cheaper than Kalshi` : '';
      await tg(
        `🎯 <b>PRE-GAME BET — ${pgBest.platform.toUpperCase()}</b>\n\n` +
        `<b>${market.title}</b>\n` +
        `BUY ${pick.side.toUpperCase()} @ ${priceInCents}¢ × ${qty} = <b>$${deployed.toFixed(2)}</b>\n` +
        `Confidence: <b>${(confidence*100).toFixed(0)}%</b> vs price ${priceInCents}¢\n` +
        `Potential profit: <b>$${(qty * (1 - bestPrice)).toFixed(2)}</b>${pgSavedMsg}\n\n` +
        `🧠 <i>${decision.reasoning}</i>`
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// UFC Predictions — Polymarket-only fight predictions
// ─────────────────────────────────────────────────────────────────────────────

let lastUFCScan = 0;
const UFC_SCAN_INTERVAL = 30 * 60 * 1000; // every 30 min (fights don't change fast)

async function checkUFCPredictions() {
  if (Date.now() - lastUFCScan < UFC_SCAN_INTERVAL) return;
  lastUFCScan = Date.now();
  if (!canTrade()) return;
  if (polyBalance < 3) return;

  // Fetch UFC moneylines from Poly
  const polyMoneylines = await getPolyMoneylines();
  const ufcMarkets = polyMoneylines.filter(m => m.slug.includes('-ufc-'));

  if (ufcMarkets.length === 0) return;
  console.log(`[ufc] Found ${ufcMarkets.length} UFC fights on Polymarket`);

  // Filter to tradeable price range + no existing positions
  const tradeable = ufcMarkets.filter(m => {
    const price = Math.min(m.s0Price, m.s1Price);
    if (price < 0.05) return false;
    // Check if we already have a position on this fight
    const hasPos = openPositions.some(p => (p.ticker ?? '').toLowerCase() === m.slug.toLowerCase());
    if (hasPos) return false;
    if (Date.now() - (tradeCooldowns.get('poly:' + m.slug) ?? 0) < COOLDOWN_MS) return false;
    return true;
  });

  if (tradeable.length === 0) return;

  // Haiku screen: which fights are predictable?
  const fightList = tradeable.slice(0, 10).map(m =>
    `"${m.title}" — ${m.s0Name} @ ${(m.s0Price*100).toFixed(0)}¢ vs ${m.s1Name} @ ${(m.s1Price*100).toFixed(0)}¢ [slug: ${m.slug}]`
  ).join('\n');

  const screenText = await claudeScreen(
    `You are an MMA/UFC analyst. Pick up to 2 fights where you're most confident predicting the winner.\n\n` +
    `UPCOMING UFC FIGHTS:\n${fightList}\n\n` +
    `For each pick, consider: fighter records, recent form, style matchup, weight class.\n` +
    `Only pick fights where you're genuinely confident (≥65%).\n\n` +
    `JSON array: [{"slug":"exact slug","fighter":"name","side":"side0"/"side1","reason":"why they win"}] or []`
  );
  if (!screenText) return;

  let picks = [];
  try {
    const arr = screenText.match(/\[[\s\S]*\]/);
    if (arr) picks = JSON.parse(arr[0]);
  } catch { return; }

  if (!Array.isArray(picks) || picks.length === 0) {
    console.log('[ufc] Haiku: no confident picks');
    return;
  }
  console.log(`[ufc] Haiku picked ${picks.length}: ${picks.map(p => p.fighter).join(', ')}`);

  for (const pick of picks.slice(0, 2)) {
    const market = tradeable.find(m => m.slug === pick.slug);
    if (!market) continue;

    const price = pick.side === 'side0' ? market.s0Price : market.s1Price;
    if (price > MAX_PRICE || price < 0.05) continue;

    // Sonnet deep dive on this fight
    const decideText = await claudeWithSearch(
      `You are a professional MMA bettor. Predict this fight.\n\n` +
      `FIGHT: ${market.title}\n` +
      `${market.s0Name} @ ${(market.s0Price*100).toFixed(0)}¢ vs ${market.s1Name} @ ${(market.s1Price*100).toFixed(0)}¢\n` +
      `Haiku's pick: ${pick.fighter} — "${pick.reason}"\n\n` +
      `RESEARCH: Look up both fighters' records, recent fights, fighting style, strengths/weaknesses.\n\n` +
      `PREDICT: How confident are you? Consider:\n` +
      `- Overall MMA record and recent form (last 3-5 fights)\n` +
      `- Fighting style matchup (striker vs grappler, etc.)\n` +
      `- Physical advantages (reach, size, cardio)\n` +
      `- Level of competition faced\n\n` +
      `BUY if confidence ≥ 65% AND at least 3 points above price.\n` +
      `Max bet: $${getPositionSize('polymarket').toFixed(2)}\n\n` +
      `JSON ONLY:\n` +
      `{"trade":false,"confidence":0.XX,"reasoning":"prediction"}\n` +
      `OR {"trade":true,"side":"${pick.side}","confidence":0.XX,"betAmount":N,"reasoning":"who wins and why"}`,
      { maxTokens: 800, maxSearches: 3 }
    );
    if (!decideText) continue;

    const jsonMatch = decideText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;
    let decision;
    try { decision = JSON.parse(jsonMatch[0]); } catch { continue; }

    if (!decision.trade) {
      console.log(`[ufc] Sonnet rejected ${pick.fighter}: conf=${((decision.confidence??0)*100).toFixed(0)}% | ${decision.reasoning?.slice(0, 80)}`);
      logScreen({ stage: 'ufc', slug: pick.slug, result: 'rejected', confidence: decision.confidence, reasoning: decision.reasoning });
      continue;
    }

    const confidence = decision.confidence ?? 0;
    if (confidence < MIN_CONFIDENCE || confidence < price + CONFIDENCE_MARGIN) {
      console.log(`[ufc] Confidence check failed: conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢`);
      continue;
    }

    if (!canTrade()) break;
    const ufcEdge = confidence - price;
    const maxBet = getPositionSize('polymarket', ufcEdge);
    const safeBet = Math.min(decision.betAmount ?? 0, maxBet);
    if (safeBet < 1) continue;
    if (!canDeployMore(safeBet)) continue;

    const qty = Math.max(1, Math.floor(safeBet / (price + 0.02)));
    const intent = pick.side === 'side0' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT';
    const edge = confidence - price;

    console.log(`[ufc] 🥊 TRADE: ${pick.fighter} @ ${(price*100).toFixed(0)}¢ × ${qty} conf=${(confidence*100).toFixed(0)}%`);
    logScreen({ stage: 'ufc', slug: pick.slug, result: 'TRADE', confidence, price, reasoning: decision.reasoning });

    tradeCooldowns.set('poly:' + market.slug, Date.now());

    const result = await polymarketPost(market.slug, intent, price + 0.02, qty);
    if (result.ok) {
      stats.tradesPlaced++;
      const deployed = qty * price;
      logTrade({
        exchange: 'polymarket', strategy: 'ufc-prediction',
        ticker: market.slug, title: market.title,
        side: pick.side === 'side0' ? 'long' : 'short',
        quantity: qty, entryPrice: price, deployCost: deployed,
        edge: edge * 100, confidence,
        reasoning: decision.reasoning,
      });

      await tg(
        `🥊 <b>UFC BET — POLYMARKET</b>\n\n` +
        `<b>${market.title}</b>\n` +
        `Fighter: <b>${pick.fighter}</b>\n` +
        `BUY @ ${(price*100).toFixed(0)}¢ × ${qty} = <b>$${deployed.toFixed(2)}</b>\n` +
        `Confidence: <b>${(confidence*100).toFixed(0)}%</b> vs price ${(price*100).toFixed(0)}¢\n` +
        `Potential profit: <b>$${(qty * (1 - price)).toFixed(2)}</b>\n\n` +
        `🧠 <i>${decision.reasoning}</i>`
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Broad Market Scan — finds edges across ALL market types
// ─────────────────────────────────────────────────────────────────────────────

let lastBroadScan = 0;
const BROAD_SCAN_INTERVAL = 5 * 60 * 1000; // every 5 min — markets don't reprice faster

async function claudeBroadScan() {
  if (Date.now() - lastBroadScan < BROAD_SCAN_INTERVAL) return;
  lastBroadScan = Date.now();
  if (kalshiBalance < 5) return; // not enough to trade

  console.log('[broad-scan] Running Claude broad market scan...');

  // Fetch markets across categories — sports, crypto, politics, economics
  const categories = [
    { name: 'Sports', series: ['KXMLBGAME', 'KXNBAGAME', 'KXNHLGAME', 'KXMLSGAME', 'KXEPLGAME', 'KXLALIGAGAME'] },
    { name: 'Crypto', keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto'] },
    { name: 'Economics', keywords: ['cpi', 'fed', 'gdp', 'jobs', 'inflation', 'rate'] },
  ];

  const allMarkets = [];

  // Sports — game-winners + additional sports series
  const sportsSeries = [...categories[0].series, 'KXNFLGAME'];
  for (const s of sportsSeries) {
    try {
      const data = await kalshiGet(`/markets?series_ticker=${s}&status=open&limit=200`);
      for (const m of data.markets ?? []) {
        if (!m.yes_ask_dollars || !m.no_ask_dollars) continue;
        allMarkets.push({
          ticker: m.ticker,
          title: m.title,
          category: 'Sports',
          yesAsk: m.yes_ask_dollars,
          noAsk: m.no_ask_dollars,
          closeTime: m.close_time ?? '',
        });
      }
    } catch { /* skip */ }
  }

  // Golf/Masters — high volume event, scan parlays by keyword
  try {
    let cursor = '';
    for (let p = 0; p < 3; p++) {
      const url = `/markets?status=open&limit=100${cursor ? '&cursor=' + cursor : ''}`;
      const data = await kalshiGet(url);
      for (const m of data.markets ?? []) {
        if (!m.yes_ask_dollars || !m.no_ask_dollars) continue;
        const t = (m.title ?? '').toLowerCase();
        const ya = parseFloat(m.yes_ask_dollars);
        if (ya < 0.01 || ya > 0.99) continue;
        if (t.includes('masters') || t.includes('rory') || t.includes('scheffler') ||
            t.includes('scottie') || t.includes('cameron young') || t.includes('mcilroy')) {
          allMarkets.push({
            ticker: m.ticker, title: m.title, category: 'Golf/Masters',
            yesAsk: m.yes_ask_dollars, noAsk: m.no_ask_dollars,
            closeTime: m.close_time ?? '',
          });
        }
      }
      cursor = data.cursor ?? '';
      if (!cursor || (data.markets ?? []).length < 100) break;
    }
  } catch { /* skip */ }

  // Non-sports — use series tickers (category API is broken)
  const nonSportsSeries = [
    { series: 'KXBTC', label: 'Crypto' },
    { series: 'KXETH', label: 'Crypto' },
    { series: 'KXFED', label: 'Economics' },
    { series: 'KXCPI', label: 'Economics' },
    { series: 'KXGDP', label: 'Economics' },
    { series: 'KXSP', label: 'Finance' },
    { series: 'KXGOLD', label: 'Finance' },
    { series: 'KXNEWPOPE', label: 'Politics' },
    { series: 'KXPRES', label: 'Politics' },
    { series: 'KXSENATE', label: 'Politics' },
    { series: 'KXHOUSE', label: 'Politics' },
  ];
  for (const { series: s, label } of nonSportsSeries) {
    try {
      const data = await kalshiGet(`/markets?series_ticker=${s}&status=open&limit=50`);
      for (const m of data.markets ?? []) {
        if (!m.yes_ask_dollars || !m.no_ask_dollars) continue;
        const ya = parseFloat(m.yes_ask_dollars);
        const na = parseFloat(m.no_ask_dollars);
        if (ya < 0.01 || na < 0.01) continue; // skip resolved/extreme
        allMarkets.push({
          ticker: m.ticker,
          title: m.title,
          category: label,
          yesAsk: m.yes_ask_dollars,
          noAsk: m.no_ask_dollars,
          closeTime: m.close_time ?? '',
        });
      }
    } catch { /* skip */ }
  }

  // Filter: sports use ticker date (close_time is settlement, not game day), non-sports use close_time
  const etNowFilter = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etTmrwFilter = new Date(etNowFilter.getTime() + 24 * 60 * 60 * 1000);
  const toShortFilter = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
  const todayFilter = toShortFilter(etNowFilter);
  const tonightFilter = toShortFilter(etTmrwFilter);
  const maxCloseMs = Date.now() + MAX_DAYS_OUT * 24 * 60 * 60 * 1000;

  const beforeFilter = allMarkets.length;
  for (let i = allMarkets.length - 1; i >= 0; i--) {
    const m = allMarkets[i];
    const isSport = m.category === 'Sports' || m.category === 'Golf/Masters';

    if (isSport) {
      const ticker = m.ticker ?? '';
      const isSoccer = ticker.startsWith('KXEPL') || ticker.startsWith('KXLALIGA') || ticker.startsWith('KXMLS');

      if (isSoccer) {
        // Soccer: allow games within next 3 days (games are scheduled, not daily like US sports)
        const ct = m.closeTime;
        if (ct) {
          const closeMs = Date.parse(ct);
          const threeDaysMs = Date.now() + 3 * 24 * 60 * 60 * 1000;
          if (Number.isFinite(closeMs) && closeMs > threeDaysMs) {
            allMarkets.splice(i, 1);
          }
        }
        // Also skip TIE markets — we only bet on team wins
        // Keep TIE contracts — draw betting is valid for in-game tied soccer
      } else {
        // US Sports: filter by ticker date (today/tonight only)
        if (!ticker.includes(todayFilter) && !ticker.includes(tonightFilter)) {
          allMarkets.splice(i, 1);
        }
      }
    } else {
      // Non-sports: filter by actual close_time
      const ct = m.closeTime;
      if (ct) {
        const closeMs = Date.parse(ct);
        if (Number.isFinite(closeMs) && closeMs > maxCloseMs) {
          allMarkets.splice(i, 1);
        }
      }
    }
  }
  const filtered = beforeFilter - allMarkets.length;
  if (filtered > 0) console.log(`[broad-scan] Filtered ${filtered} markets (sports: not today/tonight, non-sports: >${MAX_DAYS_OUT}d)`);

  if (allMarkets.length === 0) { console.log('[broad-scan] 0 markets found'); return; }

  const sportCount = allMarkets.filter(m => m.category === 'Sports').length;
  const nonSportCount = allMarkets.length - sportCount;
  console.log(`[broad-scan] Found ${allMarkets.length} markets (${sportCount} sports, ${nonSportCount} non-sports)`);

  // Group markets by event for bracket-aware presentation
  const eventGroups = new Map();
  for (const m of allMarkets) {
    // Derive event key: strip the last segment (threshold/team suffix)
    const parts = m.ticker.split('-');
    const lastPart = parts[parts.length - 1];
    // Sports tickers end with team abbrev (3 letters), brackets end with T/B + number
    const isBracket = /^[TB]?\d/.test(lastPart);
    const eventKey = isBracket ? parts.slice(0, -1).join('-') : m.ticker;
    if (!eventGroups.has(eventKey)) eventGroups.set(eventKey, []);
    eventGroups.get(eventKey).push(m);
  }

  // Build compact market list — show brackets together
  const marketLines = [];
  for (const [eventKey, markets] of eventGroups) {
    if (markets.length === 1) {
      // Single market (sports game-winner)
      const m = markets[0];
      marketLines.push(`[${m.category}] ${m.ticker}: "${m.title}" YES=$${m.yesAsk} NO=$${m.noAsk}`);
    } else {
      // Bracket/multi-outcome market — show all thresholds together
      const cat = markets[0].category;
      const baseTitle = markets[0].title.replace(/more than [\d.%-]+/, 'more than X%').replace(/\$[\d,.]+/, '$X');
      marketLines.push(`[${cat}] BRACKET: ${eventKey} — "${baseTitle}" (${markets.length} thresholds):`);
      for (const m of markets) {
        const threshold = m.ticker.split('-').pop();
        marketLines.push(`  ${m.ticker}: YES=$${m.yesAsk} NO=$${m.noAsk}`);
      }
    }
  }
  const marketSummary = marketLines.slice(0, 50).join('\n');

  // Fetch context: news + crypto prices
  let recentNews = '';
  let cryptoPrices = '';
  try {
    const newsRes = await fetch('http://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?limit=3',
      { headers: { 'User-Agent': 'arbor/1' }, signal: AbortSignal.timeout(3000) });
    if (newsRes.ok) {
      const nd = await newsRes.json();
      recentNews = (nd.articles ?? []).slice(0, 3).map(a => a.headline).join('; ');
    }
  } catch { /* skip */ }
  // Fetch BTC/ETH spot prices for crypto market analysis
  try {
    const cryptoRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(3000) });
    if (cryptoRes.ok) {
      const cd = await cryptoRes.json();
      const btc = cd.bitcoin?.usd ?? 0;
      const eth = cd.ethereum?.usd ?? 0;
      if (btc > 0) cryptoPrices = `BTC: $${btc.toLocaleString()} | ETH: $${eth.toLocaleString()}`;
    }
  } catch { /* skip */ }

  // Build list of game base tickers we already have positions on
  const positionBases = new Set();
  for (const p of openPositions) {
    const lastH = p.ticker.lastIndexOf('-');
    if (lastH > 0) positionBases.add(p.ticker.slice(0, lastH));
    positionBases.add(p.ticker);
  }

  // Filter out markets we already have positions on
  const tradeable = allMarkets.filter(m => {
    const lastH = m.ticker.lastIndexOf('-');
    const base = lastH > 0 ? m.ticker.slice(0, lastH) : m.ticker;
    return !positionBases.has(base) && !positionBases.has(m.ticker);
  });

  if (tradeable.length === 0) { console.log('[broad-scan] No tradeable markets (all have positions)'); return; }

  // Dedup sports — same game has 2 tickers (one per team), keep only one
  const seenGameBases = new Set();
  const deduped = [];
  for (const m of tradeable) {
    if (m.category === 'Sports') {
      const lastH = m.ticker.lastIndexOf('-');
      const gameBase = lastH > 0 ? m.ticker.slice(0, lastH) : m.ticker;
      if (seenGameBases.has(gameBase)) continue;
      seenGameBases.add(gameBase);
    }
    deduped.push(m);
  }

  // Sports first so Claude sees today's games, then non-sports
  const sports = deduped.filter(m => m.category === 'Sports');
  const nonSports = deduped.filter(m => m.category !== 'Sports');
  const ordered = [...sports, ...nonSports];

  // Group markets by event for bracket-aware presentation
  const tradeEventGroups = new Map();
  for (const m of ordered) {
    const parts = m.ticker.split('-');
    const lastPart = parts[parts.length - 1];
    const isBracket = /^[TB]?\d/.test(lastPart);
    const eventKey = isBracket ? parts.slice(0, -1).join('-') : m.ticker;
    if (!tradeEventGroups.has(eventKey)) tradeEventGroups.set(eventKey, []);
    tradeEventGroups.get(eventKey).push(m);
  }

  const tradeLines = [];
  for (const [eventKey, markets] of tradeEventGroups) {
    if (markets.length === 1) {
      const m = markets[0];
      tradeLines.push(`[${m.category}] ${m.ticker}: "${m.title}" YES=$${m.yesAsk} NO=$${m.noAsk}`);
    } else {
      const cat = markets[0].category;
      tradeLines.push(`[${cat}] BRACKET EVENT: ${eventKey} (${markets.length} thresholds — CUMULATIVE, pick the best one):`);
      for (const m of markets) {
        tradeLines.push(`  ${m.ticker}: "${m.title}" YES=$${m.yesAsk} NO=$${m.noAsk}`);
      }
    }
  }
  const marketSummaryFiltered = tradeLines.slice(0, 80).join('\n');

  // Ask Claude with web search — strict rules
  try {
    // Use ET date AND next day (games starting at 10pm ET = Apr12 in ticker but Apr11 locally)
    const now = new Date();
    const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etTomorrow = new Date(etNow.getTime() + 24 * 60 * 60 * 1000);
    const toShort = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
    const todayShort = toShort(etNow);
    const tomorrowShort = toShort(etTomorrow);
    const today = etNow.toISOString().slice(0, 10);

    // === STAGE 1: Cheap Haiku screen — find 0-3 candidates ($0.002/call) ===
    const screenPrompt =
      `Scan these prediction markets for potential mispricings. Most are efficient — return [] if nothing looks off.\n\n` +
      `TODAY: ${today} | Sports tickers: ${todayShort}/${tomorrowShort} only\n` +
      (cryptoPrices ? `CRYPTO: ${cryptoPrices}\n` : '') +
      `\n${marketSummaryFiltered}\n\n` +
      `FOCUS on prices in the $0.30-$0.70 range — that's where real edges exist. A team at 55¢ that should be 65¢ is more actionable than a favorite at 93¢.\n` +
      `SKIP: $0.01-$0.05 (lottery tickets), $0.90+ (heavy favorites — usually correct), BTC ranges far from spot, YES+NO≈$1 (bid-ask spread).\n\n` +
      `Return JSON array (max 5): [{"ticker":"exact","reason":"why the price seems wrong"}] or []`;

    const screenText = await claudeScreen(screenPrompt);
    if (!screenText) return;

    let candidates = [];
    try {
      const arrMatch = screenText.match(/\[[\s\S]*\]/);
      if (arrMatch) candidates = JSON.parse(arrMatch[0]);
    } catch { /* not valid JSON */ }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      console.log('[broad-scan] Haiku screen: no candidates');
      logScreen({ stage: 'haiku', result: 'none', marketCount: deduped.length });
      return;
    }
    console.log(`[broad-scan] Haiku found ${candidates.length} candidates: ${candidates.map(c => c.ticker).join(', ')}`);
    logScreen({ stage: 'haiku', result: 'found', candidates, marketCount: deduped.length });

    // === STAGE 2: Sonnet + web search on each candidate ($0.08/call, max 5) ===
    for (const candidate of candidates.slice(0, 5)) {
      const market = deduped.find(m => m.ticker === candidate.ticker);
      if (!market) continue;

      const isSportsMarket = market.category === 'Sports';
      const yesPrice = parseFloat(market.yesAsk);
      const noPrice = parseFloat(market.noAsk);

      const decidePrompt = isSportsMarket
        ? `You are a sports prediction analyst. Predict the outcome of this game.\n\n` +
          `MARKET: ${market.ticker}: "${market.title}"\n` +
          `YES price: ${(yesPrice*100).toFixed(0)}¢ | NO price: ${(noPrice*100).toFixed(0)}¢\n` +
          `Screening note: "${candidate.reason}"\n\n` +
          `RESEARCH: Look up both teams' current records, recent form, injuries.\n\n` +
          `PREDICT: Who wins? How confident are you (0-100%)?\n` +
          `- If confidence ≥ 65% and the side you pick costs ≤ 75¢, BUY\n` +
          `- Pick YES (home team/first team) or NO (away team/second team)\n\n` +
          `Max bet: $${getDynamicMaxTrade().toFixed(2)}\n\n` +
          `JSON ONLY:\n{"trade":false,"confidence":0.XX,"reasoning":"prediction"}\n` +
          `OR {"trade":true,"ticker":"${market.ticker}","side":"yes"/"no","confidence":0.XX,"betAmount":N,"reasoning":"who wins and why"}`
        : `You are a prediction analyst. Evaluate this market.\n\n` +
          `MARKET: ${market.ticker}: "${market.title}"\n` +
          `YES: ${(yesPrice*100).toFixed(0)}¢ | NO: ${(noPrice*100).toFixed(0)}¢\n` +
          `Category: ${market.category}\n` +
          `Screening note: "${candidate.reason}"\n\n` +
          `RESEARCH: Look up current real-world data relevant to this market.\n\n` +
          `PREDICT: What's the true probability? If your confidence differs from the market by 5%+, trade it.\n\n` +
          `Max bet: $${getDynamicMaxTrade().toFixed(2)}\n\n` +
          `JSON ONLY:\n{"trade":false,"confidence":0.XX,"reasoning":"analysis"}\n` +
          `OR {"trade":true,"ticker":"${market.ticker}","side":"yes"/"no","confidence":0.XX,"betAmount":N,"reasoning":"why market is wrong"}`;

      const cText = await claudeWithSearch(decidePrompt, { maxTokens: 800, maxSearches: 3 });
      if (!cText) continue;
      const jsonMatch = cText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      let decision;
      try { decision = JSON.parse(jsonMatch[0]); } catch { continue; }

      if (!decision.trade) {
        console.log(`[broad-scan] Sonnet rejected ${candidate.ticker}: ${decision.reasoning?.slice(0, 100)}`);
        logScreen({ stage: 'sonnet', ticker: candidate.ticker, result: 'rejected', reasoning: decision.reasoning });
        continue;
      }

      // Found a trade — break out to the existing validation logic
      // Inject into the same flow below
      const cTextFinal = JSON.stringify(decision);
      const jsonMatchFinal = cTextFinal.match(/\{[\s\S]*\}/);
      if (!jsonMatchFinal) continue;

      // HARD VALIDATIONS (override Claude)
      const mktValid = deduped.find(m => m.ticker === decision.ticker);
      if (!mktValid) { console.log(`[broad-scan] BLOCKED: invalid ticker ${decision.ticker}`); continue; }

      const isSportsGame = /^KX(MLB|NBA|NFL|NHL)GAME-/i.test(decision.ticker);
      if (isSportsGame && !decision.ticker.includes(todayShort) && !decision.ticker.includes(tomorrowShort)) {
        console.log(`[broad-scan] BLOCKED: wrong date ${decision.ticker}`); continue;
      }

      const lastH = decision.ticker.lastIndexOf('-');
      const base = lastH > 0 ? decision.ticker.slice(0, lastH) : decision.ticker;
      if (positionBases.has(base)) { console.log(`[broad-scan] BLOCKED: position on ${base}`); continue; }

      const price = decision.side === 'yes' ? parseFloat(mktValid.yesAsk) : parseFloat(mktValid.noAsk);
      if (price <= 0.05 || price >= MAX_PRICE) {
        console.log(`[broad-scan] BLOCKED: price ${(price*100).toFixed(0)}¢ outside 5-80¢ range`); continue;
      }

      // Confidence-based gate
      const confidence = decision.confidence ?? decision.probability ?? 0;
      if (confidence < MIN_CONFIDENCE) { console.log(`[broad-scan] Confidence too low: ${(confidence*100).toFixed(0)}%`); continue; }
      if (confidence < price + CONFIDENCE_MARGIN) { console.log(`[broad-scan] Not enough margin: conf=${(confidence*100).toFixed(0)}% vs price=${(price*100).toFixed(0)}¢`); continue; }

      const edge = confidence - price;

      if (kalshiBalance < 3) continue;
      if (Date.now() - (tradeCooldowns.get(decision.ticker) ?? 0) < COOLDOWN_MS) continue;
      if (!canTrade()) continue;
      if (!checkSportExposure(decision.ticker)) continue;

      const maxBet = getPositionSize('kalshi');
      const safeBet = Math.min(decision.betAmount ?? 0, maxBet);
      if (safeBet < 1 || price <= 0) continue;

      const qty = Math.max(1, Math.floor(safeBet / price));
      const priceInCents = Math.round(price * 100);

      console.log(`[broad-scan] 🎯 TRADE: ${mktValid.title} ${decision.side} @${priceInCents}¢ × ${qty} conf=${(confidence*100).toFixed(0)}%`);
      console.log(`  Reason: ${decision.reasoning}`);
      logScreen({ stage: 'sonnet', ticker: decision.ticker, result: 'TRADE', confidence, price, reasoning: decision.reasoning });
      if (!canDeployMore(safeBet)) continue;

      tradeCooldowns.set(decision.ticker, Date.now());
      tradeCooldowns.set(base, Date.now());

      const result = await kalshiPost('/portfolio/orders', {
        ticker: decision.ticker, action: 'buy', side: decision.side, count: qty,
        yes_price: decision.side === 'yes' ? priceInCents : 100 - priceInCents,
      });

      if (result.ok) {
        stats.tradesPlaced++;
        const teamSuffix = decision.ticker.split('-').pop() ?? '';
        const closeMs = Date.parse(mktValid.closeTime);
        const daysOut = Number.isFinite(closeMs) ? Math.ceil((closeMs - Date.now()) / (24*60*60*1000)) : '?';

        logTrade({
          exchange: 'kalshi', strategy: 'claude-prediction',
          ticker: decision.ticker, title: mktValid.title, category: mktValid.category,
          side: decision.side, quantity: qty, entryPrice: price,
          deployCost: qty * price,
          filled: (result.data.order ?? result.data).quantity_filled ?? 0,
          orderId: (result.data.order ?? result.data).order_id ?? null,
          edge: edge * 100, confidence,
          reasoning: decision.reasoning,
          daysOut,
        });

        await tg(
          `🎯 <b>PREDICTION BET — KALSHI</b>\n\n` +
          `<b>${mktValid.title}</b>\n` +
          `Category: ${mktValid.category}\n` +
          `Ticker: <code>${decision.ticker}</code>\n` +
          `Team: <b>${teamSuffix}</b>\n\n` +
          `BUY ${decision.side.toUpperCase()} @ ${(price*100).toFixed(0)}¢ × ${qty} = <b>$${(qty * price).toFixed(2)}</b>\n` +
          `Confidence: <b>${(confidence*100).toFixed(0)}%</b> vs price ${(price*100).toFixed(0)}¢\n` +
          `Potential profit: <b>$${(qty * (1 - price)).toFixed(2)}</b>\n\n` +
          `🧠 <i>${decision.reasoning}</i>`
        );
      }
      break; // placed a trade — don't check more candidates this cycle
    }
  } catch (e) {
    console.error('[broad-scan] error:', e.message);
  }

  // [Polymarket scan removed — integrated into live-edge and pre-game via cross-platform price check]
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Loop
// ─────────────────────────────────────────────────────────────────────────────

async function pollCycle() {
  // Refresh full portfolio (balance + positions)
  await refreshPortfolio();

  // Initialize daily tracking on first cycle
  if (dailyOpenBankroll === 0) resetDailyTracking();

  // Check for midnight ET reset (new trading day)
  const etHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
  if (etHour === 0 && Date.now() - lastHaltCheck > 60 * 60 * 1000) {
    lastHaltCheck = Date.now();
    resetDailyTracking();
    console.log('[risk] New trading day — reset daily limits');
  }

  // Risk check — skip everything if halted
  if (!canTrade()) return;

  // Skip if available cash too low
  const availCash = getAvailableCash('kalshi');
  if (availCash < 3) {
    console.log(`[ai-edge] Available cash $${availCash.toFixed(2)} < $3 (reserve protected) — skipping`);
    return;
  }

  // Pre-game predictions (best entry prices, runs every 10 min)
  await checkPreGamePredictions();

  // UFC predictions (Polymarket only, runs every 30 min)
  await checkUFCPredictions();

  // Live in-game predictions (runs every cycle)
  await checkLiveScoreEdges();

  // Broad market scan — sports + non-sports (runs every 5 min)
  await claudeBroadScan();
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Position Management — game-stage-aware profit-taking, stop-loss, Claude exits
// ─────────────────────────────────────────────────────────────────────────────

// Get game stage and live data for a trade's ticker by matching ESPN scoreboard
async function getGameContext(trade) {
  const ticker = trade.ticker ?? '';
  let league = '';
  if (ticker.includes('MLB')) league = 'mlb';
  else if (ticker.includes('NBA')) league = 'nba';
  else if (ticker.includes('NHL')) league = 'nhl';
  else if (ticker.includes('MLS')) league = 'mls';
  else if (ticker.includes('EPL')) league = 'epl';
  else if (ticker.includes('LALIGA')) league = 'laliga';
  else return null;

  const pathMap = { mlb: 'baseball/mlb', nba: 'basketball/nba', nhl: 'hockey/nhl', mls: 'soccer/usa.1', epl: 'soccer/eng.1', laliga: 'soccer/esp.1' };
  try {
    const res = await fetch(`http://site.api.espn.com/apis/site/v2/sports/${pathMap[league]}/scoreboard`,
      { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();

    // Find the game matching this ticker's teams
    const teamSuffix = ticker.split('-').pop()?.toUpperCase() ?? '';
    for (const ev of data.events ?? []) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const teams = (comp.competitors ?? []).map(c => c.team?.abbreviation ?? '');
      if (!teams.some(t => t === teamSuffix)) continue;

      const period = parseInt(comp.status?.period ?? '0');
      const state = comp.status?.type?.state ?? '';
      const detail = comp.status?.type?.shortDetail ?? '';
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');

      // Determine game stage: early, mid, late, finished
      let stage = 'unknown';
      if (state === 'post') stage = 'finished';
      else if (league === 'mlb') stage = period <= 4 ? 'early' : period <= 6 ? 'mid' : 'late';
      else if (league === 'nba') stage = period <= 2 ? 'early' : period === 3 ? 'mid' : 'late';
      else if (league === 'nhl') stage = period === 1 ? 'early' : period === 2 ? 'mid' : 'late';
      else if (league === 'mls') stage = period === 1 ? 'early' : 'late'; // soccer: 1st half = early, 2nd half = late

      const homeScore = parseInt(home?.score ?? '0');
      const awayScore = parseInt(away?.score ?? '0');
      const diff = Math.abs(homeScore - awayScore);
      const leading = homeScore > awayScore ? home : away;

      // Get win expectancy for current situation
      const baselineWE = getWinExpectancy(league, diff, period, leading?.team?.abbreviation === (home?.team?.abbreviation));

      // Build context string for Claude
      const sit = comp.situation;
      let situationStr = `${away?.team?.abbreviation} ${awayScore} @ ${home?.team?.abbreviation} ${homeScore} | ${detail}`;
      if (sit?.lastPlay?.text) situationStr += ` | Last: ${sit.lastPlay.text}`;
      if (league === 'mlb' && sit) {
        const runners = [sit.onFirst && '1st', sit.onSecond && '2nd', sit.onThird && '3rd'].filter(Boolean);
        if (runners.length > 0 || sit.outs > 0) situationStr += ` | ${sit.outs} outs, runners: ${runners.join(',') || 'none'}`;
        if (sit.pitcher?.athlete?.displayName) situationStr += ` | Pitching: ${sit.pitcher.athlete.displayName} (${sit.pitcher.summary ?? ''})`;
      }

      return { league, stage, period, state, detail: situationStr, homeScore, awayScore, diff, baselineWE, leading: leading?.team?.abbreviation };
    }
  } catch { /* skip */ }
  return null;
}

// Get game-stage-aware thresholds
function getExitThresholds(stage) {
  switch (stage) {
    case 'early':  return { stopLoss: -0.50, claudeStop: -0.30, profitTake: 0.40, scaleOut: 0.40, claudeProfit: [0.15, 0.39] };
    case 'mid':    return { stopLoss: -0.40, claudeStop: -0.25, profitTake: 0.30, scaleOut: 0.30, claudeProfit: [0.10, 0.29] };
    case 'late':   return { stopLoss: -0.30, claudeStop: -0.20, profitTake: 0.20, scaleOut: 0.25, claudeProfit: [0.08, 0.19] };
    default:       return { stopLoss: -0.30, claudeStop: -0.20, profitTake: 0.25, scaleOut: 0.30, claudeProfit: [0.10, 0.24] };
  }
}

async function managePositions() {
  if (!existsSync(TRADES_LOG)) return;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const openTrades = trades.filter(t => t.status === 'open');
    if (openTrades.length === 0) return;

    // Batch fetch current prices
    const kalshiPrices = new Map();
    for (const t of openTrades.filter(t => t.exchange === 'kalshi')) {
      try {
        const data = await kalshiGet(`/markets/${t.ticker}`);
        const m = data.market ?? data;
        if (m.yes_ask_dollars) {
          kalshiPrices.set(t.ticker, {
            yes: parseFloat(m.yes_ask_dollars), no: parseFloat(m.no_ask_dollars),
            yesBid: parseFloat(m.yes_bid_dollars ?? m.yes_ask_dollars),
          });
        }
      } catch { /* skip */ }
    }

    const polyPrices = new Map();
    const polyMoneylines = await getPolyMoneylines();
    for (const pm of polyMoneylines) {
      polyPrices.set(pm.slug, { s0: pm.s0Price, s1: pm.s1Price });
    }

    let anyUpdated = false;

    for (const trade of openTrades) {
      try {
        if (trade.exchange !== 'kalshi') continue; // Can only sell on Kalshi

        const prices = kalshiPrices.get(trade.ticker);
        if (!prices) continue;

        const currentPrice = trade.side === 'yes' ? prices.yes : prices.no;
        const entryPrice = trade.entryPrice ?? 0;
        if (entryPrice <= 0 || currentPrice <= 0) continue;

        const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / entryPrice);
        if (qty <= 0) continue;

        const profitPerContract = currentPrice - entryPrice;
        const pctChange = profitPerContract / entryPrice;

        // Fetch game context (stage, score, ESPN data)
        const ctx = await getGameContext(trade);
        const stage = ctx?.stage ?? 'unknown';
        const thresholds = getExitThresholds(stage);

        // === TIER 1: Rule-based auto-exits (game-stage-aware) ===

        // STOP-LOSS: Dynamic by game stage
        if (pctChange < thresholds.stopLoss) {
          console.log(`[exit] 🛑 STOP-LOSS (${stage}): ${trade.ticker} down ${(pctChange*100).toFixed(0)}% (threshold: ${(thresholds.stopLoss*100).toFixed(0)}%)`);
          const result = await executeSell(trade, qty, currentPrice, 'stop-loss');
          if (result) anyUpdated = true;
          continue;
        }

        // PROFIT-TAKE: Up enough AND price 90¢+ → sell all (game nearly decided)
        if (profitPerContract >= thresholds.profitTake && currentPrice >= 0.90) {
          console.log(`[exit] 💰 PROFIT-TAKE (${stage}): ${trade.ticker} up ${(profitPerContract*100).toFixed(0)}¢ at ${(currentPrice*100).toFixed(0)}¢`);
          const result = await executeSell(trade, qty, currentPrice, 'profit-take');
          if (result) anyUpdated = true;
          continue;
        }

        // SCALE-OUT: Up enough → sell half
        if (profitPerContract >= thresholds.scaleOut && qty >= 2 && currentPrice < 0.90) {
          const halfQty = Math.floor(qty / 2);
          console.log(`[exit] 💰 SCALE-OUT (${stage}): ${trade.ticker} up ${(profitPerContract*100).toFixed(0)}¢ — selling ${halfQty}/${qty}`);
          const result = await executeSell(trade, halfQty, currentPrice, 'scale-out');
          if (result) anyUpdated = true;
          continue;
        }

        // === TIER 2: Claude-assisted exit with game context ===

        // LOSING: Claude evaluates positions in the stop-loss danger zone
        if (pctChange < thresholds.claudeStop && pctChange >= thresholds.stopLoss) {
          const exitCooldownKey = 'exit-loss:' + trade.ticker;
          if (Date.now() - (tradeCooldowns.get(exitCooldownKey) ?? 0) < 15 * 60 * 1000) continue;
          tradeCooldowns.set(exitCooldownKey, Date.now());

          const lossPrompt =
            `You manage a live sports bet that's LOSING. Should you SELL or HOLD?\n\n` +
            `POSITION: Bought ${trade.side?.toUpperCase()} at ${(entryPrice*100).toFixed(0)}¢. Now ${(currentPrice*100).toFixed(0)}¢ (${(pctChange*100).toFixed(0)}% loss).\n` +
            `Game: ${trade.title}\n` +
            `${ctx ? `LIVE: ${ctx.detail}\nGame stage: ${stage.toUpperCase()} | Win expectancy: ${ctx.baselineWE ? (ctx.baselineWE*100).toFixed(0) + '%' : 'unknown'}` : 'No live data available'}\n\n` +
            `A) SELL NOW: Lock in loss of $${Math.abs(qty * profitPerContract).toFixed(2)}. Free capital.\n` +
            `B) HOLD: ${ctx?.baselineWE ? `Win expectancy says ${(ctx.baselineWE*100).toFixed(0)}% — team ${ctx.baselineWE > 0.45 ? 'still has a shot' : 'is in trouble'}.` : 'Unknown situation.'} Risk: could lose full $${(qty * entryPrice).toFixed(2)}.\n\n` +
            `KEY: Is this a normal sports swing (hold) or is the game getting away (sell)?\n\n` +
            `JSON ONLY: {"action": "sell"/"hold", "reasoning": "why"}`;

          const lossText = await claudeScreen(lossPrompt, { maxTokens: 200, timeout: 8000 });
          if (lossText) {
            try {
              const match = lossText.match(/\{[\s\S]*\}/);
              if (match) {
                const d = JSON.parse(match[0]);
                if (d.action === 'sell') {
                  console.log(`[exit] 🧠 CLAUDE STOP: ${trade.ticker} ${(pctChange*100).toFixed(0)}% (${stage}) | ${d.reasoning?.slice(0, 60)}`);
                  const result = await executeSell(trade, qty, currentPrice, 'claude-stop');
                  if (result) anyUpdated = true;
                } else {
                  console.log(`[exit] 🧠 CLAUDE HOLD (losing): ${trade.ticker} ${(pctChange*100).toFixed(0)}% (${stage}) | ${d.reasoning?.slice(0, 60)}`);
                }
              }
            } catch { /* skip */ }
          }
          continue;
        }

        // WINNING: Claude evaluates ambiguous profit-taking
        const [minProfit, maxProfit] = thresholds.claudeProfit;
        if (profitPerContract >= minProfit && profitPerContract < maxProfit && currentPrice < 0.90) {
          const exitCooldownKey = 'exit-profit:' + trade.ticker;
          if (Date.now() - (tradeCooldowns.get(exitCooldownKey) ?? 0) < 15 * 60 * 1000) continue;
          tradeCooldowns.set(exitCooldownKey, Date.now());

          const exitPrompt =
            `You manage a live sports bet that's WINNING. Take profit now or hold for more?\n\n` +
            `POSITION: Bought ${trade.side?.toUpperCase()} at ${(entryPrice*100).toFixed(0)}¢. Now ${(currentPrice*100).toFixed(0)}¢ (+${(profitPerContract*100).toFixed(0)}¢ profit).\n` +
            `Game: ${trade.title}\n` +
            `${ctx ? `LIVE: ${ctx.detail}\nGame stage: ${stage.toUpperCase()} | Win expectancy: ${ctx.baselineWE ? (ctx.baselineWE*100).toFixed(0) + '%' : 'unknown'}` : 'No live data available'}\n\n` +
            `A) SELL ALL: Lock in $${(qty * profitPerContract).toFixed(2)} guaranteed. Capital freed.\n` +
            `B) SELL HALF: Lock in $${(Math.floor(qty/2) * profitPerContract).toFixed(2)}, ride rest.\n` +
            `C) HOLD: If team wins → $${(qty * (1 - entryPrice)).toFixed(2)} max profit. If loses → -$${(qty * entryPrice).toFixed(2)}.\n\n` +
            `${ctx?.baselineWE ? `Win expectancy: ${(ctx.baselineWE*100).toFixed(0)}%. ${ctx.baselineWE > 0.85 ? 'Game is nearly decided — lock profit.' : ctx.baselineWE > 0.65 ? 'Good position but game still competitive.' : 'Game is close — consider holding.'}` : ''}\n\n` +
            `JSON ONLY: {"action": "sell_all"/"sell_half"/"hold", "reasoning": "why"}`;

          const exitText = await claudeScreen(exitPrompt, { maxTokens: 200, timeout: 8000 });
          if (exitText) {
            try {
              const match = exitText.match(/\{[\s\S]*\}/);
              if (match) {
                const d = JSON.parse(match[0]);
                if (d.action === 'sell_all') {
                  console.log(`[exit] 🧠 CLAUDE SELL (${stage}): ${trade.ticker} +${(profitPerContract*100).toFixed(0)}¢ | ${d.reasoning?.slice(0, 60)}`);
                  const result = await executeSell(trade, qty, currentPrice, 'claude-sell');
                  if (result) anyUpdated = true;
                } else if (d.action === 'sell_half' && qty >= 2) {
                  console.log(`[exit] 🧠 CLAUDE HALF (${stage}): ${trade.ticker} +${(profitPerContract*100).toFixed(0)}¢ | ${d.reasoning?.slice(0, 60)}`);
                  const result = await executeSell(trade, Math.floor(qty / 2), currentPrice, 'claude-scale');
                  if (result) anyUpdated = true;
                } else {
                  console.log(`[exit] 🧠 CLAUDE HOLD (${stage}): ${trade.ticker} +${(profitPerContract*100).toFixed(0)}¢ | ${d.reasoning?.slice(0, 60)}`);
                }
              }
            } catch { /* skip */ }
          }
        }

      } catch (e) { console.error(`[exit] error on ${trade.ticker}:`, e.message); }
    }

    if (anyUpdated) {
      writeFileSync(TRADES_LOG, trades.map(t => JSON.stringify(t)).join('\n') + '\n');
    }
  } catch (e) {
    console.error('[exit] error:', e.message);
  }
}

// Execute a sell order on Kalshi and update the trade record
async function executeSell(trade, sellQty, currentPrice, reason) {
  const entryPrice = trade.entryPrice ?? 0;
  const priceInCents = Math.round(currentPrice * 100);

  const result = await kalshiPost('/portfolio/orders', {
    ticker: trade.ticker,
    action: 'sell',
    side: trade.side ?? 'yes',
    count: sellQty,
    // Sell 2¢ below current to ensure fill
    yes_price: trade.side === 'yes' ? Math.max(1, priceInCents - 2) : 100 - Math.max(1, priceInCents - 2),
  });

  if (!result.ok) {
    console.error(`[exit] Sell failed for ${trade.ticker}: ${result.status}`);
    return false;
  }

  const totalQty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / entryPrice);
  const profit = (currentPrice - entryPrice) * sellQty;

  if (sellQty >= totalQty) {
    // Full exit
    trade.status = `sold-${reason}`;
    trade.exitPrice = currentPrice;
    trade.realizedPnL = Math.round(profit * 100) / 100;
    trade.settledAt = new Date().toISOString();
  } else {
    // Partial exit — update quantity and cost, keep open
    const remainQty = totalQty - sellQty;
    trade.quantity = remainQty;
    trade.deployCost = Math.round(remainQty * entryPrice * 100) / 100;
    // Log the partial profit separately
    trade.partialProfitTaken = (trade.partialProfitTaken ?? 0) + Math.round(profit * 100) / 100;
  }

  const profitStr = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`;
  const icon = reason.includes('stop') ? '🛑' : reason.includes('claude') ? '🧠' : '💰';
  const label = reason === 'stop-loss' ? 'STOP-LOSS' : reason === 'profit-take' ? 'PROFIT LOCKED' :
    reason === 'scale-out' ? 'SCALED OUT (half)' : reason === 'claude-sell' ? 'SMART EXIT' :
    reason === 'claude-scale' ? 'SMART SCALE-OUT' : reason.toUpperCase();

  await tg(
    `${icon} <b>${label}</b>\n\n` +
    `<b>${trade.title}</b>\n` +
    `${sellQty < totalQty ? `Sold ${sellQty}/${totalQty} contracts` : `Sold all ${sellQty} contracts`}\n` +
    `Entry: ${(entryPrice*100).toFixed(0)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢\n` +
    `P&L: <b>${profitStr}</b>\n` +
    `${sellQty < totalQty ? `Remaining: ${totalQty - sellQty} contracts still open` : 'Position closed'}`
  );

  logScreen({ stage: 'exit', ticker: trade.ticker, reason, sellQty, totalQty, entryPrice, exitPrice: currentPrice, profit });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement Reconciliation — update trades.jsonl with P&L on closed markets
// ─────────────────────────────────────────────────────────────────────────────

async function checkSettlements() {
  if (!existsSync(TRADES_LOG)) return;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const openTrades = trades.filter(t => t.status === 'open' && t.exchange === 'kalshi');
    if (openTrades.length === 0) return;

    // Fetch closed/settled markets
    let closedMarkets = [];
    for (const status of ['closed', 'settled']) {
      try {
        const data = await kalshiGet(`/markets?status=${status}&limit=100`);
        closedMarkets.push(...(data.markets ?? []));
      } catch { /* skip */ }
    }
    if (closedMarkets.length === 0) return;

    const closedMap = new Map();
    for (const m of closedMarkets) closedMap.set(m.ticker, m);

    let updated = false;
    for (const trade of trades) {
      if (trade.status !== 'open' || trade.exchange !== 'kalshi') continue;
      // Check all market tickers that could match this trade (with team suffixes)
      const market = closedMap.get(trade.ticker);
      if (!market || !market.result) continue;

      // Calculate P&L: if we bought YES and result is 'yes', we win $1/contract
      const won = (trade.side === 'yes' && market.result === 'yes') ||
                  (trade.side === 'no' && market.result === 'no');
      const exitPrice = won ? 1.0 : 0.0;
      // Use quantity (what we ordered), not filled (often 0 from initial API response)
      // The real fill count is deployCost / entryPrice
      const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (trade.entryPrice || 1));
      const proceeds = qty * exitPrice;
      const pnl = proceeds - (trade.deployCost ?? 0);

      trade.status = 'settled';
      trade.exitPrice = exitPrice;
      trade.realizedPnL = Math.round(pnl * 100) / 100;
      trade.settledAt = new Date().toISOString();
      trade.result = market.result;
      updated = true;

      const icon = pnl >= 0 ? '✅' : '❌';
      console.log(`[pnl] SETTLED: ${trade.ticker} ${trade.side} → ${market.result} | P&L: ${icon} $${pnl.toFixed(2)}`);
    }

    if (updated) {
      // Rewrite the file with updated records
      const newContent = trades.map(t => JSON.stringify(t)).join('\n') + '\n';
      writeFileSync(TRADES_LOG, newContent);

      // Update consecutive loss tracking
      updateConsecutiveLosses();

      // Strategy performance check — disable strategies with <40% win rate after 10+ trades
      const stratStats = {};
      for (const t of trades) {
        if (t.status !== 'settled' || !t.strategy) continue;
        if (!stratStats[t.strategy]) stratStats[t.strategy] = { wins: 0, losses: 0, pnl: 0 };
        if (t.realizedPnL >= 0) stratStats[t.strategy].wins++;
        else stratStats[t.strategy].losses++;
        stratStats[t.strategy].pnl += t.realizedPnL ?? 0;
      }
      for (const [strat, s] of Object.entries(stratStats)) {
        const total = s.wins + s.losses;
        const winRate = total > 0 ? s.wins / total : 0;
        if (total >= 10 && winRate < 0.40) {
          console.log(`[risk] ⚠️ Strategy "${strat}" has ${(winRate*100).toFixed(0)}% win rate over ${total} trades (P&L: $${s.pnl.toFixed(2)}). Consider disabling.`);
          await tg(`⚠️ <b>Strategy Alert</b>\n\n"${strat}" has ${(winRate*100).toFixed(0)}% win rate over ${total} trades.\nP&L: $${s.pnl.toFixed(2)}\n\nConsider disabling this strategy.`);
        }
      }
    }
  } catch (e) {
    console.error('[pnl] settlement check error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution Arbs — buy winning sides of settled markets below $1
// ─────────────────────────────────────────────────────────────────────────────

async function checkResolutionArbs() {
  if (kalshiBalance < 2) return;
  if (!canTrade()) return;

  try {
    // Fetch recently closed markets where result is known
    let closedMarkets = [];
    for (const status of ['closed', 'settled']) {
      try {
        const data = await kalshiGet(`/markets?status=${status}&limit=50`);
        closedMarkets.push(...(data.markets ?? []));
      } catch { /* skip */ }
    }

    for (const m of closedMarkets) {
      if (!m.result || !m.ticker) continue;

      // Determine winning side price
      const winSide = m.result; // 'yes' or 'no'
      const winPrice = winSide === 'yes'
        ? parseFloat(m.yes_ask_dollars ?? '1')
        : parseFloat(m.no_ask_dollars ?? '1');

      // If winning side is still < $0.95, there's free money
      if (winPrice >= 0.95 || winPrice <= 0) continue;

      const profit = (1.0 - winPrice);
      const fee = 0.07 * winPrice * (1 - winPrice); // Kalshi parabolic fee
      const netProfit = profit - fee;
      if (netProfit < 0.01) continue; // not worth it after fees

      // Verify with ESPN for sports markets
      const isSportsGame = /^KX(MLB|NBA|NFL|NHL)GAME-/i.test(m.ticker);
      if (isSportsGame) {
        const verified = await verifyESPNResult(m);
        if (!verified) {
          console.log(`[resolve] ESPN verification failed for ${m.ticker}, skipping`);
          continue;
        }
      }

      // Cooldown — don't re-buy same market
      if (Date.now() - (tradeCooldowns.get('res:' + m.ticker) ?? 0) < 60 * 60 * 1000) continue;

      // Resolution arbs are RISK-FREE — size aggressively (up to 50% of cash)
      const resolveCeiling = getTradeCapCeiling();
      const maxBet = Math.min(resolveCeiling, kalshiBalance * 0.50);
      const qty = Math.max(1, Math.floor(maxBet / winPrice));
      const priceInCents = Math.round(winPrice * 100);

      if (!canDeployMore(qty * winPrice)) continue;
      console.log(`[resolve] ARB: ${m.ticker} result=${winSide} winPrice=${priceInCents}¢ netProfit=${(netProfit*100).toFixed(1)}¢/contract × ${qty}`);

      tradeCooldowns.set('res:' + m.ticker, Date.now());
      const result = await kalshiPost('/portfolio/orders', {
        ticker: m.ticker, action: 'buy', side: winSide, count: qty,
        yes_price: winSide === 'yes' ? priceInCents : 100 - priceInCents,
      });

      if (result.ok) {
        stats.tradesPlaced++;
        const deployed = qty * winPrice;

        logTrade({
          exchange: 'kalshi', strategy: 'resolution-arb',
          ticker: m.ticker, title: m.title ?? m.ticker,
          side: winSide, quantity: qty, entryPrice: winPrice,
          deployCost: deployed,
          filled: (result.data.order ?? result.data).quantity_filled ?? 0,
          orderId: (result.data.order ?? result.data).order_id ?? null,
          edge: netProfit * 100,
          reasoning: `Post-result arb: ${winSide} won, buying at ${priceInCents}¢ for guaranteed $1 settlement`,
        });

        await tg(
          `💰 <b>RESOLUTION ARB — KALSHI</b>\n\n` +
          `<b>${m.title ?? m.ticker}</b>\n` +
          `Result: <b>${winSide.toUpperCase()} WON</b>\n\n` +
          `BUY ${winSide.toUpperCase()} @ $${winPrice.toFixed(2)} × ${qty}\n` +
          `Deployed: $${deployed.toFixed(2)}\n` +
          `Guaranteed profit: <b>$${(qty * netProfit).toFixed(2)}</b>\n` +
          `(${(netProfit*100).toFixed(1)}¢/contract after fees)`
        );
      }
    }
  } catch (e) {
    console.error('[resolve] error:', e.message);
  }
}

// ESPN verification for resolution arbs
async function verifyESPNResult(market) {
  const ticker = market.ticker ?? '';
  let league = '';
  if (ticker.includes('MLB')) league = 'baseball/mlb';
  else if (ticker.includes('NBA')) league = 'basketball/nba';
  else if (ticker.includes('NHL')) league = 'hockey/nhl';
  else if (ticker.includes('NFL')) league = 'football/nfl';
  else return true; // non-sports — skip ESPN check

  try {
    const res = await fetch(
      `http://site.api.espn.com/apis/site/v2/sports/${league}/scoreboard`,
      { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return false;
    const data = await res.json();

    // Extract team abbreviations from ticker
    const parts = ticker.split('-');
    const teamSuffix = parts[parts.length - 1]; // e.g., 'NYY' or 'BOS'

    // Look for a completed game with this team
    for (const ev of data.events ?? []) {
      const comp = ev.competitions?.[0];
      if (!comp || comp.status?.type?.state !== 'post') continue;
      const competitors = comp.competitors ?? [];
      const matchesTeam = competitors.some(c =>
        c.team?.abbreviation === teamSuffix
      );
      if (!matchesTeam) continue;

      // Found the game — check winner
      const winner = competitors.find(c => c.winner === true || c.winner === 'true');
      if (!winner) continue;

      const kalshiSaysWin = market.result === 'yes';
      const tickerTeamWon = winner.team?.abbreviation === teamSuffix;

      // If Kalshi says YES won, the ticker team should have won
      if (kalshiSaysWin === tickerTeamWon) return true;

      console.log(`[resolve] ESPN MISMATCH: Kalshi result=${market.result} but ESPN winner=${winner.team?.abbreviation}`);
      return false;
    }

    // Game not found on scoreboard — might be too old, allow it
    return true;
  } catch {
    return false; // fail closed — don't trade if ESPN unreachable
  }
}

function logStats() {
  // Include P&L summary in stats
  let totalPnL = 0;
  let settledCount = 0;
  if (existsSync(TRADES_LOG)) {
    try {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          if (t.status === 'settled' && t.realizedPnL != null) {
            totalPnL += t.realizedPnL;
            settledCount++;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(2)}` : `-$${Math.abs(totalPnL).toFixed(2)}`;
  console.log(`[ai-stats] claude=${stats.claudeCalls} trades=${stats.tradesPlaced} bal=$${kalshiBalance.toFixed(2)} poly=$${polyBalance.toFixed(2)} pnl=${pnlStr} (${settledCount} settled)`);
}

async function main() {
  console.log('=== Arbor AI Edge Trading Bot ===');

  if (!KALSHI_API_KEY || !kalshiPrivateKey) {
    console.error('Missing Kalshi credentials');
    process.exit(1);
  }
  if (!ANTHROPIC_KEY) {
    console.error('Missing ANTHROPIC_API_KEY — Claude is required for edge assessment');
    process.exit(1);
  }

  // Initial portfolio
  try {
    await refreshPortfolio();
  } catch (e) {
    console.error('[ai-edge] Portfolio check failed:', e.message);
  }

  console.log(`Config: MIN_CONF=${(MIN_CONFIDENCE*100).toFixed(0)}% MARGIN=${(CONFIDENCE_MARGIN*100).toFixed(0)}% MAX_PRICE=${(MAX_PRICE*100).toFixed(0)}¢ MAX_TRADE=$${getDynamicMaxTrade().toFixed(2)} BANKROLL=$${getBankroll().toFixed(2)}`);

  // Initial poll, then chain with setTimeout (prevents overlap)
  async function pollLoop() {
    try { await pollCycle(); } catch (e) { console.error('[poll] error:', e.message); }
    setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
  await pollLoop();

  // Stats on a separate non-overlapping chain
  async function statsLoop() {
    logStats();
    setTimeout(statsLoop, 5 * 60 * 1000);
  }
  setTimeout(statsLoop, 5 * 60 * 1000);

  // Settlement reconciliation + resolution arbs — every 5 min
  async function settlementLoop() {
    try { await managePositions(); } catch (e) { console.error('[exit] error:', e.message); }
    try { await checkSettlements(); } catch (e) { console.error('[settlement] error:', e.message); }
    try { await checkResolutionArbs(); } catch (e) { console.error('[resolve] error:', e.message); }
    setTimeout(settlementLoop, 5 * 60 * 1000);
  }
  setTimeout(settlementLoop, 2 * 60 * 1000); // first run after 2 min

  // Daily report — checks every hour, sends at midnight ET
  let lastDailyReport = '';
  async function dailyReportLoop() {
    const etDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const today = etDate.toISOString().slice(0, 10);
    const etHour = etDate.getHours();
    // Send at midnight ET (hour 0) and also at 8pm ET (end of trading day recap)
    if ((etHour === 0 || etHour === 20) && lastDailyReport !== `${today}-${etHour}`) {
      lastDailyReport = `${today}-${etHour}`;
      try { await sendDailyReport(); } catch (e) { console.error('[daily-report] error:', e.message); }
    }
    setTimeout(dailyReportLoop, 30 * 60 * 1000); // check every 30 min
  }
  setTimeout(dailyReportLoop, 5 * 60 * 1000); // first check after 5 min

  // Initialize risk tracking
  resetDailyTracking();

  const bankroll = getBankroll();
  const maxTrade = getDynamicMaxTrade();
  await tg(
    `🧠 <b>AI Edge Bot Started</b>\n\n` +
    `<b>Risk Controls Active:</b>\n` +
    `Max trade: $${maxTrade.toFixed(2)} (10% of bankroll, ceiling $${getTradeCapCeiling()})\n` +
    `Max deploy: ${(getMaxDeployment()*100).toFixed(0)}% ($${(bankroll*getMaxDeployment()).toFixed(2)}) | Positions: ${getMaxPositions()}\n` +
    `Daily loss halt: $${Math.max(10, bankroll * DAILY_LOSS_PCT).toFixed(2)} (${(DAILY_LOSS_PCT*100).toFixed(0)}%)\n` +
    `Reserve: ${(CAPITAL_RESERVE*100).toFixed(0)}% ($${(bankroll*CAPITAL_RESERVE).toFixed(2)}) | Sport cap: $${Math.max(15, bankroll * SPORT_EXPOSURE_PCT).toFixed(2)}\n` +
    `Consecutive loss: ${MAX_CONSECUTIVE_LOSSES}→half size, 8→halt\n\n` +
    `<b>Config:</b>\n` +
    `Min confidence: ${(MIN_CONFIDENCE*100).toFixed(0)}% + ${(CONFIDENCE_MARGIN*100).toFixed(0)}% margin | Cooldown: ${COOLDOWN_MS/60000}min\n` +
    `Model: Haiku screen → Sonnet + web search decide\n` +
    `Broad scan: every ${BROAD_SCAN_INTERVAL/60000}min | Live-edge: every 60s\n\n` +
    `💰 Kalshi: $${kalshiBalance.toFixed(2)} cash + $${kalshiPositionValue.toFixed(2)} positions\n` +
    `💰 Polymarket: $${polyBalance.toFixed(2)}\n` +
    `💰 Total bankroll: <b>$${bankroll.toFixed(2)}</b>`
  );

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await tg('🛑 <b>AI Edge Bot Stopped</b>');
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await tg('🛑 <b>AI Edge Bot Stopped</b>');
    process.exit(0);
  });

  console.log('AI edge bot running. Press Ctrl+C to stop.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
