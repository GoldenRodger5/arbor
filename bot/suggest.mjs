/**
 * Arbor Threshold Suggestions
 *
 * Analyzes trades.jsonl calibration data and recommends per-sport threshold
 * adjustments. Optionally writes calibration-overrides.json which ai-edge.mjs
 * reads at startup — no code changes required.
 *
 * Usage:
 *   node bot/suggest.mjs                          # analyze only, print report
 *   node bot/suggest.mjs --apply                  # analyze + write overrides file
 *   node bot/suggest.mjs [path/to/trades.jsonl]   # custom log path
 *
 * After --apply: review calibration-overrides.json, then restart bot:
 *   pm2 restart arbor-ai
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const APPLY = process.argv.includes('--apply');
const logArg = process.argv.find(a => !a.startsWith('--') && a.endsWith('.jsonl'));

const logPath = logArg
  ? resolve(logArg)
  : new URL('../bot/logs/trades.jsonl', import.meta.url).pathname;

const overridesPath = new URL('../bot/calibration-overrides.json', import.meta.url).pathname;

// ─── Load trades ──────────────────────────────────────────────────────────────

let raw;
try { raw = readFileSync(logPath, 'utf-8'); }
catch (e) { console.error(`Cannot read ${logPath}: ${e.message}`); process.exit(1); }

const allTrades = raw.split('\n')
  .filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const REAL_STATUSES = new Set(['settled', 'sold-stop-loss', 'sold-claude-stop']);
const real = allTrades.filter(t => REAL_STATUSES.has(t.status));

// ─── Outcome helpers ──────────────────────────────────────────────────────────

function isWin(t) {
  if (t.status === 'sold-stop-loss' || t.status === 'sold-claude-stop') return false;
  if (t.result === 'yes') return true;
  if (t.result === 'no') return false;
  if (t.realizedPnL != null) return t.realizedPnL > 0;
  return null;
}

function calibratable(t) {
  return isWin(t) !== null && t.confidence != null && t.entryPrice != null;
}

// Only live sports trades are relevant for live threshold tuning
function isLiveSport(t) {
  return ['live-prediction', 'high-conviction'].includes(t.strategy);
}

// ─── Wilson confidence interval ───────────────────────────────────────────────
// Returns [lower, upper] 95% CI for a proportion p with n observations.
// More reliable than normal approximation at small n.

function wilsonCI(wins, n) {
  if (n === 0) return [0, 1];
  const p = wins / n;
  const z = 1.96; // 95% CI
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const spread = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

// ─── Core analysis per sport ──────────────────────────────────────────────────
// Returns { sport, n, buckets, suggestions: { minConfidenceLive, requiredMarginLive } }

const CONF_BUCKETS = [
  { label: '65-69%', lo: 0.65, hi: 0.70, mid: 0.67 },
  { label: '70-74%', lo: 0.70, hi: 0.75, mid: 0.72 },
  { label: '75-79%', lo: 0.75, hi: 0.80, mid: 0.77 },
  { label: '80-84%', lo: 0.80, hi: 0.85, mid: 0.82 },
  { label: '85-89%', lo: 0.85, hi: 0.90, mid: 0.87 },
  { label: '90%+',   lo: 0.90, hi: 1.01, mid: 0.92 },
];

// Hardcoded defaults — mirrors ai-edge.mjs getRequiredMargin() sportBase
const DEFAULT_MARGINS = { nhl: 0.03, nba: 0.04, mlb: 0.05, mls: 0.05, epl: 0.05, laliga: 0.05 };
const DEFAULT_MIN_CONF = 0.65;
const MIN_TRADES_FOR_SUGGESTION = 15; // minimum settled live trades per sport
const CONFIDENT_THRESHOLD = 30;       // n ≥ 30 → "confident" suggestion vs "tentative"
const MAX_STEP = 0.05;                // never suggest jumping more than +5% per cycle

function analyzeSport(sport, trades) {
  const live = trades.filter(t => calibratable(t) && isLiveSport(t));
  const n = live.length;

  const buckets = CONF_BUCKETS.map(b => {
    const bt = live.filter(t => t.confidence >= b.lo && t.confidence < b.hi);
    const wins = bt.filter(t => isWin(t)).length;
    const losses = bt.filter(t => !isWin(t)).length;
    const total = wins + losses;
    const avgEntry = total > 0
      ? bt.reduce((s, t) => s + (t.entryPrice ?? 0), 0) / total
      : null;
    // Breakeven WR = entry price (e.g. 68¢ entry needs 68% WR to break even)
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

  // MIN CONFIDENCE suggestion:
  // Find the lowest confidence bucket where the upper Wilson CI is below breakeven.
  // That means even optimistically, this bucket is losing money. Suggest raising min
  // to the next bucket's lower bound (capped at current + MAX_STEP).
  let suggestedMinConf = currentMinConf;
  for (const b of buckets) {
    if (b.total < 3) continue; // need at least 3 in a bucket to act
    if (b.ciHi == null || b.breakevenWR == null) continue;
    // If even the optimistic upper bound of the CI is below breakeven → clearly -EV
    if (b.ciHi < b.breakevenWR) {
      const candidate = Math.min(currentMinConf + MAX_STEP, b.hi);
      if (candidate > suggestedMinConf) suggestedMinConf = candidate;
    }
  }
  if (suggestedMinConf > currentMinConf) {
    suggestions.minConfidenceLive = suggestedMinConf;
  }

  // REQUIRED MARGIN suggestion:
  // Look at the distribution of (confidence - entryPrice) for losing trades.
  // If the average losing trade had an edge very close to the current floor,
  // the floor is too low — raise it to the median edge of losing trades.
  const losingLive = live.filter(t => !isWin(t));
  if (losingLive.length >= 5) {
    const lossEdges = losingLive
      .map(t => t.confidence - (t.entryPrice ?? t.confidence))
      .filter(e => e != null && e >= 0)
      .sort((a, b) => a - b);
    if (lossEdges.length > 0) {
      const medianLossEdge = lossEdges[Math.floor(lossEdges.length / 2)];
      // If median losing edge is near the current floor, that floor is ineffective
      if (medianLossEdge <= currentMargin + 0.02) {
        const candidate = Math.min(currentMargin + 0.02, currentMargin + MAX_STEP);
        if (candidate > currentMargin) {
          suggestions.requiredMarginLive = parseFloat(candidate.toFixed(2));
        }
      }
    }
  }

  const status = n >= CONFIDENT_THRESHOLD ? 'confident' : 'tentative';
  return { sport, n, buckets, suggestions, status };
}

// ─── Group trades by sport ────────────────────────────────────────────────────

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

// ─── Load existing overrides to show diffs ────────────────────────────────────

let existingOverrides = {};
try { existingOverrides = JSON.parse(readFileSync(overridesPath, 'utf-8')); }
catch { /* no file yet */ }

