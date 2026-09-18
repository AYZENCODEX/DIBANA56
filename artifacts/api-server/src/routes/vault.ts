import { Router, type Request, type Response } from "express";
import { db, vaultEntriesTable, usersTable, vaultActivityLogTable, vaultFieldHistoryTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import * as crypto from "crypto";
import { broadcastEvent } from "./events";
import { requireAuth, requireAdmin, pepDecisionObserver } from "../middlewares/auth";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";
import { authorizeMany } from "../lib/policy/pep";
import type { ResourceRef } from "../lib/policy/types";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../lib/policy/resource";
import { syncOnVaultUpdate, syncOnVaultStatusChange, syncOnVaultDelete, delistVaultMarketplaceListings } from "../services/sync";
import { encryptField, decryptField, decryptRows } from "../lib/vault-crypto";
import { computeAutoScore, evalHealthRules, severityEmoji, type VaultHealthInput } from "../lib/vault-health";
import { createNotification } from "./notifications";
import { sendToUser } from "../lib/telegram";
// Phase 15B — team Activity Log sub-view sources everything from the shared
// Phase 4 activity_log table (subject_type="team"), including vault-usage
// events, instead of a second logging system. logVaultActivity below mirrors
// into it whenever the entry belongs to a team.
import { logSubjectActivity } from "../lib/activity-log";
import { consumeRevealToken, hasNoEntityPin } from "./vault-security";
import { VAULT_TRASH_RETENTION_DAYS } from "../lib/vault-trash-purge";
import { streamFantasticReceiptPdf } from "../lib/receipt-theme";
import { computeEntityWorth, computeEntityBuyValue, computeEntityProfitPct, computeAge } from "../lib/entity-worth";
import { requireOwnership, requirePublicAudit } from "../lib/policy/pep/middleware";
import { vaultEntryResource } from "./vault-entity-links";

const router = Router();

// ─── Route Integration Roadmap — Season C, Phase C30 (vault.ts core CRUD,
// Season B/Phase B2) ──────────────────────────────────────────────────────
// `GET/PATCH/DELETE /vault/:id` were already correctly scoped —
// `selectVaultOne()`/the `db.update()`/`db.delete()` calls below all filter
// by `and(eq(id), eq(userId, req.user!.userId))` — but that check lived
// only in each handler's own SQL, outside the PDP/audit trail every other
// migrated `:id` route in this series goes through. This reuses C21's
// exported `vaultEntryResource` (`vault-entity-links.ts`) — same
// `vault_entries.user_id` shape entities.ts/value-history.ts already reuse
// — rather than a third copy of the ref-builder. Following entities.ts's
// thin local wrapper (not vault-entity-links.ts's own fixed-404 helper),
// so each route keeps its own pre-existing deny body verbatim: GET/PATCH
// both already return `{ error: "Vault entry not found" }`, DELETE already
// returns `{ message: "Vault entry not found" }` — none of that changes.
// `POST /vault` is a create with no `:id`, nothing exists yet to own, so
// it's out of scope here for the same reason `POST /vault/bulk` and every
// other body-only create route in this series is (see C27/roadmap).
function requireVaultEntryOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, vaultEntryResource, { onDecision: pepDecisionObserver, onDeny });
}

// ── Encrypted column list — single source of truth ─────────────────────────
// Every DB column (snake_case, matching raw SQL row shape) that formatRow()
// below runs through decryptField(). Exported so other modules that need to
// decrypt a raw vault_entries row without going through formatRow() — e.g.
// routes/vault-shares.ts building the "shared with me" view — read the exact
// same list instead of hand-maintaining a second copy that silently drifts
// out of sync with this one. Does NOT include encrypted_seed_phrase, which
// uses its own decryptSeedPhrase()/reveal-token flow, not decryptField().
export const VAULT_ENTITY_ENCRYPTED_FIELDS = [
  "account_password", "email_password", "email_2fa", "email_backup_code", "email_recovery_password",
  "account_2fa", "account_backup_code",
  "recovery_2fa", "recovery_backup_code",
  "twitter_password", "twitter_email_password", "twitter_2fa", "twitter_email_recovery_password",
  "twitter_account_backup_code", "twitter_email_2fa", "twitter_email_backup_code",
  "twitter_recovery_2fa", "twitter_recovery_backup_code",
  "discord_password", "discord_email_password", "discord_2fa", "discord_email_recovery_password",
  "discord_account_backup_code", "discord_email_2fa", "discord_email_backup_code",
  "discord_recovery_2fa", "discord_recovery_backup_code",
  "telegram_password", "telegram_linked_email_password", "telegram_2fa",
  "telegram_account_backup_code", "telegram_email_2fa", "telegram_email_backup_code",
  "telegram_recovery_2fa", "telegram_recovery_backup_code",
  "backup_codes", "other_accounts",
] as const;

// Credential/2FA columns encrypted at rest (see lib/vault-crypto.ts). backupCodes
// and otherAccounts are JSON-serialized text columns — encrypted as one blob.
// Exported so other Vault-adjacent routes (e.g. vault-migration.ts's
// import/export tool, vault-snapshot.ts's full backup) encrypt/decrypt the
// exact same field set instead of maintaining a second list that can drift.
export const SENSITIVE_VAULT_FIELDS = new Set([
  "accountPassword", "emailPassword", "email2fa", "emailBackupCode", "emailRecoveryPassword",
  "recovery2fa", "recoveryBackupCode",
  "account2fa", "accountBackupCode",
  "twitterPassword", "twitterEmailPassword", "twitter2fa", "twitterEmailRecoveryPassword",
  "twitterAccountBackupCode", "twitterEmail2fa", "twitterEmailBackupCode",
  "twitterRecovery2fa", "twitterRecoveryBackupCode",
  "discordPassword", "discordEmailPassword", "discord2fa", "discordEmailRecoveryPassword",
  "discordAccountBackupCode", "discordEmail2fa", "discordEmailBackupCode",
  "discordRecovery2fa", "discordRecoveryBackupCode",
  "telegramPassword", "telegramLinkedEmailPassword", "telegram2fa",
  "telegramAccountBackupCode", "telegramEmail2fa", "telegramEmailBackupCode",
  "telegramRecovery2fa", "telegramRecoveryBackupCode",
  "backupCodes", "otherAccounts",
]);

// Entity ↔ Local bridge — platforms whose tab data can also live as a
// standalone local_accounts row (Twitter/Discord/Telegram; Wallet/Other don't
// have a matching local-account shape).
const BRIDGE_PLATFORMS = ["twitter", "discord", "telegram"] as const;

// When a vault entity (Entity) is created or edited and a platform tab was
// filled in directly (not via LocalEntityPicker's import-from-local flow),
// mirror that platform slot into its own local_accounts row so it also shows
// up under Local — same data, same account, just visible in both places.
// Rows created this way are tagged origin='entity' (vs the 'standalone'
// default) so the Local UI can badge them as auto-created. Best-effort: never
// blocks or fails the calling entity create/edit request.
async function autoCreateLocalAccountsForEntity(
  userId: number,
  vaultEntryId: number,
  body: Record<string, unknown>,
): Promise<void> {
  for (const platform of BRIDGE_PLATFORMS) {
    const username = body[`${platform}Username`];
    if (!username || typeof username !== "string" || !username.trim()) continue;

    try {
      // Already has a local account for this platform slot (either a prior
      // auto-create or an explicit import/link) — don't create a duplicate.
      const existing = await db.execute(sql`
        SELECT id FROM local_accounts
        WHERE user_id = ${userId} AND vault_entry_id = ${vaultEntryId} AND category = ${platform}
        LIMIT 1
      `);
      if (existing.rows.length > 0) continue;

      const password = body[`${platform}Password`];
      const email = platform === "telegram" ? body.telegramLinkedEmail : body[`${platform}Email`];
      const twofa = body[`${platform}2fa`];
      const followers = body[`${platform}Followers`];
      const label = `${platform.charAt(0).toUpperCase()}${platform.slice(1)} (from entity)`;

      await db.execute(sql`
        INSERT INTO local_accounts
          (user_id, category, label, username, email, password, twofa, followers, vault_entry_id, origin)
        VALUES
          (${userId}, ${platform}, ${label}, ${username},
           ${(email as string) || null}, ${encryptField((password as string) || null)},
           ${encryptField((twofa as string) || null)}, ${(followers as string) || null},
           ${vaultEntryId}, 'entity')
      `);
    } catch (err) {
      console.error(`auto-create local account (${platform}) failed:`, err);
      // best-effort — never block entity create/update
    }
  }
}

// Best-effort audit log — never blocks or fails the calling request.
async function logVaultActivity(vaultEntryId: number, userId: number, action: string, detail?: string): Promise<void> {
  try {
    await db.insert(vaultActivityLogTable).values({ vaultEntryId, userId, action, detail: detail ?? null });
  } catch (err) {
    console.error("vault activity log failed:", err);
  }
  // Phase 15B — if this entry belongs to a team, mirror the same event into
  // the shared activity_log (subject_type="team") so the team's Other →
  // Activity Log sub-view sees vault-usage entries without reading a second
  // logging system. Best-effort and non-blocking, same as the write above.
  try {
    const teamRow = await db.execute(sql.raw(`SELECT team_id FROM vault_entries WHERE id = ${vaultEntryId}`));
    const teamId = (teamRow.rows[0] as any)?.team_id;
    if (teamId) {
      await logSubjectActivity("team", Number(teamId), "vault_used", {
        actorUserId: userId,
        meta: { vaultEntryId, vaultAction: action, detail: detail ?? null },
      });
    }
  } catch {
    // best-effort — never block the caller
  }
}

// ─── Health Monitor runner ────────────────────────────────────────────────────
// Best-effort, fire-and-forget (same pattern as logVaultActivity/syncOnVaultUpdate
// below) — never blocks or fails the calling request.
export function toHealthInput(formatted: ReturnType<typeof formatRow>): VaultHealthInput {
  return {
    score: Number((formatted as any).score ?? 5),
    lastLoginAt: (formatted as any).lastLoginAt ?? null,
    hasTwitter2fa: (formatted as any).twitterUsername ? !!(formatted as any).twitter2fa : undefined,
    hasDiscord2fa: (formatted as any).discordUsername ? !!(formatted as any).discord2fa : undefined,
    hasTelegram2fa: (formatted as any).telegramUsername ? !!(formatted as any).telegram2fa : undefined,
    hasEmail2fa: (formatted as any).email ? !!(formatted as any).email2fa : undefined,
    hasAccountPassword: !!(formatted as any).accountPassword,
    email: (formatted as any).email ?? null,
    status: (formatted as any).status ?? "active",
    hasRecoveryEmail: !!(formatted as any).emailRecovery,
  };
}

async function runHealthCheck(id: number, userId: number, recalcScore: boolean): Promise<void> {
  const raw = await selectVaultOne(id, userId);
  if (!raw) return;
  const formatted = formatRow(raw);
  const input = toHealthInput(formatted);

  const dbUpdates: Record<string, unknown> = {};

  if (recalcScore) {
    const auto = computeAutoScore(input);
    if (auto !== input.score) {
      dbUpdates.score = auto;
      input.score = auto;
    }
  }

  const hits = evalHealthRules(input);
  const prevFlags: string[] = Array.isArray((formatted as any).lastHealthFlags) ? (formatted as any).lastHealthFlags : [];
  const currentIds = hits.map(h => h.id);
  const newHits = hits.filter(h => !prevFlags.includes(h.id));

  if (currentIds.join(",") !== prevFlags.join(",")) {
    dbUpdates.lastHealthFlags = JSON.stringify(currentIds);
  }
  if (newHits.length > 0) {
    dbUpdates.lastHealthAlertAt = new Date();
  }

  if (Object.keys(dbUpdates).length > 0) {
    try {
      await db.update(vaultEntriesTable).set(dbUpdates as Partial<typeof vaultEntriesTable.$inferInsert>)
        .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
    } catch (err) {
      console.error("vault health-check update failed:", err);
    }
  }

  if (newHits.length === 0) return;

  const label = formatted.projectName;
  const worst = newHits.find(h => h.severity === "alert") ?? newHits[0];
  const summary = newHits.map(h => `${severityEmoji(h.severity)} ${h.message}`).join("\n");

  createNotification(
    userId,
    "vault_health",
    `Vault Health: ${worst.severity === "alert" ? "Alert" : worst.severity === "warn" ? "Warning" : "Flag"} — ${label}`,
    summary,
    { vaultEntryId: id, ruleIds: currentIds },
  ).catch(() => {});

  db.select({ telegramChatId: usersTable.telegramChatId }).from(usersTable)
    .where(eq(usersTable.id, userId)).limit(1)
    .then(rows => {
      const chatId = rows[0]?.telegramChatId;
      if (!chatId) return;
      return sendToUser(chatId, `${severityEmoji(worst.severity)} *Vault Health*\n\n${label}\n\n${summary}`);
    })
    .catch(() => {});
}

