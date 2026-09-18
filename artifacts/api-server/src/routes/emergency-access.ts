/**
 * routes/emergency-access.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 16 — Emergency Access / Dead-Man Switch. See
 * schema/emergency-access.ts for the full design note. Summary of the flow:
 *
 *   1. Owner nominates a contact (POST /emergency-access/contacts) with a
 *      wait-days threshold. An invite email with a confirm link is sent —
 *      the contact must confirm before the nomination is "active".
 *   2. lib/emergency-access-cron.ts runs daily. For every active, confirmed
 *      contact whose owner has been inactive (users.last_active_at) for at
 *      least wait_days, it creates one emergency_access_grants row
 *      (status "pending_admin_review") and emails the owner a last-chance
 *      warning.
 *   3. The owner can cancel their own grant at any time before an admin
 *      acts (POST /emergency-access/grants/:id/cancel) — proof of life.
 *   4. An admin reviews pending grants (GET /admin/emergency-access/grants)
 *      and approves or denies. Approval mints a bearer token (see
 *      lib/emergency-access-token.ts), emailed to the contact once, never
 *      stored in plaintext.
 *   5. The contact uses that token against GET /emergency-access/view/:token
 *      to see a read-only, decrypted export of the owner's active Vault
 *      entries. The token expires (default 30 days) and every use is
 *      logged (accessedAt + a vault_activity_log row per entity).
 */
import { Router, type Request, type Response } from "express";
import { db, emergencyContactsTable, emergencyAccessGrantsTable, usersTable, vaultEntriesTable, notificationsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireAuth, requireAdmin, getRequestUserId, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership, requirePublicAudit } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { sendEmail } from "../lib/email";
import { generateInviteToken, generateEmergencyAccessToken, hashEmergencyAccessToken } from "../lib/emergency-access-token";
import { decryptField } from "../lib/vault-crypto";
import { SENSITIVE_VAULT_FIELDS } from "./vault";
import { logActivity } from "../lib/activity";

const router = Router();

// ─── Route Integration Roadmap — Season C, Phase C8 (mechanical sweep, batch 8) ─
// The other file Phase C7 flagged as a remaining candidate. Two owner-scoped
// `:id` routes here fit the same combined-where shape as the rest of this
// series: `DELETE /emergency-access/contacts/:id` (owner = `userId`) and
// `POST /emergency-access/grants/:id/cancel` (owner = `ownerUserId`). Both
// keep their existing hand-rolled scoping and response bodies unchanged —
// this only adds a second, PDP-routed ownership check ahead of it.
//
// The grant-cancel route's existing query also filters on
// `status IN ('pending_admin_review')` in the SAME where clause as the
// ownership check — that business-state filter is untouched and still
// lives in the handler; the new PEP gate only judges ownership, exactly
// like Phase B1's finance routes left their own status/business filters
// alone.
//
// NOT touched:
//   - `POST /admin/emergency-access/grants/:id/approve` and `.../deny` —
//     these are `requireAdmin` routes (an admin reviewing another user's
//     grant, not the owner acting on their own), and `requireAdmin` has
//     already been routed through the PDP since Phase A2's RBAC-PEP shim.
//     No ownership check applies here — the whole point is a *different*
//     user acting on the resource. This is the "admin-review/approval
//     shape" Phase C7 flagged as possibly needing a Phase B3-style look;
//     on inspection it needs nothing further, it's already PDP-backed.
//   - `POST /emergency-access/confirm/:token` and
//     `GET /emergency-access/view/:token` — public, unauthenticated,
//     token-is-the-auth routes (no `requireAuth`, no `req.user`); out of
//     scope for an ownership gate the same way OIDC/public routes always
//     have been in this series.
//   - `GET /emergency-access/contacts`, `POST /emergency-access/contacts`,
//     `GET /emergency-access/grants` — list/create, self-scoped by
//     construction (`eq(...userId, userId)` baked into the query, no
//     client-supplied `:id` to check), same exclusion as every other
//     list/create route in this series.
const EMERGENCY_CONTACT_OWNER_SENTINEL_NONE = -1;
const EMERGENCY_ACCESS_GRANT_OWNER_SENTINEL_NONE = -1;

const emergencyContactResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "emergency_contact", id: req.params.id, ownerId: EMERGENCY_CONTACT_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: emergencyContactsTable.userId }).from(emergencyContactsTable)
    .where(eq(emergencyContactsTable.id, id)).limit(1);
  return { type: "emergency_contact", id, ownerId: row?.userId ?? EMERGENCY_CONTACT_OWNER_SENTINEL_NONE };
};

const emergencyAccessGrantResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "emergency_access_grant", id: req.params.id, ownerId: EMERGENCY_ACCESS_GRANT_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ ownerUserId: emergencyAccessGrantsTable.ownerUserId }).from(emergencyAccessGrantsTable)
    .where(eq(emergencyAccessGrantsTable.id, id)).limit(1);
  return { type: "emergency_access_grant", id, ownerId: row?.ownerUserId ?? EMERGENCY_ACCESS_GRANT_OWNER_SENTINEL_NONE };
};

function requireEmergencyContactOwnership(action: string) {
  return requireOwnership(action, emergencyContactResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Contact not found" });
    },
  });
}

function requireEmergencyAccessGrantOwnership(action: string) {
  return requireOwnership(action, emergencyAccessGrantResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "No cancellable grant found" });
    },
  });
}

const MIN_WAIT_DAYS = 3;
const MAX_WAIT_DAYS = 365;
const ACCESS_TOKEN_TTL_DAYS = 30;

function simpleEmail(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0a0d12;color:#e0f7f7;padding:24px;">
  <h2 style="color:#00d4cc;">${title}</h2>
  ${bodyHtml}
  <p style="font-size:11px;color:#4a8080;margin-top:24px;">&copy; AYZEN &mdash; Emergency Access</p>
  </body></html>`;
}

// ─── Owner: manage contacts ─────────────────────────────────────────────────

router.get("/emergency-access/contacts", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select({
    id: emergencyContactsTable.id,
    contactName: emergencyContactsTable.contactName,
    contactEmail: emergencyContactsTable.contactEmail,
    waitDays: emergencyContactsTable.waitDays,
    status: emergencyContactsTable.status,
    confirmedAt: emergencyContactsTable.confirmedAt,
    createdAt: emergencyContactsTable.createdAt,
  }).from(emergencyContactsTable).where(eq(emergencyContactsTable.userId, userId));
  res.json({ items: rows });
});

router.post("/emergency-access/contacts", requireAuth, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { contactName, contactEmail, waitDays } = req.body ?? {};
  if (typeof contactName !== "string" || !contactName.trim()) { res.status(400).json({ error: "contactName is required" }); return; }
  if (typeof contactEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    res.status(400).json({ error: "A valid contactEmail is required" }); return;
  }
  const days = Number(waitDays) || 30;
  if (days < MIN_WAIT_DAYS || days > MAX_WAIT_DAYS) {
    res.status(400).json({ error: "Invalid waitDays", solution: `waitDays must be between ${MIN_WAIT_DAYS} and ${MAX_WAIT_DAYS}.` });
    return;
  }

  const inviteToken = generateInviteToken();
  const [row] = await db.insert(emergencyContactsTable).values({
    userId, contactName: contactName.trim().slice(0, 120), contactEmail: contactEmail.trim().toLowerCase(),
    waitDays: days, status: "active", inviteToken,
  }).returning();

  const [owner] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const confirmUrl = `${process.env.APP_URL ?? "https://ayzen.replit.app"}/emergency-access/confirm/${inviteToken}`;
  await sendEmail({
    to: row.contactEmail,
    subject: `${owner?.username ?? "An AYZEN user"} nominated you as an Emergency Access contact`,
    html: simpleEmail("Emergency Access Nomination", `
      <p>${owner?.username ?? "An AYZEN user"} has nominated you as a trusted Emergency Access contact.</p>
      <p>If they are inactive for ${days} days, you may be granted read-only access to their vault, subject to admin approval.</p>
      <p><a href="${confirmUrl}" style="color:#00d4cc;">Confirm this nomination</a></p>
      <p>If you don't recognize this, you can safely ignore this email.</p>`),
    text: `Confirm this Emergency Access nomination: ${confirmUrl}`,
  });

  await logActivity(userId, "emergency_contact_added", "emergency_contact", row.id, row.contactName, {});
  res.status(201).json({ id: row.id, contactName: row.contactName, contactEmail: row.contactEmail, waitDays: row.waitDays, status: row.status });
});

