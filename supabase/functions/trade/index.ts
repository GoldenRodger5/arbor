// trade — Telegram webhook handler + auto-execution engine.
//
// On [✅ Execute] tap:
//   1. Look up the opportunity in recent scan_results.
//   2. Scale quantity to MAX_POSITION_USD safety cap ($50).
//   3. Execute both legs simultaneously via Kalshi REST + Polymarket CLOB.
//   4. Store fill results in positions table.
//   5. Send Telegram confirmation or partial-fill alert.
//
// DRY RUN: set ?dryRun=1 on the webhook URL OR send POST with
// {"dryRun":true,"slug":"..."} to exercise the full flow without
// placing real orders. The dry-run path logs exactly what would be sent.
//
// Env:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY
//   POLY_PRIVATE_KEY, POLY_FUNDER_ADDRESS

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const TELEGRAM_CHAT_ID   = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';
const SUPABASE_URL        = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Global dry-run guard. When TRADE_DRY_RUN=true no real orders are placed.
// Override per-request via ?dryRun=1 or {"dryRun":true} in the body.
// Remove the secret (supabase secrets unset TRADE_DRY_RUN) to go live.
const GLOBAL_DRY_RUN = Deno.env.get('TRADE_DRY_RUN') === 'true';

const KALSHI_API_KEY_ID  = Deno.env.get('KALSHI_API_KEY_ID') ?? '';
const KALSHI_PRIVATE_KEY = Deno.env.get('KALSHI_PRIVATE_KEY') ?? '';
const POLY_PRIVATE_KEY    = Deno.env.get('POLY_PRIVATE_KEY') ?? '';
const POLY_FUNDER_ADDRESS = Deno.env.get('POLY_FUNDER_ADDRESS') ?? '';
// Polymarket US (CFTC-regulated) Ed25519 credentials.
const POLY_US_KEY_ID      = Deno.env.get('POLY_US_KEY_ID') ?? '';
const POLY_US_SECRET_KEY  = Deno.env.get('POLY_US_SECRET_KEY') ?? '';

const KALSHI_BASE          = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_TRADING_BASE  = KALSHI_BASE;
const POLY_US_API          = 'https://api.polymarket.us';
const POLY_CLOB_BASE       = 'https://clob.polymarket.com';

const SUPABASE_BASE = Deno.env.get('SUPABASE_URL') ?? '';

// Hard limits (safety rails — non-negotiable)
const MIN_POSITION_USD     = 20;    // not worth executing below this
const MAX_POSITION_SAFE    = 500;   // SAFE verdict cap (not binding at current capital)
const MAX_POSITION_CAUTION = 200;   // CAUTION verdict cap
const MAX_CAPITAL_FRACTION = 0.90;  // 90% of active capital per trade
const HALF_KELLY           = 0.50;  // fraction of full Kelly to use

// ─────────────────────────────────────────────────────────────────────────────
// Live balance fetching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch live Kalshi portfolio balance.
 * Response: { "balance": 9820 }  — integer cents.
 * Returns dollars. Returns 0 on error.
 */
