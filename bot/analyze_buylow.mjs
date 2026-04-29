// PHASE 1 ANALYSIS — Trailer Buy-Low Thesis Validator
//
// Joins shadow-decisions.jsonl (buy-low candidates) with price-tape.jsonl
// (intra-game price trajectories) to compute whether a "buy trailing team
// at 25-40¢, sell on price recovery" detector would be +EV.
//
// Run: node analyze_buylow.mjs
// (run from /root/arbor/bot/ on the server, or locally with paths adjusted)

import { readFileSync, existsSync } from 'node:fs';

const SHADOW_LOG = './logs/shadow-decisions.jsonl';
const TAPE_LOG = './logs/price-tape.jsonl';

if (!existsSync(SHADOW_LOG) || !existsSync(TAPE_LOG)) {
  console.error('Missing logs. Need both shadow-decisions.jsonl and price-tape.jsonl.');
  process.exit(1);
}

// Load shadow records — filter to buy-low candidates
const shadowLines = readFileSync(SHADOW_LOG, 'utf-8').split('\n').filter(l => l.trim());
const allShadows = shadowLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const buyLowShadows = allShadows.filter(s => s.isBuyLowCandidate === true);

console.log(`Total shadow records: ${allShadows.length}`);
console.log(`Buy-low candidates: ${buyLowShadows.length}`);
console.log('');

if (buyLowShadows.length === 0) {
  console.log('No buy-low candidates yet. Wait for more data.');
  process.exit(0);
}

// Load price tape — group by ticker for fast lookup
const tapeLines = readFileSync(TAPE_LOG, 'utf-8').split('\n').filter(l => l.trim());
const tapeByTicker = new Map();
for (const line of tapeLines) {
  try {
    const t = JSON.parse(line);
    if (!tapeByTicker.has(t.ticker)) tapeByTicker.set(t.ticker, []);
    tapeByTicker.get(t.ticker).push(t);
  } catch {}
}

// For each buy-low candidate, find the max price reached AFTER its timestamp.
// That's the swing-trade upside.
const results = [];
const TARGETS = [0.10, 0.12, 0.15, 0.18, 0.20]; // recovery thresholds to evaluate

for (const shadow of buyLowShadows) {
  const ticker = shadow.ticker;
  const entryPrice = shadow.decisionPrice;
  const entryTs = new Date(shadow.ts).getTime();
  const tape = tapeByTicker.get(ticker) ?? [];

  // Only consider tape entries AFTER our shadow entry, BEFORE settlement
  const tapePost = tape.filter(t => new Date(t.ts).getTime() > entryTs);

  let maxPriceAfter = entryPrice;
  let maxPriceTs = entryTs;
  let minPriceAfter = entryPrice;
  for (const t of tapePost) {
    if (t.price > maxPriceAfter) {
      maxPriceAfter = t.price;
      maxPriceTs = new Date(t.ts).getTime();
    }
    if (t.price < minPriceAfter) minPriceAfter = t.price;
  }

  const maxRecovery = maxPriceAfter - entryPrice;
  const maxDrawdown = entryPrice - minPriceAfter;
  const minutesToPeak = (maxPriceTs - entryTs) / (1000 * 60);

  const targetsHit = {};
  for (const t of TARGETS) targetsHit[`+${(t*100).toFixed(0)}c`] = maxRecovery >= t;

  results.push({
    ticker, entryPrice, maxPriceAfter, maxRecovery, maxDrawdown,
    minutesToPeak, ourPickWon: shadow.ourPickWon,
    sport: shadow.sport, league: shadow.league,
    period: shadow.period, scoreDiff: shadow.scoreDiff,
    buyLowReason: shadow.buyLowReason,
    targetsHit,
    settled: shadow.ourPickWon !== undefined && shadow.ourPickWon !== null,
  });
}

// === SUMMARY ===
const settled = results.filter(r => r.settled);
console.log(`=== SETTLED BUY-LOW CANDIDATES (${settled.length} of ${results.length}) ===\n`);

// Game-level WR (did trailing team eventually win?)
const wins = settled.filter(r => r.ourPickWon === true).length;
console.log(`Game-level WR: ${wins}/${settled.length} = ${(wins/settled.length*100).toFixed(0)}%`);
console.log(`Break-even WR @ avg entry ${(settled.reduce((a,r)=>a+r.entryPrice,0)/settled.length*100).toFixed(0)}¢: ~${(settled.reduce((a,r)=>a+r.entryPrice,0)/settled.length*100).toFixed(0)}%`);

// Recovery rates
console.log(`\n=== INTRA-GAME PRICE RECOVERY (the swing-trade thesis) ===`);
for (const t of TARGETS) {
  const key = `+${(t*100).toFixed(0)}c`;
  const hit = results.filter(r => r.targetsHit[key]).length;
  console.log(`  ${key} recovery target: ${hit}/${results.length} (${(hit/results.length*100).toFixed(0)}%) reached this target at some point`);
}

