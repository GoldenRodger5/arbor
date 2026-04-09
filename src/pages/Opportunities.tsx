import { useMemo, useState } from 'react';
import { opportunities as mockOpportunities, type Verdict, type Opportunity } from '@/data/mock';
import { useIsMobile } from '@/hooks/use-mobile';
import { useScannerContext } from '@/context/ScannerContext';
import type { ArbitrageOpportunity } from '@/types';

type Filter = 'ALL' | 'SAFE' | 'CAUTION';

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0 || !Number.isFinite(diff)) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function formatDays(days: number | undefined): string {
  if (days === undefined || !Number.isFinite(days)) return '—';
  if (days < 1) return '<1d';
  return `${Math.round(days)}d`;
}

function daysColor(days: number | undefined): string {
  if (days === undefined) return 'var(--text-tertiary)';
  if (days <= 7) return 'var(--green)';
  if (days <= 30) return 'var(--text-primary)';
  return 'var(--text-secondary)';
}

function formatAnnualized(annReturn: number | undefined): string {
  if (annReturn === undefined || !Number.isFinite(annReturn)) return '—';
  const pct = annReturn * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function annualizedColor(annReturn: number | undefined): string {
  if (annReturn === undefined) return 'var(--text-tertiary)';
  if (annReturn > 0.5) return 'var(--green)';
  if (annReturn >= 0.15) return 'var(--text-primary)';
  return 'var(--red)';
}

function formatCloseDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function adaptOpportunity(opp: ArbitrageOpportunity, idx: number): Opportunity {
  const best = opp.levels[0];
  const polyYesPrice = best
    ? (best.buyYesPlatform === 'polymarket' ? best.buyYesPrice : best.buyNoPrice)
    : 0;
  const kalshiNoPrice = best
    ? (best.buyNoPlatform === 'kalshi' ? best.buyNoPrice : best.buyYesPrice)
    : 0;

  // Map orderbook-derived levels (which we don't ship from the engine in v1)
  // by reusing the best arbitrage levels as a depth proxy.
  const polyDepth = opp.levels.slice(0, 4).map((l) => ({
    price: l.buyYesPlatform === 'polymarket' ? l.buyYesPrice : l.buyNoPrice,
    qty: Math.round(l.quantity),
  }));
  const kalshiDepth = opp.levels.slice(0, 4).map((l) => ({
    price: l.buyNoPlatform === 'kalshi' ? l.buyNoPrice : l.buyYesPrice,
    qty: Math.round(l.quantity),
  }));

  const verdict: Verdict = opp.verdict === 'PENDING' ? 'CAUTION' : opp.verdict;

  return {
    id: idx + 1,
    event: opp.kalshiMarket.title,
    polyYes: polyYesPrice,
    kalshiNo: kalshiNoPrice,
    rawSpread: best ? best.grossProfitPct * 100 : 0,
    netSpread: opp.bestNetSpread * 100,
    maxDollar: Math.round(opp.totalMaxProfit),
    verdict,
    scanned: formatRelative(opp.scannedAt),
    polyDepth,
    kalshiDepth,
    daysToClose: opp.daysToClose,
    annualizedReturn: opp.annualizedReturn,
    effectiveCloseDate: opp.effectiveCloseDate,
    kalshiCloseDate: opp.kalshiCloseDate,
    polyCloseDate: opp.polyCloseDate,
    polyUrl: opp.polyMarket.url,
    kalshiUrl: opp.kalshiMarket.url,
    verdictReasoning: opp.verdictReasoning,
    riskFactors: opp.riskFactors,
    kalshiYesMeaning: opp.kalshiYesMeaning,
    polyHedgeOutcomeLabel: opp.polyHedgeOutcomeLabel,
  };
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const colors: Record<Verdict, string> = {
    SAFE: 'var(--green)',
    CAUTION: 'var(--amber)',
    SKIP: 'var(--red)',
  };
  const c = colors[verdict];
  return (
    <span
      className="font-mono"
      style={{
        fontSize: 10,
        textTransform: 'uppercase',
        padding: '2px 8px',
        borderRadius: 6,
        color: c,
        background: `color-mix(in srgb, ${c} 12%, transparent)`,
      }}
    >
      {verdict}
    </span>
  );
}

function DepthBar({ label, depth }: { label: string; depth: { price: number; qty: number }[] }) {
  const maxQty = Math.max(...depth.map((d) => d.qty));
  return (
    <div style={{ flex: 1 }}>
      <div className="label" style={{ marginBottom: 8 }}>{label}</div>
      {depth.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-secondary)', width: 40 }}>
            ${d.price.toFixed(2)}
          </span>
          <div style={{ flex: 1, height: 14, background: 'var(--bg-base)', borderRadius: 2 }}>
            <div
              style={{
                width: `${(d.qty / maxQty) * 100}%`,
                height: '100%',
                background: i === 0 ? 'var(--green)' : 'var(--text-tertiary)',
                borderRadius: 2,
                opacity: 0.6,
              }}
            />
          </div>
          <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', width: 40, textAlign: 'right' }}>
            {d.qty}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Opportunities() {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const isMobile = useIsMobile();
  const {
    opportunities: ctxOpps,
    stats,
    refresh,
    trigger,
    triggering,
  } = useScannerContext();

  // Use live opportunities when available; otherwise fall back to mock data
  // until the first real scan_results row exists. Live opportunities are
  // sorted by annualized return (capital efficiency) descending — raw spread
  // is now a secondary metric.
  const opportunities = useMemo<Opportunity[]>(() => {
    if (ctxOpps.length > 0) {
      const adapted = ctxOpps.map(adaptOpportunity);
      adapted.sort((a, b) => {
        const ar = a.annualizedReturn ?? -Infinity;
        const br = b.annualizedReturn ?? -Infinity;
        return br - ar;
      });
      return adapted;
    }
    if (stats.lastScanAt === null) return mockOpportunities;
    return [];
  }, [ctxOpps, stats.lastScanAt]);

  const lastScanLabel =
    stats.lastScanAt === null
      ? 'no scans yet'
      : `updated ${formatRelative(stats.lastScanAt)}`;

  const filtered = opportunities.filter((o) => {
    if (filter === 'ALL') return true;
    return o.verdict === filter;
  });

  const liveCount = opportunities.filter((o) => o.verdict === 'SAFE' || o.verdict === 'CAUTION').length;

  const filters: Filter[] = ['ALL', 'SAFE', 'CAUTION'];

  const th: React.CSSProperties = {
    textAlign: 'left', padding: '8px', fontSize: 11, textTransform: 'uppercase',
    letterSpacing: '0.08em', color: 'var(--text-tertiary)', fontWeight: 500,
    borderBottom: '1px solid var(--border)',
  };
  const td: React.CSSProperties = { padding: '0 8px', height: 44, borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>Opportunities</h1>
        <span
          className="font-mono"
          style={{
            fontSize: 11, textTransform: 'uppercase',
            padding: '2px 10px', borderRadius: 6,
            color: 'var(--green)',
            background: 'rgba(34,197,94,0.12)',
          }}
        >
          {liveCount} LIVE
        </span>
        <span
          className="font-mono"
          style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}
        >
          {lastScanLabel}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={() => refresh()}
            className="font-mono"
            style={{
              fontSize: 11, textTransform: 'uppercase',
              padding: '2px 10px', borderRadius: 6,
              border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)',
              background: 'var(--bg-elevated)',
            }}
          >
            REFRESH
          </button>
          <button
            onClick={() => trigger()}
            disabled={triggering}
            className="font-mono"
            style={{
              fontSize: 11, textTransform: 'uppercase',
              padding: '2px 10px', borderRadius: 6,
              border: 'none',
              cursor: triggering ? 'wait' : 'pointer',
              color: 'var(--accent)',
              background: 'rgba(99,102,241,0.12)',
              opacity: triggering ? 0.6 : 1,
            }}
          >
            {triggering ? 'TRIGGERING…' : 'TRIGGER SCAN'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? 'var(--bg-elevated)' : 'transparent',
              color: filter === f ? 'var(--text-primary)' : 'var(--text-tertiary)',
              border: 'none', padding: '6px 14px', fontSize: 12,
              fontFamily: 'Inter, sans-serif', cursor: 'pointer',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {!isMobile && <th style={{ ...th, width: 32 }}>#</th>}
              <th style={th}>Event</th>
              <th style={{ ...th, width: 64 }}>Closes</th>
              <th style={{ ...th, width: 96 }}>Ann. Return</th>
              {!isMobile && <th style={{ ...th, width: 72 }}>Poly YES</th>}
              {!isMobile && <th style={{ ...th, width: 72 }}>Kalshi NO</th>}
              {!isMobile && <th style={{ ...th, width: 80 }}>Raw Spread</th>}
              <th style={{ ...th, width: 80 }}>Net Spread</th>
              <th style={{ ...th, width: 80 }}>Max $</th>
              <th style={{ ...th, width: 80 }}>Verdict</th>
              {!isMobile && <th style={{ ...th, width: 80 }}>Scanned</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((o) => (
              <>
                <tr
                  key={o.id}
                  onClick={() => setExpandedId(expandedId === o.id ? null : o.id)}
                  style={{
                    cursor: 'pointer',
                    borderLeft: o.netSpread > 3 ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                  className="table-row-hover"
                >
                  {!isMobile && (
                    <td className="font-mono" style={{ ...td, color: 'var(--text-tertiary)', fontSize: 12 }}>{o.id}</td>
                  )}
                  <td style={{ ...td, color: 'var(--text-primary)', fontSize: 13, maxWidth: isMobile ? 140 : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.event}
                  </td>
                  <td
                    className="font-mono"
                    style={{ ...td, fontSize: 13, fontWeight: 600, color: daysColor(o.daysToClose) }}
                  >
                    {formatDays(o.daysToClose)}
                  </td>
                  <td
                    className="font-mono"
                    style={{ ...td, fontSize: 13, fontWeight: 700, color: annualizedColor(o.annualizedReturn) }}
                  >
                    {formatAnnualized(o.annualizedReturn)}
                  </td>
                  {!isMobile && <td className="font-mono" style={{ ...td, fontSize: 13, color: 'var(--text-secondary)' }}>${o.polyYes.toFixed(2)}</td>}
                  {!isMobile && <td className="font-mono" style={{ ...td, fontSize: 13, color: 'var(--text-secondary)' }}>${o.kalshiNo.toFixed(2)}</td>}
                  {!isMobile && <td className="font-mono" style={{ ...td, fontSize: 13, color: 'var(--text-primary)' }}>{o.rawSpread.toFixed(1)}%</td>}
                  <td
                    className="font-mono"
                    style={{
                      ...td, fontSize: 13, fontWeight: 700,
                      color: o.netSpread > 0 ? 'var(--green)' : 'var(--red)',
                    }}
                  >
                    {o.netSpread > 0 ? '+' : ''}{o.netSpread.toFixed(1)}%
                  </td>
                  <td className="font-mono" style={{ ...td, fontSize: 13, color: 'var(--text-primary)' }}>
                    ${o.maxDollar}
                  </td>
                  <td style={td}><VerdictBadge verdict={o.verdict} /></td>
                  {!isMobile && <td style={{ ...td, fontSize: 11, color: 'var(--text-tertiary)' }}>{o.scanned}</td>}
                </tr>
                {expandedId === o.id && (
                  <tr key={`${o.id}-exp`}>
                    <td colSpan={isMobile ? 6 : 11} style={{ padding: 16, background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                          gap: 16,
                          marginBottom: 16,
                          fontSize: 12,
                          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                        }}
                      >
                        <div>
                          <div className="label" style={{ marginBottom: 4 }}>Kalshi closes</div>
                          <div style={{ color: 'var(--text-primary)' }}>{formatCloseDate(o.kalshiCloseDate)}</div>
                        </div>
                        <div>
                          <div className="label" style={{ marginBottom: 4 }}>Polymarket closes</div>
                          <div style={{ color: 'var(--text-primary)' }}>{formatCloseDate(o.polyCloseDate)}</div>
                        </div>
                        <div>
                          <div className="label" style={{ marginBottom: 4 }}>Effective settlement</div>
                          <div style={{ color: 'var(--text-primary)' }}>{formatCloseDate(o.effectiveCloseDate)}</div>
                        </div>
                        <div>
                          <div className="label" style={{ marginBottom: 4 }}>Days remaining</div>
                          <div style={{ color: daysColor(o.daysToClose) }}>{formatDays(o.daysToClose)}</div>
                        </div>
                        <div>
                          <div className="label" style={{ marginBottom: 4 }}>Capital locked for</div>
                          <div style={{ color: 'var(--text-primary)' }}>~{formatDays(o.daysToClose)}</div>
                        </div>
                        <div>
                          <div className="label" style={{ marginBottom: 4 }}>Annualized return</div>
                          <div style={{ color: annualizedColor(o.annualizedReturn), fontWeight: 700 }}>
                            {formatAnnualized(o.annualizedReturn)}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                        <DepthBar label="POLYMARKET DEPTH" depth={o.polyDepth} />
                        <DepthBar label="KALSHI DEPTH" depth={o.kalshiDepth} />
                      </div>
                      {(o.kalshiYesMeaning || o.polyHedgeOutcomeLabel || o.verdictReasoning || (o.riskFactors && o.riskFactors.length > 0)) && (
                        <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-base)', borderRadius: 6, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {o.kalshiYesMeaning && (
                            <div>
                              <div className="label" style={{ marginBottom: 3 }}>TRADE STRUCTURE</div>
                              <div style={{ color: 'var(--text-primary)' }}>{o.kalshiYesMeaning}</div>
                              {o.polyHedgeOutcomeLabel && (
                                <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>Hedge: buy <span style={{ color: 'var(--accent)' }}>{o.polyHedgeOutcomeLabel}</span> on Polymarket</div>
                              )}
                            </div>
                          )}
                          {o.verdictReasoning && (
                            <div>
                              <div className="label" style={{ marginBottom: 3 }}>VERDICT REASONING</div>
                              <div style={{ color: 'var(--text-secondary)' }}>{o.verdictReasoning}</div>
                            </div>
                          )}
                          {o.riskFactors && o.riskFactors.length > 0 && (
                            <div>
                              <div className="label" style={{ marginBottom: 3 }}>RISK FACTORS</div>
                              <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--amber)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {o.riskFactors.map((r, i) => <li key={i}>{r}</li>)}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                        <a href={o.polyUrl ?? '#'} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '6px 12px', textDecoration: 'none', opacity: o.polyUrl ? 1 : 0.4 }}>
                          VIEW ON POLYMARKET ↗
                        </a>
                        <a href={o.kalshiUrl ?? '#'} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '6px 12px', textDecoration: 'none', opacity: o.kalshiUrl ? 1 : 0.4 }}>
                          VIEW ON KALSHI ↗
                        </a>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      <style>{`.table-row-hover:hover { background: var(--bg-elevated); transition: background 100ms; }`}</style>
    </div>
  );
}
