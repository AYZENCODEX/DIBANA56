import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql, SQL } from "drizzle-orm";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { encryptField, decryptRow, decryptRows } from "../lib/vault-crypto";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";

const router = Router();

// Credential/PII columns encrypted at rest (see lib/vault-crypto.ts).
const KYC_SENSITIVE_FIELDS = [
  "account_password", "email_password", "email_2fa", "email_backup_code", "nid_number",
  // Extended Account fields
  "account_2fa", "account_backup_code",
  "email_recovery_password", "recovery_2fa", "recovery_backup_code",
] as const;

// Bind a value as a parameter, normalizing "" / undefined to SQL NULL.
const val = (v: unknown) => (v === null || v === undefined || v === "" ? null : v);
const numVal = (v: unknown) => (isNaN(Number(v)) ? 0 : Number(v));

// Columns pulled from the linked kyc_data_entities row (see
// routes/kyc-data-entities.ts) — a KYC entity no longer stores its own
// nid/name/father_name/birth_date/photos, it links to a Data Entity for
// those. Aliased so existing frontend code reading e.g. `.name` keeps
// working unchanged. These are fixed, hardcoded SQL fragments — no request
// data is ever interpolated into them, so sql.raw() on them is safe.
const DATA_ENTITY_JOIN = sql.raw(`
  LEFT JOIN kyc_data_entities d ON d.id = k.data_entity_id
`);
const DATA_ENTITY_SELECT = sql.raw(`
  d.nid_number AS nid_number, d.name AS name, d.father_name AS father_name,
  d.birth_date AS birth_date, d.photo1_url AS photo1_url, d.photo2_url AS photo2_url
`);

// Fetch a single KYC entity (with its linked Data Entity columns) by id —
// used to re-select a row right after an INSERT/UPDATE.
async function fetchWithData(id: number): Promise<any> {
  const result = await db.execute(sql`
    SELECT k.*, ${DATA_ENTITY_SELECT}
    FROM kyc_entries k
    ${DATA_ENTITY_JOIN}
    WHERE k.id = ${id}
  `);
  return result.rows[0];
}

// `kyc_entries` has one owner column (`user_id`) — plain single-owner
// shape, matching this file's own parameterized `sql` tagged-template
// style (not `sql.raw`).
const KYC_ENTRY_OWNER_SENTINEL_NONE = -1;
// Exported (C19B) so exchange-api.ts's `PATCH /kyc-entries/:id/exchange-keys`
// — same `kyc_entries` table, same `user_id` owner column, previously left
// unwired when the rest of this file's routes were gated in C19A — can
// reuse this instead of hand-rolling a second copy.
export const kycEntryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string);
  if (Number.isNaN(id)) return { type: "kyc_entry", id: req.params.id, ownerId: KYC_ENTRY_OWNER_SENTINEL_NONE };
  const result = await db.execute(sql`SELECT user_id FROM kyc_entries WHERE id = ${id} LIMIT 1`);
  const row = result.rows[0] as any;
  return { type: "kyc_entry", id, ownerId: row?.user_id ?? KYC_ENTRY_OWNER_SENTINEL_NONE };
};
export function requireKycEntryOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, kycEntryResource, { onDecision: pepDecisionObserver, onDeny });
}

