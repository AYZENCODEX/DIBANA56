import { Router } from "express";
import { db, supportTicketsTable, supportMessagesTable, usersTable } from "@workspace/db";
import { eq, desc, and, count } from "drizzle-orm";
import { requireAuth, requireAdmin, getRequestUser, pepDecisionObserver } from "../middlewares/auth";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule, createRoleOverrideRule } from "../lib/policy/resource";
import { authorize } from "../lib/policy/pep";

const router = Router();

// ── Route Integration Roadmap — Season C, Phase C1 (mechanical sweep) ──────
// "Get ticket + messages" and "Reply to ticket" below both hand-rolled the
// exact same "owner, OR an admin, may act" check. This one engine —
// ownership (../lib/policy/resource/ownership-rule.ts) OR an elevated role
// (../lib/policy/resource/role-override-rule.ts, this phase's own new rule
// — see its header for why `requireRole()`'s own DENY-on-mismatch rule
// can't be reused here) — is shared by both routes below via `authorize()`,
// module-load-time construction (cheap, stateless — same posture
// `adminRoleCheck`/`devRoleCheck` in `middlewares/auth.ts` already apply),
// wired to the same `pepDecisionObserver` (Phase A3) every other PEP call
// site in this app already reuses.
const ticketOwnerOrAdminEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
ticketOwnerOrAdminEngine.registerRule("resource-ownership", createResourceOwnershipRule());
ticketOwnerOrAdminEngine.registerRule("role-override", createRoleOverrideRule(["admin"]));

function fmtTicket(t: typeof supportTicketsTable.$inferSelect) {
  return { ...t, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString() };
}
function fmtMsg(m: typeof supportMessagesTable.$inferSelect) {
  return { ...m, createdAt: m.createdAt.toISOString() };
}

// ── User: list own tickets ─────────────────────────────────────────────────
router.get("/support/tickets", requireAuth, async (req, res): Promise<void> => {
  const { userId, role } = getRequestUser(req)!;
  const tickets = role === "admin"
    ? await db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.updatedAt))
    : await db.select().from(supportTicketsTable).where(eq(supportTicketsTable.userId, userId)).orderBy(desc(supportTicketsTable.updatedAt));

  // Attach username for admin view
  const enriched = await Promise.all(tickets.map(async (t) => {
    const [u] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, t.userId));
    const [{ cnt }] = await db.select({ cnt: count() }).from(supportMessagesTable).where(eq(supportMessagesTable.ticketId, t.id));
    return { ...fmtTicket(t), username: u?.username ?? "Unknown", messageCount: Number(cnt) };
  }));
  res.json(enriched);
});

// ── User: create ticket ────────────────────────────────────────────────────
router.post("/support/tickets", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const { title, category, priority, message } = req.body;
  if (!title || !message) { res.status(400).json({ error: "title and message required" }); return; }

  const [ticket] = await db.insert(supportTicketsTable).values({
    userId, title, category: category ?? "general", status: "open", priority: priority ?? "medium",
  }).returning();

  await db.insert(supportMessagesTable).values({
    ticketId: ticket.id, authorId: userId, authorRole: "user", content: message,
  });

  res.status(201).json(fmtTicket(ticket));
});

