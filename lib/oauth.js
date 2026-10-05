import {
  seal, unseal, randomBase64Url, timingSafeEqual, makeSessionPayload,
  setSessionCookie, clearSessionCookie, readSessionCookie,
  setStateCookie, readStateCookie, clearStateCookie,
} from './session.js';
import { ghFetch, GitHubError, applyRateHeaders } from './github.js';

const SCOPES = 'repo delete_repo read:org';

export function getEnv(c) {
  // Prefer bindings passed via app.request()/platform; fall back to process.env (Vercel edge + Node).
  const e = (c.env && typeof c.env === 'object' && 'SESSION_SECRET' in c.env) ? c.env : (globalThis.process?.env ?? {});
  return {
    clientId: e.GITHUB_CLIENT_ID,
    clientSecret: e.GITHUB_CLIENT_SECRET,
    sessionSecret: e.SESSION_SECRET,
    appUrl: e.APP_URL,
  };
}

export function appOrigin(c) {
  const { appUrl } = getEnv(c);
  if (appUrl) return new URL(appUrl).origin;
  return new URL(c.req.url).origin;
}

function callbackUrl(c) {
  return `${appOrigin(c)}/api/auth/callback`;
}

function redirectError(c, code) {
  return c.redirect(`/?error=${encodeURIComponent(code)}`, 302);
}

export function login(c) {
  const { clientId } = getEnv(c);
  if (!clientId) return redirectError(c, 'server_config');
  const state = randomBase64Url(24);
  setStateCookie(c, state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(c),
    scope: SCOPES,
    state,
    allow_signup: 'false',
  });
  return c.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
}

export async function callback(c) {
  const { clientId, clientSecret, sessionSecret } = getEnv(c);
  const expected = readStateCookie(c);
  clearStateCookie(c);
  if (!clientId || !clientSecret || !sessionSecret) return redirectError(c, 'server_config');

  const state = c.req.query('state');
  const code = c.req.query('code');
  if (c.req.query('error')) return redirectError(c, 'access_denied');
  if (!expected || !state || !timingSafeEqual(state, expected)) return redirectError(c, 'bad_state');
  if (!code || typeof code !== 'string' || code.length > 200) return redirectError(c, 'bad_code');

  let token;
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'serverless-github-manager' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl(c) }),
    });
    const body = await res.json().catch(() => null);
    token = body && typeof body.access_token === 'string' ? body.access_token : null;
  } catch {
    token = null;
  }
  if (!token) return redirectError(c, 'exchange_failed');

  let user;
  try {
    user = (await ghFetch(token, '/user')).data;
  } catch {
    return redirectError(c, 'user_failed');
  }
  if (!user || typeof user.login !== 'string') return redirectError(c, 'user_failed');

  let sealed;
  try {
    sealed = await seal(makeSessionPayload({ token, login: user.login, id: user.id }), sessionSecret);
  } catch {
    return redirectError(c, 'server_config');
  }
  setSessionCookie(c, sealed);
  return c.redirect('/', 302);
}

/** Best-effort token revocation, then clear the cookie. Always 204. */
export async function logout(c) {
  const { clientId, clientSecret, sessionSecret } = getEnv(c);
  const raw = readSessionCookie(c);
  if (raw && clientId && clientSecret && sessionSecret) {
    const session = await unseal(raw, sessionSecret);
    if (session?.t) {
      try {
        await fetch(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'serverless-github-manager',
            Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ access_token: session.t }),
        });
      } catch {
        /* revocation is best-effort */
      }
    }
  }
  clearSessionCookie(c);
  return c.body(null, 204);
}

/** Middleware: require a valid session; puts `{ token, login, id }` on c.var.session. */
export async function requireSession(c, next) {
  const { sessionSecret } = getEnv(c);
  const raw = readSessionCookie(c);
  if (!raw || !sessionSecret) return c.json({ error: 'unauthorized' }, 401);
  const session = await unseal(raw, sessionSecret);
  if (!session?.t) {
    clearSessionCookie(c);
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.set('session', { token: session.t, login: session.login, id: session.id });
  await next();
}

export async function me(c) {
  const { token } = c.get('session');
  try {
    const { data, headers, rate } = await ghFetch(token, '/user');
    applyRateHeaders(c, rate);
    const scopes = (headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return c.json({
      login: data.login,
      id: data.id,
      avatar_url: data.avatar_url,
      name: data.name ?? null,
      scopes,
    });
  } catch (err) {
    if (err instanceof GitHubError && err.status === 401) {
      clearSessionCookie(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    throw err;
  }
}
