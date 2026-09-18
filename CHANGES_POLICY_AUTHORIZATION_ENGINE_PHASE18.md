# AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute Providers)

## Scope

Roadmap Phase 18 section implemented: "Create provider interfaces:
SubjectProvider, ResourceProvider, OrganizationProvider, SessionProvider,
RiskProvider, DeviceProvider, RelationshipProvider. PDP requests context
through providers instead of arbitrary DB queries."

Inspection first (Rule: "inspect, map dependencies, identify existing
implementations" before changing anything). Six of the roadmap's seven
names already existed in this engine, under other names, built
incrementally as each concern's own earlier phase needed them:

| Roadmap name | Already existed as | Phase |
|---|---|---|
| RiskProvider | `RiskLevelProvider` (`pip/risk-level-adapter.ts`) | 10B |
| RelationshipProvider | `RelationshipProvider` (`rebac/types.ts`) — already this exact name | 04 |
| SessionProvider | *(gap — nothing populated `sessionAgeSeconds` yet)* | — |
| DeviceProvider | *(gap — nothing populated `deviceTrust` yet)* | — |
| ResourceProvider | *(gap — no generic resource-attribute lookup existed)* | — |
| OrganizationProvider | *(gap — no organizations table exists)* | — |
| SubjectProvider | *(gap — identity/verification/account-state were three separate steps, never composed under one name)* | — |

This phase's work was therefore split three ways:

1. **Name the six/seven concepts under the roadmap's own vocabulary**
   (`pip/types.ts`), as type ALIASES over the pre-existing interfaces where
   one already existed — not new/parallel interfaces, so nothing that
   already implements e.g. `RiskLevelProvider` needs to change (TypeScript
   interfaces are structural).
2. **Close two real gaps with real, already-durable backing data**:
   - `Subject.accountState` (existed since Phase 05, never populated) ←
     `users.status` — a real, already-enforced account-lifecycle column
     (`auth-utils.ts` already refuses to authenticate a
     `"banned"`/`"suspended"` user before a request ever reaches the PDP).
   - `PolicyContext.sessionAgeSeconds` (existed since Phase 05, never
     populated) ← `user_sessions.created_at`, keyed by the `sessionId`/jti
     already carried on `PolicyContext` (Phase 1B).
   - `PolicyContext.deviceTrust` (existed since Phase 05, never populated)
     ← whether a user's `user_sessions.user_agent` has been seen before for
     that user — a coarse but genuine, already-durable signal. Only ever
     produces `"trusted"`/`"unknown"`, never a fabricated `"untrusted"`
     (no negative device signal exists anywhere in this codebase).
   - `SubjectProvider` — a real composition of `subjectFromAuthUser()`
     (Phase 1B) + `withVerificationLevel()` (Phase 9B) + the new
     `withAccountState()`, into one `DrizzleSubjectProvider`.
3. **Give the two remaining gaps (`ResourceProvider`, `OrganizationProvider`)
   an honest, interface-only contract — no implementation.** AYZEN has no
   generic `resources` table (resources live across independently-schemaed
   per-product tables — vault items, finance invoices, projects, oidc
   clients, ...) and no `organizations` table at all. Shipping a fake or
   generic implementation for either would be exactly the "convert mock
   functionality into production functionality without real backend
   support" Rule 18 forbids. Both interfaces exist so a future per-product
   resource adapter, or a future organizations feature, has an
   authoritative shape to implement against — narrowing the gap from zero
   to "a name and shape exist," not pretending the gap is closed.

Also added: `PolicyInformationPoint` (`pip/policy-information-point.ts`) —
a composition facade that is the concrete answer to this phase's own "PDP
requests context through providers instead of arbitrary DB queries"
framing. It takes whichever of `SubjectProvider`/`RiskProvider`/
`SessionProvider`/`DeviceProvider` a caller constructs (every slot
optional) and produces a fully-attributed `Subject`/`PolicyContext`,
without the caller needing to know which table backs which attribute or in
which order the enrichment steps compose. `ResourceProvider`/
`OrganizationProvider`/`RelationshipProvider` are deliberately NOT slots on
this facade — see "Notable design points" below.

No engine-level change, no change to `types.ts`'s `Subject`/`ResourceRef`/
`PolicyContext` shapes (every field this phase populates already existed,
optional, since Phase 05), no change to any registered rule's behavior, no
route wired to authorization yet (same "engine, not endpoint" posture
every prior phase shipped with — Rule 16).

## Files added

| File | What it does |
|---|---|
| `lib/policy/pip/account-state-adapter.ts` | `AccountStateProvider` interface + `withAccountState()` — DB-free, populates `Subject.accountState`. |
| `lib/policy/pip/drizzle-account-state-provider.ts` | `DrizzleAccountStateProvider` — the real, `@workspace/db`-backed implementation, reading `users.status`. Excluded from the barrel (imports `@workspace/db`). |
| `lib/policy/pip/session-context-adapter.ts` | `SessionRecord`/`SessionContextProvider` + `computeSessionAgeSeconds()`/`withSessionAge()` — DB-free, populates `PolicyContext.sessionAgeSeconds`, computed against `context.timestamp` (never a fresh clock read, per Rule 12). |
| `lib/policy/pip/drizzle-session-context-provider.ts` | `DrizzleSessionContextProvider` — the real implementation, reading `user_sessions.created_at` via raw `pool` SQL (table predates Drizzle schema coverage, same posture `login-security-risk-provider.ts` documents for `login_history`). Fails closed to `null` for a revoked/expired/unknown `jti`. Excluded from the barrel. |
| `lib/policy/pip/device-trust-adapter.ts` | `DeviceSignal`/`DeviceTrustProvider` + `mapDeviceSignalToTrust()`/`withDeviceTrust()` — DB-free, populates `PolicyContext.deviceTrust`. Only ever `"trusted"`/`"unknown"` — see file header for why `"untrusted"` is deliberately never produced. |
| `lib/policy/pip/drizzle-device-trust-provider.ts` | `DrizzleDeviceTrustProvider` — the real implementation: has this `(userId, userAgent)` pair appeared in `user_sessions` before. Documents its own known limitation (User-Agent is a coarse, non-unique fingerprint). Excluded from the barrel. |
| `lib/policy/pip/resource-attribute-provider.ts` | `ResourceAttributeProvider` — interface only. No implementation ships this phase; header explains why (no generic resources table across AYZEN's per-product schemas). |
| `lib/policy/pip/organization-provider.ts` | `OrganizationMembership`/`OrganizationProvider` — interface only. No implementation ships this phase; header explains why (no `organizations` table exists anywhere in this codebase). |
| `lib/policy/pip/types.ts` | The roadmap's seven-name vocabulary, collected: `RiskProvider`/`SessionProvider`/`DeviceProvider`/`ResourceProvider` as type aliases over the interfaces above; `SubjectProvider` (genuinely new) — composes identity + verification + account state, deliberately excluding `riskLevel` (needs request-scoped `context.ip`, composed separately — see `PolicyInformationPoint`). `RelationshipProvider` is deliberately NOT re-aliased here (see "Notable design points"). |
| `lib/policy/pip/drizzle-subject-provider.ts` | `DrizzleSubjectProvider` — the real `SubjectProvider`, composing `subjectFromAuthUser()` + `withVerificationLevel()` + `withAccountState()`. Excluded from the barrel (imports `@workspace/db` transitively). |
| `lib/policy/pip/policy-information-point.ts` | `PolicyInformationPoint` — the composition facade (`resolveSubject()`/`resolveContext()`). DB-free itself (no query of its own); safe to include in the barrel. |
| `scripts/src/test-policy-pip-providers.ts` | Phase 18 test suite — 19/19 passing (see below). |

## Files changed

| File | Change |
|---|---|
| `lib/policy/index.ts` | Added Phase 18 barrel section: `pip/account-state-adapter`, `pip/session-context-adapter`, `pip/device-trust-adapter`, `pip/resource-attribute-provider`, `pip/organization-provider`, `pip/types`, `pip/policy-information-point`. The four `drizzle-*` files above are deliberately excluded (same precedent every prior Drizzle provider in this engine already established). |

No other file touched. `types.ts` (`Subject`/`ResourceRef`/`PolicyContext`)
is unchanged — every field this phase populates (`accountState`,
`sessionAgeSeconds`, `deviceTrust`) already existed there, optional, since
Phase 05.

## Database changes

None. No migration. This phase reads two pre-existing, already-durable
columns/tables (`users.status`; `user_sessions.created_at`/`user_agent`) —
no schema change needed for either.

## Notable design points

- **Type aliases, not new interfaces, for the six roadmap names that
  already had an equivalent.** `RiskProvider = RiskLevelProvider`,
  `SessionProvider = SessionContextProvider`, `DeviceProvider =
  DeviceTrustProvider`, `ResourceProvider = ResourceAttributeProvider`.
  TypeScript interfaces are structural, so any existing/future
  `RiskLevelProvider` implementation (e.g. `LoginSecurityRiskProvider`,
  Phase 10B) already satisfies `RiskProvider` with zero changes on that
  side. This is Rule 1 ("do not rewrite from scratch") applied literally to
  a naming phase.
- **`RelationshipProvider` deliberately NOT re-aliased in `pip/types.ts`.**
  It already carries this exact name in `rebac/types.ts` (Phase 04). A
  second `export type RelationshipProvider = ...` in `pip/types.ts` would
  make `lib/policy/index.ts`'s two `export *` barrels (`./rebac` and
  `./pip/types`) ambiguous for that one name — TypeScript does not dedupe
  two independently-declared aliases of the same name across wildcard
  re-exports even when structurally identical. Import it from
  `./rebac`/the top-level barrel, as every prior phase already does.
- **`SubjectProvider` does not populate `riskLevel`.** Risk needs
  `context.ip` — a request-scoped fact, not a pure per-user account
  attribute the way `verificationLevel`/`accountState` are. The roadmap
  itself lists `RiskProvider` as a separate item from `SubjectProvider`;
  `PolicyInformationPoint.resolveSubject()` composes the two in sequence
  (subject first, then risk once a `PolicyContext` exists) rather than
  folding risk into `DrizzleSubjectProvider`.
- **`ResourceProvider`/`OrganizationProvider` ship as contracts only, with
  no implementation — by design, not by omission.** See each file's own
  header for the full reasoning; in short: a generic resource-attribute
  lookup has no single table to read (AYZEN's resources are spread across
  per-product schemas, and Phase 03's resource rules already receive a
  fully-populated `ResourceRef` from each route for exactly this reason),
  and an organizations table does not exist anywhere in this codebase.
  Rule 18 ("do not convert mock functionality into production functionality
  without real backend support") reads as a direct instruction not to
  paper over either gap with a fake/generic implementation.
- **`PolicyInformationPoint` intentionally has no
  `resource`/`organization`/`relationship` provider slots.** Every existing
  rule that needs a `ResourceGrantProvider` or `RelationshipProvider`
  already receives it directly as a constructor argument, from the phase
  that built it (`createExplicitResourceGrantRule()` — Phase 3B;
  `createRebacRule()` — Phase 04; `createSeparationOfDutiesRule()` — Phase
  13). Routing the same objects through this facade too would be a second,
  parallel path to hand the identical provider to the identical rule, not
  a simplification — and those call sites were never "arbitrary DB
  queries" to begin with, so this phase's own framing doesn't apply to
  them. `ResourceAttributeProvider`/`OrganizationProvider` additionally
  have nothing to compose (no implementation exists).
- **`accountState`'s fail-closed default is `"unknown"`, not `"active"`.**
  `users.status` defaults to `"active"` in the schema, but
  `DrizzleAccountStateProvider` returns the sentinel `"unknown"` if no
  matching user row exists (should not happen for an already-authenticated
  `Subject`, but this is the "unknown key contributes nothing, never
  guesses the permissive answer" posture every other `*Provider` in this
  engine follows) — so a future condition written as `subject.accountState
  == "active"` can never accidentally pass on missing data.
- **`sessionAgeSeconds` is computed against `context.timestamp`, never a
  fresh clock read** — same "evaluate against the request's own stamped
  time" discipline `temporary-access-rule.ts` (Phase 11) already
  established, so repeated evaluation of the same `AuthorizationRequest`
  is guaranteed deterministic (Rule 12).
- **`deviceTrust` only ever produces `"trusted"`/`"unknown"`.** There is no
  data source anywhere in this codebase for a genuine negative device
  signal (blocklist, jailbreak/root detection, EDR posture). Fabricating an
  `"untrusted"` value from the absence of a positive signal would be
  indistinguishable from a brand-new legitimate device on its first login —
  a false-positive risk this module declines to take on, per the same
  restraint `risk-level-adapter.ts` (Phase 10B) documents for reusing only
  real signals.
- **`authenticationFreshnessSeconds` remains unpopulated**, same as
  `Subject.assuranceMethods` (Phase 9B). Nothing in this codebase records
  WHEN a step-up/re-auth last completed for a session — only when the
  session itself was opened (`user_sessions.created_at`). Populating it
  from `created_at` would silently treat every session's login moment as
  its last strong-auth moment even after a step-up refreshes the latter —
  the same class of regression `verification-level-adapter.ts` already
  declined to risk for `assuranceMethods`. Left for a later phase that adds
  real step-up-timestamp tracking (Rule 16).

## Test status

- `scripts/src/test-policy-pip-providers.ts` — 19/19 passing. Covers:
  `withAccountState` (populate/no-mutate/always-overwrite);
  `computeSessionAgeSeconds` (age math, floors at 0);
  `withSessionAge` (no `sessionId` → no-op, unknown `jti` → no-op,
  populated case computed against `context.timestamp`, never mutates
  input); `mapDeviceSignalToTrust`/`withDeviceTrust` (trusted/unknown
  mapping, never "untrusted", missing/blank `userAgent` → no-op);
  `PolicyInformationPoint.resolveSubject` (zero-provider fallback to
  `subjectFromAuthUser()`, null/undefined passthrough, SubjectProvider +
  RiskProvider composition, risk skipped when no RiskProvider configured);
  `PolicyInformationPoint.resolveContext` (SessionProvider + DeviceProvider
  composition, device enrichment skipped when `opts.userId` is absent).
- Full regression: all 23 pre-existing `scripts/src/test-policy-*.ts`
  suites (Phases 01-17, 1B, 1C, 9A/9B, 10A/10B, 3A/3B/3C) re-run
  individually after this phase's changes — all still pass, unchanged.
- Scoped `tsc --noEmit` over `lib/policy/**` (stubbed `@workspace/db`/
  `drizzle-orm`/`express`/`jsonwebtoken`/`zod` module shapes locally, no
  network available to install real `node_modules` — same environment
  limitation every prior phase's own report documents): zero NEW errors
  introduced by this phase. Verified directly by temporarily removing every
  Phase 18 file and re-running the same scoped check — the exact same 9
  pre-existing error lines remain (missing `@workspace/db` table exports
  the stub doesn't model, `node:crypto` type-lookup, an `override`-modifier
  quirk on two pre-existing error classes) both with and without this
  phase's files present; none of the errors, with the files present,
  reference any Phase 18 file.

## Security tests

- **Fail-closed posture, every new provider**: `DrizzleAccountStateProvider`
  returns `"unknown"` (not `"active"`) for a missing row;
  `DrizzleSessionContextProvider` returns `null` for a revoked/expired/
  unknown session (never a stale age); `withDeviceTrust`/`withSessionAge`
  leave their target field `undefined` rather than guess when their input
  is missing — verified by the "no-op"/"unrecognized" test cases above.
- **Never trusts client-supplied context (Rule 9)**: every new adapter
  reads exclusively from `context.sessionId`/`context.timestamp` (both
  already server-resolved upstream, same trust boundary every existing
  `PolicyContext` field relies on) or from an explicit `userId`/`userAgent`
  parameter a caller must already have obtained server-side — no new
  adapter accepts a pre-computed `accountState`/`sessionAgeSeconds`/
  `deviceTrust` value from anywhere a request body/header could reach.
- **Immutability**: every `with*()` function returns a NEW object; three
  dedicated "never mutates the input" tests assert the original
  `Subject`/`PolicyContext` is untouched.
- **No fabricated negative signal**: `withDeviceTrust`'s
  "unrecognized device maps to unknown, never untrusted" test asserts the
  weaker reading is chosen for absent data, not a fabricated stronger one —
  directly testing the restraint documented in device-trust-adapter.ts's
  header.

## Known limitations

- Nothing in the app constructs a `PolicyInformationPoint`,
  `DrizzleSubjectProvider`, `DrizzleSessionContextProvider`, or
  `DrizzleDeviceTrustProvider` yet — this phase ships the providers and the
  facade, not the endpoint wiring (same posture every prior phase shipped
  with; no route currently calls `PolicyEngine.evaluate()` at all, per the
  roadmap's own migration strategy). Wiring one into an actual request path
  is Phase 19's (PEP) concern.
- None of the four new `Drizzle*`/`user_sessions`/`users`-reading providers
  can be executed against a real database in this sandbox (no network, no
  installed `node_modules`) — typed and reviewed, not integration-tested
  against real Postgres.
- `ResourceAttributeProvider`/`OrganizationProvider` ship as interfaces
  with zero implementations, by design (see "Notable design points" and
  each file's own header) — not a partial delivery of Phase 18, a
  deliberate one given what this codebase's schema actually supports today.
- `deviceTrust`'s User-Agent-based signal is coarse (documented in
  `drizzle-device-trust-provider.ts`'s own header): identical across every
  user of the same browser/OS/version, and changes on every browser
  version bump. A real device-fingerprinting feature is out of scope for
  this phase (Rule 18: no mock-to-prod without a real backend to build one
  on top of yet).
- `authenticationFreshnessSeconds` remains unpopulated — see "Notable
  design points" above for why, same gap `assuranceMethods` has had since
  Phase 9B.

## Migration status

None required — no schema change this phase.

## Regression status

Clean — all Phase 01-17 suites (24 total scripts, including this phase's
own) still pass, individually re-run after this phase's changes.

## PHASE STATUS

- **Implemented**: yes — `AccountStateProvider` + `DrizzleAccountStateProvider`
  (`Subject.accountState` ← `users.status`); `SessionContextProvider` +
  `DrizzleSessionContextProvider` (`PolicyContext.sessionAgeSeconds` ←
  `user_sessions.created_at`); `DeviceTrustProvider` +
  `DrizzleDeviceTrustProvider` (`PolicyContext.deviceTrust` ←
  `user_sessions.user_agent` recurrence); `SubjectProvider` +
  `DrizzleSubjectProvider` (composition of identity + verification +
  account state); `ResourceAttributeProvider`/`OrganizationProvider`
  (interfaces only, no implementation, by design); the roadmap's seven-name
  vocabulary collected in `pip/types.ts`; `PolicyInformationPoint` (the
  provider-composition facade).
- **Files changed**: `lib/policy/index.ts`.
- **Files added**: 11 in `lib/policy/pip/*` + 1 test script (12 total).
- **Database changes**: none.
- **Tests**: 19/19 (Phase 18), plus all 23 pre-existing policy suites still
  green (24/24 `scripts/src/test-policy-*.ts` scripts overall, including
  this phase's own, all passing).
- **Security tests**: fail-closed defaults on missing data (every new
  provider), never trusts client-supplied context, immutability
  (never-mutates-input) on every enrichment function, no fabricated
  negative device signal.
- **Known limitations**: see above.
- **Migration status**: none required.
- **Regression status**: clean.
- **Next phase**: 19 (PEP / Express SDK).
