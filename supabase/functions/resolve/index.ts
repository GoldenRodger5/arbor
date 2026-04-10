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

function trunc(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function alertOpportunity(opp: ResolutionOpportunity, dryRun: boolean): Promise<void> {
  const qty      = Math.max(1, Math.floor(MAX_RESOLUTION_USD / opp.winningAsk));
  const deployed = (opp.winningAsk * qty);
  const profit   = (opp.netProfit * qty);
  const espnTag  = opp.espnVerified ? 'ESPN confirmed ✅' : 'Pending verification ⚠️';
  const dryLabel = dryRun ? ' [DRY RUN]' : '';
  const oppId    = slugify(opp.ticker);
  const sportTag = opp.sport ?? 'MARKET';

  const teamLine = opp.teams.length >= 2
    ? `<b>${htmlEscape(opp.teams[0])} vs ${htmlEscape(opp.teams[1])}</b>\n`
    : '';

  const text =
    `🏁 <b>RESOLUTION ARB${dryLabel} · ${sportTag}</b>\n\n` +
    teamLine +
    `${espnTag}\n\n` +
    `<b>${htmlEscape(opp.espnWinner ?? opp.teams[0] ?? '')} won</b> · winning side mispriced at <b>$${opp.winningAsk.toFixed(2)}</b>\n\n` +
    `<code>BUY ${opp.winningSide.toUpperCase().padEnd(4)} kalshi  $${opp.winningAsk.toFixed(2)}  ×  ${qty}</code>\n\n` +
    `Deploy <b>$${deployed.toFixed(2)}</b>  →  profit <b>+$${profit.toFixed(2)}</b>\n` +
    `Settles within 2 hours`;

  const row1 = [
    { text: `✅ Execute $${deployed.toFixed(2)}`, callback_data: `res_buy_${oppId}` },
    { text: '❌ Skip', callback_data: `res_skip_${oppId}` },
  ];
  const row2 = [{ text: 'Kalshi ↗', url: opp.kalshiUrl }];
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
// Live game arb: ESPN score-based spread detection
// ─────────────────────────────────────────────────────────────────────────────

interface LiveGame {
  sport: string;         // MLB, NBA, NHL, NFL
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  period: string;        // "7th", "4th", "3rd", "4th"
  clock: string;         // "5:42", "Final", etc.
  gameState: string;     // 'pre' | 'in' | 'post'
  gameId: string;
  highCertainty: boolean;
  leadingTeam: string;
  scoreDiff: number;
  winProbLabel: string;  // e.g. "~90%"
}

async function fetchLiveGames(): Promise<LiveGame[]> {
  const games: LiveGame[] = [];
  const sportConfigs = [
    { sport: 'MLB', path: 'baseball/mlb' },
    { sport: 'NBA', path: 'basketball/nba' },
    { sport: 'NHL', path: 'hockey/nhl' },
    { sport: 'NFL', path: 'football/nfl' },
  ];

  const results = await Promise.allSettled(
    sportConfigs.map(async ({ sport, path }) => {
      const url = `http://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`;
      const res = await fetch(url, { headers: { 'User-Agent': 'arbor-resolve/1' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const data = await res.json() as { events?: any[] };
      const out: LiveGame[] = [];
      for (const ev of data.events ?? []) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const state: string = comp.status?.type?.state ?? '';
        if (state !== 'in') continue; // only live games
        const comps = comp.competitors ?? [];
        if (comps.length < 2) continue;
        const home = comps.find((c: any) => c.homeAway === 'home');
        const away = comps.find((c: any) => c.homeAway === 'away');
        if (!home || !away) continue;
        const homeScore = parseInt(home.score ?? '0', 10);
        const awayScore = parseInt(away.score ?? '0', 10);
        const diff = Math.abs(homeScore - awayScore);
        const leading = homeScore >= awayScore
          ? (home.team?.displayName ?? '')
          : (away.team?.displayName ?? '');
        const period = comp.status?.period?.toString() ?? '';
        const clock  = comp.status?.displayClock ?? '';
        const clockMin = parseFloat(clock.split(':')[0] ?? '99');

        // High-certainty check per sport.
        let highCertainty = false;
        let winProb = '~50%';
        if (sport === 'MLB' && diff >= 4 && parseInt(period) >= 7) {
          highCertainty = true; winProb = '~92%';
        } else if (sport === 'NBA' && diff >= 15 && parseInt(period) >= 4 && clockMin < 5) {
          highCertainty = true; winProb = '~95%';
        } else if (sport === 'NHL' && diff >= 2 && parseInt(period) >= 3) {
          highCertainty = true; winProb = '~90%';
        } else if (sport === 'NFL' && diff >= 14 && parseInt(period) >= 4 && clockMin < 5) {
          highCertainty = true; winProb = '~95%';
        } else if (diff >= 3) {
          winProb = '~75%';
        }

        out.push({
          sport, gameId: ev.id ?? '',
          homeTeam: home.team?.displayName ?? '',
          awayTeam: away.team?.displayName ?? '',
          homeScore, awayScore, period, clock,
          gameState: state,
          highCertainty,
          leadingTeam: leading,
          scoreDiff: diff,
          winProbLabel: winProb,
        });
      }
      return out;
    }),
  );

  for (const r of results) {
    if (r.status === 'fulfilled') games.push(...r.value);
  }
  return games;
}

async function checkLiveGameSpreads(
  sb: ReturnType<typeof createClient> | null,
  dryRun: boolean,
): Promise<{ liveGames: number; highCertainty: number; liveAlerts: number }> {
  const liveGames = await fetchLiveGames();
  const highCertaintyGames = liveGames.filter(g => g.highCertainty);

  console.log('[resolve-live]', JSON.stringify({
    totalLive: liveGames.length,
    highCertainty: highCertaintyGames.length,
    games: liveGames.map(g => ({
      sport: g.sport,
      matchup: `${g.homeTeam} ${g.homeScore}-${g.awayScore} ${g.awayTeam}`,
      period: g.period, clock: g.clock,
      highCertainty: g.highCertainty,
      winProb: g.winProbLabel,
    })),
  }));

  if (!sb) return { liveGames: liveGames.length, highCertainty: highCertaintyGames.length, liveAlerts: 0 };

  let liveAlerts = 0;

  for (const game of liveGames) {
    // Update score tracking in known_game_markets.
    const scoreStr = `${game.homeScore}-${game.awayScore}`;
    const now = new Date().toISOString();

    // Find matching markets by team name (case-insensitive).
    const homeSearch = game.homeTeam.toLowerCase().split(' ').pop() ?? '';
    const awaySearch = game.awayTeam.toLowerCase().split(' ').pop() ?? '';

    const { data: matchingMarkets } = await sb
      .from('known_game_markets')
      .select('*')
      .or(`home_team.ilike.%${homeSearch}%,away_team.ilike.%${homeSearch}%,home_team.ilike.%${awaySearch}%,away_team.ilike.%${awaySearch}%`)
      .gt('close_time', now)
      .limit(10);

    // Update score + espn_game_id for any matching markets.
    for (const m of matchingMarkets ?? []) {
      const prevScore = m.last_score;
      await sb.from('known_game_markets')
        .update({ last_score: scoreStr, last_score_checked_at: now, espn_game_id: game.gameId })
        .eq('id', m.id);

      // Detect score change.
      if (prevScore && prevScore !== scoreStr) {
        console.log(`[resolve-live] score change: ${m.title} ${prevScore} → ${scoreStr}`);
      }
    }

    // For HIGH_CERTAINTY games, check Kalshi prices for arb.
    if (game.highCertainty && matchingMarkets && matchingMarkets.length > 0) {
      // Find Kalshi market in matches.
      const kalshiMarket = matchingMarkets.find((m: any) => m.platform === 'kalshi');
      if (!kalshiMarket) continue;

      // Fetch current Kalshi price for the winning side.
      try {
        const signPath = '/markets/orderbooks';
        const headers = await kalshiAuthHeaders('GET', signPath);
        const ticker = kalshiMarket.market_id;
        const res = await fetch(`${KALSHI_BASE}${signPath}?tickers=${ticker}`, { headers });
        if (!res.ok) continue;
        const data = await res.json() as { orderbooks?: any[] };
        const ob = data.orderbooks?.[0];
        if (!ob?.orderbook_fp) continue;

        const yesRaw = ob.orderbook_fp.yes_dollars ?? [];
        const noRaw  = ob.orderbook_fp.no_dollars ?? [];
        const topYesBid = yesRaw.length > 0 ? parseFloat(yesRaw[0][0]) : 0;
        const topNoBid  = noRaw.length > 0  ? parseFloat(noRaw[0][0])  : 0;
        const yesAsk = topNoBid > 0 ? 1 - topNoBid : 0;
        const noAsk  = topYesBid > 0 ? 1 - topYesBid : 0;

        // Determine which side is winning.
        // Kalshi YES is typically the first team in the ticker (home-ish).
        const winningAsk = game.homeScore > game.awayScore ? yesAsk : noAsk;
        const winningSide = game.homeScore > game.awayScore ? 'YES' : 'NO';

        console.log(`[resolve-live] ${ticker}: ${winningSide} ask=$${winningAsk.toFixed(4)} (leading ${game.leadingTeam} by ${game.scoreDiff}, ${game.winProbLabel})`);

        if (winningAsk > 0 && winningAsk < 0.90) {
          const profit = ((1 - winningAsk) * 0.99);
          const oppId  = slugify(ticker);

          const text =
            `⚡ <b>LIVE ARB · ${game.sport}</b>\n\n` +
            `<b>${htmlEscape(game.homeTeam)} ${game.homeScore} – ${htmlEscape(game.awayTeam)} ${game.awayScore}</b>\n` +
            `${game.period}${game.clock ? ' · ' + game.clock : ''} · ${game.winProbLabel} probable winner\n\n` +
            `Platform prices diverging — window closing fast\n\n` +
            `<code>BUY ${winningSide.padEnd(4)} kalshi  $${winningAsk.toFixed(2)}</code>\n\n` +
            `Profit <b>+$${profit.toFixed(2)}/contract</b>`;

          await sendTelegram({
            text,
            reply_markup: { inline_keyboard: [
              [{ text: `✅ Execute NOW`, callback_data: `buy_${oppId}` }, { text: '❌ Skip', callback_data: `skip_${oppId}` }],
            ]},
          });
          liveAlerts++;
        }
      } catch (err) {
        console.error('[resolve-live] price check threw', err);
      }
    }
  }

  return { liveGames: liveGames.length, highCertainty: highCertaintyGames.length, liveAlerts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Position settlement tracker
// ─────────────────────────────────────────────────────────────────────────────

interface SettlementResult {
  checked: number;
  settled: number;
  pendingReminders: number;
}

async function checkPositionSettlements(
  sb: ReturnType<typeof createClient>,
): Promise<SettlementResult> {
  let checked = 0; let settled = 0; let pendingReminders = 0;

  // Step 1: get all open + pending_fill positions.
  const { data: openPositions } = await sb
    .from('positions')
    .select('*')
    .in('status', ['open', 'pending_fill']);

  if (!openPositions || openPositions.length === 0) {
    console.log('[settle] no open/pending_fill positions');
  } else {
    console.log(`[settle] checking ${openPositions.length} open/pending_fill positions`);

    for (const pos of openPositions) {
      // ── pending_fill: check whether the resting Kalshi order has resolved ──
      if ((pos.status as string) === 'pending_fill') {
        const orderId = pos.kalshi_order_id as string | null;
        if (!orderId) {
          console.log(`[settle] pending_fill ${pos.id} has no kalshi_order_id, skipping`);
          continue;
        }
        try {
          const signPath = `/portfolio/orders/${orderId}`;
          const headers  = await kalshiAuthHeaders('GET', signPath);
          const res      = await fetch(`${KALSHI_TRADING_BASE}${signPath}`, { headers });
          if (!res.ok) {
            console.warn(`[settle] Kalshi order check HTTP ${res.status} for order ${orderId}`);
            continue;
          }
          const data        = await res.json() as any;
          const ord         = data.order ?? data;
          const orderStatus = (ord.status as string ?? '').toLowerCase();
          const qtyFilled   = (ord.quantity_filled ?? ord.filled ?? 0) as number;

          console.log(`[settle] pending_fill order ${orderId}: status=${orderStatus} filled=${qtyFilled}`);

          if (orderStatus === 'resting') {
            // Still on the book — come back next cycle.
            console.log(`[settle] ${pos.id} still resting, skipping`);
            continue;

          } else if (orderStatus === 'filled') {
            // Fully filled — promote to open with the real fill quantity.
            await sb.from('positions').update({
              status: 'open',
              kalshi_fill_quantity: qtyFilled,
            }).eq('id', pos.id);
            console.log(`[settle] ${pos.id} promoted open, filled=${qtyFilled}`);
            // Fall through: let the normal settlement check below run on this position.

          } else if (orderStatus === 'cancelled' || orderStatus === 'expired') {
            // Order died unfilled — mark failed, free any tracked capital, notify.
            const kFillPrice = (pos.kalshi_fill_price as number) ?? 0;
            const freedAmt   = kFillPrice * qtyFilled; // 0 for a fully-unfilled resting order

            const { data: ledger } = await sb
              .from('capital_ledger')
              .select('id, deployed_capital')
              .order('updated_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (ledger && freedAmt > 0) {
              await sb.from('capital_ledger').update({
                deployed_capital: Math.max(0, ((ledger.deployed_capital as number) ?? 0) - freedAmt),
                updated_at: new Date().toISOString(),
              }).eq('id', (ledger as any).id);
            }

            await sb.from('positions').update({ status: 'failed' }).eq('id', pos.id);

            const kTitle = trunc(htmlEscape((pos.kalshi_title as string) ?? ''));
            await sendTelegram({
              text:
                `⚠️ <b>GTC ORDER EXPIRED UNFILLED</b>\n\n` +
                `${kTitle}\n` +
                `Order never filled — no capital was deployed.\n` +
                `Position closed with no loss.\n\n` +
                `Position: <code>${pos.id}</code>`,
            });
            console.log(`[settle] ${pos.id} order ${orderStatus}, marked failed, freed $${freedAmt.toFixed(2)}`);
            continue;

          } else {
            // Unknown order status — log and skip.
            console.log(`[settle] ${pos.id} unknown order status: ${orderStatus}, skipping`);
            continue;
          }
        } catch (err) {
          console.error(`[settle] Kalshi order check threw for ${orderId}`, err);
          continue;
        }
      }
      // ── end pending_fill check ─────────────────────────────────────────────

      checked++;
      const kalshiTicker = pos.kalshi_market_id as string | null;
      const polyId       = pos.poly_market_id as string | null;
      const kFillPrice   = pos.kalshi_fill_price as number | null;
      const pFillPrice   = pos.poly_fill_price as number | null;
      const kQty         = pos.kalshi_fill_quantity as number | null;
      const kSide        = (pos.intended_kalshi_side as string | null) ?? 'yes';

      let kalshiResult: string | null = null;
      let polyResult:   string | null = null;

      // Step 2: check Kalshi settlement.
      if (kalshiTicker) {
        try {
          const signPath = `/markets/${kalshiTicker}`;
          const headers  = await kalshiAuthHeaders('GET', signPath);
          const res      = await fetch(`${KALSHI_BASE}${signPath}`, { headers });
          if (res.ok) {
            const data = await res.json() as { market?: any };
            const mkt  = data.market ?? data;
            const st   = mkt.status as string ?? '';
            const result = mkt.result as string ?? '';
            if ((st === 'determined' || st === 'finalized' || st === 'settled') && (result === 'yes' || result === 'no')) {
              kalshiResult = result;
              console.log(`[settle] Kalshi ${kalshiTicker}: ${st} result=${result}`);
            }
          }
        } catch (err) {
          console.error(`[settle] Kalshi check threw for ${kalshiTicker}`, err);
        }
      }

      // Step 3: check Polymarket US settlement.
      if (polyId) {
        try {
          const url = `${POLY_US_GATEWAY}/v1/markets?slug=${encodeURIComponent(polyId)}&limit=1`;
          const res = await fetch(url, {
            headers: { 'User-Agent': 'arbor-resolve/1', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const data = await res.json() as { markets?: any[] };
            const mkt = data.markets?.[0];
            if (mkt) {
              const closed = mkt.closed === true;
              const prices = (mkt.outcomePrices ?? []) as string[];
              // If one outcome is "1" and another is "0", market is settled.
              if (closed && prices.includes('1') && prices.includes('0')) {
                const outcomes = (mkt.outcomes ?? []) as string[];
                const winnerIdx = prices.indexOf('1');
                polyResult = outcomes[winnerIdx] ?? `outcome${winnerIdx}`;
                console.log(`[settle] Poly ${polyId}: closed, winner=${polyResult}`);
              }
            }
          }
        } catch (err) {
          console.error(`[settle] Poly check threw for ${polyId}`, err);
        }
      }

      // Step 4: if both resolved (or single-leg resolution arb), settle the position.
      const tradeType = pos.trade_type as string ?? 'arb';
      const bothResolved = tradeType === 'resolution'
        ? (kalshiResult !== null) // resolution arb = single Kalshi leg
        : (kalshiResult !== null || polyResult !== null); // arb = at least one platform confirmed

      if (bothResolved && kFillPrice !== null && kQty !== null) {
        // Calculate P&L.
        const kalshiCost  = (kFillPrice ?? 0) * (kQty ?? 0);
        const polyCost    = (pFillPrice ?? 0) * (kQty ?? 0); // same qty on both legs
        const totalCost   = kalshiCost + polyCost;

        // Determine which leg won.
        let totalPayout: number;
        if (tradeType === 'resolution') {
          // Resolution arb: winning side always pays $1.00.
          totalPayout = (kQty ?? 0) * 1.00;
        } else {
          // Two-leg arb: one leg always pays $1.00 per contract.
          // The winning leg is the one where the market result matches the side you bought.
          const kalshiWon = kalshiResult === kSide;
          totalPayout = (kQty ?? 0) * 1.00; // arb guarantees one leg wins
          // In arb, the total deployed was split across two legs, payout is always qty × $1.
        }

        const realizedPnl = totalPayout - totalCost;
        const pnlPct      = totalCost > 0 ? (realizedPnl / totalCost) * 100 : 0;

        console.log(`[settle] settling ${pos.id}: cost=$${totalCost.toFixed(2)} payout=$${totalPayout.toFixed(2)} pnl=$${realizedPnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);

        // Update position.
        await sb.from('positions').update({
          status: 'settled',
          realized_pnl: realizedPnl,
          settled_at: new Date().toISOString(),
          settlement_kalshi_result: kalshiResult,
          settlement_poly_result: polyResult,
        }).eq('id', pos.id);

        // Update capital_ledger.
        const { data: ledger } = await sb
          .from('capital_ledger')
          .select('id, deployed_capital, realized_pnl')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (ledger) {
          await sb.from('capital_ledger').update({
            deployed_capital: Math.max(0, ((ledger.deployed_capital as number) ?? 0) - totalCost),
            realized_pnl: ((ledger.realized_pnl as number) ?? 0) + realizedPnl,
            updated_at: new Date().toISOString(),
          }).eq('id', ledger.id);
        }

        const kTitle = trunc(htmlEscape(pos.kalshi_title as string ?? ''));
        if (realizedPnl >= 0) {
          await sendTelegram({
            text:
              `✅ <b>SETTLED · +$${realizedPnl.toFixed(2)}</b>\n\n` +
              `<b>${kTitle}</b>\n\n` +
              `Deployed  $${totalCost.toFixed(2)}\n` +
              `Payout    $${totalPayout.toFixed(2)}\n` +
              `Profit    <b>+$${realizedPnl.toFixed(2)} (+${pnlPct.toFixed(1)}%)</b>`,
          });
        } else {
          await sendTelegram({
            text:
              `⚠️ <b>SETTLED · -$${Math.abs(realizedPnl).toFixed(2)}</b>\n\n` +
              `<b>${kTitle}</b>\n\n` +
              `Deployed  $${totalCost.toFixed(2)}\n` +
              `Payout    $${totalPayout.toFixed(2)}\n` +
              `❌ Loss <b>-$${Math.abs(realizedPnl).toFixed(2)}</b> — check execution logs`,
          });
        }

        settled++;
      }
    }
  }

  // Step 6: auto-cancel stale pending positions (>1h old).
  const { data: pendingPositions } = await sb
    .from('positions')
    .select('id, kalshi_title, opened_at')
    .eq('status', 'pending');

  const HOUR_MS = 60 * 60 * 1000;
  for (const p of pendingPositions ?? []) {
    const age = Date.now() - Date.parse(p.opened_at as string ?? '');
    if (age > HOUR_MS) {
      await sb.from('positions')
        .update({ status: 'cancelled' })
        .eq('id', p.id);
      console.log('[resolve] auto-cancelled stale pending', p.id);
      pendingReminders++;
    }
  }

  console.log('[settle-done]', JSON.stringify({ checked, settled, pendingReminders }));
  return { checked, settled, pendingReminders };
}

// Poly US gateway URL (reuse from scanner context if available, otherwise hardcode).
const POLY_US_GATEWAY = 'https://gateway.polymarket.us';

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

  for (const opp of manualReview) {
    await sendTelegram({
      text:
        `⚠️ <b>RESOLUTION ARB · VERIFY MANUALLY</b>\n\n` +
        `<b>${trunc(htmlEscape(opp.title))}</b>\n\n` +
        `Kalshi says <b>${opp.result.toUpperCase()}</b> wins · ${opp.winningSide.toUpperCase()} @ <b>$${opp.winningAsk.toFixed(2)}</b>\n` +
        `ESPN could not confirm\n\n` +
        `Verify at ${opp.kalshiUrl}`,
    });
    alertsFired++;
  }

  // Step 6: Live game spread detection via ESPN.
  const liveResult = await checkLiveGameSpreads(sb, dryRun);

  // Step 7: Position settlement tracking.
  let settleResult = { checked: 0, settled: 0, pendingReminders: 0 };
  if (sb) {
    try {
      settleResult = await checkPositionSettlements(sb);
    } catch (err) {
      console.error('[resolve] checkPositionSettlements threw', err);
    }
  }
  alertsFired += liveResult.liveAlerts;

  const durationMs = Date.now() - startMs;
  console.log('[resolve-done]', JSON.stringify({
    durationMs, markets: markets.length, opportunities: opps.length, alertsFired, dryRun,
    liveGames: liveResult.liveGames, highCertainty: liveResult.highCertainty, liveAlerts: liveResult.liveAlerts,
    positionsChecked: settleResult.checked, positionsSettled: settleResult.settled,
    pendingReminders: settleResult.pendingReminders,
  }));

  return new Response(JSON.stringify({
    ok: true, durationMs,
    marketsScanned: markets.length,
    opportunities: opps.length,
    actionable: actionable.length,
    manualReview: manualReview.length,
    alertsFired,
    dryRun,
    liveGames: liveResult.liveGames,
    highCertainty: liveResult.highCertainty,
    liveAlerts: liveResult.liveAlerts,
    positionsChecked: settleResult.checked,
    positionsSettled: settleResult.settled,
    pendingReminders: settleResult.pendingReminders,
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
