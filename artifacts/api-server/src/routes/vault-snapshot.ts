/**
 * routes/vault-snapshot.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15 — Encrypted Full Vault Snapshot Export.
 * Feature 15b — Stored Vault Backups (server-side backup store).
 * Feature 15c — Automatic Vault Backups + Restore Preview/Merge.
 *
 * One-click download of the caller's ENTIRE vault (Vault entities, Local
 * accounts, KYC entities, Game entities, Wallets, and — optionally, since
 * it can be large — Attachments) as a single AES-256-GCM-encrypted blob,
 * protected by a password the user chooses at export time (never the
 * account password, never stored anywhere — same "prove you have it, we
 * never keep it" principle as every other Vault credential in this app).
 *
 * This is different from Feature 13's GET /vault/export
 * (routes/vault-migration.ts): that one produces a portable, UNencrypted
 * CSV/JSON of Vault entities only, meant for moving data between tools.
 * This one is a full-fidelity, encrypted disaster-recovery backup of every
 * table this app stores secrets in.
 *
 * Feature 15b: every export used to only stream the blob to the browser —
 * nothing was kept anywhere, so a lost download meant a lost backup and
 * there was never a way to see what backups existed. Every export now ALSO
 * writes a row to vault_snapshots (lib/db/src/schema/vault-snapshots.ts), so
 * backups are actually stored *in the vault* and can be listed, re-downloaded,
 * restored from, renamed, or deleted from the Snapshot Backup page — the
 * browser download still happens too, for anyone who wants an offline copy.
 * The most recent MAX_STORED_SNAPSHOTS per user are kept; older ones are
 * pruned automatically on each new export.
 *
 * Feature 15c: the payload-building + storage logic below
 * (buildVaultSnapshotPayload / storeSnapshotRow) is factored out of the POST
 * /vault/snapshot/export handler so lib/vault-backup-schedule-cron.ts can
 * build and store the exact same snapshot shape on a timer, just encrypted
 * under the server-managed envelope key (lib/vault-backup-envelope.ts)
 * instead of a user-typed password. `source` ("manual" | "scheduled") and
 * `encryptionMode` ("password" | "envelope") on vault_snapshots record which
 * path produced a given row, and `checksum` (sha256 of the stored blob) lets
 * a corruption check confirm a stored/delivered copy matches what was
 * originally written.
 *
 * Key derivation (manual/password mode): scrypt(password, salt, 32) — same
 * primitive already used for wallet seed-phrase encryption elsewhere in this
 * codebase (routes/vault.ts's SEED_KEY), just with a random per-export salt
 * instead of a fixed one, since here the "key" is a user-chosen password
 * rather than a server secret.
 *
 * Blob format (all fields base64, colon-joined):
 *   AYZENBAK1:<salt>:<iv>:<authTag>:<ciphertext>   (password mode, legacy —
 *                                                    scrypt at Node's default
 *                                                    cost; decrypt-only, kept
 *                                                    so old exports still
 *                                                    restore)
 *   AYZENBAK2:<salt>:<iv>:<authTag>:<ciphertext>   (password mode, current —
 *                                                    scrypt at a hardened
 *                                                    cost, see SCRYPT_V2_COST)
 *   ENV1:<version>:<iv>:<authTag>:<ciphertext>     (envelope mode — see
 *                                                    lib/vault-backup-envelope.ts)
 *
 * Storing the blob server-side adds no new secret exposure: it's already
 * AES-256-GCM ciphertext under a secret AYZEN doesn't keep in the clear
 * (a password it never sees again, or an envelope key wrapped under
 * VAULT_MASTER_KEY), so a vault_snapshots row is exactly as unreadable as a
 * downloaded .ayzenbak file would be.
 */
import { Router, type Request, type Response } from "express";
import express from "express";
import crypto from "crypto";
import {
  db, vaultEntriesTable, walletsTable, vaultAttachmentsTable, vaultSnapshotsTable,
} from "@workspace/db";
import { and, eq, sql, desc, isNull, isNotNull } from "drizzle-orm";
import { requireAuth, getRequestUserId, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { decryptField } from "../lib/vault-crypto";
import { decryptPhrase } from "../lib/wallet-crypto";
import { SENSITIVE_VAULT_FIELDS } from "./vault";
import { logActivity } from "../lib/activity";
import { buildRestoreDiff, applyRestoreDiff } from "../lib/vault-snapshot-restore";
import { VAULT_SNAPSHOT_TRASH_RETENTION_DAYS } from "../lib/vault-snapshot-trash-purge";
import { logBackupAudit, isAnomalousBackupIp } from "../lib/vault-backup-audit";
import { alertOwnerOfAnomalousBackupAccess } from "../lib/vault-backup-alerts";
import { getClientIp } from "../lib/login-security";
import {
  gatherMailboxSnapshot, gatherProjectsSnapshot, gatherTasksSnapshot,
  gatherFinanceSnapshot, gatherUserProfileSnapshot, gatherWalletHubSnapshot,
  gatherActivitySnapshot, gatherEntityCoverageSnapshot, gatherEmergencyAccessSnapshot,
  gatherAccountExtrasSnapshot, gatherTeamSnapshot, gatherEarningSnapshot,
  gatherBackupSystemSnapshot, gatherEmailAccountsSnapshot, gatherMailboxReputationSnapshot, gatherExternalMailSnapshot,
} from "../lib/vault-snapshot-extra";

const router = Router();

// v1 (legacy, read-only): scrypt at Node's default cost (N=16384, r=8, p=1).
// v2 (current): scrypt at a much higher cost, matching current OWASP
// guidance for password-derived encryption keys — an offline attacker who
// steals a .ayzenbak file or a vault_snapshots row now has to spend ~8x the
// memory-hard work per password guess than under v1. The cost parameters
// aren't recoverable from the blob itself (scryptSync needs them to match
// exactly), so this is versioned by prefix rather than silently swapped:
// old "AYZENBAK1" backups keep decrypting at the v1 cost forever, every new
// export is written as "AYZENBAK2" at the v2 cost. There's no in-place
// upgrade path for existing exported files (nothing server-side to touch —
// they're already out in users' downloads folders / cloud storage); anyone
// wanting the stronger KDF on an old backup just re-exports.
const BLOB_PREFIX_V1 = "AYZENBAK1";
const BLOB_PREFIX_V2 = "AYZENBAK2";
const MIN_SNAPSHOT_PASSWORD_LENGTH = 10;
const SCRYPT_KEYLEN = 32;
const SCRYPT_V2_COST = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const; // N=131072
// How many stored backups to keep per user — oldest beyond this are pruned
// automatically whenever a new one is created, so the store can't grow
// unbounded for someone who exports frequently.
const MAX_STORED_SNAPSHOTS = 20;

// Per-user total stored-backup size cap — the "storage unit" for Sylo backups.
// MAX_STORED_SNAPSHOTS alone bounds the *count*, but blobs vary wildly in
// size (attachments included or not, mailbox/finance/wallet-hub volume for
// power users), so 20 large snapshots could still balloon Supabase storage
// unchecked. This bounds the *bytes*: pruneOldSnapshots() below prunes
// oldest-first past this quota, on top of (not instead of) the count prune.
// Overridable per deployment since Supabase storage budgets differ.
const DEFAULT_STORAGE_QUOTA_BYTES = 200 * 1024 * 1024; // 200 MB / user

// Route Integration Roadmap — Season E, Phase E6: new resource builder.
// `vault_snapshots` has one owner column (`user_id`) — same plain
// single-owner shape as every other `*Resource` in this series. Every
// route below already scoped its own query by `eq(vaultSnapshotsTable.id,
// id), eq(vaultSnapshotsTable.userId, userId)` (or the trash-purge
// variant with an extra `isNotNull(deletedAt)`), just never through PEP.
//
// The builder itself deliberately does NOT filter on `deletedAt` — it
// only resolves "who owns this row" (Guide's Step 2: "exactly one DB
// read... resolves one fact"), regardless of trashed state. The
// trashed-vs-live distinction stays exactly where it already lived, in
// each handler's own more specific query (download/PATCH/DELETE require
// `deletedAt IS NULL`; restore/purge require `deletedAt IS NOT NULL`) —
// same "PEP additive, handler's own logic untouched" posture this whole
// series uses. A caller who owns a snapshot but hits the wrong trashed
// state still gets exactly the same pre-existing 404 as before, just from
// the handler's own query instead of the gate.
//
// Two of the five pre-existing handlers (download, PATCH, DELETE, restore,
// purge) had their own `Number.isFinite(id)` check ahead of any DB call,
// replying `400 { error: "Invalid snapshot id" }` for a non-numeric id —
// a different body from the "not found" 404. The plain sentinel-and-onDeny
// shape would collapse that into the same 404 as every other deny reason,
// changing behavior for that one case. Same fix as Phase C11's
// `requireAyzenMailboxMessageOwnershipStrictId`: a "strict id" wrapper
// whose own `onDeny` re-checks `Number.isFinite` and reproduces the exact
// prior split.
const VAULT_SNAPSHOT_OWNER_SENTINEL_NONE = -1;
const vaultSnapshotResource: ResourceRefBuilder = async (req) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "vault_snapshot", id: req.params.id, ownerId: VAULT_SNAPSHOT_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: vaultSnapshotsTable.userId })
    .from(vaultSnapshotsTable)
    .where(eq(vaultSnapshotsTable.id, id))
    .limit(1);
  return { type: "vault_snapshot", id, ownerId: row?.userId ?? VAULT_SNAPSHOT_OWNER_SENTINEL_NONE };
};
function requireVaultSnapshotOwnershipStrictId(action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, vaultSnapshotResource, {
    onDecision: pepDecisionObserver,
    onDeny: (req: Request, res: Response) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }
      res.status(404).json(notFoundBody);
    },
  });
}
const MAX_TOTAL_SNAPSHOT_BYTES = Number(process.env.VAULT_SNAPSHOT_STORAGE_QUOTA_BYTES) || DEFAULT_STORAGE_QUOTA_BYTES;

