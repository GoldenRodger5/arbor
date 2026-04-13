import { useArbor } from '@/context/ArborContext';

const gradeColors: Record<string, string> = {
  A: 'var(--green)',
  B: 'var(--accent)',
  C: 'var(--amber)',
  D: 'var(--red)',
};

function GradeBadge({ grade }: { grade: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 32, height: 32, borderRadius: 8, fontWeight: 700, fontSize: 16,
      background: `${gradeColors[grade] ?? 'var(--text-tertiary)'}20`,
      color: gradeColors[grade] ?? 'var(--text-tertiary)',
      fontFamily: 'JetBrains Mono, monospace',
    }}>{grade}</span>
  );
}

export default function TradeReview() {
  const { trades } = useArbor();

  // Only show settled trades for review
  const settled = trades.filter(t => t.status === 'settled' || t.status?.startsWith('sold-'));
  const reviewed = settled.filter(t => t.reviewGrade);
  const unreviewed = settled.filter(t => !t.reviewGrade);

  // Stats
  const grades = reviewed.reduce((acc, t) => {
    const g = t.reviewGrade ?? '';
    acc[g] = (acc[g] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const processWins = reviewed.filter(t => t.reviewGrade === 'B' && (t.realizedPnL ?? 0) < 0).length;
  const luckyWins = reviewed.filter(t => t.reviewGrade === 'C' && (t.realizedPnL ?? 0) > 0).length;

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Trade Review</h1>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
        AI-powered post-game analysis of every trade. Grades process quality, not just outcome.
      </p>

      {/* Grade Summary */}
      {reviewed.length > 0 && (
        <div style={{
          display: 'flex', gap: 12, marginBottom: 20, padding: '16px 20px',
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
          flexWrap: 'wrap',
        }}>
          {['A', 'B', 'C', 'D'].map(g => (
            <div key={g} style={{ textAlign: 'center', minWidth: 60 }}>
              <GradeBadge grade={g} />
              <div className="font-mono" style={{ fontSize: 14, marginTop: 4 }}>{grades[g] ?? 0}</div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                {g === 'A' ? 'Great' : g === 'B' ? 'Solid' : g === 'C' ? 'Weak' : 'Bad'}
              </div>
            </div>
          ))}
          <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
            <div>Process wins (B losses): <span className="font-mono">{processWins}</span></div>
            <div>Lucky wins (C wins): <span className="font-mono">{luckyWins}</span></div>
            <div style={{ marginTop: 4, color: 'var(--text-tertiary)', fontSize: 11 }}>
              {reviewed.length} reviewed / {settled.length} settled
            </div>
          </div>
        </div>
      )}

      {/* Info: How grading works */}
      <div style={{
        padding: '14px 18px', marginBottom: 20, borderRadius: 10,
        background: 'rgba(99, 102, 241, 0.08)', border: '1px solid rgba(99, 102, 241, 0.2)',
        fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
      }}>
        <strong style={{ color: 'var(--accent)' }}>How grading works:</strong>
        <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '32px 1fr', gap: '4px 8px' }}>
          <GradeBadge grade="A" /><span><strong>Great trade</strong> — right reasoning, outcome matched prediction</span>
          <GradeBadge grade="B" /><span><strong>Solid process</strong> — good reasoning even if outcome was bad luck (or won despite weak reasoning)</span>
          <GradeBadge grade="C" /><span><strong>Weak trade</strong> — reasoning had gaps, got lucky or predictably lost</span>
          <GradeBadge grade="D" /><span><strong>Bad trade</strong> — should not have been taken, reasoning was flawed</span>
        </div>
        <div style={{ marginTop: 8, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
          Reviews activate after 50 settled trades when the calibration engine kicks in.
          Each trade will be reviewed by Sonnet 4.6 with full game context.
        </div>
      </div>

      {/* Settled Trades (pending review) */}
      <div className="label" style={{ marginBottom: 12 }}>
        SETTLED TRADES ({settled.length})
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {settled.reverse().map(t => {
          const won = (t.realizedPnL ?? 0) > 0;
          const icon = won ? '✅' : '❌';
          const pnl = t.realizedPnL ?? 0;
          const date = new Date(t.settledAt ?? t.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const sport = t.ticker?.includes('MLB') ? 'MLB' : t.ticker?.includes('NBA') ? 'NBA' :
            t.ticker?.includes('NHL') ? 'NHL' : t.strategy === 'ufc-prediction' ? 'UFC' : 'Other';

          return (
            <div key={t.id} style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
              padding: '14px 18px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 18 }}>{icon}</span>
                  {t.reviewGrade && <GradeBadge grade={t.reviewGrade} />}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.title}
                    </div>
                    <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {sport} | {t.side?.toUpperCase()} @ {(t.entryPrice * 100).toFixed(0)}¢ | {date}
                    </div>
                  </div>
                </div>
                <div className="font-mono" style={{
                  fontSize: 14, fontWeight: 600, flexShrink: 0,
                  color: pnl >= 0 ? 'var(--green)' : 'var(--red)',
                }}>
                  {pnl >= 0 ? '+' : ''}${Math.abs(pnl).toFixed(2)}
                </div>
              </div>

              {/* Claude's original reasoning */}
              <div style={{
                marginTop: 10, padding: '10px 12px', background: 'var(--bg-base)', borderRadius: 8,
                fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
              }}>
                <span style={{ fontWeight: 600, color: 'var(--text-tertiary)' }}>Claude: </span>
                {t.reasoning}
              </div>

              {/* AI Review (if reviewed) */}
              {t.reviewText && (
                <div style={{
                  marginTop: 8, padding: '10px 12px', borderRadius: 8,
                  background: `${gradeColors[t.reviewGrade ?? 'B']}10`,
                  border: `1px solid ${gradeColors[t.reviewGrade ?? 'B']}30`,
                  fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
                }}>
                  <span style={{ fontWeight: 600, color: gradeColors[t.reviewGrade ?? 'B'] }}>Review: </span>
                  {t.reviewText}
                </div>
              )}

              {/* Pending review badge */}
              {!t.reviewGrade && (
                <div style={{
                  marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic',
                }}>
                  Pending AI review — activates at 50 settled trades
                </div>
              )}
            </div>
          );
        })}
      </div>

      {settled.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>
          No settled trades yet. Reviews will appear here as games finish.
        </div>
      )}
    </div>
  );
}
