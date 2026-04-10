// Arbor scanner — Supabase Edge Function (Deno).
// Runs the full scan cycle server-side and writes results to scan_results.
// All API calls (Kalshi, Polymarket, Anthropic) happen here, never in browser.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.102.1';
import Anthropic from 'npm:@anthropic-ai/sdk@0.85.0';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Platform =
  | 'kalshi'
  | 'polymarket'
  | 'predictit'
  | 'cryptocom'   // Crypto.com prediction markets — no public API as of Apr 2026
  | 'fanduel'     // FanDuel Predicts — app-only, WAF-protected as of Apr 2026
  | 'fanatics'    // Fanatics Markets — Cloudflare-protected as of Apr 2026
  | 'og';         // OG Markets — og.bet domain NXDOMAIN as of Apr 2026
type ResolutionVerdict = 'SAFE' | 'CAUTION' | 'SKIP' | 'PENDING';

interface UnifiedMarket {
  platform: Platform;
  marketId: string;
  title: string;
  // POLARITY-CORRECT TOKEN IDS — assigned ONLY after Claude verifies which
  // Polymarket outcome corresponds to Kalshi YES. Until verification:
  //   - For Kalshi: yesTokenId/noTokenId are not used (Kalshi uses ticker).
  //   - For Polymarket: yesTokenId/noTokenId stay UNDEFINED at fetch time.
  //     The raw outcome→token mapping lives in outcome0Label/outcome0TokenId
  //     /outcome1Label/outcome1TokenId. Claude reads those and decides which
  //     index = same direction as Kalshi YES; the resolver then assigns
  //     yesTokenId = same-direction, noTokenId = hedge so the calculator's
  //     orient-A walk (BUY Kalshi YES + BUY Poly NO=hedge) is a real arb.
  yesTokenId?: string;
  noTokenId?: string;
  // Polymarket only: raw outcome → token mapping straight from the Gamma
  // payload, BEFORE polarity verification. The label is the human-readable
  // outcome name (e.g. "Athletics", "New York Yankees"); the token id is
  // the CLOB token id at the same array index. Claude uses these labels
  // to decide which index matches the Kalshi YES direction.
  outcome0Label?: string;
  outcome0TokenId?: string;
  outcome1Label?: string;
  outcome1TokenId?: string;
  closeTime?: string;
  yesAsk?: number;
  noAsk?: number;
  resolutionCriteria?: string;
  url?: string;
  // Source category — Kalshi event.category for kalshi markets, Polymarket
  // tag slug for poly markets. Used to detect sports pairs and to drive
  // future per-category fee adjustments.
  category?: string;
  // Pre-detected sports info, populated at fetch time so the matcher and
  // resolver don't have to re-tokenize titles. `sportLeague` is one of
  // 'mlb' | 'nba' | 'nfl' | 'nhl'; `sportTeams` are canonical lowercase
  // team nicknames ('mets', 'red sox', 'lakers', etc.).
  sportLeague?: string;
  sportTeams?: string[];
}

interface OrderbookLevel {
  price: number;
  size: number;
}

interface Orderbook {
  marketId: string;
  yesAsks: OrderbookLevel[];
  noAsks: OrderbookLevel[];
  yesBids: OrderbookLevel[];
  noBids: OrderbookLevel[];
  fetchedAt: number;
}

interface ArbitrageLevel {
  buyYesPlatform: Platform;
  buyYesPrice: number;
  buyNoPlatform: Platform;
  buyNoPrice: number;
  quantity: number;
  totalCost: number;
  grossProfitPct: number;
  estimatedFees: number;
  netProfitPct: number;
  maxProfitDollars: number;
}

interface ArbitrageOpportunity {
  id: string;
  kalshiMarket: UnifiedMarket;
  polyMarket: UnifiedMarket;
  matchScore: number;
  verdict: ResolutionVerdict;
  verdictReasoning?: string;
  riskFactors?: string[];
  levels: ArbitrageLevel[];
  bestNetSpread: number;
  totalMaxProfit: number;
  scannedAt: number;
  // Capital-efficiency fields (added 2026-04 for date/annualized filtering).
  daysToClose: number;
  annualizedReturn: number;
  effectiveCloseDate: string;
  kalshiCloseDate: string;
  polyCloseDate: string;
  category: string;
}

