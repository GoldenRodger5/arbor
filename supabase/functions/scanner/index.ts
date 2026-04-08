// Arbor scanner — Supabase Edge Function (Deno).
// Runs the full scan cycle server-side and writes results to scan_results.
// All API calls (Kalshi, Polymarket, Anthropic) happen here, never in browser.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.102.1';
import Anthropic from 'npm:@anthropic-ai/sdk@0.85.0';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Platform = 'kalshi' | 'polymarket';
type ResolutionVerdict = 'SAFE' | 'CAUTION' | 'SKIP' | 'PENDING';

interface UnifiedMarket {
  platform: Platform;
  marketId: string;
  title: string;
  yesTokenId?: string;
  noTokenId?: string;
  closeTime?: string;
  yesAsk?: number;
  noAsk?: number;
  resolutionCriteria?: string;
  url?: string;
}

interface OrderbookLevel {
  price: number;
  size: number;
}

interface Orderbook {
  marketId: string;
  yesAsks: OrderbookLevel[];
  noAsks: OrderbookLevel[];
  yesBids: OrderbookLevel[];
  noBids: OrderbookLevel[];
  fetchedAt: number;
}

interface ArbitrageLevel {
  buyYesPlatform: Platform;
  buyYesPrice: number;
  buyNoPlatform: Platform;
  buyNoPrice: number;
  quantity: number;
  totalCost: number;
  grossProfitPct: number;
  estimatedFees: number;
  netProfitPct: number;
  maxProfitDollars: number;
}

interface ArbitrageOpportunity {
  id: string;
  kalshiMarket: UnifiedMarket;
  polyMarket: UnifiedMarket;
  matchScore: number;
  verdict: ResolutionVerdict;
  verdictReasoning?: string;
  riskFactors?: string[];
  levels: ArbitrageLevel[];
  bestNetSpread: number;
  totalMaxProfit: number;
  scannedAt: number;
  // Capital-efficiency fields (added 2026-04 for date/annualized filtering).
  daysToClose: number;
  annualizedReturn: number;
  effectiveCloseDate: string;
  kalshiCloseDate: string;
  polyCloseDate: string;
}

