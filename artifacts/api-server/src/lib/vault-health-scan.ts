/**
 * lib/vault-health-scan.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault Health Monitor — proactive daily scan (upgrade over the on-demand
 * checker in routes/vault.ts, which only runs when the owner saves/updates
 * an entry). This runs on a cron schedule regardless of whether anyone logs
 * in, so risk (stale login, missing 2FA, no recovery email, banned/suspended
 * status) surfaces via Telegram + email even for accounts nobody has opened
 * in weeks.
 *
 * Covers all five vault surfaces, each against its own background-rule
 * evaluator in vault-health.ts, all folded into one per-user digest:
 *   - Entity        — evalBackgroundHealthRules()             (vault_entries)
 *   - KYC Entity     — evalKycBackgroundHealthRules()          (kyc_entries)
 *   - Wallet         — evalWalletBackgroundHealthRules()       (wallets)
 *   - Local Account  — evalLocalAccountBackgroundHealthRules() (local_accounts)
 *   - Data Entity    — evalDataEntityBackgroundHealthRules()   (kyc_data_entities)
 *
 * Reuses formatRow()/toHealthInput() from routes/vault.ts for the Entity
 * pass specifically, so that decryption/field-mapping logic keeps exactly
 * one implementation. The other four types don't need decryption for a
 * presence check (an encrypted non-null value is still non-null), so they
 * read straight off the row.
 */

import { db, vaultEntriesTable, walletsTable, usersTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { formatRow, toHealthInput, selectAllVaultEntries } from "../routes/vault";
import {
  evalBackgroundHealthRules, severityEmoji, type HealthRuleHit,
  evalKycBackgroundHealthRules, evalWalletBackgroundHealthRules, evalLocalAccountBackgroundHealthRules,
  evalDataEntityBackgroundHealthRules,
} from "./vault-health";
import { createNotification } from "../routes/notifications";
import { sendToUser } from "./telegram";
import { sendVaultHealthDigestEmail } from "./email";

interface FlaggedEntry {
  entryId: number;
  label: string;
  hits: HealthRuleHit[];
}

export interface DailyScanResult {
  entriesScanned: number;
  entriesFlagged: number;
  usersAlerted: number;
}

/** Best-effort per-entry DB update — never throws, mirrors runHealthCheck()'s pattern. */
async function persistFlags(entryId: number, userId: number, currentIds: string[]): Promise<void> {
  const dbUpdates: Record<string, unknown> = { lastHealthFlags: JSON.stringify(currentIds) };
  if (currentIds.length > 0) dbUpdates.lastHealthAlertAt = new Date();
  try {
    await db.update(vaultEntriesTable)
      .set(dbUpdates as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, entryId), eq(vaultEntriesTable.userId, userId)));
  } catch (err) {
    logger.warn({ err, entryId }, "vault-health-scan: failed to persist flags");
  }
}

