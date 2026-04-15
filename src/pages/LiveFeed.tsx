import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://87.99.155.128:3456';
const API_TOKEN = import.meta.env.VITE_API_TOKEN ?? 'arbor-2026';
const isDev = import.meta.env.DEV;

interface FeedEntry {
  ts: string;
  tag: string;
  msg: string;
  type: string;
  raw: string;
}

const typeColors: Record<string, { bg: string; text: string; icon: string }> = {
  trade:     { bg: 'rgba(34, 197, 94, 0.12)', text: 'var(--green)', icon: '🎯' },
  win:       { bg: 'rgba(34, 197, 94, 0.08)', text: 'var(--green)', icon: '✅' },
  loss:      { bg: 'rgba(239, 68, 68, 0.08)', text: 'var(--red)', icon: '❌' },
  block:     { bg: 'rgba(239, 68, 68, 0.06)', text: 'var(--red)', icon: '🚫' },
  analysis:  { bg: 'rgba(99, 102, 241, 0.08)', text: 'var(--accent)', icon: '🧠' },
  portfolio: { bg: 'transparent', text: 'var(--text-tertiary)', icon: '💰' },
  dryrun:    { bg: 'rgba(245, 158, 11, 0.08)', text: 'var(--amber)', icon: '🧪' },
  info:      { bg: 'transparent', text: 'var(--text-secondary)', icon: '📋' },
};

const tagFilters = ['all', 'live-edge', 'pre-game', 'broad-scan', 'portfolio', 'exit', 'pnl', 'sync', 'risk'];

function SummaryCard() {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [hours, setHours] = useState(1);
  const [err, setErr] = useState<string | null>(null);

  const load = async (h = hours) => {
    setLoading(true);
    setErr(null);
    try {
      const data = await api.getSummary(h);
      setSummary(data.summary);
      setGeneratedAt(data.generatedAt);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(hours); }, [hours]);

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(99,102,241,0.02))',
      border: '1px solid rgba(99,102,241,0.25)', borderRadius: 12,
      padding: 14, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 14 }}>🧠</span>
        <span className="label" style={{ color: 'var(--accent)' }}>AI SUMMARY</span>
        <div style={{ flex: 1 }} />
        {[1, 3, 6].map(h => (
          <button key={h} onClick={() => setHours(h)} style={{
            padding: '2px 8px', borderRadius: 4, fontSize: 10,
            background: hours === h ? 'var(--accent)' : 'transparent',
            color: hours === h ? 'white' : 'var(--text-tertiary)',
            border: '1px solid var(--border)', cursor: 'pointer',
          }}>{h}h</button>
        ))}
        <button onClick={() => load(hours)} disabled={loading} style={{
          padding: '2px 8px', borderRadius: 4, fontSize: 10,
          background: 'transparent', color: 'var(--text-tertiary)',
          border: '1px solid var(--border)', cursor: loading ? 'default' : 'pointer',
          opacity: loading ? 0.5 : 1,
        }}>{loading ? '…' : '↻'}</button>
      </div>

      {err && <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div>}

      {summary ? (
        <div style={{
          fontSize: 13, color: 'var(--text-secondary)',
          lineHeight: 1.6, whiteSpace: 'pre-wrap',
        }}>
          {summary}
        </div>
      ) : loading ? (
        <div className="skeleton" style={{ height: 60, borderRadius: 6 }} />
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No summary yet.</div>
      )}

      {generatedAt && (
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 8 }}>
          Generated {new Date(generatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · cached 5 min
        </div>
      )}
    </div>
  );
}

export default function LiveFeed() {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [filter, setFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paused) return;

    const fetchFeed = async () => {
      try {
        let url: string;
        if (isDev) {
          url = `${API_BASE}/api/live-feed?token=${API_TOKEN}&limit=100`;
        } else {
          url = `/api/proxy?path=/api/live-feed&limit=100`;
        }
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          setEntries(data);
        }
      } catch {}
    };

    fetchFeed();
    const interval = setInterval(fetchFeed, 10000);
    return () => clearInterval(interval);
  }, [paused]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, autoScroll]);

  const filtered = entries.filter(e => {
    if (filter !== 'all' && e.tag !== filter) return false;
    if (typeFilter !== 'all' && e.type !== typeFilter) return false;
    // Hide noisy portfolio lines unless specifically filtered
    if (filter === 'all' && e.type === 'portfolio') return false;
    return true;
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Live Feed</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setPaused(!paused)} style={{
            background: paused ? 'var(--amber)' : 'var(--green)', color: 'white', border: 'none',
            borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>
            {paused ? 'PAUSED' : 'LIVE'}
          </button>
          <button onClick={() => setAutoScroll(!autoScroll)} style={{
            background: 'var(--bg-surface)', color: autoScroll ? 'var(--accent)' : 'var(--text-tertiary)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer',
          }}>
            Auto-scroll {autoScroll ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* AI Summary */}
      <SummaryCard />

      {/* Filters */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {tagFilters.map(t => (
          <button key={t} onClick={() => setFilter(t)} style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
            background: filter === t ? 'var(--accent)' : 'var(--bg-surface)',
            color: filter === t ? 'white' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}>{t}</button>
        ))}
        <span style={{ width: 1, background: 'var(--border)', margin: '0 4px' }} />
        {['all', 'trade', 'analysis', 'block', 'win', 'loss'].map(t => (
          <button key={t} onClick={() => setTypeFilter(t)} style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
            background: typeFilter === t ? 'var(--accent)' : 'var(--bg-surface)',
            color: typeFilter === t ? 'white' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}>{t === 'all' ? 'all types' : (typeColors[t]?.icon ?? '') + ' ' + t}</button>
        ))}
      </div>

      {/* Feed */}
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
        padding: 12, height: 'calc(100vh - 220px)', overflowY: 'auto',
        fontFamily: 'JetBrains Mono, monospace', fontSize: 11, lineHeight: 1.6,
      }}>
        {filtered.length === 0 ? (
          <div style={{ color: 'var(--text-tertiary)', padding: 20, textAlign: 'center' }}>
            {paused ? 'Feed paused' : 'Waiting for data...'}
          </div>
        ) : (
          filtered.map((e, i) => {
            const colors = typeColors[e.type] ?? typeColors.info;
            return (
              <div key={i} style={{
                padding: '3px 8px', marginBottom: 2, borderRadius: 4,
                background: colors.bg,
                display: 'flex', gap: 8, alignItems: 'flex-start',
              }}>
                <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, width: 48 }}>
                  {e.ts?.slice(11, 19) ?? ''}
                </span>
                <span style={{ color: 'var(--accent)', flexShrink: 0, width: 80 }}>
                  [{e.tag}]
                </span>
                <span style={{ color: colors.text, wordBreak: 'break-word' }}>
                  {e.msg}
                </span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
