import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../lib/app.js';
import { seal, makeSessionPayload } from '../lib/session.js';
import { classifyBranch, classifyBranches } from '../lib/branches.js';

const SECRET = Buffer.alloc(32, 9).toString('base64');
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csec', SESSION_SECRET: SECRET };
const ORIGIN = 'https://app.example.com';
const TOKEN = 'gho_cleanup_secret';
const NOW = Date.parse('2026-10-05T00:00:00Z');

async function authed(path, init = {}) {
  const sealed = await seal(makeSessionPayload({ token: TOKEN, login: 'a', id: 1 }), SECRET);
  init.headers = { ...(init.headers || {}), Cookie: `__Host-gm_session=${sealed}` };
  if (init.method && init.method !== 'GET') { init.headers['X-GM-CSRF'] = '1'; init.headers.Origin = ORIGIN; }
  return app.request(`${ORIGIN}${path}`, init, ENV);
}
function mockFetch(t, handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(new URL(String(url)), init); };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}
const json = (obj, status = 200) => new Response(obj === null ? null : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test('classifyBranch: merged/stale/deletable rules', () => {
  const dflt = classifyBranch({ name: 'main', isDefault: true, protected: true, aheadBy: 0, lastCommitDate: daysAgo(400) }, 90, NOW);
  assert.deepEqual(dflt, { merged: false, stale: false, ageDays: 400, deletable: false });
  const prot = classifyBranch({ name: 'release', protected: true, aheadBy: 0, lastCommitDate: daysAgo(100) }, 90, NOW);
  assert.equal(prot.merged, true); assert.equal(prot.stale, true); assert.equal(prot.deletable, false);
  const merged = classifyBranch({ name: 'f1', aheadBy: 0, lastCommitDate: daysAgo(5) }, 90, NOW);
  assert.deepEqual(merged, { merged: true, stale: false, ageDays: 5, deletable: true });
  const stale = classifyBranch({ name: 'f2', aheadBy: 3, lastCommitDate: daysAgo(90) }, 90, NOW);
  assert.deepEqual(stale, { merged: false, stale: true, ageDays: 90, deletable: true });
  const unknown = classifyBranch({ name: 'f3', aheadBy: null, lastCommitDate: null }, 90, NOW);
  assert.deepEqual(unknown, { merged: false, stale: false, ageDays: null, deletable: true });
  const badDays = classifyBranch({ name: 'f4', aheadBy: 1, lastCommitDate: daysAgo(100) }, 0, NOW);
  assert.equal(badDays.stale, true); // falls back to 90
  assert.equal(classifyBranches([{ name: 'x', aheadBy: 0 }], 30, NOW)[0].merged, true);
});

test('empty-check maps 409 to empty:true and 200 to empty:false', async (t) => {
  let empty = true;
  const calls = mockFetch(t, async (u) => (u.pathname.endsWith('/commits') ? (empty ? json({ message: 'Git Repository is empty.' }, 409) : json([{ sha: 'a' }])) : json({})));
  let res = await authed('/api/repos/a/r/empty-check');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).empty, true);
  assert.equal(new URL(calls[0].url).search, '?per_page=1');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  empty = false;
  res = await authed('/api/repos/a/r/empty-check');
  assert.equal((await res.json()).empty, false);
  res = await authed('/api/repos/a/..%2F..%2Fx/empty-check');
  assert.equal(res.status, 400);
});

test('GET branches lists, compares and classifies; default never deletable', async (t) => {
  mockFetch(t, async (u) => {
    const p = u.pathname;
    if (p === '/repos/a/r') return json({ default_branch: 'main' });
    if (p === '/repos/a/r/branches') return json([
      { name: 'main', protected: true, commit: { sha: 'aaaaaaa' } },
      { name: 'feature/x', protected: false, commit: { sha: 'bbbbbbb' } },
      { name: 'old', protected: false, commit: { sha: 'ccccccc' } },
      { name: 'keep', protected: true, commit: { sha: 'ddddddd' } },
    ]);
    if (p.startsWith('/repos/a/r/compare/')) {
      assert.match(p, /^\/repos\/a\/r\/compare\/main\.\.\.(feature\/x|old|keep)$/);
      return json({ ahead_by: p.endsWith('old') ? 0 : 2, behind_by: 1 });
    }
    if (p.startsWith('/repos/a/r/commits/')) {
      const sha = p.split('/').pop();
      return json({ commit: { committer: { date: sha === 'ccccccc' ? daysAgo(200) : daysAgo(3) } } });
    }
    return json({ message: 'unexpected ' + p }, 500);
  });
  const res = await authed('/api/repos/a/r/branches?stale_days=120');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.defaultBranch, 'main');
  assert.equal(body.staleDays, 120);
  const by = Object.fromEntries(body.branches.map((b) => [b.name, b]));
  assert.equal(by.main.isDefault, true); assert.equal(by.main.deletable, false);
  assert.equal(by['feature/x'].merged, false); assert.equal(by['feature/x'].deletable, true);
  assert.equal(by.old.merged, true); assert.equal(by.old.stale, true); assert.equal(by.old.deletable, true);
  assert.equal(by.keep.protected, true); assert.equal(by.keep.deletable, false);
  const bad = await authed('/api/repos/a/r/branches?stale_days=-1');
  assert.equal(bad.status, 400);
});

test('DELETE branch refuses default/protected and keeps slash-separated segments', async (t) => {
  const calls = mockFetch(t, async (u, init) => {
    const p = u.pathname;
    if (p === '/repos/a/r') return json({ default_branch: 'main' });
    if (p === '/repos/a/r/branches/main') return json({ name: 'main', protected: true });
    if (p === '/repos/a/r/branches/release') return json({ name: 'release', protected: true });
    if (p === '/repos/a/r/branches/feature/x') return json({ name: 'feature/x', protected: false });
    if (p === '/repos/a/r/git/refs/heads/feature/x' && init.method === 'DELETE') return json(null, 204);
    return json({ message: 'unexpected ' + p }, 500);
  });
  let res = await authed('/api/repos/a/r/branches/main', { method: 'DELETE' });
  assert.equal(res.status, 409); assert.equal((await res.json()).error, 'protected_branch');
  res = await authed('/api/repos/a/r/branches/release', { method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.ok(!calls.some((c) => c.init.method === 'DELETE'), 'no upstream DELETE for refused branches');
  res = await authed('/api/repos/a/r/branches/feature/x', { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.ok(calls.some((c) => c.init.method === 'DELETE' && c.url.endsWith('/git/refs/heads/feature/x')));
  res = await authed('/api/repos/a/r/branches/feature/x', { method: 'DELETE', headers: {} });
  assert.equal(res.status, 204);
  res = await authed('/api/repos/a/r/branches/..%2Fevil', { method: 'DELETE' });
  assert.equal(res.status, 400);
  res = await authed('/api/repos/a/r/branches/bad~name', { method: 'DELETE' });
  assert.equal(res.status, 400);
  // CSRF still enforced
  const sealed = await seal(makeSessionPayload({ token: TOKEN, login: 'a', id: 1 }), SECRET);
  res = await app.request(`${ORIGIN}/api/repos/a/r/branches/feature/x`, { method: 'DELETE', headers: { Cookie: `__Host-gm_session=${sealed}` } }, ENV);
  assert.equal(res.status, 403);
});
