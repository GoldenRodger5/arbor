import config from '@/config';
import type {
  ArbitrageLevel,
  ArbitrageOpportunity,
  Orderbook,
  ScannerConfig,
  ScannerStats,
  UnifiedMarket,
} from '@/types';
import * as kalshi from './kalshi';
import * as poly from './polymarket';
import { calculateOpportunity } from './calculator';
import { findCandidatePairs, type CandidatePair } from './matcher';
import { verifyPair } from './resolver';
import {
  getCachedVerdict,
  logSpread,
  upsertMarketPair,
} from './supabase';
import type { ResolutionVerdict } from '@/types';

interface PreparedPair {
  pair: CandidatePair;
  pairId: string | null;
  verdict: ResolutionVerdict;
  reasoning?: string;
  riskFactors?: string[];
}

async function fetchMarketsSafe(): Promise<{
  kalshiMarkets: UnifiedMarket[];
  polyMarkets: UnifiedMarket[];
}> {
  const [kalshiResult, polyResult] = await Promise.allSettled([
    kalshi.getMarkets(),
    poly.getMarkets(),
  ]);

  const kalshiMarkets =
    kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];
  const polyMarkets =
    polyResult.status === 'fulfilled' ? polyResult.value : [];

  if (kalshiResult.status === 'rejected') {
    console.error('[scanner] kalshi.getMarkets failed', kalshiResult.reason);
  }
  if (polyResult.status === 'rejected') {
    console.error('[scanner] poly.getMarkets failed', polyResult.reason);
  }

  return { kalshiMarkets, polyMarkets };
}

async function resolvePair(pair: CandidatePair): Promise<PreparedPair> {
  // Cache lookup first.
  const cached = await getCachedVerdict(
    pair.kalshi.marketId,
    pair.poly.marketId,
  );
  if (cached) {
    return {
      pair,
      pairId: cached.id,
      verdict: cached.verdict,
      reasoning: cached.reasoning,
    };
  }

  // No cache — call Claude (or get PENDING if no API key).
  let verdict: ResolutionVerdict = 'PENDING';
  let reasoning = '';
  let riskFactors: string[] = [];
  try {
    const result = await verifyPair(pair.kalshi, pair.poly);
    verdict = result.verdict;
    reasoning = result.reasoning;
    riskFactors = result.riskFactors;
  } catch (err) {
    console.error('[scanner] verifyPair failed', err);
    verdict = 'CAUTION';
  }

  let pairId: string | null = null;
  try {
    pairId = await upsertMarketPair({
      kalshiMarketId: pair.kalshi.marketId,
      kalshiTitle: pair.kalshi.title,
      kalshiResolutionCriteria: pair.kalshi.resolutionCriteria,
      polyMarketId: pair.poly.marketId,
      polyTitle: pair.poly.title,
      polyResolutionCriteria: pair.poly.resolutionCriteria,
      verdict,
      verdictReasoning: reasoning,
      riskFactors,
      matchScore: pair.score,
    });
  } catch (err) {
    console.error('[scanner] upsertMarketPair failed', err);
  }

  return { pair, pairId, verdict, reasoning, riskFactors };
}

function bestNetSpread(levels: ArbitrageLevel[]): number {
  if (levels.length === 0) return 0;
  return levels[0].netProfitPct;
}

function totalMaxProfit(levels: ArbitrageLevel[]): number {
  return levels.reduce((acc, l) => acc + l.maxProfitDollars, 0);
}

function isStale(book: Orderbook): boolean {
  return Date.now() - book.fetchedAt > config.scanner.stalenessThresholdMs;
}

