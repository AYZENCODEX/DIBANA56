import { Router } from "express";
import { db, creditsTable, creditTransactionsTable, subscriptionsTable, settingsTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
import { broadcastEvent } from "./events";
import { mintNftForUser } from "./nft-subscriptions";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";
import { getEffectiveActions } from "../services/credit-meter";

const router = Router();

// Credit packages
export const CREDIT_PACKAGES = [
  { id: "starter",    label: "Starter",    credits: 1_000,  priceBDT: 100,   priceUSDT: 1,    bonus: 0  },
  { id: "basic",      label: "Basic",      credits: 5_500,  priceBDT: 450,   priceUSDT: 4.5,  bonus: 10 },
  { id: "pro",        label: "Pro Pack",   credits: 18_000, priceBDT: 1_200, priceUSDT: 12,   bonus: 20 },
  { id: "mega",       label: "Mega",       credits: 65_000, priceBDT: 3_500, priceUSDT: 35,   bonus: 30 },
];

// AZN rates
const CREDITS_PER_AZN = 100;
const AZN_FOR_PRO = 200;
const AZN_FOR_ENTERPRISE = 1000;

// AZN token market price
const AZN_PRICE_USD = 0.01;
const USD_TO_BDT = 130;

// Admin payment config — DB (admin settings panel) takes priority, env vars are
// a fallback for first boot before the admin has configured anything.
async function getAdminPaymentInfo() {
  const [s] = await db.select().from(settingsTable).limit(1);
  return {
    bkash: s?.bkashNumber || process.env["BKASH_NUMBER"] || "01XXXXXXXXX",
    nagad: s?.nagadNumber || process.env["NAGAD_NUMBER"] || "01XXXXXXXXX",
    usdt: s?.usdtAddress || process.env["USDT_ADDRESS"] || "TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    usdtNetwork: s?.usdtNetwork || process.env["USDT_NETWORK"] || "TRC20",
  };
}

// ─── Helper: get or create credit row ─────────────────────────────────────────
async function getOrCreateCredits(userId: number) {
  const [row] = await db.select().from(creditsTable).where(eq(creditsTable.userId, userId));
  if (row) return row;
  const [created] = await db.insert(creditsTable).values({ userId }).returning();
  return created;
}

// ─── GET /api/credits — my balance ────────────────────────────────────────────
router.get("/credits", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const credits = await getOrCreateCredits(authUser.userId);
  const txs = await db.select().from(creditTransactionsTable)
    .where(eq(creditTransactionsTable.userId, authUser.userId))
    .orderBy(desc(creditTransactionsTable.createdAt))
    .limit(50);
  const paymentInfo = await getAdminPaymentInfo();
  // PHASE 5: surface the metered-action price list here so the Workspace
  // hub / Astra toolbar (which already read this endpoint for the balance)
  // can show "costs N credits" next to a metered action before the user
  // triggers it, without a second round trip. getEffectiveActions() folds
  // in any admin-console price override (credit_action_pricing) so this
  // always matches what chargeCredits() will actually deduct.
  const meteredActions = await getEffectiveActions();
  res.json({ credits, transactions: txs, packages: CREDIT_PACKAGES, rates: { creditsPerAzn: CREDITS_PER_AZN, aznForPro: AZN_FOR_PRO, aznForEnterprise: AZN_FOR_ENTERPRISE, aznPriceUSD: AZN_PRICE_USD, usdToBDT: USD_TO_BDT, aznPriceBDT: +(AZN_PRICE_USD * USD_TO_BDT).toFixed(4) }, paymentInfo, meteredActions });
});

