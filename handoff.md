# HANDOFF — UI UPGRADE PHASE (U0–U6)
Updated: 2026-10-06 · Last task touched: U2 · Work directly on `main` (Vercel auto-deploys on push)

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
| T12 | Fix /api 404 on Vercel | done (user: backend live) | cc0daa5 |
| U0 | Audit, Primer tokens & CSS foundation | done | 9c74392 |
| U1 | App shell & landing page | done | f9fce6f |
| U2 | Repositories list + performance core | done | 5be274f |
| U3 | Dialogs, bulk panel, toasts | pending | |
| U4 | Cleanup tab | pending | |
| U5 | Analytics tab | pending | |
| U6 | Performance pass, polish & final QA | pending | |

## Current / next action
UI phase (frontend only: `public/`, `src/styles.css`, `tailwind.config.js`, `scripts/mock-github.js`, tests).
Next: **U3** — restyle `modals.js` (Primer dialog: #161b22 bg, 12px radius, header+close icon, right footer,
backdrop rgba(1,4,9,.8) no blur, red `flash` on destructive; keep typed phrase + 3 s countdown + focus trap),
`BulkPanel` render in `bulk.js` (Box, 8px `.Progress`, per-item status icons, Cancel/Retry/Download) — do NOT touch
`runBulk`; `toast.js` → `.flash .flash-toast` + icon. Then U4 cleanup (lazy when hidden), U5 analytics.
U2 perf (Playwright, 1500 mock repos, `scripts/perf.mjs`, sync handler → next rAF): first rows 0.63 s, all 15 pages 1.9 s;
search 9 ms, toggle one 5, select page 11, select all 1500 matching 4, clear 3, next page 41 (30 new rows), tab→repos 12.
Remaining long tasks are from Cleanup (128 ms on switch) and Analytics (68 ms) re-rendering → fix in U4/U5.
QA: `GM_MOCK_REPOS=1500 PORT=3077 npm run dev:mock` + `PLAYWRIGHT_BROWSERS_PATH=0 node scripts/qa.mjs /tmp/x` / `scripts/perf.mjs`.
U0 baseline audit (lag sources, confirmed in code): body had 3 radial gradients + `background-attachment: fixed`;
`.glass/.glass-strong`, sticky header and grid selection bar used `backdrop-filter`; grid `renderRows()` does
`clear(tbody)` + rebuilds every cell on each `repos`/`selection` event; per-row listeners; analytics + cleanup
re-render on every `repos` event even when hidden; `.input` had `w-full` → stacked filter selects.
All gradients/blur removed in U0; render-path issues are U2/U4/U5 work.
Legacy class aliases (`.glass .input .badge* .btn-ghost .btn-warn .progress*`, Tailwind `ink-*`) map onto the
new components in `src/styles.css` so old markup still renders; delete them as each screen is rebuilt (U6 final).

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
- Entry pattern (T12 Approach B): `api/index.js` exports `{ fetch(request) { return app.fetch(request); } }`
  as default and `config = { runtime: 'nodejs' }`; `framework: null` pins Other; explicit rewrite
  `/api/:path*` → `/api/index`. `lib/app.js` retains `new Hono().basePath('/api')`.
  Node entry/paths/methods verified locally; original URL forwarding through Vercel's deployed rewrite
  still needs the user's health/login checks. Old edge catch-all removed; do not restore it.
  `public/` output, Tailwind buildCommand and security headers unchanged; no new dependencies.
