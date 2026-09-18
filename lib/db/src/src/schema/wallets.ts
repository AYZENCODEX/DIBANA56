import { pgTable, serial, text, integer, timestamp, real, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const walletsTable = pgTable("wallets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  label: text("label").notNull().default("My Wallet"),
  address: text("address").notNull(),
  chain: text("chain").notNull().default("ETH"),
  chainId: integer("chain_id"),
  balance: real("balance").notNull().default(0),
  balanceUsd: real("balance_usd").notNull().default(0),
  tokenCount: integer("token_count").notNull().default(0),
  nftCount: integer("nft_count").notNull().default(0),
  txCount: integer("tx_count").notNull().default(0),
  isPrimary: boolean("is_primary").notNull().default(false),
  lastSyncedAt: timestamp("last_synced_at"),
  notes: text("notes"),
  encryptedPhrase: text("encrypted_phrase"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertWalletSchema = createInsertSchema(walletsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastSyncedAt: true,
});
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type Wallet = typeof walletsTable.$inferSelect;

// NEW — user-to-user AZN/USDT/BDT/XP transfers (wallet-hub "Transfer" feature).
// Referenced by POST/GET /api/wallets/transfer(s) in the api-server route,
// which previously queried this table before it existed anywhere in the schema.
export const walletTransfersTable = pgTable("wallet_transfers", {
  id: serial("id").primaryKey(),
  fromUserId: integer("from_user_id").notNull(),
  toUserId: integer("to_user_id").notNull(),
  currency: text("currency").notNull(), // AZN | USDT | BDT | XP
  amount: real("amount").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type WalletTransfer = typeof walletTransfersTable.$inferSelect;

// NEW — internal ledger for off-chain-tracked token balances (e.g. USDT credited
// to a user's built-in wallet by an admin/deposit-matcher, separate from on-chain
// balance). Referenced by GET /api/wallets/tokens ("SUM(amount) ... symbol = 'USDT'").
export const builtinWalletTokensTable = pgTable("builtin_wallet_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  symbol: text("symbol").notNull(), // e.g. "USDT"
  amount: real("amount").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  userSymbolIdx: uniqueIndex("builtin_wallet_tokens_user_symbol_idx").on(t.userId, t.symbol),
}));
export type BuiltinWalletToken = typeof builtinWalletTokensTable.$inferSelect;
