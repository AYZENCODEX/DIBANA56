# Vault Backup — actually stored in the vault (Feature 15b)

## The problem
`/vault/snapshot` (Feature 15) could build a password-encrypted, full-vault
backup — but it only ever streamed that blob straight to the browser as a
download. Nothing was kept server-side:
- No record of what backups had ever been made.
- Lose the downloaded `.ayzenbak` file and the backup was gone.
- The Backup Code page (`/vault/backup`) is a *different* feature entirely
  (per-account 2FA backup codes) — easy to confuse with "the backup page"
  since both use the word "backup", but neither one was an actual backup
  *store*.

## What changed
1. **New table: `vault_snapshots`** (`lib/db/src/schema/vault-snapshots.ts`,
   migration `055_ayzen_vault_snapshots.sql`) — stores the encrypted blob
   plus metadata (label, size, entries/wallets counts, whether attachments
   were included, created date) for every backup a user makes.

2. **`POST /vault/snapshot/export`** now inserts a row into `vault_snapshots`
   in addition to streaming the download it already did. The most recent
   `MAX_STORED_SNAPSHOTS` (20) per user are kept — older ones are pruned
   automatically on every new export.

3. **New routes** (`artifacts/api-server/src/routes/vault-snapshot.ts`):
   - `GET /vault/snapshots` — list stored backups (metadata only).
   - `GET /vault/snapshots/:id/download` — re-download a stored backup's
     exact file, no password needed to download (only to decrypt/restore).
   - `PATCH /vault/snapshots/:id` — rename a stored backup.
   - `DELETE /vault/snapshots/:id` — permanently remove one.
   - `POST /vault/snapshot/restore` now also accepts `{ password, snapshotId }`
     to restore directly from a stored backup, no re-upload needed.

4. **Frontend** (`artifacts/ayzen/src/pages/user/vault-snapshot.tsx` +
   `lib/vault-snapshot-api.ts`): the Snapshot Backup page now has a
   **Stored Backups** list on top — each row shows name/date/size/counts,
   with inline rename, download, restore (password-prompt dialog), and
   delete (confirm dialog). "Create a Backup" and "Restore From a File"
   keep working exactly as before, just relabeled for clarity.

## Sidebar
No new sidebar section was needed — `Vault → Other → Data & Recovery →
Snapshot Backup` (`components/layout/vault-sidebar.tsx`) already existed and
now points at the upgraded page. Backup Code (2FA codes) stays a separate,
unrelated item under `Vault → Access`.

## Not touched
- `routes/vault-migration.ts` (`GET /vault/export`) — the unencrypted
  CSV/JSON portability export — is unrelated and untouched.
- Restoring still only recreates Vault entities as new rows (never
  overwrites), same as before.
