// Arbor Prediction Trading Bot — UI Types

export interface Trade {
  id: string;
  timestamp: string;
  exchange: 'kalshi' | 'polymarket';
  strategy: string;
  ticker: string;
  title: string;
  side: string;
  quantity: number;
  entryPrice: number;
  deployCost: number;
  filled: number;
  orderId: string | null;
  edge: number;
  confidence: number;
  reasoning: string;
  reasoningStructured?: {
    steel_man?: string;
    edge_source?: string;
    edge_argument?: string;
    key_facts?: string[];
    top_risk?: string;
    conviction?: string;
  } | null;
  liveScore?: string;
  otherPlatformPrice?: number;
  status: 'open' | 'settled' | 'sold-stop-loss' | 'sold-claude-stop' | 'sold-claude-sell' | 'closed-manual' | string;
  exitPrice: number | null;
  realizedPnL: number | null;
  settledAt: string | null;
  result?: string;
  category?: string;
  // AI review fields
  reviewGrade?: string;
  reviewText?: string;
  reviewedAt?: string;
  // High-conviction tier marker (late-game near-certain plays)
  highConviction?: boolean;
  tier?: string;
}

export interface DailySnapshot {
  date: string;
  timestamp: string;
  bankroll: number;
  kalshiCash: number;
  kalshiPositions: number;
  polyBalance: number;
  openPositionCount: number;
  totalDeployed: number;
  totalTrades: number;
  settledTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnL: number;
  todayPnL: number;
  todayTrades: number;
  consecutiveLosses: number;
  strategyStats: Record<string, StrategyStats>;
}

export interface StrategyStats {
  trades: number;
  settled: number;
  wins: number;
  losses: number;
  pnl: number;
}

export interface ScreenLog {
  timestamp: string;
  stage: string;
  ticker?: string;
  result?: string;
  confidence?: number;
  price?: number;
  reasoning?: string;
  [key: string]: unknown;
}

export interface BotState {
  bankroll: number;
  kalshiCash: number;
  kalshiPositions: number;
  polyBalance: number;
  openPositionCount: number;
  totalDeployed: number;
  isRunning: boolean;
  apiSpendCents: number;
  claudeCalls: number;
  tradesPlaced: number;
}

export interface SportPerformance {
  sport: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
}

export interface CalibrationBucket {
  label: string;
  minConf: number;
  maxConf: number;
  total: number;
  wins: number;
  actualWinRate: number;
}
