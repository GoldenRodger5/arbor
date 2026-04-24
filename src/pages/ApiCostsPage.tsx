import { useEffect, useState } from 'react';
import { api, type ApiCostReport } from '@/lib/api';
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

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const WINDOWS: { label: string; hours: number }[] = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
];

export default function ApiCostsPage() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<ApiCostReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = (h: number) => {
    setLoading(true);
    setError(null);
    api.getApiCosts(h)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message ?? 'Failed to load'); setLoading(false); });
  };

  useEffect(() => { load(hours); }, [hours]);

  const maxHourlyCents = data?.hourly.length
    ? Math.max(...data.hourly.map(h => h.cents), 1)
    : 1;

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>API Costs</h1>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 12 }}>
        Real Anthropic token usage · updates on each call
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {WINDOWS.map(w => (
          <button
            key={w.hours}
            onClick={() => { buzz('light'); setHours(w.hours); }}
            style={{
              flex: 1, padding: '8px', borderRadius: 8,
              background: hours === w.hours ? 'var(--accent)' : 'var(--bg-surface)',
              color: hours === w.hours ? 'white' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >{w.label}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="skeleton" style={{ height: 80, borderRadius: 12 }} />
          <div className="skeleton" style={{ height: 140, borderRadius: 12 }} />
          <div className="skeleton" style={{ height: 260, borderRadius: 12 }} />
        </div>
      ) : error ? (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{error}</div>
          <button onClick={() => load(hours)} style={{
            background: 'var(--accent)', color: 'white', border: 'none',
            borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Tap to retry</button>
        </div>
      ) : !data || data.totals.calls === 0 ? (
        <div style={{ color: 'var(--text-tertiary)', padding: 40, textAlign: 'center' }}>
          No API usage recorded in this window yet.
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 8 }}>
            <Stat label="SPEND" value={fmtUsd(data.totals.cents)} color="var(--accent)" />
            <Stat label="CALLS" value={data.totals.calls.toLocaleString()} />
            <Stat label="SEARCHES" value={data.totals.searches.toLocaleString()} />
            <Stat label="AVG/CALL" value={`${(data.totals.cents / data.totals.calls).toFixed(2)}¢`} />
          </div>
          {/* Efficiency row — cost per trade placed */}
          {data.totals.tradesPlaced !== undefined && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
              <Stat
                label="TRADES PLACED"
                value={data.totals.tradesPlaced.toLocaleString()}
              />
              <Stat
                label="COST/TRADE"
                value={data.totals.costPerTradeUsd != null ? fmtUsd((data.totals.costPerTradeCents ?? 0))  : '—'}
                color={data.totals.costPerTradeUsd != null && data.totals.costPerTradeUsd > 5 ? 'var(--red)'
                  : data.totals.costPerTradeUsd != null && data.totals.costPerTradeUsd > 1 ? 'var(--orange)'
                  : 'var(--green)'}
              />
              <Stat
                label={hours >= 168 ? 'AVG/DAY' : hours >= 24 ? 'DAILY RATE' : 'HOURLY RATE'}
                value={fmtUsd(data.totals.cents / (hours / (hours >= 168 ? 24 : hours >= 24 ? 24 : 1)))}
              />
            </div>
          )}

          <section style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 16, marginBottom: 16,
          }}>
            <div className="label" style={{ marginBottom: 10 }}>TOKENS</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              <Stat label="INPUT" value={fmtTok(data.totals.inputTok)} />
              <Stat label="OUTPUT" value={fmtTok(data.totals.outputTok)} />
              <Stat label="CACHE R" value={fmtTok(data.totals.cacheReadTok)} />
              <Stat label="CACHE W" value={fmtTok(data.totals.cacheWriteTok)} />
            </div>
          </section>

          {/* Daily chart + table — for 7d/30d windows, per-day view is more useful than hourly */}
          {hours >= 168 && data.daily && data.daily.length > 0 && (
            <>
              <section style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                borderRadius: 12, padding: 16, marginBottom: 16,
              }}>
                <div className="label" style={{ marginBottom: 10 }}>DAILY SPEND</div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
                  {data.daily.map(d => {
                    const maxDaily = Math.max(...(data.daily ?? []).map(x => x.cents), 1);
                    const pct = Math.max(3, (d.cents / maxDaily) * 100);
                    const label = new Date(d.day + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    return (
                      <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <div
                          title={`${label} · ${fmtUsd(d.cents)} · ${d.calls} calls · top: ${d.topCategory}`}
                          style={{
                            width: '100%',
                            height: `${pct}%`,
                            background: 'linear-gradient(to top, var(--accent), rgba(99,102,241,0.5))',
                            borderRadius: 3,
                            minHeight: 3,
                          }}
                        />
                        <div style={{ fontSize: 9, color: 'var(--text-tertiary)', writingMode: data.daily!.length > 14 ? 'vertical-rl' as any : 'horizontal-tb' as any }}>
                          {label}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                borderRadius: 12, padding: 16, marginBottom: 16, overflowX: 'auto',
              }}>
                <div className="label" style={{ marginBottom: 10 }}>DAILY BREAKDOWN</div>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border)' }}>
                      <th style={{ padding: '6px 8px' }}>Date</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Calls</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Searches</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>In Tok</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Out Tok</th>
                      <th style={{ padding: '6px 8px' }}>Top Category</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.daily].reverse().map(d => (
                      <tr key={d.day} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 600 }}>{new Date(d.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>{d.calls}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>{d.searches}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text-tertiary)' }}>{fmtTok(d.inputTok)}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text-tertiary)' }}>{fmtTok(d.outputTok)}</td>
                        <td style={{ padding: '6px 8px', fontSize: 10, color: 'var(--text-secondary)' }}>{d.topCategory.replace('pre-game-', 'pg-').replace('live-', 'lv-')}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700, color: d.cents > 2000 ? 'var(--red)' : d.cents > 800 ? 'var(--orange)' : 'var(--accent)' }}>
                          {fmtUsd(d.cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}

          {/* Hourly chart — shown for short windows (6h/24h) or as fallback */}
          {hours < 168 && data.hourly.length > 1 && (
            <section style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 16, marginBottom: 16,
            }}>
              <div className="label" style={{ marginBottom: 10 }}>HOURLY SPEND</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 100 }}>
                {data.hourly.map(h => {
                  const pct = Math.max(2, (h.cents / maxHourlyCents) * 100);
                  return (
                    <div
                      key={h.hour}
                      title={`${new Date(h.hour).toLocaleString()} · ${fmtUsd(h.cents)} · ${h.calls} calls`}
                      style={{
                        flex: 1,
                        height: `${pct}%`,
                        background: 'linear-gradient(to top, var(--accent), rgba(99,102,241,0.5))',
                        borderRadius: 2,
                        minHeight: 2,
                      }}
                    />
                  );
                })}
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6,
              }}>
                <span>{new Date(data.hourly[0].hour).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' })}</span>
                <span>peak {fmtUsd(maxHourlyCents)}/hr</span>
                <span>{new Date(data.hourly[data.hourly.length - 1].hour).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' })}</span>
              </div>
            </section>
          )}

          {/* Per-category breakdown */}
          <section style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 16,
          }}>
            <div className="label" style={{ marginBottom: 10 }}>BY CATEGORY</div>
            {data.byCategory.map(c => {
              const pctOfTotal = data.totals.cents > 0 ? (c.cents / data.totals.cents) * 100 : 0;
              return (
                <div key={c.category} style={{
                  padding: '10px 0', borderBottom: '1px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{c.category}</span>
                    <span className="font-mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>
                      {fmtUsd(c.cents)}
                    </span>
                  </div>
                  <div style={{
                    height: 4, background: 'var(--bg-base)', borderRadius: 2, overflow: 'hidden', marginBottom: 6,
                  }}>
                    <div style={{
                      height: '100%', width: `${pctOfTotal}%`,
                      background: 'var(--accent)', borderRadius: 2,
                    }} />
                  </div>
                  <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {c.calls} calls · {fmtTok(c.inputTok)} in · {fmtTok(c.outputTok)} out
                    {c.searches > 0 ? ` · ${c.searches} 🔍` : ''}
                    {c.cacheReadTok > 0 ? ` · ${fmtTok(c.cacheReadTok)} cache-r` : ''}
                    {' · '}{pctOfTotal.toFixed(1)}%
                  </div>
                </div>
              );
            })}
          </section>

          <div style={{ marginTop: 16, fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center' }}>
            Window: last {data.windowHours}h
          </div>
        </>
      )}
    </div>
  );
}