// Snapshots (and restoring them) can be several MB of JSON — scoped bump,
// same reasoning as vault-attachments.ts / vault-migration.ts.
const snapshotBodyParser = express.json({ limit: "25mb" });

function deriveKey(password: string, salt: Buffer, version: 1 | 2): Buffer {
  if (version === 1) return crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_V2_COST);
}

function encryptBlob(password: string, plaintext: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt, 2);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [BLOB_PREFIX_V2, salt.toString("base64"), iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

function decryptBlob(password: string, blob: string): string {
  const parts = blob.trim().split(":");
  const prefix = parts[0];
  if (parts.length !== 5 || (prefix !== BLOB_PREFIX_V1 && prefix !== BLOB_PREFIX_V2)) {
    throw new Error("Not a valid AYZEN vault snapshot file");
  }
  const version: 1 | 2 = prefix === BLOB_PREFIX_V2 ? 2 : 1;
  const [, saltB64, ivB64, tagB64, dataB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const key = deriveKey(password, salt, version);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Incorrect password, or the snapshot file is corrupted");
  }
}

function safeDecryptPhrase(encrypted: string): string | null {
  try { return decryptPhrase(encrypted); } catch { return null; }
}

/**
 * Recomputes a stored row's blob checksum and throws if it doesn't match
 * what was recorded at write time (storeSnapshotRow()) — the actual
 * integrity check the `checksum` column exists for, but which nothing
 * previously called. Rows written before the checksum column existed have
 * checksum = null and are treated as unverifiable rather than corrupted.
 */
export function verifyStoredChecksum(row: { blob: string; checksum: string | null }): void {
  if (!row.checksum) return;
  const actual = crypto.createHash("sha256").update(row.blob, "utf8").digest("hex");
  if (actual !== row.checksum) {
    throw new Error("Stored backup failed its integrity check (checksum mismatch) — the blob appears to be corrupted.");
  }
}

// Keeps only the MAX_STORED_SNAPSHOTS most recent stored backups for a user
// AND caps their combined size at MAX_TOTAL_SNAPSHOT_BYTES, trashing older
// rows first (by createdAt) until both limits are satisfied. Called after
// every new export (manual or scheduled — both flow through
// storeSnapshotRow()). Always keeps at least the single most recent
// snapshot, even if that one snapshot alone exceeds the byte quota — a user
// should never be left with zero backups because one export was large.
//
// Vault Backup hardening — Snapshot Delete Protection: this used to hard-
// DELETE the pruned rows outright. It now soft-deletes them (same as
// DELETE /vault/snapshots/:id below) so a snapshot pruned only because a
// user exported frequently stays recoverable for
// VAULT_SNAPSHOT_TRASH_RETENTION_DAYS instead of vanishing instantly — and
// only rows already in the trash count toward "oldest" here, since a
// soft-deleted row is no longer part of the active MAX_STORED_SNAPSHOTS/
// quota count.
async function pruneOldSnapshots(userId: number): Promise<void> {
  const rows = await db
    .select({ id: vaultSnapshotsTable.id, sizeBytes: vaultSnapshotsTable.sizeBytes })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)))
    .orderBy(desc(vaultSnapshotsTable.createdAt));

  const keep = new Set<number>();
  let runningBytes = 0;
  for (const row of rows) {
    const withinCount = keep.size < MAX_STORED_SNAPSHOTS;
    const withinQuota = runningBytes + row.sizeBytes <= MAX_TOTAL_SNAPSHOT_BYTES || keep.size === 0;
    if (!withinCount || !withinQuota) {
      // Rows are ordered newest -> oldest, so once either limit is hit,
      // every remaining row is older still and must not be kept — otherwise
      // a smaller, older row could slip in under the remaining quota and
      // create a "hole" (an older backup surviving while a newer one is
      // deleted). Stop here instead of continuing to scan.
      break;
    }
    keep.add(row.id);
    runningBytes += row.sizeBytes;
  }

  const toTrash = rows.map(r => r.id).filter(id => !keep.has(id));
  for (const id of toTrash) {
    await db.update(vaultSnapshotsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)));
  }
}