router.delete("/emergency-access/contacts/:id", requireAuth, requireEmergencyContactOwnership("emergency_contact.delete"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(String(req.params.id), 10);
  const result = await db.update(emergencyContactsTable)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(and(eq(emergencyContactsTable.id, id), eq(emergencyContactsTable.userId, userId)))
    .returning({ id: emergencyContactsTable.id, contactName: emergencyContactsTable.contactName });
  if (!result.length) { res.status(404).json({ error: "Contact not found" }); return; }
  await logActivity(userId, "emergency_contact_revoked", "emergency_contact", id, result[0].contactName, {});
  res.json({ ok: true });
});

// ─── Contact: confirm nomination (public — token is the auth) ──────────────
router.post("/emergency-access/confirm/:token", requirePublicAudit("emergency_access.confirm", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = String(req.params.token);
  const result = await db.update(emergencyContactsTable)
    .set({ inviteToken: null, confirmedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(emergencyContactsTable.inviteToken, token), eq(emergencyContactsTable.status, "active")))
    .returning({ id: emergencyContactsTable.id });
  if (!result.length) { res.status(404).json({ error: "Invalid or already-used invite link" }); return; }
  res.json({ ok: true });
});

// ─── Owner: view + cancel their own triggered grants (proof of life) ───────
router.get("/emergency-access/grants", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(emergencyAccessGrantsTable).where(eq(emergencyAccessGrantsTable.ownerUserId, userId));
  res.json({ items: rows.map(r => ({ ...r, accessTokenHash: undefined })) });
});

router.post("/emergency-access/grants/:id/cancel", requireAuth, sensitiveWriteLimiter, requireEmergencyAccessGrantOwnership("emergency_access_grant.cancel"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(String(req.params.id), 10);

  const result = await db.update(emergencyAccessGrantsTable)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(and(
      eq(emergencyAccessGrantsTable.id, id),
      eq(emergencyAccessGrantsTable.ownerUserId, userId),
      sql`${emergencyAccessGrantsTable.status} IN ('pending_admin_review')`,
    ))
    .returning({ id: emergencyAccessGrantsTable.id });
  if (!result.length) { res.status(404).json({ error: "No cancellable grant found" }); return; }

  await db.update(usersTable).set({ lastActiveAt: new Date() }).where(eq(usersTable.id, userId));
  await logActivity(userId, "emergency_access_cancelled", "emergency_access_grant", id, null, {});
  res.json({ ok: true });
});

// ─── Admin: review triggered grants ─────────────────────────────────────────
router.get("/admin/emergency-access/grants", requireAdmin, async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : "pending_admin_review";
  const rows = await db.execute(sql`
    SELECT g.*, c.contact_name, c.contact_email, u.username AS owner_username, u.email AS owner_email
    FROM emergency_access_grants g
    JOIN emergency_contacts c ON c.id = g.contact_id
    JOIN users u ON u.id = g.owner_user_id
    WHERE g.status = ${status}
    ORDER BY g.triggered_at DESC
  `);
  res.json({ items: (rows.rows as any[]).map(r => ({ ...r, access_token_hash: undefined })) });
});

