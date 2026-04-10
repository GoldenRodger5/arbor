// notify — Supabase DB webhook target for scan_results INSERT.
//
// Extracts opportunities from body.record.opportunities, filters for
// actionable spreads (>4% net, verdict SAFE/CAUTION, not belowThreshold),
// and sends up to 3 Telegram alerts per scan with inline action buttons.
//
// Env:
//   TELEGRAM_BOT_TOKEN — bot token from @BotFather
//   TELEGRAM_CHAT_ID   — numeric chat id to alert
//
// Triggered via: Dashboard → Database → Webhooks → scan_results INSERT.

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const TELEGRAM_CHAT_ID   = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';

const MAX_ALERTS_PER_SCAN    = 3;
const MIN_NET_SPREAD         = 0.03;
const MAX_DAYS_LOCKUP        = 2;    // Only alert on markets closing within 2 days
const AUTO_EXECUTE_SPREAD    = 0.05; // 5% net → auto-execute
const AUTO_EXECUTE_MAX_DAYS  = 1;    // same-day only
const GLOBAL_DRY_RUN         = Deno.env.get('TRADE_DRY_RUN') === 'true';

// ─────────────────────────────────────────────────────────────────────────────
// Kelly position sizing (mirrored from trade/index.ts)
// ─────────────────────────────────────────────────────────────────────────────

const MIN_POSITION_USD     = 20;
const MAX_POSITION_SAFE    = 80;   // Must not exceed total capital ($198)
const MAX_POSITION_CAUTION = 100;
const MAX_CAPITAL_FRACTION = 0.40;
const QUARTER_KELLY        = 0.25;

interface SizingResult {
  contracts: number;
  totalDeployed: number;
  kellyFraction: number;
  quarterKelly: number;
  rawPosition: number;
  limitingFactor: string;
}

function calculatePositionSize(
  netSpread: number,
  totalCostPerContract: number,
  activeCapital: number,
  verdict: string,
  availableLiquidity: number,
): SizingResult {
  if (netSpread <= 0 || totalCostPerContract <= 0) {
    return { contracts: 0, totalDeployed: 0, kellyFraction: 0, quarterKelly: 0, rawPosition: 0, limitingFactor: 'kelly' };
  }
  const odds = (1 / totalCostPerContract) - 1;
  const rawKelly = odds > 0 ? netSpread / odds : 0;
  const kellyFraction = Math.min(rawKelly, 1.0);
  const quarterKelly  = QUARTER_KELLY * kellyFraction;
  const rawPosition   = quarterKelly * activeCapital;
  const verdictCap    = verdict.toUpperCase() === 'SAFE' ? MAX_POSITION_SAFE : MAX_POSITION_CAUTION;
  const capitalCap    = MAX_CAPITAL_FRACTION * activeCapital;
  let finalUSD        = rawPosition;
  let limitingFactor  = 'kelly';
  if (availableLiquidity < finalUSD) { finalUSD = availableLiquidity; limitingFactor = 'liquidity'; }
  if (verdictCap          < finalUSD) { finalUSD = verdictCap;         limitingFactor = 'verdict_cap'; }
  if (capitalCap          < finalUSD) { finalUSD = capitalCap;         limitingFactor = 'capital_cap'; }
  const contracts    = Math.max(0, Math.floor(finalUSD / totalCostPerContract));
  const totalDeployed = contracts * totalCostPerContract;
  if (totalDeployed < MIN_POSITION_USD && contracts > 0) {
    const minContracts = Math.ceil(MIN_POSITION_USD / totalCostPerContract);
    const minDeployed  = minContracts * totalCostPerContract;
    if (minDeployed <= Math.min(availableLiquidity, verdictCap, capitalCap)) {
      return { contracts: minContracts, totalDeployed: minDeployed, kellyFraction, quarterKelly, rawPosition, limitingFactor: 'minimum' };
    }
  }
  return { contracts, totalDeployed, kellyFraction, quarterKelly, rawPosition, limitingFactor };
}

// Real balance fetchers (self-contained copies — notify has no imports from trade)

const KALSHI_TRADING_BASE_NOTIFY = 'https://trading-api.kalshi.com/trade-api/v2';
const POLY_CLOB_BASE_NOTIFY      = 'https://clob.polymarket.com';

let _notifyCryptoKey: CryptoKey | null = null;

