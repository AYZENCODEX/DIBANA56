# AYZEN Policy & Authorization Mega Engine — Phase 17 (Authorization Audit)

## Scope

Roadmap Phase 17 section implemented verbatim: "Create dedicated
authorization decision auditing," with the exact field list — decisionId,
requestId, subject reference, product, resource, action, decision,
policyId, policyVersion, risk, assurance, timestamp, latency, reasonCode —
plus "Avoid unnecessary sensitive data" and "Integrate with existing AYZEN
activity/security logging."

Builds on exactly two seams Phases 01/16 deliberately left for this
purpose:
- `PolicyEngine`'s `onDecision` hook (Phase 1C) — `decision-observer.ts`'s
  own header says this outright: "This is intentionally NOT Phase 17 ...
  Phase 17 can build real, queryable audit storage on top of this same
  `onDecision` seam later without touching the engine again."
- `decision.policyId`/`decision.policyVersion` (Phases 01/16) — already
  the exact fields needed for audit-row policy attribution; nothing new
  to add there.

One small, additive gap Phase 17 needed to close first: no existing field
carried decision *latency*. `AuthorizationDecision.latencyMs` (new) and
`PolicyEngine`'s own timing of `evaluateCore()` close that gap at the
source, so latency is measured where it's actually accurate (inside the
engine) rather than reconstructed later from log timestamps.

No engine-level combining-algorithm change, no change to any registered
rule's behavior, no route wired to authorization yet (same "engine, not
endpoint" posture every prior phase shipped with — Rule 16).

## Files added

