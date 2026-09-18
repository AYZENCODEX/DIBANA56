import { Router, type Request } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { pepDecisionObserver } from "../middlewares/auth";
import { authorizeMany } from "../lib/policy/pep";
import type { ResourceRef } from "../lib/policy/types";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../lib/policy/resource";

const router = Router();

type BulkAction = "delete" | "update_status" | "update_category" | "assign_team";

function safeIds(ids: unknown[]): number[] {
  return ids.map(id => parseInt(String(id), 10)).filter(n => !isNaN(n) && n > 0);
}

// ─── Route Integration Roadmap — Season C, Phase C27 (bulk-family
// policy-engine consistency sweep) ────────────────────────────────────────
// `vault/bulk`, `local-accounts/bulk` and `wallets/bulk` were already
// correctly scoped (raw SQL `WHERE id IN (...) AND user_id = ${userId}` —
// see the roadmap's own audit table) — this phase does NOT change that
// SQL at all. What it adds is the same `authorizeMany()` /
// `pepDecisionObserver` audit trail every migrated `:id` route in this
// series already gets, so a bulk request's per-row allow/deny is now a
// real, centrally observable `AuthorizationDecision` instead of only a
// WHERE clause no PDP ever saw — same posture as `ayzen-mailbox.ts`'s
// `PATCH /mailbox/bulk` (Phase C13, see that file's own header). One
// dedicated engine per table, reused across every route in this file that
// touches it.
const vaultEntryBulkOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultEntryBulkOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

const localAccountBulkOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
localAccountBulkOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

const walletBulkOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
walletBulkOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

/**
 * Fetches each candidate row's REAL owner — NOT filtered by `user_id`,
 * same trust-boundary posture as `ayzen-mailbox.ts`'s bulk candidate
 * lookup — and runs one `authorizeMany()` batch over them purely to
 * produce an audited `AuthorizationDecision` per id. The caller's own
 * pre-existing SQL (still filtered by `user_id`, unchanged by this phase)
 * is what actually decides which rows get touched; this only makes that
 * same decision visible to the PDP/audit trail. Call for its audit
 * side-effect only — its return value is intentionally discarded by every
 * call site below.
 */
async function auditBulkOwnership(
  req: Request,
  engine: PolicyEngine,
  type: string,
  table: string,
  ids: number[],
  action: string,
): Promise<void> {
  if (!ids.length) return;
  const idList = ids.join(",");
  const candidates = (await db.execute(sql.raw(
    `SELECT id, user_id FROM ${table} WHERE id IN (${idList})`
  ))).rows as any[];
  if (!candidates.length) return;
  await authorizeMany<number>({
    req,
    engine,
    action,
    items: candidates.map((row): { key: number; resource: ResourceRef } => ({
      key: Number(row.id),
      resource: { type, id: Number(row.id), ownerId: row.user_id != null ? Number(row.user_id) : undefined },
    })),
  });
}

// ── POST /vault/bulk — bulk ops on vault entries ──────────────────────────────
router.post("/vault/bulk", requireAuth, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { ids, action, payload = {} } = req.body as { ids: unknown[]; action: BulkAction; payload: Record<string, unknown> };

  const safeIdList = safeIds(ids);
  if (!safeIdList.length) { res.status(400).json({ error: "No valid IDs provided" }); return; }

  await auditBulkOwnership(req, vaultEntryBulkOwnershipEngine, "vault_entry", "vault_entries", safeIdList, `vault_entry.bulk.${action}`);

  const idList = safeIdList.join(",");

  switch (action) {
    case "delete":
      await db.execute(sql.raw(`DELETE FROM vault_entries WHERE id IN (${idList}) AND user_id = ${userId}`));
      res.json({ ok: true, affected: safeIdList.length });
      return;
    case "update_status": {
      const allowed = ["active", "warning", "banned", "suspended"];
      if (!allowed.includes(String(payload.status))) { res.status(400).json({ error: "Invalid status" }); return; }
      await db.execute(sql.raw(`UPDATE vault_entries SET status = '${payload.status}', last_activity_at = NOW() WHERE id IN (${idList}) AND user_id = ${userId}`));
      res.json({ ok: true, affected: safeIdList.length });
      return;
    }
    case "update_category": {
      const cat = String(payload.category ?? "").replace(/'/g, "''");
      if (!cat) { res.status(400).json({ error: "category required" }); return; }
      await db.execute(sql.raw(`UPDATE vault_entries SET category = '${cat}', updated_at = NOW() WHERE id IN (${idList}) AND user_id = ${userId}`));
      res.json({ ok: true, affected: safeIdList.length });
      return;
    }
    case "assign_team": {
      const teamId = parseInt(String(payload.teamId), 10);
      if (isNaN(teamId)) { res.status(400).json({ error: "teamId required" }); return; }
      await db.execute(sql.raw(`UPDATE vault_entries SET team_id = ${teamId}, updated_at = NOW() WHERE id IN (${idList}) AND user_id = ${userId}`));
      res.json({ ok: true, affected: safeIdList.length });
      return;
    }
    default:
      res.status(400).json({ error: `Unknown action: ${action}` });
  }
});

