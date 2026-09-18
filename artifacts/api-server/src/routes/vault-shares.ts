import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { authorizeMany } from "../lib/policy/pep";
import type { ResourceRef } from "../lib/policy/types";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../lib/policy/resource";
import { decryptRow } from "../lib/vault-crypto";
import { createNotification } from "./notifications";
import { VAULT_ENTITY_ENCRYPTED_FIELDS } from "./vault";

const router = Router();

/**
 * Vault entity sharing ("transfer" in the product sense the team uses the
 * word — access moves, ownership never does).
 *
 * Sharing an entity does NOT change which user owns it — the owner_id
 * column here is separate from, and never writes to, the user_id column on
 * the underlying local_accounts / vault_entries / kyc_entries / game_entries
 * row. A share is just a grant of read (or edit) access to another user.
 * Turning is_active off (PATCH) — or deleting the row (DELETE) — instantly
 * removes that access; the entity itself, and who owns it, is untouched.
 */

// entity_type -> underlying table + a short label column used to render a
// human-readable name for the shared item without exposing sensitive fields.
// Exported for routes/organizations.ts (Phase 8 — org-wide vault sharing):
// same entity_type -> table/sensitive-fields/label mapping, reused rather
// than duplicated so a future encrypted column never has to be added here
// AND kept in sync in two files (exactly the drift bug this file's own
// Phase C23-era comment above the individual entries describes fixing).
export const ENTITY_TABLES: Record<string, { table: string; sensitive: readonly string[]; label: (row: any) => string; deletedAtCol?: string }> = {
  local: {
    table: "local_accounts",
    sensitive: ["password", "recovery_email_password", "backup_codes", "twofa", "recovery_email_twofa"],
    label: (r) => r.label || r.username || r.email || `Local #${r.id}`,
  },
  entity: {
    table: "vault_entries",
    // Kept in sync with formatRow() in routes/vault.ts via a shared export —
    // see VAULT_ENTITY_ENCRYPTED_FIELDS there. Previously this was a
    // hand-maintained duplicate list that had drifted out of sync (missing
    // 17 of the 35 encrypted columns — every *_2fa / *_backup_code field
    // added after the initial share-feature build never got added here),
    // so a shared/owner-via-this-route view of an entity returned raw
    // ciphertext instead of the decrypted 2FA/backup codes for those fields.
    sensitive: VAULT_ENTITY_ENCRYPTED_FIELDS,
    label: (r) => r.project_name || r.username || `Entity #${r.id}`,
    // Only vault_entries has a recycle bin today — see routes/vault.ts. A
    // trashed entity must behave, for sharing purposes, exactly like a
    // fully-deleted local/kyc/game row already does: no new shares, and any
    // existing share stops resolving ("Entity no longer exists") instead of
    // still handing out decrypted fields for something the owner threw away.
    deletedAtCol: "deleted_at",
  },
  kyc: {
    table: "kyc_entries",
    sensitive: ["account_password", "email_password", "email_2fa", "email_backup_code", "nid_number"],
    label: (r) => r.name || r.username || `KYC #${r.id}`,
  },
  game: {
    table: "game_entries",
    sensitive: ["account_password", "email_password", "email_2fa", "email_backup_code"],
    label: (r) => r.username || `Game #${r.id}`,
  },
};

// Appended to a raw WHERE clause to exclude soft-deleted rows for entity
// types that have a recycle bin (currently just "entity" — see above).
// Empty string for every other type, so this is safe to splice in everywhere.
function notTrashedClause(cfg: { deletedAtCol?: string }): string {
  return cfg.deletedAtCol ? ` AND ${cfg.deletedAtCol} IS NULL` : "";
}

export const VALID_TYPES = Object.keys(ENTITY_TABLES);

// Internal/owner-only columns that can never be part of a per-field share —
// they either identify the row itself or its true owner, neither of which a
// share should ever expose or let a recipient edit.
const NON_SHAREABLE_COLUMNS = new Set(["id", "user_id", "created_at", "updated_at", "entity_serial"]);

const safe = (v: unknown) => v === null || v === undefined || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

