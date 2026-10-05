// Pure branch classification shared by the server route (and mirrored in the UI).
export const DEFAULT_STALE_DAYS = 90;

const DAY_MS = 86400000;

/**
 * Classify one branch.
 * @param {{name:string, protected?:boolean, isDefault?:boolean, aheadBy?:number|null, lastCommitDate?:string|null}} b
 * @param {number} staleDays
 * @param {number} [now]
 * @returns {{merged:boolean, stale:boolean, ageDays:number|null, deletable:boolean}}
 */
export function classifyBranch(b, staleDays = DEFAULT_STALE_DAYS, now = Date.now()) {
  const isDefault = !!b.isDefault;
  const isProtected = !!b.protected;
  const merged = !isDefault && Number.isInteger(b.aheadBy) && b.aheadBy === 0;
  let ageDays = null;
  if (b.lastCommitDate) {
    const t = Date.parse(b.lastCommitDate);
    if (!Number.isNaN(t)) ageDays = Math.max(0, Math.floor((now - t) / DAY_MS));
  }
  const days = Number.isFinite(staleDays) && staleDays > 0 ? staleDays : DEFAULT_STALE_DAYS;
  const stale = !isDefault && ageDays !== null && ageDays >= days;
  // Default and protected branches are never deletable, regardless of merge/age status.
  const deletable = !isDefault && !isProtected;
  return { merged, stale, ageDays, deletable };
}

/** Apply classifyBranch to a list; returns new objects with classification fields merged in. */
export function classifyBranches(list, staleDays, now) {
  return list.map((b) => ({ ...b, ...classifyBranch(b, staleDays, now) }));
}
