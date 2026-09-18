import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { decryptRow } from "../lib/vault-crypto";
import { notifyOrganizationInvited, notifyOrganizationRoleChanged } from "../lib/notification-bus";
import { broadcastToUser } from "./events";
import { ENTITY_TABLES, isValidType, VALID_TYPES } from "./vault-shares";

const router = Router();

/**
 * routes/organizations.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Workspace — Phase 8: Organization Accounts (master plan §2/§7 Phase
 * 8 — "Enterprise/Team tier: org accounts, shared vaults, managed extension
 * policy"). See migrations/109_ayzen_organizations.sql for why this is a
 * new concept distinct from `teams`/`team_members` (the farming-team
 * product `routes/teams.ts` already covers, folded into the Warde brand
 * early per CHANGES_WARDE_SUBDOMAIN_SPLIT.md).
 *
 * Authorization here is hand-rolled membership-role checks (same posture
 * as `teams.ts`'s own leader/member gates), NOT PDP-routed via
 * `authorize()`/`requireOwnership()` — this phase intentionally does not
 * wire `organization-access-rule.ts`/`DrizzleOrganizationProvider` into a
 * live PEP call site (see that provider's own file header for why: nothing
 * in the app constructs a `PolicyInformationPoint` with real providers on
 * a live request path yet, org or otherwise). Follow-up, not faked here.
 */

type OrgRole = "owner" | "admin" | "member";

async function getMembership(organizationId: number, userId: number): Promise<{ role: OrgRole; status: string } | null> {
  const rows = (await db.execute(sql`
    SELECT role, status FROM organization_members WHERE organization_id = ${organizationId} AND user_id = ${userId} LIMIT 1
  `)).rows as any[];
  if (!rows.length) return null;
  return { role: rows[0].role, status: rows[0].status };
}

/** owner or admin, and membership must be active — invited-but-pending members manage nothing. */
function canManage(m: { role: OrgRole; status: string } | null): boolean {
  return !!m && m.status === "active" && (m.role === "owner" || m.role === "admin");
}

// ─── GET /organizations — organizations the current user is an active member of ──
router.get("/organizations", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const result = await db.execute(sql`
    SELECT o.*, om.role AS my_role,
           (SELECT COUNT(*)::int FROM organization_members m2 WHERE m2.organization_id = o.id AND m2.status = 'active') AS member_count
    FROM organizations o
    JOIN organization_members om ON om.organization_id = o.id
    WHERE om.user_id = ${userId} AND om.status = 'active'
    ORDER BY o.created_at DESC
  `);
  res.json(result.rows);
});

// ─── GET /organizations/my-invites — pending invites for the current user (MUST be before /:id) ──
router.get("/organizations/my-invites", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const result = await db.execute(sql`
    SELECT om.id, om.organization_id, om.role, om.created_at AS invited_at,
           o.name AS organization_name, u.username AS invited_by_username
    FROM organization_members om
    JOIN organizations o ON o.id = om.organization_id
    LEFT JOIN users u ON u.id = om.invited_by
    WHERE om.user_id = ${userId} AND om.status = 'pending'
    ORDER BY om.created_at DESC
  `);
  res.json(result.rows);
});

// ─── POST /organizations — create a new organization; creator becomes owner ──
router.post("/organizations", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { name } = req.body;
  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  const orgName = String(name).trim();
  try {
    const result = await db.execute(sql`
      INSERT INTO organizations (name, owner_id) VALUES (${orgName}, ${userId}) RETURNING *
    `);
    const org = result.rows[0] as any;
    await db.execute(sql`
      INSERT INTO organization_members (organization_id, user_id, role, status)
      VALUES (${org.id}, ${userId}, 'owner', 'active')
    `);
    res.status(201).json(org);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create organization", detail: err?.message });
  }
});

// ─── GET /organizations/:id — org detail + member list (active members only) ──
router.get("/organizations/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!membership || membership.status !== "active") { res.status(404).json({ error: "Organization not found" }); return; }
  const orgRes = await db.execute(sql`SELECT * FROM organizations WHERE id = ${orgId} LIMIT 1`);
  const org = orgRes.rows[0];
  if (!org) { res.status(404).json({ error: "Organization not found" }); return; }
  const members = (await db.execute(sql`
    SELECT om.id, om.user_id, om.role, om.status, om.created_at, u.username
    FROM organization_members om JOIN users u ON u.id = om.user_id
    WHERE om.organization_id = ${orgId}
    ORDER BY (om.role = 'owner') DESC, om.created_at ASC
  `)).rows;
  res.json({ ...(org as object), myRole: membership.role, members });
});

