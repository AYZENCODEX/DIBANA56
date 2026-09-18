/**
 * services/credit-meter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 5 — AYZEN Credits consumption layer.
 *
 * What this is: the single place that turns a "metered action" (an AI query
 * in Zynth, an automation run in Skarn, a boosted listing in Verve, a
 * custom-routed send in Wisp, a premium widget hit from Astra, an advanced
 * report export in Ryft) into a credit deduction — reusing the exact
 * `credits` / `credit_transactions` tables and atomic-update pattern that
 * `routes/credits.ts` already uses for /credits/swap and
 * /credits/buy-subscription, instead of inventing a second billing system.
 *
 * Design (see ayzen-workspace-master-plan.md §5):
 *  - Tiers are NOT feature walls. Every action below is available to every
 *    user; it just costs credits. Core/free-tier functionality for each app
 *    (viewing the vault, basic wallet, basic mail, basic listings, manual
 *    Skarn monitoring) is never metered here and never gated on balance.
 *  - AYZEN Credits and AZN stay separate concepts (§5, Risk Register #2) —
 *    this file only ever debits/credits the `balance` column (credits), the
 *    same column /credits/purchase and /credits/swap already move. It never
 *    touches `aznBalance`.
 *  - "Hard stop" behavior (§5): when balance can't cover an action's cost,
 *    the request is rejected with a 402 + a clear "out of credits" body the
 *    frontend can turn into a one-tap top-up prompt (reusing
 *    POST /credits/purchase) — the metered action simply doesn't run.
 *
 * Two-step pattern used by every integration point below:
 *   1. `requireCreditBalance(actionKey)` — route middleware, runs AFTER
 *      requireAuth. Pre-flight balance check only (no deduction yet), so a
 *      request that's going to fail validation/auth for other reasons never
 *      touches the ledger.
 *   2. `chargeCredits(userId, actionKey)` — called by the route handler
 *      itself, once the metered action has actually succeeded (AI reply
 *      generated, report actually built, mail actually sent). This is a
 *      charge-on-success model: a user is never billed for an action that
 *      failed downstream (upstream AI provider error, SMTP failure, etc).
 *      `chargeCredits` re-checks balance atomically at charge time (same
 *      `WHERE balance >= cost` pattern as /credits/swap) so a balance that
 *      changed between the pre-flight check and the charge — e.g. a second
 *      concurrent request — still can't push a user negative.
 *
 * Costs below are a first pass, intentionally centralized in one exported
 * map so the pricing pass called out in the master plan (§8, open questions)
 * is a one-file edit, not a grep-and-replace across six apps. Also exposed
 * read-only via GET /credits (see routes/credits.ts) so the frontend can
 * show "costs 5 credits" next to a metered action before the user clicks it.
 */

