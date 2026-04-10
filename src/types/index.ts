export type ResolutionVerdict = 'SAFE' | 'CAUTION' | 'SKIP' | 'PENDING';

export interface UnifiedMarket {
  platform: 'kalshi' | 'polymarket';
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

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  marketId: string;
  yesAsks: OrderbookLevel[];
  noAsks: OrderbookLevel[];
  yesBids: OrderbookLevel[];
  noBids: OrderbookLevel[];
  fetchedAt: number;
}

export interface ArbitrageLevel {
  buyYesPlatform: 'kalshi' | 'polymarket';
  buyYesPrice: number;
  buyNoPlatform: 'kalshi' | 'polymarket';
  buyNoPrice: number;
  quantity: number;
  totalCost: number;
  grossProfitPct: number;
  estimatedFees: number;
  netProfitPct: number;
  maxProfitDollars: number;
}

export interface ArbitrageOpportunity {
  id: string;
  kalshiMarket: UnifiedMarket;
  polyMarket: UnifiedMarket;
  matchScore: number;
  verdict: ResolutionVerdict;
  verdictReasoning?: string;
  riskFactors?: string[];
  // Claude verification output fields.
  kalshiYesMeaning?: string;
  polyHedgeOutcomeLabel?: string;
  levels: ArbitrageLevel[];
  bestNetSpread: number;
  totalMaxProfit: number;
  scannedAt: number;
  // Capital-efficiency fields populated by the edge function as of 2026-04.
  // Optional so older scan_results rows still parse cleanly.
  daysToClose?: number;
  annualizedReturn?: number;
  effectiveCloseDate?: string;
  kalshiCloseDate?: string;
  polyCloseDate?: string;
  belowThreshold?: boolean;
}

export interface ScannerStats {
  kalshiCount: number;
  polyCount: number;
  matchedCount: number;
  opportunityCount: number;
  lastScanAt: number | null;
  isScanning: boolean;
}

export interface CapitalState {
  totalCapital: number;
  deployedCapital: number;
  safetyReservePct: number;
  realizedPnl: number;
  activeCapital: number;
}

export interface ScannerConfig {
  intervalSeconds: number;
  minNetSpread: number;
}

// UI-facing opportunity type used by the Opportunities page.
// Adapted from ArbitrageOpportunity by the page component.
export type Verdict = 'SAFE' | 'CAUTION' | 'SKIP';

export interface OpportunityRow {
  id: number;
  event: string;
  polyYes: number;
  kalshiNo: number;
  rawSpread: number;
  netSpread: number;
  maxDollar: number;
  verdict: Verdict;
  scanned: string;
  polyDepth: { price: number; qty: number }[];
  kalshiDepth: { price: number; qty: number }[];
  daysToClose?: number;
  annualizedReturn?: number;
  effectiveCloseDate?: string;
  kalshiCloseDate?: string;
  polyCloseDate?: string;
  polyUrl?: string;
  kalshiUrl?: string;
  verdictReasoning?: string;
  riskFactors?: string[];
  kalshiYesMeaning?: string;
  polyHedgeOutcomeLabel?: string;
}

export interface AnalyticsSummary {
  // Capital
  totalCapital: number;
  deployedCapital: number;
  activeCapital: number;
  realizedPnl: number;
  // Trades
  totalPositions: number;
  openPositions: number;
  settledPositions: number;
  partialPositions: number;
  failedPositions: number;
  // Spreads
  totalSpreadsDetected: number;
  openSpreads: number;
  closedSpreads: number;
  avgSpreadDurationSeconds: number | null;
  medianSpreadDurationSeconds: number | null;
  fastestCloseSeconds: number | null;
  slowestCloseSeconds: number | null;
  avgPeakSpread: number;
  avgFirstSpread: number;
  spreadDecayRate: number | null;
  // Alerts
  totalAlerted: number;
  totalExecuted: number;
  alertRate: number;
  executionRate: number;
  // Scanner health
  lastScanAt: string | null;
  lastFastpollAt: string | null;
}

export interface SpreadEvent {
  id: string;
  pairId: string;
  kalshiMarketId: string;
  polyMarketId: string;
  kalshiTitle: string;
  firstDetectedAt: string;
  lastSeenAt: string;
  firstNetSpread: number;
  peakNetSpread: number;
  lastNetSpread: number;
  scanCount: number;
  closedAt: string | null;
  durationSeconds: number | null;
  wasAlerted: boolean;
  wasExecuted: boolean;
  closingReason: string | null;
  source: 'scanner' | 'fastpoll';
}

export interface Position {
  id: string;
  kalshiTitle: string;
  polyTitle: string;
  kalshiMarketId: string | null;
  polyMarketId: string | null;
  status: 'pending' | 'open' | 'partial' | 'settled' | 'cancelled' | 'failed';
  intendedKalshiSide: string | null;
  intendedPolySide: string | null;
  kalshiFillPrice: number | null;
  polyFillPrice: number | null;
  kalshiFillQuantity: number | null;
  polyFillQuantity: number | null;
  kalshiOrderId: string | null;
  polyOrderId: string | null;
  executedAt: string | null;
  createdAt: string;
  opportunityId: string | null;
}
