import { positions, type Verdict } from '@/data/mock';

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const colors: Record<Verdict, string> = { SAFE: 'var(--green)', CAUTION: 'var(--amber)', SKIP: 'var(--red)' };
  const c = colors[verdict];
  return (
    <span className="font-mono" style={{ fontSize: 10, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 6, color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` }}>
      {verdict}
    </span>
  );
}

function formatSettlement(dateStr: string) {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return 'expired';
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `in ${days}d ${hours}h`;
  return `in ${hours}h`;
}

function isUrgent(dateStr: string) {
  const diff = new Date(dateStr).getTime() - Date.now();
  return diff < 86400000;
}

export default function Positions() {
  const openCount = positions.length;

  if (openCount === 0) {
    return (
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Positions</h1>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '50vh' }}>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>No open positions.</span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Positions</h1>
        <span className="font-mono" style={{ fontSize: 11, textTransform: 'uppercase', padding: '2px 10px', borderRadius: 6, color: 'var(--accent)', background: 'rgba(99,102,241,0.12)' }}>
          {openCount} OPEN
        </span>
      </div>

      {positions.map((p) => (
        <div key={p.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: 20, marginBottom: 12, borderRadius: 6 }}>
          {/* Top row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{p.event}</span>
            <VerdictBadge verdict={p.verdict} />
          </div>

          {/* Two columns */}
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div className="label">POLY LEG</div>
                <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 2 }}>{p.polyLeg}</div>
              </div>
              <div>
                <div className="label">KALSHI LEG</div>
                <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 2 }}>{p.kalshiLeg}</div>
              </div>
              <div>
                <div className="label">DEPLOYED</div>
                <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 2 }}>${p.deployed.toFixed(2)}</div>
              </div>
            </div>

            <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div className="label">UNREALIZED P&L</div>
                <div className="font-mono" style={{ fontSize: 18, fontWeight: 600, color: p.unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 2 }}>
                  {p.unrealizedPnl >= 0 ? '+' : ''}${Math.abs(p.unrealizedPnl).toFixed(2)}
                </div>
              </div>
              <div>
                <div className="label">NET SPREAD</div>
                <div className="font-mono" style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 2 }}>{p.netSpread}%</div>
              </div>
            </div>
          </div>

          {/* Bottom row */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span className="label">SETTLES </span>
              <span className="font-mono" style={{ fontSize: 12, color: isUrgent(p.settles) ? 'var(--amber)' : 'var(--text-secondary)' }}>
                {formatSettlement(p.settles)}
              </span>
            </div>
            <a href="#" style={{ fontSize: 12, color: 'var(--text-secondary)', textDecoration: 'none' }}>VIEW POSITION ↗</a>
          </div>
        </div>
      ))}
    </div>
  );
}
