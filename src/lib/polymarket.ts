// NOTE: This module's logic has been moved to
// supabase/functions/scanner/index.ts
// This file is kept for reference only.
// It is NOT imported by the frontend.

import config from '@/config';
import type { Orderbook, OrderbookLevel, UnifiedMarket } from '@/types';
import { RateLimiter } from './rateLimiter';

const limiter = new RateLimiter(config.polymarket.requestsPerSecond);

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

export async function getMarkets(
  activeOnly: boolean = true,
): Promise<UnifiedMarket[]> {
  const markets: UnifiedMarket[] = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    await limiter.acquire();

    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (activeOnly) {
      params.set('active', 'true');
      params.set('closed', 'false');
    }

    const response = await fetch(
      `${config.polymarket.gammaUrl}/markets?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(
        `Polymarket getMarkets failed: ${response.status} ${response.statusText}`,
      );
    }
    const data = (await response.json()) as PolyMarketRaw[];

    if (!data || data.length === 0) break;

    for (const m of data) {
      // Skip markets that aren't actually tradeable.
      if (!m.enableOrderBook || !m.acceptingOrders) continue;

      // clobTokenIds is a JSON string in the API response.
      let tokenIds: string[] = [];
      try {
        const raw = m.clobTokenIds ?? '[]';
        if (typeof raw === 'string') {
          tokenIds = JSON.parse(raw);
        } else if (Array.isArray(raw)) {
          tokenIds = raw;
        }
      } catch {
        continue;
      }

      if (tokenIds.length < 2) continue;

      // Convention: first token is YES, second is NO.
      const yesTokenId = tokenIds[0];
      const noTokenId = tokenIds[1];

      const conditionId = m.conditionId ?? '';

      markets.push({
        platform: 'polymarket',
        marketId: conditionId,
        title: m.question ?? '',
        yesTokenId,
        noTokenId,
        closeTime: m.endDate,
        url: buildPolyUrl(m),
      });
    }

    offset += limit;
    if (data.length < limit) break;
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
    if (Number.isFinite(price) && Number.isFinite(size)) {
      out.push({ price, size });
    }
  }
  return out;
}

async function fetchBook(tokenId: string): Promise<PolyOrderbookRaw> {
  await limiter.acquire();
  try {
    const response = await fetch(
      `${config.polymarket.clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`,
    );
    if (!response.ok) return {};
    return (await response.json()) as PolyOrderbookRaw;
  } catch {
    return {};
  }
}

export async function getOrderbook(
  yesTokenId: string,
  noTokenId: string,
  marketId: string = '',
): Promise<Orderbook> {
  const [yesBook, noBook] = await Promise.all([
    fetchBook(yesTokenId),
    fetchBook(noTokenId),
  ]);

  const yesBids = parseLevels(yesBook.bids);
  const yesAsks = parseLevels(yesBook.asks);
  const noBids = parseLevels(noBook.bids);
  const noAsks = parseLevels(noBook.asks);

  // Bids descending, asks ascending
  yesBids.sort((a, b) => b.price - a.price);
  noBids.sort((a, b) => b.price - a.price);
  yesAsks.sort((a, b) => a.price - b.price);
  noAsks.sort((a, b) => a.price - b.price);

  return {
    marketId,
    yesBids,
    yesAsks,
    noBids,
    noAsks,
    fetchedAt: Date.now(),
  };
}