async function getKalshiBalance(): Promise<number> {
  try {
    const signPath = '/portfolio/balance';
    const headers  = await kalshiAuthHeaders('GET', signPath);
    // Balance endpoint lives on the elections API, not the trading API.
    const res = await fetch(`${KALSHI_BASE}${signPath}`, { headers });
    if (!res.ok) {
      // HTTP 401 on /portfolio/* = key lacks portfolio access (requires Premier tier).
      // Falls back to capital_ledger values gracefully.
      console.warn('[kalshi-balance] HTTP', res.status, '— portfolio access requires Premier tier API key');
      return 0;
    }
    const data = await res.json() as { balance?: number };
    const cents = data.balance ?? 0;
    const dollars = cents / 100;
    console.log('[kalshi-balance]', dollars.toFixed(2));
    return dollars;
  } catch (err) {
    console.error('[kalshi-balance] threw', err);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket US Ed25519 auth
// ─────────────────────────────────────────────────────────────────────────────

// Ed25519 signing via @noble/ed25519 (works on all Deno runtimes, unlike
// crypto.subtle.importKey('raw', ..., 'Ed25519') which requires Deno ≥ 1.40).
let _ed25519Mod: { sign: (msg: Uint8Array, privKey: Uint8Array) => Promise<Uint8Array> } | null = null;
let _polyUsPrivBytes: Uint8Array | null = null;

async function loadEd25519(): Promise<typeof _ed25519Mod> {
  if (_ed25519Mod) return _ed25519Mod;
  try {
    const mod = await import('https://esm.sh/@noble/ed25519@2.1.0');
    _ed25519Mod = { sign: mod.signAsync ?? mod.sign };
    return _ed25519Mod;
  } catch (err) {
    console.error('[poly-us-auth] failed to import @noble/ed25519', err);
    return null;
  }
}

function getPolyUsPrivBytes(): Uint8Array | null {
  if (_polyUsPrivBytes) return _polyUsPrivBytes;
  if (!POLY_US_SECRET_KEY) return null;
  const raw = Uint8Array.from(atob(POLY_US_SECRET_KEY), c => c.charCodeAt(0));
  _polyUsPrivBytes = raw.slice(0, 32);
  return _polyUsPrivBytes;
}

async function polyUsAuthHeaders(
  method: string,
  path: string,
): Promise<Record<string, string>> {
  if (!POLY_US_KEY_ID || !POLY_US_SECRET_KEY) return {};
  const ed = await loadEd25519();
  const privBytes = getPolyUsPrivBytes();
  if (!ed || !privBytes) return {};

  const timestamp = String(Date.now());
  const message   = `${timestamp}${method}${path}`;
  const sigBytes  = await ed.sign(new TextEncoder().encode(message), privBytes);
  const signature = btoa(String.fromCharCode(...sigBytes));

  return {
    'X-PM-Access-Key': POLY_US_KEY_ID,
    'X-PM-Timestamp': timestamp,
    'X-PM-Signature': signature,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'arbor-trade/1',
  };
}

/**
 * Extract Polymarket US market slug from a URL.
 * e.g. "https://polymarket.us/event/yankees-vs-red-sox" → "yankees-vs-red-sox"
 */
function extractPolyUSSlug(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/');
    return parts[parts.length - 1] || null;
  } catch { return null; }
}

/**
 * Fetch Polymarket US account balance via Ed25519 auth.
 * GET https://api.polymarket.us/v1/account/balances
 * Falls back to public data-api if US API fails.
 */
async function getPolymarketBalance(_dryRun: boolean): Promise<number> {
  // Try US API first (has the real $100 balance).
  if (POLY_US_KEY_ID && POLY_US_SECRET_KEY) {
    try {
      const path    = '/v1/account/balances';
      const headers = await polyUsAuthHeaders('GET', path);
      const res     = await fetch(`${POLY_US_API}${path}`, {
        headers, signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        // Response: { balances: [{ currentBalance: 100, buyingPower: 100, ... }] }
        const balArr = data?.balances ?? data;
        const bal = Array.isArray(balArr)
          ? (balArr[0]?.currentBalance ?? balArr[0]?.buyingPower ?? balArr[0]?.balance ?? balArr[0]?.value)
          : (data?.balance ?? data?.currentBalance ?? data?.buyingPower ?? data?.value);
        const dollars = parseFloat(String(bal ?? '0'));
        if (Number.isFinite(dollars) && dollars > 0) {
          console.log('[poly-us-balance]', dollars.toFixed(2));
          return dollars;
        }
        console.log('[poly-us-balance] response (no balance extracted):', JSON.stringify(data).slice(0, 300));
      } else {
        console.warn('[poly-us-balance] HTTP', res.status, await res.text().catch(() => '').then(s => s.slice(0, 200)));
      }
    } catch (err) {
      console.error('[poly-us-balance] threw', err);
    }
  }

  // Fallback: public Data API for global Polymarket.
  if (POLY_FUNDER_ADDRESS) {
    try {
      const url = `https://data-api.polymarket.com/value?user=${encodeURIComponent(POLY_FUNDER_ADDRESS)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json() as Array<{ value?: number | string }>;
        const dollars = parseFloat(String(data?.[0]?.value ?? '0'));
        if (Number.isFinite(dollars)) {
          console.log('[poly-balance-fallback]', dollars.toFixed(2));
          return dollars;
        }
      }
    } catch { /* silent fallback */ }
  }

  return 0;
}

/**
 * Fetch both balances in parallel and update capital_ledger to reflect
 * the real total. Returns { kalshiBalance, polyBalance }.
 */
async function fetchRealBalancesAndSync(
  sb: ReturnType<typeof createClient>,
  dryRun: boolean,
): Promise<{ kalshiBalance: number; polyBalance: number }> {
  const [kalshiBalance, polyBalance] = await Promise.all([
    getKalshiBalance(),
    getPolymarketBalance(dryRun),
  ]);
  console.log('[balances]', JSON.stringify({ kalshiBalance, polyBalance }));

  // Sync to capital_ledger so the Analytics dashboard reflects real state.
  // Only update if at least one balance came back non-zero.
  if (kalshiBalance > 0 || polyBalance > 0) {
    const totalCapital = kalshiBalance + polyBalance;
    const { data: ledgerRow } = await sb
      .from('capital_ledger')
      .select('id')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ledgerRow) {
      await sb.from('capital_ledger')
        .update({ total_capital: totalCapital, updated_at: new Date().toISOString() })
        .eq('id', (ledgerRow as any).id);
    }
  }

  return { kalshiBalance, polyBalance };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capital state
// ─────────────────────────────────────────────────────────────────────────────

interface CapitalState {
  totalCapital: number;
  deployedCapital: number;
  safetyReservePct: number;
  realizedPnl: number;
  activeCapital: number;
}

async function fetchActiveCapital(
  sb: ReturnType<typeof createClient>,
): Promise<CapitalState> {
  const defaults: CapitalState = {
    totalCapital: 500, deployedCapital: 0,
    safetyReservePct: 0.2, realizedPnl: 0, activeCapital: 400,
  };
  const { data, error } = await sb
    .from('capital_ledger')
    .select('total_capital,deployed_capital,safety_reserve_pct,realized_pnl')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return defaults;
  const total    = (data.total_capital    as number) ?? 500;
  const deployed = (data.deployed_capital as number) ?? 0;
  const reserve  = (data.safety_reserve_pct as number) ?? 0.2;
  const pnl      = (data.realized_pnl     as number) ?? 0;
  return {
    totalCapital: total,
    deployedCapital: deployed,
    safetyReservePct: reserve,
    realizedPnl: pnl,
    activeCapital: total * (1 - reserve) - deployed + pnl,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kelly position sizing
// ─────────────────────────────────────────────────────────────────────────────

type LimitingFactor = 'kelly' | 'liquidity' | 'verdict_cap' | 'capital_cap' | 'minimum';

interface SizingResult {
  contracts: number;
  totalDeployed: number;
  kellyFraction: number;
  halfKelly: number;
  rawPosition: number;
  limitingFactor: LimitingFactor;
}

function calculatePositionSize(
  netSpread: number,
  totalCostPerContract: number,
  activeCapital: number,
  verdict: string,
  availableLiquidity: number,  // dollars (totalCost × qty from levels[0])
): SizingResult {
  // Safety rule 2: zero spread → zero size.
  if (netSpread <= 0 || totalCostPerContract <= 0) {
    return { contracts: 0, totalDeployed: 0, kellyFraction: 0, halfKelly: 0, rawPosition: 0, limitingFactor: 'kelly' };
  }

  // Kelly formula for prediction market arb:
  //   edge = netSpread
  //   odds = 1 / totalCost - 1  (profit per dollar staked)
  //   f*   = edge / odds
  const odds = (1 / totalCostPerContract) - 1;
  const rawKelly = odds > 0 ? netSpread / odds : 0;
  // Safety rule 3: cap kelly at 1.0.
  const kellyFraction = Math.min(rawKelly, 1.0);
  const halfKelly  = HALF_KELLY * kellyFraction;
  const rawPosition   = halfKelly * activeCapital;

  // Verdict cap.
  const verdictCap = verdict.toUpperCase() === 'SAFE' ? MAX_POSITION_SAFE : MAX_POSITION_CAUTION;
  // Capital cap: never > 40% of active capital.
  const capitalCap = MAX_CAPITAL_FRACTION * activeCapital;

  // Determine the binding limit.
  let finalUSD    = rawPosition;
  let limitingFactor: LimitingFactor = 'kelly';

  if (availableLiquidity < finalUSD) { finalUSD = availableLiquidity; limitingFactor = 'liquidity'; }
  if (verdictCap          < finalUSD) { finalUSD = verdictCap;         limitingFactor = 'verdict_cap'; }
  if (capitalCap          < finalUSD) { finalUSD = capitalCap;         limitingFactor = 'capital_cap'; }

  // Convert dollars to whole contracts.
  const contracts = Math.max(0, Math.floor(finalUSD / totalCostPerContract));
  const totalDeployed = contracts * totalCostPerContract;

  // Safety rule 1: enforce minimum.
  if (totalDeployed < MIN_POSITION_USD && contracts > 0) {
    // Check if even 1 contract is worth executing.
    if (totalCostPerContract >= MIN_POSITION_USD) {
      // 1 contract is already above min — keep it.
    } else {
      // Try rounding up to meet minimum.
      const minContracts = Math.ceil(MIN_POSITION_USD / totalCostPerContract);
      const minDeployed  = minContracts * totalCostPerContract;
      // Only round up if it stays within all caps.
      if (minDeployed <= Math.min(availableLiquidity, verdictCap, capitalCap)) {
        return {
          contracts: minContracts, totalDeployed: minDeployed,
          kellyFraction, halfKelly, rawPosition, limitingFactor: 'minimum',
        };
      }
    }
  }

  const result: SizingResult = {
    contracts, totalDeployed: contracts * totalCostPerContract,
    kellyFraction, halfKelly, rawPosition, limitingFactor,
  };

  console.log('[kelly-sizing-v2]', JSON.stringify({
    fraction: 'half-kelly',
    netSpread, odds: Number(odds.toFixed(4)),
    kellyFraction: Number(kellyFraction.toFixed(4)),
    halfKelly: Number(halfKelly.toFixed(4)),
    activeCapital: Number(activeCapital.toFixed(2)),
    halfKellyRaw: Number(rawPosition.toFixed(2)),
    finalUSD: Number(result.totalDeployed.toFixed(2)),
    contracts: result.contracts,
    limitingFactor: result.limitingFactor,
    verdict,
  }));

  return result;
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi RSA-PSS auth (identical to scanner)
// ─────────────────────────────────────────────────────────────────────────────

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

let _kalshiCryptoKey: CryptoKey | null = null;

async function kalshiAuthHeaders(
  method: string,
  path: string,
): Promise<Record<string, string>> {
  if (!KALSHI_API_KEY_ID || !KALSHI_PRIVATE_KEY) return {};
  if (!_kalshiCryptoKey) {
    const keyBuffer = pemToArrayBuffer(KALSHI_PRIVATE_KEY);
    _kalshiCryptoKey = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      keyBuffer,
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  const timestamp = String(Date.now());
  // Kalshi requires full path starting with /trade-api/v2 and saltLength=32.
  const fullPath = path.startsWith('/trade-api/v2') ? path : `/trade-api/v2${path}`;
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 },
    _kalshiCryptoKey,
    new TextEncoder().encode(`${timestamp}${method}${fullPath}`),
  );
  return {
    'KALSHI-ACCESS-KEY': KALSHI_API_KEY_ID,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': bufferToBase64(sig),
    'Content-Type': 'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket CLOB auth
// ─────────────────────────────────────────────────────────────────────────────
//
// Polymarket CLOB uses two-layer auth:
//   L1: ECDSA wallet signature (proves wallet ownership)
//   L2: API key derived from the wallet (used for order signing)
//
// We implement this without the @polymarket/clob-client npm package because
// the Deno edge runtime doesn't support all Node.js modules that package
// requires (fs, path, etc.). Instead we use the raw HTTP API directly with
// ethers.js for signing.
//
// L2 key derivation: POST /auth/derive-api-key with a signed nonce.
// Order placement: POST /order with L2 HMAC signature.

interface PolyL2Creds {
  apiKey: string;
  secret: string;
  passphrase: string;
  address: string;
}

let _polyL2Creds: PolyL2Creds | null = null;

/**
 * Get Polymarket L2 API credentials.
 * Priority: pre-configured POLYMARKET_KEY_ID/SECRET_ID env vars (fastest).
 * Fallback: derive from wallet via POLY_PRIVATE_KEY (requires ethers.js).
 * Dry-run: return stubs.
 */
async function getPolyL2Creds(dryRun: boolean): Promise<PolyL2Creds | null> {
  if (_polyL2Creds) return _polyL2Creds;

  // Priority 1: pre-configured CLOB API credentials (no wallet signing needed).
  if (POLYMARKET_KEY_ID && POLYMARKET_SECRET_ID) {
    _polyL2Creds = {
      apiKey:     POLYMARKET_KEY_ID,
      secret:     POLYMARKET_SECRET_ID,
      passphrase: '', // Polymarket CLOB doesn't require passphrase with direct API keys
      address:    POLY_FUNDER_ADDRESS || '',
    };
    console.log('[poly-auth] using pre-configured CLOB API key', POLYMARKET_KEY_ID.slice(0, 8) + '...');
    return _polyL2Creds;
  }

  if (dryRun) {
    return {
      apiKey: 'dry-run-api-key',
      secret: 'dry-run-secret',
      passphrase: 'dry-run-passphrase',
      address: POLY_FUNDER_ADDRESS || '0xdryrun',
    };
  }

  // Fallback: derive from wallet private key.
  if (!POLY_PRIVATE_KEY) {
    console.error('[poly-auth] no credentials configured — set POLYMARKET_KEY_ID+SECRET_ID or POLY_PRIVATE_KEY');
    return null;
  }
  try {
    const { ethers } = await import('https://esm.sh/ethers@6.11.1');
    const wallet  = new ethers.Wallet(POLY_PRIVATE_KEY);
    const address = wallet.address;
    const nonce   = Math.floor(Date.now() / 1000);
    const signature = await wallet.signMessage(String(nonce));

    const res = await fetch(`${POLY_CLOB_BASE}/auth/derive-api-key`, {
      method: 'GET',
      headers: {
        'POLY_ADDRESS': address, 'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': String(nonce), 'POLY_NONCE': String(nonce),
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      console.error('[poly-auth] derive-api-key failed', res.status);
      return null;
    }
    const data = await res.json() as { apiKey?: string; secret?: string; passphrase?: string };
    if (!data.apiKey || !data.secret) return null;
    _polyL2Creds = { apiKey: data.apiKey, secret: data.secret, passphrase: data.passphrase ?? '', address };
    console.log('[poly-auth] L2 creds derived for', address);
    return _polyL2Creds;
  } catch (err) {
    console.error('[poly-auth] derivation threw', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution functions
// ─────────────────────────────────────────────────────────────────────────────

interface FillResult {
  orderId: string;
  filled: number;
  avgPrice: number;
}

/**
 * Place a limit order on Kalshi. Returns fill details or null on failure.
 * In dry-run mode logs the request body and returns a synthetic fill.
 */
async function executeKalshiOrder(
  ticker: string,
  side: 'yes' | 'no',
  count: number,
  priceInCents: number,
  dryRun: boolean,
): Promise<FillResult | null> {
  const body = {
    ticker,
    action: 'buy',
    side,
    count,
    yes_price: side === 'yes' ? priceInCents : 100 - priceInCents,
    time_in_force: 'good_til_cancelled',
  };
  if (dryRun) {
    console.log('[kalshi-order-dry-run]', JSON.stringify({
      endpoint: `POST ${KALSHI_TRADING_BASE}/portfolio/orders`,
      body,
    }));
    return {
      orderId: 'dry-run-kalshi-' + Date.now(),
      filled: count,
      avgPrice: priceInCents / 100,
    };
  }
  const signPath = '/portfolio/orders';
  try {
    const headers = await kalshiAuthHeaders('POST', signPath);
    const res = await fetch(`${KALSHI_TRADING_BASE}${signPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as any;
    console.log('[kalshi-order]', JSON.stringify({
      status: res.status,
      ticker,
      side,
      count,
      priceInCents,
      response: data,
    }));
    if (!res.ok) return null;
    const order = data.order ?? data;
    return {
      orderId: order.order_id ?? order.id ?? String(Date.now()),
      filled: order.quantity_filled ?? order.filled ?? count,
      avgPrice: (order.avg_price ?? priceInCents) / 100,
    };
  } catch (err) {
    console.error('[kalshi-order] threw', err);
    return null;
  }
}

/**
 * Place a BUY order on Polymarket US via Ed25519 auth.
 * POST https://api.polymarket.us/v1/orders
 *
 * For arb: tokenId is the hedge token. We extract the market slug from the
 * opportunity's polyMarket.url and determine buy intent from the side.
 *
 * @param tokenId   - Poly token ID (used for slug extraction fallback + logging)
 * @param price     - Price per contract (0-1 decimal)
 * @param size      - Number of contracts
 * @param funderAddress - Poly wallet address (used for legacy fallback only)
 * @param dryRun    - If true, log and return synthetic fill
 * @param polyUrl   - The polyMarket.url from the opportunity (for slug extraction)
 * @param isHedge   - True if this is the NO/hedge side (ORDER_INTENT_BUY_SHORT)
 */
async function executePolymarketOrder(
  tokenId: string,
  price: number,
  size: number,
  funderAddress: string,
  dryRun: boolean,
  polyUrl?: string,
  isHedge = true,
): Promise<FillResult | null> {
  const slug = polyUrl ? extractPolyUSSlug(polyUrl) : null;
  const intent = isHedge ? 'ORDER_INTENT_BUY_SHORT' : 'ORDER_INTENT_BUY_LONG';

  const orderBody = {
    marketSlug: slug ?? tokenId, // slug preferred; fall back to tokenId as identifier
    intent,
    type: 'ORDER_TYPE_LIMIT',
    price: { value: price.toFixed(2), currency: 'USD' },
    quantity: Math.round(size),
    tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
  };

  if (dryRun) {
    console.log('[poly-us-order-dry-run]', JSON.stringify({
      url: `${POLY_US_API}/v1/orders`,
      slug,
      intent,
      price: price.toFixed(4),
      quantity: Math.round(size),
      dryRun: true,
    }));
    return {
      orderId: 'dry-run-poly-us-' + Date.now(),
      filled: Math.round(size),
      avgPrice: price,
    };
  }

  if (!POLY_US_KEY_ID || !POLY_US_SECRET_KEY) {
    console.error('[poly-us-order] POLY_US_KEY_ID/SECRET_KEY not set');
    return null;
  }

  try {
    const path    = '/v1/orders';
    const headers = await polyUsAuthHeaders('POST', path);
    const bodyStr = JSON.stringify(orderBody);

    const res = await fetch(`${POLY_US_API}${path}`, {
      method: 'POST',
      headers,
      body: bodyStr,
    });
    const data = await res.json().catch(() => ({})) as any;
    console.log('[poly-us-order]', JSON.stringify({
      status: res.status,
      slug,
      intent,
      price,
      size: Math.round(size),
      response: data,
    }));
    if (!res.ok) return null;

    const order = data.order ?? data;
    return {
      orderId: order.id ?? order.orderId ?? order.order_id ?? String(Date.now()),
      filled:  parseFloat(String(order.filledQuantity ?? order.filled ?? order.sizeMatched ?? size)),
      avgPrice: parseFloat(String(order.avgPrice ?? order.avg_price ?? price)),
    };
  } catch (err) {
    console.error('[poly-us-order] threw', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram helpers
// ─────────────────────────────────────────────────────────────────────────────

async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    console.error(`[trade] tg ${method} failed`, res.status, JSON.stringify(json));
  }
  return json;
}

async function answerCallback(id: string, text?: string): Promise<void> {
  await tg('answerCallbackQuery', { callback_query_id: id, text: text ?? '' });
}

async function editMessage(chatId: number | string, messageId: number, text: string): Promise<void> {
  await tg('editMessageText', {
    chat_id: chatId, message_id: messageId,
    text, parse_mode: 'HTML', disable_web_page_preview: true,
  });
}

async function sendMessage(chatId: number | string, text: string): Promise<void> {
  await tg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function slugifyId(marketId: string): string {
  return (marketId || '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 32).replace(/^_+|_+$/g, '');
}

function htmlEscape(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

interface Opportunity {
  id?: string;
  kalshiMarket: {
    marketId?: string;
    title?: string;
    url?: string;
    noTokenId?: string;
    yesTokenId?: string;
  };
  polyMarket: {
    marketId?: string;
    title?: string;
    url?: string;
    noTokenId?: string;
    yesTokenId?: string;
  };
  verdict?: string;
  verdictReasoning?: string;
  levels: Level[];
  bestNetSpread: number;
  totalMaxProfit: number;
  daysToClose: number;
  annualizedReturn: number;
  effectiveCloseDate?: string;
  belowThreshold?: boolean;
}

async function findOpportunityBySlug(
  sb: ReturnType<typeof createClient>,
  slug: string,
): Promise<Opportunity | null> {
  const { data, error } = await sb
    .from('scan_results')
    .select('opportunities, scanned_at')
    .order('scanned_at', { ascending: false })
    .limit(3);
  if (error) { console.error('[trade] scan_results query failed', error); return null; }
  for (const row of data ?? []) {
    const opps = (row as any).opportunities as Opportunity[] | null;
    if (!Array.isArray(opps)) continue;
    for (const o of opps) {
      if (slugifyId(o.kalshiMarket?.marketId || o.id || '') === slug) return o;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler: execute both legs
// ─────────────────────────────────────────────────────────────────────────────

async function handleBuy(
  sb: ReturnType<typeof createClient>,
  slug: string,
  chatId: number,
  messageId: number,
  callbackId: string,
  dryRun: boolean,
): Promise<void> {
  const opp = await findOpportunityBySlug(sb, slug);
  if (!opp) {
    await answerCallback(callbackId, 'Opportunity not found');
    await editMessage(chatId, messageId,
      '⚠️ <b>Opportunity not found</b>\nCouldn\'t match this alert against the 3 most recent scans.');
    return;
  }

  const lvl = opp.levels[0];
  const kTitle = opp.kalshiMarket.title || '';
  const pTitle = opp.polyMarket.title || '';
  const kTicker = opp.kalshiMarket.marketId || '';

  // Determine which platform is which side.
  const kalshiSide: 'yes' | 'no' = lvl.buyYesPlatform === 'kalshi' ? 'yes' : 'no';
  const kalshiRawPrice = kalshiSide === 'yes' ? lvl.buyYesPrice : lvl.buyNoPrice;
  const polyRawPrice   = kalshiSide === 'yes' ? lvl.buyNoPrice  : lvl.buyYesPrice;

  // The poly token to buy is the hedge (no-side relative to kalshi yes).
  // polyMarket.noTokenId is set by the polarity verifier to the hedge token.
  const polyTokenId = opp.polyMarket.noTokenId
    ?? opp.polyMarket.yesTokenId
    ?? '';

  if (!polyTokenId) {
    await answerCallback(callbackId, 'Missing Poly token ID');
    await editMessage(chatId, messageId,
      '⚠️ <b>Missing Polymarket token ID</b>\nThis opportunity needs to be re-verified by Claude.');
    return;
  }

  // Fetch real live balances from both platforms and update capital_ledger.
  const { kalshiBalance, polyBalance } = await fetchRealBalancesAndSync(sb, dryRun);
  // Use real balances if available; fall back to capital_ledger otherwise.
  const capital = await fetchActiveCapital(sb);
  const realTotal = (kalshiBalance + polyBalance) > 0
    ? kalshiBalance + polyBalance
    : capital.totalCapital;
  const activeCapital = realTotal * 0.90;

  // Safety rule 1: refuse if active capital is below minimum.
  if (activeCapital < MIN_POSITION_USD) {
    await answerCallback(callbackId, 'Insufficient capital');
    await sendMessage(chatId,
      `⚠️ Active capital below $${MIN_POSITION_USD} ($${activeCapital.toFixed(2)} available) — ` +
      `no trades will execute until capital is replenished.\n` +
      `💳 Kalshi: $${kalshiBalance.toFixed(2)} | Poly: $${polyBalance.toFixed(2)}`);
    return;
  }

  const costPerPair = kalshiRawPrice + polyRawPrice;
  const availableLiquidity = (lvl.totalCost ?? costPerPair) * lvl.quantity;
  const sizing = calculatePositionSize(
    opp.bestNetSpread,
    costPerPair,
    activeCapital,
    opp.verdict ?? 'CAUTION',
    availableLiquidity,
  );

  let qty = sizing.contracts;
  if (qty > 0) {
    // Check actual per-leg costs at the Kelly-sized quantity.
    const kCost = kalshiRawPrice * qty;
    const pCost = polyRawPrice   * qty;
    if (kalshiBalance > 0 && kalshiBalance < kCost) {
      await answerCallback(callbackId, 'Insufficient Kalshi balance');
      await editMessage(chatId, messageId,
        `⚠️ <b>Insufficient Kalshi balance</b>\n\n` +
        `Required: <b>$${kCost.toFixed(2)}</b>\n` +
        `Available: <b>$${kalshiBalance.toFixed(2)}</b>\n\n` +
        `Top up at <a href="https://kalshi.com">kalshi.com</a> before trading.`);
      await sb.from('positions').update({ status: 'cancelled' }).eq('id', 'pending');
      return;
    }
    if (polyBalance > 0 && polyBalance < pCost) {
      await answerCallback(callbackId, 'Insufficient Polymarket balance');
      await editMessage(chatId, messageId,
        `⚠️ <b>Insufficient Polymarket balance</b>\n\n` +
        `Required: <b>$${pCost.toFixed(2)}</b>\n` +
        `Available: <b>$${polyBalance.toFixed(2)}</b>\n\n` +
        `Top up at <a href="https://polymarket.com">polymarket.com</a> before trading.`);
      return;
    }
  }
  if (qty < 1) {
    await answerCallback(callbackId, 'Position too small');
    await editMessage(chatId, messageId,
      `⚠️ <b>Kelly sizing resulted in 0 contracts</b>\n\n` +
      `Active capital: $${activeCapital.toFixed(2)}\n` +
      `Net spread: ${(opp.bestNetSpread * 100).toFixed(1)}%\n` +
      `Kelly fraction: ${(sizing.kellyFraction * 100).toFixed(1)}%\n` +
      `Limiting factor: ${sizing.limitingFactor}`);
    return;
  }

  const kalshiPriceInCents = Math.round(kalshiRawPrice * 100);
  const totalDeployed = sizing.totalDeployed;
  const expectedProfit = Math.round(opp.totalMaxProfit * (qty / lvl.quantity));

  const dryLabel = dryRun ? ' [DRY RUN]' : '';
  await answerCallback(callbackId, dryRun ? 'Dry run — logging only' : 'Executing...');

  // Insert pending position row.
  const insertRow: Record<string, unknown> = {
    kalshi_market_id: kTicker,
    kalshi_title: kTitle,
    poly_market_id: opp.polyMarket.marketId ?? null,
    poly_title: pTitle,
    status: 'pending',
    intended_kalshi_side: kalshiSide,
    intended_poly_side: kalshiSide === 'yes' ? 'no' : 'yes',
    opportunity_id: slug,
    kelly_fraction: sizing.kellyFraction,
    limiting_factor: sizing.limitingFactor,
    active_capital_at_execution: activeCapital,
  };
  const { data: posRow, error: insertErr } = await sb
    .from('positions').insert(insertRow).select('id').single();
  if (insertErr || !posRow) {
    console.error('[trade] position insert failed', insertErr);
    await editMessage(chatId, messageId,
      `⚠️ <b>DB insert failed</b>\n<code>${htmlEscape(insertErr?.message ?? 'unknown')}</code>`);
    return;
  }
  const positionId = (posRow as any).id as string;

  // Show "executing" state while orders are in flight.
  await editMessage(chatId, messageId,
    `⚙️ <b>Executing${dryLabel}...</b>\n\n` +
    `<b>${htmlEscape(kTitle.slice(0,60))}</b>\n\n` +
    `Kalshi  →  ${kalshiSide.toUpperCase()} @ $${kalshiRawPrice.toFixed(2)}  ×  ${qty} contracts\n` +
    `Polymarket  →  hedge @ $${polyRawPrice.toFixed(2)}  ×  ${qty} contracts`);

  console.log('[execution]', JSON.stringify({
    opportunity: slug,
    positionId,
    dryRun,
    kalshi: { ticker: kTicker, side: kalshiSide, count: qty, priceInCents: kalshiPriceInCents },
    poly: { tokenId: polyTokenId, price: polyRawPrice, size: qty, funder: POLY_FUNDER_ADDRESS },
    totalDeployed: totalDeployed.toFixed(2),
    expectedProfit,
    balances: { kalshiBalance, polyBalance },
  }));

  // Execute both legs simultaneously.
  const [kalshiResult, polyResult] = await Promise.all([
    executeKalshiOrder(kTicker, kalshiSide, qty, kalshiPriceInCents, dryRun),
    executePolymarketOrder(polyTokenId, polyRawPrice, qty, POLY_FUNDER_ADDRESS, dryRun, opp.polyMarket.url, true),
  ]);

  const kalshiOk = kalshiResult !== null;
  const polyOk   = polyResult !== null;
  const bothOk   = kalshiOk && polyOk;
  const noneOk   = !kalshiOk && !polyOk;

  // Determine final status and build update.
  const finalStatus = bothOk ? 'open' : noneOk ? 'failed' : 'partial';
  const update: Record<string, unknown> = {
    status: finalStatus,
    executed_at: new Date().toISOString(),
  };
  if (kalshiResult) {
    update.kalshi_order_id      = kalshiResult.orderId;
    update.kalshi_fill_price    = kalshiResult.avgPrice;
    update.kalshi_fill_quantity = kalshiResult.filled;
  }
  if (polyResult) {
    update.poly_order_id      = polyResult.orderId;
    update.poly_fill_price    = polyResult.avgPrice;
    update.poly_fill_quantity = polyResult.filled;
  }
  await sb.from('positions').update(update).eq('id', positionId);

  const settleDate = opp.effectiveCloseDate
    ? new Date(opp.effectiveCloseDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : `${opp.daysToClose.toFixed(0)}d`;
  const kTitleShort = kTitle.length > 60 ? kTitle.slice(0, 59) + '…' : kTitle;

  let tgMsg: string;
  if (bothOk) {
    const actualDeployed = (kalshiResult!.avgPrice * kalshiResult!.filled) +
                           (polyResult!.avgPrice * polyResult!.filled);

    // Track deployed capital so the system knows how much is in open positions.
    try {
      const { data: ledger } = await sb
        .from('capital_ledger')
        .select('id, deployed_capital')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ledger) {
        const newDeployed = ((ledger.deployed_capital as number) ?? 0) + actualDeployed;
        await sb.from('capital_ledger')
          .update({ deployed_capital: newDeployed, updated_at: new Date().toISOString() })
          .eq('id', (ledger as any).id);
        console.log('[capital-deployed]', JSON.stringify({
          added: Number(actualDeployed.toFixed(2)),
          newDeployed: Number(newDeployed.toFixed(2)),
        }));
      }
    } catch (err) {
      console.error('[capital-deployed] update failed', err);
    }

    tgMsg =
      `✅ <b>EXECUTED${dryLabel}</b>\n\n` +
      `<b>${htmlEscape(kTitleShort)}</b>\n\n` +
      `<code>Kalshi     ${kalshiSide.toUpperCase().padEnd(6)}$${kalshiResult!.avgPrice.toFixed(2)}  ×  ${kalshiResult!.filled}</code>\n` +
      `<code>Polymarket hedge  $${polyResult!.avgPrice.toFixed(2)}  ×  ${polyResult!.filled}</code>\n\n` +
      `Deployed  <b>$${actualDeployed.toFixed(2)}</b>\n` +
      `Profit    <b>+$${expectedProfit}</b>  when settled ${settleDate}\n\n` +
      `<code>${positionId}</code>`;
  } else if (noneOk) {
    tgMsg =
      `❌ <b>Execution failed — no position opened${dryLabel}</b>\n\n` +
      `<b>${htmlEscape(kTitleShort)}</b>\n\n` +
      `Both legs returned errors. No capital deployed.\n` +
      `Check platform status and try again if spread persists.\n\n` +
      `<code>${positionId}</code>`;
  } else {
    const filledPlatform   = kalshiOk ? 'Kalshi'      : 'Polymarket';
    const failedPlatform   = kalshiOk ? 'Polymarket'  : 'Kalshi';
    const failedMarket     = kalshiOk ? pTitle : kTitle;
    const failedSide       = kalshiOk ? (kalshiSide === 'yes' ? 'NO' : 'YES') : kalshiSide.toUpperCase();
    const failedPrice      = kalshiOk ? polyRawPrice : kalshiRawPrice;
    tgMsg =
      `⚠️ <b>PARTIAL FILL — ACT NOW${dryLabel}</b>\n\n` +
      `${filledPlatform} leg filled ✅\n` +
      `${failedPlatform} leg failed ❌\n\n` +
      `You have an open unhedged position.\n\n` +
      `Manually execute on ${failedPlatform}:\n` +
      `<code>${htmlEscape(failedMarket.slice(0,60))}</code>\n` +
      `Buy ${failedSide} @ $${failedPrice.toFixed(2)}\n\n` +
      `Or immediately close your ${filledPlatform} position.\n\n` +
      `<code>${positionId}</code>`;
  }
  await editMessage(chatId, messageId, tgMsg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution arb handler (single-leg)
// ─────────────────────────────────────────────────────────────────────────────

async function handleResolutionBuy(
  sb: ReturnType<typeof createClient>,
  oppId: string,        // slugified market_id (after 'res_buy_')
  chatId: number,
  messageId: number,
  callbackId: string,
  dryRun: boolean,
): Promise<void> {
  // Look up the resolution opportunity by matching slugified market_id.
  const { data: rows, error } = await sb
    .from('resolution_opportunities')
    .select('*')
    .eq('executed', false)
    .eq('expired', false)
    .order('detected_at', { ascending: false })
    .limit(50);

  if (error) {
    await answerCallback(callbackId, 'DB error');
    await editMessage(chatId, messageId,
      `⚠️ <b>DB error</b>\n<code>${htmlEscape(error.message)}</code>`);
    return;
  }

  // Match by slugified market_id.
  const opp = (rows ?? []).find((r: any) => {
    const slug = (r.market_id as string).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 32).replace(/^_+|_+$/g, '');
    return slug === oppId;
  }) as any | undefined;

  if (!opp) {
    await answerCallback(callbackId, 'Opportunity not found or already executed');
    await editMessage(chatId, messageId,
      '⚠️ <b>Resolution opportunity not found</b>\nIt may have already been executed or expired.');
    return;
  }

  const ticker     = opp.market_id  as string;
  const title      = opp.market_title as string;
  const side       = opp.winning_side as 'yes' | 'no';
  const winningAsk = parseFloat(opp.winning_ask as string);
  const netPct     = parseFloat(opp.estimated_profit_pct as string);

  // Size: use a conservative $200 cap for resolution arb since it's single-leg guaranteed.
  const MAX_RESOLUTION_USD = 200;
  const qty           = Math.max(1, Math.floor(MAX_RESOLUTION_USD / winningAsk));
  const deployed      = (winningAsk * qty).toFixed(2);
  const grossProfit   = ((1 - winningAsk) * qty).toFixed(2);
  const netProfit     = ((1 - winningAsk) * 0.99 * qty).toFixed(2);
  const priceInCents  = Math.round(winningAsk * 100);
  const dryLabel      = dryRun ? ' [DRY RUN]' : '';

  // Fetch real Kalshi balance (single-leg resolution only needs Kalshi).
  const kalshiBalance = await getKalshiBalance();
  const legCost = winningAsk * qty;
  if (kalshiBalance > 0 && kalshiBalance < legCost) {
    await answerCallback(callbackId, 'Insufficient Kalshi balance');
    await editMessage(chatId, messageId,
      `⚠️ <b>Insufficient Kalshi balance</b>\n\nRequired: <b>$${legCost.toFixed(2)}</b>\nAvailable: <b>$${kalshiBalance.toFixed(2)}</b>`);
    return;
  }

  await answerCallback(callbackId, dryRun ? 'Dry run' : 'Executing resolution arb...');

  // Insert pending position (single-leg, trade_type='resolution').
  const insertRow: Record<string, unknown> = {
    kalshi_market_id:    ticker,
    kalshi_title:        title,
    poly_market_id:      null,
    poly_title:          null,
    status:              'pending',
    intended_kalshi_side: side,
    intended_poly_side:  null,
    opportunity_id:      oppId,
    trade_type:          'resolution',
  };
  const { data: posRow, error: insertErr } = await sb
    .from('positions').insert(insertRow).select('id').single();
  if (insertErr || !posRow) {
    console.error('[trade-resolution] position insert failed', insertErr);
    await editMessage(chatId, messageId,
      `⚠️ <b>DB insert failed</b>\n<code>${htmlEscape(insertErr?.message ?? 'unknown')}</code>`);
    return;
  }
  const positionId = (posRow as any).id as string;

  // Show executing state.
  await editMessage(chatId, messageId,
    `⚙️ <b>Executing resolution arb${dryLabel}...</b>\n\n${htmlEscape(title)}\n\n` +
    `KALSHI — Buy ${side.toUpperCase()} @ $${winningAsk.toFixed(4)} × ${qty} contracts\n` +
    `Expected payout: $${qty}.00`);

  console.log('[resolution-execution]', JSON.stringify({
    positionId, ticker, side, qty, priceInCents, deployed, dryRun,
  }));

  // Execute single leg only.
  const result = await executeKalshiOrder(ticker, side, qty, priceInCents, dryRun);

  const finalStatus = result ? 'open' : 'failed';
  const update: Record<string, unknown> = {
    status:       finalStatus,
    executed_at:  new Date().toISOString(),
    trade_type:   'resolution',
  };
  if (result) {
    update.kalshi_order_id      = result.orderId;
    update.kalshi_fill_price    = result.avgPrice;
    update.kalshi_fill_quantity = result.filled;
  }
  await sb.from('positions').update(update).eq('id', positionId);

  // Mark opportunity as executed.
  await sb.from('resolution_opportunities')
    .update({ executed: true })
    .eq('market_id', ticker);

  let tgMsg: string;
  if (result) {
    const resDeployed = (result.avgPrice * result.filled);
    const resProfit   = ((1 - result.avgPrice) * 0.99 * result.filled);
    tgMsg =
      `🏁 <b>RESOLUTION EXECUTED${dryLabel}</b>\n\n` +
      `<b>${htmlEscape(title.slice(0,60))}</b>\n\n` +
      `<code>BUY ${side.toUpperCase().padEnd(4)} kalshi  $${result.avgPrice.toFixed(2)}  ×  ${result.filled}</code>\n\n` +
      `Deployed <b>$${resDeployed.toFixed(2)}</b>  →  profit <b>+$${resProfit.toFixed(2)}</b>\n` +
      `Settles within 2 hours\n\n` +
      `<code>${positionId}</code>`;
  } else {
    tgMsg =
      `❌ <b>Execution failed — no position opened${dryLabel}</b>\n\n` +
      `<b>${htmlEscape(title.slice(0,60))}</b>\n\n` +
      `Order not placed. Check platform status.\n\n` +
      `<code>${positionId}</code>`;
  }
  await editMessage(chatId, messageId, tgMsg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Skip handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleSkip(
  sb: ReturnType<typeof createClient>,
  slug: string,
  chatId: number,
  messageId: number,
  callbackId: string,
  originalText?: string,
): Promise<void> {
  await answerCallback(callbackId, 'Skipped');
  let label = slug;
  if (originalText) {
    for (const line of originalText.split('\n')) {
      const t = line.trim();
      if (t) { label = t; break; }
    }
  }
  await editMessage(chatId, messageId, `⏭ <b>Skipped</b>\n${htmlEscape(label)}`);

  // Record skip in spread_events for 24h dedup cooldown.
  // The slug is the kalshi market ID slugified; try to match spread_events pair_id.
  await sb.from('spread_events')
    .update({ skipped_at: new Date().toISOString() })
    .like('pair_id', `%${slug}%`)
    .is('closed_at', null)
    .catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Message handler (/done_uuid)
// ─────────────────────────────────────────────────────────────────────────────

function fmtDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60)  return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function handleStats(chatId: number | string): Promise<void> {
  try {
    const analyticsUrl = (SUPABASE_URL || '').replace(/\/$/, '') + '/functions/v1/analytics';
    const res = await fetch(analyticsUrl, {
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      await sendMessage(chatId, `⚠️ Analytics fetch failed: HTTP ${res.status}`);
      return;
    }
    const d = await res.json() as any;

    const pctAlerted  = d.totalSpreadsDetected > 0
      ? Math.round(d.totalSpreadsAlerted  / d.totalSpreadsDetected * 100)
      : 0;
    const pctExecuted = d.totalSpreadsDetected > 0
      ? Math.round(d.totalSpreadsExecuted / d.totalSpreadsDetected * 100)
      : 0;

    const msg =
      `📊 <b>SPREAD ANALYTICS</b>\n\n` +
      `Avg duration:    <b>${fmtDuration(d.avgSpreadDurationSeconds)}</b>\n` +
      `Median duration: <b>${fmtDuration(d.medianSpreadDurationSeconds)}</b>\n` +
      `Fastest close:   <b>${fmtDuration(d.fastestClosedSeconds)}</b>\n` +
      `Open now:        <b>${d.openSpreads}</b>\n\n` +
      `Total detected:  <b>${d.totalSpreadsDetected}</b>\n` +
      `Alerted:         <b>${d.totalSpreadsAlerted}</b> (${pctAlerted}%)\n` +
      `Executed:        <b>${d.totalSpreadsExecuted}</b> (${pctExecuted}%)\n\n` +
      `Avg peak spread: <b>+${d.avgPeakSpread ?? '—'}%</b>\n` +
      `Spread decay:    <b>${d.spreadDecayRate ?? '—'}%</b> (first→last)\n\n` +
      `<b>Fastpoll vs Scanner:</b>\n` +
      `Fastpoll avg:  ${fmtDuration(d.bySource?.fastpoll?.avgDuration ?? null)} (${d.bySource?.fastpoll?.count ?? 0} events)\n` +
      `Scanner avg:   ${fmtDuration(d.bySource?.scanner?.avgDuration ?? null)} (${d.bySource?.scanner?.count ?? 0} events)`;

    await sendMessage(chatId, msg);
  } catch (err) {
    await sendMessage(chatId, `⚠️ /stats error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleMessage(
  sb: ReturnType<typeof createClient>,
  msg: any,
): Promise<void> {
  const chatId = msg?.chat?.id;
  const text: string = msg?.text ?? '';
  if (!chatId) return;

  if (text.trim() === '/stats') {
    await handleStats(chatId);
    return;
  }

  const doneMatch = text.match(/^\/done_([0-9a-fA-F-]{36})/);
  if (doneMatch) {
    const uuid = doneMatch[1];
    const { error } = await sb.from('positions').update({ status: 'open' }).eq('id', uuid);
    if (error) {
      await sendMessage(chatId, `⚠️ Update failed: <code>${htmlEscape(error.message)}</code>`);
      return;
    }
    await sendMessage(chatId,
      `✅ Position <code>${uuid}</code> marked as OPEN.\nSettlement will be tracked automatically.`);
    return;
  }

  const cancelMatch = text.match(/^\/cancel_([0-9a-fA-F-]{36})/);
  if (cancelMatch) {
    const uuid = cancelMatch[1];
    const { error } = await sb.from('positions').update({ status: 'cancelled' }).eq('id', uuid);
    if (error) {
      await sendMessage(chatId, `⚠️ Cancel failed: <code>${htmlEscape(error.message)}</code>`);
      return;
    }
    await sendMessage(chatId, `🚫 Position <code>${uuid}</code> cancelled.`);
    return;
  }

  await sendMessage(chatId,
    'Commands:\n/stats — spread analytics\n/done_{uuid} — mark position as filled\n/cancel_{uuid} — cancel pending position');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 });
  if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response('missing env', { status: 500 });
  }

  const url = new URL(req.url);
  // ?dryRun=1 on the URL OR {"dryRun":true} in the body activates dry-run mode.
  const urlDryRun = url.searchParams.get('dryRun') === '1' || GLOBAL_DRY_RUN;

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let update: any = {};
  try { update = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const bodyDryRun = update.dryRun === true;
  const dryRun = urlDryRun || bodyDryRun;

  // Manual dry-run invocation: POST {"dryRun":true,"slug":"KXMLB..."}
  if (dryRun && update.slug) {
    const slug = update.slug as string;
    console.log('[trade] manual dry-run for slug:', slug);
    // Fake chatId/messageId for dry-run (we'll send to TELEGRAM_CHAT_ID directly).
    const chatId = parseInt(TELEGRAM_CHAT_ID, 10) || 0;
    // Use sendMessage instead of editMessage since there's no real message to edit.
    const opp = await findOpportunityBySlug(sb, slug);
    if (!opp) {
      return new Response(JSON.stringify({ ok: false, error: 'opportunity not found' }),
        { headers: { 'Content-Type': 'application/json' } });
    }
    const lvl = opp.levels[0];
    const kalshiSide: 'yes' | 'no' = lvl.buyYesPlatform === 'kalshi' ? 'yes' : 'no';
    const kalshiRawPrice = kalshiSide === 'yes' ? lvl.buyYesPrice : lvl.buyNoPrice;
    const polyRawPrice   = kalshiSide === 'yes' ? lvl.buyNoPrice  : lvl.buyYesPrice;
    const costPerPair = kalshiRawPrice + polyRawPrice;
    const polyTokenId = opp.polyMarket.noTokenId ?? opp.polyMarket.yesTokenId ?? '';
    const kalshiPriceInCents = Math.round(kalshiRawPrice * 100);

    // Fetch real balances + Kelly sizing for dry-run.
    const { kalshiBalance, polyBalance } = await fetchRealBalancesAndSync(sb, dryRun);
    const capital = await fetchActiveCapital(sb);
    const realTotal = (kalshiBalance + polyBalance) > 0
      ? kalshiBalance + polyBalance
      : capital.totalCapital;
    const activeCapital = realTotal * 0.90;
    const availableLiquidity = (lvl.totalCost ?? costPerPair) * lvl.quantity;
    const sizing = calculatePositionSize(
      opp.bestNetSpread, costPerPair, activeCapital,
      opp.verdict ?? 'CAUTION', availableLiquidity,
    );
    const qty = Math.max(1, sizing.contracts);

    const dryRunPayload = {
      balances: {
        kalshi: kalshiBalance,
        poly: polyBalance,
        realTotal,
      },
      kelly: {
        netSpread: opp.bestNetSpread,
        kellyFraction: Number(sizing.kellyFraction.toFixed(4)),
        halfKelly:  Number(sizing.halfKelly.toFixed(4)),
        activeCapital: Number(activeCapital.toFixed(2)),
        rawPosition:   Number(sizing.rawPosition.toFixed(2)),
        contracts:     qty,
        totalDeployed: Number(sizing.totalDeployed.toFixed(2)),
        limitingFactor: sizing.limitingFactor,
        verdict: opp.verdict,
      },
      kalshi: {
        endpoint: `POST ${KALSHI_TRADING_BASE}/portfolio/orders`,
        ticker: opp.kalshiMarket.marketId,
        side: kalshiSide,
        count: qty,
        priceInCents: kalshiPriceInCents,
        yes_price: kalshiSide === 'yes' ? kalshiPriceInCents : 100 - kalshiPriceInCents,
        type: 'limit',
        expiration_ts: null,
      },
      poly: {
        endpoint: `POST ${POLY_CLOB_BASE}/order`,
        tokenID: polyTokenId,
        price: polyRawPrice.toFixed(4),
        size: qty.toFixed(2),
        side: 'BUY',
        funder: POLY_FUNDER_ADDRESS,
        orderType: 'GTC',
      },
      totalDeployed: (costPerPair * qty).toFixed(2),
      expectedProfit: Math.round(opp.totalMaxProfit * (qty / lvl.quantity)),
    };
    console.log('[dry-run-payload]', JSON.stringify(dryRunPayload, null, 2));
    if (chatId) {
      await sendMessage(chatId,
        `🧪 <b>DRY RUN — Kelly Sizing</b>\n\n` +
        `<b>${htmlEscape(opp.kalshiMarket.title ?? slug)}</b>\n\n` +
        `<b>KELLY CALC</b>\n` +
        `<code>netSpread:    ${(opp.bestNetSpread * 100).toFixed(2)}%\n` +
        `kellyFraction: ${(sizing.kellyFraction * 100).toFixed(1)}%\n` +
        `halfKelly:  ${(sizing.halfKelly * 100).toFixed(1)}%\n` +
        `activeCapital: $${activeCapital.toFixed(2)}\n` +
        `rawPosition:   $${sizing.rawPosition.toFixed(2)}\n` +
        `finalDeployed: $${(costPerPair * qty).toFixed(2)}\n` +
        `limitingFactor: ${sizing.limitingFactor}\n` +
        `contracts:     ${qty}</code>\n\n` +
        `<b>KALSHI</b> — Buy ${kalshiSide.toUpperCase()}\n` +
        `<code>${qty} contracts @ ${kalshiPriceInCents}¢</code>\n\n` +
        `<b>POLYMARKET</b> — Buy hedge\n` +
        `<code>${qty} contracts @ $${polyRawPrice.toFixed(4)}</code>\n\n` +
        `💰 Total: <b>$${dryRunPayload.totalDeployed}</b>  (was $50 flat cap)`);
    }
    return new Response(JSON.stringify({ ok: true, dryRun: true, payload: dryRunPayload }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      const data: string = cq.data ?? '';
      const chatId = cq.message?.chat?.id;
      const messageId = cq.message?.message_id;
      const originalText: string | undefined = cq.message?.text;
      if (!chatId || !messageId) { await answerCallback(cq.id, 'Invalid callback'); return new Response('ok'); }
      if (data.startsWith('res_buy_')) {
        await handleResolutionBuy(sb, data.slice(8), chatId, messageId, cq.id, dryRun);
      } else if (data.startsWith('res_skip_')) {
        await handleSkip(sb, data.slice(9), chatId, messageId, cq.id, originalText);
      } else if (data.startsWith('buy_')) {
        await handleBuy(sb, data.slice(4), chatId, messageId, cq.id, dryRun);
      } else if (data.startsWith('skip_')) {
        await handleSkip(sb, data.slice(5), chatId, messageId, cq.id, originalText);
      } else {
        await answerCallback(cq.id, 'Unknown action');
      }
    } else if (update.message) {
      await handleMessage(sb, update.message);
    }
  } catch (err) {
    console.error('[trade] handler error', err);
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});
