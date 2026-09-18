# CHANGES — Feature 15i: Vault Backup Coverage Expansion — Linked Entities

Closes the one remaining real gap from a coverage review against the Vault
Backup blob: the **Linked Entities graph** (`vault_entity_links` — "this
entity is an alt of X" / "shares a wallet with Y", powering the "Linked
Entities" section + graph view on `vault-entity-detail.tsx`) was not part of
the backup at all.

## What changed

**Backend**
- `lib/vault-snapshot-extra.ts` — `gatherEntityCoverageSnapshot()` now also
  queries `vault_entity_links WHERE user_id = ...` and returns it as
  `entityLinks`. Same `.catch(() => [])` degrade-to-empty pattern as every
  other query in this file.
- `routes/vault-snapshot.ts` — `entityLinks` added to the nested
  `entityCoverage` object (same treatment as `categoryReceipts` /
  `valueHistory` / `sharesOwned` / `sharesReceived`: included in every
  backup, counted in `entityCoverageCount`, **not** auto-restored — see "Why
  not auto-restored" below). Snapshot `version` bumped to `4`.

No migration, no new column, no restore-path changes — `entityLinks` rides
inside the already-existing `entityCoverage` object and
`entityCoverageCount` column from Feature 15h.

## Why not auto-restored

Same limitation as `valueHistory`: `entityId` / `linkedEntityId` both point
at a specific `vault_entries` row id, and a merge-restore gives a restored
Vault Entity a brand-new id. There's no id-remapping table yet to rewrite a
link onto the entity that gets recreated for it. Included in every backup so
a full disaster recovery is always possible by hand from the raw JSON.

## Reviewed and confirmed already covered (no change needed)

Checked against the rest of the requested scope — all already covered by
existing features, nothing further to add:
- **Vault Entity attachments** — `vault_attachments`, gathered directly in
  `buildVaultSnapshotPayload()` (Feature 15).
- **Local Account credentials / receipts** — base row gathered directly
  (`local_accounts`); receipts via `vault_category_receipts`, which already
  spans Local Accounts + Vault Entities (Feature 15h).
- **Activity records** — `user_activity` + `vault_activity_log` +
  `vault_field_history`, all in `gatherActivitySnapshot()` (Feature 15f).
- **Health / P&L** — `value_history` (Feature 15h); the health-scan flag
  columns (`last_health_alert_at`/`last_health_flags`) ride on the base
  entity rows, already covered.
- **Project history** — `entity_project_roi` + `project_enrollments` +
  `project_ratings` in `gatherProjectsSnapshot()` (Feature 15d).
  (`project_dates` is per-*project* calendar data, not per-user — same
  "platform-wide catalog" exclusion as the projects catalog itself.)
- **KYC Entity full coverage** — `kyc_entries` (base row, direct) +
  `kyc_data_entities` via `data_entity_id` (Feature 15h). No other KYC child
  tables exist in the codebase.

## Not possible as a backup item

- **Game Entity attachments** — there is no attachment mechanism for Game
  Entities anywhere in the codebase; `vault_attachments` is hard-scoped to
  `vault_entry_id` (Vault Entities only — see `routes/vault-attachments.ts`).
  Nothing exists yet to back up. Building attachment support for Game
  Entities would be a new feature (schema + migration + routes + frontend),
  not a backup-coverage fix — flag separately if wanted.
