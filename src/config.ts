const config = {
  kalshi: {
    baseUrl: 'https://trading-api.kalshi.com/trade-api/v2',
    apiKeyId: import.meta.env.VITE_KALSHI_API_KEY_ID ?? '',
    privateKey: import.meta.env.VITE_KALSHI_PRIVATE_KEY ?? '',
    requestsPerSecond: 5,
  },
  polymarket: {
    gammaUrl: 'https://gamma-api.polymarket.com',
    clobUrl: 'https://clob.polymarket.com',
    requestsPerSecond: 10,
  },
  anthropic: {
    apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY ?? '',
  },
  supabase: {
    url: import.meta.env.VITE_SUPABASE_URL ?? '',
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
  },
  scanner: {
    defaultIntervalSeconds: 60,
    defaultMinNetSpread: 0.02,
    fuzzyMatchThreshold: 0.55,
    stalenessThresholdMs: 60000,
  },
} as const;

export default config;
