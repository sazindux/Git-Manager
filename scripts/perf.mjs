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

// Optional: PERF_BULK=N → mock bulk delete of N repos (≥1 s gap each), reports long tasks + list DOM mutations.
if (process.env.PERF_BULK) {
  const N = Number(process.env.PERF_BULK);
  const p2 = await (await chromium.launch()).newPage({ viewport: { width: 1280, height: 900 } });
  const e2 = [];
  p2.on('pageerror', (e) => e2.push(e.message));
  await p2.goto(`${BASE}/api/auth/login`);
  await p2.waitForFunction(() => document.querySelector('[data-loading-banner]')?.hidden, null, { timeout: 60000 });
  let picked = 0;
  while (picked < N) { // select whole pages, then single rows for the remainder
    const left = N - picked;
    if (left >= 30) { await p2.click('#repos-panel .Box-header input[type=checkbox]'); picked += 30; }
    else { for (let i = 0; i < left; i++) await p2.locator('#repos-panel li[data-id] input').nth(i).click(); picked += left; }
    if (picked < N) await p2.click('.Pagination button[aria-label="Next page"]');
  }
  await p2.click('button[aria-label="Bulk actions for selected repositories"]');
  await p2.click('text=Delete repositories…');
  await p2.fill('.Overlay input[type=text]', `delete ${N} repositories`);
  await p2.check('.Overlay input[type=checkbox]');
  await p2.waitForTimeout(3300);
  await p2.evaluate(() => {
    window.__lt = []; window.__mut = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask' });
    new MutationObserver((ms) => { window.__mut += ms.length; window.__renders = (window.__renders || 0) + 1; }).observe(document.querySelector('ul[aria-label="Repositories"]'), { childList: true });
  });
  const s = Date.now();
  await p2.click('.Overlay-footer .btn-danger-solid');
  await p2.waitForFunction(() => /(Finished|Cancelled) –/.test(document.querySelector('#bulk-panel')?.textContent || ''), null, { timeout: (N + 30) * 1500 });
  const r = await p2.evaluate(() => ({ longTasks: window.__lt.map(Math.round), listChildListMutations: window.__mut, mutationCallbacks: window.__renders }));
  console.log(JSON.stringify({ bulkDelete: N, seconds: Math.round((Date.now() - s) / 1000), ...r, errors: e2 }));
}
process.exit(0);
