import { kalshiMarkets, polyMarkets } from '@/data/mock';
import { useIsMobile } from '@/hooks/use-mobile';

function formatVolume(v: number) {
  if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  return `$${v}`;
}

function formatCloses(dateStr: string) {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return 'expired';
  const days = Math.floor(diff / 86400000);
  if (days > 30) return `in ${Math.floor(days / 30)}mo`;
  if (days > 0) return `in ${days}d`;
  const hours = Math.floor(diff / 3600000);
  return `in ${hours}h`;
}

function StatusBadge({ matched }: { matched: boolean }) {
  if (matched) {
    return (
      <span
        className="font-mono"
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          padding: '2px 8px',
          borderRadius: 6,
          background: 'rgba(99,102,241,0.15)',
          color: 'var(--accent)',
        }}
      >
        MATCHED
      </span>
    );
  }
  return (
    <span className="font-mono" style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
      UNMATCHED
    </span>
  );
}

function MarketTable({ title, markets, compact }: { title: string; markets: typeof kalshiMarkets; compact?: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontSize: 13,
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          padding: '8px 0',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {title}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thStyle}>Title</th>
            <th style={{ ...thStyle, width: 72 }}>YES</th>
            {!compact && <th style={{ ...thStyle, width: 80 }}>Volume</th>}
            {!compact && <th style={{ ...thStyle, width: 64 }}>Closes</th>}
            <th style={{ ...thStyle, width: 90 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => (
            <tr key={m.id} className="table-row-hover">
              <td style={{ ...tdStyle, maxWidth: compact ? 'none' : 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontSize: 13 }}>
                {m.title}
              </td>
              <td className="font-mono" style={{ ...tdStyle, fontSize: 13, color: m.yes < 0.5 ? 'var(--green)' : 'var(--text-primary)' }}>
                ${m.yes.toFixed(2)}
              </td>
              {!compact && (
                <td className="font-mono" style={{ ...tdStyle, fontSize: 12, color: 'var(--text-secondary)' }}>
                  {formatVolume(m.volume)}
                </td>
              )}
              {!compact && (
                <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {formatCloses(m.closes)}
                </td>
              )}
              <td style={tdStyle}>
                <StatusBadge matched={m.matched} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 8px',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-tertiary)',
  fontWeight: 500,
  borderBottom: '1px solid var(--border)',
};

const tdStyle: React.CSSProperties = {
  padding: '0 8px',
  height: 44,
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'middle',
};

export default function Scanner() {
  const isMobile = useIsMobile();
  const matchedCount = kalshiMarkets.filter((m) => m.matched).length;

  const stats = [
    { label: 'KALSHI MARKETS', value: '847' },
    { label: 'POLY MARKETS', value: '1,203' },
    { label: 'MATCHED PAIRS', value: '34' },
  ];

  return (
    <div>
      {/* Stats row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        {stats.map((s) => (
          <div
            key={s.label}
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              padding: '8px 16px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span className="label">{s.label}</span>
            <span className="font-mono" style={{ fontSize: 14, color: 'var(--text-primary)' }}>{s.value}</span>
          </div>
        ))}
      </div>

      {/* Tables */}
      {isMobile ? (
        <div>
          <MarketTable title="Kalshi" markets={kalshiMarkets} compact />
          <div style={{ borderBottom: '1px solid var(--border)', margin: '16px 0' }} />
          <MarketTable title="Polymarket" markets={polyMarkets} compact />
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 0 }}>
          <MarketTable title="Kalshi" markets={kalshiMarkets} />
          <div style={{ position: 'relative', width: 1, background: 'var(--border)' }}>
            <div
              className="font-mono"
              style={{
                position: 'absolute',
                top: -12,
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'var(--bg-elevated)',
                padding: '4px 12px',
                borderRadius: 6,
                fontSize: 11,
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              {matchedCount} MATCHED
            </div>
          </div>
          <MarketTable title="Polymarket" markets={polyMarkets} />
        </div>
      )}

      <style>{`
        .table-row-hover:hover { background: var(--bg-elevated); transition: background 100ms; }
      `}</style>
    </div>
  );
}
