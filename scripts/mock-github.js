// Dev-only: GM_MOCK=1 replaces globalThis.fetch for github.com/api.github.com with an in-memory fake.
// Never imported by lib/ or api/. Lets you exercise the UI without real OAuth credentials.
const LANGS = ['JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', null, 'Shell', 'HTML'];
const OWNERS = [{ login: 'mockuser', type: 'User' }, { login: 'mock-org', type: 'Organization' }, { login: 'friend', type: 'User' }];
const repos = new Map();
const branches = new Map();
const N = Number(process.env.GM_MOCK_REPOS || 240);

function seed() {
  for (let i = 1; i <= N; i++) {
    const owner = OWNERS[i % 7 === 0 ? 1 : i % 11 === 0 ? 2 : 0];
    const days = (i * 37) % 1400;
    const pushed = new Date(Date.now() - days * 86400000).toISOString();
    const name = `repo-${String(i).padStart(3, '0')}${i % 5 === 0 ? '-fork' : ''}`;
    repos.set(i, {
      id: i, name, full_name: `${owner.login}/${name}`, owner,
      private: i % 3 === 0, visibility: i % 3 === 0 ? 'private' : 'public', fork: i % 5 === 0,
      archived: i % 17 === 0, disabled: false, is_template: false,
      description: i % 4 === 0 ? null : `Description for repository number ${i} <b>not html</b>`,
      language: LANGS[i % LANGS.length], stargazers_count: (i * 13) % 500, forks_count: (i * 7) % 60,
      open_issues_count: i % 9, size: i % 13 === 0 ? 0 : (i * 311) % 90000,
      pushed_at: pushed, updated_at: pushed, default_branch: 'main', topics: i % 3 === 0 ? ['tooling', `t${i % 6}`] : [],
      html_url: `https://github.com/${owner.login}/${name}`,
      permissions: { admin: owner.login !== 'friend', maintain: true, push: true },
    });
    const list = [{ name: 'main', protected: true, days: 1, ahead: 0 }];
    for (let b = 0; b < i % 6; b++) list.push({ name: `feature/b${b}`, protected: b === 3, days: (b + 1) * 40, ahead: b % 2 });
    branches.set(i, list);
  }
}
seed();

function json(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4321', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000), ...headers },
  });
}
const find = (o, r) => [...repos.values()].find((x) => x.owner.login === o && x.name === r);

export function installMock() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url);
    if (u.hostname !== 'api.github.com' && u.hostname !== 'github.com') return real(input, init);
    const m = (init.method || 'GET').toUpperCase();
    const p = u.pathname;
    await new Promise((r) => setTimeout(r, 60));
    if (u.hostname === 'github.com' && p === '/login/oauth/access_token') return json({ access_token: 'mock_token' });
    if (p === '/user') return json({ login: 'mockuser', id: 1, avatar_url: 'https://avatars.githubusercontent.com/u/583231', name: 'Mock User' }, 200, { 'x-oauth-scopes': 'repo, delete_repo, read:org' });
    if (p.startsWith('/applications/')) return json(null, 204);
    if (p === '/user/repos') {
      const page = Number(u.searchParams.get('page') || 1);
      const all = [...repos.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const slice = all.slice((page - 1) * 100, page * 100);
      const h = page * 100 < all.length ? { link: `<x?page=${page + 1}>; rel="next"` } : {};
      return json(slice, 200, h);
    }
    const mt = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (mt) {
      const repo = find(mt[1], decodeURIComponent(mt[2]));
      if (!repo) return json({ message: 'Not Found' }, 404);
      const rest = mt[3] || '';
      const body = init.body ? JSON.parse(init.body) : {};
      if (rest === '' && m === 'GET') return json(repo);
      const one = rest.match(/^\/branches\/(.+)$/);
      if (one && m === 'GET') {
        const b = branches.get(repo.id).find((x) => x.name === decodeURIComponent(one[1]));
        return b ? json({ name: b.name, protected: b.protected }) : json({ message: 'Branch not found' }, 404);
      }
      if (rest === '' && m === 'PATCH') {
        if (repo.fork && 'private' in body) return json({ message: 'Visibility of forks cannot be changed' }, 422);
        if (!repo.permissions.admin) return json({ message: 'Must have admin rights to Repository.' }, 403);
        Object.assign(repo, body);
        if ('private' in body) repo.visibility = body.private ? 'private' : 'public';
        return json(repo);
      }
      if (rest === '' && m === 'DELETE') {
        if (!repo.permissions.admin) return json({ message: 'Must have admin rights to Repository.' }, 403);
        repos.delete(repo.id); return json(null, 204);
      }
      if (rest === '/topics' && m === 'GET') return json({ names: repo.topics });
      if (rest === '/topics' && m === 'PUT') { repo.topics = body.names; return json({ names: repo.topics }); }
      if (rest === '/transfer') return json({ ...repo, owner: { login: body.new_owner, type: 'User' } }, 202);
      if (rest === '/commits') return repo.size === 0 ? json({ message: 'Git Repository is empty.' }, 409) : json([{ sha: 'abc' }]);
      if (rest === '/branches') {
        return json(branches.get(repo.id).map((b) => ({ name: b.name, protected: b.protected, commit: { sha: `sha-${b.name}` } })));
      }
      const cmp = rest.match(/^\/compare\/(.+)\.\.\.(.+)$/);
      if (cmp) {
        const b = branches.get(repo.id).find((x) => x.name === decodeURIComponent(cmp[2]));
        return json({ ahead_by: b?.ahead ?? 0, behind_by: 2 });
      }
      if (rest.startsWith('/commits/')) {
        const b = branches.get(repo.id).find((x) => `sha-${x.name}` === rest.slice('/commits/'.length));
        return json({ commit: { committer: { date: new Date(Date.now() - (b?.days ?? 0) * 86400000).toISOString() } } });
      }
      const ref = rest.match(/^\/git\/refs\/heads\/(.+)$/);
      if (ref && m === 'DELETE') {
        const name = decodeURIComponent(ref[1]);
        const list = branches.get(repo.id);
        const idx = list.findIndex((x) => x.name === name);
        if (idx < 0) return json({ message: 'Reference does not exist' }, 422);
        list.splice(idx, 1); return json(null, 204);
      }
    }
    return json({ message: 'mock: unhandled ' + m + ' ' + p }, 404);
  };
}
