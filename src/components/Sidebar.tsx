import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useArbor } from '@/context/ArborContext';

// 5 primary nav items — covers 95% of daily use.
const primary = [
  { label: 'Today',       path: '/',         icon: '🏠' },
  { label: 'Trades',      path: '/trades',   icon: '📊' },
  { label: 'Performance', path: '/perf',     icon: '📈' },
  { label: 'Live',        path: '/live',     icon: '📡' },
  { label: 'Settings',    path: '/settings', icon: '⚙️' },
];

// Secondary — collapsed under "More" by default. Direct links to the
// underlying pages preserved for power users + back-compat with old URLs.
const more = [
  { label: 'Overview',     path: '/overview',    icon: '🗂️' },
  { label: 'Positions',    path: '/positions',   icon: '📦' },
  { label: 'Trade History', path: '/history',    icon: '📋' },
  { label: 'Trade Review', path: '/review',      icon: '🧠' },
  { label: 'Recap',        path: '/recap',       icon: '📅' },
  { label: 'Analytics',    path: '/analytics',   icon: '📊' },
  { label: 'Live Feed',    path: '/live-feed',   icon: '⚡' },
  { label: 'Games',        path: '/games',       icon: '🎮' },
  { label: 'Pre-Game Lab', path: '/pregame-lab', icon: '🧪' },
  { label: 'API Costs',    path: '/costs',       icon: '💸' },
];

function isActiveRoute(currentPath: string, navPath: string): boolean {
  // Exact match for root, prefix match for everything else
  if (navPath === '/') return currentPath === '/';
  return currentPath === navPath || currentPath.startsWith(navPath + '/');
}

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { stats, positions, lastRefresh, connected } = useArbor();
  const [moreOpen, setMoreOpen] = useState(
    // Auto-expand "More" if user is currently on a secondary route
    more.some(m => location.pathname === m.path)
  );
  const s = stats ?? {};

  const bankroll = s.liveBankroll ?? s.latestSnapshot?.bankroll ?? 0;
  const refreshAgo = lastRefresh ? `${Math.round((Date.now() - lastRefresh) / 1000)}s ago` : 'never';

  const NavBtn = ({ item, depth = 0 }: { item: typeof primary[0]; depth?: number }) => {
    const active = isActiveRoute(location.pathname, item.path);
    return (
      <button
        onClick={() => navigate(item.path)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', height: depth ? 36 : 44,
          paddingLeft: depth ? 32 : 20, paddingRight: 12,
          border: 'none',
          borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
          background: active ? 'var(--bg-elevated)' : 'transparent',
          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontSize: depth ? 12 : 13,
          fontFamily: 'Inter, sans-serif',
          fontWeight: active ? 600 : 400,
          cursor: 'pointer',
          transition: 'background 100ms',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: depth ? 13 : 14 }}>{item.icon}</span>
        {item.label}
      </button>
    );
  };

  return (
    <aside style={{
      width: 220, height: '100vh', position: 'fixed', left: 0, top: 0,
      background: 'var(--bg-surface)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ padding: '24px 20px 20px' }}>
        <span style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
          Arbor
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <span className={connected ? 'status-dot-live' : ''} style={{
            width: 8, height: 8, borderRadius: '50%',
            background: connected ? 'var(--green)' : 'var(--red)',
            display: 'inline-block',
          }} />
          <span style={{
            fontSize: 11,
            color: connected ? 'var(--green)' : 'var(--red)',
            fontWeight: 500,
          }}>
            {connected ? 'LIVE TRADING' : 'DISCONNECTED'}
          </span>
        </div>
      </div>

      <nav style={{ flex: 1, paddingTop: 8, overflowY: 'auto' }}>
        {primary.map(item => <NavBtn key={item.path} item={item} />)}

        {/* "More" expandable section */}
        <button
          onClick={() => setMoreOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            width: '100%', height: 40, paddingLeft: 20, paddingRight: 12,
            marginTop: 8,
            border: 'none',
            background: 'transparent',
            color: 'var(--text-tertiary)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            fontFamily: 'Inter, sans-serif',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 12 }}>{moreOpen ? '▾' : '▸'}</span>
          More
        </button>
        {moreOpen && more.map(item => <NavBtn key={item.path} item={item} depth={1} />)}
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
