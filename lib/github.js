// GitHub REST client. Never logs or leaks the token or upstream bodies.
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  toJSON() {
    return { error: this.code, message: this.message, status: this.status, ...this.extra };
  }
}

export function ghHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'serverless-github-manager',
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

/** Pick rate-limit headers from an upstream response. */
export function rateInfo(res) {
  const out = {};
  const rem = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  const limit = res.headers.get('x-ratelimit-limit');
  const retry = res.headers.get('retry-after');
  if (rem !== null) out.remaining = Number(rem);
  if (reset !== null) out.reset = Number(reset);
  if (limit !== null) out.limit = Number(limit);
  if (retry !== null) out.retryAfter = Number(retry);
  return out;
}

/** Copy rate-limit info onto a Hono context's response headers. */
export function applyRateHeaders(c, info) {
  if (!info) return;
  if (info.remaining !== undefined) c.header('X-RateLimit-Remaining', String(info.remaining));
  if (info.reset !== undefined) c.header('X-RateLimit-Reset', String(info.reset));
  if (info.limit !== undefined) c.header('X-RateLimit-Limit', String(info.limit));
  if (info.retryAfter !== undefined) c.header('Retry-After', String(info.retryAfter));
}

/** Seconds the client should wait when rate limited (capped so UI can show something sane). */
function waitSeconds(info, now = Date.now()) {
  if (info.retryAfter) return Math.max(1, info.retryAfter);
  if (info.reset) return Math.max(1, Math.ceil(info.reset - now / 1000));
  return 60;
}

/**
 * Map an upstream non-2xx response to a GitHubError with a safe, generic message.
 * Only the upstream `message` string is forwarded (truncated); never the raw body.
 */
export async function mapError(res) {
  const info = rateInfo(res);
  let upstreamMsg = '';
  try {
    const body = await res.json();
    if (body && typeof body.message === 'string') upstreamMsg = body.message.slice(0, 200);
  } catch {
    /* ignore non-JSON bodies */
  }
  const s = res.status;
  if (s === 401) return new GitHubError(401, 'unauthorized', 'GitHub session is no longer valid', { rate: info });
  if ((s === 403 || s === 429) && (info.retryAfter || info.remaining === 0)) {
    const wait = waitSeconds(info);
    return new GitHubError(429, 'rate_limited', `GitHub rate limit reached; retry in ${wait}s`, { retryAfter: wait, rate: info });
  }
  if (s === 403 && /secondary rate limit|abuse/i.test(upstreamMsg)) {
    return new GitHubError(429, 'rate_limited', 'GitHub secondary rate limit; retry in 60s', { retryAfter: 60, rate: info });
  }
  if (s === 403) return new GitHubError(403, 'forbidden', upstreamMsg || 'Forbidden by GitHub', { rate: info });
  if (s === 404) return new GitHubError(404, 'not_found', upstreamMsg || 'Not found on GitHub', { rate: info });
  if (s === 409) return new GitHubError(409, 'conflict', upstreamMsg || 'Conflict', { rate: info });
  if (s === 422) return new GitHubError(422, 'unprocessable', upstreamMsg || 'GitHub rejected the request', { rate: info });
  if (s >= 500) return new GitHubError(502, 'upstream_error', 'GitHub is unavailable', { rate: info });
  return new GitHubError(s, 'github_error', upstreamMsg || `GitHub returned ${s}`, { rate: info });
}

/**
 * Fetch a GitHub API path. Returns { status, data, rate, headers }.
 * Throws GitHubError on non-2xx (except statuses listed in opts.okStatuses).
 */
export async function ghFetch(token, path, opts = {}) {
  const { method = 'GET', body, okStatuses = [], headers: extraHeaders = {}, signal } = opts;
  const url = path.startsWith('https://') ? path : API + path;
  const init = { method, headers: ghHeaders(token, extraHeaders), signal };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new GitHubError(502, 'network_error', 'Could not reach GitHub');
  }
  const rate = rateInfo(res);
  if (!res.ok && !okStatuses.includes(res.status)) throw await mapError(res);
  let data = null;
  if (res.status !== 204 && res.status !== 205) {
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
  }
  return { status: res.status, data, rate, headers: res.headers };
}
