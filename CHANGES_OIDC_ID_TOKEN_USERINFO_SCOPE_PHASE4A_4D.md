# CHANGES — OIDC ID Token, UserInfo, Scope Enforcement (Phase 4a/4b/4c/4d)

## What this integrates

Delivered as ready-made files and copied in as-is:

- `artifacts/api-server/src/lib/oidc-access-token-verification.ts` (4c-a/4c-b/4c-c)
- `artifacts/api-server/src/routes/oidc-userinfo.ts` (4c-f)
- `artifacts/api-server/src/routes/oidc-token.ts` (updated — now wires in
  4a/4b ID token issuance, gated on the `openid` scope)
- `artifacts/api-server/src/app.ts` (updated — mounts `oidc-userinfo`
  router at the bare origin, same convention as `oidc-authorize`/`oidc-token`)
- `scripts/src/test-oidc-id-token.ts` (4a-g/4b-d)
- `scripts/src/test-oidc-userinfo.ts` (4c-g)

Phase 4a (ID Token Claims) and Phase 4c-d/4c-e (UserInfo claim shaping +
user lookup) had no implementation anywhere in the provided materials —
both `routes/oidc-token.ts` and `routes/oidc-userinfo.ts` import from
files that didn't exist yet. Built fresh in this pass:

- `lib/oidc-id-token.ts` — `buildIdTokenClaims()` (4a-a..4a-e, 4b-b/4b-c),
  `resolveIdTokenNonce()` (4b-b/4b-c), `issueOidcIdToken()` (4a-f),
  `ID_TOKEN_TTL_SECONDS` (60 minutes, same reasoning
  `ACCESS_TOKEN_TTL_SECONDS` already gives). Nonce persistence itself
  (4b-a) was already done at Phase 3b-e (`oidc_authorization_codes.nonce`,
  migration 080) — nothing new to build there, just consumed.
- `lib/oidc-userinfo.ts` — `fetchOidcUserinfoRecord()` (the DB lookup
  `routes/oidc-userinfo.ts` needs, banned/suspended-excluded, same check
  `getUserFromToken()`/`apiKeyScopeGate` already apply) and
  `buildUserinfoClaims()` (4c-d/4c-e — `profile`/`email` scope-gated claim
  shaping).

Phase 4d (Scope Enforcement Middleware) had no implementation anywhere in
the provided materials and is not referenced by any uploaded file — built
fresh, as a standalone primitive:

- `lib/oidc-scope-enforcement.ts` — `hasRequiredScope()` (4d-c, pure),
  `requireOidcScope(scope)` (4d-b/4d-c/4d-d, an Express middleware
  factory: RFC 6750 `401 invalid_request` / `401 invalid_token` / `403
  insufficient_scope`, three outcomes, plus a passthrough that attaches
  the verified token to `req.oidcToken`).
- `scripts/src/test-oidc-scope-enforcement.ts` (4d-e) — pure
  `hasRequiredScope()` cases plus the middleware exercised against a
  minimal req/res double (same shape `test-jwks-endpoint.ts` already
  established), covering all three failure outcomes, the success
  passthrough, and `req.oidcToken` attachment.

**Deliberately NOT done — Phase 4e (Middleware Rollout) is out of scope
for this pass.** `requireOidcScope()` is not mounted on any route
anywhere. Selecting which existing resource routes should require an OIDC
scope (4e-a), applying the middleware to them (4e-b), and the regression/
integration testing that comes with touching live routes (4e-c/4e-d) are
explicitly a separate, later pass — see `lib/oidc-scope-enforcement.ts`'s
own header for why building that now would be implementing 4e ahead of
4e, which the roadmap's section 1.4 rule says not to do.

## What is verified vs. not

This sandbox has no network and no `node_modules` for this workspace
(`pnpm install` needs network, unavailable here) — so none of the
`test-oidc-*.ts` scripts (this pass's included) could be run for real via
`npx tsx`, the same limitation the prior Phase 3c/3d/3e pass's own CHANGES
doc already hit for its DB-backed pieces.

What WAS done in this pass, in place of a live run:

- Every new/edited `.ts` file (`oidc-id-token.ts`, `oidc-userinfo.ts`,
  `oidc-scope-enforcement.ts`, the three copied-in route/lib files,
  `app.ts`, and all three test scripts) passed a syntax check via
  TypeScript's `ts.transpileModule()` — no parse errors.
- The PURE logic in `buildIdTokenClaims()`/`resolveIdTokenNonce()`,
  `buildUserinfoClaims()`, and `hasRequiredScope()` was extracted
  verbatim into a standalone Node script (no `jsonwebtoken`/`drizzle-orm`/
  `pino` dependency) and run against every assertion the corresponding
  test file makes — all passed. This covers every 4a-a..4a-e, 4b-b/4b-c,
  4c-d/4c-e, and 4d-c assertion that doesn't require an actual RS256
  sign/verify round trip or a live DB connection.

NOT independently re-run in this pass (need the workspace's installed
dependencies — `jsonwebtoken`, `drizzle-orm`, `pino` — and/or a live
Postgres connection, neither available here):

- `scripts/src/test-oidc-id-token.ts`'s `issueOidcIdToken()`/RS256
  sign-verify-round-trip cases (the pure `buildIdTokenClaims()` cases were
  independently verified — see above).
- `scripts/src/test-oidc-userinfo.ts`'s `verifyOidcAccessToken()` cases
  (needs `jsonwebtoken`) — `buildUserinfoClaims()`'s own cases were
  independently verified.
- `scripts/src/test-oidc-scope-enforcement.ts`'s `requireOidcScope()`
  middleware cases (needs `jsonwebtoken` via `issueOidcAccessToken()`) —
  `hasRequiredScope()`'s own cases were independently verified.
- `fetchOidcUserinfoRecord()` (`lib/oidc-userinfo.ts`) — the actual
  `users` table lookup, including the banned/suspended exclusion. Reviewed
  by hand against `getUserFromToken()`'s already-reviewed equivalent
  query; not run.
- The full `userinfoHandler()` chain (`routes/oidc-userinfo.ts`,
  Authorization header -> verify -> DB lookup -> claims -> RFC 6750
  response shape) and the full `tokenHandler()` chain with `id_token` now
  wired in (`routes/oidc-token.ts`).

Run for real — `pnpm install`, then `npx tsx scripts/src/test-oidc-id-token.ts`
/ `test-oidc-userinfo.ts` / `test-oidc-scope-enforcement.ts`, then an
actual `/oidc/authorize` → `/oidc/token` → `/oidc/userinfo` round trip
against a live Postgres — before calling Phase 4a/4b/4c/4d DONE in the
roadmap's strict §8 sense.

## Season 2 status after this pass

- 4a (ID Token Claims) — done, pending the live-dependency run above.
- 4b (Nonce Binding) — done (4b-a was already complete from Phase 3b-e;
  4b-b/4b-c/4b-d built and reasoned through in this pass).
- 4c (UserInfo) — done, pending the live-dependency run above.
- 4d (Scope Enforcement Middleware) — the primitive is done and tested in
  isolation; it enforces nothing yet because it isn't mounted anywhere
  (see "Deliberately NOT done" above).
- 4e (Middleware Rollout) — not started. This is the remaining piece
  before Season 2's exit criteria (a complete `/oidc/authorize` →
  `/oidc/token` → `/oidc/userinfo` flow with scope-gated resource routes)
  can be called fully done.
