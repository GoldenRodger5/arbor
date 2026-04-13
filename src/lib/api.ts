import type { Trade, DailySnapshot } from '@/types';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://87.99.155.128:3456';
const API_TOKEN = import.meta.env.VITE_API_TOKEN ?? 'arbor-2026';

async function get<T>(path: string): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const res = await fetch(`${API_BASE}${path}${separator}token=${API_TOKEN}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

export const api = {
  getTrades: () => get<Trade[]>('/api/trades'),
  getPositions: () => get<Trade[]>('/api/positions'),
  getStats: () => get<any>('/api/stats'),
  getSnapshots: () => get<DailySnapshot[]>('/api/snapshots'),
};
