import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useArbor } from '@/context/ArborContext';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import Confetti from '@/components/Confetti';
import Achievements from '@/components/Achievements';

const MORE_NAV = [
  { label: 'Analytics', path: '/analytics', icon: '📈', desc: 'Charts & drill-downs' },
  { label: 'Recap', path: '/recap', icon: '📅', desc: 'Daily & weekly' },
  { label: 'Trade Review', path: '/review', icon: '🧠', desc: 'AI-graded post-game' },
  { label: 'Games', path: '/games', icon: '🎮', desc: 'Live game decisions' },
  { label: 'Settings', path: '/settings', icon: '⚙️', desc: 'Control the bot' },
];

function PnlColor({ value, prefix = '' }: { value: number; prefix?: string }) {
  const color = value >= 0 ? 'var(--green)' : 'var(--red)';
  const sign = value >= 0 ? '+' : '';
  return <span style={{ color }} className="font-mono">{prefix}{sign}${Math.abs(value).toFixed(2)}</span>;
}

function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px' }}>
      <div className="label" style={{ marginBottom: 8 }}>{label}</div>
      <div className="font-mono" style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default function CommandCenter() {
  const { stats, positions, snapshots, trades, loading, refreshing, error, connected, lastRefresh, refresh } = useArbor();

  // Confetti: trigger when a new win settles
  const [showConfetti, setShowConfetti] = useState(false);
  const prevWins = useRef(0);
  useEffect(() => {
    const currentWins = stats?.wins ?? 0;
    if (prevWins.current > 0 && currentWins > prevWins.current) {
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 100);
    }
    prevWins.current = currentWins;
  }, [stats?.wins]);

  if (loading) return <div style={{ padding: 40, color: 'var(--text-secondary)' }}>Loading...</div>;

  const s = stats ?? {};
  const bankroll = s.liveBankroll ?? s.latestSnapshot?.bankroll ?? 0;
  const kalshiCash = s.latestSnapshot?.kalshiCash ?? 0;
  const kalshiPos = s.latestSnapshot?.kalshiPositions ?? 0;
  const polyBal = s.latestSnapshot?.polyBalance ?? 0;
  const openDeployed = s.openDeployed ?? positions.reduce((sum: number, p: any) => sum + (p.deployCost ?? 0), 0);

  // Chart data from snapshots
  const chartData = snapshots.map(sn => ({
    date: sn.date,
    bankroll: sn.bankroll,
    pnl: sn.totalPnL,
  }));

  // Recent activity (last 10 trades)
  const recentTrades = [...trades].reverse().slice(0, 10);

  // Streak display
  const streakIcon = s.streakType === 'win' && s.streak >= 3 ? '🔥' : s.streakType === 'win' ? '✅' : s.streakType === 'loss' ? '❌' : '';

  // Motivational projections based on actual performance
  const totalPnL = s.totalPnL ?? 0;
  const settledCount = s.settledTrades ?? 0;
  const winRate = s.winRate ?? 0;
  const avgWin = settledCount > 0 && s.wins > 0 ? totalPnL / s.wins : 0; // rough avg per win

  // "If every day is like today" projections
  const todayPnL = s.todayPnL ?? 0;
  const weeklyIfToday = todayPnL * 7;
  const monthlyIfToday = todayPnL * 30;
  const yearlyIfToday = todayPnL * 365;

  // "If every day is like our average" projections
  const tradingDays = Math.max(1, snapshots.length || 1);
  const dailyAvgPnL = totalPnL / tradingDays;
  const weeklyAvg = dailyAvgPnL * 7;
  const monthlyAvg = dailyAvgPnL * 30;
  const daysTo1K = dailyAvgPnL > 0 ? Math.ceil((1000 - bankroll) / (dailyAvgPnL + (400 / 14))) : null;
  const daysTo5K = dailyAvgPnL > 0 ? Math.ceil((5000 - bankroll) / (dailyAvgPnL + (400 / 14))) : null;

  // Daily target: 5% of bankroll
  const dailyTarget = bankroll * 0.05;
  const dailyProgress = Math.max(0, Math.min(1, todayPnL / dailyTarget));

  return (
    <div>
      <Confetti active={showConfetti} />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>More</h1>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: connected ? 'var(--green)' : 'var(--red)',
          display: 'inline-block',
        }} className={connected ? 'status-dot-live' : ''} />
      </div>

      {/* Quick nav */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 20 }}>
        {MORE_NAV.map(item => (
          <Link key={item.path} to={item.path} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 10, textDecoration: 'none', color: 'inherit',
          }}>
            <span style={{ fontSize: 20 }}>{item.icon}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{item.label}</div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{item.desc}</div>
            </div>
          </Link>
        ))}
      </div>

      {/* Projections */}
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', marginBottom: 20,
      }}>
        <div className="label" style={{ marginBottom: 8 }}>PROJECTIONS</div>
        {todayPnL !== 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.9 }}>
            <div>If every day = today: <span className="font-mono" style={{ color: weeklyIfToday >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{weeklyIfToday >= 0 ? '+' : ''}${weeklyIfToday.toFixed(0)}/wk</span> · <span className="font-mono" style={{ color: monthlyIfToday >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{monthlyIfToday >= 0 ? '+' : ''}${monthlyIfToday.toFixed(0)}/mo</span></div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No P&L today yet</div>
        )}
        {dailyAvgPnL > 0 && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.8 }}>
            <div>Avg daily: <span className="font-mono">${dailyAvgPnL.toFixed(2)}</span> → <span className="font-mono">${weeklyAvg.toFixed(0)}/wk</span></div>
            {daysTo1K != null && daysTo1K > 0 && daysTo1K < 365 && (
              <div>$1K bankroll in <span className="font-mono" style={{ color: 'var(--accent)' }}>{daysTo1K} days</span></div>
            )}
          </div>
        )}
      </div>

      {/* Bankroll Chart */}
      {chartData.length > 1 && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <div className="label" style={{ marginBottom: 12 }}>BANKROLL GROWTH</div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="bankrollGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} tickLine={false} axisLine={false} tickFormatter={v => `$${v}`} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'var(--text-secondary)' }}
                formatter={(v: number) => [`$${v.toFixed(2)}`, 'Bankroll']}
              />
              <Area type="monotone" dataKey="bankroll" stroke="var(--accent)" fill="url(#bankrollGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Achievements */}
      <Achievements stats={s} trades={trades} />
    </div>
  );
}