// ─── POST /api/credits/purchase — submit payment proof ────────────────────────
router.post("/credits/purchase", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { packageId, method, referenceId, senderNumber } = req.body as {
    packageId?: string; method?: string; referenceId?: string; senderNumber?: string;
  };

  const pkg = CREDIT_PACKAGES.find(p => p.id === packageId);
  if (!pkg) { res.status(400).json({ error: "Invalid package" }); return; }
  if (!method || !["bkash", "nagad", "binance_usdt"].includes(method)) {
    res.status(400).json({ error: "Invalid payment method" }); return;
  }
  if (!referenceId?.trim()) { res.status(400).json({ error: "Transaction ID / TX hash required" }); return; }

  // Check for duplicate reference
  const dup = await db.select({ id: creditTransactionsTable.id })
    .from(creditTransactionsTable)
    .where(and(
      eq(creditTransactionsTable.referenceId, referenceId.trim()),
      eq(creditTransactionsTable.method, method),
    ));
  if (dup.length > 0) { res.status(409).json({ error: "This transaction ID has already been submitted" }); return; }

  const [tx] = await db.insert(creditTransactionsTable).values({
    userId: authUser.userId,
    type: "purchase",
    method,
    credits: pkg.credits,
    amountBDT: method !== "binance_usdt" ? pkg.priceBDT : null,
    amountUSDT: method === "binance_usdt" ? pkg.priceUSDT : null,
    referenceId: referenceId.trim(),
    notes: senderNumber ? `Sender: ${senderNumber}` : `${pkg.label} package`,
    status: "pending",
  }).returning();

  broadcastEvent("credit_purchase_submitted", { userId: authUser.userId, txId: tx.id, method, credits: pkg.credits });
  res.status(201).json({ success: true, transaction: tx, message: "Payment submitted. Credits will be added after verification (usually within 1-2 hours)." });
});

// ─── POST /api/credits/swap — credits → AZN tokens ────────────────────────────
router.post("/credits/swap", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { credits: creditsToSwap } = req.body as { credits?: number };
  if (!creditsToSwap || creditsToSwap < CREDITS_PER_AZN) {
    res.status(400).json({ error: `Minimum swap is ${CREDITS_PER_AZN} credits (1 AZN)` }); return;
  }
  if (creditsToSwap % CREDITS_PER_AZN !== 0) {
    res.status(400).json({ error: `Credits must be a multiple of ${CREDITS_PER_AZN}` }); return;
  }

  await getOrCreateCredits(authUser.userId);
  const aznAmount = creditsToSwap / CREDITS_PER_AZN;

  // BUG FIX: this used to read creditRow.balance once, then write back
  // `creditRow.balance - creditsToSwap` (and the aznBalance/totalSpent
  // increments) computed in JS from that stale read — the exact same
  // non-atomic read-then-write race already fixed in POST /credits/transfer,
  // POST /wallets/transfer, and the Finance repayment/amortization routes.
  // Two concurrent swaps from the same user could both pass the balance
  // check against the same stale value and both writes would clobber each
  // other, letting a user swap more credits into AZN than they actually
  // held. Do the deduction as a single atomic UPDATE ... WHERE balance >=
  // creditsToSwap so Postgres serializes concurrent swaps on that row
  // instead of the app computing the new value from a value it read before
  // another request's write landed.
  const [deducted] = await db.update(creditsTable).set({
    balance: sql`${creditsTable.balance} - ${creditsToSwap}`,
    aznBalance: sql`${creditsTable.aznBalance} + ${aznAmount}`,
    totalSpent: sql`${creditsTable.totalSpent} + ${creditsToSwap}`,
    updatedAt: new Date(),
  }).where(and(eq(creditsTable.userId, authUser.userId), sql`${creditsTable.balance} >= ${creditsToSwap}`))
    .returning({ balance: creditsTable.balance, aznBalance: creditsTable.aznBalance });

  if (!deducted) {
    const fresh = await getOrCreateCredits(authUser.userId);
    res.status(400).json({ error: `Insufficient credits. You have ${fresh.balance} credits.` }); return;
  }

  const [tx] = await db.insert(creditTransactionsTable).values({
    userId: authUser.userId,
    type: "swap_to_azn",
    method: "system",
    credits: -creditsToSwap,
    aznAmount,
    status: "approved",
    notes: `Swapped ${creditsToSwap} credits → ${aznAmount} AZN`,
    approvedAt: new Date(),
  }).returning();

  broadcastEvent("credits_updated", { userId: authUser.userId });
  res.json({ success: true, aznReceived: aznAmount, newCreditBalance: deducted.balance, newAznBalance: deducted.aznBalance, transaction: tx });
});

