# AYZEN Workspace — Sylo Subdomain Split (master plan §7 Phase 2)

Implements "split Sylo onto its own subdomain" as **host-based routing in
the existing app — one deploy**, per your call. No new build target, no
separate repo, no new database migration. The same Express app + same SPA
bundle now behaves like a single-purpose Sylo app when it detects it's
being served on Sylo's hostname.

## Why this was straightforward
Vault's routes already all live under one prefix — `/vault/*` (user) and
`/admin/vault*` / `/admin/team-vault` (admin) — see `route-config.tsx`. So
"scoping the app to Sylo" reduced to: detect the hostname, then (a) keep
users inside that prefix, and (b) hide nav items outside it. No pages
needed to move or get renamed.

## What was added

### Frontend
| File | Change |
|---|---|
| `artifacts/ayzen/src/lib/subdomain-app.ts` | **New file.** `getCurrentSubdomainApp()` reads `window.location.hostname` and returns a `{ id, label, homePath, routePrefixes }` record for known subdomains (currently just `sylo`), or `null` on the main domain. `isPathInSubdomainScope()` checks a path against that scope, always allowing auth/public/receipt-link pages. Add one more entry here per app when Phase 3 (Ryft/Wisp/Verve/Zynth) starts. |
| `artifacts/ayzen/src/App.tsx` | `ProtectedRoute` now redirects to the subdomain app's `homePath` whenever the requested page is outside its scope — this is the actual enforcement point, and it covers every route in `ADMIN_ROUTES`/`USER_ROUTES` at once since they all render through it. The root `"/"` redirect also sends a logged-in user on a scoped subdomain straight to `homePath` instead of the normal role-based dashboard. |
| `artifacts/ayzen/src/components/layout/app-sidebar.tsx` | Added `filterGroupsBySubdomain()` — same recursive drop-if-empty shape as the existing plugin-gating `filterEntry()`, but keyed on route prefix instead of a plugin flag. Applied to `groups` right before render (`scopedGroups`), so on `sylo.ayzen.tech` the sidebar only shows Vault-related nav. The admin dynamic-projects sidebar section (unrelated to vault) is hidden the same way. |

### Backend
| File | Change |
|---|---|
| `artifacts/api-server/src/app.ts` | In the production static-serving block, a bare `GET /` on a configured Sylo hostname now 302-redirects straight to `/vault` server-side, before `index.html` even loads — avoids a flash of the full Workspace shell on first paint. Configured via `SYLO_HOSTS` (comma-separated, defaults to `sylo.ayzen.tech`) — keep this in sync with the frontend's `VITE_SYLO_HOSTS`. |

## How it behaves
- **Main domain** (`ayzen.tech`, `workspace.ayzen.tech`, localhost dev, any
  unrecognized host): `getCurrentSubdomainApp()` returns `null` everywhere
  — zero behavior change, full nav, all routes reachable exactly as before.
- **Sylo hostname**: `/` server-redirects to `/vault`; any authenticated
  route outside `/vault`, `/admin/vault`, `/admin/team-vault` bounces back
  to `/vault`; the sidebar only shows Vault-related groups.
- **Login already works across subdomains for free** — the AYZEN Account
  session cookie (`lib/session-cookie.ts`, shipped in the Central SSO pass)
  is shared across every `*.ayzen.tech` host, so a user signed in on the
  main domain is already signed in on `sylo.ayzen.tech`. Nothing here
  needed to touch auth.

## Known rough edge (not fixed in this pass)
`login.tsx`'s ~9 post-login `setLocation(...)` calls still hardcode
`/dashboard` / `/admin/dashboard`. On a Sylo subdomain this means a fresh
login briefly lands on `/dashboard` before `ProtectedRoute`'s scope guard
immediately redirects to `/vault` — correct end state, one extra redirect
hop. Left alone here rather than touching 9 call sites in a file that
handles several different auth flows (password, OTP, passkey, step-up) —
worth a dedicated small pass if the extra hop is noticeable in practice.

## Config needed to activate
- Backend: `SYLO_HOSTS=sylo.ayzen.tech` (default already assumes this).
- Frontend build: `VITE_SYLO_HOSTS=sylo.ayzen.tech` (same default).
- Until `sylo.ayzen.tech` DNS/hosting exists, you can still test this today
  by pointing a local hosts-file entry or a dev subdomain at the same
  deployment — `getCurrentSubdomainApp()` also matches on the first label
  of the hostname (e.g. `sylo.localhost`, `sylo-<preview>.example.com`) as
  a dev convenience, independent of the `SYLO_HOSTS` allowlist.

## What's still Phase 3, not this pass
Actually pointing DNS at Sylo's own subdomain, CDN/hosting config, and
splitting Ryft/Wisp/Verve/Zynth the same way — all unchanged, all still
ahead per the roadmap.

## What was tested
- All edited/created files checked for brace/paren balance.
- `tsc --noEmit` run on the frontend project; only pre-existing "cannot
  find module" noise from the empty sandbox `node_modules` — no syntax or
  type errors in the changed files.
- Not tested: actual browser behavior on a real subdomain (no network here).
  Before deploying: verify the sidebar filters correctly at
  `http://sylo.localhost:<port>` (or equivalent), and that a logged-in
  session on the main domain is recognized without re-login on the Sylo
  host.
