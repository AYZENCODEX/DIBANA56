# CHANGES — Vault Backup: Connected Mail Accounts Now Auto-Restored (Feature 15v)

**The ask:** "extend more" — continuing straight on from Feature 15u
(CHANGES_VAULT_BACKUP_EMAIL_ACCOUNTS.md), which added `email_accounts` to
the backup payload but left it reference-only, same treatment as
`finance`/`profile`/`backupSystem`/`team`.

## Why this domain, not another new one

I re-audited every schema file the way I did for 15u — every real per-user
domain is now in the backup. There's no more ground to cover in the "add a
missing data domain" direction. The next honest way to "extend more" is the
second direction I originally offered: **restore support**, since most
domains bundled into this backup (finance, profile, activity, entity
coverage, emergency access, account extras, team, earning, backup system,
and — until now — email accounts) are still reference-only, not
auto-restored.

Of those, `emailAccounts` is the one that can actually be made restorable
safely: unlike `finance` (cross-table balance integrity), `walletHub`'s
transfers/credits (two-party money movements), or `entityCoverage`'s shares
(two-party data), an `email_accounts` row is single-owner configuration
with no un-remappable foreign key into another entity — the same shape
`mailboxContacts`/`mailboxRules` already restore successfully.

## The fix

**`vault-snapshot-extra.ts`:**
- New `reencryptEmailAccountForRestore()` — re-encrypts `password`/
  `auth_key` on insert, same convention as `reencryptMailboxTemplateForRestore`/
  `reencryptDataEntityForRestore`.
- The `emailAccounts` payload key (`routes/vault-snapshot.ts`) is now a
  flat top-level array (`emailAccounts.accounts` → `emailAccounts`), same
  shape `mailboxFolders`/`mailboxContacts` already use, so the merge-restore
  mechanism can address it directly.

**`vault-snapshot-restore.ts`:**
- `RestoreTableKey` gains `"emailAccounts"`.
- `RESTORE_TABLE_SQL_NAMES["emailAccounts"] = "email_accounts"` — this also
  means the DR Evidence Collector's Phase 2 verification suite
  (`dr-test-runner.ts`) picks the new table up automatically with **zero**
  code changes there, since it iterates `Object.keys(RESTORE_TABLE_SQL_NAMES)`
  generically.
- New dedicated insert path (`emailAccountKey` / `existingEmailAccountKeys` /
  `insertEmailAccountRow`, mirroring the `kycDataEntities` block right above
  it), wired into both `buildRestoreDiff()` (preview) and
  `applyRestoreDiff()` (merge).
- Identity key: `email_address + protocol` per user — never `password`/
  `auth_key`, same never-key-off-an-encrypted-column rule every other
  re-encrypting insert path here already follows.
- **`team_id` is deliberately dropped on insert** — every restored row
  lands as a personal account (`teamId` null), never re-attached to a team
  automatically. Re-inserting straight into a team context would grant that
  team's *current* active members visibility into a decrypted credential
  the backup owner captured for their own disaster recovery, not for
  redistribution — a cross-person side effect none of this app's other
  restorable tables have, so it gets dropped rather than copied, the same
  way `mailboxRules` drops `action_label_id`/`action_folder_id` rather than
  risk pointing at the wrong target.
- **`is_default` is deliberately dropped and hardcoded `false`** — a raw
  insert bypasses `routes/email-accounts.ts`'s own "only one default at a
  time" application logic, so a restored row could otherwise silently
  create two rows both flagged default, or displace whichever one the
  account is actually configured to use today.

**Payload:** `version` bumped 8 → 9 (informational only — nothing branches
on it).

**Touched:** `artifacts/api-server/src/lib/vault-snapshot-extra.ts`,
`artifacts/api-server/src/lib/vault-snapshot-restore.ts`,
`artifacts/api-server/src/routes/vault-snapshot.ts`.

No migration needed — this changes restore *behavior* only, not the
`vault_snapshots` table shape (migration 075 already added
`email_accounts_count` in the prior round).
