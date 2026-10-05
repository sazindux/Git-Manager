// In-memory application state with a tiny pub/sub. Nothing is persisted.
const listeners = new Map();

export const state = {
  user: null, // { login, id, avatar_url, name, scopes }
  repos: [], // trimmed repo objects from /api/repos
  reposLoaded: false,
  loading: { active: false, page: 0, count: 0 },
  selection: new Set(), // repo ids
  rate: { remaining: null, reset: null, limit: null },
  activeTab: 'repos',
};

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, payload) {
  listeners.get(event)?.forEach((fn) => {
    try { fn(payload); } catch { /* listener errors must not break others */ }
  });
}

export function hasScope(scope) {
  const scopes = state.user?.scopes || [];
  if (scopes.includes(scope)) return true;
  // `repo` implies `public_repo`; nothing implies delete_repo.
  if (scope === 'public_repo' && scopes.includes('repo')) return true;
  return false;
}

export function setUser(user) {
  state.user = user;
  emit('user', user);
}

export function setRate(rate) {
  if (!rate) return;
  if (rate.remaining !== undefined && rate.remaining !== null) state.rate.remaining = rate.remaining;
  if (rate.reset !== undefined && rate.reset !== null) state.rate.reset = rate.reset;
  if (rate.limit !== undefined && rate.limit !== null) state.rate.limit = rate.limit;
  emit('rate', state.rate);
}

export function setRepos(repos) {
  state.repos = repos;
  state.reposLoaded = true;
  emit('repos', state.repos);
}

export function removeRepos(ids) {
  const set = new Set(ids);
  state.repos = state.repos.filter((r) => !set.has(r.id));
  for (const id of set) state.selection.delete(id);
  emit('repos', state.repos);
  emit('selection', state.selection);
}

export function updateRepo(id, patch) {
  const r = state.repos.find((x) => x.id === id);
  if (r) Object.assign(r, patch);
  emit('repos', state.repos);
}

export function setSelection(ids) {
  state.selection = new Set(ids);
  emit('selection', state.selection);
}

export function toggleSelected(id, selected) {
  if (selected) state.selection.add(id); else state.selection.delete(id);
  emit('selection', state.selection);
}

export function clearSelection() {
  state.selection.clear();
  emit('selection', state.selection);
}

export function selectedRepos() {
  return state.repos.filter((r) => state.selection.has(r.id));
}

export function setTab(tab) {
  state.activeTab = tab;
  emit('tab', tab);
}
