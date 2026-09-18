# AYZEN Workspace — Warde Subdomain Split (master plan §7 Phase 3, folded in from Phase 8)

Same pattern as Skarn: the "Team" nav group (`app-sidebar.tsx` — same shape
across `USER_NAV`, `MODERATOR_NAV`, `TEAM_LEADER_NAV`, and its own mirror in
`ADMIN_NAV`) is already the farming-team management product — members,
chat, browse/invite, task & mission progress, team leaderboard/projects
rollup, team vault, team settings. That's Warde's brand, already built.
Per your call, folded in now rather than waiting for the master plan's
Phase 8 slot.

## What was added

### Frontend
| File | Change |
|---|---|
| `artifacts/ayzen/src/lib/subdomain-app.ts` | Added `warde` to `SUBDOMAIN_APPS`. Zero changes needed in `App.tsx`/`app-sidebar.tsx`, same as every prior app. |

### Backend
| File | Change |
|---|---|
| `artifacts/api-server/src/app.ts` | Added a `warde` row to `SPLIT_APP_HOST_CONFIG` (`WARDE_HOSTS`, defaults to `warde.ayzen.tech`, home path `/teams`). |
| `scripts/src/seed-oidc-clients.ts` | Added `seedClient("warde", "Warde", { backchannelLogout: true })`. |
| `scripts/src/test-seed-oidc-clients.ts` | `SUBDOMAIN_CLIENT_IDS` now includes `"warde"`; count language updated seven→eight / six→seven throughout (assertion name + file header). |

## Route scoping chosen

| Home path | In-scope prefixes | Source |
|---|---|---|
| `/teams` | `/teams`, `/team_leader`, `/admin/teams`, `/admin/team-vault` | Every `/teams?tab=...` variant (Overview/Members/Chat/Browse/Invite/Tasks/Missions/Leaderboard/Projects/Vault/Panel) is the same route, one prefix — same `"?"` boundary mechanism `hasPrefix()` already used for Ryft's finance filters and Skarn's project rollups. `/team_leader` covers the team-leader-role Sidebar Builder custom-page route (`/team_leader/custom/:slug`), the team-leader equivalent of the custom-page routes the other roles already have. Admin's own "Team" nav group is exactly `/admin/teams` + `/admin/team-vault`, included verbatim. |

`/leaderboard` (the standalone "Social" group entry) was **not** pulled in
here — `/teams?tab=leaderboard` (team-scoped leaderboard, now in Warde) and
`/leaderboard` (the site-wide "Operators" leaderboard, still in Social) are
two different routes/views; only the former is Warde's.

## Where this leaves the master plan's Skarn/Warde split
Master plan §2 described Warde as covering "farming teams" as part of a
broader Team/Enterprise (RBAC, shared vaults, org wallets) layer, and
separately noted org-admin audit visibility into Sylo/Ryft/Verve/Skarn as
"a design principle, not yet built" (§9). This pass claims exactly the
existing `/teams` product surface — nothing here builds the
enterprise/org-account layer (shared vaults, org wallets, cross-app audit
log) that section describes; that's still genuinely unbuilt, unlike Skarn
and Warde's *farming-team* surface which already existed under a plain
label.

## What was tested
Same discipline as every prior pass in this series: brace/paren balance
checked on all four edited files (no `node_modules` in this sandbox).
Not tested: live OIDC seed run, or browser behavior on `warde.localhost`.
Before deploying: run `npx tsx scripts/src/seed-oidc-clients.ts` against a
real DB, then `npx tsx scripts/src/test-seed-oidc-clients.ts`; verify
sidebar filtering and session continuity on the new host, same checklist
as Sylo/Ryft/Wisp/Verve/Skarn.

## Status after this pass
All six branded apps with an existing product surface are now split:
**Sylo, Ryft, Wisp, Verve, Skarn, Warde.** Only **Zynth** remains
unscoped, blocked on a real user-facing route (its AI surface is currently
a global floating widget, not a page — see the Skarn CHANGES doc for the
full explanation). DNS/hosting for all six is still ahead, unchanged from
every prior pass's own carve-out.