// kyc_entries, local_accounts, and kyc_data_entities have no drizzle schema
// object (raw-SQL tables throughout routes/kyc.ts, routes/kyc-data-entities.ts
// etc — same pattern used here rather than introducing a schema just for
// this write). wallets does have walletsTable, so that one goes through the
// query builder.
async function persistRawFlags(table: "kyc_entries" | "local_accounts" | "kyc_data_entities", entryId: number, userId: number, currentIds: string[]): Promise<void> {
  const flagsJson = JSON.stringify(currentIds).replace(/'/g, "''");
  const alertClause = currentIds.length > 0 ? ", last_health_alert_at = NOW()" : "";
  try {
    await db.execute(sql.raw(
      `UPDATE ${table} SET last_health_flags = '${flagsJson}'${alertClause} WHERE id = ${entryId} AND user_id = ${userId}`
    ));
  } catch (err) {
    logger.warn({ err, table, entryId }, "vault-health-scan: failed to persist flags");
  }
}

async function persistWalletFlags(entryId: number, userId: number, currentIds: string[]): Promise<void> {
  const dbUpdates: Record<string, unknown> = { lastHealthFlags: JSON.stringify(currentIds) };
  if (currentIds.length > 0) dbUpdates.lastHealthAlertAt = new Date();
  try {
    await db.update(walletsTable)
      .set(dbUpdates as Partial<typeof walletsTable.$inferInsert>)
      .where(and(eq(walletsTable.id, entryId), eq(walletsTable.userId, userId)));
  } catch (err) {
    logger.warn({ err, entryId }, "vault-health-scan: failed to persist wallet flags");
  }
}

/**
 * Runs the full sweep: every vault entry, every owner, once. Grouped so each
 * user gets a single digest (Telegram + email + in-app notification) instead
 * of one message per at-risk entity — this runs daily and unattended, so a
 * user with 10 stale entries shouldn't get 10 pings.
 */
export async function runDailyHealthScan(): Promise<DailyScanResult> {
  const rows = await selectAllVaultEntries();
  const flaggedByUser = new Map<number, FlaggedEntry[]>();
  let entriesFlagged = 0;

  for (const raw of rows) {
    let userId: number | null = null;
    try {
      const formatted = formatRow(raw);
      userId = Number((formatted as any).userId);
      const input = toHealthInput(formatted);
      const hits = evalBackgroundHealthRules(input);

      // Persist regardless of hit count so a resolved issue clears from
      // last_health_flags (keeps it consistent with the on-demand path).
      await persistFlags(Number((formatted as any).id), userId, hits.map((h) => h.id));

      if (hits.length === 0) continue;
      entriesFlagged++;

      const label = `${(formatted as any).category} — ${(formatted as any).projectName}`;
      const list = flaggedByUser.get(userId) ?? [];
      list.push({ entryId: Number((formatted as any).id), label, hits });
      flaggedByUser.set(userId, list);
    } catch (err) {
      logger.warn({ err, userId }, "vault-health-scan: entry check failed, skipping");
    }
  }

  // ── KYC Entity ──────────────────────────────────────────────────────────
  const kycRows = (await db.execute(sql.raw(`SELECT * FROM kyc_entries`))).rows as any[];
  for (const k of kycRows) {
    try {
      const userId = Number(k.user_id);
      const hits = evalKycBackgroundHealthRules({
        hasEmail2fa: !!k.email_2fa,
        hasAccountTwofa: !!k.account_2fa,
        hasEmailBackup: !!k.email_backup_code,
        hasAccountBackup: !!k.account_backup_code,
        hasRecoveryEmail: !!k.email_recovery,
        lastLoginAt: k.last_login_at ?? null,
        status: k.status ?? "active",
      });
      await persistRawFlags("kyc_entries", Number(k.id), userId, hits.map((h) => h.id));
      if (hits.length === 0) continue;
      entriesFlagged++;
      const label = `KYC — ${k.name || k.username || `#${k.id}`}`;
      const list = flaggedByUser.get(userId) ?? [];
      list.push({ entryId: Number(k.id), label, hits });
      flaggedByUser.set(userId, list);
    } catch (err) {
      logger.warn({ err, kycId: k?.id }, "vault-health-scan: kyc entry check failed, skipping");
    }
  }

  // ── Wallet ───────────────────────────────────────────────────────────────
  const walletRows = await db.select().from(walletsTable);
  for (const w of walletRows) {
    try {
      const userId = Number(w.userId);
      const hits = evalWalletBackgroundHealthRules({
        hasSeedPhrase: !!w.encryptedPhrase,
        lastSyncedAt: w.lastSyncedAt ?? null,
      });
      await persistWalletFlags(Number(w.id), userId, hits.map((h) => h.id));
      if (hits.length === 0) continue;
      entriesFlagged++;
      const label = `Wallet — ${w.label} (${w.chain})`;
      const list = flaggedByUser.get(userId) ?? [];
      list.push({ entryId: Number(w.id), label, hits });
      flaggedByUser.set(userId, list);
    } catch (err) {
      logger.warn({ err, walletId: (w as any)?.id }, "vault-health-scan: wallet check failed, skipping");
    }
  }

  // ── Local Account ────────────────────────────────────────────────────────
  const localRows = (await db.execute(sql.raw(`SELECT * FROM local_accounts`))).rows as any[];
  for (const a of localRows) {
    try {
      const userId = Number(a.user_id);
      const hits = evalLocalAccountBackgroundHealthRules({
        hasTwofa: !!a.twofa,
        hasBackupCodes: !!a.backup_codes,
        hasRecoveryEmail: !!a.recovery_email,
        lastLoginAt: a.account_last_login_date ?? null,
        status: a.status ?? "active",
      });
      await persistRawFlags("local_accounts", Number(a.id), userId, hits.map((h) => h.id));
      if (hits.length === 0) continue;
      entriesFlagged++;
      const label = `Local — ${a.label || a.username || a.email || `#${a.id}`}`;
      const list = flaggedByUser.get(userId) ?? [];
      list.push({ entryId: Number(a.id), label, hits });
      flaggedByUser.set(userId, list);
    } catch (err) {
      logger.warn({ err, localAccountId: a?.id }, "vault-health-scan: local account check failed, skipping");
    }
  }

  // ── Data Entity ──────────────────────────────────────────────────────────
  // "used" mirrors the USED_EXPR correlated subquery in
  // routes/kyc-data-entities.ts — linked to any kyc_entries or vault_entries
  // row via data_entity_id.
  const dataEntityRows = (await db.execute(sql.raw(`
    SELECT d.*,
      (EXISTS (SELECT 1 FROM kyc_entries k WHERE k.data_entity_id = d.id)
       OR EXISTS (SELECT 1 FROM vault_entries v WHERE v.data_entity_id = d.id)) AS used
    FROM kyc_data_entities d
  `))).rows as any[];
  for (const d of dataEntityRows) {
    try {
      const userId = Number(d.user_id);
      const hits = evalDataEntityBackgroundHealthRules({
        hasNidNumber: !!d.nid_number,
        hasName: !!d.name,
        hasBirthDate: !!d.birth_date,
        hasPhoto1: !!d.photo1_url,
        hasPhoto2: !!d.photo2_url,
        used: !!d.used,
        createdAt: d.created_at ?? null,
      });
      await persistRawFlags("kyc_data_entities", Number(d.id), userId, hits.map((h) => h.id));
      if (hits.length === 0) continue;
      entriesFlagged++;
      const label = `Data Entity — ${d.name || `#${d.id}`}`;
      const list = flaggedByUser.get(userId) ?? [];
      list.push({ entryId: Number(d.id), label, hits });
      flaggedByUser.set(userId, list);
    } catch (err) {
      logger.warn({ err, dataEntityId: d?.id }, "vault-health-scan: data entity check failed, skipping");
    }
  }

  const totalScanned = rows.length + kycRows.length + walletRows.length + localRows.length + dataEntityRows.length;

  let usersAlerted = 0;
  if (flaggedByUser.size > 0) {
    const userIds = Array.from(flaggedByUser.keys());
    const users = await db
      .select({
        id: usersTable.id, username: usersTable.username, email: usersTable.email,
        telegramChatId: usersTable.telegramChatId,
        digestFrequency: usersTable.digestFrequency, lastDigestSentAt: usersTable.lastDigestSentAt,
      })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds));

    for (const user of users) {
      const entries = flaggedByUser.get(user.id);
      if (!entries || entries.length === 0) continue;
      // The scan itself runs every 6h (fresh flags), but actual delivery
      // respects the user's chosen cadence so a daily/weekly/monthly user
      // isn't pinged four times a day.
      if (!isDigestDue(user.digestFrequency, user.lastDigestSentAt)) continue;
      try {
        await deliverDigest(user, entries);
        await db.update(usersTable).set({ lastDigestSentAt: new Date() }).where(eq(usersTable.id, user.id));
        usersAlerted++;
      } catch (err) {
        logger.warn({ err, userId: user.id }, "vault-health-scan: digest delivery failed");
      }
    }
  }

  const summary = `Vault health scan: ${totalScanned} entities scanned (Entity/KYC/Wallet/Local/Data Entity), ${entriesFlagged} flagged, ${usersAlerted} user(s) alerted`;
  logBus.system(summary);
  logger.info({ scanned: totalScanned, entriesFlagged, usersAlerted }, "vault-health-scan complete");

  return { entriesScanned: totalScanned, entriesFlagged, usersAlerted };
}

