#!/usr/bin/env node
// Verification script for 2026-05-05 deploys.
// Run on Hetzner: cd /root/arbor && node bot/verify-deploys.mjs
// Or locally via SSH: ssh -i ~/.ssh/hetzner_arbor root@87.99.155.128 "cd /root/arbor && node bot/verify-deploys.mjs"

import fs from 'fs';

const DEPLOY_TS = new Date('2026-05-05T03:00:00Z').getTime(); // commits started ~3am UTC
const NOW = Date.now();

const trades = fs.readFileSync('bot/logs/trades.jsonl', 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const shadow = fs.readFileSync('bot/logs/shadow-decisions.jsonl', 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const since = (records, field, ts) => records.filter(r => {
  const t = new Date(r[field] ?? r.timestamp ?? r.ts ?? 0).getTime();
  return t >= ts;
});

console.log('=== ARBOR DEPLOY VERIFICATION — ' + new Date().toISOString() + ' ===\n');

// 1. Did the new/expanded structural cells fire?
console.log('--- STRUCTURAL CELL FIRINGS (post-deploy 2026-05-05) ---');
const newCells = [
  'mlb-inn-2-leader',
  'mlb-inn-3-leader-2run',
  'mlb-inn-4-leader',
  'mlb-inn-5-7-leader',
  'mlb-inn-6-leader',
  'mlb-inn-1-leader-2run',
  'score-event-arb',
  'pre-game-sportsbook-gap',
];
for (const cell of newCells) {
  const fires = shadow.filter(s => s.structuralPattern === cell);
  const recentFires = since(fires, 'ts', DEPLOY_TS);
  const settledRecent = recentFires.filter(s => s.status === 'settled' && s.ourPickWon != null);
  const wr = settledRecent.length > 0
    ? (settledRecent.filter(s => s.ourPickWon).length / settledRecent.length * 100).toFixed(0) + '%'
    : 'pending';
  console.log(`  ${cell}: total=${fires.length}, post-deploy=${recentFires.length} (settled=${settledRecent.length} WR=${wr})`);
}

// 2. Placed trades since deploy
console.log('\n--- PLACED TRADES SINCE DEPLOY ---');
const recentTrades = since(trades, 'timestamp', DEPLOY_TS);
console.log(`Total: ${recentTrades.length}`);
const byStrat = {};
for (const t of recentTrades) {
  const s = t.strategy ?? '?';
  byStrat[s] = (byStrat[s] || 0) + 1;
}
for (const [s, n] of Object.entries(byStrat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s}: ${n}`);
}

// 3. Pre-game hold-to-settle: any pre-game-prediction stops since deploy?
console.log('\n--- PRE-GAME EXIT BEHAVIOR ---');
const pgRecent = recentTrades.filter(t => t.strategy === 'pre-game-prediction' && t.status);
const pgStops = pgRecent.filter(t => t.status?.includes('stop') || t.status?.includes('bleed') || t.status?.includes('nuclear'));
console.log(`  Pre-game placed: ${pgRecent.length}, stopped: ${pgStops.length} (should be 0 except nuclear)`);
for (const t of pgStops) {
  console.log(`    ! ${t.ticker} status=${t.status} — verify this is nuclear-stop only`);
}

// 4. Bleed-out disable on structural-mlb-inn-* — any inn cell stop-loss exits?
console.log('\n--- STRUCTURAL INN-CELL EXIT BEHAVIOR ---');
const innRecent = recentTrades.filter(t => t.strategy?.startsWith('structural-mlb-inn-') && t.status);
const innStops = innRecent.filter(t => t.status?.includes('bleed') && !t.status?.includes('severe'));
console.log(`  Structural inn-* placed: ${innRecent.length}, bleed-out exits: ${innStops.length} (should be 0)`);
for (const t of innStops) {
  console.log(`    ! ${t.ticker} status=${t.status} — bleed-out should be disabled`);
}

// 5. Score-event-arb post-fix: any NBA fires? Any MLB diff<2? (Should both be 0)
console.log('\n--- SCORE-EVENT-ARB GATE COMPLIANCE ---');
const seaRecent = recentTrades.filter(t => t.strategy === 'structural-score-event-arb');
const seaNba = seaRecent.filter(t => t.league === 'nba');
const seaMlbBadDiff = seaRecent.filter(t => t.league === 'mlb' && (t.scoreDiff || 0) < 2);
const seaLatePeriod = seaRecent.filter(t => (t.periodAtEntry || 0) >= 9);
console.log(`  SEA placed: ${seaRecent.length}`);
console.log(`  NBA fires (should be 0): ${seaNba.length}`);
console.log(`  MLB diff<2 fires (should be 0): ${seaMlbBadDiff.length}`);
console.log(`  Period >= 9 fires (should be 0): ${seaLatePeriod.length}`);

// 6. SEA profit-lock: should now hit at +7c instead of +10c
const seaProfitExits = seaRecent.filter(t => t.status?.includes('profit-lock') && t.exitPrice && t.entryPrice);
if (seaProfitExits.length > 0) {
  const avgGain = seaProfitExits.reduce((s, t) => s + (t.exitPrice - t.entryPrice), 0) / seaProfitExits.length;
  console.log(`  SEA profit-lock avg gain: ${(avgGain * 100).toFixed(1)}c (should be ~7c)`);
}

// 7. Daily PnL since deploy
console.log('\n--- DAILY PNL ---');
const settledRecent = recentTrades.filter(t => t.realizedPnL != null);
const totalPnl = settledRecent.reduce((s, t) => s + t.realizedPnL, 0);
const totalStake = settledRecent.reduce((s, t) => s + (t.deployCost || 0), 0);
const wins = settledRecent.filter(t => t.realizedPnL > 0).length;
const losses = settledRecent.filter(t => t.realizedPnL < 0).length;
console.log(`  Settled trades: ${settledRecent.length} (W=${wins} L=${losses})`);
console.log(`  Total PnL: $${totalPnl.toFixed(2)}`);
console.log(`  Total deployed: $${totalStake.toFixed(2)}`);
if (totalStake > 0) console.log(`  ROI: ${(totalPnl / totalStake * 100).toFixed(1)}%`);

// 8. Pre-game sportsbook-gap — any candidates logged?
console.log('\n--- SPORTSBOOK-GAP DETECTOR ---');
const sbgapCandidates = since(shadow.filter(s => s.stage === 'sportsbook-gap-candidate'), 'ts', DEPLOY_TS);
const sbgapFires = since(shadow.filter(s => s.structuralPattern === 'pre-game-sportsbook-gap'), 'ts', DEPLOY_TS);
console.log(`  Candidates logged: ${sbgapCandidates.length}`);
console.log(`  Cell fires: ${sbgapFires.length}`);
if (sbgapCandidates.length === 0 && sbgapFires.length === 0) {
  console.log('  No data yet — sportsbook-gap detector may not have a games window since deploy');
}

// 9. Live-prediction stops — score-unchanged defer working?
console.log('\n--- LIVE-PREDICTION STOPS ---');
const lpStops = recentTrades.filter(t => t.strategy === 'live-prediction' && t.status?.includes('stop'));
console.log(`  live-prediction stops since deploy: ${lpStops.length}`);
for (const t of lpStops) {
  const correct = t.result === 'correct' || t.gameOutcome === 'correct' ? 'CORRECT (premature)' : 'wrong-pick';
  console.log(`    ${t.league} entry=${Math.round(t.entryPrice * 100)}c exit=${Math.round(t.exitPrice * 100)}c outcome=${correct}`);
}

// 10. Killswitch verification — inn-2 + inn-3-2run actually un-killed
console.log('\n--- KILLSWITCH VERIFICATION ---');
const inn2Fires = shadow.filter(s => s.structuralPattern === 'mlb-inn-2-leader');
const inn3Fires = shadow.filter(s => s.structuralPattern === 'mlb-inn-3-leader-2run');
const inn2RecentFires = since(inn2Fires, 'ts', DEPLOY_TS);
const inn3RecentFires = since(inn3Fires, 'ts', DEPLOY_TS);
console.log(`  inn-2-leader post-deploy fires: ${inn2RecentFires.length} (was 0 — killed before)`);
console.log(`  inn-3-leader-2run post-deploy fires: ${inn3RecentFires.length} (was 0 — killed before)`);
if (inn2RecentFires.length === 0 && inn3RecentFires.length === 0) {
  console.log('  Both 0 — either no qualifying game state has occurred yet, OR killswitch issue. Check by hand.');
}

console.log('\n=== END VERIFICATION ===');
