# CHANGES — OIDC Middleware Rollout (Phase 4e)

## Sub-phase

Season 2, Phase 4 — ID Token + UserInfo, sub-phase **4e — Middleware
Rollout** (4e-a Select Resource Routes, 4e-b Apply Middleware, 4e-c
Regression Checks, 4e-d Integration Tests, 4e-e Phase 4 Verification).

This is the remaining piece the prior pass (4a/4b/4c/4d,
`CHANGES_OIDC_ID_TOKEN_USERINFO_SCOPE_PHASE4A_4D.md`) explicitly left out:
`requireOidcScope()` (`lib/oidc-scope-enforcement.ts`, 4d) was built and
unit-tested in isolation but never mounted on any route.

## 4e-a — Select Resource Routes

Inspected every existing route file under `artifacts/api-server/src/routes/`
(`grep`'d for any existing use of `oidcToken`/`requireOidcScope`/
`verifyOidcAccessToken` — none, confirming the 4a-4d pass's own note that
the middleware isn't mounted anywhere) and confirmed how they're
currently authenticated: session cookie / legacy AYZEN API key, through
`getTokenFromReq()` and the global `apiKeyScopeGate`. Season 3 (Phase 5,
Sylo OIDC Migration) — the point at which a real first-party client
starts sending an OIDC bearer token for its OWN resource calls — has not
started.

**Decision: no existing `/api/*` route was retrofitted.** Doing so now
would mean a live, currently-working, session-authenticated route starts
requiring an OIDC bearer token before any client actually holds one to
call it with — locking out real users of a route that works today. That
is exactly what section 1.3's "preserve existing routes, handlers,
services" and section 1.4's "no speculative implementation of future
phases" boundaries exist to prevent; Sylo's own migration (Phase 5) is
the sub-phase that gets to decide which of ITS resource calls should
carry an OIDC token, not this one.

What was selected instead: a small, new OIDC resource-server surface —
`GET /oidc/resource/profile` (requires `"profile"` scope) and
`GET /oidc/resource/email` (requires `"email"` scope) — one route per
non-`openid` scope this provider currently defines semantics for
(`KNOWN_OIDC_SCOPES`, Phase 2d). This is genuinely new surface area (no
existing route's behavior changes), and is the concrete "Scope-Enforced
Resource" step the Season 2 exit criteria's flow chart names:

```
Authorize -> Login -> Code -> PKCE -> /oidc/token -> Access Token + ID Token
   -> /oidc/userinfo -> Scope-Enforced Resource
```

It also doubles as the reference shape a real Phase 5 resource route will
follow once Sylo's migration actually needs one.

## 4e-b — Apply Middleware

New file: `artifacts/api-server/src/routes/oidc-resource.ts`. Mounts
`requireOidcScope("profile")` / `requireOidcScope("email")` directly as
Express route middleware ahead of a small shared handler
(`respondWithVerifiedToken`) that echoes back what the middleware already
verified (`sub`, `client_id`, `scopes`) — no new business logic, since
this route's only job is to prove the enforcement primitive is wired
correctly.

`artifacts/api-server/src/app.ts` — one import added, one
`app.use(oidcResourceRouter)` line added, positioned with the other
bare-origin OIDC routers (`oidc-authorize`, `oidc-token`,
`oidc-userinfo`), strictly **before** the `/api` mount
(`app.use("/api", globalLimiter, apiKeyScopeGate, router)`). This is the
same "not `/api`, not behind `apiKeyScopeGate`" convention every other
`/oidc/*` router already documents for itself, for the identical reason:
an OIDC client's backend calls this URL directly against the issuer's
origin.

## 4e-c — Regression Checks

- `diff -rq` between this pass's tree and the incoming (4a-4d) tree:
  exactly one existing file touched (`app.ts`), plus three new files.
  Every other route file, `middlewares/api-key-scope.ts`, and every
  `lib/*.ts` file is byte-for-byte unchanged.
- `diff` on `app.ts` itself: purely additive — one new import line, one
  new `app.use(...)` line. The `/api` mount line
  (`app.use("/api", globalLimiter, apiKeyScopeGate, router)`) is
  unchanged, so `apiKeyScopeGate` and every `/api/*` route's existing
  auth behavior is untouched.
- Full-repo syntax check (same parser `scripts/src/check-all.ts` uses,
  run directly since `pnpm install` needs network unavailable here):
  868 `.ts`/`.tsx` files under `artifacts/`, `lib/`, `scripts/` scanned,
  **0 syntax errors** — confirms nothing else in the repo was broken by
  this change.

## 4e-d — Integration Tests

New file: `scripts/src/test-oidc-middleware-rollout.ts`. Exercises the
actual `requireOidcScope(scope) -> handler` chain each `/oidc/resource/*`
route mounts, against a minimal req/res double (same shape
`test-oidc-scope-enforcement.ts`, 4d-e, already established), using real
`issueOidcAccessToken()`-minted tokens. Covers:

- allowed / denied for `/oidc/resource/profile` (has vs. lacks `profile`)
- allowed / denied for `/oidc/resource/email` (has vs. lacks `email`)
- cross-scope denial: a `profile`-only token is rejected by
  `/oidc/resource/email` and vice versa — the two routes are
  independently gated, not sharing one pass/fail decision
- a token holding both scopes passes both routes
- no `Authorization` header at all -> `401 invalid_request`
- a garbage bearer token -> `401 invalid_token`

## 4e-e — Phase 4 Verification

New file: `scripts/src/test-oidc-phase4-exit.ts` (same shape as
`test-oidc-phase2-exit.ts`, 2E-e). Composes 4a (ID token claims), 4b
(nonce), 4c (access token verification + UserInfo claim shaping), and
4d/4e (scope-enforced resource) into one simulated login and confirms the
full Season 2 exit-criteria chain behaves consistently for the same
issued tokens: an ID token with correct `sub`/`iss`/`aud`/nonce; an
access token that verifies to the same subject; UserInfo claims shaped
correctly for the granted scopes; and the *same* access token correctly
accepted or rejected by both scope-gated resource routes depending on
what it was actually issued with.

## What is verified vs. not

Same sandbox limitation the 4a-4d pass already hit and disclosed: no
network, no `node_modules` for this workspace, so `test-oidc-middleware-rollout.ts`
and `test-oidc-phase4-exit.ts` could not be run for real via `npx tsx`
(both import `issueOidcAccessToken()`/`issueOidcIdToken()`, which need
`jsonwebtoken`).

What WAS done in this pass, in place of a live run:

- `oidc-resource.ts`, the `app.ts` diff, and both new test files passed a
  syntax check via TypeScript's parser — no parse errors (see 4e-c).
- The middleware-rollout WIRING logic this pass adds — bearer extraction,
  the three-outcome branch (`401 invalid_request` / `401 invalid_token` /
  `403 insufficient_scope`), and the `requireOidcScope() -> handler` chain
  the new route uses — was extracted verbatim into a standalone Node
  script with `verifyOidcAccessToken()` stubbed out (its real RS256
  verification is 4c-a/4c-b/4c-c's own, already-reasoned-through logic,
  not new in this pass) and run against every assertion
  `test-oidc-middleware-rollout.ts` makes for the non-crypto-dependent
  cases. All 5 wiring assertions passed. This confirms the NEW code this
  pass adds is correct independent of the RS256 sign/verify round trip,
  the same "pure/wiring logic verified standalone, crypto round-trip
  pending a live dependency run" split the 4a-4d pass's own CHANGES doc
  already used.

NOT independently re-run in this pass (need `jsonwebtoken` and/or a live
Postgres connection, neither available here — same gap the 4a-4d pass
already flagged for the pieces this pass builds on):

- `test-oidc-middleware-rollout.ts`'s and `test-oidc-phase4-exit.ts`'s
  actual RS256 sign/verify round trips (`issueOidcAccessToken()`,
  `issueOidcIdToken()`, `verifyOidcAccessToken()`) — already
  independently pending from the 4a-4d pass, unchanged by this one.
- The real Express `Router` HTTP dispatch for `/oidc/resource/*` (path
  matching, `globalLimiter`) — this pass only exercises the exported
  handler chain directly, same limitation every earlier `oidc-*` route
  test in this roadmap already has.

Run for real — `pnpm install`, then
`npx tsx scripts/src/test-oidc-middleware-rollout.ts` and
`npx tsx scripts/src/test-oidc-phase4-exit.ts`, then an actual
`/oidc/authorize` -> `/oidc/token` -> `/oidc/userinfo` ->
`/oidc/resource/profile` round trip against a live Postgres and a running
server — before calling Phase 4e DONE in the roadmap's strict §8 sense.

## Season 2 status after this pass

- 4a/4b/4c/4d — unchanged from the prior pass (done, pending the same
  live-dependency run already noted there).
- 4e (Middleware Rollout) — done in this sandbox's sense: implemented,
  wired, regression-checked against the rest of the repo, and tested to
  the extent this sandbox's missing `node_modules`/network allow (see
  above). **Phase 4, and Season 2's exit criteria, are now fully wired
  end to end** (`/oidc/authorize` -> `/oidc/token` -> Access Token + ID
  Token -> `/oidc/userinfo` -> Scope-Enforced Resource) — pending the live
  run listed above before Season 2 can be called DONE in the roadmap's
  strict §8 sense.

## Next sub-phase

Season 3, Phase 5 (Sylo OIDC Migration), starting at **5a-a — Client
Library Setup**. Per the roadmap's own hard execution boundary (section
1.3), that work is out of scope for this pass and has not been started
or speculatively implemented here.
