import { useLocation, useNavigate } from 'react-router-dom';

const tabs = [
  { label: 'Scanner', path: '/' },
  { label: 'Opps', path: '/opportunities' },
  { label: 'Analytics', path: '/analytics' },
  { label: 'Positions', path: '/positions' },
  { label: 'Settings', path: '/settings' },
];

export default function BottomTabs() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
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
        const active = location.pathname === tab.path;
        return (
          <button
            key={tab.path}
            onClick={() => navigate(tab.path)}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'none',
              border: 'none',
              color: active ? 'var(--accent)' : 'var(--text-tertiary)',
              fontSize: 11,
              fontFamily: 'Inter, sans-serif',
              cursor: 'pointer',
              height: '100%',
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
