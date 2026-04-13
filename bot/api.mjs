/**
 * Arbor Data API — serves bot data to the UI
 *
 * Reads from the bot's JSONL log files and serves via HTTP.
 * Run alongside the bot: node api.mjs
 * Default port: 3456
 */

import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.API_PORT ?? 3456;
const API_TOKEN = process.env.API_TOKEN ?? 'arbor-2026';
const TRADES_LOG = join(__dirname, 'logs/trades.jsonl');
const DAILY_LOG = join(__dirname, 'logs/daily-snapshots.jsonl');
const SCREENS_LOG = join(__dirname, 'logs/screens.jsonl');

function readJsonl(path) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function getSportFromTicker(ticker) {
  if (!ticker) return 'other';
  if (ticker.includes('MLB')) return 'mlb';
  if (ticker.includes('NBA')) return 'nba';
  if (ticker.includes('NHL')) return 'nhl';
  if (ticker.includes('MLS')) return 'mls';
  if (ticker.includes('EPL')) return 'epl';
  if (ticker.includes('LALIGA')) return 'laliga';
  if (ticker.toLowerCase().includes('ufc')) return 'ufc';
  return 'other';
}

function handleRequest(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Simple token auth — pass ?token=xxx or Authorization: Bearer xxx
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token') ?? req.headers.authorization?.replace('Bearer ', '');
  if (token !== API_TOKEN) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }
  const path = url.pathname;

  try {
    if (path === '/api/trades') {
      const trades = readJsonl(TRADES_LOG);
      json(res, trades);

    } else if (path === '/api/positions') {
      const trades = readJsonl(TRADES_LOG);
      const open = trades.filter(t => t.status === 'open');
      json(res, open);

    } else if (path === '/api/stats') {
      const trades = readJsonl(TRADES_LOG);
      const snapshots = readJsonl(DAILY_LOG);
      const settled = trades.filter(t => t.status === 'settled' || t.status?.startsWith('sold-'));
      const open = trades.filter(t => t.status === 'open');
      const wins = settled.filter(t => (t.realizedPnL ?? 0) > 0);
      const losses = settled.filter(t => (t.realizedPnL ?? 0) < 0);
      const totalPnL = settled.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);

      // Today's trades
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayTrades = trades.filter(t => new Date(t.timestamp) >= todayStart);
      const todaySettled = todayTrades.filter(t => t.status === 'settled' || t.status?.startsWith('sold-'));
      const todayPnL = todaySettled.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);

      // Best/worst trade
      const bestTrade = settled.reduce((best, t) => (t.realizedPnL ?? 0) > (best?.realizedPnL ?? -Infinity) ? t : best, null);
      const worstTrade = settled.reduce((worst, t) => (t.realizedPnL ?? 0) < (worst?.realizedPnL ?? Infinity) ? t : worst, null);

      // Sport performance
      const sportMap = {};
      for (const t of settled) {
        const sport = getSportFromTicker(t.ticker);
        if (!sportMap[sport]) sportMap[sport] = { sport, trades: 0, wins: 0, losses: 0, pnl: 0 };
        sportMap[sport].trades++;
        if ((t.realizedPnL ?? 0) > 0) sportMap[sport].wins++;
        else sportMap[sport].losses++;
        sportMap[sport].pnl += t.realizedPnL ?? 0;
      }
      for (const s of Object.values(sportMap)) {
        s.winRate = s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0;
        s.pnl = Math.round(s.pnl * 100) / 100;
      }

      // Strategy performance
      const stratMap = {};
      for (const t of trades) {
        const strat = t.strategy ?? 'unknown';
        if (!stratMap[strat]) stratMap[strat] = { strategy: strat, trades: 0, settled: 0, wins: 0, losses: 0, pnl: 0 };
        stratMap[strat].trades++;
        if (t.status === 'settled' || t.status?.startsWith('sold-')) {
          stratMap[strat].settled++;
          if ((t.realizedPnL ?? 0) > 0) stratMap[strat].wins++;
          else stratMap[strat].losses++;
          stratMap[strat].pnl += t.realizedPnL ?? 0;
        }
      }
      for (const s of Object.values(stratMap)) {
        s.winRate = s.settled > 0 ? Math.round((s.wins / s.settled) * 100) : 0;
        s.pnl = Math.round(s.pnl * 100) / 100;
      }

      // Calibration buckets
      const buckets = [
        { label: '65-70%', min: 0.65, max: 0.70, total: 0, wins: 0 },
        { label: '70-75%', min: 0.70, max: 0.75, total: 0, wins: 0 },
        { label: '75-80%', min: 0.75, max: 0.80, total: 0, wins: 0 },
        { label: '80-85%', min: 0.80, max: 0.85, total: 0, wins: 0 },
        { label: '85-90%', min: 0.85, max: 0.90, total: 0, wins: 0 },
        { label: '90%+', min: 0.90, max: 1.01, total: 0, wins: 0 },
      ];
      for (const t of settled) {
        if (t.confidence == null) continue;
        for (const b of buckets) {
          if (t.confidence >= b.min && t.confidence < b.max) {
            b.total++;
            if ((t.realizedPnL ?? 0) > 0) b.wins++;
            break;
          }
        }
      }
      const calibration = buckets.filter(b => b.total > 0).map(b => ({
        ...b,
        actualWinRate: Math.round((b.wins / b.total) * 100),
      }));

      // Win streak
      let streak = 0;
      let streakType = 'none';
      for (let i = settled.length - 1; i >= 0; i--) {
        const won = (settled[i].realizedPnL ?? 0) > 0;
        if (i === settled.length - 1) { streakType = won ? 'win' : 'loss'; streak = 1; }
        else if ((streakType === 'win' && won) || (streakType === 'loss' && !won)) streak++;
        else break;
      }

      json(res, {
        totalTrades: trades.length,
        settledTrades: settled.length,
        openTrades: open.length,
        wins: wins.length,
        losses: losses.length,
        winRate: settled.length > 0 ? Math.round((wins.length / settled.length) * 100) : null,
        totalPnL: Math.round(totalPnL * 100) / 100,
        todayTrades: todayTrades.length,
        todaySettled: todaySettled.length,
        todayPnL: Math.round(todayPnL * 100) / 100,
        bestTrade: bestTrade ? { title: bestTrade.title, pnl: bestTrade.realizedPnL, ticker: bestTrade.ticker } : null,
        worstTrade: worstTrade ? { title: worstTrade.title, pnl: worstTrade.realizedPnL, ticker: worstTrade.ticker } : null,
        streak,
        streakType,
        sportPerformance: Object.values(sportMap),
        strategyPerformance: Object.values(stratMap),
        calibration,
        latestSnapshot: snapshots.length > 0 ? snapshots[snapshots.length - 1] : null,
      });

    } else if (path === '/api/snapshots') {
      const snapshots = readJsonl(DAILY_LOG);
      json(res, snapshots);

    } else if (path === '/api/screens') {
      const screens = readJsonl(SCREENS_LOG);
      // Return last 100
      json(res, screens.slice(-100));

    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (e) {
    console.error('[api] error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`[api] Arbor data API running on port ${PORT}`);
});
