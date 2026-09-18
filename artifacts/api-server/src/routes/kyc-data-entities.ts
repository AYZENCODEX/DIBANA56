import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { encryptField, decryptRow, decryptRows } from "../lib/vault-crypto";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();

// Only the NID number is a secret-grade field here — name/father's name/
// birthdate/photos are identity data, not credentials, but nid_number is
// treated the same as it was on kyc_entries pre-split.
const DATA_ENTITY_SENSITIVE_FIELDS = ["nid_number"] as const;

// Safely escape a string for SQL — mirrors routes/kyc.ts
const safe = (v: unknown) => v === null || v === undefined || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const safeDate = (v: unknown) => v ? `'${String(v).replace(/'/g, "''")}'` : "NULL";

// A data entity is "used" iff some kyc_entries row OR some vault_entries row
// points at it via data_entity_id — same free/used pattern as
// local_accounts.vault_entry_id against vault_entries. A Data Entity isn't
// exclusive to KYC entities: a Vault Entity (e.g. an Exchange account) can
// link the very same record directly via "Link Data Entity". We compute
// this with a correlated subquery rather than a stored flag so it's always
// accurate even if a link is cleared elsewhere.
const USED_BY_KYC = `EXISTS (SELECT 1 FROM kyc_entries k WHERE k.data_entity_id = d.id)`;
const USED_BY_VAULT = `EXISTS (SELECT 1 FROM vault_entries v WHERE v.data_entity_id = d.id)`;
const USED_EXPR = `(${USED_BY_KYC} OR ${USED_BY_VAULT})`;

// `kyc_data_entities` has one owner column (`user_id`) — plain
// single-owner shape, distinct from the `vault_entries` table this file
// only reads (for the used/unused computation), so this is outside
// `vault.ts`'s Season B reservation, not part of it.
const KYC_DATA_ENTITY_OWNER_SENTINEL_NONE = -1;
const kycDataEntityResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string);
  if (Number.isNaN(id)) return { type: "kyc_data_entity", id: req.params.id, ownerId: KYC_DATA_ENTITY_OWNER_SENTINEL_NONE };
  const result = await db.execute(sql.raw(`SELECT user_id FROM kyc_data_entities WHERE id = ${id} LIMIT 1`));
  const row = result.rows[0] as any;
  return { type: "kyc_data_entity", id, ownerId: row?.user_id ?? KYC_DATA_ENTITY_OWNER_SENTINEL_NONE };
};
function requireKycDataEntityOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, kycDataEntityResource, { onDecision: pepDecisionObserver, onDeny });
}

