/**
 * Arbor WebSocket Arb Bot
 *
 * Long-running process that connects to both Kalshi and Polymarket websockets,
 * maintains local orderbook mirrors, and detects cross-platform arb opportunities
 * in real-time. Executes via REST API when a profitable spread is found.
 *
 * Architecture:
 *   1. On startup, fetch all sports game-winner markets from both platforms
 *   2. Build a map of matched pairs (same game on both platforms)
 *   3. Subscribe to orderbook updates for all matched markets via websocket
 *   4. On every orderbook update, recalculate spread for that pair
 *   5. If net spread > threshold, execute immediately via REST
 *
 * Run: node arb-bot.mjs
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants } from 'crypto';
import 'dotenv/config';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_API_KEY = process.env.KALSHI_API_KEY_ID ?? '';
const KALSHI_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const KALSHI_REST = 'https://api.elections.kalshi.com/trade-api/v2';

const POLY_US_KEY_ID = process.env.POLY_US_KEY_ID ?? '';
const POLY_US_SECRET = process.env.POLY_US_SECRET_KEY ?? '';
const POLY_US_REST = 'https://api.polymarket.us';
const POLY_US_WS = 'wss://ws.polymarket.us';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID ?? '';

const MIN_NET_SPREAD = parseFloat(process.env.MIN_NET_SPREAD ?? '0.01');
const MAX_TRADE_USD = parseFloat(process.env.MAX_TRADE_USD ?? '200');

// Fees: Kalshi taker 0.07 parabolic, Poly US 0.30% flat
const KALSHI_FEE_RATE = 0.07;
const POLY_FEE_RATE = 0.003;

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi Auth
// ─────────────────────────────────────────────────────────────────────────────

let kalshiPrivateKey = null;
try {
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH ?? './kalshi-private-key.pem';
  const pem = readFileSync(keyPath, 'utf-8');
  // createPrivateKey handles both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY)
  kalshiPrivateKey = createPrivateKey({ key: pem, format: 'pem' });
  console.log('[auth] Loaded Kalshi private key from', keyPath);
} catch (e) {
  // Try inline key from env
  const inline = process.env.KALSHI_PRIVATE_KEY ?? '';
  if (inline) {
    kalshiPrivateKey = createPrivateKey({ key: inline, format: 'pem' });
    console.log('[auth] Loaded Kalshi private key from env');
  } else {
    console.error('No Kalshi private key found:', e.message);
  }
}

function kalshiSign(method, path) {
  const ts = String(Date.now());
  const fullPath = path.startsWith('/trade-api/v2') ? path : `/trade-api/v2${path}`;
  const message = `${ts}${method}${fullPath}`;
  const sig = cryptoSign('sha256', Buffer.from(message), {
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
  const headers = kalshiSign('GET', path);
  const res = await fetch(`${KALSHI_REST}${path}`, { headers });
  if (!res.ok) throw new Error(`Kalshi GET ${path}: ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

// Local orderbook mirrors: ticker → { yesAsk, noAsk, yesBid, noBid }
const kalshiBooks = new Map();
const polyBooks = new Map();  // slug → { side0Price, side1Price }

// Matched pairs: baseTicker → { kalshiTicker, polySlug, teams, kalshiYesTeam }
const matchedPairs = new Map();

// Cooldown: prevent re-alerting same arb within 10 minutes
const executionCooldown = new Map(); // baseTicker → lastAlertedMs

// ESPN live games — refreshed every 2 minutes
let liveGameTeams = new Set();

// Live balances — refreshed every 60 seconds
let liveBalances = { kalshi: 0, poly: 0, total: 0, lastFetch: 0 };

async function refreshBalances() {
  try {
    const bal = await kalshiGet('/portfolio/balance');
    liveBalances.kalshi = (bal.balance ?? 0) / 100;
  } catch { /* keep old value */ }
  // Poly balance via US API would need Ed25519 auth — use the Supabase function instead
  try {
    const tradeUrl = process.env.SUPABASE_URL;
    const sKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (tradeUrl && sKey) {
      const res = await fetch(`${tradeUrl}/rest/v1/capital_ledger?select=total_capital&order=updated_at.desc&limit=1`, {
        headers: { 'apikey': sKey, 'Authorization': `Bearer ${sKey}` },
      });
      if (res.ok) {
        const rows = await res.json();
        if (rows.length > 0) liveBalances.total = rows[0].total_capital ?? 0;
      }
    }
  } catch { /* keep old value */ }
  liveBalances.lastFetch = Date.now();
  console.log(`[balance] Kalshi: $${liveBalances.kalshi.toFixed(2)} | Total: $${liveBalances.total.toFixed(2)}`);
}