/**
 * Gathers and shapes every table this app stores secrets in, for a given
 * user, into the plaintext JSON that both the manual export button and
 * lib/vault-backup-schedule-cron.ts's scheduled sweep encrypt (under a
 * password or the server envelope key, respectively) and store. Sensitive
 * Vault fields and wallet seed phrases are decrypted here so the resulting
 * backup is immediately usable on restore without a second decryption pass
 * against this app's own field-level keys.
 */
export async function buildVaultSnapshotPayload(
  userId: number, includeAttachments: boolean,
): Promise<{
  json: string; vaultCount: number; walletsCount: number;
  mailboxCount: number; projectsCount: number; tasksCount: number; financeCount: number;
  walletHubCount: number; activityCount: number; entityCoverageCount: number; emergencyAccessCount: number;
  accountExtrasCount: number; teamCount: number; earningCount: number; backupSystemCount: number;
  emailAccountsCount: number; mailboxReputationCount: number; externalMailCount: number;
}> {
  const [vaultRows, localRows, kycRows, gameRows, walletRows, mailbox, projects, tasks, finance, profile, walletHub, activity, entityCoverage, emergencyAccess, accountExtras, team, earning, backupSystem, emailAccounts, mailboxReputation, externalMail] = await Promise.all([
    db.select().from(vaultEntriesTable).where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`)),
    db.execute(sql`SELECT * FROM local_accounts WHERE user_id = ${userId}`).then(r => r.rows).catch(() => []),
    db.execute(sql`SELECT * FROM kyc_entries WHERE user_id = ${userId}`).then(r => r.rows).catch(() => []),
    db.execute(sql`SELECT * FROM game_entries WHERE user_id = ${userId}`).then(r => r.rows).catch(() => []),
    db.select().from(walletsTable).where(eq(walletsTable.userId, userId)),
    gatherMailboxSnapshot(userId, includeAttachments),
    gatherProjectsSnapshot(userId),
    gatherTasksSnapshot(userId),
    gatherFinanceSnapshot(userId, includeAttachments),
    gatherUserProfileSnapshot(userId),
    gatherWalletHubSnapshot(userId),
    gatherActivitySnapshot(userId),
    gatherEntityCoverageSnapshot(userId),
    gatherEmergencyAccessSnapshot(userId),
    gatherAccountExtrasSnapshot(userId),
    gatherTeamSnapshot(userId),
    gatherEarningSnapshot(userId),
    gatherBackupSystemSnapshot(userId),
    gatherEmailAccountsSnapshot(userId),
    gatherMailboxReputationSnapshot(userId),
    gatherExternalMailSnapshot(userId),
  ]);

  const vault = vaultRows.map(r => {
    const out: Record<string, unknown> = { ...r };
    for (const f of SENSITIVE_VAULT_FIELDS) out[f] = decryptField(out[f] as any);
    return out;
  });

  const wallets = walletRows.map(w => ({
    ...w,
    encryptedPhrase: undefined,
    seedPhrase: w.encryptedPhrase ? safeDecryptPhrase(w.encryptedPhrase) : null,
  }));

  let attachments: Record<string, unknown>[] = [];
  if (includeAttachments) {
    const rows = await db.select().from(vaultAttachmentsTable).where(eq(vaultAttachmentsTable.userId, userId));
    attachments = rows.map(a => ({ ...a, encryptedContent: undefined, dataBase64: decryptField(a.encryptedContent) }));
  }

  const snapshot = {
    exportedAt: new Date().toISOString(),
    userId,
    version: 9, // Connected Mail Accounts auto-restored (Feature 15v); mailboxReputation (15w) is reference-only, no bump needed
    vault, localAccounts: localRows, kycEntries: kycRows, gameEntries: gameRows, wallets, attachments,
    // KYC Data Entities (Feature 15h) — flattened to top-level like
    // localAccounts/kycEntries/gameEntries above, since this is the same
    // kind of "real entity data" (see gatherEntityCoverageSnapshot's doc
    // comment) and merge-restores the same additive way via RAW_PLANS.
    kycDataEntities: entityCoverage.dataEntities,
    // Native mailbox (Feature 15d) — flattened to top-level arrays (rather
    // than nested under `mailbox`) so the same RAW_PLANS merge-restore
    // mechanism lib/vault-snapshot-restore.ts already uses for
    // localAccounts/kycEntries/gameEntries can address these directly.
    mailboxFolders: mailbox.folders,
    mailboxMessages: mailbox.messages,
    mailboxLabels: mailbox.labels,
    mailboxMessageLabels: mailbox.messageLabels,
    mailboxRules: mailbox.rules,
    mailboxTemplates: mailbox.templates,
    mailboxContacts: mailbox.contacts,
    // Attachments (Feature 15d) — kept nested rather than flattened into
    // RAW_PLANS like the tables above: each row's message_id FK points at
    // a specific mailboxMessages row, and messages restore through their
    // own special-cased path (reencryptMailboxMessageForRestore, not
    // RAW_PLANS) rather than getting fresh sequential ids the same way
    // RAW_PLANS rows do — so there's no safe way yet to remap an
    // attachment onto its restored message. Backed up for reference/manual
    // recovery (same treatment as finance/profile/activity below); content
    // only present when includeAttachments was set at export time.
    mailboxAttachments: mailbox.attachments,
    // Protocol/project enrollments (Feature 15d). userProjects flattens into
    // RAW_PLANS same as the tables above (project_id points at the global
    // projects table, not a per-user entity, so it's always safely
    // restorable). projectEnrollments does NOT go through RAW_PLANS despite
    // being flattened here the same way — its vault_entry_id (NOT NULL) /
    // kyc_entry_id / data_entity_id all point at rows that get a brand-new
    // id on merge-restore, with no way to remap them yet (same reasoning as
    // entityCoverage below), so it's backed up for reference/manual
    // recovery only, never auto-merge-restored — see
    // lib/vault-snapshot-restore.ts's RAW_PLANS comment.
    userProjects: projects.userProjects,
    projectEnrollments: projects.enrollments,
    projectRoiLedger: projects.roiLedger,
    projectRatings: projects.ratings,
    projectPnlReceipts: projects.pnlReceipts,
    // Tasks (Feature 15d).
    taskSubmissions: tasks.submissions,
    // Wallet Hub (Feature 15e) — everything the Wallet Hub page shows beyond
    // the base `wallets` rows above. builtinWalletTokens and chainDeposits
    // are flattened to top-level (merge-restorable, same reasoning as the
    // mailbox/task tables); walletTransfers/credits/creditTransactions stay
    // nested under `walletHub` and are NOT auto-restored — see the comment
    // on `finance` below for why (these are live balances / two-party money
    // movements, not something a restore should silently rewrite).
    builtinWalletTokens: walletHub.builtinTokens,
    chainDeposits: walletHub.chainDeposits,
    walletHub: { transfers: walletHub.transfers, credits: walletHub.credits, creditTransactions: walletHub.creditTransactions },
    // Finance (Feature 15d) — kept nested and NOT wired into the RAW_PLANS
    // merge-restore mechanism: the ledger has cross-table balance integrity
    // (running totals, generated ROI columns, journal debit/credit
    // balancing) that a blind additive re-insert could silently break, and
    // "same row" identity is much harder to define safely for money
    // movements than for a mailbox rule or a KYC entry. It IS included in
    // every backup (so a full account rebuild — even by hand from the JSON
    // — is possible), same treatment vault attachments already get: backed
    // up, shown in the restore-preview counts, not auto-restored.
    finance,
    // Account configuration (Feature 15d) — handles, digest prefs, invoice
    // branding, etc. Never includes password_hash or two_fa_secret (see
    // gatherUserProfileSnapshot). Informational-only in restore, same
    // reasoning as finance: overwriting the *current* account's profile
    // row from an old backup is a decision a user should make explicitly
    // in Settings, not something a restore silently does.
    profile,
    // Activity trace (Feature 15f) — general event log + Vault-specific
    // audit trails (see gatherActivitySnapshot's doc comment). Included for
    // disaster-recovery/audit reference; capped to the most recent
    // ACTIVITY_TRACE_LIMIT rows per table and, like finance/profile, never
    // auto-restored — an audit trail records what already happened, so
    // replaying it isn't a "restore" in any meaningful sense.
    activity,
    // Entity coverage (Feature 15h) — receipts/history/shares tied to the
    // four entity tables above. Kept nested (not flattened into RAW_PLANS)
    // and NOT auto-restored — see gatherEntityCoverageSnapshot's doc
    // comment for why (sourceId/entity_id remapping, and shares being
    // two-party data). Backed up so a full manual/disaster recovery from
    // the raw JSON is always possible, same treatment as finance/profile/
    // activity above.
    entityCoverage: {
      categoryReceipts: entityCoverage.categoryReceipts,
      valueHistory: entityCoverage.valueHistory,
      sharesOwned: entityCoverage.sharesOwned,
      sharesReceived: entityCoverage.sharesReceived,
      // Feature 15i — Linked Entities graph (vault_entity_links). Same
      // nested/not-auto-restored treatment as the three above — see
      // gatherEntityCoverageSnapshot's doc comment for why.
      entityLinks: entityCoverage.entityLinks,
    },
    // Emergency Access (Feature 15j) — dead-man-switch nominations + grants,
    // both this user's own (contactsOwned, grantsOwned) and any grant where
    // this user is the nominated contact (grantsAsContact). Reference-only,
    // not auto-restored — see gatherEmergencyAccessSnapshot's doc comment.
    emergencyAccess: {
      contactsOwned: emergencyAccess.contactsOwned,
      grantsOwned: emergencyAccess.grantsOwned,
      grantsAsContact: emergencyAccess.grantsAsContact,
    },
    // Account & Platform Extras (Feature 15m) — the remaining account-scoped
    // surfaces: notifications, referrals (both directions), billing/
    // subscription state, support tickets + messages, developer API keys
    // (metadata only — key_hash stripped, see gatherAccountExtrasSnapshot's
    // doc comment), passkeys, and Polymarket trade history. Kept nested and
    // NOT auto-restored, same reasoning as finance/profile/activity/
    // entityCoverage/emergencyAccess above. Included in every backup so a
    // full manual/disaster recovery from the raw JSON is always possible.
    accountExtras: {
      notifications: accountExtras.notifications,
      referralsMade: accountExtras.referralsMade,
      referralsReceived: accountExtras.referralsReceived,
      subscription: accountExtras.subscription,
      supportTickets: accountExtras.supportTickets,
      supportMessages: accountExtras.supportMessages,
      apiKeys: accountExtras.apiKeys,
      passkeys: accountExtras.passkeys,
      polymarketTrades: accountExtras.polymarketTrades,
    },
    // Team (Feature 15n) — teams this user owns, their memberships across
    // every team they belong to, and everything they've personally posted/
    // requested/created inside a team (messages, announcements, missions,
    // join requests, favorites) plus their own slice of both team activity
    // logs (legacy + current). Kept nested and NOT auto-restored, same
    // reasoning as accountExtras/emergencyAccess above.
    team: {
      teamsOwned: team.teamsOwned,
      memberships: team.memberships,
      joinRequestsMade: team.joinRequestsMade,
      favorites: team.favorites,
      messagesSent: team.messagesSent,
      announcementsPosted: team.announcementsPosted,
      missionsCreated: team.missionsCreated,
      teamActivityLegacy: team.teamActivityLegacy,
      teamActivityShared: team.teamActivityShared,
    },
    // Earning (Feature 15n) — this user's own pay-per-click earn links
    // (title, target URL, code, rate, click/earned counters). The AZN
    // balance those links produce is already covered by walletHub.credits
    // above. Kept nested and NOT auto-restored — earn_links.code is
    // globally unique, so re-inserting an old code verbatim could collide
    // with a code re-issued to someone else since the backup was made.
    earning: {
      earnLinks: earning.earnLinks,
    },
    // Backup System self-coverage (Feature 15t) — this user's own automatic-
    // backup schedule, connected cloud-delivery accounts, delivery/audit
    // history, and a secrets-free Vault security posture summary. Secrets
    // (webhookSecret, cloud OAuth tokens, PIN/password hashes) are stripped
    // at the gather step — see gatherBackupSystemSnapshot's doc comment for
    // exactly why each one is excluded. Kept nested and NOT auto-restored,
    // same reasoning as accountExtras/team above.
    backupSystem: {
      schedule: backupSystem.schedule,
      cloudConnections: backupSystem.cloudConnections,
      deliveries: backupSystem.deliveries,
      auditLog: backupSystem.auditLog,
      vaultSecurityPosture: backupSystem.vaultSecurityPosture,
      projectTemplates: backupSystem.projectTemplates,
    },
    // Connected Mail Accounts (Feature 15u) — external IMAP/SMTP mailboxes
    // this user wired up (both personal and any team mailbox they
    // personally configured), password/authKey decrypted the same way
    // Vault entity fields and wallet seed phrases are above — see
    // gatherEmailAccountsSnapshot's doc comment for why this one IS
    // decrypted where backupSystem's cloud-connection tokens are not.
    // Flattened to a top-level array (rather than nested), same as
    // mailboxFolders/mailboxContacts above, so the merge-restore mechanism
    // in lib/vault-snapshot-restore.ts can address it directly — this is
    // auto-restored (unlike backupSystem/team above), keyed on
    // emailAddress + protocol per user.
    emailAccounts: emailAccounts.accounts,
    // Mailbox Deliverability & Reputation (Feature 15w) — this user's own
    // sender Block/Allow list, auto-flagged/blocked outbound recipients,
    // and their account's own sending-health status. Kept nested and NOT
    // auto-restored: sender/recipient reputation are live moderation
    // decisions gated on a (user, email) unique key, and blindly re-adding
    // a stale "blocked" row on restore could re-block an address the user
    // has since deliberately unblocked from Settings — the same
    // "don't silently overwrite a since-changed decision" reasoning
    // backupSystem/team above already use. sendingHealth is fully derived
    // from live sends and would just be immediately recomputed anyway.
    // Included in every backup so a full manual/disaster recovery from the
    // raw JSON is always possible.
    mailboxReputation: {
      senderReputation: mailboxReputation.senderReputation,
      recipientReputation: mailboxReputation.recipientReputation,
      sendingHealth: mailboxReputation.sendingHealth,
    },
    // External Mail Sync Cache (Feature 15x) — the synced header/body cache
    // for this user's connected external IMAP/SMTP mailboxes (mail_messages,
    // bodies decrypted like the native mailbox's above). Kept nested and
    // NOT auto-restored — this is a CACHE of a system of record that lives
    // outside AYZEN (the user's actual Gmail/Outlook/IMAP server); the
    // correct recovery path is re-syncing the account, not replaying a
    // stale cache that could resurrect content since deleted at the
    // source. Included in every backup so a full manual/disaster recovery
    // from the raw JSON is always possible, same treatment as
    // finance/profile/activity above.
    externalMail: {
      messages: externalMail.messages,
    },
  };

  const mailboxCount = mailbox.folders.length + mailbox.messages.length + mailbox.labels.length
    + mailbox.messageLabels.length + mailbox.rules.length + mailbox.templates.length
    + mailbox.contacts.length + mailbox.attachments.length;
  const projectsCount = projects.userProjects.length + projects.enrollments.length
    + projects.roiLedger.length + projects.ratings.length + projects.pnlReceipts.length;
  const tasksCount = tasks.submissions.length;
  const financeCount = Object.values(finance).reduce((n, t) => n + (Array.isArray(t) ? t.length : 0), 0);
  const walletHubCount = walletHub.transfers.length + walletHub.builtinTokens.length
    + walletHub.credits.length + walletHub.creditTransactions.length + walletHub.chainDeposits.length;
  const activityCount = activity.userActivity.length + activity.vaultActivityLog.length + activity.vaultFieldHistory.length;
  const entityCoverageCount = entityCoverage.dataEntities.length + entityCoverage.categoryReceipts.length
    + entityCoverage.valueHistory.length + entityCoverage.sharesOwned.length + entityCoverage.sharesReceived.length
    + entityCoverage.entityLinks.length;
  const emergencyAccessCount = emergencyAccess.contactsOwned.length + emergencyAccess.grantsOwned.length
    + emergencyAccess.grantsAsContact.length;
  const accountExtrasCount = accountExtras.notifications.length + accountExtras.referralsMade.length
    + accountExtras.referralsReceived.length + (accountExtras.subscription ? 1 : 0)
    + accountExtras.supportTickets.length + accountExtras.supportMessages.length
    + accountExtras.apiKeys.length + accountExtras.passkeys.length + accountExtras.polymarketTrades.length;
  const teamCount = team.teamsOwned.length + team.memberships.length + team.joinRequestsMade.length
    + team.favorites.length + team.messagesSent.length + team.announcementsPosted.length
    + team.missionsCreated.length + team.teamActivityLegacy.length + team.teamActivityShared.length;
  const earningCount = earning.earnLinks.length;
  const backupSystemCount = (backupSystem.schedule ? 1 : 0) + backupSystem.cloudConnections.length
    + backupSystem.deliveries.length + backupSystem.auditLog.length
    + (backupSystem.vaultSecurityPosture ? 1 : 0) + backupSystem.projectTemplates.length;
  const emailAccountsCount = emailAccounts.accounts.length;
  const mailboxReputationCount = mailboxReputation.senderReputation.length
    + mailboxReputation.recipientReputation.length + (mailboxReputation.sendingHealth ? 1 : 0);
  const externalMailCount = externalMail.messages.length;

  return {
    json: JSON.stringify(snapshot),
    vaultCount: vault.length,
    walletsCount: wallets.length,
    mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount,
    accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount,
  };
}

export interface StoreSnapshotRowInput {
  userId: number;
  label: string | null;
  blob: string;
  includeAttachments: boolean;
  entriesCount: number;
  walletsCount: number;
  // Feature 15d — best-effort counts for the wider backup surface. Optional
  // and defaulted to 0 so existing callers (and the DB column defaults, if
  // migration 058 hasn't been applied yet on some install) don't break.
  mailboxCount?: number;
  projectsCount?: number;
  tasksCount?: number;
  financeCount?: number;
  walletHubCount?: number;
  activityCount?: number;
  // Feature 15h — best-effort count for the entity-coverage surface
  // (KYC Data Entities, category receipts, value history, shares, links).
  entityCoverageCount?: number;
  // Feature 15j — best-effort count for the Emergency Access surface
  // (dead-man-switch contacts nominated + grants owned/received).
  emergencyAccessCount?: number;
  // Feature 15m — best-effort count for the Account & Platform Extras
  // surface (notifications, referrals, subscription, support, API keys,
  // passkeys, Polymarket trades).
  accountExtrasCount?: number;
  // Feature 15n — best-effort counts for Team (owned teams, memberships,
  // join requests, favorites, messages/announcements/missions this user
  // created, both team activity logs) and Earning (this user's own
  // pay-per-click earn links).
  teamCount?: number;
  earningCount?: number;
  // Feature 15t — best-effort count for the Backup System self-coverage
  // surface (schedule config, cloud-connection labels, delivery/audit
  // history, Vault security posture summary, authored project templates).
  backupSystemCount?: number;
  // Feature 15u — best-effort count for connected external mail accounts
  // (IMAP/SMTP, personal + any team mailbox this user configured).
  emailAccountsCount?: number;
  // Feature 15w — best-effort count for the Mailbox Deliverability &
  // Reputation surface (sender Block/Allow list, flagged/blocked outbound
  // recipients, this account's own sending-health status).
  mailboxReputationCount?: number;
  // Feature 15x — best-effort count for the External Mail Sync Cache
  // surface (synced header/body cache for connected external IMAP/SMTP
  // mailboxes).
  externalMailCount?: number;
  source: "manual" | "scheduled";
  encryptionMode: "password" | "envelope";
  encryptionVersion?: number | null;
}

/**
 * Persists an already-encrypted snapshot blob as a vault_snapshots row
 * (computing its checksum and pruning older rows past MAX_STORED_SNAPSHOTS),
 * used by both the manual export route below and every scheduled run in
 * lib/vault-backup-schedule-cron.ts — so "Stored Backups" always shows a
 * single unified list regardless of which path produced each one.
 */
export async function storeSnapshotRow(input: StoreSnapshotRowInput): Promise<{ id: number }> {
  const checksum = crypto.createHash("sha256").update(input.blob, "utf8").digest("hex");
  const [stored] = await db.insert(vaultSnapshotsTable).values({
    userId: input.userId,
    label: input.label,
    blob: input.blob,
    sizeBytes: Buffer.byteLength(input.blob, "utf8"),
    includesAttachments: !!input.includeAttachments,
    entriesCount: input.entriesCount,
    walletsCount: input.walletsCount,
    mailboxCount: input.mailboxCount ?? 0,
    projectsCount: input.projectsCount ?? 0,
    tasksCount: input.tasksCount ?? 0,
    financeCount: input.financeCount ?? 0,
    walletHubCount: input.walletHubCount ?? 0,
    activityCount: input.activityCount ?? 0,
    entityCoverageCount: input.entityCoverageCount ?? 0,
    emergencyAccessCount: input.emergencyAccessCount ?? 0,
    accountExtrasCount: input.accountExtrasCount ?? 0,
    teamCount: input.teamCount ?? 0,
    earningCount: input.earningCount ?? 0,
    backupSystemCount: input.backupSystemCount ?? 0,
    emailAccountsCount: input.emailAccountsCount ?? 0,
    mailboxReputationCount: input.mailboxReputationCount ?? 0,
    externalMailCount: input.externalMailCount ?? 0,
    checksum,
    source: input.source,
    encryptionMode: input.encryptionMode,
    encryptionVersion: input.encryptionVersion ?? null,
  }).returning({ id: vaultSnapshotsTable.id });
  await pruneOldSnapshots(input.userId);
  return { id: stored!.id };
}

// ─── POST /vault/snapshot/export ────────────────────────────────────────────
// Body: { password, includeAttachments?: boolean, label?: string }
// Builds the encrypted blob, stores it as a row in vault_snapshots (so it's
// actually backed up in the vault, not just handed to the browser), then
// streams the same blob down as a download too.
router.post("/vault/snapshot/export", requireAuth, snapshotBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { password, includeAttachments, label } = req.body ?? {};
  if (typeof password !== "string" || password.length < MIN_SNAPSHOT_PASSWORD_LENGTH) {
    res.status(400).json({
      error: "Invalid password",
      solution: `Snapshot password must be at least ${MIN_SNAPSHOT_PASSWORD_LENGTH} characters. Store it somewhere safe — AYZEN never keeps a copy and cannot recover a snapshot without it.`,
    });
    return;
  }

  const { json, vaultCount, walletsCount, mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount, accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount } = await buildVaultSnapshotPayload(userId, !!includeAttachments);
  const blob = encryptBlob(password, json);

  const { id: storedId } = await storeSnapshotRow({
    userId,
    label: typeof label === "string" && label.trim() ? label.trim().slice(0, 120) : null,
    blob,
    includeAttachments: !!includeAttachments,
    entriesCount: vaultCount,
    walletsCount,
    mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount, accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount,
    source: "manual",
    encryptionMode: "password",
  });

  await logActivity(userId, "vault_snapshot_exported", "vault_snapshot", storedId, null, {
    entries: vaultCount, wallets: walletsCount, mailbox: mailboxCount, projects: projectsCount, tasks: tasksCount, finance: financeCount, walletHub: walletHubCount, activity: activityCount, entityCoverage: entityCoverageCount, emergencyAccess: emergencyAccessCount, accountExtras: accountExtrasCount, team: teamCount, earning: earningCount, backupSystem: backupSystemCount, emailAccounts: emailAccountsCount, mailboxReputation: mailboxReputationCount, externalMail: externalMailCount,
  });

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-vault-snapshot-${Date.now()}.ayzenbak"`);
  res.setHeader("X-Snapshot-Id", String(storedId));
  res.send(blob);
});

