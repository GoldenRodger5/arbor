/**
 * Arbor Threshold Suggestions — v2 (Tier 1 + Tier 2 calibration)
 *
 * Analyzes trades.jsonl and writes calibration-overrides.json.
 * ai-edge.mjs reads the file at startup and hot-reloads hourly.
 *
 * TIER 1 (always active, no bankroll gate):
 *   • minConfidenceLive      — confidence floor per sport
 *   • requiredMarginLive     — edge floor per sport
 *   • disabledStrategies     — auto-pause -EV strategies (Wilson CI gated)
 *   • exitThresholds         — per-sport/playoff WE floor, profit-take, partial-take
 *   • reasoningTagStats      — informational (data fuel for Tier 3 later)
 *
 * TIER 2 (requires Kalshi balance ≥ $2,000):
 *   • kellyFraction          — downward-only per-sport Kelly dampening
 *   • priceConfFloors        — separate underdog/favorite confidence floors
 *   • partialTakePrice       — per-sport/playoff optimal partial-take
 *
 * Usage:
 *   node bot/suggest.mjs                  # analyze + print
 *   node bot/suggest.mjs --apply          # analyze + write calibration-overrides.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import crypto from 'crypto';

const APPLY = process.argv.includes('--apply');
const logArg = process.argv.find(a => !a.startsWith('--') && a.endsWith('.jsonl'));

const logPath = logArg
  ? resolve(logArg)
  : new URL('../bot/logs/trades.jsonl', import.meta.url).pathname;
const overridesPath = new URL('../bot/calibration-overrides.json', import.meta.url).pathname;

// ─── Tier 2 gating ────────────────────────────────────────────────────────────
const TIER2_BANKROLL_MIN = 2000;

// ─── Load trades ──────────────────────────────────────────────────────────────
let raw;
try { raw = readFileSync(logPath, 'utf-8'); }
catch (e) { console.error(`Cannot read ${logPath}: ${e.message}`); process.exit(1); }

const allTrades = raw.split('\n')
  .filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const EXIT_STATUSES = new Set([
  'sold-stop-loss', 'sold-claude-stop', 'sold-pre-game-claude-stop',
  'sold-pre-game-nuclear', 'sold-profit-take', 'sold-we-reversal', 'sold-we-drop',
]);
const SETTLED_STATUSES = new Set(['settled']);
const REAL_STATUSES = new Set([...EXIT_STATUSES, ...SETTLED_STATUSES]);

const real = allTrades.filter(t => REAL_STATUSES.has(t.status));

// ─── Kalshi balance fetch for Tier 2 gate ─────────────────────────────────────
async function fetchKalshiBalance() {
  try {
    const envPath = new URL('../bot/.env', import.meta.url).pathname;
    const env = readFileSync(envPath, 'utf-8');
    const keyId = (env.match(/KALSHI_API_KEY_ID=(.+)/) ?? [])[1]?.trim();
    const pkPath = (env.match(/KALSHI_PRIVATE_KEY_PATH=(.+)/) ?? [])[1]?.trim() ?? './kalshi-private-key.pem';

    if (!keyId) return null;
    const privateKey = readFileSync(resolve(new URL('../bot/', import.meta.url).pathname, pkPath), 'utf-8');

    const ts = Date.now().toString();
    const path = '/trade-api/v2/portfolio/balance';
    const method = 'GET';
    const msg = ts + method + path;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(msg), {
      key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
    }).toString('base64');

    const res = await fetch(`https://api.elections.kalshi.com${path}`, {
      headers: { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig, 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.balance ?? 0) / 100;
  } catch (e) {
    return null;
  }
}

// ─── Outcome helpers ──────────────────────────────────────────────────────────
function isWin(t) {
  if (t.status?.startsWith('sold-stop') || t.status?.startsWith('sold-claude-stop') ||
      t.status === 'sold-pre-game-claude-stop' || t.status === 'sold-pre-game-nuclear' ||
      t.status === 'sold-we-reversal' || t.status === 'sold-we-drop') {
    // Exit trades: win only if realizedPnL > 0
    return (t.realizedPnL ?? 0) > 0;
  }
  if (t.status === 'sold-profit-take') return (t.realizedPnL ?? 0) > 0;
  if (t.result === 'yes') return true;
  if (t.result === 'no') return false;
  if (t.realizedPnL != null) return t.realizedPnL > 0;
  return null;
}

function calibratable(t) {
  return isWin(t) !== null && t.confidence != null && t.entryPrice != null;
}

function isLiveSport(t) {
  return ['live-prediction', 'high-conviction'].includes(t.strategy);
}

function getSport(t) {
  if (t.league) return t.league.toLowerCase();
  const tk = (t.ticker ?? '').toUpperCase();
  if (tk.includes('NHL') || tk.includes('NHK') || tk.includes('-NHL-')) return 'nhl';
  if (tk.includes('NBA') || tk.includes('NBK') || tk.includes('-NBA-')) return 'nba';
  if (tk.includes('MLB') || tk.includes('-MLB-')) return 'mlb';
  if (tk.includes('MLS')) return 'mls';
  if (tk.includes('EPL')) return 'epl';
  return null;
}

function isPlayoff(t) {
  return /Game \d/i.test(t.title ?? '') || !!t.playoff;
}

function wilsonCI(wins, n) {
  if (n === 0) return [0, 1];
  const p = wins / n;
  const z = 1.96;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const spread = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

// ─── Constants ────────────────────────────────────────────────────────────────
const CONF_BUCKETS = [
  { label: '65-69%', lo: 0.65, hi: 0.70, mid: 0.67 },
  { label: '70-74%', lo: 0.70, hi: 0.75, mid: 0.72 },
  { label: '75-79%', lo: 0.75, hi: 0.80, mid: 0.77 },
  { label: '80-84%', lo: 0.80, hi: 0.85, mid: 0.82 },
  { label: '85-89%', lo: 0.85, hi: 0.90, mid: 0.87 },
  { label: '90%+',   lo: 0.90, hi: 1.01, mid: 0.92 },
];

const DEFAULT_MARGINS = { nhl: 0.03, nba: 0.04, mlb: 0.05, mls: 0.05, epl: 0.05, laliga: 0.05 };
const DEFAULT_MIN_CONF = 0.65;
const MIN_TRADES_FOR_SUGGESTION = 15;
const CONFIDENT_THRESHOLD = 30;
const MAX_STEP = 0.05;

// Tier 1: exit calibration thresholds
const EXIT_MIN_SAMPLES = 10;   // need 10+ exits per sport/playoff to suggest
const STRATEGY_MIN_SAMPLES = 20; // need 20+ trades per strategy before auto-disable

// ─── Per-sport confidence/margin analysis (legacy) ────────────────────────────
function analyzeSport(sport, trades) {
  const live = trades.filter(t => calibratable(t) && isLiveSport(t));
  const n = live.length;

  const buckets = CONF_BUCKETS.map(b => {
    const bt = live.filter(t => t.confidence >= b.lo && t.confidence < b.hi);
    const wins = bt.filter(t => isWin(t)).length;
    const losses = bt.filter(t => !isWin(t)).length;
    const total = wins + losses;
    const avgEntry = total > 0 ? bt.reduce((s, t) => s + (t.entryPrice ?? 0), 0) / total : null;
    const breakevenWR = avgEntry;
    const actualWR = total > 0 ? wins / total : null;
    const [ciLo, ciHi] = total > 0 ? wilsonCI(wins, total) : [null, null];
    const evPerDollar = (actualWR != null && avgEntry != null)
      ? actualWR * (1 - avgEntry) - (1 - actualWR) * avgEntry
      : null;
    return { ...b, total, wins, losses, avgEntry, breakevenWR, actualWR, ciLo, ciHi, evPerDollar };
  });

  const suggestions = {};

  if (n < MIN_TRADES_FOR_SUGGESTION) {
    return { sport, n, buckets, suggestions, status: 'insufficient-data' };
  }

  const currentMinConf = DEFAULT_MIN_CONF;
  const currentMargin = DEFAULT_MARGINS[sport] ?? 0.04;

  let suggestedMinConf = currentMinConf;
  for (const b of buckets) {
    if (b.total < 3) continue;
    if (b.ciHi == null || b.breakevenWR == null) continue;
    if (b.ciHi < b.breakevenWR) {
      const candidate = Math.min(currentMinConf + MAX_STEP, b.hi);
      if (candidate > suggestedMinConf) suggestedMinConf = candidate;
    }
  }
  if (suggestedMinConf > currentMinConf) suggestions.minConfidenceLive = suggestedMinConf;

  const losingLive = live.filter(t => !isWin(t));
  if (losingLive.length >= 5) {
    const lossEdges = losingLive
      .map(t => t.confidence - (t.entryPrice ?? t.confidence))
      .filter(e => e != null && e >= 0)
      .sort((a, b) => a - b);
    if (lossEdges.length > 0) {
      const medianLossEdge = lossEdges[Math.floor(lossEdges.length / 2)];
      if (medianLossEdge <= currentMargin + 0.02) {
        const candidate = Math.min(currentMargin + 0.02, currentMargin + MAX_STEP);
        if (candidate > currentMargin) suggestions.requiredMarginLive = parseFloat(candidate.toFixed(2));
      }
    }
  }

  const status = n >= CONFIDENT_THRESHOLD ? 'confident' : 'tentative';
  return { sport, n, buckets, suggestions, status };
}

// ─── TIER 1A: Exit threshold calibration ──────────────────────────────────────
// For each sport × playoff flag, measure how often exit triggers led to
// locked-in losses. A "bad stop" is one where realizedPnL was negative AND
// the position would have been profitable at settlement (we can detect this
// only if settlementPrice or finalPrice exists on the record — otherwise the
// sample contributes to the bad-stop *rate* via realizedPnL sign only).
//
// Output: exitThresholds[sport][playoff|regular] = {
//   weFloor: <number 0..1>, profitTake: <number 0..1>, weDrop: <number 0..1>,
//   partialTake: <number 0..1>   // only written if TIER 2 enabled
// }
function analyzeExits(trades) {
  const out = {};
  for (const sport of ['nhl', 'nba', 'mlb', 'mls', 'epl']) {
    const sportTrades = trades.filter(t => getSport(t) === sport);
    if (sportTrades.length < EXIT_MIN_SAMPLES) continue;

    for (const bucket of ['playoff', 'regular']) {
      const bucketTrades = sportTrades.filter(t => (isPlayoff(t) ? 'playoff' : 'regular') === bucket);
      if (bucketTrades.length < EXIT_MIN_SAMPLES) continue;

      // Measure bad-stop rate: exit trades that realized a loss
      const stopExits = bucketTrades.filter(t =>
        t.status === 'sold-stop-loss' ||
        t.status === 'sold-claude-stop' ||
        t.status === 'sold-pre-game-claude-stop' ||
        t.status === 'sold-we-reversal' ||
        t.status === 'sold-we-drop');

      if (stopExits.length < EXIT_MIN_SAMPLES) continue;

      // Flag stops that subsequently settled profitably (if settlementResult field exists)
      const recoveredStops = stopExits.filter(t =>
        t.settlementResult === 'yes' ||
        t.marketFinalPrice > (t.exitPrice ?? 0.30) + 0.15);

      const badStopRate = stopExits.length > 0 ? recoveredStops.length / stopExits.length : 0;

      // If more than 30% of stops end up recovering (market resolves above exit), stops are too tight.
      // Lower the WE floor and tighten stop-loss price.
      out[sport] = out[sport] ?? {};
      out[sport][bucket] = out[sport][bucket] ?? {};
      out[sport][bucket]._samples = stopExits.length;
      out[sport][bucket]._badStopRate = parseFloat(badStopRate.toFixed(3));

      // Default thresholds by playoff flag (mirrors current playoff-aware code)
      const defaults = bucket === 'playoff'
        ? { weFloor: 0.20, profitTake: 0.72, weDrop: 0.40 }
        : { weFloor: 0.30, profitTake: 0.70, weDrop: 0.35 };

      // Suggestion: if bad-stop rate >= 30%, tighten WE floor by 3 points (allow more holding)
      // and raise profitTake by 2 points (lock wins earlier). Only suggests *looser* exits.
      // Never suggests tighter exits from this analysis — that's what the entry threshold
      // tuning is for.
      if (badStopRate >= 0.30) {
        out[sport][bucket].weFloor = Math.max(0.08, parseFloat((defaults.weFloor - 0.03).toFixed(2)));
        out[sport][bucket].profitTake = Math.max(0.55, parseFloat((defaults.profitTake - 0.02).toFixed(2)));
        out[sport][bucket].weDrop = Math.min(0.60, parseFloat((defaults.weDrop + 0.05).toFixed(2)));
      }
    }
  }
  return out;
}

// ─── TIER 1B: Strategy gating ────────────────────────────────────────────────
// Disable any strategy whose Wilson-CI-lower WR is below its breakeven avg entry.
function analyzeStrategies(trades) {
  const byStrat = {};
  for (const t of trades) {
    if (!calibratable(t)) continue;
    const s = t.strategy ?? 'unknown';
    if (!byStrat[s]) byStrat[s] = { wins: 0, losses: 0, entryPriceSum: 0, n: 0 };
    byStrat[s].n++;
    byStrat[s].entryPriceSum += t.entryPrice ?? 0;
    if (isWin(t)) byStrat[s].wins++; else byStrat[s].losses++;
  }

  const disabled = [];
  const stats = {};
  for (const [strat, s] of Object.entries(byStrat)) {
    if (s.n < STRATEGY_MIN_SAMPLES) { stats[strat] = { n: s.n, status: 'insufficient' }; continue; }
    const avgEntry = s.entryPriceSum / s.n;
    const [ciLo, ciHi] = wilsonCI(s.wins, s.n);
    const actualWR = s.wins / s.n;
    stats[strat] = { n: s.n, wins: s.wins, actualWR, ciLo, ciHi, avgEntry };
    // If even upper 95% CI is below breakeven → strategy is clearly -EV → disable
    if (ciHi < avgEntry) {
      disabled.push(strat);
      stats[strat].action = 'auto-disabled';
    }
  }
  return { disabled, stats };
}

// ─── TIER 1C: Reasoning tag stats (informational — Tier 3 fuel) ──────────────
function analyzeReasoningTags(trades) {
  const byTag = {};
  for (const t of trades) {
    if (!calibratable(t)) continue;
    const tags = t.reasoningStructured?.reasoning_tags ?? t.reasoningTags ?? [];
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      const key = tag.toLowerCase().trim();
      if (!byTag[key]) byTag[key] = { n: 0, wins: 0, entryPriceSum: 0 };
      byTag[key].n++;
      byTag[key].entryPriceSum += t.entryPrice ?? 0;
      if (isWin(t)) byTag[key].wins++;
    }
  }
  const result = {};
  for (const [tag, s] of Object.entries(byTag)) {
    const avgEntry = s.n > 0 ? s.entryPriceSum / s.n : null;
    const [ciLo, ciHi] = wilsonCI(s.wins, s.n);
    result[tag] = {
      n: s.n, wins: s.wins,
      winRate: s.n > 0 ? parseFloat((s.wins / s.n).toFixed(3)) : null,
      avgEntry: avgEntry != null ? parseFloat(avgEntry.toFixed(3)) : null,
      ciLo: parseFloat(ciLo.toFixed(3)), ciHi: parseFloat(ciHi.toFixed(3)),
    };
  }
  return result;
}

// ─── TIER 2A: Kelly fraction per sport (downward-only) ───────────────────────
function analyzeKellyFraction(trades) {
  const out = {};
  for (const sport of ['nhl', 'nba', 'mlb', 'mls', 'epl']) {
    const sportTrades = trades.filter(t => getSport(t) === sport && calibratable(t));
    if (sportTrades.length < CONFIDENT_THRESHOLD) continue;
    const wins = sportTrades.filter(t => isWin(t)).length;
    const avgEntry = sportTrades.reduce((s, t) => s + (t.entryPrice ?? 0), 0) / sportTrades.length;
    const [ciLo] = wilsonCI(wins, sportTrades.length);
    // Realized edge = lower CI of WR - breakeven (conservative)
    const realizedEdge = ciLo - avgEntry;
    // Kelly fraction cap: 0.5 (half-Kelly). Scale by realizedEdge.
    // If edge < 0 → reduce sizing to 0.25x. If edge > 0.10 → full 0.50x.
    let fraction;
    if (realizedEdge < 0) fraction = 0.25;
    else if (realizedEdge < 0.05) fraction = 0.35;
    else if (realizedEdge < 0.10) fraction = 0.45;
    else fraction = 0.50;
    out[sport] = parseFloat(fraction.toFixed(2));
  }
  return out;
}

// ─── TIER 2B: Price × confidence floors ──────────────────────────────────────
function analyzePriceConfFloors(trades) {
  const out = {};
  for (const sport of ['nhl', 'nba', 'mlb', 'mls', 'epl']) {
    const live = trades.filter(t => getSport(t) === sport && calibratable(t) && isLiveSport(t));
    if (live.length < CONFIDENT_THRESHOLD) continue;

    for (const band of ['underdog', 'favorite']) {
      const bandTrades = live.filter(t => band === 'underdog' ? (t.entryPrice ?? 0.5) < 0.50 : (t.entryPrice ?? 0.5) >= 0.50);
      if (bandTrades.length < 10) continue;
      // Find lowest confidence bucket where CI upper still below breakeven
      const buckets = CONF_BUCKETS.map(b => {
        const bt = bandTrades.filter(t => t.confidence >= b.lo && t.confidence < b.hi);
        const wins = bt.filter(t => isWin(t)).length;
        const total = bt.length;
        const avgEntry = total > 0 ? bt.reduce((s, t) => s + (t.entryPrice ?? 0), 0) / total : null;
        const [_, ciHi] = total > 0 ? wilsonCI(wins, total) : [0, 1];
        return { ...b, total, ciHi, breakeven: avgEntry };
      });
      let floor = DEFAULT_MIN_CONF;
      for (const b of buckets) {
        if (b.total < 3 || b.breakeven == null) continue;
        if (b.ciHi < b.breakeven) {
          const candidate = Math.min(DEFAULT_MIN_CONF + MAX_STEP, b.hi);
          if (candidate > floor) floor = candidate;
        }
      }
      if (floor > DEFAULT_MIN_CONF) {
        out[sport] = out[sport] ?? {};
        out[sport][band] = parseFloat(floor.toFixed(2));
      }
    }
  }
  return out;
}

// ─── TIER 2C: Partial-take optimal price ─────────────────────────────────────
// For winning trades, find the price level where taking half-exit maximizes
// expected P&L considering that some winners reverse before settlement.
function analyzePartialTake(trades) {
  const out = {};
  for (const sport of ['nhl', 'nba', 'mlb', 'mls', 'epl']) {
    for (const bucket of ['playoff', 'regular']) {
      const sportTrades = trades.filter(t =>
        getSport(t) === sport &&
        calibratable(t) &&
        ((isPlayoff(t) ? 'playoff' : 'regular') === bucket));
      if (sportTrades.length < 15) continue;

      // Among winners, look at peakPrice vs entryPrice. Partial-take price
      // should sit at ~70% of average peak gain above entry.
      const winners = sportTrades.filter(t => isWin(t));
      if (winners.length < 8) continue;
      const avgPeakGain = winners
        .map(t => (t.peakPrice ?? t.exitPrice ?? 0.65) - (t.entryPrice ?? 0.50))
        .filter(g => g > 0)
        .reduce((s, g, _, arr) => s + g / arr.length, 0);

      const avgEntry = winners.reduce((s, t) => s + (t.entryPrice ?? 0.50), 0) / winners.length;
      const suggested = Math.min(0.85, Math.max(0.60, avgEntry + avgPeakGain * 0.70));
      out[sport] = out[sport] ?? {};
      out[sport][bucket] = parseFloat(suggested.toFixed(2));
    }
  }
  return out;
}

// ─── Group trades by sport ────────────────────────────────────────────────────
const sportMap = new Map();
for (const t of real) {
  const sport = getSport(t);
  if (!sport) continue;
  if (!sportMap.has(sport)) sportMap.set(sport, []);
  sportMap.get(sport).push(t);
}

const analyses = [...sportMap.entries()]
  .map(([sport, trades]) => analyzeSport(sport, trades))
  .sort((a, b) => b.n - a.n);

// ─── Fetch bankroll (for Tier 2 gate) ─────────────────────────────────────────
const bankroll = await fetchKalshiBalance();
const tier2Enabled = bankroll != null && bankroll >= TIER2_BANKROLL_MIN;

// ─── Run Tier 1 analyses ──────────────────────────────────────────────────────
const exitThresholds = analyzeExits(real);
const strategyAnalysis = analyzeStrategies(real);
const reasoningTagStats = analyzeReasoningTags(real);

// ─── Run Tier 2 analyses (gated) ──────────────────────────────────────────────
const kellyFraction = tier2Enabled ? analyzeKellyFraction(real) : null;
const priceConfFloors = tier2Enabled ? analyzePriceConfFloors(real) : null;
const partialTakePrice = tier2Enabled ? analyzePartialTake(real) : null;

// ─── Load existing overrides to show diffs ────────────────────────────────────
let existingOverrides = {};
try { existingOverrides = JSON.parse(readFileSync(overridesPath, 'utf-8')); }
catch { /* no file yet */ }

