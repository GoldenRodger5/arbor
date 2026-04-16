import { useEffect, useState, useMemo } from 'react';
import { useArbor } from '@/context/ArborContext';
import { api, type PaperTrade } from '@/lib/api';
import type { Trade } from '@/types';

const SPORT_COLOR: Record<string, string> = {
  MLB: '#002d72', NBA: '#c9082a', NHL: '#0066cc',
  MLS: '#005293', EPL: '#3d195b',
};

function sportFromTicker(ticker: string, sport?: string): string {
  const tk = (ticker ?? '').toUpperCase();
  if (tk.includes('MLB') || sport === 'mlb') return 'MLB';
  if (tk.includes('NHL') || sport === 'nhl') return 'NHL';
  if (tk.includes('NBA') || sport === 'nba') return 'NBA';
  if (tk.includes('MLS') || sport === 'mls') return 'MLS';
  return 'OTHER';
}

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isToday(ts: string): boolean {
  const d = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return d === todayET();
}

function RealBetRow({ t, expanded, onToggle }: { t: Trade; expanded: boolean; onToggle: () => void }) {
  const sport = sportFromTicker(t.ticker);
  const sportColor = SPORT_COLOR[sport] ?? '#4B4B5E';

  const isOpen = t.status === 'open';
  const isWin = t.status === 'settled' && (t.realizedPnL ?? 0) >= 0;
  const isLoss = t.status === 'settled' && (t.realizedPnL ?? 0) < 0;

  const statusLabel = isOpen ? 'LIVE' : isWin ? 'WIN' : isLoss ? 'LOSS' : t.status.replace('closed-manual', 'SOLD').toUpperCase();
  const statusColor = isOpen ? 'var(--green)' : isWin ? 'var(--green)' : isLoss ? 'var(--red)' : 'var(--text-secondary)';
  const statusBg = isOpen ? 'rgba(34,197,94,0.15)' : isWin ? 'rgba(34,197,94,0.15)' : isLoss ? 'rgba(239,68,68,0.15)' : 'var(--bg-elevated)';

  return (
    <div
      onClick={onToggle}
      style={{
        background: 'var(--bg-base)', borderRadius: 8, cursor: 'pointer',
        border: '1px solid rgba(34,197,94,0.2)',
        borderLeft: '3px solid var(--green)',
        padding: '10px 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
          background: sportColor, color: '#fff', letterSpacing: '0.04em', flexShrink: 0,
        }}>{sport}</span>
        <span style={{
          fontSize: 13, fontWeight: 600, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--text-primary)',
        }}>{t.title}</span>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
          color: statusColor, background: statusBg, letterSpacing: '0.05em', flexShrink: 0,
        }}>{statusLabel}</span>
      </div>

      <div className="font-mono" style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)', flexWrap: 'wrap' }}>
        <span>entry <span style={{ color: 'var(--text-secondary)' }}>{Math.round(t.entryPrice * 100)}¢</span></span>
        <span>conf <span style={{ color: 'var(--text-secondary)' }}>{Math.round((t.confidence ?? 0) * 100)}%</span></span>
        {t.edge != null && (
          <span>edge <span style={{ color: t.edge >= 5 ? 'var(--green)' : 'var(--text-secondary)' }}>{t.edge.toFixed(1)}%</span></span>
        )}
        {t.realizedPnL != null && (
          <span style={{ marginLeft: 'auto', color: (t.realizedPnL ?? 0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
            {(t.realizedPnL ?? 0) >= 0 ? '+' : ''}${t.realizedPnL.toFixed(2)}
          </span>
        )}
      </div>

      {expanded && t.reasoning ? (
        <div style={{
          marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)',
          fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, fontStyle: 'italic',
        }}>{t.reasoning}</div>
      ) : t.reasoning ? (
        <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-tertiary)' }}>tap for reasoning ↓</div>
      ) : null}
    </div>
  );
}