// ─── PATCH /organizations/:id — rename (owner/admin only) ────────────────────
router.patch("/organizations/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!canManage(membership)) { res.status(403).json({ error: "Only an org owner or admin can update this" }); return; }
  const { name } = req.body;
  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  await db.execute(sql`UPDATE organizations SET name = ${String(name).trim()}, updated_at = now() WHERE id = ${orgId}`);
  res.json({ ok: true });
});

// ─── DELETE /organizations/:id — owner only ───────────────────────────────────
router.delete("/organizations/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!membership || membership.role !== "owner") { res.status(403).json({ error: "Only the org owner can delete this organization" }); return; }
  // organization_members / organization_vault_shares / organization_extension_policies
  // all reference organizations(id) ON DELETE CASCADE (migration 109) — one delete is enough.
  await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
  res.json({ ok: true });
});

// ─── POST /organizations/:id/invite — invite a member by username or email ───
router.post("/organizations/:id/invite", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!canManage(membership)) { res.status(403).json({ error: "Only an org owner or admin can invite members" }); return; }
  const { username } = req.body;
  if (!username?.trim()) { res.status(400).json({ error: "username is required" }); return; }
  const userResult = await db.execute(sql`SELECT id FROM users WHERE username = ${username.trim()} OR email = ${username.trim()} LIMIT 1`);
  if (!userResult.rows.length) { res.status(404).json({ error: "User not found" }); return; }
  const inviteeId = (userResult.rows[0] as any).id;
  try {
    await db.execute(sql`
      INSERT INTO organization_members (organization_id, user_id, role, status, invited_by)
      VALUES (${orgId}, ${inviteeId}, 'member', 'pending', ${userId})
    `);
    const orgNameRes = await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}`);
    const orgName = (orgNameRes.rows[0] as any)?.name ?? `Organization #${orgId}`;
    broadcastToUser(inviteeId, "organization_invite", { organizationId: orgId });
    notifyOrganizationInvited(inviteeId, orgId, orgName).catch(() => {});
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: "User already invited or a member" });
  }
});

// ─── PATCH /organizations/:id/invites/respond — accept or decline own pending invite ──
router.patch("/organizations/:id/invites/respond", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const { accept } = req.body as { accept?: boolean };
  const membership = await getMembership(orgId, userId);
  if (!membership || membership.status !== "pending") { res.status(404).json({ error: "No pending invite for this organization" }); return; }
  if (accept) {
    await db.execute(sql`UPDATE organization_members SET status = 'active', updated_at = now() WHERE organization_id = ${orgId} AND user_id = ${userId}`);
  } else {
    await db.execute(sql`DELETE FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${userId}`);
  }
  res.json({ ok: true });
});

// ─── DELETE /organizations/:id/members/:memberId — remove a member ───────────
router.delete("/organizations/:id/members/:memberId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const memberId = parseInt(req.params.memberId as string, 10);
  const membership = await getMembership(orgId, userId);
  // "manager OR self" — same shape teams.ts's own member-removal route uses.
  if (!canManage(membership) && userId !== memberId) { res.status(403).json({ error: "Not allowed" }); return; }
  const targetRes = await db.execute(sql`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${memberId}`);
  const targetRole = (targetRes.rows[0] as any)?.role;
  if (targetRole === "owner") { res.status(400).json({ error: "Cannot remove the org owner — transfer ownership first" }); return; }
  await db.execute(sql`DELETE FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${memberId}`);
  res.json({ ok: true });
});

// ─── PATCH /organizations/:id/members/:memberId/role — promote/demote (owner only) ──
router.patch("/organizations/:id/members/:memberId/role", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const memberId = parseInt(req.params.memberId as string, 10);
  const { role } = req.body;
  if (!["admin", "member"].includes(role)) { res.status(400).json({ error: "role must be admin or member" }); return; }
  const membership = await getMembership(orgId, userId);
  if (!membership || membership.role !== "owner") { res.status(403).json({ error: "Only the org owner can change roles" }); return; }
  const targetRes = await db.execute(sql`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${memberId}`);
  if ((targetRes.rows[0] as any)?.role === "owner") { res.status(400).json({ error: "Cannot change the owner's role — transfer ownership instead" }); return; }
  await db.execute(sql`UPDATE organization_members SET role = ${role}, updated_at = now() WHERE organization_id = ${orgId} AND user_id = ${memberId}`);
  const orgNameRes = await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}`);
  const orgName = (orgNameRes.rows[0] as any)?.name ?? `Organization #${orgId}`;
  notifyOrganizationRoleChanged(memberId, orgId, orgName, role).catch(() => {});
  res.json({ ok: true });
});

