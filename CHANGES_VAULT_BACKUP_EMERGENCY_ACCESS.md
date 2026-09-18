# CHANGES — Feature 15j: Vault Backup Coverage Expansion — Emergency Access

Closes the last item explicitly flagged as "not touched" in
`CHANGES_VAULT_BACKUP_ENTITY_COVERAGE.md`: Emergency Access (Feature 16's
dead-man-switch — `emergency_contacts` + `emergency_access_grants`) was
excluded because it's account-level, not entity data. It's still this
user's own configuration/workflow state though, same category as
`profile`/`walletHub`, so it now rides along in the same disaster-recovery
snapshot.

## What changed

**Backend**
- `lib/vault-snapshot-extra.ts` — added `gatherEmergencyAccessSnapshot()`,
  returning:
  - `contactsOwned` — `emergency_contacts` this user nominated.
  - `grantsOwned` — `emergency_access_grants` triggered against this user's
    own vault (`owner_user_id`).
  - `grantsAsContact` — grants where this user is the nominated contact,
    resolved via `emergency_contacts.contact_user_id` (the grants table
    itself only carries `contact_id`, not the contact's own user id) — same
    "both directions matter" reasoning `sharesOwned`/`sharesReceived`
    already use.
- `routes/vault-snapshot.ts` — `buildVaultSnapshotPayload()` now also calls
  `gatherEmergencyAccessSnapshot()` and nests the result under a new
  `emergencyAccess` key (same shape/treatment as `finance`/`profile`:
  included in every backup, counted, **not** auto-restored — see below).
  Snapshot `version` bumped to `5`. New `emergencyAccessCount` returned
  alongside the other per-surface counts, threaded through
  `storeSnapshotRow()` / `POST /vault/snapshot/export` /
  `GET /vault/snapshots` / `logActivity()`, same pattern as
  `entityCoverageCount` before it.
- `lib/vault-backup-schedule-cron.ts` — `runVaultBackupSchedule()` now
  destructures and passes through `emergencyAccessCount` too, so scheduled
  backups get the same denormalized count as manual exports.
- `lib/db/src/schema/vault-snapshots.ts` — added `emergencyAccessCount`
  column.
- New migration `062_ayzen_vault_backup_emergency_access.sql` — adds
  `emergency_access_count` to `vault_snapshots` (applied by hand against
  Supabase, same convention as migrations 055–061: not wired into
  `index.ts`'s boot-time `MIGRATIONS` array).

**Frontend**
- None needed — same reason as Feature 15h: the Snapshot Backup page's
  restore-preview UI renders `preview.tables` generically.

## Why not auto-restored

Same reasoning as `entityCoverage`/`finance`/`profile`/`activity`:
`contact_id` and `owner_user_id` would need remapping post-restore just like
every other cross-row reference in this backup, and `access_token_hash`
rows represent live workflow state — a pending or still-valid grant.
Silently reinstating one on restore would replay old state as if it just
happened, the same mistake the activity trail is already excluded for.
Included in every backup so a full manual/disaster recovery is always
possible from the raw JSON.

## Vault Backup coverage — now closed out

With this, every item ever flagged as a gap across Features 15d–15j is
either covered or has been confirmed as not applicable:
- ✅ Mailbox, Projects, Tasks, Finance, Profile (15d)
- ✅ Wallet Hub (15e)
- ✅ Activity trace (15f)
- ✅ Full Local/Vault/KYC/Game entity coverage — data entities, category
  receipts, value history, shares (15h)
- ✅ Linked Entities graph (15i)
- ✅ Emergency Access (15j)
- ⛔ `vault_security` — deliberately excluded, always: auth material
  (PIN/2FA/password hashes), same reasoning `password_hash`/`two_fa_secret`
  are stripped from `profile`.
- ⛔ Vault Marketplace (`vault_market_listings`, `marketplace_wallets`,
  `marketplace_transactions`) — platform-wide subsystem data, same "not
  this user's raw data" reasoning the projects/tasks catalogs are excluded
  for. Could still be revisited if a concrete need shows up.
- ⛔ Game Entity attachments — no such feature exists in the codebase to
  back up (would be a new feature build, not a backup fix).
