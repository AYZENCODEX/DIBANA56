# Route Integration Roadmap — Season E, Phase E4: `teams.ts` leader-half audit-only triage

## Scope
`ROADMAP_ROUTE_INTEGRATION_PHASE_E1_E7.md`'s E4 — triage-first, per its own
instruction ("প্রথম কাজ তাই triage, না code"). D8's close-out noted D7 gave
audit-only wiring to the LEADER half of two compound "leader OR X" checks in
`teams.ts` (member self-removal, message delete); D6 separately left 6 other
`teams.ts` baseline entries deliberately untouched as self-scoped. This
phase's job: check whether any of those 6 are actually the same D7
leader-audit-only shape (mis-triaged, promote-worthy) or whether D6's
self-scoped call was correct for all of them.

## The two already-wired D7 leader-audit-only routes (context, not this phase's subject)
For reference — these are NOT part of the 6-entry baseline this phase
triages, since D7 already gave them audit-only wiring and the coverage
script already recognizes them as wired (compound "leader OR ownerId" checks
where the ownerId half routes through `authorize()` as a real gate):

- `DELETE /teams/:id/members/:memberId` — self-removal (ownerId-shaped) is a
  real gate via `teamsOwnershipEngine`; the leader half is a D7 audit-only
  `authorize()` call against `teamLeaderEngine`, decision discarded, hand-rolled
  `myRole !== "leader"` check still does the actual gating.
- `DELETE /teams/:id/messages/:messageId` — same split: authorship
  (ownerId-shaped) is a real gate, leader half is D7 audit-only.

Both stay exactly as D7 left them — out of scope here, and not baseline
entries (the coverage script sees the ownerId-shaped `authorize()` call on
each and counts the route as wired, same as any other compound-check route
in this file).

## Triage — the 6 baseline entries

| Route | Shape | Verdict |
|---|---|---|
| `POST /teams/:id/favorite` | Toggles a row keyed by `(user_id, team_id)` — the caller's own row, no separate owner field, no leader alternative branch at all | **Self-scoped — no gate applicable** |
| `POST /teams/:id/join-request` | Inserts/upserts a row keyed by `(team_id, user_id)` = the caller — this is the caller creating a request about themselves, not accessing an existing resource with an owner | **Self-scoped — no gate applicable** |
| `POST /teams/:id/leave` | Deletes the caller's own `team_members` row (`team_id, user_id = caller`); the one branch check (`team.owner_id === userId`) is a business rule blocking the CURRENT owner from leaving, not an access-control gate over someone else's resource | **Self-scoped — no gate applicable** |
| `PATCH /teams/:id/notifications` | Updates the caller's own `team_members.muted` (`team_id, user_id = caller`) | **Self-scoped — no gate applicable** |
| `GET /teams/:id/notifications` | Reads the caller's own `team_members.muted` (`team_id, user_id = caller`) | **Self-scoped — no gate applicable** |
| `PATCH /teams/:id/invites/respond` | Accepts/rejects the caller's own pending `team_members` row (`team_id, user_id = caller, status = 'pending'`) | **Self-scoped — no gate applicable** |

None of the 6 has the shape D7 gave audit-only wiring to: a compound
"leader OR [something with a genuinely separate owner]" check where a
DIFFERENT user's id is being compared against a fetched owner column. Every
one of these 6 is a plain `(userId, teamId)`-keyed operation on the caller's
own row — the same "composite key, no separate resource-id" self-scoped
shape this file's own D6/C4 headers, and `finance.ts`'s
`PUT /finance/currencies/:currency`, already established as the correct
no-gate case. `requireOwnership()`/`requireGroupMembership()`-style wiring
does not fit any of them; forcing one on would gate a resource that has no
owner distinct from the caller, which is the exact wrong-abstraction risk
the roadmap's own E4 entry warned about.

## Conclusion: D6's original call was correct for all 6 — no code change

Per the roadmap's own instruction ("শুধু যা promote-worthy পাওয়া যায় সেটাই
code change পাবে") and the D1-D4 "audit first" precedent (findings-only
output is itself a valid, complete phase when nothing is promote-worthy),
this phase makes **zero** code changes to `teams.ts`. All 6 baseline entries
are confirmed, not newly explained — D6's original self-scoped
classification holds.

## Baseline
No change — the 6 `teams.ts` entries stay in `ownership-gate-baseline.json`
exactly as they were, now carrying this doc as their permanent "reviewed,
intentionally not wired, cost > benefit — actually no benefit, no owner
distinct from caller" rationale, so a future phase doesn't re-open the same
question (same purpose D4/E6's own "explicit note" convention serves).

## Verification
`tsx scripts/src/check-ownership-gate-coverage.ts` re-run after this triage
(no code touched, so no diff expected):

```
Scanned 138 route files, 487 param routes total, 101 unwired,
20 public/token-audit-only (Phase F1, not counted as a gap).

OK — no new unwired param routes (101 pre-existing gap(s) in baseline, unchanged).
```

Clean pass, 101 unchanged — confirms this phase neither introduced a new gap
nor silently promoted anything.

## Result
| Item | Count |
|---|---|
| Baseline entries triaged | 6 |
| Promoted (audit-only → enforcing) | 0 |
| Confirmed genuinely self-scoped (D6's decision upheld) | 6 |
| SQL/behavior change | 0 |
| Baseline shrink | 0 (101 → 101, unchanged) |

## Next
Per `ROADMAP_ROUTE_INTEGRATION_PHASE_E1_E7.md`, next up is **E5** — new
`ResourceRefBuilder`s for `ayzen-mailbox.ts` + `vault-attachments.ts` (higher
risk, no existing builder to reuse, needs hands-on owner-column shape
confirmation before any code is written).