let stats = { wsUpdates: 0, spreadsChecked: 0, arbsFound: 0, executed: 0 };

// Fully autonomous mode — execute trades automatically
const ALERT_ONLY = false;

// ─────────────────────────────────────────────────────────────────────────────
// Telegram
// ─────────────────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[tg] failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ESPN Live Game Filter
// ─────────────────────────────────────────────────────────────────────────────

async function refreshLiveGames() {
  const keys = new Set();
  const sports = [
    'baseball/mlb', 'basketball/nba', 'hockey/nhl', 'football/nfl',
  ];
  const results = await Promise.allSettled(
    sports.map(path =>
      fetch(`http://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`, {
        headers: { 'User-Agent': 'arbor-bot/1' },
        signal: AbortSignal.timeout(5000),
      }).then(r => r.ok ? r.json() : { events: [] })
    ),
  );
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const ev of r.value.events ?? []) {
      const comp = ev.competitions?.[0];
      if (!comp || comp.status?.type?.state !== 'in') continue;
      const names = (comp.competitors ?? [])
        .map(c => (c.team?.displayName ?? '').toLowerCase())
        .filter(Boolean).sort();
      if (names.length >= 2) keys.add(names.join(' '));
    }
  }
  liveGameTeams = keys;
  if (keys.size > 0) console.log(`[espn] ${keys.size} live games:`, [...keys].join(', '));
}

