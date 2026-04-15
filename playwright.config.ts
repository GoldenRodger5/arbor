import { defineConfig } from '@playwright/test';

// Minimal config — was using a missing lovable-agent-playwright-config.
// Runs e2e against TEST_BASE_URL (defaults to production Vercel alias).
export default defineConfig({
  testDir: './src/test',
  testMatch: /.*e2e\.test\.ts$/,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 3,
  reporter: 'list',
  use: {
    baseURL: process.env.TEST_BASE_URL ?? 'https://arbor-drab.vercel.app',
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },
});