// ─── GET /vault/snapshots ───────────────────────────────────────────────────
// Lists stored backups for the caller, newest first — metadata only, never
// the blob, so this stays cheap even with MAX_STORED_SNAPSHOTS large ones.
router.get("/vault/snapshots", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const rows = await db
    .select({
      id: vaultSnapshotsTable.id,
      label: vaultSnapshotsTable.label,
      sizeBytes: vaultSnapshotsTable.sizeBytes,
      includesAttachments: vaultSnapshotsTable.includesAttachments,
      entriesCount: vaultSnapshotsTable.entriesCount,
      walletsCount: vaultSnapshotsTable.walletsCount,
      mailboxCount: vaultSnapshotsTable.mailboxCount,
      projectsCount: vaultSnapshotsTable.projectsCount,
      tasksCount: vaultSnapshotsTable.tasksCount,
      financeCount: vaultSnapshotsTable.financeCount,
      walletHubCount: vaultSnapshotsTable.walletHubCount,
      activityCount: vaultSnapshotsTable.activityCount,
      entityCoverageCount: vaultSnapshotsTable.entityCoverageCount,
      emergencyAccessCount: vaultSnapshotsTable.emergencyAccessCount,
      accountExtrasCount: vaultSnapshotsTable.accountExtrasCount,
      teamCount: vaultSnapshotsTable.teamCount,
      earningCount: vaultSnapshotsTable.earningCount,
      backupSystemCount: vaultSnapshotsTable.backupSystemCount,
      emailAccountsCount: vaultSnapshotsTable.emailAccountsCount,
      mailboxReputationCount: vaultSnapshotsTable.mailboxReputationCount,
      externalMailCount: vaultSnapshotsTable.externalMailCount,
      source: vaultSnapshotsTable.source,
      encryptionMode: vaultSnapshotsTable.encryptionMode,
      createdAt: vaultSnapshotsTable.createdAt,
    })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)))
    .orderBy(desc(vaultSnapshotsTable.createdAt));

  res.json({ snapshots: rows, max: MAX_STORED_SNAPSHOTS });
});

