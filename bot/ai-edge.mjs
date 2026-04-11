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

const MIN_EDGE_PCT = 5;          // Claude must estimate >= 5% edge to trade
const MAX_TRADE_USD = 30;        // Conservative: $30 per directional bet
const POLL_INTERVAL_MS = 2 * 60 * 1000; // Check news every 2 minutes
const COOLDOWN_MS = 30 * 60 * 1000;     // 30 min cooldown per market after trading

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
let stats = { newsChecked: 0, claudeCalls: 0, edgesFound: 0, tradesPlaced: 0 };

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
            const notes = comp.notes ?? [];
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

  const prompt = `You are a sports prediction market analyst. Analyze this news and determine if it creates a trading edge.

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

  // Kelly sizing: f = edge / odds
  const odds = (1 / price) - 1;
  const edge = edgePct / 100;
  const kellyFraction = odds > 0 ? edge / odds : 0;
  const halfKelly = 0.5 * kellyFraction;

  // Size: half Kelly on available balance, capped at MAX_TRADE_USD
  const budget = Math.min(MAX_TRADE_USD, kalshiBalance * halfKelly);
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
      `🧠 <b>AI EDGE TRADE</b>\n\n` +
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
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Loop
// ─────────────────────────────────────────────────────────────────────────────

async function pollCycle() {
  // Refresh balance
  try {
    const bal = await kalshiGet('/portfolio/balance');
    kalshiBalance = (bal.balance ?? 0) / 100;
  } catch { /* keep old */ }

  // Step 1: Fetch news
  const newsItems = await fetchESPNNews();
  stats.newsChecked += newsItems.length;

  if (newsItems.length > 0) {
    console.log(`[ai-edge] ${newsItems.length} new items:`, newsItems.map(n => n.headline.slice(0, 50)).join(' | '));
  }

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
  console.log(`Config: MIN_EDGE=${MIN_EDGE_PCT}% MAX_TRADE=$${MAX_TRADE_USD} POLL=${POLL_INTERVAL_MS / 1000}s`);

  if (!KALSHI_API_KEY || !kalshiPrivateKey) {
    console.error('Missing Kalshi credentials');
    process.exit(1);
  }
  if (!ANTHROPIC_KEY) {
    console.error('Missing ANTHROPIC_API_KEY — Claude is required for edge assessment');
    process.exit(1);
  }

  // Initial balance
  try {
    const bal = await kalshiGet('/portfolio/balance');
    kalshiBalance = (bal.balance ?? 0) / 100;
    console.log(`[ai-edge] Balance: $${kalshiBalance.toFixed(2)}`);
  } catch (e) {
    console.error('[ai-edge] Balance check failed:', e.message);
  }

  // Initial poll
  await pollCycle();

  // Poll every 2 minutes
  setInterval(pollCycle, POLL_INTERVAL_MS);

  // Stats every 5 minutes
  setInterval(logStats, 5 * 60 * 1000);

  await tg(
    `🧠 <b>AI Edge Bot Started</b>\n\n` +
    `Min edge: ${MIN_EDGE_PCT}%\n` +
    `Max trade: $${MAX_TRADE_USD}\n` +
    `Poll: every ${POLL_INTERVAL_MS / 1000}s\n` +
    `Balance: $${kalshiBalance.toFixed(2)}\n` +
    `Model: claude-haiku-4-5`
  );

  console.log('AI edge bot running. Press Ctrl+C to stop.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
