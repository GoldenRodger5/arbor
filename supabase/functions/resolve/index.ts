// resolve — Resolution arb monitor.
//
// Polls Kalshi for recently-closed game markets where:
//   1. The result is known (result='yes'|'no')
//   2. The winning side is still trading below $0.95
//
// Winning side below $1.00 after resolution = guaranteed profit.
// No hedge needed — single leg, zero directional risk.
//
// Pipeline:
//   1. Fetch Kalshi markets with status=closed (last 6h) — gives 'determined'
//      status markets. Also fetch status=settled for safety net.
//   2. For each market with a known result: check if winning price < threshold.
//   3. For sports markets, cross-check outcome via ESPN scoreboard API.
//   4. Alert via Telegram. Execute if TRADE_DRY_RUN is unset and user taps.
//
// Confirmed API field names (Apr 2026):
//   status=closed  → returns markets with status='determined' (result known, not yet finalized)
//   status=settled → returns markets with status='finalized'  (fully settled)
//   prices: yes_ask_dollars, no_ask_dollars (string floats, e.g. "0.9100")
//   result: 'yes' | 'no' | '' (empty = not yet known)
//
// ESPN scoreboard URLs:
//   MLB: site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard
//   NBA: site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard
//   NHL: site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard
//   NFL: site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
//
// Env: KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY,
//      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      TRADE_DRY_RUN (set to 'true' to skip real execution)

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_BASE        = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_TRADING_BASE = 'https://trading-api.kalshi.com/trade-api/v2';
const TG_API             = `https://api.telegram.org/bot${Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''}`;
const TELEGRAM_CHAT_ID   = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';
const GLOBAL_DRY_RUN     = Deno.env.get('TRADE_DRY_RUN') === 'true';

// Alert threshold: only fire if winning side is below this
const ARB_THRESHOLD = 0.95;
// Fee: Kalshi charges ~1% on winning contracts at settlement
const RESOLUTION_FEE_RATE = 0.01;
// Only check markets closed within last N hours
const LOOKBACK_HOURS = 6;
// $850 PredictIt-style cap per single-leg resolution trade
const MAX_RESOLUTION_USD = 200;
// Sports game ticker pattern — only these have ESPN cross-check
const SPORTS_GAME_RE = /^KX(MLB|NBA|NFL|NHL)GAME-/i;

