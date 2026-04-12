/**
 * Arbor AI Edge Trading Bot
 *
 * Uses Claude to analyze real-time sports news (injuries, lineup changes,
 * weather) and place directional bets on Kalshi when the market hasn't
 * repriced yet.
 *
 * Pipeline (runs every 2 minutes):
 *   1. Fetch latest news/injuries from ESPN for MLB, NBA, NHL
 *   2. Match news items to active Kalshi game-winner markets
 *   3. Ask Claude: "Does this news materially change the probability?
 *      If yes, which direction, and by how much?"
 *   4. If Claude says edge > 5% and market price hasn't adjusted,
 *      place a directional bet
 *   5. Size by Kelly criterion on the estimated edge
 *
 * Key advantage: Claude processes injury reports in <2 seconds.
 * Markets often take 5-30 minutes to reprice after news breaks.
 *
 * Run: node ai-edge.mjs
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
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

const MIN_EDGE = 0.07;           // 7% edge minimum — consistent across ALL strategies
const MIN_EDGE_PCT = 7;          // same × 100 for display
const MAX_TRADE_FRACTION = 0.10; // 10% of bankroll per trade — base fraction
const POLL_INTERVAL_MS = 60 * 1000; // Check news every 60 seconds
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown per market (was 15 — too short)
const MAX_DAYS_OUT = 1;            // Same-day only — capital turns over nightly
const CLAUDE_MODEL = 'claude-sonnet-4-6';
// MAX_POSITIONS and deployment limits are DYNAMIC — see getMaxPositions() and getMaxDeployment()
const DAILY_LOSS_PCT = 0.05;       // Stop trading if down 5% in a day (scales with bankroll)
const CAPITAL_RESERVE = 0.10;      // Always keep 10% of bankroll untouched
const MAX_CONSECUTIVE_LOSSES = 3;  // After 3 losses → reduce size + wait
const SPORT_EXPOSURE_PCT = 0.08;   // Max 8% of bankroll deployed on same sport per day

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
        model: CLAUDE_MODEL,
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
const seenNewsIds = new Map();    // id → timestamp (pruned every cycle)
let kalshiBalance = 0;
let kalshiPositionValue = 0;
let openPositions = [];  // fetched each cycle
let stats = { newsChecked: 0, claudeCalls: 0, edgesFound: 0, tradesPlaced: 0 };

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
  if (b < 500) return 8;
  if (b < 2000) return 12;
  if (b < 10000) return 15;
  if (b < 50000) return 20;
  return 25;
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
    haltReason = `Daily loss limit hit: $${Math.abs(dailyPnL).toFixed(2)} lost today (limit: $${dailyLossLimit.toFixed(2)} = 5% of $${dailyOpenBankroll.toFixed(2)})`;
    tg(`🛑 <b>TRADING HALTED</b>\n\n${haltReason}\n\nBot will resume tomorrow.`);
    console.log(`[risk] ${haltReason}`);
    return false;
  }

  // Check max positions (dynamic)
  const maxPos = getMaxPositions();
  if (openPositions.length >= maxPos) {
    console.log(`[risk] Max positions reached: ${openPositions.length}/${maxPos}`);
    return false;
  }

  // Check consecutive losses (reduce size, don't halt until 5)
  if (consecutiveLosses >= 5) {
    tradingHalted = true;
    haltReason = `5 consecutive losses — full halt for safety`;
    tg(`🛑 <b>TRADING HALTED</b>\n\n${haltReason}`);
    console.log(`[risk] ${haltReason}`);
    return false;
  }

  return true;
}

function getPositionSize(exchange = 'kalshi') {
  let size = getDynamicMaxTrade(exchange);

  // Reduce size after consecutive losses
  if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    size = Math.min(size, 2); // Drop to $2 max after 3 losses
    console.log(`[risk] Reduced position size to $${size.toFixed(2)} after ${consecutiveLosses} consecutive losses`);
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

async function refreshPortfolio() {
  try {
    const bal = await kalshiGet('/portfolio/balance');
    kalshiBalance = (bal.balance ?? 0) / 100;
    kalshiPositionValue = (bal.portfolio_value ?? 0) / 100;
  } catch { /* keep old */ }

  // Fetch open positions
  try {
    const data = await kalshiGet('/portfolio/positions');
    openPositions = (data.event_positions ?? data.market_positions ?? data.positions ?? []).map(p => ({
      ticker: p.event_ticker ?? p.ticker ?? p.market_ticker ?? '',
      cost: parseFloat(p.total_cost_dollars ?? '0'),
    })).filter(p => p.cost > 0);
  } catch { openPositions = []; }

  // Also refresh Poly balance
  await refreshPolyBalance();

  console.log(`[portfolio] Kalshi: $${kalshiBalance.toFixed(2)} cash + $${kalshiPositionValue.toFixed(2)} positions | Poly: $${polyBalance.toFixed(2)} | Open: ${openPositions.length}`);
}

