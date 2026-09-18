import { Router } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.post("/payments/coingate/webhook", async (req, res): Promise<void> => {
  const { order_id, status } = req.body;
  if (!order_id) {
    res.status(400).json({ error: "Missing order_id" });
    return;
  }
  if (status === "paid" || status === "confirming") {
    try {
      await db.update(subscriptionsTable)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(subscriptionsTable.coingateOrderId, String(order_id)));
    } catch (err) {
      console.error("Webhook DB update error:", err);
    }
  }
  res.json({ received: true });
});

export default router;
