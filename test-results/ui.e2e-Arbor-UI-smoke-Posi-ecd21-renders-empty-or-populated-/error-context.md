# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ui.e2e.test.ts >> Arbor UI smoke >> Positions page renders (empty or populated)
- Location: src/test/ui.e2e.test.ts:56:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('h1').filter({ hasText: /Positions/ })
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for locator('h1').filter({ hasText: /Positions/ })

```

# Page snapshot

```yaml
- main [ref=e3]:
  - paragraph [ref=e4]:
    - generic [ref=e5]:
      - strong [ref=e6]: "404"
      - text: ": NOT_FOUND"
    - generic [ref=e7]:
      - text: "Code:"
      - code [ref=e8]: "`NOT_FOUND`"
    - generic [ref=e9]:
      - text: "ID:"
      - code [ref=e10]: "`iad1::rw2hq-1776292671823-a508fa2cfa9a`"
  - link "Read our documentation to learn more about this error." [ref=e11] [cursor=pointer]:
    - /url: https://vercel.com/docs/errors/NOT_FOUND
    - generic [ref=e12]: Read our documentation to learn more about this error.
```

# Test source

```ts
  1   | import { test, expect, type Page } from '@playwright/test';
  2   | 
  3   | // Test against the production Vercel deployment so we also exercise the proxy + SSE path.
  4   | const BASE = process.env.TEST_BASE_URL ?? 'https://arbor-drab.vercel.app';
  5   | 
  6   | test.describe('Arbor UI smoke', () => {
  7   |   test('Today page loads with bankroll + recent sections', async ({ page }) => {
  8   |     await page.goto(BASE);
  9   |     await expect(page.getByText('BANKROLL')).toBeVisible();
  10  |     // Bankroll value should appear as $N (wait for async fetch to settle)
  11  |     await expect(page.locator('text=/\\$\\d/').first()).toBeVisible({ timeout: 10_000 });
  12  |     // Nav hub should show OPEN POSITIONS and RECENT sections
  13  |     await expect(page.getByText(/OPEN POSITIONS/i)).toBeVisible();
  14  |     await expect(page.getByText('RECENT')).toBeVisible();
  15  |     // Pause button exists
  16  |     await expect(page.getByRole('button', { name: /Pause Bot|Resume Bot/i })).toBeVisible();
  17  |   });
  18  | 
  19  |   test('Overview page shows charts + quick nav', async ({ page }) => {
  20  |     await page.goto(`${BASE}/overview`);
  21  |     await expect(page.getByText('Overview')).toBeVisible();
  22  |     await expect(page.getByText('Analytics')).toBeVisible(); // MORE_NAV tile
  23  |     await expect(page.getByText('Recap')).toBeVisible();
  24  |   });
  25  | 
  26  |   test('Analytics page shows timeframe pills + drill-down opens sheet', async ({ page }) => {
  27  |     await page.goto(`${BASE}/analytics`);
  28  |     await expect(page.getByText('Analytics')).toBeVisible();
  29  |     await expect(page.getByRole('button', { name: /7 days/i })).toBeVisible();
  30  |     // Click 30d pill
  31  |     await page.getByRole('button', { name: /30 days/i }).click();
  32  |     // Wait for summary cards
  33  |     await expect(page.locator('text=/TRADES|WIN RATE|P&L/').first()).toBeVisible();
  34  |   });
  35  | 
  36  |   test('Recap page loads and shows period toggle', async ({ page }) => {
  37  |     await page.goto(`${BASE}/recap`);
  38  |     await expect(page.getByRole('heading', { name: 'Recap' })).toBeVisible();
  39  |     await expect(page.getByRole('button', { name: 'daily' })).toBeVisible();
  40  |     await expect(page.getByRole('button', { name: 'weekly' })).toBeVisible();
  41  |     // Click weekly
  42  |     await page.getByRole('button', { name: 'weekly' }).click();
  43  |     // Stats hero should load
  44  |     await expect(page.locator('text=/P&L|WIN%|PLACED/').first()).toBeVisible({ timeout: 20_000 });
  45  |   });
  46  | 
  47  |   test('Settings page shows control UI', async ({ page }) => {
  48  |     await page.goto(`${BASE}/settings`);
  49  |     await expect(page.getByText('Settings & Control')).toBeVisible();
  50  |     await expect(page.getByText(/Running|Paused/i)).toBeVisible();
  51  |     // Strategy toggles present
  52  |     await expect(page.getByText(/Live edge/i)).toBeVisible();
  53  |     await expect(page.getByText(/Pre-game predictions/i)).toBeVisible();
  54  |   });
  55  | 
  56  |   test('Positions page renders (empty or populated)', async ({ page }) => {
  57  |     await page.goto(`${BASE}/positions`);
> 58  |     await expect(page.locator('h1', { hasText: /Positions/ })).toBeVisible();
      |                                                                ^ Error: expect(locator).toBeVisible() failed
  59  |     // Must show either "No open positions" or at least one position
  60  |     const empty = page.getByText('No open positions');
  61  |     const filter = page.getByRole('button', { name: /^all$/i });
  62  |     await expect(empty.or(filter)).toBeVisible();
  63  |   });
  64  | 
  65  |   test('Trade history loads + swipe button appears when trades exist', async ({ page }) => {
  66  |     await page.goto(`${BASE}/history`);
  67  |     await expect(page.getByRole('heading', { name: 'Trade History' })).toBeVisible();
  68  |     // Summary bar shows "N trades" or filters
  69  |     await expect(page.locator('text=/\\d+ trades|All Dates/').first()).toBeVisible();
  70  |   });
  71  | 
  72  |   test('Games page renders', async ({ page }) => {
  73  |     await page.goto(`${BASE}/games`);
  74  |     await expect(page.getByRole('heading', { name: 'Games Intelligence' })).toBeVisible();
  75  |   });
  76  | 
  77  |   test('Live feed renders + summary card visible', async ({ page }) => {
  78  |     await page.goto(`${BASE}/live`);
  79  |     await expect(page.getByRole('heading', { name: 'Live Feed' })).toBeVisible();
  80  |     await expect(page.getByText('AI SUMMARY')).toBeVisible();
  81  |   });
  82  | 
  83  |   test('Trade review page renders', async ({ page }) => {
  84  |     await page.goto(`${BASE}/review`);
  85  |     await expect(page.getByRole('heading', { name: 'Trade Review' })).toBeVisible();
  86  |   });
  87  | 
  88  |   test('404 page renders for unknown route', async ({ page }) => {
  89  |     await page.goto(`${BASE}/nonexistent-route`);
  90  |     // NotFound renders something — could be "404" text or redirect
  91  |     await expect(page.locator('body')).toBeVisible();
  92  |   });
  93  | 
  94  |   test('Service worker registers', async ({ page }) => {
  95  |     await page.goto(BASE);
  96  |     // Wait for SW registration
  97  |     const swRegistered = await page.evaluate(async () => {
  98  |       if (!('serviceWorker' in navigator)) return false;
  99  |       const regs = await navigator.serviceWorker.getRegistrations();
  100 |       return regs.length > 0;
  101 |     });
  102 |     expect(swRegistered).toBe(true);
  103 |   });
  104 | });
  105 | 
  106 | test.describe('Mobile viewport', () => {
  107 |   test.use({ viewport: { width: 390, height: 844 } });
  108 | 
  109 |   test('Bottom tabs are visible on mobile', async ({ page }) => {
  110 |     await page.goto(BASE);
  111 |     // BottomTabs renders Today, Positions, Games, History, More buttons
  112 |     await expect(page.getByRole('button', { name: /Today/i })).toBeVisible();
  113 |     await expect(page.getByRole('button', { name: /Positions/i })).toBeVisible();
  114 |     await expect(page.getByRole('button', { name: /Games/i })).toBeVisible();
  115 |   });
  116 | 
  117 |   test('Navigation between mobile tabs works', async ({ page }) => {
  118 |     await page.goto(BASE);
  119 |     await page.getByRole('button', { name: /Positions/i }).click();
  120 |     await expect(page).toHaveURL(/\/positions$/);
  121 |     await page.getByRole('button', { name: /Today/i }).click();
  122 |     await expect(page).toHaveURL(new RegExp(`${BASE}/?$`));
  123 |   });
  124 | });
  125 | 
  126 | test.describe('API integration', () => {
  127 |   test('Stats endpoint returns data via proxy', async ({ request }) => {
  128 |     const res = await request.get(`${BASE}/api/proxy?path=${encodeURIComponent('/api/stats')}`);
  129 |     expect(res.ok()).toBe(true);
  130 |     const data = await res.json();
  131 |     expect(data).toHaveProperty('totalTrades');
  132 |     expect(data).toHaveProperty('winRate');
  133 |   });
  134 | 
  135 |   test('Control status returns JSON', async ({ request }) => {
  136 |     const res = await request.get(`${BASE}/api/proxy?path=${encodeURIComponent('/api/control/status')}`);
  137 |     expect(res.ok()).toBe(true);
  138 |     const data = await res.json();
  139 |     expect(data).toHaveProperty('paused');
  140 |     expect(data).toHaveProperty('disabledStrategies');
  141 |   });
  142 | 
  143 |   test('Pause then resume via proxy POST', async ({ request }) => {
  144 |     // Pause
  145 |     const pause = await request.post(`${BASE}/api/proxy?path=${encodeURIComponent('/api/control/pause')}`, {
  146 |       data: { reason: 'e2e-test' },
  147 |     });
  148 |     expect(pause.ok()).toBe(true);
  149 |     const pauseData = await pause.json();
  150 |     expect(pauseData.paused).toBe(true);
  151 | 
  152 |     // Resume
  153 |     const resume = await request.post(`${BASE}/api/proxy?path=${encodeURIComponent('/api/control/resume')}`);
  154 |     expect(resume.ok()).toBe(true);
  155 |     const resumeData = await resume.json();
  156 |     expect(resumeData.paused).toBe(false);
  157 |   });
  158 | 
```