// Exported for vault-migration.ts's bulk importer, which creates entries the
// same way this route does — one entitySerial generator, not two.
export function generateSerial(userId: number): string {
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `AYZN${userId}-${ts}${rand}`;
}

// ─── Seed-phrase encryption (AES-256-GCM, server-side key) ───────────────────
// SECURITY: seed phrases are the single most sensitive secret Vault stores,
// so this key must be dedicated and never fall back to a hardcoded literal
// or be borrowed from another subsystem's secret (e.g. SESSION_SECRET,
// which also signs sessions — a session-forgery bug would then also unlock
// every seed phrase). Set VAULT_SEED_ENCRYPTION_KEY (>= 32 chars) in the
// environment before this module is imported, or the server refuses to
// start. Mirrors the fail-loud pattern in lib/vault-crypto.ts.
const SEED_KEY_RAW = process.env["VAULT_SEED_ENCRYPTION_KEY"];
if (!SEED_KEY_RAW || SEED_KEY_RAW.length < 32) {
  throw new Error(
    "VAULT_SEED_ENCRYPTION_KEY is missing or shorter than 32 characters. Set it as a strong " +
    "random secret (e.g. `openssl rand -hex 32`), distinct from SESSION_SECRET and " +
    "VAULT_FIELD_ENCRYPTION_KEY, before starting the API server — this key protects every " +
    "crypto wallet seed phrase stored in Vault."
  );
}
const KEY_BUF = crypto.scryptSync(SEED_KEY_RAW, "ayzen_seed_salt", 32);

function encryptSeedPhrase(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY_BUF, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + enc.toString("hex");
}

function decryptSeedPhrase(stored: string): string | null {
  try {
    const [ivHex, tagHex, encHex] = stored.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const enc = Buffer.from(encHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY_BUF, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString("utf8") + decipher.final("utf8");
  } catch { return null; }
}

// ─── SAFE_COLS — raw SQL fallback ────────────────────────────────────────────
const SAFE_COLS = `id, user_id, entity_serial, category, project_name,
  email, email_password,
  twitter_username, twitter_password,
  discord_username, discord_password,
  telegram_username, telegram_password,
  wallet_addresses, backup_codes, notes,
  created_at, updated_at,
  null::text as email_recovery, null::text as email_recovery_password,
  null::text as twitter_email, null::text as twitter_email_password,
  null::text as twitter_followers, null::text as twitter_2fa,
  null::text as twitter_email_recovery, null::text as twitter_email_recovery_password,
   null::text as twitter_age, null::text as twitter_worth,
  null::text as discord_email, null::text as discord_email_password,
  null::text as discord_2fa, null::text as discord_email_recovery,
  null::text as discord_email_recovery_password,
  null::text as discord_followers, null::text as discord_age, null::text as discord_worth,
  null::text as telegram_phone, null::text as telegram_2fa,
  null::text as telegram_linked_email, null::text as telegram_linked_email_password,
  null::text as telegram_age, null::text as telegram_worth,
   null::text as twitter_buy_value, null::text as discord_buy_value, null::text as telegram_buy_value,
   0::real as current_value, 0::real as current_buy_value,
   0::real as wallet_worth_usd, null::timestamp as wallet_worth_synced_at,
  null::text as encrypted_seed_phrase, null::text as status, null::timestamp as last_activity_at,
  null::text as username, null::text as account_password, null::text as email_2fa, null::text as email_backup_code,
  null::text as recovery_2fa, null::text as recovery_backup_code,
  null::timestamp as last_login_at, null::timestamp as buy_date, null::timestamp as create_date,
  0::integer as followers,
  null::text as drive_wallet_label, null::text as drive_wallet_address, null::text as drive_wallet_note, null::timestamp as drive_wallet_set_at,
  null::text as telegram_followers,
  null::timestamp as twitter_last_login_at, null::timestamp as twitter_buy_date, null::timestamp as twitter_create_date, null::text as twitter_notes,
  null::timestamp as discord_last_login_at, null::timestamp as discord_buy_date, null::timestamp as discord_create_date, null::text as discord_notes,
  null::timestamp as telegram_last_login_at, null::timestamp as telegram_buy_date, null::timestamp as telegram_create_date, null::text as telegram_notes,
  null::text as account_2fa, null::text as account_backup_code,
  null::text as twitter_account_backup_code, null::text as twitter_email_2fa, null::text as twitter_email_backup_code,
  null::text as twitter_recovery_2fa, null::text as twitter_recovery_backup_code,
  null::text as discord_account_backup_code, null::text as discord_email_2fa, null::text as discord_email_backup_code,
  null::text as discord_recovery_2fa, null::text as discord_recovery_backup_code,
  null::text as telegram_account_backup_code, null::text as telegram_email_2fa, null::text as telegram_email_backup_code,
  null::text as telegram_recovery_2fa, null::text as telegram_recovery_backup_code,
  null::timestamp as deleted_at`;

// selectVault/selectVaultOne/selectAllVaultEntries are the "live" view —
// deleted_at IS NULL — used everywhere except the trash routes below, so a
// soft-deleted entry disappears from every normal list/detail/health-scan
// read the instant it's trashed, exactly like the old hard-delete did.
async function selectVault(userId: number): Promise<Record<string, unknown>[]> {
  try {
    return (await db.select().from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`))) as unknown as Record<string, unknown>[];
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE user_id = ${userId} AND deleted_at IS NULL`));
    return res.rows as Record<string, unknown>[];
  }
}

async function selectVaultOne(id: number, userId: number): Promise<Record<string, unknown> | null> {
  try {
    const rows = await db.select().from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`));
    return (rows[0] as unknown as Record<string, unknown>) ?? null;
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL`));
    return (res.rows[0] as Record<string, unknown>) ?? null;
  }
}

