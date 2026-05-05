#!/usr/bin/env node
// Conviction-lock shadow analysis.
// Run on Hetzner: cd /root/arbor && node bot/analyze-conviction-lock.mjs
// Counts how many "lock" picks logged, breaks down by tier, sport, tag combo,
// computes WR + Wilson 95% CI lower bound. After 30 days of data accumulates,
// promote the best-performing tier to live trading.

import fs from 'fs';

const shadow = fs.readFileSync('bot/logs/shadow-decisions.jsonl', 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const lockShadow = shadow.filter(s => s.stage === 'pre-game-conviction-shadow');
const settled = lockShadow.filter(s => s.status === 'settled' && s.ourPickWon != null);

function wilson95Lo(wins, n) {
  if (n === 0) return 0;
  const p = wins / n;
  const z = 1.96;
  const denom = 1 + z*z/n;
  return Math.max(0, ((p + z*z/(2*n) - z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / denom));
}

console.log('=== CONVICTION-LOCK SHADOW ANALYSIS — ' + new Date().toISOString() + ' ===\n');

console.log(`Total lock picks logged: ${lockShadow.length}`);
console.log(`Settled with outcome: ${settled.length}`);
console.log(`Pending settlement: ${lockShadow.length - settled.length}\n`);

if (settled.length === 0) {
  console.log('No settled outcomes yet. Re-run after games finish.\n');
  console.log('Recent picks logged:');
  for (const s of lockShadow.slice(-10)) {
    const tier = s.tierStrict ? 'STRICT' : s.tierMedium ? 'MED' : 'LOOSE';
    console.log(`  ${s.ts.slice(0,16)} ${s.ticker} ${tier} conf=${Math.round(s.claudeConfidence*100)}% edge=${s.edgePt}pt tags=[${(s.reasoningTags || []).slice(0,3).join(',')}]`);
  }
  process.exit(0);
}

// Overall WR
const wins = settled.filter(s => s.ourPickWon).length;
const overallWR = (wins / settled.length * 100).toFixed(0);
const overallCI = (wilson95Lo(wins, settled.length) * 100).toFixed(0);
console.log(`OVERALL WR: ${wins}/${settled.length} = ${overallWR}% (CI95-lo: ${overallCI}%)\n`);

// By tier
console.log('=== BY TIER ===');
for (const tier of ['Strict', 'Medium', 'Loose']) {
  const flag = `tier${tier}`;
  const tierRecs = settled.filter(s => s[flag]);
  if (tierRecs.length === 0) { console.log(`  ${tier}: no records`); continue; }
  const w = tierRecs.filter(s => s.ourPickWon).length;
  const wr = (w / tierRecs.length * 100).toFixed(0);
  const ci = (wilson95Lo(w, tierRecs.length) * 100).toFixed(0);
  console.log(`  ${tier}: ${w}/${tierRecs.length} = ${wr}% (CI95-lo: ${ci}%)`);
}

// By sport
console.log('\n=== BY SPORT ===');
const bySport = {};
for (const s of settled) {
  const sp = s.league || s.sport?.toLowerCase() || 'unknown';
  if (!bySport[sp]) bySport[sp] = { n: 0, w: 0 };
  bySport[sp].n++;
  if (s.ourPickWon) bySport[sp].w++;
}
for (const [sp, d] of Object.entries(bySport).sort((a,b) => b[1].n - a[1].n)) {
  const wr = (d.w / d.n * 100).toFixed(0);
  const ci = (wilson95Lo(d.w, d.n) * 100).toFixed(0);
  console.log(`  ${sp}: ${d.w}/${d.n} = ${wr}% (CI95-lo: ${ci}%)`);
}

// By tag (which boost tags actually predict winners?)
console.log('\n=== BY BOOST TAG ===');
const boostTags = ['playoff-home-fav','line-movement','era-gap','star-injury','home-court'];
for (const tag of boostTags) {
  const recs = settled.filter(s => (s.reasoningTags || []).includes(tag));
  if (recs.length === 0) continue;
  const w = recs.filter(s => s.ourPickWon).length;
  const wr = (w / recs.length * 100).toFixed(0);
  const ci = (wilson95Lo(w, recs.length) * 100).toFixed(0);
  console.log(`  ${tag}: ${w}/${recs.length} = ${wr}% (CI95-lo: ${ci}%)`);
}

// MFE analysis (did the price actually go up?)
console.log('\n=== PRICE EVOLUTION (when MFE tracked) ===');
const withMfe = settled.filter(s => s.maxPriceAfterEntry != null && s.decisionPrice != null);
if (withMfe.length > 0) {
  const mfes = withMfe.map(s => s.maxPriceAfterEntry - s.decisionPrice);
  const hit5 = mfes.filter(m => m >= 0.05).length;
  const hit10 = mfes.filter(m => m >= 0.10).length;
  const hit15 = mfes.filter(m => m >= 0.15).length;
  const hit20 = mfes.filter(m => m >= 0.20).length;
  const avgMfe = mfes.reduce((s,m)=>s+m,0) / mfes.length;
  console.log(`  n=${withMfe.length} avg MFE=${(avgMfe*100).toFixed(1)}c`);
  console.log(`  hit +5c:  ${hit5}/${withMfe.length} = ${(hit5/withMfe.length*100).toFixed(0)}%`);
  console.log(`  hit +10c: ${hit10}/${withMfe.length} = ${(hit10/withMfe.length*100).toFixed(0)}%`);
  console.log(`  hit +15c: ${hit15}/${withMfe.length} = ${(hit15/withMfe.length*100).toFixed(0)}%`);
  console.log(`  hit +20c: ${hit20}/${withMfe.length} = ${(hit20/withMfe.length*100).toFixed(0)}%`);
}

// Promotion criteria
console.log('\n=== PROMOTION CRITERIA ===');
const strictRecs = settled.filter(s => s.tierStrict);
if (strictRecs.length >= 20) {
  const w = strictRecs.filter(s => s.ourPickWon).length;
  const ci = wilson95Lo(w, strictRecs.length);
  if (ci >= 0.65) {
    console.log(`  ✅ STRICT tier: n=${strictRecs.length}, CI95-lo ${(ci*100).toFixed(0)}% — READY TO PROMOTE TO LIVE TRADING`);
  } else {
    console.log(`  ⏳ STRICT tier: n=${strictRecs.length}, CI95-lo ${(ci*100).toFixed(0)}% — wait for more data or tighten filters`);
  }
} else {
  console.log(`  ⏳ STRICT tier: only ${strictRecs.length} settled, need 20 for promotion decision`);
}

console.log('\n=== END ===');
