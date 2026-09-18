import { Router } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { broadcastToUser } from "./events";
import { syncSubscriptionExpiry } from "../services/sync";
import { creditAdminWalletIfNew } from "../services/admin-wallet";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";

const router = Router();

export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    price: 0,
    currency: "USD",
    vaultLimit: 3,
    otherAccountsAllowed: false,
    mainAccountOnly: false,
    description: "Get started with limited vault",
    features: ["3 vault entities", "Basic wallet tracking", "AYZEN email", "Community access"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: 3,
    currency: "USD",
    vaultLimit: -1,
    otherAccountsAllowed: false,
    mainAccountOnly: true,
    description: "For serious airdrop hunters",
    features: ["Unlimited vault entities", "Main account setup only", "All wallets", "Priority support", "AI assistant"],
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    price: 6,
    currency: "USD",
    vaultLimit: -1,
    otherAccountsAllowed: true,
    mainAccountOnly: false,
    description: "Full platform access",
    features: ["Unlimited vault entities", "All account types", "Other accounts unlocked", "Dedicated support", "API access", "AZN token rewards"],
  },
};

router.get("/plans", async (_req, res): Promise<void> => {
  res.json(Object.values(PLANS));
});

router.get("/subscription", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  try {
    await syncSubscriptionExpiry(userId);
    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    if (!sub) {
      res.json({ plan: "free", status: "active", ...PLANS.free });
      return;
    }
    const planInfo = PLANS[sub.plan as keyof typeof PLANS] ?? PLANS.free;
    res.json({ ...sub, ...planInfo });
  } catch {
    res.json({ plan: "free", status: "active", ...PLANS.free });
  }
});