// Cross-user bulk read for lib/vault-health-scan.ts's daily background scan —
// the per-user helpers above (selectVault/selectVaultOne) are scoped to a
// single userId because every request-driven route is. The scan has no
// request/user context, so it needs every entry across every owner.
// Trashed entries are excluded — no point health-flagging something the
// user already threw away.
export async function selectAllVaultEntries(): Promise<Record<string, unknown>[]> {
  try {
    return (await db.select().from(vaultEntriesTable).where(sql`${vaultEntriesTable.deletedAt} IS NULL`)) as unknown as Record<string, unknown>[];
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE deleted_at IS NULL`));
    return res.rows as Record<string, unknown>[];
  }
}

// ─── Trash (soft-deleted entries) ────────────────────────────────────────────
async function selectVaultTrash(userId: number): Promise<Record<string, unknown>[]> {
  try {
    return (await db.select().from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NOT NULL`))
      .orderBy(desc(vaultEntriesTable.deletedAt))) as unknown as Record<string, unknown>[];
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE user_id = ${userId} AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`));
    return res.rows as Record<string, unknown>[];
  }
}

// One trashed row, scoped to its owner — shared by restore/purge-one so both
// 404 cleanly instead of silently no-op'ing on someone else's (or an
// already-live) entry.
async function selectVaultTrashOne(id: number, userId: number): Promise<Record<string, unknown> | null> {
  try {
    const rows = await db.select().from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NOT NULL`));
    return (rows[0] as unknown as Record<string, unknown>) ?? null;
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NOT NULL`));
    return (res.rows[0] as Record<string, unknown>) ?? null;
  }
}

// Permanent purge — the actual row delete + cross-table cleanup that used to
// live directly in the DELETE /vault/:id handler before soft-delete. Shared
// by DELETE /vault/trash/:id (manual purge) and the retention cron.
async function hardDeleteVaultEntry(id: number, userId: number): Promise<void> {
  await db.delete(vaultEntriesTable).where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  await db.execute(sql`DELETE FROM value_history WHERE user_id = ${userId} AND source_type = 'vault' AND source_id = ${id}`);
  syncOnVaultDelete(id).catch(() => {});
}

export function formatRow(e: Record<string, unknown>, revealSeed = false) {
  const walStr = e.wallet_addresses ?? e.walletAddresses;
  const bkStrRaw = e.backup_codes ?? e.backupCodes;
  const bkStr = bkStrRaw ? decryptField(bkStrRaw as string) : bkStrRaw;
  const otherAccountsRaw = e.other_accounts ?? e.otherAccounts;
  const encSeed = e.encrypted_seed_phrase ?? e.encryptedSeedPhrase ?? null;
  return {
    id: e.id,
    userId: e.user_id ?? e.userId,
    entitySerial: e.entity_serial ?? e.entitySerial,
    category: e.category,
    projectName: e.project_name ?? e.projectName,
    username: e.username ?? null,
    accountPassword: decryptField((e.account_password ?? e.accountPassword ?? null) as string | null),
    email: e.email,
    emailPassword: decryptField((e.email_password ?? e.emailPassword) as string | null),
    email2fa: decryptField((e.email_2fa ?? e.email2fa ?? null) as string | null),
    emailBackupCode: decryptField((e.email_backup_code ?? e.emailBackupCode ?? null) as string | null),
    emailRecovery: e.email_recovery ?? e.emailRecovery ?? null,
    emailRecoveryPassword: decryptField((e.email_recovery_password ?? e.emailRecoveryPassword ?? null) as string | null),
    recovery2fa: decryptField((e.recovery_2fa ?? e.recovery2fa ?? null) as string | null),
    recoveryBackupCode: decryptField((e.recovery_backup_code ?? e.recoveryBackupCode ?? null) as string | null),
    lastLoginAt: e.last_login_at ?? e.lastLoginAt ?? null,
    buyDate: e.buy_date ?? e.buyDate ?? null,
    createDate: e.create_date ?? e.createDate ?? null,
    followers: Number(e.followers ?? 0),
    driveWalletLabel: e.drive_wallet_label ?? e.driveWalletLabel ?? null,
    driveWalletAddress: e.drive_wallet_address ?? e.driveWalletAddress ?? null,
    driveWalletNote: e.drive_wallet_note ?? e.driveWalletNote ?? null,
    driveWalletSetAt: e.drive_wallet_set_at ?? e.driveWalletSetAt ?? null,
    twitterUsername: e.twitter_username ?? e.twitterUsername,
    twitterPassword: decryptField((e.twitter_password ?? e.twitterPassword) as string | null),
    twitterEmail: e.twitter_email ?? e.twitterEmail ?? null,
    twitterEmailPassword: decryptField((e.twitter_email_password ?? e.twitterEmailPassword ?? null) as string | null),
    twitterFollowers: e.twitter_followers ?? e.twitterFollowers ?? null,
    twitter2fa: decryptField((e.twitter_2fa ?? e.twitter2fa ?? null) as string | null),
    twitterEmailRecovery: e.twitter_email_recovery ?? e.twitterEmailRecovery ?? null,
    twitterEmailRecoveryPassword: decryptField((e.twitter_email_recovery_password ?? e.twitterEmailRecoveryPassword ?? null) as string | null),
    twitterAge: e.twitter_age ?? e.twitterAge ?? null,
    twitterWorth: e.twitter_worth ?? e.twitterWorth ?? null,
    twitterBuyValue: e.twitter_buy_value ?? e.twitterBuyValue ?? null,
    twitterLastLoginAt: e.twitter_last_login_at ?? e.twitterLastLoginAt ?? null,
    twitterBuyDate: e.twitter_buy_date ?? e.twitterBuyDate ?? null,
    twitterCreateDate: e.twitter_create_date ?? e.twitterCreateDate ?? null,
    twitterNotes: e.twitter_notes ?? e.twitterNotes ?? null,
    discordUsername: e.discord_username ?? e.discordUsername,
    discordPassword: decryptField((e.discord_password ?? e.discordPassword) as string | null),
    discordEmail: e.discord_email ?? e.discordEmail ?? null,
    discordEmailPassword: decryptField((e.discord_email_password ?? e.discordEmailPassword ?? null) as string | null),
    discord2fa: decryptField((e.discord_2fa ?? e.discord2fa ?? null) as string | null),
    discordEmailRecovery: e.discord_email_recovery ?? e.discordEmailRecovery ?? null,
    discordEmailRecoveryPassword: decryptField((e.discord_email_recovery_password ?? e.discordEmailRecoveryPassword ?? null) as string | null),
    discordFollowers: e.discord_followers ?? e.discordFollowers ?? null,
    discordAge: e.discord_age ?? e.discordAge ?? null,
    discordWorth: e.discord_worth ?? e.discordWorth ?? null,
    discordBuyValue: e.discord_buy_value ?? e.discordBuyValue ?? null,
    discordLastLoginAt: e.discord_last_login_at ?? e.discordLastLoginAt ?? null,
    discordBuyDate: e.discord_buy_date ?? e.discordBuyDate ?? null,
    discordCreateDate: e.discord_create_date ?? e.discordCreateDate ?? null,
    discordNotes: e.discord_notes ?? e.discordNotes ?? null,
    telegramUsername: e.telegram_username ?? e.telegramUsername,
    telegramPassword: decryptField((e.telegram_password ?? e.telegramPassword) as string | null),
    telegramPhone: e.telegram_phone ?? e.telegramPhone ?? null,
    telegram2fa: decryptField((e.telegram_2fa ?? e.telegram2fa ?? null) as string | null),
    telegramLinkedEmail: e.telegram_linked_email ?? e.telegramLinkedEmail ?? null,
    telegramLinkedEmailPassword: decryptField((e.telegram_linked_email_password ?? e.telegramLinkedEmailPassword ?? null) as string | null),
    telegramAge: e.telegram_age ?? e.telegramAge ?? null,
    telegramWorth: e.telegram_worth ?? e.telegramWorth ?? null,
    telegramBuyValue: e.telegram_buy_value ?? e.telegramBuyValue ?? null,
    telegramFollowers: e.telegram_followers ?? e.telegramFollowers ?? null,
    telegramLastLoginAt: e.telegram_last_login_at ?? e.telegramLastLoginAt ?? null,
    telegramBuyDate: e.telegram_buy_date ?? e.telegramBuyDate ?? null,
    telegramCreateDate: e.telegram_create_date ?? e.telegramCreateDate ?? null,
    telegramNotes: e.telegram_notes ?? e.telegramNotes ?? null,
    // New per-platform credential fields
    account2fa: decryptField((e.account_2fa ?? (e as any).account2fa ?? null) as string | null),
    accountBackupCode: decryptField((e.account_backup_code ?? (e as any).accountBackupCode ?? null) as string | null),
    twitterAccountBackupCode: decryptField((e.twitter_account_backup_code ?? (e as any).twitterAccountBackupCode ?? null) as string | null),
    twitterEmail2fa: decryptField((e.twitter_email_2fa ?? (e as any).twitterEmail2fa ?? null) as string | null),
    twitterEmailBackupCode: decryptField((e.twitter_email_backup_code ?? (e as any).twitterEmailBackupCode ?? null) as string | null),
    twitterRecovery2fa: decryptField((e.twitter_recovery_2fa ?? (e as any).twitterRecovery2fa ?? null) as string | null),
    twitterRecoveryBackupCode: decryptField((e.twitter_recovery_backup_code ?? (e as any).twitterRecoveryBackupCode ?? null) as string | null),
    discordAccountBackupCode: decryptField((e.discord_account_backup_code ?? (e as any).discordAccountBackupCode ?? null) as string | null),
    discordEmail2fa: decryptField((e.discord_email_2fa ?? (e as any).discordEmail2fa ?? null) as string | null),
    discordEmailBackupCode: decryptField((e.discord_email_backup_code ?? (e as any).discordEmailBackupCode ?? null) as string | null),
    discordRecovery2fa: decryptField((e.discord_recovery_2fa ?? (e as any).discordRecovery2fa ?? null) as string | null),
    discordRecoveryBackupCode: decryptField((e.discord_recovery_backup_code ?? (e as any).discordRecoveryBackupCode ?? null) as string | null),
    telegramAccountBackupCode: decryptField((e.telegram_account_backup_code ?? (e as any).telegramAccountBackupCode ?? null) as string | null),
    telegramEmail2fa: decryptField((e.telegram_email_2fa ?? (e as any).telegramEmail2fa ?? null) as string | null),
    telegramEmailBackupCode: decryptField((e.telegram_email_backup_code ?? (e as any).telegramEmailBackupCode ?? null) as string | null),
    telegramRecovery2fa: decryptField((e.telegram_recovery_2fa ?? (e as any).telegramRecovery2fa ?? null) as string | null),
    telegramRecoveryBackupCode: decryptField((e.telegram_recovery_backup_code ?? (e as any).telegramRecoveryBackupCode ?? null) as string | null),
    walletAddresses: walStr ? (() => { try { return JSON.parse(walStr as string); } catch { return []; } })() : [],
    backupCodes: bkStr ? (() => { try { return JSON.parse(bkStr as string); } catch { return []; } })() : [],
    tags: (() => {
      const t = e.tags ?? (e as any).tags;
      if (!t) return [];
      try { return JSON.parse(t as string); } catch { return []; }
    })(),
    notes: e.notes,
    otherAccounts: otherAccountsRaw ? decryptField(otherAccountsRaw as string) : null,
    currentValue: Number(e.current_value ?? e.currentValue ?? 0),
    currentBuyValue: Number(e.current_buy_value ?? e.currentBuyValue ?? 0),
    walletWorthUsd: Number(e.wallet_worth_usd ?? e.walletWorthUsd ?? 0),
    walletWorthSyncedAt: e.wallet_worth_synced_at ?? e.walletWorthSyncedAt ?? null,
    status: e.status ?? "active",
    twitterBanned: !!(e.twitter_banned ?? e.twitterBanned ?? false),
    discordBanned: !!(e.discord_banned ?? e.discordBanned ?? false),
    telegramBanned: !!(e.telegram_banned ?? e.telegramBanned ?? false),
    lastActivityAt: e.last_activity_at ?? e.lastActivityAt ?? null,
    lastHealthAlertAt: e.last_health_alert_at ?? (e as any).lastHealthAlertAt ?? null,
    lastHealthFlags: (() => {
      const f = e.last_health_flags ?? (e as any).lastHealthFlags;
      if (!f) return [];
      try { return JSON.parse(f as string); } catch { return []; }
    })(),
    // Data Entity bridge — same shape as kyc_entries.dataEntityId
    dataEntityId: (e.data_entity_id ?? (e as any).dataEntityId ?? null) != null
      ? Number(e.data_entity_id ?? (e as any).dataEntityId) : null,
    // Seed phrase: only returned if explicitly revealed; always masked in lists
    hasSeedPhrase: !!encSeed,
    seedPhrase: revealSeed && encSeed ? decryptSeedPhrase(encSeed as string) : undefined,
    createdAt: e.created_at ? new Date(e.created_at as string).toISOString() : e.createdAt,
    updatedAt: e.updated_at ? new Date(e.updated_at as string).toISOString() : e.updatedAt,
    deletedAt: (e.deleted_at ?? (e as any).deletedAt)
      ? new Date((e.deleted_at ?? (e as any).deletedAt) as string).toISOString() : null,
  };
}

const NEW_VAULT_FIELDS: (keyof typeof vaultEntriesTable.$inferInsert)[] = [
  "username", "accountPassword", "email2fa", "emailBackupCode",
  "recovery2fa", "recoveryBackupCode",
  "lastLoginAt", "buyDate", "createDate",
  "emailRecovery", "emailRecoveryPassword",
  "twitterEmail", "twitterEmailPassword", "twitterFollowers", "twitter2fa",
  "twitterEmailRecovery", "twitterEmailRecoveryPassword", "twitterAge", "twitterWorth", "twitterBuyValue",
  "twitterLastLoginAt", "twitterBuyDate", "twitterCreateDate", "twitterNotes",
  "discordEmail", "discordEmailPassword", "discord2fa",
  "discordEmailRecovery", "discordEmailRecoveryPassword", "discordFollowers", "discordAge", "discordWorth", "discordBuyValue",
  "discordLastLoginAt", "discordBuyDate", "discordCreateDate", "discordNotes",
  "telegramPhone", "telegram2fa", "telegramLinkedEmail", "telegramLinkedEmailPassword", "telegramAge", "telegramWorth", "telegramBuyValue",
  "telegramFollowers", "telegramLastLoginAt", "telegramBuyDate", "telegramCreateDate", "telegramNotes",
  "twitterBanned", "discordBanned", "telegramBanned",
  "account2fa", "accountBackupCode",
  "twitterAccountBackupCode", "twitterEmail2fa", "twitterEmailBackupCode", "twitterRecovery2fa", "twitterRecoveryBackupCode",
  "discordAccountBackupCode", "discordEmail2fa", "discordEmailBackupCode", "discordRecovery2fa", "discordRecoveryBackupCode",
  "telegramAccountBackupCode", "telegramEmail2fa", "telegramEmailBackupCode", "telegramRecovery2fa", "telegramRecoveryBackupCode",
  "dataEntityId",
];

// Base scalar fields updatable via PATCH /vault/:id (the full multi-tab form)
// — hoisted to module scope so PATCH /vault/:id/field (single-field Change
// button) can reuse the exact same allow-list instead of duplicating it.
const BASE_VAULT_FIELDS = [
  "projectName", "email", "emailPassword",
  "twitterUsername", "twitterPassword",
  "discordUsername", "discordPassword",
  "telegramUsername", "telegramPassword",
  "notes",
  "currentValue", "currentBuyValue",
];

const DATE_FIELDS = new Set([
  "lastLoginAt", "buyDate", "createDate",
  "twitterLastLoginAt", "twitterBuyDate", "twitterCreateDate",
  "discordLastLoginAt", "discordBuyDate", "discordCreateDate",
  "telegramLastLoginAt", "telegramBuyDate", "telegramCreateDate",
]);

// Every plain scalar field eligible for the per-field "Change" button —
// everything PATCH /vault/:id can already touch, minus the JSON/array
// fields (walletAddresses, backupCodes, tags, otherAccounts) and fields
// with their own dedicated flow (seedPhrase, status, score, drive wallet),
// which keep their existing endpoints/UI instead.
const SINGLE_FIELD_EDITABLE = new Set<string>([...BASE_VAULT_FIELDS, ...(NEW_VAULT_FIELDS as string[]), "followers"]);

// Human-readable label for the commit-history feed — camelCase -> Title Case
// (e.g. "twitterEmailRecoveryPassword" -> "Twitter Email Recovery Password").
function fieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}

// ─── GET /vault — list user's vault entries ──────────────────────────────────
router.get("/vault", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entries = await selectVault(userId);
  res.json(entries.map(e => formatRow(e)));
});

// Chains checked for every entity's gas health — same six read-only RPC
// chains refresh-wallet-worth already sums for entity worth, since those are
// exactly the chains an entity's driveWalletAddress/walletAddresses could be
// live on.
const ENTITY_GAS_CHAINS = ["ETH", "BASE", "MATIC", "BSC", "ARB", "OP"] as const;

function addressesFor(entry: Record<string, unknown>): string[] {
  const walStr = (entry.wallet_addresses ?? entry.walletAddresses) as string | null | undefined;
  let addresses: string[] = [];
  try { addresses = walStr ? JSON.parse(walStr) : []; } catch { addresses = []; }
  const driveAddress = (entry.drive_wallet_address ?? entry.driveWalletAddress) as string | null | undefined;
  if (driveAddress) addresses = [...addresses, driveAddress];
  return addresses;
}

// ─── GET /vault/gas-overview — gas health across every one of the user's ────
// vault entities in one call. Powers the "Gas" tab on the entities list page:
// total native-coin (gas) value on hand, the worst risk level seen anywhere
// (drives a banner/badge), and a per-entity risk summary so at-a-glance you
// can see which entities are running low before a farmed account gets stuck
// mid-transaction with no gas to finish it.
router.get("/vault/gas-overview", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const { getGasOverview } = await import("../lib/gas-health");
    const entries = await selectVault(userId);

    const entitiesWithAddresses = entries
      .map((e) => ({ entry: e, addresses: addressesFor(e) }))
      .filter((x) => x.addresses.length > 0);

    const perEntity = await Promise.all(entitiesWithAddresses.map(async ({ entry, addresses }) => {
      const overview = await getGasOverview(addresses, [...ENTITY_GAS_CHAINS]);
      return {
        id: entry.id,
        projectName: entry.project_name ?? entry.projectName,
        totalUsd: overview.totalUsd,
        risk: overview.worstRisk,
        // only the chains that actually have a nonzero balance or an error —
        // no point listing 6 chains of "0 balance, healthy-by-default" noise
        chains: overview.snapshots.filter((s) => s.balance > 0 || s.error),
      };
    }));

    const totalUsd = parseFloat(perEntity.reduce((s, e) => s + e.totalUsd, 0).toFixed(2));
    const atRisk = perEntity.filter((e) => e.risk === "critical" || e.risk === "warning")
      .sort((a, b) => (a.risk === "critical" ? -1 : 1) - (b.risk === "critical" ? -1 : 1));

    res.json({
      totalUsd,
      entityCount: perEntity.length,
      atRiskCount: atRisk.length,
      atRisk,
      entities: perEntity,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Unable to load gas overview", detail: err?.message });
  }
});

// ─── GET /vault/:id/gas — gas health for one entity, per chain, with the ────
// same real-time simulation as the overview (live gas price + how many more
// native sends / ERC-20 transfers the current balance covers on each chain).
// This is what renders when an entity is clicked open onto its own Gas tab.
router.get("/vault/:id/gas", requireAuth, requireVaultEntryOwnership("vault_entry.gas.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;

  const entry = await selectVaultOne(id, userId);
  if (!entry) { res.status(404).json({ error: "Vault entry not found" }); return; }

  const addresses = addressesFor(entry);
  if (addresses.length === 0) {
    res.json({ totalUsd: 0, risk: "unknown", chains: [], message: "This entity has no wallet addresses to check" });
    return;
  }

  try {
    const { getGasOverview } = await import("../lib/gas-health");
    const overview = await getGasOverview(addresses, [...ENTITY_GAS_CHAINS]);
    res.json({
      totalUsd: overview.totalUsd,
      risk: overview.worstRisk,
      chains: overview.snapshots,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Unable to load gas health for this entity", detail: err?.message });
  }
});

// ─── POST /vault — create vault entry ────────────────────────────────────────
router.post("/vault", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const {
    projectName,
    username, accountPassword,
    email, emailPassword, email2fa, emailBackupCode,
    recovery2fa, recoveryBackupCode,
    lastLoginAt, buyDate, createDate,
    twitterUsername, twitterPassword,
    discordUsername, discordPassword,
    telegramUsername, telegramPassword,
    walletAddresses, backupCodes, notes, otherAccounts, tags,
    seedPhrase, // plaintext — will be encrypted before storage
    emailRecovery, emailRecoveryPassword,
    twitterEmail, twitterEmailPassword, twitterFollowers, twitter2fa,
    twitterEmailRecovery, twitterEmailRecoveryPassword, twitterAge, twitterWorth, twitterBuyValue,
    twitterLastLoginAt, twitterBuyDate, twitterCreateDate, twitterNotes,
    discordEmail, discordEmailPassword, discord2fa,
    discordEmailRecovery, discordEmailRecoveryPassword, discordFollowers, discordAge, discordWorth, discordBuyValue,
    discordLastLoginAt, discordBuyDate, discordCreateDate, discordNotes,
    telegramPhone, telegram2fa, telegramLinkedEmail, telegramLinkedEmailPassword, telegramAge, telegramWorth, telegramBuyValue,
    telegramFollowers, telegramLastLoginAt, telegramBuyDate, telegramCreateDate, telegramNotes,
    account2fa, accountBackupCode,
    twitterAccountBackupCode, twitterEmail2fa, twitterEmailBackupCode, twitterRecovery2fa, twitterRecoveryBackupCode,
    discordAccountBackupCode, discordEmail2fa, discordEmailBackupCode, discordRecovery2fa, discordRecoveryBackupCode,
    telegramAccountBackupCode, telegramEmail2fa, telegramEmailBackupCode, telegramRecovery2fa, telegramRecoveryBackupCode,
    score,
    dataEntityId,
  } = req.body;

  if (!projectName) {
    res.status(400).json({ error: "projectName is required" });
    return;
  }

  const serial = generateSerial(userId);
  const encryptedSeedPhrase = seedPhrase ? encryptSeedPhrase(seedPhrase) : null;

  const baseValues: Record<string, unknown> = {
    userId, entitySerial: serial, projectName,
    email: email || null, emailPassword: encryptField(emailPassword || null),
    twitterUsername: twitterUsername || null, twitterPassword: encryptField(twitterPassword || null),
    discordUsername: discordUsername || null, discordPassword: encryptField(discordPassword || null),
    telegramUsername: telegramUsername || null, telegramPassword: encryptField(telegramPassword || null),
    walletAddresses: walletAddresses ? JSON.stringify(walletAddresses) : null,
    backupCodes: encryptField(backupCodes ? JSON.stringify(backupCodes) : null),
    tags: Array.isArray(tags) ? JSON.stringify(tags) : null,
    notes: notes || null,
    otherAccounts: encryptField(otherAccounts || null),
    score: Math.max(0, Math.min(10, Number.isFinite(Number(score)) ? Number(score) : 5)),
  };

  let entry: Record<string, unknown>;
  try {
    const [row] = await db.insert(vaultEntriesTable).values({
      ...baseValues,
      encryptedSeedPhrase,
      username: username || null,
      accountPassword: encryptField(accountPassword || null),
      email2fa: encryptField(email2fa || null),
      emailBackupCode: encryptField(emailBackupCode || null),
      recovery2fa: encryptField(recovery2fa || null),
      recoveryBackupCode: encryptField(recoveryBackupCode || null),
      lastLoginAt: lastLoginAt ? new Date(lastLoginAt) : null,
      buyDate: buyDate ? new Date(buyDate) : null,
      createDate: createDate ? new Date(createDate) : null,
      emailRecovery: emailRecovery || null,
      emailRecoveryPassword: encryptField(emailRecoveryPassword || null),
      twitterEmail: twitterEmail || null,
      twitterEmailPassword: encryptField(twitterEmailPassword || null),
      twitterFollowers: twitterFollowers || null,
      twitter2fa: encryptField(twitter2fa || null),
      twitterEmailRecovery: twitterEmailRecovery || null,
      twitterEmailRecoveryPassword: encryptField(twitterEmailRecoveryPassword || null),
      twitterAge: twitterAge || null,
      twitterWorth: twitterWorth || null,
      twitterBuyValue: twitterBuyValue || null,
      twitterLastLoginAt: twitterLastLoginAt ? new Date(twitterLastLoginAt) : null,
      twitterBuyDate: twitterBuyDate ? new Date(twitterBuyDate) : null,
      twitterCreateDate: twitterCreateDate ? new Date(twitterCreateDate) : null,
      twitterNotes: twitterNotes || null,
      discordEmail: discordEmail || null,
      discordEmailPassword: encryptField(discordEmailPassword || null),
      discord2fa: encryptField(discord2fa || null),
      discordEmailRecovery: discordEmailRecovery || null,
      discordEmailRecoveryPassword: encryptField(discordEmailRecoveryPassword || null),
      discordFollowers: discordFollowers || null,
      discordAge: discordAge || null,
      discordWorth: discordWorth || null,
      discordBuyValue: discordBuyValue || null,
      discordLastLoginAt: discordLastLoginAt ? new Date(discordLastLoginAt) : null,
      discordBuyDate: discordBuyDate ? new Date(discordBuyDate) : null,
      discordCreateDate: discordCreateDate ? new Date(discordCreateDate) : null,
      discordNotes: discordNotes || null,
      telegramPhone: telegramPhone || null,
      telegram2fa: encryptField(telegram2fa || null),
      telegramLinkedEmail: telegramLinkedEmail || null,
      telegramLinkedEmailPassword: encryptField(telegramLinkedEmailPassword || null),
      telegramAge: telegramAge || null,
      telegramWorth: telegramWorth || null,
      telegramBuyValue: telegramBuyValue || null,
      telegramFollowers: telegramFollowers || null,
      telegramLastLoginAt: telegramLastLoginAt ? new Date(telegramLastLoginAt) : null,
      telegramBuyDate: telegramBuyDate ? new Date(telegramBuyDate) : null,
      telegramCreateDate: telegramCreateDate ? new Date(telegramCreateDate) : null,
      telegramNotes: telegramNotes || null,
      account2fa: encryptField(account2fa || null),
      accountBackupCode: encryptField(accountBackupCode || null),
      twitterAccountBackupCode: encryptField(twitterAccountBackupCode || null),
      twitterEmail2fa: encryptField(twitterEmail2fa || null),
      twitterEmailBackupCode: encryptField(twitterEmailBackupCode || null),
      twitterRecovery2fa: encryptField(twitterRecovery2fa || null),
      twitterRecoveryBackupCode: encryptField(twitterRecoveryBackupCode || null),
      discordAccountBackupCode: encryptField(discordAccountBackupCode || null),
      discordEmail2fa: encryptField(discordEmail2fa || null),
      discordEmailBackupCode: encryptField(discordEmailBackupCode || null),
      discordRecovery2fa: encryptField(discordRecovery2fa || null),
      discordRecoveryBackupCode: encryptField(discordRecoveryBackupCode || null),
      telegramAccountBackupCode: encryptField(telegramAccountBackupCode || null),
      telegramEmail2fa: encryptField(telegramEmail2fa || null),
      telegramEmailBackupCode: encryptField(telegramEmailBackupCode || null),
      telegramRecovery2fa: encryptField(telegramRecovery2fa || null),
      telegramRecoveryBackupCode: encryptField(telegramRecoveryBackupCode || null),
      dataEntityId: dataEntityId ? Number(dataEntityId) : null,
    } as typeof vaultEntriesTable.$inferInsert).returning();
    entry = row as unknown as Record<string, unknown>;
  } catch {
    // New columns not in Drizzle schema yet — insert without them
    const [row] = await db.insert(vaultEntriesTable).values(baseValues as typeof vaultEntriesTable.$inferInsert).returning();
    entry = row as unknown as Record<string, unknown>;
  }

  broadcastEvent("vault_updated", { action: "created", entryId: entry.id });
  logVaultActivity(Number(entry.id), userId, "created", projectName);
  autoCreateLocalAccountsForEntity(userId, Number(entry.id), req.body).catch(() => {});
  res.status(201).json(formatRow(entry));
});

// ─── GET /vault/tags — distinct tags used by this user, for filter UI ────────
router.get("/vault/tags", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const entries = await selectVault(userId);
    const set = new Set<string>();
    for (const e of entries) {
      const raw = (e as any).tags ?? (e as any).tags;
      if (!raw) continue;
      try {
        const arr = JSON.parse(raw as string);
        if (Array.isArray(arr)) for (const t of arr) if (typeof t === "string" && t.trim()) set.add(t.trim());
      } catch { /* skip malformed */ }
    }
    res.json({ tags: Array.from(set).sort((a, b) => a.localeCompare(b)) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch tags", detail: err?.message });
  }
});

// ─── Route Integration Roadmap — Season C, Phase C27 (bulk-family
// policy-engine consistency sweep) ────────────────────────────────────────
// `PATCH /vault/bulk-tag` and `PATCH /vault/bulk-action` were already
// correctly scoped — every per-id write below already goes through
// Drizzle's `and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId,
// userId))`, same posture as the raw-SQL `WHERE ... AND user_id = ...`
// routes in `bulk.ts`/`vault-shares.ts`. This phase does not change that —
// it adds the same `authorizeMany()`/`pepDecisionObserver` audit trail
// those files' bulk routes just got, using the vault_entries table's own
// `vault_entry` resource type (`vault-entity-links.ts`, C21) so decisions
// here correlate with every other vault_entry PEP check in the codebase.
// Both routes loop per-id already (never one batched UPDATE), so the audit
// step runs once up front over the full id list, then the existing per-id
// loop proceeds completely unchanged.
const vaultBulkOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultBulkOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

