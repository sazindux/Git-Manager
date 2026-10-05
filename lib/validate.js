// Strict validators for every path/body parameter forwarded to GitHub.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export const MAX_TOPICS = 20;

export function isValidOwner(v) {
  return typeof v === 'string' && OWNER_RE.test(v);
}

export function isValidRepo(v) {
  return typeof v === 'string' && REPO_RE.test(v) && v !== '.' && v !== '..';
}

export function isValidBranch(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 255) return false;
  if (CONTROL_RE.test(v) || v.includes('..')) return false;
  if (v.startsWith('/') || v.endsWith('/') || v.includes('//')) return false;
  if (/[ ~^:?*[\\]/.test(v)) return false; // git ref-name forbidden chars
  if (v.endsWith('.lock') || v.endsWith('.')) return false;
  return true;
}

/** Encode a branch for a GitHub URL: each '/'-separated segment via encodeURIComponent. */
export function encodeBranch(branch) {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/** Lowercase + trim; returns null when invalid. */
export function normalizeTopic(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return TOPIC_RE.test(t) ? t : null;
}

/**
 * Normalize a list of topics. Returns { ok: true, topics } (deduped, ≤ MAX_TOPICS)
 * or { ok: false, error }.
 */
export function normalizeTopics(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'topics must be an array' };
  const out = [];
  for (const raw of list) {
    const t = normalizeTopic(raw);
    if (t === null) return { ok: false, error: `invalid topic: ${String(raw).slice(0, 60)}` };
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TOPICS) return { ok: false, error: `at most ${MAX_TOPICS} topics allowed` };
  return { ok: true, topics: out };
}

export function parsePositiveInt(v, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}
