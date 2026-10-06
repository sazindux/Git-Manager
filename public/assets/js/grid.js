// Repository list (GitHub "Your repositories" style): progressive load, search/filter/sort, 30/page pager,
// keyed row cache + patching, one delegated listener, rAF-batched renders, selection header → bulk bar.
import { el, show, formatNumber, formatBytesFromKB, formatDate, relativeTime, debounce } from './ui.js';
import { get, describeError } from './api.js';
import { state, on, emit, hasScope, setRepos, setSelection, toggleSelected, clearSelection } from './state.js';
import { error as toastError, info as toastInfo } from './toast.js';
import { icon, spinner } from './icons.js';
import { langDot } from './langcolors.js';
import { createMenu } from './menu.js';

const PAGE_SIZE = 30;

const filters = {
  q: '',
  visibility: 'all', // all | public | private
  kind: 'all', // all | fork | source
  archived: 'all', // all | archived | active
  affiliation: 'all', // all | owner | collaborator | org
  language: 'all',
  emptyOnly: false,
  sort: 'pushed', // name | stars | forks | size | pushed
  dir: 'desc',
};

let page = 1;
let filtered = [];
let lastClickedId = null;
let loadAbort = null;

// --- filtering / sorting (pure) -------------------------------------------------------------

export function affiliationOf(repo, login) {
  if (repo.owner?.login === login) return 'owner';
  if (repo.owner?.type === 'Organization') return 'org';
  return 'collaborator';
}

export function isLikelyEmpty(repo) {
  // `isEmpty` is set by the cleanup scan (empty-check); size is only a cheap pre-filter.
  if (repo.isEmpty === true || repo.isEmpty === false) return repo.isEmpty;
  return (repo.size ?? 0) === 0;
}

// Lowercased search haystack cached per repo object; invalidated when name/description/topics change.
const hayCache = new WeakMap();
function haystack(r) {
  const c = hayCache.get(r);
  if (c && c.n === r.full_name && c.d === r.description && c.t === r.topics) return c.h;
  const h = `${r.full_name}\n${r.description || ''}\n${(r.topics || []).join(' ')}`.toLowerCase();
  hayCache.set(r, { n: r.full_name, d: r.description, t: r.topics, h });
  return h;
}

export function applyFilters(repos, f, login) {
  const q = f.q.trim().toLowerCase();
  const out = repos.filter((r) => {
    if (f.visibility === 'public' && r.private) return false;
    if (f.visibility === 'private' && !r.private) return false;
    if (f.kind === 'fork' && !r.fork) return false;
    if (f.kind === 'source' && r.fork) return false;
    if (f.archived === 'archived' && !r.archived) return false;
    if (f.archived === 'active' && r.archived) return false;
    if (f.affiliation !== 'all' && affiliationOf(r, login) !== f.affiliation) return false;
    if (f.language !== 'all' && (r.language || 'Unknown') !== f.language) return false;
    if (f.emptyOnly && !isLikelyEmpty(r)) return false;
    if (q && !haystack(r).includes(q)) return false;
    return true;
  });
  const dir = f.dir === 'asc' ? 1 : -1;
  const key = {
    name: (r) => r.full_name.toLowerCase(),
    stars: (r) => r.stargazers_count ?? 0,
    forks: (r) => r.forks_count ?? 0,
    size: (r) => r.size ?? 0,
    pushed: (r) => r.pushed_at || '',
    updated: (r) => r.updated_at || r.pushed_at || '',
  }[f.sort] || ((r) => r.pushed_at || '');
  // Decorate once (keys computed n times, not n log n).
  const dec = out.map((r) => ({ r, k: key(r), n: r.full_name }));
  dec.sort((a, b) => {
    if (a.k < b.k) return -1 * dir;
    if (a.k > b.k) return 1 * dir;
    return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
  });
  return dec.map((d) => d.r);
}

// --- loading --------------------------------------------------------------------------------

export async function loadAllRepos(onProgress) {
  loadAbort?.abort();
  loadAbort = new AbortController();
  const { signal } = loadAbort;
  const all = [];
  let p = 1;
  let hasMore = true;
  state.loading = { active: true, page: 0, count: 0 };
  while (hasMore) {
    const data = await get(`/api/repos?page=${p}`, { signal });
    all.push(...(data.items || []));
    hasMore = !!data.hasMore;
    state.loading = { active: hasMore, page: p, count: all.length };
    onProgress?.({ ...state.loading, items: all });
    p += 1;
    if (p > 200) break; // 20k repos safety valve
  }
  state.loading.active = false;
  setRepos(all);
  return all;
}

