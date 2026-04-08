// Scanner mock data
export const kalshiMarkets = [
  { id: 'k1', title: 'Will Bitcoin exceed $100K by July 2025?', yes: 0.42, volume: 234500, closes: '2025-07-01', matched: true },
  { id: 'k2', title: 'Fed rate cut at June FOMC meeting', yes: 0.61, volume: 187200, closes: '2025-06-18', matched: true },
  { id: 'k3', title: 'Trump wins 2028 Republican primary', yes: 0.35, volume: 89400, closes: '2028-03-01', matched: false },
  { id: 'k4', title: 'Ethereum above $5000 by EOY 2025', yes: 0.38, volume: 156800, closes: '2025-12-31', matched: true },
  { id: 'k5', title: 'US GDP growth above 3% Q2 2025', yes: 0.55, volume: 42300, closes: '2025-07-30', matched: false },
  { id: 'k6', title: 'Apple stock above $250 by Sept 2025', yes: 0.48, volume: 67800, closes: '2025-09-30', matched: false },
  { id: 'k7', title: 'Ukraine ceasefire agreement by Aug 2025', yes: 0.31, volume: 345600, closes: '2025-08-31', matched: true },
  { id: 'k8', title: 'US inflation below 2.5% by Dec 2025', yes: 0.44, volume: 98700, closes: '2025-12-31', matched: false },
];

export const polyMarkets = [
  { id: 'p1', title: 'Bitcoin exceeds $100K by July 2025', yes: 0.45, volume: 456700, closes: '2025-07-01', matched: true },
  { id: 'p2', title: 'Federal Reserve cuts rates in June', yes: 0.58, volume: 312400, closes: '2025-06-18', matched: true },
  { id: 'p3', title: 'Solana flips Ethereum market cap 2025', yes: 0.12, volume: 23400, closes: '2025-12-31', matched: false },
  { id: 'p4', title: 'ETH price above $5K end of 2025', yes: 0.41, volume: 278900, closes: '2025-12-31', matched: true },
  { id: 'p5', title: 'Democrats win 2026 midterm House', yes: 0.47, volume: 567800, closes: '2026-11-03', matched: false },
  { id: 'p6', title: 'Tesla delivers 2M vehicles in 2025', yes: 0.33, volume: 45600, closes: '2025-12-31', matched: false },
  { id: 'p7', title: 'Ukraine-Russia ceasefire before Sept', yes: 0.34, volume: 489200, closes: '2025-08-31', matched: true },
  { id: 'p8', title: 'S&P 500 above 6000 by Oct 2025', yes: 0.52, volume: 123400, closes: '2025-10-31', matched: false },
];

// Opportunities mock data
export type Verdict = 'SAFE' | 'CAUTION' | 'SKIP';

export interface Opportunity {
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
}

export const opportunities: Opportunity[] = [
  {
    id: 1, event: 'Bitcoin exceeds $100K by July 2025',
    polyYes: 0.45, kalshiNo: 0.58, rawSpread: 3.0, netSpread: 1.8,
    maxDollar: 580, verdict: 'SAFE', scanned: '2m ago',
    polyDepth: [{ price: 0.44, qty: 1200 }, { price: 0.45, qty: 800 }, { price: 0.46, qty: 450 }, { price: 0.47, qty: 200 }],
    kalshiDepth: [{ price: 0.57, qty: 900 }, { price: 0.58, qty: 600 }, { price: 0.59, qty: 350 }, { price: 0.60, qty: 150 }],
  },
  {
    id: 2, event: 'Fed rate cut at June FOMC meeting',
    polyYes: 0.58, kalshiNo: 0.39, rawSpread: -3.0, netSpread: -4.2,
    maxDollar: 0, verdict: 'SKIP', scanned: '1m ago',
    polyDepth: [{ price: 0.57, qty: 2100 }, { price: 0.58, qty: 1500 }, { price: 0.59, qty: 900 }],
    kalshiDepth: [{ price: 0.38, qty: 1800 }, { price: 0.39, qty: 1200 }, { price: 0.40, qty: 700 }],
  },
  {
    id: 3, event: 'ETH price above $5K end of 2025',
    polyYes: 0.41, kalshiNo: 0.62, rawSpread: 3.0, netSpread: 1.5,
    maxDollar: 420, verdict: 'CAUTION', scanned: '4m ago',
    polyDepth: [{ price: 0.40, qty: 500 }, { price: 0.41, qty: 380 }, { price: 0.42, qty: 220 }],
    kalshiDepth: [{ price: 0.61, qty: 400 }, { price: 0.62, qty: 280 }, { price: 0.63, qty: 150 }],
  },
  {
    id: 4, event: 'Ukraine-Russia ceasefire before Sept',
    polyYes: 0.34, kalshiNo: 0.69, rawSpread: 3.0, netSpread: 3.8,
    maxDollar: 890, verdict: 'SAFE', scanned: '1m ago',
    polyDepth: [{ price: 0.33, qty: 3400 }, { price: 0.34, qty: 2200 }, { price: 0.35, qty: 1100 }],
    kalshiDepth: [{ price: 0.68, qty: 2800 }, { price: 0.69, qty: 1900 }, { price: 0.70, qty: 800 }],
  },
  {
    id: 5, event: 'S&P 500 closes above 5800 in Q3',
    polyYes: 0.52, kalshiNo: 0.51, rawSpread: 3.0, netSpread: 4.2,
    maxDollar: 1240, verdict: 'SAFE', scanned: '30s ago',
    polyDepth: [{ price: 0.51, qty: 1800 }, { price: 0.52, qty: 1200 }, { price: 0.53, qty: 600 }],
    kalshiDepth: [{ price: 0.50, qty: 1500 }, { price: 0.51, qty: 1000 }, { price: 0.52, qty: 500 }],
  },
  {
    id: 6, event: 'US unemployment above 4.5% by Dec',
    polyYes: 0.38, kalshiNo: 0.60, rawSpread: -2.0, netSpread: -3.1,
    maxDollar: 0, verdict: 'SKIP', scanned: '6m ago',
    polyDepth: [{ price: 0.37, qty: 600 }, { price: 0.38, qty: 400 }, { price: 0.39, qty: 250 }],
    kalshiDepth: [{ price: 0.59, qty: 500 }, { price: 0.60, qty: 350 }, { price: 0.61, qty: 200 }],
  },
];

