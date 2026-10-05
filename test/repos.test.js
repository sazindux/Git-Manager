import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../lib/app.js';
import { seal, makeSessionPayload } from '../lib/session.js';
import { trimRepo } from '../lib/repos.js';

const SECRET = Buffer.alloc(32, 5).toString('base64');
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csec', SESSION_SECRET: SECRET };
const ORIGIN = 'https://app.example.com';
const TOKEN = 'gho_supersecret';

async function authed(path, init = {}) {
  const sealed = await seal(makeSessionPayload({ token: TOKEN, login: 'a', id: 1 }), SECRET);
  init.headers = { ...(init.headers || {}), Cookie: `__Host-gm_session=${sealed}` };
  return app.request(`${ORIGIN}${path}`, init, ENV);
}

function mockFetch(t, handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = real; });
}

const fullRepo = {
  id: 1, node_id: 'x', name: 'r', full_name: 'a/r', owner: { login: 'a', type: 'User', avatar_url: 'u' },
  private: true, visibility: 'private', fork: false, archived: false, disabled: false, is_template: false,
  description: 'd', language: 'JS', stargazers_count: 2, forks_count: 1, open_issues_count: 0, size: 10,
  pushed_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', default_branch: 'main', topics: ['x'],
  html_url: 'https://github.com/a/r', permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  clone_url: 'secret-ish', ssh_url: 'nope',
};

test('trimRepo keeps only allow-listed fields', () => {
  const t = trimRepo(fullRepo);
  assert.equal(t.clone_url, undefined);
  assert.equal(t.node_id, undefined);
  assert.deepEqual(t.owner, { login: 'a', type: 'User' });
  assert.deepEqual(t.permissions, { admin: true, maintain: true, push: true });
  assert.equal(t.name, 'r');
  assert.deepEqual(trimRepo({ ...fullRepo, topics: undefined }).topics, []);
});

test('GET /api/repos requires auth', async () => {
  const res = await app.request(`${ORIGIN}/api/repos`, undefined, ENV);
  assert.equal(res.status, 401);
});

test('GET /api/repos returns trimmed items, hasMore, rate headers', async (t) => {
  mockFetch(t, async (url, init) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/user/repos');
    assert.equal(u.searchParams.get('per_page'), '100');
    assert.equal(u.searchParams.get('page'), '2');
    assert.equal(u.searchParams.get('affiliation'), 'owner,collaborator,organization_member');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
    return new Response(JSON.stringify([fullRepo]), {
      headers: {
        'content-type': 'application/json',
        link: '<https://api.github.com/user/repos?page=3>; rel="next"',
        'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '1700000000',
      },
    });
  });
  const res = await authed('/api/repos?page=2');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-ratelimit-remaining'), '4000');
  const body = await res.json();
  assert.equal(body.page, 2);
  assert.equal(body.hasMore, true);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].clone_url, undefined);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test('GET /api/repos hasMore=false on last page', async (t) => {
  mockFetch(t, async () => new Response('[]', { headers: { 'content-type': 'application/json' } }));
  const body = await (await authed('/api/repos')).json();
  assert.equal(body.hasMore, false);
  assert.deepEqual(body.items, []);
});

test('GET /api/repos rejects bad page', async () => {
  assert.equal((await authed('/api/repos?page=0')).status, 400);
  assert.equal((await authed('/api/repos?page=abc')).status, 400);
});

test('GitHub 401 → 401 and cookie cleared, no body leakage', async (t) => {
  mockFetch(t, async () => new Response(JSON.stringify({ message: 'Bad credentials', secret: 'LEAK' }), { status: 401 }));
  const res = await authed('/api/repos');
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes('LEAK'));
  assert.match(res.headers.getSetCookie()[0], /Max-Age=0/);
});

test('GitHub rate limit → 429 rate_limited with retryAfter', async (t) => {
  mockFetch(t, async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
    status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' },
  }));
  const res = await authed('/api/repos');
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, 'rate_limited');
  assert.equal(body.retryAfter, 30);
  assert.equal(res.headers.get('retry-after'), '30');
});

test('GitHub 500 → 502 generic, upstream body hidden', async (t) => {
  mockFetch(t, async () => new Response('<html>stack trace LEAK</html>', { status: 500 }));
  const res = await authed('/api/repos');
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!text.includes('LEAK'));
});

test('network failure → 502 network_error', async (t) => {
  mockFetch(t, async () => { throw new Error('ECONNRESET token=' + TOKEN); });
  const res = await authed('/api/repos');
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!text.includes(TOKEN));
  assert.ok(text.includes('network_error'));
});