| File | What it does |
|---|---|
| `lib/policy/audit/types.ts` | `AuthorizationAuditEntry` (roadmap's Phase 17 field list, typed) + `AuthorizationAuditWriter` interface. |
| `lib/policy/audit/to-audit-entry.ts` | `toAuditEntry()` — the one pure, DB-free `(decision, request) → AuthorizationAuditEntry` mapping. Derives `product` from the `product.resource.action` grammar (`request.action`, never `resource.type`); deliberately excludes `ip`/`sessionId`/`scopes`/full resource attribute set. |
| `lib/policy/audit/audit-observer.ts` | `createAuthorizationAuditObserver()` — a second `PolicyDecisionObserver`, parallel to Phase 1C's `createLoggingObserver()`, that persists every decision through a caller-supplied `AuthorizationAuditWriter`. Fire-and-forget; a writer failure is swallowed and can never become an authorization failure. |
| `lib/policy/audit/drizzle-audit-writer.ts` | `DrizzleAuthorizationAuditWriter` — the real, `@workspace/db`-backed writer. The one file in this directory that imports `@workspace/db` (excluded from the barrel, same precedent every prior Drizzle provider already established). |
| `lib/policy/audit/index.ts` | Barrel for `types.ts`/`to-audit-entry.ts`/`audit-observer.ts` (not the Drizzle writer). |
| `lib/db/src/schema/authorization-audit-log.ts` | `authorizationAuditLogTable` — typed columns (not one JSONB blob) so every Phase 17 field is independently indexable. |
| `migrations/103_ayzen_authorization_audit_log.sql` | Creates `authorization_audit_log` + indexes + append-only DB triggers (no UPDATE, no DELETE), same pattern as migration 073 (`vault_backup_audit_log`). |
| `scripts/src/test-policy-audit.ts` | 23 DB-free tests, using an in-memory `FakeAuditWriter`. |

## Files changed

| File | What changed |
|---|---|
| `lib/policy/types.ts` | Added `AuthorizationDecision.latencyMs?: number` — optional, additive, `undefined` for any decision never run through `evaluate()`/`evaluateWithTrace()`. |
| `lib/policy/policy-engine.ts` | `evaluate()`/`evaluateWithTrace()` now time their own `evaluateCore()` call (`Date.now()` before/after) and stamp the elapsed ms onto the returned decision via a new, non-mutating `stampLatency()` helper. No change to `evaluateCore()`'s combining logic itself. |
| `lib/policy/index.ts` | Top-level barrel now also exports `./audit` (types, `toAuditEntry`, `createAuthorizationAuditObserver` — not the Drizzle writer). |
| `lib/db/src/schema/index.ts` | Added `export * from "./authorization-audit-log"`. |

## Notable design points

- **A second observer, not a replacement.** `createAuthorizationAuditObserver()`
  and Phase 1C's `createLoggingObserver()` are independent
  `PolicyDecisionObserver`s built from the exact same seam. An app that
  wants both structured logs *and* a durable audit row for the same
  decision composes them (call one, then the other) — `PolicyEngine` only
  ever accepts a single `onDecision` callback, and this phase does not
  change that contract.
- **`product` is derived from `request.action`, never `resource.type`.**
  `registry-rule-loader.ts`'s own header is explicit that the
  `product.resource.action` grammar's three dot-segments come from
  `action`; `ResourceRef.type` (e.g. `"sylo.vault_item"`) is a separate,
  two-segment convention that does not reliably share the same first
  segment. `deriveProduct()` only returns a value when `action` is
  exactly three `[a-z0-9_-]+` segments — an opaque Phase-01-style action
  yields `undefined`, never a guess.
- **"Subject reference," not "subject."** Only `userId`/`role`/`authType`/
  `organizationId` are captured — never `scopes`, never the full
  `Subject`/`ResourceRef`/`PolicyContext` objects. Verified by a test that
  asserts the built entry's JSON serialization never contains the
  fixture's `ip`, `sessionId`, or `scopes` values.
- **An audit row is written even when there is no subject at all.**
  UNAUTHENTICATED (subject: null) and INVALID_AUTHORIZATION_CONTEXT
  (request could not even be built) decisions still produce an entry —
  Rule 10 ("sensitive authorization decisions must be auditable") does not
  carve out an exception for the cases where nothing else in the request
  succeeded.
- **`latencyMs` is measured by the engine, not reconstructed by the
  audit layer.** Timing starts before `evaluateCore()`'s first branch
  (covering the invalid-context/unauthenticated short-circuits too, not
  just the full rule-evaluation path) and is stamped once, by the one
  method (`evaluate()`/`evaluateWithTrace()`) every caller already goes
  through — an external caller timing around an already-async call would
  contaminate the number with its own overhead; this does not.
- **Append-only by DB trigger, not by convention.** Same discipline
  migration 073 established for `vault_backup_audit_log`: `BEFORE
  DELETE`/`BEFORE UPDATE` triggers raise an exception unconditionally, so
  a bug or a compromised account with DB write access still cannot
  quietly edit or erase a row.
- **Distinct from `policy_admin_audit_log` (Phase 07), on purpose.** That
  table records *administrative* policy-registry mutations (who
  created/versioned/activated a policy); this table records the *runtime
  outcome* of every `PolicyEngine.evaluate()` call, registry-backed or
  not. Two different questions, two separate tables — not merged, same
  posture `vault_backup_audit_log` and `user_activity` already coexist
  under.
- **PrecedenceEngine is deliberately NOT touched this phase.**
  `PrecedenceEngine` has its own, differently-shaped `onTierEvaluated`
  observer (tier-level, not per-decision) and no `onDecision` hook — Phase
  17's audit wiring targets the seam Phase 1C actually built for it
  (`PolicyEngine.onDecision`). Extending `PrecedenceEngine` with its own
  equivalent hook is a natural, small follow-up but is out of scope for
  this delivery (Rule 16) — see "Known limitations" below.

## Test status

- `scripts/src/test-policy-audit.ts` — 23/23 passing.
- Full regression: all 22 pre-existing `scripts/src/test-policy-*.ts`
  suites (Phases 01-16, 1B, 1C) still pass unchanged, run individually
  after this phase's changes.
- Scoped `tsc --noEmit` (with `types: []`, to work around this sandbox
  having no installed `@types/node`/`node_modules` — no network available
  to install them) over the `api-server` package: zero NEW errors
  introduced by this phase. Every remaining error under `lib/policy/**`
  is the exact same "Cannot find module '@workspace/db'/'drizzle-orm'" /
  "Cannot find name 'node:crypto'" class already present, identically, on
  every prior phase's own Drizzle-touching file (confirmed by diffing
  against `registry/drizzle-policy-registry-provider.ts` and
  `policy-context.ts`, both pre-existing) — an environment limitation, not
  a code defect. One real issue this scoped check did catch and fix before
  landing: `audit-observer.ts`'s returned closure needed an explicit
  `void | Promise<void>` return type and an explicit `return undefined` in
  its catch branch (TS7030, "not all code paths return a value").

