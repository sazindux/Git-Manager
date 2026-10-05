// Repository route handlers. Each mutating route acts on exactly one repo.
import { ghFetch, applyRateHeaders } from './github.js';
import { isValidOwner, isValidRepo, isValidBranch, encodeBranch, parsePositiveInt, normalizeTopics, MAX_TOPICS } from './validate.js';
import { classifyBranches, DEFAULT_STALE_DAYS } from './branches.js';

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


async function readJsonBody(c) {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

const bad = (c, message) => c.json({ error: 'bad_request', message }, 400);

/** PATCH /repos/:owner/:repo — only `private` and/or `archived` booleans are accepted. */
export async function patchRepo(c) {
  const { token } = c.get('session');
  const { path } = c.get('target');
  const body = await readJsonBody(c);
  if (!body) return bad(c, 'JSON object body required');
  const allowed = ['private', 'archived'];
  const keys = Object.keys(body);
  if (keys.length === 0) return bad(c, 'Body must contain private and/or archived');
  for (const k of keys) {
    if (!allowed.includes(k)) return bad(c, `Unsupported field: ${k.slice(0, 40)}`);
    if (typeof body[k] !== 'boolean') return bad(c, `${k} must be a boolean`);
  }
  const { data, rate } = await ghFetch(token, path, { method: 'PATCH', body });
  applyRateHeaders(c, rate);
  return c.json({ repo: trimRepo(data || {}), rate });
}

/** DELETE /repos/:owner/:repo */
export async function deleteRepo(c) {
  const { token } = c.get('session');
  const { path } = c.get('target');
  const { rate } = await ghFetch(token, path, { method: 'DELETE' });
  applyRateHeaders(c, rate);
  return c.body(null, 204);
}

/** Pure merge used by PUT topics. Returns { ok, topics } or { ok: false, error }. */
export function mergeTopics(existing, mode, names) {
  const incoming = normalizeTopics(names);
  if (!incoming.ok) return incoming;
  const current = Array.isArray(existing) ? existing.map((t) => String(t).toLowerCase()) : [];
  let merged;
  if (mode === 'add') merged = [...new Set([...current, ...incoming.topics])];
  else if (mode === 'remove') merged = current.filter((t) => !incoming.topics.includes(t));
  else if (mode === 'replace') merged = incoming.topics;
  else return { ok: false, error: 'mode must be add, remove or replace' };
  if (merged.length > MAX_TOPICS) return { ok: false, error: `Result would have ${merged.length} topics; at most ${MAX_TOPICS} allowed` };
  return { ok: true, topics: merged };
}

/** PUT /repos/:owner/:repo/topics — body { mode, names } */
export async function putTopics(c) {
  const { token } = c.get('session');
  const { path } = c.get('target');
  const body = await readJsonBody(c);
  if (!body) return bad(c, 'JSON object body required');
  if (!['add', 'remove', 'replace'].includes(body.mode)) return bad(c, 'mode must be add, remove or replace');
  if (!Array.isArray(body.names)) return bad(c, 'names must be an array');
  if (body.names.length > 100) return bad(c, 'Too many topics in request');
  const pre = normalizeTopics(body.names);
  if (!pre.ok) return bad(c, pre.error);
  let existing = [];
  if (body.mode !== 'replace') {
    const cur = await ghFetch(token, `${path}/topics`);
    existing = Array.isArray(cur.data?.names) ? cur.data.names : [];
  }
  const merged = mergeTopics(existing, body.mode, body.names);
  if (!merged.ok) return bad(c, merged.error);
  const { data, rate } = await ghFetch(token, `${path}/topics`, { method: 'PUT', body: { names: merged.topics } });
  applyRateHeaders(c, rate);
  return c.json({ topics: Array.isArray(data?.names) ? data.names : merged.topics, rate });
}

/** POST /repos/:owner/:repo/transfer — body { new_owner, new_name? }. GitHub answers 202 (accepted/pending). */
export async function transferRepo(c) {
  const { token } = c.get('session');
  const { owner, path } = c.get('target');
  const body = await readJsonBody(c);
  if (!body) return bad(c, 'JSON object body required');
  for (const k of Object.keys(body)) if (!['new_owner', 'new_name'].includes(k)) return bad(c, `Unsupported field: ${k.slice(0, 40)}`);
  const newOwner = typeof body.new_owner === 'string' ? body.new_owner.trim() : '';
  if (!isValidOwner(newOwner)) return bad(c, 'new_owner must be a valid GitHub login');
  if (newOwner.toLowerCase() === owner.toLowerCase()) return bad(c, 'new_owner is already the owner');
  const payload = { new_owner: newOwner };
  if (body.new_name !== undefined) {
    if (typeof body.new_name !== 'string' || !isValidRepo(body.new_name.trim())) return bad(c, 'new_name must be a valid repository name');
    payload.new_name = body.new_name.trim();
  }
  const { status, data, rate } = await ghFetch(token, `${path}/transfer`, { method: 'POST', body: payload, okStatuses: [202] });
  applyRateHeaders(c, rate);
  return c.json({ status, pending: status === 202, repo: data ? trimRepo(data) : null, rate }, 202);
}

/** GET /repos/:owner/:repo/empty-check — GitHub answers 409 for repositories without commits. */
export async function emptyCheck(c) {
  const { token } = c.get('session');
  const { path } = c.get('target');
  const { status, rate } = await ghFetch(token, `${path}/commits?per_page=1`, { okStatuses: [409] });
  applyRateHeaders(c, rate);
  return c.json({ empty: status === 409, rate });
}

const MAX_BRANCH_PAGES = 10; // 1000 branches per repo is plenty for a cleanup tool

/** GET /repos/:owner/:repo/branches?stale_days=N — branch list with merged/stale/deletable classification. */
export async function listBranches(c) {
  const { token } = c.get('session');
  const { path } = c.get('target');
  const staleDays = parsePositiveInt(c.req.query('stale_days'), DEFAULT_STALE_DAYS, { max: 36500 });
  if (staleDays === null) return bad(c, 'Invalid stale_days');

  const repoRes = await ghFetch(token, path);
  const defaultBranch = typeof repoRes.data?.default_branch === 'string' ? repoRes.data.default_branch : 'main';

  const raw = [];
  let rate = repoRes.rate;
  for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
    const res = await ghFetch(token, `${path}/branches?per_page=100&page=${page}`);
    rate = res.rate;
    const items = Array.isArray(res.data) ? res.data : [];
    raw.push(...items);
    if (items.length < 100) break;
  }

  const branches = [];
  for (const b of raw) {
    if (typeof b?.name !== 'string' || !isValidBranch(b.name)) continue;
    const isDefault = b.name === defaultBranch;
    const entry = { name: b.name, protected: !!b.protected, isDefault, aheadBy: null, behindBy: null, lastCommitDate: null };
    if (!isDefault) {
      const cmp = await ghFetch(token, `${path}/compare/${encodeBranch(defaultBranch)}...${encodeBranch(b.name)}`, { okStatuses: [404] });
      if (cmp.status === 200 && cmp.data) {
        entry.aheadBy = Number.isInteger(cmp.data.ahead_by) ? cmp.data.ahead_by : null;
        entry.behindBy = Number.isInteger(cmp.data.behind_by) ? cmp.data.behind_by : null;
      }
      rate = cmp.rate;
    }
    const sha = typeof b.commit?.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(b.commit.sha) ? b.commit.sha : null;
    if (sha) {
      const cm = await ghFetch(token, `${path}/commits/${sha}`, { okStatuses: [404, 422] });
      const d = cm.data?.commit?.committer?.date || cm.data?.commit?.author?.date || null;
      entry.lastCommitDate = typeof d === 'string' ? d : null;
      rate = cm.rate;
    }
    branches.push(entry);
  }
  applyRateHeaders(c, rate);
  return c.json({ defaultBranch, staleDays, branches: classifyBranches(branches, staleDays), rate });
}

/** DELETE /repos/:owner/:repo/branches/* — refuses the default branch and protected branches. */
export async function deleteBranch(c) {
  const { token } = c.get('session');
  const { path } = c.get('target');
  let branch;
  try {
    branch = decodeURIComponent(c.req.param('branch') ?? c.req.path.split('/branches/')[1] ?? '');
  } catch {
    return bad(c, 'Invalid branch name');
  }
  if (!isValidBranch(branch)) return bad(c, 'Invalid branch name');

  const repoRes = await ghFetch(token, path);
  const defaultBranch = repoRes.data?.default_branch;
  if (branch === defaultBranch) return c.json({ error: 'protected_branch', message: 'The default branch cannot be deleted', status: 409 }, 409);
  const br = await ghFetch(token, `${path}/branches/${encodeBranch(branch)}`);
  if (br.data?.protected) return c.json({ error: 'protected_branch', message: 'Protected branches cannot be deleted', status: 409 }, 409);

  const { rate } = await ghFetch(token, `${path}/git/refs/heads/${encodeBranch(branch)}`, { method: 'DELETE' });
  applyRateHeaders(c, rate);
  return c.body(null, 204);
}