// ESPN sport slugs
const ESPN_SPORT: Record<string, { sport: string; league: string }> = {
  MLB: { sport: 'baseball',   league: 'mlb' },
  NBA: { sport: 'basketball', league: 'nba' },
  NFL: { sport: 'football',   league: 'nfl' },
  NHL: { sport: 'hockey',     league: 'nhl' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi RSA-PSS auth (self-contained copy)
// ─────────────────────────────────────────────────────────────────────────────

let _cachedKey: CryptoKey | null = null;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
async function kalshiAuthHeaders(method: string, path: string): Promise<Record<string, string>> {
  const apiKeyId   = Deno.env.get('KALSHI_API_KEY_ID')  ?? '';
  const privateKey = Deno.env.get('KALSHI_PRIVATE_KEY') ?? '';
  if (!apiKeyId || !privateKey) return {};
  if (!_cachedKey) {
    _cachedKey = await globalThis.crypto.subtle.importKey(
      'pkcs8', pemToArrayBuffer(privateKey),
      { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign'],
    );
  }
  const ts  = String(Date.now());
  const fullPath = path.startsWith('/trade-api/v2') ? path : `/trade-api/v2${path}`;
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 }, _cachedKey,
    new TextEncoder().encode(`${ts}${method}${fullPath}`),
  );
  return {
    'KALSHI-ACCESS-KEY': apiKeyId, 'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': b64(sig), 'Content-Type': 'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface KalshiMarketRaw {
  ticker: string;
  event_ticker?: string;
  title?: string;
  status?: string;       // 'active' | 'determined' | 'finalized'
  result?: string;       // 'yes' | 'no' | ''
  yes_ask_dollars?: string | null;
  no_ask_dollars?: string | null;
  close_time?: string;
  expiration_time?: string;
  expected_expiration_time?: string;
  yes_sub_title?: string;  // typically the YES winner label
  no_sub_title?: string;
}

interface ResolutionOpportunity {
  ticker: string;
  title: string;
  eventTicker: string;
  result: 'yes' | 'no';
  winningSide: 'yes' | 'no';
  winningAsk: number;
  profit: number;      // gross (1 - winningAsk)
  netProfit: number;   // after ~1% fee
  netPct: number;
  closedAt: string;
  sport: string | null;
  teams: string[];
  // ESPN verification
  espnVerified: boolean;
  espnWinner: string | null;
  kalshiUrl: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sport ticker parsing (self-contained copy)
// ─────────────────────────────────────────────────────────────────────────────

const MLB_CODES: Readonly<Record<string, string>> = {
  ARI:'diamondbacks',ATL:'braves',BAL:'orioles',BOS:'red sox',CHC:'cubs',CIN:'reds',
  CLE:'guardians',COL:'rockies',CWS:'white sox',CHW:'white sox',DET:'tigers',HOU:'astros',
  KCR:'royals',KCO:'royals',LAA:'angels',LAD:'dodgers',MIA:'marlins',MIL:'brewers',
  MIN:'twins',NYM:'mets',NYY:'yankees',OAK:'athletics',ATH:'athletics',PHI:'phillies',
  PIT:'pirates',SDP:'padres',SEA:'mariners',SFG:'giants',STL:'cardinals',TBR:'rays',
  TEX:'rangers',TOR:'blue jays',WSH:'nationals',WAS:'nationals',
};
const NBA_CODES: Readonly<Record<string, string>> = {
  ATL:'hawks',BOS:'celtics',BKN:'nets',BRK:'nets',CHA:'hornets',CHO:'hornets',
  CHI:'bulls',CLE:'cavaliers',DAL:'mavericks',DEN:'nuggets',DET:'pistons',GSW:'warriors',
  HOU:'rockets',IND:'pacers',LAC:'clippers',LAL:'lakers',MEM:'grizzlies',MIA:'heat',
  MIL:'bucks',MIN:'timberwolves',NOP:'pelicans',NYK:'knicks',OKC:'thunder',ORL:'magic',
  PHI:'sixers',PHX:'suns',POR:'blazers',SAC:'kings',SAS:'spurs',TOR:'raptors',UTA:'jazz',WAS:'wizards',
};
const NFL_CODES: Readonly<Record<string, string>> = {
  ARI:'cardinals',ATL:'falcons',BAL:'ravens',BUF:'bills',CAR:'panthers',CHI:'bears',
  CIN:'bengals',CLE:'browns',DAL:'cowboys',DEN:'broncos',DET:'lions',GB:'packers',GNB:'packers',
  HOU:'texans',IND:'colts',JAC:'jaguars',JAX:'jaguars',KC:'chiefs',KAN:'chiefs',LV:'raiders',
  LVR:'raiders',LAC:'chargers',LAR:'rams',MIA:'dolphins',MIN:'vikings',NE:'patriots',
  NWE:'patriots',NO:'saints',NOR:'saints',NYG:'giants',NYJ:'jets',PHI:'eagles',PIT:'steelers',
  SF:'49ers',SFO:'49ers',SEA:'seahawks',TB:'buccaneers',TAM:'buccaneers',TEN:'titans',WAS:'commanders',
};
const NHL_CODES: Readonly<Record<string, string>> = {
  ANA:'ducks',ARI:'coyotes',BOS:'bruins',BUF:'sabres',CGY:'flames',CAR:'hurricanes',
  CHI:'blackhawks',COL:'avalanche',CBJ:'blue jackets',DAL:'stars',DET:'red wings',EDM:'oilers',
  FLA:'panthers',LAK:'kings',MIN:'wild',MTL:'canadiens',NSH:'predators',NJD:'devils',
  NYI:'islanders',NYR:'rangers',OTT:'senators',PHI:'flyers',PIT:'penguins',SJS:'sharks',
  SEA:'kraken',STL:'blues',TBL:'lightning',TOR:'maple leafs',VAN:'canucks',VGK:'golden knights',
  WSH:'capitals',WPG:'jets',UTA:'utah hockey',
};

function parseTicker(ticker: string): { sport: string; teams: string[] } | null {
  const m = ticker.match(/^KX(MLB|NBA|NFL|NHL)GAME-/);
  if (!m) return null;
  const sport = m[1];
  const tail  = ticker.split('-').pop() ?? '';
  const codes = (tail.match(/[A-Z]+$/) ?? [])[0] ?? '';
  const map   = sport === 'MLB' ? MLB_CODES : sport === 'NBA' ? NBA_CODES : sport === 'NFL' ? NFL_CODES : NHL_CODES;
  const try2  = (a: string, b: string) => map[a] && map[b] ? [map[a], map[b]] : null;
  let teams: string[] | null = null;
  if (codes.length === 6) teams = try2(codes.slice(0,3), codes.slice(3));
  else if (codes.length === 5) teams = try2(codes.slice(0,2), codes.slice(2)) ?? try2(codes.slice(0,3), codes.slice(3));
  else if (codes.length === 4) teams = try2(codes.slice(0,2), codes.slice(2));
  return teams ? { sport, teams } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Fetch Kalshi closed/determined markets
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRecentlyClosedMarkets(): Promise<KalshiMarketRaw[]> {
  const all: KalshiMarketRaw[] = [];
  const cutoff = Date.now() - LOOKBACK_HOURS * 3_600_000;
  const signPath = '/markets';

  for (const st of ['closed', 'settled'] as const) {
    try {
      const params = new URLSearchParams({ status: st, limit: '200' });
      const headers = await kalshiAuthHeaders('GET', signPath);
      const res = await fetch(`${KALSHI_BASE}${signPath}?${params}`, { headers });
      if (!res.ok) { console.warn(`[resolve] kalshi ${st} HTTP ${res.status}`); continue; }
      const data = await res.json() as { markets?: KalshiMarketRaw[] };
      for (const m of data.markets ?? []) {
        // Filter to markets closed within lookback window.
        const closeMs = Date.parse(
          m.expected_expiration_time ?? m.expiration_time ?? m.close_time ?? '',
        );
        if (Number.isFinite(closeMs) && closeMs < cutoff) continue; // too old
        // Must have a known result to be actionable.
        if (!m.result || (m.result !== 'yes' && m.result !== 'no')) continue;
        all.push(m);
      }
    } catch (err) {
      console.error(`[resolve] kalshi fetch ${st} threw`, err);
    }
  }

  console.log('[resolve-kalshi]', JSON.stringify({ fetched: all.length }));
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Identify mispriced winning sides
// ─────────────────────────────────────────────────────────────────────────────

function findOpportunities(markets: KalshiMarketRaw[]): ResolutionOpportunity[] {
  const opps: ResolutionOpportunity[] = [];

  for (const m of markets) {
    if (!m.result || (m.result !== 'yes' && m.result !== 'no')) continue;

    const yesAsk = parseFloat(m.yes_ask_dollars ?? '1');
    const noAsk  = parseFloat(m.no_ask_dollars  ?? '1');
    if (!Number.isFinite(yesAsk) || !Number.isFinite(noAsk)) continue;

    const winningSide = m.result as 'yes' | 'no';
    const winningAsk  = winningSide === 'yes' ? yesAsk : noAsk;

    // Skip if already fully priced (1.00) or past threshold.
    if (winningAsk >= ARB_THRESHOLD) continue;
    // Skip if priced at $0 (already settled out).
    if (winningAsk <= 0.001) continue;

    const gross    = 1.0 - winningAsk;
    const netProfit = gross * (1 - RESOLUTION_FEE_RATE);
    const netPct    = netProfit / winningAsk;

    const sportInfo = parseTicker(m.event_ticker ?? m.ticker ?? '');
    const eventTicker = m.event_ticker ?? (m.ticker ?? '').split('-').slice(0, -1).join('-');
    const seriesTicker = (m.event_ticker ?? m.ticker ?? '').split('-')[0];

    opps.push({
      ticker: m.ticker ?? '',
      title:  m.title  ?? m.ticker ?? '',
      eventTicker,
      result: m.result as 'yes' | 'no',
      winningSide,
      winningAsk,
      profit:    gross,
      netProfit,
      netPct,
      closedAt: m.expected_expiration_time ?? m.expiration_time ?? m.close_time ?? '',
      sport: sportInfo?.sport ?? null,
      teams: sportInfo?.teams ?? [],
      espnVerified: false,
      espnWinner:   null,
      kalshiUrl: `https://kalshi.com/markets/${seriesTicker.toLowerCase()}`,
    });
  }

  console.log('[resolve-opps]', JSON.stringify({
    total: markets.length,
    opportunities: opps.length,
    tickers: opps.map(o => ({ ticker: o.ticker, winningAsk: o.winningAsk, side: o.winningSide })),
  }));
  return opps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: ESPN outcome verification
// ─────────────────────────────────────────────────────────────────────────────

interface ESPNGame {
  isFinal: boolean;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  winner: string;  // team display name
}

async function fetchESPNGames(sport: string): Promise<ESPNGame[]> {
  const slug = ESPN_SPORT[sport];
  if (!slug) return [];
  const url = `http://site.api.espn.com/apis/site/v2/sports/${slug.sport}/${slug.league}/scoreboard`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'arbor-resolve/1' } });
    if (!res.ok) { console.warn(`[resolve-espn] ${sport} HTTP ${res.status}`); return []; }
    const data = await res.json() as { events?: any[] };
    const games: ESPNGame[] = [];
    for (const ev of data.events ?? []) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const statusName: string = comp.status?.type?.name ?? '';
      const isFinal = statusName === 'STATUS_FINAL';
      const comps = comp.competitors ?? [];
      if (comps.length < 2) continue;
      const home = comps.find((c: any) => c.homeAway === 'home');
      const away = comps.find((c: any) => c.homeAway === 'away');
      if (!home || !away) continue;
      const homeScore = parseInt(home.score ?? '0', 10);
      const awayScore = parseInt(away.score ?? '0', 10);
      const winner = homeScore > awayScore
        ? home.team?.displayName ?? ''
        : away.team?.displayName ?? '';
      games.push({
        isFinal,
        homeTeam: home.team?.displayName ?? '',
        awayTeam: away.team?.displayName ?? '',
        homeScore, awayScore, winner,
      });
    }
    console.log(`[resolve-espn] ${sport}: ${games.length} games, ${games.filter(g=>g.isFinal).length} final`);
    return games;
  } catch (err) {
    console.error(`[resolve-espn] ${sport} threw`, err);
    return [];
  }
}

async function verifyOutcomesViaESPN(opps: ResolutionOpportunity[]): Promise<void> {
  const sportsNeeded = [...new Set(opps.filter(o => o.sport).map(o => o.sport!))];
  const gamesByLeague = new Map<string, ESPNGame[]>();
  for (const sport of sportsNeeded) {
    gamesByLeague.set(sport, await fetchESPNGames(sport));
  }

  for (const opp of opps) {
    if (!opp.sport || opp.teams.length < 2) continue;
    const games = gamesByLeague.get(opp.sport) ?? [];
    // Find final game where both teams appear in the ESPN game.
    for (const g of games) {
      if (!g.isFinal) continue;
      const gameName = `${g.homeTeam} ${g.awayTeam}`.toLowerCase();
      const t1 = opp.teams[0].toLowerCase();
      const t2 = opp.teams[1].toLowerCase();
      if (!gameName.includes(t1) && !gameName.includes(t2)) continue;
      // Match! Cross-check winner vs Kalshi result.
      opp.espnVerified = true;
      opp.espnWinner   = g.winner;

      // Kalshi YES = first team in the ticker by convention.
      const kalshiYesTeam = opp.teams[0].toLowerCase();
      const espnWinnerLower = g.winner.toLowerCase();
      const espnYesWon = espnWinnerLower.includes(kalshiYesTeam) ||
        (opp.teams[0].split(' ').length > 1 &&
         opp.teams[0].split(' ').some(w => w.length > 3 && espnWinnerLower.includes(w)));
      const kalshiSaysYesWon = opp.result === 'yes';

      if (espnYesWon !== kalshiSaysYesWon) {
        // Discrepancy — don't trade, log prominently.
        console.error('[resolve-espn] DISCREPANCY — Kalshi vs ESPN mismatch', {
          ticker: opp.ticker,
          kalshiResult: opp.result,
          espnWinner: g.winner,
          teams: opp.teams,
        });
        opp.espnVerified = false; // force manual review
      }
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram helpers
// ─────────────────────────────────────────────────────────────────────────────

function htmlEscape(s: string): string {
  return (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function slugify(s: string): string {
  return (s ?? '').replace(/[^a-zA-Z0-9]+/g,'_').slice(0,32).replace(/^_+|_+$/g,'');
}

async function sendTelegram(payload: Record<string, unknown>): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
  if (!token || !TELEGRAM_CHAT_ID) return;
  const res = await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, chat_id: TELEGRAM_CHAT_ID, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[resolve-tg] sendMessage failed', res.status, body.slice(0,200));
  }
}

async function alertOpportunity(opp: ResolutionOpportunity, dryRun: boolean): Promise<void> {
  const netPctStr = (opp.netPct * 100).toFixed(1);
  const qty       = Math.max(1, Math.floor(MAX_RESOLUTION_USD / opp.winningAsk));
  const deployed  = (opp.winningAsk * qty).toFixed(2);
  const profit    = (opp.netProfit * qty).toFixed(2);
  const sportLine = opp.sport && opp.teams.length >= 2
    ? `<b>${htmlEscape(opp.teams[0])} vs ${htmlEscape(opp.teams[1])}</b> — ${opp.sport} — GAME FINAL\n`
    : '';
  const espnLine = opp.espnVerified
    ? `✅ ESPN confirmed: <b>${htmlEscape(opp.espnWinner ?? '')}</b> won\n`
    : `⚠️ ESPN verification pending — manual confirm advised\n`;
  const dryLabel = dryRun ? ' [DRY RUN]' : '';
  const oppId    = slugify(opp.ticker);

  const text =
    `🏁 <b>RESOLUTION ARB${dryLabel}</b> — ${opp.sport ?? 'MARKET'}\n\n` +
    sportLine +
    `${htmlEscape(opp.title)}\n\n` +
    `${espnLine}\n` +
    `Kalshi result: <b>${opp.result.toUpperCase()}</b> — ${htmlEscape(opp.winningSide.toUpperCase())} side wins\n` +
    `Current ${opp.winningSide.toUpperCase()} ask: <b>$${opp.winningAsk.toFixed(4)}</b> (should be $1.00)\n\n` +
    `Buy ${opp.winningSide.toUpperCase()}: <code>kalshi @ $${opp.winningAsk.toFixed(4)} × ${qty} contracts = $${deployed}</code>\n` +
    `Guaranteed payout: <b>$${qty}.00</b>\n` +
    `Net profit: <b>$${profit} (+${netPctStr}%)</b>\n` +
    `Settles: typically within 2 hours`;

  const row1 = [
    { text: `✅ Execute $${deployed}`, callback_data: `res_buy_${oppId}` },
    { text: '❌ Skip',                  callback_data: `res_skip_${oppId}` },
  ];
  const row2 = [{ text: '📈 View on Kalshi ↗', url: opp.kalshiUrl }];

  await sendTelegram({ text, reply_markup: { inline_keyboard: [row1, row2] } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi single-leg order execution
// ─────────────────────────────────────────────────────────────────────────────

async function executeResolutionOrder(
  ticker: string,
  side: 'yes' | 'no',
  count: number,
  priceInCents: number,
  dryRun: boolean,
): Promise<{ orderId: string; filled: number } | null> {
  const body = {
    ticker, action: 'buy', side, count,
    yes_price: side === 'yes' ? priceInCents : 100 - priceInCents,
    time_in_force: 'good_til_cancelled',
  };
  if (dryRun) {
    console.log('[resolve-order-dry]', JSON.stringify({ ticker, side, count, priceInCents }));
    return { orderId: 'dry-resolve-' + Date.now(), filled: count };
  }
  try {
    const signPath = '/portfolio/orders';
    const headers  = await kalshiAuthHeaders('POST', signPath);
    const res      = await fetch(`${KALSHI_TRADING_BASE}${signPath}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as any;
    console.log('[resolve-order]', JSON.stringify({ status: res.status, ticker, side, count, response: data }));
    if (!res.ok) return null;
    const ord = data.order ?? data;
    return { orderId: ord.order_id ?? String(Date.now()), filled: ord.quantity_filled ?? count };
  } catch (err) {
    console.error('[resolve-order] threw', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  const startMs = Date.now();
  const url     = new URL(req.url);
  const dryRun  = GLOBAL_DRY_RUN || url.searchParams.get('dryRun') === '1';

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const sb = (supabaseUrl && serviceKey)
    ? createClient(supabaseUrl, serviceKey)
    : null;

  // Step 1: fetch recently closed Kalshi markets.
  const markets = await fetchRecentlyClosedMarkets();

  // Step 2: find mispriced winning sides.
  const opps = findOpportunities(markets);

  // Step 3: verify outcomes for sports markets via ESPN.
  const sportsOpps = opps.filter(o => o.sport && SPORTS_GAME_RE.test(o.ticker));
  if (sportsOpps.length > 0) await verifyOutcomesViaESPN(sportsOpps);

  // Step 4: filter to actionable opportunities.
  // Sports: require ESPN verification. Non-sports: alert for manual review only.
  const actionable  = opps.filter(o => !o.sport || o.espnVerified);
  const manualReview = opps.filter(o => o.sport && !o.espnVerified);

  console.log('[resolve-summary]', JSON.stringify({
    total: opps.length, actionable: actionable.length,
    manualReview: manualReview.length, dryRun,
  }));

  let alertsFired = 0;
  for (const opp of actionable) {
    // Persist to resolution_opportunities so trade.ts can look up by slugified ID.
    if (sb) {
      const qty = Math.max(1, Math.floor(200 / opp.winningAsk));
      await sb.from('resolution_opportunities').upsert({
        platform:             'kalshi',
        market_id:            opp.ticker,
        market_title:         opp.title,
        winning_side:         opp.winningSide,
        winning_ask:          opp.winningAsk,
        estimated_profit_pct: opp.netPct,
        detected_at:          new Date().toISOString(),
        executed:             false,
        expired:              false,
      }, { onConflict: 'platform,market_id' }).catch((e: Error) => {
        console.error('[resolve] resolution_opportunities upsert failed', e.message);
      });
    }

    // Alert via Telegram.
    await alertOpportunity(opp, dryRun);
    alertsFired++;

    // Log to spread_events for tracking.
    if (sb) {
      const pairId = `${opp.ticker}:RESOLUTION`;
      await sb.from('spread_events').upsert({
        pair_id: pairId, kalshi_market_id: opp.ticker, poly_market_id: 'N/A',
        kalshi_title: opp.title, first_net_spread: opp.netPct,
        peak_net_spread: opp.netPct, last_net_spread: opp.netPct,
        source: 'scanner', was_alerted: true,
      }, { onConflict: 'pair_id', ignoreDuplicates: true }).catch(() => {});
    }
  }

  // Alert manual-review non-verified sports opps separately.
  for (const opp of manualReview) {
    const text =
      `⚠️ <b>RESOLUTION ARB — MANUAL VERIFY REQUIRED</b>\n\n` +
      `${htmlEscape(opp.title)}\n\n` +
      `Kalshi says: <b>${opp.result.toUpperCase()}</b> wins\n` +
      `ESPN: could not verify outcome\n` +
      `${opp.winningSide.toUpperCase()} ask: <b>$${opp.winningAsk.toFixed(4)}</b>\n\n` +
      `Verify manually at: <a href="${opp.kalshiUrl}">${opp.kalshiUrl}</a>\n` +
      `If correct, execute: buy ${opp.winningSide} @ ${opp.winningAsk.toFixed(4)}`;
    await sendTelegram({ text });
    alertsFired++;
  }

  const durationMs = Date.now() - startMs;
  console.log('[resolve-done]', JSON.stringify({ durationMs, markets: markets.length, opportunities: opps.length, alertsFired, dryRun }));

  return new Response(JSON.stringify({
    ok: true, durationMs,
    marketsScanned: markets.length,
    opportunities: opps.length,
    actionable: actionable.length,
    manualReview: manualReview.length,
    alertsFired,
    dryRun,
    details: opps.map(o => ({
      ticker:       o.ticker,
      result:       o.result,
      winningSide:  o.winningSide,
      winningAsk:   o.winningAsk,
      netPct:       Number((o.netPct * 100).toFixed(2)),
      espnVerified: o.espnVerified,
      espnWinner:   o.espnWinner,
    })),
  }), { headers: { 'Content-Type': 'application/json' } });
});
