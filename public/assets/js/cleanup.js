// Cleanup tools: Forks, Empty repos, Branches. All GitHub strings are rendered via textContent.
import { el, clear, show, formatNumber, formatBytesFromKB, formatDate } from './ui.js';
import { get, del, describeError } from './api.js';
import { state, on, emit, hasScope, removeRepos } from './state.js';
import { runBulk, writeOptions, readOptions, BulkPanel } from './bulk.js';
import { confirmDelete, confirmSimple } from './modals.js';
import { success, info, error as toastError } from './toast.js';

const repoPath = (r) => `/api/repos/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}`;
const plural = (n, one, many) => (n === 1 ? one : many);
const DEFAULT_STALE_DAYS = 90;

// UI-side mirror of lib/branches.js: default/protected branches are never deletable.
export function isBranchDeletable(b) {
  return !!b && !b.isDefault && !b.protected && b.deletable !== false;
}

let bulkPanel = null;
let progressHost = null;

export function initCleanup(section) {
  clear(section);
  progressHost = el('div', { hidden: true });
  bulkPanel = new BulkPanel(progressHost);
  const tabs = [
    { id: 'forks', label: 'Forks', mount: mountForks },
    { id: 'empty', label: 'Empty repos', mount: mountEmpty },
    { id: 'branches', label: 'Branches', mount: mountBranches },
  ];
  const body = el('div', { class: 'glass p-5' });
  const nav = el('div', { class: 'flex flex-wrap gap-2', role: 'tablist', 'aria-label': 'Cleanup tools' });
  let active = null;
  const activate = (t) => {
    active = t.id;
    for (const b of nav.children) b.setAttribute('aria-selected', String(b.dataset.tab === t.id));
    clear(body);
    t.mount(body);
  };
  for (const t of tabs) {
    nav.append(el('button', {
      type: 'button', role: 'tab', class: 'btn-ghost py-1.5 aria-selected:bg-sky-500/20 aria-selected:border-sky-400/40',
      dataset: { tab: t.id }, 'aria-selected': 'false', onClick: () => activate(t),
    }, t.label));
  }
  section.append(nav, progressHost, body);
  activate(tabs[0]);
  // Re-render the active tab when the repo list changes (deletes, reload) so lists stay accurate.
  on('repos', () => { const t = tabs.find((x) => x.id === active); if (t && !bulkRunning) { clear(body); t.mount(body); } });
}

let bulkRunning = false;
async function runWithPanel(spec) {
  bulkRunning = true;
  try { return await bulkPanel.run(spec); } finally { bulkRunning = false; emit('repos', state.repos); }
}

function deleteDisabledReason() {
  if (!hasScope('delete_repo')) return 'Missing OAuth scope delete_repo – sign out and in again to grant it';
  return '';
}

function emptyState(text) {
  return el('p', { class: 'text-slate-400', text });
}

// --- generic selectable repo table ------------------------------------------------------------

