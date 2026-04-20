import type { Trade, DailySnapshot } from '@/types';

// In production (Vercel): use the serverless proxy to avoid mixed content
// In dev: hit VPS directly
const isDev = import.meta.env.DEV;
const VPS_DIRECT = import.meta.env.VITE_API_URL ?? 'http://87.99.155.128:3456';
const API_TOKEN = import.meta.env.VITE_API_TOKEN ?? 'arbor-2026';

function buildGetUrl(apiPath: string): string {
  if (isDev) {
    const sep = apiPath.includes('?') ? '&' : '?';
    return `${VPS_DIRECT}${apiPath}${sep}token=${API_TOKEN}`;
  }
  return `/api/proxy?path=${encodeURIComponent(apiPath)}`;
}

function buildPostUrl(apiPath: string): string {
  if (isDev) {
    const sep = apiPath.includes('?') ? '&' : '?';
    return `${VPS_DIRECT}${apiPath}${sep}token=${API_TOKEN}`;
  }
  return `/api/proxy?path=${encodeURIComponent(apiPath)}`;
}

async function get<T>(apiPath: string, timeoutMs = 10000): Promise<T> {
  const res = await fetch(buildGetUrl(apiPath), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`API ${apiPath}: ${res.status}`);
  return res.json();
}

async function post<T>(apiPath: string, body: any = {}): Promise<T> {
  const res = await fetch(buildPostUrl(apiPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`API ${apiPath}: ${res.status}`);
  return res.json();
}

/** SSE URL — used by useRealtime. In prod adds &stream=1 so proxy knows to stream. */
export function eventsUrl(): string {
  if (isDev) return `${VPS_DIRECT}/api/events?token=${API_TOKEN}`;
  return `/api/proxy?path=${encodeURIComponent('/api/events')}&stream=1`;
}

export const api = {
  getTrades: () => get<Trade[]>('/api/trades'),
  getPositions: () => get<Trade[]>('/api/positions'),
  getStats: () => get<any>('/api/stats'),
  getSnapshots: () => get<DailySnapshot[]>('/api/snapshots'),
  getGames: () => get<any[]>('/api/games'),
  getControlStatus: () => get<{ paused: boolean; disabledStrategies: string[]; pausedReason?: string; updatedAt: string | null }>('/api/control/status'),
  pause: (reason?: string) => post<any>('/api/control/pause', { reason }),
  resume: () => post<any>('/api/control/resume'),
  toggleStrategy: (strategy: string, action: 'enable' | 'disable') =>
    post<any>('/api/control/strategy', { strategy, action }),
  sellPosition: (args: { tradeId?: string; ticker?: string; reason?: string }) =>
    post<any>('/api/control/sell', args),
  getSummary: (hours = 1) =>
    get<{ summary: string; generatedAt: string | null; lines?: number; hours?: number }>(`/api/summary?hours=${hours}`, 60000),
  getRecap: (period: 'daily' | 'weekly' = 'daily') =>
    get<RecapData>(`/api/recap?period=${period}`, 60000),
  getLiveInsight: () =>
    get<LiveInsightData>('/api/live-insight'),
  getPaperTrades: (date?: string) =>
    get<PaperTrade[]>(`/api/paper-trades${date ? `?date=${date}` : ''}`),
  getPaperStats: () =>
    get<PaperStats>('/api/paper-stats'),
  getApiCosts: (hours = 24) =>
    get<ApiCostReport>(`/api/costs?hours=${hours}`),
};

export type ApiCostCategory = {
  category: string;
  calls: number;
  inputTok: number;
  outputTok: number;
  cacheReadTok: number;
  cacheWriteTok: number;
  searches: number;
  cents: number;
  usd: number;
  models: Record<string, number>;
};

export type ApiCostReport = {
  windowHours: number;
  totals: {
    calls: number;
    searches: number;
    inputTok: number;
    outputTok: number;
    cacheReadTok: number;
    cacheWriteTok: number;
    cents: number;
    usd: number;
  };
  byCategory: ApiCostCategory[];
  hourly: { hour: string; calls: number; cents: number }[];
};

export type PaperTrade = {
  id: string;
  timestamp: string;
  strategy: 'pre-game-paper';
  sport: string;
  marketBase: string;
  ticker: string;
  teamAbbr: string;
  teamName: string;
  opponentAbbr: string;
  opponentName: string;
  marketTitle: string;
  confidence: number;
  price: number;
  edge: number;
  wouldBetAmount: number;
  wouldQty: number;
  reasoning: string;
  pgBaseline: number;
  status: 'pending' | 'won' | 'lost';
  outcome: 'correct' | 'incorrect' | null;
  settledAt: string | null;
  paperPnL: number | null;
};

export type PaperStats = {
  total: number;
  pending: number;
  wins: number;
  losses: number;
  winRate: number | null;
  impliedPnL: number;
  bySport: { sport: string; total: number; wins: number; winRate: number | null; impliedPnL: number }[];
  byConfidence: { label: string; total: number; wins: number; winRate: number | null; impliedPnL: number }[];
};

export type LiveInsightGame = {
  gameKey: string;
  league: string | null;
  away: string;
  home: string;
  score: string | null;
  gameDetail: string | null;
  period: number | null;
  targetAbbr: string | null;
  price: number | null;
  winExpectancy: number | null;
  confidence: number | null;
  result: string;
  reasoning: string | null;
  updatedAt: string;
  cycleCount: number;
};

export type LiveInsightData = {
  games: LiveInsightGame[];
  insight: string | null;
  generatedAt: string;
  windowMinutes: number;
};

export type RecapData = {
  period: 'daily' | 'weekly';
  start: string;
  end: string;
  placed: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnL: number;
  best: { title: string; pnl: number; ticker: string } | null;
  worst: { title: string; pnl: number; ticker: string } | null;
  sportBreakdown: { sport: string; trades: number; wins: number; pnl: number; winRate: number }[];
  commentary: string | null;
  generatedAt: string;
};