// ─── Print report ─────────────────────────────────────────────────────────────
const divider = '═'.repeat(66);
const thin = '─'.repeat(66);

console.log('\n' + divider);
console.log('ARBOR THRESHOLD SUGGESTIONS — v2 (Tier 1 + Tier 2)');
console.log(divider);
console.log(`\nAnalyzing ${real.length} completed trades across ${sportMap.size} sports`);
if (bankroll != null) {
  console.log(`Kalshi bankroll: $${bankroll.toFixed(2)} — Tier 2 ${tier2Enabled ? 'ENABLED ✓' : `DISABLED (need $${TIER2_BANKROLL_MIN}+)`}`);
} else {
  console.log(`Kalshi bankroll: unavailable (balance fetch failed) — Tier 2 gated OFF`);
}

const newOverrides = {
  _generated: new Date().toISOString().slice(0, 10),
  _tradesAnalyzed: real.length,
  _bankroll: bankroll != null ? parseFloat(bankroll.toFixed(2)) : null,
  _tier2Enabled: tier2Enabled,
  _note: 'Generated by suggest.mjs v2. Review before restart. Delete file to revert.',
};

let hasAnySuggestion = false;

// Tier 1 / legacy: minConfidenceLive & requiredMarginLive
for (const analysis of analyses) {
  const { sport, suggestions } = analysis;
  if (suggestions.minConfidenceLive != null) {
    newOverrides.minConfidenceLive = newOverrides.minConfidenceLive ?? {};
    newOverrides.minConfidenceLive[sport] = suggestions.minConfidenceLive;
    hasAnySuggestion = true;
  }
  if (suggestions.requiredMarginLive != null) {
    newOverrides.requiredMarginLive = newOverrides.requiredMarginLive ?? {};
    newOverrides.requiredMarginLive[sport] = suggestions.requiredMarginLive;
    hasAnySuggestion = true;
  }
}

