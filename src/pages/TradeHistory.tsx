import { useState, useMemo } from 'react';
import { useArbor } from '@/context/ArborContext';
import TradeSwiper from '@/components/TradeSwiper';

function PnlBadge({ value }: { value: number | null }) {
  if (value == null) return <span className="font-mono" style={{ color: 'var(--text-tertiary)' }}>—</span>;
  const color = value >= 0 ? 'var(--green)' : 'var(--red)';
  const sign = value >= 0 ? '+' : '';
  return <span className="font-mono" style={{ color, fontWeight: 600 }}>{sign}${Math.abs(value).toFixed(2)}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    open: { bg: 'rgba(99, 102, 241, 0.15)', text: 'var(--accent)' },
    settled: { bg: 'rgba(34, 197, 94, 0.15)', text: 'var(--green)' },
    'sold-stop-loss': { bg: 'rgba(239, 68, 68, 0.15)', text: 'var(--red)' },
    'sold-claude-stop': { bg: 'rgba(239, 68, 68, 0.15)', text: 'var(--red)' },
    'closed-manual': { bg: 'rgba(245, 158, 11, 0.15)', text: 'var(--amber)' },
  };
  const c = colors[status] ?? colors.open;
  return (
    <span style={{
      background: c.bg, color: c.text, padding: '2px 8px', borderRadius: 4,
      fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    }}>{status.replace('sold-', '').replace('-', ' ')}</span>
  );
}

