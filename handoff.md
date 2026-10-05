# HANDOFF — PROJECT COMPLETE
Updated: 2026-10-05T19:25Z · Last task touched: T11 · Branch: main

## Task status
| ID | Task | Status | Commit |
|----|------|--------|--------|
| T0 | Scaffold & config | done | ae3de79 |
| T1 | Session crypto & OAuth flow | done | 02675de |
| T2 | GitHub client & repo list endpoint | done | f89dd18 |
| T3 | Frontend shell & glass UI | done | 80d4af5 |
| T4 | Repository dashboard | done | 4914a23 |
| T5 | Bulk engine & safety modals | done | 42634a3 |
| T6 | Bulk actions: visibility/archive/topics/delete | done | 606eb7d |
| T7 | Bulk transfer | done | 5881df0 |
| T8 | Cleanup tools | done | 0640fd8 |
| T9 | Analytics | done | 994c346 |
| T10 | Security & quality review | done | 89d3230 |
| T11 | Docs & final QA | done | 8143228 |

## Current / next action
All tasks T0–T11 are done. Remaining work is user-side only (see "User actions required"). If a live-deploy
bug is reported, add it under "Known issues", fix it, and update the affected task row.
Final QA: `npm run build` OK, `npm test` 64/64 pass, UI CSP-clean in mock mode (Playwright, 0 console errors).

