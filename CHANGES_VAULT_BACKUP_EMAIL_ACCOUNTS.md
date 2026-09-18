# CHANGES — Vault Backup Coverage Expansion: Connected Mail Accounts (Feature 15u)

**The ask:** "Massively extend the vault backup" — specifically, find a real
data domain that isn't in the backup yet and add it, the same way rounds
15d through 15t each added one (mailbox, projects/tasks, finance, wallet
hub, activity, entity coverage, emergency access, account extras, team/
earning, and the backup system's own configuration).

## Finding the actual gap

Before adding anything, I audited every schema file against what
`buildVaultSnapshotPayload()` / `vault-snapshot-extra.ts` already gather, to
avoid re-covering ground the app already covers under a different name:

- **Already covered** (via `gatherAccountExtrasSnapshot` / `gatherEntityCoverageSnapshot`,
  Feature 15m/15h): notifications, referrals, subscription/billing,
  support tickets + messages, developer API keys (metadata only), passkeys,
  Polymarket trades, value history.
- **Deliberately platform-wide, not user data** — same reasoning this file
  already gives for excluding the projects/tasks *catalogs*: `dr_test_reports`
  (DR evidence, admin-wide), `admin_wallet_ledger` (admin ledger), `broadcasts`,
  `config_entries`, `dev_nav_items`, `page_layouts`, `settings`/`plugins`/
  `error_logs`, `uptime_pings`.
- **Deliberately excluded as live secrets/infra**, same class as
  `webhook_secret` and the cloud OAuth tokens `gatherBackupSystemSnapshot`
  already excludes: `otp_codes` (transient, already hashed + short-lived),
  `encryption_keys` (the wrapped DEKs that decrypt *everything else in this
  app*, including this backup's own field-encrypted values — including
  these, even wrapped, would be a fundamentally different class of exposure
  than any per-user secret, and it isn't per-user data at all).
- **The actual gap:** `email_accounts` (`lib/db/src/schema/email-accounts.ts`)
  — the external IMAP/SMTP mailboxes a user connects
  (`routes/email-accounts.ts`) so AYZEN can send/fetch through their own
  existing Gmail/Outlook/custom-domain inbox, instead of (or alongside) the
  native ayzen.tech mailbox. The native mailbox itself has been fully
  covered since Feature 15d — but nothing backed up *which outside
  mailboxes a user had wired up, at what host/port, under which
  credentials*. A disaster-recovery restore that rebuilds every native
  message but leaves you re-discovering your own IMAP settings from memory
  isn't full coverage.

## The fix — `gatherEmailAccountsSnapshot()`

New function in `lib/vault-snapshot-extra.ts`, following the exact
`rows(db.execute(sql\`...\`))` pattern every other gather function in the
file uses:

- Queries `email_accounts` scoped to `user_id = userId` — this user's own
  personal accounts (`teamId` null) plus any team mailbox they personally
  configured, matching the "own slice, not everything currently visible"
  scoping `gatherTeamSnapshot` already uses for team data elsewhere in this
  file. A team mailbox *another* member set up is that member's own backup,
  not this user's.
- `password` / `auth_key` are decrypted with `decryptField` — the same
  field-encryption primitive (and the same treatment) Vault entity fields
  and wallet seed phrases already get elsewhere in the same snapshot.

**Why this one IS decrypted, where round 8/15t's cloud-connection OAuth
tokens and webhook secret are NOT:** those are AYZEN's own currently-valid
credential to reach a *third party* on the user's behalf — possession alone
grants live access, and a stolen backup blob (which routinely leaves the
server by design, e.g. emailed/cloud-delivered) would hand that access to
whoever has the blob, independent of anything else they know. An
`email_accounts` row is the opposite direction: it's the user's own
external mailbox credential, i.e. exactly the kind of secret this app's
Vault exists to store and back up in the first place — the same category
as a Vault entry's own sensitive fields or a wallet's seed phrase, both of
which this backup already decrypts and includes rather than stripping.

## Wiring

Same shape as every prior round — a new `emailAccountsCount` denormalized
count threaded through the same six call sites `backupSystemCount` (15t)
touches:

- `routes/vault-snapshot.ts` — `buildVaultSnapshotPayload()` (payload
  built + count computed, snapshot `version` bumped 7 → 8),
  `StoreSnapshotRowInput` / `storeSnapshotRow()`, the manual export route's
  `storeSnapshotRow` call + `logActivity` call, and `GET /vault/snapshots`'s
  column selection.
- `vault-backup-schedule-cron.ts` — `runVaultBackupSchedule()`, so
  scheduled/automatic backups carry the same count as manual exports.
- `lib/db/src/schema/vault-snapshots.ts` + new
  `migrations/075_ayzen_vault_backup_email_accounts.sql` — the
  `email_accounts_count` column.
- `artifacts/ayzen/src/lib/vault-snapshot-api.ts` — `StoredSnapshot`
  interface, `emailAccountsCount` optional (older rows predate migration
  075).
- `artifacts/ayzen/src/pages/user/vault-snapshot.tsx` — new badge on each
  stored-backup row, `Mail` icon (already imported), next to the
  `backupSystemCount` badge it sits beside.

**Payload placement:** `emailAccounts: { accounts: [...] }`, nested (not
flattened into `RAW_PLANS`) and **not auto-restored** — same reasoning as
`backupSystem`/`team` in the prior round: silently re-inserting an old
mailbox config, especially a team one, could resurrect a connection setup
another member has since changed or a credential that's since been
rotated, without anyone explicitly choosing that. It's backed up for
reference/manual disaster recovery, same treatment every non-`RAW_PLANS`
domain in this file already gets.

**Touched:** `migrations/075_ayzen_vault_backup_email_accounts.sql`,
`lib/db/src/schema/vault-snapshots.ts`,
`artifacts/api-server/src/lib/vault-snapshot-extra.ts`,
`artifacts/api-server/src/routes/vault-snapshot.ts`,
`artifacts/api-server/src/lib/vault-backup-schedule-cron.ts`,
`artifacts/ayzen/src/lib/vault-snapshot-api.ts`,
`artifacts/ayzen/src/pages/user/vault-snapshot.tsx`.
