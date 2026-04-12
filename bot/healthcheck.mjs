/**
 * Arbor Health Check — standalone script run by pm2 cron
 *
 * Sends a daily Telegram health report at 8am ET with:
 *   - Which bots are running
 *   - Kalshi balance
 *   - Open positions
 *   - Errors in the last 24h
 *   - Profit/loss summary
 *
 * Also runs on startup to confirm deployment.
 *
 * Run: node healthcheck.mjs
 * Schedule: pm2 adds a cron to run this daily
 */

import { readFileSync, existsSync } from 'fs';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants } from 'crypto';
import { execSync } from 'child_process';
import 'dotenv/config';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID ?? '';
const KALSHI_API_KEY = process.env.KALSHI_API_KEY_ID ?? '';

let kalshiPrivateKey = null;
try {
  const pem = readFileSync('./kalshi-private-key.pem', 'utf-8');
  kalshiPrivateKey = createPrivateKey({ key: pem, format: 'pem' });
} catch { /* no key */ }

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log(text); return; }
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

async function kalshiGet(path) {
  if (!kalshiPrivateKey || !KALSHI_API_KEY) return null;
  const ts = String(Date.now());
  const fp = '/trade-api/v2' + path;
  const sig = cryptoSign('sha256', Buffer.from(ts + 'GET' + fp), {
    key: kalshiPrivateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  const res = await fetch('https://api.elections.kalshi.com/trade-api/v2' + path, {
    headers: {
      'KALSHI-ACCESS-KEY': KALSHI_API_KEY,
      'KALSHI-ACCESS-TIMESTAMP': ts,
      'KALSHI-ACCESS-SIGNATURE': sig.toString('base64'),
    },
    signal: AbortSignal.timeout(10000),
  });
  return res.ok ? res.json() : null;
}

async function run() {
  const lines = [];
  lines.push('📊 <b>ARBOR DAILY HEALTH CHECK</b>');
  lines.push('');

  // Check pm2 processes
  try {
    const pm2Out = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
    const procs = JSON.parse(pm2Out);
    // Only check arbor-ai (arb-bot intentionally stopped, health is cron)
    const criticalProcs = procs.filter(p => p.name === 'arbor-ai');
    let allOnline = true;
    for (const p of procs) {
      const status = p.pm2_env?.status ?? 'unknown';
      const uptime = p.pm2_env?.pm_uptime ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 3600000) : 0;
      const restarts = p.pm2_env?.restart_time ?? 0;
      const icon = status === 'online' ? '✅' : (p.name === 'arbor-arb' ? '⏸️' : '❌');
      if (status !== 'online' && p.name === 'arbor-ai') allOnline = false;
      lines.push(`${icon} <b>${p.name}</b> — ${status} (${uptime}h uptime, ${restarts} restarts)`);
    }
    if (criticalProcs.length === 0) {
      lines.push('❌ arbor-ai not found!');
      allOnline = false;
    }
    lines.push('');
    lines.push(allOnline ? '🟢 All systems operational' : '🔴 arbor-ai is DOWN');
  } catch {
    lines.push('⚠️ Could not check pm2 status');
  }
  lines.push('');

  // Kalshi balance
  try {
    const bal = await kalshiGet('/portfolio/balance');
    if (bal) {
      const cash = (bal.balance ?? 0) / 100;
      const positions = (bal.portfolio_value ?? 0) / 100;
      lines.push(`💰 <b>Kalshi Balance</b>`);
      lines.push(`Cash: $${cash.toFixed(2)}`);
      lines.push(`Positions: $${positions.toFixed(2)}`);
      lines.push(`Total: <b>$${(cash + positions).toFixed(2)}</b>`);
    } else {
      lines.push('⚠️ Could not fetch Kalshi balance');
    }
  } catch {
    lines.push('⚠️ Kalshi balance check failed');
  }
  lines.push('');

  // Open positions
  try {
    const posData = await kalshiGet('/portfolio/positions');
    const positions = (posData?.event_positions ?? []).filter(p => parseFloat(p.total_cost_dollars ?? '0') > 0);
    if (positions.length > 0) {
      lines.push(`📊 <b>Open Positions: ${positions.length}</b>`);
      for (const p of positions.slice(0, 5)) {
        lines.push(`  ${p.event_ticker}: $${parseFloat(p.total_cost_dollars ?? '0').toFixed(2)}`);
      }
      if (positions.length > 5) lines.push(`  ... and ${positions.length - 5} more`);
    } else {
      lines.push('📊 No open positions');
    }
  } catch {
    lines.push('⚠️ Could not fetch positions');
  }
  lines.push('');

  // Check for errors in logs (last 24h)
  try {
    const logFiles = ['./logs/arb-error.log', './logs/ai-error.log'];
    let errorCount = 0;
    let lastError = '';
    for (const f of logFiles) {
      if (!existsSync(f)) continue;
      const content = readFileSync(f, 'utf-8');
      const logLines = content.split('\n').filter(l => l.trim());
      // Count lines from last 24h
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const line of logLines.slice(-50)) {
        const dateMatch = line.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (dateMatch && Date.parse(dateMatch[1]) > cutoff) {
          errorCount++;
          lastError = line.slice(0, 100);
        }
      }
    }
    if (errorCount > 0) {
      lines.push(`⚠️ <b>${errorCount} errors</b> in last 24h`);
      lines.push(`Last: <code>${lastError}</code>`);
    } else {
      lines.push('✅ No errors in last 24h');
    }
  } catch {
    lines.push('⚠️ Could not check error logs');
  }
  lines.push('');

  // P&L Summary from trades.jsonl
  try {
    const tradesFile = './logs/trades.jsonl';
    if (existsSync(tradesFile)) {
      const tradeLines = readFileSync(tradesFile, 'utf-8').split('\n').filter(l => l.trim());
      let totalPnL = 0, settled = 0, openCount = 0, totalDeployed = 0;
      const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
      let todayPnL = 0, todayTrades = 0;
      for (const l of tradeLines) {
        try {
          const t = JSON.parse(l);
          if (t.status === 'settled' && t.realizedPnL != null) {
            totalPnL += t.realizedPnL;
            settled++;
            if (t.settledAt && Date.parse(t.settledAt) > cutoff24h) todayPnL += t.realizedPnL;
          } else if (t.status === 'open') {
            openCount++;
            totalDeployed += (t.deployCost ?? 0);
          }
          if (t.timestamp && Date.parse(t.timestamp) > cutoff24h) todayTrades++;
        } catch { /* skip */ }
      }
      lines.push(`📈 <b>P&L Summary</b>`);
      lines.push(`Total: <b>${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}</b> (${settled} settled)`);
      lines.push(`Today: ${todayPnL >= 0 ? '+' : ''}$${todayPnL.toFixed(2)} | ${todayTrades} trades placed`);
      lines.push(`Open: ${openCount} trades, $${totalDeployed.toFixed(2)} deployed`);
    } else {
      lines.push('📈 No trade history yet');
    }
  } catch {
    lines.push('⚠️ Could not read trade log');
  }
  lines.push('');

  // Timestamp
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  lines.push(`🕐 ${now} ET`);

  await tg(lines.join('\n'));
  console.log('[healthcheck] Report sent');
}

run().then(() => process.exit(0)).catch(e => {
  console.error('Healthcheck failed:', e);
  process.exit(1);
});