// ─── Route Integration Roadmap — Season C, Phase C23 (mechanical sweep) ────
// `vault_shares` has its own plain `owner_id` column — simple single-owner
// shape, same "second, PDP-routed, audited decision on top of an unchanged
// existing query" treatment as everywhere else in this series. Only
// `PATCH`/`DELETE /vault-shares/:id` are in scope — both already share the
// same deny body (`404 "Not found or not yours to manage"`), so one
// resource builder + wrapper covers both. This file's own queries are
// written with `sql.raw`, but — same as every other new resource lookup
// this series has added (see kyc.ts/local-accounts.ts) — the builder below
// uses parameterized `sql` instead, since it's new code with no reason to
// take on the string-interpolated style.
//
// `PATCH`/`DELETE /vault-shares/bulk` were NOT touched here — their
// ownership pre-filter was already baked directly into each query
// (`... AND owner_id = ${userId}`), the same C13 `authorizeMany()`-shaped
// bulk pattern flagged in the roadmap as a decision for a future bulk-
// family sweep. That sweep is Phase C27 — see the block below.
const VAULT_SHARE_OWNER_SENTINEL_NONE = -1;

const vaultShareResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "vault_share", id: req.params.id, ownerId: VAULT_SHARE_OWNER_SENTINEL_NONE };
  const rows = (await db.execute(sql`SELECT owner_id FROM vault_shares WHERE id = ${id} LIMIT 1`)).rows as any[];
  return { type: "vault_share", id, ownerId: rows[0]?.owner_id ?? VAULT_SHARE_OWNER_SENTINEL_NONE };
};

function requireVaultShareOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, vaultShareResource, { onDecision: pepDecisionObserver, onDeny });
}
const denyVaultShareNotFound = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found or not yours to manage" }); };

// ─── Route Integration Roadmap — Season C, Phase C27 (bulk-family
// policy-engine consistency sweep) ────────────────────────────────────────
// All three `/vault-shares/bulk` routes were already correctly scoped (raw
// SQL/query-builder ownership filters, per-item, exactly like every other
// route in this file) — this phase does NOT change any of that filtering.
// What it adds is the same `authorizeMany()`/`pepDecisionObserver` audit
// trail `bulk.ts` just got, so each bulk request's per-item allow/deny is a
// real, centrally observable `AuthorizationDecision` instead of only a
// WHERE clause no PDP ever saw — same posture as `ayzen-mailbox.ts`'s
// `PATCH /mailbox/bulk` (Phase C13).
//
// `PATCH`/`DELETE /vault-shares/bulk` both operate on `vault_shares` rows
// themselves (single resource shape, `vault_share`/`owner_id`) — one
// dedicated engine, reused by both.
const vaultShareBulkOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultShareBulkOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

/**
 * Fetches each candidate vault_shares row's REAL owner_id — NOT filtered by
 * the caller's own userId — and runs one `authorizeMany()` batch over them
 * purely to produce an audited `AuthorizationDecision` per id. The route's
 * own pre-existing query (still filtered by owner_id, unchanged by this
 * phase) is what actually decides which rows get touched; this only makes
 * that same decision visible to the PDP/audit trail. Call for its audit
 * side-effect only — its return value is intentionally discarded.
 */
async function auditVaultShareBulkOwnership(req: Request, ids: number[], action: string): Promise<void> {
  if (!ids.length) return;
  const candidates = (await db.execute(sql.raw(
    `SELECT id, owner_id FROM vault_shares WHERE id IN (${ids.join(",")})`
  ))).rows as any[];
  if (!candidates.length) return;
  await authorizeMany<number>({
    req,
    engine: vaultShareBulkOwnershipEngine,
    action,
    items: candidates.map((row): { key: number; resource: ResourceRef } => ({
      key: Number(row.id),
      resource: { type: "vault_share", id: Number(row.id), ownerId: row.owner_id != null ? Number(row.owner_id) : undefined },
    })),
  });
}

// `POST /vault-shares/bulk` creates NEW shares, so there's no `vault_share`
// row to check ownership of yet — what needs auditing is ownership of the
// underlying entity being shared (`local_account` / `vault_entry` /
// `kyc_entry` / `game_entry`, per `item.entityType`), which is exactly what
// this route's existing per-item `ownedCheck` query already establishes.
// One shared engine covers all four types — `createResourceOwnershipRule()`
// only ever compares `resource.ownerId` to the subject, so it's the same
// rule regardless of which table `ownerId` came from (see that rule's own
// header). Reuses the resource-type strings already established for these
// tables elsewhere (`local-accounts.ts`, `vault-entity-links.ts`, `kyc.ts`,
// `game-entries.ts`) so decisions correlate with those files' own audit
// trail rather than inventing a fifth naming scheme.
const vaultShareCandidateOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultShareCandidateOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

