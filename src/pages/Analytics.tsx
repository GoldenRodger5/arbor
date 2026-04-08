import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';
import { pnlData, categoryData, spreadDistribution, tradeHistory, type TradeStatus, type Verdict } from '@/data/mock';
import { useIsMobile } from '@/hooks/use-mobile';

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const colors: Record<Verdict, string> = { SAFE: 'var(--green)', CAUTION: 'var(--amber)', SKIP: 'var(--red)' };
  const c = colors[verdict];
  return (
    <span className="font-mono" style={{ fontSize: 10, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 6, color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` }}>
      {verdict}
    </span>
  );
}

function StatusBadge({ status }: { status: TradeStatus }) {
  const colors: Record<TradeStatus, string> = { SETTLED: 'var(--green)', OPEN: 'var(--accent)', DISPUTED: 'var(--amber)' };
  const c = colors[status];
  return (
    <span className="font-mono" style={{ fontSize: 10, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 6, color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` }}>
      {status}
    </span>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', padding: '8px 12px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</div>
      <div className="font-mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>${payload[0].value.toFixed(2)}</div>
    </div>
  );
};

export default function Analytics() {
  const [range, setRange] = useState<'7D' | '30D' | 'ALL'>('30D');
  const isMobile = useIsMobile();

  const ranges: ('7D' | '30D' | 'ALL')[] = ['7D', '30D', 'ALL'];

  const stats = [
    { label: 'TOTAL P&L', value: '+$284.50', color: 'var(--green)', sub: 'Since inception' },
    { label: 'WIN RATE', value: '73%', color: 'var(--text-primary)', sub: '22 of 30 trades' },
    { label: 'AVG SPREAD', value: '3.2%', color: 'var(--text-primary)', sub: 'After fees' },
    { label: 'DEPLOYED', value: '$340', color: 'var(--text-primary)', sub: 'of $500 capital', progress: 68 },
  ];

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-tertiary)', fontWeight: 500, borderBottom: '1px solid var(--border)' };
  const td: React.CSSProperties = { padding: '0 8px', height: 44, borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };

  const chartData = range === '7D' ? pnlData.slice(-7) : range === '30D' ? pnlData : pnlData;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Analytics</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {ranges.map((r) => (
            <button key={r} onClick={() => setRange(r)} style={{ background: 'none', border: 'none', color: range === r ? 'var(--text-primary)' : 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 24 }}>
        {stats.map((s) => (
          <div key={s.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 20, borderRadius: 6 }}>
            <div className="label">{s.label}</div>
            <div className="font-mono" style={{ fontSize: 28, fontWeight: 600, color: s.color, marginTop: 4 }}>{s.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{s.sub}</div>
            {s.progress !== undefined && (
              <div style={{ marginTop: 8, height: 4, background: 'var(--bg-elevated)', borderRadius: 2, width: '100%' }}>
                <div style={{ height: '100%', width: `${s.progress}%`, background: 'var(--accent)', borderRadius: 2 }} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* P&L Chart */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 20, borderRadius: 6, marginBottom: 24 }}>
        <ResponsiveContainer width="100%" height={isMobile ? 180 : 240}>
          <LineChart data={chartData}>
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} interval={4} />
            <YAxis tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} orientation="right" />
            <Tooltip content={<CustomTooltip />} />
            <Line type="monotone" dataKey="pnl" stroke="var(--accent)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Category + Distribution */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 20, borderRadius: 6 }}>
          <div className="label" style={{ marginBottom: 12 }}>OPPORTUNITIES BY CATEGORY</div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={categoryData} layout="vertical">
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="category" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} axisLine={false} tickLine={false} width={80} />
              <Bar dataKey="count" radius={[0, 2, 2, 0]}>
                {categoryData.map((_, i) => (
                  <Cell key={i} fill="var(--accent)" fillOpacity={0.3 + (i * 0.12)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 20, borderRadius: 6 }}>
          <div className="label" style={{ marginBottom: 12 }}>SPREAD DISTRIBUTION</div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={spreadDistribution}>
              <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
              <Bar dataKey="count" fill="var(--green)" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Trade History */}
      <div className="label" style={{ marginBottom: 12 }}>TRADE HISTORY</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Date</th>
              <th style={th}>Event</th>
              <th style={th}>Verdict</th>
              <th style={th}>Spread</th>
              <th style={th}>P&L</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {tradeHistory.map((t, i) => (
              <tr key={i} className="table-row-hover">
                <td style={{ ...td, fontSize: 12, color: 'var(--text-tertiary)' }}>{t.date}</td>
                <td style={{ ...td, fontSize: 13, color: 'var(--text-primary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.event}</td>
                <td style={td}><VerdictBadge verdict={t.verdict} /></td>
                <td className="font-mono" style={{ ...td, fontSize: 13, color: 'var(--text-secondary)' }}>{t.spread.toFixed(1)}%</td>
                <td className="font-mono" style={{ ...td, fontSize: 13, color: t.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {t.pnl >= 0 ? '+' : ''}${Math.abs(t.pnl).toFixed(2)}
                </td>
                <td style={td}><StatusBadge status={t.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <style>{`.table-row-hover:hover { background: var(--bg-elevated); transition: background 100ms; }`}</style>
    </div>
  );
}
