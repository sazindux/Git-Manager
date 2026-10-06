// Dev-only perf probe (see scripts/qa.mjs for setup). Measures main-thread time of common interactions
// on the mock (GM_MOCK_REPOS=1500). Each figure = sync handler + the next rAF render, via performance.now().
import { chromium } from 'playwright';

const BASE = process.env.QA_BASE || 'http://localhost:3077';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const t0 = Date.now();
await page.goto(`${BASE}/api/auth/login`);
await page.waitForSelector('#repos-panel li[data-id]');
const firstRows = Date.now() - t0;
await page.waitForFunction(() => document.querySelector('[data-loading-banner]')?.hidden, null, { timeout: 60000 });
const allLoaded = Date.now() - t0;
await page.evaluate(() => {
  window.__lt = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: false });
  window.__measure = (fn) => new Promise((res) => {
    const s = performance.now();
    const n0 = window.__lt.length;
    fn();
    requestAnimationFrame(() => { const mid = performance.now(); setTimeout(() => setTimeout(() => {
      const lt = window.__lt.slice(n0).map(Math.round);
      res(lt.length ? `${Math.round(mid - s)} (long tasks ${lt.join('/')})` : Math.round(mid - s));
    }, 30), 0); });
  });
});
const m = {};
m.searchType = await page.evaluate(() => { const i = document.querySelector('input[type=search]'); return window.__measure(() => { i.value = 'react'; i.dispatchEvent(new Event('input')); }); });
await page.waitForTimeout(300);
m.searchApplied = await page.evaluate(() => window.__measure(() => {}));
m.toggleOne = await page.evaluate(() => window.__measure(() => document.querySelector('#repos-panel li[data-id] input').click()));
m.selectPage = await page.evaluate(() => window.__measure(() => document.querySelector('#repos-panel .Box-header input[type=checkbox]').click()));
await page.evaluate(() => { const i = document.querySelector('input[type=search]'); i.value = ''; i.dispatchEvent(new Event('input')); });
await page.waitForTimeout(300);
m.selectAllMatching = await page.evaluate(() => window.__measure(() => [...document.querySelectorAll('#repos-panel button.btn-link')].find((b) => b.textContent.startsWith('Select all'))?.click()));
m.clearSelection = await page.evaluate(() => window.__measure(() => [...document.querySelectorAll('#repos-panel button.btn-link')].find((b) => b.textContent === 'Clear selection')?.click()));
m.nextPage = await page.evaluate(() => window.__measure(() => document.querySelector('.Pagination button[aria-label="Next page"]').click()));
m.tabAnalytics = await page.evaluate(() => window.__measure(() => document.querySelector('[data-tab=analytics]').click()));
m.tabCleanup = await page.evaluate(() => window.__measure(() => document.querySelector('[data-tab=cleanup]').click()));
m.tabRepos = await page.evaluate(() => window.__measure(() => document.querySelector('[data-tab=repos]').click()));
const longTasks = await page.evaluate(() => window.__lt.map(Math.round));
const rows = await page.evaluate(() => document.querySelectorAll('#repos-panel li[data-id]').length);
console.log(JSON.stringify({ firstRowsMs: firstRows, allLoadedMs: allLoaded, rowsOnPage: rows, ms: m, longTasksDuringInteractions: longTasks, errors: errs }, null, 1));
await browser.close();