// ─── POST /api/credits/buy-subscription — AZN → subscription ──────────────────
router.post("/credits/buy-subscription", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { plan, username } = req.body as { plan?: string; username?: string };
  if (!plan || !["pro", "enterprise"].includes(plan)) {
    res.status(400).json({ error: "Invalid plan. Choose pro or enterprise" }); return;
  }

  const aznCost = plan === "enterprise" ? AZN_FOR_ENTERPRISE : AZN_FOR_PRO;
  await getOrCreateCredits(authUser.userId);

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // BUG FIX: same non-atomic read-then-write race as /credits/swap, fixed
  // the same way — deduct AZN with a single atomic UPDATE ... WHERE
  // azn_balance >= aznCost instead of reading the balance into JS and
  // writing `creditRow.aznBalance - aznCost` back, which let concurrent
  // purchases both pass the check against the same stale balance.
  const [deducted] = await db.update(creditsTable).set({
    aznBalance: sql`${creditsTable.aznBalance} - ${aznCost}`,
    updatedAt: new Date(),
  }).where(and(eq(creditsTable.userId, authUser.userId), sql`${creditsTable.aznBalance} >= ${aznCost}`))
    .returning({ aznBalance: creditsTable.aznBalance });

  if (!deducted) {
    const fresh = await getOrCreateCredits(authUser.userId);
    res.status(400).json({ error: `Insufficient AZN. Need ${aznCost} AZN, you have ${fresh.aznBalance.toFixed(2)} AZN.` }); return;
  }

  // Upsert subscription
  const existing = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, authUser.userId));
  if (existing.length > 0) {
    await db.update(subscriptionsTable).set({ plan, status: "active", expiresAt, updatedAt: new Date() }).where(eq(subscriptionsTable.userId, authUser.userId));
  } else {
    await db.insert(subscriptionsTable).values({ userId: authUser.userId, plan, status: "active", expiresAt });
  }

  await db.insert(creditTransactionsTable).values({
    userId: authUser.userId,
    type: "azn_subscription",
    method: "system",
    credits: 0,
    aznAmount: -aznCost,
    status: "approved",
    notes: `Purchased ${plan} subscription for ${aznCost} AZN`,
    approvedAt: new Date(),
  });

  broadcastEvent("subscription_updated", { userId: authUser.userId, plan });

  // Auto-mint the subscription-pass NFT — AZN was already charged above, so skip re-deducting.
  let nft = null;
  try {
    const minted = await mintNftForUser({ userId: authUser.userId, plan, username, deductAzn: false });
    nft = minted.nft;
  } catch (err) {
    // Subscription purchase itself succeeded — NFT mint failure shouldn't block the response,
    // but it is surfaced so the frontend/user knows the collectible wasn't issued.
    res.json({ success: true, plan, expiresAt, aznSpent: aznCost, newAznBalance: deducted.aznBalance, nft: null, nftError: (err as Error).message });
    return;
  }

  res.json({ success: true, plan, expiresAt, aznSpent: aznCost, newAznBalance: deducted.aznBalance, nft });
});

// ─── ADMIN: GET /api/admin/credits — pending purchases ────────────────────────
router.get("/admin/credits", requireAdmin, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser || authUser.role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }

  const pending = await db.select().from(creditTransactionsTable)
    .where(eq(creditTransactionsTable.status, "pending"))
    .orderBy(desc(creditTransactionsTable.createdAt));
  res.json(pending);
});

// ─── ADMIN: POST /api/admin/credits/:id/approve ────────────────────────────────
router.post("/admin/credits/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser || authUser.role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [tx] = await db.select().from(creditTransactionsTable).where(eq(creditTransactionsTable.id, id));
  if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
  if (tx.status !== "pending") { res.status(400).json({ error: "Transaction already processed" }); return; }

  await db.update(creditTransactionsTable).set({ status: "approved", approvedAt: new Date(), adminNote: req.body.note ?? null, updatedAt: new Date() }).where(eq(creditTransactionsTable.id, id));

  const creditRow = await getOrCreateCredits(tx.userId);
  await db.update(creditsTable).set({
    balance: creditRow.balance + (tx.credits ?? 0),
    totalPurchased: creditRow.totalPurchased + (tx.credits ?? 0),
    updatedAt: new Date(),
  }).where(eq(creditsTable.userId, tx.userId));

  broadcastEvent("credits_updated", { userId: tx.userId, credits: tx.credits });
  res.json({ success: true });
});