function pemToAB(pem: string): ArrayBuffer {
  const cleaned = pem.replace(/-----BEGIN [^-]+-----/g,'').replace(/-----END [^-]+-----/g,'').replace(/\s+/g,'');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function notifyKalshiHeaders(method: string, path: string): Promise<Record<string, string>> {
  const apiKeyId   = Deno.env.get('KALSHI_API_KEY_ID')  ?? '';
  const privateKey = Deno.env.get('KALSHI_PRIVATE_KEY') ?? '';
  if (!apiKeyId || !privateKey) return {};
  if (!_notifyCryptoKey) {
    _notifyCryptoKey = await globalThis.crypto.subtle.importKey(
      'pkcs8', pemToAB(privateKey),
      { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign'],
    );
  }
  const ts  = String(Date.now());
  const fullPath = path.startsWith('/trade-api/v2') ? path : `/trade-api/v2${path}`;
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 }, _notifyCryptoKey,
    new TextEncoder().encode(`${ts}${method}${fullPath}`),
  );
  return {
    'KALSHI-ACCESS-KEY': apiKeyId, 'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': toB64(sig), 'Content-Type': 'application/json',
  };
}

async function getKalshiBalanceForNotify(): Promise<number> {
  try {
    const path    = '/portfolio/balance';
    const headers = await notifyKalshiHeaders('GET', path);
    // Balance endpoint lives on api.elections.kalshi.com, same as market data.
    const res     = await fetch(`https://api.elections.kalshi.com/trade-api/v2${path}`, { headers });
    if (!res.ok) return 0;
    const data = await res.json() as { balance?: number };
    return (data.balance ?? 0) / 100;
  } catch { return 0; }
}

// Ed25519 auth for Polymarket US balance via @noble/ed25519 (Deno compat).
let _notifyEd25519: { sign: (msg: Uint8Array, key: Uint8Array) => Promise<Uint8Array> } | null = null;
let _notifyPolyPrivBytes: Uint8Array | null = null;

