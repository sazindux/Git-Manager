// Repository grid: loads all pages, search/filter/sort, client pagination, selection with shift-click.
import { el, clear, show, formatNumber, formatBytesFromKB, formatDate, debounce } from './ui.js';
import { get, describeError } from './api.js';
import { state, on, emit, setRepos, setSelection, toggleSelected, clearSelection } from './state.js';
import { error as toastError, info as toastInfo } from './toast.js';

const PAGE_SIZE = 50;

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
    if (q) {
      const hay = `${r.full_name}\n${r.description || ''}\n${(r.topics || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const dir = f.dir === 'asc' ? 1 : -1;
  const key = {
    name: (r) => r.full_name.toLowerCase(),
    stars: (r) => r.stargazers_count ?? 0,
    forks: (r) => r.forks_count ?? 0,
    size: (r) => r.size ?? 0,
    pushed: (r) => r.pushed_at || '',
  }[f.sort] || ((r) => r.pushed_at || '');
  out.sort((a, b) => {
    const ka = key(a); const kb = key(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return a.full_name.localeCompare(b.full_name);
  });
  return out;
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
    onProgress?.(state.loading);
    p += 1;
    if (p > 200) break; // 20k repos safety valve
  }
  state.loading.active = false;
  setRepos(all);
  return all;
}

// --- UI -------------------------------------------------------------------------------------

export function initGrid(panel) {
  clear(panel);
  panel.classList.remove('p-5');
  panel.classList.add('p-0', 'overflow-hidden');

  // Loading banner
  const progressBar = el('div', { class: 'progress-bar w-0' });
  const progressText = el('span', { class: 'text-sm text-slate-300', text: 'Loading repositories…' });
  const loadingBox = el('div', { class: 'space-y-2 border-b border-white/10 p-4', role: 'status' },
    el('div', { class: 'flex items-center justify-between gap-3' }, progressText,
      el('span', { class: 'h-2 w-2 animate-pulse rounded-full bg-sky-400', 'aria-hidden': 'true' })),
    el('div', { class: 'progress' }, progressBar));

  // Toolbar
  const search = el('input', {
    class: 'input', type: 'search', placeholder: 'Search name, description, topics…',
    'aria-label': 'Search repositories', autocomplete: 'off',
  });
  const mkSelect = (label, name, options) => {
    const sel = el('select', { class: 'input py-1.5', 'aria-label': label, dataset: { filter: name } },
      ...options.map(([v, t]) => el('option', { value: v, text: t })));
    sel.value = filters[name];
    return sel;
  };
  const selVisibility = mkSelect('Visibility', 'visibility', [['all', 'Public + private'], ['public', 'Public'], ['private', 'Private']]);
  const selKind = mkSelect('Fork or source', 'kind', [['all', 'Forks + sources'], ['source', 'Sources'], ['fork', 'Forks']]);
  const selArchived = mkSelect('Archived', 'archived', [['all', 'Active + archived'], ['active', 'Active'], ['archived', 'Archived']]);
  const selAffiliation = mkSelect('Affiliation', 'affiliation', [['all', 'All affiliations'], ['owner', 'Owned by me'], ['collaborator', 'Collaborator'], ['org', 'Organization']]);
  const selLanguage = mkSelect('Language', 'language', [['all', 'All languages']]);
  const selSort = mkSelect('Sort by', 'sort', [['pushed', 'Last push'], ['name', 'Name'], ['stars', 'Stars'], ['forks', 'Forks'], ['size', 'Size']]);
  const dirBtn = el('button', { type: 'button', class: 'btn-ghost py-1.5', 'aria-label': 'Toggle sort direction', title: 'Sort direction' }, '↓');
  const emptyChk = el('input', { type: 'checkbox', class: 'h-4 w-4 rounded accent-sky-400' });
  const emptyLabel = el('label', { class: 'flex items-center gap-2 text-sm text-slate-300 whitespace-nowrap' }, emptyChk, 'Empty only');
  const reloadBtn = el('button', { type: 'button', class: 'btn-ghost py-1.5', title: 'Reload repositories from GitHub' }, 'Reload');
  const countText = el('span', { class: 'text-sm text-slate-400', 'aria-live': 'polite' });

  const toolbar = el('div', { class: 'space-y-3 border-b border-white/10 p-4' },
    el('div', { class: 'flex flex-wrap items-center gap-2' },
      el('div', { class: 'min-w-[14rem] flex-1' }, search),
      selSort, dirBtn, reloadBtn),
    el('div', { class: 'flex flex-wrap items-center gap-2' },
      selVisibility, selKind, selArchived, selAffiliation, selLanguage, emptyLabel,
      el('span', { class: 'ml-auto' }, countText)));

  // Selection bar
  const selCount = el('span', { class: 'font-medium text-slate-100' });
  const selectFilteredBtn = el('button', { type: 'button', class: 'btn-ghost py-1.5' });
  const clearSelBtn = el('button', { type: 'button', class: 'btn-ghost py-1.5', onClick: () => clearSelection() }, 'Clear');
  const actionBtn = (type, label, cls = 'btn-ghost') =>
    el('button', { type: 'button', class: `${cls} py-1.5`, dataset: { action: type }, onClick: () => emit('bulk-action', { type }) }, label);
  const actionButtons = [
    actionBtn('private', 'Make private'),
    actionBtn('public', 'Make public', 'btn-warn'),
    actionBtn('archive', 'Archive'),
    actionBtn('unarchive', 'Unarchive'),
    actionBtn('topics', 'Topics'),
    actionBtn('transfer', 'Transfer'),
    actionBtn('delete', 'Delete', 'btn-danger'),
  ];
  const selectionBar = el('div', {
    class: 'sticky top-[3.6rem] z-20 flex flex-wrap items-center gap-2 border-b border-sky-400/30 bg-ink-900/90 px-4 py-2 backdrop-blur-xl md:top-[3.6rem]',
    role: 'region', 'aria-label': 'Selection actions',
  }, el('span', { class: 'text-sm text-slate-300' }, selCount, ' selected'), selectFilteredBtn, clearSelBtn,
  el('div', { class: 'ml-auto flex flex-wrap gap-2' }, ...actionButtons));
  show(selectionBar, false);

  // Table
  const headChk = el('input', { type: 'checkbox', class: 'h-4 w-4 rounded accent-sky-400', 'aria-label': 'Select all on this page' });
  const th = (text, cls = '') => el('th', { scope: 'col', class: `px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 ${cls}` }, text);
  const tbody = el('tbody', { class: 'divide-y divide-white/5' });
  const table = el('table', { class: 'w-full min-w-[56rem] text-sm' },
    el('thead', { class: 'bg-white/5' }, el('tr', {},
      el('th', { scope: 'col', class: 'w-10 px-3 py-2' }, headChk),
      th('Repository'), th('Status'), th('Language'), th('Stars', 'text-right'), th('Forks', 'text-right'),
      th('Size', 'text-right'), th('Pushed'))),
    tbody);
  const tableWrap = el('div', { class: 'overflow-x-auto' }, table);
  const emptyState = el('p', { class: 'p-8 text-center text-slate-400', text: 'No repositories match the current filters.' });
  show(emptyState, false);

  // Pagination
  const prevBtn = el('button', { type: 'button', class: 'btn-ghost py-1.5', onClick: () => { page -= 1; renderRows(); } }, 'Previous');
  const nextBtn = el('button', { type: 'button', class: 'btn-ghost py-1.5', onClick: () => { page += 1; renderRows(); } }, 'Next');
  const pageText = el('span', { class: 'text-sm text-slate-400' });
  const pager = el('div', { class: 'flex items-center justify-between gap-3 border-t border-white/10 p-3' }, pageText,
    el('div', { class: 'flex gap-2' }, prevBtn, nextBtn));

  panel.append(loadingBox, toolbar, selectionBar, tableWrap, emptyState, pager);

  // --- behaviour ---
  const login = state.user?.login;

  function recompute() {
    filtered = applyFilters(state.repos, filters, login);
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    countText.textContent = `${formatNumber(filtered.length)} of ${formatNumber(state.repos.length)} repositories`;
    renderRows();
    renderSelection();
  }

  function pageItems() {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }

  function renderRows() {
    clear(tbody);
    const items = pageItems();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    show(emptyState, items.length === 0 && state.reposLoaded);
    show(tableWrap, items.length > 0);
    for (const r of items) tbody.append(renderRow(r));
    const start = filtered.length ? (page - 1) * PAGE_SIZE + 1 : 0;
    const end = Math.min(page * PAGE_SIZE, filtered.length);
    pageText.textContent = `Showing ${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(filtered.length)} · Page ${page} of ${pages}`;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= pages;
    syncHeadCheckbox();
  }

  function renderRow(r) {
    const chk = el('input', {
      type: 'checkbox', class: 'h-4 w-4 rounded accent-sky-400', dataset: { id: String(r.id) },
      'aria-label': `Select ${r.full_name}`,
    });
    chk.checked = state.selection.has(r.id);
    chk.addEventListener('click', (ev) => onRowCheckboxClick(ev, r.id, chk.checked));

    const badges = [];
    badges.push(el('span', { class: r.private ? 'badge' : 'badge-ok', text: r.private ? 'Private' : 'Public' }));
    if (r.fork) badges.push(el('span', { class: 'badge', text: 'Fork' }));
    if (r.archived) badges.push(el('span', { class: 'badge-warn', text: 'Archived' }));
    if (r.is_template) badges.push(el('span', { class: 'badge', text: 'Template' }));
    if (r.isEmpty === true) badges.push(el('span', { class: 'badge-danger', text: 'Empty' }));
    if (r.transferPending) badges.push(el('span', { class: 'badge-warn', text: `Transfer pending → ${r.transferPending}` }));
    if (r.permissions && !r.permissions.admin) badges.push(el('span', { class: 'badge', text: 'No admin', title: 'You are not an admin of this repository' }));
    const aff = affiliationOf(r, login);
    if (aff !== 'owner') badges.push(el('span', { class: 'badge', text: aff === 'org' ? 'Org' : 'Collab' }));

    const topics = (r.topics || []).slice(0, 6).map((t) => el('span', { class: 'badge text-[10px]', text: t }));
    if ((r.topics || []).length > 6) topics.push(el('span', { class: 'text-xs text-slate-500', text: `+${r.topics.length - 6}` }));

    const link = el('a', {
      class: 'font-medium text-sky-300 hover:underline', href: r.html_url, target: '_blank', rel: 'noopener noreferrer',
    });
    link.textContent = r.full_name;

    const tr = el('tr', { class: 'hover:bg-white/5', dataset: { id: String(r.id) } },
      el('td', { class: 'px-3 py-2 align-top' }, chk),
      el('td', { class: 'px-3 py-2 align-top' },
        el('div', { class: 'flex flex-col gap-1' }, link,
          r.description ? el('p', { class: 'max-w-xl truncate text-xs text-slate-400', text: r.description, title: r.description }) : null,
          topics.length ? el('div', { class: 'flex flex-wrap gap-1' }, ...topics) : null)),
      el('td', { class: 'px-3 py-2 align-top' }, el('div', { class: 'flex flex-wrap gap-1' }, ...badges)),
      el('td', { class: 'px-3 py-2 align-top text-slate-300', text: r.language || '—' }),
      el('td', { class: 'px-3 py-2 align-top text-right tabular-nums text-slate-300', text: formatNumber(r.stargazers_count) }),
      el('td', { class: 'px-3 py-2 align-top text-right tabular-nums text-slate-300', text: formatNumber(r.forks_count) }),
      el('td', { class: 'px-3 py-2 align-top text-right tabular-nums text-slate-300', text: formatBytesFromKB(r.size) }),
      el('td', { class: 'px-3 py-2 align-top whitespace-nowrap text-slate-300', text: formatDate(r.pushed_at), title: r.pushed_at || '' }));
    if (state.selection.has(r.id)) tr.classList.add('bg-sky-500/10');
    return tr;
  }

  function onRowCheckboxClick(ev, id, checked) {
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
  }

  function syncHeadCheckbox() {
    const items = pageItems();
    const selectedOnPage = items.filter((r) => state.selection.has(r.id)).length;
    headChk.checked = items.length > 0 && selectedOnPage === items.length;
    headChk.indeterminate = selectedOnPage > 0 && selectedOnPage < items.length;
    headChk.disabled = items.length === 0;
  }

  function renderSelection() {
    const n = state.selection.size;
    show(selectionBar, n > 0);
    selCount.textContent = formatNumber(n);
    const allFilteredSelected = filtered.length > 0 && filtered.every((r) => state.selection.has(r.id));
    selectFilteredBtn.textContent = `Select all ${formatNumber(filtered.length)} matching`;
    selectFilteredBtn.disabled = allFilteredSelected || filtered.length === 0;
    for (const tr of tbody.children) {
      const id = Number(tr.dataset.id);
      const sel = state.selection.has(id);
      tr.classList.toggle('bg-sky-500/10', sel);
      const chk = tr.querySelector('input[type=checkbox]');
      if (chk) chk.checked = sel;
    }
    syncHeadCheckbox();
  }

  function populateLanguages() {
    const counts = new Map();
    for (const r of state.repos) {
      const l = r.language || 'Unknown';
      counts.set(l, (counts.get(l) || 0) + 1);
    }
    const current = selLanguage.value;
    clear(selLanguage);
    selLanguage.append(el('option', { value: 'all', text: 'All languages' }));
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([l, n]) => selLanguage.append(el('option', { value: l, text: `${l} (${n})` })));
    selLanguage.value = counts.has(current) || current === 'all' ? current : 'all';
    filters.language = selLanguage.value;
  }

  // Events
  search.addEventListener('input', debounce(() => { filters.q = search.value; page = 1; recompute(); }, 120));
  for (const sel of [selVisibility, selKind, selArchived, selAffiliation, selLanguage, selSort]) {
    sel.addEventListener('change', () => { filters[sel.dataset.filter] = sel.value; page = 1; recompute(); });
  }
  dirBtn.addEventListener('click', () => {
    filters.dir = filters.dir === 'asc' ? 'desc' : 'asc';
    dirBtn.textContent = filters.dir === 'asc' ? '↑' : '↓';
    page = 1; recompute();
  });
  emptyChk.addEventListener('change', () => { filters.emptyOnly = emptyChk.checked; page = 1; recompute(); });
  headChk.addEventListener('change', () => {
    const next = new Set(state.selection);
    for (const r of pageItems()) { if (headChk.checked) next.add(r.id); else next.delete(r.id); }
    setSelection(next);
  });
  selectFilteredBtn.addEventListener('click', () => {
    const next = new Set(state.selection);
    for (const r of filtered) next.add(r.id);
    setSelection(next);
    toastInfo(`Selected ${formatNumber(filtered.length)} repositories`);
  });
  reloadBtn.addEventListener('click', () => load());

  on('repos', () => { populateLanguages(); recompute(); });
  on('selection', renderSelection);

  async function load() {
    reloadBtn.disabled = true;
    show(loadingBox, true);
    progressBar.style.width = '0%';
    progressText.textContent = 'Loading repositories…';
    clearSelection();
    try {
      await loadAllRepos(({ page: p, count, active }) => {
        progressText.textContent = `Loaded ${formatNumber(count)} repositories (page ${p})…`;
        // Unknown total: ease towards 90% until done.
        progressBar.style.width = active ? `${Math.min(90, 100 - 100 / (p + 1))}%` : '100%';
      });
    } catch (err) {
      if (err?.name !== 'AbortError') toastError(describeError(err));
    } finally {
      show(loadingBox, false);
      reloadBtn.disabled = false;
    }
  }

  recompute();
  load();
  return { reload: load };
}