// ─── GET /vault/snapshots/storage ───────────────────────────────────────────
// Powers a "storage unit" meter for Stored Backups (Google-One-style, same
// spirit as the rest of the Sylo/AYZEN WORKSPACE rebrand) — how much of the
// per-user backup quota is used, so the UI can warn before old backups start
// getting silently pruned to make room for new ones.
router.get("/vault/snapshots/storage", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const rows = await db
    .select({ sizeBytes: vaultSnapshotsTable.sizeBytes })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)));

  const usedBytes = rows.reduce((sum, r) => sum + r.sizeBytes, 0);
  res.json({
    usedBytes,
    quotaBytes: MAX_TOTAL_SNAPSHOT_BYTES,
    percentUsed: Math.min(100, Math.round((usedBytes / MAX_TOTAL_SNAPSHOT_BYTES) * 100)),
    count: rows.length,
    maxCount: MAX_STORED_SNAPSHOTS,
  });
});

// ─── GET /vault/snapshots/:id/download ──────────────────────────────────────
// Re-downloads a previously stored backup's exact blob — same file you'd
// have gotten at export time. A password-mode (manual) backup needs its
// password to decrypt afterwards; an envelope-mode (scheduled/automatic)
// backup can only be decrypted server-side (see restore below), since its
// key is never handed to the browser — this download exists mainly so an
// automatic backup can still be moved off-vault by hand if desired.
router.get("/vault/snapshots/:id/download", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.download", { error: "Snapshot not found" }), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  const [row] = await db.select().from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)));
  if (!row) { res.status(404).json({ error: "Snapshot not found" }); return; }

  try {
    verifyStoredChecksum(row);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Stored backup failed its integrity check" });
    return;
  }

  // Vault Backup hardening, Round 7 — checked BEFORE logging this download,
  // so this event never counts as its own prior history. Awaited (it's one
  // fast indexed SELECT) so the ordering is guaranteed, unlike a fire-and-
  // forget call racing the audit-log write below.
  const ip = getClientIp(req);
  const anomalous = await isAnomalousBackupIp(userId, ip).catch(() => false);

  // Vault Backup hardening, Round 6 — this hands back a raw, offline-
  // decryptable blob (see this route's file-header note), and until now
  // that event went completely unlogged anywhere in the app. Not awaited —
  // logBackupAudit() never throws (best-effort internally), and the download
  // itself shouldn't wait on the audit write.
  logBackupAudit({
    ownerUserId: userId, eventType: "snapshot_downloaded", snapshotId: id, req,
    detail: { encryptionMode: row.encryptionMode ?? "password" },
  });
  // Round 7's alert — also not awaited (an alert email shouldn't delay the
  // download either), fired only when the IP above was flagged.
  if (anomalous) alertOwnerOfAnomalousBackupAccess(userId, "snapshot_downloaded", ip).catch(() => {});

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-vault-snapshot-${new Date(row.createdAt).getTime()}.ayzenbak"`);
  res.send(row.blob);
});