/**
 * Fetches each candidate vault_entries row's REAL owner — NOT filtered by
 * the caller's own userId — and runs one `authorizeMany()` batch over them
 * purely to produce an audited `AuthorizationDecision` per id. The route's
 * own pre-existing per-id loop (still filtered by userId, unchanged by
 * this phase) is what actually decides which rows get touched; this only
 * makes that same decision visible to the PDP/audit trail. Call for its
 * audit side-effect only — its return value is intentionally discarded.
 */
async function auditVaultBulkOwnership(req: Request, ids: number[], action: string): Promise<void> {
  if (!ids.length) return;
  const rows = await db.select({ id: vaultEntriesTable.id, userId: vaultEntriesTable.userId })
    .from(vaultEntriesTable).where(sql`${vaultEntriesTable.id} IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);
  if (!rows.length) return;
  await authorizeMany<number>({
    req,
    engine: vaultBulkOwnershipEngine,
    action,
    items: rows.map((row): { key: number; resource: ResourceRef } => ({
      key: Number(row.id),
      resource: { type: "vault_entry", id: Number(row.id), ownerId: row.userId != null ? Number(row.userId) : undefined },
    })),
  });
}

// ─── PATCH /vault/bulk-tag — add or remove a tag across multiple entries ─────
router.patch("/vault/bulk-tag", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { ids, tag, action } = req.body as { ids?: number[]; tag?: string; action?: "add" | "remove" };

  if (!Array.isArray(ids) || ids.length === 0) { res.status(400).json({ error: "ids (non-empty array) is required" }); return; }
  if (!tag || !String(tag).trim()) { res.status(400).json({ error: "tag is required" }); return; }
  const op = action === "remove" ? "remove" : "add";
  const cleanTag = String(tag).trim();

  const cleanIdsForAudit = ids.map(Number).filter(Number.isFinite);
  await auditVaultBulkOwnership(req, cleanIdsForAudit, `vault_entry.bulk.tag.${op}`);

  const results: { id: number; ok: boolean }[] = [];
  for (const rawId of ids) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) { results.push({ id: rawId as number, ok: false }); continue; }
    try {
      const raw = await selectVaultOne(id, userId);
      if (!raw) { results.push({ id, ok: false }); continue; }
      const formatted = formatRow(raw);
      const current: string[] = Array.isArray((formatted as any).tags) ? (formatted as any).tags : [];
      const next = op === "add"
        ? Array.from(new Set([...current, cleanTag]))
        : current.filter(t => t !== cleanTag);
      await db.update(vaultEntriesTable)
        .set({ tags: JSON.stringify(next), updatedAt: new Date() } as Partial<typeof vaultEntriesTable.$inferInsert>)
        .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
      results.push({ id, ok: true });
    } catch {
      results.push({ id, ok: false });
    }
  }

  broadcastEvent("vault_updated", { action: "bulk_tagged", entryIds: ids });
  res.json({ tag: cleanTag, action: op, results });
});

// ─── PATCH /vault/bulk-action — generic multi-select action (tag/status/delete) ─
// Single entry point for the vault.tsx selection action-bar. `action: "tag"`
// mirrors /vault/bulk-tag above (kept separately for backward compat — nothing
// else calls it, so this just avoids duplicating that logic inline). Every
// path is per-id + best-effort, same pattern as bulk-tag: one bad/missing id
// doesn't abort the rest of the batch, and the response reports per-id results
// so the client can tell the user "8 of 10 succeeded" instead of a flat pass/fail.
const BULK_ALLOWED_STATUSES = new Set(["active", "warning", "banned", "suspended"]);

router.patch("/vault/bulk-action", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { ids, action } = req.body as { ids?: number[]; action?: "tag" | "status" | "delete" };

  if (!Array.isArray(ids) || ids.length === 0) { res.status(400).json({ error: "ids (non-empty array) is required" }); return; }
  if (ids.length > 200) { res.status(400).json({ error: "Max 200 ids per bulk action" }); return; }
  const cleanIds = ids.map(Number).filter(Number.isFinite);
  if (cleanIds.length === 0) { res.status(400).json({ error: "No valid ids" }); return; }

  if (action === "tag") {
    const { tag, tagAction } = req.body as { tag?: string; tagAction?: "add" | "remove" };
    if (!tag || !String(tag).trim()) { res.status(400).json({ error: "tag is required" }); return; }
    const op = tagAction === "remove" ? "remove" : "add";
    const cleanTag = String(tag).trim();

    await auditVaultBulkOwnership(req, cleanIds, `vault_entry.bulk.tag.${op}`);

    const results: { id: number; ok: boolean }[] = [];
    for (const id of cleanIds) {
      try {
        const raw = await selectVaultOne(id, userId);
        if (!raw) { results.push({ id, ok: false }); continue; }
        const formatted = formatRow(raw);
        const current: string[] = Array.isArray((formatted as any).tags) ? (formatted as any).tags : [];
        const next = op === "add" ? Array.from(new Set([...current, cleanTag])) : current.filter(t => t !== cleanTag);
        await db.update(vaultEntriesTable)
          .set({ tags: JSON.stringify(next), updatedAt: new Date() } as Partial<typeof vaultEntriesTable.$inferInsert>)
          .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
        results.push({ id, ok: true });
      } catch {
        results.push({ id, ok: false });
      }
    }
    broadcastEvent("vault_updated", { action: "bulk_tagged", entryIds: cleanIds });
    res.json({ action: "tag", results });
    return;
  }

  if (action === "status") {
    const { status } = req.body as { status?: string };
    if (!status || !BULK_ALLOWED_STATUSES.has(status)) {
      res.status(400).json({ error: `status must be one of: ${Array.from(BULK_ALLOWED_STATUSES).join(", ")}` });
      return;
    }

    await auditVaultBulkOwnership(req, cleanIds, "vault_entry.bulk.update_status");

    const results: { id: number; ok: boolean }[] = [];
    for (const id of cleanIds) {
      try {
        const [row] = await db.update(vaultEntriesTable)
          .set({ status, lastActivityAt: new Date(), updatedAt: new Date() } as Partial<typeof vaultEntriesTable.$inferInsert>)
          .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
          .returning();
        if (!row) { results.push({ id, ok: false }); continue; }
        logVaultActivity(id, userId, "status_changed", `→ ${status}`);
        syncOnVaultStatusChange(id, status).catch(() => {});
        results.push({ id, ok: true });
      } catch {
        results.push({ id, ok: false });
      }
    }
    broadcastEvent("vault_updated", { action: "bulk_status", entryIds: cleanIds, status });
    res.json({ action: "status", status, results });
    return;
  }

  if (action === "delete") {
    // Soft-delete, same as DELETE /vault/:id — bulk delete shouldn't skip the
    // recycle bin just because it's going through a different route.
    await auditVaultBulkOwnership(req, cleanIds, "vault_entry.bulk.delete");

    const results: { id: number; ok: boolean }[] = [];
    for (const id of cleanIds) {
      try {
        const [row] = await db.update(vaultEntriesTable)
          .set({ deletedAt: new Date() })
          .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`))
          .returning();
        if (!row) { results.push({ id, ok: false }); continue; }
        logVaultActivity(id, userId, "trashed");
        delistVaultMarketplaceListings(id, "vault_entry_trashed").catch(() => {});
        results.push({ id, ok: true });
      } catch {
        results.push({ id, ok: false });
      }
    }
    broadcastEvent("vault_updated", { action: "bulk_trashed", entryIds: cleanIds });
    res.json({ action: "delete", results, retentionDays: VAULT_TRASH_RETENTION_DAYS });
    return;
  }

  res.status(400).json({ error: "action must be one of: tag, status, delete" });
});

