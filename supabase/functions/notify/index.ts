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

const MAX_ALERTS_PER_SCAN = 3;
const MIN_NET_SPREAD = 0.03;

// ─────────────────────────────────────────────────────────────────────────────
// Kelly position sizing (mirrored from trade/index.ts)
// ─────────────────────────────────────────────────────────────────────────────

const MIN_POSITION_USD     = 20;
const MAX_POSITION_SAFE    = 200;
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

function formatMessage(
  o: Opportunity,
  activeCapital: number,
  kalshiBalance = 0,
  polyBalance = 0,
): { text: string; reply_markup: unknown } {
  const lvl = o.levels[0];
  const costPerPair = lvl.buyYesPrice + lvl.buyNoPrice;
  const availableLiquidity = (lvl.totalCost ?? costPerPair) * lvl.quantity;
  const verdict = (o.verdict || 'CAUTION').toUpperCase();

  const sizing = calculatePositionSize(
    o.bestNetSpread, costPerPair, activeCapital, verdict, availableLiquidity,
  );
  const qty           = Math.max(1, sizing.contracts);
  const yesCost       = lvl.buyYesPrice * qty;
  const noCost        = lvl.buyNoPrice * qty;
  const kellyDeployed = sizing.totalDeployed > 0 ? sizing.totalDeployed : costPerPair * qty;

  const maxProfit    = Math.round(o.totalMaxProfit * (qty / lvl.quantity));
  const netSpreadPct = (o.bestNetSpread * 100).toFixed(1);
  const apyPct       = (o.annualizedReturn * 100).toFixed(1);
  const daysToClose  = o.daysToClose.toFixed(1);
  const emoji        = verdict === 'SAFE' ? '🟢' : '🟡';

  const kTitle    = htmlEscape(o.kalshiMarket.title || '(untitled)');
  const reasoning = htmlEscape(o.verdictReasoning || '');

  const buyYesLine =
    `Buy YES: <code>${lvl.buyYesPlatform} @ $${lvl.buyYesPrice.toFixed(4)}` +
    ` × ${qty} contracts = $${yesCost.toFixed(2)}</code>`;
  const buyNoLine =
    `Buy NO:  <code>${lvl.buyNoPlatform} @ $${lvl.buyNoPrice.toFixed(4)}` +
    ` × ${qty} contracts = $${noCost.toFixed(2)}</code>`;

  const balanceLine = (kalshiBalance > 0 || polyBalance > 0)
    ? `💳 Kalshi: $${kalshiBalance.toFixed(2)} | Poly: $${polyBalance.toFixed(2)}\n`
    : '';

  const text =
    `${emoji} <b>ARB SIGNAL — ${verdict}</b>\n\n` +
    `<b>${kTitle}</b>\n\n` +
    `${buyYesLine}\n` +
    `${buyNoLine}\n\n` +
    `💰 Deploying: <b>$${kellyDeployed.toFixed(2)}</b>\n` +
    `   <i>(Quarter Kelly on $${activeCapital.toFixed(0)} active capital — limit: ${sizing.limitingFactor})</i>\n` +
    balanceLine +
    `📈 <b>Max profit: $${maxProfit} (+${netSpreadPct}% net)</b>\n` +
    `📅 <b>Closes in ${daysToClose}d</b>  →  APY: <b>+${apyPct}%</b>\n` +
    `<i>(${daysToClose}d lockup — worth it at +${netSpreadPct}% net?)</i>\n\n` +
    (reasoning ? `<i>${reasoning}</i>` : '');

  const oppId = slugifyId(o.kalshiMarket.marketId || o.id || '');
  const row1 = [
    {
      text: `✅ Execute $${kellyDeployed.toFixed(2)}`,
      callback_data: `buy_${oppId}`,
    },
    { text: '❌ Skip', callback_data: `skip_${oppId}` },
  ];
  const row2: Array<{ text: string; url: string }> = [];
  if (o.kalshiMarket.url) {
    row2.push({ text: '📈 View on Kalshi ↗', url: o.kalshiMarket.url });
  }
  if (o.polyMarket.url) {
    row2.push({ text: '📊 View on Polymarket ↗', url: o.polyMarket.url });
  }
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

    const toSend = filtered.slice(0, MAX_ALERTS_PER_SCAN);
    let sent = 0;
    for (const o of toSend) {
      try {
        const { text, reply_markup } = formatMessage(o, activeCapital, kalshiBalance, polyBalance);
        await sendTelegram({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup,
        });
        sent++;
      } catch (err) {
        console.error('[notify] failed to send alert', err);
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
