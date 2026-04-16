import { useEffect, useState } from 'react';
import { api, type PaperTrade, type PaperStats } from '@/lib/api';
import { useArbor } from '@/context/ArborContext';

const SPORT_COLOR: Record<string, string> = {
  mlb: '#002d72', nba: '#c9082a', nhl: '#0066cc',
  mls: '#005293', epl: '#3d195b', laliga: '#ff4b00',
};

function sportLabel(s: string) {
  return { mlb: 'MLB', nba: 'NBA', nhl: 'NHL', mls: 'MLS', epl: 'EPL', laliga: 'La Liga' }[s] ?? s.toUpperCase();
}

function StatusBadge({ status }: { status: PaperTrade['status'] }) {
  const cfg = {
    pending: { bg: '#2a2a1a', color: '#d4b400', label: 'PENDING' },
    won:     { bg: '#0d2a1a', color: '#00c97a', label: 'WON' },
    lost:    { bg: '#2a0d0d', color: '#ff4d4d', label: 'LOST' },
  }[status];
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
      padding: '2px 7px', borderRadius: 4,
      background: cfg.bg, color: cfg.color,
    }}>{cfg.label}</span>
  );
}

function PaperCard({ t }: { t: PaperTrade }) {
  const sportColor = SPORT_COLOR[t.sport] ?? '#4B4B5E';
  const edgeStr = t.edge >= 0 ? `+${t.edge.toFixed(1)}%` : `${t.edge.toFixed(1)}%`;
  const pnlColor = t.paperPnL == null ? 'var(--text-secondary)'
    : t.paperPnL > 0 ? 'var(--green)' : 'var(--red)';

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${sportColor}`,
      borderRadius: 8,
      padding: '14px 16px',
      marginBottom: 10,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
          background: sportColor + '33', color: sportColor === '#002d72' ? '#4d88ff' : sportColor,
          letterSpacing: '0.05em',
        }}>{sportLabel(t.sport)}</span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>{t.marketTitle}</span>
        <StatusBadge status={t.status} />
      </div>

      {/* Pick row */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
          {t.teamName}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          vs {t.opponentName}
        </span>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>CONF</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
            {Math.round(t.confidence * 100)}%
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>PRICE</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
            {Math.round(t.price * 100)}¢
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>EDGE</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: t.edge >= 4 ? 'var(--green)' : 'var(--text-secondary)', fontFamily: 'monospace' }}>
            {edgeStr}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>WOULD BET</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
            ${t.wouldBetAmount.toFixed(2)}
          </div>
        </div>
        {t.paperPnL != null && (
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>PAPER P&amp;L</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: pnlColor, fontFamily: 'monospace' }}>
              {t.paperPnL >= 0 ? '+' : ''}${t.paperPnL.toFixed(2)}
            </div>
          </div>
        )}
      </div>

      {/* Reasoning */}
      {t.reasoning && (
        <div style={{
          fontSize: 11, color: 'var(--text-secondary)',
          borderTop: '1px solid var(--border)', paddingTop: 8,
          fontStyle: 'italic', lineHeight: 1.5,
        }}>
          {t.reasoning}
        </div>
      )}

      {/* Timestamp */}
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6 }}>
        {new Date(t.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} ET
      </div>
    </div>
  );
}

function CalibrationTable({ stats }: { stats: PaperStats }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em', marginBottom: 12 }}>
        CALIBRATION
      </h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['', 'Picks', 'Wins', 'Win %', 'Implied P&L'].map(h => (
                <th key={h} style={{ textAlign: h === '' ? 'left' : 'right', padding: '6px 10px', color: 'var(--text-tertiary)', fontWeight: 500, borderBottom: '1px solid var(--border)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* By confidence */}
            {stats.byConfidence.map(b => (
              <tr key={b.label}>
                <td style={{ padding: '7px 10px', color: 'var(--text-secondary)' }}>{b.label}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{b.total}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{b.wins}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: b.winRate == null ? 'var(--text-tertiary)' : b.winRate >= 60 ? 'var(--green)' : b.winRate >= 45 ? 'var(--text-primary)' : 'var(--red)' }}>
                  {b.winRate != null ? `${b.winRate}%` : '—'}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: b.impliedPnL >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {b.total > 0 ? `${b.impliedPnL >= 0 ? '+' : ''}$${b.impliedPnL.toFixed(2)}` : '—'}
                </td>
              </tr>
            ))}
            {/* Divider */}
            <tr><td colSpan={5} style={{ borderTop: '1px solid var(--border)', padding: 0 }} /></tr>
            {/* By sport */}
            {stats.bySport.map(s => (
              <tr key={s.sport}>
                <td style={{ padding: '7px 10px', color: 'var(--text-secondary)' }}>{sportLabel(s.sport)}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{s.total}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{s.wins}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: s.winRate == null ? 'var(--text-tertiary)' : s.winRate >= 60 ? 'var(--green)' : s.winRate >= 45 ? 'var(--text-primary)' : 'var(--red)' }}>
                  {s.winRate != null ? `${s.winRate}%` : '—'}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: s.impliedPnL >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {s.total > 0 ? `${s.impliedPnL >= 0 ? '+' : ''}$${s.impliedPnL.toFixed(2)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PreGameLabPage() {
  const { trades: allTrades } = useArbor();
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [stats, setStats] = useState<PaperStats | null>(null);

  // If any real pre-game bets have ever been placed, the strategy is live
  const isLive = allTrades.some(t => t.strategy === 'pre-game-prediction');
  const [view, setView] = useState<'today' | 'all'>('today');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, s] = await Promise.all([
        api.getPaperTrades(view === 'today' ? 'today' : undefined),
        api.getPaperStats(),
      ]);
      setTrades([...t].reverse()); // newest first
      setStats(s);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [view]);

  const pending = trades.filter(t => t.status === 'pending');
  const settled = trades.filter(t => t.status !== 'pending');
  const todayImpliedPnL = view === 'today'
    ? settled.reduce((s, t) => s + (t.paperPnL ?? 0), 0)
    : null;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 24px' }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Pre-Game Lab
          </h1>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
            padding: '3px 8px', borderRadius: 4,
            background: isLive ? 'rgba(34,197,94,0.15)' : '#1a1a2e',
            color: isLive ? 'var(--green)' : '#6b7dff',
            border: isLive ? '1px solid rgba(34,197,94,0.3)' : '1px solid #2d2d5e',
          }}>{isLive ? 'LIVE' : 'PAPER ONLY'}</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
          Simulated pre-game picks — no real money. Tracking calibration data to decide if pre-game should go live.
        </p>
      </div>

      {/* Summary bar */}
      {stats && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 28,
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 20px',
        }}>
          {[
            { label: 'TOTAL PICKS', value: stats.total + stats.pending },
            { label: 'WIN RATE', value: stats.winRate != null ? `${stats.winRate}%` : '—' },
            { label: 'IMPLIED P&L', value: `${stats.impliedPnL >= 0 ? '+' : ''}$${stats.impliedPnL.toFixed(2)}`, color: stats.impliedPnL >= 0 ? 'var(--green)' : 'var(--red)' },
            { label: 'PENDING', value: stats.pending },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: color ?? 'var(--text-primary)', fontFamily: 'monospace' }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* View toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {(['today', 'all'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)',
            background: view === v ? 'var(--accent)' : 'var(--bg-surface)',
            color: view === v ? '#fff' : 'var(--text-secondary)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>
            {v === 'today' ? "Today's Picks" : 'All Time'}
          </button>
        ))}
        <button onClick={load} style={{
          marginLeft: 'auto', padding: '6px 14px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
        }}>Refresh</button>
      </div>

      {/* Calibration table — all-time only */}
      {stats && view === 'all' && stats.total > 0 && <CalibrationTable stats={stats} />}

      {/* Today implied P&L strip */}
      {view === 'today' && todayImpliedPnL != null && settled.length > 0 && (
        <div style={{
          marginBottom: 16, padding: '10px 14px', borderRadius: 6,
          background: todayImpliedPnL >= 0 ? '#0d2a1a' : '#2a0d0d',
          color: todayImpliedPnL >= 0 ? 'var(--green)' : 'var(--red)',
          fontSize: 12, fontWeight: 600,
        }}>
          Today's settled paper picks: {todayImpliedPnL >= 0 ? '+' : ''}${todayImpliedPnL.toFixed(2)} implied P&L
          &nbsp;({settled.filter(t => t.status === 'won').length}W / {settled.filter(t => t.status === 'lost').length}L)
        </div>
      )}

      {/* Trade list */}
      {loading && (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '32px 0', textAlign: 'center' }}>
          Loading...
        </div>
      )}
      {error && (
        <div style={{ color: 'var(--red)', fontSize: 13, padding: '16px 0' }}>{error}</div>
      )}
      {!loading && !error && trades.length === 0 && (
        <div style={{
          color: 'var(--text-tertiary)', fontSize: 13, padding: '48px 0',
          textAlign: 'center', lineHeight: 1.7,
        }}>
          No paper picks yet.
          <br />
          The bot runs pre-game analysis every 15 minutes before 6pm ET.
          <br />
          Picks meeting the 70%+ confidence threshold appear here automatically.
        </div>
      )}

      {/* Pending picks */}
      {!loading && pending.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '0.06em', marginBottom: 10 }}>
            PENDING ({pending.length})
          </div>
          {pending.map(t => <PaperCard key={t.id} t={t} />)}
        </div>
      )}

      {/* Settled picks */}
      {!loading && settled.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '0.06em', marginBottom: 10 }}>
            SETTLED ({settled.length})
          </div>
          {settled.map(t => <PaperCard key={t.id} t={t} />)}
        </div>
      )}
    </div>
  );
}
