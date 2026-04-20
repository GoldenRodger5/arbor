import { useLocation, useNavigate } from 'react-router-dom';
import { useArbor } from '@/context/ArborContext';

const navItems = [
  { label: 'Today', path: '/', icon: '🏠' },
  { label: 'Overview', path: '/overview', icon: '🗂️' },
  { label: 'Positions', path: '/positions', icon: '📊' },
  { label: 'Trade History', path: '/history', icon: '📋' },
  { label: 'Analytics', path: '/analytics', icon: '📈' },
  { label: 'Recap', path: '/recap', icon: '📅' },
  { label: 'Trade Review', path: '/review', icon: '🧠' },
  { label: 'Live Feed', path: '/live', icon: '📡' },
  { label: 'Games', path: '/games', icon: '🎮' },
  { label: 'Pre-Game Lab', path: '/pregame-lab', icon: '🧪' },
  { label: 'API Costs', path: '/costs', icon: '💸' },
  { label: 'Settings', path: '/settings', icon: '⚙️' },
];

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { stats, positions, lastRefresh, connected } = useArbor();
  const s = stats ?? {};

  const bankroll = s.liveBankroll ?? s.latestSnapshot?.bankroll ?? 0;
  const refreshAgo = lastRefresh ? `${Math.round((Date.now() - lastRefresh) / 1000)}s ago` : 'never';

  return (
    <aside style={{
      width: 220, height: '100vh', position: 'fixed', left: 0, top: 0,
      background: 'var(--bg-surface)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ padding: '24px 20px 20px' }}>
        <span style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
          Arbor
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <span className={connected ? 'status-dot-live' : ''} style={{
            width: 8, height: 8, borderRadius: '50%', background: connected ? 'var(--green)' : 'var(--red)', display: 'inline-block',
          }} />
          <span style={{ fontSize: 11, color: connected ? 'var(--green)' : 'var(--red)', fontWeight: 500 }}>
            {connected ? 'LIVE TRADING' : 'DISCONNECTED'}
          </span>
        </div>
      </div>

      <nav style={{ flex: 1, paddingTop: 8 }}>
        {navItems.map((item) => {
          const active = location.pathname === item.path;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', height: 44, paddingLeft: 20, border: 'none',
                borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                background: active ? 'var(--bg-elevated)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 13, fontFamily: 'Inter, sans-serif', cursor: 'pointer',
                transition: 'background 100ms',
              }}
            >
              <span style={{ fontSize: 14 }}>{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>

      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
        <div style={{ marginBottom: 10 }}>
          <span className="label">BANKROLL</span>
          <div className="font-mono" style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginTop: 4 }}>
            ${bankroll.toFixed(2)}
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <span className="label">POSITIONS</span>
          <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {positions.length} open
          </div>
        </div>
        <div>
          <span className="label">UPDATED</span>
          <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
            {refreshAgo}
          </div>
        </div>
      </div>
    </aside>
  );
}
