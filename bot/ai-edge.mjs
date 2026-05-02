/**
 * Arbor Prediction Trading Bot
 *
 * Autonomous sports prediction engine for Kalshi + Polymarket.
 * Uses Claude (Haiku screen → Sonnet + web search decide) to predict
 * game winners and buy contracts on the cheaper platform.
 *
 * Pipeline (every 60 seconds):
 *   1. Pre-game: Scan today's games, predict winners, buy at 25-85¢
 *   2. Live: Monitor ESPN scores, predict winners of games with leads
 *   3. Cross-platform: Compare Kalshi vs Poly prices, buy cheaper
 *   4. Resolution: Buy winning sides of settled games below $1 (risk-free)
 *   5. Stop-loss: Sell Kalshi positions down >30% from entry
 *
 * Risk controls: dynamic sizing (10% of bankroll), 15% daily loss halt,
 * 5-consecutive-loss reducer, 85¢ max price, 65% min confidence,
 * 5% confidence-over-price margin, sport exposure caps.
 *
 * Run: node ai-edge.mjs
 */

import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { getBullpenStats, formatBullpenLine, bullpenTier, logBullpenLookup } from './bullpen-stats.mjs';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants } from 'crypto';
import 'dotenv/config';

// ─────────────────────────────────────────────────────────────────────────────
// Time Helpers — everything in ET, never raw UTC
// ─────────────────────────────────────────────────────────────────────────────

function etNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function etTodayStr() {
  const d = etNow();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function etHour() { return etNow().getHours(); }

// Centralized cross-sport contamination guard. Catches cases like:
//   - MLS DAL@MIN ticker analyzed with NHL terms (Wallstedt, Hintz, "period")
//   - NBA ticker where reasoning cites pitchers / innings
// `expectedSport` is one of 'MLB' | 'NBA' | 'NHL' | 'SOCCER' | 'NFL'
// Returns the offending term (string) if mismatch detected, else null.
function detectWrongSport(expectedSport, reasoningRaw) {
  const r = (reasoningRaw ?? '').toLowerCase();
  if (!r) return null;
  const has = (...terms) => terms.find(t => r.includes(t)) ?? null;
  const sport = String(expectedSport ?? '').toUpperCase();
  if (sport === 'MLB') {
    return has(' nba', ' nhl', 'basketball', 'hockey', 'goalie', 'power play', 'faceoff', 'puck', 'world series winner', 'quarter', 'touchdown');
  }
  if (sport === 'NBA') {
    return has(' mlb', ' nhl', 'pitcher', 'era ', 'inning', 'goalie', 'puck', 'power play', 'faceoff', 'touchdown', 'halftime match', 'stoppage time');
  }
  if (sport === 'NHL') {
    return has(' nba', ' mlb', 'pitcher', 'basketball', 'inning', 'era ', 'touchdown', 'stoppage time', 'corner kick', 'yellow card', 'red card');
  }
  if (sport === 'SOCCER' || sport === 'MLS' || sport === 'EPL' || sport === 'LALIGA' || sport === 'SERIEA' || sport === 'BUNDESLIGA' || sport === 'LIGUE1') {
    // Soccer matchups must NOT cite hockey/basketball/baseball terminology.
    return has('goalie', 'power play', 'faceoff', 'puck', 'hat trick', 'period', 'pitcher', 'inning', 'era ', 'bullpen', 'quarter', 'three-pointer', 'free throw', 'rebound', 'touchdown', 'wallstedt', 'hintz', 'oettinger');
  }
  if (sport === 'NFL') {
    return has(' nba', ' mlb', ' nhl', 'pitcher', 'inning', 'goalie', 'puck', 'three-pointer');
  }
  return null;
}
function etTimestamp() {
  const d = etNow();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
// Override console.log to prefix with ET timestamp
const _origLog = console.log;
const _origErr = console.error;
console.log = (...args) => _origLog(etTimestamp() + ':', ...args);
console.error = (...args) => _origErr(etTimestamp() + ':', ...args);

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_API_KEY = process.env.KALSHI_API_KEY_ID ?? '';
const KALSHI_REST = 'https://api.elections.kalshi.com/trade-api/v2';
const ANTHROPIC_KEY = process.env.VITE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_DECIDER = 'gpt-5'; // GPT-5 — Sonnet-4.5-equivalent reasoning + structured output
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID ?? '';

// DRY RUN MODE: Run full pipeline but don't place real orders.
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
if (DRY_RUN) console.log('🧪 DRY RUN MODE — no real orders will be placed');

// KALSHI ONLY MODE: Skip all Polymarket trading. Capital consolidating to Kalshi.
const KALSHI_ONLY = process.env.KALSHI_ONLY !== 'false'; // default: true
if (KALSHI_ONLY) console.log('📊 KALSHI ONLY — Polymarket trading disabled');

// PRE-GAME LIVE MODE: When true, pre-game picks place real Kalshi orders.
// When false, all pre-game picks are paper-logged only (calibration mode).
const PREGAME_LIVE = process.env.PREGAME_LIVE !== 'false'; // default ON
if (PREGAME_LIVE) console.log('🎯 PRE-GAME LIVE — real pre-game orders enabled');
else console.log('📋 PRE-GAME PAPER — pre-game picks are paper-only (calibration mode)');

const MIN_CONFIDENCE = 0.70;      // Claude must be ≥70% confident to trade (was 0.65 — data showed 65-70% bucket was 14% WR, -$78)
const CONFIDENCE_MARGIN = 0.03;   // LEGACY flat margin — only used for draw bets + fallback

// Calibration overrides — generated by suggest.mjs from accumulated trade history.
// Allows per-sport threshold tuning without editing this file.
// Run: node bot/suggest.mjs --apply   then: pm2 restart arbor-ai
let CAL = {};
try {
  CAL = JSON.parse(readFileSync('./calibration-overrides.json', 'utf-8'));
  const n = CAL._tradesAnalyzed ?? '?';
  console.log(`[calibration] Loaded overrides from calibration-overrides.json (${n} trades analyzed)`);
} catch { /* no overrides file — all defaults apply */ }

// ─────────────────────────────────────────────────────────────────────────────
// Calibration helpers — consume CAL overrides written by suggest.mjs
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if calibration auto-disabled this strategy for a sustained -EV run.
 *  NOTE: The primary `isStrategyDisabled()` (defined later) covers UI control disables.
 *  This one is merged into that function below — do not call directly.
 */
function isStrategyAutoDisabledByCAL(strategy) {
  return Array.isArray(CAL.disabledStrategies) && CAL.disabledStrategies.includes(strategy);
}

/** Tag-credibility evaluation. Reads CAL.reasoningTagStats (auto-collected daily)
 *  and returns the worst (lowest Wilson lower-bound) tag found in the trade's
 *  reasoning_tags array. Used to BLOCK trades that cite reasoning tags with
 *  poor historical hit rates (e.g., starter-mismatch 1/9, bullpen-mismatch 1/5).
 *
 *  Why this matters: auto-calibration has been quietly collecting this data for
 *  weeks but never used it for trade decisions. Tags with statistical signal
 *  (n ≥ 5) AND ciLo < 0.25 represent edge sources that have been catastrophically
 *  wrong — Sonnet citing them is a yellow flag. Blocking these saves real money.
 *
 *  Returns null if all tags are clean / not enough data; returns { tag, stats }
 *  for the worst-offending tag if blocking is warranted.
 */
function evaluateTagCredibility(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  const stats = CAL.reasoningTagStats;
  if (!stats) return null;
  let worst = null;
  for (const tag of tags) {
    const s = stats[tag];
    if (!s || (s.n ?? 0) < 5) continue; // need statistical signal
    if ((s.ciLo ?? 0) < 0.25) {
      if (!worst || s.ciLo < worst.stats.ciLo) {
        worst = { tag, stats: s };
      }
    }
  }
  return worst;
}

/** Inverse of evaluateTagCredibility — when reasoning_tags reference HIGH-credibility
 *  tags (Wilson lower-CI ≥ 0.55, n ≥ 20), apply a small sizing boost. Discovered
 *  via shadow data 2026-04-27: `we-undervalued` (39 samples, 67% WR) and `market-lag`
 *  (44 samples, 61% WR) consistently outperform their cohorts. Boost factor capped
 *  at 1.15 to avoid runaway sizing on any single signal.
 *  Returns multiplier in [1.0, 1.15]. */
/** Pre-game tag gate — pre-game-prediction has lost money across MLB/NBA/NHL/MLS
 *  with Sonnet's generic "team X is better" reasoning. Only certain tags have
 *  >55% WR with statistically meaningful samples:
 *    - playoff-home-fav: 75% WR (n=8)
 *    - we-undervalued: 67% WR (n=39)
 *    - market-lag: 61% WR (n=44)
 *    - injury-news: lineup-driven, sample small but logically high-edge
 *  Bad tags (BLOCKED via evaluateTagCredibility):
 *    - starter-mismatch: 17% WR (n=6)
 *    - lineup-cold: 40% WR (n=15)
 *    - era-gap (alone): mediocre, often "thin edge" trap
 *  Returns true if at least one APPROVED edge tag is present.
 *  Use to gate pre-game trades — without proven edge tag, reject. */
function hasProvenPregameEdgeTag(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  // Updated 2026-04-29 from full game-level dedup audit (n=601 shadows, 12+ unique games per tag):
  //   REMOVED line-movement: 8 games game-level → 50% gWR, -15% EV (was wrongly added 4/28)
  // Banned (NEW explicit list, in addition to auto-cal blocking):
  //   bullpen-mismatch: 7 games game-level → 43% gWR, -25% EV
  //   lineup-cold: 12 games → 50% gWR, -15% EV
  //   starter-mismatch: 5 games → 20% gWR, -54% EV (catastrophic)
  const APPROVED = new Set([
    'playoff-home-fav',  // 6 games gWR 67%, +2% EV
    'we-undervalued',    // 26 games gWR 65%, +0.7% EV
    'market-lag',        // 28 games gWR 64%, +1.7% EV (highest sample)
    'injury-news',       // matches lineup-change pattern
    'public-fade',       // structurally documented
    'momentum-shift',    // 5 games gWR 60%, +3.4% EV (small but +EV)
  ]);
  return tags.some(t => typeof t === 'string' && APPROVED.has(t.toLowerCase().trim()));
}

/** Hard-banned tags — even if other approved tags also present, reject if these
 *  appear. Prevents "stack a bad tag with a good one to sneak through" gaming. */
function hasHardBannedPregameTag(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  const BANNED = new Set([
    'bullpen-mismatch',  // 43% gWR -25% EV (n=7 games)
    'starter-mismatch',  // 20% gWR -54% EV (n=5 games) — worst offender
    'lineup-cold',       // 50% gWR -15% EV (n=12 games)
  ]);
  return tags.some(t => typeof t === 'string' && BANNED.has(t.toLowerCase().trim()));
}

function evaluateTagBoost(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return 1.0;
  const stats = CAL.reasoningTagStats;
  if (!stats) return 1.0;
  let bestBoost = 1.0;
  for (const tag of tags) {
    const s = stats[tag];
    if (!s || (s.n ?? 0) < 20) continue;
    const ciLo = s.ciLo ?? 0;
    if (ciLo >= 0.60) bestBoost = Math.max(bestBoost, 1.15);
    else if (ciLo >= 0.55) bestBoost = Math.max(bestBoost, 1.10);
    else if (ciLo >= 0.50) bestBoost = Math.max(bestBoost, 1.05);
  }
  return bestBoost;
}

/** Tag-credibility prompt feedback. Surfaces the auto-collected reasoning_tag
 *  stats to Claude so it AVOIDS citing tags with bad historical hit rates as
 *  edge sources. Only includes tags with n ≥ 5 (statistical signal).
 */
function getReasoningTagFeedback() {
  const stats = CAL.reasoningTagStats;
  if (!stats) return '';
  const meaningful = Object.entries(stats)
    .filter(([_, s]) => (s.n ?? 0) >= 5)
    .sort((a, b) => (b[1].n ?? 0) - (a[1].n ?? 0));
  if (meaningful.length === 0) return '';
  const lines = meaningful.map(([tag, s]) => {
    const wr = Math.round((s.winRate ?? 0) * 100);
    const ciLo = Math.round((s.ciLo ?? 0) * 100);
    const verdict = s.ciLo > 0.55 ? '✅ STRONG'
                  : s.ciLo > 0.40 ? '⚠️ marginal'
                  : s.ciLo > 0.25 ? '⚠️ WEAK'
                  : '❌ DON\'T cite this as edge source';
    return `  ${tag}: ${s.wins}/${s.n} (${wr}% WR, Wilson lower ${ciLo}%) — ${verdict}`;
  }).join('\n');
  return `═══ YOUR REASONING TAG TRACK RECORD ═══\n${lines}\nIf your edge_argument leans on a ❌ tag, your edge is unlikely to hold. Pick a different edge_source or pass.\n`;
}

/** Tier 1: Per-sport/playoff exit thresholds from CAL. Strategy-specific overrides
 *  layer on top when present (only the fields CAL actually emits — usually only
 *  when bad-stop rate ≥30% triggered a loosening). Falls back to caller defaults. */
function getCALExitThresholds(sport, isPlayoff, defaults, strategy) {
  const bucket = isPlayoff ? 'playoff' : 'regular';
  const sportCal = CAL.exitThresholds?.[sport?.toLowerCase?.()]?.[bucket] ?? {};
  const stratCal = strategy ? (CAL.exitThresholds?._byStrategy?.[strategy] ?? {}) : {};
  return {
    weFloor: stratCal.weFloor ?? sportCal.weFloor ?? defaults.weFloor,
    profitTake: stratCal.profitTake ?? sportCal.profitTake ?? defaults.profitTake,
    weDrop: stratCal.weDrop ?? sportCal.weDrop ?? defaults.weDrop,
  };
}

/** Tier 2: Per-sport Kelly fraction (0.25–0.50). Returns 0.50 if uncalibrated.
 *  Post-drawdown haircut: after a circuit-breaker trip, halve Kelly for 72h to
 *  reduce variance during recovery (anti-martingale).
 *  CLV haircut: if 7-day CLV is materially negative (below −1¢ with n≥30), halve
 *  Kelly. CLV is the truth-meter for edge — sustained negative CLV means we're
 *  systematically getting worse prices than the close, even if WR looks OK. */
function getKellyFraction(sport) {
  const f = CAL.kellyFraction?.[sport?.toLowerCase?.()];
  let base = (typeof f === 'number' && f > 0 && f <= 0.50) ? f : 0.50;
  // 2026-04-30: NHL halved permanently. Shadow data over 40 trades shows -$34.79
  // net at 41% WR (live-prediction) — market systematically overprices NHL leaders
  // (1-goal P2/P3 leads convert 56-59% historically at 71-78¢ market price).
  // Half sizing while we figure out the +EV path; remove this when NHL net positive.
  if (sport?.toLowerCase?.() === 'nhl') base *= 0.5;
  if (typeof kellyHaircutUntilMs === 'number' && kellyHaircutUntilMs > Date.now()) {
    base *= 0.5;
  }
  // CLV-based haircut — only fires once we have enough data (n≥30) to be confident
  try {
    if (typeof getClvStats === 'function') {
      const clv7 = getClvStats({ days: 7 });
      if (clv7?.all && clv7.all.n >= 30 && clv7.all.avgClv < -0.01) {
        base *= 0.5;
      }
    }
  } catch { /* CLV haircut is best-effort */ }
  return base;
}

/** Tier 2: Partial-take target price for sport/playoff (null = use existing logic). */
function getPartialTakePrice(sport, isPlayoff) {
  const bucket = isPlayoff ? 'playoff' : 'regular';
  return CAL.partialTakePrice?.[sport?.toLowerCase?.()]?.[bucket] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rolling Calibration Feedback — tells Claude its own recent track record
// Refreshed every 2 hours, injected into live-edge + pre-game prompts.
// ─────────────────────────────────────────────────────────────────────────────
let calibrationFeedback = '';
let lastCalFeedbackAt = 0;
const CAL_FEEDBACK_INTERVAL = 2 * 60 * 60 * 1000;

function computeCalibrationFeedback() {
  if (!existsSync(TRADES_LOG)) return '';
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    // Adaptive window: start at 7d (regime-relevant — bot is actively tuned);
    // expand per-sport up to 21d if a sport has <10 samples so low-volume sports
    // (e.g. pre-game-edge-first on playoff NHL) still get calibration signal.
    // Window is applied later per-sport; here we grab the widest (21d) pool and
    // each sport filters down to its own cutoff.
    const WINDOWS = [7, 14, 21]; // days
    const maxCutoff = Date.now() - WINDOWS[WINDOWS.length - 1] * 864e5;
    // Use PICK ACCURACY (gameOutcome) not trade P&L. Stopped-out winners (BUF/VGK)
    // should count as correct picks, since calibration is about prediction skill,
    // not stop-loss timing. Fall back to P&L only when gameOutcome is missing.
    const settledRaw = trades.filter(t =>
      (t.status === 'settled' || t.status?.startsWith('sold-')) &&
      t.confidence != null &&
      (t.gameOutcome === 'correct' || t.gameOutcome === 'incorrect' || t.realizedPnL != null) &&
      new Date(t.settledAt ?? t.timestamp).getTime() > maxCutoff
    );
    // GAME DEDUPE: multiple bets on the same game side are 1 correlated outcome,
    // not N independent samples. Collapse to one trade per (marketBase, side) —
    // pick the earliest so the confidence reflects the initial read, not a scale-in.
    // Without this, 8 live bets on BHA → 8 "losses" if BHA drew, inflating sample
    // size and letting one unlucky game dominate band verdicts.
    const gameSeen = new Map();
    for (const t of settledRaw) {
      const gKey = `${t.marketBase ?? t.ticker ?? ''}|${t.side ?? 'yes'}`;
      const existing = gameSeen.get(gKey);
      const tTs = new Date(t.timestamp ?? t.settledAt).getTime();
      if (!existing || tTs < new Date(existing.timestamp ?? existing.settledAt).getTime()) {
        gameSeen.set(gKey, t);
      }
    }
    const settledAll = [...gameSeen.values()];
    if (settledAll.length < 10) return '';

    // Tag sport + phase + side on each trade.
    // phase: pre-game vs live (from strategy). side: dog (<50¢) vs fav (≥50¢).
    // Blended feedback hid today's failure — MLB live 8-2 + MLB pre-game 0-6 → 50% overall.
    // Claude saw "MLB calibrated" when pre-game/dog was broken. Split fixes that.
    for (const t of settledAll) {
      const tk = (t.ticker ?? '').toUpperCase();
      t._sport = t.league ?? (tk.includes('NHL') ? 'nhl' : tk.includes('NBA') ? 'nba' : tk.includes('MLB') ? 'mlb' : tk.includes('MLS') ? 'mls' : tk.includes('EPL') ? 'epl' : tk.includes('LALIGA') ? 'laliga' : null);
      t._ts = new Date(t.settledAt ?? t.timestamp).getTime();
      t._phase = (t.strategy ?? '').startsWith('pre-game') ? 'pre' : 'live';
      t._side = (t.entryPrice ?? 0.5) < 0.50 ? 'dog' : 'fav';
      t._isShadow = false;
    }

    // SHADOW DATA INTEGRATION (Phase 3): merge settled shadow decisions into the same buckets.
    // Each shadow record adds to the same (sport × phase × side × confidence band) bucket but
    // is tagged so we can show "REAL X + SHADOW Y" separately to Claude. Wilson bounds tighten
    // naturally as combined n grows. Shadow-only Brier helps detect drift between live trading
    // calibration and unbet decision calibration.
    if (existsSync(SHADOW_DECISIONS_LOG)) {
      try {
        const shadowLines = readFileSync(SHADOW_DECISIONS_LOG, 'utf-8').split('\n').filter(l => l.trim());
        const shadowRecords = shadowLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        // Only settled shadow records, within window, with valid confidence
        for (const sr of shadowRecords) {
          if (sr.status !== 'settled') continue;
          if (sr.claudeConfidence == null || sr.ourPickWon == null) continue;
          const settledMs = sr.settledAt ? Date.parse(sr.settledAt) : 0;
          if (settledMs < maxCutoff) continue;
          // Convert shadow → trade-like record for the same bucket pipeline
          settledAll.push({
            ticker: sr.ticker,
            confidence: sr.claudeConfidence,
            entryPrice: sr.decisionPrice,
            gameOutcome: sr.ourPickWon ? 'correct' : 'incorrect',
            strategy: sr.stage === 'live-edge' ? 'live-prediction-shadow' : 'pre-game-prediction-shadow',
            settledAt: sr.settledAt,
            timestamp: sr.ts,
            _sport: sr.league ?? (sr.sport === 'NBA' ? 'nba' : sr.sport === 'MLB' ? 'mlb' : sr.sport === 'NHL' ? 'nhl' : 'soccer'),
            _ts: settledMs,
            _phase: 'live', // shadow is always from live-edge currently
            _side: (sr.decisionPrice ?? 0.5) < 0.50 ? 'dog' : 'fav',
            _isShadow: true,
          });
        }
      } catch { /* shadow file optional */ }
    }

    // Adaptive per-sport window, then split by (phase, side) combo → buckets.
    // Buckets now include 58-64% to cover edge-first tier bets (previously below all buckets).
    const sportData = {};
    const sportWindows = {};
    const now = Date.now();
    for (const sport of new Set(settledAll.map(t => t._sport).filter(Boolean))) {
      let chosen = null;
      for (const days of WINDOWS) {
        const cutoff = now - days * 864e5;
        const subset = settledAll.filter(t => t._sport === sport && t._ts > cutoff);
        if (subset.length >= 10 || days === WINDOWS[WINDOWS.length - 1]) {
          chosen = { days, subset };
          if (subset.length >= 10) break;
        }
      }
      if (!chosen) continue;
      sportWindows[sport] = chosen.days;
      const combos = {};
      for (const t of chosen.subset) {
        const won = t.gameOutcome ? t.gameOutcome === 'correct' : (t.realizedPnL ?? 0) > 0;
        const band = t.confidence < 0.65 ? '58-64' : t.confidence < 0.70 ? '65-69' : t.confidence < 0.75 ? '70-74' : '75+';
        const comboKey = `${t._phase}/${t._side}`;
        if (!combos[comboKey]) combos[comboKey] = { buckets: {}, totalW: 0, totalL: 0, totalShadowW: 0, totalShadowL: 0 };
        const c = combos[comboKey];
        // Track real vs shadow separately at total + bucket level for transparent output
        if (t._isShadow) {
          c[won ? 'totalShadowW' : 'totalShadowL']++;
        } else {
          c[won ? 'totalW' : 'totalL']++;
        }
        if (!c.buckets[band]) c.buckets[band] = { w: 0, l: 0, sw: 0, sl: 0, entrySum: 0, n: 0, pmHits: 0, pmTracked: 0 };
        if (t._isShadow) {
          c.buckets[band][won ? 'sw' : 'sl']++;
        } else {
          c.buckets[band][won ? 'w' : 'l']++;
          // Price-move tracking — only on real trades, only when MFE was recorded.
          // Trades placed before MFE shipped have null maxFavorableMove (excluded).
          if (t.maxFavorableMove != null) {
            c.buckets[band].pmTracked++;
            if (t.maxFavorableMove >= 0.05) c.buckets[band].pmHits++;
          }
        }
        c.buckets[band].entrySum += t.entryPrice ?? 0.5;
        c.buckets[band].n++;
      }
      sportData[sport] = combos;
    }

    // Verdicts per (sport, phase/side, bucket). For 58-64% bucket, compare WR to
    // average entry price (that's the breakeven — edge-first buys cheap). For
    // higher buckets, compare to band floor as before.
    const bandLower = { '65-69': 65, '70-74': 70, '75+': 75 };
    const lines2 = [];
    for (const [sport, combos] of Object.entries(sportData)) {
      const winTag = sportWindows[sport] ? ` [${sportWindows[sport]}d]` : '';
      const comboLines = [];
      for (const combo of ['pre/dog', 'pre/fav', 'live/dog', 'live/fav']) {
        const c = combos[combo];
        if (!c) continue;
        const totalN = c.totalW + c.totalL;
        if (totalN < 3) continue;
        const wr = Math.round((c.totalW / totalN) * 100);
        const bucketLines = [];
        for (const band of ['58-64', '65-69', '70-74', '75+']) {
          const b = c.buckets[band];
          if (!b || b.n < 3) continue;
          const realN = b.w + b.l;
          const shadowN = (b.sw ?? 0) + (b.sl ?? 0);
          const totalN = realN + shadowN;
          const totalW = b.w + (b.sw ?? 0);
          const bWR = totalN > 0 ? Math.round((totalW / totalN) * 100) : 0;
          const floor = band === '58-64' ? Math.round((b.entrySum / b.n) * 100) : bandLower[band];
          // Wilson 95% lower bound — combined n shrinks the bound, giving stronger signal
          // Combined uses real+shadow; reported separately so Claude sees the source split.
          const wilsonLowerBound = (w, n) => {
            if (n === 0) return 0;
            const p = w / n;
            const z = 1.96;
            const denom = 1 + z*z/n;
            return Math.max(0, Math.round(((p + z*z/(2*n) - z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / denom) * 100));
          };
          // Combine real + shadow for the verdict (more samples = tighter bounds).
          let verdict;
          const sourceLabel = shadowN > 0
            ? `REAL ${b.w}W/${b.l}L + SHADOW ${b.sw ?? 0}W/${b.sl ?? 0}L`
            : `${b.w}W/${b.l}L`;
          if (totalN < 5) {
            verdict = `n=${totalN} TOO FEW — ignore (Wilson lower bound spans 20-90%)`;
          } else if (totalN < 10) {
            verdict = `${sourceLabel} on small n=${totalN} (Wilson lower ${wilsonLowerBound(totalW, totalN)}%) — treat with caution, don't over-anchor`;
          } else if (bWR >= floor + 5) verdict = `CRUSHING at ${bWR}% vs ${floor}% (n=${totalN}) — underconfident here`;
          else if (bWR >= floor) verdict = `calibrated at ${bWR}% vs ${floor}% (n=${totalN}) — trust reads`;
          else if (bWR >= floor - 5) verdict = `within tolerance at ${bWR}% vs ${floor}% (n=${totalN})`;
          else if (bWR >= floor - 15) verdict = `underperforming at ${bWR}% vs ${floor}% (n=${totalN}) — trim ~${Math.min(8, floor - bWR)}pts`;
          else verdict = `LOSING at ${bWR}% vs ${floor}% (n=${totalN}) — require much stronger evidence or skip this combo`;
          // Tier 1.5 — once we have ≥20 real trades with MFE in this bucket, append
          // price-move WR ("did the model find a real mispricing?") alongside game WR.
          // This is informational; the verdict above still uses game WR. Helps Claude
          // see when game outcomes flipped on trades the price *did* move toward.
          let pmSuffix = '';
          if ((b.pmTracked ?? 0) >= 20) {
            const pmWR = Math.round((b.pmHits / b.pmTracked) * 100);
            pmSuffix = ` | price-move ≥5¢: ${b.pmHits}/${b.pmTracked} (${pmWR}%)`;
          }
          bucketLines.push(`    ${band}%: ${sourceLabel}${pmSuffix} — ${verdict}`);
        }
        if (bucketLines.length === 0) {
          comboLines.push(`  ${combo}: ${c.totalW}W/${c.totalL}L (${wr}%) — buckets too thin for verdict`);
        } else {
          comboLines.push(`  ${combo}: ${c.totalW}W/${c.totalL}L (${wr}%)\n${bucketLines.join('\n')}`);
        }
      }
      if (comboLines.length === 0) continue;
      lines2.push(`${sport.toUpperCase()}${winTag}:\n${comboLines.join('\n')}`);
    }

    if (lines2.length === 0) return '';
    const totalSettled = Object.values(sportData).reduce((s, combos) => s + Object.values(combos).reduce((ss, c) => ss + c.totalW + c.totalL, 0), 0);
    return `\n📊 YOUR RECENT PICK ACCURACY (adaptive 7-21d window per sport, ${totalSettled} trades; split by phase=pre-game/live and side=dog[<50¢]/fav[≥50¢]; measured by game outcome, not stop-loss P&L):\n${lines2.join('\n')}\nApply verdicts PER (phase/side/bucket). If MLB/pre/dog is losing, treat a 62% MLB pre-game underdog read with heavy skepticism even if MLB/live/fav is calibrated. A confident read on a clear mismatch is what the bot needs — but don't ride a losing combo just because another one works.\n`;
  } catch { return ''; }
}

function getCalibrationFeedback() {
  if (Date.now() - lastCalFeedbackAt >= CAL_FEEDBACK_INTERVAL) {
    lastCalFeedbackAt = Date.now();
    calibrationFeedback = computeCalibrationFeedback();
    if (calibrationFeedback) console.log('[calibrate] Refreshed calibration feedback for Claude prompts');
  }
  return calibrationFeedback;
}

// Dynamic confidence margin — sport-aware, price-aware, situation-aware
//
// KEY INSIGHT: Live and pre-game are completely different:
// - LIVE: price = game state. 75¢ with a big lead = nearly free money. DON'T penalize high prices.
// - PRE-GAME: price = market consensus. 75¢ favorite could easily lose. BE selective on expensive.
//
// We can't afford to spam cheap bets at $327 — need to be selective everywhere,
// but ESPECIALLY selective on pre-game favorites and random sports (MLB).
function getRequiredMargin(price, { sport = '', live = false, scoreChanged = false,
  lineMove = false, lineMoveConfirming = false, lineMoveContra = false,
  lineMoveVelocity = 0, crossConfirmed = false } = {}) {
  // Calibration override takes precedence over hardcoded values (live bets only)
  if (live && CAL.requiredMarginLive?.[sport] != null) {
    const overrideBase = CAL.requiredMarginLive[sport];
    let sitAdj = 0;
    if (scoreChanged)        sitAdj -= 0.01;
    if (lineMoveConfirming)  sitAdj -= 0.01; // market agrees — act fast
    if (lineMoveContra)      sitAdj += 0.02; // market moving against — investigate
    if (crossConfirmed)      sitAdj -= 0.005; // both contracts agree — stronger signal
    if (lineMoveVelocity > 3) sitAdj -= 0.005; // fast spike = urgent information window
    return Math.max(0.01, overrideBase + sitAdj);
  }

  // Base margin by sport — how predictable is this sport?
  const sportBase = {
    nhl: 0.03,    // low-scoring, binary outcomes, goalie variance
    nba: 0.04,    // high-scoring but 15-pt comebacks happen 13%
    mlb: 0.05,    // most random sport — best team wins 60% over a season
    mls: 0.05, epl: 0.05, laliga: 0.05, seriea: 0.05, bundesliga: 0.05, ligue1: 0.05,  // draws kill, need conviction
    ufc: 0.02,    // least efficient market, biggest edges
    crypto: 0.04, economics: 0.04, politics: 0.04,
  }[sport] ?? 0.04;

  if (live) {
    // LIVE BETS: Don't penalize high prices — they reflect the game state
    // A team up 20 in Q4 at 85¢ is a BETTER bet than a pre-game toss-up at 50¢
    let sitAdj = 0;
    if (scoreChanged)        sitAdj -= 0.01;   // market recalculating — act fast
    if (lineMoveConfirming)  sitAdj -= 0.01;   // market agrees with us — edge window
    if (lineMoveContra)      sitAdj += 0.02;   // market moving against — be cautious
    if (crossConfirmed)      sitAdj -= 0.005;  // both Kalshi contracts agree — strong signal
    if (lineMoveVelocity > 3) sitAdj -= 0.005; // fast move = urgent — act before window closes
    return Math.max(0.01, sportBase + sitAdj);
  }

  // PRE-GAME: Market has settled. Be selective, especially on expensive favorites.
  // Expensive pre-game favorites are TRAPS — one loss at 75¢ wipes out 3 cheap wins.
  let priceAdj = 0;
  if (price >= 0.70) priceAdj = 0.03;         // 70¢+ pre-game favorite: need 3% more conviction
  else if (price >= 0.55) priceAdj = 0.01;     // mid-range: slight bump

  // Pre-game always needs +1% vs live (market has had time to settle)
  const margin = Math.max(0.02, sportBase + priceAdj + 0.01);
  return margin;
}
const MAX_PRICE = 0.75;           // Default ceiling — use getMaxPrice(league, period) for sport-specific limits

// Sport-specific price ceiling based on variance research:
// MLB: tiered by run differential — same logic as NHL/NBA
//   1-run:  78¢ — thin margin, one swing ties it
//   2-run:  82¢ — 2-run late (P5+) = 85-88% WE, real edge at 79-82¢
//   3-run:  86¢ — 3-run P7+ = 90-92% WE, ATL-type situations with elite bullpen
//   4+ run: 88¢ — 93-95% WE, only catastrophic collapses flip these
// NHL P3: 85¢ — 2-goal leads with <10min left are genuinely 93%+ WE, 85¢ still has edge
// NHL P1/P2: tiered by goal differential (a 2-goal P2 lead is 82-85% WE, very different from 1-goal 68%)
//   1-goal:   78¢ — P2 1-goal now passes WE floor (68%), needs room to enter at 65-75¢
//   2-goal:   82¢ — 82-85% WE, real edge exists at 76-82¢ for strong teams
//   3+ goal:  85¢ — 90%+ WE even mid-game, only overwhelming comebacks flip these
// NBA Q4: 80¢ — 15-pt comeback in Q4 happens only 8%, 20-pt is <2%
// NBA Q1-Q3: tiered by point differential
//   1-9 pt:   75¢ — swingy modern NBA, keep the blanket cap
//   10-14 pt: 78¢ — comeback rate 13%, real edge at 75-78¢ for dominant teams
//   15+ pt:   82¢ — 15pt+ comebacks are ~4%, tables say 90%+ WE
// Soccer: 75¢ always — draws kill contracts, never overpay for a lead
// diff (optional) = score differential in the sport's native units (runs/goals/pts).
// When omitted, falls back to the conservative (1-point) value.
function getMaxPrice(league, period, diff = 1) {
  if (league === 'mlb') {
    if (diff >= 4) return 0.88;
    if (diff >= 3) return 0.86;
    if (diff >= 2) return 0.82;
    return 0.78;
  }
  if (league === 'nhl') {
    if (period >= 3) return 0.85;
    // P1/P2
    if (diff >= 3) return 0.85;
    if (diff >= 2) return 0.82;
    return 0.78; // 1-goal P2 now passes WE floor (68%), needs room to enter at 65-75¢
  }
  if (league === 'nba') {
    if (period >= 4) return 0.80;
    // Q1/Q2/Q3
    if (diff >= 15) return 0.82;
    if (diff >= 10) return 0.78;
    return 0.75;
  }
  if (['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league)) return 0.75;
  return MAX_PRICE;
}
// 2026-04-23: tightened 10% → 6%. Preference is smaller bets for data collection
// over concentrated bets. At $110 bankroll: 6% = $6.60 per live-edge trade.
// When WR and calibration stabilize, can relax back toward 8-10%.
const MAX_TRADE_FRACTION = 0.10; // 10% of bankroll per trade — bumped from 8% on 2026-04-30
// Rationale: yesterday's 8 wins at 8% sizing netted +$9.59 (9.7% of $99) — JUST
// under the 10%/day target. Wins averaged $1.20 each. To consistently clear 10-15%/day
// from 8 wins, need ~$1.88/win avg → bigger sizing or more trades.
// Both shipped today: 3 new detectors (Q3 retuned, MLB-P4 added, NHL loosened)
// AND 10% baseline. Risk profile is meaningfully different from yesterday morning's
// 8% bump because:
//   - Bleed-out stop active (caps single-trade loss at ~-22% drawdown)
//   - Hard price-drop override (exits at -20% with adverse velocity)
//   - NBA-Q3 retuned (would NOT have fired on TOR-CLE)
// Same TOR-CLE scenario at 10% sizing with these protections = ~-$5 loss vs
// yesterday's -$10.73. Asymmetric R:R now favors aggression.
// Daily loss cap (25%) still in place — catastrophe protection unchanged.
// P1.3 — Pre-game sizing cut 15% → 5% per data analysis 2026-04-23.
// Biggest losses all came from oversized pre-game positions: SD-LAA -$33 (76 ct @ 44¢),
// ATL-PHI -$32 (66 ct @ 49¢), SF-WSH -$24 (57 ct @ 52¢), DET-BOS -$21 (71 ct @ 46¢).
// Pre-game WR is 41% — can't afford 10-15% position sizing when losers are 2.6× winners.
const PRE_GAME_TRADE_FRACTION = 0.05; // 5% for pre-game — tighter until pre-game WR improves
const POLL_INTERVAL_MS = 45 * 1000; // Check news every 45 seconds (was 60s)
// Tightened 2026-04-27 evening to capture more market-lag windows during peak
// hours. The Kalshi market re-prices on a 30-90s lag after game state changes;
// 60s polling missed ~30% of those lag windows. 45s polling covers most while
// still being conservative on Kalshi rate limits. Claude API cost impact: ~zero
// (Claude only runs on actual candidates, not every poll).
const COOLDOWN_MS = 5 * 60 * 1000;  // 5 min base cooldown (can be bypassed for better prices)
// 2026-04-23: tightened 8% → 5%. At $110 bankroll this is $5.50 per game, which is
// small enough to spread bets and collect diversified data. Was producing 30-80 contract
// positions that moved too much of the book on single games.
const MAX_GAME_EXPOSURE_PCT = 0.05; // Max 5% of bankroll on one game

// Scale-in entries scale with bankroll — at small bankroll, concentrate less on single games
function getMaxEntriesPerGame() {
  const b = getBankroll();
  if (b < 1000) return 1;   // Under $1K: one entry per game, spread capital wider
  if (b < 2000) return 2;   // $1K-$2K: allow one add if price improves
  return 3;                  // $2K+: full scale-in logic
}
const MAX_ENTRIES_PER_GAME = 3; // Legacy constant — use getMaxEntriesPerGame() instead
const MAX_DAYS_OUT = 1;            // Same-day only — capital turns over nightly

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL DETECTORS — pattern recognizers that fire when game state matches
// a historically-profitable cell. Bypass Sonnet entirely (saves API cost), build
// a synthetic decision object that flows through the same trade execution path.
// Position sizes are conservative since we skip Sonnet's qualitative quality check.
// ─────────────────────────────────────────────────────────────────────────────

// NBA Q4 cold-shooting: 88% WR (8W/1L) historical, +$3.83/trade.
// Pattern: Q4 with the leading team having a clear FG% advantage and the market
// price below the WE table — Kalshi lag exploit. Fires only on the leading team.
function detectNbaQ4ColdShooting({ league, period, gameDetail, diff, leadingFGNum, trailingFGNum, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'nba') return null;
  if (period !== 4) return null;
  if (targetAbbr !== leadingAbbr) return null; // bet only the leader
  if (leadingFGNum == null || trailingFGNum == null) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 5) return null;

  const m = (gameDetail || '').match(/^(\d+):(\d+)/);
  if (!m) return null;
  const minsLeft = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  if (minsLeft < 4 || minsLeft > 10) return null;

  const fgGap = leadingFGNum - trailingFGNum;
  if (fgGap < 8) return null;

  const edge = weTimeAdj - price;
  if (edge < 0.07) return null;

  return {
    trade: true,
    side: 'yes',
    confidence: weTimeAdj,
    betAmount: null, // bot will Kelly-size based on confidence
    reasoning: {
      steel_man: `Trailing team has ${minsLeft.toFixed(1)} minutes to mount a comeback with possessions remaining`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (NBA Q4 cold-shooting, historical 88% WR n=8): leading team has ${fgGap.toFixed(0)}pt FG% advantage, time-adjusted WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge — Kalshi WE-table lag.`,
      key_facts: [
        `Q4 ${minsLeft.toFixed(1)} min remaining with ${diff}-pt lead`,
        `Leading team FG% ${leadingFGNum.toFixed(0)}% vs trailing ${trailingFGNum.toFixed(0)}% (${fgGap.toFixed(0)}pt gap)`,
        `Time-adjusted WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ — ${(edge*100).toFixed(0)}pt edge`,
      ],
      top_risk: 'Foul trouble on leading team star or sudden 3pt run from trailing team',
      conviction: 'Structural pattern match — 8W/1L historical on this exact setup',
      reasoning_tags: ['market-lag', 'we-undervalued', 'pace-mismatch'],
    },
    _structuralPattern: 'nba-q4-cold-shooting',
    _matchInfo: { fgGap, minsLeft, edge: edge * 100, diff },
  };
}

// NBA Q4 leader (broader): 89% WR (8W/1L) on actual trade data n=9 historical.
// Fires on Q4 leader by 6+ pts at price ≤78¢ — broader than cold-shooting which
// requires 8+pt FG gap (rare, narrow). This catches the bigger population of
// Q4 leads where lead-protection dynamics + market-lag dominate.
//
// Difference from cold-shooting:
//   - No FG% gap requirement (any team-quality, not just shooting-dominant)
//   - 6+ pt diff (vs 5+) for safety
//   - 4-10 min remaining (same)
//   - Edge ≥5pt (vs 7pt) — looser since FG-gap quality check removed
//   - Price ≤78¢ (vs 80¢) — tighter for asymmetry safety
function detectNbaQ4Leader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'nba') return null;
  if (period !== 4) return null;
  if (targetAbbr !== leadingAbbr) return null; // leader only
  if (weTimeAdj == null || price == null) return null;
  if (diff < 5) return null; // 2026-04-29: was 6 — 5pt Q4 leads with 4-10min left
                              // are still WE-mispriced ~62-68% vs market 50-55¢ pattern
  if (price > 0.78) return null; // need room to run + asymmetry
  const m = (gameDetail || '').match(/^(\d+):(\d+)/);
  if (!m) return null;
  const minsLeft = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  if (minsLeft < 4 || minsLeft > 10) return null;
  const edge = weTimeAdj - price;
  if (edge < 0.05) return null;
  return {
    trade: true,
    side: 'yes',
    confidence: weTimeAdj,
    betAmount: null,
    reasoning: {
      steel_man: `Trailing team has ${minsLeft.toFixed(1)} minutes and limited possessions to overcome ${diff}-pt deficit`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (NBA Q4 leader, ~89% WR n=9 historical): ${diff}-pt lead, ${minsLeft.toFixed(1)}min left, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Q4, ${diff}-pt lead with ${minsLeft.toFixed(1)} min remaining`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
      ],
      top_risk: '3pt barrage by trailing team or foul trouble on leading team',
      conviction: 'Structural pattern — 89% WR historical (n=9) on Q4 leaders 5+ pts',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'nba-q4-leader',
    _matchInfo: { minsLeft, edge: edge * 100, diff },
  };
}

// MLB innings 3-5 leading-team: ~67% WR over n=6 historical (small sample,
// but consistent with the structural pattern). Mid-game leads in MLB are
// statistically protective — the trailing team has fewer at-bats remaining,
// and elite/good bullpens haven't yet been activated. This detector is more
// CONSERVATIVE than the others (smaller historical sample) so requires:
//   • ≥10pt edge (vs 5-7pt for higher-confidence detectors)
//   • Confirmed elite or good bullpen tier (poor/below excluded)
//   • Lead ≥2 runs (1-run leads have higher variance — already blocked elsewhere)
//   • Price ≤78¢ (within typical mid-game NBA ceiling, leaves room to run)
// NBA Q4 leader UNDERDOG-PRICED: catches the 4 rejected shadow cases (all won)
// where a Q4 leader is priced at 40-55¢ despite leading by 3+ pts with 4-10 min left.
// Pure WE-vs-price mispricing — when Kalshi prices a leader as a coin-flip but the
// score + clock say 60-70%+, that's pure +EV. Diff threshold 3 (vs ≥5 in the
// standard detector) because at low prices the asymmetry alone is the edge.
// 2026-04-29: shadow data showed 4/4 wins on this cell, edge 8-19pt.
function detectNbaQ4LeaderUnderdogPrice({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'nba') return null;
  if (period !== 4) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 3) return null;
  if (price < 0.40 || price > 0.55) return null; // underdog-priced band only
  const m = (gameDetail || '').match(/^(\d+):(\d+)/);
  if (!m) return null;
  const minsLeft = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  if (minsLeft < 4 || minsLeft > 10) return null;
  const edge = weTimeAdj - price;
  if (edge < 0.07) return null; // need ≥7pt edge at this band
  return {
    trade: true,
    side: 'yes',
    confidence: weTimeAdj,
    betAmount: null,
    reasoning: {
      steel_man: `Trailing team has ${minsLeft.toFixed(1)} min to overcome ${diff}-pt deficit; market pricing leader as coin flip`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (NBA Q4 leader underdog-priced): ${diff}-pt lead with ${minsLeft.toFixed(1)} min left, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge. Kalshi mispricing leader as toss-up.`,
      key_facts: [
        `Q4, ${diff}-pt lead with ${minsLeft.toFixed(1)} min`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ — underdog-priced leader`,
      ],
      top_risk: 'Late comeback or 3pt barrage by trailing team',
      conviction: 'Structural pattern — 4/4 shadow data on Q4 leaders priced 40-55¢',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'nba-q4-leader-underdog-price',
    _matchInfo: { minsLeft, edge: edge * 100, diff, price: Math.round(price * 100) },
  };
}

// MLB inn 5-7 leader (BROADER than detectMlbMidGameLead — catches the cases that
// fail mid-game's bullpen-tier and ≥10pt-edge requirements). Shadow data 2026-04-29:
// 28 rejected cases at edge 1-7pt, ~80% WR, +9-23% EV.
//
// Constraints:
//   • inn 5-7 (overlaps inn 5 with mid-game-lead but mid-game requires bullpen)
//   • leader, ≥1 run lead
//   • edge ≥4pt (vs ≥10pt for mid-game)
//   • price ≤82¢ (room for upside)
//   • no bullpen-tier requirement (this is the loose-fire detector)
// ─── DIP-BUY / UNDERPRICED LEADER DETECTORS (2026-04-29 audit) ────────────────
// Built from full shadow audit (605 records, 4 days). Cells where the bot has been
// REJECTING leader trades at 46-65¢ price band but those leaders went on to win at
// 70%+ rates. These detectors fire mechanically on the proven cells.

// MLB inning 6 leader at 46-65¢: 14 game-level wins out of 14 candidates (93% WR,
// +31% EV in shadow audit). The single highest-WR cell discovered. Fires only in
// the depressed price band where the market underrates an established lead.
function detectMlbInn6Leader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period !== 6) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 1) return null;
  if (price < 0.46 || price > 0.65) return null; // only fires in the underpriced band
  const edge = weTimeAdj - price;
  if (edge < 0.04) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `${diff}-run lead in 6th — only 3 innings left for trailing team to come back`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn 6 leader 46-65¢, jackpot cell 93% WR n=14): ${diff}-run lead in 6th, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning 6, ${diff}-run lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 14 games, 13 won (93%) at avg 62¢`,
      ],
      top_risk: 'Late-inning bullpen blow-up or trailing rally',
      conviction: 'Structural pattern — highest-WR cell in 4-day shadow audit',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-inn-6-leader',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// MLB inning 2 leader at 50-65¢: 9 game-level, 78% WR, +17% EV (shadow audit).
// Captures early-game leaders the market underprices because innings remain.
function detectMlbInn2Leader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period !== 2) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 1) return null;
  if (price < 0.50 || price > 0.65) return null;
  const edge = weTimeAdj - price;
  if (edge < 0.04) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `${diff}-run lead in 2nd — early but trailing team has full game to come back`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn 2 leader 50-65¢, 78% WR n=9): ${diff}-run lead in 2nd, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning 2, ${diff}-run lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 9 games, 7 won (78%) at avg 61¢`,
      ],
      top_risk: 'Plenty of innings left for trailing team rally',
      conviction: 'Structural pattern — early-lead market underpricing',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-inn-2-leader',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// NBA Q2 leader at 50-65¢: 8 game-level, 75% WR, +14% EV. Mid-half leaders
// market underprices because half is still left. Diff ≥5 to ensure meaningful lead.
// 2026-05-02 OFFENSIVE: NBA Q4 deep-trailer swing. When a team is down 8-15
// in Q4 with 4-9 min remaining, their price is 15-25¢. NBA Q4 runs are common
// (10-0 / 12-2 spurts in 2-3 min). When trailer cuts the deficit by 4+, price
// spikes from 18¢ → 35¢ (~+17¢ swing).
//
// Math at 20¢ entry on a 25% rally rate (cuts deficit to ≤4, triggers price
// spike that lets us swing-exit at +15¢):
//   25% × +$0.15 + 75% × (price-stays-flat-or-down) ≈ +$0.04/contract = +20% ROI
// Asymmetric pay structure works in our favor.
function detectNbaQ4DeepTrailer({ league, period, gameDetail, diff, price, targetAbbr, leadingAbbr }) {
  if (league !== 'nba') return null;
  if (period !== 4) return null;
  if (targetAbbr === leadingAbbr) return null; // TRAILER only
  if (diff < 8 || diff > 15) return null; // mid-deep deficit (8-15pt)
  if (price == null) return null;
  if (price < 0.10 || price > 0.25) return null; // cheap-underdog asymmetric band
  // Time check: 4-9 min remaining (enough for run, not garbage time)
  const m = (gameDetail || '').match(/^(\d+):(\d+)/);
  if (!m) return null;
  const minsLeft = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  if (minsLeft < 4 || minsLeft > 9) return null;
  return {
    trade: true, side: 'yes', confidence: 0.30, betAmount: null,
    reasoning: {
      steel_man: `${diff}-pt deficit with ${minsLeft.toFixed(1)} min in Q4 — price ${(price*100).toFixed(0)}¢ is undervalued for NBA run-based variance`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (NBA Q4 deep-trailer swing): ${targetAbbr} trailing ${diff}, ${minsLeft.toFixed(1)} min left, ${(price*100).toFixed(0)}¢. NBA Q4 runs are common; price spikes on 4+ pt cuts.`,
      key_facts: [
        `Q4 ${minsLeft.toFixed(1)} min left, ${diff}-pt deficit`,
        `Trailer at ${(price*100).toFixed(0)}¢ — asymmetric pay`,
        `NBA Q4 10-0 runs happen ~25% of games — swing exit at +15¢`,
      ],
      top_risk: 'Leader extends lead, position drops to 0',
      conviction: 'NBA Q4 variance is the bot — buy cheap volatility',
      reasoning_tags: ['underdog-spot', 'we-undervalued', 'pace-mismatch'],
    },
    _structuralPattern: 'nba-q4-deep-trailer',
    _matchInfo: { period, diff, minsLeft, price: Math.round(price*100) },
  };
}

function detectNbaQ2Leader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'nba') return null;
  if (period !== 2) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 5) return null; // need meaningful lead at this stage
  // 2026-05-02 DIFF-AWARE CAP from bucket audit. Big leads (d>=9) hold up at
  // higher prices: shadow shows 70-75¢ at 100% WR (n=4), 75-80¢ at 100% (n=2).
  // Smaller leads (d=5-8) leak above 65¢: 70-75¢ shows 36% WR (n=11) ⚠️.
  if (diff >= 9 && (price < 0.50 || price > 0.78)) return null;
  if (diff < 9 && (price < 0.50 || price > 0.65)) return null;
  // 2026-05-02 BUCKET-WR ANCHORING: dropped 5pt edge floor. Cell ≥9pt-lead
  // shows 100% WR at 70-80¢ — empirical authority over WE adjustments.
  const edge = weTimeAdj - price;
  if (edge < -0.05) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `${diff}-pt lead in Q2 — half left but lead is meaningful`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (NBA Q2 leader 50-65¢, 75% WR n=8): ${diff}-pt lead in Q2, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Q2, ${diff}-pt lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 8 games, 6 won (75%) at avg 61¢`,
      ],
      top_risk: 'Half remaining — sustainable run by trailing team possible',
      conviction: 'Structural pattern — Q2 lead market underpricing',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'nba-q2-leader',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// NBA Q3 leader at 50-65¢: 9 game-level, 78% WR, +19% EV. Diff ≥4 to ensure lead
// is meaningful (and avoid the documented Q3 -EV cell at lower diffs).
function detectNbaQ3Leader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  // 2026-04-30 RE-ENABLED with tighter conditions. Original disable was a 1-trade
  // overreaction (TOR-CLE -$10.73). Updated shadow data (n=19) confirmed 89% WR
  // and +26.6% EV for NBA-P3 leaders generally. The TOR-CLE loss had specific
  // characteristics that the new conditions filter out:
  //   - TOR led by 10pts (giant lead, more to give back)
  //   - 11:13 left in Q3 (early — full quarter for comeback)
  //   - Game collapsed over 30+ min (slow bleed)
  // Bleed-out stop now active as safety net (caps single losses at ~-22%).
  if (league !== 'nba') return null;
  if (period !== 3) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  // Tighter diff window: 4-8 pts. Filters TOR-CLE-style 10pt-lead-collapse cases.
  // Bigger leads (>8) more vulnerable to comeback runs; smaller (<4) too marginal.
  if (diff < 4 || diff > 8) return null;
  // 2026-05-02 BUCKET REFINEMENT: cap loosened 62¢ → 70¢. Bucket audit shows
  // d=7-8 at 60-65¢: 100% WR (n=3), 65-70¢: 100% (n=3). Previous 62¢ cap was
  // missing the 65-70¢ winners. Bucket profile across the cell:
  //   50-55: 100% n=3 / 60-65: 100% / 65-70: 100% (small but consistent)
  //   70-75: 17% (n=6) ⚠️ — keep blocked
  if (price < 0.50 || price > 0.70) return null;
  // Time window: 4-10 min remaining in Q3. Skips very early Q3 (TOR-CLE was at 11:13).
  const m = (gameDetail || '').match(/^(\d+):(\d+)/);
  if (!m) return null;
  const minsLeft = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  if (minsLeft < 4 || minsLeft > 10) return null;
  // Require WE ≥70% (filter low-confidence reads)
  if (weTimeAdj < 0.70) return null;
  // 2026-05-02 BUCKET-WR ANCHORING: dropped 5pt edge floor.
  const edge = weTimeAdj - price;
  if (edge < -0.05) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `${diff}-pt lead in Q3 — quarter+ left but lead is sustained`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (NBA Q3 leader 50-65¢, 78% WR n=9): ${diff}-pt lead in Q3, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Q3, ${diff}-pt lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 9 games, 7 won (78%) at avg 59¢`,
      ],
      top_risk: 'Q4 still to play — comeback windows exist',
      conviction: 'Structural pattern — Q3 lead market underpricing',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'nba-q3-leader',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100), minsLeft },
  };
}

// MLB inning 4 leader at 50-82¢: 22 shadow records, 100% WR, +24.9% EV (audit 2026-04-30).
// Currently uncovered: detectMlbMidGameLead requires bullpen tier + ≥10pt edge.
// detectMlbInn5To7Leader starts at inn 5. So inning 4 was missed entirely.
// Same shape as inn-2/5-7/6 detectors that have gone 100% WR in production.
function detectMlbInn4Leader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period !== 4) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 1) return null;
  if (price < 0.50) return null;
  // 2026-05-02: diff-aware caps from bucket-level shadow analysis. Real-bet WR
  // was 33% n=3 with the old 82¢ blanket cap because LAA tonight at 81¢ was in
  // the 80-85¢ bucket where shadow shows only 55% WR (n=11). Tighter caps:
  //   d=1: ≤72¢ (single-run leads in 4th are fragile, 5 innings remain)
  //   d=2: ≤78¢ (block the 80-85 trap; 70-80 band shows 80%+ WR)
  //   d≥3: ≤82¢ (kept; bigger leads survive higher prices)
  if (diff === 1 && price > 0.72) return null;
  if (diff === 2 && price > 0.78) return null;
  // 2026-05-02 DEAD-ZONE for d=3: 75-80¢ shows 50% WR (n=4), 80-82¢ shows 80% (n=10).
  // Allow 50-75¢ (lockdown lean) OR 80-82¢ (high-conviction band), block 75-80 dead zone.
  if (diff === 3) {
    const inLow = price >= 0.50 && price <= 0.75;
    const inHigh = price >= 0.80 && price <= 0.82;
    if (!inLow && !inHigh) return null;
  }
  if (diff >= 4 && price > 0.82) return null;
  // 2026-05-02 BUCKET-WR ANCHORING: dropped 8pt edge floor. The diff-aware caps
  // already filter out the leaky 80-85¢ d=2 bucket. Within validated bands:
  //   d=1 60-70¢: 100% WR (n=12) | 70-72¢: 79%
  //   d=2 65-70¢: 100% (n=5) | 70-75¢: 79% (n=14) | 75-80¢: 81% (n=21)
  //   d≥3 75-80¢: 50% small-sample / 80-85¢: 80% (n=10)
  // Claude was double-counting situational risk against +EV cells. Anchor on
  // empirical bucket data instead. Backstop: WE >= price-5pt sanity check.
  const edge = weTimeAdj - price;
  if (edge < -0.05) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `${diff}-run lead in 4th — 5 innings to close out, room for runs both ways`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn 4 leader 50-82¢, 100% WR n=22 shadow): ${diff}-run lead in 4th, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning 4, ${diff}-run lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 22 shadow leaders, 100% WR at avg 75¢`,
      ],
      top_risk: 'Mid-game variance — opponent has 5 more innings of at-bats',
      conviction: 'Structural pattern — uncovered cell from 2026-04-30 shadow audit',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-inn-4-leader',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// MLB inning 1 leader with 3+ run lead: shadow audit 2026-04-30 shows 100% WR n=10 at avg 76¢.
// 3+ runs in 1st inning = early statement game; trailing team must mount full-game comeback.
// Detector cap 80¢ since data tops out around there.
function detectMlbInn1Leader3Plus({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period !== 1) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 3) return null;
  if (price > 0.85) return null;
  // 2026-05-02 BUCKET-WR ANCHORING: dropped edge requirement. Cell shows 100% WR
  // n=15 at 65-85¢ — buying at any price in band is +EV regardless of Claude's
  // momentary WE adjustments. Backstop: WE must be within 5pt of price (catches
  // catastrophic state shifts where WE genuinely drops below 50%).
  const edge = weTimeAdj - price;
  if (edge < -0.05) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `${diff}-run lead in 1st — early but commanding; trailing team needs full-game comeback`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn 1 leader 3+ runs, 100% WR n=10 shadow): ${diff}-run lead in 1st, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning 1, ${diff}-run lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 10 shadow leaders, 100% WR at avg 76¢`,
      ],
      top_risk: 'Full game ahead — opponent has 8 innings of at-bats',
      conviction: 'Structural pattern — early-statement leader from shadow audit',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-inn-1-leader-3run',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// MLB inning 3 leader with 3+ run lead: live-edge gap detector identified 2026-05-01.
// Inn-3 was uncovered between detectMlbInn1Leader3Plus (inn 1) and detectMlbInn4Leader (inn 4).
// TEX-DET tonight (TEX 4-0 inn-3 at 88¢) sat in this gap — global price ceiling caught it
// but no structural detector to fast-path. Cell logic: inn-3 is "blowout track" — a 3+ run
// lead 1/3 of game in is statistically very strong (~85-92% conversion). Cap at 88¢
// matches the global MLB ceiling for diff>=4 and Fix A diff-aware approach for inn-5-7.
// MLB inning 3 leader EXACTLY 2-run lead. Bucket audit 2026-05-02:
// 65-70: 75% (n=8), 70-75: 78% (n=9), 75-80: 75% (n=20), 80-85: 83% (n=6).
// Uniform 75-83% across the entire 65-85¢ band, n=45 — replaces volume from
// the disabled inn-3-3run cell with a real +EV one. Cap at 82¢ to stay within
// the validated band; 8pt edge floor for selection-bias filter.
function detectMlbInn3Leader2Run({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period !== 3) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff !== 2) return null;
  if (price < 0.65 || price > 0.82) return null;
  // 2026-05-02 BUCKET-WR ANCHORING: dropped 6pt edge floor. Cell shows uniform
  // 75-83% WR across 65-85¢ band (n=45). Empirical bucket data trumps Claude's
  // step-3 adjustments which double-count situational risks already in the data.
  const edge = weTimeAdj - price;
  if (edge < -0.05) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `2-run lead in 3rd — early-mid game, lead validates pitcher control`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn 3 leader 2-run, 75-83% WR n=45 shadow): 2-run lead in 3rd, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning 3, 2-run lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 45 shadow leaders, uniform 75-83% WR across 65-85¢`,
      ],
      top_risk: '6 innings remain — ample time for trailing offense to flip',
      conviction: 'Structural pattern — replaces disabled inn-3-3run, 2-run subset is the real cell',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-inn-3-leader-2run',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

function detectMlbInn3Leader3Plus({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  // 2026-05-02 DISABLED. Comprehensive bucket audit (n=27) shows EVERY price
  // bucket on this cell is below break-even:
  //   70-75¢: 60% WR (n=5)
  //   75-80¢: 45% WR (n=11)
  //   80-85¢: 50% WR (n=8)
  // Cell is not +EV at any price. Return null unconditionally.
  // Replaced volume by adding detectMlbInn3Leader2Run (uniform 75-83% WR cell).
  return null;
  // eslint-disable-next-line no-unreachable
  if (league !== 'mlb') return null;
  if (period !== 3) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 3) return null;
  if (price > 0.78) return null;
  const edge = weTimeAdj - price;
  if (edge < 0.08) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `${diff}-run lead in 3rd — 1/3 of game played, lead is statistically commanding`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn 3 leader 3+ runs): ${diff}-run lead in 3rd, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning 3, ${diff}-run lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Blowout-track cell — 6 innings remaining for opponent to overcome 3+ runs`,
      ],
      top_risk: '6 innings remaining — bullpen blow-up or opponent rally still possible',
      conviction: 'Structural pattern — gap-fill detector for inn-3 leaders (2026-05-01 add)',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-inn-3-leader-3run',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// MLB inning 2 leader with EXACTLY 2-run lead: shadow audit 2026-04-30 shows 92% WR n=40 at avg 71¢.
// This is the BIGGEST missed cell in shadow data — Sonnet rejects most of these. Bypass with detector.
// Existing detectMlbInn2Leader is broader (covers diff 3+); this targets the high-WR 2-run subset.
function detectMlbInn2Leader2Run({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period !== 2) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff !== 2) return null; // EXACTLY 2-run lead — the proven cell
  if (price > 0.80) return null;
  // 2026-05-02 BUCKET-WR ANCHORING: dropped 4pt edge floor. Cell shows 100% WR
  // at 65-70¢ (n=13), 88% at 70-75 (n=17), 83% at 75-80 (n=6). Empirical bucket
  // data >> Claude's situational adjustments. Backstop: WE >= price-5pt sanity.
  const edge = weTimeAdj - price;
  if (edge < -0.05) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `2-run lead in 2nd — early lead, but 92% historical conversion suggests market underprices these`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn 2 leader 2-run, 92% WR n=40 shadow): 2-run lead in 2nd, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning 2, 2-run lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 40 shadow leaders, 92% WR at avg 71¢`,
      ],
      top_risk: 'Early game — 7+ innings remaining for trailing-team rally',
      conviction: 'Structural pattern — highest-volume +EV cell from shadow audit (n=40)',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-inn-2-leader-2run',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// MLB inning 5 leader with 3+ run lead: shadow audit 2026-04-30 shows 100% WR n=12 at avg 83¢.
// Higher prices than other cells — these are blowout-track games where market correctly favors leader.
// Cap at 88¢ matches Fix A diff-aware exception. Verifies Fix A's higher cap actually permits these.
function detectMlbInn5Leader3Plus({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period !== 5) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 3) return null;
  if (price > 0.88) return null;
  // 2026-05-02 BUCKET-WR ANCHORING: dropped 4pt edge floor. Cell shows 100% WR
  // at 80-85¢ (n=8) and 100% at 85-90¢ (n=4). 88¢ cap already filters; no edge
  // requirement needed. Empirical data is the authority.
  const edge = weTimeAdj - price;
  if (edge < -0.05) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `${diff}-run lead in 5th — game half over with commanding cushion; bullpen-protect math`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn 5 leader 3+ runs, 100% WR n=12 shadow): ${diff}-run lead in 5th, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning 5, ${diff}-run lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 12 shadow leaders, 100% WR at avg 83¢`,
      ],
      top_risk: 'Bullpen blow-up still possible but lead size shields against single bad inning',
      conviction: 'Structural pattern — high-price +EV cell from shadow audit (Fix A diff-aware permits)',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-inn-5-leader-3run',
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// Soccer 1H home leader at 50-65¢: 5 game-level, 80% WR, +18% EV. Smaller sample
// but consistent with the home-leader 2H pattern. Excludes MLS for now (mixed
// historical) and minute < 30 (too early — own-goal variance).
function detectSoccer1HHomeLeader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr, homeAbbr }) {
  const europeanLeagues = ['epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'];
  if (!europeanLeagues.includes(league)) return null;
  if (period !== 1) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (targetAbbr !== homeAbbr) return null; // home leaders only — same as 2H detector
  if (weTimeAdj == null || price == null) return null;
  if (diff < 1) return null;
  if (price < 0.50 || price > 0.65) return null;
  const m = (gameDetail || '').match(/^(\d+)/);
  if (!m) return null;
  const minute = parseInt(m[1], 10);
  if (minute < 30 || minute > 45) return null; // last 15 min of 1H only
  const edge = weTimeAdj - price;
  if (edge < 0.05) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `Home team leading ${diff} at minute ${minute}' — half remains for opponent`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (Soccer 1H home leader 50-65¢, 80% WR n=5): ${targetAbbr} leading ${diff} at min ${minute}', WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Minute ${minute}', home team leading by ${diff}`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Cell history: 5 games, 4 won (80%) at avg 62¢`,
      ],
      top_risk: 'Half remaining — comeback or equalizer possible',
      conviction: 'Structural pattern — home leader 1H underpricing',
      reasoning_tags: ['market-lag', 'we-undervalued', 'playoff-home-fav'],
    },
    _structuralPattern: 'soccer-1h-home-leader',
    _matchInfo: { minute, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// 2026-05-02 OFFENSIVE: MLB inn-8/9 leader — closer-territory lockdown.
// Late-inning closer entry typically means 90%+ lockdown rate. Different from
// detectMlbLateInningLockdown which requires bullpen-tier data (0 fires ever
// because data dependency wasn't met). This simpler version: inn 8-9 + d=1+ +
// reasonable price band. Pattern is well-documented across baseball.
function detectMlbInn89Leader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period < 8 || period > 9) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 1) return null;
  // Price band: 70-90¢. Below 70¢ is suspicious (something wrong); above 90¢
  // not enough upside to justify trade fees + small variance.
  if (price < 0.70 || price > 0.90) return null;
  // Diff-aware floor:
  //   d=1: needs at least 75¢ price (not too desperate, market still believes)
  //   d=2+: any 70-90¢ ok
  if (diff === 1 && price < 0.75) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `${diff}-run lead in inning ${period} — closer territory, trailing team has limited at-bats`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn-${period} closer-territory leader): ${diff}-run lead, price ${(price*100).toFixed(0)}¢. Inn-8/9 leaders settle 88-95% historically (closers convert ~93% of save opportunities).`,
      key_facts: [
        `Inning ${period}, ${diff}-run lead`,
        `Closer territory — trailing team has ${period === 8 ? '1-2' : '0-1'} innings remaining`,
        `MLB closers: ~93% conversion rate (industry standard)`,
      ],
      top_risk: 'Closer blow-up — rare but happens (~5-10% of save opportunities)',
      conviction: 'Late-inning closer-locked leader — mechanical pattern',
      reasoning_tags: ['market-lag', 'we-undervalued', 'late-inning'],
    },
    _structuralPattern: 'mlb-inn-89-leader',
    _matchInfo: { period, diff, price: Math.round(price*100) },
  };
}

function detectMlbInn5To7Leader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr, ticker }) {
  if (league !== 'mlb') return null;
  if (period < 5 || period > 7) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 1) return null;
  // 2026-05-02 MAJOR REWORK: this detector was the worst performer (n=9, 56% WR,
  // -$14.27 P&L). Selection bias: it fires on Sonnet-rejected setups, which are
  // the marginal end of every cell. Tightening per inning + diff:
  //
  //   inn 5 d=1: ≤50¢ (existing fix-D — 4 innings remain, fragile)
  //   inn 5 d=2: ≤65¢ (was 70¢ — 70-75 bucket showed only 60% WR shadow)
  //   inn 5 d≥3: ≤88¢ (kept — 100% shadow WR at higher prices)
  //   inn 6 d=1: ≤50¢ (existing fix-D-2)
  //   inn 6 d=2: SKIP — let inn-6-leader (100% real WR n=6 at 46-65¢) handle it
  //   inn 6 d≥3: ≤88¢ (kept)
  //   inn 7 d=1: ≤45¢ (NEW — close-game 7th, lockdown territory only at deep dip)
  //   inn 7 d=2: ≤72¢ (slight loosen, 2 innings left = stronger lockdown)
  //   inn 7 d≥3: ≤88¢ (kept)
  // 2026-05-02 BUCKET REFINEMENT for inn-5 d=1: extend allowed band to ≤60¢.
  // Bucket profile: 50-55¢ = 100% (n=4), 55-60¢ = 80% (n=5) ✅
  //                 60-65¢ = 50% (n=14), 65-70¢ = 41% (n=22) ⚠️ block
  // Old gate ≤50¢ was over-tight — missed 9 winning samples in 50-60 range.
  if (period === 5 && diff === 1 && price > 0.60) {
    if (typeof logFixABlock === 'function') { try { logFixABlock({ league, period, diff, price, targetAbbr, gate: 'inn5-1run-above60', ticker }); } catch {} }
    return null;
  }
  // 2026-05-02 DEAD-ZONE CARVE-OUTS for d=2. Bucket audit revealed non-monotonic
  // WR profiles where the middle band (~65-75¢) is a money pit but the high
  // band (75-85¢) is a sweet spot. Earlier flat-cap tightening blocked both.
  // Now: allow low-band entries (deep mispricing) AND high-band entries
  // (lockdown lean) but skip the dead zone in between.
  //
  //   inn 5 d=2 buckets: 60-65: 67% / 70-75: 60% (n=10) ⚠️ / 75-80: 83% (n=18) / 80-85: 82% (n=11)
  //   inn 6 d=2 buckets: 70-75: 20% (n=5) ⚠️ / 75-80: 91% (n=11) / 80-85: 100% (n=3)
  //   inn 7 d=2 buckets: 70-75: 50% (n=4) ⚠️ / 75-80: 60% (n=5) / 80-85: 83% (n=6)
  if (period === 5 && diff === 2) {
    // Allow 50-65¢ (low-band mispricing) OR 75-85¢ (lockdown sweet spot). Skip middle.
    const inLow = price >= 0.50 && price < 0.65;
    const inHigh = price >= 0.75 && price <= 0.85;
    if (!inLow && !inHigh) {
      if (typeof logFixABlock === 'function') { try { logFixABlock({ league, period, diff, price, targetAbbr, gate: 'inn5-2run-deadzone', ticker }); } catch {} }
      return null;
    }
  }
  // 2026-05-02 BUCKET REFINEMENT for inn-6 d=1: extended audit reveals the
  // 65-70¢ band has 82% WR n=11 (+14pt EV) — was blocked by old ≤50¢ rule.
  // Bucket profile: 60-65: 100% (n=5), 65-70: 82% (n=11) ✅
  //                 70-75: 57% (n=14), 75-80: 33% (n=6) ⚠️ block
  // Allow inn-6 d=1 up to 70¢; block above.
  if (period === 6 && diff === 1 && price > 0.70) {
    if (typeof logFixABlock === 'function') { try { logFixABlock({ league, period, diff, price, targetAbbr, gate: 'inn6-1run-above70', ticker }); } catch {} }
    return null;
  }
  if (period === 6 && diff === 2) {
    // Below 65¢: defer to inn-6-leader (100% WR n=6 in 46-65¢ band).
    // 65-75¢: dead zone (20% WR n=5).
    // 75-85¢: sweet spot (91-100% WR n=14).
    if (price < 0.75 || price > 0.85) {
      if (typeof logFixABlock === 'function') { try { logFixABlock({ league, period, diff, price, targetAbbr, gate: 'inn6-2run-deadzone', ticker }); } catch {} }
      return null;
    }
  }
  if (period === 7 && diff === 1 && price > 0.45) {
    if (typeof logFixABlock === 'function') { try { logFixABlock({ league, period, diff, price, targetAbbr, gate: 'inn7-1run-tight', ticker }); } catch {} }
    return null;
  }
  if (period === 7 && diff === 2) {
    // Allow 50-72¢ (lockdown lean) OR 80-85¢ (deep lockdown). Block 72-80 dead zone.
    const inLow = price >= 0.50 && price <= 0.72;
    const inHigh = price >= 0.80 && price <= 0.85;
    if (!inLow && !inHigh) {
      if (typeof logFixABlock === 'function') { try { logFixABlock({ league, period, diff, price, targetAbbr, gate: 'inn7-2run-deadzone', ticker }); } catch {} }
      return null;
    }
  }
  if (diff >= 3 && price > 0.88) {
    if (typeof logFixABlock === 'function') { try { logFixABlock({ league, period, diff, price, targetAbbr, gate: 'diff-ge-3', ticker }); } catch {} }
    return null;
  }
  // 2026-05-02 BUCKET-WR ANCHORING: dropped 8pt edge floor. The dead-zone
  // carve-outs above filter to validated +EV bands. Within those bands:
  //   inn 5 d=2 50-65: 67% / 75-80: 83% / 80-85: 82%
  //   inn 6 d=2 75-80: 91% / 80-85: 100%
  //   inn 7 d=2 50-72: 50-67% / 80-85: 83%
  //   diff>=3: 100% in 80-90¢
  // Edge requirement was double-counting Claude's situational adjustments
  // against historically validated cells. Backstop: WE >= price-5pt sanity.
  const edge = weTimeAdj - price;
  if (edge < -0.05) return null;
  return {
    trade: true,
    side: 'yes',
    confidence: weTimeAdj,
    betAmount: null,
    reasoning: {
      steel_man: `${diff}-run lead in ${period}th inning — trailing team has limited at-bats remaining`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB inn 5-7 leader, shadow ~80% WR n=28): ${diff}-run lead in ${period}th, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning ${period}, ${diff}-run lead`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
      ],
      top_risk: 'Late-inning bullpen blow-up or trailing-team rally',
      conviction: 'Structural pattern — broad MLB mid/late-mid leader',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-inn-5-7-leader',
    _matchInfo: { period, diff, edge: edge * 100 },
  };
}

function detectMlbMidGameLead({ league, period, gameDetail, diff, leadingBullpenTier, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period < 3 || period > 5) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 2) return null; // 2+ run lead only

  const tier = (leadingBullpenTier || '').toLowerCase();
  if (tier !== 'elite' && tier !== 'good') return null; // bullpen quality required

  const edge = weTimeAdj - price;
  if (edge < 0.10) return null;

  if (price > 0.78) return null; // need room to run

  return {
    trade: true,
    side: 'yes',
    confidence: weTimeAdj,
    betAmount: null,
    reasoning: {
      steel_man: `Trailing team has ${9 - period} innings remaining to come back, comeback rates are non-trivial`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB mid-game leader, ~67% WR n=6): ${targetAbbr} leading by ${diff} runs in inning ${period}, ${tier} bullpen tier, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge.`,
      key_facts: [
        `Inning ${period}, ${diff}-run lead`,
        `Bullpen tier: ${tier} (sufficient to protect mid-game lead)`,
        `Time-adjusted WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
      ],
      top_risk: 'Big inning by trailing team or starter pulled early',
      conviction: 'Structural pattern match — 67% WR on mid-game MLB leaders with good bullpens',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-mid-game-lead',
    _matchInfo: { period, diff, edge: edge * 100, tier },
  };
}

// MLB inning 2-4 leader (early-mid pattern): 81% WR / n=48 / Wilson 90% lower-CI 70%.
// Discovered via shadow-decision mining 2026-04-27. Broader than `detectMlbMidGameLead`
// which requires 2+ run lead, elite/good bullpen, ≥10pt edge — this fires on any leader
// in inning 2-4 at price ≤72¢ regardless of bullpen tier or edge size.
//
// Why it works: shadow data shows MLB leaders in inning 2-4 win 80-85% of the time
// across confidence bands (60-79%) AND edge buckets (negative through positive). The
// market underprices early-mid leaders because conventional wisdom says "lots of
// game left." Shadow data shows that's wrong — once you have a lead through the
// 2nd-4th inning, the trailing team's comeback path narrows fast.
//
// Constraints (data-driven):
//   - Inning 2-4 (P5+ handled by detectMlbMidGameLead with stricter rules)
//   - Lead ≥1 (not 2+ — shadow shows 1-run leads also high-WR here)
//   - Price ≤72¢ (above 72 = gamma trap, runners-on-base can erase 20¢ in one swing)
//   - WE anchor must exist (≥45% — basic sanity)
//   - Skip if existing detectMlbMidGameLead already qualifies (avoid double-fire)
// REVERTED 2026-04-27 evening: the original "n=48, 81% WR" finding was misleading.
// Game-level dedupe revealed only 22 unique games (68% game-WR). At avg price 73¢,
// break-even WR is 73% — actual 68% game-WR is NEGATIVE EV. P3 specifically is 47%
// WR (trap zone). Detector returns null permanently until we re-mine for a +EV cell.
function detectMlbEarlyMidLead() {
  return null;
}

// MLB late-inning lockdown (innings 8-9): leader at 80-90¢ with bullpen edge.
// Mid-game detector handles innings 3-5; this catches the late-inning lockdown
// pattern where the leading team has a closer-grade bullpen and the price has
// risen but still has room. WE table for 1-2 run leads in 8th/9th is 85%+
// when bullpen is elite — Kalshi sometimes prices these at 82-87¢.
//
// Constraints (data-driven):
//   - Period 8-9 (MLB innings 8 and 9 — the "closer" zone)
//   - Lead ≥1 (1 run is enough late since few outs remaining)
//   - Bullpen tier elite or good (closer/setup quality matters)
//   - Price 78-92¢ (lower than that = mid-game, higher = no upside)
//   - Edge ≥4pt (looser than mid-game since pattern is mechanical)
//   - Word "closer" was 100% WR in shadow text — closer presence is the key signal
function detectMlbLateInningLockdown({ league, period, gameDetail, diff, leadingBullpenTier, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'mlb') return null;
  if (period < 8 || period > 9) return null;
  if (targetAbbr !== leadingAbbr) return null;
  if (weTimeAdj == null || price == null) return null;
  if (diff < 1) return null;
  if (price < 0.78 || price > 0.92) return null;
  const tier = (leadingBullpenTier || '').toLowerCase();
  if (tier !== 'elite' && tier !== 'good') return null;
  const edge = weTimeAdj - price;
  if (edge < 0.04) return null;
  return {
    trade: true,
    side: 'yes',
    confidence: weTimeAdj,
    betAmount: null,
    reasoning: {
      steel_man: `${diff}-run lead in ${period}th inning with ${tier} bullpen — closer-grade lockdown territory`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (MLB late-inning lockdown, P${period}): ${diff}-run lead with ${tier} bullpen, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge. Late-inning leaders with closer-quality bullpens win ~88-92% historically.`,
      key_facts: [
        `Inning ${period}, ${diff}-run lead`,
        `${tier} bullpen tier (closer/setup quality)`,
        `WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
      ],
      top_risk: `Big inning by trailing team or closer blow-up (rare with ${tier} tier)`,
      conviction: 'Structural pattern — late-inning + good-bullpen leader is mechanical',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'mlb-late-inning-lockdown',
    _matchInfo: { period, diff, edge: edge * 100, tier },
  };
}

// NHL P3 closing-out: 75% WR (3/4) historical pattern, +$1.91/trade.
// Pattern: 3rd period leader with time running out. Time decay protects leads
// in hockey — late P3 is the safest window for the leading team.
//
// Excludes 1-goal leads in last 2 min (pulled-goalie chaos — high variance,
// market correctly prices). Excludes 1-goal leads in first 8 min of P3 (still
// 12+ min to play — too much variance to call this "closing out").
// 2026-05-02 OFFENSIVE: SCORE-EVENT ARB — fires the moment a score changes.
// Hypothesis: ESPN scoreboard updates on score events 30-90s before Kalshi
// market makers fully reprice. We exploit the lag by firing fast-path at the
// current (still-stale) leader price.
//
// Validation: price-tape data shows 5.5% of polling intervals contain ≥10¢
// price moves, mostly clustered around score events. ~5-10 such events per
// active game × 4-6 games/night = 30-60 opportunities/day.
//
// Sized small (3% bankroll cap). Quick exit (swing at +5¢, not hold).
// Only fires when _scoreChanged is true on the cycle, indicating fresh signal.
function detectScoreEventArb({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr, scoreChanged }) {
  if (!scoreChanged) return null;
  if (targetAbbr !== leadingAbbr) return null; // bet leader only after score change
  if (diff < 1) return null;
  if (weTimeAdj == null || price == null) return null;
  // Asymmetric pay band: 45-78¢. Below 45¢ leader bets are too random,
  // above 78¢ the lag arb is already pricing in (market caught up).
  if (price < 0.45 || price > 0.78) return null;
  // Sport gates: only fire on sports where score events have fast info
  const validSports = ['mlb','nba','nhl'];
  if (!validSports.includes(league)) return null;
  const edge = weTimeAdj - price;
  if (edge < 0.04) return null;
  return {
    trade: true, side: 'yes', confidence: weTimeAdj, betAmount: null,
    reasoning: {
      steel_man: `Score JUST changed; leader ${targetAbbr} now at ${(price*100).toFixed(0)}¢ but Kalshi MM may not have fully repriced`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (score-event arb): _scoreChanged=true on this cycle, leader ${targetAbbr} priced ${(price*100).toFixed(0)}¢, WE ${(weTimeAdj*100).toFixed(0)}% (${(edge*100).toFixed(0)}pt edge). Kalshi MM lags ESPN by 30-90s on score events; we capture the window.`,
      key_facts: [
        `Score event detected this cycle (${diff}-run/pt/goal lead)`,
        `Leader ${targetAbbr} at ${(price*100).toFixed(0)}¢ vs WE ${(weTimeAdj*100).toFixed(0)}%`,
        `Strategy: swing-exit at +5¢ on next cycle reprice`,
      ],
      top_risk: 'False score event (data anomaly) or Kalshi already repriced',
      conviction: 'Mechanical — pure information-lag arb, no game-state analysis needed',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'score-event-arb',
    _isScoreEventArb: true,
    _matchInfo: { period, diff, edge: edge * 100, price: Math.round(price*100) },
  };
}

// 2026-05-02 OFFENSIVE: NHL P3 empty-net pull window — TRAILER side bet.
// When NHL trailer is down 1-2 in P3 final 2 min, they pull the goalie for
// extra attacker. Scoring rate spikes ~5x normal (open net + 6v5 attackers).
// Trailer's price plummets to 8-15¢ but recovery probability is asymmetric:
// they only need 1 goal to tie (forcing OT, where price spikes to 50¢+).
//
// Math: at 12¢ entry on a true ~25% recovery rate (pulled-goalie spike):
//   25% × $0.88 - 75% × $0.12 = $0.22 - $0.09 = +$0.13/contract = +108% ROI per win
// Asymmetric pay covers wide WR misses. Pure swing — sell at 25¢+.
function detectNhlEmptyNetTrailer({ league, period, gameDetail, diff, price, targetAbbr, leadingAbbr }) {
  if (league !== 'nhl') return null;
  if (period !== 3) return null;
  if (targetAbbr === leadingAbbr) return null; // TRAILER only
  if (diff < 1 || diff > 2) return null; // 1-2 goal deficit (3+ won't recover)
  if (price == null) return null;
  // Parse minutes left in P3
  const m = (gameDetail || '').match(/^(\d+):(\d+)/);
  if (!m) return null;
  const minsLeft = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  if (minsLeft < 0.5 || minsLeft > 2.5) return null; // pull window only
  // Underdog asymmetric-pay band
  if (price < 0.06 || price > 0.20) return null;
  return {
    trade: true, side: 'yes', confidence: 0.25, betAmount: null,
    reasoning: {
      steel_man: `${diff}-goal deficit with ${minsLeft.toFixed(1)} min in P3 — goalie pulled, extra attacker, scoring rate ~5x`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (NHL empty-net pull window): ${targetAbbr} trailing by ${diff}, ${minsLeft.toFixed(1)} min left in P3, price ${(price*100).toFixed(0)}¢. Asymmetric pay covers true rate down to 13%.`,
      key_facts: [
        `P3 ${minsLeft.toFixed(1)} min, ${diff}-goal deficit, trailer pulling goalie`,
        `Empty-net + 6v5 attackers = ~5x normal scoring rate`,
        `Tie forces OT where trailer price spikes to 50¢+ (swing exit target)`,
      ],
      top_risk: 'Empty-net goal makes it 3-goal deficit, position goes to 0',
      conviction: 'Structural pattern — game-state-driven scoring rate spike',
      reasoning_tags: ['underdog-spot', 'we-undervalued', 'market-lag'],
    },
    _structuralPattern: 'nhl-empty-net-trailer',
    _matchInfo: { period, diff, minsLeft, price: Math.round(price*100) },
  };
}

function detectNhlP3ClosingOut({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr }) {
  if (league !== 'nhl') return null;
  if (period !== 3) return null;
  if (targetAbbr !== leadingAbbr) return null; // leader only
  if (weTimeAdj == null || price == null) return null;
  if (diff < 1) return null;

  // Parse minutes left in P3. Format examples: "8:32 - 3rd", "1:45 - 3rd".
  const m = (gameDetail || '').match(/^(\d+):(\d+)/);
  if (!m) return null;
  const minsLeft = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;

  // 2026-04-30 LOOSENED: NHL-P3 leader cell shows 92% WR (n=13) +14.8% EV in
  // shadow data but detector fired 0 times in 24h because conditions too tight.
  // Bumping ceiling 82¢ → 90¢ (NHL P3 leaders typically trade 80-92¢) and
  // expanding time window 2-10 → 2-12 min lets us actually catch this cell.
  // Closing-out window. Skip first 8 min (too much time) and last 2 min
  // (pulled-goalie variance on 1-goal leads).
  if (minsLeft > 12) return null;
  if (minsLeft < 2 && diff < 2) return null;

  const edge = weTimeAdj - price;
  // Edge requirements scaled by lead size:
  //   1-goal: ≥7pt edge (was 8pt) — high-variance cell, need clear edge
  //   2-goal: ≥4pt edge (was 5pt) — protective lead
  //   3+ goal: ≥3pt edge (NEW) — big leads need less edge
  const minEdge = diff === 1 ? 0.07 : (diff === 2 ? 0.04 : 0.03);
  if (edge < minEdge) return null;

  // 2026-05-02 v2: tightened d=1 cap further from 78¢ → 75¢. Bucket data:
  //   70-75¢: 50% WR (n=6) ⚠️ — was inside old 78¢ cap, leaking
  //   75-80¢: 75% WR (n=12) ✅ — sweet spot, but 75-78 is the ONLY allowed slice
  //   80-85¢: 56% WR (n=18) ⚠️ — blocked
  // Also block 70-75 explicitly: cap at 75¢ + minimum 70¢ for d=1 to skip the
  // coin-flip range. Net allowed for d=1: 70-75¢ (the proven sub-band).
  // Wait — better: cap at 78 BUT require >=75. Result: 75-78 only for d=1.
  if (diff === 1 && (price < 0.75 || price > 0.78)) return null;
  if (diff >= 2 && price > 0.90) return null;

  return {
    trade: true,
    side: 'yes',
    confidence: weTimeAdj,
    betAmount: null,
    reasoning: {
      steel_man: `Trailing team has ${minsLeft.toFixed(1)} minutes to score, may pull goalie for extra attacker`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (NHL P3 closing-out, historical 75% WR n=4): ${targetAbbr} leading by ${diff} goal${diff === 1 ? '' : 's'} with ${minsLeft.toFixed(1)} min left in P3, WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge. Time decay protects hockey leads.`,
      key_facts: [
        `P3 ${minsLeft.toFixed(1)} min left, ${diff}-goal lead`,
        `Time-adjusted WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢`,
        `Pattern: NHL P3 closing-out has been 3W/1L historical`,
      ],
      top_risk: 'Pulled goalie + extra attacker scoring in final 2 minutes',
      conviction: 'Structural pattern match — time decay favors leader in hockey late P3',
      reasoning_tags: ['market-lag', 'we-undervalued'],
    },
    _structuralPattern: 'nhl-p3-closing-out',
    _matchInfo: { minsLeft, diff, edge: edge * 100 },
  };
}

// Soccer 2H home-leader (early second half): 100% WR (5/5) historical pattern.
// Examples: FUL@AVL halftime entry (won), WHU@EVE pattern, MTL@NYC halftime.
// The pattern: home team leading by 1+ goals at start of second half (minute 45-65)
// in a major European league. Captures the "home crowd + half-time tactical reset
// favors leader" dynamic that the WE table partially misses for 1-goal margins.
//
// Excludes MLS (mixed historical, small sample) and minute > 65 (draw cliff
// approaching, EPL/LaLiga 70-min hard exit kicks in soon — better to enter earlier).
// Excludes away leaders (ATH/ATM 4/25 was the away-leader counter-example, lost).
// 2026-05-02 OFFENSIVE: Counter-equalizer soccer rally buy. When a leader's
// price has CRASHED on equalizer (was ≥55¢ in last 5 min, now ≤35¢), the
// market overshoots. If the leader is the structurally stronger team (home,
// or recently-leading), they often rally for the win.
//
// Math at 30¢ entry on a 35% recovery rate (post-equalizer rally to lead):
//   35% × $0.70 + 65% × (-$0.30) = $0.245 - $0.195 = +$0.05/contract = +17% ROI
// Asymmetric pay covers WR mis-calibration; entry was an OVERREACTION.
function detectSoccerCounterEqualizer({ league, period, gameDetail, diff, price, targetAbbr, leadingAbbr, homeAbbr, ticker }) {
  if (!['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(league)) return null;
  if (period !== 2) return null;
  if (diff !== 0) return null; // game must be tied (just equalized)
  if (price == null) return null;
  // Target must be the HOME team (structurally stronger, more likely to rally)
  if (targetAbbr !== homeAbbr) return null;
  // Entry band: 25-35¢ (post-crash dip, asymmetric pay)
  if (price < 0.25 || price > 0.35) return null;
  // Minute: 50-80 (room to rally, before draw-cliff)
  const m = (gameDetail || '').match(/^(\d+)/);
  if (!m) return null;
  const minute = parseInt(m[1], 10);
  if (minute < 50 || minute > 80) return null;
  // Require recent CONTRA crash on this ticker — confirms the equalizer
  // already happened (price already crashed, we're buying the dip).
  const contraMover = recentCrossContraMovers.get(ticker);
  if (!contraMover) return null;
  const contraAgeMin = (Date.now() - contraMover.when) / 60000;
  if (contraAgeMin > 5) return null; // crash must be recent
  if (contraMover.velocity < 8) return null; // must be a SHARP crash (8¢/min+)
  return {
    trade: true, side: 'yes', confidence: 0.40, betAmount: null,
    reasoning: {
      steel_man: `Home team's price crashed to ${(price*100).toFixed(0)}¢ at minute ${minute} after equalizer — market overshoot, structurally stronger home side often rallies`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (counter-equalizer rally): ${targetAbbr} home crashed ${contraMover.velocity.toFixed(1)}¢/min ${contraAgeMin.toFixed(1)}min ago, now ${(price*100).toFixed(0)}¢ at min ${minute}. Asymmetric pay covers 30% recovery rate.`,
      key_facts: [
        `Minute ${minute}, score tied, price ${(price*100).toFixed(0)}¢ post-crash`,
        `Recent contra: ${contraMover.velocity.toFixed(1)}¢/min ${contraAgeMin.toFixed(1)}min ago`,
        `Home team structural advantage — rally probability ~30-40%`,
      ],
      top_risk: 'Away team scores again, lock loss',
      conviction: 'Counter-trade market overshoot on equalizer — buy the dip',
      reasoning_tags: ['market-lag', 'underdog-spot', 'home-court'],
    },
    _structuralPattern: 'soccer-counter-equalizer-rally',
    _matchInfo: { minute, price: Math.round(price*100), contraVelocity: Math.round(contraMover.velocity*10)/10 },
  };
}

function detectSoccerHomeHTLeader({ league, period, gameDetail, diff, weTimeAdj, price, targetAbbr, leadingAbbr, homeAbbr }) {
  const europeanLeagues = ['epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'];
  if (!europeanLeagues.includes(league)) return null;
  if (period !== 2) return null; // 2nd half (includes HT)
  if (targetAbbr !== leadingAbbr) return null; // leader only
  if (targetAbbr !== homeAbbr) return null;     // HOME leader only — away pattern (ATH 4/25) failed
  if (weTimeAdj == null || price == null) return null;
  if (diff < 1) return null;

  const m = (gameDetail || '').match(/^(\d+)/);
  if (!m) return null;
  const minute = parseInt(m[1], 10);
  // 2026-05-02 v2: tightened minimum minute from 45 → 55. ALA@ATH 2026-05-02
  // bought at minute 46 with lead held for ~0 minutes of 2H, equalized 60
  // seconds later, -63% nuclear stop. The "100% WR n=5 historical" cell was
  // measured at later minutes when lead had been held longer. Minute 45-55
  // is the danger zone — halftime tactical reset hasn't played out yet.
  if (minute < 55 || minute > 65) return null;

  // Price cap from bucket audit. Shadow soccer-2H d=1:
  //   65-70¢: 60% WR (n=5) borderline
  //   70-75¢: 56% WR (n=9) ⚠️
  // Sub-65 sample is thin (n=3, 100% WR) but the trend is clear:
  // the high-price band leaks money. Cap at 65¢.
  if (price > 0.65) return null;

  const edge = weTimeAdj - price;
  if (edge < 0.05) return null;

  return {
    trade: true,
    side: 'yes',
    confidence: weTimeAdj,
    betAmount: null,
    reasoning: {
      steel_man: `Trailing team has ~${Math.max(0, 90 - minute)} minutes to mount a comeback against home opponent`,
      edge_source: 'market_lag',
      edge_argument: `STRUCTURAL DETECTOR (Soccer 2H home-leader, historical 100% WR n=5): ${targetAbbr} home, leading by ${diff} at minute ${minute}', WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ = ${(edge*100).toFixed(0)}pt edge — home-crowd + tactical-reset dynamic the WE table partially misses.`,
      key_facts: [
        `Minute ${minute}', home team ${targetAbbr} leading by ${diff} goal${diff === 1 ? '' : 's'}`,
        `Time-adjusted WE ${(weTimeAdj*100).toFixed(0)}% vs market ${(price*100).toFixed(0)}¢ (${(edge*100).toFixed(0)}pt edge)`,
        `Pattern: European-league home-leader 2H (FUL, WHU, MTL — all wins)`,
      ],
      top_risk: 'Late equalizer or comeback — a draw loses the WIN contract',
      conviction: 'Structural pattern match — 5/5 historical on home-leader 2H European',
      reasoning_tags: ['playoff-home-fav', 'we-undervalued', 'home-court'],
    },
    _structuralPattern: 'soccer-2h-home-leader',
    _matchInfo: { minute, diff, edge: edge * 100 },
  };
}
const CLAUDE_SCREENER = 'claude-haiku-4-5-20251001';  // Cheap screening — $0.002/call
const CLAUDE_DECIDER = 'claude-sonnet-4-6';            // Expensive analysis — only on candidates
// MAX_POSITIONS and deployment limits are DYNAMIC — see getMaxPositions() and getMaxDeployment()
const DAILY_LOSS_PCT = 0.25;       // Stop trading if down 25% in a day — room for bad streaks at small bankroll
const CAPITAL_RESERVE = 0.05;      // Keep 5% of bankroll untouched (more capital working)
const MAX_CONSECUTIVE_LOSSES = 7;  // After 7 losses → reduce size (5 in a row happens naturally every 2-3 weeks)
const SPORT_EXPOSURE_PCT = 0.25;   // Max 25% of bankroll per sport — sports are the main edge source

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
  // Kalshi signs path WITHOUT query string — strip before signing
  const pathOnly = path.split('?')[0];
  const fullPath = pathOnly.startsWith('/trade-api/v2') ? pathOnly : `/trade-api/v2${pathOnly}`;
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
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would POST ${path}: ${JSON.stringify(body).slice(0, 150)}`);
    return { ok: true, status: 200, data: { order: { order_id: 'dry-run', quantity_filled: body.count ?? 0 } } };
  }
  const res = await fetch(`${KALSHI_REST}${path}`, {
    method: 'POST', headers: kalshiHeaders('POST', path), body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

// 2026-05-01: kalshiDelete helper for cancelling orders.
// Previously phantom-trade-prevention logic just GAVE UP on orders that didn't
// fill within 1.5s, leaving them resting in the orderbook. They could then fill
// hours later when market moved through the limit price → orphan position the
// bot doesn't track. Now we actively CANCEL phantoms to prevent late fills.
async function kalshiDelete(path) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would DELETE ${path}`);
    return { ok: true, status: 200, data: {} };
  }
  const res = await fetch(`${KALSHI_REST}${path}`, {
    method: 'DELETE', headers: kalshiHeaders('DELETE', path),
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

// Initialize Ed25519 signing ONCE at module level — avoids frozen object error
let polySign = null;
let polyPrivBytes = null;
async function initPolySigning() {
  if (polySign) return; // already initialized
  if (!POLY_US_KEY_ID || !POLY_US_SECRET) return;
  try {
    const { createHash } = await import('crypto');
    const ed = await import('@noble/ed25519');
    // ed.etc may be frozen — use Object.defineProperty which works on frozen objects
    // or wrap sha512 at a higher level
    try {
      ed.etc.sha512Sync = (...m) => {
        const h = createHash('sha512');
        for (const msg of m) h.update(msg);
        return new Uint8Array(h.digest());
      };
    } catch {
      // Object is frozen — override via defineProperty on a fresh copy
      try {
        Object.defineProperty(ed.etc, 'sha512Sync', {
          value: (...m) => {
            const h = createHash('sha512');
            for (const msg of m) h.update(msg);
            return new Uint8Array(h.digest());
          },
          writable: true, configurable: true,
        });
      } catch {
        // Object is truly sealed — use signAsync which uses its own sha512
        // signAsync doesn't need sha512Sync set
      }
    }
    // Prefer signAsync (doesn't need sha512Sync) over sync sign
    polySign = ed.signAsync ?? ed.sign;
    polyPrivBytes = Uint8Array.from(atob(POLY_US_SECRET), c => c.charCodeAt(0)).slice(0, 32);
    console.log('[poly] Ed25519 signing initialized (using signAsync)');
  } catch (e) {
    console.error('[poly] init error:', e.message);
  }
}

async function polySignRequest(method, path) {
  if (!polySign) await initPolySigning();
  if (!polySign) return null;
  const ts = String(Date.now());
  // Polymarket US signature: timestamp + method + path (NO body)
  const message = `${ts}${method}${path}`;
  const sigBytes = await polySign(new TextEncoder().encode(message), polyPrivBytes);
  const signature = btoa(String.fromCharCode(...sigBytes));
  return {
    headers: {
      'X-PM-Access-Key': POLY_US_KEY_ID,
      'X-PM-Timestamp': ts,
      'X-PM-Signature': signature,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'arbor-ai/1',
    },
  };
}

async function refreshPolyBalance() {
  if (!POLY_US_KEY_ID || !POLY_US_SECRET) return;
  try {
    const path = '/v1/account/balances';
    const auth = await polySignRequest('GET', path);
    if (!auth) return;

    const res = await fetch(`${POLY_US_API}${path}`, {
      headers: auth.headers,
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

async function polymarketPost(slug, intent, price, quantity) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would POST Poly order: ${slug} ${intent} @${price} x${quantity}`);
    return { ok: true, status: 200, data: { id: 'dry-run', quantity_filled: quantity } };
  }
  if (!POLY_US_KEY_ID || !POLY_US_SECRET) {
    console.error('[poly-order] credentials not set');
    return { ok: false, status: 0, data: {} };
  }
  try {
    const path = '/v1/orders';
    const body = {
      marketSlug: slug,
      intent,
      type: 'ORDER_TYPE_LIMIT',
      price: { value: price.toFixed(2), currency: 'USD' },
      quantity: Math.round(quantity),
      tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    };
    const bodyStr = JSON.stringify(body);
    const auth = await polySignRequest('POST', path);
    if (!auth) return { ok: false, status: 0, data: {} };

    const res = await fetch(`${POLY_US_API}${path}`, {
      method: 'POST',
      headers: auth.headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[poly-order] FAILED ${res.status}:`, JSON.stringify(data));
    }
    console.log('[poly-order]', JSON.stringify({ status: res.status, slug, intent, price, quantity, response: data }));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    console.error('[poly-order] error:', e.message);
    return { ok: false, status: 0, data: {} };
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
// Standardized Telegram notification helpers — consistent format across all
// trade events. Every notification ends with today's running P&L summary so
// the user can see daily progress at a glance without checking the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

/** Compute today's P&L from settled trades (ET day). Cached briefly. */
let _todayPnLCache = { date: '', pnl: 0, wins: 0, losses: 0, fetchedAt: 0 };
function getDailyPnLSummary() {
  const today = etTodayStr();
  if (_todayPnLCache.date === today && Date.now() - _todayPnLCache.fetchedAt < 30000) {
    return _todayPnLCache;
  }
  let pnl = 0, wins = 0, losses = 0;
  try {
    if (existsSync(TRADES_LOG)) {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          if (t.realizedPnL == null) continue;
          const settled = t.settledAt ?? t.timestamp;
          if (!settled || tsToEtDate(settled) !== today) continue;
          pnl += t.realizedPnL;
          if (t.realizedPnL > 0) wins++;
          else if (t.realizedPnL < 0) losses++;
        } catch {}
      }
    }
  } catch {}
  _todayPnLCache = { date: today, pnl, wins, losses, fetchedAt: Date.now() };
  return _todayPnLCache;
}

/** CLV stats over a rolling window. Reads trades.jsonl, filters trades with clv != null,
 *  returns { all, byStrategy } summaries. Cached briefly to avoid hammering disk on every footer. */
let _clvStatsCache = { fetchedAt: 0, days: 0, summary: null };
function getClvStats({ days = 7 } = {}) {
  if (_clvStatsCache.summary && _clvStatsCache.days === days && Date.now() - _clvStatsCache.fetchedAt < 60_000) {
    return _clvStatsCache.summary;
  }
  if (!existsSync(TRADES_LOG)) return null;
  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const records = [];
    for (const l of lines) {
      try {
        const t = JSON.parse(l);
        if (typeof t.clv !== 'number') continue;
        if (!t.timestamp || Date.parse(t.timestamp) < cutoff) continue;
        records.push(t);
      } catch {}
    }
    if (records.length === 0) {
      _clvStatsCache = { fetchedAt: Date.now(), days, summary: null };
      return null;
    }
    const summarize = (recs) => {
      const n = recs.length;
      const sum = recs.reduce((s, t) => s + t.clv, 0);
      const positive = recs.filter(t => t.clv > 0).length;
      return { n, avgClv: sum / n, beatPct: positive / n };
    };
    const all = summarize(records);
    const byStrat = {};
    for (const r of records) {
      const s = r.strategy ?? 'unknown';
      if (!byStrat[s]) byStrat[s] = [];
      byStrat[s].push(r);
    }
    const byStrategy = {};
    for (const [s, recs] of Object.entries(byStrat)) {
      if (recs.length >= 5) byStrategy[s] = summarize(recs);
    }
    const summary = { all, byStrategy, windowDays: days };
    _clvStatsCache = { fetchedAt: Date.now(), days, summary };
    return summary;
  } catch {
    return null;
  }
}

/** Daily P&L footer line shown on every trade event notification.
 *  Includes 7-day CLV when sample is meaningful (n≥10). */
function dailyFooter() {
  const d = getDailyPnLSummary();
  const pnlStr = d.pnl >= 0 ? `+$${d.pnl.toFixed(2)}` : `-$${Math.abs(d.pnl).toFixed(2)}`;
  let line = `📈 Today: ${d.wins}W/${d.losses}L | <b>${pnlStr}</b>`;
  const clv = getClvStats({ days: 7 });
  if (clv?.all && clv.all.n >= 10) {
    const cents = Math.round(clv.all.avgClv * 100);
    const sign = cents >= 0 ? '+' : '';
    line += ` · 7d CLV ${sign}${cents}¢ (n=${clv.all.n})`;
  }
  return line;
}

/** Standard trade-entry notification. Used for live, pre-game, draw-bet, structural. */
async function tgTradeEntry({ kind, title, gameLine, team, price, qty, deployed, conf, edge, reason, strategyTag, isStructural = false }) {
  const icon = isStructural ? '🚀' : kind.includes('DRAW') ? '⚽' : kind.includes('UFC') ? '🥊' : kind.includes('PRE-GAME') ? '🎯' : '🎯';
  const lines = [
    `${icon} <b>${kind}</b>`,
    title,
  ];
  if (gameLine) lines.push(`<i>${gameLine}</i>`);
  lines.push(``);
  lines.push(`📊 <b>${team}</b> YES @ ${Math.round((price ?? 0) * 100)}¢ × ${qty} = <b>$${(deployed ?? 0).toFixed(2)}</b>`);
  if (conf != null && edge != null) {
    lines.push(`🎯 conf ${Math.round(conf * 100)}% · edge +${Math.round(edge)}pt${strategyTag ? ` · <code>${strategyTag}</code>` : ''}`);
  }
  // 2026-04-29: bump 200 → 350 char limit. Sonnet edge_arguments are 150-200 chars;
  // structural trades benefit from showing edge_argument + key_facts + conviction (~300 chars).
  if (reason) lines.push(`🧠 ${reason.slice(0, 350)}`);
  lines.push(``);
  lines.push(dailyFooter());
  return tg(lines.join('\n'));
}

/** Standard trade-exit notification. Used for profit-locks, stop-losses, profit-takes. */
async function tgTradeExit({ kind, title, entry, exit, qty, pnl, reason, isWin }) {
  const icon = isWin ? '✅' : pnl != null && pnl < 0 ? '❌' : '⚠️';
  const entryC = Math.round((entry ?? 0) * 100);
  const exitC = Math.round((exit ?? 0) * 100);
  const delta = exitC - entryC;
  const pctChange = entry > 0 ? Math.round((delta / entryC) * 100) : 0;
  const pnlStr = pnl != null ? (pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`) : 'TBD';
  const lines = [
    `${icon} <b>${kind}</b>`,
    title,
    ``,
    `📊 ${entryC}¢ → ${exitC}¢ (${delta >= 0 ? '+' : ''}${delta}¢, ${pctChange >= 0 ? '+' : ''}${pctChange}%)${qty != null ? ` × ${qty}` : ''}`,
    `💰 P&L: <b>${pnlStr}</b>`,
  ];
  if (reason) {
    lines.push(``);
    lines.push(`🧠 ${reason.slice(0, 200)}`);
  }
  lines.push(``);
  lines.push(dailyFooter());
  return tg(lines.join('\n'));
}

/** Standard settlement notification. */
async function tgSettlement({ title, won, pnl, source = 'Kalshi' }) {
  const icon = won ? '✅' : '❌';
  const verb = won ? 'WIN' : 'LOSS';
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  return tg(
    `${icon} <b>SETTLED — ${verb}</b> (${source})\n` +
    `${title}\n\n` +
    `💰 P&L: <b>${pnlStr}</b>\n\n` +
    dailyFooter()
  );
}

/** Bankroll milestone notifications. Fires when crossing meaningful thresholds.
 *  Bug fix 2026-04-27: previously _lastMilestoneHit started at 0 every restart,
 *  meaning on next settled trade it would fire ALL already-crossed milestones
 *  (false alerts). Now initialized to the highest milestone already passed at
 *  module load, so only NEW crossings fire. */
const BANKROLL_MILESTONES = [150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000];
let _lastMilestoneHit = 0;
let _milestoneInitialized = false;
async function checkBankrollMilestone() {
  const b = getBankroll();
  // First call: set _lastMilestoneHit to the highest already-crossed milestone
  // so we don't fire "you reached $150!" when bankroll is already at $300.
  if (!_milestoneInitialized) {
    for (const m of BANKROLL_MILESTONES) {
      if (b >= m) _lastMilestoneHit = m;
    }
    _milestoneInitialized = true;
    return;
  }
  if (b <= _lastMilestoneHit) return;
  for (const m of BANKROLL_MILESTONES) {
    if (b >= m && _lastMilestoneHit < m) {
      _lastMilestoneHit = m;
      const fromInitial = b - 100; // assume $100 starting
      const pctGrowth = ((b / 100 - 1) * 100).toFixed(0);
      await tg(
        `🎉 <b>BANKROLL MILESTONE — $${m}</b>\n\n` +
        `Bankroll just crossed <b>$${m}</b>!\n` +
        `Current: <b>$${b.toFixed(2)}</b>\n` +
        `Growth from $100: <b>+$${fromInitial.toFixed(2)}</b> (${pctGrowth}%)\n\n` +
        `Position sizes will scale up at this bankroll tier.\n\n` +
        dailyFooter()
      );
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude with Web Search — researches before deciding
// ─────────────────────────────────────────────────────────────────────────────

// Prices in $/1M tokens. Keys match model IDs; substring fallbacks below.
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { in: 1.00, out: 5.00, cwrite: 1.25, cread: 0.10 },
  'claude-sonnet-4-6':         { in: 3.00, out: 15.00, cwrite: 3.75, cread: 0.30 },
  'claude-sonnet-4-5-20250929':{ in: 3.00, out: 15.00, cwrite: 3.75, cread: 0.30 },
  'claude-opus-4-7':           { in: 15.00, out: 75.00, cwrite: 18.75, cread: 1.50 },
};
const WEB_SEARCH_COST_USD = 0.01; // $10 / 1000 searches
function priceFor(model) {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  if (/haiku/i.test(model)) return MODEL_PRICING['claude-haiku-4-5-20251001'];
  if (/opus/i.test(model)) return MODEL_PRICING['claude-opus-4-7'];
  return MODEL_PRICING['claude-sonnet-4-6'];
}

const API_USAGE_LOG = './logs/api-usage.jsonl';
const apiCostByCategory = new Map(); // category -> { calls, inputTok, outputTok, cacheReadTok, cacheWriteTok, searches, cents }

function recordUsage({ category, model, usage, searches = 0 }) {
  const p = priceFor(model);
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  // Cents = tokens/1e6 × $/M × 100 cents
  const cents =
    (inTok * p.in + outTok * p.out + cacheWrite * p.cwrite + cacheRead * p.cread) / 10_000 +
    searches * WEB_SEARCH_COST_USD * 100;

  const key = category || 'uncategorized';
  const b = apiCostByCategory.get(key) ?? {
    calls: 0, inputTok: 0, outputTok: 0, cacheReadTok: 0, cacheWriteTok: 0, searches: 0, cents: 0,
  };
  b.calls += 1;
  b.inputTok += inTok;
  b.outputTok += outTok;
  b.cacheReadTok += cacheRead;
  b.cacheWriteTok += cacheWrite;
  b.searches += searches;
  b.cents += cents;
  apiCostByCategory.set(key, b);

  stats.claudeCalls += 1;
  stats.apiSpendCents += cents;

  // Append to JSONL for dashboard history
  try {
    appendFileSync(API_USAGE_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      category: key, model,
      inputTok: inTok, outputTok: outTok,
      cacheReadTok: cacheRead, cacheWriteTok: cacheWrite,
      searches, cents,
    }) + '\n');
  } catch { /* non-fatal */ }
}

// Cheap Haiku screen — no web search
async function claudeScreen(prompt, { maxTokens = 300, timeout = 10000, category = 'screen' } = {}) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: AbortSignal.timeout(timeout),
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_SCREENER,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    recordUsage({ category, model: CLAUDE_SCREENER, usage: data.usage });
    return data.content?.[0]?.text ?? '';
  } catch (e) {
    console.error('[claude-screen] error:', e.message);
    return null;
  }
}

// Module-level transient-error tracker. Wrappers below catch errors and
// return null (the existing contract); batch callers using Promise.allSettled
// then see status='fulfilled' with a null value, which prevents the existing
// per-promise rejection-message check from detecting transient timeouts.
// Wrappers stamp this when they catch a transient; batch callers check it as
// a backstop. Race window is short and false-positives just suppress alerts.
//
// Escalation: per-event Telegram pings on transients are noise (we suppress
// them above), but a sustained Anthropic degradation IS something the user
// wants to know about. Track timestamps in a 1h ring; if count >= threshold,
// fire ONE summary alert and reset. Keeps the canary for real outages.
let _lastClaudeTransientErrorAt = 0;
let _claudeTransientTimestamps = []; // sliding 1h window
let _lastTransientEscalationAt = 0;
const CLAUDE_TRANSIENT_REGEX = /aborted|timeout|ECONNRESET|ETIMEDOUT|fetch failed|network/i;
const TRANSIENT_ESCALATION_THRESHOLD = 10;
const TRANSIENT_ESCALATION_WINDOW_MS = 60 * 60 * 1000;
function _markClaudeTransientIfApplicable(err) {
  if (err && CLAUDE_TRANSIENT_REGEX.test(err.message ?? String(err))) {
    const now = Date.now();
    _lastClaudeTransientErrorAt = now;
    // Trim ring to last hour, then add
    _claudeTransientTimestamps = _claudeTransientTimestamps.filter(t => now - t < TRANSIENT_ESCALATION_WINDOW_MS);
    _claudeTransientTimestamps.push(now);
    // Escalate if threshold hit AND we haven't escalated in the last hour
    if (_claudeTransientTimestamps.length >= TRANSIENT_ESCALATION_THRESHOLD &&
        (now - _lastTransientEscalationAt) >= TRANSIENT_ESCALATION_WINDOW_MS) {
      _lastTransientEscalationAt = now;
      const count = _claudeTransientTimestamps.length;
      _claudeTransientTimestamps = []; // reset ring after escalation
      tg(`🌐 <b>Anthropic web-search degraded</b>\n${count} transient Claude timeouts in last hour — bot is auto-skipping affected cycles. No action needed unless this continues.`).catch(() => {});
    }
  }
}
function _claudeTransientRecent(windowMs = 10000) {
  return (Date.now() - _lastClaudeTransientErrorAt) < windowMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Static prompt block for live-edge — extracted to enable Anthropic prompt caching.
// Contains the fully-static portions of the live-edge prompt: response format,
// steel-man resolution rules, Step 3 enforcement language. ~1500 tokens, above
// Anthropic's 1024-token cache minimum. Sent as the FIRST content block on every
// live-edge call (with cache_control: ephemeral); the dynamic per-game block
// follows. Cache hits reduce input cost ~10x on this prefix.
//
// Identical text to what was previously inlined at the end of the prompt — only
// the position changes (now front, was back). A trigger line at the end of the
// dynamic block points Claude back to this format ("respond per JSON format above").
// ─────────────────────────────────────────────────────────────────────────────
const LIVE_EDGE_STATIC_PREFIX = `═══ MANDATORY RESPONSE FORMAT — READ FIRST ═══
You will receive game-specific data and analysis instructions below this section. After reading them, you MUST respond with valid JSON in one of these two shapes ONLY — no prose, no markdown, no explanation outside JSON.

PASS response (no trade):
{"trade": false, "confidence": 0.XX, "reasoning": "why market is right / what disqualified this"}

TRADE response (placing a bet) — reasoning MUST be a structured object (not a string):
{"trade": true, "side": "yes", "confidence": 0.XX, "betAmount": N,
 "reasoning": {
   "steel_man": "sharp money's argument for the current price, in one sentence",
   "edge_source": "one tag from this list: bullpen_mismatch | starter_dominance | lineup_cold | market_lag | star_injury | goalie_mismatch | pace_mismatch | schedule_spot | motivation | other",
   "edge_argument": "our concrete reason the market is wrong, in one sentence",
   "key_facts": ["verifiable fact 1", "verifiable fact 2", "verifiable fact 3"],
   "top_risk": "what could still beat us, in one sentence",
   "conviction": "the single factor that pushed you over threshold",
   "reasoning_tags": ["1-3 short lowercase tags from this list ONLY: era-gap, playoff-home-fav, starter-mismatch, bullpen-mismatch, market-lag, public-fade, goalie-mismatch, lineup-cold, injury-news, line-movement, we-undervalued, momentum-shift, underdog-spot, schedule-spot, pitcher-form, star-injury, pace-mismatch, other"]
 }}
Every TRADE response MUST follow this exact schema. Do not substitute a string for the reasoning object.

🛡️ STEEL-MAN RESOLUTION (non-negotiable):
Before you return trade:true, your edge_argument MUST specifically defeat the steel_man — not just out-weigh it.
• If your steel_man names a concrete risk (injury, matchup, tired bullpen, strong home record) and your edge_argument does NOT address that specific risk with a verifiable fact — return trade:false.
• If your resolution is "yes steel-man is real but our edge is bigger" without naming WHY the steel-man is less load-bearing here — return trade:false.
• If steel_man and edge_argument are both strong and point opposite directions → the market is probably right → return trade:false.
• Valid resolution looks like: steel_man says "bullpen shaky" + edge_argument says "their setup man has 0.00 ERA last 10 appearances and is available tonight per ESPN". That's a specific defeat.
Your conviction field should name the specific fact that neutralizes the steel_man, not restate the edge.

⚠️ STEP 3 ENFORCEMENT (referenced below): The Step 3 adjustments in the league-specific section are ON TOP OF the WE baseline, not "already baked in." If a DOWN adjustment applies, you MUST subtract it. The arguments "the baseline already accounts for this," "the WE table already includes superior trailing teams," or any equivalent meta-argument that dismisses Step 3 adjustments are FORBIDDEN. Your reasoning MUST list the adjustments you applied with their numeric values (e.g., "trailing better -6, trailing at home -4 → final 61%"). If you cannot show this math in your reasoning, your decision is invalid. ATH/ATM 2026-04-25 was a real failure of this rule: bot bought ATH at 67% conf when 71% baseline minus -6 (ATM significantly better) minus -4 (ATM at home) = 61% cap, edge collapsed within 5 minutes.

═══ REASONING QUALITY STANDARDS ═══
Your reasoning is logged for calibration analysis and reviewed for systematic patterns. Hold yourself to these standards:

1. CITE SPECIFIC FACTS, NOT VIBES: "Their bullpen has been shaky" is invalid. "Their setup man has 7.20 ERA L10" is valid. Every claim in your edge_argument and key_facts must cite a verifiable number, name, or dated event from the GAME DATA below.

2. DEFEAT THE STEEL-MAN, DON'T OUTWEIGH IT: A real defeat looks like "steel_man cites bullpen risk → edge_argument cites confirmed elite closer with 0.00 ERA last 8 outings, available tonight." A non-defeat looks like "steel_man is real but our edge is bigger" — that's a tie, and ties go to the market.

3. NO SYNTHETIC EDGES: If you can't name a SPECIFIC mispriced factor, the gap is variance, not edge. The market sees the same public data you do. "Public is fading the favorite" is only valid if you can cite a published % public-money split. Otherwise it's projection.

4. CONFIDENCE IS NOT A NEGOTIATION: When the WE-vs-confidence gate constrains you, do not inflate confidence to clear it. Either you have edge under the gate or you don't. Inflating confidence by 2-3pts to "barely clear" is the single biggest source of bot losses historically.

5. UNDERDOG REVERENCE: If you're betting a sub-50% team, the math is HARDER, not easier. The market has already priced their underdog status. To earn an underdog confidence above the market, you need either (a) confirmed key opponent absence not in the price, or (b) specific tactical/stylistic mismatch with cited evidence. "They're motivated" or "they're due" are not edges.

═══ COMMON ANTI-PATTERNS (specific failures to avoid) ═══

❌ ANTI-PATTERN: "The market is at X¢ but my analysis says Y%, so the gap is the edge." This is not analysis — it's restating the price. Your edge requires a specific REASON the market is wrong. Without a reason, the gap IS the variance, not the edge.

❌ ANTI-PATTERN: "Cannot confirm injury status — applying uncertainty buffer and rejecting." Uncertainty is NEVER a Hard NO trigger by itself. Treat unavailable info as neutral. Only the Hard NOs in Step 2 block a trade.

❌ ANTI-PATTERN: Trade reasoning that doesn't include a numbered Step 3 adjustment ledger. "Confidence: 67% (from 71% baseline)" without showing the -4 adjustment line is incomplete. Show the math.

❌ ANTI-PATTERN: Citing players, coaches, or stats from prior seasons or different teams. Every cited fact must apply to the SPECIFIC teams in TODAY's game. If you can't verify in the GAME DATA below, don't cite it.

❌ ANTI-PATTERN: "I'd take the risk because the market is probably overcorrecting." Overcorrecting how? In what specific way? If you can't name the specific overcorrection, the gap is information you don't have, not edge.

❌ ANTI-PATTERN: Going to confidence ≥ 80% on any single trade. The historical 80%+ bucket has been near 50% actual WR — those reads are systematically overconfident. If your gut says 80%, calibrate to 72-75% and accept the smaller edge.

═══ REASONING TAG GLOSSARY (use only the relevant 1-3 tags) ═══
- era-gap: starting pitcher ERA differential ≥ 1.5pt with confirmed numbers
- starter-mismatch: top-of-rotation vs back-end starter, ace vs spot-starter
- bullpen-mismatch: confirmed bullpen tier differential ('elite' vs 'below'/'poor')
- pitcher-form: starter currently in dominant or struggling stretch (last 3-5 starts)
- goalie-mismatch: SV% gap ≥ 0.020 with confirmed games-played floor
- lineup-cold: trailing team batting average / shooting % significantly below season norm in this game
- pace-mismatch: NBA pace differential creating asymmetric scoring opportunities
- market-lag: prediction-market price hasn't yet absorbed a recent score/event we have data on
- public-fade: confirmed public-money split favoring the team being faded (cite the source)
- playoff-home-fav: home team in playoff/elimination game with crowd advantage
- we-undervalued: WE baseline materially exceeds market price with no concrete reason for the gap
- line-movement: recent confirming line movement validates our direction
- momentum-shift: trailing team just scored, ran a streak, or had a galvanizing event
- injury-news: confirmed injury (with player name) materially affecting outcome
- star-injury: high-impact star confirmed out (CHECK ROSTER — must be on the actual team)
- schedule-spot: back-to-back, long road trip, post-cross-country travel
- rest-advantage: opponent on second night of back-to-back or post-overtime fatigue
- back-to-back: opponent or our team playing consecutive nights
- home-court: meaningful home advantage (top home record, strong crowd)
- motivation: confirmed must-win game (relegation, playoff seeding, last game of streak)
- underdog-spot: betting a trailing team with structural reason (must include the reason)
- other: doesn't fit any of the above (use sparingly)

═══ END OF UNIVERSAL RULES — game-specific instructions and data follow ═══

`;

// ═══════════════════════════════════════════════════════════════════════════
// PRE-GAME STATIC FRAMEWORKS — per-sport instructions that NEVER change call
// to call. Moved into system prompt with cache_control so Anthropic caches the
// 1500-3000 token framework once per 5-minute window. The same content was
// previously sent fresh in every user prompt — pure billing optimization.
//
// Content is byte-identical to what was in pgPromptText before. Cache-read is
// billed at ~10% of fresh input cost. With ~110 pre-game calls/day across 4
// sports, expected savings: ~$3-5/day on input tokens.
// ═══════════════════════════════════════════════════════════════════════════

const PG_BASE_SYSTEM = `You are a professional sports betting analyst on prediction markets. You MUST respond with a single JSON object only — no prose, no explanation outside the JSON. Your entire response must be valid JSON.

`;

const NBA_PG_FRAMEWORK = `═══ NBA SWING-TRADE FRAMEWORK ═══
STRATEGY: We buy pre-game and SELL when the price rises to entry + 12¢ — we do NOT hold to settlement. The price rises whenever this team starts winning — scoring runs, building a lead, or the opponent struggling. Your confidence = "what is the real probability this team WINS today?" We are looking for teams the market is undervaluing.

📊 HISTORICAL DATA: NBA pre-game picks have gone 1-4 on trades where the only edge was "better team record + home court." The market prices those already. Play-In Tournament bets stacking "opponent missing star X (doubtful)" + "must-win motivation" have gone 0-2 on heavy underdogs (POR 18¢ → 75% conf → loss). DOUBTFUL players play ~40% of the time; do NOT stack a +30% swing on a single doubtful star.

⚠️ CORE FRAME: The market has already priced team records, home court, and obvious injury news. Your edge must be a SPECIFIC mispricing the market hasn't caught — NOT a re-confirmation of what the price already reflects.

⚠️ DATA RULES: ESPN roster data is injected in the user prompt — use it. You have ONE web search. Use it to check TODAY's injury report, back-to-back schedule, and rest news for both teams. If ESPN provided active/inactive players, those are confirmed — do NOT contradict them. For any star player whose 2026 status you cannot confirm after searching, apply a 3% uncertainty penalty and continue — do NOT use uncertainty as a reason to pass unless it would affect a Hard NO.
⚠️ ROSTER INTEGRITY: Only cite players who play for the SPECIFIC teams in this game. Do NOT reference players from other franchises.

WIN PROBABILITY BASELINE: NBA home teams win ~63% of games. A motivated team vs. a resting/eliminated opponent can push to 70%+. Teams on back-to-backs win ~45% of those games.

═══ STEP 2 — HARD NOs (respond {"trade":false} immediately if ANY apply) ═══
❌ Team you want to bet is confirmed resting 2+ starters (load management) → NO
❌ Team has clinched and cannot confirm stars playing meaningful minutes → NO
❌ Team on back-to-back AND star player is DOUBTFUL or OUT → NO
❌ No specific edge — just "they're the better team" → NO (already priced in)

═══ STEP 3 — WIN PROBABILITY EDGE ANALYSIS ═══
Start from 63% win rate (home) / 37% (away). Adjust based on confirmed research:
+ Opponent confirmed resting stars / eliminated / tanking → UP 8-12%
+ Your team in must-win / seeding-critical game vs lower-stakes opponent → UP 5-8%
+ Opponent back-to-back fatigue AND your team is rested → UP 4-6%
+ Clear matchup advantage (size, pace, system) confirmed by standings/stats → UP 3-5%
- Your team on back-to-back → DOWN 5-8%
- Star player (15+ ppg) OUT → DOWN 10-15%
- Opponent has a significant home/rest/motivation advantage → DOWN 4-8%

═══ STEP 4 — DECISION ═══
REMEMBER: confidence = P(this team wins the game). We exit at +12¢ — typically happens when the team builds a lead and the market reprices.
BUY only if ALL are true:
✓ Confidence ≥ 70% (win probability)
✓ Confidence beats current price by 4+ points
✓ You have a SPECIFIC edge catalyst — not just "better team"
🚫 THIN-EDGE REJECTION: if your only case is "better record + home court" OR "opponent missing Xth-best player" OR "playoff motivation," return {"trade":false}. These are market-priced. Need a non-obvious fact.
🚫 PLAY-IN / PLAYOFF UNDERDOG CAP: if the team is priced below 35¢ AND it's a Play-In or elimination game, MAX confidence = price + 12. A 7-seed does not have 60%+ probability to beat a 2-seed at home, even with their star doubtful.

📊 CONFIDENCE CALIBRATION — use this scale precisely:
  0.65 = marginal edge (1 weak factor confirmed)
  0.70 = clear edge (2+ independently confirmed factors)
  0.75 = strong edge (3 factors — injury, rest advantage, AND motivation/matchup)
  0.80+ = exceptional (reserved for opponent missing 2+ stars + confirmed tanking/rest + blowout matchup — all must be verified from your search, not assumed)
⛔ If you reach 0.75+, you MUST list each factor as a separate sentence in your reasoning. Stacking adjustments without independent confirmation = cap at 0.72.

⚠️ UNDERDOG REALITY CHECK — If the team you want to bet is priced below 35¢:
  The market says this team loses 65%+ of the time. NBA markets are the MOST efficient — seeding, talent, and home court are already priced in.
  YOUR MAX CONFIDENCE = market price + 15 points. Example: team at 18¢ → max 33%. Team at 30¢ → max 45%.
  • "Star is DOUBTFUL" ≠ "star is OUT." Doubtful players play ~40% of the time. Apply +5-8% bump for injury risk, NOT +30%.
  • A 62-win team at home does NOT lose to a 7-seed 75% of the time — even without their best player.
  • Playoff seeding gaps (1-4 seed vs 5-8 seed) are the strongest win predictor in NBA. Respect them.
  • If opponent is on a hot streak (5+ consecutive wins), that is CONFIRMED momentum the market has priced. Subtract 3-5% from your estimate.
  If your confidence exceeds price + 15 for a sub-35¢ team, you are delusional — re-anchor to the market.

`;

const NHL_PG_FRAMEWORK = `═══ NHL SWING-TRADE FRAMEWORK ═══
STRATEGY: We buy pre-game and SELL when price rises to entry + 12¢ — we do NOT hold to settlement. The price rises whenever this team starts winning — scoring first, building a lead, or the opponent struggling early. Your confidence = "what is the real probability this team WINS today?" We are looking for teams the market is undervaluing. Goalie matchup and special teams are the primary drivers in NHL win probability.

⚠️ DATA RULES: ESPN-confirmed goalies and their SV%/GAA are in the user prompt — those numbers are authoritative ground truth. Do NOT contradict ESPN stats with different values from training data. You have ONE web search — use it to check for late goalie changes, scratches, special teams rankings, and back-to-back schedule. If ESPN provided a goalie, treat them as CONFIRMED. Only fire Hard NO for "unconfirmed" if ESPN shows "NOT IN ESPN."
⚠️ ROSTER INTEGRITY: Only cite players who play for the SPECIFIC teams in this game. Do NOT reference players from other franchises.

WIN PROBABILITY BASELINE: NHL home teams win (in regulation + OT) ~55% of games. An elite goalie vs. a backup can push that to 62%+. A team on back-to-back drops to ~47%.

═══ STEP 2 — HARD NOs (respond {"trade":false} immediately if ANY apply) ═══
❌ Starting goalie for the team you want to bet cannot be confirmed by ESPN OR by ≥2 independent web sources (NHL.com, team official, major outlets) → NO. NOTE: if ESPN is silent but 2+ web sources name the goalie, that IS confirmed — proceed.
❌ Team has clinched everything AND cannot confirm starting goalie → NO
❌ Team on 3rd game in 4 nights AND opponent is rested → NO
❌ No specific edge — just "better team overall" → NO (already priced in)

═══ STEP 3 — WIN PROBABILITY EDGE ANALYSIS ═══
Start from 55% win rate (home) / 45% (away). Adjust based on confirmed research:
+ Elite goalie (SV% > .920) vs below-average opponent goalie (SV% < .905) → UP 8-12%
+ Your team top-5 power play AND opponent bottom-5 penalty kill → UP 4-6%
+ Opponent on back-to-back → UP 4-5%
+ Your team in must-win (seeding, playoff survival) vs lower-stakes opponent → UP 3-5%
- Backup goalie starting for your team → DOWN 8-12%
- Your team on back-to-back → DOWN 4-6%
- Opponent elite PP (top-5) AND your PK bottom-10 → DOWN 4-6%

═══ STEP 4 — DECISION ═══
REMEMBER: confidence = P(this team wins the game). We exit at +12¢ — typically happens when they score first and the market reprices their win probability.
BUY only if ALL are true:
✓ Confidence ≥ 70% (win probability)
✓ Confidence beats current price by 4+ points
✓ Goalie is confirmed AND you have a specific win-probability edge

📊 CONFIDENCE CALIBRATION — use this scale precisely:
  0.65 = slight edge (goalie mismatch alone, or back-to-back alone)
  0.70 = clear edge (elite goalie SV% > .920 vs backup, confirmed)
  0.75 = strong edge (elite goalie + fatigue disadvantage for opponent + motivation)
  0.80+ = exceptional (dominant goalie in playoff context + opponent depleted + home ice — all must be verified from search, not assumed)
⛔ SV%/GAA values in user prompt are from ESPN — use them exactly. If your search returns a different SV%, note both values.

⚠️ UNDERDOG REALITY CHECK — If the team you want to bet is priced below 35¢:
  YOUR MAX CONFIDENCE = market price + 18 points. Example: team at 25¢ → max 43%. Team at 30¢ → max 48%.
  NHL has more parity than NBA (goalie variance), but a team priced below 35¢ is a heavy underdog for a reason.
  • Goalie matchup alone justifies at most +12% uplift — not +40%.
  • Playoff series context matters: higher-seeded home teams win Game 1 ~60% historically. Respect home ice.
  • If opponent is on a hot streak (5+ game point streak), the market has priced that momentum in.
  If your confidence exceeds price + 18 for a sub-35¢ team, re-anchor to the market.

`;

const MLB_PG_FRAMEWORK = `═══ MLB SWING-TRADE FRAMEWORK ═══
STRATEGY: We buy pre-game and SELL when price rises to entry + 12¢ — we do NOT hold to settlement. The price rises whenever this team starts winning — scoring runs, building an early lead, or the opponent's starter struggling. Your confidence = "what is the real probability this team WINS today?"

⚠️ CORE FRAME: The market has already priced starting pitching, team records, home field, and recent form. These are NOT your edge — the market sees them too. Your job is to find situations where the market has MISPRICED a specific factor — OR where a spot-starter/opener disaster (ERA > 6.0) has been under-weighted. A 1-2pt ERA gap is not an edge; a 3+pt gap OR an opponent at ERA 6+ IS one.

📊 HISTORICAL DATA: MLB pre-game picks with 1-2pt ERA gaps went 8-16 (33% WR) for -$94 over our last sample. Picks with opponent ERA > 6.0 went 4-1 (80% WR) for +$95. The difference is real. Stop picking thin ERA gaps.

⚠️ DATA RULES: ESPN-confirmed starters and their ERA/WHIP are in the user prompt — those are authoritative ground truth. Do NOT override ESPN stats with different values from your training data or web search. You have ONE web search — use it for: last 5 starts form, bullpen rest, lineup injuries, any late scratches. Do NOT search for pitcher ERA — it is already provided.
⚠️ ROSTER INTEGRITY: Only cite players who play for the SPECIFIC teams in this game. Verify any player name you mention belongs to the listed teams.

WIN PROBABILITY BASELINE: MLB home teams win ~54% of games. An ace (ERA < 3.0) pitching vs. a weak lineup boosts that to ~62-65%. A weak starter (ERA > 5.0) drops it to ~42-46%.

═══ STEP 2 — HARD NOs (respond {"trade":false} immediately if ANY apply) ═══
⛔ THESE ARE ABSOLUTE. If ANY Hard NO applies, respond {"trade":false} immediately. Do NOT continue reasoning.
❌ Starting pitcher for the team you want to bet cannot be confirmed by ESPN OR by ≥2 independent web sources (MLB.com, Baseball-Reference, team site, ESPN article) → NO. NOTE: if ESPN is silent but 2+ web sources name the starter, that IS confirmed — proceed. Also NOTE: if this is an opener/bullpen game (both sides have no designated starter in ESPN), skip this rule and analyze at the team level.
⚠️ PITCHING MATCHUP GUIDANCE (NOT Hard NOs — these are confidence adjustments, not vetoes):
  • Your starter ERA > 5.0 AND opponent starter ERA < 3.5 → apply -6-10% adjustment, but do NOT auto-veto. Even bad pitchers sometimes hang 4-5 innings and the price can still swing +12¢ if their team scores early.
  • Both starters ERA 4.5-5.5 → coin-flip game. If WE-price edge is ≥ 8pt, a +12¢ swing is still reachable on early-inning luck. Don't auto-pass — assess the actual edge.
  • Opponent starter ERA < 2.5 AND WHIP < 1.0 → ace pitcher, apply -8% adjustment. But remember: we exit at +12¢, not at settlement. Even against aces, prices swing on early runs, errors, and bullpen changes. Don't veto unless the WE-price edge is below 5pt.
  The market has already priced pitching matchups. Your job is to find WE-vs-price gaps, not to re-litigate every pitcher duel.

═══ STEP 3 — WIN PROBABILITY EDGE ANALYSIS ═══
Start from 54% win rate (home) / 46% (away). Adjust based on confirmed research:
+ Opponent starter ERA > 6.0 (genuinely terrible — spot starter, emergency call-up, debut disaster) → UP 10-14% ← THIS IS THE REAL EDGE
+ Your ace (ERA < 2.5, WHIP < 1.05) vs opponent ERA > 5.5 → UP 8-10% (need BOTH ends of the gap to be extreme)
+ Your team top-tier bullpen (ERA < 3.5) → UP 2-3% (but market knows this too — small bump)
- Opponent has elite ace (ERA < 2.5, WHIP < 1.0) → DOWN 8-12%
- Your key lineup bat confirmed OUT → DOWN 4-6%

🚫 THIN-EDGE REJECTION: Do NOT stack 1-2pt ERA gaps + "strong lineup" + "home field" + "recent form" into a 66% confidence. Historical data says these are market-priced and net-losing. If your only case is a 1-3pt ERA gap, return {"trade":false}.

⚠️ CONFIDENCE CAP: For MLB, confidence above 65% requires EITHER: (a) opponent starter ERA > 6.0 confirmed, OR (b) your ace ERA < 2.5 AND opponent ERA > 5.5 (BOTH extremes). Any 2pt ERA gap on two mid-quality pitchers is NOT enough — cap at 62% and likely pass.

═══ STEP 4 — DECISION ═══
REMEMBER: confidence = P(this team wins the game). We exit at +12¢ — typically happens after they score early and the market reprices. A clear pitching edge translates to win probability and contract price movement.
BUY only if ALL are true:
✓ Confidence meets the price-tiered floor: price<50¢ → ≥63%, price 50-65¢ → ≥66%, price>65¢ → ≥68%. Do NOT return exactly 65% for a mid-price favorite — either you have genuine 66%+ conviction or it's a pass.
✓ Confidence beats current price by the required margin (typically 4+ points)
✓ Both starters confirmed AND there's a clear pitching/matchup edge
🎯 EDGE-FIRST HALF-SIZE EXCEPTION (NON-MLB ONLY): If this is NBA/NHL/soccer AND the team is priced ≤ 55¢ AND your honest confidence is 58-65% AND the edge (confidence − price) is ≥ 10 points, that IS a valid trade — we take it at half size. Do NOT write "HARD PASS" or return {"trade":false} just because you didn't hit 66%. Return {"trade":true} with your real confidence (58-65%), and the bot will auto-size. The reasoning you write gets stored for calibration — don't contradict yourself.
🧊 MLB PRE-GAME EDGE-FIRST IS FROZEN (went 1-5 on 2026-04-22). For MLB, the standard 66%+ floor applies — there is NO half-size exception today. If you're under 66% on MLB pre-game, just return {"trade":false}.

📊 CONFIDENCE CALIBRATION — MLB scale (MLB is the most random sport — tightened 2026-04-23 per 45-trade post-mortem):
  0.62 = marginal — ERA gap 3-4pt, must be your only edge; expect high variance
  0.66 = clear edge — opponent ERA > 5.5 confirmed OR your ace ERA < 2.8 vs their ERA > 4.5
  0.70 = strong edge — opponent ERA > 6.0 (emergency starter) confirmed
  0.73+ = exceptional — opponent ERA > 6.5 + confirmed lineup injuries; needs 3 independent factors
  ⛔ DO NOT hit 0.68+ on "solid ace vs mediocre starter." Our data: 8-16 on that bucket (-$94). Reject those.
⛔ ESPN ERA/WHIP in user prompt are ground truth. If you write a different ERA in your reasoning than what ESPN shows, your analysis is invalid. Use the ESPN number.

⚠️ UNDERDOG REALITY CHECK — If the team you want to bet is priced below 35¢:
  YOUR MAX CONFIDENCE = market price + 20 points. Example: team at 25¢ → max 45%. Team at 30¢ → max 50%.
  MLB is the most random sport, so underdogs win more often — but the market knows that too.
  • A pitching mismatch (ace vs journeyman) justifies at most +12-15% uplift, not +30%.
  • If opponent is on a hot streak (5+ consecutive wins), their lineup is locked in — subtract 3-5% from your estimate.
  • Even the worst MLB team wins ~38% of its games. A team priced at 30¢ is already below that floor — there's a specific reason.
  If your confidence exceeds price + 20 for a sub-35¢ team, re-anchor to the market.

`;

const SOCCER_PG_FRAMEWORK = `═══ SOCCER SWING-TRADE FRAMEWORK ═══
STRATEGY: We buy pre-game and SELL when price rises to entry + 12¢ — we do NOT hold to settlement. The price rises whenever this team starts winning — scoring, building a lead, or dominating possession while the opponent struggles. Your confidence = "what is the real probability this team WINS today?" We are looking for teams the market is undervaluing. A strong attack vs. a leaky defense produces both goals AND win probability. A draw only hurts if we're still holding at the end.

⚠️ DATA RULES: You have ONE web search. Use it to check TODAY's team news, key injuries, form, and motivation context. If you cannot confirm a key injury after searching, treat the player as available but apply a 2% uncertainty buffer. Do NOT use uncertainty as a reason to pass unless it affects a Hard NO.

WIN PROBABILITY BASELINE: Soccer home teams win (regulation) ~45% of games, draw ~27%, away ~28%. Strong home sides vs. weak away teams can reach 55-60% win probability.

⚠️ DRAW TAX (KEY): Your confidence = P(team wins). A TIE is NOT a loss on your ledger but IS a loss on our contract — we need the team to WIN outright. If the TIE leg is priced ≥30¢, ~30%+ of outcomes are draws and your win confidence must be computed AGAINST that, not on top of it. Example: if you think home team is "clearly better," they still face ~30% draw probability before they even face loss probability. Ceiling that thinking.

📊 HISTORICAL DATA: Soccer pre-game picks at <40¢ entry with 30pt+ claimed edges have gone 1-2 (-$18 on NE-CLB MLS at 36¢ / 68% conf). Don't stack "unbeaten home run" + "opponent missing scorer" + "motivation" into a 70% prob on a 36¢ team — the market is telling you they're heavy underdogs for a reason that survives all three.

═══ STEP 2 — HARD NOs (respond {"trade":false} immediately if ANY apply) ═══
❌ Your team's key striker is confirmed OUT AND opponent defense is strong → NO
❌ Both teams are defensive/low-scoring (under 1 goal per game each) → NO (likely to draw, price won't move)
❌ No specific edge — just "they're better overall" → NO (already priced in)

═══ STEP 3 — WIN PROBABILITY EDGE ANALYSIS ═══
Start from 45% win rate (home) / 28% (away). Adjust based on confirmed research:
+ Your team scores 2+ per game AND opponent defense concedes 1.5+ per game → UP 8-12%
+ Your team in must-win (relegation, title run, European spot) vs lower-stakes opponent → UP 5-8%
+ Opponent missing key central defender or goalkeeper → UP 4-6%
+ Strong home record at this venue (60%+ win rate) → UP 3-5%
- Your team's starting striker confirmed OUT → DOWN 8-12%
- Opponent elite defense (conceding under 0.8 per game) → DOWN 6-10%
- Your team low-scoring (under 1.2 goals per game) → DOWN 5-8%

═══ STEP 4 — DECISION ═══
REMEMBER: confidence = P(this team wins the game in regulation). We exit at +12¢ — typically happens when they score and the market reprices their win probability upward.
BUY only if ALL are true:
✓ Confidence ≥ 65% (win probability)
✓ Confidence beats current price by 4+ points
✓ You have a specific confirmed win-probability catalyst

📊 CONFIDENCE CALIBRATION — Soccer scale (draw rate ~25% is a major suppressor):
  0.65 = marginal edge (home favorite + leaky opponent defense)
  0.70 = clear edge (prolific attack 2+/game vs defense conceding 1.5+/game, confirmed)
  0.75 = strong edge (dominant home side + opponent missing key striker + motivation gap)
  0.80+ = exceptional (all three: dominant attack, confirmed injuries to opponent, must-win context — all from search, not assumed)

⚠️ UNDERDOG REALITY CHECK — If the team you want to bet is priced below 35¢:
  YOUR MAX CONFIDENCE = market price + 15 points. Example: team at 25¢ → max 40%.
  Soccer underdogs face a double penalty: they must beat the opponent AND avoid a draw (~25% of games draw).
  • Away underdogs win only ~15-20% of matches against top-half home sides. The market knows this.
  • A key absence for the opponent adds at most +5-8% — not enough to flip an underdog into a favorite.
  If your confidence exceeds price + 15 for a sub-35¢ team, re-anchor to the market.

`;

// Pre-game sportsbook-gap detector — mechanical fire when Kalshi underprices a
// team relative to ESPN's sharp sportsbook consensus by 5-15pt. Bypasses Sonnet
// entirely (saves API cost + faster reaction). The sportsbook IS the sharp market;
// when Kalshi differs by 5+pt, that's market lag — pure +EV by definition since
// sharps and Kalshi disagree and sharps are usually right.
//
// Returns synthetic decision shaped like Sonnet's output, or null if no gap.
// Caller should attach to item._structuralDecision and bypass Sonnet call.
//
// Constraints:
//   - Gap 5-15pt (smaller = noise; larger = likely data issue or stale sportsbook line)
//   - Kalshi price 30-68¢ (avoid deep-underdog asymmetry + capped upside at 70+¢)
//   - Reasoning_tag: market-lag (proven 61% WR cell from auto-cal data)
function detectPregameSportsbookGap(market, sportsbookData, sport) {
  if (!sportsbookData || !market) return null;
  const t1Price = market.team1?.price;
  const t2Price = market.team2?.price;
  if (t1Price == null || t2Price == null) return null;
  // Determine sportsbook prob for each team
  const _t1 = (market.team1?.team ?? '').toUpperCase();
  const _t2 = (market.team2?.team ?? '').toUpperCase();
  // sportsbookData stored with key "AWAY-HOME" — figure out which way
  // Simpler: the lookup function returned the entry. Caller gives us isT1Away flag context.
  // For this detector we re-lookup to determine orientation:
  let t1Prob, t2Prob, source;
  if (sportsbookData.isT1Away !== undefined) {
    t1Prob = sportsbookData.isT1Away ? sportsbookData.awayProb : sportsbookData.homeProb;
    t2Prob = sportsbookData.isT1Away ? sportsbookData.homeProb : sportsbookData.awayProb;
    source = sportsbookData.source;
  } else {
    return null;
  }
  // Compute gaps for each side: positive = Kalshi UNDERPRICES (we buy)
  const t1Gap = t1Prob - t1Price;
  const t2Gap = t2Prob - t2Price;
  let pick = null;
  if (t1Gap >= 0.05 && t1Gap <= 0.15 && t1Price >= 0.30 && t1Price <= 0.68) {
    pick = { team: market.team1, gap: t1Gap, prob: t1Prob };
  } else if (t2Gap >= 0.05 && t2Gap <= 0.15 && t2Price >= 0.30 && t2Price <= 0.68) {
    pick = { team: market.team2, gap: t2Gap, prob: t2Prob };
  }
  if (!pick) return null;
  return {
    trade: true,
    team: pick.team.team,
    confidence: Math.round(pick.prob * 100) / 100,
    betAmount: null,
    exitScenario: `sportsbook ${Math.round(pick.prob*100)}% vs Kalshi ${Math.round(pick.team.price*100)}¢ (${Math.round(pick.gap*100)}pt gap) — Kalshi reprices when news/sharp money catches up`,
    reasoning: `STRUCTURAL DETECTOR (sportsbook-gap mechanical): ${pick.team.team} sportsbook no-vig ${(pick.prob*100).toFixed(0)}% vs Kalshi ${Math.round(pick.team.price*100)}¢ = ${(pick.gap*100).toFixed(0)}pt gap. Sportsbook is the sharp market. Kalshi will reprice toward consensus.`,
    reasoning_tags: ['market-lag', 'we-undervalued'],
    _structuralPattern: 'pre-game-sportsbook-gap',
    _matchInfo: { gap: Math.round(pick.gap * 100), prob: Math.round(pick.prob * 100), source },
  };
}

function getPgFramework(sport) {
  if (sport === 'NBA') return NBA_PG_FRAMEWORK;
  if (sport === 'NHL') return NHL_PG_FRAMEWORK;
  if (sport === 'MLB') return MLB_PG_FRAMEWORK;
  return SOCCER_PG_FRAMEWORK;
}

// Prompt-caching support — opt-in via array-form prompt or cacheSystem flag.
// `prompt` can be a string (existing contract, no caching) OR an array of content
// blocks `[{type:'text', text:'...', cache_control?:{type:'ephemeral'}}, ...]`.
// `cacheSystem: true` wraps the system prompt with cache_control for the static
// instruction stem. Both are no-ops on existing string callers — safe to land
// without changing any call site behavior.
//
// Sonnet without web search — for decisions where we already have the data we need.
// ─────────────────────────────────────────────────────────────────────────────
// OpenAI fallback (2026-05-02) — when Anthropic credits are exhausted or auth
// fails, fall back to GPT-5 so the bot keeps trading on live-edge cells.
//
// CALIBRATION NOTE: GPT-5 baseline confidence runs 5-10pt higher than Claude
// Sonnet on the same setup. Mitigations applied:
//   1. Calibration nudge appended to prompt (be conservative)
//   2. Tag provider in response so caller can apply higher edge floor
//   3. Track separately in shadow data via _openaiFallback marker
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_FALLBACK_MARKER = '_openaiFallback';

function _normalizePromptToString(prompt) {
  // claudeSonnet supports both string and array-of-content-blocks (for caching).
  // OpenAI doesn't support content-block caching the same way. Concat to string.
  if (Array.isArray(prompt)) {
    return prompt.map(b => typeof b === 'string' ? b : (b?.text ?? '')).join('\n\n');
  }
  return prompt ?? '';
}

const OPENAI_CALIBRATION_NOTE = '\n\n[CALIBRATION INSTRUCTION: This system was calibrated against Claude Sonnet output. GPT-5 tends to anchor 5-10 percentage points higher on confidence than Sonnet for the same situation. Report your `confidence` value 4-5 percentage points BELOW your gut estimate to align with the downstream thresholds. Be conservative — if you would normally say 75%, report 70-71%. The bot already has structural detectors for clear-cut cases; your role here is judgment under uncertainty, so erring conservative is the right move.]';

async function openaiSonnet(prompt, { maxTokens = 1024, timeout = 30000, system = null, category = 'openai-sonnet' } = {}) {
  if (!OPENAI_KEY) {
    console.error('[openai-sonnet] OPENAI_API_KEY not set — fallback unavailable');
    return null;
  }
  try {
    const userText = _normalizePromptToString(prompt) + OPENAI_CALIBRATION_NOTE;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: userText });
    const body = {
      model: OPENAI_DECIDER,
      max_completion_tokens: maxTokens,
      messages,
      reasoning_effort: 'minimal', // fast structured output, no deep thinking needed
    };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      signal: AbortSignal.timeout(timeout),
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[openai-sonnet] HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage ?? {};
    console.log(`[openai-sonnet] ✅ used (cat=${category}) tokens=${usage.total_tokens ?? '?'} (in=${usage.prompt_tokens ?? '?'} out=${usage.completion_tokens ?? '?'})`);
    // Inject provenance marker into the JSON response so callers can tag trade.
    // We do this by string-injection into the JSON body if it parses cleanly.
    if (text && text.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(text.replace(/```json\s*|\s*```/g, '').trim());
        parsed[OPENAI_FALLBACK_MARKER] = true;
        return JSON.stringify(parsed);
      } catch { /* not clean JSON, return raw */ }
    }
    return text;
  } catch (e) {
    console.error('[openai-sonnet] error:', e.message);
    return null;
  }
}

function _isClaudeBillingError(status, errBody) {
  if (status === 401 || status === 403) return true;
  if (typeof errBody !== 'string') return false;
  return errBody.includes('credit balance') || errBody.includes('credits') || errBody.includes('billing');
}

async function claudeSonnet(prompt, { maxTokens = 1024, timeout = 30000, system = null, category = 'sonnet', cacheSystem = false } = {}) {
  try {
    const body = {
      model: CLAUDE_DECIDER,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    };
    if (system) {
      body.system = cacheSystem
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system;
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: AbortSignal.timeout(timeout),
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('[claude-sonnet] HTTP', res.status, errBody);
      // 2026-05-02: fallback to OpenAI on credit/auth errors. Returns OpenAI
      // response with _openaiFallback marker in the JSON for downstream tagging.
      if (_isClaudeBillingError(res.status, errBody)) {
        console.log(`[claude-sonnet] → falling back to GPT-5 (cat=${category})`);
        return await openaiSonnet(prompt, { maxTokens, timeout, system, category: `${category}-openai` });
      }
      return null;
    }
    const data = await res.json();
    recordUsage({ category, model: CLAUDE_DECIDER, usage: data.usage });
    const textBlocks = (data.content ?? []).filter(b => b.type === 'text');
    return textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : '';
  } catch (e) {
    _markClaudeTransientIfApplicable(e);
    console.error('[claude-sonnet] error:', e.message);
    return null;
  }
}

// Expensive Sonnet + web search — only for final trade decisions.
// Same caching contract as claudeSonnet: pass array prompt for content-block caching,
// pass `cacheSystem: true` to cache the system stem. Strings still work unchanged.
async function claudeWithSearch(prompt, { maxTokens = 1024, maxSearches = 3, timeout = 45000, system = null, category = 'search', cacheSystem = false } = {}) {
  try {
    const body = {
      model: CLAUDE_DECIDER,
      max_tokens: maxTokens,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: maxSearches,
      }],
      messages: [{ role: 'user', content: prompt }],
    };
    if (system) {
      body.system = cacheSystem
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system;
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: AbortSignal.timeout(timeout),
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('[claude-search] HTTP', res.status, errBody);
      // 2026-05-02: fallback to OpenAI (no search) when credits/auth fail.
      // Loses the breaking-news search capability but at least gets a decision.
      if (_isClaudeBillingError(res.status, errBody)) {
        console.log(`[claude-search] → falling back to GPT-5 NO-SEARCH (cat=${category})`);
        return await openaiSonnet(prompt, { maxTokens, timeout, system, category: `${category}-openai-nosearch` });
      }
      return null;
    }

    const data = await res.json();
    const textBlocks = (data.content ?? []).filter(b => b.type === 'text');
    const searches = (data.content ?? []).filter(b => b.type === 'server_tool_use').length;
    if (searches > 0) console.log(`[claude-search] Used ${searches} web searches`);
    recordUsage({ category, model: CLAUDE_DECIDER, usage: data.usage, searches });

    // Return last text block (Claude's final answer after research)
    const finalText = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : '';
    if (!finalText && textBlocks.length === 0) {
      console.log(`[claude-search] WARNING: No text blocks in response. Content types: ${(data.content ?? []).map(b => b.type).join(', ')}`);
    }
    return finalText;
  } catch (e) {
    _markClaudeTransientIfApplicable(e);
    console.error('[claude-search] error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let lastHighConvictionAt = 0;      // timestamp of last high-conviction bet
let highConvictionDeployed = 0;    // total $ in active high-conviction bets
let lastHCLossAt = 0;              // timestamp of most recent HC loss (triggers 24h HC cooldown)

// Scan timer state — declared here (before loadState) to avoid TDZ errors on startup
let lastBroadScan = 0;     // moved from line ~2981
let lastPreGameScan = 0;   // moved from line ~2329
let lastUFCScan = 0;       // moved from line ~2812

// ─────────────────────────────────────────────────────────────────────────────
// State Persistence — survives restarts so we don't re-fire scans or burn credits
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = './logs/state.json';

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      lastBroadScan,
      lastPreGameScan,
      lastUFCScan,
      lastHighConvictionAt,
      highConvictionDeployed,
      lastHCLossAt,
      stopLocks: Object.fromEntries([...stopLocks.entries()].filter(([, v]) => v > Date.now())),
      stoppedBets: Object.fromEntries([...stoppedBets.entries()].filter(([, v]) => Date.now() - v.stoppedAt < 4 * 60 * 60 * 1000)),
      savedAt: Date.now(),
    }));
  } catch (e) { console.error('[state] save error:', e.message); }
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    // Only restore if state was saved recently (within 2 hours) — stale state is useless
    if (!s.savedAt || Date.now() - s.savedAt > 2 * 60 * 60 * 1000) {
      console.log('[state] State file too old, starting fresh');
      return;
    }
    if (s.lastBroadScan) lastBroadScan = s.lastBroadScan;
    if (s.lastPreGameScan) lastPreGameScan = s.lastPreGameScan;
    if (s.lastUFCScan) lastUFCScan = s.lastUFCScan;
    if (s.lastHighConvictionAt) lastHighConvictionAt = s.lastHighConvictionAt;
    if (s.highConvictionDeployed) highConvictionDeployed = s.highConvictionDeployed;
    if (s.lastHCLossAt) lastHCLossAt = s.lastHCLossAt;
    if (s.stopLocks) {
      for (const [base, unlockMs] of Object.entries(s.stopLocks)) {
        if (unlockMs > Date.now()) {
          stopLocks.set(base, unlockMs);
          tradeCooldowns.set(base, unlockMs - COOLDOWN_MS);
          console.log(`[state] Restored stop-lock on ${base} — expires in ${Math.round((unlockMs - Date.now()) / 60000)}min`);
        }
      }
    }
    if (s.stoppedBets) {
      for (const [base, info] of Object.entries(s.stoppedBets)) {
        if (Date.now() - info.stoppedAt < 4 * 60 * 60 * 1000) {
          stoppedBets.set(base, info);
          console.log(`[state] Restored stopped-bet on ${base} (${info.team}) — eligible for thesis-vindicated re-entry`);
        }
      }
    }
    const broadWait = Math.max(0, Math.round((s.lastBroadScan + 1800000 - Date.now()) / 1000));
    const preWait = Math.max(0, Math.round((s.lastPreGameScan + 900000 - Date.now()) / 1000));
    console.log(`[state] Restored — broad scan in ${broadWait}s, pre-game in ${preWait}s`);
  } catch (e) { console.error('[state] load error:', e.message); }
}
const tradeCooldowns = new Map(); // ticker → lastTradedMs
// After a swing trade exits (stop, thesis-expiry, or profit-lock), record the
// state it exited in. For the next 20 min, a re-entry on the same gameBase
// is blocked UNLESS the score has changed OR price has moved ≥5¢ better than
// the exit price. Prevents chasing the same dead thesis scan after scan.
const swingExitState = new Map(); // gameBase → { ts, scoreKey, exitPrice, reason }
const stopLocks = new Map();      // gameBase → unlockTimestampMs (persisted across restarts)
const stoppedBets = new Map();    // gameBase → { team, stoppedAt, entryPrice } (persisted — enables thesis-vindicated re-entry)
const lastGameStates = new Map(); // "ATH@NYM" → "1-0-5" (score-period, for change detection)
const gameEntries = new Map();    // "game:ATH@NYM" → { count: 2, lastPrice: 0.62, totalDeployed: 24.36 }
const lastSeenPrices = new Map(); // ticker → { price, ts } for line movement detection

// 2026-05-01: Phantom order tracker for orphan recovery. When phantom-trade-prevention
// fires AND we couldn't successfully cancel the order (race condition with fill), we
// track the order context here. If the order later fills (showing up as an "untracked
// position" in Kalshi sync), the reconciler can adopt it as a recovered bot trade with
// proper strategy + entry context — instead of mislabeling it as a manual bet.
//
// Real incident 2026-05-01 21:17 ET: bot placed ORL buy at 53¢ at 7:45 PM, gave up
// after 1.5s, order rested 1h 18min, filled at 9:03 PM at 55¢ × 9 contracts. Bot
// then bought ANOTHER 8 contracts at 9:04 PM via structural detector. Net: 17
// contracts on Kalshi vs 8 in bot's records → orphan 9 contracts unmanaged.
const phantomOrderTracker = new Map(); // orderId -> { ticker, attemptedQty, price, ts, league, confidence, strategy }
const PHANTOM_TRACKER_TTL_MS = 4 * 60 * 60 * 1000; // 4h — orders rarely rest longer

// 2026-05-01 Tier 3 — cached ESPN /summary fetcher for NBA/NHL deep extraction
// (player fouls, goalie info, PP state). Cached per-eventId for 60s to avoid
// hammering ESPN on every live-edge cycle. Used in live-edge shadow log path.
const espnSummaryCache = new Map(); // eventId → { data, fetchedAt }
const ESPN_SUMMARY_TTL_MS = 60 * 1000;
async function getEspnSummary(eventId, sportPath) {
  if (!eventId || !sportPath) return null;
  const cached = espnSummaryCache.get(eventId);
  if (cached && Date.now() - cached.fetchedAt < ESPN_SUMMARY_TTL_MS) return cached.data;
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/summary?event=${eventId}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    espnSummaryCache.set(eventId, { data, fetchedAt: Date.now() });
    if (espnSummaryCache.size > 200) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, v] of espnSummaryCache) if (v.fetchedAt < cutoff) espnSummaryCache.delete(k);
    }
    return data;
  } catch { return null; }
}

// 2026-05-01 — NHL goalie history persistence. Tracks which goalies started
// each NHL game over the last 3 days. Used to detect back-to-back starts
// (likely backup tonight) — a major edge factor.
const NHL_GOALIE_HISTORY_FILE = './logs/nhl-goalie-history.json';
function loadNhlGoalieHistory() {
  try {
    if (!existsSync(NHL_GOALIE_HISTORY_FILE)) return {};
    return JSON.parse(readFileSync(NHL_GOALIE_HISTORY_FILE, 'utf-8'));
  } catch { return {}; }
}
function saveNhlGoalieHistory(history) {
  try {
    // Prune entries older than 4 days
    const cutoff = Date.now() - 4 * 86400 * 1000;
    const pruned = {};
    for (const [name, info] of Object.entries(history)) {
      if (info?.lastStartTs > cutoff) pruned[name] = info;
    }
    writeFileSync(NHL_GOALIE_HISTORY_FILE, JSON.stringify(pruned, null, 2));
  } catch { /* best-effort */ }
}
function recordNhlGoalieStart(goalieName, teamAbbr) {
  if (!goalieName) return;
  const history = loadNhlGoalieHistory();
  history[goalieName] = { lastStartTs: Date.now(), team: teamAbbr };
  saveNhlGoalieHistory(history);
}
function isGoalieBackToBack(goalieName) {
  if (!goalieName) return false;
  const history = loadNhlGoalieHistory();
  const info = history[goalieName];
  if (!info?.lastStartTs) return false;
  const hoursAgo = (Date.now() - info.lastStartTs) / (3600 * 1000);
  // Back-to-back = started within last 18-30 hours (yesterday's game)
  return hoursAgo > 18 && hoursAgo < 36;
}
const LINE_MOVE_THRESHOLD = 0.05; // 5¢ move = something happened
const missingFromKalshi = new Map(); // tradeId → firstMissingMs — 2-strike rule before closing
let massDisappearStreak = 0; // consecutive sync cycles where ALL Kalshi positions are absent
const recentCrossContraMovers = new Map(); // ticker → { velocity, when } — cross-confirmed drops for pg-guard
// 2026-04-30 — structural entry throttles (prevent 4-min burst-fire pattern from 4/30)
const structuralEntryStamps = new Map(); // `${league}:${strategy}` → lastEntryMs (for 5-min same-sport-strategy spacing)
const structuralOpenEntries = new Map(); // ticker → { league, strategy, entryPrice, entryTs } (for concurrent-bleed check)
const STRUCTURAL_SPACING_MS = 5 * 60 * 1000;
const STRUCTURAL_BLEED_THRESHOLD = 0.05; // 5¢ underwater triggers throttle on new entries

function checkStructuralThrottles({ league, strategy, ticker }) {
  const now = Date.now();
  // Throttle C: 5-min spacing same-sport same-strategy
  const stampKey = `${league}:${strategy}`;
  const lastStamp = structuralEntryStamps.get(stampKey) ?? 0;
  if (now - lastStamp < STRUCTURAL_SPACING_MS) {
    const remainSec = Math.ceil((STRUCTURAL_SPACING_MS - (now - lastStamp)) / 1000);
    return { blocked: true, reason: `5-min spacing: another ${strategy} fired ${Math.floor((now-lastStamp)/1000)}s ago in ${league.toUpperCase()} (need ${remainSec}s more)` };
  }
  // Throttle B: any same-sport structural position currently underwater ≥5¢
  for (const [t, info] of structuralOpenEntries.entries()) {
    if (t === ticker) continue;
    if (info.league !== league) continue;
    const last = lastSeenPrices.get(t);
    if (!last || typeof last.price !== 'number') continue;
    const drawdown = info.entryPrice - last.price;
    if (drawdown >= STRUCTURAL_BLEED_THRESHOLD) {
      return { blocked: true, reason: `concurrent bleed: ${t.split('-').pop()} underwater ${Math.round(drawdown*100)}¢ from entry (${Math.round(info.entryPrice*100)}¢ → ${Math.round(last.price*100)}¢)` };
    }
  }
  return { blocked: false };
}

function recordStructuralEntry({ league, strategy, ticker, entryPrice }) {
  const now = Date.now();
  structuralEntryStamps.set(`${league}:${strategy}`, now);
  structuralOpenEntries.set(ticker, { league, strategy, entryPrice, entryTs: now });
}

function clearStructuralEntry(ticker) {
  structuralOpenEntries.delete(ticker);
}

// MFE (Maximum Favorable Excursion) tracker — highest favorable price reached per
// open trade. Persisted to trades.jsonl on exit/settlement. Enables price-move
// calibration alongside game-outcome calibration: even when a game flips, did the
// model find a real mispricing that the price moved toward?
const mfeTracking = new Map(); // tradeId → { maxPrice, maxMove }

// CLV (Closing Line Value) tracker — pre-game trades only. The single most important
// metric for measuring real edge: did we get a better price than the market at game
// start? +2¢ avg CLV = winning bettor; +5¢ = elite (Pinnacle/ProbWin industry data).
// Captured once in [game_start - 30s, game_start + 180s] window via 60s capture loop.
// Kalshi books are 0-100¢ implied probability — no vig-stripping needed; CLV in cents.
const clvTracking = new Map(); // tradeId → { ticker, side, entryPrice, gameStartMs, strategy }
function registerClvCapture(tradeId, { ticker, side, entryPrice, gameStartMs, strategy }) {
  if (!tradeId || !ticker || !Number.isFinite(gameStartMs) || gameStartMs <= 0) return;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;
  // Only meaningful for pre-game/UFC-style entries — live entries already ARE the live price
  clvTracking.set(tradeId, { ticker, side: (side ?? 'yes').toLowerCase(), entryPrice, gameStartMs, strategy: strategy ?? 'unknown', registeredAt: Date.now() });
}

// RLM (Reverse Line Movement) proxy — captures market-microstructure signals at
// entry time for later validation against CLV. Pure telemetry; no behavior change.
//
// Why proxies (not real RLM): Kalshi public API doesn't expose volume-by-aggressor
// or per-side ticket counts. We approximate sharp action via:
//   1. Recent cross-confirmed contra velocity (existing `recentCrossContraMovers`)
//   2. Direction of the recent move relative to our entry side (toward/against)
//   3. Last-60s price velocity from `lastSeenPrices` (lightweight signal, available
//      everywhere the bot makes a trade decision)
//
// Validation plan: tag on every entry, then 2-4 weeks of CLV data tells us whether
// RLM-tagged trades have systematically higher CLV than untagged. If yes → promote
// to confidence amplifier in next sprint. If no → kill the tag.
function getLiveMoveContext(ticker, entrySide, entryPrice) {
  const context = { recentCrash: null, last60s: null, directionRelativeToEntry: null };
  // (1) Recent cross-confirmed contra-velocity crash
  const cm = recentCrossContraMovers.get(ticker);
  if (cm) {
    const ageSec = (Date.now() - cm.when) / 1000;
    if (ageSec <= 90 && cm.velocity >= 15) {
      context.recentCrash = {
        velocity: Math.round(cm.velocity * 10) / 10,
        ageSec: Math.round(ageSec),
        when: new Date(cm.when).toISOString(),
      };
    }
  }
  // (2) Last-60s velocity from price-tick map
  const lsp = lastSeenPrices.get(ticker);
  if (lsp && Number.isFinite(lsp.price) && Number.isFinite(lsp.ts)) {
    const elapsedMin = Math.max(1/60, (Date.now() - lsp.ts) / 60000);
    if (elapsedMin <= 5) {
      // YES side: positive move = price went UP toward us. NO side: positive = price went DOWN.
      const yesMove = lsp.price - entryPrice; // entry is current; lsp is previous tick
      const moveTowardEntry = entrySide === 'no' ? -yesMove : yesMove;
      const velocityCents = Math.round((Math.abs(yesMove) * 100) / elapsedMin * 10) / 10;
      if (Math.abs(yesMove) >= 0.02) {
        context.last60s = {
          fromPrice: Math.round(lsp.price * 1000) / 1000,
          toPrice: Math.round(entryPrice * 1000) / 1000,
          velocityCentsPerMin: velocityCents,
          ageSec: Math.round((Date.now() - lsp.ts) / 1000),
        };
        context.directionRelativeToEntry = moveTowardEntry > 0 ? 'against' // price moved AWAY from us → we paid more
                                          : moveTowardEntry < 0 ? 'aligned' // price moved TOWARD us → we got better entry
                                          : null;
      }
    }
  }
  return (context.recentCrash || context.last60s) ? context : null;
}

// Profit-locking ladder — Pinnacle/pro-grade incremental locking on volatile in-play
// trades. Mechanical (no Claude consult) — captures volatility on partial size while
// leaving room for the existing "hold when leading" upside on the remaining position.
//
// Tier 1 (+15¢ profit/contract): lock 1/3 of remaining qty
// Tier 2 (+25¢ profit/contract): lock another 1/2 of remaining (= ~1/3 of original)
// Tier 3 (NBA Q4 final 2:00 + price ≥85¢): GAMMA OVERRIDE — exit remainder.
//   At 85¢+ with 2min left, one possession swings 15¢ — gamma risk dominates
//   remaining 15¢ of edge. Research-backed (Pinnacle live-betting practice).
//
// Eligible strategies: live-prediction, pre-game-edge-first, structural-*. Other
// strategies have their own exit logic (live-swing +12¢, draw-bet binary cliff,
// pre-game-prediction holdToSettle, high-conviction Claude-gated).
function getLadderState(trade, profitPerContract, currentPrice, league, ctx) {
  const strat = trade.strategy ?? '';
  // 2026-04-29: added pre-game-prediction to eligible. Previously only had
  // partialTakePrice (single threshold sells 50%). Ladder gives tiered partial
  // locks (1/3 + 1/3) which captures peaks better. The existing pre-game
  // partialTakePrice profit-lock checks !partialTakeAt, so if ladder fires
  // first, partial-take won't double-fire on the same trade.
  const eligible = strat === 'live-prediction'
    || strat === 'pre-game-edge-first'
    || strat === 'pre-game-prediction'
    || strat.startsWith('structural-');
  if (!eligible) return null;
  const tiersDone = trade.ladderTiersDone ?? 0;
  // Tier 3 — NBA Q4 gamma override. Fires regardless of tiersDone if conditions hit.
  if (league === 'nba'
      && ctx?.period === 4
      && Number.isFinite(ctx?.clockSeconds) && ctx.clockSeconds <= 120
      && currentPrice >= 0.85
      && profitPerContract > 0) {
    return { fire: true, tier: 3, fraction: 1.0, label: 'NBA-Q4-gamma' };
  }
  // 2026-04-29: lower tier-1 threshold for low-price entries (≤60¢). At 50¢
  // entry, +12¢ pop = 24% return — comparable to +15¢ on a 70¢ entry (21%).
  // Captures swing variance reliably without overstaying.
  const isLowPriceEntry = (trade.entryPrice ?? 0.5) <= 0.60;
  const tier1Trig = isLowPriceEntry ? 0.12 : 0.15;
  const tier1Label = isLowPriceEntry ? 'tier-1-+12c' : 'tier-1-+15c';
  if (tiersDone === 0 && profitPerContract >= tier1Trig) {
    // 2026-04-29: tiny-position handling. For qty ≤ 3, the 1/3 fraction floors to
    // 1 contract, leaving 2 for tier-2 (which is then 1/2 of 2 = 1 again). Result:
    // bot sells in painful 1-contract chunks with multiple Telegram notifications.
    // Better: sell all at once for tiny positions. Less granularity, cleaner UX,
    // captures the same profit. The "ride remaining for upside" logic only matters
    // when the remaining is ≥3 contracts.
    const totalQty = trade.quantity ?? 0;
    if (totalQty > 0 && totalQty <= 3) {
      return { fire: true, tier: 1, fraction: 1.0, label: tier1Label + '-full-tiny-qty' };
    }
    return { fire: true, tier: 1, fraction: 1/3, label: tier1Label };
  }
  // 2026-04-29: parallel adjustment for tier-2. Most swing trades peak at +18-22¢
  // before retracing — waiting for +25¢ on low-price entries leaves money on the
  // table. For entries ≤60¢, fire tier-2 at +20¢. Higher entries unchanged.
  const tier2Trig = isLowPriceEntry ? 0.20 : 0.25;
  const tier2Label = isLowPriceEntry ? 'tier-2-+20c' : 'tier-2-+25c';
  if (tiersDone === 1 && profitPerContract >= tier2Trig) {
    return { fire: true, tier: 2, fraction: 1/2, label: tier2Label };
  }
  return null;
}

// Apply MFE fields from the tracker to a trade object (and an optional persisted
// JSONL record). Idempotent and safe on missing tracker entries (no-op).
function applyMFE(trade, persistedRecord = null) {
  const mfe = mfeTracking.get(trade.id);
  if (mfe) {
    trade.maxFavorablePrice = mfe.maxPrice;
    trade.maxFavorableMove = Math.round(mfe.maxMove * 10000) / 10000;
    if (persistedRecord) {
      persistedRecord.maxFavorablePrice = trade.maxFavorablePrice;
      persistedRecord.maxFavorableMove = trade.maxFavorableMove;
    }
    mfeTracking.delete(trade.id);
  }
}

// Claude HOLD memo — structured record of the last HOLD decision per ticker.
// When a sell-decision prompt fires and Claude says HOLD, we stamp the context here.
// Subsequent sell-decision prompts within 10min skip the Claude call entirely if nothing
// material has changed. Prevents the "5 prompts ask the same question 5 ways, one eventually
// caves" failure mode (DAL@MIN: HOLD at hard-stop, HOLD at hard-stop, then mechanical nuclear
// fired anyway on the same tied game).
const claudeHoldMemos = new Map(); // ticker -> { ts, ourWE, diff, period, stage, reasoning, path }

function recordClaudeHold(ticker, ctx, ourWE, path, reasoning) {
  if (!ticker) return;
  claudeHoldMemos.set(ticker, {
    ts: Date.now(),
    ourWE: (typeof ourWE === 'number' && isFinite(ourWE)) ? ourWE : null,
    diff: ctx?.diff ?? null,
    period: ctx?.period ?? null,
    stage: ctx?.stage ?? null,
    reasoning: String(reasoning ?? '').slice(0, 120),
    path: String(path ?? ''),
  });
}

// Returns an auto-HOLD object { ageMin, ourWE, path, reasoning } if the memo is fresh
// and no material state change has occurred, else null (caller should proceed to Claude).
function shouldAutoHold(ticker, ctx, ourWE) {
  if (!ticker) return null;
  const memo = claudeHoldMemos.get(ticker);
  if (!memo) return null;
  const ageMs = Date.now() - memo.ts;
  if (ageMs > 10 * 60 * 1000) { claudeHoldMemos.delete(ticker); return null; }
  // Our WE dropped meaningfully since the HOLD — re-ask Claude.
  if (memo.ourWE != null && typeof ourWE === 'number' && isFinite(ourWE) && ourWE < memo.ourWE - 0.10) return null;
  // Deficit grew against us.
  if (memo.diff != null && ctx?.diff != null && ctx.diff < memo.diff) return null;
  // Cross-confirmed contra-velocity AFTER the memo — market moved against us, re-ask.
  const contra = recentCrossContraMovers.get(ticker);
  if (contra && contra.when > memo.ts && (contra.velocity ?? 0) >= 5) return null;
  // Stage advanced into late — new regime, re-ask.
  if (ctx?.stage === 'late' && memo.stage && memo.stage !== 'late') return null;
  return {
    ageMin: Math.round(ageMs / 60000),
    ourWE: memo.ourWE,
    path: memo.path,
    reasoning: memo.reasoning,
  };
}

// Live-edge reject memo — skip Sonnet call when state hasn't changed enough to flip Claude's answer.
// Key: gameBase. Value: { scoreKey, priceCents, ts }.
// Invalidates when score changes, price moves ≥3¢, or age > 6min.
const liveEdgeRejectMemo = new Map();
// 2026-05-01: reduced from 5min → 3min. TEX-DET 4-0 inn-3 stuck for 10+ min in
// "memo hit" loop because Sonnet's earlier rejection was stale by inn-4.
const LIVE_REJECT_MAX_AGE_MS = 3 * 60 * 1000;
const LIVE_REJECT_PRICE_TOL_CENTS = 5;

// Check whether a tomorrow-dated ticker starts within maxHours of now (ET).
// Ticker format embeds HHMM immediately after the date string, e.g. "26APR172010".
// This prevents betting on tomorrow evening games when the pre-game scanner opens
// at 10pm — only games starting within 8 hours (late West Coast crossover) are valid.
function tomorrowTickerWithinHours(ticker, tonightStr, etNow, maxHours = 8) {
  const dateIdx = ticker.indexOf(tonightStr);
  if (dateIdx < 0) return false;
  const timeStr = ticker.slice(dateIdx + tonightStr.length, dateIdx + tonightStr.length + 4);
  if (!/^\d{4}$/.test(timeStr)) return false;
  const gameH = parseInt(timeStr.slice(0, 2));
  const gameM = parseInt(timeStr.slice(2, 4));
  const nowMins = etNow.getHours() * 60 + etNow.getMinutes();
  const gameMins = gameH * 60 + gameM;
  // Minutes until game — crosses midnight so add 24h and mod
  const minsUntil = (gameMins + 24 * 60 - nowMins) % (24 * 60);
  return minsUntil <= maxHours * 60;
}

// Checks if a ticker's embedded game date is within the next 24h window.
// Used to filter line-move detector to near-term games only — avoids log noise
// and false contra-exit triggers from thin-liquidity far-future markets
// (e.g. LFC-CFC May 9 EPL showing 17¢/min moves from odd-lot fills).
function tickerIsWithinNext24h(ticker) {
  // Format: KXSPORTGAME-YYMMMDD[HHMM]-TEAM (e.g. KXMLBGAME-26APR231510SDCOL-SD)
  const m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return true; // unparseable, let it through
  const [_, yr, monStr, day] = m;
  const monMap = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
  const mon = monMap[monStr];
  if (mon == null) return true;
  const year = 2000 + parseInt(yr);
  // Compare in ET
  const now = etNow();
  const gameDate = new Date(year, mon, parseInt(day));
  const daysOut = (gameDate.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / (24 * 3600 * 1000);
  // Allow today + tomorrow (some games start past ET midnight)
  return daysOut <= 1.5 && daysOut >= -0.5;
}

// Restore gameEntries + tradeCooldowns from trades.jsonl on startup so restarts don't
// wipe knowledge of existing positions (prevents double-buys and scale-in at worse prices)
try {
  if (existsSync('./logs/trades.jsonl')) {
    const restoreLines = readFileSync('./logs/trades.jsonl', 'utf-8').split('\n').filter(l => l.trim());
    // ET midnight in UTC: today ET midnight = today's date at 04:00 UTC (ET = UTC-4)
    const etMidnightUTC = (() => { const d = etNow(); d.setHours(0,0,0,0); return d.getTime() - (d.getTime() - new Date(d.toLocaleString('en-US',{timeZone:'UTC'})).getTime()); })();
    const etTodayStartMs = new Date(etNow().toISOString().slice(0,10) + 'T04:00:00Z').getTime();
    const etTodayEndMs = etTodayStartMs + 24 * 60 * 60 * 1000;
    for (const l of restoreLines) {
      try {
        const t = JSON.parse(l);
        if (t.status !== 'open' && t.status !== 'closed-manual') continue;
        // Only restore today's trades — compare UTC timestamp against ET day window (ET midnight = UTC 04:00)
        const tradeMs = t.timestamp ? Date.parse(t.timestamp) : 0;
        if (tradeMs < etTodayStartMs || tradeMs >= etTodayEndMs) continue;
        const ticker = t.ticker ?? '';

        // Restore gameEntries — use ticker BASE as canonical key (consistent regardless of which side we bet)
        // e.g. KXNHLGAME-26APR13DALTOR-DAL and KXNHLGAME-26APR13DALTOR-TOR both use "KXNHLGAME-26APR13DALTOR"
        const base = ticker.lastIndexOf('-') > 0 ? ticker.slice(0, ticker.lastIndexOf('-')) : ticker;
        if (base) {
          const entry = gameEntries.get(base) ?? { count: 0, lastPrice: 0, totalDeployed: 0, lastScoreKey: null };
          entry.count++;
          entry.lastPrice = t.entryPrice ?? 0;
          entry.totalDeployed += t.deployCost ?? 0;
          // Parse "HOM 2 - AWA 1" (or similar) from liveScore to restore the score state
          const m = (t.liveScore ?? '').match(/[A-Z]{2,3}\s+(\d+)\s*[-–]\s*[A-Z]{2,3}\s+(\d+)/);
          if (m) entry.lastScoreKey = `${m[1]}-${m[2]}`;
          gameEntries.set(base, entry);
        }

        // Restore tradeCooldowns from trade timestamp
        const tradeTime = t.timestamp ? Date.parse(t.timestamp) : 0;
        if (tradeTime > 0) {
          tradeCooldowns.set(ticker, tradeTime);
          const base = ticker.lastIndexOf('-') > 0 ? ticker.slice(0, ticker.lastIndexOf('-')) : ticker;
          tradeCooldowns.set(base, tradeTime);
        }
      } catch { /* skip */ }
    }
    if (gameEntries.size > 0) {
      console.log(`[restore] Restored ${gameEntries.size} game entries from JSONL: ${[...gameEntries.entries()].map(([k, v]) => `${k}(${v.count}x@${(v.lastPrice*100).toFixed(0)}¢=$${v.totalDeployed.toFixed(2)})`).join(', ')}`);
    }
  }
} catch (e) { console.error('[restore] error:', e.message); }

// Load persisted scan timers and high-conviction state
loadState();

// Score-state helper — a compact "home-away" key so we can detect whether the
// score has changed between scale-in cycles. If it has, the game state is
// genuinely different (not "same asset cheaper") and we should NOT average down.
function scoreKey(home, away) {
  if (home == null || away == null) return null;
  return `${away}-${home}`;
}

// Render a structured reasoning object (as returned by Sonnet in the new schema)
// into a human-readable string. The structured form stays in the trade log under
// reasoningStructured for programmatic analysis / calibration. The rendered string
// is what the UI and legacy consumers see.
function renderStructuredReasoning(r) {
  if (!r || typeof r !== 'object') return '';
  const parts = [];
  if (r.steel_man)        parts.push(`STEEL-MAN: ${r.steel_man}`);
  if (r.edge_source)      parts.push(`EDGE SOURCE: ${r.edge_source}`);
  if (r.edge_argument)    parts.push(`WHY MARKET IS WRONG: ${r.edge_argument}`);
  if (Array.isArray(r.key_facts) && r.key_facts.length > 0) {
    parts.push(`KEY FACTS: ${r.key_facts.filter(Boolean).join('; ')}`);
  }
  if (r.top_risk)         parts.push(`KEY RISK: ${r.top_risk}`);
  if (r.conviction)       parts.push(`CONVICTION: ${r.conviction}`);
  if (Array.isArray(r.reasoning_tags) && r.reasoning_tags.length > 0) {
    parts.push(`TAGS: ${r.reasoning_tags.filter(Boolean).join(',')}`);
  }
  return parts.join(' | ');
}

// Full multi-line reasoning for Telegram — shows each section on its own line
function renderReasoningForTelegram(r, fallbackStr) {
  if (!r || typeof r !== 'object') return fallbackStr || '';
  const lines = [];
  if (r.steel_man)        lines.push(`STEEL-MAN: ${r.steel_man}`);
  if (r.edge_source)      lines.push(`EDGE SOURCE: ${r.edge_source}`);
  if (r.edge_argument)    lines.push(`WHY MARKET IS WRONG: ${r.edge_argument}`);
  if (Array.isArray(r.key_facts) && r.key_facts.length > 0) {
    lines.push(`KEY FACTS: ${r.key_facts.filter(Boolean).join('; ')}`);
  }
  if (r.top_risk)         lines.push(`KEY RISK: ${r.top_risk}`);
  if (r.conviction)       lines.push(`CONVICTION: ${r.conviction}`);
  return lines.length > 0 ? lines.join('\n') : (fallbackStr || '');
}

// 2026-04-29: profit lock-in REMOVED. Capping post-profit trades at 30% of
// realized P&L kept losses small but also capped daily upside below the
// 10%/day target. User explicitly wants max upside preserved — protect
// against catastrophic losses through detector quality + price-drop
// override (both already shipped) instead of position-size caps.
function getProfitLockInCap() { return null; }

// Smart cooldown: allow adding to position IF price improved AND score is
// unchanged, block otherwise.
//
// Why score-gate: a 3¢ price drop because the trailing team just scored is
// a genuinely worse thesis, not a buying opportunity. Averaging down in that
// situation is the gambler's fallacy. Price-drop alone is too weak a signal.
//
// proposedAmount: optional — if provided, checks whether current + proposed would exceed cap
// currentScoreKey: optional — scoreKey(home, away) at the moment of this check
function canScaleInto(gameKey, currentPrice, proposedAmount = 0, currentScoreKey = null) {
  const entry = gameEntries.get(gameKey);
  if (!entry) return true; // first entry — always allowed

  // Block if max entries reached (dynamic — fewer entries at smaller bankrolls)
  if (entry.count >= getMaxEntriesPerGame()) return false;

  // Block if total exposure (including proposed new bet) would exceed bankroll cap
  if (entry.totalDeployed + proposedAmount >= getBankroll() * MAX_GAME_EXPOSURE_PCT) return false;

  // Score-state gate: if the score has changed since our last entry, the game
  // is different now — skip scale-in regardless of price movement. Only applies
  // when we have score data for both entries; otherwise fall through (non-sports markets).
  if (currentScoreKey && entry.lastScoreKey && currentScoreKey !== entry.lastScoreKey) {
    return false;
  }

  // Allow if price is MEANINGFULLY better (lower) than last entry — 4¢+ clears the
  // noise floor. 2¢ was catching bid/ask spread widening rather than real moves.
  if (currentPrice < entry.lastPrice - 0.04) return true;

  // Block if price is same or only marginally better — nothing concrete changed
  return false;
}

function recordGameEntry(gameKey, price, deployed, scoreKeyValue = null) {
  const entry = gameEntries.get(gameKey) ?? { count: 0, lastPrice: 0, totalDeployed: 0, lastScoreKey: null };
  entry.count++;
  entry.lastPrice = price;
  entry.totalDeployed += deployed;
  if (scoreKeyValue) entry.lastScoreKey = scoreKeyValue;
  gameEntries.set(gameKey, entry);
}
let kalshiBalance = 0;
let kalshiPositionValue = 0;
let openPositions = [];  // fetched each cycle
let stats = { claudeCalls: 0, tradesPlaced: 0, apiSpendCents: 0 }; // track API costs

// ─────────────────────────────────────────────────────────────────────────────
// Risk Management State
// ─────────────────────────────────────────────────────────────────────────────

let dailyOpenBankroll = 0;       // snapshot at start of day / bot restart
let weeklyOpenBankroll = 0;      // snapshot at start of week (Monday 00:00 ET)
let weeklyResetISOWeek = '';     // 'YYYY-Wnn' marker so we only reset once per week
let consecutiveLosses = 0;       // reset on any win
let tradingHalted = false;       // circuit breaker flag (full halt — manual unhalt required)
let haltReason = '';
let lastHaltCheck = 0;
// Soft halt: blocks new entries but lets existing positions close. Auto-clears at next
// daily/weekly reset. Used for -10% daily and -15% weekly trips. Less drastic than
// full halt — designed to stop the bleeding without locking out recovery.
let softHaltUntilMs = 0;
let softHaltReason = '';
// Kelly haircut: after a circuit-breaker trip resolves, scale all Kelly fractions
// down 50% for 72h. "Anti-martingale" — bet less when recovering. Pro practice from
// Pinnacle/Kelly research (recompute off current bankroll, not peak).
let kellyHaircutUntilMs = 0;

function getBankroll() {
  return kalshiBalance + kalshiPositionValue;
}

// [REMOVED: Fee-gating functions — replaced by confidence-based prediction engine]

// Inverse curve: aggressive when small (need growth), conservative when big (protect gains)
// $200 → 85% deployed, $1K → 75%, $5K → 50%, $20K → 30%, $50K+ → 20%
function getMaxDeployment() {
  const b = getBankroll();
  if (b < 500) return 0.85;
  if (b < 2000) return 0.75;
  if (b < 5000) return 0.60;
  if (b < 20000) return 0.40;
  if (b < 50000) return 0.30;
  return 0.20;
}

function getMaxPositions() {
  const b = getBankroll();
  // Fewer, larger, higher-conviction bets. Thin positions = fee drag + no impact.
  if (b < 500) return 12;
  if (b < 1000) return 15;
  if (b < 2000) return 18;
  if (b < 10000) return 25;
  if (b < 50000) return 35;
  return 50;
}

// Per-trade cap also scales: small accounts need room, big accounts need limits
function getTradeCapCeiling() {
  const b = getBankroll();
  if (b < 500) return 50;        // $200 → max $20 per trade (10% wins)
  if (b < 2000) return 150;      // $1K → max $100
  if (b < 10000) return 500;     // $5K → max $500
  if (b < 50000) return 2000;    // $20K → max $2000
  return 5000;                    // $50K+ → max $5000
}

function getAvailableCash(exchange = 'kalshi') {
  const bal = exchange === 'polymarket' ? polyBalance : kalshiBalance;
  const reserve = getBankroll() * CAPITAL_RESERVE;
  return Math.max(0, bal - reserve);
}

// GRANULAR BUCKET THROTTLE (2026-04-30): reads calibration-stats.json and returns
// a sizing multiplier based on the FULL granular bucket: sport × strategy × edge × conf.
// The coarse getBucketSizingMult below operates only at sport×strategy level, which
// averages bad granular cells with profitable ones. Example documented bleeder:
//   "MLB | pre-game-prediction | 15-19pt | 65-69%": n=8, 63% WR, -$9.18/trade
// is invisible to the coarse throttle because MLB pre-game OVERALL is closer to
// break-even. This catches it.
//
// Returns: throttle multiplier in [0, 1]
//   pnlPerTrade < -5 (n≥5): 0.00 (freeze)
//   pnlPerTrade < -2 (n≥5): 0.25 (quarter size)
//   pnlPerTrade < -1 (n≥5): 0.50 (half size)
//   pnlPerTrade < -0.5 (n≥5): 0.75 (slight cut)
//   else (or n<5): 1.00 (full size, not enough data to throttle)
const _granularBucketCache = { ts: 0, buckets: null };
function _classifyEdgeBand(edge) {
  return edge < 0.05 ? '<5pt' : edge < 0.10 ? '5-9pt' : edge < 0.15 ? '10-14pt' : edge < 0.20 ? '15-19pt' : '20+pt';
}
function _classifyConfBand(c) {
  return c < 0.60 ? '<60%' : c < 0.65 ? '60-64%' : c < 0.70 ? '65-69%' : c < 0.75 ? '70-74%' : c < 0.80 ? '75-79%' : '80%+';
}
function getGranularBucketThrottle(sport, strategy, edge, confidence) {
  if (!sport || !strategy || edge == null || confidence == null) return 1;
  // Map sport name to calibration-stats convention
  const sportKey = sport === 'mlb' || sport === 'MLB' ? 'MLB'
                 : sport === 'nba' || sport === 'NBA' ? 'NBA'
                 : sport === 'nhl' || sport === 'NHL' ? 'NHL'
                 : ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(sport) ? 'Soccer'
                 : sport;
  const now = Date.now();
  if (!_granularBucketCache.buckets || now - _granularBucketCache.ts > 5 * 60 * 1000) {
    try {
      const raw = readFileSync('./logs/calibration-stats.json', 'utf-8');
      const cs = JSON.parse(raw);
      _granularBucketCache.buckets = Array.isArray(cs.buckets) ? cs.buckets : [];
      _granularBucketCache.ts = now;
    } catch {
      _granularBucketCache.buckets = [];
      _granularBucketCache.ts = now;
    }
  }
  const buckets = _granularBucketCache.buckets;
  if (!buckets || buckets.length === 0) return 1;
  const edgeBand = _classifyEdgeBand(edge);
  const confBand = _classifyConfBand(confidence);
  // Find matching bucket
  const match = buckets.find(b =>
    b.sport === sportKey &&
    b.strategy === strategy &&
    b.edge === edgeBand &&
    b.conf === confBand
  );
  if (!match || (match.n ?? 0) < 5) return 1;
  const ppt = match.pnlPerTrade ?? 0;
  let mult = 1;
  let label = '';
  if (ppt < -5)        { mult = 0.00; label = 'FROZEN'; }
  else if (ppt < -2)   { mult = 0.25; label = 'QUARTER-SIZE'; }
  else if (ppt < -1)   { mult = 0.50; label = 'HALF-SIZE'; }
  else if (ppt < -0.5) { mult = 0.75; label = 'SLIGHT CUT'; }
  if (mult < 1) {
    console.log(`[risk] 🎯 GRANULAR BUCKET ${label} ${sportKey}|${strategy}|${edgeBand}|${confBand}: n=${match.n} pnlPerTrade=$${ppt.toFixed(2)} → ${mult.toFixed(2)}x`);
  }
  return mult;
}

// GRADUATED AUTO-SIZE-DOWN (2026-04-23): reads calibration-stats.json and returns
// a sizing multiplier based on recent (sport × strategy) WR. Softer than binary
// auto-freeze — reduces blast radius while preserving data flow.
//
// Thresholds (rolling last 10 trades in the bucket):
//   WR ≥ 50% or n < 10     → 1.00x (full sizing)
//   WR 35-49%              → 0.50x (half size — cautionary)
//   WR < 35% and n ≥ 10    → 0.25x (quarter size — strong warning)
//   WR < 30% and n ≥ 15    → 0.00x (soft freeze — enough evidence)
//
// Cache 5min so we don't re-parse file on every trade.
const _bucketMultCache = { ts: 0, data: null };
function getBucketSizingMult(sport, strategy) {
  if (!sport || !strategy) return 1;
  const now = Date.now();
  if (!_bucketMultCache.data || now - _bucketMultCache.ts > 5 * 60 * 1000) {
    try {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      const bySportStrat = new Map();
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          // Bug fix 2026-04-27: was filtering on `gameOutcome` which is only set
          // on ~63% of settled trades. Now uses realizedPnL directly (universal).
          // Skips manual exits (closed-manual / sold-manual) which aren't a
          // verdict on strategy quality.
          if (t.realizedPnL == null) continue;
          if (t.status === 'closed-manual' || t.status === 'sold-manual') continue;
          const tk = (t.ticker ?? '').toUpperCase();
          const sportKey = tk.includes('NBA') ? 'NBA' : tk.includes('MLB') ? 'MLB'
            : tk.includes('NHL') ? 'NHL' : (tk.match(/MLS|EPL|LALIGA|SERIEA|BUNDESLIGA|LIGUE1/) ? 'Soccer' : 'Other');
          const key = `${sportKey}|${t.strategy}`;
          if (!bySportStrat.has(key)) bySportStrat.set(key, []);
          bySportStrat.get(key).push(t);
        } catch {}
      }
      const data = {};
      for (const [key, trades] of bySportStrat) {
        // Use last 15 trades for stability (was 10 — too volatile on small samples)
        const recent = trades.slice(-15);
        const wins = recent.filter(t => (t.realizedPnL ?? 0) > 0).length;
        const wr = recent.length > 0 ? wins / recent.length : 0.5;
        const totalPnl = recent.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
        const avgPnl = recent.length > 0 ? totalPnl / recent.length : 0;
        data[key] = { n: recent.length, wr, avgPnl, totalPnl };
      }
      _bucketMultCache.ts = now;
      _bucketMultCache.data = data;
    } catch (e) {
      return 1; // on error, don't penalize
    }
  }
  const stats = _bucketMultCache.data?.[`${sport}|${strategy}`];
  // 2026-05-02 v3: don't fully exempt sub-n=10 detectors from sizing rules.
  // Apply evidenceMult of 0.6 below n=10. Was returning 1.0 (full sizing)
  // which over-exposed unproven detectors.
  if (!stats) return 1;
  if (stats.n < 5) return 0.6; // Tiny sample, halve sizing
  // P&L-based throttle (NEW 2026-04-27): even if WR looks fine, asymmetric losses
  // (small wins, big losses) destroy a strategy. Auto-throttle on negative avg P&L.
  // This was the missing piece: MLB pre-game had 18% tWR but 63% on the 15-19pt
  // edge bucket which lost -$9.18/trade due to high-priced favorites paying tiny
  // upside. WR-only check missed this.
  // 2026-05-02: lowered freeze threshold for catastrophic bleeders.
  if (stats.n >= 5 && stats.avgPnl < -3.00) return 0.00;  // catastrophic bleeder
  if (stats.n >= 10 && stats.avgPnl < -2.00) return 0.00; // confirmed bleeder

  // 2026-05-02 v3: require n>=10 placed bets for FULL sizing. Below n=10,
  // max 0.6x — matches sizing to evidence. Shadow data isn't ground truth;
  // placed-bet outcomes are. Be smaller while we accumulate per-detector data.
  const evidenceMult = stats.n < 10 ? 0.6 : 1.0;

  if (stats.avgPnl < -1.00) return 0.25 * evidenceMult;
  if (stats.avgPnl < -0.50) return 0.50 * evidenceMult;
  // WR-based throttle (existing logic)
  if (stats.wr >= 0.50) return 1.00;
  if (stats.wr >= 0.35) return 0.50;
  if (stats.n >= 15 && stats.wr < 0.30) return 0.00; // soft freeze
  return 0.25; // WR < 35% with 10-14 samples
}

function getDynamicMaxTrade(exchange = 'kalshi', sport = null, strategy = null) {
  const bankroll = getBankroll();
  // Tier 2: Per-sport Kelly fraction (downward-only; default 0.50 = half-Kelly)
  const kellyMult = sport ? (getKellyFraction(sport) / 0.50) : 1;
  // Tier 3: Per-bucket auto-size-down based on recent (sport × strategy) WR.
  // Softer than auto-freeze — data keeps flowing. See getBucketSizingMult.
  const sportMapped = sport ? (sport === 'mlb' ? 'MLB' : sport === 'nba' ? 'NBA' : sport === 'nhl' ? 'NHL'
    : ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(sport) ? 'Soccer' : 'Other') : null;
  const bucketMult = getBucketSizingMult(sportMapped, strategy);
  if (bucketMult < 1 && bucketMult > 0) {
    console.log(`[risk] 📉 BUCKET SIZE-DOWN: ${sportMapped || 'sport?'} × ${strategy} running cold — sizing at ${(bucketMult*100).toFixed(0)}% of normal`);
  } else if (bucketMult === 0) {
    console.log(`[risk] 🧊 BUCKET SOFT-FREEZE: ${sportMapped || 'sport?'} × ${strategy} at <30% WR on 15+ samples — blocking trade`);
  }
  // P1.3 — pre-game strategies capped at 5%.
  const isPreGame = strategy && (strategy === 'pre-game-prediction' || strategy === 'pre-game-edge-first');
  // 2026-04-30: NBA/NHL structural detectors capped at 5% bankroll. Late-game
  // basketball/hockey lead variance is sharper than baseball (a single Q4 run
  // flips a 10pt lead in 4min). TOR-CLE NBA Q3 at 10% sizing → −$10.73 single trade.
  // MLB structural stays at 10%.
  const isNbaNhlStructural = strategy && strategy.startsWith?.('structural-')
    && (strategy.includes('nba') || strategy.includes('nhl'));
  const strategyFrac = isPreGame ? 0.05 : (isNbaNhlStructural ? 0.05 : MAX_TRADE_FRACTION);
  const pctCap = bankroll * strategyFrac * kellyMult * bucketMult;
  const ceiling = getTradeCapCeiling();
  const available = getAvailableCash(exchange);
  return Math.min(pctCap, ceiling, available);
}

function getTotalDeployed() {
  // Use Kalshi's portfolio_value (current market value) not original cost
  // Original cost is misleading — a $50 position that's now worth $10 isn't $50 of deployment
  return kalshiPositionValue + openPositions.filter(p => p.exchange === 'polymarket').reduce((sum, p) => sum + (p.cost ?? 0), 0);
}

function canDeployMore(tradeAmount) {
  const maxDeploy = getBankroll() * getMaxDeployment();
  const currentlyDeployed = getTotalDeployed();
  if (currentlyDeployed + tradeAmount > maxDeploy) {
    console.log(`[risk] Deployment cap: $${currentlyDeployed.toFixed(2)} + $${tradeAmount.toFixed(2)} > $${maxDeploy.toFixed(2)} (${(getMaxDeployment()*100).toFixed(0)}% of $${getBankroll().toFixed(2)})`);
    return false;
  }
  return true;
}

// UI control state — read each call, written by api.mjs
const CONTROL_FILE = './logs/control.json';
function readUIControl() {
  try {
    if (!existsSync(CONTROL_FILE)) return { paused: false, disabledStrategies: [] };
    return JSON.parse(readFileSync(CONTROL_FILE, 'utf-8'));
  } catch { return { paused: false, disabledStrategies: [] }; }
}
function isStrategyDisabled(strategy) {
  const ctrl = readUIControl();
  if ((ctrl.disabledStrategies ?? []).includes(strategy)) return true;
  // Tier 1 auto-calibration can also pause a strategy for sustained -EV runs
  if (isStrategyAutoDisabledByCAL(strategy)) return true;
  return false;
}

function canTrade() {
  // UI pause overrides everything
  const ctrl = readUIControl();
  if (ctrl.paused) {
    console.log(`[risk] UI PAUSED${ctrl.pausedReason ? ` — ${ctrl.pausedReason}` : ''}`);
    return false;
  }
  // Manual unhalt via control.json: { "unhaltRequested": true } clears full halt + soft halt.
  // Path of last resort — used after a circuit-breaker trip when the user has audited
  // and wants to resume without restarting the bot.
  if (ctrl.unhaltRequested && (tradingHalted || softHaltUntilMs > Date.now())) {
    console.log(`[risk] Manual unhalt acknowledged — clearing halt state`);
    tradingHalted = false;
    haltReason = '';
    softHaltUntilMs = 0;
    softHaltReason = '';
    try { tg(`✅ <b>HALT LIFTED</b>\n\nManual unhalt acknowledged. Trading resumes with 72h Kelly haircut for safety.`); } catch {}
    kellyHaircutUntilMs = Date.now() + 72 * 60 * 60 * 1000;
    // Clear flag in control.json so we don't re-acknowledge on every cycle
    try {
      const next = { ...ctrl, unhaltRequested: false, unhaltAckAt: new Date().toISOString() };
      writeFileSync(CONTROL_FILE, JSON.stringify(next, null, 2));
    } catch {}
  }

  if (tradingHalted) {
    console.log(`[risk] HALTED: ${haltReason}`);
    return false;
  }

  // Soft halt: blocks NEW entries but lets existing positions close (managePositions
  // runs independently of canTrade). Auto-clears when softHaltUntilMs passes.
  if (softHaltUntilMs > Date.now()) {
    console.log(`[risk] SOFT HALT: ${softHaltReason} — blocked until ${new Date(softHaltUntilMs).toISOString()}`);
    return false;
  }

  // Drawdown circuit breaker — graduated. Trips soft halt at -10% daily / -15% weekly,
  // full halt at -25% daily / -30% weekly. Re-enabled 2026-04-27 after CLV instrumentation
  // gives us a real edge-validity signal: if we drawdown HARD with negative CLV, edge is
  // gone (model regression). If we drawdown HARD with positive CLV, it's variance — but
  // either way the breaker preserves runway. Better to pause + resume small than to bleed.
  if (!checkDrawdownBreaker()) return false;

  // Check max positions (dynamic) — only count positions with meaningful cost
  const maxPos = getMaxPositions();
  const meaningfulPositions = openPositions.filter(p => (p.cost ?? 0) >= 1.0).length;
  if (meaningfulPositions >= maxPos) {
    console.log(`[risk] Max meaningful positions: ${meaningfulPositions}/${maxPos} (${openPositions.length} total including dust)`);
    return false;
  }

  // Also check deployment cap — even if position count is OK, don't over-deploy
  const deployed = getTotalDeployed();
  const maxDeploy = getBankroll() * getMaxDeployment();
  if (deployed >= maxDeploy) {
    console.log(`[risk] Deployment cap: $${deployed.toFixed(2)}/$${maxDeploy.toFixed(2)} (${(getMaxDeployment()*100).toFixed(0)}%)`);
    return false;
  }

  // Check consecutive losses (reduce size at 5, don't halt until 8)
  if (consecutiveLosses >= 10) {
    tradingHalted = true;
    haltReason = `10 consecutive losses — full halt, something is wrong`;
    tg(`🛑 <b>TRADING HALTED</b>\n\n${haltReason}`);
    console.log(`[risk] ${haltReason}`);
    return false;
  }

  return true;
}

// High-conviction tier — detects near-certain late-game situations
// Returns { isHighConv: true, tier: '30%'/'25%'/'20%', reason: '...' } or { isHighConv: false }
function checkHighConviction(confidence, league, stage, diff, period, price = null) {
  if (confidence < 0.90 || stage !== 'late') return { isHighConv: false };

  // EV gate: a 90% confidence bet at 95¢ is +0¢ edge per $1. Sizing 25-30% of
  // bankroll on near-fair bets is variance exposure without expected return.
  // Require the edge (conf - price) to be at least 7¢ — ties HC size to real
  // EV rather than confidence alone.
  if (price != null && confidence - price < 0.07) return { isHighConv: false };

  // Drawdown cooldown: if the most recent HC bet was a loss, pause HC for 24h.
  // Rare-event losses are a possible calibration signal; going back in bigger
  // is exactly how you cascade a bad day into a bad week.
  if (Date.now() - lastHCLossAt < 24 * 60 * 60 * 1000) return { isHighConv: false };

  // Safety rails: max 1 per hour, max 40% of bankroll in high-conviction
  if (Date.now() - lastHighConvictionAt < 60 * 60 * 1000) return { isHighConv: false };
  if (highConvictionDeployed >= getBankroll() * 0.40) return { isHighConv: false };

  // Sport-specific lead thresholds for "game is over"
  let qualifies = false;
  let reason = '';

  if (league === 'nba') {
    if (diff >= 20) { qualifies = true; reason = `NBA Q4 up ${diff} pts — <1% comeback`; }
    else if (diff >= 15 && period === 4) { qualifies = true; reason = `NBA Q4 up ${diff} pts — ~2% comeback`; }
  } else if (league === 'nhl') {
    if (diff >= 2) { qualifies = true; reason = `NHL P3 up ${diff} goals — ${diff >= 3 ? '<1%' : '~5%'} comeback`; }
    // 1-goal P3 removed from HC: 20-25% OT probability, OT is near-random for avg teams
    // Don't deploy 25-30% bankroll on situations with genuine coin-flip risk
  } else if (league === 'mlb') {
    if (diff >= 4 && period >= 7) { qualifies = true; reason = `MLB ${period}th up ${diff} runs — ~2% comeback`; }
    else if (diff >= 3 && period >= 8) { qualifies = true; reason = `MLB ${period}th up ${diff} runs — ~5% comeback`; }
  }
  // Soccer excluded from HC — liveStage 'late' starts at minute 46 (period 2 start),
  // not 75'. Without minute tracking we can't safely enforce the real threshold.

  if (!qualifies) return { isHighConv: false };

  // Determine tier based on confidence
  const tier = confidence >= 0.93 ? 0.30 : confidence >= 0.90 ? 0.25 : 0.20;
  return { isHighConv: true, tier, reason };
}

function getPositionSize(exchange = 'kalshi', confidenceMargin = 0, highConvTier = 0, sport = null, entryPrice = null) {
  const bankroll = getBankroll();

  // High-conviction tier: 25-30% of bankroll instead of 10%
  // HC tier bypasses the normal trade ceiling — the ceiling is for normal bets,
  // HC bets are rare (1/hour max) and near-certain. Own ceiling: 50% of bankroll.
  if (highConvTier > 0) {
    const hcSize = bankroll * highConvTier;
    const available = getAvailableCash(exchange);
    // HC still honors per-sport Kelly dampening
    const kellyMult = sport ? (getKellyFraction(sport) / 0.50) : 1;
    const hcCeiling = bankroll * 0.50 * kellyMult;
    const size = Math.min(hcSize * kellyMult, available, hcCeiling);
    console.log(`[sizing] 🔥 HIGH CONVICTION: ${(highConvTier*100).toFixed(0)}% of $${bankroll.toFixed(0)} → $${size.toFixed(2)}${kellyMult < 1 ? ` [kelly ${kellyMult.toFixed(2)}x ${sport}]` : ''}`);
    return Math.max(1, size);
  }

  let size = getDynamicMaxTrade(exchange, sport);

  // Scale UP for high-confidence trades — bigger margin = bigger bet
  // margin 5% = 1x (base), 10% = 1.5x, 15% = 2x, 20%+ = 2.5x (max)
  if (confidenceMargin > 0.05) {
    const multiplier = Math.min(2.5, 1 + (confidenceMargin - 0.05) * 10);
    const scaledSize = size * multiplier;
    const ceiling = getTradeCapCeiling();
    // 2026-05-02: BANKROLL HARD CAP — even with confidence multiplier, no single
    // trade exceeds 15% of bankroll. Tightened earlier from $200 ceiling.
    const bankrollCap = bankroll * 0.15;
    size = Math.min(scaledSize, ceiling, bankrollCap);
    if (multiplier > 1.1) console.log(`[sizing] High confidence (+${(confidenceMargin*100).toFixed(0)}%): ${multiplier.toFixed(1)}x → $${size.toFixed(2)} (15%-bankroll cap=$${bankrollCap.toFixed(2)})`);
  }

  // Reduce size after consecutive losses
  if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    size = size * 0.5;
    console.log(`[risk] Reduced position size to $${size.toFixed(2)} (50%) after ${consecutiveLosses} consecutive losses`);
  }

  // 2026-05-02: PRICE-TIERED HARD CAP. Asymmetric loss profile means
  // high-priced bets need precise WR — small mis-calibration kills us.
  //   Bet at 80¢: lose 80¢, win 20¢ — need ~80% WR to break even
  //   Bet at 50¢: lose 50¢, win 50¢ — need 50% WR
  //   Bet at 30¢: lose 30¢, win 70¢ — need 30% WR
  // If real placed-bet WR is 50-60% (per recent loss streak evidence vs
  // shadow's 75-85% claims), buying favorites systematically loses money.
  // This cap forces smaller bet size at higher prices regardless of edge.
  if (entryPrice != null && entryPrice > 0) {
    let priceCap;
    if (entryPrice >= 0.80) priceCap = bankroll * 0.04;
    else if (entryPrice >= 0.65) priceCap = bankroll * 0.06;
    else if (entryPrice >= 0.50) priceCap = bankroll * 0.10;
    else priceCap = bankroll * 0.15; // underdog asymmetric pay covers WR misses
    if (size > priceCap) {
      console.log(`[sizing] 🛡️ PRICE-TIERED CAP at ${(entryPrice*100).toFixed(0)}¢: $${size.toFixed(2)} → $${priceCap.toFixed(2)}`);
      size = priceCap;
    }
  }

  return Math.max(1, size); // minimum $1
}

function getSportExposure(sport) {
  // Calculate how much is deployed on a given sport today
  let exposure = 0;
  for (const p of openPositions) {
    const ticker = p.ticker ?? '';
    if (sport === 'MLB' && ticker.includes('MLB')) exposure += p.cost;
    else if (sport === 'NBA' && ticker.includes('NBA')) exposure += p.cost;
    else if (sport === 'NHL' && ticker.includes('NHL')) exposure += p.cost;
    else if (sport === 'NFL' && ticker.includes('NFL')) exposure += p.cost;
  }
  return exposure;
}

function checkSportExposure(ticker) {
  for (const sport of ['MLB', 'NBA', 'NHL', 'NFL']) {
    if (ticker.includes(sport)) {
      const current = getSportExposure(sport);
      const sportCap = Math.max(15, getBankroll() * SPORT_EXPOSURE_PCT);
      if (current >= sportCap) {
        console.log(`[risk] ${sport} exposure $${current.toFixed(2)} >= $${sportCap.toFixed(2)} cap (8% of bankroll)`);
        return false;
      }
      return true;
    }
  }
  return true; // non-sports — no cap
}

// Update consecutive losses from trade log
function updateConsecutiveLosses() {
  if (!existsSync(TRADES_LOG)) return;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    // Read settled trades in reverse order
    let streak = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const t = JSON.parse(lines[i]);
        if (t.status !== 'settled') continue;
        if (t.realizedPnL >= 0) break; // win breaks the streak
        streak++;
      } catch { continue; }
    }
    consecutiveLosses = streak;
  } catch { /* keep current */ }
}

// Returns 'YYYY-Wnn' for the current ET date — used as a once-per-week reset marker.
// Week boundary = Monday 00:00 ET. ISO week numbering.
function getEtIsoWeekKey() {
  const et = etNow();
  const day = et.getDay() || 7; // sun=0 → 7 so Monday is 1
  const thursday = new Date(et);
  thursday.setDate(et.getDate() + (4 - day));
  const yearStart = new Date(thursday.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  return `${thursday.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Reset daily tracking (called at midnight ET or on restart)
function resetDailyTracking() {
  dailyOpenBankroll = getBankroll();
  // Soft daily halt auto-clears at midnight (the whole point — fresh bankroll basis).
  // Full halt (tradingHalted) only clears via consecutive-loss reset OR manual unhalt:
  // requires human review when 25%+ daily drawdown trips.
  if (softHaltUntilMs > 0 && Date.now() > softHaltUntilMs) {
    softHaltUntilMs = 0;
    softHaltReason = '';
    // Apply 72h Kelly haircut after a soft halt resolves (anti-martingale recovery)
    kellyHaircutUntilMs = Date.now() + 72 * 60 * 60 * 1000;
    console.log(`[risk] Soft halt cleared. Kelly haircut active for 72h.`);
  }
  // Reset HC state daily — prior night's bets shouldn't count against today's cap
  highConvictionDeployed = 0;
  lastHighConvictionAt = 0;
  updateConsecutiveLosses();
  // Weekly reset on Monday — snapshot week-open bankroll, clear week-soft-halt marker
  const wKey = getEtIsoWeekKey();
  if (wKey !== weeklyResetISOWeek) {
    weeklyOpenBankroll = getBankroll();
    weeklyResetISOWeek = wKey;
    console.log(`[risk] Weekly reset (${wKey}): weekOpenBankroll=$${weeklyOpenBankroll.toFixed(2)}`);
  }
  if (weeklyOpenBankroll === 0) weeklyOpenBankroll = getBankroll();
  console.log(`[risk] Daily reset: bankroll=$${dailyOpenBankroll.toFixed(2)} consecutiveLosses=${consecutiveLosses} weekOpen=$${weeklyOpenBankroll.toFixed(2)}`);
}

// Drawdown circuit breaker — graduated. Soft halts block new entries (existing
// positions still close). Full halts require manual unhalt. Applied inside canTrade()
// before any other gate so a tripped breaker short-circuits cleanly.
//
// Thresholds (research-backed — Pinnacle/Sharp Football):
//   −10% daily   → soft halt rest of day, 72h Kelly haircut after reset
//   −25% daily   → full halt, manual review required
//   −15% weekly  → soft halt rest of week
//   −30% weekly  → full halt
function checkDrawdownBreaker() {
  const bk = getBankroll();
  if (dailyOpenBankroll > 0) {
    const dailyDD = (dailyOpenBankroll - bk) / dailyOpenBankroll;
    if (dailyDD >= 0.25 && !tradingHalted) {
      tradingHalted = true;
      haltReason = `Daily drawdown -${(dailyDD * 100).toFixed(1)}% (open $${dailyOpenBankroll.toFixed(2)} → now $${bk.toFixed(2)}). Full halt — manual unhalt required.`;
      try { tg(`🛑 <b>FULL HALT — DAILY DRAWDOWN</b>\n\n${haltReason}\n\nTo resume: set <code>{"unhaltRequested": true}</code> in <code>logs/control.json</code> or restart bot.`); } catch {}
      console.log(`[risk] FULL HALT: ${haltReason}`);
      return false;
    }
    // 2026-05-02: bankroll floor on soft halt. At small bankroll (< $1000), normal
    // session variance can trigger -10% drawdown easily — soft-halting paralyzes
    // the bot during the bootstrap phase where we need it firing to compound.
    // Above $1000, drawdown protection kicks back in to avoid catastrophic days.
    const SOFT_HALT_BANKROLL_FLOOR = 1000;
    if (dailyDD >= 0.10 && softHaltUntilMs < Date.now() && bk >= SOFT_HALT_BANKROLL_FLOOR) {
      const tomorrow = etNow();
      tomorrow.setHours(24, 0, 0, 0);
      softHaltUntilMs = tomorrow.getTime();
      softHaltReason = `Daily drawdown -${(dailyDD * 100).toFixed(1)}% — new entries blocked rest of day, open positions still close. 72h Kelly haircut after reset.`;
      try { tg(`⚠️ <b>SOFT HALT — DAILY DRAWDOWN</b>\n\n${softHaltReason}`); } catch {}
      console.log(`[risk] SOFT HALT (daily): ${softHaltReason}`);
      return false;
    } else if (dailyDD >= 0.10 && bk < SOFT_HALT_BANKROLL_FLOOR) {
      // Log but don't halt — bankroll too small for drawdown circuit to be useful
      console.log(`[risk] SOFT HALT SKIPPED — bankroll $${bk.toFixed(2)} below $${SOFT_HALT_BANKROLL_FLOOR} floor (DD=-${(dailyDD * 100).toFixed(1)}%)`);
    }
  }
  if (weeklyOpenBankroll > 0) {
    const weeklyDD = (weeklyOpenBankroll - bk) / weeklyOpenBankroll;
    if (weeklyDD >= 0.30 && !tradingHalted) {
      tradingHalted = true;
      haltReason = `Weekly drawdown -${(weeklyDD * 100).toFixed(1)}% (week open $${weeklyOpenBankroll.toFixed(2)} → now $${bk.toFixed(2)}). Full halt — manual unhalt required.`;
      try { tg(`🛑 <b>FULL HALT — WEEKLY DRAWDOWN</b>\n\n${haltReason}\n\nThis is a regime-change signal. Audit edge before resuming.`); } catch {}
      console.log(`[risk] FULL HALT: ${haltReason}`);
      return false;
    }
    // 2026-05-02: bankroll floor for weekly halt — same logic as daily.
    // SOFT_HALT_BANKROLL_FLOOR ($1000) is defined above. Below scale, weekly
    // variance can hit 15% drawdown easily on $80-$200 bankrolls; halting
    // paralyzes the compounding phase we need most.
    if (weeklyDD >= 0.15 && softHaltUntilMs < Date.now() + 24 * 60 * 60 * 1000 && bk >= 1000) {
      // Block until next Monday 00:00 ET
      const et = etNow();
      const daysToMonday = (8 - (et.getDay() || 7)) % 7 || 7;
      const monday = new Date(et);
      monday.setDate(et.getDate() + daysToMonday);
      monday.setHours(0, 0, 0, 0);
      softHaltUntilMs = monday.getTime();
      softHaltReason = `Weekly drawdown -${(weeklyDD * 100).toFixed(1)}% — new entries blocked until Monday.`;
      try { tg(`⚠️ <b>SOFT HALT — WEEKLY DRAWDOWN</b>\n\n${softHaltReason}`); } catch {}
      console.log(`[risk] SOFT HALT (weekly): ${softHaltReason}`);
      return false;
    } else if (weeklyDD >= 0.15 && bk < 1000) {
      console.log(`[risk] WEEKLY SOFT HALT SKIPPED — bankroll $${bk.toFixed(2)} below $1000 floor (DD=-${(weeklyDD * 100).toFixed(1)}%)`);
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// P&L Trade Logging — append-only JSONL for every trade placed
// ─────────────────────────────────────────────────────────────────────────────

const TRADES_LOG = './logs/trades.jsonl';
const DAILY_LOG = './logs/daily-snapshots.jsonl';
const SCREENS_LOG = './logs/screens.jsonl';
const PAPER_TRADES_LOG = './logs/paper-trades.jsonl';
// Shadow decision tracker (2026-04-25): captures every Sonnet decision (live-edge YES + NO)
// for offline calibration analysis. Settled via Kalshi market resolution. 100x more samples
// than real trades alone; enables proper confidence calibration with Wilson-bounded buckets.
const SHADOW_DECISIONS_LOG = './logs/shadow-decisions.jsonl';
// Price tape (2026-04-29): captures per-game live price snapshots even when
// no shadow decision fires. Used for intra-game variance analysis (dip-buy thesis,
// swing-trade exit calibration). Slim records: ticker, ts, price, score, period.
const PRICE_TAPE_LOG = './logs/price-tape.jsonl';

// Throttle map: per-ticker last-tape-write timestamp. Prevents spam when same
// ticker appears in multiple per-cycle code paths.
const _priceTapeThrottle = new Map();
function logPriceTapeEntry({ ticker, price, gameBase, league, score, period, gameDetail, leadingAbbr }) {
  if (!ticker || price == null) return;
  // Throttle to once per 90s per ticker — captures ~1 sample/cycle without spam
  const last = _priceTapeThrottle.get(ticker) ?? 0;
  if (Date.now() - last < 90 * 1000) return;
  _priceTapeThrottle.set(ticker, Date.now());
  try {
    appendFileSync(PRICE_TAPE_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      ticker, gameBase, league,
      price, score, period, gameDetail, leadingAbbr,
    }) + '\n');
  } catch { /* best-effort */ }
}

// Games currently in progress — populated by checkLiveScoreEdges each cycle.
// Key: "ABBR1|ABBR2" (sorted, upper-case). Lets pre-game scanner skip live games.
const activeLiveGames = new Set();
if (!existsSync('./logs')) mkdirSync('./logs', { recursive: true });

// Kalshi parabolic fee: 7% × price × (1 - price). Max at 50¢ (1.75¢), zero at 0 or 100¢.
function kalshiFee(price) {
  return 0.07 * price * (1 - price);
}

// Net edge after fees — what we actually keep
function netEdge(confidence, price) {
  const fee = kalshiFee(price);
  return confidence - price - fee;
}

// Strip markdown code blocks and extract JSON from Claude responses
// Handles: ```json {...} ```, ```{...}```, or raw {...}
// Brace-balanced extractor: returns the FIRST fully-balanced {...} (or [...]) object.
// Fixes failures where Sonnet emits `{json}\n\nprose with {...}` — greedy regex used
// to grab everything first-{ to last-}, causing "Unexpected non-whitespace after JSON".
function extractBalanced(text, open, close) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const start = cleaned.indexOf(open);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null; // unbalanced
}
function extractJSON(text) { return extractBalanced(text, '{', '}'); }
function extractJSONArray(text) { return extractBalanced(text, '[', ']'); }

// Throttled error telemetry — sends a batched Telegram alert per error-kind at most
// once every 30 min, with up to 3 sample detail strings. Every error also logs locally.
const ERROR_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const errorAlertState = new Map();
async function reportError(kind, detail, { throttle = true } = {}) {
  const now = Date.now();
  const state = errorAlertState.get(kind) ?? { lastAlert: 0, count: 0, samples: [] };
  state.count += 1;
  if (state.samples.length < 3) state.samples.push(String(detail));
  console.log(`[error:${kind}] ${detail}`);
  const due = !throttle || (now - state.lastAlert >= ERROR_ALERT_COOLDOWN_MS);
  if (due) {
    const head = `⚠️ <b>Bot error: ${kind}</b> (x${state.count} since last alert)`;
    const samples = state.samples.map(s => `• ${s.slice(0, 220)}`).join('\n');
    try { await tg(`${head}\n${samples}`); } catch {}
    state.lastAlert = now;
    state.count = 0;
    state.samples = [];
  }
  errorAlertState.set(kind, state);
}

// Extract actual fill count from order response — Kalshi returns 0 on initial POST, fills async
function getActualFill(result, requestedQty) {
  const order = result.data?.order ?? result.data ?? {};
  // Kalshi API returns fill_count_fp as a string (e.g. "57.00"), NOT quantity_filled.
  const filled = parseFloat(order.fill_count_fp) || (order.quantity_filled ?? order.filled_quantity ?? order.filled ?? 0);
  // If API says 0 filled (common for limit orders), assume full fill for IOC or check status
  // For IOC orders: filled = actual. For limit orders: filled may be 0 initially → use requested qty
  // We'll trust the fill count if > 0, otherwise assume full fill (Kalshi fills most orders)
  return filled > 0 ? filled : requestedQty;
}

function logTrade(entry) {
  // P3.3 — capture ET time-of-day + day-of-week for future pattern analysis.
  // Enables weekend vs weekday WR splits, day-game vs night-game splits, etc.
  const etHourNow = etHour();
  const dayPart = etHourNow < 12 ? 'morning' : etHourNow < 17 ? 'afternoon' : etHourNow < 22 ? 'evening' : 'night';
  const dayOfWeek = ['sun','mon','tue','wed','thu','fri','sat'][etNow().getDay()];
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    etHour: etHourNow,
    dayPart,
    dayOfWeek,
    ...entry,
    status: 'open',           // open → settled (updated by checkSettlements)
    exitPrice: null,
    realizedPnL: null,
  };
  try {
    appendFileSync(TRADES_LOG, JSON.stringify(record) + '\n');
    console.log(`[pnl] Logged trade: ${record.exchange} ${record.ticker} ${record.side} $${record.deployCost?.toFixed(2)}`);
  } catch (e) {
    console.error('[pnl] Failed to log trade:', e.message);
  }
  // Auto-register CLV capture for pre-game-style trades. Live trades skip — entry IS the live price.
  // Strategy prefix `pre-game-` covers prediction/edge-first/paper/structural pre-entries.
  // We look up game start via pgGameStartTimes (keyed by marketBase, ie ticker without trailing -TEAM).
  try {
    const strat = String(record.strategy ?? '');
    const isPreGameLike = strat.startsWith('pre-game-') || strat === 'claude-prediction' || strat === 'ufc-prediction' || strat === 'draw-bet';
    if (isPreGameLike && record.exchange === 'kalshi' && record.ticker) {
      const marketBase = record.ticker.includes('-') ? record.ticker.slice(0, record.ticker.lastIndexOf('-')) : record.ticker;
      const gsm = pgGameStartTimes.get(marketBase);
      if (Number.isFinite(gsm) && gsm > Date.now() - 5 * 60 * 1000) {
        registerClvCapture(record.id, {
          ticker: record.ticker,
          side: record.side ?? 'yes',
          entryPrice: record.entryPrice,
          gameStartMs: gsm,
          strategy: strat,
        });
      }
    }
  } catch { /* CLV registration is best-effort */ }
  return record.id;
}

// Patch a trade record in trades.jsonl by id (used for CLV updates and similar
// post-entry annotations). Atomic rewrite — safe under append concurrency because
// readers re-read fresh each cycle. Returns true if record was found+updated.
function updateTradeRecord(tradeId, updates) {
  if (!tradeId || !existsSync(TRADES_LOG)) return false;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let updated = false;
    for (const r of records) {
      if (r.id === tradeId) {
        Object.assign(r, updates);
        updated = true;
        break;
      }
    }
    if (updated) {
      writeFileSync(TRADES_LOG, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    return updated;
  } catch (e) {
    console.error('[pnl] updateTradeRecord failed:', e.message);
    return false;
  }
}

// CLV capture loop — for each pending trade, when game start is in window, fetch
// market mid and persist closingPrice + clv to the trade record. Window opens 30s
// before game start and closes 3min after; if we miss the window the entry is
// dropped (the price has moved too far for "closing" to be meaningful).
async function captureClvTicks() {
  if (clvTracking.size === 0) return;
  const now = Date.now();
  for (const [tradeId, info] of [...clvTracking.entries()]) {
    const windowOpen = info.gameStartMs - 30 * 1000;
    const windowClose = info.gameStartMs + 3 * 60 * 1000;
    if (now < windowOpen) continue;
    if (now > windowClose) {
      clvTracking.delete(tradeId);
      console.log(`[clv] missed capture window for ${info.ticker} (game started ${Math.round((now - info.gameStartMs)/60000)}min ago)`);
      continue;
    }
    try {
      const m = await kalshiGet(`/markets/${info.ticker}`);
      const market = m.market ?? m;
      const yesAskRaw = parseFloat(market.yes_ask_dollars ?? '0');
      const yesBidRaw = parseFloat(market.yes_bid_dollars ?? '0');
      // Some endpoints return cents (1-99), others return dollars (0.01-0.99). Normalize.
      const norm = (v) => v > 1 ? v / 100 : v;
      const yesAsk = norm(yesAskRaw);
      const yesBid = norm(yesBidRaw);
      let mid = 0;
      if (yesAsk > 0 && yesBid > 0) mid = (yesAsk + yesBid) / 2;
      else if (yesAsk > 0) mid = yesAsk;
      else if (yesBid > 0) mid = yesBid;
      if (mid <= 0 || mid >= 1) continue; // try again next tick
      // For YES: closingPrice = mid. For NO: closingPrice = 1 - mid (NO market price).
      const closingPrice = info.side === 'no' ? (1 - mid) : mid;
      const clv = closingPrice - info.entryPrice; // positive = we got a better price than close
      const updated = updateTradeRecord(tradeId, {
        closingPrice: Math.round(closingPrice * 10000) / 10000,
        clv: Math.round(clv * 10000) / 10000,
        clvCapturedAt: new Date().toISOString(),
      });
      if (updated) {
        const clvCents = Math.round(clv * 100);
        const sign = clvCents >= 0 ? '+' : '';
        console.log(`[clv] ${info.ticker} entry=${Math.round(info.entryPrice*100)}¢ close=${Math.round(closingPrice*100)}¢ CLV=${sign}${clvCents}¢ (${info.strategy})`);
      }
      clvTracking.delete(tradeId);
    } catch (e) {
      // Transient — next tick will retry while still inside window
    }
  }
}

// Log a paper (simulated) pre-game trade — no real money, for calibration
function logPaperTrade(entry) {
  const record = {
    id: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    strategy: 'pre-game-paper',
    status: 'pending',       // pending → won | lost (updated by settlePaperTrades)
    outcome: null,
    settledAt: null,
    paperPnL: null,
    ...entry,
  };
  try {
    appendFileSync(PAPER_TRADES_LOG, JSON.stringify(record) + '\n');
    console.log(`[paper] Logged paper trade: ${record.sport?.toUpperCase()} ${record.marketBase} → ${record.teamAbbr} @${Math.round((record.price??0)*100)}¢ conf=${Math.round((record.confidence??0)*100)}%`);
  } catch (e) {
    console.error('[paper] Failed to log paper trade:', e.message);
  }
}

// Shadow decision dedup map: avoid logging same (ticker, score, price-bucket) within 5min.
// Shadow decisions fire many times per game cycle as Sonnet re-evaluates; we only need
// one shadow record per state-change to track outcome.
const recentShadowKeys = new Map(); // key → ts

// Build enriched shadow-context fields from available state (2026-04-27 expansion).
// Adds dimensions the shadow tracker wasn't capturing — each one a candidate for
// future pattern mining. All best-effort; missing data → null fields.
//
// Inputs (any may be null/undefined):
//   priceData: cachedPrices entry with yes/no asks + yesBid/noBid (post-2026-04-27)
//   gameDetail: ESPN status string ("8:59 - Q4", "Mid 7th", "82'", etc.)
//   ticker: market ticker (used for last-seen-prices velocity lookup)
//   side: 'yes' | 'no' for direction-aware velocity
//
// Returns object suitable for spread into the shadow record.
function buildShadowContext({ priceData, gameDetail, ticker, side, decisionPrice }) {
  const ctx = {
    yesBid: null, yesAsk: null, spreadCents: null,
    clockSeconds: null,
    velocity60s: null, velocityDir: null,
    etHour: etHour(),
    dayOfWeek: ['sun','mon','tue','wed','thu','fri','sat'][etNow().getDay()],
  };
  // Bid/ask spread (liquidity proxy)
  if (priceData) {
    const ya = priceData.yes ?? 0;
    const yb = priceData.yesBid ?? 0;
    if (ya > 0) ctx.yesAsk = Math.round(ya * 1000) / 1000;
    if (yb > 0) ctx.yesBid = Math.round(yb * 1000) / 1000;
    if (ya > 0 && yb > 0) ctx.spreadCents = Math.round((ya - yb) * 100);
  }
  // Clock-seconds-remaining (time-pressure proxy) — parse "MM:SS" patterns
  if (gameDetail) {
    const m = String(gameDetail).match(/(\d{1,2}):(\d{2})/);
    if (m) {
      const mins = parseInt(m[1], 10), secs = parseInt(m[2], 10);
      if (Number.isFinite(mins) && Number.isFinite(secs)) ctx.clockSeconds = mins * 60 + secs;
    }
  }
  // Last-60s velocity (momentum proxy) from lastSeenPrices map
  if (ticker) {
    const lsp = lastSeenPrices.get(ticker);
    if (lsp && Number.isFinite(lsp.price) && Number.isFinite(lsp.ts) && Number.isFinite(decisionPrice)) {
      const elapsedMin = Math.max(1/60, (Date.now() - lsp.ts) / 60000);
      if (elapsedMin <= 5) {
        const yesMove = decisionPrice - lsp.price;
        const moveTowardEntry = side === 'no' ? -yesMove : yesMove;
        ctx.velocity60s = Math.round((Math.abs(yesMove) * 100) / elapsedMin * 10) / 10;
        ctx.velocityDir = moveTowardEntry > 0.005 ? 'against' : moveTowardEntry < -0.005 ? 'aligned' : 'flat';
      }
    }
  }
  return ctx;
}

// Log a shadow Claude decision (every YES/NO from live-edge Sonnet) for calibration analysis.
// These are NOT trades — purely data points to track Claude's confidence vs actual game outcome.
// Settled via Kalshi market.result by settleShadowDecisions() — see Phase 2.
function logShadowDecision(entry) {
  // Quality filter: skip ultra-low-info decisions
  if (entry.claudeConfidence != null && entry.claudeConfidence < 0.50) return; // <50% conf = no signal
  if (entry.decisionPrice != null && entry.decisionPrice > 0.95) return;       // settlement-imminent
  // Dedup: same (ticker, score, ~5¢ price-bucket) in last 5min = skip
  const priceCents = Math.round((entry.decisionPrice ?? 0) * 100);
  const priceBucket = Math.round(priceCents / 5) * 5; // 5-cent buckets
  // 2026-05-01: include `stage` in dedup key. Without it, when multiple stages
  // log records for the SAME game state (e.g., live-edge-trailer-synthetic and
  // live-edge-comeback-synthetic both fire on the same MLB trailer), the second
  // logger gets dedup'd and its records never persist. This was causing
  // comeback-buy synthetic = 0 records despite many eligible setups.
  const dedupKey = `${entry.stage ?? '?'}|${entry.ticker}|${entry.scoreDiff}|${entry.period}|${priceBucket}`;
  const lastTs = recentShadowKeys.get(dedupKey) ?? 0;
  if (Date.now() - lastTs < 5 * 60 * 1000) return; // skip within 5min
  recentShadowKeys.set(dedupKey, Date.now());
  // Periodic GC: remove entries older than 30min to bound memory
  if (recentShadowKeys.size > 1000) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, t] of recentShadowKeys) if (t < cutoff) recentShadowKeys.delete(k);
  }
  const record = {
    id: `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    status: 'pending',          // pending → settled (updated by settleShadowDecisions)
    settledAt: null,
    winningSide: null,          // 'yes' or 'no' from market.result
    ourPickWon: null,           // boolean: did our targetAbbr's YES contract win?
    calibrationDelta: null,     // Brier component: (claudeConfidence - outcome)²
    ...entry,
  };
  try {
    appendFileSync(SHADOW_DECISIONS_LOG, JSON.stringify(record) + '\n');
  } catch (e) {
    // Silent fail — shadow data is best-effort, don't disrupt trading
  }
}

// Log a pregame rejection — captures EVERY pre-Sonnet and post-Sonnet gate that
// kills a candidate. Bypasses logShadowDecision's filters (no 50% conf floor, no
// dedup, no price ceiling) so we get every rejection on record. Used to find the
// real bottleneck after pregame went 5+ days with zero fires (2026-04-30).
function logPregameRejection(market, subStage, reason, ctx = {}) {
  try {
    const team = (ctx.team ?? '').toUpperCase();
    const ticker = market?.base ? (market.base + (team ? '-' + team : '')) : (ctx.ticker ?? null);
    const record = {
      id: `pgrej-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      stage: 'pre-game',
      subStage,                     // 'pre-sonnet' | 'post-sonnet-gate' | 'sonnet-error'
      ticker,
      marketBase: market?.base ?? null,
      marketTitle: market?.title ?? null,
      sport: ctx.sport ?? null,
      league: ctx.league ?? null,
      decision: 'no-trade',
      rejectReason: reason,
      claudeConfidence: ctx.confidence ?? null,
      decisionPrice: ctx.price ?? null,
      edge: ctx.edge ?? null,
      targetAbbr: team || null,
      // 2026-05-02: persist team1/team2 abbrs so the settler can resolve game outcome
      // even when ticker is the base (no team suffix). Without these, pgrej records
      // never settle (247 stuck pending in audit) because Kalshi `/markets/{base}`
      // returns 404 — markets need a team-suffix form.
      team1Abbr: (market?.team1?.team ?? '').toUpperCase() || null,
      team2Abbr: (market?.team2?.team ?? '').toUpperCase() || null,
      team1Price: market?.team1?.price ?? null,
      team2Price: market?.team2?.price ?? null,
      reasoningPreview: ctx.reasoningPreview ?? null,
      reasoningTags: ctx.reasoningTags ?? null,
      reasoningStructured: ctx.reasoningStructured ?? null,
      gateContext: ctx.gateContext ?? null,
      status: 'pending',
      settledAt: null,
      winningSide: null,
      ourPickWon: null,
      calibrationDelta: null,
    };
    appendFileSync(SHADOW_DECISIONS_LOG, JSON.stringify(record) + '\n');
  } catch { /* best-effort, never disrupt trading */ }
}

// 2026-04-30: Fix A/D telemetry — log when our structural detector match would
// have fired but a price cap blocked it. Lets us verify post-deploy that the caps
// aren't over-correcting (e.g., blocking the +17pt edge MLB-p5-d3 cell).
function logFixABlock({ league, period, diff, price, targetAbbr, gate, ticker }) {
  try {
    const record = {
      id: `fixblock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      stage: 'live-edge-fix-block',
      subStage: gate,
      decision: 'no-trade',
      rejectReason: gate,
      league,
      period,
      scoreDiff: diff,
      decisionPrice: price,
      targetAbbr,
      ticker: ticker ?? null, // 2026-05-01: needed for settlement-based outcome verification
      gateContext: { gate, diff, period, price },
      status: 'pending',
      settledAt: null,
      ourPickWon: null,
    };
    appendFileSync(SHADOW_DECISIONS_LOG, JSON.stringify(record) + '\n');
  } catch { /* best-effort */ }
}

// Settle pending paper trades against Kalshi market outcomes
async function settlePaperTrades() {
  if (!existsSync(PAPER_TRADES_LOG)) return;
  const lines = readFileSync(PAPER_TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
  const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const pending = trades.filter(t => t.status === 'pending' && t.ticker);
  if (pending.length === 0) return;

  let updated = false;
  for (const t of pending) {
    try {
      const market = await kalshiGet(`/markets/${t.ticker}`);
      if (!market?.market?.result) continue; // not settled yet
      const result = market.market.result; // 'yes' or 'no'
      const won = result === 'yes'; // we always log the YES side (the team we picked)
      t.status = won ? 'won' : 'lost';
      t.outcome = won ? 'correct' : 'incorrect';
      t.settledAt = market.market.close_time ?? new Date().toISOString();
      const stake = t.wouldBetAmount ?? 5;
      t.paperPnL = won
        ? Math.round(stake * ((1 / (t.price ?? 0.7)) - 1) * 100) / 100
        : -stake;
      updated = true;
      console.log(`[paper] Settled ${t.marketBase}: ${t.teamAbbr} ${t.status} | paperPnL=$${t.paperPnL?.toFixed(2)}`);
    } catch { /* market not found or not settled — skip */ }
  }

  if (!updated) return;
  // Rewrite file with updated records
  const allById = new Map(trades.map(t => [t.id, t]));
  for (const t of pending) allById.set(t.id, t);
  writeFileSync(PAPER_TRADES_LOG, [...allById.values()].map(t => JSON.stringify(t)).join('\n') + '\n');
}

// PHASE 2 — Settle pending shadow decisions against Kalshi market outcomes.
// For each shadow record, fetch the ticker's resolution, compute whether our
// targetAbbr's YES contract won, and store calibrationDelta (Brier component).
// Caps work per cycle to avoid hammering the Kalshi API on backlog.
async function settleShadowDecisions() {
  if (!existsSync(SHADOW_DECISIONS_LOG)) return;
  const lines = readFileSync(SHADOW_DECISIONS_LOG, 'utf-8').split('\n').filter(l => l.trim());
  const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // Settle records older than 6h (game should be over by then)
  const cutoffMs = Date.now() - 6 * 3600 * 1000;
  const pending = records.filter(r => r.status === 'pending' && r.ticker && Date.parse(r.ts ?? '') < cutoffMs);
  if (pending.length === 0) return;
  // Cap per-cycle work — don't slam Kalshi if we have a big backlog
  const MAX_PER_CYCLE = 30;
  const batch = pending.slice(0, MAX_PER_CYCLE);

  let updated = false;
  for (const r of batch) {
    try {
      // 2026-05-02: pgrej records have ticker = market base (no team suffix), so a
      // direct kalshiGet fails. When base + team1Abbr/team2Abbr are present, query
      // team1's market and infer game winner from result. We don't set ourPickWon
      // for these (no pick was placed) but we set gameWinner for analysis.
      const isBaseTicker = r.stage === 'pre-game' && r.team1Abbr && r.team2Abbr
        && r.ticker && !r.ticker.includes(`-${r.team1Abbr}`) && !r.ticker.includes(`-${r.team2Abbr}`);
      const lookupTicker = isBaseTicker ? `${r.ticker}-${r.team1Abbr}` : r.ticker;
      const market = await kalshiGet(`/markets/${lookupTicker}`);
      const result = market?.market?.result;
      if (!result || (result !== 'yes' && result !== 'no')) {
        // Mark as expired (game over but no resolution we can read) so we don't loop on it forever
        if (Date.parse(r.ts ?? '') < Date.now() - 48 * 3600 * 1000) {
          r.status = 'expired';
          updated = true;
        }
        continue;
      }
      r.status = 'settled';
      r.settledAt = market.market.close_time ?? new Date().toISOString();
      r.winningSide = result;
      if (isBaseTicker) {
        // For base-ticker pgrej records: query result is for team1 side.
        // result === 'yes' means team1 won, 'no' means team2 won.
        r.gameWinner = result === 'yes' ? r.team1Abbr : r.team2Abbr;
        // ourPickWon stays null — no pick was placed
      } else {
        // We log every shadow as the YES side of targetAbbr — won iff result === 'yes'
        r.ourPickWon = result === 'yes';
      }
      // Brier component: (predicted - outcome)². Lower is better. 0 = perfect.
      if (r.claudeConfidence != null) {
        const outcome = r.ourPickWon ? 1 : 0;
        r.calibrationDelta = Math.round(Math.pow(r.claudeConfidence - outcome, 2) * 10000) / 10000;
      }
      // 2026-04-30: pre-compute price recovery on synthetic-trail AND live-edge shadows.
      // For live-edge: tells us how often Sonnet-rejected setups would have hit +12¢
      // intra-game (the swing exit threshold). Critical for tuning swing-mode floors.
      if ((r.stage === 'live-edge-trailer-synthetic' || r.stage === 'live-edge')
          && existsSync(PRICE_TAPE_LOG) && r.decisionPrice) {
        try {
          const tapeLines = readFileSync(PRICE_TAPE_LOG, 'utf-8').split('\n').filter(l => l.trim());
          const entryMs = Date.parse(r.ts ?? '');
          let maxAfter = r.decisionPrice;
          for (const tl of tapeLines) {
            try {
              const t = JSON.parse(tl);
              if (t.ticker !== r.ticker) continue;
              if (Date.parse(t.ts ?? '') <= entryMs) continue;
              if (typeof t.price === 'number' && t.price > maxAfter) maxAfter = t.price;
            } catch { /* skip */ }
          }
          r.maxPriceAfterEntry = maxAfter;
          r.maxRecoveryFromEntry = Math.round((maxAfter - r.decisionPrice) * 10000) / 10000;
          r.recoveryReached10c = (maxAfter - r.decisionPrice) >= 0.10;
          r.recoveryReached12c = (maxAfter - r.decisionPrice) >= 0.12;
          r.recoveryReached15c = (maxAfter - r.decisionPrice) >= 0.15;
          r.recoveryReached20c = (maxAfter - r.decisionPrice) >= 0.20;
        } catch { /* best-effort */ }
      }
      updated = true;
    } catch { /* network error or market not found — try next cycle */ }
  }

  if (!updated) return;
  // Rewrite file with updated records (atomic by Map dedup on id)
  const allById = new Map(records.map(r => [r.id, r]));
  for (const r of batch) allById.set(r.id, r);
  writeFileSync(SHADOW_DECISIONS_LOG, [...allById.values()].map(r => JSON.stringify(r)).join('\n') + '\n');
  const settled = batch.filter(r => r.status === 'settled').length;
  if (settled > 0) console.log(`[shadow] Settled ${settled} decisions (${pending.length - MAX_PER_CYCLE > 0 ? `${pending.length - MAX_PER_CYCLE} remaining` : 'queue clear'})`);
}

// Log screening decisions for analysis: what Haiku flagged, what Sonnet decided
function logScreen(entry) {
  try {
    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(SCREENS_LOG, JSON.stringify(record) + '\n');
  } catch { /* silent */ }
}

// Daily analytics snapshot — called at midnight ET
function saveDailySnapshot() {
  try {
    // Read trade history for stats
    let totalTrades = 0, settledTrades = 0, wins = 0, losses = 0;
    let totalPnL = 0, todayPnL = 0, todayTrades = 0;
    const strategyStats = {};
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;

    if (existsSync(TRADES_LOG)) {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          totalTrades++;
          if (t.status === 'settled') {
            settledTrades++;
            const pnl = t.realizedPnL ?? 0;
            totalPnL += pnl;
            if (pnl >= 0) wins++; else losses++;
            if (t.settledAt && Date.parse(t.settledAt) > cutoff24h) todayPnL += pnl;
          }
          if (t.timestamp && Date.parse(t.timestamp) > cutoff24h) todayTrades++;
          // Per-strategy — exclude manual exits so stats reflect bot decisions only
          const strat = t.strategy ?? 'unknown';
          const isManualExit = t.status === 'closed-manual' || t.status === 'sold-manual';
          if (!strategyStats[strat]) strategyStats[strat] = { trades: 0, settled: 0, wins: 0, losses: 0, pnl: 0 };
          strategyStats[strat].trades++;
          if ((t.status === 'settled' || t.status?.startsWith('sold-')) &&
              t.status !== 'sold-sync-bug' && t.status !== 'failed-bug' && !isManualExit) {
            strategyStats[strat].settled++;
            if ((t.realizedPnL ?? 0) >= 0) strategyStats[strat].wins++;
            else strategyStats[strat].losses++;
            strategyStats[strat].pnl += (t.realizedPnL ?? 0);
          }
        } catch { /* skip */ }
      }
    }

    const snapshot = {
      date: etTodayStr(),
      timestamp: new Date().toISOString(),
      bankroll: getBankroll(),
      kalshiCash: kalshiBalance,
      kalshiPositions: kalshiPositionValue,
      polyBalance,
      openPositionCount: openPositions.length,
      totalDeployed: getTotalDeployed(),
      totalTrades,
      settledTrades,
      wins,
      losses,
      winRate: settledTrades > 0 ? Math.round((wins / settledTrades) * 100) : null,
      totalPnL: Math.round(totalPnL * 100) / 100,
      todayPnL: Math.round(todayPnL * 100) / 100,
      todayTrades,
      consecutiveLosses,
      strategyStats,
    };

    appendFileSync(DAILY_LOG, JSON.stringify(snapshot) + '\n');
    console.log(`[analytics] Daily snapshot saved: bankroll=$${snapshot.bankroll.toFixed(2)} pnl=$${snapshot.totalPnL.toFixed(2)} winRate=${snapshot.winRate ?? 'n/a'}%`);
    return snapshot;
  } catch (e) {
    console.error('[analytics] snapshot error:', e.message);
    return null;
  }
}

// Send daily P&L report to Telegram
async function sendDailyReport() {
  const snap = saveDailySnapshot();
  if (!snap) return;

  const stratLines = Object.entries(snap.strategyStats).map(([name, s]) => {
    const wr = s.settled > 0 ? `${Math.round((s.wins / s.settled) * 100)}%` : 'n/a';
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
    return `  ${name}: ${s.trades} trades, ${wr} win rate, ${pnlStr}`;
  }).join('\n');

  const pnlIcon = snap.totalPnL >= 0 ? '📈' : '📉';
  const todayIcon = snap.todayPnL >= 0 ? '+' : '';

  await tg(
    `${pnlIcon} <b>DAILY REPORT — ${snap.date}</b>\n\n` +
    `<b>Portfolio:</b>\n` +
    `Kalshi: $${snap.kalshiCash.toFixed(2)} cash + $${snap.kalshiPositions.toFixed(2)} positions\n` +
    `Polymarket: $${snap.polyBalance.toFixed(2)}\n` +
    `Total: <b>$${snap.bankroll.toFixed(2)}</b>\n\n` +
    `<b>Trading:</b>\n` +
    `Today: ${snap.todayTrades} trades, ${todayIcon}$${snap.todayPnL.toFixed(2)}\n` +
    `All time: ${snap.totalTrades} trades, ${snap.settledTrades} settled\n` +
    `Won: ${snap.wins} | Lost: ${snap.losses} | Win rate: ${snap.winRate ?? 'n/a'}%\n` +
    `Total P&L: <b>${snap.totalPnL >= 0 ? '+' : ''}$${snap.totalPnL.toFixed(2)}</b>\n\n` +
    `<b>By Strategy:</b>\n` +
    (stratLines || '  No trades yet') + '\n\n' +
    `Open: ${snap.openPositionCount} positions, $${snap.totalDeployed.toFixed(2)} deployed\n` +
    `Consecutive losses: ${snap.consecutiveLosses}\n` +
    `API spend today: ~$${(stats.apiSpendCents / 100).toFixed(2)} (${stats.claudeCalls} calls)\n` +
    `🕐 ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`
  );
}

async function refreshPortfolio() {
  try {
    const bal = await kalshiGet('/portfolio/balance');
    kalshiBalance = (bal.balance ?? 0) / 100;
    kalshiPositionValue = (bal.portfolio_value ?? 0) / 100;
  } catch { /* keep old */ }

  // Fetch Kalshi open positions — filter by event_exposure (active positions only)
  try {
    const data = await kalshiGet('/portfolio/positions');
    const allPositions = data.event_positions ?? data.market_positions ?? data.positions ?? [];
    const freshPositions = allPositions.map(p => ({
      ticker: p.event_ticker ?? p.ticker ?? p.market_ticker ?? '',
      cost: parseFloat(p.total_cost_dollars ?? '0'),
      exposure: parseFloat(p.event_exposure_dollars ?? '0'),
      exchange: 'kalshi',
    })).filter(p => p.exposure > 0);

    // Sanity guard: if API returns 0 Kalshi positions but JSONL has recent open trades (within 20min),
    // the API response is likely stale/lagged — keep existing positions rather than wiping them.
    // This prevents false "manual cashout" marks right after a restart or during Kalshi API lag.
    const prevKalshiCount = openPositions.filter(p => p.exchange === 'kalshi').length;
    if (freshPositions.length === 0 && prevKalshiCount > 0) {
      let hasRecentOpenTrade = false;
      try {
        if (existsSync(TRADES_LOG)) {
          const recentCutoff = Date.now() - 20 * 60 * 1000;
          const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim()).slice(-50);
          hasRecentOpenTrade = lines.some(l => { try { const t = JSON.parse(l); return t.status === 'open' && t.exchange === 'kalshi' && Date.parse(t.timestamp) > recentCutoff; } catch { return false; } });
        }
      } catch {}
      if (hasRecentOpenTrade) {
        console.log(`[portfolio] Kalshi API returned 0 positions but recent open trades exist — keeping previous position data`);
        // Don't overwrite openPositions — keep stale Kalshi data, just update Poly below
      } else {
        openPositions = openPositions.filter(p => p.exchange !== 'kalshi');
        for (const p of freshPositions) openPositions.push(p);
      }
    } else {
      openPositions = openPositions.filter(p => p.exchange !== 'kalshi');
      for (const p of freshPositions) openPositions.push(p);
    }
  } catch { /* keep old openPositions on fetch failure — don't wipe known positions */ }

  // Add Polymarket open positions from trades log — Poly API doesn't have a positions endpoint
  try {
    if (existsSync(TRADES_LOG)) {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          if (t.status === 'open' && t.exchange === 'polymarket') {
            openPositions.push({
              ticker: t.ticker,
              cost: t.deployCost ?? 0,
              exchange: 'polymarket',
            });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  // Also refresh Poly balance
  await refreshPolyBalance();

  // Sync: two-way reconciliation between Kalshi portfolio and JSONL trades log
  try {
    if (existsSync(TRADES_LOG)) {
      const kalshiPositions = openPositions.filter(p => p.exchange === 'kalshi');
      const kalshiTickers = new Set(kalshiPositions.map(p => p.ticker));
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      let synced = false;

      // ── Part 1: Close bot bets that are gone from Kalshi (manual cashout) ──
      for (const t of trades) {
        if (t.status !== 'open' || t.exchange !== 'kalshi') continue;
        // Prefix-aware match: Kalshi API returns event_ticker without team suffix
        const isStillOpen = [...kalshiTickers].some(kt =>
          t.ticker === kt || t.ticker.startsWith(kt + '-') || kt.startsWith(t.ticker + '-')
        );
        if (isStillOpen) {
          // Position confirmed present — clear any miss streak
          missingFromKalshi.delete(t.id);
          continue;
        }
        if (!isStillOpen) {
          // Grace period: 15 min — Kalshi API can lag, event vs market ticker mismatch common
          const placedAt = t.timestamp ? Date.parse(t.timestamp) : 0;
          if (Date.now() - placedAt < 15 * 60 * 1000) continue;
          // 2-strike rule: must be absent from Kalshi for 2+ consecutive sync cycles (~2 min)
          // before we close it. A single API miss (empty response, lag) won't kill a real position.
          //
          // MASS-DISAPPEARANCE GUARD: if ALL open Kalshi positions went missing simultaneously,
          // treat it as a Kalshi API outage/glitch — not a manual cashout. This prevents a single
          // bad API response from wiping all tracked positions. Only close individual positions when
          // a subset disappears (implying user action), not the whole portfolio at once.
          const openKalshiCount = trades.filter(t2 => t2.status === 'open' && t2.exchange === 'kalshi').length;
          const missingCount = trades.filter(t2 => t2.status === 'open' && t2.exchange === 'kalshi' && !([...kalshiTickers].some(kt => t2.ticker === kt || t2.ticker.startsWith(kt + '-') || kt.startsWith(t2.ticker + '-')))).length;
          if (missingCount >= openKalshiCount && openKalshiCount >= 2) {
            massDisappearStreak++;
            if (massDisappearStreak < 3) {
              console.log(`[sync] ALL ${openKalshiCount} Kalshi positions absent (streak ${massDisappearStreak}/3) — waiting to confirm`);
              break;
            }
            console.log(`[sync] ALL ${openKalshiCount} Kalshi positions absent for ${massDisappearStreak} cycles — treating as real manual cashout`);
          } else {
            massDisappearStreak = 0;
          }
          const firstMissing = missingFromKalshi.get(t.id);
          if (!firstMissing) {
            missingFromKalshi.set(t.id, Date.now());
            console.log(`[sync] ${t.ticker} absent from Kalshi (strike 1) — watching`);
            continue; // don't close yet, wait for next sync to confirm
          }
          if (Date.now() - firstMissing < 90 * 1000) continue; // wait at least 90s between strikes
          // Re-read JSONL for this trade — executeSell may have finalized it since we loaded trades[].
          // Without this, a successful sell that wrote status='sold-...' gets clobbered to 'closed-manual'
          // with null P&L, ghosting the realized profit.
          try {
            const freshLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
            const fresh = freshLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            const freshT = fresh.find(u => u.id === t.id);
            if (freshT && freshT.status !== 'open') {
              console.log(`[sync] Skipping closed-manual for ${t.ticker} — JSONL already shows ${freshT.status}`);
              missingFromKalshi.delete(t.id);
              t.status = freshT.status;
              t.realizedPnL = freshT.realizedPnL;
              t.settledAt = freshT.settledAt;
              continue;
            }
          } catch { /* fall through to closed-manual */ }
          t.realizedPnL = t.realizedPnL ?? null; // unknown — don't zero it out
          t.status = 'closed-manual';
          t.settledAt = new Date().toISOString();
          synced = true;
          const pnlStr = t.realizedPnL != null ? ` P&L≈$${t.realizedPnL.toFixed(2)}` : ' P&L=unknown';
          console.log(`[sync] Manual cashout: ${t.ticker}${pnlStr}`);
        }
      }

      // ── Part 2: Detect manual bets (Kalshi positions with no JSONL entry) ──
      // 2026-05-01: BEFORE labeling as manual, check if this matches a recent
      // phantom order the bot placed. If yes — adopt it as a recovered bot
      // trade with proper strategy/entry context, not a manual mystery bet.
      const trackedTickers = new Set(trades.filter(t => t.exchange === 'kalshi').map(t => t.ticker));
      // Prune phantom tracker entries older than TTL
      for (const [oid, p] of phantomOrderTracker.entries()) {
        if (Date.now() - (p.ts ?? 0) > PHANTOM_TRACKER_TTL_MS) phantomOrderTracker.delete(oid);
      }
      for (const pos of kalshiPositions) {
        if (pos.exposure <= 0) continue;
        // Check if this position matches any tracked trade (prefix-aware)
        const isTracked = [...trackedTickers].some(tt =>
          tt === pos.ticker || tt.startsWith(pos.ticker + '-') || pos.ticker.startsWith(tt + '-')
        );
        if (!isTracked) {
          // 2026-05-01: check phantom tracker — was this a bot order that filled late?
          let phantomMatch = null;
          for (const [orderId, p] of phantomOrderTracker.entries()) {
            // Match exact ticker (phantom orders have full team-suffix tickers)
            if (p.ticker === pos.ticker) {
              phantomMatch = { orderId, ...p };
              break;
            }
          }
          if (phantomMatch) {
            // RECOVERED phantom — adopt with original bot context
            const recoveredQty = Math.round(parseFloat(pos.position_fp ?? '0')) || phantomMatch.attemptedQty;
            const record = {
              id: `recovered-${phantomMatch.orderId}`,
              timestamp: new Date(phantomMatch.ts).toISOString(),
              exchange: 'kalshi',
              strategy: phantomMatch.strategy ?? 'live-prediction',
              ticker: pos.ticker, title: pos.ticker,
              side: 'yes',
              deployCost: pos.cost,
              quantity: recoveredQty,
              entryPrice: phantomMatch.price,
              filled: recoveredQty,
              orderId: phantomMatch.orderId,
              edge: null,
              confidence: phantomMatch.confidence ?? null,
              reasoning: `RECOVERED phantom — bot placed order ${Math.round((Date.now() - phantomMatch.ts) / 60000)}min ago, filled after retry window. Now adopted for management.`,
              league: phantomMatch.league ?? null,
              status: 'open',
              exitPrice: null,
              realizedPnL: null,
              isRecoveredPhantom: true,
            };
            appendFileSync(TRADES_LOG, JSON.stringify(record) + '\n');
            trackedTickers.add(pos.ticker);
            phantomOrderTracker.delete(phantomMatch.orderId);
            console.log(`[sync] ✓ RECOVERED phantom fill: ${pos.ticker} adopted as ${phantomMatch.strategy} trade (entry ${(phantomMatch.price*100).toFixed(0)}¢, qty ${recoveredQty})`);
            try {
              tg(`♻️ <b>RECOVERED PHANTOM POSITION</b>\nTicker: ${pos.ticker}\nStrategy: ${phantomMatch.strategy}\nEntry: ${(phantomMatch.price*100).toFixed(0)}¢ × ${recoveredQty}\nThe bot's order from ${Math.round((Date.now() - phantomMatch.ts) / 60000)}min ago filled late — now under bot management for exits.`);
            } catch {}
            continue;
          }
          // No phantom match — genuinely manual or untracked
          const record = {
            id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toISOString(),
            exchange: 'kalshi', strategy: 'manual',
            ticker: pos.ticker, title: pos.ticker,
            side: 'yes', deployCost: pos.cost, quantity: null,
            entryPrice: null, // we don't know the original entry price
            edge: null, confidence: null, reasoning: 'Manually placed outside bot',
            status: 'open', exitPrice: null, realizedPnL: null,
          };
          appendFileSync(TRADES_LOG, JSON.stringify(record) + '\n');
          trackedTickers.add(pos.ticker);
          console.log(`[sync] Detected manual bet: ${pos.ticker} ~$${pos.cost.toFixed(2)} deployed`);
        }
      }

      if (synced) {
        const updatedLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
        const updatedTrades = updatedLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        for (const t of trades) {
          if (t.status === 'closed-manual') {
            const idx = updatedTrades.findIndex(u => u.id === t.id);
            if (idx >= 0) updatedTrades[idx] = t;
          }
        }
        writeFileSync(TRADES_LOG, updatedTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
      }
    }
  } catch (e) { console.error('[sync] error:', e.message); }

  const kalshiCount = openPositions.filter(p => p.exchange === 'kalshi').length;
  const polyCount = openPositions.filter(p => p.exchange === 'polymarket').length;
  console.log(`[portfolio] Kalshi: $${kalshiBalance.toFixed(2)} cash + $${kalshiPositionValue.toFixed(2)} positions | Poly: $${polyBalance.toFixed(2)} | Open: ${kalshiCount} Kalshi + ${polyCount} Poly`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Team Abbreviation Mapping — ESPN and Kalshi use different abbreviations
// ─────────────────────────────────────────────────────────────────────────────

const ABBR_MAP = {
  // ESPN → Kalshi (and vice versa — we normalize to check both)
  'CHW': 'CWS', 'CWS': 'CHW',    // Chicago White Sox
  'AZ': 'ARI', 'ARI': 'AZ',       // Arizona Diamondbacks
  'GS': 'GSW', 'GSW': 'GS',       // Golden State Warriors
  'NY': 'NYK', 'NYK': 'NY',       // New York Knicks
  'SA': 'SAS', 'SAS': 'SA',       // San Antonio Spurs
  'NO': 'NOP', 'NOP': 'NO',       // New Orleans Pelicans
  'UTAH': 'UTA', 'UTA': 'UTAH',   // Utah Jazz/Hockey
  'MON': 'MTL', 'MTL': 'MON',     // Montreal Canadiens
  'LA': 'LAK', 'LAK': 'LA',       // Los Angeles Kings
  'NJ': 'NJD', 'NJD': 'NJ',       // New Jersey Devils
  'TB': 'TBL', 'TBL': 'TB',       // Tampa Bay Lightning (NHL only — MLB TB is fine)
  'WSH': 'WAS', 'WAS': 'WSH',     // Washington (varies by sport)
  'ATH': 'OAK', 'OAK': 'ATH',     // Oakland/Athletics
  // Soccer — MLS
  'RBNY': 'NYRB', 'NYRB': 'RBNY', // NY Red Bulls — ESPN=RBNY, Kalshi=NYRB
  'NYCFC': 'NYC', 'NYC': 'NYCFC', // NYC FC
  'SKC': 'KC',                      // Sporting KC — ESPN=SKC, Kalshi=KC (check for conflicts w/ MLB KC)
  'SJ': 'SJE', 'SJE': 'SJ',       // San Jose Earthquakes
  'CLT': 'CHA',                     // Charlotte FC — ESPN=CLT, Kalshi may use CHA
  'LAFC': 'LAFC',                   // LAFC (same)
  'LAG': 'LAG',                     // LA Galaxy (same)
  // Soccer — EPL / La Liga
  'MAN': 'MUN', 'MUN': 'MAN',     // Manchester United
  'WOL': 'WLV', 'WLV': 'WOL',    // Wolverhampton
  'BHA': 'BRI', 'BRI': 'BHA',     // Brighton — ESPN=BHA, Kalshi=BRI
  'VAL': 'VLL', 'VLL': 'VAL',     // Valladolid
  'SHU': 'SHE', 'SHE': 'SHU',    // Sheffield United
  'WHU': 'WH', 'WH': 'WHU',      // West Ham
  'NUFC': 'NEW', 'NEW': 'NUFC',  // Newcastle
};

// Dynamic aliases learned from Kalshi ticker ↔ ESPN name matching at runtime
const dynamicAbbr = new Map();
// Pre-seed La Liga mismatches where ABBR_MAP can't represent 1:many mappings.
// ESPN "VAL" = Valencia (Kalshi VCF), but ABBR_MAP already uses VAL↔VLL for Valladolid.
// Similarly MLL (Mallorca) → Kalshi MAL has no static entry. The alias-learner only
// fires when ONE side of a game is unmatched; two-sided mismatches (MAL@VCF with
// ESPN MLL@VAL) never trigger it. Pre-seed so tickerHasTeam matches either way.
dynamicAbbr.set('VAL', new Set(['VCF', 'VLL']));
dynamicAbbr.set('VCF', new Set(['VAL']));
dynamicAbbr.set('MLL', new Set(['MAL']));
dynamicAbbr.set('MAL', new Set(['MLL']));

// Check if a ticker contains a team abbreviation (tries static map, then dynamic aliases)
function tickerHasTeam(ticker, teamAbbr) {
  const upper = ticker.toUpperCase();
  const abbr = teamAbbr.toUpperCase();
  if (upper.includes(abbr)) return true;
  const alt = ABBR_MAP[abbr];
  if (alt && upper.includes(alt)) return true;
  const dynAlts = dynamicAbbr.get(abbr);
  if (dynAlts) {
    for (const da of dynAlts) { if (upper.includes(da)) return true; }
  }
  return false;
}

// Build dynamic aliases by matching Kalshi market titles against ESPN team names.
// Called once per scan cycle after fetching Kalshi markets.
function buildDynamicAliases(cachedPrices, espnGames) {
  // Robust title-match helper: checks full displayName, shortDisplayName, and
  // every word ≥3 chars from the name. Kalshi titles usually use the short
  // city name ("Brighton") while ESPN displayName is verbose ("Brighton & Hove
  // Albion"). Last-word fallback returned "Albion" which isn't in the title —
  // that broke CHE@BHA learning after every restart.
  const titleHasName = (title, displayName, shortDisplayName) => {
    const s = (shortDisplayName ?? '').toLowerCase();
    const n = (displayName ?? '').toLowerCase();
    if (s && title.includes(s)) return true;
    if (n && title.includes(n)) return true;
    const words = n.split(/[\s&]+/).filter(w => w.length >= 3 && !['the','and','club','fc'].includes(w));
    return words.some(w => title.includes(w));
  };

  for (const game of espnGames) {
    const homeAbbr = (game.home?.team?.abbreviation ?? '').toUpperCase();
    const awayAbbr = (game.away?.team?.abbreviation ?? '').toUpperCase();
    const homeName = game.home?.team?.displayName ?? '';
    const awayName = game.away?.team?.displayName ?? '';
    const homeShort = game.home?.team?.shortDisplayName ?? '';
    const awayShort = game.away?.team?.shortDisplayName ?? '';
    if (!homeAbbr || !awayAbbr || (!homeName && !homeShort) || (!awayName && !awayShort)) continue;

    for (const [ticker] of cachedPrices) {
      const tu = ticker.toUpperCase();
      const alreadyMatchesBoth = tickerHasTeam(tu, homeAbbr) && tickerHasTeam(tu, awayAbbr);
      if (alreadyMatchesBoth) continue;

      const title = (cachedPrices.get(ticker)?.title ?? '').toLowerCase();
      if (!titleHasName(title, homeName, homeShort) || !titleHasName(title, awayName, awayShort)) continue;

      // Title matches both teams but ticker abbr doesn't — extract Kalshi's abbr from ticker
      const basePart = tu.split('-').slice(0, -1).join('-');
      const dateMatch = basePart.match(/\d{2}[A-Z]{3}\d{2}(\d{4})?/);
      if (!dateMatch) continue;
      const teamsStr = basePart.slice(dateMatch.index + dateMatch[0].length);
      if (!teamsStr) continue;

      // Try to figure out which ESPN abbr is missing from the ticker
      const missingHome = !tu.includes(homeAbbr) && !(ABBR_MAP[homeAbbr] && tu.includes(ABBR_MAP[homeAbbr]));
      const missingAway = !tu.includes(awayAbbr) && !(ABBR_MAP[awayAbbr] && tu.includes(ABBR_MAP[awayAbbr]));

      const addAlias = (espnAbbr, kalshiToken) => {
        if (!kalshiToken || kalshiToken.length < 2 || kalshiToken.length > 5) return;
        if (!dynamicAbbr.has(espnAbbr)) dynamicAbbr.set(espnAbbr, new Set());
        if (!dynamicAbbr.get(espnAbbr).has(kalshiToken)) {
          dynamicAbbr.get(espnAbbr).add(kalshiToken);
          console.log(`[abbr-learn] Discovered alias: ESPN "${espnAbbr}" = Kalshi "${kalshiToken}" (from ${ticker})`);
        }
      };

      if (missingHome && !missingAway) {
        // Home abbr is the one Kalshi uses differently — extract it
        const knownAway = ABBR_MAP[awayAbbr] && tu.includes(ABBR_MAP[awayAbbr]) ? ABBR_MAP[awayAbbr] : awayAbbr;
        addAlias(homeAbbr, teamsStr.replace(knownAway, ''));
      } else if (missingAway && !missingHome) {
        const knownHome = ABBR_MAP[homeAbbr] && tu.includes(ABBR_MAP[homeAbbr]) ? ABBR_MAP[homeAbbr] : homeAbbr;
        addAlias(awayAbbr, teamsStr.replace(knownHome, ''));
      } else if (missingHome && missingAway) {
        // Both sides unmapped (e.g. Mallorca-Valencia: ESPN MLL@VAL vs Kalshi MALVCF).
        // Title already confirmed both teams play here. Try each split of teamsStr
        // into two tokens and assign via first-letter match against team displayNames.
        // If both teams share a first letter, skip — ambiguous, wait for one-sided learn.
        const homeInitial = homeName[0]?.toUpperCase();
        const awayInitial = awayName[0]?.toUpperCase();
        if (homeInitial && awayInitial && homeInitial !== awayInitial) {
          for (let i = 2; i <= Math.min(5, teamsStr.length - 2); i++) {
            const tok1 = teamsStr.slice(0, i);
            const tok2 = teamsStr.slice(i);
            if (tok2.length < 2 || tok2.length > 5) continue;
            if (tok1[0] === homeInitial && tok2[0] === awayInitial) {
              addAlias(homeAbbr, tok1); addAlias(awayAbbr, tok2); break;
            }
            if (tok1[0] === awayInitial && tok2[0] === homeInitial) {
              addAlias(awayAbbr, tok1); addAlias(homeAbbr, tok2); break;
            }
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Win Expectancy Baselines — historical data for anchoring Claude's predictions
// ─────────────────────────────────────────────────────────────────────────────

// MLB: probability of leading team winning, by run lead and inning
// Source: Tom Tango (tangotiger.net/we.html), FanGraphs, 1903-2024 data
// Note: 3-run lead value differs by scoring environment (~4.3 R/G in 2020s)
// MLB: win probability for leading team, by run lead (1-8) and inning (1-9)
// Source: Fangraphs WE tables, Baseball Reference — neutral park, ~54% home baseline
const MLB_WIN_EXPECTANCY = {
  1: { 1: 0.56, 2: 0.58, 3: 0.60, 4: 0.64, 5: 0.67, 6: 0.71, 7: 0.77, 8: 0.84, 9: 0.91 },
  2: { 1: 0.64, 2: 0.67, 3: 0.70, 4: 0.76, 5: 0.79, 6: 0.83, 7: 0.88, 8: 0.93, 9: 0.96 },
  3: { 1: 0.72, 2: 0.75, 3: 0.78, 4: 0.85, 5: 0.87, 6: 0.90, 7: 0.93, 8: 0.96, 9: 0.98 },
  4: { 1: 0.79, 2: 0.82, 3: 0.85, 4: 0.90, 5: 0.92, 6: 0.94, 7: 0.96, 8: 0.98, 9: 0.99 },
  5: { 1: 0.85, 2: 0.87, 3: 0.90, 4: 0.93, 5: 0.95, 6: 0.97, 7: 0.98, 8: 0.99, 9: 0.99 },
  6: { 1: 0.89, 2: 0.91, 3: 0.93, 4: 0.95, 5: 0.96, 6: 0.97, 7: 0.98, 8: 0.99, 9: 0.99 },
  7: { 1: 0.93, 2: 0.94, 3: 0.95, 4: 0.96, 5: 0.97, 6: 0.98, 7: 0.99, 8: 0.99, 9: 0.99 },
  8: { 1: 0.95, 2: 0.96, 3: 0.97, 4: 0.97, 5: 0.98, 6: 0.99, 7: 0.99, 8: 0.99, 9: 0.99 },
};

// NBA: win probability for leading team, by point lead (1-25) and quarter (1-4)
// Source: Basketball Reference, inpredictable.com — MODERN era (2015+, 3-point era)
// Per-point granularity for Q4 (most critical — a 7-pt Q4 lead ≠ a 5-pt Q4 lead)
// Key: 3-pt era means comebacks easier than pre-2015 (15-pt comeback happens 13% now vs 6% pre-2002)
const NBA_WIN_EXPECTANCY = {
  1:  { 1: 0.53, 2: 0.54, 3: 0.56, 4: 0.56 },
  2:  { 1: 0.54, 2: 0.56, 3: 0.58, 4: 0.60 },
  3:  { 1: 0.55, 2: 0.57, 3: 0.61, 4: 0.64 },
  4:  { 1: 0.56, 2: 0.59, 3: 0.63, 4: 0.69 },
  5:  { 1: 0.57, 2: 0.60, 3: 0.65, 4: 0.74 },
  6:  { 1: 0.58, 2: 0.62, 3: 0.67, 4: 0.79 },
  7:  { 1: 0.59, 2: 0.64, 3: 0.70, 4: 0.83 },
  8:  { 1: 0.60, 2: 0.66, 3: 0.73, 4: 0.86 },
  9:  { 1: 0.61, 2: 0.67, 3: 0.75, 4: 0.89 },
  10: { 1: 0.63, 2: 0.69, 3: 0.77, 4: 0.91 },
  11: { 1: 0.64, 2: 0.71, 3: 0.79, 4: 0.92 },
  12: { 1: 0.66, 2: 0.73, 3: 0.81, 4: 0.93 },
  13: { 1: 0.67, 2: 0.75, 3: 0.83, 4: 0.94 },
  14: { 1: 0.69, 2: 0.76, 3: 0.84, 4: 0.95 },
  15: { 1: 0.70, 2: 0.78, 3: 0.85, 4: 0.95 },
  16: { 1: 0.72, 2: 0.80, 3: 0.87, 4: 0.96 },
  17: { 1: 0.73, 2: 0.81, 3: 0.88, 4: 0.97 },
  18: { 1: 0.75, 2: 0.83, 3: 0.89, 4: 0.97 },
  19: { 1: 0.76, 2: 0.84, 3: 0.90, 4: 0.97 },
  20: { 1: 0.78, 2: 0.85, 3: 0.91, 4: 0.98 },
  21: { 1: 0.79, 2: 0.86, 3: 0.92, 4: 0.98 },
  22: { 1: 0.81, 2: 0.87, 3: 0.93, 4: 0.98 },
  23: { 1: 0.82, 2: 0.88, 3: 0.94, 4: 0.99 },
  24: { 1: 0.83, 2: 0.89, 3: 0.94, 4: 0.99 },
  25: { 1: 0.85, 2: 0.90, 3: 0.95, 4: 0.99 },
};

// NHL: win probability for leading team, by goal lead (1-4) and period (1-3)
// Source: Hockey Graphs, MoneyPuck — scoring first jumps to 70% win prob
// Home ice: 59% overall
const NHL_WIN_EXPECTANCY = {
  1: { 1: 0.62, 2: 0.68, 3: 0.79 },
  2: { 1: 0.80, 2: 0.86, 3: 0.93 },
  3: { 1: 0.92, 2: 0.95, 3: 0.99 },
  4: { 1: 0.96, 2: 0.97, 3: 0.99 },
};

// Home advantage adjustments applied after table lookup
// Leading team that is also the home team gets a boost; away-team leaders get slight reduction
const HOME_ADJ = { mlb: 0.02, nba: 0.03, nhl: 0.02, mls: 0.02, epl: 0.02, laliga: 0.02, seriea: 0.02, bundesliga: 0.02, ligue1: 0.02 };
const AWAY_ADJ = { mlb: -0.01, nba: -0.01, nhl: -0.01, mls: -0.01, epl: -0.01, laliga: -0.01, seriea: -0.01, bundesliga: -0.01, ligue1: -0.01 };

function getWinExpectancy(league, lead, period, isHome = null) {
  let table, leadKey, periodKey;

  if (league === 'mlb') {
    table = MLB_WIN_EXPECTANCY;
    leadKey = Math.min(lead, 8);
    periodKey = Math.min(Math.max(period, 1), 9);
  } else if (['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league)) {
    // Soccer: goal lead by half (1=first half, 2=second half)
    // Source: brendansudol.github.io, EPL/MLS data
    table = { 1: { 1: 0.65, 2: 0.78 }, 2: { 1: 0.82, 2: 0.92 }, 3: { 1: 0.94, 2: 0.98 } };
    leadKey = Math.min(lead, 3);
    periodKey = Math.min(Math.max(period, 1), 2);
  } else if (league === 'nba') {
    table = NBA_WIN_EXPECTANCY;
    leadKey = Math.min(Math.max(lead, 1), 25); // exact per-point lookup, cap at 25
    periodKey = Math.min(Math.max(period, 1), 4);
  } else if (league === 'nhl') {
    table = NHL_WIN_EXPECTANCY;
    leadKey = Math.min(lead, 4);
    periodKey = Math.min(Math.max(period, 1), 3);
  } else {
    return null;
  }

  if (!table[leadKey] || !table[leadKey][periodKey]) return null;
  const base = table[leadKey][periodKey];

  // Apply home advantage if known — leading home team gets a boost, leading away team slight reduction
  if (isHome === true)  return Math.min(0.99, base + (HOME_ADJ[league] ?? 0.02));
  if (isHome === false) return Math.max(0.01, base + (AWAY_ADJ[league] ?? -0.01));
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time-within-period WE adjustment.
// Our WE tables use PERIOD as the finest grain. But within each period, WE
// varies substantially by how much time is left. A 5-point NBA lead at 11:35
// in Q4 is ~70%, not the table's period-average 77%. This function computes
// a linear adjustment so the prompt gives Sonnet the right anchor.
//
// Returns { adjustment: number, minutesLeft: number|null, label: string }
//   adjustment = additive WE correction (negative = table is optimistic)
//   minutesLeft = parsed clock for logging
//   label = human-readable time context for prompt
// ─────────────────────────────────────────────────────────────────────────────
function timeAdjustWE(league, period, gameDetail, diff = 1) {
  const none = { adjustment: 0, minutesLeft: null, label: '' };

  if (league === 'nba') {
    // Parse "11:35 - 4th" or "3:21 - 2nd" → minutes.fraction
    const m = (gameDetail ?? '').match(/(\d+):(\d+)/);
    if (!m) return none;
    const mins = parseInt(m[1]) + parseInt(m[2]) / 60;
    const periodLen = 12; // NBA quarter = 12 min
    const frac = mins / periodLen; // 0=period ending, 1=period starting

    let adj = 0;
    if (period === 4 || period > 4) {
      // Q4 / OT — time is critical
      if (frac > 0.50) adj = -0.05;       // >6 min left: table is optimistic
      else if (frac > 0.25) adj = -0.02;   // 3-6 min: slightly optimistic
      else if (frac < 0.15 && diff >= 5) adj = +0.04; // <2 min, 5+ pt lead: nearly sealed
    } else {
      // Q1-Q3: long game ahead, table is always optimistic early in period
      if (frac > 0.60) adj = -0.03;
    }
    const label = `${mins.toFixed(1)} min left in Q${period}`;
    return { adjustment: adj, minutesLeft: mins, label };
  }

  if (league === 'nhl') {
    const m = (gameDetail ?? '').match(/(\d+):(\d+)/);
    if (!m) return none;
    const mins = parseInt(m[1]) + parseInt(m[2]) / 60;
    const periodLen = 20;
    const frac = mins / periodLen;

    let adj = 0;
    if (period === 3) {
      if (frac > 0.50) adj = -0.04;       // >10 min: still a full period feel
      else if (frac > 0.25) adj = -0.01;   // 5-10 min
      else if (frac < 0.15 && diff >= 2) adj = +0.03; // <3 min, 2+ goal: locked
    } else {
      if (frac > 0.50) adj = -0.03;        // early in P1/P2
    }
    const label = `${mins.toFixed(1)} min left in P${period}`;
    return { adjustment: adj, minutesLeft: mins, label };
  }

  if (league === 'mlb') {
    // MLB has no clock — use inning half as proxy.
    // "Top 7th" = leading team batting (or about to), trailing hasn't hit yet this inning
    // "Bot 7th" = trailing team batting RIGHT NOW = max live risk
    // "Mid/End" = between half-innings = brief neutral state
    const detail = (gameDetail ?? '').toLowerCase();
    let adj = 0;
    let label = '';
    if (detail.startsWith('bot') || detail.startsWith('bottom')) {
      adj = -0.04; // trailing team at bat = active threat, table is optimistic
      label = 'trailing team batting — active scoring threat';
    } else if (detail.startsWith('top')) {
      adj = -0.01; // leading team at bat — less immediate risk but inning not over
      label = 'leading team batting';
    } else {
      label = 'between half-innings';
    }
    // Late-inning amplifier: bot 9th with 0-1 outs is more dangerous than bot 7th
    if (period >= 9 && diff <= 2 && (detail.startsWith('bot') || detail.startsWith('bottom'))) {
      adj -= 0.02; // extra penalty for trailing team batting in 9th with close game
      label = 'trailing team batting in 9th — maximum live risk';
    }
    return { adjustment: adj, minutesLeft: null, label };
  }

  if (['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league)) {
    // Parse minute from "72'" or "2nd - 72'" or just a number
    const minMatch = (gameDetail ?? '').match(/(\d+)/);
    if (!minMatch) return none;
    const minute = parseInt(minMatch[1]);
    const effective = period === 2 ? Math.max(minute, 45) : minute;

    let adj = 0;
    if (effective < 70) adj = -0.06;         // lots of match left
    else if (effective < 80) adj = -0.02;    // settling but not locked
    else if (effective >= 85) adj = +0.04;   // park-the-bus zone
    const label = `${effective}' of match`;
    return { adjustment: adj, minutesLeft: 90 - effective, label };
  }

  return none;
}

function getWinExpectancyText(league, lead, period, isHome) {
  const adjusted = getWinExpectancy(league, lead, period, isHome);
  if (!adjusted) return '';
  const trailing = Math.max(0.01, 1 - adjusted);
  const periodName = league === 'mlb' ? `inning ${period}` : league === 'nba' ? `Q${period}` : `period ${period}`;
  const unitName = league === 'nba' ? 'points' : league === 'mlb' ? 'runs' : 'goals';
  const isSoccer = ['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league);
  const drawWarning = isSoccer ? '\n⚠️ DRAW WARNING: Soccer draws ~25% of games. Your team must WIN outright — a draw means your contract LOSES.' : '';
  return `MATHEMATICAL WIN EXPECTANCY (WE) — YOUR ANCHOR\n` +
    `Leading team wins: ${(adjusted * 100).toFixed(0)}%  |  Trailing team wins: ${(trailing * 100).toFixed(0)}%\n` +
    `(Based on all historical games where a team led by ${lead} ${unitName} at ${periodName}${isHome ? ', home team leading' : ', away team leading'})\n` +
    `CONSTRAINT: Your final confidence must stay within 12 points of these numbers. Moving beyond that requires a specific confirmed fact from your research — not general team quality, narrative, or sentiment.${drawWarning}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live Predictions + Market Scanning
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Platform Market Mapper — find same game on both Kalshi + Polymarket
// ─────────────────────────────────────────────────────────────────────────────

let cachedPolyMoneylines = [];
let polyMoneylinesFetchedAt = 0;
const POLY_CACHE_MS = 3 * 60 * 1000; // refresh every 3 min

async function getPolyMoneylines() {
  if (Date.now() - polyMoneylinesFetchedAt < POLY_CACHE_MS && cachedPolyMoneylines.length > 0) {
    return cachedPolyMoneylines;
  }
  const markets = [];
  try {
    for (let offset = 0; offset < 1000; offset += 200) {
      const res = await fetch(`https://gateway.polymarket.us/v1/markets?limit=200&offset=${offset}&active=true&closed=false`, {
        headers: { 'User-Agent': 'arbor-ai/1', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) break;
      const data = await res.json();
      if (!data.markets?.length) break;
      for (const m of data.markets) {
        if (m.marketType !== 'moneyline' || m.closed || !m.active) continue;
        const sides = m.marketSides ?? [];
        if (sides.length < 2) continue;
        const s0 = parseFloat(String(sides[0]?.price ?? '0'));
        const s1 = parseFloat(String(sides[1]?.price ?? '0'));
        if (s0 < 0.05 || s1 < 0.05) continue;
        markets.push({
          slug: m.slug ?? '',
          title: m.question ?? '',
          s0Name: sides[0]?.team?.name ?? sides[0]?.description ?? '',
          s1Name: sides[1]?.team?.name ?? sides[1]?.description ?? '',
          s0Price: s0, s1Price: s1,
        });
      }
    }
  } catch (e) {
    console.error('[poly-mapper] fetch error:', e.message);
  }
  cachedPolyMoneylines = markets;
  polyMoneylinesFetchedAt = Date.now();
  return markets;
}

// Find the Poly market matching a Kalshi game (by team abbreviations + sport)
function findPolyMarketForGame(homeAbbr, awayAbbr, polyMarkets, sport = '') {
  const ha = homeAbbr.toLowerCase();
  const aa = awayAbbr.toLowerCase();
  // Map Kalshi series to Poly sport prefix to avoid cross-sport matches
  // (PIT Pirates MLB ≠ PIT Penguins NHL)
  const sportMap = { mlb: 'mlb', nba: 'nba', nhl: 'nhl', nfl: 'nfl' };
  const polyPrefix = sportMap[sport.toLowerCase()] ?? '';

  return polyMarkets.find(m => {
    const slug = m.slug.toLowerCase();
    // Must match sport prefix if we know it
    if (polyPrefix && !slug.includes('-' + polyPrefix + '-')) return false;
    return slug.includes(ha) && slug.includes(aa);
  }) ?? null;
}

// Compare prices and pick the best platform to buy on
// targetTeamAbbr: which team we want to buy (e.g. 'PIT')
function pickBestPlatform(side, kalshiPrice, polyMatch, targetTeamAbbr = '') {
  if (KALSHI_ONLY || !polyMatch) return { platform: 'kalshi', price: kalshiPrice };

  // Find which Poly side matches the team we want to buy
  const target = targetTeamAbbr.toLowerCase();
  const s0Name = (polyMatch.s0Name ?? '').toLowerCase();
  const s1Name = (polyMatch.s1Name ?? '').toLowerCase();
  const slugParts = (polyMatch.slug ?? '').toLowerCase().split('-');

  // Match by: team name contains abbreviation, or slug position matches
  let polyPrice = null;
  let polyIntent = '';

  // Check s0 (first team in slug = LONG)
  if (s0Name.includes(target) || (slugParts.length >= 4 && slugParts[2] === target)) {
    polyPrice = polyMatch.s0Price;
    polyIntent = 'ORDER_INTENT_BUY_LONG';
  }
  // Check s1 (second team in slug = SHORT)
  else if (s1Name.includes(target) || (slugParts.length >= 5 && slugParts[3] === target)) {
    polyPrice = polyMatch.s1Price;
    polyIntent = 'ORDER_INTENT_BUY_SHORT';
  }

  if (polyPrice !== null && polyPrice < kalshiPrice - 0.02 && polyPrice >= 0.05 && polyPrice < MAX_PRICE) {
    console.log(`[cross-platform] Poly cheaper: ${target} ${(polyPrice*100).toFixed(0)}¢ vs Kalshi ${(kalshiPrice*100).toFixed(0)}¢ (saving ${((kalshiPrice-polyPrice)*100).toFixed(0)}¢)`);
    return { platform: 'polymarket', price: polyPrice, slug: polyMatch.slug, intent: polyIntent };
  }
  return { platform: 'kalshi', price: kalshiPrice };
}

// ─────────────────────────────────────────────────────────────────────────────
// Thesis Status — detect in-game player changes that invalidate pre-game thesis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if the key player(s) the thesis was built on are still active.
 * Returns a non-empty alert string if the thesis has been invalidated/weakened,
 * or null if everything looks intact (or sport unsupported / data unavailable).
 *
 * @param {Object} trade  - the open pre-game trade (has trade.reasoning, trade.ticker)
 * @param {Object} game   - the liveGames entry (has game.league, game.ev.id, game.comp)
 * @returns {Promise<string|null>}
 */
async function getThesisStatus(trade, game) {
  const eventId = game.ev?.id;
  if (!eventId) return null;
  const league = game.league;

  try {
    // ── MLB: did the starter we bet on get pulled? ────────────────────────────
    if (league === 'mlb') {
      const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${eventId}`;
      const summaryRes = await fetch(summaryUrl, {
        headers: { 'User-Agent': 'arbor-ai/1' },
        signal: AbortSignal.timeout(5000),
      });
      if (!summaryRes.ok) return null;
      const summary = await summaryRes.json();

      // Build pitcher map from boxscore: athleteId → { name, ip, er, pitchCount }
      const pitcherStats = new Map();
      for (const teamPlayers of summary.boxscore?.players ?? []) {
        for (const statGroup of teamPlayers.statistics ?? []) {
          if (statGroup.name !== 'pitching') continue;
          for (const athlete of statGroup.athletes ?? []) {
            const name = athlete.athlete?.displayName ?? athlete.athlete?.shortName ?? '';
            const labels = statGroup.labels ?? [];
            const stats = athlete.stats ?? [];
            const getIdx = (lbl) => labels.indexOf(lbl);
            const ipIdx = getIdx('IP'); const erIdx = getIdx('ER'); const pcIdx = getIdx('PC');
            const ip = ipIdx >= 0 ? parseFloat(stats[ipIdx] ?? '0') : 0;
            const er = erIdx >= 0 ? parseInt(stats[erIdx] ?? '0', 10) : 0;
            const pc = pcIdx >= 0 ? parseInt(stats[pcIdx] ?? '0', 10) : 0;
            if (name) pitcherStats.set(athlete.athlete?.id, { name, ip, er, pc });
          }
        }
      }

      // Current pitcher: scan the most recent play participant with type 'pitcher'
      let currentPitcherId = null;
      const plays = summary.plays ?? [];
      for (let i = plays.length - 1; i >= 0; i--) {
        const pitcher = (plays[i].participants ?? []).find(p => p.type === 'pitcher');
        if (pitcher?.athlete?.id) { currentPitcherId = pitcher.athlete.id; break; }
      }

      if (!currentPitcherId || !pitcherStats.size) return null;

      // Find whether the bet is on the home or away team
      const isHome = tickerHasTeam(trade.ticker, game.home.team?.abbreviation ?? '');

      // Get the starting pitcher for our team (first pitcher in boxscore = starter)
      let ourStarterId = null;
      let ourStarterName = null;
      for (const teamPlayers of summary.boxscore?.players ?? []) {
        const teamAbbr = (teamPlayers.team?.abbreviation ?? '').toUpperCase();
        if (
          (isHome && teamAbbr === (game.home.team?.abbreviation ?? '').toUpperCase()) ||
          (!isHome && teamAbbr === (game.away.team?.abbreviation ?? '').toUpperCase())
        ) {
          for (const statGroup of teamPlayers.statistics ?? []) {
            if (statGroup.name !== 'pitching') continue;
            const firstAthlete = statGroup.athletes?.[0];
            if (firstAthlete?.athlete?.id) {
              ourStarterId = firstAthlete.athlete.id;
              ourStarterName = firstAthlete.athlete?.displayName ?? firstAthlete.athlete?.shortName ?? 'Starter';
            }
            break;
          }
          break;
        }
      }

      if (!ourStarterId) return null;

      const starterStats = pitcherStats.get(ourStarterId);
      const currentStats = pitcherStats.get(currentPitcherId);
      const currentName = currentStats?.name ?? 'unknown';

      // Check if starter was pulled (current pitcher ≠ starter)
      if (currentPitcherId !== ourStarterId && starterStats) {
        const ip = starterStats.ip;
        const er = starterStats.er;
        const earlyExit = ip < 5;
        if (earlyExit) {
          return `⚠️ THESIS ALERT: ${ourStarterName} (the pitcher we bet on) was PULLED after ${ip} IP / ${er} ER. Current pitcher: ${currentName}. Early exit invalidates the starter-ERA thesis.`;
        } else {
          return `ℹ️ THESIS NOTE: ${ourStarterName} finished ${ip} IP / ${er} ER and was relieved by ${currentName}. Game now in bullpen.`;
        }
      }

      // Starter still in — report status as context
      if (starterStats) {
        return `✅ THESIS INTACT: ${ourStarterName} still pitching (${starterStats.ip} IP, ${starterStats.er} ER, ${starterStats.pc} pitches).`;
      }
      return null;
    }

    // ── NHL: did the goalie we bet on get pulled? ─────────────────────────────
    if (league === 'nhl') {
      // probables[] is already in game.comp (scoreboard data fetched each cycle)
      const isHome = tickerHasTeam(trade.ticker, game.home.team?.abbreviation ?? '');
      const ourTeamComp = isHome ? game.home : game.away;
      const currentProbs = ourTeamComp.probables ?? [];
      if (!currentProbs.length) return null;

      const currentGoalie = currentProbs[0]?.athlete?.displayName
        ?? currentProbs[0]?.athlete?.shortName ?? '';
      if (!currentGoalie) return null;

      // Try to find the goalie name mentioned in the reasoning
      const reasoning = trade.reasoning ?? '';
      // Extract words that look like a goalie name (capitalized words near "goalie", "starter", ".sv%", etc.)
      const goaliePatterns = [
        /starter[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/i,
        /goalie[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/i,
        /([A-Z][a-z]+ [A-Z][a-z]+)\s+(?:starting|in goal|\.sv%|save%|SV%)/i,
        /(?:bet(?:ting)? on|backing|thesis)[^.]*?([A-Z][a-z]+ [A-Z][a-z]+)/i,
      ];

      let thesisGoalie = null;
      for (const pat of goaliePatterns) {
        const m = reasoning.match(pat);
        if (m?.[1]) { thesisGoalie = m[1]; break; }
      }

      if (thesisGoalie) {
        const sameGoalie = currentGoalie.toLowerCase().includes(thesisGoalie.split(' ').pop()?.toLowerCase() ?? '');
        if (!sameGoalie) {
          return `⚠️ THESIS ALERT: Goalie change! We bet based on ${thesisGoalie} but current active goalie is ${currentGoalie}. Goalie-based thesis is INVALIDATED.`;
        }
        return `✅ THESIS INTACT: ${currentGoalie} still in net (matches thesis goalie ${thesisGoalie}).`;
      }

      // No specific goalie mentioned — just report current goalie for context
      return `ℹ️ Current goalie: ${currentGoalie}.`;
    }

    // ── MLS/Soccer: has a key forward been subbed out before 60'? ─────────────
    if (['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league)) {
      const soccerPathMap = { mls: 'soccer/usa.1', epl: 'soccer/eng.1', laliga: 'soccer/esp.1', seriea: 'soccer/ita.1', bundesliga: 'soccer/ger.1', ligue1: 'soccer/fra.1' };
      const sportPath = soccerPathMap[league] ?? 'soccer/usa.1';
      const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/summary?event=${eventId}`;
      const summaryRes = await fetch(summaryUrl, {
        headers: { 'User-Agent': 'arbor-ai/1' },
        signal: AbortSignal.timeout(5000),
      });
      if (!summaryRes.ok) return null;
      const summary = await summaryRes.json();

      const isHome = tickerHasTeam(trade.ticker, game.home.team?.abbreviation ?? '');
      const reasoning = trade.reasoning ?? '';

      const earlySubAlerts = [];
      for (const rosterTeam of summary.rosters ?? []) {
        const teamAbbr = (rosterTeam.team?.abbreviation ?? '').toUpperCase();
        if (
          (isHome && teamAbbr !== (game.home.team?.abbreviation ?? '').toUpperCase()) ||
          (!isHome && teamAbbr !== (game.away.team?.abbreviation ?? '').toUpperCase())
        ) continue;

        for (const player of rosterTeam.roster ?? []) {
          if (!player.starter) continue;
          const subbedOut = player.subbedOut ?? false;
          const subbedOutAt = player.subbedOutAt ?? null;
          const pos = (player.position?.abbreviation ?? '').toUpperCase();
          const isAttacker = ['CF', 'LW', 'RW', 'SS', 'FW', 'ST', 'AM', 'CF-R', 'CF-L', 'LWF', 'RWF'].some(p => pos.includes(p));
          if (!subbedOut) continue;
          if (subbedOutAt != null && subbedOutAt <= 60) {
            const name = player.athlete?.displayName ?? player.athlete?.shortName ?? 'Unknown';
            const mentionedInThesis = reasoning.toLowerCase().includes((player.athlete?.lastName ?? name.split(' ').pop() ?? '').toLowerCase());
            if (isAttacker || mentionedInThesis) {
              earlySubAlerts.push(`${name} (${pos}) subbed out at ${subbedOutAt}'`);
            }
          }
        }
      }

      if (earlySubAlerts.length > 0) {
        return `⚠️ THESIS ALERT: Key attacker(s) subbed out early: ${earlySubAlerts.join(', ')}. Offensive thesis may be weakened.`;
      }

      // Get current minute for context
      const clockMin = parseInt(game.comp?.status?.displayClock?.split(':')[0] ?? '0', 10);
      return clockMin >= 60
        ? `ℹ️ Soccer: no key attackers subbed early. Now in ${clockMin}' — game approaching final phase.`
        : null;
    }

  } catch (e) {
    // Non-fatal — thesis check is best-effort
    console.log(`[thesis-status] ${game.league} fetch failed: ${e.message}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live Predictions — predict winners during live games
// ─────────────────────────────────────────────────────────────────────────────

async function checkLiveScoreEdges() {
  const sports = [
    { league: 'mlb', path: 'baseball/mlb', series: 'KXMLBGAME' },
    { league: 'nba', path: 'basketball/nba', series: 'KXNBAGAME' },
    { league: 'nhl', path: 'hockey/nhl', series: 'KXNHLGAME' },
    { league: 'mls', path: 'soccer/usa.1', series: 'KXMLSGAME' },
    { league: 'epl', path: 'soccer/eng.1', series: 'KXEPLGAME' },
    { league: 'laliga', path: 'soccer/esp.1', series: 'KXLALIGAGAME' },
    { league: 'seriea', path: 'soccer/ita.1', series: 'KXSERIAA' },
    { league: 'bundesliga', path: 'soccer/ger.1', series: 'KXBUNDESLIGA' },
    { league: 'ligue1', path: 'soccer/fra.1', series: 'KXLIGUE1' },
  ];

  // === PHASE 1: Collect all games with leads (parallel ESPN fetch) ===
  const liveGames = [];
  const espnResults = await Promise.allSettled(
    sports.map(({ league, path }) =>
      fetch(`http://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`,
        { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : null)
        .then(data => ({ league, data }))
        .catch(() => null)
    )
  );
  for (const result of espnResults) {
    if (result.status !== 'fulfilled' || !result.value?.data) continue;
    const { league, data } = result.value;
    for (const ev of data.events ?? []) {
      const comp = ev.competitions?.[0];
      if (!comp || comp.status?.type?.state !== 'in') continue;
      const period = parseInt(comp.status?.period ?? '0');
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      const homeScore = parseInt(home.score ?? '0');
      const awayScore = parseInt(away.score ?? '0');
      const diff = Math.abs(homeScore - awayScore);
      const isSoccer = ['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league);
      // Skip tied games UNLESS it's soccer (draw is a valid bet)
      if (diff === 0 && !isSoccer) continue;
      // Soccer winner live-edge is gated below by a draw-adjusted candidate filter
      // (require 2+ goal lead, or late 1-goal lead in 2nd half). Tied soccer games
      // still fall through to the draw-bet strategy.
      const leading = diff > 0 ? (homeScore > awayScore ? home : away) : home; // tied = home as placeholder
      const detail = comp.status?.type?.shortDetail ?? '';
      liveGames.push({ league, comp, ev, home, away, homeScore, awayScore, diff, period, leading, detail, isSoccer });
    }
  }

  // Update active-live-games set so pre-game scanner skips in-progress matchups.
  // IMPORTANT: must be built from ALL in-progress ESPN games — including tied games that
  // live-edge skips for betting (diff===0 above). A tied game is still LIVE and the
  // pre-game scanner must not place a "pre-game" bet on it.
  activeLiveGames.clear();
  for (const result of espnResults) {
    if (result.status !== 'fulfilled' || !result.value?.data) continue;
    for (const ev of result.value.data.events ?? []) {
      const comp = ev.competitions?.[0];
      if (!comp || comp.status?.type?.state !== 'in') continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const ha = (home?.team?.abbreviation ?? '').toUpperCase();
      const aa = (away?.team?.abbreviation ?? '').toUpperCase();
      if (ha && aa) activeLiveGames.add([ha, aa].sort().join('|'));
    }
  }

  // === PRE-GAME POSITION GUARDIAN ===
  // Check every 60s (not every 5min like managePositions) if any pre-game bets are going wrong.
  // Pre-game bets were placed BEFORE the game started — any adverse score change is NEW info
  // that wasn't in the original thesis and should be evaluated immediately.
  //
  // Why this matters: managePositions runs every 5 min with a -25% threshold.
  // A pre-game NHL bet at 65¢ can drop to 40¢ (-38%) in 3 minutes if the other team
  // scores twice. By the time the 5-min loop catches it, we've lost an extra $10+.
  // This guardian catches it within 60 seconds.
  if (liveGames.length > 0) {
    try {
      const pgLines = existsSync(TRADES_LOG)
        ? readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim())
        : [];
      const pgTrades = pgLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const preGameOpen = pgTrades.filter(t =>
        t.status === 'open' &&
        t.exchange === 'kalshi' &&
        (t.strategy === 'pre-game-prediction' || t.strategy === 'pre-game-edge-first')
      );

      for (const trade of preGameOpen) {
        const ticker = trade.ticker ?? '';
        const teamSuffix = ticker.split('-').pop()?.toUpperCase() ?? '';
        if (!teamSuffix) continue;

        // Find this game in the ESPN data we already fetched
        const game = liveGames.find(g => {
          const ha = g.home.team?.abbreviation ?? '';
          const aa = g.away.team?.abbreviation ?? '';
          return tickerHasTeam(ticker, ha) && tickerHasTeam(ticker, aa);
        });
        if (!game) continue; // game not in progress yet or not found

        // Determine: is our team losing?
        const ourTeam = teamSuffix;
        const homeAbbr = game.home.team?.abbreviation ?? '';
        const awayAbbr = game.away.team?.abbreviation ?? '';
        const isOurTeamHome = tickerHasTeam(ourTeam, homeAbbr);
        const ourScore = isOurTeamHome ? game.homeScore : game.awayScore;
        const theirScore = isOurTeamHome ? game.awayScore : game.homeScore;
        const deficit = theirScore - ourScore;

        // ── WINNING BRANCH: dynamic WE-triggered profit sell ──────────────────────
        // When our pre-game team is LEADING, sell into price strength based on
        // game stage + WE. The thesis: we bought pre-game at a discount; once the
        // price reflects reality, lock gains rather than gambling on the full win.
        if (deficit < 0) { // our team is WINNING (deficit negative = we're ahead)
          const lead = Math.abs(deficit);
          const league = game.league;
          const stage = league === 'mlb' ? (game.period <= 4 ? 'early' : game.period <= 6 ? 'mid' : 'late')
            : league === 'nba' ? (game.period <= 2 ? 'early' : game.period === 3 ? 'mid' : 'late')
            : league === 'nhl' ? (game.period === 1 ? 'early' : game.period === 2 ? 'mid' : 'late')
            : game.period === 1 ? 'early' : 'late';
          // Only act when WE crosses meaningful thresholds AND we've gained at least 8¢
          const pgWinKey = 'pg-win:' + trade.ticker;
          const winCooldown = tradeCooldowns.get(pgWinKey) ?? 0;
          if (Date.now() - winCooldown < 5 * 60 * 1000) { /* skip — checked recently */ }
          else {
            let currentPricePg = 0;
            try {
              const mktPg = await kalshiGet(`/markets/${trade.ticker}`);
              currentPricePg = parseFloat((mktPg.market ?? mktPg).yes_ask_dollars ?? '0');
            } catch {}

            if (currentPricePg > 0) {
              const entryPg = trade.entryPrice ?? 0;
              const gainCents = currentPricePg - entryPg;
              const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / entryPg);

              // ── Winning exits — two rules only ───────────────────────────────────
              // The +12¢ price-target exit is handled by managePositions every cycle.
              // pg-guard winning branch covers two cases managePositions can't catch cleanly:
              //   1. WINDFALL: price up 30¢+ — lock immediately, don't wait for next cycle
              //   2. LATE GAME: game is closing out with us winning — sell before it can flip
              let sellFraction = 0;
              let sellReason = '';

              if (gainCents >= 0.30) {
                sellFraction = 1.0;
                sellReason = `pg-profit-windfall (+${Math.round(gainCents*100)}¢ — locking windfall)`;
              } else if (stage === 'late' && lead >= 1) {
                // Late game with any lead: the price target may never have hit +12¢ cleanly
                // (e.g. bought at 44¢, team leads 1-0 in 7th, market is at 74¢ = +30¢ windfall,
                // or leads 1-0 in 7th with market only at 54¢ = +10¢, game ending soon).
                // Sell to capture the late-game premium before a blown save wipes the gain.
                sellFraction = 1.0;
                sellReason = `pg-profit-late (${lead}-${lead === 0 ? 'tie' : 'run/goal/pt'} lead ${stage} game inn/pd ${game.period} — closing out)`;
              } else if (league === 'mlb' && gainCents >= 0.18 && game.period >= 5 && lead >= 1 && await (async () => {
                // MLB BULLPEN-LOCK: if leading team's bullpen is below/poor/unknown AND we're
                // already +18¢ in inn 5+, auto-lock without asking Claude. KC-Lugo incident:
                // Claude said HOLD at +18¢, bullpen gave up 4 runs in extras, BAL won. The
                // windfall rule saved us at +31¢ — won't always bail us out.
                try {
                  const leadStats = await getBullpenStats(ourTeam);
                  const tier = leadStats ? bullpenTier(leadStats) : 'unknown';
                  if (tier === 'below' || tier === 'poor' || tier === 'unknown') {
                    console.log(`[pg-win] 🔒 BULLPEN-LOCK: ${trade.ticker} +${Math.round(gainCents*100)}¢ ${stage} inn${game.period} — ${ourTeam} bullpen tier=${tier}, auto-lock`);
                    return true;
                  }
                } catch (e) { console.log(`[pg-win] bullpen lookup failed for ${ourTeam}: ${e.message}`); }
                return false;
              })()) {
                sellFraction = 1.0;
                sellReason = `pg-bullpen-lock (+${Math.round(gainCents*100)}¢ — shaky bullpen in inn${game.period}, don't risk it)`;
              } else if (gainCents >= 0.10 && (stage === 'mid' || stage === 'early') && lead >= 1 && !trade.pgWinThesisChecked) {
                // MILESTONE RE-EVALUATION: position profitable + leading + not yet milestone-evaluated.
                // Ask Claude: thesis confirmed? Hold to settlement for maximum gain, or lock profits now?
                tradeCooldowns.set(pgWinKey, Date.now());
                trade.pgWinThesisChecked = true;
                const pgWinThesisLeague = league;
                const pgWinThesisSport = pgWinThesisLeague === 'nhl' ? 'NHL' : pgWinThesisLeague === 'nba' ? 'NBA' : pgWinThesisLeague === 'mlb' ? 'MLB' : 'Soccer';
                const pgWinPrompt =
                  `You manage a pre-game ${pgWinThesisSport} bet that is currently WINNING. Decide: HOLD to settlement for maximum gain, or LOCK profits now at the profit target.\n\n` +
                  `POSITION: Bought ${ourTeam} YES at ${(entryPg*100).toFixed(0)}¢. Current price: ${Math.round(currentPricePg*100)}¢ (+${Math.round(gainCents*100)}¢, +${Math.round((gainCents/entryPg)*100)}%).\n` +
                  `Live score: ${awayAbbr} ${game.awayScore} @ ${homeAbbr} ${game.homeScore} | ${game.detail} | Stage: ${stage.toUpperCase()}\n` +
                  `Our team (${ourTeam}) is LEADING by ${lead}.\n\n` +
                  `ORIGINAL THESIS: "${trade.reasoning}"\n\n` +
                  `QUESTION: Is the original edge (starter quality, matchup, lineup advantage) still actively in play given the current game state? ` +
                  `If the thesis is confirmed and the team looks dominant, HOLD for settlement (full win value). ` +
                  `If the lead is fragile or the thesis is expiring, LOCK profits now.\n\n` +
                  `Profit if locked now: +$${(gainCents * qty).toFixed(2)}. Profit if held to settlement win: +$${((1 - entryPg) * qty).toFixed(2)}.\n\n` +
                  `JSON ONLY: {"action": "hold"/"lock", "reasoning": "one sentence"}`;
                try {
                  const pgWinText = await claudeSonnet(pgWinPrompt, { maxTokens: 300, timeout: 15000, category: 'pg-win' });
                  if (pgWinText) {
                    const pgWinJson = extractJSON(pgWinText);
                    if (pgWinJson) {
                      const pgWinD = JSON.parse(pgWinJson);
                      console.log(`[pg-win] 🧠 MILESTONE CHECK ${pgWinD.action?.toUpperCase()}: ${trade.ticker} +${Math.round(gainCents*100)}¢ ${stage} | ${pgWinD.reasoning?.slice(0, 80)}`);
                      if (pgWinD.action === 'hold') {
                        // Mark trade so managePositions skips the +12¢ profit-lock
                        trade.pgHoldToSettlement = true;
                        const holdLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
                        const holdTrades = holdLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                        const holdT = holdTrades.find(t => t.id === trade.id);
                        if (holdT) {
                          holdT.pgHoldToSettlement = true;
                          holdT.pgWinThesisChecked = true;
                          writeFileSync(TRADES_LOG, holdTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
                        }
                        await tg(`🏆 <b>PRE-GAME: RIDING TO SETTLEMENT</b>\n${trade.title ?? trade.ticker}\n+${Math.round(gainCents*100)}¢ in ${stage} — thesis confirmed, skipping profit-lock target\n${pgWinD.reasoning ?? ''}`);
                      }
                      // if 'lock': do nothing — managePositions handles the +12¢ exit normally
                    }
                  }
                } catch { /* skip milestone check on error */ }
              }

              if (sellFraction > 0 && !trade.partialTakeAt) {
                const sellQty = Math.max(1, Math.floor(qty * sellFraction));
                const remaining = qty - sellQty;
                if (sellQty >= 1) {
                  tradeCooldowns.set(pgWinKey, Date.now());
                  // Persist partialTakeAt to JSONL immediately so it survives restarts
                  // and managePositions won't double-sell (it checks !trade.partialTakeAt)
                  trade.partialTakeAt = new Date().toISOString();
                  trade._pgFirstSellFraction = sellFraction;
                  const freshPgLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
                  const freshPgTrades = freshPgLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                  const freshPgTrade = freshPgTrades.find(t => t.id === trade.id);
                  if (freshPgTrade) {
                    freshPgTrade.partialTakeAt = trade.partialTakeAt;
                    freshPgTrade._pgFirstSellFraction = sellFraction;
                    writeFileSync(TRADES_LOG, freshPgTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
                  }
                  console.log(`[pg-profit] ${trade.ticker} ATTEMPTING SELL ${sellQty}/${qty} contracts @ ${Math.round(currentPricePg*100)}¢ | ${sellReason} | gain=$${(gainCents*sellQty).toFixed(2)}`);
                  const _pgProfitResult = await executeSell(trade, sellQty, currentPricePg, sellReason);
                  if (_pgProfitResult) {
                    await tg(
                      `📈 <b>PRE-GAME PROFIT TAKE</b>\n\n` +
                      `📋 <b>POSITION</b>\n` +
                      `${trade.title ?? trade.ticker}\n\n` +
                      `📊 <b>METRICS</b>\n` +
                      `Sold ${sellQty}/${qty} contracts @ ${Math.round(currentPricePg*100)}¢\n` +
                      `Entry: ${Math.round(entryPg*100)}¢ → Now: ${Math.round(currentPricePg*100)}¢ (+${Math.round(gainCents*100)}¢)\n` +
                      `Profit this sale: <b>+$${(gainCents*sellQty).toFixed(2)}</b>\n` +
                      `${qty - sellQty > 0 ? `Holding ${qty - sellQty} contracts remaining` : 'Full position closed'}\n\n` +
                      `💬 <b>REASON</b>\n` +
                      sellReason
                    );
                  }
                  if (remaining >= 1) {
                    console.log(`[pg-profit] ${remaining} contracts remain — riding to ${stage === 'early' ? 'mid-game' : 'settlement'}`);
                  }
                }
              }
            }
          }
          continue; // winning branch handled — don't fall through to loss logic
        }

        // ── THESIS EXPIRY: MLB still tied after inning 4 ─────────────────────────
        // We bet on early scoring. 0-0 through 4+ innings means the early-scoring
        // thesis never played out — exit at current price rather than holding to settlement.
        if (deficit === 0 && game.league === 'mlb' && game.period >= 5 && !trade.thesisExpiredAt) {
          let expirePrice = 0;
          try {
            const expMkt = await kalshiGet(`/markets/${trade.ticker}`);
            expirePrice = parseFloat((expMkt.market ?? expMkt).yes_ask_dollars ?? '0');
          } catch {}
          if (expirePrice > 0) {
            const expQty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (trade.entryPrice ?? 1));
            trade.thesisExpiredAt = new Date().toISOString();
            const expLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
            const expTrades = expLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            const expT = expTrades.find(t => t.id === trade.id);
            if (expT) {
              expT.thesisExpiredAt = trade.thesisExpiredAt;
              writeFileSync(TRADES_LOG, expTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
            }
            const expGain = expirePrice - (trade.entryPrice ?? 0);
            console.log(`[pg-expire] ${trade.ticker} stalled — 0-0 at inn ${game.period}, attempting exit @ ${Math.round(expirePrice*100)}¢ (${expGain >= 0 ? '+' : ''}${Math.round(expGain*100)}¢)`);
            const _expResult = await executeSell(trade, expQty, expirePrice, 'pg-thesis-expired-0-0-mlb');
            if (_expResult) {
              await tg(
                `⏰ <b>PRE-GAME STALLED EXIT</b>\n\n` +
                `${trade.title ?? trade.ticker}\n` +
                `Still 0-0 at inning ${game.period} — price hasn't moved, cutting to preserve capital.\n\n` +
                `Exited @ ${Math.round(expirePrice*100)}¢ | Entry: ${Math.round((trade.entryPrice ?? 0)*100)}¢ | P&L: ${expGain >= 0 ? '+' : ''}$${(expGain * expQty).toFixed(2)}`
              );
            }
          }
          continue;
        }

        // Only evaluate if our team is LOSING (deficit > 0)
        if (deficit <= 0) continue;

        // Determine sport + game context — needed for stage-aware thresholds and thesis check
        const league = game.league;
        const sport = league === 'nhl' ? 'NHL' : league === 'nba' ? 'NBA' : league === 'mlb' ? 'MLB' :
          ['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league) ? 'Soccer' : 'Sport';
        const stage = league === 'mlb' ? (game.period <= 4 ? 'early' : game.period <= 6 ? 'mid' : 'late') :
          league === 'nba' ? (game.period <= 2 ? 'early' : game.period === 3 ? 'mid' : 'late') :
          league === 'nhl' ? (game.period === 1 ? 'early' : game.period === 2 ? 'mid' : 'late') :
          game.period === 1 ? 'early' : 'late';

        const we = getWinExpectancy(league, deficit, game.period, !isOurTeamHome) ?? 0;
        const ourWE = 1 - we; // we're the trailing team

        // Thesis monitoring runs BEFORE the cooldown — a starter pull or goalie change is
        // an urgent thesis-killer that must not be gated behind a 20-minute window.
        const thesisAlert = await getThesisStatus(trade, game);
        const thesisIsKiller = thesisAlert?.startsWith('⚠️ THESIS ALERT');
        if (thesisAlert) {
          console.log(`[pg-guard] [thesis] ${ticker}: ${thesisAlert}`);
        }

        // Cooldown: don't cascade-sell by re-evaluating too quickly. 20 min prevents sell_half spam.
        // Thesis-killers bypass this — a starter being pulled mid-game can't wait 20 minutes.
        const pgGuardKey = 'pg-guard:' + trade.ticker;
        if (!thesisIsKiller && Date.now() - (tradeCooldowns.get(pgGuardKey) ?? 0) < 20 * 60 * 1000) continue;
        tradeCooldowns.set(pgGuardKey, Date.now());

        // Fetch current market price (batch prices aren't loaded yet — individual fetch)
        let currentPrice = 0;
        try {
          const mktData = await kalshiGet(`/markets/${ticker}`);
          const mkt = mktData.market ?? mktData;
          currentPrice = parseFloat(mkt.yes_ask_dollars ?? '0');
        } catch { continue; }
        if (currentPrice <= 0) continue;

        const entryPrice = trade.entryPrice ?? 0;
        const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / entryPrice);
        const pctChange = (currentPrice - entryPrice) / entryPrice;

        // Stage-aware price threshold — early games have high variance, don't panic-sell on normal scoring.
        //   early MLB (inn 1-4): require -50% (was -35%)
        //   early other (NHL P1 / NBA Q1): require -45% (was -25%)
        //   mid   (MLB inn 5-7 / NHL P2 / NBA Q2-Q3): require -45% (was -15%)
        //   late  (MLB inn 8+ / NHL P3 / NBA Q4): require -45% (was -10%)
        // 2026-04-29 widening: stop-loss audit found 17/47 stops would have won if held.
        // Half-Kelly entry already caps blast radius — let the thesis play out unless
        // it's truly broken. Only thesis-killers (starter pulled, goalie change) bypass.
        const PG_CLAUDE_THRESHOLD = (stage === 'early' && league === 'mlb') ? -0.50
          : stage === 'early' ? -0.45
          : stage === 'mid' ? -0.45
          : -0.45;

        // WE-based trigger — also fire when game situation has deteriorated significantly
        // even if price hasn't moved enough. Markets can lag WE shifts by 1-2 cycles.
        //   Mid game + WE ≤ 40%: 25pt WE drop from a typical 65%-conf thesis is meaningful,
        //     but 45% was too aggressive — a 1-run deficit in inning 5 easily hits 44% WE.
        //     We want Claude to evaluate real deterioration, not normal early variance.
        //   Late game + WE ≤ 50%: trailing at all in late game = urgent
        // PLAYOFF ADJUSTMENT: Playoff teams fight back harder — VGK was at 22% WE in P3 and won.
        //   Lower thresholds so we don't trigger too early in close playoff games.
        const isPlayoffPG = /Game \d/i.test(trade.title ?? '');
        const weTrigger = (stage === 'late' && ourWE <= (isPlayoffPG ? 0.35 : 0.50))
                       || (stage === 'mid' && ourWE <= (isPlayoffPG ? 0.28 : 0.40));

        // Bypass price threshold if thesis has been invalidated (e.g. starter pulled, goalie changed)
        if (pctChange >= PG_CLAUDE_THRESHOLD && !weTrigger && !thesisIsKiller) {
          if (pctChange < 0) {
            console.log(`[pg-guard] ${ticker} trailing ${ourScore}-${theirScore} (${game.detail}) | ${stage} threshold=${Math.round(PG_CLAUDE_THRESHOLD*100)}% WE=${(ourWE*100).toFixed(0)}% | price ${(entryPrice*100).toFixed(0)}¢→${(currentPrice*100).toFixed(0)}¢ (${(pctChange*100).toFixed(0)}%), watching...`);
          }
          continue;
        }

        // SMALL-DEFICIT PATIENCE GATE — pro bettors don't sell on normal game variance.
        // A 1-goal NHL deficit in P1-P2, a ≤10pt NBA deficit in Q1-Q3, a ≤2-run MLB deficit
        // before the 7th, or a 1-goal soccer deficit before the 75th minute is just the game
        // playing out. The thesis hasn't been invalidated — hold everything.
        // Only thesis-killers (goalie pulled, starter yanked) bypass this gate.
        //
        // PLAYOFF WIDENING: Playoff teams are elite and fight harder. Coaching adjustments
        // between periods, deeper rotations, and desperation create more comebacks.
        // DATA: BUF@BOS Game 1 — bot sold a 2-goal P2 deficit, BUF came back to win 4-2.
        //   NHL playoff: 2-goal (from 1) in P1-P2 | NBA playoff: 15pt (from 10) in Q1-Q3
        //   MLB playoff: 3-run (from 2) in innings 1-6 | Soccer knockout: 1-goal until 80'
        if (!thesisIsKiller) {
          const isSoccer = ['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league);
          const isPlayoffGame = isPlayoffPG; // already computed above
          const isSmallDeficit = (
            (league === 'nhl' && deficit <= (isPlayoffGame ? 2 : 1) && stage !== 'late') ||
            (league === 'nba' && deficit <= (isPlayoffGame ? 15 : 10) && stage !== 'late') ||
            (league === 'mlb' && deficit <= (isPlayoffGame ? 3 : 2) && stage !== 'late') ||
            (isSoccer && deficit <= 1 && (game.period ?? 0) < (isPlayoffGame ? 80 : 75))
          );
          if (isSmallDeficit) {
            console.log(`[pg-guard] 🧘 PATIENCE: ${ticker} trailing by ${deficit} (${league.toUpperCase()} ${stage}${isPlayoffGame ? ' PLAYOFF' : ''}) — small deficit, thesis intact, auto-HOLD`);
            continue;
          }
        }

        const triggerReason = thesisIsKiller
          ? `thesis-killer (${thesisAlert?.slice(0, 80)})`
          : weTrigger
          ? `WE-trigger (WE=${(ourWE*100).toFixed(0)}%, stage=${stage})`
          : `price-trigger (${(pctChange*100).toFixed(0)}%, threshold=${Math.round(PG_CLAUDE_THRESHOLD*100)}%)`;

        const comebackContext = {
          NHL: 'NHL: 1-goal comebacks happen 30%. 2-goal comebacks ~15%. 3-goal comebacks ~5%. Down 3+ in the 3rd = essentially over.',
          NBA: 'NBA: 15-point comebacks happen 13% in the 3-point era. 20-point comebacks happen 4%. 25+ is essentially over (<1%).',
          MLB: 'MLB: 3-run comebacks happen 20% through 6 innings, 10% in the 7th+. 5+ run deficit after 6th inning = <3% comeback.',
          Soccer: 'Soccer: 1-goal deficits equalize ~20% of the time. 2-goal deficit comeback is ~5%. Down 2+ after 75th minute = essentially over.',
          Sport: 'Comebacks get less likely as the deficit grows and time runs out.',
        }[sport] ?? '';

        const profitPerContract = currentPrice - entryPrice;
        const lossAmt = Math.abs(qty * profitPerContract);
        const halfSellQty = Math.max(1, Math.floor(qty * 0.5));

        console.log(`[pg-guard] ⚠️ PRE-GAME BET LOSING: ${trade.title} | ${ourTeam} trailing ${ourScore}-${theirScore} (${game.detail}) | ${(entryPrice*100).toFixed(0)}¢→${(currentPrice*100).toFixed(0)}¢ (${(pctChange*100).toFixed(0)}%) | WE: ${(ourWE*100).toFixed(0)}% | ${triggerReason}`);

        // Check if the market has recently cross-confirmed a rapid drop on this position.
        // This means both Kalshi contracts agreed — a stronger signal than price alone.
        const contraMove = recentCrossContraMovers.get(trade.ticker);
        const contraAgeMin = contraMove ? Math.round((Date.now() - contraMove.when) / 60000) : null;
        const contraContext = contraMove
          ? `\nMARKET MOVEMENT ALERT: This position's price dropped at ${contraMove.velocity.toFixed(1)}¢/min with CROSS-CONFIRMATION (both contracts moved the same direction) ${contraAgeMin === 0 ? 'just now' : `${contraAgeMin} minute(s) ago`}. Cross-confirmed drops mean the market has information beyond the raw score — how the team looks at the plate, pitcher stuff, momentum. This is a real signal. Weight it toward sell unless your estimate has a very clear 15+ point edge over the market.\n`
          : '';

        const thesisContext = thesisAlert
          ? `\nIN-GAME THESIS STATUS: ${thesisAlert}\n` +
            (thesisIsKiller
              ? `CRITICAL: The key player/factor the thesis was built on is no longer active. Do NOT assume the original thesis edge still applies. Re-evaluate as if this were a fresh bet with current game state only.\n`
              : ``)
          : '';

        const pgPrompt =
          `You manage a pre-game ${sport} bet that is currently LOSING. Your job is to decide: hold, sell half, or sell all.\n\n` +
          `POSITION: Bought ${ourTeam} YES at ${(entryPrice*100).toFixed(0)}¢. Current price: ${(currentPrice*100).toFixed(0)}¢ (${(pctChange*100).toFixed(0)}%, -$${lossAmt.toFixed(2)}).\n` +
          `Game: ${trade.title}\n` +
          `LIVE SCORE: ${awayAbbr} ${game.awayScore} @ ${homeAbbr} ${game.homeScore} | ${game.detail}\n` +
          `Game stage: ${stage.toUpperCase()}\n\n` +
          `ORIGINAL THESIS (why we bought): "${trade.reasoning}"\n\n` +
          `${comebackContext}\n` +
          `${thesisContext}\n` +
          `${contraContext}\n` +
          `YOUR CORE QUESTION: Estimate the true win probability for ${ourTeam} RIGHT NOW.\n` +
          (stage === 'early'
            ? `🚨 EARLY GAME CONSTRAINT (${sport} — ${league === 'mlb' ? 'innings 1-4' : league === 'nhl' ? 'period 1' : league === 'nba' ? 'Q1-Q2' : '1st half'}): Do NOT recommend sell_all unless BOTH are true: (1) deficit is ${league === 'mlb' ? '4+ runs' : league === 'nba' ? '15+ points' : '2+ goals/points'} AND (2) the original thesis factor is clearly dead (starter pulled, goalie changed, star player fouled out). A single goal/run scored against us in early game is NORMAL variance — it is not a reason to exit. Our hard-stop rules protect against catastrophic losses. Your job is NOT to exit early variance.\n`
            : stage === 'mid'
            ? `IMPORTANT — game stage is MID: The original thesis factor is still relevant if not invalidated. Check: is the starter still in? Same goalie? If yes, the thesis has not expired — weight it into your estimate. Only recommend sell_all if the deficit is severe (${league === 'mlb' ? '4+ runs after inning 5' : league === 'nba' ? '20+ points' : '2+ goals'}) or the thesis factor is clearly dead.\n`
            : `Game is LATE — weight current score and time remaining heavily. The original thesis matters less now.\n`
          ) +
          (thesisAlert && !thesisIsKiller ? `📍 LIVE STATUS: ${thesisAlert}\n` : '') +
          `Then compare your estimate to the current market price of ${(currentPrice*100).toFixed(0)}¢.\n\n` +
          `THE DECISION FRAMEWORK:\n` +
          `- Your estimate is 15+ points above market (e.g. you think 40%, market shows 24¢): HOLD — clear edge\n` +
          `- Your estimate is 5–14 points above market: SELL HALF — within noise, cut exposure\n` +
          `- Your estimate is within 5 points above market: SELL ALL — no reliable edge\n` +
          `- Your estimate is 1–5 points below market: SELL HALF — slight negative but within noise; cut exposure, don't panic-exit\n` +
          `- Your estimate is 5+ points below market: SELL ALL — market is being generous, take it\n` +
          `- Game is late AND trailing by 2+: lean sell_all unless estimate is 15+ above price\n` +
          `- Game is EARLY: lean HOLD/sell_half — see constraint above. Do NOT sell_all on early variance alone.\n` +
          `NOTE: Estimates within ±5 points of market are noise — do NOT treat a small negative gap as a strong sell signal.\n\n` +
          `OPTIONS:\n` +
          `A) sell_all — estimate is 5+ below market, or late game large deficit, or thesis clearly dead. Lock loss of $${lossAmt.toFixed(2)}, recover $${(qty * currentPrice).toFixed(2)}.\n` +
          `B) sell_half — estimate is within ±5 of market or 5–14 above. Sell ${halfSellQty}/${qty} contracts, hold rest.\n` +
          `C) hold — estimate is clearly 15+ points above market. Upside: +$${(qty * (1 - entryPrice)).toFixed(2)} if wins.\n\n` +
          `JSON ONLY: {"action": "sell_all"/"sell_half"/"hold", "myWinEstimate": 0.XX, "marketPrice": 0.XX, "reasoning": "one sentence on why estimate vs price justifies the action"}`;

        const pgGuardText = await claudeSonnet(pgPrompt, { maxTokens: 500, timeout: 20000, category: 'pg-guard' });
        if (pgGuardText) {
          try {
            const match = extractJSON(pgGuardText);
            if (match) {
              const d = JSON.parse(match);
              const estPct = d.myWinEstimate != null ? `est=${Math.round(d.myWinEstimate*100)}% mkt=${Math.round(currentPrice*100)}¢` : '';

              if (d.action === 'sell_all' || d.action === 'sell') {
                console.log(`[pg-guard] 🧠 SELL ALL (${estPct}): ${trade.ticker} | ${d.reasoning?.slice(0, 100)}`);
                const freshLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
                const freshTrades = freshLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                const freshTrade = freshTrades.find(t => t.id === trade.id);
                if (freshTrade && freshTrade.status === 'open') {
                  const result = await executeSell(freshTrade, qty, currentPrice, 'pre-game-claude-stop');
                  if (result) {
                    writeFileSync(TRADES_LOG, freshTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
                    console.log(`[pg-guard] Pre-game position fully closed: ${trade.ticker}`);
                    await tg(
                      `⚠️ <b>PRE-GAME EXIT</b>\n\n` +
                      `📋 <b>POSITION</b>\n` +
                      `${trade.title}\n\n` +
                      `📊 <b>METRICS</b>\n` +
                      `Sold all @ ${Math.round(currentPrice*100)}¢\n` +
                      `Entry: ${Math.round(entryPrice*100)}¢ | Stage: ${stage.toUpperCase()}\n` +
                      (d.myWinEstimate != null ? `Claude's estimate: ${Math.round(d.myWinEstimate*100)}% vs market ${Math.round(currentPrice*100)}¢ — no edge\n` : '') +
                      `\n💬 <b>REASON</b>\n` +
                      (d.reasoning ?? 'No edge vs market price')
                    );
                  }
                }
              } else if (d.action === 'sell_half') {
                console.log(`[pg-guard] 🧠 SELL HALF (${estPct}): ${trade.ticker} | selling ${halfSellQty}/${qty} | ${d.reasoning?.slice(0, 80)}`);
                if (halfSellQty < qty) {
                  const freshLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
                  const freshTrades = freshLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                  const freshTrade = freshTrades.find(t => t.id === trade.id);
                  if (freshTrade && freshTrade.status === 'open') {
                    const result = await executeSell(freshTrade, halfSellQty, currentPrice, 'pre-game-partial-stop');
                    if (result) {
                      writeFileSync(TRADES_LOG, freshTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
                      console.log(`[pg-guard] Pre-game position halved: ${trade.ticker} (${halfSellQty} sold, ${qty - halfSellQty} holding)`);
                      await tg(
                        `⚠️ <b>PRE-GAME SELL HALF</b>\n\n` +
                        `📋 <b>POSITION</b>\n` +
                        `${trade.title}\n\n` +
                        `📊 <b>METRICS</b>\n` +
                        `Sold ${halfSellQty}/${qty} @ ${Math.round(currentPrice*100)}¢\n` +
                        `Entry: ${Math.round(entryPrice*100)}¢ | Stage: ${stage.toUpperCase()}\n` +
                        (d.myWinEstimate != null ? `Claude's estimate: ${Math.round(d.myWinEstimate*100)}% vs market ${Math.round(currentPrice*100)}¢ — uncertain edge\n` : '') +
                        `\n💬 <b>REASON</b>\n` +
                        (d.reasoning ?? 'Partial exit — estimate above market but uncertain')
                      );
                    }
                  }
                }
              } else {
                console.log(`[pg-guard] 🧠 HOLD (${estPct}): ${trade.ticker} (${stage}) | ${d.reasoning?.slice(0, 80)}`);
                tradeCooldowns.set('claude-hold:' + trade.ticker, Date.now());
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      console.error('[pg-guard] error:', e.message);
    }
  }

  if (liveGames.length === 0) return;

  // === PHASE 2: Find opportunities — score changed OR baseline-vs-price gap exists ===
  const candidates = [];
  for (const g of liveGames) {
    const gameKey = `${g.away.team?.abbreviation}@${g.home.team?.abbreviation}`;
    const currentState = `${g.awayScore}-${g.homeScore}-${g.period}`;
    const lastState = lastGameStates.get(gameKey);
    const scoreChanged = lastState !== undefined && lastState !== currentState;

    // Always update state
    lastGameStates.set(gameKey, currentState);

    // Skip first time seeing a game (no baseline)
    if (lastState === undefined) continue;

    // Calculate baseline win expectancy
    const isHome = g.leading === g.home;
    const we = g.diff > 0 ? (getWinExpectancy(g.league, g.diff, g.period, isHome) ?? 0.50) : 0.50;
    g._baselineWE = we;
    g._scoreChanged = scoreChanged;

    // Include if: score changed, OR baseline suggests opportunity (>60% WE with a lead),
    // OR it's a tied soccer game (draw-bet logic evaluates these separately).
    //
    // Soccer winner contracts: draw-adjusted gate — 26-28% draw rate makes 1-goal
    // leads marginal unless the game is late. Require 2+ goal lead, OR 1-goal lead
    // in the 2nd half (period>=2, typically >=45 min played).
    if (g.isSoccer && g.diff > 0) {
      const soccerWinnerOK = g.diff >= 2 || (g.diff === 1 && g.period >= 2);
      if (!soccerWinnerOK) continue;
    }
    if (scoreChanged || (g.diff > 0 && we >= 0.60) || (g.isSoccer && g.diff === 0)) {
      candidates.push(g);
    }
  }

  if (candidates.length === 0) return;

  // Sort by baseline WE — highest opportunity first
  candidates.sort((a, b) => b._baselineWE - a._baselineWE);

  // === BATCH FETCH: Get ALL sports market prices in one parallel call ===
  // NOTE: Kalshi sorts markets by ticker name. We need pagination to get ALL markets
  // including tonight's live games (they appear later in the list after future games).
  // Fetch up to 1000 per series to ensure we don't miss any live game.
  const cachedPrices = new Map();
  const seriesList = ['KXMLBGAME', 'KXNBAGAME', 'KXNHLGAME', 'KXMLSGAME', 'KXEPLGAME', 'KXLALIGAGAME', 'KXSERIAA', 'KXBUNDESLIGA', 'KXLIGUE1'];
  try {
    const batchResults = await Promise.allSettled(
      seriesList.map(s => kalshiGet(`/markets?series_ticker=${s}&status=open&limit=1000`).catch(() => ({ markets: [] })))
    );
    for (const r of batchResults) {
      for (const m of (r.status === 'fulfilled' ? (r.value?.markets ?? []) : [])) {
        if (m.yes_ask_dollars && m.ticker) {
          // Capture bid prices alongside ask so we can compute bid/ask spread
          // for shadow logging — wide spreads correlate with mispricing.
          cachedPrices.set(m.ticker, {
            yes: parseFloat(m.yes_ask_dollars), no: parseFloat(m.no_ask_dollars ?? '0'),
            yesBid: parseFloat(m.yes_bid_dollars ?? '0'),
            noBid: parseFloat(m.no_bid_dollars ?? '0'),
            title: m.title ?? '', closeTime: m.close_time ?? '',
          });
        }
      }
    }
  } catch { /* batch fetch failed, will fall back to individual calls */ }

  // Auto-discover abbreviation mismatches between ESPN and Kalshi
  buildDynamicAliases(cachedPrices, liveGames.map(g => ({ home: g.home, away: g.away })));

  // === LINE MOVEMENT DETECTION — flag big price swings for priority analysis ===
  // Date-bounded (2026-04-23): only detect on games within 24h. Thin far-future markets
  // (e.g. LFC-CFC May 9, BRI-WOL May 9) showed 17-22¢/min spurious moves from odd-lot
  // fills. These polluted logs and risked false contra-exit triggers on same-base tickers.
  const lineMovers = [];
  for (const [ticker, data] of cachedPrices) {
    if (!tickerIsWithinNext24h(ticker)) {
      lastSeenPrices.set(ticker, { price: data.yes, ts: Date.now() });
      continue;
    }
    const prev = lastSeenPrices.get(ticker);
    const currentPrice = data.yes;
    if (prev) {
      const move = Math.abs(currentPrice - prev.price);
      if (move >= LINE_MOVE_THRESHOLD) {
        const direction = currentPrice > prev.price ? '📈' : '📉';
        const elapsedMin = Math.max(1, (Date.now() - prev.ts) / 60000);
        const minutesAgo = Math.round(elapsedMin);
        const velocity = (move * 100) / elapsedMin; // cents per minute — distinguishes urgent spike from slow drift
        lineMovers.push({ ticker, title: data.title, from: prev.price, to: currentPrice, move, direction, minutesAgo, velocity });
        console.log(`[line-move] ${direction} ${ticker}: ${(prev.price*100).toFixed(0)}¢ → ${(currentPrice*100).toFixed(0)}¢ (${(move*100).toFixed(0)}¢ in ${minutesAgo}min, ${velocity.toFixed(1)}¢/min)`);
      }
    }
    lastSeenPrices.set(ticker, { price: currentPrice, ts: Date.now() });
  }

  // Boost candidates that had line movement — something happened (injury, weather, lineup)
  // But ONLY boost mid/late game situations. Early-game line moves are just normal scoring noise.
  if (lineMovers.length > 0) {
    for (const mover of lineMovers) {
      // Find the candidate for this game (ticker contains game base)
      const gameBase = mover.ticker.lastIndexOf('-') > 0 ? mover.ticker.slice(0, mover.ticker.lastIndexOf('-')) : mover.ticker;
      const candidate = candidates.find(g => {
        const homeAbbr = g.home.team?.abbreviation ?? '';
        const awayAbbr = g.away.team?.abbreviation ?? '';
        // Require BOTH teams to be present in the ticker — prevents cross-game false matches
        // e.g. KXMLBGAME-...-CLE correctly won't match ARI@BAL even though BAL is in both
        return tickerHasTeam(mover.ticker, homeAbbr) && tickerHasTeam(mover.ticker, awayAbbr);
      });
      if (candidate) {
        // Determine if move is confirming (toward leading team) or contra (against leading team)
        const leadingAbbr = candidate.leading?.team?.abbreviation ?? '';
        const moverTeam = mover.ticker.split('-').pop() ?? '';
        // Check with ABBR_MAP variants: ESPN may say 'ARI' but Kalshi ticker suffix says 'AZ'
        const moverIsLeadingTeam = moverTeam.toUpperCase() === leadingAbbr.toUpperCase() ||
                                   moverTeam.toUpperCase() === (ABBR_MAP[leadingAbbr.toUpperCase()] ?? '').toUpperCase() ||
                                   (ABBR_MAP[moverTeam.toUpperCase()] ?? '').toUpperCase() === leadingAbbr.toUpperCase();
        // Confirming: leading team YES going up, OR trailing team YES going down
        const isConfirming = (moverIsLeadingTeam && mover.to > mover.from) ||
                             (!moverIsLeadingTeam && mover.to < mover.from);

        // Cross-contract check: did the OTHER team's contract also move the same way?
        // e.g., COL YES up AND BOS YES down = both Kalshi contracts agree → stronger signal
        const crossConfirmed = lineMovers.some(m => {
          if (m.ticker === mover.ticker) return false;
          const mBase = m.ticker.lastIndexOf('-') > 0 ? m.ticker.slice(0, m.ticker.lastIndexOf('-')) : m.ticker;
          if (mBase !== gameBase) return false;
          const mTeam = m.ticker.split('-').pop() ?? '';
          const mIsLeading = mTeam === leadingAbbr;
          return (mIsLeading && m.to > m.from) || (!mIsLeading && m.to < m.from);
        });

        candidate._lineMove = { ...mover, confirming: isConfirming, crossConfirmed };

        // Only boost priority if baseline WE is already tradeable (65%+)
        // Contra moves don't get boosted — they're a warning, not an opportunity
        if (isConfirming && candidate._baselineWE >= 0.65) {
          candidate._baselineWE = Math.max(candidate._baselineWE, 0.90); // boost to top of priority queue
        }
        console.log(`[line-move] ${isConfirming ? '✅ CONFIRMING' : '⚠️ CONTRA'} for ${leadingAbbr} (mover: ${moverTeam} ${mover.direction} ${(mover.velocity ?? 0).toFixed(1)}¢/min)${crossConfirmed ? ' — CROSS-CONFIRMED' : ''}`);

        // Store cross-confirmed price drops so pg-guard can see rapid market moves against a position.
        // Only store when BOTH contracts agreed (cross-confirmed) — single-contract moves are noise.
        if (crossConfirmed && mover.to < mover.from) {
          recentCrossContraMovers.set(mover.ticker, { velocity: mover.velocity ?? 0, when: Date.now() });
        }
        // Prune entries older than 5 minutes
        for (const [k, v] of recentCrossContraMovers) {
          if (Date.now() - v.when > 5 * 60 * 1000) recentCrossContraMovers.delete(k);
        }
      }
    }
    // PROMOTION: a cross-confirmed, high-velocity line move on a liveGame that wasn't
    // already a candidate means the market is reacting to something (mid-inning HR, injury,
    // bullpen change) that our WE-floor filter missed. Promote it so Sonnet can evaluate.
    // Market-lag detection is strongest precisely when small early leads create big price
    // swings — exactly the 52-58% WE zone our normal 60% candidate filter excludes.
    const promoted = new Set();
    for (const mover of lineMovers) {
      const gameBase = mover.ticker.lastIndexOf('-') > 0 ? mover.ticker.slice(0, mover.ticker.lastIndexOf('-')) : mover.ticker;
      if (promoted.has(gameBase)) continue;
      const liveGame = liveGames.find(g => {
        const homeAbbr = g.home.team?.abbreviation ?? '';
        const awayAbbr = g.away.team?.abbreviation ?? '';
        return tickerHasTeam(mover.ticker, homeAbbr) && tickerHasTeam(mover.ticker, awayAbbr);
      });
      if (!liveGame || candidates.includes(liveGame)) continue;
      // Cross-confirmation: the OTHER contract in this same game also moved this cycle
      const crossConfirmed = lineMovers.some(m => {
        if (m.ticker === mover.ticker) return false;
        const mBase = m.ticker.lastIndexOf('-') > 0 ? m.ticker.slice(0, m.ticker.lastIndexOf('-')) : m.ticker;
        return mBase === gameBase;
      });
      if (!crossConfirmed) continue;
      if ((mover.velocity ?? 0) < 5) continue;
      const isHome = liveGame.leading === liveGame.home;
      liveGame._baselineWE = liveGame.diff > 0 ? (getWinExpectancy(liveGame.league, liveGame.diff, liveGame.period, isHome) ?? 0.50) : 0.50;
      liveGame._lineMovePromoted = true;
      liveGame._lineMove = { ...mover, confirming: false, crossConfirmed: true };
      candidates.push(liveGame);
      promoted.add(gameBase);
      console.log(`[live-edge] 📣 PROMOTED by line-move: ${liveGame.away.team?.abbreviation}@${liveGame.home.team?.abbreviation} — cross-confirmed ${(mover.velocity ?? 0).toFixed(1)}¢/min, WE=${(liveGame._baselineWE*100).toFixed(0)}% (below normal floor but market is active)`);
    }

    // Re-sort — confirming moves at top, contra moves stay at natural WE rank
    candidates.sort((a, b) => b._baselineWE - a._baselineWE);
  }

  console.log(`[live-edge] ${candidates.length} candidates, ${cachedPrices.size} prices cached${lineMovers.length > 0 ? `, ${lineMovers.length} line movers` : ''} | ${candidates.map(g => {
    const tag = g._lineMove ? '🔥' : g._scoreChanged ? '⚡' : '📊';
    return tag + g.away.team?.abbreviation + '@' + g.home.team?.abbreviation + '(' + (g._baselineWE*100).toFixed(0) + '%)';
  }).join(', ')})`);

  // === PHASE 3: Analyze candidates in priority order — best opportunity first ===
  let sonnetCallsThisCycle = 0;
  const MAX_SONNET_PER_CYCLE = 8; // Up from 6 — covers peak playoff hours with 8+ live games

  // Collect Sonnet work items for parallel execution
  const sonnetQueue = [];

  for (const { league, comp, home, away, homeScore, awayScore, diff, period, leading, detail: gameDetail, isSoccer, _scoreChanged, _lineMove, _lineMovePromoted } of candidates) {
    const seriesMap = { mlb: 'KXMLBGAME', nba: 'KXNBAGAME', nhl: 'KXNHLGAME', mls: 'KXMLSGAME', epl: 'KXEPLGAME', laliga: 'KXLALIGAGAME', seriea: 'KXSERIAA', bundesliga: 'KXBUNDESLIGA', ligue1: 'KXLIGUE1' };
    const series = seriesMap[league] ?? 'KXMLBGAME';

    // === DRAW BET CHECK (soccer only, tied games, 2nd half or late 1st half 0-0) ===
    if (isSoccer && diff === 0 && period >= 1) {
      try {
        const homeAbbr = home.team?.abbreviation ?? '';
        const awayAbbr = away.team?.abbreviation ?? '';

        // 2026-05-02: SYNTHETIC DRAW-BET SHADOW — moved here from inside live-edge
        // candidate loop (which never runs for tied games due to leader-only filter).
        // Logs every eligible draw-bet setup for cell mining, even if we don't actually
        // place a bet. Was producing 0 records due to the unreachable code path.
        try {
          const _minMatchEarly = gameDetail.match(/(\d+)/);
          const _minutesEarly = _minMatchEarly ? parseInt(_minMatchEarly[1]) : 0;
          const _effMinEarly = period === 2 ? Math.max(_minutesEarly, 45) : _minutesEarly;
          if (_effMinEarly >= 60) {
            const _ticker0 = `${series}-${ev.id ?? ''}-TIE`;
            const _drawPriceProxy = 0.30; // proxy — actual TIE price not always cached
            const _minuteBand = _effMinEarly < 70 ? '60-69' : _effMinEarly < 80 ? '70-79' : _effMinEarly < 85 ? '80-84' : '85+';
            const _scoreState = (homeScore === 0 && awayScore === 0) ? '0-0' : 'goals';
            const _dbCell = `${league}-draw-${_scoreState}-min${_minuteBand}`;
            logShadowDecision({
              stage: 'live-edge-drawbet-synthetic',
              ticker: _ticker0,
              sport: 'Soccer', league,
              decision: 'synthetic-drawbet-candidate',
              rejectReason: 'drawbet-baseline',
              claudeConfidence: null,
              decisionPrice: _drawPriceProxy,
              edge: null,
              scoreDiff: 0, period, gameDetail,
              leadingAbbr: null, targetAbbr: 'TIE',
              homeAbbr, awayAbbr,
              liveStage: 'mid',
              reasoningPreview: `DRAW-BET CANDIDATE [${_dbCell}] tied ${homeScore}-${awayScore} at min ${_effMinEarly} — synthetic shadow`,
              isDrawBetSynthetic: true,
              drawBetCell: _dbCell,
              strategy: 'synthetic-draw-bet',
            });
          }
        } catch { /* best-effort */ }

        // Parse minutes from detail (e.g. "72'" or "2nd - 27'")
        const minMatch = gameDetail.match(/(\d+)/);
        const minutes = minMatch ? parseInt(minMatch[1]) : 0;
        // period 2 = second half. Minutes in second half context.
        const effectiveMin = period === 2 ? Math.max(minutes, 45) : minutes;

        // Draw probability baselines by minute (research-verified)
        // EPL ~27% draw rate, MLS ~25% with 3.0 goals/game vs EPL's 2.7 — MLS
        // draws break more often in late minutes due to open play and fitness gaps.
        const isHighGoalLeague = league === 'mls';
        const drawAdj = isHighGoalLeague ? -0.03 : 0;
        let drawProb = 0;
        if (homeScore === 0 && awayScore === 0) {
          // 0-0: neither team has shown scoring ability — safer draw profile
          // 2026-04-27 expansion: enable 60-64' window at 60% draw prob to fire on
          // more matches. Draw-bet historical 71% WR / +$28/trade — proven highest-
          // ROI strategy underutilized in current rate. Earlier window adds 4-5 min
          // of opportunity per game.
          if (effectiveMin >= 80) drawProb = 0.88;
          else if (effectiveMin >= 75) drawProb = 0.85;
          else if (effectiveMin >= 70) drawProb = 0.78;
          else if (effectiveMin >= 65) drawProb = 0.70;
          else if (effectiveMin >= 60) drawProb = 0.60; // NEW: capture 60-64' setups
          else drawProb = 0;
        } else {
          // 1-1, 2-2 etc: both teams CAN score — don't enter before 65'
          // 2026-04-27 expansion: enable 65-69' window at 62% draw prob.
          if (effectiveMin >= 80) drawProb = 0.84;
          else if (effectiveMin >= 75) drawProb = 0.80;
          else if (effectiveMin >= 70) drawProb = 0.72;
          else if (effectiveMin >= 65) drawProb = 0.62; // NEW: capture 65-69' tied-game setups
          else drawProb = 0;
        }
        if (drawProb > 0) drawProb = Math.max(0, drawProb + drawAdj);

        // Red card guard — our minute-based tables assume 11v11. A red card changes
        // the entire game dynamic in ways our tables don't model. Skip draw bet if detected.
        // ESPN uses 'RC' for red cards in the statistics array. lastPlay check catches
        // same-moment red cards. Defensive: if stat not found, defaults to 0 (safe).
        const rcStat = (team) => parseInt(team.statistics?.find(s => s.abbreviation === 'RC')?.displayValue ?? '0') || 0;
        const hasRedCard = rcStat(home) > 0 || rcStat(away) > 0 ||
          (comp.situation?.lastPlay?.text ?? '').toLowerCase().includes('red card');
        if (hasRedCard) {
          console.log(`[draw-bet] Skipping ${homeAbbr} vs ${awayAbbr}: red card detected — minute tables invalid for 10v11`);
        }

        // Only bet draws when probability is strong (65%+) — eliminates the
        // 55-64% zone where a single goal wipes out the entire position
        if (!hasRedCard && drawProb > 0 && drawProb < 0.65) {
          console.log(`[draw-bet-trace] ${homeAbbr} vs ${awayAbbr} ${homeScore}-${awayScore} min=${effectiveMin}: drawProb=${(drawProb*100).toFixed(0)}% below 65% threshold — silent skip (observe only)`);
        }
        if (!hasRedCard && drawProb >= 0.65) {
          // Find the TIE market from cached prices (instant, no API call)
          const tieEntry = [...cachedPrices.entries()].find(([t]) =>
            t.startsWith(series) && t.includes('-TIE') && tickerHasTeam(t, homeAbbr) && tickerHasTeam(t, awayAbbr)
          );
          const tieMarket = tieEntry ? { ticker: tieEntry[0], yes_ask_dollars: String(tieEntry[1].yes), title: tieEntry[1].title } : null;

          if (tieMarket) {
            const tiePrice = parseFloat(tieMarket.yes_ask_dollars ?? '1');

            // Only buy if our probability exceeds the price by 3%+
            const drawMargin = isHighGoalLeague ? 0.05 : CONFIDENCE_MARGIN;
            // Scoreline-aware price ceiling:
            //   0-0 late: safe draw profile — full ceiling (MAX_PRICE, ~75¢)
            //   1-1+ late: any goal craters TIE by 30¢+ (ATL@NE 58→29 on one goal).
            //     Cap at 50¢ so risk:reward stays roughly 1:1 instead of 1:1.5 against us.
            const hasGoalsScored = homeScore > 0 || awayScore > 0;
            const drawPriceCeiling = hasGoalsScored ? 0.50 : MAX_PRICE;
            if (tiePrice > drawPriceCeiling) {
              console.log(`[draw-bet] Skipping ${homeAbbr} vs ${awayAbbr}: TIE @${Math.round(tiePrice*100)}¢ > ${Math.round(drawPriceCeiling*100)}¢ ceiling (score ${homeScore}-${awayScore}, one goal = ~30¢ drop)`);
              continue;
            }
            if (tiePrice < drawProb - drawMargin && tiePrice <= drawPriceCeiling && tiePrice >= 0.10) {
              const margin = drawProb - tiePrice;

              // Check risk gates
              if (!canTrade()) continue;
              const gameBase = tieMarket.ticker.lastIndexOf('-') > 0 ? tieMarket.ticker.slice(0, tieMarket.ticker.lastIndexOf('-')) : tieMarket.ticker;
              if (Date.now() - (tradeCooldowns.get(tieMarket.ticker) ?? 0) < COOLDOWN_MS) continue;
              if (Date.now() - (tradeCooldowns.get(gameBase) ?? 0) < COOLDOWN_MS) continue;

              // Check no existing position (portfolio API)
              let hasPos = openPositions.some(p => {
                const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
                return pBase === gameBase || (p.exchange === 'polymarket' && tickerHasTeam(p.ticker, homeAbbr) && tickerHasTeam(p.ticker, awayAbbr));
              });

              // Also check JSONL — prevents stacking when portfolio API hasn't synced yet.
              // This was the bug: 4 draw-bets on TOT-BRI totaling $167 because each
              // cycle saw no position in portfolio, cooldown had expired, and edge grew.
              if (!hasPos && existsSync(TRADES_LOG)) {
                try {
                  const dupStart = new Date(etNow().toISOString().slice(0,10) + 'T04:00:00Z').getTime();
                  const dupEnd = dupStart + 24 * 60 * 60 * 1000;
                  const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
                  for (const l of lines) {
                    try {
                      const jt = JSON.parse(l);
                      if (jt.status === 'testing-void') continue;
                      const jtMs = jt.timestamp ? Date.parse(jt.timestamp) : 0;
                      if (jtMs < dupStart || jtMs >= dupEnd) continue;
                      const jticker = (jt.ticker ?? '').toLowerCase();
                      if (jticker.includes(gameBase.toLowerCase()) || (tickerHasTeam(jticker, homeAbbr) && tickerHasTeam(jticker, awayAbbr))) {
                        hasPos = true;
                        break;
                      }
                    } catch {}
                  }
                } catch {}
              }
              // 2026-04-27: allow scale-in on draw-bet via canScaleInto.
              // Previously a blanket block (per TOT-BRI comment) — but TOT-BRI
              // was profitable (+$206 across 4 entries on the same draw thesis).
              // Re-enable scale-in with safety: canScaleInto requires (a) score
              // unchanged (still 0-0 or 1-1 — thesis intact), (b) price improved
              // 4¢+ (better entry), (c) within max-entries-per-game cap. The
              // 40% bankroll concentration cap below still applies as backstop.
              const drawScoreKey = scoreKey(homeScore, awayScore);
              if (hasPos && !canScaleInto(gameBase, tiePrice, qty * tiePrice, drawScoreKey)) {
                const drawEntry = gameEntries.get(gameBase);
                const drawScoreChanged = drawEntry?.lastScoreKey && drawScoreKey && drawEntry.lastScoreKey !== drawScoreKey;
                const drawReason = drawScoreChanged
                  ? `score changed since last entry (${drawEntry.lastScoreKey} → ${drawScoreKey}) — thesis broken`
                  : `scale-in not eligible (need ≥4¢ price drop OR same-score)`;
                console.log(`[draw-bet] Already have position on ${homeAbbr} vs ${awayAbbr}, skipping: ${drawReason}`);
                continue;
              }
              if (hasPos) {
                console.log(`[draw-bet] 📈 Scale-in: ${homeAbbr} vs ${awayAbbr} TIE@${(tiePrice*100).toFixed(0)}¢ (score ${drawScoreKey} unchanged) — adding to existing position`);
              }

              // Draw-bet bankroll cap: max 40% deployed across all concurrent draw-bets.
              // One 0-0 soccer goal wipes all draw positions simultaneously — concentration risk.
              // Tottenham-Brighton stacked $167 on one game; this prevents a multi-game version.
              if (existsSync(TRADES_LOG)) {
                try {
                  const dbLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
                  const dbTrades = dbLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                  const openDrawDeployed = dbTrades
                    .filter(t => t.strategy === 'draw-bet' && t.status === 'open')
                    .reduce((sum, t) => sum + (t.deployCost ?? 0), 0);
                  const drawBetCap = getBankroll() * 0.40;
                  if (openDrawDeployed >= drawBetCap) {
                    console.log(`[draw-bet] ⚠️ BANKROLL CAP: draw-bet exposure $${openDrawDeployed.toFixed(2)} ≥ 40% of bankroll ($${drawBetCap.toFixed(2)}) — skipping until positions close`);
                    continue;
                  }
                } catch {}
              }

              // 1.5x sizing at minute 75+ with 0-0 scoreline — highest draw probability tier (85-88%)
              const drawSizingMultiplier = (effectiveMin >= 75 && homeScore === 0 && awayScore === 0) ? 1.5 : 1.0;
              const maxBet = Math.min(getPositionSize('kalshi', margin, 0, league) * drawSizingMultiplier, getBankroll() * (0.10 * drawSizingMultiplier));
              const qty = Math.max(1, Math.floor(maxBet / tiePrice));
              if (!canDeployMore(qty * tiePrice)) continue;

              const priceInCents = Math.round(tiePrice * 100);
              console.log(`[draw-bet] ⚽ ${homeAbbr} ${homeScore}-${awayScore} ${awayAbbr} at ${effectiveMin}' | TIE @${priceInCents}¢ (prob: ${(drawProb*100).toFixed(0)}%) margin: ${(margin*100).toFixed(0)}%`);

              // Team context from already-fetched ESPN scoreboard data (zero new API calls).
              // Gives Claude the identity of each side so "open vs closed" judgement has something
              // concrete to latch onto — records, home/road splits, recent form string if present.
              const homeName = home.team?.displayName ?? homeAbbr;
              const awayName = away.team?.displayName ?? awayAbbr;
              const homeOverall = home.records?.[0]?.summary ?? '?';
              const awayOverall = away.records?.[0]?.summary ?? '?';
              const homeHomeRecDB = home.records?.find(r => r.type === 'home')?.summary ?? '';
              const awayRoadRecDB = away.records?.find(r => r.type === 'road' || r.type === 'away')?.summary ?? '';
              const homeForm = home.form ?? home.team?.form ?? '';
              const awayForm = away.form ?? away.team?.form ?? '';
              const teamCtx =
                `HOME ${homeAbbr} — ${homeName} | Record: ${homeOverall}${homeHomeRecDB ? ` | Home: ${homeHomeRecDB}` : ''}${homeForm ? ` | Form (recent): ${homeForm}` : ''}\n` +
                `AWAY ${awayAbbr} — ${awayName} | Record: ${awayOverall}${awayRoadRecDB ? ` | Away: ${awayRoadRecDB}` : ''}${awayForm ? ` | Form (recent): ${awayForm}` : ''}\n`;

              // Claude reasoning gate — swing-trade evaluation before placing
              const drawPrompt = `You are a soccer swing-trade analyst. We are NOT betting on settlement — we buy TIE and sell when the price RISES in the next 10-15 minutes. Evaluate this entry.\n\n` +
                `MATCH: ${homeAbbr} vs ${awayAbbr} (${league.toUpperCase()})\n` +
                `${teamCtx}` +
                `SCORE: ${homeScore}-${awayScore} at ${effectiveMin}'\n` +
                `DRAW PROBABILITY (historical baseline): ${(drawProb*100).toFixed(0)}%\n` +
                `TIE PRICE: ${priceInCents}¢ (margin: ${(margin*100).toFixed(0)}%)\n` +
                `DEPLOY: $${(qty * tiePrice).toFixed(2)} (${qty} contracts)\n\n` +
                `SWING-TRADE LOGIC: TIE price rises as clock ticks without a goal. Every goalless minute = higher TIE price. We sell at +12¢. We stop-loss at -50%.\n\n` +
                `STATISTICAL BASE RATE: Tied EPL/MLS games after minute 70 end as draws approximately 65% of the time, regardless of team quality, rivalry intensity, or motivation. This is the statistical floor — weigh narrative risk against it. Do NOT override this base rate without strong, specific evidence (e.g. a red card just issued, a confirmed injury to the leading scorer).\n\n` +
                `Consider:\n` +
                `- TEAM IDENTITIES (from the records above): strong home sides losing at home are usually chasing (open, goal-risk); strong away sides protecting a draw against a top home side are typically parking the bus (closed, good for us). A team badly out of form (L-L-L in recent) often closes down late to stop bleeding — also good for TIE. A team on a winning streak late in a tied game presses hard — bad for TIE.\n` +
                `- Is the game OPEN (end-to-end, both teams attacking) or CLOSED (defensive, low-energy, time-wasting)? Closed = TIE price rises faster.\n` +
                `- At ${effectiveMin}', will the next 10-15 minutes likely be goalless? That's all we need for profit.\n` +
                `- Is either team pressing hard for a winner? A team throwing bodies forward = higher goal risk = bad for us.\n` +
                `- Is ${(margin*100).toFixed(0)}% margin enough to absorb a brief dip before TIE price climbs?\n` +
                `- Any red flags: dominant team likely to score, substitution patterns suggesting attacking push?\n\n` +
                `Reply with EXACTLY this format:\n` +
                `VERDICT: BUY or SKIP\n` +
                `CONFIDENCE: <number 0-100>\n` +
                `REASONING: <1-2 sentences focused on whether TIE PRICE will rise in the next 10-15 minutes>`;

              const drawAnalysis = await claudeSonnet(drawPrompt, { maxTokens: 200, timeout: 15000, category: 'draw-bet' });
              const drawVerdict = (drawAnalysis ?? '').toUpperCase().includes('VERDICT: BUY') ? 'BUY' : 'SKIP';
              const drawReasoning = (drawAnalysis ?? '').match(/REASONING:\s*(.+)/i)?.[1]?.trim() ?? 'No reasoning provided';
              const drawConf = parseInt((drawAnalysis ?? '').match(/CONFIDENCE:\s*(\d+)/i)?.[1] ?? '0');

              if (drawVerdict !== 'BUY' || drawConf < 55) {
                console.log(`[draw-bet] Claude says ${drawVerdict} (conf: ${drawConf}%): ${drawReasoning}`);
                tradeCooldowns.set(tieMarket.ticker, Date.now());
                tradeCooldowns.set(gameBase, Date.now());
                continue;
              }

              console.log(`[draw-bet] Claude APPROVED (conf: ${drawConf}%): ${drawReasoning}`);

              tradeCooldowns.set(tieMarket.ticker, Date.now());
              tradeCooldowns.set(gameBase, Date.now());

              const result = await kalshiPost('/portfolio/orders', {
                ticker: tieMarket.ticker, action: 'buy', side: 'yes', count: qty,
                yes_price: priceInCents,
              });

              if (result.ok) {
                stats.tradesPlaced++;
                const deployed = qty * tiePrice;
                // Record game entry for scale-in tracking — enables future
                // entries on the same game when price drops further and score
                // hasn't changed (the TOT-BRI compounding pattern).
                recordGameEntry(gameBase, tiePrice, deployed, drawScoreKey);
                logTrade({
                  exchange: 'kalshi', strategy: 'draw-bet',
                  ticker: tieMarket.ticker, title: tieMarket.title ?? `${homeAbbr} vs ${awayAbbr} TIE`,
                  side: 'yes', quantity: qty, entryPrice: tiePrice, deployCost: deployed,
                  filled: (result.data.order ?? result.data).quantity_filled ?? 0,
                  orderId: (result.data.order ?? result.data).order_id ?? null,
                  edge: margin * 100, confidence: drawConf / 100,
                  reasoning: drawReasoning,
                  league,
                  scoreDiff: 0,
                  periodAtEntry: period,
                  weAtEntry: drawProb,
                  isLeadingTeam: false,
                });

                await tgTradeEntry({
                  kind: `DRAW-BET — ${league.toUpperCase()}`,
                  title: `${homeAbbr} ${homeScore}-${awayScore} ${awayAbbr}`,
                  gameLine: `Minute ${effectiveMin}' · TIE bet`,
                  team: 'TIE',
                  price: tiePrice,
                  qty: qty,
                  deployed: deployed,
                  conf: drawConf / 100,
                  edge: margin * 100,
                  reason: drawReasoning,
                  strategyTag: 'draw-bet',
                });
              }
            }
          }
        }
      } catch (e) { console.error(`[draw-bet] error:`, e.message); }

      // If game is tied, skip the normal team-win analysis (no leader to bet on)
      if (diff === 0) continue;
    }

    // === WIN EXPECTANCY FLOOR — don't waste Sonnet when baseline WE is too low to trade ===
    // If baseline WE < 65%, Claude can't reach 65% min confidence (Claude rarely exceeds baseline
    // in early games). Games between SWING_WE_FLOOR and MIN_WE_FOR_SONNET enter swing mode.
    let isSwingMode = false;
    let isThesisVindicated = false;
    // 2026-05-01: hoisted to outer scope so queue push can capture them for shadow
    // enrichment. Were previously block-scoped inside the WE-floor `{...}` block at
    // ~line 5925, causing swingWEFloor/minWEForSonnet/baseWE to be undefined at the
    // queue push site (0% population in shadow records).
    let _outerBaseWE = null;
    let _outerMinWEForSonnet = null;
    let _outerSwingWEFloor = null;
    // If baseline WE < 65%, Claude can't reach 65% min confidence (Claude rarely exceeds baseline
    // in early games). This naturally handles every situation:
    //   - 1-run lead inn 2 (58% WE) → skip (noise)
    //   - 3-run lead inn 1 (72% WE) → analyze (real blowout)
    //   - 5-pt NBA Q1 (57% WE) → skip
    //   - 15-pt NBA Q1 (70% WE) → analyze
    // Sport-specific WE floors based on actual trade data and variance research:
    //   - MLB: 75% floor (HR can erase any lead instantly)
    //   - NHL P1: BLOCKED entirely — 40 min remaining, even 2-goal leads can reverse (PIT/STL)
    //   - NHL 1-goal leads: 75% floor (1-goal P2 = 68% WE, too volatile)
    //     Only 1-goal P3 (79% WE) and all 2-goal+ leads in P2/P3 qualify
    //   - NHL 2-goal+ any period: 65% floor (80%+ WE); 1-goal P1 blocked, 1-goal P2 blocked (68%)
    //   - NBA Q3: 73% floor — requires 8+ pt lead (5-7pt Q3 is too volatile, MIA/CHA proved it)
    //   - NBA/Soccer: 65% floor otherwise
    {
      // THESIS-VINDICATED RE-ENTRY: if we got stopped out on this game but the stopped
      // team is now LEADING (tied or ahead), the thesis survived adversity — lower the WE
      // floor to allow re-entry at what's likely a better price than our original entry.
      // Only applies after the 30-min stop-lock has expired.
      const ha = home.team?.abbreviation ?? '';
      const aa = away.team?.abbreviation ?? '';
      const priorStop = [...stoppedBets.entries()].find(([base]) =>
        base.includes(ha) && base.includes(aa) && Date.now() - stoppedBets.get(base).stoppedAt < 4 * 60 * 60 * 1000
      );
      isThesisVindicated = !!(priorStop && (() => {
        const stoppedTeam = priorStop[1].team;
        const stoppedBase = priorStop[0];
        const lockExpired = !stopLocks.has(stoppedBase) || Date.now() >= stopLocks.get(stoppedBase);
        if (!lockExpired) return false;
        // Check if the stopped team is now the leading team
        const leadingAbbr2 = leading?.team?.abbreviation ?? '';
        return stoppedTeam === leadingAbbr2;
      })());

      if (isThesisVindicated) {
        console.log(`[live-edge] 🔁 THESIS VINDICATED: ${aa}@${ha} — stopped on ${priorStop[1].team}, now leading — lowering WE floor for re-entry`);
      }

      // NHL 1-goal P1: previously blocked outright. Now let it pass — downstream gates
      // (price ceiling, WE floor, Sonnet prompt, required margin) will reject if no edge.
      // Blocking upstream missed every mispriced 1-goal P1 (which happen when market
      // overreacts to the goal).

      const baseWE = getWinExpectancy(league, diff, period) ?? 0.50;
      _outerBaseWE = baseWE;
      // Thesis-vindicated: drop floor to 60% (team recovered from a deficit we stopped out of)
      const MIN_WE_FOR_SONNET = isThesisVindicated ? 0.60 : (() => {
        if (league === 'mlb') return 0.70; // 2-run leads in inn 5+ (70% WE) now qualify — was 75% which only caught 3+ run leads already priced at 80¢+
        if (league === 'nhl' && diff === 1) return 0.68; // P2 1-goal (68% WE) now passes — was 75% which only allowed P3 1-goal. P1 still blocked by separate check above.
        if (league === 'nba' && period <= 2) return 0.73; // Q1/Q2 stays strict — early NBA leads are genuinely volatile
        if (league === 'nba' && period === 3) return 0.65; // 2026-05-01: Q3 lowered 68%→65%. NBA live-pred 86% WR (n=14) — floor was rejecting +EV trades
        if (league === 'nba' && period === 4) return 0.62; // 2026-05-01: Q4 explicit 62% (was default). Late-game leads protected by clock; capture more
        return 0.62; // default — was 65%, opens up soccer and other sports slightly
      })();

      // SWING MODE: games between SWING_WE_FLOOR and MIN_WE_FOR_SONNET are candidates
      // for live swing trades — buy at ≤65¢, exit at +12¢ profit (not hold to settlement).
      // Period-aware: early-game small leads are fragile (one swing of the bat erases the
      // thesis), so require a higher WE floor before we'll consider a swing. 2026-04-23
      // ATL@WSH swing stopped out at -10¢: 1-run lead inning 4, thesis died when tied.
      const SWING_WE_FLOOR = (() => {
        if (league === 'mlb') return period <= 4 ? 0.66 : 0.62; // innings 1-4 fragile, 5+ normal
        if (league === 'nba') return period <= 2 ? 0.64 : 0.60; // Q1-Q2 small leads volatile
        if (league === 'nhl') return period === 1 ? 0.64 : 0.60; // P1 1-goal leads volatile
        return (period === 1) ? 0.58 : 0.55; // soccer: 1st half tighter than 2nd
      })();
      _outerMinWEForSonnet = MIN_WE_FOR_SONNET;
      _outerSwingWEFloor = SWING_WE_FLOOR;
      if (baseWE < MIN_WE_FOR_SONNET) {
        if (_lineMovePromoted) {
          isSwingMode = true;
          console.log(`[live-swing] 🔄 Swing candidate (line-move-promoted): ${away.team?.abbreviation}@${home.team?.abbreviation} — ${league.toUpperCase()} WE=${(baseWE*100).toFixed(0)}% below floor but market moved — letting Sonnet evaluate`);
        } else if (baseWE >= SWING_WE_FLOOR) {
          isSwingMode = true;
          const trigger = _scoreChanged ? 'score-changed' : 'sub-floor-WE';
          console.log(`[live-swing] 🔄 Swing candidate (${trigger}): ${away.team?.abbreviation}@${home.team?.abbreviation} — ${league.toUpperCase()} WE=${(baseWE*100).toFixed(0)}% (swing floor ${(SWING_WE_FLOOR*100).toFixed(0)}%, live floor ${(MIN_WE_FOR_SONNET*100).toFixed(0)}%)`);
        } else {
          console.log(`[live-edge] Skipping low-WE: ${away.team?.abbreviation}@${home.team?.abbreviation} — ${league.toUpperCase()} ${diff}-${league === 'nba' ? 'pt' : league === 'mlb' ? 'run' : 'goal'} lead P${period}, WE=${(baseWE*100).toFixed(0)}% (need ${(MIN_WE_FOR_SONNET*100).toFixed(0)}%+ for ${league.toUpperCase()} ${diff === 1 ? '1-goal' : ''})`);
          logScreen({ stage: 'live-edge-skip', result: 'skip-we-floor', league, homeAbbr: home.team?.abbreviation ?? '', awayAbbr: away.team?.abbreviation ?? '', homeScore, awayScore, diff, period, winExpectancy: baseWE, reasoning: `WE=${(baseWE*100).toFixed(0)}% is below the ${(MIN_WE_FOR_SONNET*100).toFixed(0)}% floor for ${league.toUpperCase()}${diff === 1 && league === 'nhl' ? ' 1-goal leads' : ''} — need stronger lead or later period to justify analysis` });
          continue;
        }
      }
    }

    // NOTE: Removed code-level <40% win rate hard block.
    // SJ (bottom team) won tonight with a 1-goal P3 lead. The baseline WE is real.
    // Bad teams DO protect leads 79% of the time (P3 1-goal). Let Claude assess
    // with full context instead of auto-blocking. Win rate is now a prompt adjustment.

    // 2026-04-27 audit + adjust: hard-cap simultaneous Sonnet-driven live trades
    // to limit correlated drawdown. Tightened over-cap (was 3) to 5 because at
    // small bankroll, position sizes are tiny ($3-5 each) and 5 losses is still
    // recoverable. Structural-detector trades EXCLUDED from this cap — they're
    // 75-100% WR rule-based fires we WANT to take whenever pattern matches.
    // Draw-bets also excluded — they have their own 40% bankroll concentration cap.
    {
      const sonnetDrivenStrategies = ['live-prediction', 'high-conviction', 'thesis-reentry'];
      const openCount = openPositions.filter(p => sonnetDrivenStrategies.includes(p.strategy)).length;
      const liveCap = getBankroll() < 500 ? 5 : getBankroll() < 2000 ? 8 : 12;
      if (openCount >= liveCap) {
        console.log(`[live-edge] BLOCKED ${targetAbbr}: ${openCount} Sonnet-driven live positions open, cap ${liveCap} for $${getBankroll().toFixed(0)} bankroll — variance protection (structural detectors and draw-bets bypass this)`);
        continue;
      }
    }

    // SWING MODE: max 3 concurrent swing trades (raised from 2)
    if (isSwingMode) {
      const openSwingCount = openPositions.filter(p => p.strategy === 'live-swing').length;
      if (openSwingCount >= 3) {
        console.log(`[live-swing] BLOCKED: already ${openSwingCount} open swing trades (max 3)`);
        continue;
      }
    }

    // Cap Sonnet calls per cycle to avoid stale prices on later games
    if (sonnetCallsThisCycle >= MAX_SONNET_PER_CYCLE) {
      console.log(`[live-edge] Sonnet cap reached (${MAX_SONNET_PER_CYCLE}), remaining games deferred to next cycle`);
      break;
    }

    try {
        const homeAbbr = home.team?.abbreviation ?? '';
        const awayAbbr = away.team?.abbreviation ?? '';
        if (!homeAbbr || !awayAbbr) continue;

        // Get today/tonight Kalshi markets — pre-filter to THIS game's teams + today's date
        const etNowLE = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const toShortLE = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
        const todayStr = toShortLE(etNowLE);
        // Late night: if it's after 10pm ET, also accept tomorrow's date (game started tonight, ticker is next day UTC)
        const etHourLE = etNowLE.getHours();
        const etTmrwLE = new Date(etNowLE.getTime() + 24 * 60 * 60 * 1000);
        const tonightStr = etHourLE >= 22 ? toShortLE(etTmrwLE) : null;
        // Early morning (midnight-4am ET): also accept yesterday date for late-night games still live
        const etYestLE = new Date(etNowLE.getTime() - 24 * 60 * 60 * 1000);
        const yesterdayStr = etHourLE < 4 ? toShortLE(etYestLE) : null;

        // For tonightStr markets (next-day UTC date): only accept if the game's start time
        // embedded in the ticker is before 08:00 UTC. Games that started after 8pm ET on the
        // current day have UTC start times of 00:xx–07:xx. Pre-game markets for tomorrow's
        // games have start times like 13:xx, 18:xx, 19:xx, 20:xx — those are future games.
        // This prevents matching ESPN live games (stale/delayed feed) to tomorrow's pre-game markets.
        const tonightStarted = (ticker) => {
          const m = ticker.match(/\d{2}[A-Z]{3}\d{2}(\d{4})/); // e.g. 26APR15 + 0105
          if (!m) return true; // no embedded time (NHL-style tickers) — allow through
          return parseInt(m[1]) < 800; // 0000–0759 UTC = started after 8pm ET same night
        };
        // Extra guard: reject any market whose embedded UTC start time is more than 6 hours
        // in the future. A genuinely live game must have already started. This catches cases
        // where ESPN returns stale "in progress" scores and the bot matches them to tonight's
        // pre-game markets (e.g. ESPN shows TEX@ATH still live but Kalshi only has tomorrow's 21:40 UTC market).
        const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        const tickerHasStarted = (ticker) => {
          const m = ticker.match(/(\d{2})([A-Z]{3})(\d{2})(\d{4})/);
          if (!m) return true; // no datetime in ticker, allow through
          const [, yy, mon, dd, hhmm] = m;
          const mo = MONTHS.indexOf(mon);
          if (mo < 0) return true;
          const scheduledUTC = new Date(Date.UTC(2000 + parseInt(yy), mo, parseInt(dd),
            parseInt(hhmm.slice(0,2)), parseInt(hhmm.slice(2,4))));
          return scheduledUTC.getTime() <= Date.now() + 6 * 60 * 60 * 1000; // must start within 6h
        };
        const isToday = (ticker) => {
          if (!tickerHasStarted(ticker)) return false; // reject future markets regardless of date
          return ticker.includes(todayStr) || (tonightStr && ticker.includes(tonightStr) && tonightStarted(ticker)) || (yesterdayStr && ticker.includes(yesterdayStr));
        };
        const gameMarkets = [...cachedPrices.entries()]
          .filter(([ticker, data]) => {
            if (data.yes < 0.01 || data.yes > 0.99) return false;
            // HARD FILTER: live-edge only bets on TODAY's markets — never a future game's market.
            // If ESPN shows a live game but Kalshi only has tomorrow's market for those teams,
            // skip rather than bet on the wrong game. (KC@DET live vs tomorrow's pre-game = wrong.)
            if (!isToday(ticker)) return false;
            // Sport-prefix guard: NHL Dallas Stars (DAL) @ Minnesota Wild (MIN) must NOT match
            // the MLS ticker KXMLSGAME-...-DALMIN-DAL (FC Dallas vs Minnesota United same night).
            // Both have DAL+MIN abbrs — without the prefix check we'd cross-sport-match.
            if (!ticker.startsWith(series)) return false;
            return tickerHasTeam(ticker, homeAbbr) && tickerHasTeam(ticker, awayAbbr);
          })
          .sort(([, a], [, b]) => Math.abs(b.yes - 0.50) - Math.abs(a.yes - 0.50)) // most decisive first
          .map(([ticker, data]) => ({
            ticker, title: data.title, yes_ask_dollars: String(data.yes), no_ask_dollars: String(data.no),
          }));

        if (gameMarkets.length === 0) {
          console.log(`[live-edge] No TODAY market found for ${awayAbbr}@${homeAbbr} (${todayStr}${tonightStr ? '/' + tonightStr : ''}) — skipping to avoid wrong-game bet`);
          continue;
        }

        console.log(`[live-edge] Sonnet analyzing: ${away.team?.displayName} (${awayAbbr}) ${awayScore} @ ${home.team?.displayName} (${homeAbbr}) ${homeScore} (${gameDetail})`);

        // Check BOTH sides — leading team AND trailing team (underdog value)
        const leadingAbbr = leading.team?.abbreviation ?? '';
        const trailing = homeScore > awayScore ? away : home;
        const trailingAbbr = trailing.team?.abbreviation ?? '';

        // Find markets for both teams
        // Find markets — check both ESPN and Kalshi abbreviation variants
        const leadMarket = gameMarkets.find(m => {
          const suffix = m.ticker?.split('-').pop()?.toUpperCase() ?? '';
          return suffix === leadingAbbr || suffix === (ABBR_MAP[leadingAbbr] ?? '');
        });
        const trailMarket = gameMarkets.find(m => {
          const suffix = m.ticker?.split('-').pop()?.toUpperCase() ?? '';
          return suffix === trailingAbbr || suffix === (ABBR_MAP[trailingAbbr] ?? '');
        });

        // Pick the better entry: leading team at cheap price OR trailing underdog at very cheap price
        const leadPrice = leadMarket ? parseFloat(leadMarket.yes_ask_dollars) : 1;
        const trailPrice = trailMarket ? parseFloat(trailMarket.yes_ask_dollars) : 1;

        // Default to leading team, but consider trailing if they're cheap enough (<40¢)
        let targetMarket = leadMarket;
        let targetAbbr = leadingAbbr;
        let targetTeam = leading;
        let price = leadPrice;

        // Sport-specific underdog rules — comebacks vary drastically by sport
        // NHL: low-scoring, 2-goal deficit is massive (15-20% comeback). EXACTLY down 1, period 1 only.
        // NBA: high-scoring, 15-pt comebacks happen 13%. Underdogs viable if down ≤10 in Q1-Q2.
        // MLB: mid-variance, 3-run comebacks happen 20% thru 6 innings. Down ≤2 thru inning 5.
        // Soccer: 1-goal deficits equalize ~20% of the time. Down 1 in 1st half only.
        let underdogAllowed = false;
        if (trailMarket && trailPrice >= 0.15 && trailPrice <= 0.35) {
          if (league === 'nhl' && diff === 1 && period === 1) underdogAllowed = true;  // EXACTLY 1 goal, EXACTLY P1
          else if (league === 'nba' && diff <= 10 && period <= 2) underdogAllowed = true;
          else if (league === 'mlb' && diff <= 2 && period <= 5) underdogAllowed = true;
          else if (['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league) && diff === 1 && period <= 1) underdogAllowed = true;
        }

        if (underdogAllowed) {
          const trailRec = trailing.records?.[0]?.summary ?? '';
          const leadRec = leading.records?.[0]?.summary ?? '';
          const parseWins = (rec) => parseInt(rec.split('-')[0]) || 0;
          const parseTotalGames = (rec) => rec.split('-').map(Number).reduce((a,b) => a+(isNaN(b)?0:b), 0);
          const trailWins = parseWins(trailRec);
          const leadWins = parseWins(leadRec);
          const trailTotal = parseTotalGames(trailRec);
          const trailWinPct = trailTotal > 0 ? trailWins / trailTotal : 0;
          // Trailing team must have significantly more wins (10+) AND a decent win rate (≥35%)
          // UTA@CGY at 29c: Utah had bad record — stop-losses proved it was a mistake
          if (trailWins > leadWins + 10 && trailWinPct >= 0.35) {
            targetMarket = trailMarket;
            targetAbbr = trailingAbbr;
            targetTeam = trailing;
            price = trailPrice;
            console.log(`[live-edge] 🐕 Underdog value (${league}): ${trailingAbbr} (${trailRec}) trailing ${leadingAbbr} (${leadRec}) by ${diff} at ${(trailPrice*100).toFixed(0)}¢`);
          }
        }

        if (!targetMarket) {
          console.log("[live-edge] No viable market for " + awayAbbr + "@" + homeAbbr + ": lead market at/above price ceiling");
          continue;
        }
        const title = targetMarket.title ?? '';

        console.log(`[live-edge] Found market: ${targetMarket.ticker} "${title}" ${targetAbbr} YES=$${price.toFixed(2)}`);

        // === ESPN-STALE GUARD ===
        // ESPN scoreboard often lags real scoring by 30-90s. Normal live-edge bets are 8-15pt
        // WE-vs-price gaps; those are the sweet spot. The tell for "ESPN stale" is a recent
        // CONTRA line-move on the leading team: market is actively moving against the lead
        // RIGHT NOW, which means price is absorbing a score the ESPN snapshot doesn't show yet.
        // Real case 2026-04-22: NHL DAL "2-0 P2" per ESPN @64¢ — MIN had just scored to 2-1,
        //   price was dropping, ESPN API snapshot was stale. We bet on a lead that no longer existed.
        if (targetMarket === leadMarket && diff >= 1 && _lineMove?.confirming === false) {
          const leadingIsHome = leading === home;
          const weLeadEspn = getWinExpectancy(league, diff, period, leadingIsHome) ?? 0;
          if (weLeadEspn > 0 && price > 0 && (weLeadEspn - price) >= 0.10) {
            console.log(`[live-edge] ⏸️ ESPN-stale guard: ${targetAbbr} priced ${(price*100).toFixed(0)}¢ vs ESPN-WE=${(weLeadEspn*100).toFixed(0)}% (${((weLeadEspn-price)*100).toFixed(0)}pt gap) + contra line-move — ESPN likely lagging a score. Skipping until sync.`);
            continue;
          }
        }

        // === BUILD RICH CONTEXT FROM ESPN DATA ===
        const homeRecord = home.records?.[0]?.summary ?? '';
        const awayRecord = away.records?.[0]?.summary ?? '';
        const homeHomeRec = home.records?.find(r => r.type === 'home')?.summary ?? '';
        const awayRoadRec = away.records?.find(r => r.type === 'road')?.summary ?? '';
        const homeIsLeading = leadingAbbr === homeAbbr;

        // Pitcher info (MLB)
        let pitcherInfo = '';
        if (league === 'mlb') {
          const situation = comp.situation ?? {};
          const pitcher = situation.pitcher;
          if (pitcher?.summary) {
            pitcherInfo = `Current pitcher: ${pitcher.athlete?.displayName ?? '?'} (${pitcher.summary})\n`;
          }
          // Probable/starting pitchers
          for (const c of [home, away]) {
            for (const p of c.probables ?? []) {
              const era = p.statistics?.find(s => s.abbreviation === 'ERA')?.displayValue ?? '?';
              const w = p.statistics?.find(s => s.abbreviation === 'W')?.displayValue ?? '?';
              const l = p.statistics?.find(s => s.abbreviation === 'L')?.displayValue ?? '?';
              pitcherInfo += `${c.team?.abbreviation} starter: ${p.athlete?.displayName ?? '?'} (${w}-${l}, ${era} ERA)\n`;
            }
          }
        }

        // Live situation (runners, outs, batter, last play)
        let situationInfo = '';
        const sit = comp.situation;
        if (sit) {
          const runners = [sit.onFirst && '1st', sit.onSecond && '2nd', sit.onThird && '3rd'].filter(Boolean);
          situationInfo = `Outs: ${sit.outs ?? '?'} | Runners: ${runners.length > 0 ? runners.join(', ') : 'none'}`;
          // Current batter (MLB)
          if (sit.batter?.athlete?.displayName) {
            situationInfo += ` | At bat: ${sit.batter.athlete.displayName} (${sit.batter.summary ?? ''})`;
          }
          // Last play for momentum context
          if (sit.lastPlay?.text) {
            situationInfo += `\nLast play: ${sit.lastPlay.text}`;
          }
        }

        // Active-threat gate (MLB only) — don't enter with runners on base + ≤1 out in innings 6+.
        // The market drop during an active at-bat threat is transient, not a real mispricing.
        // We lose ~6¢ of entry edge by waiting, but avoid buying at peak variance when a single
        // play can immediately invalidate the thesis. Wait for the inning to clear.
        if (league === 'mlb' && period >= 6 && sit) {
          const outs = sit.outs ?? 3;
          const runnersOn = (sit.onFirst ? 1 : 0) + (sit.onSecond ? 1 : 0) + (sit.onThird ? 1 : 0);
          const batterName = sit.batter?.athlete?.displayName ?? '';
          if (runnersOn >= 1 && outs <= 1) {
            console.log(`[live-edge] ⏳ Threat-wait: ${targetAbbr} — ${runnersOn} runner(s) on, ${outs} out(s), P${period}${batterName ? ` (${batterName} up)` : ''} — waiting for inning to clear before entry`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-active-threat', league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `Active threat: ${runnersOn} runner(s) on base, ${outs} out(s) in inning ${period} — market price is temporarily depressed by at-bat risk, not structural mispricing. Re-evaluates next cycle once inning resolves.` });
            continue;
          }
        }

        // Time remaining (critical for NBA/NHL — "3:21 in 2nd" vs just "2nd quarter")
        let timeRemaining = '';
        const statusDetail = comp.status?.type?.shortDetail ?? '';
        if (league === 'nba' || league === 'nhl') {
          timeRemaining = statusDetail; // ESPN gives "3:21 - 2nd" which includes time
        }

        // Team stats
        const homeAvg = home.statistics?.find(s => s.abbreviation === 'AVG')?.displayValue ?? '';
        const awayAvg = away.statistics?.find(s => s.abbreviation === 'AVG')?.displayValue ?? '';

        // NBA shooting stats
        let shootingInfo = '';
        let leadingFGNum = null;
        let trailingFGNum = null;
        if (league === 'nba') {
          const getStat = (team, abbr) => team.statistics?.find(s => s.abbreviation === abbr)?.displayValue ?? '';
          const homeFG = getStat(home, 'FG%');
          const awayFG = getStat(away, 'FG%');
          const home3P = getStat(home, '3P%');
          const away3P = getStat(away, '3P%');
          const homeFTA = getStat(home, 'FTA');
          const awayFTA = getStat(away, 'FTA');
          const homeReb = getStat(home, 'REB');
          const awayReb = getStat(away, 'REB');
          const homeAST = getStat(home, 'AST');
          const awayAST = getStat(away, 'AST');

          if (homeFG) {
            shootingInfo = `FG%: ${homeAbbr} ${homeFG}% | ${awayAbbr} ${awayFG}%`;
            if (home3P) shootingInfo += ` | 3P%: ${homeAbbr} ${home3P}% | ${awayAbbr} ${away3P}%`;
            shootingInfo += `\nRebounds: ${homeAbbr} ${homeReb} | ${awayAbbr} ${awayReb} | Assists: ${homeAbbr} ${homeAST} | ${awayAbbr} ${awayAST}`;
            if (homeFTA) shootingInfo += ` | FTA: ${homeAbbr} ${homeFTA} | ${awayAbbr} ${awayFTA}`;
            // Flag shooting dominance for Claude
            const homeFGn = parseFloat(homeFG) || 0;
            const awayFGn = parseFloat(awayFG) || 0;
            if (Math.abs(homeFGn - awayFGn) > 10) {
              const better = homeFGn > awayFGn ? homeAbbr : awayAbbr;
              shootingInfo += `\n⚠️ ${better} shooting significantly better (${Math.abs(homeFGn - awayFGn).toFixed(0)}% FG gap)`;
            }
            // Save numeric FG% to outer scope for the structural detector below.
            // Detector needs leading vs trailing perspective, so map by which team leads.
            if (leadingAbbr === homeAbbr) { leadingFGNum = homeFGn; trailingFGNum = awayFGn; }
            else if (leadingAbbr === awayAbbr) { leadingFGNum = awayFGn; trailingFGNum = homeFGn; }
          }
        }

        // Leading scorers (NBA)
        let leadersInfo = '';
        if (league === 'nba') {
          for (const c of [home, away]) {
            const pts = c.leaders?.find(l => l.name === 'points');
            if (pts?.leaders?.[0]) {
              const p = pts.leaders[0];
              leadersInfo += `${c.team?.abbreviation} top scorer: ${p.athlete?.displayName} ${p.displayValue}\n`;
            }
          }
        }

        // Line score
        const homeLineScore = (home.linescores ?? []).map(l => l.displayValue).join(' ');
        const awayLineScore = (away.linescores ?? []).map(l => l.displayValue).join(' ');

        // Get win expectancy baseline for this exact game situation
        const targetIsHome = targetAbbr === homeAbbr;
        const baselineText = getWinExpectancyText(league, diff, period, leadingAbbr === homeAbbr);
        // Pre-compute WE values for the calibration reminder in Step 4
        const _weRaw = getWinExpectancy(league, diff, period);
        const _weAdj = _weRaw != null ? Math.min(0.99, _weRaw + (leadingAbbr === homeAbbr ? 0.03 : -0.01)) : null;
        const _weTarget = _weAdj != null ? (targetAbbr === leadingAbbr ? _weAdj : (1 - _weAdj)) : null;
        const _weTargetPct = _weTarget != null ? (_weTarget * 100).toFixed(0) : null;

        // Time-within-period WE adjustment — the table gives period averages,
        // but 11:35 left in Q4 ≠ 1:30 left in Q4. Compute the correction and
        // pass BOTH raw and adjusted to Sonnet so it anchors on the right number.
        const _timeAdj = timeAdjustWE(league, period, gameDetail, diff);
        let _weTimeAdj = _weTarget != null ? Math.max(0.01, Math.min(0.99, _weTarget + _timeAdj.adjustment)) : null;

        // PLAYOFF ROAD-LEADER LATE-GAME PENALTY
        // Pattern seen across 4 recent losses (ANA-EDM, VGK-UTA, MTL-TB, BUF-BOS):
        // Road team holding a ≤1-goal/run/pt lead entering the final frame of a playoff game
        // is systematically overrated by the WE table. Home crowd + star talent + urgency is
        // a real tailwind for the trailing home team that the period-average anchor misses.
        const _isPlayoff = /Game \d/i.test(targetMarket?.title ?? '');
        const _targetIsRoadLeader = targetAbbr === leadingAbbr && targetAbbr !== homeAbbr;
        const _lateFrame = (league === 'nhl' && period >= 3)
                       || (league === 'nba' && period >= 4)
                       || (league === 'mlb' && period >= 8);
        if (_isPlayoff && _targetIsRoadLeader && diff <= 1 && _lateFrame && _weTimeAdj != null) {
          const before = _weTimeAdj;
          _weTimeAdj = Math.max(0.01, _weTimeAdj - 0.04);
          console.log(`[we-penalty] 🏒 PLAYOFF-ROAD-LEADER: ${targetAbbr} away ≤1 lead late ${league.toUpperCase()} playoff — WE ${(before*100).toFixed(0)}%→${(_weTimeAdj*100).toFixed(0)}% (home crowd/urgency tailwind)`);
        }
        const _weTimeAdjPct = _weTimeAdj != null ? (_weTimeAdj * 100).toFixed(0) : null;

        // MLB bullpen context — pulled from the MLB Stats API, not web search.
        // Gives us authoritative season/L30D/L7D bullpen ERA for both teams
        // so the prompt no longer has to say "search for bullpen ERA" and
        // Sonnet never Hard-NOs because data was unretrievable.
        let bullpenContext = '';
        let leadingBullpenTier = 'unknown';
        if (league === 'mlb') {
          try {
            const [leadStats, trailStats] = await Promise.all([
              getBullpenStats(leadingAbbr),
              getBullpenStats(leadingAbbr === homeAbbr ? awayAbbr : homeAbbr),
            ]);
            leadingBullpenTier = bullpenTier(leadStats);
            logBullpenLookup(leadingAbbr, leadStats, leadingBullpenTier);
            const leadLine = formatBullpenLine(leadingAbbr, leadStats);
            const trailLine = formatBullpenLine(leadingAbbr === homeAbbr ? awayAbbr : homeAbbr, trailStats);
            if (leadLine || trailLine) {
              bullpenContext =
                `\n═══ BULLPEN ═══ (from MLB Stats API — authoritative)\n` +
                (leadLine ? `${leadLine}\n` : '') +
                (trailLine ? `${trailLine}\n` : '') +
                `Tier (leading team, L30D or season fallback): ${leadingBullpenTier}\n`;
            }
          } catch (e) {
            console.log(`[live-edge] bullpen fetch error for ${leadingAbbr}: ${e.message}`);
          }
        }

        // Soccer: extract team-specific draw rates from records (W-D-L format)
        let soccerDrawWarning = '';
        if (isSoccer) {
          const parseDrawRate = (record) => {
            const parts = record.split('-').map(Number);
            if (parts.length >= 3) {
              const [w, d, l] = parts;
              const total = w + d + l;
              if (total > 0) return { draws: d, total, rate: d / total };
            }
            return null;
          };
          const targetRecord = targetAbbr === homeAbbr ? homeRecord : awayRecord;
          const drawData = parseDrawRate(targetRecord);
          if (drawData && drawData.rate > 0.30) {
            soccerDrawWarning = `\n═══ CRITICAL DRAW WARNING ═══\n` +
              `${targetAbbr} has drawn ${drawData.draws} of ${drawData.total} games this season (${(drawData.rate*100).toFixed(0)}% draw rate).\n` +
              `This is MUCH higher than average (25-28%). A DRAW means this contract LOSES.\n` +
              `You MUST reduce your WIN probability significantly — if this team draws ${(drawData.rate*100).toFixed(0)}% of games,\n` +
              `even a 1-goal lead at 70' is probably only 35-45% WIN (not the 65-78% baseline).\n` +
              `DO NOT bet if your adjusted WIN probability is below 65%.\n`;
          } else if (drawData) {
            soccerDrawWarning = `\n${targetAbbr} draw rate: ${drawData.draws}/${drawData.total} games (${(drawData.rate*100).toFixed(0)}%). Remember: draw = contract LOSES.\n`;
          }
        }

        const livePrompt =
          (isSwingMode
            ? `You are a professional sports bettor evaluating a SWING TRADE — we buy now and sell at +12¢, with a -10¢ stop. We do NOT need this team to win the game, just to extend or protect their lead long enough for one price tick upward.\n\n` +
              `Our WE baseline is historically calibrated for this exact game state (sport, lead size, period). If the market deviates from WE by 8+ points, that IS the edge — treat it as real. DEFAULT: YES when |WE − price| ≥ 8pt. Reject only for specific concrete factors not already in the data above: active scoring threat in progress, confirmed injury just announced, roster change, red card, 5-on-3. "The market has more info than us" is NOT a reason — we have the same public box score plus a trained WE model. Smart bettors take the edge; market-takers stay broke.\n\n`
            : `You are a professional sports bettor. Our WE baseline comes from historical outcomes at this exact score/period — it is the best probability estimate available, not the market's.\n\n` +
              `If WE ≥ price + 6pt, DEFAULT: YES. The burden is on justifying a NO with a specific concrete factor not already in the data above (active threat, just-announced injury, lineup change, power play). Do NOT reject on vague "market knows something" — that reflex is how you miss every real edge. Your job is to evaluate risk factors, not defer to the market.\n\n`
          ) +
          `═══ LIVE ${league.toUpperCase()} GAME ═══\n` +
          `${away.team?.displayName} (${awayRecord}${awayRoadRec ? ', ' + awayRoadRec + ' away' : ''}) ${awayScore}\n` +
          `  at\n` +
          `${home.team?.displayName} (${homeRecord}${homeHomeRec ? ', ' + homeHomeRec + ' home' : ''}) ${homeScore}\n\n` +
          `Status: ${gameDetail}\n` +
          `Line score: ${awayAbbr} [${awayLineScore}] | ${homeAbbr} [${homeLineScore}]\n` +
          (situationInfo ? `Situation: ${situationInfo}\n` : '') +
          (pitcherInfo ? `\n${pitcherInfo}` : '') +
          (homeAvg || awayAvg ? `Team batting: ${homeAbbr} ${homeAvg} | ${awayAbbr} ${awayAvg}\n` : '') +
          (shootingInfo ? `${shootingInfo}\n` : '') +
          (leadersInfo ? `${leadersInfo}` : '') +
          (timeRemaining && timeRemaining !== gameDetail ? `Time: ${timeRemaining}\n` : '') +
          bullpenContext +
          `\n═══ ${baselineText} ═══\n` +
          soccerDrawWarning +
          `\n═══ MARKET ═══\n` +
          `${targetAbbr} YES @ ${(price*100).toFixed(0)}¢ (market thinks ${(price*100).toFixed(0)}% chance)\n` +
          `${targetAbbr === leadingAbbr ? '(LEADING team' : '(TRAILING team — underdog'}${targetIsHome ? ', HOME)' : ', AWAY)'}\n` +
          (_lineMove?.confirming === true  ? `📈 LINE MOVEMENT (CONFIRMING${_lineMove.crossConfirmed ? ', CROSS-CONFIRMED' : ''}): Market moved TOWARD ${targetAbbr}: ${(_lineMove.from*100).toFixed(0)}¢ → ${(_lineMove.to*100).toFixed(0)}¢ in ${_lineMove.minutesAgo}min (${(_lineMove.velocity ?? 0).toFixed(1)}¢/min). Market agrees — edge window closing.\n` : '') +
          (_lineMove?.confirming === false ? `⚠️ CONTRA LINE MOVEMENT: Market moved AGAINST ${targetAbbr}: ${(_lineMove.from*100).toFixed(0)}¢ → ${(_lineMove.to*100).toFixed(0)}¢ in ${_lineMove.minutesAgo}min (${(_lineMove.velocity ?? 0).toFixed(1)}¢/min). Investigate why before betting — possible injury, scoring run, or news.\n` : '') +
          `\n═══ STEP 0 — MARKET EFFICIENCY GATE (CHECK FIRST) ═══\n` +
          (_weTimeAdjPct != null && _weTimeAdjPct !== _weTargetPct
            ? `The WE baseline is ${_weTargetPct}% (period average) → **${_weTimeAdjPct}%** (adjusted for ${_timeAdj.label}). USE ${_weTimeAdjPct}% as your anchor — the period average overstates early-period situations.\n`
            : `The WE baseline is ${_weTargetPct != null ? _weTargetPct + '%' : 'computed'} for ${targetAbbr}.\n`) +
          `Market price is ${(price*100).toFixed(0)}¢. Edge = adjusted WE% − price%. If |edge| < 2 points → respond {"trade":false} immediately with reason "market efficient". If edge is 2-3 points, DO NOT reject yet — proceed to Step 1 research; a starter/goalie/lineup finding can often add the missing points of edge (downstream margin+confidence gates still enforce quality).\n\n` +
          `═══ STEP 1 — WORK FROM THE DATA ABOVE ═══\n` +
          `No web search in live-edge. The ESPN game state, score, line score, pitcher/bullpen block, and line-movement info above are your only inputs. Treat unavailable stats as neutral (no penalty, no Hard NO) — "cannot confirm" is NEVER a reason to reject. Only the Hard NOs in Step 2 block a trade.\n` +
          (league === 'mlb' && leadingBullpenTier !== 'unknown'
            ? `MLB bullpen tier for leading team: ${leadingBullpenTier} (from MLB Stats API above — authoritative, do not second-guess).\n\n`
            : '\n') +
          `═══ STEP 2 — HARD NOs (if ANY apply, respond {"trade":false} immediately) ═══\n` +
          (league === 'nba' ? `❌ Leading team is resting 3+ key players tonight (confirmed load management, not just lineup rotation) → NO. This is NBA-specific — in the NBA, 3 resters = a fundamentally different team's talent level.\n` : '') +
          (league !== 'nba' ? `❌ Leading team has confirmed ≥3 STAR players ruled out tonight (not just backups or rotation) → NO. Routine rotation/rest does NOT qualify.\n` : '') +
          `❌ Trailing team is in active playoff survival (must win or season ends) AND the leading team is confirmed to be resting multiple starters OR rotating their lineup tonight → NO. NOTE: "already eliminated" alone is NOT enough — eliminated teams often still play hard for pride/contracts. The roster decision is the signal, not the standings.\n` +
          (league === 'nba' ? `❌ NBA STAR-FOUL HARD NO: Leading team's top scorer (highest PPG on roster) has 5 personal fouls AND period ≥ 3 AND lead ≤ 10 pts → NO. Check a live box score in your search. 5 fouls means he's either pinned to the bench or must play cautious on defense — that's a 10-15pt WE swing not captured by our baseline.\n` : '') +
          (isSoccer ? `❌ SOCCER LATE-DRAW HARD NO: Leading team's season draw rate > 35% AND lead = 1 goal AND minute ≥ 75 → NO. Draw-prone teams protecting a 1-0 late don't win — they draw, which loses a YES on the WIN contract.\n` : '') +
          (league === 'nhl' && targetAbbr === leadingAbbr
            ? `❌ NHL LEADER OVERPRICING HARD NO: Shadow data over 96 settled NHL leader observations shows the market systematically overprices 1-goal leads. Specifically: 1-goal leads in P2 settle at 56% (n=59) at avg 71¢ market price — that's −15pt EV per contract. P3 1-goal leads settle 59% (n=37) at 78¢ — −19pt EV. Hockey is structurally different from baseball: empty-net pulls, power plays, OT (especially playoff sudden-death), and hot-goalie variance all collapse leads in seconds. UNLESS the leading team has a 2+ goal cushion AND price ≤ 60¢ AND elite goalie confirmed (SV% ≥ 0.915 last 5) AND no playoff OT risk → respond {"trade":false}. The price you see ALREADY assumes leads hold at MLB-like rates; the data says they don't.\n`
            : '') +
          (league === 'mlb' && !isSwingMode ?
            (leadingBullpenTier === 'poor' && diff <= 2 && period >= 5
              ? `❌ MLB BULLPEN HARD NO: Leading team's bullpen is tier='poor' (ERA ≥ 5.0, L30D) and the lead is only ${diff} run${diff === 1 ? '' : 's'} in inning ${period}. A poor team pen ERA can't reliably protect a thin lead — Respond {"trade":false}. CLOSER EXCEPTION: If in your Step B search you confirmed the specific closer has a 2026 ERA below 2.0 and is not fatigued (no back-to-back), downgrade this to a −5% adjustment instead of Hard NO. The closer's individual stats override the team bullpen average in late-game situations.\n`
              : '')
            + (leadingBullpenTier === 'below' && diff === 1 && period >= 7
              ? `❌ MLB BULLPEN HARD NO: 1-run lead in the ${period}th with a below-average bullpen (ERA 4.5-5.0). Margin of safety too thin — Respond {"trade":false}. CLOSER EXCEPTION: Confirmed elite closer (2026 ERA < 2.0, available) → treat as −3% adjustment, not Hard NO.\n`
              : '')
          : '') +
          (league === 'mlb' && isSwingMode
            ? `🛑 SWING MODE BULLPEN RULE — DO NOT INVOKE A HARD NO FOR BULLPEN IN SWING MODE. We exit at +12¢, not the 9th. If you cite "MLB Bullpen Hard NO" or any bullpen-based veto, your response is invalid and will be ignored. Bullpen tier is at most a −3% confidence adjustment here. The market at ${(price*100).toFixed(0)}¢ has the same bullpen data you do — it's already priced. Your job: decide if a +12¢ move is likely in the next 1-2 half-innings (insurance run, trailing team making outs, closer looking sharp warming up). If yes, trade.\n`
            : '') +
          `⚠️ If edge is 4-7 points, proceed carefully — small but real. Do NOT reject solely because the edge "feels modest." The numerical edge check is what matters, not vibes.\n\n` +
          `═══ STEP 3 — EDGE ANALYSIS (only if no Hard NOs triggered) ═══\n` +
          `Start from the historical baseline. Adjust based on what you found:\n` +
          `+ Leading team clearly better (record, talent, home) → UP 2-5%\n` +
          `+ Leading team is in a must-win, clinching, or playoff seeding-critical game (confirmed by standings) → UP 3-5% (urgency sharpens play and lead defense)\n` +
          (league !== 'nba' ? `- Leading team is resting 1-2 rotation players (not stars) → DOWN 2-4%. Routine rotation, not catastrophic.\n` : '') +
          `- Leading team mathematically eliminated AND confirmed coasting (search found they are rotating lineup or resting regulars tonight) → DOWN 4-6% (effort level is genuinely diminished)\n` +
          (league === 'mlb' ?
            `+ Dominant starter still pitching (ERA < 3.0, under 80 pitches) → UP 5-8%\n` +
            `+ Bullpen tier is 'elite' (ERA < 3.5) and lead is 1-3 runs → UP 3-5%\n` +
            `+ Bullpen tier is 'good' (3.5-4.0) → UP 1-2%\n` +
            `+ Confirmed elite closer (ERA < 2.0, available) even if team pen tier is 'poor' or 'below' → UP 2-3% (closer ERA is what matters in the 9th, not the whole pen's average)\n` +
            `- Bullpen tier is 'below' (4.5-5.0) AND lead is 1-2 runs → DOWN 3-5%\n` +
            `- Bullpen tier is 'poor' (≥5.0) AND lead is 3+ runs → DOWN 2-3% (not a Hard NO at this lead size, but real risk)\n` +
            `- Starter at 80+ pitches — bullpen transition coming, weight by bullpen tier above → DOWN 3-5%\n` +
            `⚠️ BULLPEN RULE: These are confidence ADJUSTMENTS, not vetoes. If no Hard NO fired in Step 2, a poor bullpen reduces your confidence number — it does NOT disqualify the trade. Repeatedly seeing a bad bullpen ERA and refusing to bet is wrong: the WE baseline already accounts for average bullpen performance, and the market has the same bullpen data you do. Your edge comes from mismatches between WE and market price, not from deciding the game is "too risky."\n` +
            `⚠️ INNING HALF: The "Status" line shows "Top" (away batting) or "Bot" (home batting). If the trailing team is batting RIGHT NOW, you're at maximum live risk — a single run ties it and the price will collapse before the next bot cycle (60s). Do not enter mid at-bat with runners on base unless edge is very large. If it says "Mid" or "End", the half-inning is over — the immediate scoring threat has passed.\n` +
            `- SITUATION ALERT: Check the "Situation" line above. Runners in scoring position (2nd or 3rd) with 0-1 outs for the TRAILING team → DOWN 6-10%. This is live — a single or sac fly ties or cuts the lead immediately.\n` +
            `- BATTING ORDER ALERT: The "At bat" line shows the current batter. Search "[batter name] batting order [team] 2025" to determine lineup position. Cleanup hitters (3-4-5) at the plate with runners on = HIGH danger. Leadoff/bottom-order hitters (1-2, 7-9) at the plate = lower threat. A #4 hitter with runners on is 2-3x more dangerous than a #8 hitter in the same situation.\n` +
            `- POWER HITTER ALERT: If trailing team has 25+ HR hitters coming up WITH RUNNERS ON BASE → DOWN 5-8%. A 3-run HR erases any lead in one pitch. This is the single biggest MLB risk.\n` +
            `- HIGH-RUN PARK (Coors Field, Great American Ballpark, Globe Life Field) → reduce lead confidence 3-5%. Runs come easier; leads evaporate faster.\n`
          : league === 'nba' ?
            `+ Star player dominating (25+ pts, efficiency up) → UP 3-5%\n` +
            `+ Opponent is tanking/resting (eliminated, trading players, nothing to play for) → UP 5-8%\n` +
            `- Trailing team star player getting hot (last 2 quarters) → DOWN 3-6%\n` +
            `- Leading team on second game of back-to-back → DOWN 2-4%\n` +
            `- 15-pt comebacks happen 13% in the 3-point era. 10-pt leads in Q3 are NOT safe. Only Q4 10-pt leads are reliable (86% WE).\n` +
            `⚠️ FOUL TROUBLE (Q3/Q4 only): If the leading team's best player has 4+ fouls, they will likely sit at the start of Q4 to avoid fouling out. That changes the entire game plan. Check a live box score in your search results if available — foul trouble on a star player → DOWN 4-6%.\n` +
            `📍 Q4 TIME CONTEXT: The time-adjusted WE above already accounts for how much of Q4 remains — use it, not the raw period average. Under 90s with a 10pt+ lead: game is nearly sealed, +3% above adjusted is OK. Under 90s with a 5pt lead: still dangerous, a quick foul sequence can still flip it.\n` +
            `⚠️ SLUMP/RETURN WARNING: If you are tempted to call a team "in bad form," first confirm their key players were healthy during that stretch. A team returning stars from injury tonight has a RESET baseline — their recent results without those players do not predict tonight's performance.\n`
          : league === 'nhl' ?
            `+ 2-goal lead (any period): much more reliable than 1-goal. 2-goal P3 = 93% WE. Trust the math.\n` +
            `+ Elite goalie (SV% > .920) → UP 3-5%\n` +
            `- Leading goalie SV% .895-.910 → DOWN 4-6%\n` +
            `- OT RISK (1-goal lead in P3): The time-adjusted WE above already reduces for early-P3 situations. For 1-goal leads ALSO consider: OT is NOT a coin flip — team OT win rates span 29% to 60%+. Search "[team] NHL OT record 2024-25" before finalizing confidence. Elite OT teams (60%+) justify less reduction; poor OT teams (29%) justify more. Under 2 min P3 with 1-goal lead, also search "[trailing team] shootout record 2024-25".\n` +
            `- Trailing team on power play right now → DOWN 8-12% until it's resolved\n`
          : `+ Strong home record for leading team → UP 2-3%\n` +
            `- DRAWS happen 24-30% of games. 1-goal lead means draw is still very possible. Draw = contract LOSES.\n` +
            `- Red card on YOUR team → DOWN 25-30%\n`
          ) +
          `- Trailing team is significantly better (record, talent) → DOWN 4-8%\n` +
          `- Trailing team has momentum (just scored) → DOWN 3-5%\n` +
          `- H2H: trailing team won 7-9 of last 15 → DOWN 3-5%. Won 10+ of last 15 → DOWN 6-8% (strong signal but not automatic NO — SJ held off NSH despite H2H deficit).\n` +
          (league === 'nhl' ? `- Leading goalie SV% .885-.895 → DOWN 6-8% (bad but not automatic NO — bad goalies still hold leads sometimes)\n` : '') +
          `- Leading team win rate below 35% → DOWN 6-10% (weak teams protect leads less reliably)\n` +
          `- Trailing team is at HOME with loud playoff/crucial crowd → DOWN 3-5% (home crowd lifts desperate teams)\n` +
          `- Time remaining: 3 min left with a lead ≠ 10 min left with same lead. Adjust accordingly.\n\n` +
          `⚠️ STEP 3 IS NOT OPTIONAL — see the STEP 3 ENFORCEMENT block in the universal rules at the top. Apply each DOWN adjustment with explicit numeric value in your reasoning.\n\n` +
          `═══ STEP 3.5 — MARKET CHECK ═══\n` +
          `The market is ${(price*100).toFixed(0)}¢. Briefly consider: is there a SPECIFIC concrete reason the market is lower than your estimate?\n` +
          `Look for: confirmed injury news, lineup change, weather, rest day, goalie switch — something factual.\n` +
          `If you can identify a specific reason, adjust your confidence for it. If you CANNOT identify a concrete reason, trust your analysis — prediction markets on Kalshi are thin and often lag real game state by 1-3 minutes. The gap IS the edge.\n` +
          `Do NOT invent hypothetical reasons to explain the gap. "The market must know something" without naming WHAT is not analysis.\n\n` +
          (getCalibrationFeedback() ? `═══ YOUR TRACK RECORD ═══\n${getCalibrationFeedback()}\n` : '') +
          getReasoningTagFeedback() +
          `═══ STEP 4 — DECISION ═══\n` +
          (isSwingMode
            ? `⚠️ SWING TRADE MODE: This is a swing trade — we exit at +12¢ profit, NOT hold to settlement.\n` +
              `Focus on SHORT-TERM price momentum: will this team extend their lead or maintain it long enough for a 12¢ price spike?\n\n` +
              `BUY only if ALL are true:\n` +
              `✓ Confidence ≥ 68% that the price will rise 12¢+ within the next 1-2 periods\n` +
              `✓ Entry price ≤ 65¢ (we need room for the price to spike)\n` +
              `✓ You can name a specific near-term catalyst (pitcher cruising, team on a run, power play coming)\n` +
              `✓ The lead is likely to hold or grow in the next 15-30 minutes\n` +
              `🎯 EDGE-FIRST HALF-SIZE EXCEPTION: If price is 50-55¢ AND your honest confidence is 63-67% AND edge (confidence − price) is ≥ 10pt, return {"trade":true} with your real confidence. The bot auto-sizes half and uses the +12¢ exit. Do NOT write "does not clear 68%" as a reason to pass — the edge-first rule IS the gate. Your reasoning gets stored for calibration; keep it consistent with your decision.\n`
            : (_weTimeAdjPct != null
              ? `⚠️ CALIBRATION CHECK: Time-adjusted WE = ${_weTimeAdjPct}% for ${targetAbbr}${_weTimeAdjPct !== _weTargetPct ? ` (period average was ${_weTargetPct}%, adjusted for ${_timeAdj.label})` : ''}. Your final confidence must be within 6 points of the TIME-ADJUSTED number — not the period average. If it's not, name the single specific confirmed fact that justifies the deviation. "They're the better team" does not count.\n\n`
              : _weTargetPct != null ? `⚠️ CALIBRATION CHECK: WE = ${_weTargetPct}% for ${targetAbbr}. Your final confidence must be within 8 points of this number.\n\n` : '') +
            `BUY only if ALL three are true:\n` +
            `✓ Confidence ≥ 65%\n` +
            `✓ Confidence beats price by 3+ points for late-game strong leads (WE ≥ 80%, inning 7+ / P3 / Q4). 4+ points required for early game (Q1/P1/innings 1-5) or marginal leads under 80% WE.\n` +
            `✓ You have CLEAR conviction. If you had to talk yourself into it, say NO.\n`
          ) +
          `${targetAbbr !== leadingAbbr ? `⚠️ UNDERDOG BET — HARD CAPS (non-negotiable):\n` +
            `  • Your confidence CANNOT exceed ${league === 'nhl' ? '58' : league === 'nba' ? '60' : league === 'mlb' ? '58' : '55'}% regardless of team quality.\n` +
            `  • Historical comeback rate for this deficit/time is the anchor — team records add AT MOST +10% above it.\n` +
            `  • If the price is already reflecting smart money, you have NO edge — say NO.\n` +
            `  • If you cannot name ONE specific, verifiable fact (not "they're the better team") that overrides the deficit — say NO.\n` : ''}` +
          `Max bet: $${getDynamicMaxTrade().toFixed(2)}\n\n` +
          `═══ DECIDE NOW ═══\n` +
          `Apply Steps 0-4 above and the universal rules from the top of this prompt (response format + steel-man resolution + Step 3 enforcement). Respond with valid JSON in the schema specified at the top.`;
        // Block if we already have a position on this game (check BOTH platforms)
        const ticker = targetMarket.ticker;
        const lastH = ticker.lastIndexOf('-');
        const gameBase = lastH > 0 ? ticker.slice(0, lastH) : ticker;
        const ha = homeAbbr.toLowerCase();
        const aa = awayAbbr.toLowerCase();

        // Check BOTH Kalshi portfolio AND today's JSONL trades for this game.
        // The portfolio API can miss positions (closed-manual sync), so JSONL is the source of truth.
        // This also prevents betting BOTH sides (pre-game bet on team A, live bet on team B).
        let hasPosition = openPositions.some(p => {
          const pt = (p.ticker ?? '').toLowerCase();
          const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
          if (pBase === gameBase) return true;
          if (p.exchange === 'polymarket' && tickerHasTeam(pt, homeAbbr) && tickerHasTeam(pt, awayAbbr)) return true;
          return false;
        });

        // Also check JSONL for ANY trade today on this game — ANY status (open, closed-manual,
        // settled, sold-*). This prevents the critical bug where a pre-game bet on Team A
        // (later marked closed-manual) was invisible to the live-edge check, allowing the
        // bot to bet Team B on the SAME game. Never bet both sides of a game.
        //
        // The old code had `if (jt.status !== 'open') continue;` which skipped closed-manual
        // trades. That's what let the ORL pre-game + PHI live double-entry happen.
        // Track pre-game position state for the partial-position logic below.
        // If we have an open pre-game bet and have already taken ≥50% profit,
        // the live-edge is allowed to add a fresh same-direction bet up to the game cap.
        let pgPositionFraction = 1.0; // assume full position until we find otherwise
        let pgPositionTeam = null;
        let journalExited = false; // true if journal shows a trade on this game was sold/stopped

        if (!hasPosition && existsSync(TRADES_LOG)) {
          try {
            const dupStartMs = new Date(etNow().toISOString().slice(0,10) + 'T04:00:00Z').getTime();
            const dupEndMs = dupStartMs + 24 * 60 * 60 * 1000;
            const jLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
            for (const l of jLines) {
              try {
                const jt = JSON.parse(l);
                if (jt.status === 'testing-void') continue;
                const jtMs = jt.timestamp ? Date.parse(jt.timestamp) : 0;
                if (jtMs < dupStartMs || jtMs >= dupEndMs) continue;
                const jticker = (jt.ticker ?? '').toLowerCase();
                // Sport-prefix guard: same-day MLS DAL vs NHL DAL are different games — don't
                // let an MLS stop-loss journal entry mark the NHL version as "exited/clear".
                if (!jticker.toUpperCase().startsWith(series)) continue;
                if (tickerHasTeam(jticker, homeAbbr) && tickerHasTeam(jticker, awayAbbr)) {
                  // Fully exited positions (sold/stopped) are off the exchange — don't block new entries.
                  // Only open and closed-manual (may still be physically on exchange) should block.
                  if (jt.status !== 'open' && jt.status !== 'closed-manual') {
                    journalExited = true;
                    console.log(`[live-edge] ℹ️ Journal shows exited trade on ${homeAbbr}@${awayAbbr} (status: ${jt.status}) — position closed, not blocking`);
                    break;
                  }
                  // For pre-game positions, check how much is still open.
                  // partialTakeAt means we've already taken ≥50% profit —
                  // in that case allow a fresh same-direction live entry up to game cap.
                  if ((jt.strategy === 'pre-game-prediction' || jt.strategy === 'pre-game-edge-first') && jt.status === 'open') {
                    const tookPartial = !!(jt.partialTakeAt);
                    pgPositionFraction = tookPartial ? 0.5 : 1.0;
                    pgPositionTeam = (jt.ticker ?? '').split('-').pop()?.toUpperCase() ?? null;
                  }
                  hasPosition = true;
                  break;
                }
              } catch {}
            }
          } catch {}
        }

        // Check paper/real pre-game trades for same-game conflict.
        // In PAPER mode: log only (calibration signal — no real money at stake).
        // In LIVE mode: block live-edge from betting the other side of an active pre-game position.
        if (!hasPosition && existsSync(PAPER_TRADES_LOG)) {
          try {
            const pgDupStartMs = new Date(etNow().toISOString().slice(0,10) + 'T04:00:00Z').getTime();
            const pgDupEndMs = pgDupStartMs + 24 * 60 * 60 * 1000;
            const paperLines = readFileSync(PAPER_TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
            for (const l of paperLines) {
              try {
                const pt = JSON.parse(l);
                const ptMs = pt.timestamp ? Date.parse(pt.timestamp) : 0;
                if (ptMs < pgDupStartMs || ptMs >= pgDupEndMs) continue;
                const pticker = (pt.ticker ?? '').toLowerCase();
                if (tickerHasTeam(pticker, homeAbbr) && tickerHasTeam(pticker, awayAbbr)) {
                  // Starter-conflict deferred trades are NOT real money — the pre-game bet
                  // was blocked because the starting pitcher was uncertain. Once the game is
                  // live, the starter identity is confirmed in the boxscore, so the live-edge
                  // should evaluate freely on its own merits without the pre-game block.
                  if (pt.starterConflict) {
                    console.log(`[live-edge] ℹ️ Conflict-deferred paper trade for ${homeAbbr}@${awayAbbr} — pre-game starter was uncertain, live-edge evaluating freely`);
                    break;
                  }
                  const paperTeam = (pt.teamAbbr ?? pt.ticker?.split('-').pop() ?? '?').toUpperCase();
                  if (paperTeam !== targetAbbr?.toUpperCase()) {
                    if (PREGAME_LIVE && !journalExited) {
                      // Real pre-game position still open on the other side — block the live bet
                      hasPosition = true;
                      console.log(`[live-edge] 🚫 BLOCKED: pre-game bet on ${paperTeam}, live-edge wants ${targetAbbr} on same game — refusing both-sides bet`);
                    } else if (PREGAME_LIVE && journalExited) {
                      console.log(`[live-edge] ✅ Pre-game ${paperTeam} position was already exited (stop-loss/sold) — ${targetAbbr} side is clear for entry`);
                    } else {
                      console.log(`[live-edge] ⚠️ PAPER/LIVE CONFLICT on ${homeAbbr}@${awayAbbr}: paper pre-game picked ${paperTeam}, live-edge favoring ${targetAbbr} — proceeding (paper is not real money)`);
                    }
                  } else {
                    console.log(`[live-edge] ✅ PRE-GAME/LIVE AGREE on ${homeAbbr}@${awayAbbr}: both favor ${targetAbbr} — conviction confirmed`);
                  }
                  break;
                }
              } catch {}
            }
          } catch {}
        }

        // Block if we already have a position on this game — prevents duplicate buys and both-sides bets.
        // Exception: if a pre-game position has already taken ≥50% profit (partial exit done),
        // allow a fresh same-direction live entry up to the game exposure cap.
        // Swing mode: NO scale-in, NO escalation — hard block if any position exists.
        const currentScoreKey = scoreKey(homeScore, awayScore);
        if (isSwingMode && hasPosition) {
          console.log(`[live-swing] BLOCKED ${targetAbbr}: already have position on ${homeAbbr}@${awayAbbr} — no escalation for swing trades`);
          continue;
        }
        if (hasPosition) {
          const isSameDirection = pgPositionTeam && pgPositionTeam === targetAbbr?.toUpperCase();
          const partialExitDone = pgPositionFraction <= 0.5;
          if (isSameDirection && partialExitDone) {
            // Pre-game position is <50% remaining and live-edge agrees on direction.
            // Allow a fresh live entry — treat as a new position up to game cap.
            console.log(`[live-edge] ♻️ Pre-game partial exit done (≤50% remaining) + live agrees on ${targetAbbr} — allowing fresh live entry up to game cap`);
            hasPosition = false; // clear block so trade proceeds normally below
          } else if (!canScaleInto(gameBase, price, 0, currentScoreKey)) {
            const existingEntry = gameEntries.get(gameBase);
            const scoreChanged = existingEntry?.lastScoreKey && currentScoreKey && existingEntry.lastScoreKey !== currentScoreKey;
            const reason = scoreChanged
              ? `score changed since last entry (${existingEntry.lastScoreKey} → ${currentScoreKey}) — not averaging down on deteriorated thesis`
              : `scale-in conditions not met at ${(price*100).toFixed(0)}¢ (need ≥4¢ price improvement + unchanged score)`;
            console.log(`[live-edge] Already have position on ${homeAbbr}@${awayAbbr}, skipping: ${reason}`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-has-position', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, reasoning: `Already holding a position on ${homeAbbr}@${awayAbbr} — ${reason}` });
            continue;
          } else {
            console.log(`[live-edge] 📈 Scale-in: ${homeAbbr}@${awayAbbr} price dropped to ${(price*100).toFixed(0)}¢ (score ${currentScoreKey} unchanged)`);
          }
        }

        // Single-game re-entry cap — protect against falling-knife cluster losses.
        // Real case 2026-04-22 NHL DAL@MIN: 3 stacked entries (67¢, 65¢, 64¢) all stopped
        // simultaneously at 24¢ for −$20.72 total. Each entry passed "more edge!" logic
        // while the actual thesis was dying. Cap at 2 per game. Entry #2 half-size.
        const reentryCount = gameEntries.get(gameBase)?.count ?? 0;
        let reentryHalfSize = false;
        if (reentryCount >= 2) {
          console.log(`[live-edge] BLOCKED ${targetAbbr}: ${reentryCount} entries already on ${homeAbbr}@${awayAbbr} — single-game cap reached (max 2)`);
          logScreen({ stage: 'live-edge-skip', result: 'skip-reentry-cap', ticker, league, homeAbbr, awayAbbr, reasoning: `${reentryCount} entries already on this game — single-game re-entry cap reached (max 2)` });
          continue;
        }
        if (reentryCount >= 1) {
          reentryHalfSize = true;
          console.log(`[live-edge] ℹ️ Re-entry #${reentryCount + 1} on ${homeAbbr}@${awayAbbr} — half-sizing for cluster risk`);
        }

        // Smart cooldown: base 5min between new entries (use gameBase as canonical key)
        const timeSinceLastTrade = Date.now() - (tradeCooldowns.get(gameBase) ?? 0);
        if (timeSinceLastTrade < COOLDOWN_MS && !hasPosition) {
          continue; // within cooldown and no existing position to scale into
        }

        // Post-swing-exit re-entry gate: if we just exited this game on a swing
        // (stop/expiry/profit-lock) within the last 20 min, require genuinely
        // new state before allowing re-entry. Prevents chasing the same dead
        // thesis scan after scan.
        {
          const recentExit = swingExitState.get(gameBase);
          if (recentExit && Date.now() - recentExit.ts < 20 * 60 * 1000) {
            const nowScoreKey = `${homeScore}-${awayScore}`;
            const scoreChanged = recentExit.scoreKey && recentExit.scoreKey !== nowScoreKey;
            const priceBetter = price <= (recentExit.exitPrice - 0.05); // 5¢ cheaper
            if (!scoreChanged && !priceBetter) {
              logScreen({ stage: 'live-edge-skip', result: 'skip-post-swing-exit', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, reasoning: `Recent swing ${recentExit.reason} exit at ${Math.round(recentExit.exitPrice*100)}¢ on score ${recentExit.scoreKey}. Blocking re-entry: score unchanged and price not ≥5¢ better.` });
              continue;
            }
            // State genuinely changed — allow re-entry and clear the block so
            // we don't gate again after this cycle.
            swingExitState.delete(gameBase);
            console.log(`[live-edge] ♻️ Post-exit re-entry allowed on ${gameBase}: ${scoreChanged ? `score ${recentExit.scoreKey}→${nowScoreKey}` : `price ${Math.round(recentExit.exitPrice*100)}¢→${Math.round(price*100)}¢`}`);
          }
        }

        // Price filter — sport-specific ceiling, tiered by score differential where relevant.
        // NHL P1/P2: 75¢ default, 78¢ for 2-goal, 82¢ for 3+ goal.
        // NBA Q1-Q3: 75¢ default, 78¢ for 10-14pt, 82¢ for 15pt+.
        const sportMaxPrice = getMaxPrice(league, period, diff);
        if (price <= 0.05) {
          console.log(`[live-edge] Skipping: ${leadingAbbr} @${(price*100).toFixed(0)}¢ (lottery ticket)`);
          continue;
        }
        if (price >= sportMaxPrice) {
          console.log(`[live-edge] Skipping: ${leadingAbbr} @${(price*100).toFixed(0)}¢ (above ${(sportMaxPrice*100).toFixed(0)}¢ ceiling for ${league.toUpperCase()} P${period})`);
          logScreen({ stage: 'live-edge-skip', result: 'skip-price-ceiling', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr: leadingAbbr, reasoning: `${leadingAbbr} YES @${(price*100).toFixed(0)}¢ exceeds the ${(sportMaxPrice*100).toFixed(0)}¢ price ceiling for ${league.toUpperCase()} P${period} — market has already priced in the lead` });
          continue;
        }

        // MLB 1-run lead P7+ minimum edge guard.
        // Graduated by bullpen tier: elite/good bullpens need only 10pt edge;
        // average/below/poor/unknown still require 15pt. This opens up EV in
        // situations where the leading team's bullpen is genuinely closing-ready
        // (e.g., ATL's 2.85 season ERA) without relaxing protection elsewhere.
        if (league === 'mlb' && diff === 1 && period >= 7) {
          const weBase = getWinExpectancy('mlb', 1, period) ?? 0.76;
          // Base minEdge scaled by bullpen: elite/good = 10pt, otherwise 15pt.
          // AWAY-leader penalty: +5pt — away team leading in top of inning still
          // faces both B8+B9 (or B9) of opponent at-bats, a structural hazard the
          // table doesn't capture. Real loss: BAL@KC on 2026-04-21, BAL led 5-4
          // in top 8, bot bought at 72¢ = 12pt edge vs 84% WE, passed the gate,
          // KC tied it in bot 8 and price crashed to 42¢. Away leader WE for 1-run
          // lead in p8 is closer to 76-78%, not 84%.
          let minEdge = (leadingBullpenTier === 'elite' || leadingBullpenTier === 'good') ? 0.10 : 0.15;
          const leaderIsAway = leadingAbbr !== homeAbbr;
          if (leaderIsAway) minEdge += 0.05;
          if (price > weBase - minEdge) {
            const edgePts = (minEdge * 100).toFixed(0);
            console.log(`[live-edge] Skipping MLB 1-run P${period}: ${leadingAbbr} @${(price*100).toFixed(0)}¢ — need ≤${((weBase-minEdge)*100).toFixed(0)}¢ (WE ${(weBase*100).toFixed(0)}% - ${edgePts}pt min edge, pen tier=${leadingBullpenTier}${leaderIsAway ? ', AWAY-leader penalty' : ''})`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-mlb-1run-late', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr: leadingAbbr, reasoning: `MLB 1-run P${period}: ${leadingAbbr} @${(price*100).toFixed(0)}¢ needs ≤${((weBase-minEdge)*100).toFixed(0)}¢ (WE ${(weBase*100).toFixed(0)}% minus ${edgePts}pt edge; pen tier=${leadingBullpenTier}${leaderIsAway ? '; away-leader +5pt penalty' : ''}) — 1-run late leads too volatile at thin edge` });
            continue;
          }
        }

        // MLB scoring-threat Hard NO: bases loaded or RISP with 0 outs AND lead ≤ 2.
        // Bases loaded with 0 outs → ~85% chance of ≥1 run scoring. Runners on
        // 2nd+3rd with 0 outs → ~75% chance. With a 1-2 run lead, that's lights out.
        if (league === 'mlb' && diff <= 2 && comp.situation) {
          const sit = comp.situation;
          const outs = sit.outs ?? 0;
          const basesLoaded = !!(sit.onFirst && sit.onSecond && sit.onThird);
          const risp23Empty0Out = !!(sit.onSecond && sit.onThird && !sit.onFirst && outs === 0);
          const trailingBatting = targetIsHome ? (gameDetail?.startsWith('Top') || gameDetail?.startsWith('Mid')) : (gameDetail?.startsWith('Bot') || gameDetail?.startsWith('End'));
          if (trailingBatting && (basesLoaded || risp23Empty0Out)) {
            const situation = basesLoaded ? 'bases loaded' : 'runners on 2nd+3rd';
            console.log(`[live-edge] Skipping MLB scoring threat: ${situation}, ${outs} out${outs !== 1 ? 's' : ''}, lead ${diff} run${diff === 1 ? '' : 's'} — trailing team at max leverage`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-scoring-threat', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr: leadingAbbr, reasoning: `Scoring threat: ${situation} with ${outs} out and only ${diff}-run lead. Single hit ties or wins it for trailing team.` });
            continue;
          }
        }

        // Soccer red-card Hard NO: leading team has been shown a red card → skip WIN bet.
        // 10+ vs 11 drops the leading team's WIN probability by ~15-20pts — far more
        // than any WE adjustment can fairly model mid-game.
        if (isSoccer) {
          const rcOf = (team) => parseInt(team.statistics?.find(s => s.abbreviation === 'RC')?.displayValue ?? '0') || 0;
          const leadingTeam = leadingAbbr === homeAbbr ? home : away;
          const leadingRedCards = rcOf(leadingTeam);
          const lastPlayRedText = (comp.situation?.lastPlay?.text ?? '').toLowerCase().includes('red card');
          if (leadingRedCards > 0 || lastPlayRedText) {
            console.log(`[live-edge] Skipping ${leadingAbbr}: leading team has red card — soccer 10v11 → large WE drop`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-red-card', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr: leadingAbbr, reasoning: `${leadingAbbr} has been shown a red card (RC=${leadingRedCards}). Playing 10v11 drops win probability by ~15-20pts — too large to model around.` });
            continue;
          }
        }

        // MARKET DISSENT GUARD: if the market prices a large-lead late-game situation
        // 40+ points below WE, sharp money is actively pricing a specific collapse —
        // not lagging the score. A 99% WE at 45¢ means professionals have seen or
        // heard something (wild reliever entering, lineup surge incoming, park factor)
        // that our model doesn't capture. Real example: MIN up 6-0 in P8, market at 45¢ —
        // Aroldis Chapman entered and imploded, BOS came back. We would have lost $67+
        // holding to settlement. The market was right, not wrong.
        //
        // Threshold: gap > 40pts AND diff >= 4 AND period >= 7.
        // Does NOT block:
        //   - CLE@STL (gap 22pts) — well below threshold, correct bet
        //   - TEX@ATH (gap 34pts, diff=1) — lead too small to trigger
        //   - ARI@BAL (gap 11pts) — clearly below threshold
        if (league === 'mlb' && diff >= 4 && period >= 7) {
          const weBase = getWinExpectancy('mlb', diff, period) ?? 0;
          const marketGap = weBase - price;
          if (marketGap >= 0.40) {
            console.log(`[live-edge] Skipping ${leadingAbbr}: market dissent guard — WE=${(weBase*100).toFixed(0)}% vs market=${(price*100).toFixed(0)}¢ (${(marketGap*100).toFixed(0)}pt gap). Sharp money is pricing a specific collapse, not lagging the score.`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-market-dissent', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr: leadingAbbr, reasoning: `Market dissent: WE=${(weBase*100).toFixed(0)}% but market=${(price*100).toFixed(0)}¢ (${(marketGap*100).toFixed(0)}pt gap) with ${diff}-run lead in P${period}. This gap is not market lag — sharp money has specific information about a collapse. Do not fade professionals with a 40pt+ discount on a large late lead.` });
            continue;
          }
        }

        // Observability-only: log thin-lead market-dissent cases (diff<4 OR period<7)
        // where market is ≥12pt below WE. No skip — just surface the pattern for later
        // analysis. Example: MIN@NYM Top 9th NYM @94¢ vs WE 78% = 16pt gap, silently eaten.
        if (league === 'mlb' && diff >= 1 && !(diff >= 4 && period >= 7)) {
          const weBase = getWinExpectancy('mlb', diff, period) ?? 0;
          const marketGap = weBase - price;
          if (Math.abs(marketGap) >= 0.12) {
            const dir = marketGap > 0 ? 'market-below-WE' : 'market-above-WE';
            console.log(`[market-dissent-thin] ${dir} ${league.toUpperCase()} ${leadingAbbr} (${homeAbbr}@${awayAbbr}) P${period} diff=${diff}: WE=${(weBase*100).toFixed(0)}% vs market=${(price*100).toFixed(0)}¢ (${(marketGap*100).toFixed(0)}pt gap) — observe only`);
          }
        }

        // NHL 5-on-3 power-play Hard NO: 2-man advantage scores ~50% of the time
        // vs ~20% on a regular 5-on-4. If the leading team is up 1 goal and facing
        // a 5-on-3 right now, the lead is in serious jeopardy.
        if (league === 'nhl' && diff === 1) {
          const lastPlay = (comp.situation?.lastPlay?.text ?? '').toLowerCase();
          const strength = (comp.situation?.strength ?? '').toString().toLowerCase();
          const is5on3 = /(^|\s)5[-\s]?on[-\s]?3|5v3|two[-\s]man advantage/i.test(lastPlay)
            || /(^|\s)5[-\s]?on[-\s]?3|5v3/i.test(strength);
          if (is5on3) {
            console.log(`[live-edge] Skipping ${leadingAbbr}: trailing team on 5-on-3 PP with 1-goal lead`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-5on3', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr: leadingAbbr, reasoning: `Trailing team on a 5-on-3 power play with a 1-goal lead. 5-on-3 converts ~50% per minute — the lead probably dies.` });
            continue;
          }
        }

        // NBA comeback-momentum Hard NO: if the trailing team outscored the
        // leading team in the MOST RECENTLY COMPLETED quarter by 6+, AND the
        // lead is now ≤ 10, the game is actively reversing. Don't chase.
        if (league === 'nba' && diff <= 10 && period >= 2) {
          const homeLines = (home.linescores ?? []).map(l => parseInt(l.displayValue ?? l.value ?? '0') || 0);
          const awayLines = (away.linescores ?? []).map(l => parseInt(l.displayValue ?? l.value ?? '0') || 0);
          const completed = Math.min(homeLines.length, awayLines.length);
          if (completed >= 2) {
            const lastIdx = Math.min(completed, period) - 1;
            const trailingPts = leadingAbbr === homeAbbr ? awayLines[lastIdx] : homeLines[lastIdx];
            const leadingPts = leadingAbbr === homeAbbr ? homeLines[lastIdx] : awayLines[lastIdx];
            const swing = trailingPts - leadingPts;
            if (swing >= 6) {
              console.log(`[live-edge] Skipping NBA ${leadingAbbr}: trailing team outscored leader ${trailingPts}-${leadingPts} in Q${lastIdx + 1}, lead now ${diff}pt — active comeback`);
              logScreen({ stage: 'live-edge-skip', result: 'skip-nba-momentum', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr: leadingAbbr, reasoning: `Active comeback: trailing team won Q${lastIdx + 1} by ${swing} (${trailingPts}-${leadingPts}) and the lead is now only ${diff}pt. Market often lags this.` });
              continue;
            }
          }
        }

        // Contra line movement → no longer auto-skip. A sharp move against us is
        // exactly the shape sharp bettors fade when their model disagrees. Let Sonnet
        // see the move (it's already in the prompt as "⚠️ CONTRA LINE MOVEMENT") and decide.

        // Reject memo — same score + same period + same price + <3min since last NO = no point re-asking.
        // Score/period/price changes still let the call through (those flip Claude's answer).
        // 2026-05-01: added period to bust trigger. Score can stay same (e.g. 4-0)
        // while game progresses through innings — each new inning is a different game
        // state and warrants re-evaluation. TEX-DET 4-0 stayed in memo loop across
        // inn-3 → inn-4 transition because scoreKey alone didn't change.
        const _memoEntry = liveEdgeRejectMemo.get(gameBase);
        if (_memoEntry && Date.now() - _memoEntry.ts < LIVE_REJECT_MAX_AGE_MS) {
          const _priceCentsNow = Math.round(price * 100);
          const _priceDelta = _priceCentsNow - _memoEntry.priceCents;
          const _sameScore = _memoEntry.scoreKey === currentScoreKey;
          const _samePeriod = _memoEntry.period === period;
          const _samePrice = Math.abs(_priceDelta) <= 2 && _priceDelta >= -1;
          if (_sameScore && _samePeriod && _samePrice) {
            console.log(`[live-edge] Reject memo hit: ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}) score=${currentScoreKey} P${period} price=${_priceCentsNow}¢ (Δ${_priceDelta >= 0 ? '+' : ''}${_priceDelta}) — unchanged since last NO, skipping Sonnet`);
            continue;
          }
        }

        // Collect for parallel Sonnet execution instead of calling sequentially
        sonnetCallsThisCycle++;
        // Compute stage for queue items — needed by Phase 4 P1.1 MLB late-1run block.
        const _qStage = league === 'mlb' ? (period <= 4 ? 'early' : period <= 6 ? 'mid' : 'late')
          : league === 'nba' ? (period <= 2 ? 'early' : period === 3 ? 'mid' : 'late')
          : league === 'nhl' ? (period === 1 ? 'early' : period === 2 ? 'mid' : 'late')
          : (period === 1 ? 'early' : 'late');
        // STRUCTURAL DETECTORS: pattern recognizers for historically-profitable cells.
        // Each detector returns null or a synthetic decision; first match wins. Bypasses
        // Sonnet entirely — saves ~$0.30/call and reacts faster. Bot Kelly-sizes from
        // the confidence in the synthetic decision; existing margin/risk gates still apply.
        // 2026-05-02: SCORE-EVENT ARB runs FIRST — info-lag arb, time-sensitive.
        // _scoreChanged is destructured at the outer for-of (line 6457).
        let _structuralDecision = detectScoreEventArb({
          league, period, gameDetail, diff,
          weTimeAdj: _weTimeAdj, price,
          targetAbbr, leadingAbbr,
          scoreChanged: _scoreChanged ?? false,
        });
        if (!_structuralDecision) _structuralDecision = detectNbaQ4ColdShooting({
          league, period, gameDetail, diff,
          leadingFGNum, trailingFGNum,
          weTimeAdj: _weTimeAdj, price,
          targetAbbr, leadingAbbr,
        });
        if (!_structuralDecision) {
          // Broader NBA Q4 leader detector — catches the bigger 89% WR cell
          // that doesn't require the 8pt FG gap (rare). Same time window + leader rule.
          _structuralDecision = detectNbaQ4Leader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-04-29: NBA Q4 underdog-priced leader — fires when leader is at 40-55¢
          // (Kalshi misprices as coin-flip). 4/4 shadow wins on this cell.
          _structuralDecision = detectNbaQ4LeaderUnderdogPrice({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          _structuralDecision = detectSoccerHomeHTLeader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr, homeAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-05-02 OFFENSIVE: counter-equalizer rally buy
          _structuralDecision = detectSoccerCounterEqualizer({
            league, period, gameDetail, diff,
            price, targetAbbr, leadingAbbr, homeAbbr, ticker,
          });
        }
        if (!_structuralDecision) {
          // 2026-05-02 OFFENSIVE: NBA Q4 deep-trailer swing
          _structuralDecision = detectNbaQ4DeepTrailer({
            league, period, gameDetail, diff,
            price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-05-02 OFFENSIVE: MLB inn-8/9 closer-territory leader
          _structuralDecision = detectMlbInn89Leader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr,
          });
        }
        // 2026-04-29 dip-buy detectors (underpriced leaders 46-65¢ band)
        if (!_structuralDecision) {
          _structuralDecision = detectMlbInn6Leader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          _structuralDecision = detectMlbInn2Leader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-04-30: MLB inn 4 leader — uncovered cell from audit, 100% WR n=22
          _structuralDecision = detectMlbInn4Leader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-05-01: MLB inn 1 leader 3+ run lead — shadow 100% WR n=10 @ avg 76¢
          _structuralDecision = detectMlbInn1Leader3Plus({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-05-01: MLB inn 3 leader 3+ run lead — live-edge gap detector
          // (TEX-DET tonight 4-0 inn-3 at 88¢ sat in gap between inn-1 and inn-4 detectors)
          _structuralDecision = detectMlbInn3Leader3Plus({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-05-02: MLB inn 3 leader 2-run — uniform 75-83% WR n=45 shadow @ 65-85¢
          // Replaces disabled inn-3-3run volume with a real +EV cell.
          _structuralDecision = detectMlbInn3Leader2Run({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-05-01: MLB inn 2 leader 2-run — shadow's biggest +EV cell, 92% WR n=40 @ avg 71¢
          _structuralDecision = detectMlbInn2Leader2Run({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-05-01: MLB inn 5 leader 3+ run — shadow 100% WR n=12 @ avg 83¢
          // Cell sits in the 80-88¢ band that Fix A diff-aware permits for diff≥3
          _structuralDecision = detectMlbInn5Leader3Plus({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          _structuralDecision = detectNbaQ2Leader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          _structuralDecision = detectNbaQ3Leader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          _structuralDecision = detectSoccer1HHomeLeader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr, homeAbbr,
          });
        }
        if (!_structuralDecision) {
          _structuralDecision = detectNhlP3ClosingOut({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-05-02 OFFENSIVE: NHL empty-net trailer pull window
          _structuralDecision = detectNhlEmptyNetTrailer({
            league, period, gameDetail, diff,
            price, targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          _structuralDecision = detectMlbMidGameLead({
            league, period, gameDetail, diff,
            leadingBullpenTier,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // 2026-04-29: broader MLB inn 5-7 leader (no bullpen-tier requirement)
          // Shadow data: 28 cases at 80% WR, +9-23% EV.
          _structuralDecision = detectMlbInn5To7Leader({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr,
            ticker, // 2026-05-01: pass ticker so Fix A/D telemetry can record it
          });
        }
        if (!_structuralDecision) {
          // MLB late-inning lockdown — period 8-9 with elite/good bullpen
          _structuralDecision = detectMlbLateInningLockdown({
            league, period, gameDetail, diff,
            leadingBullpenTier,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr,
          });
        }
        if (!_structuralDecision) {
          // Shadow-mined pattern (2026-04-27): broader MLB early-mid leader detector,
          // 81% WR n=48 in shadow data. Catches inning 2 (existing detector starts at 3),
          // 1-run leads, and any bullpen tier. Lower price ceiling 72¢ avoids gamma traps.
          _structuralDecision = detectMlbEarlyMidLead({
            league, period, gameDetail, diff,
            weTimeAdj: _weTimeAdj, price,
            targetAbbr, leadingAbbr,
            leadingBullpenTier,
          });
        }
        if (_structuralDecision) {
          const info = _structuralDecision._matchInfo;
          let summary;
          if (_structuralDecision._structuralPattern === 'nba-q4-cold-shooting') {
            summary = `${info.fgGap.toFixed(0)}pt FG gap, ${info.minsLeft.toFixed(1)}min, ${info.edge.toFixed(0)}pt edge`;
          } else if (_structuralDecision._structuralPattern === 'nhl-p3-closing-out') {
            summary = `${info.minsLeft.toFixed(1)}min P3, lead ${info.diff}, ${info.edge.toFixed(0)}pt edge`;
          } else if (_structuralDecision._structuralPattern === 'mlb-mid-game-lead') {
            summary = `inning ${info.period}, lead ${info.diff}, ${info.tier} bullpen, ${info.edge.toFixed(0)}pt edge`;
          } else if (_structuralDecision._structuralPattern === 'mlb-early-mid-lead') {
            summary = `inning ${info.period}, lead ${info.diff}, price ${info.price}¢, ${info.edge.toFixed(0)}pt edge (shadow-mined)`;
          } else {
            summary = `min ${info.minute}', lead ${info.diff}, ${info.edge.toFixed(0)}pt edge`;
          }
          console.log(`[live-edge] 🎯 STRUCTURAL DETECTOR matched (${_structuralDecision._structuralPattern}): ${targetAbbr} — ${summary}, conf=${(_structuralDecision.confidence*100).toFixed(0)}% — skipping Sonnet`);
          // 2026-04-30 throttles — prevent 4-min burst-fire pattern (today's losses)
          const _structStrategy = 'structural-' + _structuralDecision._structuralPattern;
          const _throttle = checkStructuralThrottles({ league, strategy: _structStrategy, ticker });
          if (_throttle.blocked) {
            console.log(`[live-edge] 🚦 STRUCTURAL THROTTLE: ${targetAbbr} — ${_throttle.reason}`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-structural-throttle', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: _throttle.reason });
            continue;
          }
        }

        // 2026-04-29 — MLB INN 7+ SONNET BLOCK. Trade-level analysis shows
        // Sonnet-driven MLB live-prediction in inn 7+ is -$72.79 cumulative
        // (MLB-P7 25% WR -$45, MLB-P9 0% WR -$28). The structural detectors
        // (mlb-late-inning-lockdown, mlb-inn-5-7-leader) cover the +EV cases.
        // Block any inn 7+ MLB trade that ISN'T a structural detector match.
        if (!_structuralDecision && league === 'mlb' && period >= 7) {
          console.log(`[live-edge] 🚫 MLB-INN${period}-SONNET-BLOCK: ${targetAbbr} — Sonnet-only MLB inn 7+ has -$72 cumulative. Only structural detector matches allowed.`);
          logScreen({ stage: 'live-edge-skip', result: 'skip-mlb-late-sonnet', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `MLB inn ${period} Sonnet-only blocked — must be structural detector match` });
          continue;
        }

        // Two-block prompt with cached static prefix. The prefix (~1500 tokens of
        // response format + steel-man rules + Step 3 enforcement) is identical
        // across all live-edge calls and gets cached for 5 min on Anthropic side
        // — saves ~$5-7/day on input cost. The dynamic block (livePrompt) is
        // built per-call and not cached. claudeSonnet/claudeWithSearch already
        // accept array-form prompts (Step 1 wrapper change).
        const livePromptBlocks = [
          { type: 'text', text: LIVE_EDGE_STATIC_PREFIX, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: livePrompt },
        ];
        sonnetQueue.push({
          prompt: livePromptBlocks, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period,
          leadingAbbr, gameDetail, price, ticker, gameBase, title, targetAbbr, targetTeam,
          targetIsHome: targetAbbr === homeAbbr, leading, trailing, trailingAbbr, stage: _qStage,
          hasPosition, currentScoreKey, isSwingMode, isThesisVindicated,
          reentryHalfSize,
          _lineMove, _scoreChanged,
          _structuralDecision, // null if no match; synthetic decision if pattern matched
          // 2026-04-30: enrich shadow records with strategy context for cell mining.
          // 2026-05-01: SWING_WE_FLOOR/MIN_WE_FOR_SONNET/baseWE were block-scoped — bug
          // caused 0% population. Now read from outer-scope `_outer*` mirrors.
          _shadowEnrichment: {
            leadingBullpenTier: typeof leadingBullpenTier !== 'undefined' ? leadingBullpenTier : null,
            swingWEFloor: typeof _outerSwingWEFloor === 'number' ? _outerSwingWEFloor : null,
            minWEForSonnet: typeof _outerMinWEForSonnet === 'number' ? _outerMinWEForSonnet : null,
            baseWE: typeof _outerBaseWE === 'number' ? _outerBaseWE : null,
            // 2026-05-01 Tier 3: pass scoreboard data for NBA/NHL deep extraction
            espnEventId: comp?.id ?? null,
            espnCompetitors: comp?.competitors ?? null, // contains probables (goalies), leaders
            espnSituation: comp?.situation ?? null, // NHL strength + PP state when populated
          },
        });

    } catch (e) {
      console.error(`[live-edge] pre-filter error:`, e.message);
    }
  }

  // === PHASE 4: Fire Sonnet calls in parallel (3 at a time) ===
  if (sonnetQueue.length === 0) return;

  // Elevate up to 2 items with CONTRA line-movement to Claude-with-search.
  // Rationale: contra moves are often breaking injury/lineup/ejection news the
  // ESPN snapshot hasn't caught yet. A targeted search can surface it before we
  // fade a sharp move. Cap at 2/cycle so we don't blow the 60s live-edge window
  // (each search adds ~5-8s vs. ~2-3s for no-search Sonnet).
  const SEARCH_CAP = 2;
  let searchBudget = SEARCH_CAP;
  const shouldSearch = (item) => {
    if (searchBudget <= 0) return false;
    if (!item._lineMove || item._lineMove.confirming !== false) return false;
    searchBudget--;
    item._useSearch = true;
    return true;
  };
  for (const item of sonnetQueue) shouldSearch(item);
  const searchItemCount = sonnetQueue.filter(i => i._useSearch).length;
  console.log(`[live-edge] Sending ${sonnetQueue.length} games to Sonnet in parallel${searchItemCount > 0 ? ` (${searchItemCount} with web search on contra-move)` : ''}...`);

  // Batch in groups of 3 for parallel execution
  for (let batch = 0; batch < sonnetQueue.length; batch += 3) {
    const batchItems = sonnetQueue.slice(batch, batch + 3);
    const batchResults = await Promise.allSettled(
      batchItems.map(item => {
        // STRUCTURAL DETECTOR FAST PATH — return synthetic decision as if Sonnet
        // responded with this JSON. Saves the API call and reacts in zero time.
        // Downstream code parses cText with extractJSON+JSON.parse, so we return
        // a JSON string here.
        if (item._structuralDecision) {
          return JSON.stringify(item._structuralDecision);
        }
        if (item._useSearch) {
          // item.prompt is an array of content blocks (cached prefix + dynamic).
          // For the search path, append a third block with the breaking-news
          // search instructions — preserves the cached prefix.
          const searchSuffixText =
            `\n\n═══ BREAKING-NEWS SEARCH (contra line-move fired) ═══\n` +
            `Market moved AGAINST ${item.targetAbbr} fast. This is often breaking news not yet in ESPN. ` +
            `Do ONE targeted search: "${item.targetTeam?.team?.displayName ?? item.targetAbbr} ${item.league.toUpperCase()} injury ejection lineup news today". ` +
            `If the search surfaces a confirmed injury, ejection, or lineup change affecting ${item.targetAbbr}, cite it and reject the trade. ` +
            `If nothing concrete is found, treat the contra move as market noise and evaluate normally on the WE-vs-price edge.`;
          const searchPrompt = Array.isArray(item.prompt)
            ? [...item.prompt, { type: 'text', text: searchSuffixText }]
            : item.prompt + searchSuffixText;
          // 45s timeout (was 25s): Anthropic web-search routinely needs 30-50s
          // for one search + reasoning. Today's 3 sonnet-empty alerts were all
          // 25s timeouts on calls that almost certainly would've completed at 45s.
          // cacheSystem: true — short system stem combines with the cached user
          // prefix block (LIVE_EDGE_STATIC_PREFIX) for cumulative prefix caching.
          return claudeWithSearch(searchPrompt, { maxTokens: 2000, maxSearches: 1, timeout: 45000, category: 'live-edge-search', system: 'You are a sports betting analyst. You MUST respond with a single JSON object only — no prose, no explanation outside the JSON. Your entire response must be valid JSON.', cacheSystem: true });
        }
        return claudeSonnet(item.prompt, { maxTokens: 1500, timeout: 45000, category: 'live-edge', system: 'You are a sports betting analyst. You MUST respond with a single JSON object only — no prose, no explanation outside the JSON. Your entire response must be valid JSON.', cacheSystem: true });
      })
    );

    for (let i = 0; i < batchItems.length; i++) {
      const item = batchItems[i];
      const batchResult = batchResults[i];
      const cText = batchResult.status === 'fulfilled' ? batchResult.value : null;
      if (!cText) {
        // Distinguish transient infra failures (Anthropic web-search timeouts, network
        // aborts) from real Sonnet failures (empty response, bad model output).
        // Transient infra failures are noise — log but don't spam Telegram.
        // Two paths can produce a transient: (a) promise rejected with a timeout-shaped
        // message, or (b) wrapper caught the timeout and returned null — in which case
        // we backstop via the module-level transient flag (see _claudeTransientRecent).
        const reasonMsg = batchResult.status === 'rejected' ? (batchResult.reason?.message ?? '') : '';
        const isTransientTimeout = CLAUDE_TRANSIENT_REGEX.test(reasonMsg) || _claudeTransientRecent();
        if (isTransientTimeout) {
          console.log(`[live-edge] ⏳ Transient timeout on ${item.targetAbbr} (${item.league.toUpperCase()} ${item.awayAbbr}@${item.homeAbbr})${reasonMsg ? ': ' + reasonMsg.slice(0, 100) : ' (caught by wrapper)'} — silent skip, will retry next cycle`);
        } else {
          await reportError('live-edge:sonnet-empty', `${item.targetAbbr} ${item.league.toUpperCase()} ${item.awayAbbr}@${item.homeAbbr}${reasonMsg ? ': ' + reasonMsg : ''}`);
        }
        continue;
      }

      // Destructure back the context we need. `isSwingMode` is mutable below
      // (isEdgeFirstLive promotion at ~line 4377 reassigns it) so it must be `let`.
      // 2026-04-24: added leading/trailing/trailingAbbr/stage which are referenced by
      // P1.1 (MLB late-1run block) and team-quality haircut. Were causing
      // ReferenceErrors on every live-edge call.
      const { league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, leadingAbbr,
              gameDetail, price, ticker, gameBase, title, targetAbbr, hasPosition, currentScoreKey, isThesisVindicated, reentryHalfSize,
              leading, trailing, trailingAbbr, stage } = item;
      let { isSwingMode } = item;

      try {
        const jsonMatch = extractJSON(cText);
        if (!jsonMatch) { await reportError('live-edge:no-json', `${targetAbbr} ${league.toUpperCase()} ${awayAbbr}@${homeAbbr}: ${cText.slice(0, 120)}`); continue; }

        let decision;
        try { decision = JSON.parse(jsonMatch); } catch (e) { await reportError('live-edge:parse-fail', `${targetAbbr} ${league.toUpperCase()} ${awayAbbr}@${homeAbbr}: ${e.message} | head=${jsonMatch.slice(0, 120)}`); continue; }

        // 2026-05-02: provenance check. If response came from OpenAI fallback,
        // raise the edge floor for trade firing — GPT-5 calibration is unverified
        // for our cells, so require a stronger margin of safety until we have data.
        const _decisionProvider = decision._openaiFallback === true ? 'openai' : 'claude';
        if (_decisionProvider === 'openai' && decision.trade && decision.confidence != null) {
          const _openaiEdge = decision.confidence - price;
          if (_openaiEdge < 0.08) {
            console.log(`[live-edge] OpenAI fallback edge ${(_openaiEdge*100).toFixed(0)}pt < 8pt floor — overriding to NO`);
            decision.trade = false;
          }
        }

        // Normalize reasoning: accept structured object (new format) OR string (fallback).
        // For TRADE responses we want the structured object; we'll also render it to a
        // readable string so the existing UI and logs keep working unchanged.
        const reasoningStructured = (typeof decision.reasoning === 'object' && decision.reasoning !== null)
          ? decision.reasoning
          : null;
        const reasoningStr = reasoningStructured
          ? renderStructuredReasoning(reasoningStructured)
          : (typeof decision.reasoning === 'string' ? decision.reasoning : '');
        decision.reasoning = reasoningStr;
        decision.reasoningStructured = reasoningStructured;

        // Shadow decision logging — captures every Sonnet YES/NO for offline calibration.
        // YES decisions also become trades.jsonl entries via downstream code; logging here
        // ensures we have the AT-DECISION price and reasoning regardless of what filters
        // do downstream. Settlement reconciler (Phase 2) backfills outcome.
        const _shadowSport = league === 'mlb' ? 'MLB' : league === 'nba' ? 'NBA' : league === 'nhl' ? 'NHL'
          : ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(league) ? 'Soccer' : 'Other';
        // Enriched shadow context (2026-04-27 expansion): bid/ask spread, clock,
        // velocity, time-of-day, full reasoning structure. Each adds a dimension
        // for future pattern mining. RLM context already present per-trade.
        const _liveShadowCtx = buildShadowContext({
          priceData: cachedPrices.get(ticker),
          gameDetail, ticker, side: 'yes', decisionPrice: price,
        });
        // 2026-04-30 Tier 1 enrichment: capture strategy/swing/lineMove/bullpen
        // context so shadow data supports per-strategy and per-cell mining.
        const _shadowEnrich = item._shadowEnrichment ?? {};
        const _strategyTag = item._structuralDecision
          ? `structural-${item._structuralDecision._structuralPattern}`
          : (isSwingMode ? 'live-swing' : 'live-prediction');
        const _lineMoveTag = item._lineMove
          ? (item._lineMove.confirming === true ? 'CONFIRMING'
             : item._lineMove.confirming === false ? 'CONTRA' : 'NEUTRAL')
          : null;
        // Period phase: parse from gameDetail. ESPN sends "Top X"/"Bot X" mid-inning,
        // "Mid X"/"End X" between innings. For non-MLB use period progress fraction.
        const _periodPhase = (() => {
          if (!gameDetail) return null;
          if (league === 'mlb') {
            if (/^Top\b/i.test(gameDetail)) return 'top-inning';
            if (/^Bot\b/i.test(gameDetail)) return 'bot-inning';
            if (/^Mid\b/i.test(gameDetail)) return 'mid-inning-break';
            if (/^End\b/i.test(gameDetail)) return 'end-inning';
          }
          // NBA/NHL/Soccer: use clock if present in gameDetail
          const m = gameDetail.match(/(\d+):(\d+)/);
          if (m) {
            const mins = parseInt(m[1], 10);
            if (league === 'nba') return mins >= 8 ? 'early' : mins >= 4 ? 'mid' : 'late';
            if (league === 'nhl') return mins >= 13 ? 'early' : mins >= 7 ? 'mid' : 'late';
            return mins >= 30 ? 'early' : mins >= 15 ? 'mid' : 'late';
          }
          return null;
        })();

        // 2026-05-01 Tier 3 — NBA / NHL deep extraction from ESPN data.
        // NBA: leading-scorer foul trouble (requires summary fetch for boxscore.players)
        // NHL: starting goalie + back-to-back detection + PP state (mostly from scoreboard, summary fallback)
        let _nbaLeaderTopScorer = null, _nbaLeaderTopScorerFouls = null, _nbaLeaderTopScorerInTrouble = null;
        let _nbaTrailerTopScorer = null, _nbaTrailerTopScorerFouls = null, _nbaTrailerTopScorerInTrouble = null;
        let _nhlHomeGoalie = null, _nhlAwayGoalie = null;
        let _nhlHomeGoalieBackToBack = null, _nhlAwayGoalieBackToBack = null;
        let _nhlPpStrength = null, _nhlPpTeam = null;
        // 2026-05-02: ESPN lastPlay.probability — universal win-prob signal across
        // NBA/NHL/NFL/MLB live games. Cross-validates Kalshi pricing against ESPN's
        // model. Available on most live-game scoreboard responses (situation.lastPlay
        // for NBA, plays[-1] elsewhere). When available, store both home and away.
        let _espnHomeWinProb = null, _espnAwayWinProb = null, _espnTiePct = null;
        try {
          const _enrich = item._shadowEnrichment ?? {};
          const _competitors = _enrich.espnCompetitors;
          const _situation = _enrich.espnSituation;
          // Helpers
          const _findComp = (tabbr) => (_competitors || []).find(c => (c.team?.abbreviation ?? '').toUpperCase() === (tabbr ?? '').toUpperCase());
          // === NHL goalie (free from scoreboard probables) ===
          if (league === 'nhl' && _competitors) {
            const homeC = _findComp(homeAbbr);
            const awayC = _findComp(awayAbbr);
            _nhlHomeGoalie = homeC?.probables?.[0]?.athlete?.displayName ?? null;
            _nhlAwayGoalie = awayC?.probables?.[0]?.athlete?.displayName ?? null;
            _nhlHomeGoalieBackToBack = isGoalieBackToBack(_nhlHomeGoalie);
            _nhlAwayGoalieBackToBack = isGoalieBackToBack(_nhlAwayGoalie);
            // Record TODAY's start (only when we observe the goalie in active live game)
            if (_nhlHomeGoalie && period >= 1) recordNhlGoalieStart(_nhlHomeGoalie, homeAbbr);
            if (_nhlAwayGoalie && period >= 1) recordNhlGoalieStart(_nhlAwayGoalie, awayAbbr);
          }
          // === NHL power play state (from situation.strength when populated) ===
          if (league === 'nhl' && _situation) {
            // ESPN situation may have strength as "5v5", "5v4", "5v3" — capture verbatim
            _nhlPpStrength = _situation.strength ?? _situation.lastPlay?.strength ?? null;
            // Determine which team has the advantage (homeTeamHasGoalie / power-play indicator)
            if (_nhlPpStrength && _nhlPpStrength !== '5v5') {
              const homePP = _situation.homeTeamHasGoalie === false || _situation.homePowerPlay === true;
              const awayPP = _situation.awayTeamHasGoalie === false || _situation.awayPowerPlay === true;
              _nhlPpTeam = homePP ? homeAbbr : awayPP ? awayAbbr : null;
            }
          }
          // === ESPN lastPlay win probability (universal signal) ===
          // Audit 2026-05-02: confirmed NBA scoreboard situation.lastPlay.probability
          // contains {homeWinPercentage, awayWinPercentage, tiePercentage}. NHL
          // situation is null on scoreboard but plays array on /summary has it too.
          // For now capture from scoreboard situation when available.
          if (_situation?.lastPlay?.probability) {
            const _prob = _situation.lastPlay.probability;
            _espnHomeWinProb = typeof _prob.homeWinPercentage === 'number' ? _prob.homeWinPercentage : null;
            _espnAwayWinProb = typeof _prob.awayWinPercentage === 'number' ? _prob.awayWinPercentage : null;
            _espnTiePct = typeof _prob.tiePercentage === 'number' ? _prob.tiePercentage : null;
          }
          // === NBA leading-scorer foul trouble (requires /summary fetch) ===
          if (league === 'nba' && _enrich.espnEventId) {
            const sm = await getEspnSummary(_enrich.espnEventId, 'basketball/nba');
            if (sm?.boxscore?.players) {
              // For each team's players, find the top scorer (highest PTS) and their fouls (PF)
              for (const teamGroup of sm.boxscore.players) {
                const tabbr = (teamGroup.team?.abbreviation ?? '').toUpperCase();
                // Find the stat group containing PTS + PF (usually first / starters group)
                const stats = teamGroup.statistics || [];
                let bestPts = -1, bestName = null, bestFouls = null;
                for (const grp of stats) {
                  const keys = grp.keys || [];
                  const ptsIdx = keys.indexOf('PTS') !== -1 ? keys.indexOf('PTS') : keys.indexOf('points');
                  const pfIdx = keys.indexOf('PF') !== -1 ? keys.indexOf('PF') : keys.indexOf('fouls');
                  if (ptsIdx < 0) continue;
                  for (const ath of (grp.athletes || [])) {
                    const sArr = ath.stats || [];
                    const pts = parseFloat(sArr[ptsIdx] ?? '0') || 0;
                    if (pts > bestPts) {
                      bestPts = pts;
                      bestName = ath.athlete?.displayName ?? null;
                      bestFouls = pfIdx >= 0 ? parseInt(sArr[pfIdx] ?? '0', 10) || 0 : null;
                    }
                  }
                }
                const inTrouble = bestFouls != null && (bestFouls >= 5 || (bestFouls >= 4 && (period ?? 0) >= 3));
                if (tabbr === leadingAbbr.toUpperCase()) {
                  _nbaLeaderTopScorer = bestName;
                  _nbaLeaderTopScorerFouls = bestFouls;
                  _nbaLeaderTopScorerInTrouble = inTrouble;
                } else {
                  _nbaTrailerTopScorer = bestName;
                  _nbaTrailerTopScorerFouls = bestFouls;
                  _nbaTrailerTopScorerInTrouble = inTrouble;
                }
              }
            }
          }
        } catch { /* best-effort, never disrupt shadow logging */ }

        logShadowDecision({
          stage: 'live-edge',
          ticker,
          sport: _shadowSport,
          league,
          decision: decision.trade ? 'trade' : 'no-trade',
          rejectReason: decision.trade ? null : 'claude-no',
          // 2026-05-02: persist structural-pattern tag on shadow records for placed
          // bets. Was missing — making it impossible to audit which detector is
          // responsible for losing bets (47 placed MLB live-edge shadows all tagged
          // (claude/manual) in audit). Now we can join shadow → settlement → detector.
          structuralPattern: decision._structuralPattern ?? null,
          // 2026-05-02: provenance — track which LLM produced this decision so cron
          // audit can compute WR per provider (Claude vs GPT-5 fallback).
          llmProvider: _decisionProvider,
          claudeConfidence: decision.confidence ?? null,
          decisionPrice: price,
          edge: decision.confidence != null ? Math.round((decision.confidence - price) * 100) : null,
          scoreDiff: diff,
          period,
          gameDetail,
          leadingAbbr,
          targetAbbr,
          homeAbbr, awayAbbr,
          liveStage: stage, // destructured from item at line 6240
          reasoningPreview: (decision.reasoning ?? '').slice(0, 200),
          reasoningStructured: decision.reasoningStructured ?? null,
          reasoningTags: decision.reasoningStructured?.reasoning_tags ?? null,
          rlmContext: getLiveMoveContext(ticker, 'yes', price),
          // Tier 1 enrichment fields
          strategy: _strategyTag,
          isSwingMode: !!isSwingMode,
          swingWEFloor: _shadowEnrich.swingWEFloor ?? null,
          minWEForSonnet: _shadowEnrich.minWEForSonnet ?? null,
          baseWE: _shadowEnrich.baseWE ?? null,
          lineMove: _lineMoveTag,
          lineMoveVelocity: item._lineMove?.velocity ?? null,
          lineMoveCrossConfirmed: item._lineMove?.crossConfirmed ?? null,
          mlbBullpenTier: _shadowEnrich.leadingBullpenTier ?? null,
          periodPhase: _periodPhase,
          isLeadingTeam: targetAbbr === leadingAbbr,
          // 2026-05-01 Tier 2 derivations — free observability from existing fields
          // Parse clock seconds from gameDetail. NBA: "8:59 - 4th" or "End 3rd Q".
          // NHL: "8:59 - 3rd" or "End 2nd". MLB: gameDetail has "Top 5th" — no clock.
          clockSeconds: (() => {
            if (!gameDetail) return null;
            const m = gameDetail.match(/(\d+):(\d{2})/);
            if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
            return null;
          })(),
          // NHL empty-net pull window: P3 + clock<90s + 1-2 goal lead. Trailing team
          // pulls goalie. Scoring rate spikes ~5x normal.
          nhlEmptyNetWindow: (() => {
            if (league !== 'nhl' || period !== 3) return false;
            if (!gameDetail) return false;
            const m = gameDetail.match(/(\d+):(\d{2})/);
            if (!m) return false;
            const secs = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
            return secs < 90 && Math.abs(diff ?? 0) >= 1 && Math.abs(diff ?? 0) <= 2;
          })(),
          // NBA garbage-time: Q4 + 20+ pt lead + >4min remaining. Bench-vs-bench
          // variance distorts trailing-stop logic.
          nbaGarbageTime: (() => {
            if (league !== 'nba' || period !== 4) return false;
            if (Math.abs(diff ?? 0) < 20) return false;
            if (!gameDetail) return false;
            const m = gameDetail.match(/(\d+):(\d{2})/);
            if (!m) return false;
            const secs = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
            return secs > 240; // >4min remaining
          })(),
          // Soccer stoppage time: gameDetail has "90+5'" format or period > 90
          socInStoppage: (() => {
            const isSoccer = ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(league);
            if (!isSoccer) return false;
            if (period && period >= 90) return true;
            if (gameDetail && /^9\d\+\d/.test(gameDetail)) return true;
            return false;
          })(),
          // 2026-05-01 Tier 3 — NBA / NHL deep extraction tags
          nbaLeaderTopScorer: _nbaLeaderTopScorer,
          nbaLeaderTopScorerFouls: _nbaLeaderTopScorerFouls,
          nbaLeaderTopScorerInTrouble: _nbaLeaderTopScorerInTrouble,
          nbaTrailerTopScorer: _nbaTrailerTopScorer,
          nbaTrailerTopScorerFouls: _nbaTrailerTopScorerFouls,
          nbaTrailerTopScorerInTrouble: _nbaTrailerTopScorerInTrouble,
          nhlHomeGoalie: _nhlHomeGoalie,
          nhlAwayGoalie: _nhlAwayGoalie,
          nhlHomeGoalieBackToBack: _nhlHomeGoalieBackToBack,
          nhlAwayGoalieBackToBack: _nhlAwayGoalieBackToBack,
          nhlPowerPlayStrength: _nhlPpStrength,
          nhlPowerPlayTeam: _nhlPpTeam,
          // 2026-05-02: ESPN win-prob signal (universal across sports)
          espnHomeWinProb: _espnHomeWinProb,
          espnAwayWinProb: _espnAwayWinProb,
          espnTiePct: _espnTiePct,
          ..._liveShadowCtx,
        });

        // 2026-04-29 Gap 1 — TRAILING-TEAM SYNTHETIC SHADOW. The bot only screens
        // leaders, so we have ZERO ground-truth on trailing teams. Log a synthetic
        // shadow for the trailer side too — same game state, opposite team, with
        // estimated trailer price (1 - leader_price as proxy if not cached). At
        // settlement, the reconciler fills ourPickWon based on the trailer ticker's
        // outcome. Lets us validate "buy-underdog" theses with real data.
        //
        // 2026-04-29 PHASE 1 BUY-LOW CANDIDATE TAGGING. When trailer price is in
        // the 25-40¢ band AND game state is recoverable, tag the shadow as a
        // "buy-low candidate". After 7 days we'll join with price-tape data to
        // compute: (a) what % of these saw price recover ≥10-15¢ at some point,
        // (b) what % settled as wins, (c) which sport/period gives best recovery.
        // This is shadow-only: NEVER trades, just records what would have happened.
        try {
          const _trailerAbbr = (homeAbbr === leadingAbbr) ? awayAbbr : homeAbbr;
          if (_trailerAbbr && _trailerAbbr !== leadingAbbr) {
            const _tickerBase = ticker.substring(0, ticker.lastIndexOf('-'));
            const _trailerTicker = `${_tickerBase}-${_trailerAbbr}`;
            const _trailerCached = cachedPrices.get(_trailerTicker);
            const _trailerPrice = _trailerCached?.price ?? Math.max(0.01, Math.min(0.99, 1 - price));

            // Buy-low cell tagging. 2026-04-30: tag every record with a cell label
            // (sport-trail-${diff}-P${period}-${priceBand}) regardless of whether it
            // falls in the canonical buy-low band. This ensures shadow data isn't
            // anonymous outside the heuristic — we can still mine boundary cells
            // (e.g., MLB 4-run deficit, NHL P3) for unexpected edges.
            let _buyLowCandidate = false;
            let _buyLowReason = null;
            const _priceBand = _trailerPrice < 0.25 ? 'deep'        // <25¢ deep underdog
              : _trailerPrice <= 0.40 ? 'low'                       // 25-40¢ canonical buy-low
              : _trailerPrice <= 0.55 ? 'mid'                       // 41-55¢ marginal
              : 'high';                                              // >55¢ near-coinflip
            if (league === 'mlb' && diff >= 1) {
              _buyLowReason = `mlb-trail-${Math.min(diff, 5)}run-P${period}-${_priceBand}`;
              if (_priceBand === 'low' && diff <= 3 && period >= 1 && period <= 6) _buyLowCandidate = true;
            } else if (league === 'nba' && diff >= 1) {
              const _ptBucket = diff <= 4 ? `${diff}pt` : diff <= 8 ? '5-8pt' : diff <= 12 ? '9-12pt' : diff <= 16 ? '13-16pt' : '17+pt';
              _buyLowReason = `nba-trail-${_ptBucket}-P${period}-${_priceBand}`;
              if (_priceBand === 'low' && diff >= 5 && diff <= 15 && period >= 1 && period <= 3) _buyLowCandidate = true;
            } else if (league === 'nhl' && diff >= 1) {
              _buyLowReason = `nhl-trail-${Math.min(diff, 4)}goal-P${period}-${_priceBand}`;
              if (_priceBand === 'low' && diff <= 2 && period >= 1 && period <= 2) _buyLowCandidate = true;
            } else if (['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(league) && diff >= 1) {
              // 2026-04-30: soccer trailer cell tagging. Period in soccer = minute (1-90).
              // Soccer trailers face draw-cliff risk on YES contract, but we still tag
              // for visibility — mining may reveal cells where mid-match recoveries
              // happen often enough to swing-trade pre-final-whistle. Don't flag as
              // buy-low candidate (still excluded from canonical band).
              const _minBucket = period < 30 ? '<30' : period < 45 ? '30-44' : period < 60 ? '45-59' : period < 75 ? '60-74' : period < 85 ? '75-84' : '85+';
              _buyLowReason = `${league}-trail-${Math.min(diff, 3)}goal-min${_minBucket}-${_priceBand}`;
              // Soccer NOT auto-tagged as buy-low candidate — draw cliff makes
              // hold-to-settlement risky. Mining only.
            }

            logShadowDecision({
              stage: 'live-edge-trailer-synthetic',
              ticker: _trailerTicker,
              sport: _shadowSport, league,
              decision: 'synthetic-trail',
              rejectReason: 'trailer-baseline',
              claudeConfidence: null,
              decisionPrice: _trailerPrice,
              edge: null,
              scoreDiff: diff, period, gameDetail,
              leadingAbbr, targetAbbr: _trailerAbbr,
              homeAbbr, awayAbbr,
              liveStage: stage,
              reasoningPreview: _buyLowCandidate
                ? `BUY-LOW CANDIDATE [${_buyLowReason}] @ ${(_trailerPrice*100).toFixed(0)}¢ — phase 1 data collection`
                : 'synthetic trailer-baseline (bot does not evaluate trailers)',
              isTrailerSynthetic: true,
              isBuyLowCandidate: _buyLowCandidate,
              buyLowReason: _buyLowReason,
              // 2026-05-02: tier-3 enrichment was missing on synthetic logs — fixed
              nhlHomeGoalie: _nhlHomeGoalie,
              nhlAwayGoalie: _nhlAwayGoalie,
              nhlHomeGoalieBackToBack: _nhlHomeGoalieBackToBack,
              nhlAwayGoalieBackToBack: _nhlAwayGoalieBackToBack,
              nhlPowerPlayStrength: _nhlPpStrength,
              nhlPowerPlayTeam: _nhlPpTeam,
              nbaLeaderTopScorer: _nbaLeaderTopScorer,
              nbaLeaderTopScorerFouls: _nbaLeaderTopScorerFouls,
              nbaTrailerTopScorer: _nbaTrailerTopScorer,
              nbaTrailerTopScorerFouls: _nbaTrailerTopScorerFouls,
              espnHomeWinProb: _espnHomeWinProb,
              espnAwayWinProb: _espnAwayWinProb,
              espnTiePct: _espnTiePct,
            });
            logPriceTapeEntry({
              ticker: _trailerTicker,
              price: _trailerPrice,
              gameBase, league,
              score: `${awayScore}-${homeScore}`,
              period, gameDetail, leadingAbbr,
            });
            if (_buyLowCandidate) {
              console.log(`[shadow] 🎰 BUY-LOW candidate: ${_trailerTicker} ${_trailerAbbr} @ ${(_trailerPrice*100).toFixed(0)}¢ (${_buyLowReason}) — phase 1 data only, no trade`);
            }

            // 2026-04-30 Tier 2 — COMEBACK-BUY synthetic shadow.
            // Comeback-buy fires only on MLB ace-vs-weak-pitcher dynamic and has
            // n=4 actual trades total. We can't tune cells without more data.
            // Log a synthetic shadow when bot SEES comeback-eligible state but
            // doesn't fire (so we mine which cells convert to +12¢/+15¢ pop).
            // Eligibility: MLB trailing team, deficit ≤ 3, period 1-7, price 25-50¢.
            if (league === 'mlb' && diff >= 1 && diff <= 3 && period >= 1 && period <= 7
                && _trailerPrice >= 0.25 && _trailerPrice <= 0.50) {
              const _cbCell = `mlb-comeback-${diff}run-P${period}-${_priceBand}`;
              logShadowDecision({
                stage: 'live-edge-comeback-synthetic',
                ticker: _trailerTicker,
                sport: _shadowSport, league,
                decision: 'synthetic-comeback-candidate',
                rejectReason: 'comeback-baseline',
                claudeConfidence: null,
                decisionPrice: _trailerPrice,
                edge: null,
                scoreDiff: diff, period, gameDetail,
                leadingAbbr, targetAbbr: _trailerAbbr,
                homeAbbr, awayAbbr,
                liveStage: stage,
                reasoningPreview: `COMEBACK-BUY CANDIDATE [${_cbCell}] @ ${(_trailerPrice*100).toFixed(0)}¢ — bot saw setup, didn't fire`,
                isComebackSynthetic: true,
                comebackCell: _cbCell,
                strategy: 'synthetic-comeback-buy',
                // 2026-05-02: tier-3 enrichment
                nhlHomeGoalie: _nhlHomeGoalie,
                nhlAwayGoalie: _nhlAwayGoalie,
                nhlPowerPlayStrength: _nhlPpStrength,
                nhlPowerPlayTeam: _nhlPpTeam,
                nbaLeaderTopScorer: _nbaLeaderTopScorer,
                nbaLeaderTopScorerFouls: _nbaLeaderTopScorerFouls,
                espnHomeWinProb: _espnHomeWinProb,
                espnAwayWinProb: _espnAwayWinProb,
                espnTiePct: _espnTiePct,
              });
            }
          }
        } catch { /* best-effort */ }

        // 2026-04-30 Tier 2 — DRAW-BET synthetic shadow.
        // Draw-bet has $202/7 trades = highest per-trade EV but n is tiny.
        // Log synthetic when bot sees soccer match tied at minute ≥ 60.
        // Cell unlock: which (league × team-draw-rate × minute × score) combos
        // make draw-bets +EV. Currently we have zero shadow visibility.
        try {
          const _isSoccer = ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(league);
          if (_isSoccer && diff === 0 && period >= 60) {
            // Tied soccer match in 2nd half — draw becomes more likely as time runs out
            const _drawTicker = ticker.substring(0, ticker.lastIndexOf('-')) + '-TIE';
            // Tie-side price not always cached; use 1 - both team prices as proxy
            const _drawPriceProxy = Math.max(0.01, Math.min(0.99, 1 - price));
            const _minuteBand = period < 70 ? '60-69' : period < 80 ? '70-79' : period < 85 ? '80-84' : '85+';
            const _dbCell = `${league}-draw-tied-min${_minuteBand}`;
            logShadowDecision({
              stage: 'live-edge-drawbet-synthetic',
              ticker: _drawTicker,
              sport: 'Soccer', league,
              decision: 'synthetic-drawbet-candidate',
              rejectReason: 'drawbet-baseline',
              claudeConfidence: null,
              decisionPrice: _drawPriceProxy,
              edge: null,
              scoreDiff: 0, period, gameDetail,
              leadingAbbr: null, targetAbbr: 'TIE',
              homeAbbr, awayAbbr,
              liveStage: stage,
              reasoningPreview: `DRAW-BET CANDIDATE [${_dbCell}] tied at min ${period} — bot saw setup`,
              isDrawBetSynthetic: true,
              drawBetCell: _dbCell,
              strategy: 'synthetic-draw-bet',
              // 2026-05-02: tier-3 enrichment (soccer-specific cells use these too)
              espnHomeWinProb: _espnHomeWinProb,
              espnAwayWinProb: _espnAwayWinProb,
              espnTiePct: _espnTiePct,
            });
          }
        } catch { /* best-effort */ }

        // 2026-04-29 Gap 2 — PRICE TAPE for the leader side. logPriceTapeEntry
        // throttles per-ticker so multiple call sites don't spam.
        logPriceTapeEntry({
          ticker, price, gameBase, league,
          score: `${awayScore}-${homeScore}`,
          period, gameDetail, leadingAbbr,
        });

        if (!decision.trade) {
          console.log(`[live-edge] Claude says NO on ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}): conf=${((decision.confidence ?? 0)*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ | ${decision.reasoning?.slice(0, 80)}`);
          liveEdgeRejectMemo.set(gameBase, { scoreKey: currentScoreKey, period, priceCents: Math.round(price * 100), ts: Date.now() });
          logScreen({ stage: 'live-edge', ticker, result: 'pass', confidence: decision.confidence, price, reasoning: decision.reasoning, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, gameDetail, targetAbbr });
          continue;
        }

        // Cross-sport contamination guard — same logic the pre-game path uses, now on live-edge too.
        // Catches cases like KXMLSGAME DAL@MIN analyzed with NHL terms (Wallstedt, period, power play).
        {
          const _isSoccerLeague = ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(league);
          const _expSport = league === 'mlb' ? 'MLB' : league === 'nba' ? 'NBA' : league === 'nhl' ? 'NHL' : _isSoccerLeague ? 'SOCCER' : league.toUpperCase();
          const _wrong = detectWrongSport(_expSport, (decision.reasoning ?? '') + ' ' + (decision.exitScenario ?? ''));
          if (_wrong) {
            console.log(`[live-edge] BLOCKED ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}): Claude confused sport — reasoning mentions "${_wrong}"`);
            logScreen({ stage: 'live-edge', ticker, result: 'blocked-wrong-sport', reasoning: `Expected ${_expSport}, reasoning mentions ${_wrong}`, claudeReasoning: (decision.reasoning ?? '').slice(0, 200) });
            continue;
          }
        }

        // KILLER BUCKET BLOCK (live-edge, all sports after per-sport extension 2026-04-24):
        // 15+pt edge × <70% conf is the proportionality-mismatch pattern. Block fires only
        // when conf < 70%, so the NBA 70-74% jackpot bucket (5/5 WR, +$55) is unaffected.
        // 2026-04-29 EXEMPTION: NBA Q4 leaders bypass — 4/4 shadow wins at 56-64% conf with
        // 8-19pt edges. The "proportionality mismatch" rule is the WRONG signal for the
        // single best-performing live cell (89% WR, +$34.86 trade-level). Bypasses ONLY
        // when our pick is the actual leader in NBA Q4 (objective condition, not Sonnet-derived).
        {
          const _liveEdge = (decision.confidence ?? 0) - price;
          if (_liveEdge >= 0.15 && (decision.confidence ?? 0) < 0.70) {
            // 2026-04-29 EXTENDED EXEMPTION: NBA Q4 leader OR any structural detector.
            // Structural detectors are rules-based (period × score × price) and don't
            // suffer the proportionality-mismatch pattern that makes the killer-bucket
            // rule meaningful for Sonnet judgment trades.
            let _killBucketExempt = !!item._structuralDecision;
            try {
              if (league === 'nba' && period === 4 && targetAbbr) {
                const _tu = targetAbbr.toUpperCase();
                const _hu = (homeAbbr ?? '').toUpperCase();
                const _au = (awayAbbr ?? '').toUpperCase();
                const _tIsHome = _tu === _hu;
                const _tIsAway = _tu === _au;
                const _ts = _tIsHome ? homeScore : _tIsAway ? awayScore : null;
                const _os = _tIsHome ? awayScore : _tIsAway ? homeScore : null;
                if (_ts != null && _os != null && _ts > _os) _killBucketExempt = true;
              }
            } catch { /* best-effort */ }
            if (_killBucketExempt) {
              console.log(`[live-edge] ✓ NBA-P4-LEADER KILLER-BUCKET EXEMPT ${targetAbbr}: ${(_liveEdge*100).toFixed(0)}pt edge at ${((decision.confidence ?? 0)*100).toFixed(0)}% conf — bypassing (89% WR cell)`);
            } else {
              console.log(`[live-edge] 🚫 KILLER BUCKET BLOCKED ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}): ${(_liveEdge*100).toFixed(0)}pt edge at ${((decision.confidence ?? 0)*100).toFixed(0)}% conf — proportionality mismatch (15+pt edges need 70%+ conf).`);
              logScreen({ stage: 'live-edge', ticker, result: 'killer-bucket-block', reasoning: `${league.toUpperCase()}: Edge ${(_liveEdge*100).toFixed(0)}pt + conf ${((decision.confidence ?? 0)*100).toFixed(0)}% = -EV bucket` });
              continue;
            }
          }
        }

        // 2026-04-27 — TAG CREDIBILITY BLOCK. The auto-calibration system has been
        // collecting reasoning_tag stats for weeks but never used them to filter trades.
        // Tags with statistical signal (n ≥ 5) AND Wilson lower-bound < 25% are edge
        // sources Sonnet has been WRONG about catastrophically. Examples from current
        // calibration: starter-mismatch 1/9 (11% WR), bullpen-mismatch 1/5 (20% WR),
        // lineup-cold 2/5 (40% WR, ciLo 12%). When Sonnet cites these as the edge,
        // historical data says skip. Structural detector trades have synthetic tags
        // and should bypass — they're rule-based, not Sonnet-reasoned.
        // 2026-04-29 LOOSENING: only block when there's a bad tag AND no offsetting
        // good tag (we-undervalued / market-lag / playoff-home-fav). Sonnet often
        // cites mixed tags; killing the trade because of one weak co-citation rejects
        // ~3 +EV trades/week per shadow data.
        if (!item._structuralDecision) {
          const tags = decision.reasoningStructured?.reasoning_tags;
          const worstTag = evaluateTagCredibility(tags);
          // Check if any HIGH-credibility tag is also present (Wilson ≥ 0.55, n ≥ 20)
          let hasGoodTag = false;
          if (worstTag && Array.isArray(tags)) {
            const stats = CAL.reasoningTagStats ?? {};
            for (const t of tags) {
              const s = stats[t];
              if (s && (s.n ?? 0) >= 20 && (s.ciLo ?? 0) >= 0.55) {
                hasGoodTag = true;
                break;
              }
            }
          }
          if (worstTag && !hasGoodTag) {
            console.log(`[live-edge] 🚫 TAG-CREDIBILITY BLOCKED ${targetAbbr}: cites '${worstTag.tag}' which has ${worstTag.stats.wins}/${worstTag.stats.n} historical (Wilson lower ${(worstTag.stats.ciLo*100).toFixed(0)}%) — pass`);
            logScreen({ stage: 'live-edge', ticker, result: 'tag-credibility-block', reasoning: `Reasoning tag '${worstTag.tag}' has ${worstTag.stats.wins}/${worstTag.stats.n} (${(worstTag.stats.winRate*100).toFixed(0)}% WR, ciLo ${(worstTag.stats.ciLo*100).toFixed(0)}%) — auto-cal flag` });
            continue;
          } else if (worstTag && hasGoodTag) {
            console.log(`[live-edge] ✓ TAG-CREDIBILITY OFFSET ${targetAbbr}: bad tag '${worstTag.tag}' present but offset by high-credibility tag — allowing through`);
          }
        }

        // Confidence-based gate — sport-specific floor if calibration override exists, else global
        let confidence = decision.confidence ?? 0;
        // 2026-05-02: per-sport + per-league live-prediction confidence floors.
        // MLB live: 70% → 75% (was 46% WR, -$31 P&L over n=24)
        // NHL live: 70% → 74% (was 41% WR, -$13 over n=17 — partly stale data)
        // MLS live: 70% → 78% (50% WR, -$61 across all MLS strategies)
        // EPL live: 70% (kept — small sample, mostly draw-bet drives EPL P&L)
        // LaLiga live: 70% → 73% (40% WR, +$28 mostly variance, conservative)
        // SerieA/Bundesliga/Ligue1: rare, default to standard 70%
        const SPORT_FLOOR_OVERRIDES = { mlb: 0.75, nhl: 0.74, mls: 0.78, laliga: 0.73 };
        const _hardcodedFloor = SPORT_FLOOR_OVERRIDES[league] ?? null;
        const sportMinConf = _hardcodedFloor ?? CAL.minConfidenceLive?.[league] ?? MIN_CONFIDENCE;

        // 2026-05-02: MLS live-swing DISABLED. n=2, -$11.19 over single trade in MLS.
        // Combined with MLS-wide 50% WR / -$61 P&L across all strategies, MLS is
        // structurally unprofitable. Live-swing buys deep underdogs (12¢ entry) which
        // is exactly the spot where MLS variance dominates.
        if (league === 'mls' && isSwingMode) {
          console.log(`[live-edge] 🚫 MLS-LIVE-SWING DISABLED: ${targetAbbr} — MLS structurally bleeding (-$61/10 trades), live-swing path needs more data before re-enabling`);
          logScreen({ stage: 'live-edge', ticker, result: 'mls-live-swing-disabled', reasoning: `MLS live-swing DISABLED — historical -$11.19/-100% WR n=2` });
          continue;
        }

        // 2026-05-02: MAX_CONFIDENCE cap for MLB live. Confidence-band audit revealed
        // a non-monotonic profile:
        //   65-75%: 11% WR (-$29) ❌ — handled by min-floor above
        //   75-80%: 55% WR (+$37) ✅ — sweet spot
        //   80-85%: 40% WR (-$9)  ❌
        //   85-95%: 10% WR (-$32) 🔴 — Claude over-confident on dominant-looking states
        // High-confidence MLB live is a money pit because Claude only goes 85%+ on
        // states that LOOK obvious (price 78-88¢) — small edge, asymmetric loss.
        // Block MLB live entries above 85% confidence. Structural detectors handle
        // genuinely strong situations through the cell-WR path instead.
        const MLB_LIVE_MAX_CONF = 0.85;
        if (league === 'mlb' && !item._structuralDecision && decision.trade && confidence > MLB_LIVE_MAX_CONF) {
          console.log(`[live-edge] 🚫 MLB-LIVE-MAX-CONF: ${targetAbbr} at ${(confidence*100).toFixed(0)}% conf is in the 85%+ bleeder band (n=15 settled = -$32). Skipping non-structural path.`);
          logScreen({ stage: 'live-edge', ticker, result: 'mlb-live-max-conf', reasoning: `MLB live conf ${(confidence*100).toFixed(0)}% > 85% cap — historical -$32/-15 trades band` });
          continue;
        }
        // Tier 2: price×confidence floor (underdog/favorite band) if calibrated
        const priceBand = price < 0.50 ? 'underdog' : 'favorite';
        const priceBandFloor = CAL.priceConfFloors?.[league]?.[priceBand] ?? 0;
        let effectiveMinConf = Math.max(sportMinConf, priceBandFloor);

        // 2026-04-29 NBA Q4 leader floor: WE-table mispricing on late-game leads is the
        // cleanest documented edge (PHI@BOS today fired at 72% conf, 16pt edge — won).
        // Standard 70% floor blocks 60-69% conf cases where Sonnet correctly reads a
        // 5-9pt 4th-quarter lead. Q4 leaders settle ~62% historically; Sonnet at 60%+
        // with a real WE gap is +EV. Lower floor to 58% strictly for NBA Q4 leaders.
        try {
          if (league === 'nba' && period === 4 && targetAbbr) {
            const targetUp = targetAbbr.toUpperCase();
            const homeUp = (homeAbbr ?? '').toUpperCase();
            const awayUp = (awayAbbr ?? '').toUpperCase();
            const targetIsHome = targetUp === homeUp;
            const targetIsAway = targetUp === awayUp;
            const targetScore = targetIsHome ? homeScore : targetIsAway ? awayScore : null;
            const oppScore = targetIsHome ? awayScore : targetIsAway ? homeScore : null;
            if (targetScore != null && oppScore != null && targetScore > oppScore) {
              // 2026-04-29: lowered 58% → 53%. At 19pt edge + leader status, 50% WR
              // is +EV; the 89% WR cell deserves more aggressive capture.
              const nbaQ4Floor = 0.53;
              if (effectiveMinConf > nbaQ4Floor) {
                console.log(`[live-edge] 🏀 NBA Q4 LEADER floor: ${targetAbbr} leading ${targetScore}-${oppScore} P4 — floor ${(effectiveMinConf*100).toFixed(0)}% → ${(nbaQ4Floor*100).toFixed(0)}%`);
                effectiveMinConf = nbaQ4Floor;
              }
            }
          }
        } catch { /* best-effort */ }

        // 2026-04-29 PHASE 2: LOW-PRICE LEADER FLOOR. Shadow audit (605 records, 4 days)
        // showed leaders at 46-65¢ price band have 70-72% WR — the bot has been REJECTING
        // these because Sonnet's confidence lands at 55-65% (below 70% floor) even though
        // the price-implied math says fire. Lower floor to 55% specifically when:
        //   - target = leader (NOT trailing — those are different EV math)
        //   - price ≤ 60¢ (the underpriced band)
        // This unlocks Sonnet-driven trades in the documented +EV cell while keeping the
        // 70% floor in the higher-price band where 60% WR is -EV.
        try {
          const _isLowPriceLeader = targetAbbr === leadingAbbr && price <= 0.60 && price >= 0.40;
          if (_isLowPriceLeader) {
            const lowPriceFloor = 0.55;
            if (effectiveMinConf > lowPriceFloor) {
              console.log(`[live-edge] 💰 LOW-PRICE-LEADER floor: ${targetAbbr} ${league.toUpperCase()} P${period} leader at ${(price*100).toFixed(0)}¢ — floor ${(effectiveMinConf*100).toFixed(0)}% → ${(lowPriceFloor*100).toFixed(0)}% (46-65¢ leader 70-72% WR cell)`);
              effectiveMinConf = lowPriceFloor;
            }
          }
        } catch { /* best-effort */ }

        // 2026-04-29 STRUCTURAL FLOOR BYPASS: structural detectors are mechanical
        // rules with their own internal validation gates. They shouldn't be subject
        // to the same confidence floor as Sonnet judgment trades. Set effective floor
        // to 0 for structural decisions — the detector already gated entry.
        if (item._structuralDecision) {
          effectiveMinConf = 0;
        }
        // EDGE-FIRST LIVE TIER: clear edge in the 50-55¢ underdog band with 63%+ conf bypasses
        // the standard/swing conf floors. Routes through swing path (half size, +12¢ exit).
        // Mirrors the pre-game edge-first tier — same EV math at half-size when market pricing lags.
        const _edgeAbsLive = confidence - price;
        const isEdgeFirstLive = confidence >= 0.63 &&
                                _edgeAbsLive >= 0.10 &&
                                price >= 0.48 && price <= 0.68 &&
                                (confidence < effectiveMinConf || (isSwingMode && confidence < 0.68));
        if (isEdgeFirstLive && !isSwingMode) {
          const openSwingCountEF = openPositions.filter(p => p.strategy === 'live-swing').length;
          if (openSwingCountEF >= 3) {
            console.log(`[live-edge] 🎯 EDGE-FIRST would trigger but max 3 swing positions open — skipping ${targetAbbr}`);
            continue;
          }
          isSwingMode = true;
          console.log(`[live-edge] 🎯 EDGE-FIRST LIVE: ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}) conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ edge=${(_edgeAbsLive*100).toFixed(1)}pt — promoted to swing (half-size, +12¢ exit)`);
        } else if (isEdgeFirstLive) {
          console.log(`[live-edge] 🎯 EDGE-FIRST LIVE: ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}) conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ edge=${(_edgeAbsLive*100).toFixed(1)}pt — bypassing swing 68% floor`);
        }
        if (confidence < effectiveMinConf && !isEdgeFirstLive) {
          const floorNote = priceBandFloor > sportMinConf ? ` [price-band ${priceBand} floor]` : (CAL.minConfidenceLive?.[league] ? ' [calibrated]' : '');
          console.log(`[live-edge] Confidence too low on ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}): ${(confidence*100).toFixed(0)}% < ${(effectiveMinConf*100).toFixed(0)}%${floorNote}`);
          liveEdgeRejectMemo.set(gameBase, { scoreKey: currentScoreKey, period, priceCents: Math.round(price * 100), ts: Date.now() });
          logScreen({ stage: 'live-edge-skip', result: 'skip-conf-low', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, confidence: decision.confidence, targetAbbr, reasoning: `Claude wanted to trade ${targetAbbr} at ${(confidence*100).toFixed(0)}% confidence but floor is ${(effectiveMinConf*100).toFixed(0)}%${floorNote} — ${decision.reasoning?.slice(0, 120) ?? ''}` });
          continue;
        }

        // HARD CAP: Claude can't deviate far from historical baseline
        // Leading team: +10% max (tighter — WE math is reliable for favorites in-game)
        // Trailing team: +15% max (looser — underdog upside needs more room, separate hard caps handle the ceiling)
        // Prevents insanity like "17% baseline → 68% confidence" (Utah @ Calgary)
        let weAtEntry = null;          // WE table value for the specific team we're betting on
        let isLeadingTeamTarget = false; // true = betting the leader, false = betting the underdog
        const baselineWE = getWinExpectancy(league, diff, period, leadingAbbr === homeAbbr);
        if (baselineWE != null) {
          isLeadingTeamTarget = targetAbbr === leadingAbbr;
          const targetBaseline = isLeadingTeamTarget ? baselineWE : (1 - baselineWE);
          weAtEntry = targetBaseline;
          const capMargin = isLeadingTeamTarget ? 0.10 : 0.15; // tighter for leading team
          const maxAllowed = Math.min(0.95, targetBaseline + capMargin);
          if (confidence > maxAllowed) {
            console.log(`[live-edge] Confidence capped on ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}): Claude said ${(confidence*100).toFixed(0)}% but WE baseline is ${(targetBaseline*100).toFixed(0)}% → capped at ${(maxAllowed*100).toFixed(0)}% (leading=${isLeadingTeamTarget})`);
            confidence = maxAllowed;
          }
        }

        // Team-quality haircut: when swinging a small lead, penalize if the trailing team is materially stronger by season record.
        // Why: a .400 team leading a .550 team 1-0 in inning 3 is a mean-reversion trap — market knows this, WE table doesn't.
        if (isSwingMode && isLeadingTeamTarget) {
          const leadRec = leading?.records?.[0]?.summary ?? '';
          const trailRec = trailing?.records?.[0]?.summary ?? '';
          const parseWinPct = (rec) => {
            const m = rec.match(/^(\d+)-(\d+)/);
            if (!m) return null;
            const w = parseInt(m[1], 10), l = parseInt(m[2], 10);
            const total = w + l;
            return total >= 10 ? w / total : null;
          };
          const leadPct = parseWinPct(leadRec);
          const trailPct = parseWinPct(trailRec);
          if (leadPct != null && trailPct != null) {
            const gap = trailPct - leadPct;
            if (gap >= 0.100) {
              const haircut = Math.min(0.05, gap * 0.25);
              console.log(`[live-swing] 📉 Team-quality haircut: leading ${leadingAbbr} (${leadRec}, ${(leadPct*100).toFixed(0)}%) vs trailing ${trailingAbbr} (${trailRec}, ${(trailPct*100).toFixed(0)}%) — trailing stronger by ${(gap*100).toFixed(0)}pt, applying -${(haircut*100).toFixed(1)}pt confidence haircut`);
              confidence -= haircut;
            }
          }
        }

        // Standard live-prediction: block <50¢ entries. Data: 0/4 WR, -$33 on underdog live bets.
        // If sub-50¢ is the right call, swing mode is the vehicle (tighter gates, smaller size, +12¢ exit).
        if (!isSwingMode && price < 0.50) {
          console.log(`[live-edge] BLOCKED ${targetAbbr}: price ${(price*100).toFixed(0)}¢ < 50¢ — underdog live entries have 0% historical WR; route via swing mode`);
          logScreen({ stage: 'live-edge-skip', result: 'skip-underdog-price', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `Entry price ${(price*100).toFixed(0)}¢ below 50¢ floor — underdog live bets have 0-for-4 historical WR. Route via swing mode or skip.` });
          continue;
        }

        // P1.1 — Block late-inning 1-run MLB live-prediction leads.
        // Data (11 historical trades, 36% WR, -$19 net): buying the leader of a 1-run MLB game
        // in innings 7-9 at 62-78¢ (when WE table says 76-87%) has been a net loser. The market
        // is correctly pricing bullpen-collapse risk at 60-70¢ — our WE table doesn't model it.
        // Losers (LAA-NYY -$18, KC-DET -$18, MIA-ATL -$17) averaged $15; winners averaged $8.
        // The edge we think we have is the edge the market already priced. Just skip the setup.
        if (!isSwingMode && league === 'mlb' && stage === 'late' && Math.abs(diff) <= 1 && targetAbbr === leadingAbbr) {
          console.log(`[live-edge] BLOCKED ${targetAbbr} (MLB late-inning 1-run lead pattern): inning ${period}, diff ${diff}, WE-table overvalues bullpen protection — historical 36% WR, -$19 net. Skipping.`);
          logScreen({ stage: 'live-edge-skip', result: 'skip-mlb-late-1run', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `MLB late-inning 1-run leads: 11 historical trades, 36% WR, -$19 net. Market correctly prices bullpen risk; WE table doesn't.` });
          continue;
        }

        // 2026-04-27 audit: NHL live-prediction surgical block.
        // Real data by period:
        //   P1: 5 trades, 40% WR, -$0.54/trade — block
        //   P2: 2 trades, 50% WR, -$2.83/trade — block
        //   P3: 4 trades, 75% WR, +$1.91/trade — KEEP
        // Shadow data confirms early-period NHL is heavily miscalibrated (Sonnet
        // overconfident by 30-50pts). P3 is where the bot has shown actual edge.
        // Don't pause NHL entirely; just keep the winning sub-cell.
        if (!isSwingMode && league === 'nhl' && (period === 1 || period === 2) && targetAbbr === leadingAbbr) {
          console.log(`[live-edge] BLOCKED ${targetAbbr}: NHL P${period} live-prediction — historical 40-50% WR (P1: 5 trades, P2: 2 trades). Only P3 has shown edge.`);
          logScreen({ stage: 'live-edge-skip', result: 'skip-nhl-early-period', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `NHL early-period live-prediction historical: P1 40% WR, P2 50% WR, both net negative. Only P3 (75% WR) is profitable.` });
          continue;
        }

        // 2026-04-30: NHL hard gates — total NHL P&L is -$34.79 over 40 trades (41% WR
        // live-prediction). Shadow cell data shows market systematically overprices
        // NHL leaders: p2-d1 settles 56% @ 71¢ (-15pt edge), p3-d1 settles 59% @ 78¢
        // (-19pt edge). The earlier P3 carve-out was based on n=4 trade luck — real
        // n=37 shadow data shows P3 is a trap too. Tightening:
        //   - price cap 60¢ (avoid the 71-80¢ kill zone)
        //   - conf floor 78% (filter low-conviction)
        //   - P3 block (highest-variance period; shadow proves trap)
        if (!isSwingMode && league === 'nhl' && targetAbbr === leadingAbbr) {
          if (price > 0.60) {
            console.log(`[live-edge] BLOCKED ${targetAbbr}: NHL leader price ${(price*100).toFixed(0)}¢ > 60¢ — shadow data shows -$0.15 EV/contract above 70¢ entries`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-nhl-price-cap', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `NHL leader at ${(price*100).toFixed(0)}¢ above 60¢ cap — shadow shows systematic overpricing in this band.` });
            continue;
          }
          const nhlConf = decision.confidence ?? 0;
          if (nhlConf < 0.78) {
            console.log(`[live-edge] BLOCKED ${targetAbbr}: NHL leader conf ${(nhlConf*100).toFixed(0)}% < 78% floor — sport bleeds at lower conviction`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-nhl-conf-floor', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `NHL conf ${(nhlConf*100).toFixed(0)}% below 78% floor.` });
            continue;
          }
          if (period === 3) {
            console.log(`[live-edge] BLOCKED ${targetAbbr}: NHL P3 live-prediction — shadow n=37 shows 59% WR @ 78¢ = -19pt edge. Highest-variance period.`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-nhl-p3-block', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `NHL P3 shadow data: n=37, 59% WR @ 78¢, -19pt edge. Empty net + late-game variance.` });
            continue;
          }
        }

        // 2026-04-27 audit: MLB live-prediction inning 9 has 0/4 historical (-$27.52).
        // Closer-vs-trailing variance is too high; even 2-3 run leads can flip on a single
        // inning. The 1-run block above catches some but inning 9 with any lead size has
        // been a net loser. Block all inning 9 live-prediction entries (swing mode allowed
        // since it has its own +12¢ exit logic that doesn't depend on settlement).
        if (!isSwingMode && league === 'mlb' && period === 9 && targetAbbr === leadingAbbr) {
          console.log(`[live-edge] BLOCKED ${targetAbbr}: MLB inning 9 live-prediction — 0/4 historical, all losses. Closer/trailing-team variance too high.`);
          logScreen({ stage: 'live-edge-skip', result: 'skip-mlb-9th', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `MLB live-prediction inning 9 historical: 0/4, -$27.52. Blocked.` });
          continue;
        }

        // 2026-04-27 audit: MLB inning 7 live-prediction is 25% WR over n=8, -$45 net. Not
        // as terrible as inning 9 but materially negative. Tighten: require both stronger
        // edge AND higher confidence to enter MLB 7th inning. The remaining trades passing
        // this gate are the highest-conviction ones where we still want to participate.
        if (!isSwingMode && league === 'mlb' && period === 7 && targetAbbr === leadingAbbr) {
          const edge7 = (decision.confidence ?? 0) - price;
          const conf7 = decision.confidence ?? 0;
          if (edge7 < 0.12 || conf7 < 0.80) {
            console.log(`[live-edge] BLOCKED ${targetAbbr}: MLB inning 7 live-prediction requires edge≥12pt AND conf≥80% (got edge=${(edge7*100).toFixed(0)}pt conf=${(conf7*100).toFixed(0)}%) — historical 25% WR over 8 trades, tightening`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-mlb-7th-thin', ticker, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, price, targetAbbr, reasoning: `MLB inning 7 live-prediction needs edge≥12pt AND conf≥80% — 25% WR / -$45 historical at lower thresholds.` });
            continue;
          }
        }

        // Swing mode: entry price must be ≤60¢ and confidence ≥72%
        // 2026-04-30: tightened from ≤65¢ / ≥68% — recent 8-game sample showed 33% gWR
        // and clipped mean −$2.31 (worst-performing strategy by clipped mean).
        // 2026-05-02: BYPASS swing-mode caps for STRUCTURAL detector matches.
        // Score-event-arb fired on TB at 64¢ but was blocked by 60¢ swing cap.
        // Structural detectors have their own per-cell caps; they should override
        // generic swing-mode price/confidence floors.
        if (isSwingMode && !item._structuralDecision) {
          if (price > 0.60) {
            console.log(`[live-swing] BLOCKED ${targetAbbr}: price ${(price*100).toFixed(0)}¢ > 60¢ cap for swing trades`);
            continue;
          }
          if (confidence < 0.72 && !isEdgeFirstLive) {
            console.log(`[live-swing] BLOCKED ${targetAbbr}: confidence ${(confidence*100).toFixed(0)}% < 72% min for swing trades`);
            continue;
          }
        }

        // Dynamic margin — sport-aware, price-aware, situation-aware
        // Swing mode uses 3% floor (we exit at +12¢, not settlement — tighter edge OK).
        // Standard mode uses 4% floor.
        let reqMargin = Math.max(isSwingMode ? 0.03 : 0.04, getRequiredMargin(price, {
          sport: league, live: true,
          scoreChanged: !!item._scoreChanged,
          lineMove: !!item._lineMove,
          lineMoveConfirming: item._lineMove?.confirming === true,
          lineMoveContra:     item._lineMove?.confirming === false && !!item._lineMove,
          lineMoveVelocity:   item._lineMove?.velocity ?? 0,
          crossConfirmed:     item._lineMove?.crossConfirmed === true,
        }));
        // NBA Q4 time-aware floor (LAL@HOU 4/24 -$3.84 lesson):
        // 7-pt lead with 11:30 left in Q4 had thin 4pt edge but ~25 possessions of variance
        // remaining. Late-game NBA leads compress in WR variance only as time decays. Require
        // 6pt edge minimum when >8min left in Q4, easing back to 4pt under 4min.
        if (league === 'nba' && period === 4 && !isSwingMode) {
          const minMatch = (gameDetail ?? '').match(/^(\d{1,2}):(\d{2})/);
          const minsLeft = minMatch ? parseInt(minMatch[1], 10) + parseInt(minMatch[2], 10) / 60 : null;
          if (minsLeft != null && minsLeft > 8) {
            reqMargin = Math.max(reqMargin, 0.06);
            console.log(`[live-edge] NBA Q4 time-floor (${minsLeft.toFixed(1)}min left): edge floor raised to 6pt`);
          } else if (minsLeft != null && minsLeft > 4) {
            reqMargin = Math.max(reqMargin, 0.05);
          }
        }
        const rawEdge = confidence - price;
        if (rawEdge < reqMargin) {
          console.log(`[live-edge] Not enough margin on ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}): conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ edge=${(rawEdge*100).toFixed(1)}% need=${(reqMargin*100).toFixed(0)}%`);
          continue;
        }

        // 🛑 EDGE × CONFIDENCE GATE (2026-04-28 from cross-tab audit n=174 settled trades):
        // Specific (edge × confidence) cells are statistically losing despite passing
        // individual confidence floor and margin checks. Most damaging cell:
        //   edge ≥ 15pt × conf 66-70%: n=35, -$76.19 (the bot's biggest single bleeder)
        // Sonnet over-claims edge magnitude when confidence is mid (66-70%); the
        // implied "huge edge" is delusional. Bypass these cells. Bypass also for:
        //   edge 5-9pt × conf 66-75% (combined n=24, -$63)
        //   edge 0-4pt × conf 76-80% (n=9, -$13) — high-conf thin-edge trap
        // Structural-detector trades EXCLUDED (they're mechanical, not Sonnet-driven).
        // Bug fix 2026-04-29: was referencing _structuralDecision but at this scope
        // the variable is item._structuralDecision (we're in the post-Sonnet processing
        // loop, not the candidate-build loop). Caused ReferenceError that crashed
        // a real MIL structural fire (89% conf 21pt edge — missed +EV trade).
        if (!item._structuralDecision) {
          const edgePct = rawEdge * 100;
          const confPct = confidence * 100;
          let blockReason = null;
          if (edgePct >= 15 && confPct < 71) {
            blockReason = `edge ${edgePct.toFixed(0)}pt × conf ${confPct.toFixed(0)}% — historical -$76 over n=35 (Sonnet over-claims edge at mid conf)`;
          } else if (edgePct >= 5 && edgePct < 10 && confPct < 76) {
            blockReason = `edge ${edgePct.toFixed(0)}pt × conf ${confPct.toFixed(0)}% — historical -$63 over n=24 (mid-conf thin-edge trap)`;
          } else if (edgePct < 5 && confPct >= 76 && confPct < 81) {
            blockReason = `edge ${edgePct.toFixed(0)}pt × conf ${confPct.toFixed(0)}% — historical -$13 over n=9 (high-conf thin-edge trap)`;
          } else if (edgePct >= 15 && confPct >= 80) {
            blockReason = `edge ${edgePct.toFixed(0)}pt × conf ${confPct.toFixed(0)}% — historical -$29 over n=6 (Sonnet over-confident on huge claimed edge)`;
          }
          if (blockReason) {
            console.log(`[live-edge] 🛑 EDGE×CONF GATE: ${targetAbbr} blocked — ${blockReason}`);
            logScreen({ stage: 'live-edge-skip', result: 'skip-edge-conf-trap', ticker, league, homeAbbr, awayAbbr, diff, period, price, confidence, edge: edgePct, targetAbbr, reasoning: blockReason });
            continue;
          }
        }

        const edge = confidence - price;

        console.log(`[live-edge] ✅ ${targetAbbr} (${league.toUpperCase()} ${awayAbbr}@${homeAbbr}) PASSED margin: conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ edge=${(edge*100).toFixed(1)}% — checking risk gates...`);

        // Risk checks
        if (!canTrade()) { console.log(`[live-edge] BLOCKED ${targetAbbr}: canTrade() failed`); continue; }

        // Stop-lock check — blocks BOTH sides of a game for 30 min after any stop-loss.
        // Persisted across restarts so a quick bot restart doesn't clear the protection.
        const liveEdgeBase = ticker.lastIndexOf('-') > 0 ? ticker.slice(0, ticker.lastIndexOf('-')) : ticker;
        const lockUntil = stopLocks.get(liveEdgeBase);
        if (lockUntil && Date.now() < lockUntil) {
          const minsLeft = Math.ceil((lockUntil - Date.now()) / 60000);
          console.log(`[live-edge] 🔒 BLOCKED ${targetAbbr}: stop-lock on ${liveEdgeBase} — ${minsLeft}min remaining (no re-entry either side after stop)`);
          continue;
        }

        // === CROSS-PLATFORM PRICE CHECK — buy on cheaper platform ===
        const polyMoneylines = await getPolyMoneylines();
        const polyMatch = findPolyMarketForGame(homeAbbr, awayAbbr, polyMoneylines, league);
        const best = pickBestPlatform('yes', price, polyMatch, targetAbbr);

        // Use the better price for sizing
        const bestPrice = best.price;
        const bestEdge = confidence - bestPrice;
        if (confidence - bestPrice < reqMargin) { console.log(`[live-edge] BLOCKED ${targetAbbr}: cross-platform recheck failed (bestPrice=${(bestPrice*100).toFixed(0)}¢)`); continue; }

        // Check for high-conviction tier (late-game blowouts → 25-30% sizing)
        // Determine game stage from period (ctx is not available in live-edge — it's from managePositions)
        const liveStage = league === 'mlb' ? (period <= 4 ? 'early' : period <= 6 ? 'mid' : 'late') :
          league === 'nba' ? (period <= 2 ? 'early' : period === 3 ? 'mid' : 'late') :
          league === 'nhl' ? (period === 1 ? 'early' : period === 2 ? 'mid' : 'late') :
          period === 1 ? 'early' : 'late';
        const hcCheck = isSwingMode ? { isHighConv: false } : checkHighConviction(confidence, league, liveStage, diff, period, bestPrice);
        let maxBetLE = hcCheck.isHighConv
          ? getPositionSize(best.platform, bestEdge, hcCheck.tier, league, bestPrice)
          : getPositionSize(best.platform, bestEdge, 0, league, bestPrice);
        if (isSwingMode) maxBetLE = Math.floor(maxBetLE * 0.5); // half sizing for swing trades
        if (reentryHalfSize) maxBetLE = Math.floor(maxBetLE * 0.5); // half sizing for 3rd/4th entry on same game

        // 2026-04-30 GRANULAR BUCKET THROTTLE: catches sport×strategy×edge×conf
        // bucket combos that are documented losers. The coarse sport×strategy
        // throttle averages bad cells with profitable ones and misses them.
        // Only applies to non-structural trades — structural detectors have
        // synthetic confidence values that don't map to real conf bands cleanly.
        if (!item._structuralDecision) {
          const _granStrategy = isThesisVindicated ? 'thesis-reentry'
            : isSwingMode ? 'live-swing'
            : hcCheck.isHighConv ? 'high-conviction'
            : 'live-prediction';
          const _granMult = getGranularBucketThrottle(league, _granStrategy, bestEdge, confidence);
          if (_granMult < 1) {
            const before = maxBetLE;
            maxBetLE = Math.floor(maxBetLE * _granMult);
            if (_granMult === 0) {
              console.log(`[live-edge] 🚫 GRANULAR FREEZE: ${targetAbbr} (${league.toUpperCase()}) — bucket auto-frozen, blocking trade`);
              continue;
            }
            console.log(`[sizing] 🎯 GRANULAR THROTTLE ${(_granMult*100).toFixed(0)}%: $${before.toFixed(2)} → $${maxBetLE.toFixed(2)}`);
          }
        }

        // 2026-04-29 — STRUCTURAL DETECTOR KELLY OVERRIDE.
        // Auto-cal kellyFraction is calibrated against SONNET trade performance. Structural
        // detectors are pure rules-based (period × score × price); they don't depend on
        // Sonnet judgment, so applying Sonnet-derived Kelly throttles to them is wrong.
        // Restore the throttled portion. Example: MLB Kelly is 0.25 (auto-cal). Default
        // is 0.50, so kellyMult = 0.5 → halves all MLB sizing. Structural trades undo this.
        if (item._structuralDecision && !hcCheck.isHighConv) {
          const _baseKelly = 0.50;
          const _calKelly = (typeof CAL.kellyFraction?.[league] === 'number') ? CAL.kellyFraction[league] : _baseKelly;
          const _kellyMult = _calKelly / _baseKelly;
          if (_kellyMult > 0 && _kellyMult < 1) {
            const before = maxBetLE;
            maxBetLE = Math.floor(maxBetLE / _kellyMult);
            console.log(`[sizing] 🎯 STRUCTURAL KELLY-OVERRIDE: $${before.toFixed(2)} → $${maxBetLE.toFixed(2)} (${league.toUpperCase()} kelly ${_calKelly} restored to ${_baseKelly} for rules-based detector)`);
          }
        }

        // 2026-04-29 — CELL-BASED SIZING MULTIPLIER:
        //   Boost: NBA Q4 leader structural detectors (89% WR proven cell) → 1.5x
        //   Cut:   MLB inn 7+ AND NBA Q3 (losing cells) → 0.25x quarter-size
        //   Both apply only to NON-swing/NON-HC trades (existing modifiers don't stack).
        {
          const _structPattern = item._structuralDecision?._structuralPattern ?? '';
          // 1.5x boost on documented jackpot cells (≥85% WR proven)
          const isJackpotStructural =
            _structPattern === 'nba-q4-leader' ||              // 100% WR n=6
            _structPattern === 'nba-q4-cold-shooting' ||       // structural pattern
            _structPattern === 'nba-q4-leader-underdog-price' ||  // 100% WR n=3
            _structPattern === 'mlb-inn-6-leader';             // 93% WR n=14 — Phase 4 add
          if (isJackpotStructural && !isSwingMode && !hcCheck.isHighConv) {
            const before = maxBetLE;
            maxBetLE = Math.floor(maxBetLE * 1.5);
            console.log(`[sizing] 🎯 JACKPOT-CELL BOOST 1.5x: $${before.toFixed(2)} → $${maxBetLE.toFixed(2)} (pattern=${_structPattern}, ≥89% WR proven cell)`);
          }
          // Losing-cell quarter-size (only applies to Sonnet-only trades, structural detectors exempt)
          const isLosingCellSonnet = !item._structuralDecision && (
            (league === 'mlb' && period >= 7) ||  // already blocked above but defense-in-depth
            (league === 'nba' && period === 3)    // NBA Q3 was -$11 in 4 trades
          );
          if (isLosingCellSonnet) {
            const before = maxBetLE;
            maxBetLE = Math.max(1, Math.floor(maxBetLE * 0.25));
            console.log(`[sizing] 🧊 LOSING-CELL QUARTER-SIZE: $${before.toFixed(2)} → $${maxBetLE.toFixed(2)} (${league.toUpperCase()}-P${period} historically -EV)`);
          }
        }

        // Tag-credibility BOOST: shadow data 2026-04-27 shows reasoning_tags
        // `we-undervalued` (39 samples, 67% WR) and `market-lag` (44 samples, 61% WR)
        // outperform their cohorts. Apply 1.05-1.15x sizing multiplier when these
        // appear. Capped at 1.15 to avoid runaway sizing on any single signal.
        // Counterpart to evaluateTagCredibility (which BLOCKS bad-tag trades).
        const _liveBoost = evaluateTagBoost(decision.reasoningStructured?.reasoning_tags);
        if (_liveBoost > 1.0) {
          const before = maxBetLE;
          maxBetLE = Math.floor(maxBetLE * _liveBoost);
          console.log(`[sizing] 🎯 TAG BOOST ${_liveBoost.toFixed(2)}x: $${before.toFixed(2)} → $${maxBetLE.toFixed(2)} (tags: ${(decision.reasoningStructured?.reasoning_tags ?? []).join(',')})`);
        }

        // 2026-04-30 — HARD POSITION CAP for NBA/NHL structural detectors.
        // CRITICAL FIX: prior 5% cap in getDynamicMaxTrade was being bypassed because
        // (1) caller didn't pass `strategy`, defaulting to 10% MAX_TRADE_FRACTION, and
        // (2) JACKPOT-CELL BOOST 1.5x + high-conf 2-2.5x multipliers compounded on top.
        // Tonight 2026-04-30 23:40 ET: MIN NBA Q4 sized at $34.81 = 35% of $97 bankroll.
        // Hard cap AFTER all multipliers, no bypass. NBA/NHL = max 5% of bankroll.
        {
          const _structPattern = item._structuralDecision?._structuralPattern ?? '';
          const _isNbaNhlStruct = item._structuralDecision && (_structPattern.startsWith('nba-') || _structPattern.startsWith('nhl-'));
          if (_isNbaNhlStruct) {
            const _hardCapDollars = getBankroll() * 0.05;
            if (maxBetLE > _hardCapDollars) {
              const before = maxBetLE;
              maxBetLE = Math.floor(_hardCapDollars);
              console.log(`[sizing] 🛡️ NBA/NHL HARD CAP 5%: $${before.toFixed(2)} → $${maxBetLE.toFixed(2)} (structural ${_structPattern} on $${getBankroll().toFixed(0)} bankroll)`);
            }
          }
        }

        // 2026-05-01 — NBA LIVE-PREDICTION HIGH-CONF KELLY BUMP.
        // NBA live-prediction has 86% game-WR over 14 trades (+$59.87 cumulative).
        // Kelly criterion says size up on proven edge. At conf ≥80% the trade is
        // high-conviction territory. Raise sizing ceiling from 10% to 13% of bankroll
        // ONLY for NBA live-prediction at conf ≥80%. Doesn't stack with structural cap
        // above (different code paths). Doesn't apply to swing/HC (separate logic).
        if (!item._structuralDecision && !isSwingMode && !hcCheck.isHighConv
            && league === 'nba' && (decision.confidence ?? 0) >= 0.80) {
          const _nbaBumpCeil = getBankroll() * 0.13;
          if (maxBetLE < _nbaBumpCeil) {
            // Only RAISE — never lower. The 10% default cap was already applied by
            // getDynamicMaxTrade. We bump the ceiling without forcing maxBetLE up to it.
            const before = maxBetLE;
            // Apply a 1.3x bump capped at the new 13% ceiling
            maxBetLE = Math.min(_nbaBumpCeil, Math.floor(maxBetLE * 1.3));
            if (maxBetLE > before) {
              console.log(`[sizing] 🏀 NBA HIGH-CONF KELLY BUMP: $${before.toFixed(2)} → $${maxBetLE.toFixed(2)} (live-prediction conf ${((decision.confidence??0)*100).toFixed(0)}%, 86% historical WR)`);
            }
          }
        }

        // 2026-04-29 PROFIT LOCK-IN — protect today's earned gains from a single
        // adverse trade. Once up ≥5% on the day, cap any new trade at 30% of profit.
        // Today's NBA-Q3 ($15.66 deploy → -$10.73 loss) erased 6 prior wins. With
        // this rule, that trade would have been capped at $2.54, loss capped at -$1.74.
        const _profitCap = getProfitLockInCap();
        if (_profitCap != null && maxBetLE > _profitCap) {
          const before = maxBetLE;
          maxBetLE = Math.floor(_profitCap);
          console.log(`[sizing] 🔒 PROFIT LOCK-IN: $${before.toFixed(2)} → $${maxBetLE.toFixed(2)} (capped at 30% of today's $${(getDailyPnLSummary().pnl).toFixed(2)} profit — protects gains from single big loss)`);
        }

        const claudeBet = decision.betAmount ?? 0;
        const safeBet = hcCheck.isHighConv ? maxBetLE : Math.min(claudeBet > 0 ? claudeBet : maxBetLE, maxBetLE);
        if (safeBet < 1) {
          console.log(`[live-edge] BLOCKED ${targetAbbr}: bet too small (max=$${maxBetLE.toFixed(2)} Claude=$${claudeBet})`);
          continue;
        }
        if (!canDeployMore(safeBet)) { console.log(`[live-edge] BLOCKED ${targetAbbr}: deployment cap (safeBet=$${safeBet.toFixed(2)})`); continue; }

        // Scale-in cap re-check with actual bet size — prevents stacking beyond MAX_GAME_EXPOSURE_PCT
        if (hasPosition && !canScaleInto(gameBase, bestPrice, safeBet, currentScoreKey)) {
          const gameExp = gameEntries.get(gameBase);
          console.log(`[live-edge] BLOCKED ${targetAbbr}: scale-in would exceed game cap ($${(gameExp?.totalDeployed ?? 0).toFixed(2)} + $${safeBet.toFixed(2)} > $${(getBankroll() * MAX_GAME_EXPOSURE_PCT).toFixed(2)} cap) or score changed`);
          continue;
        }

        const qty = Math.max(1, Math.floor(safeBet / bestPrice));
        const priceInCents = Math.round(bestPrice * 100);

        // Tier 1: Strategy gating — if auto-calibration disabled this strategy, skip
        const plannedStrategy = isThesisVindicated ? 'thesis-reentry' : isSwingMode ? 'live-swing' : hcCheck.isHighConv ? 'high-conviction' : 'live-prediction';
        if (isStrategyDisabled(plannedStrategy)) {
          console.log(`[live-edge] BLOCKED ${targetAbbr}: strategy "${plannedStrategy}" auto-disabled by calibration (Wilson-CI -EV)`);
          logScreen({ stage: 'live-edge-skip', result: 'skip-strategy-disabled', ticker, reasoning: `strategy ${plannedStrategy} paused by auto-calibration — -EV over ${CAL._tradesAnalyzed ?? '?'} trades` });
          continue;
        }

        // Track high-conviction deployment
        if (hcCheck.isHighConv) {
          lastHighConvictionAt = Date.now();
          highConvictionDeployed += safeBet;
          console.log(`[live-edge] 🔥 HIGH CONVICTION: ${hcCheck.reason}`);
        }

        const hcLabel = hcCheck.isHighConv ? '🔥 HIGH CONVICTION ' : '';
        const platformLabel = best.platform === 'polymarket' ? `POLY (${(price*100).toFixed(0)}¢ Kalshi → ${priceInCents}¢ Poly, saved ${((price-bestPrice)*100).toFixed(0)}¢)` : 'KALSHI';

        // Set cooldowns BEFORE order so a restart mid-execution doesn't lose them
        tradeCooldowns.set(ticker, Date.now());
        tradeCooldowns.set(gameBase, Date.now());
        const matchupKeyCooldown = `game:${homeAbbr}@${awayAbbr}`;
        tradeCooldowns.set(matchupKeyCooldown, Date.now());
        tradeCooldowns.set(`game:${awayAbbr}@${homeAbbr}`, Date.now());

        // Execute the order
        // 2026-04-29 — ORDERBOOK STEP-UP: send yes_price 2¢ above target so the
        // order walks the book and captures liquidity in the [target, target+2¢]
        // band. Kalshi fills at min(yes_price, current_ask), so worst case we pay
        // 2¢ more on contracts that would otherwise not fill. Observed problem
        // (SEA-MIN 4/29): order at exact 63¢ filled only 1 of 5 target contracts
        // before price moved up. Stepping up captures the rest of the orderbook.
        let result, deployed;
        if (best.platform === 'polymarket' && best.slug) {
          result = await polymarketPost(best.slug, best.intent, bestPrice + 0.02, qty);
          deployed = qty * bestPrice;
        } else {
          // 2026-04-29 ADAPTIVE STEP-UP: in fast-moving markets (price climbing
          // 5+¢/min in our direction), the 2¢ default tolerance gets blown past
          // before our order reaches Kalshi. Today's STL: placed at 64¢ (62+2),
          // price was 68¢ within 60s, order never filled. Scale step-up with
          // observed velocity so we still capture the trade.
          let stepUp = 2;
          try {
            const prevSeen = lastSeenPrices.get(ticker);
            if (prevSeen) {
              const elapsedMin = Math.max(0.5, (Date.now() - prevSeen.ts) / 60000);
              const velocityCpm = ((bestPrice - prevSeen.price) * 100) / elapsedMin; // ¢/min in our buy direction
              if (velocityCpm >= 8) stepUp = 7;
              else if (velocityCpm >= 5) stepUp = 5;
              else if (velocityCpm >= 3) stepUp = 3;
              if (stepUp > 2) {
                console.log(`[live-edge] 🌊 FAST-MARKET step-up: ${ticker} velocity=${velocityCpm.toFixed(1)}¢/min → step-up ${stepUp}¢ (was 2¢)`);
              }
            }
          } catch { /* fall back to 2¢ */ }
          const stepUpPrice = Math.min(99, priceInCents + stepUp);
          result = await kalshiPost('/portfolio/orders', {
            ticker, action: 'buy', side: 'yes', count: qty,
            yes_price: stepUpPrice,
          });
          deployed = qty * bestPrice;
        }

        if (result.ok) {
          let actualFill = getActualFill(result, qty);
          // 2026-04-29 PHANTOM-TRADE PREVENTION: getActualFill returns requestedQty
          // when Kalshi reports 0 fills (because most orders eventually fill).
          // BUT in a fast-moving market the limit order can rest unfilled. Today's
          // STL @62¢ logged 16 contracts filled but Kalshi position was 0 — phantom
          // trade with $2.40 of fake P&L. Verify position before logging.
          const reportedFill = parseFloat(result.data?.order?.fill_count_fp ?? '0') || 0;
          if (reportedFill === 0 && best.platform !== 'polymarket') {
            // Kalshi reported 0 — position-check to confirm before logging
            try {
              await new Promise(r => setTimeout(r, 1500)); // brief delay for fill registration
              const posCheck = await kalshiGet(`/portfolio/positions?ticker=${ticker}`);
              const mktPos = (posCheck.market_positions ?? []).find(p => p.ticker === ticker);
              const realPos = Math.max(0, parseFloat(mktPos?.position_fp ?? '0'));
              if (realPos === 0) {
                // 2026-05-01 BUGFIX: previously we just gave up here. The order
                // remained resting in Kalshi's orderbook and could fill HOURS
                // later → orphan position bot can't manage. Real incident:
                // ORL 7:45 PM order rested 1h 18min, filled at 9:03 PM. Bot then
                // double-bought via structural detector. Now: actively CANCEL
                // the order. If cancel races with fill, adopt the fill.
                const orderId = result.data?.order?.order_id ?? result.data?.id;
                let outcomeHandled = false;
                if (orderId) {
                  try {
                    const cancelRes = await kalshiDelete(`/portfolio/orders/${orderId}`);
                    if (cancelRes.ok || cancelRes.status === 404) {
                      console.log(`[live-edge] 🚫 PHANTOM CANCELLED: ${ticker} order ${orderId} (limit ${(bestPrice*100).toFixed(0)}¢) cancelled before it could rest-fill`);
                      outcomeHandled = true;
                    } else {
                      // Cancel non-200 — possible race with fill. Re-check position.
                      await new Promise(r => setTimeout(r, 500));
                      const recheck = await kalshiGet(`/portfolio/positions?ticker=${ticker}`);
                      const newMktPos = (recheck.market_positions ?? []).find(p => p.ticker === ticker);
                      const newPos = Math.max(0, parseFloat(newMktPos?.position_fp ?? '0'));
                      if (newPos > 0) {
                        actualFill = newPos;
                        console.log(`[live-edge] ✓ ADOPTED late fill: ${ticker} ${actualFill} contracts (cancel raced with fill)`);
                        // fall through to log this as a real trade below
                      } else {
                        // Cancel failed AND still no position — track for reconciliation
                        const _structPattern = item._structuralDecision?._structuralPattern ?? null;
                        phantomOrderTracker.set(orderId, {
                          ticker, attemptedQty: qty, price: bestPrice, ts: Date.now(),
                          league, confidence,
                          strategy: _structPattern ? `structural-${_structPattern}` : (isSwingMode ? 'live-swing' : 'live-prediction'),
                        });
                        console.log(`[live-edge] ⚠️ PHANTOM TRACKED for reconciliation: ${ticker} order ${orderId} (cancel failed, position 0) — sync will adopt if it fills later`);
                        outcomeHandled = true;
                      }
                    }
                  } catch (cancelErr) {
                    console.log(`[live-edge] Cancel error for ${orderId}: ${cancelErr.message} — tracking for reconciliation`);
                    const _structPattern2 = item._structuralDecision?._structuralPattern ?? null;
                    phantomOrderTracker.set(orderId, {
                      ticker, attemptedQty: qty, price: bestPrice, ts: Date.now(),
                      league, confidence,
                      strategy: _structPattern2 ? `structural-${_structPattern2}` : (isSwingMode ? 'live-swing' : 'live-prediction'),
                    });
                    outcomeHandled = true;
                  }
                } else {
                  console.log(`[live-edge] 🚫 PHANTOM (no order ID): ${ticker} — cannot cancel, hoping for the best`);
                  outcomeHandled = true;
                }
                if (outcomeHandled) continue;
                // else fall through to log as adopted late fill (actualFill set above)
              } else {
                // Position exists — use the actual count
                actualFill = realPos;
                console.log(`[live-edge] ✓ Position-check confirmed: ${ticker} actual fill = ${actualFill} contracts`);
              }
            } catch (e) {
              // On error, fall back to assumed full fill (current behavior, slightly risky)
              console.log(`[live-edge] Position-check failed for ${ticker}: ${e.message} — assuming full fill`);
            }
          }
          if (actualFill <= 0) {
            console.log(`[live-edge] Order accepted but 0 filled for ${ticker} — skipping log`);
            continue;
          }
          const actualDeployed = actualFill * bestPrice;
          stats.tradesPlaced++;

          // Log TRADE only AFTER confirmed fill — prevents phantom trades in the
          // live scouting display when orders fail (503, no liquidity, etc.)
          console.log(`[live-edge] 🎯 ${hcLabel}TRADE on ${platformLabel}: ${ticker} ${targetAbbr} YES @${priceInCents}¢ × ${actualFill} conf=${(confidence*100).toFixed(0)}%`);
          console.log(`  Score: ${awayAbbr} ${awayScore} @ ${homeAbbr} ${homeScore} (${gameDetail})`);
          console.log(`  Reason: ${decision.reasoning}`);
          logScreen({ stage: 'live-edge', ticker, result: 'TRADE', confidence, price: bestPrice, platform: best.platform, reasoning: decision.reasoning, league, homeAbbr, awayAbbr, homeScore, awayScore, diff, period, gameDetail, targetAbbr });
          recordGameEntry(gameBase, bestPrice, actualDeployed, currentScoreKey); // use ticker base as canonical key, store score for scale-in gate

          // Recent-crash tag — flags entries placed shortly after a high-velocity
          // contra crash on the same ticker. Pure observation; no behavioral change.
          // Hypothesis under test: WHU/EVE 4/25 — bot bought during a 80→50→65→84
          // recovery whipsaw, EVE actually scored 2 min later. Did we get bailed out
          // by luck (WHU scored 2-1 right before our profit-lock) or is "buying the
          // recovery from a head-fake crash" systematically OK? n=1 isn't enough.
          // Threshold: velocity ≥15¢/min within last 90s. Captures real volatility,
          // skips routine 5¢/min noise.
          let recentCrashContext = null;
          {
            const cm = recentCrossContraMovers.get(ticker);
            if (cm) {
              const ageSec = (Date.now() - cm.when) / 1000;
              if (ageSec <= 90 && cm.velocity >= 15) {
                recentCrashContext = {
                  velocity: Math.round(cm.velocity * 10) / 10,
                  ageSec: Math.round(ageSec),
                  when: new Date(cm.when).toISOString(),
                };
              }
            }
          }
          // RLM proxy: extends crash context with direction relative to entry +
          // last-60s velocity. Pure telemetry — validated against CLV in 2-4 weeks.
          const rlmContext = getLiveMoveContext(ticker, 'yes', bestPrice);
          logTrade({
            exchange: best.platform,
            strategy: item._structuralDecision ? `structural-${item._structuralDecision._structuralPattern}` : isThesisVindicated ? 'thesis-reentry' : isSwingMode ? 'live-swing' : hcCheck.isHighConv ? 'high-conviction' : 'live-prediction',
            ticker: best.platform === 'polymarket' ? best.slug : ticker,
            title, side: 'yes',
            quantity: actualFill, entryPrice: bestPrice, deployCost: actualDeployed,
            filled: actualFill,
            highConviction: hcCheck.isHighConv || undefined,
            orderId: (result.data?.order ?? result.data)?.order_id ?? result.data?.id ?? null,
            edge: bestEdge * 100, confidence,
            reasoning: decision.reasoning,
            reasoningStructured: decision.reasoningStructured ?? null,
            liveScore: `${awayAbbr} ${awayScore} - ${homeAbbr} ${homeScore} (${gameDetail})`,
            otherPlatformPrice: best.platform === 'polymarket' ? price : (polyMatch?.s0Price ?? null),
            // Calibration fields — used by calibrate.mjs to measure prediction accuracy
            league,
            scoreDiff: diff,
            periodAtEntry: period,
            liveStageAtEntry: liveStage,
            weAtEntry,                          // WE table's prediction for this team (null if no table entry)
            isLeadingTeam: isLeadingTeamTarget, // true = betting leader, false = betting underdog
            recentCrashContext,                  // null or {velocity, ageSec, when} — see WAITLIST.md
            rlmContext,                          // null or {recentCrash, last60s, directionRelativeToEntry} — RLM proxy telemetry
          });
          if (recentCrashContext) {
            console.log(`[live-edge] 🏷️ TAGGED recent-crash entry: ${ticker} bought ${recentCrashContext.ageSec}s after ${recentCrashContext.velocity}¢/min crash`);
          }

          // Clear thesis-vindicated flag after successful re-entry (one shot only)
          if (isThesisVindicated) {
            stoppedBets.delete(gameBase);
            saveState();
            console.log(`[live-edge] 🔁 Thesis-vindicated re-entry complete on ${gameBase} — cleared stoppedBets`);
          }

          const isStructuralMatch = !!item._structuralDecision;
          if (isStructuralMatch) {
            recordStructuralEntry({
              league: item.league,
              strategy: `structural-${item._structuralDecision._structuralPattern}`,
              ticker,
              entryPrice: bestPrice,
            });
          }
          const betLabel = isStructuralMatch ? `STRUCTURAL — ${item._structuralDecision._structuralPattern.toUpperCase()}` :
            isThesisVindicated ? 'THESIS RE-ENTRY' :
            isSwingMode ? 'SWING TRADE' :
            hcCheck.isHighConv ? '🔥 HIGH CONVICTION' :
            targetAbbr === leadingAbbr ? 'LIVE — LEADER' : 'LIVE — UNDERDOG';
          const stratTag = isStructuralMatch ? `structural-${item._structuralDecision._structuralPattern}`
            : isThesisVindicated ? 'thesis-reentry'
            : isSwingMode ? 'live-swing'
            : hcCheck.isHighConv ? 'high-conviction'
            : 'live-prediction';
          // 2026-04-29: enrich structural reasoning. Sonnet trades have rich context
          // in edge_argument; structural trades have generic template text. For structural,
          // concatenate edge_argument + first 2 key_facts + conviction so the Telegram
          // notification surfaces specifics (period, score-diff, edge math, why-this-pattern).
          let _notifReason = decision.reasoningStructured?.edge_argument ?? decision.reasoning;
          if (isStructuralMatch) {
            const _rs = decision.reasoningStructured ?? {};
            const _facts = Array.isArray(_rs.key_facts) ? _rs.key_facts.slice(0, 2).join(' · ') : '';
            const _conv = _rs.conviction ?? '';
            const _parts = [_rs.edge_argument, _facts, _conv].filter(Boolean);
            if (_parts.length) _notifReason = _parts.join(' — ');
          }
          await tgTradeEntry({
            kind: betLabel,
            title: title,
            gameLine: `${awayAbbr} ${awayScore} - ${homeAbbr} ${homeScore} · ${gameDetail}`,
            team: targetAbbr,
            price: bestPrice,
            qty: actualFill,
            deployed: actualDeployed,
            conf: confidence,
            edge: (confidence - bestPrice) * 100,
            reason: _notifReason,
            strategyTag: stratTag,
            isStructural: isStructuralMatch,
          });
          // Deduct from cached balance so subsequent orders this cycle are aware
          kalshiBalance = Math.max(0, kalshiBalance - actualDeployed);
        } else {
          console.error(`[live-edge] Order failed:`, result.status, JSON.stringify(result.data));
        }
      } catch (e) {
        console.error(`[live-edge] error processing ${item.homeAbbr}@${item.awayAbbr}:`, e.message, '\n', e.stack);
        await reportError('live-edge:process-crash', `${item.homeAbbr}@${item.awayAbbr} ${item.league?.toUpperCase()}: ${e.message}`);
      }
    }
  }

  // === PHASE 5: Comeback candidates ============================================
  // Buy the TRAILING team when their ace is still on the mound in innings 2-5.
  // Logic: a 1-2 run deficit in early innings with an elite pitcher still going
  // is structurally mispriced. The market overweights the current score and
  // underweights (a) how many innings remain and (b) that the ace will keep it
  // close while the lineup has time to respond. We buy the dip and sell when
  // the team ties or leads — we don't need them to win the full game.
  //
  // Filters: MLB only | innings 2-5 | deficit 1-2 | trailing ERA < 3.5 |
  //          ace confirmed still on mound | price 10-44¢ | no existing position
  if (cachedPrices.size > 0) {
    for (const g of liveGames) {
      try {
        if (g.league !== 'mlb') continue;
        if (g.diff < 1 || g.diff > 2) continue;
        if (g.period < 2 || g.period > 5) continue;

        // Toxic-cell block (2026-05-02): shadow data shows two cells where buying
        // the trailer at 25-40¢ destroys money:
        //   mlb-trail-2run-P2: 20% game-WR n=10, ~0% recover ≥15¢, avg max-rec 2¢
        //   mlb-trail-2run-P4: 10% game-WR n=10, ~0% recover ≥15¢, avg max-rec 1¢
        // Even with ace ERA <3.5 the deficit doesn't shrink — early 2-run holes
        // with no offensive momentum trend toward the trailer losing. Hard skip.
        if (g.diff === 2 && (g.period === 2 || g.period === 4)) continue;

        const trailingIsHome = g.homeScore < g.awayScore;
        const trailingTeam  = trailingIsHome ? g.home : g.away;
        const leadingTeam   = trailingIsHome ? g.away : g.home;
        const trailingAbbr  = trailingTeam.team?.abbreviation ?? '';
        const leadingAbbr   = leadingTeam.team?.abbreviation ?? '';
        if (!trailingAbbr || !leadingAbbr) continue;

        // Need confirmed starter data for trailing team
        const trailingProb = trailingTeam.probables?.[0];
        if (!trailingProb) continue;
        const trailingStarterERA = parseFloat(
          trailingProb.statistics?.find(s => s.abbreviation === 'ERA')?.displayValue ?? '99'
        );
        if (isNaN(trailingStarterERA) || trailingStarterERA > 3.5) continue;
        const trailingStarterName = trailingProb.athlete?.displayName ?? '';
        // Note: situation.pitcher is the FIELDING team's pitcher (whoever is on the mound),
        // NOT necessarily the trailing team's pitcher. In innings 2-5 with ERA < 3.5 and
        // only a 1-2 run deficit, starters almost never get pulled — the inning + ERA
        // filter is sufficient assurance. Explicit pitch-count data isn't in the ESPN
        // probables endpoint, so we skip the unreliable name-match check here.

        // Find trailing team's Kalshi ticker in cached prices
        const trailingTicker = [...cachedPrices.keys()].find(t => {
          const suffix = t.split('-').pop()?.toUpperCase() ?? '';
          return t.startsWith('KXMLBGAME') &&
                 suffix === trailingAbbr.toUpperCase() &&
                 tickerHasTeam(t.toLowerCase(), trailingAbbr) &&
                 tickerHasTeam(t.toLowerCase(), leadingAbbr);
        });
        if (!trailingTicker) continue;

        const trailingPrice = cachedPrices.get(trailingTicker)?.yes ?? 0;
        if (trailingPrice <= 0.10 || trailingPrice > 0.44) continue;

        const trailingBase = trailingTicker.lastIndexOf('-') > 0
          ? trailingTicker.slice(0, trailingTicker.lastIndexOf('-'))
          : trailingTicker;

        // Stop-lock check
        const lockUntil = stopLocks.get(trailingBase);
        if (lockUntil && Date.now() < lockUntil) continue;

        // Existing position check (portfolio + JSONL)
        const hasPortfolioPos = openPositions.some(p => {
          const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
          return pBase === trailingBase;
        });
        if (hasPortfolioPos) continue;

        let hasJsonlPos = false;
        if (existsSync(TRADES_LOG)) {
          try {
            const dupStart = new Date(etNow().toISOString().slice(0,10) + 'T04:00:00Z').getTime();
            const jLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
            for (const l of jLines) {
              try {
                const jt = JSON.parse(l);
                if (jt.status === 'testing-void') continue;
                const jtMs = jt.timestamp ? Date.parse(jt.timestamp) : 0;
                if (jtMs < dupStart) continue;
                if (tickerHasTeam((jt.ticker ?? '').toLowerCase(), trailingAbbr) &&
                    tickerHasTeam((jt.ticker ?? '').toLowerCase(), leadingAbbr)) {
                  hasJsonlPos = true; break;
                }
              } catch {}
            }
          } catch {}
        }
        if (hasJsonlPos) continue;

        // Cooldown: re-evaluate same comeback candidate at most every 8 min
        const cbKey = 'comeback:' + trailingBase;
        if (Date.now() - (tradeCooldowns.get(cbKey) ?? 0) < 8 * 60 * 1000) continue;
        tradeCooldowns.set(cbKey, Date.now());

        const leadingProb       = leadingTeam.probables?.[0];
        const leadingStarterName = leadingProb?.athlete?.displayName ?? 'unknown';
        const leadingStarterERA  = parseFloat(
          leadingProb?.statistics?.find(s => s.abbreviation === 'ERA')?.displayValue ?? '3.5'
        );
        const inningsLeft = 9 - g.period + 1;
        const comebackWinPct = Math.round(
          (1 - (getWinExpectancy('mlb', g.diff, g.period, !trailingIsHome) ?? 0.65)) * 100
        );

        // KALSHI-ESPN SYNC CHECK: If Kalshi's leading-team price implies a win prob
        // 12+ points higher than ESPN's game state would predict, ESPN is lagging real-time
        // scoring. Skip and wait for ESPN to catch up — the "edge" is just a data artifact.
        // Example: ESPN says 0-1 (comebackWinPct=31% → leading team should be ~69¢) but
        // Kalshi is pricing WSH at 84¢ (15-point gap) → WSH already scored more runs.
        const leadingTicker = [...cachedPrices.keys()].find(t =>
          t.startsWith('KXMLBGAME') &&
          tickerHasTeam(t.toLowerCase(), leadingAbbr) &&
          tickerHasTeam(t.toLowerCase(), trailingAbbr)
        );
        const leadingKalshiPrice = leadingTicker ? (cachedPrices.get(leadingTicker)?.yes ?? 0) : 0;
        const kalshiLeadingPct  = Math.round(leadingKalshiPrice * 100);
        const espnLeadingPct    = 100 - comebackWinPct;
        if (leadingKalshiPrice > 0 && (kalshiLeadingPct - espnLeadingPct) >= 12) {
          console.log(`[comeback] ⚠️ Skip ${trailingAbbr}: Kalshi/ESPN mismatch — Kalshi prices ${leadingAbbr} at ${kalshiLeadingPct}¢ but ESPN model says ${espnLeadingPct}¢ (${kalshiLeadingPct - espnLeadingPct}pt gap) — ESPN lagging, waiting for sync`);
          continue;
        }

        // ENTRY WE FLOOR: don't enter if price is already below the WE-reversal exit floor (30%).
        // SF@WSH entered at 16¢ (below the 30% exit floor) → immediately sold 3 min later at break-even.
        // A 25¢ minimum ensures we have room to run before the exit floor kicks in.
        if (trailingPrice < 0.25) {
          console.log(`[comeback] ⚠️ Skip ${trailingAbbr}: price ${Math.round(trailingPrice*100)}¢ < 25¢ minimum — already near WE exit floor, no room to run`);
          continue;
        }

        // Code gate: trailing team's starter ERA > 5.5 means their pitcher is actively
        // giving up runs — the deficit will grow, not shrink. No comeback edge.
        if (!isNaN(parseFloat(trailingStarterERA)) && parseFloat(trailingStarterERA) > 5.5) {
          console.log(`[comeback] 🚫 Skip ${trailingAbbr}: trailing starter ${trailingStarterName} ERA ${trailingStarterERA} > 5.5 — deficit likely to grow, not shrink`);
          continue;
        }

        console.log(`[comeback] 🔄 Candidate: ${trailingAbbr} trailing ${g.awayScore}-${g.homeScore} inn${g.period} | trailing starter ${trailingStarterName} (${trailingStarterERA} ERA) | opp starter ${leadingStarterName} (${leadingStarterERA} ERA) | ${inningsLeft} innings left | ${Math.round(trailingPrice*100)}¢ vs model ${comebackWinPct}%`);

        // Sonnet evaluation — lightweight, no web search needed
        const cbPrompt =
          `You are a baseball swing trader evaluating a mid-game comeback bet.\n\n` +
          `GAME: ${trailingAbbr} trailing ${leadingAbbr} | Score: ${g.awayScore}-${g.homeScore} | Inning: ${g.period} of 9\n` +
          `Innings remaining: ~${inningsLeft}\n` +
          `Market prices ${trailingAbbr} YES at ${Math.round(trailingPrice*100)}¢ (implies ${Math.round(trailingPrice*100)}% win probability)\n` +
          `Statistical comeback rate for this deficit/inning: ${comebackWinPct}%\n\n` +
          `PITCHER DATA (ESPN confirmed):\n` +
          `${trailingAbbr} starter (OUR team, the one we're betting on): ${trailingStarterName} ERA ${trailingStarterERA}\n` +
          `  → This ERA tells you whether OUR pitcher can hold the deficit from growing. Low ERA = deficit stable. High ERA = deficit likely widens.\n` +
          `${leadingAbbr} starter (OPPONENT, the team we're betting against): ${leadingStarterName} ERA ${leadingStarterERA}\n` +
          `  → This ERA tells you whether OUR offense can score. High opponent ERA = our lineup can break through. Low opponent ERA = hard to score.\n\n` +
          `STRATEGY: We buy the trailing team NOW and SELL when they tie or take the lead — price spikes from ${Math.round(trailingPrice*100)}¢ back to 48-56¢. We do NOT hold to settlement.\n\n` +
          `HARD NOs:\n` +
          `❌ ${inningsLeft} innings remaining is not realistically enough for a ${g.diff}-run comeback given lineup quality → NO\n` +
          `❌ Leading team has a dominant closer (ERA < 2.0) who will enter in the 8th/9th regardless → NO if inning ≥ 5\n` +
          `❌ The ${comebackWinPct}% comeback rate is already priced in at ${Math.round(trailingPrice*100)}¢ (gap < 5pts) → NO\n` +
          `❌ Our starter ERA is high (already filtered above 5.5) — but if ERA is 4.5-5.5, be very skeptical: deficit will likely grow before it shrinks → lean NO\n\n` +
          `BUY signal: Our starter keeping it close (ERA < 4.0) + opponent starter is hittable (ERA > 4.5) + innings available + market underprices base rate by ≥ 5pts\n\n` +
          `JSON only:\n` +
          `{"trade":false,"confidence":0.XX,"reasoning":"one sentence"}\n` +
          `{"trade":true,"confidence":0.XX,"reasoning":"one sentence — cite which pitcher ERA creates the edge and why"}`;

        const cbText = await claudeSonnet(cbPrompt, { maxTokens: 250, timeout: 15000, category: 'comeback' });
        if (!cbText) continue;
        const cbMatch = extractJSON(cbText);
        if (!cbMatch) continue;
        let cbDecision;
        try { cbDecision = JSON.parse(cbMatch); } catch (e) { await reportError('comeback:parse-fail', `${e.message} | head=${cbMatch.slice(0, 120)}`); continue; }

        const cbConf = cbDecision.confidence ?? 0;
        const cbEdge = cbConf - trailingPrice;

        if (!cbDecision.trade || cbConf < 0.62 || cbEdge < 0.05) {
          console.log(`[comeback] ❌ Pass on ${trailingAbbr}: conf=${Math.round(cbConf*100)}% edge=${Math.round(cbEdge*100)}pts | ${cbDecision.reasoning?.slice(0,80)}`);
          continue;
        }

        console.log(`[comeback] ✅ BUY ${trailingAbbr} @ ${Math.round(trailingPrice*100)}¢ | conf=${Math.round(cbConf*100)}% edge=+${Math.round(cbEdge*100)}pts | ${cbDecision.reasoning?.slice(0,80)}`);

        // Size conservatively — comeback has higher variance than leading-team bets
        const cbMaxTrade = Math.min(getBankroll() * 0.08, getAvailableCash('kalshi'));
        const cbQty = Math.max(1, Math.round(Math.min(getPositionSize('kalshi', cbEdge, 0, g.league) * 0.60, cbMaxTrade) / trailingPrice));
        const cbBetAmount = cbQty * trailingPrice;
        if (cbBetAmount < 5) { console.log(`[comeback] Bet too small ($${cbBetAmount.toFixed(2)}), skipping`); continue; }

        const priceInCents = Math.round(trailingPrice * 100);
        const cbResult = await kalshiPost('/portfolio/orders', {
          ticker: trailingTicker,
          action: 'buy',
          side: 'yes',
          count: cbQty,
          yes_price: Math.min(99, priceInCents + 2),
        });

        if (cbResult.ok) {
          const cbOrder = cbResult.data?.order ?? {};
          const cbFill = cbOrder.count ?? cbQty;
          const cbDeployed = Math.round(cbFill * trailingPrice * 100) / 100;

          const cbTrade = {
            id: cbOrder.order_id ?? `cb-${Date.now()}`,
            timestamp: new Date().toISOString(),
            strategy: 'comeback-buy',
            exchange: 'kalshi',
            ticker: trailingTicker,
            title: cachedPrices.get(trailingTicker)?.title ?? `${trailingAbbr} vs ${leadingAbbr}`,
            side: 'yes',
            entryPrice: trailingPrice,
            entryDiff: g.diff,  // run deficit at entry — exit if this grows
            quantity: cbFill,
            deployCost: cbDeployed,
            confidence: cbConf,
            reasoning: cbDecision.reasoning,
            status: 'open',
          };

          appendFileSync(TRADES_LOG, JSON.stringify(cbTrade) + '\n');
          openPositions.push(cbTrade);
          gameEntries.set(trailingBase, { ticker: trailingTicker, price: trailingPrice, lastScoreKey: scoreKey(g.awayScore, g.homeScore) });
          tradeCooldowns.set(trailingBase, Date.now());

          await tg(
            `🔄 <b>COMEBACK BUY — KALSHI</b>\n\n` +
            `📋 <b>GAME</b>\n` +
            `${cachedPrices.get(trailingTicker)?.title ?? trailingTicker}\n` +
            `Score: ${g.awayScore}-${g.homeScore} (${trailingAbbr} trailing) | Inning ${g.period}\n\n` +
            `📊 <b>METRICS</b>\n` +
            `Bought ${trailingAbbr} YES @ ${priceInCents}¢ × ${cbFill} = <b>$${cbDeployed.toFixed(2)}</b>\n` +
            `Confidence: <b>${Math.round(cbConf*100)}%</b> | Edge: +${Math.round(cbEdge*100)}pts vs market\n` +
            `Statistical comeback rate: ${comebackWinPct}% | Market priced: ${priceInCents}%\n` +
            `Ace: ${trailingStarterName} (${trailingStarterERA} ERA) | Opp: ${leadingStarterName} (${leadingStarterERA} ERA) | ${inningsLeft} innings left\n` +
            `Exit: sell when ${trailingAbbr} ties or leads (price ~50¢+)\n\n` +
            `🧠 <b>REASONING</b>\n` +
            `${cbDecision.reasoning}`
          );
        } else {
          console.error(`[comeback] Order failed:`, cbResult.status, JSON.stringify(cbResult.data));
        }
      } catch (e) {
        console.error(`[comeback] Error for game:`, e.message);
      }
    }
  }

  // === PHASE 6: TRAILER-HOLD (2026-05-02) =====================================
  // Shadow audit: MLB trailing team in inn 5-6 with 1-run deficit at 25-45¢
  // wins the GAME 72% of the time (n=18: P5 75% n=12, P6 67% n=6). But avg
  // intra-game price recovery is only 6¢ — comeback-buy's swing-exit can't
  // capture this. Hold-to-settlement is the right exit framework.
  //
  // EV math at 36¢ entry, 72% WR observed (60% pessimistic floor):
  //   72%: 0.72*0.64 - 0.28*0.36 = +$0.36/contract = +100% ROI
  //   60%: 0.60*0.64 - 0.40*0.36 = +$0.24/contract = +67% ROI
  //
  // Different from comeback-buy:
  //   - No ace-ERA filter (cell wins regardless of pitcher quality)
  //   - No Sonnet eval (structural)
  //   - No swing-exit at +15¢ — hold to settlement
  //   - Exit only on: deficit growth, hard stop -15¢, or game settles
  if (cachedPrices.size > 0) {
    for (const g of liveGames) {
      try {
        if (g.league !== 'mlb') continue;
        if (g.diff !== 1) continue;             // d=1 only — d=2+ cells lose money
        if (g.period < 5 || g.period > 6) continue;

        const trailingIsHome = g.homeScore < g.awayScore;
        const trailingTeam   = trailingIsHome ? g.home : g.away;
        const leadingTeam    = trailingIsHome ? g.away : g.home;
        const trailingAbbr   = trailingTeam.team?.abbreviation ?? '';
        const leadingAbbr    = leadingTeam.team?.abbreviation ?? '';
        if (!trailingAbbr || !leadingAbbr) continue;

        const trailingTicker = [...cachedPrices.keys()].find(t => {
          const suffix = t.split('-').pop()?.toUpperCase() ?? '';
          return t.startsWith('KXMLBGAME') &&
                 suffix === trailingAbbr.toUpperCase() &&
                 tickerHasTeam(t.toLowerCase(), trailingAbbr) &&
                 tickerHasTeam(t.toLowerCase(), leadingAbbr);
        });
        if (!trailingTicker) continue;

        const trailingPrice = cachedPrices.get(trailingTicker)?.yes ?? 0;
        if (trailingPrice < 0.25 || trailingPrice > 0.45) continue;

        const trailingBase = trailingTicker.lastIndexOf('-') > 0
          ? trailingTicker.slice(0, trailingTicker.lastIndexOf('-'))
          : trailingTicker;

        // Stop-lock check
        const lockUntil = stopLocks.get(trailingBase);
        if (lockUntil && Date.now() < lockUntil) continue;

        // Existing position check (portfolio + JSONL same-day)
        const hasPortfolioPos = openPositions.some(p => {
          const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
          return pBase === trailingBase;
        });
        if (hasPortfolioPos) continue;

        let hasJsonlPos = false;
        if (existsSync(TRADES_LOG)) {
          try {
            const dupStart = new Date(etNow().toISOString().slice(0,10) + 'T04:00:00Z').getTime();
            const jLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
            for (const l of jLines) {
              try {
                const jt = JSON.parse(l);
                if (jt.status === 'testing-void') continue;
                const jtMs = jt.timestamp ? Date.parse(jt.timestamp) : 0;
                if (jtMs < dupStart) continue;
                if (tickerHasTeam((jt.ticker ?? '').toLowerCase(), trailingAbbr) &&
                    tickerHasTeam((jt.ticker ?? '').toLowerCase(), leadingAbbr)) {
                  hasJsonlPos = true; break;
                }
              } catch {}
            }
          } catch {}
        }
        if (hasJsonlPos) continue;

        // Cooldown: re-evaluate same trailer at most every 8 min
        const thKey = 'trailer-hold:' + trailingBase;
        if (Date.now() - (tradeCooldowns.get(thKey) ?? 0) < 8 * 60 * 1000) continue;
        tradeCooldowns.set(thKey, Date.now());

        // KALSHI-ESPN SYNC CHECK (same as comeback-buy): skip if Kalshi-implied
        // leader prob is 12+ pts higher than ESPN model — ESPN is lagging real score.
        const leaderTickerForSync = [...cachedPrices.keys()].find(t =>
          t.startsWith('KXMLBGAME') &&
          tickerHasTeam(t.toLowerCase(), leadingAbbr) &&
          tickerHasTeam(t.toLowerCase(), trailingAbbr) &&
          (t.split('-').pop()?.toUpperCase() ?? '') === leadingAbbr.toUpperCase()
        );
        const leaderKalshiPx = leaderTickerForSync ? (cachedPrices.get(leaderTickerForSync)?.yes ?? 0) : 0;
        const espnLeaderProb = getWinExpectancy('mlb', g.diff, g.period, !trailingIsHome) ?? 0.65;
        if (leaderKalshiPx > 0 && (Math.round(leaderKalshiPx*100) - Math.round(espnLeaderProb*100)) >= 12) {
          console.log(`[trailer-hold] Skip ${trailingAbbr}: Kalshi/ESPN mismatch ${Math.round(leaderKalshiPx*100)}¢ vs ${Math.round(espnLeaderProb*100)}¢ — ESPN lagging`);
          continue;
        }

        // Sizing: smaller than comeback-buy (variance is real, sample n=18)
        const thMaxTrade = Math.min(getBankroll() * 0.04, getAvailableCash('kalshi'));
        const thQty = Math.max(1, Math.floor(thMaxTrade / trailingPrice));
        const thBetAmount = thQty * trailingPrice;
        if (thBetAmount < 5) { console.log(`[trailer-hold] Bet too small ($${thBetAmount.toFixed(2)}), skipping`); continue; }

        const priceCents = Math.round(trailingPrice * 100);
        console.log(`[trailer-hold] 🎯 BUY ${trailingAbbr} @ ${priceCents}¢ × ${thQty} | inn${g.period} d=${g.diff} | hold-to-settlement`);

        const thResult = await kalshiPost('/portfolio/orders', {
          ticker: trailingTicker,
          action: 'buy',
          side: 'yes',
          count: thQty,
          yes_price: Math.min(99, priceCents + 2),
        });
        if (thResult.ok) {
          const thOrder = thResult.data?.order ?? {};
          const thFill = thOrder.count ?? thQty;
          const thDeployed = Math.round(thFill * trailingPrice * 100) / 100;
          const thTrade = {
            id: thOrder.order_id ?? `th-${Date.now()}`,
            timestamp: new Date().toISOString(),
            strategy: 'trailer-hold',
            exchange: 'kalshi',
            ticker: trailingTicker,
            title: cachedPrices.get(trailingTicker)?.title ?? `${trailingAbbr} vs ${leadingAbbr}`,
            side: 'yes',
            entryPrice: trailingPrice,
            entryDiff: g.diff,
            entryPeriod: g.period,
            quantity: thFill,
            deployCost: thDeployed,
            confidence: 0.72,
            reasoning: `STRUCTURAL: MLB trailer 1-run deficit inn${g.period} at ${priceCents}¢ — shadow cell 72% game-WR n=18. Hold to settlement.`,
            status: 'open',
            holdToSettlement: true,
            _structuralPattern: `mlb-trailer-${g.period}-1run-hold`,
          };
          appendFileSync(TRADES_LOG, JSON.stringify(thTrade) + '\n');
          openPositions.push(thTrade);
          gameEntries.set(trailingBase, { ticker: trailingTicker, price: trailingPrice, lastScoreKey: scoreKey(g.awayScore, g.homeScore) });
          tradeCooldowns.set(trailingBase, Date.now());
          await tg(
            `🎯 <b>TRAILER-HOLD — KALSHI</b>\n\n` +
            `📋 <b>GAME</b>\n` +
            `${cachedPrices.get(trailingTicker)?.title ?? trailingTicker}\n` +
            `Score: ${g.awayScore}-${g.homeScore} (${trailingAbbr} trailing) | Inning ${g.period}\n\n` +
            `📊 <b>METRICS</b>\n` +
            `Bought ${trailingAbbr} YES @ ${priceCents}¢ × ${thFill} = <b>$${thDeployed.toFixed(2)}</b>\n` +
            `Cell history: 72% WR n=18 (P5 75% n=12 + P6 67% n=6)\n` +
            `Strategy: HOLD TO SETTLEMENT — exit only if deficit grows\n\n` +
            `🧠 <b>REASONING</b>\n` +
            `Shadow audit identified this cell as +EV. Trailing teams in inn 5-6 down 1 run win the game ~72% of the time, but price barely moves intra-game (avg max-rec 6¢) so swing-exit fails. We hold for the settlement payout.`
          );
        } else {
          console.error(`[trailer-hold] Order failed:`, thResult.status, JSON.stringify(thResult.data));
        }
      } catch (e) {
        console.error(`[trailer-hold] Error for game:`, e.message);
      }
    }
  }

  // === PHASE 7: TRAIL-2RUN-P2 SWING (2026-05-02) ==============================
  // Inverse of trailer-hold: this cell LOSES games (20% game-WR n=10) but
  // has a 50% rate of recovering ≥15¢ intra-game with avg max-rec +22¢. The
  // edge is in the swing, not the settlement — opposite exit discipline.
  //
  // Cell: mlb-trail-2run-P2 (trailer down 2 runs, inning 2)
  // EV at 34¢ entry: 50% × +15¢ + 50% × -10¢ = +2.5¢/contract = +7% ROI
  // Marginal but real; ship small.
  if (cachedPrices.size > 0) {
    for (const g of liveGames) {
      try {
        if (g.league !== 'mlb') continue;
        if (g.diff !== 2) continue;
        if (g.period !== 2) continue;

        const trailingIsHome = g.homeScore < g.awayScore;
        const trailingTeam   = trailingIsHome ? g.home : g.away;
        const leadingTeam    = trailingIsHome ? g.away : g.home;
        const trailingAbbr   = trailingTeam.team?.abbreviation ?? '';
        const leadingAbbr    = leadingTeam.team?.abbreviation ?? '';
        if (!trailingAbbr || !leadingAbbr) continue;

        const trailingTicker = [...cachedPrices.keys()].find(t => {
          const suffix = t.split('-').pop()?.toUpperCase() ?? '';
          return t.startsWith('KXMLBGAME') &&
                 suffix === trailingAbbr.toUpperCase() &&
                 tickerHasTeam(t.toLowerCase(), trailingAbbr) &&
                 tickerHasTeam(t.toLowerCase(), leadingAbbr);
        });
        if (!trailingTicker) continue;

        const trailingPrice = cachedPrices.get(trailingTicker)?.yes ?? 0;
        if (trailingPrice < 0.28 || trailingPrice > 0.40) continue;

        const trailingBase = trailingTicker.lastIndexOf('-') > 0
          ? trailingTicker.slice(0, trailingTicker.lastIndexOf('-'))
          : trailingTicker;

        const lockUntil = stopLocks.get(trailingBase);
        if (lockUntil && Date.now() < lockUntil) continue;

        const hasPortfolioPos = openPositions.some(p => {
          const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
          return pBase === trailingBase;
        });
        if (hasPortfolioPos) continue;

        let hasJsonlPos = false;
        if (existsSync(TRADES_LOG)) {
          try {
            const dupStart = new Date(etNow().toISOString().slice(0,10) + 'T04:00:00Z').getTime();
            const jLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
            for (const l of jLines) {
              try {
                const jt = JSON.parse(l);
                if (jt.status === 'testing-void') continue;
                const jtMs = jt.timestamp ? Date.parse(jt.timestamp) : 0;
                if (jtMs < dupStart) continue;
                if (tickerHasTeam((jt.ticker ?? '').toLowerCase(), trailingAbbr) &&
                    tickerHasTeam((jt.ticker ?? '').toLowerCase(), leadingAbbr)) {
                  hasJsonlPos = true; break;
                }
              } catch {}
            }
          } catch {}
        }
        if (hasJsonlPos) continue;

        const tsKey = 'trail-swing:' + trailingBase;
        if (Date.now() - (tradeCooldowns.get(tsKey) ?? 0) < 8 * 60 * 1000) continue;
        tradeCooldowns.set(tsKey, Date.now());

        // Smaller sizing than trailer-hold (3% vs 4%) — n=10 sample, marginal EV
        const tsMaxTrade = Math.min(getBankroll() * 0.03, getAvailableCash('kalshi'));
        const tsQty = Math.max(1, Math.floor(tsMaxTrade / trailingPrice));
        const tsBetAmount = tsQty * trailingPrice;
        if (tsBetAmount < 5) continue;

        const priceCents = Math.round(trailingPrice * 100);
        console.log(`[trail-swing] 🔁 BUY ${trailingAbbr} @ ${priceCents}¢ × ${tsQty} | inn2 d=2 swing | target +15¢`);

        const tsResult = await kalshiPost('/portfolio/orders', {
          ticker: trailingTicker,
          action: 'buy',
          side: 'yes',
          count: tsQty,
          yes_price: Math.min(99, priceCents + 2),
        });
        if (tsResult.ok) {
          const tsOrder = tsResult.data?.order ?? {};
          const tsFill = tsOrder.count ?? tsQty;
          const tsDeployed = Math.round(tsFill * trailingPrice * 100) / 100;
          const tsTrade = {
            id: tsOrder.order_id ?? `ts-${Date.now()}`,
            timestamp: new Date().toISOString(),
            strategy: 'trail-swing',
            exchange: 'kalshi',
            ticker: trailingTicker,
            title: cachedPrices.get(trailingTicker)?.title ?? `${trailingAbbr} vs ${leadingAbbr}`,
            side: 'yes',
            entryPrice: trailingPrice,
            entryDiff: g.diff,
            entryPeriod: g.period,
            quantity: tsFill,
            deployCost: tsDeployed,
            confidence: 0.50,
            reasoning: `STRUCTURAL SWING: MLB trail-2run-P2 cell at ${priceCents}¢ — 50% recover ≥15¢ n=10. Sell at +15¢ or -10¢.`,
            status: 'open',
            _structuralPattern: 'mlb-trail-2run-P2-swing',
          };
          appendFileSync(TRADES_LOG, JSON.stringify(tsTrade) + '\n');
          openPositions.push(tsTrade);
          gameEntries.set(trailingBase, { ticker: trailingTicker, price: trailingPrice, lastScoreKey: scoreKey(g.awayScore, g.homeScore) });
          tradeCooldowns.set(trailingBase, Date.now());
          await tg(
            `🔁 <b>TRAIL-SWING — KALSHI</b>\n\n` +
            `📋 <b>GAME</b>\n` +
            `${cachedPrices.get(trailingTicker)?.title ?? trailingTicker}\n` +
            `Score: ${g.awayScore}-${g.homeScore} (${trailingAbbr} trailing 2) | Inning 2\n\n` +
            `📊 <b>METRICS</b>\n` +
            `Bought ${trailingAbbr} YES @ ${priceCents}¢ × ${tsFill} = <b>$${tsDeployed.toFixed(2)}</b>\n` +
            `Cell history: 50% recover ≥15¢ (n=10), avg max-rec +22¢\n` +
            `Strategy: SWING — sell at +15¢ profit OR -10¢ loss\n\n` +
            `🧠 <b>REASONING</b>\n` +
            `Inverse of trailer-hold: this cell loses 80% of games but generates intra-game swings. Capture the +15¢ pop and exit; do NOT hold.`
          );
        } else {
          console.error(`[trail-swing] Order failed:`, tsResult.status, JSON.stringify(tsResult.data));
        }
      } catch (e) {
        console.error(`[trail-swing] Error for game:`, e.message);
      }
    }
  }

  // === PHASE 8: SHORT-SIDE UNDERDOG SCANNER (2026-05-02) ====================
  // When a leader's price is OUT OF BAND for any leader detector (i.e., market
  // overprices the leader), buy the UNDERDOG YES at asymmetric-pay band.
  //
  // Math: leader at 88¢ implies 88% market WR. If true WR is 70-80%, underdog
  // at 12¢ is genuinely underpriced.
  //   If true WR underdog = 25% (vs 12% market): 25% × $0.88 - 75% × $0.12
  //   = $0.22 - $0.09 = +$0.13/contract = +108% ROI per win
  //
  // SAFEGUARDS:
  //   - Skip if any open position on same game-base (no double-positioning)
  //   - Skip if same-day position already on this game in trades.jsonl
  //   - Hard 3% bankroll cap until we accumulate placed-bet validation data
  //   - Hold to settlement (asymmetric pay realizes at $1.00)
  //   - Sport-specific gates (only sports where leader cells show overpriced)
  //   - Cooldown 15min per game (no spam)
  if (cachedPrices.size > 0) {
    for (const g of liveGames) {
      try {
        const sport = g.league;
        const isSoccerLg = ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(sport);
        // Sport-specific eligibility: ONLY where leader cells show overpriced patterns.
        // Skip MLS pre-game disabled, Serie A/Bundesliga/Ligue 1 too thin.
        const eligibleSport = sport === 'mlb' || sport === 'nba' ||
          ['epl','laliga'].includes(sport);
        if (!eligibleSport) continue;
        if (g.diff < 1) continue;

        // Determine leader / underdog
        const leaderIsHome = g.homeScore > g.awayScore;
        const leaderTeam = leaderIsHome ? g.home : g.away;
        const trailingTeam = leaderIsHome ? g.away : g.home;
        const leadingAbbr = leaderTeam.team?.abbreviation ?? '';
        const trailingAbbr = trailingTeam.team?.abbreviation ?? '';
        if (!leadingAbbr || !trailingAbbr) continue;

        // Find leader + underdog Kalshi tickers
        const leaderTicker = [...cachedPrices.keys()].find(t =>
          t.startsWith(g.league === 'mlb' ? 'KXMLBGAME' :
                       g.league === 'nba' ? 'KXNBAGAME' :
                       'KXEPLGAME') &&
          (t.split('-').pop()?.toUpperCase() ?? '') === leadingAbbr.toUpperCase()
        );
        const underdogTicker = [...cachedPrices.keys()].find(t =>
          t.startsWith(g.league === 'mlb' ? 'KXMLBGAME' :
                       g.league === 'nba' ? 'KXNBAGAME' :
                       'KXEPLGAME') &&
          (t.split('-').pop()?.toUpperCase() ?? '') === trailingAbbr.toUpperCase()
        );
        if (!leaderTicker || !underdogTicker) continue;

        const leaderPrice = cachedPrices.get(leaderTicker)?.yes ?? 0;
        const underdogPrice = cachedPrices.get(underdogTicker)?.yes ?? 0;

        // Sport-specific OUT-OF-BAND triggers — leader must be priced ABOVE
        // any allowed leader-detector cap, indicating market overprices.
        let isOutOfBand = false;
        let cellLabel = '';
        if (sport === 'mlb') {
          // MLB inn 4-7 leader at 80-88¢ above all caps for d=1/2 (max 78 d=2)
          if (g.period >= 4 && g.period <= 7 && leaderPrice >= 0.80 && leaderPrice <= 0.92) {
            isOutOfBand = true;
            cellLabel = `mlb-inn${g.period}-d${g.diff}-leader-80-92`;
          }
        } else if (sport === 'nba') {
          // NBA Q4 leader 85-95¢ — beyond our 78¢ cap, asymmetric play
          if (g.period === 4 && leaderPrice >= 0.85 && leaderPrice <= 0.95) {
            // Time check: must have ≥3min remaining (else genuinely settled)
            const m = (g.detail || '').match(/^(\d+):(\d{2})/);
            if (m) {
              const minsLeft = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
              if (minsLeft >= 3 && minsLeft <= 9) {
                isOutOfBand = true;
                cellLabel = `nba-q4-leader-85-95-${minsLeft.toFixed(0)}min`;
              }
            }
          }
        } else if (isSoccerLg) {
          // Soccer 2H home leader at 70-85¢ — 3-way market means draw still possible
          if (g.period === 2 && leaderIsHome && leaderPrice >= 0.70 && leaderPrice <= 0.85) {
            const minMatch = (g.detail || '').match(/^(\d+)/);
            if (minMatch) {
              const minute = parseInt(minMatch[1], 10);
              if (minute >= 50 && minute <= 75) {
                isOutOfBand = true;
                cellLabel = `soccer-2h-home-leader-70-85-min${minute}`;
              }
            }
          }
        }
        if (!isOutOfBand) continue;

        // Underdog asymmetric-pay band check (8-22¢)
        if (underdogPrice < 0.08 || underdogPrice > 0.22) continue;

        // Same-game-base dedup — prevent double-positioning
        const gameBase = leaderTicker.lastIndexOf('-') > 0
          ? leaderTicker.slice(0, leaderTicker.lastIndexOf('-'))
          : leaderTicker;
        const hasPortfolioPos = openPositions.some(p => {
          const pBase = p.ticker.lastIndexOf('-') > 0
            ? p.ticker.slice(0, p.ticker.lastIndexOf('-'))
            : p.ticker;
          return pBase === gameBase;
        });
        if (hasPortfolioPos) continue;

        // Same-day jsonl dedup
        let hasJsonlPos = false;
        if (existsSync(TRADES_LOG)) {
          try {
            const dupStart = new Date(etNow().toISOString().slice(0,10) + 'T04:00:00Z').getTime();
            const jLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
            for (const l of jLines) {
              try {
                const jt = JSON.parse(l);
                if (jt.status === 'testing-void') continue;
                const jtMs = jt.timestamp ? Date.parse(jt.timestamp) : 0;
                if (jtMs < dupStart) continue;
                if (tickerHasTeam((jt.ticker ?? '').toLowerCase(), trailingAbbr) &&
                    tickerHasTeam((jt.ticker ?? '').toLowerCase(), leadingAbbr)) {
                  hasJsonlPos = true; break;
                }
              } catch {}
            }
          } catch {}
        }
        if (hasJsonlPos) continue;

        // Per-game cooldown (15 min)
        const udKey = 'underdog-short:' + gameBase;
        if (Date.now() - (tradeCooldowns.get(udKey) ?? 0) < 15 * 60 * 1000) continue;
        tradeCooldowns.set(udKey, Date.now());

        // Sized SMALL until validated. 3% bankroll cap.
        const udMaxTrade = Math.min(getBankroll() * 0.03, getAvailableCash('kalshi'));
        const udQty = Math.max(1, Math.floor(udMaxTrade / underdogPrice));
        const udBetAmount = udQty * underdogPrice;
        if (udBetAmount < 4) continue;

        const priceCents = Math.round(underdogPrice * 100);
        console.log(`[underdog-short] 🎯 BUY ${trailingAbbr} YES @ ${priceCents}¢ × ${udQty} | leader ${leadingAbbr} @ ${(leaderPrice*100).toFixed(0)}¢ | cell=${cellLabel}`);

        const udResult = await kalshiPost('/portfolio/orders', {
          ticker: underdogTicker,
          action: 'buy',
          side: 'yes',
          count: udQty,
          yes_price: Math.min(99, priceCents + 2),
        });
        if (udResult.ok) {
          const udOrder = udResult.data?.order ?? {};
          const udFill = udOrder.count ?? udQty;
          const udDeployed = Math.round(udFill * underdogPrice * 100) / 100;
          const udTrade = {
            id: udOrder.order_id ?? `ud-${Date.now()}`,
            timestamp: new Date().toISOString(),
            strategy: 'underdog-short',
            exchange: 'kalshi',
            ticker: underdogTicker,
            title: cachedPrices.get(underdogTicker)?.title ?? `${trailingAbbr} vs ${leadingAbbr}`,
            side: 'yes',
            entryPrice: underdogPrice,
            entryDiff: g.diff,
            entryPeriod: g.period,
            quantity: udFill,
            deployCost: udDeployed,
            confidence: 0.30,
            reasoning: `STRUCTURAL UNDERDOG-SHORT: leader ${leadingAbbr} priced ${(leaderPrice*100).toFixed(0)}¢ (out of band — market overprices). ${trailingAbbr} YES at ${priceCents}¢ asymmetric pay. Cell: ${cellLabel}.`,
            status: 'open',
            holdToSettlement: true,
            _structuralPattern: cellLabel,
            _undergCellLabel: cellLabel,
          };
          appendFileSync(TRADES_LOG, JSON.stringify(udTrade) + '\n');
          openPositions.push(udTrade);
          gameEntries.set(gameBase, { ticker: underdogTicker, price: underdogPrice, lastScoreKey: scoreKey(g.awayScore, g.homeScore) });
          await tg(
            `🎯 <b>UNDERDOG-SHORT — KALSHI</b>\n\n` +
            `📋 <b>GAME</b>\n` +
            `${cachedPrices.get(underdogTicker)?.title ?? underdogTicker}\n` +
            `Score: ${g.awayScore}-${g.homeScore} (${trailingAbbr} trailing)\n\n` +
            `📊 <b>METRICS</b>\n` +
            `Bought ${trailingAbbr} YES @ ${priceCents}¢ × ${udFill} = <b>$${udDeployed.toFixed(2)}</b>\n` +
            `Leader ${leadingAbbr} priced ${(leaderPrice*100).toFixed(0)}¢ (out of band)\n` +
            `Cell: ${cellLabel}\n\n` +
            `🧠 <b>REASONING</b>\n` +
            `Market overprices leader at ${(leaderPrice*100).toFixed(0)}¢. Underdog at ${priceCents}¢ has asymmetric pay structure. Hold to settlement.`
          );
        } else {
          console.error(`[underdog-short] Order failed:`, udResult.status, JSON.stringify(udResult.data));
        }
      } catch (e) {
        console.error(`[underdog-short] Error for game:`, e.message);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Predictions — bet on today's games BEFORE they start
// ─────────────────────────────────────────────────────────────────────────────

// lastPreGameScan declared at top (before loadState) to avoid TDZ
const PREGAME_SCAN_INTERVAL = 15 * 60 * 1000; // every 15 min
const MAX_PREGAME_PER_CYCLE = 5;   // Analyze up to 5 markets per scan cycle (quality > volume)
const MAX_PREGAME_PAPER_PER_DAY = 999; // Paper mode: no real cap — log every qualifying pick for calibration
const PREGAME_HOURS_WINDOW = 6;    // Only place real bet when game starts within this many hours (was 2 — missed most pre-game shots on evening games)
let preGameTradesToday = 0;
let preGameTradesDate = '';         // reset counter on new day
const preGameBetGames = new Set();  // games we've already bet on today (prevents re-buying)
const preGameAnalysisCache = new Map(); // marketBase → timestamp of last Claude analysis
// Starter-change detector: persistent across scans. Tracks the last-seen starter
// name per (sport:teamAbbr). When ESPN updates a different name for the same key,
// that's a STARTER SCRATCH/CHANGE — high-edge event because sportsbook lines move
// in <1 minute but Kalshi typically lags 5-15 min on lineup news.
// Value: { name, era, seenAt, prevName, prevSeenAt } — only set when CHANGE detected.
// Cleared if no change seen in 24h.
const previousStarterMap = new Map(); // 'KEY:abbr' → { name, era, seenAt }
const starterChangeMap = new Map(); // 'KEY:abbr' → { newName, newEra, prevName, prevEra, detectedAt }
const STARTER_CHANGE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — change is "fresh" for 6h after detection
// 2026-04-30: oscillation dedup. ESPN's probables array can list 2 candidates and
// reorder them between polls — same names flip back and forth, generating a phantom
// "lineup change" every 15 min for the rest of the day. Track every starter we've
// seen for a team in the last 6h; if a "new" name is one we've already seen recently,
// it's an ESPN ordering artifact, not a real swap. Suppress alert + map update.
const seenStarterNames = new Map(); // 'KEY:abbr' → Map<name, lastSeenMs>
// NBA injury-change detector: tracks which players appear in inactive list per team.
// When NEW name appears in inactive (vs previous snapshot), that's a "ruled out" event.
// Sportsbooks reprice ~30 sec after NBA's official injury report; Kalshi lags 5-15 min.
const previousNbaInactiveMap = new Map(); // 'NBA:abbr' → Set of inactive player names
const nbaInjuryChangeMap = new Map(); // 'NBA:abbr' → { newlyOut: [name1, ...], detectedAt }
// Price snapshot at time of last analysis. When cache TTL expires, we gate re-analysis
// on whether prices actually moved. If neither side moved ≥3¢ since last look, Claude
// would produce the same answer from the same data — skip the $0.08 call. (2026-04-23)
const preGameAnalyzedPrice = new Map(); // marketBase → { team1Cents, team2Cents, at }
const PG_ANALYZED_PRICE_TOL_CENTS = 3;
const pgGameStartTimes = new Map();     // marketBase → game start (ms UTC), persists across scan cycles

const preGameRejectCache = new Map(); // marketBase → timestamp of last REJECTED analysis (longer TTL)
const PG_REJECT_TTL_MS = 4 * 60 * 60 * 1000; // 4h sticky for rejected markets (was 2h — ERA/price-band math doesn't flip in 2h, was re-burning $7/day on repeat rejects)
// Price at time of reject. If any side moves ≥2¢ since reject, invalidate the sticky cache
// and let the market re-analyze — sharp money movement is the one signal that can flip
// a "margin failed" or "confidence low" reject into a real edge.
const preGameRejectPrice = new Map(); // marketBase → { team1Cents, team2Cents }
const PG_REJECT_PRICE_TOL_CENTS = 2;
// Markets that Claude rejected specifically because ESPN ground truth was missing.
// ESPN fills in starters 4-6h before game time — we force a re-scan in the T-2h window
// even if the cache/reject timer says skip. Reclaims ~10-12% of MLB games/week that
// we previously refused to analyze because starter listings hadn't published yet.
const preGameEspnMissSet = new Set(); // marketBase (cleared when analyzed again or game starts)
const ESPN_MISS_PATTERNS = /NOT IN ESPN|no ESPN|ESPN Ground Truth|ESPN data|ESPN-confirmed|ESPN ERA|starter is (?:not|un)confirmed|No ESPN/i;

// Dynamic cache TTL based on time until game start.
// Games far from starting (overnight scan) get a longer cache — no point asking Claude the same
// question every hour when the starters/odds won't change until a few hours before game time.
//   >8h to start → 4h cache  (overnight: re-analyze 2-3x vs 16-24x with flat 1h TTL)
//   4-8h to start → 2h cache
//   <4h to start → 2h cache  (was 1h — same game rejected 5-8× per day wastes tokens)
function getPgCacheTtl(marketBase) {
  let startMs = pgGameStartTimes.get(marketBase);

  // Fallback for MLB: parse HHMM directly from ticker (KXMLBGAME-26APR201810HOUCLE → 1810)
  // This works on first scan before ESPN data is available, covering the highest-volume case.
  if (!startMs) {
    const m = marketBase.match(/\d{2}[A-Z]{3}\d{2}(\d{4})[A-Z]/);
    if (m) {
      const h = parseInt(m[1].slice(0, 2), 10);
      const mn = parseInt(m[1].slice(2, 4), 10);
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const nowMins = et.getHours() * 60 + et.getMinutes();
      const gameMins = h * 60 + mn;
      const minsUntil = (gameMins + 24 * 60 - nowMins) % (24 * 60);
      if (minsUntil > 8 * 60) return 4 * 60 * 60 * 1000;
      if (minsUntil > 4 * 60) return 2 * 60 * 60 * 1000;
      return 2 * 60 * 60 * 1000;
    }
    return 3 * 60 * 60 * 1000; // unknown start time → 3h default (NBA/NHL/Soccer first scan)
  }

  const minsUntil = (startMs - Date.now()) / 60000;
  if (minsUntil > 8 * 60) return 4 * 60 * 60 * 1000;
  if (minsUntil > 4 * 60) return 2 * 60 * 60 * 1000;
  return 2 * 60 * 60 * 1000;
}

async function checkPreGamePredictions() {
  // PAPER MODE: Runs full pre-game analysis for all sports but logs to paper-trades.jsonl
  // instead of placing real orders. Used for calibration — no real money at risk.
  if (Date.now() - lastPreGameScan < PREGAME_SCAN_INTERVAL) return;
  lastPreGameScan = Date.now();
  if (!canTrade()) return;

  // Overnight pause: no actionable pre-game edges between 00:00 and 06:00 ET
  // (rosters/weather/starters not firm, cache churns for nothing). Saves ~6h of calls/day.
  const _etHour = etHour();
  if (_etHour >= 0 && _etHour < 6) return;

  // No hard time cutoff — skip individual games that are already live instead.
  // This lets west-coast NHL/MLB games (9-10pm ET) get pre-game analysis
  // while still ignoring any game that ESPN confirms is already in progress.
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

  // Daily paper limit — restore from paper-trades.jsonl (survives restarts)
  // Use proper ET date (not UTC) so late-night games (10pm ET = 02:00 UTC+1) match correctly.
  const todayDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const tsToEtDate = (ts) => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : '';
  if (preGameTradesDate !== todayDateStr) {
    preGameTradesDate = todayDateStr;
    preGameBetGames.clear();
    preGameAnalysisCache.clear();
    preGameTradesToday = 0;
    // Restore from paper-trades.jsonl (covers both paper and real-bet mirrors)
    if (existsSync(PAPER_TRADES_LOG)) {
      const todayLines = readFileSync(PAPER_TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of todayLines) {
        try {
          const t = JSON.parse(l);
          if (t.strategy === 'pre-game-paper' && tsToEtDate(t.timestamp) === todayDateStr) {
            preGameTradesToday++;
            if (t.marketBase) preGameBetGames.add(t.marketBase);
          }
        } catch {}
      }
    }
    // Backstop: also restore from real trades.jsonl in case paper mirror was missed.
    // Derives marketBase from ticker by stripping the trailing "-TEAMABBR" suffix.
    if (existsSync(TRADES_LOG)) {
      const tradeLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of tradeLines) {
        try {
          const t = JSON.parse(l);
          if ((t.strategy === 'pre-game-prediction' || t.strategy === 'pre-game-edge-first') && tsToEtDate(t.timestamp) === todayDateStr && t.ticker) {
            const base = t.ticker.replace(/-[A-Z]+$/, '');
            if (base) preGameBetGames.add(base);
          }
        } catch {}
      }
    }
    if (preGameTradesToday > 0) console.log(`[pre-game] Restored paper count: ${preGameTradesToday} paper trades today, ${preGameBetGames.size} games locked`);
  }
  if (preGameTradesToday >= MAX_PREGAME_PAPER_PER_DAY) {
    console.log(`[pre-game] Paper daily limit reached (${preGameTradesToday}/${MAX_PREGAME_PAPER_PER_DAY}). Skipping.`);
    return;
  }

  const sportsSeries = ['KXMLBGAME', 'KXNBAGAME', 'KXNHLGAME', 'KXMLSGAME', 'KXEPLGAME', 'KXLALIGAGAME'];
  const etTmrw = new Date(etNow.getTime() + 24 * 60 * 60 * 1000);
  const toShort = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
  const todayStr = toShort(etNow);
  // Only include tomorrow's date after 10pm ET (late games that cross midnight)
  const etHr = etNow.getHours();
  const tonightStr = etHr >= 22 ? toShort(etTmrw) : null;

  // Collect today's pre-game markets — group both tickers per game
  const gameMap = new Map(); // base → { tickers: [{ticker, team, yesAsk}], title, base, series }
  for (const series of sportsSeries) {
    try {
      const data = await kalshiGet(`/markets?series_ticker=${series}&status=open&limit=200`);
      for (const m of data.markets ?? []) {
        if (!m.yes_ask_dollars) continue;
        const ticker = m.ticker ?? '';
        if (!ticker.includes(todayStr) && !(tonightStr && tomorrowTickerWithinHours(ticker, tonightStr, etNow))) continue;
        const lastH = ticker.lastIndexOf('-');
        const base = lastH > 0 ? ticker.slice(0, lastH) : ticker;
        const team = ticker.split('-').pop() ?? '';
        const yesAsk = parseFloat(m.yes_ask_dollars);
        const yesSubTitle = m.yes_sub_title ?? team; // Kalshi provides the team name

        if (!gameMap.has(base)) gameMap.set(base, { tickers: [], title: m.title, base, series });
        gameMap.get(base).tickers.push({ ticker, team, teamName: yesSubTitle, yesAsk });
      }
    } catch { /* skip */ }
  }

  // Build pre-game markets with both sides
  const preGameMarkets = [];
  for (const [base, game] of gameMap) {
    if (game.tickers.length < 2) continue; // need both sides
    // Skip if already have position
    const hasPos = openPositions.some(p => {
      const pBase = p.ticker.lastIndexOf('-') > 0 ? p.ticker.slice(0, p.ticker.lastIndexOf('-')) : p.ticker;
      return pBase === base;
    });
    if (hasPos) continue;
    if (Date.now() - (tradeCooldowns.get(base) ?? 0) < COOLDOWN_MS) continue;

    // Skip if this game is already live — ESPN confirmed it's in progress.
    // activeLiveGames is updated each live-edge cycle. If both teams from a live
    // game pair appear in the Kalshi ticker, the game has started → skip pre-game analysis.
    if (activeLiveGames.size > 0) {
      const gameIsLive = game.tickers.some(t => {
        const ticker = t.ticker.toLowerCase();
        return [...activeLiveGames].some(pair => {
          const [a, b] = pair.split('|');
          return tickerHasTeam(ticker, a) && tickerHasTeam(ticker, b);
        });
      });
      if (gameIsLive) {
        console.log(`[pre-game] Skipping ${base} — game already in progress (live-edge handles it)`);
        continue;
      }
    }

    // Both teams with prices — filter out TIE tickers (soccer has 3: team1, team2, tie)
    const realTeams = game.tickers.filter(t => t.team.toUpperCase() !== 'TIE');
    if (realTeams.length < 2) continue;
    const team1 = realTeams[0];
    const team2 = realTeams[1];
    // Preserve the TIE leg for soccer — Claude needs to see market-implied draw probability.
    const tieTicker = game.tickers.find(t => t.team.toUpperCase() === 'TIE');

    // Skip if both prices are outside range
    if (team1.yesAsk > MAX_PRICE && team2.yesAsk > MAX_PRICE) {
      logPregameRejection({ base, title: game.title, team1: { price: team1.yesAsk, team: team1.team }, team2: { price: team2.yesAsk, team: team2.team } }, 'pre-sonnet', 'both-prices-too-high', { gateContext: { maxPrice: MAX_PRICE, team1Price: team1.yesAsk, team2Price: team2.yesAsk } });
      continue;
    }
    if (team1.yesAsk < 0.15 && team2.yesAsk < 0.15) {
      logPregameRejection({ base, title: game.title, team1: { price: team1.yesAsk, team: team1.team }, team2: { price: team2.yesAsk, team: team2.team } }, 'pre-sonnet', 'both-prices-too-low', { gateContext: { team1Price: team1.yesAsk, team2Price: team2.yesAsk } });
      continue;
    }

    preGameMarkets.push({
      title: game.title, base, series: game.series,
      team1: { ticker: team1.ticker, team: team1.team, teamName: team1.teamName, price: team1.yesAsk },
      team2: { ticker: team2.ticker, team: team2.team, teamName: team2.teamName, price: team2.yesAsk },
      tie: tieTicker ? { ticker: tieTicker.ticker, price: tieTicker.yesAsk } : null,
    });
  }

  if (preGameMarkets.length === 0) { console.log('[pre-game] No pre-game markets in range'); return; }
  console.log(`[pre-game] Found ${preGameMarkets.length} pre-game markets in sweet spot`);

  // PAPER MODE: all sports eligible — we're collecting calibration data, not limiting by real-money risk.
  // Skip soccer TIE-only games (already filtered above). All of MLB/NBA/NHL/MLS/EPL/La Liga included.
  const eligibleMarkets = preGameMarkets; // no sport filter
  console.log(`[pre-game] ${eligibleMarkets.length} paper-eligible markets across all sports`);

  // Skip markets Claude already analyzed recently — prevents burning tokens re-analyzing
  // the same rejected games every 15 minutes overnight when no bets can be placed.
  const now = Date.now();
  const uncachedMarkets = eligibleMarkets.filter(m => {
    // ESPN-miss retry: if last rejection was ESPN-missing data AND game is now within
    // 2h of start AND it's been ≥30min since last look, force re-scan. ESPN publishes
    // starters in the T-6h → T-2h window; the overnight rejection is stale.
    if (preGameEspnMissSet.has(m.base)) {
      const startMs = pgGameStartTimes.get(m.base);
      const lastAt = preGameAnalysisCache.get(m.base) ?? 0;
      const withinRetryWindow = startMs && (startMs - now) > 0 && (startMs - now) <= 2 * 60 * 60 * 1000;
      const waitedLongEnough = now - lastAt >= 30 * 60 * 1000;
      if (withinRetryWindow && waitedLongEnough) return true;
    }
    // Sticky reject cache: once margin/cap check rejects, don't burn tokens re-analyzing for 4h.
    // Exception: if any side's price moved ≥2¢ since the reject, sharp money is repricing —
    // let it re-analyze to catch the new edge window.
    const rejAt = preGameRejectCache.get(m.base);
    if (rejAt && now - rejAt < PG_REJECT_TTL_MS) {
      const rejPrices = preGameRejectPrice.get(m.base);
      const team1Now = Math.round((m.team1?.price ?? 0) * 100);
      const team2Now = Math.round((m.team2?.price ?? 0) * 100);
      const moved = rejPrices && (
        Math.abs(team1Now - (rejPrices.team1Cents ?? team1Now)) >= PG_REJECT_PRICE_TOL_CENTS ||
        Math.abs(team2Now - (rejPrices.team2Cents ?? team2Now)) >= PG_REJECT_PRICE_TOL_CENTS
      );
      if (!moved) return false;
      console.log(`[pre-game] Reject cache invalidated for ${m.base} — price moved (${rejPrices?.team1Cents}→${team1Now}¢ / ${rejPrices?.team2Cents}→${team2Now}¢)`);
    }
    // Primary TTL check
    const lastAnalyzedAt = preGameAnalysisCache.get(m.base) ?? 0;
    const ttlExpired = now - lastAnalyzedAt > getPgCacheTtl(m.base);
    if (!preGameAnalysisCache.has(m.base)) return true; // never analyzed
    if (!ttlExpired) return false; // still within TTL
    // TTL expired — but only re-analyze if price actually moved ≥3¢ on either side.
    // Same prompt + same data = same Claude answer. Skip the $0.08 call if nothing
    // changed. (Option B cost optimization, 2026-04-23.)
    const priceSnapshot = preGameAnalyzedPrice.get(m.base);
    if (priceSnapshot) {
      const team1Now = Math.round((m.team1?.price ?? 0) * 100);
      const team2Now = Math.round((m.team2?.price ?? 0) * 100);
      const moved =
        Math.abs(team1Now - (priceSnapshot.team1Cents ?? team1Now)) >= PG_ANALYZED_PRICE_TOL_CENTS ||
        Math.abs(team2Now - (priceSnapshot.team2Cents ?? team2Now)) >= PG_ANALYZED_PRICE_TOL_CENTS;
      if (!moved) return false;
      console.log(`[pre-game] TTL expired but price static — skipping re-analysis for ${m.base} (${priceSnapshot.team1Cents}→${team1Now}¢ / ${priceSnapshot.team2Cents}→${team2Now}¢)`);
      // Extend the cache timestamp so we don't re-hit this filter every cycle
      preGameAnalysisCache.set(m.base, now);
      return false;
    }
    return true; // no snapshot yet, go analyze
  });
  if (uncachedMarkets.length < eligibleMarkets.length) {
    console.log(`[pre-game] Analysis cache: skipping ${eligibleMarkets.length - uncachedMarkets.length} recently-analyzed markets (${uncachedMarkets.length} uncached)`);
  }
  // Option C — priority sort + cap 12 → 5 per cycle.
  // Rank by (1) near-kickoff games first, (2) larger recent price moves (news signal),
  // (3) ESPN-miss retry candidates. This ensures the 5 analyses per cycle hit the
  // markets most likely to produce real edges.
  uncachedMarkets.sort((a, b) => {
    // ESPN-miss retry candidates get absolute priority (they were deferred earlier)
    const aEspnMiss = preGameEspnMissSet.has(a.base) ? 0 : 1;
    const bEspnMiss = preGameEspnMissSet.has(b.base) ? 0 : 1;
    if (aEspnMiss !== bEspnMiss) return aEspnMiss - bEspnMiss;
    // Closer to start time = higher priority
    const aMins = (pgGameStartTimes.get(a.base) ?? Number.MAX_SAFE_INTEGER) - now;
    const bMins = (pgGameStartTimes.get(b.base) ?? Number.MAX_SAFE_INTEGER) - now;
    if (Math.abs(aMins - bMins) > 30 * 60 * 1000) return aMins - bMins; // differ by >30min
    // Within similar time windows, prefer markets with larger recent price movement
    const priceMove = (mkt) => {
      const snap = preGameAnalyzedPrice.get(mkt.base);
      if (!snap) return 10; // never analyzed — treat as high priority
      const t1n = Math.round((mkt.team1?.price ?? 0) * 100);
      const t2n = Math.round((mkt.team2?.price ?? 0) * 100);
      return Math.max(Math.abs(t1n - snap.team1Cents), Math.abs(t2n - snap.team2Cents));
    };
    return priceMove(b) - priceMove(a);
  });
  const pgSlice = uncachedMarkets.slice(0, 5); // cap 12 → 5 per cycle (Option C)
  if (uncachedMarkets.length > 5) {
    console.log(`[pre-game] Cycle cap: analyzing top 5 of ${uncachedMarkets.length} (priority: near-kickoff + price-move)`);
    for (const _dropped of uncachedMarkets.slice(5)) {
      logPregameRejection(_dropped, 'pre-sonnet', 'cycle-cap-dropped', { gateContext: { totalUncached: uncachedMarkets.length, cap: 5 } });
    }
  }
  // Pre-game sizing capped at 5% per P1.3 — pass strategy so getDynamicMaxTrade applies the cap.
  const maxBetDisplay = getDynamicMaxTrade('kalshi', null, 'pre-game-prediction').toFixed(2);

  const todayDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });
  const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const currentSeasonYear = new Date().getFullYear();

  // ── ESPN starter enrichment ────────────────────────────────────────────────
  // Fetch confirmed starters/goalies from ESPN before calling Claude.
  // Claude's web search is unreliable for "is the starter confirmed tonight?" —
  // it often returns stale articles. ESPN's scoreboard API has real-time probables.
  // We inject these so Claude only needs to web-search for STATS, not identity.
  const espnStarterMap = new Map(); // team abbr (lowercase) → { name, era?, wl?, svPct?, gaa?, sport }
  const espnStartTimeMap = new Map(); // "AWAY-HOME" (uppercase) → Date object (UTC start time)
  // Sportsbook consensus from ESPN's odds field (free, no third-party API needed).
  // Key: "AWAY-HOME" uppercase. Value: { homeProb, awayProb, source, raw }
  // homeProb/awayProb are NO-VIG probabilities — divide raw moneyline implied probs
  // by their sum to strip the bookmaker's vig (~4-6% typical).
  // Used to anchor Sonnet's pre-game reasoning so it can't claim "edge" when
  // sharp consensus already prices the matchup at the same probability.
  const espnSportsbookMap = new Map();
  // 2026-05-02: team form + season record map. ESPN's competitor object includes
  // `form` (5-char W/L/D string of last 5 results) and `records[0].summary` (e.g.
  // "14-9-12"). Pre-fetched and injected into soccer prompts so Claude doesn't
  // have to web-search for form (unreliable) or guess. Big edge for MLS/EPL/etc.
  // Key: team abbr UPPERCASE → { form, recordSummary, teamName }
  const espnTeamFormMap = new Map();
  // 2026-05-02: added EPL, LaLiga, Serie A, Bundesliga, Ligue 1 paths so the
  // sportsbook-gap detector can actually fire for European soccer. Was 0 fires
  // ever because we never fetched their odds. Highest-edge pre-game signal we
  // have (no-vig sportsbook consensus vs Kalshi) — now active for all soccer.
  const espnSportPaths = [
    { key: 'MLB', path: 'baseball/mlb' },
    { key: 'NHL', path: 'hockey/nhl' },
    { key: 'NBA', path: 'basketball/nba' },
    { key: 'MLS', path: 'soccer/usa.1' },
    { key: 'EPL', path: 'soccer/eng.1' },
    { key: 'LALIGA', path: 'soccer/esp.1' },
    { key: 'SERIEA', path: 'soccer/ita.1' },
    { key: 'BUNDESLIGA', path: 'soccer/ger.1' },
    { key: 'LIGUE1', path: 'soccer/fra.1' },
  ];
  // espnRosterMap: team abbr (lowercase) → { active: string[], inactive: string[] }
  // Used to inject confirmed roster/lineup into prompts so Claude can't hallucinate wrong players
  const espnRosterMap = new Map();
  await Promise.all(espnSportPaths.map(async ({ key, path }) => {
    try {
      const res = await fetch(`http://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const ev of data.events ?? []) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const state = comp.status?.type?.state;
        if (state !== 'pre' && state !== 'in') continue;
        // Build start time map from ESPN event date (ISO UTC)
        // Key format: "AWAY-HOME" uppercase to match against Kalshi ticker team codes
        const competitors = comp.competitors ?? [];
        const away = competitors.find(c => c.homeAway === 'away');
        const home = competitors.find(c => c.homeAway === 'home');
        if (away && home && ev.date) {
          const awayAbbr = (away.team?.abbreviation ?? '').toUpperCase();
          const homeAbbr = (home.team?.abbreviation ?? '').toUpperCase();
          espnStartTimeMap.set(`${awayAbbr}-${homeAbbr}`, new Date(ev.date));
          // Extract sportsbook moneyline odds and compute no-vig consensus.
          // ESPN provides multiple sportsbooks in comp.odds[]; we use the first
          // one with both home/away moneylines populated.
          try {
            const oddsArr = comp.odds ?? [];
            for (const o of oddsArr) {
              const homeMl = o.homeTeamOdds?.moneyLine;
              const awayMl = o.awayTeamOdds?.moneyLine;
              if (typeof homeMl === 'number' && typeof awayMl === 'number') {
                // American moneyline → implied probability:
                //   negative odds:  P = -ml / (-ml + 100)
                //   positive odds:  P =  100 / (ml + 100)
                const mlToProb = (ml) => ml < 0 ? (-ml) / (-ml + 100) : 100 / (ml + 100);
                const homeRaw = mlToProb(homeMl);
                const awayRaw = mlToProb(awayMl);
                const total = homeRaw + awayRaw;
                if (total > 0) {
                  const homeProb = homeRaw / total;
                  const awayProb = awayRaw / total;
                  espnSportsbookMap.set(`${awayAbbr}-${homeAbbr}`, {
                    homeProb: Math.round(homeProb * 1000) / 1000,
                    awayProb: Math.round(awayProb * 1000) / 1000,
                    homeMl, awayMl,
                    source: o.provider?.name ?? 'sportsbook',
                  });
                  break;
                }
              }
            }
          } catch { /* odds optional; skip silently */ }
        }
        // 2026-05-02: capture team form (last 5 results) + season record per team.
        // ESPN provides this on every soccer scoreboard competitor.
        for (const team of competitors) {
          try {
            const abbrUpper = (team.team?.abbreviation ?? '').toUpperCase();
            if (!abbrUpper) continue;
            const form = typeof team.form === 'string' ? team.form : null;
            const recordSummary = team.records?.[0]?.summary ?? null;
            if (form || recordSummary) {
              espnTeamFormMap.set(abbrUpper, {
                form,
                recordSummary,
                teamName: team.team?.displayName ?? abbrUpper,
              });
            }
          } catch { /* form data is best-effort */ }
        }
        for (const team of competitors) {
          const abbr = (team.team?.abbreviation ?? '').toLowerCase();
          const probs = team.probables ?? [];
          if (probs.length > 0 && abbr) {
            const p = probs[0];
            const name = p.athlete?.displayName ?? '';
            if (!name) continue;
            const getStat = (abbrev) => p.statistics?.find(s => s.abbreviation === abbrev)?.displayValue ?? null;
            // Key by `${sport}:${abbr}` so NHL PHI (Flyers) doesn't collide with
            // MLB PHI (Phillies) — that collision put Dan Vladar in an MLB prompt.
            const _starterEntry = {
              name,
              era:   getStat('ERA'),
              w:     getStat('W'),
              l:     getStat('L'),
              whip:  getStat('WHIP'),
              svPct: getStat('SV%'),
              gaa:   getStat('GAA'),
              sport: key,
            };
            espnStarterMap.set(`${key}:${abbr}`, _starterEntry);
            // CHANGE DETECTION: compare to previous snapshot. If name differs, log change.
            // This is a high-edge event because sportsbooks reprice lineup news in <1min
            // while Kalshi typically lags 5-15 min — the edge window we want to capture.
            const _starterKey = `${key}:${abbr}`;
            const _prev = previousStarterMap.get(_starterKey);
            // Track every name seen in last 6h to detect ESPN ordering oscillation
            let _seen = seenStarterNames.get(_starterKey);
            if (!_seen) { _seen = new Map(); seenStarterNames.set(_starterKey, _seen); }
            // Prune entries older than 6h
            for (const [n, ts] of _seen) { if (Date.now() - ts > STARTER_CHANGE_TTL_MS) _seen.delete(n); }
            const _isOscillation = _seen.has(name); // we've already seen this "new" name recently
            if (_prev && _prev.name && _prev.name !== name && !_isOscillation) {
              const _prevEraNum = parseFloat(_prev.era ?? 'NaN');
              const _newEraNum = parseFloat(_starterEntry.era ?? 'NaN');
              starterChangeMap.set(_starterKey, {
                newName: name,
                newEra: _starterEntry.era,
                newEraNum: Number.isFinite(_newEraNum) ? _newEraNum : null,
                prevName: _prev.name,
                prevEra: _prev.era,
                prevEraNum: Number.isFinite(_prevEraNum) ? _prevEraNum : null,
                detectedAt: Date.now(),
              });
              console.log(`[lineup-change] 🚨 ${key} ${abbr.toUpperCase()} starter changed: ${_prev.name} (ERA ${_prev.era ?? '?'}) → ${name} (ERA ${_starterEntry.era ?? '?'})`);
              // 2026-04-30: Telegram notification silenced per user request — was firing 30+ times/day on
              // ESPN ordering oscillation. Console log retained for debugging. The change is still
              // injected into pre-game prompts via starterChangeMap if it passes oscillation dedup.
            } else if (_prev && _prev.name && _prev.name !== name && _isOscillation) {
              // Silent: ESPN flipped probables[0] order between two known candidates
            }
            _seen.set(name, Date.now());
            previousStarterMap.set(_starterKey, { name, era: _starterEntry.era, seenAt: Date.now() });
            // Clean up stale change entries (>6h old)
            for (const [k, v] of starterChangeMap) {
              if (Date.now() - v.detectedAt > STARTER_CHANGE_TTL_MS) starterChangeMap.delete(k);
            }
          }
          // NBA: extract active/inactive player list to prevent hallucinated lineups
          if (key === 'NBA' && abbr) {
            const roster = team.roster ?? [];
            const active = roster.filter(r => !r.didNotPlay).map(r => r.athlete?.displayName ?? r.athlete?.shortName ?? '').filter(Boolean);
            const inactive = roster.filter(r => r.didNotPlay).map(r => r.athlete?.displayName ?? r.athlete?.shortName ?? '').filter(Boolean);
            if (active.length > 0 || inactive.length > 0) {
              espnRosterMap.set(abbr, { active, inactive, teamName: team.team?.displayName ?? '' });
            }
            // INJURY-CHANGE DETECTION: detect when a NEW player appears in inactive list.
            // This catches "star ruled out" events where ESPN updates 30-60 min pre-game.
            // Sportsbooks reprice fast; Kalshi lags 5-15 min. Edge window for pre-game bet.
            const _nbaKey = `NBA:${abbr}`;
            const _prevInactive = previousNbaInactiveMap.get(_nbaKey) ?? new Set();
            const _newSet = new Set(inactive);
            const _newlyOut = inactive.filter(n => n && !_prevInactive.has(n));
            // Only fire when previous snapshot existed (avoid first-scan noise) AND
            // newly-out list is small (1-3 names — bigger lists usually mean roster
            // reset, e.g. game just started). Stale changes (>6h) get cleaned.
            if (_prevInactive.size > 0 && _newlyOut.length > 0 && _newlyOut.length <= 3) {
              nbaInjuryChangeMap.set(_nbaKey, { newlyOut: _newlyOut, detectedAt: Date.now() });
              console.log(`[injury-change] 🚨 NBA ${abbr.toUpperCase()} ruled OUT: ${_newlyOut.join(', ')}`);
              try { tg(`🚨 <b>NBA INJURY UPDATE — ${abbr.toUpperCase()}</b>\nRuled OUT: ${_newlyOut.join(', ')}\nKalshi may lag — bot will check next pre-game scan.`); } catch {}
            }
            previousNbaInactiveMap.set(_nbaKey, _newSet);
            // Clean up stale changes (>6h old)
            for (const [k, v] of nbaInjuryChangeMap) {
              if (Date.now() - v.detectedAt > STARTER_CHANGE_TTL_MS) nbaInjuryChangeMap.delete(k);
            }
          }
        }
      }
    } catch { /* skip — ESPN down or timeout */ }
  }));

  // Seed pgGameStartTimes with fresh ESPN start times so the TTL function has accurate data
  // for non-MLB sports (NBA/NHL/Soccer) on the NEXT scan cycle. MLB already parses from ticker.
  for (const mkt of preGameMarkets) {
    const t1 = mkt.team1.team.toUpperCase();
    const t2 = mkt.team2.team.toUpperCase();
    const startDate = espnStartTimeMap.get(`${t1}-${t2}`) ?? espnStartTimeMap.get(`${t2}-${t1}`);
    if (startDate) pgGameStartTimes.set(mkt.base, startDate.getTime());
  }

  // Build a per-market starter context string to inject at the top of each prompt.
  // These stats are ESPN ground truth — Claude must not contradict or hallucinate different numbers.
  const buildStarterContext = (market, sportKey) => {
    // sportKey is 'MLB' | 'NHL' | 'NBA' | 'MLS' — scope the starter lookup so
    // NHL PHI Flyers don't bleed into MLB PHI Phillies (Dan Vladar incident).
    const t1 = espnStarterMap.get(`${sportKey}:${market.team1.team.toLowerCase()}`);
    const t2 = espnStarterMap.get(`${sportKey}:${market.team2.team.toLowerCase()}`);
    const r1 = espnRosterMap.get(market.team1.team.toLowerCase());
    const r2 = espnRosterMap.get(market.team2.team.toLowerCase());
    const hasStarters = t1 || t2;
    const hasRosters  = r1 || r2;
    if (!hasStarters && !hasRosters) return '';

    const fmt = (abbr, s) => {
      if (!s) return `  ${abbr}: NOT IN ESPN — confirm via web search (≥2 independent sources: MLB.com, Baseball-Reference, team official, ESPN.com article). If confirmed, treat as valid and cite sources.`;
      const mlbStats = s.era
        ? ` | Record: ${s.w ?? '?'}-${s.l ?? '?'} | ERA: ${s.era} | WHIP: ${s.whip ?? '?'}`
        : '';
      const nhlStats = s.svPct ? ` | SV%: ${s.svPct} | GAA: ${s.gaa ?? '?'}` : '';
      return `  ${abbr}: ${s.name}${mlbStats}${nhlStats}  ← ESPN confirmed starter`;
    };

    // Bullpen-game detection (MLB only): when BOTH sides show NOT IN ESPN, this is
    // often a genuine opener/bullpen game rather than missing data. Tell Claude to
    // analyze at the team level (bullpen ERA, team OPS, form) instead of requiring
    // a designated starter.
    const isBullpenGame = sportKey === 'MLB' && !t1 && !t2 && (r1 || r2);

    const fmtRoster = (abbr, r) => {
      if (!r) return '';
      const t = r.teamName ? `${abbr} (${r.teamName})` : abbr;
      const inactStr = r.inactive.length > 0 ? `\n    OUT/DNP: ${r.inactive.slice(0, 8).join(', ')}` : '';
      const actStr = r.active.length > 0 ? `\n    Available: ${r.active.slice(0, 8).join(', ')}` : '';
      return `  ${t}:${actStr}${inactStr}`;
    };

    let out = `⚡ ESPN GROUND TRUTH — DO NOT CONTRADICT THESE NUMBERS IN YOUR REASONING:\n`;
    if (isBullpenGame) {
      out += `  ⚾ BULLPEN GAME — neither team has a designated starter in ESPN. This is not missing data; this is a genuine opener/bullpen day. Analyze at the team level: bullpen ERA, recent team form, lineup strength, home/road splits, motivation. Do NOT require starter confirmation to trade — there is no starter.\n`;
    } else if (hasStarters) {
      out += fmt(market.team1.team, t1) + '\n';
      out += fmt(market.team2.team, t2) + '\n';
      out += `⛔ STAT INTEGRITY RULES:\n`;
      out += `  • The ERA/WHIP/SV% numbers above are the authoritative ground truth for today.\n`;
      out += `  • Do NOT cite different ERA/WHIP/SV% values in your reasoning — your training data may be stale.\n`;
      out += `  • If your web search returns a different ERA, explicitly note "ESPN shows X, search shows Y" and explain why you prefer one.\n`;
      out += `  • Treat ESPN-confirmed starters as confirmed. If ESPN shows "NOT IN ESPN" for one starter, your web search can still confirm them — require ≥2 independent sources (MLB.com, Baseball-Reference, team official, ESPN article) and cite them. Only fire Hard NO if neither ESPN nor 2+ web sources can confirm.\n`;
    }
    if (hasRosters) {
      out += `\n📋 ESPN ROSTER STATUS (confirmed active/inactive players):\n`;
      out += fmtRoster(market.team1.team, r1) + '\n';
      out += fmtRoster(market.team2.team, r2) + '\n';
      out += `  ⚠️ ROSTER INTEGRITY: Only cite players listed above. Do NOT reference players from other teams.\n`;
    }
    out += `\n`;
    return out;
  };

  const pgPrompts = pgSlice.filter(market => {
    // Pre-filter: drop soccer leagues where winner bets are disabled BEFORE
    // we burn Claude tokens on them. The downstream block at ~line 5669 was
    // firing too late — markets were analyzed, returned malformed prose (e.g.
    // NYRBDCU 2026-04-22), triggered no-json alerts, wasted API budget.
    const tk = market.base ?? '';
    // 2026-04-24: MLS pre-game RE-ENABLED with cross-sport killer-bucket block now in place.
    // Historical 4 trades, -$35 P&L was driven by NE-CLB-style narrative stacks (low-priced
    // underdog + claimed 30+pt edge) — exactly the pattern the new block catches.
    // Soccer prompt has been hardened (TIE leg context, draw tax, underdog cap to 40¢).
    // SerieA/Bundesliga/Ligue1 still excluded — Kalshi has 0 markets for those leagues anyway.
    if (tk.includes('SERIAAGAME') || tk.includes('BUNDESLIGAGAME') || tk.includes('LIGUE1GAME')) {
      return false;
    }
    return true;
  }).map(market => {
    const tk = market.base ?? '';
    const sport = tk.includes('NBA') ? 'NBA' : tk.includes('NHL') ? 'NHL' :
      tk.includes('MLB') ? 'MLB' : tk.includes('MLS') ? 'MLS' :
      tk.includes('EPL') ? 'EPL' : tk.includes('LALIGA') ? 'La Liga' :
      tk.includes('SERIAA') ? 'Serie A' : tk.includes('BUNDESLIGA') ? 'Bundesliga' :
      tk.includes('LIGUE1') ? 'Ligue 1' : 'Sport';
    const starterCtx = buildStarterContext(market, sport);
    // LINEUP-CHANGE injection: if either team's starter changed within the last
    // 6h, surface it prominently. This is a high-edge event because sportsbooks
    // reprice in <1min while Kalshi lags 5-15min on lineup news. Sonnet should
    // weight this heavily and the change-direction (better/worse new starter)
    // tells the bet direction.
    let lineupChangeCtx = '';
    {
      const t1Abbr = (market.team1?.team ?? '').toLowerCase();
      const t2Abbr = (market.team2?.team ?? '').toLowerCase();
      const c1 = starterChangeMap.get(`${sport}:${t1Abbr}`);
      const c2 = starterChangeMap.get(`${sport}:${t2Abbr}`);
      const fmtChange = (c, teamName) => {
        const dir = (c.newEraNum != null && c.prevEraNum != null)
          ? (c.newEraNum > c.prevEraNum + 0.5 ? '⬇️ WORSE' : c.newEraNum < c.prevEraNum - 0.5 ? '⬆️ BETTER' : '↔️ similar')
          : '';
        const ageMin = Math.round((Date.now() - c.detectedAt) / 60000);
        return `🚨 ${teamName} STARTER CHANGED ${ageMin}min ago: ${c.prevName} (ERA ${c.prevEra ?? '?'}) → ${c.newName} (ERA ${c.newEra ?? '?'}) ${dir}`;
      };
      const lines = [];
      if (c1) lines.push(fmtChange(c1, market.team1.teamName));
      if (c2) lines.push(fmtChange(c2, market.team2.teamName));
      // NBA injury changes (newly-out players)
      if (sport === 'NBA') {
        const inj1 = nbaInjuryChangeMap.get(`NBA:${t1Abbr}`);
        const inj2 = nbaInjuryChangeMap.get(`NBA:${t2Abbr}`);
        const fmtInj = (inj, teamName) => {
          const ageMin = Math.round((Date.now() - inj.detectedAt) / 60000);
          return `🚨 ${teamName} INJURY UPDATE ${ageMin}min ago — ruled OUT: ${inj.newlyOut.join(', ')}`;
        };
        if (inj1) lines.push(fmtInj(inj1, market.team1.teamName));
        if (inj2) lines.push(fmtInj(inj2, market.team2.teamName));
      }
      if (lines.length > 0) {
        lineupChangeCtx =
          `\n🚨🚨🚨 LINEUP CHANGE DETECTED — HIGH-EDGE EVENT 🚨🚨🚨\n` +
          lines.join('\n') + '\n' +
          `EDGE LOGIC: Sportsbooks repriced this in <1 minute. Kalshi typically lags 5-15 minutes on lineup news.\n` +
          `If the new starter is materially worse (ERA +0.8+), bet AGAINST that team. Use reasoning_tag "injury-news".\n` +
          `If the new starter is materially better, bet FOR that team. Use reasoning_tag "injury-news".\n` +
          `If the change is similar quality (within 0.5 ERA), the lineup-change edge is SMALL — only fire if Kalshi clearly lagged sportsbook.\n` +
          `THIS OVERRIDES the standard "thin edge" rejection — lineup-change IS a confirmed edge.\n\n`;
      }
    }
    // Sportsbook anchor — fetch ESPN's no-vig consensus for this matchup so Sonnet
    // can compare its confidence to sharp-market consensus. Without this, Sonnet
    // is essentially regurgitating the same analysis sportsbooks already ran.
    // Lookup tries both team-order keys since Kalshi market team1/team2 order
    // isn't always away/home.
    const _t1 = (market.team1?.team ?? '').toUpperCase();
    const _t2 = (market.team2?.team ?? '').toUpperCase();
    const _sportsbook = espnSportsbookMap.get(`${_t1}-${_t2}`) ?? espnSportsbookMap.get(`${_t2}-${_t1}`);
    const _isT1Away = _sportsbook ? espnSportsbookMap.has(`${_t1}-${_t2}`) : false;
    let sportsbookCtx = '';
    if (_sportsbook) {
      // Map to which side is team1 (since Kalshi prices market.team1 vs market.team2)
      const isT1Away = _isT1Away;
      const t1Prob = isT1Away ? _sportsbook.awayProb : _sportsbook.homeProb;
      const t2Prob = isT1Away ? _sportsbook.homeProb : _sportsbook.awayProb;
      const t1Cents = Math.round(t1Prob * 100);
      const t2Cents = Math.round(t2Prob * 100);
      const k1Cents = Math.round((market.team1.price ?? 0) * 100);
      const k2Cents = Math.round((market.team2.price ?? 0) * 100);
      const t1Delta = k1Cents - t1Cents;
      const t2Delta = k2Cents - t2Cents;
      sportsbookCtx =
        `📊 SPORTSBOOK SHARP CONSENSUS (no-vig from ${_sportsbook.source}):\n` +
        `  ${market.team1.teamName} (${market.team1.team}): SPORTSBOOK=${t1Cents}% | KALSHI=${k1Cents}¢ | Δ=${t1Delta>=0?'+':''}${t1Delta}pt\n` +
        `  ${market.team2.teamName} (${market.team2.team}): SPORTSBOOK=${t2Cents}% | KALSHI=${k2Cents}¢ | Δ=${t2Delta>=0?'+':''}${t2Delta}pt\n` +
        `\n` +
        `🎯 EDGE ANCHOR RULES:\n` +
        `  • Sportsbook is the SHARP MARKET — its no-vig probability reflects ALL public information already (injuries, matchup, recent form, weather). It is the truth-meter.\n` +
        `  • If your confidence MATCHES sportsbook (within 3pt), you are NOT finding edge — you are recapping consensus. Return trade=false.\n` +
        `  • If your confidence is HIGHER than sportsbook by 5pt+, you are claiming sportsbook is wrong. You MUST cite a SPECIFIC reason (lineup news from your search not yet absorbed, structural pattern, or unique matchup factor). Generic "team X is better" is not enough.\n` +
        `  • If your confidence is LOWER than sportsbook by 5pt+, you must explain why the sharp market is overconfident. This is rare — usually sharp markets are right.\n` +
        `  • IF Kalshi differs from sportsbook by 5+pt in either direction, that itself is a market-lag edge — Kalshi is slow, sportsbook is fast. Bias to trust sportsbook.\n\n`;
    } else {
      // No sportsbook data available (rare — usually means game not on ESPN scoreboard yet)
      sportsbookCtx =
        `📊 SPORTSBOOK CONSENSUS: not available for this game (ESPN scoreboard didn't return odds).\n` +
        `  Without a sharp anchor, BE EXTRA CAUTIOUS. Generic confidence in "team X is better" is exactly what sportsbooks already priced. Apply 5pt downward bias to your confidence.\n\n`;
    }

    // 2026-05-02: TEAM FORM context — pre-fetched from ESPN scoreboard. Last 5
    // results (W/L/D pattern) + season record summary. Reliable, fresh, no
    // web search required. Gives Claude concrete form data instead of guessing.
    let teamFormCtx = '';
    try {
      const f1 = espnTeamFormMap.get(_t1);
      const f2 = espnTeamFormMap.get(_t2);
      if (f1 || f2) {
        const fmtForm = (s) => {
          if (!s) return null;
          // ESPN form is ordered MOST-RECENT-FIRST. e.g. "WLDDD" = last:W prev:L
          const parts = s.split('').map(c => c === 'W' ? '✓W' : c === 'L' ? '✗L' : '–D');
          return parts.join(' ');
        };
        teamFormCtx = `📋 TEAM FORM (ESPN — verified, do NOT contradict via web search):\n`;
        if (f1) {
          teamFormCtx += `  ${market.team1.team}: form=${fmtForm(f1.form) ?? '?'} | season=${f1.recordSummary ?? '?'}\n`;
        }
        if (f2) {
          teamFormCtx += `  ${market.team2.team}: form=${fmtForm(f2.form) ?? '?'} | season=${f2.recordSummary ?? '?'}\n`;
        }
        teamFormCtx += `  CALIBRATION: 5-loss-streak teams are not "due for a win" — the streak is information about quality. 5-win-streak teams have momentum priced in already; only +EV when market underprices their dominance vs current opponent's actual form.\n\n`;
      }
    } catch { /* form is best-effort */ }
    // Hard anti-hallucination preamble — injected before every prompt.
    const antiHallucinationHeader =
      `🛑 ZERO-FABRICATION RULES — violations invalidate your analysis and the trade will be blocked:\n` +
      `1. SPORT: This is a ${sport} game — ${market.team1.teamName} vs ${market.team2.teamName}. Do NOT cite players, stats, starters, or storylines from any other sport.\n` +
      `2. DATE/TIME: Right now is ${nowET} (${todayDate}). The current ${sport} season is ${currentSeasonYear}. Do NOT cite stats or standings from prior seasons as if they were current.\n` +
      `3. PLAYERS: Only cite players who are CURRENTLY on the ${market.team1.teamName} or ${market.team2.teamName} roster in ${currentSeasonYear}. If you cannot confirm a player is on one of these two teams right now, do NOT name them. Same last-name on a different franchise is a different person.\n` +
      `4. STATS: ERA/WHIP/SV%/GAA numbers in the ESPN GROUND TRUTH block (below) are authoritative. If you write a different value in your reasoning, your analysis is invalid.\n` +
      `5. DO NOT MAKE ANYTHING UP. If a fact is not in ESPN ground truth and not confirmed by your web search, say "unconfirmed" and downgrade your confidence. Never invent names, numbers, records, or streaks.\n` +
      `6. If your web search returns results for a DIFFERENT sport, game, or date than this game — ignore those results and note the conflict. Do not let cross-query contamination enter your reasoning.\n` +
      `7. 🚫 KNOWN-WRONG NAMES — these names have repeatedly shown up in wrong-sport analyses. If you catch yourself citing any of them outside their actual sport, STOP, delete the sentence, and re-read the game title:\n` +
      `   • "Connelly Early" — MLB pitcher only. If this is NOT an MLB game and you cited him, you are hallucinating.\n` +
      `   • "Dominic James" — not a current starter. Verify against ESPN ground truth before citing any goalie/pitcher.\n` +
      `   Add this check BEFORE writing your reasoning — if a search result surfaces one of these names and it doesn't match ${sport}, discard it.\n\n`;

    // pgPromptText now holds ONLY the dynamic per-game content. The static
    // framework (decision tree, hard NOs, calibration scale, underdog check,
    // historical data, win prob baseline) lives in per-sport SYSTEM constants
    // (NBA_PG_FRAMEWORK / NHL_PG_FRAMEWORK / MLB_PG_FRAMEWORK / SOCCER_PG_FRAMEWORK)
    // which are passed as the cached system prompt below — saves ~40% on
    // pre-game input cost via Anthropic prompt caching.
    const pgPromptText = sport === 'NBA'
      ? `TODAY is ${todayDate}.\n\n` +
        `GAME: ${market.title}\n` +
        `${market.team1.teamName} (${market.team1.team}) wins: ${(market.team1.price*100).toFixed(0)}¢\n` +
        `${market.team2.teamName} (${market.team2.team}) wins: ${(market.team2.price*100).toFixed(0)}¢\n\n` +
        `═══ STEP 1 — SEARCH & ASSESS ═══\n` +
        `Search for "${market.team1.teamName} vs ${market.team2.teamName} ${todayDate} injury report lineup news head to head recent meetings" and use results to assess:\n` +
        `A) ROSTER QUALITY: Who are the key players for each team? Any stars OUT, DOUBTFUL, or on rest? Confirmed injuries from your search trump training knowledge.\n` +
        `B) BACK-TO-BACK: Is either team on a back-to-back or 3rd game in 4 nights? Check schedule from search results. Fatigue significantly reduces win probability.\n` +
        `C) MOTIVATION: Where are these teams in the standings? Playoff race, seeding fights, or coasting? NBA teams tanking or fully clinched play worse.\n` +
        `D) MATCHUP EDGE: Does this team have a structural advantage — size, pace, offensive system — that makes them more likely to win specifically against this opponent?\n` +
        `E) HEAD-TO-HEAD (PLAYOFFS ONLY): If this is a playoff series or the teams have met in the same series recently, note who has won recent meetings and by what margin. Regular-season H2H is mostly noise — ignore unless playoff context. Playoff H2H is signal — +3% for a team that won 3 of the last 4 meetings in the series.\n\n` +
        `Max bet: $${maxBetDisplay}\n\n` +
        // Calibration feedback moved to cached system prompt (2026-04-29) — no longer duplicated here
        '' +
        `JSON ONLY — include exitScenario:\n` +
        `{"trade":false,"confidence":0.XX,"reasoning":"one sentence"}\n` +
        `OR {"trade":true,"team":"${market.team1.team}" or "${market.team2.team}","confidence":0.XX,"betAmount":N,"exitScenario":"specific reason e.g. opponent resting 3 starters, team motivated for playoff seeding — price rises when they build Q1 lead","reasoning":"one sentence","reasoning_tags":["1-3 lowercase hyphen-delimited tags from this list ONLY: era-gap, playoff-home-fav, starter-mismatch, bullpen-mismatch, market-lag, public-fade, goalie-mismatch, lineup-cold, injury-news, line-movement, we-undervalued, momentum-shift, underdog-spot, schedule-spot, pitcher-form, star-injury, pace-mismatch, back-to-back, rest-advantage, home-court, motivation, other"]}`

      : sport === 'NHL'
      ? `TODAY is ${todayDate}.\n\n` +
        `⚠️ ROSTER INTEGRITY: Only cite players who play for ${market.team1.teamName} or ${market.team2.teamName}. Do NOT reference players from other franchises.\n\n` +
        `GAME: ${market.title}\n` +
        `${market.team1.teamName} (${market.team1.team}) wins: ${(market.team1.price*100).toFixed(0)}¢\n` +
        `${market.team2.teamName} (${market.team2.team}) wins: ${(market.team2.price*100).toFixed(0)}¢\n\n` +
        `═══ STEP 1 — SEARCH & ASSESS ═══\n` +
        `Search for "${market.team1.teamName} vs ${market.team2.teamName} ${todayDate} goalie confirmed injury news playoff series head to head" and use results to assess:\n` +
        `A) GOALIES: Goalies confirmed above from ESPN — use the ESPN SV%/GAA as ground truth. Verify with search for any last-minute changes. Assess each goalie's win probability impact. An elite goalie (SV% > .920) vs. a backup (.890) is a 10-15% win probability swing. In playoff context: search for 2026 PLAYOFF SV% specifically — elite goalies outperform regular-season numbers in elimination games.\n` +
        `B) SPECIAL TEAMS: From search + training knowledge, assess power play and penalty kill quality. Top-5 PP teams convert at a higher rate and generate scoring momentum.\n` +
        `C) FATIGUE: Is either team on a back-to-back? NHL back-to-back teams win at ~8% lower rates.\n` +
        `D) MOTIVATION: Playoff race intensity for each team. Teams fighting for seeding play harder in regulation.\n` +
        `E) HEAD-TO-HEAD (PLAYOFFS ONLY): If this is a playoff series game, note series score (e.g. 2-1) and who won recent meetings. Momentum in a playoff series is real: +3% for the team coming off a win in the series, -3% for a team that just lost Game N at home. Regular-season H2H is noise — ignore outside playoffs.\n\n` +
        // Calibration feedback moved to cached system prompt (2026-04-29) — no longer duplicated here
        '' +
        `JSON ONLY — include exitScenario:\n` +
        `{"trade":false,"confidence":0.XX,"reasoning":"one sentence"}\n` +
        `OR {"trade":true,"team":"${market.team1.team}" or "${market.team2.team}","confidence":0.XX,"betAmount":N,"exitScenario":"specific reason e.g. elite goalie SV .928 vs backup .891 — price rises when they score first","reasoning":"one sentence","reasoning_tags":["1-3 lowercase hyphen-delimited tags from this list ONLY: era-gap, playoff-home-fav, starter-mismatch, bullpen-mismatch, market-lag, public-fade, goalie-mismatch, lineup-cold, injury-news, line-movement, we-undervalued, momentum-shift, underdog-spot, schedule-spot, pitcher-form, star-injury, pace-mismatch, back-to-back, rest-advantage, home-court, motivation, other"]}`

      : sport === 'MLB'
      ? `TODAY is ${todayDate}.\n\n` +
        `⚠️ ROSTER INTEGRITY: Verify any player name you mention belongs to ${market.team1.teamName} or ${market.team2.teamName}, not another franchise.\n\n` +
        `GAME: ${market.title}\n` +
        `${market.team1.teamName} (${market.team1.team}) wins: ${(market.team1.price*100).toFixed(0)}¢\n` +
        `${market.team2.teamName} (${market.team2.team}) wins: ${(market.team2.price*100).toFixed(0)}¢\n\n` +
        `═══ STEP 1 — SEARCH & ASSESS ═══\n` +
        `Search for "${market.team1.teamName} vs ${market.team2.teamName} ${todayDate} pitcher stats lineup news" and use results to assess:\n` +
        `A) STARTING PITCHERS: Starters are listed above from ESPN. Verify with search — confirm 2026 ERA, WHIP, recent form. An ace (ERA < 3.0) dominates and wins ~65% of starts. A weak starter (ERA > 5.0) loses more than they win and get lit up early.\n` +
        `B) BULLPEN: Does this team have a strong bullpen to protect leads? Weak bullpens blow leads in the 7th-8th even with good starters.\n` +
        `C) LINEUP POWER: Assess run-scoring ability from search results. Strong lineups (+4.5 R/G) put pressure on the opponent. Known sluggers in the 3-4 spots.\n` +
        `D) PARK FACTOR: Note the park for context only — do NOT add percentage points for park factors. The market already prices park factors in. A hitter's park at Coors doesn't give you an edge; the market knows Coors exists.\n\n` +
        // Calibration feedback moved to cached system prompt (2026-04-29) — no longer duplicated here
        '' +
        `JSON ONLY — include exitScenario:\n` +
        `{"trade":false,"confidence":0.XX,"reasoning":"one sentence"}\n` +
        `OR {"trade":true,"team":"${market.team1.team}" or "${market.team2.team}","confidence":0.XX,"betAmount":N,"exitScenario":"specific reason e.g. ace ERA 2.8 vs ERA 5.1 starter — price rises when they score first and market reprices win probability","reasoning":"one sentence","reasoning_tags":["1-3 lowercase hyphen-delimited tags from this list ONLY: era-gap, playoff-home-fav, starter-mismatch, bullpen-mismatch, market-lag, public-fade, goalie-mismatch, lineup-cold, injury-news, line-movement, we-undervalued, momentum-shift, underdog-spot, schedule-spot, pitcher-form, star-injury, pace-mismatch, back-to-back, rest-advantage, home-court, motivation, other"]}`

      : /* Soccer (MLS / EPL / La Liga / Serie A / Bundesliga / Ligue 1) */
      `TODAY is ${todayDate}.\n\n` +
        `⛔ ROSTER INTEGRITY: Only cite players confirmed on ${market.team1.teamName} or ${market.team2.teamName} rosters. Do NOT reference players from other clubs.\n\n` +
        `GAME: ${market.title}\n` +
        `${market.team1.teamName} (${market.team1.team}) wins: ${(market.team1.price*100).toFixed(0)}¢\n` +
        `${market.team2.teamName} (${market.team2.team}) wins: ${(market.team2.price*100).toFixed(0)}¢\n` +
        (market.tie ? `DRAW (tie): ${(market.tie.price*100).toFixed(0)}¢  ← market-implied draw probability\n` : '') +
        (market.tie ? `⚠️ 3-WAY CHECK: ${(market.team1.price*100).toFixed(0)} + ${(market.team2.price*100).toFixed(0)} + ${(market.tie.price*100).toFixed(0)} = ${Math.round((market.team1.price + market.team2.price + market.tie.price) * 100)}¢. Draw takes ${Math.round(market.tie.price*100)}% probability off the top of the win market — your win confidence must beat both the price AND the draw leg.\n` : '') +
        `\n` +
        `═══ STEP 1 — SEARCH & ASSESS ═══\n` +
        `Search for "${market.team1.teamName} vs ${market.team2.teamName} ${todayDate} team news injuries form recent meetings head to head" and use results to assess:\n` +
        `A) ATTACK QUALITY: How prolific is each team's attack? Top-5 goals-per-game teams generate scoring chances that translate to wins.\n` +
        `B) KEY PLAYERS: Are either team's star strikers/forwards available? Check injury news from search. Key absences significantly reduce win probability.\n` +
        `C) FORM & STYLE: Recent form from search results. High-energy pressing teams create chances earlier. Teams in strong form win at higher rates.\n` +
        `D) MOTIVATION: Is either team in a must-win (relegation, title run, European qualification)? Higher motivation = more aggressive pressing = more goals = higher win probability.\n` +
        `E) DEFENSE: Elite defenses (conceding <0.8/game) can keep motivated opponents scoreless. Porous defenses lose more games.\n` +
        `F) HEAD-TO-HEAD: Soccer H2H is more meaningful than US sports — tactical matchups, psychological edges, and stylistic mismatches persist across seasons. If one side has won ≥3 of the last 5 meetings OR dominated the last 2 with clean sheets, that is a real +3-5% signal. Cite the specific scorelines from search, not a vague "they own this matchup."\n\n` +
        // Calibration feedback moved to cached system prompt (2026-04-29) — no longer duplicated here
        '' +
        `JSON ONLY — include exitScenario:\n` +
        `{"trade":false,"confidence":0.XX,"reasoning":"one sentence"}\n` +
        `OR {"trade":true,"team":"${market.team1.team}" or "${market.team2.team}","confidence":0.XX,"betAmount":N,"exitScenario":"specific reason e.g. prolific attack vs defense conceding 1.8/game — price rises when they score first goal","reasoning":"one sentence","reasoning_tags":["1-3 lowercase hyphen-delimited tags from this list ONLY: era-gap, playoff-home-fav, starter-mismatch, bullpen-mismatch, market-lag, public-fade, goalie-mismatch, lineup-cold, injury-news, line-movement, we-undervalued, momentum-shift, underdog-spot, schedule-spot, pitcher-form, star-injury, pace-mismatch, back-to-back, rest-advantage, home-court, motivation, other"]}`;

    // STRUCTURAL FAST PATH: if Kalshi differs from sportsbook consensus by 5-15pt,
    // mechanical fire — skip Sonnet entirely. This is the highest-confidence
    // pre-game signal (sportsbook is the sharp market; Kalshi lag = pure +EV).
    let _pgStructural = null;
    if (_sportsbook) {
      _pgStructural = detectPregameSportsbookGap(
        market,
        { ..._sportsbook, isT1Away: _isT1Away },
        sport
      );
      if (_pgStructural) {
        console.log(`[pre-game] 🎯 STRUCTURAL (sportsbook-gap): ${market.base} ${_pgStructural.team} — sportsbook ${_pgStructural._matchInfo.prob}% vs Kalshi ${Math.round((_pgStructural.team === market.team1.team ? market.team1.price : market.team2.price) * 100)}¢ (${_pgStructural._matchInfo.gap}pt gap) — bypassing Sonnet`);
      }
    }

    return {
      market,
      sport,
      _structuralDecision: _pgStructural,
      _sportsbook,
      _isT1Away,
      // Order: anti-hallucination → LINEUP CHANGE (highest priority) → sportsbook anchor → starters → analysis.
      // Lineup change first because it's the BIGGEST signal — if the starter
      // just changed, Sonnet should react to that before any other consideration.
      prompt: antiHallucinationHeader + lineupChangeCtx + sportsbookCtx + teamFormCtx + starterCtx + pgPromptText,
    };
  });

  let preGameTradesThisCycle = 0;
  for (let batch = 0; batch < pgPrompts.length; batch += 3) {
    if (preGameTradesThisCycle >= MAX_PREGAME_PER_CYCLE) break;
    const batchItems = pgPrompts.slice(batch, batch + 3);
    const batchResults = await Promise.allSettled(
      batchItems.map(item => {
        // Structural fast path — sportsbook-gap mechanical detector returns
        // synthetic JSON that downstream code parses identically to Sonnet output.
        // Saves the API call and reacts in zero time.
        if (item._structuralDecision) {
          return Promise.resolve(JSON.stringify(item._structuralDecision));
        }
        // 2026-04-29 COST OPTIMIZATION — switched from claudeWithSearch to claudeSonnet.
        // Pre-game web search added ~$0.01/call ($14 over 10d at 1433 calls). The bot
        // already provides comprehensive ESPN ground truth (starters, lineups, sportsbook
        // anchor, lineup-change context) so search rarely surfaces meaningfully new info.
        // For high-impact triggers (lineup change in last 30min, breaking news), the
        // bot's existing scrapers handle fresh data. Sonnet's training data + bot context
        // is sufficient for routine pre-game evaluation.
        return claudeSonnet(item.prompt, {
          maxTokens: 2000,
          timeout: 30000,
          category: 'pre-game',
          // Per-sport system prompt with cached static framework. The 1500-3000 token
          // framework (decision tree, hard NOs, calibration scale, underdog check)
          // caches via cache_control: ephemeral. Calibration feedback now appended
          // here too so it's cached alongside the framework (was inline in user prompt).
          system: PG_BASE_SYSTEM + getPgFramework(item.sport) + (getCalibrationFeedback() || ''),
          cacheSystem: true,
        });
      })
    );

    for (let i = 0; i < batchItems.length; i++) {
      const { market, _sportsbook: _pgSportsbook, _isT1Away: _pgIsT1Away } = batchItems[i];
      const batchRes = batchResults[i];
      const decideText = batchRes.status === 'fulfilled' ? batchRes.value : null;
      if (!decideText) {
        // Same transient-timeout suppression as live-edge. Two paths to detect:
        // explicit rejection-message regex, or backstop via wrapper-set transient flag.
        const reasonMsg = batchRes.status === 'rejected' ? (batchRes.reason?.message ?? '') : '';
        const isTransientTimeout = CLAUDE_TRANSIENT_REGEX.test(reasonMsg) || _claudeTransientRecent();
        if (isTransientTimeout) {
          console.log(`[pre-game] ⏳ Transient timeout on ${market.base}${reasonMsg ? ': ' + reasonMsg.slice(0, 100) : ' (caught by wrapper)'} — silent skip, will retry next cycle`);
        } else {
          await reportError('pre-game:sonnet-empty', `${market.base}${reasonMsg ? ': ' + reasonMsg : ''}`);
        }
        continue;
      }

      const jsonMatch = extractJSON(decideText);
      if (!jsonMatch) {
        await reportError('pre-game:no-json', `${market.base}: ${decideText.slice(0, 160)}`);
        continue;
      }
      let decision;
      try { decision = JSON.parse(jsonMatch); } catch (e) {
        await reportError('pre-game:parse-fail', `${market.base}: ${e.message} | head=${jsonMatch.slice(0, 160)}`);
        continue;
      }

      // Pre-game shadow tracking — captures every Sonnet pre-game decision for offline
      // calibration analysis (matches the live-edge pattern). Live-edge has 350+
      // shadow records; pre-game previously had zero. Adding this gives us 100x more
      // calibration signal on pre-game decisions over the next 2 weeks.
      try {
        const _pgShadowSport = sport === 'NBA' ? 'NBA' : sport === 'MLB' ? 'MLB' : sport === 'NHL' ? 'NHL' : 'Soccer';
        const _pgShadowTarget = (decision.team ?? '').toUpperCase() || market.team1?.team || market.team2?.team || '';
        const _pgShadowPrice = decision.team
          ? (decision.team.toUpperCase() === market.team1.team.toUpperCase() ? market.team1.price : market.team2.price)
          : null;
        // Pre-game shadow context — game hasn't started, so velocity/clock are
        // mostly null. Bid/ask spread + time-of-day still informative.
        const _pgShadowTicker = market.base + (decision.team ? '-' + decision.team.toUpperCase() : '');
        const _pgShadowCtx = buildShadowContext({
          priceData: null,
          gameDetail: null, ticker: _pgShadowTicker, side: 'yes',
          decisionPrice: _pgShadowPrice,
        });
        logShadowDecision({
          stage: 'pre-game',
          ticker: _pgShadowTicker,
          sport: _pgShadowSport,
          league: sport === 'NBA' ? 'nba' : sport === 'MLB' ? 'mlb' : sport === 'NHL' ? 'nhl' : (league || 'soccer'),
          decision: decision.trade ? 'trade' : 'no-trade',
          rejectReason: decision.trade ? null : 'claude-no',
          claudeConfidence: decision.confidence ?? null,
          decisionPrice: _pgShadowPrice,
          edge: decision.confidence != null && _pgShadowPrice != null ? Math.round((decision.confidence - _pgShadowPrice) * 100) : null,
          targetAbbr: _pgShadowTarget,
          reasoningPreview: (decision.reasoning ?? '').slice(0, 200),
          reasoningStructured: decision.reasoning_structured ?? null,
          reasoningTags: decision.reasoning_tags ?? null,
          ..._pgShadowCtx,
        });
      } catch (e) { /* shadow logging best-effort, never block trade flow */ }

      // Map Claude's team pick to the correct ticker — ALWAYS buy YES on that team's market
      const chosenTeam = (decision.team ?? '').toUpperCase();
      let matchedSide = null;
      if (chosenTeam === market.team1.team.toUpperCase()) {
        matchedSide = market.team1;
      } else if (chosenTeam === market.team2.team.toUpperCase()) {
        matchedSide = market.team2;
      } else {
        // Try fuzzy match (teamName contains abbreviation)
        if (market.team1.teamName.toUpperCase().includes(chosenTeam) || chosenTeam.includes(market.team1.team.toUpperCase())) {
          matchedSide = market.team1;
        } else if (market.team2.teamName.toUpperCase().includes(chosenTeam) || chosenTeam.includes(market.team2.team.toUpperCase())) {
          matchedSide = market.team2;
        }
      }
      if (!matchedSide) {
        console.log(`[pre-game] BLOCKED: Claude picked team "${chosenTeam}" but game has ${market.team1.team} vs ${market.team2.team}`);
        logPregameRejection(market, 'post-sonnet-gate', 'team-mismatch', { team: chosenTeam, confidence: decision.confidence, reasoningPreview: (decision.reasoning ?? '').slice(0, 200), gateContext: { picked: chosenTeam, available: [market.team1.team, market.team2.team] } });
        continue;
      }

      // Validate: cross-check team in JSON against reasoning text
      // Claude sometimes picks the wrong abbreviation (says "BUF wins" but outputs team:"CHI")
      const reasoning = (decision.reasoning ?? '').toLowerCase();
      const otherSide = matchedSide === market.team1 ? market.team2 : market.team1;
      const otherTeamLower = otherSide.teamName.toLowerCase();
      const chosenTeamLower = matchedSide.teamName.toLowerCase();

      // Validate: cross-check Claude's team pick against its own reasoning
      // Claude sometimes picks the WRONG abbreviation (says "Buffalo wins" but outputs team:"CHI")
      // Simple check: count how many times each team is mentioned positively vs negatively
      const otherTeamNames = [otherSide.team.toLowerCase(), otherTeamLower.split(' ')[0]];
      const chosenTeamNames = [matchedSide.team.toLowerCase(), chosenTeamLower.split(' ')[0]];

      // Positive signals in reasoning
      const positiveWords = ['favorite', 'favored', 'better', 'stronger', 'dominant', 'elite', 'superior', 'advantage', 'win streak', 'hot'];
      const negativeWords = ['eliminated', 'last place', 'worst', 'losing streak', 'struggling', 'injury', 'injured', 'depleted', 'poor', 'weak'];

      let otherPositive = 0, chosenPositive = 0, otherNegative = 0, chosenNegative = 0;

      // Split reasoning into sentences and check context
      const sentences = reasoning.split(/[.;]/);
      for (const sentence of sentences) {
        const mentionsOther = otherTeamNames.some(n => n.length >= 3 && sentence.includes(n));
        const mentionsChosen = chosenTeamNames.some(n => n.length >= 3 && sentence.includes(n));
        const hasPositive = positiveWords.some(w => sentence.includes(w));
        const hasNegative = negativeWords.some(w => sentence.includes(w));

        if (mentionsOther && hasPositive) otherPositive++;
        if (mentionsOther && hasNegative) otherNegative++;
        if (mentionsChosen && hasPositive) chosenPositive++;
        if (mentionsChosen && hasNegative) chosenNegative++;
      }

      // If the other team has more positive mentions AND our chosen team has more negative mentions → confused
      if (otherPositive > chosenPositive && otherNegative < chosenNegative) {
        console.log(`[pre-game] BLOCKED: Claude picked ${chosenTeam} but reasoning favors ${otherSide.team} (other: +${otherPositive}/-${otherNegative}, chosen: +${chosenPositive}/-${chosenNegative}). Likely abbreviation confusion.`);
        logPregameRejection(market, 'post-sonnet-gate', 'abbreviation-confusion-soft', { team: chosenTeam, confidence: decision.confidence, reasoningPreview: (decision.reasoning ?? '').slice(0, 200), gateContext: { picked: chosenTeam, otherSide: otherSide.team, chosenPos: chosenPositive, chosenNeg: chosenNegative, otherPos: otherPositive, otherNeg: otherNegative } });
        continue;
      }

      // Also block if other team has 3+ more positive mentions than chosen (strong signal)
      if (otherPositive >= chosenPositive + 3) {
        console.log(`[pre-game] BLOCKED: Claude picked ${chosenTeam} but reasoning overwhelmingly favors ${otherSide.team} (+${otherPositive} vs +${chosenPositive}). Likely abbreviation confusion.`);
        logPregameRejection(market, 'post-sonnet-gate', 'abbreviation-confusion-hard', { team: chosenTeam, confidence: decision.confidence, reasoningPreview: (decision.reasoning ?? '').slice(0, 200), gateContext: { picked: chosenTeam, otherSide: otherSide.team, chosenPos: chosenPositive, otherPos: otherPositive } });
        continue;
      }

      // ALWAYS buy YES on the chosen team's ticker
      const pick = { ticker: matchedSide.ticker, side: 'yes' };
      const price = matchedSide.price;
      const bettingOnTeam = matchedSide.teamName;
      const expectedSport = batchItems[i].sport;
      const wrongSport = detectWrongSport(expectedSport, reasoning);
      if (wrongSport) {
        console.log(`[pre-game] BLOCKED: Claude confused sport for ${market.base}. Expected ${expectedSport}, reasoning mentions ${wrongSport}.`);
        logPregameRejection(market, 'post-sonnet-gate', 'sport-confusion', { team: chosenTeam, confidence: decision.confidence, sport: expectedSport, reasoningPreview: (decision.reasoning ?? '').slice(0, 200), gateContext: { expectedSport, mentionedSport: wrongSport } });
        continue;
      }

      // ── HALLUCINATION VALIDATION ───────────────────────────────────────────
      // Cross-sport contamination: reject if reasoning cites any starter name
      // that ESPN knows belongs to a DIFFERENT sport (e.g. Vladar/Flyers in
      // a Phillies MLB prompt). Also reject if reasoning names a "starter"
      // that doesn't match ESPN's confirmed starter for either team.
      {
        const fullText = ((decision.reasoning ?? '') + ' ' + (decision.exitScenario ?? '')).toLowerCase();
        const t1Starter = espnStarterMap.get(`${expectedSport}:${market.team1.team.toLowerCase()}`);
        const t2Starter = espnStarterMap.get(`${expectedSport}:${market.team2.team.toLowerCase()}`);
        const validLastNames = [t1Starter?.name, t2Starter?.name]
          .filter(Boolean).map(n => (n.split(' ').slice(-1)[0] ?? '').toLowerCase()).filter(l => l.length >= 4);

        // Block if a starter name from a different sport appears in reasoning.
        // Require FULL-NAME match ("First Last" as a phrase) — last-name alone
        // produced massive false positives on common English words (e.g. "Early"
        // in Connelly Early matched "takes early shots" in NBA reasoning).
        let crossSportHit = null;
        for (const [key, entry] of espnStarterMap.entries()) {
          if (!entry?.sport || entry.sport === expectedSport) continue;
          const full = (entry.name ?? '').trim();
          if (!full || full.split(/\s+/).length < 2) continue;
          const parts = full.toLowerCase().split(/\s+/);
          const last = parts[parts.length - 1];
          if (last.length < 4) continue;
          if (validLastNames.includes(last)) continue; // real collision on purpose — skip
          // Escape regex metachars; match full name as a phrase with flexible whitespace.
          const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const phrase = parts.map(esc).join('\\s+');
          if (new RegExp(`\\b${phrase}\\b`, 'i').test(fullText)) {
            crossSportHit = `${entry.name} (${entry.sport}) cited in ${expectedSport} analysis`;
            break;
          }
        }
        if (crossSportHit) {
          console.log(`[pre-game] BLOCKED: hallucination — ${crossSportHit} for ${market.base}`);
          logScreen({ stage: 'pre-game-sonnet', ticker: market.base, result: 'blocked-hallucination', reasoning: crossSportHit, claudeReasoning: decision.reasoning?.slice(0, 200) });
          logPregameRejection(market, 'post-sonnet-gate', 'cross-sport-hallucination', { team: chosenTeam, confidence: decision.confidence, sport: expectedSport, reasoningPreview: (decision.reasoning ?? '').slice(0, 200), gateContext: { hallucinated: crossSportHit } });
          continue;
        }

        // For MLB/NHL: if ESPN gave us a starter for the chosen team and Claude
        // names a "starter/pitcher/ace/goalie" that isn't that person, block.
        if ((expectedSport === 'MLB' || expectedSport === 'NHL')) {
          const chosenStarter = matchedSide === market.team1 ? t1Starter : t2Starter;
          if (chosenStarter?.name) {
            const expectedLast = chosenStarter.name.split(' ').slice(-1)[0].toLowerCase();
            // Extract capitalized "Firstname Lastname" patterns within 8 chars of starter/pitcher/goalie/ace keywords
            // First word must be a proper given name: capital + lowercase-only
            // letters (no apostrophes). Rejects possessive team prefixes like
            // "KC's Seth" (Seth Lugo) and "LAA's Reid" (Reid Detmers) that
            // previously blocked LEGITIMATE Claude picks. Last word is still
            // permissive for O'Brien, D'Angelo etc.
            // Require BOTH words to contain lowercase letters — filters out all-caps
            // acronyms (NO, ERA, WHIP, SV, GAA, OUT, DNP, IL, TBD) that were causing
            // false-positive blocks when Claude wrote "starter has Hard NO..." or
            // "Messick ERA of 4.2..." in proximity to role keywords.
            const roleRegex = /(starter|starting pitcher|pitcher|ace|goalie|netminder)[^.]{0,60}?\b([A-Z][a-z]{2,}\s+[A-Z][a-zA-Z'\-]*[a-z][a-zA-Z'\-]*)\b/g;
            const rawText = (decision.reasoning ?? '') + ' ' + (decision.exitScenario ?? '');
            const venueWords = new Set(['place','arena','stadium','park','field','garden','center','centre','dome','coliseum','bowl','ballpark','grounds']);
            // Stop-list of first-words that are sentence starters/qualifiers, not names.
            // Caught "Hard NO" false positive (4/21 MILDET) — "Hard" passed [A-Z][a-z]{2,}.
            const nonNameFirstWords = new Set(['Hard','Soft','Strong','Weak','Probable','Likely','Definite','Confirmed','Unconfirmed','Expected','Unknown','Unlisted','Reported','Rumored']);
            const other = matchedSide === market.team1 ? t2Starter : t1Starter;
            const otherLast = other?.name ? other.name.split(' ').slice(-1)[0].toLowerCase() : '';
            // Collect ALL hits — if ANY match expected/other starter, Claude is correct
            // even if other candidates are mentioned. Only flag when no valid hit exists.
            let matchedExpected = false;
            const badCandidates = [];
            let m;
            while ((m = roleRegex.exec(rawText)) !== null) {
              const citedRaw = m[2];
              const firstWord = citedRaw.split(/\s+/)[0];
              if (nonNameFirstWords.has(firstWord)) continue; // "Hard NO", "Likely Ace" etc.
              const cited = citedRaw.toLowerCase();
              const citedLast = cited.split(' ').slice(-1)[0];
              if (venueWords.has(citedLast)) continue;
              if (citedLast === expectedLast || citedLast === otherLast) { matchedExpected = true; continue; }
              badCandidates.push(citedRaw);
            }
            const bad = matchedExpected ? null : badCandidates[0];
            if (bad) {
              console.log(`[pre-game] BLOCKED: hallucinated starter "${bad}" — ESPN confirms ${chosenStarter.name} for ${matchedSide.team} in ${market.base}`);
              logScreen({ stage: 'pre-game-sonnet', ticker: market.base, result: 'blocked-hallucination', reasoning: `cited starter "${bad}" ≠ ESPN starter "${chosenStarter.name}"`, claudeReasoning: decision.reasoning?.slice(0, 200) });
              logPregameRejection(market, 'post-sonnet-gate', 'hallucinated-starter', { team: matchedSide.team, confidence: decision.confidence, reasoningPreview: (decision.reasoning ?? '').slice(0, 200), gateContext: { citedStarter: bad, espnStarter: chosenStarter.name } });
              continue;
            }
          }
        }
      }
      // ───────────────────────────────────────────────────────────────────────

      // Mark as analyzed regardless of trade/no-trade — don't re-analyze for 2 hours.
      // Also snapshot the price so the TTL-expired re-analysis gate can check for movement.
      preGameAnalysisCache.set(market.base, Date.now());
      preGameAnalyzedPrice.set(market.base, {
        team1Cents: Math.round((market.team1?.price ?? 0) * 100),
        team2Cents: Math.round((market.team2?.price ?? 0) * 100),
        at: Date.now(),
      });

      if (!decision.trade) {
        const reasonText = decision.reasoning ?? '';
        const isEspnMiss = ESPN_MISS_PATTERNS.test(reasonText);
        const startMs = pgGameStartTimes.get(market.base);
        const minsToStart = startMs ? (startMs - Date.now()) / 60000 : null;
        if (isEspnMiss && (minsToStart === null || minsToStart > 120)) {
          preGameEspnMissSet.add(market.base);
          console.log(`[pre-game] Sonnet rejected ${market.base} (ESPN-miss, will retry at T-2h): conf=${((decision.confidence??0)*100).toFixed(0)}% | ${reasonText.slice(0, 80)}`);
        } else {
          preGameEspnMissSet.delete(market.base);
          console.log(`[pre-game] Sonnet rejected ${market.base}: conf=${((decision.confidence??0)*100).toFixed(0)}% | ${reasonText.slice(0, 80)}`);
        }
        logScreen({ stage: 'pre-game-sonnet', ticker: market.base, result: 'rejected', confidence: decision.confidence, reasoning: decision.reasoning });
        // 2026-04-30: capture pregame Sonnet rejections in shadow for redesign analysis.
        // 697 claude-no records exist but ALL are tagged stage=live-edge — pregame had
        // zero visibility. Now pregame claude-no decisions land in shadow with full
        // context so we can see the rejection histogram (sport, conf, price, tags).
        try {
          logPregameRejection(market, isEspnMiss ? 'sonnet-espn-miss' : 'sonnet-claude-no', 'claude-no', {
            sport: market.sport ?? null,
            league: market.league ?? null,
            confidence: decision.confidence ?? null,
            price: decision.targetPrice ?? null,
            edge: decision.edge ?? null,
            reasoningPreview: (decision.reasoning ?? '').slice(0, 300),
            reasoningTags: decision.reasoningStructured?.reasoning_tags ?? null,
            reasoningStructured: decision.reasoningStructured ?? null,
            gateContext: {
              isEspnMiss,
              team1Price: market.team1?.price ?? null,
              team2Price: market.team2?.price ?? null,
              minsToStart: minsToStart != null ? Math.round(minsToStart) : null,
            },
          });
        } catch { /* best-effort */ }
        // Only set sticky reject cache if this wasn't an ESPN-miss retry candidate —
        // otherwise the 2h reject TTL would block the T-2h retry we just queued up.
        if (!preGameEspnMissSet.has(market.base)) {
          preGameRejectCache.set(market.base, Date.now());
          preGameRejectPrice.set(market.base, {
            team1Cents: Math.round((market.team1?.price ?? 0) * 100),
            team2Cents: Math.round((market.team2?.price ?? 0) * 100),
          });
        }
        continue;
      }
      // Trade accepted — clear any stale ESPN-miss flag.
      preGameEspnMissSet.delete(market.base);

    let confidence = decision.confidence ?? 0;
    const _pgPriceForGate = matchedSide.price;

    // KILLER BUCKET BLOCK (2026-04-23, data-driven — MLB-ONLY after per-sport audit):
    // MLB cross-tab: 15+pt edge × 65-69% conf = 17 trades, -$43 (real statistical power).
    // Non-MLB sports have 1-3 samples per cell — not enough to block. ELC-ATM LALIGA hit
    // +$40 on exactly this bucket (67% conf, 27pt edge) with 3 confirmed injuries.
    // Blocking non-MLB would kill legitimate soccer/NBA/NHL edges based on weak evidence.
    //
    // Per-sport auto-learning (P3.2 Wilson-CI auto-freeze) will handle non-MLB once we
    // have 15+ samples per bucket. Until then, trust Claude for non-MLB 15+pt edges.
    //
    // KILLER BUCKET BLOCK — extended to all sports 2026-04-24 with sport-specific carve-outs.
    // Pattern: 15+pt claimed edge × <70% confidence is the historical anti-edge bucket
    // (Claude stacks narrative without proportional conviction). MLB had 17 trades -$43.
    // MLS NE-CLB lost $18 in this exact pattern. Now blocked on all sports unless one of
    // the legitimate edge sources is cited:
    //   MLB: opponent starter ERA > 5.5 / "spot starter" / "emergency" / "debut"
    //   NHL: backup goalie OR confirmed star injury (e.g. "Hintz out", "MacKinnon scratched")
    //   NBA: opponent missing 2+ confirmed stars (not "doubtful" — confirmed OUT)
    //   Soccer: 2+ confirmed key player injuries cited specifically
    {
      const _claimedEdge = confidence - _pgPriceForGate;
      if (_claimedEdge >= 0.15 && confidence < 0.70) {
        const _fullR = ((decision.reasoning ?? '') + ' ' + (decision.exitScenario ?? '')).toLowerCase();
        // Sport-specific legitimate-edge carve-outs
        let _hasCarveOut = false;
        let _carveLabel = '';
        if (expectedSport === 'MLB') {
          _hasCarveOut = /\bera\s*[67-9]\.\d{1,2}\b/i.test(_fullR) ||
                         /\b(emergency|spot|debut|rookie|recalled|called up)\s*(starter|arm|pitcher)\b/i.test(_fullR);
          _carveLabel = 'MLB spot-starter ERA > 6.0';
        } else if (expectedSport === 'NHL') {
          // Backup goalie OR confirmed star injury (specific name + "out"/"scratched"/"injured reserve")
          _hasCarveOut = /\b(backup goalie|backup tendy|emergency goalie|third-string|recall(ed)?\s*goalie)\b/i.test(_fullR) ||
                         /\b[A-Z][a-z]+\s+(out|scratched|day-to-day|injured reserve|on ir|long[- ]term injured)\b/.test((decision.reasoning ?? '') + ' ' + (decision.exitScenario ?? ''));
          _carveLabel = 'NHL backup goalie or confirmed star injury';
        } else if (expectedSport === 'NBA') {
          // Two confirmed star players OUT (not doubtful) — phrase pattern "X out and Y out"
          const outNames = ((decision.reasoning ?? '') + ' ' + (decision.exitScenario ?? ''))
            .match(/\b[A-Z][a-zA-Z]+\s+(?:[A-Z][a-zA-Z]+\s+)?(?:is\s+)?(?:confirmed\s+)?out\b/g) ?? [];
          _hasCarveOut = outNames.length >= 2;
          _carveLabel = `NBA ${outNames.length}+ confirmed star injuries`;
        } else if (expectedSport === 'SOCCER' || ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes((expectedSport || '').toLowerCase())) {
          // Soccer: require 2+ confirmed key player injuries with names cited
          const injuryMentions = _fullR.match(/\b(out|injured|suspended|red card|acl|hamstring|torn|ligament)\b/g) ?? [];
          _hasCarveOut = injuryMentions.length >= 3; // 3+ injury-related terms = multiple confirmed absences
          _carveLabel = 'soccer multiple confirmed injuries';
        }
        if (!_hasCarveOut) {
          console.log(`[pre-game] 🚫 KILLER BUCKET BLOCKED (${expectedSport}): ${market.base} claims ${(_claimedEdge*100).toFixed(0)}pt edge at ${(confidence*100).toFixed(0)}% conf — proportionality mismatch (no ${expectedSport}-specific carve-out cited).`);
          logScreen({ stage: 'pre-game-sonnet', ticker: market.base, result: 'killer-bucket-block', reasoning: `${expectedSport}: Edge ${(_claimedEdge*100).toFixed(0)}pt + conf ${(confidence*100).toFixed(0)}% = -EV bucket, no carve-out detected`, claudeReasoning: (decision.reasoning ?? '').slice(0, 200) });
          logPregameRejection(market, 'post-sonnet-gate', 'killer-bucket', { team: matchedSide.team, confidence, sport: expectedSport, edge: Math.round(_claimedEdge * 100), reasoningPreview: (decision.reasoning ?? '').slice(0, 200), gateContext: { claimedEdgePt: Math.round(_claimedEdge * 100), conf: Math.round(confidence * 100) } });
          continue;
        } else {
          console.log(`[pre-game] ✅ KILLER BUCKET CARVE-OUT (${expectedSport}): ${market.base} — ${_carveLabel} detected, allowing through`);
        }
      }
    }

    // CONFIDENCE OUTLIER GATE: if Claude claims >0.75, require at least 2 numeric stats
    // cited in the reasoning. High confidence on vague reasoning = overfit on narrative.
    // Regex matches any stat pattern: ERA 3.2, SV% .921, 12.6 K/9, 1-5, 63%, etc.
    if (confidence > 0.75) {
      const fullReasoning = (decision.reasoning ?? '') + ' ' + (decision.exitScenario ?? '');
      const numericStatMatches = fullReasoning.match(/\b\d+\.?\d*\s*(?:%|ERA|WHIP|SV%|GAA|K\/9|R\/G|ppg|pts|win|loss|W-L|goals?|saves?|innings?)\b/gi) ?? [];
      const distinctNumbers = (fullReasoning.match(/\b\d+\.\d+\b|\b\d{2,}\b/g) ?? []).length;
      if (numericStatMatches.length < 2 && distinctNumbers < 3) {
        console.log(`[pre-game] ⚠️ CONFIDENCE SOFT-CAP: ${market.base} confidence ${(confidence*100).toFixed(0)}% → 73% — high confidence but only ${numericStatMatches.length} verifiable stat(s) cited. Reasoning: ${fullReasoning.slice(0, 100)}`);
        confidence = 0.73;
      }
    }

    // UNDERDOG CONFIDENCE CAP — prevents Claude from claiming an 18¢ team has 75% win probability.
    // DATA: POR at 18¢ was assigned 75% confidence (57pt claimed edge), SAS was a 62-win 2-seed
    // on a hot streak at home. Claude cited Wembanyama "doubtful" to justify a 75% win prob
    // for the 7-seed. That's delusional — doubtful ≠ out, and SAS has depth beyond one player.
    // The market isn't perfect but it's not off by 57 points.
    //
    // Sport-specific max edge above market for underdogs.
    // Extended 2026-04-23 after NE-CLB MLS loss at 36¢ entry (conf 68% = 32pt edge, -$18).
    // Soccer draw suppressor means a 36-40¢ team needs more skepticism than other sports.
    //   NBA: price < 35¢ → +15 pt (efficient market)
    //   NHL: price < 35¢ → +18 pt (goalie variance)
    //   MLB: price < 35¢ → +20 pt (most random sport)
    //   Soccer: price < 40¢ → +15 pt (draw tax widens the underdog zone)
    const pgSportKey = expectedSport.toLowerCase();
    const isSoccerSport = ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(pgSportKey);
    const underdogCapThreshold = isSoccerSport ? 0.40 : 0.35;
    if (price < underdogCapThreshold) {
      const maxEdgeMap = { nba: 0.15, nhl: 0.18, mlb: 0.20, epl: 0.15, laliga: 0.15, mls: 0.15, seriea: 0.15, bundesliga: 0.15, ligue1: 0.15 };
      const maxEdge = maxEdgeMap[pgSportKey] ?? 0.15;
      const maxUnderdogConf = price + maxEdge;
      if (confidence > maxUnderdogConf) {
        console.log(`[pre-game] ⚠️ UNDERDOG CAP: ${market.base} at ${(price*100).toFixed(0)}¢ — Claude said ${(confidence*100).toFixed(0)}% but max = ${(maxUnderdogConf*100).toFixed(0)}% (${pgSportKey.toUpperCase()} underdog cap: price + ${(maxEdge*100).toFixed(0)}pt)`);
        confidence = maxUnderdogConf;
      }
    }

    // HARD CAP: Pre-game confidence capped at early-event baseline + sport-specific bonus.
    // Baselines are now EARLY-EVENT probabilities (first-goal / early-lead / early-scoring),
    // not full-game win rates. These are higher than win rates because we only need a
    // price spike at any point during the game, not the final outcome.
    // MLB: early-scoring baseline ~45% (scores 2+ in first 3 innings)
    // NBA: early-lead baseline ~72% home (builds 8+ pt lead at some point in first half)
    // NHL: first-goal baseline ~56% home
    // Soccer: first-goal baseline ~55% home — draws are irrelevant, we exit on first goal

    // Soccer winner-bet block — draw-bet strategy handles all soccer leagues, no pre-game winner contracts.
    // Draw rates: MLS ~27%, Serie A ~28%, Bundesliga ~26%, Ligue 1 ~27%, EPL ~25%, La Liga ~22%.
    // At these draw rates, a "win" contract has a 22-28% chance of full loss on a draw outcome
    // on top of normal loss variance. Draw-bet strategy captures the actual edge in these markets.
    // EPL/La Liga allowed at 55¢+ since draw rates are slightly lower and Kalshi has liquid markets.
    if (['mls', 'seriea', 'bundesliga', 'ligue1'].includes(pgSportKey)) {
      console.log(`[pre-game] 🚫 SOCCER WINNER-BET BLOCKED: ${market.base} — ${pgSportKey.toUpperCase()} winner bets disabled (draw rate ~26-28% makes winner contracts -EV; draw-bet strategy handles soccer instead)`);
      logPregameRejection(market, 'post-sonnet-gate', 'soccer-winner-blocked', { league: pgSportKey, sport: 'Soccer', confidence: decision.confidence, gateContext: { league: pgSportKey } });
      continue;
    }

    const preGameBaselines = { mlb: 0.45, nba: 0.72, nhl: 0.56, mls: 0.55, epl: 0.55, laliga: 0.55, seriea: 0.55, bundesliga: 0.55, ligue1: 0.55 };
    const pgBaseline = preGameBaselines[pgSportKey] ?? 0.55;
    // Cap: how far above early-event baseline Claude can go.
    // MLB: +25% (45% + 25% = 70% max) — was 20% but created a dead zone where
    //   65% cap + 67% min-conf = impossible. Raised to let genuine conviction through.
    // NBA: +15% (72% + 15% = 87% max) — dominant mismatch e.g. opponent resting all starters
    // NHL: +20% (56% + 20% = 76% home, 44% + 20% = 64% away) — was +18 but created
    //   an impossible pass on NHL away underdogs: cap 62% < floor 63% killed 17pt edges.
    // Soccer: +15% (55% + 15% = 70% max) — opens soccer since we exit on first goal (draws irrelevant)
    const sportCapBonus = { mlb: 0.25, nba: 0.15, nhl: 0.20, mls: 0.15, epl: 0.15, laliga: 0.15, seriea: 0.15, bundesliga: 0.15, ligue1: 0.15 }[pgSportKey] ?? 0.15;
    // Detect home/away. Titles include "X at Y" (X=away) and "Game N: X at Y" (playoff, X=away).
    // "X vs Y" → team1=home. Baselines are HOME probabilities — invert for away bets.
    const titleLower = (market.title ?? '').toLowerCase();
    const isAwayBet = (titleLower.includes(' at ') && matchedSide === market.team1) ||
                      (titleLower.includes(' vs ') && matchedSide === market.team2);
    const pgTargetBaseline = isAwayBet ? (1 - pgBaseline) : pgBaseline;
    const pgMaxAllowed = Math.min(0.85, pgTargetBaseline + sportCapBonus);
    console.log(`[pre-game] side-detect: ${market.base} title="${market.title}" matched=${matchedSide} team1=${market.team1} team2=${market.team2} isAway=${isAwayBet} baseline=${(pgTargetBaseline*100).toFixed(0)}% cap=${(pgMaxAllowed*100).toFixed(0)}%`);
    if (confidence > pgMaxAllowed) {
      console.log(`[pre-game] Confidence capped: Claude said ${(confidence*100).toFixed(0)}% but pre-game baseline is ${(pgTargetBaseline*100).toFixed(0)}% → capped at ${(pgMaxAllowed*100).toFixed(0)}%`);
      confidence = pgMaxAllowed;
    }

    // MAX ENTRY PRICE CAP — don't pay more than 68¢ pre-game.
    // Sell-into-lead thesis only works if there's room for the price to move up.
    // At 70¢+ entry, the market has already priced in the edge; upside is only 30¢
    // vs. downside of 70¢ — asymmetry is wrong. Cap at 68¢ to preserve the trade structure.
    if (price > 0.68) {
      console.log(`[pre-game] Entry price too high: ${(price*100).toFixed(0)}¢ > 68¢ cap — market has priced out the edge`);
      logPregameRejection(market, 'post-sonnet-gate', 'price-too-high', { team: matchedSide.team, price, confidence, sport: pgSportKey, gateContext: { priceCap: 0.68 } });
      continue;
    }

    // 🛑 PROVEN-EDGE TAG GATE (2026-04-28): pre-game-prediction has lost across MLB/NBA/NHL/MLS
    // (74 trades, ~30% WR, -$74 cumulative) when reasoning was generic "team X is better."
    // Only fire if Sonnet's reasoning_tags include AT LEAST ONE proven-edge tag:
    //   playoff-home-fav, we-undervalued, market-lag, injury-news, public-fade
    // Tags like `era-gap` alone, `starter-mismatch`, `lineup-cold` are documented losers.
    // Without a proven tag, Sonnet is regurgitating sportsbook consensus = no edge.
    const _pgTags = Array.isArray(decision.reasoning_tags) ? decision.reasoning_tags : [];

    // 🛑 HARD-BANNED TAG CHECK (2026-04-29): Even if other proven tags also present,
    // reject if any hard-banned tag appears. Prevents "stack a winner with a loser
    // to sneak through" gaming. bullpen-mismatch / starter-mismatch / lineup-cold
    // are -EV at game-level, regardless of whatever else is co-cited.
    if (hasHardBannedPregameTag(_pgTags)) {
      console.log(`[pre-game] 🚫 HARD-BANNED TAG: ${market.base} — tags [${_pgTags.join(',')}] include a documented loser (bullpen-mismatch / starter-mismatch / lineup-cold)`);
      logScreen({ stage: 'pre-game-skip', result: 'skip-hard-banned-tag', ticker: market.base, sport: pgSportKey, reasoning: `Hard-banned tag present in [${_pgTags.join(',')}]` });
      logPregameRejection(market, 'post-sonnet-gate', 'hard-banned-tag', { team: matchedSide.team, price, confidence, sport: pgSportKey, reasoningTags: _pgTags, reasoningPreview: (decision.reasoning ?? '').slice(0, 200), gateContext: { tags: _pgTags } });
      continue;
    }

    // Disaster-tier MLB cell exempt — opponent ERA > 6.0 is its own proven edge
    // (4-1 historical, 80% WR). Allow era-gap or starter-mismatch tags here.
    // Compute opponent ERA inline since this gate runs BEFORE the MIN_CONF block.
    let _disasterTierExempt = false;
    if (pgSportKey === 'mlb') {
      try {
        const _oppAbbrLc = (otherSide?.team ?? '').toLowerCase();
        const _oppStarter = espnStarterMap.get(`MLB:${_oppAbbrLc}`);
        const _oppEraNum = parseFloat(_oppStarter?.era ?? 'NaN');
        if (Number.isFinite(_oppEraNum) && _oppEraNum > 6.0) _disasterTierExempt = true;
      } catch { /* best-effort */ }
    }

    // 🎯 SPORTSBOOK-GAP EXEMPTION (2026-04-29): When Kalshi's price for the chosen
    // team is 4+ pt below sportsbook no-vig consensus, that gap IS the proven edge
    // (sportsbooks are the sharp market). Allow any reasoning tag through, since
    // we don't need Sonnet to articulate the edge — the price gap proves it.
    // Threshold 4pt chosen below the 5pt structural-detector trigger so this catches
    // the "almost-mechanical" cases Sonnet flags but the structural detector skipped.
    let _sportsbookGapExempt = false;
    if (_pgSportsbook && matchedSide) {
      try {
        const t1IsAway = _pgIsT1Away;
        const matchedIsT1 = matchedSide === market.team1;
        const matchedIsAway = matchedIsT1 ? t1IsAway : !t1IsAway;
        const sbProb = matchedIsAway ? _pgSportsbook.awayProb : _pgSportsbook.homeProb;
        const kalshiProb = matchedSide.price ?? 0;
        const gapPt = (sbProb - kalshiProb) * 100;
        if (gapPt >= 4) {
          _sportsbookGapExempt = true;
          console.log(`[pre-game] ✓ SPORTSBOOK-GAP EXEMPT: ${market.base} ${matchedSide.team} — sportsbook ${(sbProb*100).toFixed(0)}% vs Kalshi ${Math.round(kalshiProb*100)}¢ = ${gapPt.toFixed(1)}pt gap (≥4pt threshold)`);
        }
      } catch { /* best-effort */ }
    }

    if (!hasProvenPregameEdgeTag(_pgTags) && !_disasterTierExempt && !_sportsbookGapExempt) {
      console.log(`[pre-game] 🚫 NO PROVEN EDGE TAG: ${market.base} — Sonnet's tags [${_pgTags.join(',') || '(none)'}] don't include any proven-winning category. Generic analysis = no edge over sportsbook.`);
      logScreen({ stage: 'pre-game-skip', result: 'skip-no-proven-tag', ticker: market.base, sport: pgSportKey, reasoning: `Reasoning tags ${_pgTags.join(',')} lack a proven-edge tag (need playoff-home-fav, we-undervalued, market-lag, injury-news, or public-fade)` });
      logPregameRejection(market, 'post-sonnet-gate', 'no-proven-edge-tag', { team: matchedSide.team, price, confidence, sport: pgSportKey, reasoningTags: _pgTags, reasoningPreview: (decision.reasoning ?? '').slice(0, 200), gateContext: { tags: _pgTags } });
      continue;
    }

    // 🛑 SOCCER PRE-GAME PERMANENTLY DISABLED (2026-04-28): MLS/EPL/LaLiga pre-game
    // is -$34.83 over 4 trades. Soccer underdog asymmetry + draw tax makes pre-game
    // structurally unfavorable. Re-enable only when we have a confirmed soccer edge
    // (e.g., lineup scraper) — generic Sonnet pre-game analysis loses money here.
    if (['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(pgSportKey)) {
      console.log(`[pre-game] 🛑 SOCCER PRE-GAME DISABLED: ${market.base} (${pgSportKey.toUpperCase()}) — strategy net -$34.83 historically. Need lineup-scraper edge to re-enable.`);
      logScreen({ stage: 'pre-game-skip', result: 'skip-soccer-disabled', ticker: market.base, sport: pgSportKey, reasoning: 'Soccer pre-game-prediction permanently disabled — losing strategy with no confirmed edge source' });
      logPregameRejection(market, 'post-sonnet-gate', 'soccer-pregame-disabled', { team: matchedSide.team, price, confidence, league: pgSportKey, sport: 'Soccer' });
      continue;
    }

    // SOCCER MINIMUM PRICE: 55¢. Below 55¢ the payoff asymmetry is structurally unfavorable.
    // At a 47¢ underdog entry, profit-lock at +20¢ = max gain of 43% on stake. A loss = -100%.
    // You need >70% win rate to be +EV — no one hits that on MLS/EPL underdogs.
    // Real data: MLS pre-game 2W-2L, -$34.83, with both losses being full wipeouts.
    // At 55¢+, the favorite framing reduces loss severity and the payoff ratio improves.
    if (['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(pgSportKey) && price < 0.55) {
      console.log(`[pre-game] 🚫 SOCCER FLOOR: ${market.base} — ${pgSportKey.toUpperCase()} at ${(price*100).toFixed(0)}¢ below 55¢ minimum (underdog payoff asymmetry unfavorable below 55¢)`);
      logPregameRejection(market, 'post-sonnet-gate', 'soccer-floor-below-55', { team: matchedSide.team, price, confidence, league: pgSportKey, sport: 'Soccer' });
      continue;
    }

    // ── SOCCER CALIBRATION GUARD ───────────────────────────────────────────
    // Soccer leagues aren't calibrated yet — WE tables, injury scraping, and
    // ESPN starter gates are all MLB/NBA/NHL-tuned. Until per-league n ≥ 10
    // completed trades, apply:
    //   (1) Confidence cap at price + 15pt (sanity bound on runaway conviction)
    //   (2) Quarter-size (applied at sizing below)
    //
    // Removed 2026-04-22: earlier 3-player hallucination block killed a live
    // ELC@ATM thesis that played out (40¢ → 60¢). Soccer tactical analysis
    // naturally cites 3+ players (injuries, key attackers). Guard was too crude
    // and reactive to a single misread on my part — quarter-sizing already
    // caps blast radius. Trust the engine; let P&L data arbitrate.
    // Softened 2026-04-22: conf cap was price + 8pt — too tight. At a 40¢
    // underdog that caps conf at 48%, below every floor. +15pt lets honest
    // edge trades through while still catching 80%-vs-40¢ runaways.
    const isSoccerPg = ['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(pgSportKey);
    let soccerCalibrated = false;
    if (isSoccerPg && existsSync(TRADES_LOG)) {
      const soccerLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      let n = 0;
      for (const l of soccerLines) {
        try {
          const tr = JSON.parse(l);
          if (tr.league !== pgSportKey) continue;
          if (tr.strategy !== 'pre-game-prediction' && tr.strategy !== 'pre-game-edge-first') continue;
          if (tr.realizedPnL == null) continue;
          n++;
        } catch {}
      }
      soccerCalibrated = n >= 10;
    }
    if (isSoccerPg && !soccerCalibrated) {
      const cappedConf = Math.min(confidence, price + 0.15);
      if (cappedConf < confidence) {
        console.log(`[pre-game] ⚠️ SOCCER CAP: ${market.base} conf ${(confidence*100).toFixed(0)}% → ${(cappedConf*100).toFixed(0)}% (uncalibrated league, max market+15pt)`);
        confidence = cappedConf;
      }
    }

    const pgReqMargin = getRequiredMargin(price, { sport: pgSportKey, live: false });
    // Price-tiered minimum confidence — the required certainty scales with entry price.
    // Buying a 70¢ favorite requires high confidence (market has priced it well, little margin for error).
    // Buying a 47¢ underdog only needs 63% — the market is already pricing in the uncertainty,
    // and a 14-point edge at that price has strong EV even without near-certainty.
    //
    // Tiers (NHL/NBA):
    //   Under 50¢:  63% — underdog entries, market already discounted, edge is EV-positive
    //   50–65¢:     65% — mid-range. Lowered from 70% so playoff road-underdog cap (~64%)
    //               doesn't collide with the floor and lock out every eligible trade.
    //   Above 65¢:  72% — expensive favorites, need strong conviction
    //
    // Tiers (MLB/Soccer):
    //   Under 50¢:  63% — matches NHL/NBA, opens highest-edge swing trades (18pt edge at 44¢)
    //   50–65¢:     65% — lowered from 67% to work with the 70% cap
    //   Above 65¢:  68% — expensive favorites need conviction but not an impossible bar
    const isSoccer = ['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(pgSportKey);
    const isNhlNba = pgSportKey === 'nhl' || pgSportKey === 'nba';
    // Disaster-tier ERA exemption already computed above (before proven-tag gate).
    // Log here when active so it appears in the right context.
    if (_disasterTierExempt) {
      const _oppStarter = espnStarterMap.get(`MLB:${(otherSide?.team ?? '').toLowerCase()}`);
      console.log(`[pre-game] 🎯 DISASTER-TIER EXEMPTION: ${market.base} — opponent ${_oppStarter?.name ?? '?'} ERA ${_oppStarter?.era ?? '?'} > 6.0 (historical 4-1, 80% WR). Lowering MIN_CONF floor.`);
    }
    const PRE_GAME_MIN_CONF = isNhlNba
      ? (price < 0.50 ? 0.63 : price <= 0.65 ? 0.65 : 0.72)
      : pgSportKey === 'mls'
        // 2026-05-02: MLS pre-game DISABLED. Historical: n=4 trades, 50% WR, -$34.83
        // P&L (avg -$8.71 per trade — worst single soccer category). MLS Sportsbook
        // efficiency + open play + high draw rate makes pre-game predictions a
        // money pit at our scale. Soccer reasoning enhancement (form/h2h/etc) is
        // a separate investigation; until then, no MLS pre-game.
        ? 0.99 // effectively disable — no realistic Sonnet call hits 99%
      : pgSportKey === 'mlb'
        // 2026-05-02 v3 OFFENSIVE: GOLDMINE-FIRST tiers. The 40-45¢ MLB pre-game
        // band is +$7.82 avg per trade (43% WR n=7) — our highest-EV strategy.
        // LOWER the floor here, RAISE everywhere else. Push volume to the goldmine.
        //   <45¢ (GOLDMINE):  55% (was 60) — capture more 13-16pt edge underdogs
        //   45-50¢ (BLEEDER): 67% — filter the 33% WR band
        //   50-65¢ (TOSS-UP): 70% — filter 7-9% WR catastrophe
        //   >65¢ (FAVORITE):  75% — high-price needs strong conviction
        // Disaster-tier exempt: -5pt discount on all tiers.
        ? (_disasterTierExempt
            ? (price < 0.45 ? 0.50 : price < 0.50 ? 0.62 : price <= 0.65 ? 0.65 : 0.70)
            : (price < 0.45 ? 0.55 : price < 0.50 ? 0.67 : price <= 0.65 ? 0.70 : 0.75))
        : isSoccer
          ? (price < 0.50 ? 0.63 : price <= 0.65 ? 0.65 : 0.68) // Soccer: unchanged
          : 0.65; // fallback for other sports
    // EDGE-FIRST TIER: a clear edge with moderate conviction is still a bet worth making,
    // just at reduced size. Pros don't need 65% conf to bet a 51¢ line with 12pt edge —
    // the math says +EV even after a 5pt calibration haircut. Sit-out days (like today)
    // have starved the bot of real P&L data, which in turn starves calibration feedback.
    // Placing half-size EV+ bets fixes both problems: captures edge, generates data.
    //
    // Qualifies if: conf ≥ 58% AND edge ≥ 10pt AND price ≤ 55¢ (underdog zone only —
    // favorites at this conf level are actually risky, cheap edges are where the math works).
    // CALIBRATION HAIRCUT — Claude's pre-game confidence has been systematically overconfident.
    // 2026-04-22 data: MLB pre-game edge-first went 0/5 on claimed 10-17pt edges the market
    // had already absorbed. Apply sport-specific haircut before gate/edge-first so floors and
    // Kelly sizing both reflect realistic probability. Live markets are not adjusted here
    // (their edges come from Kalshi book lag on WE, which is a different dynamic).
    const _calibrationHaircut = pgSportKey === 'mlb' ? 0.05
                              : pgSportKey === 'nba' ? 0.03
                              : pgSportKey === 'nhl' ? 0.02
                              : 0.02; // soccer/other
    if (_calibrationHaircut > 0 && confidence > _calibrationHaircut) {
      const _preHaircut = confidence;
      confidence = Math.max(0, confidence - _calibrationHaircut);
      console.log(`[pre-game] calibration haircut: ${(_preHaircut*100).toFixed(0)}% → ${(confidence*100).toFixed(0)}% (${pgSportKey} -${(_calibrationHaircut*100).toFixed(0)}pt)`);
    }
    const _edgeAbs = confidence - price;
    // EDGE-FIRST FLOORS — MLB tightened to 15pt after 2026-04-22 0/5 on 10-13pt edges.
    // MLB pre-game also requires a CITED EDGE SOURCE (injury scratch, weather, starter change,
    // bullpen game) because generic "ERA gap / home field" reasoning is already priced in.
    const _edgeFirstFloor = pgSportKey === 'mlb' ? 0.15 : 0.10;
    const _reasonForSource = ((decision.reasoning ?? '') + ' ' + (decision.exitScenario ?? '')).toLowerCase();
    const _hasEdgeSource = /\b(scratch|injury list|day[- ]to[- ]day|doubtful|questionable|ruled out|out (with|for|today|the game)|bullpen game|opener|weather|wind|rain|snow|rookie (debut|start)|recalled|suspended|late scratch|\bil\b|15[- ]?day|10[- ]?day|concussion|illness|flu|covid|personal leave|bereavement|paternity|load management)\b/i.test(_reasonForSource);
    const _edgeSourceRequired = pgSportKey === 'mlb';
    // MLB pre-game edge-first FROZEN 2026-04-23: went 1-5 (−$27.54) on 2026-04-22.
    // 2026-04-27 audit: extended to ALL sports. Total record across all sports: 2W/8L,
    // -$34.49. Non-MLB record: 0W/3L (NBA/NHL/MLS combined). Pre-game-edge-first as a
    // tier has not been profitable in any sport. Freeze entirely until rewritten.
    const PREGAME_EDGE_FIRST_FROZEN_ALL = true;
    const isEdgeFirst = confidence >= 0.58 &&
                        _edgeAbs >= _edgeFirstFloor &&
                        price <= 0.55 &&
                        confidence < PRE_GAME_MIN_CONF && // only triggers when standard gate would reject on conf
                        (!_edgeSourceRequired || _hasEdgeSource) &&
                        !PREGAME_EDGE_FIRST_FROZEN_ALL;
    if (PREGAME_EDGE_FIRST_FROZEN_ALL && confidence >= 0.58 && _edgeAbs >= _edgeFirstFloor && price <= 0.55 && confidence < PRE_GAME_MIN_CONF) {
      console.log(`[pre-game] 🧊 edge-first FROZEN (ALL sports): ${market.base} would qualify (conf=${(confidence*100).toFixed(0)}%, edge=${(_edgeAbs*100).toFixed(0)}pt, price=${(price*100).toFixed(0)}¢) — tier paused after 2W/8L total`);
    } else if (pgSportKey === 'mlb' && confidence >= 0.58 && _edgeAbs >= _edgeFirstFloor && price <= 0.55 && confidence < PRE_GAME_MIN_CONF && !_hasEdgeSource) {
      console.log(`[pre-game] ❌ MLB edge-first rejected for ${market.base}: no cited edge source (injury/weather/starter-change/bullpen-game) in reasoning`);
    }

    if ((confidence < PRE_GAME_MIN_CONF || _edgeAbs < pgReqMargin) && !isEdgeFirst) {
      console.log(`[pre-game] Margin check failed: conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ edge=${(_edgeAbs*100).toFixed(1)}% need=${(pgReqMargin*100).toFixed(0)}% min=${(PRE_GAME_MIN_CONF*100).toFixed(0)}% (${pgSportKey})`);
      preGameRejectCache.set(market.base, Date.now());
      preGameRejectPrice.set(market.base, {
        team1Cents: Math.round((market.team1?.price ?? 0) * 100),
        team2Cents: Math.round((market.team2?.price ?? 0) * 100),
      });
      logPregameRejection(market, 'post-sonnet-gate', 'margin-check-failed', { team: matchedSide.team, price, confidence, edge: Math.round(_edgeAbs * 100), sport: pgSportKey, reasoningTags: _pgTags, gateContext: { conf: Math.round(confidence * 100), edgePt: Math.round(_edgeAbs * 100), reqMarginPt: Math.round(pgReqMargin * 100), minConfPt: Math.round(PRE_GAME_MIN_CONF * 100) } });
      continue;
    }
    if (isEdgeFirst) {
      console.log(`[pre-game] 🎯 EDGE-FIRST: ${market.base} conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ edge=${(_edgeAbs*100).toFixed(1)}pt — below std floor (${(PRE_GAME_MIN_CONF*100).toFixed(0)}%) but EV+ at half-size`);
    }

    // Duplicate guard — one bet per game per day (survives restarts via JSONL)
    if (preGameBetGames.has(market.base)) {
      console.log(`[pre-game] Already bet ${market.base} today`);
      logPregameRejection(market, 'post-sonnet-gate', 'already-bet-today', { team: matchedSide.team, price, confidence, sport: pgSportKey });
      continue;
    }

    // 2026-04-27 audit: MLB pre-game-prediction at 45-49¢ entry has 33% WR over n=9,
    // -$54 net. Mid-priced underdog dead-zone — these are the trades where neither side
    // is a clear favorite and the market is correctly uncertain. Block this band entirely.
    // Sub-45¢ has 50% WR +$55 (extreme underdog with cited catalyst). 50¢+ is OK.
    if (pgSportKey === 'mlb' && price >= 0.45 && price < 0.50) {
      console.log(`[pre-game] BLOCKED ${market.base}: MLB pre-game 45-49¢ entry — historical 33% WR over 9 trades, -$54 net. Mid-priced underdog dead-zone.`);
      logPregameRejection(market, 'post-sonnet-gate', 'mlb-price-band-45-49', { team: matchedSide.team, price, confidence, sport: pgSportKey, gateContext: { band: '45-49' } });
      continue;
    }

    if (existsSync(PAPER_TRADES_LOG)) {
      const paperLines = readFileSync(PAPER_TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      // Fix: compare using ET date (tsToEtDate) not UTC date string — trades at 10pm ET have next-day UTC timestamps
      const hasPaperToday = paperLines.some(l => {
        try { const t = JSON.parse(l); return tsToEtDate(t.timestamp) === todayDateStr && t.marketBase === market.base; } catch { return false; }
      });
      if (hasPaperToday) {
        console.log(`[pre-game] Already logged trade for ${market.base} today (JSONL)`);
        logPregameRejection(market, 'post-sonnet-gate', 'already-paper-logged-today', { team: matchedSide.team, price, confidence, sport: pgSportKey });
        continue;
      }
    }

    // Cross-day matchup guard — don't re-enter the same two-team matchup if we lost it in the last 36h.
    // Real data: TEXATH-TEX Apr16 (win), TEXSEA-TEX Apr17 (diff opponent, allowed).
    // This blocks same-series re-entry e.g. KC@DET Mon (loss) → KC@DET Tue (blocked).
    // Only fires if BOTH team abbreviations appear in a losing pre-game trade from the last 36h.
    if (existsSync(TRADES_LOG)) {
      const t1 = market.team1.team.toUpperCase();
      const t2 = market.team2.team.toUpperCase();
      const cutoffMs = Date.now() - 36 * 60 * 60 * 1000;
      const recentLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      const hadMatchupLoss = recentLines.some(l => {
        try {
          const tr = JSON.parse(l);
          if (tr.strategy !== 'pre-game-prediction') return false;
          if (!tr.timestamp || Date.parse(tr.timestamp) < cutoffMs) return false;
          const tk = (tr.ticker ?? '').toUpperCase();
          if (!tk.includes(t1) || !tk.includes(t2)) return false; // different matchup
          // Confirmed loss: negative P&L or a stop/nuclear/claude-stop exit
          return (tr.realizedPnL != null && tr.realizedPnL < 0) ||
                 ['sold-stop-loss','sold-pre-game-nuclear','sold-pre-game-claude-stop','sold-claude-stop'].includes(tr.status);
        } catch { return false; }
      });
      if (hadMatchupLoss) {
        console.log(`[pre-game] 🚫 CROSS-DAY BLOCK: ${market.base} — lost ${t1} vs ${t2} matchup in last 36h`);
        logPregameRejection(market, 'post-sonnet-gate', 'cross-day-matchup-loss', { team: matchedSide.team, price, confidence, sport: pgSportKey, gateContext: { t1, t2 } });
        continue;
      }
    }

    const edge = confidence - price;
    // PRE-GAME SIZING CAP — tiered by bankroll, with underdog boost.
    // DATA: <45¢ entries (underdogs) hit 75% win rate — strongest signal in the dataset.
    // Underdogs also have higher payout per contract (55¢+ vs 43-50¢ for coin flips).
    // Boost underdog sizing by 50% to capitalize on the edge.
    const bkr = getBankroll();
    const isGoldmine = price >= 0.40 && price < 0.45 && pgSportKey === 'mlb'; // PROVEN +EV cell
    const isUnderdog = price < 0.45;
    // 2026-05-02 OFFENSIVE: goldmine band gets bigger sizing (12% vs 8%) to push
    // volume on +$7.82 avg/trade cell. Asymmetric pay structure means even at
    // 43% WR we're net winning. Stack volume on the proven cell.
    const pgFraction = bkr < 500
      ? (isGoldmine ? 0.12 : isUnderdog ? 0.08 : 0.06)
      : PRE_GAME_TRADE_FRACTION;
    const pgAbsCap = bkr < 500 ? (isGoldmine ? 40 : isUnderdog ? 30 : 20) : bkr < 1000 ? 50 : Infinity;
    const pgMaxTrade = Math.min(bkr * pgFraction, pgAbsCap, getAvailableCash('kalshi'));
    // Edge-first tier: half-size — entry is EV+ but below standard conf floor, so size down.
    // Soccer pre-calibration: quarter-size until league has n≥10 settled pg trades.
    const soccerSizeMult = (isSoccerPg && !soccerCalibrated) ? 0.25 : 1.0;
    let betAmount = Math.min(getPositionSize('kalshi', edge, 0, pgSportKey, price), pgMaxTrade) * (isEdgeFirst ? 0.5 : 1.0) * soccerSizeMult;

    // 2026-04-30 GRANULAR BUCKET THROTTLE for pre-game.
    // Documented bleeder: "MLB | pre-game-prediction | 15-19pt | 65-69%": -$9.18/trade.
    // Coarse throttle missed it. This catches it.
    {
      const _pgStrategy = isEdgeFirst ? 'pre-game-edge-first' : 'pre-game-prediction';
      const _granMult = getGranularBucketThrottle(pgSportKey, _pgStrategy, edge, confidence);
      if (_granMult < 1) {
        const _before = betAmount;
        betAmount = betAmount * _granMult;
        if (_granMult === 0) {
          console.log(`[pre-game] 🚫 GRANULAR FREEZE: ${market.base} ${matchedSide.team} — bucket auto-frozen, blocking pre-game trade`);
          logPregameRejection(market, 'post-sonnet-gate', 'granular-bucket-freeze', { team: matchedSide.team, price, confidence, edge: Math.round(edge * 100), sport: pgSportKey, gateContext: { strategy: _pgStrategy } });
          continue;
        }
        console.log(`[pre-game] 🎯 GRANULAR THROTTLE ${(_granMult*100).toFixed(0)}%: $${_before.toFixed(2)} → $${betAmount.toFixed(2)}`);
      }
    }

    const betQty = betAmount >= 1 ? Math.max(1, Math.floor(betAmount / price)) : 0;
    if (betAmount < 1) continue;

    preGameTradesToday++;
    preGameTradesThisCycle++;
    // NOTE: preGameBetGames.add() is called ONLY after a trade is actually placed (real or paper).
    // Moving it here (before gate checks) caused overnight-analyzed markets to be permanently locked
    // for the day, preventing daytime re-analysis with fresh ESPN starter data.

    // ESPN GATE — only place real money when ESPN has confirmed at least one starter.
    // The pre-game scan runs overnight (2-5 AM ET) when ESPN's scoreboard doesn't yet
    // have today's games loaded. Without ESPN starters, Claude web-searches at midnight
    // and "confirms" starters from stale articles — leading to bets on wrong pitchers.
    // If ESPN has neither team's starter, defer to paper only until starters are known.
    if (PREGAME_LIVE) {
      // ── OVERNIGHT GATE: no real bets before 10 AM ET ──────────────────────
      // Overnight scans run 2-5 AM ET when stale articles "confirm" wrong starters.
      // Games 12-18 hrs away give no edge and lock capital for half a day.
      if (etNow.getHours() < 10) {
        console.log(`[pre-game] 🌙 OVERNIGHT GATE: ${market.base} — no real bets before 10 AM ET (currently ${etNow.getHours()}:${String(etNow.getMinutes()).padStart(2,'0')} ET)`);
        // Fall through to paper logging below
      } else {
      // ── 4-HOUR WINDOW: only bet when game starts within PREGAME_HOURS_WINDOW ──
      // Parse HHMM from ticker (e.g. KXMLBGAME-26APR172010STLHOU → 2010 = 8:10 PM ET).
      // Capital locked up for 8-15 hours overnight earns nothing and risks wrong-starter bets.
      const pgDateStr = tonightStr ?? todayStr; // whichever date matched this market
      const pgDateIdx = market.base.indexOf(pgDateStr);
      const pgTimeStr = pgDateIdx >= 0 ? market.base.slice(pgDateIdx + pgDateStr.length, pgDateIdx + pgDateStr.length + 4) : '';
      let withinWindow = true;
      if (/^\d{4}$/.test(pgTimeStr)) {
        // MLB tickers embed HHMM in ET (e.g. 1605 = 4:05 PM ET)
        const pgGameH = parseInt(pgTimeStr.slice(0, 2));
        const pgGameM = parseInt(pgTimeStr.slice(2, 4));
        const pgNowMins = etNow.getHours() * 60 + etNow.getMinutes();
        const pgGameMins = pgGameH * 60 + pgGameM;
        // minsUntil handles midnight crossover
        const pgMinsUntil = (pgGameMins + 24 * 60 - pgNowMins) % (24 * 60);
        withinWindow = pgMinsUntil <= PREGAME_HOURS_WINDOW * 60;
        if (!withinWindow) {
          const pgHrsUntil = (pgMinsUntil / 60).toFixed(1);
          console.log(`[pre-game] ⏰ TIME GATE: ${market.base} starts in ${pgHrsUntil}h (>${PREGAME_HOURS_WINDOW}h window) — deferring to paper`);
        }
      } else {
        // MLS/NBA/NHL tickers don't embed HHMM — use ESPN start times as fallback.
        // Without this, the time gate is completely bypassed for non-MLB sports.
        const t1Abbr = market.team1.team.toUpperCase();
        const t2Abbr = market.team2.team.toUpperCase();
        const espnStart = espnStartTimeMap.get(`${t1Abbr}-${t2Abbr}`) ?? espnStartTimeMap.get(`${t2Abbr}-${t1Abbr}`);
        if (espnStart) {
          const pgMinsUntil = Math.max(0, (espnStart.getTime() - Date.now()) / 60000);
          withinWindow = pgMinsUntil <= PREGAME_HOURS_WINDOW * 60;
          if (!withinWindow) {
            const pgHrsUntil = (pgMinsUntil / 60).toFixed(1);
            console.log(`[pre-game] ⏰ TIME GATE (ESPN): ${market.base} starts in ${pgHrsUntil}h (>${PREGAME_HOURS_WINDOW}h window) — deferring to paper`);
          }
        } else {
          console.log(`[pre-game] ⚠️ No start time for ${market.base} (no HHMM in ticker, no ESPN match) — allowing bet`);
        }
      }
      if (!withinWindow) {
        // Fall through to paper logging below
      } else {
      const espnT1 = espnStarterMap.get(market.team1.team.toLowerCase());
      const espnT2 = espnStarterMap.get(market.team2.team.toLowerCase());
      const isMlbOrHockey = pgSportKey === 'mlb' || pgSportKey === 'nhl';
      // ESPN gate: normally blocks real bets when neither team's starter has loaded.
      // Exception: edge-first tier — starter info is publicly known pre-game even if
      // ESPN's feed is lagging, and edge-first is already half-size with a large edge.
      // Skipping these trades was the #1 cause of zero-bet days.
      const minsToFirstPitch = (typeof pgMinsUntil !== 'undefined') ? pgMinsUntil : 999;
      const espnBypassForEdgeFirst = isEdgeFirst;
      if (espnBypassForEdgeFirst && isMlbOrHockey && !espnT1 && !espnT2) {
        console.log(`[pre-game] 🎯 EDGE-FIRST BYPASS: ESPN gate waived for ${market.base} — ${minsToFirstPitch}min to first pitch, half-size trade`);
      }
      if (isMlbOrHockey && !espnT1 && !espnT2 && !espnBypassForEdgeFirst) {
        console.log(`[pre-game] ⏳ ESPN GATE: no starters confirmed for ${market.base} yet — deferring to paper-only until ESPN loads`);
        // Fall through to paper logging below (don't place real bet)
      } else {

      // MLB ERA GAP GATE — require ≥2.5 ERA difference between confirmed starters.
      // Data: MLB pre-game 4W-10L, -$60 net. The ERA mismatch signal is real (STL vs
      // Burrows 6.55, TEX vs Crochet 7.58 worked) but marginal matchups (4.2 vs 3.8 ERA)
      // add noise without edge. 2.5 gap filters those out. Only skips if BOTH ERAs are
      // confirmed — if one is missing, let Claude decide.
      if (pgSportKey === 'mlb') {
        const t1ERA = parseFloat(espnT1?.era ?? 'NaN');
        const t2ERA = parseFloat(espnT2?.era ?? 'NaN');
        if (!isNaN(t1ERA) && !isNaN(t2ERA)) {
          const eraGap = Math.abs(t1ERA - t2ERA);
          const eraGapThreshold = getBankroll() < 500 ? 3.0 : 2.5;
          if (eraGap < eraGapThreshold) {
            console.log(`[pre-game] 🚫 MLB ERA GAP: ${market.base} — gap ${eraGap.toFixed(2)} (${espnT1?.name ?? '?'} ${t1ERA} ERA vs ${espnT2?.name ?? '?'} ${t2ERA} ERA) below ${eraGapThreshold} threshold (bankroll ${getBankroll() < 500 ? '<$500 → 3.0' : '≥$500 → 2.5'}) — skipping`);
            logPregameRejection(market, 'post-sonnet-gate', 'mlb-era-gap-too-small', { team: matchedSide.team, price, confidence, sport: 'MLB', league: 'mlb', gateContext: { eraGap: +eraGap.toFixed(2), threshold: eraGapThreshold, t1Name: espnT1?.name, t1ERA, t2Name: espnT2?.name, t2ERA } });
            continue; // skip to next market — no paper log needed for hard filter
          }
          console.log(`[pre-game] ✅ MLB ERA GAP: ${market.base} — gap ${eraGap.toFixed(2)} clears 2.5 threshold (${espnT1?.name ?? '?'} ${t1ERA} vs ${espnT2?.name ?? '?'} ${t2ERA})`);
          // ERA DIRECTION CHECK — verify Claude backed the lower-ERA (better) pitcher.
          // The gap gate ensures there IS a real quality difference; this ensures we're
          // on the right side of it. Allow up to 1.0 ERA slack for park/defense factors.
          // t1 = team1 (away), t2 = team2 (home) — matches market.team1 / market.team2.
          const pickedIsTeam1 = matchedSide === market.team1;
          const pickedStarterERA = pickedIsTeam1 ? t1ERA : t2ERA;
          const oppStarterERA = pickedIsTeam1 ? t2ERA : t1ERA;
          const pickedStarterName = pickedIsTeam1 ? (espnT1?.name ?? '?') : (espnT2?.name ?? '?');
          const dirSlack = getBankroll() < 500 ? 0.5 : 1.0;
          if (pickedStarterERA > oppStarterERA + dirSlack) {
            console.log(`[pre-game] 🚫 ERA DIRECTION: ${market.base} — Claude backed ${chosenTeam} (${pickedStarterName} ERA ${pickedStarterERA.toFixed(2)}) but opponent ERA is lower at ${oppStarterERA.toFixed(2)} — wrong side of the ERA gap (slack=${dirSlack}), skipping`);
            logPregameRejection(market, 'post-sonnet-gate', 'mlb-era-direction-wrong', { team: matchedSide.team, price, confidence, sport: 'MLB', league: 'mlb', gateContext: { pickedStarterName, pickedERA: +pickedStarterERA.toFixed(2), oppERA: +oppStarterERA.toFixed(2), dirSlack } });
            continue;
          }

          // ELITE ACE CODE GATE — if the opponent starter is elite (ERA < 2.5 AND WHIP < 1.0),
          // hard-block regardless of what Claude's prompt reasoning says. This turns the
          // "Hard NO" from a prompt suggestion into an enforced rule — Claude's March 2026
          // TEX@SEA error (misreading Woo WHIP 0.92 as "barely clears" the < 1.0 threshold)
          // showed prompt-only guards can be silently overridden by bad reasoning.
          const oppWhip = parseFloat((pickedIsTeam1 ? espnT2 : espnT1)?.whip ?? 'NaN');
          const oppStarterName = pickedIsTeam1 ? (espnT2?.name ?? '?') : (espnT1?.name ?? '?');
          if (!isNaN(oppStarterERA) && !isNaN(oppWhip) && oppStarterERA < 2.5 && oppWhip < 1.0) {
            console.log(`[pre-game] 🚫 ELITE ACE BLOCK: ${market.base} — opponent ${oppStarterName} ERA ${oppStarterERA.toFixed(2)} WHIP ${oppWhip.toFixed(2)} qualifies as elite ace — lineup won't score, price won't rise, skipping`);
            logPregameRejection(market, 'post-sonnet-gate', 'mlb-elite-ace-block', { team: matchedSide.team, price, confidence, sport: 'MLB', league: 'mlb', gateContext: { oppStarterName, oppERA: +oppStarterERA.toFixed(2), oppWHIP: +oppWhip.toFixed(2) } });
            continue;
          }
        }
      }

      // ── MLB STARTER CROSS-VALIDATION ──────────────────────────────────────
      // ESPN provides probable starters, but they can be wrong (late scratches,
      // bullpen games announced after ESPN updates). Before risking real money,
      // do a targeted web search to confirm the starters match what ESPN says.
      // ── STARTER CROSS-VALIDATION ─────────────────────────────────────────────
      // Three-source approach to avoid false positives from stale web search results:
      //   1. ESPN probables (already fetched above — real-time scoreboard)
      //   2. MLB.com official schedule API (authoritative probable pitcher feed)
      //   3. Claude web search (tiebreaker ONLY if sources 1 & 2 disagree)
      //
      // A conflict is only declared if the web search ALSO disagrees with ESPN.
      // ESPN + MLB.com agreeing = confirmed. One source lagging = not a real conflict.
      let starterConflict = false;
      if (pgSportKey === 'mlb' && (espnT1 || espnT2)) {
        const homeAbbr = market.team2.team.toUpperCase();
        const awayAbbr = market.team1.team.toUpperCase();
        const espnHomeName = espnT2?.name ?? 'unknown';
        const espnAwayName = espnT1?.name ?? 'unknown';
        console.log(`[pre-game] 🔍 STARTER XVAL: verifying ${awayAbbr} (${espnAwayName}) @ ${homeAbbr} (${espnHomeName})`);

        // Helper: compare pitcher names via last name (handles "C. Sanchez" vs "Cristopher Sanchez")
        const lastName = (n) => (n ?? '').trim().split(/\s+/).pop()?.toLowerCase() ?? '';
        const namesMatch = (a, b) => {
          if (!a || !b || a === 'unknown' || b === 'unknown') return null; // can't compare
          if (a.toLowerCase() === b.toLowerCase()) return true;
          return lastName(a) === lastName(b);
        };

        // Step 1: MLB.com official probable pitcher API
        let mlbHomeActual = null;
        let mlbAwayActual = null;
        try {
          const mlbDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
          const mlbRes = await fetch(
            `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${mlbDateStr}&hydrate=probablePitcher`,
            { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) }
          );
          if (mlbRes.ok) {
            const mlbData = await mlbRes.json();
            for (const dateEntry of mlbData.dates ?? []) {
              for (const game of dateEntry.games ?? []) {
                const mlbHome = (game.teams?.home?.team?.abbreviation ?? '').toUpperCase();
                const mlbAway = (game.teams?.away?.team?.abbreviation ?? '').toUpperCase();
                // Match on at least one team abbreviation (MLB uses different abbr than ESPN sometimes)
                const homeMatch = mlbHome === homeAbbr || mlbHome.slice(0, 3) === homeAbbr.slice(0, 3);
                const awayMatch = mlbAway === awayAbbr || mlbAway.slice(0, 3) === awayAbbr.slice(0, 3);
                if (homeMatch && awayMatch) {
                  mlbHomeActual = game.teams?.home?.probablePitcher?.fullName ?? null;
                  mlbAwayActual = game.teams?.away?.probablePitcher?.fullName ?? null;
                  console.log(`[pre-game] 📋 MLB.com: home=${mlbHomeActual ?? 'TBD'} away=${mlbAwayActual ?? 'TBD'}`);
                  break;
                }
              }
            }
          }
        } catch (mlbErr) {
          console.log(`[pre-game] ⚠️ MLB.com fetch failed: ${mlbErr.message} — using ESPN only`);
        }

        // Step 2: Compare ESPN and MLB.com
        const homeAgree = namesMatch(espnHomeName, mlbHomeActual);
        const awayAgree = namesMatch(espnAwayName, mlbAwayActual);
        const sourcesAgree = (homeAgree !== false) && (awayAgree !== false); // null = unknown, false = mismatch

        if (sourcesAgree && (mlbHomeActual || mlbAwayActual)) {
          // ESPN and MLB.com agree (or MLB.com has no data yet) — confirmed, skip web search
          console.log(`[pre-game] ✅ STARTER CONFIRMED (ESPN+MLB.com): ${espnAwayName} @ ${espnHomeName}`);
        } else {
          // Sources disagree or MLB.com is missing — run Claude web search as tiebreaker
          const mlbConflictNote = mlbHomeActual || mlbAwayActual
            ? `MLB.com shows home=${mlbHomeActual ?? 'TBD'} away=${mlbAwayActual ?? 'TBD'}`
            : 'MLB.com returned no probable pitcher data yet';
          console.log(`[pre-game] ⚠️ ESPN vs MLB.com mismatch — running web search tiebreaker. ${mlbConflictNote}`);

          // Get game start time for tighter search
          const gameStartDate = espnStartTimeMap.get(`${awayAbbr}-${homeAbbr}`) ?? espnStartTimeMap.get(`${homeAbbr}-${awayAbbr}`);
          const gameTimeET = gameStartDate
            ? gameStartDate.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
            : 'tonight';

          try {
            const xvalPrompt = `Today is ${todayDate}. I need to determine the ACTUAL starting pitchers for the MLB game: ${awayAbbr} at ${homeAbbr}, starting ${gameTimeET} ET.

SOURCE COMPARISON:
- ESPN probables: ${awayAbbr}=${espnAwayName}, ${homeAbbr}=${espnHomeName}
- MLB.com probables: ${awayAbbr}=${mlbAwayActual ?? 'not listed'}, ${homeAbbr}=${mlbHomeActual ?? 'not listed'}

These sources show different pitchers (or MLB.com has no data). Search for the CURRENT confirmed starting pitcher for this specific game tonight.

Search: "${awayAbbr} ${homeAbbr} starting pitcher ${todayDate}" AND "${homeAbbr} starting pitcher tonight"

For EACH team, determine: what is the confirmed pitcher throwing the FIRST PITCH tonight?

IMPORTANT: Only set conflict=true if you find CLEAR evidence that the actual starter is DIFFERENT from ESPN's listing. Name abbreviations (e.g. "C. Sanchez" vs "Cristopher Sanchez") are NOT conflicts — they are the same person. A conflict is only when a completely different player is confirmed, or a bullpen/opener game is announced instead.

Respond in EXACTLY this JSON:
{
  "homeConfirmed": true/false,
  "awayConfirmed": true/false,
  "homeActual": "full pitcher name",
  "awayActual": "full pitcher name",
  "conflict": true/false,
  "conflictTeam": "HOME"/"AWAY"/"BOTH"/null,
  "note": "one sentence explanation"
}`;
            const xvalResult = await claudeWithSearch(xvalPrompt, { maxTokens: 512, maxSearches: 2, timeout: 30000, category: 'xval' });
            if (xvalResult) {
              const xvalJson = xvalResult.match(/\{[\s\S]*\}/)?.[0];
              if (xvalJson) {
                try {
                  const xval = JSON.parse(xvalJson);
                  // Only flag as conflict if web search actively confirms a DIFFERENT starter
                  // (not just uncertainty — uncertainty defaults to trusting ESPN)
                  if (xval.conflict) {
                    // Final sanity check: if web search's "actual" matches ESPN by last name,
                    // it's a false positive (abbreviation vs full name confusion)
                    const webHomeMatch = namesMatch(espnHomeName, xval.homeActual);
                    const webAwayMatch = namesMatch(espnAwayName, xval.awayActual);
                    if (webHomeMatch === false || webAwayMatch === false) {
                      starterConflict = true;
                      console.log(`[pre-game] ⚠️ STARTER CONFLICT for ${market.base}: ESPN says ${espnAwayName}/${espnHomeName}, confirmed actual: ${xval.awayActual ?? '?'}/${xval.homeActual ?? '?'} — ${xval.note}`);
                      await tg(
                        `⚠️ <b>STARTER CONFLICT — ${market.base}</b>\n` +
                        `ESPN: ${espnAwayName} @ ${espnHomeName}\n` +
                        `MLB.com: ${mlbAwayActual ?? 'TBD'} @ ${mlbHomeActual ?? 'TBD'}\n` +
                        `Web search: ${xval.awayActual ?? '?'} @ ${xval.homeActual ?? '?'}\n` +
                        `${xval.note}\n` +
                        `<i>Deferring pre-game to paper — live bets still allowed once game starts</i>`
                      );
                    } else {
                      console.log(`[pre-game] ✅ STARTER CONFIRMED (web tiebreaker): names match ESPN by last name — ${xval.note}`);
                    }
                  } else {
                    console.log(`[pre-game] ✅ STARTER CONFIRMED (web tiebreaker): ${espnAwayName} @ ${espnHomeName} — ${xval.note ?? 'matches search results'}`);
                  }
                } catch (parseErr) {
                  console.log(`[pre-game] ⚠️ STARTER XVAL parse error: ${parseErr.message} — proceeding with ESPN data`);
                }
              }
            }
          } catch (xvalErr) {
            console.log(`[pre-game] ⚠️ STARTER XVAL failed: ${xvalErr.message} — proceeding with ESPN data`);
          }
        }
      }

      if (starterConflict) {
        // Log a conflict-deferred paper trade for record-keeping and calibration.
        // Tagged with starterConflict: true so the live-edge skips its both-sides guard
        // — the game is live now with a confirmed starter, live-edge should evaluate freely.
        logPaperTrade({
          sport: pgSportKey, marketBase: market.base, ticker: matchedSide.ticker,
          teamAbbr: matchedSide.team, teamName: bettingOnTeam,
          opponentAbbr: otherSide.team, opponentName: otherSide.teamName,
          marketTitle: market.title, confidence, price,
          edge: Math.round(edge * 1000) / 10, wouldBetAmount: Math.round(betAmount * 100) / 100,
          wouldQty: betQty, reasoning: decision.reasoning,
          starterConflict: true,
          status: 'conflict-deferred',
        });
      } else {
      // ── LIVE MODE: place a real Kalshi order ──────────────────────────────
      const pgPriceInCents = Math.round(price * 100);
      console.log(`[pre-game] 🎯 LIVE BET: ${market.base} → ${matchedSide.team} @${pgPriceInCents}¢ conf=${Math.round(confidence*100)}% bet=$${betAmount.toFixed(2)} qty=${betQty}`);
      try {
        const pgResult = await kalshiPost('/portfolio/orders', {
          ticker: matchedSide.ticker,
          action: 'buy',
          side: 'yes',
          count: betQty,
          yes_price: pgPriceInCents,
        });
        if (pgResult.ok) {
          const pgFill = getActualFill(pgResult, betQty);
          if (pgFill > 0) {
            const pgDeployed = pgFill * price;
            logTrade({
              exchange: 'kalshi',
              strategy: isEdgeFirst ? 'pre-game-edge-first' : 'pre-game-prediction',
              ticker: matchedSide.ticker,
              title: market.title,
              side: 'yes',
              quantity: pgFill,
              entryPrice: price,
              deployCost: pgDeployed,
              filled: pgFill,
              orderId: (pgResult.data?.order ?? pgResult.data)?.order_id ?? null,
              edge: Math.round(edge * 1000) / 10,
              confidence,
              reasoning: decision.reasoning,
              exitScenario: decision.exitScenario ?? null,
              reasoningTags: Array.isArray(decision.reasoning_tags)
                ? decision.reasoning_tags.filter(x => typeof x === 'string').map(x => x.toLowerCase().replace(/_/g, '-').trim()).slice(0, 3)
                : null,
              pgBaseline: pgTargetBaseline,
              sport: pgSportKey,
              rlmContext: getLiveMoveContext(matchedSide.ticker, 'yes', price),
            });
            // Mirror to paper-trades.jsonl so conflict detector and pg-guard find it
            logPaperTrade({
              sport: pgSportKey, marketBase: market.base, ticker: matchedSide.ticker,
              teamAbbr: matchedSide.team, teamName: bettingOnTeam,
              opponentAbbr: otherSide.team, opponentName: otherSide.teamName,
              marketTitle: market.title, confidence, price,
              edge: Math.round(edge * 1000) / 10, wouldBetAmount: pgDeployed,
              wouldQty: pgFill, reasoning: decision.reasoning, exitScenario: decision.exitScenario ?? null,
              pgBaseline: pgTargetBaseline,
            });
            await tgTradeEntry({
              kind: `PRE-GAME — ${pgSportKey.toUpperCase()}`,
              title: market.title,
              gameLine: `Strategy: buy early, sell on +12¢ spike`,
              team: matchedSide.team,
              price: pgPriceInCents / 100,
              qty: pgFill,
              deployed: pgDeployed,
              conf: confidence,
              edge: edge * 100,
              reason: decision.exitScenario || decision.reasoning,
              strategyTag: 'pre-game-prediction',
            });
            console.log(`[pre-game] ✅ Filled ${pgFill}/${betQty} @ ${pgPriceInCents}¢ deployed=$${pgDeployed.toFixed(2)}`);
            // Lock this game now that we've actually placed a real bet.
            preGameBetGames.add(market.base);
            // Deduct from cached balance so subsequent orders in this batch
            // know how much cash remains (prevents insufficient_balance 400s)
            kalshiBalance = Math.max(0, kalshiBalance - pgDeployed);
          }
        } else {
          console.log(`[pre-game] LIVE order failed for ${market.base}: status=${pgResult.status} ${JSON.stringify(pgResult.data).slice(0, 200)}`);
        }
      } catch (err) {
        console.log(`[pre-game] LIVE order error for ${market.base}: ${err.message}`);
      }
      logScreen({ stage: 'pre-game-live', ticker: market.base, result: 'LIVE', confidence, price, reasoning: decision.reasoning });
      } // end starterConflict else
      } // end ESPN gate else
      } // end time window else
      } // end daily cap else
    } else {
      // ── PAPER MODE: log only, no real order ──────────────────────────────
      if (preGameTradesToday > MAX_PREGAME_PER_CYCLE * 10) { console.log(`[pre-game] Paper daily limit reached`); continue; }
      logPaperTrade({
        sport: pgSportKey, marketBase: market.base, ticker: matchedSide.ticker,
        teamAbbr: matchedSide.team, teamName: bettingOnTeam,
        opponentAbbr: otherSide.team, opponentName: otherSide.teamName,
        marketTitle: market.title, confidence, price,
        edge: Math.round(edge * 1000) / 10, wouldBetAmount: Math.round(betAmount * 100) / 100,
        wouldQty: betQty, reasoning: decision.reasoning, exitScenario: decision.exitScenario ?? null,
        pgBaseline: pgTargetBaseline,
      });
      logScreen({ stage: 'pre-game-paper', ticker: market.base, result: 'PAPER', confidence, price, reasoning: decision.reasoning });
      console.log(`[pre-game] 📋 PAPER: ${market.base} → ${matchedSide.team} @${Math.round(price*100)}¢ conf=${Math.round(confidence*100)}% wouldBet=$${betAmount.toFixed(2)} (${preGameTradesToday} today)`);
      // Lock this game after paper trade is logged — prevents re-analysis within same day.
      preGameBetGames.add(market.base);
    }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// UFC Predictions — Polymarket-only fight predictions
// ─────────────────────────────────────────────────────────────────────────────

// lastUFCScan declared at top (before loadState) to avoid TDZ
const UFC_SCAN_INTERVAL = 30 * 60 * 1000; // every 30 min (fights don't change fast)

async function checkUFCPredictions() {
  if (KALSHI_ONLY) return; // UFC is Poly-only
  if (Date.now() - lastUFCScan < UFC_SCAN_INTERVAL) return;
  lastUFCScan = Date.now();
  if (!canTrade()) return;
  if (polyBalance < 3) return;

  // Fetch UFC moneylines from Poly
  const polyMoneylines = await getPolyMoneylines();
  const ufcMarkets = polyMoneylines.filter(m => m.slug.includes('-ufc-'));

  if (ufcMarkets.length === 0) return;
  console.log(`[ufc] Found ${ufcMarkets.length} UFC fights on Polymarket`);

  // Filter to tradeable price range + no existing positions
  const tradeable = ufcMarkets.filter(m => {
    const price = Math.min(m.s0Price, m.s1Price);
    if (price < 0.05) return false;
    // Check if we already have a position on this fight
    const hasPos = openPositions.some(p => (p.ticker ?? '').toLowerCase() === m.slug.toLowerCase());
    if (hasPos) return false;
    if (Date.now() - (tradeCooldowns.get('poly:' + m.slug) ?? 0) < COOLDOWN_MS) return false;
    return true;
  });

  if (tradeable.length === 0) return;

  // Haiku screen: which fights are predictable?
  const fightList = tradeable.slice(0, 10).map(m =>
    `"${m.title}" — ${m.s0Name} @ ${(m.s0Price*100).toFixed(0)}¢ vs ${m.s1Name} @ ${(m.s1Price*100).toFixed(0)}¢ [slug: ${m.slug}]`
  ).join('\n');

  const screenText = await claudeScreen(
    `You are an MMA/UFC analyst. Pick up to 2 fights where you're most confident predicting the winner.\n\n` +
    `UPCOMING UFC FIGHTS:\n${fightList}\n\n` +
    `For each pick, consider: fighter records, recent form, style matchup, weight class.\n` +
    `Only pick fights where you're genuinely confident (≥65%).\n\n` +
    `JSON array: [{"slug":"exact slug","fighter":"name","side":"side0"/"side1","reason":"why they win"}] or []`,
    { category: 'ufc-screen' }
  );
  if (!screenText) return;

  let picks = [];
  try {
    const arr = extractJSONArray(screenText);
    if (arr) picks = JSON.parse(arr);
  } catch { return; }

  if (!Array.isArray(picks) || picks.length === 0) {
    console.log('[ufc] Haiku: no confident picks');
    return;
  }
  console.log(`[ufc] Haiku picked ${picks.length}: ${picks.map(p => p.fighter).join(', ')}`);

  for (const pick of picks.slice(0, 2)) {
    const market = tradeable.find(m => m.slug === pick.slug);
    if (!market) continue;

    const price = pick.side === 'side0' ? market.s0Price : market.s1Price;
    if (price > MAX_PRICE || price < 0.05) continue;

    // Sonnet deep dive — cold analysis, no Haiku anchor to avoid confirmation bias
    const decideText = await claudeWithSearch(
      `You are a professional MMA bettor. Predict this fight independently.\n\n` +
      `FIGHT: ${market.title}\n` +
      `${market.s0Name} (side0) @ ${(market.s0Price*100).toFixed(0)}¢ vs ${market.s1Name} (side1) @ ${(market.s1Price*100).toFixed(0)}¢\n\n` +
      `RESEARCH: Look up both fighters' records, recent fights, fighting style, strengths/weaknesses.\n\n` +
      `PREDICT: Who wins and why? Consider:\n` +
      `- Overall MMA record and recent form (last 3-5 fights)\n` +
      `- Fighting style matchup (striker vs grappler, etc.)\n` +
      `- Physical advantages (reach, size, cardio)\n` +
      `- Level of competition faced\n` +
      `- Ring rust (long layoffs hurt performance)\n\n` +
      `BUY if confidence ≥ 65% AND at least 3 points above that fighter's price.\n` +
      `Max bet: $${getPositionSize('polymarket').toFixed(2)}\n\n` +
      `JSON ONLY:\n` +
      `{"trade":false,"confidence":0.XX,"reasoning":"prediction"}\n` +
      `OR {"trade":true,"fighter":"exact name","side":"side0" or "side1","confidence":0.XX,"betAmount":N,"reasoning":"who wins and why"}`,
      { maxTokens: 800, maxSearches: 3, category: 'ufc' }
    );
    if (!decideText) { await reportError('ufc:sonnet-empty', 'UFC decider returned empty'); continue; }

    const jsonMatch = extractJSON(decideText);
    if (!jsonMatch) { await reportError('ufc:no-json', decideText.slice(0, 160)); continue; }
    let decision;
    try { decision = JSON.parse(jsonMatch); } catch (e) { await reportError('ufc:parse-fail', `${e.message} | head=${jsonMatch.slice(0, 160)}`); continue; }

    if (!decision.trade) {
      console.log(`[ufc] Sonnet rejected (${market.title}): conf=${((decision.confidence??0)*100).toFixed(0)}% | ${decision.reasoning?.slice(0, 80)}`);
      logScreen({ stage: 'ufc', slug: pick.slug, result: 'rejected', confidence: decision.confidence, reasoning: decision.reasoning });
      continue;
    }

    // Cross-reference: Haiku screened, Sonnet analyzed with web data — Sonnet wins when they disagree
    const sonnetFighter = (decision.fighter ?? '').toLowerCase();
    const haikuFighter = (pick.fighter ?? '').toLowerCase();
    const sonnetSide = decision.side ?? pick.side;
    const agreesOnFighter = sonnetFighter && haikuFighter &&
      (sonnetFighter.includes(haikuFighter.split(' ').pop()) || haikuFighter.includes(sonnetFighter.split(' ').pop()) || decision.side === pick.side);
    if (!agreesOnFighter) {
      // Sonnet has 3 web searches and full fighter analysis — trust it over Haiku's quick screen
      // Log the disagreement but proceed with Sonnet's pick (if it has valid side/fighter data)
      if (!decision.fighter || !decision.side) {
        console.log(`[ufc] BLOCKED: Sonnet disagreed with Haiku but gave incomplete pick — skipping (Haiku: ${pick.fighter}, Sonnet: ${decision.fighter ?? 'none'})`);
        logScreen({ stage: 'ufc', slug: pick.slug, result: 'disagreement-incomplete', reasoning: `Haiku: ${pick.fighter}, Sonnet: ${decision.fighter}` });
        continue;
      }
      console.log(`[ufc] ⚡ Sonnet overrides Haiku: Haiku picked ${pick.fighter}, Sonnet picked ${decision.fighter} — trusting Sonnet`);
      logScreen({ stage: 'ufc', slug: pick.slug, result: 'sonnet-override', reasoning: `Haiku: ${pick.fighter}, Sonnet: ${decision.fighter}` });
    }
    // Always use Sonnet's side — it has more information
    decision.side = sonnetSide || pick.side;

    const confidence = decision.confidence ?? 0;
    // UFC: most inefficient market, smallest margin needed
    const ufcMargin = getRequiredMargin(price, { sport: 'ufc', live: false });
    if (confidence < MIN_CONFIDENCE || confidence < price + ufcMargin) {
      console.log(`[ufc] Margin check failed: conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ need=${(ufcMargin*100).toFixed(0)}%`);
      continue;
    }

    if (!canTrade()) break;
    const ufcEdge = confidence - price;
    const maxBet = getPositionSize('polymarket', ufcEdge, 0, 'ufc');
    const safeBet = Math.min(decision.betAmount ?? 0, maxBet);
    if (safeBet < 1) continue;
    if (!canDeployMore(safeBet)) continue;

    const qty = Math.max(1, Math.floor(safeBet / (price + 0.02)));
    const intent = pick.side === 'side0' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT';
    const edge = confidence - price;

    console.log(`[ufc] 🥊 TRADE: ${pick.fighter} @ ${(price*100).toFixed(0)}¢ × ${qty} conf=${(confidence*100).toFixed(0)}%`);
    logScreen({ stage: 'ufc', slug: pick.slug, result: 'TRADE', confidence, price, reasoning: decision.reasoning });

    tradeCooldowns.set('poly:' + market.slug, Date.now());

    const result = await polymarketPost(market.slug, intent, price + 0.02, qty);
    if (result.ok) {
      stats.tradesPlaced++;
      const deployed = qty * price;
      logTrade({
        exchange: 'polymarket', strategy: 'ufc-prediction',
        ticker: market.slug, title: market.title,
        side: pick.side === 'side0' ? 'long' : 'short',
        quantity: qty, entryPrice: price, deployCost: deployed,
        edge: edge * 100, confidence,
        reasoning: decision.reasoning,
      });

      await tg(
        `🥊 <b>UFC BET — POLYMARKET</b>\n\n` +
        `<b>${market.title}</b>\n` +
        `Fighter: <b>${pick.fighter}</b>\n` +
        `BUY @ ${(price*100).toFixed(0)}¢ × ${qty} = <b>$${deployed.toFixed(2)}</b>\n` +
        `Confidence: <b>${(confidence*100).toFixed(0)}%</b> vs price ${(price*100).toFixed(0)}¢\n` +
        `Potential profit: <b>$${(qty * (1 - price)).toFixed(2)}</b>\n\n` +
        `🧠 <i>${decision.reasoning}</i>`
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Broad Market Scan — finds edges across ALL market types
// ─────────────────────────────────────────────────────────────────────────────

// lastBroadScan declared at top (before loadState) to avoid TDZ
const BROAD_SCAN_INTERVAL = 30 * 60 * 1000; // every 30 min — sports blocked, only non-sports remain

async function claudeBroadScan() {
  if (Date.now() - lastBroadScan < BROAD_SCAN_INTERVAL) return;
  lastBroadScan = Date.now();
  if (kalshiBalance < 5) return; // not enough to trade

  console.log('[broad-scan] Running Claude broad market scan...');

  // Fetch markets across categories — crypto, politics, economics
  // Sports game markets (KXMLBGAME etc.) are excluded: live-edge handles them with score+WE context.
  // Broad scan has no live game context so those would always be filtered out as untradeable anyway.
  const categories = [
    { name: 'Crypto', keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto'] },
    { name: 'Economics', keywords: ['cpi', 'fed', 'gdp', 'jobs', 'inflation', 'rate'] },
  ];

  const allMarkets = [];

  // Sports — only non-game sports markets (stats, futures, etc.) via general search
  // Skip the KXMLBGAME/NBA/NHL/etc. game-winner series — all get filtered as untradeable
  const sportsSeries = [];
  for (const s of sportsSeries) {
    try {
      const data = await kalshiGet(`/markets?series_ticker=${s}&status=open&limit=200`);
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

  // Golf/Masters — high volume event, scan parlays by keyword
  try {
    let cursor = '';
    for (let p = 0; p < 3; p++) {
      const url = `/markets?status=open&limit=100${cursor ? '&cursor=' + cursor : ''}`;
      const data = await kalshiGet(url);
      for (const m of data.markets ?? []) {
        if (!m.yes_ask_dollars || !m.no_ask_dollars) continue;
        const t = (m.title ?? '').toLowerCase();
        const ya = parseFloat(m.yes_ask_dollars);
        if (ya < 0.01 || ya > 0.99) continue;
        if (t.includes('masters') || t.includes('rory') || t.includes('scheffler') ||
            t.includes('scottie') || t.includes('cameron young') || t.includes('mcilroy')) {
          allMarkets.push({
            ticker: m.ticker, title: m.title, category: 'Golf/Masters',
            yesAsk: m.yes_ask_dollars, noAsk: m.no_ask_dollars,
            closeTime: m.close_time ?? '',
          });
        }
      }
      cursor = data.cursor ?? '';
      if (!cursor || (data.markets ?? []).length < 100) break;
    }
  } catch { /* skip */ }

  // Non-sports — use series tickers (category API is broken)
  const nonSportsSeries = [
    // Crypto disabled — focus on sports edge only for now
    // { series: 'KXBTC', label: 'Crypto' },
    // { series: 'KXETH', label: 'Crypto' },
    { series: 'KXFED', label: 'Economics' },
    { series: 'KXCPI', label: 'Economics' },
    { series: 'KXGDP', label: 'Economics' },
    { series: 'KXSP', label: 'Finance' },
    { series: 'KXGOLD', label: 'Finance' },
    { series: 'KXNEWPOPE', label: 'Politics' },
    { series: 'KXPRES', label: 'Politics' },
    { series: 'KXSENATE', label: 'Politics' },
    { series: 'KXHOUSE', label: 'Politics' },
  ];
  for (const { series: s, label } of nonSportsSeries) {
    try {
      const data = await kalshiGet(`/markets?series_ticker=${s}&status=open&limit=50`);
      for (const m of data.markets ?? []) {
        if (!m.yes_ask_dollars || !m.no_ask_dollars) continue;
        const ya = parseFloat(m.yes_ask_dollars);
        const na = parseFloat(m.no_ask_dollars);
        if (ya < 0.01 || na < 0.01) continue; // skip resolved/extreme
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

  // Filter: sports use ticker date (close_time is settlement, not game day), non-sports use close_time
  const etNowFilter = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etTmrwFilter = new Date(etNowFilter.getTime() + 24 * 60 * 60 * 1000);
  const toShortFilter = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
  const todayFilter = toShortFilter(etNowFilter);
  // Only include tomorrow after 10pm ET (late games crossing midnight)
  const etHourFilter = etNowFilter.getHours();
  const tonightFilter = etHourFilter >= 22 ? toShortFilter(etTmrwFilter) : null;
  const maxCloseMs = Date.now() + MAX_DAYS_OUT * 24 * 60 * 60 * 1000;

  const beforeFilter = allMarkets.length;
  for (let i = allMarkets.length - 1; i >= 0; i--) {
    const m = allMarkets[i];
    const isSport = m.category === 'Sports' || m.category === 'Golf/Masters';

    if (isSport) {
      const ticker = m.ticker ?? '';
      const isSoccer = ticker.startsWith('KXEPL') || ticker.startsWith('KXLALIGA') || ticker.startsWith('KXMLS');

      if (isSoccer) {
        // Soccer: allow games within next 3 days (games are scheduled, not daily like US sports)
        const ct = m.closeTime;
        if (ct) {
          const closeMs = Date.parse(ct);
          const threeDaysMs = Date.now() + 3 * 24 * 60 * 60 * 1000;
          if (Number.isFinite(closeMs) && closeMs > threeDaysMs) {
            allMarkets.splice(i, 1);
          }
        }
        // Also skip TIE markets — we only bet on team wins
        // Keep TIE contracts — draw betting is valid for in-game tied soccer
      } else {
        // US Sports: filter by ticker date (today/tonight only)
        if (!ticker.includes(todayFilter) && !(tonightFilter && tomorrowTickerWithinHours(ticker, tonightFilter, etNowFilter))) {
          allMarkets.splice(i, 1);
        }
      }
    } else {
      // Non-sports: filter by actual close_time
      const ct = m.closeTime;
      if (ct) {
        const closeMs = Date.parse(ct);
        if (Number.isFinite(closeMs) && closeMs > maxCloseMs) {
          allMarkets.splice(i, 1);
        }
      }
    }
  }
  const filtered = beforeFilter - allMarkets.length;
  if (filtered > 0) console.log(`[broad-scan] Filtered ${filtered} markets (sports: not today/tonight, non-sports: >${MAX_DAYS_OUT}d)`);

  if (allMarkets.length === 0) { console.log('[broad-scan] 0 markets found'); return; }

  const sportCount = allMarkets.filter(m => m.category === 'Sports').length;
  const nonSportCount = allMarkets.length - sportCount;
  console.log(`[broad-scan] Found ${allMarkets.length} markets (${sportCount} sports, ${nonSportCount} non-sports)`);

  // Group markets by event for bracket-aware presentation
  const eventGroups = new Map();
  for (const m of allMarkets) {
    // Derive event key: strip the last segment (threshold/team suffix)
    const parts = m.ticker.split('-');
    const lastPart = parts[parts.length - 1];
    // Sports tickers end with team abbrev (3 letters), brackets end with T/B + number
    const isBracket = /^[TB]?\d/.test(lastPart);
    const eventKey = isBracket ? parts.slice(0, -1).join('-') : m.ticker;
    if (!eventGroups.has(eventKey)) eventGroups.set(eventKey, []);
    eventGroups.get(eventKey).push(m);
  }

  // Build compact market list — show brackets together
  const marketLines = [];
  for (const [eventKey, markets] of eventGroups) {
    if (markets.length === 1) {
      // Single market (sports game-winner)
      const m = markets[0];
      marketLines.push(`[${m.category}] ${m.ticker}: "${m.title}" YES=$${m.yesAsk} NO=$${m.noAsk}`);
    } else {
      // Bracket/multi-outcome market — show all thresholds together
      const cat = markets[0].category;
      const baseTitle = markets[0].title.replace(/more than [\d.%-]+/, 'more than X%').replace(/\$[\d,.]+/, '$X');
      marketLines.push(`[${cat}] BRACKET: ${eventKey} — "${baseTitle}" (${markets.length} thresholds):`);
      for (const m of markets) {
        const threshold = m.ticker.split('-').pop();
        marketLines.push(`  ${m.ticker}: YES=$${m.yesAsk} NO=$${m.noAsk}`);
      }
    }
  }
  const marketSummary = marketLines.slice(0, 50).join('\n');

  // Fetch context: news + crypto prices
  let recentNews = '';
  let cryptoPrices = '';
  try {
    const newsRes = await fetch('http://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?limit=3',
      { headers: { 'User-Agent': 'arbor/1' }, signal: AbortSignal.timeout(3000) });
    if (newsRes.ok) {
      const nd = await newsRes.json();
      recentNews = (nd.articles ?? []).slice(0, 3).map(a => a.headline).join('; ');
    }
  } catch { /* skip */ }
  // Fetch BTC/ETH spot prices for crypto market analysis
  try {
    const cryptoRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(3000) });
    if (cryptoRes.ok) {
      const cd = await cryptoRes.json();
      const btc = cd.bitcoin?.usd ?? 0;
      const eth = cd.ethereum?.usd ?? 0;
      if (btc > 0) cryptoPrices = `BTC: $${btc.toLocaleString()} | ETH: $${eth.toLocaleString()}`;
    }
  } catch { /* skip */ }

  // Build list of game base tickers we already have positions on
  const positionBases = new Set();
  for (const p of openPositions) {
    const lastH = p.ticker.lastIndexOf('-');
    if (lastH > 0) positionBases.add(p.ticker.slice(0, lastH));
    positionBases.add(p.ticker);
  }

  // Filter out markets we already have positions on, and sports game markets
  // (live-edge and pre-game handle sports games with proper context — broad scan can't)
  const tradeable = allMarkets.filter(m => {
    if (/^KX(MLB|NBA|NFL|NHL|MLS|EPL|LALIGA)GAME-/i.test(m.ticker)) return false;
    const lastH = m.ticker.lastIndexOf('-');
    const base = lastH > 0 ? m.ticker.slice(0, lastH) : m.ticker;
    return !positionBases.has(base) && !positionBases.has(m.ticker);
  });

  if (tradeable.length === 0) { console.log('[broad-scan] No tradeable markets (all have positions)'); return; }

  // Dedup sports — same game has 2 tickers (one per team), keep only one
  const seenGameBases = new Set();
  const deduped = [];
  for (const m of tradeable) {
    if (m.category === 'Sports') {
      const lastH = m.ticker.lastIndexOf('-');
      const gameBase = lastH > 0 ? m.ticker.slice(0, lastH) : m.ticker;
      if (seenGameBases.has(gameBase)) continue;
      seenGameBases.add(gameBase);
    }
    deduped.push(m);
  }

  // Sports first so Claude sees today's games, then non-sports
  const sports = deduped.filter(m => m.category === 'Sports');
  const nonSports = deduped.filter(m => m.category !== 'Sports');
  const ordered = [...sports, ...nonSports];

  // Group markets by event for bracket-aware presentation
  const tradeEventGroups = new Map();
  for (const m of ordered) {
    const parts = m.ticker.split('-');
    const lastPart = parts[parts.length - 1];
    const isBracket = /^[TB]?\d/.test(lastPart);
    const eventKey = isBracket ? parts.slice(0, -1).join('-') : m.ticker;
    if (!tradeEventGroups.has(eventKey)) tradeEventGroups.set(eventKey, []);
    tradeEventGroups.get(eventKey).push(m);
  }

  const tradeLines = [];
  for (const [eventKey, markets] of tradeEventGroups) {
    if (markets.length === 1) {
      const m = markets[0];
      tradeLines.push(`[${m.category}] ${m.ticker}: "${m.title}" YES=$${m.yesAsk} NO=$${m.noAsk}`);
    } else {
      const cat = markets[0].category;
      tradeLines.push(`[${cat}] BRACKET EVENT: ${eventKey} (${markets.length} thresholds — CUMULATIVE, pick the best one):`);
      for (const m of markets) {
        tradeLines.push(`  ${m.ticker}: "${m.title}" YES=$${m.yesAsk} NO=$${m.noAsk}`);
      }
    }
  }
  const marketSummaryFiltered = tradeLines.slice(0, 80).join('\n');

  // Ask Claude with web search — strict rules
  try {
    // Use ET date AND next day (games starting at 10pm ET = Apr12 in ticker but Apr11 locally)
    const now = new Date();
    const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etTomorrow = new Date(etNow.getTime() + 24 * 60 * 60 * 1000);
    const toShort = (d) => `${String(d.getFullYear() % 100)}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
    const todayShort = toShort(etNow);
    // Only include tomorrow after 10pm ET
    const etHourBS = etNow.getHours();
    // Only mention tomorrow in the prompt if filtered markets actually contain tomorrow games
    // (markets are already filtered by tomorrowTickerWithinHours at location 2 above,
    //  so if no within-8h tomorrow game exists, tomorrowShortCandidate won't appear in the data)
    const tomorrowShortCandidate = etHourBS >= 22 ? toShort(etTomorrow) : null;
    const tomorrowShort = (tomorrowShortCandidate && marketSummaryFiltered.includes(tomorrowShortCandidate))
      ? tomorrowShortCandidate : null;
    const today = etNow.toISOString().slice(0, 10);

    // === STAGE 1: Cheap Haiku screen — find 0-3 candidates ($0.002/call) ===
    const screenPrompt =
      `Scan these prediction markets for potential mispricings. Most are efficient — return [] if nothing looks off.\n\n` +
      `TODAY: ${today} | Sports tickers: ${todayShort}${tomorrowShort ? '/' + tomorrowShort : ''} only\n` +
      (cryptoPrices ? `CRYPTO: ${cryptoPrices}\n` : '') +
      `\n${marketSummaryFiltered}\n\n` +
      `FOCUS on prices in the $0.30-$0.70 range — that's where real edges exist. A team at 55¢ that should be 65¢ is more actionable than a favorite at 93¢.\n` +
      `SKIP: $0.01-$0.05 (lottery tickets), $0.90+ (heavy favorites — usually correct), BTC ranges far from spot, YES+NO≈$1 (bid-ask spread).\n\n` +
      `Return JSON array (max 5): [{"ticker":"exact","reason":"why the price seems wrong"}] or []`;

    const screenText = await claudeScreen(screenPrompt, { category: 'broad-scan-screen' });
    if (!screenText) return;

    let candidates = [];
    try {
      const arrMatch = extractJSONArray(screenText);
      if (arrMatch) candidates = JSON.parse(arrMatch);
    } catch { /* not valid JSON */ }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      console.log('[broad-scan] Haiku screen: no candidates');
      logScreen({ stage: 'haiku', result: 'none', marketCount: deduped.length });
      return;
    }
    console.log(`[broad-scan] Haiku found ${candidates.length} candidates: ${candidates.map(c => c.ticker).join(', ')}`);
    logScreen({ stage: 'haiku', result: 'found', candidates, marketCount: deduped.length });

    // === STAGE 2: Sonnet + web search on each candidate ($0.08/call, max 5) ===
    for (const candidate of candidates.slice(0, 5)) {
      const market = deduped.find(m => m.ticker === candidate.ticker);
      if (!market) continue;

      // Skip sports game markets early — live-edge and pre-game handle these with proper
      // live score + WE data. Broad scan can't reliably map YES/NO sides or get game context.
      if (/^KX(MLB|NBA|NFL|NHL|MLS|EPL|LALIGA)GAME-/i.test(market.ticker)) {
        console.log(`[broad-scan] Skipping sports game ${market.ticker} — handled by live-edge/pre-game`);
        continue;
      }

      const isSportsMarket = market.category === 'Sports' || market.category === 'Golf/Masters';
      const yesPrice = parseFloat(market.yesAsk);
      const noPrice = parseFloat(market.noAsk);

      // Detect sport for sports markets
      const bsTicker = market.ticker ?? '';
      const bsDetectedSport = bsTicker.includes('MLB') ? 'MLB' : bsTicker.includes('NBA') ? 'NBA' :
        bsTicker.includes('NHL') ? 'NHL' : bsTicker.includes('MLS') ? 'MLS' : bsTicker.includes('EPL') ? 'EPL' :
        bsTicker.includes('LALIGA') ? 'La Liga' : 'Sports';
      const bsTodayDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });

      const decidePrompt = isSportsMarket
        ? `You are a ${bsDetectedSport} prediction analyst. Predict the outcome of this REGULAR SEASON ${bsDetectedSport} game being played TODAY, ${bsTodayDate}.\n\n` +
          `THIS IS A ${bsDetectedSport} GAME. Not a futures market, not a playoff series.\n\n` +
          `MARKET: ${market.ticker}: "${market.title}"\n` +
          `Sport: ${bsDetectedSport}\n` +
          `YES price: ${(yesPrice*100).toFixed(0)}¢ | NO price: ${(noPrice*100).toFixed(0)}¢\n` +
          `Screening note: "${candidate.reason}"\n\n` +
          `RESEARCH: Look up both teams' 2026 records, starting pitchers/goalies, key injuries TODAY, recent form.\n\n` +
          `PREDICT: Who wins this ${bsDetectedSport} game? How confident are you (0-100%)?\n` +
          `- If confidence ≥ 65% and the side you pick costs ≤ 75¢, BUY\n` +
          `- Pick YES (first team) or NO (second team)\n\n` +
          `Max bet: $${getDynamicMaxTrade().toFixed(2)}\n\n` +
          `CRITICAL: Respond with ONLY a JSON object. No other text.\n` +
          `{"trade":false,"confidence":0.XX,"reasoning":"${bsDetectedSport}: prediction"}\n` +
          `OR {"trade":true,"ticker":"${market.ticker}","side":"yes"/"no","confidence":0.XX,"betAmount":N,"reasoning":"${bsDetectedSport}: who wins and why"}`
        : `You are a prediction analyst. Evaluate this market.\n\n` +
          `MARKET: ${market.ticker}: "${market.title}"\n` +
          `YES: ${(yesPrice*100).toFixed(0)}¢ | NO: ${(noPrice*100).toFixed(0)}¢\n` +
          `Category: ${market.category}\n` +
          `Screening note: "${candidate.reason}"\n\n` +
          `RESEARCH: Look up current real-world data relevant to this market.\n\n` +
          `PREDICT: What's the true probability? If your confidence differs from the market by 5%+, trade it.\n\n` +
          `Max bet: $${getDynamicMaxTrade().toFixed(2)}\n\n` +
          `JSON ONLY:\n{"trade":false,"confidence":0.XX,"reasoning":"analysis"}\n` +
          `OR {"trade":true,"ticker":"${market.ticker}","side":"yes"/"no","confidence":0.XX,"betAmount":N,"reasoning":"why market is wrong"}`;

      const cText = await claudeWithSearch(decidePrompt, { maxTokens: 800, maxSearches: 3, category: 'broad-scan' });
      if (!cText) { await reportError('broad-scan:sonnet-empty', `${candidate.ticker}`); continue; }
      const jsonMatch = extractJSON(cText);
      if (!jsonMatch) {
        // 2026-04-29: silence Telegram alerts when Sonnet returned a non-JSON pass message
        // (e.g. "resolution is imminent", "no edge", "decline to trade"). These are valid
        // Sonnet decisions to skip, not errors. Only alert on genuine parse failures.
        const passKeywords = /imminent|resolution|resolves|already (settled|resolved)|no (edge|trade|opportunity)|decline|cannot recommend/i;
        if (passKeywords.test(cText)) {
          console.log(`[broad-scan] Sonnet declined ${candidate.ticker} (no JSON): ${cText.slice(0, 100)}`);
        } else {
          await reportError('broad-scan:no-json', `${candidate.ticker}: ${cText.slice(0, 160)}`);
        }
        continue;
      }

      let decision;
      try { decision = JSON.parse(jsonMatch); } catch (e) { await reportError('broad-scan:parse-fail', `${candidate.ticker}: ${e.message} | head=${jsonMatch.slice(0, 160)}`); continue; }

      if (!decision.trade) {
        console.log(`[broad-scan] Sonnet rejected ${candidate.ticker}: ${decision.reasoning?.slice(0, 100)}`);
        logScreen({ stage: 'sonnet', ticker: candidate.ticker, result: 'rejected', reasoning: decision.reasoning });
        continue;
      }

      // Found a trade — break out to the existing validation logic
      // Inject into the same flow below
      const cTextFinal = JSON.stringify(decision);
      const jsonMatchFinal = extractJSON(cTextFinal);
      if (!jsonMatchFinal) continue;

      // HARD VALIDATIONS (override Claude)
      const mktValid = deduped.find(m => m.ticker === decision.ticker);
      if (!mktValid) { console.log(`[broad-scan] BLOCKED: invalid ticker ${decision.ticker}`); continue; }

      const isSportsGame = /^KX(MLB|NBA|NFL|NHL|MLS|EPL|LALIGA)GAME-/i.test(decision.ticker);
      // Block ALL sports games from broad-scan — pre-game and live-edge handle these
      // with proper side mapping. Broad-scan can't reliably map YES/NO on sports.
      if (isSportsGame) {
        console.log(`[broad-scan] BLOCKED: sports game ${decision.ticker} — use pre-game or live-edge instead`);
        continue;
      }

      const lastH = decision.ticker.lastIndexOf('-');
      const base = lastH > 0 ? decision.ticker.slice(0, lastH) : decision.ticker;
      if (positionBases.has(base)) { console.log(`[broad-scan] BLOCKED: position on ${base}`); continue; }

      const price = decision.side === 'yes' ? parseFloat(mktValid.yesAsk) : parseFloat(mktValid.noAsk);
      if (price <= 0.05 || price >= MAX_PRICE) {
        console.log(`[broad-scan] BLOCKED: price ${(price*100).toFixed(0)}¢ outside 5-80¢ range`); continue;
      }

      // Confidence-based gate
      let confidence = decision.confidence ?? decision.probability ?? 0;

      // HARD CAP: Sports broad-scan confidence capped at baseline + 20%
      const bsSportKey = decision.ticker.includes('MLB') ? 'mlb' : decision.ticker.includes('NBA') ? 'nba' :
        decision.ticker.includes('NHL') ? 'nhl' : decision.ticker.includes('MLS') ? 'mls' :
        decision.ticker.includes('EPL') ? 'epl' : decision.ticker.includes('LALIGA') ? 'laliga' :
        decision.ticker.includes('SERIAA') ? 'seriea' : decision.ticker.includes('BUNDESLIGA') ? 'bundesliga' :
        decision.ticker.includes('LIGUE1') ? 'ligue1' : '';
      if (bsSportKey) {
        const bsBaselines = { mlb: 0.54, nba: 0.63, nhl: 0.59, mls: 0.49, epl: 0.45, laliga: 0.45, seriea: 0.45, bundesliga: 0.45, ligue1: 0.45 };
        const bsBaseline = bsBaselines[bsSportKey] ?? 0.55;
        // Approximate: YES = home team, NO = away. Not perfect but good enough for a cap.
        const bsTargetBaseline = decision.side === 'yes' ? bsBaseline : (1 - bsBaseline);
        const bsMaxAllowed = Math.min(0.90, bsTargetBaseline + 0.20);
        if (confidence > bsMaxAllowed) {
          console.log(`[broad-scan] Confidence capped: ${(confidence*100).toFixed(0)}% → ${(bsMaxAllowed*100).toFixed(0)}% (baseline ${(bsTargetBaseline*100).toFixed(0)}%)`);
          confidence = bsMaxAllowed;
        }
      }

      const bsCat = mktValid.category?.toLowerCase() ?? '';
      const bsSport = bsSportKey || (bsCat.includes('crypto') ? 'crypto' : bsCat.includes('econ') ? 'economics' : bsCat.includes('polit') ? 'politics' : '');
      const bsReqMargin = getRequiredMargin(price, { sport: bsSport, live: false });
      if (confidence < MIN_CONFIDENCE) { console.log(`[broad-scan] Confidence too low: ${(confidence*100).toFixed(0)}%`); continue; }
      if ((confidence - price) < bsReqMargin) { console.log(`[broad-scan] Not enough margin: conf=${(confidence*100).toFixed(0)}% price=${(price*100).toFixed(0)}¢ edge=${((confidence-price)*100).toFixed(1)}% need=${(bsReqMargin*100).toFixed(0)}% (${bsSport})`); continue; }

      const edge = confidence - price;

      if (kalshiBalance < 3) continue;
      if (Date.now() - (tradeCooldowns.get(decision.ticker) ?? 0) < COOLDOWN_MS) continue;
      if (!canTrade()) continue;
      // Sport exposure cap removed — sports are our main revenue driver

      const maxBet = getPositionSize('kalshi', 0, 0, bsSport);
      const safeBet = Math.min(decision.betAmount ?? 0, maxBet);
      if (safeBet < 1 || price <= 0) continue;

      const qty = Math.max(1, Math.floor(safeBet / price));
      const priceInCents = Math.round(price * 100);

      console.log(`[broad-scan] 🎯 TRADE: ${mktValid.title} ${decision.side} @${priceInCents}¢ × ${qty} conf=${(confidence*100).toFixed(0)}%`);
      console.log(`  Reason: ${decision.reasoning}`);
      logScreen({ stage: 'sonnet', ticker: decision.ticker, result: 'TRADE', confidence, price, reasoning: decision.reasoning });
      if (!canDeployMore(safeBet)) continue;

      tradeCooldowns.set(decision.ticker, Date.now());
      tradeCooldowns.set(base, Date.now());

      // For sports games: ALWAYS buy YES. If Claude said NO (other team wins),
      // we should find the other team's ticker. But since broad-scan rarely trades sports,
      // just force YES on sports and keep YES/NO for non-sports (crypto, economics).
      const finalSide = isSportsGame ? 'yes' : decision.side;
      if (isSportsGame && decision.side === 'no') {
        console.log(`[broad-scan] WARNING: Claude said NO on sports game ${decision.ticker}. Forcing YES to avoid side confusion. Verify reasoning.`);
      }
      const result = await kalshiPost('/portfolio/orders', {
        ticker: decision.ticker, action: 'buy', side: finalSide, count: qty,
        yes_price: finalSide === 'yes' ? priceInCents : 100 - priceInCents,
      });

      if (result.ok) {
        stats.tradesPlaced++;
        const teamSuffix = decision.ticker.split('-').pop() ?? '';
        const closeMs = Date.parse(mktValid.closeTime);
        const daysOut = Number.isFinite(closeMs) ? Math.ceil((closeMs - Date.now()) / (24*60*60*1000)) : '?';

        logTrade({
          exchange: 'kalshi', strategy: 'claude-prediction',
          ticker: decision.ticker, title: mktValid.title, category: mktValid.category,
          side: decision.side, quantity: qty, entryPrice: price,
          deployCost: qty * price,
          filled: (result.data.order ?? result.data).quantity_filled ?? 0,
          orderId: (result.data.order ?? result.data).order_id ?? null,
          edge: edge * 100, confidence,
          reasoning: decision.reasoning,
          daysOut,
        });

        await tg(
          `🎯 <b>PREDICTION BET — KALSHI</b>\n\n` +
          `<b>${mktValid.title}</b>\n` +
          `Category: ${mktValid.category}\n` +
          `Ticker: <code>${decision.ticker}</code>\n` +
          `Team: <b>${teamSuffix}</b>\n\n` +
          `BUY ${decision.side.toUpperCase()} @ ${(price*100).toFixed(0)}¢ × ${qty} = <b>$${(qty * price).toFixed(2)}</b>\n` +
          `Confidence: <b>${(confidence*100).toFixed(0)}%</b> vs price ${(price*100).toFixed(0)}¢\n` +
          `Potential profit: <b>$${(qty * (1 - price)).toFixed(2)}</b>\n\n` +
          `🧠 <i>${decision.reasoning}</i>`
        );
      }
      break; // placed a trade — don't check more candidates this cycle
    }
  } catch (e) {
    console.error('[broad-scan] error:', e.message);
  }

  // [Polymarket scan removed — integrated into live-edge and pre-game via cross-platform price check]
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Loop
// ─────────────────────────────────────────────────────────────────────────────

async function pollCycle() {
  // Refresh full portfolio (balance + positions)
  await refreshPortfolio();

  // Initialize daily tracking on first cycle
  if (dailyOpenBankroll === 0) resetDailyTracking();

  // Check for midnight ET reset (new trading day)
  if (etHour() === 0 && Date.now() - lastHaltCheck > 60 * 60 * 1000) {
    lastHaltCheck = Date.now();
    resetDailyTracking();
    console.log('[risk] New trading day — reset daily limits');
  }

  // Risk check — skip everything if halted
  if (!canTrade()) return;

  // Min cash cap removed — let canTrade() and canDeployMore() handle limits
  const availCash = getAvailableCash('kalshi');
  if (false) { // disabled
  }

  // Live in-game predictions FIRST — most time-sensitive (scores change every minute)
  await checkLiveScoreEdges();

  // Pre-game predictions (best entry prices, runs every 5 min)
  await checkPreGamePredictions();

  // UFC predictions (Polymarket only, runs every 30 min)
  await checkUFCPredictions();

  // Broad market scan — sports + non-sports (runs every 5 min)
  await claudeBroadScan();
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Position Management — game-stage-aware profit-taking, stop-loss, Claude exits
// ─────────────────────────────────────────────────────────────────────────────

// Get game stage and live data for a trade's ticker by matching ESPN scoreboard
async function getGameContext(trade) {
  const ticker = trade.ticker ?? '';
  let league = '';
  if (ticker.includes('MLB')) league = 'mlb';
  else if (ticker.includes('NBA')) league = 'nba';
  else if (ticker.includes('NHL')) league = 'nhl';
  else if (ticker.includes('MLS')) league = 'mls';
  else if (ticker.includes('EPL')) league = 'epl';
  else if (ticker.includes('LALIGA')) league = 'laliga';
  else if (ticker.includes('SERIAA')) league = 'seriea';
  else if (ticker.includes('BUNDESLIGA')) league = 'bundesliga';
  else if (ticker.includes('LIGUE1')) league = 'ligue1';
  else return null;

  const pathMap = { mlb: 'baseball/mlb', nba: 'basketball/nba', nhl: 'hockey/nhl', mls: 'soccer/usa.1', epl: 'soccer/eng.1', laliga: 'soccer/esp.1', seriea: 'soccer/ita.1', bundesliga: 'soccer/ger.1', ligue1: 'soccer/fra.1' };
  try {
    const res = await fetch(`http://site.api.espn.com/apis/site/v2/sports/${pathMap[league]}/scoreboard`,
      { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();

    // Find the game matching this ticker's teams
    const teamSuffix = ticker.split('-').pop()?.toUpperCase() ?? '';
    for (const ev of data.events ?? []) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const teams = (comp.competitors ?? []).map(c => c.team?.abbreviation ?? '');
      if (!teams.some(t => t === teamSuffix)) continue;

      const period = parseInt(comp.status?.period ?? '0');
      const state = comp.status?.type?.state ?? '';
      const detail = comp.status?.type?.shortDetail ?? '';
      // displayClock format: "MM:SS" (e.g., "8:59"). Used by ladder gamma override
      // to detect NBA Q4 final 2:00 — a price-vs-edge regime change point.
      let clockSeconds = null;
      const clockStr = comp.status?.displayClock;
      if (typeof clockStr === 'string' && /^\d+:\d+$/.test(clockStr)) {
        const [m, s] = clockStr.split(':').map(n => parseInt(n, 10));
        if (Number.isFinite(m) && Number.isFinite(s)) clockSeconds = m * 60 + s;
      }
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');

      // Determine game stage: early, mid, late, finished
      let stage = 'unknown';
      if (state === 'post') stage = 'finished';
      else if (league === 'mlb') stage = period <= 4 ? 'early' : period <= 6 ? 'mid' : 'late';
      else if (league === 'nba') stage = period <= 2 ? 'early' : period === 3 ? 'mid' : 'late';
      else if (league === 'nhl') stage = period === 1 ? 'early' : period === 2 ? 'mid' : 'late';
      else if (['mls', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league)) stage = period === 1 ? 'early' : 'late'; // soccer: 1st half = early, 2nd half = late

      const homeScore = parseInt(home?.score ?? '0');
      const awayScore = parseInt(away?.score ?? '0');
      const diff = Math.abs(homeScore - awayScore);
      const leading = homeScore > awayScore ? home : away;

      // Get win expectancy for current situation
      const baselineWE = getWinExpectancy(league, diff, period, leading?.team?.abbreviation === (home?.team?.abbreviation));

      // Build context string for Claude
      const sit = comp.situation;
      let situationStr = `${away?.team?.abbreviation} ${awayScore} @ ${home?.team?.abbreviation} ${homeScore} | ${detail}`;
      if (sit?.lastPlay?.text) situationStr += ` | Last: ${sit.lastPlay.text}`;
      if (league === 'mlb' && sit) {
        const runners = [sit.onFirst && '1st', sit.onSecond && '2nd', sit.onThird && '3rd'].filter(Boolean);
        if (runners.length > 0 || sit.outs > 0) situationStr += ` | ${sit.outs} outs, runners: ${runners.join(',') || 'none'}`;
        if (sit.pitcher?.athlete?.displayName) situationStr += ` | Pitching: ${sit.pitcher.athlete.displayName} (${sit.pitcher.summary ?? ''})`;
      }

      return { league, stage, period, state, detail: situationStr, homeScore, awayScore, diff, baselineWE, leading: leading?.team?.abbreviation, clockSeconds };
    }
  } catch { /* skip */ }
  return null;
}

// Get exit thresholds — when Claude starts evaluating a losing position
// claudeStop = the % drop where Claude is asked sell/hold
// Nuclear stop (hardcoded in managePositions) handles the absolute floor
function getExitThresholds(stage, entryPrice = 0.50) {
  const tier = entryPrice >= 0.70 ? 'expensive' : entryPrice >= 0.50 ? 'mid' : 'cheap';

  // Claude evaluates earlier on expensive entries (can't afford to wait)
  // and later on cheap entries (risk/reward justifies patience)
  const thresholds = {
    expensive: {
      early:   { claudeStop: -0.15 },  // 75¢ entry → Claude at 64¢ (-15%)
      mid:     { claudeStop: -0.12 },  // 75¢ entry → Claude at 66¢ (-12%)
      late:    { claudeStop: -0.10 },  // 75¢ entry → Claude at 67¢ (-10%)
      unknown: { claudeStop: -0.12 },
    },
    mid: {
      early:   { claudeStop: -0.25 },  // 60¢ entry → Claude at 45¢
      mid:     { claudeStop: -0.20 },
      late:    { claudeStop: -0.15 },
      unknown: { claudeStop: -0.20 },
    },
    cheap: {
      early:   { claudeStop: -0.35 },  // 30¢ entry → Claude at 19¢
      mid:     { claudeStop: -0.30 },
      late:    { claudeStop: -0.25 },
      unknown: { claudeStop: -0.30 },
    },
  };

  return thresholds[tier][stage] ?? thresholds[tier].unknown;
}

// Process UI-requested manual sells (written by api.mjs to sell-requests.jsonl).
// Marks each request as 'done' or 'failed' after processing so we don't retry.
const SELL_REQUESTS_FILE = './logs/sell-requests.jsonl';
async function processUISellRequests() {
  if (!existsSync(SELL_REQUESTS_FILE)) return;
  try {
    const lines = readFileSync(SELL_REQUESTS_FILE, 'utf-8').split('\n').filter(l => l.trim());
    const requests = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const pending = requests.filter(r => r.status === 'pending');
    if (pending.length === 0) return;

    const trades = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    for (const req of pending) {
      const trade = trades.find(t =>
        t.status === 'open' && t.exchange === 'kalshi' &&
        ((req.tradeId && t.id === req.tradeId) || (req.ticker && t.ticker === req.ticker))
      );
      if (!trade) { req.status = 'failed'; req.error = 'trade not found or not open'; continue; }
      try {
        const data = await kalshiGet(`/markets/${trade.ticker}`);
        const m = data.market ?? data;
        const bid = parseFloat(m.yes_bid_dollars ?? m.yes_ask_dollars ?? '0');
        const price = trade.side === 'yes' ? bid : (1 - parseFloat(m.yes_ask_dollars ?? '0'));
        const result = await executeSell(trade, trade.quantity, price, req.reason ?? 'manual-ui');
        req.status = result ? 'done' : 'failed';
        req.executedAt = new Date().toISOString();
        req.executedPrice = price;
      } catch (e) {
        req.status = 'failed';
        req.error = e.message;
      }
    }

    // Rewrite file with updated statuses + keep last 200
    const all = [...requests.filter(r => r.status !== 'pending' || pending.find(p => p.id === r.id)), ...pending];
    const merged = requests.map(r => pending.find(p => p.id === r.id) ?? r).slice(-200);
    writeFileSync(SELL_REQUESTS_FILE, merged.map(r => JSON.stringify(r)).join('\n') + '\n');
    void all;
  } catch (e) {
    console.error('[ui-sell] error:', e.message);
  }
}

async function managePositions() {
  // Process UI sell requests first (manual overrides from the web app)
  await processUISellRequests();

  if (!existsSync(TRADES_LOG)) return;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const openTrades = trades.filter(t => t.status === 'open');
    // Sync structuralOpenEntries with reality: remove any ticker no longer open.
    // Keeps the concurrent-bleed throttle from blocking on phantom/closed positions.
    const _openTickers = new Set(openTrades.map(t => t.ticker));
    for (const t of structuralOpenEntries.keys()) {
      if (!_openTickers.has(t)) structuralOpenEntries.delete(t);
    }
    if (openTrades.length === 0) return;

    // Batch fetch current prices
    const kalshiPrices = new Map();
    for (const t of openTrades.filter(t => t.exchange === 'kalshi')) {
      try {
        const data = await kalshiGet(`/markets/${t.ticker}`);
        const m = data.market ?? data;
        if (m.yes_ask_dollars) {
          kalshiPrices.set(t.ticker, {
            yes: parseFloat(m.yes_ask_dollars), no: parseFloat(m.no_ask_dollars),
            yesBid: parseFloat(m.yes_bid_dollars ?? m.yes_ask_dollars),
          });
        }
      } catch { /* skip */ }
    }

    const polyPrices = new Map();
    const polyMoneylines = await getPolyMoneylines();
    for (const pm of polyMoneylines) {
      polyPrices.set(pm.slug, { s0: pm.s0Price, s1: pm.s1Price });
    }

    let anyUpdated = false;

    for (const trade of openTrades) {
      try {
        if (trade.exchange !== 'kalshi') continue; // Can only sell on Kalshi

        const prices = kalshiPrices.get(trade.ticker);
        if (!prices) continue;

        const currentPrice = trade.side === 'yes' ? prices.yes : prices.no;
        const entryPrice = trade.entryPrice ?? 0;
        if (entryPrice <= 0 || currentPrice <= 0) continue;

        const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / entryPrice);
        if (qty <= 0) continue;

        const profitPerContract = currentPrice - entryPrice;
        const pctChange = profitPerContract / entryPrice;

        // MFE update — track max favorable price move over the trade's lifetime.
        // YES side: favorable = price up. NO side: favorable = price down.
        // Persisted on exit/settlement; in-memory between updates.
        {
          const favorableMove = trade.side === 'yes'
            ? (currentPrice - entryPrice)
            : (entryPrice - currentPrice);
          const prev = mfeTracking.get(trade.id);
          if (!prev || favorableMove > prev.maxMove) {
            mfeTracking.set(trade.id, {
              maxPrice: currentPrice,
              maxMove: favorableMove,
            });
          }
        }

        // Fetch game context (stage, score, ESPN data)
        const ctx = await getGameContext(trade);
        const stage = ctx?.stage ?? 'unknown';
        const league = ctx?.league ?? (trade.ticker?.includes('MLB') ? 'mlb' : trade.ticker?.includes('NBA') ? 'nba' : trade.ticker?.includes('NHL') ? 'nhl' : trade.ticker?.includes('MLS') ? 'mls' : trade.ticker?.includes('EPL') ? 'epl' : trade.ticker?.includes('LALIGA') ? 'laliga' : trade.ticker?.includes('SERIAA') ? 'seriea' : trade.ticker?.includes('BUNDESLIGA') ? 'bundesliga' : trade.ticker?.includes('LIGUE1') ? 'ligue1' : '');
        const thresholds = getExitThresholds(stage, entryPrice);

        // === TIER 1: Rule-based auto-exits ===

        // CONTRA LINE-MOVE SCRATCH — if a cross-confirmed CONTRA drop just fired on this
        // ticker at >=5¢/min, exit before stop-loss eats the full drawdown. The
        // recentCrossContraMovers map is already gated on cross-confirmation (both
        // contracts moved together) and expires after 5min, so a hit here means a
        // real market reaction within the last few minutes. Saves us from watching
        // a live trade collapse 75→47→8¢ before the nuclear stop finally fires.
        // Requires trade to have been open ≥60s to avoid firing on entry-induced moves.
        const tradeAgeSec = (Date.now() - new Date(trade.timestamp ?? 0).getTime()) / 1000;
        const contraMove = recentCrossContraMovers.get(trade.ticker);
        if (contraMove && tradeAgeSec >= 60 && contraMove.velocity >= 5) {
          const moveAgeSec = (Date.now() - contraMove.when) / 1000;
          // GATE 1: respect recent Claude HOLD — don't override a thesis-aware hold
          // with a pure price-velocity signal. STL@MIA was scratched at 21¢ 5 min
          // after Claude explicitly held at WE=60%, costing us ~30% true-WE edge.
          const claudeHoldMsCt = tradeCooldowns.get('claude-hold:' + trade.ticker) ?? 0;
          const claudeHoldAgeSec = claudeHoldMsCt > 0 ? (Date.now() - claudeHoldMsCt) / 1000 : Infinity;
          const claudeHoldActive = claudeHoldAgeSec <= 600;
          // GATE 2: pre-game / edge-first in early-stage with WE still recoverable.
          // A 2-run MLB deficit end of 2nd is still ~30% WE — price crash is market
          // overreaction, not thesis death. Wait for WE to confirm.
          const isPgLikeCt = trade.strategy === 'pre-game-prediction' || trade.strategy === 'pre-game-edge-first';
          const ourTeamAbbrCt = (trade.ticker?.split('-').pop() ?? '').toUpperCase();
          const ourWECt = (ctx?.baselineWE != null)
            ? (ctx.leading === ourTeamAbbrCt ? ctx.baselineWE : (1 - ctx.baselineWE))
            : null;
          const pgEarlyWeOk = isPgLikeCt && stage === 'early' && ourWECt != null && ourWECt > 0.30;
          if (moveAgeSec <= 120 && claudeHoldActive) {
            console.log(`[exit] 🛡️ CONTRA BLOCKED on ${trade.ticker}: Claude HOLD ${Math.round(claudeHoldAgeSec)}s ago overrides price-velocity signal`);
          } else if (moveAgeSec <= 120 && pgEarlyWeOk) {
            console.log(`[exit] 🛡️ CONTRA BLOCKED on ${trade.ticker}: ${trade.strategy} in ${stage} stage, WE=${(ourWECt*100).toFixed(0)}% still recoverable — market overreaction, not thesis death`);
          } else if (moveAgeSec <= 120) {
            console.log(`[exit] ⚠️ CONTRA EXIT: ${trade.ticker} — cross-confirmed ${contraMove.velocity.toFixed(1)}¢/min drop ${Math.round(moveAgeSec)}s ago, attempting to scratch full position @ ${(currentPrice*100).toFixed(0)}¢`);
            const result = await executeSellAndNotify(trade, qty, currentPrice, 'contra-line-move', {
              kind: 'CONTRA-EXIT (price velocity)',
              title: trade.title,
              entry: entryPrice,
              exit: currentPrice,
              qty: qty,
              pnl: qty * (currentPrice - entryPrice),
              reason: `Market dropped ${contraMove.velocity.toFixed(1)}¢/min cross-confirmed — scratching before stop-loss`,
              isWin: pctChange >= 0,
            });
            if (result) anyUpdated = true;
            continue;
          }
        }

        // 2026-04-29 — TRAILING STOP. If price has retraced significantly from
        // peak (MFE), exit before further damage. Activates only AFTER trade has
        // been meaningfully profitable (peak ≥+10¢) so noise doesn't trigger it.
        // Catches the case where price spikes then crashes back — e.g., NYY-TEX
        // hit 93¢ peak today; if it had crashed to 70¢ before tier-1 fired we'd
        // have given back $2-3. Fires on full remaining position; ladder still
        // runs first to capture partial locks at threshold crosses.
        {
          const eligibleForTrailing = trade.strategy?.startsWith?.('structural-')
            || trade.strategy === 'live-prediction'
            || trade.strategy === 'live-swing'
            || trade.strategy === 'pre-game-prediction'
            || trade.strategy === 'pre-game-edge-first';
          if (eligibleForTrailing && trade.side === 'yes' && !trade.trailingStopFiredAt) {
            const mfe = mfeTracking.get(trade.id);
            const peakPrice = mfe?.maxPrice ?? trade.maxFavorablePrice ?? entryPrice;
            const peakGain = peakPrice - entryPrice;
            const retraceFromPeak = peakPrice - currentPrice;
            const TRAILING_ACTIVATE = 0.10;  // need +10¢ peak to activate
            // Fix B (2026-04-30): structural detectors have ~80-100% WR — they should ride
            // to near-settlement, not exit on an 8¢ noise dip. Widen for structural.
            // 2026-04-30 sport-aware refinement: NBA leads swing more than MLB (Q3-Q4
            // routinely flip 5-10pt). NBA structural needs wider trail to ride through
            // normal variance and capture peak. NHL between MLB and NBA. MLB unchanged.
            const isStructural = trade.strategy?.startsWith?.('structural-');
            const _trailLeague = ctx?.league;
            const TRAILING_DISTANCE = isStructural
              ? (_trailLeague === 'nba' ? 0.15
                 : _trailLeague === 'nhl' ? 0.12
                 : 0.12) // MLB / soccer / default
              : 0.08;

            // Fix C (2026-04-30): if Claude voted HOLD within last 15min AND we're in a
            // late inning (MLB inn 8-9) with win probability ≥ 80%, suppress the trailing
            // stop entirely. Claude's HOLD explicitly says "settlement EV > sell price" —
            // trust that over a mechanical retrace trigger. SF@PHI 8th inning was the
            // exact case: HOLD vote → 9¢ dip from PHI baserunners → stop fired → SF won.
            const claudeHoldTs = tradeCooldowns.get('claude-hold:' + trade.ticker) ?? 0;
            const claudeHoldRecent = claudeHoldTs > 0 && (Date.now() - claudeHoldTs) <= 15 * 60 * 1000;
            const lateInningSuppression = isStructural && league === 'mlb'
              && claudeHoldRecent
              && ctx?.period != null && ctx.period >= 8
              && currentPrice >= 0.70; // WP ≥ 70¢ = game is in hand, noise dips are normal
            if (lateInningSuppression) {
              console.log(`[exit] 🧠🛡️ TRAILING STOP SUPPRESSED: ${trade.ticker} — Claude HOLD ${Math.round((Date.now()-claudeHoldTs)/1000)}s ago + inn ${ctx.period} + price ${(currentPrice*100).toFixed(0)}¢ — holding for settlement`);
            }

            // 2026-05-01: NBA GARBAGE-TIME suppression. Q4 + 20+ pt lead + >4min
            // remaining = bench-vs-bench play. Bench scoring runs cause 5-10c noise
            // dips that fire the trailing stop, but the OUTCOME is locked because
            // the game is decided. Suppress trailing stop in this regime — leader
            // settles at 100c regardless of price wiggle.
            const _gtClockMatch = ctx?.gameDetail?.match?.(/(\d+):(\d{2})/);
            const _gtSecsLeft = _gtClockMatch ? parseInt(_gtClockMatch[1], 10) * 60 + parseInt(_gtClockMatch[2], 10) : 999;
            const nbaGarbageTimeSuppression = isStructural && league === 'nba'
              && ctx?.period === 4
              && Math.abs(ctx?.diff ?? 0) >= 20
              && _gtSecsLeft > 240
              && currentPrice >= 0.85; // only suppress when leader pricing reflects locked game
            if (nbaGarbageTimeSuppression) {
              console.log(`[exit] 🏀🛡️ NBA GARBAGE-TIME SUPPRESSION: ${trade.ticker} — Q4 with ${Math.abs(ctx.diff)}pt lead + ${Math.floor(_gtSecsLeft/60)}:${String(_gtSecsLeft%60).padStart(2,'0')} remaining + price ${(currentPrice*100).toFixed(0)}¢ — holding through bench variance`);
            }

            const stillProfitable = currentPrice > entryPrice + 0.02; // ≥+2¢ to lock real profit
            if (!lateInningSuppression && !nbaGarbageTimeSuppression && peakGain >= TRAILING_ACTIVATE && retraceFromPeak >= TRAILING_DISTANCE && stillProfitable) {
              const lockProfit = ((currentPrice - entryPrice) * 100).toFixed(0);
              const peakProfit = (peakGain * 100).toFixed(0);
              console.log(`[exit] 🎯 TRAILING STOP: ${trade.ticker} peak=${(peakPrice*100).toFixed(0)}¢(+${peakProfit}¢) → now=${(currentPrice*100).toFixed(0)}¢ — attempting to lock +${lockProfit}¢ before further retrace`);
              const result = await executeSellAndNotify(trade, qty, currentPrice, 'trailing-stop', {
                kind: 'TRAILING STOP',
                title: trade.title,
                entry: entryPrice,
                exit: currentPrice,
                qty: qty,
                pnl: qty * profitPerContract,
                reason: `Peak ${(peakPrice*100).toFixed(0)}¢ → now ${(currentPrice*100).toFixed(0)}¢. ${(retraceFromPeak*100).toFixed(0)}¢ retrace from peak — locking +${lockProfit}¢ profit.`,
                isWin: true,
              });
              if (result) {
                trade.trailingStopFiredAt = new Date().toISOString();
                anyUpdated = true;
              }
              continue;
            }
          }
        }

        // 2026-04-29 BLEED-OUT STOP: catches the slow-drip losing pattern that
        // claudeStop / AUTO-HOLD / contra-line-move all miss. Pure price-based exit:
        // if a trade has been open long enough AND price has dropped meaningfully
        // from entry AND price is still falling — exit now. Don't ask Claude. Don't
        // check WE table. The price is telling us the thesis is dead.
        //
        // Strategy-aware thresholds (per actual trade-log analysis):
        //   structural-* / live-prediction: 10¢ drop, 8 min hold
        //   live-swing:                     8¢ drop, 5 min hold
        //   pre-game-edge-first:           15¢ drop, 30 min hold
        //   pre-game-prediction:           20¢ drop, 45 min hold
        //   draw-bet:                       (excluded — own crash-stop system)
        //
        // Tonight's TOR-CLE would have triggered at ~min 15 with -22% loss instead
        // of -68% via contra exit. Backtested on 45 historical losers: ~$280 saved.
        {
          const _strat = trade.strategy ?? '';
          let bleedOutEnabled = true;
          let dropThreshold = 0.10;  // default
          let minHoldMin = 8;
          if (_strat === 'draw-bet') {
            bleedOutEnabled = false;
          } else if (_strat === 'live-swing') {
            dropThreshold = 0.08; minHoldMin = 5;
          } else if (_strat === 'pre-game-edge-first') {
            dropThreshold = 0.15; minHoldMin = 30;
          } else if (_strat === 'pre-game-prediction') {
            dropThreshold = 0.20; minHoldMin = 45;
          } else if (_strat === 'live-prediction' || _strat.startsWith('structural-')) {
            // 2026-04-30: SPORT-AWARE bleed-out for structural detectors. Bleed-out
            // calibrated for MLB (1-run lead loss = real thesis death; outs running out)
            // misfires on NBA where Q2 leads flip 6-8x/game routinely. DEN@MIN tonight:
            // bot exited at 38¢ on Q2 lead reversal, MIN came back to 66¢. -$2.64 vs.
            // would-have-been +$3.52. Same problem applies to NHL early periods and
            // soccer 1H. Now matches volatility profile of each sport+stage.
            const _ctxLeague = ctx?.league;
            const _ctxPeriod = ctx?.period;
            const _isSoccer = ['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(_ctxLeague);
            if (_ctxLeague === 'nba' && _ctxPeriod && _ctxPeriod <= 2) {
              // NBA Q1-Q2: lead flips are routine variance — disable bleed-out, let
              // trailing stop handle exits at peak. n=1 incident (DEN@MIN 2026-04-30)
              // but sport-physics-driven, not statistical artifact.
              bleedOutEnabled = false;
            } else if (_ctxLeague === 'nba') {
              dropThreshold = 0.15; minHoldMin = 12;
            } else if (_ctxLeague === 'nhl' && _ctxPeriod === 3) {
              dropThreshold = 0.10; minHoldMin = 8;
            } else if (_ctxLeague === 'nhl') {
              dropThreshold = 0.12; minHoldMin = 10;
            } else if (_isSoccer && _ctxPeriod === 1) {
              // 2026-05-02 FIX: was `_ctxPeriod < 60` which was a period-vs-minute
              // confusion bug — period=2 (2nd half) is < 60 so soccer bleed-out
              // was permanently DISABLED in any half. ALA@ATH 2026-05-02 dropped
              // -55% in 1 min with no exit attempt because of this.
              // Real intent: only disable bleed-out in 1st half (single goal swing huge).
              // 2nd half: enable with sport-tuned thresholds.
              bleedOutEnabled = false;
            } else if (_isSoccer) {
              dropThreshold = 0.15; minHoldMin = 10;
            } else {
              // MLB (default) and any unrecognized league: 10¢ / 8min.
              dropThreshold = 0.10; minHoldMin = 8;
            }
          } else {
            bleedOutEnabled = false;  // unknown strategy — don't trigger
          }
          if (bleedOutEnabled && trade.side === 'yes') {
            const tradeAgeMin = (Date.now() - new Date(trade.timestamp ?? 0).getTime()) / 60000;
            const dropFromEntry = entryPrice - currentPrice;
            // Price-still-falling check: compare to last seen price for this ticker
            const prevSeen = lastSeenPrices.get(trade.ticker);
            const priceStillFalling = prevSeen && currentPrice <= prevSeen.price + 0.01;  // flat or down
            if (tradeAgeMin >= minHoldMin && dropFromEntry >= dropThreshold && priceStillFalling) {
              const lossPct = (currentPrice - entryPrice) / entryPrice;
              // 2026-05-02: velocity-confirmed bleed-out. Severe drops (≥-25%) exit
              // immediately as before — collapse is collapse. Moderate drops require
              // a recent cross-confirmed contra signal so we exit on real info, not
              // slow drift on quiet positions. KC@SEA 2026-05-01 was a borderline
              // case (had velocity, exit defensible); refinement protects against
              // unobserved slow-grind failure mode.
              const isSevereDrop = lossPct <= -0.25;
              const _bvMover = recentCrossContraMovers.get(trade.ticker);
              const _bvFresh = !!(_bvMover && (Date.now() - _bvMover.when) <= 5 * 60 * 1000);
              if (!isSevereDrop && !_bvFresh) {
                console.log(`[bleed-out-defer] ${trade.ticker} ${(lossPct*100).toFixed(0)}% drawdown but no fresh cross-contra velocity (last 5min) — holding for thesis (slow drift, not real info)`);
              } else {
                const _trigger = isSevereDrop ? 'SEVERE-DROP' : `velocity ${_bvMover.velocity.toFixed(1)}¢/min ${Math.round((Date.now()-_bvMover.when)/1000)}s ago`;
                console.log(`[exit] 🩸 BLEED-OUT STOP (${_trigger}): ${trade.ticker} entry=${(entryPrice*100).toFixed(0)}¢ → now=${(currentPrice*100).toFixed(0)}¢ (-${(dropFromEntry*100).toFixed(0)}¢, ${(lossPct*100).toFixed(0)}%) | open ${tradeAgeMin.toFixed(0)}min | thesis dead — attempting exit`);
                const result = await executeSellAndNotify(trade, qty, currentPrice, 'bleed-out-stop', {
                  kind: 'BLEED-OUT STOP',
                  title: trade.title,
                  entry: entryPrice,
                  exit: currentPrice,
                  qty: qty,
                  pnl: qty * profitPerContract,
                  reason: `Price dropped ${(dropFromEntry*100).toFixed(0)}¢ from entry (${(lossPct*100).toFixed(0)}%) over ${tradeAgeMin.toFixed(0)} min. Trigger: ${_trigger}.`,
                  isWin: false,
                });
                if (result) anyUpdated = true;
                continue;
              }
            }
          }
        }

        // PROFIT-LOCKING LADDER — incremental mechanical locks on volatile in-play
        // trades (live-prediction / pre-game-edge-first / structural-*). Fires BEFORE
        // safety nets so partial profits get captured on swings without preventing
        // the existing "hold when leading" upside on the remainder.
        // Fix B (2026-04-30): skip ladder entirely for structural detectors — they have
        // ~80-100% WR and are meant to ride to settlement. Taking partial profit at +15¢
        // (tier-1) steals upside: MIA-LAD exited at 65¢ when it settled at 100¢, costing
        // $1.26. The 12¢ trailing stop and bleed-out stop still protect the downside.
        {
          const ladder = trade.strategy?.startsWith?.('structural-') ? null : getLadderState(trade, profitPerContract, currentPrice, league, ctx);
          if (ladder?.fire) {
            const sellQty = ladder.fraction >= 1.0 ? qty : Math.max(1, Math.floor(qty * ladder.fraction));
            if (sellQty >= 1 && sellQty <= qty) {
              const reasonTag = `ladder-${ladder.label}`;
              const profitDollars = sellQty * profitPerContract;
              console.log(`[ladder] 🪜 ${ladder.label}: ${trade.ticker} +${(profitPerContract*100).toFixed(0)}¢ — locking ${sellQty}/${qty} contracts @ ${(currentPrice*100).toFixed(0)}¢ (+$${profitDollars.toFixed(2)})`);
              const result = await executeSell(trade, sellQty, currentPrice, reasonTag);
              if (result) {
                anyUpdated = true;
                // Persist tier counter — full exit (tier 3) is handled by executeSell's
                // sold-status path, but tiers 1-2 leave the trade open with reduced qty.
                if (ladder.tier < 3) {
                  trade.ladderTiersDone = ladder.tier;
                  try {
                    const lLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
                    const lTrades = lLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                    const lTrade = lTrades.find(t => t.id === trade.id);
                    if (lTrade) {
                      lTrade.ladderTiersDone = ladder.tier;
                      writeFileSync(TRADES_LOG, lTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
                    }
                  } catch (e) { console.error(`[ladder] Failed to persist tier for ${trade.ticker}:`, e.message); }
                }
                await tg(
                  `🪜 <b>LADDER LOCK — ${ladder.label.toUpperCase()}</b>\n\n` +
                  `${trade.title}\n` +
                  `Entry ${Math.round(entryPrice*100)}¢ → ${Math.round(currentPrice*100)}¢ (+${(profitPerContract*100).toFixed(0)}¢)\n` +
                  `Sold ${sellQty}/${qty} contracts (locked <b>+$${profitDollars.toFixed(2)}</b>)\n` +
                  (ladder.tier < 3 ? `Remaining ${qty - sellQty} ride to next tier${ladder.tier === 1 ? ' (+25¢)' : ' / settlement'}` : `Full exit — gamma override`) + '\n\n' +
                  dailyFooter()
                );
              }
              continue;
            }
          }
        }

        // LATE-GAME PROFIT-TAKE at 97¢+ — risking $0.97 to gain $0.03 is 32:1 against us
        if (stage === 'late' && currentPrice >= 0.97 && profitPerContract > 0) {
          console.log(`[exit] 💰 LATE-GAME LOCK (${stage}): ${trade.ticker} at ${(currentPrice*100).toFixed(0)}¢ — locking profit, not worth risking for 3¢`);
          const result = await executeSell(trade, qty, currentPrice, 'profit-take');
          if (result) anyUpdated = true;
          continue;
        }

        // MID-GAME PROFIT-LOCK — cash out live bets at 92¢+ before late game.
        // At 92¢ the remaining 8¢ upside ($1.00 settlement) is marginal, but a
        // reversal (opponent scores, momentum shift) can erase 20-30¢ in minutes.
        // Early game: lock at 95¢ (even more game left = more reversal risk)
        // Mid game: lock at 92¢
        // Late game: handled above at 97¢ (closer to settlement, safer to hold)
        const midLockThreshold = stage === 'early' ? 0.95 : 0.92;
        if ((stage === 'early' || stage === 'mid') && currentPrice >= midLockThreshold && profitPerContract > 0 && trade.strategy !== 'pre-game-prediction') {
          const gainPct = Math.round((profitPerContract / entryPrice) * 100);
          console.log(`[exit] 💰 MID-GAME LOCK (${stage}): ${trade.ticker} at ${(currentPrice*100).toFixed(0)}¢ — up ${(profitPerContract*100).toFixed(0)}¢ / +${gainPct}%, attempting profit lock`);
          const result = await executeSellAndNotify(trade, qty, currentPrice, 'mid-game-profit-lock', {
            kind: `PROFIT LOCK — ${stage} game`,
            title: trade.title,
            entry: entryPrice,
            exit: currentPrice,
            qty: qty,
            pnl: qty * profitPerContract,
            reason: `Only ${Math.round((1-currentPrice)*100)}¢ remaining upside — locking profit before reversal risk`,
            isWin: true,
          });
          if (result) anyUpdated = true;
          continue;
        }

        // EPL/LA LIGA 70-MINUTE HARD EXIT — draw probability spikes past 25% in final 20 minutes.
        // WE tables assume win-or-loss; they don't model the draw outcome. A 1-0 EPL lead at 70'
        // has ~25% draw risk — that's 25% chance of full position loss on top of normal L odds.
        // Sell everything at minute 70 regardless of P&L. If losing: stops handle it earlier anyway.
        if ((trade.strategy === 'pre-game-prediction' || trade.strategy === 'pre-game-edge-first') && ['epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(league)
            && ctx?.period != null && ctx.period >= 70) {
          const gainPct = Math.round((profitPerContract / entryPrice) * 100);
          const verb = profitPerContract >= 0 ? 'locking profit' : 'cutting loss';
          console.log(`[exit] ⚽⏰ SOCCER 70-MIN EXIT: ${trade.ticker} @ ${(currentPrice*100).toFixed(0)}¢ — minute ${ctx.period}, ${verb} before draw cliff (draw rate ~25%+ after min 70)`);
          const result = await executeSell(trade, qty, currentPrice, 'epl-70min-exit');
          if (result) {
            anyUpdated = true;
            await tg(
              `⚽⏰ <b>EPL 70-MIN EXIT</b>\n\n` +
              `${trade.title}\n` +
              `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (${gainPct >= 0 ? '+' : ''}${gainPct}%)\n` +
              `Minute: ${ctx.period} — selling before draw probability spikes\n` +
              `P&L: <b>${profitPerContract >= 0 ? '+' : ''}$${(qty * profitPerContract).toFixed(2)}</b>`
            );
          }
          continue;
        }

        // PRE-GAME PROFIT-LOCK — exit when the market agrees with our entry estimate.
        //
        // DATA-DRIVEN UPDATE: Pre-game settled MLB = 6W-3L (67%), avg win = +$21.35.
        // Profit-locks were selling at +12-20¢/contract when settlement pays +43-57¢ on wins.
        // At 67% win rate, EV of holding a 45¢ entry from 57¢: 0.67×55¢ - 0.33×45¢ = +22¢.
        // EV of selling at 57¢: guaranteed +12¢. Holding is nearly 2x better.
        //
        // MLB HOLD-TO-SETTLEMENT: When WE > 55% and price is rising, hold for settlement.
        // MLB games resolve cleanly — the team either wins or loses, no draws.
        // NHL/NBA/Soccer: keep profit-lock (faster-moving, more volatile, draws possible).
        //
        // CONFIDENCE-ANCHORED EXIT (NHL/NBA/EPL): don't sell below own entry confidence.
        // The pre-game thesis persists through the game — exit only when price validates it.
        //   NHL/EPL/LaLiga: price ≥ max(stage_target, entry_confidence)  — full anchor
        //   NBA:            price ≥ max(stage_target, entry_confidence - 2%)  — 2% buffer
        //   Late stage (P3/inn8+/Q4): revert to stage target only (+8¢)
        const pgStageProfitTarget = stage === 'early' ? 0.20 : stage === 'late' ? 0.08 : 0.12;

        const entryConf = trade.confidence ?? 0;
        const confFloorPrice = (league === 'mlb' || stage === 'late') ? 0
          : league === 'nba' ? Math.max(0, entryConf - 0.02)
          : entryConf;

        const confGainTarget = (confFloorPrice > entryPrice) ? (confFloorPrice - entryPrice) : 0;
        // CAL partial-take price override: if suggest.mjs calibrated a per-sport/playoff
        // partial-take price, honor it when it yields a smaller gain target (take profit earlier)
        // on winners — we never override upward, only earlier lock-in.
        const pgIsPlayoff = /Game \d/i.test(trade.title ?? '');
        const calPartialPrice = getPartialTakePrice(league, pgIsPlayoff);
        const calGainTarget = (calPartialPrice != null && calPartialPrice > entryPrice)
          ? (calPartialPrice - entryPrice) : null;
        const pgProfitTarget = calGainTarget != null
          ? Math.min(Math.max(pgStageProfitTarget, confGainTarget), calGainTarget)
          : Math.max(pgStageProfitTarget, confGainTarget);

        // HOLD-TO-SETTLEMENT (ALL SPORTS): skip profit-lock when our team is winning.
        // Data: pre-game settled wins avg +$21.35/trade vs profit-locks at +$5-8. Holding
        // when winning is strictly better EV across all sports. The 97¢ late-game lock and
        // soccer 70-min exit still fire as safety nets above this.
        // Only take profit in late stage if price ≥ 90¢ (game is nearly settled anyway).
        const holdToSettle = profitPerContract > 0 && (
          stage !== 'late' || currentPrice < 0.90
        );
        if (holdToSettle && (trade.strategy === 'pre-game-prediction' || trade.strategy === 'pre-game-edge-first') && profitPerContract >= pgProfitTarget && !trade.pgHoldToSettlement) {
          console.log(`[exit] 🧘 HOLD-TO-SETTLEMENT: ${trade.ticker} [${league.toUpperCase()}] up ${(profitPerContract*100).toFixed(0)}¢ (${(currentPrice*100).toFixed(0)}¢) — holding for settlement, team is winning`);
        }

        if ((trade.strategy === 'pre-game-prediction' || trade.strategy === 'pre-game-edge-first') && profitPerContract >= pgProfitTarget && !trade.partialTakeAt && !trade.pgHoldToSettlement && !holdToSettle) {
          if (qty >= 1) {
            const gainPct = Math.round((profitPerContract / entryPrice) * 100);
            const anchorNote = confGainTarget > pgStageProfitTarget
              ? ` [conf-anchor: ${Math.round(confFloorPrice*100)}¢ > stage +${Math.round(pgStageProfitTarget*100)}¢]`
              : ` [stage target +${Math.round(pgStageProfitTarget*100)}¢]`;
            console.log(`[exit] 💰 PRE-GAME TARGET HIT (${stage}${anchorNote}): ${trade.ticker} up ${(profitPerContract*100).toFixed(0)}¢ / +${gainPct}% — selling ALL ${qty} @ ${(currentPrice*100).toFixed(0)}¢, profit ~$${(qty * profitPerContract).toFixed(2)}`);
            const result = await executeSell(trade, qty, currentPrice, 'pre-game-profit-lock');
            if (result) {
              trade.partialTakeAt = new Date().toISOString();
              anyUpdated = true;
              await tg(
                `💰 <b>PRE-GAME TARGET HIT</b>\n\n` +
                `📋 <b>POSITION</b>\n` +
                `${trade.title}\n\n` +
                `📊 <b>METRICS</b>\n` +
                `Sold ALL ${qty} contracts @ ${(currentPrice*100).toFixed(0)}¢\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (+${(profitPerContract*100).toFixed(0)}¢, +${gainPct}%)\n` +
                `Stage: ${stage} | Target: ${confGainTarget > pgStageProfitTarget ? `conf ${Math.round(confFloorPrice*100)}¢` : `+${Math.round(pgStageProfitTarget*100)}¢`}\n` +
                `Profit: <b>+$${(qty * profitPerContract).toFixed(2)}</b>`
              );
            }
            continue;
          }
        }

        // DRAW-BET PROFIT-LOCK — sell at +12¢. Draw-bets are binary cliffs:
        // one goal and TIE goes from 50¢ to 5¢ instantly. Can't manage the downside
        // on a 60s cycle. Lock the profit, don't gamble on settlement.
        if (trade.strategy === 'draw-bet' && profitPerContract >= 0.12) {
          const gainPct = Math.round((profitPerContract / entryPrice) * 100);
          console.log(`[exit] ⚽💰 DRAW-BET PROFIT-LOCK: ${trade.ticker} up ${(profitPerContract*100).toFixed(0)}¢ / +${gainPct}% — selling ALL ${qty}`);
          const result = await executeSell(trade, qty, currentPrice, 'draw-bet-profit-lock');
          if (result) {
            anyUpdated = true;
            await tgTradeExit({
              kind: 'DRAW-BET PROFIT LOCK',
              title: trade.title,
              entry: entryPrice,
              exit: currentPrice,
              qty: qty,
              pnl: qty * profitPerContract,
              reason: `TIE price hit +12¢ target — clean exit`,
              isWin: true,
            });
          }
          continue;
        }

        // DRAW-BET STOP-LOSS — cut at -50% immediately. A goal breaking the tie
        // sends TIE from ~50¢ to ~5¢ instantly. No Claude deliberation, just exit.
        if (trade.strategy === 'draw-bet' && pctChange < -0.50) {
          const lossAmt = Math.abs(profitPerContract) * qty;
          console.log(`[exit] ⚽🛑 DRAW-BET STOP: ${trade.ticker} down ${(pctChange*100).toFixed(0)}% — attempting to cut loss at $${lossAmt.toFixed(2)}`);
          const result = await executeSellAndNotify(trade, qty, currentPrice, 'draw-bet-stop', {
            kind: 'DRAW-BET STOP LOSS',
            title: trade.title,
            entry: entryPrice,
            exit: currentPrice,
            qty: qty,
            pnl: qty * profitPerContract,
            reason: `Goal likely broke the tie — exiting before further collapse`,
            isWin: false,
          });
          if (result) anyUpdated = true;
          continue;
        }

        // LIVE-PREDICTION PROFIT-LOCK — Claude-evaluated.
        // Mechanical sells left money on the table: ORL was winning by 8 in Q4 at 71¢,
        // holding to settlement would have paid +46¢/contract vs the +17¢ locked.
        // Let Claude see score, time, momentum, and EV math before deciding.
        // 2026-04-29: extended to structural trades (strategy: structural-*).
        // For low-price entries (≤60¢), lower trigger to +12¢ — these are swing trades
        // where capturing the variance is the strategy, not holding to settlement.
        const _isStructTrade = trade.strategy?.startsWith?.('structural-');
        const _isLowPriceEntry = entryPrice <= 0.60;
        const _profitLockTrigger = _isLowPriceEntry ? 0.12 : 0.15;
        if ((trade.strategy === 'live-prediction' || _isStructTrade) && profitPerContract >= _profitLockTrigger) {
          const gainPct = Math.round((profitPerContract / entryPrice) * 100);
          const lockProfit = (profitPerContract * 100).toFixed(0);
          const profitLockKey = 'profit-lock-eval:' + trade.ticker;
          const lastProfitEval = tradeCooldowns.get(profitLockKey) ?? 0;
          if (Date.now() - lastProfitEval >= 5 * 60 * 1000) {
            tradeCooldowns.set(profitLockKey, Date.now());
            const ourTeam = trade.ticker?.split('-').pop() ?? '';
            const ourWE = ctx?.leading === ourTeam ? (ctx?.baselineWE ?? 0.5) : (1 - (ctx?.baselineWE ?? 0.5));
            const weLeading = ctx?.leading === ourTeam;
            const holdEV = Math.round((ourWE * (1 - entryPrice) - (1 - ourWE) * entryPrice) * 100);

            const profitLockPrompt =
              `Live bet UP ${lockProfit}¢ (+${gainPct}%). Should we SELL to lock profit or HOLD for settlement?\n\n` +
              `POSITION: Bought ${ourTeam} at ${(entryPrice*100).toFixed(0)}¢, now ${(currentPrice*100).toFixed(0)}¢.\n` +
              `Game: ${trade.title}\n` +
              (ctx ? `LIVE: ${ctx.detail} | Stage: ${stage.toUpperCase()} | Period: ${ctx.period}\n` : '') +
              (ctx ? `Our team: ${ourTeam} | ${weLeading ? 'WE ARE LEADING' : 'WE ARE TRAILING'} | Score diff: ${ctx.diff}\n` : '') +
              `Win expectancy: ${(ourWE * 100).toFixed(0)}%\n\n` +
              `EV MATH:\n` +
              `• SELL NOW: Lock +${lockProfit}¢/contract (guaranteed $${(qty * profitPerContract).toFixed(2)})\n` +
              `• HOLD TO WIN: +${((1 - entryPrice) * 100).toFixed(0)}¢/contract ($${(qty * (1 - entryPrice)).toFixed(2)}) at ${(ourWE * 100).toFixed(0)}% probability\n` +
              `• HOLD EV: ${holdEV > 0 ? '+' : ''}${holdEV}¢/contract vs guaranteed +${lockProfit}¢\n\n` +
              `BIAS: HOLD when leading. Teams winning by 5+ in NBA Q4 win >90%. MLB leads of 3+ in 7th+ win >85%.\n` +
              `SELL only if: momentum has clearly shifted (opponent on a big run), WE < 60%, or score is within 1-2 AND late game.\n` +
              `HOLD if: we are leading comfortably, WE > 70%, or settlement upside (${((1 - entryPrice) * 100).toFixed(0)}¢) >> lock profit (${lockProfit}¢).\n\n` +
              `JSON: {"action":"sell"/"hold","reasoning":"1 sentence"}`;

            const evalText = await claudeScreen(profitLockPrompt, { maxTokens: 200, timeout: 8000, category: 'exit:profit-lock' });
            if (evalText) {
              try {
                const match = extractJSON(evalText);
                if (match) {
                  const d = JSON.parse(match);
                  if (d.action === 'sell') {
                    console.log(`[exit] 🧠💰 CLAUDE PROFIT-LOCK (live, ${stage}): ${trade.ticker} up ${lockProfit}¢ / +${gainPct}% — selling | ${d.reasoning?.slice(0,80)}`);
                    const result = await executeSell(trade, qty, currentPrice, 'live-profit-lock');
                    if (result) {
                      anyUpdated = true;
                      await tg(
                        `🧠💰 <b>CLAUDE PROFIT-LOCK (LIVE)</b>\n\n` +
                        `${trade.title}\n` +
                        `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (+${lockProfit}¢, +${gainPct}%)\n` +
                        `Profit: <b>+$${(qty * profitPerContract).toFixed(2)}</b>\n\n` +
                        `🧠 ${d.reasoning?.slice(0, 120) ?? ''}`
                      );
                    }
                    continue;
                  } else {
                    console.log(`[exit] 🧠🛡️ CLAUDE HOLD at profit-lock (live, ${stage}): ${trade.ticker} up ${lockProfit}¢ — holding for settlement | ${d.reasoning?.slice(0,80)}`);
                    tradeCooldowns.set('claude-hold:' + trade.ticker, Date.now());
                  }
                }
              } catch { /* skip */ }
            } else {
              console.log(`[exit] ⏳ Live profit-lock threshold on ${trade.ticker} but Claude unavailable — deferring (bias: hold)`);
            }
          }
        }

        // LIVE HIGH-CONVICTION PROFIT-LOCK — Claude-evaluated.
        // HC entries are sized bigger and carry more conviction — let Claude decide
        // whether the game context supports holding for settlement vs locking profit.
        const hcProfitTarget = stage === 'early' ? 0.25 : stage === 'late' ? 0.15 : 0.20;
        if (trade.strategy === 'high-conviction' && profitPerContract >= hcProfitTarget) {
          const gainPct = Math.round((profitPerContract / entryPrice) * 100);
          const lockProfit = (profitPerContract * 100).toFixed(0);
          const hcLockKey = 'hc-profit-lock-eval:' + trade.ticker;
          const lastHcEval = tradeCooldowns.get(hcLockKey) ?? 0;
          if (Date.now() - lastHcEval >= 5 * 60 * 1000) {
            tradeCooldowns.set(hcLockKey, Date.now());
            const ourTeam = trade.ticker?.split('-').pop() ?? '';
            const ourWE = ctx?.leading === ourTeam ? (ctx?.baselineWE ?? 0.5) : (1 - (ctx?.baselineWE ?? 0.5));
            const weLeading = ctx?.leading === ourTeam;
            const holdEV = Math.round((ourWE * (1 - entryPrice) - (1 - ourWE) * entryPrice) * 100);

            const hcLockPrompt =
              `High-conviction bet UP ${lockProfit}¢ (+${gainPct}%). Should we SELL to lock profit or HOLD for settlement?\n\n` +
              `POSITION: Bought ${ourTeam} at ${(entryPrice*100).toFixed(0)}¢, now ${(currentPrice*100).toFixed(0)}¢. HC entry = larger position size.\n` +
              `Game: ${trade.title}\n` +
              (ctx ? `LIVE: ${ctx.detail} | Stage: ${stage.toUpperCase()} | Period: ${ctx.period}\n` : '') +
              (ctx ? `Our team: ${ourTeam} | ${weLeading ? 'WE ARE LEADING' : 'WE ARE TRAILING'} | Score diff: ${ctx.diff}\n` : '') +
              `Win expectancy: ${(ourWE * 100).toFixed(0)}%\n\n` +
              `EV MATH:\n` +
              `• SELL NOW: Lock +${lockProfit}¢/contract (guaranteed $${(qty * profitPerContract).toFixed(2)})\n` +
              `• HOLD TO WIN: +${((1 - entryPrice) * 100).toFixed(0)}¢/contract ($${(qty * (1 - entryPrice)).toFixed(2)}) at ${(ourWE * 100).toFixed(0)}% probability\n` +
              `• HOLD EV: ${holdEV > 0 ? '+' : ''}${holdEV}¢/contract vs guaranteed +${lockProfit}¢\n\n` +
              `This is a HIGH-CONVICTION entry — we had strong reasons to bet big. BIAS: HOLD when leading.\n` +
              `SELL only if: momentum has clearly shifted, WE < 60%, or score is dangerously close late.\n` +
              `HOLD if: we are leading, WE > 70%, or settlement upside >> lock profit.\n\n` +
              `JSON: {"action":"sell"/"hold","reasoning":"1 sentence"}`;

            const evalText = await claudeScreen(hcLockPrompt, { maxTokens: 200, timeout: 8000, category: 'exit:hc-lock' });
            if (evalText) {
              try {
                const match = extractJSON(evalText);
                if (match) {
                  const d = JSON.parse(match);
                  if (d.action === 'sell') {
                    console.log(`[exit] 🧠🔥 CLAUDE HC PROFIT-LOCK (${stage}): ${trade.ticker} up ${lockProfit}¢ / +${gainPct}% — selling | ${d.reasoning?.slice(0,80)}`);
                    const result = await executeSell(trade, qty, currentPrice, 'hc-profit-lock');
                    if (result) {
                      anyUpdated = true;
                      await tg(
                        `🧠🔥 <b>CLAUDE HC PROFIT-LOCK</b>\n\n` +
                        `${trade.title}\n` +
                        `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (+${lockProfit}¢, +${gainPct}%)\n` +
                        `Stage: ${stage} | Target was +${Math.round(hcProfitTarget*100)}¢\n` +
                        `Profit: <b>+$${(qty * profitPerContract).toFixed(2)}</b>\n\n` +
                        `🧠 ${d.reasoning?.slice(0, 120) ?? ''}`
                      );
                    }
                    continue;
                  } else {
                    console.log(`[exit] 🧠🛡️ CLAUDE HOLD at HC profit-lock (${stage}): ${trade.ticker} up ${lockProfit}¢ — holding for settlement | ${d.reasoning?.slice(0,80)}`);
                    tradeCooldowns.set('claude-hold:' + trade.ticker, Date.now());
                  }
                }
              } catch { /* skip */ }
            } else {
              console.log(`[exit] ⏳ HC profit-lock threshold on ${trade.ticker} but Claude unavailable — deferring (bias: hold)`);
            }
          }
        }

        // === LIVE SWING EXIT PATHS ===
        // Swing trades exit on profit, hard-stop, or thesis expiry — never hold to settlement.
        if (trade.strategy === 'live-swing') {
          const swingProfit = currentPrice - entryPrice;
          const periodsElapsed = ctx?.period != null && trade.periodAtEntry != null
            ? ctx.period - trade.periodAtEntry : 0;

          // 1. PROFIT-LOCK: sell all at +12¢
          if (swingProfit >= 0.12) {
            const gainPct = Math.round((swingProfit / entryPrice) * 100);
            console.log(`[exit] 🔄💰 SWING PROFIT-LOCK: ${trade.ticker} up ${(swingProfit*100).toFixed(0)}¢ / +${gainPct}% — selling ALL ${qty}`);
            {
              const lh = trade.ticker.lastIndexOf('-');
              const gb = lh > 0 ? trade.ticker.slice(0, lh) : trade.ticker;
              const sk = ctx?.homeScore != null ? `${ctx.homeScore}-${ctx.awayScore}` : null;
              swingExitState.set(gb, { ts: Date.now(), scoreKey: sk, exitPrice: currentPrice, reason: 'profit-lock' });
            }
            const result = await executeSell(trade, qty, currentPrice, 'swing-profit-lock');
            if (result) {
              anyUpdated = true;
              await tg(
                `🔄💰 <b>SWING PROFIT-LOCK</b>\n\n` +
                `${trade.title}\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (+${(swingProfit*100).toFixed(0)}¢, +${gainPct}%)\n` +
                `Profit: <b>+$${(qty * swingProfit).toFixed(2)}</b>`
              );
            }
            continue;
          }

          // 2. STOP THRESHOLD: -10¢ after 1+ period → Claude evaluates
          // Contra-velocity escalation: if a cross-confirmed contra move fired on this
          // ticker within the last 10min, tighten stop to -6¢. The market is actively
          // moving away from us — don't wait for a full -10¢ drawdown.
          const swingContra = recentCrossContraMovers.get(trade.ticker);
          const swingContraActive = swingContra && (Date.now() - swingContra.when) <= 10 * 60 * 1000 && swingContra.velocity >= 5;
          const swingStopThreshold = swingContraActive ? -0.06 : -0.10;
          if (swingContraActive && swingProfit <= -0.06 && swingProfit > -0.10) {
            console.log(`[live-swing] 🔻 CONTRA-ESCALATED stop on ${trade.ticker}: contra ${swingContra.velocity.toFixed(1)}¢/min — tightened stop to -6¢`);
          }
          if (periodsElapsed >= 1 && swingProfit <= swingStopThreshold) {
            const swingStopKey = 'swing-stop-eval:' + trade.ticker;
            const lastSwingEval = tradeCooldowns.get(swingStopKey) ?? 0;
            if (Date.now() - lastSwingEval >= 5 * 60 * 1000) {
              // Memo check: if Claude already said HOLD recently and nothing material shifted, skip.
              {
                const _swOurTeam = (trade.ticker?.split('-').pop() ?? '').toUpperCase();
                const _swOurWE = (ctx?.baselineWE != null) ? (ctx.leading === _swOurTeam ? ctx.baselineWE : (1 - ctx.baselineWE)) : null;
                const _ah = shouldAutoHold(trade.ticker, ctx, _swOurWE);
                if (_ah) {
                  console.log(`[exit] 🧠🧘 AUTO-HOLD swing-stop (memo ${_ah.ageMin}min ago from ${_ah.path}): ${trade.ticker} — skipping Claude re-eval | prev: ${_ah.reasoning}`);
                  tradeCooldowns.set(swingStopKey, Date.now());
                  continue;
                }
              }
              tradeCooldowns.set(swingStopKey, Date.now());
              const ticker = trade.ticker ?? '';
              const sport = ticker.includes('NBA') ? 'NBA' : ticker.includes('MLB') ? 'MLB'
                : ticker.includes('NHL') ? 'NHL' : 'Soccer';
              const swingStopPrompt =
                `Live ${sport} swing trade hit stop threshold (-${Math.round(-swingProfit*100)}¢ after ${periodsElapsed} period(s)). SELL or HOLD?\n\n` +
                `POSITION: Entry ${(entryPrice*100).toFixed(0)}¢ → Now ${(currentPrice*100).toFixed(0)}¢ (${(swingProfit*100).toFixed(0)}¢).\n` +
                `Game: ${trade.title}\n` +
                (ctx ? `LIVE: ${ctx.detail} | Period: ${ctx.period}\n` : '') +
                (ctx?.baselineWE != null ? `Win expectancy: ${(((ctx?.leading === (ticker.split('-').pop() ?? '')) ? ctx.baselineWE : (1 - ctx.baselineWE))*100).toFixed(0)}%\n` : '') +
                `\nThis is a swing trade (short-term momentum play). Is the momentum thesis still alive?\n` +
                `SELL if the momentum has clearly reversed and recovery is unlikely.\n` +
                `HOLD if the team still has a realistic path and the game situation supports a comeback.\n\n` +
                `JSON: {"action":"sell"/"hold","reasoning":"1 sentence"}`;
              const swingText = await claudeScreen(swingStopPrompt, { maxTokens: 200, timeout: 8000, category: 'exit:swing-stop' });
              if (swingText) {
                try {
                  const match = extractJSON(swingText);
                  if (match) {
                    const d = JSON.parse(match);
                    if (d.action === 'sell') {
                      console.log(`[exit] 🧠🔄🛑 CLAUDE SWING-STOP: ${trade.ticker} down ${Math.round(-swingProfit*100)}¢ — attempting sell | ${d.reasoning?.slice(0,80)}`);
                      {
                        const lh = trade.ticker.lastIndexOf('-');
                        const gb = lh > 0 ? trade.ticker.slice(0, lh) : trade.ticker;
                        const sk = ctx?.homeScore != null ? `${ctx.homeScore}-${ctx.awayScore}` : null;
                        swingExitState.set(gb, { ts: Date.now(), scoreKey: sk, exitPrice: currentPrice, reason: 'hard-stop' });
                      }
                      const result = await executeSell(trade, qty, currentPrice, 'swing-hard-stop');
                      if (result) {
                        anyUpdated = true;
                        await tg(
                          `🔄🛑 <b>SWING STOP (Claude)</b>\n\n` +
                          `${trade.title}\n` +
                          `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (${(swingProfit*100).toFixed(0)}¢)\n` +
                          `Loss: <b>$${(qty * swingProfit).toFixed(2)}</b>\n` +
                          `Claude: ${d.reasoning?.slice(0,100) ?? 'thesis failed'}`
                        );
                      }
                      continue;
                    } else {
                      console.log(`[exit] 🧠🛡️ CLAUDE HOLD swing-stop: ${trade.ticker} down ${Math.round(-swingProfit*100)}¢ — holding | ${d.reasoning?.slice(0,80)}`);
                      tradeCooldowns.set('claude-hold:' + trade.ticker, Date.now());
                      {
                        const _swOurTeam2 = (trade.ticker?.split('-').pop() ?? '').toUpperCase();
                        const _swOurWE2 = (ctx?.baselineWE != null) ? (ctx.leading === _swOurTeam2 ? ctx.baselineWE : (1 - ctx.baselineWE)) : null;
                        recordClaudeHold(trade.ticker, { ...ctx, stage }, _swOurWE2, 'swing-stop', d.reasoning);
                      }
                    }
                  }
                } catch { /* skip */ }
              }
            }
          }

          // 3. THESIS-EXPIRY: sport-aware + EV-aware
          //
          // Old rule: cut if <+8¢ after 2+ periods. Flaws:
          //  (a) For MLB, 2 innings is way too early — pitching theses reprice when
          //      starters exit (inn 5-6), so cutting Lugo at 0-0 inn 2 kills the trade
          //      while it's working.
          //  (b) Price-only check ignores live WE. If our team is still leading and
          //      live WE > current price + 3pt, the edge is alive — the market just
          //      hasn't fully repriced yet. That's the whole reason we entered.
          //
          // New rule: longer wait for MLB + only cut if price AND edge both stale.
          {
            const tkr = trade.ticker ?? '';
            const league = tkr.includes('MLB') ? 'mlb' : tkr.includes('NHL') ? 'nhl'
              : tkr.includes('NBA') ? 'nba' : 'soccer';
            const minPeriodsForExpiry = league === 'mlb' ? 4 : 2;
            // Compute our team's live WE if available — if we're leading or the
            // game state still implies our win probability > current price + 3pt,
            // don't cut. The edge is still alive; give the market time to reprice.
            let edgeStillAlive = false;
            if (ctx?.baselineWE != null) {
              const myTeam = (tkr.split('-').pop() ?? '').toUpperCase();
              const myWE = ctx.leading === myTeam ? ctx.baselineWE : (1 - ctx.baselineWE);
              if (myWE - currentPrice >= 0.03) edgeStillAlive = true;
            }
            if (periodsElapsed >= minPeriodsForExpiry && swingProfit < 0.08 && !edgeStillAlive) {
              console.log(`[exit] 🔄⏰ SWING THESIS-EXPIRY: ${trade.ticker} only +${(swingProfit*100).toFixed(0)}¢ after ${periodsElapsed} periods — attempting exit`);
              {
                const lh = trade.ticker.lastIndexOf('-');
                const gb = lh > 0 ? trade.ticker.slice(0, lh) : trade.ticker;
                const sk = ctx?.homeScore != null ? `${ctx.homeScore}-${ctx.awayScore}` : null;
                swingExitState.set(gb, { ts: Date.now(), scoreKey: sk, exitPrice: currentPrice, reason: 'thesis-expiry' });
              }
              const result = await executeSell(trade, qty, currentPrice, 'swing-thesis-expiry');
              if (result) {
                anyUpdated = true;
                await tg(
                  `🔄⏰ <b>SWING THESIS-EXPIRY</b>\n\n` +
                  `${trade.title}\n` +
                  `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (+${(swingProfit*100).toFixed(0)}¢)\n` +
                  `${swingProfit > 0 ? `Small gain: +$${(qty * swingProfit).toFixed(2)}` : `Loss: $${(qty * swingProfit).toFixed(2)}`} — ${periodsElapsed}+ periods, no momentum, WE no longer supports hold`
                );
              }
              continue;
            }
          }

          // Swing trades skip all other exit logic — they ONLY exit via the 3 paths above
          continue;
        }

        // === COMEBACK-BUY EXIT PATHS ===
        if (trade.strategy === 'comeback-buy') {
          const cbProfit = currentPrice - entryPrice;

          // 1. PROFIT-LOCK: swing thesis hit — team tied/led, price spiked, lock it.
          // Strategy was never "hold to settlement." The edge was in the mispricing at deficit,
          // not in the final outcome. Once the tie happens, it's a 50/50 coin flip.
          if (cbProfit >= 0.15) {
            const gainPct = Math.round((cbProfit / entryPrice) * 100);
            console.log(`[exit] 🔄💰 COMEBACK PROFIT-LOCK: ${trade.ticker} up ${(cbProfit*100).toFixed(0)}¢ / +${gainPct}% — selling ALL ${qty}`);
            const result = await executeSell(trade, qty, currentPrice, 'comeback-profit-lock');
            if (result) {
              anyUpdated = true;
              await tg(
                `🔄💰 <b>COMEBACK PROFIT-LOCK</b>\n\n` +
                `${trade.title}\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (+${(cbProfit*100).toFixed(0)}¢, +${gainPct}%)\n` +
                `Profit: <b>+$${(qty * cbProfit).toFixed(2)}</b>\n\n` +
                `💬 Comeback swing target hit — locked before reversal risk`
              );
            }
            continue;
          }

          // 2. SCORE-WORSENING EXIT: if the deficit grew since entry, the ace thesis broke.
          // We entered because the ace was keeping it close. If he gave up another run,
          // the original premise is gone — exit immediately, don't hold a broken thesis.
          if (trade.entryDiff != null && ctx?.diff != null && ctx.diff > trade.entryDiff) {
            const lossAmt = (qty * cbProfit).toFixed(2);
            console.log(`[exit] 🔄🛑 COMEBACK THESIS BROKEN: ${trade.ticker} deficit grew ${trade.entryDiff}→${ctx.diff} runs — exiting`);
            const result = await executeSell(trade, qty, currentPrice, 'comeback-thesis-broken');
            if (result) {
              anyUpdated = true;
              await tg(
                `🔄🛑 <b>COMEBACK THESIS BROKEN</b>\n\n` +
                `${trade.title}\n` +
                `Entry deficit: ${trade.entryDiff} run(s) → Now: ${ctx.diff} run(s)\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Now: ${(currentPrice*100).toFixed(0)}¢\n` +
                `${cbProfit >= 0 ? `Profit: +$${(qty * cbProfit).toFixed(2)}` : `Loss: $${lossAmt}`}\n\n` +
                `💬 Ace gave up more runs — thesis invalidated`
              );
            }
            continue;
          }

          // Comeback trades skip all other exit logic except nuclear and WE-reversal
          // (which have their own comeback-aware adjustments below)
          // No pre-game hard stop, no pg-guard, no WE-drop, no Claude stop.
          // Falls through to nuclear + WE-reversal below.
        }

        // === TRAILER-HOLD EXIT PATHS (2026-05-02) ===
        // Strategy: bought trailing team at 25-45¢ in inn 5-6, holding to settlement.
        // Cell-level WR is 72% but price barely moves intra-game (avg max-rec 6¢),
        // so we IGNORE all swing-exit paths. Only thesis-breakers fire here.
        if (trade.strategy === 'trailer-hold') {
          const thProfit = currentPrice - entryPrice;

          // 1. SCORE-WORSENING: deficit grew → cell thesis broken. Trail-2run cells
          // show 10-20% WR vs 72% for 1-run; the math flips the moment leader scores again.
          if (trade.entryDiff != null && ctx?.diff != null && ctx.diff > trade.entryDiff) {
            console.log(`[exit] 🎯🛑 TRAILER-HOLD THESIS BROKEN: ${trade.ticker} deficit grew ${trade.entryDiff}→${ctx.diff} runs — exiting`);
            const result = await executeSell(trade, qty, currentPrice, 'trailer-hold-thesis-broken');
            if (result) {
              anyUpdated = true;
              await tg(
                `🎯🛑 <b>TRAILER-HOLD THESIS BROKEN</b>\n\n` +
                `${trade.title}\n` +
                `Entry deficit: ${trade.entryDiff} run(s) → Now: ${ctx.diff} run(s)\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Now: ${(currentPrice*100).toFixed(0)}¢\n` +
                `${thProfit >= 0 ? `Profit: +$${(qty * thProfit).toFixed(2)}` : `Loss: $${(qty * thProfit).toFixed(2)}`}\n\n` +
                `💬 Cell flips from 72% WR (d=1) to ~15% WR (d=2+) — exit now`
              );
            }
            continue;
          }

          // 2. RARE PROFIT-LOCK at +25¢: avg max-rec is only 6¢ so this almost never
          // fires, but capture the rare blowout-equalizer case (trailer ties the game).
          if (thProfit >= 0.25) {
            const gainPct = Math.round((thProfit / entryPrice) * 100);
            console.log(`[exit] 🎯💰 TRAILER-HOLD PROFIT-LOCK: ${trade.ticker} up ${(thProfit*100).toFixed(0)}¢ / +${gainPct}% — selling ALL ${qty}`);
            const result = await executeSell(trade, qty, currentPrice, 'trailer-hold-profit-lock');
            if (result) {
              anyUpdated = true;
              await tg(
                `🎯💰 <b>TRAILER-HOLD PROFIT-LOCK</b>\n\n` +
                `${trade.title}\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (+${(thProfit*100).toFixed(0)}¢, +${gainPct}%)\n` +
                `Profit: <b>+$${(qty * thProfit).toFixed(2)}</b>\n\n` +
                `💬 Big intra-game pop captured before reversal risk`
              );
            }
            continue;
          }

          // 3. HARD STOP at -15¢: defensive backstop in case ctx.diff lags real score.
          // Entry 36¢ → 21¢ implies ESPN may not have caught a leader-team run yet.
          if (thProfit <= -0.15) {
            console.log(`[exit] 🎯🚨 TRAILER-HOLD HARD STOP: ${trade.ticker} down ${(thProfit*100).toFixed(0)}¢ — likely score change ESPN missed`);
            const result = await executeSell(trade, qty, currentPrice, 'trailer-hold-hard-stop');
            if (result) {
              anyUpdated = true;
              await tg(
                `🎯🚨 <b>TRAILER-HOLD HARD STOP</b>\n\n` +
                `${trade.title}\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Now: ${(currentPrice*100).toFixed(0)}¢\n` +
                `Loss: $${(qty * thProfit).toFixed(2)}\n\n` +
                `💬 -15¢ drawdown — defensive exit (likely score change in flight)`
              );
            }
            continue;
          }

          // Otherwise: HOLD. Skip all other exit paths (no trailing stop, no
          // bleed-out, no WE-floor, no swing-expiry). Settlement reconciler resolves.
          continue;
        }

        // === TRAIL-SWING EXIT PATHS (2026-05-02) ===
        // mlb-trail-2run-P2 cell: 20% game-WR but 50% recover ≥15¢ intra-game.
        // We MUST exit on swing — holding kills the trade. Hard rules:
        //   1. +15¢ profit-lock → sell ALL
        //   2. -10¢ hard stop → cut
        //   3. Deficit grows → thesis broken, sell
        //   4. Inning > 4 → swing window closing, exit at market
        if (trade.strategy === 'trail-swing') {
          const tsProfit = currentPrice - entryPrice;

          if (tsProfit >= 0.15) {
            const gainPct = Math.round((tsProfit / entryPrice) * 100);
            console.log(`[exit] 🔁💰 TRAIL-SWING PROFIT-LOCK: ${trade.ticker} +${(tsProfit*100).toFixed(0)}¢ / +${gainPct}% — selling ALL ${qty}`);
            const result = await executeSell(trade, qty, currentPrice, 'trail-swing-profit-lock');
            if (result) {
              anyUpdated = true;
              await tg(
                `🔁💰 <b>TRAIL-SWING PROFIT-LOCK</b>\n\n` +
                `${trade.title}\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (+${(tsProfit*100).toFixed(0)}¢, +${gainPct}%)\n` +
                `Profit: <b>+$${(qty * tsProfit).toFixed(2)}</b>\n\n` +
                `💬 +15¢ swing target hit — locked before reversal`
              );
            }
            continue;
          }

          if (tsProfit <= -0.10) {
            console.log(`[exit] 🔁🚨 TRAIL-SWING HARD STOP: ${trade.ticker} ${(tsProfit*100).toFixed(0)}¢ — cutting`);
            const result = await executeSell(trade, qty, currentPrice, 'trail-swing-hard-stop');
            if (result) {
              anyUpdated = true;
              await tg(
                `🔁🚨 <b>TRAIL-SWING HARD STOP</b>\n\n` +
                `${trade.title}\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Now: ${(currentPrice*100).toFixed(0)}¢\n` +
                `Loss: $${(qty * tsProfit).toFixed(2)}\n\n` +
                `💬 -10¢ stop — swing failed, cut`
              );
            }
            continue;
          }

          if (trade.entryDiff != null && ctx?.diff != null && ctx.diff > trade.entryDiff) {
            console.log(`[exit] 🔁🛑 TRAIL-SWING THESIS BROKEN: ${trade.ticker} deficit ${trade.entryDiff}→${ctx.diff} — exiting`);
            const result = await executeSell(trade, qty, currentPrice, 'trail-swing-thesis-broken');
            if (result) {
              anyUpdated = true;
              await tg(
                `🔁🛑 <b>TRAIL-SWING THESIS BROKEN</b>\n\n` +
                `${trade.title}\n` +
                `Entry deficit: ${trade.entryDiff} run(s) → Now: ${ctx.diff} run(s)\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Now: ${(currentPrice*100).toFixed(0)}¢\n` +
                `${tsProfit >= 0 ? `Profit: +$${(qty * tsProfit).toFixed(2)}` : `Loss: $${(qty * tsProfit).toFixed(2)}`}\n\n` +
                `💬 Deficit grew — swing window gone`
              );
            }
            continue;
          }

          if (ctx?.period != null && ctx.period > 4) {
            console.log(`[exit] 🔁⏰ TRAIL-SWING WINDOW CLOSED: ${trade.ticker} now inn${ctx.period} — selling at market`);
            const result = await executeSell(trade, qty, currentPrice, 'trail-swing-window-closed');
            if (result) {
              anyUpdated = true;
              await tg(
                `🔁⏰ <b>TRAIL-SWING WINDOW CLOSED</b>\n\n` +
                `${trade.title}\n` +
                `Now in inning ${ctx.period} — past P2 swing thesis\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢\n` +
                `${tsProfit >= 0 ? `Profit: +$${(qty * tsProfit).toFixed(2)}` : `Loss: $${(qty * tsProfit).toFixed(2)}`}`
              );
            }
            continue;
          }

          // Otherwise: hold for swing — skip all other exit paths
          continue;
        }

        // === SCORE-EVENT ARB EXIT PATHS (2026-05-02) ===
        // This strategy fires the moment a score changes. Kalshi MM lag = ~30-90s.
        // We capture the lag arb, then EXIT FAST before market reprices fully.
        // Don't hold to settlement — the edge is the lag, not the outcome.
        if (trade.strategy === 'structural-score-event-arb' || trade._structuralPattern === 'score-event-arb') {
          const seProfit = currentPrice - entryPrice;
          const tradeAgeMin = (Date.now() - new Date(trade.timestamp ?? 0).getTime()) / 60000;

          // 1. PROFIT-LOCK at +5¢: arb realized, exit immediately
          if (seProfit >= 0.05) {
            const gainPct = Math.round((seProfit / entryPrice) * 100);
            console.log(`[exit] ⚡💰 SCORE-EVENT-ARB PROFIT-LOCK: ${trade.ticker} +${(seProfit*100).toFixed(0)}¢ / +${gainPct}% — selling ALL ${qty}`);
            const result = await executeSell(trade, qty, currentPrice, 'score-event-arb-profit-lock');
            if (result) {
              anyUpdated = true;
              await tg(
                `⚡💰 <b>SCORE-EVENT-ARB PROFIT-LOCK</b>\n\n` +
                `${trade.title}\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (+${(seProfit*100).toFixed(0)}¢, +${gainPct}%)\n` +
                `Profit: <b>+$${(qty * seProfit).toFixed(2)}</b>\n\n` +
                `💬 Score-event arb captured — exit fast`
              );
            }
            continue;
          }

          // 2. TIME EXIT: if open >5 min, the arb window is closed — exit at market
          if (tradeAgeMin > 5) {
            console.log(`[exit] ⚡⏰ SCORE-EVENT-ARB TIME-EXIT: ${trade.ticker} open ${tradeAgeMin.toFixed(0)}min — arb window closed, exit at market ${(currentPrice*100).toFixed(0)}¢`);
            const result = await executeSell(trade, qty, currentPrice, 'score-event-arb-time-exit');
            if (result) {
              anyUpdated = true;
              await tg(
                `⚡⏰ <b>SCORE-EVENT-ARB TIME-EXIT</b>\n\n` +
                `${trade.title}\n` +
                `Entry: ${Math.round(entryPrice*100)}¢ → Now: ${(currentPrice*100).toFixed(0)}¢\n` +
                `${seProfit >= 0 ? `Profit: +$${(qty * seProfit).toFixed(2)}` : `Loss: $${(qty * seProfit).toFixed(2)}`}\n\n` +
                `💬 5min arb window closed — exit`
              );
            }
            continue;
          }

          // 3. HARD STOP at -8¢: defensive exit
          if (seProfit <= -0.08) {
            console.log(`[exit] ⚡🚨 SCORE-EVENT-ARB HARD STOP: ${trade.ticker} ${(seProfit*100).toFixed(0)}¢ — cutting`);
            const result = await executeSell(trade, qty, currentPrice, 'score-event-arb-hard-stop');
            if (result) {
              anyUpdated = true;
              await tg(
                `⚡🚨 <b>SCORE-EVENT-ARB HARD STOP</b>\n\n` +
                `${trade.title}\n` +
                `Loss: $${(qty * seProfit).toFixed(2)} — score-event signal failed`
              );
            }
            continue;
          }

          // Otherwise: hold for swing — skip all other exit paths
          continue;
        }

        // PRE-GAME PRICE DROP MONITOR — exit before game starts if market reprices sharply.
        // When a pre-game position's price drops 20¢+ and the game hasn't started (stage unknown),
        // it almost certainly means news broke: pitcher scratched, goalie pulled, injury, lineup change.
        //
        // HARDENED AFTER RVCESP BUG: ticker had no HHMM start time + no ESPN match, so ctx.stage
        // stayed 'unknown' even after the La Liga game kicked off. When RVC dropped 34¢ live (ESP
        // scored, price crashed), this exit fired as "pre-game news" — but it was live action.
        // Rayo later recovered to 90¢. Two hardenings:
        //   (1) require drop ≥45¢ for soccer (live swings routinely 20-30¢ in minutes; true news is 45¢+)
        //   (2) suppress when any cross-confirmed line-move fired on this ticker in the last 3 min —
        //       that velocity signature only happens during live play, not for pre-game news.
        if ((trade.strategy === 'pre-game-prediction' || trade.strategy === 'pre-game-edge-first') &&
            (ctx === null || ctx.stage === 'unknown') &&
            (currentPrice - entryPrice) <= -0.20) {
          const dropCents = Math.round((entryPrice - currentPrice) * 100);
          // Check for recent cross-confirmed line-move on this ticker = live play indicator
          const _pgExitContra = recentCrossContraMovers.get(trade.ticker);
          const _liveSignatureActive = _pgExitContra && (Date.now() - _pgExitContra.when) <= 3 * 60 * 1000;
          // Soccer-specific: require much bigger drop before assuming news
          const _pgIsSoccer = ['mls','epl','laliga','seriea','bundesliga','ligue1'].some(l => (trade.ticker ?? '').toUpperCase().includes(l.toUpperCase()));
          const _pgMinDrop = _pgIsSoccer ? 0.45 : 0.20;
          if ((currentPrice - entryPrice) > -_pgMinDrop) {
            console.log(`[exit] 🛡️ PRE-GAME DROP BLOCKED (${trade.ticker}): ${dropCents}¢ drop below ${Math.round(_pgMinDrop*100)}¢ soccer threshold — holding`);
          } else if (_liveSignatureActive) {
            console.log(`[exit] 🛡️ PRE-GAME DROP BLOCKED (${trade.ticker}): cross-confirmed ${_pgExitContra.velocity.toFixed(1)}¢/min move ${Math.round((Date.now() - _pgExitContra.when)/1000)}s ago = game is LIVE, not pre-game news — suppressing pre-game exit`);
          } else {
            console.log(`[exit] ⚠️ PRE-GAME PRICE DROP (pre-start): ${trade.ticker} dropped ${dropCents}¢ before game start — attempting exit`);
            const result = await executeSell(trade, qty, currentPrice, 'pre-game-news-exit');
            if (result) {
              anyUpdated = true;
              await tg(
                `⚠️ <b>PRE-GAME EXIT (pre-start)</b>\n\n` +
                `📋 <b>POSITION</b>\n` +
                `${trade.title}\n\n` +
                `📊 <b>METRICS</b>\n` +
                `Entry: ${Math.round((trade.entryPrice ?? 0)*100)}¢ → Exit: ${Math.round(currentPrice*100)}¢ (−${dropCents}¢)\n\n` +
                `💬 <b>REASON</b>\n` +
                `Price dropped ${dropCents}¢ before game start — likely lineup change or injury news`
              );
            }
            continue;
          }
        }

        // PARTIAL PROFIT-TAKE (live bets) — sell 25% when up ≥15¢, late game only.
        // BANKROLL-GATED: only fires at $1K+. At small bankroll, full winners
        // need to compound — leaving 17% of profit on the table costs more in
        // growth than the variance protection saves. Revisit at $1K+.
        // CAL override: if partial-take price is calibrated for this sport/playoff,
        // use (calPrice - entryPrice) as the gain trigger when lower than the 15¢ default.
        const livePartTkr = (trade.ticker ?? '').toUpperCase();
        const livePartSport = livePartTkr.includes('NBA') ? 'nba' : livePartTkr.includes('MLB') ? 'mlb'
          : livePartTkr.includes('NHL') ? 'nhl' : livePartTkr.includes('MLS') ? 'mls'
          : livePartTkr.includes('EPL') ? 'epl' : null;
        const livePartPlayoff = /Game \d/i.test(trade.title ?? '');
        const livePartCalPrice = getPartialTakePrice(livePartSport, livePartPlayoff);
        const livePartCalGain = (livePartCalPrice != null && livePartCalPrice > entryPrice)
          ? (livePartCalPrice - entryPrice) : null;
        const livePartTrigger = livePartCalGain != null ? Math.min(0.15, livePartCalGain) : 0.15;
        if (getBankroll() >= 1000 && profitPerContract >= livePartTrigger && stage === 'late' && !trade.partialTakeAt) {
          const sellQty = Math.max(1, Math.floor(qty * 0.25));
          if (qty - sellQty >= 2) {
            console.log(`[exit] 📊 PARTIAL PROFIT-TAKE (${stage}): ${trade.ticker} up ${(profitPerContract*100).toFixed(0)}¢ → selling ${sellQty} of ${qty} contracts at ${(currentPrice*100).toFixed(0)}¢ (locking ~$${(sellQty * profitPerContract).toFixed(2)}, keeping ${qty - sellQty} running)`);
            const result = await executeSell(trade, sellQty, currentPrice, 'scale-out');
            if (result) {
              trade.partialTakeAt = new Date().toISOString();
              anyUpdated = true;
            }
            continue;
          }
        }

        // PRE-GAME HARD STOP — cent-based, time-gated.
        // Swing-trade thesis: we exit at +12¢. Symmetric risk means we cut at -12¢.
        // But early game is noisy — only fire after enough game has elapsed.
        //
        // TIME GATE (raised for MLB):
        //   MLB: inning 5+ (was inning 3+) — innings 3-4 fired prematurely on ATL@PHI and STL@HOU,
        //     both games where a 1-run early deficit reversed into wins. pg-guard Claude (-35%)
        //     and WE-reversal (WE ≤ 30%) cover innings 3-4 instead.
        //   NBA: Q3+ (period 3+)  |  NHL: P2+  |  Soccer: min 60+
        //
        // CENT THRESHOLD (widened per data analysis 2026-04-23):
        //   Data: 4 pre-game hard-stop BAD stops cost us $79 in opp cost. ATL@PHI 48→35 (−13¢,
        //   team won), STL@HOU 45→33 (−12¢, team won). Both fired at 12-15¢ — the exact
        //   threshold that was costing us winners. Pre-game picks have 64% base WR; at −12¢
        //   the EV of holding is strongly positive. Widening to 25¢ gives Claude's prompts
        //   (pg-guard at −35%, nuclear, WE-reversal) room to evaluate a recoverable thesis.
        //   MLB mid-stage underdog bets keep a 30¢ threshold for extra room.
        const pgHardStopCents = (entryPrice < 0.50 && league === 'mlb' && stage === 'mid') ? 0.30
          : entryPrice < 0.50 ? 0.25
          : 0.25;
        const pgHardStopReady = (trade.strategy === 'pre-game-prediction' || trade.strategy === 'pre-game-edge-first') && (
          (league === 'mlb' && ctx?.period >= 5) ||
          (league === 'nba' && ctx?.period >= 3) ||
          (league === 'nhl' && ctx?.period >= 2) ||
          (['mls','epl','laliga','seriea','bundesliga','ligue1'].includes(league) && ctx?.period >= 60)
        );
        // MLB LATE-GAME LEAD LOCK: suppress hard stop when leading by 3+ runs in inning 7+.
        // WE ≥ 93% at 3-run inning-7 lead — game is statistically over. Price fluctuations
        // at 85-90¢ are noise. A stop-loss here would exit a near-certain win.
        const mlbBlowoutLock = league === 'mlb'
          && ctx?.period >= 7
          && profitPerContract > 0  // we are currently winning on price
          && (ctx?.diff ?? 0) >= 3; // 3+ run lead
        // CLAUDE STOP EVALUATION: when the cent-based threshold is hit, ASK Claude
        // instead of mechanically selling. Claude has live context (score, comeback rates,
        // time remaining) — the mechanical stop doesn't. This prevents premature exits
        // like BUF@BOS Game 1 where a 2-goal NHL playoff deficit in P2 was sold at -28¢
        // and BUF came back to win 4-2.
        //
        // v2 UPGRADE: Now includes (1) playoff detection, (2) original entry reasoning,
        // (3) sport-specific playoff comeback rates, (4) HOLD bias for playoff games.
        if (pgHardStopReady && !mlbBlowoutLock && (entryPrice - currentPrice) >= pgHardStopCents) {
          const hardStopKey = 'hard-stop-eval:' + trade.ticker;
          const lastHardStopEval = tradeCooldowns.get(hardStopKey) ?? 0;
          const _hardStopCd = pctChange < -0.30 ? 90 * 1000 : 5 * 60 * 1000;
          if (Date.now() - lastHardStopEval >= _hardStopCd) {
            {
              const _hsTeam = (trade.ticker?.split('-').pop() ?? '').toUpperCase();
              const _hsWE = (ctx?.baselineWE != null) ? (ctx.leading === _hsTeam ? ctx.baselineWE : (1 - ctx.baselineWE)) : null;
              const _ah = shouldAutoHold(trade.ticker, { ...ctx, stage }, _hsWE);
              if (_ah) {
                console.log(`[exit] 🧠🧘 AUTO-HOLD pg-hard-stop (memo ${_ah.ageMin}min ago from ${_ah.path}): ${trade.ticker} — skipping Claude re-eval | prev: ${_ah.reasoning}`);
                tradeCooldowns.set(hardStopKey, Date.now());
                continue;
              }
            }
            tradeCooldowns.set(hardStopKey, Date.now());
            const ticker = trade.ticker ?? '';
            const sport = ticker.includes('NBA') ? 'NBA' : ticker.includes('MLB') ? 'MLB'
              : ticker.includes('NHL') ? 'NHL' : ticker.includes('MLS') || ticker.includes('EPL')
              || ticker.includes('LALIGA') ? 'Soccer' : 'Sport';

            // Detect playoff / postseason games — Kalshi titles use "Game N:" prefix
            const isPlayoff = /Game \d/i.test(trade.title ?? '');

            // Comeback rates — REGULAR SEASON vs PLAYOFF (playoff teams fight harder, deeper rosters)
            const comebackCtx = isPlayoff ? {
              NBA: 'NBA PLAYOFFS: 10pt = 30%. 15pt = 18%. 20pt = 8%. 25+ = 2%. Playoff teams are elite — deeper rotations, coaching adjustments, and crowd energy drive bigger comebacks than regular season.',
              MLB: 'MLB PLAYOFFS: 1-run = 45%. 2-run = 30%. 3-run = 22%. Playoff teams have the deepest bullpens and most dangerous lineups. Momentum swings are sharper.',
              NHL: 'NHL PLAYOFFS: 1-goal = 35%. 2-goal = 22%. 3-goal = 8%. Playoff hockey has higher comeback rates — desperation pulls, power plays are more frequent, goalies face more high-danger shots in desperate pushes.',
              Soccer: 'CUP/KNOCKOUT: 1-goal = 25% equalize. 2-goal = 8%. Higher stakes = more aggressive tactics and substitutions.',
              Sport: 'Playoff/knockout comebacks are more frequent than regular season.',
            }[sport] ?? '' : {
              NBA: 'NBA: 10pt comeback = 25%. 15pt = 13%. 20pt = 4%. 25+ = <1%.',
              MLB: 'MLB: 1-run = 40%. 2-run = 25%. 3-run = 20% thru 6 inn. 5+ after 6th = <3%.',
              NHL: 'NHL: 1-goal = 30%. 2-goal = 15%. 3-goal = 5%. Down 3+ in 3rd = over.',
              Soccer: '1-goal = 20% equalize. 2-goal = 5%. Down 2+ after 75min = over.',
              Sport: 'Comebacks depend on deficit size and time remaining.',
            }[sport] ?? '';

            const timeLeft = sport === 'NHL' ? `${Math.max(0, 3 - (ctx?.period ?? 2))} period(s) left (~${Math.max(0, 3 - (ctx?.period ?? 2)) * 20}min)`
              : sport === 'MLB' ? `~${Math.max(0, 9 - (ctx?.period ?? 5))} innings left`
              : sport === 'NBA' ? `${Math.max(0, 4 - (ctx?.period ?? 3))} quarter(s) left (~${Math.max(0, 4 - (ctx?.period ?? 3)) * 12}min)`
              : `~${Math.max(0, 90 - (ctx?.period ?? 60))}min left`;

            // Pass original entry reasoning so Claude knows WHY we bet — thesis context prevents
            // selling when the original edge factors (goalie matchup, pitching mismatch, etc.) are still intact.
            const entryReasoning = trade.reasoning ? trade.reasoning.slice(0, 300) : '';

            // P2.3 — Late-game MLB: pull bullpen stats for both teams so Claude can reason about
            // lead-protection viability. Our biggest live-prediction losers were late-inning 1-2-run
            // leads (inn 7-9) where the bullpen blew up. The market priced bullpen risk; our WE table
            // didn't. Now the exit eval will see both bullpens' tier + ERA.
            let bullpenLine = '';
            if (sport === 'MLB' && (ctx?.period ?? 0) >= 6) {
              try {
                const _hsOurTeam = (trade.ticker?.split('-').pop() ?? '').toUpperCase();
                const _hsOurLeading = ctx?.leading === _hsOurTeam;
                const _hsOpp = _hsOurTeam === (ctx?.homeAbbr ?? '') ? (ctx?.awayAbbr ?? '') : (ctx?.homeAbbr ?? '');
                const [_ourBull, _oppBull] = await Promise.all([
                  getBullpenStats(_hsOurTeam).catch(() => null),
                  getBullpenStats(_hsOpp).catch(() => null),
                ]);
                const _ourLine = formatBullpenLine(_hsOurTeam, _ourBull);
                const _oppLine = formatBullpenLine(_hsOpp, _oppBull);
                const _ourTier = _ourBull ? bullpenTier(_ourBull) : 'unknown';
                if (_ourLine || _oppLine) {
                  bullpenLine =
                    `\n🔥 BULLPEN STATE (MLB Stats API — late-inning critical):\n` +
                    (_ourLine ? `  OUR team: ${_ourLine} — tier ${_ourTier}\n` : '') +
                    (_oppLine ? `  OPP team: ${_oppLine}\n` : '') +
                    (_hsOurLeading
                      ? `  ↑ We are LEADING. A POOR bullpen (5+ ERA) means the market correctly discounts our ${(currentPrice*100).toFixed(0)}¢ price — the 1-run lead is NOT safe. A GOOD bullpen (<3.5 ERA) means the lead should hold; price drop is noise.\n`
                      : `  ↑ We are TRAILING. Our own bullpen matters less; opponent's bullpen tier determines whether we can break through in the 8th-9th.\n`);
                }
              } catch (e) { /* bullpen optional, skip on failure */ }
            }

            const hardStopPrompt =
              `Live ${sport}${isPlayoff ? ' PLAYOFF' : ''} bet hit stop-loss threshold. Should we SELL or HOLD?\n\n` +
              `POSITION: Bought at ${(entryPrice*100).toFixed(0)}¢, now ${(currentPrice*100).toFixed(0)}¢ (down ${Math.round((entryPrice-currentPrice)*100)}¢, ${(pctChange*100).toFixed(0)}%).\n` +
              `Game: ${trade.title}\n` +
              (ctx ? `LIVE: ${ctx.detail} | Stage: ${stage.toUpperCase()} | Period: ${ctx.period}\n` : '') +
              (ctx?.baselineWE != null ? `Win expectancy: ${(((ctx.leading === (ticker.split('-').pop() ?? '')) ? ctx.baselineWE : (1 - ctx.baselineWE))*100).toFixed(0)}%\n` : '') +
              `TIME LEFT: ${timeLeft}\n\n` +
              (entryReasoning ? `ORIGINAL THESIS (why we bet): ${entryReasoning}\n` +
                `↑ Consider: is this thesis still intact? Key player still playing? Matchup edge still real?\n\n` : '') +
              bullpenLine +
              `COMEBACK RATES${isPlayoff ? ' (PLAYOFF — higher than regular season)' : ''}: ${comebackCtx}\n\n` +
              (isPlayoff
                ? `⚠️ PLAYOFF HOLD BIAS: This is a playoff game. Playoff teams are elite — they don't fold like regular-season teams. ` +
                  `Coaching adjustments between periods, deeper rotations, and crowd energy create more comebacks. ` +
                  `HOLD unless the deficit is truly insurmountable (${sport === 'NHL' ? '3+ goals in P3' : sport === 'NBA' ? '20+ pts in Q4' : sport === 'MLB' ? '4+ runs after inning 7' : '2+ goals after 80min'}).\n\n`
                : '') +
              `⚠️ BLOWUP SIGNATURE: If WE has dropped 25+ points from entry AND the opponent is currently extending their lead, this is a trajectory signal — SELL even if the deficit looks 'recoverable' on paper. Momentum and trajectory matter more than the raw scoreboard here.\n\n` +
              `DECIDE based on: (1) score deficit vs ${sport}${isPlayoff ? ' PLAYOFF' : ''} comeback rates at this stage, ` +
              `(2) time remaining, (3) is the original thesis still alive, (4) is the deficit recoverable, (5) trajectory (blowup signature above)?\n` +
              `HOLD if comeback is plausible (WE > ${isPlayoff ? '15' : '20'}%, manageable deficit, thesis intact, trajectory stable).\n` +
              `SELL if game is effectively over OR blowup signature present (large deficit late, WE < ${isPlayoff ? '10' : '15'}%, blowout with thesis dead, or opponent scored 2+ unanswered).\n\n` +
              `JSON: {"action":"sell"/"hold","reasoning":"1 sentence on comeback viability given score, time, and thesis status"}`;
            const evalText = await claudeScreen(hardStopPrompt, { maxTokens: 200, timeout: 8000, category: 'exit:hard-stop' });
            if (evalText) {
              try {
                const match = extractJSON(evalText);
                if (match) {
                  const d = JSON.parse(match);
                  if (d.action === 'sell') {
                    console.log(`[exit] 🧠🛑 CLAUDE STOP-EVAL (${stage}${isPlayoff ? '/playoff' : ''}): ${trade.ticker} down ${Math.round((entryPrice-currentPrice)*100)}¢ — selling | ${d.reasoning?.slice(0,80)}`);
                    const result = await executeSell(trade, qty, currentPrice, 'claude-hard-stop');
                    if (result) anyUpdated = true;
                    continue;
                  } else {
                    console.log(`[exit] 🧠🛡️ CLAUDE HOLD at stop (${stage}${isPlayoff ? '/playoff' : ''}): ${trade.ticker} down ${Math.round((entryPrice-currentPrice)*100)}¢ — holding | ${d.reasoning?.slice(0,80)}`);
                    tradeCooldowns.set('claude-hold:' + trade.ticker, Date.now());
                    {
                      const _hsTeam2 = (trade.ticker?.split('-').pop() ?? '').toUpperCase();
                      const _hsWE2 = (ctx?.baselineWE != null) ? (ctx.leading === _hsTeam2 ? ctx.baselineWE : (1 - ctx.baselineWE)) : null;
                      recordClaudeHold(trade.ticker, { ...ctx, stage }, _hsWE2, 'pg-hard-stop', d.reasoning);
                    }
                  }
                }
              } catch { /* skip */ }
            } else {
              console.log(`[exit] ⏳ Hard-stop threshold hit on ${trade.ticker} but Claude unavailable — deferring to next cycle`);
            }
          } else {
            console.log(`[exit] ⏳ Hard-stop threshold active on ${trade.ticker} — Claude eval cooling down (${Math.round((Date.now() - lastHardStopEval)/60000)}min ago)`);
          }
        }
        if (mlbBlowoutLock && pgHardStopReady && (entryPrice - currentPrice) >= pgHardStopCents) {
          console.log(`[exit] 🔒 MLB BLOWOUT LOCK: suppressing hard stop — inning ${ctx.period}, +${ctx.diff} run lead, WE ≥93% — holding to settlement`);
        }

        // PRE-GAME NUCLEAR — Claude-evaluated instead of mechanical.
        // DATA: 3 mechanical nuclear sells lost $59.05 total (COL -$19.55, DET -$21.30, NE -$18.20).
        // Pre-game picks win 64% when held to settlement. At -70% down, the position has already
        // lost most value — selling saves 15-18¢/contract but misses 82-85¢ upside if team wins.
        // EV of holding at 18¢ with 64% WR: 0.64×82¢ - 0.36×18¢ = +46¢. Clearly better to hold.
        // Only mechanical floor: WE ≤ 10% (true blowout, game is mathematically over).
        const isSoccerLeague = ['mls','epl','laliga'].includes(league);
        const pgNuclearFloor = (stage === 'early' && isSoccerLeague) ? -0.80
          : stage === 'early' ? -0.70
          : stage === 'mid' ? -0.60
          : -0.50;
        const pgNuclearTimeGated = ctx == null || (
          isSoccerLeague ? (ctx.period >= 2) :
          league === 'mlb' ? (ctx.period >= 5) :
          league === 'nba' ? (ctx.period >= 3) :
          league === 'nhl' ? (ctx.period >= 2) :
          true
        );
        // Extended: also run Claude-gated nuclear for LIVE trades when team is still viable.
        // Why: DAL@MIN NHL Game 3 — Claude HELD twice at -27%, then mechanical nuclear fired at -60%
        // on a tie game. Dallas won. Missed ~$38. Live-prediction/swing had no Claude-gated path;
        // they went straight to mechanical.
        const _isPGLikeNuke = (trade.strategy === 'pre-game-prediction' || trade.strategy === 'pre-game-edge-first');
        const _isLiveNuke = (trade.strategy === 'live-prediction' || trade.strategy === 'live-swing' || trade.strategy === 'live-edge' || trade.strategy === 'comeback-buy' || trade.strategy === 'draw-bet');
        const _ourTeamAbbrNuke = (trade.ticker?.split('-').pop() ?? '').toUpperCase();
        const _ourWENuke = (ctx?.baselineWE != null)
          ? (ctx.leading === _ourTeamAbbrNuke ? ctx.baselineWE : (1 - ctx.baselineWE))
          : null;
        const _liveNukeViable = _isLiveNuke && (_ourWENuke == null || _ourWENuke >= 0.15 || ctx?.diff === 0 || ctx?.leading === _ourTeamAbbrNuke);
        if ((_isPGLikeNuke || _liveNukeViable) && pctChange < pgNuclearFloor && pgNuclearTimeGated && !mlbBlowoutLock) {
          const nuclearKey = 'nuclear-eval:' + trade.ticker;
          const lastNuclearEval = tradeCooldowns.get(nuclearKey) ?? 0;
          const _nuclearCd = pctChange < -0.30 ? 90 * 1000 : 5 * 60 * 1000;
          if (Date.now() - lastNuclearEval >= _nuclearCd) {
            {
              const _ah = shouldAutoHold(trade.ticker, { ...ctx, stage }, _ourWENuke);
              if (_ah) {
                console.log(`[exit] 🧠🧘 AUTO-HOLD nuclear (memo ${_ah.ageMin}min ago from ${_ah.path}): ${trade.ticker} — skipping Claude re-eval | prev: ${_ah.reasoning}`);
                tradeCooldowns.set(nuclearKey, Date.now());
                continue;
              }
              // DEEP-DRAWDOWN HOLD: at price ≤20¢, EV math overwhelmingly favors holding.
              // Real-data: 2 of our 4 pre-game nuclear sells were BAD STOPs — COL@MIA MLB
              // sold $41→18¢ ($70 opp cost) and NE soccer sold $36→10¢ ($63 opp cost).
              // Both at ≤20¢ with recoverable WE. Claude's pessimism bias at deep drawdowns
              // treats "looks dead" as "is dead" but the math at 15¢ is:
              //   Hold EV = WE × 85¢  vs  Sell locks 15¢.  Break-even at WE=18%.
              //   Pre-game base WR = 64%, so holding at ≤20¢ is strongly +EV until WE collapses.
              if (currentPrice <= 0.20 && (_isPGLikeNuke || (_ourWENuke != null && _ourWENuke >= 0.18))) {
                console.log(`[exit] 🧘 DEEP-DRAWDOWN HOLD on ${trade.ticker}: price=${(currentPrice*100).toFixed(0)}¢ ≤20¢, WE=${_ourWENuke != null ? (_ourWENuke*100).toFixed(0)+'%' : 'pre-game 64% base'} — EV favors hold, skipping nuclear eval (WE-reversal safety net at 10% still active)`);
                tradeCooldowns.set(nuclearKey, Date.now());
                continue;
              }
            }
            tradeCooldowns.set(nuclearKey, Date.now());
            const ticker = trade.ticker ?? '';
            const sport = ticker.includes('NBA') ? 'NBA' : ticker.includes('MLB') ? 'MLB'
              : ticker.includes('NHL') ? 'NHL' : ticker.includes('MLS') || ticker.includes('EPL')
              || ticker.includes('LALIGA') ? 'Soccer' : 'Sport';
            const comebackCtx = {
              NBA: 'NBA: 10pt comeback = 25%. 15pt = 13%. 20pt = 4%. 25+ = <1%.',
              MLB: 'MLB: 1-run = 40%. 2-run = 25%. 3-run = 20% thru 6 inn. 5+ after 6th = <3%.',
              NHL: 'NHL: 1-goal = 30%. 2-goal = 15%. 3-goal = 5%. Down 3+ in 3rd = over.',
              Soccer: '1-goal = 20% equalize. 2-goal = 5%. Down 2+ after 75min = over.',
              Sport: 'Comebacks depend on deficit size and time remaining.',
            }[sport] ?? '';
            const timeLeft = sport === 'NHL' ? `${Math.max(0, 3 - (ctx?.period ?? 2))} period(s) left (~${Math.max(0, 3 - (ctx?.period ?? 2)) * 20}min)`
              : sport === 'MLB' ? `~${Math.max(0, 9 - (ctx?.period ?? 5))} innings left`
              : sport === 'NBA' ? `${Math.max(0, 4 - (ctx?.period ?? 3))} quarter(s) left (~${Math.max(0, 4 - (ctx?.period ?? 3)) * 12}min)`
              : `~${Math.max(0, 90 - (ctx?.period ?? 60))}min left`;
            // 2026-05-02: thesis-state framing. SUN soccer loss exposed that
            // generic "can team still win" prompts let Claude HOLD on equalized
            // leader bets ("Wolves can equalize" — irrelevant when we're long
            // SUN and Wolves ALREADY equalized). Force Claude to evaluate
            // whether the entry thesis specifically still holds.
            const _ourTeam = ticker.split('-').pop() ?? '';
            const _isLeader = ctx?.leading === _ourTeam;
            const _entryThesis = _isLeader
              ? `Entry thesis: ${_ourTeam} was leading at entry — we bet they'd hold the lead.`
              : `Entry thesis: ${_ourTeam} was undervalued at entry.`;
            const _thesisStatusQuestion = _isLeader
              ? `IS ${_ourTeam} STILL LEADING? If the score has equalized or ${_ourTeam} is now trailing, the original thesis is BROKEN and you should SELL even if the team can theoretically still win the game. "Game still winnable" ≠ "our entry thesis is intact."`
              : `Is the price gap that justified entry still favorable, or has the situation flipped against us?`;
            const nuclearPrompt =
              `Pre-game bet down ${(pctChange*100).toFixed(0)}%. Should we SELL or HOLD?\n\n` +
              `CRITICAL CONTEXT: Our pre-game picks win 64% of the time when held to settlement. ` +
              `At current price ${(currentPrice*100).toFixed(0)}¢, selling saves only ${(currentPrice*100).toFixed(0)}¢/contract ` +
              `but if the team wins we gain ${((1-currentPrice)*100).toFixed(0)}¢/contract. ` +
              `BIAS TOWARD HOLD unless the entry thesis has broken.\n\n` +
              `POSITION: Bought at ${(entryPrice*100).toFixed(0)}¢, now ${(currentPrice*100).toFixed(0)}¢ (down ${(pctChange*100).toFixed(0)}%).\n` +
              `Game: ${trade.title}\n` +
              (ctx ? `LIVE: ${ctx.detail} | Stage: ${stage.toUpperCase()} | Period: ${ctx.period}\n` : '') +
              (ctx?.baselineWE != null ? `Win expectancy: ${(((ctx.leading === _ourTeam) ? ctx.baselineWE : (1 - ctx.baselineWE))*100).toFixed(0)}%\n` : '') +
              `Currently leading: ${ctx?.leading ?? 'unknown'} | Our team: ${_ourTeam}\n` +
              `TIME LEFT: ${timeLeft}\n\n` +
              `${_entryThesis}\n` +
              `THESIS STATUS CHECK (mandatory): ${_thesisStatusQuestion}\n\n` +
              `COMEBACK RATES: ${comebackCtx}\n\n` +
              `⚠️ BLOWUP SIGNATURE: If the opponent has scored 2+ unanswered since the game started AND WE is deteriorating fast, trajectory > scoreboard — SELL even if deficit looks 'recoverable'. A pre-game pick whose thesis is visibly breaking (starter blown up, key scorer injured, opponent on 2+ unanswered run, leader-bet got equalized) should be sold, not held.\n\n` +
              `SELL if: entry thesis has broken (leader equalized/trailing, undervaluation reversed), WE < 10%, deficit is insurmountable, OR blowup signature present.\n` +
              `HOLD if: entry thesis is intact AND a realistic recovery path exists AND trajectory is stable/improving.\n\n` +
              `JSON: {"action":"sell"/"hold","reasoning":"1 sentence — must address whether ENTRY THESIS still holds, not just whether team can still win"}`;
            const evalText = await claudeScreen(nuclearPrompt, { maxTokens: 200, timeout: 8000, category: 'exit:nuclear' });
            if (evalText) {
              try {
                const match = extractJSON(evalText);
                if (match) {
                  const d = JSON.parse(match);
                  if (d.action === 'sell') {
                    console.log(`[exit] 🧠🛑 CLAUDE NUCLEAR (${stage}): ${trade.ticker} down ${(pctChange*100).toFixed(0)}% — selling | ${d.reasoning?.slice(0,80)}`);
                    const result = await executeSell(trade, qty, currentPrice, 'pre-game-nuclear');
                    if (result) anyUpdated = true;
                    continue;
                  } else {
                    console.log(`[exit] 🧠🛡️ CLAUDE HOLD at nuclear (${stage}): ${trade.ticker} down ${(pctChange*100).toFixed(0)}% — holding | ${d.reasoning?.slice(0,80)}`);
                    tradeCooldowns.set('claude-hold:' + trade.ticker, Date.now());
                    recordClaudeHold(trade.ticker, { ...ctx, stage }, _ourWENuke, 'nuclear', d.reasoning);
                  }
                }
              } catch { /* skip */ }
            } else {
              console.log(`[exit] ⏳ Nuclear threshold hit on ${trade.ticker} but Claude unavailable — deferring (bias: hold)`);
            }
          }
        }

        // NUCLEAR STOP — absolute floor, no Claude, just get out.
        // PRE-GAME: -90% floor only (64% WR to settlement → EV math favors long tail; Claude gates above handle non-trivial cases).
        // LIVE: -50/-60/-70 by entry price — no thesis backing, tighter floor saves capital on dead positions.
        const _isPreGameNuke = (trade.strategy === 'pre-game-prediction' || trade.strategy === 'pre-game-edge-first');
        // Claude-HOLD respect: if Claude explicitly held within last 15min AND team is still viable
        // (leading, tied, or WE ≥20%), widen the mechanical floor by 15pt. Prevents overriding a
        // thesis-aware HOLD with a price-only panic sell on a recoverable game.
        const _claudeHoldTs = tradeCooldowns.get('claude-hold:' + trade.ticker) ?? 0;
        const _claudeHoldRecent = _claudeHoldTs > 0 && (Date.now() - _claudeHoldTs) <= 15 * 60 * 1000;
        const _teamStillViable = _claudeHoldRecent && (
          _ourWENuke == null || _ourWENuke >= 0.20 || ctx?.diff === 0 || ctx?.leading === _ourTeamAbbrNuke
        );
        const _floorWiden = _teamStillViable ? -0.15 : 0;
        // Early-period variance widening (applied BEFORE claude-hold widening):
        //   NHL P1-P2: 2-goal deficits routinely price at 20-30¢ and recover (15-22% comeback).
        //     Widen every bucket to -70% floor so we don't force-sell during normal P1-P2 swings.
        //   NBA Q1-Q2: runs are fast (7-0 in 90s). 15pt mid-game deficits recover 13% of the time
        //     but reprice violently. Widen by 15pt (e.g. -60% → -75%).
        let _baseFloor = entryPrice >= 0.70 ? -0.50 : entryPrice >= 0.50 ? -0.60 : -0.70;
        let _earlyPeriodWiden = 0;
        if (league === 'nhl' && (ctx?.period ?? 0) > 0 && ctx.period <= 2) {
          _baseFloor = -0.70; // NHL P1-P2: uniform -70%
          _earlyPeriodWiden = -0.01; // sentinel so we log it
        } else if (league === 'nba' && (ctx?.period ?? 0) > 0 && ctx.period <= 2) {
          _earlyPeriodWiden = -0.15;
          _baseFloor += _earlyPeriodWiden;
        }
        const nuclearStop = _isPreGameNuke
          ? -0.90
          : _baseFloor + _floorWiden;
        const _normalFloor = entryPrice >= 0.70 ? -0.50 : entryPrice >= 0.50 ? -0.60 : -0.70;
        if (_earlyPeriodWiden !== 0 && pctChange < _normalFloor && pctChange >= nuclearStop) {
          console.log(`[exit] 🛡️ NUCLEAR WIDENED (${league.toUpperCase()} P${ctx.period} early-variance) on ${trade.ticker}: floor ${(nuclearStop*100).toFixed(0)}% vs normal ${(_normalFloor*100).toFixed(0)}%`);
        }
        if (_teamStillViable && pctChange < _normalFloor && pctChange >= nuclearStop) {
          console.log(`[exit] 🛡️ NUCLEAR WIDENED on ${trade.ticker}: Claude HOLD ${Math.round((Date.now() - _claudeHoldTs)/60000)}min ago + team viable (WE=${_ourWENuke != null ? (_ourWENuke*100).toFixed(0)+'%' : 'n/a'}, diff=${ctx?.diff ?? '?'}) → floor ${(nuclearStop*100).toFixed(0)}% vs normal ${((nuclearStop - _floorWiden)*100).toFixed(0)}%`);
        }
        if (pctChange < nuclearStop) {
          console.log(`[exit] 🛑 NUCLEAR STOP (${stage}, entry ${(entryPrice*100).toFixed(0)}¢): ${trade.ticker} down ${(pctChange*100).toFixed(0)}% (floor: ${(nuclearStop*100).toFixed(0)}%)`);
          const result = await executeSell(trade, qty, currentPrice, 'stop-loss');
          if (result) anyUpdated = true;
          continue;
        }

        // WE-REVERSAL — when the game situation has flipped against us.
        // Instead of mechanical sell, Claude evaluates with sport-specific comeback context.
        // SAFETY NET: WE ≤ 10% = mechanical sell (game is statistically over, no comeback).
        //
        // PRE-GAME EXCEPTION: Don't fire WE-REVERSAL on pre-game bets in early/mid game.
        // The Pre-Game Guardian (pg-guard) runs every 60s with full thesis-aware Claude
        // evaluation. Blunt WE-REVERSAL here would cancel positions before the thesis
        // has even been tested — e.g. COL down 2-0 in inning 2 while Weiss hasn't imploded yet.
        if (ctx?.diff > 0 && ctx.baselineWE != null) {
          const ourTeam = trade.ticker?.split('-').pop() ?? '';
          const ourWE = ctx.leading === ourTeam ? ctx.baselineWE : (1 - ctx.baselineWE);
          const isPreGame = (trade.strategy === 'pre-game-prediction' || trade.strategy === 'pre-game-edge-first');
          const isComeback = trade.strategy === 'comeback-buy';
          const entryMs = trade.timestamp ? Date.parse(trade.timestamp) : 0;
          const minsSinceEntry = entryMs ? (Date.now() - entryMs) / 60000 : 99;
          const gameIsLive = stage !== 'unknown';
          if (isPreGame && (minsSinceEntry < 30 || !gameIsLive)) {
            // Too soon or game not confirmed live — skip WE-reversal, let pg-guard handle it
          } else if (isComeback && minsSinceEntry < 15) {
            // COMEBACK GRACE PERIOD: comeback entries are at 10-44¢ with WE already low.
            // Give 15 min for the trade to breathe.
          } else if (isPreGame && league === 'mlb' && (ctx?.period ?? 0) < 5) {
            // Pre-game MLB innings 1-4: suppress WE-reversal. Data: SF@WSH BAD stop (−$47 missed)
            // fired on WE collapse mid-game with time remaining. Pre-game picks have 64% WR to
            // settlement; early-inning WE crashes on pre-game bets need room for the thesis
            // (starter fatigue, bullpen entry, lineup turn) to play out. pg-guard Claude at
            // −35% and the nuclear path still fire if drawdown is truly catastrophic.
          } else {
            const isPlayoffWER = /Game \d/i.test(trade.title ?? '');
            // Playoff games have more comebacks — lower the WE floor before we even ask Claude.
            // VGK was at 22% WE in P3 (below 30% regular floor) and came back to win.
            // CAL override: Tier 1 calibration can loosen (never tighten) the floor per-sport.
            const wer_tkr = (trade.ticker ?? '').toUpperCase();
            const wer_sport = wer_tkr.includes('NBA') ? 'nba' : wer_tkr.includes('MLB') ? 'mlb' : wer_tkr.includes('MLS') ? 'mls' : wer_tkr.includes('EPL') ? 'epl' : wer_tkr.includes('NHL') ? 'nhl' : null;
            const wer_defaults = { weFloor: isPlayoffWER ? 0.20 : 0.30, profitTake: 0.72, weDrop: isPlayoffWER ? 0.40 : 0.35 };
            const wer_cal = getCALExitThresholds(wer_sport, isPlayoffWER, wer_defaults, trade.strategy);
            const weFloor = isPreGame && stage !== 'late'
              ? (isPlayoffWER ? 0.15 : 0.20)
              : isComeback ? 0.15
              : wer_cal.weFloor;
            if (ourWE <= weFloor) {
              // MECHANICAL SAFETY NET: truly over — no Claude needed.
              // Playoff: raise to 8% (elite teams can score at 10%, VGK lesson).
              const mechanicalFloor = isPlayoffWER ? 0.08 : 0.10;
              if (ourWE <= mechanicalFloor) {
                console.log(`[exit] 🔄🛑 WE-REVERSAL SAFETY NET (${(ourWE*100).toFixed(0)}% WE ≤${Math.round(mechanicalFloor*100)}%): ${trade.ticker} — game is over, selling at ${(currentPrice*100).toFixed(0)}¢`);
                const result = await executeSell(trade, qty, currentPrice, 'stop-loss');
                if (result) anyUpdated = true;
                continue;
              }
              // Claude evaluates WE-reversal instead of auto-selling
              const weRevKey = 'we-rev-eval:' + trade.ticker;
              const lastWeRevEval = tradeCooldowns.get(weRevKey) ?? 0;
              const _weRevCd = pctChange < -0.30 ? 90 * 1000 : 5 * 60 * 1000;
              if (Date.now() - lastWeRevEval >= _weRevCd) {
                {
                  const _ah = shouldAutoHold(trade.ticker, { ...ctx, stage }, ourWE);
                  if (_ah) {
                    console.log(`[exit] 🧠🧘 AUTO-HOLD we-rev (memo ${_ah.ageMin}min ago from ${_ah.path}): ${trade.ticker} — skipping Claude re-eval | prev: ${_ah.reasoning}`);
                    tradeCooldowns.set(weRevKey, Date.now());
                    continue;
                  }
                }
                tradeCooldowns.set(weRevKey, Date.now());
                const ticker = trade.ticker ?? '';
                const sport = ticker.includes('NBA') ? 'NBA' : ticker.includes('MLB') ? 'MLB'
                  : ticker.includes('NHL') ? 'NHL' : 'Soccer';
                const playoffComebacks = isPlayoffWER ? {
                  NHL: 'NHL PLAYOFFS: 1-goal comebacks happen ~35% of the time — elite teams find ways in the third. 2-goal comebacks happen ~22%. 3-goal comebacks ~8%. 4+ goals in regulation = essentially over.',
                  NBA: 'NBA PLAYOFFS: 10pt comebacks happen ~30%. 15pt comebacks ~18%. 20pt comebacks ~8%. 25+ = 2%. Playoff intensity drives bigger swings than regular season.',
                  MLB: 'MLB PLAYOFFS: 1-run comebacks happen ~45%. 2-run comebacks ~30%. 3-run comebacks ~22% through 6 innings. Playoff bullpens are sharper but starters are also stretched harder.',
                  Soccer: 'CUP/KNOCKOUT PLAYOFFS: 1-goal deficit equalizes ~25% of the time. 2-goal deficit ~8%. Down 2+ after 75th = essentially over.',
                }[sport] ?? `PLAYOFFS: Comeback rates are meaningfully higher than regular season — teams are elite and desperate.`
                : {
                  NHL: 'NHL: 1-goal comebacks happen 30%. 2-goal comebacks ~15%. 3-goal comebacks ~5%. Down 3+ in the 3rd = essentially over.',
                  NBA: 'NBA: 15-point comebacks happen 13%. 20-point comebacks happen 4%. 25+ is essentially over (<1%).',
                  MLB: 'MLB: 3-run comebacks happen 20% through 6 innings, 10% in the 7th+. 5+ run deficit after 6th = <3%.',
                  Soccer: 'Soccer: 1-goal deficits equalize ~20%. 2-goal deficit comeback ~5%. Down 2+ after 75th = essentially over.',
                }[sport] ?? 'Comebacks get less likely as deficit grows and time runs out.';
                // 2026-05-02: thesis-state framing for WE-reversal too. Same SUN
                // soccer issue applies — bot bought a leader, leader got
                // equalized, Claude said HOLD because "team can still win".
                // Force explicit thesis-state evaluation.
                const _weRevTeam = ticker.split('-').pop() ?? '';
                const _weRevWasLeader = ctx?.leading === _weRevTeam;
                const _entryDiff = trade.entryDiff;
                const _thesisStatus = _weRevWasLeader
                  ? `Currently leading: ${ctx.leading} | Our team: ${_weRevTeam} → ${ctx.leading === _weRevTeam ? 'STILL leading ✓' : 'NO LONGER leading — thesis broken'}`
                  : `Our team: ${_weRevTeam} | Currently trailing: ${ctx.leading !== _weRevTeam}`;
                const weRevPrompt =
                  `${isPlayoffWER ? `⚠️ THIS IS A PLAYOFF GAME — comeback rates are significantly higher than regular season. APPLY A STRONG HOLD BIAS.\n\n` : ''}` +
                  `Live ${sport}${isPlayoffWER ? ' PLAYOFF' : ''} bet — win expectancy dropped to ${(ourWE*100).toFixed(0)}%. Should we SELL or HOLD?\n\n` +
                  `POSITION: Bought at ${(entryPrice*100).toFixed(0)}¢, now ${(currentPrice*100).toFixed(0)}¢.\n` +
                  `Game: ${trade.title}\n` +
                  (ctx ? `LIVE: ${ctx.detail} | Stage: ${stage.toUpperCase()} | Period: ${ctx.period}\n` : '') +
                  `Win expectancy: ${(ourWE*100).toFixed(0)}% | Score diff: ${ctx.diff}${_entryDiff != null ? ` (entered at diff ${_entryDiff})` : ''}\n` +
                  `THESIS STATUS: ${_thesisStatus}\n\n` +
                  `SPORT-SPECIFIC COMEBACK RATES:\n${playoffComebacks}\n\n` +
                  `KEY QUESTION: Is the entry thesis still intact, or has it broken? "Team can still win" ≠ "thesis intact." If we bought a leader and they're now tied/trailing, the thesis is BROKEN.\n` +
                  `⚠️ BLOWUP SIGNATURE: If opponent has scored 2+ unanswered since entry AND WE has dropped 25+ points from entry, trajectory > scoreboard — SELL. Don't fight a visible momentum shift just because the comeback rate "looks fine" on paper.\n\n` +
                  (isPlayoffWER
                    ? `HOLD unless thesis broken OR WE < 12% OR final 5 min/period with 3+ deficit OR blowup signature present. Playoff WE underestimates comeback potential, but momentum still matters.\n`
                    : `HOLD if entry thesis is intact AND deficit is recoverable AND trajectory is stable.\n`) +
                  `SELL if entry thesis has broken (leader equalized/trailing, score-diff worse than at entry by 2+) OR game effectively decided OR blowup signature present.\n\n` +
                  `JSON: {"action":"sell"/"hold","reasoning":"1 sentence — must address ENTRY THESIS state, not just whether team can still win the game"}`;
                const weText = await claudeScreen(weRevPrompt, { maxTokens: 200, timeout: 8000, category: 'exit:we-reversal' });
                if (weText) {
                  try {
                    const match = extractJSON(weText);
                    if (match) {
                      const d = JSON.parse(match);
                      if (d.action === 'sell') {
                        console.log(`[exit] 🧠🔄 CLAUDE WE-REVERSAL (${(ourWE*100).toFixed(0)}% WE): ${trade.ticker} — selling | ${d.reasoning?.slice(0,80)}`);
                        const result = await executeSell(trade, qty, currentPrice, 'stop-loss');
                        if (result) anyUpdated = true;
                        continue;
                      } else {
                        console.log(`[exit] 🧠🛡️ CLAUDE HOLD at WE-reversal (${(ourWE*100).toFixed(0)}% WE): ${trade.ticker} — holding | ${d.reasoning?.slice(0,80)}`);
                        tradeCooldowns.set('claude-hold:' + trade.ticker, Date.now());
                        recordClaudeHold(trade.ticker, { ...ctx, stage }, ourWE, 'we-reversal', d.reasoning);
                      }
                    }
                  } catch { /* skip */ }
                }
              }
            }
          }
        }

        // WE-DROP — catches slow deterioration that WE-reversal misses.
        // When WE drops ≥35pt from entry, Claude evaluates instead of auto-selling.
        // SAFETY NET: ≥50pt drop = mechanical sell (catastrophic deterioration).
        // PLAYOFF ADJUSTMENT: Raise thresholds — playoff swings are wider, comebacks more common.
        if (ctx?.baselineWE != null && trade.weAtEntry != null) {
          const ourTeam = trade.ticker?.split('-').pop() ?? '';
          const ourCurrentWE = ctx.diff === 0 ? 0.50 :
            (ctx.leading === ourTeam ? ctx.baselineWE : (1 - ctx.baselineWE));
          const weDrop = trade.weAtEntry - ourCurrentWE;
          const isPlayoffWED = /Game \d/i.test(trade.title ?? '');
          // Playoffs: require a bigger WE drop before asking Claude (40pt vs 35pt)
          // Playoff mechanical sell: 60pt drop (vs 50pt regular) — VGK-type situations need more room
          // CAL override: Tier 1 calibration can loosen the drop threshold per-sport.
          const wed_tkr = (trade.ticker ?? '').toUpperCase();
          const wed_sport = wed_tkr.includes('NBA') ? 'nba' : wed_tkr.includes('MLB') ? 'mlb' : wed_tkr.includes('MLS') ? 'mls' : wed_tkr.includes('EPL') ? 'epl' : wed_tkr.includes('NHL') ? 'nhl' : null;
          const wed_defaults = { weFloor: isPlayoffWED ? 0.20 : 0.30, profitTake: 0.72, weDrop: isPlayoffWED ? 0.40 : 0.35 };
          const wed_cal = getCALExitThresholds(wed_sport, isPlayoffWED, wed_defaults, trade.strategy);
          const wedTrigger = wed_cal.weDrop;
          const wedMechanical = Math.min(0.70, wedTrigger + (isPlayoffWED ? 0.20 : 0.15));
          if (weDrop >= wedTrigger) {
            if (weDrop >= wedMechanical) {
              console.log(`[exit] 📉🛑 WE-DROP SAFETY NET (${(weDrop*100).toFixed(0)}pt drop ≥${Math.round(wedMechanical*100)}pt${isPlayoffWED ? ' PLAYOFF' : ''}): ${trade.ticker} — catastrophic deterioration, selling at ${(currentPrice*100).toFixed(0)}¢`);
              const result = await executeSell(trade, qty, currentPrice, 'stop-loss');
              if (result) anyUpdated = true;
              continue;
            }
            // Claude evaluates the WE drop
            const weDropKey = 'we-drop-eval:' + trade.ticker;
            const lastWeDropEval = tradeCooldowns.get(weDropKey) ?? 0;
            const _weDropCd = pctChange < -0.30 ? 90 * 1000 : 5 * 60 * 1000;
            if (Date.now() - lastWeDropEval >= _weDropCd) {
              {
                const _ah = shouldAutoHold(trade.ticker, { ...ctx, stage }, ourCurrentWE);
                if (_ah) {
                  console.log(`[exit] 🧠🧘 AUTO-HOLD we-drop (memo ${_ah.ageMin}min ago from ${_ah.path}): ${trade.ticker} — skipping Claude re-eval | prev: ${_ah.reasoning}`);
                  tradeCooldowns.set(weDropKey, Date.now());
                  continue;
                }
              }
              tradeCooldowns.set(weDropKey, Date.now());
              const ticker = trade.ticker ?? '';
              const sport = ticker.includes('NBA') ? 'NBA' : ticker.includes('MLB') ? 'MLB'
                : ticker.includes('NHL') ? 'NHL' : 'Soccer';
              const weDropComebacks = isPlayoffWED ? {
                NHL: 'NHL PLAYOFFS: A 40pt WE drop from a 1-goal deficit is normal early-game variance. Elite playoff teams rally — 1-goal comebacks ~35%, 2-goal ~22%. Only sell if deficit is 3+ goals in the 3rd.',
                NBA: 'NBA PLAYOFFS: WE swings of 40pt happen on single big runs. Playoff teams have elite closers and adjust between quarters. 10pt deficit comeback ~30%, 15pt ~18%.',
                MLB: 'MLB PLAYOFFS: WE drops of 40pt on 2-run deficits are routine in the first 5 innings. Playoff lineups battle back — 2-run comeback ~30% through inning 6.',
                Soccer: 'PLAYOFF/CUP: A 40pt WE drop from 1-goal down is significant but still live — 1-goal deficit equalizes ~25% in cup play.',
              }[sport] ?? 'PLAYOFF: WE drops are more volatile and comebacks more common than regular season.'
              : {
                NHL: 'NHL: 1-goal comebacks happen 30%. 2-goal comebacks ~15%. 3-goal comebacks ~5%. Down 3+ in the 3rd = essentially over.',
                NBA: 'NBA: 15-point comebacks happen 13%. 20-point comebacks happen 4%. 25+ is essentially over (<1%).',
                MLB: 'MLB: 3-run comebacks happen 20% through 6 innings, 10% in the 7th+. 5+ run deficit after 6th = <3%.',
                Soccer: 'Soccer: 1-goal deficits equalize ~20%. 2-goal deficit comeback ~5%. Down 2+ after 75th = essentially over.',
              }[sport] ?? 'Comebacks get less likely as deficit grows and time runs out.';
              const weDropPrompt =
                `${isPlayoffWED ? `⚠️ THIS IS A PLAYOFF GAME — WE swings are normal, comeback rates are higher. Apply a HOLD bias.\n\n` : ''}` +
                `Live ${sport}${isPlayoffWED ? ' PLAYOFF' : ''} bet — WE dropped ${(weDrop*100).toFixed(0)} points (from ${(trade.weAtEntry*100).toFixed(0)}% at entry → ${(ourCurrentWE*100).toFixed(0)}% now). SELL or HOLD?\n\n` +
                `POSITION: Bought at ${(entryPrice*100).toFixed(0)}¢, now ${(currentPrice*100).toFixed(0)}¢.\n` +
                `Game: ${trade.title}\n` +
                (ctx ? `LIVE: ${ctx.detail} | Stage: ${stage.toUpperCase()} | Period: ${ctx.period}\n` : '') +
                `Current WE: ${(ourCurrentWE*100).toFixed(0)}% | Score diff: ${ctx.diff ?? '?'}\n\n` +
                `SPORT-SPECIFIC COMEBACK CONTEXT:\n${weDropComebacks}\n\n` +
                `The position has deteriorated significantly. Is recovery realistic at this stage?\n` +
                `⚠️ BLOWUP SIGNATURE: A ${(weDrop*100).toFixed(0)}pt WE drop is large. If the opponent has scored 2+ unanswered AND is currently extending the lead, this is a trajectory collapse — SELL even if the deficit "looks" recoverable on raw comeback rates. Rates assume stable game state; a team on a run is the opposite.\n\n` +
                (isPlayoffWED
                  ? `HOLD unless current WE < 15% OR final period/quarter/inning with large deficit OR blowup signature present.\n`
                  : `HOLD if deficit is still recoverable AND trajectory is stable (opponent not on a 2+ unanswered run).\n`) +
                `SELL if the WE drop reflects a real shift the team can't overcome, OR blowup signature present.\n\n` +
                `JSON: {"action":"sell"/"hold","reasoning":"1 sentence"}`;
              const dropText = await claudeScreen(weDropPrompt, { maxTokens: 200, timeout: 8000, category: 'exit:we-drop' });
              if (dropText) {
                try {
                  const match = extractJSON(dropText);
                  if (match) {
                    const d = JSON.parse(match);
                    if (d.action === 'sell') {
                      console.log(`[exit] 🧠📉 CLAUDE WE-DROP (${(weDrop*100).toFixed(0)}pt): ${trade.ticker} — selling | ${d.reasoning?.slice(0,80)}`);
                      const result = await executeSell(trade, qty, currentPrice, 'stop-loss');
                      if (result) anyUpdated = true;
                      continue;
                    } else {
                      console.log(`[exit] 🧠🛡️ CLAUDE HOLD at WE-drop (${(weDrop*100).toFixed(0)}pt): ${trade.ticker} — holding | ${d.reasoning?.slice(0,80)}`);
                      tradeCooldowns.set('claude-hold:' + trade.ticker, Date.now());
                      recordClaudeHold(trade.ticker, { ...ctx, stage }, ourCurrentWE, 'we-drop', d.reasoning);
                    }
                  }
                } catch { /* skip */ }
              }
            }
          }
        }

        // === TIER 2: Claude evaluates ALL losing positions ===
        // No more blind stop-loss. Claude sees the live score, sport context,
        // and comeback stats, then decides sell/hold. This is smarter because:
        // - NBA down 15 at halftime (45¢ from 75¢) = 13% comeback rate → often HOLD
        // - NHL down 3 goals in P2 (45¢ from 75¢) = ~5% comeback rate → usually SELL
        // Same % drop, completely different decision by sport.

        if (pctChange < thresholds.claudeStop) {
          const exitCooldownKey = 'exit-loss:' + trade.ticker;
          // Sport-specific cooldowns: NBA 8min (fastest), others 12min
          const isNBA = trade.ticker?.includes('NBA');
          const evalCooldownMs = isNBA ? 8 * 60 * 1000 : 12 * 60 * 1000;
          if (Date.now() - (tradeCooldowns.get(exitCooldownKey) ?? 0) < evalCooldownMs) continue;
          {
            const _t2Team = (trade.ticker?.split('-').pop() ?? '').toUpperCase();
            const _t2WE = (ctx?.baselineWE != null) ? (ctx.leading === _t2Team ? ctx.baselineWE : (1 - ctx.baselineWE)) : null;
            const _ah = shouldAutoHold(trade.ticker, { ...ctx, stage }, _t2WE);
            if (_ah) {
              console.log(`[exit] 🧠🧘 AUTO-HOLD tier-2 (memo ${_ah.ageMin}min ago from ${_ah.path}): ${trade.ticker} — skipping Claude re-eval | prev: ${_ah.reasoning}`);
              tradeCooldowns.set(exitCooldownKey, Date.now());
              continue;
            }
            // WE-based short-circuit: tier-2 is the widest net (pctChange threshold only).
            // Real data: tier-2 was 2-for-3 BAD stops (POR@PHX NBA at WE=65% entry, KC@DET MLB at WE=90%).
            // If our WE is still ≥30% AND opponent isn't on a visible run (no contra-velocity firing),
            // the WE-aware layers above would have flagged it if truly over. Skip Claude.
            //
            // 2026-04-29 HARD PRICE-DROP OVERRIDE: Today's TOR-CLE NBA-Q3 trade
            // collapsed -68% over 39 minutes while AUTO-HOLD repeatedly fired
            // at WE=60-66% (table baseline lagged actual game-state). Price was
            // telling the truth (54¢ → 17¢) but bot trusted stale WE.
            //
            // New rule: if down ≥20% AND price velocity ≥3¢/min adverse → exit
            // immediately. Override AUTO-HOLD. Price-action wins over WE-table
            // when both disagree by this much.
            const _drawdownDeep = pctChange <= -0.20;
            const _adverseVelocity = (() => {
              try {
                const prevSeen = lastSeenPrices.get(trade.ticker);
                if (!prevSeen) return 0;
                const elapsedMin = Math.max(0.5, (Date.now() - prevSeen.ts) / 60000);
                // For YES-side trade, adverse = price down. cents/min adverse:
                return Math.max(0, ((prevSeen.price - currentPrice) * 100) / elapsedMin);
              } catch { return 0; }
            })();
            if (_drawdownDeep && _adverseVelocity >= 3) {
              console.log(`[exit] ⚠️ HARD PRICE-DROP OVERRIDE: ${trade.ticker} down ${(pctChange*100).toFixed(0)}% with velocity ${_adverseVelocity.toFixed(1)}¢/min adverse — exiting regardless of WE=${_t2WE != null ? (_t2WE*100).toFixed(0)+'%' : '?'}`);
              // Fall through to Claude eval (which will likely sell) — don't AUTO-HOLD
            } else {
              const _contra = recentCrossContraMovers.get(trade.ticker);
              const _contraRecent = _contra && (Date.now() - _contra.when) <= 3 * 60 * 1000 && (_contra.velocity ?? 0) >= 5;
              if (_t2WE != null && _t2WE >= 0.30 && !_contraRecent) {
                console.log(`[exit] 🧘 AUTO-HOLD tier-2 (WE=${(_t2WE*100).toFixed(0)}% ≥30%, no contra): ${trade.ticker} — WE-aware layers would have flagged if truly over, skipping`);
                tradeCooldowns.set(exitCooldownKey, Date.now());
                continue;
              }
            }
          }
          tradeCooldowns.set(exitCooldownKey, Date.now());

          // Detect sport for context-specific prompt
          const ticker = trade.ticker ?? '';
          const sport = ticker.includes('NBA') ? 'NBA' : ticker.includes('MLB') ? 'MLB' :
            ticker.includes('NHL') ? 'NHL' : ticker.includes('MLS') || ticker.includes('EPL') || ticker.includes('LALIGA') ? 'Soccer' : 'Sport';

          const isPlayoffT2 = /Game \d/i.test(trade.title ?? '');

          // Sport-specific comeback context — playoff rates are higher
          const comebackContext = isPlayoffT2 ? {
            NBA: 'NBA PLAYOFFS: 10pt comebacks happen ~30%. 15pt comebacks ~18%. 20pt comebacks ~8%. 25+ = 2%. Elite playoff teams are resilient — apply a HOLD bias.',
            MLB: 'MLB PLAYOFFS: 2-run comebacks happen ~30% through 6 innings. 3-run comebacks ~22%. Playoff lineups are dangerous — apply a HOLD bias.',
            NHL: 'NHL PLAYOFFS: 1-goal comebacks happen ~35%. 2-goal comebacks ~22%. 3-goal comebacks ~8%. Playoff teams fight hard — apply a HOLD bias.',
            Soccer: 'PLAYOFF/CUP: 1-goal deficit equalizes ~25% in cup play. Very much alive with any time remaining.',
            Sport: 'PLAYOFFS: Comeback rates are meaningfully higher than regular season. Apply a HOLD bias unless the situation is truly hopeless.',
          }[sport] ?? '' : {
            NBA: 'NBA: 15-point comebacks happen 13% in the 3-point era. 20-point comebacks happen 4%. 25+ is essentially over (<1%).',
            MLB: 'MLB: 3-run comebacks happen 20% through 6 innings, 10% in the 7th+. 5+ run deficit after 6th inning = <3% comeback.',
            NHL: 'NHL: 1-goal comebacks happen 30%. 2-goal comebacks ~15%. 3-goal comebacks ~5%. Down 3+ in the 3rd = essentially over.',
            Soccer: 'Soccer: 1-goal deficits equalize ~20% of the time. 2-goal deficit comeback is ~5%. Down 2+ after 75th minute = essentially over.',
            Sport: 'Comebacks are possible but rare in large deficits late in the game.',
          }[sport] ?? '';

          const lossPrompt =
            `${isPlayoffT2 ? `⚠️ THIS IS A PLAYOFF GAME — elite teams fight back. Comeback rates are higher than regular season. Apply a STRONG HOLD BIAS unless the situation is clearly hopeless.\n\n` : ''}` +
            `You manage a live ${sport}${isPlayoffT2 ? ' PLAYOFF' : ''} bet that's DOWN. Should you SELL or HOLD?\n\n` +
            `POSITION: Bought ${trade.side?.toUpperCase()} at ${(entryPrice*100).toFixed(0)}¢. Now ${(currentPrice*100).toFixed(0)}¢ (${(pctChange*100).toFixed(0)}% loss, -$${Math.abs(qty * profitPerContract).toFixed(2)}).\n` +
            `Game: ${trade.title}\n` +
            `${ctx ? `LIVE: ${ctx.detail}\nGame stage: ${stage.toUpperCase()} | Win expectancy: ${ctx.baselineWE != null ? (((ctx.leading === (ticker.split('-').pop() ?? '')) ? ctx.baselineWE : (1 - ctx.baselineWE))*100).toFixed(0) + '% (our side)' : 'unknown'}` : 'No live data available'}\n\n` +
            `SPORT-SPECIFIC CONTEXT:\n${comebackContext}\n\n` +
            `DECISION FRAMEWORK:\n` +
            (isPlayoffT2
              ? `- If win expectancy > 15%: HOLD (playoff teams come back from here regularly)\n` +
                `- If win expectancy 8-15%: HOLD unless it's the final period/quarter and deficit is 3+\n` +
                `- If win expectancy < 8%: SELL (game is over even for playoffs)\n` +
                `- Key player injury/ejection on OUR team: SELL\n`
              : `- If win expectancy > 25%: HOLD (team still has a real shot)\n` +
                `- If win expectancy 10-25%: consider selling if it's late in the game\n` +
                `- If win expectancy < 10%: SELL (game is over)\n` +
                `- Key player injury/ejection on OUR team: SELL\n`) +
            `- Score suggests blowout but it's early: HOLD (lots of game left)\n` +
            `- ⚠️ BLOWUP SIGNATURE: opponent has scored 2+ unanswered AND is extending the lead → SELL, trajectory > scoreboard. Don't fight an active run just because comeback rates "look fine" — rates assume stable game state.\n\n` +
            `A) SELL: Lock in loss of $${Math.abs(qty * profitPerContract).toFixed(2)}. Free up $${currentPrice > 0 ? (qty * currentPrice).toFixed(2) : '0'} capital.\n` +
            `B) HOLD: If team wins → +$${(qty * (1 - entryPrice)).toFixed(2)}. If loses → -$${(qty * entryPrice).toFixed(2)}.\n\n` +
            `JSON ONLY: {"action": "sell"/"hold", "reasoning": "why"}`;

          const lossText = await claudeScreen(lossPrompt, { maxTokens: 200, timeout: 8000, category: 'exit:loss-check' });
          if (lossText) {
            try {
              const match = extractJSON(lossText);
              if (match) {
                const d = JSON.parse(match);
                if (d.action === 'sell') {
                  console.log(`[exit] 🧠 CLAUDE STOP: ${trade.ticker} ${(pctChange*100).toFixed(0)}% (${stage}) | ${d.reasoning?.slice(0, 60)}`);
                  const result = await executeSell(trade, qty, currentPrice, 'claude-stop');
                  if (result) anyUpdated = true;
                } else {
                  console.log(`[exit] 🧠 CLAUDE HOLD (losing): ${trade.ticker} ${(pctChange*100).toFixed(0)}% (${stage}) | ${d.reasoning?.slice(0, 60)}`);
                  tradeCooldowns.set('claude-hold:' + trade.ticker, Date.now());
                  {
                    const _t2Team2 = (trade.ticker?.split('-').pop() ?? '').toUpperCase();
                    const _t2WE2 = (ctx?.baselineWE != null) ? (ctx.leading === _t2Team2 ? ctx.baselineWE : (1 - ctx.baselineWE)) : null;
                    recordClaudeHold(trade.ticker, { ...ctx, stage }, _t2WE2, 'tier-2', d.reasoning);
                  }
                }
              }
            } catch { /* skip */ }
          }
          continue;
        }

        // NO CLAUDE PROFIT EVALUATION — if we're winning, we hold. Period.
        // Every Haiku call on a winner is wasted money. Let it settle at $1.

      } catch (e) { console.error(`[exit] error on ${trade.ticker}:`, e.message); }
    }

    if (anyUpdated) {
      writeFileSync(TRADES_LOG, trades.map(t => JSON.stringify(t)).join('\n') + '\n');
    }
  } catch (e) {
    console.error('[exit] error:', e.message);
  }
}

// Per-trade mutex: prevents concurrent exit paths (pg-guard + managePositions + swing-exit)
// from double-selling the same position. Second caller returns false silently.
const activeSells = new Set();

// Execute a sell order on Kalshi and update the trade record
// 2026-05-01: helper that ensures Telegram exit alerts ONLY fire after the sell
// is verified. Previously alerts (BLEED-OUT STOP, TRAILING STOP, etc.) fired
// BEFORE executeSell completed, leading to misleading notifications when sells
// failed (e.g., 0 fills). Now: sell first, alert only on success. If sell fails,
// executeSell itself sends a "0 FILLS" warning (no double-notification needed).
async function executeSellAndNotify(trade, sellQty, currentPrice, reason, tgPayload) {
  const result = await executeSell(trade, sellQty, currentPrice, reason);
  if (result) {
    // executeSell may have updated trade.realizedPnL — use the verified value
    // for the alert instead of the pre-call estimate.
    const verifiedPayload = { ...tgPayload };
    if (trade.realizedPnL != null && verifiedPayload.pnl != null) {
      verifiedPayload.pnl = trade.realizedPnL;
    }
    if (trade.exitPrice != null && verifiedPayload.exit != null) {
      verifiedPayload.exit = trade.exitPrice;
    }
    try { await tgTradeExit(verifiedPayload); } catch (e) { console.error('[exit] tg notify failed:', e.message); }
  }
  return result;
}

async function executeSell(trade, sellQty, currentPrice, reason) {
  const entryPrice = trade.entryPrice ?? 0;
  const priceInCents = Math.round(currentPrice * 100);

  if (activeSells.has(trade.id)) {
    console.log(`[exit] ⏸ SKIP duplicate sell on ${trade.ticker} (${reason}) — sell already in flight`);
    return false;
  }
  activeSells.add(trade.id);
  try {

  // POSITION GUARD: Check actual Kalshi position before selling to prevent accidental shorts.
  // If our tracked qty disagrees with Kalshi (e.g. a previous sell filled but we didn't detect it),
  // use the real Kalshi position to cap our sell qty. This prevents double-sells.
  try {
    const posCheck = await kalshiGet(`/portfolio/positions?ticker=${trade.ticker}`);
    const mktPos = (posCheck.market_positions ?? []).find(p => p.ticker === trade.ticker);
    const kalshiQty = Math.max(0, parseFloat(mktPos?.position_fp ?? '0'));
    if (kalshiQty === 0) {
      console.log(`[exit] POSITION GUARD: Kalshi shows 0 contracts for ${trade.ticker} — already sold, skipping`);
      // Mark trade as sold so we don't keep retrying
      trade.status = trade.status === 'open' ? `sold-${reason}` : trade.status;
      // Record approximate P&L at current price if not already set (prevents null P&L in trades log)
      if (trade.realizedPnL == null) {
        const approxQty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (trade.entryPrice || 1));
        trade.exitPrice = currentPrice;
        trade.realizedPnL = Math.round((currentPrice - (trade.entryPrice ?? 0)) * approxQty * 100) / 100;
        trade.settledAt = new Date().toISOString();
      }
      // Persist to JSONL so both-sides check sees the closed status
      if (existsSync(TRADES_LOG)) {
        try {
          const gLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
          const gTrades = gLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const gTrade = gTrades.find(t => t.id === trade.id);
          if (gTrade) {
            gTrade.status = trade.status;
            gTrade.exitPrice = trade.exitPrice;
            gTrade.realizedPnL = trade.realizedPnL;
            gTrade.settledAt = trade.settledAt;
            applyMFE(trade, gTrade);
            writeFileSync(TRADES_LOG, gTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
          }
        } catch (e) { console.error(`[exit] Failed to persist guard-sold status for ${trade.ticker}:`, e.message); }
      }
      return false;
    }
    if (kalshiQty < sellQty) {
      console.log(`[exit] POSITION GUARD: Kalshi has ${kalshiQty} but we wanted to sell ${sellQty} — capping to avoid short`);
      sellQty = kalshiQty;
    }
  } catch (posErr) {
    console.log(`[exit] Position check failed (${posErr.message}) — proceeding with tracked qty`);
  }

  // For stop-loss / nuclear / hard-stop: sell at 1¢ (market order — get out immediately, price doesn't matter)
  // For profit-takes / scale-outs: sell at exactly the observed price — Kalshi limit orders
  //   at the current best bid fill as taker orders immediately. The old -2¢ haircut was eating
  //   ~$0.78/trade on a 39-contract position and caused Telegram to show a different price than
  //   what Kalshi actually filled at.
  const isStopLoss = reason.includes('stop') || reason.includes('nuclear') || reason.includes('reversal');
  // 2026-04-29 BUGFIX: profit-lock sells were using currentPrice (the ask), placing
  // limit orders ABOVE the bid → orders rested unfilled. Today's STL with qty=2 fired
  // tier-1 ladder repeatedly (every cycle) because each sell at 93-95¢ never filled.
  // Step DOWN 2¢ so the limit lands at-or-below the bid → instant taker fill.
  // Mirrors the buy step-up of +2¢. Same 1-2¢ slippage cost we accept on entry.
  const sellPrice = isStopLoss ? 1 : Math.max(1, priceInCents - 2);

  const result = await kalshiPost('/portfolio/orders', {
    ticker: trade.ticker,
    action: 'sell',
    side: trade.side ?? 'yes',
    count: sellQty,
    yes_price: trade.side === 'yes' ? sellPrice : 100 - sellPrice,
  });

  if (!result.ok) {
    console.error(`[exit] Sell failed for ${trade.ticker}: ${result.status}`);
    return false;
  }

  const orderData = result.data?.order ?? result.data ?? {};
  // Kalshi returns fill_count_fp (string like "57.00"), NOT quantity_filled
  const actualFill = parseFloat(orderData.fill_count_fp) || orderData.quantity_filled || 0;
  if (actualFill === 0) {
    console.log(`[exit] Sell order accepted but 0 filled for ${trade.ticker} — position likely already sold`);
    // Re-check position. If truly absent, record exit at currentPrice so PnL
    // isn't left null — null PnL later gets overwritten to full-deployCost loss
    // by the settlement loop, which poisons calibration with overstated losses.
    let positionTrulyGone = false;
    let qtyNow = trade.quantity ?? 0;  // Initialize to expected qty
    try {
      const recheck = await kalshiGet(`/portfolio/positions?ticker=${trade.ticker}`);
      const mktPos = (recheck.market_positions ?? []).find(p => p.ticker === trade.ticker);
      qtyNow = Math.max(0, parseFloat(mktPos?.position_fp ?? '0'));
      positionTrulyGone = qtyNow === 0;
    } catch { /* keep positionTrulyGone=false on error */ }

    // 2026-04-29 BUGFIX: when fill_count_fp comes back 0 but Kalshi position has
    // ACTUALLY decreased, it means our order filled (race condition between order
    // confirm and position update). Treat as a successful partial sell.
    // CHC@SD today: bot fired tier-1 THREE TIMES because each prior fill returned
    // 0 in the response, so ladderTiersDone was never advanced. Sold 12/14 by
    // accident. Could over-sell or under-sell on a different scenario.
    const expectedQty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (trade.entryPrice || 1));
    const inferredFill = expectedQty - qtyNow;
    if (!positionTrulyGone && inferredFill > 0 && inferredFill <= sellQty) {
      // Partial fill happened — Kalshi confirmed position dropped by `inferredFill`.
      // Update trade.quantity to actual Kalshi state and compute realized P&L
      // for this partial. Return success so caller advances tier state.
      const partialProfit = (currentPrice - entryPrice) * inferredFill;
      trade.quantity = qtyNow;
      trade.partialTakeAt = trade.partialTakeAt ?? new Date().toISOString();
      // Add to running realized total
      trade.realizedPnL = Math.round(((trade.realizedPnL ?? 0) + partialProfit) * 100) / 100;
      console.log(`[exit] ✓ INFERRED PARTIAL FILL on ${trade.ticker}: response showed 0 but position dropped ${expectedQty}→${qtyNow} (filled ${inferredFill}) @ ${(currentPrice*100).toFixed(0)}¢, partial P&L $${partialProfit.toFixed(2)}`);
      // Persist updated qty + realizedPnL to JSONL
      if (existsSync(TRADES_LOG)) {
        try {
          const gLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
          const gTrades = gLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const gTrade = gTrades.find(t => t.id === trade.id);
          if (gTrade) {
            gTrade.quantity = trade.quantity;
            gTrade.partialTakeAt = trade.partialTakeAt;
            gTrade.realizedPnL = trade.realizedPnL;
            applyMFE(trade, gTrade);
            writeFileSync(TRADES_LOG, gTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
          }
        } catch (e) { console.error(`[exit] Failed to persist inferred-partial for ${trade.ticker}:`, e.message); }
      }
      return true; // success — caller advances ladder tier (finally releases lock)
    }

    if (positionTrulyGone) {
      const approxQty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (trade.entryPrice || 1));
      trade.status = `sold-${reason}`;
      trade.exitPrice = currentPrice;
      trade.realizedPnL = Math.round((currentPrice - (trade.entryPrice ?? 0)) * approxQty * 100) / 100;
      trade.settledAt = new Date().toISOString();
      if (existsSync(TRADES_LOG)) {
        try {
          const gLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
          const gTrades = gLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const gTrade = gTrades.find(t => t.id === trade.id);
          if (gTrade) {
            gTrade.status = trade.status;
            gTrade.exitPrice = trade.exitPrice;
            gTrade.realizedPnL = trade.realizedPnL;
            gTrade.settledAt = trade.settledAt;
            applyMFE(trade, gTrade);
            writeFileSync(TRADES_LOG, gTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
          }
        } catch (e) { console.error(`[exit] Failed to persist 0-fill close for ${trade.ticker}:`, e.message); }
      }
      console.log(`[exit] 0-fill reconciled: ${trade.ticker} → ${trade.status} @ ${(currentPrice*100).toFixed(0)}¢, PnL=$${trade.realizedPnL.toFixed(2)}`);
    }
    // Only alert when position is NOT gone — that's a real problem.
    // If position IS gone, the sale happened (either our order filled but fill_count_fp parse
    // returned 0, or a parallel path closed it first). Both are silent success — don't spam
    // the user with "0 FILLS" warnings on trades that actually closed cleanly.
    // The successful sale Telegram was already sent by the caller (e.g. PRE-GAME PROFIT TAKE).
    if (!positionTrulyGone) {
      await tg(
        `⚠️ <b>SELL ATTEMPTED — 0 FILLS</b>\n\n` +
        `${trade.title ?? trade.ticker}\n` +
        `Reason: ${reason}\n` +
        `Price: ${(currentPrice*100).toFixed(0)}¢ | Entry: ${Math.round(entryPrice*100)}¢\n\n` +
        `Position still present on Kalshi but order didn't fill — investigating.`
      );
      return false;
    }
    // Position gone = effective success. Return true so callers (like managePositions)
    // mark their partialTakeAt / anyUpdated flags correctly.
    return true;
  }

  const effectiveQty = Math.min(actualFill, sellQty);
  const totalQty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / entryPrice);
  const profit = (currentPrice - entryPrice) * effectiveQty;

  if (sellQty >= totalQty) {
    // Full exit
    trade.status = `sold-${reason}`;
    trade.exitPrice = currentPrice;
    trade.realizedPnL = Math.round(profit * 100) / 100;
    trade.settledAt = new Date().toISOString();
    // HC cooldown: if a high-conviction bet exited at a loss, pause HC for 24h.
    // Rare-event losses on 90%+ conf bets are a calibration signal; going back
    // bigger after one is how bad days become bad weeks.
    if (trade.highConviction && trade.realizedPnL < 0) {
      lastHCLossAt = Date.now();
      saveState();
      console.log(`[exit] 🔒 HC LOSS detected on ${trade.ticker} — HC locked for 24h`);
    }
    // Persist the sold status to TRADES_LOG so the both-sides check can detect
    // that this position was exited (journalExited flag). Without this, the JSONL
    // file still shows status:'open' and the bot blocks same-game re-entry.
    if (existsSync(TRADES_LOG)) {
      try {
        const sLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
        const sTrades = sLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const sTrade = sTrades.find(t => t.id === trade.id);
        if (sTrade) {
          sTrade.status = trade.status;
          sTrade.exitPrice = trade.exitPrice;
          sTrade.realizedPnL = trade.realizedPnL;
          sTrade.settledAt = trade.settledAt;
          applyMFE(trade, sTrade);
          writeFileSync(TRADES_LOG, sTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
        }
      } catch (e) { console.error(`[exit] Failed to persist sold status for ${trade.ticker}:`, e.message); }
    }
    // Clear gameEntries on full exit so the scale-in gate doesn't treat this as
    // a phantom live position blocking legitimate re-entries on the same game.
    {
      const lh = trade.ticker.lastIndexOf('-');
      const gb = lh > 0 ? trade.ticker.slice(0, lh) : trade.ticker;
      if (gameEntries.has(gb)) {
        gameEntries.delete(gb);
        console.log(`[exit] 🧹 Cleared gameEntries for ${gb} after full exit`);
      }
    }
    // After any stop-loss, lock out re-entry on this game for 30 min (BOTH sides).
    // Persisted in state.json so restarts don't clear the lock.
    if (isStopLoss) {
      const stoppedBase = trade.ticker.lastIndexOf('-') > 0
        ? trade.ticker.slice(0, trade.ticker.lastIndexOf('-'))
        : trade.ticker;
      // Track which team we were on — enables thesis-vindicated re-entry after lock expires
      const stoppedTeam = trade.ticker.lastIndexOf('-') > 0
        ? trade.ticker.slice(trade.ticker.lastIndexOf('-') + 1)
        : '';
      // Draw-bet stops lock ONLY the TIE contract — the opposite-side winner
      // contract is an independent thesis (often moved the exact opposite way as
      // the draw died). Winner-side stops keep game-wide locks because flipping
      // from the stopped side to the opposite winner on the same game is almost
      // always reactive emotion, not signal.
      const isDrawBet = trade.strategy === 'draw-bet';
      const lockKey = isDrawBet ? `${stoppedBase}-TIE` : stoppedBase;
      stoppedBets.set(stoppedBase, { team: stoppedTeam, stoppedAt: Date.now(), entryPrice });
      // Soccer re-entry lock shortened to 10min: soccer swings violently on goals/disallowed goals,
      // RVCESP-type scenarios (ESP scored, RVC crashed, 60s later ESP disallowed and RVC bounced to 90¢)
      // deserve faster re-entry. Other sports stay at 30min — MLB/NHL/NBA reversals are rarer and
      // 30min gives time for thesis to genuinely reset.
      const _soccerSport = ['MLS','EPL','LALIGA','SERIEA','BUNDESLIGA','LIGUE1'].some(l => stoppedBase.toUpperCase().includes(l));
      const STOP_REENTRY_COOLDOWN = _soccerSport ? 10 * 60 * 1000 : 30 * 60 * 1000;
      const unlockAt = Date.now() + STOP_REENTRY_COOLDOWN;
      stopLocks.set(lockKey, unlockAt);
      tradeCooldowns.set(lockKey, unlockAt - COOLDOWN_MS);
      saveState();
      console.log(`[exit] 🔒 Re-entry locked on ${lockKey} (${stoppedTeam}) for ${Math.round(STOP_REENTRY_COOLDOWN/60000)} min after stop (persisted)${isDrawBet ? ' — winner contracts NOT locked' : ''}`);
    }
  } else {
    // Partial exit — update quantity and cost, keep open
    const remainQty = totalQty - sellQty;
    trade.quantity = remainQty;
    trade.deployCost = Math.round(remainQty * entryPrice * 100) / 100;
    // Log the partial profit separately
    trade.partialProfitTaken = (trade.partialProfitTaken ?? 0) + Math.round(profit * 100) / 100;
    // Persist updated quantity to JSONL so the next cycle sees the correct count
    // (prevents the "Sold 13/49" display bug where stale totalQty is re-used)
    if (existsSync(TRADES_LOG)) {
      try {
        const pLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
        const pTrades = pLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const pTrade = pTrades.find(t => t.id === trade.id);
        if (pTrade) {
          pTrade.quantity = remainQty;
          pTrade.deployCost = trade.deployCost;
          pTrade.partialProfitTaken = trade.partialProfitTaken;
          writeFileSync(TRADES_LOG, pTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
        }
      } catch (e) { console.error(`[exit] Failed to persist partial qty for ${trade.ticker}:`, e.message); }
    }
  }

  const profitStr = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`;
  const icon = reason.includes('stop') ? '🛑' : reason.includes('claude') ? '🧠' : '💰';
  const label = reason === 'stop-loss' ? 'STOP-LOSS' : reason === 'profit-take' ? 'PROFIT LOCKED' :
    reason === 'scale-out' ? 'SCALED OUT (half)' : reason === 'claude-sell' ? 'SMART EXIT' :
    reason === 'claude-scale' ? 'SMART SCALE-OUT' : reason.toUpperCase();

  const exitReasonText = reason === 'stop-loss' ? 'Price hit stop-loss floor' :
    reason === 'claude-stop' ? 'Claude re-evaluated — thesis broke' :
    reason === 'profit-take' ? 'Profit target reached' :
    reason === 'scale-out' ? 'Partial scale-out' :
    reason === 'claude-sell' ? 'Claude: full exit' :
    reason === 'claude-scale' ? 'Claude: partial exit' : reason;
  await tg(
    `${icon} <b>${label}</b>\n\n` +
    `📋 <b>POSITION</b>\n` +
    `${trade.title}\n` +
    `Strategy: ${trade.strategy ?? 'live-prediction'}\n\n` +
    `📊 <b>METRICS</b>\n` +
    `${sellQty < totalQty ? `Sold ${sellQty}/${totalQty} contracts` : `Sold all ${sellQty} contracts`}\n` +
    `Entry: ${(entryPrice*100).toFixed(0)}¢ → Exit: ${(currentPrice*100).toFixed(0)}¢ (${currentPrice >= entryPrice ? '+' : ''}${((currentPrice - entryPrice)*100).toFixed(0)}¢)\n` +
    `P&L: <b>${profitStr}</b>\n` +
    `${sellQty < totalQty ? `Remaining: ${totalQty - sellQty} contracts still open` : 'Position closed'}\n\n` +
    `💬 <b>REASON</b>\n` +
    exitReasonText
  );

  logScreen({ stage: 'exit', ticker: trade.ticker, reason, sellQty, totalQty, entryPrice, exitPrice: currentPrice, profit });
  return true;
  } finally {
    activeSells.delete(trade.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement Reconciliation — update trades.jsonl with P&L on closed markets
// ─────────────────────────────────────────────────────────────────────────────

async function checkSettlements() {
  if (!existsSync(TRADES_LOG)) return;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    // Include closed-manual Kalshi trades — they may have actually settled on Kalshi
    // but the portfolio sync marked them closed-manual before settlement was written
    const openKalshi = trades.filter(t =>
      (t.status === 'open' || t.status === 'closed-manual') &&
      t.exchange === 'kalshi' &&
      t.realizedPnL == null  // only if P&L not yet recorded
    );
    const openPoly = trades.filter(t => t.status === 'open' && t.exchange === 'polymarket');
    let updated = false;

    // === POLYMARKET SETTLEMENT — check if games/fights are over via ESPN ===
    for (const trade of openPoly) {
      if (trade.status !== 'open') continue;
      try {
        // Determine sport from strategy or ticker
        const isUFC = trade.strategy === 'ufc-prediction' || (trade.ticker ?? '').includes('ufc');
        if (isUFC) {
          // UFC: check if the fight slug resolves via Poly gateway
          const slug = trade.ticker ?? '';
          try {
            const polyRes = await fetch(`https://gateway.polymarket.us/v1/markets/${slug}`, {
              headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) });
            if (polyRes.ok) {
              const polyMkt = await polyRes.json();
              if (polyMkt.closed || polyMkt.resolved) {
                // Determine winner from market sides
                const winningSide = (polyMkt.marketSides ?? []).find(s => parseFloat(s.price ?? '0') > 0.90);
                const won = winningSide && (
                  (trade.side === 'long' && winningSide === polyMkt.marketSides?.[0]) ||
                  (trade.side === 'short' && winningSide === polyMkt.marketSides?.[1])
                );
                const exitPrice = won ? 1.0 : 0.0;
                const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (trade.entryPrice || 1));
                const pnl = (qty * exitPrice) - (trade.deployCost ?? 0);
                trade.status = 'settled';
                trade.exitPrice = exitPrice;
                trade.realizedPnL = Math.round(pnl * 100) / 100;
                trade.settledAt = new Date().toISOString();
                applyMFE(trade);
                updated = true;
                const icon = pnl >= 0 ? '✅' : '❌';
                console.log(`[pnl] POLY SETTLED: ${slug} → ${won ? 'WIN' : 'LOSS'} | P&L: ${icon} $${pnl.toFixed(2)}`);
                const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
                await tgSettlement({ title: trade.title ?? slug, won, pnl, source: 'Poly' });
              }
            }
          } catch { /* skip */ }
        } else {
          // Sports on Poly: check ESPN for game result
          const slug = (trade.ticker ?? '').toLowerCase();
          let espnPath = '';
          if (slug.includes('-mlb-') || slug.includes('baseball')) espnPath = 'baseball/mlb';
          else if (slug.includes('-nba-') || slug.includes('basketball')) espnPath = 'basketball/nba';
          else if (slug.includes('-nhl-') || slug.includes('hockey')) espnPath = 'hockey/nhl';
          if (!espnPath) continue;

          try {
            const espnRes = await fetch(`http://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard`,
              { headers: { 'User-Agent': 'arbor-ai/1' }, signal: AbortSignal.timeout(5000) });
            if (!espnRes.ok) continue;
            const espnData = await espnRes.json();

            // Try to match by team names in the slug
            for (const ev of espnData.events ?? []) {
              const comp = ev.competitions?.[0];
              if (!comp || comp.status?.type?.state !== 'post') continue; // game not over
              const teams = (comp.competitors ?? []).map(c => (c.team?.abbreviation ?? '').toLowerCase());
              // Check if both teams are in the slug
              const matchesGame = teams.every(t => slug.includes(t) || slug.includes(ABBR_MAP[t.toUpperCase()]?.toLowerCase() ?? '---'));
              if (!matchesGame) continue;

              // Found the game — determine winner
              const winner = comp.competitors.find(c => c.winner);
              if (!winner) continue;
              const winAbbr = (winner.team?.abbreviation ?? '').toLowerCase();
              // Did our side win? Check if the slug and side match the winner
              const won = slug.includes(winAbbr) ? trade.side === 'long' : trade.side === 'short';
              const exitPrice = won ? 1.0 : 0.0;
              const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (trade.entryPrice || 1));
              const pnl = (qty * exitPrice) - (trade.deployCost ?? 0);
              trade.status = 'settled';
              trade.exitPrice = exitPrice;
              trade.realizedPnL = Math.round(pnl * 100) / 100;
              trade.settledAt = new Date().toISOString();
              applyMFE(trade);
              updated = true;
              const icon = pnl >= 0 ? '✅' : '❌';
              console.log(`[pnl] POLY SETTLED: ${trade.ticker} → ${won ? 'WIN' : 'LOSS'} | P&L: ${icon} $${pnl.toFixed(2)}`);
              const pnlStr2 = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
              await tg(`${icon} <b>SETTLED${won ? ' — WIN' : ' — LOSS'} (Poly)</b>\n\n<b>${trade.title ?? trade.ticker}</b>\nP&L: <b>${pnlStr2}</b>`);
              break;
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    if (openKalshi.length === 0 && !updated) return;

    // Check each open Kalshi trade directly via /markets/{ticker} — more reliable than
    // /portfolio/settlements which requires different API permissions.
    // /markets/{ticker} is already used successfully elsewhere in the bot.
    let settlements = [];
    for (const trade of openKalshi) {
      try {
        const mktData = await kalshiGet(`/markets/${trade.ticker}`);
        const market = mktData?.market ?? mktData;
        if (market?.result) {
          // Try to get actual fills for accurate P&L including fees and early sells
          let revenue = null;
          try {
            const fillsData = await kalshiGet(`/portfolio/fills?ticker=${trade.ticker}&limit=50`);
            const fills = fillsData?.fills ?? [];
            if (fills.length > 0) {
              let totalSellProceeds = 0;
              let totalBuyCost = 0;
              let buyContracts = 0;
              let sellContracts = 0;
              for (const fill of fills) {
                const count = parseFloat(fill.count_fp ?? 0);
                const fee = parseFloat(fill.fee_cost ?? 0);
                if (fill.action === "sell") {
                  const price = parseFloat(fill.yes_price_dollars ?? 0);
                  totalSellProceeds += count * price - fee;
                  sellContracts += count;
                } else if (fill.action === "buy") {
                  const price = parseFloat(fill.yes_price_dollars ?? 0);
                  totalBuyCost += count * price + fee;
                  buyContracts += count;
                }
              }
              // Auto-payout: contracts that auto-resolved at settlement without
              // generating a "sell" fill. Kalshi credits the cash on settlement
              // but /portfolio/fills only records explicit orders. Without this
              // adjustment, revenue = -deployCost on every auto-settled win
              // (e.g., ANA EDMANA 4/24 booked as -$6.11 instead of +$1.92).
              const residual = Math.max(0, buyContracts - sellContracts);
              let autoPayout = 0;
              if (residual > 0 && market.result) {
                const wonRes = (trade.side === 'yes' && market.result === 'yes') ||
                               (trade.side === 'no' && market.result === 'no');
                autoPayout = wonRes ? residual * 1.0 : 0;
              }
              if (totalSellProceeds > 0 || totalBuyCost > 0) {
                revenue = Math.round((totalSellProceeds + autoPayout - totalBuyCost) * 100) / 100;
              }
            }
          } catch { /* fills not available — fall back to quantity calc */ }
          settlements.push({
            ticker: trade.ticker,
            market_result: market.result,
            revenue,
            settled_time: market.close_time ?? null,
          });
        }
      } catch { /* market not found or not settled yet — skip */ }
    }

    // Also backfill gameOutcome for already-sold trades that don't have it yet.
    // This lets us ask "were we directionally right?" independent of whether we made money.
    const soldNeedingOutcome = trades.filter(t =>
      t.exchange === 'kalshi' &&
      t.gameOutcome == null &&
      t.status != null &&
      t.status !== 'open' &&
      t.status !== 'closed-manual' &&
      t.status !== 'testing-void' &&
      t.status !== 'failed-bug' &&
      t.status !== 'sold-sync-bug' &&
      t.realizedPnL != null // already closed — just need game result
    );
    for (const trade of soldNeedingOutcome) {
      try {
        const mktData = await kalshiGet(`/markets/${trade.ticker}`);
        const market = mktData?.market ?? mktData;
        if (!market?.result) continue;
        const won = (trade.side === 'yes' && market.result === 'yes') ||
                    (trade.side === 'no' && market.result === 'no');
        trade.gameOutcome = won ? 'correct' : 'incorrect';
        trade.gameResult = market.result;
        updated = true;
      } catch { /* market not settled yet or not found */ }
    }

    if (settlements.length === 0) {
      if (updated) {
        const newContent = trades.map(t => JSON.stringify(t)).join('\n') + '\n';
        writeFileSync(TRADES_LOG, newContent);
      }
      return;
    }

    // Build map: ticker → settlement data
    const settlementMap = new Map();
    for (const s of settlements) {
      if (s.ticker) settlementMap.set(s.ticker, s);
    }

    for (const trade of trades) {
      if ((trade.status !== 'open' && trade.status !== 'closed-manual') || trade.exchange !== 'kalshi') continue;
      if (trade.realizedPnL != null) continue;
      const settlement = settlementMap.get(trade.ticker);
      if (!settlement || !settlement.market_result) continue;

      // Skip phantom trades that were placed but never filled (e.g. pre-game resting limit orders)
      if ((trade.filled ?? 1) === 0) {
        trade.status = "testing-void";
        trade.realizedPnL = 0;
        trade.settledAt = new Date().toISOString();
        updated = true;
        console.log("[pnl] VOID (never filled): " + trade.ticker + " — market settled but we never bought");
        continue;
      }
      // P&L from Kalshi's revenue field (actual payout in cents → dollars)
      // revenue = total payout received. cost = deployCost. pnl = revenue - cost.
      // Fallback: calculate from market_result and qty if revenue is missing.
      const won = (trade.side === 'yes' && settlement.market_result === 'yes') ||
                  (trade.side === 'no' && settlement.market_result === 'no');
      const exitPrice = won ? 1.0 : 0.0;
      const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (trade.entryPrice || 1));

      // If this was already fully sold before settlement (closed-manual with partial sells),
      // use the accumulated partial P&L instead of computing from settlement qty.
      // This prevents phantom settlement P&L when position was closed mid-game.
      if (trade.status === 'closed-manual' && trade.partialTakeAt && (trade.partialProfitTaken != null)) {
        // The position was already fully exited via partial sells — settlement payout = $0
        const totalPartialProfit = trade.partialProfitTaken;
        trade.status = 'settled';
        trade.exitPrice = exitPrice;
        trade.realizedPnL = Math.round(totalPartialProfit * 100) / 100;
        trade.settledAt = settlement.settled_time ?? new Date().toISOString();
        trade.result = settlement.market_result;
        trade.gameOutcome = won ? 'correct' : 'incorrect';
        trade.gameResult = settlement.market_result;
        applyMFE(trade);
        updated = true;
        const icon = totalPartialProfit >= 0 ? '✅' : '❌';
        const pnlStr = totalPartialProfit >= 0 ? `+$${totalPartialProfit.toFixed(2)}` : `-$${Math.abs(totalPartialProfit).toFixed(2)}`;
        console.log(`[pnl] SETTLED (pre-sold): ${trade.ticker} ${trade.side} → ${settlement.market_result} | P&L: ${icon} $${totalPartialProfit.toFixed(2)} (from partial sells)`);
        await tgSettlement({ title: trade.title ?? trade.ticker, won, pnl: totalPartialProfit, source: 'Kalshi (pre-sold)' });
        continue;
      }

      // GUARD: closed-manual with no partial-take data means the position was exited
      // mid-game but we never recorded the exit price (typically 0-fill race on stop/contra).
      // The default branch below would assume full-settlement payout and compute
      // pnl = (qty * 0) - deployCost = full deployCost loss, which is WRONG — we
      // recovered cash at the mid-game exit. Trust Kalshi's revenue field if present
      // (revenue = net PnL across all fills); otherwise mark needs-reconcile and skip
      // rather than poison calibration with an overstated loss.
      if (trade.status === 'closed-manual' && trade.realizedPnL == null) {
        if (typeof settlement.revenue === 'number') {
          trade.status = 'settled';
          trade.exitPrice = exitPrice;
          trade.realizedPnL = Math.round(settlement.revenue * 100) / 100;
          trade.settledAt = settlement.settled_time ?? new Date().toISOString();
          trade.result = settlement.market_result;
          trade.gameOutcome = won ? 'correct' : 'incorrect';
          trade.gameResult = settlement.market_result;
          applyMFE(trade);
          updated = true;
          const icon = trade.realizedPnL >= 0 ? '✅' : '❌';
          console.log(`[pnl] SETTLED (closed-manual, revenue-based): ${trade.ticker} → ${settlement.market_result} | P&L: ${icon} $${trade.realizedPnL.toFixed(2)}`);
        } else {
          // BACKSTOP: Kalshi /portfolio/fills returned nothing (rare but observed —
          // MIN DENMIN 2026-04-25 stuck in needs-reconcile until manual backfill).
          // We have the game outcome and our recorded buy size. Compute P&L from
          // (qty × exitPrice) − deployCost. This is reliable when the position was
          // held to settlement (no mid-game sells we'd miss). For trades that had
          // partial sells before settlement, partialProfitTaken would be set and
          // we'd have hit the partial-take branch above, not here.
          const qty2 = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (trade.entryPrice || 1));
          const deploy2 = trade.deployCost ?? 0;
          if (qty2 > 0 && deploy2 > 0) {
            const computedPnl = qty2 * exitPrice - deploy2;
            trade.status = 'settled';
            trade.exitPrice = exitPrice;
            trade.realizedPnL = Math.round(computedPnl * 100) / 100;
            trade.settledAt = settlement.settled_time ?? new Date().toISOString();
            trade.result = settlement.market_result;
            trade.gameOutcome = won ? 'correct' : 'incorrect';
            trade.gameResult = settlement.market_result;
            applyMFE(trade);
            updated = true;
            const icon = trade.realizedPnL >= 0 ? '✅' : '❌';
            console.log(`[pnl] SETTLED (closed-manual, qty-based backstop): ${trade.ticker} → ${settlement.market_result} | P&L: ${icon} $${trade.realizedPnL.toFixed(2)}`);
          } else {
            trade.status = 'needs-reconcile';
            trade.settledAt = settlement.settled_time ?? new Date().toISOString();
            trade.result = settlement.market_result;
            trade.gameOutcome = won ? 'correct' : 'incorrect';
            trade.gameResult = settlement.market_result;
            applyMFE(trade);
            updated = true;
            console.log(`[pnl] needs-reconcile: ${trade.ticker} closed-manual with null PnL, no revenue, no usable qty/deploy — manual review needed`);
          }
        }
        continue;
      }

      // Use Kalshi's actual revenue if available (includes accurate fill count)
      // Note: revenue = totalSellProceeds - totalBuyCost — already a NET figure.
      // Do NOT subtract deployCost here: buyCost is already accounted for inside revenue.
      let pnl;
      if (settlement.revenue && settlement.revenue > 0) {
        pnl = settlement.revenue;
      } else {
        pnl = (qty * exitPrice) - (trade.deployCost ?? 0);
      }

      trade.status = 'settled';
      trade.exitPrice = exitPrice;
      trade.realizedPnL = Math.round(pnl * 100) / 100;
      trade.settledAt = settlement.settled_time ?? new Date().toISOString();
      trade.result = settlement.market_result;
      trade.gameOutcome = won ? 'correct' : 'incorrect';
      trade.gameResult = settlement.market_result;
      applyMFE(trade);
      updated = true;
      // HC cooldown on natural-settlement losses too
      if (trade.highConviction && trade.realizedPnL < 0) {
        lastHCLossAt = Date.now();
        saveState();
        console.log(`[pnl] 🔒 HC LOSS on settlement: ${trade.ticker} — HC locked for 24h`);
      }

      const icon = pnl >= 0 ? '✅' : '❌';
      console.log(`[pnl] SETTLED: ${trade.ticker} ${trade.side} → ${settlement.market_result} | P&L: ${icon} $${pnl.toFixed(2)}`);

      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      await tg(
        `${icon} <b>SETTLED — ${won ? 'WIN ✅' : 'LOSS ❌'}</b>\n\n` +
        `📋 <b>POSITION</b>\n` +
        `${trade.title ?? trade.ticker}\n` +
        `Strategy: ${trade.strategy ?? 'live-prediction'}\n\n` +
        `📊 <b>METRICS</b>\n` +
        `Bought ${trade.side?.toUpperCase()} @ ${((trade.entryPrice ?? 0)*100).toFixed(0)}¢ × ${qty} = $${((trade.entryPrice ?? 0) * qty).toFixed(2)}\n` +
        `Result: <b>${settlement.market_result?.toUpperCase()}</b>\n` +
        `P&L: <b>${pnlStr}</b> | ROI: ${((pnl / ((trade.entryPrice ?? 1) * qty)) * 100).toFixed(0)}%`
      );
    }

    if (updated) {
      // Rewrite the file with updated records
      const newContent = trades.map(t => JSON.stringify(t)).join('\n') + '\n';
      writeFileSync(TRADES_LOG, newContent);

      // Update consecutive loss tracking
      updateConsecutiveLosses();

      // Bankroll milestone check — fires when crossing $150/$200/$300/etc thresholds
      try { await checkBankrollMilestone(); } catch (e) { /* milestone is best-effort */ }

      // Strategy performance check — disable strategies with <40% win rate after 10+ trades
      const stratStats = {};
      for (const t of trades) {
        if (t.status !== 'settled' || !t.strategy) continue;
        if (!stratStats[t.strategy]) stratStats[t.strategy] = { wins: 0, losses: 0, pnl: 0 };
        if (t.realizedPnL >= 0) stratStats[t.strategy].wins++;
        else stratStats[t.strategy].losses++;
        stratStats[t.strategy].pnl += t.realizedPnL ?? 0;
      }
      for (const [strat, s] of Object.entries(stratStats)) {
        const total = s.wins + s.losses;
        const winRate = total > 0 ? s.wins / total : 0;
        if (total >= 10 && winRate < 0.40) {
          console.log(`[risk] ⚠️ Strategy "${strat}" has ${(winRate*100).toFixed(0)}% win rate over ${total} trades (P&L: $${s.pnl.toFixed(2)}). Consider disabling.`);
          await tg(`⚠️ <b>Strategy Alert</b>\n\n"${strat}" has ${(winRate*100).toFixed(0)}% win rate over ${total} trades.\nP&L: $${s.pnl.toFixed(2)}\n\nConsider disabling this strategy.`);
        }
      }
    }
  } catch (e) {
    console.error('[pnl] settlement check error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop-Loss Outcome Review — check if stop-losses were correct after games end
// ─────────────────────────────────────────────────────────────────────────────

// Stop-loss review uses trade's own `stopReviewed` field to persist across restarts
async function reviewStopLossOutcomes() {
  if (!existsSync(TRADES_LOG)) return;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Find trades that were stopped out in last 24h AND haven't been reviewed yet
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stoppedTrades = trades.filter(t =>
      (t.status === 'sold-stop-loss' || t.status === 'sold-claude-stop') &&
      t.settledAt && Date.parse(t.settledAt) > cutoff &&
      !t.stopReviewed // persisted in JSONL, survives restarts
    );
    if (stoppedTrades.length === 0) return;

    // Check each stopped trade against final game result
    for (const trade of stoppedTrades) {
      const ticker = trade.ticker ?? '';
      let league = '';
      if (ticker.includes('MLB')) league = 'mlb';
      else if (ticker.includes('NBA')) league = 'nba';
      else if (ticker.includes('NHL')) league = 'nhl';
      else if (ticker.includes('MLS')) league = 'mls';
      else if (ticker.includes('EPL')) league = 'epl';
      else if (ticker.includes('LALIGA')) league = 'laliga';
      else if (ticker.includes('SERIAA')) league = 'seriea';
      else if (ticker.includes('BUNDESLIGA')) league = 'bundesliga';
      else if (ticker.includes('LIGUE1')) league = 'ligue1';
      else continue;

      // Check if the Kalshi market has settled
      try {
        const mktData = await kalshiGet(`/markets/${ticker}`);
        const market = mktData?.market;
        if (!market || !market.result) continue; // game not over yet

        trade.stopReviewed = true; // persist in JSONL so we don't re-review after restart

        const wouldHaveWon = (trade.side === 'yes' && market.result === 'yes') ||
                            (trade.side === 'no' && market.result === 'no');

        const entryPrice = trade.entryPrice ?? 0;
        const exitPrice = trade.exitPrice ?? 0;
        const stopLoss = exitPrice - entryPrice;
        const ifHeld = wouldHaveWon ? (1 - entryPrice) : (0 - entryPrice);
        const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / (entryPrice || 1));

        const icon = wouldHaveWon ? '😤' : '✅';
        const verdict = wouldHaveWon
          ? `BAD STOP — would have WON $${(ifHeld * qty).toFixed(2)} if held`
          : `GOOD STOP — saved $${(Math.abs(ifHeld - stopLoss) * qty).toFixed(2)} vs total loss`;

        console.log(`[stop-review] ${icon} ${trade.ticker}: ${verdict}`);

        const _srSport = (trade.ticker ?? '').includes('NBA') ? '🏀 NBA' :
          (trade.ticker ?? '').includes('MLB') ? '⚾ MLB' :
          (trade.ticker ?? '').includes('NHL') ? '🏒 NHL' :
          (trade.ticker ?? '').match(/MLS|EPL|LALIGA|SERIEA|BUNDESLIGA|LIGUE1/) ? '⚽ Soccer' : 'Sport';
        const _srStopType = (trade.status ?? '').replace(/^sold-/, '');
        await tg(
          `${icon} <b>STOP-LOSS REVIEW</b>\n\n` +
          `${_srSport} · <code>${_srStopType}</code>\n` +
          `<b>${trade.title ?? trade.ticker}</b>\n` +
          `Entry: ${(entryPrice*100).toFixed(0)}¢ → Stopped at: ${(exitPrice*100).toFixed(0)}¢ · qty ${qty}\n` +
          `Game result: <b>${market.result?.toUpperCase()}</b> (we bet ${trade.side})\n\n` +
          `${wouldHaveWon ? `😤 <b>Premature stop</b> — would have won $${(ifHeld * qty).toFixed(2)}` :
            `✅ <b>Good stop</b> — avoided losing $${(Math.abs(entryPrice) * qty).toFixed(2)}`}\n` +
          `Actual loss from stop: $${Math.abs(stopLoss * qty).toFixed(2)}`
        );

        logScreen({ stage: 'stop-review', ticker: trade.ticker, wouldHaveWon, stopLoss: stopLoss * qty, ifHeld: ifHeld * qty });
      } catch (e) {
        console.error(`[stop-review] error checking ${ticker}:`, e.message);
      }
    }

    // Save updated trades (with stopReviewed flags)
    if (stoppedTrades.length > 0) {
      writeFileSync(TRADES_LOG, trades.map(t => JSON.stringify(t)).join('\n') + '\n');
    }
  } catch (e) {
    console.error('[stop-review] error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Calibration Engine — adjusts confidence thresholds based on trade history
// ─────────────────────────────────────────────────────────────────────────────

const CALIBRATION_MIN_TRADES = 50; // Need 50+ settled trades before calibrating

function runCalibration() {
  if (!existsSync(TRADES_LOG)) return;
  try {
    const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const settled = trades.filter(t => t.status === 'settled' && t.confidence != null);

    if (settled.length < CALIBRATION_MIN_TRADES) {
      console.log(`[calibrate] ${settled.length}/${CALIBRATION_MIN_TRADES} settled trades — need more data`);
      return;
    }

    // Bucket trades by confidence range and check actual win rates
    const buckets = [
      { label: '65-70%', min: 0.65, max: 0.70, wins: 0, total: 0 },
      { label: '70-75%', min: 0.70, max: 0.75, wins: 0, total: 0 },
      { label: '75-80%', min: 0.75, max: 0.80, wins: 0, total: 0 },
      { label: '80-85%', min: 0.80, max: 0.85, wins: 0, total: 0 },
      { label: '85-90%', min: 0.85, max: 0.90, wins: 0, total: 0 },
      { label: '90%+',   min: 0.90, max: 1.01, wins: 0, total: 0 },
    ];

    for (const t of settled) {
      const conf = t.confidence;
      const won = (t.realizedPnL ?? 0) > 0;
      for (const b of buckets) {
        if (conf >= b.min && conf < b.max) {
          b.total++;
          if (won) b.wins++;
          break;
        }
      }
    }

    // Build calibration report
    const reportLines = [`📊 <b>CALIBRATION REPORT</b> (${settled.length} trades)\n`];
    let overconfident = false;

    for (const b of buckets) {
      if (b.total < 3) continue; // not enough data in this bucket
      const actualWinRate = b.wins / b.total;
      const midConfidence = (b.min + b.max) / 2;
      const calibrationError = actualWinRate - midConfidence;
      const icon = Math.abs(calibrationError) < 0.05 ? '✅' : calibrationError < 0 ? '⚠️' : '💰';
      reportLines.push(`${icon} ${b.label}: predicted ${(midConfidence*100).toFixed(0)}% → actual ${(actualWinRate*100).toFixed(0)}% (${b.wins}/${b.total})`);

      // Flag if we're significantly overconfident (predicted 75%+ but winning <60%)
      if (midConfidence >= 0.75 && actualWinRate < 0.60 && b.total >= 5) overconfident = true;
    }

    // Strategy breakdown
    const stratWins = {};
    for (const t of settled) {
      const s = t.strategy ?? 'unknown';
      if (!stratWins[s]) stratWins[s] = { wins: 0, total: 0, pnl: 0 };
      stratWins[s].total++;
      if ((t.realizedPnL ?? 0) > 0) stratWins[s].wins++;
      stratWins[s].pnl += t.realizedPnL ?? 0;
    }
    reportLines.push('\n<b>By Strategy:</b>');
    for (const [strat, s] of Object.entries(stratWins)) {
      reportLines.push(`  ${strat}: ${(s.wins/s.total*100).toFixed(0)}% win (${s.wins}/${s.total}) | P&L: $${s.pnl.toFixed(2)}`);
    }

    if (overconfident) {
      reportLines.push('\n⚠️ <b>OVERCONFIDENT</b> — actual wins significantly below predicted. Consider raising MIN_CONFIDENCE.');
    }

    console.log(`[calibrate] Report: ${settled.length} trades, ${buckets.filter(b => b.total >= 3).length} buckets with data`);
    tg(reportLines.join('\n'));

    logScreen({ stage: 'calibration', settledCount: settled.length, buckets: buckets.filter(b => b.total > 0) });
  } catch (e) {
    console.error('[calibrate] error:', e.message);
  }
}

function logStats() {
  // Include P&L summary in stats
  let totalPnL = 0;
  let settledCount = 0;
  if (existsSync(TRADES_LOG)) {
    try {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          if (t.status === 'settled' && t.realizedPnL != null) {
            totalPnL += t.realizedPnL;
            settledCount++;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(2)}` : `-$${Math.abs(totalPnL).toFixed(2)}`;
  const apiSpend = (stats.apiSpendCents / 100).toFixed(2);
  console.log(`[ai-stats] claude=${stats.claudeCalls} trades=${stats.tradesPlaced} api=$${apiSpend} bal=$${kalshiBalance.toFixed(2)} poly=$${polyBalance.toFixed(2)} pnl=${pnlStr} (${settledCount} settled)`);
}

async function main() {
  console.log('=== Arbor AI Edge Trading Bot ===');

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

  console.log(`Config: MIN_CONF=${(MIN_CONFIDENCE*100).toFixed(0)}% MARGIN=${(CONFIDENCE_MARGIN*100).toFixed(0)}% MAX_PRICE=${(MAX_PRICE*100).toFixed(0)}¢ MAX_TRADE=$${getDynamicMaxTrade().toFixed(2)} BANKROLL=$${getBankroll().toFixed(2)}`);

  // Initial poll, then chain with setTimeout (prevents overlap)
  async function pollLoop() {
    try { await pollCycle(); } catch (e) { console.error('[poll] error:', e.message); }
    setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
  await pollLoop();

  // Stats on a separate non-overlapping chain
  async function statsLoop() {
    logStats();
    saveState();
    setTimeout(statsLoop, 5 * 60 * 1000);
  }

  // LOSING-STREAK DETECTOR: scans recent settled trades for any (sport, strategy) bucket
  // that has gone cold — 5+ consecutive losses or <30% WR over 10+ recent trades. Alerts
  // via Telegram so we can investigate systematic bias. Not auto-freeze — that's a
  // separate design decision (P3.2 Wilson-CI auto-freeze).
  // De-duplicates alerts per bucket per 6h.
  const losingStreakAlertMemo = new Map(); // bucket key -> last alert ts
  async function checkLosingStreak() {
    if (!existsSync(TRADES_LOG)) return;
    try {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      const settled = [];
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          if (t.realizedPnL == null || !t.gameOutcome) continue;
          if (!t.strategy || !t.ticker) continue;
          settled.push(t);
        } catch {}
      }
      // Group by sport+strategy
      const buckets = new Map();
      for (const t of settled) {
        const sport = (t.ticker ?? '').includes('NBA') ? 'NBA' :
          (t.ticker ?? '').includes('MLB') ? 'MLB' :
          (t.ticker ?? '').includes('NHL') ? 'NHL' :
          (t.ticker ?? '').match(/MLS|EPL|LALIGA|SERIEA|BUNDESLIGA|LIGUE1/) ? 'Soccer' : 'Other';
        const key = `${sport}:${t.strategy}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(t);
      }
      for (const [key, trades] of buckets) {
        if (trades.length < 5) continue;
        const recent = trades.slice(-10);
        const wins = recent.filter(t => t.gameOutcome === 'correct').length;
        const losses = recent.filter(t => t.gameOutcome === 'incorrect').length;
        const wr = wins / recent.length;
        const recentPnL = recent.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
        // Check consecutive-loss streak at the tail
        let streak = 0;
        for (let i = trades.length - 1; i >= 0; i--) {
          if (trades[i].gameOutcome === 'incorrect') streak++;
          else break;
        }
        const alertKey = `streak-alert:${key}`;
        const lastAlertMs = losingStreakAlertMemo.get(alertKey) ?? 0;
        if (Date.now() - lastAlertMs < 6 * 3600 * 1000) continue; // 6h dedup
        // Trigger conditions
        const isStreakAlarm = streak >= 5;
        const isWRAlarm = recent.length >= 10 && wr < 0.30;
        if (isStreakAlarm || isWRAlarm) {
          losingStreakAlertMemo.set(alertKey, Date.now());
          const icon = isStreakAlarm ? '🧊' : '📉';
          const headline = isStreakAlarm
            ? `${streak} LOSSES IN A ROW`
            : `WR ${Math.round(wr*100)}% last ${recent.length}`;
          const lastPicks = trades.slice(-Math.min(8, trades.length)).map(t => {
            const team = (t.ticker ?? '').split('-').pop();
            const o = t.gameOutcome === 'correct' ? '✓' : '✗';
            return `${team}${o}`;
          }).join(' ');
          console.log(`[streak] ${icon} ${key}: ${headline} | recent P&L $${recentPnL.toFixed(2)} | ${lastPicks}`);
          await tg(
            `${icon} <b>LOSING-STREAK ALERT</b>\n\n` +
            `<b>${key}</b>: ${headline}\n` +
            `Last 10 WR: ${wins}-${losses} (${Math.round(wr*100)}%)\n` +
            `Last 10 P&L: $${recentPnL.toFixed(2)}\n` +
            `Last picks: ${lastPicks}\n\n` +
            `💡 Systematic bias likely — investigate prompt / freeze bucket?`
          );
        }
      }
    } catch (e) {
      console.error('[streak] scan error:', e.message);
    }
  }
  setTimeout(statsLoop, 5 * 60 * 1000);

  // CALIBRATION STATS — aggregates all settled trades by (sport × strategy × edge-band ×
  // conf-band). Writes to logs/calibration-stats.json every 10min and emits a Telegram
  // digest once per day (first cycle after 09:00 ET). Enables per-sport bucket analysis
  // without hardcoding rules — we can eyeball the data + act when samples > 15 per cell.
  const _lastDigestDateKey = { value: '' };
  async function updateCalibrationStats() {
    if (!existsSync(TRADES_LOG)) return;
    try {
      const lines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      const settled = [];
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          if (t.realizedPnL == null || !t.gameOutcome) continue;
          if (!t.strategy || !t.ticker) continue;
          settled.push(t);
        } catch {}
      }
      const sportOf = (tk) => tk.includes('NBA') ? 'NBA' : tk.includes('MLB') ? 'MLB'
        : tk.includes('NHL') ? 'NHL' : tk.match(/MLS|EPL|LALIGA|SERIEA|BUNDESLIGA|LIGUE1/) ? 'Soccer' : 'Other';
      const edgeBand = (edge) => edge < 0.05 ? '<5pt' : edge < 0.10 ? '5-9pt' : edge < 0.15 ? '10-14pt' : edge < 0.20 ? '15-19pt' : '20+pt';
      const confBand = (c) => c < 0.60 ? '<60%' : c < 0.65 ? '60-64%' : c < 0.70 ? '65-69%' : c < 0.75 ? '70-74%' : c < 0.80 ? '75-79%' : '80%+';

      // Position-level aggregation: collapse multiple bets on the same ticker
      // (e.g. SAS@POR pre-game $4.03 win + live $3.12 nuclear loss = one POR
      // position +$0.91). Matches the dedupe-to-first behavior in
      // computeCalibrationFeedback, but ALSO sums P&L across the position so
      // dashboard rows reflect total $ in/out per team-game. Bucket assignment
      // uses the earliest trade's confidence/strategy (canonical thesis read);
      // MFE = max across trades in position; gameOutcome = earliest's (all
      // trades in a position share the same underlying game outcome).
      const positionMap = new Map();
      for (const t of settled) {
        const key = t.ticker ?? '';
        const existing = positionMap.get(key);
        if (!existing) {
          positionMap.set(key, {
            earliest: t,
            totalPnL: t.realizedPnL ?? 0,
            maxMFE: t.maxFavorableMove ?? null,
            tradeCount: 1,
          });
        } else {
          existing.totalPnL += (t.realizedPnL ?? 0);
          existing.tradeCount++;
          if (t.maxFavorableMove != null) {
            existing.maxMFE = existing.maxMFE != null
              ? Math.max(existing.maxMFE, t.maxFavorableMove)
              : t.maxFavorableMove;
          }
          const tTs = new Date(t.timestamp ?? t.settledAt).getTime();
          const eTs = new Date(existing.earliest.timestamp ?? existing.earliest.settledAt).getTime();
          if (tTs < eTs) existing.earliest = t;
        }
      }
      const positions = [...positionMap.values()].map(p => ({
        ...p.earliest,
        realizedPnL: Math.round(p.totalPnL * 100) / 100,
        maxFavorableMove: p.maxMFE,
        positionTradeCount: p.tradeCount,
      }));

      const buckets = new Map();
      for (const t of positions) {
        const sport = sportOf(t.ticker ?? '');
        const strat = t.strategy ?? 'unknown';
        const edge = (t.confidence ?? 0) - (t.entryPrice ?? 0);
        const ebd = edgeBand(edge);
        const cbd = confBand(t.confidence ?? 0);
        const key = `${sport}|${strat}|${ebd}|${cbd}`;
        if (!buckets.has(key)) buckets.set(key, { sport, strategy: strat, edge: ebd, conf: cbd, n: 0, wins: 0, losses: 0, pnl: 0, pmHits: 0, pmTracked: 0 });
        const b = buckets.get(key);
        b.n++;
        if (t.gameOutcome === 'correct') b.wins++;
        else if (t.gameOutcome === 'incorrect') b.losses++;
        b.pnl += (t.realizedPnL ?? 0);
        // Price-move tracking — only when MFE was recorded (trades placed before
        // 2026-04-25 have null maxFavorableMove and are excluded from pmTracked).
        if (t.maxFavorableMove != null) {
          b.pmTracked++;
          if (t.maxFavorableMove >= 0.05) b.pmHits++;
        }
      }
      const rows = Array.from(buckets.values()).map(b => ({
        ...b,
        wr: b.n > 0 ? Math.round(b.wins / b.n * 100) : 0,
        pnl: Math.round(b.pnl * 100) / 100,
        pnlPerTrade: b.n > 0 ? Math.round(b.pnl / b.n * 100) / 100 : 0,
        priceMoveWR: b.pmTracked > 0 ? Math.round(b.pmHits / b.pmTracked * 100) : null,
      })).sort((a, b) => b.n - a.n);

      const calPath = './logs/calibration-stats.json';
      try {
        writeFileSync(calPath, JSON.stringify({
          updatedAt: new Date().toISOString(),
          totalSettled: settled.length,        // raw trade count
          totalPositions: positions.length,    // position-aggregated count (multi-trade theses collapsed)
          buckets: rows,
        }, null, 2));
      } catch (e) { console.log(`[cal-stats] write error: ${e.message}`); }

      // Daily digest: once per ET day after 09:00. Finds worst + best buckets with ≥5 trades.
      const etH = etHour();
      const todayKey = etTodayStr();
      if (etH >= 9 && _lastDigestDateKey.value !== todayKey) {
        _lastDigestDateKey.value = todayKey;
        const significant = rows.filter(r => r.n >= 5);
        if (significant.length > 0) {
          const worst = [...significant].sort((a, b) => a.pnl - b.pnl).slice(0, 3);
          const best = [...significant].sort((a, b) => b.pnl - a.pnl).slice(0, 3);
          const fmt = (r) => `${r.sport} ${r.strategy.replace('pre-game-','pg-').replace('live-','lv-')}\n   ${r.edge} × ${r.conf}: ${r.n}n, ${r.wr}% WR, $${r.pnl.toFixed(0)}`;
          const totalPnL = rows.reduce((s, r) => s + r.pnl, 0);
          console.log(`[cal-stats] Daily digest: ${settled.length} settled, net $${totalPnL.toFixed(2)}`);

          // CLV breakout — overall + per-strategy (bonus C). Surfaces whether each
          // strategy is actually beating the closing line. Industry threshold:
          // +2¢ avg = winning bettor, +5¢ = elite, ≤+1¢ = edge is illusory.
          const clv7 = getClvStats({ days: 7 });
          let clvSection = '';
          if (clv7?.all && clv7.all.n >= 5) {
            const fmtClv = (s) => {
              const c = Math.round(s.avgClv * 100);
              const sign = c >= 0 ? '+' : '';
              const beat = Math.round(s.beatPct * 100);
              const grade = c >= 5 ? '🏆' : c >= 2 ? '🟢' : c >= 0 ? '🟡' : '🔴';
              return `${grade} ${sign}${c}¢ avg · ${beat}% beat close · n=${s.n}`;
            };
            clvSection = `\n\n📐 <b>7d CLV — overall</b>\n${fmtClv(clv7.all)}`;
            const stratEntries = Object.entries(clv7.byStrategy)
              .sort(([,a],[,b]) => b.avgClv - a.avgClv);
            if (stratEntries.length > 0) {
              clvSection += `\n\n📐 <b>7d CLV — by strategy</b>\n` +
                stratEntries.map(([s, st]) => `• <code>${s.replace('pre-game-','pg-')}</code>: ${fmtClv(st)}`).join('\n');
            }
          }

          // 2026-05-02: daily calibration digest Telegram disabled per user request.
          // Stats still written to logs/calibration-stats.json + console-logged.
          // Re-enable by un-commenting tg() below if needed.
          // await tg(
          //   `📊 <b>DAILY CALIBRATION DIGEST</b>\n` +
          //   `${settled.length} settled · total P&L $${totalPnL.toFixed(2)}\n\n` +
          //   `🟢 <b>BEST BUCKETS (n≥5)</b>\n` +
          //   best.map(fmt).join('\n') + '\n\n' +
          //   `🔴 <b>WORST BUCKETS (n≥5)</b>\n` +
          //   worst.map(fmt).join('\n') +
          //   clvSection + '\n\n' +
          //   `📁 Full stats: logs/calibration-stats.json`
          // );
          void best; void worst; void clvSection; void totalPnL;
        }
      }
    } catch (e) {
      console.error('[cal-stats] scan error:', e.message);
    }
  }

  // Settlement reconciliation + stop-loss review — every 90s (was 5 min)
  // 2026-04-29: speed up to capture fast profit-lock opportunities. NYY-TEX hit
  // +15¢ ladder threshold at 16:43 but ladder didn't fire until 16:46 (3-min lag)
  // because managePositions was on 5-min cycle. Swing trades need faster reaction.
  async function settlementLoop() {
    try { await managePositions(); } catch (e) { console.error('[exit] error:', e.message); }
    try { await checkSettlements(); } catch (e) { console.error('[settlement] error:', e.message); }
    try { await settlePaperTrades(); } catch (e) { console.error('[paper-settle] error:', e.message); }
    try { await settleShadowDecisions(); } catch (e) { console.error('[shadow-settle] error:', e.message); }
    try { await reviewStopLossOutcomes(); } catch (e) { console.error('[stop-review] error:', e.message); }
    try { await checkLosingStreak(); } catch (e) { console.error('[streak] error:', e.message); }
    try { await updateCalibrationStats(); } catch (e) { console.error('[cal-stats] error:', e.message); }
    setTimeout(settlementLoop, 90 * 1000);
  }

  // CLV capture loop — fast tick (60s) so we hit the narrow [game_start - 30s, +180s]
  // window on every pre-game trade. No-ops when nothing pending.
  async function clvLoop() {
    try { await captureClvTicks(); } catch (e) { console.error('[clv] error:', e.message); }
    setTimeout(clvLoop, 60 * 1000);
  }
  setTimeout(clvLoop, 60 * 1000); // first run after 60s
  setTimeout(settlementLoop, 2 * 60 * 1000); // first run after 2 min

  // Fast soccer exit loop — every 30 seconds.
  // Soccer first-goal price spikes are brief: the market reprices immediately on a goal
  // then drifts back as draw risk reasserts. The standard 5-min managePositions cycle is
  // too slow — we need to catch and sell the spike within 30 seconds of it occurring.
  // Only runs when there are open pre-game soccer positions to avoid unnecessary API calls.
  async function soccerExitLoop() {
    try {
      if (!existsSync(TRADES_LOG)) { setTimeout(soccerExitLoop, 30 * 1000); return; }
      const sLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
      const soccerOpen = sLines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(t => t && t.status === 'open' && t.exchange === 'kalshi' &&
          (t.strategy === 'pre-game-prediction' || t.strategy === 'pre-game-edge-first') &&
          ['mls', 'epl', 'laliga'].includes((t.sport ?? '').toLowerCase()));

      if (soccerOpen.length > 0) {
        for (const trade of soccerOpen) {
          try {
            if (trade.partialTakeAt) continue; // already took profit
            const mktData = await kalshiGet(`/markets/${trade.ticker}`);
            const m = mktData.market ?? mktData;
            const currentPrice = parseFloat(m.yes_ask_dollars ?? '0');
            if (currentPrice <= 0) continue;
            const entryPrice = trade.entryPrice ?? 0;
            const profitPerContract = currentPrice - entryPrice;
            if (profitPerContract < 0.12) continue; // no spike yet

            const qty = trade.quantity ?? Math.round((trade.deployCost ?? 0) / entryPrice);
            if (qty <= 0) continue;

            // Soccer: sell 90% on first-goal spike. Same exit fraction as managePositions
            // but fires 10x faster — catches the spike before it drifts back.
            const sellQty = Math.max(1, Math.floor(qty * 0.90));
            const gainCents = Math.round(profitPerContract * 100);
            console.log(`[soccer-exit] ⚡ FAST SPIKE EXIT: ${trade.ticker} up ${gainCents}¢ — attempting sell ${sellQty}/${qty} @ ${Math.round(currentPrice*100)}¢ (first-goal spike)`);

            // Re-read fresh to avoid stale state
            const freshLines = readFileSync(TRADES_LOG, 'utf-8').split('\n').filter(l => l.trim());
            const freshTrades = freshLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            const freshTrade = freshTrades.find(t => t.id === trade.id);
            if (freshTrade && freshTrade.status === 'open' && !freshTrade.partialTakeAt) {
              const result = await executeSell(freshTrade, sellQty, currentPrice, 'pre-game-profit-lock');
              if (result) {
                freshTrade.partialTakeAt = new Date().toISOString();
                writeFileSync(TRADES_LOG, freshTrades.map(t => JSON.stringify(t)).join('\n') + '\n');
                await tg(
                  `⚡ <b>SOCCER FIRST-GOAL SPIKE</b>\n\n` +
                  `📋 <b>POSITION</b>\n` +
                  `${trade.title}\n\n` +
                  `📊 <b>METRICS</b>\n` +
                  `Entry: ${Math.round((trade.entryPrice ?? 0)*100)}¢ → Exit: ${Math.round(currentPrice*100)}¢ (+${gainCents}¢)\n` +
                  `Sold 90% (${sellQty} contracts) — first goal scored, exit triggered\n` +
                  `Profit this sale: <b>+$${(gainCents * sellQty / 100).toFixed(2)}</b>`
                );
              }
            }
          } catch { /* skip individual trade errors */ }
        }
      }
    } catch (e) { console.error('[soccer-exit] error:', e.message); }
    setTimeout(soccerExitLoop, 30 * 1000);
  }
  setTimeout(soccerExitLoop, 30 * 1000); // starts 30s after bot init

  // Calibration engine — runs daily at 6am ET.
  // 1) runCalibration() — internal threshold analysis + Telegram report
  // 2) suggest.mjs --apply — Wilson CI-based threshold suggestions, writes calibration-overrides.json
  // 3) Hot-reload CAL overrides so the bot picks up new thresholds without restart
  // 4) Refresh calibration feedback cache so Claude prompts get updated track record
  let lastCalibration = '';
  async function calibrationLoop() {
    const today = etTodayStr();
    if (etHour() === 6 && lastCalibration !== today) {
      lastCalibration = today;
      try {
        runCalibration();
        console.log('[calibrate] Running suggest.mjs --apply...');
        try {
          execSync('node suggest.mjs --apply', { timeout: 30000, cwd: new URL('.', import.meta.url).pathname });
          console.log('[calibrate] suggest.mjs --apply completed');
        } catch (e) { console.error('[calibrate] suggest.mjs error:', e.message?.slice(0, 200)); }
        // Hot-reload calibration overrides + diff vs prior state so we can alert
        // on newly disabled or re-enabled strategies (auto-revival signal).
        try {
          const priorDisabled = new Set(Array.isArray(CAL.disabledStrategies) ? CAL.disabledStrategies : []);
          const nextCAL = JSON.parse(readFileSync('./calibration-overrides.json', 'utf-8'));
          const nextDisabled = new Set(Array.isArray(nextCAL.disabledStrategies) ? nextCAL.disabledStrategies : []);
          CAL = nextCAL;
          console.log(`[calibrate] Reloaded overrides (${CAL._tradesAnalyzed ?? '?'} trades analyzed)`);
          const newlyDisabled = [...nextDisabled].filter(s => !priorDisabled.has(s));
          const newlyRevived = [...priorDisabled].filter(s => !nextDisabled.has(s));
          if (newlyDisabled.length > 0) {
            await tg(`🛑 <b>STRATEGY AUTO-DISABLED</b>\n\nCalibration detected sustained -EV:\n${newlyDisabled.map(s => `  • ${s}`).join('\n')}\n\nWilson 95% CI upper bound fell below breakeven. Trading will skip these until the sample recovers.`);
          }
          if (newlyRevived.length > 0) {
            await tg(`✅ <b>STRATEGY RE-ENABLED</b>\n\nCalibration CI upper now above breakeven:\n${newlyRevived.map(s => `  • ${s}`).join('\n')}\n\nTrading resumed for these strategies.`);
          }
        } catch { /* no file yet — fine */ }
        // Refresh Claude prompt calibration feedback
        calibrationFeedback = computeCalibrationFeedback();
        if (calibrationFeedback) console.log('[calibrate] Refreshed calibration feedback for Claude prompts');
      } catch (e) { console.error('[calibrate] error:', e.message); }
    }
    setTimeout(calibrationLoop, 60 * 60 * 1000);
  }
  setTimeout(calibrationLoop, 10 * 60 * 1000);
  console.log('[calibrate] Auto-calibration enabled — runs daily at 6am ET');

  // Daily report — checks every hour, sends at midnight ET
  let lastDailyReport = '';
  async function dailyReportLoop() {
    const today = etTodayStr();
    const hr = etHour();
    // Send at midnight ET (hour 0) and also at 8pm ET (end of trading day recap)
    if ((hr === 0 || hr === 20) && lastDailyReport !== `${today}-${hr}`) {
      lastDailyReport = `${today}-${hr}`;
      try { await sendDailyReport(); } catch (e) { console.error('[daily-report] error:', e.message); }
    }
    setTimeout(dailyReportLoop, 30 * 60 * 1000); // check every 30 min
  }
  setTimeout(dailyReportLoop, 5 * 60 * 1000); // first check after 5 min

  // Initialize risk tracking
  resetDailyTracking();

  const bankroll = getBankroll();
  const maxTrade = getDynamicMaxTrade();
  await tg(
    `🧠 <b>AI Edge Bot Started</b>\n\n` +
    `<b>Risk Controls Active:</b>\n` +
    `Max trade: $${maxTrade.toFixed(2)} (10% of bankroll, ceiling $${getTradeCapCeiling()})\n` +
    `Max deploy: ${(getMaxDeployment()*100).toFixed(0)}% ($${(bankroll*getMaxDeployment()).toFixed(2)}) | Positions: ${getMaxPositions()}\n` +
    `Daily loss halt: $${Math.max(10, bankroll * DAILY_LOSS_PCT).toFixed(2)} (${(DAILY_LOSS_PCT*100).toFixed(0)}%)\n` +
    `Reserve: ${(CAPITAL_RESERVE*100).toFixed(0)}% ($${(bankroll*CAPITAL_RESERVE).toFixed(2)}) | Game cap: 15% ($${(bankroll*0.15).toFixed(2)})\n` +
    `Pre-game: max ${MAX_PREGAME_PER_CYCLE}/cycle, ${MAX_PREGAME_PAPER_PER_DAY}/day | Consecutive loss: ${MAX_CONSECUTIVE_LOSSES}→half\n\n` +
    `<b>Config:</b>\n` +
    `Min confidence: ${(MIN_CONFIDENCE*100).toFixed(0)}% | Margins: dynamic by sport + price\n` +
    `Mode: ${KALSHI_ONLY ? 'Kalshi only' : 'Kalshi + Poly'} | ${DRY_RUN ? 'DRY RUN' : 'LIVE TRADING'}\n` +
    `Sonnet + web search | Live-edge: every 60s\n\n` +
    `💰 Kalshi: $${kalshiBalance.toFixed(2)} cash + $${kalshiPositionValue.toFixed(2)} positions\n` +
    `💰 Total bankroll: <b>$${bankroll.toFixed(2)}</b>`
  );

  // Graceful shutdown
  process.on('SIGINT', async () => {
    saveState();
    await tg('🛑 <b>AI Edge Bot Stopped</b>');
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    saveState();
    await tg('🛑 <b>AI Edge Bot Stopped</b>');
    process.exit(0);
  });

  console.log('AI edge bot running. Press Ctrl+C to stop.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
