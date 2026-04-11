import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import config from '@/config';
import type { AnalyticsSummary, CapitalState, ResolutionVerdict, SpreadEvent } from '@/types';

export const supabase: SupabaseClient | null = config.supabase.url
  ? createClient(config.supabase.url, config.supabase.anonKey)
  : null;

let warned = false;

export function safeSupabase(): SupabaseClient | null {
  if (!supabase) {
    if (!warned) {
      console.warn('[supabase] Not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
      warned = true;
    }
    return null;
  }
  return supabase;
}

export interface UpsertMarketPairInput {
  kalshiMarketId: string;
  kalshiTitle: string;
  kalshiResolutionCriteria?: string;
  polyMarketId: string;
  polyTitle: string;
  polyResolutionCriteria?: string;
  verdict: ResolutionVerdict;
  verdictReasoning?: string;
  riskFactors?: string[];
  matchScore: number;
}

export async function upsertMarketPair(
  data: UpsertMarketPairInput,
): Promise<string | null> {
  const sb = safeSupabase();
  if (!sb) return null;

  const row = {
    kalshi_market_id: data.kalshiMarketId,
    kalshi_title: data.kalshiTitle,
    kalshi_resolution_criteria: data.kalshiResolutionCriteria ?? null,
    poly_market_id: data.polyMarketId,
    poly_title: data.polyTitle,
    poly_resolution_criteria: data.polyResolutionCriteria ?? null,
    resolution_verdict: data.verdict,
    verdict_reasoning: data.verdictReasoning ?? null,
    risk_factors: data.riskFactors ?? null,
    match_score: data.matchScore,
    last_verified_at: new Date().toISOString(),
  };

  const { data: result, error } = await sb
    .from('market_pairs')
    .upsert(row, { onConflict: 'kalshi_market_id,poly_market_id' })
    .select('id')
    .single();

  if (error) {
    console.error('[supabase] upsertMarketPair failed', error);
    return null;
  }
  return (result?.id as string | undefined) ?? null;
}

export interface CachedVerdict {
  id: string;
  verdict: ResolutionVerdict;
  reasoning?: string;
}

export async function getCachedVerdict(
  kalshiId: string,
  polyId: string,
): Promise<CachedVerdict | null> {
  const sb = safeSupabase();
  if (!sb) return null;

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from('market_pairs')
    .select('id, resolution_verdict, verdict_reasoning, last_verified_at')
    .eq('kalshi_market_id', kalshiId)
    .eq('poly_market_id', polyId)
    .gt('last_verified_at', cutoff)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[supabase] getCachedVerdict failed', error);
    return null;
  }
  if (!data) return null;

  return {
    id: data.id as string,
    verdict: data.resolution_verdict as ResolutionVerdict,
    reasoning: (data.verdict_reasoning as string | null) ?? undefined,
  };
}

export interface SpreadLogInput {
  polyYesPrice: number;
  polyNoPrice: number;
  kalshiYesPrice: number;
  kalshiNoPrice: number;
  rawSpread: number;
  estimatedFees: number;
  netSpread: number;
  availableQuantity: number;
  maxProfitDollars: number;
}

