# Route Integration Roadmap — Season D, Phase D6: `createGroupMembershipRule()`

## Scope

D1 sized this phase: `teams.ts`'s membership-shape bucket (৫১ route, hand-
verified) was large/repeated enough to justify a new reusable PDP rule
rather than leaving every `SELECT role FROM team_members WHERE team_id =
... AND user_id = ... [AND status = 'active']` check hand-rolled forever.
This phase (ক) builds that rule, and (খ) wires it into every route in
`teams.ts` where it actually applies — same "don't just build it, use it"
posture D1–D5 already established for bug-fixes.

## (ক) The new rule

`lib/policy/resource/group-membership-rule.ts` — `createGroupMembershipRule(options?)`.

- No `options` (or `{}`) → "does the subject have ANY known membership" —
  the bucket খ.১ shape (any active member may read).
- `{ requiredRoles: ["leader"] }` → "does the subject hold THIS role" —
  the bucket খ.২ shape (leader-only writes).

**Design choice — DB-free, not a new provider.** Every other rule in
`lib/policy/resource/` is either a pure comparison over a caller-supplied
`ResourceRef` field (`ownership-rule.ts`'s `ownerId`, `organization-
access-rule.ts`'s `organizationId`) or genuinely needs its own DB-backed
provider (`explicit-grant-rule.ts`'s `ResourceGrantProvider`, for a table
no caller already queries for its own reasons). `team_members` is the
first case, not the second: every one of `teams.ts`'s 40+ in-scope routes
either already ran the exact membership `SELECT` for its own business
logic (the response payload, a downstream `role === "leader"` branch, a
two-stage "not a member" vs "not leader" error message) or needed to run
it anyway just to learn the role. A DB-backed provider would have added a
SECOND, redundant query at every call site for no benefit. So the rule
takes the fact as a caller-supplied field instead — `ResourceRef.groupRole`
(new, `lib/policy/types.ts`) — same trust boundary `ownerId`/
`organizationId` already establish. ABSTAIN-not-DENY on "no membership
fact" / "wrong role", same reasoning as every sibling rule in this
directory (see the file's own header for the full write-up).

`lib/policy/resource/index.ts` now re-exports it (barrel header updated
to note it's a Season D addition, not part of Phase 03's original
five-rule list).

## (খ) Wiring into `teams.ts`

Two module-load-time engines, same single-engine-per-shape posture
`teamsOwnershipEngine` already established in this file:

```ts
const teamMembershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
teamMembershipEngine.registerRule("group-membership", createGroupMembershipRule());

const teamLeaderEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
teamLeaderEngine.registerRule("group-membership", createGroupMembershipRule({ requiredRoles: ["leader"] }));
```

**42 routes converted** (20 member-only via `teamMembershipEngine`, 22
leader-only via `teamLeaderEngine` — D1's own hand-count was an estimate,
same "heuristic vs. exact" gap D1–D3 already flagged for their own
numbers):

- Member-only: `GET /teams/:id`, `/stats`, `/leaderboard`,
  `/member-progress`, `/activity`, `/projects`, `/messages` (+ `POST`),
  `/vault` (GET + POST), `/missions` (list + detail), `/members/:memberId`,
  `/messages/pinned`, `/announcements` (GET), `/analytics/growth`,
  `/email-accounts` (list, fetch-inbox, fetch-body, stored-messages).
- Leader-only: `PATCH /teams/:id`, `/invite-link`, `/invite`, `POST
  /missions` + `PATCH /missions/:missionId` (D5's leader-gate fix — now
  routed through the same PDP rule as every other mission-lifecycle
  action), `/enroll-project`, `/tasks/:taskId/enroll`, `/join-requests`
  (GET + PATCH), `/members/:memberId/note`, `/avatar`, `/visibility`,
  `/messages/:messageId/pin`, `/announcements` (POST), `DELETE
  /missions/:missionId`, `/missions/:missionId/claim`, `/export`,
  `/audit-log`, and the 4 leader-only mailbox routes (`test-config`,
  add/update/remove config).

**No new queries added anywhere.** Every conversion reuses the route's
existing lookup — either the exact query it already ran (`getTeamRole()`,
this file's pre-existing active-only helper, hoisted and now called from
routes above its own textual definition same as it always was for the
mailbox section) or a new-but-equally-necessary one (`getTeamRoleAny()`,
added for the ~17 routes whose original query had NO `status = 'active'`
filter — D1's own finding that this file was inconsistent about that even
before D6; each route's filter is preserved exactly, not normalized to
one or the other). The gate itself — which comparison decides the 403 —
now runs through the PDP; the SQL that produces the role fact is
byte-for-byte what it always was.

**No response text changed.** Every converted route keeps its original
`res.status(403).json({ error: "..." })` message. The two-stage routes
(`invite-link`, `POST`/`PATCH /missions`, `enroll-project`, `tasks/:taskId/
enroll`) keep BOTH their original messages ("Not a team member" vs the
route-specific "Only leader can ...") — the role fact is still fetched
into a local variable for that branch, same as before; only the
comparison that decides ALLOW moved to the PDP.

## Deliberately NOT touched (same routes D1 already classified as
out-of-scope for this shape)

- **বুকেট খ.৩ — self-scoped (6):** `/favorite`, `/join-request`, `/leave`,
  `/notifications` (GET + PATCH). These scope by `user_id = callerId`
  directly in the query — there's no separate membership FACT to compare,
  so `group-membership-rule.ts` has nothing to add here.
- **বুকেট খ.৪ — already PDP-routed, compound (5):** member self-removal,
  role-change, message delete/update, transfer-ownership. C4's own
  decision to leave the hand-rolled `role !== "leader"` half of these
  compound "leader OR owner/author" checks untouched stands — D6 doesn't
  reopen that call. (A future phase COULD replace that half with
  `teamLeaderEngine` + `createRoleOverrideRule`-style OR-composition, but
  that's a combining-algorithm question, not this phase's scope.)
- **বুকেট ক — inline platform-role (4 admin routes):** `role !== "admin"`
  checks on `req.user!.role` — a different fact entirely
  (`subject.role`, not `resource.groupRole`); D1's own bucket ক, D8's
  problem, not D6's.

## Verification

- Both edited/new files pass a TypeScript **syntax** parse (no parse
  diagnostics) via the `typescript` package's `createSourceFile()`.
- Manual line-by-line diff review of all 42 converted call sites against
  the pre-D6 file, confirming: same error message, same status code, same
  `status = 'active'` filter presence/absence as the original query,
  no added round-trips.
- **Full `tsc --noEmit` / DB-connected integration test was not run** —
  this sandbox has no installed `node_modules` for `@workspace/db`/
  `express`/`drizzle-orm` and no network to fetch them (same limitation
  `drizzle-resource-grant-provider.ts`'s own header already notes for
  Phase 3B: "cannot be executed against a real database in this sandbox
  either"). A follow-up pass with the real toolchain should run
  `pnpm --filter @workspace/api-server typecheck` before merge.

## এখনো যা বাকি

- D7 (contingent, audit-trail sweep): partially superseded by this
  phase — 42 of `teams.ts`'s previously-invisible-to-`pepDecisionObserver`
  routes now ARE observable (both new engines pass `onDecision:
  pepDecisionObserver`), same as `teamsOwnershipEngine`'s existing 5. D7's
  remaining candidate list shrinks to: the 40 raw-SQL/token finance routes
  (D2), the self-scoped/compound teams.ts routes D6 didn't touch, and
  `projects.ts`/`tasks.ts`'s membership/owner-scoped raw-SQL routes (D3).
- D8: `group-membership-rule.ts`'s wrapper shape (`engine.registerRule(
  "group-membership", createGroupMembershipRule(...))`) is a candidate
  for the lint script's `PEP_WIRING_NAMES` update, same as D1/D2/D3's
  inline-`authorize()`/platform-role findings — none of these 42 routes
  will show as "wired" to `check-ownership-gate-coverage.ts` until that
  script knows this pattern too.
- Real `tsc --noEmit` + integration-test pass with the actual toolchain
  (see "Verification" above) before this lands.
