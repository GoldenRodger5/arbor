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
  levels: ArbitrageLevel[];
  bestNetSpread: number;
  totalMaxProfit: number;
  scannedAt: number;
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
