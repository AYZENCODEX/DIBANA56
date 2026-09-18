# AYZEN Policy & Authorization Mega Engine — Phase 22D (Security / Abuse Testing — Policy category)

## Scope

Roadmap Phase 22 section implemented for its **Policy** sub-list only,
verbatim:

> "Policy:
>  - policy injection
>  - invalid DSL
>  - conflicting rules
>  - priority abuse
>  - cache poisoning
>  - stale authorization cache"

Phase 22 has five categories (Authentication, Authorization, Context,
Policy, Reliability). 22A covered Authorization, 22B Authentication, 22C
Context. This is 22C's own named next sub-phase. Reliability remains —
see "Deliberately not done here" below.

## Why this needed the real Phase 06 DSL + Phase 07 registry

Every prior 22-series file assumed a fixed, already-registered rule set
and asked "can a hostile CLIENT REQUEST influence the decision". This
category is different: it asks "can hostile POLICY CONTENT itself (DSL
text an admin — possibly a compromised or malicious one — submits) either
execute something it shouldn't, or produce an ambiguous/non-deterministic
decision". That requires the real `parseAbacDsl()`/`compileAbacPolicy()`
(`../abac/dsl`) and the real `PolicyRegistry` (`../registry/policy-registry.ts`)
— no fake stands in for either, since the whole question is about what
THEIR code actually does with adversarial text, not about a client-request
boundary a fake could abstract away.

## Cache poisoning / stale authorization cache: no cache exists yet

A repo-wide search of `lib/policy/*` turns up no caching layer at all — no
memoized rule-set, no decision cache, no TTL anywhere in this directory
(the roadmap's own PERFORMANCE RULES section: "Introduce caching only
after correctness" — correctness-only is exactly where this engine still
is). Building a fake cache here to "test" would be inventing
infrastructure this codebase doesn't have (Rule 18), and a test of
imaginary infrastructure proves nothing about the real one. What IS real
and testable: whether anything in the registry→PDP path introduces
ACCIDENTAL staleness even without an explicit cache (a lingering
reference, a snapshot taken too early). The two "cache" cases test exactly
that, against the real `PolicyRegistry`/`createRegistryPolicyRules()`.

## Implementation

One new file, `scripts/src/test-policy-security-policy.ts`. Nine cases:

- **policy injection** — five JS-injection-shaped DSL payloads (statement
  chaining, template-literal env-var interpolation, prototype pollution,
  string-boundary escape, `require()`-based code execution) are all
  rejected by `parseAbacDsl()` with a `DslError`, never partially parsed;
  a compiled condition round-trips through `JSON.stringify`/`JSON.parse`
  byte-for-byte, confirming it is plain data with no embedded closure or
  function; and `PolicyRegistry.createPolicy()` rejects an
  injection-shaped payload with `InvalidPolicyContentError` BEFORE ever
  calling `provider.insertVersion()` — confirmed via a zero-length
  `provider.rows` array, not just the thrown error.
- **invalid DSL** — eight structurally malformed expressions (empty
  string, unclosed parens, unterminated string, unrecognized root
  namespace, missing operator between clauses, over-length input past
  `MAX_INPUT_LENGTH`, over-token input past `MAX_TOKENS`) are all rejected
  with `DslError`, never silently accepted as "no condition"; a batch
  containing one bad expression alongside a good one fails outright rather
  than partially compiling the good half.
- **conflicting rules** — an ALLOW-authored registry policy and a
  DENY-authored one covering the identical action, driven all the way to
  ACTIVE through the real maker-checker `PolicyRegistry` lifecycle, are
  registered in BOTH orders; both orders resolve to DENY
  (deny-overrides), confirming registration order cannot flip the
  outcome.
- **priority abuse** — an attacker-authored ALLOW policy created with an
  extreme `priority: 999999` and registered FIRST (the most favorable
  order for it) still cannot override a legitimate, low-priority DENY
  policy on the same action — because `createRegistryPolicyRules()` never
  reads the `priority` field at all; only caller-supplied array order and
  `PolicyEngine`'s deny-overrides combining matter.
- **cache / staleness** — disabling an ACTIVE policy is reflected
  immediately on the very next `listActivePolicies()`/
  `createRegistryPolicyRules()` call, with no stale read; and
  `PolicyEngine.evaluate()` never memoizes by `(action, resource)` alone —
  two requests sharing identical action+resource but differing
  `subject.role` each get an independently correct decision, not one
  incorrectly reused for the other.

No production code changed — every case in this category was already
correct by construction (`parseAbacDsl()`/`compileAbacPolicy()` already
reject non-grammar input via a hand-rolled tokenizer/parser with no
`eval()`-equivalent anywhere per Rule 6; `PolicyRegistry` already validates
before writing; `PolicyEngine` already combines by strict deny-overrides
with no priority field or memoization anywhere). This sub-phase is
test-only, same as 22A and 22C.

## Tests

```
npx tsx scripts/src/test-policy-security-policy.ts
```

**Executed live in this environment** (Node v22, via `tsx`/esbuild — no
`node_modules` install required; this file has no runtime dependency
outside the repo's own `lib/policy` barrel). All nine cases pass:

```
Policy Engine — Phase 22D (Security / Abuse Testing — Policy) tests
  ok — policy injection: ... (x3)
  ok — invalid DSL: ... (x2)
  ok — conflicting rules: ...
  ok — priority abuse: ...
  ok — no stale authorization cache: ...
  ok — no decision cache: ...

All Phase 22D Policy abuse-testing checks passed.
```

## Security tests

This entire file *is* the security test suite for its category — nine
cases, see Implementation above.

## Known limitations

- **No real cache to poison** — as documented above, this codebase has no
  caching layer in `lib/policy/*` at all today, so "cache poisoning" and
  "stale authorization cache" are demonstrated here as an absence
  (no accidental staleness in the registry→PDP path) rather than as an
  attack against a real cache. If caching is introduced in a later phase
  (per the roadmap's own PERFORMANCE RULES — "introduce caching only after
  correctness"), this category's fixtures should be revisited against the
  real cache implementation.
- **Priority field has no enforced ceiling** — `NewPolicyInput.priority`
  accepted `999999` verbatim with no validation error. This is not a
  fail-open gap (the attacker's ALLOW still loses to the legitimate DENY
  either way, confirmed above), but is worth noting as a possible future
  input-validation hardening item, not a Phase 22 fix (Rule 16).

## Migration status

None — no schema changes, no new tables, no new routes.

## Regression status

Verified live: the full existing `scripts/src/test-policy-*.ts` suite
(everything not requiring `jsonwebtoken`/`@workspace/db`) still passes
after adding this file. This sub-phase adds one new test file and touches
no production code, so no regression surface exists beyond "does the new
file itself pass."

## Next phase

Phase 22E — **Reliability** category (database failure, policy failure,
provider timeout, cache failure, partial context failure) — the last
Phase 22 category. Per Rule 16, not started here.
