import { useMemo, useState } from 'react';
import { useArbor } from '@/context/ArborContext';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, ScatterChart, Scatter, CartesianGrid,
  AreaChart, Area,
} from 'recharts';
import BottomSheet from '@/components/BottomSheet';
import TradeCard from '@/components/TradeCard';
import { buzz } from '@/lib/notify';

const COLORS = ['#6366F1', '#22C55E', '#EF4444', '#F59E0B', '#06B6D4', '#EC4899', '#8B5CF6'];

type Timeframe = 'today' | '7d' | '30d' | 'all';
const TIMEFRAMES: { key: Timeframe; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All' },
];

// "Today" means America/New_York today — the user operates on ET, not UTC.
function etMidnightTodayMs(): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const offsetStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = parseInt(offsetStr.replace('GMT', '')) || -5;
  return Date.UTC(
    parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day),
  ) - offsetHours * 3600_000;
}

function tfStart(tf: Timeframe): number {
  const now = new Date();
  if (tf === 'today') return etMidnightTodayMs();
  if (tf === '7d') return now.getTime() - 7 * 864e5;
  if (tf === '30d') return now.getTime() - 30 * 864e5;
  return 0;
}

function sportOf(t: any): string {
  const tk = (t.ticker ?? '').toUpperCase();
  if (tk.includes('MLB')) return 'MLB';
  if (tk.includes('NBA')) return 'NBA';
  if (tk.includes('NHL')) return 'NHL';
  if (tk.includes('MLS') || tk.includes('EPL') || tk.includes('LALIGA')) return 'Soccer';
  if (t.strategy === 'ufc-prediction') return 'UFC';
  return 'Other';
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 20, marginBottom: 16,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div className="label">{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function AnalyticsPage() {
  const { trades } = useArbor();
  const [tf, setTf] = useState<Timeframe>('7d');
  const [drill, setDrill] = useState<{ title: string; subtitle?: string; trades: any[] } | null>(null);
  const [calSport, setCalSport] = useState<string>('all');
  const [calDay, setCalDay] = useState<string>('all');

  const start = tfStart(tf);
  const filtered = useMemo(() => trades.filter(t => new Date(t.timestamp).getTime() >= start), [trades, start]);
  const settled = useMemo(() => filtered.filter(t => t.status === 'settled' || t.status?.startsWith('sold-')), [filtered]);

  // ─── Derived analytics (filtered to timeframe) ─────────────────────────────
  const totalPnL = settled.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
  const wins = settled.filter(t => (t.realizedPnL ?? 0) > 0).length;
  const winRate = settled.length ? Math.round((wins / settled.length) * 100) : 0;

  // Daily PnL series
  const dailySeries = useMemo(() => {
    const map: Record<string, number> = {};
    for (const t of settled) {
      const d = new Date(t.settledAt ?? t.timestamp).toISOString().slice(5, 10);
      map[d] = (map[d] ?? 0) + (t.realizedPnL ?? 0);
    }
    const entries = Object.entries(map).sort();
    let running = 0;
    return entries.map(([date, pnl]) => { running += pnl; return { date, pnl: Math.round(pnl * 100) / 100, running: Math.round(running * 100) / 100 }; });
  }, [settled]);

  // Per-sport
  const sportData = useMemo(() => {
    const map: Record<string, { sport: string; trades: number; wins: number; pnl: number }> = {};
    for (const t of settled) {
      const s = sportOf(t);
      if (!map[s]) map[s] = { sport: s, trades: 0, wins: 0, pnl: 0 };
      map[s].trades++;
      if ((t.realizedPnL ?? 0) > 0) map[s].wins++;
      map[s].pnl += t.realizedPnL ?? 0;
    }
    return Object.values(map).map(s => ({ ...s, pnl: Math.round(s.pnl * 100) / 100, winRate: s.trades ? Math.round((s.wins / s.trades) * 100) : 0 }));
  }, [settled]);

  // Strategy
  const stratData = useMemo(() => {
    const map: Record<string, { name: string; value: number; pnl: number; wins: number }> = {};
    for (const t of filtered) {
      const s = t.strategy ?? 'unknown';
      if (!map[s]) map[s] = { name: s.replace('-prediction', '').replace('-', ' '), value: 0, pnl: 0, wins: 0 };
      map[s].value++;
      if (t.realizedPnL != null) map[s].pnl += t.realizedPnL;
      if ((t.realizedPnL ?? 0) > 0) map[s].wins++;
    }
    return Object.values(map).map((s, i) => ({ ...s, pnl: Math.round(s.pnl * 100) / 100, winRate: s.value ? Math.round((s.wins / s.value) * 100) : 0, fill: COLORS[i % COLORS.length] }));
  }, [filtered]);

  // Available sports and days for calibration filters
  const calSports = useMemo(() => {
    const set = new Set<string>();
    for (const t of settled) if (t.confidence != null) set.add(sportOf(t));
    return ['all', ...Array.from(set).sort()];
  }, [settled]);

  const calDays = useMemo(() => {
    const set = new Set<string>();
    for (const t of settled) {
      if (t.confidence == null) continue;
      const d = new Date(t.timestamp);
      set.add(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]);
    }
    return ['all', ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter(d => set.has(d))];
  }, [settled]);

  // Calibration — filtered by sport + day
  const calFiltered = useMemo(() => settled.filter(t => {
    if (t.confidence == null) return false;
    if (calSport !== 'all' && sportOf(t) !== calSport) return false;
    if (calDay !== 'all') {
      const d = new Date(t.timestamp);
      if (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] !== calDay) return false;
    }
    return true;
  }), [settled, calSport, calDay]);

  const calData = useMemo(() => {
    const buckets = [
      { label: '65-70%', min: 0.65, max: 0.70 },
      { label: '70-75%', min: 0.70, max: 0.75 },
      { label: '75-80%', min: 0.75, max: 0.80 },
      { label: '80-85%', min: 0.80, max: 0.85 },
      { label: '85-90%', min: 0.85, max: 0.90 },
      { label: '90%+', min: 0.90, max: 1.01 },
    ].map(b => ({ ...b, total: 0, wins: 0, pnl: 0 }));
    for (const t of calFiltered) {
      for (const b of buckets) {
        if (t.confidence >= b.min && t.confidence < b.max) {
          b.total++;
          if ((t.realizedPnL ?? 0) > 0) b.wins++;
          b.pnl += t.realizedPnL ?? 0;
          break;
        }
      }
    }
    return buckets.filter(b => b.total > 0).map(b => ({
      label: b.label,
      predicted: (b.min + b.max) / 2 * 100,
      actual: Math.round((b.wins / b.total) * 100),
      total: b.total,
      wins: b.wins,
      pnl: Math.round(b.pnl * 100) / 100,
    }));
  }, [calFiltered]);

  const calOverall = useMemo(() => {
    if (calFiltered.length === 0) return null;
    const avgConf = calFiltered.reduce((s, t) => s + t.confidence, 0) / calFiltered.length;
    const wins = calFiltered.filter(t => (t.realizedPnL ?? 0) > 0).length;
    const actualWr = wins / calFiltered.length;
    const gap = (actualWr - avgConf) * 100;
    return { avgConf: Math.round(avgConf * 100), actualWr: Math.round(actualWr * 100), gap: Math.round(gap), total: calFiltered.length };
  }, [calFiltered]);

  // Hour of day
  const hourData = useMemo(() => {
    const map: Record<number, { trades: number; pnl: number }> = {};
    for (const t of filtered) {
      const hr = new Date(t.timestamp).getHours();
      if (!map[hr]) map[hr] = { trades: 0, pnl: 0 };
      map[hr].trades++;
      if (t.realizedPnL != null) map[hr].pnl += t.realizedPnL;
    }
    return Object.entries(map).map(([hr, d]) => ({
      hour: `${hr}:00`,
      hourNum: parseInt(hr),
      trades: d.trades,
      pnl: Math.round(d.pnl * 100) / 100,
    })).sort((a, b) => a.hourNum - b.hourNum);
  }, [filtered]);

  const tooltipStyle = {
    contentStyle: { background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 },
    labelStyle: { color: 'var(--text-secondary)' },
  };

  // ─── Drill-down handlers ────────────────────────────────────────────────
  const drillSport = (sport: string) => {
    buzz('light');
    setDrill({
      title: `${sport} — ${tf === 'all' ? 'All time' : TIMEFRAMES.find(t => t.key === tf)?.label}`,
      subtitle: `${settled.filter(t => sportOf(t) === sport).length} settled trades`,
      trades: filtered.filter(t => sportOf(t) === sport).reverse(),
    });
  };
  const drillHour = (hr: number) => {
    buzz('light');
    setDrill({
      title: `${hr}:00 hour`,
      subtitle: `Trades initiated between ${hr}:00 and ${hr + 1}:00`,
      trades: filtered.filter(t => new Date(t.timestamp).getHours() === hr).reverse(),
    });
  };
  const drillBucket = (b: typeof calData[number]) => {
    buzz('light');
    setDrill({
      title: `Confidence ${b.label}`,
      subtitle: `${b.total} settled · ${b.actual}% actual win rate (predicted ~${Math.round(b.predicted)}%)`,
      trades: settled.filter(t => t.confidence != null && t.confidence * 100 >= parseInt(b.label) && t.confidence * 100 < parseInt(b.label) + 5).reverse(),
    });
  };

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>Analytics</h1>

      {/* Timeframe pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {TIMEFRAMES.map(t => (
          <button key={t.key} onClick={() => { buzz('light'); setTf(t.key); }} style={{
            padding: '8px 14px', borderRadius: 8,
            background: tf === t.key ? 'var(--accent)' : 'var(--bg-surface)',
            color: tf === t.key ? 'white' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Summary bar */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16,
      }}>
        {[
          { label: 'TRADES', val: filtered.length, color: 'var(--text-primary)' },
          { label: 'WIN RATE', val: `${winRate}%`, color: winRate >= 55 ? 'var(--green)' : winRate >= 45 ? 'var(--amber)' : 'var(--red)' },
          { label: 'P&L', val: `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`, color: totalPnL >= 0 ? 'var(--green)' : 'var(--red)' },
        ].map(x => (
          <div key={x.label} style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '12px 14px',
          }}>
            <div className="label" style={{ fontSize: 10 }}>{x.label}</div>
            <div className="font-mono" style={{ fontSize: 18, fontWeight: 700, color: x.color, marginTop: 4 }}>
              {x.val}
            </div>
          </div>
        ))}
      </div>

      {/* Running PnL */}
      {dailySeries.length > 0 && (
        <Section title="RUNNING P&L">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={dailySeries}>
              <defs>
                <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={totalPnL >= 0 ? '#22C55E' : '#EF4444'} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={totalPnL >= 0 ? '#22C55E' : '#EF4444'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} tickFormatter={v => `$${v}`} />
              <Tooltip {...tooltipStyle} formatter={(v: number) => [`$${v.toFixed(2)}`]} />
              <Area type="monotone" dataKey="running" stroke={totalPnL >= 0 ? '#22C55E' : '#EF4444'} fill="url(#bg)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* Per-sport (tap to drill) */}
      {sportData.length > 0 && (
        <Section title="BY SPORT · TAP TO DRILL">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={sportData} onClick={(e: any) => e?.activeLabel && drillSport(e.activeLabel)}>
              <XAxis dataKey="sport" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} tickFormatter={v => `$${v}`} />
              <Tooltip {...tooltipStyle} formatter={(v: number) => [`$${v.toFixed(2)}`]} />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]} cursor="pointer">
                {sportData.map((d, i) => (
                  <Cell key={i} fill={d.pnl >= 0 ? 'var(--green)' : 'var(--red)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ marginTop: 10 }}>
            {sportData.map(sp => (
              <button
                key={sp.sport}
                onClick={() => drillSport(sp.sport)}
                style={{
                  width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 10px', background: 'var(--bg-base)', borderRadius: 6,
                  border: '1px solid var(--border)', marginBottom: 6, cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                <span style={{ fontWeight: 600 }}>{sp.sport}</span>
                <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                  {sp.trades} · {sp.winRate}% · <span style={{ color: sp.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {sp.pnl >= 0 ? '+' : ''}${sp.pnl.toFixed(2)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* Calibration */}
      <Section title="CONFIDENCE CALIBRATION">
        {/* Sport filter */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {calSports.map(s => (
            <button key={s} onClick={() => { buzz('light'); setCalSport(s); }} style={{
              padding: '5px 10px', borderRadius: 6,
              background: calSport === s ? 'var(--accent)' : 'var(--bg-base)',
              color: calSport === s ? 'white' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', textTransform: 'uppercase',
            }}>{s}</button>
          ))}
        </div>
        {/* Day filter */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {calDays.map(d => (
            <button key={d} onClick={() => { buzz('light'); setCalDay(d); }} style={{
              padding: '5px 8px', borderRadius: 6,
              background: calDay === d ? 'var(--accent)' : 'var(--bg-base)',
              color: calDay === d ? 'white' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
              fontSize: 10, fontWeight: 600, cursor: 'pointer',
            }}>{d === 'all' ? 'All Days' : d}</button>
          ))}
        </div>

        {/* Summary stat */}
        {calOverall && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14,
          }}>
            <div style={{ background: 'var(--bg-base)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>TRADES</div>
              <div className="font-mono" style={{ fontSize: 16, fontWeight: 700 }}>{calOverall.total}</div>
            </div>
            <div style={{ background: 'var(--bg-base)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>AVG CONF</div>
              <div className="font-mono" style={{ fontSize: 16, fontWeight: 700 }}>{calOverall.avgConf}%</div>
            </div>
            <div style={{ background: 'var(--bg-base)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>ACTUAL WR</div>
              <div className="font-mono" style={{ fontSize: 16, fontWeight: 700, color: calOverall.actualWr >= calOverall.avgConf ? 'var(--green)' : 'var(--red)' }}>{calOverall.actualWr}%</div>
            </div>
            <div style={{ background: 'var(--bg-base)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>GAP</div>
              <div className="font-mono" style={{ fontSize: 16, fontWeight: 700, color: calOverall.gap >= 0 ? 'var(--green)' : 'var(--red)' }}>{calOverall.gap >= 0 ? '+' : ''}{calOverall.gap}%</div>
            </div>
          </div>
        )}

        {calData.length > 0 ? (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 10 }}>
              Diagonal = perfect. Above = underconfident (good). Below = overconfident (bad).
            </div>
            <ResponsiveContainer width="100%" height={230}>
              <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="predicted" type="number" domain={[60, 100]} tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} label={{ value: 'Predicted', position: 'bottom', fontSize: 10, fill: 'var(--text-tertiary)' }} />
                <YAxis dataKey="actual" type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} label={{ value: 'Actual', angle: -90, position: 'left', fontSize: 10, fill: 'var(--text-tertiary)' }} />
                <Tooltip {...tooltipStyle} formatter={(v: number, name: string) => [`${v}%`, name]} />
                <Scatter data={calData} onClick={(d: any) => d?.payload && drillBucket(d.payload)} cursor="pointer">
                  {calData.map((d, i) => (
                    <Cell key={i} fill={d.actual >= d.predicted ? 'var(--green)' : 'var(--red)'} r={Math.max(6, Math.min(16, d.total))} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>

            {/* Bucket detail table */}
            <div style={{ marginTop: 14 }}>
              {calData.map(b => {
                const gap = b.actual - Math.round(b.predicted);
                return (
                  <button
                    key={b.label}
                    onClick={() => drillBucket(b)}
                    style={{
                      width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 10px', background: 'var(--bg-base)', borderRadius: 6,
                      border: '1px solid var(--border)', marginBottom: 6, cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    <span style={{ fontWeight: 600, minWidth: 60 }}>{b.label}</span>
                    <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {b.wins}/{b.total}
                    </span>
                    <span className="font-mono" style={{ color: b.actual >= Math.round(b.predicted) ? 'var(--green)' : 'var(--red)' }}>
                      {b.actual}% actual
                    </span>
                    <span className="font-mono" style={{ color: gap >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600, minWidth: 45, textAlign: 'right' }}>
                      {gap >= 0 ? '+' : ''}{gap}%
                    </span>
                    <span className="font-mono" style={{ color: b.pnl >= 0 ? 'var(--green)' : 'var(--red)', minWidth: 65, textAlign: 'right' }}>
                      {b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(2)}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: 20, textAlign: 'center' }}>
            No calibration data for this filter combination.
          </div>
        )}
      </Section>

      {/* Strategy */}
      {stratData.length > 0 && (
        <Section title="STRATEGY MIX">
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <ResponsiveContainer width={160} height={160}>
              <PieChart>
                <Pie data={stratData} dataKey="value" cx="50%" cy="50%" innerRadius={35} outerRadius={65} paddingAngle={2}>
                  {stratData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Pie>
                <Tooltip {...tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ flex: 1, minWidth: 180 }}>
              {stratData.map(st => (
                <div key={st.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: st.fill }} />
                  <span style={{ flex: 1 }}>{st.name}</span>
                  <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{st.value}</span>
                  <span className="font-mono" style={{ color: st.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {st.pnl >= 0 ? '+' : ''}${st.pnl.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {/* Hour of day */}
      {hourData.length > 0 && (
        <Section title="BY HOUR · TAP TO DRILL">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={hourData} onClick={(e: any) => {
              const hr = e?.activePayload?.[0]?.payload?.hourNum;
              if (hr != null) drillHour(hr);
            }}>
              <XAxis dataKey="hour" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} tickFormatter={v => `$${v}`} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]} cursor="pointer">
                {hourData.map((d, i) => (
                  <Cell key={i} fill={d.pnl >= 0 ? 'var(--green)' : 'var(--red)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* Drill-down sheet */}
      <BottomSheet
        open={drill != null}
        onOpenChange={(open) => !open && setDrill(null)}
        title={drill?.title}
        subtitle={drill?.subtitle}
      >
        {drill && (
          drill.trades.length === 0 ? (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: 20, textAlign: 'center' }}>
              No trades in this slice.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {drill.trades.slice(0, 30).map(t => <TradeCard key={t.id} trade={t} compact />)}
            </div>
          )
        )}
      </BottomSheet>
    </div>
  );
}
