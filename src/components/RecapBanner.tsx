import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RecapData } from '@/lib/api';

const DAILY_KEY = 'arbor:recap-seen-daily';
const WEEKLY_KEY = 'arbor:recap-seen-weekly';

/** Shows a compact daily recap the first time you open the app each day.
 *  On Sunday, upgrades to a weekly recap if the weekly hasn't been seen this week. */
export default function RecapBanner() {
  const [data, setData] = useState<RecapData | null>(null);
  const [period, setPeriod] = useState<'daily' | 'weekly'>('daily');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const isSunday = new Date().getDay() === 0;
    const weekKey = `${new Date().getFullYear()}-W${Math.floor(Date.now() / (7 * 864e5))}`;

    const seenDaily = localStorage.getItem(DAILY_KEY);
    const seenWeekly = localStorage.getItem(WEEKLY_KEY);

    const showWeekly = isSunday && seenWeekly !== weekKey;
    const showDaily = !showWeekly && seenDaily !== today;

    if (!showWeekly && !showDaily) { setDismissed(true); return; }

    const p = showWeekly ? 'weekly' : 'daily';
    setPeriod(p);
    api.getRecap(p).then(d => {
      // Only show if there's actually activity to recap
      if (d.placed === 0 && d.settled === 0) {
        setDismissed(true);
        return;
      }
      setData(d);
    }).catch(() => setDismissed(true));
  }, []);

  if (dismissed || !data) return null;

  const dismiss = () => {
    const today = new Date().toISOString().slice(0, 10);
    const weekKey = `${new Date().getFullYear()}-W${Math.floor(Date.now() / (7 * 864e5))}`;
    if (period === 'daily') localStorage.setItem(DAILY_KEY, today);
    else localStorage.setItem(WEEKLY_KEY, weekKey);
    setDismissed(true);
  };

  const pnl = data.totalPnL;
  const won = pnl > 0;

  return (
    <div style={{
      position: 'relative',
      background: `linear-gradient(135deg, ${won ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.10)'}, transparent)`,
      border: `1px solid ${won ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.30)'}`,
      borderRadius: 14, padding: 16,
    }}>
      <button onClick={dismiss} style={{
        position: 'absolute', top: 8, right: 10, background: 'none', border: 'none',
        color: 'var(--text-tertiary)', fontSize: 18, cursor: 'pointer', padding: 4, lineHeight: 1,
      }}>×</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>{period === 'weekly' ? '📅' : '☀️'}</span>
        <span className="label" style={{ color: won ? 'var(--green)' : 'var(--red)' }}>
          {period === 'weekly' ? 'WEEK' : 'YESTERDAY'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 10 }}>
        <span className="font-mono" style={{
          fontSize: 28, fontWeight: 700,
          color: won ? 'var(--green)' : 'var(--red)',
        }}>
          {won ? '+' : ''}${Math.abs(pnl).toFixed(2)}
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {data.wins}W–{data.losses}L · {data.winRate ?? 0}%
        </span>
      </div>

      {data.commentary && (
        <div style={{
          fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55,
          marginBottom: 10, whiteSpace: 'pre-wrap',
        }}>
          {data.commentary.split('\n\n')[0]}
        </div>
      )}

      <Link to="/recap" onClick={dismiss} style={{
        display: 'inline-block', fontSize: 12, color: 'var(--accent)',
        fontWeight: 600, textDecoration: 'none',
      }}>
        See full recap →
      </Link>
    </div>
  );
}
