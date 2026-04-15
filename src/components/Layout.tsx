import { ReactNode } from 'react';
import Sidebar from './Sidebar';
import BottomTabs from './BottomTabs';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { useArbor } from '@/context/ArborContext';
import { buzz } from '@/lib/notify';

export default function Layout({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const { refresh } = useArbor();
  const { pull, refreshing, threshold } = usePullToRefresh(async () => {
    buzz('light');
    await refresh();
  });

  if (isMobile) {
    const progress = Math.min(1, pull / threshold);
    return (
      <div style={{ minHeight: '100vh', paddingBottom: 80, overscrollBehavior: 'none' }}>
        {(pull > 0 || refreshing) && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50,
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            height: Math.max(pull, refreshing ? 48 : 0),
            pointerEvents: 'none',
            transition: refreshing || pull === 0 ? 'height 200ms ease-out' : 'none',
          }}>
            <div style={{
              fontSize: 18,
              color: 'var(--accent)',
              transform: `rotate(${progress * 360}deg) scale(${refreshing ? 1 : Math.max(0.5, progress)})`,
              transition: 'transform 60ms',
              animation: refreshing ? 'spin 700ms linear infinite' : undefined,
            }}>
              {refreshing ? '⟳' : progress >= 1 ? '↑' : '↓'}
            </div>
          </div>
        )}
        <div style={{ padding: 16, transform: pull ? `translateY(${pull * 0.4}px)` : undefined, transition: pull ? 'none' : 'transform 200ms' }}>
          {children}
        </div>
        <BottomTabs />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <main style={{ marginLeft: 220, flex: 1, padding: 24 }}>{children}</main>
    </div>
  );
}
