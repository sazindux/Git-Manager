// Fetch wrapper for /api. Same-origin cookies, CSRF header on writes, 401 → login screen.
import { setRate, emit } from './state.js';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || 'error';
    this.retryAfter = extra.retryAfter ?? null;
  }
  get isRateLimit() { return this.code === 'rate_limited' || this.status === 429; }
}

function readRate(res) {
  const rem = res.headers.get('X-RateLimit-Remaining');
  const reset = res.headers.get('X-RateLimit-Reset');
  const limit = res.headers.get('X-RateLimit-Limit');
  if (rem !== null || reset !== null) {
    setRate({
      remaining: rem !== null ? Number(rem) : undefined,
      reset: reset !== null ? Number(reset) : undefined,
      limit: limit !== null ? Number(limit) : undefined,
    });
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') headers['X-GM-CSRF'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Network error – check your connection');
  }
  readRate(res);
  if (res.status === 204) return null;
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (res.status === 401) {
    emit('unauthorized');
    throw new ApiError(401, 'unauthorized', 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const retryAfter = data?.retryAfter ?? (res.headers.get('Retry-After') ? Number(res.headers.get('Retry-After')) : null);
    throw new ApiError(res.status, data?.error, data?.message, { retryAfter });
  }
  if (data?.rate) setRate(data.rate);
  return data;
}

export const get = (path, opts) => api(path, { ...opts, method: 'GET' });
export const post = (path, body, opts) => api(path, { ...opts, method: 'POST', body });
export const patch = (path, body, opts) => api(path, { ...opts, method: 'PATCH', body });
export const put = (path, body, opts) => api(path, { ...opts, method: 'PUT', body });
export const del = (path, opts) => api(path, { ...opts, method: 'DELETE' });

/** Human-readable message for an error from any bulk action. */
export function describeError(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'AbortError') return 'Cancelled';
  if (err instanceof ApiError) {
    if (err.isRateLimit) return `Rate limited (retry in ${err.retryAfter ?? '?'}s)`;
    if (err.code === 'forbidden') return err.message || 'Forbidden – you need admin rights for this repository';
    if (err.code === 'not_found') return 'Not found (deleted already, or no access)';
    if (err.code === 'unprocessable') return err.message || 'GitHub rejected the request';
    return err.message || err.code;
  }
  return err.message || String(err);
}
