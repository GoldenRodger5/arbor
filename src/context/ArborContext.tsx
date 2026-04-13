import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Trade, DailySnapshot } from '@/types';
import { api } from '@/lib/api';

interface ArborState {
  trades: Trade[];
  positions: Trade[];
  stats: any;
  snapshots: DailySnapshot[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  connected: boolean;
  lastRefresh: number;
  refresh: () => Promise<void>;
}

const ArborContext = createContext<ArborState | null>(null);

const POLL_MS = 15_000; // 15 seconds — fast enough for live games

export function ArborProvider({ children }: { children: ReactNode }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [positions, setPositions] = useState<Trade[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [t, p, s, sn] = await Promise.allSettled([
        api.getTrades(),
        api.getPositions(),
        api.getStats(),
        api.getSnapshots(),
      ]);
      if (!mountedRef.current) return;
      if (t.status === 'fulfilled') setTrades(t.value);
      if (p.status === 'fulfilled') setPositions(p.value);
      if (s.status === 'fulfilled') setStats(s.value);
      if (sn.status === 'fulfilled') setSnapshots(sn.value);

      const anySuccess = [t, p, s, sn].some(r => r.status === 'fulfilled');
      setConnected(anySuccess);
      setError(anySuccess ? null : 'All API calls failed');
      setLastRefresh(Date.now());
    } catch (e: any) {
      if (mountedRef.current) {
        setError(e.message);
        setConnected(false);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  return (
    <ArborContext.Provider value={{
      trades, positions, stats, snapshots,
      loading, refreshing, error, connected, lastRefresh, refresh,
    }}>
      {children}
    </ArborContext.Provider>
  );
}

export function useArbor() {
  const ctx = useContext(ArborContext);
  if (!ctx) throw new Error('useArbor must be used within ArborProvider');
  return ctx;
}
