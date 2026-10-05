import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidOwner, isValidRepo, isValidBranch, encodeBranch, normalizeTopic, normalizeTopics, parsePositiveInt,
} from '../lib/validate.js';

test('owner validation', () => {
  for (const ok of ['a', 'octocat', 'my-org-1', 'A'.repeat(39)]) assert.equal(isValidOwner(ok), true, ok);
  for (const bad of ['', '-a', 'a_b', 'a.b', '..', '../x', '%2e%2e', 'a/b', 'A'.repeat(40), null, 42, 'a b']) {
    assert.equal(isValidOwner(bad), false, String(bad));
  }
});

test('repo validation', () => {
  for (const ok of ['x', 'my.repo', 'my_repo-2', 'a'.repeat(100), '.github', '...x']) assert.equal(isValidRepo(ok), true, ok);
  for (const bad of ['', '.', '..', 'a/b', 'a b', 'a%2e', 'a'.repeat(101), '../etc', 'repo?x=1', 'repo#1', undefined]) {
    assert.equal(isValidRepo(bad), false, String(bad));
  }
});

test('branch validation', () => {
  for (const ok of ['main', 'feature/x-1', 'release/v1.2.3', 'ünïcödé', 'a'.repeat(255)]) assert.equal(isValidBranch(ok), true, ok);
  for (const bad of ['', '..', 'a..b', 'feat/../main', '/lead', 'trail/', 'a//b', 'has space', 'tab\there', 'a\u0000b',
    'x~1', 'x^2', 'x:y', 'x?y', 'x*y', 'x[y', 'back\\slash', 'ends.lock', 'ends.', 'a'.repeat(256), null]) {
    assert.equal(isValidBranch(bad), false, JSON.stringify(bad));
  }
});

test('encodeBranch encodes segments but keeps slashes', () => {
  assert.equal(encodeBranch('feature/x#1'), 'feature/x%231');
  assert.equal(encodeBranch('ünï/cödé'), '%C3%BCn%C3%AF/c%C3%B6d%C3%A9');
  assert.equal(encodeBranch('main'), 'main');
});

test('topic normalization', () => {
  assert.equal(normalizeTopic('  JavaScript '), 'javascript');
  assert.equal(normalizeTopic('web-dev'), 'web-dev');
  assert.equal(normalizeTopic('-bad'), null);
  assert.equal(normalizeTopic('under_score'), null);
  assert.equal(normalizeTopic(''), null);
  assert.equal(normalizeTopic('a'.repeat(51)), null);
  assert.equal(normalizeTopic(5), null);
});

test('normalizeTopics dedupes, limits and rejects invalid', () => {
  assert.deepEqual(normalizeTopics(['A', 'a', 'b']), { ok: true, topics: ['a', 'b'] });
  assert.equal(normalizeTopics('x').ok, false);
  assert.equal(normalizeTopics(['ok', 'not ok']).ok, false);
  assert.equal(normalizeTopics(Array.from({ length: 21 }, (_, i) => `t${i}`)).ok, false);
  assert.equal(normalizeTopics(Array.from({ length: 20 }, (_, i) => `t${i}`)).ok, true);
});

test('parsePositiveInt', () => {
  assert.equal(parsePositiveInt(undefined, 1), 1);
  assert.equal(parsePositiveInt('', 1), 1);
  assert.equal(parsePositiveInt('5', 1), 5);
  assert.equal(parsePositiveInt('0', 1), null);
  assert.equal(parsePositiveInt('1.5', 1), null);
  assert.equal(parsePositiveInt('abc', 1), null);
  assert.equal(parsePositiveInt('1000', 1, { max: 999 }), null);
});
