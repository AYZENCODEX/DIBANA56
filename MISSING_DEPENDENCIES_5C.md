# Status: gaps filled — please review before running

Your earlier upload (`ayzen_phase5_sylo_oidc_migration_complete.zip`) was a
snapshot from the end of **Phase 5a/5b only**, predating Phase 5c. Your
other uploads (`admin-oidc-rollout (2).ts`, `oidc-callback.tsx`,
`oidc-login-attempts.ts`, `sylo-oidc-callback.ts`, `oidc-cutover-gate.ts`,
`oidc-client-errors.ts`, `oidc-rollout-flag.ts`, `oidc-client-rollout.ts`,
`auth (1).ts`, `App (1).tsx`, `login (1).tsx`, `index (4).ts`,
`package (4).json`, the four new `test-*.ts` files) are the real,
final-state 5c–5e files and are placed in this tree unmodified except for
the additive edits below.

## Additive edits I made against the real base files

- `artifacts/api-server/src/app.ts` — added `oidc-rollout-flag` and
  `oidc-client-errors` router imports + bare-origin `app.use(...)` mounts.
- `artifacts/api-server/src/routes/index.ts` — added the
  `admin-oidc-rollout` router import + `router.use(...)`, same tier as
  `configRouter`.
- `scripts/package.json` — added every `oidc:*` script entry the CHANGES
  doc lists.

## Files I reconstructed from scratch this pass

Seven files were referenced by imports in your uploaded files but existed
in neither upload. Since you asked me to complete the task, I wrote them —
but unlike everything above, **these are new code I authored to match the
documented behavior and this repo's existing conventions, not files
recovered from your real project**. Please review them against whatever
actually exists in your live repo before running anything against a real
database:

1. **`lib/db/src/schema/oidc-rollout-flags.ts`** — Drizzle table def for
   `oidc_client_rollout_flags` (`appId` unique text, `oidcEnabled` boolean
   default false, timestamps). Matches exactly how
   `lib/oidc-client-rollout.ts` already queries/writes it.
2. **`migrations/083_ayzen_oidc_rollout_flags.sql`** — `CREATE TABLE` for
   the above, styled after migrations 078/079's header/comment format.
   **If your real database already has this table from when 5c was
   actually built, do not re-run this — diff it against your real schema
   first.**
3. **`artifacts/ayzen/src/lib/sylo-oidc-rollout-flag.ts`** — frontend
   `getSyloOidcRolloutFlag()`, mirroring `lib/oidc-client-rollout.ts`'s
   fail-safe-to-false / 15s-cache behavior, fetching
   `${getApiBase()}/oidc/rollout-flags/:appId`. `App.tsx` and `login.tsx`
   both import this by name (`getSyloOidcRolloutFlag`) — the signature
   matches their call sites.
4. **`scripts/src/set-oidc-rollout-flag.ts`** — the CLI script. Its
   exported `parseArgs()` matches the exact contract
   `test-oidc-rollback-drill.ts` already asserts against
   (`{ app, action, allowNonSylo, dryRun }`, `--app=`, `--enable`/
   `--disable`, `--allow-non-sylo`, `--dry-run`) — that file's tests
   should pass unmodified against this implementation.
5. **`scripts/src/test-oidc-rollout-flag.ts`** — new DB-free tests for
   `parseArgs()`'s own decision table.
6. **`scripts/src/test-oidc-client-rollout.ts`** — a DB-free spot-check of
   `CACHE_TTL_MS`'s value only, with its own header explaining why this
   module (unlike the others) has no pure decision function to test more
   thoroughly without a real Postgres connection.
7. **`scripts/src/test-sylo-oidc-cutover-checklist.ts`** — the 5d-a
   pre-cutover checklist, composing 5a/5b/5c's suites via `spawnSync` (same
   pattern as `test-oidc-post-cutover-verification.ts`) plus a spot-check
   of the `--enable` cutover command, ending in a printed **LIVE
   CHECKLIST**.

## `routes/oidc-token.ts` — now wired (this pass)

Originally I left this untouched (base zip predates 5c-d, no
`recordOidcLoginAttempt` calls existed at all). Since you asked me to
finish it: I added the 5c-d/5e-a wiring myself — a `recordTokenFailure()`
helper called alongside every existing `logger.warn(...)` in each failure
branch (`invalid_request`, `unsupported_grant_type`, client-auth failure,
`invalid_grant` for consumption/binding/PKCE), plus one
`recordOidcLoginAttempt(appId, "oidc", "success")` call right after a code
is redeemed. `appId` is the request's `client_id`; it's skipped (recorded
as nothing) when no `client_id` can yet be trusted, same "don't attribute
what you can't verify" rule `resolveLegacyLoginAppId()` already applies on
the legacy side. No existing branch logic changed — this is a diff in the
same additive shape the CHANGES doc describes for it. Same caveat as the
other reconstructed files: written to match the documented contract, not
recovered from your real file — diff it against your live version before
trusting it in production.

## Syntax-checked

Ran `tsc --noEmit --noResolve` over every new/edited file in this pass —
zero `TS1xxx` (real syntax) errors. Remaining diagnostics are all
unresolved-import/missing-type-package noise, the same class every CHANGES
doc in this roadmap already discloses for a sandbox with no installed
`node_modules`.