import type { Request, Response, NextFunction } from "express";
import { db, creditsTable, creditTransactionsTable, creditActionPricingTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { broadcastEvent } from "../routes/events";
import { getRequestUser } from "../middlewares/auth";

// ─── Metered action registry ───────────────────────────────────────────────
// One entry per action in the master plan's §5 "Metered actions" table,
// plus the Phase 5 follow-up set (admin credit console request): Sylo vault
// entity view + credential/seed access, Wisp native mailbox view/send/
// template, Ryft wallet create/transaction, and the workspace-level project
// enroll / task submit actions. `app` is just for grouping/reporting (admin
// console, GET /credits); the `key` is what routes pass to
// requireCreditBalance()/chargeCredits().
//
// This map is still the CODE default for every action's existence and
// starting cost. Per-action price/enabled overrides an admin sets from the
// credit console live in `credit_action_pricing` (see getEffectiveAction()
// below) — this map never needs a deploy just to reprice something, but it
// is the only place new action keys get added.
export type MeteredAction = {
  key: string;
  app: "zynth" | "skarn" | "verve" | "wisp" | "astra" | "ryft" | "sylo" | "workspace";
  label: string;
  cost: number; // in AYZEN Credits — code default, may be overridden (see above)
};

export const METERED_ACTIONS: Record<string, MeteredAction> = {
  "zynth.ai_query": {
    key: "zynth.ai_query",
    app: "zynth",
    label: "AI query / agent action",
    cost: 5,
  },
  "skarn.automation_run": {
    key: "skarn.automation_run",
    app: "skarn",
    label: "Automated farming run / claim execution",
    cost: 10,
  },
  "verve.boosted_listing": {
    key: "verve.boosted_listing",
    app: "verve",
    label: "Boosted / promoted listing",
    cost: 50,
  },
  "verve.premium_analytics": {
    key: "verve.premium_analytics",
    app: "verve",
    label: "Premium marketplace analytics",
    cost: 8,
  },
  "wisp.custom_send": {
    key: "wisp.custom_send",
    app: "wisp",
    label: "Custom-routed send (external mail account relay)",
    cost: 2,
  },
  "astra.premium_widget": {
    key: "astra.premium_widget",
    app: "astra",
    label: "Astra premium widget (Ryft Connect / Skarn Watch push)",
    cost: 3,
  },
  "ryft.report_export": {
    key: "ryft.report_export",
    app: "ryft",
    label: "Advanced report generation / export",
    cost: 15,
  },
  // ── Phase 5 follow-up set ─────────────────────────────────────────────
  "sylo.vault_entity_view": {
    key: "sylo.vault_entity_view",
    app: "sylo",
    label: "Vault entity view",
    cost: 1,
  },
  "sylo.credential_access": {
    key: "sylo.credential_access",
    app: "sylo",
    label: "Credential / seed phrase reveal",
    cost: 5,
  },
  // ── Phase 5b — "Entity individual rate" request: vault_entries was the
  // only one of Sylo's four entity kinds (vault/local/kyc/game — see
  // lib/schema-migrations.ts's local_accounts/kyc_entries/game_entries
  // CREATE TABLE comments) with its own metered view action. These three
  // give local accounts, KYC entities, and game entries the same
  // individually-configurable rate vault entries already had, each priced
  // and toggled independently from the admin console — no console code
  // change needed, since GET/PATCH/DELETE /admin/credits/actions is
  // already generic over whatever keys exist in this map.
  "sylo.local_account_view": {
    key: "sylo.local_account_view",
    app: "sylo",
    label: "Local account view",
    cost: 1,
  },
  "sylo.kyc_entry_view": {
    key: "sylo.kyc_entry_view",
    app: "sylo",
    label: "KYC entity view",
    cost: 1,
  },
  "sylo.game_entry_view": {
    key: "sylo.game_entry_view",
    app: "sylo",
    label: "Game entity view",
    cost: 1,
  },
  "wisp.mail_view": {
    key: "wisp.mail_view",
    app: "wisp",
    label: "Mailbox message view",
    cost: 1,
  },
  "wisp.mail_send": {
    key: "wisp.mail_send",
    app: "wisp",
    label: "Send mail (native AYZEN mailbox)",
    cost: 2,
  },
  "wisp.template_use": {
    key: "wisp.template_use",
    app: "wisp",
    label: "Create / use mail template",
    cost: 2,
  },
  "ryft.wallet_create": {
    key: "ryft.wallet_create",
    app: "ryft",
    label: "Create wallet",
    cost: 3,
  },
  "ryft.wallet_tx": {
    key: "ryft.wallet_tx",
    app: "ryft",
    label: "Wallet transaction (send / withdraw)",
    cost: 5,
  },
  "workspace.project_use": {
    key: "workspace.project_use",
    app: "workspace",
    label: "Project enroll / use",
    cost: 2,
  },
  "workspace.task_submit": {
    key: "workspace.task_submit",
    app: "workspace",
    label: "Task submission",
    cost: 2,
  },
};

function assertKnownAction(key: string): MeteredAction {
  const action = METERED_ACTIONS[key];
  if (!action) throw new Error(`Unknown metered action: ${key}`);
  return action;
}

/** Sync lookup of the code-default action — no DB override applied. Kept
 * for call sites that only need the static label/app/key (e.g. building
 * the admin console's "known actions" list before overrides are fetched).
 * Route-facing balance checks/charges must use `getMeteredAction()` below,
 * not this, so an admin-set price actually takes effect. */
export function getStaticMeteredAction(key: string): MeteredAction {
  return assertKnownAction(key);
}

// ─── Admin override cache ──────────────────────────────────────────────────
// Every metered request would otherwise cost an extra round trip just to
// check "did an admin reprice this?". Overrides change rarely (an admin
// editing the credit console), so a short-TTL in-memory cache is the right
// trade-off — same "cheap to build, cheap to keep fresh" posture as the
// singletons in middlewares/auth.ts. Any admin write below clears the
// cache immediately so the console's own "save" always reflects instantly,
// even before the TTL would have expired it naturally.
const OVERRIDE_CACHE_TTL_MS = 15_000;
let overrideCache: Map<string, { cost: number | null; enabled: boolean }> | null = null;
let overrideCacheAt = 0;

async function loadOverrides(): Promise<Map<string, { cost: number | null; enabled: boolean }>> {
  const now = Date.now();
  if (overrideCache && now - overrideCacheAt < OVERRIDE_CACHE_TTL_MS) return overrideCache;
  const rows = await db.select().from(creditActionPricingTable);
  const map = new Map<string, { cost: number | null; enabled: boolean }>();
  for (const row of rows) map.set(row.actionKey, { cost: row.cost, enabled: row.enabled });
  overrideCache = map;
  overrideCacheAt = now;
  return map;
}

/** Admin console calls this after every pricing write so the new price/
 * enabled state is live on the very next request, not after the TTL. */
export function invalidateActionPricingCache(): void {
  overrideCache = null;
  overrideCacheAt = 0;
}

// ─── getMeteredAction — effective action (code default + admin override) ──
// This is what every balance check / charge in this file uses. `enabled:
// false` waives the fee (effective cost 0) — it never blocks the action;
// see file header and the master plan §5 ("tiers aren't feature walls").
export async function getMeteredAction(key: string): Promise<MeteredAction> {
  const action = assertKnownAction(key);
  const overrides = await loadOverrides();
  const override = overrides.get(key);
  if (!override) return action;
  const cost = override.enabled ? (override.cost ?? action.cost) : 0;
  return { ...action, cost };
}

/** Every known action, with overrides applied — powers GET /credits'
 * `meteredActions` list and the admin console's own listing. */
export async function getEffectiveActions(): Promise<MeteredAction[]> {
  const overrides = await loadOverrides();
  return Object.values(METERED_ACTIONS).map((action) => {
    const override = overrides.get(action.key);
    if (!override) return action;
    const cost = override.enabled ? (override.cost ?? action.cost) : 0;
    return { ...action, cost };
  });
}

// ─── Helper: get or create credit row (mirrors routes/credits.ts) ─────────
async function getOrCreateCredits(userId: number) {
  const [row] = await db.select().from(creditsTable).where(eq(creditsTable.userId, userId));
  if (row) return row;
  const [created] = await db.insert(creditsTable).values({ userId }).returning();
  return created;
}

// ─── requireCreditBalance — pre-flight check middleware ───────────────────
// Mount AFTER requireAuth. Blocks with 402 if the user can't currently
// afford `actionKey`; otherwise attaches `req.meteredAction` and calls next.
// Does NOT deduct — see file header for why charging happens on success.
export function requireCreditBalance(actionKey: string, opts?: { exemptRoles?: string[] }) {
  // NOTE: does not resolve the action eagerly here — an admin-set override
  // (credit_action_pricing) must be read fresh per request, not baked in
  // once at route-file module-load time.
  const exemptRoles = opts?.exemptRoles ?? [];
  return async (req: Request & { meteredAction?: MeteredAction }, res: Response, next: NextFunction): Promise<void> => {
    const authUser = getRequestUser(req);
    if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

    // Internal/ops roles (e.g. the admin console's own use of a metered
    // route) aren't a user spending their own credit pool — exempt them
    // rather than charging AYZEN's own ops staff for internal tooling use.
    if (exemptRoles.includes(authUser.role)) { next(); return; }

    const action = await getMeteredAction(actionKey);
    if (action.cost === 0) { req.meteredAction = action; next(); return; }

    const credits = await getOrCreateCredits(authUser.userId);
    if (credits.balance < action.cost) {
      res.status(402).json({
        error: "Out of credits",
        code: "OUT_OF_CREDITS",
        action: action.key,
        label: action.label,
        cost: action.cost,
        balance: credits.balance,
        topUp: { method: "POST", url: "/api/credits/purchase" },
      });
      return;
    }

    req.meteredAction = action;
    next();
  };
}

// ─── hasCreditBalance — same pre-flight check as requireCreditBalance, but
// as a plain function rather than middleware, for routes where whether an
// action is metered at all depends on something only known inside the
// handler (e.g. /finance/reports/custom: JSON view is free, CSV/PDF export
// is the metered action — see routes/finance.ts). Returns the balance-check
// result so the caller decides how to respond; doesn't send anything itself.
export async function hasCreditBalance(
  userId: number,
  actionKey: string,
): Promise<{ ok: true } | { ok: false; action: MeteredAction; balance: number }> {
  const action = await getMeteredAction(actionKey);
  if (action.cost === 0) return { ok: true };
  const credits = await getOrCreateCredits(userId);
  if (credits.balance < action.cost) return { ok: false, action, balance: credits.balance };
  return { ok: true };
}

// ─── chargeCredits — atomic charge-on-success ──────────────────────────────
// Call this from inside the route handler once the metered action has
// actually completed. Same atomic `WHERE balance >= cost` pattern as
// /credits/swap and /credits/buy-subscription (routes/credits.ts) so two
// concurrent requests can't both pass a stale balance check.
export async function chargeCredits(
  userId: number,
  actionKey: string,
  opts?: { notes?: string; quantity?: number },
): Promise<
  | { ok: true; charged: number; newBalance: number; txId: number }
  | { ok: false; balance: number; cost: number }
> {
  const action = await getMeteredAction(actionKey);
  const cost = action.cost * (opts?.quantity ?? 1);

  await getOrCreateCredits(userId);

  // Fee waived (admin set enabled=false, or a quantity of 0 was passed) —
  // nothing to deduct, and no ledger noise for a zero-value charge.
  if (cost === 0) {
    const credits = await getOrCreateCredits(userId);
    return { ok: true, charged: 0, newBalance: credits.balance, txId: -1 };
  }

  const [deducted] = await db
    .update(creditsTable)
    .set({
      balance: sql`${creditsTable.balance} - ${cost}`,
      totalSpent: sql`${creditsTable.totalSpent} + ${cost}`,
      updatedAt: new Date(),
    })
    .where(and(eq(creditsTable.userId, userId), sql`${creditsTable.balance} >= ${cost}`))
    .returning({ balance: creditsTable.balance });

  if (!deducted) {
    const fresh = await getOrCreateCredits(userId);
    return { ok: false, balance: fresh.balance, cost };
  }

  const [tx] = await db
    .insert(creditTransactionsTable)
    .values({
      userId,
      type: "usage_debit",
      method: "system",
      credits: -cost,
      status: "approved",
      approvedAt: new Date(),
      notes: opts?.notes ?? `${action.label} (${action.app})`,
      actionKey: action.key,
    })
    .returning();

  broadcastEvent("credits_updated", { userId });
  return { ok: true, charged: cost, newBalance: deducted.balance, txId: tx.id };
}

// ─── refundCredits — compensating credit for a charge that should not have
// happened (e.g. the metered action was charged, then a later step in the
// same request failed in a way the handler couldn't check before charging).
// Inserts a new ledger row rather than mutating the original charge, so the
// transaction history stays an honest append-only log — same principle
// already used for swap/subscription rows in routes/credits.ts.
export async function refundCredits(userId: number, txId: number, reason?: string): Promise<void> {
  const [original] = await db
    .select()
    .from(creditTransactionsTable)
    .where(and(eq(creditTransactionsTable.id, txId), eq(creditTransactionsTable.userId, userId)));
  if (!original || original.credits >= 0) return; // nothing to refund

  const refundAmount = -original.credits;

  await db
    .update(creditsTable)
    .set({
      balance: sql`${creditsTable.balance} + ${refundAmount}`,
      totalSpent: sql`${creditsTable.totalSpent} - ${refundAmount}`,
      updatedAt: new Date(),
    })
    .where(eq(creditsTable.userId, userId));

  await db.insert(creditTransactionsTable).values({
    userId,
    type: "usage_refund",
    method: "system",
    credits: refundAmount,
    status: "approved",
    approvedAt: new Date(),
    notes: reason ?? `Refund for transaction #${txId}`,
    actionKey: original.actionKey,
  });

  broadcastEvent("credits_updated", { userId });
}
