# Git Manager

Bulk-manage your GitHub repositories from a single page: list, search and filter them, then
**bulk delete, archive/unarchive, toggle visibility, transfer, edit topics**, run **cleanup tools**
(forks, empty repositories, merged/stale branches) and view a **live analytics overview**.
The UI follows GitHub's Primer dark look (not affiliated with GitHub) and stays fast with thousands of
repositories (keyed rows, event delegation, rAF-batched renders, lazy hidden tabs).

100% serverless and stateless: Vercel static hosting + one Hono Node function. No database, no KV,
no analytics, no third-party services besides GitHub.

## Privacy model

- You sign in with a **GitHub OAuth App** (scopes `repo`, `delete_repo`, `read:org`).
- The access token is stored **only** in an **AES-256-GCM encrypted, HttpOnly, Secure, SameSite=Lax
  cookie** (`__Host-gm_session`, 8-hour lifetime). It is decrypted per request on the server and is never
  sent to browser JavaScript, never logged, never written to a URL or response body.
- The server stores **nothing**. Repository data lives only in your browser tab's memory for the current
  page session (no `localStorage`, `sessionStorage` or IndexedDB).
- **Sign out** revokes the token at GitHub (best effort) and clears the cookie.
- Strict Content-Security-Policy (`default-src 'self'`, no inline scripts/styles), HSTS, `nosniff`,
  `Referrer-Policy: no-referrer`. All `/api/*` responses are `Cache-Control: no-store`.
- Mutating requests require a custom CSRF header plus a matching `Origin`; only a fixed allow-list of
  routes exists (this is **not** a generic GitHub proxy) and every path parameter is validated.

## Why these scopes

| Scope | Needed for |
|---|---|
| `repo` | Listing private repos, changing visibility/archive state, topics, transfers, branch deletion |
| `delete_repo` | Deleting repositories (the UI disables delete actions if this scope is missing) |
| `read:org` | Listing repositories of organizations you belong to |

`admin:org` is deliberately **not** requested.

> **Organizations:** if an org has *third-party application access restrictions* enabled, an org owner
> must approve this OAuth App before its repositories appear or can be modified.
> GitHub → Organization → Settings → Third-party access.

## Deploy to Vercel

### 1. Import the repository

1. Vercel → *Add New Project* → import this GitHub repository.
2. Framework preset: **Other**. Build command `npm run build`, output directory `public`
   (both are also set in `vercel.json`). Node.js 20 or newer.
3. Deploy once to learn your production URL, e.g. `https://my-app.vercel.app`.
   `GET https://my-app.vercel.app/api/health` should return `{"ok":true}`.

### 2. Register a GitHub OAuth App

GitHub → Settings → Developer settings → **OAuth Apps** → *New OAuth App*:

| Field | Value |
|---|---|
| Homepage URL | `https://<your-domain>` |
| Authorization callback URL | `https://<your-domain>/api/auth/callback` |

Generate a **client secret** and keep both values for the next step.

> One OAuth App supports **one** callback URL. Use this app for production only and create a second
> OAuth App for local development with callback `http://localhost:3000/api/auth/callback`.

### 3. Environment variables

Set these in Vercel → Project → Settings → Environment Variables, then **redeploy**:

| Variable | Value |
|---|---|
| `GITHUB_CLIENT_ID` | from the OAuth App |
| `GITHUB_CLIENT_SECRET` | from the OAuth App |
| `SESSION_SECRET` | 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `APP_URL` (optional) | `https://<your-domain>` — forces the callback origin; otherwise the request origin is used |

`.env.example` lists the same variables with placeholders. Never commit a real `.env`.

## Local development

```bash
npm install
npm run build          # Tailwind → public/assets/styles.css
npm test               # node --test (crypto, validators, routes, bulk runner, classifiers, analytics)
```

**With real GitHub** (needs the Vercel CLI and a dev OAuth App with callback
`http://localhost:3000/api/auth/callback`):

```bash
cp .env.example .env   # fill in the dev OAuth App values + SESSION_SECRET
npm run dev            # vercel dev → http://localhost:3000
```

**Without any credentials** (built-in fake GitHub with ~240 repos, same security headers):

```bash
npm run dev:mock       # → http://localhost:3000 ; open /api/auth/login to sign in instantly
```

## Project layout

```
api/index.js        Vercel Node entry (Web-standard fetch export → Hono app; /api/* rewritten here)
lib/                app.js (routes + middleware), session.js (AES-GCM cookie), oauth.js,
                    github.js (fetch wrapper, rate limits, safe errors), validate.js,
                    repos.js (repo/topic/transfer/branch handlers), branches.js (classifier)
public/             index.html + assets/js/* (vanilla ES modules, no bundler; icons.js Octicon-style SVGs,
                    langcolors.js linguist colors, menu.js accessible dropdowns)
src/styles.css      Tailwind 3.4 entry + Primer-dark tokens/components (.btn, .Box, .Label, .dropdown, …)
test/               node:test suites
scripts/            dev server + mock GitHub (GM_MOCK_REPOS=1500), Playwright qa.mjs / perf.mjs (dev only)
```

## Rate limits and safety

- Read-type bulk work runs with concurrency 4; **every mutating request is sequential with ≥1 s gap**,
  per GitHub's guidance, and automatically waits and retries on `rate_limited` responses.
- Deleting requires typing `delete N repositories`, ticking an acknowledgement and waiting 3 seconds.
  Making repositories public requires typing `make public`; transfers require typing the target owner.
- Default and protected branches can never be selected or deleted (enforced in the UI **and** the server).
- Transfers to a personal account stay pending until the recipient accepts them on GitHub.

## Manual QA checklist

Use a throwaway account or test repositories.

- [ ] Logged out → landing page with *Sign in with GitHub*; `/api/me` returns 401.
- [ ] Sign in → GitHub consent shows exactly `repo`, `delete_repo`, `read:org` → redirected to the dashboard.
- [ ] All repositories load with a progress indicator; search, each filter, sort and pagination work.
- [ ] Shift-click selects a range; *Select all N matching* selects across pages; selection bar shows the count.
- [ ] Archive, then unarchive a test repo; status badge updates without reloading.
- [ ] Make a test repo private, then public (phrase `make public` required).
- [ ] Add, remove and replace topics on a test repo; verify on GitHub.
- [ ] Transfer a test repo to another owner → shown as *started/pending*.
- [ ] Delete a test repo via the safety modal (phrase, checkbox, 3 s countdown) → disappears from the list and analytics update.
- [ ] Bulk run: Cancel stops after the current item; *Retry failed* re-runs failures; *Download log* yields JSON without tokens.
- [ ] Cleanup → Forks lists only forks; Empty repos scan confirms emptiness; Branches scan never offers the default or protected branches.
- [ ] Analytics totals match the repo count; unknown languages show as *Unknown*.
- [ ] Rate-limit badge shows remaining requests and turns amber/red when low.
- [ ] Sign out → back to the landing page; the token is revoked (GitHub → Settings → Applications no longer lists an active session, or API calls with the old token fail).
- [ ] Browser devtools: no CSP violations in the console, no cookies readable from JS, nothing in local/session storage.

## License

MIT
