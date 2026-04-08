// NOTE: This module's logic has been moved to
// supabase/functions/scanner/index.ts
// This file is kept for reference only.
// It is NOT imported by the frontend.

import config from '@/config';
import type { Orderbook, OrderbookLevel, UnifiedMarket } from '@/types';
import { RateLimiter } from './rateLimiter';

const limiter = new RateLimiter(config.kalshi.requestsPerSecond);

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

let cachedKey: CryptoKey | null = null;
let cachedKeyPem: string | null = null;

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  if (cachedKey && cachedKeyPem === privateKeyPem) {
    return cachedKey;
  }
  const keyBuffer = pemToArrayBuffer(privateKeyPem);
  const key = await window.crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKey = key;
  cachedKeyPem = privateKeyPem;
  return key;
}

export async function signRequest(
  privateKeyPem: string,
  method: string,
  path: string,
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = String(Date.now());
  const message = `${timestamp}${method}${path}`;
  const key = await importPrivateKey(privateKeyPem);
  const signatureBuffer = await window.crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 },
    key,
    new TextEncoder().encode(message),
  );
  return { timestamp, signature: bufferToBase64(signatureBuffer) };
}

export async function getAuthHeaders(
  method: string,
  path: string,
): Promise<Record<string, string>> {
  if (!config.kalshi.apiKeyId || !config.kalshi.privateKey) {
    return {};
  }
  const { timestamp, signature } = await signRequest(
    config.kalshi.privateKey,
    method,
    path,
  );
  return {
    'KALSHI-ACCESS-KEY': config.kalshi.apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Content-Type': 'application/json',
  };
}

interface KalshiMarketRaw {
  ticker: string;
  event_ticker?: string;
  title?: string;
  close_time?: string;
  yes_ask?: number;
  no_ask?: number;
}

function deriveSeriesTicker(eventTicker: string): string {
  // Strip "-<digit>..." suffix to get series ticker.
  // e.g. KXFRENCHPRES-27 -> KXFRENCHPRES
  const match = eventTicker.match(/-\d/);
  if (match && match.index !== undefined) {
    return eventTicker.slice(0, match.index);
  }
  return eventTicker;
}

function buildKalshiUrl(raw: KalshiMarketRaw): string {
  const eventTicker = raw.event_ticker || raw.ticker || '';
  const series = deriveSeriesTicker(eventTicker);
  return `https://kalshi.com/markets/${series.toLowerCase()}`;
}

export async function getMarkets(
  status: string = 'open',
  maxMarkets: number = 0,
): Promise<UnifiedMarket[]> {
  const markets: UnifiedMarket[] = [];
  let cursor: string | null = null;
  const path = '/markets';

  while (maxMarkets === 0 || markets.length < maxMarkets) {
    await limiter.acquire();

    const params = new URLSearchParams({ limit: '1000', status });
    if (cursor) params.set('cursor', cursor);

    const headers = await getAuthHeaders('GET', path);
    const response = await fetch(
      `${config.kalshi.baseUrl}${path}?${params.toString()}`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(
        `Kalshi getMarkets failed: ${response.status} ${response.statusText}`,
      );
    }
    const data = await response.json();

    for (const m of (data.markets ?? []) as KalshiMarketRaw[]) {
      // Kalshi prices are in cents (0-100); convert to 0-1 scale.
      const yesAsk =
        typeof m.yes_ask === 'number' ? m.yes_ask / 100 : undefined;
      const noAsk =
        typeof m.no_ask === 'number' ? m.no_ask / 100 : undefined;

      markets.push({
        platform: 'kalshi',
        marketId: m.ticker,
        title: m.title ?? '',
        closeTime: m.close_time,
        yesAsk,
        noAsk,
        url: buildKalshiUrl(m),
      });
    }

    cursor = data.cursor || null;
    if (!cursor) break;
  }

  return markets;
}

interface KalshiOrderbookResponse {
  orderbook?: {
    yes?: Array<[number, number]> | null;
    no?: Array<[number, number]> | null;
  };
}

export async function getOrderbook(
  ticker: string,
  depth: number = 10,
): Promise<Orderbook> {
  await limiter.acquire();

  const path = `/markets/${ticker}/orderbook`;
  const headers = await getAuthHeaders('GET', path);

  const response = await fetch(
    `${config.kalshi.baseUrl}${path}?depth=${depth}`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(
      `Kalshi getOrderbook failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as KalshiOrderbookResponse;
  const ob = data.orderbook ?? {};

  const yesBids: OrderbookLevel[] = [];
  const noBids: OrderbookLevel[] = [];

  for (const level of ob.yes ?? []) {
    if (Array.isArray(level) && level.length >= 2) {
      yesBids.push({ price: level[0] / 100, size: level[1] });
    }
  }
  for (const level of ob.no ?? []) {
    if (Array.isArray(level) && level.length >= 2) {
      noBids.push({ price: level[0] / 100, size: level[1] });
    }
  }

  // Derive asks from opposite bids:
  // YES ask = 1 - NO bid, NO ask = 1 - YES bid
  const yesAsks: OrderbookLevel[] = noBids.map((b) => ({
    price: 1 - b.price,
    size: b.size,
  }));
  const noAsks: OrderbookLevel[] = yesBids.map((b) => ({
    price: 1 - b.price,
    size: b.size,
  }));

  // Bids descending, asks ascending
  yesBids.sort((a, b) => b.price - a.price);
  noBids.sort((a, b) => b.price - a.price);
  yesAsks.sort((a, b) => a.price - b.price);
  noAsks.sort((a, b) => a.price - b.price);

  return {
    marketId: ticker,
    yesBids,
    yesAsks,
    noBids,
    noAsks,
    fetchedAt: Date.now(),
  };
}