function getPortfolioSummary() {
  const total = kalshiBalance + kalshiPositionValue + polyBalance;
  return `KALSHI — Cash: $${kalshiBalance.toFixed(2)}, Positions: $${kalshiPositionValue.toFixed(2)}\n` +
    `POLYMARKET — Balance: $${polyBalance.toFixed(2)}\n` +
    `TOTAL: $${total.toFixed(2)}\n` +
    `Open Kalshi positions: ${openPositions.length}` +
    (openPositions.length > 0 ? '\n' + openPositions.map(p =>
      `  ${p.ticker}: $${p.cost.toFixed(2)}`
    ).join('\n') : '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Fetch ESPN News & Injuries
// ─────────────────────────────────────────────────────────────────────────────

async function fetchESPNNews() {
  const items = [];
  const sports = [
    { league: 'mlb', path: 'baseball/mlb' },
    { league: 'nba', path: 'basketball/nba' },
    { league: 'nhl', path: 'hockey/nhl' },
  ];

  for (const { league, path } of sports) {
    // News headlines
    try {
      const res = await fetch(
        `http://site.api.espn.com/apis/site/v2/sports/${path}/news?limit=10`,
        { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) {
        const data = await res.json();
        for (const article of data.articles ?? []) {
          const id = article.id ?? article.headline;
          if (seenNewsIds.has(id)) continue;
          // Only care about recent articles (last 30 minutes)
          const published = Date.parse(article.published ?? '');
          if (!Number.isFinite(published) || Date.now() - published > 30 * 60 * 1000) continue;
          seenNewsIds.set(id, Date.now());
          items.push({
            league,
            type: 'news',
            headline: article.headline ?? '',
            description: article.description ?? '',
            published: article.published ?? '',
            teams: extractTeamNames(article.headline + ' ' + (article.description ?? '')),
          });
        }
      }
    } catch { /* silent */ }

    // Injury updates from scoreboard (today's games)
    try {
      const res = await fetch(
        `http://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`,
        { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) {
        const data = await res.json();
        for (const ev of data.events ?? []) {
          const comp = ev.competitions?.[0];
          if (!comp) continue;
          // Check for injury/status notes
          for (const c of comp.competitors ?? []) {
            const injuries = c.injuries ?? [];
            for (const inj of injuries) {
              const id = `inj-${c.team?.abbreviation}-${inj.id ?? inj.athlete?.id}`;
              if (seenNewsIds.has(id)) continue;
              seenNewsIds.set(id, Date.now());
              const status = inj.status ?? inj.type?.name ?? '';
              if (status === 'Active') continue; // not newsworthy
              items.push({
                league,
                type: 'injury',
                headline: `${inj.athlete?.displayName ?? 'Player'} (${c.team?.displayName ?? ''}) — ${status}`,
                description: `${inj.details?.detail ?? ''} ${inj.details?.side ?? ''} ${inj.details?.type ?? ''}`.trim(),
                published: new Date().toISOString(),
                teams: [c.team?.displayName?.toLowerCase() ?? ''],
              });
            }
          }
        }
      }
    } catch { /* silent */ }
  }

  return items;
}

function extractTeamNames(text) {
  const lower = text.toLowerCase();
  const teams = [];
  // Common team names — just check if they appear
  const knownTeams = [
    'yankees', 'mets', 'dodgers', 'braves', 'astros', 'cubs', 'red sox',
    'phillies', 'padres', 'mariners', 'guardians', 'orioles', 'rays',
    'twins', 'tigers', 'royals', 'athletics', 'angels', 'reds', 'cardinals',
    'pirates', 'brewers', 'nationals', 'marlins', 'rockies', 'giants',
    'diamondbacks', 'rangers', 'blue jays', 'white sox',
    'celtics', 'knicks', 'lakers', 'warriors', 'nuggets', 'bucks', 'heat',
    'suns', 'cavaliers', 'thunder', 'mavericks', 'rockets', 'clippers',
    'hawks', 'bulls', 'nets', 'pacers', 'kings', 'pelicans', 'grizzlies',
    'spurs', 'timberwolves', 'blazers', 'jazz', 'hornets', 'pistons',
    'wizards', 'raptors', 'magic', 'sixers',
    'bruins', 'lightning', 'panthers', 'hurricanes', 'rangers', 'islanders',
    'penguins', 'capitals', 'senators', 'maple leafs', 'canadiens',
    'jets', 'stars', 'avalanche', 'wild', 'blues', 'predators',
    'golden knights', 'oilers', 'flames', 'canucks', 'kraken', 'ducks',
    'sharks', 'blackhawks', 'red wings', 'sabres', 'devils', 'flyers',
  ];
  for (const t of knownTeams) {
    if (lower.includes(t)) teams.push(t);
  }
  return teams;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Find matching Kalshi markets
// ─────────────────────────────────────────────────────────────────────────────

async function findMatchingMarkets(newsItem) {
  const series = newsItem.league === 'mlb' ? 'KXMLBGAME'
               : newsItem.league === 'nba' ? 'KXNBAGAME'
               : 'KXNHLGAME';
  try {
    const params = new URLSearchParams({ series_ticker: series, status: 'open', limit: '100' });
    const data = await kalshiGet(`/markets?${params}`);
    const matches = [];
    for (const m of data.markets ?? []) {
      const title = (m.title ?? '').toLowerCase();
      // Check if any team from the news appears in the market title
      for (const team of newsItem.teams) {
        if (title.includes(team) || team.split(' ').some(w => w.length > 3 && title.includes(w))) {
          matches.push({
            ticker: m.ticker,
            title: m.title,
            yesAsk: m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : null,
            noAsk: m.no_ask_dollars ? parseFloat(m.no_ask_dollars) : null,
            yesBid: m.yes_bid_dollars ? parseFloat(m.yes_bid_dollars) : null,
          });
          break;
        }
      }
    }
    return matches;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Ask Claude for edge assessment
// ─────────────────────────────────────────────────────────────────────────────

async function assessEdge(newsItem, market) {
  if (!ANTHROPIC_KEY) return null;

  const prompt = `You are a sports prediction market trader managing a real portfolio.

MY PORTFOLIO:
${getPortfolioSummary()}

NEWS:
Type: ${newsItem.type}
League: ${newsItem.league.toUpperCase()}
Headline: ${newsItem.headline}
Details: ${newsItem.description}

MARKET:
Title: ${market.title}
Current YES price: $${market.yesAsk?.toFixed(2) ?? 'unknown'}
Current NO price: $${market.noAsk?.toFixed(2) ?? 'unknown'}

RESEARCH FIRST: Use web search to look up CURRENT information before deciding:
- Both teams' current win-loss records and standings
- Recent form (last 5-10 games)
- Key injuries or lineup changes
- Head-to-head record this season
Your probability MUST be grounded in real data you find, not assumptions.

QUESTION: Does this news materially change the probability of this game's outcome? If so:
1. Which side benefits (YES or NO)?
2. What should the fair probability be after this news?
3. What is the edge (difference between fair prob and current market price)?

IMPORTANT: Do NOT bet on heavy underdogs (market price below $0.25) unless your research reveals a SPECIFIC concrete reason (e.g., star player injury on favorite, confirmed rest day). "Upset potential" alone is NOT an edge.

Respond in JSON only:
{
  "hasEdge": true/false,
  "side": "yes" or "no",
  "fairProbability": 0.XX,
  "currentPrice": 0.XX,
  "edgePct": X.X,
  "confidence": "high"/"medium"/"low",
  "reasoning": "one sentence citing specific facts from your research"
}

If the news doesn't meaningfully change the probability (e.g. minor roster move, already priced in, not relevant to this game), return {"hasEdge": false}.`;

  try {
    const text = await claudeWithSearch(prompt);
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[claude] error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Execute trade
// ─────────────────────────────────────────────────────────────────────────────

async function executeTrade(market, assessment) {
  const { side, edgePct, fairProbability, reasoning } = assessment;
  const price = side === 'yes' ? market.yesAsk : market.noAsk;
  if (!price || price <= 0) return;
  if (!canTrade()) return;
  if (!checkSportExposure(market.ticker)) return;

  // 1/4 Kelly sizing (conservative for AI-estimated edges)
  const odds = (1 / price) - 1;
  const edge = edgePct / 100;
  const kellyFraction = odds > 0 ? edge / odds : 0;
  const quarterKelly = 0.25 * kellyFraction;

  // Dynamic cap based on bankroll + consecutive loss adjustment
  const maxTrade = getPositionSize('kalshi');
  const budget = Math.min(maxTrade, getBankroll() * quarterKelly);
  const qty = Math.max(1, Math.floor(budget / price));
  const deployed = qty * price;
  const priceInCents = Math.round(price * 100);

  console.log(`[ai-trade] ${market.ticker} BUY ${side.toUpperCase()} @${priceInCents}¢ × ${qty} edge=${edgePct.toFixed(1)}%`);
  if (!canDeployMore(deployed)) return;

  const result = await kalshiPost('/portfolio/orders', {
    ticker: market.ticker,
    action: 'buy',
    side,
    count: qty,
    yes_price: side === 'yes' ? priceInCents : 100 - priceInCents,
  });

  if (result.ok) {
    stats.tradesPlaced++;
    tradeCooldowns.set(market.ticker, Date.now());
    const order = result.data.order ?? result.data;
    const filled = order.quantity_filled ?? order.fill_count_fp ?? 0;

    logTrade({
      exchange: 'kalshi', strategy: 'news-edge',
      ticker: market.ticker, title: market.title,
      side, quantity: qty, entryPrice: price,
      deployCost: deployed, filled,
      orderId: order.order_id ?? null,
      edge: edgePct, fairProb: fairProbability,
      reasoning,
    });

    await tg(
      `🧠 <b>AI EDGE TRADE — KALSHI</b>\n\n` +
      `<b>${market.title}</b>\n\n` +
      `BUY ${side.toUpperCase()} @ $${price.toFixed(2)} × ${qty}\n` +
      `Deployed: <b>$${deployed.toFixed(2)}</b>\n` +
      `Edge: <b>${edgePct.toFixed(1)}%</b> (${assessment.confidence})\n` +
      `Fair prob: ${(fairProbability * 100).toFixed(0)}% vs market ${(price * 100).toFixed(0)}%\n\n` +
      `📰 <i>${reasoning}</i>\n\n` +
      `Filled: ${filled} | Order: ${order.order_id ?? 'pending'}`
    );

    console.log(`[ai-trade] placed: filled=${filled} orderId=${order.order_id ?? 'unknown'}`);
  } else {
    console.error(`[ai-trade] order failed: ${result.status}`, JSON.stringify(result.data));
    await tg(`❌ <b>AI Trade FAILED</b>\n${market.title}\n${side.toUpperCase()} @ $${price.toFixed(2)}\nHTTP ${result.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Live Score Edge — buy winning sides in late games at discount
// ─────────────────────────────────────────────────────────────────────────────

async function checkLiveScoreEdges() {
  const sports = [
    { league: 'mlb', path: 'baseball/mlb', series: 'KXMLBGAME' },
    { league: 'nba', path: 'basketball/nba', series: 'KXNBAGAME' },
    { league: 'nhl', path: 'hockey/nhl', series: 'KXNHLGAME' },
  ];

  for (const { league, path, series } of sports) {
    try {
      const res = await fetch(
        `http://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`,
        { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) continue;
      const data = await res.json();

      for (const ev of data.events ?? []) {
        const comp = ev.competitions?.[0];
        if (!comp || comp.status?.type?.state !== 'in') continue;

        const period = parseInt(comp.status?.period ?? '0');
        const competitors = comp.competitors ?? [];
        if (competitors.length < 2) continue;

        const home = competitors.find(c => c.homeAway === 'home');
        const away = competitors.find(c => c.homeAway === 'away');
        if (!home || !away) continue;

        const homeScore = parseInt(home.score ?? '0');
        const awayScore = parseInt(away.score ?? '0');
        const diff = Math.abs(homeScore - awayScore);
        const leading = homeScore > awayScore ? home : away;
        const leadingName = leading.team?.displayName ?? '';
        const gameDetail = comp.status?.type?.shortDetail ?? '';

        // Threshold to trigger — must be a decisive lead in late game
        let highCertainty = false;
        if (league === 'mlb' && period >= 7 && diff >= 3) highCertainty = true;
        else if (league === 'nba' && period >= 3 && diff >= 12) highCertainty = true;
        else if (league === 'nhl' && period >= 3 && diff >= 2) highCertainty = true;
        if (!highCertainty) continue;

        const homeAbbr = home.team?.abbreviation ?? '';
        const awayAbbr = away.team?.abbreviation ?? '';
        console.log(`[live-edge] Checking: ${away.team?.displayName} (${awayAbbr}) ${awayScore} @ ${home.team?.displayName} (${homeAbbr}) ${homeScore} (${gameDetail})`);

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

        // Pick the market for the leading team (buy YES on the winner)
        const leadingAbbr = leading.team?.abbreviation ?? '';
        const trailingAbbr = (leadingAbbr === homeAbbr) ? awayAbbr : homeAbbr;

        // Find the market ticker for the leading team
        let targetMarket = gameMarkets.find(m => m.ticker?.toUpperCase().endsWith('-' + leadingAbbr));
        if (!targetMarket) targetMarket = gameMarkets[0]; // fallback

        const price = parseFloat(targetMarket.yes_ask_dollars);
        const title = targetMarket.title ?? '';

        console.log(`[live-edge] Found market: ${targetMarket.ticker} "${title}" YES=$${price.toFixed(2)}`);

        // Use Claude to assess win probability based on live score + research
        const portfolioInfo = getPortfolioSummary();
        const livePrompt =
          `You are a sports prediction market analyst. Be skeptical — only trade with high confidence.\n\n` +
          `LIVE ${league.toUpperCase()} GAME RIGHT NOW:\n` +
          `${away.team?.displayName} ${awayScore} at ${home.team?.displayName} ${homeScore}\n` +
          `Game status: ${gameDetail}\n` +
          `Leading team: ${leading.team?.displayName} by ${diff}\n\n` +
          `MARKET: ${title}\n` +
          `Ticker: ${targetMarket.ticker}\n` +
          `${leadingAbbr} YES price: $${price.toFixed(2)} (implied ${(price*100).toFixed(0)}%)\n\n` +
          `CASH: $${kalshiBalance.toFixed(2)} | Max bet: $${Math.min(MAX_TRADE_CAP, kalshiBalance * 0.25).toFixed(2)}\n\n` +
          `RESEARCH: Use web search to check both teams' records and any relevant context.\n\n` +
          `QUESTION: Given the live score and game situation, what is the TRUE probability ${leading.team?.displayName} wins?\n` +
          `- If your probability is > market price by 7%+, recommend the trade\n` +
          `- If the market has already priced in the lead correctly, pass\n\n` +
          `Respond JSON ONLY:\n` +
          `{"trade": false, "reasoning": "why"}\n` +
          `OR {"trade": true, "side": "yes", "winProbability": 0.XX, "betAmount": N, "reasoning": "facts"}`;
        // Block if we already have a position on this game
        const ticker = targetMarket.ticker;
        const lastH = ticker.lastIndexOf('-');
        const gameBase = lastH > 0 ? ticker.slice(0, lastH) : ticker;
        const hasPosition = openPositions.some(p => {
          const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
          return pBase === gameBase;
        });
        if (hasPosition) { console.log(`[live-edge] BLOCKED: already have position on ${gameBase}`); continue; }

        // Cooldown check
        if (Date.now() - (tradeCooldowns.get(ticker) ?? 0) < COOLDOWN_MS) continue;
        if (Date.now() - (tradeCooldowns.get(gameBase) ?? 0) < COOLDOWN_MS) continue;

        // Price sanity
        if (price <= 0.05 || price >= 0.98) {
          console.log(`[live-edge] Market already priced in: ${leadingAbbr} YES @${(price*100).toFixed(0)}¢`);
          continue;
        }

        // Ask Claude for win probability assessment
        const cText = await claudeWithSearch(livePrompt);
        if (!cText) continue;
        const jsonMatch = cText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        let decision;
        try { decision = JSON.parse(jsonMatch[0]); } catch { continue; }

        if (!decision.trade) {
          console.log(`[live-edge] Claude passed: ${decision.reasoning?.slice(0, 100)}`);
          continue;
        }

        const winProb = decision.winProbability ?? 0;
        const edge = winProb - price;
        if (edge < MIN_EDGE) {
          console.log(`[live-edge] Edge too small: ${(edge*100).toFixed(1)}% (${leadingAbbr} YES @${(price*100).toFixed(0)}¢ vs ${(winProb*100).toFixed(0)}%)`);
          continue;
        }

        // Size the bet — dynamic + risk-managed
        if (!canTrade()) continue;
        if (!checkSportExposure(ticker)) continue;
        const maxBetLE = getPositionSize('kalshi');
        const claudeBet = decision.betAmount ?? 0;
        const safeBet = Math.min(claudeBet, maxBetLE);
        if (safeBet < 1) {
          console.log(`[live-edge] Bet too small: max=$${maxBetLE.toFixed(2)} Claude=$${claudeBet}`);
          continue;
        }
        const qty = Math.max(1, Math.floor(safeBet / price));
        const priceInCents = Math.round(price * 100);

        console.log(`[live-edge] TRADE: ${ticker} ${leadingAbbr} YES @${priceInCents}¢ × ${qty} edge=${(edge*100).toFixed(1)}%`);
        console.log(`  Score: ${awayAbbr} ${awayScore} @ ${homeAbbr} ${homeScore} (${gameDetail})`);
        console.log(`  Reason: ${decision.reasoning}`);
        if (!canDeployMore(qty * price)) continue;

        tradeCooldowns.set(ticker, Date.now());
        tradeCooldowns.set(gameBase, Date.now());
        const result = await kalshiPost('/portfolio/orders', {
          ticker, action: 'buy', side: 'yes', count: qty,
          yes_price: priceInCents,
        });

        if (result.ok) {
          stats.tradesPlaced++;
          const deployed = qty * price;

          logTrade({
            exchange: 'kalshi', strategy: 'live-score',
            ticker, title, side: 'yes',
            quantity: qty, entryPrice: price, deployCost: deployed,
            filled: (result.data.order ?? result.data).quantity_filled ?? 0,
            orderId: (result.data.order ?? result.data).order_id ?? null,
            edge: edge * 100, fairProb: winProb,
            reasoning: decision.reasoning,
            liveScore: `${awayAbbr} ${awayScore} - ${homeAbbr} ${homeScore} (${gameDetail})`,
          });

          await tg(
            `⚡ <b>LIVE SCORE EDGE — KALSHI</b>\n\n` +
            `<b>${title}</b>\n` +
            `Ticker: <code>${ticker}</code>\n` +
            `Team: <b>${leadingAbbr}</b>\n` +
            `Score: ${awayAbbr} ${awayScore} - ${homeAbbr} ${homeScore} (${gameDetail})\n\n` +
            `BUY YES @ $${price.toFixed(2)} × ${qty}\n` +
            `Deployed: <b>$${deployed.toFixed(2)}</b>\n` +
            `Claude prob: ${(winProb*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}%\n` +
            `Edge: <b>${(edge*100).toFixed(1)}%</b>\n\n` +
            `🔍 <i>${decision.reasoning}</i>`
          );
        } else {
          console.error(`[live-edge] Order failed:`, result.status, JSON.stringify(result.data));
        }
      }
    } catch (e) {
      console.error(`[live-edge] ${league} error:`, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Broad Market Scan — finds edges across ALL market types
// ─────────────────────────────────────────────────────────────────────────────

let lastBroadScan = 0;
const BROAD_SCAN_INTERVAL = 2 * 60 * 1000; // every 2 min — fast enough to catch edges

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
      const data = await kalshiGet(`/markets?series_ticker=${s}&status=open&limit=10`);
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
      const data = await kalshiGet(`/markets?series_ticker=${s}&status=open&limit=10`);
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

  // Filter out markets closing too far in the future — capital efficiency
  const maxCloseMs = Date.now() + MAX_DAYS_OUT * 24 * 60 * 60 * 1000;
  const beforeFilter = allMarkets.length;
  for (let i = allMarkets.length - 1; i >= 0; i--) {
    const ct = allMarkets[i].closeTime;
    if (ct) {
      const closeMs = Date.parse(ct);
      if (Number.isFinite(closeMs) && closeMs > maxCloseMs) {
        allMarkets.splice(i, 1);
      }
    }
  }
  const filtered = beforeFilter - allMarkets.length;
  if (filtered > 0) console.log(`[broad-scan] Filtered ${filtered} markets closing > ${MAX_DAYS_OUT} days out`);

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

  // Put non-sports first so Claude sees crypto/economics/politics before the cap
  const nonSports = tradeable.filter(m => m.category !== 'Sports');
  const sports = tradeable.filter(m => m.category === 'Sports');
  const ordered = [...nonSports, ...sports];

  // Group tradeable markets by event for bracket-aware presentation
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
      tradeLines.push(`[${cat}] BRACKET EVENT: ${eventKey} (${markets.length} thresholds — these are CUMULATIVE, pick the best one):`);
      for (const m of markets) {
        tradeLines.push(`  ${m.ticker}: "${m.title}" YES=$${m.yesAsk} NO=$${m.noAsk}`);
      }
    }
  }
  const marketSummaryFiltered = tradeLines.slice(0, 60).join('\n');

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

    const broadPrompt =
      `You are a skeptical prediction market analyst. Your DEFAULT answer is {"trade":false}. Most markets are efficiently priced — finding a real edge is rare. Your job is to check if any of these markets have a GENUINE mispricing, not to force a trade.\n\n` +
      `AVAILABLE CASH: $${kalshiBalance.toFixed(2)} (positions value is LOCKED, not available)\n\n` +
      `MY EXISTING POSITIONS (DO NOT trade these again):\n` +
      (openPositions.length > 0 ? openPositions.map(p => `  ${p.ticker}`).join('\n') : '  None') + '\n\n' +
      `TODAY: ${today} (sports tickers: ${todayShort} = today, ${tomorrowShort} = tonight's late games)\n` +
      (cryptoPrices ? `LIVE CRYPTO PRICES: ${cryptoPrices}\n` : '') +
      `\nMARKETS:\n${marketSummaryFiltered}\n\n` +
      `PROCESS — follow this EXACTLY:\n` +
      `1. RESEARCH: Use web search to look up current facts for any market that catches your eye\n` +
      `2. ASSESS: Based on your research, estimate the true probability\n` +
      `3. COMPARE: Is your probability at least 7 percentage points different from the market price?\n` +
      `4. CHALLENGE YOURSELF: Ask "Why would the market be wrong here? Thousands of traders are pricing this — what do I know that they don't?" If your answer is vague (e.g. "undervalued", "upset potential", "seems mispriced"), you do NOT have an edge.\n` +
      `5. DECIDE: Only trade if you have a SPECIFIC, CONCRETE reason backed by facts from your research.\n\n` +
      `MARKET STRUCTURE — understand before trading:\n` +
      `- YES + NO sums to ~$1.00-1.03. This is bid-ask spread, NOT mispricing.\n` +
      `- KXBTC/KXETH are NARROW $250 RANGE bets. BTC must land in that exact window. A 1¢ price on a range far from current price is CORRECTLY priced.\n` +
      `- Sports underdogs at 15-25¢ are usually correctly priced. Bad teams lose a lot.\n` +
      `- Contracts at $0.01-$0.05 are lottery tickets. The market knows they're unlikely.\n` +
      `- BRACKET MARKETS (CPI, GDP, Fed, BTC): These are CUMULATIVE thresholds shown together. "GDP > 2.0% YES=$0.53" means market thinks 53% chance GDP exceeds 2.0%. The IMPLIED range probability comes from the DIFFERENCE between adjacent thresholds. Pick the threshold where your research shows the biggest mispricing vs market. You only need ONE ticker from a bracket.\n\n` +
      `HARD CONSTRAINTS:\n` +
      `- Sports game tickers: ONLY "${todayShort}" or "${tomorrowShort}"\n` +
      `- Max bet: $${Math.min(MAX_TRADE_CAP, kalshiBalance * 0.25).toFixed(2)}\n` +
      `- If cash < $3: return {"trade":false}\n` +
      `- Min price: $0.05 (no lottery tickets)\n` +
      `- Markets close within ${MAX_DAYS_OUT} days. Prefer sooner.\n` +
      `- Fees: ~1.75¢/contract at 50¢.\n\n` +
      `Respond JSON ONLY:\n` +
      `{"trade":false,"reasoning":"why no good trade"}\n` +
      `OR\n` +
      `{"trade":true,"ticker":"exact","side":"yes"/"no","betAmount":N,"probability":0.XX,"counterArgument":"strongest reason this trade could be WRONG","reasoning":"specific facts proving market is mispriced DESPITE the counter-argument"}`;

    const cText = await claudeWithSearch(broadPrompt, { maxTokens: 1024, maxSearches: 5 });
    if (!cText) return;
    const jsonMatch = cText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    let decision;
    try { decision = JSON.parse(jsonMatch[0]); } catch { return; }

    if (!decision.trade) {
      console.log(`[broad-scan] No trade: ${decision.reasoning}`);
      return;
    }

    // HARD VALIDATIONS (override Claude if it breaks rules)
    const market = tradeable.find(m => m.ticker === decision.ticker);
    if (!market) { console.log(`[broad-scan] BLOCKED: invalid ticker ${decision.ticker}`); return; }

    // Block sports game-winner tickers that aren't today or tonight (tomorrow UTC)
    const isSportsGame = /^KX(MLB|NBA|NFL|NHL)GAME-/i.test(decision.ticker);
    if (isSportsGame && !decision.ticker.includes(todayShort) && !decision.ticker.includes(tomorrowShort)) {
      console.log(`[broad-scan] BLOCKED: sports ticker ${decision.ticker} is not today (${todayShort}) or tonight (${tomorrowShort})`);
      return;
    }

    // Block if we already have a position on this game
    const lastH = decision.ticker.lastIndexOf('-');
    const base = lastH > 0 ? decision.ticker.slice(0, lastH) : decision.ticker;
    if (positionBases.has(base)) {
      console.log(`[broad-scan] BLOCKED: already have position on ${base}`);
      return;
    }

    // Block if edge < 10%
    const price = decision.side === 'yes' ? parseFloat(market.yesAsk) : parseFloat(market.noAsk);

    // Block lottery tickets — contracts at 1-3¢ are tail bets, not edges
    if (price <= 0.03) {
      console.log(`[broad-scan] BLOCKED: price ${(price*100).toFixed(0)}¢ is a lottery ticket, not an edge`);
      return;
    }

    const edge = Math.abs((decision.probability ?? 0) - price);
    if (edge < MIN_EDGE) {
      console.log(`[broad-scan] BLOCKED: edge ${(edge*100).toFixed(1)}% < ${MIN_EDGE_PCT}% minimum`);
      return;
    }

    // Block if cash too low
    if (kalshiBalance < 3) {
      console.log(`[broad-scan] BLOCKED: cash $${kalshiBalance.toFixed(2)} < $3`);
      return;
    }

    // Cooldown
    if (Date.now() - (tradeCooldowns.get(decision.ticker) ?? 0) < COOLDOWN_MS) return;

    // Risk checks
    if (!canTrade()) return;
    if (!checkSportExposure(decision.ticker)) return;

    // Dynamic sizing — scales with bankroll, reduces after losses
    const maxBet = getPositionSize('kalshi');
    const safeBet = Math.min(decision.betAmount ?? 0, maxBet);
    if (safeBet < 1 || price <= 0) return;

    const qty = Math.max(1, Math.floor(safeBet / price));
    const priceInCents = Math.round(price * 100);

    console.log(`[broad-scan] TRADE: ${market.title} ${decision.side} @${priceInCents}¢ × ${qty} edge=${(edge*100).toFixed(1)}%`);
    console.log(`  Reason: ${decision.reasoning}`);
    if (!canDeployMore(safeBet)) return;

    tradeCooldowns.set(decision.ticker, Date.now());
    tradeCooldowns.set(base, Date.now());

    const result = await kalshiPost('/portfolio/orders', {
      ticker: decision.ticker, action: 'buy', side: decision.side, count: qty,
      yes_price: decision.side === 'yes' ? priceInCents : 100 - priceInCents,
    });

    if (result.ok) {
      stats.tradesPlaced++;
      const teamSuffix = decision.ticker.split('-').pop() ?? '';
      const closeMs = Date.parse(market.closeTime);
      const daysOut = Number.isFinite(closeMs) ? Math.ceil((closeMs - Date.now()) / (24*60*60*1000)) : '?';

      logTrade({
        exchange: 'kalshi', strategy: 'claude-scan',
        ticker: decision.ticker, title: market.title, category: market.category,
        side: decision.side, quantity: qty, entryPrice: price,
        deployCost: qty * price,
        filled: (result.data.order ?? result.data).quantity_filled ?? 0,
        orderId: (result.data.order ?? result.data).order_id ?? null,
        edge: edge * 100, fairProb: decision.probability,
        reasoning: decision.reasoning,
        counterArgument: decision.counterArgument ?? null,
        daysOut,
      });

      await tg(
        `🧠 <b>CLAUDE TRADE — KALSHI</b>\n\n` +
        `<b>${market.title}</b>\n` +
        `Category: ${market.category}\n` +
        `Ticker: <code>${decision.ticker}</code>\n` +
        `Team: <b>${teamSuffix}</b> | Closes in <b>${daysOut}d</b>\n\n` +
        `BUY ${decision.side.toUpperCase()} @ $${price.toFixed(2)} × ${qty}\n` +
        `Deployed: <b>$${(qty * price).toFixed(2)}</b>\n` +
        `Edge: <b>${(edge*100).toFixed(0)}%</b> (Claude ${((decision.probability ?? 0)*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}%)\n\n` +
        `🔍 <i>Research-backed: ${decision.reasoning}</i>`
      );
    }
  } catch (e) {
    console.error('[broad-scan] error:', e.message);
  }

  // === POLYMARKET SCAN ===
  if (polyBalance < 3) return; // not enough Poly cash
  try {
    const polyMarkets = [];
    // Paginate all pages to find moneyline markets
    for (let polyOffset = 0; polyOffset < 1000; polyOffset += 200) {
      const polyRes = await fetch(`https://gateway.polymarket.us/v1/markets?limit=200&offset=${polyOffset}&active=true&closed=false`, {
        headers: { 'User-Agent': 'arbor-ai/1', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!polyRes.ok) break;
      const pd = await polyRes.json();
      if (!pd.markets?.length) break;
      for (const m of pd.markets ?? []) {
        if (m.closed || !m.active) continue;
        // Include moneyline (game-winners) AND futures (Masters, MVP, etc.)
        if (m.marketType !== 'moneyline' && m.marketType !== 'futures') continue;
        const sides = m.marketSides ?? [];
        if (sides.length < 2) continue;
        const s0 = parseFloat(String(sides[0]?.price ?? '0'));
        const s1 = parseFloat(String(sides[1]?.price ?? '0'));
        if (s0 < 0.05 || s1 < 0.05) continue; // skip resolved/extreme
        polyMarkets.push({
          slug: m.slug ?? '',
          title: m.question ?? '',
          side0: `${sides[0]?.team?.name ?? sides[0]?.description ?? 'Side0'} @ $${s0.toFixed(2)}`,
          side1: `${sides[1]?.team?.name ?? sides[1]?.description ?? 'Side1'} @ $${s1.toFixed(2)}`,
          s0Price: s0,
          s1Price: s1,
        });
      }
    }
    if (polyMarkets.length === 0) return;

    const polyList = polyMarkets.slice(0, 15).map(m =>
      `"${m.title}" — ${m.side0} | ${m.side1} [slug: ${m.slug}]`
    ).join('\n');

    const polyPrompt =
      `You are a skeptical prediction market analyst. Your DEFAULT answer is {"trade":false}. Most markets are efficiently priced.\n\n` +
      `POLYMARKET CASH: $${polyBalance.toFixed(2)}\n\n` +
      `MARKETS:\n${polyList}\n\n` +
      `PROCESS:\n` +
      `1. Research any interesting market with web search (team records, standings, player stats, expert analysis)\n` +
      `2. Estimate true probability from your research\n` +
      `3. Ask yourself: "Why would thousands of other traders have this wrong?"\n` +
      `4. Only trade if you have a SPECIFIC answer to that question backed by concrete facts\n\n` +
      `CONSTRAINTS:\n` +
      `- Need 10%+ edge (researched probability vs market price)\n` +
      `- Max bet: $${Math.min(50, polyBalance * 0.25).toFixed(2)}\n` +
      `- Min price: $0.05 (no lottery tickets)\n` +
      `- side0 = ORDER_INTENT_BUY_LONG, side1 = ORDER_INTENT_BUY_SHORT\n\n` +
      `JSON ONLY:\n` +
      `{"trade":false,"reasoning":"why"}\n` +
      `OR {"trade":true,"slug":"exact slug","side":"side0"/"side1","betAmount":N,"probability":0.XX,"counterArgument":"why this trade could be wrong","reasoning":"specific facts proving market is wrong despite counter-argument"}`;

    const pcText = await claudeWithSearch(polyPrompt, { maxTokens: 1024, maxSearches: 3 });
    if (!pcText) return;
    const pcMatch = pcText.match(/\{[\s\S]*\}/);
    if (!pcMatch) return;
    let polyDecision;
    try { polyDecision = JSON.parse(pcMatch[0]); } catch { return; }

    if (!polyDecision.trade) {
      console.log(`[poly-scan] No trade: ${polyDecision.reasoning}`);
      return;
    }

    const polyMkt = polyMarkets.find(m => m.slug === polyDecision.slug);
    if (!polyMkt) { console.log(`[poly-scan] Invalid slug: ${polyDecision.slug}`); return; }

    // Polymarket cooldown check
    const polyKey = 'poly:' + polyDecision.slug;
    if (Date.now() - (tradeCooldowns.get(polyKey) ?? 0) < COOLDOWN_MS) {
      console.log(`[poly-scan] On cooldown: ${polyDecision.slug}`);
      return;
    }

    const polyPrice = polyDecision.side === 'side0' ? polyMkt.s0Price : polyMkt.s1Price;
    const polyEdge = Math.abs((polyDecision.probability ?? 0) - polyPrice);
    if (polyPrice <= 0.05) { console.log(`[poly-scan] BLOCKED: price ${(polyPrice*100).toFixed(0)}¢ is a lottery ticket`); return; }
    if (polyEdge < MIN_EDGE) { console.log(`[poly-scan] Edge too small: ${(polyEdge*100).toFixed(1)}%`); return; }

    if (!canTrade()) return;
    const polyIntent = polyDecision.side === 'side0' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT';
    const polyMaxBet = getPositionSize('polymarket');
    const polyBet = Math.min(polyDecision.betAmount ?? 0, polyMaxBet);
    if (polyBet < 1) return;
    const polyQty = Math.max(1, Math.floor(polyBet / (polyPrice + 0.02))); // +2¢ buffer

    console.log(`[poly-scan] TRADE: ${polyMkt.title} ${polyDecision.side} @${(polyPrice*100).toFixed(0)}¢ × ${polyQty}`);
    const polyResult = await polymarketPost(polyMkt.slug, polyIntent, polyPrice + 0.02, polyQty);

    if (polyResult.ok) {
      stats.tradesPlaced++;
      tradeCooldowns.set(polyKey, Date.now());

      logTrade({
        exchange: 'polymarket', strategy: 'claude-scan',
        ticker: polyMkt.slug, title: polyMkt.title,
        side: polyDecision.side === 'side0' ? 'long' : 'short',
        quantity: polyQty, entryPrice: polyPrice,
        deployCost: polyQty * polyPrice,
        edge: polyEdge * 100, fairProb: polyDecision.probability,
        reasoning: polyDecision.reasoning,
        counterArgument: polyDecision.counterArgument ?? null,
      });

      await tg(
        `🧠 <b>CLAUDE TRADE — POLYMARKET</b>\n\n` +
        `<b>${polyMkt.title}</b>\n` +
        `Slug: <code>${polyMkt.slug}</code>\n\n` +
        `BUY ${polyDecision.side === 'side0' ? 'LONG' : 'SHORT'} @ $${polyPrice.toFixed(2)} × ${polyQty}\n` +
        `Deployed: <b>$${(polyQty * polyPrice).toFixed(2)}</b>\n` +
        `Edge: <b>${(polyEdge*100).toFixed(0)}%</b>\n\n` +
        `🧠 <i>${polyDecision.reasoning}</i>`
      );
    }
  } catch (e) {
    console.error('[poly-scan] error:', e.message);
  }
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

  // Prune news IDs older than 2 hours
  const pruneThreshold = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, ts] of seenNewsIds) {
    if (ts < pruneThreshold) seenNewsIds.delete(id);
  }

  // Step 1: Fetch news
  const newsItems = await fetchESPNNews();
  stats.newsChecked += newsItems.length;

  if (newsItems.length > 0) {
    console.log(`[ai-edge] ${newsItems.length} new items:`, newsItems.map(n => n.headline.slice(0, 50)).join(' | '));
  }

  // Skip all Claude-powered analysis when available cash is too low
  const availCash = getAvailableCash('kalshi');
  if (availCash < 3) {
    console.log(`[ai-edge] Available cash $${availCash.toFixed(2)} < $3 (reserve protected) — skipping`);
    return;
  }

  // Step 1b: Check live scores for high-certainty winners
  await checkLiveScoreEdges();

  // Step 1c: Broad market scan — let Claude find edges across ALL Kalshi markets
  await claudeBroadScan();

  // Step 2-4: For each news item, find markets and assess edge
  for (const news of newsItems) {
    if (news.teams.length === 0) continue;

    const markets = await findMatchingMarkets(news);
    if (markets.length === 0) continue;

    for (const market of markets.slice(0, 2)) {
      // Position check — don't trade games we already have positions on
      const mBase = market.ticker.lastIndexOf('-') > 0
        ? market.ticker.slice(0, market.ticker.lastIndexOf('-'))
        : market.ticker;
      const hasPos = openPositions.some(p => {
        const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
        return pBase === mBase;
      });
      if (hasPos) continue;

      // Date check — sports game-winners must be today or tonight
      const isSports = /^KX(MLB|NBA|NFL|NHL)GAME-/i.test(market.ticker);
      if (isSports) {
        const etNow2 = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const etTmrw = new Date(etNow2.getTime() + 24 * 60 * 60 * 1000);
        const toS = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
        if (!market.ticker.includes(toS(etNow2)) && !market.ticker.includes(toS(etTmrw))) continue;
      }

      // Cooldown (ticker + base)
      if (Date.now() - (tradeCooldowns.get(market.ticker) ?? 0) < COOLDOWN_MS) continue;
      if (Date.now() - (tradeCooldowns.get(mBase) ?? 0) < COOLDOWN_MS) continue;

      // Ask Claude
      const assessment = await assessEdge(news, market);
      if (!assessment || !assessment.hasEdge) continue;
      if (!assessment.side || typeof assessment.edgePct !== 'number' ||
          typeof assessment.fairProbability !== 'number' || !assessment.reasoning) continue;

      // Edge must be >= 10%
      const expectedEdge = Math.abs(assessment.fairProbability - (assessment.currentPrice ?? 0)) * 100;
      if (expectedEdge < MIN_EDGE * 100) continue;
      if (assessment.confidence === 'low') continue;

      stats.edgesFound++;
      console.log(`[ai-edge] EDGE: ${market.title} — ${assessment.side} ${expectedEdge.toFixed(1)}% (${assessment.confidence})`);

      // Execute + set base cooldown
      await executeTrade(market, assessment);
      tradeCooldowns.set(mBase, Date.now());

      await new Promise(r => setTimeout(r, 1000));
    }
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
      const { writeFileSync } = await import('fs');
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
  if (kalshiBalance < 2) return; // need cash to buy

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
  console.log(`[ai-stats] news=${stats.newsChecked} claude=${stats.claudeCalls} edges=${stats.edgesFound} trades=${stats.tradesPlaced} bal=$${kalshiBalance.toFixed(2)} pnl=${pnlStr} (${settledCount} settled)`);
}

async function main() {
  console.log('=== Arbor AI Edge Trading Bot ===');
  console.log(`Config: MIN_EDGE=${MIN_EDGE_PCT}% MAX_TRADE=$${MAX_TRADE_CAP} POLL=${POLL_INTERVAL_MS / 1000}s`);

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
    try { await checkSettlements(); } catch (e) { console.error('[settlement] error:', e.message); }
    try { await checkResolutionArbs(); } catch (e) { console.error('[resolve] error:', e.message); }
    setTimeout(settlementLoop, 5 * 60 * 1000);
  }
  setTimeout(settlementLoop, 2 * 60 * 1000); // first run after 2 min

  // Initialize risk tracking
  resetDailyTracking();

  const bankroll = getBankroll();
  const maxTrade = getDynamicMaxTrade();
  await tg(
    `🧠 <b>AI Edge Bot Started</b>\n\n` +
    `<b>Risk Controls Active:</b>\n` +
    `Max trade: $${maxTrade.toFixed(2)} (10% of bankroll, ceiling $${getTradeCapCeiling()})\n` +
    `Max deploy: ${(getMaxDeployment()*100).toFixed(0)}% ($${(bankroll*getMaxDeployment()).toFixed(2)}) | Positions: ${getMaxPositions()}\n` +
    `Daily loss halt: $${Math.max(10, bankroll * DAILY_LOSS_PCT).toFixed(2)} (5%)\n` +
    `Reserve: ${(CAPITAL_RESERVE*100).toFixed(0)}% ($${(bankroll*CAPITAL_RESERVE).toFixed(2)}) | Sport cap: $${Math.max(15, bankroll * SPORT_EXPOSURE_PCT).toFixed(2)}\n` +
    `Consecutive loss halt: ${MAX_CONSECUTIVE_LOSSES}→reduce, 5→halt\n\n` +
    `<b>Config:</b>\n` +
    `Min edge: ${MIN_EDGE_PCT}% | Cooldown: ${COOLDOWN_MS/60000}min\n` +
    `Model: ${CLAUDE_MODEL} + web search\n\n` +
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
