import { test } from 'node:test';
import assert from 'node:assert/strict';

// grid.js imports browser-only helpers; stub `document` minimal surface is not needed because
// applyFilters/affiliationOf are pure and only evaluated lazily. Import via a tiny shim.
globalThis.document ??= { createElement() { return {}; }, createTextNode() { return {}; } };
const { applyFilters, affiliationOf, isLikelyEmpty } = await import('../public/assets/js/grid.js');

const base = { q: '', visibility: 'all', kind: 'all', archived: 'all', affiliation: 'all', language: 'all', emptyOnly: false, sort: 'pushed', dir: 'desc' };
const repos = [
  { id: 1, full_name: 'me/alpha', owner: { login: 'me', type: 'User' }, private: false, fork: false, archived: false, language: 'JavaScript', stargazers_count: 5, forks_count: 1, size: 10, pushed_at: '2025-01-01T00:00:00Z', topics: ['web'], description: 'first' },
  { id: 2, full_name: 'me/beta', owner: { login: 'me', type: 'User' }, private: true, fork: true, archived: false, language: null, stargazers_count: 50, forks_count: 0, size: 0, pushed_at: '2025-03-01T00:00:00Z', topics: [], description: null },
  { id: 3, full_name: 'acme/gamma', owner: { login: 'acme', type: 'Organization' }, private: false, fork: false, archived: true, language: 'Go', stargazers_count: 1, forks_count: 9, size: 999, pushed_at: '2024-01-01T00:00:00Z', topics: ['cli', 'tool'], description: 'Gamma tool' },
  { id: 4, full_name: 'friend/delta', owner: { login: 'friend', type: 'User' }, private: false, fork: false, archived: false, language: 'Go', stargazers_count: 0, forks_count: 0, size: 3, pushed_at: '2023-06-01T00:00:00Z', topics: [], description: '' },
];

test('affiliation classification', () => {
  assert.equal(affiliationOf(repos[0], 'me'), 'owner');
  assert.equal(affiliationOf(repos[2], 'me'), 'org');
  assert.equal(affiliationOf(repos[3], 'me'), 'collaborator');
});

test('filters: visibility, kind, archived, affiliation, language, empty', () => {
  const ids = (f) => applyFilters(repos, { ...base, ...f }, 'me').map((r) => r.id);
  assert.deepEqual(ids({ visibility: 'private' }), [2]);
  assert.deepEqual(ids({ kind: 'fork' }), [2]);
  assert.deepEqual(ids({ archived: 'archived' }), [3]);
  assert.deepEqual(ids({ affiliation: 'org' }), [3]);
  assert.deepEqual(ids({ affiliation: 'collaborator' }), [4]);
  assert.deepEqual(ids({ language: 'Unknown' }), [2]);
  assert.deepEqual(ids({ language: 'Go', sort: 'name', dir: 'asc' }), [3, 4]);
  assert.deepEqual(ids({ emptyOnly: true }), [2]);
  assert.equal(isLikelyEmpty({ size: 0, isEmpty: false }), false);
});

test('search matches name, description and topics (case-insensitive)', () => {
  const ids = (q) => applyFilters(repos, { ...base, q }, 'me').map((r) => r.id);
  assert.deepEqual(ids('ALPHA'), [1]);
  assert.deepEqual(ids('tool'), [3]);
  assert.deepEqual(ids('first'), [1]);
  assert.deepEqual(ids('nothing-here'), []);
});

test('sorting by stars/size/pushed/name with direction', () => {
  const ids = (f) => applyFilters(repos, { ...base, ...f }, 'me').map((r) => r.id);
  assert.deepEqual(ids({ sort: 'stars', dir: 'desc' }), [2, 1, 3, 4]);
  assert.deepEqual(ids({ sort: 'size', dir: 'asc' }), [2, 4, 1, 3]);
  assert.deepEqual(ids({ sort: 'pushed', dir: 'desc' }), [2, 1, 3, 4]);
  assert.deepEqual(ids({ sort: 'name', dir: 'asc' }), [3, 4, 1, 2]);
});
