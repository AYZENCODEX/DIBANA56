import { Router } from "express";
import { db, broadcastsTable, usersTable } from "@workspace/db";
import { count } from "drizzle-orm";
import { broadcastToAll } from "../lib/telegram";
import { broadcastEvent } from "./events";
import { requireAdmin } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";

const router = Router();

function formatBroadcast(b: typeof broadcastsTable.$inferSelect) {
  return { ...b, createdAt: b.createdAt.toISOString(), scheduledAt: b.scheduledAt?.toISOString() ?? null };
}

router.get("/broadcast", async (_req, res): Promise<void> => {
  const broadcasts = await db.select().from(broadcastsTable);
  res.json(broadcasts.map(formatBroadcast));
});

// SECURITY FIX: this endpoint messages every user on the platform (email /
// Telegram / in-app) and previously had NO auth check at all — anyone who
// could reach the API could spam or phish the entire user base. Now
// admin-only, plus rate-limited like the other sensitive write endpoints.
router.post("/broadcast", requireAdmin, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const { title, message, channel, recipientFilter, scheduledAt } = req.body;
  if (!title || !message || !channel) { res.status(400).json({ error: "title, message, and channel are required" }); return; }
  const [{ total }] = await db.select({ total: count() }).from(usersTable);
  const [broadcast] = await db.insert(broadcastsTable).values({
    title, message, channel: channel ?? "email",
    recipientFilter: recipientFilter ?? "all",
    recipientCount: Number(total),
    status: scheduledAt ? "scheduled" : "sent",
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
  }).returning();
  // Push to Telegram if channel includes telegram
  if (channel === "telegram" || channel === "all") {
    const tgText = `📣 *${title}*\n\n${message}`;
    broadcastToAll(tgText).catch(() => {});
  }
  // Push in-app SSE notification to all connected clients
  if (channel === "inapp" || channel === "all") {
    broadcastEvent("broadcast", { title, message, channel });
  }

  res.status(201).json(formatBroadcast(broadcast));
});

router.get("/broadcast/inbox", async (_req, res): Promise<void> => {
  const broadcasts = await db.select().from(broadcastsTable);
  res.json(broadcasts.map(formatBroadcast));
});

export default router;
