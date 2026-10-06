// Cleanup tools: Forks, Empty repos, Branches. All GitHub strings are rendered via textContent.
// Rendering is lazy: while the tab is hidden, `repos` events only mark it dirty (rendered on tab switch).
import { el, clear, show, formatNumber, formatBytesFromKB, formatDate, relativeTime, debounce } from './ui.js';
import { get, del, describeError } from './api.js';
import { state, on, emit, hasScope, removeRepos } from './state.js';
import { runBulk, writeOptions, readOptions, BulkPanel } from './bulk.js';
import { confirmDelete, confirmSimple } from './modals.js';
import { success, info, error as toastError } from './toast.js';
import { icon, spinner } from './icons.js';
import { langDot } from './langcolors.js';
import { createMenu } from './menu.js';

const repoPath = (r) => `/api/repos/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}`;
const plural = (n, one, many) => (n === 1 ? one : many);
const DEFAULT_STALE_DAYS = 90;
const CHUNK = 100;

// UI-side mirror of lib/branches.js: default/protected branches are never deletable.
export function isBranchDeletable(b) {
  return !!b && !b.isDefault && !b.protected && b.deletable !== false;
}

let bulkPanel = null;
let progressHost = null;
let bulkRunning = false;

export function initCleanup(section) {
  clear(section);
  progressHost = el('div', { hidden: true });
  bulkPanel = new BulkPanel(progressHost);
  const tabs = [
    { id: 'forks', label: 'Forks', icon: 'fork', mount: mountForks },
    { id: 'empty', label: 'Empty repositories', icon: 'repo', mount: mountEmpty },
    { id: 'branches', label: 'Branches', icon: 'git-branch', mount: mountBranches },
  ];
  const body = el('div', { id: 'cleanup-panel', role: 'tabpanel', tabindex: '-1', class: 'space-y-4' });
  const nav = el('div', { class: 'UnderlineNav UnderlineNav--sub', role: 'tablist', 'aria-label': 'Cleanup tools' });
  const counters = {};
  let active = null;
  let dirty = true;
  const remount = () => {
    dirty = false;
    const t = tabs.find((x) => x.id === active);
    clear(body);
    t.mount(body);
    updateCounters();
  };
  const updateCounters = () => {
    counters.forks.textContent = formatNumber(state.repos.filter((r) => r.fork).length);
    const empty = state.repos.filter((r) => r.isEmpty === true).length;
    counters.empty.textContent = formatNumber(empty);
    show(counters.empty, empty > 0);
  };
  const activate = (t, focus = false) => {
    active = t.id;
    for (const b of nav.children) {
      const selected = b.dataset.tab === t.id;
      b.setAttribute('aria-selected', String(selected));
      b.setAttribute('tabindex', selected ? '0' : '-1');
      if (selected) { body.setAttribute('aria-labelledby', b.id); if (focus) b.focus(); }
    }
    remount();
  };
  for (const t of tabs) {
    const counter = el('span', { class: 'Counter' });
    if (t.id !== 'branches') counters[t.id] = counter;
    nav.append(el('button', {
      type: 'button', role: 'tab', id: `cleanup-tab-${t.id}`, 'aria-controls': 'cleanup-panel',
      class: 'UnderlineNav-item', dataset: { tab: t.id }, 'aria-selected': 'false', onClick: () => activate(t),
    }, el('span', { class: 'UnderlineNav-inner' }, icon(t.icon), t.label, t.id !== 'branches' ? counter : null)));
  }
  // Roving tabindex: arrow keys / Home / End move between tabs (WAI-ARIA tabs pattern).
  nav.addEventListener('keydown', (ev) => {
    const idx = tabs.findIndex((x) => x.id === active);
    let next = -1;
    if (ev.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (ev.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    activate(tabs[next], true);
  });
  section.append(nav, progressHost, body);
  active = tabs[0].id;
  activate(tabs[0]);
  // Lazy: hidden → only mark dirty; visible → coalesce into one render per frame. Skip during own bulk runs.
  let raf = 0;
  on('repos', () => {
    dirty = true;
    if (state.activeTab !== 'cleanup' || bulkRunning || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (dirty && !bulkRunning && state.activeTab === 'cleanup') remount(); });
  });
  on('tab', (tab) => { if (tab === 'cleanup' && dirty && !bulkRunning) remount(); });
}

async function runWithPanel(spec) {
  bulkRunning = true;
  try { return await bulkPanel.run(spec); } finally { bulkRunning = false; emit('repos', state.repos); }
}

function deleteDisabledReason() {
  if (!hasScope('delete_repo')) return 'Missing OAuth scope delete_repo – sign out and in again to grant it';
  return '';
}

function intro(title, text) {
  return el('div', { class: 'space-y-1' },
    el('h2', { class: 'm-0 text-xl font-semibold', text: title }),
    el('p', { class: 'm-0 text-sm text-fg-muted', text }));
}

function blankslate(iconName, title, desc) {
  return el('div', { class: 'Box' }, el('div', { class: 'Blankslate' }, icon(iconName, { size: 24 }),
    el('h3', { class: 'Blankslate-title', text: title }), desc ? el('p', { class: 'Blankslate-desc', text: desc }) : null));
}

function progressBar() {
  const item = el('span', { class: 'Progress-item' });
  item.style.width = '0%';
  const bar = el('div', { class: 'Progress', hidden: true, role: 'progressbar', 'aria-valuemin': '0', 'aria-label': 'Scan progress' }, item);
  return {
    bar,
    set(done, total) { item.classList.toggle('is-success', total > 0 && done >= total); item.style.width = `${total ? Math.round((done / total) * 100) : 0}%`; bar.setAttribute('aria-valuemax', String(total)); bar.setAttribute('aria-valuenow', String(done)); },
  };
}

// --- generic selectable Box list (GitHub-style rows, delegated events) ------------------------

function repoMeta(r, extra = []) {
  const meta = [];
  if (r.language) meta.push(el('span', { class: 'inline-flex items-center gap-1' }, langDot(r.language), r.language));
  if (r.stargazers_count) meta.push(el('span', { class: 'inline-flex items-center gap-1', title: 'Stars' }, icon('star'), formatNumber(r.stargazers_count)));
  meta.push(el('span', { text: formatBytesFromKB(r.size) }));
  for (const x of extra) meta.push(x);
  return el('div', { class: 'meta-row mt-1' }, ...meta);
}

function repoRowBody(r, extraMeta) {
  const labels = [el('span', { class: 'Label', text: r.private ? 'Private' : 'Public' })];
  if (r.fork) labels.push(el('span', { class: 'Label Label--done', text: 'Fork' }));
  if (r.archived) labels.push(el('span', { class: 'Label Label--attention', text: 'Archived' }));
  if (r.isEmpty === true) labels.push(el('span', { class: 'Label Label--danger', text: 'Empty' }));
  return el('div', { class: 'min-w-0 flex-1' },
    el('div', { class: 'flex min-w-0 flex-wrap items-center gap-2' },
      el('a', { href: r.html_url, target: '_blank', rel: 'noopener noreferrer', class: 'min-w-0 truncate font-semibold', title: r.full_name, text: r.full_name }),
      ...labels),
    r.description ? el('p', { class: 'm-0 mt-1 truncate text-sm text-fg-muted', text: r.description, title: r.description }) : null,
    repoMeta(r, extraMeta(r)));
}

/** Box list with select-all header that doubles as the action bar ("N selected" + red Delete). */
function repoBox({ repos, selected, extraMeta = () => [], actionLabel, onDelete }) {
  const allChk = el('input', { type: 'checkbox', 'aria-label': 'Select all listed repositories' });
  const count = el('span', { class: 'text-sm font-semibold', 'aria-live': 'polite' });
  const delBtn = el('button', { type: 'button', class: 'btn btn-sm btn-danger ml-auto' }, icon('trash'), el('span', { text: actionLabel }));
  const header = el('div', { class: 'Box-header' }, allChk, count, delBtn);
  const list = el('ul', { class: 'm-0 p-0', 'aria-label': 'Repositories' });
  const checks = new Map();
  const more = el('button', { type: 'button', class: 'btn btn-sm' });
  const footer = el('div', { class: 'Box-footer flex justify-center py-2', hidden: true }, more);
  let rendered = 0;
  const renderMore = () => { // chunked: keeps tab switches fast with hundreds of rows
    const frag = document.createDocumentFragment();
    for (const r of repos.slice(rendered, rendered + CHUNK)) {
      const chk = el('input', { type: 'checkbox', class: 'mt-1 shrink-0', 'aria-label': `Select ${r.full_name}`, dataset: { id: String(r.id) } });
      chk.checked = selected.has(r.id);
      const li = el('li', { class: `Box-row Box-row--hover list-row flex gap-3${chk.checked ? ' is-selected' : ''}` }, chk, repoRowBody(r, extraMeta));
      checks.set(r.id, { chk, li });
      frag.append(li);
    }
    rendered = Math.min(repos.length, rendered + CHUNK);
    list.append(frag);
    const left = repos.length - rendered;
    show(footer, left > 0);
    more.textContent = `Show ${formatNumber(Math.min(CHUNK, left))} more (${formatNumber(left)} hidden)`;
  };
  more.addEventListener('click', renderMore);
  renderMore();
  const sync = () => {
    const n = repos.reduce((a, r) => a + (selected.has(r.id) ? 1 : 0), 0);
    allChk.checked = repos.length > 0 && n === repos.length;
    allChk.indeterminate = n > 0 && n < repos.length;
    count.textContent = n ? `${formatNumber(n)} selected` : `${formatNumber(repos.length)} ${plural(repos.length, 'repository', 'repositories')}`;
    const reason = deleteDisabledReason();
    delBtn.disabled = n === 0 || !!reason;
    delBtn.title = reason || (n ? '' : 'Select repositories first');
    header.classList.toggle('is-active', n > 0);
  };
  list.addEventListener('change', (e) => {
    const id = Number(e.target.dataset?.id);
    if (!id) return;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    checks.get(id)?.li.classList.toggle('is-selected', e.target.checked);
    sync();
  });
  allChk.addEventListener('change', () => {
    for (const r of repos) {
      if (allChk.checked) selected.add(r.id); else selected.delete(r.id);
      const c = checks.get(r.id); if (c) { c.chk.checked = allChk.checked; c.li.classList.toggle('is-selected', allChk.checked); }
    }
    sync();
  });
  delBtn.addEventListener('click', () => onDelete(repos.filter((r) => selected.has(r.id))));
  sync();
  return el('div', { class: 'Box' }, header, list, footer);
}

async function deleteRepos(repos, actionLabel) {
  if (deleteDisabledReason()) return info(deleteDisabledReason());
  if (!repos.length) return;
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

const ageMeta = (label, iso) => el('span', { title: iso ? formatDate(iso) : '', text: `${label} ${relativeTime(iso)}` });

// --- Forks ------------------------------------------------------------------------------------

const forkSelection = new Set();
function mountForks(body) {
  const forks = state.repos.filter((r) => r.fork);
  const ids = new Set(forks.map((r) => r.id));
  for (const id of forkSelection) if (!ids.has(id)) forkSelection.delete(id);
  body.append(intro('Forked repositories', `${formatNumber(forks.length)} of ${formatNumber(state.repos.length)} loaded repositories are forks. Forks you no longer contribute to can usually be deleted safely – your pull requests on the upstream repository stay intact, but any unpushed or unmerged commits on the fork are lost.`));
  if (!state.reposLoaded) return body.append(el('div', { class: 'flash', role: 'status' }, spinner(), el('span', { text: 'Repositories are still loading…' })));
  if (!forks.length) return body.append(blankslate('fork', 'No forks found', 'None of your loaded repositories is a fork.'));
  body.append(repoBox({
    repos: forks, selected: forkSelection, actionLabel: 'Delete selected',
    extraMeta: (r) => [ageMeta('Pushed', r.pushed_at)],
    onDelete: (sel) => deleteRepos(sel, 'Delete forks'),
  }));
}

// --- Empty repos ------------------------------------------------------------------------------

const emptySelection = new Set();
let emptyScan = { running: false, done: 0, total: 0, scanned: false };

function mountEmpty(body) {
  const candidates = state.repos.filter((r) => (r.size ?? 0) === 0 || r.isEmpty === true);
  const confirmed = state.repos.filter((r) => r.isEmpty === true);
  const ids = new Set(confirmed.map((r) => r.id));
  for (const id of emptySelection) if (!ids.has(id)) emptySelection.delete(id);

  const scanBtn = el('button', { type: 'button', class: 'btn btn-primary' }, icon('search'), el('span', { text: emptyScan.scanned ? 'Rescan' : 'Scan for empty repositories' }));
  const status = el('p', { class: 'm-0 text-sm text-fg-muted', role: 'status' });
  const prog = progressBar();
  const includeAll = el('input', { type: 'checkbox' });
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
    scanBtn.disabled = true; show(prog.bar, true); prog.set(0, targets.length); setStatus();
    const controller = new AbortController();
    const cancel = el('button', { type: 'button', class: 'btn', onClick: () => controller.abort() }, 'Cancel scan');
    scanBtn.after(cancel);
    try {
      bulkRunning = true;
      await runBulk(targets, async (r, { signal }) => {
        const res = await get(`${repoPath(r)}/empty-check`, { signal });
        r.isEmpty = !!res.empty; // mutate in place; single `repos` emit after the scan
        return res;
      }, { ...readOptions(), signal: controller.signal, onProgress: ({ done, total }) => { emptyScan.done = done; prog.set(done, total); setStatus(); } });
    } catch (e) {
      toastError(describeError(e));
    } finally {
      bulkRunning = false;
      emptyScan = { ...emptyScan, running: false, scanned: true };
      cancel.remove();
      emit('repos', state.repos); // grid "Empty" filter + this tab re-render
    }
  });

  body.append(
    intro('Empty repositories', 'A repository is empty when GitHub reports it has no commits. Size alone is not reliable, so each candidate is verified with one API call (4 in parallel).'),
    el('div', { class: 'Box' }, el('div', { class: 'Box-body space-y-3' },
      el('div', { class: 'flex flex-wrap items-center gap-3' }, scanBtn,
        el('label', { class: 'inline-flex items-center gap-2 text-sm' }, includeAll, 'Scan all repositories (slower)')),
      status, prog.bar)));

  if (!confirmed.length) {
    if (emptyScan.scanned) body.append(blankslate('check', 'No empty repositories found', 'Every scanned repository has at least one commit.'));
    return;
  }
  body.append(repoBox({
    repos: confirmed, selected: emptySelection, actionLabel: 'Delete selected',
    extraMeta: (r) => [ageMeta('Updated', r.updated_at)],
    onDelete: (sel) => deleteRepos(sel, 'Delete empty repositories'),
  }));
}

