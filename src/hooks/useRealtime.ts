import { useEffect, useRef } from 'react';
import { eventsUrl } from '@/lib/api';

type EventHandler = (data: any) => void;
type Handlers = {
  onTrade?: EventHandler;
  onScreen?: EventHandler;
  onControl?: EventHandler;
  onSellRequest?: EventHandler;
  onConnect?: () => void;
  onDisconnect?: () => void;
};

/**
 * Subscribe to the bot's SSE stream for live trades/screens/control changes.
 * Auto-reconnects with exponential backoff. No-op if SSE isn't supported.
 */
export function useRealtime(handlers: Handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let backoff = 1000;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (cancelled) return;
      try {
        es = new EventSource(eventsUrl());

        es.addEventListener('open', () => {
          backoff = 1000;
          handlersRef.current.onConnect?.();
        });

        es.addEventListener('hello', () => {
          backoff = 1000;
        });

        es.addEventListener('trade', (ev: MessageEvent) => {
          try { handlersRef.current.onTrade?.(JSON.parse(ev.data)); } catch { /* ignore */ }
        });

        es.addEventListener('screen', (ev: MessageEvent) => {
          try { handlersRef.current.onScreen?.(JSON.parse(ev.data)); } catch { /* ignore */ }
        });

        es.addEventListener('control', (ev: MessageEvent) => {
          try { handlersRef.current.onControl?.(JSON.parse(ev.data)); } catch { /* ignore */ }
        });

        es.addEventListener('sell-request', (ev: MessageEvent) => {
          try { handlersRef.current.onSellRequest?.(JSON.parse(ev.data)); } catch { /* ignore */ }
        });

        es.addEventListener('error', () => {
          handlersRef.current.onDisconnect?.();
          es?.close();
          es = null;
          if (cancelled) return;
          const next = Math.min(backoff * 2, 30_000);
          reconnectTimer = window.setTimeout(connect, backoff);
          backoff = next;
        });
      } catch {
        // EventSource not supported — polling in ArborContext remains the fallback.
      }
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);
}
