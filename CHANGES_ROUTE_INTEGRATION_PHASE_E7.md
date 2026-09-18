# Route Integration Roadmap — Season E, Phase E7: close-out

## Scope
`ROADMAP_ROUTE_INTEGRATION_PHASE_E1_E7.md`'s E7 — Season E's last phase.
Three tasks, per that file's own E7 entry: (১) confirm the baseline is
current after E1-E6, (২) decide whether `auditFinanceOwnership()`/
`auditProjectsOwnership()` are now dead code and remove whichever are,
(৩) add a "Season E — সম্পূর্ণ disposition" section to
`CHANGES_ROUTE_INTEGRATION_PHASE_C35.md`'s reference table, next to
Season D's own addendum (D8's precedent for exactly this).

## (১) Baseline confirmation
`tsx scripts/src/check-ownership-gate-coverage.ts --update-baseline` (same
globally-installed `typescript`/`tsx`, temporary local `node_modules/
typescript` symlink, same setup every phase since D8 has used) re-run
against the current tree:

```
Scanned 138 route files, 487 param routes total, 89 unwired,
20 public/token-audit-only (Phase F1, not counted as a gap).

Baseline updated: 89 accepted unwired param routes written to
scripts/src/ownership-gate-baseline.json
```

No change from E6's own end state (89) — expected, since E6 already ran
`--update-baseline` itself and no route was touched between E6 and E7.
This step exists to *confirm* that, not to do new work.

## (২) `auditFinanceOwnership()` / `auditProjectsOwnership()` — dead-code check

| Helper | Live callers found | Disposition |
|---|---|---|
| `auditFinanceOwnership()` | 0 (`grep -rn` in `routes/` only matches two explanatory comments in `finance.ts`, no call sites) | **Already removed** — E2 removed it (and 9 now-unused `*AuditEngine` consts, 4 imports) as soon as every `finance.ts` caller migrated to real `requireOwnership()`. Nothing to do here; this check just confirms E2's own removal stuck and no later phase reintroduced a caller. |
| `auditProjectsOwnership()` | 1 (`projects.ts:632`, inside `POST /projects/:id/enroll`'s `kycEntryId` branch) | **Not removed — still has a live caller.** E3 itself deferred this exact decision to E7, contingent on "whatever E4-E6 do to its other potential callers." Neither E4 (`teams.ts`), E5 (`ayzen-mailbox.ts`/`vault-attachments.ts`), nor E6 (long-tail files) touches `projects.ts`'s enrollment route at all — the `kycEntryId` branch is unchanged from E3. The helper, its supporting `kycEntryAuditEngine`, and `kycEntryOwnerResource()` all stay. |

`auditProjectsOwnership()` isn't dead code and won't become dead code as a
side effect of this roadmap — the `kycEntryId` branch it audits is an
optional request-body field checked *inside* a conditional, which (per
E3's own finding) can't be expressed as an unconditional router-level
`requireOwnership()` gate. Removing it would require either restructuring
that route's control flow (out of scope for a mechanical route-integration
sweep) or an owner decision to change the route's shape — neither of
which E1-E7 was scoped to do. Left as a known, correctly-audit-only,
permanent case, same posture D7's own audit-only wiring already
established for routes that are safe but structurally can't take a
blocking gate.

## (৩) `CHANGES_ROUTE_INTEGRATION_PHASE_C35.md` — Season E addendum
Added, mirroring D8's own "Addendum — Season D" section: a file→disposition
table for E1-E7, a summary of what got promoted/reused/deferred, and the
final baseline arithmetic (154 → 89).

One thing surfaced while assembling that arithmetic and is worth flagging
here rather than silently smoothing over: E1's own verified end-state was
**154 → 141** (confirmed by a real script run in E1's own CHANGES doc),
but E2's own verified *start*-state — also from a real script run, not an
assumption — was **121**, not 141. That's a 20-route drop between E1 and
E2 that no phase in this roadmap accounts for. It doesn't indicate a
security regression (the count only went *down*, and every phase's own
clean run confirms no *new* unwired route appeared at any point — that's
what the script's pass/fail actually checks, not the absolute count), so
it isn't a gap this phase needs to close. But the roadmap's own arithmetic
doesn't explain it, and inventing an explanation here would be a claim
this phase has no evidence for. Recorded in the C35 addendum, in the open,
for whoever next has a reason to reconcile it (most likely: something in
this same `routes/` tree changed between those two phases outside this
roadmap's own commits — a plausible but unverified guess, stated as a
guess).

## Verification
- `tsx scripts/src/check-ownership-gate-coverage.ts` (no `--update-
  baseline`) re-run one final time after the C35 edit (a markdown-only
  change, but confirming nothing else drifted): clean, 89 unchanged, no
  new gaps.
- `grep -rn` for both helper names across `artifacts/api-server/src/
  routes/` — the table in (২) above is that grep's actual output, not a
  restatement of what the roadmap predicted.
- `CHANGES_ROUTE_INTEGRATION_PHASE_C35.md`'s edit is additive-only (one
  new section appended after the existing Season D addendum) — nothing
  in Season A/B/C/D's own tables was touched.

## Result
| Item | Count |
|---|---|
| Baseline at Season E start (post-D8) | 154 |
| Baseline at Season E end (post-E7) | 89 |
| Routes promoted across E1-E6 | 45 (E1 13, E2 18, E3 2, E4 0, E5 5, E6 7) |
| Unexplained baseline drop (flagged, not closed) | 20 (between E1 and E2) |
| Dead-code helpers removed this phase | 0 (already done in E2) |
| Dead-code helpers confirmed still-live, correctly kept | 1 (`auditProjectsOwnership()`) |
| Files touched this phase | 1 (`CHANGES_ROUTE_INTEGRATION_PHASE_C35.md`, addendum only) |
| Owner-decision-pending items remaining | 0 |
| Known unaddressed real bugs | 0 |

## Season E — can the series close?
Yes, per the same criteria D8 used for Season D: no pending owner
decision, no known unaddressed real bug, and the baseline's remaining 89
entries are each hand-verified and documented (across E1-E6's own CHANGES
docs and this phase's C35 addendum) as a specific, correct, permanent
shape rather than an open gap. The one loose end (the unexplained
141→121 drop) is a bookkeeping question, not a security one, and is
recorded rather than hidden.
