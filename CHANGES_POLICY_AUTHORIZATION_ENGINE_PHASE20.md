# AYZEN Policy & Authorization Mega Engine — Phase 20 (Batch Authorization)

## Scope

Roadmap Phase 20 section implemented, verbatim: "Support: `authorizeMany()`.
Use for: marketplace lists, projects, organization members, vault
resources, admin dashboards. Avoid N+1 authorization queries."

## Inspection first

`authorize()` (Phase 19, `pep/authorize.ts`) itself performs zero DB reads
— but everything it can delegate to for Subject/PolicyContext resolution
does: a Phase 18 `PolicyInformationPoint` composes `SubjectProvider` /
`RiskProvider` / `SessionProvider` / `DeviceProvider`, and the real,
`@workspace/db`-backed implementations of those (`drizzle-subject-
provider.ts`, `login-security-risk-provider.ts`, `drizzle-session-context-
provider.ts`, `drizzle-device-trust-provider.ts`) each do read the
database. A route rendering a list of N resources that called `authorize()`
once per row would therefore re-resolve the SAME subject's risk/session/
device/verification standing N times over for one page render — the real
N+1 this phase targets. Every registered `PolicyRule` (Phase 02-13) is
otherwise already an in-memory, once-per-batch-cheap function once
subject/context is resolved (RBAC's own provider reads are keyed by
`userId`, not by resource — see `rbac/rbac-rule.ts`'s own header), so
batching the RULE evaluation itself was not the gap; batching the
SUBJECT/CONTEXT resolution around it was.

## Implementation

Added `authorizeMany()` (and a small convenience, `allowedKeys()`) to the
same `lib/policy/pep/` directory as `authorize()` — not a new top-level
directory — because it takes an Express `Request`, exactly like
`authorize()` does, and exists to remove redundant work `authorize()`
itself does per-call, not to add a new PDP capability.

`authorizeMany()`:

1. Resolves `req.user` + `req` into a single `Subject`/`PolicyContext`,
   using the exact same three-branch logic `authorize()` already
   implements (PIP-enriched when `enrichment.pip` is supplied, the DB-free
   Phase 1B adapters otherwise) — deliberately duplicated rather than
   factored into a shared helper, since `authorize()` stays single-item-
   shaped by design (see its own header) and calling it in a loop would
   silently reintroduce the N+1 this file exists to remove. Any future
   change to subject resolution must be made in both places.
2. Calls `engine.evaluate()` once per item, reusing that ONE resolved
   Subject/PolicyContext across every item, rather than re-resolving per
   item.
3. Every item's decision shares the SAME `PolicyContext` (and therefore
   the same `context.requestId`) — all N decisions answer one logical
   "what can this caller do, across this list" question as part of
   rendering ONE route response, so grouping them under one correlation id
   for audit (Phase 17) is deliberate, not an oversight.
4. Fails loud, before any engine call, if an item has no resolvable
   `action` (neither its own nor a batch-level default) — same
   "fail loud, don't silently misattribute" posture `requireOwnership()`
   already established in Phase 19 for its own construction-time input.
5. Never invents a new way to reach ALLOW/DENY/STEP_UP/APPROVAL_REQUIRED —
   every decision still comes from the caller's own `engine.evaluate()`.

`allowedKeys(outcome)` is a small, optional convenience over
`outcome.results` — `.filter(r => r.decision.effect === "ALLOW").map(r =>
r.key)` — covering the roadmap's own named use case (rendering only the
rows a viewer may act on) without every call site re-implementing that
one filter by hand. It is not a second way to reach ALLOW; it only reads
decisions `authorizeMany()` already produced.

Not implemented (deliberately, Rule 16): a genuinely vectorized
`PolicyEngine`/`PrecedenceEngine` evaluation method. The roadmap's own
Phase 20 wording asks only for `authorizeMany()` and "avoid N+1
authorization queries" — the queries in question are the PIP's DB-backed
provider reads, not the PDP's in-memory rule pass, so no engine-level
change was needed or made.

## Files added

| File | What it does |
|---|---|
| `lib/policy/pep/authorize-many.ts` | `authorizeMany()` (batched, single-subject-resolution authorization) and `allowedKeys()` (ALLOW-only key filter). |
| `scripts/src/test-policy-batch.ts` | DB-free test suite, 7 assertions. |

## Files changed

| File | Change |
|---|---|
| `lib/policy/pep/index.ts` | Added `export * from "./authorize-many"`; updated header comment to name Phase 20. |
| `lib/policy/index.ts` | Added a short comment above `export * from "./pep"` noting Phase 20's addition to that same barrel (no new export line needed — `./pep`'s own barrel already covers it). |

## Database changes

None. `authorizeMany()` makes zero direct DB calls itself; any DB
work happens exactly once per batch, inside whichever Phase 18 providers
the caller's `PolicyInformationPoint` was built with — same boundary
`authorize()` itself already draws.

## Tests

`npx tsx scripts/src/test-policy-batch.ts` — **7/7 passing.** Covers:

- One decision per item, returned in input order, for a mixed
  ALLOW/DENY rule.
- **The core claim of this phase**: with a counting `SubjectProvider` +
  `SessionProvider` wired through a real `PolicyInformationPoint`, a
  25-item batch calls `getSubject()` and `getSessionRecord()` exactly
  ONCE each — not 25 times.
- Every item's decision shares one `requestId`.
- A per-item `action` override alongside a batch-level default `action`.
- An item with no resolvable action throws before any `engine.evaluate()`
  call (verified via a call-counting engine wrapper).
- Unauthenticated `req.user` → `UNAUTHENTICATED` deny for every item,
  `subject: null`, never throws.
- `allowedKeys()` returns only ALLOW keys, preserving input order.

Regression check: re-ran `test-policy-pep.ts` (Phase 19, 19/19 passing),
`test-policy-pip-providers.ts` (Phase 18, 18/18 passing), and
`test-policy-explainability.ts` (Phase 15, 8/8 passing) after this
phase's barrel edits — all unaffected.

## Security tests

Covered inline within `test-policy-batch.ts`:

- Unauthenticated batches deny every item (`UNAUTHENTICATED`, not a
  silent skip or an accidental ALLOW-through) — fail-closed holds at
  batch scale, not just per-item.
- A batch item with no resolvable action is rejected at construction,
  before touching the engine — never silently evaluated against an
  empty-string or undefined action.

## Known limitations

- `authorizeMany()` is a plain async function, not a middleware — a
  caller folds its per-item results into its own response shape
  (filtering a list, annotating rows with a `canEdit` flag, etc.).
  `enforce()` (Phase 19) is not reused here since it has no generic way
  to render N results into one response.
- Still N calls into `engine.evaluate()` — only Subject/PolicyContext
  resolution is batched, not rule evaluation itself (see "Inspection
  first" above for why that was the actual N+1).
- Nothing in `routes/*.ts` calls `authorizeMany()` yet — same "engine, not
  endpoint" posture every phase before this one shipped with (Rule 16).

## Migration status

N/A — no schema changes.

## Regression status

No regressions found.

## Next phase

Audit gate after Phase 20 (per the roadmap's own "Audit Gates" section:
"Phase 20: Integration + Performance Audit"), then Phase 21 — Policy Test
Framework. Per Rule 16, neither is started in this session.
