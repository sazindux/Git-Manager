import { Hono } from 'hono';
import { GitHubError, applyRateHeaders } from './github.js';
import { clearSessionCookie } from './session.js';
import { login, callback, logout, me, requireSession, appOrigin } from './oauth.js';
import { listRepos, validateTarget, patchRepo, deleteRepo, putTopics, transferRepo, emptyCheck, listBranches, deleteBranch } from './repos.js';

export const app = new Hono().basePath('/api');

// Every API response is uncacheable.
app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

// CSRF: non-GET requests need the custom header and a matching Origin.
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (c.req.header('X-GM-CSRF') !== '1') return c.json({ error: 'csrf' }, 403);
  const origin = c.req.header('Origin');
  if (!origin || origin !== appOrigin(c)) return c.json({ error: 'bad_origin' }, 403);
  return next();
});

app.get('/health', (c) => c.json({ ok: true }));

app.get('/auth/login', login);
app.get('/auth/callback', callback);
app.post('/auth/logout', logout);
app.get('/me', requireSession, me);

app.get('/repos', requireSession, listRepos);
app.patch('/repos/:owner/:repo', requireSession, validateTarget, patchRepo);
app.delete('/repos/:owner/:repo', requireSession, validateTarget, deleteRepo);
app.put('/repos/:owner/:repo/topics', requireSession, validateTarget, putTopics);
app.post('/repos/:owner/:repo/transfer', requireSession, validateTarget, transferRepo);
app.get('/repos/:owner/:repo/empty-check', requireSession, validateTarget, emptyCheck);
app.get('/repos/:owner/:repo/branches', requireSession, validateTarget, listBranches);
app.delete('/repos/:owner/:repo/branches/:branch{.+}', requireSession, validateTarget, deleteBranch);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  if (err instanceof GitHubError) {
    applyRateHeaders(c, err.extra?.rate);
    if (err.status === 401) clearSessionCookie(c);
    return c.json(err.toJSON(), err.status);
  }
  return c.json({ error: 'internal_error' }, 500);
});
