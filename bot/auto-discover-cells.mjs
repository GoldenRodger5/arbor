#!/usr/bin/env node
/**
 * Auto-discover candidate structural cells from shadow data.
 *
 * Runs daily at 6:30am ET (after calibration). Scans live-edge claude-no
 * shadow records for (sport × period × diff × price-band) buckets where
 * BOTH leader-side and trailer-side EV math show +EV. Compares against
 * existing structural cell coverage. Outputs a candidate cells report
 * with optimal exit policy + verdict.
 *
 * Output: bot/logs/discovered-cells.json + console markdown.
 *
 * Usage:
 *   node bot/auto-discover-cells.mjs                # report only
 *   node bot/auto-discover-cells.mjs --since 7d     # last 7 days only
 *
 * The script is read-only. It does NOT modify any code or trading logic.
 * Human review required before adding any candidate as a real cell.
 */

import { readFileSync, writeFileSync } from 'fs';

const SHADOW_LOG = './bot/logs/shadow-decisions.jsonl';
const TRADES_LOG = './bot/logs/trades.jsonl';
const OUTPUT_LOG = './bot/logs/discovered-cells.json';
const sinceArg = process.argv.find(a => a.startsWith('--since'));
const SINCE_DAYS = sinceArg ? parseInt(sinceArg.split('=')[1] || '14') : 14;
const SINCE_MS = Date.now() - SINCE_DAYS * 86400000;

const MIN_GAMES = 8;       // need at least 8 unique games per bucket
const MIN_EV = 0.05;       // 5c per fire minimum to flag as candidate
const PRICE_BAND = 0.05;   // 5c price-band granularity

const gameKey = (t, target) => t ? t.split('-').slice(0, -1).join('-') + '|' + (target || '?') : null;

function wilson95Lo(w, n) {
  if (n === 0) return 0;
  const p = w / n, z = 1.96, denom = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return Math.max(0, (center - margin) / denom);
}

