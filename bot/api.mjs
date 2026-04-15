/**
 * Arbor Data API — serves bot data to the UI
 *
 * Reads from the bot's JSONL log files and serves via HTTP.
 * Run alongside the bot: node api.mjs
 * Default port: 3456
 */

import { readFileSync, writeFileSync, existsSync, statSync, watchFile } from 'fs';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load .env from the bot/ folder regardless of cwd (pm2 runs us from /root/arbor)
loadDotenv({ path: join(__dirname, '.env') });
const PORT = process.env.API_PORT ?? 3456;
const API_TOKEN = process.env.API_TOKEN ?? 'arbor-2026';
const TRADES_LOG = join(__dirname, 'logs/trades.jsonl');
const DAILY_LOG = join(__dirname, 'logs/daily-snapshots.jsonl');
const SCREENS_LOG = join(__dirname, 'logs/screens.jsonl');
const CONTROL_FILE = join(__dirname, 'logs/control.json');
const SELL_REQUESTS_FILE = join(__dirname, 'logs/sell-requests.jsonl');

// ─────────────────────────────────────────────────────────────────────────────
// Control state — persisted to disk so ai-edge.mjs can read it each cycle
// ─────────────────────────────────────────────────────────────────────────────
function readControl() {
  try {
    if (!existsSync(CONTROL_FILE)) return { paused: false, disabledStrategies: [], updatedAt: null };
    return JSON.parse(readFileSync(CONTROL_FILE, 'utf-8'));
  } catch {
    return { paused: false, disabledStrategies: [], updatedAt: null };
  }
}
function writeControl(state) {
  const next = { ...readControl(), ...state, updatedAt: new Date().toISOString() };
  writeFileSync(CONTROL_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE clients — each client is { res, id }. We fan out events on file changes.
// ─────────────────────────────────────────────────────────────────────────────
const sseClients = new Set();
let sseClientId = 0;

function sseSend(client, event, data) {
  try {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch { /* client disconnected */ }
}
function broadcast(event, data) {
  for (const c of sseClients) sseSend(c, event, data);
}

// Watch trades.jsonl and screens.jsonl — broadcast newly-added lines.
function tailWatcher(path, eventName) {
  let lastSize = existsSync(path) ? statSync(path).size : 0;
  watchFile(path, { interval: 1000 }, (curr, prev) => {
    if (curr.size <= lastSize) { lastSize = curr.size; return; }
    try {
      const content = readFileSync(path, 'utf-8');
      const newContent = content.slice(lastSize);
      lastSize = curr.size;
      const lines = newContent.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          broadcast(eventName, data);
        } catch { /* ignore malformed */ }
      }
    } catch { /* ignore read errors */ }
  });
}
tailWatcher(TRADES_LOG, 'trade');
tailWatcher(SCREENS_LOG, 'screen');

// Heartbeat every 25s so proxies/load-balancers don't close idle connections.
setInterval(() => broadcast('ping', { t: Date.now() }), 25_000);

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic client — Haiku for quick summaries. Cached per key.
// ─────────────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.VITE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
const llmCache = new Map(); // key → { at, text }
const LLM_CACHE_TTL_MS = 5 * 60 * 1000;

async function callLLM({ model = 'claude-sonnet-4-6', system, user, maxTokens = 900 }) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY missing');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? '';
}

