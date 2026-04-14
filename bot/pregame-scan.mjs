/**
 * Pregame Scan — Dry Run
 *
 * Fetches tonight's real Kalshi pre-game markets, runs the exact same
 * Claude prompts the bot would use, and reports recommendations.
 * Never places any orders.
 *
 * Run: node bot/pregame-scan.mjs
 */

import { readFileSync } from 'fs';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants } from 'crypto';
import 'dotenv/config';

// ─── Config ──────────────────────────────────────────────────────────────────

const KALSHI_API_KEY  = process.env.KALSHI_API_KEY_ID ?? '';
const KALSHI_REST     = 'https://api.elections.kalshi.com/trade-api/v2';
const ANTHROPIC_KEY   = process.env.VITE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
const MAX_PRICE       = 0.85;

// ─── Kalshi auth ──────────────────────────────────────────────────────────────

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
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── ET helpers ───────────────────────────────────────────────────────────────

function etNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

// ─── Claude with web search (matches bot's claudeWithSearch exactly) ─────────

async function claudeWithSearch(prompt, { maxTokens = 600, maxSearches = 2 } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(60000),
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
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
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const textBlocks = (data.content ?? []).filter(b => b.type === 'text');
  const searches = (data.content ?? []).filter(b => b.type === 'server_tool_use').length;
  if (searches > 0) console.log(`  (used ${searches} web search${searches > 1 ? 'es' : ''})`);

  return textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : '';
}

// ─── Main pregame scan ────────────────────────────────────────────────────────

