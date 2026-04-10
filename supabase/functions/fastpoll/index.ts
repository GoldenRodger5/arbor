// fastpoll — speed-optimised game-winner arb scanner.
//
// Runs every 60s via pg_cron. Total target runtime: < 15 seconds.
// Skips Claude verification entirely — polarity is deterministic for
// binary game-winner markets.
//
// Pipeline:
//   1. Fetch Kalshi game-winner markets (KXMLBGAME, KXNBAGAME, KXNHLGAME,
//      KXNFLGAME, KXMLSGAME) closing within 72h.
//   2. Fetch Polymarket sports markets (tag=sports) closing within 72h.
//   3. Load known_game_markets cache; upsert new/updated rows.
//   4. Match pairs by team name overlap (same join logic as scanner).
//   5. For each promising pair (raw spread > 2%), fetch CLOB orderbook.
//   6. Calculate net spread (sports fee 3%).
//   7. Alert via Telegram if net spread > 3% AND closes within 48h
//      AND not alerted within the last 6 hours.
//
// Env: KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY,
//      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_BASE  = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_GAMMA   = 'https://gamma-api.polymarket.com';
const POLY_CLOB    = 'https://clob.polymarket.com';
const TG_API       = `https://api.telegram.org/bot${Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''}`;
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';

const MS_PER_HOUR  = 3_600_000;
const WINDOW_MS    = 72 * MS_PER_HOUR; // fetch markets closing within 72h
const ALERT_REFIRE_MS = 6 * MS_PER_HOUR;
const MIN_RAW_SPREAD_FOR_CLOB  = 0.02;
const MIN_NET_SPREAD_FOR_ALERT = 0.03;
const ALERT_DAYS_MAX   = 2;
const SPORTS_FEE       = 0.03;
const GAME_SERIES      = ['KXMLBGAME', 'KXNBAGAME', 'KXNHLGAME', 'KXNFLGAME', 'KXMLSGAME'];

// Kelly sizing constants (mirrored from trade/index.ts)
const MIN_POSITION_USD     = 20;
const MAX_POSITION_CAUTION = 100;
const MAX_CAPITAL_FRACTION = 0.40;
const QUARTER_KELLY        = 0.25;

function calculatePositionSize(
  netSpread: number,
  totalCostPerContract: number,
  activeCapital: number,
  availableLiquidity: number,
): { contracts: number; totalDeployed: number; kellyFraction: number; limitingFactor: string } {
  if (netSpread <= 0 || totalCostPerContract <= 0) {
    return { contracts: 0, totalDeployed: 0, kellyFraction: 0, limitingFactor: 'kelly' };
  }
  const odds = (1 / totalCostPerContract) - 1;
  const kellyFraction = Math.min(odds > 0 ? netSpread / odds : 0, 1.0);
  const rawPosition   = QUARTER_KELLY * kellyFraction * activeCapital;
  const verdictCap    = MAX_POSITION_CAUTION; // game-winner pairs default to CAUTION
  const capitalCap    = MAX_CAPITAL_FRACTION * activeCapital;
  let   finalUSD      = rawPosition;
  let   limitingFactor = 'kelly';
  if (availableLiquidity < finalUSD) { finalUSD = availableLiquidity; limitingFactor = 'liquidity'; }
  if (verdictCap          < finalUSD) { finalUSD = verdictCap;         limitingFactor = 'verdict_cap'; }
  if (capitalCap          < finalUSD) { finalUSD = capitalCap;         limitingFactor = 'capital_cap'; }
  let contracts     = Math.max(0, Math.floor(finalUSD / totalCostPerContract));
  let totalDeployed = contracts * totalCostPerContract;
  if (totalDeployed < MIN_POSITION_USD && contracts > 0) {
    const minContracts = Math.ceil(MIN_POSITION_USD / totalCostPerContract);
    const minDeployed  = minContracts * totalCostPerContract;
    if (minDeployed <= Math.min(availableLiquidity, verdictCap, capitalCap)) {
      contracts = minContracts; totalDeployed = minDeployed; limitingFactor = 'minimum';
    }
  }
  return { contracts, totalDeployed, kellyFraction, limitingFactor };
}

