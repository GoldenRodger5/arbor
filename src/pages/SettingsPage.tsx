import { useEffect, useRef, useState } from 'react';
import { useArbor } from '@/context/ArborContext';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { buzz, notificationPermission, requestNotificationPermission } from '@/lib/notify';

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
      <span className="font-mono" style={{ fontSize: 13 }}>{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 20, marginBottom: 16,
    }}>
      <div className="label" style={{ marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

const STRATEGIES = [
  { key: 'live-edge', label: 'Live edge (in-game scanner)' },
  { key: 'pre-game', label: 'Pre-game predictions' },
  { key: 'broad-scan', label: 'Broad Claude scan' },
  { key: 'ufc-prediction', label: 'UFC (Polymarket)' },
];

export default function SettingsPage() {
  const { stats, control, refreshControl } = useArbor();
  const s = stats ?? {};

  const [notifState, setNotifState] = useState<string>('default');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setNotifState(notificationPermission()); }, []);

  // ─── Hold-to-confirm STOP ───────────────────────────────────────────────
  const [holdPct, setHoldPct] = useState(0);
  const holdTimer = useRef<number | null>(null);
  const holdStart = useRef<number>(0);
  const HOLD_MS = 1200;

  const startHold = () => {
    if (busy) return;
    buzz('light');
    holdStart.current = Date.now();
    const tick = () => {
      const elapsed = Date.now() - holdStart.current;
      const pct = Math.min(1, elapsed / HOLD_MS);
      setHoldPct(pct);
      if (pct >= 1) {
        cancelHold();
        confirmStop();
      } else {
        holdTimer.current = window.requestAnimationFrame(tick);
      }
    };
    holdTimer.current = window.requestAnimationFrame(tick);
  };
  const cancelHold = () => {
    if (holdTimer.current) cancelAnimationFrame(holdTimer.current);
    holdTimer.current = null;
    setHoldPct(0);
  };

  const confirmStop = async () => {
    setBusy(true);
    try {
      await api.pause('hold-to-stop');
      buzz('error');
      toast.warning('Bot paused — no new trades will be placed');
      await refreshControl();
    } catch (e: any) {
      toast.error(`Pause failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    try {
      await api.resume();
      buzz('success');
      toast.success('Bot resumed');
      await refreshControl();
    } catch (e: any) {
      toast.error(`Resume failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleStrategy = async (key: string, disabled: boolean) => {
    setBusy(true);
    try {
      await api.toggleStrategy(key, disabled ? 'enable' : 'disable');
      buzz('light');
      toast.success(disabled ? `Enabled ${key}` : `Disabled ${key}`);
      await refreshControl();
    } catch (e: any) {
      toast.error(`Toggle failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const enableNotifs = async () => {
    const result = await requestNotificationPermission();
    setNotifState(result);
    if (result === 'granted') toast.success('Notifications enabled');
  };

  const disabledSet = new Set(control.disabledStrategies ?? []);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Settings & Control</h1>

      {/* Bot control — the big deal */}
      <Section title="BOT CONTROL">
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
          padding: '8px 12px', background: 'var(--bg-base)', borderRadius: 8,
        }}>
          <span className={control.paused ? '' : 'status-dot-live'} style={{
            width: 10, height: 10, borderRadius: '50%',
            background: control.paused ? 'var(--amber)' : 'var(--green)',
          }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {control.paused ? 'Paused' : 'Running'}
          </span>
          {control.paused && control.pausedReason && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>
              reason: {control.pausedReason}
            </span>
          )}
          {control.updatedAt && (
            <span style={{ marginLeft: control.paused ? 0 : 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>
              {new Date(control.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {control.paused ? (
          <button
            onClick={resume}
            disabled={busy}
            style={{
              width: '100%', background: 'var(--green)', color: 'white', border: 'none',
              borderRadius: 10, padding: '14px', fontSize: 14, fontWeight: 700,
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            ▶ Resume Trading
          </button>
        ) : (
          <button
            onPointerDown={startHold}
            onPointerUp={cancelHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
            disabled={busy}
            style={{
              width: '100%', position: 'relative', overflow: 'hidden',
              background: 'var(--red)', color: 'white', border: 'none',
              borderRadius: 10, padding: '14px', fontSize: 14, fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
              userSelect: 'none', touchAction: 'none',
            }}
          >
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${holdPct * 100}%`, background: 'rgba(0,0,0,0.25)', transition: 'width 60ms linear',
            }} />
            <span style={{ position: 'relative', zIndex: 1 }}>
              {holdPct > 0 ? 'Keep holding…' : '⏸ Hold to Pause'}
            </span>
          </button>
        )}
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          Paused = no new orders. Open positions continue to be monitored and sold per their rules.
        </div>
      </Section>

      {/* Strategy toggles */}
      <Section title="STRATEGIES">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {STRATEGIES.map(st => {
            const disabled = disabledSet.has(st.key);
            return (
              <label key={st.key} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                background: 'var(--bg-base)', borderRadius: 8, cursor: 'pointer',
              }}>
                <span style={{ flex: 1, fontSize: 13 }}>{st.label}</span>
                <button
                  type="button"
                  onClick={() => toggleStrategy(st.key, disabled)}
                  disabled={busy}
                  style={{
                    position: 'relative', width: 42, height: 24, borderRadius: 12,
                    background: disabled ? 'var(--bg-elevated)' : 'var(--green)',
                    border: '1px solid var(--border)', cursor: busy ? 'default' : 'pointer',
                    padding: 0, transition: 'background 150ms',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: disabled ? 2 : 20,
                    width: 18, height: 18, borderRadius: '50%',
                    background: '#fff', transition: 'left 150ms',
                  }} />
                </button>
              </label>
            );
          })}
        </div>
      </Section>

      {/* Notifications */}
      <Section title="NOTIFICATIONS">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)' }}>
            Browser alerts for new trades, wins, and losses
          </span>
          {notifState === 'granted' ? (
            <span style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>✓ Enabled</span>
          ) : notifState === 'denied' ? (
            <span style={{ fontSize: 12, color: 'var(--red)' }}>Blocked in browser</span>
          ) : (
            <button
              onClick={enableNotifs}
              style={{
                background: 'var(--accent)', color: 'white', border: 'none',
                borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >Enable</button>
          )}
        </div>
      </Section>

      {/* System status */}
      <Section title="SYSTEM STATUS">
        <InfoRow label="Total Trades" value={s.totalTrades ?? 0} />
        <InfoRow label="Settled (known PnL)" value={`${s.settledTrades ?? 0} (${s.wins ?? 0}W / ${s.losses ?? 0}L)`} />
        <InfoRow
          label="Closed w/ unknown PnL"
          value={s.closedManualTrades ?? 0}
        />
        <InfoRow label="Win Rate (of known)" value={s.winRate != null ? `${s.winRate}%` : 'N/A'} />
        <InfoRow label="Open Positions" value={s.openTrades ?? 0} />
      </Section>

      {/* Bankroll source */}
      <Section title="BANKROLL SOURCE">
        <InfoRow label="Live bankroll" value={<>${(s.liveBankroll ?? 0).toFixed(2)}</>} />
        <InfoRow
          label="Source"
          value={s.bankrollSource === 'live-portfolio' ? 'Bot portfolio log (LIVE)' : 'Snapshot estimate'}
        />
        {s.livePortfolio && (
          <>
            <InfoRow label="Kalshi cash" value={<>${s.livePortfolio.kalshiCash.toFixed(2)}</>} />
            <InfoRow label="Kalshi positions" value={<>${s.livePortfolio.kalshiPositions.toFixed(2)}</>} />
            <InfoRow label="Polymarket" value={<>${s.livePortfolio.polyBalance.toFixed(2)}</>} />
            <InfoRow label="Portfolio updated" value={s.livePortfolio.at ?? '—'} />
          </>
        )}
        {s.bankrollIsEstimated && (
          <InfoRow
            label="Estimate range"
            value={<>${(s.liveBankrollLo ?? 0).toFixed(2)} – ${(s.liveBankrollHi ?? 0).toFixed(2)}</>}
          />
        )}
        <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-base)', borderRadius: 8, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          The bot logs its true Kalshi + Polymarket balance every cycle. We use
          that log line as the authoritative bankroll. When unavailable (startup,
          log rotation), we estimate from the daily snapshot + realized P&L since,
          which is less accurate when trades close without a captured PnL.
        </div>
      </Section>

      {/* Configuration (read-only) */}
      <Section title="TRADING CONFIGURATION">
        <InfoRow label="Min Confidence" value="65%" />
        <InfoRow label="Max Price" value="sport-dependent (75-82¢)" />
        <InfoRow label="Deployment Cap" value="85% (scales by bankroll)" />
        <InfoRow label="Max Positions" value="dynamic" />
        <InfoRow label="Poll Interval" value="60s" />
      </Section>
    </div>
  );
}