// ─── PATCH /vault/snapshots/:id ─────────────────────────────────────────────
// Body: { label }. Renames a stored backup so it's easier to pick out of a
// list later ("Before wallet migration", etc).
router.patch("/vault/snapshots/:id", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.update", { error: "Snapshot not found" }), express.json(), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  const label = typeof req.body?.label === "string" ? req.body.label.trim().slice(0, 120) : null;
  const [updated] = await db.update(vaultSnapshotsTable)
    .set({ label: label || null })
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId)))
    .returning({ id: vaultSnapshotsTable.id });
  if (!updated) { res.status(404).json({ error: "Snapshot not found" }); return; }
  res.json({ ok: true });
});

// ─── DELETE /vault/snapshots/:id ────────────────────────────────────────────
// Vault Backup hardening — Snapshot Delete Protection: this used to hard-
// delete the row immediately. It now soft-deletes (sets deleted_at) instead
// — the row stays recoverable via POST /vault/snapshots/:id/restore for
// VAULT_SNAPSHOT_TRASH_RETENTION_DAYS, and migration 072's DB trigger
// refuses a direct hard DELETE on any row that isn't already trashed (and
// long enough ago), so this app-layer check isn't the only thing standing
// between a single request and permanently losing a backup.
router.delete("/vault/snapshots/:id", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.trash", { error: "Snapshot not found" }), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  const [trashed] = await db.update(vaultSnapshotsTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)))
    .returning({ id: vaultSnapshotsTable.id });
  if (!trashed) { res.status(404).json({ error: "Snapshot not found" }); return; }

  await logActivity(userId, "vault_snapshot_trashed", "vault_snapshot", id, null, null);
  await logBackupAudit({ ownerUserId: userId, eventType: "snapshot_trashed", snapshotId: id, req });
  res.json({ message: "Backup moved to trash", retentionDays: VAULT_SNAPSHOT_TRASH_RETENTION_DAYS });
});

