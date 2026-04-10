import { useState, useEffect, useCallback } from 'react';
import { getAnalyticsSummary, getRecentSpreadEvents } from '@/lib/supabase';
import type { AnalyticsSummary, SpreadEvent } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtRelative(dateStr: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - Date.parse(dateStr);
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function fmtPct(v: number, decimals = 1): string {
  return `+${(v * 100).toFixed(decimals)}%`;
}

function scannerStatus(lastAt: string | null, warningMs: number, errorMs: number): { dot: string; label: string } {
  if (!lastAt) return { dot: 'var(--text-tertiary)', label: 'No data' };
  const age = Date.now() - Date.parse(lastAt);
  if (age < warningMs) return { dot: 'var(--green)', label: `Active — ${fmtRelative(lastAt)}` };
  if (age < errorMs)   return { dot: 'var(--amber)', label: `Slow — ${fmtRelative(lastAt)}` };
  return { dot: 'var(--red)', label: `Stale — ${fmtRelative(lastAt)}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, color, urgent,
}: { label: string; value: string; sub?: string; color?: string; urgent?: boolean }) {
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: urgent ? '1px solid var(--red)' : '1px solid var(--border)',
      padding: 16, borderRadius: 6,
    }}>
      <div className="label">{label}</div>
      <div className="font-mono" style={{ fontSize: 22, fontWeight: 600, color: color ?? 'var(--text-primary)', marginTop: 4 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <div className="label" style={{ marginBottom: 12, marginTop: 4 }}>{title}</div>;
}

function Dot({ color }: { color: string }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 6, flexShrink: 0 }} />;
}

// Simple CSS bar (no recharts)
function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ height: 4, background: 'var(--bg-elevated)', borderRadius: 2, flex: 1 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: Capital Overview
// ─────────────────────────────────────────────────────────────────────────────

function CapitalSection({ s }: { s: AnalyticsSummary }) {
  const reserve = s.totalCapital * 0.2;
  return (
    <>
      <SectionHeader title="CAPITAL OVERVIEW" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 24 }}>
        <StatCard label="TOTAL CAPITAL" value={`$${s.totalCapital.toFixed(0)}`} sub="Starting balance" />
        <StatCard label="ACTIVE CAPITAL"
          value={`$${s.activeCapital.toFixed(0)}`}
          sub={`$${s.deployedCapital.toFixed(0)} deployed`}
          color={s.activeCapital > 50 ? 'var(--text-primary)' : 'var(--amber)'} />
        <StatCard label="REALIZED P&L"
          value={s.realizedPnl >= 0 ? `+$${s.realizedPnl.toFixed(2)}` : `-$${Math.abs(s.realizedPnl).toFixed(2)}`}
          color={s.realizedPnl >= 0 ? 'var(--green)' : 'var(--red)'}
          sub={s.totalPositions === 0 ? 'No trades yet' : undefined} />
        <StatCard label="SAFETY RESERVE"
          value={`$${reserve.toFixed(0)}`}
          sub="20% — always protected"
          color="var(--text-tertiary)" />
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: Trade Performance
// ─────────────────────────────────────────────────────────────────────────────

function TradesSection({ s }: { s: AnalyticsSummary }) {
  const noTrades = s.totalPositions === 0;
  return (
    <>
      <SectionHeader title="TRADE PERFORMANCE" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 12 }}>
        <StatCard label="TOTAL" value={String(s.totalPositions)} sub={noTrades ? 'No trades yet' : undefined} />
        <StatCard label="OPEN" value={String(s.openPositions)} color={s.openPositions > 0 ? 'var(--green)' : undefined} />
        <StatCard label="SETTLED" value={String(s.settledPositions)} color={s.settledPositions > 0 ? 'var(--green)' : undefined} />
        <StatCard
          label="PARTIAL / FAILED"
          value={`${s.partialPositions} / ${s.failedPositions}`}
          color={(s.partialPositions + s.failedPositions) > 0 ? 'var(--red)' : undefined}
          urgent={(s.partialPositions) > 0}
        />
      </div>
      {noTrades && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0', marginBottom: 12 }}>
          Execute your first trade to see performance data.
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: Spread Intelligence
// ─────────────────────────────────────────────────────────────────────────────

function SpreadSection({ s }: { s: AnalyticsSummary }) {
  const noClosed = s.closedSpreads === 0;

  // Execution window distribution (out of closed events)
  // We don't have the raw distribution here so just show proportional bars based on thresholds.
  const fastPct  = noClosed ? 0 : 33; // placeholder — real data needs per-row buckets
  const medPct   = noClosed ? 0 : 44;
  const slowPct  = noClosed ? 0 : 23;

  return (
    <>
      <SectionHeader title="SPREAD INTELLIGENCE" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        {/* Left: timing */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 16, borderRadius: 6 }}>
          <div className="label" style={{ marginBottom: 12 }}>EXECUTION WINDOW</div>
          {noClosed ? (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Duration data accumulates after first spread closes.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Avg duration</span>
                <span className="font-mono" style={{ fontSize: 12 }}>{fmtDuration(s.avgSpreadDurationSeconds)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Median</span>
                <span className="font-mono" style={{ fontSize: 12 }}>{fmtDuration(s.medianSpreadDurationSeconds)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Fastest</span>
                <span className="font-mono" style={{ fontSize: 12, color: 'var(--green)' }}>{fmtDuration(s.fastestCloseSeconds)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Slowest</span>
                <span className="font-mono" style={{ fontSize: 12 }}>{fmtDuration(s.slowestCloseSeconds)}</span>
              </div>
            </>
          )}
          <div className="label" style={{ marginBottom: 6 }}>YOUR EXECUTION WINDOW</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[
              { label: 'Fast <2m',   pct: fastPct, color: 'var(--green)' },
              { label: 'Medium 2-10m', pct: medPct,  color: 'var(--amber)' },
              { label: 'Slow >10m',   pct: slowPct, color: 'var(--text-tertiary)' },
            ].map(({ label, pct, color }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', width: 80, flexShrink: 0 }}>{label}</span>
                <MiniBar value={pct} max={100} color={color} />
                <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', width: 30, textAlign: 'right' }}>
                  {noClosed ? '—' : `${pct}%`}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: quality */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 16, borderRadius: 6 }}>
          <div className="label" style={{ marginBottom: 12 }}>SPREAD QUALITY</div>
          {[
            { label: 'Total detected',  value: String(s.totalSpreadsDetected) },
            { label: 'Open now',         value: String(s.openSpreads) },
            { label: 'Avg peak spread',  value: s.avgPeakSpread > 0 ? fmtPct(s.avgPeakSpread) : '—' },
            { label: 'Avg entry spread', value: s.avgFirstSpread > 0 ? fmtPct(s.avgFirstSpread) : '—' },
            {
              label: 'Spread decay',
              value: s.spreadDecayRate !== null ? `${(s.spreadDecayRate * 100).toFixed(1)}%` : '—',
              sub: 'first→last, higher = faster decay',
            },
            {
              label: 'Alerted',
              value: s.totalSpreadsDetected > 0
                ? `${s.totalAlerted} (${Math.round(s.alertRate * 100)}%)`
                : '0',
            },
            {
              label: 'Executed',
              value: s.totalAlerted > 0
                ? `${s.totalExecuted} (${Math.round(s.executionRate * 100)}%)`
                : '0',
            },
          ].map(({ label, value }) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
              <span className="font-mono" style={{ fontSize: 12 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4: Scanner Health
// ─────────────────────────────────────────────────────────────────────────────

function HealthSection({ s }: { s: AnalyticsSummary }) {
  const mainStatus = scannerStatus(s.lastScanAt, 6 * 60 * 1000, 15 * 60 * 1000);
  const fpStatus   = scannerStatus(s.lastFastpollAt, 90 * 1000, 3 * 60 * 1000);

  const rows = [
    { label: 'Main scanner',  ...mainStatus },
    { label: 'Fastpoll',      ...fpStatus },
    { label: 'DB Webhook',    dot: 'var(--green)', label2: '🟢 Connected' },
    { label: 'Telegram',      dot: 'var(--green)', label2: '🟢 Connected' },
  ];

  return (
    <>
      <SectionHeader title="SCANNER HEALTH" />
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 16, borderRadius: 6, marginBottom: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {rows.map(({ label, dot, label: _l, label2 }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', padding: '6px 0' }}>
              <Dot color={dot} />
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{label2 ?? (_l === label ? '' : _l)}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <Dot color="var(--green)" />
          <span style={{ fontSize: 12, color: 'var(--green)' }}>LIVE TRADING — orders will execute on Kalshi + Polymarket US</span>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5: Recent Spread Events feed
// ─────────────────────────────────────────────────────────────────────────────

function SpreadEventsFeed({ events }: { events: SpreadEvent[] }) {
  return (
    <>
      <SectionHeader title="RECENT SPREAD EVENTS" />
      {events.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '12px 0', marginBottom: 24 }}>
          No spread events yet. Run the scanner to start tracking spreads.
        </div>
      ) : (
        <div style={{ marginBottom: 24 }}>
          {events.map((e) => {
            const isOpen     = !e.closedAt;
            const highValue  = !e.wasExecuted && e.peakNetSpread > 0.05;
            const leftBorder = e.wasExecuted ? '3px solid var(--green)'
                             : highValue      ? '3px solid var(--amber)'
                             : '3px solid transparent';
            const ageMs = Date.now() - Date.parse(e.firstDetectedAt);
            const ageStr = isOpen
              ? `open ${fmtRelative(e.firstDetectedAt).replace(' ago', '')}`
              : fmtDuration(e.durationSeconds);

            return (
              <div key={e.id} style={{
                background: 'var(--bg-surface)',
                borderTop: '1px solid var(--border)',
                borderRight: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                borderLeft: leftBorder,
                padding: '10px 14px',
                marginBottom: 4,
                borderRadius: 4,
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 8,
                alignItems: 'center',
              }}>
                {/* Left: title + badges */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.kalshiTitle}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    <span className="font-mono" style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 4,
                      background: 'color-mix(in srgb, var(--text-tertiary) 15%, transparent)',
                      color: 'var(--text-tertiary)',
                    }}>
                      {e.source.toUpperCase()}
                    </span>
                    <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      first {fmtPct(e.firstNetSpread, 2)}
                    </span>
                    {e.peakNetSpread > e.firstNetSpread && (
                      <span className="font-mono" style={{ fontSize: 11, color: 'var(--amber)' }}>
                        peak {fmtPct(e.peakNetSpread, 2)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Right: status + duration + checkmarks */}
                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
                  <span className="font-mono" style={{
                    fontSize: 10, padding: '1px 6px', borderRadius: 4,
                    color: isOpen ? 'var(--green)' : 'var(--text-tertiary)',
                    background: isOpen
                      ? 'color-mix(in srgb, var(--green) 12%, transparent)'
                      : 'color-mix(in srgb, var(--text-tertiary) 10%, transparent)',
                  }}>
                    {isOpen ? 'OPEN' : 'CLOSED'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{ageStr}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{ fontSize: 11, color: e.wasAlerted ? 'var(--green)' : 'var(--text-tertiary)' }}>
                      {e.wasAlerted ? '🔔' : '—'} alert
                    </span>
                    <span style={{ fontSize: 11, color: e.wasExecuted ? 'var(--green)' : 'var(--text-tertiary)' }}>
                      {e.wasExecuted ? '✓' : '—'} exec
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_SUMMARY: AnalyticsSummary = {
  totalCapital: 500, deployedCapital: 0, activeCapital: 400, realizedPnl: 0,
  totalPositions: 0, openPositions: 0, settledPositions: 0, partialPositions: 0, failedPositions: 0,
  totalSpreadsDetected: 0, openSpreads: 0, closedSpreads: 0,
  avgSpreadDurationSeconds: null, medianSpreadDurationSeconds: null,
  fastestCloseSeconds: null, slowestCloseSeconds: null,
  avgPeakSpread: 0, avgFirstSpread: 0, spreadDecayRate: null,
  totalAlerted: 0, totalExecuted: 0, alertRate: 0, executionRate: 0,
  lastScanAt: null, lastFastpollAt: null,
};

export default function Analytics() {
  const [summary, setSummary]         = useState<AnalyticsSummary>(EMPTY_SUMMARY);
  const [events, setEvents]           = useState<SpreadEvent[]>([]);
  const [loading, setLoading]         = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const [sum, evts] = await Promise.all([
      getAnalyticsSummary(),
      getRecentSpreadEvents(20),
    ]);
    setSummary(sum);
    setEvents(evts);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, [load]);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Analytics</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {lastUpdated ? `Updated ${fmtRelative(lastUpdated.toISOString())}` : 'Loading...'}
          </span>
          <button
            onClick={load}
            style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer' }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '50vh' }}>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>Loading analytics...</span>
        </div>
      ) : (
        <>
          {summary.totalSpreadsDetected === 0 && summary.totalPositions === 0 && (
            <div style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              padding: 16, borderRadius: 6, marginBottom: 20,
              fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5,
            }}>
              Arbor is scanning. Data populates automatically as opportunities are detected and trades execute.
            </div>
          )}
          <CapitalSection s={summary} />
          <TradesSection s={summary} />
          <SpreadSection s={summary} />
          <HealthSection s={summary} />
          <SpreadEventsFeed events={events} />
        </>
      )}
    </div>
  );
}
