# CHANGES — Vault Backup Coverage Expansion: Mailbox Deliverability &amp; Reputation (Feature 15w)

**The ask:** "Vault backup system extend koro" — find the next real data
domain not yet in the backup and add it, the same way rounds 15d through
15v each did (mailbox, projects/tasks, finance, wallet hub, activity,
entity coverage, emergency access, account extras, team/earning, the
backup system's own configuration, connected mail accounts).

## Finding the actual gap

Audited every table created across `migrations/*.sql` against what
`buildVaultSnapshotPayload()` / `vault-snapshot-extra.ts` already gather,
to avoid re-covering ground the app already covers under a different name:

- **Already covered**: everything under `ayzen_mailbox_folders` /
  `_messages` / `_labels` / `_message_labels` / `_rules` / `_templates` /
  `_attachments` / `ayzen_contacts` (Feature 15d, native mailbox content
  itself); `email_accounts` (Feature 15u, external IMAP/SMTP connections).
- **Deliberately excluded elsewhere already**, same class as the
  cloud-connection OAuth tokens and `webhook_secret` `gatherBackupSystemSnapshot`
  excludes: `otp_codes`, `encryption_keys`.
- **The actual gap:** the moderation/deliverability layer sitting on top
  of the native mailbox — `ayzen_mailbox_sender_reputation` (the Block/
  Allow list behind `GET /mailbox/senders?status=blocked|allowed`),
  `ayzen_mailbox_recipient_reputation` (outbound addresses this user's own
  sends have auto-flagged or blocked, gating `POST /send`), and
  `ayzen_mailbox_sending_health` (this account's own rolling bounce/
  complaint rate and healthy/warning/paused status). A disaster-recovery
  restore that rebuilds every message but loses your block list and makes
  you re-trip every bounce flag from a clean slate isn't full coverage.

**Also considered and left out**, same "transient worker state / platform-
wide admin config" reasoning used for `otp_codes` and the cloud OAuth
tokens above:

- `ayzen_mailbox_send_queue` — a durable outbox for messages already
  captured under `mailboxMessages`; the row itself (`status`, `attempts`,
  `locked_by`) is mid-flight worker state with no lasting value once a
  send has settled.
- `ayzen_mailbox_sending_config` — a **singleton** row (`id` always `1`)
  of admin-tunable platform thresholds, not scoped to any one user at all.

## The fix — `gatherMailboxReputationSnapshot()`

New function in `lib/vault-snapshot-extra.ts`, following the exact
`rows(db.execute(sql\`...\`))` pattern every other gather function in the
file uses. Scoped to `user_id = userId` across all three tables.
`sendingHealth` is a single row per user (or `null` if none exists yet),
unlike the other two which are arrays.

**Nested under `mailboxReputation`, not auto-restored** — same treatment
as `backupSystem`/`team`/`accountExtras` elsewhere in this file:

- `senderReputation` / `recipientReputation` are live, user-curated
  moderation decisions keyed on `(user_id, lower(email))`. Blindly
  re-inserting a stale `status = 'blocked'` row on restore could
  re-block or re-flag an address the user has since deliberately
  unblocked from Settings — a decision that should stay a decision, not
  get silently overwritten by an old backup.
- `sendingHealth` is fully derived/computed from live sends (never
  something a user edits directly), so it's backed up for reference the
  same way `gatherActivitySnapshot`'s audit trails are — restoring it
  would just be immediately recomputed anyway, so there's nothing to
  restore.

No fields required stripping or decryption here: none of the three
tables hold anything field-encrypted or secret — `sender_reputation`/
`recipient_reputation`/`sending_health` are all plain moderation state
and counters, not credentials.

## Wiring

Same shape every prior round used — a new `*_count` column, threaded
through the full pipeline:

- **`migrations/076_ayzen_vault_backup_mailbox_reputation.sql`** — adds
  `mailbox_reputation_count` to `vault_snapshots`.
- **`lib/db/src/schema/vault-snapshots.ts`** — new
  `mailboxReputationCount` column + doc comment.
- **`lib/vault-snapshot-extra.ts`** — new `gatherMailboxReputationSnapshot()`.
- **`routes/vault-snapshot.ts`** — wired into
  `buildVaultSnapshotPayload()`'s `Promise.all`, the returned snapshot
  object (`mailboxReputation: { senderReputation, recipientReputation,
  sendingHealth }`), the count computation
  (`senderReputation.length + recipientReputation.length +
  (sendingHealth ? 1 : 0)`), `StoreSnapshotRowInput`, `storeSnapshotRow`'s
  insert, the manual export route's call/store/activity-log, and the
  `GET /vault/snapshots` list select. Payload `version` stays at `9` —
  this addition is reference-only, not auto-restored, so it doesn't
  change what a restore does with an older blob.
- **`lib/vault-backup-schedule-cron.ts`** — wired into the scheduled-
  backup path (`runVaultBackupSchedule`) the same way every other count
  already is.
- **`artifacts/ayzen/src/lib/vault-snapshot-api.ts`** — new
  `mailboxReputationCount?: number` field on the stored-snapshot type,
  optional so pre-076 rows just omit it.
- **`artifacts/ayzen/src/pages/user/vault-snapshot.tsx`** — Stored
  Backups list gains a `+N mail reputation` badge (`ShieldCheck` icon),
  same row-of-badges pattern as `backupSystemCount`/`emailAccountsCount`
  right next to it.

**Touched:** `migrations/076_ayzen_vault_backup_mailbox_reputation.sql`,
`lib/db/src/schema/vault-snapshots.ts`,
`artifacts/api-server/src/lib/vault-snapshot-extra.ts`,
`artifacts/api-server/src/routes/vault-snapshot.ts`,
`artifacts/api-server/src/lib/vault-backup-schedule-cron.ts`,
`artifacts/ayzen/src/lib/vault-snapshot-api.ts`,
`artifacts/ayzen/src/pages/user/vault-snapshot.tsx`.
