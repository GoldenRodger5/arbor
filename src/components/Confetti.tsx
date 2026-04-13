import { useEffect, useState } from 'react';

const COLORS = ['#22C55E', '#6366F1', '#F59E0B', '#06B6D4', '#EC4899', '#8B5CF6', '#EF4444'];

interface Piece {
  id: number;
  left: number;
  color: string;
  delay: number;
  size: number;
}

export default function Confetti({ active }: { active: boolean }) {
  const [pieces, setPieces] = useState<Piece[]>([]);

  useEffect(() => {
    if (!active) return;
    const newPieces = Array.from({ length: 40 }, (_, i) => ({
      id: Date.now() + i,
      left: Math.random() * 100,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      delay: Math.random() * 1.5,
      size: 6 + Math.random() * 6,
    }));
    setPieces(newPieces);
    const timer = setTimeout(() => setPieces([]), 4000);
    return () => clearTimeout(timer);
  }, [active]);

  if (pieces.length === 0) return null;

  return (
    <>
      {pieces.map(p => (
        <div
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            background: p.color,
            width: p.size,
            height: p.size,
            animationDelay: `${p.delay}s`,
          }}
        />
      ))}
    </>
  );
}