async function fetchActiveCapital(sb: ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2.39.0').createClient>): Promise<number> {
  const { data } = await sb
    .from('capital_ledger')
    .select('total_capital,deployed_capital,safety_reserve_pct,realized_pnl')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return 400;
  return ((data.total_capital as number) ?? 500) * (1 - ((data.safety_reserve_pct as number) ?? 0.2))
       - ((data.deployed_capital as number) ?? 0)
       + ((data.realized_pnl as number) ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi RSA-PSS auth (verbatim copy from scanner — no imports)
// ─────────────────────────────────────────────────────────────────────────────

let _cachedKey: CryptoKey | null = null;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function kalshiAuthHeaders(method: string, path: string): Promise<Record<string, string>> {
  const apiKeyId   = Deno.env.get('KALSHI_API_KEY_ID')   ?? '';
  const privateKey = Deno.env.get('KALSHI_PRIVATE_KEY')  ?? '';
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
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': bufferToBase64(sig),
    'Content-Type': 'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sport ticker parsing (verbatim copy from scanner)
// ─────────────────────────────────────────────────────────────────────────────

const MLB_CODE_TO_TEAM: Readonly<Record<string, string>> = {
  ARI:'diamondbacks',ATL:'braves',BAL:'orioles',BOS:'red sox',
  CHC:'cubs',CIN:'reds',CLE:'guardians',COL:'rockies',
  CWS:'white sox',CHW:'white sox',DET:'tigers',HOU:'astros',
  KCR:'royals',KCO:'royals',LAA:'angels',LAD:'dodgers',
  MIA:'marlins',MIL:'brewers',MIN:'twins',NYM:'mets',
  NYY:'yankees',OAK:'athletics',ATH:'athletics',PHI:'phillies',
  PIT:'pirates',SDP:'padres',SEA:'mariners',SFG:'giants',
  STL:'cardinals',TBR:'rays',TEX:'rangers',TOR:'blue jays',
  WSH:'nationals',WAS:'nationals',
};
const NBA_CODE_TO_TEAM: Readonly<Record<string, string>> = {
  ATL:'hawks',BOS:'celtics',BKN:'nets',BRK:'nets',CHA:'hornets',
  CHO:'hornets',CHI:'bulls',CLE:'cavaliers',DAL:'mavericks',DEN:'nuggets',
  DET:'pistons',GSW:'warriors',HOU:'rockets',IND:'pacers',LAC:'clippers',
  LAL:'lakers',MEM:'grizzlies',MIA:'heat',MIL:'bucks',MIN:'timberwolves',
  NOP:'pelicans',NYK:'knicks',OKC:'thunder',ORL:'magic',PHI:'sixers',
  PHX:'suns',POR:'blazers',SAC:'kings',SAS:'spurs',TOR:'raptors',
  UTA:'jazz',WAS:'wizards',
};
const NFL_CODE_TO_TEAM: Readonly<Record<string, string>> = {
  ARI:'cardinals',ATL:'falcons',BAL:'ravens',BUF:'bills',CAR:'panthers',
  CHI:'bears',CIN:'bengals',CLE:'browns',DAL:'cowboys',DEN:'broncos',
  DET:'lions',GB:'packers',GNB:'packers',HOU:'texans',IND:'colts',
  JAC:'jaguars',JAX:'jaguars',KC:'chiefs',KAN:'chiefs',LV:'raiders',
  LVR:'raiders',LAC:'chargers',LAR:'rams',MIA:'dolphins',MIN:'vikings',
  NE:'patriots',NWE:'patriots',NO:'saints',NOR:'saints',NYG:'giants',
  NYJ:'jets',PHI:'eagles',PIT:'steelers',SF:'49ers',SFO:'49ers',
  SEA:'seahawks',TB:'buccaneers',TAM:'buccaneers',TEN:'titans',WAS:'commanders',
};
const NHL_CODE_TO_TEAM: Readonly<Record<string, string>> = {
  ANA:'ducks',ARI:'coyotes',BOS:'bruins',BUF:'sabres',CGY:'flames',
  CAR:'hurricanes',CHI:'blackhawks',COL:'avalanche',CBJ:'blue jackets',
  DAL:'stars',DET:'red wings',EDM:'oilers',FLA:'panthers',LAK:'kings',
  MIN:'wild',MTL:'canadiens',NSH:'predators',NJD:'devils',NYI:'islanders',
  NYR:'rangers',OTT:'senators',PHI:'flyers',PIT:'penguins',SJS:'sharks',
  SEA:'kraken',STL:'blues',TBL:'lightning',TOR:'maple leafs',VAN:'canucks',
  VGK:'golden knights',WSH:'capitals',WPG:'jets',UTA:'utah hockey',
};

interface SportInfo { sport: 'mlb'|'nba'|'nfl'|'nhl'; teams: string[]; }

function parseKalshiSportTicker(ticker: string): SportInfo | null {
  if (!ticker) return null;
  const m = ticker.match(/^KX(MLB|NBA|NFL|NHL)GAME-/);
  if (!m) return null;
  const sport = m[1].toLowerCase() as SportInfo['sport'];
  const tail = ticker.split('-').pop() ?? '';
  const alphaMatch = tail.match(/[A-Z]+$/);
  if (!alphaMatch) return null;
  const codes = alphaMatch[0];
  const map = sport === 'mlb' ? MLB_CODE_TO_TEAM
            : sport === 'nba' ? NBA_CODE_TO_TEAM
            : sport === 'nfl' ? NFL_CODE_TO_TEAM
            : NHL_CODE_TO_TEAM;
  const tryParse = (a: string, b: string) => {
    const ta = map[a], tb = map[b];
    return (ta && tb) ? [ta, tb] : null;
  };
  let teams: string[] | null = null;
  if      (codes.length === 6) teams = tryParse(codes.slice(0,3), codes.slice(3));
  else if (codes.length === 5) teams = tryParse(codes.slice(0,2), codes.slice(2)) ?? tryParse(codes.slice(0,3), codes.slice(3));
  else if (codes.length === 4) teams = tryParse(codes.slice(0,2), codes.slice(2));
  return teams ? { sport, teams } : null;
}

function parseKalshiGameDate(marketId: string): Date | null {
  if (!marketId) return null;
  const m = marketId.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})?(\d{2})?/i);
  if (!m) return null;
  const monthIdx = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(m[2].toUpperCase());
  if (monthIdx < 0) return null;
  const d = new Date(Date.UTC(2000 + parseInt(m[1],10), monthIdx, parseInt(m[3],10),
    m[4] ? parseInt(m[4],10) : 12, m[5] ? parseInt(m[5],10) : 0));
  return Number.isFinite(d.getTime()) ? d : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface KalshiGameMarket {
  ticker: string;
  title: string;
  closeTime: string;
  yesAsk: number;   // 0-1
  noAsk: number;    // 0-1
  sport: SportInfo['sport'];
  teams: string[];
  gameDate: Date | null;
  kalshiUrl: string;
}

interface PolyGameMarket {
  conditionId: string;
  title: string;
  closeTime: string;
  outcome0Label: string;
  outcome0TokenId: string;
  outcome1Label: string;
  outcome1TokenId: string;
  teams: string[];  // extracted from title
  eventSlug: string;
  polyUrl: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Fetch Kalshi game-winner markets
// ─────────────────────────────────────────────────────────────────────────────

async function fetchKalshiGameMarkets(): Promise<KalshiGameMarket[]> {
  const now = Date.now();
  const cutoff = now + WINDOW_MS;
  const markets: KalshiGameMarket[] = [];

  for (const series of GAME_SERIES) {
    try {
      const signPath = '/markets';
      const params = new URLSearchParams({
        series_ticker: series, status: 'open', limit: '100', mve_filter: 'exclude',
      });
      const headers = await kalshiAuthHeaders('GET', signPath);
      const res = await fetch(`${KALSHI_BASE}${signPath}?${params}`, { headers });
      if (!res.ok) { console.warn(`[fastpoll-kalshi] ${series} ${res.status}`); continue; }
      const data = await res.json() as { markets?: any[] };
      for (const m of data.markets ?? []) {
        if (!m.ticker) continue;
        // Kalshi game markets use status='active'. Skip anything settled/closed.
        if (m.status && m.status !== 'active' && m.status !== 'open') continue;
        // Use expected_expiration_time (actual game end) for the 72h window.
        // Fall back to close_time (settlement deadline, often +2d buffer).
        const expiryStr = m.expected_expiration_time ?? m.close_time ?? '';
        if (!expiryStr) continue;
        const expiryMs = Date.parse(expiryStr);
        if (!Number.isFinite(expiryMs) || expiryMs <= now || expiryMs > cutoff) continue;
        // Prices come back as dollar strings (yes_ask_dollars) OR integer cents (yes_ask).
        // Prefer the dollar-string fields; fall back to the integer-cent fields.
        let yesAsk: number | null = null;
        let noAsk:  number | null = null;
        if (m.yes_ask_dollars != null) {
          yesAsk = parseFloat(m.yes_ask_dollars);
          noAsk  = parseFloat(m.no_ask_dollars);
        } else if (typeof m.yes_ask === 'number') {
          yesAsk = m.yes_ask / 100;
          noAsk  = m.no_ask  / 100;
        }
        if (yesAsk === null || noAsk === null || !isFinite(yesAsk) || !isFinite(noAsk)) continue;
        if (yesAsk <= 0 || noAsk <= 0 || yesAsk >= 1 || noAsk >= 1) continue;
        const sportInfo = parseKalshiSportTicker(m.event_ticker ?? m.ticker);
        if (!sportInfo) continue;
        const seriesTicker = (m.event_ticker ?? m.ticker).split('-')[0];
        markets.push({
          ticker: m.ticker,
          title: m.title ?? m.ticker,
          closeTime: expiryStr,
          yesAsk,
          noAsk,
          sport: sportInfo.sport,
          teams: sportInfo.teams,
          gameDate: parseKalshiGameDate(m.ticker),
          kalshiUrl: `https://kalshi.com/markets/${seriesTicker.toLowerCase()}`,
        });
      }
    } catch (err) {
      console.error(`[fastpoll-kalshi] ${series} threw`, err);
    }
  }

  console.log('[fastpoll-kalshi]', JSON.stringify({ fetched: markets.length, within72h: markets.length }));
  return markets;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Fetch Polymarket sports markets
// ─────────────────────────────────────────────────────────────────────────────

// Lightweight team detection — just check if well-known team names appear.
function extractTeamsFromTitle(title: string): string[] {
  const lower = ' ' + title.toLowerCase().replace(/[^\w\s]/g, ' ') + ' ';
  const allTeams: Record<string, string[]> = {
    mlb: Object.values(MLB_CODE_TO_TEAM),
    nba: Object.values(NBA_CODE_TO_TEAM),
    nfl: Object.values(NFL_CODE_TO_TEAM),
    nhl: Object.values(NHL_CODE_TO_TEAM),
  };
  const found: string[] = [];
  for (const teams of Object.values(allTeams)) {
    for (const t of teams) {
      if (lower.includes(' ' + t + ' ') || lower.includes(' ' + t)) {
        if (!found.includes(t)) found.push(t);
      }
    }
  }
  return found;
}

function parseJsonArray(raw: string | string[] | undefined): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : null; }
  catch { return null; }
}

async function fetchPolyGameMarkets(): Promise<PolyGameMarket[]> {
  const now = Date.now();
  const endMax = new Date(now + WINDOW_MS).toISOString();
  const endMin = new Date(now).toISOString();

  const markets: PolyGameMarket[] = [];
  let totalFetched = 0;
  let binaryCount = 0;

  try {
    // Fetch via /events with sports tag
    const params = new URLSearchParams({
      active: 'true', closed: 'false', tag_slug: 'sports', limit: '100',
      end_date_min: endMin, end_date_max: endMax,
    });
    const res = await fetch(`${POLY_GAMMA}/events?${params}`);
    if (!res.ok) { console.warn('[fastpoll-polymarket] events fetch failed', res.status); }
    else {
      const events = await res.json() as Array<{ slug?: string; markets?: any[] }>;
      for (const ev of events ?? []) {
        for (const m of ev.markets ?? []) {
          totalFetched++;
          if (!m.enableOrderBook || !m.acceptingOrders) continue;
          if (m.active === false) continue;
          const tokenIds = parseJsonArray(m.clobTokenIds);
          const outcomes = parseJsonArray(m.outcomes);
          if (!tokenIds || tokenIds.length < 2 || !outcomes || outcomes.length < 2) continue;
          binaryCount++;
          const title: string = m.question ?? '';
          const teams = extractTeamsFromTitle(title);
          if (teams.length < 1) continue; // skip non-team sports markets
          const closeTime: string = m.endDate ?? '';
          const closeMs = Date.parse(closeTime);
          if (!Number.isFinite(closeMs) || closeMs <= now || closeMs > now + WINDOW_MS) continue;
          const eventSlug = ev.slug ?? m.slug ?? '';
          markets.push({
            conditionId: m.conditionId ?? '',
            title,
            closeTime,
            outcome0Label: String(outcomes[0]),
            outcome0TokenId: String(tokenIds[0]),
            outcome1Label: String(outcomes[1]),
            outcome1TokenId: String(tokenIds[1]),
            teams,
            eventSlug,
            polyUrl: eventSlug ? `https://polymarket.com/event/${eventSlug}` : '',
          });
        }
      }
    }
  } catch (err) {
    console.error('[fastpoll-polymarket] threw', err);
  }

  console.log('[fastpoll-polymarket]', JSON.stringify({ fetched: totalFetched, binary: binaryCount, withTeams: markets.length }));
  return markets;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3-4: Cache management
// ─────────────────────────────────────────────────────────────────────────────

interface KnownRow {
  platform: string;
  market_id: string;
  alerted_at: string | null;
  last_spread_pct: number | null;
}

async function upsertKalshiMarkets(
  sb: ReturnType<typeof createClient>,
  markets: KalshiGameMarket[],
  knownKalshi: Map<string, KnownRow>,
): Promise<void> {
  const now = new Date().toISOString();
  const rows = markets.map((m) => ({
    platform: 'kalshi',
    market_id: m.ticker,
    title: m.title,
    close_time: m.closeTime,
    sport_league: m.sport,
    home_team: m.teams[0] ?? null,
    away_team: m.teams[1] ?? null,
    game_date: m.gameDate ? m.gameDate.toISOString().slice(0, 10) : null,
    last_checked_at: now,
  }));
  if (rows.length === 0) return;
  const { error } = await sb.from('known_game_markets').upsert(rows, {
    onConflict: 'platform,market_id',
    ignoreDuplicates: false,
  });
  if (error) console.error('[fastpoll-cache] kalshi upsert failed', error.message);
}

async function upsertPolyMarkets(
  sb: ReturnType<typeof createClient>,
  markets: PolyGameMarket[],
): Promise<void> {
  const now = new Date().toISOString();
  const rows = markets.map((m) => ({
    platform: 'polymarket',
    market_id: m.conditionId,
    title: m.title,
    close_time: m.closeTime,
    sport_league: null,
    home_team: m.teams[0] ?? null,
    away_team: m.teams[1] ?? null,
    game_date: null,
    last_checked_at: now,
  }));
  if (rows.length === 0) return;
  const { error } = await sb.from('known_game_markets').upsert(rows, {
    onConflict: 'platform,market_id',
    ignoreDuplicates: false,
  });
  if (error) console.error('[fastpoll-cache] poly upsert failed', error.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: Pair matching
// ─────────────────────────────────────────────────────────────────────────────

interface MatchedPair {
  kalshi: KalshiGameMarket;
  poly: PolyGameMarket;
  // Polarity — deterministic for binary game-winner markets.
  // Kalshi YES = team that Kalshi chose as the YES side.
  // We find which poly outcome label best matches a Kalshi team.
  polyYesTokenId: string;   // same direction as Kalshi YES
  polyNoTokenId: string;    // hedge token (what we buy on Poly for arb)
  polyYesLabel: string;
  polyNoLabel: string;
}

function matchPairs(
  kalshiMarkets: KalshiGameMarket[],
  polyMarkets: PolyGameMarket[],
): MatchedPair[] {
  const pairs: MatchedPair[] = [];

  // Build per-team index for Polymarket: team → poly markets containing it.
  const polyByTeam = new Map<string, PolyGameMarket[]>();
  for (const pm of polyMarkets) {
    for (const t of pm.teams) {
      const key = t.toLowerCase();
      const arr = polyByTeam.get(key) ?? [];
      arr.push(pm);
      polyByTeam.set(key, arr);
    }
  }

  const claimedPoly = new Set<string>();

  for (const km of kalshiMarkets) {
    // Kalshi YES is the FIRST team in the ticker (home team by convention).
    // e.g. KXMLBGAME-26APR111610ATHNYM → teams = ['athletics', 'mets']
    // Kalshi YES = athletics win.
    const [team0, team1] = km.teams;

    // Find Polymarket markets that contain at least one of the two teams.
    const candidateSet = new Map<string, { pm: PolyGameMarket; overlap: number }>();
    for (const t of km.teams) {
      for (const pm of polyByTeam.get(t.toLowerCase()) ?? []) {
        if (claimedPoly.has(pm.conditionId)) continue;
        const existing = candidateSet.get(pm.conditionId);
        candidateSet.set(pm.conditionId, { pm, overlap: (existing?.overlap ?? 0) + 1 });
      }
    }
    if (candidateSet.size === 0) continue;

    // Pick best candidate: highest overlap, tie-break by closest close time.
    const kCloseMs = Date.parse(km.closeTime);
    let bestPm: PolyGameMarket | null = null;
    let bestOv = 0;
    let bestGap = Infinity;
    for (const { pm, overlap } of candidateSet.values()) {
      const gap = Math.abs(Date.parse(pm.closeTime) - kCloseMs);
      if (overlap > bestOv || (overlap === bestOv && gap < bestGap)) {
        bestOv = overlap; bestPm = pm; bestGap = gap;
      }
    }
    if (!bestPm || bestOv < 1) continue;
    // Reject if close times differ by more than 36h (different game instances).
    if (bestGap > 36 * MS_PER_HOUR) continue;

    claimedPoly.add(bestPm.conditionId);

    // Polarity assignment:
    // Kalshi YES = team0 (the first team parsed from the ticker).
    // Find which Poly outcome label mentions team0. That's the same direction.
    const label0 = bestPm.outcome0Label.toLowerCase();
    const label1 = bestPm.outcome1Label.toLowerCase();
    const team0Lower = team0.toLowerCase();
    const team1Lower = (team1 ?? '').toLowerCase();

    let polyYesTokenId: string;
    let polyNoTokenId: string;
    let polyYesLabel: string;
    let polyNoLabel: string;

    // Check which label contains team0 (Kalshi YES side).
    const outcome0MatchesYes = label0.includes(team0Lower) ||
      (team0Lower.split(' ').length > 1 && team0Lower.split(' ').some(w => label0.includes(w) && w.length > 3));
    const outcome1MatchesYes = label1.includes(team0Lower) ||
      (team0Lower.split(' ').length > 1 && team0Lower.split(' ').some(w => label1.includes(w) && w.length > 3));

    if (outcome0MatchesYes && !outcome1MatchesYes) {
      // Outcome 0 = Kalshi YES direction
      polyYesTokenId = bestPm.outcome0TokenId;
      polyNoTokenId  = bestPm.outcome1TokenId;
      polyYesLabel   = bestPm.outcome0Label;
      polyNoLabel    = bestPm.outcome1Label;
    } else if (outcome1MatchesYes && !outcome0MatchesYes) {
      // Outcome 1 = Kalshi YES direction
      polyYesTokenId = bestPm.outcome1TokenId;
      polyNoTokenId  = bestPm.outcome0TokenId;
      polyYesLabel   = bestPm.outcome1Label;
      polyNoLabel    = bestPm.outcome0Label;
    } else {
      // Ambiguous — fall back to matching team1 to outcome0 (hedge is same-dir).
      // If team1 is in outcome0, then outcome0 is the NO side (hedge for YES).
      const outcome0MatchesNo = label0.includes(team1Lower) ||
        (team1Lower.split(' ').length > 1 && team1Lower.split(' ').some(w => label0.includes(w) && w.length > 3));
      if (outcome0MatchesNo) {
        polyYesTokenId = bestPm.outcome1TokenId;
        polyNoTokenId  = bestPm.outcome0TokenId;
        polyYesLabel   = bestPm.outcome1Label;
        polyNoLabel    = bestPm.outcome0Label;
      } else {
        // Can't determine — skip (safer than a wrong polarity)
        console.log('[fastpoll-match] skipped ambiguous polarity', km.ticker, bestPm.title);
        continue;
      }
    }

    pairs.push({ kalshi: km, poly: bestPm, polyYesTokenId, polyNoTokenId, polyYesLabel, polyNoLabel });
  }

  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6: Spread calculation
// ─────────────────────────────────────────────────────────────────────────────

interface OrderbookLevel { price: number; size: number; }

async function fetchPolyClobBook(tokenId: string): Promise<{ bids: OrderbookLevel[]; asks: OrderbookLevel[] }> {
  try {
    const res = await fetch(`${POLY_CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
    if (!res.ok) return { bids: [], asks: [] };
    const data = await res.json() as any;
    const parse = (arr: any[]) => (arr ?? []).map((l: any) => ({
      price: parseFloat(String(l.price)),
      size:  parseFloat(String(l.size)),
    })).filter((l: OrderbookLevel) => isFinite(l.price) && isFinite(l.size));
    return { bids: parse(data.bids), asks: parse(data.asks) };
  } catch { return { bids: [], asks: [] }; }
}

interface SpreadResult {
  netSpread: number;
  grossSpread: number;
  orientation: 'A' | 'B'; // A = Kalshi YES + Poly NO, B = Kalshi NO + Poly YES
  kalshiPrice: number;
  polyPrice: number;
  quantity: number;
  kalshiSide: 'yes' | 'no';
  polyTokenId: string;   // the token we'd buy on Polymarket
  totalDeployed: number;
  maxProfit: number;
}

async function calculateSpread(pair: MatchedPair): Promise<SpreadResult | null> {
  const { kalshi } = pair;

  // Quick pre-check with stored Kalshi prices — skip CLOB fetch if hopeless.
  // Orientation A: BUY Kalshi YES + BUY Poly NO (hedge)
  const rawA = 1 - kalshi.yesAsk - (1 - 0.97); // rough estimate
  // More precise: gross = 1 - kalshiYesAsk - polyNoAsk
  // We don't have polyNoAsk yet. Use 1 - kalshi.yesAsk as a lower bound.
  // If kalshi.yesAsk alone is >= 0.98 in either orientation, skip.
  if (kalshi.yesAsk + (1 - kalshi.yesAsk) * 0.02 >= 0.98 &&
      kalshi.noAsk  + (1 - kalshi.noAsk)  * 0.02 >= 0.98) {
    return null;
  }

  // Fetch CLOB orderbooks for both poly tokens.
  const [noBook, yesBook] = await Promise.all([
    fetchPolyClobBook(pair.polyNoTokenId),
    fetchPolyClobBook(pair.polyYesTokenId),
  ]);

  const bestPolyNoAsk  = noBook.asks.sort((a,b) => a.price-b.price)[0]?.price  ?? 1;
  const bestPolyYesAsk = yesBook.asks.sort((a,b) => a.price-b.price)[0]?.price ?? 1;

  // Orientation A: BUY Kalshi YES + BUY Poly NO
  const grossA = 1 - kalshi.yesAsk - bestPolyNoAsk;
  // Orientation B: BUY Kalshi NO + BUY Poly YES
  const grossB = 1 - kalshi.noAsk  - bestPolyYesAsk;

  let best: SpreadResult | null = null;

  for (const [gross, kPrice, pPrice, kSide, pTokenId, pBook] of [
    [grossA, kalshi.yesAsk, bestPolyNoAsk,  'yes', pair.polyNoTokenId,  noBook]  as const,
    [grossB, kalshi.noAsk,  bestPolyYesAsk, 'no',  pair.polyYesTokenId, yesBook] as const,
  ]) {
    if (gross < MIN_RAW_SPREAD_FOR_CLOB) continue;
    const net = gross - SPORTS_FEE * (kPrice * (1 - kPrice) + pPrice * (1 - pPrice));
    if (net <= 0) continue;

    // Size: limited by CLOB depth + $50 cap.
    const polyQtyAvail = pBook.asks.sort((a,b) => a.price-b.price)[0]?.size ?? 0;
    const maxByBudget  = MAX_POSITION_USD / (kPrice + pPrice);
    const qty = Math.max(1, Math.min(Math.floor(polyQtyAvail), Math.floor(maxByBudget)));
    const deployed = (kPrice + pPrice) * qty;
    const profit   = gross * qty;

    if (!best || net > best.netSpread) {
      best = {
        netSpread: net, grossSpread: gross,
        orientation: kSide === 'yes' ? 'A' : 'B',
        kalshiPrice: kPrice, polyPrice: pPrice, quantity: qty,
        kalshiSide: kSide, polyTokenId: pTokenId,
        totalDeployed: deployed, maxProfit: profit,
      };
    }
  }

  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7: Telegram alert
// ─────────────────────────────────────────────────────────────────────────────

function htmlEscape(s: string): string {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function slugify(s: string): string {
  return (s||'').replace(/[^a-zA-Z0-9]+/g,'_').slice(0,32).replace(/^_+|_+$/g,'');
}

async function sendAlert(
  pair: MatchedPair,
  spread: SpreadResult,
  sb: ReturnType<typeof createClient>,
): Promise<void> {
  const { kalshi, poly } = pair;
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
  if (!token || !TELEGRAM_CHAT_ID) return;

  // Kelly sizing for this alert.
  const activeCapital = await fetchActiveCapital(sb);
  const totalCostPerContract = spread.kalshiPrice + spread.polyPrice;
  const availableLiquidity   = totalCostPerContract * spread.quantity;
  const sizing = calculatePositionSize(
    spread.netSpread, totalCostPerContract, activeCapital, availableLiquidity,
  );
  const qty            = Math.max(1, sizing.contracts);
  const kellyDeployed  = sizing.totalDeployed > 0 ? sizing.totalDeployed : totalCostPerContract * qty;

  const netPct   = (spread.netSpread * 100).toFixed(1);
  const closeMs  = Date.parse(kalshi.closeTime);
  const daysLeft = (closeMs - Date.now()) / (86_400_000);
  const closeStr = new Date(closeMs).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  }) + ' ET';

  const yesCost = spread.kalshiPrice * qty;
  const noCost  = spread.polyPrice   * qty;
  const league   = kalshi.sport.toUpperCase();
  const homeTeam = kalshi.teams[0] ?? '';
  const awayTeam = kalshi.teams[1] ?? '';

  const oppId = slugify(kalshi.ticker);

  const text =
    `🚨 <b>FAST ALERT — GAME WINNER — SAFE</b>\n\n` +
    `<b>${htmlEscape(homeTeam)} vs ${htmlEscape(awayTeam)}</b> — ${league}\n` +
    `${htmlEscape(kalshi.title)}\n\n` +
    `Buy ${spread.kalshiSide.toUpperCase()}: <code>kalshi @ $${spread.kalshiPrice.toFixed(4)} × ${qty} = $${yesCost.toFixed(2)}</code>\n` +
    `Buy hedge: <code>polymarket @ $${spread.polyPrice.toFixed(4)} × ${qty} = $${noCost.toFixed(2)}</code>\n\n` +
    `💰 Deploying: <b>$${kellyDeployed.toFixed(2)}</b>\n` +
    `   <i>(Quarter Kelly on $${activeCapital.toFixed(0)} active capital — limit: ${sizing.limitingFactor})</i>\n` +
    `📈 <b>Max profit: $${(spread.netSpread * kellyDeployed).toFixed(2)} (+${netPct}% net)</b>\n` +
    `⏱ Game time: ${closeStr} — closes in ${(daysLeft * 24).toFixed(1)}h\n\n` +
    `Polarity: Kalshi YES = ${htmlEscape(homeTeam)} wins | Poly hedge = ${htmlEscape(spread.kalshiSide === 'yes' ? pair.polyNoLabel : pair.polyYesLabel)}`;

  const row1 = [
    { text: `✅ Execute $${kellyDeployed.toFixed(2)}`, callback_data: `buy_${oppId}` },
    { text: '❌ Skip', callback_data: `skip_${oppId}` },
  ];
  const row2 = [];
  if (kalshi.kalshiUrl) row2.push({ text: '📈 View on Kalshi ↗', url: kalshi.kalshiUrl });
  if (poly.polyUrl)     row2.push({ text: '📊 View on Polymarket ↗', url: poly.polyUrl });

  const payload: Record<string, unknown> = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: row2.length ? [row1, row2] : [row1] },
  };

  const res = await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[fastpoll-alert] telegram failed', res.status, body.slice(0,200));
  } else {
    console.log('[fastpoll-alert] sent for', kalshi.ticker, 'net=', netPct + '%');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async () => {
  const startMs = Date.now();

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) {
    return new Response('missing supabase env', { status: 500 });
  }
  const sb = createClient(supabaseUrl, serviceKey);

  // Steps 1 + 2 in parallel.
  const [kalshiMarkets, polyMarkets] = await Promise.all([
    fetchKalshiGameMarkets(),
    fetchPolyGameMarkets(),
  ]);

  // Step 3: load known markets cache.
  const { data: knownRows } = await sb
    .from('known_game_markets')
    .select('platform,market_id,alerted_at,last_spread_pct');
  const knownKalshi = new Map<string, KnownRow>();
  const knownPoly   = new Map<string, KnownRow>();
  for (const r of knownRows ?? []) {
    if (r.platform === 'kalshi')     knownKalshi.set(r.market_id, r as KnownRow);
    else if (r.platform === 'polymarket') knownPoly.set(r.market_id, r as KnownRow);
  }

  // Step 4: upsert.
  const newKalshi = kalshiMarkets.filter(m => !knownKalshi.has(m.ticker)).length;
  const newPoly   = polyMarkets.filter(m => !knownPoly.has(m.conditionId)).length;
  console.log('[fastpoll-new]', JSON.stringify({
    newKalshi, newPoly,
    existingKalshi: kalshiMarkets.length - newKalshi,
    existingPoly:   polyMarkets.length   - newPoly,
  }));
  await Promise.all([
    upsertKalshiMarkets(sb, kalshiMarkets, knownKalshi),
    upsertPolyMarkets(sb, polyMarkets),
  ]);

  // Step 5: match pairs.
  const pairs = matchPairs(kalshiMarkets, polyMarkets);
  console.log('[fastpoll-matched]', pairs.length, 'pairs');

  // Steps 5-7: spread + alert.
  let alertsFired = 0;
  const spreadResults: Array<{ ticker: string; netSpread: number | null }> = [];

  for (const pair of pairs) {
    const { kalshi } = pair;
    const daysToClose = (Date.parse(kalshi.closeTime) - Date.now()) / 86_400_000;

    // Skip CLOB fetch if raw spread can't possibly be > threshold.
    if (kalshi.yesAsk + 0.98 >= 1 + MIN_RAW_SPREAD_FOR_CLOB &&
        kalshi.noAsk  + 0.98 >= 1 + MIN_RAW_SPREAD_FOR_CLOB) {
      spreadResults.push({ ticker: kalshi.ticker, netSpread: null });
      continue;
    }

    const spread = await calculateSpread(pair);
    spreadResults.push({ ticker: kalshi.ticker, netSpread: spread?.netSpread ?? null });

    // Persist spread back to cache.
    if (spread) {
      await sb.from('known_game_markets')
        .update({ last_spread_pct: spread.netSpread, last_checked_at: new Date().toISOString() })
        .eq('platform', 'kalshi').eq('market_id', kalshi.ticker);
    }

    // Alert conditions: net > 3%, closes within 48h, not recently alerted.
    if (spread && spread.netSpread > MIN_NET_SPREAD_FOR_ALERT && daysToClose < ALERT_DAYS_MAX) {
      const cached = knownKalshi.get(kalshi.ticker);
      const lastAlerted = cached?.alerted_at ? Date.parse(cached.alerted_at) : 0;
      if (Date.now() - lastAlerted > ALERT_REFIRE_MS) {
        await sendAlert(pair, spread, sb);
        await sb.from('known_game_markets')
          .update({ alerted_at: new Date().toISOString() })
          .eq('platform', 'kalshi').eq('market_id', kalshi.ticker);
        alertsFired++;
      }
    }
  }

  // Spread persistence — track duration of each game spread via spread_events.
  try {
    const now = new Date().toISOString();
    // Build current active spreads (pairs with a positive net spread).
    const activePairIds = new Set<string>();
    for (let i = 0; i < pairs.length; i++) {
      const spread = (spreadResults[i]?.netSpread ?? 0);
      if (spread > 0) {
        const pid = `${pairs[i].kalshi.ticker}:${pairs[i].poly.conditionId}`;
        activePairIds.add(pid);
        // Load existing open event.
        const { data: existing } = await sb.from('spread_events')
          .select('id, peak_net_spread')
          .eq('pair_id', pid)
          .is('closed_at', null)
          .eq('source', 'fastpoll')
          .limit(1)
          .maybeSingle();
        if (!existing) {
          await sb.from('spread_events').insert({
            pair_id: pid,
            kalshi_market_id: pairs[i].kalshi.ticker,
            poly_market_id: pairs[i].poly.conditionId,
            kalshi_title: pairs[i].kalshi.title,
            first_detected_at: now,
            last_seen_at: now,
            first_net_spread: spread,
            peak_net_spread: spread,
            last_net_spread: spread,
            scan_count: 1,
            source: 'fastpoll',
          });
        } else {
          await sb.from('spread_events').update({
            last_seen_at: now,
            last_net_spread: spread,
            peak_net_spread: Math.max(existing.peak_net_spread as number, spread),
          }).eq('id', existing.id);
        }
      }
    }
    // Close any open fastpoll spread_events not in current active pairs.
    const { data: openFp } = await sb.from('spread_events')
      .select('id, pair_id, first_detected_at')
      .is('closed_at', null)
      .eq('source', 'fastpoll');
    for (const r of openFp ?? []) {
      if (!activePairIds.has(r.pair_id as string)) {
        const dur = Math.round((Date.now() - Date.parse(r.first_detected_at as string)) / 1000);
        await sb.from('spread_events').update({
          closed_at: now,
          last_net_spread: 0,
          closing_reason: 'spread_closed',
          duration_seconds: dur,
        }).eq('id', r.id);
      }
    }
  } catch (err) {
    console.error('[fastpoll] syncSpreadEvents failed', err);
  }

  const durationMs = Date.now() - startMs;
  console.log('[fastpoll-done]', JSON.stringify({
    durationMs,
    kalshiMarkets: kalshiMarkets.length,
    polyMarkets: polyMarkets.length,
    pairs: pairs.length,
    alertsFired,
    spreads: spreadResults,
  }));

  return new Response(JSON.stringify({
    ok: true, durationMs,
    kalshiMarkets: kalshiMarkets.length,
    polyMarkets: polyMarkets.length,
    newKalshi, newPoly,
    pairs: pairs.length,
    alertsFired,
    spreads: spreadResults,
  }), { headers: { 'Content-Type': 'application/json' } });
});
