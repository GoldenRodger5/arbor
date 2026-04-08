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
  const { opportunities: ctxOpps, stats, startScan, stopScan } = useScannerContext();

  // Use live opportunities when available; otherwise fall back to mock data
  // (only when not actively scanning).
  const opportunities = useMemo<Opportunity[]>(() => {
    if (ctxOpps.length > 0) return ctxOpps.map(adaptOpportunity);
    if (!stats.isScanning) return mockOpportunities;
    return [];
  }, [ctxOpps, stats.isScanning]);

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
        <button
          onClick={() => (stats.isScanning ? stopScan() : startScan())}
          className="font-mono"
          style={{
            fontSize: 11, textTransform: 'uppercase',
            padding: '2px 10px', borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            color: stats.isScanning ? 'var(--red)' : 'var(--accent)',
            background: stats.isScanning ? 'rgba(239,68,68,0.12)' : 'rgba(99,102,241,0.12)',
            marginLeft: 'auto',
          }}
        >
          {stats.isScanning ? 'STOP SCAN' : 'START SCAN'}
        </button>
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
                    <td colSpan={isMobile ? 4 : 9} style={{ padding: 16, background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                        <DepthBar label="POLYMARKET DEPTH" depth={o.polyDepth} />
                        <DepthBar label="KALSHI DEPTH" depth={o.kalshiDepth} />
                      </div>
                      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                        <a href="#" style={{ fontSize: 12, color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '6px 12px', textDecoration: 'none' }}>
                          VIEW ON POLYMARKET ↗
                        </a>
                        <a href="#" style={{ fontSize: 12, color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '6px 12px', textDecoration: 'none' }}>
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