async function cachedLLM(key, opts) {
  const hit = llmCache.get(key);
  if (hit && Date.now() - hit.at < LLM_CACHE_TTL_MS) return hit.text;
  const text = await callLLM(opts);
  llmCache.set(key, { at: Date.now(), text });
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read POST body as JSON
// ─────────────────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

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

// ─────────────────────────────────────────────────────────────────────────────
// America/New_York day boundaries — the bot operates on US sports markets
// that run on ET, so "today"/"yesterday" should match ET, not UTC. Without
// this, dashboard stats lag by 4-5 hours and attribute trades to the wrong day.
// ─────────────────────────────────────────────────────────────────────────────
function etMidnightUTC(daysBack = 0) {
  const now = new Date();
  const dateParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  const offsetStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = parseInt(offsetStr.replace('GMT', '')) || -5;
  const utcMidnight = Date.UTC(
    parseInt(dateParts.year),
    parseInt(dateParts.month) - 1,
    parseInt(dateParts.day),
  ) - offsetHours * 3600_000;
  return new Date(utcMidnight - daysBack * 86_400_000);
}

/**
 * Read the most recent [portfolio] line from ai-out.log. The bot logs this
 * each cycle with the authoritative Kalshi + Poly balances, so we use it
 * as the source of truth for bankroll instead of the stale daily snapshot.
 */
function readLivePortfolio() {
  try {
    const LOG_FILE = join(__dirname, 'logs/ai-out.log');
    if (!existsSync(LOG_FILE)) return null;
    const stat = statSync(LOG_FILE);
    const size = stat.size;
    const chunk = Math.min(50_000, size);
    const buf = readFileSync(LOG_FILE);
    const slice = buf.subarray(Math.max(0, size - chunk)).toString('utf-8');
    const lines = slice.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/\[portfolio\] Kalshi: \$([\d.]+) cash \+ \$([\d.]+) positions \| Poly: \$([\d.]+)/);
      if (m) {
        const tsMatch = lines[i].match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        return {
          kalshiCash: parseFloat(m[1]),
          kalshiPositions: parseFloat(m[2]),
          polyBalance: parseFloat(m[3]),
          bankroll: parseFloat(m[1]) + parseFloat(m[2]) + parseFloat(m[3]),
          at: tsMatch ? tsMatch[1] + 'Z' : null,
        };
      }
    }
    return null;
  } catch { return null; }
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

