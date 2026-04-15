import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Trade, DailySnapshot } from '@/types';
import { api } from '@/lib/api';
import { useRealtime } from '@/hooks/useRealtime';
import { notify, buzz } from '@/lib/notify';
import { toast } from 'sonner';

type ControlState = {
  paused: boolean;
  pausedReason?: string | null;
  disabledStrategies: string[];
  updatedAt: string | null;
};

interface ArborState {
  trades: Trade[];
  positions: Trade[];
  stats: any;
  snapshots: DailySnapshot[];
  control: ControlState;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  connected: boolean;
  realtime: boolean;
  lastRefresh: number;
  refresh: () => Promise<void>;
  refreshControl: () => Promise<void>;
}

const ArborContext = createContext<ArborState | null>(null);

// Slow polling is the SSE fallback / safety net. SSE pushes give us live updates.
const POLL_MS = 30_000;

const DEFAULT_CONTROL: ControlState = { paused: false, disabledStrategies: [], updatedAt: null };

export function ArborProvider({ children }: { children: ReactNode }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [positions, setPositions] = useState<Trade[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([]);
  const [control, setControl] = useState<ControlState>(DEFAULT_CONTROL);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [realtime, setRealtime] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(0);
  const mountedRef = useRef(true);
  const seenTradeIds = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [t, p, s, sn, c] = await Promise.allSettled([
        api.getTrades(),
        api.getPositions(),
        api.getStats(),
        api.getSnapshots(),
        api.getControlStatus(),
      ]);
      if (!mountedRef.current) return;
      if (t.status === 'fulfilled') {
        setTrades(t.value);
        // Seed dedup set so we don't fire "new trade" toasts for pre-existing trades
        for (const tr of t.value) if (tr.id) seenTradeIds.current.add(tr.id);
      }
      if (p.status === 'fulfilled') setPositions(p.value);
      if (s.status === 'fulfilled') setStats(s.value);
      if (sn.status === 'fulfilled') setSnapshots(sn.value);
      if (c.status === 'fulfilled') setControl({ ...DEFAULT_CONTROL, ...c.value });

      const anySuccess = [t, p, s, sn, c].some(r => r.status === 'fulfilled');
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

  const refreshControl = useCallback(async () => {
    try {
      const c = await api.getControlStatus();
      if (mountedRef.current) setControl({ ...DEFAULT_CONTROL, ...c });
    } catch { /* ignore */ }
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

  // ─── SSE realtime ──────────────────────────────────────────────────────────
  useRealtime({
    onConnect: () => {
      setRealtime(true);
      setConnected(true);
    },
    onDisconnect: () => {
      setRealtime(false);
    },
    onTrade: (trade: any) => {
      if (!trade?.id) return;
      const isNew = !seenTradeIds.current.has(trade.id);
      seenTradeIds.current.add(trade.id);

      // Merge into trades list
      setTrades(prev => {
        const idx = prev.findIndex(t => t.id === trade.id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], ...trade };
          return copy;
        }
        return [...prev, trade];
      });

      // Positions: open trades show, anything else removes
      setPositions(prev => {
        if (trade.status === 'open') {
          const idx = prev.findIndex(p => p.id === trade.id);
          if (idx >= 0) { const c = [...prev]; c[idx] = trade; return c; }
          return [...prev, trade];
        }
        return prev.filter(p => p.id !== trade.id);
      });

      // Fire a notification for key moments
      if (isNew && trade.status === 'open') {
        const priceTxt = trade.entryPrice != null ? ` @ ${Math.round(trade.entryPrice * 100)}¢` : '';
        const confTxt = trade.confidence != null ? ` (${Math.round(trade.confidence * 100)}% conf)` : '';
        toast.success(`Bought ${trade.title ?? trade.ticker}${priceTxt}${confTxt}`);
        notify('🎯 New trade', {
          body: `${trade.title ?? trade.ticker}${priceTxt}${confTxt}`,
          tag: `trade-${trade.id}`,
          haptic: 'light',
        });
      } else if (trade.status === 'settled' || trade.status?.startsWith('sold-')) {
        const pnl = trade.realizedPnL ?? 0;
        const won = pnl > 0;
        const sign = won ? '+' : '';
        const msg = `${trade.title ?? trade.ticker}: ${sign}$${Math.abs(pnl).toFixed(2)}`;
        if (won) toast.success(`✅ Win — ${msg}`); else toast.error(`❌ Loss — ${msg}`);
        notify(won ? '✅ Win' : '❌ Loss', {
          body: msg,
          tag: `settle-${trade.id}`,
          haptic: won ? 'success' : 'error',
        });
      }

      // Refresh stats in the background (cheap)
      api.getStats().then(s => mountedRef.current && setStats(s)).catch(() => {});
    },
    onControl: (state: any) => {
      setControl({ ...DEFAULT_CONTROL, ...state });
      if (state.paused) {
        toast.warning('Bot paused');
        buzz('light');
      } else {
        toast.success('Bot resumed');
      }
    },
  });

  return (
    <ArborContext.Provider value={{
      trades, positions, stats, snapshots, control,
      loading, refreshing, error, connected, realtime, lastRefresh,
      refresh, refreshControl,
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
