import { useEffect, useRef, useState } from 'react';

type Props = {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  duration?: number;
  signed?: boolean;           // show +/- prefix
  colorize?: boolean;         // green/red based on sign
  className?: string;
  style?: React.CSSProperties;
};

/**
 * Smoothly tweens from previous value to next over `duration` ms.
 * Uses requestAnimationFrame with an ease-out curve for a satisfying feel.
 */
export default function AnimatedNumber({
  value, prefix = '', suffix = '', decimals = 2,
  duration = 500, signed = false, colorize = false,
  className = '', style,
}: Props) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (value === prev.current) return;
    const from = prev.current;
    const to = value;
    const start = performance.now();
    prev.current = to;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  const sign = signed && display > 0 ? '+' : signed && display < 0 ? '-' : '';
  const abs = Math.abs(display);
  const color = colorize
    ? (display > 0 ? 'var(--green)' : display < 0 ? 'var(--red)' : 'var(--text-primary)')
    : undefined;

  return (
    <span
      className={`font-mono ${className}`}
      style={{ ...style, color: color ?? style?.color }}
    >
      {sign}{prefix}{abs.toFixed(decimals)}{suffix}
    </span>
  );
}
