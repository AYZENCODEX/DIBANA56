# CHANGES — Sylo OIDC Migration (Phase 5) + OIDC Middleware Rollout (Phase 4e)

## Sub-phases covered

This pass applies two things on top of the incoming
(4a-4d-applied) tree:

1. **Season 2, Phase 4e — Middleware Rollout** (4e-a..4e-e), taken
   as-is from `ayzen_phase4e_middleware_rollout.zip`.
2. **Season 3, Phase 5 — Sylo OIDC Migration**:
   - **5a — OIDC Client Configuration** (5a-a..5a-f)
   - **5b — Sylo Login Wiring** (5b-a..5b-g)

Season 3's own boundary (5c — Feature-Flagged Dual Run — is a
separate, not-yet-started sub-phase) means this pass stops at the end
of 5b, same as the roadmap's own section 1.3 execution boundary.

## Phase 4e — applied verbatim

- New: `artifacts/api-server/src/routes/oidc-resource.ts`
  (`GET /oidc/resource/profile`, `GET /oidc/resource/email`, each
  gated by `requireOidcScope()`, 4d).
- `artifacts/api-server/src/app.ts` — purely additive: one import,
  one `app.use(oidcResourceRouter)`, mounted with the other
  bare-origin `/oidc/*` routers, strictly before the `/api` mount.
  `apiKeyScopeGate` and every `/api/*` route's auth is untouched.
- New: `scripts/src/test-oidc-middleware-rollout.ts`,
  `scripts/src/test-oidc-phase4-exit.ts`.
- See `CHANGES_OIDC_MIDDLEWARE_ROLLOUT_PHASE4E.md` (carried over
  unmodified) for 4e's own full reasoning and verification status.

## Phase 5a — OIDC Client Configuration

- New: `artifacts/ayzen/src/lib/oidc-client.ts` (5a-a) — generic
  Authorization Code + PKCE client library: PKCE pair/`state`
  generation, authorize-URL builder, token exchange. No Sylo- or
  route-specific knowledge; public-client only (no `client_secret`,
  ever).
