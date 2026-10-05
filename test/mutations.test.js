import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../lib/app.js';
import { seal, makeSessionPayload } from '../lib/session.js';
import { mergeTopics } from '../lib/repos.js';

const SECRET = Buffer.alloc(32, 7).toString('base64');
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csec', SESSION_SECRET: SECRET };
const ORIGIN = 'https://app.example.com';
const TOKEN = 'gho_mut_secret';

async function authed(path, init = {}) {
  const sealed = await seal(makeSessionPayload({ token: TOKEN, login: 'a', id: 1 }), SECRET);
  init.headers = { ...(init.headers || {}), Cookie: `__Host-gm_session=${sealed}` };
  if (init.method && init.method !== 'GET') {
    init.headers['X-GM-CSRF'] = '1';
    init.headers.Origin = ORIGIN;
  }
  if (init.json !== undefined) { init.body = JSON.stringify(init.json); init.headers['Content-Type'] = 'application/json'; delete init.json; }
  return app.request(`${ORIGIN}${path}`, init, ENV);
}

function mockFetch(t, handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(url, init, calls.length); };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('mergeTopics add/remove/replace, normalization, limit', () => {
  assert.deepEqual(mergeTopics(['a'], 'add', ['B', 'a']), { ok: true, topics: ['a', 'b'] });
  assert.deepEqual(mergeTopics(['a', 'b'], 'remove', ['B']), { ok: true, topics: ['a'] });
  assert.deepEqual(mergeTopics(['a'], 'replace', ['c']), { ok: true, topics: ['c'] });
  assert.equal(mergeTopics([], 'add', ['bad topic']).ok, false);
  assert.equal(mergeTopics(Array.from({ length: 20 }, (_, i) => `t${i}`), 'add', ['x']).ok, false);
  assert.equal(mergeTopics([], 'nuke', ['x']).ok, false);
});

test('PATCH accepts only private/archived booleans', async (t) => {
  const calls = mockFetch(t, async (url, init) => json({ id: 1, name: 'r', full_name: 'a/r', owner: { login: 'a' }, ...JSON.parse(init.body) }));
  let res = await authed('/api/repos/a/r', { method: 'PATCH', json: { private: true } });
  assert.equal(res.status, 200);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(new URL(calls[0].url).pathname, '/repos/a/r');
  assert.equal((await res.json()).repo.private, true);
  res = await authed('/api/repos/a/r', { method: 'PATCH', json: { name: 'evil' } });
  assert.equal(res.status, 400);
  res = await authed('/api/repos/a/r', { method: 'PATCH', json: { private: 'yes' } });
  assert.equal(res.status, 400);
  res = await authed('/api/repos/a/r', { method: 'PATCH', json: {} });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 1);
});

test('mutating routes require CSRF header + Origin', async (t) => {
  mockFetch(t, async () => json({}));
  const sealed = await seal(makeSessionPayload({ token: TOKEN, login: 'a', id: 1 }), SECRET);
  const res = await app.request(`${ORIGIN}/api/repos/a/r`, { method: 'DELETE', headers: { Cookie: `__Host-gm_session=${sealed}` } }, ENV);
  assert.equal(res.status, 403);
  const res2 = await app.request(`${ORIGIN}/api/repos/a/r`, { method: 'DELETE', headers: { Cookie: `__Host-gm_session=${sealed}`, 'X-GM-CSRF': '1', Origin: 'https://evil.example' } }, ENV);
  assert.equal(res2.status, 403);
});

test('DELETE returns 204 and rejects invalid targets', async (t) => {
  const calls = mockFetch(t, async () => new Response(null, { status: 204 }));
  const res = await authed('/api/repos/a/r', { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(calls[0].init.method, 'DELETE');
  // Traversal-looking / invalid names are rejected (400 by validator or 404 by router) and never reach GitHub.
  for (const p of ['/api/repos/a/%2e%2e', '/api/repos/-bad/r', '/api/repos/a/r%2Fx', '/api/repos/a/']) {
    const st = (await authed(p, { method: 'DELETE' })).status;
    assert.ok(st === 400 || st === 404, `${p} → ${st}`);
  }
  assert.equal(calls.length, 1);
});

test('DELETE forbidden maps to readable error; only upstream `message` forwarded', async (t) => {
  mockFetch(t, async () => json({ message: 'Must have admin rights to Repository.', documentation_url: 'LEAKY', errors: ['LEAKY'] }, 403));
  const res = await authed('/api/repos/a/r', { method: 'DELETE' });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'forbidden');
  assert.match(body.message, /admin rights/);
  assert.ok(!JSON.stringify(body).includes('LEAKY'));
});

test('PUT topics merges with existing (add), replaces, validates', async (t) => {
  const calls = mockFetch(t, async (url, init) => {
    if (init.method === 'PUT') return json({ names: JSON.parse(init.body).names });
    return json({ names: ['old'] });
  });
  let res = await authed('/api/repos/a/r/topics', { method: 'PUT', json: { mode: 'add', names: ['New-One'] } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).topics, ['old', 'new-one']);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).pathname, '/repos/a/r/topics');
  res = await authed('/api/repos/a/r/topics', { method: 'PUT', json: { mode: 'replace', names: ['x'] } });
  assert.deepEqual((await res.json()).topics, ['x']);
  assert.equal(calls.length, 3); // replace skips the GET
  res = await authed('/api/repos/a/r/topics', { method: 'PUT', json: { mode: 'add', names: ['bad topic!'] } });
  assert.equal(res.status, 400);
  res = await authed('/api/repos/a/r/topics', { method: 'PUT', json: { mode: 'zap', names: [] } });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 3);
});