// ── Get ticket + messages ─────────────────────────────────────────────────
router.get("/support/tickets/:id", requireAuth, async (req, res): Promise<void> => {
  const { userId, role } = getRequestUser(req)!;
  const id = parseInt(req.params.id as string, 10);

  const [ticket] = await db.select().from(supportTicketsTable).where(eq(supportTicketsTable.id, id));
  if (!ticket) { res.status(404).json({ error: "Not found" }); return; }
  // Phase C1: same "owner OR admin" question as before, now decided by the
  // PDP (real Decision, requestId, audit row) instead of the hand-rolled
  // boolean — same response shape (403 "Forbidden") on a non-ALLOW.
  const readOutcome = await authorize({
    req,
    engine: ticketOwnerOrAdminEngine,
    action: "support.ticket.read",
    resource: { type: "support.ticket", id: String(ticket.id), ownerId: ticket.userId },
  });
  if (readOutcome.decision.effect !== "ALLOW") { res.status(403).json({ error: "Forbidden" }); return; }

  const messages = await db.select().from(supportMessagesTable)
    .where(eq(supportMessagesTable.ticketId, id)).orderBy(supportMessagesTable.createdAt);

  const messagesWithAuthors = await Promise.all(messages.map(async (m) => {
    const [u] = await db.select({ username: usersTable.username, avatarUrl: usersTable.avatarUrl })
      .from(usersTable).where(eq(usersTable.id, m.authorId));
    return { ...fmtMsg(m), username: u?.username ?? "System", avatarUrl: u?.avatarUrl ?? null };
  }));

  const [u] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, ticket.userId));
  res.json({ ...fmtTicket(ticket), username: u?.username ?? "Unknown", messages: messagesWithAuthors });
});

// ── Reply to ticket ────────────────────────────────────────────────────────
router.post("/support/tickets/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const { userId, role } = getRequestUser(req)!;
  const ticketId = parseInt(req.params.id as string, 10);
  const { content } = req.body;
  if (!content?.trim()) { res.status(400).json({ error: "content required" }); return; }

  const [ticket] = await db.select().from(supportTicketsTable).where(eq(supportTicketsTable.id, ticketId));
  if (!ticket) { res.status(404).json({ error: "Ticket not found" }); return; }
  // Phase C1 — see the "Get ticket + messages" route above for the full
  // rationale; same engine, same shape, different action name for audit.
  const replyOutcome = await authorize({
    req,
    engine: ticketOwnerOrAdminEngine,
    action: "support.ticket.reply",
    resource: { type: "support.ticket", id: String(ticket.id), ownerId: ticket.userId },
  });
  if (replyOutcome.decision.effect !== "ALLOW") { res.status(403).json({ error: "Forbidden" }); return; }

  const [msg] = await db.insert(supportMessagesTable).values({
    ticketId, authorId: userId, authorRole: role, content: content.trim(),
  }).returning();

  // Update ticket status
  const newStatus = role === "admin" ? "in_progress" : ticket.status;
  await db.update(supportTicketsTable).set({ status: newStatus, updatedAt: new Date() }).where(eq(supportTicketsTable.id, ticketId));

  const [u] = await db.select({ username: usersTable.username, avatarUrl: usersTable.avatarUrl }).from(usersTable).where(eq(usersTable.id, userId));
  res.status(201).json({ ...fmtMsg(msg), username: u?.username ?? "System", avatarUrl: u?.avatarUrl ?? null });
});

// ── Admin: update ticket status ───────────────────────────────────────────
router.patch("/support/tickets/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const { status, priority } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (status) updates.status = status;
  if (priority) updates.priority = priority;
  const [t] = await db.update(supportTicketsTable).set(updates).where(eq(supportTicketsTable.id, id)).returning();
  res.json(fmtTicket(t));
});

// ── Admin: stats ──────────────────────────────────────────────────────────
router.get("/support/stats", requireAdmin, async (_req, res): Promise<void> => {
  const [{ total }] = await db.select({ total: count() }).from(supportTicketsTable);
  const open = await db.select({ cnt: count() }).from(supportTicketsTable).where(eq(supportTicketsTable.status, "open"));
  const inprog = await db.select({ cnt: count() }).from(supportTicketsTable).where(eq(supportTicketsTable.status, "in_progress"));
  const resolved = await db.select({ cnt: count() }).from(supportTicketsTable).where(eq(supportTicketsTable.status, "resolved"));
  res.json({ total: Number(total), open: Number(open[0].cnt), inProgress: Number(inprog[0].cnt), resolved: Number(resolved[0].cnt) });
});

export default router;
