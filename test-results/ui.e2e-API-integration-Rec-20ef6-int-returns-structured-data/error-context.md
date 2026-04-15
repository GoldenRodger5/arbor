# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ui.e2e.test.ts >> API integration >> Recap endpoint returns structured data
- Location: src/test/ui.e2e.test.ts:167:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
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
  159 |   test('Summary endpoint returns Sonnet-generated content', async ({ request }) => {
  160 |     const res = await request.get(`${BASE}/api/proxy?path=${encodeURIComponent('/api/summary')}&hours=6`);
  161 |     expect(res.ok()).toBe(true);
  162 |     const data = await res.json();
  163 |     expect(data).toHaveProperty('summary');
  164 |     expect(typeof data.summary).toBe('string');
  165 |   });
  166 | 
  167 |   test('Recap endpoint returns structured data', async ({ request }) => {
  168 |     const res = await request.get(`${BASE}/api/proxy?path=${encodeURIComponent('/api/recap')}&period=weekly`);
> 169 |     expect(res.ok()).toBe(true);
      |                      ^ Error: expect(received).toBe(expected) // Object.is equality
  170 |     const data = await res.json();
  171 |     expect(data).toHaveProperty('period', 'weekly');
  172 |     expect(data).toHaveProperty('placed');
  173 |     expect(data).toHaveProperty('sportBreakdown');
  174 |   });
  175 | });
  176 | 
  177 | async function waitForIdle(page: Page) {
  178 |   await page.waitForLoadState('networkidle');
  179 | }
  180 | void waitForIdle;
  181 | 
```