const ENTITY_TYPE_TO_RESOURCE_TYPE: Record<keyof typeof ENTITY_TABLES, string> = {
  local: "local_account",
  entity: "vault_entry",
  kyc: "kyc_entry",
  game: "game_entry",
};

/**
 * Batches ownership-audit lookups for a `POST /vault-shares/bulk` request:
 * one grouped `SELECT id, user_id FROM {table} WHERE id IN (...)` query per
 * distinct `entityType` present in `items` (never one query per item), then
 * a single `authorizeMany()` call across every item regardless of type.
 * Only items with a syntactically valid `entityType`/`entityId` are
 * included — the route's own loop already re-validates and re-checks
 * ownership per item afterward via `ownedCheck`; this is audit-only and
 * changes nothing about which items actually get shared.
 */
async function auditVaultShareCreateOwnership(
  req: Request,
  items: { entityType: unknown; entityId: unknown }[],
): Promise<void> {
  const byType = new Map<keyof typeof ENTITY_TABLES, number[]>();
  for (const item of items) {
    const entityType = item?.entityType;
    const entityId = parseInt(item?.entityId as string, 10);
    if (!isValidType(entityType) || isNaN(entityId)) continue;
    const list = byType.get(entityType) ?? [];
    list.push(entityId);
    byType.set(entityType, list);
  }
  if (!byType.size) return;

  const authItems: { key: string; resource: ResourceRef; action: string }[] = [];
  for (const [entityType, ids] of byType) {
    const cfg = ENTITY_TABLES[entityType];
    const resourceType = ENTITY_TYPE_TO_RESOURCE_TYPE[entityType];
    const candidates = (await db.execute(sql.raw(
      `SELECT id, user_id FROM ${cfg.table} WHERE id IN (${ids.join(",")})`
    ))).rows as any[];
    for (const row of candidates) {
      authItems.push({
        key: `${entityType}:${row.id}`,
        resource: { type: resourceType, id: Number(row.id), ownerId: row.user_id != null ? Number(row.user_id) : undefined },
        action: `${resourceType}.share.create`,
      });
    }
  }
  if (!authItems.length) return;
  await authorizeMany<string>({ req, engine: vaultShareCandidateOwnershipEngine, items: authItems });
}

export function isValidType(t: unknown): t is keyof typeof ENTITY_TABLES {
  return typeof t === "string" && VALID_TYPES.includes(t);
}

type FieldPermission = "view" | "edit";
type FieldPermissionMap = Record<string, FieldPermission>;

/** All real columns of an entity type's underlying table, minus the internal/owner-only ones. */
async function shareableColumns(entityType: keyof typeof ENTITY_TABLES): Promise<string[]> {
  const cfg = ENTITY_TABLES[entityType];
  const r = await db.execute(sql.raw(
    `SELECT column_name FROM information_schema.columns WHERE table_name = ${safe(cfg.table)} ORDER BY ordinal_position`
  ));
  return (r.rows as any[]).map((row) => row.column_name).filter((c) => !NON_SHAREABLE_COLUMNS.has(c));
}

/**
 * Validates a client-supplied { field: 'view'|'edit' } map against the
 * entity type's real columns. Returns null (no per-field restriction — falls
 * back to legacy whole-entity `permission`) for an empty/absent input, or
 * throws a descriptive error for anything invalid so route handlers can
 * turn it into a 400.
 */
async function parseFieldPermissions(entityType: keyof typeof ENTITY_TABLES, input: unknown): Promise<FieldPermissionMap | null> {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("fieldPermissions must be an object of { field: 'view'|'edit' }");
  const entries = Object.entries(input as Record<string, unknown>);
  if (!entries.length) return null;

  const validColumns = new Set(await shareableColumns(entityType));
  const result: FieldPermissionMap = {};
  for (const [field, perm] of entries) {
    if (!validColumns.has(field)) throw new Error(`Unknown or non-shareable field: ${field}`);
    if (perm !== "view" && perm !== "edit") throw new Error(`Permission for field '${field}' must be 'view' or 'edit'`);
    result[field] = perm;
  }
  return result;
}

