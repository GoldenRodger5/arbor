// NOTE: This module's logic has been moved to
// supabase/functions/scanner/index.ts
// This file is kept for reference only.
// It is NOT imported by the frontend.

import config from '@/config';
import type { UnifiedMarket } from '@/types';

/**
 * Lowercase, strip punctuation, split into tokens, sort alphabetically.
 * Equivalent of rapidfuzz token_sort prep + UnifiedMarket.normalized_title.
 */
export function normalizeTitle(title: string): string[] {
  const cleaned = title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(' ')
    .filter((t) => t.length > 0)
    .sort();
}

/**
 * Token-set Jaccard similarity. Returns 0-1.
 * The Python reference uses rapidfuzz's token_sort_ratio (which is a
 * Levenshtein-based ratio over the token-sorted strings, scored 0-100).
 * This is a lighter-weight equivalent appropriate for a TS bundle: it
 * compares the token sets directly.
 */
export function fuzzyScore(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a));
  const tb = new Set(normalizeTitle(b));
  if (ta.size === 0 && tb.size === 0) return 0;

  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

export interface CandidatePair {
  kalshi: UnifiedMarket;
  poly: UnifiedMarket;
  score: number;
}

/**
 * For each Kalshi market find the highest-scoring Polymarket title.
 * Greedy: pairs are emitted in order of best score and a Polymarket
 * market may only be matched once (mirrors fuzzy_matcher.py).
 */
export function findCandidatePairs(
  kalshiMarkets: UnifiedMarket[],
  polyMarkets: UnifiedMarket[],
): CandidatePair[] {
  if (kalshiMarkets.length === 0 || polyMarkets.length === 0) return [];

  const threshold = config.scanner.fuzzyMatchThreshold;

  // Compute best poly index + score for each kalshi market.
  const bestForKalshi: Array<{ polyIdx: number; score: number }> = [];
  for (let i = 0; i < kalshiMarkets.length; i++) {
    let bestScore = -1;
    let bestIdx = -1;
    for (let j = 0; j < polyMarkets.length; j++) {
      const score = fuzzyScore(kalshiMarkets[i].title, polyMarkets[j].title);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }
    bestForKalshi.push({ polyIdx: bestIdx, score: bestScore });
  }

  // Process kalshi markets in descending best-score order so the
  // highest-confidence pairs claim their poly counterpart first.
  const order = bestForKalshi
    .map((b, i) => ({ kalshiIdx: i, ...b }))
    .sort((a, b) => b.score - a.score);

  const claimed = new Set<number>();
  const results: CandidatePair[] = [];

  for (const entry of order) {
    if (entry.score < threshold) continue;
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
  return results;
}