router.post("/admin/emergency-access/grants/:id/approve", requireAdmin, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const adminId = getRequestUserId(req);
  const id = parseInt(String(req.params.id), 10);

  const [grant] = await db.select().from(emergencyAccessGrantsTable)
    .where(and(eq(emergencyAccessGrantsTable.id, id), eq(emergencyAccessGrantsTable.status, "pending_admin_review")));
  if (!grant) { res.status(404).json({ error: "No pending grant found" }); return; }

  const [contact] = await db.select().from(emergencyContactsTable).where(eq(emergencyContactsTable.id, grant.contactId));
  if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

  const { plaintext, hash } = generateEmergencyAccessToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.update(emergencyAccessGrantsTable).set({
    status: "approved",
    adminReviewedBy: adminId,
    adminReviewedAt: new Date(),
    adminNote: typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null,
    accessTokenHash: hash,
    accessTokenExpiresAt: expiresAt,
  }).where(eq(emergencyAccessGrantsTable.id, id));

  const viewUrl = `${process.env.APP_URL ?? "https://ayzen.replit.app"}/emergency-access/view/${plaintext}`;
  await sendEmail({
    to: contact.contactEmail,
    subject: "Your AYZEN Emergency Access request has been approved",
    html: simpleEmail("Emergency Access Approved", `
      <p>Your emergency access request has been reviewed and approved.</p>
      <p><a href="${viewUrl}" style="color:#00d4cc;">View the vault</a> (link expires in ${ACCESS_TOKEN_TTL_DAYS} days, single link — do not share it).</p>`),
    text: `Emergency access approved. View here (expires in ${ACCESS_TOKEN_TTL_DAYS} days): ${viewUrl}`,
  });

  await db.insert(notificationsTable).values({
    userId: grant.ownerUserId, type: "security",
    title: "Emergency access approved",
    message: `An admin approved emergency vault access for ${contact.contactName}.`,
  });

  res.json({ ok: true });
});

router.post("/admin/emergency-access/grants/:id/deny", requireAdmin, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const adminId = getRequestUserId(req);
  const id = parseInt(String(req.params.id), 10);
  const result = await db.update(emergencyAccessGrantsTable).set({
    status: "denied", adminReviewedBy: adminId, adminReviewedAt: new Date(),
    adminNote: typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null,
  }).where(and(eq(emergencyAccessGrantsTable.id, id), eq(emergencyAccessGrantsTable.status, "pending_admin_review")))
    .returning({ id: emergencyAccessGrantsTable.id, ownerUserId: emergencyAccessGrantsTable.ownerUserId });
  if (!result.length) { res.status(404).json({ error: "No pending grant found" }); return; }

  await db.insert(notificationsTable).values({
    userId: result[0].ownerUserId, type: "security",
    title: "Emergency access request denied",
    message: "An admin denied a triggered emergency access request on your vault.",
  });
  res.json({ ok: true });
});

// ─── Contact: use the approved token (public — token is the auth) ─────────
router.get("/emergency-access/view/:token", requirePublicAudit("emergency_access.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = String(req.params.token);
  if (!token.startsWith("ayzn_emrg_")) { res.status(404).json({ error: "Invalid link" }); return; }
  const hash = hashEmergencyAccessToken(token);

  const [grant] = await db.select().from(emergencyAccessGrantsTable)
    .where(and(eq(emergencyAccessGrantsTable.accessTokenHash, hash), eq(emergencyAccessGrantsTable.status, "approved")));
  if (!grant) { res.status(404).json({ error: "Invalid or revoked link" }); return; }
  if (!grant.accessTokenExpiresAt || grant.accessTokenExpiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: "This link has expired" }); return;
  }

  const rows = await db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.userId, grant.ownerUserId), sql`${vaultEntriesTable.deletedAt} IS NULL`));

  const decrypted = rows.map(r => {
    const out: Record<string, unknown> = { ...r };
    for (const f of SENSITIVE_VAULT_FIELDS) out[f] = decryptField(out[f] as any);
    return out;
  });

  await db.update(emergencyAccessGrantsTable).set({ accessedAt: new Date() }).where(eq(emergencyAccessGrantsTable.id, grant.id));
  await logActivity(grant.ownerUserId, "emergency_access_viewed", "emergency_access_grant", grant.id, null, {});

  res.json({ entries: decrypted, viewedAt: new Date().toISOString(), expiresAt: grant.accessTokenExpiresAt });
});

export default router;