// Preserve carry-forwards
for (const key of ['minConfidenceLive', 'requiredMarginLive']) {
  if (existingOverrides[key]) {
    for (const [sport, val] of Object.entries(existingOverrides[key])) {
      if (!newOverrides[key]?.[sport]) {
        newOverrides[key] = newOverrides[key] ?? {};
        newOverrides[key][sport] = val;
      }
    }
  }
}

// Tier 1: Exit thresholds
console.log('\n' + thin);
console.log('TIER 1 — EXIT THRESHOLDS');
console.log(thin);
if (Object.keys(exitThresholds).length === 0) {
  console.log('  Not enough exit data yet per sport/playoff bucket.');
} else {
  for (const [sport, buckets] of Object.entries(exitThresholds)) {
    for (const [bucket, thresh] of Object.entries(buckets)) {
      if (thresh.weFloor != null) {
        console.log(`  ${sport} ${bucket}: badStopRate=${(thresh._badStopRate * 100).toFixed(0)}% → weFloor=${thresh.weFloor} profitTake=${thresh.profitTake} weDrop=${thresh.weDrop}`);
        hasAnySuggestion = true;
      } else {
        console.log(`  ${sport} ${bucket}: badStopRate=${(thresh._badStopRate * 100).toFixed(0)}% (within tolerance — no change)`);
      }
    }
  }
  // Write only suggested changes (not informational samples)
  const cleaned = {};
  for (const [sport, buckets] of Object.entries(exitThresholds)) {
    for (const [bucket, thresh] of Object.entries(buckets)) {
      if (thresh.weFloor != null) {
        cleaned[sport] = cleaned[sport] ?? {};
        cleaned[sport][bucket] = { weFloor: thresh.weFloor, profitTake: thresh.profitTake, weDrop: thresh.weDrop };
      }
    }
  }
  if (Object.keys(cleaned).length > 0) newOverrides.exitThresholds = cleaned;
}

