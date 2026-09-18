import { pgTable, serial, text, integer, real, timestamp } from "drizzle-orm/pg-core";

// A ledger, not a single balance row — the running balance per currency is
// computed on read (SUM(amount) GROUP BY currency). This avoids races on a
// shared counter and gives a full audit trail of where every taka/AZN/USD of
// platform revenue came from (marketplace fees, subscriptions, account/OTP
// sales from the AYZEN-owned inventory, etc.)
export const adminWalletLedgerTable = pgTable("admin_wallet_ledger", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(), // 'marketplace_fee' | 'subscription' | 'account_sale' | 'otp_sale' | 'manual'
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("AZN"), // 'AZN' | 'USD' | 'USDT' | 'BDT' | 'credits'
  refId: text("ref_id"), // e.g. "mktx_123", "sub_45"
  userId: integer("user_id"), // the paying user, for audit — nullable (manual adjustments have none)
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AdminWalletLedgerRow = typeof adminWalletLedgerTable.$inferSelect;
