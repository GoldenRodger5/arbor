import { useEffect, useRef, useState } from 'react';
import type { Trade } from '@/types';
import TradeCard from './TradeCard';
import { buzz } from '@/lib/notify';

/** Swipeable deck of trades — one-at-a-time, full reasoning, touch-friendly. */
export default function TradeSwiper({ trades, onClose }: { trades: Trade[]; onClose?: () => void }) {
  const [index, setIndex] = useState(0);
  const [drag, setDrag] = useState(0);
  const startX = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index]);

  const prev = () => {
    if (index <= 0) return;
    buzz('light');
    setIndex(i => i - 1);
  };
  const next = () => {
    if (index >= trades.length - 1) return;
    buzz('light');
    setIndex(i => i + 1);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    startX.current = e.clientX;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (startX.current == null) return;
    setDrag(e.clientX - startX.current);
  };
  const onPointerUp = () => {
    if (startX.current == null) return;
    const threshold = 60;
    if (drag > threshold) prev();
    else if (drag < -threshold) next();
    setDrag(0);
    startX.current = null;
  };

  if (trades.length === 0) return null;
  const trade = trades[index];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 12, color: 'var(--text-tertiary)',
      }}>
        <span>{index + 1} / {trades.length}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {trades.slice(0, 24).map((_, i) => (
            <span key={i} style={{
              width: 6, height: 6, borderRadius: '50%',
              background: i === index ? 'var(--accent)' : 'var(--bg-elevated)',
              transition: 'background 150ms',
            }} />
          ))}
        </div>
        {onClose && (
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--text-tertiary)',
            fontSize: 12, cursor: 'pointer', padding: 0,
          }}>Close</button>
        )}
      </div>

      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { setDrag(0); startX.current = null; }}
        style={{
          transform: `translateX(${drag}px)`,
          transition: drag === 0 ? 'transform 200ms ease-out' : 'none',
          touchAction: 'pan-y',
          userSelect: 'none',
        }}
      >
        <TradeCard trade={trade} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={prev}
          disabled={index === 0}
          style={{
            flex: 1, padding: '10px', border: '1px solid var(--border)',
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: index === 0 ? 'default' : 'pointer',
            opacity: index === 0 ? 0.4 : 1,
          }}
        >← Prev</button>
        <button
          onClick={next}
          disabled={index === trades.length - 1}
          style={{
            flex: 1, padding: '10px', border: '1px solid var(--border)',
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            borderRadius: 8, fontSize: 12, fontWeight: 600,
            cursor: index === trades.length - 1 ? 'default' : 'pointer',
            opacity: index === trades.length - 1 ? 0.4 : 1,
          }}
        >Next →</button>
      </div>
    </div>
  );
}