- New: `artifacts/ayzen/src/lib/sylo-oidc-config.ts` (5a-b/5a-c/5a-d)
  — resolves Sylo's issuer (override → `getApiBase()` → same-origin
  fallback), `client_id` (`getCurrentSubdomainApp()`, defaulting to
  `"sylo"`), `redirect_uri`
  (`${origin}/oidc/callback`), and scopes (`["openid","profile","email"]`,
  matching `seed-oidc-clients.ts`'s `AYZEN_FIRST_PARTY_SCOPES`).
- New: `artifacts/ayzen/src/lib/sylo-oidc-discovery.ts` (5a-e) —
  **written in this pass** (not present in the uploaded file set;
  `sylo-oidc-login.ts` and `oidc-callback.tsx` both import
  `getSyloOidcProviderMetadata` from it, so Phase 5 could not
  actually run without it). Fetches
  `{issuer}/.well-known/openid-configuration`, validates and narrows
  it to the four fields `OidcProviderMetadata` needs, and caches the
  result per-issuer (a failed fetch does not poison the cache — see
  the file's own header for why). Exports a
  `__resetSyloOidcProviderMetadataCacheForTests()` escape hatch, never
  called from production code.
- Updated: `artifacts/api-server/src/lib/oidc-discovery.ts` and
  `scripts/src/test-openid-configuration-endpoint.ts` — the discovery
  document now publishes `authorization_endpoint` / `token_endpoint`
  / `userinfo_endpoint` (all three routes exist as of Phase 3/4), the
  follow-up 1E-d's own header flagged as pending. This is what
  `sylo-oidc-discovery.ts` above fetches; without it, "load provider
  metadata" would have nothing real to load. `well-known-openid-configuration.ts`
  itself needed no change — it already just serializes whatever
  `getOidcDiscoveryMetadata()` returns.
- Updated: `artifacts/ayzen/src/lib/subdomain-app.ts` —
  `/oidc/callback` added to `ALWAYS_ALLOWED_PREFIXES`. `App.tsx`'s own
  header already asserted this was true; it wasn't yet — the callback
  route has to render regardless of which subdomain app is scoped
  (it's what establishes the session in the first place), so this was
  a genuine gap, not a style choice.
- New: `scripts/src/test-sylo-oidc-client-library.ts` (5a-a tests,
  uploaded as-is) and `scripts/src/test-sylo-oidc-config-and-discovery.ts`
  (5a-f, **written in this pass** — covers `resolveSyloOidcIssuer()`'s
  override/fallback branches, `getSyloOidcClientConfig()` end to end,
  and `fetchSyloOidcProviderMetadata()`/`getSyloOidcProviderMetadata()`
  including the per-issuer cache and its failure-doesn't-poison-cache
  behavior).

## Phase 5b — Sylo Login Wiring

- New: `artifacts/ayzen/src/lib/sylo-oidc-login.ts` (5b-a) — starts a
  fresh Authorization Code + PKCE attempt, persists the pending
  transaction to `sessionStorage`, navigates to `/oidc/authorize`.
- New: `artifacts/ayzen/src/pages/oidc-callback.tsx` (5b-b) +
  `artifacts/ayzen/src/lib/sylo-oidc-callback.ts` (5b-b..5b-f) — state
  verification, PKCE token exchange, local session establishment via
  the existing `POST /auth/session-exchange` endpoint, ID-token
  `sub`/`nonce` cross-checks, and a closed set of user-facing error
  states.
- New: `artifacts/ayzen/src/lib/sylo-oidc-session-exchange.ts` (5b-e).
- Updated: `artifacts/ayzen/src/App.tsx` — `ProtectedRoute` now starts
  `startSyloOidcLogin()` for an unauthenticated hit on an in-scope
  subdomain app instead of falling straight to the generic `/login`
  form; `/oidc/callback` is mounted as its own route, outside
  `ProtectedRoute`, at the same tier as `/login`.
- New: `scripts/src/test-sylo-oidc-e2e-login.ts` (5b-g, **written in
  this pass**) — composes 5b-a through 5b-f into one simulated round
  trip: PKCE/state generation → simulated provider callback → state
  verification → injected token exchange → injected session exchange
  → the full closed set of `SyloOidcCallbackErrorCode` failure states
  (`provider_error`, `missing_pending_transaction`, `state_mismatch`,
  `missing_code`, `token_exchange_failed`, `session_exchange_failed`,
  `identity_mismatch` via both the nonce and the `sub` cross-check) →
  `describeSyloOidcCallbackError()`'s user-facing mapping. Runs
  against the real, unmocked `oidc-client.ts`/`sylo-oidc-callback.ts`
  functions with a fake `Storage` and injected network boundaries —
  it does not call `startSyloOidcLogin()` or mount `oidc-callback.tsx`
  directly, since both need a real browser (`window`, DOM); see the
  file's own header for why that split is exactly what 5a/5b already
  built the injectable seams for.

## Regression checks

- `diff` on `app.ts`: purely additive (one import, one `app.use`),
  confirmed above.
- Full-repo syntax check (TypeScript parser, same tool
  `scripts/src/check-all.ts` uses): **879 `.ts`/`.tsx` files** under
  `artifacts/`, `lib/`, `scripts/` — **0 syntax errors**.
- Every file touched or added this pass was individually parse-checked
  before the full-repo scan.

## What was actually run, vs. what's still pending a live dependency

Run for real, in this sandbox, no stubbed crypto/network:

- `scripts/src/test-sylo-oidc-client-library.ts` — **all 11
  assertions pass** (needs only Web Crypto + `fetch`, both Node
  built-ins).
- `scripts/src/test-sylo-oidc-config-and-discovery.ts` — **all 14
  assertions pass**.
- `scripts/src/test-sylo-oidc-e2e-login.ts` — **all 12 assertions
  pass**.

NOT run for real (same sandbox limitation every earlier CHANGES doc
in this roadmap already discloses — no network, no installed
`node_modules` for the backend workspace):

- `scripts/src/test-openid-configuration-endpoint.ts` — needs
  `express`. Syntax-checked only.
- `scripts/src/test-oidc-middleware-rollout.ts` /
  `scripts/src/test-oidc-phase4-exit.ts` — need `jsonwebtoken`, same
  gap 4e's own CHANGES doc already flagged, unchanged by this pass.
- A real Vite/browser run of `startSyloOidcLogin()` → `/oidc/authorize`
  → `/oidc/callback` → `POST /auth/session-exchange` against a live
  API server and Postgres — 5b-g's test above exercises every
  decision point in that flow with the browser-only edges (`window`,
  network) injected out; the actual end-to-end HTTP round trip still
  needs a live environment.

Run for real before calling Phase 5 DONE in the roadmap's strict §8
sense: `pnpm install` in both workspaces, then every `test-*.ts` file
above via `npx tsx`, then an actual browser hitting a Sylo subdomain
against a running API server + Postgres.

## Season 3 status after this pass

- 5a (OIDC Client Configuration) — done in this sandbox's sense:
  implemented, wired, and tested for real (client library + config +
  discovery, including the newly-written `sylo-oidc-discovery.ts` and
  its test file).
- 5b (Sylo Login Wiring) — done in this sandbox's sense: implemented,
  wired into `App.tsx`, and tested for real end-to-end at the
  function level (5b-g), including the full closed set of error
  states (5b-f).
- Phase 5's own exit flow (login start → authorize → callback → PKCE
  token exchange → local session establishment) is now wired
  end-to-end in the codebase — pending the live run listed above
  before Season 3 can be called DONE in the roadmap's strict §8 sense.

## Next sub-phase

Season 3, Phase 5c (Feature-Flagged Dual Run) — out of scope for this
pass per the roadmap's own execution boundary; not started or
speculatively implemented here.
