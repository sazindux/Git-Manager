# HANDOFF
Updated: 2026-10-05T15:30Z · Last task touched: T0 · Branch: main

## Task status
| ID | Task | Status | Commit |
|----|------|--------|--------|
| T0 | Scaffold & config | done | (see git log: feat(T0)) |
| T1 | Session crypto & OAuth flow | pending | |
| T2 | GitHub client & repo list endpoint | pending | |
| T3 | Frontend shell & glass UI | pending | |
| T4 | Repository dashboard | pending | |
| T5 | Bulk engine & safety modals | pending | |
| T6 | Bulk actions: visibility/archive/topics/delete | pending | |
| T7 | Bulk transfer | pending | |
| T8 | Cleanup tools | pending | |
| T9 | Analytics | pending | |
| T10 | Security & quality review | pending | |
| T11 | Docs & final QA | pending | |

## Current / next action
Start T1: create `lib/session.js` (AES-256-GCM seal/unseal via `crypto.subtle`, base64url, cookie
helpers with `__Host-gm_session` vs `gm_session` for http://localhost), `lib/oauth.js`
(login/callback/logout/me handlers), wire into `lib/app.js` with CSRF/origin middleware for non-GET.
Add `test/session.test.js` (round trip, tamper, expiry, wrong key).

## Key facts
- Entry pattern: `api/[...route].js` → `import { handle } from 'hono/vercel'`, `export const config = { runtime: 'edge' }`,
  `export default handle(app)`. App in `lib/app.js` with `new Hono().basePath('/api')`. Import verified locally;
  edge deploy on Vercel NOT yet verified (see Known issues).
- Versions installed: hono 4.13.x, tailwindcss 3.4.x, Node 22 local (engines >=20).
- Module map:
  - `lib/app.js` → Hono app, no-store middleware, `/api/health`, JSON 404/500 handlers.
  - `api/[...route].js` → thin Vercel edge entry.
  - `src/styles.css` → Tailwind + components: `.glass .glass-strong .btn .btn-primary .btn-ghost .btn-danger .btn-warn .input .badge .badge-ok .badge-warn .badge-danger .progress .progress-bar`.
  - `public/index.html` → placeholder page (replaced in T3).
  - `test/app.test.js` → smoke tests using `app.request()`.
- Implemented endpoints: `GET /api/health`.
- Conventions: tests use `app.request(url, init)` (no server needed). Test script: `node --test "test/**/*.test.js"`.
  Built CSS `public/assets/styles.css` is gitignored (Vercel builds it via `npm run build`).
- Tailwind config uses `export default` (package is ESM); color palette `ink-950/900/800/700`.

## Decisions & deviations from the prompt
- `public/assets/styles.css` is gitignored and produced at build time (keeps diffs clean).
- Test script uses a glob instead of `node --test test/` (directory arg not supported by Node 22).

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
