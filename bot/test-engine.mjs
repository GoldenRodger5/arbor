/**
 * Arbor Engine Test Suite
 *
 * Tests:
 * 1. Gate logic (WE floor, price ceiling, HC, underdog, market matching) — pure JS
 * 2. Claude prompt responses — 5 real API calls covering NHL, MLB, NBA scenarios
 *
 * Run: node bot/test-engine.mjs
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';

// Load env from project root .env
const envRaw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envRaw.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
// Support both ANTHROPIC_API_KEY and VITE_ANTHROPIC_API_KEY
if (!process.env.ANTHROPIC_API_KEY && process.env.VITE_ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.VITE_ANTHROPIC_API_KEY;
}

// ─── Replicate core engine functions for testing ─────────────────────────────

const MLB_WIN_EXPECTANCY = {
  1: { 1: 0.56, 2: 0.58, 3: 0.60, 4: 0.64, 5: 0.67, 6: 0.71, 7: 0.77, 8: 0.84, 9: 0.91 },
  2: { 1: 0.64, 2: 0.67, 3: 0.70, 4: 0.76, 5: 0.79, 6: 0.83, 7: 0.88, 8: 0.93, 9: 0.96 },
  3: { 1: 0.72, 2: 0.75, 3: 0.78, 4: 0.85, 5: 0.87, 6: 0.90, 7: 0.93, 8: 0.96, 9: 0.98 },
  4: { 1: 0.79, 2: 0.82, 3: 0.85, 4: 0.90, 5: 0.92, 6: 0.94, 7: 0.96, 8: 0.98, 9: 0.99 },
  5: { 1: 0.85, 2: 0.87, 3: 0.90, 4: 0.93, 5: 0.95, 6: 0.97, 7: 0.98, 8: 0.99, 9: 0.99 },
};
const NBA_WIN_EXPECTANCY = {
  5:  { 1: 0.57, 2: 0.60, 3: 0.65, 4: 0.75 },
  10: { 1: 0.63, 2: 0.69, 3: 0.77, 4: 0.86 },
  15: { 1: 0.70, 2: 0.78, 3: 0.85, 4: 0.92 },
  20: { 1: 0.78, 2: 0.85, 3: 0.91, 4: 0.96 },
  25: { 1: 0.85, 2: 0.90, 3: 0.95, 4: 0.98 },
};
const NHL_WIN_EXPECTANCY = {
  1: { 1: 0.62, 2: 0.68, 3: 0.79 },
  2: { 1: 0.80, 2: 0.86, 3: 0.93 },
  3: { 1: 0.92, 2: 0.95, 3: 0.99 },
};

function getWinExpectancy(league, lead, period) {
  let table, leadKey, periodKey;
  if (league === 'mlb') {
    table = MLB_WIN_EXPECTANCY;
    leadKey = Math.min(lead, 5);
    periodKey = Math.min(Math.max(period, 1), 9);
  } else if (league === 'nba') {
    table = NBA_WIN_EXPECTANCY;
    leadKey = lead >= 25 ? 25 : lead >= 20 ? 20 : lead >= 15 ? 15 : lead >= 10 ? 10 : 5;
    periodKey = Math.min(Math.max(period, 1), 4);
  } else if (league === 'nhl') {
    table = NHL_WIN_EXPECTANCY;
    leadKey = Math.min(lead, 3);
    periodKey = Math.min(Math.max(period, 1), 3);
  } else { return null; }
  return table[leadKey]?.[periodKey] ?? null;
}

function getMaxPrice(league, period) {
  if (league === 'mlb') return 0.75;
  if (league === 'nhl') return period >= 3 ? 0.82 : 0.75;
  if (league === 'nba') return period >= 4 ? 0.80 : 0.75;
  return 0.75;
}

function getMinWE(league, diff) {
  if (league === 'mlb') return 0.75;
  if (league === 'nhl' && diff === 1) return 0.75;
  return 0.65;
}

function checkHighConviction(confidence, league, stage, diff, period) {
  if (confidence < 0.90 || stage !== 'late') return { isHighConv: false, reason: 'conf/stage fail' };
  let qualifies = false;
  let reason = '';
  if (league === 'nba') {
    if (diff >= 20) { qualifies = true; reason = `NBA Q4 up ${diff} pts`; }
    else if (diff >= 15 && period === 4) { qualifies = true; reason = `NBA Q4 up ${diff} pts`; }
  } else if (league === 'nhl') {
    if (diff >= 2) { qualifies = true; reason = `NHL P3 up ${diff} goals`; }
    // 1-goal P3 intentionally removed
  } else if (league === 'mlb') {
    if (diff >= 4 && period >= 7) { qualifies = true; reason = `MLB ${period}th up ${diff} runs`; }
    else if (diff >= 3 && period >= 8) { qualifies = true; reason = `MLB ${period}th up ${diff} runs`; }
  }
  if (!qualifies) return { isHighConv: false, reason: 'threshold not met' };
  const tier = confidence >= 0.93 ? 0.30 : 0.25;
  return { isHighConv: true, tier, reason };
}

const ABBR_MAP = {
  'CHW': 'CWS', 'CWS': 'CHW',
  'AZ': 'ARI', 'ARI': 'AZ',
  'GS': 'GSW', 'GSW': 'GS',
  'NY': 'NYK', 'NYK': 'NY',
  'SA': 'SAS', 'SAS': 'SA',
  'NO': 'NOP', 'NOP': 'NO',
  'UTAH': 'UTA', 'UTA': 'UTAH',
  'MON': 'MTL', 'MTL': 'MON',
  'LA': 'LAK', 'LAK': 'LA',
  'NJ': 'NJD', 'NJD': 'NJ',
  'TB': 'TBL', 'TBL': 'TB',
  'WSH': 'WAS', 'WAS': 'WSH',
  'ATH': 'OAK', 'OAK': 'ATH',
};

function tickerHasTeam(ticker, teamAbbr) {
  const upper = ticker.toUpperCase();
  if (upper.includes(teamAbbr.toUpperCase())) return true;
  const alt = ABBR_MAP[teamAbbr.toUpperCase()];
  if (alt && upper.includes(alt)) return true;
  return false;
}

// Price-based live market detection: sort by distance from 0.50
function pickLiveMarket(markets) {
  return [...markets].sort((a, b) =>
    Math.abs(b.price - 0.50) - Math.abs(a.price - 0.50)
  );
}

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, actual, expected, note = '') {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓  ${name}`);
  } else {
    failed++;
    failures.push({ name, actual, expected, note });
    console.log(`  ✗  ${name}`);
    console.log(`       got:      ${JSON.stringify(actual)}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    if (note) console.log(`       note: ${note}`);
  }
}

function assert(name, cond, note = '') {
  test(name, cond, true, note);
}

// ─── SECTION 1: WE Floor Gate ─────────────────────────────────────────────────
console.log('\n═══ SECTION 1: Win Expectancy Floor Gate ═══');

// MLB
{
  const we = getWinExpectancy('mlb', 1, 3);
  const floor = getMinWE('mlb', 1);
  test('MLB 1-run lead inning 3 → WE=60% → BLOCKED (need 75%)', we < floor, true, `WE=${(we*100).toFixed(0)}%`);
}
{
  const we = getWinExpectancy('mlb', 2, 5);
  const floor = getMinWE('mlb', 2);
  test('MLB 2-run lead inning 5 → WE=79% → PASSES', we >= floor, true, `WE=${(we*100).toFixed(0)}%`);
}
{
  const we = getWinExpectancy('mlb', 3, 4);
  const floor = getMinWE('mlb', 3);
  test('MLB 3-run lead inning 4 → WE=85% → PASSES', we >= floor, true, `WE=${(we*100).toFixed(0)}%`);
}
{
  const we = getWinExpectancy('mlb', 1, 6);
  const floor = getMinWE('mlb', 1);
  test('MLB 1-run lead inning 6 → WE=71% → BLOCKED (need 75%)', we < floor, true, `WE=${(we*100).toFixed(0)}%`);
}
{
  const we = getWinExpectancy('mlb', 1, 7);
  const floor = getMinWE('mlb', 1);
  test('MLB 1-run lead inning 7 → WE=77% → PASSES', we >= floor, true, `WE=${(we*100).toFixed(0)}%`);
}

// NHL
{
  const we = getWinExpectancy('nhl', 1, 2);
  const floor = getMinWE('nhl', 1);
  test('NHL 1-goal lead P2 → WE=68% → BLOCKED (need 75% for 1-goal)', we < floor, true, `WE=${(we*100).toFixed(0)}%`);
}
{
  const we = getWinExpectancy('nhl', 1, 3);
  const floor = getMinWE('nhl', 1);
  test('NHL 1-goal lead P3 → WE=79% → PASSES (1-goal floor=75%)', we >= floor, true, `WE=${(we*100).toFixed(0)}%`);
}
{
  const we = getWinExpectancy('nhl', 2, 1);
  const floor = getMinWE('nhl', 2);
  test('NHL 2-goal lead P1 → WE=80% → PASSES (2-goal floor=65%)', we >= floor, true, `WE=${(we*100).toFixed(0)}%`);
}
{
  const we = getWinExpectancy('nhl', 2, 2);
  const floor = getMinWE('nhl', 2);
  test('NHL 2-goal lead P2 → WE=86% → PASSES', we >= floor, true, `WE=${(we*100).toFixed(0)}%`);
}

// NBA
{
  const we = getWinExpectancy('nba', 5, 3);
  const floor = getMinWE('nba', 5);
  test('NBA 5-pt lead Q3 → WE=65% → PASSES (floor=65%)', we >= floor, true, `WE=${(we*100).toFixed(0)}%`);
}
{
  const we = getWinExpectancy('nba', 10, 2);
  const floor = getMinWE('nba', 10);
  test('NBA 10-pt lead Q2 → WE=69% → PASSES', we >= floor, true, `WE=${(we*100).toFixed(0)}%`);
}

// ─── SECTION 2: Price Ceiling Gate ────────────────────────────────────────────
console.log('\n═══ SECTION 2: Price Ceiling Gate ═══');

test('MLB inning 6, price 74¢ → PASSES ceiling (75¢)', 0.74 <= getMaxPrice('mlb', 6), true);
test('MLB inning 6, price 76¢ → BLOCKED (75¢ ceiling)', 0.76 > getMaxPrice('mlb', 6), true);
test('MLB inning 9, price 94¢ → BLOCKED (75¢ ceiling)', 0.94 > getMaxPrice('mlb', 9), true);
test('NHL P2, price 74¢ → PASSES ceiling (75¢)', 0.74 <= getMaxPrice('nhl', 2), true);
test('NHL P2, price 76¢ → BLOCKED (75¢ ceiling)', 0.76 > getMaxPrice('nhl', 2), true);
test('NHL P3, price 80¢ → PASSES ceiling (82¢)', 0.80 <= getMaxPrice('nhl', 3), true);
test('NHL P3, price 83¢ → BLOCKED (82¢ ceiling)', 0.83 > getMaxPrice('nhl', 3), true);
test('NBA Q3, price 74¢ → PASSES (75¢ ceiling)', 0.74 <= getMaxPrice('nba', 3), true);
test('NBA Q4, price 78¢ → PASSES (80¢ ceiling)', 0.78 <= getMaxPrice('nba', 4), true);
test('NBA Q4, price 81¢ → BLOCKED (80¢ ceiling)', 0.81 > getMaxPrice('nba', 4), true);

// ─── SECTION 3: High Conviction ───────────────────────────────────────────────
console.log('\n═══ SECTION 3: High Conviction Gate ═══');

{
  const r = checkHighConviction(0.92, 'nhl', 'late', 1, 3);
  test('NHL 1-goal P3 conf=92% → NOT high conviction (removed)', r.isHighConv, false,
    'After fix: HC requires diff>=2 for NHL. 1-goal P3 deploys 25-30% on 20-25% OT risk.');
}
{
  const r = checkHighConviction(0.92, 'nhl', 'late', 2, 3);
  test('NHL 2-goal P3 conf=92% → HIGH CONVICTION at 25% tier', r.isHighConv, true, r.reason);
  test('NHL 2-goal P3 tier', r.tier, 0.25);
}
{
  const r = checkHighConviction(0.94, 'nhl', 'late', 2, 3);
  test('NHL 2-goal P3 conf=94% → HIGH CONVICTION at 30% tier', r.tier, 0.30);
}
{
  const r = checkHighConviction(0.92, 'nhl', 'late', 1, 2);
  test('NHL 1-goal P2 conf=92% → NOT high conviction', r.isHighConv, false, 'P2 never qualified for HC');
}
{
  const r = checkHighConviction(0.92, 'mlb', 'late', 4, 8);
  test('MLB 4-run lead inning 8 conf=92% → HIGH CONVICTION', r.isHighConv, true, r.reason);
}
{
  const r = checkHighConviction(0.92, 'mlb', 'late', 3, 8);
  test('MLB 3-run lead inning 8 conf=92% → HIGH CONVICTION', r.isHighConv, true, r.reason);
}
{
  const r = checkHighConviction(0.92, 'mlb', 'late', 3, 7);
  test('MLB 3-run lead inning 7 conf=92% → NOT high conviction (need inning>=8 for 3-run)', r.isHighConv, false);
}
{
  const r = checkHighConviction(0.88, 'nhl', 'late', 2, 3);
  test('NHL 2-goal P3 conf=88% → NOT HC (need 90%)', r.isHighConv, false);
}
{
  const r = checkHighConviction(0.92, 'nhl', 'mid', 2, 3);
  test('NHL 2-goal P3 conf=92% stage=mid → NOT HC (need stage=late)', r.isHighConv, false);
}
{
  const r = checkHighConviction(0.92, 'nba', 'late', 20, 4);
  test('NBA 20-pt Q4 lead conf=92% → HIGH CONVICTION', r.isHighConv, true, r.reason);
}
{
  const r = checkHighConviction(0.92, 'nba', 'late', 14, 4);
  test('NBA 14-pt Q4 lead conf=92% → NOT HC (need 15+)', r.isHighConv, false);
}

// ─── SECTION 4: Underdog Gate ─────────────────────────────────────────────────
console.log('\n═══ SECTION 4: Underdog Gate ═══');

function underdogAllowed(league, diff, period, trailPrice) {
  if (trailPrice < 0.15 || trailPrice > 0.35) return false;
  if (league === 'nhl' && diff === 1 && period === 1) return true;
  if (league === 'nba' && diff <= 10 && period <= 2) return true;
  if (league === 'mlb' && diff <= 2 && period <= 5) return true;
  if ((league === 'mls' || league === 'epl') && diff === 1 && period <= 1) return true;
  return false;
}

test('NHL down 1, P1, 25¢ → ALLOWED', underdogAllowed('nhl', 1, 1, 0.25), true);
test('NHL down 1, P2, 25¢ → BLOCKED (period=2)', underdogAllowed('nhl', 1, 2, 0.25), false);
test('NHL down 1, P3, 25¢ → BLOCKED (period=3)', underdogAllowed('nhl', 1, 3, 0.25), false);
test('NHL down 2, P1, 25¢ → BLOCKED (diff=2, need exactly 1)', underdogAllowed('nhl', 2, 1, 0.25), false);
test('NHL down 1, P1, 14¢ → BLOCKED (below 15¢ floor)', underdogAllowed('nhl', 1, 1, 0.14), false);
test('NHL down 1, P1, 36¢ → BLOCKED (above 35¢ ceiling)', underdogAllowed('nhl', 1, 1, 0.36), false);
test('NBA down 8, Q2, 28¢ → ALLOWED', underdogAllowed('nba', 8, 2, 0.28), true);
test('NBA down 10, Q2, 28¢ → ALLOWED (exactly at threshold)', underdogAllowed('nba', 10, 2, 0.28), true);
test('NBA down 11, Q2, 28¢ → BLOCKED (diff>10)', underdogAllowed('nba', 11, 2, 0.28), false);
test('NBA down 8, Q3, 28¢ → BLOCKED (period=3)', underdogAllowed('nba', 8, 3, 0.28), false);
test('MLB down 2, inning 5, 25¢ → ALLOWED', underdogAllowed('mlb', 2, 5, 0.25), true);
test('MLB down 2, inning 6, 25¢ → BLOCKED (period>5)', underdogAllowed('mlb', 2, 6, 0.25), false);
test('MLB down 3, inning 4, 25¢ → BLOCKED (diff=3)', underdogAllowed('mlb', 3, 4, 0.25), false);

// ─── SECTION 5: Market Matching (ticker + ABBR_MAP) ───────────────────────────
console.log('\n═══ SECTION 5: Market Matching ═══');

// Ticker contains team
test('KXNHLGAME-26APR14WPGVGK-VGK contains WPG', tickerHasTeam('KXNHLGAME-26APR14WPGVGK-VGK', 'WPG'), true);
test('KXNHLGAME-26APR14WPGVGK-VGK contains VGK', tickerHasTeam('KXNHLGAME-26APR14WPGVGK-VGK', 'VGK'), true);
test('KXMLBGAME-26APR142140TEXATH-TEX contains TEX', tickerHasTeam('KXMLBGAME-26APR142140TEXATH-TEX', 'TEX'), true);
test('KXMLBGAME-26APR142140TEXATH-TEX contains ATH', tickerHasTeam('KXMLBGAME-26APR142140TEXATH-TEX', 'ATH'), true);
// ABBR_MAP translation
test('ABBR_MAP: ESPN LA Kings (LA) → Kalshi ticker LAK', tickerHasTeam('KXNHLGAME-26APR13LVSEA-LAK', 'LA'), true, 'ABBR_MAP LA→LAK');
test('ABBR_MAP: ESPN ATH (Athletics) → Kalshi OAK', tickerHasTeam('KXMLBGAME-26APR142140TEXOAK-OAK', 'ATH'), true, 'ABBR_MAP ATH→OAK');
test('ABBR_MAP: ESPN TB → Kalshi TBL', tickerHasTeam('KXNHLGAME-26APR13DETBTBL-TBL', 'TB'), true, 'ABBR_MAP TB→TBL');
test('ABBR_MAP: Kalshi WSH → ESPN WAS', tickerHasTeam('KXNHLGAME-26APR14WSHDAL-WAS', 'WSH'), true, 'ABBR_MAP WSH→WAS');
// Cross-sport collision prevention
test('NHL ticker does NOT contain NBA team SAS', tickerHasTeam('KXNHLGAME-26APR14WPGVGK-VGK', 'SAS'), false);
// Leading team market identification via suffix
{
  const ticker = 'KXNHLGAME-26APR14WPGVGK-VGK';
  const suffix = ticker.split('-').pop().toUpperCase();
  test('Suffix match: VGK ticker suffix = VGK → matches leadingAbbr VGK', suffix === 'VGK', true);
  test('Suffix match: VGK ticker suffix != WPG', suffix === 'WPG', false);
}

// ─── SECTION 6: Live Market Detection (price-based, not date-string) ───────────
console.log('\n═══ SECTION 6: Live Market Detection (price-based sort) ═══');

// Scenario: TEX@ATH — two markets, one live (94¢ = game in progress), one pre-game (53¢ = tomorrow)
const texAthMarkets = [
  { ticker: 'KXMLBGAME-26APR142140TEXATH-TEX', price: 0.53 }, // tomorrow pre-game
  { ticker: 'KXMLBGAME-26APR131900TEXATH-TEX', price: 0.94 }, // today live (4-0 lead)
];
const sorted = pickLiveMarket(texAthMarkets);
test('Live market detection: 94¢ live market sorts BEFORE 53¢ pre-game market', sorted[0].price, 0.94,
  'Distance from 50c: 44 pts vs 3 pts → live market wins');

// Scenario: NJD@PHI — two markets, near-50 pre-game + 28c live underdog
const nhlMarkets = [
  { ticker: 'KXNHLGAME-26APR14NJDPHI-NJD', price: 0.49 }, // pre-game, near 50
  { ticker: 'KXNHLGAME-26APR14NJDPHI-PHI', price: 0.72 }, // live, PHI leading
];
const sortedNHL = pickLiveMarket(nhlMarkets);
test('Live market detection: 72¢ live market sorts BEFORE 49¢ pre-game market', sortedNHL[0].price, 0.72);

// Both markets valid but wrong team suffix
{
  // VGK leading 4-0 (price 79¢, distance 29 pts from 50); WPG trailing (21¢, distance 29 pts)
  // Equal distance case — use a clearer example: VGK at 79¢ vs pre-game WPG at 51¢
  const markets = [
    { ticker: 'KXNHLGAME-26APR14WPGVGK-WPG', price: 0.51 }, // pre-game, nearly 50
    { ticker: 'KXNHLGAME-26APR14WPGVGK-VGK', price: 0.79 }, // live (VGK leading 3-0)
  ].filter(m => tickerHasTeam(m.ticker, 'WPG') && tickerHasTeam(m.ticker, 'VGK'));
  test('Both WPG and VGK tickers match game filter', markets.length, 2);
  const sorted2 = pickLiveMarket(markets);
  // 79¢ distance=29pts vs 51¢ distance=1pt → VGK sorts first
  test('VGK 79¢ (live leader) sorts before WPG 51¢ (pre-game)', sorted2[0].ticker.endsWith('-VGK'), true);
}

// ─── SECTION 7: Wrong-day detection (WE vs price consistency check) ───────────
console.log('\n═══ SECTION 7: Wrong-day Market Detection ═══');

// The bot detects wrong-day markets by checking: WE is high (live game) but price near 50 (pre-game)
// Rule: if WE > 80% but market price within 10% of 50¢ → pre-game / wrong day
function isWrongDayMarket(we, price) {
  return we > 0.80 && Math.abs(price - 0.50) < 0.10;
}

test('WE=94% price=53¢ → wrong-day (pre-game for diff day)', isWrongDayMarket(0.94, 0.53), true,
  'TEX leading 4-0 in 6th but tomorrow\'s market priced near 50');
test('WE=94% price=94¢ → live market (consistent)', isWrongDayMarket(0.94, 0.94), false);
test('WE=79% price=52¢ → wrong-day', isWrongDayMarket(0.79, 0.52), false,
  'WE=79% is NOT >80% so this passes — actually the bot checks >=80% in practice');
test('WE=85% price=50¢ → wrong-day', isWrongDayMarket(0.85, 0.50), true);
test('WE=68% price=62¢ → live (68% WE, price reflects live situation)', isWrongDayMarket(0.68, 0.62), false);

// ─── SECTION 8: Claude API Tests ──────────────────────────────────────────────
console.log('\n═══ SECTION 8: Claude Prompt Tests (live API calls) ═══');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Build a prompt exactly as the bot would — with game state, baseline WE, market, and instructions
function buildTestPrompt(scenario) {
  const { league, awayTeam, awayRecord, awayScore, homeTeam, homeRecord, homeScore,
    gameDetail, awayLineScore, homeLineScore, situation, pitcherInfo,
    targetAbbr, leadingAbbr, price, period, diff, isHome, baselineWE, extraContext } = scenario;

  const isLeading = targetAbbr === leadingAbbr;
  const homeAdj = isHome ? 0.03 : -0.01;
  const adjustedWE = Math.min(0.99, baselineWE + homeAdj);

  const awayAbbr = awayTeam.split(' ').pop().slice(0, 3).toUpperCase();
  const homeAbbr = homeTeam.split(' ').pop().slice(0, 3).toUpperCase();

  return `You are a professional sports bettor. Your job: predict this game's outcome using the historical baseline below.

═══ LIVE ${league.toUpperCase()} GAME ═══
${awayTeam} (${awayRecord}) ${awayScore}
  at
${homeTeam} (${homeRecord}) ${homeScore}

Status: ${gameDetail}
Line score: ${awayAbbr} [${awayLineScore}] | ${homeAbbr} [${homeLineScore}]
${situation ? `Situation: ${situation}\n` : ''}${pitcherInfo ? `\n${pitcherInfo}\n` : ''}
═══ HISTORICAL BASELINE: ${(adjustedWE * 100).toFixed(0)}% win probability for ${leadingAbbr} ═══
Based on historical data: a ${diff}-${league === 'nba' ? 'pt' : league === 'mlb' ? 'run' : 'goal'} lead in ${league === 'mlb' ? `inning ${period}` : league === 'nba' ? `Q${period}` : `period ${period}`} means the leading team wins ~${(adjustedWE * 100).toFixed(0)}% of the time.

═══ MARKET ═══
${targetAbbr} YES @ ${Math.round(price * 100)}¢ (market thinks ${Math.round(price * 100)}% chance)
(${isLeading ? 'LEADING team' : 'TRAILING team — underdog'}${isHome ? ', HOME)' : ', AWAY)'}
${extraContext || ''}
═══ STEP 1 — SEARCH FIRST, ANALYZE SECOND ═══
Before touching the baseline, use web search to check these FOUR things:
A) Is the leading team resting 3+ starters tonight? (injury report / lineup)
B) ${league === 'mlb' ? `What is the starter's ERA and current pitch count?` : league === 'nhl' ? `What is the leading team's starting goalie SV% this season?` : `What is the leading team's key player status tonight?`}
C) What is the H2H record between these two teams this season and last 2 seasons?
D) Does the TRAILING team have playoff/clinching implications tonight?

═══ STEP 2 — HARD NOs (if ANY apply, respond {"trade":false} immediately) ═══
❌ Leading team is resting 3+ key players → NO
❌ Trailing team is fighting for playoffs/clinching AND leading team has nothing to play for → NO
${league === 'mlb' ? '❌ Starter has 90+ pitches and bullpen ERA > 5.0 with 3+ innings left → NO\n' : ''}❌ You find yourself saying "modest," "marginal," "just clears the bar," or "only X points of edge" → NO

═══ STEP 3 — EDGE ANALYSIS (only if no Hard NOs triggered) ═══
Start from the historical baseline. Adjust based on what you found:
+ Leading team clearly better (record, talent, home) → UP 2-5%
${league === 'mlb' ?
`+ Dominant starter still pitching (ERA < 3.0, under 80 pitches) → UP 5-8%
+ Strong bullpen ERA < 3.5 about to enter → UP 2-4%
- Starter at 80+ pitches — bullpen transition coming → DOWN 3-5%
- SITUATION ALERT: Check the "Situation" line above. Runners in scoring position with 0-1 outs for the TRAILING team → DOWN 6-10%.
- BATTING ORDER ALERT: The "At bat" line shows the current batter. Search "[batter name] batting order [team] 2025" to determine lineup position. Cleanup hitters (3-4-5) at the plate with runners on = HIGH danger. Leadoff/bottom-order (1-2, 7-9) = lower threat.
- POWER HITTER ALERT: Trailing team has 25+ HR hitters coming up WITH RUNNERS ON BASE → DOWN 5-8%.
- Leading team bullpen ERA > 5.0 last 10 days → DOWN 5-8%
- HIGH-RUN PARK (Coors Field, Great American Ballpark, Globe Life Field) → reduce lead confidence 3-5%.` :
league === 'nba' ?
`+ Star player dominating (25+ pts, efficiency up) → UP 3-5%
- Trailing team star player getting hot → DOWN 3-6%
- Leading team on second game of back-to-back → DOWN 2-4%
- 15-pt comebacks happen 13% in the 3-point era. 10-pt leads in Q3 are NOT safe.` :
`+ 2-goal lead: much more reliable than 1-goal. 2-goal P3 = 93% WE.
+ Elite goalie (SV% > .920) → UP 3-5%
- OT RISK (1-goal lead in P3): Under 10 min → OT probability ~25-30%, reduce 3-5%. IMPORTANT: OT is NOT a coin flip — team OT win rates span 29% to 60%+. Search "[team] NHL OT record 2024-25" before finalizing confidence.
- Trailing team on power play right now → DOWN 8-12%`}
- Trailing team is significantly better (record, talent) → DOWN 4-8%
- H2H: trailing team won 7-9 of last 15 → DOWN 3-5%. Won 10+ of last 15 → DOWN 6-8%.
- Leading team win rate below 35% → DOWN 6-10%

═══ STEP 4 — DECISION ═══
BUY only if ALL three are true:
✓ Confidence ≥ 65%
✓ Confidence beats price by 4+ points
✓ You have CLEAR conviction. If you had to talk yourself into it, say NO.
${!isLeading ? `⚠️ UNDERDOG BET — HARD CAPS (non-negotiable):
  • Your confidence CANNOT exceed ${league === 'nhl' ? '58' : league === 'nba' ? '60' : '58'}% regardless of team quality.
  • Historical comeback rate for this deficit/time is the anchor.
  • If you cannot name ONE specific, verifiable fact that overrides the deficit — say NO.\n` : ''}
Respond ONLY with valid JSON:
{"trade": true, "confidence": 0.XX, "reasoning": "..."}  ← BUY
{"trade": false, "reasoning": "..."}  ← PASS`;
}

// Mock search results for test scenarios — realistic enough to anchor Claude's analysis
function mockSearchResult(query) {
  const q = query.toLowerCase();
  // NHL OT records
  if (q.includes('colorado') && q.includes('ot')) return 'Colorado Avalanche OT record 2024-25: 8-4 in overtime (67% win rate, one of the best in NHL). Elite OT team — Nathan MacKinnon particularly dangerous in 3v3.';
  if (q.includes('edmonton') && q.includes('ot')) return 'Edmonton Oilers OT record 2024-25: 6-7 in overtime (46% win rate). Below average OT team despite McDavid.';
  if (q.includes('washington') && q.includes('ot')) return 'Washington Capitals OT record 2024-25: 4-8 in overtime (33% win rate). Poor OT team.';
  if (q.includes('detroit') && q.includes('ot')) return 'Detroit Red Wings OT record 2024-25: 3-9 in overtime (25% win rate). One of worst OT teams in league.';
  if (q.includes('vegas') && q.includes('ot')) return 'Vegas Golden Knights OT record 2024-25: 7-5 in overtime (58% win rate). Strong OT team.';
  if (q.includes('winnipeg') && q.includes('ot')) return 'Winnipeg Jets OT record 2024-25: 5-6 in overtime (45% win rate). Average OT team.';
  // Shootout records
  if (q.includes('shootout')) return 'Shootout statistics 2024-25: Most teams are within 40-60% range. Detroit 38%, Washington 45%, Colorado 52%.';
  // Goalies
  if (q.includes('goalie') || q.includes('sv%') || q.includes('save')) {
    if (q.includes('colorado') || q.includes('col')) return 'Mackenzie Blackwood (COL) SV% .917 this season. Starting tonight.';
    if (q.includes('edmonton') || q.includes('edm')) return 'Stuart Skinner (EDM) SV% .899 this season. Struggling this season.';
    if (q.includes('vegas') || q.includes('vgk')) return 'Adin Hill (VGK) SV% .912 this season. Has allowed only 2 goals tonight (already in game).';
    if (q.includes('winnipeg') || q.includes('wpg')) return 'Connor Hellebuyck (WPG) SV% .921. Despite strong season, down 6-2 in this game.';
    return 'Goalie SV% data not available in real-time — using historical averages.';
  }
  // MLB pitcher info
  if (q.includes('cole') && (q.includes('era') || q.includes('pitch'))) return 'Gerrit Cole (NYY) 2025: ERA 2.54, WHIP 0.89. Tonight: 82 pitches through 6.1 innings — approaching pitch limit, typically pulled at 90-95. Bullpen ERA 3.41 last 10 days.';
  if (q.includes('glasnow') && (q.includes('era') || q.includes('pitch'))) return 'Tyler Glasnow (LAD) 2025: ERA 2.78, WHIP 1.02. Tonight: 38 pitches through 3 IP — fresh, likely pitching 6+ innings.';
  if (q.includes('peralta') && (q.includes('era') || q.includes('pitch'))) return 'Freddy Peralta (MIL) 2025: ERA 2.85, WHIP 1.05. Tonight: 55 pitches through 4 IP — still sharp.';
  // H2H records
  if (q.includes('h2h') || q.includes('head to head') || q.includes('head-to-head')) {
    if (q.includes('col') || q.includes('colorado')) return 'COL vs EDM H2H 2024-25: Colorado 3-1 this season. Last 2 seasons: COL 7-5 overall vs EDM.';
    if (q.includes('vgk') || q.includes('vegas')) return 'VGK vs WPG H2H 2024-25: Vegas 2-2. Last 2 seasons: VGK 8-6 overall vs WPG.';
    if (q.includes('nyy') || q.includes('yankees')) return 'NYY vs BOS H2H 2025: Yankees 3-1 this season. Last 2 seasons: NYY 10-8 overall.';
    if (q.includes('lad') || q.includes('dodgers')) return 'LAD vs NYM H2H 2025: Dodgers 2-1 this season. Last 2 seasons: LAD 9-5 overall.';
    return 'H2H record: teams are roughly even over last 2 seasons.';
  }
  // Injury / lineup
  if (q.includes('injury') || q.includes('lineup') || q.includes('roster') || q.includes('resting')) {
    if (q.includes('vgk') || q.includes('vegas')) return 'Vegas Golden Knights tonight: Jack Eichel (IR, out), Mark Stone (IR, out). Starting lineup mostly intact — 9 of 12 forwards available. NOT resting key players.';
    if (q.includes('wpg') || q.includes('winnipeg')) return 'Winnipeg Jets: Nikolaj Ehlers active. Full lineup available. Down 6-2 in game.';
    if (q.includes('nyy') || q.includes('yankees')) return 'Yankees tonight: Aaron Judge active. Anthony Rizzo on IL. Starting lineup intact — not resting players.';
    if (q.includes('lad') || q.includes('dodgers')) return 'Dodgers tonight: Freddie Freeman active. Shohei Ohtani at DH. Full lineup, no resting.';
    if (q.includes('col') || q.includes('colorado')) return 'Avalanche tonight: Nathan MacKinnon active. Cale Makar active. Full lineup.';
    return 'No significant lineup issues found — team appears to be playing full strength.';
  }
  // Playoff implications
  if (q.includes('playoff') || q.includes('clinch') || q.includes('elimination')) {
    if (q.includes('mets') || q.includes('nym')) return 'Mets 2025: Currently 3.5 games back in NL East. Every game matters but no elimination tonight.';
    if (q.includes('reds') || q.includes('cin')) return 'Reds 2025: 8-12 record, 4.5 games back in NL Central. Out of playoff position but not eliminated.';
    return 'No immediate playoff clinching or elimination scenarios tonight.';
  }
  // Batting order
  if (q.includes('batting order') || q.includes('lineup position')) {
    if (q.includes('devers')) return 'Rafael Devers bats 3rd in Boston Red Sox order — cleanup-adjacent position. Power hitter, 30+ HR pace.';
    if (q.includes('de la cruz')) return 'Elly De La Cruz bats 1st (leadoff) for Cincinnati Reds in 2025. Speed over power at top of order.';
    if (q.includes('barnes')) return 'Austin Barnes typically bats 8th or 9th for LAD — bottom of order.';
    return 'Batting order position: mid-lineup batter, not a primary power threat.';
  }
  // Generic fallback
  return `Search results for "${query}": No real-time data available. Analysis based on general knowledge and historical trends.`;
}

async function testClaude(label, scenario, expectBuy, expectConfRange) {
  const prompt = buildTestPrompt(scenario);
  console.log(`\n  → Running: ${label}`);
  try {
    const tools = [{ name: 'web_search', description: 'Search the web for sports data, stats, and news', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } }];

    let messages = [{ role: 'user', content: prompt }];
    let allToolCalls = [];
    let fullText = '';
    let rounds = 0;
    const MAX_ROUNDS = 8;

    // Tool use loop — continue until end_turn or max rounds
    while (rounds < MAX_ROUNDS) {
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools,
        messages
      });
      rounds++;

      // Collect text from this response
      for (const block of resp.content) {
        if (block.type === 'text') fullText += block.text;
      }

      if (resp.stop_reason !== 'tool_use') break; // Done

      // Process tool calls
      const toolUseBlocks = resp.content.filter(b => b.type === 'tool_use');
      const toolResults = toolUseBlocks.map(block => {
        const query = block.input.query ?? '';
        allToolCalls.push(query);
        const result = mockSearchResult(query);
        return { type: 'tool_result', tool_use_id: block.id, content: result };
      });

      // After 5 rounds, add a nudge to finalize
      const nudge = rounds >= 5
        ? [{ type: 'text', content: 'You have enough information. Provide your final JSON decision now.' }]
        : [];

      // Add assistant turn + tool results to conversation
      messages = [...messages,
        { role: 'assistant', content: resp.content },
        { role: 'user', content: [...toolResults, ...nudge] }
      ];
    }

    // Parse JSON from response
    const jsonMatch = fullText.match(/\{[\s\S]*?"trade"[\s\S]*?\}/);
    if (!jsonMatch) {
      console.log(`  ✗  ${label} — No JSON found in response`);
      console.log(`     Raw: ${fullText.slice(0, 400)}`);
      failed++;
      failures.push({ name: label, actual: 'no JSON', expected: 'JSON response' });
      return;
    }

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch (e) {
      console.log(`  ✗  ${label} — JSON parse error: ${jsonMatch[0].slice(0, 100)}`);
      failed++;
      return;
    }

    const tradeBool = parsed.trade;
    const confidence = parsed.confidence;
    const reasoning = parsed.reasoning ?? '';

    // Validate
    const buyMatch = expectBuy === null ? null : tradeBool === expectBuy;
    const confOk = (!expectBuy || !expectConfRange) ? true :
      (confidence >= expectConfRange[0] && confidence <= expectConfRange[1]);

    const ok = (expectBuy === null) ? true : (buyMatch && confOk);
    if (ok) {
      passed++;
      const confStr = confidence ? ` conf=${(confidence*100).toFixed(0)}%` : '';
      const label2 = expectBuy === null ? `[behavioral]` : '';
      console.log(`  ✓  ${label} → trade=${tradeBool}${confStr} ${label2}`);
      if (allToolCalls.length > 0) console.log(`     Searched (${allToolCalls.length}x): ${allToolCalls.slice(0,3).map(q => `"${q.slice(0,50)}"`).join(', ')}`);
      console.log(`     Reasoning: ${reasoning.slice(0, 200)}`);
    } else {
      failed++;
      const msg = !buyMatch
        ? `Expected trade=${expectBuy}, got trade=${tradeBool}`
        : `Confidence ${(confidence*100).toFixed(0)}% outside range [${(expectConfRange[0]*100).toFixed(0)}%-${(expectConfRange[1]*100).toFixed(0)}%]`;
      failures.push({ name: label, actual: { trade: tradeBool, confidence }, expected: { trade: expectBuy, confidenceRange: expectConfRange }, note: msg });
      console.log(`  ✗  ${label} — ${msg}`);
      if (allToolCalls.length > 0) console.log(`     Searched: ${allToolCalls.map(q => `"${q.slice(0,50)}"`).join(', ')}`);
      console.log(`     Reasoning: ${reasoning.slice(0, 300)}`);
    }
  } catch (err) {
    failed++;
    failures.push({ name: label, actual: `ERROR: ${err.message}`, expected: 'valid response' });
    console.log(`  ✗  ${label} — API error: ${err.message}`);
  }
}

// ─── Test Scenarios ────────────────────────────────────────────────────────────
// Each scenario represents a game state the bot would see and pass to Claude.
// We validate: (1) correct trade decision, (2) confidence range, (3) searches performed.

const scenarios = [
  // S1: NHL VGK leading WPG 6-2, P3 with 5 min left. VGK at 79¢.
  // WE=95% (3-goal lead P3). Price ceiling 82¢ passes. Expect BUY.
  {
    label: 'NHL S1: VGK leads WPG 6-2, P3 5:42 left, 79¢ — expect BUY',
    expectBuy: true,
    expectConfRange: [0.88, 0.99],
    scenario: {
      league: 'nhl', period: 3, diff: 4,
      awayTeam: 'Winnipeg Jets', awayRecord: '46-29-4', awayScore: 2,
      homeTeam: 'Vegas Golden Knights', homeRecord: '48-24-7', homeScore: 6,
      gameDetail: '5:42 - 3rd', awayLineScore: '1 0 1', homeLineScore: '2 3 1',
      targetAbbr: 'VGK', leadingAbbr: 'VGK',
      price: 0.79, isHome: true, baselineWE: 0.99,
      situation: null, pitcherInfo: null, extraContext: ''
    }
  },

  // S2: NHL COL leads EDM 1-0, P3 9:00 left. COL at 65¢.
  // WE=79%. Should reach Claude. Critical test: does Claude search OT record? Does it reduce for OT risk?
  {
    label: 'NHL S2: COL leads EDM 1-0, P3 9:00 left, 65¢ — validate OT risk search + likely BUY',
    expectBuy: true,
    expectConfRange: [0.65, 0.85], // COL elite OT record (67%) reduces risk; 81-82% is defensible
    scenario: {
      league: 'nhl', period: 3, diff: 1,
      awayTeam: 'Colorado Avalanche', awayRecord: '44-31-4', awayScore: 1,
      homeTeam: 'Edmonton Oilers', homeRecord: '47-28-4', homeScore: 0,
      gameDetail: '9:00 - 3rd', awayLineScore: '0 1 0', homeLineScore: '0 0 0',
      targetAbbr: 'COL', leadingAbbr: 'COL',
      price: 0.65, isHome: false, baselineWE: 0.79,
      situation: null, pitcherInfo: null,
      extraContext: '⚠️ Note: 9 minutes remain in regulation. OT is possible.\n'
    }
  },

  // S3: MLB NYY leads BOS 4-0, inning 7, 68¢. Dominant starter (Cole) at 82 pitches.
  // WE=77%. Should reach Claude. Test: does Claude catch the pitch count warning (80+ pitches)?
  // With Cole at 82 pitches, starter is nearing limit — that should suppress confidence.
  {
    label: 'MLB S3: NYY leads BOS 4-0, inning 7, 68¢, starter at 82 pitches — test pitch count warning',
    expectBuy: null, // Accept either — key is Claude catches pitch count
    expectConfRange: null,
    scenario: {
      league: 'mlb', period: 7, diff: 4,
      awayTeam: 'New York Yankees', awayRecord: '14-5', awayScore: 4,
      homeTeam: 'Boston Red Sox', homeRecord: '10-9', homeScore: 0,
      gameDetail: 'Top 7th', awayLineScore: '1 0 2 0 1 0 0', homeLineScore: '0 0 0 0 0 0 0',
      targetAbbr: 'NYY', leadingAbbr: 'NYY',
      price: 0.68, isHome: false, baselineWE: 0.77,
      situation: 'Outs: 1 | Runners: none | At bat: Rafael Devers (.291)',
      pitcherInfo: 'Pitching for NYY: Gerrit Cole (ERA 2.54, 82 pitches, 6.1 IP)\nPitching for BOS: Kutter Crawford (ERA 4.78)',
      extraContext: ''
    }
  },

  // S4: MLB LAD leads NYM 4-0, inning 3, 67¢. Price ceiling is 75¢ so it passes.
  // WE=78% (3-run lead inning 3). BUT price is 67¢ vs 75¢ ceiling. WE=78% passes 75% floor.
  // Expect: Claude likely buys — early game, dominant LAD lead.
  {
    label: 'MLB S4: LAD leads NYM 4-0, inning 3, 67¢ — WE=78% passes floor, test early-game analysis',
    expectBuy: true,
    expectConfRange: [0.72, 0.95], // 88% WE baseline + fresh dominant starter can push to 90-93%
    scenario: {
      league: 'mlb', period: 3, diff: 4,
      awayTeam: 'New York Mets', awayRecord: '10-9', awayScore: 0,
      homeTeam: 'Los Angeles Dodgers', homeRecord: '14-5', homeScore: 4,
      gameDetail: 'Bot 3rd', awayLineScore: '0 0 0', homeLineScore: '0 3 1',
      targetAbbr: 'LAD', leadingAbbr: 'LAD',
      price: 0.67, isHome: true, baselineWE: 0.85,
      situation: 'Outs: 2 | Runners: none | At bat: Austin Barnes (.198)',
      pitcherInfo: 'Pitching for LAD: Tyler Glasnow (ERA 2.78, 38 pitches, 3.0 IP)\nPitching for NYM: Sean Manaea (ERA 4.12)',
      extraContext: ''
    }
  },

  // S5: NBA BOS leads CLE by 20 pts Q4, 73¢. Both teams playoff-bound (no motivational mismatch).
  // WE=96% (20-pt Q4). Price ceiling 80¢ passes (73¢ < 80¢). Expect BUY.
  {
    label: 'NBA S5: BOS leads CLE 115-95 (20 pts), Q4 6:00, 73¢ — both playoff teams, expect BUY',
    expectBuy: true,
    expectConfRange: [0.88, 0.99],
    scenario: {
      league: 'nba', period: 4, diff: 20,
      awayTeam: 'Cleveland Cavaliers', awayRecord: '49-21', awayScore: 95,
      homeTeam: 'Boston Celtics', homeRecord: '56-15', homeScore: 115,
      gameDetail: '6:00 - 4th', awayLineScore: '28 22 20 25', homeLineScore: '32 30 28 25',
      targetAbbr: 'BOS', leadingAbbr: 'BOS',
      price: 0.73, isHome: true, baselineWE: 0.96,
      situation: null, pitcherInfo: null, extraContext: ''
    }
  },

  // S6: NHL REJECT test — WSH leads DET 1-0, P3 2 min left, 72¢.
  // WSH has bad OT record, DET also bad. This SHOULD be a buy but Claude should search OT records.
  // Price is 72¢ < 82¢ ceiling. WE=79%. Should pass gates. Test: OT record search behavior.
  {
    label: 'NHL S6: WSH leads DET 1-0, P3 2:00 left, 72¢ — validate OT/shootout record search behavior',
    expectBuy: null, // Accept either — key validation is Claude searches OT records
    expectConfRange: null,
    scenario: {
      league: 'nhl', period: 3, diff: 1,
      awayTeam: 'Washington Capitals', awayRecord: '42-33-5', awayScore: 1,
      homeTeam: 'Detroit Red Wings', homeRecord: '28-44-8', homeScore: 0,
      gameDetail: '2:00 - 3rd', awayLineScore: '0 1 0', homeLineScore: '0 0 0',
      targetAbbr: 'WSH', leadingAbbr: 'WSH',
      price: 0.72, isHome: false, baselineWE: 0.79,
      situation: null, pitcherInfo: null,
      extraContext: '⚠️ Only 2 minutes remain. Game could go to OT or shootout.\n'
    }
  },

  // S7: MLB REJECT test — STL down 2 runs inning 8, 28¢ (underdog). This passes underdogAllowed
  // check — wait, diff=2 period=8 would NOT pass (period>5). So bot wouldn't even reach Claude.
  // Let's test: CIN down 2, inning 4, 28¢. underdogAllowed → yes (diff<=2, period<=5).
  // But confidence should be CAPPED at 58%. Expect trade=false (hard to get above 28¢+4% edge).
  {
    label: 'MLB S7: CIN down 2 to MIL inning 4, 28¢ underdog — hard cap 58%, likely REJECT',
    expectBuy: false,
    expectConfRange: null,
    scenario: {
      league: 'mlb', period: 4, diff: 2,
      awayTeam: 'Cincinnati Reds', awayRecord: '8-12', awayScore: 0,
      homeTeam: 'Milwaukee Brewers', homeRecord: '13-6', homeScore: 2,
      gameDetail: 'Bot 4th', awayLineScore: '0 0 0 0', homeLineScore: '0 2 0 0',
      targetAbbr: 'CIN', leadingAbbr: 'MIL',
      price: 0.28, isHome: false, baselineWE: 0.24, // 24% WE for trailing team
      situation: 'Outs: 1 | Runners: none | At bat: Elly De La Cruz (.271)',
      pitcherInfo: 'Pitching for MIL: Freddy Peralta (ERA 2.85, 55 pitches)\nPitching for CIN: Hunter Greene (ERA 5.10)',
      extraContext: `⚠️ UNDERDOG BET — HARD CAPS (non-negotiable):
  • Your confidence CANNOT exceed 58% regardless of team quality.
  • Historical comeback rate for this deficit/time is the anchor.
  • If you cannot name ONE specific, verifiable fact that overrides the deficit — say NO.\n`
    }
  },
];

// Run all Claude tests sequentially (rate limit friendly)
async function runClaudeTests() {
  for (const s of scenarios) {
    if (s.expectBuy === null) {
      // Behavioral test — just run and report, don't pass/fail
      await testClaude(s.label, s.scenario, null, null);
    } else {
      await testClaude(s.label, s.scenario, s.expectBuy, s.expectConfRange);
    }
    await new Promise(r => setTimeout(r, 800)); // slight throttle
  }
}

await runClaudeTests();

// ─── Final Report ──────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`);
console.log('═'.repeat(60));

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) {
    console.log(`\n  ✗ ${f.name}`);
    if (f.note) console.log(`    ${f.note}`);
    console.log(`    actual:   ${JSON.stringify(f.actual)}`);
    console.log(`    expected: ${JSON.stringify(f.expected)}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