interface CandidatePair {
  kalshi: UnifiedMarket;
  poly: UnifiedMarket;
  score: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_GAMMA = 'https://gamma-api.polymarket.com';
const POLY_CLOB = 'https://clob.polymarket.com';

// Default fuzzy threshold for politics/macro pairs. Lowered from 0.40 →
// 0.25 because the tighter threshold was killing legitimate cross-platform
// pairs whose titles phrased the same proposition differently (e.g.
// "Trump wins 2028" vs "Will Donald Trump win the 2028 election?"). Claude
// is the source of truth for SAFE/SKIP — the fuzzy matcher's only job is
// to surface candidates worth verifying. We'd rather waste a Claude call
// on a 0.27-overlap false positive than miss a real arb.
const FUZZY_THRESHOLD = 0.25;
// Sports titles format very differently across platforms (Kalshi:
// "Chiefs ML vs Eagles 04/13" vs Poly: "Will Kansas City Chiefs beat
// Philadelphia Eagles on April 13?"). Token overlap on team names alone
// usually only gives 0.30-0.40, so we lower the threshold for any pair
// where both titles share a recognizable team from the same league.
const SPORTS_FUZZY_THRESHOLD = 0.30;
// Economic markets use a 0.30 threshold — release-date wording differs
// across platforms ("April CPI" vs "CPI YoY > 3.2%") so the fuzzy matcher
// has weaker signal than politics, but Claude verifies polarity downstream.
const ECONOMIC_FUZZY_THRESHOLD = 0.30;
// Entertainment/awards: nominee-name overlap is the main signal
// ("Will Beyoncé win Album of the Year?") so 0.30 captures it.
const ENTERTAINMENT_FUZZY_THRESHOLD = 0.30;
// Science/tech: drug names, mission names, model versions vary; 0.30 is
// the lower bound that still admits matches.
const SCIENCE_FUZZY_THRESHOLD = 0.30;
// Financial: index/commodity markets share strong tokens (S&P 500, 4500,
// %, etc.) so a slightly higher 0.35 threshold reduces noise while
// keeping the matcher sensitive.
const FINANCIAL_FUZZY_THRESHOLD = 0.35;
// PredictIt titles are phrased very differently from Kalshi even for the
// same event ("Will the Senate confirm X?" vs "X confirmed?"). Title
// normalization (normalizePredictItTitle) closes much of the gap but
// systematic formatting differences still suppress scores by ~0.10.
// Use 0.45 as the minimum for PI×Kalshi pairs so real matches survive.
const PREDICTIT_FUZZY_THRESHOLD = 0.45;
const STALENESS_THRESHOLD_MS = 120_000;
// TEMP: diagnostic, raise to 0.02 once spread distribution is understood.
const MIN_NET_SPREAD = 0.005;
// Threshold passed into the orderbook walk so we collect all profitable +
// unprofitable levels for diagnostics. The display threshold above flags
// pairs with `belowThreshold = true` instead of dropping them.
const DIAGNOSTIC_WALK_THRESHOLD = -1.0;
// Capital efficiency: only scan markets that settle inside this window.
// Markets closing in < 24h are too risky (resolution timing); markets > 365d
// out tie up capital for negligible annualized return.
const MIN_DAYS_TO_CLOSE = 1;
const MAX_DAYS_TO_CLOSE = 365;
// Sports gets a per-hour minimum instead of a per-day minimum: a 3h cushion
// is enough to filter "already in progress" and "about to start" games while
// still allowing tonight's games scanned in the morning. 3 hours is the
// floor to safely execute both legs (Kalshi auth, Poly tx, settlement).
const MIN_HOURS_TO_CLOSE_SPORTS = 3;
// Per-category date filter ceilings — the further out a market closes,
// the more its annualized return decays and the more category-specific
// resolution risk creeps in. Sports used to be capped at 14d to focus on
// game-day markets, but that killed legitimate season futures (Pennant,
// World Series, Cy Young, MVP — all close in Oct/Nov, often 200+ days
// out). Raised to 365 to keep season-long sports futures alive; the
// proposition mismatch between game-winner and season-futures is
// prevented earlier in the join pass via the prop-noise filter.
// Economic releases get 60 days (covers next CPI/NFP cycle); politics/
// everything else keeps the 365-day default.
const MAX_DAYS_TO_CLOSE_SPORTS = 365;
const MAX_DAYS_TO_CLOSE_ECONOMIC = 60;
// New category windows added Apr 2026.
// Entertainment/awards: 6 months — most awards (Oscars, Grammys, Emmys)
// resolve once a year, so a 180d window picks up the next ceremony.
// Science/tech: 4 months — FDA decisions, SpaceX launches, AI benchmarks
// move on a quarterly cadence.
// Financial: 1 month — index/commodity price markets are weekly or
// monthly. 30d window keeps them tight enough to avoid stale verdicts.
const MAX_DAYS_TO_CLOSE_ENTERTAINMENT = 180;
const MAX_DAYS_TO_CLOSE_SCIENCE = 120;
const MAX_DAYS_TO_CLOSE_FINANCIAL = 30;
// 15% annualized minimum is the politics floor (current default).
// Sports/economic categories deserve different floors because their
// average days-to-close is shorter, so even small spreads still produce
// large APYs (50% / 20% respectively).
const MIN_ANNUALIZED_RETURN = 0.15;
const MIN_APY_SPORTS = 0.50;
const MIN_APY_ECONOMIC = 0.20;
const MIN_APY_POLITICS = 0.15;
const MIN_APY_ENTERTAINMENT = 0.10;
const MIN_APY_SCIENCE = 0.12;
const MIN_APY_FINANCIAL = 0.20;
// Priority = annualizedReturn * categoryMultiplier. Faster-recycling
// categories rank above equivalent-APY long-dated ones because the same
// dollar can be redeployed sooner.
const CATEGORY_MULTIPLIER_SPORTS = 1.5;
const CATEGORY_MULTIPLIER_ECONOMIC = 1.2;
const CATEGORY_MULTIPLIER_POLITICS = 1.0;
const CATEGORY_MULTIPLIER_ENTERTAINMENT = 1.1;
const CATEGORY_MULTIPLIER_SCIENCE = 1.1;
const CATEGORY_MULTIPLIER_FINANCIAL = 1.3;
const REQUEST_DELAY_MS = 50; // gentle pacing between orderbook calls
const KALSHI_PAGE_DELAY_MS = 250; // Kalshi rate limit ~5 req/s
// Lowered Apr 2026 from 250 → 40 because fast-paths were removed: every
// pair now spends one Claude call. At 250 the worker hit WORKER_LIMIT
// (~150s wallclock + memory). Raised back to 80 once cache + sports-first
// sort proved that the long tail is mostly cache hits — only the first
// scan after cold start has to spend the full Claude budget. CLAUDE_CONCURRENCY
// stays at 5 to keep wallclock under the 150s worker budget.
const MAX_PAIRS_TO_RESOLVE = 80;
const MAX_ORDERBOOKS_TO_FETCH = 60;
const CLAUDE_CONCURRENCY = 5;
const ORDERBOOK_CONCURRENCY = 3;
const TOP_SPREADS_STORED = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

function parseCloseTimeMs(s?: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function daysFromNow(ms: number, now = Date.now()): number {
  return (ms - now) / MS_PER_DAY;
}

/**
 * Effective settlement is the EARLIER of the two close dates — that's when
 * the pair's first leg actually pays out.
 */
function effectiveCloseMs(pair: CandidatePair): number | null {
  const k = parseCloseTimeMs(pair.kalshi.closeTime);
  const p = parseCloseTimeMs(pair.poly.closeTime);
  if (k === null && p === null) return null;
  if (k === null) return p;
  if (p === null) return k;
  return Math.min(k, p);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sports team detection
// ─────────────────────────────────────────────────────────────────────────────
//
// We detect sports pairs by checking if both titles contain the same team
// name from the same league. This is robust because team names are unique
// per league (no two NFL teams are called "chiefs"). Substring matching on
// the lowercased title catches both "Chiefs" and "Kansas City Chiefs".
//
// Multi-word team names like "red sox" and "blue jays" are matched as
// substrings so they work in either order.

type Sport = 'nfl' | 'nba' | 'mlb' | 'nhl' | 'mls';

const NFL_TEAMS: ReadonlySet<string> = new Set([
  'chiefs', 'eagles', 'cowboys', 'patriots', 'packers', 'rams', '49ers',
  'bills', 'ravens', 'bengals', 'browns', 'steelers', 'texans', 'colts',
  'jaguars', 'titans', 'broncos', 'raiders', 'chargers', 'seahawks',
  'cardinals', 'falcons', 'saints', 'panthers', 'buccaneers', 'bears',
  'lions', 'vikings', 'giants', 'commanders', 'jets', 'dolphins',
]);

const NBA_TEAMS: ReadonlySet<string> = new Set([
  'lakers', 'celtics', 'warriors', 'nets', 'knicks', 'bulls', 'heat',
  'bucks', 'nuggets', 'suns', 'mavs', 'mavericks', 'clippers', 'sixers',
  'raptors', 'hawks', 'hornets', 'pistons', 'pacers', 'cavaliers',
  'magic', 'wizards', 'pelicans', 'grizzlies', 'spurs', 'thunder',
  'blazers', 'jazz', 'kings', 'rockets', 'timberwolves',
]);

const MLB_TEAMS: ReadonlySet<string> = new Set([
  'yankees', 'red sox', 'dodgers', 'giants', 'cubs', 'cardinals',
  'braves', 'mets', 'phillies', 'nationals', 'marlins', 'brewers',
  'pirates', 'reds', 'astros', 'rangers', 'angels', 'athletics',
  'mariners', 'padres', 'rockies', 'diamondbacks', 'twins', 'white sox',
  'tigers', 'guardians', 'royals', 'orioles', 'rays', 'blue jays',
]);

// NHL teams. Some names COLLIDE with other leagues (kings/NBA, rangers/MLB,
// panthers/NFL, jets/NFL, stars/—, wild/—, devils/—, capitals/—). We
// include them because some NHL games would otherwise be undetectable
// (e.g. "LA Kings vs NY Rangers" has zero unambiguous tokens). The
// collision is resolved at two layers downstream:
//   1. polyMarketToUnified picks the league with the HIGHEST team count
//      (mlb > nba > nfl > nhl > mls on ties), so a market with one nhl
//      hit but two mlb hits routes to mlb.
//   2. The sports join pass has a defensive (km.sportLeague !==
//      pm.sportLeague) guard.
const NHL_TEAMS: ReadonlySet<string> = new Set([
  'avalanche', 'coyotes', 'bruins', 'sabres', 'flames', 'hurricanes',
  'blackhawks', 'blue jackets', 'stars', 'red wings', 'oilers',
  'panthers', 'kings', 'wild', 'canadiens', 'predators', 'devils',
  'islanders', 'rangers', 'senators', 'flyers', 'penguins', 'sharks',
  'kraken', 'blues', 'lightning', 'maple leafs', 'canucks',
  'golden knights', 'capitals', 'jets', 'ducks', 'utah hockey',
]);

// MLS teams. Bare-city forms ('portland', 'san jose', 'colorado',
// 'vancouver', 'new england', 'charlotte') are intentionally EXCLUDED
// in favor of the full club name to avoid cross-sport contamination
// (Portland Trail Blazers / NBA, Vancouver Canucks / NHL, etc.).
const MLS_TEAMS: ReadonlySet<string> = new Set([
  'atlanta united', 'austin fc', 'charlotte fc', 'chicago fire',
  'fc cincinnati', 'colorado rapids', 'columbus crew', 'fc dallas',
  'dc united', 'houston dynamo', 'inter miami', 'la galaxy', 'lafc',
  'los angeles fc', 'minnesota united', 'cf montreal', 'nashville sc',
  'new england revolution', 'new york city fc', 'nycfc',
  'new york red bulls', 'orlando city', 'philadelphia union',
  'portland timbers', 'real salt lake', 'san jose earthquakes',
  'seattle sounders', 'sporting kc', 'sporting kansas city',
  'st louis city', 'toronto fc', 'vancouver whitecaps',
]);

interface DetectedTeams {
  nfl: string[];
  nba: string[];
  mlb: string[];
  nhl: string[];
  mls: string[];
}

const EMPTY_TEAMS: DetectedTeams = { nfl: [], nba: [], mlb: [], nhl: [], mls: [] };

function hasAnyTeam(t: DetectedTeams): boolean {
  return t.nfl.length + t.nba.length + t.mlb.length + t.nhl.length + t.mls.length > 0;
}

function detectTeams(title: string): DetectedTeams {
  if (!title) return EMPTY_TEAMS;
  const lower = ' ' + title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const nfl: string[] = [];
  const nba: string[] = [];
  const mlb: string[] = [];
  const nhl: string[] = [];
  const mls: string[] = [];
  // Pad with spaces so 'rays' doesn't match 'arrays', etc.
  for (const team of NFL_TEAMS) if (lower.includes(' ' + team + ' ')) nfl.push(team);
  for (const team of NBA_TEAMS) if (lower.includes(' ' + team + ' ')) nba.push(team);
  for (const team of MLB_TEAMS) if (lower.includes(' ' + team + ' ')) mlb.push(team);
  for (const team of NHL_TEAMS) if (lower.includes(' ' + team + ' ')) nhl.push(team);
  // MLS uses a more permissive match because club names often appear at
  // a title boundary without trailing punctuation ("…vs Inter Miami").
  for (const team of MLS_TEAMS) {
    if (
      lower.includes(' ' + team + ' ') ||
      lower.includes(' ' + team) ||
      lower.endsWith(team + ' ')
    ) {
      mls.push(team);
    }
  }
  return { nfl, nba, mlb, nhl, mls };
}

interface SharedTeamInfo {
  sport: Sport;
  team: string;
}

/**
 * Returns the shared team if both titles mention at least one team from
 * the same league, else null. NBA "cardinals" / NFL "cardinals" /
 * MLB "cardinals" all collide — that's intentional, the shared sport
 * disambiguates.
 */
function findSharedTeam(a: DetectedTeams, b: DetectedTeams): SharedTeamInfo | null {
  for (const t of a.nfl) if (b.nfl.includes(t)) return { sport: 'nfl', team: t };
  for (const t of a.nba) if (b.nba.includes(t)) return { sport: 'nba', team: t };
  for (const t of a.mlb) if (b.mlb.includes(t)) return { sport: 'mlb', team: t };
  for (const t of a.nhl) if (b.nhl.includes(t)) return { sport: 'nhl', team: t };
  for (const t of a.mls) if (b.mls.includes(t)) return { sport: 'mls', team: t };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket prop-noise filter (module scope so polyMarketToUnified can use it)
// ─────────────────────────────────────────────────────────────────────────────
//
// Polymarket sports markets include lots of derivative props ("1H O/U
// 116.5", "Race to 20", "Lakers -3.5", "Will there be a run scored in
// the first inning?", "Anytime scorer: Mbappé", etc.). Pairing one of
// these with a Kalshi game-winner produces a phantom arb because the
// propositions don't match. We filter prop markets out at
// polyMarketToUnified() so they never enter the pool, and again
// defensively in the sports join pass.
// Word-boundary regex covering single-token props (1H, O/U, race-to,
// anytime scorer, first inning, runs scored, pitcher, strikeout, …).
// Word boundaries are intentional so 'total' doesn't gobble unrelated
// titles that mention 'total' as a noun.
const PROP_NOISE_RE =
  /\b(o\/u|over\/under|1h|2h|1q|2q|3q|4q|race to|margin|first to|spread|handicap|alt|prop|to score|to win mvp|moneyline|first half|second half|first quarter|fourth quarter|first inning|1st inning|run scored|runs scored|total runs|total points|total goals|anytime scorer|first scorer|last scorer|correct score|halftime|half time|double chance|draw no bet|both teams to score|clean sheet|to win to nil|innings|pitcher|strikeout|home run|batting|fielding|grand slam)\b/i;

// Catches "+3.5", "-3.5", "±3" alt-line punctuation in titles.
const PROP_PUNCT_RE = /[+\-]\d|±\d/;

function isPropMarket(title: string): boolean {
  if (!title) return false;
  if (PROP_NOISE_RE.test(title)) return true;
  if (PROP_PUNCT_RE.test(title)) return true;
  // Substring fallbacks — these phrasings get mangled by \b on the
  // dashes/articles in between, so we check them directly.
  const lower = title.toLowerCase();
  if (lower.includes('will there be a run')) return true;
  if (lower.includes('scored in the first')) return true;
  if (lower.includes('first-inning')) return true;
  if (lower.includes('run in the 1st')) return true;
  if (lower.includes('runs in the')) return true;
  return false;
}

// Counter for prop markets dropped during polyMarketToUnified — reset
// at the start of polyGetMarkets() and logged at the end.
let _propMarketsFiltered = 0;

// Counter for US-restricted / inactive poly markets filtered out.
// Reset at the start of polyGetMarkets() and surfaced in [poly-us-filter].
let _polyRestrictedFiltered = 0;
let _polyInactiveFiltered = 0;
let _polyRawTotal = 0;

// Counter + sample buffer for the recurrence-filter rejection path. Reset
// at the top of runScanCycle and surfaced in the HTTP response so the
// number of pairs killed by event-uniqueness classification is observable
// without scraping logs.
interface RecurrenceRejection {
  kalshiTitle: string;
  polyTitle: string;
  type: EventRecurrence['subtype'] | 'UNIQUE';
  actualGapHours: number;
  maxGapHours: number;
  reason: 'gap' | 'ticker-cross-check';
}
let _recurrenceRejected = 0;
let _recurrenceRejectionSamples: RecurrenceRejection[] = [];

// FIX 3 series-discovery state. Reset at the start of kalshiGetMarkets()
// and surfaced in the diag response so the discovery output is observable
// without depending on Logflare ingestion (which is unreliable).
interface KalshiSeriesDiscovery {
  // Series prefixes seen in the unfiltered /events scan, keyed by category.
  byCategory: Record<string, string[]>;
  // Per-category /events probes (event count, sample titles, series prefixes).
  probes: Array<{
    category: string;
    events: number;
    firstTitles: string[];
    seriesPrefixes: string[];
    error?: string;
  }>;
}
let _kalshiSeriesDiscovery: KalshiSeriesDiscovery = { byCategory: {}, probes: [] };

// Per-category Kalshi market counts after all approaches (A-G) finish.
// Reset at the top of kalshiGetMarkets via the assignment in the body and
// surfaced in the HTTP response so we can verify entertainment/science/
// climate inventory without scraping logs.
interface KalshiCategoryCounts {
  entertainment: number;
  science: number;
  climate: number;
  sports: number;
  politics: number;
  economics: number;
}
let _kalshiCategoryCounts: KalshiCategoryCounts = {
  entertainment: 0, science: 0, climate: 0,
  sports: 0, politics: 0, economics: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi sports event_ticker parsing
// ─────────────────────────────────────────────────────────────────────────────
//
// Kalshi sports event tickers look like KXMLBGAME-26APR111610ATHNYM where the
// trailing 6 chars are two 3-letter team codes. The market title gets
// truncated to ~10 chars per side ("New York M") so we can't reliably detect
// teams from the title alone — we have to parse the ticker.

const MLB_CODE_TO_TEAM: Readonly<Record<string, string>> = {
  ARI: 'diamondbacks', ATL: 'braves', BAL: 'orioles', BOS: 'red sox',
  CHC: 'cubs', CIN: 'reds', CLE: 'guardians', COL: 'rockies',
  CWS: 'white sox', CHW: 'white sox', DET: 'tigers', HOU: 'astros',
  KCR: 'royals', KCO: 'royals', LAA: 'angels', LAD: 'dodgers',
  MIA: 'marlins', MIL: 'brewers', MIN: 'twins', NYM: 'mets',
  NYY: 'yankees', OAK: 'athletics', ATH: 'athletics', PHI: 'phillies',
  PIT: 'pirates', SDP: 'padres', SEA: 'mariners', SFG: 'giants',
  STL: 'cardinals', TBR: 'rays', TEX: 'rangers', TOR: 'blue jays',
  WSH: 'nationals', WAS: 'nationals',
};

const NBA_CODE_TO_TEAM: Readonly<Record<string, string>> = {
  ATL: 'hawks', BOS: 'celtics', BKN: 'nets', BRK: 'nets',
  CHA: 'hornets', CHO: 'hornets', CHI: 'bulls', CLE: 'cavaliers',
  DAL: 'mavericks', DEN: 'nuggets', DET: 'pistons', GSW: 'warriors',
  HOU: 'rockets', IND: 'pacers', LAC: 'clippers', LAL: 'lakers',
  MEM: 'grizzlies', MIA: 'heat', MIL: 'bucks', MIN: 'timberwolves',
  NOP: 'pelicans', NYK: 'knicks', OKC: 'thunder', ORL: 'magic',
  PHI: 'sixers', PHX: 'suns', POR: 'blazers', SAC: 'kings',
  SAS: 'spurs', TOR: 'raptors', UTA: 'jazz', WAS: 'wizards',
};

const NFL_CODE_TO_TEAM: Readonly<Record<string, string>> = {
  ARI: 'cardinals', ATL: 'falcons', BAL: 'ravens', BUF: 'bills',
  CAR: 'panthers', CHI: 'bears', CIN: 'bengals', CLE: 'browns',
  DAL: 'cowboys', DEN: 'broncos', DET: 'lions', GB: 'packers',
  GNB: 'packers', HOU: 'texans', IND: 'colts', JAC: 'jaguars',
  JAX: 'jaguars', KC: 'chiefs', KAN: 'chiefs', LV: 'raiders',
  LVR: 'raiders', LAC: 'chargers', LAR: 'rams', MIA: 'dolphins',
  MIN: 'vikings', NE: 'patriots', NWE: 'patriots', NO: 'saints',
  NOR: 'saints', NYG: 'giants', NYJ: 'jets', PHI: 'eagles',
  PIT: 'steelers', SF: '49ers', SFO: '49ers', SEA: 'seahawks',
  TB: 'buccaneers', TAM: 'buccaneers', TEN: 'titans', WAS: 'commanders',
};

const NHL_CODE_TO_TEAM: Readonly<Record<string, string>> = {
  ANA: 'ducks', ARI: 'coyotes', BOS: 'bruins', BUF: 'sabres',
  CGY: 'flames', CAR: 'hurricanes', CHI: 'blackhawks', COL: 'avalanche',
  CBJ: 'blue jackets', DAL: 'stars', DET: 'red wings', EDM: 'oilers',
  FLA: 'panthers', LAK: 'kings', MIN: 'wild', MTL: 'canadiens',
  NSH: 'predators', NJD: 'devils', NYI: 'islanders', NYR: 'rangers',
  OTT: 'senators', PHI: 'flyers', PIT: 'penguins', SJS: 'sharks',
  SEA: 'kraken', STL: 'blues', TBL: 'lightning', TOR: 'maple leafs',
  VAN: 'canucks', VGK: 'golden knights', WSH: 'capitals', WPG: 'jets',
  UTA: 'utah hockey',
};

interface KalshiSportInfo {
  sport: 'mlb' | 'nba' | 'nfl' | 'nhl';
  teams: string[];
}

/**
 * Parses a Kalshi event_ticker like KXMLBGAME-26APR111610ATHNYM into the
 * sport and the canonical team names. Returns null if not a recognized
 * sports ticker.
 */
function parseKalshiSportTicker(eventTicker: string): KalshiSportInfo | null {
  if (!eventTicker) return null;
  const m = eventTicker.match(/^KX(MLB|NBA|NFL|NHL)GAME-/);
  if (!m) return null;
  const sport = m[1].toLowerCase() as 'mlb' | 'nba' | 'nfl' | 'nhl';
  // Take the trailing alpha suffix (codes are letters only) — strip any
  // single-team disambiguator like "-NOP" first.
  const tail = eventTicker.split('-').pop() ?? '';
  // Find the last contiguous alpha run.
  const alphaMatch = tail.match(/[A-Z]+$/);
  if (!alphaMatch) return null;
  const codes = alphaMatch[0];
  // Codes are 2-4 chars; standard MLB/NBA/NHL is 3 chars, NFL has 2-3 char
  // codes (KC, NE, SF, etc). When 6 chars total, it's two 3-char codes.
  // When 5 chars (e.g., NEKAN, NEMIA), it could be 2+3 or 3+2. We try the
  // most common splits.
  const map = sport === 'mlb' ? MLB_CODE_TO_TEAM
    : sport === 'nba' ? NBA_CODE_TO_TEAM
    : sport === 'nfl' ? NFL_CODE_TO_TEAM
    : NHL_CODE_TO_TEAM;
  const tryParse = (a: string, b: string): string[] | null => {
    const ta = map[a];
    const tb = map[b];
    if (ta && tb) return [ta, tb];
    return null;
  };
  let teams: string[] | null = null;
  if (codes.length === 6) {
    teams = tryParse(codes.slice(0, 3), codes.slice(3));
  } else if (codes.length === 5) {
    teams = tryParse(codes.slice(0, 2), codes.slice(2)) ??
      tryParse(codes.slice(0, 3), codes.slice(3));
  } else if (codes.length === 4) {
    teams = tryParse(codes.slice(0, 2), codes.slice(2));
  }
  if (!teams) return null;
  return { sport, teams };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event recurrence classification
// ─────────────────────────────────────────────────────────────────────────────
//
// The scanner used to assume that any pair of markets with similar titles
// closing within 5 days of each other was a legitimate cross-platform pair.
// This works for UNIQUE events (one MOTY award, one election) but fails for
// RECURRING events with identical titles: a 3-game baseball series, monthly
// CPI reports, weekly jobless claims. In those cases the 5-day proximity
// gate happily pairs game 1 of the series with game 3, or April CPI with
// May CPI, and Claude's verifier sometimes votes SAFE on the resulting
// fake spread because the questions ARE about the same teams / metric.
//
// We classify each pair upstream and apply a tighter gap (36h for sports
// games, 20d for monthly economic prints, 6d for weekly) so adjacent
// instances of the same recurring series can never be matched together.

const MONTH_NAME_RE =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;
const RECURRING_KALSHI_PREFIXES = [
  'KXCPI', 'KXJOBS', 'KXFOMC', 'KXPCE', 'KXGDP', 'KXNFP', 'KXUNRATE',
];

interface EventRecurrence {
  type: 'UNIQUE' | 'RECURRING';
  subtype?: 'sports-game' | 'monthly-econ' | 'weekly';
  maxGapMs: number;
}

/**
 * Parses a Kalshi sports ticker like KXMLBGAME-26APR111610ATHNYM into a
 * Date for the scheduled game start. Format: YY MMM DD HH MM (ET-ish).
 * Returns null on parse failure. The 36h tolerance applied downstream
 * absorbs any timezone slop.
 */
function parseKalshiGameDate(marketId: string): Date | null {
  if (!marketId) return null;
  const m = marketId.match(
    /-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})?(\d{2})?/i,
  );
  if (!m) return null;
  const yy = parseInt(m[1], 10);
  const monthIdx = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
    .indexOf(m[2].toUpperCase());
  if (monthIdx < 0) return null;
  const dd = parseInt(m[3], 10);
  const hh = m[4] ? parseInt(m[4], 10) : 12;
  const mi = m[5] ? parseInt(m[5], 10) : 0;
  const yyyy = 2000 + yy;
  const d = new Date(Date.UTC(yyyy, monthIdx, dd, hh, mi));
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Classify a (kalshi, poly) pair as UNIQUE or RECURRING and return the max
 * close-time gap allowed between them. RECURRING events get tight gaps so
 * adjacent instances of the same series can never be matched together.
 *
 * Sports game-winners: 36h. Detection: kalshi title contains "Winner?"
 *   AND kalshi.sportLeague is set, OR the marketId looks like KX*GAME-.
 * Monthly economic: 20 days. Detection: title contains a month name OR
 *   the kalshi marketId starts with one of the RECURRING_KALSHI_PREFIXES.
 * Weekly: 6 days. Detection: title regex /\bweekly\b|\bweek of\b/i.
 *
 * Anything else falls through to UNIQUE with a generous 60-day window.
 */
function classifyEventRecurrence(
  km: UnifiedMarket,
  pm: UnifiedMarket,
): EventRecurrence {
  const kTitle = (km.title || '').toLowerCase();
  const pTitle = (pm.title || '').toLowerCase();
  const kId = km.marketId || '';

  // 1) Sports game-winner — tightest tolerance.
  const isSportsWinner = (
    (kTitle.includes('winner?') && !!km.sportLeague) ||
    /^KX(MLB|NBA|NFL|NHL|MLS)GAME-/i.test(kId)
  );
  if (isSportsWinner) {
    return { type: 'RECURRING', subtype: 'sports-game', maxGapMs: 36 * MS_PER_HOUR };
  }

  // 2) Weekly recurring — check before monthly so "weekly jobless" doesn't
  //    fall into the monthly bucket.
  const weeklyRe = /\bweekly\b|\bweek of\b/i;
  if (weeklyRe.test(kTitle) || weeklyRe.test(pTitle)) {
    return { type: 'RECURRING', subtype: 'weekly', maxGapMs: 6 * MS_PER_DAY };
  }

  // 3) Monthly economic — title month name OR known recurring kalshi prefix.
  const titleHasMonth = MONTH_NAME_RE.test(kTitle) || MONTH_NAME_RE.test(pTitle);
  const idIsRecurring = RECURRING_KALSHI_PREFIXES.some((p) => kId.startsWith(p));
  if (titleHasMonth || idIsRecurring) {
    return { type: 'RECURRING', subtype: 'monthly-econ', maxGapMs: 20 * MS_PER_DAY };
  }

  // 4) UNIQUE — generous window so legitimate cross-platform pairs that
  //    differ in close-time by a couple of weeks (settlement timing, weekly
  //    vs end-of-month resolution) still pair up.
  return { type: 'UNIQUE', maxGapMs: 60 * MS_PER_DAY };
}


// ─────────────────────────────────────────────────────────────────────────────
// Pair category classification
// ─────────────────────────────────────────────────────────────────────────────

// Crypto removed entirely (Apr 2026): Kalshi crypto markets are weekly
// price-ladder contracts ("BTC > $X by Mar 21") while Polymarket crypto
// markets are coarse monthly/quarterly bets ("Will BTC hit $X in 2026?").
// The two ladders never line up at the same (price, date) tuple in
// practice, and even when they do the resolution sources differ enough
// that Claude has to SKIP them. We'll revisit if Kalshi adds longer-dated
// strikes that line up with Poly's grid.
type PairCategory =
  | 'sports'
  | 'economic'
  | 'politics'
  | 'entertainment'
  | 'science'
  | 'financial';

// Strings here mix Kalshi raw category names (e.g. 'Economics') and
// Polymarket tag slugs (e.g. 'economics'), so the same Set works for
// both sides regardless of which platform fetched the market.
const ECONOMIC_CATEGORIES = new Set([
  'economics', 'finance',
  'Economics', 'Finance',
]);
const ENTERTAINMENT_CATEGORIES = new Set([
  'awards', 'entertainment', 'pop-culture', 'music', 'film',
  'Awards', 'Culture', 'Entertainment',
]);
const SCIENCE_CATEGORIES = new Set([
  'science', 'technology', 'space', 'biotech',
  'Science', 'Climate',
]);
const FINANCIAL_CATEGORIES = new Set([
  'stocks', 'commodities',
  // Kalshi sometimes uses "Financials" as the category for index markets.
  'Financials', 'Stocks', 'Commodities',
]);

function isEconomicMarket(m: UnifiedMarket): boolean {
  const cat = m.category;
  if (!cat) return false;
  return ECONOMIC_CATEGORIES.has(cat);
}
function isEntertainmentMarket(m: UnifiedMarket): boolean {
  const cat = m.category;
  if (!cat) return false;
  return ENTERTAINMENT_CATEGORIES.has(cat);
}
function isScienceMarket(m: UnifiedMarket): boolean {
  const cat = m.category;
  if (!cat) return false;
  return SCIENCE_CATEGORIES.has(cat);
}
function isFinancialMarket(m: UnifiedMarket): boolean {
  const cat = m.category;
  if (!cat) return false;
  return FINANCIAL_CATEGORIES.has(cat);
}

function pairCategory(pair: CandidatePair): PairCategory {
  // Sports first — most specific signal (precomputed shared team).
  if (pairSharedTeamFast(pair)) return 'sports';
  // Financial before economic: index/commodity markets often carry both
  // 'finance' AND 'stocks' tags on Polymarket; we want the financial
  // bucket (tighter window, higher APY floor) to win.
  if (isFinancialMarket(pair.kalshi) || isFinancialMarket(pair.poly)) return 'financial';
  // Economic — either side tagged in Economics/Finance.
  if (isEconomicMarket(pair.kalshi) || isEconomicMarket(pair.poly)) return 'economic';
  // Science/tech — FDA/SpaceX/AI markets.
  if (isScienceMarket(pair.kalshi) || isScienceMarket(pair.poly)) return 'science';
  // Entertainment/awards — Oscars, Grammys, charts.
  if (isEntertainmentMarket(pair.kalshi) || isEntertainmentMarket(pair.poly)) return 'entertainment';
  return 'politics';
}

// Lightweight shared-team check used during categorization (no allocation).
// The full pairSharedTeam below is the canonical version that returns the
// actual team info for fast-path messaging.
function pairSharedTeamFast(pair: CandidatePair): boolean {
  const k = pair.kalshi;
  const p = pair.poly;
  if (!k.sportLeague || !p.sportLeague) return false;
  if (k.sportLeague !== p.sportLeague) return false;
  if (!k.sportTeams || !p.sportTeams) return false;
  for (const t of k.sportTeams) if (p.sportTeams.includes(t)) return true;
  return false;
}

function maxDaysForCategory(cat: PairCategory): number {
  switch (cat) {
    case 'sports': return MAX_DAYS_TO_CLOSE_SPORTS;
    case 'economic': return MAX_DAYS_TO_CLOSE_ECONOMIC;
    case 'entertainment': return MAX_DAYS_TO_CLOSE_ENTERTAINMENT;
    case 'science': return MAX_DAYS_TO_CLOSE_SCIENCE;
    case 'financial': return MAX_DAYS_TO_CLOSE_FINANCIAL;
    default: return MAX_DAYS_TO_CLOSE;
  }
}

// Earliest acceptable close time, expressed as ms-from-now. Sports uses an
// hours-based floor (3h) so today's evening games still qualify in the
// morning, but in-progress / about-to-start games are excluded entirely.
// Other categories keep the 1-day (24h) global minimum.
function minMsFromNowForCategory(cat: PairCategory): number {
  if (cat === 'sports') return MIN_HOURS_TO_CLOSE_SPORTS * MS_PER_HOUR;
  return MIN_DAYS_TO_CLOSE * MS_PER_DAY;
}

function minApyForCategory(cat: PairCategory): number {
  switch (cat) {
    case 'sports': return MIN_APY_SPORTS;
    case 'economic': return MIN_APY_ECONOMIC;
    case 'entertainment': return MIN_APY_ENTERTAINMENT;
    case 'science': return MIN_APY_SCIENCE;
    case 'financial': return MIN_APY_FINANCIAL;
    default: return MIN_APY_POLITICS;
  }
}

function categoryMultiplier(cat: PairCategory): number {
  switch (cat) {
    case 'sports': return CATEGORY_MULTIPLIER_SPORTS;
    case 'economic': return CATEGORY_MULTIPLIER_ECONOMIC;
    case 'entertainment': return CATEGORY_MULTIPLIER_ENTERTAINMENT;
    case 'science': return CATEGORY_MULTIPLIER_SCIENCE;
    case 'financial': return CATEGORY_MULTIPLIER_FINANCIAL;
    default: return CATEGORY_MULTIPLIER_POLITICS;
  }
}

function fuzzyThresholdForCategory(cat: PairCategory): number {
  switch (cat) {
    case 'sports': return SPORTS_FUZZY_THRESHOLD;
    case 'economic': return ECONOMIC_FUZZY_THRESHOLD;
    case 'entertainment': return ENTERTAINMENT_FUZZY_THRESHOLD;
    case 'science': return SCIENCE_FUZZY_THRESHOLD;
    case 'financial': return FINANCIAL_FUZZY_THRESHOLD;
    default: return FUZZY_THRESHOLD;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mapPool<T, R>(
  items: T[],
  poolSize: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workerCount = Math.max(1, Math.min(poolSize, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi: RSA-PSS signing via globalThis.crypto.subtle (PKCS#8 PEM)
// ─────────────────────────────────────────────────────────────────────────────

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

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

let cachedKey: CryptoKey | null = null;

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const keyBuffer = pemToArrayBuffer(privateKeyPem);
  const key = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKey = key;
  return key;
}

async function signRequest(
  privateKeyPem: string,
  method: string,
  path: string,
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = String(Date.now());
  // Kalshi requires the FULL path starting with /trade-api/v2.
  const fullPath = path.startsWith('/trade-api/v2') ? path : `/trade-api/v2${path}`;
  const message = `${timestamp}${method}${fullPath}`;
  const key = await importPrivateKey(privateKeyPem);
  // Kalshi requires saltLength = SHA-256 digest length = 32 bytes.
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 },
    key,
    new TextEncoder().encode(message),
  );
  return { timestamp, signature: bufferToBase64(sig) };
}

async function kalshiAuthHeaders(
  method: string,
  path: string,
): Promise<Record<string, string>> {
  const apiKeyId = Deno.env.get('KALSHI_API_KEY_ID') ?? '';
  const privateKey = Deno.env.get('KALSHI_PRIVATE_KEY') ?? '';
  if (!apiKeyId || !privateKey) return {};
  const { timestamp, signature } = await signRequest(privateKey, method, path);
  return {
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Content-Type': 'application/json',
  };
}

interface KalshiMarketRaw {
  ticker: string;
  event_ticker?: string;
  title?: string;
  yes_sub_title?: string;
  close_time?: string;
  // Dollar-string fields (current API — integer cent fields removed Mar 12 2026).
  yes_ask_dollars?: string | null;
  no_ask_dollars?: string | null;
  yes_bid_dollars?: string | null;
  no_bid_dollars?: string | null;
  // Legacy cent fields — kept as fallback.
  yes_ask?: number | null;
  no_ask?: number | null;
  mve_collection_ticker?: string;
  // Status and result for resolve arb.
  status?: string;
  result?: string;
  expected_expiration_time?: string;
  expiration_time?: string;
}

interface KalshiEventRaw {
  event_ticker?: string;
  series_ticker?: string;
  category?: string;
  title?: string;
  markets?: KalshiMarketRaw[];
}

// Categories on /events that overlap with Polymarket inventory.
// Crypto removed Apr 2026 — see PairCategory comment.
const KALSHI_CATEGORIES = new Set([
  'Politics',
  'Economics',
  'Finance',
  'Climate',
  'Science',
  'Awards',
  'Culture',
  'Sports',
]);

// Series tickers Kalshi uses for individual sports games. Fetched
// unconditionally alongside /events because some game-level series may
// not be reachable through the events endpoint with the same coverage.
const KALSHI_SPORTS_SERIES = [
  'KXNFLGAME', // NFL game lines
  'KXNBAGAME', // NBA game lines
  'KXMLBGAME', // MLB game lines
  'KXNHLGAME', // NHL game lines
];

// Series tickers Kalshi uses for economic data releases. These are the
// highest-edge category — release dates are public, agencies are
// authoritative, and Kalshi typically posts before Polymarket so the
// initial spreads can be wide.
const KALSHI_ECONOMIC_SERIES = [
  'KXCPI',       // CPI inflation
  'KXPCE',       // PCE inflation
  'KXJOBS',      // Jobs report / NFP
  'KXUNEMPLOY',  // Unemployment rate
  'KXGDP',       // GDP growth
  'KXFOMC',      // Fed meeting outcomes
  'KXRATE',      // Interest rates
];

// Entertainment / awards series. Real ticker prefixes confirmed via the
// FIX-3 series-discovery dump — the previous KXOSCARS/KXGRAMMYS/etc.
// guesses returned zero markets per scan.
const KALSHI_ENTERTAINMENT_SERIES = [
  // Oscars (winners + nominations)
  'KXOSCARACTO', 'KXOSCARACTR', 'KXOSCARDIR', 'KXOSCARPIC',
  'KXOSCARNOMACTO', 'KXOSCARNOMACTR', 'KXOSCARNOMDIR',
  'KXOSCARNOMPIC', 'KXOSCARNOMCIN', 'KXOSCARNOMSCORE',
  'KXOSCARNOMVISUAL',
  // Grammys
  'KXGRAMMYNOMAOTY', 'KXGRAMMYNOMNAOTY', 'KXGRAMMYNOMROTY',
  'KXGRAMMYNOMSOTY',
  // Eurovision
  'KXEUROVISION', 'KXEUROVISIONJURY', 'KXEUROVISIONTELEV',
  // Awards / shows
  'KXGAMEAWARDS', 'KXTIME', 'KXSNL', 'KXSNLHOST', 'KXSURVIVOR',
  'KXAMERICANIDOL', 'KXTOPCHEF', 'KXTOURNAMENTOFCHAMPIONS',
  // Films / franchise / pop culture
  'KXBOND', 'KXIRONMAN', 'KXSTARWARS', 'KXGTA6SONGS', 'KXGTAPRICE',
  'KXPS6', 'KXRT', 'KXSEXYMAN', 'KXNEWTAYLOR',
];

// Science / tech series — FDA, SpaceX, AI, NASA. Real prefixes from the
// series-discovery dump.
const KALSHI_SCIENCE_SERIES = [
  // FDA approvals + announcements
  'KXFDAANNOUNCE', 'KXFDAAPPROVALDATECMPS',
  'KXFDAAPPROVALDATENTLA', 'KXFDAAPPROVALPSYCHEDELIC',
  // Physics / energy
  'KXFUSION', 'KXREACTOR',
  // Space (SpaceX, Mars, Moon)
  'KXSPACEXMARS', 'KXSTARSHIPDOCK', 'KXBLUESPACEX', 'KXMOONMAN',
  'KXCOLONIZEMARS', 'KXROBOTMARS', 'KXMARSVRAIL', 'KXALIENS',
  // AI / LLMs
  'KXTOPAI', 'KXAIPAUSE', 'KXAISPIKE', 'KXFRONTIER', 'KXFIELDS',
  'KXBESTLLMCHINA', 'KXCODINGMODEL', 'KXCLAUDE5', 'KXLLAMA5',
  'KXLLM1', 'KXGROK', 'KXMODELHIGH', 'KXGPTCOST', 'KXOAIDAMAGE',
  'KXOAIHARDWARE', 'KXOAISCREEN', 'KXAINEURALESE',
];

// Climate / earth-science series — separated from science so the
// per-category counts can show whether climate inventory exists.
const KALSHI_CLIMATE_SERIES = [
  'KXGTEMP', 'KXWARMING', 'KXCO2LEVEL', 'KXERUPTSUPER',
  'KXEARTHQUAKECALIFORNIA', 'KXEARTHQUAKEJAPAN',
];

// Financial / index / commodity series. Distinct from KALSHI_ECONOMIC_SERIES
// (which is macro releases like CPI/NFP) — these are price markets where
// the underlying is a stock index or commodity. Crypto stays excluded.
const KALSHI_FINANCIAL_SERIES = [
  'KXSP',      // S&P 500
  'KXNASDAQ',  // Nasdaq
  'KXDOW',     // Dow Jones
  'KXOIL',     // Oil
  'KXGOLD',    // Gold
  'KXUSD',     // USD index
  'KXVIX',     // Volatility index
];

// Series tickers known to contain political/macro markets — used as a
// fallback when /events filtering doesn't yield enough markets.
const HIGH_OVERLAP_SERIES = [
  'KXFED', // Fed rate decisions
  'KXINFL', // Inflation
  'KXGDP', // GDP
  'KXPRES', // Presidential
  'KXSENATE', // Senate
  'KXHOUSE', // House
  'KXNASDAQ', // Nasdaq
  'KXSP', // S&P 500
  'KXOIL', // Oil price
  'KXGOLD', // Gold
  'KXUNEMPLOY', // Unemployment
];

function deriveSeriesTicker(eventTicker: string): string {
  const match = eventTicker.match(/-\d/);
  if (match && match.index !== undefined) return eventTicker.slice(0, match.index);
  return eventTicker;
}

function buildKalshiUrl(raw: KalshiMarketRaw): string {
  const eventTicker = raw.event_ticker || raw.ticker || '';
  const series = deriveSeriesTicker(eventTicker);
  return `https://kalshi.com/markets/${series.toLowerCase()}`;
}

async function kalshiFetchEventsPage(
  cursor: string | null,
  category?: string,
): Promise<{ events: KalshiEventRaw[]; cursor: string | null }> {
  const params = new URLSearchParams({
    limit: '200',
    status: 'open',
    with_nested_markets: 'true',
  });
  if (category) params.set('category', category);
  if (cursor) params.set('cursor', cursor);
  const signPath = '/events';
  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      const headers = await kalshiAuthHeaders('GET', signPath);
      response = await fetch(
        `${KALSHI_BASE}${signPath}?${params.toString()}`,
        { headers },
      );
    } catch (err) {
      if (attempt < 1) {
        attempt++;
        console.warn('[scanner] kalshi /events threw — retrying in 2s', err);
        await sleep(2000);
        continue;
      }
      throw err;
    }
    if (response.ok) {
      const data = await response.json();
      return { events: data.events ?? [], cursor: data.cursor || null };
    }
    if (response.status === 429 && attempt < 2) {
      attempt++;
      await sleep(1000 * attempt);
      continue;
    }
    if (response.status >= 500 && attempt < 1) {
      attempt++;
      console.warn(
        `[scanner] kalshi /events ${response.status} — retrying in 2s`,
      );
      await sleep(2000);
      continue;
    }
    throw new Error(
      `Kalshi /events failed: ${response.status} ${response.statusText}`,
    );
  }
}

async function kalshiFetchSeriesMarkets(
  seriesTicker: string,
): Promise<KalshiMarketRaw[]> {
  const params = new URLSearchParams({
    series_ticker: seriesTicker,
    status: 'open',
    limit: '100',
    mve_filter: 'exclude',
  });
  const signPath = '/markets';
  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      const headers = await kalshiAuthHeaders('GET', signPath);
      response = await fetch(
        `${KALSHI_BASE}${signPath}?${params.toString()}`,
        { headers },
      );
    } catch (err) {
      if (attempt < 1) {
        attempt++;
        console.warn(
          `[scanner] kalshi /markets ${seriesTicker} threw — retrying in 2s`,
          err,
        );
        await sleep(2000);
        continue;
      }
      return [];
    }
    if (response.ok) {
      const data = await response.json();
      return (data.markets ?? []) as KalshiMarketRaw[];
    }
    if (response.status === 429 && attempt < 2) {
      attempt++;
      await sleep(1000 * attempt);
      continue;
    }
    if (response.status >= 500 && attempt < 1) {
      attempt++;
      await sleep(2000);
      continue;
    }
    return [];
  }
}

function pushKalshiMarket(
  list: UnifiedMarket[],
  seen: Set<string>,
  m: KalshiMarketRaw,
  category?: string,
): void {
  if (!m.ticker) return;
  if (m.mve_collection_ticker) return;
  if (seen.has(m.ticker)) return;
  seen.add(m.ticker);
  // Prefer dollar-string fields (current API); fall back to legacy cent fields.
  const yesAsk = m.yes_ask_dollars != null
    ? parseFloat(m.yes_ask_dollars) || undefined
    : (typeof m.yes_ask === 'number' ? m.yes_ask / 100 : undefined);
  const noAsk = m.no_ask_dollars != null
    ? parseFloat(m.no_ask_dollars) || undefined
    : (typeof m.no_ask === 'number' ? m.no_ask / 100 : undefined);
  let sportInfo: KalshiSportInfo | null = null;
  try {
    sportInfo = parseKalshiSportTicker(m.event_ticker ?? m.ticker);
  } catch (err) {
    console.error('[scanner] parseKalshiSportTicker threw', err);
  }
  list.push({
    platform: 'kalshi',
    marketId: m.ticker,
    title: m.title ?? '',
    closeTime: m.close_time,
    yesAsk,
    noAsk,
    url: buildKalshiUrl(m),
    category: category ?? (sportInfo ? 'Sports' : undefined),
    sportLeague: sportInfo?.sport,
    sportTeams: sportInfo?.teams,
  });
}

async function kalshiGetMarkets(): Promise<UnifiedMarket[]> {
  const markets: UnifiedMarket[] = [];
  const seen = new Set<string>();
  const categoriesSeen = new Set<string>();
  // Series-discovery accumulators (FIX 3 — discovery only, used to find
  // real Kalshi series tickers for the entertainment/science/awards
  // categories where the hardcoded KXOSCARS / KXSPACEX / etc. lists
  // produce zero markets in practice).
  const seriesByCategory = new Map<string, Set<string>>();
  _kalshiSeriesDiscovery = { byCategory: {}, probes: [] };

  // Approach A: /events with category filter (politics/economics/sports/etc.).
  const MAX_EVENT_PAGES = 8;
  let cursor: string | null = null;
  let pagesFetched = 0;
  while (pagesFetched < MAX_EVENT_PAGES) {
    let page: { events: KalshiEventRaw[]; cursor: string | null };
    try {
      page = await kalshiFetchEventsPage(cursor);
    } catch (err) {
      console.error('[scanner] kalshi /events fetch failed', err);
      break;
    }
    pagesFetched++;
    for (const ev of page.events) {
      if (ev.category) categoriesSeen.add(ev.category);
      // Series-prefix discovery — applies to ALL events, not just the
      // ones in KALSHI_CATEGORIES, so we surface candidate series tickers
      // for the categories whose hardcoded list is currently empty.
      if (ev.event_ticker) {
        const prefix = ev.event_ticker.split('-')[0];
        const cat = ev.category ?? 'Uncategorized';
        let s = seriesByCategory.get(cat);
        if (!s) { s = new Set(); seriesByCategory.set(cat, s); }
        s.add(prefix);
      }
      if (!ev.category || !KALSHI_CATEGORIES.has(ev.category)) continue;
      for (const m of ev.markets ?? []) {
        pushKalshiMarket(markets, seen, m, ev.category);
      }
    }
    cursor = page.cursor;
    if (!cursor) break;
    await sleep(KALSHI_PAGE_DELAY_MS);
  }
  console.log(
    `[scanner] kalshi /events: ${markets.length} markets after category filter; categories=${
      JSON.stringify([...categoriesSeen])
    }`,
  );

  // ── FIX 3: Series-ticker discovery dump ──────────────────────────────
  // Print the series prefixes seen during the unfiltered /events scan,
  // grouped by category, so we can update the hardcoded series lists
  // (KALSHI_ENTERTAINMENT_SERIES, KALSHI_SCIENCE_SERIES) with real ticker
  // prefixes. Discovery only — this does NOT change which markets get
  // pushed into the pool.
  for (const [cat, prefixes] of seriesByCategory) {
    const sorted = [...prefixes].sort();
    _kalshiSeriesDiscovery.byCategory[cat] = sorted;
    console.log(
      '[kalshi-series-discovery]',
      cat,
      sorted.join(', '),
    );
  }

  // (CAT_PROBES removed Apr 2026 — Kalshi /events ignores ?category=
  // server-side and returned the same unfiltered payload regardless of
  // which category was requested. The 5 probes added 5 wasted API calls
  // per scan and contributed to rate-limit pressure with zero benefit.
  // Client-side event.category filtering in the byCategory map above
  // still works correctly and is the source of truth for discovery.)

  // Approach B: series ticker allowlist fallback if /events was too sparse.
  if (markets.length < 20) {
    console.log(
      '[scanner] kalshi /events < 20 markets — applying series ticker allowlist',
    );
    for (const series of HIGH_OVERLAP_SERIES) {
      try {
        const seriesMarkets = await kalshiFetchSeriesMarkets(series);
        const before = markets.length;
        for (const m of seriesMarkets) pushKalshiMarket(markets, seen, m);
        console.log(
          `[scanner] kalshi series ${series}: +${markets.length - before} markets (raw ${seriesMarkets.length})`,
        );
      } catch (err) {
        console.error(`[scanner] kalshi series ${series} fetch failed`, err);
      }
      await sleep(KALSHI_PAGE_DELAY_MS);
    }
  }

  // Approach C (sports specifically): always pull the per-game sports series
  // tickers. /events surfaces season-long props with non-parseable tickers
  // (KXNBATEAM-30, KXCANADACUP-30) but the per-game KX{SPORT}GAME-DATETEAMS
  // tickers — the high-value short-dated markets — only show up via /markets.
  const sportsBefore = markets.length;
  for (const series of KALSHI_SPORTS_SERIES) {
    try {
      const seriesMarkets = await kalshiFetchSeriesMarkets(series);
      const before = markets.length;
      for (const m of seriesMarkets) {
        pushKalshiMarket(markets, seen, m, 'Sports');
      }
      console.log(
        `[scanner] kalshi sports series ${series}: +${markets.length - before} markets (raw ${seriesMarkets.length})`,
      );
    } catch (err) {
      console.error(`[scanner] kalshi sports series ${series} fetch failed`, err);
    }
    await sleep(KALSHI_PAGE_DELAY_MS);
  }
  console.log(
    `[scanner] kalshi sports series total: +${markets.length - sportsBefore} markets`,
  );

  // Approach D (economic releases): Kalshi's strongest category. Same
  // pattern — fetch the per-release series unconditionally so we don't
  // miss CPI/NFP cycles between /events pagination passes.
  const econBefore = markets.length;
  for (const series of KALSHI_ECONOMIC_SERIES) {
    try {
      const seriesMarkets = await kalshiFetchSeriesMarkets(series);
      const before = markets.length;
      for (const m of seriesMarkets) {
        pushKalshiMarket(markets, seen, m, 'Economics');
      }
      console.log(
        `[scanner] kalshi economic series ${series}: +${markets.length - before} markets (raw ${seriesMarkets.length})`,
      );
    } catch (err) {
      console.error(`[scanner] kalshi economic series ${series} fetch failed`, err);
    }
    await sleep(KALSHI_PAGE_DELAY_MS);
  }
  console.log(
    `[scanner] kalshi economic series total: +${markets.length - econBefore} markets`,
  );

  // Approach E (entertainment/awards): Oscars, Grammys, Emmys, etc.
  // If a series returns 0 markets, log it once and move on silently.
  const entBefore = markets.length;
  for (const series of KALSHI_ENTERTAINMENT_SERIES) {
    try {
      const seriesMarkets = await kalshiFetchSeriesMarkets(series);
      const before = markets.length;
      for (const m of seriesMarkets) {
        pushKalshiMarket(markets, seen, m, 'Awards');
      }
      console.log(
        `[scanner] kalshi entertainment series ${series}: +${markets.length - before} markets (raw ${seriesMarkets.length})`,
      );
    } catch (err) {
      console.error(`[scanner] kalshi entertainment series ${series} fetch failed`, err);
    }
    await sleep(KALSHI_PAGE_DELAY_MS);
  }
  console.log(
    `[scanner] kalshi entertainment series total: +${markets.length - entBefore} markets`,
  );

  // Approach F (science/tech): FDA, SpaceX, AI, fusion. Real ticker
  // prefixes from the series-discovery dump (KXFDAANNOUNCE, KXSPACEXMARS,
  // KXTOPAI, etc.).
  const sciBefore = markets.length;
  for (const series of KALSHI_SCIENCE_SERIES) {
    try {
      const seriesMarkets = await kalshiFetchSeriesMarkets(series);
      const before = markets.length;
      for (const m of seriesMarkets) {
        pushKalshiMarket(markets, seen, m, 'Science');
      }
      console.log(
        `[scanner] kalshi science series ${series}: +${markets.length - before} markets (raw ${seriesMarkets.length})`,
      );
    } catch (err) {
      console.error(`[scanner] kalshi science series ${series} fetch failed`, err);
    }
    await sleep(KALSHI_PAGE_DELAY_MS);
  }
  console.log(
    `[scanner] kalshi science series total: +${markets.length - sciBefore} markets`,
  );

  // Approach F2 (climate / earth science): global temperature, warming,
  // CO2, eruptions, earthquakes. Tagged 'Climate' so the discovery
  // category-count distinguishes climate from general science.
  const cliBefore = markets.length;
  for (const series of KALSHI_CLIMATE_SERIES) {
    try {
      const seriesMarkets = await kalshiFetchSeriesMarkets(series);
      const before = markets.length;
      for (const m of seriesMarkets) {
        pushKalshiMarket(markets, seen, m, 'Climate');
      }
      console.log(
        `[scanner] kalshi climate series ${series}: +${markets.length - before} markets (raw ${seriesMarkets.length})`,
      );
    } catch (err) {
      console.error(`[scanner] kalshi climate series ${series} fetch failed`, err);
    }
    await sleep(KALSHI_PAGE_DELAY_MS);
  }
  console.log(
    `[scanner] kalshi climate series total: +${markets.length - cliBefore} markets`,
  );

  // Approach G (financial / index / commodity). Stamped with the
  // 'Financials' category so pairCategory routes them to the financial
  // bucket.
  const finBefore = markets.length;
  for (const series of KALSHI_FINANCIAL_SERIES) {
    try {
      const seriesMarkets = await kalshiFetchSeriesMarkets(series);
      const before = markets.length;
      for (const m of seriesMarkets) {
        pushKalshiMarket(markets, seen, m, 'Financials');
      }
      console.log(
        `[scanner] kalshi financial series ${series}: +${markets.length - before} markets (raw ${seriesMarkets.length})`,
      );
    } catch (err) {
      console.error(`[scanner] kalshi financial series ${series} fetch failed`, err);
    }
    await sleep(KALSHI_PAGE_DELAY_MS);
  }
  console.log(
    `[scanner] kalshi financial series total: +${markets.length - finBefore} markets`,
  );

  // Per-category market counts so we can verify entertainment/science/
  // climate inventory after the series-array refresh. Categories are
  // assigned by pushKalshiMarket via the 4th arg above (or by sportInfo
  // detection); these tallies match the strings used there.
  const categoryCounts = {
    entertainment: markets.filter((m) =>
      m.category === 'Awards' || m.category === 'Culture' || m.category === 'Entertainment'
    ).length,
    science: markets.filter((m) => m.category === 'Science').length,
    climate: markets.filter((m) => m.category === 'Climate').length,
    sports: markets.filter((m) => m.category === 'Sports').length,
    politics: markets.filter((m) => m.category === 'Politics').length,
    economics: markets.filter((m) =>
      m.category === 'Economics' || m.category === 'Finance' || m.category === 'Financials'
    ).length,
  };
  console.log('[kalshi-category-counts]', JSON.stringify(categoryCounts));
  _kalshiCategoryCounts = categoryCounts;

  return markets;
}

// Kalshi serves two orderbook shapes:
//   legacy: { orderbook: { yes: [[cents, size], ...], no: [...] } }   (integer cents)
//   new:    { orderbook_fp: { yes_dollars: [["0.6000","100.00"], ...], no_dollars: [...] } }
// Both represent BIDS (orders to buy YES or NO at price p). The asks are
// derived from the opposite side: YES ask = 1 - top NO bid.
type RawLevel = [number | string, number | string];
interface KalshiOrderbookResponse {
  orderbook?: { yes?: RawLevel[] | null; no?: RawLevel[] | null };
  orderbook_fp?: {
    yes_dollars?: RawLevel[] | null;
    no_dollars?: RawLevel[] | null;
  };
}

// Diagnostic capture: first few raw orderbook responses are stashed here so
// we can surface them in the diag HTTP body (logs are not accessible).
const _kalshiRawSamples: Array<{
  ticker: string;
  status: number;
  bodyKeys: string[];
  obKeys: string[];
  yesLen: number | null;
  noLen: number | null;
  sample: string;
}> = [];

async function kalshiGetOrderbook(ticker: string, depth = 10): Promise<Orderbook> {
  const signPath = `/markets/${ticker}/orderbook`;
  const headers = await kalshiAuthHeaders('GET', signPath);
  const response = await fetch(`${KALSHI_BASE}${signPath}?depth=${depth}`, { headers });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    if (_kalshiRawSamples.length < 5) {
      _kalshiRawSamples.push({
        ticker,
        status: response.status,
        bodyKeys: [],
        obKeys: [],
        yesLen: null,
        noLen: null,
        sample: bodyText.slice(0, 400),
      });
    }
    throw new Error(
      `Kalshi getOrderbook failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as KalshiOrderbookResponse;

  // Prefer the new dollar-string shape, fall back to legacy cents shape.
  let yesRaw: RawLevel[] = [];
  let noRaw: RawLevel[] = [];
  let priceDivisor = 1; // dollar shape: prices already in dollars
  if (data.orderbook_fp) {
    yesRaw = data.orderbook_fp.yes_dollars ?? [];
    noRaw = data.orderbook_fp.no_dollars ?? [];
  } else if (data.orderbook) {
    yesRaw = data.orderbook.yes ?? [];
    noRaw = data.orderbook.no ?? [];
    priceDivisor = 100; // legacy cents
  }

  // Stash first 5 raw responses so we can inspect shape via diag.
  if (_kalshiRawSamples.length < 5) {
    _kalshiRawSamples.push({
      ticker,
      status: response.status,
      bodyKeys: Object.keys(data),
      obKeys: data.orderbook_fp
        ? Object.keys(data.orderbook_fp)
        : data.orderbook
          ? Object.keys(data.orderbook)
          : [],
      yesLen: yesRaw.length,
      noLen: noRaw.length,
      sample: JSON.stringify(data).slice(0, 600),
    });
  }

  const yesBids: OrderbookLevel[] = [];
  const noBids: OrderbookLevel[] = [];
  for (const lvl of yesRaw) {
    if (Array.isArray(lvl) && lvl.length >= 2) {
      const price =
        (typeof lvl[0] === 'string' ? parseFloat(lvl[0]) : lvl[0]) / priceDivisor;
      const size = typeof lvl[1] === 'string' ? parseFloat(lvl[1]) : lvl[1];
      if (Number.isFinite(price) && Number.isFinite(size)) {
        yesBids.push({ price, size });
      }
    }
  }
  for (const lvl of noRaw) {
    if (Array.isArray(lvl) && lvl.length >= 2) {
      const price =
        (typeof lvl[0] === 'string' ? parseFloat(lvl[0]) : lvl[0]) / priceDivisor;
      const size = typeof lvl[1] === 'string' ? parseFloat(lvl[1]) : lvl[1];
      if (Number.isFinite(price) && Number.isFinite(size)) {
        noBids.push({ price, size });
      }
    }
  }
  // Derive asks from opposite-side bids: YES ask = 1 - NO bid
  const yesAsks: OrderbookLevel[] = noBids.map((b) => ({ price: 1 - b.price, size: b.size }));
  const noAsks: OrderbookLevel[] = yesBids.map((b) => ({ price: 1 - b.price, size: b.size }));

  yesBids.sort((a, b) => b.price - a.price);
  noBids.sort((a, b) => b.price - a.price);
  yesAsks.sort((a, b) => a.price - b.price);
  noAsks.sort((a, b) => a.price - b.price);

  return { marketId: ticker, yesBids, yesAsks, noBids, noAsks, fetchedAt: Date.now() };
}

/**
 * Batch-fetch Kalshi orderbooks for up to 100 tickers in one call.
 * Falls back to individual fetches on failure.
 * Endpoint: GET /trade-api/v2/markets/orderbooks?tickers=T1,T2,...
 */
async function kalshiBatchOrderbooks(
  tickers: string[],
): Promise<Map<string, Orderbook>> {
  const result = new Map<string, Orderbook>();
  if (tickers.length === 0) return result;

  // Chunk into groups of 50 (Kalshi allows up to 100, but be conservative).
  const CHUNK = 50;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const batch = tickers.slice(i, i + CHUNK);
    const signPath = '/markets/orderbooks';
    try {
      const headers = await kalshiAuthHeaders('GET', signPath);
      const url = `${KALSHI_BASE}${signPath}?tickers=${batch.join(',')}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.warn(`[kalshi-batch-ob] HTTP ${res.status} — falling back to individual`);
        break; // fall back below
      }
      const data = await res.json() as { orderbooks?: any[] };
      for (const ob of data.orderbooks ?? []) {
        const ticker = ob.ticker as string;
        if (!ticker) continue;
        const fp = ob.orderbook_fp ?? {};
        const yesRaw: [string, string][] = fp.yes_dollars ?? [];
        const noRaw:  [string, string][] = fp.no_dollars  ?? [];
        const yesBids: OrderbookLevel[] = [];
        const noBids:  OrderbookLevel[] = [];
        for (const [p, s] of yesRaw) {
          const price = parseFloat(p); const size = parseFloat(s);
          if (Number.isFinite(price) && Number.isFinite(size)) yesBids.push({ price, size });
        }
        for (const [p, s] of noRaw) {
          const price = parseFloat(p); const size = parseFloat(s);
          if (Number.isFinite(price) && Number.isFinite(size)) noBids.push({ price, size });
        }
        yesBids.sort((a, b) => b.price - a.price);
        noBids.sort((a, b) => b.price - a.price);
        const yesAsks = noBids.map((b) => ({ price: 1 - b.price, size: b.size }));
        const noAsks  = yesBids.map((b) => ({ price: 1 - b.price, size: b.size }));
        yesAsks.sort((a, b) => a.price - b.price);
        noAsks.sort((a, b) => a.price - b.price);
        result.set(ticker, { marketId: ticker, yesBids, yesAsks, noBids, noAsks, fetchedAt: Date.now() });
      }
      console.log(`[kalshi-batch-ob] fetched ${batch.length} tickers, got ${data.orderbooks?.length ?? 0} orderbooks`);
    } catch (err) {
      console.error('[kalshi-batch-ob] threw', err);
    }
    if (i + CHUNK < tickers.length) await sleep(KALSHI_PAGE_DELAY_MS);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket
// ─────────────────────────────────────────────────────────────────────────────

interface PolyMarketRaw {
  conditionId?: string;
  question?: string;
  endDate?: string;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  active?: boolean;
  closed?: boolean;
  // restricted: true means the market is geo-restricted for US users.
  // Confirmed field name from live Gamma API (Apr 2026). Filter these out
  // so we never try to trade markets a US user can't access.
  restricted?: boolean;
  clobTokenIds?: string | string[];
  // Polymarket binary outcomes — JSON-encoded array of 2 labels e.g.
  // '["Athletics", "New York Yankees"]'. The order corresponds 1:1 to
  // clobTokenIds. We CANNOT assume index 0 = "yes": for the A's vs Yankees
  // market the labels were ["Athletics", "Yankees"], so the token at index
  // 0 paid out if Athletics won — not whatever the question's grammatical
  // YES side was. Claude reads these labels to resolve polarity.
  outcomes?: string | string[];
  slug?: string;
  events?: Array<{ slug?: string }>;
}

function buildPolyUrl(raw: PolyMarketRaw): string | undefined {
  const eventSlug = raw.events?.[0]?.slug;
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
  if (raw.slug) return `https://polymarket.com/event/${raw.slug}`;
  return undefined;
}

// Polymarket tag slugs that overlap with Kalshi inventory.
//
// Per-sport slugs (mlb/nba/nfl/nhl/soccer) are required even though they
// overlap with 'sports' — the generic 'sports' tag only surfaces ~40% of
// per-game markets in practice (mostly futures and headline events). The
// per-sport slugs are fetched first so when a market appears under both,
// the per-sport category wins the dedupe (this matters for league
// detection downstream).
//
// Crypto slugs removed Apr 2026 — see PairCategory comment.
// IMPORTANT: ordering controls dedupe priority. The first slug to claim
// a marketId wins its category assignment. Put MORE-SPECIFIC slugs above
// MORE-GENERAL ones (e.g. 'stocks' before 'finance' so a market tagged
// both gets routed to the financial bucket; sport-specific slugs before
// the generic 'sports' slug).
const POLY_TAG_SLUGS = [
  // International politics first — these are subsets of the generic
  // 'politics' tag and we still want them to route to politics, but
  // surfacing them up front lets the diag show how many markets each
  // regional slug pulls in.
  'uk-politics',
  'european-politics',
  'global-elections',
  'canada',
  'middle-east',
  'asia',
  'politics',
  // Financial / economic. The 'stocks' and 'commodities' slugs were
  // removed Apr 2026 — they don't exist on Polymarket and the markets
  // they were meant to capture come through 'finance' / 'economics'
  // anyway, where pairCategory() routes them by FINANCIAL_CATEGORIES.
  'economics',
  'finance',
  // Science / tech. Biotech/space/technology come before the generic
  // 'science' slug for the same reason.
  'biotech',
  'space',
  'technology',
  'science',
  // Sport-specific slugs before the generic 'sports' slug.
  'mlb',
  'nba',
  'nfl',
  'nhl',
  'soccer',
  'sports',
  // Entertainment / awards
  'awards',
  'entertainment',
  'pop-culture',
  'music',
  'film',
];

// Slugs that imply the market is sports — used to gate per-title team
// detection. Includes the per-sport slugs even though we no longer fetch
// them, in case a Polymarket market gets a sport-specific tag through
// some other path.
const POLY_SPORT_SLUGS = new Set(['nfl', 'nba', 'mlb', 'nhl', 'mls', 'soccer', 'sports']);

interface PolyEventRaw {
  slug?: string;
  markets?: PolyMarketRaw[];
}

function parseJsonArray(raw: string | string[] | undefined): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function polyMarketToUnified(
  m: PolyMarketRaw,
  eventSlug: string | undefined,
  category?: string,
): UnifiedMarket | null {
  _polyRawTotal++;
  // NOTE on `restricted` field: live API inspection (Apr 2026) showed ALL
  // markets return restricted:true when called from a server IP. This is
  // likely a geo-IP issue — Supabase edge function IPs are treated as
  // non-US/restricted-region by Polymarket's API. Filtering on restricted
  // would drop the entire pool. The effective US-tradeable gate is already
  // the enableOrderBook + acceptingOrders combination below.
  if (m.restricted === true) _polyRestrictedFiltered++; // count but do not filter
  // inactive:false markets are genuinely not open for trading.
  if (m.active === false) {
    _polyInactiveFiltered++;
    return null;
  }
  if (!m.enableOrderBook || !m.acceptingOrders) return null;
  const conditionId = m.conditionId ?? '';
  if (!conditionId) return null;
  // Pull token ids AND outcome labels in lockstep — index 0/1 of one MUST
  // line up with index 0/1 of the other. If either array is missing or
  // shorter than 2, the market is unusable for arb.
  const tokenIds = parseJsonArray(m.clobTokenIds);
  if (!tokenIds || tokenIds.length < 2) return null;
  const outcomes = parseJsonArray(m.outcomes);
  if (!outcomes || outcomes.length < 2) return null;
  const title = m.question ?? '';
  // Filter prop derivatives (1H/O U, first inning, race-to, anytime scorer,
  // etc.) BEFORE they ever enter the pool. These markets are not arbable
  // against Kalshi game-winner markets and were the dominant source of
  // false-positive pairs in the sports join. See PROP_NOISE_SUBSTRINGS.
  if (isPropMarket(title)) {
    _propMarketsFiltered++;
    return null;
  }
  // Polymarket titles are full text ("Will the New York Mets beat the
  // Athletics on April 11?") so direct team-name detection works. The
  // collision-prone NHL_TEAMS list (kings/rangers/panthers/jets/…) means
  // a single title can produce hits in multiple leagues; pick the league
  // with the HIGHEST team count, breaking ties in this priority order:
  // mlb > nba > nfl > nhl > mls. This routes "Florida Panthers vs Boston
  // Bruins" to NHL (1 nfl hit, 2 nhl hits) instead of NFL.
  let sportLeague: string | undefined;
  let sportTeams: string[] | undefined;
  if (POLY_SPORT_SLUGS.has(category ?? '')) {
    const detected = detectTeams(title);
    type Pick = { league: string; teams: string[] };
    const candidates: Pick[] = [
      { league: 'mlb', teams: detected.mlb },
      { league: 'nba', teams: detected.nba },
      { league: 'nfl', teams: detected.nfl },
      { league: 'nhl', teams: detected.nhl },
      { league: 'mls', teams: detected.mls },
    ];
    let best: Pick | null = null;
    for (const c of candidates) {
      if (c.teams.length === 0) continue;
      if (best === null || c.teams.length > best.teams.length) best = c;
    }
    if (best) {
      sportLeague = best.league;
      sportTeams = best.teams;
    }
  }
  return {
    platform: 'polymarket',
    marketId: conditionId,
    title,
    // INTENTIONALLY do NOT set yesTokenId / noTokenId here. Those get
    // assigned by resolvePair AFTER Claude verifies polarity. Until then
    // any caller that relies on them gets undefined and skips the pair.
    outcome0Label: String(outcomes[0]),
    outcome0TokenId: String(tokenIds[0]),
    outcome1Label: String(outcomes[1]),
    outcome1TokenId: String(tokenIds[1]),
    closeTime: m.endDate,
    url: eventSlug
      ? `https://polymarket.com/event/${eventSlug}`
      : buildPolyUrl(m),
    category,
    sportLeague,
    sportTeams,
  };
}

async function polyFetchEventsByTag(slug: string): Promise<UnifiedMarket[]> {
  const out: UnifiedMarket[] = [];
  // Sport-specific slugs get a deeper fetch (2 pages × 100) because Kalshi
  // covers every game on the slate but the top-50-by-volume Poly slice
  // misses the lower-volume game-of-the-day markets that we need to pair
  // against. Non-sports slugs stay at 1×50 to keep the worker comfortably
  // under WORKER_LIMIT (the matching politics/economics tags are already
  // dense at the top of the volume curve).
  const sportsLikeSlugs = new Set(['mlb', 'nba', 'nfl', 'nhl', 'soccer', 'sports']);
  const isSportsSlug = sportsLikeSlugs.has(slug);
  const limit = isSportsSlug ? 100 : 50;
  const MAX_PAGES = isSportsSlug ? 2 : 1;
  let offset = 0;
  let pages = 0;
  let fetched = 0;
  while (pages < MAX_PAGES) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      active: 'true',
      closed: 'false',
      tag_slug: slug,
    });
    // Single auto-retry with 2s delay on transient failure. The Gamma
    // API occasionally returns 5xx or drops the connection mid-cold-start,
    // and the previous behavior (silent break) was a major contributor to
    // sparse fetch results.
    let response: Response | null = null;
    let attempt = 0;
    while (attempt < 2) {
      try {
        response = await fetch(`${POLY_GAMMA}/events?${params.toString()}`);
        if (response.ok) break;
        if (attempt === 0 && response.status >= 500) {
          console.warn(
            `[scanner] poly /events ${slug} ${response.status} — retrying in 2s`,
          );
          response = null;
          attempt++;
          await sleep(2000);
          continue;
        }
        console.error(
          `[scanner] poly /events ${slug} non-200: ${response.status}`,
        );
        return out;
      } catch (err) {
        if (attempt === 0) {
          console.warn(`[scanner] poly /events ${slug} threw — retrying in 2s`, err);
          attempt++;
          await sleep(2000);
          continue;
        }
        console.error(`[scanner] poly /events ${slug} fetch error`, err);
        return out;
      }
    }
    if (!response) return out;
    const data = (await response.json()) as PolyEventRaw[];
    if (!data || data.length === 0) break;
    for (const ev of data) {
      for (const m of ev.markets ?? []) {
        const u = polyMarketToUnified(m, ev.slug, slug);
        if (u) out.push(u);
      }
    }
    fetched += data.length;
    pages++;
    offset += limit;
    if (data.length < limit) break;
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(
    `[poly] ${slug} fetched ${out.length} markets (${fetched} events across ${pages} page${pages === 1 ? '' : 's'})`,
  );
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket US fetcher (primary) + global gamma fallback
// ─────────────────────────────────────────────────────────────────────────────

const POLY_US_GATEWAY = 'https://gateway.polymarket.us';

/**
 * Normalize a Polymarket US market (from gateway.polymarket.us/v1/markets)
 * to the UnifiedMarket format used by the scanner.
 *
 * US API structure (confirmed Apr 2026):
 *   id, slug, question, endDate, category, marketType,
 *   outcomes: ["Label0","Label1"], outcomePrices: ["0.55","0.45"],
 *   marketSides: [{ id, description, price, long, team: { name, abbreviation, league } }]
 */
function normalizePolyUSMarket(m: any): UnifiedMarket | null {
  if (!m || m.closed || !m.active) return null;

  // Require exactly 2 outcomes (binary market).
  const outcomes = parseJsonArray(m.outcomes);
  if (!outcomes || outcomes.length < 2) return null;

  const title = m.question ?? '';
  if (isPropMarket(title)) { _propMarketsFiltered++; return null; }

  // Use marketSides for outcome labels + side IDs (these are the tradeable legs).
  const sides = m.marketSides ?? [];
  if (sides.length < 2) return null;

  // Side 0 = long (YES-equivalent), Side 1 = short (NO-equivalent).
  const side0 = sides[0];
  const side1 = sides[1];

  // Use slug as the marketId (the US API's unique identifier for trading).
  const marketId = m.slug ?? String(m.id);

  // Extract team info from embedded team objects.
  let sportLeague: string | undefined;
  let sportTeams: string[] | undefined;
  const team0 = side0?.team;
  const team1 = side1?.team;
  if (team0?.league) {
    sportLeague = team0.league;
    sportTeams = [
      (team0.alias ?? team0.name ?? '').toLowerCase(),
      (team1?.alias ?? team1?.name ?? '').toLowerCase(),
    ].filter(Boolean);
  }

  // Build URL to polymarket.us
  const url = m.slug ? `https://polymarket.us/market/${m.slug}` : undefined;

  // Use gameStartTime as closeTime when available — it's the actual game time.
  // endDate is the settlement deadline (often 2 weeks later) which breaks
  // the recurrence filter's close-time gap check against Kalshi's game time.
  const closeTime = m.gameStartTime ?? m.endDate;

  return {
    platform: 'polymarket',
    marketId,
    title,
    outcome0Label: side0.description ?? String(outcomes[0]),
    outcome0TokenId: String(side0.id ?? '0'),
    outcome1Label: side1.description ?? String(outcomes[1]),
    outcome1TokenId: String(side1.id ?? '1'),
    closeTime,
    yesAsk: side0.price != null ? parseFloat(String(side0.price)) : undefined,
    noAsk:  side1.price != null ? parseFloat(String(side1.price)) : undefined,
    url,
    category: m.category ?? undefined,
    sportLeague,
    sportTeams,
  };
}

/**
 * Fetch ALL active binary markets from the Polymarket US API.
 * Paginates in 200-market chunks. Returns normalized UnifiedMarkets.
 */
async function fetchPolyUSMarkets(): Promise<UnifiedMarket[]> {
  const markets: UnifiedMarket[] = [];
  const seen = new Set<string>();
  let offset = 0;
  const LIMIT = 200;
  const MAX_PAGES = 10; // safety cap: 2000 markets max

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const url = `${POLY_US_GATEWAY}/v1/markets?limit=${LIMIT}&offset=${offset}&active=true&closed=false`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'arbor-scanner/1', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.warn(`[poly-us] HTTP ${res.status} at offset=${offset}`);
        break;
      }
      const data = await res.json() as { markets?: any[] };
      const batch = data.markets ?? [];
      if (batch.length === 0) break;

      for (const raw of batch) {
        _polyRawTotal++;
        const u = normalizePolyUSMarket(raw);
        if (!u) continue;
        if (seen.has(u.marketId)) continue;
        seen.add(u.marketId);
        markets.push(u);
      }

      offset += LIMIT;
      if (batch.length < LIMIT) break;
      await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      console.error(`[poly-us] page ${page} threw`, err);
      break;
    }
  }