// ─── POST /organizations/:id/transfer-ownership — owner hands off to another active member ──
router.post("/organizations/:id/transfer-ownership", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const { memberId } = req.body;
  const targetId = parseInt(memberId, 10);
  const membership = await getMembership(orgId, userId);
  if (!membership || membership.role !== "owner") { res.status(403).json({ error: "Only the current owner can transfer ownership" }); return; }
  const targetMembership = await getMembership(orgId, targetId);
  if (!targetMembership || targetMembership.status !== "active") { res.status(400).json({ error: "Target must be an active member" }); return; }
  await db.execute(sql`UPDATE organizations SET owner_id = ${targetId}, updated_at = now() WHERE id = ${orgId}`);
  await db.execute(sql`UPDATE organization_members SET role = 'admin', updated_at = now() WHERE organization_id = ${orgId} AND user_id = ${userId}`);
  await db.execute(sql`UPDATE organization_members SET role = 'owner', updated_at = now() WHERE organization_id = ${orgId} AND user_id = ${targetId}`);
  res.json({ ok: true });
});

// ─── POST /organizations/:id/leave — leave (owner cannot leave — must transfer or delete) ──
router.post("/organizations/:id/leave", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!membership) { res.status(404).json({ error: "Not a member" }); return; }
  if (membership.role === "owner") { res.status(400).json({ error: "Owner cannot leave — transfer ownership or delete the organization" }); return; }
  await db.execute(sql`DELETE FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${userId}`);
  res.json({ ok: true });
});

// ─── Managed extension policy ("master plan §2's third Phase-8 line item) ────
// GET is any active member (so Astra/the settings page can show the
// effective policy to everyone it applies to); PUT is owner/admin only.
router.get("/organizations/:id/extension-policy", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!membership || membership.status !== "active") { res.status(404).json({ error: "Organization not found" }); return; }
  const rows = (await db.execute(sql`SELECT * FROM organization_extension_policies WHERE organization_id = ${orgId} LIMIT 1`)).rows as any[];
  const row = rows[0];
  // No row yet = every default off, same "missing row = default posture"
  // convention notification_preferences (migration 108) already uses.
  res.json({
    organizationId: orgId,
    disableSeedReveal: row?.disable_seed_reveal ?? false,
    requireDomainAllowlist: row?.require_domain_allowlist ?? false,
    allowedDomains: row?.allowed_domains ? JSON.parse(row.allowed_domains) : [],
    updatedAt: row?.updated_at ?? null,
  });
});

router.put("/organizations/:id/extension-policy", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!canManage(membership)) { res.status(403).json({ error: "Only an org owner or admin can update the extension policy" }); return; }
  const { disableSeedReveal, requireDomainAllowlist, allowedDomains } = req.body as {
    disableSeedReveal?: boolean; requireDomainAllowlist?: boolean; allowedDomains?: string[];
  };
  if (allowedDomains !== undefined && (!Array.isArray(allowedDomains) || allowedDomains.some((d) => typeof d !== "string"))) {
    res.status(400).json({ error: "allowedDomains must be an array of strings" });
    return;
  }
  const domainsJson = JSON.stringify(allowedDomains ?? []);
  await db.execute(sql`
    INSERT INTO organization_extension_policies (organization_id, disable_seed_reveal, require_domain_allowlist, allowed_domains, updated_by, updated_at)
    VALUES (${orgId}, ${!!disableSeedReveal}, ${!!requireDomainAllowlist}, ${domainsJson}, ${userId}, now())
    ON CONFLICT (organization_id) DO UPDATE SET
      disable_seed_reveal = EXCLUDED.disable_seed_reveal,
      require_domain_allowlist = EXCLUDED.require_domain_allowlist,
      allowed_domains = EXCLUDED.allowed_domains,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `);
  res.json({ ok: true });
});