function PaperPickRow({ t, expanded, onToggle }: { t: PaperTrade; expanded: boolean; onToggle: () => void }) {
  const sport = sportFromTicker(t.ticker ?? '', t.sport);
  const sportColor = SPORT_COLOR[sport] ?? '#4B4B5E';

  const isPending = t.status === 'pending';
  const isWon = t.status === 'won';
  const isLost = t.status === 'lost';

  const statusLabel = isPending ? 'PAPER' : isWon ? 'WON' : 'LOST';
  const statusColor = isPending ? 'var(--amber)' : isWon ? 'var(--green)' : 'var(--red)';
  const statusBg = isPending ? 'rgba(245,158,11,0.12)' : isWon ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';

  return (
    <div
      onClick={onToggle}
      style={{
        background: 'var(--bg-base)', borderRadius: 8, cursor: 'pointer',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${sportColor}`,
        padding: '10px 12px', opacity: 0.88,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
          background: sportColor, color: '#fff', letterSpacing: '0.04em', flexShrink: 0,
        }}>{sport}</span>
        <span style={{
          fontSize: 13, fontWeight: 600, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--text-primary)',
        }}>{t.teamName} vs {t.opponentName}</span>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
          color: statusColor, background: statusBg, letterSpacing: '0.05em', flexShrink: 0,
        }}>{statusLabel}</span>
      </div>

      <div className="font-mono" style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)', flexWrap: 'wrap' }}>
        <span>would <span style={{ color: 'var(--text-secondary)' }}>{Math.round(t.price * 100)}¢</span></span>
        <span>conf <span style={{ color: 'var(--text-secondary)' }}>{Math.round(t.confidence * 100)}%</span></span>
        <span>edge <span style={{ color: t.edge >= 5 ? 'var(--green)' : 'var(--text-secondary)' }}>{t.edge.toFixed(1)}%</span></span>
        {t.paperPnL != null && (
          <span style={{ marginLeft: 'auto', color: t.paperPnL >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
            {t.paperPnL >= 0 ? '+' : ''}${t.paperPnL.toFixed(2)} paper
          </span>
        )}
      </div>

      {expanded && t.reasoning ? (
        <div style={{
          marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)',
          fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, fontStyle: 'italic',
        }}>{t.reasoning}</div>
      ) : t.reasoning ? (
        <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-tertiary)' }}>tap for reasoning ↓</div>
      ) : null}
    </div>
  );
}

export default function PreGameStrip() {
  const { trades } = useArbor();
  const [paperTrades, setPaperTrades] = useState<PaperTrade[]>([]);
  const [loadingPaper, setLoadingPaper] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    api.getPaperTrades(today)
      .then(t => setPaperTrades(t))
      .catch(() => {})
      .finally(() => setLoadingPaper(false));
  }, []);

  // Real pre-game bets placed today (strategy = pre-game-prediction)
  const realBets = useMemo(
    () => trades.filter(t => t.strategy === 'pre-game-prediction' && isToday(t.timestamp)),
    [trades],
  );

  // Tickers that have a real bet — paper picks for these are redundant
  const realTickers = useMemo(() => new Set(realBets.map(t => t.ticker)), [realBets]);

  // Paper picks today that didn't turn into a real bet
  const paperOnly = useMemo(
    () => paperTrades.filter(t => !realTickers.has(t.ticker)),
    [paperTrades, realTickers],
  );

  const total = realBets.length + paperOnly.length;

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Don't render at all until we at least know if there's anything to show
  if (!loadingPaper && total === 0) return null;

  return (
    <section style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 14 }}>🧪</span>
        <span className="label">PRE-GAME TODAY</span>
        {realBets.length > 0 && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
            background: 'rgba(34,197,94,0.15)', color: 'var(--green)', letterSpacing: '0.06em',
          }}>{realBets.length} LIVE BET{realBets.length !== 1 ? 'S' : ''}</span>
        )}
        {paperOnly.length > 0 && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
            background: 'rgba(245,158,11,0.12)', color: 'var(--amber)', letterSpacing: '0.06em',
          }}>{paperOnly.length} PAPER</span>
        )}
        {loadingPaper && total === 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Loading…</span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {realBets.map(t => (
          <RealBetRow
            key={t.id}
            t={t}
            expanded={expanded.has(t.id)}
            onToggle={() => toggle(t.id)}
          />
        ))}
        {paperOnly.map(t => (
          <PaperPickRow
            key={t.id}
            t={t}
            expanded={expanded.has(t.id)}
            onToggle={() => toggle(t.id)}
          />
        ))}
      </div>
    </section>
  );
}
