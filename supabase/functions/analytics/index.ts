// analytics — returns spread persistence statistics from spread_events.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

serve(async () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) {
    return new Response('missing env', { status: 500 });
  }
  const sb = createClient(supabaseUrl, serviceKey);

  // Fetch all closed spread events.
  const { data: closed, error: closedErr } = await sb
    .from('spread_events')
    .select('*')
    .not('closed_at', 'is', null)
    .order('first_detected_at', { ascending: false });
  if (closedErr) {
    return new Response(JSON.stringify({ error: closedErr.message }), { status: 500 });
  }

  // Fetch open events.
  const { data: open } = await sb
    .from('spread_events')
    .select('*')
    .is('closed_at', null)
    .order('first_detected_at', { ascending: false });

  const all = [...(closed ?? []), ...(open ?? [])];

  // Duration stats (closed events only).
  const durations: number[] = (closed ?? [])
    .map((r: any) => r.duration_seconds as number | null)
    .filter((d): d is number => d !== null && d > 0);

  durations.sort((a, b) => a - b);

  const avg    = durations.length > 0
    ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length)
    : null;
  const median = durations.length > 0
    ? durations[Math.floor(durations.length / 2)]
    : null;
  const fastest = durations.length > 0 ? durations[0] : null;
  const slowest = durations.length > 0 ? durations[durations.length - 1] : null;

  const total    = all.length;
  const alerted  = all.filter((r: any) => r.was_alerted).length;
  const executed = all.filter((r: any) => r.was_executed).length;

  // Spread decay: average of (first - last) / first for closed events with positive first.
  const decayRates = (closed ?? [])
    .filter((r: any) => r.first_net_spread > 0 && r.last_net_spread !== null)
    .map((r: any) => (r.first_net_spread - r.last_net_spread) / r.first_net_spread);
  const avgDecay = decayRates.length > 0
    ? decayRates.reduce((s, v) => s + v, 0) / decayRates.length
    : null;

  const peaks = all
    .filter((r: any) => r.peak_net_spread > 0)
    .map((r: any) => r.peak_net_spread as number);
  const avgPeak = peaks.length > 0
    ? peaks.reduce((s, v) => s + v, 0) / peaks.length
    : null;

  const firsts = all
    .filter((r: any) => r.first_net_spread > 0)
    .map((r: any) => r.first_net_spread as number);
  const avgFirst = firsts.length > 0
    ? firsts.reduce((s, v) => s + v, 0) / firsts.length
    : null;

  // By source.
  const bySource: Record<string, { count: number; avgDuration: number | null }> = {};
  for (const src of ['scanner', 'fastpoll']) {
    const srcDurs = (closed ?? [])
      .filter((r: any) => r.source === src)
      .map((r: any) => r.duration_seconds as number | null)
      .filter((d): d is number => d !== null && d > 0);
    bySource[src] = {
      count: all.filter((r: any) => r.source === src).length,
      avgDuration: srcDurs.length > 0
        ? Math.round(srcDurs.reduce((s, v) => s + v, 0) / srcDurs.length)
        : null,
    };
  }

  // What % of closed spreads closed before any alert fired.
  const alertToCloseRatio = total > 0 ? alerted / total : 0;

  const recentEvents = [...all]
    .sort((a: any, b: any) =>
      Date.parse(b.first_detected_at) - Date.parse(a.first_detected_at))
    .slice(0, 10)
    .map((r: any) => ({
      pairId:           r.pair_id,
      kalshiTitle:      r.kalshi_title,
      source:           r.source,
      firstDetectedAt:  r.first_detected_at,
      firstNetSpread:   Number((r.first_net_spread as number).toFixed(4)),
      peakNetSpread:    Number((r.peak_net_spread  as number).toFixed(4)),
      lastNetSpread:    Number((r.last_net_spread  as number).toFixed(4)),
      durationSeconds:  r.duration_seconds,
      closedAt:         r.closed_at,
      wasAlerted:       r.was_alerted,
      wasExecuted:      r.was_executed,
      closingReason:    r.closing_reason,
    }));

  const result = {
    avgSpreadDurationSeconds:    avg,
    medianSpreadDurationSeconds: median,
    fastestClosedSeconds:        fastest,
    slowestClosedSeconds:        slowest,
    totalSpreadsDetected:        total,
    totalSpreadsAlerted:         alerted,
    totalSpreadsExecuted:        executed,
    alertToCloseRatio:           Number((alertToCloseRatio * 100).toFixed(1)),
    avgPeakSpread:               avgPeak !== null ? Number((avgPeak * 100).toFixed(2)) : null,
    avgFirstSpread:              avgFirst !== null ? Number((avgFirst * 100).toFixed(2)) : null,
    spreadDecayRate:             avgDecay !== null ? Number((avgDecay * 100).toFixed(1)) : null,
    openSpreads:                 (open ?? []).length,
    bySource,
    recentEvents,
  };

  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
});
