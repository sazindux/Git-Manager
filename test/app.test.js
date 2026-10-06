import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../lib/app.js';
import entry, { config } from '../api/index.js';

test('GET /api/health returns runtime, function marker and no-store', async () => {
  const res = await app.request('http://localhost/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-gm-function'), '1');
  assert.deepEqual(await res.json(), { ok: true, runtime: 'node' });
});

test('unknown API route returns 404 JSON', async () => {
  const res = await app.request('http://localhost/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-gm-function'), '1');
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('nested login reaches OAuth and includes the function marker', async () => {
  const res = await app.request('/api/auth/login', {}, { SESSION_SECRET: '' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?error=server_config');
  assert.equal(res.headers.get('x-gm-function'), '1');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('Vercel Node fetch entry preserves API paths and methods', async () => {
  assert.equal(config.runtime, 'nodejs');
  const health = await entry.fetch(new Request('https://gitmanage.vercel.app/api/health'));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, runtime: 'node' });

  const nested = await entry.fetch(new Request('https://gitmanage.vercel.app/api/nope/deep?check=1'));
  assert.equal(nested.status, 404);
  assert.equal(nested.headers.get('x-gm-function'), '1');
  assert.deepEqual(await nested.json(), { error: 'not_found' });

  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const res = await entry.fetch(new Request('https://gitmanage.vercel.app/api/repos/owner/repo', { method }));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('x-gm-function'), '1');
    assert.deepEqual(await res.json(), { error: 'csrf' });
  }
});

test('CSRF rejection includes the function marker', async () => {
  const res = await app.request('/api/auth/logout', { method: 'POST' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('x-gm-function'), '1');
  assert.deepEqual(await res.json(), { error: 'csrf' });
});

test('health detects the Edge runtime when present', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EdgeRuntime');
  Object.defineProperty(globalThis, 'EdgeRuntime', { value: 'edge-runtime', configurable: true });
  try {
    const res = await app.request('/api/health');
    assert.deepEqual(await res.json(), { ok: true, runtime: 'edge' });
  } finally {
    if (original) Object.defineProperty(globalThis, 'EdgeRuntime', original);
    else delete globalThis.EdgeRuntime;
  }
});
