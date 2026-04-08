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
import { startScanner } from '@/lib/scanner';
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
  startScan: () => void;
  stopScan: () => void;
  updateConfig: (patch: Partial<ScannerConfig>) => void;
}

const ScannerContext = createContext<ScannerContextValue | null>(null);

export function ScannerProvider({ children }: { children: ReactNode }) {
  const [opportunities, setOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [stats, setStats] = useState<ScannerStats>(defaultStats);
  const [config, setConfig] = useState<ScannerConfig>(defaultConfig);
  const [capital, setCapital] = useState<CapitalState>(defaultCapital);

  const cleanupRef = useRef<(() => void) | null>(null);
  const configRef = useRef<ScannerConfig>(defaultConfig);
  configRef.current = config;

  const startScan = useCallback(() => {
    if (cleanupRef.current) return; // already scanning
    setStats((s) => ({ ...s, isScanning: true }));
    cleanupRef.current = startScanner(configRef.current, (result) => {
      setOpportunities(result.opportunities);
      setStats({ ...result.stats, isScanning: true });
    });
  }, []);

  const stopScan = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setStats((s) => ({ ...s, isScanning: false }));
  }, []);

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

  // Auto-start if Kalshi key is configured.
  useEffect(() => {
    if (import.meta.env.VITE_KALSHI_API_KEY_ID) {
      startScan();
    }
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
    startScan,
    stopScan,
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