const DIGEST_INTERVAL_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** Has enough time passed since the user's last digest for their chosen frequency? */
function isDigestDue(frequency: string | null, lastSentAt: Date | null): boolean {
  if (!lastSentAt) return true;
  const interval = DIGEST_INTERVAL_MS[frequency ?? "daily"] ?? DIGEST_INTERVAL_MS.daily;
  return Date.now() - lastSentAt.getTime() >= interval;
}

async function deliverDigest(
  user: { id: number; username: string; email: string; telegramChatId: string | null },
  entries: FlaggedEntry[]
): Promise<void> {
  const lines = entries.map((e) => {
    const worst = e.hits.find((h) => h.severity === "alert") ?? e.hits[0];
    const rest = e.hits.filter((h) => h !== worst).map((h) => `${severityEmoji(h.severity)} ${h.message}`).join(" · ");
    return `${severityEmoji(worst.severity)} *${e.label}*\n${worst.message}${rest ? ` · ${rest}` : ""}`;
  });
  const plainLines = entries.map((e) => `<strong>${e.label}</strong> — ${e.hits.map((h) => h.message).join("; ")}`);

  // In-app notification (bell icon) — non-blocking, best-effort like the rest.
  createNotification(
    user.id,
    "vault_health_digest",
    `Vault Health Digest — ${entries.length} entit${entries.length === 1 ? "y" : "ies"} flagged`,
    entries.map((e) => `${e.label}: ${e.hits.map((h) => h.message).join("; ")}`).join("\n"),
    { entryIds: entries.map((e) => e.entryId) },
  ).catch(() => {});

  // Telegram — only if the user has linked their account.
  if (user.telegramChatId) {
    const text = `🩺 *Vault Health Digest*\n\n${entries.length} entit${entries.length === 1 ? "y" : "ies"} need attention:\n\n${lines.join("\n\n")}`;
    sendToUser(user.telegramChatId, text).catch(() => {});
  }

  // Email — always, since this is precisely for users who haven't logged in.
  if (user.email) {
    sendVaultHealthDigestEmail(user.email, user.username, plainLines, entries.length).catch(() => {});
  }
}
