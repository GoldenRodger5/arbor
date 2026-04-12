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
const CONFIDENCE_MARGIN = 0.05;   // Confidence must exceed price by 5%+
const MAX_PRICE = 0.85;           // Don't buy contracts above 85¢
const MAX_TRADE_FRACTION = 0.10; // 10% of bankroll per trade — base fraction
const POLL_INTERVAL_MS = 60 * 1000; // Check news every 60 seconds
const COOLDOWN_MS = 15 * 60 * 1000; // 15 min — allows scaling into winners
const MAX_DAYS_OUT = 1;            // Same-day only — capital turns over nightly
const CLAUDE_SCREENER = 'claude-haiku-4-5-20251001';  // Cheap screening — $0.002/call
const CLAUDE_DECIDER = 'claude-sonnet-4-6';            // Expensive analysis — only on candidates
// MAX_POSITIONS and deployment limits are DYNAMIC — see getMaxPositions() and getMaxDeployment()
const DAILY_LOSS_PCT = 0.15;       // Stop trading if down 15% in a day (room for 2-3 bad trades)
const CAPITAL_RESERVE = 0.05;      // Keep 5% of bankroll untouched (more capital working)
const MAX_CONSECUTIVE_LOSSES = 5;  // After 5 losses → reduce size (3 was too tight)
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
  return openPositions.reduce((sum, p) => sum + (p.cost ?? 0), 0);
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
  if (consecutiveLosses >= 8) {
    tradingHalted = true;
    haltReason = `8 consecutive losses — full halt, something is wrong`;
    tg(`🛑 <b>TRADING HALTED</b>\n\n${haltReason}`);
    console.log(`[risk] ${haltReason}`);
    return false;
  }

  return true;
}

