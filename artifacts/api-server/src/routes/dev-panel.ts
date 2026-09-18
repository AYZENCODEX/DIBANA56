import { Router } from "express";
import { db, creditsTable, creditTransactionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRoles } from "../middlewares/auth";
import { broadcastEvent } from "./events";

const router = Router();
const requireDevOrAdmin = requireRoles("admin", "dev");

async function getOrCreateCredits(userId: number) {
  const [row] = await db.select().from(creditsTable).where(eq(creditsTable.userId, userId));
  if (row) return row;
  const [created] = await db.insert(creditsTable).values({ userId }).returning();
  return created;
}

// ── GET /dev/system-info — quick environment/runtime snapshot ─────────────────
router.get("/dev/system-info", requireDevOrAdmin, async (_req, res): Promise<void> => {
  res.json({
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    env: process.env.NODE_ENV ?? "development",
    timestamp: new Date().toISOString(),
  });
});

// ── POST /dev/azn/deploy — deploy (mint/grant) AZN directly to a user's wallet ─
router.post("/dev/azn/deploy", requireDevOrAdmin, async (req, res): Promise<void> => {
  const { userId, amount, note } = req.body as { userId?: number; amount?: number; note?: string };
  if (!userId || !amount || amount <= 0) {
    res.status(400).json({ error: "userId and a positive amount are required" }); return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const creditRow = await getOrCreateCredits(userId);
  await db.update(creditsTable).set({
    aznBalance: creditRow.aznBalance + amount,
    updatedAt: new Date(),
  }).where(eq(creditsTable.userId, userId));

  await db.insert(creditTransactionsTable).values({
    userId,
    type: "dev_deploy",
    method: "system",
    credits: 0,
    aznAmount: amount,
    status: "approved",
    notes: note?.trim() || `AZN deployed by developer tools (${amount} AZN)`,
    approvedAt: new Date(),
  });

  broadcastEvent("credits_updated", { userId });
  res.json({ success: true, userId, amount, newAznBalance: creditRow.aznBalance + amount });
});

export default router;
