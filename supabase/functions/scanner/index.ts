// Arbor scanner — Supabase Edge Function (Deno).
// Runs the full scan cycle server-side and writes results to scan_results.
// All API calls (Kalshi, Polymarket, Anthropic) happen here, never in browser.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.102.1';
import Anthropic from 'npm:@anthropic-ai/sdk@0.85.0';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Platform = 'kalshi' | 'polymarket';
type ResolutionVerdict = 'SAFE' | 'CAUTION' | 'SKIP' | 'PENDING';

interface UnifiedMarket {
  platform: Platform;
  marketId: string;
  title: string;
  yesTokenId?: string;
  noTokenId?: string;
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
  // Pre-detected crypto info, populated at fetch time. Crypto fast-path
  // requires both sides to have asset, price, and dateRef populated AND to
  // match exactly. Otherwise the pair falls through to Claude as normal.
  cryptoAsset?: 'btc' | 'eth';
  cryptoPrice?: number;
  cryptoDateRef?: string;
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

// Default fuzzy threshold for politics/macro pairs. Sports/crypto/economic
// use the per-category override below since their titles overlap less
// cleanly across platforms.
const FUZZY_THRESHOLD = 0.40;
// Sports titles format very differently across platforms (Kalshi:
// "Chiefs ML vs Eagles 04/13" vs Poly: "Will Kansas City Chiefs beat
// Philadelphia Eagles on April 13?"). Token overlap on team names alone
// usually only gives 0.30-0.40, so we lower the threshold for any pair
// where both titles share a recognizable team from the same league.
const SPORTS_FUZZY_THRESHOLD = 0.30;
// Crypto and economic categories use a 0.35 threshold — slightly lower
// than politics (0.40) because price/release-date wording differs more
// across platforms but slightly higher than sports because the underlying
// fuzzy matcher still has signal to work with (no team-name truncation).
const CRYPTO_FUZZY_THRESHOLD = 0.35;
const ECONOMIC_FUZZY_THRESHOLD = 0.35;
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
// Per-category date filter ceilings — the further out a market closes,
// the more its annualized return decays and the more category-specific
// resolution risk creeps in. Sports get the tightest window because games
// resolve in hours/days; crypto price markets get 30 days (most are weekly
// or monthly); economic releases get 60 days (covers next CPI/NFP cycle);
// politics/everything else keeps the 365-day default.
const MAX_DAYS_TO_CLOSE_SPORTS = 14;
const MAX_DAYS_TO_CLOSE_CRYPTO = 30;
const MAX_DAYS_TO_CLOSE_ECONOMIC = 60;
// 15% annualized minimum is the politics floor (current default).
// Sports/crypto/economic categories deserve different floors because
// their average days-to-close is shorter, so even small spreads still
// produce huge APYs (50%/30%/20% respectively).
const MIN_ANNUALIZED_RETURN = 0.15;
const MIN_APY_SPORTS = 0.50;
const MIN_APY_CRYPTO = 0.30;
const MIN_APY_ECONOMIC = 0.20;
const MIN_APY_POLITICS = 0.15;
// Priority = annualizedReturn * categoryMultiplier. Faster-recycling
// categories rank above equivalent-APY long-dated ones because the same
// dollar can be redeployed sooner.
const CATEGORY_MULTIPLIER_SPORTS = 1.5;
const CATEGORY_MULTIPLIER_CRYPTO = 1.3;
const CATEGORY_MULTIPLIER_ECONOMIC = 1.2;
const CATEGORY_MULTIPLIER_POLITICS = 1.0;
const REQUEST_DELAY_MS = 50; // gentle pacing between orderbook calls
const KALSHI_PAGE_DELAY_MS = 250; // Kalshi rate limit ~5 req/s
const MAX_PAIRS_TO_RESOLVE = 250; // soft cap; cache covers steady state
const MAX_ORDERBOOKS_TO_FETCH = 250;
const CLAUDE_CONCURRENCY = 6;
const ORDERBOOK_CONCURRENCY = 4;
const TOP_SPREADS_STORED = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

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

type Sport = 'nfl' | 'nba' | 'mlb' | 'nhl';

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

interface DetectedTeams {
  nfl: string[];
  nba: string[];
  mlb: string[];
}

const EMPTY_TEAMS: DetectedTeams = { nfl: [], nba: [], mlb: [] };

function hasAnyTeam(t: DetectedTeams): boolean {
  return t.nfl.length + t.nba.length + t.mlb.length > 0;
}

function detectTeams(title: string): DetectedTeams {
  if (!title) return EMPTY_TEAMS;
  const lower = ' ' + title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const nfl: string[] = [];
  const nba: string[] = [];
  const mlb: string[] = [];
  // Pad with spaces so 'rays' doesn't match 'arrays', etc.
  for (const team of NFL_TEAMS) if (lower.includes(' ' + team + ' ')) nfl.push(team);
  for (const team of NBA_TEAMS) if (lower.includes(' ' + team + ' ')) nba.push(team);
  for (const team of MLB_TEAMS) if (lower.includes(' ' + team + ' ')) mlb.push(team);
  return { nfl, nba, mlb };
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
  return null;
}

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
// Crypto market detection
// ─────────────────────────────────────────────────────────────────────────────
//
// We extract the asset (BTC/ETH), price level (e.g. 100000 for "$100K"),
// and a coarse date reference (e.g. "jul-2025" or "2025") from each title
// at fetch time. The crypto fast-path requires both sides to have all
// three populated AND to match exactly. Anything else falls through to
// Claude.

interface CryptoInfo {
  asset: 'btc' | 'eth';
  price: number | null;
  dateRef: string | null;
}

const MONTH_MAP: Record<string, string> = {
  jan: 'jan', january: 'jan',
  feb: 'feb', february: 'feb',
  mar: 'mar', march: 'mar',
  apr: 'apr', april: 'apr',
  may: 'may',
  jun: 'jun', june: 'jun',
  jul: 'jul', july: 'jul',
  aug: 'aug', august: 'aug',
  sep: 'sep', sept: 'sep', september: 'sep',
  oct: 'oct', october: 'oct',
  nov: 'nov', november: 'nov',
  dec: 'dec', december: 'dec',
};

function detectCrypto(title: string): CryptoInfo | null {
  if (!title) return null;
  const lower = title.toLowerCase();
  let asset: 'btc' | 'eth' | null = null;
  if (/\b(bitcoin|btc)\b/.test(lower)) asset = 'btc';
  else if (/\b(ethereum|eth|ether)\b/.test(lower)) asset = 'eth';
  if (!asset) return null;

  // Extract first price level. Patterns:
  //   $100K, $100,000, 100K, $4500, $100000
  // We require BTC ≥ 1000 and ETH ≥ 100 to filter out years and small ints.
  let price: number | null = null;
  const priceRe = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = priceRe.exec(lower)) !== null) {
    const cleanedNum = match[1].replace(/,/g, '');
    let val = parseFloat(cleanedNum);
    if (!Number.isFinite(val)) continue;
    const suffix = match[2]?.toLowerCase();
    if (suffix === 'k') val *= 1000;
    else if (suffix === 'm') val *= 1_000_000;
    if (asset === 'btc' && val < 1000) continue;
    if (asset === 'eth' && val < 100) continue;
    if (val > 10_000_000) continue;
    // Reject likely-year matches (4 digits 2000-2099 with no $ or K/M).
    if (val >= 2000 && val <= 2099 && !match[0].includes('$') && !suffix) continue;
    price = val;
    break;
  }

  // Extract date reference: "by July 2025", "Dec 31 2025", "EOY 2025",
  // "end of 2025", or just a bare year. Canonicalize to mon-YYYY when both
  // are present, else just YYYY.
  let dateRef: string | null = null;
  const monthYearRe =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s*(?:\d{1,2},?\s*)?(\d{4})\b/i;
  const my = lower.match(monthYearRe);
  if (my) {
    const m = MONTH_MAP[my[1].toLowerCase()] ?? my[1].toLowerCase();
    dateRef = `${m}-${my[2]}`;
  } else {
    const eoyMatch = lower.match(/\b(?:eoy|end of(?:\s+the)?(?:\s+year)?)\s*(\d{4})\b/);
    if (eoyMatch) {
      dateRef = `dec-${eoyMatch[1]}`;
    } else {
      const yearMatch = lower.match(/\b(20\d{2})\b/);
      if (yearMatch) dateRef = yearMatch[1];
    }
  }

  return { asset, price, dateRef };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pair category classification
