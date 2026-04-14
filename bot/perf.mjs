/**
 * Arbor Performance Analytics
 *
 * Reads trades.jsonl and outputs win rate by sport, confidence bucket,
 * edge bucket, and strategy. Shows P&L breakdown and flags loss patterns.
 *
 * Run: node bot/perf.mjs [path/to/trades.jsonl]
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

console.log(`\nTotal records in log: ${allTrades.length}`);

// ─── Status categories ────────────────────────────────────────────────────────

const byStatus = {};
for (const t of allTrades) {
  byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
}
console.log('\nAll statuses:');
for (const [s, n] of Object.entries(byStatus)) console.log(`  ${s}: ${n}`);

// ─── Filter to real, completed trades only ────────────────────────────────────
// Include: settled, sold-stop-loss, sold-claude-stop
// Exclude: testing-void (pre-launch testing), failed-bug, closed-manual (manual
//          exits not driven by strategy — skew results), open (still live)

const REAL_STATUSES = new Set(['settled', 'sold-stop-loss', 'sold-claude-stop']);
const real = allTrades.filter(t => REAL_STATUSES.has(t.status));

// ─── Determine outcome ────────────────────────────────────────────────────────

function isWin(t) {
  if (t.status === 'sold-stop-loss' || t.status === 'sold-claude-stop') return false;
  if (t.result === 'yes') return true;
  if (t.result === 'no') return false;
  // result=null on settled: use realizedPnL sign
  if (t.realizedPnL != null) return t.realizedPnL > 0;
  return null; // unknown
}

// ─── Detect sport from ticker ─────────────────────────────────────────────────

function getSport(t) {
  const tk = (t.ticker ?? '').toUpperCase();
  if (tk.includes('MLB') || tk.includes('ATHNYM') || tk.includes('HOUSEA')) return 'MLB';
  if (tk.includes('NHL') || tk.includes('NHK')) return 'NHL';
  if (tk.includes('NBA') || tk.includes('NBK')) return 'NBA';
  if (tk.includes('MLS') || tk.includes('MLS')) return 'MLS';
  if (tk.includes('EPL')) return 'EPL';
  // Polymarket: parse from ticker string
  if (tk.includes('-NHL-') || tk.includes('AEC-NHL')) return 'NHL';
  if (tk.includes('-NBA-')) return 'NBA';
  if (tk.includes('-MLB-')) return 'MLB';
  // Fallback: check title or liveScore
  const score = (t.liveScore ?? '').toLowerCase();
  if (score.includes('inning') || score.includes('bot ') || score.includes('top ')) return 'MLB';
  if (score.includes('1st') || score.includes('2nd') || score.includes('3rd')) {
    // Could be NHL or NBA — check score values
    const nums = (t.liveScore ?? '').match(/\d+/g)?.map(Number) ?? [];
    if (nums.some(n => n > 20)) return 'NBA';
    return 'NHL';
  }
  if (score.includes("'") || score.includes("min")) return 'Soccer';
  return 'Unknown';
}

// ─── Confidence bucket ────────────────────────────────────────────────────────

function confBucket(conf) {
  if (conf == null) return '?';
  const p = conf * 100;
  if (p < 68) return '65-67%';
  if (p < 72) return '68-71%';
  if (p < 76) return '72-75%';
  if (p < 80) return '76-79%';
  if (p < 85) return '80-84%';
  if (p < 90) return '85-89%';
  return '90%+';
}

// ─── Edge bucket ─────────────────────────────────────────────────────────────

function edgeBucket(edge) {
  if (edge == null) return '?';
  if (edge < 4) return '<4%';
  if (edge < 6) return '4-5%';
  if (edge < 9) return '6-8%';
  if (edge < 14) return '9-13%';
  if (edge < 21) return '14-20%';
  return '21%+';
}

// ─── Build stats ──────────────────────────────────────────────────────────────

function makeCounter() {
  return { wins: 0, losses: 0, unknown: 0, pnl: 0, trades: [] };
}

function addTo(map, key, win, t) {
  if (!map.has(key)) map.set(key, makeCounter());
  const c = map.get(key);
  if (win === true) c.wins++;
  else if (win === false) c.losses++;
  else c.unknown++;
  c.pnl += t.realizedPnL ?? 0;
  c.trades.push(t);
}

const bySport     = new Map();
const byConf      = new Map();
const byEdge      = new Map();
const byExchange  = new Map();
let totalWins = 0, totalLosses = 0, totalUnknown = 0, totalPnL = 0;

for (const t of real) {
  const win     = isWin(t);
  const sport   = getSport(t);
  const conf    = t.confidence;
  const edge    = typeof t.edge === 'number' ? t.edge : parseFloat(t.edge);

  addTo(bySport,    sport,              win, t);
  addTo(byConf,     confBucket(conf),   win, t);
  addTo(byEdge,     edgeBucket(edge),   win, t);
  addTo(byExchange, t.exchange ?? '?',  win, t);

  if (win === true) totalWins++;
  else if (win === false) totalLosses++;
  else totalUnknown++;
  totalPnL += t.realizedPnL ?? 0;
}

// ─── Print helpers ────────────────────────────────────────────────────────────

function pct(wins, losses) {
  const total = wins + losses;
  if (total === 0) return ' — ';
  return `${((wins / total) * 100).toFixed(0)}%`;
}

function row(label, c) {
  const total = c.wins + c.losses;
  const wr = pct(c.wins, c.losses);
  const pnlStr = (c.pnl >= 0 ? '+' : '') + c.pnl.toFixed(2);
  return `  ${label.padEnd(14)} ${String(total).padStart(3)} trades  ${wr.padStart(4)} WR  ${pnlStr.padStart(8)} P&L  (${c.wins}W / ${c.losses}L${c.unknown ? ' / ' + c.unknown + '?' : ''})`;
}

// ─── Output ───────────────────────────────────────────────────────────────────

const divider = '═'.repeat(60);

console.log('\n' + divider);
console.log('ARBOR PERFORMANCE ANALYTICS');
console.log(divider);

const totalReal = totalWins + totalLosses + totalUnknown;
console.log(`\nReal completed trades: ${totalReal}  (settled + stop-loss exits)`);
console.log(`Excluded: testing-void, failed-bug, closed-manual, open`);

console.log(`\nOVERALL: ${totalWins}W / ${totalLosses}L  →  ${pct(totalWins, totalLosses)} win rate  |  ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} P&L`);

// ── By sport ──
console.log('\n── BY SPORT ──');
for (const [k, c] of [...bySport.entries()].sort((a,b) => (b[1].wins+b[1].losses) - (a[1].wins+a[1].losses))) {
  console.log(row(k, c));
}

// ── By confidence ──
console.log('\n── BY CONFIDENCE AT ENTRY ──');
const confOrder = ['65-67%','68-71%','72-75%','76-79%','80-84%','85-89%','90%+'];
for (const k of confOrder) {
  const c = byConf.get(k);
  if (c) console.log(row(k, c));
}

// ── By edge ──
console.log('\n── BY EDGE AT ENTRY ──');
const edgeOrder = ['<4%','4-5%','6-8%','9-13%','14-20%','21%+'];
for (const k of edgeOrder) {
  const c = byEdge.get(k);
  if (c) console.log(row(k, c));
}

// ── By exchange ──
console.log('\n── BY EXCHANGE ──');
for (const [k, c] of byExchange.entries()) {
  console.log(row(k, c));
}

// ── Loss breakdown ──
console.log('\n── ALL LOSSES (detailed) ──');
const losses = real.filter(t => isWin(t) === false);
for (const t of losses) {
  const sport  = getSport(t);
  const pnlStr = (t.realizedPnL ?? 0) >= 0 ? '+' : '';
  console.log(`  [${sport}] ${t.ticker?.split('-').slice(-1)[0] ?? '?'}  conf=${((t.confidence??0)*100).toFixed(0)}%  edge=${typeof t.edge==='number'?t.edge.toFixed(0):t.edge}pts  entry=${((t.entryPrice??0)*100).toFixed(0)}¢  P&L=${pnlStr}$${(t.realizedPnL??0).toFixed(2)}  status=${t.status}`);
  const reason = (t.reasoning ?? '').slice(0, 120);
  console.log(`     Score: ${t.liveScore ?? '?'}`);
  console.log(`     Why: ${reason}...`);
}

// ── Breakeven analysis ──
console.log('\n── BREAKEVEN ANALYSIS ──');
const avgEntry = real.reduce((s,t) => s + (t.entryPrice ?? 0), 0) / real.length;
const breakevenWR = avgEntry * 100;
console.log(`  Avg entry price: ${(avgEntry*100).toFixed(1)}¢`);
console.log(`  Breakeven win rate at avg price: ${breakevenWR.toFixed(1)}%`);
console.log(`  Actual win rate: ${pct(totalWins, totalLosses)}`);
const actualWR = totalWins / (totalWins + totalLosses);
const evPerDollar = actualWR * (1 - avgEntry) - (1 - actualWR) * avgEntry;
console.log(`  EV per $1 deployed: ${evPerDollar >= 0 ? '+' : ''}$${evPerDollar.toFixed(3)}`);

console.log('\n' + divider + '\n');
