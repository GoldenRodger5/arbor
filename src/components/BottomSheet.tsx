import { Drawer } from 'vaul';
import type { ReactNode } from 'react';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
};

/**
 * Native-feeling bottom sheet (vaul). Drag-to-dismiss, spring physics,
 * snapping, safe-area aware. Works on desktop and mobile.
 */
export default function BottomSheet({ open, onOpenChange, title, subtitle, children }: Props) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
          zIndex: 9998, backdropFilter: 'blur(2px)',
        }} />
        <Drawer.Content style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
          background: 'var(--bg-surface)',
          borderTopLeftRadius: 18, borderTopRightRadius: 18,
          borderTop: '1px solid var(--border)',
          maxHeight: '92vh',
          display: 'flex', flexDirection: 'column',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          boxShadow: '0 -12px 48px rgba(0,0,0,0.5)',
          outline: 'none',
        }}>
          {/* Grab handle */}
          <div style={{
            display: 'flex', justifyContent: 'center', padding: '10px 0 6px',
            flexShrink: 0,
          }}>
            <div style={{
              width: 40, height: 4, borderRadius: 2,
              background: 'var(--text-tertiary)', opacity: 0.5,
            }} />
          </div>

          {(title || subtitle) && (
            <div style={{
              padding: '4px 20px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
            }}>
              {title && (
                <Drawer.Title style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
                  {title}
                </Drawer.Title>
              )}
              {subtitle && (
                <Drawer.Description style={{
                  fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0',
                }}>
                  {subtitle}
                </Drawer.Description>
              )}
            </div>
          )}

          <div style={{ overflowY: 'auto', padding: 20, flex: 1 }}>
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