/** Keeps only the fields the field-permission map allows, dropping everything else. */
function filterToAllowedFields<T extends Record<string, any>>(entity: T, fieldPermissions: FieldPermissionMap): Partial<T> {
  const out: Partial<T> = {};
  for (const field of Object.keys(fieldPermissions)) {
    if (field in entity) out[field as keyof T] = entity[field];
  }
  return out;
}

// ─── POST /vault-shares — share an owned entity with another user ─────────
// body: { entityType, entityId, username, permission? ('view'|'edit') }
router.post("/vault-shares", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { entityType, entityId, username, permission = "view", fieldPermissions } = req.body;

  if (!isValidType(entityType)) { res.status(400).json({ error: `entityType must be one of: ${VALID_TYPES.join(", ")}` }); return; }
  const id = parseInt(entityId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid entityId" }); return; }
  if (!username || typeof username !== "string" || !username.trim()) { res.status(400).json({ error: "username is required" }); return; }
  if (!["view", "edit"].includes(permission)) { res.status(400).json({ error: "permission must be 'view' or 'edit'" }); return; }

  const cfg = ENTITY_TABLES[entityType];

  let parsedFieldPermissions: FieldPermissionMap | null;
  try {
    parsedFieldPermissions = await parseFieldPermissions(entityType, fieldPermissions);
  } catch (err: any) {
    res.status(400).json({ error: err.message }); return;
  }

  try {
    // Must own the entity to share it — ownership itself is never touched below.
    const ownedCheck = await db.execute(sql.raw(
      `SELECT id FROM ${cfg.table} WHERE id = ${id} AND user_id = ${userId}${notTrashedClause(cfg)}`
    ));
    if (!ownedCheck.rows.length) { res.status(404).json({ error: "Entity not found, not owned by you, or in trash" }); return; }

    const targetResult = await db.execute(sql.raw(
      `SELECT id, username FROM users WHERE username = ${safe(username.trim())} OR email = ${safe(username.trim())}`
    ));
    const target = targetResult.rows[0] as any;
    if (!target) { res.status(404).json({ error: "User not found" }); return; }
    if (Number(target.id) === userId) { res.status(400).json({ error: "You already own this — can't share with yourself" }); return; }

    const fieldPermsSql = safe(parsedFieldPermissions ? JSON.stringify(parsedFieldPermissions) : null);
    const result = await db.execute(sql.raw(`
      INSERT INTO vault_shares (entity_type, entity_id, owner_id, shared_with_user_id, permission, field_permissions, is_active, revoked_at)
      VALUES (${safe(entityType)}, ${id}, ${userId}, ${Number(target.id)}, ${safe(permission)}, ${fieldPermsSql}, TRUE, NULL)
      ON CONFLICT (entity_type, entity_id, shared_with_user_id)
      DO UPDATE SET permission = ${safe(permission)}, field_permissions = ${fieldPermsSql}, is_active = TRUE, revoked_at = NULL, updated_at = NOW()
      RETURNING *
    `));

    const share = result.rows[0] as any;

    createNotification(
      Number(target.id),
      "vault_share",
      "New vault item shared with you",
      `Someone shared a ${entityType} vault item with you (${parsedFieldPermissions ? `${Object.keys(parsedFieldPermissions).length} field(s)` : permission} access).`,
      { entityType, entityId: id, shareId: share.id }
    ).catch(() => {});

    res.status(201).json({
      id: share.id,
      entityType: share.entity_type,
      entityId: share.entity_id,
      ownerId: share.owner_id,
      sharedWithUserId: share.shared_with_user_id,
      sharedWithUsername: target.username,
      permission: share.permission,
      fieldPermissions: parsedFieldPermissions,
      isActive: share.is_active,
      createdAt: share.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /vault-shares/fields/:entityType — shareable field list for the UI ──
// Lets the frontend build a per-field permission picker without hardcoding
// each entity type's column list (which does vary — local/entity/kyc/game
// each have a different shape).
router.get("/vault-shares/fields/:entityType", requireAuth, async (req, res): Promise<void> => {
  const entityType = req.params.entityType;
  if (!isValidType(entityType)) { res.status(400).json({ error: `entityType must be one of: ${VALID_TYPES.join(", ")}` }); return; }
  try {
    const fields = await shareableColumns(entityType);
    res.json({ entityType, fields, sensitiveFields: ENTITY_TABLES[entityType].sensitive });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── POST /vault-shares/bulk — share multiple entities (same or mixed
// types) with one user in a single call. Each item is checked for
// ownership independently — one bad item doesn't fail the whole batch.
// body: { items: [{ entityType, entityId }, ...], username, permission? }
router.post("/vault-shares/bulk", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { items, username, permission = "view", fieldPermissions } = req.body;

  if (!Array.isArray(items) || !items.length) { res.status(400).json({ error: "items must be a non-empty array of { entityType, entityId }" }); return; }
  if (items.length > 200) { res.status(400).json({ error: "Too many items in one batch (max 200)" }); return; }
  if (!username || typeof username !== "string" || !username.trim()) { res.status(400).json({ error: "username is required" }); return; }
  if (!["view", "edit"].includes(permission)) { res.status(400).json({ error: "permission must be 'view' or 'edit'" }); return; }

  // fieldPermissions here applies uniformly to every item in the batch. If a
  // given item's entity type doesn't have one of the named fields, that
  // item is skipped with a reason rather than failing the whole batch —
  // same "one bad item doesn't sink the batch" spirit as the rest of this
  // endpoint.
  const fieldPermCache = new Map<string, FieldPermissionMap | null>();
  async function fieldPermissionsFor(entityType: keyof typeof ENTITY_TABLES): Promise<FieldPermissionMap | null> {
    if (fieldPermCache.has(entityType)) return fieldPermCache.get(entityType)!;
    const parsed = await parseFieldPermissions(entityType, fieldPermissions);
    fieldPermCache.set(entityType, parsed);
    return parsed;
  }

  try {
    const targetResult = await db.execute(sql.raw(
      `SELECT id, username FROM users WHERE username = ${safe(username.trim())} OR email = ${safe(username.trim())}`
    ));
    const target = targetResult.rows[0] as any;
    if (!target) { res.status(404).json({ error: "User not found" }); return; }
    if (Number(target.id) === userId) { res.status(400).json({ error: "You already own this — can't share with yourself" }); return; }

    // Phase C27 — audit-only, see auditVaultShareCreateOwnership()'s own
    // header. Does not affect which items get shared below.
    await auditVaultShareCreateOwnership(req, items);

    const shared: any[] = [];
    const failed: { entityType: string; entityId: number; reason: string }[] = [];

    for (const item of items) {
      const entityType = item?.entityType;
      const entityId = parseInt(item?.entityId, 10);
      if (!isValidType(entityType) || isNaN(entityId)) {
        failed.push({ entityType: String(entityType), entityId: Number(item?.entityId), reason: "Invalid entityType/entityId" });
        continue;
      }
      const cfg = ENTITY_TABLES[entityType];
      try {
        const itemFieldPerms = await fieldPermissionsFor(entityType);
        const ownedCheck = await db.execute(sql.raw(`SELECT id FROM ${cfg.table} WHERE id = ${entityId} AND user_id = ${userId}${notTrashedClause(cfg)}`));
        if (!ownedCheck.rows.length) {
          failed.push({ entityType, entityId, reason: "Not found, not owned by you, or in trash" });
          continue;
        }
        const fieldPermsSql = safe(itemFieldPerms ? JSON.stringify(itemFieldPerms) : null);
        const result = await db.execute(sql.raw(`
          INSERT INTO vault_shares (entity_type, entity_id, owner_id, shared_with_user_id, permission, field_permissions, is_active, revoked_at)
          VALUES (${safe(entityType)}, ${entityId}, ${userId}, ${Number(target.id)}, ${safe(permission)}, ${fieldPermsSql}, TRUE, NULL)
          ON CONFLICT (entity_type, entity_id, shared_with_user_id)
          DO UPDATE SET permission = ${safe(permission)}, field_permissions = ${fieldPermsSql}, is_active = TRUE, revoked_at = NULL, updated_at = NOW()
          RETURNING *
        `));
        shared.push(result.rows[0]);
      } catch (err: any) {
        failed.push({ entityType, entityId, reason: err?.message ?? "DB error" });
      }
    }

    if (shared.length) {
      const byType: Record<string, number> = {};
      for (const s of shared as any[]) byType[s.entity_type] = (byType[s.entity_type] ?? 0) + 1;
      const summary = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(", ");
      createNotification(
        Number(target.id),
        "vault_share",
        "New vault items shared with you",
        `Someone shared ${shared.length} vault item(s) with you (${summary}).`,
        { count: shared.length }
      ).catch(() => {});
    }

    res.status(shared.length ? 201 : 400).json({
      sharedCount: shared.length,
      failedCount: failed.length,
      shared: shared.map((s: any) => ({
        id: s.id, entityType: s.entity_type, entityId: s.entity_id, permission: s.permission, isActive: s.is_active,
      })),
      failed,
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});


// ─── GET /vault-shares/sent — entities I own that I've shared out ─────────
router.get("/vault-shares/sent", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entityType = req.query.entityType as string | undefined;
  try {
    const q = entityType && isValidType(entityType)
      ? sql.raw(`SELECT vs.*, u.username as recipient_username FROM vault_shares vs
                 JOIN users u ON u.id = vs.shared_with_user_id
                 WHERE vs.owner_id = ${userId} AND vs.entity_type = ${safe(entityType)}
                 ORDER BY vs.created_at DESC`)
      : sql.raw(`SELECT vs.*, u.username as recipient_username FROM vault_shares vs
                 JOIN users u ON u.id = vs.shared_with_user_id
                 WHERE vs.owner_id = ${userId}
                 ORDER BY vs.created_at DESC`);
    const result = await db.execute(q);
    const rows = result.rows as any[];

    // Attach a display label per entity without leaking sensitive fields.
    const byType: Record<string, number[]> = {};
    for (const r of rows) (byType[r.entity_type] ??= []).push(r.entity_id);

    const labels: Record<string, Record<number, string>> = {};
    for (const [type, ids] of Object.entries(byType)) {
      const cfg = ENTITY_TABLES[type];
      if (!cfg || !ids.length) continue;
      const entRes = await db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id IN (${ids.join(",")})`));
      labels[type] = {};
      for (const row of entRes.rows as any[]) labels[type][row.id] = cfg.label(row);
    }

    res.json(rows.map(r => ({
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      entityLabel: labels[r.entity_type]?.[r.entity_id] ?? `#${r.entity_id}`,
      sharedWithUserId: r.shared_with_user_id,
      sharedWithUsername: r.recipient_username,
      permission: r.permission,
      fieldPermissions: r.field_permissions ? JSON.parse(r.field_permissions) : null,
      isActive: r.is_active,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /vault-shares/received — entities shared with me ─────────────────
router.get("/vault-shares/received", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entityType = req.query.entityType as string | undefined;
  const activeOnly = req.query.activeOnly !== "false"; // default true
  try {
    const conditions = [`vs.shared_with_user_id = ${userId}`];
    if (activeOnly) conditions.push(`vs.is_active = TRUE`);
    if (entityType && isValidType(entityType)) conditions.push(`vs.entity_type = ${safe(entityType)}`);

    const result = await db.execute(sql.raw(
      `SELECT vs.*, u.username as owner_username FROM vault_shares vs
       JOIN users u ON u.id = vs.owner_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY vs.created_at DESC`
    ));
    const rows = result.rows as any[];

    const byType: Record<string, number[]> = {};
    for (const r of rows) (byType[r.entity_type] ??= []).push(r.entity_id);

    const labels: Record<string, Record<number, string>> = {};
    for (const [type, ids] of Object.entries(byType)) {
      const cfg = ENTITY_TABLES[type];
      if (!cfg || !ids.length) continue;
      const entRes = await db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id IN (${ids.join(",")})`));
      labels[type] = {};
      for (const row of entRes.rows as any[]) labels[type][row.id] = cfg.label(row);
    }

    res.json(rows.map(r => ({
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      entityLabel: labels[r.entity_type]?.[r.entity_id] ?? `#${r.entity_id}`,
      ownerId: r.owner_id,
      ownerUsername: r.owner_username,
      permission: r.permission,
      fieldPermissions: r.field_permissions ? JSON.parse(r.field_permissions) : null,
      isActive: r.is_active,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /vault-shares/entity/:entityType/:entityId — fetch the actual data
// for a shared entity. Allowed if the requester owns it, OR has an active
// share on it. This is the read path a recipient uses; it never changes
// user_id on the underlying row.
router.get("/vault-shares/entity/:entityType/:entityId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entityType = req.params.entityType;
  const entityId = parseInt(req.params.entityId as string, 10);
  if (!isValidType(entityType)) { res.status(400).json({ error: `entityType must be one of: ${VALID_TYPES.join(", ")}` }); return; }
  if (isNaN(entityId)) { res.status(400).json({ error: "Invalid entityId" }); return; }

  const cfg = ENTITY_TABLES[entityType];

  try {
    const ownRes = await db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id = ${entityId} AND user_id = ${userId}${notTrashedClause(cfg)}`));
    if (ownRes.rows.length) {
      res.json({ access: "owner", permission: "edit", fieldPermissions: null, entity: decryptRow(ownRes.rows[0] as any, cfg.sensitive as any) });
      return;
    }

    const shareRes = await db.execute(sql.raw(
      `SELECT * FROM vault_shares WHERE entity_type = ${safe(entityType)} AND entity_id = ${entityId}
       AND shared_with_user_id = ${userId} AND is_active = TRUE`
    ));
    const share = shareRes.rows[0] as any;
    if (!share) { res.status(403).json({ error: "Not shared with you" }); return; }

    const entRes = await db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id = ${entityId}${notTrashedClause(cfg)}`));
    if (!entRes.rows.length) { res.status(404).json({ error: "Entity no longer exists" }); return; }

    const decrypted = decryptRow(entRes.rows[0] as any, cfg.sensitive as any);
    const fieldPermissions: FieldPermissionMap | null = share.field_permissions ? JSON.parse(share.field_permissions) : null;

    if (fieldPermissions) {
      // Per-field share: only the named fields are visible at all, and
      // editable-ness is field-by-field rather than the whole-row
      // view/edit split used by legacy whole-entity shares.
      res.json({
        access: "shared",
        permission: share.permission,
        fieldPermissions,
        entity: filterToAllowedFields(decrypted, fieldPermissions),
      });
      return;
    }

    res.json({ access: "shared", permission: share.permission, fieldPermissions: null, entity: decrypted });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── PATCH /vault-shares/bulk — toggle isActive/permission on many shares
// at once. Must be registered before "/vault-shares/:id" so "bulk" isn't
// matched as an :id.
// body: { ids: number[], isActive?: boolean, permission?: 'view'|'edit' }
router.patch("/vault-shares/bulk", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { ids, isActive, permission } = req.body;
  if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: "ids must be a non-empty array" }); return; }
  const cleanIds = ids.map((i: unknown) => parseInt(i as string, 10)).filter((n: number) => !isNaN(n));
  if (!cleanIds.length) { res.status(400).json({ error: "No valid ids provided" }); return; }
  if (permission !== undefined && !["view", "edit"].includes(permission)) { res.status(400).json({ error: "permission must be 'view' or 'edit'" }); return; }

  await auditVaultShareBulkOwnership(req, cleanIds, "vault_share.bulk.update");

  const sets: string[] = ["updated_at = NOW()"];
  if (typeof isActive === "boolean") {
    sets.push(`is_active = ${isActive ? "TRUE" : "FALSE"}`);
    sets.push(`revoked_at = ${isActive ? "NULL" : "NOW()"}`);
  }
  if (permission !== undefined) sets.push(`permission = ${safe(permission)}`);

  try {
    const result = await db.execute(sql.raw(
      `UPDATE vault_shares SET ${sets.join(", ")} WHERE id IN (${cleanIds.join(",")}) AND owner_id = ${userId} RETURNING *`
    ));
    const rows = result.rows as any[];

    if (typeof isActive === "boolean" && !isActive) {
      for (const share of rows) {
        createNotification(
          Number(share.shared_with_user_id),
          "vault_share",
          "Shared access removed",
          `Access to a shared ${share.entity_type} vault item was turned off.`,
          { entityType: share.entity_type, entityId: share.entity_id }
        ).catch(() => {});
      }
    }

    res.json({ updatedCount: rows.length, updated: rows.map(s => ({ id: s.id, isActive: s.is_active, permission: s.permission })) });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── DELETE /vault-shares/bulk — remove many share records at once ────────
// Registered before "/vault-shares/:id" for the same reason as above.
// body: { ids: number[] }
router.delete("/vault-shares/bulk", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: "ids must be a non-empty array" }); return; }
  const cleanIds = ids.map((i: unknown) => parseInt(i as string, 10)).filter((n: number) => !isNaN(n));
  if (!cleanIds.length) { res.status(400).json({ error: "No valid ids provided" }); return; }

  await auditVaultShareBulkOwnership(req, cleanIds, "vault_share.bulk.delete");

  try {
    const result = await db.execute(sql.raw(
      `DELETE FROM vault_shares WHERE id IN (${cleanIds.join(",")}) AND owner_id = ${userId} RETURNING id`
    ));
    res.json({ deletedCount: result.rows.length });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── PATCH /vault-shares/:id — owner toggles access on/off, or changes permission
// Setting isActive to false is the "turn permission off" action — the item
// immediately stops showing up under the recipient's "shared with me" list.
router.patch("/vault-shares/:id", requireAuth, requireVaultShareOwnership("vault_share.update", denyVaultShareNotFound), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const { isActive, permission, fieldPermissions } = req.body;

  // Need the existing row's entity_type to validate fieldPermissions against
  // the right table, and to confirm ownership before touching anything.
  const existingRes = await db.execute(sql.raw(`SELECT * FROM vault_shares WHERE id = ${id} AND owner_id = ${userId}`));
  const existing = existingRes.rows[0] as any;
  if (!existing) { res.status(404).json({ error: "Not found or not yours to manage" }); return; }

  const sets: string[] = ["updated_at = NOW()"];
  if (typeof isActive === "boolean") {
    sets.push(`is_active = ${isActive ? "TRUE" : "FALSE"}`);
    sets.push(`revoked_at = ${isActive ? "NULL" : "NOW()"}`);
  }
  if (permission !== undefined) {
    if (!["view", "edit"].includes(permission)) { res.status(400).json({ error: "permission must be 'view' or 'edit'" }); return; }
    sets.push(`permission = ${safe(permission)}`);
  }
  if (fieldPermissions !== undefined) {
    // Explicit null clears per-field restrictions back to whole-entity sharing.
    if (fieldPermissions === null) {
      sets.push(`field_permissions = NULL`);
    } else {
      let parsed: FieldPermissionMap | null;
      try {
        parsed = await parseFieldPermissions(existing.entity_type, fieldPermissions);
      } catch (err: any) {
        res.status(400).json({ error: err.message }); return;
      }
      sets.push(`field_permissions = ${safe(parsed ? JSON.stringify(parsed) : null)}`);
    }
  }

  try {
    const result = await db.execute(sql.raw(
      `UPDATE vault_shares SET ${sets.join(", ")} WHERE id = ${id} AND owner_id = ${userId} RETURNING *`
    ));
    if (!result.rows.length) { res.status(404).json({ error: "Not found or not yours to manage" }); return; }
    const share = result.rows[0] as any;

    if (typeof isActive === "boolean" && !isActive) {
      createNotification(
        Number(share.shared_with_user_id),
        "vault_share",
        "Shared access removed",
        `Access to a shared ${share.entity_type} vault item was turned off.`,
        { entityType: share.entity_type, entityId: share.entity_id }
      ).catch(() => {});
    }

    res.json({
      id: share.id,
      entityType: share.entity_type,
      entityId: share.entity_id,
      isActive: share.is_active,
      permission: share.permission,
      fieldPermissions: share.field_permissions ? JSON.parse(share.field_permissions) : null,
      revokedAt: share.revoked_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── DELETE /vault-shares/:id — owner removes the share record entirely ───
router.delete("/vault-shares/:id", requireAuth, requireVaultShareOwnership("vault_share.delete", denyVaultShareNotFound), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const result = await db.execute(sql.raw(
      `DELETE FROM vault_shares WHERE id = ${id} AND owner_id = ${userId} RETURNING id`
    ));
    if (!result.rows.length) { res.status(404).json({ error: "Not found or not yours to manage" }); return; }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

export default router;
