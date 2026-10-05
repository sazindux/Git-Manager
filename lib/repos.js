// Repository route handlers. Each mutating route acts on exactly one repo.
import { ghFetch, applyRateHeaders } from './github.js';
import { isValidOwner, isValidRepo, parsePositiveInt } from './validate.js';

const REPO_FIELDS = [
  'id', 'name', 'full_name', 'private', 'visibility', 'fork', 'archived', 'disabled', 'is_template',
  'description', 'language', 'stargazers_count', 'forks_count', 'open_issues_count', 'size',
  'pushed_at', 'updated_at', 'default_branch', 'topics', 'html_url',
];

export function trimRepo(r) {
  const out = {};
  for (const k of REPO_FIELDS) out[k] = r[k] ?? null;
  out.owner = { login: r.owner?.login ?? null, type: r.owner?.type ?? null };
  out.permissions = r.permissions
    ? { admin: !!r.permissions.admin, maintain: !!r.permissions.maintain, push: !!r.permissions.push }
    : null;
  out.topics = Array.isArray(r.topics) ? r.topics : [];
  return out;
}

/** Hono middleware validating :owner/:repo params; stores them on c.var.target. */
export async function validateTarget(c, next) {
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  if (!isValidOwner(owner) || !isValidRepo(repo)) {
    return c.json({ error: 'invalid_target', message: 'Invalid owner or repository name' }, 400);
  }
  c.set('target', { owner, repo, path: `/repos/${owner}/${repo}` });
  await next();
}

export async function listRepos(c) {
  const { token } = c.get('session');
  const page = parsePositiveInt(c.req.query('page'), 1, { max: 10000 });
  if (page === null) return c.json({ error: 'bad_request', message: 'Invalid page' }, 400);
  const qs = new URLSearchParams({
    per_page: '100',
    page: String(page),
    sort: 'updated',
    affiliation: 'owner,collaborator,organization_member',
  });
  const { data, rate, headers } = await ghFetch(token, `/user/repos?${qs}`);
  applyRateHeaders(c, rate);
  const items = Array.isArray(data) ? data.map(trimRepo) : [];
  const link = headers.get('link') || '';
  const hasMore = /rel="next"/.test(link) || items.length === 100;
  return c.json({ page, items, hasMore, rate });
}