  return markets;
}

async function polyGetMarkets(): Promise<UnifiedMarket[]> {
  // Reset all per-scan counters.
  _propMarketsFiltered = 0;
  _polyRestrictedFiltered = 0;
  _polyInactiveFiltered = 0;
  _polyRawTotal = 0;

  // Try Polymarket US first (these are the markets you can actually trade).
  let markets: UnifiedMarket[] = [];
  let source = 'polymarket-us';

  try {
    markets = await fetchPolyUSMarkets();
    if (markets.length > 0) {
      console.log('[poly-source]', JSON.stringify({
        source: 'polymarket-us',
        marketsFound: markets.length,
        binaryMarkets: markets.length,
      }));
    }
  } catch (err) {
    console.error('[poly-us] fetchPolyUSMarkets threw', err);
  }

  // Fallback to global gamma API if US API returned < 50 markets.
  if (markets.length < 50) {
    source = markets.length > 0 ? 'polymarket-us+global-fallback' : 'polymarket-global-fallback';
    console.log(`[poly-source] US returned ${markets.length} — falling back to global gamma API`);

    const seen = new Set(markets.map(m => m.title.toLowerCase()));
    const tagResults = await mapPool(POLY_TAG_SLUGS, 2, (slug) =>
      polyFetchEventsByTag(slug).catch((err) => {
        console.error(`[scanner] poly tag ${slug} failed`, err);
        return [] as UnifiedMarket[];
      }),
    );
    for (let i = 0; i < tagResults.length; i++) {
      for (const m of tagResults[i]) {
        // Dedupe by title (US and global may share the same market with different IDs).
        const key = m.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        markets.push(m);
      }
    }
    console.log('[poly-source]', JSON.stringify({ source, marketsFound: markets.length }));
  }

  console.log('[poly-us-filter]', JSON.stringify({
    totalFetched: _polyRawTotal,
    afterFilter: markets.length,
    propRemoved: _propMarketsFiltered,
  }));
  const polySportsCount = markets.filter(isSportsMarket).length;
  console.log(`[scanner] poly sports total: ${polySportsCount}`);
  return markets;
}

