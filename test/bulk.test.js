import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { createElement() { return {}; }, createTextNode() { return {}; } };
const { runBulk, writeOptions, readOptions, buildLog } = await import('../public/assets/js/bulk.js');

// Virtual clock so tests do not actually wait.
function makeClock() {
  let t = 0;
  const pending = [];
  return {
    now: () => t,
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      pending.push({ at: t + ms, resolve, reject, signal });
    }),
    // Drain: let microtasks/macrotasks settle, fire the earliest pending sleep, repeat until idle.
    async tick() {
      let idle = 0;
      while (idle < 5) {
        await new Promise((r) => setImmediate(r));
        if (!pending.length) { idle++; continue; }
        idle = 0;
        pending.sort((a, b) => a.at - b.at);
        const p = pending.shift();
        t = Math.max(t, p.at);
        if (p.signal?.aborted) p.reject(new DOMException('Aborted', 'AbortError')); else p.resolve();
      }
    },
  };
}

test('write mode is strictly sequential with >=1000 ms gap between starts', async () => {
  const clock = makeClock();
  const starts = [];
  let active = 0; let maxActive = 0;
  const fn = async (item) => {
    active++; maxActive = Math.max(maxActive, active);
    starts.push(clock.now());
    await new Promise((r) => setImmediate(r));
    active--;
    return item * 2;
  };
  const p = runBulk([1, 2, 3, 4], fn, writeOptions({ now: clock.now, sleep: clock.sleep }));
  // Let the chain progress: each item triggers one sleep.
  await clock.tick();
  const { results, cancelled } = await p;
  assert.equal(cancelled, false);
  assert.equal(maxActive, 1);
  assert.deepEqual(results.map((r) => r.status), ['ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(results.map((r) => r.value), [2, 4, 6, 8]);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1000, `gap ${starts[i] - starts[i - 1]}`);
});

test('read mode runs up to 4 concurrently', async () => {
  let active = 0; let maxActive = 0;
  const fn = async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); active--; };
  const { results } = await runBulk(Array.from({ length: 10 }, (_, i) => i), fn, readOptions());
  assert.equal(maxActive, 4);
  assert.equal(results.filter((r) => r.status === 'ok').length, 10);
});

test('cancellation stops after the current item', async () => {
  const clock = makeClock();
  const ac = new AbortController();
  const seen = [];
  const fn = async (item) => { seen.push(item); if (item === 2) ac.abort(); return item; };
  const p = runBulk([1, 2, 3, 4], fn, writeOptions({ now: clock.now, sleep: clock.sleep, signal: ac.signal }));
  await clock.tick();
  const { results, cancelled } = await p;
  assert.equal(cancelled, true);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(results.map((r) => r.status), ['ok', 'ok', 'cancelled', 'cancelled']);
});

test('rate_limited errors wait retryAfter seconds and retry; other errors fail with message', async () => {
  const clock = makeClock();
  let calls = 0;
  const fn = async (item) => {
    calls++;
    if (item === 'a' && calls === 1) { const e = new Error('rl'); e.code = 'rate_limited'; e.retryAfter = 7; e.isRateLimit = true; throw e; }
    if (item === 'b') { const e = new Error('No admin rights'); e.code = 'forbidden'; throw e; }
    return 'ok';
  };
  const progress = [];
  const p = runBulk(['a', 'b'], fn, writeOptions({ now: clock.now, sleep: clock.sleep, onProgress: (s) => { if (s.rateWait) progress.push(s.rateWait); } }));
  await clock.tick();
  const { results } = await p;
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].attempts, 2);
  assert.deepEqual(progress, [7]);
  assert.equal(results[1].status, 'failed');
  assert.match(results[1].error, /No admin rights/);
  assert.equal(results[1].errorCode, 'forbidden');
  assert.ok(clock.now() >= 7000);
});

test('buildLog contains only identifiers, statuses and errors', () => {
  const log = buildLog({ action: 'delete', startedAt: 0, finishedAt: 1000, cancelled: false, results: [
    { item: { id: 1, full_name: 'me/a' }, key: 1, status: 'ok', attempts: 1 },
    { item: { id: 2, full_name: 'me/b' }, key: 2, status: 'failed', attempts: 1, error: 'Forbidden', errorCode: 'forbidden' },
  ] });
  assert.equal(log.summary.ok, 1); assert.equal(log.summary.failed, 1);
  assert.deepEqual(Object.keys(log.items[0]).sort(), ['attempts', 'code', 'error', 'key', 'label', 'status']);
  assert.equal(log.items[1].label, 'me/b');
});
