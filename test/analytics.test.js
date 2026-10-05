import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { createElement() { return {}; }, createTextNode() { return {}; } };
const { computeAnalytics, topLanguages, UNKNOWN_LANGUAGE } = await import('../public/assets/js/analytics.js');

const NOW = Date.parse('2026-10-05T00:00:00Z');
const d = (days) => new Date(NOW - days * 86400000).toISOString();
const repos = [
  { id: 1, full_name: 'me/a', private: false, fork: false, archived: false, language: 'JavaScript', stargazers_count: 10, forks_count: 2, open_issues_count: 1, size: 100, pushed_at: d(10) },
  { id: 2, full_name: 'me/b', private: true, fork: true, archived: false, language: null, stargazers_count: 0, forks_count: 0, open_issues_count: 0, size: 0, pushed_at: d(400) },
  { id: 3, full_name: 'me/c', private: true, fork: false, archived: true, language: '', stargazers_count: 5, forks_count: 1, open_issues_count: 2, size: 5000, pushed_at: d(900) },
  { id: 4, full_name: 'me/d', private: false, fork: false, archived: false, language: 'JavaScript', stargazers_count: 7, forks_count: 0, open_issues_count: 0, size: 300, pushed_at: null },
  { id: 5, full_name: 'me/e', private: false, fork: false, archived: false, language: 'Go', stargazers_count: undefined, forks_count: null, open_issues_count: 0, size: 50, pushed_at: d(200) },
];

test('computeAnalytics totals', () => {
  const { totals } = computeAnalytics(repos, NOW);
  assert.deepEqual(totals, { repos: 5, public: 3, private: 2, forks: 1, sources: 4, archived: 1, active: 4, stars: 22, forkCount: 3, openIssues: 3, sizeKB: 5450 });
});

test('language distribution treats null/empty as Unknown and sorts by count', () => {
  const { languages } = computeAnalytics(repos, NOW);
  assert.deepEqual(languages.map((l) => [l.name, l.count]), [['JavaScript', 2], [UNKNOWN_LANGUAGE, 2], ['Go', 1]]);
  assert.ok(Math.abs(languages[0].share - 0.4) < 1e-9);
});

test('top lists: stars, size, oldest untouched (active only, valid dates only)', () => {
  const a = computeAnalytics(repos, NOW);
  assert.deepEqual(a.byStars.map((r) => r.id), [1, 4, 3]); // zero-star repos excluded
  assert.deepEqual(a.bySize.map((r) => r.id), [3, 4, 1, 5]); // size 0 excluded
  assert.deepEqual(a.oldest.map((x) => [x.repo.id, x.days]), [[2, 400], [5, 200], [1, 10]]); // archived (3) + no date (4) excluded
});

test('empty input and non-array are safe', () => {
  assert.equal(computeAnalytics([], NOW).totals.repos, 0);
  assert.equal(computeAnalytics(null, NOW).languages.length, 0);
});

test('topLanguages groups the tail into Other', () => {
  const langs = Array.from({ length: 12 }, (_, i) => ({ name: `L${i}`, count: 12 - i, share: (12 - i) / 78 }));
  const top = topLanguages(langs, 8);
  assert.equal(top.length, 8);
  assert.equal(top[7].name, 'Other');
  assert.equal(top[7].count, 5 + 4 + 3 + 2 + 1);
  assert.equal(top[7].grouped, 5);
  assert.equal(topLanguages(langs.slice(0, 3), 8).length, 3);
});
