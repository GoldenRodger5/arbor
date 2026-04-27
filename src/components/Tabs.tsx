import { useSearchParams } from 'react-router-dom';
import { buzz } from '@/lib/notify';

export type Tab = {
  id: string;
  label: string;
  icon?: string;
};

type Props = {
  tabs: Tab[];
  /** URL search-param key. Default 'tab'. */
  paramKey?: string;
  /** Default tab id when none in URL. Defaults to first tab. */
  defaultTab?: string;
  /** Visual style — 'pills' or 'underline'. Default 'pills'. */
  variant?: 'pills' | 'underline';
  /** Sticky-position tabs at top of viewport when scrolling. Default true on mobile. */
  sticky?: boolean;
};

/** URL-synced tab navigation. Each tab updates ?tab=xxx so back button works
 *  and tabs are deep-linkable. Used by TradesPage and PerformancePage. */
export function TabsHeader({ tabs, paramKey = 'tab', defaultTab, variant = 'pills', sticky = true }: Props) {
  const [params, setParams] = useSearchParams();
  const active = params.get(paramKey) ?? defaultTab ?? tabs[0]?.id;

  const onChange = (id: string) => {
    buzz('light');
    const next = new URLSearchParams(params);
    next.set(paramKey, id);
    setParams(next, { replace: true });
  };

  return (
    <div
      role="tablist"
      style={{
        position: sticky ? 'sticky' : 'static',
        top: 0,
        zIndex: 10,
        background: 'var(--bg-base)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        margin: '0 -16px 16px',
        padding: '0 16px',
        borderBottom: variant === 'underline' ? '1px solid var(--border)' : 'none',
        display: 'flex',
        gap: variant === 'pills' ? 6 : 0,
        overflowX: 'auto',
        scrollbarWidth: 'none',
        WebkitOverflowScrolling: 'touch',
        paddingTop: variant === 'pills' ? 8 : 0,
        paddingBottom: variant === 'pills' ? 8 : 0,
      }}
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        if (variant === 'underline') {
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(t.id)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                padding: '12px 14px',
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                fontFamily: 'inherit',
                transition: 'border-color 100ms, color 100ms',
              }}
            >
              {t.icon && <span style={{ marginRight: 6 }}>{t.icon}</span>}
              {t.label}
            </button>
          );
        }
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            style={{
              background: isActive ? 'var(--accent)' : 'var(--bg-surface)',
              color: isActive ? 'white' : 'var(--text-secondary)',
              border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8,
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              fontFamily: 'inherit',
              transition: 'background 120ms, color 120ms',
            }}
          >
            {t.icon && <span style={{ marginRight: 6 }}>{t.icon}</span>}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** Hook for reading the current tab id from URL. */
export function useActiveTab(tabs: Tab[], paramKey = 'tab', defaultTab?: string): string {
  const [params] = useSearchParams();
  return params.get(paramKey) ?? defaultTab ?? tabs[0]?.id;
}