export default function TradeHistory() {
  const { trades } = useArbor();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filterSport, setFilterSport] = useState('all');
  const [filterResult, setFilterResult] = useState('all');
  const [filterStrategy, setFilterStrategy] = useState('all');
  const [filterDate, setFilterDate] = useState('all');
  const [swipeOpen, setSwipeOpen] = useState(false);

  const sortedTrades = useMemo(() => [...trades].reverse(), [trades]);

  const sportOf = (t: any) => {
    const tk = (t.ticker ?? '').toUpperCase();
    if (tk.includes('MLB')) return 'MLB';
    if (tk.includes('NBA')) return 'NBA';
    if (tk.includes('NHL')) return 'NHL';
    if (tk.includes('MLS') || tk.includes('EPL') || tk.includes('LALIGA')) return 'Soccer';
    if (t.strategy === 'ufc-prediction') return 'UFC';
    return 'Other';
  };

  const resultOf = (t: any) => {
    if (t.status === 'open') return 'open';
    if ((t.realizedPnL ?? 0) > 0) return 'win';
    if ((t.realizedPnL ?? 0) < 0) return 'loss';
    return 'even';
  };

  const dateOf = (t: any) => new Date(t.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // Unique values for filters
  const sports = useMemo(() => ['all', ...new Set(sortedTrades.map(sportOf))], [sortedTrades]);
  const strategies = useMemo(() => ['all', ...new Set(sortedTrades.map(t => t.strategy).filter(Boolean))], [sortedTrades]);
  const dates = useMemo(() => {
    const d = new Set(sortedTrades.map(dateOf));
    return ['all', ...d];
  }, [sortedTrades]);

  const filtered = sortedTrades.filter(t => {
    if (filterSport !== 'all' && sportOf(t) !== filterSport) return false;
    if (filterResult !== 'all' && resultOf(t) !== filterResult) return false;
    if (filterStrategy !== 'all' && t.strategy !== filterStrategy) return false;
    if (filterDate !== 'all' && dateOf(t) !== filterDate) return false;
    return true;
  });

  // Summary
  const settled = filtered.filter(t => t.status !== 'open');
  const wins = settled.filter(t => (t.realizedPnL ?? 0) > 0).length;
  const totalPnL = settled.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
  const avgPnL = settled.length > 0 ? totalPnL / settled.length : 0;

  if (swipeOpen) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Swipe Reasoning</h1>
          <button onClick={() => setSwipeOpen(false)} style={{
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            border: '1px solid var(--border)', borderRadius: 8,
            padding: '6px 10px', fontSize: 12, cursor: 'pointer',
          }}>Back to list</button>
        </div>
        <TradeSwiper trades={filtered} onClose={() => setSwipeOpen(false)} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Trade History</h1>
        {filtered.length > 0 && (
          <button
            onClick={() => setSwipeOpen(true)}
            style={{
              background: 'var(--accent)', color: 'white', border: 'none',
              borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >📖 Swipe reasoning</button>
        )}
      </div>

      {/* Summary Bar */}
      <div style={{
        display: 'flex', gap: 20, padding: '12px 16px', background: 'var(--bg-surface)',
        border: '1px solid var(--border)', borderRadius: 10, marginBottom: 16, flexWrap: 'wrap',
        fontSize: 13,
      }}>
        <span>{filtered.length} trades</span>
        <span>{settled.length} settled</span>
        <span style={{ color: 'var(--green)' }}>{wins}W</span>
        <span style={{ color: 'var(--red)' }}>{settled.length - wins}L</span>
        <span>Win rate: {settled.length > 0 ? Math.round((wins / settled.length) * 100) : 0}%</span>
        <span>P&L: <PnlBadge value={Math.round(totalPnL * 100) / 100} /></span>
        <span>Avg: <PnlBadge value={Math.round(avgPnL * 100) / 100} /></span>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <select value={filterDate} onChange={e => setFilterDate(e.target.value)} style={selectStyle}>
          {dates.map(d => <option key={d} value={d}>{d === 'all' ? 'All Dates' : d}</option>)}
        </select>
        <select value={filterSport} onChange={e => setFilterSport(e.target.value)} style={selectStyle}>
          {sports.map(s => <option key={s} value={s}>{s === 'all' ? 'All Sports' : s}</option>)}
        </select>
        <select value={filterResult} onChange={e => setFilterResult(e.target.value)} style={selectStyle}>
          <option value="all">All Results</option>
          <option value="win">Wins</option>
          <option value="loss">Losses</option>
          <option value="open">Open</option>
        </select>
        <select value={filterStrategy} onChange={e => setFilterStrategy(e.target.value)} style={selectStyle}>
          {strategies.map(s => <option key={s} value={s}>{s === 'all' ? 'All Strategies' : s}</option>)}
        </select>
        {(filterDate !== 'all' || filterSport !== 'all' || filterResult !== 'all' || filterStrategy !== 'all') && (
          <button onClick={() => { setFilterDate('all'); setFilterSport('all'); setFilterResult('all'); setFilterStrategy('all'); }}
            style={{ ...selectStyle, color: 'var(--red)', cursor: 'pointer' }}>Clear filters</button>
        )}
      </div>

      {/* Trade List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.map(t => {
          const isExpanded = expanded === t.id;
          const date = new Date(t.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          const sport = sportOf(t);
          const isHC = t.highConviction || t.strategy === 'high-conviction';

          return (
            <div key={t.id} onClick={() => setExpanded(isExpanded ? null : t.id)} style={{
              background: 'var(--bg-surface)', border: `1px solid ${isHC ? 'rgba(245, 158, 11, 0.3)' : 'var(--border)'}`,
              borderRadius: 10, padding: '12px 16px', cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                  <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', width: 70, flexShrink: 0 }}>
                    {date} {time}
                  </span>
                  <span style={{
                    background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4,
                    fontSize: 10, fontWeight: 600, color: 'var(--accent)', flexShrink: 0,
                  }}>{sport}</span>
                  {isHC && <span style={{ fontSize: 12 }}>🔥</span>}
                  <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.title}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, marginLeft: 12 }}>
                  <StatusBadge status={t.status} />
                  <div style={{ width: 75, textAlign: 'right' }}><PnlBadge value={t.realizedPnL} /></div>
                </div>
              </div>

              <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
                {t.side?.toUpperCase()} @ {(t.entryPrice * 100).toFixed(0)}¢ × {t.quantity} = ${t.deployCost?.toFixed(2)}
                {t.exitPrice != null && <> → Exit: {(t.exitPrice * 100).toFixed(0)}¢</>}
                {' '} | Conf: {(t.confidence * 100).toFixed(0)}% | Edge: {t.edge?.toFixed(1)}%
              </div>

              {isExpanded && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div className="label" style={{ marginBottom: 6 }}>CLAUDE'S REASONING</div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, fontStyle: 'italic' }}>
                    {t.reasoning}
                  </div>
                  {t.liveScore && (
                    <div className="font-mono" style={{ fontSize: 11, color: 'var(--amber)', marginTop: 8 }}>
                      Score at entry: {t.liveScore}
                    </div>
                  )}
                  <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                    Strategy: {t.strategy} | Exchange: {t.exchange} | Ticker: {t.ticker}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>No trades match filters</div>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)',
  borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer',
};
