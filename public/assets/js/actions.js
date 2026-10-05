// Wires selection-bar bulk actions to safety modals, the bulk runner and the API.
import { on, state, hasScope, selectedRepos, updateRepo, removeRepos, clearSelection } from './state.js';
import { patch, del, put, post } from './api.js';
import { writeOptions } from './bulk.js';
import { confirmDelete, confirmMakePublic, confirmTransfer, confirmSimple, promptText, openModal } from './modals.js';
import { el, formatNumber, $$ } from './ui.js';
import { success, info } from './toast.js';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

const repoPath = (r) => `/api/repos/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}`;
const plural = (n) => (n === 1 ? 'repository' : 'repositories');

export function initActions(bulkPanel) {
  on('bulk-action', ({ type }) => handle(type, bulkPanel));
  on('user', updateScopeState);
  on('repos', updateScopeState);
  on('selection', updateScopeState);
  updateScopeState();
}

function updateScopeState() {
  const canDelete = hasScope('delete_repo');
  for (const btn of $$('[data-action="delete"]')) {
    btn.disabled = !canDelete;
    btn.title = canDelete ? 'Permanently delete the selected repositories' : 'Missing OAuth scope delete_repo – sign out and in again to grant it';
  }
  const canWrite = hasScope('repo');
  for (const btn of $$('[data-action]:not([data-action="delete"])')) {
    btn.disabled = !canWrite;
    btn.title = canWrite ? '' : 'Missing OAuth scope repo';
  }
}

async function handle(type, bulkPanel) {
  const repos = selectedRepos();
  if (!repos.length) return info('Select at least one repository first');
  switch (type) {
    case 'private': return runVisibility(bulkPanel, repos, true);
    case 'public': return runVisibility(bulkPanel, repos, false);
    case 'archive': return runArchive(bulkPanel, repos, true);
    case 'unarchive': return runArchive(bulkPanel, repos, false);
    case 'topics': return runTopics(bulkPanel, repos);
    case 'delete': return runDelete(bulkPanel, repos);
    case 'transfer': return runTransfer(bulkPanel, repos);
    default: return undefined;
  }
}

function afterRun(action, { results, cancelled }) {
  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  if (ok) success(`${action}: ${formatNumber(ok)} ${plural(ok)} done${failed ? `, ${failed} failed` : ''}${cancelled ? ' (cancelled)' : ''}`);
  else if (failed) info(`${action}: all ${failed} failed – see the progress panel for reasons`);
  clearSelection();
}

async function runVisibility(bulkPanel, selected, makePrivate) {
  const repos = selected.filter((r) => r.private !== makePrivate);
  if (!repos.length) return info(`All selected repositories are already ${makePrivate ? 'private' : 'public'}`);
  const ok = makePrivate
    ? await confirmSimple({ title: `Make ${formatNumber(repos.length)} ${plural(repos.length)} private`, message: 'Only you and collaborators will be able to see these repositories. Forks cannot change visibility and will fail.', repos, confirmLabel: 'Make private' })
    : await confirmMakePublic(repos);
  if (!ok) return;
  const label = makePrivate ? 'Make private' : 'Make public';
  await bulkPanel.run({
    title: label, action: makePrivate ? 'make-private' : 'make-public', items: repos, options: writeOptions(),
    perItemFn: (r, { signal }) => patch(repoPath(r), { private: makePrivate }, { signal }),
    onItemOk: (r, res) => updateRepo(r.id, { private: res?.repo?.private ?? makePrivate, visibility: res?.repo?.visibility ?? (makePrivate ? 'private' : 'public') }),
    onFinish: (out) => afterRun(label, out),
  });
}

async function runArchive(bulkPanel, selected, archive) {
  const repos = selected.filter((r) => !!r.archived !== archive);
  if (!repos.length) return info(`All selected repositories are already ${archive ? 'archived' : 'active'}`);
  const ok = await confirmSimple({
    title: `${archive ? 'Archive' : 'Unarchive'} ${formatNumber(repos.length)} ${plural(repos.length)}`,
    message: archive ? 'Archived repositories become read-only (no pushes, issues or pull requests) until unarchived.' : 'These repositories become writable again.',
    repos, confirmLabel: archive ? 'Archive' : 'Unarchive',
  });
  if (!ok) return;
  const label = archive ? 'Archive' : 'Unarchive';
  await bulkPanel.run({
    title: label, action: archive ? 'archive' : 'unarchive', items: repos, options: writeOptions(),
    perItemFn: (r, { signal }) => patch(repoPath(r), { archived: archive }, { signal }),
    onItemOk: (r, res) => updateRepo(r.id, { archived: res?.repo?.archived ?? archive }),
    onFinish: (out) => afterRun(label, out),
  });
}