// ─── GET /vault/snapshots/trash ─────────────────────────────────────────────
// Lists this user's soft-deleted backups (most recently trashed first),
// with the computed date each will be permanently purged — same shape as
// GET /vault/trash for vault entries (routes/vault.ts).
router.get("/vault/snapshots/trash", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const rows = await db
    .select({
      id: vaultSnapshotsTable.id,
      label: vaultSnapshotsTable.label,
      sizeBytes: vaultSnapshotsTable.sizeBytes,
      entriesCount: vaultSnapshotsTable.entriesCount,
      walletsCount: vaultSnapshotsTable.walletsCount,
      source: vaultSnapshotsTable.source,
      encryptionMode: vaultSnapshotsTable.encryptionMode,
      createdAt: vaultSnapshotsTable.createdAt,
      deletedAt: vaultSnapshotsTable.deletedAt,
    })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.userId, userId), isNotNull(vaultSnapshotsTable.deletedAt)))
    .orderBy(desc(vaultSnapshotsTable.deletedAt));

  res.json({
    snapshots: rows.map((r) => ({
      ...r,
      purgeAt: r.deletedAt ? new Date(new Date(r.deletedAt).getTime() + VAULT_SNAPSHOT_TRASH_RETENTION_DAYS * 86400000).toISOString() : null,
    })),
    retentionDays: VAULT_SNAPSHOT_TRASH_RETENTION_DAYS,
  });
});

// ─── POST /vault/snapshots/:id/restore — pull a backup back out of the trash ─
// Different from POST /vault/snapshot/restore (singular, further up): that
// one merges a decrypted backup's DATA back into the live vault. This one
// just undoes a soft-delete so the backup row itself is visible/usable
// again — no decryption, no data changes.
router.post("/vault/snapshots/:id/restore", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.untrash", { error: "Trashed backup not found" }), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  const [restored] = await db.update(vaultSnapshotsTable)
    .set({ deletedAt: null })
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNotNull(vaultSnapshotsTable.deletedAt)))
    .returning({ id: vaultSnapshotsTable.id });
  if (!restored) { res.status(404).json({ error: "Trashed backup not found" }); return; }

  await logActivity(userId, "vault_snapshot_untrashed", "vault_snapshot", id, null, null);
  await logBackupAudit({ ownerUserId: userId, eventType: "snapshot_untrashed", snapshotId: id, req });
  res.json({ message: "Backup restored from trash" });
});

// ─── DELETE /vault/snapshots/trash/:id — permanently purge one trashed backup ─
// Must already be trashed (deleted_at IS NOT NULL) — mirrors DELETE
// /vault/trash/:id for vault entries. 3 path segments, same non-shadowing
// reasoning as that route: Express only shadows routes with an identical
// segment shape, so this never collides with DELETE /vault/snapshots/:id
// above. Lets a user who's sure they want a specific trashed backup gone
// skip waiting out the retention window — the migration-072 trigger still
// refuses this until the row has been trashed for at least 3 days, so it
// can't be used to instantly bypass the recovery window either.
router.delete("/vault/snapshots/trash/:id", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.purge", { error: "Trashed backup not found" }), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  const [trashedRow] = await db.select({ id: vaultSnapshotsTable.id })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNotNull(vaultSnapshotsTable.deletedAt)));
  if (!trashedRow) { res.status(404).json({ error: "Trashed backup not found" }); return; }

  try {
    await db.delete(vaultSnapshotsTable).where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId)));
  } catch (err: any) {
    // Most likely migration 072's "trashed less than 3 days ago" guard.
    res.status(400).json({ error: err?.message ?? "This backup can't be permanently deleted yet" });
    return;
  }

  await logActivity(userId, "vault_snapshot_purged", "vault_snapshot", id, null, null);
  await logBackupAudit({ ownerUserId: userId, eventType: "snapshot_purged", snapshotId: id, req });
  res.json({ message: "Backup permanently deleted" });
});