// ─── GET /kyc-data-entities — list, optionally filtered by used/unused ───────
router.get("/kyc-data-entities", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const status = (req.query.status as string) || null; // "used" | "unused" | null (all)
  try {
    let where = `d.user_id = ${userId}`;
    if (status === "used") where += ` AND ${USED_EXPR}`;
    if (status === "unused") where += ` AND NOT ${USED_EXPR}`;
    const result = await db.execute(sql.raw(`
      SELECT d.*, ${USED_EXPR} AS used,
        (SELECT k.id FROM kyc_entries k WHERE k.data_entity_id = d.id LIMIT 1) AS linked_kyc_entry_id,
        (SELECT k.category FROM kyc_entries k WHERE k.data_entity_id = d.id LIMIT 1) AS linked_kyc_category,
        (SELECT v.id FROM vault_entries v WHERE v.data_entity_id = d.id LIMIT 1) AS linked_vault_entry_id,
        (SELECT v.project_name FROM vault_entries v WHERE v.data_entity_id = d.id LIMIT 1) AS linked_vault_project_name
      FROM kyc_data_entities d
      WHERE ${where}
      ORDER BY d.created_at DESC
    `));
    res.json(decryptRows(result.rows as any[], DATA_ENTITY_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /kyc-data-entities/overview — roll-up stats for the Overview page ───
router.get("/kyc-data-entities/overview", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const result = await db.execute(sql.raw(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ${USED_EXPR})::int AS used,
        COUNT(*) FILTER (WHERE NOT ${USED_EXPR})::int AS unused
      FROM kyc_data_entities d
      WHERE d.user_id = ${userId}
    `));
    res.json(result.rows[0] ?? { total: 0, used: 0, unused: 0 });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── POST /kyc-data-entities — create a data entity ───────────────────────────
router.post("/kyc-data-entities", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const {
    nidNumber = null, name = null, fatherName = null, birthDate = null,
    photo1Url = null, photo2Url = null, notes = null,
  } = req.body;

  try {
    const result = await db.execute(sql.raw(`
      INSERT INTO kyc_data_entities
        (user_id, nid_number, name, father_name, birth_date, photo1_url, photo2_url, notes)
      VALUES
        (${userId}, ${safe(encryptField(nidNumber))}, ${safe(name)}, ${safe(fatherName)},
         ${safeDate(birthDate)}, ${safe(photo1Url)}, ${safe(photo2Url)}, ${safe(notes)})
      RETURNING *
    `));
    res.status(201).json({ ...decryptRow(result.rows[0] as any, DATA_ENTITY_SENSITIVE_FIELDS), used: false });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /kyc-data-entities/:id — fetch single data entity ───────────────────
router.get("/kyc-data-entities/:id", requireAuth, requireKycDataEntityOwnership("kyc_data_entity.read", (_req, res) => { res.status(404).json({ error: "Not found" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const result = await db.execute(sql.raw(`
      SELECT d.*, ${USED_EXPR} AS used,
        (SELECT k.id FROM kyc_entries k WHERE k.data_entity_id = d.id LIMIT 1) AS linked_kyc_entry_id,
        (SELECT k.category FROM kyc_entries k WHERE k.data_entity_id = d.id LIMIT 1) AS linked_kyc_category,
        (SELECT v.id FROM vault_entries v WHERE v.data_entity_id = d.id LIMIT 1) AS linked_vault_entry_id,
        (SELECT v.project_name FROM vault_entries v WHERE v.data_entity_id = d.id LIMIT 1) AS linked_vault_project_name
      FROM kyc_data_entities d
      WHERE d.id = ${id} AND d.user_id = ${userId} LIMIT 1
    `));
    if (!result.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    res.json(decryptRow(result.rows[0] as any, DATA_ENTITY_SENSITIVE_FIELDS));
  } catch (err: any) { res.status(500).json({ error: "DB error", detail: err?.message }); }
});

// ─── PUT /kyc-data-entities/:id — update a data entity ────────────────────────
router.put("/kyc-data-entities/:id", requireAuth, requireKycDataEntityOwnership("kyc_data_entity.update", (_req, res) => { res.status(404).json({ error: "Not found or forbidden" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const {
    nidNumber, name, fatherName, birthDate, photo1Url, photo2Url, notes,
  } = req.body;

  try {
    const result = await db.execute(sql.raw(`
      UPDATE kyc_data_entities SET
        nid_number = ${safe(encryptField(nidNumber))}, name = ${safe(name)},
        father_name = ${safe(fatherName)}, birth_date = ${safeDate(birthDate)},
        photo1_url = ${safe(photo1Url)}, photo2_url = ${safe(photo2Url)},
        notes = ${safe(notes)}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `));
    if (!result.rows.length) { res.status(404).json({ error: "Not found or forbidden" }); return; }
    res.json(decryptRow(result.rows[0] as any, DATA_ENTITY_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── DELETE /kyc-data-entities/:id — delete a data entity ─────────────────────
// Blocked while a KYC entity OR a Vault entity is still linked — unlink (or
// delete) that entity first, same guard style as vault-entity-links deletes.
router.delete("/kyc-data-entities/:id", requireAuth, requireKycDataEntityOwnership("kyc_data_entity.delete", (_req, res) => { res.json({ success: true }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const linkedKyc = await db.execute(sql.raw(`SELECT id FROM kyc_entries WHERE data_entity_id = ${id} LIMIT 1`));
    if (linkedKyc.rows.length) {
      res.status(409).json({ error: "Data entity is in use by a KYC entity — unlink it first" });
      return;
    }
    const linkedVault = await db.execute(sql.raw(`SELECT id FROM vault_entries WHERE data_entity_id = ${id} LIMIT 1`));
    if (linkedVault.rows.length) {
      res.status(409).json({ error: "Data entity is in use by a Vault entity — unlink it first" });
      return;
    }
    await db.execute(sql.raw(`DELETE FROM kyc_data_entities WHERE id = ${id} AND user_id = ${userId}`));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

export default router;