function isGameLive(teams) {
  if (!teams || teams.length < 2 || liveGameTeams.size === 0) return false;
  const key = [...teams].sort().join(' ');
  return liveGameTeams.has(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spread Calculation
// ─────────────────────────────────────────────────────────────────────────────

function calculateNetSpread(kalshiAsk, polyAsk) {
  const totalCost = kalshiAsk + polyAsk;
  const gross = 1 - totalCost;
  const kFee = KALSHI_FEE_RATE * kalshiAsk * (1 - kalshiAsk);
  const pFee = POLY_FEE_RATE * polyAsk;
  return gross - kFee - pFee;
}

async function checkArb(baseTicker) {
  const pair = matchedPairs.get(baseTicker);
  if (!pair) return;

  const kBook = kalshiBooks.get(pair.kalshiTicker);
  const pBook = polyBooks.get(pair.polySlug);
  if (!kBook || !pBook) return;

  stats.spreadsChecked++;

  // POLARITY: the Kalshi ticker suffix tells us what YES means.
  // pair.kalshiYesIsPolyS0 tells us if Kalshi YES team = Poly side 0.
  //
  // A real arb MUST buy OPPOSITE sides:
  //   If Kalshi YES = Poly S0 → hedge = Kalshi YES + Poly S1 (opposite team)
  //   If Kalshi YES = Poly S1 → hedge = Kalshi YES + Poly S0 (opposite team)
  //
  // Orientation A: Buy Kalshi YES + Buy Poly hedge side
  // Orientation B: Buy Kalshi NO  + Buy Poly Kalshi-YES side
  const polyHedgePrice = pair.kalshiYesIsPolyS0 ? pBook.side1Price : pBook.side0Price;
  const polyYesSidePrice = pair.kalshiYesIsPolyS0 ? pBook.side0Price : pBook.side1Price;

  const spreadA = calculateNetSpread(kBook.yesAsk, polyHedgePrice);
  const spreadB = calculateNetSpread(kBook.noAsk, polyYesSidePrice);

  const bestSpread = Math.max(spreadA, spreadB);
  const orientation = spreadA >= spreadB ? 'A' : 'B';

  if (bestSpread >= MIN_NET_SPREAD) {
    stats.arbsFound++;
    const kalshiPrice = orientation === 'A' ? kBook.yesAsk : kBook.noAsk;
    const polyPrice = orientation === 'A' ? polyHedgePrice : polyYesSidePrice;
    const kalshiSide = orientation === 'A' ? 'yes' : 'no';

    // Skip if game is live (in progress)
    if (isGameLive(pair.teams)) {
      return; // silently skip — live games have collapsed spreads, not real arbs
    }

    // Check cooldown (10 min)
    const lastAlert = executionCooldown.get(baseTicker) ?? 0;
    if (Date.now() - lastAlert < 10 * 60 * 1000) {
      return; // silently skip — already alerted recently
    }

    console.log(`[ARB] ${baseTicker} ${orientation} spread=${(bestSpread * 100).toFixed(2)}% K${kalshiSide}=$${kalshiPrice.toFixed(3)} P=$${polyPrice.toFixed(3)}`);
    executionCooldown.set(baseTicker, Date.now());

    if (ALERT_ONLY) {
      // Alert only — don't execute until spreads are verified real
      const totalCost = kalshiPrice + polyPrice;
      const qty = Math.max(1, Math.floor(Math.min(MAX_TRADE_USD, liveBalances.kalshi * 0.9) / totalCost));
      const deployed = qty * totalCost;
      const profit = qty * bestSpread;
      await sendTelegram(
        `🔔 <b>WS ARB DETECTED</b>\n\n` +
        `<b>${pair.teams.join(' vs ')}</b>\n\n` +
        `Kalshi ${kalshiSide.toUpperCase()} ask: $${kalshiPrice.toFixed(3)}\n` +
        `Polymarket ask: $${polyPrice.toFixed(3)}\n` +
        `Total: $${totalCost.toFixed(3)} → gross ${((1-totalCost)*100).toFixed(1)}%\n\n` +
        `Net spread: <b>${(bestSpread * 100).toFixed(2)}%</b> (after fees)\n` +
        `Qty: ${qty} → deploy $${deployed.toFixed(2)} → profit $${profit.toFixed(2)}\n\n` +
        `⚠️ <i>Alert only — verify on platforms before executing</i>`
      );
    } else {
      executeArb(pair, kalshiPrice, polyPrice, kalshiSide, bestSpread).catch(e =>
        console.error('[execute] threw:', e.message)
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

async function executeArb(pair, kalshiPrice, polyPrice, kalshiSide, netSpread) {
  const totalCost = kalshiPrice + polyPrice;
  const qty = Math.max(1, Math.floor(Math.min(MAX_TRADE_USD, liveBalances.kalshi * 0.9) / totalCost));
  const deployed = qty * totalCost;
  const profit = qty * netSpread;

  console.log(`[EXECUTE] ${pair.kalshiTicker} ${kalshiSide} qty=${qty} deployed=$${deployed.toFixed(2)} profit=$${profit.toFixed(2)}`);
  executionCooldown.set(pair.baseTicker, Date.now());

  // Step 1: Execute Polymarket first
  const polyIntent = kalshiSide === 'yes' ? 'ORDER_INTENT_BUY_SHORT' : 'ORDER_INTENT_BUY_LONG';
  let polyResult = null;
  try {
    const ts = String(Date.now());
    // Ed25519 auth would go here — for now use the trade edge function
    const tradeUrl = process.env.SUPABASE_URL
      ? `${process.env.SUPABASE_URL}/functions/v1/trade`
      : null;

    if (tradeUrl) {
      // Delegate to the existing trade function which handles sequential execution
      const res = await fetch(tradeUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          autoExecute: true,
          liveRawTotal: MAX_TRADE_USD,
          callback_query: {
            id: 'ws-arb-' + Date.now(),
            data: `buy_${pair.kalshiTicker.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 32)}`,
            message: { chat: { id: parseInt(TG_CHAT) || 0 }, message_id: 0 },
          },
        }),
      });
      console.log(`[EXECUTE] trade function returned ${res.status}`);
      stats.executed++;
    }
  } catch (e) {
    console.error('[EXECUTE] failed:', e.message);
  }

  await sendTelegram(
    `🤖 <b>WS ARB DETECTED</b>\n\n` +
    `<b>${pair.teams.join(' vs ')}</b>\n\n` +
    `Kalshi ${kalshiSide.toUpperCase()} @ $${kalshiPrice.toFixed(3)}\n` +
    `Polymarket hedge @ $${polyPrice.toFixed(3)}\n\n` +
    `Net spread: <b>${(netSpread * 100).toFixed(2)}%</b>\n` +
    `Qty: ${qty} × $${totalCost.toFixed(2)} = $${deployed.toFixed(2)}\n` +
    `Expected profit: <b>+$${profit.toFixed(2)}</b>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Market Discovery
// ─────────────────────────────────────────────────────────────────────────────

async function fetchKalshiSportsMarkets() {
  const series = ['KXMLBGAME', 'KXNBAGAME', 'KXNHLGAME', 'KXNFLGAME'];
  const markets = [];
  const baseSeen = new Set();

  for (const s of series) {
    try {
      const path = '/markets';
      const headers = kalshiSign('GET', path);
      const params = new URLSearchParams({ series_ticker: s, status: 'open', limit: '200' });
      const res = await fetch(`${KALSHI_REST}${path}?${params}`, { headers });
      if (!res.ok) continue;
      const data = await res.json();
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
        if (!yesAsk || !noAsk) continue;
        markets.push({
          ticker: m.ticker,
          title: m.title ?? '',
          yesAsk, noAsk,
          eventTicker: m.event_ticker ?? m.ticker,
        });
        kalshiBooks.set(m.ticker, { yesAsk, noAsk, yesBid: 0, noBid: 0 });
      }
    } catch (e) {
      console.error(`[init] Kalshi ${s} fetch failed:`, e.message);
    }
  }
  console.log(`[init] Kalshi: ${markets.length} game-winner markets`);
  return markets;
}

async function fetchPolymarketSportsMarkets() {
  const markets = [];
  // Paginate to catch moneyline markets which may not be on page 1
  for (let offset = 0; offset < 1000; offset += 200) {
    try {
      const res = await fetch(`https://gateway.polymarket.us/v1/markets?limit=200&offset=${offset}&active=true&closed=false`, {
        headers: { 'User-Agent': 'arbor-bot/1', 'Accept': 'application/json' },
      });
      if (!res.ok) break;
      const data = await res.json();
      const batch = data.markets ?? [];
      if (batch.length === 0) break;
      for (const m of batch) {
        if (m.closed || !m.active) continue;
        // Only moneyline (game-winner) markets — skip futures, props, drawable
        if (m.marketType !== 'moneyline') continue;
        const sides = m.marketSides ?? [];
        if (sides.length < 2) continue;
        const team0 = sides[0]?.team;
        const team1 = sides[1]?.team;
        if (!team0?.name || !team1?.name) continue;

        const slug = m.slug ?? '';
        const side0Price = parseFloat(String(sides[0].price ?? '0'));
        const side1Price = parseFloat(String(sides[1].price ?? '0'));
        if (!side0Price || !side1Price) continue;

      markets.push({
        slug,
        title: m.question ?? '',
        side0Price, side1Price,
        team0: (team0.alias ?? team0.name).toLowerCase(),
        team1: (team1.alias ?? team1.name).toLowerCase(),
      });
      polyBooks.set(slug, { side0Price, side1Price });
      }
    } catch (e) {
      console.error('[init] Poly fetch failed:', e.message);
      break;
    }
  }
  console.log(`[init] Polymarket: ${markets.length} moneyline markets`);
  return markets;
}

