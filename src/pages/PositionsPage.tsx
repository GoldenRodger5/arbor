import { useState } from 'react';
import { useArbor } from '@/context/ArborContext';

export default function PositionsPage() {
  const { positions } = useArbor();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

  const sportOf = (t: any) => {
    const tk = t.ticker ?? '';
    if (tk.includes('MLB')) return 'MLB';
    if (tk.includes('NBA')) return 'NBA';
    if (tk.includes('NHL')) return 'NHL';
    if (tk.includes('MLS')) return 'MLS';
    if (tk.includes('EPL')) return 'EPL';
    if (t.strategy === 'ufc-prediction') return 'UFC';
    return 'Other';
  };

  const sports = ['all', ...new Set(positions.map(sportOf))];
  const filtered = filter === 'all' ? positions : positions.filter(p => sportOf(p) === filter);
  const totalDeployed = filtered.reduce((s, p) => s + (p.deployCost ?? 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Positions ({positions.length})</h1>
        <div className="font-mono" style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
          ${totalDeployed.toFixed(2)} deployed
        </div>
      </div>

      {/* Sport Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {sports.map(s => (
          <button key={s} onClick={() => setFilter(s)} style={{
            padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)',
            background: filter === s ? 'var(--accent)' : 'var(--bg-surface)',
            color: filter === s ? 'white' : 'var(--text-secondary)',
            fontSize: 12, fontWeight: 500, cursor: 'pointer', textTransform: 'uppercase',
          }}>{s}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>No open positions</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map(p => {
            const isExpanded = expanded === p.id;
            const sport = sportOf(p);
            const potentialProfit = p.quantity * (1 - p.entryPrice);
            const held = p.timestamp ? Math.round((Date.now() - new Date(p.timestamp).getTime()) / 60000) : 0;
            const heldStr = held < 60 ? `${held}m` : `${Math.floor(held / 60)}h ${held % 60}m`;

            return (
              <div key={p.id} onClick={() => setExpanded(isExpanded ? null : p.id)} style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
                padding: '16px 20px', cursor: 'pointer', transition: 'border-color 150ms',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{
                        background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: 4,
                        fontSize: 10, fontWeight: 700, color: 'var(--accent)',
                      }}>{sport}</span>
                      <span style={{
                        background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: 4,
                        fontSize: 10, fontWeight: 500, color: 'var(--text-secondary)', textTransform: 'uppercase',
                      }}>{p.exchange}</span>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{p.title}</div>
                    <div className="font-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {p.side?.toUpperCase()} @ {(p.entryPrice * 100).toFixed(0)}¢ × {p.quantity} = ${p.deployCost?.toFixed(2)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', marginLeft: 16, flexShrink: 0 }}>
                    <div className="font-mono" style={{ fontSize: 18, fontWeight: 600, color: 'var(--green)' }}>
                      ${potentialProfit.toFixed(2)}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>potential profit</div>
                    <div className="font-mono" style={{ fontSize: 12, color: 'var(--accent)', marginTop: 4 }}>
                      {(p.confidence * 100).toFixed(0)}% conf
                    </div>
                  </div>
                </div>

                {p.liveScore && (
                  <div className="font-mono" style={{
                    marginTop: 8, padding: '6px 10px', background: 'var(--bg-base)', borderRadius: 6,
                    fontSize: 12, color: 'var(--amber)',
                  }}>
                    {p.liveScore}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>
                  <span>Edge: {p.edge?.toFixed(1)}%</span>
                  <span>Held: {heldStr}</span>
                  <span>Strategy: {p.strategy}</span>
                </div>

                {isExpanded && (
                  <div style={{
                    marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)',
                    fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, fontStyle: 'italic',
                  }}>
                    {p.reasoning}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