// ─── Print report ─────────────────────────────────────────────────────────────

const divider = '═'.repeat(66);
const thin = '─'.repeat(66);

console.log('\n' + divider);
console.log('ARBOR THRESHOLD SUGGESTIONS');
console.log(divider);
console.log(`\nAnalyzing ${real.length} completed trades across ${sportMap.size} sports`);
console.log(`Requires ≥${MIN_TRADES_FOR_SUGGESTION} live trades per sport to suggest | ≥${CONFIDENT_THRESHOLD} = "confident"`);

// Collect final override values across all sports
const newOverrides = {
  _generated: new Date().toISOString().slice(0, 10),
  _tradesAnalyzed: real.length,
  _note: 'Generated by suggest.mjs. Review before restarting bot. Delete file to revert to defaults.',
};

let hasAnySuggestion = false;

for (const analysis of analyses) {
  const { sport, n, buckets, suggestions, status } = analysis;
  console.log('\n' + thin);
  const statusTag = status === 'insufficient-data'
    ? `⏳ need ${MIN_TRADES_FOR_SUGGESTION - n} more trades`
    : status === 'confident' ? '✓ confident' : '~ tentative';
  console.log(`${sport.toUpperCase()}  (${n} live trades — ${statusTag})`);
  console.log(thin);

  if (status === 'insufficient-data') {
    console.log(`  Not enough data yet. Keep collecting trades.`);
    continue;
  }

  // Print bucket table
  console.log(`  Bucket      n   Actual WR   Breakeven   95% CI              EV/dollar`);
  console.log(`  ──────────  ─── ──────────  ──────────  ──────────────────  ─────────`);
  for (const b of buckets) {
    if (b.total === 0) continue;
    const wr = b.actualWR != null ? `${(b.actualWR * 100).toFixed(0)}%` : '—';
    const be = b.breakevenWR != null ? `${(b.breakevenWR * 100).toFixed(0)}¢` : '—';
    const ci = (b.ciLo != null && b.ciHi != null)
      ? `[${(b.ciLo * 100).toFixed(0)}%, ${(b.ciHi * 100).toFixed(0)}%]`
      : '—';
    const ev = b.evPerDollar != null
      ? `${b.evPerDollar >= 0 ? '+' : ''}${b.evPerDollar.toFixed(3)}`
      : '—';
    const flag = (b.ciHi != null && b.breakevenWR != null && b.total >= 3 && b.ciHi < b.breakevenWR)
      ? '  ⚠ -EV even optimistically'
      : '';
    console.log(`  ${b.label.padEnd(10)}  ${String(b.total).padStart(3)} ${wr.padStart(10)}  ${be.padStart(10)}  ${ci.padStart(18)}  ${ev.padStart(9)}${flag}`);
  }

  // Print suggestions
  if (Object.keys(suggestions).length === 0) {
    console.log(`\n  ✓ No threshold changes suggested for ${sport.toUpperCase()}.`);
  } else {
    console.log(`\n  SUGGESTIONS (${status}):`);
    if (suggestions.minConfidenceLive != null) {
      const curr = (existingOverrides.minConfidenceLive?.[sport] ?? DEFAULT_MIN_CONF) * 100;
      const next = suggestions.minConfidenceLive * 100;
      console.log(`  • minConfidenceLive[${sport}]: ${curr.toFixed(0)}% → ${next.toFixed(0)}%`);
      console.log(`    Live ${sport.toUpperCase()} trades in the ${(DEFAULT_MIN_CONF * 100).toFixed(0)}-${(suggestions.minConfidenceLive * 100).toFixed(0)}% range are consistently -EV.`);
      hasAnySuggestion = true;
    }
    if (suggestions.requiredMarginLive != null) {
      const curr = (existingOverrides.requiredMarginLive?.[sport] ?? DEFAULT_MARGINS[sport] ?? 0.04) * 100;
      const next = suggestions.requiredMarginLive * 100;
      console.log(`  • requiredMarginLive[${sport}]: ${curr.toFixed(0)}% → ${next.toFixed(0)}%`);
      console.log(`    Median losing trade had ${next.toFixed(0)}% edge — current floor too low.`);
      hasAnySuggestion = true;
    }
  }

  // Merge into newOverrides
  if (suggestions.minConfidenceLive != null) {
    newOverrides.minConfidenceLive = newOverrides.minConfidenceLive ?? {};
    newOverrides.minConfidenceLive[sport] = suggestions.minConfidenceLive;
  }
  if (suggestions.requiredMarginLive != null) {
    newOverrides.requiredMarginLive = newOverrides.requiredMarginLive ?? {};
    newOverrides.requiredMarginLive[sport] = suggestions.requiredMarginLive;
  }
}