// ─── GET /kyc-entries — list user's KYC entities ──────────────────────────────
router.get("/kyc-entries", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const category = (req.query.category as string) || null;
  // Platform filter — used by the Exchange enroll-by-KYC-entity picker to
  // narrow to e.g. category=Exchange&platform=Binance.
  const platform = (req.query.platform as string) || null;
  // unused=true excludes any KYC Entity already spent on an active
  // project_enrollments row (kyc_entry_id) — same free/used idea as the
  // Data Entity used/unused split, one KYC Entity backs one enrollment.
  const unused = req.query.unused === "true";
  try {
    const conditions: SQL[] = [sql`k.user_id = ${userId}`];
    if (category) conditions.push(sql`k.category = ${category}`);
    if (platform) conditions.push(sql`k.platform = ${platform}`);
    if (unused) conditions.push(sql`NOT EXISTS (SELECT 1 FROM project_enrollments pe WHERE pe.kyc_entry_id = k.id AND pe.status = 'active')`);
    const whereSql = sql.join(conditions, sql` AND `);
    const q = sql`
      SELECT k.*, ${DATA_ENTITY_SELECT}
      FROM kyc_entries k
      ${DATA_ENTITY_JOIN}
      WHERE ${whereSql}
      ORDER BY k.created_at DESC
    `;
    const result = await db.execute(q);
    res.json(decryptRows(result.rows as any[], KYC_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── POST /kyc-entries — create KYC entity ─────────────────────────────────────
router.post("/kyc-entries", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const {
    category = "Other",
    // Account · Main
    username = null, accountPassword = null, notes = null,
    email = null, emailPassword = null,
    account2fa = null, accountBackupCode = null,
    email2fa = null, emailBackupCode = null,
    // Account · Info
    lastLoginAt = null, accountBuyDate = null, accountCreateDate = null,
    accountBuyPrice = 0, accountWorth = 0, kycFollowers = null,
    // Account · Recovery
    emailRecovery = null, emailRecoveryPassword = null,
    recovery2fa = null, recoveryBackupCode = null,
    // KYC identity — instead of raw nid/name/father/birthdate/photos, a KYC
    // entity now links to a kyc_data_entities row (see routes/kyc-data-entities.ts).
    dataEntityId = null,
    // KYC · Seller
    platform = null, buyPrice = 0, location = null, connection = null,
    contactNumber = null, buyDate = null, paid = false, sellerName = null, socialAccount = null,
  } = req.body;

  if (!category) { res.status(400).json({ error: "Category required" }); return; }

  try {
    const result = await db.execute(sql`
      INSERT INTO kyc_entries
        (user_id, category, username, account_password, notes,
         email, email_password, email_2fa, email_backup_code,
         account_2fa, account_backup_code,
         last_login_at, account_buy_date, account_create_date,
         account_buy_price, account_worth, followers,
         email_recovery, email_recovery_password, recovery_2fa, recovery_backup_code,
         data_entity_id,
         platform, buy_price, location, connection, contact_number, buy_date, paid, seller_name, social_account)
      VALUES
        (${userId}, ${val(category)}, ${val(username)}, ${val(encryptField(accountPassword))}, ${val(notes)},
         ${val(email)}, ${val(encryptField(emailPassword))}, ${val(encryptField(email2fa))}, ${val(encryptField(emailBackupCode))},
         ${val(encryptField(account2fa))}, ${val(encryptField(accountBackupCode))},
         ${val(lastLoginAt)}, ${val(accountBuyDate)}, ${val(accountCreateDate)},
         ${numVal(accountBuyPrice)}, ${numVal(accountWorth)}, ${val(kycFollowers)},
         ${val(emailRecovery)}, ${val(encryptField(emailRecoveryPassword))}, ${val(encryptField(recovery2fa))}, ${val(encryptField(recoveryBackupCode))},
         ${dataEntityId ? numVal(dataEntityId) : null},
         ${val(platform)}, ${numVal(buyPrice)}, ${val(location)}, ${val(connection)},
         ${val(contactNumber)}, ${val(buyDate)}, ${!!paid}, ${val(sellerName)}, ${val(socialAccount)})
      RETURNING *
    `);
    const row = result.rows[0] as any;
    const withData = row.data_entity_id ? await fetchWithData(row.id) : row;
    res.status(201).json(decryptRow(withData as any, KYC_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /kyc-entries/:id — fetch single KYC entity ───────────────────────────
router.get("/kyc-entries/:id", requireAuth, requireKycEntryOwnership("kyc_entry.read", (_req, res) => { res.status(404).json({ error: "Not found" }); }), requireCreditBalance("sylo.kyc_entry_view"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const result = await db.execute(sql`
      SELECT k.*, ${DATA_ENTITY_SELECT}
      FROM kyc_entries k
      ${DATA_ENTITY_JOIN}
      WHERE k.id = ${id} AND k.user_id = ${userId} LIMIT 1
    `);
    if (!result.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    // Charge-on-success: only after the row was actually found — a 404 above
    // never touches the ledger. Mirrors vault.ts's GET /vault/:id pattern.
    const charge = await chargeCredits(userId, "sylo.kyc_entry_view");
    res.json({ ...decryptRow(result.rows[0] as any, KYC_SENSITIVE_FIELDS), _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null });
  } catch (err: any) { res.status(500).json({ error: "DB error", detail: err?.message }); }
});

// ─── PUT /kyc-entries/:id — update KYC entity ─────────────────────────────────
router.put("/kyc-entries/:id", requireAuth, requireKycEntryOwnership("kyc_entry.update", (_req, res) => { res.status(404).json({ error: "Not found or forbidden" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const {
    category, username, accountPassword, notes,
    email, emailPassword, email2fa, emailBackupCode,
    account2fa, accountBackupCode,
    lastLoginAt, accountBuyDate, accountCreateDate,
    accountBuyPrice, accountWorth, kycFollowers,
    emailRecovery, emailRecoveryPassword, recovery2fa, recoveryBackupCode,
    dataEntityId,
    platform, buyPrice, location, connection,
    contactNumber, buyDate, paid, sellerName, socialAccount,
  } = req.body;

  try {
    const result = await db.execute(sql`
      UPDATE kyc_entries SET
        category = ${val(category)}, username = ${val(username)},
        account_password = ${val(encryptField(accountPassword))}, notes = ${val(notes)},
        email = ${val(email)}, email_password = ${val(encryptField(emailPassword))},
        email_2fa = ${val(encryptField(email2fa))}, email_backup_code = ${val(encryptField(emailBackupCode))},
        account_2fa = ${val(encryptField(account2fa))}, account_backup_code = ${val(encryptField(accountBackupCode))},
        last_login_at = ${val(lastLoginAt)}, account_buy_date = ${val(accountBuyDate)},
        account_create_date = ${val(accountCreateDate)},
        account_buy_price = ${numVal(accountBuyPrice)}, account_worth = ${numVal(accountWorth)},
        followers = ${val(kycFollowers)},
        email_recovery = ${val(emailRecovery)},
        email_recovery_password = ${val(encryptField(emailRecoveryPassword))},
        recovery_2fa = ${val(encryptField(recovery2fa))},
        recovery_backup_code = ${val(encryptField(recoveryBackupCode))},
        data_entity_id = ${dataEntityId !== undefined ? sql`${dataEntityId ? numVal(dataEntityId) : null}` : sql`data_entity_id`},
        platform = ${val(platform)}, buy_price = ${numVal(buyPrice)},
        location = ${val(location)}, connection = ${val(connection)},
        contact_number = ${val(contactNumber)}, buy_date = ${val(buyDate)},
        paid = ${paid !== undefined ? sql`${!!paid}` : sql`paid`},
        seller_name = ${val(sellerName)}, social_account = ${val(socialAccount)},
        updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `);
    if (!result.rows.length) { res.status(404).json({ error: "Not found or forbidden" }); return; }
    const row = result.rows[0] as any;
    const withData = row.data_entity_id ? await fetchWithData(row.id) : row;
    res.json(decryptRow(withData as any, KYC_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── PATCH /kyc-entries/:id/status — ban / unban KYC entity ──────────────────
router.patch("/kyc-entries/:id/status", requireAuth, requireKycEntryOwnership("kyc_entry.status.update", (_req, res) => { res.status(404).json({ error: "Not found or forbidden" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const allowed = ["active", "banned"];
  const status = req.body.status;
  if (!allowed.includes(status)) { res.status(400).json({ error: "status must be one of: active, banned" }); return; }

  try {
    const result = await db.execute(sql`
      UPDATE kyc_entries SET status = ${status}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `);
    if (!result.rows.length) { res.status(404).json({ error: "Not found or forbidden" }); return; }
    res.json(decryptRow(result.rows[0] as any, KYC_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── DELETE /kyc-entries/:id — delete KYC entity ──────────────────────────────
router.delete("/kyc-entries/:id", requireAuth, requireKycEntryOwnership("kyc_entry.delete", (_req, res) => { res.json({ success: true }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    await db.execute(sql`DELETE FROM kyc_entries WHERE id = ${id} AND user_id = ${userId}`);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /kyc-entries/enrollments — Exchange projects enrolled via a KYC
// Entity pick (Binance/Bitget/Kucoin/Bybit shortcut, no manual form) ────────
// Powers the KYC sidebar's "Enrolled" page — only rows created through the
// KYC-entity picker (kyc_entry_id set); ordinary manual/"Other" enrollments
// (dataEntityId path) don't show up here, they stay on the regular
// Project ↔ Entity enrollment list.
router.get("/kyc-entries/enrollments", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const result = await db.execute(sql`
      SELECT
        pe.id AS enrollment_id, pe.status, pe.enrolled_at,
        p.id AS project_id, p.name AS project_name, p.project_type, p.thumbnail_url,
        k.id AS kyc_entry_id, k.platform AS kyc_platform, k.username AS kyc_username,
        ve.id AS vault_entry_id, ve.project_name AS vault_entry_name
      FROM project_enrollments pe
      JOIN projects p ON p.id = pe.project_id
      JOIN kyc_entries k ON k.id = pe.kyc_entry_id
      JOIN vault_entries ve ON ve.id = pe.vault_entry_id
      WHERE pe.user_id = ${userId} AND pe.kyc_entry_id IS NOT NULL
      ORDER BY pe.enrolled_at DESC
    `);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

export default router;
