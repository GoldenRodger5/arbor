// Vercel serverless function — proxies API requests to VPS over HTTP
// Browser → HTTPS Vercel → HTTP VPS (no mixed content)
//
// Supports:
//   GET  /api/proxy?path=/api/stats           → JSON passthrough
//   POST /api/proxy?path=/api/control/pause   → JSON body forwarded
//   GET  /api/proxy?path=/api/events&stream=1 → SSE passthrough (max ~60s on Vercel)

export const config = {
  // Allow longer execution for SSE streams (Pro plan: 300s; Hobby: 60s)
  maxDuration: 60,
};

export default async function handler(req, res) {
  const VPS_API = process.env.VPS_API_URL || 'http://87.99.155.128:3456';
  const TOKEN = process.env.API_TOKEN || 'arbor-2026';

  const path = req.query.path || '/api/stats';
  const isStream = req.query.stream === '1' || path.startsWith('/api/events');

  // Forward non-control query params (like limit) to the VPS
  const extraParams = Object.entries(req.query)
    .filter(([k]) => !['path', 'stream'].includes(k))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const allParams = `token=${TOKEN}${extraParams ? '&' + extraParams : ''}`;
  const separator = path.includes('?') ? '&' : '?';
  const upstream = `${VPS_API}${path}${separator}${allParams}`;

  // CORS (same origin in practice, but safe defaults)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    // ─── SSE streaming passthrough ──────────────────────────────────────────
    if (isStream) {
      const response = await fetch(upstream, { signal: AbortSignal.timeout(55_000) });
      if (!response.ok || !response.body) {
        res.status(response.status || 502).json({ error: `Upstream returned ${response.status}` });
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch { /* client hung up */ }
      res.end();
      return;
    }

    // ─── POST passthrough ────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body ? JSON.stringify(req.body) : undefined;
      const response = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      res.status(response.status);
      res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/json');
      res.send(text);
      return;
    }

    // ─── Standard GET passthrough ────────────────────────────────────────────
    const response = await fetch(upstream, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      res.status(response.status).json({ error: `VPS returned ${response.status}` });
      return;
    }
    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=5');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
