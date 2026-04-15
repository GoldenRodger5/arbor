import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useArbor } from '@/context/ArborContext';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { buzz, notificationPermission, requestNotificationPermission } from '@/lib/notify';
import { useEffect, useState } from 'react';
import AnimatedNumber from '@/components/AnimatedNumber';
import RecapBanner from '@/components/RecapBanner';
import LiveScouting from '@/components/LiveScouting';

function sportOf(ticker?: string, strategy?: string): string {
  const tk = (ticker ?? '').toUpperCase();
  if (tk.includes('MLB')) return 'MLB';
  if (tk.includes('NBA')) return 'NBA';
  if (tk.includes('NHL')) return 'NHL';
  if (tk.includes('MLS')) return 'MLS';
  if (tk.includes('EPL')) return 'EPL';
  if (tk.includes('LALIGA')) return 'La Liga';
  if (strategy === 'ufc-prediction') return 'UFC';
  return 'Other';
}

const SPORT_COLOR: Record<string, string> = {
  MLB: '#002d72', NBA: '#c9082a', NHL: '#0066cc',
  MLS: '#005293', EPL: '#3d195b', 'La Liga': '#ff4b00',
  UFC: '#d20a0a', Other: '#4B4B5E',
};

export default function TodayPage() {
  const { stats, positions, trades, control, realtime, connected, refresh, refreshing, loading } = useArbor();
  const [notifState, setNotifState] = useState<string>('default');

  useEffect(() => {
    setNotifState(notificationPermission());
  }, []);

  const s = stats ?? {};
  const bankroll = s.liveBankroll ?? s.latestSnapshot?.bankroll ?? 0;
  const bankrollSource = s.bankrollSource as string | undefined;
  const bankrollAt = s.livePortfolio?.at as string | undefined;
  const closedManualCount = s.closedManualTrades ?? 0;
  const todayPnL = s.todayPnL ?? 0;
  const todayTrades = s.todayTrades ?? 0;
  const todaySettled = s.todaySettled ?? 0;
  const streak = s.streak ?? 0;
  const streakType = s.streakType ?? '';
  const streakIcon = streakType === 'win' && streak >= 3 ? '🔥' : streakType === 'win' ? '✅' : streakType === 'loss' ? '❌' : '';

  // Recent activity: last 5 events
  const recent = useMemo(() => [...trades].reverse().slice(0, 5), [trades]);

  // Latest reasoning (last open or most-recent trade with reasoning)
  const latestReasoned = useMemo(() => {
    for (const t of [...trades].reverse()) {
      if (t.reasoning && t.reasoning.length > 20) return t;
    }
    return null;
  }, [trades]);

  const enableNotifs = async () => {
    const result = await requestNotificationPermission();
    setNotifState(result);
    if (result === 'granted') {
      toast.success('Notifications enabled');
      buzz('success');
    } else if (result === 'denied') {
      toast.error('Notifications blocked — enable in browser settings');
    }
  };

  const togglePause = async () => {
    try {
      buzz('light');
      if (control.paused) {
        await api.resume();
      } else {
        // Hold-to-confirm handled below for pause; simple tap = pause via menu
        await api.pause('manual-tap');
      }
    } catch (e: any) {
      toast.error(`Control failed: ${e.message}`);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 40, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="skeleton" style={{ height: 80, borderRadius: 12 }} />
        <div className="skeleton" style={{ height: 48, borderRadius: 10 }} />
        <div className="skeleton" style={{ height: 120, borderRadius: 12 }} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Status strip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11,
        color: 'var(--text-tertiary)',
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: connected ? (realtime ? 'var(--green)' : 'var(--amber)') : 'var(--red)',
          display: 'inline-block',
        }} className={connected ? 'status-dot-live' : ''} />
        <span>{realtime ? 'Live push' : connected ? 'Polling' : 'Offline'}</span>
        {control.paused && (
          <span style={{
            marginLeft: 'auto', background: 'rgba(245,158,11,0.15)', color: 'var(--amber)',
            padding: '2px 8px', borderRadius: 4, fontWeight: 600, letterSpacing: '0.06em',
          }}>PAUSED</span>
        )}
        {!control.paused && (
          <button
            onClick={refresh}
            disabled={refreshing}
            style={{
              marginLeft: 'auto', background: 'none', border: 'none',
              color: 'var(--text-tertiary)', fontSize: 11, cursor: 'pointer', padding: 0,
            }}
          >{refreshing ? 'Refreshing…' : 'Refresh'}</button>
        )}
      </div>

      {/* Hero: bankroll + today */}
      <div style={{
        background: 'linear-gradient(135deg, var(--bg-surface), var(--bg-elevated))',
        border: '1px solid var(--border)', borderRadius: 16, padding: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className="label">BANKROLL</span>
          {bankrollSource === 'live-portfolio' ? (
            <span title={bankrollAt ? `From bot portfolio log at ${bankrollAt}` : 'From bot portfolio log'} style={{
              fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              background: 'rgba(34,197,94,0.15)', color: 'var(--green)',
              letterSpacing: '0.06em',
            }}>LIVE</span>
          ) : (
            <span title="No recent portfolio log — showing snapshot estimate" style={{
              fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              background: 'rgba(245,158,11,0.15)', color: 'var(--amber)',
              letterSpacing: '0.06em',
            }}>EST</span>
          )}
        </div>
        <AnimatedNumber
          value={bankroll}
          prefix="$"
          style={{ fontSize: 38, fontWeight: 700, letterSpacing: '-0.02em', display: 'block' }}
        />
        {closedManualCount > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
            {closedManualCount} trade{closedManualCount !== 1 ? 's' : ''} with unknown PnL not included in stats
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 10 }}>
          <div>
            <div className="label">TODAY</div>
            <AnimatedNumber
              value={todayPnL}
              prefix="$"
              signed
              colorize
              style={{ fontSize: 22, fontWeight: 700 }}
            />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {todayTrades} trade{todayTrades !== 1 ? 's' : ''} · {todaySettled} settled
          </div>
          {streak > 0 && (
            <div style={{ marginLeft: 'auto', fontSize: 13 }}>
              <span className={streakType === 'win' && streak >= 3 ? 'streak-fire' : ''}>
                {streakIcon} {streak} {streakType}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Live scouting — what bot is watching right now */}
      <LiveScouting />

      {/* Recap banner (first open of day / week) */}
      <RecapBanner />

      {/* Notifications prompt (first visit) */}
      {notifState === 'default' && (
        <button
          onClick={enableNotifs}
          style={{
            background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)',
            borderRadius: 12, padding: '12px 14px', textAlign: 'left', cursor: 'pointer',
            color: 'var(--accent)', fontSize: 13, fontWeight: 500,
            display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <span style={{ fontSize: 18 }}>🔔</span>
          <span style={{ flex: 1 }}>Enable alerts for new trades and wins</span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Tap to enable</span>
        </button>
      )}

      {/* Open positions */}
      <section style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="label">OPEN POSITIONS ({positions.length})</div>
          <Link to="/positions" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>See all →</Link>
        </div>
        {positions.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 0' }}>
            No open positions. Waiting for an edge.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {positions.slice(0, 5).map(p => {
              const sport = sportOf(p.ticker, p.strategy);
              return (
                <Link key={p.id} to="/positions" style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  background: 'var(--bg-base)', borderRadius: 8, textDecoration: 'none',
                  color: 'inherit',
                }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                    background: SPORT_COLOR[sport] ?? 'var(--bg-elevated)', color: '#fff', flexShrink: 0,
                  }}>{sport}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.title}
                  </span>
                  <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>
                    {p.side?.toUpperCase()} @ {(p.entryPrice * 100).toFixed(0)}¢
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Latest reasoning */}
      {latestReasoned && (
        <section style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div className="label">LATEST REASONING</div>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
              {new Date(latestReasoned.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {latestReasoned.title}
          </div>
          <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>
            {latestReasoned.side?.toUpperCase()} @ {(latestReasoned.entryPrice * 100).toFixed(0)}¢ ·
            {' '}conf {(latestReasoned.confidence * 100).toFixed(0)}%
            {latestReasoned.edge != null && <> · edge {latestReasoned.edge.toFixed(1)}%</>}
          </div>
          <div style={{
            fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, fontStyle: 'italic',
          }}>
            {latestReasoned.reasoning}
          </div>
        </section>
      )}

      {/* Recent activity */}
      <section style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div className="label">RECENT</div>
          <Link to="/history" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>See all →</Link>
        </div>
        {recent.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No activity yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recent.map(t => {
              const icon = t.status === 'settled' && (t.realizedPnL ?? 0) >= 0 ? '✅' :
                t.status === 'settled' ? '❌' :
                t.status?.startsWith('sold-') ? '🛑' :
                t.status === 'open' ? '🎯' : '📋';
              const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
              return (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
                  <span>{icon}</span>
                  <span className="font-mono" style={{ color: 'var(--text-tertiary)', width: 52, flexShrink: 0 }}>{time}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.title}
                  </span>
                  {t.realizedPnL != null && (
                    <span className="font-mono" style={{
                      color: (t.realizedPnL ?? 0) >= 0 ? 'var(--green)' : 'var(--red)',
                      fontWeight: 600, flexShrink: 0,
                    }}>
                      {(t.realizedPnL ?? 0) >= 0 ? '+' : ''}${Math.abs(t.realizedPnL ?? 0).toFixed(2)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <button onClick={togglePause} style={{
          background: control.paused ? 'var(--green)' : 'var(--bg-surface)',
          color: control.paused ? 'white' : 'var(--amber)',
          border: `1px solid ${control.paused ? 'var(--green)' : 'rgba(245,158,11,0.3)'}`,
          borderRadius: 12, padding: '14px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
        }}>
          {control.paused ? '▶ Resume Bot' : '⏸ Pause Bot'}
        </button>
        <Link to="/settings" style={{
          background: 'var(--bg-surface)', color: 'var(--text-secondary)',
          border: '1px solid var(--border)', borderRadius: 12,
          padding: '14px 12px', fontSize: 13, fontWeight: 600,
          textDecoration: 'none', textAlign: 'center',
        }}>
          ⚙ Settings
        </Link>
      </div>
    </div>
  );
}
