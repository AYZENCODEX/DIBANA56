import { pgTable, serial, integer, text, real, timestamp, boolean } from "drizzle-orm/pg-core";

export const creditsTable = pgTable("credits", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  balance: integer("balance").notNull().default(0),
  aznBalance: real("azn_balance").notNull().default(0),
  // NEW — required by /api/wallets/transfer, /api/wallets/ayzen-balance
  usdtBalance: real("usdt_balance").notNull().default(0),
  bdtBalance: real("bdt_balance").notNull().default(0),
  xpBalance: real("xp_balance").notNull().default(0),
  totalPurchased: integer("total_purchased").notNull().default(0),
  totalSpent: integer("total_spent").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const creditTransactionsTable = pgTable("credit_transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  type: text("type").notNull(),
  method: text("method"),
  credits: integer("credits").notNull().default(0),
  aznAmount: real("azn_amount").notNull().default(0),
  amountBDT: real("amount_bdt"),
  amountUSDT: real("amount_usdt"),
  referenceId: text("reference_id"),
  status: text("status").notNull().default("pending"),
  // PHASE 5 (credit console) — the metered-action key this debit/refund
  // belongs to (e.g. "sylo.vault_entity_view"), when the row came from
  // services/credit-meter.ts's chargeCredits()/refundCredits() rather than
  // a purchase/swap/transfer flow. Nullable: only usage rows set it. Lets
  // the admin credit console (routes/admin-credit-console.ts) aggregate
  // real spend per action/app without parsing the free-text `notes`
  // column, which was never meant to be machine-read.
  actionKey: text("action_key"),
  notes: text("notes"),
  adminNote: text("admin_note"),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CreditRow = typeof creditsTable.$inferSelect;
export type CreditTxRow = typeof creditTransactionsTable.$inferSelect;
