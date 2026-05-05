#!/usr/bin/env node
/**
 * Telemetry health check — runs daily after auto-discovery (~6:35am ET).
 * Verifies that critical observability streams are actually capturing data.
 * Catches silent failures like the CLV bug from 2026-05-05 (0/99 captures).
 *
 * EXITS NONZERO if any critical metric is broken — so cron can email on failure.
 *
 * Checks:
 *   1. CLV: does any pre-game trade in last 7d have clv field populated?
 *   2. Pre-game shadow ourPickWon: at least 5% of recent claude-no records
 *   3. MFE tracking: at least 60% of last 7d closed trades have maxFavorablePrice
 *   4. Trade volume: any trades placed in last 24h?
 *   5. Calibration log: was bot/logs/calibration-log.json updated in last 36h?
 *   6. Auto-discovery output: discovered-cells.json updated in last 36h?
 *
 * Output: console summary + bot/logs/health-check.log line per run.
 */

import { readFileSync, existsSync, statSync, appendFileSync } from 'fs';

const TRADES_LOG = './bot/logs/trades.jsonl';
const SHADOW_LOG = './bot/logs/shadow-decisions.jsonl';
const CALIB_LOG = './bot/logs/calibration-log.json';
const DISCOVER_LOG = './bot/logs/discovered-cells.json';
const HEALTH_LOG = './bot/logs/health-check.log';

const NOW = Date.now();
const D7_AGO = NOW - 7 * 86400000;
const D1_AGO = NOW - 1 * 86400000;
const H36_AGO = NOW - 36 * 3600000;

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '🔴'} ${name}: ${detail}`);
}

console.log(`\n=== ARBOR TELEMETRY HEALTH CHECK — ${new Date().toISOString()} ===\n`);

const trades = readJsonl(TRADES_LOG);
const shadow = readJsonl(SHADOW_LOG);

// 1. CLV capture
const recentPg = trades.filter(t =>
  (t.strategy?.startsWith('pre-game-') || t.strategy === 'draw-bet') &&
  t.timestamp && new Date(t.timestamp).getTime() >= D7_AGO);
const withClv = recentPg.filter(t => typeof t.clv === 'number');
check(
  'CLV capture (last 7d pre-game)',
  recentPg.length === 0 || withClv.length > 0,
  recentPg.length === 0
    ? 'no pre-game trades to check'
    : `${withClv.length}/${recentPg.length} have clv field (${(withClv.length / recentPg.length * 100).toFixed(0)}%)`
);

// 2. Pre-game shadow ourPickWon population (last 7d)
const recentClaudeNo = shadow.filter(s =>
  s.stage === 'pre-game' && s.decision === 'no-trade' && s.rejectReason === 'claude-no' &&
  s.status === 'settled' && s.ts && new Date(s.ts).getTime() >= D7_AGO);
const withOurPick = recentClaudeNo.filter(s => s.ourPickWon != null);
check(
  'Pre-game shadow ourPickWon (last 7d claude-no)',
  recentClaudeNo.length === 0 || (withOurPick.length / recentClaudeNo.length) >= 0.30,
  recentClaudeNo.length === 0
    ? 'no recent claude-no records'
    : `${withOurPick.length}/${recentClaudeNo.length} populated (${(withOurPick.length / recentClaudeNo.length * 100).toFixed(0)}%) — should be ≥30%`
);

// 3. MFE tracking on recent closed trades
const recentClosed = trades.filter(t =>
  t.realizedPnL != null &&
  !['testing-void', 'failed-bug', 'voided-no-fill'].includes(t.status) &&
  t.timestamp && new Date(t.timestamp).getTime() >= D7_AGO);
const withMfe = recentClosed.filter(t => t.maxFavorablePrice != null);
check(
  'MFE tracking (last 7d closed)',
  recentClosed.length < 5 || (withMfe.length / recentClosed.length) >= 0.60,
  recentClosed.length < 5
    ? `only ${recentClosed.length} closed trades (insufficient)`
    : `${withMfe.length}/${recentClosed.length} have maxFavorablePrice (${(withMfe.length / recentClosed.length * 100).toFixed(0)}%) — should be ≥60%`
);

// 4. Trade volume — any trades in last 24h?
const last24h = trades.filter(t =>
  t.timestamp && new Date(t.timestamp).getTime() >= D1_AGO &&
  !['testing-void', 'failed-bug'].includes(t.status));
check(
  'Trade volume (last 24h)',
  last24h.length > 0,
  `${last24h.length} trades in last 24h`
);

// 5. Calibration log updated
let calibAge = Infinity;
if (existsSync(CALIB_LOG)) calibAge = NOW - statSync(CALIB_LOG).mtimeMs;
check(
  'Calibration log freshness',
  calibAge < 36 * 3600000,
  existsSync(CALIB_LOG) ? `last updated ${(calibAge / 3600000).toFixed(1)}h ago` : 'file missing'
);

// 6. Auto-discovery log updated
let discAge = Infinity;
if (existsSync(DISCOVER_LOG)) discAge = NOW - statSync(DISCOVER_LOG).mtimeMs;
check(
  'Auto-discovery output freshness',
  discAge < 36 * 3600000,
  existsSync(DISCOVER_LOG) ? `last updated ${(discAge / 3600000).toFixed(1)}h ago` : 'file missing'
);

const failed = checks.filter(c => !c.ok);
console.log(`\n=== SUMMARY: ${checks.length - failed.length}/${checks.length} checks passed ===`);
if (failed.length > 0) {
  console.log('FAILURES:');
  for (const f of failed) console.log(`  🔴 ${f.name}`);
}

// Append to log file for trend tracking
const logLine = `${new Date().toISOString()} | ${checks.length - failed.length}/${checks.length} | ${failed.map(f => f.name).join(';') || 'all-ok'}\n`;
try { appendFileSync(HEALTH_LOG, logLine); } catch {}

process.exit(failed.length > 0 ? 1 : 0);