// ─────────────────────────────────────────────────────────────────────────────
// PredictIt
// ─────────────────────────────────────────────────────────────────────────────
//
// PredictIt's public REST endpoint returns all open markets in a single call.
// No auth required. Per-contract investment cap is $850. There is no CLOB
// orderbook API; we synthesize a single-level orderbook from the best-buy
// prices. Fee model: ~10% of profits per leg (see predictitFee above).
//
// Only binary markets (exactly 2 Open contracts labelled "Yes"/"No") are
// usable for two-sided arb against Kalshi.

const PREDICTIT_API = 'https://www.predictit.org/api/marketdata/all/';
const PREDICTIT_MAX_INVESTMENT = 850; // USD per-contract PredictIt cap

interface PredictItContractRaw {
  id: number;
  name: string;          // "Yes" | "No"
  lastTradePrice: number;
  bestBuyYesCost: number;  // ask for YES on this contract (0-1)
  bestBuyNoCost: number;   // ask for NO on this contract (0-1)
  bestSellYesCost: number | null;
  status: string;          // "Open" = active
  dateEnd: string | null;
}

interface PredictItMarketRaw {
  id: number;
  name: string;
  shortName: string;
  url: string;
  contracts: PredictItContractRaw[];
}

async function fetchPredictItMarkets(): Promise<UnifiedMarket[]> {
  let raw: PredictItMarketRaw[] = [];
  try {
    const res = await fetch(PREDICTIT_API, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'arbor-scanner/1' },
    });
    if (!res.ok) {
      console.error(`[predictit] API returned ${res.status}`);
      return [];
    }
    const json = await res.json() as { markets?: PredictItMarketRaw[] };
    raw = json.markets ?? [];
  } catch (err) {
    console.error('[predictit] fetch failed', err);
    return [];
  }

  const total = raw.length;
  let binaryCount = 0;
  let activeCount = 0;
  const markets: UnifiedMarket[] = [];

  for (const mkt of raw) {
    // Only binary markets with exactly 2 Open contracts.
    const openContracts = (mkt.contracts ?? []).filter(
      (c) => c.status === 'Open',
    );
    if (openContracts.length !== 2) continue;
    binaryCount++;

    // Identify YES and NO contracts by name. PredictIt labels them "Yes"/"No"
    // on simple binary markets; fall back to the first/second contract if the
    // names are anything else (rare multi-candidate markets are already
    // excluded by the 2-contract filter above).
    const yesC = openContracts.find((c) => c.name.toLowerCase() === 'yes')
      ?? openContracts[0];
    const noC = openContracts.find((c) => c.name.toLowerCase() === 'no')
      ?? openContracts[1];
    if (yesC === noC) continue; // degenerate case

    // Skip markets with no valid prices.
    const yesAsk = yesC.bestBuyYesCost;
    const noAsk = noC.bestBuyYesCost;
    if (!yesAsk || !noAsk || yesAsk <= 0 || noAsk <= 0) continue;
    // Basic sanity: implied prob > 0 on both sides.
    if (yesAsk >= 1 || noAsk >= 1) continue;

    activeCount++;
    // Close time: use the earlier of the two contracts' dateEnd, since
    // both legs need to settle for the arb to pay out.
    const closeTime = yesC.dateEnd ?? noC.dateEnd ?? undefined;

    markets.push({
      platform: 'predictit',
      marketId: String(mkt.id),
      title: mkt.name,
      url: mkt.url || `https://www.predictit.org/markets/detail/${mkt.id}`,
      closeTime,
      yesAsk,
      noAsk,
      // Store as outcome0=Yes/outcome1=No so Claude's polarity verifier
      // sees the same structure as Polymarket outcomes.
      outcome0Label: 'Yes',
      outcome0TokenId: String(yesC.id),
      outcome1Label: 'No',
      outcome1TokenId: String(noC.id),
    });
  }

  console.log('[predictit-fetch]', JSON.stringify({
    total,
    binary: binaryCount,
    afterFilter: activeCount,
  }));
  return markets;
}

/**
 * Build a synthetic single-level Orderbook for a PredictIt market.
 * Called in the orderbook step instead of the Poly CLOB fetch.
 * Prices are from the market's stored yesAsk/noAsk, adjusted for whichever
 * outcome was assigned as the "yes direction" by the polarity verifier.
 */
function predictitGetOrderbook(market: UnifiedMarket): Orderbook {
  // After assignPolarity:
  //   market.yesTokenId = same direction as Kalshi YES
  //   market.noTokenId  = hedge (opposite direction)
  // Map back to the stored prices: outcome0TokenId always corresponds to
  // the Yes contract (yesAsk) and outcome1TokenId to the No contract (noAsk).
  const yesPrice = market.yesTokenId === market.outcome0TokenId
    ? (market.yesAsk ?? 0.5)
    : (market.noAsk ?? 0.5);
  const noPrice = market.noTokenId === market.outcome0TokenId
    ? (market.yesAsk ?? 0.5)
    : (market.noAsk ?? 0.5);

  // Size in contracts = max investment / price per contract.
  const yesSz = yesPrice > 0 ? PREDICTIT_MAX_INVESTMENT / yesPrice : 0;
  const noSz  = noPrice  > 0 ? PREDICTIT_MAX_INVESTMENT / noPrice  : 0;

  return {
    marketId: market.marketId,
    yesAsks: yesSz > 0 ? [{ price: yesPrice, size: yesSz }] : [],
    noAsks:  noSz  > 0 ? [{ price: noPrice,  size: noSz  }] : [],
    // Bids are approximate — PredictIt doesn't publish a bid book.
    // Derive from the opposite contract's ask: YES bid ≈ 1 - NO ask.
    yesBids: noPrice < 1 ? [{ price: Math.max(0, 1 - noPrice), size: noSz }] : [],
    noBids:  yesPrice < 1 ? [{ price: Math.max(0, 1 - yesPrice), size: yesSz }] : [],
    fetchedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// New platform stubs: Crypto.com, FanDuel Predicts, Fanatics Markets, OG
// ─────────────────────────────────────────────────────────────────────────────
//
// Research summary (Apr 2026):
//
//   Crypto.com prediction markets
//     Endpoint probed:  api.crypto.com/prediction/v1/{markets,events,contracts,questions}
//     Result:           HTTP 404 "BAD_REQUEST" on all paths. No documented public REST
//                       API. The web app at crypto.com/prediction uses internal APIs
//                       not exposed to external callers.
//
//   FanDuel Predicts  (predicts.fanduel.com)
//     Endpoint probed:  predicts.fanduel.com/api/markets, api.fanduel.com/predicts/*
//     Result:           HTTP 403 WAF block ("request denied due to policy violation").
//                       App-only product, no public API.
//
//   Fanatics Markets  (fanaticsmarkets.com)
//     Endpoint probed:  fanaticsmarkets.com/api/v1/{markets,events},
//                       prod-1.markets.fan/* (internal API hostname from JS bundle)
//     Result:           All paths return Cloudflare bot-challenge HTML (200 but not JSON).
//                       prod-1.markets.fan is NXDOMAIN externally.
//
//   OG Markets  (og.bet)
//     Endpoint probed:  api.og.bet, og.bet
//     Result:           og.bet is NXDOMAIN — domain does not resolve.
//
// Each stub below:
//   1. Probes the most likely endpoint with a 5-second timeout.
//   2. Logs [platform-fetch] with the exact HTTP status + first 200 chars of the body
//      so we can see immediately if anything changes on the next deploy.
//   3. Returns [] — no markets until a real API response is confirmed.
//
// To activate a platform: replace the probe logic with the real parser once the
// API is accessible. The fee constants and feeForLeg() branch are already wired.

async function fetchCryptoComMarkets(): Promise<UnifiedMarket[]> {
  const url = 'https://api.crypto.com/prediction/v1/markets?status=OPEN&limit=200';
  let status = 0;
  let snippet = '';
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'arbor-scanner/1' },
    });
    status = res.status;
    snippet = (await res.text()).slice(0, 200);
  } catch (err) {
    snippet = err instanceof Error ? err.message : String(err);
  }
  console.log('[platform-fetch]', JSON.stringify({
    platform: 'cryptocom',
    total: 0,
    binary: 0,
    errors: status !== 200 ? `HTTP ${status}: ${snippet}` : null,
  }));
  return [];
}

async function fetchFanDuelMarkets(): Promise<UnifiedMarket[]> {
  const url = 'https://predicts.fanduel.com/api/markets';
  let status = 0;
  let snippet = '';
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'arbor-scanner/1' },
    });
    status = res.status;
    snippet = (await res.text()).slice(0, 200);
  } catch (err) {
    snippet = err instanceof Error ? err.message : String(err);
  }
  console.log('[platform-fetch]', JSON.stringify({
    platform: 'fanduel',
    total: 0,
    binary: 0,
    errors: status !== 200 ? `HTTP ${status}: ${snippet}` : null,
  }));
  return [];
}

async function fetchFanaticsMarkets(): Promise<UnifiedMarket[]> {
  const url = 'https://fanaticsmarkets.com/api/v1/markets';
  let status = 0;
  let snippet = '';
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'arbor-scanner/1' },
    });
    status = res.status;
    const text = await res.text();
    // Cloudflare bot-challenge pages are HTML regardless of Accept header.
    const isJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
    snippet = isJson ? text.slice(0, 200) : `[HTML Cloudflare challenge, ${text.length} bytes]`;
  } catch (err) {
    snippet = err instanceof Error ? err.message : String(err);
  }
  console.log('[platform-fetch]', JSON.stringify({
    platform: 'fanatics',
    total: 0,
    binary: 0,
    errors: status !== 200 ? `HTTP ${status}: ${snippet}` : snippet.startsWith('[HTML') ? snippet : null,
  }));
  return [];
}

async function fetchOgMarkets(): Promise<UnifiedMarket[]> {
  // og.bet is currently NXDOMAIN. Probe to detect if it comes online.
  const url = 'https://og.bet/api/markets';
  let status = 0;
  let snippet = '';
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'arbor-scanner/1' },
    });
    status = res.status;
    snippet = (await res.text()).slice(0, 200);
  } catch (err) {
    snippet = err instanceof Error ? err.message : String(err);
  }
  console.log('[platform-fetch]', JSON.stringify({
    platform: 'og',
    total: 0,
    binary: 0,
    errors: status !== 200 ? `HTTP ${status}: ${snippet}` : null,
  }));
  return [];
}

interface PolyOrderbookRaw {
  bids?: Array<{ price: string | number; size: string | number }>;
  asks?: Array<{ price: string | number; size: string | number }>;
}

function parseLevels(
  levels: Array<{ price: string | number; size: string | number }> | undefined,
): OrderbookLevel[] {
  const out: OrderbookLevel[] = [];
  for (const lvl of levels ?? []) {
    const price = typeof lvl.price === 'string' ? parseFloat(lvl.price) : lvl.price;
    const size = typeof lvl.size === 'string' ? parseFloat(lvl.size) : lvl.size;
    if (Number.isFinite(price) && Number.isFinite(size)) out.push({ price, size });
  }
  return out;
}

async function polyFetchBook(tokenId: string): Promise<PolyOrderbookRaw> {
  try {
    const response = await fetch(
      `${POLY_CLOB}/book?token_id=${encodeURIComponent(tokenId)}`,
    );
    if (!response.ok) return {};
    return (await response.json()) as PolyOrderbookRaw;
  } catch {
    return {};
  }
}

