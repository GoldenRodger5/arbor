import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Decision {
  timestamp: string;
  result: string;
  reasoning: string | null;
  confidence: number | null;
  price: number | null;
  winExpectancy: number | null;
  targetAbbr: string | null;
  homeScore: number | null;
  awayScore: number | null;
  period: number | null;
  gameDetail: string | null;
}

interface Game {
  gameKey: string;
  league: string | null;
  homeAbbr: string | null;
  awayAbbr: string | null;
  lastSeen: string;
  lastScore: string | null;
  lastDetail: string | null;
  decisions: Decision[];
}

const RESULT_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  'TRADE':            { label: 'TRADE',       color: '#fff',               bg: 'var(--green)' },
  'pass':             { label: 'NO',          color: 'var(--red)',         bg: 'rgba(239,68,68,0.12)' },
  'skip-we-floor':    { label: 'WE FLOOR',    color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' },
  'skip-price-ceiling': { label: 'TOO PRICED', color: 'var(--amber)',      bg: 'rgba(245,158,11,0.12)' },
  'skip-has-position': { label: 'HELD',       color: 'var(--accent)',      bg: 'rgba(99,102,241,0.12)' },
  'skip-conf-low':    { label: 'CONF LOW',    color: 'var(--amber)',       bg: 'rgba(245,158,11,0.12)' },
};

const LEAGUE_COLORS: Record<string, string> = {
  nhl: '#0066cc', nba: '#c9082a', mlb: '#002d72', mls: '#005293',
  epl: '#3d195b', laliga: '#ff4b00',
};

function timeAgo(ts: string): string {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export default function GamesPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  useEffect(() => {
    const fetch = async () => {
      try {
        const data = await api.getGames();
        setGames(data);
        setLastRefresh(Date.now());
      } catch {}
      finally { setLoading(false); }
    };
    fetch();
    const iv = setInterval(fetch, 15000);
    return () => clearInterval(iv);
  }, []);

  // Summary counts
  const tradeCount = games.reduce((n, g) => n + g.decisions.filter(d => d.result === 'TRADE').length, 0);
  const noCount = games.reduce((n, g) => n + g.decisions.filter(d => d.result === 'pass').length, 0);
  const skipCount = games.reduce((n, g) => n + g.decisions.filter(d => d.result.startsWith('skip-')).length, 0);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Games Intelligence</h1>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
            Last 8 hours · Updated {timeAgo(new Date(lastRefresh).toISOString())}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          {[
            { label: 'TRADES', val: tradeCount, color: 'var(--green)' },
            { label: 'NO', val: noCount, color: 'var(--red)' },
            { label: 'SKIPPED', val: skipCount, color: 'var(--text-tertiary)' },
          ].map(({ label, val, color }) => (
            <div key={label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace' }}>{val}</div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {loading && (
        <div style={{ color: 'var(--text-tertiary)', padding: 40, textAlign: 'center' }}>Loading games...</div>
      )}

      {!loading && games.length === 0 && (
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
          padding: 40, textAlign: 'center', color: 'var(--text-tertiary)',
        }}>
          No game decisions in the last 8 hours.<br />
          <span style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
            The bot logs decisions here as it monitors live games.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {games.map(game => {
          const isExpanded = expandedKey === game.gameKey;
          const latestDecision = [...game.decisions].sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          )[0];
          const hasTrade = game.decisions.some(d => d.result === 'TRADE');
          const leagueColor = LEAGUE_COLORS[game.league ?? ''] ?? 'var(--text-tertiary)';

          return (
            <div key={game.gameKey} style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderLeft: hasTrade ? '3px solid var(--green)' : '3px solid var(--border)',
              borderRadius: 10, overflow: 'hidden',
            }}>
              {/* Card header — click to expand */}
              <button
                onClick={() => setExpandedKey(isExpanded ? null : game.gameKey)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                {/* League badge */}
                <span style={{
                  fontSize: 10, fontWeight: 700, color: '#fff', background: leagueColor,
                  padding: '2px 7px', borderRadius: 4, flexShrink: 0, letterSpacing: '0.04em',
                }}>
                  {(game.league ?? '?').toUpperCase()}
                </span>

                {/* Matchup */}
                <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
                  {game.awayAbbr ?? '?'} @ {game.homeAbbr ?? '?'}
                </span>

                {/* Score */}
                {game.lastScore && (
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>
                    {game.lastScore}
                    {game.lastDetail && <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>({game.lastDetail})</span>}
                  </span>
                )}

                {/* Decision count */}
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                  {game.decisions.length} decision{game.decisions.length !== 1 ? 's' : ''}
                </span>

                {/* Latest result badge */}
                {latestDecision && (() => {
                  const s = RESULT_STYLE[latestDecision.result] ?? { label: latestDecision.result, color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' };
                  return (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
                      color: s.color, background: s.bg, flexShrink: 0,
                    }}>
                      {s.label}
                    </span>
                  );
                })()}

                {/* Time */}
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, minWidth: 52 }}>
                  {timeAgo(game.lastSeen)}
                </span>

                {/* Expand chevron */}
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}>
                  ▼
                </span>
              </button>

              {/* Expanded decisions */}
              {isExpanded && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 10 }}>
                    {game.decisions.length} decision{game.decisions.length !== 1 ? 's' : ''} — click to expand each
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[...game.decisions]
                      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                      .map((d, i) => <DecisionCard key={i} d={d} />)
                    }
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DecisionCard({ d }: { d: Decision }) {
  const [expanded, setExpanded] = useState(false);
  const s = RESULT_STYLE[d.result] ?? { label: d.result, color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' };

  return (
    <div style={{
      background: 'var(--bg-elevated)', borderRadius: 8, overflow: 'hidden',
      border: '1px solid var(--border)',
    }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        {/* Result badge */}
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
          color: s.color, background: s.bg, flexShrink: 0, minWidth: 70, textAlign: 'center',
        }}>
          {s.label}
        </span>

        {/* Target team */}
        {d.targetAbbr && (
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>
            {d.targetAbbr}
          </span>
        )}

        {/* Score at time of decision */}
        {d.homeScore != null && d.awayScore != null && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>
            {d.awayScore}–{d.homeScore} {d.gameDetail ?? (d.period != null ? `P${d.period}` : '')}
          </span>
        )}

        {/* Confidence + price */}
        <span style={{ flex: 1, fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-secondary)' }}>
          {d.confidence != null && <span>conf={Math.round(d.confidence * 100)}%</span>}
          {d.price != null && <span style={{ marginLeft: 8 }}>price={Math.round(d.price * 100)}¢</span>}
          {d.winExpectancy != null && <span style={{ marginLeft: 8, color: 'var(--text-tertiary)' }}>WE={Math.round(d.winExpectancy * 100)}%</span>}
        </span>

        {/* Time */}
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
          {fmtTime(d.timestamp)}
        </span>

        {/* Expand */}
        {d.reasoning && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}>▼</span>
        )}
      </button>

      {/* Full reasoning */}
      {expanded && d.reasoning && (
        <div style={{
          borderTop: '1px solid var(--border)', padding: '10px 12px',
          fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
          fontFamily: 'Inter, sans-serif',
        }}>
          {d.reasoning}
        </div>
      )}
    </div>
  );
}
