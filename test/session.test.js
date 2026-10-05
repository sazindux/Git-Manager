import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seal, unseal, importKey, timingSafeEqual, toBase64Url, fromBase64Url,
  makeSessionPayload, sessionCookieName, SESSION_TTL_SECONDS,
} from '../lib/session.js';

const SECRET = Buffer.alloc(32, 7).toString('base64');
const OTHER = Buffer.alloc(32, 9).toString('base64');

test('seal/unseal round trip', async () => {
  const payload = makeSessionPayload({ token: 'gho_x', login: 'alice', id: 1 });
  const sealed = await seal(payload, SECRET);
  assert.match(sealed, /^[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes('gho_x'));
  assert.deepEqual(await unseal(sealed, SECRET), payload);
});

test('two seals of same payload differ (random IV)', async () => {
  const p = makeSessionPayload({ token: 't', login: 'a', id: 1 });
  assert.notEqual(await seal(p, SECRET), await seal(p, SECRET));
});

test('tampered ciphertext is rejected', async () => {
  const sealed = await seal(makeSessionPayload({ token: 't', login: 'a', id: 1 }), SECRET);
  const bytes = fromBase64Url(sealed);
  bytes[bytes.length - 1] ^= 0x01;
  assert.equal(await unseal(toBase64Url(bytes), SECRET), null);
  bytes[bytes.length - 1] ^= 0x01;
  bytes[14] ^= 0x80;
  assert.equal(await unseal(toBase64Url(bytes), SECRET), null);
});

test('garbage input is rejected', async () => {
  assert.equal(await unseal('', SECRET), null);
  assert.equal(await unseal('not base64url!!', SECRET), null);
  assert.equal(await unseal('AAAA', SECRET), null);
  assert.equal(await unseal(undefined, SECRET), null);
});

test('expired payload is rejected', async () => {
  const now = Date.now();
  const sealed = await seal(makeSessionPayload({ token: 't', login: 'a', id: 1 }, now), SECRET);
  assert.ok(await unseal(sealed, SECRET, now + 1000));
  assert.equal(await unseal(sealed, SECRET, now + SESSION_TTL_SECONDS * 1000 + 1), null);
  const noExp = await seal({ t: 't' }, SECRET);
  assert.equal(await unseal(noExp, SECRET), null);
});

test('wrong key is rejected', async () => {
  const sealed = await seal(makeSessionPayload({ token: 't', login: 'a', id: 1 }), SECRET);
  assert.equal(await unseal(sealed, OTHER), null);
});

test('importKey validates secret length', async () => {
  await assert.rejects(importKey(''), /not set/);
  await assert.rejects(importKey('!!!'), /base64/);
  await assert.rejects(importKey(Buffer.alloc(16).toString('base64')), /32 bytes/);
});

test('timingSafeEqual', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('abc', undefined), false);
});

test('cookie name depends on localhost', () => {
  assert.equal(sessionCookieName('http://localhost:3000/api/me'), 'gm_session');
  assert.equal(sessionCookieName('https://app.vercel.app/api/me'), '__Host-gm_session');
});
