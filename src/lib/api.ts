import type { Trade, DailySnapshot } from '@/types';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://87.99.155.128:3456';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

export const api = {
  getTrades: () => get<Trade[]>('/api/trades'),
  getPositions: () => get<Trade[]>('/api/positions'),
  getStats: () => get<any>('/api/stats'),
  getSnapshots: () => get<DailySnapshot[]>('/api/snapshots'),
};
