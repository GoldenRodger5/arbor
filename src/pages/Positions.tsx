import { useState, useEffect } from 'react';
import { getPositions, type Position } from '@/lib/supabase';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60000);
  const hours   = Math.floor(diff / 3600000);
  const days    = Math.floor(diff / 86400000);
  if (days > 0)    return `${days}d ago`;
  if (hours > 0)   return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

function calcDeployed(p: Position): number | null {
  if (
    p.kalshiFillPrice !== null && p.kalshiFillQuantity !== null &&
    p.polyFillPrice   !== null && p.polyFillQuantity   !== null
  ) {
    return p.kalshiFillPrice * p.kalshiFillQuantity +
           p.polyFillPrice   * p.polyFillQuantity;
  }
  return null;
}

function calcMaxProfit(p: Position): number | null {
  if (
    p.kalshiFillPrice    !== null && p.kalshiFillQuantity !== null &&
    p.polyFillPrice      !== null
  ) {
    return Math.round(
      p.kalshiFillQuantity * (1 - p.kalshiFillPrice - p.polyFillPrice),
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status badge
// ─────────────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Position['status'] }) {
  const config: Record<Position['status'], { label: string; color: string }> = {
    pending:   { label: 'PENDING',   color: 'var(--amber)' },
    open:      { label: 'OPEN',      color: 'var(--green)' },
    partial:   { label: 'PARTIAL',   color: 'var(--red)'   },
    settled:   { label: 'SETTLED',   color: 'var(--green)' },
    failed:    { label: 'FAILED',    color: 'var(--red)'   },
    cancelled: { label: 'CANCELLED', color: 'var(--text-tertiary)' },
  };
  const { label, color } = config[status] ?? config.pending;
  return (
    <span
      className="font-mono"
      style={{
        fontSize: 10,
        textTransform: 'uppercase',
        padding: '2px 8px',
        borderRadius: 6,
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Position card
// ─────────────────────────────────────────────────────────────────────────────

function PositionCard({ p }: { p: Position }) {
  const isPartial  = p.status === 'partial';
  const isPending  = p.status === 'pending';
  const deployed   = calcDeployed(p);
  const maxProfit  = calcMaxProfit(p);

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: isPartial
          ? '1px solid var(--red)'
          : '1px solid var(--border)',
        padding: 20,
        marginBottom: 12,
        borderRadius: 6,
        boxShadow: isPartial ? '0 0 0 1px var(--red)' : undefined,
      }}
    >
      {/* Top row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.4 }}>
          {p.kalshiTitle || '(untitled)'}
        </span>
        <StatusBadge status={p.status} />
      </div>

      {/* Two columns */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        {/* Left */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, flex: 1 }}>
          <div>
            <div className="label">KALSHI LEG</div>
            <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 2 }}>
              {p.intendedKalshiSide?.toUpperCase() ?? '—'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, wordBreak: 'break-word' }}>
              {p.kalshiTitle || '—'}
            </div>
          </div>
          <div>
            <div className="label">POLYMARKET LEG</div>
            <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 2 }}>
              {p.intendedPolySide?.toUpperCase() ?? '—'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, wordBreak: 'break-word' }}>
              {p.polyTitle || '—'}
            </div>
          </div>
          <div>
            <div className="label">DEPLOYED</div>
            <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 2 }}>
              {deployed !== null
                ? `$${deployed.toFixed(2)}`
                : <span style={{ color: 'var(--text-tertiary)' }}>Pending execution</span>
              }
            </div>
          </div>
        </div>

        {/* Right */}
        <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
          <div>
            <div className="label">FILL PRICES</div>
            <div className="font-mono" style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 2 }}>
              Kalshi: {p.kalshiFillPrice !== null ? `$${p.kalshiFillPrice.toFixed(4)}` : '—'}
            </div>
            <div className="font-mono" style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 1 }}>
              Poly: {p.polyFillPrice !== null ? `$${p.polyFillPrice.toFixed(4)}` : '—'}
            </div>
          </div>
          <div>
            <div className="label">CONTRACTS</div>
            <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 2 }}>
              {p.kalshiFillQuantity ?? '—'}
            </div>
          </div>
          <div>
            <div className="label">MAX PROFIT</div>
            <div
              className="font-mono"
              style={{
                fontSize: 13,
                marginTop: 2,
                color: maxProfit !== null && maxProfit > 0 ? 'var(--green)' : 'var(--text-primary)',
              }}
            >
              {maxProfit !== null ? `$${maxProfit}` : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom row */}
      <div
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 12,
          marginTop: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        {/* Left: timestamps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span>
            <span className="label">OPENED </span>
            <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {formatRelativeTime(p.createdAt)}
            </span>
          </span>
          {p.executedAt && (
            <span>
              <span className="label">EXECUTED </span>
              <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {formatRelativeTime(p.executedAt)}
              </span>
            </span>
          )}
        </div>

        {/* Right: status notes + order links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {isPartial && (
            <span style={{ fontSize: 12, color: 'var(--red)', fontWeight: 500 }}>
              ⚠️ Unhedged position
            </span>
          )}
          {isPending && (
            <span style={{ fontSize: 12, color: 'var(--amber)' }}>
              Manual execution required
            </span>
          )}
          {p.kalshiOrderId && (
            <a
              href="https://kalshi.com/portfolio"
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: 'var(--text-secondary)', textDecoration: 'none' }}
            >
              Kalshi order ↗
            </a>
          )}
          {p.polyOrderId && (
            <a
              href="https://polymarket.com/portfolio"
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: 'var(--text-secondary)', textDecoration: 'none' }}
            >
              Poly order ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function Positions() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const data = await getPositions();
      if (!cancelled) {
        setPositions(data);
        setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const activeCount = positions.filter(
    (p) => p.status === 'open' || p.status === 'pending' || p.status === 'partial',
  ).length;

  if (loading) {
    return (
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Positions</h1>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '50vh' }}>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>Loading positions...</span>
        </div>
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Positions</h1>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '50vh', gap: 8 }}>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>No open positions.</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
            Positions will appear here after your first executed trade.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Positions</h1>
        {activeCount > 0 && (
          <span
            className="font-mono"
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              padding: '2px 10px',
              borderRadius: 6,
              color: 'var(--accent)',
              background: 'rgba(99,102,241,0.12)',
            }}
          >
            {activeCount} ACTIVE
          </span>
        )}
      </div>

      {positions.map((p) => (
        <PositionCard key={p.id} p={p} />
      ))}
    </div>
  );
}