// ─── ADMIN: POST /api/admin/credits/:id/reject ─────────────────────────────────
router.post("/admin/credits/:id/reject", requireAdmin, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser || authUser.role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.update(creditTransactionsTable).set({ status: "rejected", adminNote: req.body.note ?? "Rejected by admin", updatedAt: new Date() }).where(eq(creditTransactionsTable.id, id));
  res.json({ success: true });
});

// ─── POST /api/credits/transfer — user-to-user AZN transfer ──────────────────
router.post("/credits/transfer", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { toUsername, amount } = req.body as { toUsername?: string; amount?: number };
  if (!toUsername?.trim()) { res.status(400).json({ error: "toUsername is required" }); return; }
  if (!amount || amount <= 0) { res.status(400).json({ error: "amount must be greater than 0" }); return; }
  if (amount < 0.01) { res.status(400).json({ error: "Minimum transfer is 0.01 AZN" }); return; }

  // Find recipient
  const { usersTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const [recipient] = await db.select({ id: usersTable.id, username: usersTable.username })
    .from(usersTable).where(eq(usersTable.username, toUsername.trim()));
  if (!recipient) { res.status(404).json({ error: "User not found" }); return; }
  if (recipient.id === authUser.userId) { res.status(400).json({ error: "Cannot transfer to yourself" }); return; }

  const [sender] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, authUser.userId));
  const senderUsername = sender?.username ?? "someone";

  const senderCredits = await getOrCreateCredits(authUser.userId);
  if (senderCredits.aznBalance < amount) {
    res.status(400).json({ error: `Insufficient AZN. You have ${senderCredits.aznBalance.toFixed(4)} AZN.` }); return;
  }

  // Everything below runs in one real transaction (db.transaction() —
  // drizzle's node-postgres transaction correctly holds a single dedicated
  // connection for the whole callback) with the deduction done as a single
  // atomic UPDATE ... WHERE aznBalance >= amount, not "read balance into a
  // JS variable, then SET balance to (that variable - amount)". The old
  // version computed the new balance entirely in JS from a stale read, so
  // two concurrent transfers could each read the same starting balance and
  // the second UPDATE's write would silently clobber the first — both
  // recipients get credited, but the sender's balance only reflects one
  // deduction, net-creating AZN out of nothing. The guarded UPDATE below
  // can't lose a concurrent write like that: Postgres serializes the two
  // UPDATEs on that row, and the second one's WHERE clause simply stops
  // matching once the first has committed its deduction.
  let newSenderBalance: number;
  try {
    newSenderBalance = await db.transaction(async (tx) => {
      const deduction = await tx.update(creditsTable)
        .set({ aznBalance: sql`${creditsTable.aznBalance} - ${amount}`, updatedAt: new Date() })
        .where(and(eq(creditsTable.userId, authUser.userId), sql`${creditsTable.aznBalance} >= ${amount}`))
        .returning({ aznBalance: creditsTable.aznBalance });
      if (deduction.length === 0) throw new Error("INSUFFICIENT_BALANCE");

      await tx.insert(creditsTable).values({ userId: recipient.id }).onConflictDoNothing();
      await tx.update(creditsTable)
        .set({ aznBalance: sql`${creditsTable.aznBalance} + ${amount}`, updatedAt: new Date() })
        .where(eq(creditsTable.userId, recipient.id));

      await tx.insert(creditTransactionsTable).values({
        userId: authUser.userId, type: "azn_transfer_out", method: "transfer",
        credits: 0, aznAmount: -amount, status: "approved",
        notes: `Sent ${amount} AZN to @${recipient.username}`,
        referenceId: String(recipient.id), approvedAt: new Date(),
      });
      await tx.insert(creditTransactionsTable).values({
        userId: recipient.id, type: "azn_transfer_in", method: "transfer",
        credits: 0, aznAmount: amount, status: "approved",
        notes: `Received ${amount} AZN from @${senderUsername}`,
        referenceId: String(authUser.userId), approvedAt: new Date(),
      });

      return deduction[0].aznBalance;
    });
  } catch (err: any) {
    if (err?.message === "INSUFFICIENT_BALANCE") {
      res.status(400).json({ error: `Insufficient AZN — balance changed, please retry.` });
      return;
    }
    res.status(500).json({ error: "Transfer failed", detail: err?.message });
    return;
  }

  // Notify recipient
  try {
    const { createNotification } = await import("./notifications");
    await createNotification(recipient.id, "azn_transfer", `+${amount} AZN Received 💸`,
      `@${senderUsername} sent you ${amount} AZN tokens.`,
      { from: authUser.userId, amount });
  } catch {}

  broadcastEvent("credits_updated", { userId: authUser.userId });
  broadcastEvent("credits_updated", { userId: recipient.id });

  res.json({
    success: true,
    sent: amount,
    to: recipient.username,
    newBalance: +newSenderBalance.toFixed(6),
    message: `Successfully sent ${amount} AZN to @${recipient.username}`,
  });
});

