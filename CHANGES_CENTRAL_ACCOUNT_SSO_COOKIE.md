# AYZEN Account — Central SSO Cookie (master plan §4, Option A)

Implements the first concrete slice of `ayzen-workspace-master-plan.md` §4:
a shared session cookie across `*.ayzen.tech`, built on top of the existing
signed-JWT + revocable-session stack (`lib/jwt.ts`, `lib/sessions.ts`) —
no new auth system, no breaking change to the current Bearer-token flow.

## What was missing
Every login endpoint already returned a signed JWT in the JSON body, and
that token already works across every module (Mail/Vault/Finance/Marketplace
are all routes in one SPA). But once those modules split onto their own
subdomains (`sylo.ayzen.tech`, `ryft.ayzen.tech`, …), a JSON-body token isn't
enough — there's no browser mechanism that hands it to a different
subdomain automatically. Nothing enforced "one login for every app" at the
transport level; each subdomain would need to be handed the token some
other way.

## What was added

### Backend
| File | Change |
|---|---|
| `artifacts/api-server/src/lib/session-cookie.ts` | **New file** — `setSessionCookie`/`clearSessionCookie`/`getSessionCookie`. Cookie is httpOnly, `SameSite=Lax`, `Secure` in production, domain from `AYZEN_COOKIE_DOMAIN` (e.g. `.ayzen.tech`; unset in dev so it stays host-only). |
| `artifacts/api-server/src/app.ts` | Mounts `cookie-parser` (was already a dependency, unused) before the router. |
| `artifacts/api-server/src/lib/auth-utils.ts` | `getTokenFromReq()` now falls back to the `ayzen_session` cookie when there's no `Authorization` header. This is the single choke point `requireAuth`/`requireAdmin`/etc. already go through, so **every existing route gains cookie support for free** — no per-route changes needed. |
| `artifacts/api-server/src/lib/sessions.ts` | Added `revokeSessionByJti()` — revokes a session by the JWT's `sid` claim directly (needed by `/auth/logout`, which only has the token, not the Security page's numeric session-row id). |
| `artifacts/api-server/src/routes/auth.ts` | Every token-issuing endpoint (`/auth/login`, `/auth/login/step-up/verify`, `/auth/magic-link/verify`, `/auth/supabase-sync`, `/auth/refresh`, `/auth/reset-password`) now also calls `setSessionCookie()`. `/auth/refresh` accepts the refresh token from the cookie as a fallback when the body doesn't have one. `/auth/me`, `/auth/sessions`, `/auth/sessions/:id/revoke`, `/auth/sessions/revoke-others` switched from manually parsing the `Authorization` header to `getTokenFromReq()`, so they work from a cookie-only session too. Added `POST /auth/logout` (clears the cookie, revokes the current session) and `POST /auth/session-exchange` (see below). |

### `POST /api/auth/session-exchange` — for AYZEN Astra
The master plan's §3/§4 calls out that the browser extension can't rely on
third-party cookies the way a subdomain can, and says to "build Astra's
token-exchange as if Option B already existed" even while the web apps use
Option A. This endpoint is that piece: Astra's background script calls it,
the browser attaches the `ayzen_session` cookie automatically (same-site
request), and the endpoint exchanges that for a **separate** token — its
own `user_sessions` row, labeled "AYZEN Astra (extension)" so it's visible
and individually revocable on the Security page without signing the user
out of the web app. It deliberately requires the cookie specifically
(not any Bearer token) — that's what makes it a real trust boundary instead
of a passthrough.

## What did NOT change
- The JSON body of every login response still returns `{ token,
  refreshToken, user }` exactly as before — the Expo mobile app, API keys,
  and anything using `setAuthTokenGetter` are unaffected.
- No new database migration — this reuses the existing `user_sessions`
  table and JWT `sid` claim from the SSO-sessions feature.
- No frontend changes in this pass. The web SPA doesn't need any changes to
  benefit (cookies are set automatically by the browser on every login
  response), but once apps actually split across subdomains, cross-origin
  `fetch()` calls will need `credentials: "include"` — CORS already has
  `credentials: true` configured (`middlewares/security.ts`), so that's a
  one-line change at that point, not a redesign.

## Config needed to actually activate cross-subdomain sharing
Set `AYZEN_COOKIE_DOMAIN=.ayzen.tech` in production once subdomains exist.
Until then, leave it unset — the cookie still works (host-only), it just
doesn't span domains yet, which matches where the app suite actually is
today (Phase 1 of the master plan's build order, before Phase 2's Sylo
split).

## What was tested
- All edited/created files checked for brace/paren balance.
- `tsc --noEmit` attempted; `node_modules` isn't installed in this sandbox
  so it only surfaces "cannot find module" noise (same limitation noted in
  `CHANGES_ACCOUNT_SSO_SESSIONS.md`) — no syntax or type errors found in
  the changed files themselves.
- Not tested: actual runtime/DB behavior (no network/DB access here).
  Before deploying: verify a login sets the cookie (check `Set-Cookie` in
  the response), verify `/auth/session-exchange` fails without a cookie and
  succeeds with one, and verify `/auth/logout` actually clears it.
