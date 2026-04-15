import { useEffect, useRef, useState } from 'react';

/**
 * Attaches pull-to-refresh to document.body.
 * Only triggers when window is scrolled to the top.
 * Calls onRefresh when user pulls down past threshold, then releases.
 */
export function usePullToRefresh(onRefresh: () => Promise<void> | void, { threshold = 70 } = {}) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY > 0) { startY.current = null; return; }
      startY.current = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (startY.current == null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy > 0 && window.scrollY === 0) {
        setPull(Math.min(dy, threshold * 1.5));
      }
    };
    const onTouchEnd = async () => {
      if (startY.current == null) { setPull(0); return; }
      if (pull >= threshold) {
        setRefreshing(true);
        try { await onRefresh(); } catch { /* ignore */ }
        setRefreshing(false);
      }
      setPull(0);
      startY.current = null;
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [pull, onRefresh, threshold]);

  return { pull, refreshing, threshold };
}
