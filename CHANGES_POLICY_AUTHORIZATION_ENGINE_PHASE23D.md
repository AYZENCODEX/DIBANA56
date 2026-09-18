# AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy Console — Resources section)

## Scope

Admin Policy Console, Resources section: a write-capable admin surface over
the SAME `resource_grants` table Phase 03 (sub-phase 3B) already created
(Rule 2 — do not replace/duplicate existing data), covering create/list/
revoke of explicit (subject, resource, action) grant/deny entries, with its
own audit stream. The "Resources" counterpart to 23A/23B's Policies/Policy
Versions console and 23C's Roles/Permissions/Assignments console.

## Implemented

- `ResourceAdminRegistry` (`lib/policy/resource-admin/resource-admin-registry.ts`)
  — the one place that enforces WHO may call it (an injected
  `ResourceAdminAuthorizer`), the one storage-can't-enforce-alone business
  rule (a tuple may have at most one row, of either effect), assurance on
  the one sensitive mutation (creating an explicit `"allow"` grant), and
  writes an audit entry for every mutation. Reads
  (`listResourceGrants`/`listGrantsForSubject`/`listGrantsForResource`/
  `getResourceGrant`) are not actor-gated at this layer — same posture
  `RbacAdminRegistry`'s own reads take; the console/route layer in front
  decides who may reach them at all.