function repoTable({ repos, selected, extraCols = [], onChange }) {
  const allChk = el('input', { type: 'checkbox', class: 'h-4 w-4 rounded accent-sky-400', 'aria-label': 'Select all listed' });
  const sync = () => {
    allChk.checked = repos.length > 0 && repos.every((r) => selected.has(r.id));
    allChk.indeterminate = !allChk.checked && repos.some((r) => selected.has(r.id));
    onChange();
  };
  allChk.addEventListener('change', () => { for (const r of repos) { if (allChk.checked) selected.add(r.id); else selected.delete(r.id); } for (const c of tbody.querySelectorAll('input')) c.checked = allChk.checked; sync(); });
  const th = (t, cls = '') => el('th', { class: `px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400 ${cls}`, text: t });
  const tbody = el('tbody', { class: 'divide-y divide-white/5' });
  for (const r of repos) {
    const chk = el('input', { type: 'checkbox', class: 'h-4 w-4 rounded accent-sky-400', 'aria-label': `Select ${r.full_name}` });
    chk.checked = selected.has(r.id);
    chk.addEventListener('change', () => { if (chk.checked) selected.add(r.id); else selected.delete(r.id); sync(); });
    tbody.append(el('tr', { class: 'hover:bg-white/5' },
      el('td', { class: 'px-3 py-2' }, chk),
      el('td', { class: 'px-3 py-2' },
        el('a', { href: r.html_url, target: '_blank', rel: 'noopener noreferrer', class: 'font-medium text-sky-300 hover:underline', text: r.full_name }),
        r.description ? el('p', { class: 'truncate text-xs text-slate-400 max-w-md', text: r.description, title: r.description }) : null),
      el('td', { class: 'px-3 py-2 text-xs' },
        el('span', { class: r.private ? 'badge-warn' : 'badge', text: r.private ? 'private' : 'public' }), ' ',
        r.archived ? el('span', { class: 'badge', text: 'archived' }) : null),
      ...extraCols.map((col) => el('td', { class: 'px-3 py-2 text-sm text-slate-300 whitespace-nowrap' }, col(r)))));
  }
  const table = el('div', { class: 'overflow-x-auto rounded-lg border border-white/10' },
    el('table', { class: 'min-w-full text-sm' },
      el('thead', { class: 'bg-white/5' }, el('tr', {}, el('th', { class: 'px-3 py-2' }, allChk), th('Repository'), th('Status'), ...extraCols.map((c) => th(c.title || '')))),
      tbody));
  sync();
  return table;
}

function deleteBar({ selected, label, onDelete }) {
  const btn = el('button', { type: 'button', class: 'btn-danger py-1.5', onClick: onDelete });
  const count = el('span', { class: 'text-sm text-slate-300', 'aria-live': 'polite' });
  const bar = el('div', { class: 'flex flex-wrap items-center gap-3' }, count, btn);
  const update = () => {
    const n = selected.size;
    count.textContent = `${formatNumber(n)} selected`;
    const reason = deleteDisabledReason();
    btn.disabled = n === 0 || !!reason;
    btn.title = reason || '';
    btn.textContent = `${label} ${formatNumber(n)} ${plural(n, 'repository', 'repositories')}`;
  };
  update();
  return { bar, update };
}

async function deleteRepos(repos, actionLabel) {
  if (deleteDisabledReason()) return info(deleteDisabledReason());
  const ok = await confirmDelete(repos);
  if (!ok) return;
  await runWithPanel({
    title: actionLabel, action: 'cleanup-delete', items: repos, options: writeOptions(),
    perItemFn: (r, { signal }) => del(repoPath(r), { signal }),
    onItemOk: (r) => removeRepos([r.id]),
    onFinish: ({ results, cancelled }) => {
      const ok = results.filter((r) => r.status === 'ok').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      if (ok) success(`Deleted ${formatNumber(ok)} ${plural(ok, 'repository', 'repositories')}${failed ? `, ${failed} failed` : ''}${cancelled ? ' (cancelled)' : ''}`);
      else if (failed) info(`Delete: all ${failed} failed – see the progress panel`);
    },
  });
}

// --- Forks ------------------------------------------------------------------------------------

