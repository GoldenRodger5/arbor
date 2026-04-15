import { useEffect, useState } from 'react';
import { api, type LiveInsightData } from '@/lib/api';

const LEAGUE_COLOR: Record<string, string> = {
  mlb: '#002d72', nba: '#c9082a', nhl: '#0066cc',
  mls: '#005293', epl: '#3d195b', laliga: '#ff4b00',
};

const RESULT_META: Record<string, { label: string; color: string; bg: string }> = {
  'TRADE':               { label: '🎯 TRADED', color: '#fff', bg: 'var(--green)' },
  'pass':                { label: 'PASSED',    color: 'var(--red)', bg: 'rgba(239,68,68,0.12)' },
  'skip-we-floor':       { label: 'WE LOW',    color: 'var(--amber)', bg: 'rgba(245,158,11,0.12)' },
  'skip-price-ceiling':  { label: 'PRICE HIGH', color: 'var(--amber)', bg: 'rgba(245,158,11,0.12)' },
  'skip-has-position':   { label: 'HELD',      color: 'var(--accent)', bg: 'rgba(99,102,241,0.12)' },
  'skip-conf-low':       { label: 'LOW CONF',  color: 'var(--amber)', bg: 'rgba(245,158,11,0.12)' },
  'skip-contra-move':    { label: 'CONTRA',    color: 'var(--red)', bg: 'rgba(239,68,68,0.12)' },
  'skip-mlb-1run-late':  { label: 'EDGE THIN', color: 'var(--amber)', bg: 'rgba(245,158,11,0.12)' },
};

export default function LiveScouting() {
  const [data, setData] = useState<LiveInsightData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const d = await api.getLiveInsight();
      setData(d);
      setErr(null);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 60_000); // refresh every minute
    return () => clearInterval(iv);
  }, []);

  const games = data?.games ?? [];

  return (
    <section style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 14 }}>🔭</span>
        <span className="label">LIVE SCOUTING</span>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
          background: 'rgba(34,197,94,0.15)', color: 'var(--green)',
          letterSpacing: '0.06em',
        }}>LIVE</span>
        <div style={{ flex: 1 }} />
        <button onClick={load} disabled={loading} style={{
          background: 'transparent', border: '1px solid var(--border)',
          color: 'var(--text-tertiary)', fontSize: 10, padding: '3px 8px',
          borderRadius: 4, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1,
        }}>{loading ? '…' : '↻'}</button>
      </div>

      {err && <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div>}

      {loading && !data ? (
        <div className="skeleton" style={{ height: 80, borderRadius: 8 }} />
      ) : games.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '8px 0' }}>
          No live games being considered right now.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {games.map(g => {
            const meta = RESULT_META[g.result] ?? { label: g.result, color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' };
            const leagueColor = LEAGUE_COLOR[g.league ?? ''] ?? 'var(--text-tertiary)';
            return (
              <div key={g.gameKey} style={{
                padding: '10px 12px', background: 'var(--bg-base)', borderRadius: 8,
                border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                    background: leagueColor, color: '#fff', letterSpacing: '0.04em',
                  }}>{(g.league ?? '?').toUpperCase()}</span>
                  <span className="font-mono" style={{ fontSize: 13, fontWeight: 600 }}>
                    {g.score ?? `${g.away} @ ${g.home}`}
                  </span>
                  {g.gameDetail && (
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                      {g.gameDetail}
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                    color: meta.color, background: meta.bg, letterSpacing: '0.04em',
                  }}>{meta.label}</span>
                </div>

                <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6 }}>
                  {g.targetAbbr && <span>target={g.targetAbbr} </span>}
                  {g.price != null && <span>· price={g.price}¢ </span>}
                  {g.winExpectancy != null && <span>· WE={g.winExpectancy}% </span>}
                  {g.confidence != null && <span>· conf={g.confidence}% </span>}
                </div>

                {g.reasoning && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, fontStyle: 'italic' }}>
                    {g.reasoning}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {data?.insight && (
        <div style={{
          marginTop: 12, padding: 12, borderRadius: 8,
          background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(99,102,241,0.02))',
          border: '1px solid rgba(99,102,241,0.25)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 12 }}>🧠</span>
            <span className="label" style={{ color: 'var(--accent)', fontSize: 10 }}>
              CLAUDE'S READ
            </span>
          </div>
          <div style={{
            fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6,
          }}>
            {data.insight}
          </div>
        </div>
      )}
    </section>
  );
}