// ── POST /local-accounts/bulk — bulk ops on local accounts ───────────────────
router.post("/local-accounts/bulk", requireAuth, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { ids, action, payload = {} } = req.body as { ids: unknown[]; action: BulkAction; payload: Record<string, unknown> };

  const safeIdList = safeIds(ids);
  if (!safeIdList.length) { res.status(400).json({ error: "No valid IDs provided" }); return; }
  const idList = safeIdList.join(",");

  await auditBulkOwnership(req, localAccountBulkOwnershipEngine, "local_account", "local_accounts", safeIdList, `local_account.bulk.${action}`);

  switch (action) {
    case "delete":
      await db.execute(sql.raw(`DELETE FROM local_accounts WHERE id IN (${idList}) AND user_id = ${userId}`));
      res.json({ ok: true, affected: safeIdList.length });
      return;
    case "update_category": {
      const cat = String(payload.category ?? "").replace(/'/g, "''");
      if (!cat) { res.status(400).json({ error: "category required" }); return; }
      await db.execute(sql.raw(`UPDATE local_accounts SET category = '${cat}', updated_at = NOW() WHERE id IN (${idList}) AND user_id = ${userId}`));
      res.json({ ok: true, affected: safeIdList.length });
      return;
    }
    default:
      res.status(400).json({ error: `Unknown action: ${action}` });
  }
});

// ── POST /wallets/bulk — bulk ops on wallets ──────────────────────────────────
router.post("/wallets/bulk", requireAuth, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { ids, action, payload = {} } = req.body as { ids: unknown[]; action: BulkAction; payload: Record<string, unknown> };

  const safeIdList = safeIds(ids);
  if (!safeIdList.length) { res.status(400).json({ error: "No valid IDs provided" }); return; }
  const idList = safeIdList.join(",");

  await auditBulkOwnership(req, walletBulkOwnershipEngine, "wallet", "wallets", safeIdList, `wallet.bulk.${action}`);

  switch (action) {
    case "delete":
      await db.execute(sql.raw(`DELETE FROM wallets WHERE id IN (${idList}) AND user_id = ${userId}`));
      res.json({ ok: true, affected: safeIdList.length });
      return;
    case "update_category": {
      const chain = String(payload.chain ?? "").replace(/'/g, "''");
      if (!chain) { res.status(400).json({ error: "chain required" }); return; }
      await db.execute(sql.raw(`UPDATE wallets SET chain = '${chain}', updated_at = NOW() WHERE id IN (${idList}) AND user_id = ${userId}`));
      res.json({ ok: true, affected: safeIdList.length });
      return;
    }
    default:
      res.status(400).json({ error: `Unknown action: ${action}` });
  }
});

