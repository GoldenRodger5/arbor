import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import config from '@/config';
import type { CapitalState, ResolutionVerdict } from '@/types';

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

const DEFAULT_CAPITAL: CapitalState = {
  totalCapital: 500,
  deployedCapital: 0,
  safetyReservePct: 0.2,
  realizedPnl: 0,
  activeCapital: 500,
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

  const totalCapital = (data.total_capital as number | null) ?? 500;
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
