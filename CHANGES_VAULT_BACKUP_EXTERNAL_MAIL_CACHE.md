# CHANGES — Vault Backup Coverage Expansion: External Mail Sync Cache (Feature 15x)

**The ask:** "Aro extand kro" — continue the same coverage-expansion game:
audit the schema for the next real gap and add it.

## Finding the actual gap

Round 15w closed the mailbox moderation layer. Re-auditing every table
created across `migrations/*.sql` against what's now gathered turned up
one it missed: **`mail_messages`**
(`migrations/037_mail_messages_table.sql`) — the local sync cache for a
user's connected external IMAP/SMTP mailboxes, written by
`lib/mail-sync.ts` (header sync) and `routes/email-accounts.ts`'s
fetch-body handler (lazy body cache, `encryptField`'d at rest same as
every other cached mail body in this app).

**Why it was missed before:** Feature 15u (`gatherEmailAccountsSnapshot`)
backs up *which* external mailboxes a user connected — host, port,
credentials. It's easy to read that as "external mail: covered" and
stop there, but `email_accounts` and `mail_messages` are two different
tables: one is the connection, the other is the synced content sitting
behind it. A restore that reconnects your Gmail but shows an empty inbox
until the next sync isn't full coverage of what the Email Manager page
was actually showing.

**Also re-confirmed still correctly excluded** (no change from prior
rounds): `dr_test_reports` (platform-wide DR evidence, admin-only),
`resend_webhook_events` / `project_pnl_receipts` (already reference-only
under their respective existing gather functions), `otp_codes` /
`encryption_keys` (live secrets, same reasoning as every prior round).

## The fix — `gatherExternalMailSnapshot()`

New function in `lib/vault-snapshot-extra.ts`. Scoped to
`user_id = userId` — `mail_messages` carries `user_id` directly (unlike
`ayzen_mailbox_attachments`, which needs a join through its parent
message). `body_text` is decrypted the same way native mailbox message
bodies already are in `gatherMailboxSnapshot`, wrapped in the same
try/catch-and-fall-back-to-raw pattern for rows that predate encryption
or fail to decrypt for any reason.

**Nested under `externalMail`, not auto-restored** — a different
reasoning than any prior nested/non-restored block, worth calling out
explicitly: this table isn't AYZEN's own data at all, it's a **cache**
of a system of record that lives entirely outside the app (the user's
actual Gmail/Outlook/IMAP server). Two consequences:

- Re-inserting stale cached rows on restore could resurrect message
  content the user has since deleted at the source — a cache going
  stale is normal; silently replaying a stale cache is not.
- The correct recovery action isn't "restore" at all, it's
  `POST /email-accounts/:id/sync` — re-syncing rebuilds this table from
  the live mailbox, which is strictly more correct than anything an old
  backup blob could offer.

Still included in every backup (same as finance/profile/activity/
mailboxReputation) so a full manual/disaster-recovery read of the raw
JSON is always possible even without IMAP access at recovery time.

## Wiring

Same shape as every prior round:

- **`migrations/077_ayzen_vault_backup_external_mail_cache.sql`** — adds
  `external_mail_count` to `vault_snapshots`.
- **`lib/db/src/schema/vault-snapshots.ts`** — new `externalMailCount`
  column + doc comment.
- **`lib/vault-snapshot-extra.ts`** — new `gatherExternalMailSnapshot()`.
- **`routes/vault-snapshot.ts`** — wired into
  `buildVaultSnapshotPayload()`'s `Promise.all`, the returned snapshot
  object (`externalMail: { messages }`), the count computation
  (`messages.length`), `StoreSnapshotRowInput`, `storeSnapshotRow`'s
  insert, the manual export route's call/store/activity-log, and the
  `GET /vault/snapshots` list select.
- **`lib/vault-backup-schedule-cron.ts`** — wired into the scheduled-
  backup path the same way every other count already is.
- **`artifacts/ayzen/src/lib/vault-snapshot-api.ts`** — new
  `externalMailCount?: number` field, optional so pre-077 rows omit it.
- **`artifacts/ayzen/src/pages/user/vault-snapshot.tsx`** — Stored
  Backups list gains a `+N synced mail` badge (`Inbox` icon), next to
  the 15w mail-reputation badge.

Payload `version` stays unchanged — this addition is reference-only, not
auto-restored, so it doesn't change what a restore does with an older
blob.

**Touched:** `migrations/077_ayzen_vault_backup_external_mail_cache.sql`,
`lib/db/src/schema/vault-snapshots.ts`,
`artifacts/api-server/src/lib/vault-snapshot-extra.ts`,
`artifacts/api-server/src/routes/vault-snapshot.ts`,
`artifacts/api-server/src/lib/vault-backup-schedule-cron.ts`,
`artifacts/ayzen/src/lib/vault-snapshot-api.ts`,
`artifacts/ayzen/src/pages/user/vault-snapshot.tsx`.