// Analytics mock data
export const pnlData = Array.from({ length: 30 }, (_, i) => {
  const date = new Date(2025, 2, 10 + i);
  const base = 50 + i * 8;
  const noise = Math.sin(i * 0.7) * 30 + Math.cos(i * 1.3) * 15;
  return {
    date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    pnl: Math.round((base + noise) * 100) / 100,
  };
});

export const categoryData = [
  { category: 'Politics', count: 14 },
  { category: 'Crypto', count: 11 },
  { category: 'Sports', count: 8 },
  { category: 'Economics', count: 6 },
  { category: 'Finance', count: 4 },
  { category: 'Other', count: 2 },
];

export const spreadDistribution = [
  { bucket: '0-2%', count: 12 },
  { bucket: '2-4%', count: 18 },
  { bucket: '4-6%', count: 8 },
  { bucket: '6%+', count: 4 },
];

export type TradeStatus = 'SETTLED' | 'OPEN' | 'DISPUTED';

export interface Trade {
  date: string;
  event: string;
  verdict: Verdict;
  spread: number;
  pnl: number;
  status: TradeStatus;
}

export const tradeHistory: Trade[] = [
  { date: 'Apr 6', event: 'BTC above $95K by April', verdict: 'SAFE', spread: 4.2, pnl: 18.40, status: 'SETTLED' },
  { date: 'Apr 5', event: 'Fed holds rates in March', verdict: 'SAFE', spread: 3.1, pnl: 12.80, status: 'SETTLED' },
  { date: 'Apr 4', event: 'ETH flips BNB market cap', verdict: 'CAUTION', spread: 2.8, pnl: -5.20, status: 'SETTLED' },
  { date: 'Apr 3', event: 'Ukraine ceasefire by April', verdict: 'SAFE', spread: 5.1, pnl: 24.60, status: 'SETTLED' },
  { date: 'Apr 2', event: 'S&P 500 above 5500 in March', verdict: 'SAFE', spread: 3.8, pnl: 15.30, status: 'SETTLED' },
  { date: 'Apr 1', event: 'Trump tariff announcement', verdict: 'CAUTION', spread: 2.1, pnl: 8.90, status: 'OPEN' },
  { date: 'Mar 31', event: 'Solana above $200 by April', verdict: 'SKIP', spread: -1.2, pnl: -8.40, status: 'SETTLED' },
  { date: 'Mar 30', event: 'US GDP Q1 above 2.5%', verdict: 'SAFE', spread: 3.5, pnl: 0, status: 'OPEN' },
  { date: 'Mar 29', event: 'Apple launches AI device', verdict: 'CAUTION', spread: 1.8, pnl: 6.20, status: 'DISPUTED' },
  { date: 'Mar 28', event: 'Oil above $85 by May', verdict: 'SAFE', spread: 4.0, pnl: 19.10, status: 'SETTLED' },
];

// Positions mock data
export interface Position {
  id: string;
  event: string;
  verdict: Verdict;
  polyLeg: string;
  kalshiLeg: string;
  deployed: number;
  unrealizedPnl: number;
  netSpread: number;
  settles: string;
}

export const positions: Position[] = [
  {
    id: 'pos1', event: 'Ukraine-Russia ceasefire before Sept',
    verdict: 'SAFE', polyLeg: 'YES @ $0.34', kalshiLeg: 'NO @ $0.69',
    deployed: 120, unrealizedPnl: 8.40, netSpread: 4.2, settles: '2025-08-31',
  },
  {
    id: 'pos2', event: 'S&P 500 closes above 5800 in Q3',
    verdict: 'SAFE', polyLeg: 'YES @ $0.52', kalshiLeg: 'NO @ $0.51',
    deployed: 85, unrealizedPnl: -3.20, netSpread: 3.1, settles: '2025-09-30',
  },
  {
    id: 'pos3', event: 'Bitcoin exceeds $100K by July 2025',
    verdict: 'CAUTION', polyLeg: 'YES @ $0.45', kalshiLeg: 'NO @ $0.58',
    deployed: 135, unrealizedPnl: 12.60, netSpread: 1.8, settles: '2025-07-01',
  },
];
