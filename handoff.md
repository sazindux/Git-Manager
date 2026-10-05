# HANDOFF
Updated: 2026-10-05T16:00Z · Last task touched: T3 · Branch: main

## Task status
| ID | Task | Status | Commit |
|----|------|--------|--------|
| T0 | Scaffold & config | done | ae3de79 |
| T1 | Session crypto & OAuth flow | done | 02675de |
| T2 | GitHub client & repo list endpoint | done | f89dd18 |
| T3 | Frontend shell & glass UI | done | 80d4af5 |
| T4 | Repository dashboard | pending | |
| T5 | Bulk engine & safety modals | pending | |
| T6 | Bulk actions: visibility/archive/topics/delete | pending | |
| T7 | Bulk transfer | pending | |
| T8 | Cleanup tools | pending | |
| T9 | Analytics | pending | |
| T10 | Security & quality review | pending | |
| T11 | Docs & final QA | pending | |

## Current / next action
Start T4: create `public/assets/js/grid.js` (load all pages via `GET /api/repos?page=N` with progress → `setRepos`;
search/filters/sort; 50/page client pagination; checkbox selection with shift-click + select-all-filtered; sticky selection
bar). Mount it from `dashboard.js#initDashboard()` into `#repos-panel`. Verify in browser via `npm run dev:mock`.

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
  - `lib/repos.js` → `trimRepo`, `validateTarget` middleware (sets `c.var.target = {owner, repo, path}`), `listRepos`.
  - `api/[...route].js` → thin Vercel edge entry.
  - `src/styles.css` → Tailwind + components: `.glass .glass-strong .btn .btn-primary .btn-ghost .btn-danger .btn-warn .input .badge .badge-ok .badge-warn .badge-danger .progress .progress-bar`.
  - `public/index.html` → views `#view-loading/#view-landing/#view-dashboard`, header (avatar `#user-avatar`, `#user-login`, `#rate-badge`, `#btn-logout`), tab buttons `[data-tab]`, sections `#tab-repos` (`#repos-panel`), `#tab-cleanup`, `#tab-analytics`, `#toasts`, `#modal-root`. Script: `/assets/js/main.js` (module).
  - `public/assets/js/ui.js` → `el(tag, attrs, ...children)` (attrs: class, text, onClick…, dataset), `append`, `clear`, `show(node, bool)`, `$`, `$$`, `svg`, `formatNumber`, `formatBytesFromKB`, `formatDate`, `daysSince`, `debounce`, `sleep(ms, signal)`.
  - `public/assets/js/state.js` → `state` {user, repos, selection:Set, rate, activeTab}, `on/emit` events (`user`, `rate`, `repos`, `selection`, `tab`, `unauthorized`), `hasScope`, `setUser`, `setRate`, `setRepos`, `removeRepos`, `updateRepo`, `setSelection`, `toggleSelected`, `clearSelection`, `selectedRepos`, `setTab`.
  - `public/assets/js/api.js` → `api/get/post/patch/put/del`, `ApiError` (status, code, retryAfter, isRateLimit), `describeError(err)`; emits `unauthorized` on 401; reads X-RateLimit headers.
  - `public/assets/js/toast.js` → `toast(msg, kind)`, `success/error/info`.
  - `public/assets/js/main.js` → bootstrap (`/api/me`), views, tabs, logout, `?error=` toasts; dynamically imports `dashboard.js`.
  - `public/assets/js/dashboard.js` → `initDashboard()` mounts feature modules (placeholder until T4).
  - `scripts/dev-server.js` → Node static+API server applying vercel.json headers; `GM_MOCK=1` loads `scripts/mock-github.js` (in-memory fake GitHub, 240 repos). `npm run dev:mock` (scripts/dev.sh) = zero-config local run. Login flow works with mock (any code).
  - `test/app.test.js` → smoke tests using `app.request()`.
- Implemented endpoints: `GET /api/health`, `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout`, `GET /api/me`, `GET /api/repos?page=N` → `{page, items, hasMore, rate}`.
- Error JSON shape: `{error: <code>, message, status, retryAfter?, rate?}`; codes: unauthorized, rate_limited(429), forbidden, not_found, conflict, unprocessable, upstream_error, network_error, csrf, bad_origin, invalid_target.
- Conventions: tests use `app.request(url, init, ENV)` with mocked `globalThis.fetch` (see test/repos.test.js helpers `authed`, `mockFetch`). Test script: `node --test "test/**/*.test.js"`.
  Built CSS `public/assets/styles.css` is gitignored (Vercel builds it via `npm run build`).
- Tailwind config uses `export default` (package is ESM); color palette `ink-950/900/800/700`.

## Decisions & deviations from the prompt
- Added `scripts/dev-server.js` + `scripts/mock-github.js` (dev-only, no deps, never imported by lib/api) so the UI can be verified without Vercel CLI or real OAuth. CSP-clean verified via Playwright on the landing view.
- `public/assets/styles.css` is gitignored and produced at build time (keeps diffs clean).
- Test script uses a glob instead of `node --test test/` (directory arg not supported by Node 22).
- `hono/adapter` `env()` ignores `c.env` on Node/edge, so `getEnv` reads `c.env` first (tests) then `process.env` (Vercel).
- Mutating-route CSRF check compares Origin with `appOrigin(c)` (APP_URL if set, else request origin).

## Known issues / unverified
- Edge runtime + `hono/vercel` on real Vercel deploy not verified from sandbox (no Vercel access). If `/api/health`
  fails after deploy, fall back: remove `config` export and use the Node pattern (`export const GET = handle(app)` etc.).

## User actions required
- [ ] Import repo into Vercel (framework: Other; build = `npm run build`, output = `public`) and deploy; check `/api/health`.
- [ ] Create GitHub OAuth App: homepage `https://<domain>`, callback `https://<domain>/api/auth/callback`.
- [ ] Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` (base64 of 32 random bytes), optional `APP_URL` in Vercel; redeploy.

## How to run / verify
```
npm install
npm run build   # → public/assets/styles.css
npm test
npm run dev     # vercel dev (needs Vercel CLI + .env)
```