const forkSelection = new Set();
function mountForks(body) {
  const forks = state.repos.filter((r) => r.fork);
  for (const id of forkSelection) if (!forks.some((r) => r.id === id)) forkSelection.delete(id);
  body.append(el('div', { class: 'mb-4 space-y-1' },
    el('h2', { class: 'text-lg font-semibold', text: 'Forked repositories' }),
    el('p', { class: 'text-sm text-slate-400', text: `${formatNumber(forks.length)} of ${formatNumber(state.repos.length)} loaded repositories are forks. Forks you no longer contribute to can usually be deleted safely – your pull requests on the upstream repository stay intact, but any unpushed or unmerged commits on the fork are lost.` })));
  if (!state.reposLoaded) return body.append(emptyState('Repositories are still loading…'));
  if (!forks.length) return body.append(emptyState('No forks found.'));
  const { bar, update } = deleteBar({ selected: forkSelection, label: 'Delete', onDelete: () => deleteRepos(forks.filter((r) => forkSelection.has(r.id)), 'Delete forks') });
  body.append(bar, el('div', { class: 'mt-3' }, repoTable({
    repos: forks, selected: forkSelection, onChange: update,
    extraCols: [
      Object.assign((r) => `${formatNumber(r.stargazers_count || 0)} ★`, { title: 'Stars' }),
      Object.assign((r) => formatDate(r.pushed_at), { title: 'Last push' }),
      Object.assign((r) => formatBytesFromKB(r.size), { title: 'Size' }),
    ],
  })));
}

// --- Empty repos ------------------------------------------------------------------------------

const emptySelection = new Set();
let emptyScan = { running: false, done: 0, total: 0, scanned: false };

function mountEmpty(body) {
  const candidates = state.repos.filter((r) => (r.size ?? 0) === 0 || r.isEmpty === true);
  const confirmed = state.repos.filter((r) => r.isEmpty === true);
  for (const id of emptySelection) if (!confirmed.some((r) => r.id === id)) emptySelection.delete(id);

  const scanBtn = el('button', { type: 'button', class: 'btn-primary py-1.5' }, emptyScan.scanned ? 'Rescan' : 'Scan for empty repositories');
  const status = el('p', { class: 'text-sm text-slate-400', role: 'status' });
  const barEl = el('div', { class: 'progress-bar w-0' });
  const progress = el('div', { class: 'progress', hidden: true, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(candidates.length) }, barEl);
  const includeAll = el('input', { type: 'checkbox', class: 'h-4 w-4 rounded accent-sky-400' });
  const setStatus = () => {
    if (emptyScan.running) status.textContent = `Scanning ${formatNumber(emptyScan.done)} / ${formatNumber(emptyScan.total)}…`;
    else if (emptyScan.scanned) status.textContent = `Scan complete: ${formatNumber(confirmed.length)} empty ${plural(confirmed.length, 'repository', 'repositories')} confirmed by GitHub.`;
    else status.textContent = `${formatNumber(candidates.length)} ${plural(candidates.length, 'repository reports', 'repositories report')} size 0 (cheap pre-filter). Run a scan to confirm emptiness via the GitHub commits API.`;
  };
  setStatus();

  scanBtn.addEventListener('click', async () => {
    const targets = includeAll.checked ? state.repos.slice() : candidates;
    if (!targets.length) return info('Nothing to scan');
    emptyScan = { running: true, done: 0, total: targets.length, scanned: false };
    scanBtn.disabled = true; show(progress, true); progress.setAttribute('aria-valuemax', String(targets.length)); setStatus();
    const controller = new AbortController();
    const cancel = el('button', { type: 'button', class: 'btn-ghost py-1.5', onClick: () => controller.abort() }, 'Cancel scan');
    scanBtn.after(cancel);
    try {
      bulkRunning = true;
      await runBulk(targets, async (r, { signal }) => {
        const res = await get(`${repoPath(r)}/empty-check`, { signal });
        r.isEmpty = !!res.empty; // mutate in place; single `repos` emit after the scan
        return res;
      }, { ...readOptions(), signal: controller.signal, onProgress: ({ done, total }) => { emptyScan.done = done; barEl.style.width = `${Math.round((done / total) * 100)}%`; progress.setAttribute('aria-valuenow', String(done)); setStatus(); } });
    } catch (e) {
      toastError(describeError(e));
    } finally {
      bulkRunning = false;
      emptyScan = { ...emptyScan, running: false, scanned: true };
      cancel.remove();
      emit('repos', state.repos); // grid "Empty only" filter + this tab re-render
    }
  });

  body.append(el('div', { class: 'mb-4 space-y-1' },
    el('h2', { class: 'text-lg font-semibold', text: 'Empty repositories' }),
    el('p', { class: 'text-sm text-slate-400', text: 'A repository is empty when GitHub reports it has no commits. Size alone is not reliable, so each candidate is verified with one API call (4 in parallel).' })),
    el('div', { class: 'flex flex-wrap items-center gap-3' }, scanBtn,
      el('label', { class: 'flex items-center gap-2 text-sm text-slate-300' }, includeAll, 'Scan all repositories (slower)')),
    el('div', { class: 'mt-3 space-y-2' }, status, progress));

  if (!confirmed.length) {
    if (emptyScan.scanned) body.append(el('p', { class: 'mt-4 text-slate-400', text: 'No empty repositories found.' }));
    return;
  }
  const { bar, update } = deleteBar({ selected: emptySelection, label: 'Delete', onDelete: () => deleteRepos(confirmed.filter((r) => emptySelection.has(r.id)), 'Delete empty repositories') });
  body.append(el('div', { class: 'mt-4' }, bar), el('div', { class: 'mt-3' }, repoTable({
    repos: confirmed, selected: emptySelection, onChange: update,
    extraCols: [Object.assign((r) => formatDate(r.updated_at), { title: 'Updated' })],
  })));
}