- Versions installed: hono 4.13.x, tailwindcss 3.4.x, Node 22 local (engines >=20).
- Module map:
  - `lib/app.js` → Hono app; middlewares: X-GM-Function diagnostic, no-store, CSRF (non-GET needs `X-GM-CSRF: 1` + Origin === appOrigin); routes; `onError` maps `GitHubError` → JSON, clears cookie on 401.
  - `lib/session.js` → `seal/unseal(payload, secretB64)`, `makeSessionPayload`, `randomBase64Url`, `timingSafeEqual`, cookie helpers (`set/clear/readSessionCookie`, `set/read/clearStateCookie`), `sessionCookieName(url)`.
  - `lib/oauth.js` → `getEnv(c)` (c.env if has SESSION_SECRET else process.env), `appOrigin(c)`, handlers `login/callback/logout/me`, middleware `requireSession` (sets `c.var.session = {token, login, id}`).
  - `lib/github.js` → `ghFetch(token, path, {method, body, okStatuses, headers})` → `{status, data, rate, headers}`; throws `GitHubError(status, code, message, {retryAfter, rate})`; `mapError`, `rateInfo`, `applyRateHeaders(c, rate)`.
  - `lib/validate.js` → `isValidOwner/Repo/Branch`, `encodeBranch`, `normalizeTopic(s)`, `parsePositiveInt`, `MAX_TOPICS`.
  - `lib/repos.js` → `trimRepo`, `validateTarget` middleware (sets `c.var.target = {owner, repo, path}`), `listRepos`, `patchRepo`, `deleteRepo`, `mergeTopics` (pure), `putTopics`, `transferRepo`, `emptyCheck`, `listBranches` (GET repo → default branch; paginate branches ≤10 pages; per branch compare + commit date), `deleteBranch` (fetches repo + branch first; 409 `protected_branch` for default/protected), helpers `readJsonBody(c)`, `bad(c, msg)` (400 `bad_request`).
  - `lib/branches.js` → pure `classifyBranch(b, staleDays, now)` → `{merged, stale, ageDays, deletable}` (deletable = !default && !protected), `classifyBranches`, `DEFAULT_STALE_DAYS=90`.
  - `api/index.js` → thin Vercel Node Web Standard fetch entry; passes Request unchanged.
  - `src/styles.css` → Primer-dark `:root` tokens + `@layer components`: `.btn` (+`-primary -danger -danger-solid -invisible -octicon -link -sm -lg -block`), `.form-control` (+`-block -sm`, `select.` chevron via data-URI), `.search-input`, `.Box/-header/-title/-body/-row/-footer/-row--hover`, `.list-row` (content-visibility), `.Label` (+`--accent/success/attention/danger/done`), `.Counter`, `.topic`, `.lang-dot`, `.flash` (+`-success/-warn/-error/-toast`), `.dropdown/-menu/-item/-header/-divider`, `.UnderlineNav/-item`, `.SegmentedControl`, `.Pagination/-item`, `.Blankslate`, `.Progress/-item`, `.avatar`, `.app-mark`, text helpers, `.spinner`; legacy aliases at bottom.
  - `tailwind.config.js` → colors `canvas{,subtle,inset}`, `border{,muted}`, `fg{,muted,subtle}`, `accent{,link,emphasis}`, `success`, `danger`, `attention`, `done` (+ legacy `ink-*`); system font stacks.
  - `public/assets/js/icons.js` → `icon(name, {size, class, label})` Octicon-style SVG (names in `ICON_NAMES`), `spinner()`, `appMark(size)` neutral logo.
  - `public/assets/js/langcolors.js` → `LANG_COLORS`, `langColor(name)` (linguist or hashed hsl), `langDot(name)` (CSSOM bg).
  - `public/assets/js/config.js` → `APP_NAME = 'Git Manager'` (applied to title/header/landing by `main.js applyBranding()`).
  - `public/assets/js/main.js` (U1) → `applyBranding`, profile `createMenu` (login, scopes, GitHub profile, Sign out), `renderRate` (Label → attention <20%, danger <4%), `#count-repos` Counter on `repos`, WAI-ARIA tabs (`role=tab`, `aria-selected`, roving tabindex, ←/→/Home/End).
  - `scripts/perf.mjs` → dev-only Playwright timing probe (load, search, toggle, select page/all, pager, tab switches, long tasks).
  - `ui.js` adds `relativeTime(iso)` ("3 days ago" / "on Mar 5, 2024").
  - `scripts/qa.mjs` → dev-only Playwright screenshots (landing + 3 tabs @1280/390, optional profile menu) + console error count. Playwright is installed with `--no-save` (never in package.json); needs `sudo npx playwright install-deps chromium` once per sandbox.
  - `public/assets/js/menu.js` → `createMenu({label, icon, buttonClass, align, items, ariaLabel, selectable, title, buttonContent})` → `{root, button, menu, setLabel, refresh, open, close}`; items `{label, icon, danger, checked, disabled, meta, dot, multi, keepOpen, onSelect}` | `{divider}` | `{header}` | `{text}`; Arrow/Home/End/Esc/Tab, click-outside, focus return; one menu open at a time.
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
  - `public/assets/js/grid.js` (U2) → `loadAllRepos(onProgress)` (onProgress now also gets `items` so far), pure `applyFilters` (same semantics; WeakMap-cached lowercased haystack, decorate-sort; new sort key `updated`), `affiliationOf`, `isLikelyEmpty`. `initGrid(panel)`: filter row (search + `createMenu` Type/Language(dots+counts)/Owner/Sort(+direction) + Reload icon), results line + Clear filter, loading `flash` (`[data-loading-banner]`), Box list; header = select-page checkbox + count, turns into bulk bar (`N selected`, Select all M matching, Clear selection, `Actions ▾` emitting `bulk-action` with scope/loading-based disabling). Rows: `Map<id,{li,chk,body,sig}>`, body rebuilt only when `rowSig` changes; one delegated click listener on `ul` (shift-click range) + pager; all renders via rAF `schedule(kind)` with dirty flags (`data/langs/list/sel`), skipped while tab hidden and flushed on `tab` event. 30/page GitHub pager.
  - `scripts/dev-server.js` → Node static+API server applying vercel.json headers; `GM_MOCK=1` loads `scripts/mock-github.js` (in-memory fake GitHub; `GM_MOCK_REPOS` default 240, e.g. 1500; varied names/descriptions/topics/20 languages/forks/archived/empty/templates). `npm run dev:mock` (scripts/dev.sh) = zero-config local run. In mock mode `/api/auth/login` redirects straight to the callback (no GitHub hop), so opening `/api/auth/login` logs you in.
  - `test/app.test.js` → smoke tests using `app.request()`; `test/grid.test.js` → filter/sort tests; `test/bulk.test.js` → runner sequencing/gap/cancel/rate-retry with a virtual clock (both stub `globalThis.document`); `test/mutations.test.js` → PATCH/DELETE/topics routes + CSRF (helper `authed(path, {method, json})` adds CSRF+Origin); `test/cleanup.test.js` → classifier + empty-check/branches/delete-branch routes; `test/analytics.test.js` → computeAnalytics/topLanguages.
