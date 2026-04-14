/**
 * Arbor Calibration Analytics
 *
 * Measures whether Claude's stated confidence matches actual win rates.
 * Answers: "When Claude says 72%, does it win 72% of the time?"
 *
 * Outputs:
 *   - Brier score (overall + per sport) — lower is better, 0.25 = coin flip
 *   - Calibration curve — stated confidence vs actual win rate per bucket
 *   - WE-bucket analysis — WE table accuracy (Phase 1+ trades only)
 *   - Leader vs underdog split (Phase 1+ trades only)
 *   - Per-sport calibration summary with actionable flags
 *
 * Run: node bot/calibrate.mjs [path/to/trades.jsonl]
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Load trades ──────────────────────────────────────────────────────────────

const logPath = process.argv[2]
  ? resolve(process.argv[2])
  : new URL('../bot/logs/trades.jsonl', import.meta.url).pathname;

let raw;
try { raw = readFileSync(logPath, 'utf-8'); }
catch (e) { console.error(`Cannot read ${logPath}: ${e.message}`); process.exit(1); }

const allTrades = raw.split('\n')
  .filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

// ─── Filter to real, completed trades only ────────────────────────────────────

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

// Only include trades where we have a definite binary outcome and a confidence value
function calibratable(t) {
  return isWin(t) !== null && t.confidence != null;
}

// ─── Brier Score ──────────────────────────────────────────────────────────────
// BS = mean((confidence - outcome)²). Perfect = 0.0, coin flip at 50% = 0.25.

function brierScore(trades) {
  const pts = trades.filter(calibratable);
  if (pts.length === 0) return null;
  const sum = pts.reduce((s, t) => {
    const outcome = isWin(t) ? 1 : 0;
    return s + Math.pow(t.confidence - outcome, 2);
  }, 0);
  return sum / pts.length;
}

function brierLabel(bs) {
  if (bs == null) return '—';
  if (bs < 0.10) return `${bs.toFixed(3)} ✓ excellent`;
  if (bs < 0.15) return `${bs.toFixed(3)} ✓ good`;
  if (bs < 0.20) return `${bs.toFixed(3)} ~ acceptable`;
  if (bs < 0.25) return `${bs.toFixed(3)} ⚠ poor`;
  return `${bs.toFixed(3)} ✗ worse than coin flip`;
}

// ─── Print helpers ────────────────────────────────────────────────────────────

function pct(wins, losses) {
  const total = wins + losses;
  if (total === 0) return '  —  ';
  return `${((wins / total) * 100).toFixed(0)}%`;
}

function gap(actual, expected) {
  const diff = actual - expected;
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${(diff * 100).toFixed(0)}pts`;
}

function gapLabel(actualWR, expectedWR, n) {
  if (n < 5) return '(too few)';
  const diff = actualWR - expectedWR;
  if (Math.abs(diff) <= 0.08) return '✓ calibrated';
  if (diff > 0) return '  under-confident';  // winning more than stated — could lower threshold
  return '⚠ OVER-CONFIDENT';                 // winning less than stated — raise threshold
}

const divider = '═'.repeat(66);
const thin = '─'.repeat(66);

// ─── Section 1: Overview ──────────────────────────────────────────────────────

console.log('\n' + divider);
console.log('ARBOR CALIBRATION ANALYTICS');
console.log(divider);

const scored = real.filter(calibratable);
const withWE = real.filter(t => t.weAtEntry != null && calibratable(t));
const withLeader = real.filter(t => t.isLeadingTeam != null && calibratable(t));

console.log(`\nCompleted trades (settled + stop-loss): ${real.length}`);
console.log(`  With confidence (calibratable):        ${scored.length}`);
console.log(`  With weAtEntry  (Phase 1+ data):       ${withWE.length}`);
console.log(`  With isLeadingTeam (Phase 1+ data):    ${withLeader.length}`);

const totalWins = scored.filter(t => isWin(t)).length;
const totalLosses = scored.filter(t => !isWin(t)).length;
const actualWR = totalWins / (totalWins + totalLosses || 1);
const avgConf = scored.reduce((s, t) => s + t.confidence, 0) / (scored.length || 1);

console.log(`\nOVERALL`);
console.log(`  Win rate:          ${(actualWR * 100).toFixed(1)}%  (${totalWins}W / ${totalLosses}L)`);
console.log(`  Avg stated conf:   ${(avgConf * 100).toFixed(1)}%`);
console.log(`  Conf vs WR gap:    ${gap(actualWR, avgConf)}  ${gapLabel(actualWR, avgConf, scored.length)}`);
console.log(`  Brier score:       ${brierLabel(brierScore(scored))}`);

// ─── Section 2: Calibration Curve ────────────────────────────────────────────

console.log('\n' + thin);
console.log('CALIBRATION CURVE  (stated confidence vs actual win rate)');
console.log(thin);
console.log('  Bucket      n     Expected   Actual    Gap       Verdict');
console.log('  ──────────  ────  ─────────  ────────  ────────  ─────────────────');

const confBuckets = [
  { label: '65-69%', lo: 0.65, hi: 0.70, mid: 0.67 },
  { label: '70-74%', lo: 0.70, hi: 0.75, mid: 0.72 },
  { label: '75-79%', lo: 0.75, hi: 0.80, mid: 0.77 },
  { label: '80-84%', lo: 0.80, hi: 0.85, mid: 0.82 },
  { label: '85-89%', lo: 0.85, hi: 0.90, mid: 0.87 },
  { label: '90%+',   lo: 0.90, hi: 1.01, mid: 0.92 },
];

for (const b of confBuckets) {
  const bt = scored.filter(t => t.confidence >= b.lo && t.confidence < b.hi);
  const wins = bt.filter(t => isWin(t)).length;
  const losses = bt.filter(t => !isWin(t)).length;
  const total = wins + losses;
  if (total === 0) continue;
  const awr = wins / total;
  const label = b.label.padEnd(10);
  const nStr = String(total).padStart(4);
  const expStr = `${(b.mid * 100).toFixed(0)}%`.padStart(9);
  const actStr = pct(wins, losses).padStart(8);
  const gapStr = gap(awr, b.mid).padStart(8);
  const verdict = gapLabel(awr, b.mid, total);
  console.log(`  ${label}  ${nStr}  ${expStr}  ${actStr}  ${gapStr}  ${verdict}`);
}

// ─── Section 3: Per-Sport Calibration ────────────────────────────────────────

console.log('\n' + thin);
console.log('PER-SPORT CALIBRATION');
console.log(thin);
console.log('  Sport       n     Avg Conf   Actual WR   Gap       Brier     Verdict');
console.log('  ──────────  ────  ─────────  ──────────  ────────  ────────  ─────────────');

// Use `league` field first (Phase 1+), fall back to ticker-based detection
function getSport(t) {
  if (t.league) return t.league.toUpperCase();
  const tk = (t.ticker ?? '').toUpperCase();
  if (tk.includes('MLB') || tk.includes('ATHNYM') || tk.includes('HOUSEA')) return 'MLB';
  if (tk.includes('NHL') || tk.includes('NHK')) return 'NHL';
  if (tk.includes('NBA') || tk.includes('NBK')) return 'NBA';
  if (tk.includes('MLS')) return 'MLS';
  if (tk.includes('EPL')) return 'EPL';
  if (tk.includes('-NHL-') || tk.includes('AEC-NHL')) return 'NHL';
  if (tk.includes('-NBA-')) return 'NBA';
  if (tk.includes('-MLB-')) return 'MLB';
  return 'Unknown';
}

const sportMap = new Map();
for (const t of scored) {
  const sport = getSport(t);
  if (!sportMap.has(sport)) sportMap.set(sport, []);
  sportMap.get(sport).push(t);
}

for (const [sport, trades] of [...sportMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const wins = trades.filter(t => isWin(t)).length;
  const losses = trades.filter(t => !isWin(t)).length;
  const total = wins + losses;
  if (total === 0) continue;
  const awr = wins / total;
  const avgC = trades.reduce((s, t) => s + t.confidence, 0) / trades.length;
  const bs = brierScore(trades);
  const sportLabel = sport.padEnd(10);
  const nStr = String(total).padStart(4);
  const confStr = `${(avgC * 100).toFixed(1)}%`.padStart(9);
  const wrStr = pct(wins, losses).padStart(10);
  const gapStr = gap(awr, avgC).padStart(8);
  const bsStr = (bs != null ? bs.toFixed(3) : '—').padStart(8);
  const verdict = gapLabel(awr, avgC, total);
  console.log(`  ${sportLabel}  ${nStr}  ${confStr}  ${wrStr}  ${gapStr}  ${bsStr}  ${verdict}`);
}

// ─── Section 4: WE-Bucket Analysis (Phase 1+ only) ───────────────────────────

if (withWE.length > 0) {
  console.log('\n' + thin);
  console.log(`WE-BUCKET ANALYSIS  (${withWE.length} trades with weAtEntry — Phase 1+ data)`);
  console.log('Measures whether the Win Expectancy tables themselves are accurate.');
  console.log(thin);
  console.log('  WE Bucket   n     WE Midpt   Actual WR   Gap       Verdict');
  console.log('  ──────────  ────  ─────────  ──────────  ────────  ─────────────────');

  const weBuckets = [
    { label: '50-59%', lo: 0.50, hi: 0.60, mid: 0.55 },
    { label: '60-69%', lo: 0.60, hi: 0.70, mid: 0.65 },
    { label: '70-79%', lo: 0.70, hi: 0.80, mid: 0.75 },
    { label: '80-89%', lo: 0.80, hi: 0.90, mid: 0.85 },
    { label: '90%+',   lo: 0.90, hi: 1.01, mid: 0.93 },
  ];

  for (const b of weBuckets) {
    const bt = withWE.filter(t => t.weAtEntry >= b.lo && t.weAtEntry < b.hi);
    const wins = bt.filter(t => isWin(t)).length;
    const losses = bt.filter(t => !isWin(t)).length;
    const total = wins + losses;
    if (total === 0) continue;
    const awr = wins / total;
    const label = b.label.padEnd(10);
    const nStr = String(total).padStart(4);
    const midStr = `${(b.mid * 100).toFixed(0)}%`.padStart(9);
    const actStr = pct(wins, losses).padStart(10);
    const gapStr = gap(awr, b.mid).padStart(8);
    const verdict = gapLabel(awr, b.mid, total);
    console.log(`  ${label}  ${nStr}  ${midStr}  ${actStr}  ${gapStr}  ${verdict}`);
  }
} else {
  console.log('\n' + thin);
  console.log('WE-BUCKET ANALYSIS  — no Phase 1+ trades yet (weAtEntry field missing)');
  console.log('This section will populate after the next settled trade.');
  console.log(thin);
}

// ─── Section 5: Leader vs Underdog (Phase 1+ only) ───────────────────────────

if (withLeader.length > 0) {
  console.log('\n' + thin);
  console.log(`LEADER vs UNDERDOG  (${withLeader.length} trades with isLeadingTeam — Phase 1+ data)`);
  console.log(thin);

  for (const [label, trades] of [
    ['Bet leader  (isLeadingTeam=true)',  withLeader.filter(t => t.isLeadingTeam === true)],
    ['Bet underdog (isLeadingTeam=false)', withLeader.filter(t => t.isLeadingTeam === false)],
  ]) {
    const wins = trades.filter(t => isWin(t)).length;
    const losses = trades.filter(t => !isWin(t)).length;
    const total = wins + losses;
    if (total === 0) { console.log(`  ${label}: no data`); continue; }
    const awr = wins / total;
    const avgC = trades.reduce((s, t) => s + t.confidence, 0) / trades.length;
    const bs = brierScore(trades);
    const pnl = trades.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
    const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
    console.log(`  ${label}`);
    console.log(`    ${total} trades  WR: ${pct(wins, losses)}  avg conf: ${(avgC*100).toFixed(1)}%  gap: ${gap(awr, avgC)}  Brier: ${bs != null ? bs.toFixed(3) : '—'}  P&L: $${pnlStr}`);
    console.log(`    ${gapLabel(awr, avgC, total)}`);
  }
} else {
  console.log('\n' + thin);
  console.log('LEADER vs UNDERDOG  — no Phase 1+ trades yet');
  console.log(thin);
}

// ─── Section 6: Strategy breakdown ───────────────────────────────────────────

console.log('\n' + thin);
console.log('BY STRATEGY');
console.log(thin);

const stratMap = new Map();
for (const t of scored) {
  const s = t.strategy ?? 'unknown';
  if (!stratMap.has(s)) stratMap.set(s, []);
  stratMap.get(s).push(t);
}

for (const [strat, trades] of [...stratMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const wins = trades.filter(t => isWin(t)).length;
  const losses = trades.filter(t => !isWin(t)).length;
  const total = wins + losses;
  if (total === 0) continue;
  const awr = wins / total;
  const avgC = trades.reduce((s, t) => s + t.confidence, 0) / trades.length;
  const bs = brierScore(trades);
  const pnl = trades.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
  const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
  console.log(`  ${strat.padEnd(22)}  ${total} trades  WR: ${pct(wins, losses)}  Brier: ${bs != null ? bs.toFixed(3) : '—'}  P&L: $${pnlStr}`);
}

// ─── Section 7: Actionable flags ─────────────────────────────────────────────

console.log('\n' + thin);
console.log('ACTIONABLE FLAGS  (requires ≥5 trades in bucket to flag)');
console.log(thin);

let flagCount = 0;

// Check each confidence bucket
for (const b of confBuckets) {
  const bt = scored.filter(t => t.confidence >= b.lo && t.confidence < b.hi);
  const wins = bt.filter(t => isWin(t)).length;
  const losses = bt.filter(t => !isWin(t)).length;
  const total = wins + losses;
  if (total < 5) continue;
  const awr = wins / total;
  const diff = awr - b.mid;
  if (diff < -0.10) {
    console.log(`  ⚠  Conf ${b.label}: winning ${(awr*100).toFixed(0)}% but stating ${(b.mid*100).toFixed(0)}% (overconfident by ${(-diff*100).toFixed(0)}pts over ${total} trades) — consider raising MIN_CONFIDENCE`);
    flagCount++;
  } else if (diff > 0.12) {
    console.log(`  💡 Conf ${b.label}: winning ${(awr*100).toFixed(0)}% but stating ${(b.mid*100).toFixed(0)}% (underconfident by ${(diff*100).toFixed(0)}pts over ${total} trades) — threshold may be too conservative`);
    flagCount++;
  }
}

// Check per-sport
for (const [sport, trades] of sportMap.entries()) {
  const wins = trades.filter(t => isWin(t)).length;
  const losses = trades.filter(t => !isWin(t)).length;
  const total = wins + losses;
  if (total < 5) continue;
  const awr = wins / total;
  const avgC = trades.reduce((s, t) => s + t.confidence, 0) / trades.length;
  const diff = awr - avgC;
  if (diff < -0.12) {
    console.log(`  ⚠  ${sport}: avg conf ${(avgC*100).toFixed(1)}% but actual WR ${(awr*100).toFixed(1)}% (overconfident by ${(-diff*100).toFixed(0)}pts) — sport-specific threshold may be too low`);
    flagCount++;
  }
}

// Leader vs underdog flags
if (withLeader.length >= 5) {
  const underdogs = withLeader.filter(t => t.isLeadingTeam === false);
  const ugWins = underdogs.filter(t => isWin(t)).length;
  const ugLosses = underdogs.filter(t => !isWin(t)).length;
  if (ugWins + ugLosses >= 5) {
    const ugWR = ugWins / (ugWins + ugLosses);
    const ugConf = underdogs.reduce((s, t) => s + t.confidence, 0) / underdogs.length;
    if (ugWR < ugConf - 0.12) {
      console.log(`  ⚠  Underdog bets: conf avg ${(ugConf*100).toFixed(1)}% but WR ${(ugWR*100).toFixed(1)}% — trailing-team +15% cap may be too loose`);
      flagCount++;
    }
  }
}

if (flagCount === 0) {
  console.log(`  ✓ No actionable flags. Keep collecting data (need ≥5 trades per bucket).`);
}

console.log('\n' + divider + '\n');
