# AYZEN Policy & Authorization Mega Engine — Phase 22C (Security / Abuse Testing — Context category)

## Scope

Roadmap Phase 22 section implemented for its **Context** sub-list only,
verbatim:

> "Context:
>  - spoofed organization
>  - spoofed role
>  - spoofed risk
>  - spoofed device
>  - spoofed assurance"

Phase 22 has five categories (Authentication, Authorization, Context,
Policy, Reliability). 22A covered Authorization, 22B Authentication. This
is 22B's own named next sub-phase. Policy and Reliability remain — see
"Deliberately not done here" below.

## Why this needed the Phase 18 PIP, not 22A's fixtures

22A already proved `authorize()` never reads `req.body`/`req.query` for
role/organizationId at the PEP boundary — but every 22A case built its
`Subject`/`PolicyContext` the Phase 1B way (`subjectFromAuthUser()` +
`policyContextFromRequest()`, no PIP), so it never touched a
`RiskProvider`/`DeviceProvider`/PIP-composed `organizationId` at all —
those fields are only ever populated when a caller supplies
`enrichment.pip` (a `PolicyInformationPoint`, Phase 18). This category's
whole point is that composition path: does a hostile request body/header
influence what a PIP *provider* reports, given the exact same `userId` a
legitimate provider would key its own DB lookup on. Every fake provider in
the new test file is written the way `drizzle-subject-provider.ts` /
`login-security-risk-provider.ts` / `drizzle-device-trust-provider.ts`
already are: keyed ONLY on `userId` (or `userId` + `ip`/`userAgent`, both
server-resolved — see `context-adapter.ts`), never on anything read off
`user` beyond `userId` itself, and never on `req.body`/`req.query`.

## Implementation

One new file, `scripts/src/test-policy-security-context.ts`. Nine cases
across the five named attack categories, each following the same shape:
send a `req.body`/`req.query`/extra-`req.user`-property claim that, if it
were ever consulted, would change the resulting decision, then assert the
decision is exactly what the AUTHENTIC provider data implies.

- **spoofed role** — a PIP-composed subject still carries only the
  authentic `req.user.role`; a forged `req.body.role` has no effect on the
  RBAC decision.
- **spoofed organization** — `organization-access` ALLOWs only against the
  provider's real membership (100), never a body-forged target
  organization (200), with a positive control confirming the real
  membership legitimately grants access to a resource actually in that
  org.
- **spoofed risk** — a HIGH-risk subject (per the provider's own signal)
  is still denied even when the body claims a low risk level, with a
  positive control for a genuinely LOW-risk subject.
- **spoofed device** — `context.deviceTrust` is always the provider's own
  signal; a body/header claiming "trusted" for a never-seen device has no
  effect, with a positive control for a genuinely seen-before device.
- **spoofed assurance** — the one category with no real provider AT ALL
  yet (`verification-level-adapter.ts`'s own header: populating
  `assuranceMethods` from account capability, rather than session usage,
  would be a real regression, deliberately still unbuilt). This case
  proves the NEGATIVE: a body claiming `assuranceMethods: ["passkey"]` has
  nowhere to be read from, so the subject still computes to the L1 floor
  and STEP_UPs against an L3 requirement.
- **composition** — a fully-doctored `req.user` object with four ad-hoc,
  non-`AuthenticatedUserLike` properties (`organizationId`, `riskLevel`,
  `deviceTrust`, `assuranceMethods`) bolted on is confirmed to have zero
  effect across every field at once — only `userId`/`role`/`authType`/
  `keyType`/`scopes` are ever read from `user` itself; everything else
  comes from provider composition or stays unset.

No production code changed — every case in this category was already
correct by construction (provider interfaces are keyed on `userId` alone;
nothing in `pip/context-adapter.ts`/`policy-information-point.ts` ever
reads a request body). This sub-phase is test-only, same as 22A.

## Tests

```
npx tsx scripts/src/test-policy-security-context.ts
```

**Executed live in this environment** (Node v22, via `tsx`/esbuild — no
`node_modules` install required since this file has no non-type-only
runtime dependency outside the repo's own `lib/policy` barrel). All nine
cases pass:

```
Policy Engine — Phase 22C (Security / Abuse Testing — Context) tests
  ok — spoofed role: ...
  ok — spoofed organization: ... (x2)
  ok — spoofed risk: ... (x2)
  ok — spoofed device: ... (x2)
  ok — spoofed assurance: ...
  ok — composition: ...

All Phase 22C Context abuse-testing checks passed.
```

## Security tests

This entire file *is* the security test suite for its category — nine
cases, see Implementation above.

## Known limitations

- **Spoofed assurance has no positive control** — because no provider
  populates `assuranceMethods`/`authenticationFreshnessSeconds` from real
  session usage yet (see `verification-level-adapter.ts`'s own header),
  there is no "genuinely high-assurance subject" case to contrast against
  the negative proven here. That positive control becomes possible once a
  real session-usage-backed assurance-methods provider ships — deliberately
  not built here (Rule 16/18: do not convert mock functionality into
  production functionality prematurely, and do not implement future
  phases prematurely).
- **`organizationId` composition uses a hypothetical fixture provider**
  (`FakeOrgSubjectProvider`), not the real `DrizzleSubjectProvider`, which
  does not populate `organizationId` today. The fixture pins down the
  CONTRACT any future real implementation must honor (keyed on `userId`
  alone); it does not itself prove the real Drizzle provider satisfies
  that contract, since that provider doesn't yet expose the field.

## Migration status

None — no schema changes, no new tables, no new routes.

## Regression status

Verified live: the full existing `scripts/src/test-policy-*.ts` suite
(everything not requiring `jsonwebtoken`/`@workspace/db`, i.e. everything
runnable in this sandbox) still passes after adding this file. This
sub-phase adds one new test file and touches no production code, so no
regression surface exists beyond "does the new file itself pass."

## Next phase

Phase 22D — **Policy** category (policy injection, invalid DSL,
conflicting rules, priority abuse, cache poisoning, stale authorization
cache). Per Rule 16, not started here.