- Implemented endpoints: `GET /api/health`, `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout`, `GET /api/me`, `GET /api/repos?page=N` → `{page, items, hasMore, rate}`, `PATCH /api/repos/:o/:r` (`{private?, archived?}` → `{repo, rate}`), `DELETE /api/repos/:o/:r` (204), `PUT /api/repos/:o/:r/topics` (`{mode, names}` → `{topics, rate}`), `POST /api/repos/:o/:r/transfer` (`{new_owner, new_name?}` → 202 `{pending, repo, rate}`), `GET /api/repos/:o/:r/empty-check` → `{empty, rate}`, `GET /api/repos/:o/:r/branches?stale_days=N` → `{defaultBranch, staleDays, branches:[{name, protected, isDefault, aheadBy, behindBy, lastCommitDate, merged, stale, ageDays, deletable}], rate}`, `DELETE /api/repos/:o/:r/branches/:branch{.+}` (204; 409 `protected_branch`).
- Error JSON shape: `{error: <code>, message, status, retryAfter?, rate?}`; codes: unauthorized, rate_limited(429), protected_branch(409), forbidden, not_found, conflict, unprocessable, upstream_error, network_error, csrf, bad_origin, invalid_target.
- Conventions: tests use `app.request(url, init, ENV)` with mocked `globalThis.fetch` (see test/repos.test.js helpers `authed`, `mockFetch`). Test script: `node --test "test/**/*.test.js"`.
  Built CSS `public/assets/styles.css` is gitignored (Vercel builds it via `npm run build`).