export async function logSpread(
  pairId: string,
  data: SpreadLogInput,
): Promise<void> {
  const sb = safeSupabase();
  if (!sb) return;

  const { error } = await sb.from('spread_logs').insert({
    pair_id: pairId,
    poly_yes_price: data.polyYesPrice,
    poly_no_price: data.polyNoPrice,
    kalshi_yes_price: data.kalshiYesPrice,
    kalshi_no_price: data.kalshiNoPrice,
    raw_spread: data.rawSpread,
    estimated_fees: data.estimatedFees,
    net_spread: data.netSpread,
    available_quantity: data.availableQuantity,
    max_profit_dollars: data.maxProfitDollars,
  });

  if (error) {
    console.error('[supabase] logSpread failed', error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Positions
// ─────────────────────────────────────────────────────────────────────────────

export interface Position {
  id: string;
  kalshiTitle: string;
  polyTitle: string;
  kalshiMarketId: string | null;
  polyMarketId: string | null;
  status: 'pending' | 'open' | 'partial' | 'settled' | 'cancelled' | 'failed';
  intendedKalshiSide: string | null;
  intendedPolySide: string | null;
  kalshiFillPrice: number | null;
  polyFillPrice: number | null;
  kalshiFillQuantity: number | null;
  polyFillQuantity: number | null;
  kalshiOrderId: string | null;
  polyOrderId: string | null;
  executedAt: string | null;
  createdAt: string;
  opportunityId: string | null;
}

export async function getPositions(): Promise<Position[]> {
  const sb = safeSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from('positions')
    .select(
      'id, kalshi_title, poly_title, kalshi_market_id, poly_market_id, ' +
      'status, intended_kalshi_side, intended_poly_side, ' +
      'kalshi_fill_price, poly_fill_price, kalshi_fill_quantity, poly_fill_quantity, ' +
      'kalshi_order_id, poly_order_id, executed_at, opened_at, opportunity_id',
    )
    .order('opened_at', { ascending: false });

  if (error) {
    console.error('[supabase] getPositions failed', error);
    return [];
  }

  return (data ?? []).map((r) => ({
    id: r.id as string,
    kalshiTitle: (r.kalshi_title as string | null) ?? '',
    polyTitle: (r.poly_title as string | null) ?? '',
    kalshiMarketId: (r.kalshi_market_id as string | null) ?? null,
    polyMarketId: (r.poly_market_id as string | null) ?? null,
    status: (r.status as Position['status']) ?? 'pending',
    intendedKalshiSide: (r.intended_kalshi_side as string | null) ?? null,
    intendedPolySide: (r.intended_poly_side as string | null) ?? null,
    kalshiFillPrice: (r.kalshi_fill_price as number | null) ?? null,
    polyFillPrice: (r.poly_fill_price as number | null) ?? null,
    kalshiFillQuantity: (r.kalshi_fill_quantity as number | null) ?? null,
    polyFillQuantity: (r.poly_fill_quantity as number | null) ?? null,
    kalshiOrderId: (r.kalshi_order_id as string | null) ?? null,
    polyOrderId: (r.poly_order_id as string | null) ?? null,
    executedAt: (r.executed_at as string | null) ?? null,
    createdAt: (r.opened_at as string) ?? new Date().toISOString(),
    opportunityId: (r.opportunity_id as string | null) ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────────────────────────────────────

export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const sb = safeSupabase();
  const defaults: AnalyticsSummary = {
    totalCapital: 0, deployedCapital: 0, activeCapital: 0, realizedPnl: 0,
    totalPositions: 0, openPositions: 0, settledPositions: 0, partialPositions: 0, failedPositions: 0,
    totalSpreadsDetected: 0, openSpreads: 0, closedSpreads: 0,
    avgSpreadDurationSeconds: null, medianSpreadDurationSeconds: null,
    fastestCloseSeconds: null, slowestCloseSeconds: null,
    avgPeakSpread: 0, avgFirstSpread: 0, spreadDecayRate: null,
    totalAlerted: 0, totalExecuted: 0, alertRate: 0, executionRate: 0,
    lastScanAt: null, lastFastpollAt: null,
  };
  if (!sb) return defaults;

  const [capitalRes, positionsRes, spreadEventsRes, lastScanRes, lastFastpollRes] =
    await Promise.allSettled([
      sb.from('capital_ledger')
        .select('total_capital,deployed_capital,safety_reserve_pct,realized_pnl')
        .order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      sb.from('positions').select('status,kalshi_fill_price,poly_fill_price,kalshi_fill_quantity'),
      sb.from('spread_events').select('*').order('first_detected_at', { ascending: false }).limit(200),
      sb.from('scan_results').select('scanned_at').order('scanned_at', { ascending: false }).limit(1).maybeSingle(),
      sb.from('known_game_markets').select('last_checked_at').order('last_checked_at', { ascending: false }).limit(1).maybeSingle(),
    ]);

  // Capital
  let totalCapital = 0, deployedCapital = 0, safetyReservePct = 0.2, realizedPnl = 0;
  if (capitalRes.status === 'fulfilled' && capitalRes.value.data) {
    const c = capitalRes.value.data as Record<string, number | null>;
    totalCapital    = (c.total_capital    as number) ?? 0;
    deployedCapital = (c.deployed_capital as number) ?? 0;
    safetyReservePct = (c.safety_reserve_pct as number) ?? 0.2;
    realizedPnl     = (c.realized_pnl     as number) ?? 0;
  } else if (capitalRes.status === 'fulfilled' && !capitalRes.value.data) {
    // No capital_ledger row exists — insert a default so the dashboard shows real values.
    // $291 = Kalshi ~$191 + Polymarket ~$100 starting capital.
    sb.from('capital_ledger').insert({
      total_capital: 291,
      deployed_capital: 0,
      safety_reserve_pct: 0.10,
      realized_pnl: 0,
    }).catch(() => {/* anon key may not have insert rights — silent */});
    totalCapital = 291;
    safetyReservePct = 0.10;
  }
  const activeCapital = totalCapital * (1 - safetyReservePct) - deployedCapital + realizedPnl;

  // Positions
  let totalPositions = 0, openPositions = 0, settledPositions = 0, partialPositions = 0, failedPositions = 0;
  if (positionsRes.status === 'fulfilled') {
    const rows = (positionsRes.value.data ?? []) as Array<Record<string, unknown>>;
    totalPositions = rows.length;
    for (const r of rows) {
      const s = r.status as string;
      if (s === 'open' || s === 'pending') openPositions++;
      else if (s === 'settled') settledPositions++;
      else if (s === 'partial') partialPositions++;
      else if (s === 'failed') failedPositions++;
    }
  }

  // Spread events
  let totalSpreadsDetected = 0, openSpreads = 0, closedSpreads = 0;
  let avgSpreadDurationSeconds: number | null = null, medianSpreadDurationSeconds: number | null = null;
  let fastestCloseSeconds: number | null = null, slowestCloseSeconds: number | null = null;
  let avgPeakSpread = 0, avgFirstSpread = 0, spreadDecayRate: number | null = null;
  let totalAlerted = 0, totalExecuted = 0;

  if (spreadEventsRes.status === 'fulfilled') {
    const rows = (spreadEventsRes.value.data ?? []) as Array<Record<string, unknown>>;
    totalSpreadsDetected = rows.length;
    totalAlerted  = rows.filter(r => r.was_alerted).length;
    totalExecuted = rows.filter(r => r.was_executed).length;
    openSpreads   = rows.filter(r => !r.closed_at).length;
    closedSpreads = rows.filter(r => r.closed_at).length;

    const durations = rows
      .filter(r => r.duration_seconds !== null && (r.duration_seconds as number) > 0)
      .map(r => r.duration_seconds as number)
      .sort((a, b) => a - b);
    if (durations.length > 0) {
      avgSpreadDurationSeconds    = Math.round(durations.reduce((s, v) => s + v, 0) / durations.length);
      medianSpreadDurationSeconds = durations[Math.floor(durations.length / 2)];
      fastestCloseSeconds         = durations[0];
      slowestCloseSeconds         = durations[durations.length - 1];
    }
    const peakSpreads  = rows.filter(r => (r.peak_net_spread  as number) > 0).map(r => r.peak_net_spread  as number);
    const firstSpreads = rows.filter(r => (r.first_net_spread as number) > 0).map(r => r.first_net_spread as number);
    if (peakSpreads.length)  avgPeakSpread  = peakSpreads.reduce((s, v) => s + v, 0) / peakSpreads.length;
    if (firstSpreads.length) avgFirstSpread = firstSpreads.reduce((s, v) => s + v, 0) / firstSpreads.length;

    const decayRates = rows
      .filter(r => (r.first_net_spread as number) > 0 && r.last_net_spread !== null)
      .map(r => ((r.first_net_spread as number) - (r.last_net_spread as number)) / (r.first_net_spread as number));
    if (decayRates.length > 0) {
      spreadDecayRate = decayRates.reduce((s, v) => s + v, 0) / decayRates.length;
    }
  }

  const lastScanAt = (lastScanRes.status === 'fulfilled' && lastScanRes.value.data)
    ? (lastScanRes.value.data as Record<string, string>).scanned_at
    : null;
  const lastFastpollAt = (lastFastpollRes.status === 'fulfilled' && lastFastpollRes.value.data)
    ? (lastFastpollRes.value.data as Record<string, string>).last_checked_at
    : null;

  return {
    totalCapital, deployedCapital, activeCapital, realizedPnl,
    totalPositions, openPositions, settledPositions, partialPositions, failedPositions,
    totalSpreadsDetected, openSpreads, closedSpreads,
    avgSpreadDurationSeconds, medianSpreadDurationSeconds,
    fastestCloseSeconds, slowestCloseSeconds,
    avgPeakSpread, avgFirstSpread, spreadDecayRate,
    totalAlerted, totalExecuted,
    alertRate:     totalSpreadsDetected > 0 ? totalAlerted  / totalSpreadsDetected : 0,
    executionRate: totalAlerted          > 0 ? totalExecuted / totalAlerted         : 0,
    lastScanAt, lastFastpollAt,
  };
}

export async function getRecentSpreadEvents(limit = 20): Promise<SpreadEvent[]> {
  const sb = safeSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from('spread_events')
    .select('*')
    .order('first_detected_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('[supabase] getRecentSpreadEvents failed', error); return []; }
  return (data ?? []).map((r) => ({
    id:               r.id as string,
    pairId:           r.pair_id as string,
    kalshiMarketId:   r.kalshi_market_id as string,
    polyMarketId:     r.poly_market_id as string,
    kalshiTitle:      r.kalshi_title as string,
    firstDetectedAt:  r.first_detected_at as string,
    lastSeenAt:       r.last_seen_at as string,
    firstNetSpread:   r.first_net_spread as number,
    peakNetSpread:    r.peak_net_spread as number,
    lastNetSpread:    r.last_net_spread as number,
    scanCount:        r.scan_count as number,
    closedAt:         r.closed_at as string | null,
    durationSeconds:  r.duration_seconds as number | null,
    wasAlerted:       (r.was_alerted as boolean) ?? false,
    wasExecuted:      (r.was_executed as boolean) ?? false,
    closingReason:    r.closing_reason as string | null,
    source:           r.source as 'scanner' | 'fastpoll',
  }));
}

const DEFAULT_CAPITAL: CapitalState = {
  totalCapital: 0,
  deployedCapital: 0,
  safetyReservePct: 0.2,
  realizedPnl: 0,
  activeCapital: 0,
};

function computeActiveCapital(
  totalCapital: number,
  safetyReservePct: number,
  deployedCapital: number,
  realizedPnl: number,
): number {
  return totalCapital * (1 - safetyReservePct) - deployedCapital + realizedPnl;
}

export async function getCapital(): Promise<CapitalState> {
  const sb = safeSupabase();
  if (!sb) return DEFAULT_CAPITAL;

  const { data, error } = await sb
    .from('capital_ledger')
    .select('total_capital, deployed_capital, safety_reserve_pct, realized_pnl')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[supabase] getCapital failed', error);
    return DEFAULT_CAPITAL;
  }
  if (!data) return DEFAULT_CAPITAL;

  const totalCapital = (data.total_capital as number | null) ?? 0;
  const deployedCapital = (data.deployed_capital as number | null) ?? 0;
  const safetyReservePct = (data.safety_reserve_pct as number | null) ?? 0.2;
  const realizedPnl = (data.realized_pnl as number | null) ?? 0;

  return {
    totalCapital,
    deployedCapital,
    safetyReservePct,
    realizedPnl,
    activeCapital: computeActiveCapital(
      totalCapital,
      safetyReservePct,
      deployedCapital,
      realizedPnl,
    ),
  };
}
