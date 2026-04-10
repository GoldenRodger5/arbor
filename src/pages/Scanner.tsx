import { useScannerContext } from '@/context/ScannerContext';

function formatRelative(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export default function Scanner() {
  const { stats, trigger, triggering } = useScannerContext();

  const cards = [
    { label: 'KALSHI MARKETS', value: stats.kalshiCount > 0 ? stats.kalshiCount.toLocaleString() : '—' },
    { label: 'POLYMARKET US', value: stats.polyCount > 0 ? stats.polyCount.toLocaleString() : '—' },
    { label: 'MATCHED PAIRS', value: stats.matchedCount > 0 ? stats.matchedCount.toLocaleString() : '—' },
    { label: 'OPPORTUNITIES', value: stats.opportunityCount > 0 ? stats.opportunityCount.toLocaleString() : '—' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Scanner</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            Last scan: {formatRelative(stats.lastScanAt)}
          </span>
          <button
            onClick={() => trigger()}
            disabled={triggering}
            style={{
              background: 'none', border: '1px solid var(--border)',
              color: 'var(--text-secondary)', fontSize: 12, padding: '4px 10px',
              borderRadius: 4, cursor: triggering ? 'wait' : 'pointer',
              opacity: triggering ? 0.6 : 1,
            }}
          >
            {triggering ? 'Scanning...' : '↻ Scan Now'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 24 }}>
        {cards.map((c) => (
          <div key={c.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 16, borderRadius: 6 }}>
            <div className="label">{c.label}</div>
            <div className="font-mono" style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', marginTop: 4 }}>
              {c.value}
            </div>
          </div>
        ))}
      </div>

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 20, borderRadius: 6 }}>
        <div className="label" style={{ marginBottom: 12 }}>HOW IT WORKS</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          The scanner fetches all active markets from Kalshi (~5,700) and Polymarket US (~1,000)
          every 5 minutes. It fuzzy-matches titles, verifies polarity via Claude AI, fetches
          orderbooks, and calculates net spreads after fees. Opportunities with &gt;3% net spread
          closing within 2 days trigger Telegram alerts.
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 12 }}>
          The fastpoll function runs every 60 seconds targeting game-winner markets specifically,
          with deterministic polarity (no Claude needed) for faster detection.
        </div>
      </div>

      {stats.isScanning && (
        <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, color: 'var(--accent)' }}>
          Scan in progress...
        </div>
      )}
    </div>
  );
}
