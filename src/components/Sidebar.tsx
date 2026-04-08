import { useLocation, useNavigate } from 'react-router-dom';
import { useScannerContext } from '@/context/ScannerContext';

const navItems = [
  { label: 'Scanner', path: '/' },
  { label: 'Opportunities', path: '/opportunities' },
  { label: 'Analytics', path: '/analytics' },
  { label: 'Positions', path: '/positions' },
  { label: 'Settings', path: '/settings' },
];

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { stats, capital } = useScannerContext();

  return (
    <aside
      style={{
        width: 220,
        height: '100vh',
        position: 'fixed',
        left: 0,
        top: 0,
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: '24px 20px 32px' }}>
        <span style={{ fontWeight: 600, fontSize: 18, color: 'var(--text-primary)' }}>
          Arbor
        </span>
      </div>

      <nav style={{ flex: 1 }}>
        {navItems.map((item) => {
          const active = location.pathname === item.path;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                height: 48,
                paddingLeft: 20,
                border: 'none',
                borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                background: active ? 'var(--bg-elevated)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 14,
                fontFamily: 'Inter, sans-serif',
                cursor: 'pointer',
                transition: 'background 100ms',
              }}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span
            className={stats.isScanning ? 'status-dot-live' : undefined}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: stats.isScanning ? 'var(--green)' : 'var(--text-tertiary)',
              display: 'inline-block',
            }}
          />
          <span className="label">{stats.isScanning ? 'LIVE' : 'IDLE'}</span>
        </div>
        <div>
          <span className="label">CAPITAL</span>
          <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 4 }}>
            ${(capital?.deployedCapital ?? 0).toFixed(2)} deployed
          </div>
        </div>
      </div>
    </aside>
  );
}
