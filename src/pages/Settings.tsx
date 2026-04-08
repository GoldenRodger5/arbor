import { useState } from 'react';
import { useScannerContext } from '@/context/ScannerContext';

function MaskedInput({ label, placeholder }: { label: string; placeholder?: string }) {
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="label" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 0 }}>
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 4, color: 'var(--text-primary)', fontSize: 13,
            fontFamily: "'JetBrains Mono', monospace", padding: '10px 12px',
            outline: 'none',
          }}
        />
        <button
          onClick={() => setVisible(!visible)}
          style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderLeft: 'none', borderRadius: '0 4px 4px 0', padding: '0 12px',
            color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12,
            fontFamily: 'Inter, sans-serif',
          }}
        >
          {visible ? 'HIDE' : 'SHOW'}
        </button>
      </div>
    </div>
  );
}

function TextInput({ label, placeholder, type = 'text', mono }: { label: string; placeholder?: string; type?: string; mono?: boolean }) {
  const [value, setValue] = useState('');
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="label" style={{ marginBottom: 6 }}>{label}</div>
      <input
        type={type}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 4, color: 'var(--text-primary)', fontSize: 13,
          fontFamily: mono ? "'JetBrains Mono', monospace" : 'Inter, sans-serif',
          padding: '10px 12px', outline: 'none',
        }}
      />
    </div>
  );
}

const intervalToSeconds = (i: string): number => {
  if (i === '30s') return 30;
  if (i === '60s') return 60;
  if (i === '5min') return 300;
  return 60;
};

const secondsToInterval = (s: number): string => {
  if (s <= 30) return '30s';
  if (s <= 60) return '60s';
  return '5min';
};

export default function Settings() {
  const { config, capital: ctxCapital, stats, startScan, stopScan, updateConfig } = useScannerContext();

  const [spreadThreshold, setSpreadThreshold] = useState(config.minNetSpread * 100);
  const [scanInterval, setScanInterval] = useState(secondsToInterval(config.intervalSeconds));
  const [capital, setCapital] = useState(String(ctxCapital.totalCapital));
  const [reserve, setReserve] = useState(String(Math.round(ctxCapital.safetyReservePct * 100)));

  const activeCapital = (parseFloat(capital || '0') * (1 - parseFloat(reserve || '0') / 100)).toFixed(2);

  const intervals = ['30s', '60s', '5min'];

  const handleSpreadChange = (v: number) => {
    setSpreadThreshold(v);
    updateConfig({ minNetSpread: v / 100 });
  };

  const handleIntervalChange = (i: string) => {
    setScanInterval(i);
    updateConfig({ intervalSeconds: intervalToSeconds(i) });
  };

  const toggleScan = () => {
    if (stats.isScanning) stopScan();
    else startScan();
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 32 }}>Settings</h1>

      {/* API Credentials */}
      <div className="label" style={{ marginBottom: 16 }}>API CREDENTIALS</div>
      <MaskedInput label="Kalshi API Key ID" />
      <MaskedInput label="Kalshi Private Key Path" />
      <MaskedInput label="Poly API Key" />
      <MaskedInput label="Poly Secret" />
      <MaskedInput label="Poly Passphrase" />

      <div style={{ height: 32 }} />

      {/* Scanner */}
      <div className="label" style={{ marginBottom: 16 }}>SCANNER</div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Min Net Spread Threshold</span>
          <span className="font-mono" style={{ fontSize: 13, color: 'var(--accent)' }}>{spreadThreshold.toFixed(1)}%</span>
        </div>
        <input
          type="range"
          min="0.5"
          max="10"
          step="0.5"
          value={spreadThreshold}
          onChange={(e) => handleSpreadChange(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--accent)' }}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)', marginRight: 12 }}>Scan Interval</span>
        <div style={{ display: 'inline-flex', gap: 4, marginTop: 8 }}>
          {intervals.map((int) => (
            <button
              key={int}
              onClick={() => handleIntervalChange(int)}
              style={{
                background: scanInterval === int ? 'var(--bg-elevated)' : 'transparent',
                color: scanInterval === int ? 'var(--text-primary)' : 'var(--text-tertiary)',
                border: '1px solid var(--border)', padding: '6px 14px', fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer',
                borderRadius: 4,
              }}
            >
              {int}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button
          onClick={toggleScan}
          style={{
            width: 40, height: 20, borderRadius: 10, border: 'none',
            background: stats.isScanning ? 'var(--accent)' : 'var(--text-tertiary)',
            position: 'relative', cursor: 'pointer', transition: 'background 200ms',
          }}
        >
          <div
            style={{
              width: 16, height: 16, borderRadius: '50%', background: 'var(--text-primary)',
              position: 'absolute', top: 2,
              left: stats.isScanning ? 22 : 2, transition: 'left 200ms',
            }}
          />
        </button>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{stats.isScanning ? 'Scanning' : 'Idle'}</span>
      </div>

      <div style={{ height: 32 }} />

      {/* Capital */}
      <div className="label" style={{ marginBottom: 16 }}>CAPITAL</div>
      <TextInput label="Starting Capital" placeholder="$500" type="number" mono />
      <TextInput label="Safety Reserve %" placeholder="20" type="number" mono />
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
        Active Capital: <span className="font-mono">${activeCapital}</span>
      </div>

      <div style={{ height: 32 }} />

      {/* Alerts */}
      <div className="label" style={{ marginBottom: 16 }}>ALERTS</div>
      <MaskedInput label="Telegram Bot Token" />
      <TextInput label="Telegram Chat ID" mono />
      <button
        style={{
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          color: 'var(--text-primary)', padding: '8px 16px', fontSize: 12,
          textTransform: 'uppercase', fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.05em', cursor: 'pointer',
        }}
      >
        Send Test Alert
      </button>

      <div style={{ height: 32 }} />

      {/* Danger */}
      <div className="label" style={{ marginBottom: 16 }}>DANGER</div>
      <button
        style={{
          background: 'var(--bg-surface)', border: '1px solid rgba(239,68,68,0.3)',
          color: 'var(--red)', padding: '8px 16px', fontSize: 12,
          textTransform: 'uppercase', fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.05em', cursor: 'pointer',
        }}
      >
        Clear All Logs
      </button>
    </div>
  );
}
