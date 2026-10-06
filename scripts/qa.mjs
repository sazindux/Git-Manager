// Dev-only UI QA (not a dependency): `npm i --no-save playwright && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`
// then with `GM_MOCK_REPOS=1500 PORT=3077 npm run dev:mock` running: `PLAYWRIGHT_BROWSERS_PATH=0 node scripts/qa.mjs [outDir]`
// Takes a screenshot per tab at 1280px and 390px, prints console/CSP errors and simple timings.
import { chromium } from 'playwright';

const BASE = process.env.QA_BASE || 'http://localhost:3077';
const out = process.argv[2] || '/tmp/qa';
const browser = await chromium.launch();
let errors = 0;
for (const width of [1280, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { errors++; console.log(`[${width}] console.${m.type()}: ${m.text()}`); } });
  page.on('pageerror', (e) => { errors++; console.log(`[${width}] pageerror: ${e.message}`); });
  await page.goto(`${BASE}/`);
  await page.screenshot({ path: `${out}-landing-${width}.png` });
  await page.goto(`${BASE}/api/auth/login`);
  await page.waitForSelector('#view-dashboard:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('[data-loading-banner]:not([hidden])'), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  for (const tab of ['repos', 'cleanup', 'analytics']) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}-${tab}-${width}.png`, fullPage: false });
  }
  if (process.env.QA_MENU) {
    await page.click('[data-tab="repos"]');
    await page.click('[aria-label="Open user menu"]');
    await page.screenshot({ path: `${out}-menu-${width}.png` });
    await page.keyboard.press('Escape');
  }
  await page.close();
}
await browser.close();
console.log(`done, ${errors} console errors/warnings`);