function getPositionSize(exchange = 'kalshi') {
  let size = getDynamicMaxTrade(exchange);

  // Reduce size after consecutive losses — half size, not a fixed floor
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

// [getPortfolioSummary removed — was only used by dead news-edge pipeline]

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
      if (diff === 0) continue;
      const leading = homeScore > awayScore ? home : away;
      const detail = comp.status?.type?.shortDetail ?? '';
      liveGames.push({ league, comp, ev, home, away, homeScore, awayScore, diff, period, leading, detail });
    }
  }

  if (liveGames.length === 0) return;

  // === PHASE 2: Haiku batch screen — pick best 2 games to analyze ===
  const gameSummaries = liveGames.slice(0, 15).map((g, i) => {
    const homeRec = g.home.records?.[0]?.summary ?? '?';
    const awayRec = g.away.records?.[0]?.summary ?? '?';
    return `${i+1}. [${g.league.toUpperCase()}] ${g.away.team?.abbreviation}(${awayRec}) ${g.awayScore} @ ${g.home.team?.abbreviation}(${homeRec}) ${g.homeScore} | ${g.detail}`;
  }).join('\n');

  const screenText = await claudeScreen(
    `Pick up to 2 live games where you're most confident predicting the winner. Consider: score, inning/period, team records, home advantage.\n\n` +
    `LIVE GAMES:\n${gameSummaries}\n\n` +
    `Pick games where the leading team's price might be ≤ 80¢ (early leads, close games, not blowouts already priced at 95¢+).\n\n` +
    `JSON array: [{"index":N,"team":"ABR","reason":"one line"}] or []`
  );

  let haikuPicks = [];
  try {
    const arr = screenText?.match(/\[[\s\S]*\]/);
    if (arr) haikuPicks = JSON.parse(arr[0]);
  } catch { /* bad json */ }

  if (!Array.isArray(haikuPicks) || haikuPicks.length === 0) {
    console.log(`[live-edge] Haiku: no picks from ${liveGames.length} live games`);
    return;
  }
  console.log(`[live-edge] Haiku picked ${haikuPicks.length} from ${liveGames.length} live games: ${haikuPicks.map(p => p.team).join(', ')}`);

  // === PHASE 3: Only analyze Haiku's picks with Sonnet (saves 80%+ API cost) ===
  for (const pick of haikuPicks.slice(0, 2)) {
    const idx = (pick.index ?? 1) - 1;
    if (idx < 0 || idx >= liveGames.length) continue;
    const { league, comp, home, away, homeScore, awayScore, diff, period, leading, detail: gameDetail } = liveGames[idx];
    const series = league === 'mlb' ? 'KXMLBGAME' : league === 'nba' ? 'KXNBAGAME' : 'KXNHLGAME';

    try {
        const homeAbbr = home.team?.abbreviation ?? '';
        const awayAbbr = away.team?.abbreviation ?? '';
        if (!homeAbbr || !awayAbbr) continue;
        console.log(`[live-edge] Sonnet analyzing: ${away.team?.displayName} (${awayAbbr}) ${awayScore} @ ${home.team?.displayName} (${homeAbbr}) ${homeScore} (${gameDetail})`);

        // Get today/tonight Kalshi markets — pre-filter to THIS game's teams + today's date
        const etNowLE = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const etTmrwLE = new Date(etNowLE.getTime() + 24 * 60 * 60 * 1000);
        const toShortLE = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
        const todayStr = toShortLE(etNowLE);
        const tonightStr = toShortLE(etTmrwLE);

        const params = new URLSearchParams({ series_ticker: series, status: 'open', limit: '100' });
        const mkts = await kalshiGet(`/markets?${params}`);

        // Filter to ONLY markets for THIS game: must contain team abbreviation AND today's date
        const gameMarkets = (mkts.markets ?? []).filter(m => {
          if (!m.yes_ask_dollars || !m.no_ask_dollars) return false;
          const ya = parseFloat(m.yes_ask_dollars);
          const na = parseFloat(m.no_ask_dollars);
          if (ya < 0.01 || ya > 0.99 || na < 0.01 || na > 0.99) return false;
          const ticker = m.ticker ?? '';
          // Must be today or tonight
          if (!ticker.includes(todayStr) && !ticker.includes(tonightStr)) return false;
          // Must match BOTH playing teams (ticker contains both abbreviations)
          const upperTicker = ticker.toUpperCase();
          const hasHome = upperTicker.includes(homeAbbr);
          const hasAway = upperTicker.includes(awayAbbr);
          return hasHome && hasAway;
        });

        if (gameMarkets.length === 0) {
          console.log(`[live-edge] No Kalshi market found for ${awayAbbr}@${homeAbbr} on ${todayStr}/${tonightStr}`);
          continue;
        }

        // Check BOTH sides — leading team AND trailing team (underdog value)
        const leadingAbbr = leading.team?.abbreviation ?? '';
        const trailing = homeScore > awayScore ? away : home;
        const trailingAbbr = trailing.team?.abbreviation ?? '';

        // Find markets for both teams
        const leadMarket = gameMarkets.find(m => m.ticker?.toUpperCase().endsWith('-' + leadingAbbr));
        const trailMarket = gameMarkets.find(m => m.ticker?.toUpperCase().endsWith('-' + trailingAbbr));

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

        // Live situation (runners, outs)
        let situationInfo = '';
        const sit = comp.situation;
        if (sit) {
          const runners = [sit.onFirst && '1st', sit.onSecond && '2nd', sit.onThird && '3rd'].filter(Boolean);
          situationInfo = `Outs: ${sit.outs ?? '?'} | Runners: ${runners.length > 0 ? runners.join(', ') : 'none'}`;
        }

        // Team stats
        const homeAvg = home.statistics?.find(s => s.abbreviation === 'AVG')?.displayValue ?? '';
        const awayAvg = away.statistics?.find(s => s.abbreviation === 'AVG')?.displayValue ?? '';

        // Line score
        const homeLineScore = (home.linescores ?? []).map(l => l.displayValue).join(' ');
        const awayLineScore = (away.linescores ?? []).map(l => l.displayValue).join(' ');

        const livePrompt =
          `You are a professional sports bettor. Predict who wins this game based on ALL the data below.\n\n` +
          `═══ LIVE ${league.toUpperCase()} GAME ═══\n` +
          `${away.team?.displayName} (${awayRecord}${awayRoadRec ? ', ' + awayRoadRec + ' away' : ''}) ${awayScore}\n` +
          `  at\n` +
          `${home.team?.displayName} (${homeRecord}${homeHomeRec ? ', ' + homeHomeRec + ' home' : ''}) ${homeScore}\n\n` +
          `Status: ${gameDetail}\n` +
          `Line score: ${awayAbbr} [${awayLineScore}] | ${homeAbbr} [${homeLineScore}]\n` +
          (situationInfo ? `Situation: ${situationInfo}\n` : '') +
          (pitcherInfo ? `\n${pitcherInfo}` : '') +
          (homeAvg || awayAvg ? `Team batting: ${homeAbbr} ${homeAvg} | ${awayAbbr} ${awayAvg}\n` : '') +
          `\n═══ MARKET ═══\n` +
          `${targetAbbr} YES @ ${(price*100).toFixed(0)}¢ → pay ${(price*100).toFixed(0)}¢, win $1.00 if ${targetTeam.team?.displayName} wins\n` +
          `${targetAbbr === leadingAbbr ? '(LEADING team' : '(TRAILING team — underdog value?'}${targetAbbr === homeAbbr ? ', HOME)' : ', AWAY)'}\n\n` +
          `═══ YOUR JOB ═══\n` +
          `Use web search ONLY if you need additional context (recent injuries, streaks).\n\n` +
          `Based on: score, game stage, team records, home/away, pitching — how confident are you ${targetTeam.team?.displayName} wins?\n` +
          `${targetAbbr !== leadingAbbr ? 'NOTE: This team is BEHIND. Only bet if you believe they come back (early game, better team, weak opposing bullpen).\n' : ''}\n` +
          `BUY RULE: confidence ≥ 65% AND at least 5 points above price.\n` +
          `Example: 72% confident + 60¢ price = BUY. 68% confident + 65¢ = PASS.\n\n` +
          `Max bet: $${getDynamicMaxTrade().toFixed(2)}\n\n` +
          `JSON ONLY:\n` +
          `{"trade": false, "confidence": 0.XX, "reasoning": "who wins and why not buying"}\n` +
          `OR {"trade": true, "side": "yes", "confidence": 0.XX, "betAmount": N, "reasoning": "why ${leadingAbbr} wins"}`;
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
          if (p.exchange === 'polymarket' && pt.includes(ha) && pt.includes(aa)) return true;
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
        const cText = await claudeWithSearch(livePrompt);
        if (!cText) continue;
        const jsonMatch = cText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        let decision;
        try { decision = JSON.parse(jsonMatch[0]); } catch { continue; }

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
          console.log(`[live-edge] Not enough margin: conf=${(confidence*100).toFixed(0)}% vs price=${(price*100).toFixed(0)}¢ (need 5%+ gap)`);
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

        const maxBetLE = getPositionSize(best.platform);
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
const PREGAME_SCAN_INTERVAL = 10 * 60 * 1000; // every 10 min

async function checkPreGamePredictions() {
  if (Date.now() - lastPreGameScan < PREGAME_SCAN_INTERVAL) return;
  lastPreGameScan = Date.now();
  if (!canTrade()) return;

  const sportsSeries = ['KXMLBGAME', 'KXNBAGAME', 'KXNHLGAME'];
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
    `You are a sports handicapper. Pick up to 3 games where you have a strong opinion on who wins.\n\n` +
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
  for (const pick of picks.slice(0, 3)) {
    const market = preGameMarkets.find(m => m.ticker === pick.ticker);
    if (!market) continue;

    const price = pick.side === 'yes' ? market.yesAsk : market.noAsk;
    if (price > MAX_PRICE || price < 0.05) continue;

    const decideText = await claudeWithSearch(
      `You are a professional sports bettor. Make a prediction on this game.\n\n` +
      `GAME: ${market.title}\n` +
      `Ticker: ${market.ticker}\n` +
      `YES price: ${(market.yesAsk*100).toFixed(0)}¢ | NO price: ${(market.noAsk*100).toFixed(0)}¢\n` +
      `Haiku's pick: ${pick.side.toUpperCase()} — "${pick.reason}"\n\n` +
      `RESEARCH: Look up both teams' records, starting pitchers (MLB), injury reports, recent form.\n\n` +
      `PREDICT: How confident are you in ${pick.side.toUpperCase()}? Consider:\n` +
      `- Team records and quality\n` +
      `- Home/away advantage\n` +
      `- Starting pitchers / key players\n` +
      `- Recent form (last 5 games)\n\n` +
      `BUY if confidence ≥ 65% AND at least 5 points above price.\n` +
      `Max bet: $${getDynamicMaxTrade().toFixed(2)}\n\n` +
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
    const pgSport = market.ticker.includes('MLB') ? 'mlb' : market.ticker.includes('NBA') ? 'nba' : market.ticker.includes('NHL') ? 'nhl' : '';
    const pgPolyMarkets = await getPolyMoneylines();
    const pgPolyMatch = findPolyMarketForGame(team1, team2, pgPolyMarkets, pgSport);
    // The team we want is in the ticker suffix (e.g., -PIT or -CHC)
    const pgTargetTeam = market.ticker.split('-').pop() ?? '';
    const pgBest = pickBestPlatform(pick.side, price, pgPolyMatch, pgTargetTeam);

    const bestPrice = pgBest.price;
    const edge = confidence - bestPrice;
    if (edge < CONFIDENCE_MARGIN) continue;

    const maxBet = getPositionSize(pgBest.platform);
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
    { name: 'Sports', series: ['KXMLBGAME', 'KXNBAGAME', 'KXNHLGAME'] },
    { name: 'Crypto', keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto'] },
    { name: 'Economics', keywords: ['cpi', 'fed', 'gdp', 'jobs', 'inflation', 'rate'] },
  ];

  const allMarkets = [];

  // Sports — game-winners + additional sports series
  const sportsSeries = [...categories[0].series, 'KXMLSGAME', 'KXNFLGAME'];
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
      // Sports: filter by ticker date (game date), not close_time (settlement date)
      const ticker = m.ticker ?? '';
      if (!ticker.includes(todayFilter) && !ticker.includes(tonightFilter)) {
        allMarkets.splice(i, 1);
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
      `Return JSON array (max 3): [{"ticker":"exact","reason":"why the price seems wrong"}] or []`;

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

    // === STAGE 2: Sonnet + web search on each candidate ($0.08/call, max 3) ===
    for (const candidate of candidates.slice(0, 3)) {
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

  // Live in-game predictions (runs every cycle)
  await checkLiveScoreEdges();

  // Broad market scan — sports + non-sports (runs every 5 min)
  await claudeBroadScan();
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Stop-Loss — sell positions that have dropped >30% from entry
// ─────────────────────────────────────────────────────────────────────────────

async function checkStopLosses() {
  if (!existsSync(TRADES_LOG)) return;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    // Check both Kalshi and Poly open trades
    const openTrades = trades.filter(t => t.status === 'open');
    if (openTrades.length === 0) return;

    // Batch fetch Kalshi prices — one call instead of N
    let kalshiPrices = new Map();
    const kalshiTickers = openTrades.filter(t => t.exchange === 'kalshi').map(t => t.ticker);
    if (kalshiTickers.length > 0) {
      for (const ticker of kalshiTickers) {
        try {
          const data = await kalshiGet(`/markets/${ticker}`);
          const m = data.market ?? data;
          if (m.yes_ask_dollars) {
            kalshiPrices.set(ticker, { yes: parseFloat(m.yes_ask_dollars), no: parseFloat(m.no_ask_dollars) });
          }
        } catch { /* skip */ }
      }
    }

    // Fetch Poly prices from cached moneylines
    const polyPrices = new Map();
    const polyMoneylines = await getPolyMoneylines();
    for (const pm of polyMoneylines) {
      polyPrices.set(pm.slug, { s0: pm.s0Price, s1: pm.s1Price });
    }

    for (const trade of openTrades) {
      try {
        let currentPrice = null;

        if (trade.exchange === 'kalshi') {
          const prices = kalshiPrices.get(trade.ticker);
          if (!prices) continue;
          currentPrice = trade.side === 'yes' ? prices.yes : prices.no;
        } else if (trade.exchange === 'polymarket') {
          const prices = polyPrices.get(trade.ticker);
          if (!prices) continue;
          // Use whichever side matches (long=s0, short=s1)
          currentPrice = trade.side === 'long' || trade.side === 'yes' ? prices.s0 : prices.s1;
        }
        if (!currentPrice) continue;

        const entryPrice = trade.entryPrice ?? 0;
        if (entryPrice <= 0) continue;

        const pctChange = (currentPrice - entryPrice) / entryPrice;

        // Stop-loss: if position dropped >30% from entry, sell (Kalshi only — Poly settles at expiry)
        if (pctChange < -0.30) {
          const qty = trade.filled ?? trade.quantity ?? 0;
          if (qty <= 0) continue;

          console.log(`[stop-loss] 🛑 ${trade.ticker} on ${trade.exchange} dropped ${(pctChange*100).toFixed(0)}% (${entryPrice.toFixed(2)}→${currentPrice.toFixed(2)})`);

          if (trade.exchange === 'polymarket') {
            // Polymarket doesn't support selling — just alert
            await tg(`⚠️ <b>POLY POSITION DOWN ${(pctChange*100).toFixed(0)}%</b>\n${trade.title}\nEntry: ${(entryPrice*100).toFixed(0)}¢ → Now: ${(currentPrice*100).toFixed(0)}¢`);
            continue;
          }

          const priceInCents = Math.round(currentPrice * 100);
          const result = await kalshiPost('/portfolio/orders', {
            ticker: trade.ticker,
            action: 'sell',
            side: trade.side ?? 'yes',
            count: qty,
            yes_price: trade.side === 'yes' ? Math.max(1, priceInCents - 2) : 100 - Math.max(1, priceInCents - 2),
          });

          if (result.ok) {
            const loss = (currentPrice - entryPrice) * qty;
            trade.status = 'sold-stoploss';
            trade.exitPrice = currentPrice;
            trade.realizedPnL = Math.round(loss * 100) / 100;
            trade.settledAt = new Date().toISOString();

            await tg(
              `🛑 <b>STOP-LOSS TRIGGERED</b>\n\n` +
              `<b>${trade.title}</b>\n` +
              `Sold ${trade.side?.toUpperCase()} @ ${(currentPrice*100).toFixed(0)}¢ × ${qty}\n` +
              `Entry: ${(entryPrice*100).toFixed(0)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢\n` +
              `Loss: <b>$${Math.abs(loss).toFixed(2)}</b> (${(pctChange*100).toFixed(0)}%)`
            );
          }
        }
      } catch { /* skip individual ticker check failures */ }
    }

    // Rewrite trades log if any were updated
    const updated = trades.some(t => t.status === 'sold-stoploss' && !t._saved);
    if (updated) {
      writeFileSync(TRADES_LOG, trades.map(t => JSON.stringify(t)).join('\n') + '\n');
    }
  } catch (e) {
    console.error('[stop-loss] error:', e.message);
  }
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
      const filled = trade.filled ?? trade.quantity ?? 0;
      const proceeds = filled * exitPrice;
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
    try { await checkStopLosses(); } catch (e) { console.error('[stop-loss] error:', e.message); }
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
