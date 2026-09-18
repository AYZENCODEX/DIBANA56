# Route Integration Roadmap — Season E, Phase E3: `projects.ts` `vaultEntryId` group, audit-only → enforcing

> Written retroactively — the code for this phase was already applied on top
> of E2's `finance.ts` state, but no `CHANGES_*` doc had been produced yet.
> This doc reconstructs the change from the diff against the pre-E3 file
> (same D7 audit-only baseline E1/E2 started from) and the in-file comments
> the change itself left behind, per `ROADMAP_ROUTE_INTEGRATION_PHASE_E1_E7.md`'s
> own E3 scope.

## Scope
`ROADMAP_ROUTE_INTEGRATION_PHASE_E1_E7.md`'s E3 — `projects.ts`'s D7
audit-only block (`auditProjectsOwnership()`, `vaultEntryAuditEngine`,
`vaultEntryOwnerResource`) promoted to a real, blocking `requireOwnership()`
gate, same shape E1/E2 already used in `finance.ts`.

## Re-triage first, per the roadmap's own instruction
E3's roadmap entry explicitly called for re-confirming D3/D7's own
bucket-breakdown before touching code, since the numbers could have drifted.
They hadn't: of this file's `:id`-shaped routes, exactly **two** have a
client-supplied entity id whose real owner could genuinely differ from the
caller — both already flagged by D7 and both keyed off the same
`vaultEntryId` (read from either `req.params.vaultEntryId` or
`req.body.vaultEntryId`; `vaultEntryOwnerResource` already handled both
shapes). This is smaller than the roadmap's own "~7" estimate — that number
came from D8's file-by-file table without a fresh per-route check, and the
roadmap itself flagged its own bucket counts as "preliminary, not final
truth". The other 14 previously-flagged-unwired routes in this file confirm
unchanged: 3 public (no auth at all), 11 self-scoped-by-construction
(composite `(userId, projectId)` key, or a project id that isn't an owned
resource at all) — same D6/D3 precedent this file's own header already
documents. None of those 14 get a gate.

**No SQL/behavior changed** — both routes' pre-existing
`user_id = ${userId}`-scoped queries are untouched. What changed: the
ownership decision for `vaultEntryId` now blocks at router-level middleware
instead of being computed and discarded inside the handler.

## The two promoted routes

| Route | action | Pre-existing deny (now `onDeny`) |
|---|---|---|
| `GET /projects/entity/:vaultEntryId/overview` | `project.entity_overview.read` | Silent no-op — a non-owned/nonexistent `vaultEntryId` already replied `200` with an empty/null-shaped body (queries were already `user_id`-scoped, so a mismatch just returned no rows, never a 404) |
| `POST /projects/:id/enroll` (the `vaultEntryId` half only) | `project.enroll` | `404 { error: "Vault entity not found" }` |

`requireProjectsVaultEntryOwnership(action, onDeny)` was added next to
`vaultEntryOwnerResource`'s declaration — same parametrized-`onDeny` shape
E2 introduced for `finance.ts`'s mixed-deny-body groups, needed here because
the two routes' pre-existing deny bodies differ (one silent no-op, one 404).

For the overview route, the silent-no-op `onDeny` (`projectEntityOverviewSilentDeny`)
reproduces the exact pre-existing empty-shaped body — parses `vaultEntryId`
from the params the same way the handler always did, and returns the same
`{ entity: null, vaultEntryId, projects: [], activity: [], summary: {...all zero...} }`
shape, per `OWNERSHIP_GATING_GUIDE.md`'s "silent no-op" deny case (same
precedent E2 used for `finance.ts`'s goal/recurring/budget/report-schedule
deletes).

## What stayed audit-only — `kycEntryId`
`POST /projects/:id/enroll`'s OTHER id, `kycEntryId`, stays exactly as D7
left it: an inline, conditional `auditProjectsOwnership()` call. It's read
from an optional body field and only relevant inside an
`if (kycEntryId) { ... }` branch that already runs its own
existence+ownership `SELECT` first — a router-level `requireOwnership()`
gate runs unconditionally for every request and has no way to skip itself
when the field is absent, so this half cannot be promoted the same way
without changing behavior for requests that never send a `kycEntryId`. This
mirrors E1's own reasoning for why `finance.ts`'s truly-conditional checks
stayed inline.

## Dead-code note
`auditProjectsOwnership()`, `vaultEntryAuditEngine`, and
`vaultEntryOwnerResource`'s audit-only call site were NOT removed — unlike
`finance.ts`'s `auditFinanceOwnership()` at the end of E2, this file's
`auditProjectsOwnership()` helper still has a live caller (the `kycEntryId`
half above), so it is not dead code yet. Same "don't remove a caller-having
construct" rule E1/E2 already followed in the other direction (they DID
remove `auditFinanceOwnership()` once every caller migrated). This helper's
removal is deferred to E7's close-out, contingent on whatever E4-E6 do to
its other potential callers, per the roadmap's own E7 scope.

## Verification
`tsx scripts/src/check-ownership-gate-coverage.ts` (globally-installed
`typescript`/`tsx`, temporary local `node_modules/typescript` symlink,
same setup D8/E1/E2 used — no repo file changed by the check itself),
run against this doc's own baseline update below:

```
Scanned 138 route files, 487 param routes total, 101 unwired,
20 public/token-audit-only (Phase F1, not counted as a gap).

OK — no new unwired param routes (101 pre-existing gap(s) in baseline, unchanged).
```

`--update-baseline`-equivalent applied by hand alongside this doc (see
below): the two promoted routes
(`projects.ts:GET /projects/entity/:vaultEntryId/overview`,
`projects.ts:POST /projects/:id/enroll`) removed from
`ownership-gate-baseline.json`, bundled with E2's own removals since neither
had been applied to the baseline file yet when this doc was written.

**Real `tsc --noEmit` still not run** — same D6-D8/E1/E2 sandbox limitation
(`@workspace/db`/`express`/`drizzle-orm` have no installed `node_modules`
here). Run `pnpm --filter @workspace/api-server typecheck` in the real
toolchain before merge.

## Result
| Item | Count |
|---|---|
| Promoted routes (audit-only → enforcing) | 2 (`GET /projects/entity/:vaultEntryId/overview`, `POST /projects/:id/enroll` — `vaultEntryId` half) |
| Baseline shrink (bundled with E2's, applied together) | 121 → 103 → 101 |
| SQL/behavior change | 0 |
| Stayed audit-only (unpromoted, by design) | 1 (`POST /projects/:id/enroll`'s `kycEntryId` half — optional field, can't be a router-level gate) |
| Confirmed-unchanged, no gate (public/self-scoped) | 14 |
