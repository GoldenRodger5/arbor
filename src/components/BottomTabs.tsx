import { useLocation, useNavigate } from 'react-router-dom';
import { buzz } from '@/lib/notify';

const tabs = [
  { label: 'Today', path: '/', icon: '🏠' },
  { label: 'Positions', path: '/positions', icon: '📊' },
  { label: 'Games', path: '/games', icon: '🎮' },
  { label: 'History', path: '/history', icon: '📋' },
  { label: 'More', path: '/overview', icon: '⋯' },
];

export default function BottomTabs() {
  const location = useLocation();
  const navigate = useNavigate();

  const go = (path: string) => {
    buzz('light');
    navigate(path);
  };

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
            onClick={() => go(tab.path)}
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
