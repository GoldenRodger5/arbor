// Frontend config — only public values here. All secrets (API keys, private
// keys, tokens) live in Supabase edge function secrets, never in the browser.
const config = {
  supabase: {
    url: import.meta.env.VITE_SUPABASE_URL ?? '',
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
  },
  scanner: {
    defaultIntervalSeconds: 60,
    defaultMinNetSpread: 0.02,
  },
} as const;

export default config;