// --- UI -------------------------------------------------------------------------------------

const TYPE_OPTIONS = [
  ['all', 'All', {}],
  ['public', 'Public', { visibility: 'public' }],
  ['private', 'Private', { visibility: 'private' }],
  ['source', 'Sources', { kind: 'source' }],
  ['fork', 'Forks', { kind: 'fork' }],
  ['archived', 'Archived', { archived: 'archived' }],
  ['active', 'Not archived', { archived: 'active' }],
  ['empty', 'Empty', { emptyOnly: true }],
];
const SORT_OPTIONS = [['updated', 'Last updated'], ['pushed', 'Last pushed'], ['name', 'Name'], ['stars', 'Stars'], ['forks', 'Forks'], ['size', 'Size']];
const AFF_OPTIONS = [['all', 'All'], ['owner', 'Owned by me'], ['collaborator', 'Collaborator'], ['org', 'Organization']];
const DEFAULTS = { visibility: 'all', kind: 'all', archived: 'all', emptyOnly: false };

function typeOf(f) {
  for (const [key, , patch] of TYPE_OPTIONS) {
    const want = { ...DEFAULTS, ...patch };
    if (Object.keys(want).every((k) => f[k] === want[k])) return key;
  }
  return 'all';
}

/** Signature of every field a row displays; a change triggers a patch of that row only. */
function rowSig(r) {
  return [r.full_name, r.html_url, r.private, r.fork, r.archived, r.is_template, r.isEmpty, r.transferPending,
    r.description, (r.topics || []).join(','), r.language, r.stargazers_count, r.forks_count, r.size,
    r.updated_at, r.pushed_at, r.owner?.login, r.owner?.type, r.permissions?.admin].join('\u0001');
}