// --- Branches ---------------------------------------------------------------------------------

const branchRepoSelection = new Set();
const branchSelection = new Set(); // keys `${repoId}\u0000${branch}`
let branchResults = new Map(); // repoId → { repo, defaultBranch, branches, error }
let staleDays = DEFAULT_STALE_DAYS;
let branchFilter = 'candidates'; // candidates | merged | stale | all
let repoQuery = '';
const keyOf = (repoId, name) => `${repoId}\u0000${name}`;
const FILTERS = [['candidates', 'Merged or stale'], ['merged', 'Merged only'], ['stale', 'Stale only'], ['all', 'All branches']];
const PICK_LIMIT = 300;

function mountBranches(body) {
  const repos = state.repos.filter((r) => !r.archived && (r.permissions?.push || r.permissions?.admin));
  const ids = new Set(repos.map((r) => r.id));
  for (const id of branchRepoSelection) if (!ids.has(id)) branchRepoSelection.delete(id);

  body.append(intro('Branch cleanup', 'Pick repositories, scan their branches, then delete merged (0 commits ahead of the default branch) or stale ones. Default and protected branches are never offered.'));

  // Repo picker (Box with search header, delegated checkbox list)
  const search = el('input', { class: 'form-control form-control-sm', type: 'search', placeholder: 'Filter repositories…', 'aria-label': 'Filter repositories', autocomplete: 'off' });
  search.value = repoQuery;
  const list = el('ul', { class: 'picker-list m-0 p-0', 'aria-label': 'Repositories to scan' });
  const pickCount = el('span', { class: 'text-sm text-fg-muted', 'aria-live': 'polite' });
  const daysInput = el('input', { class: 'form-control form-control-sm w-20', type: 'number', min: '1', max: '36500', step: '1', 'aria-label': 'Stale after days' });
  daysInput.value = String(staleDays);
  const scanBtn = el('button', { type: 'button', class: 'btn btn-sm btn-primary ml-auto' }, icon('search'), el('span', { text: 'Scan branches' }));
  const shownRepos = () => { const q = repoQuery.toLowerCase(); return repos.filter((r) => !q || r.full_name.toLowerCase().includes(q)); };
  const renderList = () => {
    const shown = shownRepos();
    const frag = document.createDocumentFragment();
    for (const r of shown.slice(0, PICK_LIMIT)) {
      const chk = el('input', { type: 'checkbox', dataset: { id: String(r.id) } });
      chk.checked = branchRepoSelection.has(r.id);
      frag.append(el('li', {}, el('label', { class: 'picker-item' }, chk, el('span', { class: 'truncate', text: r.full_name, title: r.full_name }))));
    }
    if (!shown.length) frag.append(el('li', { class: 'px-4 py-2 text-sm text-fg-muted', text: 'No matching repositories' }));
    else if (shown.length > PICK_LIMIT) frag.append(el('li', { class: 'px-4 py-2 text-xs text-fg-muted', text: `Showing ${PICK_LIMIT} of ${formatNumber(shown.length)} – refine the filter` }));
    list.replaceChildren(frag);
  };
  const updatePick = () => { pickCount.textContent = `${formatNumber(branchRepoSelection.size)} selected`; scanBtn.disabled = branchRepoSelection.size === 0; };
  list.addEventListener('change', (e) => {
    const id = Number(e.target.dataset?.id); if (!id) return;
    if (e.target.checked) branchRepoSelection.add(id); else branchRepoSelection.delete(id);
    updatePick();
  });
  search.addEventListener('input', debounce(() => { repoQuery = search.value; renderList(); }, 120));
  const selShown = el('button', { type: 'button', class: 'btn-link text-sm', onClick: () => { for (const r of shownRepos()) branchRepoSelection.add(r.id); renderList(); updatePick(); } }, 'Select shown');
  const clearPick = el('button', { type: 'button', class: 'btn-link text-sm', onClick: () => { branchRepoSelection.clear(); renderList(); updatePick(); } }, 'Clear');
  renderList(); updatePick();

  const scanStatus = el('p', { class: 'm-0 text-sm text-fg-muted', role: 'status' });
  const prog = progressBar();
  const results = el('div', { class: 'min-w-0' });

  scanBtn.addEventListener('click', async () => {
    const d = Number(daysInput.value);
    staleDays = Number.isInteger(d) && d >= 1 && d <= 36500 ? d : DEFAULT_STALE_DAYS;
    daysInput.value = String(staleDays);
    const targets = repos.filter((r) => branchRepoSelection.has(r.id));
    if (!targets.length) return;
    scanBtn.disabled = true; show(prog.bar, true); prog.set(0, targets.length);
    const controller = new AbortController();
    const cancel = el('button', { type: 'button', class: 'btn btn-sm', onClick: () => controller.abort() }, 'Cancel scan');
    scanBtn.after(cancel);
    branchResults = new Map(); branchSelection.clear();
    bulkRunning = true;
    try {
      const out = await runBulk(targets, async (r, { signal }) => get(`${repoPath(r)}/branches?stale_days=${staleDays}`, { signal }),
        { ...readOptions(), concurrency: 2, signal: controller.signal, onProgress: ({ done, total }) => { scanStatus.textContent = `Scanning ${formatNumber(done)} / ${formatNumber(total)} repositories…`; prog.set(done, total); } });
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
    el('div', { class: 'grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start' },
      el('div', { class: 'space-y-2' },
        el('div', { class: 'Box' },
          el('div', { class: 'Box-header flex-wrap' },
            el('div', { class: 'search-input min-w-0 flex-1' }, icon('search'), search), selShown, clearPick),
          list,
          el('div', { class: 'Box-footer flex flex-wrap items-center gap-3 py-2' }, pickCount,
            el('label', { class: 'inline-flex items-center gap-2 text-sm' }, 'Stale after', daysInput, 'days'),
            scanBtn)),
        scanStatus, prog.bar),
      results));
  if (branchResults.size) { scanStatus.textContent = `Showing last scan (${formatNumber(branchResults.size)} ${plural(branchResults.size, 'repository', 'repositories')}).`; renderResults(results); }
  else results.append(blankslate('git-branch', 'No branches scanned yet', 'Select repositories on the left and press “Scan branches”.'));
}

function matchesFilter(b) {
  if (branchFilter === 'all') return true;
  if (branchFilter === 'merged') return b.merged;
  if (branchFilter === 'stale') return b.stale;
  return b.merged || b.stale;
}

function branchRow(repo, b, selected) {
  const deletable = isBranchDeletable(b);
  const reason = b.isDefault ? 'Default branch cannot be deleted' : 'Protected branch cannot be deleted';
  const chk = el('input', { type: 'checkbox', class: 'mt-1 shrink-0', 'aria-label': `Select ${repo.full_name} ${b.name}`, disabled: !deletable, title: deletable ? '' : reason, dataset: { key: keyOf(repo.id, b.name) } });
  chk.checked = selected;
  const labels = [];
  if (b.isDefault) labels.push(el('span', { class: 'Label Label--accent', text: 'Default' }));
  if (b.protected) labels.push(el('span', { class: 'Label Label--attention', text: 'Protected' }));
  if (b.merged && !b.isDefault) labels.push(el('span', { class: 'Label Label--done', text: 'Merged' }));
  if (b.stale) labels.push(el('span', { class: 'Label Label--danger', text: `Stale · ${b.ageDays ?? '?'}d` }));
  const meta = [];
  if (!b.isDefault) meta.push(el('span', { class: 'inline-flex items-center gap-1', title: `${b.aheadBy ?? '?'} ahead / ${b.behindBy ?? '?'} behind the default branch` }, icon('git-merge'), `${b.aheadBy ?? '?'} ahead · ${b.behindBy ?? '?'} behind`));
  meta.push(el('span', { title: b.lastCommitDate ? formatDate(b.lastCommitDate) : '', text: b.lastCommitDate ? `Last commit ${relativeTime(b.lastCommitDate)}` : 'No commit date' }));
  return el('li', { class: `Box-row Box-row--hover list-row list-row--sm flex gap-3${selected ? ' is-selected' : ''}${deletable ? '' : ' is-locked'}` },
    chk,
    el('div', { class: 'min-w-0 flex-1' },
      el('div', { class: 'flex min-w-0 flex-wrap items-center gap-2' },
        icon(deletable ? 'git-branch' : 'lock', { class: 'shrink-0 fill-muted', label: deletable ? undefined : reason }),
        el('span', { class: 'branch-name', text: b.name, title: b.name }),
        el('span', { class: 'truncate text-xs text-fg-muted', text: repo.full_name, title: repo.full_name }),
        ...labels),
      el('div', { class: 'meta-row mt-1' }, ...meta)));
}

function renderResults(host) {
  clear(host);
  if (!branchResults.size) return;
  const rows = [];
  for (const { repo, branches, error } of branchResults.values()) {
    for (const b of branches) if (matchesFilter(b) || b.isDefault) rows.push({ repo, b });
    if (error) rows.push({ repo, error });
  }
  for (const k of branchSelection) {
    const [id, name] = k.split('\u0000');
    const entry = branchResults.get(Number(id));
    const b = entry?.branches.find((x) => x.name === name);
    if (!isBranchDeletable(b)) branchSelection.delete(k);
  }
  const selectable = rows.filter((r) => r.b && isBranchDeletable(r.b) && matchesFilter(r.b));

  const filterMenu = createMenu({
    label: FILTERS.find(([k]) => k === branchFilter)[1], ariaLabel: 'Show branches', selectable: true, buttonClass: 'btn btn-sm', align: 'right',
    items: () => [{ header: 'Show branches' }, ...FILTERS.map(([k, label]) => ({ label, checked: branchFilter === k, onSelect: () => { branchFilter = k; renderResults(host); } }))],
  });
  const allChk = el('input', { type: 'checkbox', 'aria-label': 'Select all deletable listed branches' });
  const count = el('span', { class: 'text-sm font-semibold', 'aria-live': 'polite' });
  const delBtn = el('button', { type: 'button', class: 'btn btn-sm btn-danger', onClick: () => deleteSelectedBranches(host) }, icon('trash'), el('span', { text: 'Delete selected' }));
  const header = el('div', { class: 'Box-header flex-wrap' }, allChk, count, el('span', { class: 'ml-auto flex items-center gap-2' }, filterMenu.root, delBtn));
  const list = el('ul', { class: 'm-0 p-0', 'aria-label': 'Branches' });
  const updateBar = () => {
    const n = branchSelection.size;
    count.textContent = n ? `${formatNumber(n)} ${plural(n, 'branch', 'branches')} selected` : `${formatNumber(rows.filter((r) => r.b).length)} ${plural(rows.filter((r) => r.b).length, 'branch', 'branches')}`;
    const reason = hasScope('repo') ? '' : 'Missing OAuth scope repo';
    delBtn.disabled = n === 0 || !!reason; delBtn.title = reason || (n ? '' : 'Select branches first');
    const m = selectable.reduce((a, r) => a + (branchSelection.has(keyOf(r.repo.id, r.b.name)) ? 1 : 0), 0);
    allChk.checked = selectable.length > 0 && m === selectable.length;
    allChk.indeterminate = m > 0 && m < selectable.length;
    allChk.disabled = selectable.length === 0;
  };
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    if (r.error) {
      frag.append(el('li', { class: 'Box-row flex items-center gap-2 text-sm' }, icon('alert', { class: 'shrink-0 fill-danger' }),
        el('span', { class: 'font-semibold', text: r.repo.full_name }), el('span', { class: 'text-danger', text: `Scan failed: ${r.error}` })));
      continue;
    }
    frag.append(branchRow(r.repo, r.b, isBranchDeletable(r.b) && branchSelection.has(keyOf(r.repo.id, r.b.name))));
  }
  if (!rows.length) frag.append(el('li', { class: 'Box-row text-sm text-fg-muted', text: 'No branches match this filter.' }));
  list.replaceChildren(frag);
  list.addEventListener('change', (e) => {
    const k = e.target.dataset?.key; if (!k || e.target.disabled) return;
    if (e.target.checked) branchSelection.add(k); else branchSelection.delete(k);
    e.target.closest('li')?.classList.toggle('is-selected', e.target.checked);
    updateBar();
  });
  allChk.addEventListener('change', () => {
    for (const r of selectable) { const k = keyOf(r.repo.id, r.b.name); if (allChk.checked) branchSelection.add(k); else branchSelection.delete(k); }
    for (const c of list.querySelectorAll('input:not([disabled])')) { c.checked = allChk.checked; c.closest('li')?.classList.toggle('is-selected', allChk.checked); }
    updateBar();
  });
  host.append(el('div', { class: 'Box' }, header, list));
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
    confirmLabel: 'Delete branches', confirmClass: 'btn btn-danger-solid',
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
