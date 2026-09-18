# AYZEN Policy & Authorization Mega Engine — Phase 22B (Security / Abuse Testing — Authentication category)

## Scope

Roadmap Phase 22 section implemented for its **Authentication** sub-list
only, verbatim:

> "Authentication:
>  - unsigned token
>  - malformed token
>  - expired token
>  - token substitution
>  - stale session"

This is 22A's own named "natural next sub-phase." Phase 22 has five
categories (Authentication, Authorization, Context, Policy, Reliability);
22A covered Authorization, this covers Authentication. Context, Policy,
and Reliability remain — see "Deliberately not done here" below.

## Why this needed the real jwt.ts / auth-utils.ts, not a fake req.user

22A's whole fixture set — by its own design — assumes `req.user` is already
authentic; every case there hands `authorize()` a fake `Request` with a
hand-set `user` field and asks whether a hostile client can influence the
DECISION given an authentic subject. Authentication is the layer underneath
that assumption: can a hostile client forge, corrupt, or resurrect the
subject itself. Answering that means calling the real verification code
(`verifyAuthToken()` in `lib/jwt.ts`) with hand-built or hand-tampered
token strings, not a fake `req.user` object.

## Implementation

One new file, `scripts/src/test-policy-security-authentication.ts`.
Twelve cases across the five named attack categories, plus one fixture-
sanity positive control (same "confirm the harness isn't just always
returning null" discipline 22A used for its resource-ID-substitution
positive control).

- **unsigned token** — an `alg:"none"` token with an empty signature
  segment, and the pre-JWT legacy base64(JSON) format, are both rejected
  by `verifyAuthToken()`; the legacy format is also confirmed rejected by
  `getUserFromToken()` when `ALLOW_LEGACY_AUTH_TOKENS` is unset (the
  default) — checked without ever reaching the database, since that path
  returns `null` before any DB lookup happens.
- **malformed token** — plain garbage, dot-shaped-but-non-base64 garbage,
  a truncated signature segment, and payload tampering (role escalation,
  userId substitution) on an otherwise-real signed token are all rejected.
  Every tampering case reuses one `tamperPayload()` helper that keeps the
  real header and signature untouched and only recomputes the payload
  segment — isolating the assertion to "does a modified claim without a
  matching signature verify", the same mechanism in every case.
- **expired token** — a token signed with a negative expiry is rejected;
  separately, forging the `exp` claim forward on an expired token without
  re-signing does not resurrect it (same signature-mismatch mechanism as
  the malformed-token cases, checked explicitly for `exp` since it's the
  claim an attacker most directly wants to move).
- **token substitution** — four angles: (1) swapping the `sid` claim to
  target someone else's session id without re-signing; (2) kid confusion —
  an attacker's own RSA keypair signs a token carrying the SERVER's real
  `kid`, which `resolveVerificationKeys()` resolves to the real server
  public key only, so the attacker's signature fails against it; (3) a
  fabricated, unregistered `kid` resolves to zero candidates and is never
  retried against the real active key (the deterministic no-fallback
  lookup `jwt-keys.ts` documents); (4) the classic RS256→HS256
  algorithm-confusion attack (signing with the server's own PUBLIC key
  used as an HMAC secret, claiming HS256) is rejected because
  `ALLOW_LEGACY_HS256_TOKENS` is off by default — the only path that ever
  attempts an HS256 check at all.
- **stale session** — DB-dependent, so split the same way
  `test-oidc-logout-session-integration.ts` (OIDC roadmap, Phase 6c-d)
  already established for this exact situation: the DB-free half is
  checked by reading the real source of `lib/auth-utils.ts` and
  `lib/sessions.ts` and asserting on it (same technique that file uses,
  not a mocked pool) — confirming `getUserFromToken()` actually calls
  `isSessionRevoked(ownToken.sid)` and returns `null` immediately when it
  reports true, that `isSessionRevoked()` treats both explicit revocation
  AND lapsed expiry as stale, and that a `sid`-less legacy token is
  deliberately exempt from this check (documented, pre-existing behavior,
  not something this phase is newly asserting is fine). The genuinely
  DB-dependent half — does revoking a session mid-life actually stop a
  still-cryptographically-valid token from authenticating — is recorded
  as an explicit manual verification step in the test's own console
  output, not faked with a mocked pool, so this file never gives a false
  "pass" for behavior it didn't actually exercise.