router.post("/subscription/upgrade", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  const { plan } = req.body;
  if (!plan || !PLANS[plan as keyof typeof PLANS]) {
    res.status(400).json({ error: "Invalid plan" });
    return;
  }
  if (plan === "free") {
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    res.json({ plan: "free", status: "active" });
    return;
  }
  const planInfo = PLANS[plan as keyof typeof PLANS];
  const coingateKey = process.env.COINGATE_API_KEY;
  if (!coingateKey) {
    res.status(503).json({ error: "Payment gateway not configured. Contact admin." });
    return;
  }
  try {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "https://ayzen.replit.app";
    const resp = await fetch("https://api.coingate.com/v2/orders", {
      method: "POST",
      headers: {
        Authorization: `Token ${coingateKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        order_id: `ayzen_sub_${userId}_${Date.now()}`,
        price_amount: planInfo.price,
        price_currency: "USD",
        receive_currency: "USDT",
        title: `AYZEN ${planInfo.name} Plan`,
        description: `AYZEN ${planInfo.name} monthly subscription`,
        callback_url: `${baseUrl}/api/payments/coingate/webhook`,
        success_url: `${baseUrl}/?payment=success`,
        cancel_url: `${baseUrl}/?payment=cancelled`,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      res.status(500).json({ error: "Payment creation failed", detail: err });
      return;
    }
    const order = await resp.json() as any;
    const expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const existing = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    if (existing.length > 0) {
      await db.update(subscriptionsTable).set({
        plan, status: "pending",
        coingateOrderId: String(order.id),
        coingatePaymentUrl: order.payment_url,
        expiresAt, updatedAt: new Date(),
      }).where(eq(subscriptionsTable.userId, userId));
    } else {
      await db.insert(subscriptionsTable).values({
        userId, plan, status: "pending",
        coingateOrderId: String(order.id),
        coingatePaymentUrl: order.payment_url,
        expiresAt,
      });
    }
    res.json({ paymentUrl: order.payment_url, orderId: order.id, plan });
  } catch (err: any) {
    res.status(500).json({ error: "Payment gateway error", detail: err?.message });
  }
});

router.post("/subscription/check", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  const { orderId } = req.body;
  const coingateKey = process.env.COINGATE_API_KEY;
  if (!coingateKey || !orderId) {
    res.status(400).json({ error: "Missing params" });
    return;
  }
  try {
    const resp = await fetch(`https://api.coingate.com/v2/orders/${orderId}`, {
      headers: { Authorization: `Token ${coingateKey}` },
    });
    const order = await resp.json() as any;
    if (order.status === "paid" || order.status === "confirming") {
      const [existingSub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
      await db.update(subscriptionsTable).set({ status: "active", updatedAt: new Date() })
        .where(eq(subscriptionsTable.userId, userId));
      if (existingSub && order.status === "paid") {
        const planInfo = PLANS[existingSub.plan as keyof typeof PLANS];
        if (planInfo && planInfo.price > 0) {
          // Idempotency: this refId is unique per CoinGate order, so re-polling
          // "paid" for an order already credited is a no-op rather than double revenue.
          await creditAdminWalletIfNew(
            `sub_coingate_${orderId}`,
            planInfo.price,
            planInfo.currency,
            userId,
            `${planInfo.name} plan — CoinGate`
          );
        }
      }
      res.json({ paid: true, status: "active" });
    } else {
      res.json({ paid: false, status: order.status });
    }
  } catch {
    res.status(500).json({ error: "Check failed" });
  }
});

// ─── POST /api/subscription/manual-upgrade — pay via BKash/Nagad/USDT ────────
router.post("/subscription/manual-upgrade", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  const { plan, method, referenceId, senderNumber } = req.body as {
    plan?: string; method?: string; referenceId?: string; senderNumber?: string;
  };
  if (!plan || !PLANS[plan as keyof typeof PLANS] || plan === "free") {
    res.status(400).json({ error: "Invalid plan" }); return;
  }
  if (!method || !["bkash", "nagad", "binance_usdt"].includes(method)) {
    res.status(400).json({ error: "Invalid payment method" }); return;
  }
  if (!referenceId?.trim()) {
    res.status(400).json({ error: "Transaction ID / TX hash required" }); return;
  }

  const planInfo = PLANS[plan as keyof typeof PLANS];
  const expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
  const safeRef = referenceId.trim().replace(/'/g, "''");
  const safeMethod = method.replace(/'/g, "''");
  const safeSender = (senderNumber ?? "").replace(/'/g, "''");

  try {
    await db.execute(sql.raw(
      `INSERT INTO subscriptions (user_id, plan, status, coingate_order_id, expires_at, payment_method, sender_number)
       VALUES (${userId}, '${plan}', 'pending', 'manual_${safeRef}', '${expiresAt.toISOString()}', '${safeMethod}', '${safeSender}')
       ON CONFLICT (user_id) DO UPDATE SET
         plan = EXCLUDED.plan, status = 'pending',
         coingate_order_id = EXCLUDED.coingate_order_id,
         coingate_payment_url = NULL,
         expires_at = EXCLUDED.expires_at,
         payment_method = EXCLUDED.payment_method,
         sender_number = EXCLUDED.sender_number,
         rejection_reason = NULL,
         updated_at = NOW()`
    ));
  } catch (err: any) {
    res.status(500).json({ error: "Database error. Please try again.", detail: err?.message });
    return;
  }

  // Notify user via SSE
  broadcastToUser(userId, "subscription_updated", { plan, status: "pending" });

  res.status(201).json({
    success: true, plan, planName: planInfo.name, price: planInfo.price,
    message: `Payment submitted for ${planInfo.name} plan. Admin will activate within 1-2 hours.`,
  });
});

// ─── ADMIN: GET /api/admin/subscriptions ─────────────────────────────────────
router.get("/admin/subscriptions", requireAdmin, async (req, res): Promise<void> => {

  const rows = await db.execute(sql.raw(
    `SELECT s.*, u.username, u.email
     FROM subscriptions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.status IN ('pending', 'active', 'rejected')
     ORDER BY s.updated_at DESC`
  ));
  res.json(rows.rows);
});

// ─── ADMIN: POST /api/admin/subscriptions/:userId/approve ────────────────────
router.post("/admin/subscriptions/:userId/approve", requireAdmin, async (req, res): Promise<void> => {

  const targetUserId = parseInt(Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId, 10);
  const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, targetUserId));
  await db.update(subscriptionsTable).set({ status: "active", updatedAt: new Date() })
    .where(eq(subscriptionsTable.userId, targetUserId));

  if (sub) {
    const planInfo = PLANS[sub.plan as keyof typeof PLANS];
    if (planInfo && planInfo.price > 0) {
      const refId = sub.coingateOrderId ? `sub_manual_${sub.coingateOrderId}` : `sub_manual_${targetUserId}_${sub.id}`;
      await creditAdminWalletIfNew(refId, planInfo.price, planInfo.currency, targetUserId, `${planInfo.name} plan — manual approval`);
    }
  }

  // Email + real-time notification
  const [user] = await db.select({ email: usersTable.email, username: usersTable.username })
    .from(usersTable).where(eq(usersTable.id, targetUserId));
  if (user && sub) {
    const planInfo = PLANS[sub.plan as keyof typeof PLANS] ?? { name: sub.plan };
    const { sendSubscriptionApprovedEmail } = await import("../lib/email");
    sendSubscriptionApprovedEmail(user.email, user.username, planInfo.name).catch(() => {});
  }
  broadcastToUser(targetUserId, "subscription_updated", { status: "active", plan: sub?.plan });
  res.json({ success: true });
});

// ─── ADMIN: POST /api/admin/subscriptions/:userId/reject ─────────────────────
router.post("/admin/subscriptions/:userId/reject", requireAdmin, async (req, res): Promise<void> => {

  const targetUserId = parseInt(Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId, 10);
  const { reason } = req.body as { reason?: string };
  const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, targetUserId));

  await db.execute(sql.raw(
    `UPDATE subscriptions SET status = 'rejected', rejection_reason = ${reason ? `'${reason.replace(/'/g, "''")}'` : "NULL"}, updated_at = NOW()
     WHERE user_id = ${targetUserId}`
  ));

  // Email + real-time notification
  const [user] = await db.select({ email: usersTable.email, username: usersTable.username })
    .from(usersTable).where(eq(usersTable.id, targetUserId));
  if (user && sub) {
    const planInfo = PLANS[sub.plan as keyof typeof PLANS] ?? { name: sub.plan };
    const { sendSubscriptionRejectedEmail } = await import("../lib/email");
    sendSubscriptionRejectedEmail(user.email, user.username, planInfo.name, reason).catch(() => {});
  }
  broadcastToUser(targetUserId, "subscription_updated", { status: "rejected", reason });
  res.json({ success: true });
});

export default router;
