# CHANGES — Feature 15n: Vault Backup Coverage Expansion — Team & Earning

Closes two more account-scoped gaps in the Vault Backup blob
(`/vault/snapshot/export` and the automatic backup cron): **Teams**
(`routes/teams.ts`) and **Earning** (`pages/user/earn.tsx` /
`routes/earn-links.ts`) were entirely outside every backup until now.

## The gap

`buildVaultSnapshotPayload()` already covered Vault/Local/KYC/Game entities
and everything hanging off them (15h/15i), the native mailbox/projects/
tasks/finance/profile (15d), the Wallet Hub (15e), the activity trace
(15f), Emergency Access (15j), and the remaining account/platform extras —
notifications, referrals, subscription, support, API keys, passkeys,
Polymarket trades (15m). Two more account-scoped surfaces were still
missing entirely:

- **Teams** — a user's own team ownership, memberships, and everything
  they've personally posted/requested/created inside a team. None of it
  was in any backup, so a disaster-recovery restore had no reference copy
  of a user's team relationships at all.
- **Earning** — the pay-per-click `earn_links` a user has minted on the
  Earn page. The AZN balance those links produce (`credits.azn_balance`)
  was already covered by the Wallet Hub surface (15e), but the links
  themselves — title, target URL, share code, per-click rate, and their
  running click/earned counters — were not.

## What changed

**Backend**
- `lib/vault-snapshot-extra.ts` — added `gatherTeamSnapshot()`, returning:
  - `teamsOwned` — `teams` rows this user owns (`owner_id`).
  - `memberships` — `team_members` rows for this user, across every team
    they belong to (not just owned ones) — this is what "which teams am I
    in, and with what role/status" means for this user's own account
    state.
  - `joinRequestsMade` — `team_join_requests` this user filed.
  - `favorites` — `team_favorites`: teams this user starred.
  - `messagesSent` — `team_messages` this user posted, across every team's
    chat (not the full chat log for teams they're merely a member of —
    that's other members' data).
  - `announcementsPosted` — `team_announcements` this user authored
    (`created_by`; only leaders can post these, so in practice this is
    populated for `teamsOwned`).
  - `missionsCreated` — `team_missions` this user created (`created_by`).
  - `teamActivityLegacy` — `team_activity_log` rows this user triggered:
    the pre-"Phase 17 audit fix" bespoke team log (see
    `routes/teams.ts`'s own comment on this) — nothing writes to it
    anymore, but historical rows are still on disk and still part of this
    user's own history. Capped to `TEAM_ACTIVITY_LIMIT` (2000), same
    unbounded-growth reasoning as the activity trace's
    `ACTIVITY_TRACE_LIMIT`.
  - `teamActivityShared` — `activity_log` rows with `subject_type='team'`
    where this user was the actor (`actor_user_id`) — the current
    (post-fix) team event log. This generic, reusable table (see its own
    schema doc comment) was never itself scoped into any backup surface
    before now; this pulls only the team-subject slice this user
    personally caused. Also capped to `TEAM_ACTIVITY_LIMIT`.

  And `gatherEarningSnapshot()`, returning:
  - `earnLinks` — every `earn_links` row this user owns.

  Both use the same `.catch(() => [])` degrade-to-empty pattern as the
  rest of this file.
- `routes/vault-snapshot.ts` — `buildVaultSnapshotPayload()` now also calls
  `gatherTeamSnapshot()` and `gatherEarningSnapshot()`, nesting the results
  under new `team` / `earning` keys (same shape/treatment as
  `accountExtras`/`emergencyAccess`: included in every backup, counted,
  **not** auto-restored — see below). Snapshot `version` bumped to `7`.
  New `teamCount` / `earningCount` returned alongside the other per-surface
  counts, threaded through `storeSnapshotRow()` /
  `POST /vault/snapshot/export` / `GET /vault/snapshots` / the activity-log
  payload, same pattern as `accountExtrasCount` before it.
- `lib/vault-backup-schedule-cron.ts` — `runVaultBackupSchedule()` now
  threads `teamCount` / `earningCount` through to `storeSnapshotRow()` too,
  so scheduled/automatic backups carry the same counts as manual exports.
- `migrations/065_ayzen_vault_backup_team_earning.sql` — adds
  `team_count` / `earning_count` to `vault_snapshots` (applied by hand
  against Supabase, same convention as migrations 055–064: not wired into
  `index.ts`'s boot-time `MIGRATIONS` array).
- `lib/db/src/schema/vault-snapshots.ts` — adds the matching `teamCount` /
  `earningCount` columns.

**Frontend**
- `lib/vault-snapshot-api.ts` — `StoredSnapshot` gains optional
  `teamCount` / `earningCount`.
- `pages/user/vault-snapshot.tsx` — the Stored Backups list row now shows
  a `+N team` badge (tooltip: "Teams owned, memberships, join requests,
  favorites, messages, announcements, missions, team activity") and a
  `+N earning` badge (tooltip: "Pay-per-click earn links") next to the
  existing entities/wallets/attachments/account/automatic badges, whenever
  a backup carries any of this surface.

## Why not auto-restored

Same category as `accountExtras`/`emergencyAccess`/`entityCoverage`: a
restored `teams`/`team_members` row would need `team_id` remapped
post-restore the same as every other cross-row reference already excluded
for this reason elsewhere in this backup, and re-inserting old team chat/
announcement/join-request rows would replay old workflow state as if it
just happened — the same mistake the activity trail is already excluded
for. `earn_links.code` is additionally globally unique
(`routes/earn-links.ts`'s `randomCode()`), so a merge-restore re-inserting
an old code verbatim could collide with a code re-issued to someone else
in the meantime. Backed up for reference/manual disaster recovery from the
raw JSON, same treatment every other reference-only surface above already
gets.

## Already covered (not new in this change)

The rest of the requested surface was already fully covered by earlier
features in this backup, so no new work was needed for it:

- **Notifications, Referrals, Profile** — Feature 15m
  (`CHANGES_VAULT_BACKUP_ACCOUNT_EXTRAS.md`): `notifications`,
  `referrals` (both directions), and the user's own `users` row
  (auth secrets stripped) are already in every backup.
- **KYC** — Feature 15h (`CHANGES_VAULT_BACKUP_ENTITY_COVERAGE.md`): the
  base `kyc_entries` table is gathered directly in
  `buildVaultSnapshotPayload()`, and the underlying identity record
  (`kyc_data_entities` — name, father's name, birth date, photos, NID
  number) is gathered by `gatherEntityCoverageSnapshot()`.

## Not touched

- Other members' data on a team this user merely belongs to (their
  messages, their membership rows, the team's other announcements/
  missions) — not this user's own data, same reasoning the projects/tasks
  catalogs were already excluded for in Feature 15d.
- `credits` / `credit_transactions` (the AZN balance `earn_links` clicks
  produce) — already covered by `gatherWalletHubSnapshot()` (Feature 15e).
