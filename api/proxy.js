// Vercel serverless function — proxies API requests to VPS over HTTP
// Browser → HTTPS Vercel → HTTP VPS (no mixed content)

export default async function handler(req, res) {
  const VPS_API = process.env.VPS_API_URL || 'http://87.99.155.128:3456';
  const TOKEN = process.env.API_TOKEN || 'arbor-2026';

  // Get the path from query param: /api/proxy?path=/api/stats
  const path = req.query.path || '/api/stats';

  try {
    const response = await fetch(`${VPS_API}${path}?token=${TOKEN}`, {
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