// ─── Org-wide ("shared") vault sharing ─────────────────────────────────────
// Shares one vault entity with every ACTIVE member of an org at once,
// instead of one routes/vault-shares.ts row per recipient. The sharer must
// currently own the entity (checked below, same trust boundary
// vault-shares.ts's own per-user sharing draws) AND be an active member of
// the target org — sharing into an org you don't belong to would let a
// non-member hand out access to a group they have no standing in.
router.post("/organizations/:id/vault-shares", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!membership || membership.status !== "active") { res.status(404).json({ error: "Organization not found" }); return; }
  const { entityType, entityId } = req.body as { entityType?: unknown; entityId?: unknown };
  if (!isValidType(entityType)) { res.status(400).json({ error: `entityType must be one of: ${VALID_TYPES.join(", ")}` }); return; }
  const id = parseInt(entityId as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid entityId" }); return; }
  const cfg = ENTITY_TABLES[entityType];
  const ownedRes = await db.execute(sql.raw(`SELECT id FROM ${cfg.table} WHERE id = ${id} AND user_id = ${userId}`));
  if (!ownedRes.rows.length) { res.status(403).json({ error: "You don't own this entity" }); return; }
  try {
    const result = await db.execute(sql`
      INSERT INTO organization_vault_shares (organization_id, entity_type, entity_id, shared_by)
      VALUES (${orgId}, ${entityType}, ${id}, ${userId}) RETURNING *
    `);
    res.status(201).json(result.rows[0]);
  } catch {
    res.status(409).json({ error: "Already shared with this organization" });
  }
});

// GET /organizations/:id/vault-shares — every entity currently shared with
// this org, decrypted, for the requesting (active) member. Deliberately a
// dedicated endpoint rather than folded into GET /vault-shares/received —
// see this phase's CHANGES doc for why (keeps vault-shares.ts's existing,
// already-tested per-user resolution query untouched).
router.get("/organizations/:id/vault-shares", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!membership || membership.status !== "active") { res.status(404).json({ error: "Organization not found" }); return; }
  const shares = (await db.execute(sql`
    SELECT ovs.*, u.username AS shared_by_username FROM organization_vault_shares ovs
    JOIN users u ON u.id = ovs.shared_by
    WHERE ovs.organization_id = ${orgId} AND ovs.is_active = TRUE
    ORDER BY ovs.created_at DESC
  `)).rows as any[];

  const byType: Record<string, number[]> = {};
  for (const s of shares) (byType[s.entity_type] ??= []).push(s.entity_id);

  const entities: Record<string, Record<number, Record<string, unknown>>> = {};
  for (const [type, ids] of Object.entries(byType)) {
    const cfg = ENTITY_TABLES[type];
    if (!cfg || !ids.length) continue;
    const rows = (await db.execute(sql.raw(`SELECT * FROM ${cfg.table} WHERE id IN (${ids.join(",")})`))).rows as any[];
    entities[type] = {};
    for (const row of rows) entities[type][row.id] = decryptRow(row, cfg.sensitive as any);
  }

  res.json(shares.map((s) => {
    const entity = entities[s.entity_type]?.[s.entity_id];
    const fieldPermissions = s.field_permissions ? JSON.parse(s.field_permissions) : null;
    return {
      id: s.id,
      entityType: s.entity_type,
      entityId: s.entity_id,
      entityLabel: entity ? ENTITY_TABLES[s.entity_type].label(entity) : `#${s.entity_id}`,
      entity: entity
        ? (fieldPermissions ? Object.fromEntries(Object.keys(fieldPermissions).map((f) => [f, (entity as any)[f]])) : entity)
        : null, // underlying row deleted since sharing — same "entity no longer exists" posture vault-shares.ts's own read endpoint takes
      fieldPermissions,
      sharedBy: s.shared_by,
      sharedByUsername: s.shared_by_username,
      createdAt: s.created_at,
    };
  }));
});

// DELETE — sharer, or an org owner/admin, can revoke.
router.delete("/organizations/:id/vault-shares/:shareId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orgId = parseInt(req.params.id as string, 10);
  const shareId = parseInt(req.params.shareId as string, 10);
  const membership = await getMembership(orgId, userId);
  if (!membership || membership.status !== "active") { res.status(404).json({ error: "Organization not found" }); return; }
  const shareRes = await db.execute(sql`SELECT shared_by FROM organization_vault_shares WHERE id = ${shareId} AND organization_id = ${orgId}`);
  const share = shareRes.rows[0] as any;
  if (!share) { res.status(404).json({ error: "Share not found" }); return; }
  if (share.shared_by !== userId && !canManage(membership)) { res.status(403).json({ error: "Not allowed" }); return; }
  await db.execute(sql`UPDATE organization_vault_shares SET is_active = FALSE, revoked_at = now() WHERE id = ${shareId}`);
  res.json({ ok: true });
});

export default router;