// ─── POST /api/credits/sell-azn — request to sell AZN tokens ─────────────────
router.post("/credits/sell-azn", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { aznAmount, method, accountNumber } = req.body as { aznAmount?: number; method?: string; accountNumber?: string };
  if (!aznAmount || aznAmount < 1) {
    res.status(400).json({ error: "Minimum sell is 1 AZN" }); return;
  }
  if (!method || !["bkash", "nagad", "binance_usdt"].includes(method)) {
    res.status(400).json({ error: "Invalid withdrawal method" }); return;
  }
  if (!accountNumber?.trim()) {
    res.status(400).json({ error: "Account number / wallet address required" }); return;
  }

  await getOrCreateCredits(authUser.userId);
  const usdValue = +(aznAmount * AZN_PRICE_USD).toFixed(4);
  const bdtValue = +(usdValue * USD_TO_BDT).toFixed(2);

  // BUG FIX: same non-atomic read-then-write race as /credits/swap and
  // /credits/buy-subscription, fixed the same way — and the most critical
  // of the three, since this deduction backs a real-money admin payout
  // (bKash/Nagad/USDT). The old code read creditRow.aznBalance once and
  // wrote back `creditRow.aznBalance - aznAmount` computed in JS with no
  // atomic guard, so a user firing several sell-azn requests concurrently
  // could have every one of them pass the balance check against the same
  // stale value — each creating its own pending withdrawal for the full
  // amount — while only one deduction's worth of AZN actually left the
  // balance. Admin approving those requests at face value would pay out
  // real money for AZN the user never actually gave up. Deduct with a
  // single atomic UPDATE ... WHERE azn_balance >= aznAmount instead.
  const [deducted] = await db.update(creditsTable).set({
    aznBalance: sql`${creditsTable.aznBalance} - ${aznAmount}`,
    updatedAt: new Date(),
  }).where(and(eq(creditsTable.userId, authUser.userId), sql`${creditsTable.aznBalance} >= ${aznAmount}`))
    .returning({ aznBalance: creditsTable.aznBalance });

  if (!deducted) {
    const fresh = await getOrCreateCredits(authUser.userId);
    res.status(400).json({ error: `Insufficient AZN. You have ${fresh.aznBalance.toFixed(4)} AZN.` }); return;
  }

  const [tx] = await db.insert(creditTransactionsTable).values({
    userId: authUser.userId,
    type: "azn_sell",
    method,
    credits: 0,
    aznAmount: -aznAmount,
    amountUSDT: method === "binance_usdt" ? usdValue : null,
    amountBDT: method !== "binance_usdt" ? bdtValue : null,
    status: "pending",
    notes: `Sell ${aznAmount} AZN → ${method === "binance_usdt" ? `$${usdValue} USDT` : `৳${bdtValue}`} to: ${accountNumber.trim()}`,
    referenceId: accountNumber.trim(),
  }).returning();

  broadcastEvent("credit_sell_requested", { userId: authUser.userId, txId: tx.id, aznAmount });
  res.status(201).json({
    success: true,
    transaction: tx,
    usdValue,
    bdtValue,
    message: `Sell request submitted. Admin will send ${method !== "binance_usdt" ? `৳${bdtValue}` : `$${usdValue} USDT`} to your account within 24 hours.`,
  });
});

export default router;