// Tier 1: Strategy gating
console.log('\n' + thin);
console.log('TIER 1 — STRATEGY GATING');
console.log(thin);
if (Object.keys(strategyAnalysis.stats).length === 0) {
  console.log('  No strategy data available.');
} else {
  for (const [strat, s] of Object.entries(strategyAnalysis.stats)) {
    if (s.status === 'insufficient') {
      console.log(`  ${strat}: ${s.n} trades — need ${STRATEGY_MIN_SAMPLES}+ to evaluate`);
    } else {
      const flag = s.action === 'auto-disabled' ? '  🛑 AUTO-DISABLE' : '';
      console.log(`  ${strat}: n=${s.n} wr=${(s.actualWR * 100).toFixed(0)}% ci=[${(s.ciLo * 100).toFixed(0)}%, ${(s.ciHi * 100).toFixed(0)}%] breakeven=${(s.avgEntry * 100).toFixed(0)}%${flag}`);
    }
  }
  if (strategyAnalysis.disabled.length > 0) {
    newOverrides.disabledStrategies = strategyAnalysis.disabled;
    hasAnySuggestion = true;
  }
}

// Tier 1: Reasoning tags (info only)
console.log('\n' + thin);
console.log('TIER 1 — REASONING TAG STATS (informational — not gated)');
console.log(thin);
if (Object.keys(reasoningTagStats).length === 0) {
  console.log('  No reasoning tags logged yet (will populate as new trades emit reasoning_tags).');
} else {
  for (const [tag, s] of Object.entries(reasoningTagStats)) {
    console.log(`  ${tag.padEnd(24)} n=${String(s.n).padStart(3)} wr=${((s.winRate ?? 0) * 100).toFixed(0).padStart(3)}% ci=[${(s.ciLo * 100).toFixed(0).padStart(3)}%, ${(s.ciHi * 100).toFixed(0).padStart(3)}%]`);
  }
  newOverrides.reasoningTagStats = reasoningTagStats;
}