## Known limitations

- Nothing in the app constructs `new PolicyEngine({ onDecision:
  createAuthorizationAuditObserver(new DrizzleAuthorizationAuditWriter())
  })` yet — this phase ships the engine and the writer, not the endpoint
  wiring (same posture every prior phase shipped with; no route currently
  calls `PolicyEngine.evaluate()` at all, per the roadmap's own migration
  strategy).
- `DrizzleAuthorizationAuditWriter` cannot be executed against a real
  database in this sandbox (no network, no installed `node_modules`) —
  typed and reviewed, not integration-tested against real Postgres.
- No batching. One `INSERT` per decision. Acceptable for Phase 17's own
  scope; "avoid N+1" is Phase 20's (`authorizeMany()`) concern if this
  ever becomes a measured problem — not solved preemptively here (Rule
  16).
- `PrecedenceEngine` does not get an equivalent `onDecision`/audit hook
  this phase (see "Notable design points" above).
- No read/query API over `authorization_audit_log` is built this phase —
  the roadmap's own Phase 23 (Admin Policy Console, "Decision Logs"
  section) is the natural home for that; Phase 17's own scope is the
  write path only.

## Migration status

Written, not yet run against a live DB. Run
`103_ayzen_authorization_audit_log.sql` in Supabase SQL Editor, after 102.

## Regression status

Clean — all Phase 01-16 suites still pass, individually re-run after this
phase's changes to `policy-engine.ts`/`types.ts`.

## PHASE STATUS

- Implemented: yes — `AuthorizationAuditEntry`, `toAuditEntry()`,
  `createAuthorizationAuditObserver()`, `DrizzleAuthorizationAuditWriter`,
  `AuthorizationDecision.latencyMs` + engine-level stamping.
- Files changed: `lib/policy/types.ts`, `lib/policy/policy-engine.ts`,
  `lib/policy/index.ts`, `lib/db/src/schema/index.ts`.
- Files added: 5 (`lib/policy/audit/*`), 1 schema file
  (`lib/db/src/schema/authorization-audit-log.ts`), 1 migration (103), 1
  test script.
- Database changes: 1 new table (`authorization_audit_log`) + 5 indexes +
  2 append-only-enforcement triggers. No change to any existing table.
- Tests: 23/23 (Phase 17), plus all 22 pre-existing policy suites still
  green.
- Security tests: sensitive-data exclusion (ip/sessionId/scopes never
  reach a built entry — asserted by string-search over the serialized
  entry, not just field-by-field), fail-closed posture (a throwing writer
  never changes or blocks the returned `AuthorizationDecision`, for both
  ALLOW and DENY paths), parity (wiring the audit observer never changes
  which decision is reached, verified byte-for-byte modulo `latencyMs`),
  audit-on-every-path (ALLOW/DENY/STEP_UP/APPROVAL_REQUIRED/UNAUTHENTICATED
  each produce exactly one row).
- Known limitations: see above.
- Migration status: written, not yet run.
- Regression status: clean.
- Next phase: 18 (PIP / Attribute Providers).
