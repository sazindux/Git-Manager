// Live analytics computed from the in-memory repo list. Hand-written SVG charts, no library.
import { el, svg, clear, formatNumber, formatBytesFromKB, formatDate, daysSince } from './ui.js';
import { state, on } from './state.js';

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

const PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#f472b6', '#2dd4bf', '#f97316', '#94a3b8'];

// --- rendering --------------------------------------------------------------------------------

function donut(segments, { size = 160, stroke = 22, label, sublabel }) {
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0);
  const root = svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': label ? `${label}: ${sublabel || ''}` : 'Donut chart', class: 'shrink-0' });
  root.append(svg('circle', { cx: c, cy: c, r, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': stroke }));
  let offset = 0;
  if (total > 0) {
    segments.forEach((s, i) => {
      if (!s.value) return;
      const len = (s.value / total) * circ;
      const seg = svg('circle', {
        cx: c, cy: c, r, fill: 'none', stroke: s.color || PALETTE[i % PALETTE.length], 'stroke-width': stroke,
        'stroke-dasharray': `${len} ${circ - len}`, 'stroke-dashoffset': -offset, transform: `rotate(-90 ${c} ${c})`,
      }, svg('title', {}, `${s.name}: ${formatNumber(s.value)}`));
      root.append(seg);
      offset += len;
    });
  }
  if (label !== undefined) {
    root.append(svg('text', { x: c, y: c - 4, 'text-anchor': 'middle', fill: '#f1f5f9', 'font-size': '22', 'font-weight': '600' }, label));
    if (sublabel) root.append(svg('text', { x: c, y: c + 16, 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': '11' }, sublabel));
  }
  return root;
}

function legend(segments) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return el('ul', { class: 'space-y-1 text-sm', 'aria-label': 'Legend' }, ...segments.map((s, i) => el('li', { class: 'flex items-center gap-2' },
    (() => { const dot = el('span', { class: 'inline-block h-2.5 w-2.5 shrink-0 rounded-full', 'aria-hidden': 'true' }); dot.style.backgroundColor = s.color || PALETTE[i % PALETTE.length]; return dot; })(),
    el('span', { class: 'truncate text-slate-200', text: s.name }),
    el('span', { class: 'ml-auto tabular-nums text-slate-400', text: `${formatNumber(s.value)} · ${total ? Math.round((s.value / total) * 100) : 0}%` }))));
}

/** Horizontal bars: items = [{ label, value, display, href }] */
function bars(items, { ariaLabel }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  const ul = el('ul', { class: 'space-y-2', 'aria-label': ariaLabel });
  if (!items.length) ul.append(el('li', { class: 'text-sm text-slate-400', text: 'No data' }));
  items.forEach((it, i) => {
    const bar = el('div', { class: 'h-2 rounded-full', role: 'presentation' });
    bar.style.width = `${max ? Math.max(2, Math.round((it.value / max) * 100)) : 0}%`;
    bar.style.backgroundColor = PALETTE[i % PALETTE.length];
    const name = it.href
      ? el('a', { href: it.href, target: '_blank', rel: 'noopener noreferrer', class: 'truncate text-sky-300 hover:underline', text: it.label, title: it.label })
      : el('span', { class: 'truncate text-slate-200', text: it.label, title: it.label });
    ul.append(el('li', { class: 'space-y-1 text-sm' },
      el('div', { class: 'flex items-center gap-3' }, name, el('span', { class: 'ml-auto shrink-0 tabular-nums text-slate-400', text: it.display ?? formatNumber(it.value) })),
      el('div', { class: 'h-2 w-full rounded-full bg-white/5' }, bar)));
  });
  return ul;
}

function statCard(label, value, hint) {
  return el('div', { class: 'glass p-4' },
    el('p', { class: 'text-xs uppercase tracking-wide text-slate-400', text: label }),
    el('p', { class: 'mt-1 text-2xl font-semibold tabular-nums', text: value }),
    hint ? el('p', { class: 'mt-1 text-xs text-slate-400', text: hint }) : null);
}

function card(title, ...children) {
  return el('section', { class: 'glass p-5 space-y-3', 'aria-label': title }, el('h2', { class: 'text-base font-semibold', text: title }), ...children);
}

export function renderAnalytics(host, repos, now = Date.now()) {
  clear(host);
  if (!state.reposLoaded) return host.append(el('div', { class: 'glass p-5' }, el('p', { class: 'text-slate-300', text: 'Repositories are still loading…' })));
  const a = computeAnalytics(repos, now);
  const t = a.totals;
  if (!t.repos) return host.append(el('div', { class: 'glass p-5' }, el('p', { class: 'text-slate-300', text: 'No repositories loaded.' })));
  const pct = (n) => `${Math.round((n / t.repos) * 100)}%`;

  host.append(el('div', { class: 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4' },
    statCard('Repositories', formatNumber(t.repos), `${formatNumber(t.active)} active · ${formatNumber(t.archived)} archived`),
    statCard('Stars received', formatNumber(t.stars), `${formatNumber(t.forkCount)} forks of your repos`),
    statCard('Total storage', formatBytesFromKB(t.sizeKB), 'GitHub-reported size'),
    statCard('Open issues', formatNumber(t.openIssues), 'across all loaded repositories')));

  const langSegs = topLanguages(a.languages).map((l) => ({ name: l.name, value: l.count }));
  host.append(el('div', { class: 'grid gap-4 lg:grid-cols-3' },
    card('Visibility',
      el('div', { class: 'flex items-center gap-4' },
        donut([{ name: 'Public', value: t.public, color: PALETTE[0] }, { name: 'Private', value: t.private, color: PALETTE[1] }], { label: formatNumber(t.repos), sublabel: 'repos' }),
        legend([{ name: 'Public', value: t.public, color: PALETTE[0] }, { name: 'Private', value: t.private, color: PALETTE[1] }])),
      el('div', { class: 'flex flex-wrap gap-2' },
        el('span', { class: 'badge', text: `${pct(t.public)} public` }), el('span', { class: 'badge-warn', text: `${pct(t.private)} private` }))),
    card('Forks & archive',
      el('div', { class: 'flex items-center gap-4' },
        donut([{ name: 'Sources', value: t.sources, color: PALETTE[2] }, { name: 'Forks', value: t.forks, color: PALETTE[3] }], { label: formatNumber(t.forks), sublabel: 'forks' }),
        legend([{ name: 'Sources', value: t.sources, color: PALETTE[2] }, { name: 'Forks', value: t.forks, color: PALETTE[3] }])),
      el('div', { class: 'flex flex-wrap gap-2' },
        el('span', { class: 'badge-ok', text: `${formatNumber(t.active)} active` }), el('span', { class: 'badge', text: `${formatNumber(t.archived)} archived` }))),
    card('Languages',
      el('div', { class: 'flex items-center gap-4' },
        donut(langSegs, { label: formatNumber(a.languages.length), sublabel: 'languages' }),
        legend(langSegs)),
      el('p', { class: 'text-xs text-slate-400', text: 'Primary language per repository as reported by GitHub; repositories without a detected language count as Unknown.' }))));

  host.append(el('div', { class: 'grid gap-4 lg:grid-cols-3' },
    card('Top 10 by stars', bars(a.byStars.map((r) => ({ label: r.full_name, value: r.stargazers_count || 0, display: `${formatNumber(r.stargazers_count || 0)} ★`, href: r.html_url })), { ariaLabel: 'Top repositories by stars' })),
    card('Largest 10 by size', bars(a.bySize.map((r) => ({ label: r.full_name, value: r.size || 0, display: formatBytesFromKB(r.size), href: r.html_url })), { ariaLabel: 'Largest repositories' })),
    card('Oldest untouched (active)', bars(a.oldest.map(({ repo, days }) => ({ label: repo.full_name, value: days, display: `${formatNumber(days)} d · ${formatDate(repo.pushed_at)}`, href: repo.html_url })), { ariaLabel: 'Repositories with the oldest last push' }),
      el('p', { class: 'text-xs text-slate-400', text: 'Days since last push. Archived repositories are excluded.' }))));
}

export function initAnalytics(section) {
  const render = () => renderAnalytics(section, state.repos);
  render();
  on('repos', render);
}
