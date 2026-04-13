import { useEffect, useRef, useState } from 'react';
import { useArbor } from '@/context/ArborContext';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import Confetti from '@/components/Confetti';
import Achievements from '@/components/Achievements';

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Command Center</h1>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: connected ? 'var(--green)' : 'var(--red)',
              display: 'inline-block',
            }} className={connected ? 'status-dot-live' : ''} />
          </div>
          <div style={{ fontSize: 12, color: error ? 'var(--red)' : 'var(--text-tertiary)', marginTop: 4 }}>
            {error ? `Connection error: ${error}` : `Live — updates every 15s${refreshing ? ' (refreshing...)' : ''}`}
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          style={{
            background: refreshing ? 'var(--bg-elevated)' : 'var(--accent)',
            color: 'white', border: 'none', borderRadius: 8,
            padding: '8px 16px', fontSize: 13, cursor: refreshing ? 'default' : 'pointer', fontWeight: 500,
            opacity: refreshing ? 0.6 : 1, transition: 'opacity 150ms',
          }}
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Bankroll Hero */}
      <div style={{
        background: 'linear-gradient(135deg, var(--bg-surface), var(--bg-elevated))',
        border: '1px solid var(--border)', borderRadius: 16, padding: '24px 28px', marginBottom: 20,
      }}>
        <div className="label" style={{ marginBottom: 8 }}>TOTAL BANKROLL</div>
        <div className="font-mono" style={{ fontSize: 36, fontWeight: 700 }}>${bankroll.toFixed(2)}</div>
        <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
          <span>Kalshi: ${kalshiCash.toFixed(2)} cash + ${kalshiPos.toFixed(2)} positions</span>
          <span>Poly: ${polyBal.toFixed(2)}</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <span style={{ fontSize: 13, marginRight: 16 }}>Today: <PnlColor value={s.todayPnL ?? 0} /></span>
          <span style={{ fontSize: 13 }}>All time: <PnlColor value={s.totalPnL ?? 0} /></span>
        </div>
      </div>

      {/* Daily Challenge + Projections */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
        {/* Daily Challenge */}
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span className="label">DAILY TARGET</span>
            <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              ${(s.todayPnL ?? 0).toFixed(2)} / ${dailyTarget.toFixed(2)}
            </span>
          </div>
          <div style={{ height: 8, background: 'var(--bg-base)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 4, transition: 'width 500ms ease',
              width: `${Math.min(100, dailyProgress * 100)}%`,
              background: dailyProgress >= 1 ? 'var(--green)' : dailyProgress >= 0.5 ? 'var(--accent)' : 'var(--amber)',
            }} />
          </div>
          {dailyProgress >= 1 && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>
              Target hit! Keep stacking.
            </div>
          )}
        </div>

        {/* Projections */}
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px',
        }}>
          <div className="label" style={{ marginBottom: 8 }}>IF EVERY DAY IS LIKE TODAY</div>
          {todayPnL !== 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.9 }}>
              <div>This week: <span className="font-mono" style={{ color: weeklyIfToday >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{weeklyIfToday >= 0 ? '+' : ''}${weeklyIfToday.toFixed(0)}/wk</span></div>
              <div>This month: <span className="font-mono" style={{ color: monthlyIfToday >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{monthlyIfToday >= 0 ? '+' : ''}${monthlyIfToday.toFixed(0)}/mo</span></div>
              <div>This year: <span className="font-mono" style={{ color: yearlyIfToday >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{yearlyIfToday >= 0 ? '+' : ''}${yearlyIfToday.toFixed(0)}/yr</span></div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No P&L today yet</div>
          )}
          {dailyAvgPnL > 0 && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.8 }}>
              <div>Avg daily: <span className="font-mono">${dailyAvgPnL.toFixed(2)}</span> → <span className="font-mono">${weeklyAvg.toFixed(0)}/wk</span></div>
              {daysTo1K != null && daysTo1K > 0 && daysTo1K < 365 && (
                <div>$1K bankroll in <span className="font-mono" style={{ color: 'var(--accent)' }}>{daysTo1K} days</span></div>
              )}
              {daysTo5K != null && daysTo5K > 0 && daysTo5K < 365 && (
                <div>$5K bankroll in <span className="font-mono" style={{ color: 'var(--accent)' }}>{daysTo5K} days</span></div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Stats Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        <StatCard label="TODAY'S TRADES" value={s.todayTrades ?? 0} sub={<>Settled: {s.todaySettled ?? 0}</>} />
        <StatCard label="WIN RATE" value={s.winRate != null ? `${s.winRate}%` : 'N/A'} sub={<>{s.wins ?? 0}W / {s.losses ?? 0}L</>} />
        <StatCard
          label="STREAK"
          value={
            <span className={s.streakType === 'win' && (s.streak ?? 0) >= 3 ? 'streak-fire' : ''}>
              {streakIcon} {s.streak ?? 0} {s.streakType ?? ''}
            </span>
          }
        />
        <StatCard label="OPEN" value={s.openTrades ?? 0} sub={<>${(positions.reduce((sum, p) => sum + (p.deployCost ?? 0), 0)).toFixed(2)} deployed</>} />
        <StatCard
          label="BEST TRADE"
          value={s.bestTrade ? <PnlColor value={s.bestTrade.pnl} /> : 'N/A'}
          sub={s.bestTrade?.title?.slice(0, 30)}
        />
        <StatCard
          label="WORST TRADE"
          value={s.worstTrade ? <PnlColor value={s.worstTrade.pnl} /> : 'N/A'}
          sub={s.worstTrade?.title?.slice(0, 30)}
        />
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

      {/* Active Positions */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <div className="label" style={{ marginBottom: 12 }}>ACTIVE POSITIONS ({positions.length})</div>
        {positions.length === 0 ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '12px 0' }}>No open positions</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {positions.slice(0, 12).map(p => {
              const pnl = p.exitPrice != null ? (p.exitPrice - p.entryPrice) * p.quantity : 0;
              const sport = p.ticker?.includes('MLB') ? 'MLB' : p.ticker?.includes('NBA') ? 'NBA' : p.ticker?.includes('NHL') ? 'NHL' : p.ticker?.includes('MLS') ? 'MLS' : p.exchange === 'polymarket' ? 'POLY' : '';
              return (
                <div key={p.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 12px', background: 'var(--bg-base)', borderRadius: 8,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {sport && <span style={{
                        background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4,
                        fontSize: 10, fontWeight: 600, color: 'var(--accent)',
                      }}>{sport}</span>}
                      <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.title}
                      </span>
                    </div>
                    <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                      {p.side?.toUpperCase()} @ {(p.entryPrice * 100).toFixed(0)}¢ × {p.quantity} = ${p.deployCost?.toFixed(2)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', marginLeft: 12 }}>
                    <div className="font-mono" style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent)' }}>
                      {(p.confidence * 100).toFixed(0)}%
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>conf</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
        <div className="label" style={{ marginBottom: 12 }}>RECENT ACTIVITY</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {recentTrades.map(t => {
            const icon = t.status === 'settled' && (t.realizedPnL ?? 0) >= 0 ? '✅' :
              t.status === 'settled' ? '❌' :
              t.status?.startsWith('sold-') ? '🛑' :
              t.status === 'open' ? '🎯' : '📋';
            const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
                <span>{icon}</span>
                <span className="font-mono" style={{ color: 'var(--text-tertiary)', width: 55, flexShrink: 0 }}>{time}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.title} — {t.side?.toUpperCase()} @ {(t.entryPrice * 100).toFixed(0)}¢
                </span>
                {t.realizedPnL != null && <PnlColor value={t.realizedPnL} />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Achievements */}
      <div style={{ marginTop: 20 }}>
        <Achievements stats={s} trades={trades} />
      </div>
    </div>
  );
}