// ─── GET /vault/health-report — dashboard panel: counts by health issue ─────
router.get("/vault/health-report", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const entries = await selectVault(userId);
    const formatted = entries.map(e => formatRow(e));

    let lowScore = 0, missing2fa = 0, inactive30d = 0, bannedOrSuspended = 0;
    const flagged: Record<string, unknown>[] = [];

    for (const f of formatted) {
      const input = toHealthInput(f);
      const hits = evalHealthRules(input);
      if (hits.length > 0) {
        flagged.push({
          id: (f as any).id,
          entitySerial: (f as any).entitySerial,
          projectName: (f as any).projectName,
          score: input.score,
          hits,
        });
      }
      if (hits.some(h => h.id === "low_score")) lowScore++;
      if (hits.some(h => h.id === "missing_2fa")) missing2fa++;
      if (hits.some(h => h.id === "inactive_30d")) inactive30d++;
      if (hits.some(h => h.id.startsWith("status_"))) bannedOrSuspended++;
    }

    res.json({
      totalEntries: formatted.length,
      counts: { lowScore, missing2fa, inactive30d, bannedOrSuspended },
      flaggedEntries: flagged,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate health report", detail: err?.message });
  }
});

// ─── POST /vault/health-check — run the rules engine across all of the ──────
// user's entries now (in addition to the automatic check on every PATCH),
// auto-recalculating scores and firing notifications for newly-flagged issues.
router.post("/vault/health-check", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const entries = await selectVault(userId);
    await Promise.all(entries.map(e => runHealthCheck(Number((e as any).id), userId, true).catch(() => {})));
    res.json({ checked: entries.length });
  } catch (err: any) {
    res.status(500).json({ error: "Health check failed", detail: err?.message });
  }
});

// ─── GET /vault/analytics — portfolio overview, per-platform breakdown, ─────
// value trend, and best/worst performers by ROI.
router.get("/vault/analytics", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const entries = (await selectVault(userId)).map(e => formatRow(e));

    const totalValue = entries.reduce((s, e: any) => s + (Number(e.currentValue) || 0), 0);
    const totalBuyValue = entries.reduce((s, e: any) => s + (Number(e.currentBuyValue) || 0), 0);
    const avgScore = entries.length ? entries.reduce((s, e: any) => s + (Number(e.score) || 0), 0) / entries.length : 0;

    const byProject: Record<string, { count: number; totalValue: number; totalBuyValue: number; avgScore: number }> = {};
    for (const e of entries as any[]) {
      const key = e.projectName || "Untitled";
      if (!byProject[key]) byProject[key] = { count: 0, totalValue: 0, totalBuyValue: 0, avgScore: 0 };
      byProject[key].count++;
      byProject[key].totalValue += Number(e.currentValue) || 0;
      byProject[key].totalBuyValue += Number(e.currentBuyValue) || 0;
      byProject[key].avgScore += Number(e.score) || 0;
    }
    for (const key of Object.keys(byProject)) {
      byProject[key].avgScore = byProject[key].count ? byProject[key].avgScore / byProject[key].count : 0;
    }

    const platformWorth = (field: "twitterWorth" | "discordWorth" | "telegramWorth", buyField: "twitterBuyValue" | "discordBuyValue" | "telegramBuyValue") => {
      let worth = 0, buy = 0, count = 0;
      for (const e of entries as any[]) {
        const w = Number(e[field]);
        const b = Number(e[buyField]);
        if (Number.isFinite(w) && w !== 0) { worth += w; count++; }
        if (Number.isFinite(b)) buy += b;
      }
      return { totalWorth: worth, totalBuyValue: buy, count };
    };
    const perPlatform = {
      twitter: platformWorth("twitterWorth", "twitterBuyValue"),
      discord: platformWorth("discordWorth", "discordBuyValue"),
      telegram: platformWorth("telegramWorth", "telegramBuyValue"),
    };

    const with2fa = entries.filter((e: any) => e.twitter2fa || e.discord2fa || e.telegram2fa || e.email2fa).length;
    const twofaCoveragePct = entries.length ? Math.round((with2fa / entries.length) * 100) : 0;

    const withRoi = (entries as any[])
      .filter(e => Number(e.currentBuyValue) > 0)
      .map(e => ({
        id: e.id,
        entitySerial: e.entitySerial,
        projectName: e.projectName,
        currentValue: Number(e.currentValue) || 0,
        currentBuyValue: Number(e.currentBuyValue) || 0,
        roiPct: ((Number(e.currentValue) - Number(e.currentBuyValue)) / Number(e.currentBuyValue)) * 100,
      }))
      .sort((a, b) => b.roiPct - a.roiPct);

    res.json({
      overview: {
        totalEntries: entries.length,
        totalVaultWorth: totalValue,
        totalBuyValue,
        netPnl: totalValue - totalBuyValue,
        avgScore: Math.round(avgScore * 10) / 10,
        twofaCoveragePct,
      },
      byProject,
      perPlatform,
      bestPerforming: withRoi.slice(0, 5),
      worstPerforming: withRoi.slice(-5).reverse(),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch analytics", detail: err?.message });
  }
});