export async function runScanCycle(scanConfig: ScannerConfig): Promise<{
  opportunities: ArbitrageOpportunity[];
  stats: ScannerStats;
}> {
  const startedAt = Date.now();

  // 1. Fetch markets concurrently.
  const { kalshiMarkets, polyMarkets } = await fetchMarketsSafe();

  // 2. Find candidate pairs by fuzzy match.
  const candidates = findCandidatePairs(kalshiMarkets, polyMarkets);

  // 3. Resolve verdicts (cache or Claude) for each candidate, in parallel.
  const prepared = await Promise.all(candidates.map(resolvePair));

  // Filter out SKIP verdicts.
  const validPairs = prepared.filter((p) => p.verdict !== 'SKIP');

  // 4. Fetch orderbooks for SAFE/CAUTION/PENDING pairs concurrently.
  const orderbookResults = await Promise.all(
    validPairs.map(async (p) => {
      const { pair } = p;
      try {
        if (!pair.poly.yesTokenId || !pair.poly.noTokenId) return null;
        const [kalshiBook, polyBook] = await Promise.all([
          kalshi.getOrderbook(pair.kalshi.marketId),
          poly.getOrderbook(
            pair.poly.yesTokenId,
            pair.poly.noTokenId,
            pair.poly.marketId,
          ),
        ]);
        return { kalshiBook, polyBook };
      } catch (err) {
        console.error('[scanner] orderbook fetch failed', err);
        return null;
      }
    }),
  );

  // 5. Build opportunities.
  const opportunities: ArbitrageOpportunity[] = [];

  for (let i = 0; i < validPairs.length; i++) {
    const prep = validPairs[i];
    const books = orderbookResults[i];
    if (!books) continue;

    const { kalshiBook, polyBook } = books;

    // Staleness check.
    if (isStale(kalshiBook) || isStale(polyBook)) continue;

    const levels = calculateOpportunity(
      kalshiBook,
      polyBook,
      scanConfig.minNetSpread,
    );
    if (levels.length === 0) continue;

    const best = levels[0];
    const opp: ArbitrageOpportunity = {
      id: `${prep.pair.kalshi.marketId}:${prep.pair.poly.marketId}`,
      kalshiMarket: prep.pair.kalshi,
      polyMarket: prep.pair.poly,
      matchScore: prep.pair.score,
      verdict: prep.verdict,
      verdictReasoning: prep.reasoning,
      riskFactors: prep.riskFactors,
      levels,
      bestNetSpread: bestNetSpread(levels),
      totalMaxProfit: totalMaxProfit(levels),
      scannedAt: Date.now(),
    };
    opportunities.push(opp);

    if (prep.pairId) {
      const polyYesPrice =
        best.buyYesPlatform === 'polymarket' ? best.buyYesPrice : best.buyNoPrice;
      const polyNoPrice =
        best.buyNoPlatform === 'polymarket' ? best.buyNoPrice : best.buyYesPrice;
      const kalshiYesPrice =
        best.buyYesPlatform === 'kalshi' ? best.buyYesPrice : best.buyNoPrice;
      const kalshiNoPrice =
        best.buyNoPlatform === 'kalshi' ? best.buyNoPrice : best.buyYesPrice;

      try {
        await logSpread(prep.pairId, {
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
  }

  // 6. Sort opportunities by best net spread descending.
  opportunities.sort((a, b) => b.bestNetSpread - a.bestNetSpread);

  // 7. Stats.
  const stats: ScannerStats = {
    kalshiCount: kalshiMarkets.length,
    polyCount: polyMarkets.length,
    matchedCount: candidates.length,
    opportunityCount: opportunities.length,
    lastScanAt: startedAt,
    isScanning: false,
  };

  return { opportunities, stats };
}

export function startScanner(
  scanConfig: ScannerConfig,
  onUpdate: (result: {
    opportunities: ArbitrageOpportunity[];
    stats: ScannerStats;
  }) => void,
): () => void {
  const tick = () => {
    runScanCycle(scanConfig).then(onUpdate).catch((err) => {
      console.error('[scanner] runScanCycle failed', err);
    });
  };

  // Run once immediately.
  tick();

  const id = setInterval(tick, scanConfig.intervalSeconds * 1000);
  return () => clearInterval(id);
}
