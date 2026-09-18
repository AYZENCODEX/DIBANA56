/**
 * lib/vault-snapshot-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15 — Encrypted Full Vault Snapshot Export.
 * Feature 15b — Stored Vault Backups (list / re-download / rename / delete /
 * restore-by-id against the vault_snapshots table, see routes/vault-snapshot.ts).
 * Thin typed wrapper around customFetch for routes/vault-snapshot.ts.
 */
import { customFetch } from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api-base";

function vaultApiPath(path: string): string {
  return `${getApiBase()}/api${path}`;
}

export type RestoreTableKey = "vault" | "wallets" | "localAccounts" | "kycEntries" | "gameEntries";

export interface RestoreTableDiff {
  table: RestoreTableKey;
  label: string;
  totalInSnapshot: number;
  toAdd: number;
  alreadyPresent: number;
  /** Non-sensitive display labels only — never credentials. */
  sample: string[];
}

export interface RestorePreview {
  exportedAt: string | null;
  tables: RestoreTableDiff[];
  totalToAdd: number;
}

export interface SnapshotRestoreResult {
  restored: number;
  skipped: number;
  errors: { table: RestoreTableKey; index: number; reason: string }[];
  byTable: Record<RestoreTableKey, { restored: number }>;
}

export interface StoredSnapshot {
  id: number;
  label: string | null;
  sizeBytes: number;
  includesAttachments: boolean;
  entriesCount: number;
  walletsCount: number;
  // Feature 15m — denormalized row count for the Account & Platform Extras
  // surface (notifications, referrals, subscription, support, API keys,
  // passkeys, Polymarket trades) bundled into every backup. Optional so
  // older stored-backup rows (from before migration 064) just omit it.
  accountExtrasCount?: number;
  // Feature 15n — denormalized row counts for the Team (owned teams,
  // memberships, join requests, favorites, messages/announcements/missions
  // this user created, both team activity logs) and Earning (this user's
  // own pay-per-click earn links) surfaces bundled into every backup.
  // Optional so older stored-backup rows (from before migration 065) just
  // omit them.
  teamCount?: number;
  earningCount?: number;
  // Feature 15t — denormalized row count for the Backup System self-coverage
  // surface (schedule config, connected cloud accounts, delivery/audit
  // history, Vault security posture summary, authored project templates)
  // bundled into every backup. Optional so older stored-backup rows (from
  // before migration 074) just omit it.
  backupSystemCount?: number;
  // Feature 15u — denormalized row count for connected external mail
  // accounts (IMAP/SMTP, personal + any team mailbox this user configured)
  // bundled into every backup. Optional so older stored-backup rows (from
  // before migration 075) just omit it.
  emailAccountsCount?: number;
  // Feature 15w — denormalized row count for Mailbox Deliverability &
  // Reputation (sender Block/Allow list, flagged/blocked outbound
  // recipients, this account's own sending-health status) bundled into
  // every backup. Optional so older stored-backup rows (from before
  // migration 076) just omit it.
  mailboxReputationCount?: number;
  // Feature 15x — denormalized row count for the External Mail Sync Cache
  // (synced header/body cache for connected external IMAP/SMTP mailboxes)
  // bundled into every backup. Optional so older stored-backup rows (from
  // before migration 077) just omit it.
  externalMailCount?: number;
  source?: "manual" | "scheduled";
  encryptionMode?: "password" | "envelope";
  createdAt: string;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Builds a fresh encrypted (.ayzenbak) backup of the whole vault. The
 * backend both stores this as a new row in vault_snapshots AND streams it
 * back here, which we then trigger as a browser download too — so the
 * backup is kept in the vault's own backup store, not just wherever the
 * downloaded file happens to end up.
 */
export async function exportVaultSnapshot(password: string, includeAttachments = false, label?: string): Promise<void> {
  const blob = await customFetch<Blob>(vaultApiPath("/vault/snapshot/export"), {
    method: "POST",
    body: JSON.stringify({ password, includeAttachments, label }),
    responseType: "blob",
  });
  triggerBlobDownload(blob, `ayzen-vault-snapshot-${Date.now()}.ayzenbak`);
}

/** Reads a .ayzenbak File into text, for feeding into restoreVaultSnapshot(). */
export function snapshotFileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

/**
 * Dry-run: decrypts an uploaded .ayzenbak blob and reports, per table, how
 * many rows would be added vs. already present — writes nothing. Call this
 * before restoreVaultSnapshot() so the user can confirm what's about to
 * change.
 */
export function previewVaultSnapshotRestore(password: string, blob: string): Promise<RestorePreview> {
  return customFetch(vaultApiPath("/vault/snapshot/restore-preview"), {
    method: "POST",
    body: JSON.stringify({ password, blob }),
  });
}

/** Same dry-run as previewVaultSnapshotRestore(), against a stored backup by id. */
export function previewStoredVaultSnapshotRestore(password: string, snapshotId: number): Promise<RestorePreview> {
  return customFetch(vaultApiPath("/vault/snapshot/restore-preview"), {
    method: "POST",
    body: JSON.stringify({ password, snapshotId }),
  });
}

/**
 * Restores from a raw .ayzenbak blob string (e.g. read from an uploaded
 * file). Merge restore: only rows missing from the vault are added, across
 * every table the backup contains — safe to call more than once.
 */
export function restoreVaultSnapshot(password: string, blob: string): Promise<SnapshotRestoreResult> {
  return customFetch(vaultApiPath("/vault/snapshot/restore"), {
    method: "POST",
    body: JSON.stringify({ password, blob }),
  });
}

/** Restores directly from a backup already stored in the vault — no file needed. */
export function restoreStoredVaultSnapshot(password: string, snapshotId: number): Promise<SnapshotRestoreResult> {
  return customFetch(vaultApiPath("/vault/snapshot/restore"), {
    method: "POST",
    body: JSON.stringify({ password, snapshotId }),
  });
}

/** Lists every backup currently stored in the vault, newest first. */
export function listVaultSnapshots(): Promise<{ snapshots: StoredSnapshot[]; max: number }> {
  return customFetch(vaultApiPath("/vault/snapshots"));
}

/** Re-downloads a previously stored backup's exact file — no password needed to download. */
export async function downloadStoredSnapshot(id: number, createdAt: string): Promise<void> {
  const blob = await customFetch<Blob>(vaultApiPath(`/vault/snapshots/${id}/download`), { responseType: "blob" });
  triggerBlobDownload(blob, `ayzen-vault-snapshot-${new Date(createdAt).getTime()}.ayzenbak`);
}

/** Renames a stored backup (pass an empty string to clear the label). */
export function renameVaultSnapshot(id: number, label: string): Promise<{ ok: boolean }> {
  return customFetch(vaultApiPath(`/vault/snapshots/${id}`), {
    method: "PATCH",
    body: JSON.stringify({ label }),
  });
}

/** Permanently deletes a stored backup from the vault. */
export function deleteVaultSnapshot(id: number): Promise<{ ok: boolean }> {
  return customFetch(vaultApiPath(`/vault/snapshots/${id}`), { method: "DELETE" });
}

/**
 * Feature 15c — Automatic Vault Backups.
 * Thin typed wrapper around customFetch for routes/vault-backup-schedule.ts.
 */
export interface VaultBackupSchedule {
  enabled: boolean;
  frequency: "daily" | "weekly" | "monthly";
  dayOfWeek: number;
  dayOfMonth: number;
  hourOfDay: number;
  includeAttachments: boolean;
  destination: "store" | "email" | "webhook" | "google_drive" | "dropbox";
  destinationEmail: string | null;
  webhookUrl: string | null;
  hasWebhookSecret?: boolean;
  lastRunAt: string | null;
  lastRunStatus: "success" | "failed" | "missed" | null;
  lastRunError: string | null;
  nextRunAt: string | null;
}

export interface VaultBackupDeliveryRow {
  id: number;
  snapshotId: number;
  destination: "email" | "webhook" | "google_drive" | "dropbox";
  target: string | null;
  status: "success" | "failed";
  error: string | null;
  createdAt: string;
}

/** Feature 15l — Google Drive / Dropbox connection status, for the Automatic Backups card. */
export type CloudProvider = "google_drive" | "dropbox";
export interface CloudConnectionStatus {
  provider: CloudProvider;
  connected: boolean;
  accountLabel: string | null;
  configured: boolean;
}

/** Gets the caller's automatic backup schedule, or defaults (enabled: false) if never configured. */
export function getVaultBackupSchedule(): Promise<VaultBackupSchedule> {
  return customFetch(vaultApiPath("/vault/backup/schedule"));
}

/** Saves (creates or updates) the caller's automatic backup schedule. */
export function saveVaultBackupSchedule(schedule: Partial<VaultBackupSchedule>): Promise<{ ok: boolean; nextRunAt: string | null }> {
  return customFetch(vaultApiPath("/vault/backup/schedule"), {
    method: "PUT",
    body: JSON.stringify(schedule),
  });
}

/** Runs the caller's saved schedule immediately — handy for testing a destination before trusting it to the timer. */
export function runVaultBackupScheduleNow(): Promise<{ ok: boolean; snapshotId?: number; error?: string }> {
  return customFetch(vaultApiPath("/vault/backup/schedule/run-now"), { method: "POST" });
}

/** Recent off-vault delivery attempts (email/webhook/cloud), newest first. */
export function listVaultBackupDeliveries(): Promise<{ deliveries: VaultBackupDeliveryRow[] }> {
  return customFetch(vaultApiPath("/vault/backup/deliveries"));
}

/** Feature 15l — Google Drive / Dropbox connection status for every provider. */
export function listCloudConnections(): Promise<{ connections: CloudConnectionStatus[] }> {
  return customFetch(vaultApiPath("/vault/backup/cloud"));
}

/**
 * Gets the OAuth consent-screen URL for a provider and navigates the
 * browser there. A plain server-side redirect can't be used here — this
 * app authenticates via a bearer header, which a page navigation can't
 * carry (see routes/vault-backup-cloud.ts's file header) — so the URL is
 * fetched authenticated first, then navigated to.
 */
export async function connectCloudProvider(provider: CloudProvider): Promise<void> {
  const { url } = await customFetch<{ url: string }>(vaultApiPath(`/vault/backup/cloud/${provider}/connect`));
  window.location.href = url;
}

/** Disconnects a Google Drive/Dropbox connection — any schedule still pointed at it will start failing until repointed. */
export function disconnectCloudProvider(provider: CloudProvider): Promise<{ ok: boolean }> {
  return customFetch(vaultApiPath(`/vault/backup/cloud/${provider}`), { method: "DELETE" });
}