// ── POST /projects/bulk-enroll — enroll multiple entities into a project ─────
// Phase 3: accepts either entityIds (numeric vault_entry ids) or
// entitySerials (a list of vault_entries.entity_serial values, resolved to
// ids server-side) — the two are merged and deduped. Also accepts an
// optional accountData object (Main/Info/Recovery fields, same shape as the
// single-enroll route) applied to every enrolled entity's snapshot.
// Phase C26: entityIds is now pre-filtered against vault_entries.user_id,
// same as the entitySerials path — non-owned ids are silently dropped
// rather than enrolled under the caller's user_id (was: cross-tenant
// ownership bypass, any guessable vault_entries.id could be enrolled).
router.post("/projects/bulk-enroll", requireAuth, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { projectId, entityIds, entitySerials, accountData, dataEntityId } = req.body as {
    projectId: number; entityIds?: unknown[]; entitySerials?: unknown[]; accountData?: Record<string, unknown>; dataEntityId?: number;
  };

  if (!projectId) { res.status(400).json({ error: "projectId required" }); return; }

  const safeEntityIds = new Set<number>();

  const requestedIds = safeIds(entityIds ?? []);
  if (requestedIds.length) {
    const idList = requestedIds.join(",");
    const ownedRows = await db.execute(sql.raw(
      `SELECT id FROM vault_entries WHERE user_id = ${userId} AND id IN (${idList})`
    ));
    for (const row of ownedRows.rows as any[]) safeEntityIds.add(Number(row.id));
  }

  const safeSerials = Array.isArray(entitySerials)
    ? entitySerials.map(s => String(s).trim()).filter(Boolean)
    : [];
  if (safeSerials.length) {
    const escaped = safeSerials.map(s => `'${s.replace(/'/g, "''")}'`).join(",");
    const resolved = await db.execute(sql.raw(
      `SELECT id FROM vault_entries WHERE user_id = ${userId} AND entity_serial IN (${escaped})`
    ));
    for (const row of resolved.rows as any[]) safeEntityIds.add(Number(row.id));
  }

  if (!safeEntityIds.size) { res.status(400).json({ error: "entityIds or entitySerials required" }); return; }

  const accountDataJson = accountData && typeof accountData === "object" ? JSON.stringify(accountData) : null;
  const safeDataEntityId = dataEntityId ? Number(dataEntityId) : null;

  let enrolled = 0;
  for (const entityId of safeEntityIds) {
    try {
      await db.execute(sql`
        INSERT INTO project_enrollments (project_id, vault_entry_id, user_id, account_data, data_entity_id)
        VALUES (${projectId}, ${entityId}, ${userId}, ${accountDataJson}, ${safeDataEntityId})
        ON CONFLICT DO NOTHING
      `);
      enrolled++;
    } catch { /* skip duplicates */ }
  }

  res.json({ ok: true, enrolled });
});

// ── POST /csv/export — export resources as CSV ───────────────────────────────
router.get("/csv/export/:resource", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const resource = Array.isArray(req.params.resource) ? req.params.resource[0] : req.params.resource;

  let rows: any[] = [];
  let filename = "export.csv";

  if (resource === "vault") {
    const result = await db.execute(sql.raw(
      `SELECT id, entity_serial, category, project_name, email, twitter_username, discord_username, telegram_username, created_at
       FROM vault_entries WHERE user_id = ${userId}`
    ));
    rows = result.rows as any[];
    filename = "entities.csv";
  } else if (resource === "local-accounts") {
    const result = await db.execute(sql.raw(
      `SELECT id, label, category, username, email, followers, account_worth, buy_price, created_at
       FROM local_accounts WHERE user_id = ${userId}`
    ));
    rows = result.rows as any[];
    filename = "local-accounts.csv";
  } else if (resource === "wallets") {
    const result = await db.execute(sql.raw(
      `SELECT id, label, address, chain, balance, balance_usd, tx_count, created_at
       FROM wallets WHERE user_id = ${userId}`
    ));
    rows = result.rows as any[];
    filename = "wallets.csv";
  } else {
    res.status(400).json({ error: "Unknown resource" }); return;
  }

  if (!rows.length) { res.status(200).send(""); return; }

  const headers = Object.keys(rows[0]).join(",");
  const csvRows = rows.map(r => Object.values(r).map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
  const csv = [headers, ...csvRows].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

export default router;
