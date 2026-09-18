# AYZEN Policy & Authorization Mega Engine — Phase 19 (PEP / Express SDK)

## Scope

Roadmap Phase 19 section implemented, verbatim: "Create thin enforcement
helpers: `authorize()`, `requirePolicy()`, `requirePermission()`,
`requireOwnership()`, `requireRole()`, `requireStepUp()`,
`requireApproval()`. Expected flow: route → authentication → authorization
middleware → business service. PEP enforces. PDP decides."

`authorize.ts`, `middleware.ts`, `pep/types.ts`, and `pep/index.ts` were
already drafted going into this session. Inspection found the one missing
piece: `enforce.ts` — imported by both `middleware.ts` and `pep/index.ts`,
but not present anywhere in the codebase or the upload set. Nothing in
this directory could actually run without it (every `requirePolicy()`-built
middleware calls it as its last step). This phase's real work was writing
that file and wiring the directory into the top-level `lib/policy` barrel,
then verifying the whole PEP surface against the pre-written
`scripts/src/test-policy-pep.ts` suite.

## Files added

| File | What it does |
|---|---|
| `lib/policy/pep/enforce.ts` | Renders an `AuthorizeOutcome` onto an Express `res`, or calls `next()` for ALLOW. Stamps `req.authorization` for every outcome, before any response is sent. Picks 401 vs 403 from `decision.effect`/`decision.reason` (UNAUTHENTICATED and STEP_UP → 401; every other DENY and APPROVAL_REQUIRED → 403). Resolves `includeDetail` (boolean or per-request predicate) once and renders Phase 15's `explainAuthorizationDecision()` detail behind it. `onDeny`/`onStepUp`/`onApprovalRequired` fully replace the default response when supplied. |
| `scripts/src/test-policy-pep.ts` | Copied in from the provided upload set (already fully written) — DB-free, fake-Request/Response, fake RBAC/Approval providers, 19 assertions covering every helper. |

## Files changed

| File | Change |
|---|---|
| `lib/policy/index.ts` | Replaced with the provided Phase 19 top-level barrel (adds `export * from "./pep"`; every Phase 01-18 export preserved verbatim). |

## Files placed (already written, not modified — from the provided upload set)

- `lib/policy/pep/authorize.ts`
- `lib/policy/pep/middleware.ts`
- `lib/policy/pep/types.ts`
- `lib/policy/pep/index.ts` (later re-edited in Phase 20, below)

## Database changes

None. This phase adds zero schema, zero new tables, zero migrations —
consistent with the roadmap's own framing of Phase 19 as
Express-request-shaping + in-memory rule composition over Phase 02-18's
already-existing rule factories and PIP adapters.

## Tests

`npx tsx scripts/src/test-policy-pep.ts` — **19/19 passing.** Covers:

- `authorize()`: unauthenticated → UNAUTHENTICATED deny; authenticated +
  zero rules → NO_MATCHING_POLICY deny (default-deny, Rule 7); ALLOW rule →
  ALLOW with `request` recovered for `explain()`.
- `requirePolicy()`: ALLOW → `next()`, `req.authorization` stamped;
  unauthenticated → 401, `next()` never called; DENY → 403 with the
  generic `userMessage`, no `detail` by default; `includeDetail: true`
  attaches Phase 15 admin detail; `includeDetail` as a per-request
  predicate is actually invoked with `req`; `onDeny` fully replaces the
  default response.
- `requirePermission()`: throws at construction on a malformed
  `product.resource.action` key; grants/denies via a real RBAC role
  permission.
- `requireOwnership()`: owner allowed, non-owner denied; a resource
  builder that omits `ownerId` → `next(err)`, never a silent deny.
- `requireRole()`: membership allowed; mismatch denied with
  `EXPLICIT_DENY` (not `NO_MATCHING_POLICY`).
- `requireStepUp()`: assurance already met → ALLOW via the companion
  pass-through rule; assurance unmet → 401 `STEP_UP_REQUIRED` with
  `requiredAssurance`; `onStepUp` fully replaces the default response.
- `requireApproval()`: a live `APPROVED` request → ALLOW; none on file →
  403 `APPROVAL_REQUIRED`; an approval on file for a *different* resource
  id never grants (no cross-resource leak).

Regression check: re-ran `test-policy-pip-providers.ts` (Phase 18, 18/18
passing) and `test-policy-explainability.ts` (Phase 15, 8/8 passing) after
the top-level barrel change — both unaffected.

## Security tests

Covered inline within `test-policy-pep.ts` (this engine's established
pattern of folding security-relevant boundary cases into the phase's own
suite rather than a separate file at this stage — see Phase 22's own,
later, dedicated abuse-testing phase):

- Fail-closed default: DENY renders no policy internals (`detail:
  undefined`) unless `includeDetail` is explicitly true.
- `requireOwnership()` never silently denies on a wiring bug (missing
  `ownerId`) — it surfaces a distinct construction-shaped error via
  `next(err)` instead, so a broken resource builder can't be
  indistinguishable from "really isn't the owner."
- `requireApproval()`'s exact-match-only lookup: an approval for resource
  id `"77"` does not authorize action against resource id `"78"`.
- `requirePermission()` fails loud at construction (throws) on a
  malformed permission key, rather than silently never matching at
  request time.

## Known limitations

- Nothing in `routes/*.ts` calls any PEP helper yet — same "engine, not
  endpoint" posture every phase before this one shipped with (Rule 16).
  Wiring these into real routes is explicitly a later, separate step.
- `enforce()`'s default response bodies are a fixed shape
  (`{ error, code, solution, detail? }`, plus `requiredAssurance` for
  STEP_UP). A caller wanting a different shape uses
  `onDeny`/`onStepUp`/`onApprovalRequired` — there is no per-route body
  customization short of an override.

## Migration status

N/A — no schema changes.

## Regression status

No regressions found. Phase 15 and Phase 18 suites re-verified passing
after this phase's one top-level barrel edit.

## Next phase

Phase 20 — Batch Authorization (`authorizeMany()`) — implemented in this
same session; see `CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE20.md`.
