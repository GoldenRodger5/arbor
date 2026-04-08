import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ArbitrageOpportunity,
  CapitalState,
  ScannerConfig,
  ScannerStats,
} from '@/types';
import { getLatestScanResult, startScanner, triggerScan } from '@/lib/scanner';
import { getCapital } from '@/lib/supabase';

const defaultStats: ScannerStats = {
  kalshiCount: 0,
  polyCount: 0,
  matchedCount: 0,
  opportunityCount: 0,
  lastScanAt: null,
  isScanning: false,
};

const defaultConfig: ScannerConfig = {
  intervalSeconds: 60,
  minNetSpread: 0.02,
};

const defaultCapital: CapitalState = {
  totalCapital: 500,
  deployedCapital: 0,
  safetyReservePct: 0.2,
  realizedPnl: 0,
  activeCapital: 500,
};

interface ScannerContextValue {
  opportunities: ArbitrageOpportunity[];
  stats: ScannerStats;
  config: ScannerConfig;
  capital: CapitalState;
  refresh: () => Promise<void>;
  trigger: () => Promise<{ ok: boolean; error?: string }>;
  triggering: boolean;
  updateConfig: (patch: Partial<ScannerConfig>) => void;
}

const ScannerContext = createContext<ScannerContextValue | null>(null);

export function ScannerProvider({ children }: { children: ReactNode }) {
  const [opportunities, setOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [stats, setStats] = useState<ScannerStats>(defaultStats);
  const [config, setConfig] = useState<ScannerConfig>(defaultConfig);
  const [capital, setCapital] = useState<CapitalState>(defaultCapital);
  const [triggering, setTriggering] = useState(false);

  const cleanupRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    const result = await getLatestScanResult();
    setOpportunities(result.opportunities);
    setStats(result.stats);
  }, []);

  const trigger = useCallback(async () => {
    setTriggering(true);
    try {
      const result = await triggerScan();
      // Refresh shortly after the function returns so the new row is visible.
      if (result.ok) {
        setTimeout(() => {
          refresh().catch(() => {});
        }, 3000);
      }
      return result;
    } finally {
      setTriggering(false);
    }
  }, [refresh]);

  const updateConfig = useCallback((patch: Partial<ScannerConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  // Load capital on mount.
  useEffect(() => {
    let active = true;
    getCapital()
      .then((c) => {
        if (active) setCapital(c);
      })
      .catch((err) => {
        console.error('[scanner-context] getCapital failed', err);
      });
    return () => {
      active = false;
    };
  }, []);

  // Start polling Supabase on mount; tear down on unmount.
  useEffect(() => {
    cleanupRef.current = startScanner(config, (result) => {
      setOpportunities(result.opportunities);
      setStats(result.stats);
    });
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: ScannerContextValue = {
    opportunities,
    stats,
    config,
    capital,
    refresh,
    trigger,
    triggering,
    updateConfig,
  };

  return (
    <ScannerContext.Provider value={value}>{children}</ScannerContext.Provider>
  );
}

export function useScannerContext(): ScannerContextValue {
  const ctx = useContext(ScannerContext);
  if (!ctx) {
    throw new Error('useScannerContext must be used within a ScannerProvider');
  }
  return ctx;
}
