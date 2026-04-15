import type { Trade } from '@/types';

function sportOf(ticker?: string, strategy?: string): string {
  const tk = (ticker ?? '').toUpperCase();
  if (tk.includes('MLB')) return 'MLB';
  if (tk.includes('NBA')) return 'NBA';
  if (tk.includes('NHL')) return 'NHL';
  if (tk.includes('MLS')) return 'MLS';
  if (tk.includes('EPL')) return 'EPL';
  if (tk.includes('LALIGA')) return 'La Liga';
  if (strategy === 'ufc-prediction') return 'UFC';
  return 'Other';
}

const SPORT_COLOR: Record<string, string> = {
  MLB: '#002d72', NBA: '#c9082a', NHL: '#0066cc',
  MLS: '#005293', EPL: '#3d195b', 'La Liga': '#ff4b00',
  UFC: '#d20a0a', Other: '#4B4B5E',
};

function statusLabel(status?: string, pnl?: number | null): { text: string; color: string } {
  if (status === 'open') return { text: 'Open', color: 'var(--accent)' };
  if (status === 'settled') {
    if ((pnl ?? 0) > 0) return { text: 'Won', color: 'var(--green)' };
    return { text: 'Lost', color: 'var(--red)' };
  }
  if (status?.startsWith('sold-')) return { text: 'Sold', color: 'var(--amber)' };
  if (status === 'closed-manual') return { text: 'Closed', color: 'var(--text-secondary)' };
  return { text: status ?? '', color: 'var(--text-secondary)' };
}

export default function TradeCard({ trade, compact = false }: { trade: Trade; compact?: boolean }) {
  const sport = sportOf(trade.ticker, trade.strategy);
  const status = statusLabel(trade.status, trade.realizedPnL);
  const entryPct = Math.round((trade.entryPrice ?? 0) * 100);
  const exitPct = trade.exitPrice != null ? Math.round(trade.exitPrice * 100) : null;
  const pnl = trade.realizedPnL ?? null;
  const held = trade.timestamp ? Math.round((Date.now() - new Date(trade.timestamp).getTime()) / 60000) : 0;
  const heldStr = held < 60 ? `${held}m` : `${Math.floor(held / 60)}h ${held % 60}m`;
  const date = new Date(trade.timestamp).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <article style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {/* Header: sport badge + title + status */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '4px 8px', borderRadius: 6,
          background: SPORT_COLOR[sport] ?? 'var(--bg-elevated)', color: '#fff', flexShrink: 0,
          letterSpacing: '0.04em',
        }}>{sport}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3 }}>{trade.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{date} · {heldStr}</div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
          background: `${status.color}20`, color: status.color, flexShrink: 0,
        }}>{status.text}</span>
      </div>

      {/* Price path + PnL */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
        background: 'var(--bg-base)', borderRadius: 10, fontSize: 13,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{trade.side?.toUpperCase()}</span>
          <span className="font-mono" style={{ fontWeight: 600 }}>{entryPct}¢</span>
        </div>
        {exitPct != null && (
          <>
            <span style={{ color: 'var(--text-tertiary)' }}>→</span>
            <span className="font-mono" style={{ fontWeight: 600 }}>{exitPct}¢</span>
          </>
        )}
        <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          × {trade.quantity}
        </span>
        <div style={{ flex: 1 }} />
        {pnl != null ? (
          <span className="font-mono" style={{
            fontSize: 16, fontWeight: 700,
            color: pnl >= 0 ? 'var(--green)' : 'var(--red)',
          }}>
            {pnl >= 0 ? '+' : ''}${Math.abs(pnl).toFixed(2)}
          </span>
        ) : (
          <span className="font-mono" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            ${trade.deployCost?.toFixed(2)}
          </span>
        )}
      </div>

      {/* Meta chips */}
      <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--text-tertiary)', flexWrap: 'wrap' }}>
        <span>Conf {Math.round((trade.confidence ?? 0) * 100)}%</span>
        {trade.edge != null && <span>· Edge {trade.edge.toFixed(1)}%</span>}
        {trade.liveScore && <span style={{ color: 'var(--amber)' }}>· {trade.liveScore}</span>}
        {trade.strategy && <span style={{ marginLeft: 'auto' }}>{trade.strategy}</span>}
      </div>

      {/* Reasoning — the hero of the card */}
      {trade.reasoning && !compact && (
        <div style={{
          fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6,
          paddingTop: 4, fontStyle: 'italic',
          borderTop: '1px solid var(--border)',
        }}>
          {trade.reasoning}
        </div>
      )}

      {/* Review (if graded) */}
      {trade.reviewText && (
        <div style={{
          fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8,
          background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
        }}>
          <span style={{ fontWeight: 700, color: 'var(--accent)', marginRight: 6 }}>
            {trade.reviewGrade ?? 'Review'}:
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>{trade.reviewText}</span>
        </div>
      )}
    </article>
  );
}
