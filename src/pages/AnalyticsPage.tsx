import { useArbor } from '@/context/ArborContext';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, ScatterChart, Scatter, CartesianGrid,
  AreaChart, Area,
} from 'recharts';

const COLORS = ['#6366F1', '#22C55E', '#EF4444', '#F59E0B', '#06B6D4', '#EC4899', '#8B5CF6'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <div className="label" style={{ marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );
}

export default function AnalyticsPage() {
  const { stats, snapshots, trades } = useArbor();
  const s = stats ?? {};

  // Sport performance chart data
  const sportData = (s.sportPerformance ?? []).map((sp: any) => ({
    ...sp,
    sport: sp.sport?.toUpperCase(),
    fill: sp.pnl >= 0 ? 'var(--green)' : 'var(--red)',
  }));

  // Strategy pie data
  const stratData = (s.strategyPerformance ?? []).map((st: any, i: number) => ({
    name: st.strategy?.replace('-prediction', '').replace('-', ' '),
    value: st.trades,
    pnl: st.pnl,
    winRate: st.winRate,
    fill: COLORS[i % COLORS.length],
  }));

  // Calibration scatter data
  const calData = (s.calibration ?? []).map((b: any) => ({
    predicted: (b.min + b.max) / 2 * 100,
    actual: b.actualWinRate,
    total: b.total,
    label: b.label,
  }));

  // Bankroll chart
  const bankrollData = snapshots.map(sn => ({
    date: sn.date?.slice(5),
    bankroll: sn.bankroll,
    pnl: sn.totalPnL,
  }));

  // Time distribution
  const hourMap: Record<number, { trades: number; wins: number; pnl: number }> = {};
  for (const t of trades) {
    const hr = new Date(t.timestamp).getHours();
    if (!hourMap[hr]) hourMap[hr] = { trades: 0, wins: 0, pnl: 0 };
    hourMap[hr].trades++;
    if (t.status === 'settled' && (t.realizedPnL ?? 0) > 0) hourMap[hr].wins++;
    if (t.realizedPnL != null) hourMap[hr].pnl += t.realizedPnL;
  }
  const hourData = Object.entries(hourMap).map(([hr, d]) => ({
    hour: `${hr}:00`,
    trades: d.trades,
    pnl: Math.round(d.pnl * 100) / 100,
  })).sort((a, b) => parseInt(a.hour) - parseInt(b.hour));

  const tooltipStyle = {
    contentStyle: { background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 },
    labelStyle: { color: 'var(--text-secondary)' },
  };

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Analytics</h1>

      {/* Bankroll Growth */}
      {bankrollData.length > 0 && (
        <Section title="BANKROLL GROWTH">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={bankrollData}>
              <defs>
                <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366F1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366F1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} tickFormatter={v => `$${v}`} />
              <Tooltip {...tooltipStyle} formatter={(v: number) => [`$${v.toFixed(2)}`]} />
              <Area type="monotone" dataKey="bankroll" stroke="#6366F1" fill="url(#bg)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* Sport Performance */}
      {sportData.length > 0 && (
        <Section title="PERFORMANCE BY SPORT">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>Win Rate</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={sportData}>
                  <XAxis dataKey="sport" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} tickFormatter={v => `${v}%`} />
                  <Tooltip {...tooltipStyle} formatter={(v: number) => [`${v}%`]} />
                  <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                    {sportData.map((d: any, i: number) => (
                      <Cell key={i} fill={d.winRate >= 55 ? 'var(--green)' : d.winRate >= 45 ? 'var(--amber)' : 'var(--red)'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>P&L ($)</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={sportData}>
                  <XAxis dataKey="sport" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} tickFormatter={v => `$${v}`} />
                  <Tooltip {...tooltipStyle} formatter={(v: number) => [`$${v.toFixed(2)}`]} />
                  <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                    {sportData.map((d: any, i: number) => (
                      <Cell key={i} fill={d.pnl >= 0 ? 'var(--green)' : 'var(--red)'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          {/* Sport table */}
          <div style={{ marginTop: 12 }}>
            {sportData.map((sp: any) => (
              <div key={sp.sport} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                <span style={{ fontWeight: 500 }}>{sp.sport}</span>
                <span className="font-mono">{sp.trades} trades | {sp.winRate}% win | <span style={{ color: sp.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{sp.pnl >= 0 ? '+' : ''}${sp.pnl.toFixed(2)}</span></span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Calibration */}
      {calData.length > 0 && (
        <Section title="CONFIDENCE CALIBRATION">
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Dots on the diagonal = perfectly calibrated. Above = underconfident (good). Below = overconfident (bad).
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="predicted" name="Predicted" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} label={{ value: 'Predicted %', position: 'bottom', fontSize: 11, fill: 'var(--text-tertiary)' }} />
              <YAxis dataKey="actual" name="Actual" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} label={{ value: 'Actual Win %', angle: -90, position: 'left', fontSize: 11, fill: 'var(--text-tertiary)' }} />
              <Tooltip {...tooltipStyle} formatter={(v: number, name: string) => [`${v}%`, name]} />
              <Scatter data={calData} fill="var(--accent)">
                {calData.map((d: any, i: number) => (
                  <Cell key={i} fill={d.actual >= d.predicted ? 'var(--green)' : 'var(--red)'} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--text-tertiary)', justifyContent: 'center' }}>
            {calData.map((b: any) => (
              <span key={b.label}>
                {b.label}: <span className="font-mono" style={{ color: b.actual >= b.predicted ? 'var(--green)' : 'var(--red)' }}>
                  {b.actual}%
                </span> ({b.total} trades)
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* Strategy Breakdown */}
      {stratData.length > 0 && (
        <Section title="STRATEGY BREAKDOWN">
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <ResponsiveContainer width={180} height={180}>
              <PieChart>
                <Pie data={stratData} dataKey="value" cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={2}>
                  {stratData.map((d: any, i: number) => (
                    <Cell key={i} fill={d.fill} />
                  ))}
                </Pie>
                <Tooltip {...tooltipStyle} formatter={(v: number, name: string) => [v, name]} />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ flex: 1 }}>
              {stratData.map((st: any) => (
                <div key={st.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: st.fill, flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{st.name}</span>
                  <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{st.value} trades</span>
                  <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{st.winRate}%</span>
                  <span className="font-mono" style={{ color: st.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {st.pnl >= 0 ? '+' : ''}${st.pnl.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {/* Trading Hours */}
      {hourData.length > 0 && (
        <Section title="PERFORMANCE BY HOUR (ET)">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={hourData}>
              <XAxis dataKey="hour" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} tickFormatter={v => `$${v}`} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {hourData.map((d, i) => (
                  <Cell key={i} fill={d.pnl >= 0 ? 'var(--green)' : 'var(--red)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Section>
      )}
    </div>
  );
}