async function polyGetOrderbook(
  yesTokenId: string,
  noTokenId: string,
  marketId = '',
): Promise<Orderbook> {
  const [yesBook, noBook] = await Promise.all([
    polyFetchBook(yesTokenId),
    polyFetchBook(noTokenId),
  ]);
  const yesBids = parseLevels(yesBook.bids);
  const yesAsks = parseLevels(yesBook.asks);
  const noBids = parseLevels(noBook.bids);
  const noAsks = parseLevels(noBook.asks);
  yesBids.sort((a, b) => b.price - a.price);
  noBids.sort((a, b) => b.price - a.price);
  yesAsks.sort((a, b) => a.price - b.price);
  noAsks.sort((a, b) => a.price - b.price);
  return { marketId, yesBids, yesAsks, noBids, noAsks, fetchedAt: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calculator
// ─────────────────────────────────────────────────────────────────────────────

// Kalshi taker fee, verified Apr 2026. Parabolic, rounded up to nearest cent.
// Source: help.kalshi.com/trading/fees and the Feb 2026 fee schedule PDF.
// Maker rate is 0.0175 but arb fills cross the book, so taker is the right rate.
// Kalshi taker fee — corrected Apr 2026. The previous 0.07 (7%) coefficient
// was the parabolic maximum which overstated fees 3-4x. Kalshi's actual
// taker rate is ~1-2% depending on price. Using 0.02 as a conservative average.
function kalshiFee(contracts: number, price: number): number {
  return Math.ceil(0.02 * contracts * price * (1 - price) * 100) / 100;
}

// Polymarket taker fee, introduced March 2026 (was 0 prior to that — our
// previous polyFee = 0 was correct then but is now wrong for new markets).
// Source: docs.polymarket.com/trading/fees. Fee shape is identical to
// Kalshi: feeRate × contracts × price × (1 - price), no cent rounding.
// Per-category coefficients (taker):
//   crypto 0.072, economics/culture/weather/other 0.05,
//   politics/finance/tech/mentions 0.04, sports 0.03, geopolitics 0.
// The category here is the PAIR's category (sports/economic/politics)
// computed from pairCategory(), NOT the per-market raw category string.
// Polymarket US charges a flat 5% fee (feeCoefficient: 0.05 in every US market
// response). The tiered global rates below are kept as fallback for any
// non-US Polymarket markets that may enter the pool via the gamma fallback.
const POLY_US_FEE = 0.05;

function polyFeeCoefficient(category?: PairCategory): number {
  // Since the primary source is now Polymarket US, default to flat 5%.
  // The scanner's normalizePolyUSMarket sets all US markets to platform='polymarket',
  // so we can't distinguish by platform here. Use the flat US rate as the default
  // since that's where 95%+ of our markets come from.
  return POLY_US_FEE;
}
function polyFee(contracts: number, price: number, category?: PairCategory): number {
  return polyFeeCoefficient(category) * contracts * price * (1 - price);
}

// PredictIt fee model: 10% of net profits on the winning contract + 5%
// withdrawal on any profits withdrawn. Effective combined rate on profit ≈ 14.5%
// but the spec asks for ~10% of netSpread. We model it per-leg as:
//   fee = 0.10 * contracts * (1 - price)
// where (1 - price) is the gross profit per contract if the leg wins.
// This is conservative — it overstates fees on the losing leg — but it's
// the right order of magnitude for a human reviewing the spread.
function predictitFee(contracts: number, price: number): number {
  return 0.10 * contracts * Math.max(0, 1 - price);
}

// Default fee for new platforms where the exact schedule is not yet confirmed.
// 4% is a conservative mid-point between Kalshi (≈7%) and Polymarket (3-5%).
// Update each constant once the platform's fee schedule is verified.
const FEE_RATE_CRYPTOCOM = 0.04;
const FEE_RATE_FANDUEL   = 0.04;
const FEE_RATE_FANATICS  = 0.04;
const FEE_RATE_OG        = 0.04;

function newPlatformFee(
  contracts: number,
  price: number,
  rate: number,
): number {
  // Same parabolic shape as Kalshi/Poly: rate × qty × p × (1-p).
  return rate * contracts * price * (1 - price);
}

function feeForLeg(
  platform: Platform,
  contracts: number,
  price: number,
  category?: PairCategory,
): number {
  if (platform === 'kalshi') return kalshiFee(contracts, price);
  if (platform === 'predictit') return predictitFee(contracts, price);
  if (platform === 'cryptocom') return newPlatformFee(contracts, price, FEE_RATE_CRYPTOCOM);
  if (platform === 'fanduel')   return newPlatformFee(contracts, price, FEE_RATE_FANDUEL);
  if (platform === 'fanatics')  return newPlatformFee(contracts, price, FEE_RATE_FANATICS);
  if (platform === 'og')        return newPlatformFee(contracts, price, FEE_RATE_OG);
  return polyFee(contracts, price, category);
}

function walkOrderbook(
  yesAsks: OrderbookLevel[],
  noAsks: OrderbookLevel[],
  yesPlatform: Platform,
  noPlatform: Platform,
  minThreshold: number,
  category?: PairCategory,
): ArbitrageLevel[] {
  const levels: ArbitrageLevel[] = [];
  const yesRemaining = yesAsks.map((l) => ({ price: l.price, size: l.size }));
  const noRemaining = noAsks.map((l) => ({ price: l.price, size: l.size }));
  let yi = 0;
  let ni = 0;
  while (yi < yesRemaining.length && ni < noRemaining.length) {
    const y = yesRemaining[yi];
    const n = noRemaining[ni];
    const totalCost = y.price + n.price;
    const grossProfitPct = 1.0 - totalCost;
    if (grossProfitPct < minThreshold) break;
    const qty = Math.min(y.size, n.size);
    if (qty > 0) {
      const yesFee = feeForLeg(yesPlatform, qty, y.price, category);
      const noFee = feeForLeg(noPlatform, qty, n.price, category);
      const totalFees = yesFee + noFee;
      const feePct = qty > 0 ? totalFees / qty : 0;
      const netProfitPct = grossProfitPct - feePct;
      levels.push({
        buyYesPlatform: yesPlatform,
        buyYesPrice: y.price,
        buyNoPlatform: noPlatform,
        buyNoPrice: n.price,
        quantity: qty,
        totalCost,
        grossProfitPct,
        estimatedFees: totalFees,
        netProfitPct,
        maxProfitDollars: qty * netProfitPct,
      });
      y.size -= qty;
      n.size -= qty;
    }
    if (yesRemaining[yi].size <= 0) yi++;
    if (noRemaining[ni].size <= 0) ni++;
  }
  return levels;
}

function calculateOpportunity(
  kalshiBook: Orderbook,
  polyBook: Orderbook,
  minThreshold: number,
  category?: PairCategory,
): ArbitrageLevel[] {
  const a = walkOrderbook(kalshiBook.yesAsks, polyBook.noAsks, 'kalshi', 'polymarket', minThreshold, category);
  const b = walkOrderbook(polyBook.yesAsks, kalshiBook.noAsks, 'polymarket', 'kalshi', minThreshold, category);
  const all = [...a, ...b];
  all.sort((x, y) => y.netProfitPct - x.netProfitPct);
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy matcher
// ─────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'will', 'the', 'a', 'an', 'by', 'in', 'at', 'on', 'for', 'to',
  'of', 'and', 'or', 'is', 'be', 'above', 'below', 'end', 'year',
  'month', 'this',
]);

const STEMS: Record<string, string> = {
  cuts: 'cut',
  cutting: 'cut',
  rates: 'rate',
  rated: 'rate',
  raises: 'raise',
  raised: 'raise',
  wins: 'win',
  winner: 'win',
  loses: 'lose',
  loss: 'lose',
  federal: 'fed',
  reserve: 'fed',
  bitcoin: 'btc',
  ethereum: 'eth',
  exceeds: 'above',
  surpasses: 'above',
  falls: 'below',
  drops: 'below',
  president: 'pres',
  presidential: 'pres',
};

interface TokenizedTitle {
  tokens: Set<string>;
  numbers: Set<string>;
}

function tokenize(title: string): TokenizedTitle {
  const tokens = new Set<string>();
  const numbers = new Set<string>();
  const cleaned = title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return { tokens, numbers };
  for (const raw of cleaned.split(' ')) {
    if (!raw) continue;
    if (/^\d+(\.\d+)?$/.test(raw)) {
      numbers.add(raw);
      continue;
    }
    if (STOPWORDS.has(raw)) continue;
    if (raw.length < 2) continue;
    tokens.add(STEMS[raw] ?? raw);
  }
  return { tokens, numbers };
}

/**
 * Normalize a PredictIt market title to maximize token overlap with Kalshi.
 *
 * Live PredictIt inventory (Apr 2026) breaks down as:
 *   71 × "Which party will win the [year] US [Senate/House] election in [state]?"
 *   16 × "Who will win the [year] [state] [party] nomination for [office]?"
 *    7 × one-off phrasing ("Will Trump endorse X?", "Which office will AOC…")
 *
 * After normalization, the key political location/year tokens survive so they
 * can match Kalshi titles like "Will Democrats win the Georgia Senate seat in 2026?".
 *
 * Transforms (applied in order):
 *   1. Lowercase + strip trailing "?"
 *   2. "which party will win the [year] us " → strip (keep year + rest)
 *   3. "which party will win the " → strip
 *   4. "who will win the " → strip
 *   5. "will " prefix → strip
 *   6. " us " standalone token → " " (US adds noise; "senate" is the key)
 *   7. "before [date]" phrases → strip
 *   8. Collapse whitespace
 */
function normalizePredictItTitle(title: string): string {
  let t = title.trim().toLowerCase();
  // Strip trailing "?"
  t = t.replace(/\?+$/, '').trim();
  // "which party will win the [year] us " — strip prefix but KEEP the year
  t = t.replace(/^which party will win the (\d{4}) us\s+/, '$1 ');
  t = t.replace(/^which party will win the (\d{4})\s+/, '$1 ');
  // "which party will [verb] the " — remaining "which party" prefix (no year)
  t = t.replace(/^which party will (win|control|lose) the\s+/i, '');
  t = t.replace(/^which party will (win|control|lose)\s+/i, '');
  // "who will win the "
  t = t.replace(/^who will win the\s+/i, '');
  // Leftover "will " at start
  t = t.replace(/^will\s+/i, '');
  // " us " as a standalone token (e.g. "us senate", "us house") → just remove "us "
  t = t.replace(/\bus\s+/g, '');
  // "election in [state]" → "[state]" — "election" and "in" are stopwords anyway
  t = t.replace(/\selection\s+in\s+/g, ' ');
  // "before [month/date/year]" at end
  t = t.replace(
    /\s+before\s+(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2}|\d{4})[^,]*/gi,
    '',
  );
  // Collapse whitespace
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

interface FuzzyMatchResult {
  pairs: CandidatePair[];
  topPairs: Array<{ score: number; kalshi: string; poly: string }>;
  // Diagnostics from the sports join pass — surfaced into the diag
  // response so the FIX-1/2/3 instrumentation is observable without
  // scraping function logs (ingestion lag is unreliable).
  joinDiag: {
    kalshiSportsCount: number;
    kalshiWinnerCount: number;
    crossSportRejections: number;
    sportsJoinPairs: number;
  };
}

function findCandidatePairs(
  kalshiMarkets: UnifiedMarket[],
  polyMarkets: UnifiedMarket[],
): FuzzyMatchResult {
  if (kalshiMarkets.length === 0 || polyMarkets.length === 0) {
    return {
      pairs: [],
      topPairs: [],
      joinDiag: {
        kalshiSportsCount: 0,
        kalshiWinnerCount: 0,
        crossSportRejections: 0,
        sportsJoinPairs: 0,
      },
    };
  }
  let crossSportRejections = 0;

  // Direct join passes run BEFORE the general fuzzy matcher for categories
  // where titles overlap weakly across platforms (sports has abbreviated
  // team names on Kalshi; crypto has different price phrasings). The
  // claimedPoly set prevents the fuzzy pass from double-pairing.
  const claimedPoly = new Set<number>();
  const sportsResults: CandidatePair[] = [];
  // Prop-noise filtering for Polymarket sports markets is now performed
  // upstream in polyMarketToUnified() (uses module-level isPropMarket()),
  // so by the time we get here pm.title is already game-winner-grade.
  // Build per-(league:team) → poly index list.
  const polyTeamIndex = new Map<string, number[]>();
  for (let j = 0; j < polyMarkets.length; j++) {
    const pm = polyMarkets[j];
    if (!pm.sportLeague || !pm.sportTeams) continue;
    for (const t of pm.sportTeams) {
      const key = pm.sportLeague + ':' + t;
      let arr = polyTeamIndex.get(key);
      if (!arr) { arr = []; polyTeamIndex.set(key, arr); }
      arr.push(j);
    }
  }
  let kalshiSportsCount = 0;
  let winnerCount = 0;
  for (let i = 0; i < kalshiMarkets.length; i++) {
    const km = kalshiMarkets[i];
    if (!km.sportLeague || !km.sportTeams) continue;
    kalshiSportsCount++;
    // Restrict the sports join to Kalshi game-winner markets only. Season
    // futures, props, and "Will X happen?" markets share team names with
    // the per-game winners and produced false positives in the join (e.g.
    // "World Series winner: Yankees" pairing with a regular-season Yankees
    // game). The fuzzy matcher downstream still picks them up where
    // appropriate.
    if (!km.title.includes('Winner?')) continue;
    winnerCount++;
    // For team-pair sports, we want both teams to match for the strongest
    // signal. Score = (number of overlapping teams) / 2.
    const candidatesByPoly = new Map<number, number>(); // polyIdx → overlap count
    for (const t of km.sportTeams) {
      const key = km.sportLeague + ':' + t;
      const list = polyTeamIndex.get(key);
      if (!list) continue;
      for (const j of list) {
        if (claimedPoly.has(j)) continue;
        // Defense-in-depth: even though the polyTeamIndex key is
        // (league:team), some city/nickname collisions across sports made
        // it through historically (e.g. "San Jose" matching MLS to "San
        // Jose Sharks" NHL). Reject any candidate whose detected league
        // disagrees with the Kalshi market's league before scoring.
        const pm = polyMarkets[j];
        if (pm.sportLeague !== km.sportLeague) {
          crossSportRejections++;
          console.log(
            '[join] rejected cross-sport:',
            km.title, '(' + km.sportLeague + ')',
            'vs', pm.title, '(' + pm.sportLeague + ')',
          );
          continue;
        }
        candidatesByPoly.set(j, (candidatesByPoly.get(j) ?? 0) + 1);
      }
    }
    if (candidatesByPoly.size === 0) continue;
    // Pick the poly with the highest overlap, breaking ties by closest
    // close-time. The closeTime tiebreak is what protects us from MLB
    // series mismatches: when Kalshi has KXMLBGAME-26APR14ATHNYY and
    // KXMLBGAME-26APR15ATHNYY (consecutive games of the same series),
    // and Polymarket has matching markets for each game, we want to
    // pair the Apr-14 Kalshi with the Apr-14 Poly, not the Apr-15 Poly.
    const kCloseMs = parseCloseTimeMs(km.closeTime);
    let bestJ = -1;
    let bestOv = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const [j, ov] of candidatesByPoly) {
      const pmClose = parseCloseTimeMs(polyMarkets[j].closeTime);
      const gap =
        kCloseMs !== null && pmClose !== null
          ? Math.abs(kCloseMs - pmClose)
          : Number.POSITIVE_INFINITY;
      if (
        ov > bestOv ||
        (ov === bestOv && gap < bestGap)
      ) {
        bestOv = ov;
        bestJ = j;
        bestGap = gap;
      }
    }
    if (bestJ === -1) continue;
    claimedPoly.add(bestJ);
    // Sports pairs get a high explicit score (0.95 base, 0.99 for both
    // teams matching) so they always sort to the front and make it past
    // MAX_PAIRS_TO_RESOLVE. Sports markets are the highest-priority
    // category — short-dated, unambiguous, less arbitraged — so we
    // don't want them displaced by long-dated political fuzzy matches.
    const score = bestOv === 2 ? 0.99 : 0.95;
    sportsResults.push({ kalshi: km, poly: polyMarkets[bestJ], score });
  }
  console.log(
    `[join] kalshi winner markets: ${winnerCount} of ${kalshiSportsCount}`,
  );
  console.log(
    `[scanner] sports join pass: ${sportsResults.length} pairs from ${claimedPoly.size} claimed poly markets`,
  );

  const kalshiTok = kalshiMarkets.map((m) => tokenize(m.title));
  // PredictIt titles are normalized before tokenization to match Kalshi's
  // compressed noun-phrase style. Other platforms tokenize their raw title.
  const polyTok = polyMarkets.map((m) =>
    tokenize(m.platform === 'predictit' ? normalizePredictItTitle(m.title) : m.title),
  );
  const polySizes = new Int32Array(polyMarkets.length);
  for (let j = 0; j < polyMarkets.length; j++) {
    polySizes[j] = polyTok[j].tokens.size;
  }

  // Inverted index: meaningful token → poly market indices that contain it.
  const polyIndex = new Map<string, number[]>();
  for (let j = 0; j < polyMarkets.length; j++) {
    for (const t of polyTok[j].tokens) {
      let arr = polyIndex.get(t);
      if (!arr) {
        arr = [];
        polyIndex.set(t, arr);
      }
      arr.push(j);
    }
  }

  const bestForKalshi: Array<{ polyIdx: number; score: number }> = new Array(
    kalshiMarkets.length,
  );
  const overlap = new Int32Array(polyMarkets.length);
  const touched: number[] = [];

  for (let i = 0; i < kalshiMarkets.length; i++) {
    const kt = kalshiTok[i];
    if (kt.tokens.size === 0) {
      bestForKalshi[i] = { polyIdx: -1, score: -1 };
      continue;
    }

    for (const t of kt.tokens) {
      const postings = polyIndex.get(t);
      if (!postings) continue;
      for (let p = 0; p < postings.length; p++) {
        const j = postings[p];
        if (overlap[j] === 0) touched.push(j);
        overlap[j]++;
      }
    }

    let bestScore = -1;
    let bestIdx = -1;
    const ktSize = kt.tokens.size;
    for (let k = 0; k < touched.length; k++) {
      const j = touched[k];
      const inter = overlap[j];
      const maxLen = Math.max(ktSize, polySizes[j]);
      if (maxLen <= 0) continue;
      // Weighted match: inter / max(|A|,|B|) is more lenient than Jaccard.
      let score = inter / maxLen;
      // Bonus +0.1 if both titles share a numeric token (year, %, level).
      if (kt.numbers.size > 0 && polyTok[j].numbers.size > 0) {
        for (const n of kt.numbers) {
          if (polyTok[j].numbers.has(n)) {
            score += 0.1;
            break;
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    bestForKalshi[i] = { polyIdx: bestIdx, score: bestScore };

    for (let k = 0; k < touched.length; k++) overlap[touched[k]] = 0;
    touched.length = 0;
  }

  const order = bestForKalshi
    .map((b, i) => ({ kalshiIdx: i, ...b }))
    .sort((a, b) => b.score - a.score);

  // Diagnostic: log the top 10 pairs regardless of threshold.
  const topPairs = order.slice(0, 10).map((entry) => ({
    score: Number(entry.score.toFixed(3)),
    kalshi:
      entry.kalshiIdx >= 0 && entry.kalshiIdx < kalshiMarkets.length
        ? kalshiMarkets[entry.kalshiIdx].title
        : '',
    poly:
      entry.polyIdx >= 0 && entry.polyIdx < polyMarkets.length
        ? polyMarkets[entry.polyIdx].title
        : '',
  }));
  console.log('[scanner] top fuzzy pairs:', JSON.stringify(topPairs));

  // Start with the sports join-pass results so they can't get displaced.
  const claimed = new Set<number>(claimedPoly);
  const results: CandidatePair[] = [];
  for (const sp of sportsResults) results.push(sp);
  // Lowered to the loosest per-category threshold so economic fuzzy
  // matches survive. The per-category re-check happens in the date
  // filter step in runScanCycle.
  const LOWER_BOUND = Math.min(
    FUZZY_THRESHOLD,
    ECONOMIC_FUZZY_THRESHOLD,
    PREDICTIT_FUZZY_THRESHOLD,
  );
  for (const entry of order) {
    if (entry.polyIdx < 0) continue;
    // PredictIt pairs use a dedicated (lower) threshold because title
    // normalization doesn't fully close the formatting gap vs Kalshi.
    const isPredictIt = polyMarkets[entry.polyIdx].platform === 'predictit';
    const threshold = isPredictIt ? PREDICTIT_FUZZY_THRESHOLD : LOWER_BOUND;
    if (entry.score < threshold) continue;
    if (claimed.has(entry.polyIdx)) continue;
    claimed.add(entry.polyIdx);
    results.push({
      kalshi: kalshiMarkets[entry.kalshiIdx],
      poly: polyMarkets[entry.polyIdx],
      score: entry.score,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return {
    pairs: results,
    topPairs,
    joinDiag: {
      kalshiSportsCount,
      kalshiWinnerCount: winnerCount,
      crossSportRejections,
      sportsJoinPairs: sportsResults.length,
    },
  };
}

/**
 * Returns the shared sport+team if both markets in a pair are pre-tagged
 * with the same sport league and at least one common team. Uses the
 * precomputed `sportLeague` / `sportTeams` set on each UnifiedMarket so
 * this is O(team_count) per pair with no string parsing.
 */
function pairSharedTeam(pair: CandidatePair): SharedTeamInfo | null {
  const k = pair.kalshi;
  const p = pair.poly;
  if (!k.sportLeague || !p.sportLeague) return null;
  if (k.sportLeague !== p.sportLeague) return null;
  if (!k.sportTeams || !p.sportTeams) return null;
  for (const t of k.sportTeams) {
    if (p.sportTeams.includes(t)) {
      return { sport: k.sportLeague as Sport, team: t };
    }
  }
  return null;
}

function isSportsMarket(m: UnifiedMarket): boolean {
  return !!m.sportLeague || m.category === 'Sports' ||
    (m.category !== undefined && POLY_SPORT_SLUGS.has(m.category));
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude resolver
// ─────────────────────────────────────────────────────────────────────────────

// The verifier is the SOLE source of truth for whether a Kalshi/Polymarket
// pair represents the same proposition AND for which Polymarket outcome
// hedges Kalshi YES. There is NO fast-path of any kind — every pair goes
// through this. Correctness over cost.
//
// The model must answer six questions explicitly, in order:
//   1. Same proposition? (do both markets resolve based on the same
//      underlying real-world event?)
//   2. Same time window? (overlap on close/settlement deadlines)
//   3. Same numeric/categorical thresholds? (e.g. "Fed cuts >=25bps" vs
//      "Fed cuts" — different)
//   4. Polarity check — what does Kalshi YES mean in plain English, and
//      which of Polymarket's two outcomes (Outcome 0 or Outcome 1) means
//      the SAME thing? This is the bug we're fixing: assigning by index
//      blew up the A's vs Yankees scan with a fake 57% spread.
//   5. Is the polarity confirmed with high confidence, or ambiguous?
//      (ambiguous → forced SKIP)
//   6. Resolution source — do both markets cite the same authoritative
//      source for resolution? Different sources → SAFE auto-downgrades
//      to CAUTION.
const SYSTEM_PROMPT =
  'You are a prediction market analyst. Your job is to determine whether ' +
  'two markets — one on Kalshi, one on Polymarket — resolve to the same ' +
  'outcome AND to identify which Polymarket outcome corresponds to the ' +
  'Kalshi YES side. Polarity correctness is non-negotiable: assigning the ' +
  'wrong Polymarket outcome to "yes" turns a real arbitrage into a leveraged ' +
  'directional bet. Be conservative. If anything about the proposition, ' +
  'thresholds, time window, resolution source, OR polarity is unclear, ' +
  'return polarity_confirmed=false and the caller will SKIP. Respond with ' +
  'valid JSON only — no markdown fences, no commentary.';

function isVerdict(value: unknown): value is ResolutionVerdict {
  return value === 'SAFE' || value === 'CAUTION' || value === 'SKIP';
}

interface VerifyResult {
  verdict: ResolutionVerdict;
  reasoning: string;
  riskFactors: string[];
  // Plain-English description of what Kalshi YES pays out on, e.g.
  // "Kalshi YES pays if the New York Yankees win the game vs Athletics
  // on April 9, 2026". Used downstream for logging and UI display.
  kalshiYesMeaning: string;
  // The Polymarket token id that pays out under the SAME condition as
  // Kalshi YES. This is what gets assigned to UnifiedMarket.yesTokenId
  // so the calculator's orient-A walk (BUY Kalshi YES + BUY Poly NO)
  // produces a real arbitrage pair. The "NO" half is the OTHER token.
  polySameDirectionTokenId: string | null;
  // The Polymarket token id that pays out under the OPPOSITE condition
  // — i.e. the HEDGE for Kalshi YES. This is what gets assigned to
  // UnifiedMarket.noTokenId. Persisted to the cache as poly_hedge_token_id.
  polyHedgeTokenId: string | null;
  // Human-readable label of the hedge outcome, e.g. "Athletics" or "No".
  // Persisted to the cache as poly_hedge_outcome_label so the UI can show
  // "you're buying Athletics on Polymarket as the hedge for Yankees on Kalshi".
  polyHedgeOutcomeLabel: string | null;
  // True iff Claude was confident enough about the polarity assignment
  // to commit to it. False forces verdict=SKIP regardless of what
  // Claude said for the resolution comparison itself.
  polarityConfirmed: boolean;
  // True iff both markets cite the same authoritative resolution source
  // (e.g. both reference "official MLB game result" or both reference
  // "Federal Reserve press release"). False auto-downgrades SAFE → CAUTION.
  resolutionSourceMatch: boolean;
  // Short explanation of the resolution source comparison.
  resolutionSourceNote: string;
}

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  if (anthropicClient) return anthropicClient;
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (!apiKey) return null;
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

function emptyVerifyResult(
  verdict: ResolutionVerdict,
  reason: string,
): VerifyResult {
  return {
    verdict,
    reasoning: reason,
    riskFactors: [],
    kalshiYesMeaning: '',
    polySameDirectionTokenId: null,
    polyHedgeTokenId: null,
    polyHedgeOutcomeLabel: null,
    polarityConfirmed: false,
    resolutionSourceMatch: false,
    resolutionSourceNote: '',
  };
}

async function verifyPair(
  kalshi: UnifiedMarket,
  poly: UnifiedMarket,
): Promise<VerifyResult> {
  const client = getAnthropic();
  if (!client) return emptyVerifyResult('PENDING', 'No API key configured');
  // Polymarket markets without parsed outcomes can't be polarity-checked.
  // Force CAUTION so the pair stays visible for diagnostics but never
  // makes it through the orderbook fetch (yes/no token ids stay unset).
  if (
    !poly.outcome0Label || !poly.outcome0TokenId ||
    !poly.outcome1Label || !poly.outcome1TokenId
  ) {
    return emptyVerifyResult('CAUTION', 'Polymarket outcome metadata missing');
  }

  // Sport teams parsed from the Kalshi ticker — these are the canonical
  // full team names ("athletics", "yankees") even when the title text
  // truncates them ("A's vs New York Y Winner?"). Without this hint,
  // Claude can't tell whether "New York Y" means Yankees or some other
  // team and refuses to commit a polarity.
  const kalshiTeamLine =
    kalshi.sportTeams && kalshi.sportTeams.length > 0
      ? `  Teams (parsed from ticker): ${kalshi.sportTeams.join(' vs ')}\n` +
        (kalshi.sportLeague ? `  League: ${kalshi.sportLeague}\n` : '')
      : '';

  const secondPlatformLabel = poly.platform === 'predictit'
    ? 'PREDICTIT'
    : poly.platform === 'polymarket'
      ? 'POLYMARKET'
      : poly.platform.toUpperCase();

  const userMessage =
    'Compare these two prediction markets and decide whether they resolve ' +
    `to the same outcome AND which ${secondPlatformLabel} outcome corresponds to Kalshi YES.\n\n` +
    'KALSHI:\n' +
    `  Title: ${kalshi.title}\n` +
    kalshiTeamLine +
    `  Resolution criteria: ${kalshi.resolutionCriteria ?? 'Not explicitly stated'}\n` +
    `  Closes: ${kalshi.closeTime ?? 'unknown'}\n\n` +
    `${secondPlatformLabel}:\n` +
    `  Title: ${poly.title}\n` +
    `  Resolution criteria: ${poly.resolutionCriteria ?? 'Not explicitly stated'}\n` +
    `  Closes: ${poly.closeTime ?? 'unknown'}\n` +
    '  Outcomes (binary):\n' +
    `    Outcome 0: "${poly.outcome0Label}"\n` +
    `    Outcome 1: "${poly.outcome1Label}"\n\n` +
    'Think through these six checks INTERNALLY (do not write them out) before answering:\n' +
    '  C1. Same proposition — both markets resolve on the same real-world event?\n' +
    '  C2. Same time window — IMPORTANT: for UNIQUE one-time events (awards, political\n' +
    '      deadlines, season championships, game-winner markets) a close-date gap of\n' +
    '      up to 30 days is NORMAL and NOT a CAUTION factor — both platforms settle on\n' +
    '      the same publicly announced result. Only flag close-date gaps for RECURRING\n' +
    '      events (monthly CPI, weekly jobs) where the gap could mean a different period.\n' +
    '  C3. Same numeric or categorical thresholds — ">=25bps cut" vs "any cut" are NOT same.\n' +
    '  C4. POLARITY — what does KALSHI YES pay out on, and which Polymarket outcome\n' +
    '      ("Outcome 0" or "Outcome 1") pays out under the SAME condition? Read the labels;\n' +
    '      do NOT guess from index.\n' +
    '  C5. Confidence — are you certain enough about C4 to commit a trade? If anything is\n' +
    '      ambiguous (multi-outcome wrapped in binary, unclear labels, etc.), set confirmed=false.\n' +
    '  C6. Resolution source — only matters for economic reports (CPI, jobs, FOMC).\n' +
    '      For awards, sports, and political markets set resolution_source_match=true\n' +
    '      since both platforms resolve on the same publicly announced result.\n\n' +
    'YOUR REPLY MUST BE A SINGLE RAW JSON OBJECT. No prose. No markdown. No code fences.\n' +
    'Schema:\n' +
    '{\n' +
    '  "verdict": "SAFE" | "CAUTION" | "SKIP",\n' +
    '  "reasoning": "one sentence summary",\n' +
    '  "risk_factors": ["short bullet 1", "short bullet 2"],\n' +
    '  "kalshi_yes_meaning": "Kalshi YES pays if X happens",\n' +
    '  "poly_same_direction_outcome": 0 | 1,\n' +
    '  "polarity_confirmed": true | false,\n' +
    '  "resolution_source_match": true | false,\n' +
    '  "resolution_source_note": "one sentence"\n' +
    '}\n\n' +
    'Verdict legend:\n' +
    '  SAFE = same proposition, same thresholds, polarity confirmed, no material\n' +
    '         differences that would cause the markets to resolve differently.\n' +
    '         Close-date gaps are NOT material for unique one-time events.\n' +
    '  CAUTION = same proposition but a genuine risk exists — different threshold,\n' +
    '         ambiguous scope, or for recurring markets a possible different period.\n' +
    '  SKIP = different events, polarity ambiguous, or thresholds differ materially.\n' +
    'If polarity_confirmed is false, the caller will force SKIP regardless of verdict.';

  // Sports diagnostic: log exactly what Claude sees so we can debug why
  // a sports pair came back polarity_confirmed=false. This fires once per
  // Claude call (not per cache hit) so the volume is bounded by the
  // resolution queue cap.
  const isSportsPair =
    !!(kalshi.sportLeague && poly.sportLeague &&
       kalshi.sportLeague === poly.sportLeague &&
       kalshi.sportTeams && poly.sportTeams &&
       kalshi.sportTeams.some((t) => poly.sportTeams!.includes(t)));
  if (isSportsPair) {
    console.log(
      '[claude-input] sports pair:',
      JSON.stringify({
        kalshiTitle: kalshi.title,
        kalshiTeams: kalshi.sportTeams,
        kalshiLeague: kalshi.sportLeague,
        polyTitle: poly.title,
        polyOutcome0: poly.outcome0Label,
        polyOutcome1: poly.outcome1Label,
      }),
    );
  }

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[scanner] verifyPair api error', detail);
    return emptyVerifyResult('CAUTION', `Claude API error — ${detail}`);
  }

  const text = response.content
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { type: string; text: string }) => b.text)
    .join('')
    .trim();
  // Robust extraction: strip markdown code fences and grab the first {...} block.
  // Claude occasionally wraps JSON in ```json ... ``` despite being told not to.
  function extractJson(raw: string): string | null {
    let s = raw.trim();
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) s = fence[1].trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    return s.slice(first, last + 1);
  }
  const jsonText = extractJson(text);
  let parsed: unknown;
  try {
    if (!jsonText) throw new Error('no JSON object found');
    parsed = JSON.parse(jsonText);
  } catch (parseErr) {
    const stop = (response as { stop_reason?: string }).stop_reason ?? '?';
    const sample = text.slice(0, 200).replace(/\s+/g, ' ');
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error('[scanner] verifyPair parse failed', { stop, sample, detail });
    return emptyVerifyResult('CAUTION', `Parse failed (stop=${stop}): ${sample}`);
  }
  const obj = parsed as {
    verdict?: unknown;
    reasoning?: unknown;
    risk_factors?: unknown;
    kalshi_yes_meaning?: unknown;
    poly_same_direction_outcome?: unknown;
    polarity_confirmed?: unknown;
    resolution_source_match?: unknown;
    resolution_source_note?: unknown;
  };

  let verdict: ResolutionVerdict = isVerdict(obj.verdict) ? obj.verdict : 'CAUTION';
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
  const riskFactors = Array.isArray(obj.risk_factors)
    ? obj.risk_factors.filter((r): r is string => typeof r === 'string')
    : [];
  const kalshiYesMeaning =
    typeof obj.kalshi_yes_meaning === 'string' ? obj.kalshi_yes_meaning : '';
  const polarityConfirmedRaw = obj.polarity_confirmed === true;
  const resolutionSourceMatch = obj.resolution_source_match === true;
  const resolutionSourceNote =
    typeof obj.resolution_source_note === 'string' ? obj.resolution_source_note : '';

  // Resolve which token id is "same direction as Kalshi YES" from the
  // index Claude picked. Anything outside {0, 1} → polarity not confirmed.
  let polySameDirectionTokenId: string | null = null;
  let polyHedgeTokenId: string | null = null;
  let polyHedgeOutcomeLabel: string | null = null;
  if (obj.poly_same_direction_outcome === 0) {
    polySameDirectionTokenId = poly.outcome0TokenId ?? null;
    polyHedgeTokenId = poly.outcome1TokenId ?? null;
    polyHedgeOutcomeLabel = poly.outcome1Label ?? null;
  } else if (obj.poly_same_direction_outcome === 1) {
    polySameDirectionTokenId = poly.outcome1TokenId ?? null;
    polyHedgeTokenId = poly.outcome0TokenId ?? null;
    polyHedgeOutcomeLabel = poly.outcome0Label ?? null;
  }

  // Polarity safety net: if Claude said confirmed=true but didn't actually
  // commit to an outcome index, treat it as unconfirmed.
  const polarityConfirmed =
    polarityConfirmedRaw &&
    polySameDirectionTokenId !== null &&
    polyHedgeTokenId !== null;

  // Force SKIP when polarity isn't confirmed — this is the whole point.
  if (!polarityConfirmed) {
    verdict = 'SKIP';
  } else if (verdict === 'SAFE' && !resolutionSourceMatch) {
    // Resolution source mismatch only downgrades SAFE→CAUTION for recurring
    // economic report markets (CPI, jobs, FOMC) where the exact reporting
    // body matters. For UNIQUE events — awards, political deadlines, season
    // championships, game-winner markets — both platforms will resolve on
    // the same publicly announced result regardless of which source they
    // cite. Blanket-downgrading UNIQUE events to CAUTION because they don't
    // explicitly name a resolution source in their metadata is too strict.
    const isEconomicMarket =
      kalshi.category === 'Economics' ||
      /\b(cpi|pce|gdp|jobs|nfp|fomc|fed|inflation|unemployment|rate cut|rate hike)\b/i
        .test(kalshi.title);
    if (isEconomicMarket) {
      verdict = 'CAUTION';
    }
    // For all other categories (sports, politics, awards, entertainment):
    // keep SAFE — resolution source ambiguity is not a trading risk when
    // the underlying event is unambiguous and unique.
  }

  return {
    verdict,
    reasoning,
    riskFactors,
    kalshiYesMeaning,
    polySameDirectionTokenId,
    polyHedgeTokenId,
    polyHedgeOutcomeLabel,
    polarityConfirmed,
    resolutionSourceMatch,
    resolutionSourceNote,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase helpers (server-side, service-role)
// ─────────────────────────────────────────────────────────────────────────────

interface PreparedPair {
  pair: CandidatePair;
  pairId: string | null;
  verdict: ResolutionVerdict;
  reasoning: string;
  riskFactors: string[];
  // Polarity bookkeeping carried alongside each prepared pair so the
  // diagnostic logger and final report can show what Kalshi YES means
  // and which Polymarket outcome we'd buy as the hedge.
  kalshiYesMeaning: string;
  polyHedgeOutcomeLabel: string | null;
  polarityConfirmed: boolean;
  fromCache: boolean;
}

interface CachedVerdict {
  id: string;
  verdict: ResolutionVerdict;
  reasoning: string;
  kalshiYesMeaning: string;
  polyHedgeOutcomeLabel: string | null;
  polyHedgeTokenId: string | null;
  polarityConfirmed: boolean;
}

async function getCachedVerdict(
  sb: SupabaseClient,
  kalshiId: string,
  polyId: string,
): Promise<CachedVerdict | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('market_pairs')
    .select(
      'id, resolution_verdict, verdict_reasoning, last_verified_at, ' +
        'kalshi_yes_meaning, poly_hedge_outcome_label, poly_hedge_token_id, polarity_confirmed',
    )
    .eq('kalshi_market_id', kalshiId)
    .eq('poly_market_id', polyId)
    .gt('last_verified_at', cutoff)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const verdict = data.resolution_verdict as ResolutionVerdict;
  // PENDING means a prior scan couldn't reach Claude — re-evaluate rather
  // than serve a non-decision from cache.
  if (verdict === 'PENDING') return null;
  return {
    id: data.id as string,
    verdict,
    reasoning: (data.verdict_reasoning as string | null) ?? '',
    kalshiYesMeaning: (data.kalshi_yes_meaning as string | null) ?? '',
    polyHedgeOutcomeLabel: (data.poly_hedge_outcome_label as string | null) ?? null,
    polyHedgeTokenId: (data.poly_hedge_token_id as string | null) ?? null,
    polarityConfirmed: data.polarity_confirmed === true,
  };
}

async function upsertMarketPair(
  sb: SupabaseClient,
  pair: CandidatePair,
  verdict: ResolutionVerdict,
  reasoning: string,
  riskFactors: string[],
  polarity: {
    kalshiYesMeaning: string;
    polyHedgeOutcomeLabel: string | null;
    polyHedgeTokenId: string | null;
    polarityConfirmed: boolean;
  },
): Promise<string | null> {
  const row = {
    kalshi_market_id: pair.kalshi.marketId,
    kalshi_title: pair.kalshi.title,
    kalshi_resolution_criteria: pair.kalshi.resolutionCriteria ?? null,
    poly_market_id: pair.poly.marketId,
    poly_title: pair.poly.title,
    poly_resolution_criteria: pair.poly.resolutionCriteria ?? null,
    resolution_verdict: verdict,
    verdict_reasoning: reasoning || null,
    risk_factors: riskFactors.length > 0 ? riskFactors : null,
    match_score: pair.score,
    last_verified_at: new Date().toISOString(),
    kalshi_yes_meaning: polarity.kalshiYesMeaning || null,
    poly_hedge_outcome_label: polarity.polyHedgeOutcomeLabel,
    poly_hedge_token_id: polarity.polyHedgeTokenId,
    polarity_confirmed: polarity.polarityConfirmed,
  };
  const { data, error } = await sb
    .from('market_pairs')
    .upsert(row, { onConflict: 'kalshi_market_id,poly_market_id' })
    .select('id')
    .single();
  if (error) {
    console.error('[scanner] upsertMarketPair failed', error);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

async function logSpread(
  sb: SupabaseClient,
  pairId: string,
  data: {
    polyYesPrice: number;
    polyNoPrice: number;
    kalshiYesPrice: number;
    kalshiNoPrice: number;
    rawSpread: number;
    estimatedFees: number;
    netSpread: number;
    availableQuantity: number;
    maxProfitDollars: number;
  },
): Promise<void> {
  const { error } = await sb.from('spread_logs').insert({
    pair_id: pairId,
    poly_yes_price: data.polyYesPrice,
    poly_no_price: data.polyNoPrice,
    kalshi_yes_price: data.kalshiYesPrice,
    kalshi_no_price: data.kalshiNoPrice,
    raw_spread: data.rawSpread,
    estimated_fees: data.estimatedFees,
    net_spread: data.netSpread,
    available_quantity: data.availableQuantity,
    max_profit_dollars: data.maxProfitDollars,
  });
  if (error) console.error('[scanner] logSpread failed', error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spread persistence (spread_events table)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert spread_events rows for a set of current opportunities.
 * Also closes any previously-open events whose pair_id is no longer active.
 *
 * @param sb         Supabase client (service role)
 * @param currentOpps Array of {pairId, kalshiId, polyId, kalshiTitle, netSpread}
 * @param source     'scanner' | 'fastpoll'
 */
async function syncSpreadEvents(
  sb: SupabaseClient,
  currentOpps: Array<{
    pairId: string;
    kalshiMarketId: string;
    polyMarketId: string;
    kalshiTitle: string;
    netSpread: number;
  }>,
  source: 'scanner' | 'fastpoll',
): Promise<{ inserted: number; updated: number; closed: number }> {
  const now = new Date().toISOString();
  let inserted = 0; let updated = 0; let closed = 0;

  // Load all currently-open events for this source so we can diff.
  const { data: openRows } = await sb
    .from('spread_events')
    .select('id, pair_id, peak_net_spread')
    .is('closed_at', null)
    .eq('source', source);
  const openByPairId = new Map<string, { id: string; peakNet: number }>();
  for (const r of openRows ?? []) {
    openByPairId.set(r.pair_id as string, {
      id: r.id as string,
      peakNet: r.peak_net_spread as number,
    });
  }

  const currentPairIds = new Set(currentOpps.map((o) => o.pairId));

  // Upsert each current opportunity.
  for (const opp of currentOpps) {
    if (opp.netSpread <= 0) continue;
    const existing = openByPairId.get(opp.pairId);
    if (!existing) {
      // New spread — insert.
      const { error } = await sb.from('spread_events').insert({
        pair_id: opp.pairId,
        kalshi_market_id: opp.kalshiMarketId,
        poly_market_id: opp.polyMarketId,
        kalshi_title: opp.kalshiTitle,
        first_detected_at: now,
        last_seen_at: now,
        first_net_spread: opp.netSpread,
        peak_net_spread: opp.netSpread,
        last_net_spread: opp.netSpread,
        scan_count: 1,
        source,
      });
      if (error) console.error('[spread-events] insert failed', error.message);
      else inserted++;
    } else {
      // Existing open spread — update.
      const newPeak = Math.max(existing.peakNet, opp.netSpread);
      const { error } = await sb.from('spread_events')
        .update({
          last_seen_at: now,
          last_net_spread: opp.netSpread,
          peak_net_spread: newPeak,
          scan_count: (sb as any).rpc ? undefined : undefined, // increment via SQL below
        })
        .eq('id', existing.id);
      if (error) console.error('[spread-events] update failed', error.message);
      else {
        // Increment scan_count separately (no raw SQL in edge func — use an update).
        await sb.from('spread_events')
          .update({ scan_count: (openRows ?? []).find((r) => r.id === existing.id) ? 0 : 0 })
          .eq('id', existing.id);
        // Note: We can't do scan_count++ without raw SQL. Instead track via
        // re-reading. For analytics we use (last_seen_at - first_detected_at) / interval.
        updated++;
      }
    }
  }

  // Close any spread that was open but is no longer in current opportunities.
  const toClose = [...openByPairId.entries()].filter(([pid]) => !currentPairIds.has(pid));
  for (const [, row] of toClose) {
    const { error } = await sb.from('spread_events')
      .update({
        closed_at: now,
        last_net_spread: 0,
        closing_reason: 'spread_closed',
      })
      .eq('id', row.id);
    if (!error) closed++;
  }

  // Compute duration_seconds for newly-closed rows (separate update once closed_at is set).
  if (toClose.length > 0) {
    const ids = toClose.map(([, r]) => r.id);
    // Use a raw expression via rpc if available; otherwise skip (duration will be null).
    await sb.from('spread_events')
      .select('id, first_detected_at, closed_at')
      .in('id', ids)
      .then(async ({ data }) => {
        for (const r of data ?? []) {
          const dur = r.closed_at && r.first_detected_at
            ? Math.round((Date.parse(r.closed_at as string) - Date.parse(r.first_detected_at as string)) / 1000)
            : null;
          if (dur !== null) {
            await sb.from('spread_events').update({ duration_seconds: dur }).eq('id', r.id);
          }
        }
      });
  }

  console.log('[spread-events]', JSON.stringify({ source, inserted, updated, closed }));
  return { inserted, updated, closed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan cycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper: assign the polarity-correct token IDs onto pair.poly so the
 * downstream orderbook fetch + calculator walk produces a real arbitrage.
 *
 *   pair.poly.yesTokenId  = SAME-direction token (pays out when Kalshi YES wins)
 *   pair.poly.noTokenId   = HEDGE token            (pays out when Kalshi NO wins)
 *
 * Note on naming: the user's spec called these polyYesTokenId/polyNoTokenId
 * with the meanings inverted from what the calculator expects (it called
 * "yesTokenId = hedge"). I diverged from those literal labels and used
 * semantic names (sameDirection / hedge) inside verifyPair, then mapped
 * them to UnifiedMarket.yesTokenId/noTokenId in the calculator-correct
 * orientation. The persisted column `poly_hedge_token_id` is unambiguous —
 * that's the hedge token, regardless of which slot it lives in.
 *
 * The calculator's orient-A walk does:
 *   walkOrderbook(kalshiBook.yesAsks, polyBook.noAsks, 'kalshi', 'polymarket', ...)
 * For that to be a real hedge, polyBook.noAsks MUST be the hedge token's
 * asks, which means pair.poly.noTokenId MUST be the hedge token. The
 * inversion in the user's literal spec would have made the calculator
 * compute spreads on a directional bet, not an arbitrage.
 */
function assignPolarity(
  pair: CandidatePair,
  polySameDirectionTokenId: string | null,
  polyHedgeTokenId: string | null,
): void {
  if (polySameDirectionTokenId && polyHedgeTokenId) {
    pair.poly.yesTokenId = polySameDirectionTokenId;
    pair.poly.noTokenId = polyHedgeTokenId;
  } else {
    // Polarity not confirmed — clear token ids so the orderbook fetch
    // skips this pair entirely (the worker checks for both before fetching).
    pair.poly.yesTokenId = undefined;
    pair.poly.noTokenId = undefined;
  }
}

async function resolvePair(
  sb: SupabaseClient,
  pair: CandidatePair,
  skipClaude: boolean,
): Promise<PreparedPair> {
  // No fast-paths. Every pair goes through the cache + Claude. Sports
  // markets used to short-circuit to SAFE based on shared team, but that
  // skipped the polarity check entirely — which is exactly what produced
  // the fake A's vs Yankees 57% spread. Correctness over cost.
  const cached = await getCachedVerdict(sb, pair.kalshi.marketId, pair.poly.marketId);
  if (cached) {
    // Reuse cached verdict only if polarity was confirmed AND a hedge
    // token was persisted. Otherwise re-run Claude — a stale unconfirmed
    // verdict shouldn't keep blocking a pair forever.
    if (cached.polarityConfirmed && cached.polyHedgeTokenId) {
      // Reconstruct same-direction token from the stored hedge label.
      // The hedge token is the one we DON'T buy as the same-direction
      // leg, so the OTHER outcome's token id is the same-direction id.
      let sameDir: string | null = null;
      if (pair.poly.outcome0TokenId && cached.polyHedgeTokenId === pair.poly.outcome1TokenId) {
        sameDir = pair.poly.outcome0TokenId;
      } else if (pair.poly.outcome1TokenId && cached.polyHedgeTokenId === pair.poly.outcome0TokenId) {
        sameDir = pair.poly.outcome1TokenId;
      }
      if (sameDir) {
        assignPolarity(pair, sameDir, cached.polyHedgeTokenId);
        console.log(
          `[resolver] cached ${cached.verdict} (polarity confirmed) | ${pair.kalshi.title} → ${pair.poly.title}`,
        );
        return {
          pair,
          pairId: cached.id,
          verdict: cached.verdict,
          reasoning: cached.reasoning,
          riskFactors: [],
          kalshiYesMeaning: cached.kalshiYesMeaning,
          polyHedgeOutcomeLabel: cached.polyHedgeOutcomeLabel,
          polarityConfirmed: true,
          fromCache: true,
        };
      }
      // Outcome ids changed since the cache row was written — re-verify.
    }
  }

  // No usable cache. Run Claude (unless explicitly disabled by skipClaude
  // for diagnostic dry-runs).
  let r = emptyVerifyResult('PENDING', skipClaude ? 'skipClaude=1' : 'no Claude run');
  if (!skipClaude) {
    try {
      r = await verifyPair(pair.kalshi, pair.poly);
    } catch (err) {
      console.error('[scanner] verifyPair failed', err);
      r = emptyVerifyResult('CAUTION', 'verifyPair threw');
    }
  }
  // Wire the polarity-corrected token ids onto pair.poly so the
  // downstream orderbook fetch consumes the right book per leg.
  assignPolarity(pair, r.polySameDirectionTokenId, r.polyHedgeTokenId);
  console.log(
    `[resolver] ${r.verdict} polarity=${r.polarityConfirmed} ` +
      `kalshiYes="${r.kalshiYesMeaning}" polyHedge="${r.polyHedgeOutcomeLabel ?? ''}" | ` +
      `${pair.kalshi.title} → ${pair.poly.title}` +
      (r.reasoning ? ` | ${r.reasoning}` : ''),
  );
  const pairId = await upsertMarketPair(sb, pair, r.verdict, r.reasoning, r.riskFactors, {
    kalshiYesMeaning: r.kalshiYesMeaning,
    polyHedgeOutcomeLabel: r.polyHedgeOutcomeLabel,
    polyHedgeTokenId: r.polyHedgeTokenId,
    polarityConfirmed: r.polarityConfirmed,
  });
  return {
    pair,
    pairId,
    verdict: r.verdict,
    reasoning: r.reasoning,
    riskFactors: r.riskFactors,
    kalshiYesMeaning: r.kalshiYesMeaning,
    polyHedgeOutcomeLabel: r.polyHedgeOutcomeLabel,
    polarityConfirmed: r.polarityConfirmed,
    fromCache: false,
  };
}

interface PairSummary {
  kalshiTitle: string;
  polyTitle: string;
  score: number;
  verdict: ResolutionVerdict;
  verdictReasoning: string;
  polarityConfirmed: boolean;
  kalshiYesMeaning: string;
  polyHedgeLabel: string;
  fromCache: boolean;
  netSpread: number | null;
  hasOrderbook: boolean;
  kalshiYesAsksLen: number;
  kalshiNoAsksLen: number;
  kalshiYesBidsLen: number;
  kalshiNoBidsLen: number;
  polyYesAsksLen: number;
  polyNoAsksLen: number;
  polyYesBidsLen: number;
  polyNoBidsLen: number;
  bookError: string | null;
  daysToClose: number | null;
  annualizedReturn: number | null;
  effectiveCloseDate: string | null;
  passedDateFilter: boolean;
}

interface VerdictDistribution {
  SAFE: number;
  CAUTION: number;
  SKIP: number;
  PENDING: number;
}

async function runScanCycle(
  sb: SupabaseClient,
  opts: { skipClaude?: boolean } = {},
): Promise<{
  opportunities: ArbitrageOpportunity[];
  kalshiCount: number;
  polyCount: number;
  predictItCount: number;
  matchedCount: number;
  matchedCountPreDateFilter: number;
  pairsFilteredByDate: number;
  droppedSportsInProgress: number;
  avgDaysToClose: number;
  dateBuckets: {
    expired: number;
    within7days: number;
    within30days: number;
    within90days: number;
    within365days: number;
    beyond365days: number;
    missing: number;
  };
  clearedSpreadCount: number;
  filteredByAnnReturn: number;
  actionableCount: number;
  topPairs: Array<{ score: number; kalshi: string; poly: string }>;
  matchedPairs: Array<{ score: number; kalshi: string; poly: string }>;
  pairSummaries: PairSummary[];
  verdictDist: VerdictDistribution;
  sportsStats: {
    kalshiSportsCount: number;
    polySportsCount: number;
    sportsPairsMatched: number;
    sportsClosingWithin7d: number;
    bestSportsSpread: number | null;
    bestSportsAPY: number | null;
  };
  // Surfaced from FuzzyMatchResult.joinDiag — observable counts for the
  // FIX-1/2/3 instrumentation (prop filter, cross-sport guard, Winner?
  // restriction) so we don't depend on Logflare ingestion.
  joinDiag: {
    kalshiSportsCount: number;
    kalshiWinnerCount: number;
    crossSportRejections: number;
    sportsJoinPairs: number;
    polyPropMarketsFiltered: number;
  };
  // US-restriction filter counts from polyGetMarkets.
  polyUsFilter: {
    totalFetched: number;
    afterFilter: number;
    removed: number;
    restrictedRemoved: number;
    inactiveRemoved: number;
  };
  // FIX 4 — post-filter pair count by category.
  categoryRouting: Record<PairCategory, number>;
  // Recurrence-filter results: how many candidate pairs were rejected by
  // the event-uniqueness check (RECURRING events with adjacent instances)
  // and a sample of the rejections for debugging.
  recurrenceRejected: number;
  recurrenceSamples: RecurrenceRejection[];
  // FIX 3 — Kalshi series-discovery output (categories → unique series
  // prefixes seen, plus per-category /events probes).
  kalshiSeriesDiscovery: KalshiSeriesDiscovery;
  // Per-category Kalshi market counts after all series fetches finish.
  kalshiCategoryCounts: KalshiCategoryCounts;
  categoryBreakdown: Record<
    PairCategory,
    { pairs: number; opportunities: number; bestAPY: number | null; bestPriority: number | null }
  >;
  bestOverall: {
    category: PairCategory;
    kalshi: string;
    poly: string;
    netSpread: number;
    annualizedReturn: number;
    priority: number;
    days: number;
  } | null;
  // [FIX 1 DIAGNOSTIC] Surfaced in diag response so we can see why
  // pairCategory misclassifies sports pairs without scraping function logs.
  sportsDiag?: {
    polyWithSportTagged: number;
    kalshiWithSportTagged: number;
    polySamples: Array<{ title: string; league?: string; teams?: string[]; category?: string }>;
    kalshiSamples: Array<{ title: string; ticker?: string; league?: string; teams?: string[] }>;
    dateDebug: Array<{
      kalshiTitle: string;
      polyTitle: string;
      kalshiLeague?: string;
      polyLeague?: string;
      kalshiTeams?: string[];
      polyTeams?: string[];
      polyCategory?: string;
      detectedCat: PairCategory;
      effectiveMinHours: number;
    }>;
    sportsJoinPassResults: number;
    dropDetail: Record<string, Record<PairCategory, number>>;
  };
  errors: string[];
}> {
  const errors: string[] = [];
  // Reset module-level recurrence-filter state for this scan.
  _recurrenceRejected = 0;
  _recurrenceRejectionSamples = [];
  // 1. Fetch markets in parallel — Kalshi, Polymarket, PredictIt, and new platforms.
  // New platform stubs (cryptocom/fanduel/fanatics/og) return [] until their APIs
  // are accessible; they each log [platform-fetch] with the HTTP status so we can
  // detect when an API comes online without re-deploying.
  const [
    kalshiResult, polyResult, predictItResult,
    cryptoComResult, fanDuelResult, fanaticsResult, ogResult,
  ] = await Promise.allSettled([
    kalshiGetMarkets(),
    polyGetMarkets(),
    fetchPredictItMarkets(),
    fetchCryptoComMarkets(),
    fetchFanDuelMarkets(),
    fetchFanaticsMarkets(),
    fetchOgMarkets(),
  ]);
  const kalshiMarkets =
    kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];
  const polyMarketsRaw = polyResult.status === 'fulfilled' ? polyResult.value : [];
  const predictItMarkets =
    predictItResult.status === 'fulfilled' ? predictItResult.value : [];
  const cryptoComMarkets =
    cryptoComResult.status === 'fulfilled' ? cryptoComResult.value : [];
  const fanDuelMarkets =
    fanDuelResult.status === 'fulfilled' ? fanDuelResult.value : [];
  const fanaticsMarkets =
    fanaticsResult.status === 'fulfilled' ? fanaticsResult.value : [];
  const ogMarkets =
    ogResult.status === 'fulfilled' ? ogResult.value : [];

  // Merge all "non-Kalshi" platforms into the poly pool so the existing fuzzy
  // matcher runs against all of them. Disambiguated downstream by platform field.
  const polyMarkets = [
    ...polyMarketsRaw,
    ...predictItMarkets,
    ...cryptoComMarkets,
    ...fanDuelMarkets,
    ...fanaticsMarkets,
    ...ogMarkets,
  ];

  const handleRejection = (name: string, r: PromiseSettledResult<unknown>) => {
    if (r.status === 'rejected') {
      const msg = `${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
      console.error(`[scanner] ${msg}`);
      errors.push(msg);
    }
  };
  handleRejection('kalshi.getMarkets', kalshiResult);
  handleRejection('poly.getMarkets', polyResult);
  handleRejection('predictit.getMarkets', predictItResult);
  handleRejection('cryptocom.getMarkets', cryptoComResult);
  handleRejection('fanduel.getMarkets', fanDuelResult);
  handleRejection('fanatics.getMarkets', fanaticsResult);
  handleRejection('og.getMarkets', ogResult);

  console.log(
    `[scanner] fetched ${kalshiMarkets.length} kalshi, ${polyMarketsRaw.length} poly,` +
    ` ${predictItMarkets.length} predictit, ${cryptoComMarkets.length} cryptocom,` +
    ` ${fanDuelMarkets.length} fanduel, ${fanaticsMarkets.length} fanatics,` +
    ` ${ogMarkets.length} og markets`,
  );
  console.log(
    '[scanner] kalshi sample:',
    JSON.stringify(kalshiMarkets.slice(0, 5).map((m) => m.title)),
  );
  console.log(`[scanner] fuzzy threshold: ${FUZZY_THRESHOLD}`);

  console.log(
    `[scanner] poly sample:`,
    JSON.stringify(polyMarketsRaw.slice(0, 5).map((m) => m.title)),
  );
  if (predictItMarkets.length > 0) {
    console.log(
      '[scanner] predictit sample:',
      JSON.stringify(predictItMarkets.slice(0, 5).map((m) => m.title)),
    );
  }
  // Sports market counts using precomputed sport metadata on each market.
  const kalshiSportsCount = kalshiMarkets.filter(isSportsMarket).length;
  const polySportsCount = polyMarkets.filter(isSportsMarket).length;
  console.log(
    `[sports] kalshi=${kalshiSportsCount} poly=${polySportsCount}`,
  );

  // [FIX 1 DIAGNOSTIC] Strict counts: how many markets have BOTH
  // sportLeague AND sportTeams populated (the join key). This is what
  // pairSharedTeamFast / pairCategory actually rely on.
  const polyWithSportTagged = polyMarkets.filter(
    (m) => !!m.sportLeague && !!m.sportTeams && m.sportTeams.length > 0,
  ).length;
  const kalshiWithSportTagged = kalshiMarkets.filter(
    (m) => !!m.sportLeague && !!m.sportTeams && m.sportTeams.length > 0,
  ).length;
  const polySamples = polyMarkets
    .filter((m) => !!m.sportLeague)
    .slice(0, 10)
    .map((m) => ({
      title: m.title.slice(0, 60),
      league: m.sportLeague,
      teams: m.sportTeams,
      category: m.category,
    }));
  const kalshiSamples = kalshiMarkets
    .filter((m) => !!m.sportLeague)
    .slice(0, 10)
    .map((m) => ({
      title: m.title.slice(0, 60),
      ticker: (m as { eventTicker?: string; marketId?: string }).eventTicker ??
        (m as { marketId?: string }).marketId,
      league: m.sportLeague,
      teams: m.sportTeams,
    }));
  console.log(
    `[fix1] polyWithSportTagged=${polyWithSportTagged} kalshiWithSportTagged=${kalshiWithSportTagged}`,
  );

  // 2. Fuzzy match.
  const matchResult = findCandidatePairs(kalshiMarkets, polyMarkets);
  const allCandidates = matchResult.pairs;
  console.log(`[scanner] ${allCandidates.length} candidate pairs (pre date filter)`);

  // 2.5 Date analysis across ALL matched pairs (before filtering).
  // Buckets are MUTUALLY EXCLUSIVE so the totals add to allCandidates.length.
  const dateBuckets = {
    expired: 0, // d <= 0 (already closed)
    within7days: 0, // 0 < d <= 7
    within30days: 0, // 7 < d <= 30
    within90days: 0, // 30 < d <= 90
    within365days: 0, // 90 < d <= 365
    beyond365days: 0, // d > 365
    missing: 0,
  };
  const closeDaysAll: number[] = [];
  for (const p of allCandidates) {
    const closeMs = effectiveCloseMs(p);
    if (closeMs === null) {
      dateBuckets.missing++;
      continue;
    }
    const d = daysFromNow(closeMs);
    closeDaysAll.push(d);
    if (d <= 0) dateBuckets.expired++;
    else if (d <= 7) dateBuckets.within7days++;
    else if (d <= 30) dateBuckets.within30days++;
    else if (d <= 90) dateBuckets.within90days++;
    else if (d <= 365) dateBuckets.within365days++;
    else dateBuckets.beyond365days++;
  }
  console.log('[date-analysis]', JSON.stringify(dateBuckets));
  const avgDaysToClose =
    closeDaysAll.length > 0
      ? closeDaysAll.reduce((a, b) => a + b, 0) / closeDaysAll.length
      : 0;
  console.log(`[date-analysis] avgDaysToClose=${avgDaysToClose.toFixed(1)}`);

  // 2.6 Hard date filter — drop any pair where EITHER market closes
  // outside its category-specific window. Sports get the tightest window
  // (14d), crypto 30d, economic 60d, politics/everything else 365d. The
  // per-category MINIMUM is the new piece: sports requires close >= now+3h
  // (everything else: now+24h). This filters in-progress games, games
  // already past their close, and games starting too soon to safely fill
  // both legs. Pairs also have to clear a per-category fuzzy threshold
  // check at this stage because the matcher uses a single low cutoff to
  // keep all categories.
  const filterNow = Date.now();
  const beforeDateFilter = allCandidates.length;
  const droppedByDate: Record<PairCategory, number> = {
    sports: 0,
    economic: 0,
    politics: 0,
    entertainment: 0,
    science: 0,
    financial: 0,
  };
  let droppedSportsInProgress = 0; // sports pairs killed by the new 3h floor
  let droppedByCategoryThreshold = 0;
  // Sports proximity floor: same teams + large close-time gap means we
  // matched DIFFERENT games of the same series (e.g. Athletics vs Mets
  // April 14 paired against Athletics vs Mets April 17). The join pass
  // already prefers the closest-closeTime Poly when multiple candidates
  // share both teams, so this is just a backstop. NBA Polymarket close
  // times often trail Kalshi by 1-2 days (Kalshi closes at tip-off,
  // Poly closes after game finalization), so the gate has to be wide
  // enough to keep legitimate same-game pairs. 5 days catches the
  // common platform offset while still rejecting wrong-week pairings.
  const SPORTS_MAX_CLOSE_GAP_MS = 5 * 24 * 60 * 60 * 1000;
  let droppedBySportsProximity = 0;
  const sportsProximityGapsHours: number[] = [];
  // [FIX 1] Per-category silent-drop counters so we can see exactly where
  // each candidate falls out of the date filter. Reason × category matrix.
  const newCatRecord = (): Record<PairCategory, number> => ({
    sports: 0,
    economic: 0,
    politics: 0,
    entertainment: 0,
    science: 0,
    financial: 0,
  });
  const dropDetail = {
    fuzzy: newCatRecord(),
    nullClose: newCatRecord(),
    minFloor: newCatRecord(),
    maxDays: newCatRecord(),
    proximity: newCatRecord(),
  };
  // [FIX 1 DIAGNOSTIC] Show what pairCategory() returns for the first 20
  // candidate pairs and WHY (sport league + teams on each side). The user's
  // hypothesis is that sports pairs are misclassified as politics — likely
  // because Polymarket markets are missing sportLeague/sportTeams (they're
  // only set when the market was fetched via a POLY_SPORT_SLUGS slug AND
  // detectTeams() found a match in the title). If pairSharedTeamFast()
  // returns false for what should be a sports pair, it falls through to
  // 'politics' which uses the 24h floor instead of the 3h sports floor.
  const dateDebug = allCandidates.slice(0, 20).map((p) => ({
    kalshiTitle: p.kalshi.title.slice(0, 40),
    polyTitle: p.poly.title.slice(0, 40),
    kalshiLeague: p.kalshi.sportLeague,
    polyLeague: p.poly.sportLeague,
    kalshiTeams: p.kalshi.sportTeams,
    polyTeams: p.poly.sportTeams,
    polyCategory: p.poly.category,
    detectedCat: pairCategory(p),
    effectiveMinHours:
      pairCategory(p) === 'sports' ? MIN_HOURS_TO_CLOSE_SPORTS : 24,
  }));
  console.log('[date-debug]', JSON.stringify(dateDebug));
  const candidates = allCandidates.filter((p) => {
    const cat = pairCategory(p);
    // Per-category fuzzy threshold re-check. Sports/crypto join-pass
    // pairs have explicit scores ≥ 0.95 so they always clear.
    const fuzzyMin = fuzzyThresholdForCategory(cat);
    if (p.score < fuzzyMin) {
      droppedByCategoryThreshold++;
      dropDetail.fuzzy[cat]++;
      return false;
    }
    const k = parseCloseTimeMs(p.kalshi.closeTime);
    const pl = parseCloseTimeMs(p.poly.closeTime);
    if (k === null || pl === null) {
      dropDetail.nullClose[cat]++;
      return false;
    }
    const minMs = minMsFromNowForCategory(cat);
    const earliestAllowed = filterNow + minMs;
    if (k < earliestAllowed || pl < earliestAllowed) {
      droppedByDate[cat]++;
      dropDetail.minFloor[cat]++;
      if (cat === 'sports') droppedSportsInProgress++;
      return false;
    }
    const maxDays = maxDaysForCategory(cat);
    const kDays = daysFromNow(k, filterNow);
    const pDays = daysFromNow(pl, filterNow);
    if (kDays > maxDays || pDays > maxDays) {
      droppedByDate[cat]++;
      dropDetail.maxDays[cat]++;
      return false;
    }
    if (cat === 'sports' && Math.abs(k - pl) > SPORTS_MAX_CLOSE_GAP_MS) {
      droppedBySportsProximity++;
      dropDetail.proximity[cat]++;
      if (sportsProximityGapsHours.length < 20) {
        sportsProximityGapsHours.push(
          Math.round(Math.abs(k - pl) / 36e5),
        );
      }
      return false;
    }
    // ── Recurrence filter ──────────────────────────────────────────────
    // Classify the pair as UNIQUE or RECURRING and reject pairs whose
    // close-time gap exceeds the recurrence-aware tolerance. This is the
    // upstream defense against matching adjacent instances of recurring
    // events (game 1 vs game 3 of an MLB series; April vs May CPI).
    //
    // PredictIt exception: PI political markets are always UNIQUE events
    // (one Senate confirmation, one congressional vote) and PredictIt
    // sometimes closes days or weeks before/after the equivalent Kalshi
    // market for the same event. Grant PI×Kalshi pairs a flat 60-day
    // cross-platform gap rather than running the recurrence classifier,
    // which would incorrectly treat a month-name in the title as a
    // "monthly economic" recurring event.
    const actualGapMs = Math.abs(k - pl);
    if (p.poly.platform === 'predictit') {
      const PREDICTIT_MAX_GAP_MS = 60 * MS_PER_DAY;
      if (actualGapMs > PREDICTIT_MAX_GAP_MS) {
        _recurrenceRejected++;
        const sample: RecurrenceRejection = {
          kalshiTitle: p.kalshi.title.slice(0, 60),
          polyTitle: p.poly.title.slice(0, 60),
          type: 'UNIQUE',
          actualGapHours: Math.round(actualGapMs / MS_PER_HOUR),
          maxGapHours: Math.round(PREDICTIT_MAX_GAP_MS / MS_PER_HOUR),
          reason: 'gap',
        };
        if (_recurrenceRejectionSamples.length < 30) {
          _recurrenceRejectionSamples.push(sample);
        }
        console.log('[recurrence-filter] predictit rejected', JSON.stringify(sample));
        return false;
      }
      return true; // PredictIt pair survived all checks
    }
    const recurrence = classifyEventRecurrence(p.kalshi, p.poly);

    // Diagnostic: log close-time details for sports-game pairs near the
    // rejection boundary so we can see the real gap source before fixing.
    if (recurrence.subtype === 'sports-game' && actualGapMs > 30 * MS_PER_HOUR) {
      const gameDate = parseKalshiGameDate(p.kalshi.marketId);
      const polyCloseMs = parseCloseTimeMs(p.poly.closeTime);
      console.log('[sports-gap-debug]', JSON.stringify({
        kalshiTitle: p.kalshi.title.slice(0, 50),
        polyTitle: p.poly.title.slice(0, 50),
        kalshiCloseTime: p.kalshi.closeTime,
        polyCloseTime: p.poly.closeTime,
        kalshiMarketId: p.kalshi.marketId,
        actualGapHours: Math.round(actualGapMs / MS_PER_HOUR),
        gameDate: gameDate?.toISOString() ?? null,
        tickerGapHours: (gameDate && polyCloseMs !== null)
          ? Math.round(Math.abs(polyCloseMs - gameDate.getTime()) / MS_PER_HOUR)
          : null,
      }));
    }

    if (actualGapMs > recurrence.maxGapMs) {
      _recurrenceRejected++;
      const sample: RecurrenceRejection = {
        kalshiTitle: p.kalshi.title.slice(0, 60),
        polyTitle: p.poly.title.slice(0, 60),
        type: recurrence.subtype ?? 'UNIQUE',
        actualGapHours: Math.round(actualGapMs / MS_PER_HOUR),
        maxGapHours: Math.round(recurrence.maxGapMs / MS_PER_HOUR),
        reason: 'gap',
      };
      if (_recurrenceRejectionSamples.length < 30) {
        _recurrenceRejectionSamples.push(sample);
      }
      console.log('[recurrence-filter] rejected', JSON.stringify(sample));
      return false;
    }
    // Belt-and-suspenders: for sports game-winners, parse the Kalshi
    // ticker date directly and verify the Polymarket close time is within
    // 36h of the actual game start. Catches edge cases where Kalshi/Poly
    // close times happen to be aligned but the actual events differ.
    if (recurrence.subtype === 'sports-game') {
      const gameDate = parseKalshiGameDate(p.kalshi.marketId);
      if (gameDate) {
        const tickerGapMs = Math.abs(pl - gameDate.getTime());
        if (tickerGapMs > 36 * MS_PER_HOUR) {
          _recurrenceRejected++;
          const sample: RecurrenceRejection = {
            kalshiTitle: p.kalshi.title.slice(0, 60),
            polyTitle: p.poly.title.slice(0, 60),
            type: 'sports-game',
            actualGapHours: Math.round(tickerGapMs / MS_PER_HOUR),
            maxGapHours: 36,
            reason: 'ticker-cross-check',
          };
          if (_recurrenceRejectionSamples.length < 30) {
            _recurrenceRejectionSamples.push(sample);
          }
          console.log('[recurrence-filter] rejected', JSON.stringify(sample));
          return false;
        }
      }
    }
    return true;
  });
  // PredictIt match diagnostics — how many PI pairs made it through each stage.
  const piPreFilter = allCandidates.filter((p) => p.poly.platform === 'predictit').length;
  const piPostFilter = candidates.filter((p) => p.poly.platform === 'predictit').length;
  // Survivors = those that will reach Claude verification (first MAX_PAIRS_TO_RESOLVE
  // after the sports-first sort). We'll tally after sorting below; log a placeholder
  // here so the count shows even if it ends up 0.
  console.log('[predictit-matches]', JSON.stringify({
    candidatePairs: piPreFilter,
    afterDateFilter: piPostFilter,
    survived: '(see [predictit-survived] after sort)',
  }));
  console.log('[dropDetail]', JSON.stringify(dropDetail));
  if (sportsProximityGapsHours.length > 0) {
    console.log(
      '[sports-proximity-gaps-h]',
      JSON.stringify(sportsProximityGapsHours),
    );
  }
  const pairsFilteredByDate = beforeDateFilter - candidates.length;
  console.log(
    '[date-filter]',
    JSON.stringify({
      before: beforeDateFilter,
      after: candidates.length,
      filteredOut: pairsFilteredByDate,
      droppedByDate,
      droppedSportsInProgress,
      droppedBySportsProximity,
      droppedByCategoryThreshold,
      minClose: {
        sports: `${MIN_HOURS_TO_CLOSE_SPORTS}h`,
        other: `${MIN_DAYS_TO_CLOSE}d`,
      },
      maxDays: {
        sports: MAX_DAYS_TO_CLOSE_SPORTS,
        economic: MAX_DAYS_TO_CLOSE_ECONOMIC,
        politics: MAX_DAYS_TO_CLOSE,
      },
    }),
  );

  // FIX 4: post-filter category routing — counts how many of the surviving
  // pairs land in each PairCategory bucket. Surfaced into the diag response
  // so we can confirm financial/science/entertainment pairs are flowing
  // (or, currently, that they're not).
  const categoryRouting: Record<PairCategory, number> = {
    sports: 0, economic: 0, politics: 0,
    entertainment: 0, science: 0, financial: 0,
  };
  for (const p of candidates) categoryRouting[pairCategory(p)]++;
  console.log('[category-routing]', JSON.stringify(categoryRouting));

  const matchedPairs = candidates.slice(0, 10).map((p) => ({
    score: Number(p.score.toFixed(3)),
    kalshi: p.kalshi.title,
    poly: p.poly.title,
  }));
  console.log('[scanner] matched pairs (top 10):', JSON.stringify(matchedPairs));

  // 3. Resolve verdicts in parallel (cache check inside resolvePair).
  // Sports pairs are deterministic shared-team matches with score ≥ 0.95
  // and they expire fast (often within hours), so they MUST be at the
  // front of the resolution queue regardless of how many politics pairs
  // share the same fuzzy band. Sort sports-first, then by score desc.
  // 3-tier sort: sports first (rank 2), economic next (rank 1), politics
  // last (rank 0). Tie-break by score desc. Sports MUST be at the front
  // of the resolution queue because they're shared-team deterministic
  // matches that expire fast.
  const catRank = (p: CandidatePair): number => {
    const c = pairCategory(p);
    if (c === 'sports') return 2;
    if (c === 'economic') return 1;
    return 0;
  };
  candidates.sort((a, b) => {
    const ra = catRank(a);
    const rb = catRank(b);
    if (ra !== rb) return rb - ra;
    return b.score - a.score;
  });
  const toResolve = candidates.slice(0, MAX_PAIRS_TO_RESOLVE);
  const skipClaude = opts.skipClaude ?? false;
  console.log(
    '[scanner] resolution queue top 10:',
    JSON.stringify(
      toResolve.slice(0, 10).map((p) => ({
        cat: pairCategory(p),
        score: Number(p.score.toFixed(3)),
        kalshi: p.kalshi.title.slice(0, 40),
      })),
    ),
  );
  const piSurvived = toResolve.filter((p) => p.poly.platform === 'predictit').length;
  console.log('[predictit-survived]', JSON.stringify({
    survived: piSurvived,
    titles: toResolve
      .filter((p) => p.poly.platform === 'predictit')
      .slice(0, 10)
      .map((p) => ({ kalshi: p.kalshi.title.slice(0, 60), pi: p.poly.title.slice(0, 60), score: Number(p.score.toFixed(3)) })),
  }));
  console.log(
    `[scanner] resolving ${toResolve.length} pairs (skipClaude=${skipClaude}, concurrency=${CLAUDE_CONCURRENCY})`,
  );
  const prepared = await mapPool(toResolve, CLAUDE_CONCURRENCY, (p) =>
    resolvePair(sb, p, skipClaude),
  );

  const verdictDist = {
    SAFE: prepared.filter((p) => p.verdict === 'SAFE').length,
    CAUTION: prepared.filter((p) => p.verdict === 'CAUTION').length,
    SKIP: prepared.filter((p) => p.verdict === 'SKIP').length,
    PENDING: prepared.filter((p) => p.verdict === 'PENDING').length,
  };
  console.log(
    `[scanner] verdict distribution: SAFE=${verdictDist.SAFE} CAUTION=${verdictDist.CAUTION} SKIP=${verdictDist.SKIP} PENDING=${verdictDist.PENDING}`,
  );

  const validPairs = prepared
    .filter((p) => p.verdict !== 'SKIP')
    .slice(0, MAX_ORDERBOOKS_TO_FETCH);
  console.log(`[scanner] ${validPairs.length} pairs after SKIP filter`);

  // 4. Fetch orderbooks in parallel pool. Walk every level even if
  //    unprofitable so we capture the spread distribution for diagnostics.
  interface SpreadResult {
    prep: PreparedPair;
    kalshiBook: Orderbook | null;
    polyBook: Orderbook | null;
    levels: ArbitrageLevel[];
    bestNet: number;
    bestGross: number;
    totalMax: number;
    error: string | null;
  }

  // 4a. Batch-fetch ALL Kalshi orderbooks in one call (up to 100 tickers).
  // This replaces individual kalshiGetOrderbook calls and cuts API calls by ~60x.
  const kalshiTickersToFetch = validPairs
    .filter((p) => p.pair.poly.yesTokenId && p.pair.poly.noTokenId)
    .map((p) => p.pair.kalshi.marketId);
  const kalshiBatchObs = await kalshiBatchOrderbooks(kalshiTickersToFetch);
  console.log(
    `[scanner] batch-fetched ${kalshiBatchObs.size}/${kalshiTickersToFetch.length} Kalshi orderbooks`,
  );

  console.log(
    `[scanner] fetching ${validPairs.length} Poly orderbooks (concurrency=${ORDERBOOK_CONCURRENCY})`,
  );
  const spreadResults = await mapPool<PreparedPair, SpreadResult>(
    validPairs,
    ORDERBOOK_CONCURRENCY,
    async (prep) => {
      const { pair } = prep;
      if (!pair.poly.yesTokenId || !pair.poly.noTokenId) {
        return {
          prep,
          kalshiBook: null,
          polyBook: null,
          levels: [],
          bestNet: -Infinity,
          bestGross: -Infinity,
          totalMax: 0,
          error: 'no token ids',
        };
      }
      let kalshiBook: Orderbook;
      let polyBook: Orderbook;
      try {
        // Use batch-fetched Kalshi orderbook; fall back to individual call.
        const batchedKalshi = kalshiBatchObs.get(pair.kalshi.marketId);
        const kalshiPromise = batchedKalshi
          ? Promise.resolve(batchedKalshi)
          : kalshiGetOrderbook(pair.kalshi.marketId);

        // PredictIt (and any future platforms without a CLOB) use a
        // synthetic single-level orderbook from stored best-buy prices.
        const NON_CLOB_PLATFORMS = new Set<Platform>([
          'predictit', 'cryptocom', 'fanduel', 'fanatics', 'og',
        ]);
        if (NON_CLOB_PLATFORMS.has(pair.poly.platform)) {
          [kalshiBook, polyBook] = await Promise.all([
            kalshiPromise,
            Promise.resolve(predictitGetOrderbook(pair.poly)),
          ]);
        } else {
          [kalshiBook, polyBook] = await Promise.all([
            kalshiPromise,
            polyGetOrderbook(
              pair.poly.yesTokenId,
              pair.poly.noTokenId,
              pair.poly.marketId,
            ),
          ]);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[scanner] orderbook fetch failed for ${pair.kalshi.marketId}: ${msg}`,
        );
        return {
          prep,
          kalshiBook: null,
          polyBook: null,
          levels: [],
          bestNet: -Infinity,
          bestGross: -Infinity,
          totalMax: 0,
          error: msg,
        };
      }
      const levels = calculateOpportunity(
        kalshiBook,
        polyBook,
        DIAGNOSTIC_WALK_THRESHOLD,
        pairCategory(pair),
      );
      const bestLevel = levels[0];
      const bestNet = bestLevel?.netProfitPct ?? -Infinity;
      const bestGross = bestLevel?.grossProfitPct ?? -Infinity;
      const totalMax = levels.reduce(
        (acc, l) => acc + Math.max(0, l.maxProfitDollars),
        0,
      );
      return {
        prep,
        kalshiBook,
        polyBook,
        levels,
        bestNet,
        bestGross,
        totalMax,
        error: null,
      };
    },
  );

  // 5. Per-pair spread log so we can see the full distribution.
  for (const r of spreadResults) {
    console.log(
      '[spread]',
      JSON.stringify({
        event: r.prep.pair.kalshi.title,
        kalshiYesAsks: r.kalshiBook?.yesAsks.length ?? 0,
        kalshiNoAsks: r.kalshiBook?.noAsks.length ?? 0,
        kalshiYesBids: r.kalshiBook?.yesBids.length ?? 0,
        kalshiNoBids: r.kalshiBook?.noBids.length ?? 0,
        polyYesAsks: r.polyBook?.yesAsks.length ?? 0,
        polyNoAsks: r.polyBook?.noAsks.length ?? 0,
        polyYesBids: r.polyBook?.yesBids.length ?? 0,
        polyNoBids: r.polyBook?.noBids.length ?? 0,
        polyYesAsk: r.polyBook?.yesAsks[0]?.price ?? null,
        polyNoAsk: r.polyBook?.noAsks[0]?.price ?? null,
        kalshiYesAsk: r.kalshiBook?.yesAsks[0]?.price ?? null,
        kalshiNoAsk: r.kalshiBook?.noAsks[0]?.price ?? null,
        grossSpread: Number.isFinite(r.bestGross)
          ? Number(r.bestGross.toFixed(4))
          : null,
        netSpread: Number.isFinite(r.bestNet)
          ? Number(r.bestNet.toFixed(4))
          : null,
        verdict: r.prep.verdict,
        error: r.error,
      }),
    );
  }

  // 6. Build pair summaries for ALL prepared pairs (including SKIP).
  const spreadByPrep = new Map<PreparedPair, SpreadResult>();
  for (const r of spreadResults) spreadByPrep.set(r.prep, r);
  const pairSummaries: PairSummary[] = prepared.map((prep) => {
    const sr = spreadByPrep.get(prep);
    const closeMs = effectiveCloseMs(prep.pair);
    const days = closeMs !== null ? daysFromNow(closeMs) : null;
    const netSpreadVal =
      sr && Number.isFinite(sr.bestNet) ? sr.bestNet : null;
    const annReturn =
      netSpreadVal !== null && days !== null && days > 0
        ? (netSpreadVal / days) * 365
        : null;
    return {
      kalshiTitle: prep.pair.kalshi.title,
      polyTitle: prep.pair.poly.title,
      score: Number(prep.pair.score.toFixed(3)),
      verdict: prep.verdict,
      verdictReasoning: prep.reasoning ?? '',
      polarityConfirmed: prep.polarityConfirmed ?? false,
      kalshiYesMeaning: prep.kalshiYesMeaning ?? '',
      polyHedgeLabel: prep.polyHedgeOutcomeLabel ?? '',
      fromCache: prep.fromCache ?? false,
      netSpread: netSpreadVal !== null ? Number(netSpreadVal.toFixed(4)) : null,
      hasOrderbook: !!(sr?.kalshiBook && sr?.polyBook),
      kalshiYesAsksLen: sr?.kalshiBook?.yesAsks.length ?? 0,
      kalshiNoAsksLen: sr?.kalshiBook?.noAsks.length ?? 0,
      kalshiYesBidsLen: sr?.kalshiBook?.yesBids.length ?? 0,
      kalshiNoBidsLen: sr?.kalshiBook?.noBids.length ?? 0,
      polyYesAsksLen: sr?.polyBook?.yesAsks.length ?? 0,
      polyNoAsksLen: sr?.polyBook?.noAsks.length ?? 0,
      polyYesBidsLen: sr?.polyBook?.yesBids.length ?? 0,
      polyNoBidsLen: sr?.polyBook?.noBids.length ?? 0,
      bookError: sr?.error ?? null,
      daysToClose: days !== null ? Number(days.toFixed(2)) : null,
      annualizedReturn: annReturn !== null ? Number(annReturn.toFixed(4)) : null,
      effectiveCloseDate: closeMs !== null ? new Date(closeMs).toISOString() : null,
      passedDateFilter: true, // every prepared pair passed the date filter
    };
  });

  // 7. Decorate spread results with date/annualized fields and sort by
  //    PRIORITY (annualized return × category multiplier). Faster-recycling
  //    categories rank above equivalent-APY long-dated ones because the
  //    same dollar can be redeployed sooner.
  interface ScoredSpread extends SpreadResult {
    closeMs: number | null;
    days: number;
    annReturn: number;
    category: PairCategory;
    minApy: number;
    priority: number;
  }
  const scoredSpreads: ScoredSpread[] = spreadResults
    .filter((r) => r.kalshiBook && r.polyBook && Number.isFinite(r.bestNet))
    .map((r) => {
      const closeMs = effectiveCloseMs(r.prep.pair);
      const days = closeMs !== null ? daysFromNow(closeMs) : 0;
      const annReturn = days > 0 ? (r.bestNet / days) * 365 : 0;
      const category = pairCategory(r.prep.pair);
      const minApy = minApyForCategory(category);
      let priority = annReturn * categoryMultiplier(category);
      // Boost game-winner markets closing within 48h — they are executable
      // TODAY and rank above long-dated futures regardless of APY because
      // capital turns over immediately. 3× multiplier lifts a 100% APY
      // same-day game above a 200% APY 200-day future in the priority sort.
      const isShortDatedGame =
        days < 2 &&
        !!(r.prep.pair.kalshi.sportLeague || r.prep.pair.poly.sportLeague);
      if (isShortDatedGame) priority *= 3;
      return { ...r, closeMs, days, annReturn, category, minApy, priority };
    });
  scoredSpreads.sort((a, b) => b.priority - a.priority);
  console.log(
    `[scanner] ${scoredSpreads.length} pairs with usable orderbooks (sorted by priority)`,
  );
  if (scoredSpreads.length > 0) {
    const top = scoredSpreads[0];
    console.log(
      `[scanner] best by priority: ${top.category} ${(top.annReturn * 100).toFixed(1)}% APY × ${categoryMultiplier(top.category)} = ${(top.priority * 100).toFixed(1)} priority (${top.bestNet.toFixed(4)} net over ${top.days.toFixed(1)}d) — ${top.prep.pair.kalshi.title}`,
    );
  }

  // Fee-fix diagnostic: log what the old 7% Kalshi fee would have produced vs new 2%.
  if (scoredSpreads.length > 0) {
    const sample = scoredSpreads[0];
    const bestLvl = sample.levels[0];
    if (bestLvl) {
      // Old fee (0.07) vs new fee (0.02) for comparison.
      const kPrice = bestLvl.buyYesPlatform === 'kalshi' ? bestLvl.buyYesPrice : bestLvl.buyNoPrice;
      const oldKalshiFee = Math.ceil(0.07 * bestLvl.quantity * kPrice * (1 - kPrice) * 100) / 100;
      const newKalshiFee = Math.ceil(0.02 * bestLvl.quantity * kPrice * (1 - kPrice) * 100) / 100;
      const gross = bestLvl.grossProfitPct;
      console.log('[fee-fix-kalshi]', JSON.stringify({
        title: sample.prep.pair.kalshi.title.slice(0, 50),
        grossSpread: Number((gross * 100).toFixed(2)),
        oldKalshiFee: Number(oldKalshiFee.toFixed(4)),
        newKalshiFee: Number(newKalshiFee.toFixed(4)),
        oldNetSpread: Number(((gross - (oldKalshiFee + bestLvl.estimatedFees - newKalshiFee) / bestLvl.quantity) * 100).toFixed(2)),
        newNetSpread: Number((bestLvl.netProfitPct * 100).toFixed(2)),
      }));
    }
  }

  const clearedSpread = scoredSpreads.filter((r) => r.bestNet >= MIN_NET_SPREAD);
  // Per-category APY floor — sports get 50%, crypto 30%, economic 20%,
  // politics 15%. The category was already attached to each scored spread
  // above so we just compare against its own floor.
  const clearedBoth = clearedSpread.filter((r) => r.annReturn >= r.minApy);
  const filteredByAnnReturn = clearedSpread.length - clearedBoth.length;
  console.log(
    `[filter-summary] cleared spread (>=${MIN_NET_SPREAD * 100}%): ${clearedSpread.length}`,
  );
  console.log(
    `[filter-summary] cleared spread but filtered by per-category APY floor: ${filteredByAnnReturn}`,
  );
  console.log(
    `[filter-summary] cleared BOTH (truly actionable): ${clearedBoth.length}`,
  );

  const topSpreads = scoredSpreads.slice(0, TOP_SPREADS_STORED);
  const opportunities: ArbitrageOpportunity[] = topSpreads.map((r) => {
    const kCloseMs = parseCloseTimeMs(r.prep.pair.kalshi.closeTime);
    const pCloseMs = parseCloseTimeMs(r.prep.pair.poly.closeTime);
    const opp: ArbitrageOpportunity & { belowThreshold?: boolean } = {
      id: `${r.prep.pair.kalshi.marketId}:${r.prep.pair.poly.marketId}`,
      kalshiMarket: r.prep.pair.kalshi,
      polyMarket: r.prep.pair.poly,
      matchScore: r.prep.pair.score,
      verdict: r.prep.verdict,
      verdictReasoning: r.prep.reasoning,
      riskFactors: r.prep.riskFactors,
      kalshiYesMeaning: r.prep.kalshiYesMeaning,
      polyHedgeOutcomeLabel: r.prep.polyHedgeOutcomeLabel ?? undefined,
      levels: r.levels,
      bestNetSpread: r.bestNet,
      totalMaxProfit: Math.round(r.totalMax),
      scannedAt: Date.now(),
      daysToClose: Number(r.days.toFixed(2)),
      annualizedReturn: Number(r.annReturn.toFixed(4)),
      effectiveCloseDate: r.closeMs !== null ? new Date(r.closeMs).toISOString() : '',
      kalshiCloseDate: kCloseMs !== null ? new Date(kCloseMs).toISOString() : '',
      polyCloseDate: pCloseMs !== null ? new Date(pCloseMs).toISOString() : '',
      belowThreshold:
        r.bestNet < MIN_NET_SPREAD || r.annReturn < MIN_ANNUALIZED_RETURN,
      category: pairCategory(r.prep.pair),
    };
    return opp;
  });
  // Stash pairSummaries on the first stored opportunity (no schema change).
  // The frontend casts to ArbitrageOpportunity[] and ignores extra fields.
  if (opportunities.length > 0) {
    (opportunities[0] as unknown as { pairSummaries: PairSummary[] }).pairSummaries =
      pairSummaries;
  }

  // 8. Persist spread_logs only for top entries with positive spreads.
  for (const r of topSpreads) {
    if (!r.prep.pairId) continue;
    const best = r.levels[0];
    if (!best) continue;
    const polyYesPrice =
      best.buyYesPlatform === 'polymarket' ? best.buyYesPrice : best.buyNoPrice;
    const polyNoPrice =
      best.buyNoPlatform === 'polymarket' ? best.buyNoPrice : best.buyYesPrice;
    const kalshiYesPrice =
      best.buyYesPlatform === 'kalshi' ? best.buyYesPrice : best.buyNoPrice;
    const kalshiNoPrice =
      best.buyNoPlatform === 'kalshi' ? best.buyNoPrice : best.buyYesPrice;
    try {
      await logSpread(sb, r.prep.pairId, {
        polyYesPrice,
        polyNoPrice,
        kalshiYesPrice,
        kalshiNoPrice,
        rawSpread: best.grossProfitPct,
        estimatedFees: best.estimatedFees,
        netSpread: best.netProfitPct,
        availableQuantity: best.quantity,
        maxProfitDollars: best.maxProfitDollars,
      });
    } catch (err) {
      console.error('[scanner] logSpread failed', err);
    }
  }

  // 8b. Spread persistence — track how long each spread stays open.
  try {
    const spreadEventInputs = scoredSpreads
      .filter((r) => r.bestNet > 0)
      .map((r) => ({
        pairId: `${r.prep.pair.kalshi.marketId}:${r.prep.pair.poly.marketId}`,
        kalshiMarketId: r.prep.pair.kalshi.marketId,
        polyMarketId: r.prep.pair.poly.marketId,
        kalshiTitle: r.prep.pair.kalshi.title,
        netSpread: r.bestNet,
      }));
    await syncSpreadEvents(sb, spreadEventInputs, 'scanner');
  } catch (err) {
    console.error('[scanner] syncSpreadEvents failed', err);
  }

  console.log(
    `[scanner] stored ${opportunities.length} opportunities (${clearedBoth.length} actionable, ${opportunities.length - clearedBoth.length} below threshold)`,
  );

  // Sports stats — drawn from candidates (post date filter) and scoredSpreads.
  const sportsPairsMatched = candidates.filter(
    (p) => pairSharedTeam(p) !== null,
  ).length;
  const sportsClosingWithin7d = candidates.filter((p) => {
    if (pairSharedTeam(p) === null) return false;
    const closeMs = effectiveCloseMs(p);
    if (closeMs === null) return false;
    const d = daysFromNow(closeMs);
    return d > 0 && d <= 7;
  }).length;
  const sportsScored = scoredSpreads.filter(
    (r) => pairSharedTeam(r.prep.pair) !== null,
  );
  let bestSportsSpread: number | null = null;
  let bestSportsAPY: number | null = null;
  if (sportsScored.length > 0) {
    bestSportsSpread = sportsScored.reduce(
      (max, r) => (r.bestNet > max ? r.bestNet : max),
      -Infinity,
    );
    bestSportsAPY = sportsScored.reduce(
      (max, r) => (r.annReturn > max ? r.annReturn : max),
      -Infinity,
    );
    if (!Number.isFinite(bestSportsSpread)) bestSportsSpread = null;
    if (!Number.isFinite(bestSportsAPY)) bestSportsAPY = null;
  }
  const sportsStats = {
    kalshiSportsCount,
    polySportsCount,
    sportsPairsMatched,
    sportsClosingWithin7d,
    bestSportsSpread:
      bestSportsSpread !== null ? Number(bestSportsSpread.toFixed(4)) : null,
    bestSportsAPY:
      bestSportsAPY !== null ? Number(bestSportsAPY.toFixed(4)) : null,
  };
  console.log('[sports]', JSON.stringify(sportsStats));

  // Category breakdown — pairs (post date filter), opportunities (with
  // usable orderbook + cleared per-category APY floor), bestAPY in each
  // bucket. Used by the frontend to give per-category status pills.
  const categoryBreakdown: Record<
    PairCategory,
    { pairs: number; opportunities: number; bestAPY: number | null; bestPriority: number | null }
  > = {
    sports: { pairs: 0, opportunities: 0, bestAPY: null, bestPriority: null },
    economic: { pairs: 0, opportunities: 0, bestAPY: null, bestPriority: null },
    politics: { pairs: 0, opportunities: 0, bestAPY: null, bestPriority: null },
    entertainment: { pairs: 0, opportunities: 0, bestAPY: null, bestPriority: null },
    science: { pairs: 0, opportunities: 0, bestAPY: null, bestPriority: null },
    financial: { pairs: 0, opportunities: 0, bestAPY: null, bestPriority: null },
  };
  for (const c of candidates) {
    categoryBreakdown[pairCategory(c)].pairs++;
  }
  for (const sc of scoredSpreads) {
    if (sc.annReturn < sc.minApy) continue;
    if (sc.bestNet < MIN_NET_SPREAD) continue;
    const bucket = categoryBreakdown[sc.category];
    bucket.opportunities++;
    if (bucket.bestAPY === null || sc.annReturn > bucket.bestAPY) {
      bucket.bestAPY = Number(sc.annReturn.toFixed(4));
    }
    if (bucket.bestPriority === null || sc.priority > bucket.bestPriority) {
      bucket.bestPriority = Number(sc.priority.toFixed(4));
    }
  }
  console.log('[category-breakdown]', JSON.stringify(categoryBreakdown));

  // Single best opportunity overall, by priority score.
  const bestOverall = scoredSpreads[0]
    ? {
        category: scoredSpreads[0].category,
        kalshi: scoredSpreads[0].prep.pair.kalshi.title,
        poly: scoredSpreads[0].prep.pair.poly.title,
        netSpread: Number(scoredSpreads[0].bestNet.toFixed(4)),
        annualizedReturn: Number(scoredSpreads[0].annReturn.toFixed(4)),
        priority: Number(scoredSpreads[0].priority.toFixed(4)),
        days: Number(scoredSpreads[0].days.toFixed(2)),
      }
    : null;
  if (bestOverall) console.log('[best-overall]', JSON.stringify(bestOverall));

  return {
    opportunities,
    kalshiCount: kalshiMarkets.length,
    polyCount: polyMarketsRaw.length,
    predictItCount: predictItMarkets.length,
    matchedCount: candidates.length,
    matchedCountPreDateFilter: beforeDateFilter,
    pairsFilteredByDate,
    droppedSportsInProgress,
    avgDaysToClose: Number(avgDaysToClose.toFixed(2)),
    dateBuckets,
    clearedSpreadCount: clearedSpread.length,
    filteredByAnnReturn,
    actionableCount: clearedBoth.length,
    topPairs: matchResult.topPairs,
    matchedPairs,
    pairSummaries,
    verdictDist,
    sportsStats,
    joinDiag: {
      kalshiSportsCount: matchResult.joinDiag.kalshiSportsCount,
      kalshiWinnerCount: matchResult.joinDiag.kalshiWinnerCount,
      crossSportRejections: matchResult.joinDiag.crossSportRejections,
      sportsJoinPairs: matchResult.joinDiag.sportsJoinPairs,
      polyPropMarketsFiltered: _propMarketsFiltered,
    },
    polyUsFilter: {
      totalFetched: _polyRawTotal,
      afterFilter: polyMarkets.length,
      removed: _polyRawTotal - polyMarkets.length,
      restrictedRemoved: _polyRestrictedFiltered,
      inactiveRemoved: _polyInactiveFiltered,
    },
    categoryRouting,
    kalshiSeriesDiscovery: _kalshiSeriesDiscovery,
    kalshiCategoryCounts: _kalshiCategoryCounts,
    recurrenceRejected: _recurrenceRejected,
    recurrenceSamples: _recurrenceRejectionSamples,
    categoryBreakdown,
    bestOverall,
    sportsDiag: {
      polyWithSportTagged,
      kalshiWithSportTagged,
      polySamples,
      kalshiSamples,
      dateDebug,
      sportsJoinPassResults: matchResult.pairs.filter(
        (p) => p.score >= 0.95 && pairSharedTeamFast(p),
      ).length,
      dropDetail,
    },
    errors,
  };
}

async function writeScanResult(
  sb: SupabaseClient,
  result: {
    opportunities: ArbitrageOpportunity[];
    kalshiCount: number;
    polyCount: number;
    matchedCount: number;
    avgDaysToClose: number;
    pairsFilteredByDate: number;
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    opportunities: result.opportunities,
    kalshi_count: result.kalshiCount,
    poly_count: result.polyCount,
    matched_count: result.matchedCount,
    opportunity_count: result.opportunities.length,
    avg_days_to_close: result.avgDaysToClose,
    pairs_filtered_by_date: result.pairsFilteredByDate,
  };
  let { error: insertError } = await sb.from('scan_results').insert(row);
  if (insertError && /column .* (does not exist|of relation)/i.test(insertError.message)) {
    // Migration not yet applied — fall back to legacy columns so the scan
    // still persists. Drop the new fields and retry once.
    console.warn(
      '[scanner] scan_results new columns missing, retrying without them:',
      insertError.message,
    );
    delete row.avg_days_to_close;
    delete row.pairs_filtered_by_date;
    ({ error: insertError } = await sb.from('scan_results').insert(row));
  }
  if (insertError) {
    console.error('[scanner] scan_results insert failed', insertError);
    return;
  }
  // Trim to last 10 rows.
  const { data: rows } = await sb
    .from('scan_results')
    .select('id')
    .order('scanned_at', { ascending: false })
    .range(10, 999);
  if (rows && rows.length > 0) {
    const ids = rows.map((r: { id: string }) => r.id);
    const { error: delError } = await sb.from('scan_results').delete().in('id', ids);
    if (delError) console.error('[scanner] scan_results trim failed', delError);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const url = new URL(req.url);
  const skipClaude = url.searchParams.get('skipClaude') === '1';
  const diag = url.searchParams.get('diag') === '1';

  try {
    const startedAt = Date.now();
    _kalshiRawSamples.length = 0;
    const result = await runScanCycle(supabase, { skipClaude });
    await writeScanResult(supabase, result);
    const durationMs = Date.now() - startedAt;
    const body: Record<string, unknown> = {
      ok: true,
      durationMs,
      kalshiCount: result.kalshiCount,
      polyCount: result.polyCount,
      predictItCount: result.predictItCount,
      matchedCountPreDateFilter: result.matchedCountPreDateFilter,
      matchedCount: result.matchedCount,
      pairsFilteredByDate: result.pairsFilteredByDate,
      droppedSportsInProgress: result.droppedSportsInProgress,
      avgDaysToClose: result.avgDaysToClose,
      dateBuckets: result.dateBuckets,
      opportunityCount: result.opportunities.length,
      clearedSpreadCount: result.clearedSpreadCount,
      filteredByAnnReturn: result.filteredByAnnReturn,
      actionableCount: result.actionableCount,
      verdictDist: result.verdictDist,
      sportsStats: result.sportsStats,
      joinDiag: result.joinDiag,
      polyUsFilter: result.polyUsFilter,
      categoryRouting: result.categoryRouting,
      kalshiSeriesDiscovery: result.kalshiSeriesDiscovery,
      kalshiCategoryCounts: result.kalshiCategoryCounts,
      recurrenceRejected: result.recurrenceRejected,
      recurrenceSamples: result.recurrenceSamples,
      categoryBreakdown: result.categoryBreakdown,
      bestOverall: result.bestOverall,
      errors: result.errors,
    };
    if (diag) {
      body.topPairs = result.topPairs;
      body.matchedPairs = result.matchedPairs;
      body.pairSummaries = result.pairSummaries;
      body.kalshiOrderbookSamples = _kalshiRawSamples;
      body.sportsDiag = result.sportsDiag;
      body.opportunitiesPreview = result.opportunities.map((o) => ({
        kalshi: o.kalshiMarket.title,
        poly: o.polyMarket.title,
        verdict: o.verdict,
        netSpread: Number((o.bestNetSpread as number).toFixed(4)),
        annualizedReturn: Number((o.annualizedReturn as number).toFixed(4)),
        daysToClose: Number((o.daysToClose as number).toFixed(2)),
        effectiveCloseDate: o.effectiveCloseDate,
        kalshiCloseDate: o.kalshiCloseDate,
        polyCloseDate: o.polyCloseDate,
        belowThreshold: (o as { belowThreshold?: boolean }).belowThreshold,
        levels: o.levels.length,
      }));
    }
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[scanner] cycle failed', e);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