No production code was changed. Like 22A, this phase is test-only.

## Runtime requirements (pre-existing, not introduced by this phase)

Needs `DATABASE_URL` set to *any* value, even an unreachable host —
`lib/jwt-keys.ts` and `lib/auth-utils.ts` both import `@workspace/db` at
module load time, and that module throws immediately if `DATABASE_URL` is
unset at all. `test-resolve-verification-keys.ts` (Phase 1D-b) already
documents this same pre-existing constraint.

A REAL reachable Postgres is **not** required for cases 1-4: `getVerificationKeys()`
wraps its `jwt_signing_keys` read in try/catch and falls back to the
single env-resolved active keypair on any DB error, and a refused/
unreachable connection is exactly such an error. Case 5 is static-source-
verification-only, as described above, plus a documented manual step.

## Tests

```
npx tsx scripts/src/test-policy-security-authentication.ts
```

**Not executed in this environment.** This sandbox has no network access
and no installed `node_modules` (the workspace uses pnpm; `pnpm install`
needs network), so `tsx`/`typescript`/`jsonwebtoken` etc. aren't available
to actually run here. Every case above was instead traced by hand against
the real, current source of `lib/jwt.ts`, `lib/jwt-keys.ts`, and
`lib/auth-utils.ts` (all read from the uploaded codebase, not from
memory) to confirm the exact code path each assertion exercises and the
exact outcome it should produce — the same level of rigor 22A's own
`policyContextFromRequest()`/`authorize()` claims were checked against,
just without a runtime to confirm it live. Please run the command above
(with `DATABASE_URL` set per the note above) in your own environment and
report back if any case doesn't match this analysis — that would indicate
either a divergence between the uploaded codebase and what's actually
deployed, or an error in this phase's own reasoning, and either way is
worth catching before Phase 22C.

Also worth re-running alongside this file: `test-policy-security-
authorization.ts` (22A) and the Phase 21B declarative suites, to confirm
this phase introduced no regression — it shouldn't have, since it adds
one new file and touches no shared module, but that claim is unverified
in this environment for the same reason above.

## Security tests

This entire file *is* the security test suite for its category — see
Implementation above for the twelve cases.

## Known limitations

- **Not executed live** — see "Tests" above. This is the main limitation
  of this delivery and should be resolved before treating 22B as closed.
- **RS256→HS256 alg-confusion case only proves the default-off path.**
  `ALLOW_LEGACY_HS256_TOKENS` is read into a module-level `const` at
  import time in `jwt-keys.ts`, so a single test process can't toggle it
  mid-run to also exercise "what if legacy HS256 were on and the attacker
  still can't forge a token" — that would need a second process invoked
  with the env var set. The test's own comment notes *why* it would still
  fail even then (`getLegacyHs256Secret()` reads a server-configured
  secret, never RSA public key material), but that specific claim is
  documented, not independently executed.
- **Stale session case 5 is not exercised live at all** — by design, per
  the DB-dependency split explained above, matching this codebase's own
  established precedent rather than introducing a mocked pool. The
  manual verification steps printed by the test itself are the closest
  this phase gets to confirming the DB-dependent half.
- **Fabricated-kid case's exact behavior depends on process cache state**
  (pre- vs post- `loadVerificationKeyCache()`) — both states were traced
  by hand and both reject the fabricated kid (see `jwt-keys.ts`'s own
  `resolveVerificationKeys()` doc comment), but only one of those two
  states is actually reached in any single run of the test, depending on
  whether an earlier case already triggered a cache load.

## Migration status

None — no schema changes, no new tables, no new routes. Test-only phase.

## Regression status

Not verified live in this environment (see Known limitations). By
inspection: the new file imports only `lib/jwt.ts`, `lib/jwt-keys.ts`,
and `lib/auth-utils.ts`, all read-only (no writes to shared fixtures,
caches, or module state that would outlive the process), so it should not
affect any other suite's behavior when run separately or in sequence.

## Next phase

Phase 22C — **Context** category (spoofed organization, spoofed role,
spoofed risk, spoofed device, spoofed assurance), per the roadmap's own
Phase 18 framing: a `PolicyInformationPoint`'s enrichment inputs
specifically (session/device/risk providers feeding `enrichment.pip`),
which needs its own fixture set with a fake, adversarial PIP — not
reachable from either 22A's or 22B's existing fixtures. Per Rule 16, not
started here.