async function runDelete(bulkPanel, repos) {
  if (!hasScope('delete_repo')) return info('Missing OAuth scope delete_repo');
  const ok = await confirmDelete(repos);
  if (!ok) return;
  await bulkPanel.run({
    title: 'Delete repositories', action: 'delete', items: repos, options: writeOptions(),
    perItemFn: (r, { signal }) => del(repoPath(r), { signal }),
    onItemOk: (r) => removeRepos([r.id]),
    onFinish: (out) => afterRun('Delete', out),
  });
}

function parseTopics(text) {
  return text.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

async function runTopics(bulkPanel, repos) {
  const spec = await openModal({
    title: `Edit topics on ${formatNumber(repos.length)} ${plural(repos.length)}`,
    confirmLabel: 'Apply topics',
    build: ({ setConfirmEnabled, confirmBtn }) => {
      const modeSel = el('select', { class: 'input', 'aria-label': 'Mode' },
        el('option', { value: 'add', text: 'Add topics (keep existing)' }),
        el('option', { value: 'remove', text: 'Remove topics' }),
        el('option', { value: 'replace', text: 'Replace all topics' }));
      const input = el('input', { class: 'input font-mono', type: 'text', placeholder: 'web, cli, my-tool', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Topics' });
      const err = el('p', { class: 'text-xs text-rose-300', 'aria-live': 'polite' });
      const check = () => {
        const names = parseTopics(input.value);
        const bad = names.find((t) => !TOPIC_RE.test(t));
        let e = '';
        if (bad) e = `Invalid topic "${bad}" – lowercase letters, digits and hyphens, max 50 chars`;
        else if (names.length > 20) e = 'At most 20 topics per repository';
        else if (!names.length && modeSel.value !== 'replace') e = '';
        err.textContent = e;
        setConfirmEnabled(!e && (names.length > 0 || modeSel.value === 'replace'));
        confirmBtn._value = { mode: modeSel.value, names };
      };
      input.addEventListener('input', check); modeSel.addEventListener('change', check); check();
      return [
        el('label', { class: 'block space-y-1' }, el('span', { class: 'text-slate-300', text: 'Mode' }), modeSel),
        el('label', { class: 'block space-y-1' }, el('span', { class: 'text-slate-300', text: 'Topics (comma or space separated)' }), input),
        el('p', { class: 'text-xs text-slate-400', text: 'Replace with an empty list clears all topics. GitHub allows at most 20 topics per repository.' }),
        err,
      ];
    },
  });
  if (!spec) return;
  await bulkPanel.run({
    title: 'Update topics', action: `topics-${spec.mode}`, items: repos, options: writeOptions(),
    perItemFn: (r, { signal }) => put(`${repoPath(r)}/topics`, spec, { signal }),
    onItemOk: (r, res) => updateRepo(r.id, { topics: Array.isArray(res?.topics) ? res.topics : r.topics }),
    onFinish: (out) => afterRun('Topics', out),
  });
}

async function runTransfer(bulkPanel, repos) {
  const me = state.user?.login?.toLowerCase();
  const newOwner = await promptText({
    title: `Transfer ${formatNumber(repos.length)} ${plural(repos.length)}`,
    label: 'New owner (user or organization login)',
    placeholder: 'octo-org',
    hint: 'Repository names are kept. Transfers to a personal account must be accepted by the recipient; transfers to an organization you administer complete immediately.',
    validate: (v) => (!OWNER_RE.test(v) ? 'Invalid GitHub login' : v.toLowerCase() === me ? 'That is your own account' : ''),
  });
  if (!newOwner) return;
  const ok = await confirmTransfer(repos, newOwner);
  if (!ok) return;
  await bulkPanel.run({
    title: `Transfer to ${newOwner}`, action: 'transfer', items: repos, options: writeOptions(),
    perItemFn: (r, { signal }) => post(`${repoPath(r)}/transfer`, { new_owner: newOwner }, { signal }),
    onItemOk: (r, res) => {
      // 202: transfer started. Personal-account targets stay listed until accepted; org targets move immediately.
      if (res?.repo?.owner?.login && res.repo.owner.login.toLowerCase() !== r.owner.login.toLowerCase()) removeRepos([r.id]);
      else updateRepo(r.id, { transferPending: newOwner });
    },
    onFinish: (out) => afterRun('Transfer', out),
  });
}
