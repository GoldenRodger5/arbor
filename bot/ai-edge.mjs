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

import { readFileSync } from 'fs';
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

const MIN_EDGE_PCT = 3;          // 3% edge minimum — real edges are small but frequent
const MAX_TRADE_FRACTION = 0.25; // Use up to 25% of balance per trade
const MAX_TRADE_CAP = 50;        // Hard cap $50 per trade
const POLL_INTERVAL_MS = 60 * 1000; // Check news every 60 seconds
const COOLDOWN_MS = 15 * 60 * 1000; // 15 min cooldown per market

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

async function refreshPolyBalance() {
  if (!POLY_US_KEY_ID || !POLY_US_SECRET) return;
  try {
    const ed = await import('@noble/ed25519');
    // Configure sha512 for ed25519 using Node's built-in crypto
    const { createHash } = await import('crypto');
    ed.etc.sha512Sync = (...m) => {
      const h = createHash('sha512');
      for (const msg of m) h.update(msg);
      return new Uint8Array(h.digest());
    };
    const sign = ed.signAsync ?? ed.sign;
    const privBytes = Uint8Array.from(atob(POLY_US_SECRET), c => c.charCodeAt(0)).slice(0, 32);
    const timestamp = String(Date.now());
    const path = '/v1/account/balances';
    const message = `${timestamp}GET${path}`;
    const sigBytes = await sign(new TextEncoder().encode(message), privBytes);
    const signature = btoa(String.fromCharCode(...sigBytes));

    const res = await fetch(`${POLY_US_API}${path}`, {
      headers: {
        'X-PM-Access-Key': POLY_US_KEY_ID,
        'X-PM-Timestamp': timestamp,
        'X-PM-Signature': signature,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'arbor-ai/1',
      },
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

const tradeCooldowns = new Map(); // ticker → lastTradedMs
const seenNewsIds = new Set();    // prevent re-processing same news
let kalshiBalance = 0;
let kalshiPositionValue = 0;
let openPositions = [];  // fetched each cycle
let stats = { newsChecked: 0, claudeCalls: 0, edgesFound: 0, tradesPlaced: 0 };

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
          seenNewsIds.add(id);
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
              seenNewsIds.add(id);
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

QUESTION: Does this news materially change the probability of this game's outcome? If so:
1. Which side benefits (YES or NO)?
2. What should the fair probability be after this news?
3. What is the edge (difference between fair prob and current market price)?

Respond in JSON only:
{
  "hasEdge": true/false,
  "side": "yes" or "no",
  "fairProbability": 0.XX,
  "currentPrice": 0.XX,
  "edgePct": X.X,
  "confidence": "high"/"medium"/"low",
  "reasoning": "one sentence"
}

If the news doesn't meaningfully change the probability (e.g. minor roster move, already priced in, not relevant to this game), return {"hasEdge": false}.`;

  try {
    stats.claudeCalls++;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error('[claude] HTTP', res.status);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text ?? '';
    // Extract JSON from response
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
  if (kalshiBalance < 5) {
    console.log('[ai-trade] Balance too low ($' + kalshiBalance.toFixed(2) + '), skipping');
    return;
  }

  // Kelly sizing: f = edge / odds
  const odds = (1 / price) - 1;
  const edge = edgePct / 100;
  const kellyFraction = odds > 0 ? edge / odds : 0;
  const halfKelly = 0.5 * kellyFraction;

  // Size: half Kelly on available balance, capped at 25% of balance or $50
  const maxTrade = Math.min(MAX_TRADE_CAP, kalshiBalance * MAX_TRADE_FRACTION);
  const budget = Math.min(maxTrade, kalshiBalance * halfKelly);
  const qty = Math.max(1, Math.floor(budget / price));
  const deployed = qty * price;
  const priceInCents = Math.round(price * 100);

  console.log(`[ai-trade] ${market.ticker} BUY ${side.toUpperCase()} @${priceInCents}¢ × ${qty} edge=${edgePct.toFixed(1)}%`);

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

        console.log(`[live-edge] Checking: ${away.team?.displayName} ${awayScore} @ ${home.team?.displayName} ${homeScore} (${gameDetail})`);

        // Get today's Kalshi markets for this sport
        const params = new URLSearchParams({ series_ticker: series, status: 'open', limit: '100' });
        const mkts = await kalshiGet(`/markets?${params}`);
        const marketList = (mkts.markets ?? [])
          .filter(m => {
            if (!m.yes_ask_dollars || !m.no_ask_dollars) return false;
            // Only include markets that could be today's game
            const ya = parseFloat(m.yes_ask_dollars);
            const na = parseFloat(m.no_ask_dollars);
            return ya > 0.01 && ya < 0.99 && na > 0.01 && na < 0.99;
          })
          .slice(0, 20) // limit to avoid huge prompt
          .map(m => `${m.ticker}: "${m.title}" YES=$${m.yes_ask_dollars} NO=$${m.no_ask_dollars}`);

        if (marketList.length === 0) continue;

        // Use Claude to: 1) find the right market, 2) assess win probability, 3) pick side, 4) decide bet size
        stats.claudeCalls++;
        const portfolioInfo = getPortfolioSummary();
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{ role: 'user', content:
              `You are a sports prediction market trader managing a real portfolio.\n\n` +
              `MY PORTFOLIO:\n${portfolioInfo}\n\n` +
              `LIVE ${league.toUpperCase()} GAME RIGHT NOW (today ${new Date().toISOString().slice(0,10)}):\n` +
              `${away.team?.displayName} ${awayScore} at ${home.team?.displayName} ${homeScore}\n` +
              `Game status: ${gameDetail}\n\n` +
              `KALSHI MARKETS (some may be for DIFFERENT DATES):\n` +
              marketList.join('\n') + '\n\n' +
              `RULES:\n` +
              `- Ticker dates: 26APR11 = April 11, 26APR12 = April 12, etc.\n` +
              `- Today is ${new Date().toISOString().slice(0,10)}. ONLY pick a ticker with TODAY's date.\n` +
              `- If I already have a position on this game, DON'T add more.\n` +
              `- Never bet more than 25% of my cash balance on one trade.\n` +
              `- If cash balance is below $5, return {"ticker": null} — not enough to trade.\n` +
              `- Only trade if you're very confident (>80% win probability).\n\n` +
              `Respond in JSON ONLY:\n` +
              `{"ticker": "exact ticker for TODAY or null", "side": "yes"/"no", ` +
              `"winProbability": 0.XX, "betAmount": dollars to bet (max 25% of cash), ` +
              `"reasoning": "one sentence"}`
            }],
          }),
        });

        if (!claudeRes.ok) { console.error('[live-edge] Claude HTTP', claudeRes.status); continue; }
        const cData = await claudeRes.json();
        const cText = cData.content?.[0]?.text ?? '';
        const jsonMatch = cText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        let decision;
        try { decision = JSON.parse(jsonMatch[0]); } catch { continue; }
        if (!decision.ticker || decision.ticker === 'null') {
          console.log(`[live-edge] Claude: no matching ticker for today's game`);
          continue;
        }

        // Validate the ticker exists in our market list
        const market = (mkts.markets ?? []).find(m => m.ticker === decision.ticker);
        if (!market) { console.log(`[live-edge] Claude picked invalid ticker: ${decision.ticker}`); continue; }

        // Block if we already have a position on this game
        const lastH = decision.ticker.lastIndexOf('-');
        const gameBase = lastH > 0 ? decision.ticker.slice(0, lastH) : decision.ticker;
        const hasPosition = openPositions.some(p => {
          const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
          return pBase === gameBase;
        });
        if (hasPosition) { console.log(`[live-edge] BLOCKED: already have position on ${gameBase}`); continue; }

        // Check cooldown (also blocks base ticker to prevent opposite-side trades)
        if (Date.now() - (tradeCooldowns.get(decision.ticker) ?? 0) < COOLDOWN_MS) continue;
        if (Date.now() - (tradeCooldowns.get(gameBase) ?? 0) < COOLDOWN_MS) continue;

        const winProb = decision.winProbability ?? 0.90;
        const side = decision.side;
        const price = side === 'yes'
          ? parseFloat(market.yes_ask_dollars)
          : parseFloat(market.no_ask_dollars);

        const edge = winProb - price;
        if (edge < 0.03) {
          console.log(`[live-edge] Edge too small: ${(edge*100).toFixed(1)}% (${side} @${(price*100).toFixed(0)}¢ vs ${(winProb*100).toFixed(0)}%)`);
          continue;
        }

        // Use Claude's recommended bet amount, capped by actual balance
        const claudeBet = decision.betAmount ?? 0;
        const safeBet = Math.min(claudeBet, kalshiBalance * 0.25, MAX_TRADE_CAP);
        if (safeBet < 1) {
          console.log(`[live-edge] Not enough cash ($${kalshiBalance.toFixed(2)}) or Claude said $0`);
          continue;
        }
        const qty = Math.max(1, Math.floor(safeBet / price));
        const priceInCents = Math.round(price * 100);

        console.log(`[live-edge] Claude matched: ${decision.ticker} ${side} @${priceInCents}¢ edge=${(edge*100).toFixed(1)}%`);
        console.log(`  Reason: ${decision.reasoning}`);

        tradeCooldowns.set(decision.ticker, Date.now());
        tradeCooldowns.set(gameBase, Date.now()); // block opposite-side trades
        const result = await kalshiPost('/portfolio/orders', {
          ticker: decision.ticker, action: 'buy', side, count: qty,
          yes_price: side === 'yes' ? priceInCents : 100 - priceInCents,
          });

        if (result.ok) {
          stats.tradesPlaced++;
          const deployed = qty * price;
          const profit = qty * edge;
          await tg(
            `⚡ <b>LIVE SCORE EDGE — KALSHI</b>\n\n` +
            `<b>${market.title}</b>\n` +
            `Ticker: <code>${decision.ticker}</code>\n` +
            `Score: ${awayScore}-${homeScore} (${gameDetail})\n\n` +
            `BUY ${side.toUpperCase()} @ $${price.toFixed(2)} × ${qty}\n` +
            `Deployed: <b>$${deployed.toFixed(2)}</b>\n` +
            `Claude prob: ${(winProb*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}%\n` +
            `Edge: <b>${(edge*100).toFixed(1)}%</b>\n\n` +
            `🧠 <i>${decision.reasoning}</i>`
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
const BROAD_SCAN_INTERVAL = 5 * 60 * 1000; // every 5 min (uses more Claude tokens)

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

  // Sports — get a sample of active game-winner markets
  for (const s of categories[0].series) {
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

  // Non-sports — fetch by Kalshi event categories
  const categoryMap = [
    { kalshiCat: 'Economics', label: 'Economics' },
    { kalshiCat: 'Politics', label: 'Politics' },
    { kalshiCat: 'Crypto', label: 'Crypto' },
    { kalshiCat: 'Finance', label: 'Finance' },
  ];
  for (const { kalshiCat, label } of categoryMap) {
    try {
      const data = await kalshiGet(`/markets?status=open&limit=20&event_category=${kalshiCat}`);
      for (const m of data.markets ?? []) {
        if (!m.yes_ask_dollars || !m.no_ask_dollars) continue;
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

  if (allMarkets.length === 0) return;

  // Build compact market list for Claude
  const marketSummary = allMarkets.slice(0, 30).map(m =>
    `[${m.category}] ${m.ticker}: "${m.title}" YES=$${m.yesAsk} NO=$${m.noAsk}`
  ).join('\n');

  // Fetch recent headlines for context
  let recentNews = '';
  try {
    const newsRes = await fetch('http://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?limit=3',
      { headers: { 'User-Agent': 'arbor/1' }, signal: AbortSignal.timeout(3000) });
    if (newsRes.ok) {
      const nd = await newsRes.json();
      recentNews = (nd.articles ?? []).slice(0, 3).map(a => a.headline).join('; ');
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

  const marketSummaryFiltered = tradeable.slice(0, 25).map(m =>
    `[${m.category}] ${m.ticker}: "${m.title}" YES=$${m.yesAsk} NO=$${m.noAsk}`
  ).join('\n');

  // Ask Claude — strict rules
  stats.claudeCalls++;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const todayParts = today.split('-');
    const todayShort = `26${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][parseInt(todayParts[1])-1]}${todayParts[2]}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content:
          `You are a professional sports bettor. Find ONE trade with a real edge.\n\n` +
          `AVAILABLE CASH: $${kalshiBalance.toFixed(2)} (this is ALL I can bet with — positions value is LOCKED)\n\n` +
          `MY EXISTING POSITIONS (DO NOT trade these games again):\n` +
          (openPositions.length > 0 ? openPositions.map(p => `  ${p.ticker}`).join('\n') : '  None') + '\n\n' +
          `TODAY: ${today} (tickers use format ${todayShort} for today)\n\n` +
          `MARKETS I CAN TRADE:\n${marketSummaryFiltered}\n\n` +
          `STRICT RULES — violating ANY means return {"trade":false}:\n` +
          `1. Your probability MUST differ from market price by at least 10 percentage points\n` +
          `2. YES price + NO price on Kalshi always sums to ~$1.00-1.03. This is NOT mispricing — it's the bid-ask spread. Do NOT trade based on YES+NO sum.\n` +
          `3. For SPORTS game-winner tickers (KXMLBGAME/KXNBAGAME/KXNHLGAME): ONLY trade if ticker contains "${todayShort}" (today's date). Non-sports tickers (crypto/economics/politics) don't have dates — trade those anytime.\n` +
          `4. Max bet: $${Math.min(MAX_TRADE_CAP, kalshiBalance * 0.25).toFixed(2)} (25% of $${kalshiBalance.toFixed(2)} cash)\n` +
          `5. If cash < $3, return {"trade":false}\n` +
          `6. You need a REAL reason the market is wrong — not just "asymmetric pricing" or "bid-ask spread"\n` +
          `7. Fees eat ~1.75¢ per contract at 50¢. Account for this.\n\n` +
          `Respond JSON ONLY:\n` +
          `{"trade":false,"reasoning":"why no good trade"}\n` +
          `OR\n` +
          `{"trade":true,"ticker":"exact","side":"yes"/"no","betAmount":N,"probability":0.XX,"reasoning":"specific reason market is wrong"}`
        }],
      }),
    });

    if (!claudeRes.ok) { console.error('[broad-scan] Claude HTTP', claudeRes.status); return; }
    const cData = await claudeRes.json();
    const cText = cData.content?.[0]?.text ?? '';
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

    // Block sports game-winner tickers that aren't today
    const isSportsGame = /^KX(MLB|NBA|NFL|NHL)GAME-/i.test(decision.ticker);
    if (isSportsGame && !decision.ticker.includes(todayShort)) {
      console.log(`[broad-scan] BLOCKED: sports ticker ${decision.ticker} is not today (${todayShort})`);
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
    const edge = Math.abs((decision.probability ?? 0) - price);
    if (edge < 0.10) {
      console.log(`[broad-scan] BLOCKED: edge ${(edge*100).toFixed(1)}% < 10% minimum`);
      return;
    }

    // Block if cash too low
    if (kalshiBalance < 3) {
      console.log(`[broad-scan] BLOCKED: cash $${kalshiBalance.toFixed(2)} < $3`);
      return;
    }

    // Cooldown
    if (Date.now() - (tradeCooldowns.get(decision.ticker) ?? 0) < COOLDOWN_MS) return;

    // Size — strictly from cash, NOT positions
    const maxBet = Math.min(MAX_TRADE_CAP, kalshiBalance * 0.25);
    const safeBet = Math.min(decision.betAmount ?? 0, maxBet);
    if (safeBet < 1 || price <= 0) return;

    const qty = Math.max(1, Math.floor(safeBet / price));
    const priceInCents = Math.round(price * 100);

    console.log(`[broad-scan] TRADE: ${market.title} ${decision.side} @${priceInCents}¢ × ${qty} edge=${(edge*100).toFixed(1)}%`);
    console.log(`  Reason: ${decision.reasoning}`);

    tradeCooldowns.set(decision.ticker, Date.now());
    // Also cooldown the base ticker to prevent opposite-side trades
    tradeCooldowns.set(base, Date.now());

    const result = await kalshiPost('/portfolio/orders', {
      ticker: decision.ticker, action: 'buy', side: decision.side, count: qty,
      yes_price: decision.side === 'yes' ? priceInCents : 100 - priceInCents,
    });

    if (result.ok) {
      stats.tradesPlaced++;
      await tg(
        `🧠 <b>CLAUDE TRADE — KALSHI</b>\n\n` +
        `<b>${market.title}</b>\n` +
        `Category: ${market.category}\n` +
        `Ticker: <code>${decision.ticker}</code>\n\n` +
        `BUY ${decision.side.toUpperCase()} @ $${price.toFixed(2)} × ${qty}\n` +
        `Deployed: <b>$${(qty * price).toFixed(2)}</b>\n` +
        `Edge: <b>${(edge*100).toFixed(0)}%</b> (Claude ${((decision.probability ?? 0)*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}%)\n\n` +
        `🧠 <i>${decision.reasoning}</i>`
      );
    }
  } catch (e) {
    console.error('[broad-scan] error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Loop
// ─────────────────────────────────────────────────────────────────────────────

async function pollCycle() {
  // Refresh full portfolio (balance + positions)
  await refreshPortfolio();

  // Prune old seen news IDs (keep last 500)
  if (seenNewsIds.size > 500) {
    const arr = [...seenNewsIds];
    arr.splice(0, arr.length - 200);
    seenNewsIds.clear();
    for (const id of arr) seenNewsIds.add(id);
  }

  // Step 1: Fetch news
  const newsItems = await fetchESPNNews();
  stats.newsChecked += newsItems.length;

  if (newsItems.length > 0) {
    console.log(`[ai-edge] ${newsItems.length} new items:`, newsItems.map(n => n.headline.slice(0, 50)).join(' | '));
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

    for (const market of markets.slice(0, 2)) { // max 2 markets per news item
      // Check cooldown
      const lastTraded = tradeCooldowns.get(market.ticker) ?? 0;
      if (Date.now() - lastTraded < COOLDOWN_MS) continue;

      // Step 3: Ask Claude
      const assessment = await assessEdge(news, market);
      if (!assessment || !assessment.hasEdge) continue;
      // Validate Claude's response has required fields
      if (!assessment.side || typeof assessment.edgePct !== 'number' ||
          typeof assessment.fairProbability !== 'number' || !assessment.reasoning) {
        console.log('[ai-edge] Invalid Claude response, skipping');
        continue;
      }
      // Cross-check: edgePct should roughly match |fairProb - currentPrice|
      const expectedEdge = Math.abs(assessment.fairProbability - (assessment.currentPrice ?? 0)) * 100;
      if (Math.abs(assessment.edgePct - expectedEdge) > 10) {
        console.log(`[ai-edge] Edge mismatch: claimed ${assessment.edgePct}% but calc'd ${expectedEdge.toFixed(1)}%, skipping`);
        continue;
      }
      if (assessment.edgePct < MIN_EDGE_PCT) continue;
      if (assessment.confidence === 'low') continue;

      stats.edgesFound++;
      console.log(`[ai-edge] EDGE: ${market.title} — ${assessment.side} ${assessment.edgePct.toFixed(1)}% (${assessment.confidence})`);
      console.log(`  Reason: ${assessment.reasoning}`);

      // Step 4: Execute
      await executeTrade(market, assessment);

      // Rate limit Claude calls
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function logStats() {
  console.log(`[ai-stats] news=${stats.newsChecked} claude=${stats.claudeCalls} edges=${stats.edgesFound} trades=${stats.tradesPlaced} bal=$${kalshiBalance.toFixed(2)}`);
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

  // Initial poll
  await pollCycle();

  // Poll every 2 minutes
  setInterval(pollCycle, POLL_INTERVAL_MS);

  // Stats every 5 minutes
  setInterval(logStats, 5 * 60 * 1000);

  await tg(
    `🧠 <b>AI Edge Bot Started</b>\n\n` +
    `Markets: Sports + Crypto + Economics + Politics + Finance\n` +
    `Platform: Kalshi (Polymarket balance tracked, trading coming soon)\n` +
    `Min edge: ${MIN_EDGE_PCT}%\n` +
    `Max trade: $${MAX_TRADE_CAP} (25% of cash)\n` +
    `Poll: every ${POLL_INTERVAL_MS / 1000}s | Broad scan: every 5min\n\n` +
    `💰 Kalshi: $${kalshiBalance.toFixed(2)} cash + $${kalshiPositionValue.toFixed(2)} positions\n` +
    `💰 Polymarket: $${polyBalance.toFixed(2)}\n` +
    `Model: claude-haiku-4-5`
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