interface CandidatePair {
  kalshi: UnifiedMarket;
  poly: UnifiedMarket;
  score: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_GAMMA = 'https://gamma-api.polymarket.com';
const POLY_CLOB = 'https://clob.polymarket.com';

const FUZZY_THRESHOLD = 0.40;
const STALENESS_THRESHOLD_MS = 120_000;
// TEMP: diagnostic, raise to 0.02 once spread distribution is understood.
const MIN_NET_SPREAD = 0.005;
// Threshold passed into the orderbook walk so we collect all profitable +
// unprofitable levels for diagnostics. The display threshold above flags
// pairs with `belowThreshold = true` instead of dropping them.
const DIAGNOSTIC_WALK_THRESHOLD = -1.0;
// Capital efficiency: only scan markets that settle inside this window.
// Markets closing in < 24h are too risky (resolution timing); markets > 90d
// out tie up capital for negligible annualized return.
const MIN_DAYS_TO_CLOSE = 1;
const MAX_DAYS_TO_CLOSE = 365;
// 15% annualized minimum to be flagged as actionable. A 1% spread closing in
// 3 days (~121% annualized) ranks above a 5% spread closing in 200 days (~9%).
const MIN_ANNUALIZED_RETURN = 0.15;
const REQUEST_DELAY_MS = 50; // gentle pacing between orderbook calls
const KALSHI_PAGE_DELAY_MS = 250; // Kalshi rate limit ~5 req/s
const MAX_PAIRS_TO_RESOLVE = 250; // soft cap; cache covers steady state
const MAX_ORDERBOOKS_TO_FETCH = 250;
const CLAUDE_CONCURRENCY = 6;
const ORDERBOOK_CONCURRENCY = 4;
const TOP_SPREADS_STORED = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

function parseCloseTimeMs(s?: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function daysFromNow(ms: number, now = Date.now()): number {
  return (ms - now) / MS_PER_DAY;
}

/**
 * Effective settlement is the EARLIER of the two close dates — that's when
 * the pair's first leg actually pays out.
 */
function effectiveCloseMs(pair: CandidatePair): number | null {
  const k = parseCloseTimeMs(pair.kalshi.closeTime);
  const p = parseCloseTimeMs(pair.poly.closeTime);
  if (k === null && p === null) return null;
  if (k === null) return p;
  if (p === null) return k;
  return Math.min(k, p);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mapPool<T, R>(
  items: T[],
  poolSize: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workerCount = Math.max(1, Math.min(poolSize, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi: RSA-PSS signing via globalThis.crypto.subtle (PKCS#8 PEM)
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
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

let cachedKey: CryptoKey | null = null;

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const keyBuffer = pemToArrayBuffer(privateKeyPem);
  const key = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKey = key;
  return key;
}

async function signRequest(
  privateKeyPem: string,
  method: string,
  path: string,
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = String(Date.now());
  const message = `${timestamp}${method}${path}`;
  const key = await importPrivateKey(privateKeyPem);
  // Match Python reference: padding.PSS.MAX_LENGTH for 2048-bit RSA + SHA-256
  // → emLen(256) - hLen(32) - 2 = 222.
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 222 },
    key,
    new TextEncoder().encode(message),
  );
  return { timestamp, signature: bufferToBase64(sig) };
}

async function kalshiAuthHeaders(
  method: string,
  path: string,
): Promise<Record<string, string>> {
  const apiKeyId = Deno.env.get('KALSHI_API_KEY_ID') ?? '';
  const privateKey = Deno.env.get('KALSHI_PRIVATE_KEY') ?? '';
  if (!apiKeyId || !privateKey) return {};
  const { timestamp, signature } = await signRequest(privateKey, method, path);
  return {
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Content-Type': 'application/json',
  };
}

interface KalshiMarketRaw {
  ticker: string;
  event_ticker?: string;
  title?: string;
  yes_sub_title?: string;
  close_time?: string;
  yes_ask?: number;
  no_ask?: number;
  mve_collection_ticker?: string;
}

interface KalshiEventRaw {
  event_ticker?: string;
  series_ticker?: string;
  category?: string;
  title?: string;
  markets?: KalshiMarketRaw[];
}

// Categories on /events that overlap with Polymarket inventory.
const KALSHI_CATEGORIES = new Set([
  'Politics',
  'Economics',
  'Finance',
  'Crypto',
  'Climate',
  'Science',
  'Awards',
  'Culture',
]);

// Series tickers known to contain political/macro/crypto markets — used as a
// fallback when /events filtering doesn't yield enough markets.
const HIGH_OVERLAP_SERIES = [
  'KXFED', // Fed rate decisions
  'KXINFL', // Inflation
  'KXGDP', // GDP
  'KXPRES', // Presidential
  'KXSENATE', // Senate
  'KXHOUSE', // House
  'KXBTC', // Bitcoin price
  'KXETH', // Ethereum
  'KXNASDAQ', // Nasdaq
  'KXSP', // S&P 500
  'KXOIL', // Oil price
  'KXGOLD', // Gold
  'KXUNEMPLOY', // Unemployment
];

function deriveSeriesTicker(eventTicker: string): string {
  const match = eventTicker.match(/-\d/);
  if (match && match.index !== undefined) return eventTicker.slice(0, match.index);
  return eventTicker;
}

function buildKalshiUrl(raw: KalshiMarketRaw): string {
  const eventTicker = raw.event_ticker || raw.ticker || '';
  const series = deriveSeriesTicker(eventTicker);
  return `https://kalshi.com/markets/${series.toLowerCase()}`;
}

async function kalshiFetchEventsPage(
  cursor: string | null,
): Promise<{ events: KalshiEventRaw[]; cursor: string | null }> {
  const params = new URLSearchParams({
    limit: '200',
    status: 'open',
    with_nested_markets: 'true',
  });
  if (cursor) params.set('cursor', cursor);
  const signPath = '/events';
  let attempt = 0;
  while (true) {
    const headers = await kalshiAuthHeaders('GET', signPath);
    const response = await fetch(
      `${KALSHI_BASE}${signPath}?${params.toString()}`,
      { headers },
    );
    if (response.ok) {
      const data = await response.json();
      return { events: data.events ?? [], cursor: data.cursor || null };
    }
    if (response.status === 429 && attempt < 2) {
      attempt++;
      await sleep(1000 * attempt);
      continue;
    }
    throw new Error(
      `Kalshi /events failed: ${response.status} ${response.statusText}`,
    );
  }
}

async function kalshiFetchSeriesMarkets(
  seriesTicker: string,
): Promise<KalshiMarketRaw[]> {
  const params = new URLSearchParams({
    series_ticker: seriesTicker,
    status: 'open',
    limit: '100',
  });
  const signPath = '/markets';
  let attempt = 0;
  while (true) {
    const headers = await kalshiAuthHeaders('GET', signPath);
    const response = await fetch(
      `${KALSHI_BASE}${signPath}?${params.toString()}`,
      { headers },
    );
    if (response.ok) {
      const data = await response.json();
      return (data.markets ?? []) as KalshiMarketRaw[];
    }
    if (response.status === 429 && attempt < 2) {
      attempt++;
      await sleep(1000 * attempt);
      continue;
    }
    return [];
  }
}

function pushKalshiMarket(
  list: UnifiedMarket[],
  seen: Set<string>,
  m: KalshiMarketRaw,
): void {
  if (!m.ticker) return;
  if (m.mve_collection_ticker) return;
  if (seen.has(m.ticker)) return;
  seen.add(m.ticker);
  const yesAsk = typeof m.yes_ask === 'number' ? m.yes_ask / 100 : undefined;
  const noAsk = typeof m.no_ask === 'number' ? m.no_ask / 100 : undefined;
  list.push({
    platform: 'kalshi',
    marketId: m.ticker,
    title: m.title ?? '',
    closeTime: m.close_time,
    yesAsk,
    noAsk,
    url: buildKalshiUrl(m),
  });
}

async function kalshiGetMarkets(): Promise<UnifiedMarket[]> {
  const markets: UnifiedMarket[] = [];
  const seen = new Set<string>();
  const categoriesSeen = new Set<string>();

  // Approach A: /events with category filter (politics/economics/etc.).
  const MAX_EVENT_PAGES = 8;
  let cursor: string | null = null;
  let pagesFetched = 0;
  while (pagesFetched < MAX_EVENT_PAGES) {
    let page: { events: KalshiEventRaw[]; cursor: string | null };
    try {
      page = await kalshiFetchEventsPage(cursor);
    } catch (err) {
      console.error('[scanner] kalshi /events fetch failed', err);
      break;
    }
    pagesFetched++;
    for (const ev of page.events) {
      if (ev.category) categoriesSeen.add(ev.category);
      if (!ev.category || !KALSHI_CATEGORIES.has(ev.category)) continue;
      for (const m of ev.markets ?? []) pushKalshiMarket(markets, seen, m);
    }
    cursor = page.cursor;
    if (!cursor) break;
    await sleep(KALSHI_PAGE_DELAY_MS);
  }
  console.log(
    `[scanner] kalshi /events: ${markets.length} markets after category filter; categories=${
      JSON.stringify([...categoriesSeen])
    }`,
  );

  // Approach B: series ticker allowlist fallback if /events was too sparse.
  if (markets.length < 20) {
    console.log(
      '[scanner] kalshi /events < 20 markets — applying series ticker allowlist',
    );
    for (const series of HIGH_OVERLAP_SERIES) {
      try {
        const seriesMarkets = await kalshiFetchSeriesMarkets(series);
        const before = markets.length;
        for (const m of seriesMarkets) pushKalshiMarket(markets, seen, m);
        console.log(
          `[scanner] kalshi series ${series}: +${markets.length - before} markets (raw ${seriesMarkets.length})`,
        );
      } catch (err) {
        console.error(`[scanner] kalshi series ${series} fetch failed`, err);
      }
      await sleep(KALSHI_PAGE_DELAY_MS);
    }
  }

  return markets;
}

// Kalshi serves two orderbook shapes:
//   legacy: { orderbook: { yes: [[cents, size], ...], no: [...] } }   (integer cents)
//   new:    { orderbook_fp: { yes_dollars: [["0.6000","100.00"], ...], no_dollars: [...] } }
// Both represent BIDS (orders to buy YES or NO at price p). The asks are
// derived from the opposite side: YES ask = 1 - top NO bid.
type RawLevel = [number | string, number | string];
interface KalshiOrderbookResponse {
  orderbook?: { yes?: RawLevel[] | null; no?: RawLevel[] | null };
  orderbook_fp?: {
    yes_dollars?: RawLevel[] | null;
    no_dollars?: RawLevel[] | null;
  };
}

// Diagnostic capture: first few raw orderbook responses are stashed here so
// we can surface them in the diag HTTP body (logs are not accessible).
const _kalshiRawSamples: Array<{
  ticker: string;
  status: number;
  bodyKeys: string[];
  obKeys: string[];
  yesLen: number | null;
  noLen: number | null;
  sample: string;
}> = [];

async function kalshiGetOrderbook(ticker: string, depth = 10): Promise<Orderbook> {
  const signPath = `/markets/${ticker}/orderbook`;
  const headers = await kalshiAuthHeaders('GET', signPath);
  const response = await fetch(`${KALSHI_BASE}${signPath}?depth=${depth}`, { headers });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    if (_kalshiRawSamples.length < 5) {
      _kalshiRawSamples.push({
        ticker,
        status: response.status,
        bodyKeys: [],
        obKeys: [],
        yesLen: null,
        noLen: null,
        sample: bodyText.slice(0, 400),
      });
    }
    throw new Error(
      `Kalshi getOrderbook failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as KalshiOrderbookResponse;

  // Prefer the new dollar-string shape, fall back to legacy cents shape.
  let yesRaw: RawLevel[] = [];
  let noRaw: RawLevel[] = [];
  let priceDivisor = 1; // dollar shape: prices already in dollars
  if (data.orderbook_fp) {
    yesRaw = data.orderbook_fp.yes_dollars ?? [];
    noRaw = data.orderbook_fp.no_dollars ?? [];
  } else if (data.orderbook) {
    yesRaw = data.orderbook.yes ?? [];
    noRaw = data.orderbook.no ?? [];
    priceDivisor = 100; // legacy cents
  }

  // Stash first 5 raw responses so we can inspect shape via diag.
  if (_kalshiRawSamples.length < 5) {
    _kalshiRawSamples.push({
      ticker,
      status: response.status,
      bodyKeys: Object.keys(data),
      obKeys: data.orderbook_fp
        ? Object.keys(data.orderbook_fp)
        : data.orderbook
          ? Object.keys(data.orderbook)
          : [],
      yesLen: yesRaw.length,
      noLen: noRaw.length,
      sample: JSON.stringify(data).slice(0, 600),
    });
  }

  const yesBids: OrderbookLevel[] = [];
  const noBids: OrderbookLevel[] = [];
  for (const lvl of yesRaw) {
    if (Array.isArray(lvl) && lvl.length >= 2) {
      const price =
        (typeof lvl[0] === 'string' ? parseFloat(lvl[0]) : lvl[0]) / priceDivisor;
      const size = typeof lvl[1] === 'string' ? parseFloat(lvl[1]) : lvl[1];
      if (Number.isFinite(price) && Number.isFinite(size)) {
        yesBids.push({ price, size });
      }
    }
  }
  for (const lvl of noRaw) {
    if (Array.isArray(lvl) && lvl.length >= 2) {
      const price =
        (typeof lvl[0] === 'string' ? parseFloat(lvl[0]) : lvl[0]) / priceDivisor;
      const size = typeof lvl[1] === 'string' ? parseFloat(lvl[1]) : lvl[1];
      if (Number.isFinite(price) && Number.isFinite(size)) {
        noBids.push({ price, size });
      }
    }
  }
  // Derive asks from opposite-side bids: YES ask = 1 - NO bid
  const yesAsks: OrderbookLevel[] = noBids.map((b) => ({ price: 1 - b.price, size: b.size }));
  const noAsks: OrderbookLevel[] = yesBids.map((b) => ({ price: 1 - b.price, size: b.size }));

  yesBids.sort((a, b) => b.price - a.price);
  noBids.sort((a, b) => b.price - a.price);
  yesAsks.sort((a, b) => a.price - b.price);
  noAsks.sort((a, b) => a.price - b.price);

  return { marketId: ticker, yesBids, yesAsks, noBids, noAsks, fetchedAt: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket
// ─────────────────────────────────────────────────────────────────────────────

interface PolyMarketRaw {
  conditionId?: string;
  question?: string;
  endDate?: string;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  clobTokenIds?: string | string[];
  slug?: string;
  events?: Array<{ slug?: string }>;
}

function buildPolyUrl(raw: PolyMarketRaw): string | undefined {
  const eventSlug = raw.events?.[0]?.slug;
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
  if (raw.slug) return `https://polymarket.com/event/${raw.slug}`;
  return undefined;
}

// Polymarket tag slugs that overlap with Kalshi inventory.
const POLY_TAG_SLUGS = ['politics', 'crypto', 'economics', 'finance', 'science'];

interface PolyEventRaw {
  slug?: string;
  markets?: PolyMarketRaw[];
}

function polyMarketToUnified(
  m: PolyMarketRaw,
  eventSlug: string | undefined,
): UnifiedMarket | null {
  if (!m.enableOrderBook || !m.acceptingOrders) return null;
  const conditionId = m.conditionId ?? '';
  if (!conditionId) return null;
  let tokenIds: string[] = [];
  try {
    const raw = m.clobTokenIds ?? '[]';
    if (typeof raw === 'string') tokenIds = JSON.parse(raw);
    else if (Array.isArray(raw)) tokenIds = raw;
  } catch {
    return null;
  }
  if (tokenIds.length < 2) return null;
  return {
    platform: 'polymarket',
    marketId: conditionId,
    title: m.question ?? '',
    yesTokenId: tokenIds[0],
    noTokenId: tokenIds[1],
    closeTime: m.endDate,
    url: eventSlug
      ? `https://polymarket.com/event/${eventSlug}`
      : buildPolyUrl(m),
  };
}

async function polyFetchEventsByTag(slug: string): Promise<UnifiedMarket[]> {
  const out: UnifiedMarket[] = [];
  const limit = 100;
  let offset = 0;
  const MAX_PAGES = 4;
  let pages = 0;
  while (pages < MAX_PAGES) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      active: 'true',
      closed: 'false',
      tag_slug: slug,
    });
    let response: Response;
    try {
      response = await fetch(`${POLY_GAMMA}/events?${params.toString()}`);
    } catch (err) {
      console.error(`[scanner] poly /events ${slug} fetch error`, err);
      break;
    }
    if (!response.ok) {
      console.error(
        `[scanner] poly /events ${slug} non-200: ${response.status}`,
      );
      break;
    }
    const data = (await response.json()) as PolyEventRaw[];
    if (!data || data.length === 0) break;
    for (const ev of data) {
      for (const m of ev.markets ?? []) {
        const u = polyMarketToUnified(m, ev.slug);
        if (u) out.push(u);
      }
    }
    pages++;
    offset += limit;
    if (data.length < limit) break;
    await sleep(REQUEST_DELAY_MS);
  }
  return out;
}

async function polyGetMarkets(): Promise<UnifiedMarket[]> {
  const tagResults = await Promise.all(
    POLY_TAG_SLUGS.map((slug) =>
      polyFetchEventsByTag(slug).catch((err) => {
        console.error(`[scanner] poly tag ${slug} failed`, err);
        return [] as UnifiedMarket[];
      }),
    ),
  );
  const seen = new Set<string>();
  const markets: UnifiedMarket[] = [];
  for (let i = 0; i < tagResults.length; i++) {
    const before = markets.length;
    for (const m of tagResults[i]) {
      if (seen.has(m.marketId)) continue;
      seen.add(m.marketId);
      markets.push(m);
    }
    console.log(
      `[scanner] poly tag ${POLY_TAG_SLUGS[i]}: +${markets.length - before} markets (raw ${tagResults[i].length})`,
    );
  }
  return markets;
}

interface PolyOrderbookRaw {
  bids?: Array<{ price: string | number; size: string | number }>;
  asks?: Array<{ price: string | number; size: string | number }>;
}

function parseLevels(
  levels: Array<{ price: string | number; size: string | number }> | undefined,
): OrderbookLevel[] {
  const out: OrderbookLevel[] = [];
  for (const lvl of levels ?? []) {
    const price = typeof lvl.price === 'string' ? parseFloat(lvl.price) : lvl.price;
    const size = typeof lvl.size === 'string' ? parseFloat(lvl.size) : lvl.size;
    if (Number.isFinite(price) && Number.isFinite(size)) out.push({ price, size });
  }
  return out;
}

async function polyFetchBook(tokenId: string): Promise<PolyOrderbookRaw> {
  try {
    const response = await fetch(
      `${POLY_CLOB}/book?token_id=${encodeURIComponent(tokenId)}`,
    );
    if (!response.ok) return {};
    return (await response.json()) as PolyOrderbookRaw;
  } catch {
    return {};
  }
}

async function polyGetOrderbook(
  yesTokenId: string,
  noTokenId: string,
  marketId = '',
): Promise<Orderbook> {
  const [yesBook, noBook] = await Promise.all([
    polyFetchBook(yesTokenId),
    polyFetchBook(noTokenId),
  ]);
  const yesBids = parseLevels(yesBook.bids);
  const yesAsks = parseLevels(yesBook.asks);
  const noBids = parseLevels(noBook.bids);
  const noAsks = parseLevels(noBook.asks);
  yesBids.sort((a, b) => b.price - a.price);
  noBids.sort((a, b) => b.price - a.price);
  yesAsks.sort((a, b) => a.price - b.price);
  noAsks.sort((a, b) => a.price - b.price);
  return { marketId, yesBids, yesAsks, noBids, noAsks, fetchedAt: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calculator
// ─────────────────────────────────────────────────────────────────────────────

// Kalshi taker fee, verified Apr 2026. Parabolic, rounded up to nearest cent.
// Source: help.kalshi.com/trading/fees and the Feb 2026 fee schedule PDF.
// Maker rate is 0.0175 but arb fills cross the book, so taker is the right rate.
function kalshiFee(contracts: number, price: number): number {
  return Math.ceil(0.07 * contracts * price * (1 - price) * 100) / 100;
}

// Polymarket taker fee, introduced March 2026 (was 0 prior to that — our
// previous polyFee = 0 was correct then but is now wrong for new markets).
// Source: docs.polymarket.com/trading/fees. Fee shape is identical to
// Kalshi: feeRate × contracts × price × (1 - price), no cent rounding.
// Per-category coefficients (taker):
//   crypto 0.072, economics/culture/weather/other 0.05,
//   politics/finance/tech/mentions 0.04, sports 0.03, geopolitics 0.
// We don't pass category through the calculator yet, so default to the
// MAX observed coefficient (0.072) — conservative on purpose: it never
// understates fees, the worst it does is hide marginal opportunities.
const POLY_FEE_COEFFICIENT = 0.072;
function polyFee(contracts: number, price: number): number {
  return POLY_FEE_COEFFICIENT * contracts * price * (1 - price);
}

function feeForLeg(platform: Platform, contracts: number, price: number): number {
  return platform === 'kalshi'
    ? kalshiFee(contracts, price)
    : polyFee(contracts, price);
}

function walkOrderbook(
  yesAsks: OrderbookLevel[],
  noAsks: OrderbookLevel[],
  yesPlatform: Platform,
  noPlatform: Platform,
  minThreshold: number,
): ArbitrageLevel[] {
  const levels: ArbitrageLevel[] = [];
  const yesRemaining = yesAsks.map((l) => ({ price: l.price, size: l.size }));
  const noRemaining = noAsks.map((l) => ({ price: l.price, size: l.size }));
  let yi = 0;
  let ni = 0;
  while (yi < yesRemaining.length && ni < noRemaining.length) {
    const y = yesRemaining[yi];
    const n = noRemaining[ni];
    const totalCost = y.price + n.price;
    const grossProfitPct = 1.0 - totalCost;
    if (grossProfitPct < minThreshold) break;
    const qty = Math.min(y.size, n.size);
    if (qty > 0) {
      const yesFee = feeForLeg(yesPlatform, qty, y.price);
      const noFee = feeForLeg(noPlatform, qty, n.price);
      const totalFees = yesFee + noFee;
      const feePct = qty > 0 ? totalFees / qty : 0;
      const netProfitPct = grossProfitPct - feePct;
      levels.push({
        buyYesPlatform: yesPlatform,
        buyYesPrice: y.price,
        buyNoPlatform: noPlatform,
        buyNoPrice: n.price,
        quantity: qty,
        totalCost,
        grossProfitPct,
        estimatedFees: totalFees,
        netProfitPct,
        maxProfitDollars: qty * netProfitPct,
      });
      y.size -= qty;
      n.size -= qty;
    }
    if (yesRemaining[yi].size <= 0) yi++;
    if (noRemaining[ni].size <= 0) ni++;
  }
  return levels;
}

function calculateOpportunity(
  kalshiBook: Orderbook,
  polyBook: Orderbook,
  minThreshold: number,
): ArbitrageLevel[] {
  const a = walkOrderbook(kalshiBook.yesAsks, polyBook.noAsks, 'kalshi', 'polymarket', minThreshold);
  const b = walkOrderbook(polyBook.yesAsks, kalshiBook.noAsks, 'polymarket', 'kalshi', minThreshold);
  const all = [...a, ...b];
  all.sort((x, y) => y.netProfitPct - x.netProfitPct);
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy matcher
// ─────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'will', 'the', 'a', 'an', 'by', 'in', 'at', 'on', 'for', 'to',
  'of', 'and', 'or', 'is', 'be', 'above', 'below', 'end', 'year',
  'month', 'this',
]);

const STEMS: Record<string, string> = {
  cuts: 'cut',
  cutting: 'cut',
  rates: 'rate',
  rated: 'rate',
  raises: 'raise',
  raised: 'raise',
  wins: 'win',
  winner: 'win',
  loses: 'lose',
  loss: 'lose',
  federal: 'fed',
  reserve: 'fed',
  bitcoin: 'btc',
  ethereum: 'eth',
  exceeds: 'above',
  surpasses: 'above',
  falls: 'below',
  drops: 'below',
  president: 'pres',
  presidential: 'pres',
};

interface TokenizedTitle {
  tokens: Set<string>;
  numbers: Set<string>;
}

function tokenize(title: string): TokenizedTitle {
  const tokens = new Set<string>();
  const numbers = new Set<string>();
  const cleaned = title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return { tokens, numbers };
  for (const raw of cleaned.split(' ')) {
    if (!raw) continue;
    if (/^\d+(\.\d+)?$/.test(raw)) {
      numbers.add(raw);
      continue;
    }
    if (STOPWORDS.has(raw)) continue;
    if (raw.length < 2) continue;
    tokens.add(STEMS[raw] ?? raw);
  }
  return { tokens, numbers };
}

interface FuzzyMatchResult {
  pairs: CandidatePair[];
  topPairs: Array<{ score: number; kalshi: string; poly: string }>;
}

function findCandidatePairs(
  kalshiMarkets: UnifiedMarket[],
  polyMarkets: UnifiedMarket[],
): FuzzyMatchResult {
  if (kalshiMarkets.length === 0 || polyMarkets.length === 0) {
    return { pairs: [], topPairs: [] };
  }

  const kalshiTok = kalshiMarkets.map((m) => tokenize(m.title));
  const polyTok = polyMarkets.map((m) => tokenize(m.title));
  const polySizes = new Int32Array(polyMarkets.length);
  for (let j = 0; j < polyMarkets.length; j++) {
    polySizes[j] = polyTok[j].tokens.size;
  }

  // Inverted index: meaningful token → poly market indices that contain it.
  const polyIndex = new Map<string, number[]>();
  for (let j = 0; j < polyMarkets.length; j++) {
    for (const t of polyTok[j].tokens) {
      let arr = polyIndex.get(t);
      if (!arr) {
        arr = [];
        polyIndex.set(t, arr);
      }
      arr.push(j);
    }
  }

  const bestForKalshi: Array<{ polyIdx: number; score: number }> = new Array(
    kalshiMarkets.length,
  );
  const overlap = new Int32Array(polyMarkets.length);
  const touched: number[] = [];

  for (let i = 0; i < kalshiMarkets.length; i++) {
    const kt = kalshiTok[i];
    if (kt.tokens.size === 0) {
      bestForKalshi[i] = { polyIdx: -1, score: -1 };
      continue;
    }

    for (const t of kt.tokens) {
      const postings = polyIndex.get(t);
      if (!postings) continue;
      for (let p = 0; p < postings.length; p++) {
        const j = postings[p];
        if (overlap[j] === 0) touched.push(j);
        overlap[j]++;
      }
    }

    let bestScore = -1;
    let bestIdx = -1;
    const ktSize = kt.tokens.size;
    for (let k = 0; k < touched.length; k++) {
      const j = touched[k];
      const inter = overlap[j];
      const maxLen = Math.max(ktSize, polySizes[j]);
      if (maxLen <= 0) continue;
      // Weighted match: inter / max(|A|,|B|) is more lenient than Jaccard.
      let score = inter / maxLen;
      // Bonus +0.1 if both titles share a numeric token (year, %, level).
      if (kt.numbers.size > 0 && polyTok[j].numbers.size > 0) {
        for (const n of kt.numbers) {
          if (polyTok[j].numbers.has(n)) {
            score += 0.1;
            break;
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    bestForKalshi[i] = { polyIdx: bestIdx, score: bestScore };

    for (let k = 0; k < touched.length; k++) overlap[touched[k]] = 0;
    touched.length = 0;
  }

  const order = bestForKalshi
    .map((b, i) => ({ kalshiIdx: i, ...b }))
    .sort((a, b) => b.score - a.score);

  // Diagnostic: log the top 10 pairs regardless of threshold.
  const topPairs = order.slice(0, 10).map((entry) => ({
    score: Number(entry.score.toFixed(3)),
    kalshi:
      entry.kalshiIdx >= 0 && entry.kalshiIdx < kalshiMarkets.length
        ? kalshiMarkets[entry.kalshiIdx].title
        : '',
    poly:
      entry.polyIdx >= 0 && entry.polyIdx < polyMarkets.length
        ? polyMarkets[entry.polyIdx].title
        : '',
  }));
  console.log('[scanner] top fuzzy pairs:', JSON.stringify(topPairs));

  const claimed = new Set<number>();
  const results: CandidatePair[] = [];
  for (const entry of order) {
    if (entry.score < FUZZY_THRESHOLD) continue;
    if (entry.polyIdx < 0) continue;
    if (claimed.has(entry.polyIdx)) continue;
    claimed.add(entry.polyIdx);
    results.push({
      kalshi: kalshiMarkets[entry.kalshiIdx],
      poly: polyMarkets[entry.polyIdx],
      score: entry.score,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return { pairs: results, topPairs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude resolver
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a prediction market analyst specializing in resolution criteria. ' +
  'Compare two markets from different platforms and determine if they will ' +
  'definitionally resolve to the same outcome. Be conservative — if there is ' +
  'any meaningful difference in resolution conditions, flag it. Respond only ' +
  'with valid JSON, no markdown backticks.';

function isVerdict(value: unknown): value is ResolutionVerdict {
  return value === 'SAFE' || value === 'CAUTION' || value === 'SKIP';
}

interface VerifyResult {
  verdict: ResolutionVerdict;
  reasoning: string;
  riskFactors: string[];
}

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  if (anthropicClient) return anthropicClient;
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (!apiKey) return null;
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

async function verifyPair(
  kalshi: UnifiedMarket,
  poly: UnifiedMarket,
): Promise<VerifyResult> {
  const client = getAnthropic();
  if (!client) {
    return { verdict: 'PENDING', reasoning: 'No API key configured', riskFactors: [] };
  }

  const userMessage =
    'Compare these prediction markets:\n\n' +
    'KALSHI:\n' +
    `Title: ${kalshi.title}\n` +
    `Resolution criteria: ${kalshi.resolutionCriteria ?? 'Not explicitly stated'}\n\n` +
    'POLYMARKET:\n' +
    `Title: ${poly.title}\n` +
    `Resolution criteria: ${poly.resolutionCriteria ?? 'Not explicitly stated'}\n\n` +
    'Return JSON only:\n' +
    '{\n' +
    '  "verdict": "SAFE" | "CAUTION" | "SKIP",\n' +
    '  "reasoning": "one sentence",\n' +
    '  "risk_factors": ["difference 1", "difference 2"]\n' +
    '}\n\n' +
    'SAFE = identical resolution, guaranteed same outcome\n' +
    'CAUTION = similar but subtle differences exist\n' +
    'SKIP = different resolution conditions, do not trade';

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = response.content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { type: string; text: string }) => b.text)
      .join('')
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { verdict: 'CAUTION', reasoning: 'Failed to parse Claude response', riskFactors: [] };
    }
    const obj = parsed as { verdict?: unknown; reasoning?: unknown; risk_factors?: unknown };
    const verdict: ResolutionVerdict = isVerdict(obj.verdict) ? obj.verdict : 'CAUTION';
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
    const riskFactors = Array.isArray(obj.risk_factors)
      ? obj.risk_factors.filter((r): r is string => typeof r === 'string')
      : [];
    return { verdict, reasoning, riskFactors };
  } catch (err) {
    console.error('[scanner] verifyPair error', err);
    return { verdict: 'CAUTION', reasoning: 'Claude API error', riskFactors: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase helpers (server-side, service-role)
// ─────────────────────────────────────────────────────────────────────────────

interface PreparedPair {
  pair: CandidatePair;
  pairId: string | null;
  verdict: ResolutionVerdict;
  reasoning: string;
  riskFactors: string[];
}

async function getCachedVerdict(
  sb: SupabaseClient,
  kalshiId: string,
  polyId: string,
): Promise<{ id: string; verdict: ResolutionVerdict; reasoning: string } | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('market_pairs')
    .select('id, resolution_verdict, verdict_reasoning, last_verified_at')
    .eq('kalshi_market_id', kalshiId)
    .eq('poly_market_id', polyId)
    .gt('last_verified_at', cutoff)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const verdict = data.resolution_verdict as ResolutionVerdict;
  // PENDING means a prior scan couldn't reach Claude — re-evaluate rather
  // than serve a non-decision from cache.
  if (verdict === 'PENDING') return null;
  return {
    id: data.id as string,
    verdict,
    reasoning: (data.verdict_reasoning as string | null) ?? '',
  };
}

async function upsertMarketPair(
  sb: SupabaseClient,
  pair: CandidatePair,
  verdict: ResolutionVerdict,
  reasoning: string,
  riskFactors: string[],
): Promise<string | null> {
  const row = {
    kalshi_market_id: pair.kalshi.marketId,
    kalshi_title: pair.kalshi.title,
    kalshi_resolution_criteria: pair.kalshi.resolutionCriteria ?? null,
    poly_market_id: pair.poly.marketId,
    poly_title: pair.poly.title,
    poly_resolution_criteria: pair.poly.resolutionCriteria ?? null,
    resolution_verdict: verdict,
    verdict_reasoning: reasoning || null,
    risk_factors: riskFactors.length > 0 ? riskFactors : null,
    match_score: pair.score,
    last_verified_at: new Date().toISOString(),
  };
  const { data, error } = await sb
    .from('market_pairs')
    .upsert(row, { onConflict: 'kalshi_market_id,poly_market_id' })
    .select('id')
    .single();
  if (error) {
    console.error('[scanner] upsertMarketPair failed', error);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

async function logSpread(
  sb: SupabaseClient,
  pairId: string,
  data: {
    polyYesPrice: number;
    polyNoPrice: number;
    kalshiYesPrice: number;
    kalshiNoPrice: number;
    rawSpread: number;
    estimatedFees: number;
    netSpread: number;
    availableQuantity: number;
    maxProfitDollars: number;
  },
): Promise<void> {
  const { error } = await sb.from('spread_logs').insert({
    pair_id: pairId,
    poly_yes_price: data.polyYesPrice,
    poly_no_price: data.polyNoPrice,
    kalshi_yes_price: data.kalshiYesPrice,
    kalshi_no_price: data.kalshiNoPrice,
    raw_spread: data.rawSpread,
    estimated_fees: data.estimatedFees,
    net_spread: data.netSpread,
    available_quantity: data.availableQuantity,
    max_profit_dollars: data.maxProfitDollars,
  });
  if (error) console.error('[scanner] logSpread failed', error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan cycle
// ─────────────────────────────────────────────────────────────────────────────

async function resolvePair(
  sb: SupabaseClient,
  pair: CandidatePair,
  skipClaude: boolean,
): Promise<PreparedPair> {
  const cached = await getCachedVerdict(sb, pair.kalshi.marketId, pair.poly.marketId);
  if (cached) {
    console.log(
      `[resolver] cached ${cached.verdict} | ${pair.kalshi.title} → ${pair.poly.title}`,
    );
    return {
      pair,
      pairId: cached.id,
      verdict: cached.verdict,
      reasoning: cached.reasoning,
      riskFactors: [],
    };
  }
  let verdict: ResolutionVerdict = 'PENDING';
  let reasoning = '';
  let riskFactors: string[] = [];
  if (!skipClaude) {
    try {
      const r = await verifyPair(pair.kalshi, pair.poly);
      verdict = r.verdict;
      reasoning = r.reasoning;
      riskFactors = r.riskFactors;
    } catch (err) {
      console.error('[scanner] verifyPair failed', err);
      verdict = 'CAUTION';
    }
  }
  console.log(
    `[resolver] ${verdict} | ${pair.kalshi.title} → ${pair.poly.title}` +
      (reasoning ? ` | ${reasoning}` : ''),
  );
  const pairId = await upsertMarketPair(sb, pair, verdict, reasoning, riskFactors);
  return { pair, pairId, verdict, reasoning, riskFactors };
}

interface PairSummary {
  kalshiTitle: string;
  polyTitle: string;
  score: number;
  verdict: ResolutionVerdict;
  netSpread: number | null;
  hasOrderbook: boolean;
  kalshiYesAsksLen: number;
  kalshiNoAsksLen: number;
  kalshiYesBidsLen: number;
  kalshiNoBidsLen: number;
  polyYesAsksLen: number;
  polyNoAsksLen: number;
  polyYesBidsLen: number;
  polyNoBidsLen: number;
  bookError: string | null;
  daysToClose: number | null;
  annualizedReturn: number | null;
  effectiveCloseDate: string | null;
  passedDateFilter: boolean;
}

interface VerdictDistribution {
  SAFE: number;
  CAUTION: number;
  SKIP: number;
  PENDING: number;
}

async function runScanCycle(
  sb: SupabaseClient,
  opts: { skipClaude?: boolean } = {},
): Promise<{
  opportunities: ArbitrageOpportunity[];
  kalshiCount: number;
  polyCount: number;
  matchedCount: number;
  matchedCountPreDateFilter: number;
  pairsFilteredByDate: number;
  avgDaysToClose: number;
  dateBuckets: {
    within7days: number;
    within30days: number;
    within90days: number;
    beyond90days: number;
    missing: number;
  };
  clearedSpreadCount: number;
  filteredByAnnReturn: number;
  actionableCount: number;
  topPairs: Array<{ score: number; kalshi: string; poly: string }>;
  matchedPairs: Array<{ score: number; kalshi: string; poly: string }>;
  pairSummaries: PairSummary[];
  verdictDist: VerdictDistribution;
  errors: string[];
}> {
  const errors: string[] = [];
  // 1. Fetch markets in parallel.
  const [kalshiResult, polyResult] = await Promise.allSettled([
    kalshiGetMarkets(),
    polyGetMarkets(),
  ]);
  const kalshiMarkets =
    kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];
  const polyMarkets = polyResult.status === 'fulfilled' ? polyResult.value : [];
  if (kalshiResult.status === 'rejected') {
    const msg = `kalshi.getMarkets: ${
      kalshiResult.reason instanceof Error
        ? kalshiResult.reason.message
        : String(kalshiResult.reason)
    }`;
    console.error(`[scanner] ${msg}`);
    errors.push(msg);
  }
  if (polyResult.status === 'rejected') {
    const msg = `poly.getMarkets: ${
      polyResult.reason instanceof Error
        ? polyResult.reason.message
        : String(polyResult.reason)
    }`;
    console.error(`[scanner] ${msg}`);
    errors.push(msg);
  }
  console.log(
    `[scanner] fetched ${kalshiMarkets.length} kalshi, ${polyMarkets.length} poly markets`,
  );
  console.log(
    '[scanner] kalshi sample:',
    JSON.stringify(kalshiMarkets.slice(0, 5).map((m) => m.title)),
  );
  console.log(
    '[scanner] poly sample:',
    JSON.stringify(polyMarkets.slice(0, 5).map((m) => m.title)),
  );
  console.log(`[scanner] fuzzy threshold: ${FUZZY_THRESHOLD}`);

  // 2. Fuzzy match.
  const matchResult = findCandidatePairs(kalshiMarkets, polyMarkets);
  const allCandidates = matchResult.pairs;
  console.log(`[scanner] ${allCandidates.length} candidate pairs (pre date filter)`);

  // 2.5 Date analysis across ALL matched pairs (before filtering).
  // Buckets are MUTUALLY EXCLUSIVE so the totals add to allCandidates.length.
  const dateBuckets = {
    expired: 0, // d <= 0 (already closed)
    within7days: 0, // 0 < d <= 7
    within30days: 0, // 7 < d <= 30
    within90days: 0, // 30 < d <= 90
    within365days: 0, // 90 < d <= 365
    beyond365days: 0, // d > 365
    missing: 0,
  };
  const closeDaysAll: number[] = [];
  for (const p of allCandidates) {
    const closeMs = effectiveCloseMs(p);
    if (closeMs === null) {
      dateBuckets.missing++;
      continue;
    }
    const d = daysFromNow(closeMs);
    closeDaysAll.push(d);
    if (d <= 0) dateBuckets.expired++;
    else if (d <= 7) dateBuckets.within7days++;
    else if (d <= 30) dateBuckets.within30days++;
    else if (d <= 90) dateBuckets.within90days++;
    else if (d <= 365) dateBuckets.within365days++;
    else dateBuckets.beyond365days++;
  }
  console.log('[date-analysis]', JSON.stringify(dateBuckets));
  const avgDaysToClose =
    closeDaysAll.length > 0
      ? closeDaysAll.reduce((a, b) => a + b, 0) / closeDaysAll.length
      : 0;
  console.log(`[date-analysis] avgDaysToClose=${avgDaysToClose.toFixed(1)}`);

  // 2.6 Hard date filter — drop any pair where EITHER market closes outside
  // the [MIN_DAYS_TO_CLOSE, MAX_DAYS_TO_CLOSE] window.
  const beforeDateFilter = allCandidates.length;
  const candidates = allCandidates.filter((p) => {
    const k = parseCloseTimeMs(p.kalshi.closeTime);
    const pl = parseCloseTimeMs(p.poly.closeTime);
    if (k === null || pl === null) return false;
    const kDays = daysFromNow(k);
    const pDays = daysFromNow(pl);
    if (kDays < MIN_DAYS_TO_CLOSE || kDays > MAX_DAYS_TO_CLOSE) return false;
    if (pDays < MIN_DAYS_TO_CLOSE || pDays > MAX_DAYS_TO_CLOSE) return false;
    return true;
  });
  const pairsFilteredByDate = beforeDateFilter - candidates.length;
  console.log(
    '[date-filter]',
    JSON.stringify({
      before: beforeDateFilter,
      after: candidates.length,
      filteredOut: pairsFilteredByDate,
      reason: `outside ${MIN_DAYS_TO_CLOSE}-${MAX_DAYS_TO_CLOSE} day window`,
    }),
  );

  const matchedPairs = candidates.slice(0, 10).map((p) => ({
    score: Number(p.score.toFixed(3)),
    kalshi: p.kalshi.title,
    poly: p.poly.title,
  }));
  console.log('[scanner] matched pairs (top 10):', JSON.stringify(matchedPairs));

  // 3. Resolve verdicts in parallel (cache check inside resolvePair).
  const toResolve = candidates.slice(0, MAX_PAIRS_TO_RESOLVE);
  const skipClaude = opts.skipClaude ?? false;
  console.log(
    `[scanner] resolving ${toResolve.length} pairs (skipClaude=${skipClaude}, concurrency=${CLAUDE_CONCURRENCY})`,
  );
  const prepared = await mapPool(toResolve, CLAUDE_CONCURRENCY, (p) =>
    resolvePair(sb, p, skipClaude),
  );

  const verdictDist = {
    SAFE: prepared.filter((p) => p.verdict === 'SAFE').length,
    CAUTION: prepared.filter((p) => p.verdict === 'CAUTION').length,
    SKIP: prepared.filter((p) => p.verdict === 'SKIP').length,
    PENDING: prepared.filter((p) => p.verdict === 'PENDING').length,
  };
  console.log(
    `[scanner] verdict distribution: SAFE=${verdictDist.SAFE} CAUTION=${verdictDist.CAUTION} SKIP=${verdictDist.SKIP} PENDING=${verdictDist.PENDING}`,
  );

  const validPairs = prepared
    .filter((p) => p.verdict !== 'SKIP')
    .slice(0, MAX_ORDERBOOKS_TO_FETCH);
  console.log(`[scanner] ${validPairs.length} pairs after SKIP filter`);

  // 4. Fetch orderbooks in parallel pool. Walk every level even if
  //    unprofitable so we capture the spread distribution for diagnostics.
  interface SpreadResult {
    prep: PreparedPair;
    kalshiBook: Orderbook | null;
    polyBook: Orderbook | null;
    levels: ArbitrageLevel[];
    bestNet: number;
    bestGross: number;
    totalMax: number;
    error: string | null;
  }

  console.log(
    `[scanner] fetching ${validPairs.length} orderbook pairs (concurrency=${ORDERBOOK_CONCURRENCY})`,
  );
  const spreadResults = await mapPool<PreparedPair, SpreadResult>(
    validPairs,
    ORDERBOOK_CONCURRENCY,
    async (prep) => {
      const { pair } = prep;
      if (!pair.poly.yesTokenId || !pair.poly.noTokenId) {
        return {
          prep,
          kalshiBook: null,
          polyBook: null,
          levels: [],
          bestNet: -Infinity,
          bestGross: -Infinity,
          totalMax: 0,
          error: 'no token ids',
        };
      }
      let kalshiBook: Orderbook;
      let polyBook: Orderbook;
      try {
        [kalshiBook, polyBook] = await Promise.all([
          kalshiGetOrderbook(pair.kalshi.marketId),
          polyGetOrderbook(
            pair.poly.yesTokenId,
            pair.poly.noTokenId,
            pair.poly.marketId,
          ),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[scanner] orderbook fetch failed for ${pair.kalshi.marketId}: ${msg}`,
        );
        return {
          prep,
          kalshiBook: null,
          polyBook: null,
          levels: [],
          bestNet: -Infinity,
          bestGross: -Infinity,
          totalMax: 0,
          error: msg,
        };
      }
      const levels = calculateOpportunity(
        kalshiBook,
        polyBook,
        DIAGNOSTIC_WALK_THRESHOLD,
      );
      const bestLevel = levels[0];
      const bestNet = bestLevel?.netProfitPct ?? -Infinity;
      const bestGross = bestLevel?.grossProfitPct ?? -Infinity;
      const totalMax = levels.reduce(
        (acc, l) => acc + Math.max(0, l.maxProfitDollars),
        0,
      );
      return {
        prep,
        kalshiBook,
        polyBook,
        levels,
        bestNet,
        bestGross,
        totalMax,
        error: null,
      };
    },
  );

  // 5. Per-pair spread log so we can see the full distribution.
  for (const r of spreadResults) {
    console.log(
      '[spread]',
      JSON.stringify({
        event: r.prep.pair.kalshi.title,
        kalshiYesAsks: r.kalshiBook?.yesAsks.length ?? 0,
        kalshiNoAsks: r.kalshiBook?.noAsks.length ?? 0,
        kalshiYesBids: r.kalshiBook?.yesBids.length ?? 0,
        kalshiNoBids: r.kalshiBook?.noBids.length ?? 0,
        polyYesAsks: r.polyBook?.yesAsks.length ?? 0,
        polyNoAsks: r.polyBook?.noAsks.length ?? 0,
        polyYesBids: r.polyBook?.yesBids.length ?? 0,
        polyNoBids: r.polyBook?.noBids.length ?? 0,
        polyYesAsk: r.polyBook?.yesAsks[0]?.price ?? null,
        polyNoAsk: r.polyBook?.noAsks[0]?.price ?? null,
        kalshiYesAsk: r.kalshiBook?.yesAsks[0]?.price ?? null,
        kalshiNoAsk: r.kalshiBook?.noAsks[0]?.price ?? null,
        grossSpread: Number.isFinite(r.bestGross)
          ? Number(r.bestGross.toFixed(4))
          : null,
        netSpread: Number.isFinite(r.bestNet)
          ? Number(r.bestNet.toFixed(4))
          : null,
        verdict: r.prep.verdict,
        error: r.error,
      }),
    );
  }

  // 6. Build pair summaries for ALL prepared pairs (including SKIP).
  const spreadByPrep = new Map<PreparedPair, SpreadResult>();
  for (const r of spreadResults) spreadByPrep.set(r.prep, r);
  const pairSummaries: PairSummary[] = prepared.map((prep) => {
    const sr = spreadByPrep.get(prep);
    const closeMs = effectiveCloseMs(prep.pair);
    const days = closeMs !== null ? daysFromNow(closeMs) : null;
    const netSpreadVal =
      sr && Number.isFinite(sr.bestNet) ? sr.bestNet : null;
    const annReturn =
      netSpreadVal !== null && days !== null && days > 0
        ? (netSpreadVal / days) * 365
        : null;
    return {
      kalshiTitle: prep.pair.kalshi.title,
      polyTitle: prep.pair.poly.title,
      score: Number(prep.pair.score.toFixed(3)),
      verdict: prep.verdict,
      netSpread: netSpreadVal !== null ? Number(netSpreadVal.toFixed(4)) : null,
      hasOrderbook: !!(sr?.kalshiBook && sr?.polyBook),
      kalshiYesAsksLen: sr?.kalshiBook?.yesAsks.length ?? 0,
      kalshiNoAsksLen: sr?.kalshiBook?.noAsks.length ?? 0,
      kalshiYesBidsLen: sr?.kalshiBook?.yesBids.length ?? 0,
      kalshiNoBidsLen: sr?.kalshiBook?.noBids.length ?? 0,
      polyYesAsksLen: sr?.polyBook?.yesAsks.length ?? 0,
      polyNoAsksLen: sr?.polyBook?.noAsks.length ?? 0,
      polyYesBidsLen: sr?.polyBook?.yesBids.length ?? 0,
      polyNoBidsLen: sr?.polyBook?.noBids.length ?? 0,
      bookError: sr?.error ?? null,
      daysToClose: days !== null ? Number(days.toFixed(2)) : null,
      annualizedReturn: annReturn !== null ? Number(annReturn.toFixed(4)) : null,
      effectiveCloseDate: closeMs !== null ? new Date(closeMs).toISOString() : null,
      passedDateFilter: true, // every prepared pair passed the date filter
    };
  });

  // 7. Decorate spread results with date/annualized fields and sort by
  //    annualized return (capital efficiency) — net spread is now secondary.
  interface ScoredSpread extends SpreadResult {
    closeMs: number | null;
    days: number;
    annReturn: number;
  }
  const scoredSpreads: ScoredSpread[] = spreadResults
    .filter((r) => r.kalshiBook && r.polyBook && Number.isFinite(r.bestNet))
    .map((r) => {
      const closeMs = effectiveCloseMs(r.prep.pair);
      const days = closeMs !== null ? daysFromNow(closeMs) : 0;
      const annReturn = days > 0 ? (r.bestNet / days) * 365 : 0;
      return { ...r, closeMs, days, annReturn };
    });
  scoredSpreads.sort((a, b) => b.annReturn - a.annReturn);
  console.log(
    `[scanner] ${scoredSpreads.length} pairs with usable orderbooks (sorted by annualized return)`,
  );
  if (scoredSpreads.length > 0) {
    const top = scoredSpreads[0];
    console.log(
      `[scanner] best annualized: ${(top.annReturn * 100).toFixed(1)}% (${top.bestNet.toFixed(4)} net over ${top.days.toFixed(1)}d) — ${top.prep.pair.kalshi.title}`,
    );
  }

  const clearedSpread = scoredSpreads.filter((r) => r.bestNet >= MIN_NET_SPREAD);
  const clearedBoth = clearedSpread.filter(
    (r) => r.annReturn >= MIN_ANNUALIZED_RETURN,
  );
  const filteredByAnnReturn = clearedSpread.length - clearedBoth.length;
  console.log(
    `[filter-summary] cleared spread (>=${MIN_NET_SPREAD * 100}%): ${clearedSpread.length}`,
  );
  console.log(
    `[filter-summary] cleared spread but filtered by annReturn (<${MIN_ANNUALIZED_RETURN * 100}% APY): ${filteredByAnnReturn}`,
  );
  console.log(
    `[filter-summary] cleared BOTH (truly actionable): ${clearedBoth.length}`,
  );

  const topSpreads = scoredSpreads.slice(0, TOP_SPREADS_STORED);
  const opportunities: ArbitrageOpportunity[] = topSpreads.map((r) => {
    const kCloseMs = parseCloseTimeMs(r.prep.pair.kalshi.closeTime);
    const pCloseMs = parseCloseTimeMs(r.prep.pair.poly.closeTime);
    const opp: ArbitrageOpportunity & { belowThreshold?: boolean } = {
      id: `${r.prep.pair.kalshi.marketId}:${r.prep.pair.poly.marketId}`,
      kalshiMarket: r.prep.pair.kalshi,
      polyMarket: r.prep.pair.poly,
      matchScore: r.prep.pair.score,
      verdict: r.prep.verdict,
      verdictReasoning: r.prep.reasoning,
      riskFactors: r.prep.riskFactors,
      levels: r.levels,
      bestNetSpread: r.bestNet,
      totalMaxProfit: Math.round(r.totalMax),
      scannedAt: Date.now(),
      daysToClose: Number(r.days.toFixed(2)),
      annualizedReturn: Number(r.annReturn.toFixed(4)),
      effectiveCloseDate: r.closeMs !== null ? new Date(r.closeMs).toISOString() : '',
      kalshiCloseDate: kCloseMs !== null ? new Date(kCloseMs).toISOString() : '',
      polyCloseDate: pCloseMs !== null ? new Date(pCloseMs).toISOString() : '',
      belowThreshold:
        r.bestNet < MIN_NET_SPREAD || r.annReturn < MIN_ANNUALIZED_RETURN,
    };
    return opp;
  });
  // Stash pairSummaries on the first stored opportunity (no schema change).
  // The frontend casts to ArbitrageOpportunity[] and ignores extra fields.
  if (opportunities.length > 0) {
    (opportunities[0] as unknown as { pairSummaries: PairSummary[] }).pairSummaries =
      pairSummaries;
  }

  // 8. Persist spread_logs only for top entries with positive spreads.
  for (const r of topSpreads) {
    if (!r.prep.pairId) continue;
    const best = r.levels[0];
    if (!best) continue;
    const polyYesPrice =
      best.buyYesPlatform === 'polymarket' ? best.buyYesPrice : best.buyNoPrice;
    const polyNoPrice =
      best.buyNoPlatform === 'polymarket' ? best.buyNoPrice : best.buyYesPrice;
    const kalshiYesPrice =
      best.buyYesPlatform === 'kalshi' ? best.buyYesPrice : best.buyNoPrice;
    const kalshiNoPrice =
      best.buyNoPlatform === 'kalshi' ? best.buyNoPrice : best.buyYesPrice;
    try {
      await logSpread(sb, r.prep.pairId, {
        polyYesPrice,
        polyNoPrice,
        kalshiYesPrice,
        kalshiNoPrice,
        rawSpread: best.grossProfitPct,
        estimatedFees: best.estimatedFees,
        netSpread: best.netProfitPct,
        availableQuantity: best.quantity,
        maxProfitDollars: best.maxProfitDollars,
      });
    } catch (err) {
      console.error('[scanner] logSpread failed', err);
    }
  }

  console.log(
    `[scanner] stored ${opportunities.length} opportunities (${clearedBoth.length} actionable, ${opportunities.length - clearedBoth.length} below threshold)`,
  );

  return {
    opportunities,
    kalshiCount: kalshiMarkets.length,
    polyCount: polyMarkets.length,
    matchedCount: candidates.length,
    matchedCountPreDateFilter: beforeDateFilter,
    pairsFilteredByDate,
    avgDaysToClose: Number(avgDaysToClose.toFixed(2)),
    dateBuckets,
    clearedSpreadCount: clearedSpread.length,
    filteredByAnnReturn,
    actionableCount: clearedBoth.length,
    topPairs: matchResult.topPairs,
    matchedPairs,
    pairSummaries,
    verdictDist,
    errors,
  };
}

async function writeScanResult(
  sb: SupabaseClient,
  result: {
    opportunities: ArbitrageOpportunity[];
    kalshiCount: number;
    polyCount: number;
    matchedCount: number;
    avgDaysToClose: number;
    pairsFilteredByDate: number;
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    opportunities: result.opportunities,
    kalshi_count: result.kalshiCount,
    poly_count: result.polyCount,
    matched_count: result.matchedCount,
    opportunity_count: result.opportunities.length,
    avg_days_to_close: result.avgDaysToClose,
    pairs_filtered_by_date: result.pairsFilteredByDate,
  };
  let { error: insertError } = await sb.from('scan_results').insert(row);
  if (insertError && /column .* (does not exist|of relation)/i.test(insertError.message)) {
    // Migration not yet applied — fall back to legacy columns so the scan
    // still persists. Drop the new fields and retry once.
    console.warn(
      '[scanner] scan_results new columns missing, retrying without them:',
      insertError.message,
    );
    delete row.avg_days_to_close;
    delete row.pairs_filtered_by_date;
    ({ error: insertError } = await sb.from('scan_results').insert(row));
  }
  if (insertError) {
    console.error('[scanner] scan_results insert failed', insertError);
    return;
  }
  // Trim to last 10 rows.
  const { data: rows } = await sb
    .from('scan_results')
    .select('id')
    .order('scanned_at', { ascending: false })
    .range(10, 999);
  if (rows && rows.length > 0) {
    const ids = rows.map((r: { id: string }) => r.id);
    const { error: delError } = await sb.from('scan_results').delete().in('id', ids);
    if (delError) console.error('[scanner] scan_results trim failed', delError);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const url = new URL(req.url);
  const skipClaude = url.searchParams.get('skipClaude') === '1';
  const diag = url.searchParams.get('diag') === '1';

  try {
    const startedAt = Date.now();
    _kalshiRawSamples.length = 0;
    const result = await runScanCycle(supabase, { skipClaude });
    await writeScanResult(supabase, result);
    const durationMs = Date.now() - startedAt;
    const body: Record<string, unknown> = {
      ok: true,
      durationMs,
      kalshiCount: result.kalshiCount,
      polyCount: result.polyCount,
      matchedCountPreDateFilter: result.matchedCountPreDateFilter,
      matchedCount: result.matchedCount,
      pairsFilteredByDate: result.pairsFilteredByDate,
      avgDaysToClose: result.avgDaysToClose,
      dateBuckets: result.dateBuckets,
      opportunityCount: result.opportunities.length,
      clearedSpreadCount: result.clearedSpreadCount,
      filteredByAnnReturn: result.filteredByAnnReturn,
      actionableCount: result.actionableCount,
      verdictDist: result.verdictDist,
      errors: result.errors,
    };
    if (diag) {
      body.topPairs = result.topPairs;
      body.matchedPairs = result.matchedPairs;
      body.pairSummaries = result.pairSummaries;
      body.kalshiOrderbookSamples = _kalshiRawSamples;
      body.opportunitiesPreview = result.opportunities.map((o) => ({
        kalshi: o.kalshiMarket.title,
        poly: o.polyMarket.title,
        verdict: o.verdict,
        netSpread: Number((o.bestNetSpread as number).toFixed(4)),
        annualizedReturn: Number((o.annualizedReturn as number).toFixed(4)),
        daysToClose: Number((o.daysToClose as number).toFixed(2)),
        effectiveCloseDate: o.effectiveCloseDate,
        kalshiCloseDate: o.kalshiCloseDate,
        polyCloseDate: o.polyCloseDate,
        belowThreshold: (o as { belowThreshold?: boolean }).belowThreshold,
        levels: o.levels.length,
      }));
    }
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[scanner] cycle failed', e);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