async function getPolyBalanceForNotify(): Promise<number> {
  const keyId  = Deno.env.get('POLY_US_KEY_ID')     ?? '';
  const secret = Deno.env.get('POLY_US_SECRET_KEY')  ?? '';

  if (keyId && secret) {
    try {
      if (!_notifyEd25519) {
        const mod = await import('https://esm.sh/@noble/ed25519@2.1.0');
        _notifyEd25519 = { sign: mod.signAsync ?? mod.sign };
      }
      if (!_notifyPolyPrivBytes) {
        _notifyPolyPrivBytes = Uint8Array.from(atob(secret), c => c.charCodeAt(0)).slice(0, 32);
      }

      const timestamp = String(Date.now());
      const path      = '/v1/account/balances';
      const message   = `${timestamp}GET${path}`;
      const sigBytes  = await _notifyEd25519.sign(new TextEncoder().encode(message), _notifyPolyPrivBytes);
      const signature = btoa(String.fromCharCode(...sigBytes));

      const res = await fetch(`https://api.polymarket.us${path}`, {
        headers: {
          'X-PM-Access-Key': keyId,
          'X-PM-Timestamp':  timestamp,
          'X-PM-Signature':  signature,
          'Content-Type':    'application/json',
          'Accept':          'application/json',
          'User-Agent':      'arbor-notify/1',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        // Response: { balances: [{ currentBalance: 100, currency: "USD", buyingPower: 100, ... }] }
        const balArr = data?.balances ?? data;
        const bal = Array.isArray(balArr)
          ? (balArr[0]?.currentBalance ?? balArr[0]?.buyingPower ?? balArr[0]?.balance ?? balArr[0]?.value)
          : (data?.balance ?? data?.currentBalance ?? data?.buyingPower ?? data?.value);
        const dollars = parseFloat(String(bal ?? '0'));
        if (Number.isFinite(dollars) && dollars > 0) {
          console.log('[notify-poly-us-balance]', dollars.toFixed(2));
          return dollars;
        }
        console.log('[notify-poly-us-balance] response:', JSON.stringify(data).slice(0, 200));
      } else {
        console.warn('[notify-poly-us-balance] HTTP', res.status);
      }
    } catch (err) {
      console.error('[notify-poly-us-balance] threw', err);
    }
  }

  // Fallback: public data-api for global Polymarket.
  const funder = Deno.env.get('POLY_FUNDER_ADDRESS') ?? '';
  if (funder) {
    try {
      const url = `https://data-api.polymarket.com/value?user=${encodeURIComponent(funder)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json() as Array<{ value?: number | string }>;
        const dollars = parseFloat(String(data?.[0]?.value ?? '0'));
        if (Number.isFinite(dollars)) return dollars;
      }
    } catch { /* silent */ }
  }
  return 0;
}

async function fetchActiveCapital(): Promise<{ activeCapital: number; kalshiBalance: number; polyBalance: number }> {
  // Try real balances first; fall back to capital_ledger.
  const [kalshiBalance, polyBalance] = await Promise.all([
    getKalshiBalanceForNotify(),
    getPolyBalanceForNotify(),
  ]);
  console.log('[notify-balances]', JSON.stringify({ kalshiBalance, polyBalance }));
  if (kalshiBalance > 0 || polyBalance > 0) {
    const total  = kalshiBalance + polyBalance;
    const active = total * 0.8; // 80% safety-adjusted
    return { activeCapital: active, kalshiBalance, polyBalance };
  }
  // Fallback: read capital_ledger.
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) return { activeCapital: 400, kalshiBalance: 0, polyBalance: 0 };
  const sb = createClient(supabaseUrl, serviceKey);
  const { data } = await sb
    .from('capital_ledger')
    .select('total_capital,deployed_capital,safety_reserve_pct,realized_pnl')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return { activeCapital: 400, kalshiBalance: 0, polyBalance: 0 };
  const active = ((data.total_capital as number) ?? 500) * (1 - ((data.safety_reserve_pct as number) ?? 0.2))
               - ((data.deployed_capital as number) ?? 0)
               + ((data.realized_pnl as number) ?? 0);
  return { activeCapital: active, kalshiBalance: 0, polyBalance: 0 };
}

interface Level {
  buyYesPlatform: 'kalshi' | 'polymarket';
  buyYesPrice: number;
  buyNoPlatform: 'kalshi' | 'polymarket';
  buyNoPrice: number;
  quantity: number;
  totalCost?: number;
  maxProfitDollars?: number;
}

interface Market {
  marketId?: string;
  title?: string;
  url?: string;
}

interface Opportunity {
  id?: string;
  kalshiMarket: Market;
  polyMarket: Market;
  verdict?: string;
  verdictReasoning?: string;
  levels: Level[];
  bestNetSpread: number;
  totalMaxProfit: number;
  annualizedReturn: number;
  daysToClose: number;
  belowThreshold?: boolean;
}

function slugifyId(marketId: string): string {
  return (marketId || '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .slice(0, 32)
    .replace(/^_+|_+$/g, '');
}

function htmlEscape(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDate(isoOrDays: string | number | undefined): string {
  if (typeof isoOrDays === 'number') {
    const d = new Date(Date.now() + isoOrDays * 86_400_000);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  if (!isoOrDays) return '—';
  try {
    return new Date(isoOrDays).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return '—'; }
}

function trunc(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatMessage(
  o: Opportunity,
  activeCapital: number,
  _kalshiBalance = 0,
  _polyBalance = 0,
): { text: string; reply_markup: unknown } {
  const lvl = o.levels[0];
  const costPerPair = lvl.buyYesPrice + lvl.buyNoPrice;
  const availableLiquidity = (lvl.totalCost ?? costPerPair) * lvl.quantity;
  const verdict = (o.verdict || 'CAUTION').toUpperCase();

  const sizing = calculatePositionSize(
    o.bestNetSpread, costPerPair, activeCapital, verdict, availableLiquidity,
  );
  const qty           = Math.max(1, sizing.contracts);
  const kellyDeployed = sizing.totalDeployed > 0 ? sizing.totalDeployed : costPerPair * qty;
  const maxProfit     = (o.totalMaxProfit * (qty / lvl.quantity));
  const netPct        = (o.bestNetSpread * 100).toFixed(1);
  const apyPct        = (o.annualizedReturn * 100).toFixed(1);
  const emoji         = verdict === 'SAFE' ? '🟢' : '🟡';
  const kTitle        = trunc(htmlEscape(o.kalshiMarket.title || ''));
  const settleDate    = fmtDate(o.effectiveCloseDate ?? o.daysToClose);

  // Verdict reasoning — show only if non-generic (> 30 chars, not boilerplate).
  const rawReasoning = o.verdictReasoning ?? '';
  const reasoning = rawReasoning.length > 30 && !rawReasoning.toLowerCase().includes('same proposition')
    ? `\n<i>${trunc(htmlEscape(rawReasoning), 120)}</i>` : '';

  const text =
    `${emoji} <b>${verdict} · ${netPct}% net · ${o.daysToClose.toFixed(0)}d</b>\n\n` +
    `<b>${kTitle}</b>\n\n` +
    `<code>BUY YES  ${lvl.buyYesPlatform.padEnd(12)}$${lvl.buyYesPrice.toFixed(2)}  ×  ${qty}</code>\n` +
    `<code>BUY NO   ${lvl.buyNoPlatform.padEnd(12)}$${lvl.buyNoPrice.toFixed(2)}  ×  ${qty}</code>\n\n` +
    `💰 Deploy <b>$${kellyDeployed.toFixed(2)}</b>  →  profit <b>+$${maxProfit.toFixed(2)}</b>\n` +
    `📅 Settles ${settleDate}  ·  APY <b>+${apyPct}%</b>` +
    reasoning;

  const oppId = slugifyId(o.kalshiMarket.marketId || o.id || '');
  const row1 = [
    { text: `✅ Execute $${kellyDeployed.toFixed(2)}`, callback_data: `buy_${oppId}` },
    { text: '❌ Skip', callback_data: `skip_${oppId}` },
  ];
  const row2: Array<{ text: string; url: string }> = [];
  if (o.kalshiMarket.url) row2.push({ text: 'Kalshi ↗', url: o.kalshiMarket.url });
  if (o.polyMarket.url)   row2.push({ text: 'Polymarket ↗', url: o.polyMarket.url });
  const inline_keyboard: unknown[][] = [row1];
  if (row2.length > 0) inline_keyboard.push(row2);

  return { text, reply_markup: { inline_keyboard } };
}

async function sendTelegram(
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[notify] telegram sendMessage failed', res.status, body);
  }
}

serve(async (req) => {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return new Response('missing telegram env', { status: 500 });
    }
    const body = await req.json().catch(() => ({} as any));
    const record = body?.record ?? body?.new ?? {};
    const opportunities: Opportunity[] = Array.isArray(record?.opportunities)
      ? record.opportunities
      : [];

    const filtered = opportunities.filter((o) => {
      if (!o || !Array.isArray(o.levels) || o.levels.length === 0) return false;
      if (typeof o.bestNetSpread !== 'number') return false;
      if (o.bestNetSpread <= MIN_NET_SPREAD) return false;
      const v = (o.verdict || '').toUpperCase();
      if (v !== 'SAFE' && v !== 'CAUTION') return false;
      // Only alert on short-dated markets — Cy Young, MLS Cup, etc. silenced.
      if (typeof o.daysToClose !== 'number') return false;
      if (o.daysToClose > MAX_DAYS_LOCKUP) return false;
      return true;
    });

    console.log(
      `[notify] scan has ${opportunities.length} opps, ${filtered.length} actionable`,
    );

    if (filtered.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, sent: 0, total: opportunities.length }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Fetch active capital once for this scan batch.
    const { activeCapital, kalshiBalance, polyBalance } = await fetchActiveCapital();

    // Safety rule 1: warn and skip if insufficient capital.
    if (activeCapital < 20) {
      const token = TELEGRAM_BOT_TOKEN;
      if (token && TELEGRAM_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: `⚠️ Active capital below $20 ($${activeCapital.toFixed(2)} available) — no trades will execute until capital is replenished.`,
            parse_mode: 'HTML',
          }),
        });
      }
      return new Response(
        JSON.stringify({ ok: true, sent: 0, skipped: 'insufficient_capital', activeCapital }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Smart dedup: check spread_events before sending each alert.
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const sb = (supabaseUrl && serviceKey) ? createClient(supabaseUrl, serviceKey) : null;

    const REFIRE_HOURS = 6;
    const SKIP_COOLDOWN_HOURS = 24;
    const IMPROVEMENT_FACTOR  = 1.5; // re-alert if spread improved 50%+

    const toSend = filtered.slice(0, MAX_ALERTS_PER_SCAN);
    let sent = 0;
    let deduped = 0;
    for (const o of toSend) {
      try {
        const pairId = `${o.kalshiMarket.marketId ?? ''}:${o.polyMarket.marketId ?? ''}`;

        // Dedup check against spread_events.
        if (sb) {
          const { data: event } = await sb
            .from('spread_events')
            .select('alerted_at, was_alerted, was_executed, peak_net_spread, skipped_at')
            .eq('pair_id', pairId)
            .is('closed_at', null)
            .limit(1)
            .maybeSingle();

          if (event) {
            const e = event as any;
            // Rule 1: already executed → skip permanently.
            if (e.was_executed) { deduped++; continue; }
            // Rule 3: skipped recently → 24h cooldown.
            if (e.skipped_at && (Date.now() - Date.parse(e.skipped_at)) < SKIP_COOLDOWN_HOURS * 3_600_000) {
              deduped++; continue;
            }
            // Rule 2: recently alerted at similar spread.
            if (e.alerted_at && (Date.now() - Date.parse(e.alerted_at)) < REFIRE_HOURS * 3_600_000) {
              const peakSpread = e.peak_net_spread as number ?? 0;
              if (o.bestNetSpread < peakSpread * IMPROVEMENT_FACTOR) {
                deduped++; continue;
              }
            }
            // Rule 4: never alerted → fall through to send.
          }
        }

        const { text, reply_markup } = formatMessage(o, activeCapital, kalshiBalance, polyBalance);
        await sendTelegram({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup,
        });
        sent++;

        // Update spread_events after sending alert.
        if (sb) {
          await sb.from('spread_events')
            .update({
              was_alerted: true,
              alerted_at: new Date().toISOString(),
              last_net_spread: o.bestNetSpread,
              peak_net_spread: Math.max((event as any)?.peak_net_spread ?? 0, o.bestNetSpread),
            })
            .eq('pair_id', pairId)
            .is('closed_at', null)
            .catch(() => {});
        }
      } catch (err) {
        console.error('[notify] failed to send alert', err);
      }
    }
    if (deduped > 0) console.log(`[notify] deduped ${deduped} alerts`);

    // Auto-execute: for high-confidence same-day opportunities, call the
    // trade function directly without waiting for a button tap.
    // Respects TRADE_DRY_RUN guard.
    if (sb && !GLOBAL_DRY_RUN) {
      for (const o of filtered) {
        const v = (o.verdict || '').toUpperCase();
        if (v !== 'SAFE') continue;
        if (o.bestNetSpread < AUTO_EXECUTE_SPREAD) continue;
        if (typeof o.daysToClose !== 'number' || o.daysToClose > AUTO_EXECUTE_MAX_DAYS) continue;

        const tradeUrl = (supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/trade';
        const oppId = slugifyId(o.kalshiMarket.marketId || o.id || '');
        console.log('[notify-auto-execute] triggering for', oppId, 'spread=', (o.bestNetSpread * 100).toFixed(1) + '%');

        try {
          // Simulate a callback_query buy tap by calling handleBuy via the trade endpoint.
          const tRes = await fetch(tradeUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              callback_query: {
                id: 'auto-exec-' + Date.now(),
                data: `buy_${oppId}`,
                message: { chat: { id: parseInt(TELEGRAM_CHAT_ID, 10) || 0 }, message_id: 0 },
              },
            }),
          });
          console.log('[notify-auto-execute] trade response:', tRes.status);

          await sendTelegram({
            chat_id: TELEGRAM_CHAT_ID,
            text: `🤖 <b>AUTO-EXECUTED</b>\n\n` +
              `<b>${trunc(htmlEscape(o.kalshiMarket.title || ''))}</b>\n\n` +
              `SAFE verdict · ${(o.bestNetSpread * 100).toFixed(1)}% net · same-day game\n\n` +
              `Deployed <b>$${(costPerPair * Math.max(1, sizing.contracts)).toFixed(2)}</b>  →  profit <b>+$${maxProfit.toFixed(2)}</b>\n` +
              `Settles ${fmtDate(o.effectiveCloseDate ?? o.daysToClose)}`,
            parse_mode: 'HTML',
          });
        } catch (err) {
          console.error('[notify-auto-execute] threw', err);
        }
      }
    } else if (GLOBAL_DRY_RUN) {
      // In dry-run, just log which opps would have been auto-executed.
      const autoQualified = filtered.filter(
        (o) => (o.verdict || '').toUpperCase() === 'SAFE' &&
               o.bestNetSpread >= AUTO_EXECUTE_SPREAD &&
               typeof o.daysToClose === 'number' && o.daysToClose <= AUTO_EXECUTE_MAX_DAYS,
      );
      if (autoQualified.length > 0) {
        console.log('[notify-auto-execute-dry]', autoQualified.length, 'opps would auto-execute if TRADE_DRY_RUN was off');
      }
    }

    return new Response(
      JSON.stringify({ ok: true, sent, eligible: filtered.length }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[notify] handler error', err);
    return new Response('error: ' + String(err), { status: 500 });
  }
});