async function handleRequest(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    // ─── SSE stream ─────────────────────────────────────────────────────────
    if (path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const client = { res, id: ++sseClientId };
      sseClients.add(client);
      sseSend(client, 'hello', { id: client.id, serverTime: new Date().toISOString() });
      req.on('close', () => { sseClients.delete(client); });
      return;
    }

    // ─── Control endpoints ──────────────────────────────────────────────────
    if (path === '/api/control/status') {
      json(res, { ...readControl(), sseClients: sseClients.size });
      return;
    }
    if (path === '/api/control/pause' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const state = writeControl({ paused: true, pausedReason: body?.reason ?? 'manual' });
      broadcast('control', state);
      json(res, state);
      return;
    }
    if (path === '/api/control/resume' && req.method === 'POST') {
      const state = writeControl({ paused: false, pausedReason: null });
      broadcast('control', state);
      json(res, state);
      return;
    }
    if (path === '/api/control/strategy' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const current = readControl();
      const disabled = new Set(current.disabledStrategies ?? []);
      if (body?.action === 'disable' && body?.strategy) disabled.add(body.strategy);
      if (body?.action === 'enable' && body?.strategy) disabled.delete(body.strategy);
      const state = writeControl({ disabledStrategies: [...disabled] });
      broadcast('control', state);
      json(res, state);
      return;
    }
    // ─── Live scouting — what the bot is watching right now ────────────────
    // Pulls the last ~5 minutes of live-edge decisions, groups per game, and
    // asks Sonnet to write a short "what's on the board right now" note.
    if (path === '/api/live-insight') {
      const screens = readJsonl(SCREENS_LOG);
      const windowMs = 6 * 60 * 1000;
      const cutoff = Date.now() - windowMs;
      const recent = screens.filter(s =>
        (s.stage === 'live-edge' || s.stage === 'live-edge-skip') &&
        new Date(s.timestamp).getTime() >= cutoff
      );

      // Group by game
      const gameMap = new Map();
      for (const s of recent) {
        const key = (s.homeAbbr && s.awayAbbr) ? `${s.awayAbbr}@${s.homeAbbr}` : s.ticker;
        if (!key) continue;
        const game = gameMap.get(key) ?? {
          key, league: s.league, homeAbbr: s.homeAbbr, awayAbbr: s.awayAbbr,
          latest: null, decisions: [],
        };
        if (!game.latest || s.timestamp > game.latest.timestamp) game.latest = s;
        game.decisions.push(s);
        gameMap.set(key, game);
      }

      // Build compact game cards
      const games = [...gameMap.values()].map(g => {
        const d = g.latest ?? {};
        return {
          gameKey: g.key,
          league: g.league ?? null,
          away: g.awayAbbr,
          home: g.homeAbbr,
          score: (d.homeScore != null && d.awayScore != null) ? `${d.awayAbbr} ${d.awayScore} – ${d.homeAbbr} ${d.homeScore}` : null,
          gameDetail: d.gameDetail ?? (d.period != null ? `P${d.period}` : null),
          period: d.period ?? null,
          targetAbbr: d.targetAbbr ?? null,
          price: d.price != null ? Math.round(d.price * 100) : null,
          winExpectancy: d.winExpectancy != null ? Math.round(d.winExpectancy * 100) : null,
          confidence: d.confidence != null ? Math.round(d.confidence * 100) : null,
          result: d.result,
          reasoning: d.reasoning ?? null,
          updatedAt: d.timestamp,
          cycleCount: g.decisions.length,
        };
      }).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

      if (games.length === 0) {
        json(res, {
          games: [],
          insight: 'Nothing live right now. Bot is idle, scanning for opportunities.',
          generatedAt: new Date().toISOString(),
        });
        return;
      }

      // Ask Sonnet for the "what's on the board" take
      const compact = games.slice(0, 6).map(g => {
        const parts = [
          `[${g.league?.toUpperCase() ?? '?'}] ${g.score ?? `${g.away}@${g.home}`} ${g.gameDetail ?? ''}`,
          g.targetAbbr ? `target=${g.targetAbbr}` : '',
          g.price != null ? `price=${g.price}¢` : '',
          g.winExpectancy != null ? `WE=${g.winExpectancy}%` : '',
          g.confidence != null ? `conf=${g.confidence}%` : '',
          `result=${g.result}`,
          g.reasoning ? `reason="${g.reasoning.slice(0, 180)}"` : '',
        ].filter(Boolean);
        return '• ' + parts.join(' · ');
      }).join('\n');

      const cacheKey = `live:${games[0]?.updatedAt ?? ''}:${games.length}`;
      let insight = null;
      try {
        insight = await cachedLLM(cacheKey, {
          model: 'claude-sonnet-4-6',
          maxTokens: 450,
          system:
            `You are explaining to the bot operator what their live-edge trading bot is currently watching and why it's not acting. The reader sees the raw game cards above your text — your job is to add the ONE short pattern observation they can't derive at a glance.

Format: 2-3 short sentences. No bullets, no headings, no preamble.

Be specific about the rule (e.g. "MLB 1-run leads in innings <=6 only 58% WE, below our 75% floor") and what would unlock action (e.g. "a 3+ run lead in the 7th at <78¢ would qualify"). If it's a pattern of market overpricing, say so.`,
          user:
            `Current live-edge candidates (last 6 min):\n\n${compact}\n\nExplain in 2-3 sentences why the bot is holding off and what condition would make it act.`
        });
      } catch (e) { insight = null; }

      json(res, {
        games,
        insight,
        generatedAt: new Date().toISOString(),
        windowMinutes: windowMs / 60_000,
      });
      return;
    }

    // ─── Live-feed LLM summary ─────────────────────────────────────────────
    if (path === '/api/summary') {
      const hours = Math.min(6, parseInt(url.searchParams.get('hours') ?? '1'));
      const LOG_FILE = join(__dirname, 'logs/ai-out.log');
      if (!existsSync(LOG_FILE)) { json(res, { summary: 'No log data available yet.', generatedAt: null }); return; }

      const content = readFileSync(LOG_FILE, 'utf-8');
      const now = Date.now();
      const cutoff = now - hours * 60 * 60 * 1000;
      const recentLines = content.split('\n').filter(l => {
        const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (!m) return false;
        return new Date(m[1].replace(' ', 'T') + 'Z').getTime() >= cutoff;
      }).slice(-400);

      if (recentLines.length === 0) {
        json(res, { summary: 'Quiet — no bot activity in this window.', generatedAt: new Date().toISOString(), lines: 0 });
        return;
      }

      // Condense: keep only interesting lines (trades, skips, analysis, risk, exits)
      const filtered = recentLines.filter(l =>
        /\[(live-edge|pre-game|broad-scan|exit|risk|pnl)\]/.test(l) &&
        !/portfolio|cachedPrices|claude=/.test(l)
      ).slice(-200);

      // Snapshot current bankroll/open state so the summary has stakes
      let contextBlock = '';
      try {
        const trades = readJsonl(TRADES_LOG).filter(t => t.exchange === 'kalshi' && t.status !== 'testing-void');
        const snaps = readJsonl(DAILY_LOG);
        const open = trades.filter(t => t.status === 'open');
        const lastSnap = snaps[snaps.length - 1];
        const snapTime = lastSnap?.timestamp ? new Date(lastSnap.timestamp).getTime() : 0;
        const settledSince = trades
          .filter(t => (t.status === 'settled' || t.status?.startsWith('sold-')) && t.settledAt && new Date(t.settledAt).getTime() > snapTime)
          .reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
        const bankroll = lastSnap ? lastSnap.bankroll + settledSince : null;
        const openList = open.slice(0, 10).map(t => `  • ${t.title} · ${t.side?.toUpperCase()} @ ${Math.round((t.entryPrice ?? 0) * 100)}¢ · conf ${Math.round((t.confidence ?? 0) * 100)}% · deployed $${(t.deployCost ?? 0).toFixed(2)}`).join('\n') || '  (none)';
        contextBlock = `Current state:\n  Bankroll: ${bankroll != null ? '$' + bankroll.toFixed(2) : 'unknown'}\n  Open positions: ${open.length}\n${openList}\n\n`;
      } catch { contextBlock = ''; }

      const cacheKey = `summary:${hours}h:${filtered.length}:${filtered[filtered.length - 1]?.slice(0, 30) ?? ''}`;
      try {
        const summary = await cachedLLM(cacheKey, {
          model: 'claude-sonnet-4-6',
          maxTokens: 700,
          system:
            `You are a sharp, terse operations analyst for a live sports betting bot. The operator is a sophisticated user who wants to understand what the bot has been doing at a glance. Write like a pro trader's morning note: specific, skimmable, actionable.

Output format (markdown, 4-6 short lines, no preamble):
- **Activity:** N opportunities considered, X traded, Y skipped
- **Notable trades / skips:** one concrete example with the *reason*
- **What the bot is watching:** leagues/games currently in scope
- **Risk/health:** anything unusual (errors, pauses, deployment cap, cooldowns)
- **One-line bottom line:** what the operator should take away

Rules:
- Quote actual tickers/teams/prices when possible. Round confidence/price to nearest %.
- Never invent data. If nothing happened, say so in one line.
- Skip filler ("the bot is scanning..."). Assume the reader knows how it works.
- No emoji spam. Use at most one per bullet if it aids scanning.`,
          user:
            `${contextBlock}Activity log (last ${hours}h, ${filtered.length} events, most recent last):\n\n${filtered.slice(-180).join('\n')}\n\nGenerate the summary.`
        });
        json(res, { summary, generatedAt: new Date().toISOString(), lines: filtered.length, hours, model: 'claude-sonnet-4-6' });
      } catch (e) {
        json(res, { summary: `Summary unavailable: ${e.message}`, generatedAt: null, lines: filtered.length });
      }
      return;
    }

    // ─── Recap (daily + weekly) ────────────────────────────────────────────
    if (path === '/api/recap') {
      const raw = (url.searchParams.get('period') ?? 'daily').toLowerCase();
      const period = raw === 'weekly' ? 'weekly' : 'daily';
      const trades = readJsonl(TRADES_LOG).filter(t => t.status !== 'testing-void' && t.exchange === 'kalshi');

      // ET day boundaries — so "yesterday" means the ET day, not UTC.
      const now = new Date();
      const start = period === 'weekly'
        ? now.getTime() - 7 * 864e5
        : etMidnightUTC(1).getTime();
      const end = period === 'weekly'
        ? now.getTime()
        : etMidnightUTC(0).getTime();

      const settled = trades.filter(t => {
        const at = new Date(t.settledAt ?? t.timestamp).getTime();
        return at >= start && at < end && (t.status === 'settled' || t.status?.startsWith('sold-'));
      });
      const placed = trades.filter(t => {
        const at = new Date(t.timestamp).getTime();
        return at >= start && at < end;
      });

      const wins = settled.filter(t => (t.realizedPnL ?? 0) > 0);
      const losses = settled.filter(t => (t.realizedPnL ?? 0) < 0);
      const totalPnL = settled.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);

      const best = settled.reduce((b, t) => (t.realizedPnL ?? 0) > (b?.realizedPnL ?? -Infinity) ? t : b, null);
      const worst = settled.reduce((w, t) => (t.realizedPnL ?? 0) < (w?.realizedPnL ?? Infinity) ? t : w, null);

      // Per sport
      const sportMap = {};
      for (const t of settled) {
        const sport = getSportFromTicker(t.ticker);
        if (!sportMap[sport]) sportMap[sport] = { sport, trades: 0, wins: 0, pnl: 0 };
        sportMap[sport].trades++;
        if ((t.realizedPnL ?? 0) > 0) sportMap[sport].wins++;
        sportMap[sport].pnl += t.realizedPnL ?? 0;
      }

      // Per-sport summary for context in the prompt
      const sportLine = Object.values(sportMap)
        .map(s => `${s.sport.toUpperCase()} ${s.trades}t ${s.wins}W ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`)
        .join(' · ') || '(no settlements)';

      // LLM commentary — Sonnet, richer prompt
      let commentary = null;
      try {
        const compact = settled.slice(-30).map(t => {
          const r = t.reasoning?.slice(0, 200) ?? '';
          const pnl = t.realizedPnL?.toFixed(2) ?? '?';
          return `[${t.ticker}] ${t.title} · ${t.side?.toUpperCase()} @ ${Math.round((t.entryPrice ?? 0) * 100)}¢ · ${pnl != null ? `PnL $${pnl}` : 'open'} · conf ${Math.round((t.confidence ?? 0) * 100)}% · ${r}`;
        }).join('\n');
        const key = `recap:${period}:${start}:${end}:${settled.length}`;
        commentary = await cachedLLM(key, {
          model: 'claude-sonnet-4-6',
          maxTokens: 900,
          system:
            `You are a pro sports bettor reviewing a trading bot's recent performance for its operator. Your goal is an honest, specific, actionable recap. No cheerleading, no hedging.

Output (markdown, ~4 short sections with clear headings):

**What went right** — 2-3 bullets. Name specific trades or patterns. Tie decisions to outcomes.
**What went wrong** — 2-3 bullets. Same standard. Call out process-vs-outcome clearly (a lucky win is not the same as a well-reasoned one).
**The pattern to watch** — 1 bullet. Is the bot systematically over/underconfident in any sport, price band, or game state?
**One concrete action** — 1 sentence. A single, testable change or thing to monitor next period.

Rules:
- Quote actual numbers (tickers, confidence %, prices, PnL). Avoid vague language.
- If the sample is small (<5 settlements), say so and keep conclusions tentative.
- Distinguish outcome from process. "Lost money on a good trade" is valid feedback.
- No preamble, no sign-off.`,
          user:
            `Recap period: ${period} (${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)})
Placed: ${placed.length} · Settled: ${settled.length} · ${wins.length}W/${losses.length}L · Win% ${settled.length ? Math.round((wins.length / settled.length) * 100) : '—'}
Total PnL: $${totalPnL.toFixed(2)}
Per sport: ${sportLine}

Settled trades (most recent last):
${compact || '(no settled trades this period)'}

Write the recap.`
        });
      } catch (e) { commentary = null; }

      json(res, {
        period,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        placed: placed.length,
        settled: settled.length,
        wins: wins.length,
        losses: losses.length,
        winRate: settled.length ? Math.round((wins.length / settled.length) * 100) : null,
        totalPnL: Math.round(totalPnL * 100) / 100,
        best: best ? { title: best.title, pnl: best.realizedPnL, ticker: best.ticker } : null,
        worst: worst ? { title: worst.title, pnl: worst.realizedPnL, ticker: worst.ticker } : null,
        sportBreakdown: Object.values(sportMap).map(s => ({ ...s, pnl: Math.round(s.pnl * 100) / 100, winRate: s.trades ? Math.round((s.wins / s.trades) * 100) : 0 })),
        commentary,
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (path === '/api/control/sell' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      if (!body?.tradeId && !body?.ticker) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'tradeId or ticker required' })); return;
      }
      const request = {
        id: `sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tradeId: body.tradeId ?? null,
        ticker: body.ticker ?? null,
        reason: body.reason ?? 'manual-ui',
        requestedAt: new Date().toISOString(),
        status: 'pending',
      };
      const fs = await import('fs');
      fs.appendFileSync(SELL_REQUESTS_FILE, JSON.stringify(request) + '\n');
      broadcast('sell-request', request);
      json(res, request);
      return;
    }

    if (path === '/api/trades') {
      const trades = readJsonl(TRADES_LOG);
      const exchangeFilter = url.searchParams.get('exchange') ?? 'kalshi';
      const filtered = trades.filter(t => {
        if (t.status === 'testing-void') return false;
        if (exchangeFilter !== 'all' && t.exchange !== exchangeFilter) return false;
        return true;
      });
      json(res, filtered);

    } else if (path === '/api/positions') {
      // Only actually-open trades. 'closed-manual' means the bot confirmed the
      // position is no longer on Kalshi (after a 15 min grace + 90s strike rule)
      // — it's resolved, even if the PnL is unknown. Do not show as "open".
      const trades = readJsonl(TRADES_LOG);
      const exchangeFilter = url.searchParams.get('exchange') ?? 'kalshi';
      const open = trades.filter(t => {
        if (t.status !== 'open') return false;
        if (exchangeFilter !== 'all' && t.exchange !== exchangeFilter) return false;
        return true;
      });
      json(res, open);

    } else if (path === '/api/stats') {
      const allTrades = readJsonl(TRADES_LOG);
      const snapshots = readJsonl(DAILY_LOG);

      // Filter: Kalshi-only, exclude voided testing trades
      const exchangeFilter = url.searchParams.get('exchange') ?? 'kalshi';
      const trades = allTrades.filter(t => {
        if (t.status === 'testing-void') return false; // exclude testing
        if (exchangeFilter !== 'all' && t.exchange !== exchangeFilter) return false;
        return true;
      });

      const settled = trades.filter(t => t.status === 'settled' || t.status?.startsWith('sold-'));
      const open = trades.filter(t => t.status === 'open');
      // closed-manual = bot confirmed the position is gone from Kalshi but didn't
      // capture a realized PnL. These are resolved but invisible to the PnL math.
      const closedManual = trades.filter(t => t.status === 'closed-manual');
      const wins = settled.filter(t => (t.realizedPnL ?? 0) > 0);
      const losses = settled.filter(t => (t.realizedPnL ?? 0) < 0);
      const totalPnL = settled.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);

      // Today's trades — ET boundary (not UTC) so numbers match the user's day.
      const todayStart = etMidnightUTC(0);
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

      // Live bankroll — the bot logs authoritative Kalshi+Poly balances every
      // cycle. Prefer that over the daily snapshot, which is stale for ~24h.
      const livePortfolio = readLivePortfolio();
      const lastSnap = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
      const openDeployed = open.reduce((s, t) => s + (t.deployCost ?? 0), 0);

      // P&L realized after the last snapshot, PLUS cost basis released by
      // closed-manual trades whose realized PnL was never captured. Without
      // this second term the bankroll stays inflated by the deployCost of
      // any "unknown PnL" close — which is why the dashboard drifts.
      const snapTime = lastSnap?.timestamp ? new Date(lastSnap.timestamp).getTime() : 0;
      const pnlSinceSnap = settled
        .filter(t => t.settledAt && new Date(t.settledAt).getTime() > snapTime)
        .reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
      const closedManualSinceSnap = closedManual.filter(t =>
        t.settledAt && new Date(t.settledAt).getTime() > snapTime
      );
      const closedManualCostSinceSnap = closedManualSinceSnap.reduce((s, t) => s + (t.deployCost ?? 0), 0);

      // Worst/best-case bounds for UI honesty when we fall back to snapshot+delta.
      const liveBankrollLo = lastSnap ? lastSnap.bankroll + pnlSinceSnap - closedManualCostSinceSnap : totalPnL;
      const liveBankrollHi = lastSnap ? lastSnap.bankroll + pnlSinceSnap + closedManualCostSinceSnap : totalPnL;
      // Authoritative bankroll comes from the bot's latest [portfolio] log line.
      // If that's missing (first boot, log rotated), fall back to the snapshot midpoint.
      const liveBankroll = livePortfolio?.bankroll ?? (liveBankrollLo + liveBankrollHi) / 2;
      const bankrollSource = livePortfolio ? 'live-portfolio' : lastSnap ? 'snapshot-estimate' : 'computed';

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
        latestSnapshot: lastSnap,
        livePortfolio,
        liveBankroll: Math.round(liveBankroll * 100) / 100,
        liveBankrollLo: Math.round(liveBankrollLo * 100) / 100,
        liveBankrollHi: Math.round(liveBankrollHi * 100) / 100,
        bankrollIsEstimated: bankrollSource !== 'live-portfolio' && closedManualSinceSnap.length > 0,
        bankrollSource,
        openDeployed: Math.round(openDeployed * 100) / 100,
        closedManualTrades: closedManual.length,
        closedManualCost: Math.round(closedManualSinceSnap.reduce((s, t) => s + (t.deployCost ?? 0), 0) * 100) / 100,
        serverTime: new Date().toISOString(),
      });

    } else if (path === '/api/snapshots') {
      const snapshots = readJsonl(DAILY_LOG);
      json(res, snapshots);

    } else if (path === '/api/screens') {
      const screens = readJsonl(SCREENS_LOG);
      // Return last 100
      json(res, screens.slice(-100));

    } else if (path === '/api/games') {
      const screens = readJsonl(SCREENS_LOG);
      // Last 8 hours of live-edge decisions
      const cutoff = Date.now() - 8 * 60 * 60 * 1000;
      const relevant = screens.filter(s => {
        if (!['live-edge', 'live-edge-skip'].includes(s.stage)) return false;
        return new Date(s.timestamp).getTime() >= cutoff;
      });

      // Group by game key (awayAbbr@homeAbbr)
      const gameMap = new Map();
      for (const s of relevant) {
        let key = null;
        if (s.homeAbbr && s.awayAbbr) {
          key = `${s.awayAbbr}@${s.homeAbbr}`;
        } else if (s.ticker) {
          // fallback: use ticker base as key
          const lastH = s.ticker.lastIndexOf('-');
          key = lastH > 0 ? s.ticker.slice(0, lastH) : s.ticker;
        }
        if (!key) continue;

        if (!gameMap.has(key)) {
          gameMap.set(key, {
            gameKey: key,
            league: s.league ?? null,
            homeAbbr: s.homeAbbr ?? null,
            awayAbbr: s.awayAbbr ?? null,
            lastSeen: s.timestamp,
            lastScore: null,
            lastDetail: null,
            decisions: [],
          });
        }

        const game = gameMap.get(key);
        // Update metadata from most recent entry
        if (s.timestamp > game.lastSeen) {
          game.lastSeen = s.timestamp;
          if (s.league) game.league = s.league;
          if (s.homeAbbr) game.homeAbbr = s.homeAbbr;
          if (s.awayAbbr) game.awayAbbr = s.awayAbbr;
        }
        if (s.homeScore != null && s.awayScore != null) {
          // Update if this is the most recent score we've seen
          const curTs = game.lastScoreTs ?? '';
          if (s.timestamp >= curTs) {
            game.lastScore = `${s.awayAbbr} ${s.awayScore} – ${s.homeAbbr} ${s.homeScore}`;
            game.lastDetail = s.gameDetail ?? (s.period != null ? `P${s.period}` : null);
            game.lastScoreTs = s.timestamp;
          }
        }

        game.decisions.push({
          timestamp: s.timestamp,
          result: s.result,
          reasoning: s.reasoning ?? null,
          confidence: s.confidence ?? null,
          price: s.price ?? null,
          winExpectancy: s.winExpectancy ?? null,
          targetAbbr: s.targetAbbr ?? null,
          homeScore: s.homeScore ?? null,
          awayScore: s.awayScore ?? null,
          period: s.period ?? null,
          gameDetail: s.gameDetail ?? null,
        });
      }

      // Remove internal timestamp tracker
      for (const g of gameMap.values()) delete g.lastScoreTs;

      // Sort games by lastSeen desc
      const games = [...gameMap.values()].sort((a, b) =>
        new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
      );
      json(res, games);

    } else if (path === '/api/live-feed') {
      // Tail the last N lines of ai-out.log for real-time feed
      const LOG_FILE = join(__dirname, 'logs/ai-out.log');
      const limit = parseInt(url.searchParams.get('limit') ?? '50');
      if (!existsSync(LOG_FILE)) { json(res, []); return; }
      try {
        const content = readFileSync(LOG_FILE, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        const tail = lines.slice(-Math.min(limit, 200));
        const parsed = tail.map(line => {
          // Parse: "2026-04-13 20:23:15: [live-edge] Found market: ..."
          const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}): /);
          const ts = tsMatch ? tsMatch[1] : '';
          const rest = tsMatch ? line.slice(tsMatch[0].length) : line;
          const tagMatch = rest.match(/^\[([^\]]+)\] /);
          const tag = tagMatch ? tagMatch[1] : '';
          const msg = tagMatch ? rest.slice(tagMatch[0].length) : rest;

          // Categorize for UI coloring
          let type = 'info';
          if (msg.includes('TRADE') || msg.includes('🎯') || msg.includes('🔥')) type = 'trade';
          else if (msg.includes('BLOCKED') || msg.includes('stop-loss') || msg.includes('🛑')) type = 'block';
          else if (msg.includes('Sonnet analyzing') || msg.includes('Claude says')) type = 'analysis';
          else if (msg.includes('SETTLED') || msg.includes('✅') || msg.includes('WIN')) type = 'win';
          else if (msg.includes('❌') || msg.includes('LOSS')) type = 'loss';
          else if (msg.includes('portfolio')) type = 'portfolio';
          else if (msg.includes('DRY RUN')) type = 'dryrun';

          return { ts, tag, msg, type, raw: line };
        });
        json(res, parsed);
      } catch (e) {
        json(res, []);
      }

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
