# AYZEN Workspace — Skarn Subdomain Split (master plan §7 Phase 3)

## The key finding, stated first
Skarn was **not** an unbuilt Phase 4 project, despite what the master plan
doc's "Old module (current code)" column said ("Phantom Protocol / V6
blueprint"). Confirmed by reading the actual code: the **"Protocols" nav
group** in `app-sidebar.tsx` — present in both `USER_NAV` and `ADMIN_NAV`,
its own comment literally says *"Protocols restructure (round 2)"* — is
already the full airdrop project-tracking product: projects, categories
(Exchange/Web3/Instant/Onchain/App/Social/Task rollups), per-project tasks,
operator progress. This *is* Skarn, already shipped, just never renamed
from its working label. So this pass is the same kind of split as
Sylo/Ryft/Wisp/Verve — scope existing routes, rename nothing — not a new
build.

## What was added

### Frontend
| File | Change |
|---|---|
| `artifacts/ayzen/src/lib/subdomain-app.ts` | Added `skarn` to `SUBDOMAIN_APPS`. Same "zero changes needed in `App.tsx`/`app-sidebar.tsx`" story as every prior app in this series. |

### Backend
| File | Change |
|---|---|
| `artifacts/api-server/src/app.ts` | Added a `skarn` row to `SPLIT_APP_HOST_CONFIG` (`SKARN_HOSTS`, defaults to `skarn.ayzen.tech`, home path `/projects`). |
| `scripts/src/seed-oidc-clients.ts` | Added `seedClient("skarn", "Skarn", { backchannelLogout: true })` — same shape as the other five, registers the OIDC client so `skarn.ayzen.tech` gets the existing "Sign in with AYZEN" auto-cutover flow for free (that flow is already fully generic over `getCurrentSubdomainApp().id`, confirmed when Ryft/Wisp/Verve were added — nothing there needed to change again). |
| `scripts/src/test-seed-oidc-clients.ts` | Updated `SUBDOMAIN_CLIENT_IDS` to include `"skarn"`, and the six→seven / five→six count language in the assertion name and file header comments, so the "exactly N first-party apps, no more no fewer" test stays accurate instead of silently passing on a stale expectation. |

## Route scoping chosen

| Home path | In-scope prefixes | Source |
|---|---|---|
| `/projects` | `/projects`, `/tasks`, `/content`, `/admin/projects`, `/admin/project-templates`, `/admin/operator-progress`, `/admin/tasks` | Exactly `USER_NAV`'s "Protocols" group (`/projects` + every `?rollup=`/`?type=` filter variant the Category sub-tree uses — `hasPrefix()`'s `"?"` boundary check already covers those, same mechanism Ryft's finance filters relied on — plus `/tasks` and `/content`, both nested *inside* the Protocols group itself) and `ADMIN_NAV`'s "Protocols" group (its four items, verbatim). |

### Deliberately left out — read the code, didn't assume
These are airdrop-farming-*adjacent* but organizationally live in their own
sidebar groups, not nested under "Protocols":
- `/teams` — the "Team" nav group (farming teams, team chat, team vault).
- `/leaderboard` — lives in the "Social" group, alongside `/inbox`, `/profile`, `/support`.
- `/earn`, `/referrals` — their own "Earn" group.
- `/enroll/*` — its own "Enroll" group (separate from both Vault's enrollment sub-pages and Protocols).
- `/calendar`, `/checkin`, `/history` — the "Command" group (the Workspace hub itself, not app-scoped).

Master plan §2 describes Skarn as covering "farming teams" too, which would
pull `/teams` in — but the user's own framing this pass was specifically
"Protocols is the top-level sidebar name," so this pass claims exactly
that group and no more. Worth a follow-up decision, not an assumption to
bundle in silently.

## Zynth — still not included, and why re-confirmed
Re-checked before writing this: there is a real AI chat surface
(`components/ai-chat.tsx`), but it's mounted globally and unconditionally
in `App.tsx` (`<AiChat />` sits next to the router, not inside a route) —
a floating widget on every page, not a page of its own. The OIDC client is
seeded and the client-id resolver is already generic, but there's no
`homePath` a subdomain visitor could sensibly land on yet. Left out per
your last call ("আপাতত বাদ দাও").

## What was tested
- Brace/paren balance checked on all four edited files (no `node_modules`
  in this sandbox, same constraint as every prior pass in this series).
- Not tested: live OIDC seed run, or browser behavior on
  `skarn.localhost`. Same pre-deploy checklist as Sylo/Ryft/Wisp/Verve:
  run `npx tsx scripts/src/seed-oidc-clients.ts` against a real DB, then
  `npx tsx scripts/src/test-seed-oidc-clients.ts` to confirm the count
  assertion passes; verify the sidebar filters correctly and an existing
  session is recognized without re-login on the new host.

## What's still open
- Whether `/teams` (and/or `/leaderboard`, `/earn`, `/enroll/*`) should
  fold into Skarn's scope — flagged above, not decided here.
- Zynth's entry — blocked on a real user-facing AI route existing.
- DNS/hosting for `skarn.ayzen.tech` — same as every other split app, still ahead.