## Security checklist (T10, verified 2026-10-05)
- [x] No `console.*` in lib/ api/ public/ (only scripts/dev.sh generates a dev secret locally).
- [x] No `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`eval`; all DOM via `el()` + textContent/setAttribute.
- [x] No `localStorage`/`sessionStorage`/`indexedDB`/`document.cookie` in frontend; state in memory only.
- [x] `index.html`: no inline `<script>`, no `on*=` handlers, no `style=`; single `<script type=module src>`.
- [x] `vercel.json` headers match spec §7 exactly (CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy); dev server applies the same headers and the UI runs with zero console errors under that CSP (Playwright, mock mode).
- [x] `package.json`: runtime dep only `hono`; dev dep only `tailwindcss`; no DB/KV/storage packages.
- [x] Token only inside AES-256-GCM sealed HttpOnly cookie; `GitHubError.toJSON` forwards only a truncated upstream `message` string, never body/headers/token; OAuth failures redirect with short codes only.
- [x] OAuth `state` cookie checked with `timingSafeEqual`; state cookie cleared on callback.
- [x] CSRF middleware global in `lib/app.js`: all non-GET/HEAD/OPTIONS require `X-GM-CSRF: 1` + `Origin === appOrigin`.
- [x] Only allow-listed routes exist; `validateTarget` (owner/repo regex) on every `/repos/:owner/:repo*` route; branch/topic/new_owner/new_name validated; PATCH body keys restricted to `private`/`archived`; default/protected branches refused server-side (409) and disabled in UI.
- [x] `Cache-Control: no-store` on all `/api/*` responses; GitHub 401 clears cookie → UI returns to login.
- [x] A11y: skip link, `:focus-visible` ring, modals `role=dialog aria-modal` with focus trap, Esc/backdrop close, focus restore; all inputs labelled (`aria-label` or wrapping `<label>`); progress bars `role=progressbar` with values; live regions for counts/toasts; cleanup tabs now full WAI-ARIA tabs pattern (fixed in T10).

## Key facts
- Entry pattern: `api/[...route].js` → `import { handle } from 'hono/vercel'`, `export const config = { runtime: 'edge' }`,
  `export default handle(app)`. App in `lib/app.js` with `new Hono().basePath('/api')`. Import verified locally;
  edge deploy on Vercel NOT yet verified (see Known issues).
- Versions installed: hono 4.13.x, tailwindcss 3.4.x, Node 22 local (engines >=20).
- Module map:
  - `lib/app.js` → Hono app; middlewares: no-store, CSRF (non-GET needs `X-GM-CSRF: 1` + Origin === appOrigin); routes; `onError` maps `GitHubError` → JSON, clears cookie on 401.
  - `lib/session.js` → `seal/unseal(payload, secretB64)`, `makeSessionPayload`, `randomBase64Url`, `timingSafeEqual`, cookie helpers (`set/clear/readSessionCookie`, `set/read/clearStateCookie`), `sessionCookieName(url)`.
  - `lib/oauth.js` → `getEnv(c)` (c.env if has SESSION_SECRET else process.env), `appOrigin(c)`, handlers `login/callback/logout/me`, middleware `requireSession` (sets `c.var.session = {token, login, id}`).
  - `lib/github.js` → `ghFetch(token, path, {method, body, okStatuses, headers})` → `{status, data, rate, headers}`; throws `GitHubError(status, code, message, {retryAfter, rate})`; `mapError`, `rateInfo`, `applyRateHeaders(c, rate)`.
  - `lib/validate.js` → `isValidOwner/Repo/Branch`, `encodeBranch`, `normalizeTopic(s)`, `parsePositiveInt`, `MAX_TOPICS`.
  - `lib/repos.js` → `trimRepo`, `validateTarget` middleware (sets `c.var.target = {owner, repo, path}`), `listRepos`, `patchRepo`, `deleteRepo`, `mergeTopics` (pure), `putTopics`, `transferRepo`, `emptyCheck`, `listBranches` (GET repo → default branch; paginate branches ≤10 pages; per branch compare + commit date), `deleteBranch` (fetches repo + branch first; 409 `protected_branch` for default/protected), helpers `readJsonBody(c)`, `bad(c, msg)` (400 `bad_request`).
  - `lib/branches.js` → pure `classifyBranch(b, staleDays, now)` → `{merged, stale, ageDays, deletable}` (deletable = !default && !protected), `classifyBranches`, `DEFAULT_STALE_DAYS=90`.
  - `api/[...route].js` → thin Vercel edge entry.
  - `src/styles.css` → Tailwind + components: `.glass .glass-strong .btn .btn-primary .btn-ghost .btn-danger .btn-warn .input .badge .badge-ok .badge-warn .badge-danger .progress .progress-bar`.
  - `public/index.html` → views `#view-loading/#view-landing/#view-dashboard`, header (avatar `#user-avatar`, `#user-login`, `#rate-badge`, `#btn-logout`), tab buttons `[data-tab]`, sections `#tab-repos` (`#repos-panel`), `#tab-cleanup`, `#tab-analytics`, `#toasts`, `#modal-root`. Script: `/assets/js/main.js` (module).
  - `public/assets/js/ui.js` → `el(tag, attrs, ...children)` (attrs: class, text, onClick…, dataset), `append`, `clear`, `show(node, bool)`, `$`, `$$`, `svg`, `formatNumber`, `formatBytesFromKB`, `formatDate`, `daysSince`, `debounce`, `sleep(ms, signal)`.
  - `public/assets/js/state.js` → `state` {user, repos, selection:Set, rate, activeTab}, `on/emit` events (`user`, `rate`, `repos`, `selection`, `tab`, `unauthorized`), `hasScope`, `setUser`, `setRate`, `setRepos`, `removeRepos`, `updateRepo`, `setSelection`, `toggleSelected`, `clearSelection`, `selectedRepos`, `setTab`.
  - `public/assets/js/api.js` → `api/get/post/patch/put/del`, `ApiError` (status, code, retryAfter, isRateLimit), `describeError(err)`; emits `unauthorized` on 401; reads X-RateLimit headers.
  - `public/assets/js/toast.js` → `toast(msg, kind)`, `success/error/info`.
  - `public/assets/js/main.js` → bootstrap (`/api/me`), views, tabs, logout, `?error=` toasts; dynamically imports `dashboard.js`.
  - `public/assets/js/dashboard.js` → `initDashboard()`: creates `bulkPanel.instance = new BulkPanel($('#bulk-panel'))` (exported), mounts `initGrid(#repos-panel)`, `initActions(bulkPanel)`, `initCleanup(#tab-cleanup)`, `initAnalytics(#tab-analytics)`.
  - `public/assets/js/analytics.js` → pure `computeAnalytics(repos, now)` → `{totals, languages, byStars, bySize, oldest}`, `topLanguages(langs, max)` (groups tail into Other), `renderAnalytics(host, repos)` (SVG donuts via `svg()`, CSS bars, stat cards), `initAnalytics(section)` re-renders on `repos`.
  - `public/assets/js/cleanup.js` → `initCleanup(section)`: own `BulkPanel` + tabs Forks / Empty repos / Branches (module-level selection Sets + `branchResults` Map survive re-renders; re-mounts on `repos` event unless a bulk run is active). Empty scan sets `repo.isEmpty` in place then emits `repos`. Branch delete URL = `${repoPath}/branches/${segments encoded}`. UI mirror `isBranchDeletable(b)`.
  - `public/assets/js/actions.js` → listens `bulk-action`; `runVisibility/runArchive/runDelete/runTopics/runTransfer` (modal → `bulkPanel.run` with `writeOptions()` → `updateRepo/removeRepos`); `updateScopeState()` disables `[data-action]` buttons lacking scope (`delete_repo`/`repo`) with explanatory title; `repoPath(r)` helper.
  - `public/assets/js/bulk.js` → pure `runBulk(items, fn, {concurrency, minGapMs, signal, onProgress, now, sleep})` → `{results:[{item,key,status,value,error,errorCode,attempts}], cancelled}`; `writeOptions()` (1 worker, 1000 ms gap), `readOptions()` (4 workers); `BulkPanel.run({title, action, items, perItemFn, options, onItemOk, onFinish})` renders progress/cancel/retry/log; `buildLog`, `downloadJson`, `labelOf`.
  - `public/assets/js/modals.js` → `openModal({title, build, confirmLabel, confirmClass, danger})` (focus trap, Esc/backdrop close → null), `confirmDelete(repos)`, `confirmMakePublic(repos)`, `confirmTransfer(repos, newOwner)`, `confirmSimple({title, message, repos, confirmLabel, confirmClass})`, `promptText({title, label, validate, hint})` → string|null.
  - `public/assets/js/grid.js` → `loadAllRepos(onProgress)` (pages until `hasMore` false → `setRepos`), pure `applyFilters(repos, filters, login)`, `affiliationOf`, `isLikelyEmpty` (uses `repo.isEmpty` if set by cleanup scan, else size===0), `initGrid(panel)` (toolbar, selection bar with action buttons emitting `bulk-action`, table 50/page, shift-click, select-all-filtered, Reload). Listens to `repos`/`selection` events so later mutations re-render automatically.
  - `scripts/dev-server.js` → Node static+API server applying vercel.json headers; `GM_MOCK=1` loads `scripts/mock-github.js` (in-memory fake GitHub, 240 repos). `npm run dev:mock` (scripts/dev.sh) = zero-config local run. In mock mode `/api/auth/login` redirects straight to the callback (no GitHub hop), so opening `/api/auth/login` logs you in.
  - `test/app.test.js` → smoke tests using `app.request()`; `test/grid.test.js` → filter/sort tests; `test/bulk.test.js` → runner sequencing/gap/cancel/rate-retry with a virtual clock (both stub `globalThis.document`); `test/mutations.test.js` → PATCH/DELETE/topics routes + CSRF (helper `authed(path, {method, json})` adds CSRF+Origin); `test/cleanup.test.js` → classifier + empty-check/branches/delete-branch routes; `test/analytics.test.js` → computeAnalytics/topLanguages.
- Implemented endpoints: `GET /api/health`, `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout`, `GET /api/me`, `GET /api/repos?page=N` → `{page, items, hasMore, rate}`, `PATCH /api/repos/:o/:r` (`{private?, archived?}` → `{repo, rate}`), `DELETE /api/repos/:o/:r` (204), `PUT /api/repos/:o/:r/topics` (`{mode, names}` → `{topics, rate}`), `POST /api/repos/:o/:r/transfer` (`{new_owner, new_name?}` → 202 `{pending, repo, rate}`), `GET /api/repos/:o/:r/empty-check` → `{empty, rate}`, `GET /api/repos/:o/:r/branches?stale_days=N` → `{defaultBranch, staleDays, branches:[{name, protected, isDefault, aheadBy, behindBy, lastCommitDate, merged, stale, ageDays, deletable}], rate}`, `DELETE /api/repos/:o/:r/branches/:branch{.+}` (204; 409 `protected_branch`).
- Error JSON shape: `{error: <code>, message, status, retryAfter?, rate?}`; codes: unauthorized, rate_limited(429), protected_branch(409), forbidden, not_found, conflict, unprocessable, upstream_error, network_error, csrf, bad_origin, invalid_target.
- Conventions: tests use `app.request(url, init, ENV)` with mocked `globalThis.fetch` (see test/repos.test.js helpers `authed`, `mockFetch`). Test script: `node --test "test/**/*.test.js"`.
  Built CSS `public/assets/styles.css` is gitignored (Vercel builds it via `npm run build`).
