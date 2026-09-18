# CHANGES — Feature 15h: Vault Backup Coverage Expansion — Entity Coverage

Extends the Vault Backup blob (`/vault/snapshot/export` and the automatic
backup cron) so Local Accounts, Vault Entities, KYC Entities, and Game
Entities are **fully** covered — not just their own base rows, which were
already backed up, but everything else hanging off those four tables.

## The gap

`buildVaultSnapshotPayload()` already gathered the four base tables
(`vault_entries`, `local_accounts`, `kyc_entries`, `game_entries`) directly.
But four more pieces of data that belong to those same entities lived
outside those tables and were missing from every backup:

- **`kyc_data_entities`** — the actual identity record (name, father's
  name, birth date, photos, NID number) that a KYC Entity *or* a Vault
  Entity can link via `data_entity_id` (see `routes/kyc-data-entities.ts`).
  This is real identity data, not metadata — a restored KYC/Vault entity
  with no underlying identity record behind it is a hole in the backup, not
  a convenience gap.
- **`vault_category_receipts`** — shareable receipt-card links minted per
  `(user, category)` across Local Accounts / Vault Entities in that
  category.
- **`value_history`** — the $ worth / follower-count P&L timeline recorded
  per Vault or Local entity.
- **`vault_shares`** — entity access grants, which span **all four** entity
  types (`local` / `entity` / `kyc` / `game` — see `ENTITY_TABLES` in
  `routes/vault-shares.ts`), gathered in both directions: shares this user
  granted away on their own entities, and shares someone else granted *to*
  this user.

## What changed

**Backend**
- `lib/vault-snapshot-extra.ts` — added `gatherEntityCoverageSnapshot()`
  (returns `dataEntities`, `categoryReceipts`, `valueHistory`,
  `sharesOwned`, `sharesReceived`) and `reencryptDataEntityForRestore()`
  (re-encrypts `nid_number` on insert, same convention as the existing
  mailbox message/template re-encrypt helpers). `nid_number` is decrypted
  at gather time so the backup is immediately usable, matching how every
  other sensitive field in this backup already works.
- `routes/vault-snapshot.ts` — `buildVaultSnapshotPayload()` now also
  calls `gatherEntityCoverageSnapshot()`:
  - `kycDataEntities` is flattened to a top-level array, same as
    `localAccounts` / `kycEntries` / `gameEntries`, and is fully
    merge-restorable.
  - `categoryReceipts`, `valueHistory`, `sharesOwned`, `sharesReceived` are
    kept nested under a new `entityCoverage` key — included in every
    backup for disaster-recovery reference, but **not** auto-restored (see
    "Why these four aren't auto-restored" below). Same treatment
    `finance`/`profile`/`activity` already get.
  - Snapshot `version` bumped to `3`.
  - New `entityCoverageCount` returned alongside the existing per-surface
    counts, and threaded through `storeSnapshotRow()` /
    `POST /vault/snapshot/export` / `GET /vault/snapshots` /
    `logActivity()`, same pattern as `activityCount` before it.
- `lib/vault-snapshot-restore.ts` — added a `kycDataEntities` restore path:
  - Identity key = `name + father_name + birth_date` (deliberately avoids
    `nid_number`, since that column is encrypted at rest and
    `existingDataEntityKeys()` reads straight from the DB without
    decrypting — same reasoning every other identity key here already
    avoids encrypted columns).
  - `insertDataEntityRow()` re-encrypts `nid_number` via
    `reencryptDataEntityForRestore()` before insert.
  - Wired into both `buildRestoreDiff()` (preview) and `applyRestoreDiff()`
    (apply), and into `RestoreTableKey` / `byTable`.
- `lib/vault-backup-schedule-cron.ts` — `runVaultBackupSchedule()` now
  destructures and passes through `entityCoverageCount` too, so scheduled
  backups get the same denormalized count as manual exports.
- `lib/db/src/schema/vault-snapshots.ts` — added `entityCoverageCount`
  column.
- New migration `061_ayzen_vault_backup_entity_coverage.sql` — adds
  `entity_coverage_count` to `vault_snapshots` (applied by hand against
  Supabase, same convention as migrations 055–060: not wired into
  `index.ts`'s boot-time `MIGRATIONS` array).

**Frontend**
- None needed. The Snapshot Backup page's restore-preview UI already
  renders `preview.tables` generically (label + counts per table), so the
  new `kycDataEntities` row shows up automatically once the backend returns
  it — no per-table hardcoding to update.

## Why `categoryReceipts` / `valueHistory` / `sharesOwned` / `sharesReceived` aren't auto-restored

- `value_history.source_id` and `vault_shares.entity_id` both point at a
  *specific row id* on one of the four entity tables. A merge restore gives
  a restored entity a brand-new id — there's no safe way yet to remap a
  history point or a share grant onto the entity that gets recreated for
  it, the exact same limitation `mailboxAttachments` already has against
  `mailboxMessages`.
- `vault_shares` is also two-party data: silently reinstating a grant that
  points at another user's account isn't something a restore should ever
  do on its own, even if the id-remapping problem above didn't exist.
- All four are still included in every backup — so a full disaster
  recovery is always possible by hand from the raw JSON — and are counted
  in `entityCoverageCount`, same treatment `finance` / `profile` /
  `activity` already get.

## Not touched

- `vault_security` (Vault PIN/2FA/password hashes) — deliberately excluded,
  same reasoning `gatherUserProfileSnapshot()` already excludes
  `password_hash` / `two_fa_secret`: these are credentials, not data, and a
  backup blob re-decryptable by anyone who eventually gets the export
  password should never carry auth material.
- `emergency_access` (emergency contacts / dead-man-switch grants) — a
  separate, account-level feature, not entity data. Out of scope here.
- Vault Marketplace (`vault_market_listings`, `marketplace_wallets`,
  `marketplace_transactions`) — a separate buying/selling subsystem on top
  of these entities, same "platform-wide, not this user's raw data"
  reasoning the projects/tasks catalogs already get excluded for. Could be
  a future coverage pass if needed.
