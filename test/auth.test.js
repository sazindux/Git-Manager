import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../lib/app.js';
import { seal, makeSessionPayload } from '../lib/session.js';

const SECRET = Buffer.alloc(32, 3).toString('base64');
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csec', SESSION_SECRET: SECRET };
const ORIGIN = 'https://app.example.com';
const req = (path, init) => app.request(`${ORIGIN}${path}`, init, ENV);


test('login redirects to GitHub with state cookie', async () => {
  const res = await req('/api/auth/login');
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'cid');
  assert.equal(loc.searchParams.get('scope'), 'repo delete_repo read:org');
  assert.equal(loc.searchParams.get('redirect_uri'), `${ORIGIN}/api/auth/callback`);
  assert.equal(loc.searchParams.get('allow_signup'), 'false');
  const state = loc.searchParams.get('state');
  assert.ok(state.length >= 22);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('gm_oauth_state='));
  assert.ok(setCookie.includes(state));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=600/);
});

test('callback rejects state mismatch', async () => {
  const res = await req('/api/auth/callback?code=abc&state=xyz', { headers: { Cookie: 'gm_oauth_state=other' } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?error=bad_state');
  const cleared = res.headers.getSetCookie().find((c) => c.startsWith('gm_oauth_state='));
  assert.match(cleared, /Max-Age=0/);
});

test('callback rejects missing state cookie', async () => {
  const res = await req('/api/auth/callback?code=abc&state=xyz');
  assert.equal(res.headers.get('location'), '/?error=bad_state');
});

test('callback full flow with mocked GitHub', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(init.body);
      assert.equal(body.client_id, 'cid');
      assert.equal(body.client_secret, 'csec');
      assert.equal(body.code, 'thecode');
      return new Response(JSON.stringify({ access_token: 'gho_secret' }), { headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://api.github.com/user') {
      assert.equal(init.headers.Authorization, 'Bearer gho_secret');
      return new Response(JSON.stringify({ login: 'alice', id: 42, avatar_url: 'https://avatars.githubusercontent.com/u/42', name: 'Alice' }), {
        headers: { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, delete_repo, read:org', 'x-ratelimit-remaining': '4999' },
      });
    }
    throw new Error('unexpected fetch ' + url);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const res = await req('/api/auth/callback?code=thecode&state=st123', { headers: { Cookie: 'gm_oauth_state=st123' } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const sess = res.headers.getSetCookie().find((c) => c.startsWith('__Host-gm_session='));
  assert.ok(sess);
  assert.ok(!sess.includes('gho_secret'));
  assert.match(sess, /HttpOnly/);
  assert.match(sess, /Max-Age=28800/);
  const value = sess.split(';')[0].split('=')[1];

  const meRes = await req('/api/me', { headers: { Cookie: `__Host-gm_session=${value}` } });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.headers.get('x-ratelimit-remaining'), '4999');
  const body = await meRes.json();
  assert.deepEqual(body, { login: 'alice', id: 42, avatar_url: 'https://avatars.githubusercontent.com/u/42', name: 'Alice', scopes: ['repo', 'delete_repo', 'read:org'] });
  assert.ok(!JSON.stringify(body).includes('gho_secret'));
});

test('/api/me without session → 401', async () => {
  const res = await req('/api/me');
  assert.equal(res.status, 401);
});

test('/api/me with garbage cookie → 401 and clears cookie', async () => {
  const res = await req('/api/me', { headers: { Cookie: '__Host-gm_session=garbage' } });
  assert.equal(res.status, 401);
  assert.match(res.headers.getSetCookie()[0], /Max-Age=0/);
});

test('/api/me when GitHub says 401 → clears session', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"message":"Bad credentials"}', { status: 401 });
  t.after(() => { globalThis.fetch = realFetch; });
  const sealed = await seal(makeSessionPayload({ token: 'gho_x', login: 'a', id: 1 }), SECRET);
  const res = await req('/api/me', { headers: { Cookie: `__Host-gm_session=${sealed}` } });
  assert.equal(res.status, 401);
  assert.match(res.headers.getSetCookie()[0], /Max-Age=0/);
});

test('CSRF: POST without header → 403; wrong origin → 403', async () => {
  let res = await req('/api/auth/logout', { method: 'POST', headers: { Origin: ORIGIN } });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'csrf' });
  res = await req('/api/auth/logout', { method: 'POST', headers: { 'X-GM-CSRF': '1', Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'bad_origin' });
  res = await req('/api/auth/logout', { method: 'POST', headers: { 'X-GM-CSRF': '1' } });
  assert.equal(res.status, 403);
});

test('logout revokes (best effort) and clears cookie → 204', async (t) => {
  const realFetch = globalThis.fetch;
  let revoked = false;
  globalThis.fetch = async (url, init) => {
    if (url === 'https://api.github.com/applications/cid/token' && init.method === 'DELETE') {
      revoked = JSON.parse(init.body).access_token === 'gho_x';
      return new Response(null, { status: 204 });
    }
    throw new Error('unexpected');
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const sealed = await seal(makeSessionPayload({ token: 'gho_x', login: 'a', id: 1 }), SECRET);
  const res = await req('/api/auth/logout', {
    method: 'POST',
    headers: { 'X-GM-CSRF': '1', Origin: ORIGIN, Cookie: `__Host-gm_session=${sealed}` },
  });
  assert.equal(res.status, 204);
  assert.equal(revoked, true);
  assert.match(res.headers.getSetCookie()[0], /__Host-gm_session=;.*Max-Age=0/);
});

test('APP_URL overrides request origin for callback + CSRF', async () => {
  const env2 = { ...ENV, APP_URL: 'https://prod.example.com' };
  const res = await app.request('https://preview.example.com/api/auth/login', undefined, env2);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://prod.example.com/api/auth/callback');
});

test('localhost uses plain cookie name without Secure', async () => {
  const res = await app.request('http://localhost:3000/api/auth/login', undefined, ENV);
  const sc = res.headers.getSetCookie()[0];
  assert.match(sc, /^gm_oauth_state=/);
  assert.ok(!/Secure/.test(sc));
});
