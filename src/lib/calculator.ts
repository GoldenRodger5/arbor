import type { ArbitrageLevel, Orderbook, OrderbookLevel } from '@/types';

type Platform = 'kalshi' | 'polymarket';

/**
 * Kalshi taker fee. Formula from fee_calculator.py:
 *   ceil(0.07 * contracts * price * (1 - price) * 100) / 100
 * Returns fee in dollars. Price is on the 0-1 scale.
 */
export function kalshiFee(contracts: number, price: number): number {
  return Math.ceil(0.07 * contracts * price * (1 - price) * 100) / 100;
}

/** Polymarket Global currently has zero taker fees. */
export function polyFee(): number {
  return 0;
}

function feeForLeg(platform: Platform, contracts: number, price: number): number {
  return platform === 'kalshi' ? kalshiFee(contracts, price) : polyFee();
}

/**
 * Walk two ask sides in lockstep, taking min(yesQty, noQty) per step.
 * Stops when gross profit (1 - totalCost) drops below the threshold.
 * Faithful port of ArbitrageCalculator._walk_orderbook.
 */
export function walkOrderbook(
  yesAsks: OrderbookLevel[],
  noAsks: OrderbookLevel[],
  yesPlatform: Platform,
  noPlatform: Platform,
  minThreshold: number,
): ArbitrageLevel[] {
  const levels: ArbitrageLevel[] = [];

  // Mutable copies of remaining size at each level.
  const yesRemaining: Array<{ price: number; size: number }> = yesAsks.map(
    (l) => ({ price: l.price, size: l.size }),
  );
  const noRemaining: Array<{ price: number; size: number }> = noAsks.map(
    (l) => ({ price: l.price, size: l.size }),
  );

  let yesIdx = 0;
  let noIdx = 0;

  while (yesIdx < yesRemaining.length && noIdx < noRemaining.length) {
    const yesLvl = yesRemaining[yesIdx];
    const noLvl = noRemaining[noIdx];

    const totalCost = yesLvl.price + noLvl.price;
    const grossProfitPct = 1.0 - totalCost;

    // Stop walking once we drop below the minimum gross threshold.
    if (grossProfitPct < minThreshold) break;

    const qty = Math.min(yesLvl.size, noLvl.size);

    if (qty > 0) {
      const yesFee = feeForLeg(yesPlatform, qty, yesLvl.price);
      const noFee = feeForLeg(noPlatform, qty, noLvl.price);
      const totalFees = yesFee + noFee;

      // Express fees as a fraction of one contract for net % math.
      const feePct = qty > 0 ? totalFees / qty : 0;
      const netProfitPct = grossProfitPct - feePct;
      const maxProfitDollars = qty * netProfitPct;

      levels.push({
        buyYesPlatform: yesPlatform,
        buyYesPrice: yesLvl.price,
        buyNoPlatform: noPlatform,
        buyNoPrice: noLvl.price,
        quantity: qty,
        totalCost,
        grossProfitPct,
        estimatedFees: totalFees,
        netProfitPct,
        maxProfitDollars,
      });

      yesLvl.size -= qty;
      noLvl.size -= qty;
    }

    if (yesRemaining[yesIdx].size <= 0) yesIdx++;
    if (noRemaining[noIdx].size <= 0) noIdx++;
  }

  return levels;
}

/**
 * Try both arbitrage strategies (YES on Kalshi + NO on Poly, and the
 * reverse), combine and sort by net profit % descending.
 */
export function calculateOpportunity(
  kalshiBook: Orderbook,
  polyBook: Orderbook,
  minThreshold: number,
): ArbitrageLevel[] {
  // Strategy 1: YES on Kalshi + NO on Polymarket
  const levels1 = walkOrderbook(
    kalshiBook.yesAsks,
    polyBook.noAsks,
    'kalshi',
    'polymarket',
    minThreshold,
  );

  // Strategy 2: YES on Polymarket + NO on Kalshi
  const levels2 = walkOrderbook(
    polyBook.yesAsks,
    kalshiBook.noAsks,
    'polymarket',
    'kalshi',
    minThreshold,
  );

  const all = [...levels1, ...levels2];
  all.sort((a, b) => b.netProfitPct - a.netProfitPct);
  return all;
}
