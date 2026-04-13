import { useArbor } from '@/context/ArborContext';

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
      <span className="font-mono" style={{ fontSize: 13 }}>{value}</span>
    </div>
  );
}

export default function SettingsPage() {
  const { stats } = useArbor();
  const s = stats ?? {};

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Settings & System</h1>

      {/* System Status */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div className="label" style={{ marginBottom: 12 }}>SYSTEM STATUS</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span className="status-dot-live" style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Bot Online</span>
        </div>
        <InfoRow label="Total Trades" value={s.totalTrades ?? 0} />
        <InfoRow label="Settled" value={`${s.settledTrades ?? 0} (${s.wins ?? 0}W / ${s.losses ?? 0}L)`} />
        <InfoRow label="Win Rate" value={s.winRate != null ? `${s.winRate}%` : 'N/A'} />
        <InfoRow label="Open Positions" value={s.openTrades ?? 0} />
      </div>

      {/* Configuration (read-only) */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div className="label" style={{ marginBottom: 12 }}>TRADING CONFIGURATION</div>
        <InfoRow label="Min Confidence" value="65%" />
        <InfoRow label="Max Price" value="90¢" />
        <InfoRow label="Max Trade (% bankroll)" value="10%" />
        <InfoRow label="Max Positions" value="12" />
        <InfoRow label="Deployment Cap" value="85%" />
        <InfoRow label="Daily Loss Limit" value="15%" />
        <InfoRow label="Capital Reserve" value="5%" />
        <InfoRow label="Cooldown" value="5 min" />
        <InfoRow label="Poll Interval" value="60s" />
      </div>

      {/* Dynamic Margins */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div className="label" style={{ marginBottom: 12 }}>DYNAMIC MARGINS (LIVE)</div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12 }}>
          Live bets use sport base only. No price penalty — high prices reflect game state.
        </div>
        <InfoRow label="NHL" value="3% (2% with score change)" />
        <InfoRow label="NBA" value="4% (3% with score change)" />
        <InfoRow label="MLB" value="5% (4% with score change)" />
        <InfoRow label="Soccer" value="5% (4% with score change)" />
        <InfoRow label="UFC" value="2% (1% with score change)" />
      </div>

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div className="label" style={{ marginBottom: 12 }}>DYNAMIC MARGINS (PRE-GAME)</div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12 }}>
          Pre-game adds +1% base. Favorites at 70¢+ get +3% more (trap protection).
        </div>
        <InfoRow label="NHL (&lt;55¢ / 55-70¢ / 70¢+)" value="4% / 5% / 7%" />
        <InfoRow label="NBA (&lt;55¢ / 55-70¢ / 70¢+)" value="5% / 6% / 8%" />
        <InfoRow label="MLB (&lt;55¢ / 55-70¢ / 70¢+)" value="6% / 7% / 9%" />
        <InfoRow label="Soccer (&lt;55¢ / 55-70¢ / 70¢+)" value="6% / 7% / 9%" />
        <InfoRow label="UFC (&lt;55¢ / 55-70¢ / 70¢+)" value="3% / 4% / 6%" />
      </div>

      {/* Sport Performance Quick View */}
      {(s.sportPerformance ?? []).length > 0 && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <div className="label" style={{ marginBottom: 12 }}>SPORT STATUS</div>
          {(s.sportPerformance ?? []).map((sp: any) => (
            <div key={sp.sport} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: sp.winRate >= 55 ? 'var(--green)' : sp.winRate >= 45 ? 'var(--amber)' : 'var(--red)',
              }} />
              <span style={{ flex: 1, fontWeight: 500, fontSize: 13, textTransform: 'uppercase' }}>{sp.sport}</span>
              <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {sp.trades} trades | {sp.winRate}% | <span style={{ color: sp.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {sp.pnl >= 0 ? '+' : ''}${sp.pnl.toFixed(2)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