// --- Branches ---------------------------------------------------------------------------------

const branchRepoSelection = new Set();
const branchSelection = new Set(); // keys `${repoId}\u0000${branch}`
let branchResults = new Map(); // repoId → { repo, defaultBranch, branches, error }
let staleDays = DEFAULT_STALE_DAYS;
let branchFilter = 'candidates'; // candidates | merged | stale | all
let repoQuery = '';
const keyOf = (repoId, name) => `${repoId}\u0000${name}`;

function mountBranches(body) {
  const repos = state.repos.filter((r) => !r.archived && (r.permissions?.push || r.permissions?.admin));
  for (const id of branchRepoSelection) if (!repos.some((r) => r.id === id)) branchRepoSelection.delete(id);

  body.append(el('div', { class: 'mb-4 space-y-1' },
    el('h2', { class: 'text-lg font-semibold', text: 'Branch cleanup' }),
    el('p', { class: 'text-sm text-slate-400', text: 'Pick repositories, scan their branches, then delete merged (0 commits ahead of the default branch) or stale ones. Default and protected branches are never offered.' })));

  // Repo picker
  const search = el('input', { class: 'input py-1.5', type: 'search', placeholder: 'Filter repositories…', 'aria-label': 'Filter repositories', autocomplete: 'off' });
  search.value = repoQuery;
  const list = el('ul', { class: 'max-h-56 overflow-y-auto rounded-lg border border-white/10 divide-y divide-white/5 text-sm', 'aria-label': 'Repositories to scan' });
  const pickCount = el('span', { class: 'text-sm text-slate-300', 'aria-live': 'polite' });
  const daysInput = el('input', { class: 'input w-24 py-1.5', type: 'number', min: '1', max: '36500', step: '1', 'aria-label': 'Stale after days' });
  daysInput.value = String(staleDays);
  const scanBtn = el('button', { type: 'button', class: 'btn-primary py-1.5' }, 'Scan branches');
  const renderList = () => {
    clear(list);
    const q = repoQuery.toLowerCase();
    const shown = repos.filter((r) => !q || r.full_name.toLowerCase().includes(q)).slice(0, 300);
    for (const r of shown) {
      const chk = el('input', { type: 'checkbox', class: 'h-4 w-4 rounded accent-sky-400' });
      chk.checked = branchRepoSelection.has(r.id);
      chk.addEventListener('change', () => { if (chk.checked) branchRepoSelection.add(r.id); else branchRepoSelection.delete(r.id); updatePick(); });
      list.append(el('li', {}, el('label', { class: 'flex items-center gap-2 px-3 py-1.5 hover:bg-white/5' }, chk, el('span', { class: 'truncate', text: r.full_name }))));
    }
    if (!shown.length) list.append(el('li', { class: 'px-3 py-2 text-slate-400', text: 'No matching repositories' }));
  };
  const updatePick = () => { pickCount.textContent = `${formatNumber(branchRepoSelection.size)} selected`; scanBtn.disabled = branchRepoSelection.size === 0; };
  search.addEventListener('input', () => { repoQuery = search.value; renderList(); });
  const selShown = el('button', { type: 'button', class: 'btn-ghost py-1.5', onClick: () => { const q = repoQuery.toLowerCase(); for (const r of repos) if (!q || r.full_name.toLowerCase().includes(q)) branchRepoSelection.add(r.id); renderList(); updatePick(); } }, 'Select shown');
  const clearPick = el('button', { type: 'button', class: 'btn-ghost py-1.5', onClick: () => { branchRepoSelection.clear(); renderList(); updatePick(); } }, 'Clear');
  renderList(); updatePick();

  const scanStatus = el('p', { class: 'text-sm text-slate-400', role: 'status' });
  const barEl = el('div', { class: 'progress-bar w-0' });
  const progress = el('div', { class: 'progress', hidden: true, role: 'progressbar', 'aria-valuemin': '0' }, barEl);
  const results = el('div', { class: 'mt-4' });

  scanBtn.addEventListener('click', async () => {
    const d = Number(daysInput.value);
    staleDays = Number.isInteger(d) && d >= 1 && d <= 36500 ? d : DEFAULT_STALE_DAYS;
    daysInput.value = String(staleDays);
    const targets = repos.filter((r) => branchRepoSelection.has(r.id));
    if (!targets.length) return;
    scanBtn.disabled = true; show(progress, true); progress.setAttribute('aria-valuemax', String(targets.length));
    const controller = new AbortController();
    const cancel = el('button', { type: 'button', class: 'btn-ghost py-1.5', onClick: () => controller.abort() }, 'Cancel scan');
    scanBtn.after(cancel);
    branchResults = new Map(); branchSelection.clear();
    bulkRunning = true;
    try {
      const out = await runBulk(targets, async (r, { signal }) => get(`${repoPath(r)}/branches?stale_days=${staleDays}`, { signal }),
        { ...readOptions(), concurrency: 2, signal: controller.signal, onProgress: ({ done, total }) => { scanStatus.textContent = `Scanning ${formatNumber(done)} / ${formatNumber(total)} repositories…`; barEl.style.width = `${Math.round((done / total) * 100)}%`; progress.setAttribute('aria-valuenow', String(done)); } });
      for (const res of out.results) {
        if (res.status === 'ok') branchResults.set(res.item.id, { repo: res.item, defaultBranch: res.value.defaultBranch, branches: res.value.branches || [] });
        else if (res.status === 'failed') branchResults.set(res.item.id, { repo: res.item, branches: [], error: res.error });
      }
      scanStatus.textContent = out.cancelled ? 'Scan cancelled.' : `Scan complete for ${formatNumber(branchResults.size)} ${plural(branchResults.size, 'repository', 'repositories')}.`;
    } catch (e) {
      toastError(describeError(e));
    } finally {
      bulkRunning = false; cancel.remove(); scanBtn.disabled = false;
    }
    renderResults(results);
  });

  body.append(
    el('div', { class: 'grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' },
      el('div', { class: 'space-y-2' },
        el('div', { class: 'flex flex-wrap items-center gap-2' }, search, selShown, clearPick),
        list,
        el('div', { class: 'flex flex-wrap items-center gap-3' }, pickCount,
          el('label', { class: 'flex items-center gap-2 text-sm text-slate-300' }, 'Stale after', daysInput, 'days'),
          scanBtn),
        scanStatus, progress),
      results));
  if (branchResults.size) { scanStatus.textContent = `Showing last scan (${formatNumber(branchResults.size)} ${plural(branchResults.size, 'repository', 'repositories')}).`; renderResults(results); }
}