// ─── GET /vault/analytics/value-history — value_history rows for charting ───
router.get("/vault/analytics/value-history", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const { valueHistoryTable } = await import("@workspace/db");
    const rows = await db.select().from(valueHistoryTable)
      .where(and(eq(valueHistoryTable.userId, userId), eq(valueHistoryTable.sourceType, "vault")))
      .orderBy(valueHistoryTable.createdAt);
    res.json(rows.map((r: any) => ({ ...r, createdAt: r.createdAt.toISOString() })));
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch value history", detail: err?.message });
  }
});

// ─── GET /vault/activity — my Vault activity feed (owner, paginated) ────────
// Powers the "Activity Log" item in the Vault sidebar (Other group) — every
// row is scoped to the current user's own vault_activity_log entries only
// (entity views + creates/updates/deletes/seed-reveals/status changes),
// distinct from GET /admin/vault/activity which is the admin-wide feed across
// every user. Joined with vault_entries so each row can show which entity
// ("page") was touched, not just an id.
// NOTE: must be registered before GET /vault/:id below — otherwise Express
// would match "activity" as the :id param and this route would never fire
// (same reason /vault/analytics/value-history above is also a static path
// registered ahead of the :id catch-all).
router.get("/vault/activity", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
  const offset = (pageNum - 1) * limitNum;
  try {
    const rows = await db
      .select({
        log: vaultActivityLogTable,
        entitySerial: vaultEntriesTable.entitySerial,
        entityId: vaultEntriesTable.id,
      })
      .from(vaultActivityLogTable)
      .leftJoin(vaultEntriesTable, eq(vaultActivityLogTable.vaultEntryId, vaultEntriesTable.id))
      .where(eq(vaultActivityLogTable.userId, userId))
      .orderBy(desc(vaultActivityLogTable.createdAt))
      .limit(limitNum)
      .offset(offset);

    const [{ count }] = await db.execute(sql`
      SELECT COUNT(*)::int as count FROM vault_activity_log WHERE user_id = ${userId}
    `).then(r => r.rows as { count: number }[]);

    res.json({
      entries: rows.map(({ log, entitySerial, entityId }) => ({
        ...log,
        createdAt: log.createdAt.toISOString(),
        entitySerial: entitySerial ?? null,
        entityId: entityId ?? null,
      })),
      total: count ?? rows.length,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch Vault activity", detail: err?.message });
  }
});

// ─── GET /vault/trash — list this user's soft-deleted entries ───────────────
// Must be registered before GET /vault/:id below — both are 2 path segments
// ("/vault/trash" vs "/vault/:id"), and Express matches registration order
// within the same segment shape, so "trash" would otherwise be swallowed as
// an :id.
router.get("/vault/trash", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entries = await selectVaultTrash(userId);
  res.json(entries.map(e => {
    const row = formatRow(e);
    const deletedAt = row.deletedAt ? new Date(row.deletedAt as string) : null;
    const purgeAt = deletedAt ? new Date(deletedAt.getTime() + VAULT_TRASH_RETENTION_DAYS * 86400000).toISOString() : null;
    return { ...row, purgeAt };
  }));
});

// ─── GET /vault/:id — get single entry ───────────────────────────────────────
// PHASE 5 (admin credit console request): entity view is now a metered
// action (sylo.vault_entity_view) — charge-on-success, same two-step
// pattern as every other integration point in services/credit-meter.ts.
router.get("/vault/:id", requireAuth, requireVaultEntryOwnership("vault_entry.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), requireCreditBalance("sylo.vault_entity_view"), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const entry = await selectVaultOne(id, userId);
  if (!entry) { res.status(404).json({ error: "Vault entry not found" }); return; }
  // Page-access tracking for the Vault Activity Log (sidebar → Other →
  // Activity Log) — records that this entity's detail page was opened, not
  // just that it was edited. Best-effort, never blocks the response.
  const serial = (entry as any).entity_serial ?? (entry as any).entitySerial ?? undefined;
  logVaultActivity(id, userId, "viewed", serial);
  // Charge-on-success: only now that the entry was actually found/returned.
  // A 404 above never touches the ledger.
  const charge = await chargeCredits(userId, "sylo.vault_entity_view");
  res.json({ ...formatRow(entry), _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null });
});

// ─── GET /vault/:id/seed — reveal decrypted seed phrase (explicit opt-in) ───
// Requires a fresh, single-use reveal token minted by a successful entity-PIN
// verify (POST /vault/security/verify, kind="entity") — see routes/
// vault-security.ts. Closes the gap where requireAuth alone (i.e. a merely
// valid session) was enough to pull a plaintext seed phrase with no PIN
// check at all, bypassing the frontend gate entirely. Users who haven't set
// an entity PIN keep the old "nothing to gate on" behavior.
//
// PHASE 5 (admin credit console request): revealing the credential/seed is
// the highest-stakes read in Sylo, so it's the pricier of the two new vault
// actions (sylo.credential_access vs. sylo.vault_entity_view above).
//
// PHASE 8 (Organization Accounts): also gated on the caller's org
// extension policy — see the org-membership check inside the handler.
router.get("/vault/:id/seed", requireAuth, requireVaultEntryOwnership("vault_entry.seed.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), requireCreditBalance("sylo.credential_access"), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;

  // Phase 8 — managed extension policy (master plan §2/§9). An org
  // owner/admin can set organization_extension_policies.disable_seed_reveal
  // to block this endpoint for every ACTIVE member of that org, regardless
  // of which entity they're revealing — enforced here server-side (not
  // just an Astra UI toggle) since this route is the actual seed-reveal
  // choke point every other read/autofill path already goes through. Any
  // one org membership with the flag set is enough to block; a user who
  // wants seed reveal back has to leave that org or ask an admin to relax
  // the policy, not bypass it entity-by-entity.
  const orgBlock = (await db.execute(sql`
    SELECT 1 FROM organization_members om
    JOIN organization_extension_policies oep ON oep.organization_id = om.organization_id
    WHERE om.user_id = ${userId} AND om.status = 'active' AND oep.disable_seed_reveal = TRUE
    LIMIT 1
  `)).rows;
  if (orgBlock.length) {
    res.status(403).json({
      error: "Seed phrase reveal is disabled by your organization's extension policy",
      code: "ORG_SEED_REVEAL_DISABLED",
    });
    return;
  }

  const pinless = await hasNoEntityPin(userId);
  if (!pinless) {
    const token = (req.header("x-reveal-token") ?? req.query.revealToken) as string | undefined;
    if (!consumeRevealToken(userId, token)) {
      res.status(403).json({
        error: "Reveal token missing or expired",
        code: "REVEAL_TOKEN_REQUIRED",
        solution: "Verify your entity PIN again — the reveal token is single-use and expires quickly.",
      });
      return;
    }
  }

  const entry = await selectVaultOne(id, userId);
  if (!entry) { res.status(404).json({ error: "Vault entry not found" }); return; }
  const encSeed = entry.encrypted_seed_phrase ?? entry.encryptedSeedPhrase ?? null;
  if (!encSeed) { res.status(404).json({ error: "No seed phrase stored for this entity" }); return; }
  const plaintext = decryptSeedPhrase(encSeed as string);
  if (!plaintext) { res.status(500).json({ error: "Failed to decrypt seed phrase" }); return; }
  logVaultActivity(id, userId, "seed_revealed");
  // Charge-on-success: only after the seed was actually decrypted and is
  // about to be returned — a missing seed / decrypt failure above never
  // costs the user credits.
  const charge = await chargeCredits(userId, "sylo.credential_access");
  res.json({ seedPhrase: plaintext, _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null });
});

