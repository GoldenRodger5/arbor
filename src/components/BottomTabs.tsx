import { useLocation, useNavigate } from 'react-router-dom';
import { buzz } from '@/lib/notify';

// Same 5 primary as Sidebar — consistent mental model across mobile/desktop
const tabs = [
  { label: 'Today',       path: '/',         icon: '🏠' },
  { label: 'Trades',      path: '/trades',   icon: '📊' },
  { label: 'Performance', path: '/perf',     icon: '📈' },
  { label: 'Live',        path: '/live',     icon: '📡' },
  { label: 'Settings',    path: '/settings', icon: '⚙️' },
];

function isActiveRoute(currentPath: string, navPath: string): boolean {
  if (navPath === '/') return currentPath === '/';
  return currentPath === navPath || currentPath.startsWith(navPath + '/');
}

export default function BottomTabs() {
  const location = useLocation();
  const navigate = useNavigate();

  const go = (path: string) => {
    buzz('light');
    navigate(path);
  };

  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0, left: 0, right: 0,
        height: 60,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        background: 'var(--bg-surface)',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        zIndex: 100,
      }}
    >
      {tabs.map((tab) => {
        const active = isActiveRoute(location.pathname, tab.path);
        return (
          <button
            key={tab.path}
            onClick={() => go(tab.path)}
            aria-current={active ? 'page' : undefined}
            style={{
              flex: 1,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              background: 'none',
              border: 'none',
              color: active ? 'var(--accent)' : 'var(--text-tertiary)',
              fontSize: 10,
              fontFamily: 'Inter, sans-serif',
              fontWeight: active ? 600 : 400,
              cursor: 'pointer',
              height: '100%',
              gap: 2,
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
