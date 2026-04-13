interface AchievementDef {
  id: string;
  icon: string;
  title: string;
  desc: string;
  check: (stats: any, trades: any[]) => boolean;
}

const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-trade', icon: '🎯', title: 'First Blood', desc: 'Placed your first trade', check: (s) => (s.totalTrades ?? 0) >= 1 },
  { id: 'first-win', icon: '✅', title: 'Winner Winner', desc: 'Won your first trade', check: (s) => (s.wins ?? 0) >= 1 },
  { id: '5-wins', icon: '🏆', title: 'High Five', desc: '5 winning trades', check: (s) => (s.wins ?? 0) >= 5 },
  { id: '10-trades', icon: '📊', title: 'Getting Serious', desc: '10 trades placed', check: (s) => (s.totalTrades ?? 0) >= 10 },
  { id: '25-trades', icon: '💪', title: 'Quarter Century', desc: '25 trades placed', check: (s) => (s.totalTrades ?? 0) >= 25 },
  { id: '50-settled', icon: '🧮', title: 'Calibration Ready', desc: '50 trades settled', check: (s) => (s.settledTrades ?? 0) >= 50 },
  { id: '3-streak', icon: '🔥', title: 'On Fire', desc: '3-win streak', check: (s) => s.streakType === 'win' && (s.streak ?? 0) >= 3 },
  { id: '5-streak', icon: '💥', title: 'Unstoppable', desc: '5-win streak', check: (s) => s.streakType === 'win' && (s.streak ?? 0) >= 5 },
  { id: 'positive-pnl', icon: '💰', title: 'In The Green', desc: 'Positive all-time P&L', check: (s) => (s.totalPnL ?? 0) > 0 },
  { id: '$50-day', icon: '🤑', title: 'Big Day', desc: '$50+ profit in one day', check: (s) => (s.todayPnL ?? 0) >= 50 },
  { id: '$500-bankroll', icon: '📈', title: 'Half a Grand', desc: 'Bankroll hit $500', check: (s) => (s.latestSnapshot?.bankroll ?? 0) >= 500 },
  { id: '$1k-bankroll', icon: '🎉', title: 'Comma Club', desc: 'Bankroll hit $1,000', check: (s) => (s.latestSnapshot?.bankroll ?? 0) >= 1000 },
  { id: 'multi-sport', icon: '🌍', title: 'Diversified', desc: 'Won in 3+ sports', check: (s) => (s.sportPerformance ?? []).filter((sp: any) => sp.wins > 0).length >= 3 },
  { id: '60-winrate', icon: '🎯', title: 'Sharp', desc: '60%+ win rate (10+ trades)', check: (s) => (s.winRate ?? 0) >= 60 && (s.settledTrades ?? 0) >= 10 },
];

export default function Achievements({ stats, trades }: { stats: any; trades: any[] }) {
  const earned = ACHIEVEMENTS.filter(a => a.check(stats, trades));
  const locked = ACHIEVEMENTS.filter(a => !a.check(stats, trades));

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
      <div className="label" style={{ marginBottom: 12 }}>ACHIEVEMENTS ({earned.length}/{ACHIEVEMENTS.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {earned.map(a => (
          <div key={a.id} className="badge-pop" title={a.desc} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
            background: 'rgba(99, 102, 241, 0.12)', border: '1px solid rgba(99, 102, 241, 0.25)',
            borderRadius: 8, fontSize: 12,
          }}>
            <span style={{ fontSize: 16 }}>{a.icon}</span>
            <span style={{ fontWeight: 500 }}>{a.title}</span>
          </div>
        ))}
        {locked.map(a => (
          <div key={a.id} title={a.desc} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
            background: 'var(--bg-base)', border: '1px solid var(--border)',
            borderRadius: 8, fontSize: 12, opacity: 0.35,
          }}>
            <span style={{ fontSize: 16, filter: 'grayscale(1)' }}>{a.icon}</span>
            <span style={{ fontWeight: 500, color: 'var(--text-tertiary)' }}>{a.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