async function runPregameScan() {
  const etNowDate = etNow();
  const etHour = etNowDate.getHours();
  const toShort = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2,'0')}`;
  const todayStr = toShort(etNowDate);
  const etTmrw = new Date(etNowDate.getTime() + 24 * 60 * 60 * 1000);
  const tonightStr = etHour >= 22 ? toShort(etTmrw) : null;

  console.log(`\n🔍 PREGAME DRY-RUN SCAN — ${etNowDate.toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
  console.log(`   Today key: ${todayStr}${tonightStr ? ` / tonight: ${tonightStr}` : ''}\n`);

  const sportsSeries = ['KXNBAGAME', 'KXNHLGAME'];  // Only NBA + NHL eligible for pre-game
  const gameMap = new Map();

  for (const series of sportsSeries) {
    console.log(`Fetching Kalshi ${series}...`);
    try {
      const data = await kalshiGet(`/markets?series_ticker=${series}&status=open&limit=200`);
      const markets = data.markets ?? [];
      console.log(`  Got ${markets.length} markets`);
      for (const m of markets) {
        if (!m.yes_ask_dollars) continue;
        const ticker = m.ticker ?? '';
        if (!ticker.includes(todayStr) && !(tonightStr && ticker.includes(tonightStr))) continue;
        const lastH = ticker.lastIndexOf('-');
        const base = lastH > 0 ? ticker.slice(0, lastH) : ticker;
        const team = ticker.split('-').pop() ?? '';
        const yesAsk = parseFloat(m.yes_ask_dollars);
        const yesSubTitle = m.yes_sub_title ?? team;

        if (!gameMap.has(base)) gameMap.set(base, { tickers: [], title: m.title, base, series });
        gameMap.get(base).tickers.push({ ticker, team, teamName: yesSubTitle, yesAsk });
      }
    } catch (e) {
      console.log(`  ERROR fetching ${series}: ${e.message}`);
    }
  }

  // Build pre-game market pairs
  const preGameMarkets = [];
  for (const [base, game] of gameMap) {
    const realTeams = game.tickers.filter(t => t.team.toUpperCase() !== 'TIE');
    if (realTeams.length < 2) continue;
    if (realTeams[0].yesAsk > MAX_PRICE && realTeams[1].yesAsk > MAX_PRICE) continue;
    if (realTeams[0].yesAsk < 0.15 && realTeams[1].yesAsk < 0.15) continue;
    preGameMarkets.push({
      title: game.title, base, series: game.series,
      team1: { ticker: realTeams[0].ticker, team: realTeams[0].team, teamName: realTeams[0].teamName, price: realTeams[0].yesAsk },
      team2: { ticker: realTeams[1].ticker, team: realTeams[1].team, teamName: realTeams[1].teamName, price: realTeams[1].yesAsk },
    });
  }

  console.log(`\n📋 Found ${preGameMarkets.length} pre-game markets tonight:\n`);
  for (const m of preGameMarkets) {
    const sport = m.base.includes('NBA') ? 'NBA' : m.base.includes('NHL') ? 'NHL' : '???';
    console.log(`  [${sport}] ${m.team1.teamName} (${m.team1.team}) ${(m.team1.price*100).toFixed(0)}¢  vs  ${m.team2.teamName} (${m.team2.team}) ${(m.team2.price*100).toFixed(0)}¢`);
    console.log(`         Base: ${m.base}`);
  }

  if (preGameMarkets.length === 0) {
    console.log('No eligible markets found. Markets may not be open yet or games are already in progress.');
    return;
  }

  // Build prompts — identical to bot's checkPreGamePredictions
  const todayDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });
  const preGameBaselines = { mlb: 0.54, nba: 0.63, nhl: 0.59 };
  const sportCapBonus    = { mlb: 0.08, nba: 0.20, nhl: 0.15 };
  const PRE_GAME_MIN_CONF = 0.70;
  const PG_REQ_MARGIN = 0.04;  // 4% edge required

  console.log(`\n🤖 Running Claude scans on ${preGameMarkets.length} games...\n`);

  const results = [];

  for (const market of preGameMarkets) {
    const sport = market.base.includes('NBA') ? 'NBA' : 'NHL';
    const sportKey = sport.toLowerCase();

    const prompt = sport === 'NBA'
      ? `You are a professional NBA bettor. Predict who wins this game being played TODAY, ${todayDate}.\n\n` +
        `GAME: ${market.title}\n` +
        `${market.team1.teamName} (${market.team1.team}) wins: ${(market.team1.price*100).toFixed(0)}¢\n` +
        `${market.team2.teamName} (${market.team2.team}) wins: ${(market.team2.price*100).toFixed(0)}¢\n\n` +
        `BASELINE: NBA home team wins 63%. Back-to-back team loses 3-5% WR. Star player out = -10%.\n\n` +
        `═══ STEP 1 — RESEARCH (use both searches here) ═══\n` +
        `A) Is either team on a back-to-back tonight? Check tonight's schedule vs yesterday's.\n` +
        `B) Is any star player (15+ ppg) injured, questionable, or OUT today? Check today's injury report.\n` +
        `C) What is each team's home/away record this season?\n` +
        `D) Does either team have playoff/play-in implications — or is either team eliminated/tanking?\n\n` +
        `═══ STEP 2 — HARD NOs (respond {"trade":false} immediately if ANY apply) ═══\n` +
        `❌ Team you want to bet ON is resting 3+ starters tonight → NO\n` +
        `❌ Opponent is fighting for playoff seeding/clinching AND your team has nothing to play for → NO\n` +
        `❌ Your team on back-to-back AND star player is DOUBTFUL or OUT → NO\n\n` +
        `═══ STEP 3 — EDGE ANALYSIS (only if no Hard NOs) ═══\n` +
        `Start from 63% home / 37% away baseline. Adjust:\n` +
        `+ Your team has 2+ days rest vs opponent on back-to-back → UP 3-5%\n` +
        `+ Star player dominant recent form (25+ ppg last 5 games) → UP 3-5%\n` +
        `+ Opponent eliminated/tanking (nothing to play for, rotating lineup) → UP 5-8%\n` +
        `+ Strong home record (60%+ at home) vs weak away record for opponent → UP 2-4%\n` +
        `- Star player (15+ ppg) officially OUT tonight → DOWN 8-12%\n` +
        `- Your team on back-to-back (second game) → DOWN 3-5%\n` +
        `- Opponent star on a hot streak (above season average last 5) → DOWN 3-5%\n` +
        `- Your team lost 3+ straight → DOWN 3-5%\n` +
        `- H2H: opponent won 10+ of last 15 meetings → DOWN 4-6%\n\n` +
        `═══ STEP 4 — DECISION ═══\n` +
        `BUY only if ALL three are true:\n` +
        `✓ Confidence ≥ 70%\n` +
        `✓ Confidence beats price by 4+ points\n` +
        `✓ You have a specific reason why — not just "they're the better team"\n\n` +
        `JSON ONLY:\n` +
        `{"trade":false,"confidence":0.XX,"reasoning":"one sentence"}\n` +
        `OR {"trade":true,"team":"${market.team1.team}" or "${market.team2.team}","confidence":0.XX,"betAmount":20,"reasoning":"one sentence"}`

      : /* NHL */
        `You are a professional NHL bettor. Predict who wins this game being played TODAY, ${todayDate}.\n\n` +
        `GAME: ${market.title}\n` +
        `${market.team1.teamName} (${market.team1.team}) wins: ${(market.team1.price*100).toFixed(0)}¢\n` +
        `${market.team2.teamName} (${market.team2.team}) wins: ${(market.team2.price*100).toFixed(0)}¢\n\n` +
        `BASELINE: NHL home team wins 59%. Goalie is the single most important factor.\n\n` +
        `═══ STEP 1 — RESEARCH (goalie confirmation is mandatory) ═══\n` +
        `A) WHO IS CONFIRMED STARTING IN GOAL for BOTH teams tonight? This is your first search. If you cannot confirm both starters, DO NOT BET.\n` +
        `B) What is each confirmed starter's season SV% and GAA? Any recent bad form (GAA > 3.0 in last 5 starts)?\n` +
        `C) Is either team on a back-to-back or playing their 3rd game in 4 nights?\n` +
        `D) Does either team have playoff/clinching implications tonight?\n\n` +
        `═══ STEP 2 — HARD NOs (respond {"trade":false} immediately if ANY apply) ═══\n` +
        `❌ Starting goalie for the team you want to bet is NOT confirmed → NO\n` +
        `❌ Team you want to bet ON is resting 3+ skaters → NO\n` +
        `❌ Opponent has playoff/clinching implications AND your team has nothing to play for → NO\n` +
        `❌ Your team is on their 3rd game in 4 nights AND opponent is rested → NO\n\n` +
        `═══ STEP 3 — EDGE ANALYSIS (only if no Hard NOs) ═══\n` +
        `Start from 59% home / 41% away baseline. Adjust:\n` +
        `+ Elite goalie starting (SV% > .920) → UP 4-6%\n` +
        `+ Your team has better power play % AND penalty kill % → UP 2-4%\n` +
        `+ Opponent on back-to-back or 3rd in 4 nights → UP 3-5%\n` +
        `+ Your team won 4 of last 5 → UP 2-3%\n` +
        `- Goalie GAA > 3.5 in last 5 starts → DOWN 8-12%\n` +
        `- Goalie SV% .895-.910 → DOWN 4-6%\n` +
        `- Goalie SV% below .895 → DOWN 6-8%\n` +
        `- Your team on back-to-back (second game) → DOWN 3-5%\n` +
        `- Opponent's PP% is top-10 AND your PK% is bottom-10 → DOWN 3-5%\n` +
        `- Your team lost 3+ straight → DOWN 3-5%\n` +
        `- H2H: opponent won 10+ of last 15 meetings → DOWN 4-6%\n` +
        `- NOTE: If this game goes to OT, it is a 3v3 coin flip. Factor this in.\n\n` +
        `═══ STEP 4 — DECISION ═══\n` +
        `BUY only if ALL three are true:\n` +
        `✓ Confidence ≥ 70%\n` +
        `✓ Confidence beats price by 4+ points\n` +
        `✓ Goalie is confirmed and you trust the matchup\n\n` +
        `JSON ONLY:\n` +
        `{"trade":false,"confidence":0.XX,"reasoning":"one sentence"}\n` +
        `OR {"trade":true,"team":"${market.team1.team}" or "${market.team2.team}","confidence":0.XX,"betAmount":20,"reasoning":"one sentence"}`;

    console.log(`\n━━━ [${sport}] ${market.team1.teamName} vs ${market.team2.teamName} ━━━`);
    console.log(`  Prices: ${market.team1.team} ${(market.team1.price*100).toFixed(0)}¢  /  ${market.team2.team} ${(market.team2.price*100).toFixed(0)}¢`);
    console.log(`  Calling Claude...`);

    let rawResponse;
    try {
      rawResponse = await claudeWithSearch(prompt, { maxTokens: 600, maxSearches: 2 });
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      results.push({ market, sport, error: e.message });
      continue;
    }

    if (!rawResponse) {
      console.log(`  Claude returned empty`);
      results.push({ market, sport, error: 'empty response' });
      continue;
    }

    // Extract JSON
    const jsonMatch = rawResponse.match(/\{[\s\S]*"trade"[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`  No JSON found in response. Raw: ${rawResponse.slice(0, 200)}`);
      results.push({ market, sport, rawResponse, error: 'no JSON' });
      continue;
    }

    let decision;
    try { decision = JSON.parse(jsonMatch[0]); } catch (e) {
      console.log(`  JSON parse error: ${e.message}`);
      results.push({ market, sport, rawResponse, error: 'parse error' });
      continue;
    }

    // Apply confidence cap (same as bot)
    const pgBaseline = preGameBaselines[sportKey] ?? 0.55;
    const pgCap = Math.min(0.85, pgBaseline + sportCapBonus[sportKey]);
    if ((decision.confidence ?? 0) > pgCap) {
      console.log(`  ⚠️  Confidence capped: ${(decision.confidence*100).toFixed(0)}% → ${(pgCap*100).toFixed(0)}% (pregame cap)`);
      decision.confidence = pgCap;
    }

    // Determine price for chosen side
    let chosenPrice = null;
    if (decision.trade && decision.team) {
      const t = decision.team.toUpperCase();
      if (t === market.team1.team.toUpperCase()) chosenPrice = market.team1.price;
      else if (t === market.team2.team.toUpperCase()) chosenPrice = market.team2.price;
    }

    const edge = chosenPrice != null ? (decision.confidence - chosenPrice) : null;
    const wouldTrade = decision.trade && decision.confidence >= PRE_GAME_MIN_CONF && edge != null && edge >= PG_REQ_MARGIN;

    console.log(`  CLAUDE SAYS: trade=${decision.trade} conf=${decision.confidence ? (decision.confidence*100).toFixed(0)+'%' : '?'}${decision.team ? ' team='+decision.team : ''}`);
    console.log(`  REASONING: ${decision.reasoning ?? '(none)'}`);
    if (edge != null) console.log(`  EDGE: ${(edge*100).toFixed(1)}% (need 4%)`);
    console.log(`  BOT WOULD: ${wouldTrade ? '✅ TRADE' : '❌ PASS'}`);

    results.push({ market, sport, decision, chosenPrice, edge, wouldTrade });
  }

  // ─── Summary ──────────────────────────────────────────────────────────────

  console.log('\n\n' + '═'.repeat(60));
  console.log('PREGAME SCAN SUMMARY');
  console.log('═'.repeat(60));

  const trades = results.filter(r => r.wouldTrade);
  const passes = results.filter(r => !r.wouldTrade && !r.error);
  const errors = results.filter(r => r.error);

  console.log(`\n✅ WOULD TRADE (${trades.length}):`);
  for (const r of trades) {
    const side = r.decision.team;
    const price = r.chosenPrice;
    console.log(`  [${r.sport}] ${side} @ ${(price*100).toFixed(0)}¢ — conf=${(r.decision.confidence*100).toFixed(0)}% edge=${(r.edge*100).toFixed(1)}%`);
    console.log(`    Why: ${r.decision.reasoning}`);
  }

  console.log(`\n❌ PASS (${passes.length}):`);
  for (const r of passes) {
    console.log(`  [${r.sport}] ${r.market.team1.team} vs ${r.market.team2.team} — conf=${r.decision?.confidence != null ? (r.decision.confidence*100).toFixed(0)+'%' : '?'}`);
    console.log(`    Why: ${r.decision?.reasoning ?? '(no decision)'}`);
  }

  if (errors.length > 0) {
    console.log(`\n⚠️ ERRORS (${errors.length}):`);
    for (const r of errors) {
      console.log(`  [${r.sport}] ${r.market.team1.team} vs ${r.market.team2.team}: ${r.error}`);
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('DRY RUN COMPLETE — no orders placed');
  console.log('═'.repeat(60) + '\n');
}

runPregameScan().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
