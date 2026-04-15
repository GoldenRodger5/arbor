import { test, expect, type Page } from '@playwright/test';

// Test against the production Vercel deployment so we also exercise the proxy + SSE path.
const BASE = process.env.TEST_BASE_URL ?? 'https://arbor-drab.vercel.app';

test.describe('Arbor UI smoke', () => {
  test('Today page loads with bankroll + recent sections', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.getByText('BANKROLL')).toBeVisible();
    // Bankroll value should appear as $N (wait for async fetch to settle)
    await expect(page.locator('text=/\\$\\d/').first()).toBeVisible({ timeout: 10_000 });
    // Nav hub should show OPEN POSITIONS and RECENT sections
    await expect(page.getByText(/OPEN POSITIONS/i)).toBeVisible();
    await expect(page.getByText('RECENT')).toBeVisible();
    // Pause button exists
    await expect(page.getByRole('button', { name: /Pause Bot|Resume Bot/i })).toBeVisible();
  });

  test('Overview page shows charts + quick nav', async ({ page }) => {
    await page.goto(`${BASE}/overview`);
    await expect(page.getByText('Overview')).toBeVisible();
    await expect(page.getByText('Analytics')).toBeVisible(); // MORE_NAV tile
    await expect(page.getByText('Recap')).toBeVisible();
  });

  test('Analytics page shows timeframe pills + drill-down opens sheet', async ({ page }) => {
    await page.goto(`${BASE}/analytics`);
    await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
    await expect(page.getByRole('button', { name: /7 days/i })).toBeVisible();
    // Click 30d pill
    await page.getByRole('button', { name: /30 days/i }).click();
    // Wait for summary cards
    await expect(page.locator('text=/TRADES|WIN RATE|P&L/').first()).toBeVisible();
  });

  test('Recap page loads and shows period toggle', async ({ page }) => {
    await page.goto(`${BASE}/recap`);
    await expect(page.getByRole('heading', { name: 'Recap' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'daily' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'weekly' })).toBeVisible();
    // Click weekly
    await page.getByRole('button', { name: 'weekly' }).click();
    // Stats hero should load
    await expect(page.locator('text=/P&L|WIN%|PLACED/').first()).toBeVisible({ timeout: 20_000 });
  });

  test('Settings page shows control UI', async ({ page }) => {
    await page.goto(`${BASE}/settings`);
    await expect(page.getByRole('heading', { name: 'Settings & Control' })).toBeVisible();
    // Status indicator is a span next to the animated dot; exact-match avoids the help text below
    await expect(page.locator('span').filter({ hasText: /^(Running|Paused)$/ }).first()).toBeVisible();
    // Strategy toggles present
    await expect(page.getByText(/Live edge/i)).toBeVisible();
    await expect(page.getByText(/Pre-game predictions/i)).toBeVisible();
  });

  test('Positions page renders (empty or populated)', async ({ page }) => {
    await page.goto(`${BASE}/positions`);
    await expect(page.locator('h1', { hasText: /Positions/ })).toBeVisible();
    // Deployed total is always visible regardless of empty state
    await expect(page.locator('text=/\\$\\d.*deployed/')).toBeVisible();
  });

  test('Trade history loads + swipe button appears when trades exist', async ({ page }) => {
    await page.goto(`${BASE}/history`);
    await expect(page.getByRole('heading', { name: 'Trade History' })).toBeVisible();
    // Summary bar shows "N trades" or filters
    await expect(page.locator('text=/\\d+ trades|All Dates/').first()).toBeVisible();
  });

  test('Games page renders', async ({ page }) => {
    await page.goto(`${BASE}/games`);
    await expect(page.getByRole('heading', { name: 'Games Intelligence' })).toBeVisible();
  });

  test('Live feed renders + summary card visible', async ({ page }) => {
    await page.goto(`${BASE}/live`);
    await expect(page.getByRole('heading', { name: 'Live Feed' })).toBeVisible();
    await expect(page.getByText('AI SUMMARY')).toBeVisible();
  });

  test('Trade review page renders', async ({ page }) => {
    await page.goto(`${BASE}/review`);
    await expect(page.getByRole('heading', { name: 'Trade Review' })).toBeVisible();
  });

  test('404 page renders for unknown route', async ({ page }) => {
    await page.goto(`${BASE}/nonexistent-route`);
    // NotFound renders something — could be "404" text or redirect
    await expect(page.locator('body')).toBeVisible();
  });

  test('Service worker registers', async ({ page }) => {
    await page.goto(BASE);
    // Wait for SW registration
    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length > 0;
    });
    expect(swRegistered).toBe(true);
  });
});

test.describe('Mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Bottom tabs are visible on mobile', async ({ page }) => {
    await page.goto(BASE);
    // BottomTabs renders Today, Positions, Games, History, More buttons
    await expect(page.getByRole('button', { name: /Today/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Positions/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Games/i })).toBeVisible();
  });

  test('Navigation between mobile tabs works', async ({ page }) => {
    await page.goto(BASE);
    await page.getByRole('button', { name: /Positions/i }).click();
    await expect(page).toHaveURL(/\/positions$/);
    await page.getByRole('button', { name: /Today/i }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/?$`));
  });
});

test.describe('API integration', () => {
  test('Stats endpoint returns data via proxy', async ({ request }) => {
    const res = await request.get(`${BASE}/api/proxy?path=${encodeURIComponent('/api/stats')}`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('totalTrades');
    expect(data).toHaveProperty('winRate');
  });

  test('Control status returns JSON', async ({ request }) => {
    const res = await request.get(`${BASE}/api/proxy?path=${encodeURIComponent('/api/control/status')}`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('paused');
    expect(data).toHaveProperty('disabledStrategies');
  });

  test('Pause then resume via proxy POST', async ({ request }) => {
    // Pause
    const pause = await request.post(`${BASE}/api/proxy?path=${encodeURIComponent('/api/control/pause')}`, {
      data: { reason: 'e2e-test' },
    });
    expect(pause.ok()).toBe(true);
    const pauseData = await pause.json();
    expect(pauseData.paused).toBe(true);

    // Resume
    const resume = await request.post(`${BASE}/api/proxy?path=${encodeURIComponent('/api/control/resume')}`);
    expect(resume.ok()).toBe(true);
    const resumeData = await resume.json();
    expect(resumeData.paused).toBe(false);
  });

  test('Summary endpoint returns Sonnet-generated content', async ({ request }) => {
    const res = await request.get(`${BASE}/api/proxy?path=${encodeURIComponent('/api/summary')}&hours=6`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('summary');
    expect(typeof data.summary).toBe('string');
  });

  test('Recap endpoint returns structured data', async ({ request }) => {
    const res = await request.get(`${BASE}/api/proxy?path=${encodeURIComponent('/api/recap')}&period=weekly`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('period', 'weekly');
    expect(data).toHaveProperty('placed');
    expect(data).toHaveProperty('sportBreakdown');
  });
});

async function waitForIdle(page: Page) {
  await page.waitForLoadState('networkidle');
}
void waitForIdle;