- Tailwind config uses `export default` (package is ESM); color palette `ink-950/900/800/700`.

## Decisions & deviations from the prompt
- Added `scripts/dev-server.js` + `scripts/mock-github.js` (dev-only, no deps, never imported by lib/api) so the UI can be verified without Vercel CLI or real OAuth. CSP-clean verified via Playwright on the landing view.
- `public/assets/styles.css` is gitignored and produced at build time (keeps diffs clean).
- Test script uses a glob instead of `node --test test/` (directory arg not supported by Node 22).
- `hono/adapter` `env()` ignores `c.env` on Node/edge, so `getEnv` reads `c.env` first (tests) then `process.env` (Vercel).
- Mutating-route CSRF check compares Origin with `appOrigin(c)` (APP_URL if set, else request origin).
- Branch scan runs with concurrency 2 (each repo scan is many upstream calls); branch list capped at 1000 branches/repo. Branch URLs keep `/` between encoded segments (spec 5.4), so the route uses Hono `:branch{.+}`.
- Cleanup tab has its own BulkPanel instance (progress shown inside the Cleanup tab, not the Repositories tab).

## Known issues / unverified
- E2E of cleanup + analytics tabs verified only against the mock GitHub (Playwright, zero console errors); real-GitHub edge cases (e.g. compare 404 on unrelated histories → aheadBy null → not merged) handled but untested live.
- Edge runtime + `hono/vercel` on real Vercel deploy not verified from sandbox (no Vercel access). If `/api/health`
  fails after deploy, fall back: remove `config` export and use the Node pattern (`export const GET = handle(app)` etc.).

## User actions required
- [ ] Run README "Manual QA checklist" against the live deployment with a throwaway repo.
- [ ] Import repo into Vercel (framework: Other; build = `npm run build`, output = `public`) and deploy; check `/api/health`.
- [ ] Create GitHub OAuth App: homepage `https://<domain>`, callback `https://<domain>/api/auth/callback`.
- [ ] Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` (base64 of 32 random bytes), optional `APP_URL` in Vercel; redeploy.

## How to run / verify
```
npm install
npm run build   # → public/assets/styles.css
npm test
npm run dev     # vercel dev (needs Vercel CLI + .env)
PORT=3077 npm run dev:mock   # fake GitHub, open /api/auth/login to sign in
```