// ─────────────────────────────────────────────────────────────────────────────

type PairCategory = 'sports' | 'crypto' | 'economic' | 'politics';

const ECONOMIC_CATEGORIES = new Set([
  'economics', 'finance',
  'Economics', 'Finance',
]);

const CRYPTO_CATEGORIES = new Set([
  'crypto', 'bitcoin', 'ethereum',
  'Crypto', 'Bitcoin', 'Ethereum',
]);

function isEconomicMarket(m: UnifiedMarket): boolean {
  const cat = m.category;
  if (!cat) return false;
  return ECONOMIC_CATEGORIES.has(cat);
}

function isCryptoMarket(m: UnifiedMarket): boolean {
  if (m.cryptoAsset) return true;
  const cat = m.category;
  if (!cat) return false;
  return CRYPTO_CATEGORIES.has(cat);
}

function pairCategory(pair: CandidatePair): PairCategory {
  // Sports first — most specific signal (precomputed shared team).
  if (pairSharedTeamFast(pair)) return 'sports';
  // Crypto second — at least one side has asset detected OR has crypto
  // category tag. Same-asset detection on both sides is what triggers the
  // FAST-PATH; here we just need to bucket the pair correctly.
  if (isCryptoMarket(pair.kalshi) || isCryptoMarket(pair.poly)) return 'crypto';
  // Economic — either side tagged in Economics/Finance.
  if (isEconomicMarket(pair.kalshi) || isEconomicMarket(pair.poly)) return 'economic';
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
  if (cat === 'sports') return MAX_DAYS_TO_CLOSE_SPORTS;
  if (cat === 'crypto') return MAX_DAYS_TO_CLOSE_CRYPTO;
  if (cat === 'economic') return MAX_DAYS_TO_CLOSE_ECONOMIC;
  return MAX_DAYS_TO_CLOSE;
}

function minApyForCategory(cat: PairCategory): number {
  if (cat === 'sports') return MIN_APY_SPORTS;
  if (cat === 'crypto') return MIN_APY_CRYPTO;
  if (cat === 'economic') return MIN_APY_ECONOMIC;
  return MIN_APY_POLITICS;
}