function matchesFilter(b) {
  if (branchFilter === 'all') return true;
  if (branchFilter === 'merged') return b.merged;
  if (branchFilter === 'stale') return b.stale;
  return b.merged || b.stale;
}

function renderResults(host) {
  clear(host);
  if (!branchResults.size) return;
  const filterSel = el('select', { class: 'input py-1.5 w-auto', 'aria-label': 'Show branches' },
    el('option', { value: 'candidates', text: 'Merged or stale' }), el('option', { value: 'merged', text: 'Merged only' }),
    el('option', { value: 'stale', text: 'Stale only' }), el('option', { value: 'all', text: 'All branches' }));
  filterSel.value = branchFilter;
  filterSel.addEventListener('change', () => { branchFilter = filterSel.value; renderResults(host); });

  const rows = [];
  for (const { repo, branches, error, defaultBranch } of branchResults.values()) {
    for (const b of branches) if (matchesFilter(b) || b.isDefault) rows.push({ repo, b, defaultBranch });
    if (error) rows.push({ repo, error });
  }
  for (const k of branchSelection) {
    const [id, name] = k.split('\u0000');
    const entry = branchResults.get(Number(id));
    const b = entry?.branches.find((x) => x.name === name);
    if (!isBranchDeletable(b)) branchSelection.delete(k);
  }

  const count = el('span', { class: 'text-sm text-slate-300', 'aria-live': 'polite' });
  const delBtn = el('button', { type: 'button', class: 'btn-danger py-1.5', onClick: () => deleteSelectedBranches(host) });
  const updateBar = () => {
    const n = branchSelection.size;
    count.textContent = `${formatNumber(n)} ${plural(n, 'branch', 'branches')} selected`;
    const reason = hasScope('repo') ? '' : 'Missing OAuth scope repo';
    delBtn.disabled = n === 0 || !!reason; delBtn.title = reason;
    delBtn.textContent = `Delete ${formatNumber(n)} ${plural(n, 'branch', 'branches')}`;
  };
  const selectable = rows.filter((r) => r.b && isBranchDeletable(r.b) && matchesFilter(r.b));
  const allChk = el('input', { type: 'checkbox', class: 'h-4 w-4 rounded accent-sky-400', 'aria-label': 'Select all deletable listed branches' });
  allChk.addEventListener('change', () => {
    for (const r of selectable) { const k = keyOf(r.repo.id, r.b.name); if (allChk.checked) branchSelection.add(k); else branchSelection.delete(k); }
    for (const c of tbody.querySelectorAll('input:not([disabled])')) c.checked = allChk.checked;
    updateBar();
  });
  const th = (t) => el('th', { class: 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400', text: t });
  const tbody = el('tbody', { class: 'divide-y divide-white/5' });
  for (const r of rows) {
    if (r.error) {
      tbody.append(el('tr', {}, el('td', { class: 'px-3 py-2' }), el('td', { class: 'px-3 py-2 font-mono text-xs', text: r.repo.full_name }),
        el('td', { class: 'px-3 py-2 text-xs text-rose-300', colspan: '4', text: `Scan failed: ${r.error}` })));
      continue;
    }
    const { b } = r;
    const deletable = isBranchDeletable(b);
    const chk = el('input', { type: 'checkbox', class: 'h-4 w-4 rounded accent-sky-400', 'aria-label': `Select ${r.repo.full_name} ${b.name}`, disabled: !deletable, title: deletable ? '' : b.isDefault ? 'Default branch cannot be deleted' : 'Protected branch cannot be deleted' });
    chk.checked = deletable && branchSelection.has(keyOf(r.repo.id, b.name));
    chk.addEventListener('change', () => { const k = keyOf(r.repo.id, b.name); if (chk.checked) branchSelection.add(k); else branchSelection.delete(k); updateBar(); });
    const badges = [];
    if (b.isDefault) badges.push(el('span', { class: 'badge', text: 'default' }));
    if (b.protected) badges.push(el('span', { class: 'badge-warn', text: 'protected' }));
    if (b.merged) badges.push(el('span', { class: 'badge-ok', text: 'merged' }));
    if (b.stale) badges.push(el('span', { class: 'badge-danger', text: `stale ${b.ageDays ?? '?'}d` }));
    tbody.append(el('tr', { class: deletable ? 'hover:bg-white/5' : 'opacity-70' },
      el('td', { class: 'px-3 py-2' }, chk),
      el('td', { class: 'px-3 py-2 font-mono text-xs text-slate-300 whitespace-nowrap', text: r.repo.full_name }),
      el('td', { class: 'px-3 py-2 font-mono text-xs break-all', text: b.name }),
      el('td', { class: 'px-3 py-2 text-xs whitespace-nowrap' }, b.isDefault ? '—' : `+${b.aheadBy ?? '?'} / −${b.behindBy ?? '?'}`),
      el('td', { class: 'px-3 py-2 text-xs whitespace-nowrap', text: b.lastCommitDate ? formatDate(b.lastCommitDate) : '—' }),
      el('td', { class: 'px-3 py-2 flex flex-wrap gap-1' }, ...badges)));
  }
  if (!rows.length) tbody.append(el('tr', {}, el('td', { class: 'px-3 py-3 text-slate-400', colspan: '6', text: 'No branches match this filter.' })));

  host.append(
    el('div', { class: 'flex flex-wrap items-center gap-3' }, filterSel, count, delBtn),
    el('div', { class: 'mt-3 overflow-x-auto rounded-lg border border-white/10' },
      el('table', { class: 'min-w-full text-sm' },
        el('thead', { class: 'bg-white/5' }, el('tr', {}, el('th', { class: 'px-3 py-2' }, allChk), th('Repository'), th('Branch'), th('Ahead / behind'), th('Last commit'), th('Flags'))),
        tbody)));
  updateBar();
}

async function deleteSelectedBranches(host) {
  const items = [];
  for (const k of branchSelection) {
    const [id, name] = k.split('\u0000');
    const entry = branchResults.get(Number(id));
    const b = entry?.branches.find((x) => x.name === name);
    if (entry && isBranchDeletable(b)) items.push({ repo: entry.repo, branch: b, label: `${entry.repo.full_name}#${b.name}` });
  }
  if (!items.length) return info('No deletable branches selected');
  const ok = await confirmSimple({
    title: `Delete ${formatNumber(items.length)} ${plural(items.length, 'branch', 'branches')}`,
    message: 'The selected branches are deleted from GitHub. Open pull requests from these branches will be closed. Default and protected branches are excluded. This cannot be undone unless you still have the commits locally.',
    repos: items.map((i) => ({ full_name: i.label })),
    confirmLabel: 'Delete branches', confirmClass: 'btn-danger',
  });
  if (!ok) return;
  await runWithPanel({
    title: 'Delete branches', action: 'delete-branches', items, options: writeOptions(),
    perItemFn: (it, { signal }) => del(`${repoPath(it.repo)}/branches/${it.branch.name.split('/').map(encodeURIComponent).join('/')}`, { signal }),
    onItemOk: (it) => {
      const entry = branchResults.get(it.repo.id);
      if (entry) entry.branches = entry.branches.filter((b) => b.name !== it.branch.name);
      branchSelection.delete(keyOf(it.repo.id, it.branch.name));
    },
    onFinish: ({ results, cancelled }) => {
      const ok = results.filter((r) => r.status === 'ok').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      if (ok) success(`Deleted ${formatNumber(ok)} ${plural(ok, 'branch', 'branches')}${failed ? `, ${failed} failed` : ''}${cancelled ? ' (cancelled)' : ''}`);
      else if (failed) info(`Delete branches: all ${failed} failed – see the progress panel`);
      renderResults(host);
    },
  });
}
