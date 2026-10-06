// Live analytics (GitHub Insights-like) computed from the in-memory repo list. CSS bars only, no library.
// Rendering is lazy (only while the tab is visible) and computeAnalytics is memoized per repo-list version.
import { el, clear, formatNumber, formatBytesFromKB, formatDate, daysSince } from './ui.js';
import { state, on } from './state.js';
import { icon, spinner } from './icons.js';
import { langColor } from './langcolors.js';

export const UNKNOWN_LANGUAGE = 'Unknown';
const TOP_N = 10;

/** Pure: aggregate statistics for a list of trimmed repo objects. */
export function computeAnalytics(repos, now = Date.now()) {
  const list = Array.isArray(repos) ? repos : [];
  const totals = { repos: list.length, public: 0, private: 0, forks: 0, sources: 0, archived: 0, active: 0, stars: 0, forkCount: 0, openIssues: 0, sizeKB: 0 };
  const langMap = new Map();
  for (const r of list) {
    if (r.private) totals.private++; else totals.public++;
    if (r.fork) totals.forks++; else totals.sources++;
    if (r.archived) totals.archived++; else totals.active++;
    totals.stars += Number(r.stargazers_count) || 0;
    totals.forkCount += Number(r.forks_count) || 0;
    totals.openIssues += Number(r.open_issues_count) || 0;
    totals.sizeKB += Number(r.size) || 0;
    const lang = typeof r.language === 'string' && r.language.trim() ? r.language : UNKNOWN_LANGUAGE;
    langMap.set(lang, (langMap.get(lang) || 0) + 1);
  }
  const languages = [...langMap.entries()].map(([name, count]) => ({ name, count, share: list.length ? count / list.length : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const byStars = list.filter((r) => (Number(r.stargazers_count) || 0) > 0)
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0) || a.full_name.localeCompare(b.full_name)).slice(0, TOP_N);
  const bySize = list.filter((r) => (Number(r.size) || 0) > 0)
    .sort((a, b) => (b.size || 0) - (a.size || 0) || a.full_name.localeCompare(b.full_name)).slice(0, TOP_N);
  const oldest = list.filter((r) => !r.archived && r.pushed_at)
    .map((r) => ({ repo: r, days: daysSince(r.pushed_at, now) })).filter((x) => Number.isFinite(x.days))
    .sort((a, b) => b.days - a.days || a.repo.full_name.localeCompare(b.repo.full_name)).slice(0, TOP_N);
  return { totals, languages, byStars, bySize, oldest };
}

/** Group languages beyond `max` into "Other" for charts. */
export function topLanguages(languages, max = 8) {
  if (languages.length <= max) return languages;
  const head = languages.slice(0, max - 1);
  const rest = languages.slice(max - 1);
  const count = rest.reduce((s, l) => s + l.count, 0);
  const share = rest.reduce((s, l) => s + l.share, 0);
  return [...head, { name: 'Other', count, share, grouped: rest.length }];
}

// --- rendering --------------------------------------------------------------------------------

const pctText = (n, total) => (total ? `${(Math.round((n / total) * 1000) / 10).toFixed(1)}%` : '0%');

function dot(color) {
  const d = el('span', { class: 'lang-dot', 'aria-hidden': 'true' });
  d.style.backgroundColor = color;
  return d;
}

function tile(iconName, label, value, hint) {
  return el('div', { class: 'Box stat-tile' },
    el('div', { class: 'flex items-center gap-2 text-sm text-fg-muted' }, icon(iconName), el('span', { text: label })),
    el('p', { class: 'stat-value', text: value }),
    hint ? el('p', { class: 'm-0 text-xs text-fg-muted', text: hint }) : null);
}

function card(title, ...children) {
  return el('section', { class: 'Box min-w-0', 'aria-label': title },
    el('div', { class: 'Box-header' }, el('h2', { class: 'Box-title', text: title })),
    el('div', { class: 'Box-body space-y-3' }, ...children));
}

/** GitHub's segmented language bar + legend. segs = [{ name, value, color }] */
function segmentedBar(segs, ariaLabel) {
  const total = segs.reduce((s, x) => s + x.value, 0);
  const bar = el('div', { class: 'seg-bar', role: 'img', 'aria-label': `${ariaLabel}: ${segs.map((x) => `${x.name} ${pctText(x.value, total)}`).join(', ')}` });
  for (const x of segs) {
    if (!x.value) continue;
    const part = el('span', { class: 'seg-bar-item', title: `${x.name}: ${formatNumber(x.value)} (${pctText(x.value, total)})` });
    part.style.width = `${(x.value / total) * 100}%`;
    part.style.backgroundColor = x.color;
    bar.append(part);
  }
  const legend = el('ul', { class: 'seg-legend', 'aria-label': `${ariaLabel} legend` }, ...segs.map((x) => el('li', { class: 'inline-flex items-center gap-2 text-xs' },
    dot(x.color), el('span', { class: 'font-semibold', text: x.name }), el('span', { class: 'text-fg-muted', text: `${pctText(x.value, total)} · ${formatNumber(x.value)}` }))));
  return [bar, legend];
}

/** Labeled meter: "Public 40 (66.7%)" + thin bar. */
function meter(label, value, total, color) {
  const fill = el('span', { class: 'meter-fill' });
  fill.style.width = `${total ? (value / total) * 100 : 0}%`;
  fill.style.backgroundColor = color;
  return el('div', { class: 'space-y-1' },
    el('div', { class: 'flex items-center gap-2 text-sm' }, dot(color), el('span', { text: label }),
      el('span', { class: 'ml-auto tabular-nums text-fg-muted', text: `${formatNumber(value)} · ${pctText(value, total)}` })),
    el('div', { class: 'meter', role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(value) }, fill));
}

/** Box list with thin bars: items = [{ label, value, display, href, language }] */
function barList(title, items, { ariaLabel, note }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  const ul = el('ol', { class: 'm-0 p-0', 'aria-label': ariaLabel });
  if (!items.length) ul.append(el('li', { class: 'Box-row text-sm text-fg-muted', text: 'No data' }));
  for (const it of items) {
    const fill = el('span', { class: 'meter-fill' });
    fill.style.width = `${max ? Math.max(1, (it.value / max) * 100) : 0}%`;
    fill.style.backgroundColor = it.language ? langColor(it.language) : 'var(--accent-fg)';
    ul.append(el('li', { class: 'Box-row py-2 space-y-1' },
      el('div', { class: 'flex min-w-0 items-center gap-3 text-sm' },
        el('a', { href: it.href, target: '_blank', rel: 'noopener noreferrer', class: 'min-w-0 truncate', text: it.label, title: it.label }),
        el('span', { class: 'ml-auto shrink-0 tabular-nums text-xs text-fg-muted', text: it.display })),
      el('div', { class: 'meter meter--thin', 'aria-hidden': 'true' }, fill)));
  }
  return el('section', { class: 'Box min-w-0 cv-auto', 'aria-label': title },
    el('div', { class: 'Box-header' }, el('h2', { class: 'Box-title', text: title })),
    ul, note ? el('div', { class: 'Box-footer py-2 text-xs text-fg-muted', text: note }) : null);
}

let memo = { version: -1, repos: null, len: -1, result: null };
let version = 0;
/** computeAnalytics memoized per repo-list version (bumped on every `repos` event) + identity/length. */
function analyticsFor(repos, now) {
  if (memo.version !== version || memo.repos !== repos || memo.len !== repos.length) {
    memo = { version, repos, len: repos.length, result: computeAnalytics(repos, now) };
  }
  return memo.result;
}

export function renderAnalytics(host, repos, now = Date.now()) {
  clear(host);
  if (!state.reposLoaded) return host.append(el('div', { class: 'flash', role: 'status' }, spinner(), el('span', { text: 'Repositories are still loading…' })));
  const a = analyticsFor(repos, now);
  const t = a.totals;
  if (!t.repos) {
    return host.append(el('div', { class: 'Box' }, el('div', { class: 'Blankslate' }, icon('graph', { size: 24 }),
      el('h3', { class: 'Blankslate-title', text: 'No repositories loaded' }))));
  }
  host.append(el('div', { class: 'space-y-1' },
    el('h2', { class: 'm-0 text-xl font-semibold', text: 'Insights' }),
    el('p', { class: 'm-0 text-sm text-fg-muted', text: `Computed from ${formatNumber(t.repos)} loaded repositories.` })));

  host.append(el('div', { class: 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6' },
    tile('repo', 'Repositories', formatNumber(t.repos), `${formatNumber(t.active)} active`),
    tile('star', 'Stars', formatNumber(t.stars), 'received'),
    tile('database', 'Storage', formatBytesFromKB(t.sizeKB), 'GitHub-reported size'),
    tile('issue-opened', 'Open issues', formatNumber(t.openIssues), 'incl. pull requests'),
    tile('fork', 'Forks', formatNumber(t.forks), `${formatNumber(t.forkCount)} forks of your repos`),
    tile('archive', 'Archived', formatNumber(t.archived), pctText(t.archived, t.repos))));

  const langSegs = topLanguages(a.languages, 12).map((l) => ({
    name: l.grouped ? `Other (${l.grouped})` : l.name, value: l.count,
    color: l.grouped ? '#6e7681' : langColor(l.name),
  }));
  host.append(card('Languages', ...segmentedBar(langSegs, 'Languages'),
    el('p', { class: 'm-0 text-xs text-fg-muted', text: `${formatNumber(a.languages.length)} languages · primary language per repository as reported by GitHub; repositories without a detected language count as Unknown.` })));

  host.append(el('div', { class: 'grid gap-4 md:grid-cols-2' },
    card('Visibility',
      meter('Public', t.public, t.repos, 'var(--success-fg)'),
      meter('Private', t.private, t.repos, 'var(--attention-fg)')),
    card('Sources, forks & archive',
      meter('Sources', t.sources, t.repos, 'var(--accent-fg)'),
      meter('Forks', t.forks, t.repos, 'var(--done-fg)'),
      meter('Archived', t.archived, t.repos, 'var(--fg-muted)'))));

  host.append(el('div', { class: 'grid gap-4 lg:grid-cols-3' },
    barList('Top starred', a.byStars.map((r) => ({ label: r.full_name, value: r.stargazers_count || 0, display: `★ ${formatNumber(r.stargazers_count || 0)}`, href: r.html_url, language: r.language })), { ariaLabel: 'Top repositories by stars' }),
    barList('Largest', a.bySize.map((r) => ({ label: r.full_name, value: r.size || 0, display: formatBytesFromKB(r.size), href: r.html_url, language: r.language })), { ariaLabel: 'Largest repositories' }),
    barList('Oldest untouched', a.oldest.map(({ repo, days }) => ({ label: repo.full_name, value: days, display: `${formatNumber(days)} d · ${formatDate(repo.pushed_at)}`, href: repo.html_url, language: repo.language })),
      { ariaLabel: 'Repositories with the oldest last push', note: 'Days since last push. Archived repositories are excluded.' })));
}

export function initAnalytics(section) {
  let dirty = true;
  let raf = 0;
  const render = () => { dirty = false; renderAnalytics(section, state.repos); };
  on('repos', () => {
    version++;
    dirty = true;
    if (state.activeTab !== 'analytics' || raf) return; // hidden: render on tab switch
    raf = requestAnimationFrame(() => { raf = 0; if (dirty && state.activeTab === 'analytics') render(); });
  });
  on('tab', (tab) => { if (tab === 'analytics' && dirty) render(); });
  // Idle pre-render while hidden (after the list is fully loaded) so the first switch is cheap.
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  let prerendered = false; // once, after the initial load – never during bulk runs
  on('repos', () => {
    if (prerendered || !state.reposLoaded) return;
    prerendered = true;
    idle(() => { if (dirty && state.activeTab !== 'analytics') render(); }, { timeout: 2000 });
  });
  if (state.activeTab === 'analytics') render();
}
