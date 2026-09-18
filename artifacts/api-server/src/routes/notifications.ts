import { Router, type Request, type Response } from "express";
import { db, notificationsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { broadcastToUser } from "./events";
import { requireAuth, requireAdmin, getRequestUser, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();

// ─── Route Integration Roadmap — Season C, Phase C6 (mechanical sweep, batch 6) ─
// Same combined-where ownership shape Phase C5 flagged for a future manual
// audit (`and(eq(table.id, id), eq(table.userId, userId))`, not the
// `!== userId` shape earlier C-phases grepped for). Both routes below
// already no-op (200 `{ success: true }`, no row affected) for a
// nonexistent/not-yours notification id — neither ever returned a 404, so
// `onDeny` here reproduces that exact same response rather than inventing a
// new one, same "byte-for-byte response parity" posture Phase B1 applied
// to Finance. The additive value is the SAME everywhere else in Season
// B/C: this ownership check now produces a real, audited
// `AuthorizationDecision` instead of being invisible to the PDP.
const NOTIFICATION_OWNER_SENTINEL_NONE = -1;

const notificationResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) return { type: "notification", id: req.params.id, ownerId: NOTIFICATION_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: notificationsTable.userId }).from(notificationsTable)
    .where(eq(notificationsTable.id, id)).limit(1);
  return { type: "notification", id, ownerId: row?.userId ?? NOTIFICATION_OWNER_SENTINEL_NONE };
};

function requireNotificationOwnership(action: string) {
  return requireOwnership(action, notificationResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.json({ success: true });
    },
  });
}

// GET /api/notifications/unread-count — before /:id
router.get("/notifications/unread-count", async (req, res): Promise<void> => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!token) { res.json({ count: 0 }); return; }
  const { getUserFromToken } = await import("../lib/auth-utils");
  const authUser = await getUserFromToken(token);
  if (!authUser) { res.json({ count: 0 }); return; }
  try {
    const result = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(notificationsTable)
      .where(and(eq(notificationsTable.userId, authUser.userId), eq(notificationsTable.isRead, false)));
    res.json({ count: Number(result[0]?.count ?? 0) });
  } catch { res.json({ count: 0 }); }
});

// GET /api/notifications
router.get("/notifications", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.userId, authUser.userId))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(50);
    res.json(rows);
  } catch { res.json([]); }
});

// PATCH /api/notifications/read-all — before /:id
router.patch("/notifications/read-all", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  await db.update(notificationsTable)
    .set({ isRead: true })
    .where(eq(notificationsTable.userId, authUser.userId));
  res.json({ success: true });
});

// PATCH /api/notifications/:id/read
router.patch("/notifications/:id/read", requireAuth, requireNotificationOwnership("notification.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.update(notificationsTable)
    .set({ isRead: true })
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, authUser.userId)));
  res.json({ success: true });
});

// DELETE /api/notifications/:id
router.delete("/notifications/:id", requireAuth, requireNotificationOwnership("notification.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.delete(notificationsTable)
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, authUser.userId)));
  res.json({ success: true });
});

// Admin: POST /api/notifications
router.post("/notifications", requireAdmin, async (req, res): Promise<void> => {
  const { userId, type, title, message, data } = req.body;
  if (!userId || !title) { res.status(400).json({ error: "userId and title required" }); return; }
  const [notif] = await db.insert(notificationsTable).values({
    userId: Number(userId), type: type ?? "system", title, message: message ?? "",
    isRead: false, data: data ? JSON.stringify(data) : undefined,
  }).returning();
  broadcastToUser(Number(userId), "notification", { id: notif.id, type, title, message });
  res.status(201).json(notif);
});

export async function createNotification(
  userId: number, type: string, title: string, message: string, data?: Record<string, unknown>
) {
  try {
    const [notif] = await db.insert(notificationsTable).values({
      userId, type, title, message, isRead: false,
      data: data ? JSON.stringify(data) : undefined,
    }).returning();
    broadcastToUser(userId, "notification", { id: notif.id, type, title, message });
  } catch {}
}

export default router;