// Shared by restore-preview/restore below: pull the decrypted snapshot JSON
// out of either an uploaded blob or a stored snapshot row, given a password.
// Envelope-mode (scheduled) stored snapshots decrypt with the server key
// instead — no password needed, since nobody was present to set one.
//
// Vault Backup hardening, Round 4 — envelope mode is stored-row-only now.
// ─────────────────────────────────────────────────────────────────────────
// This used to accept a client-supplied `blob` for EITHER mode, and decide
// which decrypt path to use by sniffing its prefix. That was a real
// cross-tenant hole for envelope mode specifically: it has no password at
// all, so given a copy of ANY user's "ENV1:..." blob — obtained any way at
// all (a support ticket, a misdirected delivery, a DB export, someone
// pasting it somewhere) — a different authenticated user could decrypt it
// by POSTing it here under their OWN account. Password mode never had this
// problem (the attacker would still need the export password), but
// envelope mode's "key" is a shared server secret nobody types, so blob
// possession alone was sufficient.
//
// Fix: a client-supplied `blob` is now ONLY ever treated as password mode.
// Envelope-mode snapshots can only be restored via `snapshotId`, which is
// looked up through a query already filtered to `userId` — i.e. only ever
// the caller's own row — before anything gets decrypted. (Layer 2 of this
// fix, AAD-binding new envelope blobs to their owning userId, lives in
// lib/vault-backup-envelope.ts; that's defense-in-depth for this same class
// of bug, not a substitute for this check.)
async function decryptSnapshotFromRequest(
  userId: number, body: any,
): Promise<{ snapshot: any } | { error: string; status: number }> {
  const { password, snapshotId } = body ?? {};
  let { blob } = body ?? {};

  if (snapshotId !== undefined) {
    const id = Number(snapshotId);
    if (!Number.isFinite(id)) return { error: "Invalid snapshotId", status: 400 };
    const [row] = await db.select().from(vaultSnapshotsTable)
      .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)));
    if (!row) return { error: "Snapshot not found — it may be in the trash; restore it first", status: 404 };
    try {
      verifyStoredChecksum(row);
    } catch (err: any) {
      return { error: err?.message ?? "Stored backup failed its integrity check", status: 500 };
    }
    const encryptionMode = (row.encryptionMode as "password" | "envelope" | undefined) ?? "password";
    if (encryptionMode === "envelope" || row.blob.trim().startsWith("ENV1:") || row.blob.trim().startsWith("ENV2:")) {
      try {
        const { envelopeDecryptBackup } = await import("../lib/vault-backup-envelope");
        // `row.userId` is provably `userId` here (the query above filtered on
        // it) — this is the ONLY place envelopeDecryptBackup is ever called
        // with anything other than a value straight off a userId-scoped row.
        return { snapshot: JSON.parse(await envelopeDecryptBackup(row.blob, row.userId)) };
      } catch (err: any) {
        return { error: err?.message ?? "Could not decrypt automatic backup", status: 400 };
      }
    }
    blob = row.blob;
  }

  // Client-supplied `blob` (an uploaded .ayzenbak file) is password mode
  // ONLY, regardless of what its prefix claims — see the Round 4 comment
  // above. A blob claiming to be "ENV1:"/"ENV2:" here is simply not a
  // decryptable password-mode file and will fail the format check inside
  // decryptBlob() with a clear error, same as any other malformed upload.
  if (typeof blob !== "string" || !blob) return { error: "blob or snapshotId is required", status: 400 };
  if (typeof password !== "string" || !password) return { error: "password is required", status: 400 };
  try {
    return { snapshot: JSON.parse(decryptBlob(password, blob)) };
  } catch (err: any) {
    return { error: err?.message ?? "Could not decrypt snapshot", status: 400 };
  }
}

// ─── POST /vault/snapshot/restore-preview ──────────────────────────────────
// Body: { password, blob } OR { password, snapshotId } — same input shape as
// restore below (password is not required for an envelope-mode / automatic
// stored snapshot). Decrypts the backup and reports, per table (Vault,
// Wallets, Local Accounts, KYC Entities, Game Entities), how many rows would
// be added vs. skipped as already-present by a merge restore — WITHOUT
// writing anything. Only non-sensitive display fields go into the response
// (no passwords, 2FA, backup codes, or seed phrases), even though this is a
// dry run — the response still travels over the network and may get logged.
router.post("/vault/snapshot/restore-preview", requireAuth, snapshotBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const result = await decryptSnapshotFromRequest(userId, req.body);
  if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }

  const preview = await buildRestoreDiff(userId, result.snapshot);
  res.json(preview);
});

// ─── POST /vault/snapshot/restore ──────────────────────────────────────────
// Body: { password, blob } to restore from an uploaded .ayzenbak file, OR
// { password, snapshotId } to restore straight from a stored backup without
// re-uploading anything (password not required for an envelope-mode /
// automatic stored snapshot). MERGE restore across every table the snapshot
// contains — Vault entities, Local accounts, KYC entities, Game entities,
// and Wallets (Attachments stay informational-only in the preview; there's
// no upload-replay path to recreate them from a base64 blob). A row is
// added only if nothing with the same identity (see
// lib/vault-snapshot-restore.ts) already exists for this user — the diff is
// recomputed from scratch here, never trusting a client-supplied one — so
// running restore more than once always converges: it never duplicates and
// never overwrites.
router.post("/vault/snapshot/restore", requireAuth, snapshotBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const result = await decryptSnapshotFromRequest(userId, req.body);
  if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }

  const applied = await applyRestoreDiff(userId, result.snapshot);
  await logActivity(userId, "vault_snapshot_restored", null, null, null, {
    restored: applied.restored, skipped: applied.skipped, byTable: applied.byTable,
  });
  // Round 7 — checked BEFORE the audit write below, same ordering reasoning
  // as the download route above.
  const restoreIp = getClientIp(req);
  const restoreAnomalous = await isAnomalousBackupIp(userId, restoreIp).catch(() => false);
  await logBackupAudit({
    ownerUserId: userId, eventType: "snapshot_restored",
    snapshotId: Number.isFinite(Number(req.body?.snapshotId)) ? Number(req.body.snapshotId) : null,
    req, detail: { restored: applied.restored, skipped: applied.skipped },
  });
  if (restoreAnomalous) alertOwnerOfAnomalousBackupAccess(userId, "snapshot_restored", restoreIp).catch(() => {});
  res.json(applied);
});

export default router;
