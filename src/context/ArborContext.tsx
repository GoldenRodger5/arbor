import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Trade, DailySnapshot } from '@/types';
import { api } from '@/lib/api';

interface ArborState {
  trades: Trade[];
  positions: Trade[];
  stats: any;
  snapshots: DailySnapshot[];
  loading: boolean;
  error: string | null;
  lastRefresh: number;
  refresh: () => Promise<void>;
}

const ArborContext = createContext<ArborState | null>(null);

export function ArborProvider({ children }: { children: ReactNode }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [positions, setPositions] = useState<Trade[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [t, p, s, sn] = await Promise.allSettled([
        api.getTrades(),
        api.getPositions(),
        api.getStats(),
        api.getSnapshots(),
      ]);
      if (t.status === 'fulfilled') setTrades(t.value);
      if (p.status === 'fulfilled') setPositions(p.value);
      if (s.status === 'fulfilled') setStats(s.value);
      if (sn.status === 'fulfilled') setSnapshots(sn.value);
      setLastRefresh(Date.now());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + poll every 30s
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <ArborContext.Provider value={{ trades, positions, stats, snapshots, loading, error, lastRefresh, refresh }}>
      {children}
    </ArborContext.Provider>
  );
}

export function useArbor() {
  const ctx = useContext(ArborContext);
  if (!ctx) throw new Error('useArbor must be used within ArborProvider');
  return ctx;
}