// ─── PATCH /vault/:id/drive-wallet — set the fixed Drive wallet record ───────
// Wallet → Drive is a one-time, unedited fixed record (per spec): once set,
// it can never be changed or cleared through this endpoint.
router.patch("/vault/:id/drive-wallet", requireAuth, requireVaultEntryOwnership("vault_entry.drive_wallet.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const { label, address, note } = req.body;
  if (!address || !String(address).trim()) { res.status(400).json({ error: "Wallet address is required" }); return; }

  const entry = await selectVaultOne(id, userId);
  if (!entry) { res.status(404).json({ error: "Vault entry not found" }); return; }
  const alreadySet = entry.drive_wallet_set_at ?? (entry as any).driveWalletSetAt ?? entry.drive_wallet_address ?? (entry as any).driveWalletAddress;
  if (alreadySet) { res.status(409).json({ error: "Drive wallet is already set and cannot be edited" }); return; }

  try {
    const [row] = await db.update(vaultEntriesTable)
      .set({
        driveWalletLabel: label || null,
        driveWalletAddress: String(address).trim(),
        driveWalletNote: note || null,
        driveWalletSetAt: new Date(),
        updatedAt: new Date(),
      } as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { res.status(404).json({ error: "Vault entry not found" }); return; }
    logVaultActivity(id, userId, "drive_wallet_set");
    res.json(formatRow(row as unknown as Record<string, unknown>));
  } catch (err: any) {
    res.status(500).json({ error: "Unable to save drive wallet", detail: err?.message });
  }
});

// ─── POST /vault/validate-key — pre-save seed phrase / private key check ────
// Validates the credential entered in the entity form's "Add Private Key"
// field *before* it gets encrypted and saved, so the user finds out
// immediately if they mistyped a word or dropped a character, instead of
// discovering it later when something tries to derive an address from a
// silently-broken value. Pure offline BIP-39 / secp256k1 check — see
// lib/wallet-key-validation.ts. No entity id needed; this runs against
// whatever is currently typed into the create/edit form.
router.post("/vault/validate-key", requireAuth, async (req, res): Promise<void> => {
  const { value } = req.body as { value?: string };
  if (typeof value !== "string" || !value.trim()) {
    res.status(400).json({ error: "value is required" });
    return;
  }
  const { validateWalletKey } = await import("../lib/wallet-key-validation");
  res.json(validateWalletKey(value));
});

// ─── POST /vault/:id/refresh-wallet-worth — live multi-chain balance pull ────
// Reads every address in walletAddresses + driveWalletAddress, checks each one
// against ETH/BASE/MATIC/BSC/ARB/OP via read-only RPC (ethers v6, same pattern
// as routes/wallets.ts), sums native-coin USD value, and stores it on
// walletWorthUsd — no manual worth entry needed for the wallet portion.
router.post("/vault/:id/refresh-wallet-worth", requireAuth, requireVaultEntryOwnership("vault_entry.wallet_worth.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;

  const entry = await selectVaultOne(id, userId);
  if (!entry) { res.status(404).json({ error: "Vault entry not found" }); return; }

  const rawWalletAddresses = (entry as any).wallet_addresses ?? (entry as any).walletAddresses;
  let addresses: string[] = [];
  try { addresses = rawWalletAddresses ? JSON.parse(rawWalletAddresses as string) : []; } catch { addresses = []; }
  const driveAddress = (entry as any).drive_wallet_address ?? (entry as any).driveWalletAddress;
  if (driveAddress) addresses = [...addresses, driveAddress];

  if (addresses.length === 0) {
    res.status(400).json({ error: "This entity has no wallet addresses to check" }); return;
  }

  try {
    const { getMultiChainWalletWorth } = await import("../lib/chain-balance");
    const summary = await getMultiChainWalletWorth(addresses);

    const [row] = await db.update(vaultEntriesTable)
      .set({
        walletWorthUsd: summary.totalUsd,
        walletWorthSyncedAt: new Date(),
        updatedAt: new Date(),
      } as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { res.status(404).json({ error: "Vault entry not found" }); return; }

    logVaultActivity(id, userId, "wallet_worth_refreshed");
    res.json({
      walletWorthUsd: summary.totalUsd,
      walletWorthSyncedAt: (row as any).walletWorthSyncedAt,
      breakdown: summary.results.filter((r) => r.balance > 0 || r.error),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Unable to refresh live wallet worth", detail: err?.message });
  }
});

// ─── PATCH /vault/:id — update vault entry ───────────────────────────────────
router.patch("/vault/:id", requireAuth, requireVaultEntryOwnership("vault_entry.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;

  const baseFields = BASE_VAULT_FIELDS;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const f of baseFields) {
    if (req.body[f] !== undefined) updates[f] = SENSITIVE_VAULT_FIELDS.has(f) ? encryptField(req.body[f]) : req.body[f];
  }
  for (const f of NEW_VAULT_FIELDS) {
    if (req.body[f] === undefined) continue;
    if (DATE_FIELDS.has(f)) { updates[f] = req.body[f] ? new Date(req.body[f]) : null; continue; }
    updates[f] = SENSITIVE_VAULT_FIELDS.has(f) ? encryptField(req.body[f]) : req.body[f];
  }
  if (req.body.followers !== undefined) {
    const n = Number(req.body.followers);
    if (Number.isFinite(n)) updates.followers = Math.max(0, Math.round(n));
  }
  if (req.body.dataEntityId !== undefined) {
    updates.dataEntityId = req.body.dataEntityId ? Number(req.body.dataEntityId) : null;
  }
  if (req.body.walletAddresses !== undefined) updates.walletAddresses = JSON.stringify(req.body.walletAddresses);
  if (req.body.backupCodes !== undefined) updates.backupCodes = encryptField(JSON.stringify(req.body.backupCodes));
  if (req.body.tags !== undefined) updates.tags = JSON.stringify(Array.isArray(req.body.tags) ? req.body.tags : []);
  if (req.body.otherAccounts !== undefined) updates.otherAccounts = encryptField(req.body.otherAccounts);
  if (req.body.seedPhrase !== undefined) {
    updates.encryptedSeedPhrase = req.body.seedPhrase ? encryptSeedPhrase(req.body.seedPhrase) : null;
  }
  if (req.body.status !== undefined) {
    const allowed = ["active", "warning", "banned", "suspended"];
    if (allowed.includes(req.body.status)) {
      updates.status = req.body.status;
      updates.lastActivityAt = new Date();
    }
  }
  if (req.body.score !== undefined) {
    const n = Number(req.body.score);
    if (Number.isFinite(n)) updates.score = Math.max(0, Math.min(10, Math.round(n)));
  }
  if (req.body.currentValue !== undefined) {
    const n = Number(req.body.currentValue);
    if (Number.isFinite(n)) updates.currentValue = n;
  }
  if (req.body.currentBuyValue !== undefined) {
    const n = Number(req.body.currentBuyValue);
    if (Number.isFinite(n)) updates.currentBuyValue = n;
  }

  let entry: Record<string, unknown>;
  try {
    const [row] = await db.update(vaultEntriesTable)
      .set(updates as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { res.status(404).json({ error: "Vault entry not found" }); return; }
    entry = row as unknown as Record<string, unknown>;
  } catch {
    // Strip new fields and retry with base fields only
    for (const f of NEW_VAULT_FIELDS) delete updates[f];
    delete updates.encryptedSeedPhrase;
    delete updates.status;
    delete updates.lastActivityAt;
    delete updates.followers;
    delete updates.tags;
    delete updates.lastHealthAlertAt;
    delete updates.lastHealthFlags;
    const [row] = await db.update(vaultEntriesTable)
      .set(updates as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { res.status(404).json({ error: "Vault entry not found" }); return; }
    entry = row as unknown as Record<string, unknown>;
  }

  broadcastEvent("vault_updated", { action: "updated", entryId: id });
  autoCreateLocalAccountsForEntity(userId, id, req.body).catch(() => {});
  // Health Monitor: auto-recalculate score (unless the client sent one explicitly)
  // and check health rules, firing a notification only for newly-triggered issues.
  runHealthCheck(id, userId, req.body.score === undefined).catch(() => {});
  if (req.body.status !== undefined) {
    logVaultActivity(id, userId, "status_changed", `→ ${req.body.status}`);
    // Sync: propagate status change to marketplace (auto-delist if banned/suspended)
    syncOnVaultStatusChange(id, req.body.status).catch(() => {});
  } else {
    logVaultActivity(id, userId, "updated");
    // Sync: refresh stale marketplace listing previews for this entry
    syncOnVaultUpdate(id).catch(() => {});
  }
  res.json(formatRow(entry));
});

// ─── PATCH /vault/:id/field — update exactly one field, with commit history ──
// Powers the per-field "Change" button on the entity detail page (per
// platform tab, per field): edit one credential/value in place instead of
// the whole multi-tab form. Body: { field: string, value: unknown }. The
// old → new value is recorded in vault_field_history — see
// GET /vault/:id/field-history for the commit log this powers.
router.patch("/vault/:id/field", requireAuth, requireVaultEntryOwnership("vault_entry.field.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;

  const { field, value } = req.body as { field?: string; value?: unknown };
  if (!field || !SINGLE_FIELD_EDITABLE.has(field)) {
    res.status(400).json({ error: "Unknown or non-editable field" }); return;
  }

  const [existing] = await db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  if (!existing) { res.status(404).json({ error: "Vault entry not found" }); return; }

  const isSensitive = SENSITIVE_VAULT_FIELDS.has(field);
  const isDate = DATE_FIELDS.has(field);
  const isFollowers = field === "followers";

  let columnValue: unknown;
  let newDisplay: string | null;
  if (isDate) {
    columnValue = value ? new Date(value as string) : null;
    newDisplay = columnValue ? (columnValue as Date).toISOString() : null;
  } else if (isFollowers) {
    const n = Number(value);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "followers must be a number" }); return; }
    columnValue = Math.max(0, Math.round(n));
    newDisplay = String(columnValue);
  } else {
    const plain = value === "" || value == null ? null : String(value);
    columnValue = isSensitive ? encryptField(plain) : plain;
    newDisplay = plain;
  }

  // Old value, decrypted/formatted the same way the entity's own read path
  // (formatRow) would show it, so the commit-history entry is readable.
  const oldRaw = (existing as unknown as Record<string, unknown>)[field];
  let oldDisplay: string | null;
  if (isSensitive) oldDisplay = decryptField((oldRaw ?? null) as string | null);
  else if (isDate) oldDisplay = oldRaw ? new Date(oldRaw as string).toISOString() : null;
  else oldDisplay = oldRaw != null ? String(oldRaw) : null;

  try {
    const [row] = await db.update(vaultEntriesTable)
      .set({ [field]: columnValue, updatedAt: new Date() } as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { res.status(404).json({ error: "Vault entry not found" }); return; }

    // Commit history — old/new values encrypted at rest (same helper as the
    // live column), decrypted only for the owner on GET /vault/:id/field-history.
    db.insert(vaultFieldHistoryTable).values({
      vaultEntryId: id, userId, field,
      oldValue: encryptField(oldDisplay),
      newValue: encryptField(newDisplay),
    }).catch((err) => console.error("vault field history log failed:", err));

    broadcastEvent("vault_updated", { action: "field_updated", entryId: id, field });
    logVaultActivity(id, userId, "field_updated", `${fieldLabel(field)} changed`);
    autoCreateLocalAccountsForEntity(userId, id, { [field]: value }).catch(() => {});
    runHealthCheck(id, userId, true).catch(() => {});
    syncOnVaultUpdate(id).catch(() => {});

    res.json(formatRow(row as unknown as Record<string, unknown>));
  } catch (err: any) {
    res.status(500).json({ error: "Unable to update field", detail: err?.message });
  }
});

// ─── GET /vault/:id/field-history — per-field commit history (owner only) ───
// Query: ?field=twitterPassword to filter to one field's history, omit for
// the full per-field change feed on this entity. Newest first.
router.get("/vault/:id/field-history", requireAuth, requireVaultEntryOwnership("vault_entry.field_history.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const fieldFilter = (req.query.field as string) || undefined;

  const [existing] = await db.select({ id: vaultEntriesTable.id }).from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  if (!existing) { res.status(404).json({ error: "Vault entry not found" }); return; }

  try {
    const rows = await db.select().from(vaultFieldHistoryTable)
      .where(fieldFilter
        ? and(eq(vaultFieldHistoryTable.vaultEntryId, id), eq(vaultFieldHistoryTable.field, fieldFilter))
        : eq(vaultFieldHistoryTable.vaultEntryId, id))
      .orderBy(desc(vaultFieldHistoryTable.changedAt))
      .limit(200);
    res.json(rows.map((r) => ({
      id: r.id,
      field: r.field,
      fieldLabel: fieldLabel(r.field),
      oldValue: decryptField(r.oldValue),
      newValue: decryptField(r.newValue),
      changedAt: r.changedAt.toISOString(),
    })));
  } catch (err: any) {
    res.status(500).json({ error: "Unable to load field history", detail: err?.message });
  }
});

// ─── DELETE /vault/:id — delete vault entry ──────────────────────────────────
// ─── DELETE /vault/trash — empty the whole trash for this user ──────────────
// Must be registered before DELETE /vault/:id below — same segment-shadowing
// reasoning as GET /vault/trash above ("/vault/trash" vs "/vault/:id").
router.delete("/vault/trash", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const trashed = await selectVaultTrash(userId);
  for (const row of trashed) {
    await hardDeleteVaultEntry(Number(row.id), userId);
  }
  broadcastEvent("vault_updated", { action: "trash_emptied" });
  res.json({ message: "Trash emptied", count: trashed.length });
});

// Soft-delete — moves the entry to the recycle bin (deleted_at = now) instead
// of removing the row. It disappears from every normal list/detail/health
// read immediately (selectVault* filters deleted_at IS NULL), but stays
// recoverable via POST /vault/:id/restore until the retention cron purges it.
router.delete("/vault/:id", requireAuth, requireVaultEntryOwnership("vault_entry.delete", (_req, res) => { res.status(404).json({ message: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const existing = await selectVaultOne(id, userId);
  if (!existing) { res.status(404).json({ message: "Vault entry not found" }); return; }
  await db.update(vaultEntriesTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  broadcastEvent("vault_updated", { action: "trashed", entryId: id });
  logVaultActivity(id, userId, "trashed");
  // Delist from the marketplace right away — a trashed entry shouldn't stay
  // sellable even during its recoverable window. Deliberately NOT calling
  // syncOnVaultDelete() here: it also prunes entity_project_roi rows, which
  // is a real (unrecoverable) delete and would defeat the point of a soft
  // delete if the entry gets restored. That full sync only runs on the
  // actual purge, in hardDeleteVaultEntry() below.
  delistVaultMarketplaceListings(id, "vault_entry_trashed").catch(() => {});
  res.json({ message: "Vault entry moved to trash", retentionDays: VAULT_TRASH_RETENTION_DAYS });
});

// ─── POST /vault/:id/restore — pull an entry back out of the trash ──────────
// 3 path segments, so registration order relative to "/vault/:id" (2
// segments) doesn't matter — Express only shadows routes with the same
// segment shape. Left here, right after the delete handler it undoes.
router.post("/vault/:id/restore", requireAuth, requireVaultEntryOwnership("vault_entry.restore", (_req, res) => { res.status(404).json({ message: "Trashed vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const trashed = await selectVaultTrashOne(id, userId);
  if (!trashed) { res.status(404).json({ message: "Trashed vault entry not found" }); return; }
  await db.update(vaultEntriesTable)
    .set({ deletedAt: null })
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  broadcastEvent("vault_updated", { action: "restored", entryId: id });
  logVaultActivity(id, userId, "restored");
  res.json({ message: "Vault entry restored" });
});

// ─── DELETE /vault/trash/:id — permanently purge one trashed entry ──────────
// Must be trashed first (deleted_at IS NOT NULL) — this is the only route
// that actually removes the row; DELETE /vault/:id above only soft-deletes.
// 3 segments — same non-shadowing reasoning as POST /vault/:id/restore above.
router.delete("/vault/trash/:id", requireAuth, requireVaultEntryOwnership("vault_entry.purge", (_req, res) => { res.status(404).json({ message: "Trashed vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const trashed = await selectVaultTrashOne(id, userId);
  if (!trashed) { res.status(404).json({ message: "Trashed vault entry not found" }); return; }
  await hardDeleteVaultEntry(id, userId);
  broadcastEvent("vault_updated", { action: "purged", entryId: id });
  res.json({ message: "Vault entry permanently deleted" });
});

// ─── GET /admin/vault — admin view of all entries ────────────────────────────
router.get("/admin/vault", requireAdmin, async (req, res): Promise<void> => {
  try {
    const entries = await db
      .select({ entry: vaultEntriesTable, username: usersTable.username, userEmail: usersTable.email })
      .from(vaultEntriesTable)
      .leftJoin(usersTable, eq(vaultEntriesTable.userId, usersTable.id));
    res.json(entries.map(({ entry, username, userEmail }) => ({
      ...formatRow(entry as unknown as Record<string, unknown>),
      username,
      userEmail,
    })));
  } catch {
    const rows = await selectVault(0);
    res.json(rows.map(e => formatRow(e)));
  }
});

// ─── GET /admin/vault/full — full unencrypted vault for admin ─────────────────
router.get("/admin/vault/full", requireAdmin, async (req, res): Promise<void> => {
  try {
    const entries = await db
      .select({ entry: vaultEntriesTable, username: usersTable.username, userEmail: usersTable.email })
      .from(vaultEntriesTable)
      .leftJoin(usersTable, eq(vaultEntriesTable.userId, usersTable.id));

    const result = entries.map(({ entry, username, userEmail }) => {
      const row = formatRow(entry as unknown as Record<string, unknown>);
      // Decrypt seed phrase for admin
      const encSeed = (entry as any).encrypted_seed_phrase ?? (entry as any).encryptedSeedPhrase ?? null;
      const seedPhrase = encSeed ? (decryptSeedPhrase(encSeed as string) ?? null) : null;
      return { ...row, seedPhrase, username, userEmail };
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch full vault", detail: err?.message });
  }
});

// ─── GET /admin/vault/local-accounts — all users' local accounts ──────────────
router.get("/admin/vault/local-accounts", requireAdmin, async (req, res): Promise<void> => {
  try {
    const result = await db.execute(sql`
      SELECT la.*, u.username, u.email as user_email
      FROM local_accounts la
      LEFT JOIN users u ON la.user_id = u.id
      ORDER BY la.created_at DESC
    `);
    res.json(decryptRows(result.rows as any[], ["password", "recovery_email_password", "backup_codes", "twofa", "recovery_email_twofa"]));
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch local accounts", detail: err?.message });
  }
});

// ─── GET /admin/vault/users — list of users with vault data counts ────────────
router.get("/admin/vault/users", requireAdmin, async (req, res): Promise<void> => {
  try {
    const result = await db.execute(sql`
      SELECT
        u.id, u.username, u.email,
        COUNT(DISTINCT ve.id)::int as entity_count,
        COUNT(DISTINCT la.id)::int as local_account_count
      FROM users u
      LEFT JOIN vault_entries ve ON ve.user_id = u.id
      LEFT JOIN local_accounts la ON la.user_id = u.id
      GROUP BY u.id, u.username, u.email
      HAVING COUNT(DISTINCT ve.id) > 0 OR COUNT(DISTINCT la.id) > 0
      ORDER BY entity_count DESC, u.username
    `);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch vault users", detail: err?.message });
  }
});

// ─── GET /admin/vault/users/:userId — specific user's full vault data ──────────
router.get("/admin/vault/users/:userId", requireAdmin, async (req, res): Promise<void> => {
  const targetId = parseInt(Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId, 10);
  if (isNaN(targetId)) { res.status(400).json({ error: "Invalid userId" }); return; }

  try {
    const [entities, localAccounts, userInfo] = await Promise.all([
      db.select().from(vaultEntriesTable).where(eq(vaultEntriesTable.userId, targetId)),
      db.execute(sql`SELECT * FROM local_accounts WHERE user_id = ${targetId} ORDER BY created_at DESC`),
      db.select().from(usersTable).where(eq(usersTable.id, targetId)),
    ]);

    const formattedEntities = entities.map(entry => {
      const row = formatRow(entry as unknown as Record<string, unknown>);
      const encSeed = (entry as any).encryptedSeedPhrase ?? null;
      const seedPhrase = encSeed ? (decryptSeedPhrase(encSeed as string) ?? null) : null;
      return { ...row, seedPhrase };
    });

    res.json({
      user: userInfo[0] ? { id: userInfo[0].id, username: userInfo[0].username, email: userInfo[0].email } : null,
      entities: formattedEntities,
      localAccounts: localAccounts.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch user vault", detail: err?.message });
  }
});

// ─── GET /vault/:id/activity — audit trail for one vault entry (owner only) ──
router.get("/vault/:id/activity", requireAuth, requireVaultEntryOwnership("vault_entry.activity.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const entry = await selectVaultOne(id, userId);
  if (!entry) { res.status(404).json({ error: "Vault entry not found" }); return; }
  try {
    const rows = await db.select().from(vaultActivityLogTable)
      .where(eq(vaultActivityLogTable.vaultEntryId, id))
      .orderBy(desc(vaultActivityLogTable.createdAt));
    res.json(rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })));
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch activity log", detail: err?.message });
  }
});

// ─── GET /admin/vault/activity — vault-wide audit feed (admin, paginated) ───
router.get("/admin/vault/activity", requireAdmin, async (req, res): Promise<void> => {
  const { page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
  const offset = (pageNum - 1) * limitNum;
  try {
    const rows = await db
      .select({ log: vaultActivityLogTable, username: usersTable.username })
      .from(vaultActivityLogTable)
      .leftJoin(usersTable, eq(vaultActivityLogTable.userId, usersTable.id))
      .orderBy(desc(vaultActivityLogTable.createdAt))
      .limit(limitNum)
      .offset(offset);
    res.json({
      entries: rows.map(({ log, username }) => ({ ...log, createdAt: log.createdAt.toISOString(), username: username ?? "Unknown" })),
      page: pageNum,
      limit: limitNum,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch activity feed", detail: err?.message });
  }
});

// ─── Public receipt link ──────────────────────────────────────────────────────
// One shareable, unauthenticated "PnL card" per Vault Entity — same idea as
// the Local Entity receipt (routes/local-accounts.ts) and the Finance
// ledger receipt (routes/finance.ts), but sourced from computeEntityWorth's
// aggregate across the entity + all linked platforms. Only "worth showing
// off" fields are exposed — no credentials, 2FA, backup codes, wallet
// addresses, or seed phrase, even though those are already encrypted at rest.

function generateVaultReceiptToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}
function vaultReceiptUrl(receiptToken: string): string {
  return `${process.env.APP_URL ?? "https://ayzen.replit.app"}/receipt/entity/${receiptToken}`;
}

// POST /vault/:id/receipt — mint (or fetch the existing) public link
router.post("/vault/:id/receipt", requireAuth, requireVaultEntryOwnership("vault_entry.receipt.create", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entity id" }); return; }
  try {
    const [row] = await db.select({ id: vaultEntriesTable.id, receiptToken: vaultEntriesTable.receiptToken })
      .from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`));
    if (!row) { res.status(404).json({ error: "Vault entry not found" }); return; }

    let token = row.receiptToken;
    if (!token) {
      for (let attempt = 0; attempt < 3 && !token; attempt++) {
        const candidate = generateVaultReceiptToken();
        try {
          const [updated] = await db.update(vaultEntriesTable)
            .set({ receiptToken: candidate, updatedAt: new Date() })
            .where(eq(vaultEntriesTable.id, id))
            .returning({ receiptToken: vaultEntriesTable.receiptToken });
          token = updated.receiptToken;
        } catch { /* unique collision — loop and retry */ }
      }
      if (!token) { res.status(500).json({ error: "Could not generate a receipt link, please try again" }); return; }
    }
    res.json({ token, url: vaultReceiptUrl(token) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create receipt link", detail: err?.message });
  }
});

// DELETE /vault/:id/receipt — revoke the public link
router.delete("/vault/:id/receipt", requireAuth, requireVaultEntryOwnership("vault_entry.receipt.delete", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entity id" }); return; }
  const [row] = await db.update(vaultEntriesTable)
    .set({ receiptToken: null, updatedAt: new Date() })
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
    .returning({ id: vaultEntriesTable.id });
  if (!row) { res.status(404).json({ error: "Vault entry not found" }); return; }
  res.json({ success: true });
});

async function findVaultEntryByReceiptToken(token: string) {
  const [entry] = await db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.receiptToken, token), sql`${vaultEntriesTable.deletedAt} IS NULL`)).limit(1);
  if (!entry) return null;
  const [owner] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, entry.userId)).limit(1);
  return { entry, issuedBy: owner?.username ?? null };
}

function fmtPublicVaultReceipt(entry: any, issuedBy: string | null) {
  const worth = computeEntityWorth(entry);
  const buyValue = computeEntityBuyValue(entry);
  const roiPct = computeEntityProfitPct(entry);
  return {
    id: entry.id,
    entitySerial: entry.entitySerial,
    projectName: entry.projectName,
    category: entry.category,
    username: entry.username,
    followers: entry.followers,
    age: computeAge(entry.createDate),
    worth,
    buyValue,
    profit: buyValue > 0 ? worth - buyValue : null,
    roiPct,
    status: entry.status,
    score: entry.score,
    issuedBy,
    generatedAt: new Date().toISOString(),
  };
}

// GET /vault/receipt/:token — public, no auth
router.get("/vault/receipt/:token", requirePublicAudit("vault_receipt.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findVaultEntryByReceiptToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  res.json(fmtPublicVaultReceipt(found.entry, found.issuedBy));
});

// GET /vault/receipt/:token/pdf — public, no auth
router.get("/vault/receipt/:token/pdf", requirePublicAudit("vault_receipt.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findVaultEntryByReceiptToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  const r = fmtPublicVaultReceipt(found.entry, found.issuedBy);
  const displayName = r.projectName || r.entitySerial || `Vault Entity #${r.id}`;

  streamFantasticReceiptPdf(res, {
    kicker: "Vault Entity Receipt",
    title: displayName,
    subtitle: [r.category, r.username ? `@${r.username}` : null].filter(Boolean).join(" · ") || r.entitySerial || undefined,
    avatarLetter: displayName,
    heroLabel: r.roiPct !== null ? "Profit & Loss" : "Total Worth",
    heroValue: r.roiPct !== null ? `${r.roiPct >= 0 ? "+" : ""}${r.roiPct.toFixed(1)}%` : `$${r.worth.toFixed(2)}`,
    heroPositive: r.roiPct !== null ? r.roiPct >= 0 : undefined,
    stats: [
      { label: "Username", value: r.username || "—" },
      { label: "Followers", value: r.followers ? String(r.followers) : "—" },
      { label: "Account Age", value: r.age ?? "—" },
      { label: "Total Worth", value: `$${r.worth.toFixed(2)}`, color: "#0f9d58" },
      { label: "Buy Value", value: `$${r.buyValue.toFixed(2)}` },
      { label: "Net Profit", value: r.profit !== null ? `${r.profit >= 0 ? "+" : ""}$${r.profit.toFixed(2)}` : "—", color: r.profit !== null ? (r.profit >= 0 ? "#0f9d58" : "#e4453a") : undefined },
    ],
    receiptId: r.id,
    issuedBy: r.issuedBy,
    filenamePrefix: "vault-entity",
  });
});

export default router;
