# CHANGES — Sylo OIDC Migration, Phase 5c–5e (Feature-Flagged Dual Run, Cutover, Monitoring & Rollback)

## Scope

This pass completes Season 3, Phase 5's remaining sub-phases per the
roadmap (`ayzen-oidc-roadmap-v5-claude-modular.md`, §"PHASE 5 — SYLO OIDC
MIGRATION"):

- **5c — Feature-Flagged Dual Run** (5c-a..5c-e) — already implemented in
  the incoming tree (uploaded files); verified consistent, unmodified
  except where 5e-a/5e-b needed one additive parameter threaded through.
- **5d — Sylo Cutover** (5d-a..5d-d) — 5d-a (pre-cutover checklist) and
  5d-b (enable mechanism) were already done; **5d-c and 5d-d are new in
  this pass**.
- **5e — Monitoring & Rollback** (5e-a..5e-e) — 5e-a/5e-b's counting
  primitives existed in embryonic form (5c-d's win/loss counters); **error-
  code granularity, alert thresholds (5e-c), the rollback drill (5e-d),
  and post-cutover verification (5e-e) are new in this pass**.

Phase 5 (5a through 5e-e) is now implemented and DB-free-tested end to
end in this sandbox's sense — see "What was actually run" below for
exactly what that does and doesn't mean.

## What was already correct in the incoming tree (5c, verified not modified)

- `migrations/083_ayzen_oidc_rollout_flags.sql` — `oidc_client_rollout_flags` table.
- `lib/oidc-client-rollout.ts` — `getOidcRolloutFlag()`/`setOidcRolloutFlag()`, fail-safe-to-false, short-TTL cache.
- `routes/oidc-rollout-flag.ts` — public `GET /oidc/rollout-flags/:appId`.
- `routes/admin-oidc-rollout.ts` — admin `GET`/`PATCH /admin/oidc-rollout/:appId`, `requireDev`-gated, Sylo-only-without-override.
- `scripts/src/set-oidc-rollout-flag.ts` — CLI twin of the admin PATCH.
- `lib/sylo-oidc-rollout-flag.ts` — frontend flag read, fail-safe, short-TTL cache.
- `lib/oidc-login-attempts.ts` (original) — `recordOidcLoginAttempt()`/`getOidcLoginAttemptStats()`, dual-run comparison (5c-d), already wired into `routes/auth.ts`'s legacy login and `routes/oidc-token.ts`'s token endpoint.
- `scripts/src/test-oidc-client-rollout.ts`, `test-oidc-rollout-flag.ts`, `test-sylo-oidc-cutover-checklist.ts` (5d-a).

## New/modified in this pass

### 5d-c — Disable Old Login Path (Sylo only)

- **New: `lib/oidc-cutover-gate.ts`** — `evaluateLegacyLoginGate(appId, oidcEnabledForApp)`, a pure decision function. Blocks only when `appId === "sylo"` AND the (already-existing) rollout flag is on. Cutover (5d-b) and disabling the old path (5d-c) are the same flag flip — no second toggle. Same "duplicate the one boundary check per call site" discipline the rest of 5c/5d already uses, documented in the file's own header.
- **Modified: `routes/auth.ts`** — `POST /auth/login` now calls `getOidcRolloutFlag()` + `evaluateLegacyLoginGate()` immediately after resolving `legacyLoginAppId`, *before* the credential DB lookup. A block returns `403 { error, code: "OIDC_REQUIRED", solution }` and is recorded as a monitored `"legacy"` failure (feeds 5e-a/5e-b). Every other `/auth/*` route (register, magic-link, passkey, session-exchange, refresh, logout) is untouched — 5d-c's scope is exactly the one credential-form login endpoint.
- **New: `scripts/src/test-oidc-cutover-gate.ts`** — 5 assertions on the gate's decision table (null appId, sylo on/off, non-Sylo app, case handling). **Run for real: all 5 pass.**

### 5d-d — Regression Test

- **New: `scripts/src/test-sylo-oidc-cutover-regression.ts`** — composed, DB-free regression suite simulating the full `POST /auth/login` branch structure (gate check → credential check) around the real `evaluateLegacyLoginGate()` and `oidc-login-attempts.ts` functions. Covers: pre-cutover legacy still works; post-cutover legacy blocked regardless of credentials; the block is monitored, not silent; a non-Sylo app is completely unaffected; the `oidc` path's own recording is untouched by 5d-c; rollback (flag back to false) reopens legacy on the very next attempt with no separate step; `evaluateOidcRolloutHealth()` correctly reports both a healthy and a broken post-cutover state (5e-c smoke test in both directions). **Run for real: all 8 pass.**

### 5e-a/5e-b — Login Failure Metrics + Token/Callback Errors

- **Modified: `lib/oidc-login-attempts.ts`** — additive changes only, existing exports unchanged in signature except `recordOidcLoginAttempt()` gaining an optional trailing `errorCode?: string` parameter:
  - `OidcLoginAttemptPath` gains `"callback"` (browser-reported `/oidc/callback` failures — no `"success"` counterpart by design, see file's own doc comment on why double-counting a login already recorded via the `"oidc"` path would be wrong).
  - `AttemptRecord` gains `errorCode`; `OidcLoginAttemptPathStats` gains `topErrors: Array<{ code, count }>` (top 5 + an `"other"` bucket), computed in `summarize()`.
  - New `recordOidcCallbackError(appId, errorCode)` — thin wrapper for the one caller (the new beacon route) that only ever reports failures.
  - `OidcLoginAttemptStats` gains a `callback` field alongside `legacy`/`oidc`.
- **Modified: `routes/oidc-token.ts`** — `respondTokenError()` now passes the actual `OidcTokenErrorCode` (e.g. `invalid_grant`) into `recordOidcLoginAttempt()` as `errorCode`, so the admin dashboard's `topErrors` shows the same vocabulary a client debugging its own integration sees.
- **New: `routes/oidc-client-errors.ts`** — `POST /oidc/client-errors`, bare-origin, `globalLimiter`, unauthenticated, body `{ appId, errorCode }`, always `204`. The one-way beacon for `/oidc/callback`'s browser-only failure states (`state_mismatch`, `identity_mismatch`, `missing_pending_transaction`, `missing_code`, `token_exchange_failed`, `session_exchange_failed` — everything in `SyloOidcCallbackErrorCode` except `provider_error`, which the provider side already logs on its own).
- **Modified: `app.ts`** — one import, one `app.use(oidcClientErrorsRouter)`, mounted bare-origin alongside the other `/oidc/*` routers, strictly before the `/api` mount. Purely additive.
- **Modified: `lib/sylo-oidc-callback.ts`** — new `reportSyloOidcCallbackError(errorCode, appId?, overrides?)`, fire-and-forget (`keepalive: true`, `.catch(() => {})`, never awaited by the caller), posts to the new beacon route. Excludes `provider_error` deliberately (see file's own new doc comment — avoids double-counting a failure the authorize endpoint already logged).
- **Modified: `pages/oidc-callback.tsx`** — the existing catch block now calls `reportSyloOidcCallbackError(err.code)` when `err instanceof SyloOidcCallbackError`, immediately before setting the error UI state. No behavior change to what the user sees; purely an added side-observation.

### 5e-c — Alert Thresholds

- **Modified: `lib/oidc-login-attempts.ts`** — new `evaluateOidcRolloutHealth(appId, windowMs?, thresholds?)`, a pure function of `getOidcLoginAttemptStats()`'s own output. Two thresholds, deliberately not a rules engine (see file's own header):
  - `minOidcSample` (default 20) — below this many `oidc` attempts in the window, always reports healthy (not enough traffic to trust a rate).
  - `maxFailureRateDeltaOverLegacy` (default 0.15) — how much worse `oidc`'s failure rate is allowed to be than `legacy`'s own concurrent rate.
  - `maxAbsoluteOidcFailureRate` (default 0.5) — a hard ceiling independent of legacy, catching the case where legacy is *also* failing badly.
  - Returns `{ healthy, reasons[], thresholds, stats }` — never itself acts on the result (no paging, no auto-rollback) — same "this file only answers a question" discipline the rest of the module already documents.
- **Modified: `routes/admin-oidc-rollout.ts`** — `GET /admin/oidc-rollout/:appId` now also returns `health` (the `evaluateOidcRolloutHealth()` result) alongside the existing `oidcEnabled`/`stats`. Import list and file header comment updated; PATCH endpoint unchanged.

### 5e-d — Rollback Drill

- **New: `scripts/src/test-oidc-rollback-drill.ts`** — DB-free part: spot-checks the real rollback CLI invocation (`parseArgs(["--app=sylo","--disable"])`, no override needed), confirms a `--dry-run` rollback still parses, confirms `evaluateLegacyLoginGate()` treats "never enabled" and "rolled back" identically (no separate disabled-by-rollback state to drift out of sync), then runs a full simulated drill sequence: cutover live → simulated unhealthy traffic (`evaluateOidcRolloutHealth()` actually flags it) → rollback issued → legacy reopened on the very next attempt → post-rollback traffic records cleanly. Ends with a printed **LIVE DRILL** checklist (real DB write, real cache propagation across instances, real browser check, timing the drill) — same shape as 5d-a's own checklist script, for the opposite direction. **Run for real: all 7 assertions pass.**

### 5e-e — Post-Cutover Verification

- **New: `scripts/src/test-oidc-post-cutover-verification.ts`** — composes `test-oidc-cutover-gate.ts` (5d-c), `test-sylo-oidc-cutover-regression.ts` (5d-d), `test-oidc-rollback-drill.ts` (5e-d), and `test-oidc-client-rollout.ts` (5c-d baseline) via `spawnSync`, same "don't trust a human to remember the right order" reasoning `test-sylo-oidc-cutover-checklist.ts` already established. Prints a pass/fail summary per suite, then a **LIVE VERIFICATION** checklist (real browser login, real 403 on a direct legacy POST, real admin GET showing `health.healthy: true` under traffic, a deliberately triggered OIDC and callback failure each showing up in `topErrors`/`stats.callback`, a logout sanity check, confirmation the 5e-d drill has actually been run against the real environment). Exits non-zero if any composed suite fails. **Run for real: mechanically confirmed working** — 3 of 4 composed suites pass outright; the 4th (`test-oidc-client-rollout.ts`) fails for the same pre-existing, already-disclosed reason noted below (its `CACHE_TTL_MS` spot-check imports `drizzle-orm`/`@workspace/db` at module load).

### `package.json`

- Added script entries: `oidc:test-client-rollout`, `oidc:test-cutover-gate`, `oidc:test-sylo-cutover-regression`, `oidc:rollback-drill`, `oidc:test-post-cutover-verification` (the first of these — `test-oidc-client-rollout.ts` — existed already but had no npm script before this pass).

## Regression checks

- `diff` on `app.ts`: purely additive (one import, one `app.use`), same as every earlier pass in this roadmap.
- `diff` on `routes/auth.ts`: additive imports + one new block inserted before the existing credential lookup in `POST /auth/login`; every other route in the file untouched.
- `diff` on `routes/oidc-token.ts`: one parameter threaded through `respondTokenError()`'s existing `recordOidcLoginAttempt()` calls; no branch logic changed.
- `diff` on `routes/admin-oidc-rollout.ts`: one import, one field added to the `GET` response; `PATCH` handler untouched.
- `diff` on `lib/oidc-login-attempts.ts`: every pre-existing export (`resolveLegacyLoginAppId`, `recordOidcLoginAttempt` — same required params, one new optional one — `getOidcLoginAttemptStats`, `DEFAULT_STATS_WINDOW_MS`, `__resetOidcLoginAttemptsForTests`) unchanged in call shape; only additions.
- Full syntax check (real TypeScript 7 parser, `tsc --noEmit` with `noResolve` since this sandbox has no installed workspace `node_modules`): **21 `.ts`/`.tsx` files in this pass's tree — 0 parse/syntax errors (TS1xxx range)**. Every diagnostic reported is `TS2307`/`TS2591`/`TS2304`/`TS2875` — unresolvable workspace imports and missing `@types/node`/`react` type packages, the identical class of "expected, sandbox has no installed node_modules" diagnostic every earlier CHANGES doc in this roadmap already discloses, not a real error.

## What was actually run, vs. what's still pending a live dependency

Run for real, in this sandbox, no stubbed crypto/network/DB:

- `scripts/src/test-oidc-cutover-gate.ts` — **all 5 assertions pass**.
- `scripts/src/test-sylo-oidc-cutover-regression.ts` — **all 8 assertions pass**.
- `scripts/src/test-oidc-rollback-drill.ts` — **all 7 assertions pass**.
- `scripts/src/test-oidc-post-cutover-verification.ts` — **runs end to end**, correctly composes and reports on the three suites above plus the pre-existing `test-oidc-client-rollout.ts`.

NOT run for real (same sandbox limitation every earlier CHANGES doc in
this roadmap already discloses — no network, no installed
`@workspace/db`/`drizzle-orm`/`express`/`react` for the two real
workspaces):

- `scripts/src/test-oidc-client-rollout.ts` — its `CACHE_TTL_MS` spot-check imports `lib/oidc-client-rollout.ts`, which imports `@workspace/db`/`drizzle-orm` at module top level. This was already true before this pass; unchanged by it.
- `routes/auth.ts`'s actual `POST /auth/login` 403 response, `routes/admin-oidc-rollout.ts`'s `health` field under real traffic, `routes/oidc-client-errors.ts`'s beacon actually reachable from a real page — all need `express` + a live DB + (for the beacon) a real browser hitting `/oidc/callback`.
- A real cutover, a real incident triggering 5e-c's thresholds organically, and a real rollback drill against a live (ideally staging) environment — the exact items each new script's own printed **LIVE …** checklist enumerates.

Run for real before calling Phase 5 VERIFIED in the roadmap's strict
§1.4/§8 sense: `pnpm install` in both workspaces, then every `test-*.ts`
file above via `npx tsx` (or `npx tsx scripts/src/test-oidc-post-cutover-verification.ts`
to run the composed set in one command), then the LIVE DRILL and LIVE
VERIFICATION checklists' items against a real cutover.

## Season 3 status after this pass

- 5a (OIDC Client Configuration) — done (prior pass).
- 5b (Sylo Login Wiring) — done (prior pass).
- 5c (Feature-Flagged Dual Run) — done (incoming tree, verified consistent this pass).
- 5d (Sylo Cutover) — done in this sandbox's sense: 5d-a/5d-b (prior), 5d-c/5d-d (this pass) all implemented and DB-free-tested for real.
- 5e (Monitoring & Rollback) — done in this sandbox's sense: 5e-a/5e-b (failure metrics + error-code breakdown, this pass), 5e-c (alert thresholds, this pass), 5e-d (rollback drill, this pass), 5e-e (post-cutover verification, this pass) all implemented and DB-free-tested for real.
- Per roadmap §1.4 (`DONE → TESTED → VERIFIED → NEXT`): Phase 5 (5a–5e-e) is **TESTED** in this sandbox's sense. **VERIFIED** still requires the live-environment items each script's own printed checklist enumerates — a real cutover against a real Sylo deployment, a real rollback drill, and the specific live checks in `test-oidc-post-cutover-verification.ts`'s own **LIVE VERIFICATION** section.

## Next sub-phase

Phase 6 — Logout + Session Tie-In. Out of scope for this pass per the
roadmap's own execution boundary (§1.3); not started or speculatively
implemented here.