function categoryMultiplier(cat: PairCategory): number {
  if (cat === 'sports') return CATEGORY_MULTIPLIER_SPORTS;
  if (cat === 'crypto') return CATEGORY_MULTIPLIER_CRYPTO;
  if (cat === 'economic') return CATEGORY_MULTIPLIER_ECONOMIC;
  return CATEGORY_MULTIPLIER_POLITICS;
}

function fuzzyThresholdForCategory(cat: PairCategory): number {
  if (cat === 'sports') return SPORTS_FUZZY_THRESHOLD;
  if (cat === 'crypto') return CRYPTO_FUZZY_THRESHOLD;
  if (cat === 'economic') return ECONOMIC_FUZZY_THRESHOLD;
  return FUZZY_THRESHOLD;
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
  const message = `${timestamp}${method}${path}`;
  const key = await importPrivateKey(privateKeyPem);
  // Match Python reference: padding.PSS.MAX_LENGTH for 2048-bit RSA + SHA-256
  // → emLen(256) - hLen(32) - 2 = 222.
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 222 },
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
  yes_ask?: number;
  no_ask?: number;
  mve_collection_ticker?: string;
}

interface KalshiEventRaw {
  event_ticker?: string;
  series_ticker?: string;
  category?: string;
  title?: string;
  markets?: KalshiMarketRaw[];
}