// Tier 2: Kelly, price×conf, partial-take
console.log('\n' + thin);
console.log(`TIER 2 — BANKROLL-GATED CALIBRATIONS (bankroll ${tier2Enabled ? '≥' : '<'} $${TIER2_BANKROLL_MIN})`);
console.log(thin);
if (!tier2Enabled) {
  console.log('  Skipped — unlocks when Kalshi balance crosses threshold.');
} else {
  if (kellyFraction && Object.keys(kellyFraction).length > 0) {
    console.log('  Kelly fraction per sport:');
    for (const [sport, frac] of Object.entries(kellyFraction)) {
      console.log(`    ${sport}: ${frac} (of full Kelly)`);
    }
    newOverrides.kellyFraction = kellyFraction;
    hasAnySuggestion = true;
  }
  if (priceConfFloors && Object.keys(priceConfFloors).length > 0) {
    console.log('  Price × confidence floors:');
    for (const [sport, bands] of Object.entries(priceConfFloors)) {
      for (const [band, floor] of Object.entries(bands)) {
        console.log(`    ${sport} ${band}: min confidence = ${(floor * 100).toFixed(0)}%`);
      }
    }
    newOverrides.priceConfFloors = priceConfFloors;
    hasAnySuggestion = true;
  }
  if (partialTakePrice && Object.keys(partialTakePrice).length > 0) {
    console.log('  Partial-take price:');
    for (const [sport, buckets] of Object.entries(partialTakePrice)) {
      for (const [bucket, price] of Object.entries(buckets)) {
        console.log(`    ${sport} ${bucket}: ${(price * 100).toFixed(0)}¢`);
      }
    }
    newOverrides.partialTakePrice = partialTakePrice;
    hasAnySuggestion = true;
  }
  if (!hasAnySuggestion) console.log('  No Tier 2 suggestions yet.');
}

// ─── Summary and write ────────────────────────────────────────────────────────
console.log('\n' + divider);
if (!hasAnySuggestion) {
  console.log('\n✓ No threshold changes suggested at this time.');
  console.log('  Keep collecting trades — suggestions fire when evidence is clear.\n');
} else {
  console.log('\nPROPOSED calibration-overrides.json:');
  console.log(JSON.stringify(newOverrides, null, 2));
  if (APPLY) {
    writeFileSync(overridesPath, JSON.stringify(newOverrides, null, 2) + '\n');
    console.log(`\n✓ Written to ${overridesPath}`);
    console.log('  ai-edge.mjs hot-reloads the file each calibration cycle.\n');
  } else {
    console.log('\n  Dry run — file not written. Re-run with --apply to write.\n');
  }
}
console.log(divider + '\n');
