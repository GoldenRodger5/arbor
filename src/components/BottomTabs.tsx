import { useLocation, useNavigate } from 'react-router-dom';

const tabs = [
  { label: 'Home', path: '/', icon: '🏠' },
  { label: 'Positions', path: '/positions', icon: '📊' },
  { label: 'History', path: '/history', icon: '📋' },
  { label: 'Analytics', path: '/analytics', icon: '📈' },
  { label: 'Games', path: '/games', icon: '🎮' },
  { label: 'Live', path: '/live', icon: '📡' },
];

export default function BottomTabs() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, height: 60,
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      background: 'var(--bg-surface)', borderTop: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-around', zIndex: 100,
    }}>
      {tabs.map((tab) => {
        const active = location.pathname === tab.path;
        return (
          <button
            key={tab.path}
            onClick={() => navigate(tab.path)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', background: 'none', border: 'none',
              color: active ? 'var(--accent)' : 'var(--text-tertiary)',
              fontSize: 10, fontFamily: 'Inter, sans-serif', cursor: 'pointer', height: '100%', gap: 2,
            }}
          >
            <span style={{ fontSize: 18 }}>{tab.icon}</span>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
