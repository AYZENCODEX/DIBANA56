# AYZEN Policy & Authorization Mega Engine — Phase 22A (Security / Abuse Testing — Authorization category)

## Scope

Roadmap Phase 22 section implemented for its **Authorization** sub-list
only, verbatim:

> "Authorization:
>  - IDOR
>  - privilege escalation
>  - role tampering
>  - permission injection
>  - cross-tenant access
>  - resource-ID substitution
>
>  Authorization failures must fail closed."

Phase 22 has five categories (Authentication, Authorization, Context,
Policy, Reliability). This sub-phase covers one. See "Deliberately not
done here" below for why the other four are real, separate follow-ups,
not an oversight.

## Why Authorization first, and why through the PEP, not the bare engine

Every `test-policy-declarative-*.ts` (Phase 21B) suite calls
`engine.evaluate()` directly — correct for testing one rule's own logic
in isolation, but an abuse test's actual question is "can a hostile
CLIENT influence the decision", which is a question about the boundary
an attacker actually touches: the Express `Request`. So this phase's one
new file, `scripts/src/test-policy-security-authorization.ts`, goes
through `authorize()` (Phase 19's PEP entry point) with a fake `Request`
carrying attacker-controlled `body`/`query` fields, the same
`as unknown as Request` pattern `test-policy-pep.ts` already establishes.

Authorization was the category to do first specifically because it needs
no new infrastructure beyond what Phase 21B just finished building
(the same five rule fakes) plus the already-shipped `authorize()` — the
other four categories each need something this codebase hasn't built a
test harness for yet (see below).

## Implementation

One `PolicyEngine` with five real rules registered — RBAC +
resource-ownership + ReBAC + organization-access + explicit resource
grant, the same "vault-access"-shaped composition
`test-policy-test-framework.ts`'s own worked example already
establishes — because an attacker does not care which specific
registered rule they might slip through; a single-rule engine could not
exercise "does ANY path leak" the way this composition can.

Thirteen cases, two per named attack category (plus one composition
check), each confirming BOTH the resulting `effect` AND, for role/org
attacks, that the concrete field an attacker would try to spoof
(`req.body.role`, `req.body.organizationId`, `req.user.permissions`,
`req.body.permissions`, an `X-Role` header) has zero effect on the
decision — because `authorize()`/`policyContextFromRequest()` only ever
read `req.user`, `req.headers["x-request-id"]`, and `req.ip`, never
`req.body`/`req.query`/any other header. This is a structural guarantee
already true of the Phase 19 code, not something this phase changed —
these tests exist to make that guarantee an explicit, checked fact
instead of something only apparent from reading `authorize.ts`'s own
header comment.

- **IDOR** — a real, authenticated subject requesting a resource they
  have no relationship to at all (not the owner, no role grant, no
  ReBAC relation, no org match, no explicit grant) is denied.
- **privilege escalation** — a subject holding only a read permission
  cannot perform a stronger action nothing grants; separately, forging
  `req.body.action` never changes which action is actually evaluated
  (the route handler's own call to `authorize({ action, ... })` is
  authoritative, never anything read back off the request).
- **role tampering** — `req.body.role`/`req.query.role`/an `X-Role`
  header are all inert; the `Subject.role` `authorize()` actually built
  still reflects the authentic `req.user.role`.
- **permission injection** — neither `req.user.permissions` (not a real
  field of `AuthenticatedUserLike` at all) nor `req.body.permissions`/
  `req.body.grants` are ever consulted by any registered rule.
- **cross-tenant access** — a same-action, different-organization
  request is denied by `organization-access`'s own abstain-on-mismatch;
  forging `req.body.organizationId` to match the target has no effect.
- **resource-ID substitution** — an explicit grant for resource `"42"`
  does not cover `"43"` or a lookalike `"42x"`, exact-match only; a
  positive control (the real `"42"` request) confirms the fixture itself
  is correct, not merely that IDs never match anything.
- **composition** — an entirely unauthenticated request (`req.user` is
  `null`) is denied with `UNAUTHENTICATED` before any registered rule
  even runs, regardless of a `req.body`/`req.query` that tries to smuggle
  in a fake identity.

## Tests

```
npx tsx scripts/src/test-policy-security-authorization.ts
```

All thirteen checks pass. Also re-ran the full Phase 21B declarative
suite set, `test-policy-test-framework.ts` (21A), and `test-policy-pep.ts`
(19) together to confirm this phase introduced no regression in the
shared `lib/policy` barrel or fixtures.

## Deliberately not done here (later Phase 22 sub-phases)

- **Authentication** (unsigned token, malformed token, expired token,
  token substitution, stale session) — needs the real `lib/jwt.ts`
  verification code and `middlewares/auth.ts` exercised adversarially,
  not a fake `req.user`. This entire phase's fixture set assumes
  `req.user` is already authentic — exactly the assumption the
  Authentication category exists to stress-test from the other side.
  This is the natural next sub-phase (22B).
- **Context** (spoofed organization, spoofed role, spoofed risk, spoofed
  device, spoofed assurance) — this phase's role/org cases already cover
  the PEP-boundary slice of "spoofed role"/"spoofed organization", but
  the roadmap's own framing is about a Phase 18 `PolicyInformationPoint`'s
  enrichment inputs specifically (session/device/risk providers feeding
  `enrichment.pip`), which needs its own fixture set with a fake PIP,
  not covered here.
- **Policy** (policy injection, invalid DSL, conflicting rules, priority
  abuse, cache poisoning, stale authorization cache) — needs the Phase 06
  DSL compiler and Phase 07 registry/PAP layer exercised adversarially
  (malformed DSL strings, two policies deliberately set to conflict,
  registry cache invalidation timing) — a distinct suite, and the same
  DSL/registry code path Phase 21B's own "deliberately not done" section
  already flagged as needing its own declarative coverage first.
- **Reliability** (database failure, policy failure, provider timeout,
  cache failure, partial context failure) — needs providers that fail
  on demand (a throwing fake, not the always-succeeding fakes every
  suite in this codebase uses today) to confirm `policy-engine.ts`'s
  `POLICY_EVALUATION_ERROR` fail-closed path actually fires and wins,
  under every failure mode named — a new fixture pattern, not a reuse of
  existing fakes.
