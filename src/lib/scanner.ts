// Frontend scanner — polls scan_results from Supabase.
// All actual scanning happens in supabase/functions/scanner (cron-driven).
// The browser never calls Kalshi, Polymarket, or Anthropic directly.

import type {
  ArbitrageOpportunity,
  ScannerConfig,
  ScannerStats,
} from '@/types';
import { safeSupabase } from './supabase';

const POLL_INTERVAL_MS = 30_000;

const emptyStats: ScannerStats = {
  kalshiCount: 0,
  polyCount: 0,
  matchedCount: 0,
  opportunityCount: 0,
  lastScanAt: null,
  isScanning: false,
};

export interface ScanResult {
  opportunities: ArbitrageOpportunity[];
  stats: ScannerStats;
}

export async function getLatestScanResult(): Promise<ScanResult> {
  const sb = safeSupabase();
  if (!sb) return { opportunities: [], stats: emptyStats };

  const { data, error } = await sb
    .from('scan_results')
    .select(
      'opportunities, kalshi_count, poly_count, matched_count, opportunity_count, scanned_at',
    )
    .order('scanned_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[scanner] getLatestScanResult failed', error);
    return { opportunities: [], stats: emptyStats };
  }
  if (!data) return { opportunities: [], stats: emptyStats };

  const rawOpps = (data.opportunities as ArbitrageOpportunity[] | null) ?? [];
  const scannedAtMs = data.scanned_at
    ? new Date(data.scanned_at as string).getTime()
    : null;

  return {
    opportunities: rawOpps,
    stats: {
      kalshiCount: (data.kalshi_count as number | null) ?? 0,
      polyCount: (data.poly_count as number | null) ?? 0,
      matchedCount: (data.matched_count as number | null) ?? 0,
      opportunityCount: (data.opportunity_count as number | null) ?? 0,
      lastScanAt: scannedAtMs,
      isScanning: false,
    },
  };
}

export async function triggerScan(): Promise<{ ok: boolean; error?: string }> {
  const sb = safeSupabase();
  if (!sb) return { ok: false, error: 'Supabase not configured' };
  try {
    const { error } = await sb.functions.invoke('scanner');
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function startScanner(
  _config: ScannerConfig,
  onUpdate: (result: ScanResult) => void,
): () => void {
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    getLatestScanResult()
      .then((result) => {
        if (!cancelled) onUpdate(result);
      })
      .catch((err) => {
        console.error('[scanner] poll failed', err);
      });
  };
  tick();
  const id = setInterval(tick, POLL_INTERVAL_MS);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}