- Tailwind config uses `export default` (package is ESM).

## Decisions & deviations from the prompt
- U0: work committed straight to `main` (UI-phase instruction), not the old PR branch. Test count is 68 (not 64; T12 added 4).
- U0: Playwright is not installed in the sandbox (no npm/pip package); only the remote console-capture tool is available → mock mode verified 0 console errors on 1500 repos; timings unmeasured so far. U1: installed Playwright locally via `npm i --no-save` + system deps → screenshots work; only expected console error is the `/api/me` 401 on the logged-out landing.
- U2: Actions menu is disabled while pages are still streaming in (avoids acting on a partial list). Default sort is now "Last updated" (`updated_at`), like GitHub. Owner/affiliation is a 4th `Owner ▾` menu; "Empty only" moved into `Type ▾ → Empty`. `actions.js updateScopeState()` now finds no `[data-action]` buttons (harmless; menu checks scopes itself) — remove in U6.
- U1: removed the header `#user-login` text and `#btn-logout` button; login + Sign out now live in the avatar dropdown (spec). Landing has no glass card; the GitHub mark appears only inside the sign-in button.
- U0: the sed pass added base `btn` to every legacy `btn-*` usage because new variants are modifiers (Primer style), not standalone.
- T12: chose B, not Hono zero-config A. Live shallow routes prove a deployed API function while nested
  paths miss it; README/handoff prescribe Other. Dashboard C is unknown, so explicitly pin Other rather
  than infer it. No root Hono entry or second competing deployment strategy added.
- Current docs consulted 2026-10-06: [NOT_FOUND](https://vercel.com/docs/errors/NOT_FOUND),
  [Node api/ functions](https://vercel.com/docs/functions/runtimes/node-js),
  [Web Standard fetch export](https://vercel.com/docs/functions/functions-api-reference#fetch-web-standard),
  [framework null and wildcard rewrites](https://vercel.com/docs/project-configuration/vercel-json),
  [Vercel Hono guide](https://vercel.com/docs/frameworks/backend/hono),
  [Hono Vercel guide](https://hono.dev/docs/getting-started/vercel). Both Hono guides support zero-config
  root/src entrypoints; Vercel documents public static assets. B avoids changing this project's static build.
- Required branch/PR workflow used, with pushed checkpoints squashed before PR updates; user requested main.
- Added `scripts/dev-server.js` + `scripts/mock-github.js` (dev-only, no deps, never imported by lib/api) so the UI can be verified without Vercel CLI or real OAuth. CSP-clean verified via Playwright on the landing view.
- `public/assets/styles.css` is gitignored and produced at build time (keeps diffs clean).
- Test script uses a glob instead of `node --test test/` (directory arg not supported by Node 22).
- `hono/adapter` `env()` ignores `c.env` on Node/edge, so `getEnv` reads `c.env` first (tests) then `process.env` (Vercel).
- Mutating-route CSRF check compares Origin with `appOrigin(c)` (APP_URL if set, else request origin).
- Branch scan runs with concurrency 2 (each repo scan is many upstream calls); branch list capped at 1000 branches/repo. Branch URLs keep `/` between encoded segments (spec 5.4), so the route uses Hono `:branch{.+}`.
- Cleanup tab has its own BulkPanel instance (progress shown inside the Cleanup tab, not the Repositories tab).

## Known issues / unverified
- E2E of cleanup + analytics tabs verified only against the mock GitHub (Playwright, zero console errors); real-GitHub edge cases (e.g. compare 404 on unrelated histories → aheadBy null → not merged) handled but untested live.
- T12 resolved (user confirms backend + all features work live). README still mentions the old edge entry; fix in U6 docs pass.

## User actions required
- [ ] After each U-task push, check https://gitmanage.vercel.app (Vercel auto-deploys main).

## How to run / verify
```
npm install
npm run build   # → public/assets/styles.css
npm test
npm run dev     # vercel dev (needs Vercel CLI + .env)
PORT=3077 npm run dev:mock   # fake GitHub, open /api/auth/login to sign in
```
