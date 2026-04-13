// Vercel serverless function — proxies API requests to VPS over HTTP
// Browser → HTTPS Vercel → HTTP VPS (no mixed content)

export default async function handler(req, res) {
  const VPS_API = process.env.VPS_API_URL || 'http://87.99.155.128:3456';
  const TOKEN = process.env.API_TOKEN || 'arbor-2026';

  // Get the path from query param: /api/proxy?path=/api/stats
  // Forward any extra query params (like limit) to the VPS
  const path = req.query.path || '/api/stats';
  const extraParams = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  try {
    const allParams = `token=${TOKEN}${extraParams ? '&' + extraParams : ''}`;
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(`${VPS_API}${path}${separator}${allParams}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      res.status(response.status).json({ error: `VPS returned ${response.status}` });
      return;
    }

    const data = await response.json();

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=5');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