// Categories on /events that overlap with Polymarket inventory.
const KALSHI_CATEGORIES = new Set([
  'Politics',
  'Economics',
  'Finance',
  'Crypto',
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

// Series tickers Kalshi uses for crypto price markets. Daily variants
// (D suffix) are the highest-value short-dated markets. Fetched
// unconditionally alongside /events because daily markets churn through
// /events fast and we don't want to miss them.
const KALSHI_CRYPTO_SERIES = [
  'KXBTC',  // Bitcoin price (weekly/longer)
  'KXBTCD', // Bitcoin daily
  'KXETH',  // Ethereum price
  'KXETHD', // Ethereum daily
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

// Series tickers known to contain political/macro/crypto markets — used as a
// fallback when /events filtering doesn't yield enough markets.
const HIGH_OVERLAP_SERIES = [
  'KXFED', // Fed rate decisions
  'KXINFL', // Inflation
  'KXGDP', // GDP
  'KXPRES', // Presidential
  'KXSENATE', // Senate
  'KXHOUSE', // House
  'KXBTC', // Bitcoin price
  'KXETH', // Ethereum
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
): Promise<{ events: KalshiEventRaw[]; cursor: string | null }> {
  const params = new URLSearchParams({
    limit: '200',
    status: 'open',
    with_nested_markets: 'true',
  });
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
  const yesAsk = typeof m.yes_ask === 'number' ? m.yes_ask / 100 : undefined;
  const noAsk = typeof m.no_ask === 'number' ? m.no_ask / 100 : undefined;
  let sportInfo: KalshiSportInfo | null = null;
  try {
    sportInfo = parseKalshiSportTicker(m.event_ticker ?? m.ticker);
  } catch (err) {
    console.error('[scanner] parseKalshiSportTicker threw', err);
  }
  // Crypto detection runs on every Kalshi market title (not just Crypto
  // category) because some events sit under "Finance" or no category at
  // all but are clearly crypto price markets.
  let cryptoInfo: CryptoInfo | null = null;
  try {
    cryptoInfo = detectCrypto(m.title ?? '');
  } catch (err) {
    console.error('[scanner] detectCrypto threw', err);
  }
  list.push({
    platform: 'kalshi',
    marketId: m.ticker,
    title: m.title ?? '',
    closeTime: m.close_time,
    yesAsk,
    noAsk,
    url: buildKalshiUrl(m),
    category: category ?? (sportInfo ? 'Sports' : cryptoInfo ? 'Crypto' : undefined),
    sportLeague: sportInfo?.sport,
    sportTeams: sportInfo?.teams,
    cryptoAsset: cryptoInfo?.asset,
    cryptoPrice: cryptoInfo?.price ?? undefined,
    cryptoDateRef: cryptoInfo?.dateRef ?? undefined,
  });
}

async function kalshiGetMarkets(): Promise<UnifiedMarket[]> {
  const markets: UnifiedMarket[] = [];
  const seen = new Set<string>();
  const categoriesSeen = new Set<string>();

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

  // Approach D (crypto): always pull KX{BTC,ETH}{,D} series. /events
  // sometimes serves these under "Crypto" category but daily markets
  // churn faster than /events pages and we don't want to miss any.
  const cryptoBefore = markets.length;
  for (const series of KALSHI_CRYPTO_SERIES) {
    try {
      const seriesMarkets = await kalshiFetchSeriesMarkets(series);
      const before = markets.length;
      for (const m of seriesMarkets) {
        pushKalshiMarket(markets, seen, m, 'Crypto');
      }
      console.log(
        `[scanner] kalshi crypto series ${series}: +${markets.length - before} markets (raw ${seriesMarkets.length})`,
      );
    } catch (err) {
      console.error(`[scanner] kalshi crypto series ${series} fetch failed`, err);
    }
    await sleep(KALSHI_PAGE_DELAY_MS);
  }
  console.log(
    `[scanner] kalshi crypto series total: +${markets.length - cryptoBefore} markets`,
  );

  // Approach E (economic releases): Kalshi's strongest category. Same
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

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket
// ─────────────────────────────────────────────────────────────────────────────

interface PolyMarketRaw {
  conditionId?: string;
  question?: string;
  endDate?: string;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  clobTokenIds?: string | string[];
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
// Crypto-specific slugs (bitcoin/ethereum) are kept separate from the
// generic 'crypto' slug because Polymarket sometimes promotes a crypto
// price market under the asset slug only.
const POLY_TAG_SLUGS = [
  'politics',
  'crypto',
  'bitcoin',
  'ethereum',
  'economics',
  'finance',
  'science',
  // Sport-specific slugs FIRST so they win the dedupe over the generic
  // 'sports' slug below.
  'mlb',
  'nba',
  'nfl',
  'nhl',
  'soccer',
  'sports',
];

// Slugs that imply the market is sports — used to gate per-title team
// detection. Includes the per-sport slugs even though we no longer fetch
// them, in case a Polymarket market gets a sport-specific tag through
// some other path.
const POLY_SPORT_SLUGS = new Set(['nfl', 'nba', 'mlb', 'nhl', 'soccer', 'sports']);

// Slugs that imply the market is crypto — used to seed crypto detection
// at fetch time on titles that don't explicitly mention BTC/ETH.
const POLY_CRYPTO_SLUGS = new Set(['crypto', 'bitcoin', 'ethereum']);

interface PolyEventRaw {
  slug?: string;
  markets?: PolyMarketRaw[];
}

function polyMarketToUnified(
  m: PolyMarketRaw,
  eventSlug: string | undefined,
  category?: string,
): UnifiedMarket | null {
  if (!m.enableOrderBook || !m.acceptingOrders) return null;
  const conditionId = m.conditionId ?? '';
  if (!conditionId) return null;
  let tokenIds: string[] = [];
  try {
    const raw = m.clobTokenIds ?? '[]';
    if (typeof raw === 'string') tokenIds = JSON.parse(raw);
    else if (Array.isArray(raw)) tokenIds = raw;
  } catch {
    return null;
  }
  if (tokenIds.length < 2) return null;
  const title = m.question ?? '';
  // Polymarket titles are full text ("Will the New York Mets beat the
  // Athletics on April 11?") so direct team-name detection works. We pick
  // the first sport that has a hit; per-sport disambiguation is then
  // handled by findSharedSportTeam.
  let sportLeague: string | undefined;
  let sportTeams: string[] | undefined;
  if (POLY_SPORT_SLUGS.has(category ?? '')) {
    const detected = detectTeams(title);
    if (detected.mlb.length > 0) { sportLeague = 'mlb'; sportTeams = detected.mlb; }
    else if (detected.nba.length > 0) { sportLeague = 'nba'; sportTeams = detected.nba; }
    else if (detected.nfl.length > 0) { sportLeague = 'nfl'; sportTeams = detected.nfl; }
    // NHL detection from titles isn't reliable yet (no team list above),
    // but the tag itself flags this as a sports market.
  }
  // Crypto detection: always run on every Polymarket title (since price
  // markets sometimes show up under non-crypto categories).
  let cryptoInfo: CryptoInfo | null = null;
  try {
    cryptoInfo = detectCrypto(title);
  } catch (err) {
    console.error('[scanner] detectCrypto threw (poly)', err);
  }
  // Normalize the category for poly-side classification: Polymarket sends
  // tag slugs in lowercase; we keep them lowercase so isEconomicMarket
  // matches both 'Economics' (kalshi) and 'finance' (poly).
  let resolvedCategory = category;
  if (POLY_CRYPTO_SLUGS.has(category ?? '') && !cryptoInfo) {
    // Tag says crypto but title didn't parse — still flag it.
    resolvedCategory = 'crypto';
  }
  return {
    platform: 'polymarket',
    marketId: conditionId,
    title,
    yesTokenId: tokenIds[0],
    noTokenId: tokenIds[1],
    closeTime: m.endDate,
    url: eventSlug
      ? `https://polymarket.com/event/${eventSlug}`
      : buildPolyUrl(m),
    category: resolvedCategory,
    sportLeague,
    sportTeams,
    cryptoAsset: cryptoInfo?.asset,
    cryptoPrice: cryptoInfo?.price ?? undefined,
    cryptoDateRef: cryptoInfo?.dateRef ?? undefined,
  };
}

async function polyFetchEventsByTag(slug: string): Promise<UnifiedMarket[]> {
  const out: UnifiedMarket[] = [];
  // 50 events per tag (was 100) — with 13 tag slugs we hit WORKER_LIMIT
  // at the higher limit. Page 1 is sorted by volume so the top-50 slice
  // is still the highest-value markets.
  const limit = 50;
  let offset = 0;
  const MAX_PAGES = 1;
  let pages = 0;
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
    pages++;
    offset += limit;
    if (data.length < limit) break;
    await sleep(REQUEST_DELAY_MS);
  }
  return out;
}

async function polyGetMarkets(): Promise<UnifiedMarket[]> {
  // Bounded concurrency: 2 in flight at a time keeps the worker well
  // under its memory budget. The previous setting of 4 was at the edge
  // and caused intermittent WORKER_LIMIT failures on cold start.
  const tagResults = await mapPool(POLY_TAG_SLUGS, 2, (slug) =>
    polyFetchEventsByTag(slug).catch((err) => {
      console.error(`[scanner] poly tag ${slug} failed`, err);
      return [] as UnifiedMarket[];
    }),
  );
  const seen = new Set<string>();
  const markets: UnifiedMarket[] = [];
  for (let i = 0; i < tagResults.length; i++) {
    const before = markets.length;
    for (const m of tagResults[i]) {
      if (seen.has(m.marketId)) continue;
      seen.add(m.marketId);
      markets.push(m);
    }
    console.log(
      `[scanner] poly tag ${POLY_TAG_SLUGS[i]}: +${markets.length - before} markets (raw ${tagResults[i].length})`,
    );
  }
  const polySportsCount = markets.filter(isSportsMarket).length;
  console.log(`[scanner] poly sports total: ${polySportsCount}`);
  return markets;
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
function kalshiFee(contracts: number, price: number): number {
  return Math.ceil(0.07 * contracts * price * (1 - price) * 100) / 100;
}

// Polymarket taker fee, introduced March 2026 (was 0 prior to that — our
// previous polyFee = 0 was correct then but is now wrong for new markets).
// Source: docs.polymarket.com/trading/fees. Fee shape is identical to
// Kalshi: feeRate × contracts × price × (1 - price), no cent rounding.
// Per-category coefficients (taker):
//   crypto 0.072, economics/culture/weather/other 0.05,
//   politics/finance/tech/mentions 0.04, sports 0.03, geopolitics 0.
// We don't pass category through the calculator yet, so default to the
// MAX observed coefficient (0.072) — conservative on purpose: it never
// understates fees, the worst it does is hide marginal opportunities.
const POLY_FEE_COEFFICIENT = 0.072;
function polyFee(contracts: number, price: number): number {
  return POLY_FEE_COEFFICIENT * contracts * price * (1 - price);
}

function feeForLeg(platform: Platform, contracts: number, price: number): number {
  return platform === 'kalshi'
    ? kalshiFee(contracts, price)
    : polyFee(contracts, price);
}

function walkOrderbook(
  yesAsks: OrderbookLevel[],
  noAsks: OrderbookLevel[],
  yesPlatform: Platform,
  noPlatform: Platform,
  minThreshold: number,
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
      const yesFee = feeForLeg(yesPlatform, qty, y.price);
      const noFee = feeForLeg(noPlatform, qty, n.price);
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
): ArbitrageLevel[] {
  const a = walkOrderbook(kalshiBook.yesAsks, polyBook.noAsks, 'kalshi', 'polymarket', minThreshold);
  const b = walkOrderbook(polyBook.yesAsks, kalshiBook.noAsks, 'polymarket', 'kalshi', minThreshold);
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

interface FuzzyMatchResult {
  pairs: CandidatePair[];
  topPairs: Array<{ score: number; kalshi: string; poly: string }>;
}

function findCandidatePairs(
  kalshiMarkets: UnifiedMarket[],
  polyMarkets: UnifiedMarket[],
): FuzzyMatchResult {
  if (kalshiMarkets.length === 0 || polyMarkets.length === 0) {
    return { pairs: [], topPairs: [] };
  }

  // Direct join passes run BEFORE the general fuzzy matcher for categories
  // where titles overlap weakly across platforms (sports has abbreviated
  // team names on Kalshi; crypto has different price phrasings). The
  // claimedPoly set prevents the fuzzy pass from double-pairing.
  const claimedPoly = new Set<number>();
  const sportsResults: CandidatePair[] = [];
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
  for (let i = 0; i < kalshiMarkets.length; i++) {
    const km = kalshiMarkets[i];
    if (!km.sportLeague || !km.sportTeams) continue;
    // For team-pair sports, we want both teams to match for the strongest
    // signal. Score = (number of overlapping teams) / 2.
    const candidatesByPoly = new Map<number, number>(); // polyIdx → overlap count
    for (const t of km.sportTeams) {
      const key = km.sportLeague + ':' + t;
      const list = polyTeamIndex.get(key);
      if (!list) continue;
      for (const j of list) {
        if (claimedPoly.has(j)) continue;
        candidatesByPoly.set(j, (candidatesByPoly.get(j) ?? 0) + 1);
      }
    }
    if (candidatesByPoly.size === 0) continue;
    // Pick the poly with the highest overlap, breaking ties by closest
    // close-time (we don't have that here yet; use first).
    let bestJ = -1;
    let bestOv = 0;
    for (const [j, ov] of candidatesByPoly) {
      if (ov > bestOv) { bestOv = ov; bestJ = j; }
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
    `[scanner] sports join pass: ${sportsResults.length} pairs from ${claimedPoly.size} claimed poly markets`,
  );

  // Crypto join pass — match by (asset, price, dateRef) tuple. Both sides
  // must have all three populated AND match exactly. The matcher only
  // produces a pair when there's a clean signal; anything else falls
  // through to the fuzzy pass. We boost the score so crypto pairs always
  // make MAX_PAIRS_TO_RESOLVE.
  const cryptoResults: CandidatePair[] = [];
  // Build poly crypto index keyed by asset|price|date.
  const polyCryptoIndex = new Map<string, number[]>();
  for (let j = 0; j < polyMarkets.length; j++) {
    const pm = polyMarkets[j];
    if (!pm.cryptoAsset || pm.cryptoPrice === undefined || !pm.cryptoDateRef) continue;
    const key = `${pm.cryptoAsset}|${pm.cryptoPrice}|${pm.cryptoDateRef}`;
    let arr = polyCryptoIndex.get(key);
    if (!arr) { arr = []; polyCryptoIndex.set(key, arr); }
    arr.push(j);
  }
  for (let i = 0; i < kalshiMarkets.length; i++) {
    const km = kalshiMarkets[i];
    if (!km.cryptoAsset || km.cryptoPrice === undefined || !km.cryptoDateRef) continue;
    const key = `${km.cryptoAsset}|${km.cryptoPrice}|${km.cryptoDateRef}`;
    const list = polyCryptoIndex.get(key);
    if (!list) continue;
    // Pick the first unclaimed match. Crypto markets don't typically
    // have ambiguity at the (asset, price, date) tuple level.
    let bestJ = -1;
    for (const j of list) {
      if (claimedPoly.has(j)) continue;
      bestJ = j;
      break;
    }
    if (bestJ === -1) continue;
    claimedPoly.add(bestJ);
    cryptoResults.push({
      kalshi: km,
      poly: polyMarkets[bestJ],
      score: 0.97, // between sports (0.95-0.99) and politics fuzzy max
    });
  }
  console.log(
    `[scanner] crypto join pass: ${cryptoResults.length} pairs (poly index size ${polyCryptoIndex.size})`,
  );

  const kalshiTok = kalshiMarkets.map((m) => tokenize(m.title));
  const polyTok = polyMarkets.map((m) => tokenize(m.title));
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

  // Start with the join-pass results so they can't get displaced.
  const claimed = new Set<number>(claimedPoly);
  const results: CandidatePair[] = [];
  for (const sp of sportsResults) results.push(sp);
  for (const cr of cryptoResults) results.push(cr);
  // Lowered to the loosest per-category threshold so crypto/economic
  // fuzzy matches survive. The per-category re-check happens in the
  // date filter step in runScanCycle.
  const LOWER_BOUND = Math.min(
    FUZZY_THRESHOLD,
    CRYPTO_FUZZY_THRESHOLD,
    ECONOMIC_FUZZY_THRESHOLD,
  );
  for (const entry of order) {
    if (entry.polyIdx < 0) continue;
    if (entry.score < LOWER_BOUND) continue;
    if (claimed.has(entry.polyIdx)) continue;
    claimed.add(entry.polyIdx);
    results.push({
      kalshi: kalshiMarkets[entry.kalshiIdx],
      poly: polyMarkets[entry.polyIdx],
      score: entry.score,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return { pairs: results, topPairs };
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

const SYSTEM_PROMPT =
  'You are a prediction market analyst specializing in resolution criteria. ' +
  'Compare two markets from different platforms and determine if they will ' +
  'definitionally resolve to the same outcome. Be conservative — if there is ' +
  'any meaningful difference in resolution conditions, flag it. Respond only ' +
  'with valid JSON, no markdown backticks.';

function isVerdict(value: unknown): value is ResolutionVerdict {
  return value === 'SAFE' || value === 'CAUTION' || value === 'SKIP';
}

interface VerifyResult {
  verdict: ResolutionVerdict;
  reasoning: string;
  riskFactors: string[];
}

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  if (anthropicClient) return anthropicClient;
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (!apiKey) return null;
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

async function verifyPair(
  kalshi: UnifiedMarket,
  poly: UnifiedMarket,
): Promise<VerifyResult> {
  const client = getAnthropic();
  if (!client) {
    return { verdict: 'PENDING', reasoning: 'No API key configured', riskFactors: [] };
  }

  const userMessage =
    'Compare these prediction markets:\n\n' +
    'KALSHI:\n' +
    `Title: ${kalshi.title}\n` +
    `Resolution criteria: ${kalshi.resolutionCriteria ?? 'Not explicitly stated'}\n\n` +
    'POLYMARKET:\n' +
    `Title: ${poly.title}\n` +
    `Resolution criteria: ${poly.resolutionCriteria ?? 'Not explicitly stated'}\n\n` +
    'Return JSON only:\n' +
    '{\n' +
    '  "verdict": "SAFE" | "CAUTION" | "SKIP",\n' +
    '  "reasoning": "one sentence",\n' +
    '  "risk_factors": ["difference 1", "difference 2"]\n' +
    '}\n\n' +
    'SAFE = identical resolution, guaranteed same outcome\n' +
    'CAUTION = similar but subtle differences exist\n' +
    'SKIP = different resolution conditions, do not trade';

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = response.content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { type: string; text: string }) => b.text)
      .join('')
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { verdict: 'CAUTION', reasoning: 'Failed to parse Claude response', riskFactors: [] };
    }
    const obj = parsed as { verdict?: unknown; reasoning?: unknown; risk_factors?: unknown };
    const verdict: ResolutionVerdict = isVerdict(obj.verdict) ? obj.verdict : 'CAUTION';
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
    const riskFactors = Array.isArray(obj.risk_factors)
      ? obj.risk_factors.filter((r): r is string => typeof r === 'string')
      : [];
    return { verdict, reasoning, riskFactors };
  } catch (err) {
    console.error('[scanner] verifyPair error', err);
    return { verdict: 'CAUTION', reasoning: 'Claude API error', riskFactors: [] };
  }
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
}

async function getCachedVerdict(
  sb: SupabaseClient,
  kalshiId: string,
  polyId: string,
): Promise<{ id: string; verdict: ResolutionVerdict; reasoning: string } | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('market_pairs')
    .select('id, resolution_verdict, verdict_reasoning, last_verified_at')
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
  };
}

async function upsertMarketPair(
  sb: SupabaseClient,
  pair: CandidatePair,
  verdict: ResolutionVerdict,
  reasoning: string,
  riskFactors: string[],
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
// Scan cycle
// ─────────────────────────────────────────────────────────────────────────────

async function resolvePair(
  sb: SupabaseClient,
  pair: CandidatePair,
  skipClaude: boolean,
): Promise<PreparedPair> {
  // Sports fast-path runs BEFORE the verdict cache because (a) sports
  // resolutions are unambiguous so we always want SAFE here regardless of
  // any stale cached PENDING/CAUTION from prior Claude runs, and (b) it
  // saves a DB roundtrip when both pre-conditions hold.
  const sharedTeam = pairSharedTeam(pair);
  if (sharedTeam !== null) {
    const verdict: ResolutionVerdict = 'SAFE';
    const reasoning = `sports fast-path: both markets reference ${sharedTeam.sport.toUpperCase()} ${sharedTeam.team}; resolution unambiguous`;
    console.log(
      `[resolver] SAFE (sports fast-path, ${sharedTeam.sport}/${sharedTeam.team}) | ${pair.kalshi.title} → ${pair.poly.title}`,
    );
    const pairId = await upsertMarketPair(sb, pair, verdict, reasoning, []);
    return { pair, pairId, verdict, reasoning, riskFactors: [] };
  }
  // Crypto fast-path: SAFE only if both sides have asset+price+dateRef
  // AND all three match exactly. Anything else (different asset, missing
  // price, different date reference) falls through to Claude. Same
  // ordering rationale as sports — don't trust stale cached PENDING.
  const k = pair.kalshi;
  const p = pair.poly;
  if (
    k.cryptoAsset && p.cryptoAsset &&
    k.cryptoAsset === p.cryptoAsset &&
    k.cryptoPrice !== undefined && p.cryptoPrice !== undefined &&
    k.cryptoPrice === p.cryptoPrice &&
    k.cryptoDateRef && p.cryptoDateRef &&
    k.cryptoDateRef === p.cryptoDateRef
  ) {
    const verdict: ResolutionVerdict = 'SAFE';
    const reasoning =
      `crypto fast-path: both markets reference ${k.cryptoAsset.toUpperCase()} at $${k.cryptoPrice} on ${k.cryptoDateRef}`;
    console.log(
      `[resolver] SAFE (crypto fast-path, ${k.cryptoAsset}/${k.cryptoPrice}/${k.cryptoDateRef}) | ${k.title} → ${p.title}`,
    );
    const pairId = await upsertMarketPair(sb, pair, verdict, reasoning, []);
    return { pair, pairId, verdict, reasoning, riskFactors: [] };
  }
  // Economic markets: NEVER fast-path. Resolution differs by agency,
  // seasonal-adjustment flag, and exact threshold wording. Always send
  // to Claude. (No early return here — falls through to cache + verifyPair.)
  const cached = await getCachedVerdict(sb, pair.kalshi.marketId, pair.poly.marketId);
  if (cached) {
    console.log(
      `[resolver] cached ${cached.verdict} | ${pair.kalshi.title} → ${pair.poly.title}`,
    );
    return {
      pair,
      pairId: cached.id,
      verdict: cached.verdict,
      reasoning: cached.reasoning,
      riskFactors: [],
    };
  }
  let verdict: ResolutionVerdict = 'PENDING';
  let reasoning = '';
  let riskFactors: string[] = [];
  if (!skipClaude) {
    try {
      const r = await verifyPair(pair.kalshi, pair.poly);
      verdict = r.verdict;
      reasoning = r.reasoning;
      riskFactors = r.riskFactors;
    } catch (err) {
      console.error('[scanner] verifyPair failed', err);
      verdict = 'CAUTION';
    }
  }
  console.log(
    `[resolver] ${verdict} | ${pair.kalshi.title} → ${pair.poly.title}` +
      (reasoning ? ` | ${reasoning}` : ''),
  );
  const pairId = await upsertMarketPair(sb, pair, verdict, reasoning, riskFactors);
  return { pair, pairId, verdict, reasoning, riskFactors };
}

interface PairSummary {
  kalshiTitle: string;
  polyTitle: string;
  score: number;
  verdict: ResolutionVerdict;
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
  matchedCount: number;
  matchedCountPreDateFilter: number;
  pairsFilteredByDate: number;
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
  errors: string[];
}> {
  const errors: string[] = [];
  // 1. Fetch markets in parallel.
  const [kalshiResult, polyResult] = await Promise.allSettled([
    kalshiGetMarkets(),
    polyGetMarkets(),
  ]);
  const kalshiMarkets =
    kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];
  const polyMarkets = polyResult.status === 'fulfilled' ? polyResult.value : [];
  if (kalshiResult.status === 'rejected') {
    const msg = `kalshi.getMarkets: ${
      kalshiResult.reason instanceof Error
        ? kalshiResult.reason.message
        : String(kalshiResult.reason)
    }`;
    console.error(`[scanner] ${msg}`);
    errors.push(msg);
  }
  if (polyResult.status === 'rejected') {
    const msg = `poly.getMarkets: ${
      polyResult.reason instanceof Error
        ? polyResult.reason.message
        : String(polyResult.reason)
    }`;
    console.error(`[scanner] ${msg}`);
    errors.push(msg);
  }
  console.log(
    `[scanner] fetched ${kalshiMarkets.length} kalshi, ${polyMarkets.length} poly markets`,
  );
  console.log(
    '[scanner] kalshi sample:',
    JSON.stringify(kalshiMarkets.slice(0, 5).map((m) => m.title)),
  );
  console.log(
    '[scanner] poly sample:',
    JSON.stringify(polyMarkets.slice(0, 5).map((m) => m.title)),
  );
  console.log(`[scanner] fuzzy threshold: ${FUZZY_THRESHOLD}`);

  // Sports market counts using precomputed sport metadata on each market.
  const kalshiSportsCount = kalshiMarkets.filter(isSportsMarket).length;
  const polySportsCount = polyMarkets.filter(isSportsMarket).length;
  console.log(
    `[sports] kalshi=${kalshiSportsCount} poly=${polySportsCount}`,
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
  // (14d), crypto 30d, economic 60d, politics/everything else 365d. Pairs
  // also have to clear a per-category fuzzy threshold check at this stage
  // because the matcher uses a single low cutoff to keep all categories.
  const beforeDateFilter = allCandidates.length;
  let droppedByDate = { sports: 0, crypto: 0, economic: 0, politics: 0 };
  let droppedByCategoryThreshold = 0;
  const candidates = allCandidates.filter((p) => {
    const cat = pairCategory(p);
    // Per-category fuzzy threshold re-check. Sports/crypto join-pass
    // pairs have explicit scores ≥ 0.95 so they always clear.
    const fuzzyMin = fuzzyThresholdForCategory(cat);
    if (p.score < fuzzyMin) {
      droppedByCategoryThreshold++;
      return false;
    }
    const k = parseCloseTimeMs(p.kalshi.closeTime);
    const pl = parseCloseTimeMs(p.poly.closeTime);
    if (k === null || pl === null) return false;
    const kDays = daysFromNow(k);
    const pDays = daysFromNow(pl);
    const maxDays = maxDaysForCategory(cat);
    if (kDays < MIN_DAYS_TO_CLOSE || kDays > maxDays) {
      droppedByDate[cat]++;
      return false;
    }
    if (pDays < MIN_DAYS_TO_CLOSE || pDays > maxDays) {
      droppedByDate[cat]++;
      return false;
    }
    return true;
  });
  const pairsFilteredByDate = beforeDateFilter - candidates.length;
  console.log(
    '[date-filter]',
    JSON.stringify({
      before: beforeDateFilter,
      after: candidates.length,
      filteredOut: pairsFilteredByDate,
      droppedByDate,
      droppedByCategoryThreshold,
      maxDays: {
        sports: MAX_DAYS_TO_CLOSE_SPORTS,
        crypto: MAX_DAYS_TO_CLOSE_CRYPTO,
        economic: MAX_DAYS_TO_CLOSE_ECONOMIC,
        politics: MAX_DAYS_TO_CLOSE,
      },
    }),
  );

  const matchedPairs = candidates.slice(0, 10).map((p) => ({
    score: Number(p.score.toFixed(3)),
    kalshi: p.kalshi.title,
    poly: p.poly.title,
  }));
  console.log('[scanner] matched pairs (top 10):', JSON.stringify(matchedPairs));

  // 3. Resolve verdicts in parallel (cache check inside resolvePair).
  const toResolve = candidates.slice(0, MAX_PAIRS_TO_RESOLVE);
  const skipClaude = opts.skipClaude ?? false;
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

  console.log(
    `[scanner] fetching ${validPairs.length} orderbook pairs (concurrency=${ORDERBOOK_CONCURRENCY})`,
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
        [kalshiBook, polyBook] = await Promise.all([
          kalshiGetOrderbook(pair.kalshi.marketId),
          polyGetOrderbook(
            pair.poly.yesTokenId,
            pair.poly.noTokenId,
            pair.poly.marketId,
          ),
        ]);
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
      const priority = annReturn * categoryMultiplier(category);
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
    crypto: { pairs: 0, opportunities: 0, bestAPY: null, bestPriority: null },
    economic: { pairs: 0, opportunities: 0, bestAPY: null, bestPriority: null },
    politics: { pairs: 0, opportunities: 0, bestAPY: null, bestPriority: null },
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
    polyCount: polyMarkets.length,
    matchedCount: candidates.length,
    matchedCountPreDateFilter: beforeDateFilter,
    pairsFilteredByDate,
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
    categoryBreakdown,
    bestOverall,
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
      matchedCountPreDateFilter: result.matchedCountPreDateFilter,
      matchedCount: result.matchedCount,
      pairsFilteredByDate: result.pairsFilteredByDate,
      avgDaysToClose: result.avgDaysToClose,
      dateBuckets: result.dateBuckets,
      opportunityCount: result.opportunities.length,
      clearedSpreadCount: result.clearedSpreadCount,
      filteredByAnnReturn: result.filteredByAnnReturn,
      actionableCount: result.actionableCount,
      verdictDist: result.verdictDist,
      sportsStats: result.sportsStats,
      categoryBreakdown: result.categoryBreakdown,
      bestOverall: result.bestOverall,
      errors: result.errors,
    };
    if (diag) {
      body.topPairs = result.topPairs;
      body.matchedPairs = result.matchedPairs;
      body.pairSummaries = result.pairSummaries;
      body.kalshiOrderbookSamples = _kalshiRawSamples;
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