- `RbacResourceAdminAuthorizer` (`resource-admin/authorizer.ts`) — reuses
  Phase 02's `RbacProvider`/`resolveEffectivePermissions`/
  `permissionMatches` rather than a second permission-resolution path,
  gated on one flat permission, `admin.resource.manage` (no manage/assign
  split — a resource grant has no narrower capability to carve out; see
  that file's own header).
- `DrizzleResourceAdminProvider` (`resource-admin/drizzle-resource-admin-provider.ts`)
  — the real, `@workspace/db`-backed provider; the only file in this
  module that imports `@workspace/db`.
- `resourceAdminAuditLogTable` (appended to
  `lib/db/src/schema/resource-grants.ts`) + migration `105_ayzen_resource_admin_audit_log.sql`
  — a dedicated append-only audit stream for this surface, seeded with the
  `admin.resource.manage` permission-catalog entry and an explicit grant to
  the `admin` role.
- `lib/resource-admin-console.ts` — the route-facing service layer:
  actor resolution, the single-permission read gate, zod request
  validation, and error translation from the registry's typed errors into
  an HTTP-ready `ResourceAdminConsoleResult<T>`.
- `routes/admin-resource-console.ts` — `requireDev`-gated routes:
  `GET /admin/resource-grants`,
  `GET /admin/users/:userId/resource-grants`,
  `GET /admin/resources/:resourceType/:resourceId/grants`,
  `GET /admin/resource-grants/:userId/:resourceType/:resourceId/:action`,
  `POST /admin/resource-grants`,
  `DELETE /admin/resource-grants/:userId/:resourceType/:resourceId/:action`.
  Mounted in `routes/index.ts` next to `adminRbacConsoleRouter`.

## The allow/deny assurance asymmetry (unchanged from design, confirmed by tests)

- `effect: "allow"` is a privilege escalation (a subject acquires access to
  one specific resource instance they wouldn't otherwise have) — requires
  strong assurance on the acting admin's session.
- `effect: "deny"` only narrows what a subject may do — no assurance
  required.
- Revoking a row of EITHER effect is the safe/non-escalating direction —
  no assurance required either way.

## Files changed

- `lib/db/src/schema/resource-grants.ts` — added `resourceAdminAuditLogTable`,
  `insertResourceAdminAuditLogSchema` (additive only; `resourceGrantsTable`
  itself untouched).
- `artifacts/api-server/src/lib/policy/index.ts` — added the Phase 23D
  barrel re-export.

## Files added

- `migrations/105_ayzen_resource_admin_audit_log.sql`
- `artifacts/api-server/src/lib/policy/resource-admin/{types,errors,authorizer,resource-admin-registry,drizzle-resource-admin-provider,index}.ts`
- `artifacts/api-server/src/lib/resource-admin-console.ts`
- `artifacts/api-server/src/routes/admin-resource-console.ts`
- `scripts/src/test-resource-admin-registry.ts`

## A gap found and fixed during implementation

`ResourceAdminRegistry` had no public `getResourceGrant()` — only
`ResourceAdminProvider`/`DrizzleResourceAdminProvider` did; the registry
used the provider method internally only for its own duplicate-tuple check
inside `createResourceGrant()`. Both the console layer's single-entry
detail view and this phase's own test suite need a fully-specified-tuple
lookup that doesn't require pulling the entire list and filtering
client-side. Added a thin, non-actor-gated passthrough method to the
registry, alongside its three existing `list*` reads (same "not actor-gated
here" posture, same file). No behavior of the existing duplicate-check call
site changed — it still calls `this.provider.getResourceGrant(...)`
directly.

## Database changes

- Migration `105_ayzen_resource_admin_audit_log.sql` — creates
  `resource_admin_audit_log` (id, actor_id, action, subject_key, before
  JSONB, after JSONB, created_at), three indexes (subject_key, actor_id,
  action), a CHECK constraint on `action`, and seeds
  `admin.resource.manage` into `permissions` + an explicit grant to the
  `admin` role. Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING
  throughout). Not yet applied to any live database by this phase — ready
  to run in Supabase SQL Editor after 104.
- `resource_grants` (migration 097) is reused as-is — no schema change, no
  new writer path added to the PDP's own read-only
  `ResourceGrantProvider`.

## Tests

`scripts/src/test-resource-admin-registry.ts` — 12 cases, DB-free
(`FakeResourceAdminProvider` + the real `RbacResourceAdminAuthorizer`
wired to a `FakeRbacProvider`), run with `npx tsx
scripts/src/test-resource-admin-registry.ts`:

- `createResourceGrant`: deny succeeds without assurance; allow requires
  strong assurance (rejected without it, succeeds with it); duplicate
  tuple rejected regardless of the existing row's effect; denied without
  `admin.resource.manage`; writes exactly one audit row with the correct
  action/subjectKey/before/after shape.
- `revokeResourceGrant`: succeeds for either effect without assurance;
  unknown tuple rejected; denied without `admin.resource.manage`; writes
  exactly one audit row.
- Reads (`listResourceGrants`/`listGrantsForSubject`/
  `listGrantsForResource`/`getResourceGrant`) confirmed to ignore actor
  permissions at the registry level.
- `buildResourceAdminActor`: unions legacy role + real RBAC user-role
  grants; the actor it builds is usable end-to-end against
  `ResourceAdminRegistry`.

All 12 pass. Also re-ran the pre-existing `test-rbac-admin-registry.ts`,
`test-policy-registry.ts`, and `test-policy-rbac.ts` suites as a
regression check — all still pass unmodified.

## Security tests

Covered by the suite above: authorization-denial paths (missing
`admin.resource.manage`), the assurance-asymmetry gate on `"allow"`
specifically, and audit-trail integrity (exactly one row per mutation,
correct before/after snapshot) are all exercised directly, not just
inferred from reading the source.

## Known limitations

- No typecheck/build was run against the full workspace — the provided
  archive has no `node_modules`, and this environment has no network
  access to install workspace dependencies (`@workspace/db`, `zod`,
  `drizzle-orm`, `express` types, etc.). Verification instead used: (a)
  isolated per-file `tsc --noEmit` passes with dependency-resolution
  errors filtered out, catching one real bug (the missing
  `getResourceGrant()`, fixed above); (b) actually running the new test
  suite through `tsx` against the real module graph (imports genuinely
  resolved, not mocked) — 12/12 pass.
- One pre-existing, codebase-wide TS quirk surfaces under isolated
  `tsc --noEmit` on both `lib/resource-admin-console.ts` (this phase) and
  the already-checked-in `lib/rbac-admin-console.ts` (Phase 23C, three
  call sites) identically: `return { ok: true };` typed as
  `ResourceAdminConsoleResult<Record<string, never>>` (used for 204
  no-body responses) reports `Property 'ok' is incompatible with index
  signature`. Since this is not something introduced by this phase and
  the exact same pattern already ships unmodified in 23C, it was left
  as-is rather than unilaterally changed; worth a look under the real
  project tsconfig/TS version during the next full build.
- `resourceId` in the new routes' path params is matched as a single URL
  segment (documented in `admin-resource-console.ts`'s own header) — same
  convention every other `:id`-style param in this codebase already takes;
  a resource id containing a literal `/` would need percent-encoding by
  the caller.
- No CHANGES docs exist in this codebase for 23A/23B/23C (highest
  pre-existing doc was Phase 22E) even though the code and route-mounting
  comments reference those sub-phases by name. This doc was added for 23D
  only, matching the convention going forward; 23A–23C were not
  retroactively backfilled since that wasn't part of this phase's own
  scope.

## Migration status

Not yet run against any live database. `105_ayzen_resource_admin_audit_log.sql`
is idempotent and ready to run in Supabase SQL Editor after 104, per this
repo's existing migration convention.

## Regression status

No existing behavior changed. `resource_grants`'s own schema, the PDP's
read-only `ResourceGrantProvider`/`explicit-grant-rule.ts` path, and every
other admin console (Policies/Policy Versions, Roles/Permissions/
Assignments) are untouched. Re-ran their test suites as a spot check — all
still pass.

## Next phase

Phase 24 — Observability (authorization_requests_total,
authorization_allow/deny/step_up/approval_total, authorization_latency,
authorization_policy_errors, authorization_cache_hit_rate; dashboards for
authorization health, denial spikes, policy errors, latency, unusual
access patterns, high-risk decisions; integrate with existing AYZEN
observability). Not started — per the roadmap's own workflow, stopping
here for review before beginning it.