const shadowRaw = readFileSync(SHADOW_LOG, 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const tradesRaw = readFileSync(TRADES_LOG, 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const data = shadowRaw.filter(s =>
  s.stage === 'live-edge' && s.decision === 'no-trade' && s.rejectReason === 'claude-no' &&
  s.maxPriceAfterEntry != null && s.minPriceAfterEntry != null && s.decisionPrice != null &&
  s.status === 'settled' && s.ourPickWon != null &&
  new Date(s.ts || 0).getTime() >= SINCE_MS);

console.log(`\n=== AUTO-DISCOVERY — ${new Date().toISOString()} ===`);
console.log(`Window: last ${SINCE_DAYS}d, ${data.length} settled shadow records with MFE\n`);

// Catalog existing cells by their conditions (rough — manual list, kept in sync via comments)
// Each entry: a function that returns true if a (league, period, diff, side) is covered.
const existingCellCoverage = [
  // MLB leader cells
  { name: 'mlb-inn-1-leader-1run', match: (l,p,d,side,px) => l==='mlb' && p===1 && d===1 && side==='leader' && px>=0.55 && px<=0.75 },
  { name: 'mlb-inn-1-leader-2run', match: (l,p,d,side,px) => l==='mlb' && p===1 && d===2 && side==='leader' && px>=0.60 && px<=0.82 },
  { name: 'mlb-inn-1-leader-3plus', match: (l,p,d,side,px) => l==='mlb' && p===1 && d>=3 && side==='leader' && px<=0.88 },
  { name: 'mlb-inn-2-leader', match: (l,p,d,side,px) => l==='mlb' && p===2 && d>=1 && d<=2 && side==='leader' && px>=0.50 && px<=0.88 },
  { name: 'mlb-inn-2-leader-3plus', match: (l,p,d,side,px) => l==='mlb' && p===2 && d>=3 && side==='leader' && px>=0.55 && px<=0.88 },
  { name: 'mlb-inn-3-leader-2run', match: (l,p,d,side,px) => l==='mlb' && p===3 && d===2 && side==='leader' && px>=0.60 && px<=0.88 },
  { name: 'mlb-inn-3-leader-3plus', match: (l,p,d,side,px) => l==='mlb' && p===3 && d>=3 && side==='leader' && px<=0.88 },
  { name: 'mlb-inn-4-leader', match: (l,p,d,side,px) => l==='mlb' && p===4 && d>=1 && side==='leader' && px>=0.50 && px<=0.82 },
  { name: 'mlb-inn-5-7-leader', match: (l,p,d,side,px) => l==='mlb' && p>=5 && p<=7 && d>=2 && side==='leader' },
  { name: 'mlb-inn-5-leader-3run', match: (l,p,d,side,px) => l==='mlb' && p===5 && d>=3 && side==='leader' && px<=0.88 },
  { name: 'mlb-inn-6-leader', match: (l,p,d,side,px) => l==='mlb' && p===6 && d>=1 && side==='leader' && px>=0.46 && px<=0.70 },
  { name: 'mlb-inn-89-leader', match: (l,p,d,side,px) => l==='mlb' && p>=8 && d>=1 && side==='leader' && px>=0.70 && px<=0.90 },
  { name: 'score-event-arb (MLB)', match: (l,p,d,side,px) => l==='mlb' && p<=8 && d>=2 && side==='leader' },
  // MLB trailer cells (NEW today)
  { name: 'mlb-late-trailer-d1', match: (l,p,d,side,px) => l==='mlb' && p>=5 && p<=7 && d===1 && side==='trailer' && px>=0.25 && px<=0.40 },
  { name: 'mlb-early-trailer-d1', match: (l,p,d,side,px) => l==='mlb' && p>=1 && p<=2 && d===1 && side==='trailer' && px>=0.30 && px<=0.45 },
  // NHL/NBA cells
  { name: 'nhl-p2-leader-1goal', match: (l,p,d,side,px) => l==='nhl' && p===2 && d===1 && side==='leader' && px>=0.50 && px<=0.78 },
  { name: 'nhl-p3-closing-out', match: (l,p,d,side,px) => l==='nhl' && p===3 && d>=1 && side==='leader' },
  { name: 'nhl-empty-net-trailer', match: (l,p,d,side,px) => l==='nhl' && p===3 && side==='trailer' && px<=0.20 },
  { name: 'nba-q2-leader', match: (l,p,d,side,px) => l==='nba' && p===2 && d>=1 && side==='leader' },
  { name: 'nba-q4-leader', match: (l,p,d,side,px) => l==='nba' && p===4 && d>=1 && side==='leader' },
  { name: 'nba-q4-deep-trailer', match: (l,p,d,side,px) => l==='nba' && p===4 && d>=8 && side==='trailer' && px<=0.25 },
];

function isCovered(league, period, diff, side, priceMid) {
  return existingCellCoverage.some(c => c.match(league, period, diff, side, priceMid));
}

// Build buckets: (league × period × diff × price-band)
const buckets = {};
for (const r of data) {
  const priceBand = Math.floor(r.decisionPrice / PRICE_BAND) * PRICE_BAND;
  const k = `${r.league || '?'}|P${r.period}|d${r.scoreDiff || '?'}|${(priceBand * 100).toFixed(0)}c`;
  if (!buckets[k]) buckets[k] = { records: [], league: r.league, period: r.period, diff: r.scoreDiff, priceBand };
  const gk = gameKey(r.ticker, r.targetAbbr);
  // Dedupe to one record per game+side
  if (!buckets[k].records.find(x => gameKey(x.ticker, x.targetAbbr) === gk)) {
    buckets[k].records.push(r);
  }
}

const candidates = [];
for (const k in buckets) {
  const { records, league, period, diff, priceBand } = buckets[k];
  if (records.length < MIN_GAMES) continue;

  // LEADER side analysis
  const lWins = records.filter(r => r.ourPickWon).length;
  const lWR = lWins / records.length;
  const lCiLo = wilson95Lo(lWins, records.length);
  const lAvgEntry = records.reduce((s, r) => s + r.decisionPrice, 0) / records.length;
  const lSettleEV = lWR * (1 - lAvgEntry) - (1 - lWR) * lAvgEntry;
  let lBestLock = 0, lBestEV = lSettleEV;
  for (let pct = 5; pct <= 30; pct += 1) {
    const lock = pct / 100;
    const hr = records.filter(r => (r.maxPriceAfterEntry - r.decisionPrice) >= lock).length / records.length;
    const ev = hr * lock + (1 - hr) * lSettleEV;
    if (ev > lBestEV) { lBestEV = ev; lBestLock = pct; }
  }

  // TRAILER side analysis
  const tWins = records.filter(r => !r.ourPickWon).length;
  const tWR = tWins / records.length;
  const tCiLo = wilson95Lo(tWins, records.length);
  const tAvgEntry = 1 - lAvgEntry;
  const tSettleEV = tWR * (1 - tAvgEntry) - (1 - tWR) * tAvgEntry;
  let tBestLock = 0, tBestEV = tSettleEV;
  for (let pct = 5; pct <= 35; pct += 1) {
    const lock = pct / 100;
    const hr = records.filter(r => (r.decisionPrice - r.minPriceAfterEntry) >= lock).length / records.length;
    const ev = hr * lock + (1 - hr) * tSettleEV;
    if (ev > tBestEV) { tBestEV = ev; tBestLock = pct; }
  }

  // Determine winning side
  let side = null, ev = 0, lock = 0, wr = 0, entry = 0, ciLo = 0;
  if (lBestEV >= MIN_EV && lCiLo > 0.40) {
    side = 'leader'; ev = lBestEV; lock = lBestLock; wr = lWR; entry = lAvgEntry; ciLo = lCiLo;
  }
  if (tBestEV >= MIN_EV && tCiLo > 0.20 && tBestEV > ev) {
    side = 'trailer'; ev = tBestEV; lock = tBestLock; wr = tWR; entry = tAvgEntry; ciLo = tCiLo;
  }
  if (!side) continue;

  const priceMid = priceBand + PRICE_BAND / 2;
  const covered = isCovered(league, period, diff, side, priceMid);

  candidates.push({
    bucket: k,
    league, period, diff, priceBand: Math.round(priceBand * 100), priceMid,
    n: records.length, side, wr, ciLo, entry,
    optimalLock: lock, evPerFire: ev,
    covered, status: covered ? 'COVERED' : 'NEW-CANDIDATE',
  });
}

candidates.sort((a, b) => b.evPerFire - a.evPerFire);

// Console report
console.log('=== ALL CANDIDATES (sorted by EV/fire) ===');
console.log('rank | bucket | n | side | WR | CI-lo | entry | lock | EV/fire | status');
for (let i = 0; i < Math.min(20, candidates.length); i++) {
  const c = candidates[i];
  console.log(`  ${i + 1}. ${c.bucket} n=${c.n} ${c.side.toUpperCase()} WR=${(c.wr * 100).toFixed(0)}% CI=${(c.ciLo * 100).toFixed(0)}% px=${(c.entry * 100).toFixed(0)}c lock=+${c.optimalLock}c EV=${(c.evPerFire * 100).toFixed(1)}c [${c.status}]`);
}

// New candidates
const newCandidates = candidates.filter(c => !c.covered);
console.log(`\n=== NEW CANDIDATE CELLS (${newCandidates.length}) ===`);
if (newCandidates.length === 0) {
  console.log('  No new candidates beyond current coverage. System is at coverage ceiling for current data.');
} else {
  for (const c of newCandidates) {
    console.log(`  🆕 ${c.bucket} ${c.side} WR=${(c.wr * 100).toFixed(0)}% lock=+${c.optimalLock}c EV=${(c.evPerFire * 100).toFixed(1)}c (n=${c.n})`);
  }
}

// Cells losing money (negative EV signals — reverse opportunity?)
const negativeCandidates = [];
for (const k in buckets) {
  const { records, league, period, diff } = buckets[k];
  if (records.length < MIN_GAMES) continue;
  const lWR = records.filter(r => r.ourPickWon).length / records.length;
  const lAvgEntry = records.reduce((s, r) => s + r.decisionPrice, 0) / records.length;
  const lSettleEV = lWR * (1 - lAvgEntry) - (1 - lWR) * lAvgEntry;
  if (lSettleEV < -0.05) {
    negativeCandidates.push({ bucket: k, lWR, lAvgEntry, lSettleEV, n: records.length });
  }
}
console.log(`\n=== BUCKETS WHERE LEADER IS DEEPLY -EV (potential structural fires being prevented correctly) ===`);
negativeCandidates.sort((a, b) => a.lSettleEV - b.lSettleEV).slice(0, 5).forEach(c =>
  console.log(`  ${c.bucket} n=${c.n} leader-WR=${(c.lWR * 100).toFixed(0)}% px=${(c.lAvgEntry * 100).toFixed(0)}c settleEV=${(c.lSettleEV * 100).toFixed(1)}c`)
);

// Write JSON output
const output = {
  generated: new Date().toISOString(),
  windowDays: SINCE_DAYS,
  recordsAnalyzed: data.length,
  totalCandidates: candidates.length,
  newCandidates: newCandidates.length,
  candidates: candidates.slice(0, 50),
  newCandidatesDetail: newCandidates,
};
writeFileSync(OUTPUT_LOG, JSON.stringify(output, null, 2) + '\n');
console.log(`\n✓ Discovered cells written to ${OUTPUT_LOG}`);
console.log(`  Total candidates: ${candidates.length}`);
console.log(`  NEW (uncovered): ${newCandidates.length}`);
