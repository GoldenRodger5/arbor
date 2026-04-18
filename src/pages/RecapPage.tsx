import { useEffect, useState } from 'react';
import { api, type RecapData } from '@/lib/api';
import { buzz } from '@/lib/notify';

function Stat({ label, value, color = 'var(--text-primary)' }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{
      background: 'var(--bg-base)', borderRadius: 10, padding: '12px 14px', textAlign: 'center',
    }}>
      <div className="label" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div className="font-mono" style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

export default function RecapPage() {
  const [period, setPeriod] = useState<'daily' | 'weekly'>('daily');
  const [data, setData] = useState<RecapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = (p: 'daily' | 'weekly') => {
    setLoading(true);
    setError(null);
    api.getRecap(p)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message ?? 'Failed to load'); setLoading(false); });
  };

  useEffect(() => { load(period); }, [period]);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>Recap</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['daily', 'weekly'] as const).map(p => (
          <button key={p} onClick={() => { buzz('light'); setPeriod(p); }} style={{
            flex: 1, padding: '10px', borderRadius: 8,
            background: period === p ? 'var(--accent)' : 'var(--bg-surface)',
            color: period === p ? 'white' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
          }}>{p}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="skeleton" style={{ height: 80, borderRadius: 12 }} />
          <div className="skeleton" style={{ height: 120, borderRadius: 12 }} />
        </div>
      ) : error ? (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{error}</div>
          <button onClick={() => load(period)} style={{
            background: 'var(--accent)', color: 'white', border: 'none',
            borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Tap to retry</button>
        </div>
      ) : !data ? (
        <div style={{ color: 'var(--text-tertiary)', padding: 40, textAlign: 'center' }}>No data available for this period</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 12 }}>
            {new Date(data.start).toLocaleDateString()} → {new Date(data.end).toLocaleDateString()}
          </div>

          {/* Hero stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
            <Stat
              label="P&L"
              value={`${data.totalPnL >= 0 ? '+' : ''}$${data.totalPnL.toFixed(2)}`}
              color={data.totalPnL >= 0 ? 'var(--green)' : 'var(--red)'}
            />
            <Stat label="W–L" value={`${data.wins}–${data.losses}`} />
            <Stat label="WIN%" value={data.winRate != null ? `${data.winRate}%` : '—'} color={(data.winRate ?? 0) >= 55 ? 'var(--green)' : 'var(--amber)'} />
            <Stat label="PLACED" value={data.placed} />
          </div>

          {/* AI commentary */}
          {data.commentary && (
            <section style={{
              background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(99,102,241,0.02))',
              border: '1px solid rgba(99,102,241,0.25)', borderRadius: 12,
              padding: 16, marginBottom: 16,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 16 }}>🧠</span>
                <span className="label" style={{ color: 'var(--accent)' }}>CLAUDE\'S TAKE</span>
              </div>
              <div style={{
                fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
              }}>
                {data.commentary}
              </div>
            </section>
          )}

          {/* Best / worst */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            {data.best && (
              <div style={{
                background: 'var(--bg-surface)', border: '1px solid rgba(34,197,94,0.3)',
                borderRadius: 10, padding: 12,
              }}>
                <div className="label" style={{ color: 'var(--green)', marginBottom: 4 }}>🏆 BEST</div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {data.best.title}
                </div>
                <div className="font-mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)' }}>
                  +${data.best.pnl.toFixed(2)}
                </div>
              </div>
            )}
            {data.worst && (
              <div style={{
                background: 'var(--bg-surface)', border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 10, padding: 12,
              }}>
                <div className="label" style={{ color: 'var(--red)', marginBottom: 4 }}>💀 WORST</div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {data.worst.title}
                </div>
                <div className="font-mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--red)' }}>
                  ${data.worst.pnl.toFixed(2)}
                </div>
              </div>
            )}
          </div>

          {/* Sport breakdown */}
          {data.sportBreakdown.length > 0 && (
            <section style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 16,
            }}>
              <div className="label" style={{ marginBottom: 10 }}>BY SPORT</div>
              {data.sportBreakdown.map(sp => (
                <div key={sp.sport} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13,
                }}>
                  <span style={{ fontWeight: 600, textTransform: 'uppercase' }}>{sp.sport}</span>
                  <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                    {sp.trades} · {sp.winRate}% ·
                    {' '}<span style={{ color: sp.pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      {sp.pnl >= 0 ? '+' : ''}${sp.pnl.toFixed(2)}
                    </span>
                  </span>
                </div>
              ))}
            </section>
          )}

          <div style={{ marginTop: 16, fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center' }}>
            Generated {new Date(data.generatedAt).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
