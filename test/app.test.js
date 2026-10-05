import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../lib/app.js';

test('GET /api/health returns ok and no-store', async () => {
  const res = await app.request('http://localhost/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: true });
});

test('unknown API route returns 404 JSON', async () => {
  const res = await app.request('http://localhost/api/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});