// EV calculation for swing-trade exit at +12¢
const swingExit = 0.12;
let totalSwingPnl = 0;
let swingWins = 0;
for (const r of results) {
  if (r.maxRecovery >= swingExit) {
    totalSwingPnl += swingExit;
    swingWins++;
  } else {
    // If didn't hit target, settles based on game outcome
    if (r.ourPickWon === true) totalSwingPnl += (1 - r.entryPrice);
    else if (r.ourPickWon === false) totalSwingPnl += -r.entryPrice;
    // If unsettled, ignore
  }
}
const validForEv = results.filter(r => r.maxRecovery >= swingExit || r.ourPickWon !== null);
console.log(`\n=== HYPOTHETICAL P&L (sell at +${(swingExit*100).toFixed(0)}c if reached) ===`);
console.log(`Swing-exit hits: ${swingWins}/${validForEv.length} (${(swingWins/validForEv.length*100).toFixed(0)}%)`);
console.log(`Sum P&L per contract: $${totalSwingPnl.toFixed(2)} across ${validForEv.length} hypothetical trades`);
console.log(`Average per trade: $${(totalSwingPnl/Math.max(1, validForEv.length)).toFixed(3)}/contract`);

// By sport
console.log(`\n=== BY SPORT ===`);
const sports = ['MLB', 'NBA', 'NHL'];
for (const sport of sports) {
  const slice = results.filter(r => r.sport === sport);
  if (slice.length === 0) continue;
  const settledN = slice.filter(r => r.settled).length;
  const winsN = slice.filter(r => r.ourPickWon === true).length;
  const recovery15 = slice.filter(r => r.maxRecovery >= 0.15).length;
  const avgRec = slice.reduce((a,r) => a + r.maxRecovery, 0) / slice.length;
  console.log(`  ${sport}: n=${slice.length} | settled=${settledN} | game-WR=${(winsN/Math.max(1,settledN)*100).toFixed(0)}% | recover≥15¢=${(recovery15/slice.length*100).toFixed(0)}% | avg max-recovery=${(avgRec*100).toFixed(0)}¢`);
}

// By buyLowReason (specific cell)
console.log(`\n=== BY CELL ===`);
const byCell = {};
for (const r of results) {
  const k = r.buyLowReason || '?';
  if (!byCell[k]) byCell[k] = { n: 0, settled: 0, wins: 0, recovery15: 0, sumRec: 0 };
  byCell[k].n++;
  if (r.settled) byCell[k].settled++;
  if (r.ourPickWon === true) byCell[k].wins++;
  if (r.maxRecovery >= 0.15) byCell[k].recovery15++;
  byCell[k].sumRec += r.maxRecovery;
}
for (const [k, v] of Object.entries(byCell).sort((a,b) => b[1].n - a[1].n)) {
  if (v.n < 3) continue;
  const wr = v.settled > 0 ? (v.wins/v.settled*100).toFixed(0) : '-';
  const rec = (v.recovery15/v.n*100).toFixed(0);
  const avgRec = (v.sumRec/v.n*100).toFixed(0);
  console.log(`  ${k.padEnd(28)} n=${v.n.toString().padStart(3)} | game-WR=${wr}% | recover≥15¢=${rec}% | avg max-rec=${avgRec}¢`);
}

console.log(`\n=== VERDICT ===`);
const overallRecovery15 = results.filter(r => r.maxRecovery >= 0.15).length / results.length;
if (settled.length < 30) {
  console.log(`⚠️  Only ${settled.length} settled candidates. Need n ≥ 30 for reliable verdict. Wait more days.`);
} else if (overallRecovery15 >= 0.60 && wins/settled.length >= 0.40) {
  console.log(`✅ STRONG SIGNAL: ${(overallRecovery15*100).toFixed(0)}% recover ≥15¢, ${(wins/settled.length*100).toFixed(0)}% game-WR.`);
  console.log(`Recommendation: ship Phase 3 with $2/trade size cap, focus on top-performing cells above.`);
} else if (overallRecovery15 >= 0.45 && wins/settled.length >= 0.30) {
  console.log(`🟡 MARGINAL SIGNAL: ${(overallRecovery15*100).toFixed(0)}% recover, ${(wins/settled.length*100).toFixed(0)}% game-WR.`);
  console.log(`Recommendation: cherry-pick the 1-2 best cells from the per-cell table; skip rest.`);
} else {
  console.log(`❌ THESIS REJECTED: ${(overallRecovery15*100).toFixed(0)}% recover ≥15¢, ${(wins/settled.length*100).toFixed(0)}% game-WR.`);
  console.log(`Recommendation: don't ship Phase 3. Trailing-team swing trades aren't +EV in this market.`);
}
