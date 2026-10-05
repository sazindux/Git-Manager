// AES-256-GCM sealed session cookie. Web Crypto only (edge + Node compatible).
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const IV_BYTES = 12;

const te = new TextEncoder();
const td = new TextDecoder();

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  if (typeof str !== 'string' || /[^A-Za-z0-9_-]/.test(str)) throw new Error('bad base64url');
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fromBase64(str) {
  const bin = atob(str.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBase64Url(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** Import SESSION_SECRET (base64 of exactly 32 bytes) as an AES-GCM key. */
export async function importKey(secretBase64) {
  if (typeof secretBase64 !== 'string' || secretBase64.length === 0) {
    throw new Error('SESSION_SECRET is not set');
  }
  let raw;
  try {
    raw = fromBase64(secretBase64);
  } catch {
    throw new Error('SESSION_SECRET is not valid base64');
  }
  if (raw.byteLength !== 32) {
    throw new Error('SESSION_SECRET must decode to exactly 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a JSON-serialisable payload → base64url(iv || ciphertext). */
export async function seal(payload, secretBase64) {
  const key = await importKey(secretBase64);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const plain = te.encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return toBase64Url(out);
}

/** Decrypt and validate. Returns the payload or null (tampered, malformed, or expired). */
export async function unseal(value, secretBase64, now = Date.now()) {
  try {
    const key = await importKey(secretBase64);
    const bytes = fromBase64Url(value);
    if (bytes.length <= IV_BYTES + 16) return null;
    const iv = bytes.subarray(0, IV_BYTES);
    const ct = bytes.subarray(IV_BYTES);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const payload = JSON.parse(td.decode(plain));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Constant-time string equality (length leak only). */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = te.encode(a);
  const bb = te.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// ---- cookie helpers -------------------------------------------------------

export function isLocalhost(requestUrl) {
  const u = new URL(requestUrl);
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

export function sessionCookieName(requestUrl) {
  return isLocalhost(requestUrl) ? 'gm_session' : '__Host-gm_session';
}

export const STATE_COOKIE = 'gm_oauth_state';

function cookieAttrs(requestUrl, maxAge) {
  return {
    httpOnly: true,
    secure: !isLocalhost(requestUrl),
    sameSite: 'Lax',
    path: '/',
    maxAge,
  };
}

export function setSessionCookie(c, value) {
  setCookie(c, sessionCookieName(c.req.url), value, cookieAttrs(c.req.url, SESSION_TTL_SECONDS));
}

export function clearSessionCookie(c) {
  deleteCookie(c, sessionCookieName(c.req.url), cookieAttrs(c.req.url, 0));
}

export function readSessionCookie(c) {
  return getCookie(c, sessionCookieName(c.req.url)) ?? null;
}

export function setStateCookie(c, value) {
  setCookie(c, STATE_COOKIE, value, cookieAttrs(c.req.url, 600));
}

export function readStateCookie(c) {
  return getCookie(c, STATE_COOKIE) ?? null;
}

export function clearStateCookie(c) {
  deleteCookie(c, STATE_COOKIE, cookieAttrs(c.req.url, 0));
}

/** Build the session payload. `exp` is absolute epoch ms. */
export function makeSessionPayload({ token, login, id }, now = Date.now()) {
  return { t: token, login, id, exp: now + SESSION_TTL_SECONDS * 1000 };
}
