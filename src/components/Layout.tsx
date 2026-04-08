import { ReactNode } from 'react';
import Sidebar from './Sidebar';
import BottomTabs from './BottomTabs';
import { useIsMobile } from '@/hooks/use-mobile';

export default function Layout({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div style={{ minHeight: '100vh', paddingBottom: 80 }}>
        <div style={{ padding: 16 }}>{children}</div>
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