function matchMarkets(kalshiMarkets, polyMarkets) {
  // Build poly index by team name
  const polyByTeam = new Map();
  for (const pm of polyMarkets) {
    for (const t of [pm.team0, pm.team1]) {
      const arr = polyByTeam.get(t) ?? [];
      arr.push(pm);
      polyByTeam.set(t, arr);
    }
  }

  // Parse kalshi teams from title (e.g., "A's vs New York M Winner?")
  for (const km of kalshiMarkets) {
    // Try to find a poly market with overlapping teams
    const titleLower = km.title.toLowerCase();
    let bestPoly = null;
    let bestOverlap = 0;

    for (const [team, pms] of polyByTeam) {
      if (titleLower.includes(team) || team.split(' ').some(w => w.length > 3 && titleLower.includes(w))) {
        for (const pm of pms) {
          const overlap = (bestPoly === pm) ? bestOverlap : 0;
          if (overlap + 1 > bestOverlap || !bestPoly) {
            bestPoly = pm;
            bestOverlap = overlap + 1;
          }
        }
      }
    }

    if (bestPoly && bestOverlap >= 2) {
      const lastH = km.ticker.lastIndexOf('-');
      const baseTicker = lastH > 0 ? km.ticker.slice(0, lastH) : km.ticker;
      const suffix = km.ticker.slice(lastH + 1).toLowerCase();

      // Date check: reject cross-day matches. Extract date from ticker and Poly slug.
      const tickerDateMatch = km.ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
      let kalshiGameDate = null;
      if (tickerDateMatch) {
        const monthIdx = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
          .indexOf(tickerDateMatch[2].toUpperCase());
        kalshiGameDate = new Date(Date.UTC(2000 + parseInt(tickerDateMatch[1]), monthIdx, parseInt(tickerDateMatch[3])));
      }
      if (kalshiGameDate && bestPoly.slug) {
        const polyDateMatch = bestPoly.slug.match(/(\d{4}-\d{2}-\d{2})/);
        if (polyDateMatch) {
          const polyDate = new Date(polyDateMatch[1] + 'T00:00:00Z');
          const kalshiDay = kalshiGameDate.toISOString().slice(0, 10);
          const polyDay = polyDateMatch[1];
          if (kalshiDay !== polyDay) {
            continue; // different calendar day — not the same game
          }
        }
      }

      // Determine which Poly side corresponds to Kalshi YES.
      // The ticker suffix (e.g. "CLE" from "-CLE") is the team Kalshi YES pays for.
      // Match it against Poly team names to find which side (0 or 1) that is.
      const suffixMatchesS0 =
        bestPoly.team0.includes(suffix) ||
        suffix.length >= 3 && bestPoly.team0.split(' ').some(w => w.startsWith(suffix));
      const suffixMatchesS1 =
        bestPoly.team1.includes(suffix) ||
        suffix.length >= 3 && bestPoly.team1.split(' ').some(w => w.startsWith(suffix));

      let kalshiYesIsPolyS0;
      if (suffixMatchesS0 && !suffixMatchesS1) {
        kalshiYesIsPolyS0 = true;
      } else if (suffixMatchesS1 && !suffixMatchesS0) {
        kalshiYesIsPolyS0 = false;
      } else {
        // Ambiguous — skip this pair
        console.log(`[match] SKIP ambiguous polarity: ${km.ticker} suffix=${suffix} s0=${bestPoly.team0} s1=${bestPoly.team1}`);
        continue;
      }

      matchedPairs.set(baseTicker, {
        baseTicker,
        kalshiTicker: km.ticker,
        polySlug: bestPoly.slug,
        teams: [bestPoly.team0, bestPoly.team1],
        kalshiYesIsPolyS0,
      });
      const hedgeSide = kalshiYesIsPolyS0 ? 'S1' : 'S0';
      console.log(`[match] ${km.ticker} YES=${suffix}=Poly${kalshiYesIsPolyS0?'S0':'S1'} hedge=Poly${hedgeSide} → ${bestPoly.slug}`);
    }
  }

  console.log(`[init] Matched pairs: ${matchedPairs.size}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi WebSocket
// ─────────────────────────────────────────────────────────────────────────────

function connectKalshiWS() {
  // Kalshi WS requires auth headers on the HTTP upgrade request.
  // Sign with the EXACT WS path (not the REST prefix).
  const ts = String(Date.now());
  const wsPath = '/trade-api/ws/v2';
  const message = `${ts}GET${wsPath}`;
  const sig = cryptoSign('sha256', Buffer.from(message), {
    key: kalshiPrivateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  const authHeaders = {
    'KALSHI-ACCESS-KEY': KALSHI_API_KEY,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': sig.toString('base64'),
  };
  const ws = new WebSocket(KALSHI_WS_URL, { headers: authHeaders });

  ws.on('open', () => {
    console.log('[kalshi-ws] connected');
    // Subscribe to orderbook deltas for all matched tickers (one at a time per API docs)
    let subId = 1;
    for (const pair of matchedPairs.values()) {
      ws.send(JSON.stringify({
        id: subId++,
        cmd: 'subscribe',
        params: { channels: ['orderbook_delta'], market_ticker: pair.kalshiTicker },
      }));
    }
    console.log(`[kalshi-ws] subscribed to ${matchedPairs.size} tickers`);
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'orderbook_snapshot' || msg.type === 'orderbook_delta') {
        stats.wsUpdates++;
        const ticker = msg.msg?.market_ticker;
        if (!ticker) return;

        // WS gives us bid levels. We need ask prices. Two sources:
        //   1. Listing: yes_ask_dollars/no_ask_dollars (authoritative but stale)
        //   2. Derived: 1 - opposite_bid (real-time but wider due to bid-ask spread)
        // Strategy: on every WS update, re-fetch the individual market listing
        // for real ask prices. This adds ~100ms latency but ensures accuracy.
        // Only re-fetch if we haven't in the last 5 seconds (rate limit).
        const book = kalshiBooks.get(ticker);
        if (!book) { kalshiBooks.set(ticker, { yesAsk: 0.5, noAsk: 0.5, yesBid: 0, noBid: 0, lastFetch: 0 }); return; }

        const now = Date.now();
        if (now - (book.lastFetch ?? 0) < 5000) return; // rate limit re-fetch
        book.lastFetch = now;

        // Re-fetch individual market for real ask prices
        try {
          const mktPath = `/markets/${ticker}`;
          const mktHeaders = kalshiSign('GET', mktPath);
          const mktRes = await fetch(`${KALSHI_REST}${mktPath}`, { headers: mktHeaders });
          if (mktRes.ok) {
            const mktData = await mktRes.json();
            const mkt = mktData.market ?? mktData;
            const ya = mkt.yes_ask_dollars != null ? parseFloat(mkt.yes_ask_dollars) : null;
            const na = mkt.no_ask_dollars != null ? parseFloat(mkt.no_ask_dollars) : null;
            if (ya != null && ya > 0) book.yesAsk = ya;
            if (na != null && na > 0) book.noAsk = na;
          }
        } catch { /* keep existing prices */ }

        kalshiBooks.set(ticker, book);

        // Find which pair this ticker belongs to and check arb
        for (const [base, pair] of matchedPairs) {
          if (pair.kalshiTicker === ticker) {
            checkArb(base).catch(() => {});
            break;
          }
        }
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  ws.on('close', () => {
    console.log('[kalshi-ws] disconnected, reconnecting in 5s...');
    sendTelegram('⚠️ Kalshi WS disconnected — reconnecting...').catch(() => {});
    setTimeout(connectKalshiWS, 5000);
  });

  ws.on('error', (e) => {
    console.error('[kalshi-ws] error:', e.message);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket Polling (WS requires different auth — poll every 10s instead)
// ─────────────────────────────────────────────────────────────────────────────

async function pollPolyPrices() {
  try {
    const res = await fetch('https://gateway.polymarket.us/v1/markets?limit=200&active=true&closed=false', {
      headers: { 'User-Agent': 'arbor-bot/1', 'Accept': 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    for (const m of data.markets ?? []) {
      const slug = m.slug ?? '';
      const sides = m.marketSides ?? [];
      if (sides.length < 2 || !polyBooks.has(slug)) continue;
      const s0 = parseFloat(String(sides[0]?.price ?? '0'));
      const s1 = parseFloat(String(sides[1]?.price ?? '0'));
      if (s0 > 0 && s1 > 0) {
        const old = polyBooks.get(slug);
        if (old.side0Price !== s0 || old.side1Price !== s1) {
          polyBooks.set(slug, { side0Price: s0, side1Price: s1 });
          stats.wsUpdates++;
          // Check arb for any pair using this slug
          for (const [base, pair] of matchedPairs) {
            if (pair.polySlug === slug) {
              checkArb(base).catch(() => {});
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[poly-poll] error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats logging
// ─────────────────────────────────────────────────────────────────────────────

function logStats() {
  console.log(`[stats] updates=${stats.wsUpdates} checked=${stats.spreadsChecked} arbs=${stats.arbsFound} executed=${stats.executed} pairs=${matchedPairs.size}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Arbor WebSocket Arb Bot ===');
  console.log(`Config: MIN_NET_SPREAD=${MIN_NET_SPREAD} MAX_TRADE_USD=${MAX_TRADE_USD}`);

  if (!KALSHI_API_KEY || !kalshiPrivateKey) {
    console.error('Missing Kalshi credentials');
    process.exit(1);
  }

  // Step 1: Fetch markets
  const [kalshiMarkets, polyMarkets] = await Promise.all([
    fetchKalshiSportsMarkets(),
    fetchPolymarketSportsMarkets(),
  ]);

  // Step 2: Match pairs
  matchMarkets(kalshiMarkets, polyMarkets);

  if (matchedPairs.size === 0) {
    console.log('No matched pairs found. Waiting for markets...');
  }

  // Step 3: Fetch balances and live games
  await refreshBalances();
  await refreshLiveGames();

  // Step 4: Connect Kalshi websocket
  connectKalshiWS();

  // Step 5: Poll Polymarket every 10 seconds
  setInterval(pollPolyPrices, 10_000);

  // Step 6: Refresh ESPN live games every 2 minutes + balances every 60s
  setInterval(refreshLiveGames, 2 * 60 * 1000);
  setInterval(refreshBalances, 60_000);

  // Step 7: Refresh market discovery every 5 minutes
  setInterval(async () => {
    const [km, pm] = await Promise.all([
      fetchKalshiSportsMarkets(),
      fetchPolymarketSportsMarkets(),
    ]);
    matchMarkets(km, pm);
  }, 5 * 60 * 1000);

  // Step 8: Log stats every 30 seconds
  setInterval(logStats, 30_000);

  // Startup notification
  await sendTelegram(
    `🤖 <b>Arbor WS Bot Started</b>\n\n` +
    `Matched pairs: ${matchedPairs.size}\n` +
    `Kalshi markets: ${kalshiMarkets.length}\n` +
    `Poly markets: ${polyMarkets.length}\n` +
    `Min spread: ${(MIN_NET_SPREAD * 100).toFixed(1)}%\n` +
    `Max trade: $${MAX_TRADE_USD}`
  );

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await sendTelegram('🛑 <b>Arb Bot Stopped</b>');
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await sendTelegram('🛑 <b>Arb Bot Stopped</b>');
    process.exit(0);
  });

  console.log('Bot running. Press Ctrl+C to stop.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