export function initGrid(panel) {
  filters.sort = 'updated';
  const login = state.user?.login;
  const rows = new Map(); // repoId → { li, chk, body, sig }
  let loadingItems = null; // progressive list while pages stream in
  let langCounts = [];
  let dirty = { data: true, langs: true, list: true, sel: true };
  let rafId = 0;

  // ---------- filter bar ----------
  const search = el('input', {
    class: 'form-control', type: 'search', placeholder: 'Find a repository…',
    'aria-label': 'Find a repository', autocomplete: 'off', spellcheck: 'false',
  });
  const searchWrap = el('div', { class: 'search-input min-w-[12rem] flex-1 basis-full sm:basis-auto' }, icon('search'), search);

  const setFilter = (patch) => { Object.assign(filters, patch); page = 1; refreshMenuLabels(); schedule('data'); };

  const typeMenu = createMenu({
    label: 'Type', ariaLabel: 'Filter by type', selectable: true,
    items: () => [{ header: 'Select type' }, ...TYPE_OPTIONS.map(([key, label, patch]) => ({
      label, checked: typeOf(filters) === key, onSelect: () => setFilter({ ...DEFAULTS, ...patch }),
    }))],
  });
  const langMenu = createMenu({
    label: 'Language', ariaLabel: 'Filter by language', selectable: true,
    items: () => [{ header: 'Select language' },
      { label: 'All', checked: filters.language === 'all', meta: formatNumber(sourceRepos().length), onSelect: () => setFilter({ language: 'all' }) },
      ...langCounts.map(([l, n]) => ({ label: l, dot: l === 'Unknown' ? null : l, meta: formatNumber(n), checked: filters.language === l, onSelect: () => setFilter({ language: l }) }))],
  });
  const affMenu = createMenu({
    label: 'Owner', ariaLabel: 'Filter by owner / affiliation', selectable: true,
    items: () => [{ header: 'Select affiliation' }, ...AFF_OPTIONS.map(([key, label]) => ({
      label, checked: filters.affiliation === key, onSelect: () => setFilter({ affiliation: key }),
    }))],
  });
  const sortMenu = createMenu({
    label: 'Sort', ariaLabel: 'Sort repositories', selectable: true,
    items: () => [{ header: 'Select order' }, ...SORT_OPTIONS.map(([key, label]) => ({
      label, checked: filters.sort === key,
      onSelect: () => setFilter({ sort: key, dir: key === 'name' ? 'asc' : 'desc' }),
    })), { divider: true },
    { label: 'Descending', icon: 'sort-desc', checked: filters.dir === 'desc', onSelect: () => setFilter({ dir: 'desc' }) },
    { label: 'Ascending', icon: 'sort-asc', checked: filters.dir === 'asc', onSelect: () => setFilter({ dir: 'asc' }) }],
  });
  const reloadBtn = el('button', { type: 'button', class: 'btn', title: 'Reload repositories from GitHub', 'aria-label': 'Reload repositories' }, icon('sync'));

  function refreshMenuLabels() {
    const t = typeOf(filters);
    typeMenu.setLabel(t === 'all' ? 'Type' : `Type: ${TYPE_OPTIONS.find((o) => o[0] === t)[1]}`);
    langMenu.setLabel(filters.language === 'all' ? 'Language' : `Language: ${filters.language}`);
    affMenu.setLabel(filters.affiliation === 'all' ? 'Owner' : `Owner: ${AFF_OPTIONS.find((o) => o[0] === filters.affiliation)[1]}`);
    sortMenu.setLabel(`Sort: ${SORT_OPTIONS.find((o) => o[0] === filters.sort)?.[1] || 'Last pushed'}`);
  }

  const filterBar = el('div', { class: 'flex flex-wrap items-center gap-2 border-b border-border-muted pb-4' },
    searchWrap,
    el('div', { class: 'flex flex-wrap items-center gap-2' }, typeMenu.root, langMenu.root, affMenu.root, sortMenu.root, reloadBtn));

  // ---------- results line + loading banner ----------
  const resultsCount = el('strong');
  const resultsText = el('span');
  const clearFilterBtn = el('button', { type: 'button', class: 'btn-link ml-auto inline-flex items-center gap-1 text-fg-muted hover:text-accent-link' }, icon('x'), 'Clear filter');
  const resultsLine = el('div', { class: 'flex items-center gap-1 py-3 text-sm', 'aria-live': 'polite' }, resultsCount, resultsText, clearFilterBtn);

  const loadingText = el('span', { text: 'Loading repositories…' });
  const loadingBanner = el('div', { class: 'flash mb-3', role: 'status', dataset: { loadingBanner: '' } }, spinner(), loadingText);
  show(loadingBanner, false);

  // ---------- Box list ----------
  const headChk = el('input', { type: 'checkbox', 'aria-label': 'Select all repositories on this page' });
  const headCount = el('span', { class: 'text-sm font-semibold' });
  const headIdle = el('div', { class: 'flex min-w-0 flex-1 items-center gap-2' }, headCount);
  const selCount = el('span', { class: 'text-sm font-semibold' });
  const selectAllBtn = el('button', { type: 'button', class: 'btn-link text-sm' });
  const clearSelBtn = el('button', { type: 'button', class: 'btn-link text-sm' }, 'Clear selection');
  const actionsMenu = createMenu({
    label: 'Actions', ariaLabel: 'Bulk actions for selected repositories', align: 'right', buttonClass: 'btn btn-sm',
    items: () => {
      const canWrite = hasScope('repo');
      const canDelete = hasScope('delete_repo');
      const busy = loadingItems !== null;
      const w = (type, label, ic) => ({
        label, icon: ic, disabled: !canWrite || busy,
        title: busy ? 'Wait until all repositories are loaded' : canWrite ? undefined : 'Missing OAuth scope repo',
        onSelect: () => emit('bulk-action', { type }),
      });
      return [
        { header: `${formatNumber(state.selection.size)} selected` },
        w('private', 'Make private', 'lock'), w('public', 'Make public', 'globe'),
        w('archive', 'Archive', 'archive'), w('unarchive', 'Unarchive', 'archive'),
        w('topics', 'Add / remove topics', 'tag'), w('transfer', 'Transfer…', 'transfer'),
        { divider: true },
        { label: 'Delete repositories…', icon: 'trash', danger: true, disabled: !canDelete || busy,
          title: busy ? 'Wait until all repositories are loaded' : canDelete ? 'Permanently delete the selected repositories' : 'Missing OAuth scope delete_repo – sign out and in again to grant it',
          onSelect: () => emit('bulk-action', { type: 'delete' }) },
      ];
    },
  });
  const headSel = el('div', { class: 'flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1', role: 'region', 'aria-label': 'Selection actions' },
    selCount, selectAllBtn, clearSelBtn, el('span', { class: 'ml-auto' }, actionsMenu.root));
  show(headSel, false);
  const boxHeader = el('div', { class: 'Box-header' }, headChk, headIdle, headSel);

  const list = el('ul', { class: 'm-0 p-0', 'aria-label': 'Repositories' });
  const blank = el('div', { class: 'Blankslate' }, icon('repo', { size: 24 }),
    el('h3', { class: 'Blankslate-title', text: 'No repositories matched your search' }),
    el('p', { class: 'Blankslate-desc', text: 'Try a different search term or clear the filters.' }));
  show(blank, false);
  const box = el('div', { class: 'Box' }, boxHeader, list, blank);

  const pager = el('nav', { class: 'Pagination', 'aria-label': 'Pagination' });

  panel.replaceChildren(filterBar, resultsLine, loadingBanner, box, pager);

  // ---------- data ----------
  const sourceRepos = () => loadingItems || state.repos;

  function countLanguages() {
    const counts = new Map();
    for (const r of sourceRepos()) { const l = r.language || 'Unknown'; counts.set(l, (counts.get(l) || 0) + 1); }
    langCounts = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (filters.language !== 'all' && !counts.has(filters.language)) { filters.language = 'all'; refreshMenuLabels(); }
  }

  function pruneRows() {
    if (rows.size <= PAGE_SIZE * 4) return;
    const ids = new Set(sourceRepos().map((r) => r.id));
    for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
  }

  const pages = () => Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const filtersActive = () => filters.q.trim() !== '' || typeOf(filters) !== 'all' || filters.language !== 'all' || filters.affiliation !== 'all';

  // ---------- rAF scheduler ----------
  function schedule(...kinds) {
    for (const k of kinds) dirty[k] = true;
    if (kinds.includes('data')) dirty.list = true;
    if (kinds.includes('list')) dirty.sel = true;
    if (rafId || state.activeTab !== 'repos') return; // hidden: stays dirty, flushed on tab switch
    rafId = requestAnimationFrame(flush);
  }

  function flush() {
    rafId = 0;
    if (state.activeTab !== 'repos') return;
    const d = dirty;
    dirty = { data: false, langs: false, list: false, sel: false };
    if (d.langs) { countLanguages(); langMenu.refresh(); pruneRows(); }
    if (d.data) {
      filtered = applyFilters(sourceRepos(), filters, login);
      if (page > pages()) page = pages();
    }
    if (d.list || d.data) renderList();
    if (d.sel || d.list || d.data) renderSelection();
  }

  // ---------- rows ----------
  function buildRowBody(r) {
    const aff = affiliationOf(r, login);
    const link = el('a', { class: 'min-w-0 truncate text-base font-semibold', href: r.html_url, target: '_blank', rel: 'noopener noreferrer', title: r.full_name });
    if (aff === 'owner') link.textContent = r.name || r.full_name;
    else link.append(el('span', { class: 'font-normal', text: `${r.owner?.login ?? ''} / ` }), r.name || r.full_name);
    const labels = [el('span', { class: 'Label', text: r.private ? 'Private' : 'Public' })];
    if (r.is_template) labels.push(el('span', { class: 'Label', text: 'Template' }));
    if (r.fork) labels.push(el('span', { class: 'Label Label--done', text: 'Fork' }));
    if (r.archived) labels.push(el('span', { class: 'Label Label--attention', text: 'Archived' }));
    if (r.isEmpty === true) labels.push(el('span', { class: 'Label Label--danger', text: 'Empty' }));
    if (r.transferPending) labels.push(el('span', { class: 'Label Label--attention', text: `Transfer pending → ${r.transferPending}` }));
    if (r.permissions && !r.permissions.admin) labels.push(el('span', { class: 'Label', text: 'No admin', title: 'You are not an admin of this repository' }));
    if (aff !== 'owner') labels.push(el('span', { class: 'Label', text: aff === 'org' ? 'Org' : 'Collaborator' }));

    const parts = [el('div', { class: 'flex min-w-0 flex-wrap items-center gap-2' }, link, ...labels)];
    if (r.description) parts.push(el('p', { class: 'truncate-2 m-0 mt-1 text-sm text-fg-muted', text: r.description, title: r.description }));
    const topics = r.topics || [];
    if (topics.length) {
      const t = topics.slice(0, 8).map((x) => el('span', { class: 'topic', text: x }));
      if (topics.length > 8) t.push(el('span', { class: 'text-xs text-fg-muted', text: `+${topics.length - 8}`, title: topics.slice(8).join(', ') }));
      parts.push(el('div', { class: 'mt-2 flex flex-wrap gap-1' }, ...t));
    }
    const meta = [];
    if (r.language) meta.push(el('span', { class: 'inline-flex items-center gap-1' }, langDot(r.language), r.language));
    if (r.stargazers_count) meta.push(el('span', { class: 'inline-flex items-center gap-1', title: 'Stars' }, icon('star'), formatNumber(r.stargazers_count)));
    if (r.forks_count) meta.push(el('span', { class: 'inline-flex items-center gap-1', title: 'Forks' }, icon('fork'), formatNumber(r.forks_count)));
    meta.push(el('span', { title: 'Repository size' }, formatBytesFromKB(r.size)));
    const when = r.updated_at || r.pushed_at;
    meta.push(el('span', { title: when ? `Updated ${new Date(when).toLocaleString()} · pushed ${formatDate(r.pushed_at)}` : '' }, `Updated ${relativeTime(when)}`));
    parts.push(el('div', { class: 'mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted' }, ...meta));
    return parts;
  }

  function rowFor(r) {
    let entry = rows.get(r.id);
    const sig = rowSig(r);
    if (!entry) {
      const chk = el('input', { type: 'checkbox', class: 'mt-1 shrink-0', dataset: { role: 'select' } });
      const body = el('div', { class: 'min-w-0 flex-1' });
      const li = el('li', { class: 'Box-row Box-row--hover list-row flex gap-3', dataset: { id: String(r.id) } }, chk, body);
      entry = { li, chk, body, sig: '' };
      rows.set(r.id, entry);
    }
    if (entry.sig !== sig) {
      entry.body.replaceChildren(...buildRowBody(r));
      entry.chk.setAttribute('aria-label', `Select ${r.full_name}`);
      entry.sig = sig;
    }
    return entry;
  }

  function renderList() {
    const items = pageItems();
    const frag = document.createDocumentFragment();
    for (const r of items) frag.append(rowFor(r).li);
    list.replaceChildren(frag);
    const loaded = state.reposLoaded || loadingItems !== null;
    show(blank, items.length === 0 && loaded && loadingItems === null);
    show(list, items.length > 0);
    // results line
    const n = filtered.length;
    resultsCount.textContent = `${formatNumber(n)} ${n === 1 ? 'repository' : 'repositories'}`;
    resultsText.textContent = filtersActive() ? ' matching filters' : '';
    show(clearFilterBtn, filtersActive());
    show(resultsLine, loaded);
    headCount.textContent = loadingItems ? `${formatNumber(sourceRepos().length)} loaded so far…` : `${formatNumber(n)} ${n === 1 ? 'repository' : 'repositories'}`;
    renderPager();
  }

  function renderPager() {
    const total = pages();
    show(pager, total > 1);
    if (total <= 1) { pager.replaceChildren(); return; }
    const btn = (label, p, { disabled = false, current = false, aria } = {}) => {
      const b = el('button', { type: 'button', class: 'Pagination-item', 'aria-label': aria, dataset: { page: String(p) } });
      if (label === 'prev') b.append(icon('chevron-left'), el('span', { class: 'hidden sm:inline', text: 'Previous' }));
      else if (label === 'next') b.append(el('span', { class: 'hidden sm:inline', text: 'Next' }), icon('chevron-right'));
      else b.textContent = label;
      if (disabled) b.disabled = true;
      if (current) b.setAttribute('aria-current', 'page');
      return b;
    };
    const nums = new Set([1, total, page - 1, page, page + 1]);
    if (page <= 3) [2, 3, 4].forEach((x) => nums.add(x));
    if (page >= total - 2) [total - 1, total - 2, total - 3].forEach((x) => nums.add(x));
    const seq = [...nums].filter((x) => x >= 1 && x <= total).sort((a, b) => a - b);
    const out = [btn('prev', page - 1, { disabled: page <= 1, aria: 'Previous page' })];
    let prev = 0;
    for (const x of seq) {
      if (x - prev > 1) out.push(el('span', { class: 'Pagination-gap', 'aria-hidden': 'true', text: '…' }));
      out.push(btn(String(x), x, { current: x === page, aria: `Page ${x}` }));
      prev = x;
    }
    out.push(btn('next', page + 1, { disabled: page >= total, aria: 'Next page' }));
    pager.replaceChildren(...out);
  }

  // ---------- selection (patch only visible rows + header) ----------
  function renderSelection() {
    const sel = state.selection;
    const items = pageItems();
    let onPage = 0;
    for (const r of items) {
      const entry = rows.get(r.id);
      if (!entry) continue;
      const s = sel.has(r.id);
      if (s) onPage++;
      if (entry.chk.checked !== s) entry.chk.checked = s;
      entry.li.classList.toggle('is-selected', s);
    }
    headChk.checked = items.length > 0 && onPage === items.length;
    headChk.indeterminate = onPage > 0 && onPage < items.length;
    headChk.disabled = items.length === 0;
    const n = sel.size;
    show(headIdle, n === 0);
    show(headSel, n > 0);
    if (n > 0) {
      selCount.textContent = `${formatNumber(n)} selected`;
      let all = filtered.length > 0;
      for (const r of filtered) if (!sel.has(r.id)) { all = false; break; }
      selectAllBtn.textContent = `Select all ${formatNumber(filtered.length)} matching`;
      show(selectAllBtn, !all && filtered.length > n - 0);
      actionsMenu.refresh();
    }
  }

  // ---------- events (delegated) ----------
  list.addEventListener('click', (ev) => {
    const chk = ev.target.closest?.('input[data-role="select"]');
    if (!chk) return;
    const id = Number(chk.closest('li').dataset.id);
    const checked = chk.checked;
    if (ev.shiftKey && lastClickedId !== null && lastClickedId !== id) {
      const items = pageItems();
      const a = items.findIndex((x) => x.id === lastClickedId);
      const b = items.findIndex((x) => x.id === id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const next = new Set(state.selection);
        for (let i = lo; i <= hi; i++) { if (checked) next.add(items[i].id); else next.delete(items[i].id); }
        lastClickedId = id;
        setSelection(next);
        return;
      }
    }
    lastClickedId = id;
    toggleSelected(id, checked);
  });
  pager.addEventListener('click', (ev) => {
    const b = ev.target.closest?.('button[data-page]');
    if (!b || b.disabled) return;
    page = Math.min(pages(), Math.max(1, Number(b.dataset.page)));
    schedule('list');
    box.scrollIntoView({ block: 'start' });
  });
  const onSearch = debounce(() => { if (filters.q !== search.value) setFilter({ q: search.value }); }, 120);
  search.addEventListener('input', onSearch);
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; setFilter({ q: '' }); } });
  clearFilterBtn.addEventListener('click', () => {
    search.value = '';
    setFilter({ q: '', ...DEFAULTS, language: 'all', affiliation: 'all' });
    search.focus();
  });
  headChk.addEventListener('change', () => {
    const next = new Set(state.selection);
    for (const r of pageItems()) { if (headChk.checked) next.add(r.id); else next.delete(r.id); }
    setSelection(next);
  });
  selectAllBtn.addEventListener('click', () => {
    const next = new Set(state.selection);
    for (const r of filtered) next.add(r.id);
    setSelection(next);
    toastInfo(`Selected ${formatNumber(filtered.length)} repositories`);
  });
  clearSelBtn.addEventListener('click', () => { clearSelection(); headChk.focus(); });
  reloadBtn.addEventListener('click', () => load());

  on('repos', () => schedule('data', 'langs'));
  on('selection', () => schedule('sel'));
  on('tab', (tab) => { if (tab === 'repos' && (dirty.data || dirty.list || dirty.sel || dirty.langs)) schedule(); });

  // ---------- loading (progressive) ----------
  let progressPending = false;
  async function load() {
    reloadBtn.disabled = true;
    loadingText.textContent = 'Loading repositories…';
    show(loadingBanner, true);
    clearSelection();
    loadingItems = [];
    schedule('data', 'langs');
    try {
      await loadAllRepos(({ page: p, count, active, items }) => {
        loadingItems = active ? items : null;
        loadingText.textContent = active ? `Loaded ${formatNumber(count)} repositories (page ${p}) — more on the way…` : `Loaded ${formatNumber(count)} repositories`;
        // First page renders immediately; later pages only refresh counts/menu once per frame.
        if (p === 1 || !progressPending) {
          progressPending = true;
          requestAnimationFrame(() => { progressPending = false; });
          schedule('data', 'langs');
        }
      });
    } catch (err) {
      if (err?.name !== 'AbortError') toastError(describeError(err));
    } finally {
      loadingItems = null;
      show(loadingBanner, false);
      reloadBtn.disabled = false;
      schedule('data', 'langs');
    }
  }

  refreshMenuLabels();
  schedule('data', 'langs');
  load();
  return { reload: load };
}