// Preserve any overrides from existing file that aren't being overwritten by new suggestions
// (e.g., a manual override you set that no sport had enough data to re-suggest)
for (const key of ['minConfidenceLive', 'requiredMarginLive']) {
  if (existingOverrides[key]) {
    for (const [sport, val] of Object.entries(existingOverrides[key])) {
      if (!newOverrides[key]?.[sport]) {
        // No suggestion for this sport this run — carry forward existing override with a note
        newOverrides[key] = newOverrides[key] ?? {};
        newOverrides[key][sport] = val;
      }
    }
  }
}

// ─── Summary and write ────────────────────────────────────────────────────────

console.log('\n' + divider);

if (!hasAnySuggestion) {
  console.log('\n✓ No threshold changes suggested at this time.');
  console.log('  Keep collecting trades — suggestions fire when evidence is statistically clear.\n');
} else {
  console.log('\nPROPOSED calibration-overrides.json:');
  console.log(JSON.stringify(newOverrides, null, 2));

  if (APPLY) {
    writeFileSync(overridesPath, JSON.stringify(newOverrides, null, 2) + '\n');
    console.log(`\n✓ Written to ${overridesPath}`);
    console.log('  Review the file, then restart the bot: pm2 restart arbor-ai');
    console.log('  To revert: delete calibration-overrides.json and restart.\n');
  } else {
    console.log('\n  Dry run — file not written. Re-run with --apply to write:');
    console.log('  node bot/suggest.mjs --apply\n');
  }
}

console.log(divider + '\n');
