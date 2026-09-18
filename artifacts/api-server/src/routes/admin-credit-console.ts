/**
 * routes/admin-credit-console.ts
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 5 — AYZEN Credits admin console.
 *
 * The consumption layer itself (balance checks, charge-on-success, the
 * METERED_ACTIONS registry) lives in services/credit-meter.ts. This file is
 * the admin-facing surface on top of it:
 *
 *  - GET  /admin/credits/actions        list every metered action, its code
 *                                        default, any admin override, and
 *                                        the effective (currently-charged)
 *                                        cost — grouped by app.
 *  - PATCH /admin/credits/actions/:key  set a per-action price and/or waive
 *                                        the fee (enabled=false). Can only
 *                                        touch keys that already exist in
 *                                        METERED_ACTIONS — this console
 *                                        reprices actions, it doesn't
 *                                        invent new metered endpoints (that
 *                                        stays a code change, see that
 *                                        file's header).
 *  - GET  /admin/credits/usage          aggregate real spend per action from
 *                                        credit_transactions, so pricing
 *                                        decisions are based on actual
 *                                        volume, not guesses.
 *
 * Per the master plan (§5) and credit-meter.ts's own design note: nothing
 * here ever blocks a feature. `enabled=false` only waives the fee (cost 0)
 * — nothing in this console can turn a metered action into a locked one.
 */

import { Router } from "express";
import { db, creditActionPricingTable, creditTransactionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAdmin, getRequestUser } from "../middlewares/auth";
import {
  METERED_ACTIONS,
  getEffectiveActions,
  invalidateActionPricingCache,
} from "../services/credit-meter";

const router = Router();

// ─── GET /admin/credits/actions — every metered action + effective price ───
router.get("/admin/credits/actions", requireAdmin, async (_req, res): Promise<void> => {
  const [effective, overrideRows] = await Promise.all([
    getEffectiveActions(),
    db.select().from(creditActionPricingTable),
  ]);
  const overridesByKey = new Map(overrideRows.map((row) => [row.actionKey, row]));

  const actions = effective.map((action) => {
    const override = overridesByKey.get(action.key);
    const defaultCost = METERED_ACTIONS[action.key]?.cost ?? action.cost;
    return {
      key: action.key,
      app: action.app,
      label: action.label,
      defaultCost,
      effectiveCost: action.cost,
      override: override
        ? { cost: override.cost, enabled: override.enabled, updatedBy: override.updatedBy, updatedAt: override.updatedAt }
        : null,
    };
  });

  // Grouped by app so the console can render one section per app (Sylo,
  // Wisp, Ryft, Zynth, Skarn, Verve, Astra, Workspace) instead of one flat
  // table — matches how the master plan's §5 table itself is organized.
  const byApp: Record<string, typeof actions> = {};
  for (const action of actions) {
    (byApp[action.app] ??= []).push(action);
  }

  res.json({ actions, byApp });
});

// ─── PATCH /admin/credits/actions/:key — set cost and/or waive the fee ────
router.patch("/admin/credits/actions/:key", requireAdmin, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  if (!METERED_ACTIONS[key]) {
    res.status(404).json({
      error: "Unknown metered action",
      solution: "This console can only reprice an existing action key from services/credit-meter.ts's METERED_ACTIONS — adding a new metered endpoint is a code change.",
    });
    return;
  }

  const { cost, enabled } = req.body as { cost?: number | null; enabled?: boolean };
  if (cost !== undefined && cost !== null && (!Number.isInteger(cost) || cost < 0)) {
    res.status(400).json({ error: "cost must be a non-negative integer, or null to clear the override and fall back to the code default" });
    return;
  }

  const [existing] = await db.select().from(creditActionPricingTable).where(eq(creditActionPricingTable.actionKey, key));

  if (existing) {
    await db.update(creditActionPricingTable).set({
      cost: cost !== undefined ? cost : existing.cost,
      enabled: enabled !== undefined ? enabled : existing.enabled,
      updatedBy: authUser.userId,
      updatedAt: new Date(),
    }).where(eq(creditActionPricingTable.actionKey, key));
  } else {
    await db.insert(creditActionPricingTable).values({
      actionKey: key,
      cost: cost ?? null,
      enabled: enabled ?? true,
      updatedBy: authUser.userId,
    });
  }

  // Take effect immediately, not after the 15s cache TTL — an admin
  // saving a price change expects the very next request to reflect it.
  invalidateActionPricingCache();

  const [effective] = (await getEffectiveActions()).filter((a) => a.key === key);
  res.json({ success: true, action: effective });
});

// ─── DELETE /admin/credits/actions/:key — clear an override, revert to code default ───
router.delete("/admin/credits/actions/:key", requireAdmin, async (req, res): Promise<void> => {
  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  await db.delete(creditActionPricingTable).where(eq(creditActionPricingTable.actionKey, key));
  invalidateActionPricingCache();
  res.json({ success: true });
});

// ─── GET /admin/credits/usage — real spend per action, from the ledger ────
router.get("/admin/credits/usage", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      actionKey: creditTransactionsTable.actionKey,
      chargeCount: sql<number>`count(*)`.mapWith(Number),
      totalCredits: sql<number>`coalesce(sum(-${creditTransactionsTable.credits}), 0)`.mapWith(Number),
    })
    .from(creditTransactionsTable)
    .where(sql`${creditTransactionsTable.type} = 'usage_debit' AND ${creditTransactionsTable.actionKey} IS NOT NULL`)
    .groupBy(creditTransactionsTable.actionKey);

  const usage = rows
    .map((row) => {
      const action = row.actionKey ? METERED_ACTIONS[row.actionKey] : undefined;
      return {
        actionKey: row.actionKey,
        app: action?.app ?? "unknown",
        label: action?.label ?? row.actionKey ?? "Unknown action",
        chargeCount: row.chargeCount,
        totalCredits: row.totalCredits,
      };
    })
    .sort((a, b) => b.totalCredits - a.totalCredits);

  const totalCreditsSpent = usage.reduce((sum, row) => sum + row.totalCredits, 0);
  const totalCharges = usage.reduce((sum, row) => sum + row.chargeCount, 0);

  res.json({ usage, totals: { creditsSpent: totalCreditsSpent, charges: totalCharges } });
});

export default router;
