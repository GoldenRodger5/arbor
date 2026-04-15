import type { Trade, DailySnapshot } from '@/types';

// In production (Vercel): use the serverless proxy to avoid mixed content
// In dev: hit VPS directly
const isDev = import.meta.env.DEV;
const VPS_DIRECT = import.meta.env.VITE_API_URL ?? 'http://87.99.155.128:3456';
const API_TOKEN = import.meta.env.VITE_API_TOKEN ?? 'arbor-2026';

async function get<T>(apiPath: string): Promise<T> {
  let url: string;
  if (isDev) {
    // Dev: hit VPS directly (no HTTPS issues on localhost)
    const sep = apiPath.includes('?') ? '&' : '?';
    url = `${VPS_DIRECT}${apiPath}${sep}token=${API_TOKEN}`;
  } else {
    // Production: use Vercel serverless proxy (HTTPS → HTTP)
    url = `/api/proxy?path=${encodeURIComponent(apiPath)}`;
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`API ${apiPath}: ${res.status}`);
  return res.json();
}

export const api = {
  getTrades: () => get<Trade[]>('/api/trades'),
  getPositions: () => get<Trade[]>('/api/positions'),
  getStats: () => get<any>('/api/stats'),
  getSnapshots: () => get<DailySnapshot[]>('/api/snapshots'),
  getGames: () => get<any[]>('/api/games'),
};
